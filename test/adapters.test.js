import test from 'node:test';
import assert from 'node:assert/strict';
import RedisMock from 'ioredis-mock';
import { RedisDeduper, RedisLimiter, RedisSpend, MemoryDeduper, MemoryLimiter, MemorySpend } from '../src/core/ports.js';
import { LedgerWriter } from '../src/core/ledgerWriter.js';
import { Metrics } from '../src/obs.js';

// The same contract must hold for the memory and Redis adapters.
const contracts = {
  memory: () => ({ d: new MemoryDeduper(), l: new MemoryLimiter(3, 60000), s: new MemorySpend() }),
  redis: () => { const r = new RedisMock(); return { d: new RedisDeduper(r), l: new RedisLimiter(r, 3, 60000), s: new RedisSpend(r), r }; },
};
for (const [name, make] of Object.entries(contracts)) {
  test(`${name}: deduper allows first occurrence only`, async () => {
    const { d } = make();
    const k = 'k' + Math.random();
    assert.equal(await d.firstTime(k), true);
    assert.equal(await d.firstTime(k), false);
    assert.equal(await d.firstTime(k + 'b'), true);
  });
  test(`${name}: limiter blocks after limit, isolates keys`, async () => {
    const { l } = make();
    const k = 'ip' + Math.random();
    assert.deepEqual([await l.allow(k), await l.allow(k), await l.allow(k), await l.allow(k)], [true, true, true, false]);
    assert.equal(await l.allow(k + 'other'), true);
  });
  test(`${name}: spend counters accumulate atomically under concurrency`, async () => {
    const { s } = make();
    await Promise.all(Array.from({ length: 100 }, () => s.add('cmp1', 0.01)));
    const g = await s.get('cmp1');
    assert.ok(Math.abs(g.total - 1) < 1e-9);
    assert.ok(Math.abs(g.today - 1) < 1e-9);
    assert.deepEqual(await s.get('missing'), { total: 0, today: 0 });
  });
}

test('ledger writer retries on failure without losing or duplicating events', async () => {
  let fail = 2; const seen = [];
  const repo = { recordBatch: async (evts) => { if (fail-- > 0) throw new Error('db down'); seen.push(...evts.map((e) => e.token)); return evts.length; } };
  const w = new LedgerWriter({ repo, log: { error() {} } });
  w.push({ token: 'a' }); w.push({ token: 'b' });
  assert.equal(await w.flush(5000), true);
  assert.deepEqual(seen, ['a', 'b']);
  assert.equal(w.failed, 2);
});
test('ledger writer sheds load when the queue is full and reports it', async () => {
  const repo = { recordBatch: () => new Promise(() => {}) };
  const w = new LedgerWriter({ repo, log: { error() {} }, maxQueue: 2 });
  for (let i = 0; i < 5; i++) w.push({ token: String(i) });
  assert.equal(w.dropped, 3); // queue capacity is 2; the rest are shed
});
test('metrics render valid prometheus text with histogram buckets', () => {
  const m = new Metrics();
  m.inc('x_total', { a: '1' }); m.inc('x_total', { a: '1' });
  m.observe('lat', { r: 'q' }, 0.02);
  const out = m.render();
  assert.match(out, /x_total\{a="1"\} 2/);
  assert.match(out, /lat_bucket\{r="q",le="0.025"\} 1/);
  assert.match(out, /lat_count\{r="q"\} 1/);
});

import { createPool, Repo } from '../src/db/repo.js';
test('repo.recordBatch inserts atomically, updates counters, rolls back on failure', async () => {
  const repo = new Repo(await createPool('')); await repo.migrate();
  await repo.createCampaign({ id: 'c1', owner: 'u', name: 'n', format: 'banner', model: 'CPM', bid: 1, budget: 9, dailyBudget: 0, countries: [], platforms: [], endsAt: 0, status: 'active', creative: {} });
  const ev = (i, type = 'impression', cost = 0.002) => ({ type, campaignId: 'c1', appId: 'a1', cost, t: Date.now(), token: 't' + i });
  const n = await repo.recordBatch([...Array.from({ length: 300 }, (_, i) => ev(i)), ev('k', 'click', 0)]);
  assert.equal(n, 301);
  await repo.flushCounters();
  const c = await repo.campaign('c1');
  assert.equal(c.impressions, 300); assert.equal(c.clicks, 1); assert.ok(Math.abs(c.spent - 0.6) < 1e-9);
  assert.equal(Number((await repo.q('SELECT COUNT(*) n FROM ledger')).rows[0].n), 301);
  await assert.rejects(repo.recordBatch([ev('z1'), { ...ev('z2'), cost: NaN, t: NaN }])); // bad row aborts whole batch
  assert.equal(Number((await repo.q('SELECT COUNT(*) n FROM ledger')).rows[0].n), 301);
});

test('redis limiters with different names do not share counters (regression)', async () => {
  const r = new RedisMock();
  const ads = new RedisLimiter(r, 1000000, 60000, 'ad'), auth = new RedisLimiter(r, 2, 60000, 'auth');
  for (let i = 0; i < 50; i++) await ads.allow('1.2.3.4');
  assert.equal(await auth.allow('1.2.3.4'), true); // heavy ad traffic must not lock out login
});

import { Breaker } from '../src/core/ports.js';
test('breaker: hung/failed dependency falls back fast, opens, then recovers', async () => {
  const b = new Breaker({ failures: 2, openMs: 80, timeoutMs: 30 });
  let healthy = false, calls = 0;
  const fn = () => { calls++; return healthy ? Promise.resolve('real') : new Promise(() => {}); }; // hangs forever when down
  const t0 = Date.now();
  assert.equal(await b.run(fn, () => 'local'), 'local'); // times out after ~30ms, not forever
  assert.equal(await b.run(fn, () => 'local'), 'local');
  assert.ok(Date.now() - t0 < 500);
  assert.equal(b.open, true);
  const before = calls;
  assert.equal(await b.run(fn, () => 'local'), 'local'); // open: dependency not even called
  assert.equal(calls, before);
  healthy = true;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await b.run(fn, () => 'local'), 'real'); // half-open probe succeeds, breaker closes
  assert.equal(b.open, false);
});

test('counter deltas are batched; a failed flush is retried not lost; ledger is never affected; reconcile repairs a crash', async () => {
  const repo = new Repo(await createPool('')); await repo.migrate();
  await repo.createCampaign({ id: 'c9', owner: 'u', name: 'n', format: 'banner', model: 'CPM', bid: 1, budget: 9, dailyBudget: 0, countries: [], platforms: [], endsAt: 0, status: 'active', creative: {} });
  const ev = (i, type = 'impression', cost = 0.002) => ({ type, campaignId: 'c9', appId: 'a1', cost, t: Date.now(), token: 'k' + i });
  let updates = 0, failUpdates = true;
  const realQ = repo.q.bind(repo);
  repo.q = (s, p) => (/^UPDATE campaigns SET impressions=impressions+/.test(s) ? (updates++, failUpdates ? Promise.reject(new Error('canceling statement due to statement timeout')) : realQ(s, p)) : realQ(s, p));
  for (let b = 0; b < 5; b++) await repo.recordBatch([ev('a' + b), ev('b' + b), ev('c' + b, 'click', 0)]); // 5 batches
  assert.equal(updates, 0); // nothing touched the hot row on the write path
  await repo.flushCounters();
  assert.equal(updates, 1); // one update for 5 batches (not 5)
  assert.equal(repo.counterFailures, 1);
  assert.equal((await repo.campaign('c9')).impressions, 0); // not applied yet...
  failUpdates = false;
  await repo.flushCounters(); // ...retried with the SAME deltas
  const c = await repo.campaign('c9');
  assert.equal(c.impressions, 10); assert.equal(c.clicks, 5); assert.ok(Math.abs(c.spent - 0.02) < 1e-9);
  repo.pending.clear();
  await realQ('UPDATE campaigns SET impressions=0, clicks=0, spent=0 WHERE id=$1', ['c9']); // simulate a crash that lost in-memory deltas
  await repo.reconcileCounters();
  const r = await repo.campaign('c9');
  assert.equal(r.impressions, 10); assert.equal(r.clicks, 5);
  assert.equal(Number((await realQ('SELECT COUNT(*) n FROM ledger')).rows[0].n), 15); // ledger complete throughout
});

import { EventEmitter } from 'node:events';
test('a checked-out Postgres client that errors mid-write does NOT crash the process (regression: SIGKILL of Postgres killed every pod)', async () => {
  // node-postgres emits 'error' on a checked-out client when the server dies; an EventEmitter with no listener THROWS it.
  const clients = [];
  const mk = () => {
    const c = new EventEmitter(); c.released = null;
    c.query = async (sql) => {
      if (/^BEGIN/.test(sql)) return {};
      if (/^INSERT INTO ledger/.test(sql)) { setImmediate(() => c.emit('error', new Error('Connection terminated unexpectedly'))); await new Promise((r) => setTimeout(r, 20)); throw new Error('Connection terminated unexpectedly'); }
      return { rows: [] };
    };
    c.release = (destroy) => { c.released = destroy === undefined ? false : destroy; };
    clients.push(c); return c;
  };
  const seen = [];
  const repo = new Repo({ connect: async () => mk(), query: async () => ({ rows: [] }) });
  repo.onClientError = (e) => seen.push(e.message);
  const crashed = [];
  const onUncaught = (e) => crashed.push(e);
  process.once('uncaughtException', onUncaught);
  await assert.rejects(repo.recordBatch([{ type: 'impression', campaignId: 'c', appId: 'a', cost: 0.001, t: Date.now(), token: 'x' }]), /terminated/);
  await new Promise((r) => setTimeout(r, 50));
  process.removeListener('uncaughtException', onUncaught);
  assert.deepEqual(crashed, []);                                   // no uncaught 'error' event
  assert.deepEqual(seen, ['Connection terminated unexpectedly']);  // surfaced to the logger instead
  assert.equal(clients[0].released, true);                         // the broken connection is destroyed, not returned to the pool
  assert.equal(clients[0].listenerCount('error'), 0);              // and our handler is detached again
});
