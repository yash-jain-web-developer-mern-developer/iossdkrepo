// Automated publisher payouts through Stripe Connect: onboarding, readiness, sending a transfer, automatic small payouts, failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { boot, serve, settle } from './lib/helpers.js';
import { signStripePayload } from '../src/billing/stripe.js';

const camp = (o = {}) => ({ name: 'Launch', bid: 6000, budget: 1000, clickUrl: 'https://example.com/landing', ...o });
const secret = 'whsec_connect';

async function stripeStub() {
  const st = { calls: [], ready: false, failTransfer: false };
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
    const form = new URLSearchParams(b), path = req.url; st.calls.push({ method: req.method, path, form, idem: req.headers['idempotency-key'], auth: req.headers.authorization });
    const out = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (path === '/v1/accounts' && req.method === 'POST' && st.rejectRecipient && form.get('tos_acceptance[service_agreement]') === 'recipient') return out(400, { error: { message: 'The recipient ToS agreement is not supported for platforms in US creating accounts in GB.' } });
    if (path === '/v1/accounts' && req.method === 'POST' && form.get('country') === 'IN') return out(400, { error: { message: 'Connected accounts in IN cannot be created by platforms in US.' } });
    if (path === '/v1/accounts' && req.method === 'POST') return out(200, { id: 'acct_test1', object: 'account', details_submitted: false, payouts_enabled: false, requirements: { currently_due: ['individual.first_name', 'external_account'] } });
    if (path === '/v1/account_links') return out(200, { url: 'https://connect.stripe.com/setup/e/acct_test1/abc' });
    if (path === '/v1/accounts/acct_test1') return out(200, { id: 'acct_test1', details_submitted: st.ready, payouts_enabled: st.ready, charges_enabled: st.ready, requirements: { currently_due: st.ready ? [] : ['external_account'] } });
    if (path === '/v1/transfers') return st.failTransfer ? out(400, { error: { code: 'balance_insufficient', message: 'Insufficient funds in your Stripe balance.' } }) : out(200, { id: 'tr_' + form.get('metadata[payout_id]').slice(-6), amount: Number(form.get('amount')) });
    return out(404, { error: { message: 'unknown ' + path } });
  }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); st.url = `http://127.0.0.1:${srv.address().port}`; st.close = () => srv.close(); return st;
}
async function connectApp(st, extra = {}) {
  const t = await boot({ paymentsMode: 'stripe', stripeSecretKey: 'sk_test_x', stripeWebhookSecret: secret, stripeApiBase: st.url, payoutsMode: 'stripe_connect', minPayoutUsd: 5, requirePayoutVerification: true, ...extra });
  const adv = await t.signup('adv@x.io', 'advertiser'), pub = await t.signup('pub@x.io', 'publisher'), admin = await t.makeAdmin();
  await t.call('/api/campaigns', 'POST', camp(), adv);
  const a = (await t.call('/api/apps', 'POST', { name: 'Big App', floorEcpm: 5000 }, pub)).body;
  for (let i = 0; i < 20; i++) assert.equal((await serve(t, a.id)).status, 200); // 20 x $5 => $100 spend => $70 for the publisher
  await settle(t.app);
  const me = await t.app.repo.userByEmail('pub@x.io');
  const hook = (type, object) => { const raw = JSON.stringify({ id: 'evt_' + Math.random(), type, data: { object } }); return t.call('/api/webhooks/stripe', 'POST', null, null, raw, { 'stripe-signature': signStripePayload(raw, secret) }); };
  return { t, adv, pub, admin, me, hook, status: async (refresh = false) => (await t.call('/api/billing/connect/status' + (refresh ? '?refresh=1' : ''), 'GET', null, pub)).body };
}

test('manual mode: the Connect endpoints are off and say so', async () => {
  const t = await boot({ minPayoutUsd: 5 });
  const pub = await t.signup('pub@x.io', 'publisher'), admin = await t.makeAdmin();
  assert.equal((await t.call('/api/billing/connect/start', 'POST', {}, pub)).status, 501);
  assert.equal((await t.call('/api/billing/connect/status', 'GET', null, pub)).body.mode, 'manual');
  assert.equal((await t.call('/api/admin/payouts/send', 'POST', { id: 'x' }, admin)).status, 501);
  await t.stop();
});

test('onboarding: an account and onboarding link are created, readiness is tracked, and Stripe verification counts as KYC and tax', async () => {
  const st = await stripeStub(); const { t, pub, me, hook, status } = await connectApp(st);
  // no payout account yet: a payout cannot be requested
  assert.equal((await t.call('/api/billing/payout', 'POST', { amountUsd: 10 }, pub)).body.error, 'payout_account_required');
  const s1 = await status(); assert.equal(s1.mode, 'stripe_connect'); assert.equal(s1.connected, false);
  const start = await t.call('/api/billing/connect/start', 'POST', {}, pub); assert.equal(start.status, 200); assert.match(start.body.url, /^https:\/\/connect\.stripe\.com\//);
  const acctCall = st.calls.find((c) => c.path === '/v1/accounts'), linkCall = st.calls.find((c) => c.path === '/v1/account_links');
  assert.equal(acctCall.form.get('type'), 'express'); assert.equal(acctCall.form.get('capabilities[transfers][requested]'), 'true'); assert.equal(acctCall.form.get('metadata[user_id]'), me.id); assert.equal(acctCall.form.get('email'), 'pub@x.io'); assert.equal(acctCall.auth, 'Bearer sk_test_x');
  assert.equal(linkCall.form.get('account'), 'acct_test1'); assert.equal(linkCall.form.get('type'), 'account_onboarding'); assert.match(linkCall.form.get('return_url'), /#connect=return$/); assert.match(linkCall.form.get('refresh_url'), /#connect=refresh$/);
  await t.call('/api/billing/connect/start', 'POST', {}, pub); assert.equal(st.calls.filter((c) => c.path === '/v1/accounts').length, 1); // the account is created once; a new link each time
  const s2 = await status(); assert.equal(s2.connected, true); assert.equal(s2.payoutsEnabled, false);
  assert.equal((await t.call('/api/billing/payout', 'POST', { amountUsd: 10 }, pub)).body.error, 'payout_account_required'); // onboarding not finished

  st.ready = true; const s3 = await status(true); // the publisher finished onboarding; asking Stripe updates our record
  assert.equal(s3.payoutsEnabled, true); assert.equal(s3.requirements.length, 0);
  const prof = await t.app.repo.payoutProfile(me.id); assert.equal(prof.kyc_status, 'verified'); assert.equal(prof.tax_status, 'verified');
  // Stripe tells us something changed: the readiness flags follow the event
  await hook('account.updated', { id: 'acct_test1', details_submitted: true, payouts_enabled: false, requirements: { currently_due: ['external_account'] } });
  const s4 = await status(); assert.equal(s4.payoutsEnabled, false); assert.deepEqual(s4.requirements, ['external account']);
  await hook('account.updated', { id: 'acct_unknown', payouts_enabled: true }); // not ours: ignored
  await t.stop(); st.close();
});

test('paying out: an admin sends an approved payout as a Stripe transfer exactly once; failures leave it approved so it can be retried', async () => {
  const st = await stripeStub(); const { t, pub, admin, status } = await connectApp(st);
  await t.call('/api/billing/connect/start', 'POST', {}, pub); st.ready = true; await status(true);
  const req = await t.call('/api/billing/payout', 'POST', { amountUsd: 30 }, pub); assert.equal(req.status, 201); assert.equal(req.body.status, 'requested');
  const queue = (await t.call('/api/admin/payouts?status=requested', 'GET', null, admin)).body; assert.equal(queue[0].viaStripe, true); assert.equal(queue[0].stripeReady, true);
  assert.equal((await t.call('/api/admin/payouts/send', 'POST', { id: req.body.id }, pub)).status, 403); // not an admin
  assert.equal((await t.call('/api/admin/payouts/send', 'POST', { id: req.body.id }, admin)).body.error, 'not_approved'); // must be approved (or approve=true)
  st.failTransfer = true;
  const failed = await t.call('/api/admin/payouts/send', 'POST', { id: req.body.id, approve: true }, admin); assert.equal(failed.status, 502); assert.match(failed.body.detail, /Insufficient funds/);
  assert.equal((await t.app.repo.payout(req.body.id)).status, 'approved'); // approved but not paid: nothing is lost
  st.failTransfer = false;
  const ok = await t.call('/api/admin/payouts/send', 'POST', { id: req.body.id }, admin); assert.equal(ok.status, 200); assert.equal(ok.body.status, 'paid'); assert.match(ok.body.reference, /^tr_/);
  const tr = st.calls.filter((c) => c.path === '/v1/transfers').pop();
  assert.equal(tr.form.get('amount'), '3000'); assert.equal(tr.form.get('currency'), 'usd'); assert.equal(tr.form.get('destination'), 'acct_test1'); assert.equal(tr.form.get('transfer_group'), req.body.id); assert.equal(tr.idem, 'payout-' + req.body.id);
  const row = await t.app.repo.payout(req.body.id); assert.equal(row.status, 'paid'); assert.equal(row.reference, ok.body.reference);
  assert.equal((await t.call('/api/admin/payouts/send', 'POST', { id: req.body.id }, admin)).body.error, 'not_approved'); // already paid: no second transfer
  assert.equal(st.calls.filter((c) => c.path === '/v1/transfers').length, 2); // one failed attempt, one success
  const summary = (await t.call('/api/billing/summary', 'GET', null, pub)).body; assert.equal(summary.paid, 30);
  const audit = (await t.call('/api/admin/audit?limit=50', 'GET', null, admin)).body; assert.ok(audit.some((a) => a.action === 'payout_sent_stripe'));
  // an account that is not ready cannot be paid
  st.ready = false; await status(true);
  const r2 = await t.call('/api/billing/payout', 'POST', { amountUsd: 10 }, pub); assert.equal(r2.body.error, 'payout_account_required');
  await t.stop(); st.close();
});

test('automatic payouts: small payouts to an onboarded publisher are approved and paid at once; larger ones, and failures, wait for an admin', async () => {
  const st = await stripeStub(); const { t, pub, admin, status } = await connectApp(st, { autoPayoutMaxUsd: 25 });
  await t.call('/api/billing/connect/start', 'POST', {}, pub); st.ready = true; await status(true);
  const small = await t.call('/api/billing/payout', 'POST', { amountUsd: 20 }, pub);
  assert.equal(small.status, 201); assert.equal(small.body.status, 'paid'); assert.equal(small.body.auto, 'paid'); assert.match(small.body.reference, /^tr_/);
  assert.equal((await t.app.repo.payout(small.body.id)).resolved_by, 'system:auto');
  const big = await t.call('/api/billing/payout', 'POST', { amountUsd: 30 }, pub); assert.equal(big.body.status, 'requested'); assert.equal(big.body.auto, undefined); // above the automatic limit
  st.failTransfer = true;
  const flaky = await t.call('/api/billing/payout', 'POST', { amountUsd: 10 }, pub); assert.equal(flaky.body.status, 'approved'); assert.equal(flaky.body.auto, 'approved_send_failed');
  st.failTransfer = false;
  assert.equal((await t.call('/api/admin/payouts/send', 'POST', { id: flaky.body.id }, admin)).status, 200); // the admin retries and it goes through
  assert.equal((await t.call('/api/admin/payouts/send', 'POST', { id: big.body.id, approve: true }, admin)).status, 200);
  assert.equal((await t.call('/api/billing/summary', 'GET', null, pub)).body.paid, 60);
  await t.stop(); st.close();
});

test('configuration: Connect payouts need a Stripe key, and the mode is validated', async () => {
  const { loadConfig } = await import('../src/config.js');
  assert.throws(() => loadConfig({ PAYOUTS_MODE: 'stripe_connect' }), /STRIPE_SECRET_KEY/);
  assert.throws(() => loadConfig({ PAYOUTS_MODE: 'wire' }), /PAYOUTS_MODE must be/);
  const ok = loadConfig({ PAYOUTS_MODE: 'stripe_connect', STRIPE_SECRET_KEY: 'sk_test_x', AUTO_PAYOUT_MAX_USD: '50' }); assert.equal(ok.payoutsMode, 'stripe_connect'); assert.equal(ok.autoPayoutMaxUsd, 50);
  assert.equal(loadConfig({}).payoutsMode, 'manual');
});

test('payout hold: recent earnings stay pending for PAYOUT_HOLD_DAYS and become payable once they are older', async () => {
  const st = await stripeStub(); const { t, pub, status } = await connectApp(st, { payoutHoldDays: 7 });
  await t.call('/api/billing/connect/start', 'POST', {}, pub); st.ready = true; await status(true);
  const s1 = (await t.call('/api/billing/summary', 'GET', null, pub)).body;
  assert.equal(s1.holdDays, 7); assert.equal(s1.pending, 70); assert.equal(s1.payable, 0); // $100 spend today: the whole $70 share is still pending
  const early = await t.call('/api/billing/payout', 'POST', { amountUsd: 10 }, pub); assert.equal(early.status, 409); assert.equal(early.body.error, 'exceeds_payable');
  await t.app.repo.q("UPDATE ledger SET day = '2020-01-01'"); // the earnings are now old enough
  const s2 = (await t.call('/api/billing/summary', 'GET', null, pub)).body; assert.equal(s2.pending, 0); assert.equal(s2.payable, 70);
  assert.equal((await t.call('/api/billing/payout', 'POST', { amountUsd: 10 }, pub)).status, 201);
  await t.stop(); st.close();
});

test('configuration: the payout hold is read from PAYOUT_HOLD_DAYS (0 by default outside production) and is bounded', async () => {
  const { loadConfig } = await import('../src/config.js');
  assert.equal(loadConfig({}).payoutHoldDays, 0);
  assert.equal(loadConfig({ PAYOUT_HOLD_DAYS: '3' }).payoutHoldDays, 3);
  assert.throws(() => loadConfig({ PAYOUT_HOLD_DAYS: '120' }), /PAYOUT_HOLD_DAYS/);
});

test('onboarding outside the platform country uses the recipient service agreement (Stripe requires it for transfer-only accounts there); inside it does not', async () => {
  for (const [country, expected] of [['GB', 'recipient'], ['US', null]]) {
    const st = await stripeStub(); const { t, pub, me } = await connectApp(st);
    await t.app.repo.savePayoutProfile(me.id, { legalName: 'Dev Studio', country, method: 'bank', methodRef: '1234' });
    assert.equal((await t.call('/api/billing/connect/start', 'POST', {}, pub)).status, 200);
    const call = st.calls.find((c) => c.path === '/v1/accounts'); assert.equal(call.form.get('country'), country); assert.equal(call.form.get('tos_acceptance[service_agreement]'), expected);
    await t.stop(); st.close();
  }
});

test('cross-border onboarding falls back to the full agreement (card_payments + transfers) when Stripe refuses the recipient agreement for that country', async () => {
  const st = await stripeStub(); st.rejectRecipient = true; const { t, pub, me } = await connectApp(st);
  await t.app.repo.savePayoutProfile(me.id, { legalName: 'Dev Studio', country: 'GB', method: 'bank', methodRef: '1234' });
  assert.equal((await t.call('/api/billing/connect/start', 'POST', {}, pub)).status, 200);
  const calls = st.calls.filter((c) => c.path === '/v1/accounts' && c.form.get('type')); assert.equal(calls.length, 2);
  assert.equal(calls[0].form.get('tos_acceptance[service_agreement]'), 'recipient'); assert.equal(calls[1].form.get('capabilities[card_payments][requested]'), 'true'); assert.equal(calls[1].form.get('tos_acceptance[service_agreement]'), null);
  assert.notEqual(calls[0].idem, calls[1].idem); // different parameters need different idempotency keys
  await t.stop(); st.close();
});

test('a country Stripe cannot onboard (for example India for a US platform) gets a clear answer, not a server error', async () => {
  const st = await stripeStub(); const { t, pub, me } = await connectApp(st);
  await t.app.repo.savePayoutProfile(me.id, { legalName: 'Dev Studio', country: 'IN', method: 'bank', methodRef: '1234' });
  const r = await t.call('/api/billing/connect/start', 'POST', {}, pub); assert.equal(r.status, 409); assert.equal(r.body.error, 'country_unsupported'); assert.match(r.body.detail, /manually/);
  await t.stop(); st.close();
});
