import test from 'node:test';
import assert from 'node:assert/strict';
import { KafkaSink, handleBatch, validEvent } from '../src/core/kafka.js';
import { Metrics } from '../src/obs.js';

const ev = (i, o = {}) => ({ type: 'impression', campaignId: 'c1', appId: 'a1', cost: 0.002, t: Date.now(), token: 't' + i, ...o });
const quiet = { error() {}, info() {}, warn() {} };
const msg = (e) => ({ value: Buffer.from(typeof e === 'string' ? e : JSON.stringify(e)), offset: '0' });

test('validEvent accepts every event type the tracker emits (regression: invalid_click was dead-lettered)', () => {
  for (const type of ['impression', 'click', 'install', 'invalid_click']) assert.ok(validEvent(ev(1, { type })), type);
});

test('validEvent rejects malformed events', () => {
  assert.ok(validEvent(ev(1)));
  for (const bad of [null, {}, ev(1, { cost: NaN }), ev(1, { cost: -1 }), ev(1, { type: 'x' }), ev(1, { token: '' }), ev(1, { t: 'now' })]) assert.equal(validEvent(bad), false);
});

test('sink: push resolves only after Kafka acknowledged (acks=all), and batches within the linger window', async () => {
  const sent = []; let ackLate = false;
  const producer = { send: async (r) => { await new Promise((x) => setTimeout(x, 30)); ackLate = true; sent.push(r); } };
  const fallback = { push() { assert.fail('must not fall back when Kafka is healthy'); } };
  const sink = new KafkaSink({ producer, topic: 't', fallback, log: quiet, metrics: new Metrics() });
  const ps = [sink.push(ev(1)), sink.push(ev(2)), sink.push(ev(3))];
  await Promise.all(ps);
  assert.equal(ackLate, true); // resolved after the broker ack, not before
  assert.equal(sent.length, 1); // one produce request for three events
  assert.equal(sent[0].acks, -1);
  assert.equal(sent[0].messages.length, 3);
});

test('sink: Kafka down -> events fall back to the local queue, breaker avoids per-request timeouts', async () => {
  const local = [];
  let calls = 0;
  const producer = { send: () => { calls++; return new Promise(() => {}); } }; // hangs like an unreachable broker
  const sink = new KafkaSink({ producer, topic: 't', fallback: { push: (e) => local.push(e) }, log: quiet, metrics: new Metrics(), sendTimeoutMs: 40, lingerMs: 1 });
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) await sink.push(ev(i));
  assert.equal(local.length, 5); // nothing lost
  assert.ok(calls <= 3, 'breaker opened after repeated failures; got ' + calls + ' calls');
  assert.ok(Date.now() - t0 < 1500);
});

test('consumer: malformed events go to the DLQ, valid events are written', async () => {
  const written = [], dead = [];
  await handleBatch({ messages: [msg(ev(1)), msg('{not json'), msg(ev(2, { cost: NaN })), msg(ev(3))],
    repo: { recordBatch: async (b) => { written.push(...b.map((e) => e.token)); } }, dlq: async (x) => dead.push(...x), log: quiet });
  assert.deepEqual(written, ['t1', 't3']);
  assert.equal(dead.length, 2);
});

test('consumer: keeps retrying while Postgres is down, never drops, never commits early', async () => {
  let failures = 4; const written = [];
  const repo = { recordBatch: async (b) => { if (failures-- > 0) throw new Error('connection refused'); written.push(...b.map((e) => e.token)); } };
  await handleBatch({ messages: [msg(ev(1)), msg(ev(2))], repo, dlq: async () => {}, log: quiet, retryMs: 5 });
  assert.deepEqual(written, ['t1', 't2']); // resolved only after the DB accepted them
  assert.equal(failures, -1);
});

test('consumer: shutdown while the DB is down aborts the batch (offset stays uncommitted -> redelivered)', async () => {
  await assert.rejects(handleBatch({ messages: [msg(ev(1))], repo: { recordBatch: async () => { throw new Error('down'); } },
    dlq: async () => {}, log: quiet, retryMs: 1, stopped: () => true }), /down/);
});

import { makeEachBatch } from '../src/core/kafka.js';
const batchOf = (n, partition = 3, start = 10) => ({ topic: 'mobiad.events', partition, messages: Array.from({ length: n }, (_, i) => ({ ...msg(ev('b' + i)), offset: String(start + i) })) });

test('consumer commits offset last+1 per partition, only after Postgres accepted the batch (regression: offsets were never committed)', async () => {
  const commits = [], order = [];
  const consumer = { commitOffsets: async (c) => { order.push('commit'); commits.push(...c); } };
  const repo = { recordBatch: async () => { order.push('db'); } };
  const each = makeEachBatch({ consumer, repo, dlq: async () => {}, log: quiet, stopped: () => false });
  let resolved = null;
  await each({ batch: batchOf(3), resolveOffset: (o) => { resolved = o; }, heartbeat: async () => {} });
  assert.deepEqual(order, ['db', 'commit']); // DB first, then commit
  assert.deepEqual(commits, [{ topic: 'mobiad.events', partition: 3, offset: '13' }]); // next offset to read = last(12) + 1
  assert.equal(resolved, '12');
});

test('consumer does NOT commit when the DB write is abandoned (shutdown) -> events are redelivered', async () => {
  const commits = [];
  const consumer = { commitOffsets: async (c) => commits.push(...c) };
  const each = makeEachBatch({ consumer, repo: { recordBatch: async () => { throw new Error('db down'); } }, dlq: async () => {}, log: quiet, stopped: () => true });
  await assert.rejects(each({ batch: batchOf(2), resolveOffset() {}, heartbeat: async () => {} }), /db down/);
  assert.equal(commits.length, 0);
});

test('producer sends unkeyed messages so one hot campaign spreads across partitions', async () => {
  const sent = [];
  const sink = new KafkaSink({ producer: { send: async (r) => sent.push(r) }, topic: 't', fallback: { push() {} }, log: quiet, metrics: new Metrics(), lingerMs: 1 });
  await sink.push(ev(1)); await sink.push(ev(2));
  for (const r of sent) for (const m of r.messages) assert.equal(m.key, undefined);
});

import { superviseConsumer } from '../src/core/kafka.js';
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('supervisor rebuilds a crashed consumer with backoff and reports liveness (regression: consumers died silently after a broker SIGKILL)', async () => {
  const made = []; let failNext = 0;
  const create = async ({ onJoin, onCrash }) => {
    if (failNext > 0) { failNext--; throw new Error('broker unreachable'); }
    const c = { id: made.length, disconnected: false, disconnect: async () => { c.disconnected = true; }, crash: (e) => onCrash(e || new Error('coordinator is not aware of this member')) };
    made.push(c); setImmediate(onJoin); return c;
  };
  const errors = []; const sup = superviseConsumer({ create, log: { error: (m) => errors.push(m), info() {} }, backoffMs: { min: 20, max: 80 } });
  await sup.start(); await tick(10);
  assert.deepEqual(sup.status(), { consuming: true, restarts: 0 });
  made[0].crash(); // the production failure
  assert.equal(sup.status().consuming, false);          // liveness metric flips to 0 immediately
  await tick(80);
  assert.equal(made.length, 2);                         // a NEW consumer was built
  assert.equal(made[0].disconnected, true);             // the dead one was cleaned up
  assert.deepEqual(sup.status(), { consuming: true, restarts: 1 });
  // the broker is still down when we try to rebuild: keep retrying with growing delay, never give up
  failNext = 3; made[1].crash();
  await tick(500);
  assert.equal(sup.status().consuming, true);           // eventually recovered
  assert.ok(sup.status().restarts >= 4);
  assert.ok(errors.length >= 2);
  // crashes are idempotent: many crash signals schedule only one restart
  const before = made.length; made.at(-1).crash(); made.at(-1).crash(); made.at(-1).crash();
  await tick(150);
  assert.equal(made.length, before + 1);
  await sup.stop();
  const n = made.length; made.at(-1).crash(); await tick(150);
  assert.equal(made.length, n);                         // stopped: no restart after shutdown
});
test('supervisor survives a consumer that fails to start at boot', async () => {
  let attempts = 0;
  const sup = superviseConsumer({ create: async ({ onJoin }) => { if (++attempts < 3) throw new Error('not ready'); setImmediate(onJoin); return { disconnect: async () => {} }; }, log: { error() {}, info() {} }, backoffMs: { min: 10, max: 20 } });
  await sup.start(); await tick(200);
  assert.equal(sup.status().consuming, true); assert.equal(attempts, 3);
  await sup.stop();
});
