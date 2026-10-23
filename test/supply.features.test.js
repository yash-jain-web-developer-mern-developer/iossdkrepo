import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { boot, human, settle, sleep } from './lib/helpers.js';
import { sanitizeTargeting, targetingOk, osMajorMinor } from '../src/core/targeting.js';
import { pickCreative, noteCreative, beta } from '../src/core/creative.js';
import { signBody, deliverReward } from '../src/core/rewards.js';
import { validateOutboundUrl, isPrivateIp, safePost } from '../src/core/safeHttp.js';

const camp = (o = {}) => ({ name: 'T', model: 'CPM', bid: 5, budget: 100, clickUrl: 'https://example.com/l', ...o });
const ask = (t, appId, extra = {}) => t.call('/v1/ad', 'POST', { appId, ...extra });

test('targeting: sanitize and match', () => {
  const t = sanitizeTargeting({ languages: ['EN', 'fr', '1x', 5], deviceTypes: ['phone', 'toaster'], connections: ['wifi'], minOs: '14.5', hours: [9, 10, 99, 'a'], appAllow: ['a1'], appBlock: ['b1'], junk: 1 });
  assert.deepEqual(t, { languages: ['en', 'fr'], deviceTypes: ['phone'], connections: ['wifi'], minOs: 14.5, hours: [9, 10], appAllow: ['a1'], appBlock: ['b1'] });
  assert.deepEqual(sanitizeTargeting({ hours: Array.from({ length: 24 }, (_, i) => i) }), {}); // all 24 hours = no restriction
  assert.equal(osMajorMinor('Android 13'), 13); assert.equal(osMajorMinor('17.4.1'), 17.4); assert.ok(Number.isNaN(osMajorMinor('x')));
  const base = { appId: 'a1', lang: 'en-US', deviceType: 'phone', connection: 'wifi', osVersion: '15.2', hourUtc: 9 };
  assert.equal(targetingOk(t, base), true);
  assert.equal(targetingOk(t, { ...base, appId: 'b1' }), false);
  assert.equal(targetingOk(t, { ...base, lang: 'de' }), false);
  assert.equal(targetingOk(t, { ...base, deviceType: 'tablet' }), false);
  assert.equal(targetingOk(t, { ...base, osVersion: '14.0' }), false);
  assert.equal(targetingOk(t, { ...base, hourUtc: 3 }), false);
  assert.equal(targetingOk(t, { ...base, connection: undefined }), false); // missing signal fails closed
  assert.equal(targetingOk({}, {}), true); assert.equal(targetingOk(undefined, {}), true);
});

test('creative rotation: Thompson sampling favours the better creative but keeps exploring', () => {
  const c = { id: 'c1', creative: { title: 'x' }, creatives: [{ id: 'cr_0' }, { id: 'cr_1' }, { id: 'cr_2' }] };
  const stats = new Map(); noteCreative(stats, 'c1', 'cr_0', 'impression');
  for (let i = 0; i < 1000; i++) noteCreative(stats, 'c1', 'cr_0', 'impression');
  for (let i = 0; i < 1000; i++) noteCreative(stats, 'c1', 'cr_1', 'impression');
  for (let i = 0; i < 100; i++) noteCreative(stats, 'c1', 'cr_1', 'click'); // 10% CTR
  for (let i = 0; i < 20; i++) noteCreative(stats, 'c1', 'cr_0', 'click');   // 2% CTR
  const wins = { cr_0: 0, cr_1: 0, cr_2: 0 };
  for (let i = 0; i < 600; i++) wins[pickCreative(c, stats).id]++;
  assert.ok(wins.cr_1 > wins.cr_0 * 3, JSON.stringify(wins));
  assert.ok(wins.cr_2 > 0, 'an untested creative still gets traffic');
  assert.equal(pickCreative({ id: 'z', creative: { title: 't' } }, new Map()).id, 'cr_0'); // single creative
  const mean = Array.from({ length: 2000 }, () => beta(2, 8)).reduce((a, b) => a + b) / 2000; assert.ok(Math.abs(mean - 0.2) < 0.03);
});

test('targeting end to end: language, device, OS, hour and app allow/block lists', async () => {
  const t = await boot();
  const adv = await t.signup('adv@x.io', 'advertiser'), pub = await t.signup('pub@x.io', 'publisher');
  const a1 = (await t.call('/api/apps', 'POST', { name: 'A1' }, pub)).body, a2 = (await t.call('/api/apps', 'POST', { name: 'A2' }, pub)).body;
  const hour = new Date().getUTCHours(), otherHour = (hour + 5) % 24;
  await t.call('/api/campaigns', 'POST', camp({ targeting: { languages: ['en'], deviceTypes: ['phone'], minOs: 14, hours: [hour], appAllow: [a1.id], connections: ['wifi'] } }), adv);
  const good = { language: 'en-GB', deviceType: 'phone', osVersion: '15.1', connection: 'wifi' };
  assert.equal((await ask(t, a1.id, good)).status, 200);
  assert.equal((await ask(t, a2.id, good)).status, 204);                       // app not on the allow list
  assert.equal((await ask(t, a1.id, { ...good, language: 'de' })).status, 204);
  assert.equal((await ask(t, a1.id, { ...good, deviceType: 'tablet' })).status, 204);
  assert.equal((await ask(t, a1.id, { ...good, osVersion: '13.0' })).status, 204);
  assert.equal((await ask(t, a1.id, { ...good, connection: 'cellular' })).status, 204);
  assert.equal((await ask(t, a1.id, {})).status, 204);                          // sends no signals at all
  const adv2 = await t.signup('adv2@x.io', 'advertiser');
  await t.call('/api/campaigns', 'POST', camp({ name: 'wrong hour', targeting: { hours: [otherHour] } }), adv2);
  await t.call('/api/campaigns', 'POST', camp({ name: 'blocked', targeting: { appBlock: [a2.id] } }), adv2);
  assert.equal((await ask(t, a2.id)).status, 204); // only the wrong-hour and blocked campaigns remain eligible-looking
  await t.stop();
});

test('creative sets: rotation, per-creative reporting, adding a creative forces re-review', async () => {
  const t = await boot({ autoApproveCampaigns: true });
  const adv = await t.signup('adv@x.io', 'advertiser'), pub = await t.signup('pub@x.io', 'publisher');
  const a = (await t.call('/api/apps', 'POST', { name: 'A' }, pub)).body;
  const bad = await t.call('/api/campaigns', 'POST', camp({ creatives: [{ title: 'ok' }, { image: 'http://x.example/i.png', clickUrl: 'javascript:alert(1)' }] }), adv);
  assert.equal(bad.status, 400); assert.match(bad.body.reasons.join(), /creative 2/);
  assert.equal((await t.call('/api/campaigns', 'POST', camp({ creatives: Array.from({ length: 6 }, (_, i) => ({ title: 'c' + i })) }), adv)).status, 400);
  const c = (await t.call('/api/campaigns', 'POST', camp({ creatives: [{ title: 'Alpha' }, { title: 'Beta', cta: 'Go' }, { title: 'Gamma', clickUrl: 'https://example.com/gamma' }] }), adv)).body;
  assert.equal(c.creatives.length, 3); assert.equal(c.creative.title, 'Alpha');
  const seen = new Map();
  for (let i = 0; i < 40; i++) { const r = await ask(t, a.id); seen.set(r.body.creative.title, (seen.get(r.body.creative.title) || 0) + 1); await t.call(t.path(r.body.impressionUrl)); }
  assert.deepEqual([...seen.keys()].sort(), ['Alpha', 'Beta', 'Gamma']);
  await settle(t.app);
  const rows = (await t.call('/api/report/breakdown?by=creative', 'GET', null, adv)).body;
  assert.deepEqual(rows.map((r) => r.key).sort(), ['cr_0', 'cr_1', 'cr_2']);
  assert.equal(rows.reduce((n, r) => n + r.impressions, 0), 40);
  // a click on the 'Gamma' creative lands on its own URL
  let landed = null;
  for (let i = 0; i < 60 && !landed; i++) { const r = await ask(t, a.id); if (r.body.creative.title === 'Gamma') { await t.call(t.path(r.body.impressionUrl)); await human(); landed = (await t.call(t.path(r.body.clickUrl))).headers.get('location'); } }
  assert.match(landed, /^https:\/\/example\.com\/gamma/);
  // add a creative: campaign goes through review again when autoApprove is off; here it re-approves automatically
  const add = await t.call('/api/campaigns/creative', 'POST', { campaignId: c.id, creative: { title: 'Delta' } }, adv);
  assert.equal((await t.call('/api/campaigns/creative', 'POST', { campaignId: c.id, creative: { clickUrl: 'ftp://bad' } }, adv)).status, 400);
  assert.equal(add.status, 201); assert.equal(add.body.id, 'cr_3'); assert.equal(add.body.creatives.length, 4);
  assert.equal((await t.call('/api/campaigns/creative', 'POST', { campaignId: c.id, creative: { title: 'E' } }, adv)).status, 201);
  assert.equal((await t.call('/api/campaigns/creative', 'POST', { campaignId: c.id, creative: { title: 'F' } }, adv)).status, 409); // cap of 5
  const other = await t.signup('o@x.io', 'advertiser');
  assert.equal((await t.call('/api/campaigns/creative', 'POST', { campaignId: c.id, creative: { title: 'steal' } }, other)).status, 404);
  await t.stop();

  const strict = await boot({ autoApproveCampaigns: false });
  const adv2 = await strict.signup('adv@x.io', 'advertiser'), admin = await strict.makeAdmin(), pub2 = await strict.signup('pub@x.io', 'publisher');
  const a2 = (await strict.call('/api/apps', 'POST', { name: 'A' }, pub2)).body;
  const c2 = (await strict.call('/api/campaigns', 'POST', camp({ creatives: [{ title: 'One' }] }), adv2)).body;
  await strict.call('/api/admin/campaigns/review', 'POST', { id: c2.id, decision: 'approve' }, admin);
  assert.equal((await ask(strict, a2.id)).status, 200);
  const r = await strict.call('/api/campaigns/creative', 'POST', { campaignId: c2.id, creative: { title: 'Two' } }, adv2);
  assert.equal(r.body.reviewStatus, 'pending');
  assert.equal((await ask(strict, a2.id)).status, 204); // stops serving until the new creative is approved
  await strict.stop();
});

test('native assets: fields flow to the ad response; policy limits apply', async () => {
  const t = await boot();
  const adv = await t.signup('adv@x.io', 'advertiser'), pub = await t.signup('pub@x.io', 'publisher');
  const a = (await t.call('/api/apps', 'POST', { name: 'A' }, pub)).body;
  assert.equal((await t.call('/api/campaigns', 'POST', camp({ format: 'native', body: 'x'.repeat(201) }), adv)).status, 400);
  assert.equal((await t.call('/api/campaigns', 'POST', camp({ format: 'native', rating: 9 }), adv)).status, 400);
  assert.equal((await t.call('/api/campaigns', 'POST', camp({ format: 'native', iconUrl: 'http://cdn.example.com/i.png' }), adv)).status, 400);
  assert.equal((await t.call('/api/campaigns', 'POST', camp({ format: 'native', title: 'Fit app', body: 'Track every workout', iconUrl: 'https://cdn.example.com/i.png', image: 'https://cdn.example.com/h.png', sponsor: 'FitCo', rating: 4.6, cta: 'Install' }), adv)).status, 201);
  const r = await ask(t, a.id, { format: 'native' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.creative, { title: 'Fit app', image: 'https://cdn.example.com/h.png', cta: 'Install', body: 'Track every workout', iconUrl: 'https://cdn.example.com/i.png', sponsor: 'FitCo', rating: 4.6 });
  await t.stop();
});

test('placements: own floors and default format; foreign placements are refused', async () => {
  const t = await boot();
  const adv = await t.signup('adv@x.io', 'advertiser'), pub = await t.signup('pub@x.io', 'publisher'), other = await t.signup('o@x.io', 'publisher');
  const a = (await t.call('/api/apps', 'POST', { name: 'A' }, pub)).body, oa = (await t.call('/api/apps', 'POST', { name: 'O' }, other)).body;
  await t.call('/api/campaigns', 'POST', camp({ bid: 3, format: 'interstitial' }), adv);
  assert.equal((await t.call('/api/placements', 'POST', { appId: a.id, name: 'x', format: 'hologram' }, pub)).status, 400);
  assert.equal((await t.call('/api/placements', 'POST', { appId: a.id, name: 'x', format: 'interstitial' }, adv)).status, 403);
  assert.equal((await t.call('/api/placements', 'POST', { appId: oa.id, name: 'x', format: 'interstitial' }, pub)).status, 404);
  const cheap = (await t.call('/api/placements', 'POST', { appId: a.id, name: 'Level end', format: 'interstitial', floorEcpm: 1 }, pub)).body;
  const dear = (await t.call('/api/placements', 'POST', { appId: a.id, name: 'Premium', format: 'interstitial', floorEcpm: 50 }, pub)).body;
  assert.equal((await t.call('/api/placements', 'GET', null, pub)).body.length, 2);
  assert.equal((await ask(t, a.id, { placementId: cheap.id })).status, 200); // format comes from the placement
  assert.equal((await ask(t, a.id, { placementId: dear.id })).status, 204);  // placement floor above every bid
  assert.equal((await ask(t, a.id, { placementId: 'plc_nope' })).status, 400);
  const ok = await ask(t, a.id, { placementId: cheap.id }); await t.call(t.path(ok.body.impressionUrl)); await settle(t.app);
  assert.equal((await t.call('/api/report/breakdown?by=placement', 'GET', null, pub)).body[0].key, cheap.id);
  await t.stop();
});

test('breakdown reports: dimensions, role limits and privacy of the other side', async () => {
  const t = await boot();
  const adv = await t.signup('adv@x.io', 'advertiser'), pub = await t.signup('pub@x.io', 'publisher');
  const a = (await t.call('/api/apps', 'POST', { name: 'Game' }, pub)).body;
  const c = (await t.call('/api/campaigns', 'POST', camp({ name: 'Spring', bid: 6000, budget: 1000 }), adv)).body;
  for (const country of ['US', 'US', 'IN']) { const r = await ask(t, a.id, { country }); await t.call(t.path(r.body.impressionUrl)); }
  await settle(t.app);
  const by = async (token, dim) => (await t.call('/api/report/breakdown?by=' + dim, 'GET', null, token)).body;
  const countries = await by(adv, 'country'); assert.deepEqual(countries.map((r) => [r.key, r.impressions]), [['US', 2], ['IN', 1]]);
  assert.equal((await by(adv, 'campaign'))[0].name, 'Spring'); assert.equal((await by(adv, 'campaign'))[0].spend > 0, true);
  assert.equal((await by(adv, 'format'))[0].key, 'banner');
  assert.equal((await by(adv, 'app'))[0].key, a.id);
  const pubRows = await by(pub, 'app'); assert.equal(pubRows[0].name, 'Game'); assert.equal(pubRows[0].spend, undefined); assert.ok(pubRows[0].publisherRevenue > 0); // publishers never see advertiser spend
  assert.equal((await t.call('/api/report/breakdown?by=creative', 'GET', null, pub)).status, 400);
  assert.equal((await t.call('/api/report/breakdown?by=placement', 'GET', null, adv)).status, 400);
  assert.equal((await t.call('/api/report/breakdown?by=ssn', 'GET', null, adv)).status, 400);
  assert.equal((await t.call('/api/report/breakdown?by=country', 'GET', null, await t.signup('new@x.io', 'advertiser'))).body.length, 0); // tenants are isolated
  await t.stop();
});

// ---- rewarded video ----
function receiver() {
  const got = []; let status = 200;
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { got.push({ body: b, headers: req.headers }); res.writeHead(status); res.end('ok'); }); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ got, url: `http://127.0.0.1:${srv.address().port}/reward`, setStatus: (s) => { status = s; }, close: () => srv.closeAllConnections() || srv.close() })));
}

test('rewarded video: signed server-to-server callback only for a real, seen, full playback, exactly once', async () => {
  const rx = await receiver();
  const t = await boot({ allowPrivateCallbacks: true });
  const adv = await t.signup('adv@x.io', 'advertiser'), pub = await t.signup('pub@x.io', 'publisher');
  const a = (await t.call('/api/apps', 'POST', { name: 'Game' }, pub)).body;
  await t.call('/api/campaigns', 'POST', camp({ format: 'video', videoUrl: 'https://cdn.example.com/a.mp4', durationSec: 1 }), adv);
  assert.equal((await t.call('/api/apps/reward', 'POST', { id: a.id, callbackUrl: 'not a url' }, pub)).status, 400);
  assert.equal((await t.call('/api/apps/reward', 'POST', { id: a.id, callbackUrl: rx.url, amount: 0 }, pub)).status, 400);
  const cfg = await t.call('/api/apps/reward', 'POST', { id: a.id, callbackUrl: rx.url, amount: 25, item: 'coins' }, pub);
  assert.equal(cfg.status, 200); assert.match(cfg.body.secret, /^[0-9a-f]{64}$/);
  const again = await t.call('/api/apps/reward', 'POST', { id: a.id, callbackUrl: rx.url, amount: 25, item: 'coins' }, pub); assert.equal(again.body.secret, undefined); // shown once
  const listed = (await t.call('/api/apps', 'GET', null, pub)).body[0]; assert.equal(listed.hasRewardSecret, true); assert.equal(listed.rewardSecret, undefined);

  // a plain video request never receives rewarded config; a rewarded request gets the video campaign and the reward description
  const ad = await ask(t, a.id, { format: 'rewarded', userId: 'player-42' });
  assert.equal(ad.status, 200); assert.deepEqual(ad.body.reward, { amount: 25, item: 'coins' });
  // instant completion (no impression, too fast) -> no reward
  await t.call(t.path(ad.body.videoCompleteUrl)); await sleep(150);
  assert.equal(rx.got.length, 0);

  const ad2 = await ask(t, a.id, { format: 'rewarded', userId: 'player-42' });
  await t.call(t.path(ad2.body.impressionUrl)); await sleep(900); // 1-second video watched
  await t.call(t.path(ad2.body.videoCompleteUrl)); await t.call(t.path(ad2.body.videoCompleteUrl)); // replay
  for (let i = 0; i < 30 && !rx.got.length; i++) await sleep(100);
  await sleep(200);
  assert.equal(rx.got.length, 1, 'exactly one callback');
  const hit = rx.got[0], body = JSON.parse(hit.body);
  assert.equal(hit.headers['x-mobiad-signature'], signBody(cfg.body.secret, hit.body));
  assert.deepEqual({ ...body, transactionId: undefined, timestamp: undefined }, { event: 'reward', appId: a.id, userId: 'player-42', amount: 25, item: 'coins', transactionId: undefined, timestamp: undefined });
  assert.match(body.transactionId, /^[0-9a-f]{24}$/);
  assert.notEqual(signBody('wrong-secret', hit.body), hit.headers['x-mobiad-signature']);
  await t.stop(); rx.close();
});

test('reward callbacks and outbound URLs are SSRF-safe; delivery retries 5xx but not 4xx', async () => {
  assert.equal(validateOutboundUrl('http://example.com/x'), 'must be an https URL');
  assert.match(validateOutboundUrl('https://127.0.0.1/x'), /private/); assert.match(validateOutboundUrl('https://localhost/x'), /private/); assert.match(validateOutboundUrl('https://u:p@example.com/'), /credentials/);
  assert.equal(validateOutboundUrl('https://example.com/ok'), null);
  for (const ip of ['10.1.2.3', '192.168.0.1', '169.254.169.254', '127.0.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) assert.equal(isPrivateIp(ip), true, ip);
  assert.equal(isPrivateIp('8.8.8.8'), false);
  await assert.rejects(safePost('http://127.0.0.1:1/x', { body: '{}' }), /blocked/);
  await assert.rejects(safePost('https://169.254.169.254/latest', { body: '{}' }), /blocked/);

  const app = { id: 'app_x', rewardCallbackUrl: 'https://pub.example/cb', rewardSecret: 's', rewardAmount: 1, rewardItem: 'gem' };
  let calls = 0; const sleeps = [];
  const flaky = async () => { calls++; return { status: calls < 3 ? 503 : 200 }; };
  assert.equal(await deliverReward({ app, userId: 'u', txn: 't', post: flaky, sleep: async (ms) => { sleeps.push(ms); } }), true);
  assert.equal(calls, 3); assert.deepEqual(sleeps, [500, 2000]);
  calls = 0; assert.equal(await deliverReward({ app, userId: 'u', txn: 't', post: async () => { calls++; return { status: 403 }; }, sleep: async () => {} }), false); assert.equal(calls, 1);
  calls = 0; assert.equal(await deliverReward({ app, userId: 'u', txn: 't', post: async () => { calls++; throw new Error('down'); }, sleep: async () => {} }), false); assert.equal(calls, 3);
  assert.equal(await deliverReward({ app: { id: 'a' }, post: flaky }), false); // not configured

  const t = await boot(); // default config: private callback targets are refused at configuration time
  const pub = await t.signup('pub@x.io', 'publisher'); const a = (await t.call('/api/apps', 'POST', { name: 'A' }, pub)).body;
  assert.equal((await t.call('/api/apps/reward', 'POST', { id: a.id, callbackUrl: 'http://127.0.0.1:9/cb' }, pub)).status, 400);
  assert.equal((await t.call('/api/apps/reward', 'POST', { id: a.id, callbackUrl: 'https://169.254.169.254/x' }, pub)).status, 400);
  await t.stop();
});
