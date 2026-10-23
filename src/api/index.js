// Control-plane router. Routes live in focused modules; each route declares what it needs:
//   public: no login · role: required role · verified: email must be verified · admin: MFA-enabled admin (when configured)
import { json, jwtVerify, readRaw, readJson } from '../http.js';
import { randomBytes } from 'node:crypto';
import { authRoutes } from './auth.js';
import { campaignRoutes } from './campaigns.js';
import { adminRoutes } from './admin.js';
import { billingRoutes } from './billing.js';
import { teamRoutes } from './team.js';
import { extrasRoutes } from './extras.js';
import { sha256, id, newOneTimeToken } from './util.js';

// What an API key may do. Never: key management, login/MFA/password, funding, payouts, admin. 'read' keys get GETs only.
const KEY_READ = new Set(['GET /api/me', 'GET /api/campaigns', 'GET /api/apps', 'GET /api/report', 'GET /api/report.csv', 'GET /api/billing/summary', 'GET /api/billing/statement', 'GET /api/report/breakdown', 'GET /api/placements', 'GET /api/billing/invoices', 'GET /api/billing/invoice', 'GET /api/billing/credit-notes', 'GET /api/ads-txt']);
const KEY_WRITE = new Set(['POST /api/campaigns', 'POST /api/campaigns/status', 'POST /api/apps', 'POST /api/campaigns/creative', 'POST /api/placements']);
const MAX_KEYS = 10;
// Team members act on the owner's data through the allowlists above (admin: read + write, viewer: read only); these routes act on the member's OWN login.
const MEMBER_SELF = new Set(['GET /api/me', 'POST /api/logout-all', 'POST /api/change-password', 'POST /api/mfa/setup', 'POST /api/mfa/enable', 'POST /api/mfa/disable', 'GET /api/account/export', 'DELETE /api/account']);

export function api(ctx) {
  const { repo, catalog, cfg, keys } = ctx;
  // Queue a webhook event for every active subscription of the user. Never fails the caller.
  ctx.emit ||= async (userId, event, data = {}) => {
    try {
      for (const h of await repo.hooksFor(userId, event)) await repo.enqueueDelivery({ id: 'dlv_' + randomBytes(8).toString('hex'), webhookId: h.id, userId, event, payload: JSON.stringify({ id: 'evt_' + randomBytes(8).toString('hex'), event, createdAt: Date.now(), data }) });
    } catch (e) { ctx.log?.error('webhook enqueue failed', { event, err: e.message }); }
  };
  ctx.changed = async () => { await catalog.refresh(); await ctx.notify.publish(); };
  // Best-effort audit trail: never fail a request because the audit insert failed, but do log it loudly.
  ctx.audit = async (req, actor, action, target, detail = {}) => {
    try { await repo.audit({ actor, action, target, detail }); } catch (e) { ctx.log?.error('audit write failed', { action, err: e.message }); }
  };

  const health = {
    'GET /healthz': { public: true, handler: async ({ res }) => json(res, 200, { ok: true }) },
    'GET /readyz': { public: true, handler: async ({ res }) => {
      // Ad serving runs from the in-process catalog, so a Postgres outage must NOT drain every pod:
      // report degraded (HTTP 200) and let alerts fire from /metrics. 503 only if we never loaded the catalog.
      if (!catalog.loaded) return json(res, 503, { ready: false, reason: 'catalog not loaded' });
      try { await Promise.race([repo.q('SELECT 1'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1000))]); return json(res, 200, { ready: true, db: 'ok' }); }
      catch { return json(res, 200, { ready: true, db: 'down', mode: 'degraded' }); }
    } },
  };
  const keyRoutes = {
    'POST /api/keys': { verified: true, handler: async ({ req, res, u, viaKey }) => {
      if (viaKey) return json(res, 403, { error: 'API keys cannot manage API keys' });
      const b = await readJson(req);
      const name = String(b.name || '').trim().slice(0, 80), scope = b.scope === 'write' ? 'write' : b.scope === 'read' || b.scope == null ? 'read' : null;
      if (!name || !scope) return json(res, 400, { error: 'name required; scope must be read or write' });
      if (u.role === 'admin') return json(res, 403, { error: 'admin accounts cannot create API keys' });
      const days = b.expiresInDays == null ? 0 : Number(b.expiresInDays);
      if (!Number.isFinite(days) || days < 0 || days > 730) return json(res, 400, { error: 'expiresInDays must be 0-730' });
      if ((await repo.activeApiKeyCount(u.id)) >= MAX_KEYS) return json(res, 409, { error: `at most ${MAX_KEYS} active keys` });
      const kid = id('key'), secret = newOneTimeToken(), expiresAt = days ? Date.now() + days * 86_400_000 : 0;
      await repo.createApiKey({ id: kid, userId: u.id, name, scope, hash: sha256(secret), expiresAt });
      await ctx.audit(req, u.id, 'api_key_created', kid, { name, scope });
      return json(res, 201, { id: kid, name, scope, expiresAt, key: `mak_${kid}_${secret}`, note: 'Store this key now; it cannot be shown again.' });
    } },
    'GET /api/keys': { handler: async ({ res, u, viaKey }) => viaKey ? json(res, 403, { error: 'API keys cannot manage API keys' }) : json(res, 200, (await repo.listApiKeys(u.id)).map((k) => ({ id: k.id, name: k.name, scope: k.scope, createdAt: +k.created_at, expiresAt: +k.expires_at, lastUsedAt: +k.last_used_at, revoked: +k.revoked_at > 0 }))) },
    'POST /api/keys/revoke': { handler: async ({ req, res, u, viaKey }) => {
      if (viaKey) return json(res, 403, { error: 'API keys cannot manage API keys' });
      const b = await readJson(req);
      if (!(await repo.revokeApiKey(u.id, String(b.id || '')))) return json(res, 404, { error: 'no such active key' });
      await ctx.audit(req, u.id, 'api_key_revoked', String(b.id), {});
      return json(res, 200, { ok: true });
    } },
  };
  const routes = { ...health, ...keyRoutes, ...authRoutes(ctx), ...campaignRoutes(ctx), ...adminRoutes(ctx), ...billingRoutes(ctx), ...teamRoutes(ctx), ...extrasRoutes(ctx) };

  // A JWT is valid only while its token_version matches the user's: password change / reset / MFA change / logout-all revoke every session.
  // API keys: "mak_<id>_<secret>" in the Authorization header. Returns { u, key } or null.
  const userFromKey = async (bearer) => {
    const m = bearer.match(/^mak_(key_[0-9a-f]{16})_([A-Za-z0-9_-]{43})$/);
    if (!m) return null;
    const k = await repo.apiKeyByHash(sha256(m[2]));
    if (!k || k.id !== m[1]) return null;
    const u = await repo.userById(k.user_id);
    return u && u.role !== 'admin' && !u.account_id ? { u, key: k } : null;
  };
  const userFromReq = async (req) => {
    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
    const c = jwtVerify(bearer, keys.jwt) || (keys.jwtPrev ? jwtVerify(bearer, keys.jwtPrev) : null);
    if (!c) return null;
    const u = await repo.userById(c.sub);
    return u && (u.token_version || 0) === (c.tv || 0) ? u : null;
  };

  const handle = async function handle(req, res, url) {
    const r = routes[`${req.method} ${url.pathname}`];
    if (!r) return url.pathname.startsWith('/api/') ? json(res, 404, { error: 'not found' }) : false;
    let u = null, viaKey = false;
    if (!r.public) {
      const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (bearer.startsWith('mak_')) {
        const k = await userFromKey(bearer);
        if (!k) return json(res, 401, { error: 'unauthenticated' });
        const rk = `${req.method} ${url.pathname}`;
        if (!KEY_READ.has(rk) && !(k.key.scope === 'write' && KEY_WRITE.has(rk))) return json(res, 403, { error: 'this API key is not allowed to call this endpoint' });
        u = k.u; viaKey = true;
      } else u = await userFromReq(req);
      if (!u) return json(res, 401, { error: 'unauthenticated' });
      if (u.account_id && !viaKey) {
        const rk = `${req.method} ${url.pathname}`, owner = await repo.userById(u.account_id);
        if (!owner) return json(res, 401, { error: 'unauthenticated' });
        if (!MEMBER_SELF.has(rk)) {
          if (!KEY_READ.has(rk) && !(u.team_role === 'admin' && KEY_WRITE.has(rk))) return json(res, 403, { error: 'team members cannot call this endpoint' });
          if (req.method !== 'GET') await ctx.audit(req, u.id, 'team_member_action', owner.id, { route: rk });
          u = owner;
        }
      }
      if (r.role && u.role !== r.role) return json(res, 403, { error: `${r.role} only` });
      if (r.verified && cfg.requireEmailVerification && !u.email_verified) return json(res, 403, { error: 'email_not_verified', detail: 'Verify your email address to continue.' });
      if (r.admin && cfg.requireAdminMfa && !u.totp_enabled) return json(res, 403, { error: 'mfa_required', detail: 'Admin accounts must enable two-factor authentication.' });
    }
    return r.handler({ req, res, url, u, viaKey });
  };
  handle.routeKeys = Object.keys(routes); // used by the OpenAPI coverage test
  return handle;
}
export { sha256, readRaw };
