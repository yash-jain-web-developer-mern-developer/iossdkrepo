import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { MobiAd, vastMediaUrl } from '../sdk/js/mobiad-sdk.js';
import { boot, settle, sleep } from './lib/helpers.js';

async function world(opts = {}) {
  const t = await boot();
  const adv = await t.signup('adv@x.io', 'advertiser'), pub = await t.signup('pub@x.io', 'publisher');
  await t.call('/api/campaigns', 'POST', { name: 'SDK Camp', model: 'CPC', bid: 1, budget: 100, clickUrl: 'https://example.com/landing', freqCap: opts.freqCap || 0 }, adv);
  const a = (await t.call('/api/apps', 'POST', { name: 'g', childDirected: !!opts.child }, pub)).body;
  return { t, adv, pub, app: a, sdk: new MobiAd({ appId: a.id, baseUrl: t.base, ...(opts.sdk || {}) }) };
}

test('SDK happy path: request -> show -> click is billed once; creative and landing URL come back', async () => {
  const { t, adv, sdk } = await world();
  const ad = await sdk.requestAd({ format: 'banner', country: 'us' });
  assert.equal(ad.creative.title, 'SDK Camp');
  assert.equal(await ad.onShown(), true);
  assert.equal(await ad.onShown(), true); // idempotent: only one impression is sent
  const landing = await ad.onClicked();
  assert.ok(landing); // landing URL or tracker URL
  assert.equal(await ad.onClicked(), null); // a second click on the same ad view is ignored
  await settle(t.app);
  const s = (await t.call('/api/report', 'GET', null, adv)).body.total;
  assert.equal(s.impressions, 1); assert.equal(s.clicks, 1); assert.equal(s.invalidClicks, 0); assert.equal(s.spend, 1);
  await t.stop();
});

test('SDK refuses clicks before onShown and delays instant clicks, so integrators cannot generate invalid traffic by accident', async () => {
  const errors = [];
  const { t, adv, sdk } = await world({ sdk: { onError: (e) => errors.push(e.message), minClickDelayMs: 450 } });
  const ad = await sdk.requestAd();
  assert.equal(await ad.onClicked(), null); // never shown
  assert.match(errors[0], /before onShown/);
  await ad.onShown();
  const t0 = Date.now();
  await ad.onClicked(); // fired immediately; the SDK waits out the minimum delay
  assert.ok(Date.now() - t0 >= 400);
  await settle(t.app);
  const s = (await t.call('/api/report', 'GET', null, adv)).body.total;
  assert.equal(s.clicks, 1); assert.equal(s.invalidClicks, 0); // would be 'too_fast' without the SDK delay
  await t.stop();
});

test('SDK: no fill resolves to null; network failures never throw into the host app; install postback works', async () => {
  const { t, sdk, app } = await world();
  await sdk.requestAd(); // fills (one campaign)
  const empty = new MobiAd({ appId: 'app_unknown', baseUrl: t.base });
  assert.equal(await empty.requestAd(), null); // 404 -> null
  const errs = [];
  const dead = new MobiAd({ appId: app.id, baseUrl: 'http://127.0.0.1:1', retries: 1, timeoutMs: 300, onError: (e) => errs.push(e) });
  assert.equal(await dead.requestAd(), null);
  assert.ok(errs.length >= 1);
  const ad = await sdk.requestAd();
  await ad.onShown();
  assert.equal(await ad.onInstalled(), true);
  await t.stop();
});

test('SDK retries transient 5xx and times out hung servers', async () => {
  let calls = 0;
  const srv = http.createServer((req, res) => {
    calls++;
    if (req.url.startsWith('/hang')) return; // never answers
    if (calls < 3) { res.writeHead(503); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ creative: { title: 'ok', image: '' }, impressionUrl: 'x', clickUrl: 'y', installUrl: 'z' }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const ad = await new MobiAd({ appId: 'a', baseUrl: base, retries: 3 }).requestAd();
  assert.equal(ad.creative.title, 'ok'); assert.equal(calls, 3); // two 503s retried, third succeeded
  const t0 = Date.now();
  assert.equal(await new MobiAd({ appId: 'a', baseUrl: base + '/hang', retries: 0, timeoutMs: 250 }).requestAd(), null);
  assert.ok(Date.now() - t0 < 2000);
  srv.closeAllConnections(); srv.close();
});

test('SDK validates its configuration', () => {
  assert.throws(() => new MobiAd({}), /appId/);
  assert.throws(() => new MobiAd({ appId: 'a', baseUrl: 'ftp://x' }), /baseUrl/);
  assert.throws(() => new MobiAd({ appId: 'a', baseUrl: 'https://x', fetch: 'nope' }), /fetch/);
});

test('SDK privacy: device id only has effect with consent; child-directed apps never use it (frequency cap sees no device)', async () => {
  const { t, sdk } = await world({ freqCap: 1 });
  const show = async (req) => { const ad = await sdk.requestAd(req); if (ad) await ad.onShown(); return !!ad; };
  assert.equal(await show({ deviceId: 'dev-A' }), true);
  assert.equal(await show({ deviceId: 'dev-A' }), false); // capped at 1/day with consent-free default
  assert.equal(await show({ deviceId: 'dev-B', consent: { coppa: true } }), true);
  assert.equal(await show({ deviceId: 'dev-B', consent: { coppa: true } }), true); // COPPA: id ignored, no cap
  await t.stop();
  const kids = await world({ freqCap: 1, child: true });
  const k = async () => { const ad = await kids.sdk.requestAd({ deviceId: 'dev-K' }); return !!ad; };
  assert.equal(await k(), false); // a child-directed app gets no non-child-safe ads at all
  await kids.t.stop();
});

test('SDK: video ads expose the rich creative and report completion once, only after the impression', async () => {
  const { t, sdk, app } = await world();
  const adv = await t.signup('vid@x.io', 'advertiser');
  await t.call('/api/campaigns', 'POST', { name: 'V', model: 'CPM', bid: 50, budget: 100, clickUrl: 'https://example.com/l', format: 'video', videoUrl: 'https://cdn.example.com/a.mp4', durationSec: 12, cta: 'Go' }, adv);
  const ad = await sdk.requestAd({ format: 'video' });
  assert.equal(ad.creative.videoUrl, 'https://cdn.example.com/a.mp4'); assert.equal(ad.creative.durationSec, 12); assert.equal(ad.creative.cta, 'Go');
  assert.equal(await ad.onVideoComplete(), false); // before the impression: ignored
  await ad.onShown();
  assert.equal(await ad.onVideoComplete(), true);
  assert.equal(await ad.onVideoComplete(), false); // once
  assert.equal(await ad.onViewable(), true); assert.equal(await ad.onViewable(), false); // viewability: after the impression, once
  const banner = await sdk.requestAd(); await banner.onShown();
  assert.equal(await banner.onVideoComplete(), false); // not a video ad
  await t.stop();
});

test('SDK: test mode, rewarded info, targeting signals, partner ads, and viewability-gated impressions', async () => {
  const { t, sdk, app } = await world();
  const seen = [];
  const spy = new MobiAd({ appId: app.id, baseUrl: t.base, fetch: async (u, i) => { if (String(u).endsWith('/v1/ad')) seen.push(JSON.parse(i.body)); return fetch(u, i); } });
  const test = await spy.requestAd({ format: 'rewarded', test: true, userId: 'player-1', language: 'en', deviceType: 'phone', osVersion: '17.2', connection: 'wifi', placementId: 'plc_x' });
  assert.equal(test.test, true); assert.deepEqual(test.reward, { amount: 1, item: 'reward' }); assert.equal(test.creative.title, 'MobiAd test ad');
  assert.deepEqual({ ...seen[0], appId: undefined }, { appId: undefined, format: 'rewarded', test: true, userId: 'player-1', language: 'en', deviceType: 'phone', osVersion: '17.2', connection: 'wifi', placementId: 'plc_x' });
  assert.equal(await test.onShown(), true);

  // partner ad shape: no creative, no clicks
  const ext = new MobiAd({ appId: app.id, baseUrl: 'http://x', fetch: async () => ({ ok: true, status: 200, json: async () => ({ external: { markup: 'html', adm: '<b>x</b>' }, impressionUrl: 'http://x/t/i/tok' }) }) });
  const ad = await ext.requestAd();
  assert.equal(ad.creative, null); assert.equal(ad.external.markup, 'html'); assert.equal(await ad.onClicked(), null);

  // viewability: 50% visible for 1 s, interrupted exposure restarts the clock, cancel resolves false
  const fire = []; class FakeIO { constructor(cb) { this.cb = cb; fire.push(this); } observe() {} disconnect() { this.gone = true; } }
  const timers = []; const st = (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, ct = (id) => { timers[id - 1].cleared = true; };
  const probe = await spy.requestAd({ test: true });
  const p = probe.reportWhenViewable({}, { IntersectionObserver: FakeIO, setTimeout: st, clearTimeout: ct });
  fire[0].cb([{ isIntersecting: true, intersectionRatio: 0.3 }]); assert.equal(timers.length, 0);                    // not enough visible
  fire[0].cb([{ isIntersecting: true, intersectionRatio: 0.8 }]); assert.equal(timers.length, 1); assert.equal(timers[0].ms, 1000);
  fire[0].cb([{ isIntersecting: false, intersectionRatio: 0 }]); assert.equal(timers[0].cleared, true);              // scrolled away: clock reset
  fire[0].cb([{ isIntersecting: true, intersectionRatio: 1 }]); assert.equal(timers.length, 2);
  timers[1].fn(); assert.equal(await p, true); assert.equal(fire[0].gone, true);
  const p2 = (await spy.requestAd({ test: true })).reportWhenViewable({}, { IntersectionObserver: FakeIO, setTimeout: st, clearTimeout: ct }); p2.cancel(); assert.equal(await p2, false);
  const errs = []; const noIO = new MobiAd({ appId: app.id, baseUrl: t.base, onError: (e) => errs.push(e) });
  assert.equal(await (await noIO.requestAd({ test: true })).reportWhenViewable({}, { IntersectionObserver: null }), true); assert.match(errs[0].message, /IntersectionObserver unavailable/); // degrades to immediate reporting
  await t.stop();
});

test('SDK: the default fetch is bound, because browsers throw "Illegal invocation" when fetch is called as a method of another object', async () => {
  const real = globalThis.fetch; let calledWith = 'none';
  globalThis.fetch = function (...a) { calledWith = this; if (this !== globalThis && this !== undefined) throw new TypeError('Illegal invocation'); return real(...a); };
  try {
    const { t, app } = await world(); const sdk = new MobiAd({ appId: app.id, baseUrl: t.base });
    const ad = await sdk.requestAd({ format: 'banner' }); assert.ok(ad, 'ad served through the default fetch'); assert.ok(calledWith === globalThis || calledWith === undefined);
    await t.stop();
  } finally { globalThis.fetch = real; }
});

test('SDK: VAST markup from partners yields the file to play (adaptive stream first) and ignores non-http files', () => {
  const v = '<VAST><MediaFiles><MediaFile type="video/mp4"><![CDATA[https://cdn.example.com/a.mp4?x=1]]></MediaFile><MediaFile type="application/x-mpegURL"><![CDATA[https://cdn.example.com/a/master.m3u8]]></MediaFile><MediaFile type="video/mp4">javascript:alert(1)</MediaFile></MediaFiles></VAST>';
  assert.equal(vastMediaUrl(v), 'https://cdn.example.com/a/master.m3u8');
  assert.equal(vastMediaUrl(v.replace('application/x-mpegURL', 'video/webm').replace('master.m3u8', 'a.webm')), 'https://cdn.example.com/a.mp4?x=1');
  assert.equal(vastMediaUrl('<VAST><MediaFile>javascript:alert(1)</MediaFile></VAST>'), null); assert.equal(vastMediaUrl('x'), null); assert.equal(vastMediaUrl(undefined), null);
});
