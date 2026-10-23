import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, settle } from './lib/helpers.js';
import { toAlpha2, rtbConsent, validBidRequest } from '../src/adserver/openrtb.js';

const camp = (o = {}) => ({ name: 'RTB', model: 'CPM', bid: 5, budget: 100, clickUrl: 'https://example.com/l', ...o });
const bidReq = (appId, o = {}) => ({ id: 'req1', imp: [{ id: '1', banner: { w: 320, h: 50 }, bidfloor: 0.5 }], app: { id: appId }, device: { ifa: 'abc', geo: { country: 'USA' } }, ...o });

test('openrtb: helpers map country, consent and validate requests', () => {
  assert.equal(toAlpha2('USA'), 'US'); assert.equal(toAlpha2('in'), 'IN'); assert.equal(toAlpha2('XXX'), '');
  assert.deepEqual(rtbConsent({ regs: { coppa: 1, ext: { gdpr: 1, us_privacy: '1YYN' } }, user: { ext: { consent: 'C' } }, device: { lmt: 1 } }),
    { coppa: true, gdpr: true, gdprConsent: 'C', usPrivacy: '1YYN', limitAdTracking: true });
  assert.equal(validBidRequest({ id: 'a', imp: [] }), false); assert.equal(validBidRequest(null), false); assert.equal(validBidRequest({ id: 'a', imp: [{}] }), true);
});

test('openrtb: bid response, floor, no-bid cases, and billing only after the win notice', async () => {
  const t = await boot();
  const adv = await t.signup('adv@x.io', 'advertiser'), pub = await t.signup('pub@x.io', 'publisher');
  await t.call('/api/campaigns', 'POST', camp(), adv);
  const a = (await t.call('/api/apps', 'POST', { name: 'ex' }, pub)).body;

  assert.equal((await t.call('/rtb/v2.6/bid', 'POST', { nope: 1 })).status, 400);
  assert.equal((await t.call('/rtb/v2.6/bid', 'POST', bidReq('app_unknown'))).status, 204);

  const ok = await t.call('/rtb/v2.6/bid', 'POST', bidReq(a.id));
  assert.equal(ok.status, 200);
  const bid = ok.body.seatbid[0].bid[0];
  assert.equal(ok.body.cur, 'USD'); assert.equal(bid.impid, '1'); assert.ok(bid.price >= 0.5 && bid.price <= 5);
  assert.match(bid.adm, /\/t\/c\//);
  assert.equal((await t.call('/rtb/v2.6/bid', 'POST', bidReq(a.id, { imp: [{ id: '1', banner: {}, bidfloor: 50 }] }))).status, 204); // floor above our bid
  assert.equal((await t.call('/rtb/v2.6/bid', 'POST', bidReq(a.id, { imp: [{ id: '1', video: {} }] }))).status, 204); // banner only
  assert.equal((await t.call('/rtb/v2.6/bid', 'POST', bidReq(a.id, { imp: [{ id: '1', banner: {}, bidfloorcur: 'EUR' }] }))).status, 204);

  await settle(t.app);
  assert.equal((await t.call('/api/report', 'GET', null, adv)).body.total.spend, 0); // bidding alone costs nothing
  await t.call(t.path(bid.nurl)); await t.call(t.path(bid.nurl)); // win notice, replayed
  await settle(t.app);
  const s = (await t.call('/api/report', 'GET', null, adv)).body.total;
  assert.equal(s.impressions, 1); assert.ok(Math.abs(s.spend - bid.price / 1000) < 1e-9);
  await t.stop();
});

test('openrtb: child-directed (COPPA) traffic gets no non-child-safe ads; self-dealing is blocked', async () => {
  const t = await boot();
  const adv = await t.signup('adv@x.io', 'advertiser'), pub = await t.signup('pub@x.io', 'publisher');
  await t.call('/api/campaigns', 'POST', camp(), adv);
  const a = (await t.call('/api/apps', 'POST', { name: 'ex' }, pub)).body;
  assert.equal((await t.call('/rtb/v2.6/bid', 'POST', bidReq(a.id, { regs: { coppa: 1 } }))).status, 204);
  const own = (await t.call('/api/apps', 'POST', { name: 'mine' }, adv)).body; // advertiser also owns an app
  if (own?.id) assert.equal((await t.call('/rtb/v2.6/bid', 'POST', bidReq(own.id))).status, 204);
  await t.stop();
});
