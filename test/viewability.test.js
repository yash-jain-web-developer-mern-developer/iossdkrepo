// Viewability measurement: the SDK reports a separate, free "viewable" event after a counted impression.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, settle } from './lib/helpers.js';

const camp = (o = {}) => ({ name: 'Launch', bid: 8, budget: 50, clickUrl: 'https://example.com/landing', ...o });

test('viewable events: counted once, only after an impression, never billed, shown as a viewability rate in reports and CSV', async () => {
  const t = await boot();
  const adv = await t.signup('adv@x.io', 'advertiser'), pub = await t.signup('pub@x.io', 'publisher');
  await t.call('/api/campaigns', 'POST', camp({ bid: 6000, budget: 1000 }), adv);
  const a = (await t.call('/api/apps', 'POST', { name: 'A', floorEcpm: 5000 }, pub)).body;
  const ads = [];
  for (let i = 0; i < 4; i++) { const r = await t.call('/v1/ad', 'POST', { appId: a.id }); assert.equal(r.status, 200); assert.match(r.body.viewableUrl, /\/t\/w\//); ads.push(r.body); }

  // a viewable report before the impression is ignored (and does not use up the token)
  assert.equal((await t.call(t.path(ads[0].viewableUrl))).status, 200);
  await settle(t.app);
  assert.equal((await t.call('/api/report', 'GET', null, adv)).body.total.viewables, 0);

  // impression for all four; viewable for three of them; one of those reported twice
  for (const ad of ads) await t.call(t.path(ad.impressionUrl));
  for (const ad of ads.slice(0, 3)) await t.call(t.path(ad.viewableUrl));
  await t.call(t.path(ads[0].viewableUrl)); // replay: counted once
  await settle(t.app);
  const rep = (await t.call('/api/report', 'GET', null, adv)).body.total;
  assert.equal(rep.impressions, 4); assert.equal(rep.viewables, 3); assert.equal(rep.viewability, 0.75);
  const spend = rep.spend; assert.ok(spend > 0);
  const pubRep = (await t.call('/api/report', 'GET', null, pub)).body.total; assert.equal(pubRep.viewables, 3);
  // viewability never changes what is billed: 4 impressions at the clearing price, nothing for the viewable events
  const paid = (await t.app.repo.q("SELECT SUM(amount_micros) AS m FROM ledger WHERE event='viewable'")).rows[0].m;
  assert.equal(Number(paid || 0), 0);
  // forged token, wrong kind
  assert.equal((await t.call(t.path(ads[0].viewableUrl.slice(0, -2) + 'xx'))).status, 400);
  const csv = await t.call('/api/report.csv', 'GET', null, adv); assert.match(csv.text, /viewable_impressions,viewability/); assert.match(csv.text, /,3,0\.7500/);
  const br = (await t.call('/api/report/breakdown?by=campaign', 'GET', null, adv)).body; assert.equal(br[0].viewables, 3); assert.equal(br[0].viewability, 0.75);
  await t.stop();
});

test('viewable test ads: a test ad answers its viewable URL, and test video ads point at the real sample video served by this server', async () => {
  const t = await boot();
  const pub = await t.signup('pub@x.io', 'publisher');
  const a = (await t.call('/api/apps', 'POST', { name: 'A', floorEcpm: 1 }, pub)).body;
  const test = await t.call('/v1/ad', 'POST', { appId: a.id, test: true }); assert.equal(test.status, 200); assert.ok(test.body.viewableUrl);
  assert.equal((await t.call(t.path(test.body.viewableUrl))).status, 200);
  const v = await t.call('/v1/ad', 'POST', { appId: a.id, test: true, format: 'video' });
  assert.equal(v.body.creative.videoUrl, t.base + '/media/sample.mp4');
  await t.stop();
});

test('sample video: served as video/mp4 with byte ranges so players can buffer and seek', async () => {
  const t = await boot();
  const full = await fetch(t.base + '/media/sample.mp4'); const all = Buffer.from(await full.arrayBuffer());
  assert.equal(full.status, 200); assert.equal(full.headers.get('content-type'), 'video/mp4'); assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.ok(all.length > 10_000); assert.equal(all.subarray(4, 8).toString(), 'ftyp'); // a real MP4 container
  const part = await fetch(t.base + '/media/sample.mp4', { headers: { range: 'bytes=0-99' } });
  assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), `bytes 0-99/${all.length}`); assert.equal((await part.arrayBuffer()).byteLength, 100);
  const tail = await fetch(t.base + '/media/sample.mp4', { headers: { range: 'bytes=-50' } }); assert.equal(tail.status, 206); assert.equal((await tail.arrayBuffer()).byteLength, 50);
  assert.equal((await fetch(t.base + '/media/sample.mp4', { headers: { range: `bytes=${all.length + 5}-` } })).status, 416);
  // adaptive streaming: an HLS master playlist with two renditions and their segments
  const master = await fetch(t.base + '/media/hls/master.m3u8'); const txt = await master.text();
  assert.equal(master.headers.get('content-type'), 'application/vnd.apple.mpegurl'); assert.ok(txt.startsWith('#EXTM3U') && (txt.match(/#EXT-X-STREAM-INF/g) || []).length === 2);
  const seg = await fetch(t.base + '/media/hls/v0_000.ts'); assert.equal(seg.headers.get('content-type'), 'video/mp2t'); assert.ok((await seg.arrayBuffer()).byteLength > 1000);
  await t.stop();
});
