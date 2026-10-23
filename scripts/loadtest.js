// Load test: node scripts/loadtest.js [baseUrl] [concurrency] [seconds]
// Creates an advertiser, publisher, campaign and app, then hammers /v1/ad + impression tracking.
const base = process.argv[2] || 'http://localhost:8080';
const conc = +process.argv[3] || 50, secs = +process.argv[4] || 10;
const call = async (p, method = 'GET', body, token) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: 'Bearer ' + token }) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: r.status === 200 || r.status === 201 ? await r.json().catch(() => null) : null };
};
const rnd = Math.random().toString(36).slice(2, 8);
const pw = 'load-' + rnd + '-Test9';
const adv = (await call('/api/signup', 'POST', { email: `adv${rnd}@load.test`, password: pw, role: 'advertiser' })).body.token;
const pub = (await call('/api/signup', 'POST', { email: `pub${rnd}@load.test`, password: pw, role: 'publisher' })).body.token;
const camp = await call('/api/campaigns', 'POST', { name: 'load', bid: 50000 + ((Date.now() / 1000) % 40000), budget: 1e7, clickUrl: 'https://example.com' }, adv);
if (camp.status !== 201) { console.error('campaign creation failed: HTTP ' + camp.status); process.exit(2); }
const app = (await call('/api/apps', 'POST', { name: 'load-app', floorEcpm: 1 }, pub)).body;

const lat = []; let ok = 0, fail = 0, impressions = 0; const failStatus = {}; const note = (k) => { failStatus[k] = (failStatus[k] || 0) + 1; }; const end = Date.now() + secs * 1000;
async function worker() {
  while (Date.now() < end) {
    const t = performance.now();
    try {
      const r = await call('/v1/ad', 'POST', { appId: app.id, format: 'banner', country: 'US' });
      lat.push(performance.now() - t);
      if (r.status !== 200) { fail++; note('ad:' + r.status); continue; }
      ok++;
      const i = await fetch(r.body.impressionUrl); await i.arrayBuffer();
      if (i.status === 200) impressions++; else { fail++; note('imp:' + i.status); }
    } catch (e) { // a network error is a measured failure, not a crash
      fail++; note('net:' + (e.cause?.code || e.name));
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}
await Promise.all(Array.from({ length: conc }, worker));
lat.sort((a, b) => a - b);
const q = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))].toFixed(1);
console.log(JSON.stringify({ seconds: secs, concurrency: conc, adRequests: lat.length, filled: ok, impressions, failures: fail,
  failStatus, adReqPerSec: Math.round(lat.length / secs), p50ms: +q(0.5), p95ms: +q(0.95), p99ms: +q(0.99) }));
// With Kafka the ledger is eventually consistent: wait until it has caught up (or stops growing for 30 s).
let rep, last = -1, still = 0;
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  try { rep = (await call('/api/report', 'GET', null, adv)).body || rep; } catch { continue; }
  const n = rep?.total?.impressions ?? 0;
  if (n >= impressions) break;
  still = n === last ? still + 1 : 0; last = n;
  if (still >= 15) break;
}
console.log('ledger impressions:', rep?.total.impressions, '(confirmed by client', impressions + ')', rep?.total.impressions === impressions ? 'MATCH' : rep?.total.impressions > impressions ? 'ledger has extra (ambiguous network errors)' : 'LOSS/LAG');
const netFail = Object.entries(failStatus).filter(([k]) => k.startsWith('net:')).reduce((s, [, v]) => s + v, 0);
console.log('ledger >= confirmed:', rep?.total.impressions >= impressions, '| network errors (ambiguous, may or may not be counted):', netFail);
process.exit(rep?.total.impressions >= impressions && fail === 0 ? 0 : 1);
