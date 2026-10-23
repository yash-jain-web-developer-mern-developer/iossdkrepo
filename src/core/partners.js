// Unified auction with external demand partners (DSPs) over OpenRTB 2.6, "header bidding" style: MobiAd's own campaigns and the
// partners' bids compete in ONE second-price auction. Everything here is pure or takes its I/O as a parameter so it is unit-testable.
import { randomBytes } from 'node:crypto';
import { safePost } from './safeHttp.js';

export const PARTNER_FORMATS = ['banner', 'interstitial', 'video', 'rewarded'];
const MAX_ADM = 100_000;

const round4 = (n) => +n.toFixed(4);
export const macro = (str, price) => String(str).split('${AUCTION_PRICE}').join(String(round4(price)));

// Build an OpenRTB 2.6 BidRequest. Personal data is only included when the consent logic allowed it.
export function buildBidRequest({ app, placement, format, floorEcpm, country, sig = {}, ua, ip, deviceId, personalize, consent = {}, tmax, blockedCategories = [] }) {
  const imp = { id: '1', tagid: placement?.id || '', bidfloor: floorEcpm || 0, bidfloorcur: 'USD', secure: 1 };
  if (format === 'video' || format === 'rewarded') Object.assign(imp, { video: { mimes: ['video/mp4'], minduration: 1, maxduration: 60, protocols: [2, 3, 5, 6], w: 640, h: 360, linearity: 1 }, ...(format === 'rewarded' ? { rwdd: 1 } : {}) });
  else if (format === 'interstitial') Object.assign(imp, { instl: 1, banner: { w: 320, h: 480, format: [{ w: 320, h: 480 }] } });
  else Object.assign(imp, { banner: { w: 320, h: 50, format: [{ w: 320, h: 50 }] } });
  return {
    id: randomBytes(8).toString('hex'), imp: [imp], at: 2, tmax, cur: ['USD'], bcat: blockedCategories.slice(0, 30),
    app: { id: app.id, name: app.name, publisher: { id: app.owner } },
    device: { ua: ua || undefined, os: app.platform === 'ios' ? 'iOS' : 'Android', osv: sig.osVersion ? String(sig.osVersion).slice(0, 20) : undefined, devicetype: sig.deviceType === 'tablet' ? 5 : 4,
      language: sig.lang ? String(sig.lang).slice(0, 2) : undefined, connectiontype: sig.connection === 'wifi' ? 2 : sig.connection === 'cellular' ? 6 : 0, lmt: consent.limitAdTracking ? 1 : 0,
      geo: country ? { country } : undefined, ...(personalize ? { ip, ifa: deviceId } : {}) },
    regs: { coppa: app.childDirected || consent.coppa ? 1 : 0, ext: { gdpr: consent.gdpr ? 1 : 0, ...(consent.usPrivacy ? { us_privacy: String(consent.usPrivacy).slice(0, 4) } : {}) } },
    ...(consent.gdprConsent ? { user: { ext: { consent: String(consent.gdprConsent).slice(0, 2000) } } } : {}),
  };
}

// Returns the best valid bid from a BidResponse or null. A partner is never trusted: every field is validated.
export function parseBidResponse(json, { floorEcpm = 0, blockedCategories = [], format, allowHttp = false }) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.seatbid)) return null;
  if (json.cur && json.cur !== 'USD') return null;
  let best = null;
  for (const sb of json.seatbid.slice(0, 5)) for (const b of (Array.isArray(sb?.bid) ? sb.bid.slice(0, 10) : [])) {
    if (!b || b.impid !== '1' || !Number.isFinite(b.price) || b.price <= 0 || b.price > 1000) continue;
    if (typeof b.adm !== 'string' || !b.adm || b.adm.length > MAX_ADM) continue;
    if (b.price < floorEcpm) continue;
    if (Array.isArray(b.cat) && b.cat.some((c) => blockedCategories.includes(String(c)))) continue;
    const isVast = /^\s*(<\?xml|<VAST)/i.test(b.adm);
    if ((format === 'video' || format === 'rewarded') && !isVast) continue; // video slots need VAST
    if (format !== 'video' && format !== 'rewarded' && isVast) continue;
    const url = (u) => (typeof u === 'string' && (allowHttp ? /^https?:\/\//i : /^https:\/\//i).test(u) && u.length <= 1000 ? u : undefined);
    if (!best || b.price > best.price) best = { price: b.price, adm: b.adm, markup: isVast ? 'vast' : 'html', nurl: url(b.nurl), burl: url(b.burl), crid: typeof b.crid === 'string' ? b.crid.slice(0, 64) : '', w: b.w, h: b.h };
  }
  return best;
}

// Per-partner circuit breaker: opens after `failures` consecutive failures for `openMs`.
export class PartnerBreakers {
  constructor({ failures = 5, openMs = 10_000, now = Date.now } = {}) { this.failures = failures; this.openMs = openMs; this.now = now; this.s = new Map(); }
  allow(id) { const x = this.s.get(id); return !x || x.openUntil <= this.now(); }
  ok(id) { this.s.delete(id); }
  fail(id) { const x = this.s.get(id) || { n: 0, openUntil: 0 }; x.n++; if (x.n >= this.failures) { x.openUntil = this.now() + this.openMs; x.n = 0; } this.s.set(id, x); }
}

// Ask every eligible partner in parallel; never waits longer than each partner's timeout. Returns bids sorted by price, best first.
export async function collectBids({ partners, request, parseOpts, breakers, metrics, log, post = safePost, allowPrivate = false }) {
  const bids = await Promise.all(partners.map(async (p) => {
    if (!breakers.allow(p.id)) { metrics?.inc('mobiad_partner_requests_total', { partner: p.id, result: 'breaker_open' }); return null; }
    const t0 = Date.now();
    try {
      const body = JSON.stringify({ ...request, tmax: p.timeoutMs });
      const r = await post(p.endpointUrl, { body, headers: { 'x-openrtb-version': '2.6', ...(p.authHeader ? { authorization: p.authHeader } : {}) }, timeoutMs: p.timeoutMs + 50, allowPrivate, allowHttp: allowPrivate, maxBytes: 200_000 });
      metrics?.observe('mobiad_partner_latency_seconds', { partner: p.id }, (Date.now() - t0) / 1000);
      breakers.ok(p.id);
      if (r.status === 204) { metrics?.inc('mobiad_partner_requests_total', { partner: p.id, result: 'nobid' }); return null; }
      if (r.status !== 200) { metrics?.inc('mobiad_partner_requests_total', { partner: p.id, result: 'http_error' }); breakers.fail(p.id); return null; }
      let j; try { j = JSON.parse(r.body); } catch { metrics?.inc('mobiad_partner_requests_total', { partner: p.id, result: 'bad_response' }); return null; }
      const bid = parseBidResponse(j, parseOpts);
      metrics?.inc('mobiad_partner_requests_total', { partner: p.id, result: bid ? 'bid' : 'invalid' });
      return bid ? { ...bid, partnerId: p.id } : null;
    } catch (e) {
      breakers.fail(p.id);
      metrics?.inc('mobiad_partner_requests_total', { partner: p.id, result: /timeout/i.test(e.message) ? 'timeout' : 'error' });
      log?.error?.('partner request failed', { partner: p.id, err: e.message });
      return null;
    }
  }));
  return bids.filter(Boolean).sort((a, b) => b.price - a.price);
}

// One second-price auction across MobiAd's campaigns and external bids.
// internal: { campaign, winEcpm, runnerUpEcpm|null } | null; ext: bids sorted desc. Ties go to MobiAd's own campaign.
export function unify(internal, ext, floorEcpm = 0) {
  const e1 = ext[0], e2 = ext[1], iw = internal ? internal.winEcpm : -1;
  if (e1 && e1.price > iw) {
    const rival = Math.max(iw > 0 ? iw : 0, e2 ? e2.price : 0);
    const clearing = Math.min(e1.price, Math.max(rival > 0 ? rival + 0.01 : floorEcpm, floorEcpm, 0.01));
    return { type: 'external', bid: e1, clearingEcpm: round4(clearing) };
  }
  if (!internal) return null;
  const rival = Math.max(internal.runnerUpEcpm || 0, e1 ? e1.price : 0);
  const clearing = Math.min(internal.winEcpm, Math.max(rival > 0 ? rival + 0.01 : floorEcpm, floorEcpm, 0.01));
  return { type: 'internal', campaign: internal.campaign, clearingEcpm: round4(Math.min(clearing, internal.winEcpm)) };
}
