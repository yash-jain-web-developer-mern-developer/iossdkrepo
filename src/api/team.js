// Team members: an account owner invites colleagues who sign in with their own credentials and act on the owner's
// campaigns/apps/reports. Roles: `admin` (read + create/edit campaigns and apps) and `viewer` (read only).
// Members can never fund, pay out, manage the team or API keys; only owners can.
import { json, readJson, hashPw, jwtSign, clientIp } from '../http.js';
import { templates } from '../auth/mailer.js';
import { id, EMAIL, sha256, newOneTimeToken, passwordProblem } from './util.js';

const MAX_TEAM = 10, INVITE_TTL = 7 * 86_400_000, ROLES = ['admin', 'viewer'];

export function teamRoutes(ctx) {
  const { repo, cfg, keys, mailer, log } = ctx;
  const limited = async (res, k) => { if (!(await ctx.authLimiter.allow(k))) { json(res, 429, { error: 'rate limited' }); return true; } return false; };

  return {
    'GET /api/team': { handler: async ({ res, u }) => {
      const [members, invites] = await Promise.all([repo.teamMembers(u.id), repo.teamInvites(u.id)]);
      return json(res, 200, {
        members: members.map((m) => ({ id: m.id, email: m.email, role: m.team_role, joinedAt: +m.created_at })),
        invites: invites.map((i) => ({ id: i.id, email: i.email, role: i.team_role, expiresAt: +i.expires_at })),
      });
    } },

    'POST /api/team/invite': { verified: true, handler: async ({ req, res, u }) => {
      if (u.role === 'admin') return json(res, 403, { error: 'admin accounts cannot have a team' });
      const b = await readJson(req), email = String(b.email || '').trim().toLowerCase();
      if (!EMAIL.test(email) || !ROLES.includes(b.role)) return json(res, 400, { error: 'valid email and role (admin|viewer) required' });
      if (await limited(res, 'invite:' + u.id)) return;
      if ((await repo.teamCount(u.id)) >= MAX_TEAM) return json(res, 409, { error: `at most ${MAX_TEAM} team members and pending invites` });
      if (await repo.userByEmail(email)) return json(res, 409, { error: 'already_registered', detail: 'That email already has a MobiAd account.' });
      const tok = newOneTimeToken(), iid = id('inv');
      await repo.createInvite({ id: iid, accountId: u.id, email, role: b.role, hash: sha256(tok), expiresAt: Date.now() + INVITE_TTL });
      mailer.send({ to: email, ...templates.teamInvite(u.email, b.role, `${cfg.publicUrl}/app#invite=${tok}`) }).catch((e) => log?.error('email send failed', { err: e.message, to: email }));
      await ctx.audit(req, u.id, 'team_invited', iid, { email, role: b.role });
      return json(res, 201, { id: iid, email, role: b.role });
    } },

    'POST /api/team/accept': { public: true, handler: async ({ req, res }) => {
      if (await limited(res, clientIp(req))) return;
      const b = await readJson(req);
      const inv = b.token ? await repo.peekInvite(sha256(String(b.token))) : null;
      if (!inv) return json(res, 400, { error: 'invalid or expired invitation' });
      const problem = passwordProblem(b.password, inv.email);
      if (problem) return json(res, 400, { error: problem });
      if (cfg.requireTermsAcceptance && b.acceptTerms !== true) return json(res, 400, { error: 'terms_not_accepted', detail: 'You must accept the Terms of Service and Privacy Policy.' });
      const owner = await repo.userById(inv.account_id);
      if (!owner) return json(res, 400, { error: 'invalid or expired invitation' });
      if (!(await repo.consumeInvite(inv.id))) return json(res, 400, { error: 'invalid or expired invitation' });
      const accepted = b.acceptTerms === true;
      const m = { id: id('usr'), email: inv.email, role: owner.role, ...hashPw(b.password), emailVerified: true, termsVersion: accepted ? cfg.termsVersion : null, termsAcceptedAt: accepted ? Date.now() : 0, accountId: owner.id, teamRole: inv.team_role };
      try { await repo.createUser(m); } catch (e) { if (/unique|duplicate/i.test(e.message)) return json(res, 409, { error: 'email exists' }); throw e; }
      await ctx.audit(req, m.id, 'team_joined', owner.id, { role: inv.team_role });
      return json(res, 201, { token: jwtSign({ sub: m.id, tv: 0 }, keys.jwt), role: m.role, email: m.email, teamRole: m.teamRole });
    } },

    'POST /api/team/remove': { handler: async ({ req, res, u }) => {
      const b = await readJson(req), target = String(b.id || '');
      const ok = target.startsWith('inv_') ? await repo.revokeInvite(u.id, target) : await repo.removeMember(u.id, target);
      if (!ok) return json(res, 404, { error: 'no such member or invitation' });
      await ctx.audit(req, u.id, 'team_removed', target, {});
      return json(res, 200, { ok: true });
    } },
  };
}
