// Wallet top-ups, publisher payouts, statements, payment-provider webhook.
import { json, readJson, readRaw } from '../http.js';
import { id, toCsv, usdToMicros, microsToUsd, monthRe } from './util.js';
import { createCheckoutSession, createRefund, createConnectAccount, createAccountLink, retrieveAccount, createTransfer, submitDisputeEvidence, requirementsDue, verifyStripeSignature, parseStripeEvent } from '../billing/stripe.js';
import { sanitizeProfile } from '../billing/tax.js';

const usd = (m) => microsToUsd(m);
const presentPayment = (p) => ({ id: p.id, amount: usd(p.amount_micros), refunded: usd(p.refunded_micros), status: p.status, failure: p.failure || null, createdAt: p.created_at, updatedAt: p.updated_at });

export function billingRoutes(ctx) {
  const { repo, cfg, log } = ctx;

  // Tell the advertiser (webhook event + e-mail) about something that happened to their money.
  async function notify(userId, event, data, subject, text) {
    ctx.emit?.(userId, event, data);
    const user = await repo.userById(userId);
    if (user?.email && ctx.mailer?.send) ctx.mailer.send({ to: user.email, subject, text }).catch(() => {});
  }
  const fmt = (micros) => '$' + (micros / 1e6).toFixed(2);
  // How much of the wallet to hold for a dispute. What the issuer reports can differ from what we credited (currency conversion, fees),
  // so a dispute covering at least 90% of what is left of the payment holds ALL of it; a clearly partial dispute holds its own amount;
  // a dispute in another currency cannot be compared, so it holds all of it.
  const disputeHold = (pay, ev) => {
    const remaining = Math.max(0, pay.amount_micros - pay.refunded_micros), reported = Math.max(0, ev.amountCents) * 10_000;
    if (ev.currency && String(ev.currency).toLowerCase() !== 'usd') return remaining;
    return reported >= remaining * 0.9 ? remaining : reported;
  };

  // ---- automated payouts (Stripe Connect) ----
  const connectOn = () => cfg.payoutsMode === 'stripe_connect';
  const stripeOpts = () => ({ secretKey: cfg.stripeSecretKey, apiBase: cfg.stripeApiBase });
  const normalizeAccount = (a) => ({ detailsSubmitted: !!a.details_submitted, payoutsEnabled: !!a.payouts_enabled, chargesEnabled: !!a.charges_enabled, requirements: requirementsDue(a) });
  async function applyConnect(userId, s) {
    await repo.updateConnectAccount(userId, s);
    if (s.detailsSubmitted && s.payoutsEnabled) await repo.markVerifiedByProvider(userId, 'Identity and tax details verified by Stripe Connect');
  }
  // Pays an APPROVED payout by moving money to the publisher's connected account. Safe to call twice: the transfer is idempotent per payout.
  async function sendPayoutViaStripe(row, actor, req) {
    if (row.status !== 'approved') return { ok: false, status: 409, error: 'not_approved', detail: `This payout is ${row.status}; it must be approved first.` };
    const acct = await repo.connectAccount(row.user_id);
    if (!acct || !acct.payoutsEnabled) return { ok: false, status: 409, error: 'payout_account_not_ready', detail: 'The publisher has not finished Stripe onboarding yet.' };
    let t;
    try { t = await createTransfer({ ...stripeOpts(), account: acct.account, payoutId: row.id, amountCents: Math.round(row.amount_micros / 10_000) }); }
    catch (e) { log?.error('stripe transfer failed', { payout: row.id, msg: e.message }); return { ok: false, status: 502, error: 'stripe_error', detail: e.message }; }
    const done = await repo.transitionPayout(row.id, 'paid', { note: 'Paid via Stripe Connect', reference: t.id, by: actor });
    await ctx.audit(req, actor, 'payout_sent_stripe', row.id, { transfer: t.id, amountUsd: usd(row.amount_micros), auto: actor === 'system:auto' });
    if (done) ctx.emit?.(row.user_id, 'payout.paid', { payoutId: row.id, amountUsd: usd(row.amount_micros), reference: t.id });
    return { ok: true, transfer: t.id };
  }

  // One normalised Stripe event -> wallet and payment records. Everything here must be safe to run twice.
  async function handleStripeEvent(ev) {
    if (ev.kind === 'account_updated') { const row = await repo.connectByAccount(ev.account); if (row) await applyConnect(row.userId, ev); return; }
    if (ev.kind === 'transfer_reversed') { const p = ev.payoutId ? await repo.payout(ev.payoutId) : null; if (p) await ctx.audit(null, p.user_id, 'payout_transfer_reversed', p.id, { transfer: ev.transferId }); return; }
    if (ev.kind === 'paid') {
      const user = await repo.userById(ev.userId);
      if (!user || user.role !== 'advertiser') { log?.error('stripe credit for unknown user', { ref: ev.sessionId }); return; }
      let pay = await repo.paymentBySession(ev.sessionId);
      if (!pay) { await repo.createPayment({ id: id('pmt'), userId: ev.userId, provider: 'stripe', sessionId: ev.sessionId, paymentIntent: ev.paymentIntent, amountMicros: ev.amountMicros, status: 'paid' }); pay = await repo.paymentBySession(ev.sessionId); }
      const applied = await repo.addWalletEntry({ id: id('wal'), userId: ev.userId, kind: 'topup', amountMicros: ev.amountMicros, provider: 'stripe', providerRef: 'stripe:' + ev.sessionId, note: 'Stripe Checkout' });
      const patch = { amountMicros: ev.amountMicros }; if (ev.paymentIntent) patch.paymentIntent = ev.paymentIntent;
      if (['pending', 'failed', 'expired'].includes(pay.status)) { patch.status = 'paid'; patch.failure = null; } // a retry after a failed attempt succeeded
      await repo.updatePayment(pay.id, patch);
      if (applied) { ctx.emit?.(ev.userId, 'wallet.credited', { amountUsd: ev.amountMicros / 1e6, provider: 'stripe' }); await ctx.audit(null, ev.userId, 'wallet_topup', ev.sessionId, { amountUsd: usd(ev.amountMicros) }); }
      // events about this payment that arrived BEFORE we knew its PaymentIntent (Stripe's delivery order is not guaranteed)
      if (ev.paymentIntent) for (const early of await repo.takeDeferredEvents(ev.paymentIntent)) await handleStripeEvent(early);
      return;
    }
    // refunds and disputes need the payment; if it is not known yet, park the event instead of losing it
    const defer = async () => { if (ev.eventId && ev.paymentIntent) await repo.deferStripeEvent({ id: ev.eventId, paymentIntent: ev.paymentIntent, payload: ev }); };
    if (ev.kind === 'failed' || ev.kind === 'expired') {
      let pay = ev.sessionId ? await repo.paymentBySession(ev.sessionId) : await repo.paymentByIntent(ev.paymentIntent);
      if (!pay && ev.userId && ev.amountMicros) pay = await repo.pendingPaymentFor(ev.userId, ev.amountMicros); // a failed attempt: the intent is not stored until it succeeds
      if (!pay || !['pending', 'failed'].includes(pay.status)) return;
      if (ev.kind === 'expired') { await repo.updatePayment(pay.id, { status: 'expired' }); return; }
      const first = pay.status !== 'failed' || pay.failure !== ev.message;
      await repo.updatePayment(pay.id, { status: 'failed', failure: ev.message, ...(ev.paymentIntent ? { paymentIntent: ev.paymentIntent } : {}) });
      if (first) {
        await ctx.audit(null, pay.user_id, 'payment_failed', pay.id, { amountUsd: usd(pay.amount_micros), message: ev.message });
        await notify(pay.user_id, 'payment.failed', { paymentId: pay.id, amountUsd: usd(pay.amount_micros), message: ev.message }, 'Your MobiAd payment did not go through', `Your payment of ${fmt(pay.amount_micros)} was not completed: ${ev.message}\n\nNo money was added to your wallet. You can try again with another card from Wallet > Add funds.`);
      }
      return;
    }
    if (ev.kind === 'refunded') {
      const pay = await repo.paymentByIntent(ev.paymentIntent);
      if (!pay) return defer();
      if (!Number.isInteger(ev.refundedCents) || ev.refundedCents <= 0) return;
      const cum = ev.refundedCents * 10_000, delta = cum - pay.refunded_micros;
      if (delta <= 0) return; // an older or repeated delivery
      const applied = await repo.addWalletEntry({ id: id('wal'), userId: pay.user_id, kind: 'refund', amountMicros: -delta, provider: 'stripe', providerRef: `stripe:refund:${ev.chargeId}:${ev.refundedCents}`, note: `Refund of ${fmt(delta)} to your card` });
      if (!applied) return;
      await repo.updatePayment(pay.id, { refundedMicros: cum, ...(['disputed', 'dispute_lost'].includes(pay.status) ? {} : { status: cum >= pay.amount_micros ? 'refunded' : 'partially_refunded' }) });
      await ctx.audit(null, pay.user_id, 'payment_refunded', pay.id, { amountUsd: usd(delta) });
      await notify(pay.user_id, 'payment.refunded', { paymentId: pay.id, amountUsd: usd(delta) }, 'A refund was issued', `We refunded ${fmt(delta)} to your card. The same amount was removed from your MobiAd wallet.`);
      return;
    }
    if (ev.kind === 'dispute_created') {
      const pay = await repo.paymentByIntent(ev.paymentIntent);
      if (!pay) return defer();
      const micros = disputeHold(pay, ev);
      if (!(await repo.createDispute({ id: ev.disputeId, paymentId: pay.id, userId: pay.user_id, amountMicros: micros, reason: ev.reason, status: ev.status }))) return; // already recorded
      await repo.addWalletEntry({ id: id('wal'), userId: pay.user_id, kind: 'dispute_hold', amountMicros: -micros, provider: 'stripe', providerRef: `stripe:dispute:${ev.disputeId}:hold`, note: `Card dispute opened (${ev.reason || 'unspecified'}): ${fmt(micros)} held` });
      await repo.updatePayment(pay.id, { status: 'disputed' });
      await ctx.audit(null, pay.user_id, 'payment_disputed', pay.id, { amountUsd: usd(micros), reason: ev.reason, dispute: ev.disputeId });
      await notify(pay.user_id, 'payment.disputed', { paymentId: pay.id, amountUsd: usd(micros), reason: ev.reason }, 'A payment of yours was disputed', `Your card issuer opened a dispute on a payment of ${fmt(micros)}. The amount is held in your wallet until the dispute is decided.`);
      return;
    }
    if (ev.kind === 'dispute_closed') {
      const pay = await repo.paymentByIntent(ev.paymentIntent);
      if (!pay) return defer();
      let d = await repo.dispute(ev.disputeId);
      const micros = disputeHold(pay, ev);
      if (!d) { // we never saw it open (e.g. webhook endpoint added later): record it so the books are right
        await repo.createDispute({ id: ev.disputeId, paymentId: pay.id, userId: pay.user_id, amountMicros: micros, reason: null, status: 'needs_response' });
        await repo.addWalletEntry({ id: id('wal'), userId: pay.user_id, kind: 'dispute_hold', amountMicros: -micros, provider: 'stripe', providerRef: `stripe:dispute:${ev.disputeId}:hold`, note: `Card dispute: ${fmt(micros)} held` });
        d = await repo.dispute(ev.disputeId);
      }
      if (d.closed_at) return;
      const releases = ['won', 'warning_closed', 'charge_refunded'].includes(ev.status); // charge_refunded: the refund itself debits the wallet, so the hold must not stay
      if (releases) {
        await repo.addWalletEntry({ id: id('wal'), userId: pay.user_id, kind: 'dispute_release', amountMicros: d.amount_micros, provider: 'stripe', providerRef: `stripe:dispute:${ev.disputeId}:release`, note: `Dispute ${ev.status.replace('_', ' ')}: held amount released` });
        await repo.updatePayment(pay.id, { status: pay.refunded_micros >= pay.amount_micros ? 'refunded' : pay.refunded_micros > 0 ? 'partially_refunded' : 'paid' });
      } else {
        if (cfg.disputeFeeUsd > 0) await repo.addWalletEntry({ id: id('wal'), userId: pay.user_id, kind: 'dispute_fee', amountMicros: -usdToMicros(cfg.disputeFeeUsd), provider: 'stripe', providerRef: `stripe:dispute:${ev.disputeId}:fee`, note: `Dispute fee (dispute lost)` });
        await repo.updatePayment(pay.id, { status: 'dispute_lost' });
      }
      await repo.closeDispute(ev.disputeId, ev.status);
      await ctx.audit(null, pay.user_id, 'dispute_closed', pay.id, { dispute: ev.disputeId, status: ev.status, amountUsd: usd(d.amount_micros) });
      await notify(pay.user_id, 'payment.dispute_closed', { paymentId: pay.id, dispute: ev.disputeId, status: ev.status }, 'A dispute was decided', releases ? `The dispute on your payment was resolved in your favour (${ev.status.replace('_', ' ')}). The held ${fmt(d.amount_micros)} was returned to your wallet.` : `The dispute on your payment was lost. The ${fmt(d.amount_micros)} stays removed from your wallet.`);
    }
  }

  return {
    'GET /api/billing/summary': { handler: async ({ res, u }) => {
      if (u.role === 'advertiser') {
        const b = await repo.advertiserBalance(u.id), entries = await repo.walletEntries(u.id, 50);
        return json(res, 200, { role: 'advertiser', credits: usd(b.creditsMicros), spent: usd(b.spentMicros), reserved: usd(b.reservedMicros), available: usd(b.availableMicros),
          paymentsMode: cfg.paymentsMode, minTopupUsd: cfg.minTopupUsd, entries: entries.map((e) => ({ id: e.id, kind: e.kind, amount: usd(e.amount_micros), provider: e.provider, note: e.note, at: e.created_at })) });
      }
      if (u.role === 'publisher') {
        const b = await repo.publisherBalance(u.id), payouts = await repo.payouts({ userId: u.id, limit: 50 });
        return json(res, 200, { role: 'publisher', earned: usd(b.earnedMicros), held: usd(b.heldMicros), paid: usd(b.paidMicros), requested: usd(b.requestedMicros), payable: usd(b.payableMicros), pending: usd(b.pendingMicros), holdDays: cfg.payoutHoldDays, minPayoutUsd: cfg.minPayoutUsd,
          apps: b.perApp.map((a) => ({ ...a, earned: usd(a.earnedMicros), earnedMicros: undefined })), payouts: payouts.map((p) => ({ id: p.id, amount: usd(p.amount_micros), status: p.status, note: p.note, reference: p.reference || null, at: p.created_at })) });
      }
      return json(res, 403, { error: 'advertisers and publishers only' });
    } },

    'POST /api/billing/topup': { role: 'advertiser', verified: true, handler: async ({ req, res, u }) => {
      const b = await readJson(req), amount = Number(b.amountUsd);
      if (!Number.isFinite(amount) || amount < cfg.minTopupUsd || amount > 10_000) return json(res, 400, { error: `amountUsd must be between ${cfg.minTopupUsd} and 10000` });
      if (cfg.paymentsMode === 'none') return json(res, 501, { error: 'payments_disabled', detail: 'Online payments are not enabled. Contact support to fund your account.' });
      if (cfg.paymentsMode === 'test') { // instant fake credit for development/demo only; refused by config validation in production
        const ref = 'test:' + id('t');
        await repo.createPayment({ id: id('pmt'), userId: u.id, provider: 'test', sessionId: ref, amountMicros: usdToMicros(amount), status: 'paid' });
        await repo.addWalletEntry({ id: id('wal'), userId: u.id, kind: 'topup', amountMicros: usdToMicros(amount), provider: 'test', providerRef: ref, note: 'TEST MODE credit' });
        await ctx.audit(req, u.id, 'wallet_topup_test', u.id, { amountUsd: amount });
        return json(res, 200, { credited: true, test: true });
      }
      const s = await createCheckoutSession({ secretKey: cfg.stripeSecretKey, apiBase: cfg.stripeApiBase, userId: u.id, email: u.email, amountUsd: amount,
        successUrl: `${cfg.publicUrl}/app#topup=success`, cancelUrl: `${cfg.publicUrl}/app#topup=cancelled` });
      await repo.createPayment({ id: id('pmt'), userId: u.id, provider: 'stripe', sessionId: s.id, amountMicros: usdToMicros(amount), status: 'pending' });
      await ctx.audit(req, u.id, 'wallet_topup_started', s.id, { amountUsd: amount });
      return json(res, 200, { checkoutUrl: s.url });
    } },

    // Stripe calls this; the signature is verified against the RAW body. Every handler below is idempotent (unique provider refs),
    // so Stripe's retries and out-of-order deliveries can never double-credit, double-refund or double-hold.
    'POST /api/webhooks/stripe': { public: true, handler: async ({ req, res }) => {
      if (cfg.paymentsMode !== 'stripe') return json(res, 404, { error: 'not found' });
      const raw = await readRaw(req, 256 * 1024);
      if (!verifyStripeSignature(raw, req.headers['stripe-signature'], cfg.stripeWebhookSecret)) return json(res, 400, { error: 'invalid signature' });
      let event; try { event = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad json' }); }
      const ev = parseStripeEvent(event);
      if (ev) await handleStripeEvent({ ...ev, eventId: event.id });
      return json(res, 200, { received: true });
    } },

    // ---- advertiser: own payment attempts, billing details for tax invoices ----
    'GET /api/billing/payments': { role: 'advertiser', handler: async ({ res, u }) => json(res, 200, (await repo.paymentsByUser(u.id, 50)).map(presentPayment)) },
    'GET /api/billing/profile': { role: 'advertiser', handler: async ({ res, u }) => json(res, 200, { ...(await repo.billingProfile(u.id)), taxMode: cfg.taxMode, taxLabel: cfg.taxLabel }) },
    'POST /api/billing/profile': { role: 'advertiser', verified: true, handler: async ({ req, res, u }) => {
      const p = sanitizeProfile(await readJson(req));
      if (p.errors.length) return json(res, 400, { error: p.errors.join('; ') });
      await repo.saveBillingProfile(u.id, p);
      await ctx.audit(req, u.id, 'billing_profile_saved', u.id, { country: p.country, hasTaxId: !!p.taxId });
      return json(res, 200, { ok: true });
    } },

    // ---- admin: payments, refunds, disputes ----
    'GET /api/admin/payments': { role: 'admin', admin: true, handler: async ({ res }) => json(res, 200, (await repo.allPayments(200)).map((p) => ({ ...presentPayment(p), email: p.email, userId: p.user_id, provider: p.provider, refundableUsd: usd(Math.max(0, p.amount_micros - p.refunded_micros)) }))) },
    'GET /api/admin/disputes': { role: 'admin', admin: true, handler: async ({ res }) => json(res, 200, (await repo.allDisputes(200)).map((d) => ({ id: d.id, paymentId: d.payment_id, email: d.email, amount: usd(d.amount_micros), reason: d.reason, status: d.status, createdAt: d.created_at, closedAt: d.closed_at, evidence: d.evidence_status || null, canRespond: ['needs_response', 'warning_needs_response'].includes(d.status) && cfg.paymentsMode === 'stripe' }))) },
    // Admin: send evidence for an open dispute to Stripe. The record of what the advertiser bought and used is added from our own data.
    'POST /api/admin/disputes/evidence': { role: 'admin', admin: true, handler: async ({ req, res, u }) => {
      const b = await readJson(req), d = await repo.dispute(String(b.disputeId || ''));
      if (!d) return json(res, 404, { error: 'dispute not found' });
      if (cfg.paymentsMode !== 'stripe') return json(res, 501, { error: 'stripe_disabled', detail: 'Evidence is only sent in Stripe mode.' });
      if (!['needs_response', 'warning_needs_response'].includes(d.status) || d.evidence_status === 'submitted') return json(res, 409, { error: 'not_open', detail: d.evidence_status === 'submitted' ? 'Evidence was already submitted: Stripe accepts it only once.' : `This dispute is "${d.status}".` });
      const explanation = String(b.explanation || '').trim();
      if (explanation.length < 20 || explanation.length > 4000) return json(res, 400, { error: 'explanation of 20-4000 characters is required' });
      const pay = await repo.payment(d.payment_id), user = await repo.userById(d.user_id), prof = await repo.billingProfile(d.user_id), rep = await repo.report('advertiser', d.user_id);
      const evidence = {
        product_description: 'Prepaid advertising credit on the MobiAd self-serve ad platform. The credit is spent on ad campaigns the customer creates and controls.',
        customer_name: prof.legalName || undefined, customer_email_address: user?.email, billing_address: prof.address || undefined,
        service_date: pay ? new Date(pay.created_at).toISOString().slice(0, 10) : undefined,
        access_activity_log: `Account ${d.user_id} (${user?.email}) topped up ${usd(pay?.amount_micros || 0)} USD on ${pay ? new Date(pay.created_at).toISOString() : 'unknown date'} and used the platform: ${rep.total.impressions} ad impressions, ${rep.total.clicks} clicks and ${usd(Math.round(rep.total.spend * 1e6))} USD of credit spent on campaigns up to ${new Date().toISOString().slice(0, 10)}.`,
        refund_policy_disclosure: 'Unspent credit can be refunded on request; credit already spent on delivered ads cannot be refunded (Terms of Service).',
        uncategorized_text: explanation,
      };
      try { await submitDisputeEvidence({ ...stripeOpts(), disputeId: d.id, evidence, submit: b.submit !== false }); }
      catch (e) { log?.error('dispute evidence failed', { msg: e.message }); return json(res, 502, { error: 'stripe_error', detail: e.message }); }
      await repo.setDisputeEvidence(d.id, b.submit === false ? 'draft' : 'submitted', u.id);
      await ctx.audit(req, u.id, 'dispute_evidence', d.id, { submitted: b.submit !== false, explanation: explanation.slice(0, 500) });
      return json(res, 200, { id: d.id, evidence: b.submit === false ? 'draft' : 'submitted' });
    } },
    'POST /api/admin/payments/refund': { role: 'admin', admin: true, handler: async ({ req, res, u }) => {
      const b = await readJson(req), pay = await repo.payment(String(b.paymentId || '')), reason = String(b.reason || '').trim();
      if (!pay) return json(res, 404, { error: 'payment not found' });
      if (!reason || reason.length > 300) return json(res, 400, { error: 'a reason (max 300 characters) is required' });
      if (!['paid', 'partially_refunded'].includes(pay.status)) return json(res, 409, { error: 'not_refundable', detail: `This payment is "${pay.status}", so it cannot be refunded.` });
      const remaining = pay.amount_micros - pay.refunded_micros;
      const micros = b.amountUsd == null || b.amountUsd === '' ? remaining : usdToMicros(Number(b.amountUsd));
      if (!Number.isFinite(micros) || micros < 10_000 || micros > remaining) return json(res, 400, { error: 'invalid_amount', detail: `Refund between $0.01 and $${usd(remaining)} (the part of this payment not yet refunded).`, remainingUsd: usd(remaining) });
      const bal = await repo.advertiserBalance(pay.user_id); // money already spent on ads cannot be handed back
      if (micros > bal.availableMicros) return json(res, 409, { error: 'exceeds_available', availableUsd: usd(Math.max(0, bal.availableMicros)), detail: 'Part of this payment is already spent or reserved for campaigns. Refund at most the available balance, or ask the advertiser to pause or reduce campaigns first.' });
      if (pay.provider === 'test') {
        const cum = pay.refunded_micros + micros;
        await repo.addWalletEntry({ id: id('wal'), userId: pay.user_id, kind: 'refund', amountMicros: -micros, provider: 'test', providerRef: `test:refund:${pay.id}:${cum}`, note: `Refund of $${usd(micros)} (test mode)`.slice(0, 300) });
        await repo.updatePayment(pay.id, { refundedMicros: cum, status: cum >= pay.amount_micros ? 'refunded' : 'partially_refunded' });
        await ctx.audit(req, u.id, 'payment_refunded', pay.id, { amountUsd: usd(micros), reason, test: true });
        ctx.emit?.(pay.user_id, 'payment.refunded', { paymentId: pay.id, amountUsd: usd(micros), reason });
        return json(res, 200, { status: 'refunded', amountUsd: usd(micros) });
      }
      if (!pay.payment_intent) return json(res, 409, { error: 'no_payment_intent', detail: 'This payment has no Stripe payment reference yet.' });
      let r;
      try { r = await createRefund({ secretKey: cfg.stripeSecretKey, apiBase: cfg.stripeApiBase, paymentIntent: pay.payment_intent, amountCents: Math.round(micros / 10_000), idempotencyKey: `refund-${pay.id}-${pay.refunded_micros}-${micros}`, metadata: { payment_id: pay.id, admin: u.id } }); }
      catch (e) { log?.error('stripe refund failed', { payment: pay.id, msg: e.message }); return json(res, 502, { error: 'stripe_error', detail: e.message }); }
      await ctx.audit(req, u.id, 'payment_refund_requested', pay.id, { amountUsd: usd(micros), reason, refundId: r.id });
      return json(res, 202, { status: 'requested', refundId: r.id, note: 'Stripe confirms by webhook; the advertiser\'s wallet is debited then.' });
    } },


    'GET /api/billing/payout-profile': { role: 'publisher', handler: async ({ res, u }) => {
      const p = await repo.payoutProfile(u.id);
      return json(res, 200, { legalName: p.legal_name, country: p.country, method: p.method, methodRef: p.method_ref, kycStatus: p.kyc_status, taxStatus: p.tax_status, reviewNote: p.review_note, verificationRequired: !!cfg.requirePayoutVerification });
    } },
    'POST /api/billing/payout-profile': { role: 'publisher', verified: true, handler: async ({ req, res, u }) => {
      const b = await readJson(req);
      const legalName = String(b.legalName || '').trim().slice(0, 120), country = String(b.country || '').trim().toUpperCase(), method = String(b.method || ''), methodRef = String(b.methodRef || '').trim().slice(0, 120);
      if (!legalName || !/^[A-Z]{2}$/.test(country) || !['bank', 'paypal', 'wise'].includes(method) || !methodRef) return json(res, 400, { error: 'legalName, country (2 letters), method (bank|paypal|wise) and methodRef are required' });
      if (/\d{12,}/.test(methodRef.replace(/[\s-]/g, ''))) return json(res, 400, { error: 'Do not enter full account numbers here; give a payout email/handle or the last 4 digits. Finance will collect bank details securely.' });
      const r = await repo.savePayoutProfile(u.id, { legalName, country, method, methodRef });
      await ctx.audit(req, u.id, 'payout_profile_saved', u.id, { country, method, reverification: r.identityChanged });
      return json(res, 200, { ok: true, reverificationRequired: r.identityChanged });
    } },
    'POST /api/billing/payout-profile/submit': { role: 'publisher', verified: true, handler: async ({ req, res, u }) => {
      const b = await readJson(req);
      if (!['kyc', 'tax'].includes(b.kind)) return json(res, 400, { error: 'kind must be kyc or tax' });
      const p = await repo.payoutProfile(u.id);
      if (!p.legal_name || !p.country) return json(res, 409, { error: 'profile_incomplete', detail: 'Save your payout profile first.' });
      if (!(await repo.submitVerification(u.id, b.kind))) return json(res, 409, { error: 'already_submitted_or_verified' });
      await ctx.audit(req, u.id, 'verification_submitted', u.id, { kind: b.kind });
      return json(res, 200, { ok: true, status: 'submitted' });
    } },
    'POST /api/billing/payout': { role: 'publisher', verified: true, handler: async ({ req, res, u }) => {
      const b = await readJson(req), amount = Number(b.amountUsd), micros = usdToMicros(amount);
      if (!Number.isFinite(amount) || amount < cfg.minPayoutUsd) return json(res, 400, { error: `minimum payout is $${cfg.minPayoutUsd}` });
      const prof = await repo.payoutProfile(u.id), connect = connectOn() ? await repo.connectAccount(u.id) : null;
      if (connectOn()) { if (!connect?.payoutsEnabled) return json(res, 409, { error: 'payout_account_required', detail: 'Set up your payout account with Stripe first (Earnings and payouts > Payout account).' }); }
      else if (!prof.legal_name || !prof.country || !prof.method || !prof.method_ref) return json(res, 409, { error: 'profile_incomplete', detail: 'Complete your payout profile first.' });
      if (cfg.requirePayoutVerification) {
        if (prof.kyc_status !== 'verified') return json(res, 409, { error: 'kyc_required', detail: 'Identity verification must be approved before payouts.', kycStatus: prof.kyc_status });
        if (prof.tax_status !== 'verified') return json(res, 409, { error: 'tax_required', detail: 'Tax information must be approved before payouts.', taxStatus: prof.tax_status });
      }
      const bal = await repo.publisherBalance(u.id);
      if (micros > bal.payableMicros) return json(res, 409, { error: 'exceeds_payable', payableUsd: usd(Math.max(0, bal.payableMicros)), heldUsd: usd(bal.heldMicros) });
      const p = { id: id('pay'), userId: u.id, amountMicros: micros };
      await repo.createPayout(p);
      await ctx.audit(req, u.id, 'payout_requested', p.id, { amountUsd: amount });
      // small payouts to a verified, onboarded publisher are approved and sent at once; anything else waits for an admin
      if (connect?.payoutsEnabled && cfg.autoPayoutMaxUsd > 0 && amount <= cfg.autoPayoutMaxUsd && await repo.transitionPayout(p.id, 'approved', { note: 'Auto-approved (small payout)', by: 'system:auto' })) {
        const sent = await sendPayoutViaStripe(await repo.payout(p.id), 'system:auto', req);
        return json(res, 201, { id: p.id, status: sent.ok ? 'paid' : 'approved', amount, auto: sent.ok ? 'paid' : 'approved_send_failed', ...(sent.ok ? { reference: sent.transfer } : { detail: sent.detail }) });
      }
      return json(res, 201, { id: p.id, status: 'requested', amount });
    } },

    // ---- publisher payout account (Stripe Connect Express): Stripe collects and verifies identity and tax details ----
    'POST /api/billing/connect/start': { role: 'publisher', verified: true, handler: async ({ req, res, u }) => {
      if (!connectOn()) return json(res, 501, { error: 'connect_disabled', detail: 'Automated payouts are not enabled. Payouts are sent by our team.' });
      try {
        let acct = await repo.connectAccount(u.id);
        if (!acct) {
          const prof = await repo.payoutProfile(u.id);
          const a = await createConnectAccount({ ...stripeOpts(), userId: u.id, email: u.email, country: /^[A-Z]{2}$/.test(prof.country) ? prof.country : undefined, platformCountry: cfg.stripePlatformCountry });
          await repo.createConnectAccount(u.id, a.id); acct = await repo.connectAccount(u.id);
        }
        const link = await createAccountLink({ ...stripeOpts(), account: acct.account, refreshUrl: `${cfg.publicUrl}/app#connect=refresh`, returnUrl: `${cfg.publicUrl}/app#connect=return` });
        await ctx.audit(req, u.id, 'connect_onboarding_started', u.id, { account: acct.account });
        return json(res, 200, { url: link.url });
      } catch (e) {
        log?.error('connect start failed', { msg: e.message });
        // Stripe only lets a platform create connected accounts in some countries (for a US platform, for example, not India)
        if (/cannot be created by platforms|not supported for platforms/i.test(e.message)) return json(res, 409, { error: 'country_unsupported', detail: 'Automatic payouts are not available in your country yet. Our team will pay you manually: contact support.' });
        return json(res, 502, { error: 'stripe_error', detail: e.message }); }
    } },
    'GET /api/billing/connect/status': { role: 'publisher', handler: async ({ res, u, url }) => {
      if (!connectOn()) return json(res, 200, { mode: 'manual' });
      let acct = await repo.connectAccount(u.id);
      if (acct && url.searchParams.get('refresh') === '1') { try { await applyConnect(u.id, normalizeAccount(await retrieveAccount({ ...stripeOpts(), account: acct.account }))); acct = await repo.connectAccount(u.id); } catch (e) { log?.error('connect refresh failed', { msg: e.message }); } }
      return json(res, 200, { mode: 'stripe_connect', connected: !!acct, detailsSubmitted: !!acct?.detailsSubmitted, payoutsEnabled: !!acct?.payoutsEnabled, requirements: acct?.requirements || [], autoPayoutMaxUsd: cfg.autoPayoutMaxUsd });
    } },
    // Admin: pay an approved payout through Stripe (approve=true approves a requested one first, with the same verification rules).
    'POST /api/admin/payouts/send': { role: 'admin', admin: true, handler: async ({ req, res, u }) => {
      if (!connectOn()) return json(res, 501, { error: 'connect_disabled', detail: 'Payouts are manual in this deployment: use Mark paid with a reference.' });
      const b = await readJson(req); let row = await repo.payout(String(b.id || ''));
      if (!row) return json(res, 404, { error: 'payout not found' });
      if (row.status === 'requested' && b.approve === true) {
        if (cfg.requirePayoutVerification) { const p = await repo.payoutProfile(row.user_id); if (p.kyc_status !== 'verified' || p.tax_status !== 'verified') return json(res, 409, { error: 'verification_missing', detail: 'KYC and tax status must both be verified before approving.' }); }
        if (await repo.transitionPayout(row.id, 'approved', { note: 'Approved with send', by: u.id })) { await ctx.audit(req, u.id, 'payout_resolved', row.id, { status: 'approved' }); ctx.emit?.(row.user_id, 'payout.approved', { payoutId: row.id, amountUsd: usd(row.amount_micros) }); }
        row = await repo.payout(row.id);
      }
      const r = await sendPayoutViaStripe(row, u.id, req);
      return r.ok ? json(res, 200, { id: row.id, status: 'paid', reference: r.transfer }) : json(res, r.status, { error: r.error, detail: r.detail });
    } },

    // Monthly statement as CSV (advertiser: spend per campaign per day; publisher: earnings per app per day).
    'GET /api/billing/statement': { handler: async ({ res, u, url }) => {
      const month = url.searchParams.get('month') || new Date().toISOString().slice(0, 7);
      if (!monthRe.test(month)) return json(res, 400, { error: 'month must be YYYY-MM' });
      await ctx.ledger.flush?.();
      const rows = await repo.statement(u.role, u.id, month), adv = u.role === 'advertiser';
      const csv = toCsv(['date', adv ? 'campaign' : 'app', 'id', 'impressions', 'clicks', 'installs', 'invalid_clicks', adv ? 'amount_usd' : 'earnings_usd'],
        rows.map((r) => [r.day, r.name, r.id, r.impressions, r.clicks, r.installs, r.invalidClicks, +(adv ? r.spend : r.spend * repo.share).toFixed(6)]));
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="mobiad-statement-${month}.csv"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(csv);
    } },
  };
}
