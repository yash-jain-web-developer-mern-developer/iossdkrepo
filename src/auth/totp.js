// RFC 6238 TOTP (HMAC-SHA1, 30 s step, 6 digits) with no dependencies, plus AES-256-GCM secret encryption.
import { createHmac, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str) {
  let bits = 0, value = 0; const out = [];
  for (const ch of String(str).replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch); if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newSecret = () => base32Encode(randomBytes(20));
export const STEP_SECONDS = 30;

export function hotp(secretBuf, counter, digits = 6) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secretBuf).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}
export const totpAt = (secretB32, timeMs, digits = 6) => hotp(base32Decode(secretB32), Math.floor(timeMs / 1000 / STEP_SECONDS), digits);

// Verify with ±1 step of clock skew. Returns the matched time-step (for replay protection) or null.
// `lastStep` is the last step already accepted for this user: a code is valid only once.
export function verifyTotp(secretB32, code, { now = Date.now(), lastStep = 0, window = 1 } = {}) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const secret = base32Decode(secretB32), step = Math.floor(now / 1000 / STEP_SECONDS);
  for (let d = -window; d <= window; d++) {
    const s = step + d;
    if (s <= lastStep) continue; // already used (or older than a used one): replay
    const expected = Buffer.from(hotp(secret, s)), got = Buffer.from(c);
    if (expected.length === got.length && timingSafeEqual(expected, got)) return s;
  }
  return null;
}
export const otpauthUrl = (secretB32, email, issuer = 'MobiAd') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;

const TAG_BYTES = 16;
// Secrets are stored encrypted (AES-256-GCM); the key is a 64-hex-char derived subkey (see core/token.js deriveKey).
export function encryptSecret(plain, keyHex) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv, { authTagLength: TAG_BYTES });
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
export function decryptSecret(blob, keyHex) {
  const [iv, tag, enc] = String(blob).split('.').map((s) => Buffer.from(s, 'base64'));
  if (iv.length !== 12 || tag.length !== TAG_BYTES) throw new Error('invalid ciphertext'); // reject truncated tags (GCM forgery risk)
  const d = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv, { authTagLength: TAG_BYTES });
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
