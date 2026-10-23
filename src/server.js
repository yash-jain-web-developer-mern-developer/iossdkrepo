// Composition root. Control plane + ad plane in one process for dev/small deployments;
// in production run N replicas behind a load balancer (all shared state is in Postgres/Redis).
import http from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { startWebhookWorker } from './core/webhooks.js';
import { createLogger, Metrics } from './obs.js';
import { createPool, Repo } from './db/repo.js';
import { createHotState } from './core/ports.js';
import { Catalog } from './core/catalog.js';
import { LedgerWriter } from './core/ledgerWriter.js';
import { createKafka } from './core/kafka.js';
import { deriveKey } from './core/token.js';
import { adServer } from './adserver/index.js';
import { api } from './api/index.js';
import { createMailer } from './auth/mailer.js';
import { scanApps } from './fraud.js';
import { json, setTrustedHops } from './http.js';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const MIME = { '.txt': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp4': 'video/mp4', '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.ico': 'image/x-icon' };
const SECURITY = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

// Dependencies (Postgres/Redis) may still be starting; wait instead of crashing.
async function untilReady(name, fn, log, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  for (let n = 1; ; n++) {
    try { return await fn(); } catch (e) {
      if (Date.now() > end) throw new Error(name + ' not ready after ' + timeoutMs + 'ms: ' + e.message);
      log.warn('waiting for ' + name, { attempt: n, err: e.message });
      await new Promise((r) => setTimeout(r, Math.min(5000, 250 * n)));
    }
  }
}

export async function createApp(overrides = {}) {
  const cfg = { ...loadConfig(), ...overrides };
  if (!cfg.secret) {
    if (cfg.prod) throw new Error('MOBIAD_SECRET required');
    cfg.secret = randomBytes(32).toString('hex');
  }
  const log = overrides.log || createLogger(process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'error' : 'info'));
  setTrustedHops(cfg.trustProxyHops);
  const metrics = new Metrics();
  // Pre-register counters at 0. A counter that does not exist yet cannot show a 0 -> 1 transition, so increase()-based
  // alerts (dead letters, fallbacks, invalid clicks...) would silently miss the FIRST event, and dashboards would say "No data".
  for (const n of ['mobiad_kafka_produced_total', 'mobiad_kafka_consumed_total', 'mobiad_kafka_fallback_total', 'mobiad_kafka_dlq_total', 'mobiad_kafka_consumer_errors_total', 'mobiad_freqcap_skips_total']) metrics.inc(n, {}, 0);
  metrics.inc('mobiad_partner_requests_total', { partner: 'none', result: 'none' }, 0);
  for (const result of ['delivered', 'error']) metrics.inc('mobiad_webhook_deliveries_total', { result }, 0);
  for (const result of ['ok', 'rejected', 'failed', 'skipped']) metrics.inc('mobiad_reward_callbacks_total', { result }, 0);
  for (const reason of ['self_click', 'no_impression', 'too_fast', 'stale', 'ip_rate']) metrics.inc('mobiad_invalid_clicks_total', { reason }, 0);
  for (const kind of ['i', 'c', 'x']) for (const result of ['counted', 'duplicate', 'invalid']) metrics.inc('mobiad_tracking_total', { kind, result }, 0);
  for (const filled of ['true', 'false']) metrics.inc('mobiad_ad_requests_total', { filled }, 0);
  const pool = overrides.pool || (await createPool(cfg.databaseUrl, { ssl: cfg.databaseSsl ? { rejectUnauthorized: true } : undefined }));
  // Idle clients error out when Postgres restarts; without a handler Node would crash the whole process.
  pool.on?.('error', (e) => log.error('postgres pool error', { err: e.message }));
  const repo = new Repo(pool, { publisherShare: cfg.publisherShare, payoutHoldDays: cfg.payoutHoldDays });
  repo.onClientError = (e) => log.error('postgres client error (connection dropped; will retry)', { err: e.message });
  repo.onCounterError = (e, id) => log.warn('campaign counter update failed (ledger is intact; run scripts/reconcile.js)', { err: e.message, campaign: id });
  await untilReady('postgres', () => repo.migrate(), log);
  repo.startCounterFlush(1000);
  const hot = await createHotState(cfg.redisUrl, { rateLimit: cfg.rateLimit || 600, onDegraded: (d) => log[d ? 'error' : 'info'](d ? 'redis degraded: using local fallbacks' : 'redis recovered') });
  const catalog = new Catalog({ repo, spend: hot.spend, refreshMs: cfg.catalogRefreshMs, log });
  await untilReady('catalog', () => catalog.refresh(), log);
  const ledger = new LedgerWriter({ repo, log });
  // With Kafka: events are durable before the tracker answers, and a consumer writes them to Postgres.
  const kafka = cfg.kafkaBrokers.length ? await createKafka(cfg, { repo, fallback: ledger, log, metrics }) : null;
  const sink = kafka ? kafka.sink : ledger;
  const keys = { jwt: deriveKey(cfg.secret, 'jwt'), track: deriveKey(cfg.secret, 'tracking'), totp: deriveKey(cfg.secret, 'totp') };
  // Secret rotation: while MOBIAD_SECRET_PREVIOUS is set, tokens and encrypted MFA secrets made under the old secret still work
  // (MFA secrets are re-encrypted with the new key on first use), so rotating does not log everyone out or lock MFA users out.
  if (cfg.previousSecret) Object.assign(keys, { jwtPrev: deriveKey(cfg.previousSecret, 'jwt'), trackPrev: deriveKey(cfg.previousSecret, 'tracking'), totpPrev: deriveKey(cfg.previousSecret, 'totp') });
  const mailer = overrides.mailer || (await createMailer({ smtpUrl: cfg.smtpUrl, from: cfg.mailFrom, log }));
  const state = { publicUrl: cfg.publicUrl, shuttingDown: false };

  const emit = async (userId, event, data = {}) => { try { for (const h of await repo.hooksFor(userId, event)) await repo.enqueueDelivery({ id: 'dlv_' + randomBytes(8).toString('hex'), webhookId: h.id, userId, event, payload: JSON.stringify({ id: 'evt_' + randomBytes(8).toString('hex'), event, createdAt: Date.now(), data }) }); } catch (e) { log.error('webhook enqueue failed', { event, err: e.message }); } };
  const ads = adServer({ emit, catalog, ledger: sink, deduper: hot.deduper, counters: hot.counters, limiter: hot.limiter, spend: hot.spend, secret: keys.track, secretPrev: keys.trackPrev, getPublicUrl: () => state.publicUrl, repo, metrics, log, isDegraded: () => hot.status().redis === 'degraded', allowPrivateCallbacks: cfg.allowPrivateCallbacks, tcfVendorId: cfg.tcfVendorId });
  const ctl = api({ emit, repo, catalog, ledger, keys, cfg: { ...cfg, publicUrl: cfg.publicUrl }, authLimiter: hot.authLimiter, strictLimiter: hot.strictLimiter, notify: hot.notify, mailer, log, metrics });
  // Fraud scan: flags apps with abnormal CTR / invalid-click share for human review (idempotent, safe on every replica).
  const webhookWorker = startWebhookWorker({ repo, log, metrics, allowPrivate: cfg.allowPrivateCallbacks, intervalMs: cfg.webhookIntervalMs || 2000 });
  const fraudTimer = setInterval(() => scanApps(repo, { audit: (a) => repo.audit(a) }).catch((e) => log.error('fraud scan failed', { err: e.message })), cfg.fraudScanMs);
  fraudTimer.unref();
  hot.notify.subscribe(() => catalog.requestRefresh());

  async function serveStatic(req, res, url) {
    if (req.method !== 'GET') return false;
    let rel;
    try { rel = url.pathname === '/' ? 'index.html' : url.pathname === '/app' ? 'app.html' : ['/privacy', '/terms', '/help'].includes(url.pathname) ? url.pathname.slice(1) + '.html' : decodeURIComponent(url.pathname.slice(1)); } catch { return false; } // malformed %-escape
    if (rel.includes(String.fromCharCode(0))) return false;
    const file = path.resolve(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) return false;
    try {
      const body = await readFile(file);
      if (path.extname(file) === '.mp4') { // video players ask for byte ranges (seeking, buffering)
        const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || ''), size = body.length;
        const h = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400' };
        if (m && (m[1] || m[2])) {
          let a = m[1] ? +m[1] : size - +m[2], z = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1; if (a < 0) a = 0;
          if (a >= size || a > z) { res.writeHead(416, { ...h, 'Content-Range': `bytes */${size}` }); res.end(); return true; }
          res.writeHead(206, { ...h, 'Content-Range': `bytes ${a}-${z}/${size}`, 'Content-Length': z - a + 1 }); res.end(body.subarray(a, z + 1)); return true;
        }
        res.writeHead(200, { ...h, 'Content-Length': size }); res.end(body); return true;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': /\.(html|js|css)$/.test(file) ? 'no-cache' : 'public, max-age=86400' }); // code must never be stale after a deploy
      res.end(body);
      return true;
    } catch { return false; }
  }

  // ---- metrics ----
  const loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable();
  const gauges = { pendingCampaigns: 0, flaggedApps: 0, pendingPayouts: 0, unverifiedUsers: 0 };
  const refreshGauges = () => repo.queueCounts().then((c) => Object.assign(gauges, c)).catch(() => {}); // DB outage: keep last values
  refreshGauges();
  const gaugeTimer = setInterval(refreshGauges, 30_000); gaugeTimer.unref();
  const tokenOk = (hdr) => { const a = createHash('sha256').update(String(hdr || '')).digest(), b = createHash('sha256').update('Bearer ' + cfg.metricsToken).digest(); return timingSafeEqual(a, b); };
  const g = (name, help, value, type = 'gauge') => '# HELP ' + name + ' ' + help + NL + '# TYPE ' + name + ' ' + type + NL + name + ' ' + value + NL;
  const NL = String.fromCharCode(10);
  const scrape = () => {
    const mem = process.memoryUsage(), p = hot.status();
    const out = metrics.render()
      + g('mobiad_ledger_written_total', 'Events written to the Postgres ledger by this process.', ledger.written, 'counter')
      + g('mobiad_ledger_queue', 'Events waiting in the in-memory ledger queue.', ledger.queue.length)
      + g('mobiad_ledger_failed_total', 'Failed ledger write attempts (retried).', ledger.failed, 'counter')
      + g('mobiad_ledger_dropped_total', 'Events dropped because the queue was full (billing data loss).', ledger.dropped, 'counter')
      + g('mobiad_counter_update_failures_total', 'Failed campaign counter flushes (retried).', repo.counterFailures, 'counter')
      + g('mobiad_redis_degraded', '1 while Redis is unavailable and local fallbacks are in use.', p.redis === 'degraded' ? 1 : 0)
      + g('mobiad_redis_breaker_trips_total', 'Times the Redis circuit breaker opened.', p.trips, 'counter')
      + (kafka ? g('mobiad_kafka_consumer_up', '1 while the ledger consumer of this pod is joined to the group and consuming.', kafka.consumerStatus().consuming ? 1 : 0)
        + g('mobiad_kafka_consumer_restarts_total', 'Times the supervisor rebuilt the ledger consumer of this pod.', kafka.consumerStatus().restarts, 'counter') : '')
      + g('mobiad_campaigns_pending_review', 'Campaigns waiting for manual review.', gauges.pendingCampaigns)
      + g('mobiad_apps_flagged', 'Apps flagged for invalid traffic (earnings held).', gauges.flaggedApps)
      + g('mobiad_payouts_pending', 'Publisher payout requests awaiting an admin.', gauges.pendingPayouts)
      + g('mobiad_process_resident_memory_bytes', 'Resident set size.', mem.rss)
      + g('mobiad_process_heap_used_bytes', 'V8 heap used.', mem.heapUsed)
      + g('mobiad_process_uptime_seconds', 'Process uptime.', Math.round(process.uptime()))
      + g('mobiad_eventloop_lag_p99_seconds', 'p99 event-loop delay since the last scrape.', (loop.percentile(99) / 1e9).toFixed(6))
      + g('mobiad_db_pool_total', 'Postgres pool connections.', pool.totalCount ?? 0)
      + g('mobiad_db_pool_idle', 'Idle Postgres pool connections.', pool.idleCount ?? 0)
      + g('mobiad_db_pool_waiting', 'Requests waiting for a Postgres connection.', pool.waitingCount ?? 0)
      + g('mobiad_build_info', 'Build information.', 1) .replace('mobiad_build_info 1', 'mobiad_build_info{version="' + VERSION + '",node="' + process.version + '"} 1');
    loop.reset();
    return out;
  };

  const server = http.createServer(async (req, res) => {
    const t0 = process.hrtime.bigint();
    const rid = randomBytes(6).toString('hex');
    for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
    // Dashboard and API responses are same-origin only; the ad plane (SDK calls, tracking pixels, bidder, sellers.json) is meant to be fetched cross-origin.
    res.setHeader('Cross-Origin-Resource-Policy', /^\/(v1|t|rtb)\/|^\/sellers\.json/.test(req.url) ? 'cross-origin' : 'same-origin');
    res.setHeader('X-Request-Id', rid);
    const origin = req.headers.origin;
    if (origin && cfg.corsOrigins.includes(origin)) {
      // nosemgrep: cors-misconfiguration -- the origin is only echoed after an exact match against the operator-configured CORS_ORIGINS allowlist.
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
      res.setHeader('Vary', 'Origin');
    }
    // SDK ad requests come from apps (no browser origin); allow any origin for /v1/ad only.
    // nosemgrep: cors-misconfiguration -- intentional: /v1/ad is a public, credential-free endpoint called from SDKs (including web); no cookies or ambient auth are involved.
    if (req.url.startsWith('/v1/ad')) res.setHeader('Access-Control-Allow-Origin', '*');
    res.on('finish', () => {
      const dt = Number(process.hrtime.bigint() - t0) / 1e9;
      const route = req.url.startsWith('/t/') ? '/t/*' : req.url.split('?')[0].startsWith('/api/') ? req.url.split('?')[0] : req.url.startsWith('/v1/') ? '/v1/ad' : req.url.startsWith('/rtb/') ? '/rtb/bid' : 'other';
      metrics.inc('mobiad_http_requests_total', { route, status: res.statusCode });
      metrics.observe('mobiad_http_duration_seconds', { route }, dt);
      if (res.statusCode >= 500) log.error('request failed', { rid, status: res.statusCode, path: req.url.split('?')[0] });
    });
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if (state.shuttingDown) { res.setHeader('Connection', 'close'); }
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/metrics') {
        if (cfg.metricsToken && !tokenOk(req.headers.authorization)) return json(res, 401, { error: 'unauthorized' });
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
        return res.end(scrape());
      }
      if ((await ads(req, res, url)) !== false) return;
      if ((await ctl(req, res, url)) !== false) return;
      if (await serveStatic(req, res, url)) return;
      json(res, 404, { error: 'not found' });
    } catch (e) {
      const client = e.message === 'bad json' || e.message === 'too large';
      if (!res.headersSent) json(res, e.message === 'too large' ? 413 : client ? 400 : 500, { error: client ? e.message : 'internal error' });
      if (!client) log.error('unhandled', { rid, err: e.message, stack: e.stack });
    }
  });
  server.keepAliveTimeout = 65_000; // above typical LB idle timeout
  server.headersTimeout = 66_000;
  server.requestTimeout = 15_000;

  catalog.start();
  async function close() {
    state.shuttingDown = true;
    clearInterval(fraudTimer); webhookWorker.stop(); clearInterval(gaugeTimer); loop.disable();
    catalog.stop();
    await new Promise((r) => { server.close(r); server.closeIdleConnections?.(); setTimeout(() => { server.closeAllConnections?.(); }, 5000).unref(); });
    await kafka?.close();
    await ledger.flush(10_000);
    await hot.close();
    await repo.close();
  }
  return { server, repo, catalog, ledger, metrics, mailer, cfg, webhookWorker, close, setPublicUrl: (u) => { state.publicUrl = u; } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await createApp();
  const log = createLogger();
  app.server.listen(app.cfg.port, () => log.info('listening', { port: app.cfg.port, db: app.cfg.databaseUrl ? 'postgres' : 'in-memory', redis: !!app.cfg.redisUrl, kafka: app.cfg.kafkaBrokers.length > 0 }));
  const stop = async (sig) => { log.info('shutdown', { sig }); await app.close(); process.exit(0); };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}
