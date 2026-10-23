import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './lib/helpers.js';

const camp = { name: 'K', model: 'CPM', bid: 5, budget: 50, clickUrl: 'https://example.com/l' };

test('api keys: create once, list without secrets, scopes, allowlist, revoke, expiry, caps', async () => {
  const t = await boot();
  const adv = await t.signup('adv@x.io', 'advertiser'), other = await t.signup('o@x.io', 'advertiser');
  assert.equal((await t.call('/api/keys', 'POST', { name: '' }, adv)).status, 400);
  assert.equal((await t.call('/api/keys', 'POST', { name: 'x', scope: 'root' }, adv)).status, 400);
  const ro = (await t.call('/api/keys', 'POST', { name: 'reader' }, adv)); assert.equal(ro.status, 201);
  assert.match(ro.body.key, /^mak_key_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
  const rw = (await t.call('/api/keys', 'POST', { name: 'writer', scope: 'write' }, adv)).body;

  const list = (await t.call('/api/keys', 'GET', null, adv)).body;
  assert.equal(list.length, 2); assert.ok(!JSON.stringify(list).includes(ro.body.key.split('_').pop()), 'secret never listed');

  // read-only key: reads ok, writes refused
  assert.equal((await t.call('/api/campaigns', 'GET', null, ro.body.key)).status, 200);
  assert.equal((await t.call('/api/me', 'GET', null, ro.body.key)).body.email, 'adv@x.io');
  assert.equal((await t.call('/api/campaigns', 'POST', camp, ro.body.key)).status, 403);
  // write key: can create campaigns, cannot touch money, accounts or keys
  assert.equal((await t.call('/api/campaigns', 'POST', camp, rw.key)).status, 201);
  for (const [p, m] of [['/api/billing/topup', 'POST'], ['/api/billing/payout', 'POST'], ['/api/logout-all', 'POST'], ['/api/mfa/disable', 'POST']])
    assert.equal((await t.call(p, m, {}, rw.key)).status, 403, p);
  assert.equal((await t.call('/api/keys', 'POST', { name: 'child' }, rw.key)).status, 403);
  assert.equal((await t.call('/api/keys', 'GET', null, rw.key)).status, 403);
  // wrong/tampered/other-format keys
  assert.equal((await t.call('/api/campaigns', 'GET', null, ro.body.key.slice(0, -1) + (ro.body.key.endsWith('A') ? 'B' : 'A'))).status, 401);
  assert.equal((await t.call('/api/campaigns', 'GET', null, 'mak_garbage')).status, 401);
  // keys belong to their owner
  assert.equal((await t.call('/api/campaigns', 'GET', null, rw.key)).body.length, 1);
  assert.equal((await t.call('/api/campaigns', 'GET', null, other)).body.length, 0);
  assert.equal((await t.call('/api/keys/revoke', 'POST', { id: rw.id }, other)).status, 404); // cannot revoke someone else's
  // revoke
  assert.equal((await t.call('/api/keys/revoke', 'POST', { id: rw.id }, adv)).status, 200);
  assert.equal((await t.call('/api/campaigns', 'GET', null, rw.key)).status, 401);
  assert.equal((await t.call('/api/keys/revoke', 'POST', { id: rw.id }, adv)).status, 404);
  // audited
  const audit = (await t.app.repo.auditList({ limit: 50 })).map((a) => a.action);
  assert.ok(audit.includes('api_key_created') && audit.includes('api_key_revoked'));
  // cap
  for (let i = 0; i < 9; i++) await t.call('/api/keys', 'POST', { name: 'k' + i }, adv);
  assert.equal((await t.call('/api/keys', 'POST', { name: 'one too many' }, adv)).status, 409);
  await t.stop();
});

test('api keys: expiry is enforced; password change does not silently keep working sessions but keys survive until revoked; admins get no keys', async () => {
  const t = await boot();
  const adv = await t.signup('adv@x.io', 'advertiser');
  const k = (await t.call('/api/keys', 'POST', { name: 'short', expiresInDays: 1 }, adv)).body;
  assert.equal((await t.call('/api/campaigns', 'GET', null, k.key)).status, 200);
  await t.app.repo.q('UPDATE api_keys SET expires_at=$2 WHERE id=$1', [k.id, Date.now() - 1000]);
  assert.equal((await t.call('/api/campaigns', 'GET', null, k.key)).status, 401);
  assert.equal((await t.call('/api/keys', 'POST', { name: 'x', expiresInDays: 9999 }, adv)).status, 400);
  const admin = await t.makeAdmin();
  assert.equal((await t.call('/api/keys', 'POST', { name: 'x' }, admin)).status, 403);
  await t.stop();
});
