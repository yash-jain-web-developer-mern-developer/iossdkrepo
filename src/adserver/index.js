// Ad serving plane: latency-critical, no database access on the request path.
// POST /v1/ad (SDK request), GET /t/i/:tok (impression), /t/c/:tok (click), /t/x/:tok (install postback), /t/v/:tok (video completion).
import { createHash } from 'node:crypto';
import { runAuction } from '../core/auction.js';
import { sign, verify } from '../core/token.js';
import { json, readJson, clientIp } from '../http.js';
import { judgeClick } from '../fraud.js';
import { rtbHandler } from './openrtb.js';
import { tokenHash } from '../db/repo.js';
import { pickCreative, noteCreative, creativesOf } from '../core/creative.js';
import { deliverReward } from '../core/rewards.js';
import { buildBidRequest, collectBids, unify, macro, PartnerBreakers, PARTNER_FORMATS } from '../core/partners.js';
import { safePost } from '../core/safeHttp.js';
import { tcfAllowsDeviceId } from '../core/tcf.js';

export const AD_FORMATS = ['banner', 'interstitial', 'native', 'video', 'playable', 'rewarded'];
const dimsOf = (p) => ({ creativeId: p.r || '', placementId: p.pl || '', country: p.co || '', format: p.fm || '' });

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const TYPES = { i: 'impression', c: 'click', x: 'install', v: 'video_complete', w: 'viewable' }; // w: the SDK measured the ad as viewable (never billed)

// May we use a device identifier for this request? No for child-directed apps, COPPA, limit-ad-tracking, GDPR without
// a consent string, or a US-privacy opt-out. (Ads are contextual either way; the id is only used for frequency caps.)
export function personalizationAllowed(app, consent = {}, { tcfVendorId = 0 } = {}) {
  if (app.childDirected || consent.coppa || consent.limitAdTracking) return false;
  if (consent.gdpr && !tcfAllowsDeviceId(consent.gdprConsent, { vendorId: tcfVendorId })) return false; // GDPR: a valid TCF v2 string with purpose 1 (and our vendor id, if configured)
  if (/^1[YN-]Y/i.test(String(consent.usPrivacy || ''))) return false;
  return true;
}

export function adServer({ catalog, ledger, deduper, counters, limiter, spend, secret, secretPrev, getPublicUrl, repo, metrics, log, isDegraded = () => false, allowPrivateCallbacks = false, tcfVendorId = 0, emit = async () => {} }) {
  const personalizationAllowedHere = (app, consent) => personalizationAllowed(app, consent, { tcfVendorId });
  const breakers = new PartnerBreakers();
  const cstats = new Map(); // per-replica creative rotation stats (steer rotation only; never used for billing)
  const bill = async (c, cost) => {
    const s = cost ? await spend.add(c.id, cost) : null;
    if (s) { c.spent = Math.max(c.spent, s.total); c.spentToday = s.today; }
    if (c.spent >= c.budget && c.status === 'active') {
      c.status = 'exhausted';
      emit(c.owner, 'campaign.exhausted', { campaignId: c.id, name: c.name });
      repo.setCampaignStatus(c.id, 'exhausted').catch((e) => log.error('persist exhausted failed', { err: e.message }));
    }
  };
  // Raw device ids are never stored: they are hashed with the app, the day and a server secret (so keys rotate daily and
  // cannot be linked across apps or days), and only used as a short-lived counter key.
  const deviceKey = (deviceId, appId) => createHash('sha256').update(`${deviceId}|${appId}|${new Date().toISOString().slice(0, 10)}|${secret}`).digest('hex').slice(0, 24);

  const rtb = rtbHandler({ catalog, limiter, secret, getPublicUrl, metrics, personalizationAllowed: personalizationAllowedHere, deviceKey, clientIp, json, readJson });

  // Server-to-server conversion postback from the advertiser: Authorization: Bearer <write-scope API key of the campaign owner>,
  // body { clickId, event, eventId?, value? }. clickId is the mobiad_click_id appended to the landing URL on an accepted click.
  // Attribution is last-click only, inside the campaign's window (the clickId expires with it). Replays never double-count or double-bill.
  async function conversion(req, res) {
    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
    const m = bearer.match(/^mak_(key_[0-9a-f]{16})_([A-Za-z0-9_-]{43})$/);
    const key = m ? await repo.apiKeyByHash(createHash('sha256').update(m[2]).digest('hex')) : null;
    if (!key || key.id !== m[1] || key.scope !== 'write') return json(res, 401, { error: 'a write-scope API key is required' });
    if (!(await limiter.allow('conv:' + key.id))) return json(res, 429, { error: 'rate limited' });
    const b = await readJson(req);
    const event = String(b.event || ''), eventId = String(b.eventId || '').slice(0, 128), value = b.value == null ? 0 : Number(b.value);
    if (!/^[a-z0-9_]{1,32}$/.test(event) || !Number.isFinite(value) || value < 0 || value > 1e6) return json(res, 400, { error: 'event (a-z0-9_), optional eventId and value (0-1000000) required' });
    const p = verify(String(b.clickId || ''), secret) || (secretPrev ? verify(String(b.clickId || ''), secretPrev) : null);
    if (!p || p.k !== 'clk') { metrics.inc('mobiad_conversions_total', { result: 'invalid' }); return json(res, 410, { error: 'unknown or expired clickId (outside the attribution window)' }); }
    const c = catalog.campaigns.get(p.c) || (await repo.campaign(p.c));
    if (!c || c.owner !== key.user_id) return json(res, 403, { error: 'this clickId does not belong to your campaigns' });
    const hash = tokenHash(`conv|${p.ck}|${event}|${eventId}`), now = Date.now();
    const cost = c.model === 'CPA' && event === c.conversionEvent ? c.bid : 0;
    await ledger.push({ type: 'conversion', campaignId: c.id, appId: p.a, ...dimsOf(p), cost, t: now, token: `conv|${p.ck}|${event}|${eventId}` }); // idempotent by token hash, durable before we answer
    const first = await repo.recordConversion({ id: 'cnv_' + hash.slice(0, 16), campaignId: c.id, appId: p.a, event, eventId, value, hash, at: now });
    if (!first) { metrics.inc('mobiad_conversions_total', { result: 'duplicate' }); return json(res, 200, { ok: true, duplicate: true }); }
    c.conversions = (c.conversions || 0) + 1;
    if (cost) await bill(c, cost);
    metrics.inc('mobiad_conversions_total', { result: 'counted' });
    return json(res, 200, { ok: true, billedUsd: cost / 1 });
  }

  const publicCreative = (cr) => ({ title: cr.title, image: cr.image, ...(cr.videoUrl ? { videoUrl: cr.videoUrl, durationSec: cr.durationSec } : {}), ...(cr.playableUrl ? { playableUrl: cr.playableUrl } : {}),
    ...(cr.cta ? { cta: cr.cta } : {}), ...(cr.body ? { body: cr.body } : {}), ...(cr.iconUrl ? { iconUrl: cr.iconUrl } : {}), ...(cr.sponsor ? { sponsor: cr.sponsor } : {}), ...(cr.rating ? { rating: cr.rating } : {}) });

  return async function handle(req, res, url) {
    if (url.pathname.startsWith('/rtb/')) return rtb(req, res, url);
    // Test mode: integrators can verify their rendering without any auction, billing or tracking. Test ads never touch the ledger.
    if (req.method === 'GET' && url.pathname === '/v1/test/pixel') { res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' }); return res.end(GIF); }
    if (req.method === 'GET' && url.pathname === '/v1/test/click') { res.writeHead(302, { Location: 'https://example.com/' }); return res.end(); }
    if (req.method === 'POST' && url.pathname === '/v1/ad') {
      if (!(await limiter.allow(clientIp(req)))) return json(res, 429, { error: 'rate limited' });
      const b = await readJson(req);
      const app = await catalog.app(String(b.appId || ''));
      if (!app) return json(res, 404, { error: 'unknown app' });
      if (b.test === true) {
        const f = AD_FORMATS.includes(b.format) ? b.format : 'banner', base0 = getPublicUrl(), px = `${base0}/v1/test/pixel`, video = f === 'video' || f === 'rewarded';
        metrics.inc('mobiad_ad_requests_total', { filled: 'test' });
        return json(res, 200, { test: true, creative: { title: 'MobiAd test ad', image: '', cta: 'Learn more', ...(video ? { videoUrl: `${base0}/media/sample.mp4`, durationSec: 5 } : {}), ...(f === 'native' ? { body: 'This is a test native ad', sponsor: 'MobiAd', rating: 4.5 } : {}), ...(f === 'playable' ? { playableUrl: 'https://cdn.example.com/test/index.html' } : {}) },
          impressionUrl: px, viewableUrl: px, clickUrl: `${base0}/v1/test/click`, installUrl: px, ...(video ? { videoCompleteUrl: px } : {}), ...(f === 'rewarded' ? { reward: { amount: app.rewardAmount || 1, item: app.rewardItem || 'reward' } } : {}) });
      }
      const placement = b.placementId ? catalog.placements.get(String(b.placementId)) : null;
      if (b.placementId && (!placement || placement.appId !== app.id)) return json(res, 400, { error: 'unknown placement for this app' });
      const format = AD_FORMATS.includes(b.format) ? b.format : (placement?.format || 'banner');
      const country2 = /^[A-Za-z]{2}$/.test(String(b.country || '')) ? String(b.country).toUpperCase() : '';
      const sig = { lang: typeof b.language === 'string' ? b.language : undefined, deviceType: b.deviceType, osVersion: b.osVersion, connection: b.connection, hourUtc: new Date().getUTCHours(), appId: app.id };
      const dev = personalizationAllowedHere(app, b.consent || {}) && typeof b.deviceId === 'string' && b.deviceId.length > 0 && b.deviceId.length <= 128 ? deviceKey(b.deviceId, app.id) : null;
      const floorEcpm = Math.max(app.floorEcpm || 0, placement?.floorEcpm || 0), consent = b.consent || {}, personalize = personalizationAllowedHere(app, consent);
      const partners = PARTNER_FORMATS.includes(format) ? catalog.partnersFor(format, { childDirected: app.childDirected || !!consent.coppa }) : [];
      const extPromise = partners.length ? collectBids({ partners, breakers, metrics, log, allowPrivate: allowPrivateCallbacks,
        request: buildBidRequest({ app, placement, format, floorEcpm, country: country2, sig, ua: req.headers['user-agent'], ip: clientIp(req), deviceId: personalize && typeof b.deviceId === 'string' ? b.deviceId.slice(0, 128) : undefined, personalize: personalize && typeof b.deviceId === 'string', consent, blockedCategories: app.blockedCategories || [] }),
        parseOpts: { floorEcpm, blockedCategories: app.blockedCategories || [], format, allowHttp: allowPrivateCallbacks } }).catch(() => []) : Promise.resolve([]);
      const exclude = new Set();
      let win = null;
      for (let attempt = 0; attempt < 4; attempt++) { // skip campaigns this device has already seen too often today
        win = runAuction(catalog.list(), {
          format, country: b.country, platform: app.platform, floorEcpm: Math.max(app.floorEcpm || 0, placement?.floorEcpm || 0), ...sig,
          excludeIds: exclude, blockedCategories: app.blockedCategories, childDirected: app.childDirected, ownerId: app.owner,
        });
        if (!win || !dev || !win.campaign.freqCap) break;
        if ((await counters.get(`fc:${win.campaign.id}:${dev}`)) < win.campaign.freqCap) break;
        exclude.add(win.campaign.id); win = null; metrics.inc('mobiad_freqcap_skips_total');
      }
      const ext = await extPromise;
      const outcome = unify(win ? { campaign: win.campaign, winEcpm: win.winEcpm, runnerUpEcpm: win.runnerUpEcpm } : null, ext, floorEcpm);
      metrics.inc('mobiad_ad_requests_total', { filled: outcome ? 'true' : 'false' });
      if (!outcome) return json(res, 204, null);
      if (outcome.type === 'external') { // a partner's bid won the unified auction
        const bid = outcome.bid, price = outcome.clearingEcpm, base2 = getPublicUrl();
        const tok2 = sign({ x: 1, pt: bid.partnerId, a: app.id, p: price, ...(bid.burl ? { bu: bid.burl } : {}), ...(placement ? { pl: placement.id } : {}), ...(country2 ? { co: country2 } : {}), fm: format }, secret);
        if (bid.nurl) safePost(macro(bid.nurl, price), { method: 'GET', timeoutMs: 1500, allowPrivate: allowPrivateCallbacks, allowHttp: allowPrivateCallbacks }).catch(() => {}); // win notice
        metrics.inc('mobiad_partner_wins_total', { partner: bid.partnerId });
        return json(res, 200, { external: { markup: bid.markup, adm: macro(bid.adm, price), ...(bid.w ? { width: bid.w } : {}), ...(bid.h ? { height: bid.h } : {}) }, impressionUrl: `${base2}/t/i/${tok2}`, viewableUrl: `${base2}/t/w/${tok2}`, ...(format === 'rewarded' ? { reward: { amount: app.rewardAmount || 1, item: app.rewardItem || 'reward' } } : {}) });
      }
      win = { ...win, clearingEcpm: outcome.clearingEcpm };
      const c = win.campaign;
      const cr = pickCreative(c, cstats);
      const tok = sign({ c: c.id, a: app.id, p: win.clearingEcpm, r: cr.id, ...(placement ? { pl: placement.id } : {}), ...(country2 ? { co: country2 } : {}), fm: format, ...(format === 'rewarded' && b.userId ? { u: String(b.userId).slice(0, 128) } : {}), ...(dev && c.freqCap ? { d: dev } : {}) }, secret);
      const base = getPublicUrl();
      return json(res, 200, {
        creative: publicCreative(cr),
        impressionUrl: `${base}/t/i/${tok}`, viewableUrl: `${base}/t/w/${tok}`, clickUrl: `${base}/t/c/${tok}`, installUrl: `${base}/t/x/${tok}`, ...(cr.videoUrl ? { videoCompleteUrl: `${base}/t/v/${tok}` } : {}),
        ...(format === 'rewarded' ? { reward: { amount: app.rewardAmount || 1, item: app.rewardItem || 'reward' } } : {}),
      });
    }
    if (req.method === 'POST' && url.pathname === '/v1/conversion') return conversion(req, res);
    const m = url.pathname.match(/^\/t\/([icxvw])\/(.+)$/);
    if (req.method === 'GET' && m) {
      const [, kind, token] = m;
      let clickId = null;
      const p = verify(token, secret) || (secretPrev ? verify(token, secretPrev) : null);
      if (!p) { metrics.inc('mobiad_tracking_total', { kind, result: 'invalid' }); return json(res, 400, { error: 'invalid token' }); }
      if (p.x) { // impression of an external (partner) ad: records publisher revenue under ext_<partner>; clicks are handled inside the partner's markup
        if (kind === 'w') { // viewability of a partner ad: counted (free) once, and only for an impression we have seen
          if (isDegraded() || (await deduper.has('impression:' + token))) {
            if (await deduper.firstTime('viewable:' + token)) { await ledger.push({ type: 'viewable', campaignId: 'ext_' + p.pt, appId: p.a, creativeId: '', placementId: p.pl || '', country: p.co || '', format: p.fm || '', cost: 0, t: Date.now(), token }); metrics.inc('mobiad_tracking_total', { kind, result: 'counted' }); } else metrics.inc('mobiad_tracking_total', { kind, result: 'duplicate' });
          } else metrics.inc('mobiad_tracking_total', { kind, result: 'no_impression' });
          res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' }); return res.end(GIF);
        }
        if (kind !== 'i') return json(res, 400, { error: 'not applicable to partner ads' });
        if (await deduper.firstTime('impression:' + token)) {
          await ledger.push({ type: 'impression', campaignId: 'ext_' + p.pt, appId: p.a, creativeId: '', placementId: p.pl || '', country: p.co || '', format: p.fm || '', cost: p.p / 1000, t: Date.now(), token });
          if (p.bu) safePost(macro(p.bu, p.p), { method: 'GET', timeoutMs: 1500, allowPrivate: allowPrivateCallbacks, allowHttp: allowPrivateCallbacks }).catch(() => {}); // billing notice
          metrics.inc('mobiad_tracking_total', { kind, result: 'counted' });
        } else metrics.inc('mobiad_tracking_total', { kind, result: 'duplicate' });
        res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' }); return res.end(GIF);
      }
      const c = catalog.campaigns.get(p.c) || (await repo.campaign(p.c));
      if (!c) return json(res, 404, { error: 'gone' });
      const type = TYPES[kind];
      if (kind === 'w' && !(isDegraded() || (await deduper.has('impression:' + token)))) { // "viewable" only makes sense after a counted impression; do not consume the token so a late-arriving impression can still be followed by it
        metrics.inc('mobiad_tracking_total', { kind, result: 'no_impression' });
        res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' }); return res.end(GIF);
      }
      if (await deduper.firstTime(type + ':' + token)) { // process only the first event per token
        let verdict = { valid: true };
        if (kind === 'c') {
          const app = await catalog.app(p.a);
          const now = Date.now();
          verdict = judgeClick({
            issuedAt: p.iat || p.exp - 24 * 3600e3, now,
            // During a Redis outage impressions seen by another replica are invisible to us: give clicks the benefit of the doubt.
            impressionSeen: isDegraded() || (await deduper.has('impression:' + token)),
            selfDealing: !!app && app.owner === c.owner,
            ipClicksThisMinute: await counters.incr(`ipclk:${c.id}:${clientIp(req)}`, 60),
          });
        }
        if (!verdict.valid) { // recorded for audit/reporting but never billed and never counted as a click
          await ledger.push({ type: 'invalid_click', campaignId: c.id, appId: p.a, ...dimsOf(p), cost: 0, t: Date.now(), token });
          metrics.inc('mobiad_invalid_clicks_total', { reason: verdict.reason });
        } else {
          let cost = 0;
          if (kind === 'i' && c.model === 'CPM') cost = p.p / 1000;
          if (kind === 'c' && c.model === 'CPC') cost = c.bid;
          if (kind === 'i') { c.impressions++; if (p.d) await counters.incr(`fc:${c.id}:${p.d}`, 86400); }
          if (kind === 'c') c.clicks++;
          if (kind === 'c') clickId = sign({ k: 'clk', c: c.id, a: p.a, ck: tokenHash(token).slice(0, 24), r: p.r, pl: p.pl, co: p.co, fm: p.fm }, secret, (c.attributionDays || 7) * 86_400_000); // one attribution id per accepted click
          await bill(c, cost);
          await ledger.push({ type, campaignId: c.id, appId: p.a, ...dimsOf(p), cost, t: Date.now(), token }); // resolves once durable
          if (p.r && (kind === 'i' || kind === 'c')) noteCreative(cstats, c.id, p.r, type);
          if (kind === 'v' && p.fm === 'rewarded') { // server-to-server reward: only for a plausible full playback after a seen impression
            const app = await catalog.app(p.a), cr = creativesOf(c).find((x) => x.id === p.r) || c.creative;
            const watched = Date.now() - (p.iat || 0) >= (cr.durationSec || 0) * 800;
            if (app && watched && (isDegraded() || (await deduper.has('impression:' + token)))) {
              deliverReward({ app, userId: p.u, txn: tokenHash('rwd' + token).slice(0, 24), allowPrivate: allowPrivateCallbacks, allowHttp: allowPrivateCallbacks, metrics, log }).catch(() => {});
            } else metrics.inc('mobiad_reward_callbacks_total', { result: 'skipped' });
          }
          metrics.inc('mobiad_tracking_total', { kind, result: 'counted' });
        }
      } else metrics.inc('mobiad_tracking_total', { kind, result: 'duplicate' });
      if (kind === 'c') {
        const cr = creativesOf(c).find((x) => x.id === p.r) || c.creative;
        let loc = cr.clickUrl || c.creative.clickUrl;
        if (clickId) { try { const u = new URL(loc); u.searchParams.set('mobiad_click_id', clickId); loc = u.toString(); } catch { /* keep the plain URL */ } }
        res.writeHead(302, { Location: loc }); return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' });
      return res.end(GIF);
    }
    return false;
  };
}
