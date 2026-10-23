import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, PW, codeNow } from './lib/helpers.js';
import { hashPw } from '../src/http.js';

const strict = { requireEmailVerification: true };

test('signup: password policy (length, common, contains email name, repetitive) and validation', async () => {
  const t = await boot();
  const bad = async (password, email = 'newuser@x.io') => (await t.call('/api/signup', 'POST', { email, password, role: 'advertiser' })).status;
  assert.equal(await bad('short'), 400);
  assert.equal(await bad('password123'), 400); // common
  assert.equal(await bad('Password1234'.toLowerCase()), 400);
  assert.equal(await bad('newuser-is-my-password'), 400); // contains the email name
  assert.equal(await bad('aaaaaaaaaaaa'), 400);
  assert.equal(await bad('x'.repeat(201)), 400);
  assert.equal((await t.call('/api/signup', 'POST', { email: 'not-an-email', password: PW, role: 'advertiser' })).status, 400);
  assert.equal((await t.call('/api/signup', 'POST', { email: 'a@x.io', password: PW, role: 'admin' })).status, 400); // nobody can self-register as admin
  assert.equal(await bad(PW), 201);
  await t.stop();
});

test('email verification: unverified accounts are gated; link works once; expired/invalid links fail', async () => {
  const t = await boot(strict);
  const s = await t.call('/api/signup', 'POST', { email: 'v@x.io', password: PW, role: 'advertiser' });
  assert.equal(s.status, 201); assert.equal(s.body.emailVerified, false);
  const mail = t.lastMail('v@x.io');
  assert.match(mail.subject, /Verify/); assert.match(mail.text, /\/app#verify=/); // token in the FRAGMENT: never sent to servers or logs
  const tok = t.tokenFrom('v@x.io', 'verify');
  const body = { name: 'c', bid: 1, budget: 5, clickUrl: 'https://example.com' };
  const gated = await t.call('/api/campaigns', 'POST', body, s.body.token);
  assert.equal(gated.status, 403); assert.equal(gated.body.error, 'email_not_verified');
  assert.equal((await t.call('/api/me', 'GET', null, s.body.token)).body.emailVerified, false);
  assert.equal((await t.call('/api/verify-email', 'POST', { token: 'nope' })).status, 400);
  assert.equal((await t.call('/api/verify-email', 'POST', {})).status, 400);
  assert.equal((await t.call('/api/verify-email', 'POST', { token: tok })).status, 200);
  assert.equal((await t.call('/api/verify-email', 'POST', { token: tok })).status, 400); // single use
  assert.equal((await t.call('/api/campaigns', 'POST', body, s.body.token)).status, 201);
  assert.equal((await t.call('/api/me', 'GET', null, s.body.token)).body.emailVerified, true);

  // expiry: age the token in the database
  const s2 = await t.call('/api/signup', 'POST', { email: 'v2@x.io', password: PW, role: 'publisher' });
  const tok2 = t.tokenFrom('v2@x.io', 'verify');
  await t.app.repo.q('UPDATE one_time_tokens SET expires_at=$1', [Date.now() - 1]);
  assert.equal((await t.call('/api/verify-email', 'POST', { token: tok2 })).status, 400);
  // resend issues a fresh working link and invalidates the old one
  assert.equal((await t.call('/api/resend-verification', 'POST', {}, s2.body.token)).status, 200);
  await new Promise((r) => setTimeout(r, 30));
  const fresh = t.tokenFrom('v2@x.io', 'verify');
  assert.notEqual(fresh, tok2);
  assert.equal((await t.call('/api/verify-email', 'POST', { token: fresh })).status, 200);
  assert.equal((await t.call('/api/resend-verification', 'POST', {}, s2.body.token)).body.alreadyVerified, true);
  await t.stop();
});

test('resend-verification is rate limited per account', async () => {
  const t = await boot(strict);
  const s = await t.call('/api/signup', 'POST', { email: 'rl@x.io', password: PW, role: 'advertiser' });
  let limited = 0;
  for (let i = 0; i < 8; i++) if ((await t.call('/api/resend-verification', 'POST', {}, s.body.token)).status === 429) limited++;
  assert.ok(limited >= 3);
  await t.stop();
});

test('password reset: no account enumeration, single-use, expiring, revokes sessions, weak password does not burn the token', async () => {
  const t = await boot(strict);
  const s = await t.call('/api/signup', 'POST', { email: 'reset@x.io', password: PW, role: 'advertiser' });
  const oldJwt = s.body.token;
  const before = t.app.mailer.outbox.length;
  const unknown = await t.call('/api/forgot-password', 'POST', { email: 'nobody@x.io' });
  const known = await t.call('/api/forgot-password', 'POST', { email: 'RESET@x.io' });
  assert.equal(unknown.status, 200); assert.equal(known.status, 200);
  assert.deepEqual(unknown.body, known.body); // identical responses
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(t.app.mailer.outbox.length, before + 1); // only the real account got mail
  const tok = t.tokenFrom('reset@x.io', 'reset');
  assert.equal((await t.call('/api/reset-password', 'POST', { token: tok, password: 'short' })).status, 400); // weak: token survives
  assert.equal((await t.call('/api/reset-password', 'POST', { token: tok, password: 'reset-is-my-name-9' })).status, 400); // contains email name
  const NEW = 'Correct-Staple-Battery-42';
  assert.equal((await t.call('/api/reset-password', 'POST', { token: tok, password: NEW })).status, 200);
  assert.equal((await t.call('/api/reset-password', 'POST', { token: tok, password: NEW + 'x' })).status, 400); // single use
  assert.equal((await t.call('/api/login', 'POST', { email: 'reset@x.io', password: PW })).status, 401); // old password dead
  assert.equal((await t.call('/api/login', 'POST', { email: 'reset@x.io', password: NEW })).status, 200);
  assert.equal((await t.call('/api/me', 'GET', null, oldJwt)).status, 401); // old session revoked
  await new Promise((r) => setTimeout(r, 30));
  assert.match(t.lastMail('reset@x.io').subject, /password was changed/);
  assert.equal((await t.call('/api/reset-password', 'POST', { token: 'garbage', password: NEW })).status, 400);
  // expiry
  await t.call('/api/forgot-password', 'POST', { email: 'reset@x.io' });
  await new Promise((r) => setTimeout(r, 30));
  const tok2 = t.tokenFrom('reset@x.io', 'reset');
  await t.app.repo.q('UPDATE one_time_tokens SET expires_at=$1', [Date.now() - 1]);
  assert.equal((await t.call('/api/reset-password', 'POST', { token: tok2, password: 'Another-Long-Pass-77' })).status, 400);
  await t.stop();
});

test('forgot-password is rate limited per email and per IP', async () => {
  const t = await boot(strict);
  await t.signup('fp@x.io', 'advertiser');
  const codes = [];
  for (let i = 0; i < 8; i++) codes.push((await t.call('/api/forgot-password', 'POST', { email: 'fp@x.io' })).status);
  assert.ok(codes.includes(429)); assert.equal(codes[0], 200);
  await t.stop();
});

test('sessions: change-password and logout-all revoke other sessions', async () => {
  const t = await boot();
  const a = await t.signup('sess@x.io', 'advertiser');
  const b = (await t.call('/api/login', 'POST', { email: 'sess@x.io', password: PW })).body.token; // second device
  assert.equal((await t.call('/api/me', 'GET', null, a)).status, 200);
  assert.equal((await t.call('/api/change-password', 'POST', { currentPassword: 'wrong-password-1', newPassword: 'Brand-New-Passw0rd!' }, a)).status, 400);
  assert.equal((await t.call('/api/change-password', 'POST', { currentPassword: PW, newPassword: 'weak' }, a)).status, 400);
  const ch = await t.call('/api/change-password', 'POST', { currentPassword: PW, newPassword: 'Brand-New-Passw0rd!' }, a);
  assert.equal(ch.status, 200);
  assert.equal((await t.call('/api/me', 'GET', null, a)).status, 401); // both old tokens dead
  assert.equal((await t.call('/api/me', 'GET', null, b)).status, 401);
  assert.equal((await t.call('/api/me', 'GET', null, ch.body.token)).status, 200); // the freshly issued one works
  assert.equal((await t.call('/api/logout-all', 'POST', {}, ch.body.token)).status, 200);
  assert.equal((await t.call('/api/me', 'GET', null, ch.body.token)).status, 401);
  await t.stop();
});

test('MFA: setup needs password, enable needs a valid code, login requires the code, codes are single-use, recovery codes work once', async () => {
  const t = await boot();
  const tok = await t.signup('mfa@x.io', 'advertiser');
  assert.equal((await t.call('/api/mfa/setup', 'POST', { password: 'wrong' }, tok)).status, 400);
  assert.equal((await t.call('/api/mfa/enable', 'POST', { code: '123456' }, tok)).status, 400); // no setup yet
  const setup = await t.call('/api/mfa/setup', 'POST', { password: PW }, tok);
  assert.equal(setup.status, 200); assert.match(setup.body.otpauthUrl, /^otpauth:\/\/totp\//);
  const secret = setup.body.secret;
  const stored = await t.app.repo.userByEmail('mfa@x.io');
  assert.ok(stored.totp_secret_enc && !stored.totp_secret_enc.includes(secret)); // encrypted at rest
  assert.equal((await t.call('/api/mfa/enable', 'POST', { code: '000000' }, tok)).status, 400);
  const en = await t.call('/api/mfa/enable', 'POST', { code: codeNow(secret) }, tok);
  assert.equal(en.status, 200); assert.equal(en.body.recoveryCodes.length, 8);
  assert.match(en.body.recoveryCodes[0], /^[0-9a-f]{5}-[0-9a-f]{5}$/);
  assert.equal((await t.call('/api/me', 'GET', null, tok)).status, 401); // pre-MFA session ended
  assert.equal((await t.call('/api/mfa/setup', 'POST', { password: PW }, en.body.token)).status, 409);

  const login = (code) => t.call('/api/login', 'POST', { email: 'mfa@x.io', password: PW, ...(code ? { code } : {}) });
  const need = await login();
  assert.equal(need.status, 401); assert.equal(need.body.error, 'mfa_required');
  assert.equal((await login('111111')).body.error, 'invalid_code');
  const good = codeNow(secret, 1); // the next 30 s step (inside the +-1 window; later than the step used to enable)
  assert.equal((await login(good)).status, 200);
  assert.equal((await login(good)).status, 401); // the same code cannot be replayed
  // recovery codes: each works exactly once
  const rc = en.body.recoveryCodes[0];
  assert.equal((await login(rc)).status, 200);
  assert.equal((await login(rc)).status, 401);
  assert.equal((await login(en.body.recoveryCodes[1].toUpperCase())).status, 200); // format-insensitive
  // disable needs password AND a code
  const cur = (await login(en.body.recoveryCodes[2])).body.token;
  assert.equal((await t.call('/api/mfa/disable', 'POST', { password: 'wrong', code: en.body.recoveryCodes[3] }, cur)).status, 400);
  assert.equal((await t.call('/api/mfa/disable', 'POST', { password: PW, code: '000000' }, cur)).status, 400);
  const dis = await t.call('/api/mfa/disable', 'POST', { password: PW, code: en.body.recoveryCodes[3] }, cur);
  assert.equal(dis.status, 200);
  assert.equal((await t.call('/api/login', 'POST', { email: 'mfa@x.io', password: PW })).status, 200); // back to password-only
  await t.stop();
});

test('MFA is not bypassed by password reset: reset needs the second factor too', async () => {
  const t = await boot(strict);
  const s = await t.call('/api/signup', 'POST', { email: 'mr@x.io', password: PW, role: 'advertiser' });
  const setup = await t.call('/api/mfa/setup', 'POST', { password: PW }, s.body.token);
  await t.call('/api/mfa/enable', 'POST', { code: codeNow(setup.body.secret) }, s.body.token);
  await t.call('/api/forgot-password', 'POST', { email: 'mr@x.io' });
  await new Promise((r) => setTimeout(r, 30));
  const tok = t.tokenFrom('mr@x.io', 'reset');
  const NEW = 'Totally-Different-Pass-55';
  assert.equal((await t.call('/api/reset-password', 'POST', { token: tok, password: NEW })).body.error, 'mfa_required'); // email access alone is not enough
  assert.equal((await t.call('/api/reset-password', 'POST', { token: tok, password: NEW, code: '000000' })).status, 401);
  assert.equal((await t.call('/api/reset-password', 'POST', { token: tok, password: NEW, code: codeNow(setup.body.secret, 1) })).status, 200);
  await t.stop();
});

test('audit trail records security events and is included in the data export', async () => {
  const t = await boot();
  const tok = await t.signup('aud@x.io', 'advertiser');
  await t.call('/api/login', 'POST', { email: 'aud@x.io', password: 'wrong-password-1' });
  await t.call('/api/login', 'POST', { email: 'aud@x.io', password: PW });
  await t.call('/api/logout-all', 'POST', {}, tok);
  const actions = (await t.app.repo.auditList({ limit: 50 })).map((a) => a.action);
  for (const a of ['signup', 'login_failed', 'login_success', 'logout_all']) assert.ok(actions.includes(a), a);
  const failed = (await t.app.repo.auditList({ action: 'login_failed' }))[0];
  assert.ok(!JSON.stringify(failed).includes('aud@x.io')); // the email itself is not written to the log, only a short hash
  const fresh = (await t.call('/api/login', 'POST', { email: 'aud@x.io', password: PW })).body.token;
  const exp = await t.call('/api/account/export', 'GET', null, fresh);
  assert.ok(exp.body.activityLog.some((a) => a.action === 'login_success'));
  await t.stop();
});

test('admin accounts cannot be created through signup, and admin routes reject non-admins and anonymous callers', async () => {
  const t = await boot();
  const adv = await t.signup('adv@x.io', 'advertiser');
  for (const [m, p] of [['GET', '/api/admin/overview'], ['GET', '/api/admin/campaigns'], ['GET', '/api/admin/users'], ['GET', '/api/admin/audit'], ['GET', '/api/admin/payouts']]) {
    assert.equal((await t.call(p, m, null, adv)).status, 403, p);
    assert.equal((await t.call(p, m)).status, 401, p);
  }
  await t.stop();
});

test('admin MFA requirement: admin APIs refuse an admin without MFA when required', async () => {
  const t = await boot({ requireAdminMfa: true });
  const admin = await t.makeAdmin();
  const denied = await t.call('/api/admin/overview', 'GET', null, admin);
  assert.equal(denied.status, 403); assert.equal(denied.body.error, 'mfa_required');
  const setup = await t.call('/api/mfa/setup', 'POST', { password: PW }, admin);
  const en = await t.call('/api/mfa/enable', 'POST', { code: codeNow(setup.body.secret) }, admin);
  assert.equal((await t.call('/api/admin/overview', 'GET', null, en.body.token)).status, 200);
  await t.stop();
});

test('hashPw uses a fresh salt each time', () => { assert.notEqual(hashPw('same-password-1').salt, hashPw('same-password-1').salt); });

import { settle, serve } from './lib/helpers.js';
test('secret rotation: old tokens and MFA secrets keep working during the overlap window and rotation completes without lockout', async () => {
  const SA = 'secret-A-secret-A-secret-A-secret-A-1234', SB = 'secret-B-secret-B-secret-B-secret-B-5678';
  const A = await boot({ secret: SA });
  const pool = A.app.repo.pool; // all three "deployments" share one database
  const done = async (t) => { t.app.server.closeAllConnections(); await new Promise((r) => t.app.server.close(r)); };

  // --- before rotation (secret A): user with MFA, a session token, and an ad with a tracking token
  const adv = await A.signup('rot@x.io', 'advertiser'), pub = await A.signup('rotp@x.io', 'publisher');
  const setup = await A.call('/api/mfa/setup', 'POST', { password: PW }, adv);
  const en = await A.call('/api/mfa/enable', 'POST', { code: codeNow(setup.body.secret, -1) }, adv); // consume the PREVIOUS time-step so later codes are fresh
  assert.equal(en.status, 200);
  const jwtA = en.body.token;
  await A.call('/api/campaigns', 'POST', { name: 'c', bid: 4, budget: 10, clickUrl: 'https://example.com' }, jwtA);
  const app = (await A.call('/api/apps', 'POST', { name: 'g', floorEcpm: 1 }, pub)).body;
  const served = await serve(A, app.id, { imp: false });
  assert.equal(served.status, 200);
  const trackingPath = A.path(served.ad.impressionUrl);
  await done(A);

  // --- rollout of secret B with A as the previous secret
  const B = await boot({ secret: SB, previousSecret: SA, pool });
  assert.equal((await B.call('/api/me', 'GET', null, jwtA)).status, 200);                    // session made under A still valid
  assert.equal((await B.call(trackingPath)).status, 200);                                     // tracking token made under A still counted
  await settle(B.app);
  assert.equal((await B.call('/api/report', 'GET', null, jwtA)).body.total.impressions, 1);
  const login1 = await B.call('/api/login', 'POST', { email: 'rot@x.io', password: PW, code: codeNow(setup.body.secret, 0) });
  assert.equal(login1.status, 200);                                                           // TOTP secret decrypted via the previous key
  await done(B);

  // --- rotation finished: the old secret is removed entirely
  const C = await boot({ secret: SB, pool });
  const login2 = await C.call('/api/login', 'POST', { email: 'rot@x.io', password: PW, code: codeNow(setup.body.secret, 1) });
  assert.equal(login2.status, 200);                                                           // MFA secret was re-encrypted with key B: no lockout
  assert.equal((await C.call('/api/me', 'GET', null, jwtA)).status, 401);                     // the old session is rejected once A is gone
  assert.equal((await C.call(trackingPath)).status, 400);                                     // and so is the old tracking token
  await done(C);
});
