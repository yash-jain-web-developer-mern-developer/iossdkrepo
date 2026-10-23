// Payment lifecycle beyond the happy path: failed and expired attempts, refunds, card disputes (chargebacks), and tax invoices.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { boot, settle } from './lib/helpers.js';
import { signStripePayload, parseStripeEvent } from '../src/billing/stripe.js';
import { taxFor, splitInclusive, sanitizeProfile } from '../src/billing/tax.js';
import { loadConfig } from '../src/config.js';

const secret = 'whsec_lifecycle';
const camp = (o = {}) => ({ name: 'Launch', bid: 8, budget: 50, clickUrl: 'https://example.com/landing', ...o });

async function stripeApp(extra = {}) {
  const t = await boot({ paymentsMode: 'stripe', stripeSecretKey: 'sk_test_x', stripeWebhookSecret: secret, ...extra });
  const adv = await t.signup('adv@x.io', 'advertiser'), me = await t.app.repo.userByEmail('adv@x.io'), admin = await t.makeAdmin();
  const hook = (type, object) => { const raw = JSON.stringify({ id: 'evt_' + Math.random(), type, data: { object } }); return t.call('/api/webhooks/stripe', 'POST', null, null, raw, { 'stripe-signature': signStripePayload(raw, secret) }); };
  const summary = async () => (await t.call('/api/billing/summary', 'GET', null, adv)).body;
  const paid = (o = {}) => ({ id: 'cs_1', payment_status: 'paid', amount_total: 5000, currency: 'usd', payment_intent: 'pi_1', metadata: { user_id: me.id }, ...o });
  const mails = (re) => t.app.mailer.outbox.filter((m) => m.to === 'adv@x.io' && re.test(m.subject)).length;
  return { t, adv, me, admin, hook, summary, paid, mails };
}

test('failed and expired card attempts are recorded with the reason, tell the advertiser once, and never credit; a later success overrides', async () => {
  const { t, adv, me, hook, summary, paid, mails } = await stripeApp();
  const repo = t.app.repo;
  await repo.createPayment({ id: 'pmt_a', userId: me.id, provider: 'stripe', sessionId: 'cs_a', amountMicros: 50_000_000, status: 'pending' });
  const failure = { id: 'pi_a', amount: 5000, metadata: { user_id: me.id }, last_payment_error: { message: 'Your card was declined.', decline_code: 'generic_decline' } };
  assert.equal((await hook('payment_intent.payment_failed', failure)).status, 200);
  assert.equal((await repo.payment('pmt_a')).status, 'failed');
  assert.equal((await repo.payment('pmt_a')).failure, 'Your card was declined.');
  assert.equal((await summary()).credits, 0);
  assert.equal(mails(/did not go through/), 1);
  await hook('payment_intent.payment_failed', failure); assert.equal(mails(/did not go through/), 1); // Stripe retried the same event: one e-mail only
  const listed = (await t.call('/api/billing/payments', 'GET', null, adv)).body; assert.equal(listed[0].status, 'failed'); assert.match(listed[0].failure, /declined/);

  // the advertiser tries again and succeeds (for example after 3-D Secure): the same payment becomes paid and is credited once
  await hook('checkout.session.completed', paid({ id: 'cs_a', payment_intent: 'pi_a' }));
  assert.equal((await repo.payment('pmt_a')).status, 'paid'); assert.equal((await repo.payment('pmt_a')).failure, null);
  assert.equal((await summary()).credits, 50);
  await hook('checkout.session.completed', paid({ id: 'cs_a', payment_intent: 'pi_a' })); assert.equal((await summary()).credits, 50);

  // an abandoned checkout expires; an expiry event for an already-paid session changes nothing
  await repo.createPayment({ id: 'pmt_b', userId: me.id, provider: 'stripe', sessionId: 'cs_b', amountMicros: 20_000_000, status: 'pending' });
  await hook('checkout.session.expired', { id: 'cs_b', metadata: { user_id: me.id } }); assert.equal((await repo.payment('pmt_b')).status, 'expired');
  await hook('checkout.session.expired', { id: 'cs_a', metadata: { user_id: me.id } }); assert.equal((await repo.payment('pmt_a')).status, 'paid');
  // a delayed payment method that fails later
  await repo.createPayment({ id: 'pmt_c', userId: me.id, provider: 'stripe', sessionId: 'cs_c', amountMicros: 10_000_000, status: 'pending' });
  await hook('checkout.session.async_payment_failed', { id: 'cs_c', metadata: { user_id: me.id } }); assert.equal((await repo.payment('pmt_c')).status, 'failed');
  assert.equal((await summary()).credits, 50);
  await t.stop();
});

test('refunds: partial then full, exactly once per Stripe state, older or unknown events ignored, advertiser told', async () => {
  const { t, hook, summary, paid, mails } = await stripeApp();
  await hook('checkout.session.completed', paid({ id: 'cs_r', amount_total: 10000, payment_intent: 'pi_r' }));
  assert.equal((await summary()).credits, 100);
  const refund = (cents, extra = {}) => hook('charge.refunded', { id: 'ch_1', payment_intent: 'pi_r', amount_refunded: cents, ...extra });
  await refund(2500); let s = await summary(); assert.equal(s.credits, 75);
  assert.equal(s.entries.find((e) => e.kind === 'refund').amount, -25);
  assert.equal((await t.app.repo.paymentByIntent('pi_r')).status, 'partially_refunded');
  await refund(2500); assert.equal((await summary()).credits, 75); // same delivery again
  await refund(10000); assert.equal((await summary()).credits, 0); // cumulative 100 => 75 more
  assert.equal((await t.app.repo.paymentByIntent('pi_r')).status, 'refunded');
  await refund(2500); assert.equal((await summary()).credits, 0); // an older delivery arriving late
  await refund(5000, { payment_intent: 'pi_unknown' }); await hook('charge.refunded', { id: 'ch_x' }); assert.equal((await summary()).credits, 0); // not ours / malformed
  assert.equal(mails(/refund was issued/), 2);
  await t.stop();
});

test('card disputes: the amount is held when opened, released if won, kept (plus an optional fee) if lost; repeats are harmless', async () => {
  const { t, admin, hook, summary, paid } = await stripeApp({ disputeFeeUsd: 15 });
  const repo = t.app.repo;
  await hook('checkout.session.completed', paid({ id: 'cs_d1', payment_intent: 'pi_d1' }));
  await hook('checkout.session.completed', paid({ id: 'cs_d2', payment_intent: 'pi_d2' }));
  await hook('checkout.session.completed', paid({ id: 'cs_d3', payment_intent: 'pi_d3' }));
  assert.equal((await summary()).credits, 150);
  const open = (n) => hook('charge.dispute.created', { id: 'dp_' + n, payment_intent: 'pi_d' + n, amount: 5000, reason: 'fraudulent', status: 'needs_response' });
  const close = (n, status) => hook('charge.dispute.closed', { id: 'dp_' + n, payment_intent: 'pi_d' + n, amount: 5000, status });

  await open(1); assert.equal((await summary()).credits, 100); // held
  await open(1); assert.equal((await summary()).credits, 100); // duplicate delivery
  assert.equal((await repo.paymentByIntent('pi_d1')).status, 'disputed');
  const list = (await t.call('/api/admin/disputes', 'GET', null, admin)).body; assert.equal(list.length, 1); assert.equal(list[0].status, 'needs_response'); assert.equal(list[0].amount, 50);
  await close(1, 'won'); assert.equal((await summary()).credits, 150); // released
  assert.equal((await repo.paymentByIntent('pi_d1')).status, 'paid');
  await close(1, 'won'); assert.equal((await summary()).credits, 150);

  await open(2); await close(2, 'lost'); // hold stays, plus the $15 fee
  assert.equal((await summary()).credits, 85); assert.equal((await repo.paymentByIntent('pi_d2')).status, 'dispute_lost');
  const kinds = (await summary()).entries.map((e) => e.kind); assert.ok(kinds.includes('dispute_hold') && kinds.includes('dispute_fee') && kinds.includes('dispute_release'));

  await open(3); await close(3, 'charge_refunded'); assert.equal((await summary()).credits, 85); // our refund is booked separately; the hold is released
  await hook('charge.dispute.closed', { id: 'dp_9', payment_intent: 'pi_d3', amount: 2000, status: 'lost' }); // never seen opening: still booked correctly
  assert.equal((await summary()).credits, 85 - 20 - 15);
  assert.equal((await t.call('/api/admin/disputes', 'GET', null, await t.signup('o@x.io', 'advertiser'))).status, 403);
  await t.stop();
});

test('dispute hold amount: Stripe\'s figure can differ from what we credited (currency conversion), so a near-full dispute holds the whole payment (found by the real Stripe sandbox)', async () => {
  const { t, hook, summary, paid } = await stripeApp();
  for (const n of [1, 2, 3]) await hook('checkout.session.completed', paid({ id: 'cs_h' + n, payment_intent: 'pi_h' + n }));
  const before = (await summary()).credits; assert.equal(before, 150);
  await hook('charge.dispute.created', { id: 'dp_h1', payment_intent: 'pi_h1', amount: 4808, currency: 'usd', status: 'needs_response' }); assert.equal((await summary()).credits, before - 50); // 96% of $50 => all $50
  await hook('charge.dispute.created', { id: 'dp_h2', payment_intent: 'pi_h2', amount: 1000, currency: 'usd', status: 'needs_response' }); assert.equal((await summary()).credits, before - 60); // clearly partial => its own $10
  await hook('charge.dispute.created', { id: 'dp_h3', payment_intent: 'pi_h3', amount: 400000, currency: 'inr', status: 'needs_response' }); assert.equal((await summary()).credits, before - 110); // another currency cannot be compared => all $50
  for (const n of [1, 2, 3]) await hook('charge.dispute.closed', { id: 'dp_h' + n, payment_intent: 'pi_h' + n, amount: 1, currency: 'usd', status: 'won' });
  assert.equal((await summary()).credits, before); // released exactly what was held, whatever Stripe reports when closing
  await t.stop();
});

test('out-of-order Stripe delivery: a dispute or refund that arrives BEFORE the payment is known is parked and applied once it is (found by the real Stripe sandbox)', async () => {
  const { t, hook, summary, paid } = await stripeApp();
  // dispute opened and a refund arrive first (same second as the payment in real life)...
  await hook('charge.dispute.created', { id: 'dp_early', payment_intent: 'pi_early', amount: 5000, reason: 'fraudulent', status: 'needs_response' });
  await hook('charge.refunded', { id: 'ch_early', payment_intent: 'pi_early', amount_refunded: 1000 });
  assert.equal((await summary()).credits, 0); assert.equal((await t.app.repo.allDisputes()).length, 0); // nothing can be booked yet
  // ...then the payment itself: everything parked is replayed, in order, exactly once
  await hook('checkout.session.completed', paid({ id: 'cs_early', payment_intent: 'pi_early' }));
  const s = await summary(); assert.equal(s.credits, 50 - 50 - 10); // paid, minus the held dispute, minus the refund
  assert.equal((await t.app.repo.allDisputes()).length, 1);
  assert.equal((await t.app.repo.paymentByIntent('pi_early')).status, 'disputed');
  await hook('checkout.session.completed', paid({ id: 'cs_early', payment_intent: 'pi_early' })); assert.equal((await summary()).credits, -10); // a repeated delivery changes nothing
  assert.equal((await t.app.repo.takeDeferredEvents('pi_early')).length, 0); // nothing left parked
  await t.stop();
});

test('admin refunds in test mode: reason and amount are validated, spent money cannot be refunded, a payment is refunded at most once', async () => {
  const t = await boot({ paymentsMode: 'test' });
  const adv = await t.signup('adv@x.io', 'advertiser'), admin = await t.makeAdmin(), pub = await t.signup('p@x.io', 'publisher');
  assert.equal((await t.call('/api/billing/topup', 'POST', { amountUsd: 50 }, adv)).status, 200);
  const pays = (await t.call('/api/admin/payments', 'GET', null, admin)).body; assert.equal(pays.length, 1); assert.equal(pays[0].status, 'paid'); assert.equal(pays[0].refundableUsd, 50);
  const refund = (b, who = admin) => t.call('/api/admin/payments/refund', 'POST', { paymentId: pays[0].id, ...b }, who);
  assert.equal((await refund({ reason: 'x' }, adv)).status, 403);
  assert.equal((await refund({})).status, 400); // a reason is required
  assert.equal((await refund({ reason: 'dup', amountUsd: 80 })).body.error, 'invalid_amount');
  assert.equal((await refund({ reason: 'dup', amountUsd: 0 })).status, 400);
  assert.equal((await t.call('/api/admin/payments/refund', 'POST', { paymentId: 'nope', reason: 'x' }, admin)).status, 404);
  // $40 of the $50 is committed to a campaign: only $10 is free to hand back
  await t.call('/api/campaigns', 'POST', camp({ budget: 40 }), adv);
  const tooMuch = await refund({ reason: 'dup', amountUsd: 20 }); assert.equal(tooMuch.status, 409); assert.equal(tooMuch.body.error, 'exceeds_available'); assert.equal(tooMuch.body.availableUsd, 10);
  const ok = await refund({ reason: 'customer asked', amountUsd: 10 }); assert.equal(ok.status, 200);
  let s = (await t.call('/api/billing/summary', 'GET', null, adv)).body; assert.equal(s.credits, 40); assert.equal(s.available, 0);
  assert.equal((await t.app.repo.payment(pays[0].id)).status, 'partially_refunded');
  assert.equal((await refund({ reason: 'again', amountUsd: 1 })).body.error, 'exceeds_available'); // nothing free now
  assert.equal((await t.call('/api/admin/audit?limit=20', 'GET', null, admin)).body.some((a) => a.action === 'payment_refunded'), true);
  await t.stop(); void pub;
});

test('admin refunds in Stripe mode: Stripe is asked (with an idempotency key), the wallet changes only when Stripe confirms, Stripe errors surface as 502', async () => {
  const seen = []; let fail = false;
  const stub = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { seen.push({ url: req.url, body: new URLSearchParams(b), idem: req.headers['idempotency-key'], auth: req.headers.authorization });
    res.writeHead(fail ? 400 : 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(fail ? { error: { code: 'charge_already_refunded', message: 'Charge ch_1 has already been refunded.' } } : { id: 're_1', status: 'succeeded', amount: Number(new URLSearchParams(b).get('amount')) })); }); });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const { t, admin, hook, summary, paid, me } = await stripeApp({ stripeApiBase: `http://127.0.0.1:${stub.address().port}` });
  await hook('checkout.session.completed', paid({ id: 'cs_s', payment_intent: 'pi_s' }));
  const pay = await t.app.repo.paymentByIntent('pi_s');
  const r = await t.call('/api/admin/payments/refund', 'POST', { paymentId: pay.id, amountUsd: 20, reason: 'duplicate order' }, admin);
  assert.equal(r.status, 202); assert.equal(r.body.refundId, 're_1');
  assert.equal(seen[0].url, '/v1/refunds'); assert.equal(seen[0].body.get('payment_intent'), 'pi_s'); assert.equal(seen[0].body.get('amount'), '2000'); assert.equal(seen[0].body.get('reason'), 'requested_by_customer');
  assert.equal(seen[0].body.get('metadata[payment_id]'), pay.id); assert.match(seen[0].idem, /^refund-/); assert.equal(seen[0].auth, 'Bearer sk_test_x');
  assert.equal((await summary()).credits, 50); // not debited yet: Stripe has not confirmed
  await hook('charge.refunded', { id: 'ch_1', payment_intent: 'pi_s', amount_refunded: 2000 });
  assert.equal((await summary()).credits, 30);
  fail = true;
  const bad = await t.call('/api/admin/payments/refund', 'POST', { paymentId: pay.id, amountUsd: 5, reason: 'try' }, admin); assert.equal(bad.status, 502); assert.match(bad.body.detail, /already been refunded/);
  await t.app.repo.createPayment({ id: 'pmt_nointent', userId: me.id, provider: 'stripe', sessionId: 'cs_n', amountMicros: 10_000_000, status: 'paid' });
  assert.equal((await t.call('/api/admin/payments/refund', 'POST', { paymentId: 'pmt_nointent', reason: 'x' }, admin)).body.error, 'no_payment_intent');
  await t.stop(); stub.close();
});

test('parseStripeEvent understands the events we handle and ignores the rest', () => {
  assert.equal(parseStripeEvent({ type: 'customer.created', data: { object: {} } }), null);
  assert.equal(parseStripeEvent({ type: 'charge.refunded', data: { object: { id: 'ch' } } }), null); // no payment intent: not ours
  assert.deepEqual(parseStripeEvent({ type: 'charge.refunded', data: { object: { id: 'ch', payment_intent: 'pi', amount_refunded: 700 } } }), { kind: 'refunded', paymentIntent: 'pi', chargeId: 'ch', refundedCents: 700 });
  assert.equal(parseStripeEvent({ type: 'checkout.session.completed', data: { object: { id: 'cs', payment_status: 'unpaid', amount_total: 100, currency: 'usd', metadata: { user_id: 'u' } } } }), null);
  assert.equal(parseStripeEvent({ type: 'checkout.session.async_payment_succeeded', data: { object: { id: 'cs', payment_status: 'paid', amount_total: 100, currency: 'usd', metadata: { user_id: 'u' }, payment_intent: { id: 'pi_x' } } } }).paymentIntent, 'pi_x');
  assert.equal(parseStripeEvent({ type: 'payment_intent.payment_failed', data: { object: { id: 'pi', amount: 1234, metadata: { user_id: 'u' }, last_payment_error: { message: 'No funds' } } } }).amountMicros, 12_340_000);
});

test('tax: rates per country, reverse charge, inclusive split that always adds up, validated billing details and configuration', () => {
  const cfg = { taxMode: 'inclusive', taxLabel: 'VAT', taxRates: { GB: 20, IN: 18, DEFAULT: 0 }, taxReverseCharge: true, taxSeller: { country: 'GB' } };
  assert.deepEqual(taxFor({ taxMode: 'none' }, { country: 'GB' }), { rateBp: 0, label: null, note: null });
  assert.equal(taxFor(cfg, { country: 'GB' }).rateBp, 2000); assert.equal(taxFor(cfg, { country: 'in' }).rateBp, 1800); assert.equal(taxFor(cfg, { country: 'US' }).rateBp, 0);
  assert.match(taxFor(cfg, { country: 'US' }).note, /No VAT/);
  const rc = taxFor(cfg, { country: 'DE', taxId: 'DE123456789' }); assert.equal(rc.rateBp, 0); assert.match(rc.note, /Reverse charge/);
  assert.equal(taxFor(cfg, { country: 'GB', taxId: 'GB1234567' }).rateBp, 2000); // same country as the seller: no reverse charge
  assert.equal(taxFor({ ...cfg, taxReverseCharge: false }, { country: 'DE', taxId: 'DE1' }).rateBp, 0);
  for (const gross of [1, 999_999, 20_000_000, 33_333_333, 123_456_789]) for (const bp of [0, 500, 1800, 2000]) { const { netMicros, taxMicros } = splitInclusive(gross, bp); assert.equal(netMicros + taxMicros, gross); assert.ok(taxMicros >= 0 && netMicros >= 0); }
  assert.deepEqual(splitInclusive(20_000_000, 2000), { netMicros: 16_666_667, taxMicros: 3_333_333 });
  assert.ok(sanitizeProfile({ legalName: 'A Ltd', address: '1 High Street, London', country: 'gb', taxId: 'GB 123 4567' }).errors.length === 0);
  assert.ok(sanitizeProfile({}).errors.length >= 3); assert.ok(sanitizeProfile({ legalName: 'A', address: '1 High Street', country: 'GBR' }).errors.some((e) => /country/.test(e)));
  assert.ok(sanitizeProfile({ legalName: 'A', address: '1 High Street', country: 'GB', taxId: '<script>' }).errors.some((e) => /taxId/.test(e)));
  const seller = { TAX_SELLER_NAME: 'MobiAd Ltd', TAX_SELLER_ADDRESS: '1 High Street, London', TAX_SELLER_COUNTRY: 'GB', TAX_SELLER_ID: 'GB123456789' };
  assert.throws(() => loadConfig({ TAX_MODE: 'inclusive' }), /TAX_SELLER_NAME/);
  assert.throws(() => loadConfig({ TAX_MODE: 'exclusive', ...seller }), /TAX_MODE must be/);
  assert.throws(() => loadConfig({ TAX_RATES_JSON: '{"GB":"20"}' }), /TAX_RATES_JSON/);
  assert.throws(() => loadConfig({ TAX_RATES_JSON: '{"GB":120}' }), /TAX_RATES_JSON/);
  assert.throws(() => loadConfig({ TAX_RATES_JSON: 'nope' }), /TAX_RATES_JSON/);
  const ok = loadConfig({ TAX_MODE: 'inclusive', TAX_RATES_JSON: '{"GB":20,"DEFAULT":0}', ...seller }); assert.equal(ok.taxRates.GB, 20); assert.equal(ok.taxLabel, 'VAT');
});

test('tax invoices: need billing details, show seller, buyer, net, tax and total, keep a frozen copy, and credit notes reverse the same tax', async () => {
  const taxCfg = { taxMode: 'inclusive', taxLabel: 'VAT', taxRates: { GB: 20, DEFAULT: 0 }, taxReverseCharge: true, taxSeller: { name: 'MobiAd Ltd', address: '1 High Street, London', country: 'GB', taxId: 'GB123456789' } };
  const t = await boot(taxCfg);
  const adv = await t.signup('adv@x.io', 'advertiser'), pub = await t.signup('pub@x.io', 'publisher'), us = await t.signup('us@x.io', 'advertiser'), de = await t.signup('de@x.io', 'advertiser'), admin = await t.makeAdmin();
  const a = (await t.call('/api/apps', 'POST', { name: 'A', floorEcpm: 5000 }, pub)).body;
  // each advertiser targets its own country, so every one of them gets spend to invoice
  for (const [who, country] of [[adv, 'GB'], [us, 'US'], [de, 'DE']]) await t.call('/api/campaigns', 'POST', camp({ name: 'C', bid: 6000, budget: 1000, countries: [country] }), who);
  for (const country of ['GB', 'US', 'DE']) for (let i = 0; i < 4; i++) { const r = await t.call('/v1/ad', 'POST', { appId: a.id, country }); assert.equal(r.status, 200); await t.call(t.path(r.body.impressionUrl)); }
  await settle(t.app);
  const now = new Date(), lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  await t.app.repo.q('UPDATE ledger SET day=$1', [lastMonth + '-15']);
  const gen = (who) => t.call('/api/billing/invoices/generate', 'POST', { month: lastMonth }, who);
  const owners = {}; for (const [k, e] of [['adv', 'adv@x.io'], ['us', 'us@x.io'], ['de', 'de@x.io']]) owners[k] = await t.app.repo.userByEmail(e);
  const spend = async (who) => (await t.call('/api/billing/summary', 'GET', null, who)).body.spent;

  const need = await gen(adv); assert.equal(need.status, 409); assert.equal(need.body.error, 'billing_profile_required');
  assert.equal((await t.call('/api/billing/profile', 'POST', { legalName: 'Acme Ltd' }, adv)).status, 400);
  assert.equal((await t.call('/api/billing/profile', 'POST', { legalName: 'Acme Ltd', address: '5 Market Street, Leeds', country: 'gb', taxId: 'GB 987 6543' }, pub)).status, 403); // advertisers only
  assert.equal((await t.call('/api/billing/profile', 'POST', { legalName: 'Acme Ltd', address: '5 Market Street, Leeds', country: 'gb', taxId: 'GB 987 6543' }, adv)).status, 200);
  assert.equal((await t.call('/api/billing/profile', 'GET', null, adv)).body.country, 'GB');

  const g = await gen(adv); assert.equal(g.status, 201); const total = g.body.total; assert.ok(total > 0);
  assert.equal(g.body.taxInvoice, true); assert.equal(g.body.taxRate, 20); assert.equal(g.body.taxLabel, 'VAT');
  assert.ok(Math.abs(g.body.tax - total / 6) < 1e-5, `tax ${g.body.tax} of ${total}`); assert.ok(Math.abs(g.body.subtotal + g.body.tax - total) < 1e-9);
  assert.equal(g.body.seller.name, 'MobiAd Ltd'); assert.equal(g.body.buyer.legalName, 'Acme Ltd'); assert.equal(g.body.buyer.country, 'GB'); assert.equal(g.body.pricesIncludeTax, true);
  await t.call('/api/billing/profile', 'POST', { legalName: 'Renamed Ltd', address: '9 Other Road, York', country: 'GB' }, adv); // later changes must not rewrite an issued invoice
  const again = (await t.call(`/api/billing/invoice?id=${g.body.id}`, 'GET', null, adv)).body; assert.equal(again.buyer.legalName, 'Acme Ltd');
  const csv = await t.call(`/api/billing/invoice?id=${g.body.id}&format=csv`, 'GET', null, adv); assert.match(csv.text, /Net amount/); assert.match(csv.text, /VAT 20%/); assert.match(csv.text, /Total paid/);

  await t.call('/api/billing/profile', 'POST', { legalName: 'Stars Inc', address: '1 Main St, Austin TX', country: 'US' }, us);
  const gu = await gen(us); assert.equal(gu.status, 201); assert.equal(gu.body.tax, 0); assert.equal(gu.body.taxRate, 0); assert.match(gu.body.taxNote, /No VAT/);
  await t.call('/api/billing/profile', 'POST', { legalName: 'Freunde GmbH', address: 'Hauptstrasse 1, Berlin', country: 'DE', taxId: 'DE123456789' }, de);
  const gd = await gen(de); assert.equal(gd.body.tax, 0); assert.match(gd.body.taxNote, /Reverse charge/);

  // a credit note against the GB invoice reverses the same 20%; one without an invoice uses the buyer's current rate
  const cn = await t.call('/api/admin/credit-notes', 'POST', { userId: owners.adv.id, amountUsd: 6, reason: 'goodwill', invoiceId: g.body.id }, admin); assert.equal(cn.status, 201);
  const notes = (await t.call('/api/billing/credit-notes', 'GET', null, adv)).body; assert.equal(notes[0].taxRate, 20); assert.ok(Math.abs(notes[0].tax - 1) < 1e-6);
  void spend;
  await t.stop();
});

test('without tax mode, invoices keep their old shape and say there is no tax breakdown', async () => {
  const t = await boot();
  const adv = await t.signup('adv@x.io', 'advertiser'), pub = await t.signup('pub@x.io', 'publisher');
  await t.call('/api/campaigns', 'POST', camp({ bid: 6000, budget: 1000 }), adv);
  const a = (await t.call('/api/apps', 'POST', { name: 'A', floorEcpm: 5000 }, pub)).body;
  const r = await t.call('/v1/ad', 'POST', { appId: a.id }); await t.call(t.path(r.body.impressionUrl)); await settle(t.app);
  const now = new Date(), lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  await t.app.repo.q('UPDATE ledger SET day=$1', [lastMonth + '-15']);
  const g = await t.call('/api/billing/invoices/generate', 'POST', { month: lastMonth }, adv);
  assert.equal(g.status, 201); assert.equal(g.body.taxInvoice, false); assert.equal(g.body.tax, 0); assert.equal(g.body.seller, null); assert.match(g.body.taxNote, /No tax breakdown/);
  await t.stop();
});

test('dispute evidence: an admin sends evidence built from our records to Stripe once; closed or repeated submissions are refused', async () => {
  const calls = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { calls.push({ path: req.url, form: new URLSearchParams(b), auth: req.headers.authorization }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'dp_e1', status: 'under_review' })); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { t, admin, adv, me, hook, paid } = await stripeApp({ stripeApiBase: `http://127.0.0.1:${srv.address().port}` });
  await t.call('/api/billing/profile', 'POST', { legalName: 'Acme Ltd', address: '1 High St, London', country: 'GB' }, adv);
  await hook('checkout.session.completed', paid({ payment_intent: 'pi_e1' }));
  await hook('charge.dispute.created', { id: 'dp_e1', payment_intent: 'pi_e1', amount: 5000, reason: 'fraudulent', status: 'needs_response' });
  const send = (body, token = admin) => t.call('/api/admin/disputes/evidence', 'POST', { disputeId: 'dp_e1', ...body }, token);
  assert.equal((await send({ explanation: 'too short' })).status, 400);
  assert.equal((await send({ explanation: 'The customer created and ran campaigns after topping up.' }, adv)).status, 403);
  const list0 = (await t.call('/api/admin/disputes', 'GET', null, admin)).body; assert.equal(list0[0].canRespond, true); assert.equal(list0[0].evidence, null);
  const ok = await send({ explanation: 'The customer created and ran campaigns after topping up.' }); assert.equal(ok.status, 200); assert.equal(ok.body.evidence, 'submitted');
  const c = calls.find((x) => x.path === '/v1/disputes/dp_e1');
  assert.equal(c.auth, 'Bearer sk_test_x'); assert.equal(c.form.get('submit'), 'true'); assert.equal(c.form.get('evidence[customer_email_address]'), 'adv@x.io'); assert.equal(c.form.get('evidence[customer_name]'), 'Acme Ltd');
  assert.match(c.form.get('evidence[access_activity_log]'), /topped up 50 USD/); assert.match(c.form.get('evidence[uncategorized_text]'), /ran campaigns/);
  assert.equal((await send({ explanation: 'The customer created and ran campaigns after topping up.' })).status, 409); // Stripe accepts evidence only once
  assert.equal((await t.call('/api/admin/disputes', 'GET', null, admin)).body[0].evidence, 'submitted');
  const audit = (await t.call('/api/admin/audit?limit=50', 'GET', null, admin)).body; assert.ok(audit.some((a) => a.action === 'dispute_evidence'));
  await hook('charge.dispute.closed', { id: 'dp_e1', payment_intent: 'pi_e1', amount: 5000, status: 'won' });
  assert.equal((await send({ explanation: 'The customer created and ran campaigns after topping up.' })).status, 409); // closed
  await t.stop(); srv.close();
});
