// OpenRTB 2.6 bidder endpoint: lets an exchange/SSP send MobiAd a BidRequest and receive a BidResponse.
// The exchange is registered as an app (`app.id` in the request = a MobiAd appId) so floors, blocklists, child-directed
// rules and self-dealing checks apply exactly as for SDK traffic. Banner and video (answered with VAST 4.2) impressions; everything else is a no-bid.
// Billing happens when the exchange calls `nurl` (our signed impression URL) after winning, never at bid time.
import { runAuction } from '../core/auction.js';
import { sign } from '../core/token.js';

const ALPHA3 = { USA: 'US', GBR: 'GB', IND: 'IN', DEU: 'DE', FRA: 'FR', CAN: 'CA', AUS: 'AU', BRA: 'BR', JPN: 'JP', IDN: 'ID', MEX: 'MX', ESP: 'ES', ITA: 'IT', NLD: 'NL', SGP: 'SG', ARE: 'AE' };
const MAX_IMPS = 10;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const httpsOnly = (u) => (/^https?:\/\//i.test(u) ? u : '');

export const toAlpha2 = (c) => { const s = String(c || '').toUpperCase(); return s.length === 3 ? ALPHA3[s] || '' : s; };

// Map OpenRTB regs/user/device fields onto the consent object used by personalizationAllowed().
export function rtbConsent(r) {
  return {
    coppa: r.regs?.coppa === 1,
    gdpr: r.regs?.ext?.gdpr === 1 || r.regs?.gdpr === 1,
    gdprConsent: r.user?.ext?.consent || r.user?.consent || '',
    usPrivacy: r.regs?.ext?.us_privacy || r.regs?.us_privacy || '',
    limitAdTracking: r.device?.lmt === 1,
  };
}

export const validBidRequest = (r) => !!r && typeof r === 'object' && typeof r.id === 'string' && r.id.length > 0 && r.id.length <= 128 && Array.isArray(r.imp) && r.imp.length > 0;

const MIME = { mp4: 'video/mp4', webm: 'video/webm', m3u8: 'application/x-mpegURL' };
const hms = (sec) => new Date(Math.max(1, Math.round(sec)) * 1000).toISOString().slice(11, 19);

// VAST 4.2 inline ad. The impression and click are tracked through our signed, idempotent tracking URLs.
export function buildVast({ campaign: c }, tok, base) {
  const ext = (new URL(c.creative.videoUrl).pathname.match(/\.(\w+)$/) || [])[1]?.toLowerCase();
  return `<?xml version="1.0" encoding="UTF-8"?><VAST version="4.2"><Ad id="${esc(c.id)}"><InLine><AdSystem>MobiAd</AdSystem><AdTitle>${esc(c.creative.title)}</AdTitle>` +
    `<Impression><![CDATA[${base}/t/i/${tok}]]></Impression><Creatives><Creative><Linear><Duration>${hms(c.creative.durationSec)}</Duration>` +
    `<TrackingEvents><Tracking event="complete"><![CDATA[${base}/t/v/${tok}]]></Tracking></TrackingEvents>` +
    `<VideoClicks><ClickThrough><![CDATA[${base}/t/c/${tok}]]></ClickThrough></VideoClicks>` +
    `<MediaFiles><MediaFile delivery="progressive" type="${MIME[ext] || 'video/mp4'}" width="640" height="360"><![CDATA[${c.creative.videoUrl}]]></MediaFile></MediaFiles></Linear></Creative></Creatives></InLine></Ad></VAST>`;
}

export function buildBid({ imp, win, tok, base, rid }) {
  const c = win.campaign, click = `${base}/t/c/${tok}`;
  if (imp.video) return { id: `${rid}:${imp.id}`, impid: imp.id, price: win.clearingEcpm, nurl: `${base}/t/i/${tok}`, adm: buildVast(win, tok, base), adomain: [], crid: c.id, w: imp.video.w || 640, h: imp.video.h || 360, cat: c.category ? [String(c.category)] : [] };
  const w = imp.banner.w || imp.banner.format?.[0]?.w || 320, h = imp.banner.h || imp.banner.format?.[0]?.h || 50;
  const adm = `<a href="${esc(click)}" target="_blank" rel="noopener"><img src="${esc(httpsOnly(c.creative.image))}" alt="${esc(c.creative.title)}" width="${w}" height="${h}"></a>`;
  return { id: `${rid}:${imp.id}`, impid: imp.id, price: win.clearingEcpm, nurl: `${base}/t/i/${tok}`, adm, adomain: [], crid: c.id, w, h, cat: c.category ? [String(c.category)] : [] };
}

export function rtbHandler({ catalog, limiter, secret, getPublicUrl, metrics, personalizationAllowed, deviceKey, clientIp, json, readJson }) {
  return async function handle(req, res, url) {
    if (req.method !== 'POST' || url.pathname !== '/rtb/v2.6/bid') return false;
    if (!(await limiter.allow(clientIp(req)))) return json(res, 429, { error: 'rate limited' });
    const r = await readJson(req);
    if (!validBidRequest(r)) return json(res, 400, { error: 'invalid BidRequest' });
    const app = await catalog.app(String(r.app?.id || ''));
    if (!app) { metrics.inc('mobiad_rtb_requests_total', { result: 'unknown_app' }); return res.writeHead(204).end(); }
    const consent = rtbConsent(r);
    const dev = personalizationAllowed(app, consent) && typeof r.device?.ifa === 'string' && r.device.ifa && r.device.ifa.length <= 128 ? deviceKey(r.device.ifa, app.id) : null;
    const country = toAlpha2(r.device?.geo?.country || r.user?.geo?.country);
    const base = getPublicUrl(), bids = [];
    for (const imp of r.imp.slice(0, MAX_IMPS)) {
      if (!imp || typeof imp.id !== 'string' || !(imp.banner || imp.video)) continue; // banner and video only
      const cur = imp.bidfloorcur || 'USD';
      if (cur !== 'USD') continue; // no currency conversion: no-bid
      const floor = Math.max(Number(imp.bidfloor) || 0, app.floorEcpm || 0);
      const win = runAuction(catalog.list(), {
        format: imp.video && !imp.banner ? 'video' : 'banner', country, platform: app.platform, floorEcpm: floor,
        blockedCategories: [...(app.blockedCategories || []), ...(Array.isArray(r.bcat) ? r.bcat.map(String) : [])],
        childDirected: app.childDirected || consent.coppa, ownerId: app.owner,
      });
      if (!win) continue;
      const tok = sign({ c: win.campaign.id, a: app.id, p: win.clearingEcpm, ...(dev && win.campaign.freqCap ? { d: dev } : {}) }, secret);
      bids.push(buildBid({ imp, win, tok, base, rid: r.id }));
    }
    metrics.inc('mobiad_rtb_requests_total', { result: bids.length ? 'bid' : 'nobid' });
    if (!bids.length) { res.writeHead(204); return res.end(); }
    return json(res, 200, { id: r.id, seatbid: [{ seat: 'mobiad', bid: bids }], cur: 'USD' });
  };
}
