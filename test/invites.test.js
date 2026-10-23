// Invite-only sign-up for the private beta.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, PW } from './lib/helpers.js';
import { normalizeCode, hashCode, newCode } from '../src/auth/invites.js';

test('invite codes: readable, high-entropy, matched ignoring case, spaces and dashes; only a hash is stored', () => {
  const c = newCode(); assert.match(c, /^MA-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/); assert.doesNotMatch(c, /[ILO01]/);
  assert.notEqual(newCode(), newCode());
  assert.equal(normalizeCode(' ma-ab12 - cd34-ef56 '), 'MAAB12CD34EF56'); assert.equal(hashCode('ma-ab12-cd34-ef56'), hashCode('MA AB12CD34EF56'));
  assert.notEqual(hashCode('MA-AAAA-AAAA-AAAA'), hashCode('MA-AAAA-AAAA-AAAB')); assert.match(hashCode('x'), /^[0-9a-f]{64}$/);
});

test('invite-only: no code, wrong code, wrong account type, wrong e-mail, expired, revoked and used-up codes are all refused', async () => {
  const t = await boot({ inviteOnly: true, requireTermsAcceptance: false });
  const admin = await t.makeAdmin();
  assert.equal((await t.call('/api/public-config')).body.inviteOnly, true);
  const signup = (email, role, code) => t.call('/api/signup', 'POST', { email, password: PW, role, inviteCode: code });
  const make = async (b) => (await t.call('/api/admin/invites', 'POST', b, admin)).body;

  assert.equal((await signup('a@x.io', 'advertiser')).status, 403); assert.equal((await signup('a@x.io', 'advertiser')).body.error, 'invite_required');
  assert.equal((await signup('a@x.io', 'advertiser', 'MA-NOPE-NOPE-NOPE')).body.error, 'invite_invalid');

  const inv = await make({ role: 'advertiser', note: 'Acme beta' }); assert.match(inv.code, /^MA-/);
  assert.equal((await signup('p@x.io', 'publisher', inv.code)).body.error, 'invite_invalid'); // issued for an advertiser
  const ok = await signup('a@x.io', 'advertiser', inv.code.toLowerCase().replace(/-/g, ' ')); assert.equal(ok.status, 201); assert.ok(ok.body.token);
  assert.equal((await signup('a2@x.io', 'advertiser', inv.code)).body.error, 'invite_invalid'); // single use

  const bound = await make({ role: 'publisher', email: 'Dev@Studio.io' });
  assert.equal((await signup('other@x.io', 'publisher', bound.code)).status, 403); // bound to another address
  assert.equal((await signup('dev@studio.io', 'publisher', bound.code)).status, 201);

  const multi = await make({ role: 'advertiser', maxUses: 2 });
  assert.equal((await signup('m1@x.io', 'advertiser', multi.code)).status, 201); assert.equal((await signup('m2@x.io', 'advertiser', multi.code)).status, 201); assert.equal((await signup('m3@x.io', 'advertiser', multi.code)).status, 403);

  const old = await make({ role: 'advertiser' });
  await t.app.repo.q('UPDATE signup_invites SET expires_at=$1 WHERE id=$2', [Date.now() - 1000, old.id]); assert.equal((await signup('e@x.io', 'advertiser', old.code)).status, 403); // expired
  const rev = await make({ role: 'advertiser' });
  assert.equal((await t.call('/api/admin/invites/revoke', 'POST', { id: rev.id }, admin)).status, 200); assert.equal((await signup('r@x.io', 'advertiser', rev.code)).status, 403); // revoked
  assert.equal((await t.call('/api/admin/invites/revoke', 'POST', { id: 'nope' }, admin)).status, 404);

  const list = (await t.call('/api/admin/invites', 'GET', null, admin)).body;
  const statuses = Object.fromEntries(list.map((i) => [i.id, i.status])); assert.equal(statuses[inv.id], 'used up'); assert.equal(statuses[old.id], 'expired'); assert.equal(statuses[rev.id], 'revoked'); assert.equal(statuses[multi.id], 'used up');
  assert.ok(!JSON.stringify(list).includes(inv.code) && !JSON.stringify(list).includes('code_hash')); // codes are never readable again
  const audit = (await t.call('/api/admin/audit?limit=100', 'GET', null, admin)).body; assert.ok(audit.some((a) => a.action === 'invite_created')); assert.ok(audit.some((a) => a.action === 'invite_revoked'));
  await t.stop();
});

test('invite-only: two people racing for the last use cannot both win, and a taken e-mail gives the use back', async () => {
  const t = await boot({ inviteOnly: true, requireTermsAcceptance: false });
  const admin = await t.makeAdmin(), mk = async (b) => (await t.call('/api/admin/invites', 'POST', b, admin)).body;
  const signup = (email, code) => t.call('/api/signup', 'POST', { email, password: PW, role: 'advertiser', inviteCode: code });
  const one = await mk({ role: 'advertiser' });
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => signup(`r${i}@x.io`, one.code)));
  assert.equal(results.filter((r) => r.status === 201).length, 1); assert.equal(results.filter((r) => r.status === 403).length, 5);

  const two = await mk({ role: 'advertiser' });
  assert.equal((await signup('r0@x.io', two.code)).status, 409); // e-mail already registered: nothing consumed
  assert.equal((await signup('fresh@x.io', two.code)).status, 201); // the code still works for a free address
  await t.stop();
});

test('invites: only admins manage them, inputs are validated, e-mail invites are sent, and open sign-up still works when invite-only is off', async () => {
  const t = await boot({ inviteOnly: true, requireTermsAcceptance: false });
  const admin = await t.makeAdmin(); await t.app.repo.createUser({ id: 'usr_x', email: 'adv@x.io', role: 'advertiser', ...(await import('../src/http.js')).hashPw(PW), emailVerified: true });
  const advTok = (await t.call('/api/login', 'POST', { email: 'adv@x.io', password: PW })).body.token;
  assert.equal((await t.call('/api/admin/invites', 'POST', { role: 'advertiser' }, advTok)).status, 403); assert.equal((await t.call('/api/admin/invites', 'GET', null, advTok)).status, 403);
  assert.equal((await t.call('/api/admin/invites', 'POST', { role: 'admin' }, admin)).status, 400); assert.equal((await t.call('/api/admin/invites', 'POST', { role: 'advertiser', email: 'nope' }, admin)).status, 400);
  assert.equal((await t.call('/api/admin/invites', 'POST', { role: 'advertiser', maxUses: 500 }, admin)).status, 400); assert.equal((await t.call('/api/admin/invites', 'POST', { role: 'advertiser', expiresInDays: 0 }, admin)).status, 400);
  const sent = await t.call('/api/admin/invites', 'POST', { role: 'publisher', email: 'dev@studio.io' }, admin); assert.equal(sent.body.emailed, true);
  const mail = t.lastMail('dev@studio.io'); assert.match(mail.subject, /invited/); assert.ok(mail.text.includes(sent.body.code)); assert.match(mail.text, /#signup=[A-Z0-9]+&role=publisher/);
  await t.stop();
  const open = await boot({ inviteOnly: false, requireTermsAcceptance: false });
  assert.equal((await open.call('/api/public-config')).body.inviteOnly, false);
  assert.equal((await open.call('/api/signup', 'POST', { email: 'free@x.io', password: PW, role: 'advertiser' })).status, 201);
  await open.stop();
});
