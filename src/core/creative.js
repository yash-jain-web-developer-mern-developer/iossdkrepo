// Creative sets: a campaign may carry several creatives. We rotate with Thompson sampling on CTR so better creatives win more
// traffic while new ones still get a chance. Stats are per-replica, in memory (they only steer rotation; billing never depends on them).

// Marsaglia-Tsang gamma sampler (shape >= 1 after the boost trick), good enough for Beta sampling.
function gamma(k, rand) {
  if (k < 1) return gamma(k + 1, rand) * Math.pow(rand(), 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { const u1 = rand() || 1e-12, u2 = rand(); x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); v = 1 + c * x; } while (v <= 0);
    v = v * v * v; const u = rand() || 1e-12;
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}
export function beta(a, b, rand = Math.random) { const x = gamma(a, rand), y = gamma(b, rand); return x / (x + y); }

export const creativesOf = (c) => (c.creatives?.length ? c.creatives : [{ id: 'cr_0', ...c.creative }]);

// stats: Map<`${campaignId}:${creativeId}`, { i, c }>. Returns the creative to serve.
export function pickCreative(c, stats, rand = Math.random) {
  const all = creativesOf(c);
  if (all.length === 1) return all[0];
  let best = all[0], bestScore = -1;
  for (const cr of all) {
    const s = stats.get(`${c.id}:${cr.id}`) || { i: 0, c: 0 };
    const score = beta(1 + s.c, 1 + Math.max(0, s.i - s.c), rand);
    if (score > bestScore) { best = cr; bestScore = score; }
  }
  return best;
}
export function noteCreative(stats, campaignId, creativeId, kind) {
  const k = `${campaignId}:${creativeId}`, s = stats.get(k) || { i: 0, c: 0 };
  if (kind === 'impression') s.i++; else if (kind === 'click') s.c++;
  stats.set(k, s);
}
