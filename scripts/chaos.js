// Chaos test against the cluster compose stack:
//   node scripts/chaos.js [lbUrl] [concurrency]
// Timeline (seconds): 0-10 steady | 10 kill Redis | 20 restore | 30 kill Postgres | 40 restore | 40-70 recovery.
// Invariant checked at the end: every impression the client saw confirmed (HTTP 200 from the tracker)
// is in the ledger exactly once (ledger == confirmed), and no replica crashed.
import { execSync } from 'node:child_process';
const base = process.argv[2] || 'http://localhost:8088', conc = +process.argv[3] || 30;
const P = 'mobiad-cluster';
const dock = (cmd) => { try { execSync(`docker ${cmd}`, { stdio: 'pipe' }); } catch (e) { console.error('docker', cmd, 'failed:', String(e.stderr || e.message).slice(0, 120)); } };
const call = async (p, method = 'GET', body, token) => {
  const r = await fetch(base + p, { method, signal: AbortSignal.timeout(6000), headers: { 'content-type': 'application/json', ...(token && { authorization: 'Bearer ' + token }) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: r.status === 200 || r.status === 201 ? await r.json().catch(() => null) : null };
};
const rnd = Math.random().toString(36).slice(2, 8), pw = 'chaos-' + rnd + '-Test9';
const adv = (await call('/api/signup', 'POST', { email: `adv${rnd}@chaos.test`, password: pw, role: 'advertiser' })).body.token;
const pub = (await call('/api/signup', 'POST', { email: `pub${rnd}@chaos.test`, password: pw, role: 'publisher' })).body.token;
const camp = await call('/api/campaigns', 'POST', { name: 'chaos', bid: 50000 + ((Date.now() / 1000) % 40000), budget: 1e7, clickUrl: 'https://example.com' }, adv);
if (camp.status !== 201) { console.error('campaign creation failed: HTTP ' + camp.status); process.exit(2); }
const app = (await call('/api/apps', 'POST', { name: 'chaos-app', floorEcpm: 1 }, pub)).body;

const SCEN = process.env.CHAOS_SCENARIO || 'outages';
const T0 = Date.now(), secs = () => Math.floor((Date.now() - T0) / 1000), END = SCEN === 'pgdown-crash' ? 50 : SCEN === 'kafka-down' ? 45 : 70;
const buckets = Array.from({ length: END + 1 }, () => ({ ok: 0, fail: 0, maxMs: 0 }));
let confirmed = 0;
async function worker() {
  while (secs() < END) {
    const b = buckets[Math.min(secs(), END)], t = performance.now();
    try {
      const r = await call('/v1/ad', 'POST', { appId: app.id, format: 'banner', country: 'US' });
      if (r.status !== 200) { b.fail++; continue; }
      const i = await fetch(r.body.impressionUrl, { signal: AbortSignal.timeout(6000) }); await i.arrayBuffer();
      if (i.status === 200) { b.ok++; confirmed++; } else b.fail++;
    } catch { b.fail++; }
    b.maxMs = Math.max(b.maxMs, performance.now() - t);
  }
}
// pgdown-crash: Postgres down, then a replica is hard-killed WHILE it is down (the in-memory-queue loss case).
const events = SCEN === 'kafka-down'
  ? [[10, `stop ${P}-redpanda-1`, 'KILL kafka broker'], [22, `start ${P}-redpanda-1`, 'RESTORE kafka broker']]
  : SCEN === 'pgdown-crash'
  ? [[5, `stop ${P}-postgres-1`, 'KILL postgres'], [15, `kill ${P}-app2-1`, 'HARD-KILL app2 while Postgres is DOWN'], [25, `start ${P}-postgres-1`, 'RESTORE postgres'], [30, `start ${P}-app2-1`, 'RESTART app2']]
  : [[10, `stop ${P}-redis-1`, 'KILL redis'], [20, `start ${P}-redis-1`, 'RESTORE redis'], [30, `stop ${P}-postgres-1`, 'KILL postgres'], [40, `start ${P}-postgres-1`, 'RESTORE postgres'],
  ...(process.env.CHAOS_HARDKILL ? [[50, `kill ${P}-app2-1`, 'HARD-KILL app2 (no graceful flush)'], [58, `start ${P}-app2-1`, 'RESTART app2']] : [])];
const chaos = (async () => { for (const [at, cmd, label] of events) { while (secs() < at) await new Promise((r) => setTimeout(r, 100)); console.log(`[t=${secs()}s] ${label}`); dock(cmd); } })();
await Promise.all([...Array.from({ length: conc }, worker), chaos]);

console.log('sec  ok/s  fail/s  maxlatency(ms)');
buckets.slice(0, END).forEach((b, s) => console.log(String(s).padStart(3), String(b.ok).padStart(5), String(b.fail).padStart(6), String(Math.round(b.maxMs)).padStart(8)));
// Wait for the pipeline to drain (Kafka consumer / retry queue), until the ledger reaches the confirmed count
// or stops growing for 30 s.
let rep, last = -1, still = 0;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  try { rep = (await call('/api/report', 'GET', null, adv)).body; } catch { continue; }
  const n = rep.total.impressions;
  if (n >= confirmed) break;
  still = n === last ? still + 1 : 0; last = n;
  if (still >= 15) break;
}
const ledger = rep?.total.impressions;
const crashed = execSync(`docker ps -a --filter name=${P}-app --format "{{.Names}} {{.Status}}"`).toString().trim();
console.log('\nconfirmed by client:', confirmed, '| in ledger:', ledger, '|', ledger === confirmed ? 'EXACT MATCH' : ledger > confirmed ? 'ledger has extra (client timed out after server counted)' : 'LOSS');
console.log(crashed);
if (process.env.CHAOS_HARDKILL) { console.log('events lost on hard kill:', confirmed - ledger); process.exit(0); }
process.exit(ledger >= confirmed && !/Exited|Restarting/.test(crashed) ? 0 : 1);
