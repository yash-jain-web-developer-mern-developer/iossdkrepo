// Opt-in: the full product flow against REAL Postgres + Redis + Kafka + SMTP (see infra/docker-compose.deps.yml).
// Skipped unless DATABASE_URL, REDIS_URL, KAFKA_BROKERS, SMTP_URL and MAILPIT_API are all set, so `npm test` stays hermetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, PW, serve, human, settle, sleep } from '../lib/helpers.js';
import { createPool, Repo } from '../../src/db/repo.js';
import { codeNow } from '../lib/helpers.js';

const E = process.env;
const real = E.DATABASE_URL && E.REDIS_URL && E.KAFKA_BROKERS && E.SMTP_URL && E.MAILPIT_API;
const skip = !real && 'needs DATABASE_URL, REDIS_URL, KAFKA_BROKERS, SMTP_URL, MAILPIT_API';
const tag = Math.random().toString(36).slice(2, 8);
const mail = async (to, tries = 40) => { // read the message from the real SMTP server's HTTP API
  for (let i = 0; i < tries; i++) {
    const r = await (await fetch(`${E.MAILPIT_API}/api/v1/search?query=${encodeURIComponent('to:' + to)}`)).json();
    if (r.messages?.length) { const m = await (await fetch(`${E.MAILPIT_API}/api/v1/message/${r.messages[0].ID}`)).json(); return m; }
    await sleep(250);
  }
  throw new Error('no mail for ' + to);
};
// Each test gets its own empty database so runs are isolated and repeatable.
async function freshDatabase(label) {
  const name = `it_${label}_${tag}`, admin = await createPool(E.DATABASE_URL);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(E.DATABASE_URL); u.pathname = '/' + name;
  return { url: u.toString(), drop: async () => { const a = await createPool(E.DATABASE_URL); await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {}); await a.end(); } };
}
const fragmentToken = (text, kind) => text.match(new RegExp(`#${kind}=([A-Za-z0-9_-]+)`))?.[1];

test('real infra: concurrent migrations from many instances are safe and complete', { skip }, async () => {
  const db = await freshDatabase('mig');
  const pools = await Promise.all(Array.from({ length: 4 }, () => createPool(db.url)));
  const repos = pools.map((p) => new Repo(p));
  await Promise.all(repos.map((r) => r.migrate())); // all four race on the advisory lock
  const v = (await repos[0].q('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => Number(r.version));
  assert.deepEqual(v, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const cols = (await repos[0].q("SELECT column_name FROM information_schema.columns WHERE table_name='users'")).rows.map((r) => r.column_name);
  for (const c of ['email_verified', 'token_version', 'totp_secret_enc', 'totp_enabled', 'recovery_hashes']) assert.ok(cols.includes(c), c);
  await Promise.all(pools.map((p) => p.end()));
  await db.drop();
});

test('real infra: signup -> real email -> verify -> MFA -> review -> serve -> bill via Kafka -> wallet/reports -> payout', { skip, timeout: 120_000 }, async () => {
  const db = await freshDatabase('flow');
  const t = await boot({ databaseUrl: db.url, redisUrl: E.REDIS_URL, kafkaBrokers: E.KAFKA_BROKERS.split(','), kafkaTopic: 'it.events.' + tag,
    smtpUrl: E.SMTP_URL, mailFrom: 'MobiAd <no-reply@mobiad.test>', requireEmailVerification: true, autoApproveCampaigns: false, requireFunding: true, requireAdminMfa: true,
    paymentsMode: 'test', rateLimit: 100000, minPayoutUsd: 10 });
  const advEmail = `adv-${tag}@it.test`, pubEmail = `pub-${tag}@it.test`;
  const adv0 = (await t.call('/api/signup', 'POST', { email: advEmail, password: PW, role: 'advertiser' })).body.token;
  const pub0 = (await t.call('/api/signup', 'POST', { email: pubEmail, password: PW, role: 'publisher' })).body.token;

  // 1. a REAL email reaches a REAL SMTP server and the link verifies the account
  const m = await mail(advEmail);
  assert.match(m.Subject, /Verify your MobiAd email/); assert.equal(m.From.Address, 'no-reply@mobiad.test');
  assert.equal((await t.call('/api/campaigns', 'POST', { name: 'x', bid: 1, budget: 1, clickUrl: 'https://example.com' }, adv0)).body.error, 'email_not_verified');
  assert.equal((await t.call('/api/verify-email', 'POST', { token: fragmentToken(m.Text, 'verify') })).status, 200);
  assert.equal((await t.call('/api/verify-email', 'POST', { token: fragmentToken((await mail(pubEmail)).Text, 'verify') })).status, 200);

  // 2. MFA on an admin (created directly: admins never come from public signup)
  const admin0 = await t.makeAdmin(`admin-${tag}@it.test`);
  const setup = await t.call('/api/mfa/setup', 'POST', { password: PW }, admin0);
  const admin = (await t.call('/api/mfa/enable', 'POST', { code: codeNow(setup.body.secret) }, admin0)).body.token;

  // 3. wallet + review + serve
  const advUser = await t.app.repo.userByEmail(advEmail);
  assert.equal((await t.call('/api/admin/wallet/credit', 'POST', { userId: advUser.id, amountUsd: 500, note: 'integration test', reference: 'it-' + tag }, admin)).body.applied, true);
  const c = (await t.call('/api/campaigns', 'POST', { name: 'IT Campaign', bid: 6000, budget: 400, clickUrl: 'https://example.com/it' }, adv0)).body;
  assert.equal(c.reviewStatus, 'pending');
  const a = (await t.call('/api/apps', 'POST', { name: 'IT App', floorEcpm: 5000 }, pub0)).body;
  assert.equal((await t.call('/v1/ad', 'POST', { appId: a.id })).status, 204); // pending: not served
  assert.equal((await t.call('/api/admin/campaigns/review', 'POST', { id: c.id, decision: 'approve', note: 'ok' }, admin)).status, 200);

  // 4. traffic through Kafka -> consumer -> Postgres ledger; concurrent, with duplicates and click fraud mixed in
  const N = 60;
  await Promise.all(Array.from({ length: N }, async () => { const s = await serve(t, a.id); await t.call(t.path(s.ad.impressionUrl)); })); // each impression fired twice (duplicate)
  const bot = await t.call('/v1/ad', 'POST', { appId: a.id }); await t.call(t.path(bot.body.impressionUrl)); await t.call(t.path(bot.body.clickUrl)); // instant click => invalid
  for (let i = 0; i < 80; i++) { // wait for the Kafka consumer to drain into Postgres
    await t.app.ledger.flush(500);
    const rep = (await t.call('/api/report', 'GET', null, adv0)).body;
    if (rep.total.impressions >= N + 1) break;
    await sleep(250);
  }
  const rep = (await t.call('/api/report', 'GET', null, adv0)).body;
  assert.equal(rep.total.impressions, N + 1); // duplicates not double counted
  assert.equal(rep.total.invalidClicks, 1); assert.equal(rep.total.clicks, 0);
  assert.equal(rep.total.spend, (N + 1) * 5); // $5 per impression at the $5000 CPM floor price

  // 5. money: wallet reserve math and publisher payout on real Postgres
  const sum = (await t.call('/api/billing/summary', 'GET', null, adv0)).body;
  assert.equal(sum.credits, 500); assert.equal(sum.spent, (N + 1) * 5); assert.equal(sum.available, 100); // 500 credit - 400 budget reserved
  const ps = (await t.call('/api/billing/summary', 'GET', null, pub0)).body;
  assert.equal(ps.earned, (N + 1) * 5 * 0.7);
  await t.call('/api/billing/payout-profile', 'POST', { legalName: 'It Pub', country: 'GB', method: 'paypal', methodRef: 'it@pub.example' }, pub0);
  const pay = await t.call('/api/billing/payout', 'POST', { amountUsd: 100 }, pub0);
  assert.equal(pay.status, 201);
  assert.equal((await t.call('/api/admin/payouts/resolve', 'POST', { id: pay.body.id, status: 'approved', note: 'it' }, admin)).status, 200);
  assert.equal((await t.call('/api/admin/payouts/resolve', 'POST', { id: pay.body.id, status: 'paid', reference: 'IT-TX' }, admin)).status, 200);
  assert.equal((await t.call('/api/billing/summary', 'GET', null, pub0)).body.paid, 100);

  // 6. password reset by real email revokes sessions
  await t.call('/api/forgot-password', 'POST', { email: pubEmail });
  await sleep(500);
  const resetMail = await mail(pubEmail, 40);
  const resetTok = fragmentToken(resetMail.Text, 'reset') || fragmentToken((await (await fetch(`${E.MAILPIT_API}/api/v1/messages`)).json()).messages.find((x) => x.Subject.includes('Reset') && x.To.some((r) => r.Address === pubEmail)) ? (await mail(pubEmail)).Text : '', 'reset');
  assert.ok(resetTok);
  assert.equal((await t.call('/api/reset-password', 'POST', { token: resetTok, password: 'Brand-New-Secret-Phrase-8' })).status, 200);
  assert.equal((await t.call('/api/me', 'GET', null, pub0)).status, 401);

  // 7. audit trail present on real Postgres
  const audit = (await t.call('/api/admin/audit?limit=500', 'GET', null, admin)).body.map((x) => x.action);
  for (const x of ['signup', 'email_verified', 'mfa_enabled', 'wallet_credit', 'campaign_reviewed', 'payout_requested', 'payout_resolved', 'password_reset']) assert.ok(audit.includes(x), x);
  await t.stop();
  await db.drop();
});

test('real infra: API keys and team members on real Postgres/Redis, invitation over real SMTP', { skip, timeout: 120_000 }, async () => {
  const db = await freshDatabase('team');
  const t = await boot({ databaseUrl: db.url, redisUrl: E.REDIS_URL, smtpUrl: E.SMTP_URL, mailFrom: 'MobiAd <no-reply@mobiad.test>', requireEmailVerification: false, rateLimit: 100000 });
  const owner = (await t.call('/api/signup', 'POST', { email: `own-${tag}@it.test`, password: PW, role: 'advertiser' })).body.token;
  const camp = { name: 'K', model: 'CPM', bid: 5, budget: 50, clickUrl: 'https://example.com/l' };

  const key = (await t.call('/api/keys', 'POST', { name: 'it', scope: 'write', expiresInDays: 30 }, owner)).body;
  assert.match(key.key, /^mak_key_/);
  assert.equal((await t.call('/api/campaigns', 'POST', camp, key.key)).status, 201);
  assert.equal((await t.call('/api/billing/topup', 'POST', { amountUsd: 5 }, key.key)).status, 403);
  const row = (await t.app.repo.q('SELECT key_hash, last_used_at FROM api_keys WHERE id=$1', [key.id])).rows[0];
  assert.ok(row.key_hash && !row.key_hash.includes(key.key.split('_').pop()), 'only a hash is stored');
  assert.ok(Number(row.last_used_at) > 0);
  assert.equal((await t.call('/api/keys/revoke', 'POST', { id: key.id }, owner)).status, 200);
  assert.equal((await t.call('/api/campaigns', 'GET', null, key.key)).status, 401);

  const to = `mem-${tag}@it.test`;
  assert.equal((await t.call('/api/team/invite', 'POST', { email: to, role: 'viewer' }, owner)).status, 201);
  const tok = fragmentToken((await mail(to)).Text, 'invite'); assert.ok(tok, 'real invitation email carries the token');
  const joined = await t.call('/api/team/accept', 'POST', { token: tok, password: PW });
  assert.equal(joined.status, 201);
  assert.equal((await t.call('/api/campaigns', 'GET', null, joined.body.token)).body.length, 1); // sees the owner's campaign
  assert.equal((await t.call('/api/campaigns', 'POST', camp, joined.body.token)).status, 403);
  assert.equal((await t.call('/api/team/accept', 'POST', { token: tok, password: PW })).status, 400); // single use
  const m = (await t.call('/api/team', 'GET', null, owner)).body.members[0];
  assert.equal((await t.call('/api/team/remove', 'POST', { id: m.id }, owner)).status, 200);
  assert.equal((await t.call('/api/campaigns', 'GET', null, joined.body.token)).status, 401);
  await t.stop(); await db.drop();
});

test('real infra: video creative, CPA conversion billed once through Kafka, and the payout verification workflow', { skip, timeout: 180_000 }, async () => {
  const db = await freshDatabase('p123');
  const t = await boot({ databaseUrl: db.url, redisUrl: E.REDIS_URL, kafkaBrokers: E.KAFKA_BROKERS.split(','), kafkaTopic: 'it.p123.' + tag,
    requireEmailVerification: false, requirePayoutVerification: true, minPayoutUsd: 1, rateLimit: 100000 });
  const adv = (await t.call('/api/signup', 'POST', { email: `a-${tag}@it.test`, password: PW, role: 'advertiser' })).body.token;
  const pub = (await t.call('/api/signup', 'POST', { email: `p-${tag}@it.test`, password: PW, role: 'publisher' })).body.token;
  const admin = await t.makeAdmin(`admin2-${tag}@it.test`);
  const key = (await t.call('/api/keys', 'POST', { name: 's2s', scope: 'write' }, adv)).body.key;
  const a = (await t.call('/api/apps', 'POST', { name: 'App', floorEcpm: 0 }, pub)).body;

  // video creative (JSONB) round-trips through Postgres and is served; completion is counted, never billed
  const v = (await t.call('/api/campaigns', 'POST', { name: 'Vid', model: 'CPM', bid: 20, budget: 100, format: 'video', videoUrl: 'https://cdn.example.com/a.mp4', durationSec: 10, clickUrl: 'https://example.com/v' }, adv)).body;
  const vad = await t.call('/v1/ad', 'POST', { appId: a.id, format: 'video' });
  assert.equal(vad.body.creative.videoUrl, 'https://cdn.example.com/a.mp4');
  await t.call(t.path(vad.body.impressionUrl)); await t.call(t.path(vad.body.videoCompleteUrl));

  // CPA: click -> attribution id -> S2S conversion (replayed) bills exactly once
  await t.call('/api/campaigns/status', 'POST', { id: v.id, status: 'paused' }, adv);
  const c = (await t.call('/api/campaigns', 'POST', { name: 'CPA', model: 'CPA', bid: 3, budget: 100, conversionEvent: 'purchase', clickUrl: 'https://example.com/c' }, adv)).body;
  const ad = await t.call('/v1/ad', 'POST', { appId: a.id });
  await t.call(t.path(ad.body.impressionUrl)); await human();
  const landing = new URL((await t.call(t.path(ad.body.clickUrl))).headers.get('location'));
  const clickId = landing.searchParams.get('mobiad_click_id'); assert.ok(clickId);
  assert.equal((await t.call('/v1/conversion', 'POST', { clickId, event: 'purchase', eventId: 'o1', value: 9.5 }, key)).status, 200);
  assert.equal((await t.call('/v1/conversion', 'POST', { clickId, event: 'purchase', eventId: 'o1', value: 9.5 }, key)).body.duplicate, true);
  let rep;
  for (let i = 0; i < 80; i++) { // wait for the Kafka consumer to drain into Postgres
    await t.app.ledger.flush(500);
    rep = (await t.call('/api/report', 'GET', null, adv)).body.total;
    if (rep.conversions >= 1 && rep.videoCompletes >= 1 && rep.impressions >= 2) break;
    await sleep(250);
  }
  assert.equal(rep.conversions, 1); assert.equal(rep.conversionValue, 9.5); assert.equal(rep.videoCompletes, 1);
  assert.ok(rep.spend >= 3 && rep.spend < 3.001, 'one CPA conversion ($3) plus a sub-cent second-price video impression');
  const row = (await t.app.repo.q('SELECT conversions FROM campaigns WHERE id=$1', [c.id])).rows[0]; assert.ok(Number(row.conversions) >= 0);

  // payouts: verification gate, then approved -> paid on real Postgres
  const me = await t.app.repo.userByEmail(`p-${tag}@it.test`);
  assert.equal((await t.call('/api/billing/payout', 'POST', { amountUsd: 1 }, pub)).body.error, 'profile_incomplete');
  await t.call('/api/billing/payout-profile', 'POST', { legalName: 'It Ltd', country: 'GB', method: 'paypal', methodRef: 'it@pub.example' }, pub);
  assert.equal((await t.call('/api/billing/payout', 'POST', { amountUsd: 1 }, pub)).body.error, 'kyc_required');
  for (const kind of ['kyc', 'tax']) { await t.call('/api/billing/payout-profile/submit', 'POST', { kind }, pub); await t.call('/api/admin/payout-profiles/review', 'POST', { userId: me.id, kind, status: 'verified' }, admin); }
  const p = await t.call('/api/billing/payout', 'POST', { amountUsd: 1 }, pub); assert.equal(p.status, 201);
  assert.equal((await t.call('/api/admin/payouts/resolve', 'POST', { id: p.body.id, status: 'paid', reference: 'x' }, admin)).status, 409);
  assert.equal((await t.call('/api/admin/payouts/resolve', 'POST', { id: p.body.id, status: 'approved' }, admin)).status, 200);
  assert.equal((await t.call('/api/admin/payouts/resolve', 'POST', { id: p.body.id, status: 'paid', reference: 'TX-1' }, admin)).status, 200);
  assert.match((await t.call('/api/admin/payouts.csv?status=paid', 'GET', null, admin)).text, /TX-1/);
  await t.stop(); await db.drop();
});

test('real infra: ledger dimensions, creatives, placements, webhooks, partners, invoices on real Postgres + Kafka', { skip, timeout: 240_000 }, async () => {
  const http = await import('node:http');
  const db = await freshDatabase('p4');
  const hits = [];
  const hook = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { hits.push({ b, h: req.headers }); res.writeHead(200); res.end('ok'); }); });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const dsp = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { if (req.method !== 'POST') { res.writeHead(200); return res.end(); } const j = JSON.parse(b); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: j.id, seatbid: [{ bid: [{ impid: '1', price: 30, adm: '<div>partner</div>' }] }] })); }); });
  await new Promise((r) => dsp.listen(0, '127.0.0.1', r));
  const t = await boot({ databaseUrl: db.url, redisUrl: E.REDIS_URL, kafkaBrokers: E.KAFKA_BROKERS.split(','), kafkaTopic: 'it.p4.' + tag, requireEmailVerification: false, rateLimit: 100000, allowPrivateCallbacks: true, webhookIntervalMs: 200 });
  const adv = (await t.call('/api/signup', 'POST', { email: `a4-${tag}@it.test`, password: PW, role: 'advertiser' })).body.token;
  const pub = (await t.call('/api/signup', 'POST', { email: `p4-${tag}@it.test`, password: PW, role: 'publisher' })).body.token;
  const admin = await t.makeAdmin(`admin4-${tag}@it.test`);
  const a = (await t.call('/api/apps', 'POST', { name: 'App' }, pub)).body;
  const plc = (await t.call('/api/placements', 'POST', { appId: a.id, name: 'Home', format: 'banner' }, pub)).body;
  const h = (await t.call('/api/webhooks', 'POST', { url: `http://127.0.0.1:${hook.address().port}/h`, events: ['campaign.approved'] }, adv)).body;
  const c = (await t.call('/api/campaigns', 'POST', { name: 'Multi', model: 'CPM', bid: 8, budget: 100, clickUrl: 'https://example.com/m', creatives: [{ title: 'One' }, { title: 'Two' }], targeting: { languages: ['en'] } }, adv)).body;
  await t.call('/api/admin/campaigns/review', 'POST', { id: c.id, decision: 'approve' }, admin);
  for (let i = 0; i < 40 && !hits.length; i++) await sleep(250);
  assert.equal(hits.length, 1); assert.equal(JSON.parse(hits[0].b).event, 'campaign.approved'); // webhook queued in Postgres, delivered by the worker

  assert.equal((await t.call('/v1/ad', 'POST', { appId: a.id, placementId: plc.id, country: 'US', language: 'fr' })).status, 204); // targeting: wrong language
  for (let i = 0; i < 6; i++) { const r = await t.call('/v1/ad', 'POST', { appId: a.id, placementId: plc.id, country: 'US', language: 'en' }); assert.equal(r.status, 200); await t.call(t.path(r.body.impressionUrl)); }
  let rows = [];
  for (let i = 0; i < 80; i++) { await t.app.ledger.flush(500); rows = (await t.call('/api/report/breakdown?by=creative', 'GET', null, adv)).body; if (rows.reduce((n, r) => n + r.impressions, 0) >= 6) break; await sleep(250); }
  assert.equal(rows.reduce((n, r) => n + r.impressions, 0), 6); assert.ok(rows.every((r) => /^cr_[01]$/.test(r.key)));
  assert.equal((await t.call('/api/report/breakdown?by=country', 'GET', null, adv)).body[0].key, 'US');
  assert.equal((await t.call('/api/report/breakdown?by=placement', 'GET', null, pub)).body[0].key, plc.id);

  // partner wins at 30 CPM against our 8 CPM; revenue is booked under ext_<id> through Kafka into the real ledger
  const pr = (await t.call('/api/admin/partners', 'POST', { name: 'DSP', endpointUrl: `http://127.0.0.1:${dsp.address().port}/bid` }, admin)).body;
  const ext = await t.call('/v1/ad', 'POST', { appId: a.id, language: 'en' }); assert.ok(ext.body.external);
  await t.call(t.path(ext.body.impressionUrl));
  let gross = 0;
  for (let i = 0; i < 80 && !gross; i++) { await t.app.ledger.flush(500); gross = (await t.call('/api/admin/partners', 'GET', null, admin)).body.find((p) => p.id === pr.id).grossUsd; await sleep(250); }
  assert.ok(gross > 0.008 && gross < 0.0082, 'second price: partner pays just above our 8 CPM: ' + gross);

  // invoice for a closed month on real Postgres + credit note
  const now = new Date(), lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  await t.app.repo.q("UPDATE ledger SET day=$1 WHERE campaign_id=$2", [lastMonth + '-10', c.id]);
  const inv = await t.call('/api/billing/invoices/generate', 'POST', { month: lastMonth }, adv); assert.equal(inv.status, 201); assert.ok(inv.body.total > 0);
  assert.equal((await t.call('/api/billing/invoices/generate', 'POST', { month: lastMonth }, adv)).body.id, inv.body.id);
  const me = await t.app.repo.userByEmail(`a4-${tag}@it.test`);
  assert.equal((await t.call('/api/admin/credit-notes', 'POST', { userId: me.id, amountUsd: 3, reason: 'it', invoiceId: inv.body.id }, admin)).status, 201);
  assert.equal((await t.call('/sellers.json')).body.sellers.length >= 2, true);
  await t.stop(); hook.close(); dsp.close(); await db.drop();
});
