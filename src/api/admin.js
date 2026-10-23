// Admin console API: creative review, fraud flags, users, audit log, wallet credits, payouts.
import { json, readJson } from '../http.js';
import { id, usdToMicros, microsToUsd, toCsv, EMAIL } from './util.js';
import { newCode, hashCode, normalizeCode } from '../auth/invites.js';
import { templates } from '../auth/mailer.js';
import { validateOutboundUrl } from '../core/safeHttp.js';
import { PARTNER_FORMATS } from '../core/partners.js';

export function adminRoutes(ctx) {
  const { repo, cfg } = ctx;
  const A = (handler) => ({ role: 'admin', admin: true, handler });

  return {
    // ---- private-beta invites: codes are shown once, stored only as hashes ----
    'POST /api/admin/invites': A(async ({ req, res, u }) => {
      const b = await readJson(req), role = b.role, email = String(b.email || '').trim().toLowerCase(), note = String(b.note || '').trim().slice(0, 200);
      if (!['advertiser', 'publisher'].includes(role)) return json(res, 400, { error: 'role must be advertiser or publisher' });
      if (email && !EMAIL.test(email)) return json(res, 400, { error: 'email is not valid' });
      const maxUses = Math.floor(Number(b.maxUses ?? 1)), days = Math.floor(Number(b.expiresInDays ?? 14));
      if (!(maxUses >= 1 && maxUses <= 50) || !(days >= 1 && days <= 90)) return json(res, 400, { error: 'maxUses must be 1-50 and expiresInDays 1-90' });
      const code = newCode(), inviteId = id('inv'), expiresAt = Date.now() + days * 86_400_000;
      await repo.createSignupInvite({ id: inviteId, codeHash: hashCode(code), role, email: email || null, note: note || null, maxUses, createdBy: u.id, expiresAt });
      await ctx.audit(req, u.id, 'invite_created', inviteId, { role, email: email || null, maxUses, days });
      let emailed = false;
      if (email && ctx.mailer?.send) { ctx.mailer.send({ to: email, ...templates.signupInvite(role, code, `${cfg.publicUrl}/app#signup=${normalizeCode(code)}&role=${role}`, days) }).catch(() => {}); emailed = true; }
      return json(res, 201, { id: inviteId, code, role, email: email || null, maxUses, expiresAt, emailed });
    }),
    'GET /api/admin/invites': A(async ({ res }) => {
      const now = Date.now();
      return json(res, 200, (await repo.listSignupInvites(200)).map((i) => ({ id: i.id, role: i.role, email: i.email, note: i.note, uses: i.used, maxUses: i.max_uses, expiresAt: i.expires_at, createdAt: i.created_at,
        status: i.revoked ? 'revoked' : i.used >= i.max_uses ? 'used up' : i.expires_at <= now ? 'expired' : 'open' })));
    }),
    'POST /api/admin/invites/revoke': A(async ({ req, res, u }) => {
      const b = await readJson(req);
      if (!(await repo.revokeSignupInvite(String(b.id || '')))) return json(res, 404, { error: 'invite not found' });
      await ctx.audit(req, u.id, 'invite_revoked', String(b.id), {});
      return json(res, 200, { ok: true });
    }),
    'GET /api/admin/overview': A(async ({ res }) => {
      const [pending, flagged, payouts, users] = await Promise.all([repo.campaignsByReview('pending'), repo.flaggedApps(), repo.payouts({ status: 'requested' }), repo.listUsers(1000)]);
      return json(res, 200, { pendingCampaigns: pending.length, flaggedApps: flagged.length, pendingPayouts: payouts.length, users: users.length });
    }),
    'GET /api/admin/campaigns': A(async ({ res, url }) => {
      const status = url.searchParams.get('status') || 'pending';
      if (!['pending', 'approved', 'rejected'].includes(status)) return json(res, 400, { error: 'invalid status' });
      return json(res, 200, await repo.campaignsByReview(status));
    }),
    'POST /api/admin/campaigns/review': A(async ({ req, res, u }) => {
      const b = await readJson(req), c = await repo.campaign(String(b.id || ''));
      if (!c || !['approve', 'reject'].includes(b.decision)) return json(res, 400, { error: 'id and decision (approve|reject) required' });
      if (b.decision === 'reject' && !String(b.note || '').trim()) return json(res, 400, { error: 'a reason is required when rejecting' });
      const status = b.decision === 'approve' ? 'approved' : 'rejected';
      await repo.setReview(c.id, { status, note: String(b.note || '').slice(0, 500), by: u.id });
      await ctx.audit(req, u.id, 'campaign_reviewed', c.id, { decision: b.decision, note: b.note || null });
      await ctx.changed(); // approvals start serving, rejections stop serving, on every replica
      ctx.emit(c.owner, 'campaign.' + status, { campaignId: c.id, name: c.name, note: b.note || null });
      const owner = await repo.userById(c.owner);
      if (owner) ctx.mailer.send({ to: owner.email, subject: `Your campaign "${c.name}" was ${status}`, text: status === 'approved' ? 'Your campaign was approved and is now eligible to serve.' : `Your campaign was rejected: ${b.note}` }).catch(() => {});
      return json(res, 200, { id: c.id, reviewStatus: status });
    }),
    'GET /api/admin/apps/flagged': A(async ({ res }) => json(res, 200, await repo.flaggedApps())),
    'POST /api/admin/apps/flag': A(async ({ req, res, u }) => {
      const b = await readJson(req), a = await repo.app(String(b.id || ''));
      if (!a || typeof b.flagged !== 'boolean') return json(res, 400, { error: 'id and flagged(boolean) required' });
      await repo.setAppFlag(a.id, b.flagged, String(b.reason || 'manual review').slice(0, 300));
      await ctx.audit(req, u.id, b.flagged ? 'app_flagged' : 'app_unflagged', a.id, { reason: b.reason || null });
      return json(res, 200, { id: a.id, flagged: b.flagged });
    }),
    'GET /api/admin/users': A(async ({ res }) => json(res, 200, await repo.listUsers(200))),
    'GET /api/admin/audit': A(async ({ res, url }) => json(res, 200, await repo.auditList({
      limit: Math.min(1000, +url.searchParams.get('limit') || 200), actor: url.searchParams.get('actor') || undefined, action: url.searchParams.get('action') || undefined }))),

    // Manual wallet credit (bank transfer, invoice payment, goodwill). Idempotent when a reference is supplied.
    'POST /api/admin/wallet/credit': A(async ({ req, res, u }) => {
      const b = await readJson(req), target = await repo.userById(String(b.userId || ''));
      const micros = usdToMicros(b.amountUsd);
      if (!target || target.role !== 'advertiser' || !Number.isFinite(micros) || micros === 0 || Math.abs(micros) > 1e11) return json(res, 400, { error: 'advertiser userId and a non-zero amountUsd (≤ 100000) required' });
      if (!String(b.note || '').trim()) return json(res, 400, { error: 'note is required for the audit trail' });
      const applied = await repo.addWalletEntry({ id: id('wal'), userId: target.id, kind: micros > 0 ? 'topup' : 'adjustment', amountMicros: micros, provider: 'manual', providerRef: b.reference ? 'manual:' + String(b.reference) : null, note: String(b.note).slice(0, 300) });
      if (!applied) return json(res, 200, { applied: false, reason: 'duplicate reference' });
      ctx.emit(target.id, 'wallet.credited', { amountUsd: microsToUsd(micros), note: b.note });
      await ctx.audit(req, u.id, 'wallet_credit', target.id, { amountUsd: microsToUsd(micros), note: b.note, reference: b.reference || null });
      return json(res, 200, { applied: true });
    }),
    'GET /api/admin/payouts': A(async ({ res, url }) => {
      const rows = await repo.payouts({ status: url.searchParams.get('status') || 'requested' }), connectOn = cfg.payoutsMode === 'stripe_connect';
      // in Stripe Connect mode each row says whether the publisher can be paid automatically
      return json(res, 200, await Promise.all(rows.map(async (r) => (connectOn ? { ...r, viaStripe: true, stripeReady: !!(await repo.connectAccount(r.user_id))?.payoutsEnabled } : r))));
    }),
    // requested -> approved | rejected; approved -> paid (external reference required) | rejected.
    'POST /api/admin/payouts/resolve': A(async ({ req, res, u }) => {
      const b = await readJson(req);
      if (!['approved', 'paid', 'rejected'].includes(b.status)) return json(res, 400, { error: 'status must be approved, paid or rejected' });
      const reference = String(b.reference || '').trim().slice(0, 120);
      if (b.status === 'paid' && !reference) return json(res, 400, { error: 'reference (the bank/PayPal transaction id) is required when marking paid' });
      const row = await repo.payout(String(b.id || ''));
      if (!row) return json(res, 404, { error: 'payout not found' });
      if (b.status === 'approved' && cfg.requirePayoutVerification) {
        const p = await repo.payoutProfile(row.user_id);
        if (p.kyc_status !== 'verified' || p.tax_status !== 'verified') return json(res, 409, { error: 'verification_missing', detail: 'KYC and tax status must both be verified before approving.' });
      }
      const ok = await repo.transitionPayout(row.id, b.status, { note: String(b.note || '').slice(0, 300), reference, by: u.id });
      if (!ok) return json(res, 409, { error: 'invalid_transition', detail: `Payout is ${row.status}; allowed: requested->approved|rejected, approved->paid|rejected.` });
      await ctx.audit(req, u.id, 'payout_resolved', row.id, { status: b.status, note: b.note || null, reference: reference || null });
      ctx.emit(row.user_id, 'payout.' + b.status, { payoutId: row.id, amountUsd: row.amount_micros / 1e6, reference: reference || null });
      return json(res, 200, { id: row.id, status: b.status });
    }),
    // External demand partners (OpenRTB DSPs) for the unified auction.
    'GET /api/admin/partners': A(async ({ res }) => json(res, 200, await repo.partners())),
    'POST /api/admin/partners': A(async ({ req, res, u }) => {
      const b = await readJson(req), name = String(b.name || '').trim().slice(0, 80);
      const problem = validateOutboundUrl(String(b.endpointUrl || ''), { allowPrivate: cfg.allowPrivateCallbacks, allowHttp: cfg.allowPrivateCallbacks });
      if (!name || problem) return json(res, 400, { error: !name ? 'name required' : 'endpointUrl ' + problem });
      const timeoutMs = Math.min(500, Math.max(50, Math.floor(+b.timeoutMs || 150))), formats = (Array.isArray(b.formats) ? b.formats : []).filter((f) => PARTNER_FORMATS.includes(f));
      const p = { id: id('prt'), name, endpointUrl: String(b.endpointUrl), authHeader: b.authHeader ? String(b.authHeader).slice(0, 300) : null, timeoutMs, formats, childSafe: !!b.childSafe };
      await repo.createPartner(p); await ctx.audit(req, u.id, 'partner_created', p.id, { name, timeoutMs, formats }); await ctx.changed();
      return json(res, 201, { id: p.id, name, timeoutMs, formats, childSafe: p.childSafe, status: 'active' });
    }),
    'POST /api/admin/partners/status': A(async ({ req, res, u }) => {
      const b = await readJson(req);
      if (!['active', 'paused'].includes(b.status) || !(await repo.setPartnerStatus(String(b.id || ''), b.status))) return json(res, 400, { error: 'id and status (active|paused) required' });
      await ctx.audit(req, u.id, 'partner_status', String(b.id), { status: b.status }); await ctx.changed();
      return json(res, 200, { ok: true });
    }),
    'GET /api/admin/payouts.csv': A(async ({ res, url }) => {
      const rows = await repo.payouts({ status: url.searchParams.get('status') || 'approved' });
      const out = [];
      for (const p of rows) { const pr = await repo.payoutProfile(p.user_id); const usr = await repo.userById(p.user_id); out.push([p.id, usr?.email || '', pr.legal_name, pr.country, pr.method, pr.method_ref, (p.amount_micros / 1e6).toFixed(2), p.status, p.reference || '']); }
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="payouts.csv"' });
      return res.end(toCsv(['payout_id', 'email', 'legal_name', 'country', 'method', 'method_ref', 'amount_usd', 'status', 'reference'], out));
    }),
    'GET /api/admin/payout-profiles': A(async ({ res, url }) => json(res, 200, (await repo.payoutProfiles(url.searchParams.get('status') || 'submitted')).map((p) => ({ userId: p.user_id, email: p.email, legalName: p.legal_name, country: p.country, method: p.method, methodRef: p.method_ref, kycStatus: p.kyc_status, taxStatus: p.tax_status, note: p.review_note })))),
    'POST /api/admin/payout-profiles/review': A(async ({ req, res, u }) => {
      const b = await readJson(req);
      if (!['kyc', 'tax'].includes(b.kind) || !['verified', 'rejected'].includes(b.status)) return json(res, 400, { error: 'kind (kyc|tax) and status (verified|rejected) required' });
      if (b.status === 'rejected' && !String(b.note || '').trim()) return json(res, 400, { error: 'a note is required when rejecting' });
      if (!(await repo.reviewVerification(String(b.userId || ''), b.kind, b.status, String(b.note || '').slice(0, 300)))) return json(res, 409, { error: 'nothing submitted to review' });
      await ctx.audit(req, u.id, 'verification_reviewed', String(b.userId), { kind: b.kind, status: b.status });
      ctx.emit(String(b.userId), 'verification.reviewed', { kind: b.kind, status: b.status, note: b.note || null });
      return json(res, 200, { ok: true });
    }),
  };
}
