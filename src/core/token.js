// HMAC-signed, expiring tracking tokens: prevents forged or replayed events.
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
const b64 = (b) => Buffer.from(b).toString('base64url');

// Domain-separated subkeys so a leak/misuse of one purpose (JWT vs tracking tokens) cannot forge the other.
export const deriveKey = (secret, label) => createHmac('sha256', secret).update('mobiad:key:' + label).digest('hex');

export function sign(payload, secret, ttlMs = 24 * 3600e3) {
  const body = b64(JSON.stringify({ ...payload, iat: Date.now(), exp: Date.now() + ttlMs, n: randomBytes(6).toString('hex') })); // iat lets the tracker spot impossibly fast clicks
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
export function verify(token, secret) {
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return null;
  const good = createHmac('sha256', secret).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== good.length || !timingSafeEqual(got, good)) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  return p.exp > Date.now() ? p : null;
}
