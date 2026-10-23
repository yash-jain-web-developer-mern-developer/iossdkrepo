import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { verifyStripeSignature, signStripePayload, createCheckoutSession, parseCheckoutCompleted, usdToMicros } from '../src/billing/stripe.js';

const secret = 'whsec_test_secret';
const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });

test('webhook signature: valid, tampered body, wrong secret, expired, malformed, multiple v1', () => {
  const now = Date.now(), t = Math.floor(now / 1000), h = signStripePayload(body, secret, t);
  assert.equal(verifyStripeSignature(body, h, secret, { now }), true);
  assert.equal(verifyStripeSignature(body + ' ', h, secret, { now }), false);
  assert.equal(verifyStripeSignature(body, h, 'other', { now }), false);
  assert.equal(verifyStripeSignature(body, signStripePayload(body, secret, t - 3600), secret, { now }), false); // replayed old event
  assert.equal(verifyStripeSignature(body, signStripePayload(body, secret, t + 3600), secret, { now }), false); // from the future
  for (const bad of ['', 'garbage', 't=abc,v1=zz', `t=${t}`, `t=${t},v1=`, undefined]) assert.equal(verifyStripeSignature(body, bad, secret, { now }), false);
  assert.equal(verifyStripeSignature(body, `${h},v1=deadbeef`, secret, { now }), true); // key rotation: any matching v1 counts
  assert.equal(verifyStripeSignature(body, h, '', { now }), false);
});

test('parseCheckoutCompleted: only paid USD sessions with a user are credited', () => {
  const ev = (o = {}) => ({ type: 'checkout.session.completed', data: { object: { id: 'cs_1', payment_status: 'paid', amount_total: 2500, currency: 'usd', metadata: { user_id: 'usr_1' }, ...o } } });
  assert.deepEqual(parseCheckoutCompleted(ev()), { userId: 'usr_1', amountMicros: 25_000_000, ref: 'cs_1' });
  assert.equal(parseCheckoutCompleted(ev({ payment_status: 'unpaid' })), null);
  assert.equal(parseCheckoutCompleted(ev({ currency: 'eur' })), null);
  assert.equal(parseCheckoutCompleted(ev({ amount_total: -5 })), null);
  assert.equal(parseCheckoutCompleted(ev({ amount_total: 10.5 })), null);
  assert.equal(parseCheckoutCompleted(ev({ metadata: {} })), null);
  assert.equal(parseCheckoutCompleted({ type: 'charge.refunded', data: { object: {} } }), null);
  assert.equal(parseCheckoutCompleted(null), null);
  assert.equal(usdToMicros(12.34), 12_340_000);
});

test('createCheckoutSession sends the documented request and returns the hosted URL (against a mock Stripe)', async () => {
  let seen;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => { seen = { method: req.method, url: req.url, auth: req.headers.authorization, ct: req.headers['content-type'], idem: req.headers['idempotency-key'], form: new URLSearchParams(b) };
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.test/pay/cs_test_1' })); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const apiBase = `http://127.0.0.1:${srv.address().port}`;
  const s = await createCheckoutSession({ secretKey: 'sk_test_x', apiBase, userId: 'usr_9', email: 'a@x.io', amountUsd: 50, successUrl: 'https://x/ok', cancelUrl: 'https://x/no' });
  assert.deepEqual(s, { id: 'cs_test_1', url: 'https://checkout.stripe.test/pay/cs_test_1' });
  assert.equal(seen.method, 'POST'); assert.equal(seen.url, '/v1/checkout/sessions');
  assert.equal(seen.auth, 'Bearer sk_test_x'); assert.match(seen.ct, /x-www-form-urlencoded/); assert.ok(seen.idem);
  assert.equal(seen.form.get('line_items[0][price_data][unit_amount]'), '5000');
  assert.equal(seen.form.get('line_items[0][price_data][currency]'), 'usd');
  assert.equal(seen.form.get('metadata[user_id]'), 'usr_9');
  assert.equal(seen.form.get('mode'), 'payment');
  srv.closeAllConnections(); srv.close();
});

test('createCheckoutSession surfaces provider errors', async () => {
  const srv = http.createServer((req, res) => { res.writeHead(402, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Your account cannot currently make live charges.' } })); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  await assert.rejects(createCheckoutSession({ secretKey: 'sk', apiBase: `http://127.0.0.1:${srv.address().port}`, userId: 'u', email: 'e@x.io', amountUsd: 5, successUrl: 'https://a', cancelUrl: 'https://b' }), /cannot currently make live charges/);
  srv.closeAllConnections(); srv.close();
});
