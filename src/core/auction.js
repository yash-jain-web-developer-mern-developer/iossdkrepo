// Pure auction logic: no I/O, deterministic, unit-testable.
import { targetingOk } from './targeting.js';
export const PRIOR_CTR = 0.02;

export function eligible(c, req, now) {
  return c.status === 'active' &&
    c.spent < c.budget &&
    (c.format === req.format || (req.format === 'rewarded' && c.format === 'video')) && // rewarded slots accept video creatives
    targetingOk(c.targeting, req) &&
    (!c.countries.length || c.countries.includes(req.country)) &&
    (!c.platforms.length || c.platforms.includes(req.platform)) &&
    (!c.endsAt || c.endsAt > now) &&
    !(c.dailyBudget && c.spentToday >= c.dailyBudget) &&
    !(req.excludeIds && req.excludeIds.has(c.id)) &&                       // e.g. frequency-capped for this device
    !(req.blockedCategories && req.blockedCategories.includes(c.category)) && // publisher brand-safety blocklist
    !(req.childDirected && !c.childSafe) &&                                 // child-directed apps only get child-safe ads
    !(req.ownerId && c.owner === req.ownerId);                              // no self-dealing: a publisher never serves its own ads
}

// Smoothed CTR: blends the prior with observed data (Bayesian, 100 pseudo-imps).
export function predictCtr(c) {
  const k = 100;
  return ((c.clicks || 0) + PRIOR_CTR * k) / ((c.impressions || 0) + k);
}

// Smoothed click->conversion rate (prior 5% over 50 pseudo-clicks) so brand-new CPA campaigns neither dominate nor starve.
export const PRIOR_CVR = 0.05;
export const predictCvr = (c) => ((c.conversions || 0) + PRIOR_CVR * 50) / ((c.clicks || 0) + 50);
export const ecpm = (c) => (c.model === 'CPC' ? c.bid * predictCtr(c) * 1000 : c.model === 'CPA' ? c.bid * predictCtr(c) * predictCvr(c) * 1000 : c.bid);

// Pacing: probabilistic throttle so daily budget lasts the day.
export function paceOk(c, now, rand = Math.random) {
  if (!c.dailyBudget) return true;
  const d = new Date(now), frac = (d.getUTCHours() * 3600 + d.getUTCMinutes() * 60) / 86400;
  const allowed = c.dailyBudget * Math.max(frac, 0.05);
  return c.spentToday < allowed || rand() < 0.1;
}

// Second-price auction with publisher floor. Returns { campaign, clearingEcpm } | null.
export function runAuction(campaigns, req, now = Date.now(), rand = Math.random) {
  const floor = req.floorEcpm || 0;
  const ranked = campaigns
    .filter((c) => eligible(c, req, now) && paceOk(c, now, rand))
    .map((c) => ({ c, e: ecpm(c) }))
    .filter((x) => x.e >= floor)
    .sort((a, b) => b.e - a.e);
  if (!ranked.length) return null;
  const [w, r] = ranked;
  const clearing = Math.min(w.e, Math.max(r ? r.e + 0.01 : floor, floor, 0.01));
  // Round to 4 dp but never charge above the winner's own eCPM bid.
  return { campaign: w.c, clearingEcpm: Math.min(+clearing.toFixed(4), w.e), winEcpm: w.e, runnerUpEcpm: r ? r.e : null };
}
