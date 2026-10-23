import test from 'node:test';
import assert from 'node:assert/strict';
import { base32Encode, base32Decode, hotp, totpAt, verifyTotp, newSecret, encryptSecret, decryptSecret, otpauthUrl } from '../src/auth/totp.js';
import { deriveKey } from '../src/core/token.js';

test('TOTP matches the RFC 6238 test vectors (SHA-1, secret "12345678901234567890")', () => {
  const secret = Buffer.from('12345678901234567890');
  const vectors = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];
  for (const [t, expected] of vectors) assert.equal(hotp(secret, Math.floor(t / 30), 8), expected, 'time ' + t);
});
test('RFC 4226 HOTP vectors', () => {
  const secret = Buffer.from('12345678901234567890');
  ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'].forEach((e, i) => assert.equal(hotp(secret, i), e));
});
test('base32 round trip and rejects garbage', () => {
  for (let n = 1; n < 40; n++) { const b = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + n) & 255)); assert.deepEqual(base32Decode(base32Encode(b)), b); }
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.throws(() => base32Decode('not*valid'));
});
test('verifyTotp: accepts current and +-1 step, rejects far codes, bad format, and replays', () => {
  const s = newSecret(), now = 1_700_000_000_000;
  const code = totpAt(s, now);
  const step = verifyTotp(s, code, { now });
  assert.ok(step);
  assert.ok(verifyTotp(s, totpAt(s, now - 30_000), { now }));
  assert.ok(verifyTotp(s, totpAt(s, now + 30_000), { now }));
  assert.equal(verifyTotp(s, totpAt(s, now - 120_000), { now }), null);
  assert.equal(verifyTotp(s, '12345', { now }), null);
  assert.equal(verifyTotp(s, 'abcdef', { now }), null);
  assert.equal(verifyTotp(s, code, { now, lastStep: step }), null); // replay of an already-used code
  assert.equal(verifyTotp(s, code, { now, lastStep: step - 1 }) !== null, true);
});
test('secret encryption: round trip, tamper detection, wrong key, random IV', () => {
  const key = deriveKey('master-secret-master-secret-1234', 'totp'), other = deriveKey('master-secret-master-secret-1234', 'jwt');
  const blob = encryptSecret('JBSWY3DPEHPK3PXP', key);
  assert.equal(decryptSecret(blob, key), 'JBSWY3DPEHPK3PXP');
  assert.notEqual(blob, encryptSecret('JBSWY3DPEHPK3PXP', key));
  assert.throws(() => decryptSecret(blob, other));
  const parts = blob.split('.'); parts[2] = Buffer.from('x'.repeat(8)).toString('base64');
  assert.throws(() => decryptSecret(parts.join('.'), key));
});
test('secret decryption rejects truncated authentication tags (GCM tag-length pinning)', () => {
  const key = deriveKey('master-secret-master-secret-1234', 'totp');
  const [iv, tag, enc] = encryptSecret('JBSWY3DPEHPK3PXP', key).split('.').map((s) => Buffer.from(s, 'base64'));
  assert.equal(tag.length, 16);
  const short = [iv, tag.subarray(0, 4), enc].map((b) => b.toString('base64')).join('.');
  assert.throws(() => decryptSecret(short, key), /invalid ciphertext/); // a 4-byte tag is guessable; must never be accepted
  assert.throws(() => decryptSecret([iv.subarray(0, 8), tag, enc].map((b) => b.toString('base64')).join('.'), key));
  assert.throws(() => decryptSecret('garbage', key));
});
test('otpauth URL is well formed', () => {
  const u = otpauthUrl('JBSWY3DPEHPK3PXP', 'a+b@x.io');
  assert.match(u, /^otpauth:\/\/totp\/MobiAd:a%2Bb%40x\.io\?secret=JBSWY3DPEHPK3PXP&issuer=MobiAd/);
});
