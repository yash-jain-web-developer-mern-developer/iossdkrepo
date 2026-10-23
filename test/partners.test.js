import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { boot, human, settle, sleep } from './lib/helpers.js';
import { buildBidRequest, parseBidResponse, unify, PartnerBreakers, macro } from '../src/core/partners.js';

// A scriptable OpenRTB DSP.
function dsp(handler) {
  const seen = [], hits = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      if (req.method === 'GET') { hits.push(req.url); res.writeHead(200); return res.end('ok'); }
      let j = {}; try { j = JSON.parse(b); } catch { /* ignore */ }
      seen.push({ body: j, headers: req.headers });
      const out = handler(j, req);
      if (out === 'nobid') { res.writeHead(204); return res.end(); }
      if (out && out.delay) return setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out.body)); }, out.delay);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => { const port = srv.address().port; r({ seen, hits, url: `http://127.0.0.1:${port}/bid`, base: `http://127.0.0.1:${port}`, close: () => srv.closeAllConnections() || srv.close() }); }));
}
const bannerBid = (price, extra = {}) => (req) => ({ id: req.id, cur: 'USD', seatbid: [{ bid: [{ id: 'b1', impid: '1', price, adm: '<a href="https://adv.example/c"><img src="https://adv.example/i.png"></a>', crid: 'cr-9', w: 320, h: 50, ...extra }] }] });
const camp = (o = {}) => ({ name: 'Own', model: 'CPM', bid: 5, budget: 1000, clickUrl: 'https://example.com/l', ...o });
const ask = (t, appId, extra = {}) => t.call('/v1/ad', 'POST', { appId, ...extra });
const addPartner = (t, admin, url, extra = {}) => t.call('/api/admin/partners', 'POST', { name: 'DSP', endpointUrl: url, timeoutMs: 200, ...extra }, admin);

test('unified auction math: second price across own campaigns and partner bids', () => {
  const own = { campaign: { id: 'c' }, winEcpm: 5, runnerUpEcpm: 2 };
  let r = unify(own, [{ price: 3 }], 0); assert.equal(r.type, 'internal'); assert.equal(r.clearingEcpm, 3.01);   // the partner's 3 is the runner-up
  r = unify(own, [{ price: 1 }], 0); assert.equal(r.clearingEcpm, 2.01);                                        // own runner-up (2) is higher
  r = unify(own, [{ price: 8 }, { price: 6 }], 0); assert.equal(r.type, 'external'); assert.equal(r.clearingEcpm, 6.01); // second highest of {own 5, partner 6}
  r = unify(own, [{ price: 8 }], 0); assert.equal(r.clearingEcpm, 5.01);                                        // own winner is the rival
  r = unify(own, [{ price: 5 }], 0); assert.equal(r.type, 'internal');                                          // tie -> MobiAd's own campaign
  r = unify(null, [{ price: 4 }], 1); assert.equal(r.type, 'external'); assert.equal(r.clearingEcpm, 1);        // only bidder: pays the floor
  r = unify({ campaign: {}, winEcpm: 5, runnerUpEcpm: null }, [], 0); assert.equal(r.clearingEcpm, 0.01);       // single bidder, no floor
  assert.equal(unify(null, [], 0), null);
  assert.equal(unify({ campaign: {}, winEcpm: 0.5, runnerUpEcpm: null }, [{ price: 0.5 }], 0).type, 'internal');
  r = unify(own, [{ price: 5.005 }], 0); assert.ok(r.clearingEcpm <= 5.005); // never above the winner's own bid
});

test('bid request/response validation: consent-aware request, hostile responses rejected', () => {
  const app = { id: 'app_1', name: 'G', owner: 'u1', platform: 'ios', childDirected: false };
  const rq = buildBidRequest({ app, format: 'rewarded', floorEcpm: 1, country: 'US', sig: { lang: 'en-GB', osVersion: '17.2', deviceType: 'tablet', connection: 'wifi' }, ua: 'UA', ip: '1.2.3.4', deviceId: 'ifa-1', personalize: true, consent: { gdpr: true, gdprConsent: 'CP123' }, tmax: 150 });
  assert.equal(rq.app.content, undefined); /* kids-directed is signalled with regs.coppa only (OpenRTB has no app.content.kidsdirected) */ assert.equal(buildBidRequest({ app: { ...app, childDirected: true }, format: 'banner', personalize: false }).regs.coppa, 1);
  assert.equal(rq.imp[0].rwdd, 1); assert.ok(rq.imp[0].video); assert.equal(rq.device.ifa, 'ifa-1'); assert.equal(rq.device.ip, '1.2.3.4'); assert.equal(rq.device.os, 'iOS'); assert.equal(rq.device.devicetype, 5); assert.equal(rq.regs.ext.gdpr, 1); assert.equal(rq.user.ext.consent, 'CP123');
  const anon = buildBidRequest({ app, format: 'banner', personalize: false, deviceId: 'ifa-1', ip: '1.2.3.4', consent: { coppa: true } });
  assert.equal(anon.device.ifa, undefined); assert.equal(anon.device.ip, undefined); assert.equal(anon.regs.coppa, 1); assert.ok(anon.imp[0].banner);
  const ok = { cur: 'USD', seatbid: [{ bid: [{ impid: '1', price: 2, adm: '<b>x</b>', burl: 'https://p.example/b?p=${AUCTION_PRICE}' }] }] };
  const opts = { floorEcpm: 1, blockedCategories: ['gambling'], format: 'banner' };
  assert.equal(parseBidResponse(ok, opts).price, 2);
  for (const bad of [null, {}, { seatbid: 'x' }, { ...ok, cur: 'EUR' }, { seatbid: [{ bid: [{ impid: '2', price: 2, adm: 'x' }] }] }, { seatbid: [{ bid: [{ impid: '1', price: -1, adm: 'x' }] }] }, { seatbid: [{ bid: [{ impid: '1', price: 'NaN', adm: 'x' }] }] },
    { seatbid: [{ bid: [{ impid: '1', price: 0.5, adm: 'x' }] }] }, { seatbid: [{ bid: [{ impid: '1', price: 2, adm: '' }] }] }, { seatbid: [{ bid: [{ impid: '1', price: 2, adm: 'x'.repeat(100001) }] }] },
    { seatbid: [{ bid: [{ impid: '1', price: 2, adm: 'x', cat: ['gambling'] }] }] }, { seatbid: [{ bid: [{ impid: '1', price: 99999, adm: 'x' }] }] }, { seatbid: [{ bid: [{ impid: '1', price: 2, adm: '<?xml version="1.0"?><VAST/>' }] }] }])
    assert.equal(parseBidResponse(bad, opts), null, JSON.stringify(bad).slice(0, 60));
  assert.equal(parseBidResponse({ seatbid: [{ bid: [{ impid: '1', price: 2, adm: '<b>x</b>' }] }] }, { ...opts, format: 'video' }), null); // video slots need VAST
  assert.equal(parseBidResponse({ seatbid: [{ bid: [{ impid: '1', price: 2, adm: '<VAST version="4.2"/>' }] }] }, { ...opts, format: 'video' }).markup, 'vast');
  assert.equal(parseBidResponse({ seatbid: [{ bid: [{ impid: '1', price: 2, adm: 'x', burl: 'http://insecure.example/b', nurl: 'javascript:1' }] }] }, opts).burl, undefined); // only https notices
  assert.equal(macro('https://x/?p=${AUCTION_PRICE}&q=${AUCTION_PRICE}', 1.23456), 'https://x/?p=1.2346&q=1.2346');
  const br = new PartnerBreakers({ failures: 2, openMs: 1000, now: (() => { let t = 0; return () => t; })() });
  br.fail('p'); assert.equal(br.allow('p'), true); br.fail('p'); assert.equal(br.allow('p'), false); br.ok('p'); assert.equal(br.allow('p'), true);
});

test('unified auction end to end: a higher partner bid wins, is billed as publisher revenue only, notices are sent', async () => {
  let base = '';
  const d = await dsp((req) => bannerBid(9, { nurl: base + '/win?p=${AUCTION_PRICE}', burl: base + '/bill?p=${AUCTION_PRICE}' })(req));
  base = d.base;
  const t = await boot({ allowPrivateCallbacks: true });
  const adv = await t.signup('adv@x.io', 'advertiser'), pub = await t.signup('pub@x.io', 'publisher'), admin = await t.makeAdmin();
  await t.call('/api/campaigns', 'POST', camp({ bid: 5 }), adv);
  const a = (await t.call('/api/apps', 'POST', { name: 'Game', blockedCategories: ['gambling'] }, pub)).body;
  assert.equal((await addPartner(t, admin, 'ftp://x')).status, 400);
  assert.equal((await t.call('/api/admin/partners', 'POST', { name: 'x', endpointUrl: d.url }, adv)).status, 403);
  const p = (await addPartner(t, admin, d.url, { formats: ['banner'], authHeader: 'Bearer secret-token' })).body;
  const r = await ask(t, a.id, { format: 'banner', country: 'US', language: 'en', consent: {} });
  assert.equal(r.status, 200);
  assert.equal(r.body.external.markup, 'html'); assert.match(r.body.external.adm, /adv\.example/); assert.equal(r.body.creative, undefined); assert.equal(r.body.clickUrl, undefined);
  // what the partner received
  const req = d.seen[0]; assert.equal(req.headers.authorization, 'Bearer secret-token'); assert.equal(req.body.app.id, a.id); assert.equal(req.body.imp[0].bidfloor, 0); assert.deepEqual(req.body.bcat, ['gambling']); assert.equal(req.body.tmax, 200); assert.equal(req.body.at, 2);
  assert.equal(req.body.device.geo.country, 'US'); assert.equal(req.body.device.ifa, undefined); // no device id was sent
  await t.call(t.path(r.body.impressionUrl)); await t.call(t.path(r.body.impressionUrl)); // replay
  await settle(t.app); for (let i = 0; i < 20 && d.hits.length < 2; i++) await sleep(50);
  assert.deepEqual([...d.hits].sort(), ['/bill?p=5.01', '/win?p=5.01']); // win notice at auction, billing notice once at impression, price macro filled
  // second price: own campaign (5 CPM) is the rival => partner pays 5.01 CPM => $0.00501 per impression
  const earn = (await t.call('/api/billing/summary', 'GET', null, pub)).body;
  assert.ok(Math.abs(earn.earned - 0.00501 * 0.7) < 1e-6, 'publisher earns 70% of the clearing price: ' + earn.earned);
  assert.equal((await t.call('/api/report', 'GET', null, adv)).body.total.spend, 0);          // advertiser untouched
  assert.equal((await t.call('/api/billing/summary', 'GET', null, adv)).body.spent, 0);
  const partners = (await t.call('/api/admin/partners', 'GET', null, admin)).body;
  assert.equal(partners[0].impressions, 1); assert.equal(partners[0].hasAuth, true); assert.ok(Math.abs(partners[0].grossUsd - 0.00501) < 1e-6); assert.equal(JSON.stringify(partners).includes('secret-token'), false);
  assert.equal((await t.call('/api/report/breakdown?by=format', 'GET', null, pub)).body[0].key, 'banner');
  assert.equal((await t.call(t.path(r.body.impressionUrl.replace('/t/i/', '/t/c/')))).status, 400); // partner ads have no MobiAd click tracker
  assert.match((await t.call('/metrics')).text, /mobiad_partner_wins_total\{partner="prt_/);
  await t.stop(); d.close();
});

test('unified auction: own campaign wins when it bids higher; partner sets the price', async () => {
  const d = await dsp(bannerBid(2));
  const t = await boot({ allowPrivateCallbacks: true });
  const adv = await t.signup('adv@x.io', 'advertiser'), pub = await t.signup('pub@x.io', 'publisher'), admin = await t.makeAdmin();
  await t.call('/api/campaigns', 'POST', camp({ bid: 5 }), adv);
  const a = (await t.call('/api/apps', 'POST', { name: 'Game' }, pub)).body;
  await addPartner(t, admin, d.url);
  const r = await ask(t, a.id);
  assert.ok(r.body.creative && !r.body.external);
  await t.call(t.path(r.body.impressionUrl)); await settle(t.app);
  const spend = (await t.call('/api/report', 'GET', null, adv)).body.total.spend;
  assert.ok(Math.abs(spend - 0.00201) < 1e-6, 'own campaign pays just above the partner bid (2.01 CPM): ' + spend);
  await t.stop(); d.close();
});

test('partners are resilient: timeouts, garbage, no-bid, paused, breaker; and privacy/child rules', async () => {
  const slow = await dsp(() => ({ delay: 600, body: bannerBid(50)({ id: 'x' }) }));
  const junk = await dsp(() => ({ not: 'openrtb' }));
  const none = await dsp(() => 'nobid');
  const good = await dsp(bannerBid(7));
  const t = await boot({ allowPrivateCallbacks: true });
  const pub = await t.signup('pub@x.io', 'publisher'), admin = await t.makeAdmin();
  const a = (await t.call('/api/apps', 'POST', { name: 'Game' }, pub)).body, kids = (await t.call('/api/apps', 'POST', { name: 'Kids', childDirected: true }, pub)).body;
  for (const d of [slow, junk, none]) await addPartner(t, admin, d.url);
  assert.equal((await ask(t, a.id)).status, 204); // nobody valid; nothing of our own
  const t0 = Date.now(); await ask(t, a.id); assert.ok(Date.now() - t0 < 450, 'slow partner capped by its own timeout, not 600 ms');
  const gp = (await addPartner(t, admin, good.url)).body;
  assert.equal((await ask(t, a.id)).body.external.markup, 'html'); // the good partner wins despite three bad ones
  // personal data only with consent and a device id
  await ask(t, a.id, { deviceId: 'IFA-123', consent: {} });
  assert.equal(good.seen.at(-1).body.device.ifa, 'IFA-123');
  await ask(t, a.id, { deviceId: 'IFA-123', consent: { limitAdTracking: true } });
  assert.equal(good.seen.at(-1).body.device.ifa, undefined);
  await ask(t, a.id, { deviceId: 'IFA-123', consent: { gdpr: true } }); // GDPR without a consent string
  assert.equal(good.seen.at(-1).body.device.ifa, undefined);
  // child-directed apps never reach partners that are not flagged child-safe
  const before = good.seen.length; await ask(t, kids.id); assert.equal(good.seen.length, before);
  const n = good.seen.length; await ask(t, a.id, { consent: { coppa: true } }); assert.equal(good.seen.length, n);
  // pause
  await t.call('/api/admin/partners/status', 'POST', { id: gp.id, status: 'paused' }, admin);
  const n2 = good.seen.length; await ask(t, a.id); assert.equal(good.seen.length, n2);
  assert.equal((await t.call('/api/admin/partners/status', 'POST', { id: gp.id, status: 'bogus' }, admin)).status, 400);
  for (const d of [slow, junk, none, good]) d.close();
  await t.stop();
});

test('unified auction: floors, video (VAST) and rewarded slots, child-safe partners, burl price macro', async () => {
  const vast = '<?xml version="1.0"?><VAST version="4.2"><Ad id="1"><InLine/></Ad></VAST>';
  const d = await dsp((req) => ({ id: req.id, seatbid: [{ bid: [{ impid: '1', price: 6, adm: req.imp[0].video ? vast : '<div>ad</div>', burl: 'https://example.invalid/burl?price=${AUCTION_PRICE}' }] }] }));
  const t = await boot({ allowPrivateCallbacks: true });
  const pub = await t.signup('pub@x.io', 'publisher'), admin = await t.makeAdmin();
  const a = (await t.call('/api/apps', 'POST', { name: 'G', floorEcpm: 8 }, pub)).body, b = (await t.call('/api/apps', 'POST', { name: 'H', floorEcpm: 1 }, pub)).body;
  const kid = (await t.call('/api/apps', 'POST', { name: 'K', childDirected: true }, pub)).body;
  await addPartner(t, admin, d.url, { formats: ['banner', 'video', 'rewarded'] });
  assert.equal((await ask(t, a.id)).status, 204); // partner bid 6 < app floor 8, and the partner was told the floor
  assert.equal(d.seen.at(-1).body.imp[0].bidfloor, 8);
  const v = await ask(t, b.id, { format: 'video' }); assert.equal(v.body.external.markup, 'vast'); assert.match(v.body.external.adm, /<VAST/);
  const rw = await ask(t, b.id, { format: 'rewarded' }); assert.equal(d.seen.at(-1).body.imp[0].rwdd, 1); assert.equal(rw.body.external.markup, 'vast'); assert.deepEqual(rw.body.reward, { amount: 1, item: 'reward' });
  const pl = (await t.call('/api/placements', 'POST', { appId: b.id, name: 'Menu', format: 'banner', floorEcpm: 2 }, pub)).body;
  assert.equal((await ask(t, b.id, { placementId: pl.id })).status, 200); assert.equal(d.seen.at(-1).body.imp[0].tagid, pl.id); assert.equal(d.seen.at(-1).body.imp[0].bidfloor, 2);
  assert.equal((await ask(t, b.id, { format: 'native' })).status, 204); // native/playable are never sent to partners
  const before = d.seen.length; await ask(t, kid.id); assert.equal(d.seen.length, before);
  await t.call('/api/admin/partners', 'POST', { name: 'KidsOK', endpointUrl: d.url, childSafe: true }, admin);
  assert.equal((await ask(t, kid.id)).status, 200); // a child-safe partner may serve child-directed apps
  d.close(); await t.stop();
});
