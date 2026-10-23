// End-to-end journey against a PRODUCTION-MODE deployment (email verification, manual review, admin MFA, funded wallet).
//   BASE=http://mobiad.mobiad.svc MAILPIT_API=http://mailpit:8025 ADMIN_EMAIL=... ADMIN_PASSWORD=... \
//   [MODE=load SECS=90 CONC=20] [REWRITE_TRACKING=1] node scripts/prod-e2e.mjs
// The admin account must already exist (node scripts/create-admin.js). MODE=journey (default) runs the whole business flow once;
// MODE=load then sends sustained traffic and reports failures per second (used to verify zero-downtime rollouts).
import { totpAt } from '../src/auth/totp.js';

const E = process.env, BASE = (E.BASE || 'http://localhost:8080').replace(/\/$/, '');
const need = (k) => { if (!E[k]) { console.error(`${k} is required`); process.exit(2); } return E[k]; };
const MAILPIT = need('MAILPIT_API'), ADMIN_EMAIL = need('ADMIN_EMAIL'), ADMIN_PASSWORD = need('ADMIN_PASSWORD');
// Pricing knobs: the journey uses a high floor ($5/impression) so billing math is easy to eyeball; load runs use a tiny
// floor and a big budget so sustained traffic does not exhaust the campaign.
const FLOOR = +E.FLOOR || 5000, BUDGET = +E.BUDGET || 200, CREDIT = +E.CREDIT || 500, PRICE = FLOOR / 1000;
const rnd = Math.random().toString(36).slice(2, 8), PW = 'E2e-Journey-Passphrase-' + rnd;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const ok = (m) => console.log('  ✓ ' + m);
const check = (cond, m) => { if (cond) ok(m); else { failed = true; console.log('  ✗ ' + m); } return cond; };

const call = async (path, method = 'GET', body, token) => {
  const r = await fetch(BASE + path, { method, redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { 'content-type': 'application/json', ...(token && { authorization: 'Bearer ' + token }) }, body: body && JSON.stringify(body) });
  const text = r.status === 204 ? '' : await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: r.status, body: json, headers: r.headers };
};
async function mailTo(addr, subject) {
  for (let i = 0; i < 60; i++) {
    const s = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent('to:' + addr + ' subject:"' + subject + '"')}`)).json();
    if (s.messages?.length) return (await (await fetch(`${MAILPIT}/api/v1/message/${s.messages[0].ID}`)).json()).Text;
    await sleep(500);
  }
  throw new Error(`no "${subject}" email for ${addr}`);
}
const fragment = (text, kind) => text.match(new RegExp(`#${kind}=([A-Za-z0-9_-]+)`))?.[1];
const track = (u) => (E.REWRITE_TRACKING ? BASE + new URL(u).pathname : u);

async function signupVerified(email, role) {
  const s = await call('/api/signup', 'POST', { email, password: PW, role, acceptTerms: true });
  if (s.status !== 201) throw new Error('signup failed: ' + JSON.stringify(s.body));
  const tok = fragment(await mailTo(email, 'Verify your MobiAd email'), 'verify');
  const v = await call('/api/verify-email', 'POST', { token: tok });
  if (v.status !== 200) throw new Error('verify failed');
  return (await call('/api/login', 'POST', { email, password: PW })).body.token;
}

async function waitReady() { // right after a rollout, Service endpoints may take a moment to propagate
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/readyz', { signal: AbortSignal.timeout(2000) })).status === 200) return; } catch { /* not yet */ } await sleep(1000); }
  throw new Error('service never became ready');
}

async function setup() {
  console.log(`== production journey against ${BASE}`);
  await waitReady();
  // 1. admin with MFA (production refuses admin APIs without it)
  const login = await call('/api/login', 'POST', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  check(login.status === 200, 'admin logs in');
  const denied = await call('/api/admin/overview', 'GET', null, login.body.token);
  check(denied.status === 403 && denied.body.error === 'mfa_required', 'admin APIs are refused until MFA is enabled');
  const setupMfa = await call('/api/mfa/setup', 'POST', { password: ADMIN_PASSWORD }, login.body.token);
  const enabled = await call('/api/mfa/enable', 'POST', { code: totpAt(setupMfa.body.secret, Date.now()) }, login.body.token);
  check(enabled.status === 200 && enabled.body.recoveryCodes?.length === 8, 'admin enables MFA with a real TOTP code');
  const admin = enabled.body.token;
  check((await call('/api/admin/overview', 'GET', null, admin)).status === 200, 'admin APIs now allowed');

  // Repeatability in shared test environments: suspend campaigns left over from earlier runs so they cannot win auctions.
  if (E.E2E_RESET) {
    const old = (await call('/api/admin/campaigns?status=approved', 'GET', null, admin)).body;
    for (const c of old) await call('/api/admin/campaigns/review', 'POST', { id: c.id, decision: 'reject', note: 'e2e cleanup of a previous run' }, admin);
    ok(`test environment reset (${old.length} old campaign(s) suspended)`);
  }

  // 2. advertiser: verified by real email, cannot create a campaign without funds, then funded by admin, then reviewed
  const advEmail = `adv-${rnd}@e2e.test`, pubEmail = `pub-${rnd}@e2e.test`;
  const advSignup = await call('/api/signup', 'POST', { email: advEmail, password: PW, role: 'advertiser', acceptTerms: true });
  check(advSignup.status === 201 && advSignup.body.emailVerified === false, 'advertiser signs up (unverified)');
  const gated = await call('/api/campaigns', 'POST', { name: 'x', bid: 1, budget: 5, clickUrl: 'https://example.com' }, advSignup.body.token);
  check(gated.status === 403 && gated.body.error === 'email_not_verified', 'unverified advertiser is blocked from creating campaigns');
  const advTok0 = fragment(await mailTo(advEmail, 'Verify your MobiAd email'), 'verify');
  check((await call('/api/verify-email', 'POST', { token: advTok0 })).status === 200, 'verification email delivered and link works');
  const adv = (await call('/api/login', 'POST', { email: advEmail, password: PW })).body.token;
  const body = { name: 'E2E Campaign', model: 'CPM', bid: 6000, budget: BUDGET, clickUrl: 'https://example.com/e2e', category: 'general' };
  const broke = await call('/api/campaigns', 'POST', body, adv);
  check(broke.status === 402, 'campaign refused without wallet funds (402)');
  const advUser = (await call('/api/admin/users', 'GET', null, admin)).body.find((u) => u.email === advEmail);
  check((await call('/api/admin/wallet/credit', 'POST', { userId: advUser.id, amountUsd: CREDIT, note: 'e2e funding', reference: 'e2e-' + rnd }, admin)).body.applied === true, `admin credits the wallet (${CREDIT} USD)`);
  const camp = await call('/api/campaigns', 'POST', body, adv);
  check(camp.status === 201 && camp.body.reviewStatus === 'pending', 'campaign created and held for manual review');

  // 3. publisher, app, no fill while pending, approval -> serving
  const pub = await signupVerified(pubEmail, 'publisher');
  const app = (await call('/api/apps', 'POST', { name: 'E2E App', floorEcpm: FLOOR }, pub)).body;
  check(!!app?.id, 'publisher registers an app');
  check((await call('/v1/ad', 'POST', { appId: app.id })).status === 204, 'no ad is served while the campaign awaits review');
  check((await call('/api/admin/campaigns/review', 'POST', { id: camp.body.id, decision: 'approve', note: 'e2e' }, admin)).status === 200, 'admin approves the campaign');
  let served = 0; for (let i = 0; i < 20 && !served; i++) { served = (await call('/v1/ad', 'POST', { appId: app.id })).status === 200 ? 1 : 0; if (!served) await sleep(500); }
  check(served === 1, 'ads are served after approval (propagated to every replica)');
  return { admin, adv, pub, app, camp: camp.body, advEmail, pubEmail };
}

async function journey(ctx) {
  const { admin, adv, pub, app } = ctx;
  // billing + fraud + reporting
  const N = 10; let imps = 0;
  for (let i = 0; i < N; i++) { const a = await call('/v1/ad', 'POST', { appId: app.id }); if (a.status === 200) { await fetch(track(a.body.impressionUrl)); imps++; } }
  const ghost = await call('/v1/ad', 'POST', { appId: app.id }); await fetch(track(ghost.body.clickUrl), { redirect: 'manual' }); // click with no impression: invalid whatever the timing (deterministic)
  
  let rep; for (let i = 0; i < 60; i++) { rep = (await call('/api/report', 'GET', null, adv)).body.total; if (rep.impressions >= imps && rep.invalidClicks >= 1) break; await sleep(500); }
  check(rep.impressions === imps, `${imps} impressions reached the ledger through Kafka`);
  check(rep.invalidClicks === 1 && rep.clicks === 0, 'a click without an impression was recorded as invalid and not billed');
  check(Math.abs(rep.spend - imps * PRICE) < 1e-6, `spend is exactly ${(imps * PRICE).toFixed(3)} USD (second-price floor)`);
  const w = (await call('/api/billing/summary', 'GET', null, adv)).body;
  check(w.credits === CREDIT && Math.abs(w.spent - imps * PRICE) < 1e-6 && Math.abs(w.available - (CREDIT - BUDGET)) < 1e-6, `wallet: credits ${CREDIT}, spent, ${BUDGET} reserved, ${CREDIT - BUDGET} available`);
  const ps = (await call('/api/billing/summary', 'GET', null, pub)).body;
  check(Math.abs(ps.earned - imps * PRICE * 0.7) < 1e-6, 'publisher earns 70% of spend');
  const payouts = PRICE >= 1; // low-price load runs do not earn enough to request a payout
  if (payouts) {
    const pay = await call('/api/billing/payout', 'POST', { amountUsd: 20 }, pub); // needs MIN_PAYOUT_USD <= 20 in the target environment
    check(pay.status === 201, 'publisher requests a payout');
    check((await call('/api/admin/payouts/resolve', 'POST', { id: pay.body.id, status: 'paid', note: 'e2e' }, admin)).status === 200, 'admin marks it paid');
  }
  const audit = (await call('/api/admin/audit?limit=300', 'GET', null, admin)).body.map((a) => a.action);
  for (const a of ['signup', 'email_verified', 'mfa_enabled', 'wallet_credit', 'campaign_reviewed', ...(payouts ? ['payout_requested', 'payout_resolved'] : [])]) check(audit.includes(a), `audit trail contains ${a}`);
  const metrics = await fetch(BASE + '/metrics', { headers: { authorization: 'Bearer ' + (E.METRICS_TOKEN || '') } });
  check(!E.METRICS_TOKEN || metrics.status === 200, 'metrics endpoint serves with the token');
  check((await fetch(BASE + '/metrics')).status === 401, '/metrics is closed without the token');
}

async function load(ctx) {
  const secs = +E.SECS || 60, conc = +E.CONC || 20, end = Date.now() + secs * 1000, t0 = Date.now();
  const sec = () => Math.floor((Date.now() - t0) / 1000), timeline = Array.from({ length: secs + 2 }, () => ({ ok: 0, fail: 0 }));
  let confirmed = 0; const fails = {};
  const worker = async () => {
    while (Date.now() < end) {
      const b = timeline[sec()];
      try {
        const a = await call('/v1/ad', 'POST', { appId: ctx.app.id });
        if (a.status !== 200) { b.fail++; const k = 'ad:' + a.status; fails[k] = (fails[k] || 0) + 1; continue; }
        const i = await fetch(track(a.body.impressionUrl), { signal: AbortSignal.timeout(8000) }); await i.arrayBuffer();
        if (i.status === 200) { b.ok++; confirmed++; } else { b.fail++; const k = 'imp:' + i.status; fails[k] = (fails[k] || 0) + 1; }
      } catch (e) { b.fail++; const k = 'net:' + (e.cause?.code || e.name); fails[k] = (fails[k] || 0) + 1; }
    }
  };
  // Exact accounting: impressions already in the ledger BEFORE the load phase (from the journey) must be subtracted.
  await sleep(2000);
  const baseline = (await call('/api/report', 'GET', null, ctx.adv)).body.total.impressions;
  console.log(`== load: ${conc} clients for ${secs}s (ledger baseline ${baseline})`);
  await Promise.all(Array.from({ length: conc }, worker));
  const failSecs = timeline.map((b, s) => [s, b]).filter(([, b]) => b.fail > 0);
  console.log(`  requests ok=${confirmed} failed=${Object.values(fails).reduce((a, b) => a + b, 0)} ${JSON.stringify(fails)}`);
  if (failSecs.length) console.log('  seconds with failures: ' + failSecs.map(([s, b]) => `${s}s(${b.fail})`).join(' '));
  let n = 0, last = -1, still = 0;
  for (let i = 0; i < 90; i++) { // drain: wait for the Kafka consumer to finish writing
    n = (await call('/api/report', 'GET', null, ctx.adv)).body.total.impressions - baseline;
    if (n >= confirmed) break;
    still = n === last ? still + 1 : 0; last = n; if (still > 20) break; await sleep(1000);
  }
  console.log(`  ledger impressions since baseline=${n} client-confirmed=${confirmed} (difference ${n - confirmed}) -> ${n === confirmed ? 'EXACT MATCH' : n > confirmed ? 'ledger has extra (client timed out after server counted)' : 'LOSS'}`);
  check(n >= confirmed, 'no confirmed impression is missing from the ledger');
  return { failures: Object.values(fails).reduce((a, b) => a + b, 0) };
}

const ctx = await setup();
if ((E.MODE || 'journey') === 'journey') await journey(ctx);
else { await journey(ctx); const r = await load(ctx); if (E.MAX_FAILURES != null && r.failures > +E.MAX_FAILURES) { failed = true; console.log(`  ✗ ${r.failures} failed requests exceeds the allowed ${E.MAX_FAILURES}`); } }
console.log(failed ? 'FAILED' : 'ALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
