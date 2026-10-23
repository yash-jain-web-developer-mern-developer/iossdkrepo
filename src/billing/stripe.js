// Stripe Checkout integration with no SDK dependency: create a Checkout Session and verify webhook signatures.
// NOTE: signature verification is unit-tested against Stripe's documented scheme; the live API calls cannot be tested
// without real credentials and must be verified in Stripe test mode before launch.
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

export const usdToMicros = (usd) => Math.round(Number(usd) * 1e6);
export const microsToUsd = (m) => m / 1e6;

// Stripe-Signature: t=<unix>,v1=<hex hmac sha256 of `${t}.${rawBody}`>[,v1=...]
export function verifyStripeSignature(rawBody, header, secret, { toleranceSec = 300, now = Date.now() } = {}) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(String(header).split(',').map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()]; }));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > toleranceSec) return false; // replay protection
  const expected = createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest();
  const candidates = String(header).split(',').map((s) => s.trim()).filter((s) => s.startsWith('v1=')).map((s) => s.slice(3));
  return candidates.some((c) => { try { const b = Buffer.from(c, 'hex'); return b.length === expected.length && timingSafeEqual(b, expected); } catch { return false; } });
}
export function signStripePayload(rawBody, secret, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')}`;
}

export async function createCheckoutSession({ secretKey, apiBase = 'https://api.stripe.com', userId, email, amountUsd, successUrl, cancelUrl, fetchImpl = fetch }) {
  const cents = Math.round(amountUsd * 100);
  const body = new URLSearchParams({
    mode: 'payment', 'success_url': successUrl, 'cancel_url': cancelUrl, 'client_reference_id': userId, 'customer_email': email,
    'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': String(cents),
    'line_items[0][price_data][product_data][name]': 'MobiAd advertising credit', 'metadata[user_id]': userId, 'metadata[amount_cents]': String(cents),
    // copied onto the PaymentIntent so a failed attempt, a refund or a dispute can be matched back to the advertiser
    'payment_intent_data[metadata][user_id]': userId, 'payment_intent_data[description]': 'MobiAd advertising credit',
    // pay exactly what was asked, in USD: with local-currency pricing the buyer pays a conversion fee and refund/dispute amounts stop matching the credit
    'adaptive_pricing[enabled]': 'false',
    // cards (including Apple Pay and Link, which are card-based): refunds, disputes and instant confirmation are all tested for these
    'payment_method_types[0]': 'card',
  });
  const r = await fetchImpl(`${apiBase}/v1/checkout/sessions`, {
    method: 'POST', body,
    headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': `topup-${userId}-${cents}-${Date.now()}` },
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`stripe error: ${j?.error?.message || r.status}`);
  return { id: j.id, url: j.url };
}

// Refund (part of) a payment. Stripe reports the result through the charge.refunded webhook, which is what debits the wallet.
// Idempotency-Key makes a double click or a retry create one refund only.
export async function createRefund({ secretKey, apiBase = 'https://api.stripe.com', paymentIntent, amountCents, reason = 'requested_by_customer', idempotencyKey, metadata = {}, fetchImpl = fetch }) {
  const body = new URLSearchParams({ payment_intent: paymentIntent, amount: String(amountCents), reason });
  for (const [k, v] of Object.entries(metadata)) body.set(`metadata[${k}]`, String(v));
  const r = await fetchImpl(`${apiBase}/v1/refunds`, { method: 'POST', body, headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) } });
  const j = await r.json();
  if (!r.ok) { const e = new Error(`stripe error: ${j?.error?.message || r.status}`); e.code = j?.error?.code || 'stripe_error'; throw e; }
  return { id: j.id, status: j.status, amountCents: j.amount };
}

// ---- Stripe Connect (Express accounts): Stripe verifies the publisher's identity and tax details and pays them out ----
async function stripeCall({ secretKey, apiBase = 'https://api.stripe.com', path, form = null, method = 'POST', idempotencyKey, fetchImpl = fetch }) {
  const r = await fetchImpl(`${apiBase}${path}`, { method, ...(form ? { body: new URLSearchParams(form) } : {}), headers: { Authorization: `Bearer ${secretKey}`, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`stripe error: ${j?.error?.message || r.status}`); e.code = j?.error?.code || 'stripe_error'; e.status = r.status; throw e; }
  return j;
}
// Express account for a publisher. Which capabilities Stripe accepts depends on where the publisher is relative to YOUR Stripe account:
// same country -> transfers only; elsewhere -> try the cross-border "recipient" agreement, then the full agreement (card_payments + transfers).
export async function createConnectAccount(o) {
  const base = { type: 'express', ...(o.country ? { country: o.country } : {}), ...(o.email ? { email: o.email } : {}), 'metadata[user_id]': o.userId };
  const same = !o.country || !o.platformCountry || o.country === o.platformCountry;
  const variants = same ? [['', { 'capabilities[transfers][requested]': 'true' }]]
    : [['-r', { 'capabilities[transfers][requested]': 'true', 'tos_acceptance[service_agreement]': 'recipient' }], ['-f', { 'capabilities[transfers][requested]': 'true', 'capabilities[card_payments][requested]': 'true' }]];
  let last;
  for (const [suffix, extra] of variants) {
    try { return await stripeCall({ ...o, path: '/v1/accounts', idempotencyKey: `acct-${o.userId}${suffix}`, form: { ...base, ...extra } }); }
    catch (e) { last = e; if (!/recipient|service agreement|card_payments/i.test(e.message)) throw e; }
  }
  throw last;
}
export const createAccountLink = (o) => stripeCall({ ...o, path: '/v1/account_links', form: { account: o.account, refresh_url: o.refreshUrl, return_url: o.returnUrl, type: 'account_onboarding' } });
export const retrieveAccount = (o) => stripeCall({ ...o, path: `/v1/accounts/${encodeURIComponent(o.account)}`, method: 'GET' });
// Move money from the platform's Stripe balance to the publisher's connected account. Idempotent per payout.
export const createTransfer = (o) => stripeCall({ ...o, path: '/v1/transfers', idempotencyKey: `payout-${o.payoutId}`,
  form: { amount: String(o.amountCents), currency: 'usd', destination: o.account, transfer_group: o.payoutId, description: 'MobiAd publisher payout', 'metadata[payout_id]': o.payoutId } });
// Dispute evidence (text fields only). submit=false saves a draft at Stripe; submit=true sends it to the card issuer, once: Stripe accepts no changes afterwards.
export const EVIDENCE_FIELDS = ['product_description', 'customer_name', 'customer_email_address', 'billing_address', 'service_date', 'access_activity_log', 'refund_policy_disclosure', 'uncategorized_text'];
export const submitDisputeEvidence = (o) => {
  const form = {}; for (const k of EVIDENCE_FIELDS) if (o.evidence?.[k]) form[`evidence[${k}]`] = String(o.evidence[k]).slice(0, 19000);
  if (o.submit) form.submit = 'true';
  return stripeCall({ ...o, path: `/v1/disputes/${encodeURIComponent(o.disputeId)}`, form, idempotencyKey: `dispute-evidence-${o.disputeId}-${createHash('sha256').update(JSON.stringify(form)).digest('hex').slice(0, 16)}` });
};
// What Stripe still needs from the publisher, in plain words.
export const requirementsDue = (acct) => [...new Set([...(acct?.requirements?.currently_due || []), ...(acct?.requirements?.past_due || [])])].map((r) => r.replace(/\./g, ' ').replace(/_/g, ' ')).slice(0, 12);

const piId = (v) => (typeof v === 'string' ? v : v?.id || null);

// Normalises the Stripe events we care about. Returns null for everything else (callers answer 200 so Stripe stops retrying).
//   paid | failed | expired | refunded | dispute_created | dispute_closed
export function parseStripeEvent(event) {
  const o = event?.data?.object; if (!o || typeof o !== 'object') return null;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const p = parseCheckoutCompleted({ type: 'checkout.session.completed', data: { object: o } }); // paid sessions in USD only
      return p ? { kind: 'paid', userId: p.userId, amountMicros: p.amountMicros, sessionId: p.ref, paymentIntent: piId(o.payment_intent) } : null;
    }
    case 'checkout.session.async_payment_failed': return { kind: 'failed', sessionId: o.id, userId: o.metadata?.user_id || o.client_reference_id || null, message: 'The delayed payment method failed.' };
    case 'checkout.session.expired': return { kind: 'expired', sessionId: o.id, userId: o.metadata?.user_id || o.client_reference_id || null };
    case 'payment_intent.payment_failed': return { kind: 'failed', paymentIntent: o.id, userId: o.metadata?.user_id || null, amountMicros: Number.isInteger(o.amount) && o.amount > 0 ? o.amount * 10_000 : null, message: String(o.last_payment_error?.message || 'The payment failed.').slice(0, 300), code: o.last_payment_error?.decline_code || o.last_payment_error?.code || null };
    case 'charge.refunded': return o.payment_intent ? { kind: 'refunded', paymentIntent: piId(o.payment_intent), chargeId: o.id, refundedCents: Number(o.amount_refunded) } : null;
    case 'charge.dispute.created': return o.payment_intent ? { kind: 'dispute_created', disputeId: o.id, paymentIntent: piId(o.payment_intent), amountCents: Number(o.amount), currency: o.currency, reason: o.reason || null, status: o.status || 'needs_response' } : null;
    case 'charge.dispute.closed': return o.payment_intent ? { kind: 'dispute_closed', disputeId: o.id, paymentIntent: piId(o.payment_intent), amountCents: Number(o.amount), currency: o.currency, status: o.status } : null;
    case 'account.updated': return o.id ? { kind: 'account_updated', account: o.id, detailsSubmitted: !!o.details_submitted, payoutsEnabled: !!o.payouts_enabled, chargesEnabled: !!o.charges_enabled, requirements: requirementsDue(o) } : null;
    case 'transfer.reversed': return { kind: 'transfer_reversed', transferId: o.id, payoutId: o.metadata?.payout_id || null, amountCents: Number(o.amount_reversed || o.amount) };
    default: return null;
  }
}

// Returns { userId, amountMicros, ref } for a completed, paid Checkout Session event, otherwise null.
export function parseCheckoutCompleted(event) {
  if (event?.type !== 'checkout.session.completed') return null;
  const s = event.data?.object;
  if (!s || s.payment_status !== 'paid') return null; // async payment methods complete later via another event
  const userId = s.metadata?.user_id || s.client_reference_id;
  const cents = Number(s.amount_total);
  if (!userId || !Number.isInteger(cents) || cents <= 0 || s.currency !== 'usd') return null;
  return { userId, amountMicros: cents * 10_000, ref: s.id };
}
