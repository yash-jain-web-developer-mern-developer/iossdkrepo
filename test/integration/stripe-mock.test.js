// Opt-in: Stripe code against Stripe's OFFICIAL stripe-mock server (it validates every request against Stripe's OpenAPI spec).
//   docker run -d -p 12111:12111 stripe/stripe-mock   then   STRIPE_MOCK_URL=http://localhost:12111 npm run test:integration
// This is stronger than the hand-written mock in test/stripe.test.js, but it is still NOT the live API: run Stripe test mode before launch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, PW } from '../lib/helpers.js';
import { createCheckoutSession, signStripePayload, parseCheckoutCompleted, createRefund, createConnectAccount, createAccountLink, retrieveAccount, createTransfer, submitDisputeEvidence, parseStripeEvent } from '../../src/billing/stripe.js';

const URL_ = process.env.STRIPE_MOCK_URL;
const skip = !URL_ && 'needs STRIPE_MOCK_URL (stripe-mock)';
const KEY = 'sk_test_mock';
// stripe-mock's bundled spec has no payment_method_types on Checkout Sessions, although live Stripe accepts it (verified in the sandbox).
// For calls to the mock only, drop that one field so the REST of the request is still validated.
const realFetch = globalThis.fetch;
if (URL_) globalThis.fetch = (u, o = {}) => { if (String(u).startsWith(URL_) && o.body instanceof URLSearchParams) { const b = new URLSearchParams(o.body); b.delete('payment_method_types[0]'); o = { ...o, body: b }; } return realFetch(u, o); };

test('stripe-mock: the Checkout Session request we send is accepted by Stripe\'s own spec validator (and a bad one is not)', { skip }, async () => {
  const s = await createCheckoutSession({ secretKey: KEY, apiBase: URL_, userId: 'usr_1', email: 'a@b.co', amountUsd: 25, successUrl: 'https://ads.example.com/app#topup=success', cancelUrl: 'https://ads.example.com/app#topup=cancelled' });
  assert.match(s.id, /^cs_/); assert.ok(s.url);
  // negative control: the mock really validates (an unknown parameter is rejected), so the pass above means something
  const bad = await fetch(`${URL_}/v1/checkout/sessions`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ mode: 'payment', not_a_real_param: 'x' }) });
  assert.equal(bad.status, 400);
  const noAuth = await fetch(`${URL_}/v1/checkout/sessions`, { method: 'POST', body: new URLSearchParams({ mode: 'payment' }) });
  assert.equal(noAuth.status, 401);
});

test('stripe-mock: refund, Connect onboarding and payout requests are all accepted by Stripe\'s own spec validator', { skip }, async () => {
  const o = { secretKey: KEY, apiBase: URL_ };
  // a refund needs a payment intent: ask the mock for one
  const pi = await (await fetch(`${URL_}/v1/payment_intents/pi_123`, { headers: { Authorization: `Bearer ${KEY}` } })).json();
  const r = await createRefund({ ...o, paymentIntent: pi.id, amountCents: 1000, reason: 'requested_by_customer', idempotencyKey: 'refund-test-1', metadata: { payment_id: 'pmt_1', admin: 'usr_admin' } });
  assert.match(r.id, /^re_/);
  // Connect: Express account, onboarding link, readiness, transfer
  const a = await createConnectAccount({ ...o, userId: 'usr_pub1', email: 'dev@studio.io', country: 'US' }); assert.match(a.id, /^acct_/);
  const l = await createAccountLink({ ...o, account: a.id, refreshUrl: 'https://ads.example.com/app#connect=refresh', returnUrl: 'https://ads.example.com/app#connect=return' }); assert.ok(l.url);
  const got = await retrieveAccount({ ...o, account: a.id }); assert.ok(got.id);
  const tr = await createTransfer({ ...o, account: a.id, payoutId: 'pay_1', amountCents: 1234 }); assert.match(tr.id, /^tr_/); assert.equal(tr.amount, 1234);
  // dispute evidence: every field we send is a real evidence field in Stripe's spec
  const ev = await submitDisputeEvidence({ ...o, disputeId: 'dp_123', submit: true, evidence: { product_description: 'Prepaid advertising credit', customer_name: 'Acme Ltd', customer_email_address: 'a@b.co', billing_address: '1 High St', service_date: '2026-10-01', access_activity_log: 'log', refund_policy_disclosure: 'policy', uncategorized_text: 'explanation' } });
  assert.match(ev.id, /^dp_/);
  // negative control: the mock is really validating (an invalid transfer is refused)
  const bad = await fetch(`${URL_}/v1/transfers`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ amount: '100', currency: 'usd', destination: a.id, bogus_field: 'x' }) });
  assert.equal(bad.status, 400);
  // and the real object shapes parse into the events we handle
  const acct = parseStripeEvent({ type: 'account.updated', data: { object: got } }); assert.equal(acct.kind, 'account_updated'); assert.equal(acct.account, got.id);
});

test('stripe-mock: full top-up flow: app -> Checkout Session on the mock -> signed webhook built from the mock\'s real object shape -> wallet credited once', { skip }, async () => {
  const secret = 'whsec_test_secret';
  const t = await boot({ paymentsMode: 'stripe', stripeSecretKey: KEY, stripeWebhookSecret: secret, stripeApiBase: URL_, requireEmailVerification: false });
  const adv = await t.signup('adv@x.io', 'advertiser'), me = await t.app.repo.userByEmail('adv@x.io');
  const top = await t.call('/api/billing/topup', 'POST', { amountUsd: 40 }, adv);
  assert.equal(top.status, 200); assert.ok(top.body.checkoutUrl);

  // take the mock's own Checkout Session object (real field names/types) and make it a paid session for this user
  const obj = await (await fetch(`${URL_}/v1/checkout/sessions/cs_test_abc`, { headers: { Authorization: `Bearer ${KEY}` } })).json();
  const session = { ...obj, id: 'cs_test_paid_1', payment_status: 'paid', amount_total: 4000, currency: 'usd', client_reference_id: me.id, metadata: { user_id: me.id } };
  const event = { id: 'evt_1', object: 'event', type: 'checkout.session.completed', data: { object: session } };
  assert.deepEqual(parseCheckoutCompleted(event), { userId: me.id, amountMicros: 40_000_000, ref: 'cs_test_paid_1' });
  const body = JSON.stringify(event), hdr = { 'stripe-signature': signStripePayload(body, secret) };
  const post = () => t.call('/api/webhooks/stripe', 'POST', null, undefined, body, hdr);
  assert.equal((await post()).status, 200);
  assert.equal((await post()).status, 200); // Stripe retries: must not credit twice
  assert.equal((await t.call('/api/billing/summary', 'GET', null, adv)).body.credits, 40);
  assert.equal((await t.call('/api/webhooks/stripe', 'POST', null, undefined, body, { 'stripe-signature': 'bad' })).status, 400);
  // an unpaid session (e.g. async payment pending) must not credit
  const unpaid = JSON.stringify({ ...event, id: 'evt_2', data: { object: { ...session, id: 'cs_unpaid', payment_status: 'unpaid' } } });
  await t.call('/api/webhooks/stripe', 'POST', null, undefined, unpaid, { 'stripe-signature': signStripePayload(unpaid, secret) });
  assert.equal((await t.call('/api/billing/summary', 'GET', null, adv)).body.credits, 40);
  await t.stop();
});
