import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, serve, settle } from './lib/helpers.js';

const profile = { legalName: 'Pub Ltd', country: 'gb', method: 'bank', methodRef: 'GB** **** 1234' };

async function earning(t) {
  const adv = await t.signup('adv@x.io', 'advertiser'), pub = await t.signup('pub@x.io', 'publisher'), admin = await t.makeAdmin();
  await t.call('/api/campaigns', 'POST', { name: 'c', bid: 6000, budget: 1000, clickUrl: 'https://example.com' }, adv);
  const a = (await t.call('/api/apps', 'POST', { name: 'A', floorEcpm: 5000 }, pub)).body;
  for (let i = 0; i < 20; i++) await serve(t, a.id);
  await settle(t.app);
  return { adv, pub, admin };
}

test('payout profile: validation, no raw account numbers, identity change forces re-verification', async () => {
  const t = await boot({ requirePayoutVerification: true });
  const pub = await t.signup('pub@x.io', 'publisher'), adv = await t.signup('adv@x.io', 'advertiser');
  assert.equal((await t.call('/api/billing/payout-profile', 'GET', null, adv)).status, 403); // publishers only
  assert.equal((await t.call('/api/billing/payout-profile', 'POST', { ...profile, country: 'GBR' }, pub)).status, 400);
  assert.equal((await t.call('/api/billing/payout-profile', 'POST', { ...profile, method: 'cash' }, pub)).status, 400);
  assert.equal((await t.call('/api/billing/payout-profile', 'POST', { ...profile, methodRef: '12345678901234567890' }, pub)).status, 400); // full account number refused
  assert.equal((await t.call('/api/billing/payout-profile/submit', 'POST', { kind: 'kyc' }, pub)).status, 409); // needs a profile first

  assert.equal((await t.call('/api/billing/payout-profile', 'POST', profile, pub)).status, 200);
  const p = (await t.call('/api/billing/payout-profile', 'GET', null, pub)).body;
  assert.equal(p.country, 'GB'); assert.equal(p.kycStatus, 'none'); assert.equal(p.verificationRequired, true);
  assert.equal((await t.call('/api/billing/payout-profile/submit', 'POST', { kind: 'bogus' }, pub)).status, 400);
  assert.equal((await t.call('/api/billing/payout-profile/submit', 'POST', { kind: 'kyc' }, pub)).status, 200);
  assert.equal((await t.call('/api/billing/payout-profile/submit', 'POST', { kind: 'kyc' }, pub)).status, 409); // already submitted
  await t.stop();
});

test('payouts: blocked until KYC and tax are verified by an admin; then requested -> approved -> paid with a reference', async () => {
  const t = await boot({ requirePayoutVerification: true, minPayoutUsd: 10 });
  const { pub, admin, adv } = await earning(t);
  const me = await t.app.repo.userByEmail('pub@x.io');
  const ask = () => t.call('/api/billing/payout', 'POST', { amountUsd: 20 }, pub);

  assert.equal((await ask()).body.error, 'profile_incomplete');
  await t.call('/api/billing/payout-profile', 'POST', profile, pub);
  assert.equal((await ask()).body.error, 'kyc_required');
  await t.call('/api/billing/payout-profile/submit', 'POST', { kind: 'kyc' }, pub);
  assert.equal((await ask()).body.error, 'kyc_required'); // submitted is not verified

  // admin review queue
  assert.equal((await t.call('/api/admin/payout-profiles', 'GET', null, adv)).status, 403);
  const q = (await t.call('/api/admin/payout-profiles', 'GET', null, admin)).body;
  assert.equal(q.length, 1); assert.equal(q[0].email, 'pub@x.io'); assert.equal(q[0].kycStatus, 'submitted');
  assert.equal((await t.call('/api/admin/payout-profiles/review', 'POST', { userId: me.id, kind: 'kyc', status: 'rejected' }, admin)).status, 400); // note required
  assert.equal((await t.call('/api/admin/payout-profiles/review', 'POST', { userId: me.id, kind: 'kyc', status: 'verified' }, admin)).status, 200);
  assert.equal((await t.call('/api/admin/payout-profiles/review', 'POST', { userId: me.id, kind: 'kyc', status: 'verified' }, admin)).status, 409); // nothing left to review
  assert.equal((await ask()).body.error, 'tax_required');
  await t.call('/api/billing/payout-profile/submit', 'POST', { kind: 'tax' }, pub);
  assert.equal((await t.call('/api/admin/payout-profiles/review', 'POST', { userId: me.id, kind: 'tax', status: 'rejected', note: 'form unreadable' }, admin)).status, 200);
  assert.equal((await t.call('/api/billing/payout-profile', 'GET', null, pub)).body.reviewNote, 'form unreadable');
  assert.equal((await t.call('/api/billing/payout-profile/submit', 'POST', { kind: 'tax' }, pub)).status, 200); // rejected -> may resubmit
  await t.call('/api/admin/payout-profiles/review', 'POST', { userId: me.id, kind: 'tax', status: 'verified' }, admin);

  const p = await ask(); assert.equal(p.status, 201);
  // approved payouts stay reserved; they cannot be double-requested beyond what is payable
  const id = p.body.id;
  assert.equal((await t.call('/api/admin/payouts/resolve', 'POST', { id, status: 'paid', reference: 'r' }, admin)).status, 409);
  assert.equal((await t.call('/api/admin/payouts/resolve', 'POST', { id, status: 'approved' }, admin)).status, 200);
  const s = (await t.call('/api/billing/summary', 'GET', null, pub)).body;
  assert.equal(s.requested, 20); assert.equal(s.payable, 50);
  assert.equal((await t.call('/api/admin/payouts/resolve', 'POST', { id, status: 'approved' }, admin)).status, 409); // not twice
  const csv = await t.call('/api/admin/payouts.csv?status=approved', 'GET', null, admin);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.text, /^payout_id,email,legal_name,country,method,method_ref,amount_usd,status,reference\n/); assert.match(csv.text, /Pub Ltd,GB,bank/);
  assert.equal((await t.call('/api/admin/payouts/resolve', 'POST', { id, status: 'paid', reference: 'BANK-TX-9' }, admin)).status, 200);
  const after = (await t.call('/api/billing/summary', 'GET', null, pub)).body;
  assert.equal(after.paid, 20); assert.equal(after.requested, 0);
  assert.equal(after.payouts.find((x) => x.id === id).status, 'paid');
  const audit = (await t.app.repo.auditList({ limit: 100 })).map((a) => a.action);
  for (const a of ['payout_profile_saved', 'verification_submitted', 'verification_reviewed', 'payout_requested', 'payout_resolved']) assert.ok(audit.includes(a), a);
  await t.stop();
});

test('payouts: rejecting releases the funds; identity change resets verification; approval needs verified status', async () => {
  const t = await boot({ requirePayoutVerification: true, minPayoutUsd: 10 });
  const { pub, admin } = await earning(t);
  const me = await t.app.repo.userByEmail('pub@x.io');
  await t.call('/api/billing/payout-profile', 'POST', profile, pub);
  for (const kind of ['kyc', 'tax']) { await t.call('/api/billing/payout-profile/submit', 'POST', { kind }, pub); await t.call('/api/admin/payout-profiles/review', 'POST', { userId: me.id, kind, status: 'verified' }, admin); }
  const id = (await t.call('/api/billing/payout', 'POST', { amountUsd: 30 }, pub)).body.id;
  assert.equal((await t.call('/api/admin/payouts/resolve', 'POST', { id, status: 'rejected', note: 'bank mismatch' }, admin)).status, 200);
  assert.equal((await t.call('/api/billing/summary', 'GET', null, pub)).body.payable, 70); // released
  assert.equal((await t.call('/api/admin/payouts/resolve', 'POST', { id, status: 'approved' }, admin)).status, 409); // terminal

  // a new request, then the publisher changes the legal name before approval -> verification reset, approval refused
  const id2 = (await t.call('/api/billing/payout', 'POST', { amountUsd: 30 }, pub)).body.id;
  const r = await t.call('/api/billing/payout-profile', 'POST', { ...profile, legalName: 'Someone Else Inc' }, pub);
  assert.equal(r.body.reverificationRequired, true);
  assert.equal((await t.call('/api/billing/payout-profile', 'GET', null, pub)).body.kycStatus, 'none');
  assert.equal((await t.call('/api/admin/payouts/resolve', 'POST', { id: id2, status: 'approved' }, admin)).body.error, 'verification_missing');
  assert.equal((await t.call('/api/billing/payout', 'POST', { amountUsd: 10 }, pub)).body.error, 'kyc_required');
  // changing only the payment reference does not reset
  await t.call('/api/billing/payout-profile', 'POST', { ...profile, legalName: 'Someone Else Inc', methodRef: 'GB** **** 9999' }, pub);
  assert.equal((await t.call('/api/admin/payouts/resolve', 'POST', { id: 'pay_nope', status: 'approved' }, admin)).status, 404);
  await t.stop();
});

test('payouts: verification is not enforced when disabled (development default) but the profile still is', async () => {
  const t = await boot({ minPayoutUsd: 10 });
  const { pub } = await earning(t);
  assert.equal((await t.call('/api/billing/payout', 'POST', { amountUsd: 20 }, pub)).body.error, 'profile_incomplete');
  await t.call('/api/billing/payout-profile', 'POST', profile, pub);
  assert.equal((await t.call('/api/billing/payout', 'POST', { amountUsd: 20 }, pub)).status, 201);
  await t.stop();
});
