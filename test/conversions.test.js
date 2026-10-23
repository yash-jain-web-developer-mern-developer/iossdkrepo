import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, human, settle } from './lib/helpers.js';
import { sign, deriveKey } from '../src/core/token.js';
import { ecpm, predictCvr } from '../src/core/auction.js';

const SECRET = 'test-secret-test-secret-test-secret-1234';
const cpa = (o = {}) => ({ name: 'CPA', model: 'CPA', bid: 3, budget: 100, clickUrl: 'https://example.com/landing?x=1', conversionEvent: 'purchase', ...o });
const post = (t, body, key) => t.call('/v1/conversion', 'POST', body, key);

async function setup(campaign = cpa()) {
  const t = await boot();
  const adv = await t.signup('adv@x.io', 'advertiser'), pub = await t.signup('pub@x.io', 'publisher');
  const key = (await t.call('/api/keys', 'POST', { name: 's2s', scope: 'write' }, adv)).body.key;
  const c = (await t.call('/api/campaigns', 'POST', campaign, adv)).body;
  const a = (await t.call('/api/apps', 'POST', { name: 'app' }, pub)).body;
  return { t, adv, pub, key, c, a };
}
// serve -> impression -> human pause -> click; returns the landing URL the user is sent to
async function click(t, appId) {
  const ad = await t.call('/v1/ad', 'POST', { appId, format: 'banner' });
  assert.equal(ad.status, 200);
  await t.call(t.path(ad.body.impressionUrl)); await human();
  const r = await t.call(t.path(ad.body.clickUrl));
  assert.equal(r.status, 302);
  return new URL(r.headers.get('location'));
}

test('auction: CPA eCPM uses a smoothed conversion rate', () => {
  const base = { model: 'CPA', bid: 10, clicks: 0, impressions: 0, conversions: 0 };
  assert.ok(predictCvr(base) > 0.04 && predictCvr(base) < 0.06);
  const warm = { ...base, impressions: 100000, clicks: 2000 }; // 2% CTR
  assert.ok(ecpm({ ...warm, conversions: 1000 }) > ecpm({ ...warm, conversions: 100 })); // proven converters rank higher
  assert.ok(ecpm({ ...warm, conversions: 0 }) < ecpm(warm && { ...warm, conversions: 100 }));
});

test('conversions: a valid click gets an attribution id; the postback bills a CPA campaign exactly once', async () => {
  const { t, adv, key, c, a } = await setup();
  const landing = await click(t, a.id);
  assert.equal(landing.searchParams.get('x'), '1'); // the advertiser's own query string is preserved
  const clickId = landing.searchParams.get('mobiad_click_id'); assert.ok(clickId);

  const r = await post(t, { clickId, event: 'purchase', eventId: 'order-1', value: 24.5 }, key);
  assert.equal(r.status, 200); assert.equal(r.body.duplicate, undefined);
  assert.equal((await post(t, { clickId, event: 'purchase', eventId: 'order-1', value: 24.5 }, key)).body.duplicate, true); // replay
  assert.equal((await post(t, { clickId, event: 'purchase', eventId: 'order-2', value: 10 }, key)).status, 200);        // a second real order
  assert.equal((await post(t, { clickId, event: 'signup' }, key)).status, 200);                                          // other event: counted, free
  await settle(t.app);

  const rep = (await t.call('/api/report', 'GET', null, adv)).body.total;
  assert.equal(rep.conversions, 3); assert.equal(rep.conversionValue, 34.5);
  assert.equal(rep.spend, 6); // 2 billed purchases x $3 (CPA never bills the click or the impression)
  const camp = (await t.call('/api/campaigns', 'GET', null, adv)).body.find((x) => x.id === c.id);
  assert.equal(camp.stats.conversions, 3);
  await t.stop();
});

test('conversions: only write keys of the campaign owner can post; forged, expired and malformed input is refused', async () => {
  const { t, key, a } = await setup();
  const other = await t.signup('other@x.io', 'advertiser');
  const otherKey = (await t.call('/api/keys', 'POST', { name: 'o', scope: 'write' }, other)).body.key;
  const readKey = (await t.call('/api/keys', 'POST', { name: 'r' }, other)).body.key;
  const clickId = (await click(t, a.id)).searchParams.get('mobiad_click_id');

  assert.equal((await post(t, { clickId, event: 'purchase' })).status, 401);               // no key
  assert.equal((await post(t, { clickId, event: 'purchase' }, readKey)).status, 401);      // read-only key
  assert.equal((await post(t, { clickId, event: 'purchase' }, otherKey)).status, 403);     // someone else's click
  assert.equal((await post(t, { clickId: clickId.slice(0, -2) + 'xx', event: 'purchase' }, key)).status, 410); // forged
  const track = deriveKey(SECRET, 'tracking');
  const expired = sign({ k: 'clk', c: 'x', a: 'y', ck: 'z' }, track, -1000);
  assert.equal((await post(t, { clickId: expired, event: 'purchase' }, key)).status, 410); // outside the attribution window
  const notAClick = sign({ c: 'x', a: 'y' }, track);
  assert.equal((await post(t, { clickId: notAClick, event: 'purchase' }, key)).status, 410); // an impression token is not an attribution id
  for (const bad of [{ event: 'Bad Event' }, { event: 'purchase', value: -1 }, { event: 'purchase', value: 'abc' }, { event: '' }])
    assert.equal((await post(t, { clickId, ...bad }, key)).status, 400);
  await t.stop();
});

test('conversions: invalid (bot) clicks get no attribution id, so fraud cannot be monetised; replayed clicks mint no second id', async () => {
  const { t, a } = await setup();
  const fast = await t.call('/v1/ad', 'POST', { appId: a.id });
  await t.call(t.path(fast.body.impressionUrl));
  const bot = await t.call(t.path(fast.body.clickUrl)); // instant click => invalid
  assert.equal(new URL(bot.headers.get('location')).searchParams.get('mobiad_click_id'), null);

  const ad = await t.call('/v1/ad', 'POST', { appId: a.id });
  await t.call(t.path(ad.body.impressionUrl)); await human();
  const first = await t.call(t.path(ad.body.clickUrl)), replay = await t.call(t.path(ad.body.clickUrl));
  assert.ok(new URL(first.headers.get('location')).searchParams.get('mobiad_click_id'));
  assert.equal(new URL(replay.headers.get('location')).searchParams.get('mobiad_click_id'), null);
  await t.stop();
});

test('conversions: non-CPA campaigns record conversions but never bill them; CPA budget exhaustion stops serving', async () => {
  const { t, adv, key, a } = await setup(cpa({ model: 'CPC', bid: 1, budget: 50 }));
  const clickId = (await click(t, a.id)).searchParams.get('mobiad_click_id');
  assert.equal((await post(t, { clickId, event: 'purchase', value: 5 }, key)).status, 200);
  await settle(t.app);
  const rep = (await t.call('/api/report', 'GET', null, adv)).body.total;
  assert.equal(rep.conversions, 1); assert.equal(rep.spend, 1); // only the $1 click; the conversion is free on CPC
  await t.stop();

  const s = await setup(cpa({ bid: 3, budget: 3 }));
  const id = (await click(s.t, s.a.id)).searchParams.get('mobiad_click_id');
  assert.equal((await post(s.t, { clickId: id, event: 'purchase' }, s.key)).status, 200);
  await settle(s.t.app);
  assert.equal((await s.t.call('/v1/ad', 'POST', { appId: s.a.id })).status, 204); // budget spent: stops serving
  await s.t.stop();
});
