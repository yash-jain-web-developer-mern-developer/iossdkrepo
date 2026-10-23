// Invalid-traffic (IVT) detection. Pure rules so they are unit-testable; the ad server supplies the signals.
// This is a first line of defense (rules + anomaly scan), NOT an MRC-accredited IVT solution.

export const FRAUD = {
  minClickDelayMs: 400,        // a human cannot see an ad and tap it faster than this
  maxClickAgeMs: 30 * 60_000,  // the token is for this ad view; very old clicks are replays
  maxIpClicksPerMinute: 5,     // per IP per campaign
  scanMinImpressions: 500,     // do not judge apps on tiny samples
  scanMaxCtr: 0.25,            // sustained CTR above 25% is not organic for banners
  scanMaxInvalidShare: 0.5,    // more than half of an app's click attempts invalid
};

// Decide whether a click should be billed. Returns { valid: true } or { valid: false, reason }.
export function judgeClick({ issuedAt, now, impressionSeen, selfDealing, ipClicksThisMinute }, rules = FRAUD) {
  if (selfDealing) return { valid: false, reason: 'self_click' };               // publisher clicking their own advertiser account's ads
  if (!impressionSeen) return { valid: false, reason: 'no_impression' };         // click without a rendered impression
  const age = now - issuedAt;
  if (age < rules.minClickDelayMs) return { valid: false, reason: 'too_fast' };
  if (age > rules.maxClickAgeMs) return { valid: false, reason: 'stale' };
  if (ipClicksThisMinute > rules.maxIpClicksPerMinute) return { valid: false, reason: 'ip_rate' };
  return { valid: true };
}

// App-level anomaly verdict from lifetime traffic counts.
export function judgeApp({ impressions, clicks, invalidClicks }, rules = FRAUD) {
  if (impressions < rules.scanMinImpressions) return { flag: false };
  const ctr = clicks / impressions;
  if (ctr > rules.scanMaxCtr) return { flag: true, reason: `CTR ${(ctr * 100).toFixed(1)}% exceeds ${(rules.scanMaxCtr * 100).toFixed(0)}%` };
  const attempts = clicks + invalidClicks;
  if (attempts >= 20 && invalidClicks / attempts > rules.scanMaxInvalidShare) {
    return { flag: true, reason: `${((invalidClicks / attempts) * 100).toFixed(0)}% of click attempts were invalid` };
  }
  return { flag: false };
}

// Scan all apps; flag newly suspicious ones (never auto-clears: a human reviews and clears via the admin API).
export async function scanApps(repo, { audit, rules = FRAUD } = {}) {
  const flagged = [];
  for (const app of await repo.allApps()) {
    if (app.flagged) continue;
    const v = judgeApp(await repo.appTraffic(app.id), rules);
    if (v.flag) {
      await repo.setAppFlag(app.id, true, v.reason);
      await audit?.({ actor: 'system', action: 'app_flagged', target: app.id, detail: { reason: v.reason } });
      flagged.push({ id: app.id, reason: v.reason });
    }
  }
  return flagged;
}
