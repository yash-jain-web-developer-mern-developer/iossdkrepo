// Advertiser campaigns, publisher apps, reports.
import { json, readJson } from '../http.js';
import { id, strs, toCsv, usdToMicros, microsToUsd } from './util.js';
import { screenCreative, initialReview, CATEGORIES, NEVER_CHILD } from '../policy.js';
import { sanitizeTargeting } from '../core/targeting.js';
import { creativesOf } from '../core/creative.js';
import { validateOutboundUrl } from '../core/safeHttp.js';
import { newRewardSecret } from '../core/rewards.js';

const CREATIVE_KEYS = ['title', 'image', 'clickUrl', 'cta', 'videoUrl', 'durationSec', 'playableUrl', 'body', 'iconUrl', 'sponsor', 'rating'];
const MAX_CREATIVES = 5;
// Merge a creative's own fields over the campaign-level defaults and return { out (stored shape), merged (for screening) }.
function normalizeCreative(src, dflt, name) {
  const m = { ...dflt };
  for (const k of CREATIVE_KEYS) if (src[k] != null && src[k] !== '') m[k] = src[k];
  const out = { title: String(m.title || name).slice(0, 120), image: String(m.image || ''), clickUrl: m.clickUrl };
  if (m.videoUrl) { out.videoUrl = String(m.videoUrl); out.durationSec = Math.round(+m.durationSec); }
  if (m.playableUrl) out.playableUrl = String(m.playableUrl);
  if (m.cta) out.cta = String(m.cta).slice(0, 30);
  if (m.body) out.body = String(m.body).slice(0, 200);
  if (m.iconUrl) out.iconUrl = String(m.iconUrl);
  if (m.sponsor) out.sponsor = String(m.sponsor).slice(0, 60);
  if (m.rating != null && m.rating !== '') out.rating = Math.round(+m.rating * 10) / 10;
  return { out, merged: m };
}
const publicApp = (a) => ({ ...a, rewardSecret: undefined, hasRewardSecret: !!a.rewardSecret });

const FORMATS = ['banner', 'interstitial', 'native', 'video', 'playable'];
const emptyStats = { impressions: 0, clicks: 0, installs: 0, invalidClicks: 0, conversions: 0, spend: 0 };

export function campaignRoutes(ctx) {
  const { repo, cfg } = ctx;
  const needFunds = (u) => cfg.requireFunding && u.role === 'advertiser';

  return {
    'POST /api/campaigns': { role: 'advertiser', verified: true, handler: async ({ req, res, u }) => {
      const b = await readJson(req);
      if (!b.name || !(b.bid > 0) || !(b.budget > 0) || b.bid > 1e5 || b.budget > 1e7) return json(res, 400, { error: 'name, bid>0, budget>0 required (bid ≤ 100000, budget ≤ 10000000)' });
      const category = b.category || 'general';
      const format = FORMATS.includes(b.format) ? b.format : 'banner';
      const list = Array.isArray(b.creatives) && b.creatives.length ? b.creatives : [{}];
      if (list.length > MAX_CREATIVES) return json(res, 400, { error: `at most ${MAX_CREATIVES} creatives per campaign` });
      const dflt = Object.fromEntries(CREATIVE_KEYS.map((k) => [k, b[k]]));
      const norm = list.map((x) => normalizeCreative(x || {}, dflt, b.name));
      const screen = { hard: [], soft: [] };
      norm.forEach((n, i) => {
        const r = screenCreative({ ...n.merged, name: b.name, category, format }, { requireHttps: cfg.requireHttpsCreatives, blockedDomains: cfg.blockedDomains, allowLocal: cfg.allowPrivateCallbacks });
        r.hard.forEach((x) => screen.hard.push(list.length > 1 ? `creative ${i + 1}: ${x}` : x)); r.soft.forEach((x) => { if (!screen.soft.includes(x)) screen.soft.push(x); });
      });
      if (screen.hard.length) return json(res, 400, { error: 'creative_rejected', reasons: screen.hard });
      const childSafe = !!b.childSafe && !NEVER_CHILD.has(category);
      if (b.childSafe && !childSafe) return json(res, 400, { error: `category "${category}" cannot be marked child-safe` });
      const reviewStatus = initialReview(screen, { autoApprove: cfg.autoApproveCampaigns });
      const budgetMicros = usdToMicros(b.budget);
      if (needFunds(u)) {
        const bal = await repo.advertiserBalance(u.id);
        if (bal.availableMicros < budgetMicros) return json(res, 402, { error: 'insufficient_funds', requiredUsd: microsToUsd(budgetMicros), availableUsd: microsToUsd(Math.max(0, bal.availableMicros)) });
      }
      const c = {
        id: id('cmp'), owner: u.id, name: String(b.name).slice(0, 120), format,
        model: ['CPC', 'CPA'].includes(b.model) ? b.model : 'CPM',
        conversionEvent: /^[a-z0-9_]{1,32}$/.test(b.conversionEvent || '') ? b.conversionEvent : 'install', attributionDays: Math.min(30, Math.max(1, Math.floor(+b.attributionDays || 7))), bid: +b.bid, budget: +b.budget, dailyBudget: Math.max(0, +b.dailyBudget || 0),
        countries: strs(b.countries), platforms: strs(b.platforms), endsAt: +b.endsAt || 0, status: 'active',
        creative: norm[0].out, creatives: Array.isArray(b.creatives) && b.creatives.length ? norm.map((n, i) => ({ id: 'cr_' + i, ...n.out })) : [],
        targeting: sanitizeTargeting(b.targeting),
        reviewStatus, category, childSafe, freqCap: Math.min(100, Math.max(0, Math.floor(+b.freqCap || 0))),
      };
      await repo.createCampaign(c);
      if (reviewStatus === 'pending' && screen.soft.length) await repo.setReview(c.id, { status: 'pending', note: 'Automated screening: ' + screen.soft.join('; '), by: 'system' });
      await ctx.audit(req, u.id, 'campaign_created', c.id, { reviewStatus, flags: screen.soft });
      if (reviewStatus === 'approved') await ctx.changed();
      return json(res, 201, { ...c, reviewNote: screen.soft.length ? screen.soft.join('; ') : null });
    } },
    'GET /api/campaigns': { handler: async ({ res, u }) => {
      const [list, st] = await Promise.all([repo.campaignsByOwner(u.id), repo.statsFor('advertiser', u.id)]);
      return json(res, 200, list.map((c) => ({ ...c, stats: st[c.id] || emptyStats })));
    } },
    // Add another creative to a campaign (rotation / A-B test). The campaign is re-screened and, unless auto-approved, goes back to review.
    'POST /api/campaigns/creative': { role: 'advertiser', verified: true, handler: async ({ req, res, u }) => {
      const b = await readJson(req), c = await repo.campaign(String(b.campaignId || ''));
      if (!c || c.owner !== u.id) return json(res, 404, { error: 'campaign not found' });
      const existing = creativesOf(c);
      if (existing.length >= MAX_CREATIVES) return json(res, 409, { error: `at most ${MAX_CREATIVES} creatives per campaign` });
      const n = normalizeCreative(b.creative || {}, { clickUrl: c.creative.clickUrl, title: c.creative.title }, c.name);
      const screen = screenCreative({ ...n.merged, name: c.name, category: c.category, format: c.format }, { requireHttps: cfg.requireHttpsCreatives, blockedDomains: cfg.blockedDomains, allowLocal: cfg.allowPrivateCallbacks });
      if (screen.hard.length) return json(res, 400, { error: 'creative_rejected', reasons: screen.hard });
      const nextIdx = existing.reduce((m, x) => Math.max(m, +(String(x.id).split('_')[1] || 0)), 0) + 1;
      const creatives = [...existing, { id: 'cr_' + nextIdx, ...n.out }];
      await repo.setCampaignCreatives(c.id, creatives, creatives[0]);
      const status = initialReview(screen, { autoApprove: cfg.autoApproveCampaigns });
      await repo.setReview(c.id, { status, note: status === 'pending' ? 'New creative added: ' + (screen.soft.join('; ') || 're-review') : null, by: 'system' });
      await ctx.audit(req, u.id, 'creative_added', c.id, { creative: 'cr_' + nextIdx, reviewStatus: status });
      await ctx.changed();
      return json(res, 201, { id: 'cr_' + nextIdx, reviewStatus: status, creatives });
    } },
    'GET /api/report/breakdown': { handler: async ({ res, u, url }) => {
      await ctx.ledger.flush?.();
      const rows = await repo.breakdown(u.role, u.id, url.searchParams.get('by') || (u.role === 'advertiser' ? 'campaign' : 'app'));
      return rows ? json(res, 200, rows) : json(res, 400, { error: u.role === 'advertiser' ? 'by must be campaign, app, creative, country or format' : 'by must be app, placement, country or format' });
    } },
    'POST /api/placements': { role: 'publisher', verified: true, handler: async ({ req, res, u }) => {
      const b = await readJson(req), a = await repo.app(String(b.appId || ''));
      if (!a || a.owner !== u.id) return json(res, 404, { error: 'app not found' });
      const name = String(b.name || '').trim().slice(0, 80), format = ['banner', 'interstitial', 'native', 'video', 'playable', 'rewarded'].includes(b.format) ? b.format : null;
      if (!name || !format) return json(res, 400, { error: 'name and format (banner|interstitial|native|video|playable|rewarded) required' });
      const p = { id: id('plc'), appId: a.id, name, format, floorEcpm: Math.max(0, +b.floorEcpm || 0) };
      await repo.createPlacement(p); await ctx.audit(req, u.id, 'placement_created', p.id, { appId: a.id, format }); await ctx.changed();
      return json(res, 201, p);
    } },
    'GET /api/placements': { handler: async ({ res, u }) => json(res, 200, await repo.placementsByOwner(u.id)) },
    // Rewarded video: where MobiAd sends the signed server-to-server reward callback. The secret is shown once.
    'POST /api/apps/reward': { role: 'publisher', verified: true, handler: async ({ req, res, u }) => {
      const b = await readJson(req), a = await repo.app(String(b.id || ''));
      if (!a || a.owner !== u.id) return json(res, 404, { error: 'app not found' });
      const problem = validateOutboundUrl(String(b.callbackUrl || ''), { allowPrivate: cfg.allowPrivateCallbacks, allowHttp: cfg.allowPrivateCallbacks });
      if (problem) return json(res, 400, { error: 'callbackUrl ' + problem });
      const amount = b.amount == null ? 1 : Math.floor(+b.amount), item = String(b.item || 'reward').trim();
      if (!(amount >= 1 && amount <= 1e6) || !/^[\w .-]{1,40}$/.test(item)) return json(res, 400, { error: 'amount (1-1000000) and item (letters, digits, space, . _ -) required' });
      const secret = !a.rewardSecret || b.rotateSecret ? newRewardSecret() : null;
      await repo.setAppReward(a.id, { url: String(b.callbackUrl), secret, amount, item });
      await ctx.audit(req, u.id, 'reward_configured', a.id, { amount, item, rotated: !!secret }); await ctx.changed();
      return json(res, 200, { ok: true, ...(secret ? { secret, note: 'Store this secret now; it cannot be shown again. Verify X-MobiAd-Signature = sha256=HMAC(secret, raw body).' } : {}) });
    } },
    'POST /api/campaigns/status': { role: 'advertiser', handler: async ({ req, res, u }) => {
      const b = await readJson(req), c = await repo.campaign(String(b.id || ''));
      if (!c || c.owner !== u.id || !['active', 'paused'].includes(b.status)) return json(res, 400, { error: 'invalid' });
      if (c.status === 'exhausted') return json(res, 409, { error: 'budget exhausted' });
      await repo.setCampaignStatus(c.id, b.status);
      await ctx.audit(req, u.id, 'campaign_status', c.id, { status: b.status });
      await ctx.changed();
      return json(res, 200, { ...c, status: b.status });
    } },

    'POST /api/apps': { role: 'publisher', verified: true, handler: async ({ req, res, u }) => {
      const b = await readJson(req);
      if (!b.name) return json(res, 400, { error: 'name required' });
      const blocked = strs(b.blockedCategories);
      if (blocked.some((x) => !CATEGORIES.includes(x))) return json(res, 400, { error: `blockedCategories must be from: ${CATEGORIES.join(', ')}` });
      const a = { id: id('app'), owner: u.id, name: String(b.name).slice(0, 120), platform: b.platform === 'ios' ? 'ios' : 'android',
        floorEcpm: Math.max(0, +b.floorEcpm || 0), childDirected: !!b.childDirected, blockedCategories: blocked };
      await repo.createApp(a);
      await ctx.audit(req, u.id, 'app_created', a.id, { childDirected: a.childDirected });
      await ctx.changed();
      return json(res, 201, a);
    } },
    'GET /api/apps': { handler: async ({ res, u }) => {
      const [list, st] = await Promise.all([repo.appsByOwner(u.id), repo.statsFor('publisher', u.id)]);
      return json(res, 200, list.map((a) => ({ ...publicApp(a), stats: st[a.id] || emptyStats })));
    } },

    'GET /api/report': { handler: async ({ res, u }) => { await ctx.ledger.flush?.(); return json(res, 200, await repo.report(u.role, u.id)); } },
    'GET /api/report.csv': { handler: async ({ res, u }) => {
      await ctx.ledger.flush?.();
      const rep = await repo.report(u.role, u.id), adv = u.role === 'advertiser';
      const csv = toCsv(['date', 'impressions', 'clicks', 'ctr', 'invalid_clicks', ...(adv ? ['conversions', 'conversion_value_usd'] : []), adv ? 'spend_usd' : 'earnings_usd', 'viewable_impressions', 'viewability'],
        Object.entries(rep.daily).map(([d, v]) => [d, v.impressions, v.clicks, v.ctr.toFixed(4), v.invalidClicks, ...(adv ? [v.conversions, v.conversionValue] : []), adv ? v.spend : v.publisherRevenue, v.viewables, v.viewability.toFixed(4)]));
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="mobiad-report.csv"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(csv);
    } },
  };
}
