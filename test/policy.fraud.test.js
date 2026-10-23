import test from 'node:test';
import assert from 'node:assert/strict';
import { screenCreative, initialReview, isPrivateOrLocalHost, RESTRICTED } from '../src/policy.js';
import { judgeClick, judgeApp, scanApps, FRAUD } from '../src/fraud.js';
import { createPool, Repo } from '../src/db/repo.js';

const ok = { clickUrl: 'https://shop.example.com/offer', name: 'Summer Sale', title: 'Big savings', category: 'shopping' };

test('policy: clean creative passes with no flags', () => {
  const r = screenCreative(ok);
  assert.deepEqual(r, { hard: [], soft: [] });
  assert.equal(initialReview(r, { autoApprove: true }), 'approved');
  assert.equal(initialReview(r, { autoApprove: false }), 'pending'); // production default: manual review
});
test('policy: hard failures for dangerous or malformed URLs', () => {
  const cases = ['javascript:alert(1)', 'data:text/html,<script>', 'ftp://x.com', 'not a url', 'https://user:pw@evil.com/', 'http://localhost/x', 'http://127.0.0.1/', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://172.20.0.1/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'https://intranet.internal/', 'https://x.local/'];
  for (const clickUrl of cases) assert.ok(screenCreative({ ...ok, clickUrl }).hard.length > 0, clickUrl);
  assert.ok(screenCreative({ ...ok, clickUrl: 'https://a.com/' + 'x'.repeat(3000) }).hard.length > 0);
});
test('policy: public IPs and normal domains are fine; https can be required; blocked domains', () => {
  assert.equal(screenCreative({ ...ok, clickUrl: 'http://8.8.8.8/' }).hard.length, 0);
  assert.equal(isPrivateOrLocalHost('172.32.0.1'), false);
  assert.equal(isPrivateOrLocalHost('172.31.255.255'), true);
  assert.ok(screenCreative({ ...ok, clickUrl: 'http://shop.example.com/' }, { requireHttps: true }).hard.some((m) => /https/.test(m)));
  assert.ok(screenCreative({ ...ok, clickUrl: 'https://sub.bad.com/' }, { blockedDomains: ['bad.com'] }).hard.some((m) => /blocked/.test(m)));
  assert.ok(screenCreative({ ...ok, image: 'http://10.1.1.1/a.png' }).hard.some((m) => /image/.test(m)));
});
test('policy: soft flags (shortener, scam phrases, restricted categories, punycode) force manual review even with autoApprove', () => {
  for (const patch of [{ clickUrl: 'https://bit.ly/abc' }, { title: 'You have won a prize' }, { category: 'gambling' }, { category: 'crypto' }, { clickUrl: 'https://xn--e1afmkfd.com/' }]) {
    const r = screenCreative({ ...ok, ...patch });
    assert.equal(r.hard.length, 0, JSON.stringify(patch));
    assert.ok(r.soft.length > 0, JSON.stringify(patch));
    assert.equal(initialReview(r, { autoApprove: true }), 'pending');
  }
  assert.ok(RESTRICTED.has('gambling') && !RESTRICTED.has('games'));
  assert.ok(screenCreative({ ...ok, category: 'weapons' }).hard.length > 0); // unknown category
});

const base = { issuedAt: 1_000_000, now: 1_005_000, impressionSeen: true, selfDealing: false, ipClicksThisMinute: 1 };
test('fraud: a normal click is valid', () => assert.deepEqual(judgeClick(base), { valid: true }));
test('fraud: each rule rejects with its own reason', () => {
  assert.equal(judgeClick({ ...base, selfDealing: true }).reason, 'self_click');
  assert.equal(judgeClick({ ...base, impressionSeen: false }).reason, 'no_impression');
  assert.equal(judgeClick({ ...base, now: base.issuedAt + 100 }).reason, 'too_fast');
  assert.equal(judgeClick({ ...base, now: base.issuedAt + FRAUD.maxClickAgeMs + 1 }).reason, 'stale');
  assert.equal(judgeClick({ ...base, ipClicksThisMinute: FRAUD.maxIpClicksPerMinute + 1 }).reason, 'ip_rate');
  assert.equal(judgeClick({ ...base, now: base.issuedAt + FRAUD.minClickDelayMs }).valid, true); // boundary: exactly the minimum is fine
});
test('fraud: app verdicts need a minimum sample, then flag abnormal CTR or invalid share', () => {
  assert.equal(judgeApp({ impressions: 100, clicks: 90, invalidClicks: 0 }).flag, false); // too few impressions to judge
  assert.equal(judgeApp({ impressions: 1000, clicks: 30, invalidClicks: 0 }).flag, false); // 3% CTR
  assert.match(judgeApp({ impressions: 1000, clicks: 400, invalidClicks: 0 }).reason, /CTR 40/);
  assert.match(judgeApp({ impressions: 1000, clicks: 20, invalidClicks: 40 }).reason, /67% of click attempts/);
  assert.equal(judgeApp({ impressions: 1000, clicks: 3, invalidClicks: 4 }).flag, false); // tiny click counts: no verdict
});
test('fraud: scanApps flags suspicious apps once, audits, never auto-clears', async () => {
  const repo = new Repo(await createPool('')); await repo.migrate();
  await repo.createApp({ id: 'good', owner: 'p', name: 'g', platform: 'android', floorEcpm: 0 });
  await repo.createApp({ id: 'bad', owner: 'p', name: 'b', platform: 'android', floorEcpm: 0 });
  const ev = (app, type, i) => ({ type, campaignId: 'c', appId: app, cost: 0, t: Date.now(), token: app + type + i });
  await repo.recordBatch([...Array.from({ length: 600 }, (_, i) => ev('good', 'impression', i)), ...Array.from({ length: 12 }, (_, i) => ev('good', 'click', i))]);
  await repo.recordBatch([...Array.from({ length: 600 }, (_, i) => ev('bad', 'impression', i)), ...Array.from({ length: 300 }, (_, i) => ev('bad', 'click', i))]);
  const audits = [];
  const first = await scanApps(repo, { audit: async (a) => audits.push(a) });
  assert.deepEqual(first.map((f) => f.id), ['bad']);
  assert.equal((await repo.app('bad')).flagged, true);
  assert.equal((await repo.app('good')).flagged, false);
  assert.equal(audits[0].action, 'app_flagged');
  assert.deepEqual(await scanApps(repo, { audit: async () => {} }), []); // already flagged: not re-flagged
});
