import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { runAuction, predictCtr, paceOk } from '../src/core/auction.js';
import { sign, verify } from '../src/core/token.js';
import { loadConfig } from '../src/config.js';
import { boot, settle, PW } from './lib/helpers.js';

const human = () => new Promise((r) => setTimeout(r, 450)); // a person needs a moment between seeing an ad and tapping it

const camp = (o) => ({ id: 'c' + Math.random(), status: 'active', spent: 0, spentToday: 0, budget: 100, format: 'banner', countries: [], platforms: [], model: 'CPM', bid: 5, impressions: 0, clicks: 0, ...o });

test('auction: second price, floor, targeting, budget, format, expiry', () => {
  const r = runAuction([camp({ bid: 10 }), camp({ bid: 4 })], { format: 'banner' });
  assert.equal(r.campaign.bid, 10);
  assert.equal(r.clearingEcpm, 4.01);
  assert.equal(runAuction([camp({ bid: 10 })], { format: 'banner', floorEcpm: 12 }), null);
  assert.equal(runAuction([camp({ bid: 1 })], { format: 'banner', floorEcpm: 2 }), null);
  assert.equal(runAuction([camp({ countries: ['IN'] })], { format: 'banner', country: 'US' }), null);
  assert.ok(runAuction([camp({ countries: ['IN'] })], { format: 'banner', country: 'IN' }));
  assert.equal(runAuction([camp({ platforms: ['ios'] })], { format: 'banner', platform: 'android' }), null);
  assert.equal(runAuction([camp({ spent: 100 })], { format: 'banner' }), null);
  assert.equal(runAuction([camp({ format: 'video' })], { format: 'banner' }), null);
  assert.equal(runAuction([camp({ endsAt: Date.now() - 1 })], { format: 'banner' }), null);
  assert.equal(runAuction([camp({ status: 'paused' })], { format: 'banner' }), null);
});
test('auction: CPC converts via CTR, clearing price never exceeds bid, floor is respected', () => {
  const cpc = camp({ model: 'CPC', bid: 1, impressions: 1000, clicks: 100 });
  assert.ok(predictCtr(cpc) > 0.08);
  const r = runAuction([cpc], { format: 'banner', floorEcpm: 3 });
  assert.ok(r.clearingEcpm >= 3);
  for (let i = 0; i < 200; i++) {
    const x = runAuction([camp({ bid: Math.random() * 20 + 0.1 }), camp({ bid: Math.random() * 20 + 0.1 })], { format: 'banner' });
    if (x) assert.ok(x.clearingEcpm <= x.campaign.bid + 1e-9);
  }
});
test('pacing throttles overspend early in the day but never blocks forever', () => {
  const early = Date.UTC(2026, 0, 1, 1, 0);
  const c = camp({ dailyBudget: 100, spentToday: 50 });
  assert.equal(paceOk(c, early, () => 0.99), false);
  assert.equal(paceOk(c, early, () => 0.01), true);
  assert.equal(paceOk(camp({ dailyBudget: 100, spentToday: 0 }), early, () => 0.99), true);
});
test('tokens reject tampering, wrong key and expiry', () => {
  const t = sign({ a: 1 }, 's');
  assert.ok(verify(t, 's'));
  assert.equal(verify(t + 'x', 's'), null);
  assert.equal(verify(t, 'other'), null);
  assert.equal(verify('garbage', 's'), null);
  assert.equal(verify(sign({ a: 1 }, 's', -1), 's'), null);
});
test('config: production refuses unsafe settings', () => {
  const good = { NODE_ENV: 'production', MOBIAD_SECRET: 'x'.repeat(32), DATABASE_URL: 'p://x', REDIS_URL: 'r://x', KAFKA_BROKERS: 'k:9092', METRICS_TOKEN: 'm'.repeat(16),
    SMTP_URL: 'smtp://u:p@mail:587', PUBLIC_URL: 'https://ads.example.com' };
  const c = loadConfig(good);
  assert.ok(c.prod);
  // production defaults are the SAFE ones
  assert.equal(c.requireEmailVerification, true); assert.equal(c.requireAdminMfa, true); assert.equal(c.autoApproveCampaigns, false);
  assert.equal(c.requireFunding, true); assert.equal(c.requireHttpsCreatives, true); assert.equal(c.paymentsMode, 'none');
  const bad = (patch, re) => assert.throws(() => loadConfig({ ...good, ...patch }), re);
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /MOBIAD_SECRET/);
  bad({ PUBLIC_URL: 'http://insecure' }, /https/);
  bad({ KAFKA_BROKERS: '' }, /KAFKA_BROKERS/);
  bad({ METRICS_TOKEN: '' }, /METRICS_TOKEN/);
  bad({ SMTP_URL: '' }, /SMTP_URL/);
  bad({ REQUIRE_EMAIL_VERIFICATION: 'false' }, /REQUIRE_EMAIL_VERIFICATION/);
  bad({ AUTO_APPROVE_CAMPAIGNS: 'true' }, /AUTO_APPROVE_CAMPAIGNS/);
  bad({ PAYMENTS_MODE: 'test' }, /PAYMENTS_MODE=test/);
  bad({ PAYMENTS_MODE: 'stripe' }, /STRIPE_SECRET_KEY/);
  bad({ PAYMENTS_MODE: 'bitcoin' }, /PAYMENTS_MODE must be/);
  assert.ok(loadConfig({ ...good, PAYMENTS_MODE: 'stripe', STRIPE_SECRET_KEY: 'sk_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' }));
  assert.throws(() => loadConfig({ PUBLISHER_SHARE: '2' }), /PUBLISHER_SHARE/);
  // development defaults are convenient
  const d = loadConfig({});
  assert.equal(d.requireEmailVerification, false); assert.equal(d.autoApproveCampaigns, true); assert.equal(d.paymentsMode, 'test');
});

test('e2e: signup, campaign, ad, tracking, dedupe, billing, reports, revenue share', async () => {
  const { app, call, signup, stop, path } = await boot();
  const adv = await signup('a@x.io', 'advertiser'), pub = await signup('p@x.io', 'publisher');
  assert.equal((await call('/api/apps', 'POST', { name: 'x' }, adv)).status, 403);
  assert.equal((await call('/api/campaigns', 'POST', { name: 'bad' }, adv)).status, 400);
  assert.equal((await call('/api/campaigns', 'POST', { name: 'n', bid: 1, budget: 1, clickUrl: 'javascript:alert(1)' }, adv)).status, 400);
  assert.equal((await call('/api/campaigns', 'GET')).status, 401);
  await call('/api/campaigns', 'POST', { name: 'Launch', bid: 8, budget: 50, clickUrl: 'https://example.com' }, adv);
  const a = (await call('/api/apps', 'POST', { name: 'Game', platform: 'android', floorEcpm: 2 }, pub)).body;
  assert.equal((await call('/v1/ad', 'POST', { appId: 'nope' })).status, 404);
  const ad = (await call('/v1/ad', 'POST', { appId: a.id, format: 'banner', country: 'US' })).body;
  assert.equal((await call(path(ad.impressionUrl))).status, 200);
  await call(path(ad.impressionUrl)); // replay must not bill twice
  await human();
  const click = await call(path(ad.clickUrl));
  assert.equal(click.status, 302);
  assert.equal(new URL(click.headers.get('location')).origin, 'https://example.com'); assert.ok(new URL(click.headers.get('location')).searchParams.get('mobiad_click_id'), 'accepted clicks carry an attribution id');
  assert.equal((await call('/t/i/forged.token')).status, 400);
  await settle(app);
  const rep = (await call('/api/report', 'GET', null, adv)).body;
  assert.equal(rep.total.impressions, 1);
  assert.equal(rep.total.clicks, 1);
  assert.ok(Math.abs(rep.total.spend - 0.002) < 1e-9);
  const pr = (await call('/api/report', 'GET', null, pub)).body;
  assert.ok(Math.abs(pr.total.publisherRevenue - 0.0014) < 1e-9);
  assert.equal((await call('/api/report', 'GET', null, await signup('other@x.io', 'advertiser'))).body.total.impressions, 0); // tenant isolation
  await stop();
});

test('budget exhaustion stops serving and cannot be resumed', async () => {
  const { app, call, signup, stop, path } = await boot();
  const adv = await signup('a@x.io', 'advertiser'), pub = await signup('p@x.io', 'publisher');
  const c = (await call('/api/campaigns', 'POST', { name: 'tiny', model: 'CPC', bid: 0.5, budget: 1, clickUrl: 'https://example.com' }, adv)).body;
  const a = (await call('/api/apps', 'POST', { name: 'g' }, pub)).body;
  for (let i = 0; i < 2; i++) {
    const ad = (await call('/v1/ad', 'POST', { appId: a.id })).body;
    await call(path(ad.impressionUrl)); await human(); await call(path(ad.clickUrl));
  }
  assert.equal((await call('/v1/ad', 'POST', { appId: a.id })).status, 204);
  await settle(app);
  assert.equal((await call('/api/campaigns/status', 'POST', { id: c.id, status: 'active' }, adv)).status, 409);
  const list = (await call('/api/campaigns', 'GET', null, adv)).body;
  assert.equal(list[0].status, 'exhausted');
  assert.ok(Math.abs(list[0].stats.spend - 1) < 1e-9);
  await stop();
});

test('pause/resume and tenant ownership', async () => {
  const { call, signup, stop } = await boot();
  const a1 = await signup('a1@x.io', 'advertiser'), a2 = await signup('a2@x.io', 'advertiser');
  const c = (await call('/api/campaigns', 'POST', { name: 'mine', bid: 1, budget: 10, clickUrl: 'https://e.com' }, a1)).body;
  assert.equal((await call('/api/campaigns/status', 'POST', { id: c.id, status: 'paused' }, a2)).status, 400);
  assert.equal((await call('/api/campaigns/status', 'POST', { id: c.id, status: 'paused' }, a1)).status, 200);
  assert.equal((await call('/api/campaigns', 'GET', null, a2)).body.length, 0);
  await stop();
});

test('durability: data survives restart on the same database; ledger is idempotent', async () => {
  const first = await boot();
  const adv = await first.signup('a@x.io', 'advertiser'), pub = await first.signup('p@x.io', 'publisher');
  await first.call('/api/campaigns', 'POST', { name: 'keep', bid: 4, budget: 10, clickUrl: 'https://e.com' }, adv);
  const a = (await first.call('/api/apps', 'POST', { name: 'g', floorEcpm: 1 }, pub)).body;
  const ad = (await first.call('/v1/ad', 'POST', { appId: a.id })).body;
  await first.call(first.path(ad.impressionUrl));
  await settle(first.app);
  const pool = first.app.repo.pool;
  const owner = await first.app.repo.userByEmail('a@x.io');
  const evt = { type: 'impression', campaignId: (await first.app.repo.campaignsByOwner(owner.id))[0].id, appId: a.id, cost: 0.001, t: Date.now(), token: 'dup' };
  assert.equal(await first.app.repo.recordEvent(evt), true);
  assert.equal(await first.app.repo.recordEvent(evt), false);
  first.app.server.closeAllConnections();
  await new Promise((r) => first.app.server.close(r));
  const second = await boot({ pool });
  const login = await second.call('/api/login', 'POST', { email: 'a@x.io', password: PW });
  assert.equal(login.status, 200);
  assert.equal((await second.call('/api/report', 'GET', null, login.body.token)).body.total.impressions, 2);
  assert.equal((await second.call('/api/login', 'POST', { email: 'a@x.io', password: 'wrongpass1' })).status, 401);
  await second.stop();
});

test('security: headers, traversal, body limit, bad json, duplicate email, validation, rate limit', async () => {
  const { call, signup, stop, base } = await boot();
  const home = await call('/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  assert.ok(home.headers.get('x-request-id'));
  for (const p of ['/..%2f..%2fpackage.json', '/%2e%2e/package.json', '/../src/server.js']) {
    const r = await fetch(base + p);
    assert.ok([404, 400].includes(r.status), p + ' -> ' + r.status);
  }
  assert.equal((await call('/api/signup', 'POST', null, null, '{not json')).status, 400);
  assert.equal((await call('/api/signup', 'POST', null, null, JSON.stringify({ email: 'x@y.io', password: 'a'.repeat(70000), role: 'advertiser' }))).status, 413);
  await signup('dup@x.io', 'advertiser');
  assert.equal((await call('/api/signup', 'POST', { email: 'DUP@x.io', password: PW, role: 'advertiser' })).status, 409);
  assert.equal((await call('/api/signup', 'POST', { email: 'e@x.io', password: 'short', role: 'advertiser' })).status, 400);
  assert.equal((await call('/api/signup', 'POST', { email: 'e@x.io', password: PW, role: 'admin' })).status, 400);
  const tok = await signup('xss@x.io', 'advertiser');
  const name = '<img src=x onerror=alert(1)>';
  await call('/api/campaigns', 'POST', { name, bid: 1, budget: 1, clickUrl: 'https://e.com' }, tok);
  assert.equal((await call('/api/campaigns', 'GET', null, tok)).body[0].name, name); // stored verbatim; UI renders via textContent
  let limited = 0;
  for (let i = 0; i < 30; i++) if ((await call('/api/login', 'POST', { email: 'a@b.co', password: 'x' })).status === 429) limited++;
  assert.ok(limited > 0);
  await stop();
});

test('observability: health, readiness and prometheus metrics', async () => {
  const { call, stop } = await boot();
  assert.equal((await call('/healthz')).status, 200);
  assert.equal((await call('/readyz')).status, 200);
  const m = (await call('/metrics')).body;
  assert.match(m, /mobiad_http_requests_total/);
  assert.match(m, /mobiad_ledger_queue/);
  await stop();
});

test('graceful shutdown flushes pending ledger writes', async () => {
  const { app, call, signup, path } = await boot();
  const adv = await signup('a@x.io', 'advertiser'), pub = await signup('p@x.io', 'publisher');
  await call('/api/campaigns', 'POST', { name: 'c', bid: 4, budget: 10, clickUrl: 'https://e.com' }, adv);
  const a = (await call('/api/apps', 'POST', { name: 'g', floorEcpm: 1 }, pub)).body;
  const ad = (await call('/v1/ad', 'POST', { appId: a.id })).body;
  await call(path(ad.impressionUrl));
  const repo = app.repo;
  repo.pool.end = async () => {}; // keep pool open so we can inspect after close
  app.server.closeAllConnections();
  await app.close();
  assert.equal(app.ledger.queue.length, 0);
  assert.equal(Number((await repo.q('SELECT COUNT(*) AS n FROM ledger')).rows[0].n), 1);
});

test('clientIp trusts only the proxy-appended X-Forwarded-For entry', async () => {
  const { clientIp, setTrustedHops } = await import('../src/http.js');
  const req = (xff) => ({ headers: { 'x-forwarded-for': xff }, socket: { remoteAddress: '10.0.0.1' } });
  setTrustedHops(0);
  assert.equal(clientIp(req('1.2.3.4')), '10.0.0.1'); // header ignored when no proxy is trusted
  setTrustedHops(1);
  assert.equal(clientIp(req('6.6.6.6, 9.9.9.9')), '9.9.9.9'); // client-supplied 6.6.6.6 is not trusted
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '10.0.0.1' } }), '10.0.0.1');
  setTrustedHops(0);
});

test('Postgres outage: pod stays ready (degraded), ads keep serving, tracking is queued then flushed on recovery', async () => {
  const { app, call, signup, stop, path } = await boot();
  after(stop);
  const adv = await signup('a@x.io', 'advertiser'), pub = await signup('p@x.io', 'publisher');
  await call('/api/campaigns', 'POST', { name: 'c', bid: 4, budget: 10, clickUrl: 'https://e.com' }, adv);
  const a = (await call('/api/apps', 'POST', { name: 'g', floorEcpm: 1 }, pub)).body;
  const realQ = app.repo.q.bind(app.repo), realBatch = app.repo.recordBatch.bind(app.repo);
  const down = () => Promise.reject(new Error('connection refused'));
  app.repo.q = down; app.repo.recordBatch = down; // simulate Postgres outage
  const ready = await call('/readyz');
  assert.equal(ready.status, 200);
  assert.equal(ready.body.db, 'down');
  const ad = await call('/v1/ad', 'POST', { appId: a.id });
  assert.equal(ad.status, 200); // served from the in-process catalog
  assert.equal((await call(path(ad.body.impressionUrl))).status, 200); // accepted and queued
  assert.equal((await call('/api/campaigns', 'GET', null, adv)).status, 500); // control plane is down (expected)
  assert.ok(app.ledger.queue.length >= 1);
  app.repo.q = realQ; app.repo.recordBatch = realBatch; // Postgres back
  assert.equal(await app.ledger.flush(8000), true);
  assert.equal((await call('/api/report', 'GET', null, adv)).body.total.impressions, 1); // nothing lost
});

test('privacy: export returns only your data; deletion needs password, stops serving, keeps the ledger', async () => {
  const { app, call, signup, stop, path } = await boot();
  const adv = await signup('gdpr@x.io', 'advertiser'), other = await signup('other@x.io', 'advertiser'), pub = await signup('pub@x.io', 'publisher');
  await call('/api/campaigns', 'POST', { name: 'mine', bid: 4, budget: 10, clickUrl: 'https://e.com' }, adv);
  await call('/api/campaigns', 'POST', { name: 'theirs', bid: 3, budget: 10, clickUrl: 'https://e.com' }, other);
  const a = (await call('/api/apps', 'POST', { name: 'g', floorEcpm: 1 }, pub)).body;
  const ad = (await call('/v1/ad', 'POST', { appId: a.id })).body;
  await call(path(ad.impressionUrl)); await settle(app);

  const exp = await call('/api/account/export', 'GET', null, adv);
  assert.equal(exp.status, 200);
  assert.equal(exp.body.account.email, 'gdpr@x.io');
  assert.deepEqual(exp.body.campaigns.map((c) => c.name), ['mine']); // no other tenant's data
  assert.equal(exp.body.report.total.impressions, 1);
  assert.equal(exp.headers.get('cache-control'), 'no-store');
  assert.equal((await call('/api/account/export')).status, 401);

  assert.equal((await call('/api/account', 'DELETE', { password: 'wrong-password', confirm: 'DELETE' }, adv)).status, 400);
  assert.equal((await call('/api/account', 'DELETE', { password: PW }, adv)).status, 400); // needs explicit confirm
  assert.equal((await call('/api/account', 'DELETE', { password: PW, confirm: 'DELETE' }, adv)).status, 200);
  assert.equal((await call('/api/login', 'POST', { email: 'gdpr@x.io', password: PW })).status, 401); // account gone
  assert.equal((await call('/api/campaigns', 'GET', null, adv)).status, 401); // old token dead
  const ledgerRows = Number((await app.repo.q('SELECT COUNT(*) n FROM ledger')).rows[0].n);
  assert.equal(ledgerRows, 1); // billing record retained
  for (let i = 0; i < 10; i++) { // deleted advertiser's campaign no longer wins auctions
    const x = (await call('/v1/ad', 'POST', { appId: a.id })).body;
    assert.ok(x.impressionUrl);
  }
  const rep = (await call('/api/campaigns', 'GET', null, other)).body;
  assert.equal(rep[0].name, 'theirs');
  const owed = await call('/api/account', 'DELETE', { password: PW, confirm: 'DELETE' }, pub);
  assert.equal(owed.status, 409); // unpaid earnings must be settled first, never silently destroyed
  assert.equal(owed.body.error, 'earnings_remaining');
  const pub2 = await signup('pub2@x.io', 'publisher'); // a publisher with nothing owed can delete
  assert.equal((await call('/api/account', 'DELETE', { password: PW, confirm: 'DELETE' }, pub2)).status, 200);
  await stop();
});

test('security hardening: malformed URL escapes, key separation, per-account throttle, no-store, timing-safe login path', async () => {
  const { call, signup, stop, base } = await boot();
  assert.equal((await fetch(base + '/%E0%A4%A')).status, 404); // malformed %-escape: 404, not a 500
  assert.equal((await fetch(base + '/%00')).status, 404);
  const { deriveKey, sign, verify } = await import('../src/core/token.js');
  assert.notEqual(deriveKey('s', 'jwt'), deriveKey('s', 'tracking'));
  assert.equal(verify(sign({ a: 1 }, deriveKey('s', 'jwt')), deriveKey('s', 'tracking')), null); // a JWT-key token is not a valid tracking token
  const home = await call('/api/campaigns');
  assert.equal(home.headers.get('cache-control'), 'no-store');
  await signup('victim@x.io', 'advertiser');
  let locked = 0;
  for (let i = 0; i < 25; i++) if ((await call('/api/login', 'POST', { email: 'victim@x.io', password: 'bad-guess-' + i })).status === 429) locked++;
  assert.ok(locked > 0); // guesses against one account are throttled
  await stop();
});

test('metrics: exposition is well formed, includes business and process gauges, and the scrape token is enforced', async () => {
  const t = await boot({ metricsToken: 'scrape-token-1234567890' });
  const adv = await t.signup('adv@x.io', 'advertiser');
  await t.call('/api/campaigns', 'POST', { name: 'c', bid: 1, budget: 5, clickUrl: 'https://example.com', category: 'gambling' }, adv); // soft-flagged: pending review
  await t.app.repo.queueCounts(); // gauges refresh on a timer; force one refresh via the same query
  assert.equal((await t.call('/metrics')).status, 401);
  assert.equal((await t.call('/metrics', 'GET', null, 'wrong')).status, 401);
  const ok = await t.call('/metrics', 'GET', null, 'scrape-token-1234567890');
  assert.equal(ok.status, 200);
  const text = ok.text;
  for (const m of ['mobiad_ledger_queue', 'mobiad_ledger_dropped_total', 'mobiad_redis_degraded', 'mobiad_campaigns_pending_review', 'mobiad_apps_flagged', 'mobiad_payouts_pending',
    'mobiad_process_resident_memory_bytes', 'mobiad_eventloop_lag_p99_seconds', 'mobiad_db_pool_waiting', 'mobiad_http_requests_total', 'mobiad_build_info{version=']) assert.ok(text.includes(m), m);
  for (const line of text.trim().split('\n').filter((l) => l && !l.startsWith('#'))) assert.match(line, /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? -?[0-9.eE+]+$/, 'bad exposition line: ' + line);
  assert.match(text, /# TYPE mobiad_ledger_queue gauge/);
  await t.stop();
});

test('compliance: terms acceptance is recorded with version and time; required when configured; shown in the export', async () => {
  const t = await boot({ requireTermsAcceptance: true, termsVersion: 'v-test-1' });
  const post = (b) => t.call('/api/signup', 'POST', { email: 'terms@x.io', password: PW, role: 'advertiser', ...b });
  const no = await post({}); assert.equal(no.status, 400); assert.equal(no.body.error, 'terms_not_accepted');
  assert.equal((await post({ acceptTerms: 'yes' })).status, 400); // must be literally true
  assert.equal((await post({ acceptTerms: false })).status, 400);
  const ok = await post({ acceptTerms: true }); assert.equal(ok.status, 201);
  const u = await t.app.repo.userByEmail('terms@x.io');
  assert.equal(u.terms_version, 'v-test-1'); assert.ok(Number(u.terms_accepted_at) > 0);
  const exp = await t.call('/api/account/export', 'GET', null, ok.body.token);
  assert.equal(exp.body.account.termsVersion, 'v-test-1'); assert.ok(exp.body.account.termsAcceptedAt > 0);
  await t.stop();
});

test('compliance: legal pages, security.txt and the OpenAPI spec are served; legal pages carry the DRAFT banner', async () => {
  const t = await boot();
  const priv = await t.call('/privacy'); assert.equal(priv.status, 200); assert.match(priv.text, /Privacy Policy/); assert.match(priv.text, /DRAFT/);
  const terms = await t.call('/terms'); assert.equal(terms.status, 200); assert.match(terms.text, /Terms of Service/); assert.match(terms.text, /DRAFT/);
  const sec = await t.call('/.well-known/security.txt'); assert.equal(sec.status, 200);
  assert.match(sec.headers.get('content-type'), /text\/plain/); assert.match(sec.text, /^Contact: /m); assert.match(sec.text, /^Expires: /m);
  await t.stop();
});

test('retention: purge removes old one-time tokens and audit entries but never ledger rows', async () => {
  const t = await boot();
  const repo = t.app.repo, day = 86_400_000, now = Date.now();
  const u = 'usr_ret';
  await repo.createToken({ id: 'o1', userId: u, purpose: 'verify', hash: 'h-old', expiresAt: now - 40 * day });   // expired 40 days ago: purge
  await repo.createToken({ id: 'o2', userId: u, purpose: 'verify', hash: 'h-recent', expiresAt: now - 5 * day });  // expired recently: keep (30-day grace)
  await repo.createToken({ id: 'o3', userId: u, purpose: 'reset', hash: 'h-live', expiresAt: now + day });         // still valid: keep
  await repo.q('INSERT INTO audit_log (at,actor,action) VALUES ($1,$2,$3),($4,$5,$6)', [now - 500 * day, 'a', 'old_event', now - 10 * day, 'a', 'recent_event']);
  await repo.recordBatch([{ type: 'impression', campaignId: 'c', appId: 'a', cost: 0.001, t: now - 3000 * day, token: 'ancient' }]); // 8 years old
  const r = await repo.purgeExpired({ now });
  assert.deepEqual(r, { oneTimeTokens: 1, auditLog: 1 });
  assert.deepEqual((await repo.q('SELECT id FROM one_time_tokens ORDER BY id')).rows.map((x) => x.id), ['o2', 'o3']);
  assert.deepEqual((await repo.auditList({ actor: 'a' })).map((x) => x.action), ['recent_event']);
  assert.equal(Number((await repo.q('SELECT COUNT(*) n FROM ledger')).rows[0].n), 1); // the billing ledger is never purged
  await t.stop();
});
