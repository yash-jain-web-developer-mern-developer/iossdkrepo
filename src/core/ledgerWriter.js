// Durable event sink: buffers events and writes them to the Postgres ledger with retry + backoff.
// Writes are idempotent (unique token hash), so retries cannot double-bill.
// In the multi-service target, this runs as a Kafka consumer instead of an in-process queue.
export class LedgerWriter {
  constructor({ repo, log, maxQueue = 100000, batchSize = 500 }) {
    this.batchSize = batchSize;
    this.repo = repo; this.log = log; this.queue = []; this.maxQueue = maxQueue;
    this.busy = false; this.written = 0; this.failed = 0; this.dropped = 0; this.retryTimer = null;
  }
  push(evt) {
    if (this.queue.length >= this.maxQueue) { this.dropped++; this.log?.error('ledger queue full, event dropped', { type: evt.type }); return; }
    this.queue.push({ evt, tries: 0 });
    this.drain();
  }
  async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const batch = this.queue.slice(0, this.batchSize);
        try {
          await this.repo.recordBatch(batch.map((b) => b.evt));
          this.queue.splice(0, batch.length); this.written += batch.length;
        } catch (e) {
          const tries = ++batch[0].tries; this.failed++;
          this.log?.error('ledger write failed', { err: e.message, tries, batch: batch.length });
          this.retryTimer = setTimeout(() => this.drain(), Math.min(2000, 100 * 2 ** tries));
          this.retryTimer.unref();
          return;
        }
      }
    } finally { this.busy = false; }
  }
  async flush(timeoutMs = 5000) {
    const end = Date.now() + timeoutMs;
    while ((this.queue.length || this.busy) && Date.now() < end) { await this.drain(); await new Promise((r) => setTimeout(r, 10)); }
    return this.queue.length === 0;
  }
}
