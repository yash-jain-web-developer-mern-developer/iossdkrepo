// Hot-state ports. Memory adapters = single instance (dev/test). Redis adapters = multi-instance production.
// All methods are async so the two are interchangeable.
const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

export class MemoryDeduper {
  constructor(max = 200000) { this.seen = new Set(); this.max = max; }
  async has(k) { return this.seen.has(k); }
  async firstTime(k) {
    if (this.seen.has(k)) return false;
    if (this.seen.size >= this.max) this.seen.clear();
    this.seen.add(k);
    return true;
  }
}
export class MemoryCounters {
  constructor() { this.m = new Map(); }
  // Increment a counter that expires ttlSec after its first increment; returns the new value.
  async incr(key, ttlSec) {
    const now = Date.now(), e = this.m.get(key);
    if (!e || e.exp < now) { this.m.set(key, { n: 1, exp: now + ttlSec * 1000 }); if (this.m.size > 200000) this.m.clear(); return 1; }
    return ++e.n;
  }
  async get(key) { const e = this.m.get(key); return e && e.exp >= Date.now() ? e.n : 0; }
}
export class MemoryLimiter {
  constructor(limit, windowMs) { this.limit = limit; this.windowMs = windowMs; this.hits = new Map(); }
  async allow(key, now = Date.now()) {
    const h = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    const ok = h.length < this.limit;
    if (ok) h.push(now);
    this.hits.set(key, h);
    return ok;
  }
}
export class MemorySpend {
  constructor() { this.m = new Map(); }
  async add(id, cost) {
    const t = this.m.get(id) || { total: 0, today: 0, day: day() };
    if (t.day !== day()) { t.today = 0; t.day = day(); }
    t.total += cost; t.today += cost;
    this.m.set(id, t);
    return { total: t.total, today: t.today };
  }
  async get(id) { const t = this.m.get(id); return t && t.day === day() ? { total: t.total, today: t.today } : { total: t?.total || 0, today: 0 }; }
}

export class RedisDeduper {
  constructor(redis, ttlSec = 86400) { this.r = redis; this.ttl = ttlSec; }
  async firstTime(k) { return (await this.r.set('dd:' + k, '1', 'EX', this.ttl, 'NX')) === 'OK'; }
  async has(k) { return (await this.r.exists('dd:' + k)) === 1; }
}
export class RedisLimiter {
  constructor(redis, limit, windowMs, name = 'default') { this.r = redis; this.name = name; this.limit = limit; this.windowSec = Math.ceil(windowMs / 1000); }
  async allow(key) {
    const k = `rl:${this.name}:${key}:${Math.floor(Date.now() / 1000 / this.windowSec)}`;
    const n = await this.r.incr(k);
    if (n === 1) await this.r.expire(k, this.windowSec * 2);
    return n <= this.limit;
  }
}
export class RedisCounters {
  constructor(redis) { this.r = redis; }
  async incr(key, ttlSec) { const k = 'ct:' + key, n = await this.r.incr(k); if (n === 1) await this.r.expire(k, ttlSec); return n; }
  async get(key) { return +(await this.r.get('ct:' + key)) || 0; }
}
export class RedisSpend {
  constructor(redis) { this.r = redis; }
  async add(id, cost) {
    const d = day();
    const total = await this.r.incrbyfloat(`sp:${id}`, cost);
    const today = await this.r.incrbyfloat(`sd:${id}:${d}`, cost);
    await this.r.expire(`sd:${id}:${d}`, 172800);
    return { total: +total, today: +today };
  }
  async get(id) {
    const [t, d] = await this.r.mget(`sp:${id}`, `sd:${id}:${day()}`);
    return { total: +t || 0, today: +d || 0 };
  }
}

// Circuit breaker: a Redis outage must degrade ad serving, never stop it.
// Every call has a hard timeout; after `failures` consecutive errors the breaker opens for `openMs`
// and calls go straight to the local fallback (per-replica memory), then it probes Redis again.
export class Breaker {
  constructor({ failures = 3, openMs = 2000, timeoutMs = 250, onChange } = {}) {
    Object.assign(this, { failures, openMs, timeoutMs, onChange, fails: 0, openUntil: 0, trips: 0, open: false });
  }
  async run(fn, fallback) {
    if (this.openUntil > Date.now()) return fallback();
    let timer;
    try {
      const r = await Promise.race([fn(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('redis timeout')), this.timeoutMs); })]);
      this.fails = 0;
      if (this.open) { this.open = false; this.onChange?.(false); }
      return r;
    } catch {
      if (++this.fails >= this.failures) {
        this.openUntil = Date.now() + this.openMs; this.fails = 0; this.trips++;
        if (!this.open) { this.open = true; this.onChange?.(true); }
      }
      return fallback();
    } finally { clearTimeout(timer); }
  }
}
// Wraps a Redis-backed port with a breaker and a memory fallback of the same shape.
const guarded = (breaker, primary, fallback, methods) => Object.fromEntries(
  methods.map((m) => [m, (...a) => breaker.run(() => primary[m](...a), () => fallback[m](...a))]));

export async function createHotState(redisUrl, { rateLimit = 600, onDegraded } = {}) {
  if (!redisUrl) {
    return { deduper: new MemoryDeduper(), limiter: new MemoryLimiter(rateLimit, 60_000), authLimiter: new MemoryLimiter(20, 60_000), strictLimiter: new MemoryLimiter(5, 3_600_000), counters: new MemoryCounters(), spend: new MemorySpend(),
      notify: { publish: async () => {}, subscribe: () => {} }, status: () => ({ redis: 'none', trips: 0 }), close: async () => {} };
  }
  const { default: Redis } = await import('ioredis');
  const r = new Redis(redisUrl, {
    maxRetriesPerRequest: 1, enableOfflineQueue: false, commandTimeout: 300, connectTimeout: 1500,
    retryStrategy: (n) => Math.min(2000, 100 * n), // keep reconnecting forever, capped backoff
  });
  r.on('error', () => {}); // outages surface per-command via the breaker; avoid unhandled 'error' events
  const breaker = new Breaker({ onChange: onDegraded });
  let sub = null;
  return {
    deduper: guarded(breaker, new RedisDeduper(r), new MemoryDeduper(), ['firstTime', 'has']),
    counters: guarded(breaker, new RedisCounters(r), new MemoryCounters(), ['incr', 'get']),
    strictLimiter: guarded(breaker, new RedisLimiter(r, 5, 3_600_000, 'strict'), new MemoryLimiter(5, 3_600_000), ['allow']),
    limiter: guarded(breaker, new RedisLimiter(r, rateLimit, 60_000, 'ad'), new MemoryLimiter(rateLimit, 60_000), ['allow']),
    authLimiter: guarded(breaker, new RedisLimiter(r, 20, 60_000, 'auth'), new MemoryLimiter(20, 60_000), ['allow']),
    spend: guarded(breaker, new RedisSpend(r), new MemorySpend(), ['add', 'get']),
    redis: r,
    // Cross-replica catalog invalidation: control-plane writes publish; every replica refreshes immediately.
    notify: {
      publish: () => r.publish('mobiad:catalog', '1').catch(() => {}),
      subscribe: (fn) => {
        sub = r.duplicate({ enableOfflineQueue: true });
        sub.on('error', () => {});
        sub.subscribe('mobiad:catalog').catch(() => {}); // ioredis re-subscribes automatically after reconnects
        sub.on('message', fn);
      },
    },
    status: () => ({ redis: breaker.open ? 'degraded' : 'ok', trips: breaker.trips }),
    close: async () => { await r.quit().catch(() => r.disconnect()); if (sub) sub.disconnect(); },
  };
}
