import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, PW, serve, human, settle } from './lib/helpers.js';
import { signStripePayload } from '../src/billing/stripe.js';

const camp = (o = {}) => ({ name: 'Launch', bid: 8, budget: 50, clickUrl: 'https://example.com/landing', ...o });

test('review workflow: pending campaigns are not served until an admin approves; rejection stops serving; everything is audited', async () => {
  const t = await boot({ autoApproveCampaigns: false });
  const adv = await t.signup('adv@x.io', 'advertiser'), pub = await t.signup('pub@x.io', 'publisher'), admin = await t.makeAdmin();
  const c = (await t.call('/api/campaigns', 'POST', camp(), adv)).body;
  assert.equal(c.reviewStatus, 'pending');
  const a = (await t.call('/api/apps', 'POST', { name: 'g', floorEcpm: 1 }, pub)).body;
  assert.equal((await t.call('/v1/ad', 'POST', { appId: a.id })).status, 204); // not served while pending

  const pending = (await t.call('/api/admin/campaigns?status=pending', 'GET', null, admin)).body;
  assert.deepEqual(pending.map((x) => x.id), [c.id]);
  assert.equal((await t.call('/api/admin/campaigns?status=bogus', 'GET', null, admin)).status, 400);
  assert.equal((await t.call('/api/admin/overview', 'GET', null, admin)).body.pendingCampaigns, 1);
  assert.equal((await t.call('/api/admin/campaigns/review', 'POST', { id: c.id, decision: 'reject' }, admin)).status, 400); // reason required
  assert.equal((await t.call('/api/admin/campaigns/review', 'POST', { id: 'nope', decision: 'approve' }, admin)).status, 400);
  assert.equal((await t.call('/api/admin/campaigns/review', 'POST', { id: c.id, decision: 'approve' }, adv)).status, 403);

  assert.equal((await t.call('/api/admin/campaigns/review', 'POST', { id: c.id, decision: 'approve', note: 'looks fine' }, admin)).status, 200);
  assert.equal((await t.call('/v1/ad', 'POST', { appId: a.id })).status, 200); // served immediately on this replica
  const mine = (await t.call('/api/campaigns', 'GET', null, adv)).body[0];
  assert.equal(mine.reviewStatus, 'approved'); assert.equal(mine.reviewNote, 'looks fine');

  assert.equal((await t.call('/api/admin/campaigns/review', 'POST', { id: c.id, decision: 'reject', note: 'misleading claims' }, admin)).status, 200);
  assert.equal((await t.call('/v1/ad', 'POST', { appId: a.id })).status, 204); // suspended again
  await new Promise((r) => setTimeout(r, 30));
  assert.match(t.lastMail('adv@x.io').text, /misleading claims/); // advertiser is told why
  const acts = (await t.call('/api/admin/audit?action=campaign_reviewed', 'GET', null, admin)).body;
  assert.equal(acts.length, 2); assert.equal(acts[0].detail.decision, 'reject');
  await t.stop();
});

test('creative screening: hard failures are 400 with reasons; soft flags force manual review even in auto-approve mode', async () => {
  const t = await boot({ autoApproveCampaigns: true, requireHttpsCreatives: true });
  const adv = await t.signup('adv@x.io', 'advertiser'), pub = await t.signup('pub@x.io', 'publisher');
  const post = (o) => t.call('/api/campaigns', 'POST', camp(o), adv);
  for (const clickUrl of ['javascript:alert(1)', 'http://example.com/insecure', 'https://127.0.0.1/x', 'https://user:pw@example.com/', 'https://169.254.169.254/latest/meta-data']) {
    const r = await post({ clickUrl });
    assert.equal(r.status, 400, clickUrl); assert.equal(r.body.error, 'creative_rejected'); assert.ok(r.body.reasons.length);
  }
  assert.equal((await post({ image: 'https://10.0.0.1/x.png' })).status, 400);
  assert.equal((await post({ category: 'weapons' })).status, 400);
  assert.equal((await post({ budget: 1e9 })).status, 400);
  assert.equal((await post({ childSafe: true, category: 'gambling' })).status, 400); // a gambling ad can never be child-safe
  const clean = await post({}); assert.equal(clean.body.reviewStatus, 'approved');
  const risky = await post({ category: 'gambling', name: 'Casino' }); assert.equal(risky.body.reviewStatus, 'pending');
  assert.match(risky.body.reviewNote, /manual review/);
  const scam = await post({ title: 'You have won a free prize' }); assert.equal(scam.body.reviewStatus, 'pending');
  const a = (await t.call('/api/apps', 'POST', { name: 'g' }, pub)).body;
  const seen = new Set();
  for (let i = 0; i < 6; i++) { const r = await t.call('/v1/ad', 'POST', { appId: a.id }); if (r.status === 200) seen.add(r.body.creative.title); }
  assert.deepEqual([...seen], ['Launch']); // only the approved clean one ever serves
  await t.stop();
});

test('wallet funding: budgets must be covered; reserve/release math; admin credits are audited and idempotent', async () => {
  const t = await boot({ requireFunding: true, autoApproveCampaigns: true, paymentsMode: 'test' });
  const adv = await t.signup('adv@x.io', 'advertiser'), admin = await t.makeAdmin();
  const me = await t.app.repo.userByEmail('adv@x.io');
  const summary = async () => (await t.call('/api/billing/summary', 'GET', null, adv)).body;
  const broke = await t.call('/api/campaigns', 'POST', camp({ budget: 60 }), adv);
  assert.equal(broke.status, 402); assert.equal(broke.body.error, 'insufficient_funds'); assert.equal(broke.body.availableUsd, 0);

  assert.equal((await t.call('/api/admin/wallet/credit', 'POST', { userId: me.id, amountUsd: 100 }, admin)).status, 400); // note required
  assert.equal((await t.call('/api/admin/wallet/credit', 'POST', { userId: 'nope', amountUsd: 100, note: 'x' }, admin)).status, 400);
  assert.equal((await t.call('/api/admin/wallet/credit', 'POST', { userId: me.id, amountUsd: 100, note: 'bank transfer #1', reference: 'wire-1' }, adv)).status, 403);
  assert.equal((await t.call('/api/admin/wallet/credit', 'POST', { userId: me.id, amountUsd: 100, note: 'bank transfer #1', reference: 'wire-1' }, admin)).body.applied, true);
  assert.equal((await t.call('/api/admin/wallet/credit', 'POST', { userId: me.id, amountUsd: 100, note: 'bank transfer #1', reference: 'wire-1' }, admin)).body.applied, false); // no double credit
  let s = await summary(); assert.equal(s.credits, 100); assert.equal(s.available, 100); assert.equal(s.reserved, 0);

  const c1 = await t.call('/api/campaigns', 'POST', camp({ budget: 60 }), adv); assert.equal(c1.status, 201);
  s = await summary(); assert.equal(s.reserved, 60); assert.equal(s.available, 40);
  const over = await t.call('/api/campaigns', 'POST', camp({ budget: 60 }), adv);
  assert.equal(over.status, 402); assert.equal(over.body.availableUsd, 40); assert.equal(over.body.requiredUsd, 60);
  assert.equal((await t.call('/api/campaigns', 'POST', camp({ budget: 40 }), adv)).status, 201);
  s = await summary(); assert.equal(s.available, 0);

  // rejecting a campaign releases its reservation
  assert.equal((await t.call('/api/admin/campaigns/review', 'POST', { id: c1.body.id, decision: 'reject', note: 'policy' }, admin)).status, 200);
  s = await summary(); assert.equal(s.available, 60);
  assert.equal((await t.call('/api/campaigns', 'POST', camp({ budget: 60 }), adv)).status, 201);

  // test-mode top-up and limits
  assert.equal((await t.call('/api/billing/topup', 'POST', { amountUsd: 1 }, adv)).status, 400); // below minimum
  assert.equal((await t.call('/api/billing/topup', 'POST', { amountUsd: 50 }, adv)).body.test, true);
  assert.equal((await summary()).credits, 150);
  const audit = (await t.call('/api/admin/audit?action=wallet_credit', 'GET', null, admin)).body;
  assert.equal(audit.length, 1); assert.equal(audit[0].detail.reference, 'wire-1');
  assert.equal((await t.call('/api/billing/summary', 'GET', null, admin)).status, 403); // admins have no wallet
  await t.stop();
});

test('payments disabled: top-up answers 501; an unverified account cannot add funds', async () => {
  const none = await boot({ paymentsMode: 'none' });
  const a = await none.signup('a@x.io', 'advertiser');
  assert.equal((await none.call('/api/billing/topup', 'POST', { amountUsd: 50 }, a)).status, 501);
  assert.equal((await none.call('/api/webhooks/stripe', 'POST', {})).status, 404); // webhook is off unless Stripe is configured
  await none.stop();
  const strict = await boot({ requireEmailVerification: true, paymentsMode: 'test' });
  const s = await strict.call('/api/signup', 'POST', { email: 'u@x.io', password: PW, role: 'advertiser' });
  assert.equal((await strict.call('/api/billing/topup', 'POST', { amountUsd: 50 }, s.body.token)).status, 403);
  await strict.stop();
});

test('Stripe webhook: signature required, credits exactly once, ignores unpaid/other events and non-advertisers', async () => {
  const secret = 'whsec_integration';
  const t = await boot({ paymentsMode: 'stripe', stripeSecretKey: 'sk_test_x', stripeWebhookSecret: secret });
  const adv = await t.signup('adv@x.io', 'advertiser'), pub = await t.signup('pub@x.io', 'publisher');
  const me = await t.app.repo.userByEmail('adv@x.io'), pubU = await t.app.repo.userByEmail('pub@x.io');
  const ev = (o = {}, type = 'checkout.session.completed') => JSON.stringify({ id: 'evt_' + Math.random(), type, data: { object: { id: 'cs_1', payment_status: 'paid', amount_total: 5000, currency: 'usd', metadata: { user_id: me.id }, ...o } } });
  const hook = (raw, sig = signStripePayload(raw, secret)) => t.call('/api/webhooks/stripe', 'POST', null, null, raw, { 'stripe-signature': sig });
  const credits = async () => (await t.call('/api/billing/summary', 'GET', null, adv)).body.credits;
  const raw = ev();
  assert.equal((await hook(raw, 't=1,v1=deadbeef')).status, 400); // forged
  assert.equal((await hook(raw, signStripePayload(raw, 'wrong-secret'))).status, 400);
  assert.equal((await hook(raw, signStripePayload(raw, secret, Math.floor(Date.now() / 1000) - 3600))).status, 400); // replayed old delivery
  assert.equal((await t.call('/api/webhooks/stripe', 'POST', null, null, raw)).status, 400); // no signature header at all
  assert.equal(await credits(), 0);
  assert.equal((await hook(raw)).status, 200); assert.equal(await credits(), 50);
  assert.equal((await hook(raw)).status, 200); assert.equal(await credits(), 50); // retry delivery: still 50
  assert.equal((await hook(ev({ payment_status: 'unpaid', id: 'cs_2' }))).status, 200); assert.equal(await credits(), 50);
  assert.equal((await hook(ev({ currency: 'eur', id: 'cs_3' }))).status, 200); assert.equal(await credits(), 50);
  assert.equal((await hook(ev({}, 'charge.refunded'))).status, 200); assert.equal(await credits(), 50);
  assert.equal((await hook(ev({ id: 'cs_4', metadata: { user_id: pubU.id } }))).status, 200); // publishers have no wallet
  assert.equal((await hook(ev({ id: 'cs_5', metadata: { user_id: 'usr_ghost' } }))).status, 200);
  assert.equal(await credits(), 50);
  assert.equal((await hook(ev({ id: 'cs_6', amount_total: 2500 }))).status, 200); assert.equal(await credits(), 75); // a different session credits normally
  assert.equal((await t.call('/api/webhooks/stripe', 'POST', null, null, 'x'.repeat(300_000), { 'stripe-signature': 'a' })).status, 413);
  await t.stop();
});

test('publisher payouts: minimum, payable cap, flagged apps are held, admin resolves once, statements/CSV are safe', async () => {
  const t = await boot({ minPayoutUsd: 50 });
  const adv = await t.signup('adv@x.io', 'advertiser'), pub = await t.signup('pub@x.io', 'publisher'), admin = await t.makeAdmin();
  const name = "=HYPERLINK(\"http://evil\",\"x\")"; // spreadsheet formula injection attempt via a user-controlled name
  const c = (await t.call('/api/campaigns', 'POST', camp({ name, bid: 6000, budget: 1000 }), adv)).body;
  const a = (await t.call('/api/apps', 'POST', { name: 'Big App', floorEcpm: 5000 }, pub)).body;
  for (let i = 0; i < 20; i++) assert.equal((await serve(t, a.id)).status, 200); // 20 impressions x $5 = $100 spend
  await settle(t.app);
  const sum = async () => (await t.call('/api/billing/summary', 'GET', null, pub)).body;
  let s = await sum(); assert.equal(s.earned, 70); assert.equal(s.payable, 70); // 70% publisher share
  assert.equal((await t.call('/api/billing/payout', 'POST', { amountUsd: 10 }, pub)).status, 400); // below minimum
  assert.equal((await t.call('/api/billing/payout', 'POST', { amountUsd: 80 }, pub)).status, 409); // more than payable
  assert.equal((await t.call('/api/billing/payout', 'POST', { amountUsd: 50 }, adv)).status, 403);

  // fraud hold: flagged app earnings are not payable
  assert.equal((await t.call('/api/admin/apps/flag', 'POST', { id: a.id, flagged: true, reason: 'suspicious CTR' }, admin)).status, 200);
  s = await sum(); assert.equal(s.payable, 0); assert.equal(s.held, 70);
  assert.equal((await t.call('/api/billing/payout', 'POST', { amountUsd: 50 }, pub)).status, 409);
  assert.equal((await t.call('/api/admin/apps/flagged', 'GET', null, admin)).body[0].flagReason, 'suspicious CTR');
  assert.equal((await t.call('/api/admin/apps/flag', 'POST', { id: a.id, flagged: false }, admin)).status, 200);
  s = await sum(); assert.equal(s.payable, 70);

  assert.equal((await t.call('/api/billing/payout', 'POST', { amountUsd: 60 }, pub)).body.error, 'profile_incomplete');
  assert.equal((await t.call('/api/billing/payout-profile', 'POST', { legalName: 'Pub Ltd', country: 'GB', method: 'paypal', methodRef: 'pay@pub.example' }, pub)).status, 200);
  const p = await t.call('/api/billing/payout', 'POST', { amountUsd: 60 }, pub);
  assert.equal(p.status, 201);
  s = await sum(); assert.equal(s.requested, 60); assert.equal(s.payable, 10);
  // a flag raised after money was requested can only hold what is still unpaid; "payable" never goes negative
  await t.call('/api/admin/apps/flag', 'POST', { id: a.id, flagged: true, reason: 'late flag' }, admin);
  s = await sum(); assert.equal(s.held, 10); assert.equal(s.payable, 0); assert.equal(s.requested, 60);
  await t.call('/api/admin/apps/flag', 'POST', { id: a.id, flagged: false }, admin);
  s = await sum(); assert.equal(s.payable, 10);
  assert.equal((await t.call('/api/admin/payouts', 'GET', null, admin)).body.length, 1);
  assert.equal((await t.call('/api/admin/payouts/resolve', 'POST', { id: p.body.id, status: 'paid', note: 'wire ref 123' }, adv)).status, 403);
  assert.equal((await t.call('/api/admin/payouts/resolve', 'POST', { id: p.body.id, status: 'bogus' }, admin)).status, 400);
  assert.equal((await t.call('/api/admin/payouts/resolve', 'POST', { id: p.body.id, status: 'paid', reference: 'wire-123' }, admin)).status, 409); // must be approved first
  assert.equal((await t.call('/api/admin/payouts/resolve', 'POST', { id: p.body.id, status: 'approved' }, admin)).status, 200);
  assert.equal((await t.call('/api/admin/payouts/resolve', 'POST', { id: p.body.id, status: 'paid' }, admin)).status, 400); // reference required
  assert.equal((await t.call('/api/admin/payouts/resolve', 'POST', { id: p.body.id, status: 'paid', note: 'wire', reference: 'wire-123' }, admin)).status, 200);
  assert.equal((await t.call('/api/admin/payouts/resolve', 'POST', { id: p.body.id, status: 'paid', reference: 'wire-123' }, admin)).status, 409); // cannot pay twice
  s = await sum(); assert.equal(s.paid, 60); assert.equal(s.requested, 0); assert.equal(s.payable, 10);

  // statements and CSV
  const month = new Date().toISOString().slice(0, 7);
  const st = await t.call(`/api/billing/statement?month=${month}`, 'GET', null, adv);
  assert.equal(st.status, 200); assert.match(st.headers.get('content-type'), /text\/csv/);
  const lines = st.text.trim().split('\n');
  assert.equal(lines[0], 'date,campaign,id,impressions,clicks,installs,invalid_clicks,amount_usd');
  assert.ok(lines[1].includes(`"'=HYPERLINK`)); // neutralised: starts with an apostrophe inside quotes
  assert.ok(!lines[1].startsWith('=') && !/(^|,)=/.test(lines[1]));
  assert.ok(lines[1].endsWith(',100'));
  assert.equal((await t.call('/api/billing/statement?month=2026-13', 'GET', null, adv)).status, 400);
  assert.equal((await t.call('/api/billing/statement?month=1999-01', 'GET', null, adv)).text.trim().split('\n').length, 1); // empty month: header only
  const pubStatement = await t.call(`/api/billing/statement?month=${month}`, 'GET', null, pub);
  assert.ok(pubStatement.text.split('\n')[1].endsWith(',70'));
  const rep = await t.call('/api/report.csv', 'GET', null, adv);
  assert.match(rep.text, /^date,impressions,clicks,ctr,invalid_clicks,conversions,conversion_value_usd,spend_usd/);
  assert.equal(rep.headers.get('x-content-type-options'), 'nosniff');
  await t.stop();
});

test('deleting an advertiser with unspent credit is refused (money is never silently destroyed)', async () => {
  const t = await boot({ paymentsMode: 'test' });
  const adv = await t.signup('adv@x.io', 'advertiser');
  await t.call('/api/billing/topup', 'POST', { amountUsd: 25 }, adv);
  const r = await t.call('/api/account', 'DELETE', { password: PW, confirm: 'DELETE' }, adv);
  assert.equal(r.status, 409); assert.equal(r.body.error, 'balance_remaining');
  await t.stop();
});
