// Customer webhooks: events are queued in Postgres (so they survive restarts and work across replicas) and delivered by a worker
// with signed bodies and exponential back-off. Delivery is at-least-once: receivers must de-duplicate on the event id.
//   X-MobiAd-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${body}`)>   (reject if |now - t| is large)
import { createHmac, randomBytes } from 'node:crypto';
import { safePost } from './safeHttp.js';

export const WEBHOOK_EVENTS = ['campaign.approved', 'campaign.rejected', 'campaign.exhausted', 'payout.approved', 'payout.paid', 'payout.rejected', 'wallet.credited', 'payment.failed', 'payment.refunded', 'payment.disputed', 'payment.dispute_closed', 'verification.reviewed', 'ping'];
export const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000]; // 1 m, 5 m, 30 m, 2 h, 12 h => 6 attempts in total
export const MAX_CONSECUTIVE_FAILURES = 20; // a hook that keeps failing is disabled, not hammered forever

export const newWebhookSecret = () => 'whsec_' + randomBytes(24).toString('hex');
export const signWebhook = (secret, body, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
export function verifyWebhook(secret, body, header, { toleranceSec = 300, now = Date.now() } = {}) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(header || ''));
  if (!m || Math.abs(now / 1000 - Number(m[1])) > toleranceSec) return false;
  return signWebhook(secret, body, Number(m[1])) === header;
}

export function startWebhookWorker({ repo, log, metrics, post = safePost, intervalMs = 2000, allowPrivate = false, now = Date.now }) {
  let busy = false;
  async function deliver(d) {
    const hook = await repo.webhook(d.webhook_id);
    if (!hook || hook.status !== 'active') { await repo.finishDelivery(d.id, 'failed', 'webhook removed or disabled'); return; }
    const body = d.payload;
    try {
      const r = await post(hook.url, { body, headers: { 'x-mobiad-signature': signWebhook(hook.secret, body), 'x-mobiad-event': d.event, 'x-mobiad-delivery': d.id }, timeoutMs: 5000, allowPrivate, allowHttp: allowPrivate });
      if (r.status >= 200 && r.status < 300) { await repo.finishDelivery(d.id, 'delivered', null); await repo.noteWebhookResult(hook.id, true); metrics?.inc('mobiad_webhook_deliveries_total', { result: 'delivered' }); return; }
      throw new Error('HTTP ' + r.status);
    } catch (e) {
      metrics?.inc('mobiad_webhook_deliveries_total', { result: 'error' });
      const attempt = d.attempts; // already incremented by the claim
      if (attempt > RETRY_DELAYS_MS.length) await repo.finishDelivery(d.id, 'failed', e.message);
      else await repo.retryDelivery(d.id, now() + RETRY_DELAYS_MS[attempt - 1], e.message);
      const disabled = await repo.noteWebhookResult(hook.id, false);
      if (disabled) log?.error('webhook disabled after repeated failures', { webhook: hook.id });
    }
  }
  async function tick() {
    if (busy) return 0; busy = true;
    try {
      const due = await repo.claimDueDeliveries(now(), 20);
      await Promise.all(due.map((d) => deliver(d).catch((e) => log?.error('webhook delivery crashed', { id: d.id, err: e.message }))));
      return due.length;
    } catch (e) { log?.error('webhook worker failed', { err: e.message }); return 0; } finally { busy = false; }
  }
  const timer = setInterval(tick, intervalMs); timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}
