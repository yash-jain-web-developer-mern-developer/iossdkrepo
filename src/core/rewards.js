// Rewarded video: when a rewarded ad plays to completion we tell the publisher's server (server-to-server) so the reward cannot
// be forged from the client. The body is JSON, signed with the app's reward secret: X-MobiAd-Signature: sha256=<hex HMAC of the raw body>.
import { createHmac, randomBytes } from 'node:crypto';
import { safePost } from './safeHttp.js';

export const newRewardSecret = () => randomBytes(32).toString('hex');
export const signBody = (secret, body) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

export function rewardPayload({ app, userId, txn, now = Date.now() }) {
  return JSON.stringify({ event: 'reward', appId: app.id, userId: userId || '', amount: app.rewardAmount || 1, item: app.rewardItem || 'reward', transactionId: txn, timestamp: now });
}

// Fire-and-forget with retries (0.5 s, 2 s). Returns a promise that resolves to true/false (never rejects) so callers may await it in tests.
export async function deliverReward({ app, userId, txn, post = safePost, allowPrivate = false, allowHttp = false, metrics, log, delays = [500, 2000], sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!app.rewardCallbackUrl || !app.rewardSecret) return false;
  const body = rewardPayload({ app, userId, txn });
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const r = await post(app.rewardCallbackUrl, { body, headers: { 'x-mobiad-signature': signBody(app.rewardSecret, body), 'x-mobiad-transaction': txn }, allowPrivate, allowHttp });
      if (r.status >= 200 && r.status < 300) { metrics?.inc('mobiad_reward_callbacks_total', { result: 'ok' }); return true; }
      if (r.status < 500 && r.status !== 429) { metrics?.inc('mobiad_reward_callbacks_total', { result: 'rejected' }); return false; } // publisher said no; do not retry
    } catch (e) { log?.error('reward callback failed', { app: app.id, err: e.message }); }
    if (attempt < delays.length) await sleep(delays[attempt]);
  }
  metrics?.inc('mobiad_reward_callbacks_total', { result: 'failed' });
  return false;
}
