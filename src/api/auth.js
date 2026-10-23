// Authentication and account lifecycle: signup, login (+MFA), email verification, password reset,
// session revocation, TOTP MFA, data export and erasure.
import { json, readJson, jwtSign, hashPw, checkPw, clientIp } from '../http.js';
import { newSecret, verifyTotp, otpauthUrl, encryptSecret, decryptSecret } from '../auth/totp.js';
import { templates } from '../auth/mailer.js';
import { normalizeCode, hashCode } from '../auth/invites.js';
import { id, EMAIL, sha256, newOneTimeToken, passwordProblem } from './util.js';
import { randomBytes } from 'node:crypto';

const DUMMY_USER = hashPw('dummy-password-for-timing');
const HOUR = 3_600_000;

export function authRoutes(ctx) {
  const { repo, cfg, keys, mailer, log } = ctx;
  const signToken = (u) => ({ token: jwtSign({ sub: u.id, tv: u.token_version || 0 }, keys.jwt), role: u.role, email: u.email });
  const link = (kind, tok) => `${cfg.publicUrl}/app#${kind}=${tok}`;
  const sendMail = (to, tpl) => { mailer.send({ to, ...tpl }).catch((e) => log?.error('email send failed', { err: e.message, to })); }; // never block or leak via timing

  async function issueToken(userId, purpose, ttlMs) {
    await repo.invalidateTokens(userId, purpose);
    const tok = newOneTimeToken();
    await repo.createToken({ id: id('ott'), userId, purpose, hash: sha256(tok), expiresAt: Date.now() + ttlMs });
    return tok;
  }

  // Decrypt the stored TOTP secret with the current key, or the previous one during a secret-rotation window.
  // Returns { secret, rotated } where rotated means it was opened with the OLD key and should be re-encrypted.
  const openTotp = (u) => {
    try { return { secret: decryptSecret(u.totp_secret_enc, keys.totp), rotated: false }; } catch (e) {
      if (!keys.totpPrev) throw e;
      return { secret: decryptSecret(u.totp_secret_enc, keys.totpPrev), rotated: true };
    }
  };
  // Check a TOTP or recovery code for a user with MFA enabled. Consumes recovery codes and enforces single-use TOTP steps.
  async function checkSecondFactor(u, code) {
    const c = String(code || '').trim();
    if (!c) return false;
    if (/^\d{3}\s?\d{3}$/.test(c)) {
      const { secret, rotated } = openTotp(u);
      const step = verifyTotp(secret, c, { lastStep: Number(u.totp_last_step) });
      if (!step) return false;
      const accepted = await repo.setTotpLastStep(u.id, step);
      if (accepted && rotated) await repo.setMfa(u.id, { secretEnc: encryptSecret(secret, keys.totp), enabled: true, recoveryHashes: u.recovery_hashes || [] }).then(() => repo.setTotpLastStep(u.id, step)); // finish the key rotation for this user
      return accepted;
    }
    const norm = c.toLowerCase().replace(/[^a-f0-9]/g, '');
    if (norm.length !== 10) return false;
    const h = sha256(norm), hashes = u.recovery_hashes || [];
    if (!hashes.includes(h)) return false;
    await repo.setRecoveryHashes(u.id, hashes.filter((x) => x !== h)); // one-time use
    return true;
  }
  const limited = async (res, ...k) => { for (const key of k) if (!(await ctx.authLimiter.allow(key))) { json(res, 429, { error: 'rate limited' }); return true; } return false; };
  const strictLimited = async (res, key) => { if (!(await ctx.strictLimiter.allow(key))) { json(res, 429, { error: 'too many requests; try again later' }); return true; } return false; };

  return {
    // what the sign-up screen needs to know before anyone is logged in
    'GET /api/public-config': { public: true, handler: async ({ res }) => json(res, 200, { inviteOnly: !!cfg.inviteOnly }) },
    'POST /api/signup': { public: true, handler: async ({ req, res }) => {
      if (await limited(res, clientIp(req))) return;
      const b = await readJson(req);
      const email = String(b.email || '').trim().toLowerCase();
      const problem = !EMAIL.test(email) ? 'valid email required' : !['advertiser', 'publisher'].includes(b.role) ? 'role (advertiser|publisher) required' : passwordProblem(b.password, email);
      if (problem) return json(res, 400, { error: problem });
      if (cfg.requireTermsAcceptance && b.acceptTerms !== true) return json(res, 400, { error: 'terms_not_accepted', detail: 'You must accept the Terms of Service and Privacy Policy to create an account.' });
      // private beta: sign-up needs a valid invite code. Every failure gets the same answer, so codes cannot be probed.
      let inviteHash = null;
      if (cfg.inviteOnly) {
        if (!normalizeCode(b.inviteCode)) return json(res, 403, { error: 'invite_required', detail: 'Sign-up is by invitation during the private beta. Ask us for an invite code.' });
        const inv = await repo.signupInviteByHash(hashCode(b.inviteCode));
        const ok = inv && !inv.revoked && inv.expires_at > Date.now() && inv.used < inv.max_uses && inv.role === b.role && (!inv.email || inv.email.toLowerCase() === email);
        if (!ok || !(await repo.consumeSignupInvite(inv.code_hash))) return json(res, 403, { error: 'invite_invalid', detail: 'This invite code is not valid for this sign-up: it may be wrong, expired, already used, or issued for a different account type or e-mail.' });
        inviteHash = inv.code_hash;
      }
      const accepted = b.acceptTerms === true;
      const u = { id: id('usr'), email, role: b.role, ...hashPw(b.password), emailVerified: !cfg.requireEmailVerification, termsVersion: accepted ? cfg.termsVersion : null, termsAcceptedAt: accepted ? Date.now() : 0 };
      try { await repo.createUser(u); } catch (e) {
        if (inviteHash) await repo.releaseSignupInvite(inviteHash); // the e-mail was taken: the invite use is given back
        if (/unique|duplicate/i.test(e.message)) return json(res, 409, { error: 'email exists' });
        throw e;
      }
      if (cfg.requireEmailVerification) sendMail(email, templates.verify(link('verify', await issueToken(u.id, 'verify', 24 * HOUR))));
      await ctx.audit(req, u.id, 'signup', u.id, { role: u.role, ...(inviteHash ? { invite: inviteHash.slice(0, 10) } : {}) });
      return json(res, 201, { ...signToken({ ...u, token_version: 0 }), emailVerified: u.emailVerified });
    } },

    'POST /api/login': { public: true, handler: async ({ req, res }) => {
      if (await limited(res, clientIp(req))) return;
      const b = await readJson(req), email = String(b.email || '').trim().toLowerCase();
      if (await limited(res, 'acct:' + email)) return; // slows credential stuffing across many IPs
      const u = await repo.userByEmail(email);
      const pwOk = checkPw(String(b.password || ''), u || DUMMY_USER); // always hash so timing does not reveal whether the email exists
      if (!u || !pwOk) { await ctx.audit(req, null, 'login_failed', sha256(email).slice(0, 12), {}); return json(res, 401, { error: 'bad credentials' }); }
      if (u.totp_enabled) {
        if (!b.code) return json(res, 401, { error: 'mfa_required', mfa: true });
        if (!(await checkSecondFactor(u, b.code))) { await ctx.audit(req, u.id, 'mfa_failed', u.id, {}); return json(res, 401, { error: 'invalid_code' }); }
      }
      await ctx.audit(req, u.id, 'login_success', u.id, { mfa: !!u.totp_enabled });
      return json(res, 200, { ...signToken(u), emailVerified: !!u.email_verified, mfaEnabled: !!u.totp_enabled });
    } },

    'GET /api/me': { handler: async ({ res, u }) => json(res, 200, { ...(cfg.demoMode ? { demo: true } : {}), id: u.id, email: u.email, role: u.role, emailVerified: !!u.email_verified, mfaEnabled: !!u.totp_enabled, ...(u.account_id ? { teamRole: u.team_role, accountId: u.account_id } : {}) }) },

    'POST /api/verify-email': { public: true, handler: async ({ req, res }) => {
      if (await limited(res, clientIp(req))) return;
      const b = await readJson(req);
      const uid = b.token ? await repo.consumeToken('verify', sha256(String(b.token))) : null;
      if (!uid) return json(res, 400, { error: 'invalid or expired link' });
      await repo.setEmailVerified(uid);
      await ctx.audit(req, uid, 'email_verified', uid, {});
      return json(res, 200, { verified: true });
    } },
    'POST /api/resend-verification': { handler: async ({ req, res, u }) => {
      if (u.email_verified) return json(res, 200, { ok: true, alreadyVerified: true });
      if (await strictLimited(res, 'verify:' + u.id)) return;
      sendMail(u.email, templates.verify(link('verify', await issueToken(u.id, 'verify', 24 * HOUR))));
      return json(res, 200, { ok: true });
    } },

    // Always answers 200 so the endpoint cannot be used to discover which emails have accounts.
    'POST /api/forgot-password': { public: true, handler: async ({ req, res }) => {
      const b = await readJson(req), email = String(b.email || '').trim().toLowerCase();
      if (await strictLimited(res, 'forgot-ip:' + clientIp(req)) || await strictLimited(res, 'forgot:' + email)) return;
      const u = EMAIL.test(email) ? await repo.userByEmail(email) : null;
      if (u) {
        sendMail(email, templates.reset(link('reset', await issueToken(u.id, 'reset', 30 * 60_000))));
        await ctx.audit(req, u.id, 'password_reset_requested', u.id, {});
      }
      return json(res, 200, { ok: true });
    } },
    'POST /api/reset-password': { public: true, handler: async ({ req, res }) => {
      if (await limited(res, clientIp(req))) return;
      const b = await readJson(req);
      const hash = b.token ? sha256(String(b.token)) : null;
      const row = hash ? await repo.peekToken('reset', hash) : null;
      const target = row ? await repo.userById(row.user_id) : null;
      const problem = target ? passwordProblem(b.password, target.email) : null;
      if (!target) return json(res, 400, { error: 'invalid or expired link' });
      if (problem) return json(res, 400, { error: problem }); // does NOT consume the token, so the user can retry
      // MFA is never bypassed by email access alone: the second factor is required to reset.
      if (target.totp_enabled && !(await checkSecondFactor(target, b.code))) return json(res, 401, { error: target.totp_enabled && !b.code ? 'mfa_required' : 'invalid_code', mfa: true });
      const uid = await repo.consumeToken('reset', hash);
      if (!uid) return json(res, 400, { error: 'invalid or expired link' });
      const h = hashPw(b.password);
      await repo.setPassword(uid, h.salt, h.hash); // bumps token_version: every existing session dies
      await repo.invalidateTokens(uid, 'reset');
      sendMail(target.email, templates.changed());
      await ctx.audit(req, uid, 'password_reset', uid, {});
      return json(res, 200, { ok: true });
    } },
    'POST /api/change-password': { handler: async ({ req, res, u }) => {
      if (await limited(res, 'acct:' + u.email)) return;
      const b = await readJson(req);
      if (!checkPw(String(b.currentPassword || ''), u)) return json(res, 400, { error: 'current password is incorrect' });
      const problem = passwordProblem(b.newPassword, u.email);
      if (problem) return json(res, 400, { error: problem });
      const h = hashPw(b.newPassword);
      await repo.setPassword(u.id, h.salt, h.hash);
      sendMail(u.email, templates.changed());
      await ctx.audit(req, u.id, 'password_changed', u.id, {});
      const fresh = await repo.userById(u.id);
      return json(res, 200, { ok: true, ...signToken(fresh) });
    } },
    'POST /api/logout-all': { handler: async ({ req, res, u }) => {
      await repo.bumpTokenVersion(u.id);
      await ctx.audit(req, u.id, 'logout_all', u.id, {});
      return json(res, 200, { ok: true });
    } },

    // ---- TOTP MFA ----
    'POST /api/mfa/setup': { handler: async ({ req, res, u }) => {
      if (u.totp_enabled) return json(res, 409, { error: 'mfa already enabled' });
      const b = await readJson(req);
      if (!checkPw(String(b.password || ''), u)) return json(res, 400, { error: 'password is incorrect' });
      const secret = newSecret();
      await repo.setMfa(u.id, { secretEnc: encryptSecret(secret, keys.totp), enabled: false, recoveryHashes: [] });
      return json(res, 200, { secret, otpauthUrl: otpauthUrl(secret, u.email) });
    } },
    'POST /api/mfa/enable': { handler: async ({ req, res, u }) => {
      if (u.totp_enabled) return json(res, 409, { error: 'mfa already enabled' });
      if (!u.totp_secret_enc) return json(res, 400, { error: 'run setup first' });
      const b = await readJson(req);
      const step = verifyTotp(openTotp(u).secret, b.code, {});
      if (!step) return json(res, 400, { error: 'invalid code' });
      const codes = Array.from({ length: 8 }, () => randomBytes(5).toString('hex'));
      await repo.setMfa(u.id, { secretEnc: u.totp_secret_enc, enabled: true, recoveryHashes: codes.map(sha256) });
      await repo.setTotpLastStep(u.id, step);
      await repo.bumpTokenVersion(u.id); // end other sessions that were established without MFA
      sendMail(u.email, templates.mfaOn());
      await ctx.audit(req, u.id, 'mfa_enabled', u.id, {});
      const fresh = await repo.userById(u.id);
      return json(res, 200, { enabled: true, recoveryCodes: codes.map((c) => `${c.slice(0, 5)}-${c.slice(5)}`), ...signToken(fresh) });
    } },
    'POST /api/mfa/disable': { handler: async ({ req, res, u }) => {
      if (!u.totp_enabled) return json(res, 409, { error: 'mfa is not enabled' });
      if (await limited(res, 'acct:' + u.email)) return;
      const b = await readJson(req);
      if (!checkPw(String(b.password || ''), u) || !(await checkSecondFactor(u, b.code))) return json(res, 400, { error: 'password or code is incorrect' });
      await repo.setMfa(u.id, { secretEnc: null, enabled: false, recoveryHashes: [] });
      await repo.bumpTokenVersion(u.id);
      sendMail(u.email, templates.mfaOff());
      await ctx.audit(req, u.id, 'mfa_disabled', u.id, {});
      const fresh = await repo.userById(u.id);
      return json(res, 200, { enabled: false, ...signToken(fresh) });
    } },

    // ---- data-subject rights (GDPR/CCPA) ----
    'GET /api/account/export': { handler: async ({ req, res, u }) => {
      const [campaigns, apps, report, audit] = await Promise.all([repo.campaignsByOwner(u.id), repo.appsByOwner(u.id), repo.report(u.role, u.id), repo.auditList({ actor: u.id, limit: 500 })]);
      await ctx.audit(req, u.id, 'account_exported', u.id, {});
      return json(res, 200, { exportedAt: new Date().toISOString(), account: { id: u.id, email: u.email, role: u.role, emailVerified: !!u.email_verified, mfaEnabled: !!u.totp_enabled, createdAt: u.created_at, termsVersion: u.terms_version || null, termsAcceptedAt: Number(u.terms_accepted_at) || null }, campaigns, apps, report, activityLog: audit },
        { 'Content-Disposition': 'attachment; filename="mobiad-account-export.json"' });
    } },
    'DELETE /api/account': { handler: async ({ req, res, u }) => {
      if (await limited(res, 'acct:' + u.email)) return;
      const b = await readJson(req);
      if (!checkPw(String(b.password || ''), u) || b.confirm !== 'DELETE') return json(res, 400, { error: 'password and confirm:"DELETE" required' });
      if (u.totp_enabled && !(await checkSecondFactor(u, b.code))) return json(res, 400, { error: 'valid MFA code required' });
      // Money owed either way must be settled first: refuse rather than silently destroy a balance.
      if (u.role === 'advertiser') { const bal = await repo.advertiserBalance(u.id); if (bal.creditsMicros - bal.spentMicros > 0) return json(res, 409, { error: 'balance_remaining', detail: 'You have unspent credit. Request a refund from support before deleting your account.' }); }
      if (u.role === 'publisher') { const bal = await repo.publisherBalance(u.id); if (bal.payableMicros + bal.requestedMicros + bal.heldMicros > 0) return json(res, 409, { error: 'earnings_remaining', detail: 'You have unpaid earnings. Request a payout (or contact support) before deleting your account.' }); }
      await ctx.audit(req, u.id, 'account_deleted', u.id, { role: u.role });
      await repo.deleteAccount(u.id);
      await ctx.changed(); // stop serving the deleted account's campaigns/apps on every replica
      return json(res, 200, { deleted: true });
    } },
  };
}
