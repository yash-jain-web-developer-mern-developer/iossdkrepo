// PostgreSQL repository. Works with real `pg` Pool or pg-mem's adapter (dev/test).
import { readFileSync, readdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = fileURLToPath(new URL('../../infra/sql/migrations/', import.meta.url));

export async function createPool(databaseUrl, opts = {}) {
  if (databaseUrl) {
    const pg = await import('pg');
    return new pg.default.Pool({
      connectionString: databaseUrl, max: +process.env.PG_POOL_MAX || 20, connectionTimeoutMillis: 2000, idleTimeoutMillis: 30000,
      statement_timeout: 5000, keepAlive: true, ...(opts.ssl ? { ssl: opts.ssl } : {}),
    });
  }
  const { newDb } = await import('pg-mem');
  const { Pool } = newDb().adapters.createPg();
  return new Pool();
}

const num = (v) => Number(v);
const json = (v, d) => (v == null ? d : typeof v === 'string' ? JSON.parse(v) : v); // pg-mem returns JSONB defaults as strings
const campaignRow = (r) => r && ({
  id: r.id, owner: r.owner, name: r.name, format: r.format, model: r.model, bid: r.bid, budget: r.budget,
  dailyBudget: r.daily_budget, countries: json(r.countries, []), platforms: json(r.platforms, []), endsAt: num(r.ends_at),
  status: r.status, creative: json(r.creative, {}), spent: r.spent, spentToday: 0,
  impressions: num(r.impressions), clicks: num(r.clicks), conversions: num(r.conversions || 0), conversionEvent: r.conversion_event || 'install', attributionDays: num(r.attribution_days || 7),
  reviewStatus: r.review_status, reviewNote: r.review_note, reviewedBy: r.reviewed_by, reviewedAt: num(r.reviewed_at || 0),
  category: r.category, childSafe: !!r.child_safe, freqCap: num(r.freq_cap || 0), targeting: json(r.targeting, {}), creatives: json(r.creatives, []),
});
const appRow = (r) => r && ({
  id: r.id, owner: r.owner, name: r.name, platform: r.platform, floorEcpm: r.floor_ecpm,
  childDirected: !!r.child_directed, blockedCategories: json(r.blocked_categories, []), flagged: !!r.flagged, flagReason: r.flag_reason,
  rewardCallbackUrl: r.reward_callback_url || null, rewardSecret: r.reward_secret || null, rewardAmount: num(r.reward_amount || 1), rewardItem: r.reward_item || 'reward',
});
const userRow = (r) => r && ({ ...r, recovery_hashes: json(r.recovery_hashes, []) });
export const tokenHash = (t) => createHash('sha256').update(t).digest('hex');
const MICROS = 1e6;
const zero = () => ({ impressions: 0, clicks: 0, installs: 0, invalidClicks: 0, videoCompletes: 0, viewables: 0, conversions: 0, conversionValue: 0, spend: 0, publisherRevenue: 0 });
const EVENT_KEY = { impression: 'impressions', click: 'clicks', install: 'installs', invalid_click: 'invalidClicks', video_complete: 'videoCompletes', viewable: 'viewables', conversion: 'conversions' };
const viewability = (o) => (o.impressions ? Math.min(1, o.viewables / o.impressions) : 0); // share of counted impressions that the SDK measured as viewable

export class Repo {
  constructor(pool, { publisherShare = 0.7, payoutHoldDays = 0 } = {}) { this.pool = pool; this.share = publisherShare; this.holdDays = payoutHoldDays; this.counterFailures = 0; this.pending = new Map(); }

  // Versioned, forward-only migrations from infra/sql/migrations/NNN_name.sql. Serialized across replicas with a
  // Postgres advisory lock (no-op on pg-mem). In production run it once as a deploy-time job (scripts/migrate.js).
  async migrate() {
    const conn = this.pool.connect ? await this.acquire() : null, client = conn?.client;
    let locked = false;
    try {
      if (client) { try { await client.query('SELECT pg_advisory_lock(727274)'); locked = true; } catch { /* pg-mem */ } }
      let applied = new Set();
      try { applied = new Set((await this.pool.query('SELECT version FROM schema_migrations')).rows.map((r) => Number(r.version))); }
      catch { await this.pool.query('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)'); }
      const files = readdirSync(MIGRATIONS).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
      const NL = String.fromCharCode(10);
      for (const f of files) {
        const version = parseInt(f, 10);
        if (applied.has(version)) continue;
        const sql = readFileSync(MIGRATIONS + f, 'utf8');
        // strip full-line AND trailing "-- comments" (none of our migrations contain '--' inside string literals)
        const stripComment = (l) => { const i = l.indexOf('--'); return i < 0 ? l : l.slice(0, i); };
        const statements = sql.split(NL).map(stripComment).join(NL).split(';').map((x) => x.split(NL).join(' ').trim()).filter(Boolean);
        for (const stmt of statements) await this.pool.query(stmt);
        await this.pool.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      }
    } finally {
      if (locked) await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
      conn?.release();
    }
  }
  q(text, params) { return this.pool.query(text, params); }

  // Check out a connection SAFELY. node-postgres emits an 'error' event on a checked-out client when the server dies
  // mid-use; with no listener Node throws it as an uncaught exception and kills the whole process (found by SIGKILLing
  // Postgres under load in a real cluster). pool.on('error') only covers IDLE clients, so every checkout needs its own handler.
  async acquire() {
    if (!this.pool.connect) return { client: this.pool, release() {} };
    const client = await this.pool.connect();
    const onError = (e) => this.onClientError?.(e);
    client.on?.('error', onError);
    let released = false;
    return { client, release: (destroy = false) => { if (released) return; released = true; client.removeListener?.('error', onError); client.release?.(destroy); } };
  }

  // ---------- users ----------
  async createUser(u) {
    await this.q('INSERT INTO users (id,email,role,salt,hash,email_verified,terms_version,terms_accepted_at,account_id,team_role) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [u.id, u.email, u.role, u.salt, u.hash, !!u.emailVerified, u.termsVersion || null, u.termsAcceptedAt || 0, u.accountId || null, u.teamRole || null]);
  }
  async userByEmail(email) { return userRow((await this.q('SELECT * FROM users WHERE email=$1', [email])).rows[0]); }
  async userById(id) { return userRow((await this.q('SELECT * FROM users WHERE id=$1', [id])).rows[0]); }
  async setEmailVerified(id) { await this.q('UPDATE users SET email_verified=true WHERE id=$1', [id]); }
  // Changing the password (or "log out everywhere") bumps token_version, which invalidates every previously issued JWT.
  async setPassword(id, salt, hash) { await this.q('UPDATE users SET salt=$2, hash=$3, token_version=token_version+1 WHERE id=$1', [id, salt, hash]); }
  async bumpTokenVersion(id) { await this.q('UPDATE users SET token_version=token_version+1 WHERE id=$1', [id]); }
  async setMfa(id, { secretEnc, enabled, recoveryHashes }) {
    await this.q('UPDATE users SET totp_secret_enc=$2, totp_enabled=$3, recovery_hashes=$4, totp_last_step=0 WHERE id=$1', [id, secretEnc, enabled, JSON.stringify(recoveryHashes || [])]);
  }
  // Atomic and single-use: only succeeds if `step` is newer than the last accepted one (so a code cannot be replayed,
  // even by two concurrent requests).
  async setTotpLastStep(id, step) {
    const r = await this.q('UPDATE users SET totp_last_step=$2 WHERE id=$1 AND totp_last_step<$2 RETURNING id', [id, step]);
    return r.rows.length > 0;
  }
  async setRecoveryHashes(id, hashes) { await this.q('UPDATE users SET recovery_hashes=$2 WHERE id=$1', [id, JSON.stringify(hashes)]); }
  async listUsers(limit = 100) { return (await this.q('SELECT id,email,role,email_verified,totp_enabled,created_at FROM users ORDER BY created_at DESC LIMIT $1', [limit])).rows; }

  // ---------- one-time tokens (email verification, password reset) ----------
  async createToken({ id, userId, purpose, hash, expiresAt }) {
    await this.q('INSERT INTO one_time_tokens (id,user_id,purpose,token_hash,expires_at) VALUES ($1,$2,$3,$4,$5)', [id, userId, purpose, hash, expiresAt]);
  }
  // Look without consuming (used to validate input before spending a single-use token).
  async peekToken(purpose, hash, now = Date.now()) {
    const row = (await this.q('SELECT * FROM one_time_tokens WHERE token_hash=$1 AND purpose=$2', [hash, purpose])).rows[0];
    return row && !row.used_at && num(row.expires_at) >= now ? row : null;
  }
  // Atomic single use: only the first caller flips used_at from NULL.
  async consumeToken(purpose, hash, now = Date.now()) {
    const row = (await this.q('SELECT * FROM one_time_tokens WHERE token_hash=$1 AND purpose=$2', [hash, purpose])).rows[0];
    if (!row || row.used_at || num(row.expires_at) < now) return null;
    const r = await this.q('UPDATE one_time_tokens SET used_at=$2 WHERE id=$1 AND used_at IS NULL RETURNING id', [row.id, now]);
    return r.rows.length ? row.user_id : null;
  }
  async invalidateTokens(userId, purpose, now = Date.now()) { await this.q('UPDATE one_time_tokens SET used_at=$3 WHERE user_id=$1 AND purpose=$2 AND used_at IS NULL', [userId, purpose, now]); }

  // Cheap COUNT(*) gauges for dashboards/alerts (refreshed by the server every 30 s).
  async queueCounts() {
    const n = async (sql) => num((await this.q(sql)).rows[0].n);
    return {
      pendingCampaigns: await n("SELECT COUNT(*) AS n FROM campaigns WHERE review_status='pending'"),
      flaggedApps: await n('SELECT COUNT(*) AS n FROM apps WHERE flagged=true'),
      pendingPayouts: await n("SELECT COUNT(*) AS n FROM payouts WHERE status='requested'"),
      unverifiedUsers: await n('SELECT COUNT(*) AS n FROM users WHERE email_verified=false'),
    };
  }

  // ---------- retention ----------
  // Deletes data that has outlived its purpose. The LEDGER is never touched here (financial records are kept for the legal
  // retention period). Returns how many rows were removed per table.
  async purgeExpired({ tokensOlderThanDays = 30, auditOlderThanDays = 400, now = Date.now() } = {}) {
    const day = 86_400_000;
    const tokens = await this.q('DELETE FROM one_time_tokens WHERE expires_at < $1 RETURNING id', [now - tokensOlderThanDays * day]);
    const audit = await this.q('DELETE FROM audit_log WHERE at < $1 RETURNING id', [now - auditOlderThanDays * day]);
    return { oneTimeTokens: tokens.rows.length, auditLog: audit.rows.length };
  }

  // ---------- team ----------
  async teamMembers(accountId) { return (await this.q('SELECT id,email,team_role,created_at FROM users WHERE account_id=$1 ORDER BY created_at', [accountId])).rows; }
  async teamInvites(accountId, now = Date.now()) { return (await this.q('SELECT id,email,team_role,expires_at FROM team_invites WHERE account_id=$1 AND used_at=0 AND expires_at>$2 ORDER BY created_at', [accountId, now])).rows; }
  async teamCount(accountId) { return (await this.teamMembers(accountId)).length + (await this.teamInvites(accountId)).length; }
  async createInvite(i) { await this.q('INSERT INTO team_invites (id,account_id,email,team_role,token_hash,expires_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [i.id, i.accountId, i.email, i.role, i.hash, i.expiresAt, Date.now()]); }
  async peekInvite(hash, now = Date.now()) {
    const i = (await this.q('SELECT * FROM team_invites WHERE token_hash=$1', [hash])).rows[0];
    return i && !num(i.used_at) && num(i.expires_at) > now ? i : null;
  }
  async consumeInvite(id, now = Date.now()) { return (await this.q('UPDATE team_invites SET used_at=$2 WHERE id=$1 AND used_at=0 RETURNING id', [id, now])).rows.length > 0; }
  async revokeInvite(accountId, id, now = Date.now()) { return (await this.q('UPDATE team_invites SET used_at=$3 WHERE id=$1 AND account_id=$2 AND used_at=0 RETURNING id', [id, accountId, now])).rows.length > 0; }
  async removeMember(accountId, userId) {
    const r = await this.q('DELETE FROM users WHERE id=$1 AND account_id=$2 RETURNING id', [userId, accountId]);
    if (r.rows.length) await this.q('DELETE FROM api_keys WHERE user_id=$1', [userId]);
    return r.rows.length > 0;
  }

  // ---------- API keys ----------
  async createApiKey(k) {
    await this.q('INSERT INTO api_keys (id,user_id,name,scope,key_hash,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [k.id, k.userId, k.name, k.scope, k.hash, Date.now(), k.expiresAt || 0]);
  }
  async listApiKeys(userId) {
    return (await this.q('SELECT id,name,scope,created_at,expires_at,last_used_at,revoked_at FROM api_keys WHERE user_id=$1 ORDER BY created_at DESC', [userId])).rows;
  }
  async activeApiKeyCount(userId, now = Date.now()) {
    return num((await this.q('SELECT COUNT(*) AS n FROM api_keys WHERE user_id=$1 AND revoked_at=0 AND (expires_at=0 OR expires_at>$2)', [userId, now])).rows[0].n);
  }
  // Returns the key row if it exists, is not revoked and not expired. last_used_at is refreshed at most once a minute.
  async apiKeyByHash(hash, now = Date.now()) {
    const k = (await this.q('SELECT * FROM api_keys WHERE key_hash=$1', [hash])).rows[0];
    if (!k || num(k.revoked_at) || (num(k.expires_at) && num(k.expires_at) <= now)) return null;
    if (now - num(k.last_used_at) > 60_000) await this.q('UPDATE api_keys SET last_used_at=$2 WHERE id=$1', [k.id, now]).catch(() => {});
    return k;
  }
  async revokeApiKey(userId, id, now = Date.now()) {
    return (await this.q('UPDATE api_keys SET revoked_at=$3 WHERE id=$1 AND user_id=$2 AND revoked_at=0 RETURNING id', [id, userId, now])).rows.length > 0;
  }

  // ---------- audit ----------
  async audit({ actor = null, action, target = null, detail = {} }) {
    await this.q('INSERT INTO audit_log (at,actor,action,target,detail) VALUES ($1,$2,$3,$4,$5)', [Date.now(), actor, action, target, JSON.stringify(detail)]);
  }
  async auditList({ limit = 200, actor, action } = {}) {
    const where = [], p = [];
    if (actor) { p.push(actor); where.push(`actor=$${p.length}`); }
    if (action) { p.push(action); where.push(`action=$${p.length}`); }
    p.push(limit);
    return (await this.q(`SELECT id,at,actor,action,target,detail FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT $${p.length}`, p)).rows
      .map((r) => ({ ...r, at: num(r.at), detail: json(r.detail, {}) }));
  }

  // ---------- campaigns ----------
  async createCampaign(c) {
    await this.q(`INSERT INTO campaigns (id,owner,name,format,model,bid,budget,daily_budget,countries,platforms,ends_at,status,creative,review_status,category,child_safe,freq_cap,conversion_event,attribution_days,targeting,creatives)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [c.id, c.owner, c.name, c.format, c.model, c.bid, c.budget, c.dailyBudget, JSON.stringify(c.countries),
      JSON.stringify(c.platforms), c.endsAt, c.status, JSON.stringify(c.creative), c.reviewStatus || 'pending', c.category || 'general', !!c.childSafe, c.freqCap || 0, c.conversionEvent || 'install', c.attributionDays || 7, JSON.stringify(c.targeting || {}), JSON.stringify(c.creatives || [])]);
  }
  async campaign(id) { return campaignRow((await this.q('SELECT * FROM campaigns WHERE id=$1', [id])).rows[0]); }
  async campaignsByOwner(owner) { return (await this.q('SELECT * FROM campaigns WHERE owner=$1 ORDER BY created_at DESC', [owner])).rows.map(campaignRow); }
  // Only approved + active campaigns are ever served.
  async servableCampaigns() { return (await this.q("SELECT * FROM campaigns WHERE status='active' AND review_status='approved'")).rows.map(campaignRow); }
  async setCampaignStatus(id, status) { await this.q('UPDATE campaigns SET status=$2 WHERE id=$1', [id, status]); }
  async setReview(id, { status, note, by }) {
    await this.q('UPDATE campaigns SET review_status=$2, review_note=$3, reviewed_by=$4, reviewed_at=$5 WHERE id=$1', [id, status, note || null, by || null, Date.now()]);
  }
  async campaignsByReview(status, limit = 100) {
    return (await this.q('SELECT * FROM campaigns WHERE review_status=$1 ORDER BY created_at ASC LIMIT $2', [status, limit])).rows.map(campaignRow);
  }

  // ---------- apps ----------
  async createApp(a) {
    await this.q('INSERT INTO apps (id,owner,name,platform,floor_ecpm,child_directed,blocked_categories) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [a.id, a.owner, a.name, a.platform, a.floorEcpm, !!a.childDirected, JSON.stringify(a.blockedCategories || [])]);
  }
  async app(id) { return appRow((await this.q('SELECT * FROM apps WHERE id=$1', [id])).rows[0]); }
  async allApps() { return (await this.q('SELECT * FROM apps')).rows.map(appRow); }
  async appsByOwner(owner) { return (await this.q('SELECT * FROM apps WHERE owner=$1', [owner])).rows.map(appRow); }
  async setAppFlag(id, flagged, reason) { await this.q('UPDATE apps SET flagged=$2, flag_reason=$3 WHERE id=$1', [id, !!flagged, flagged ? reason || null : null]); }
  async flaggedApps() { return (await this.q('SELECT * FROM apps WHERE flagged=true')).rows.map(appRow); }

  // Privacy: erasure removes the account and its configuration but KEEPS ledger rows (financial records
  // are retained for tax/audit; they hold only opaque campaign/app ids, no personal data).
  async deleteAccount(userId) {
    await this.q("UPDATE campaigns SET status='paused' WHERE owner=$1 AND status='active'", [userId]);
    await this.q('DELETE FROM placements WHERE app_id IN (SELECT id FROM apps WHERE owner=$1)', [userId]);
    await this.q('DELETE FROM apps WHERE owner=$1', [userId]);
    await this.q('DELETE FROM one_time_tokens WHERE user_id=$1', [userId]);
    await this.q('DELETE FROM api_keys WHERE user_id=$1', [userId]);
    await this.q('DELETE FROM payout_profiles WHERE user_id=$1', [userId]);
    await this.q('DELETE FROM team_invites WHERE account_id=$1', [userId]);
    await this.q('DELETE FROM users WHERE account_id=$1', [userId]);
    await this.q('DELETE FROM users WHERE id=$1', [userId]);
  }

  // ---------- ledger ----------
  // Idempotent: a duplicate token hash violates the UNIQUE constraint and returns false.
  async recordEvent({ type, campaignId, appId, cost, t, token }) {
    const micros = Math.round(cost * 1e6), day = new Date(t).toISOString().slice(0, 10);
    try {
      await this.q(
        'INSERT INTO ledger (campaign_id,app_id,event,amount_micros,token_hash,day,at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [campaignId, appId, type, micros, tokenHash(type + token), day, t]);
    } catch (e) {
      if (e.code === '23505' || /duplicate key|unique/i.test(e.message)) return false; // already recorded
      throw e;
    }
    const col = type === 'impression' ? 'impressions' : type === 'click' ? 'clicks' : null;
    if (col || cost) await this.q(`UPDATE campaigns SET ${col ? `${col}=${col}+1,` : ''} spent=spent+$2 WHERE id=$1`, [campaignId, cost]);
    return true;
  }

  // Batched, transactional write used by the LedgerWriter (one round trip per ~500 events).
  // ON CONFLICT DO NOTHING keeps retries idempotent; counters only move for rows actually inserted.
  async recordBatch(events) {
    if (!events.length) return 0;
    const params = [], tuples = [], meta = [];
    events.forEach((e, i) => {
      const o = i * 11, micros = Math.round(e.cost * 1e6), day = new Date(e.t).toISOString().slice(0, 10), h = tokenHash(e.type + e.token);
      tuples.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9},$${o + 10},$${o + 11})`);
      params.push(e.campaignId, e.appId, e.type, micros, h, day, e.t, e.creativeId || '', e.placementId || '', e.country || '', e.format || '');
      meta.push({ h, e });
    });
    const conn = await this.acquire(), client = conn.client;
    let committed = false, broken = false;
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `INSERT INTO ledger (campaign_id,app_id,event,amount_micros,token_hash,day,at,creative_id,placement_id,country,format) VALUES ${tuples.join(',')} ON CONFLICT (token_hash) DO NOTHING RETURNING token_hash`,
        params);
      const inserted = new Set(r.rows.map((x) => x.token_hash));
      const per = new Map();
      for (const { h, e } of meta) {
        if (!inserted.has(h)) continue;
        const p = per.get(e.campaignId) || { i: 0, c: 0, s: 0, v: 0 };
        if (e.type === 'impression') p.i++; else if (e.type === 'click') p.c++; else if (e.type === 'conversion') p.v++;
        p.s += e.cost;
        per.set(e.campaignId, p);
      }
      await client.query('COMMIT'); // ledger rows are durable here
      committed = true;
      // Per-campaign counters are a hot row: updating them per batch (even outside the insert transaction) made ~500
      // single-row UPDATEs/s queue on one tuple, bloating it until statements hit the timeout. Deltas are accumulated in
      // memory and flushed periodically as ONE update per campaign (see flushCounters). The ledger stays the source of truth.
      for (const [id, p] of per) {
        const d = this.pending.get(id) || { i: 0, c: 0, s: 0, v: 0 };
        d.i += p.i; d.c += p.c; d.s += p.s; d.v += p.v;
        this.pending.set(id, d);
      }
      return inserted.size;
    } catch (e) {
      broken = true; // do not return a possibly-dead connection to the pool
      if (!committed) await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { conn.release(broken); }
  }

  // ---------- webhooks ----------
  async createWebhook(h) { await this.q('INSERT INTO webhooks (id,user_id,url,secret,events,status,failures,created_at) VALUES ($1,$2,$3,$4,$5,$6,0,$7)', [h.id, h.userId, h.url, h.secret, JSON.stringify(h.events || []), 'active', Date.now()]); }
  _hook(r) { return r && { id: r.id, userId: r.user_id, url: r.url, secret: r.secret, events: json(r.events, []), status: r.status, failures: num(r.failures), createdAt: num(r.created_at) }; }
  async webhook(id) { return this._hook((await this.q('SELECT * FROM webhooks WHERE id=$1', [id])).rows[0]); }
  async webhooksByUser(userId) { return (await this.q('SELECT * FROM webhooks WHERE user_id=$1 ORDER BY created_at DESC', [userId])).rows.map((r) => this._hook(r)); }
  async deleteWebhook(userId, id) {
    const r = await this.q('DELETE FROM webhooks WHERE id=$1 AND user_id=$2 RETURNING id', [id, userId]);
    if (r.rows.length) await this.q("UPDATE webhook_deliveries SET status='failed', last_error='webhook deleted' WHERE webhook_id=$1 AND status='pending'", [id]);
    return r.rows.length > 0;
  }
  async hooksFor(userId, event) { return (await this.webhooksByUser(userId)).filter((h) => h.status === 'active' && (!h.events.length || h.events.includes(event))); }
  async enqueueDelivery(d) { await this.q('INSERT INTO webhook_deliveries (id,webhook_id,user_id,event,payload,status,attempts,next_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8)', [d.id, d.webhookId, d.userId, d.event, d.payload, 'pending', 0, Date.now()]); }
  // Lease-based claim: safe with several replicas (only the replica whose UPDATE matches processes the row).
  async claimDueDeliveries(now, limit = 20) {
    const ids = (await this.q("SELECT id FROM webhook_deliveries WHERE status='pending' AND next_at<=$1 ORDER BY next_at LIMIT $2", [now, limit])).rows;
    const out = [];
    for (const { id } of ids) {
      const r = await this.q("UPDATE webhook_deliveries SET attempts=attempts+1, next_at=$2 WHERE id=$1 AND status='pending' AND next_at<=$3 RETURNING *", [id, now + 60_000, now]);
      if (r.rows[0]) out.push({ ...r.rows[0], attempts: num(r.rows[0].attempts) });
    }
    return out;
  }
  async finishDelivery(id, status, error) { await this.q('UPDATE webhook_deliveries SET status=$2, last_error=$3, delivered_at=$4 WHERE id=$1', [id, status, error, status === 'delivered' ? Date.now() : 0]); }
  async retryDelivery(id, nextAt, error) { await this.q("UPDATE webhook_deliveries SET status='pending', next_at=$2, last_error=$3 WHERE id=$1", [id, nextAt, error]); }
  // Returns true when this failure disabled the webhook.
  async noteWebhookResult(id, ok) {
    if (ok) { await this.q('UPDATE webhooks SET failures=0 WHERE id=$1', [id]); return false; }
    const r = await this.q('UPDATE webhooks SET failures=failures+1 WHERE id=$1 RETURNING failures', [id]);
    if (r.rows[0] && num(r.rows[0].failures) >= 20) { await this.q("UPDATE webhooks SET status='disabled' WHERE id=$1", [id]); return true; }
    return false;
  }
  async deliveriesFor(userId, webhookId, limit = 50) { return (await this.q('SELECT * FROM webhook_deliveries WHERE user_id=$1 AND webhook_id=$2 ORDER BY created_at DESC LIMIT $3', [userId, webhookId, limit])).rows; }

  // ---------- invoices and credit notes ----------
  async invoiceByPeriod(userId, period) { return (await this.q('SELECT * FROM invoices WHERE user_id=$1 AND period=$2', [userId, period])).rows[0] || null; }
  async invoice(id) { return (await this.q('SELECT * FROM invoices WHERE id=$1', [id])).rows[0] || null; }
  async invoicesByUser(userId) { return (await this.q('SELECT * FROM invoices WHERE user_id=$1 ORDER BY period DESC', [userId])).rows; }
  async createInvoice({ userId, period, lines, totalMicros, subtotalMicros = null, taxMicros = 0, taxRateBp = 0, taxLabel = null, taxNote = null, seller = null, buyer = null }) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const n = num((await this.q('SELECT COUNT(*) AS n FROM invoices WHERE period=$1', [period])).rows[0].n) + 1 + attempt;
      const inv = { id: 'inv_' + createHash('sha256').update(userId + period).digest('hex').slice(0, 16), number: `INV-${period.replace('-', '')}-${String(n).padStart(4, '0')}`, user_id: userId, period, total_micros: totalMicros, lines: JSON.stringify(lines), issued_at: Date.now(),
        subtotal_micros: subtotalMicros, tax_micros: taxMicros, tax_rate_bp: taxRateBp, tax_label: taxLabel, tax_note: taxNote, seller: seller ? JSON.stringify(seller) : null, buyer: buyer ? JSON.stringify(buyer) : null };
      try { await this.q('INSERT INTO invoices (id,number,user_id,period,total_micros,lines,issued_at,subtotal_micros,tax_micros,tax_rate_bp,tax_label,tax_note,seller,buyer) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)', [inv.id, inv.number, userId, period, totalMicros, inv.lines, inv.issued_at, subtotalMicros, taxMicros, taxRateBp, taxLabel, taxNote, inv.seller, inv.buyer]); return inv; }
      catch (e) { if (!(e.code === '23505' || /duplicate key|unique/i.test(e.message))) throw e; const again = await this.invoiceByPeriod(userId, period); if (again) return again; }
    }
    throw new Error('could not allocate an invoice number');
  }
  async creditNotesByUser(userId) { return (await this.q('SELECT * FROM credit_notes WHERE user_id=$1 ORDER BY issued_at DESC', [userId])).rows; }
  async createCreditNote({ userId, amountMicros, reason, invoiceId, by, taxMicros = 0, taxRateBp = 0 }) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const n = num((await this.q('SELECT COUNT(*) AS n FROM credit_notes')).rows[0].n) + 1 + attempt;
      const cn = { id: 'cn_' + randomBytes(8).toString('hex'), number: `CN-${new Date().toISOString().slice(0, 7).replace('-', '')}-${String(n).padStart(4, '0')}`, amountMicros, taxMicros, taxRateBp };
      try { await this.q('INSERT INTO credit_notes (id,number,user_id,amount_micros,reason,invoice_id,issued_at,issued_by,tax_micros,tax_rate_bp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [cn.id, cn.number, userId, amountMicros, reason, invoiceId, Date.now(), by || null, taxMicros, taxRateBp]); return cn; }
      catch (e) { if (!(e.code === '23505' || /duplicate key|unique/i.test(e.message))) throw e; }
    }
    throw new Error('could not allocate a credit note number');
  }
  // ---------- Stripe Connect accounts (publisher payouts) ----------
  connectRow(r) { return r && { userId: r.user_id, account: r.stripe_account, detailsSubmitted: !!r.details_submitted, payoutsEnabled: !!r.payouts_enabled, chargesEnabled: !!r.charges_enabled, requirements: (() => { try { return JSON.parse(r.requirements || '[]'); } catch { return []; } })(), updatedAt: num(r.updated_at) }; }
  async connectAccount(userId) { return this.connectRow((await this.q('SELECT * FROM connect_accounts WHERE user_id=$1', [userId])).rows[0]); }
  async connectByAccount(account) { return this.connectRow((await this.q('SELECT * FROM connect_accounts WHERE stripe_account=$1', [account])).rows[0]); }
  async createConnectAccount(userId, account) {
    try { await this.q('INSERT INTO connect_accounts (user_id,stripe_account,created_at,updated_at) VALUES ($1,$2,$3,$3)', [userId, account, Date.now()]); return true; }
    catch (e) { if (e.code === '23505' || /duplicate key|unique/i.test(e.message)) return false; throw e; }
  }
  async updateConnectAccount(userId, { detailsSubmitted, payoutsEnabled, chargesEnabled, requirements }) {
    await this.q('UPDATE connect_accounts SET details_submitted=$2, payouts_enabled=$3, charges_enabled=$4, requirements=$5, updated_at=$6 WHERE user_id=$1', [userId, !!detailsSubmitted, !!payoutsEnabled, !!chargesEnabled, JSON.stringify(requirements || []), Date.now()]);
  }

  // ---------- invite-only sign-up ----------
  async createSignupInvite({ id, codeHash, role, email = null, note = null, maxUses = 1, createdBy = null, expiresAt }) {
    await this.q('INSERT INTO signup_invites (id,code_hash,role,email,note,max_uses,used,revoked,created_by,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,0,false,$7,$8,$9)', [id, codeHash, role, email, note, maxUses, createdBy, Date.now(), expiresAt]);
  }
  inviteRow(r) { return r && { ...r, max_uses: Number(r.max_uses), used: Number(r.used), created_at: num(r.created_at), expires_at: num(r.expires_at) }; }
  async signupInviteByHash(codeHash) { return this.inviteRow((await this.q('SELECT * FROM signup_invites WHERE code_hash=$1', [codeHash])).rows[0]); }
  async listSignupInvites(limit = 200) { return (await this.q('SELECT * FROM signup_invites ORDER BY created_at DESC LIMIT $1', [limit])).rows.map((r) => this.inviteRow(r)); }
  async revokeSignupInvite(id) { return (await this.q('UPDATE signup_invites SET revoked=true WHERE id=$1', [id])).rowCount > 0; }
  // One atomic step: only succeeds while the code is unrevoked, unexpired and has uses left (two simultaneous sign-ups cannot both win the last use).
  async consumeSignupInvite(codeHash, now = Date.now()) { return (await this.q('UPDATE signup_invites SET used=used+1 WHERE code_hash=$1 AND revoked=false AND expires_at>$2 AND used<max_uses', [codeHash, now])).rowCount > 0; }
  async releaseSignupInvite(codeHash) { await this.q('UPDATE signup_invites SET used = used - 1 WHERE code_hash=$1 AND used>0', [codeHash]); }

  // ---------- payment lifecycle, disputes, billing profile ----------
  async billingProfile(userId) {
    const r = (await this.q('SELECT * FROM billing_profiles WHERE user_id=$1', [userId])).rows[0];
    return { legalName: r?.legal_name || '', address: r?.address || '', country: r?.country || '', taxId: r?.tax_id || '' };
  }
  async saveBillingProfile(userId, p) {
    const args = [userId, p.legalName, p.address, p.country, p.taxId, Date.now()];
    const u = await this.q('UPDATE billing_profiles SET legal_name=$2, address=$3, country=$4, tax_id=$5, updated_at=$6 WHERE user_id=$1', args);
    if (!u.rowCount) await this.q('INSERT INTO billing_profiles (user_id,legal_name,address,country,tax_id,updated_at) VALUES ($1,$2,$3,$4,$5,$6)', args);
  }
  paymentRow(r) { return r && { ...r, amount_micros: num(r.amount_micros), refunded_micros: num(r.refunded_micros), created_at: num(r.created_at), updated_at: num(r.updated_at) }; }
  async payment(id) { return this.paymentRow((await this.q('SELECT * FROM payments WHERE id=$1', [id])).rows[0]); }
  async paymentBySession(sessionId) { return this.paymentRow((await this.q('SELECT * FROM payments WHERE session_id=$1', [sessionId])).rows[0]); }
  async paymentByIntent(intent) { return intent ? this.paymentRow((await this.q('SELECT * FROM payments WHERE payment_intent=$1 ORDER BY created_at DESC LIMIT 1', [intent])).rows[0]) : null; }
  // The newest Stripe attempt still waiting for an outcome for this amount (a failed card attempt carries the user and amount, not the session).
  async pendingPaymentFor(userId, amountMicros) { return this.paymentRow((await this.q("SELECT * FROM payments WHERE user_id=$1 AND provider='stripe' AND status IN ('pending','failed') AND amount_micros=$2 ORDER BY created_at DESC LIMIT 1", [userId, amountMicros])).rows[0]); }
  async paymentsByUser(userId, limit = 50) { return (await this.q('SELECT * FROM payments WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2', [userId, limit])).rows.map((r) => this.paymentRow(r)); }
  async allPayments(limit = 200) {
    return (await this.q('SELECT p.*, u.email AS email FROM payments p LEFT JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC LIMIT $1', [limit])).rows.map((r) => ({ ...this.paymentRow(r), email: r.email }));
  }
  async createPayment({ id, userId, provider, sessionId = null, paymentIntent = null, amountMicros, status = 'pending' }) {
    const now = Date.now();
    try { await this.q('INSERT INTO payments (id,user_id,provider,session_id,payment_intent,amount_micros,refunded_micros,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$8)', [id, userId, provider, sessionId, paymentIntent, amountMicros, status, now]); return true; }
    catch (e) { if (e.code === '23505' || /duplicate key|unique/i.test(e.message)) return false; throw e; }
  }
  async updatePayment(id, patch) {
    const map = { status: 'status', failure: 'failure', paymentIntent: 'payment_intent', refundedMicros: 'refunded_micros', amountMicros: 'amount_micros' };
    const sets = [], vals = [id];
    for (const [k, col] of Object.entries(map)) if (k in patch) { vals.push(patch[k]); sets.push(`${col}=$${vals.length}`); }
    vals.push(Date.now()); sets.push(`updated_at=$${vals.length}`);
    await this.q(`UPDATE payments SET ${sets.join(', ')} WHERE id=$1`, vals);
  }
  // Park an event whose payment we cannot match yet; replay it later with takeDeferredEvents(paymentIntent).
  async deferStripeEvent({ id, paymentIntent, payload }) {
    await this.q('DELETE FROM stripe_deferred WHERE created_at < $1', [Date.now() - 3 * 86_400_000]); // events for payments that are not ours expire
    try { await this.q('INSERT INTO stripe_deferred (id,payment_intent,payload,created_at) VALUES ($1,$2,$3,$4)', [id, paymentIntent, JSON.stringify(payload), Date.now()]); return true; }
    catch (e) { if (e.code === '23505' || /duplicate key|unique/i.test(e.message)) return false; throw e; }
  }
  async takeDeferredEvents(paymentIntent) {
    const rows = (await this.q('SELECT id, payload FROM stripe_deferred WHERE payment_intent=$1 ORDER BY created_at, id', [paymentIntent])).rows;
    for (const r of rows) await this.q('DELETE FROM stripe_deferred WHERE id=$1', [r.id]);
    return rows.map((r) => (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload));
  }
  async dispute(id) { const r = (await this.q('SELECT * FROM disputes WHERE id=$1', [id])).rows[0]; return r && { ...r, amount_micros: num(r.amount_micros), created_at: num(r.created_at), closed_at: r.closed_at == null ? null : num(r.closed_at) }; }
  async createDispute({ id, paymentId, userId, amountMicros, reason, status }) {
    try { await this.q('INSERT INTO disputes (id,payment_id,user_id,amount_micros,reason,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, paymentId, userId, amountMicros, reason, status, Date.now()]); return true; }
    catch (e) { if (e.code === '23505' || /duplicate key|unique/i.test(e.message)) return false; throw e; }
  }
  async setDisputeEvidence(id, status, by) { await this.q('UPDATE disputes SET evidence_status=$2, evidence_at=$3, evidence_by=$4 WHERE id=$1', [id, status, Date.now(), by]); }
  async closeDispute(id, status) { await this.q('UPDATE disputes SET status=$2, closed_at=$3 WHERE id=$1', [id, status, Date.now()]); }
  async allDisputes(limit = 200) {
    return (await this.q('SELECT d.*, u.email AS email FROM disputes d LEFT JOIN users u ON u.id=d.user_id ORDER BY d.created_at DESC LIMIT $1', [limit])).rows.map((r) => ({ ...r, amount_micros: num(r.amount_micros), created_at: num(r.created_at), closed_at: r.closed_at == null ? null : num(r.closed_at) }));
  }

  async publisherIds(limit = 50000) { return (await this.q("SELECT id FROM users WHERE role='publisher' AND account_id IS NULL ORDER BY created_at LIMIT $1", [limit])).rows.map((r) => r.id); }

  // ---------- demand partners ----------
  async createPartner(p) {
    await this.q('INSERT INTO demand_partners (id,name,endpoint_url,auth_header,timeout_ms,formats,child_safe,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [p.id, p.name, p.endpointUrl, p.authHeader || null, p.timeoutMs, JSON.stringify(p.formats), !!p.childSafe, 'active', Date.now()]);
  }
  async partners() {
    const rows = (await this.q('SELECT * FROM demand_partners ORDER BY created_at DESC')).rows;
    const stats = (await this.q("SELECT campaign_id, COUNT(*) AS n, SUM(amount_micros) AS micros FROM ledger WHERE campaign_id LIKE 'ext_%' AND event='impression' GROUP BY campaign_id")).rows;
    return rows.map((r) => { const st = stats.find((x) => x.campaign_id === 'ext_' + r.id); return { id: r.id, name: r.name, endpointUrl: r.endpoint_url, hasAuth: !!r.auth_header, timeoutMs: Number(r.timeout_ms), formats: json(r.formats, []), childSafe: !!r.child_safe, status: r.status, impressions: st ? num(st.n) : 0, grossUsd: st ? num(st.micros) / MICROS : 0 }; });
  }
  async activePartners() {
    return (await this.q("SELECT * FROM demand_partners WHERE status='active'")).rows.map((r) => ({ id: r.id, name: r.name, endpointUrl: r.endpoint_url, authHeader: r.auth_header, timeoutMs: Number(r.timeout_ms), formats: json(r.formats, []), childSafe: !!r.child_safe }));
  }
  async setPartnerStatus(id, status) { return (await this.q('UPDATE demand_partners SET status=$2 WHERE id=$1 RETURNING id', [id, status])).rows.length > 0; }

  // ---------- apps: rewarded video, placements ----------
  async setAppReward(appId, { url, secret, amount, item }) {
    await this.q('UPDATE apps SET reward_callback_url=$2, reward_secret=COALESCE($3, reward_secret), reward_amount=$4, reward_item=$5 WHERE id=$1', [appId, url, secret || null, amount, item]);
  }
  async createPlacement(p) { await this.q('INSERT INTO placements (id,app_id,name,format,floor_ecpm,created_at) VALUES ($1,$2,$3,$4,$5,$6)', [p.id, p.appId, p.name, p.format, p.floorEcpm, Date.now()]); }
  async allPlacements() { return (await this.q('SELECT * FROM placements')).rows.map((r) => ({ id: r.id, appId: r.app_id, name: r.name, format: r.format, floorEcpm: Number(r.floor_ecpm) })); }
  async placementsByOwner(owner) {
    return (await this.q('SELECT p.* FROM placements p JOIN apps a ON a.id=p.app_id WHERE a.owner=$1 ORDER BY p.created_at DESC', [owner])).rows.map((r) => ({ id: r.id, appId: r.app_id, name: r.name, format: r.format, floorEcpm: Number(r.floor_ecpm) }));
  }
  async setCampaignCreatives(id, creatives, creative) { await this.q('UPDATE campaigns SET creatives=$2, creative=$3 WHERE id=$1', [id, JSON.stringify(creatives), JSON.stringify(creative)]); }

  // Breakdown report: rows per dimension value. Advertisers: campaign|app|creative|country|format. Publishers: app|placement|country|format.
  async breakdown(role, ownerId, by) {
    const adv = role === 'advertiser';
    const dims = { campaign: 'l.campaign_id', app: 'l.app_id', creative: 'l.creative_id', placement: 'l.placement_id', country: 'l.country', format: 'l.format' };
    const allowed = adv ? ['campaign', 'app', 'creative', 'country', 'format'] : ['app', 'placement', 'country', 'format'];
    if (!allowed.includes(by)) return null;
    const own = adv ? 'campaigns' : 'apps', ownCol = adv ? 'campaign_id' : 'app_id';
    const rows = (await this.q(`SELECT ${dims[by]} AS k, l.event, COUNT(*) AS n, SUM(l.amount_micros) AS micros FROM ledger l JOIN ${own} t ON t.id=l.${ownCol} WHERE t.owner=$1 GROUP BY ${dims[by]}, l.event`, [ownerId])).rows;
    const names = new Map();
    if (by === 'campaign') for (const c of await this.campaignsByOwner(ownerId)) names.set(c.id, c.name);
    if (by === 'app' && !adv) for (const a of await this.appsByOwner(ownerId)) names.set(a.id, a.name);
    const out = new Map();
    for (const r of rows) {
      const k = r.k || '(none)', o = out.get(k) || { key: k, name: names.get(k) || k, ...zero() };
      const key = EVENT_KEY[r.event] || 'installs', spend = num(r.micros) / MICROS;
      o[key] += num(r.n); o.spend += spend; o.publisherRevenue += spend * this.share; out.set(k, o);
    }
    return [...out.values()].map((o) => ({ ...o, spend: +o.spend.toFixed(6), publisherRevenue: +o.publisherRevenue.toFixed(6), conversionValue: undefined, ctr: o.impressions ? o.clicks / o.impressions : 0, viewability: viewability(o) }))
      .map((o) => (adv ? { ...o, publisherRevenue: undefined } : { ...o, spend: undefined, conversions: undefined })).sort((a, b) => (b.impressions - a.impressions));
  }

  // Conversion details. Returns true only for the first insert of a given (click, event, eventId): the gate for one-time side effects.
  async recordConversion(c) {
    try {
      await this.q('INSERT INTO conversions (id,campaign_id,app_id,event,event_id,value_micros,token_hash,day,at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [c.id, c.campaignId, c.appId, c.event, c.eventId || '', Math.round((c.value || 0) * 1e6), c.hash, new Date(c.at).toISOString().slice(0, 10), c.at]);
      return true;
    } catch (e) {
      if (e.code === '23505' || /duplicate key|unique/i.test(e.message)) return false; // already recorded
      throw e;
    }
  }
  async conversionValueByDay(ownerId) {
    return (await this.q('SELECT v.day, SUM(v.value_micros) AS micros FROM conversions v JOIN campaigns c ON c.id=v.campaign_id WHERE c.owner=$1 GROUP BY v.day', [ownerId])).rows;
  }

  // Apply accumulated counter deltas. A failed update KEEPS its delta and is retried on the next flush (not lost).
  async flushCounters() {
    for (const [id, d] of [...this.pending]) {
      this.pending.delete(id); // take ownership; new deltas for this campaign accumulate separately meanwhile
      try {
        await this.q('UPDATE campaigns SET impressions=impressions+$2, clicks=clicks+$3, spent=spent+$4, conversions=conversions+$5 WHERE id=$1', [id, d.i, d.c, d.s, d.v || 0]);
      } catch (e) {
        const cur = this.pending.get(id) || { i: 0, c: 0, s: 0, v: 0 };
        this.pending.set(id, { i: cur.i + d.i, c: cur.c + d.c, s: cur.s + d.s, v: cur.v + (d.v || 0) });
        this.counterFailures++; this.lastCounterError = e.message; this.onCounterError?.(e, id);
      }
    }
  }
  startCounterFlush(ms = 1000) {
    this.counterTimer = setInterval(() => this.flushCounters().catch(() => {}), ms);
    this.counterTimer.unref();
  }
  async close() { clearInterval(this.counterTimer); await this.flushCounters().catch(() => {}); await this.pool.end?.(); }

  // Rebuild the denormalized campaign counters from the ledger (source of truth). Safe to run at any time.
  async reconcileCounters() {
    const rows = (await this.q(
      `SELECT campaign_id, event, COUNT(*) AS n, SUM(amount_micros) AS micros FROM ledger GROUP BY campaign_id, event`)).rows;
    const agg = new Map();
    for (const r of rows) {
      const a = agg.get(r.campaign_id) || { i: 0, k: 0, micros: 0 };
      if (r.event === 'impression') a.i += num(r.n); else if (r.event === 'click') a.k += num(r.n);
      a.micros += num(r.micros);
      agg.set(r.campaign_id, a);
    }
    for (const [id, a] of agg) {
      await this.q('UPDATE campaigns SET impressions=$2, clicks=$3, spent=$4 WHERE id=$1', [id, a.i, a.k, a.micros / 1e6]);
    }
    return agg.size;
  }

  // ---------- reports ----------
  // role=advertiser groups by campaign owner, publisher by app owner. Invalid (fraudulent) clicks are counted
  // separately and carry zero cost, so they never inflate clicks/CTR or spend.
  async report(role, ownerId) {
    const idCol = role === 'advertiser' ? 'campaign_id' : 'app_id';
    const tbl = role === 'advertiser' ? 'campaigns' : 'apps';
    const rows = (await this.q(
      `SELECT l.day, l.event, COUNT(*) AS n, SUM(l.amount_micros) AS micros
       FROM ledger l JOIN ${tbl} t ON t.id = l.${idCol} WHERE t.owner=$1 GROUP BY l.day, l.event`, [ownerId])).rows;
    const total = zero(), daily = {};
    for (const r of rows) {
      const d = (daily[r.day] ||= zero());
      const key = EVENT_KEY[r.event] || 'installs';
      const spend = num(r.micros) / MICROS;
      for (const o of [d, total]) { o[key] += num(r.n); o.spend += spend; o.publisherRevenue += spend * this.share; }
    }
    if (role === 'advertiser') for (const r of await this.conversionValueByDay(ownerId)) { const v = num(r.micros) / MICROS; (daily[r.day] ||= zero()).conversionValue += v; total.conversionValue += v; }
    const fin = (o) => ({ ...o, conversionValue: +o.conversionValue.toFixed(6), spend: +o.spend.toFixed(6), publisherRevenue: +o.publisherRevenue.toFixed(6), ctr: o.impressions ? o.clicks / o.impressions : 0, viewability: viewability(o) });
    return { total: fin(total), daily: Object.fromEntries(Object.entries(daily).sort().map(([k, v]) => [k, fin(v)])) };
  }
  async statsFor(role, ownerId) {
    const idCol = role === 'advertiser' ? 'campaign_id' : 'app_id';
    const tbl = role === 'advertiser' ? 'campaigns' : 'apps';
    const rows = (await this.q(
      `SELECT l.${idCol} AS id, l.event, COUNT(*) AS n, SUM(l.amount_micros) AS micros
       FROM ledger l JOIN ${tbl} t ON t.id = l.${idCol} WHERE t.owner=$1 GROUP BY l.${idCol}, l.event`, [ownerId])).rows;
    const out = {};
    for (const r of rows) {
      const s = (out[r.id] ||= { impressions: 0, clicks: 0, installs: 0, invalidClicks: 0, videoCompletes: 0, viewables: 0, conversions: 0, spend: 0 });
      s[EVENT_KEY[r.event] || 'installs'] += num(r.n);
      s.spend += num(r.micros) / MICROS;
    }
    return out;
  }
  // Monthly statement rows for invoices/CSV: [{ day, id, name, impressions, clicks, installs, invalidClicks, spend }].
  async statement(role, ownerId, month) {
    const [y, m] = month.split('-').map(Number);
    const start = `${month}-01`, next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const idCol = role === 'advertiser' ? 'campaign_id' : 'app_id', tbl = role === 'advertiser' ? 'campaigns' : 'apps';
    const rows = (await this.q(
      `SELECT l.day, l.${idCol} AS id, t.name, l.event, COUNT(*) AS n, SUM(l.amount_micros) AS micros
       FROM ledger l JOIN ${tbl} t ON t.id = l.${idCol}
       WHERE t.owner=$1 AND l.day >= $2 AND l.day < $3 GROUP BY l.day, l.${idCol}, t.name, l.event`, [ownerId, start, next])).rows;
    const out = new Map();
    for (const r of rows) {
      const k = r.day + '|' + r.id;
      const o = out.get(k) || { day: r.day, id: r.id, name: r.name, impressions: 0, clicks: 0, installs: 0, invalidClicks: 0, videoCompletes: 0, viewables: 0, conversions: 0, spend: 0 };
      o[EVENT_KEY[r.event] || 'installs'] += num(r.n); o.spend += num(r.micros) / MICROS;
      out.set(k, o);
    }
    return [...out.values()].sort((a, b) => (a.day + a.id).localeCompare(b.day + b.id));
  }
  // Per-app click-through stats over all time (used by the fraud scorer).
  async appTraffic(appId) {
    const rows = (await this.q('SELECT event, COUNT(*) AS n FROM ledger WHERE app_id=$1 GROUP BY event', [appId])).rows;
    const o = { impressions: 0, clicks: 0, invalidClicks: 0 };
    for (const r of rows) { const k = EVENT_KEY[r.event]; if (k in o) o[k] = num(r.n); }
    return o;
  }

  // ---------- billing ----------
  // Idempotent on providerRef: a retried webhook cannot credit twice. Returns false if already applied.
  async addWalletEntry({ id, userId, kind, amountMicros, provider = null, providerRef = null, note = null }) {
    try {
      await this.q('INSERT INTO wallet_entries (id,user_id,kind,amount_micros,provider,provider_ref,note,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, userId, kind, amountMicros, provider, providerRef, note, Date.now()]);
      return true;
    } catch (e) {
      if (e.code === '23505' || /duplicate key|unique/i.test(e.message)) return false;
      throw e;
    }
  }
  async walletEntries(userId, limit = 200) {
    return (await this.q('SELECT * FROM wallet_entries WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2', [userId, limit])).rows
      .map((r) => ({ ...r, amount_micros: num(r.amount_micros), created_at: num(r.created_at) }));
  }
  // Advertiser balance sheet, all derived from append-only tables (no balance row to contend on):
  //   credits  = SUM(wallet_entries)            spent = SUM(ledger.amount for the user's campaigns)
  //   reserved = unspent budget of campaigns that can still spend (active/paused/pending review)
  //   available = credits - spent - reserved    (a new campaign's budget must fit in `available`)
  async advertiserBalance(userId) {
    const credits = num((await this.q('SELECT COALESCE(SUM(amount_micros),0) AS s FROM wallet_entries WHERE user_id=$1', [userId])).rows[0].s);
    const camps = await this.campaignsByOwner(userId);
    const st = await this.statsFor('advertiser', userId);
    let spent = 0, reserved = 0;
    for (const c of camps) {
      const s = Math.round((st[c.id]?.spend || 0) * MICROS);
      spent += s;
      if (['active', 'paused'].includes(c.status) && c.reviewStatus !== 'rejected') reserved += Math.max(0, Math.round(c.budget * MICROS) - s);
    }
    return { creditsMicros: credits, spentMicros: spent, reservedMicros: reserved, availableMicros: credits - spent - reserved };
  }
  // Publisher earnings: share of billed spend on their apps. Flagged apps are held (not payable) until cleared.
  async publisherBalance(userId) {
    const apps = await this.appsByOwner(userId);
    const st = await this.statsFor('publisher', userId);
    let earned = 0, held = 0;
    const perApp = apps.map((a) => {
      const e = Math.round((st[a.id]?.spend || 0) * MICROS * this.share);
      if (a.flagged) held += e; else earned += e;
      return { id: a.id, name: a.name, earnedMicros: e, held: a.flagged };
    });
    const pay = (await this.q('SELECT status, COALESCE(SUM(amount_micros),0) AS s FROM payouts WHERE user_id=$1 GROUP BY status', [userId])).rows;
    const sum = (s) => num(pay.find((r) => r.status === s)?.s || 0);
    const paid = sum('paid'), requested = sum('requested') + sum('approved'); // approved payouts are still reserved until paid
    // Paid and requested money comes out of total earnings first, so a flag raised after a payout can only hold what is still unpaid.
    const unpaid = Math.max(0, earned + held - paid - requested), heldNow = Math.min(held, unpaid);
    // Hold period: earnings of the last holdDays days (today included) are not payable yet; chargebacks and refunds on the advertiser side usually arrive within that time.
    let recent = 0;
    if (this.holdDays > 0 && apps.length) {
      const from = new Date(Date.now() - (this.holdDays - 1) * 86_400_000).toISOString().slice(0, 10);
      const r = (await this.q(`SELECT COALESCE(SUM(l.amount_micros),0) AS s FROM ledger l JOIN apps a ON a.id = l.app_id WHERE a.owner=$1 AND a.flagged=false AND l.day >= $2`, [userId, from])).rows[0];
      recent = Math.round(num(r?.s || 0) * this.share);
    }
    const pendingNow = Math.min(recent, Math.max(0, unpaid - heldNow));
    return { earnedMicros: earned, heldMicros: heldNow, paidMicros: paid, requestedMicros: requested, pendingMicros: pendingNow, payableMicros: Math.max(0, unpaid - heldNow - pendingNow), perApp };
  }
  async createPayout({ id, userId, amountMicros }) {
    await this.q('INSERT INTO payouts (id,user_id,amount_micros,status,created_at) VALUES ($1,$2,$3,$4,$5)', [id, userId, amountMicros, 'requested', Date.now()]);
  }
  async payouts({ userId, status, limit = 200 } = {}) {
    const where = [], p = [];
    if (userId) { p.push(userId); where.push(`user_id=$${p.length}`); }
    if (status) { p.push(status); where.push(`status=$${p.length}`); }
    p.push(limit);
    return (await this.q(`SELECT * FROM payouts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT $${p.length}`, p)).rows
      .map((r) => ({ ...r, amount_micros: num(r.amount_micros), created_at: num(r.created_at), resolved_at: num(r.resolved_at) }));
  }
  // State machine: requested -> approved | rejected; approved -> paid | rejected. Each step is atomic (the UPDATE only matches the expected current state).
  async transitionPayout(id, to, { note, reference, by } = {}) {
    const from = { approved: ['requested'], rejected: ['requested', 'approved'], paid: ['approved'] }[to];
    if (!from) return false;
    const now = Date.now();
    const sql = to === 'approved'
      ? 'UPDATE payouts SET status=$2, note=COALESCE($3,note), approved_at=$4, resolved_by=$5 WHERE id=$1 AND status=ANY($6) RETURNING id'
      : 'UPDATE payouts SET status=$2, note=COALESCE($3,note), resolved_at=$4, resolved_by=$5, reference=COALESCE($7,reference) WHERE id=$1 AND status=ANY($6) RETURNING id';
    const r = await this.q(sql, to === 'approved' ? [id, to, note || null, now, by || null, from] : [id, to, note || null, now, by || null, from, reference || null]);
    return r.rows.length > 0;
  }
  async payout(id) { return (await this.q('SELECT * FROM payouts WHERE id=$1', [id])).rows[0] || null; }

  // ---------- payout profiles (status only; no documents or tax IDs are stored) ----------
  async payoutProfile(userId) {
    const r = (await this.q('SELECT * FROM payout_profiles WHERE user_id=$1', [userId])).rows[0];
    return r ? { ...r, updated_at: num(r.updated_at) } : { user_id: userId, legal_name: '', country: '', method: '', method_ref: '', kyc_status: 'none', tax_status: 'none', review_note: null, updated_at: 0 };
  }
  async savePayoutProfile(userId, p) {
    const cur = await this.payoutProfile(userId), exists = cur.updated_at > 0;
    // Changing who gets paid or where invalidates earlier verification.
    const identityChanged = exists && (cur.legal_name !== p.legalName || cur.country !== p.country);
    const kyc = identityChanged ? 'none' : cur.kyc_status, tax = identityChanged ? 'none' : cur.tax_status;
    if (exists) await this.q('UPDATE payout_profiles SET legal_name=$2,country=$3,method=$4,method_ref=$5,kyc_status=$6,tax_status=$7,updated_at=$8 WHERE user_id=$1', [userId, p.legalName, p.country, p.method, p.methodRef, kyc, tax, Date.now()]);
    else await this.q('INSERT INTO payout_profiles (user_id,legal_name,country,method,method_ref,kyc_status,tax_status,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [userId, p.legalName, p.country, p.method, p.methodRef, 'none', 'none', Date.now()]);
    return { identityChanged };
  }
  // Publisher says they completed the external process; only none/rejected -> submitted is allowed.
  async submitVerification(userId, kind) {
    const col = kind === 'kyc' ? 'kyc_status' : 'tax_status';
    const r = await this.q(`UPDATE payout_profiles SET ${col}='submitted', updated_at=$2 WHERE user_id=$1 AND ${col} IN ('none','rejected') RETURNING user_id`, [userId, Date.now()]);
    return r.rows.length > 0;
  }
  async reviewVerification(userId, kind, status, note) {
    const col = kind === 'kyc' ? 'kyc_status' : 'tax_status';
    const r = await this.q(`UPDATE payout_profiles SET ${col}=$2, review_note=$3, updated_at=$4 WHERE user_id=$1 AND ${col}='submitted' RETURNING user_id`, [userId, status, note || null, Date.now()]);
    return r.rows.length > 0;
  }
  // Stripe Connect onboarding verifies identity and collects tax details itself: record both as verified (creating the profile row if needed).
  async markVerifiedByProvider(userId, note) {
    const u = await this.q("UPDATE payout_profiles SET kyc_status='verified', tax_status='verified', method='stripe_connect', review_note=$2, updated_at=$3 WHERE user_id=$1", [userId, note, Date.now()]);
    if (!u.rowCount) await this.q("INSERT INTO payout_profiles (user_id,legal_name,country,method,method_ref,kyc_status,tax_status,review_note,updated_at) VALUES ($1,'','','stripe_connect','','verified','verified',$2,$3)", [userId, note, Date.now()]);
  }
  async payoutProfiles(status) {
    const rows = (await this.q(`SELECT p.*, u.email FROM payout_profiles p JOIN users u ON u.id=p.user_id ${status ? "WHERE p.kyc_status=$1 OR p.tax_status=$1" : ''} ORDER BY p.updated_at DESC LIMIT 200`, status ? [status] : [])).rows;
    return rows.map((r) => ({ ...r, updated_at: num(r.updated_at) }));
  }
}
