import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, serve, human, settle, sleep } from './lib/helpers.js';
import { personalizationAllowed } from '../src/adserver/index.js';
import { encodeTcString } from '../src/core/tcf.js';
const TC = encodeTcString({ purposes: [1] });

const cpc = (o = {}) => ({ name: 'Click Me', model: 'CPC', bid: 1, budget: 100, clickUrl: 'https://example.com/landing', ...o });
const stats = async (t, tok) => (await t.call('/api/report', 'GET', null, tok)).body.total;

test('fraud: instant, impression-less and flooded clicks are recorded as invalid and never billed; real clicks are billed', async () => {
  const t = await boot();
  const adv = await t.signup('adv@x.io', 'advertiser'), pub = await t.signup('pub@x.io', 'publisher');
  await t.call('/api/campaigns', 'POST', cpc(), adv);
  const a = (await t.call('/api/apps', 'POST', { name: 'g' }, pub)).body;

  // (a) bot: tap within milliseconds of the ad being served
  const fast = await t.call('/v1/ad', 'POST', { appId: a.id });
  await t.call(t.path(fast.body.impressionUrl));
  const botClick = await t.call(t.path(fast.body.clickUrl));
  assert.equal(botClick.status, 302); // the user is still sent to the landing page
  assert.equal(botClick.headers.get('location'), 'https://example.com/landing');
  // (b) click with no impression ever recorded
  const ghost = await t.call('/v1/ad', 'POST', { appId: a.id });
  await human();
  await t.call(t.path(ghost.body.clickUrl));
  await settle(t.app);
  let s = await stats(t, adv);
  assert.equal(s.clicks, 0); assert.equal(s.invalidClicks, 2); assert.equal(s.spend, 0);
  // (c) a genuine click after a human-scale delay is billed
  const real = await serve(t, a.id, { click: true });
  assert.equal(real.click.status, 302);
  await settle(t.app);
  s = await stats(t, adv);
  assert.equal(s.clicks, 1); assert.equal(s.invalidClicks, 2); assert.equal(s.spend, 1);
  assert.equal((await stats(t, pub)).invalidClicks, 2); // publishers can see their invalid traffic too
  // replaying the same click link neither bills nor records again
  await t.call(t.path(real.ad.clickUrl));
  await settle(t.app);
  assert.equal((await stats(t, adv)).clicks, 1);
  const m = (await t.call('/metrics')).text;
  assert.match(m, /mobiad_invalid_clicks_total\{reason="too_fast"\} 1/); assert.match(m, /mobiad_invalid_clicks_total\{reason="no_impression"\} 1/);
  await t.stop();
});

test('fraud: more than 5 clicks per minute from one IP on a campaign are invalid (click flooding)', async () => {
  const t = await boot();
  const adv = await t.signup('adv@x.io', 'advertiser'), pub = await t.signup('pub@x.io', 'publisher');
  await t.call('/api/campaigns', 'POST', cpc({ budget: 1000 }), adv);
  const a = (await t.call('/api/apps', 'POST', { name: 'g' }, pub)).body;
  const ads = [];
  for (let i = 0; i < 8; i++) ads.push((await serve(t, a.id)).ad);
  await human();
  for (const ad of ads) await t.call(t.path(ad.clickUrl));
  await settle(t.app);
  const s = await stats(t, adv);
  assert.equal(s.clicks, 5); assert.equal(s.invalidClicks, 3); assert.equal(s.spend, 5);
  await t.stop();
});

test('fraud: a campaign owner is never matched with their own app (no self-dealing)', async () => {
  const t = await boot();
  const adv = await t.signup('adv@x.io', 'advertiser');
  await t.call('/api/campaigns', 'POST', cpc(), adv);
  // same OWNER on both sides: insert an app owned by the advertiser's user id (roles prevent this via the API)
  const owner = await t.app.repo.userByEmail('adv@x.io');
  await t.app.repo.createApp({ id: 'app_self', owner: owner.id, name: 'mine', platform: 'android', floorEcpm: 0 });
  await t.app.catalog.refresh();
  assert.equal((await t.call('/v1/ad', 'POST', { appId: 'app_self' })).status, 204);
  await t.stop();
});

test('frequency cap: per device per campaign per day; other devices and capless requests unaffected', async () => {
  const t = await boot();
  const adv = await t.signup('adv@x.io', 'advertiser'), pub = await t.signup('pub@x.io', 'publisher');
  await t.call('/api/campaigns', 'POST', { name: 'Capped', bid: 5, budget: 100, clickUrl: 'https://example.com', freqCap: 2 }, adv);
  const a = (await t.call('/api/apps', 'POST', { name: 'g' }, pub)).body;
  const req = (deviceId, extra = {}) => serve(t, a.id, { extra: { deviceId, ...extra } });
  assert.equal((await req('dev-1')).status, 200);
  assert.equal((await req('dev-1')).status, 200);
  assert.equal((await req('dev-1')).status, 204); // third view today: capped
  assert.equal((await req('dev-2')).status, 200); // a different device is fine
  assert.equal((await serve(t, a.id)).status, 200); // no device id: nothing to cap on
  // privacy: the raw device id appears nowhere in the signed token the SDK receives
  const probe = await req('dev-3');
  const payload = Buffer.from(probe.ad.impressionUrl.split('/t/i/')[1].split('.')[0], 'base64url').toString();
  assert.ok(!payload.includes('dev-3')); assert.match(payload, /"d":"[0-9a-f]{24}"/);
  await t.stop();
});

test('consent: COPPA, limit-ad-tracking, GDPR without consent string and US opt-out disable device-based capping', async () => {
  const app = { childDirected: false };
  assert.equal(personalizationAllowed(app, {}), true);
  assert.equal(personalizationAllowed({ childDirected: true }, {}), false);
  assert.equal(personalizationAllowed(app, { coppa: true }), false);
  assert.equal(personalizationAllowed(app, { limitAdTracking: true }), false);
  assert.equal(personalizationAllowed(app, { gdpr: true }), false);
  assert.equal(personalizationAllowed(app, { gdpr: true, gdprConsent: TC }), true);
  assert.equal(personalizationAllowed(app, { usPrivacy: '1YYN' }), false); // opted out of sale
  assert.equal(personalizationAllowed(app, { usPrivacy: '1YNN' }), true);
  assert.equal(personalizationAllowed(app, { usPrivacy: '1---' }), true);

  const t = await boot();
  const adv = await t.signup('adv@x.io', 'advertiser'), pub = await t.signup('pub@x.io', 'publisher');
  await t.call('/api/campaigns', 'POST', { name: 'Capped', bid: 5, budget: 1000, clickUrl: 'https://example.com', freqCap: 1 }, adv);
  const a = (await t.call('/api/apps', 'POST', { name: 'g' }, pub)).body;
  for (const consent of [{ coppa: true }, { limitAdTracking: true }, { gdpr: true }]) {
    for (let i = 0; i < 3; i++) assert.equal((await serve(t, a.id, { extra: { deviceId: 'd-' + JSON.stringify(consent), consent } })).status, 200); // no id used => no cap
  }
  assert.equal((await serve(t, a.id, { extra: { deviceId: 'ok-dev', consent: { gdpr: true, gdprConsent: TC } } })).status, 200);
  assert.equal((await serve(t, a.id, { extra: { deviceId: 'ok-dev', consent: { gdpr: true, gdprConsent: TC } } })).status, 204); // consented: cap applies
  await t.stop();
});

test('child-directed apps only receive child-safe campaigns; publisher category blocklists are honored', async () => {
  const t = await boot();
  const adv = await t.signup('adv@x.io', 'advertiser'), pub = await t.signup('pub@x.io', 'publisher');
  await t.call('/api/campaigns', 'POST', { name: 'Adult-ish Shop', bid: 9, budget: 100, clickUrl: 'https://example.com/a', category: 'shopping' }, adv);
  const kidsOk = (await t.call('/api/campaigns', 'POST', { name: 'Kids Game', bid: 2, budget: 100, clickUrl: 'https://example.com/k', category: 'games', childSafe: true }, adv)).body;
  const kids = (await t.call('/api/apps', 'POST', { name: 'Kids App', childDirected: true }, pub)).body;
  const general = (await t.call('/api/apps', 'POST', { name: 'General App' }, pub)).body;
  for (let i = 0; i < 5; i++) { const r = await t.call('/v1/ad', 'POST', { appId: kids.id }); assert.equal(r.status, 200); assert.equal(r.body.creative.title, kidsOk.creative.title); } // never the higher-bidding non-child-safe ad
  assert.equal((await t.call('/v1/ad', 'POST', { appId: general.id })).body.creative.title, 'Adult-ish Shop'); // normal app: highest bid wins
  const blocking = (await t.call('/api/apps', 'POST', { name: 'No Shopping', blockedCategories: ['shopping'] }, pub)).body;
  assert.equal((await t.call('/v1/ad', 'POST', { appId: blocking.id })).body.creative.title, 'Kids Game');
  assert.equal((await t.call('/api/apps', 'POST', { name: 'bad', blockedCategories: ['not-a-category'] }, pub)).status, 400);
  await t.stop();
});

test('fraud scan job flags an abnormal app and the admin can review it', async () => {
  const t = await boot();
  const pub = await t.signup('pub@x.io', 'publisher'), admin = await t.makeAdmin();
  const a = (await t.call('/api/apps', 'POST', { name: 'shady' }, pub)).body;
  const ev = (type, i) => ({ type, campaignId: 'c', appId: a.id, cost: 0, t: Date.now(), token: type + i });
  await t.app.repo.recordBatch([...Array.from({ length: 600 }, (_, i) => ev('impression', i)), ...Array.from({ length: 300 }, (_, i) => ev('click', i))]);
  const { scanApps } = await import('../src/fraud.js');
  const flagged = await scanApps(t.app.repo, { audit: (x) => t.app.repo.audit(x) });
  assert.equal(flagged.length, 1);
  const list = (await t.call('/api/admin/apps/flagged', 'GET', null, admin)).body;
  assert.equal(list[0].id, a.id); assert.match(list[0].flagReason, /CTR 50\.0%/);
  assert.ok((await t.call('/api/admin/audit?action=app_flagged', 'GET', null, admin)).body.length >= 1);
  await t.stop();
});
