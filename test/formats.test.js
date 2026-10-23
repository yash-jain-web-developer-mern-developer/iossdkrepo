import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, settle } from './lib/helpers.js';
import { screenCreative } from '../src/policy.js';
import { buildVast } from '../src/adserver/openrtb.js';

const base = { name: 'V', model: 'CPM', bid: 5, budget: 50, clickUrl: 'https://example.com/l', category: 'general' };
const vid = { ...base, format: 'video', videoUrl: 'https://cdn.example.com/ad.mp4', durationSec: 15 };

test('policy: video and playable rules', () => {
  const s = (o) => screenCreative({ ...base, ...o });
  assert.deepEqual(s({ format: 'video', videoUrl: vid.videoUrl, durationSec: 15 }).hard, []);
  assert.match(s({ format: 'video' }).hard.join(), /requires videoUrl|videoUrl is required/);
  assert.match(s({ format: 'video', videoUrl: 'http://cdn.example.com/a.mp4', durationSec: 10 }).hard.join(), /videoUrl must use https/);
  assert.match(s({ format: 'video', videoUrl: 'https://cdn.example.com/a.exe', durationSec: 10 }).hard.join(), /\.mp4/);
  assert.match(s({ format: 'video', videoUrl: vid.videoUrl, durationSec: 600 }).hard.join(), /durationSec/);
  assert.match(s({ format: 'video', videoUrl: vid.videoUrl }).hard.join(), /durationSec/);
  assert.match(s({ format: 'video', videoUrl: 'https://u:p@cdn.example.com/a.mp4', durationSec: 5 }).hard.join(), /credentials/);
  assert.match(s({ format: 'video', videoUrl: 'javascript:alert(1)', durationSec: 5 }).hard.join(), /http\(s\)/);
  assert.match(s({ format: 'video', videoUrl: 'https://127.0.0.1/a.mp4', durationSec: 5 }).hard.join(), /private/);
  assert.match(s({ format: 'playable' }).hard.join(), /playable/);
  const p = s({ format: 'playable', playableUrl: 'https://cdn.example.com/game/index.html' });
  assert.deepEqual(p.hard, []); assert.match(p.soft.join(), /manual review/); // third-party code never auto-approves
});

test('formats: video campaign is served only to video requests, tracked, and completes are counted but never billed', async () => {
  const t = await boot();
  const adv = await t.signup('adv@x.io', 'advertiser'), pub = await t.signup('pub@x.io', 'publisher');
  assert.equal((await t.call('/api/campaigns', 'POST', { ...vid, durationSec: 999 }, adv)).status, 400);
  assert.equal((await t.call('/api/campaigns', 'POST', { ...vid, videoUrl: undefined }, adv)).status, 400);
  const c = await t.call('/api/campaigns', 'POST', { ...vid, cta: 'Install now' }, adv); assert.equal(c.status, 201);
  assert.equal(c.body.creative.videoUrl, vid.videoUrl);
  const a = (await t.call('/api/apps', 'POST', { name: 'v' }, pub)).body;

  assert.equal((await t.call('/v1/ad', 'POST', { appId: a.id, format: 'banner' })).status, 204); // wrong format
  const ad = await t.call('/v1/ad', 'POST', { appId: a.id, format: 'video' });
  assert.equal(ad.status, 200);
  assert.equal(ad.body.creative.videoUrl, vid.videoUrl); assert.equal(ad.body.creative.durationSec, 15); assert.equal(ad.body.creative.cta, 'Install now');
  assert.match(ad.body.videoCompleteUrl, /\/t\/v\//);

  await t.call(t.path(ad.body.impressionUrl));
  assert.equal((await t.call(t.path(ad.body.videoCompleteUrl))).status, 200);
  await t.call(t.path(ad.body.videoCompleteUrl)); // replay
  await settle(t.app);
  const rep = (await t.call('/api/report', 'GET', null, adv)).body.total;
  assert.equal(rep.videoCompletes, 1); assert.equal(rep.impressions, 1);
  const cost = (await t.app.repo.q("SELECT SUM(amount_micros) AS m FROM ledger WHERE event='video_complete'")).rows[0].m;
  assert.equal(Number(cost || 0), 0, 'completion events are never billed');
  assert.equal((await t.call('/api/report', 'GET', null, pub)).body.total.videoCompletes, 1);
  assert.equal((await t.call(t.path(ad.body.videoCompleteUrl.slice(0, -2) + 'xx'))).status, 400); // forged token
  await t.stop();
});

test('formats: playable ads require manual review in production-like config; creative carries the sandboxed URL', async () => {
  const t = await boot({ autoApproveCampaigns: true });
  const adv = await t.signup('adv@x.io', 'advertiser');
  const c = await t.call('/api/campaigns', 'POST', { ...base, format: 'playable', playableUrl: 'https://cdn.example.com/game/index.html' }, adv);
  assert.equal(c.status, 201); assert.equal(c.body.reviewStatus, 'pending'); assert.equal(c.body.creative.playableUrl, 'https://cdn.example.com/game/index.html');
  await t.stop();
});

test('openrtb: video impression is answered with valid VAST 4.2 carrying signed tracking URLs', async () => {
  const t = await boot();
  const adv = await t.signup('adv@x.io', 'advertiser'), pub = await t.signup('pub@x.io', 'publisher');
  await t.call('/api/campaigns', 'POST', vid, adv);
  const a = (await t.call('/api/apps', 'POST', { name: 'ex' }, pub)).body;
  const r = await t.call('/rtb/v2.6/bid', 'POST', { id: 'r1', imp: [{ id: '1', video: { w: 640, h: 360 }, bidfloor: 0.5 }], app: { id: a.id }, device: { geo: { country: 'USA' } } });
  assert.equal(r.status, 200);
  const bid = r.body.seatbid[0].bid[0];
  assert.match(bid.adm, /^<\?xml/); assert.match(bid.adm, /<VAST version="4\.2">/); assert.match(bid.adm, /<Duration>00:00:15<\/Duration>/);
  assert.match(bid.adm, /type="video\/mp4"/); assert.match(bid.adm, /event="complete"><!\[CDATA\[http[^\]]+\/t\/v\//);
  assert.match(bid.adm, /<ClickThrough><!\[CDATA\[http[^\]]+\/t\/c\//);
  await t.call(t.path(bid.nurl)); await settle(t.app);
  assert.equal((await t.call('/api/report', 'GET', null, adv)).body.total.impressions, 1);
  // a banner-only request never receives the video campaign
  assert.equal((await t.call('/rtb/v2.6/bid', 'POST', { id: 'r2', imp: [{ id: '1', banner: {} }], app: { id: a.id } })).status, 204);
  await t.stop();
});

test('vast: titles are XML-escaped', () => {
  const x = buildVast({ campaign: { id: 'c1', category: 'general', creative: { title: 'A <b> & "q"', videoUrl: 'https://cdn.example.com/a.webm', durationSec: 3 } } }, 'TOK', 'http://h');
  assert.ok(!x.includes('<b>')); assert.match(x, /A &lt;b&gt; &amp; &quot;q&quot;/); assert.match(x, /video\/webm/);
});

test('policy: a local http video is only accepted for local development (allowLocal), never otherwise', () => {
  const v = { ...base, format: 'video', videoUrl: 'http://192.168.1.20:8080/media/sample.mp4', durationSec: 6 };
  assert.ok(screenCreative(v).hard.length > 0);
  assert.deepEqual(screenCreative(v, { allowLocal: true }).hard, []);
  assert.match(screenCreative({ ...v, videoUrl: 'http://cdn.example.com/a.mp4' }, { allowLocal: true }).hard.join(), /must use https/); // a public host still needs https
});
