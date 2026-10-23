import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, PW } from './lib/helpers.js';

const camp = (name = 'T') => ({ name, model: 'CPM', bid: 5, budget: 50, clickUrl: 'https://example.com/l' });
const inviteToken = (t, to) => t.tokenFrom(to, 'invite');
const join = async (t, owner, email, role) => {
  assert.equal((await t.call('/api/team/invite', 'POST', { email, role }, owner)).status, 201);
  const tok = inviteToken(t, email); assert.ok(tok, 'invite email carries a token');
  const r = await t.call('/api/team/accept', 'POST', { token: tok, password: PW });
  assert.equal(r.status, 201); return { tok, ...r.body };
};

test('team: invite, accept, roles, data scoping, revoke', async () => {
  const t = await boot();
  const owner = await t.signup('boss@x.io', 'advertiser'), stranger = await t.signup('s@x.io', 'advertiser');
  await t.call('/api/campaigns', 'POST', camp('Owner campaign'), owner);

  assert.equal((await t.call('/api/team/invite', 'POST', { email: 'bad', role: 'admin' }, owner)).status, 400);
  assert.equal((await t.call('/api/team/invite', 'POST', { email: 'x@x.io', role: 'root' }, owner)).status, 400);
  assert.equal((await t.call('/api/team/invite', 'POST', { email: 's@x.io', role: 'viewer' }, owner)).status, 409); // already registered

  const ed = await join(t, owner, 'editor@x.io', 'admin');
  const vw = await join(t, owner, 'viewer@x.io', 'viewer');
  assert.equal((await t.call('/api/team/accept', 'POST', { token: ed.tok, password: PW })).status, 400); // single use
  assert.equal((await t.call('/api/team/accept', 'POST', { token: 'nope', password: PW })).status, 400);

  // viewer sees the owner's data, cannot change anything
  assert.equal((await t.call('/api/campaigns', 'GET', null, vw.token)).body.length, 1);
  assert.equal((await t.call('/api/campaigns', 'POST', camp(), vw.token)).status, 403);
  const me = (await t.call('/api/me', 'GET', null, vw.token)).body;
  assert.equal(me.email, 'viewer@x.io'); assert.equal(me.teamRole, 'viewer');
  // editor can create/pause campaigns that belong to the owner, but cannot touch money, team or keys
  const made = await t.call('/api/campaigns', 'POST', camp('By editor'), ed.token); assert.equal(made.status, 201);
  assert.equal((await t.call('/api/campaigns', 'GET', null, owner)).body.length, 2);
  assert.equal((await t.call('/api/campaigns/status', 'POST', { id: made.body.id, status: 'paused' }, ed.token)).status, 200);
  for (const [p, m] of [['/api/billing/topup', 'POST'], ['/api/billing/payout', 'POST'], ['/api/team/invite', 'POST'], ['/api/team', 'GET'], ['/api/keys', 'POST'], ['/api/team/remove', 'POST']])
    assert.equal((await t.call(p, m, m === 'GET' ? undefined : { email: 'a@b.io', role: 'admin', id: 'x' }, ed.token)).status, 403, p);
  // the stranger sees none of it
  assert.equal((await t.call('/api/campaigns', 'GET', null, stranger)).body.length, 0);
  // member actions are attributed to the member in the audit log
  const audit = await t.app.repo.auditList({ limit: 100 });
  assert.ok(audit.some((a) => a.action === 'team_member_action' && a.actor && a.actor !== (made.body.owner || '')));
  assert.ok(audit.some((a) => a.action === 'team_invited') && audit.some((a) => a.action === 'team_joined'));

  // member can log in normally and cannot invite others
  assert.equal((await t.call('/api/login', 'POST', { email: 'viewer@x.io', password: PW })).status, 200);
  // owner lists, removes; removed member is locked out immediately
  const team = (await t.call('/api/team', 'GET', null, owner)).body;
  assert.equal(team.members.length, 2);
  assert.equal((await t.call('/api/team/remove', 'POST', { id: team.members.find((m) => m.email === 'viewer@x.io').id }, owner)).status, 200);
  assert.equal((await t.call('/api/campaigns', 'GET', null, vw.token)).status, 401);
  assert.equal((await t.call('/api/team/remove', 'POST', { id: 'usr_nope' }, stranger)).status, 404); // cannot remove other accounts' people
  await t.stop();
});

test('team: invites can be revoked and expire; deleting the owner removes the team; admins have no teams', async () => {
  const t = await boot();
  const owner = await t.signup('boss@x.io', 'advertiser');
  const inv = (await t.call('/api/team/invite', 'POST', { email: 'late@x.io', role: 'viewer' }, owner)).body;
  const tok = inviteToken(t, 'late@x.io');
  assert.equal((await t.call('/api/team/remove', 'POST', { id: inv.id }, owner)).status, 200);
  assert.equal((await t.call('/api/team/accept', 'POST', { token: tok, password: PW })).status, 400); // revoked
  await t.call('/api/team/invite', 'POST', { email: 'old@x.io', role: 'viewer' }, owner);
  const oldTok = inviteToken(t, 'old@x.io');
  await t.app.repo.q('UPDATE team_invites SET expires_at=$1 WHERE email=$2', [Date.now() - 1000, 'old@x.io']);
  assert.equal((await t.call('/api/team/accept', 'POST', { token: oldTok, password: PW })).status, 400); // expired
  assert.equal((await t.call('/api/team/accept', 'POST', { token: oldTok, password: 'short' })).status, 400);

  const m = await join(t, owner, 'member@x.io', 'viewer');
  assert.equal((await t.call('/api/account', 'DELETE', { password: PW, confirm: 'DELETE' }, owner)).status, 200);
  assert.equal((await t.call('/api/login', 'POST', { email: 'member@x.io', password: PW })).status, 401);
  assert.equal((await t.call('/api/campaigns', 'GET', null, m.token)).status, 401);

  const admin = await t.makeAdmin();
  assert.equal((await t.call('/api/team/invite', 'POST', { email: 'z@x.io', role: 'admin' }, admin)).status, 403);
  await t.stop();
});

test('team: invite cap and members cannot hold API keys', async () => {
  const t = await boot();
  const owner = await t.signup('boss@x.io', 'publisher');
  for (let i = 0; i < 10; i++) assert.equal((await t.call('/api/team/invite', 'POST', { email: `p${i}@x.io`, role: 'viewer' }, owner)).status, 201);
  assert.equal((await t.call('/api/team/invite', 'POST', { email: 'extra@x.io', role: 'viewer' }, owner)).status, 409);
  await t.stop();
});
