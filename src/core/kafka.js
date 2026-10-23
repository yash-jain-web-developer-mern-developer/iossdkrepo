// Durable event pipeline: tracker -> Kafka -> ledger consumer -> Postgres.
// A tracking event is acknowledged to the client only after Kafka has persisted it (acks=all),
// so a pod crash (even while Postgres is down) cannot lose confirmed events. The consumer writes to
// Postgres idempotently (UNIQUE token_hash) and commits offsets only after the DB write succeeds.
import { Breaker } from './ports.js';

const REQUIRED = ['type', 'campaignId', 'appId', 'token'];
// Every event type the tracker can emit. A type missing here is dead-lettered as 'malformed' (found by the real-Kafka test).
export const EVENT_TYPES = ['impression', 'click', 'install', 'invalid_click', 'video_complete', 'viewable', 'conversion'];
export function validEvent(e) {
  return Boolean(e && typeof e === 'object' && REQUIRED.every((k) => typeof e[k] === 'string' && e[k]) &&
    EVENT_TYPES.includes(e.type) && Number.isFinite(e.cost) && e.cost >= 0 && Number.isFinite(e.t));
}

// Producer side. push() resolves once the event is durable (in Kafka) or, if Kafka is unavailable,
// once it is in the local in-memory queue (degraded mode: the old, weaker guarantee).
export class KafkaSink {
  constructor({ producer, topic, fallback, log, metrics, lingerMs = 5, maxBatch = 500, sendTimeoutMs = 1500 }) {
    Object.assign(this, { producer, topic, fallback, log, metrics, lingerMs, maxBatch, sendTimeoutMs });
    this.buf = []; this.timer = null;
    this.breaker = new Breaker({ failures: 2, openMs: 2000, timeoutMs: sendTimeoutMs + 500,
      onChange: (open) => log?.[open ? 'error' : 'info'](open ? 'kafka unavailable: falling back to in-memory queue' : 'kafka recovered') });
  }
  push(evt) {
    return new Promise((resolve) => {
      this.buf.push({ evt, resolve });
      if (this.buf.length >= this.maxBatch) this.flushNow();
      else if (!this.timer) this.timer = setTimeout(() => this.flushNow(), this.lingerMs);
    });
  }
  async flushNow() {
    clearTimeout(this.timer); this.timer = null;
    const items = this.buf.splice(0, this.maxBatch);
    if (!items.length) return;
    const viaFallback = () => { this.metrics?.inc('mobiad_kafka_fallback_total', {}, items.length); items.forEach((i) => this.fallback.push(i.evt)); };
    try {
      await this.breaker.run(async () => {
        await this.producer.send({ topic: this.topic, acks: -1, timeout: this.sendTimeoutMs,
          messages: items.map((i) => ({ value: JSON.stringify(i.evt) })) }); // no key: events are idempotent and unordered, so spread them evenly
        this.metrics?.inc('mobiad_kafka_produced_total', {}, items.length);
      }, viaFallback);
    } catch (e) { this.log?.error('kafka send failed', { err: e.message }); viaFallback(); }
    finally { items.forEach((i) => i.resolve()); }
    if (this.buf.length) this.flushNow();
  }
  async flush() { while (this.buf.length) await this.flushNow(); }
}

// Consumer side. `run` is kafkajs' consumer.run; kept injectable for tests.
export async function handleBatch({ messages, repo, dlq, log, metrics, chunk = 500, retryMs = 500, stopped = () => false }) {
  const good = [], bad = [];
  for (const m of messages) {
    let e = null;
    try { e = JSON.parse(m.value.toString()); } catch { /* poison */ }
    (validEvent(e) ? good : bad).push(validEvent(e) ? e : m.value.toString());
  }
  if (bad.length) { // malformed events can never succeed: park them instead of blocking the partition
    metrics?.inc('mobiad_kafka_dlq_total', {}, bad.length);
    log?.error('dead-lettering malformed events', { n: bad.length });
    await dlq(bad);
  }
  for (let i = 0; i < good.length; i += chunk) {
    const part = good.slice(i, i + chunk);
    for (let attempt = 1; ; attempt++) { // valid events are retried until the database accepts them
      try { await repo.recordBatch(part); metrics?.inc('mobiad_kafka_consumed_total', {}, part.length); break; }
      catch (e) {
        log?.error('ledger write failed; will retry (events stay safe in Kafka)', { err: e.message, attempt });
        metrics?.inc('mobiad_kafka_consumer_errors_total');
        if (stopped()) throw e;
        await new Promise((r) => setTimeout(r, Math.min(5000, retryMs * attempt)));
      }
    }
  }
}

// Process one fetched batch and commit its offset ONLY after Postgres accepted every event.
// (With autoCommit disabled, kafkajs' commitOffsetsIfNecessary() is a no-op, so we commit explicitly.)
export function makeEachBatch({ consumer, repo, dlq, log, metrics, stopped }) {
  return async ({ batch, resolveOffset, heartbeat }) => {
    if (!batch.messages.length) return;
    const hb = setInterval(() => heartbeat().catch(() => {}), 2000); // keep the session alive while the DB is slow/down
    try {
      await handleBatch({ messages: batch.messages, repo, dlq, log, metrics, stopped });
      const last = batch.messages[batch.messages.length - 1].offset;
      resolveOffset(last);
      await consumer.commitOffsets([{ topic: batch.topic, partition: batch.partition, offset: (BigInt(last) + 1n).toString() }]);
    } finally { clearInterval(hb); }
  };
}

export async function createKafka(cfg, { repo, fallback, log, metrics }) {
  const { Kafka, logLevel, Partitioners } = await import('kafkajs');
  const logger = log;
  const common = { brokers: cfg.kafkaBrokers, logLevel: logLevel[process.env.KAFKA_LOG_LEVEL || 'WARN'],
    // kafkajs problems (rebalances, crashes, auth) must show up in the app's structured logs
    logCreator: () => ({ namespace, level, log }) => { const { message, ...extra } = log; (level <= logLevel.ERROR ? logger.error : logger.warn)('kafkajs ' + namespace + ': ' + message, extra); },
    connectionTimeout: 3000,
    ...(cfg.kafkaSsl ? { ssl: true } : {}), ...(cfg.kafkaSasl ? { sasl: cfg.kafkaSasl } : {}) };
  // Producer/admin: fail fast so the tracking path degrades quickly when Kafka is unavailable.
  const kafka = new Kafka({ ...common, clientId: 'mobiad', requestTimeout: 3000, retry: { initialRetryTime: 200, retries: 3 } });
  // Consumer: needs its OWN client. Fetches long-poll the broker (up to maxWaitTime) and group joins take seconds, so a
  // short requestTimeout makes kafkajs abandon its own requests and the consumer group flaps (found by chaos/soak testing).
  const kafkaConsumer = new Kafka({ ...common, clientId: 'mobiad-consumer', requestTimeout: 30000, retry: { initialRetryTime: 300, retries: 8 } });
  const admin = kafka.admin();
  // Topics are created by the application with the intended partition count/replication, and RE-CREATED if the broker ever
  // loses them (broker replaced or wiped). Auto-creation by brokers/consumers must stay off: it creates 1-partition topics,
  // which silently removes consumer parallelism (found when a wiped broker came back and consumers auto-created the topic).
  const ensureTopics = async () => {
    await admin.connect();
    try {
      await admin.createTopics({ waitForLeaders: true, topics: [
        { topic: cfg.kafkaTopic, numPartitions: cfg.kafkaPartitions, replicationFactor: cfg.kafkaReplication, configEntries: [{ name: 'retention.ms', value: String((cfg.kafkaRetentionDays || 7) * 86_400_000) }] },
        { topic: cfg.kafkaTopic + '.dlq', numPartitions: 1, replicationFactor: cfg.kafkaReplication, configEntries: [{ name: 'retention.ms', value: String(30 * 86_400_000) }] }] });
    } finally { await admin.disconnect().catch(() => {}); }
  };
  for (let n = 1; ; n++) { // wait for the broker at boot
    try { await ensureTopics(); break; } catch (e) {
      if (n > 40) throw new Error('kafka not ready: ' + e.message);
      log.warn('waiting for kafka', { attempt: n, err: e.message });
      await new Promise((r) => setTimeout(r, Math.min(3000, 250 * n)));
    }
  }
  const topicTimer = setInterval(() => ensureTopics().catch(() => {}), cfg.kafkaEnsureTopicsMs || 30_000);
  topicTimer.unref();
  const producer = kafka.producer({ createPartitioner: Partitioners.DefaultPartitioner, allowAutoTopicCreation: false, retry: { retries: 1, initialRetryTime: 100 } });
  await producer.connect();
  const sink = new KafkaSink({ producer, topic: cfg.kafkaTopic, fallback, log, metrics });
  const dlq = (items) => producer.send({ topic: cfg.kafkaTopic + '.dlq', messages: items.map((v) => ({ value: v })) });
  let stopping = false;

  // The ledger consumer is SUPERVISED: kafkajs' own restart did not recover from "coordinator is not aware of this member"
  // after a broker SIGKILL (every pod's consumer died silently while the pod stayed healthy). We rebuild it with backoff.
  const supervisor = superviseConsumer({
    log,
    isStopping: () => stopping,
    create: async ({ onJoin, onCrash }) => {
      const c = kafkaConsumer.consumer({ groupId: 'mobiad-ledger', sessionTimeout: 30000, heartbeatInterval: 3000, allowAutoTopicCreation: false,
        retry: { initialRetryTime: 300, retries: 8, restartOnFailure: async () => false } }); // we do the restarting
      c.on(c.events.GROUP_JOIN, onJoin);
      c.on(c.events.CRASH, (e) => onCrash(e.payload?.error || new Error('consumer crash')));
      await c.connect();
      await c.subscribe({ topic: cfg.kafkaTopic, fromBeginning: true });
      c.run({
        autoCommit: false, partitionsConsumedConcurrently: 3,
        eachBatch: makeEachBatch({ consumer: c, repo, dlq, log, metrics, stopped: () => stopping }),
      }).catch((e) => onCrash(e));
      return c;
    },
  });
  await supervisor.start();

  return {
    sink,
    consumerStatus: () => supervisor.status(),
    async close() {
      stopping = true;
      clearInterval(topicTimer);
      await sink.flush().catch(() => {});
      await supervisor.stop();
      await producer.disconnect().catch(() => {});
    },
  };
}

// Keeps a consumer alive. `create({ onJoin, onCrash })` must build, connect and start a NEW consumer and return it; it is called
// again (after exponential backoff) whenever the consumer crashes or fails to start. Pure of kafkajs, so it is unit-testable.
export function superviseConsumer({ create, log, isStopping = () => false, backoffMs = { min: 1000, max: 30000 } }) {
  let current = null, consuming = false, restarts = 0, attempt = 0, timer = null, stopped = false;
  const down = (reason) => {
    consuming = false;
    if (stopped || isStopping() || timer) return;
    const delay = Math.min(backoffMs.max, backoffMs.min * 2 ** attempt++);
    log?.error('kafka ledger consumer is down; rebuilding it', { reason: String(reason?.message || reason), inMs: delay, restarts });
    timer = setTimeout(async () => {
      timer = null;
      if (stopped || isStopping()) return;
      restarts++;
      try { await current?.disconnect?.().catch(() => {}); await start(); } catch (e) { down(e); }
    }, delay);
    timer.unref?.();
  };
  async function start() {
    current = await create({ onJoin: () => { consuming = true; attempt = 0; log?.info('kafka ledger consumer joined the group'); }, onCrash: (e) => down(e) });
  }
  return {
    async start() { try { await start(); } catch (e) { down(e); } },
    status: () => ({ consuming, restarts }),
    async stop() { stopped = true; clearTimeout(timer); timer = null; await current?.disconnect?.().catch(() => {}); consuming = false; },
  };
}
