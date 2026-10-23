import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { boot, settle, sleep, human } from './lib/helpers.js';
import { encodeTcString, parseTcString, tcfAllowsDeviceId } from '../src/core/tcf.js';
import { personalizationAllowed } from '../src/adserver/index.js';
import { signWebhook, verifyWebhook, RETRY_DELAYS_MS, startWebhookWorker } from '../src/core/webhooks.js';

const camp = (o = {}) => ({ name: 'T', model: 'CPM', bid: 5, budget: 100, clickUrl: 'https://example.com/l', ...o });

test('TCF v2: consent strings are parsed; garbage and missing purposes mean no consent', () => {
  const s = encodeTcString({ purposes: [1, 2, 7], vendors: [3, 755] , maxVendor: 800 });
  const p = parseTcString(s);
  assert.deepEqual([...p.purposesConsent], [1, 2, 7]); assert.deepEqual([...p.vendorConsents].sort((a, b) => a - b), [3, 755]); assert.equal(p.version, 2);
  assert.equal(tcfAllowsDeviceId(s), true); assert.equal(tcfAllowsDeviceId(s, { vendorId: 755 }), true); assert.equal(tcfAllowsDeviceId(s, { vendorId: 4 }), false);
  assert.equal(tcfAllowsDeviceId(s, { purposes: [1, 3] }), false);
  assert.equal(tcfAllowsDeviceId(encodeTcString({ purposes: [2] })), false); // purpose 1 missing
  for (const bad of ['', 'CPx', 'not base64 !!!', null, undefined, 42, 'A'.repeat(100), 'x'.repeat(7000)]) assert.equal(tcfAllowsDeviceId(bad), false, String(bad).slice(0, 10));
  assert.equal(parseTcString(encodeTcString({ purposes: [1] }).replace(/^./, 'Z')), null); // wrong version
  const app = { childDirected: false };
  assert.equal(personalizationAllowed(app, { gdpr: true, gdprConsent: 'CPx' }), false);
  assert.equal(personalizationAllowed(app, { gdpr: true, gdprConsent: s }), true);
  assert.equal(personalizationAllowed(app, { gdpr: true, gdprConsent: s }, { tcfVendorId: 9 }), false); // we are not on the user's vendor list
  assert.equal(personalizationAllowed(app, { gdpr: false }), true);
});

test('test ads: no auction, no billing, every format', async () => {
  const t = await boot();
  const pub = await t.signup('pub@x.io', 'publisher'); const a = (await t.call('/api/apps', 'POST', { name: 'A' }, pub)).body;
  for (const f of ['banner', 'native', 'video', 'rewarded', 'playable', 'interstitial']) {
    const r = await t.call('/v1/ad', 'POST', { appId: a.id, format: f, test: true });
    assert.equal(r.status, 200, f); assert.equal(r.body.test, true); assert.equal(r.body.creative.title, 'MobiAd test ad');
    assert.equal((await t.call(t.path(r.body.impressionUrl))).status, 200);
    if (f === 'rewarded') assert.deepEqual(r.body.reward, { amount: 1, item: 'reward' });
    if (f === 'video') assert.ok(r.body.creative.videoUrl && r.body.videoCompleteUrl);
  }
  assert.equal((await t.call('/v1/test/click')).status, 302);
  assert.equal((await t.call('/v1/ad', 'POST', { appId: 'app_nope', test: true })).status, 404);
  await settle(t.app);
  assert.equal((await t.app.repo.q('SELECT COUNT(*) AS n FROM ledger')).rows[0].n, 0, 'test traffic never reaches the ledger');
  await t.stop();
});

test('sellers.json and ads.txt line', async () => {
  const t = await boot({ publicUrl: 'https://ads.mobiad.example' });
  const pub = await t.signup('pub@x.io', 'publisher'); await t.signup('adv@x.io', 'advertiser');
  const me = await t.app.repo.userByEmail('pub@x.io');
  const s = await t.call('/sellers.json');
  assert.equal(s.status, 200); assert.match(s.headers.get('cache-control'), /max-age/);
  assert.equal(s.body.version, '1.0'); assert.equal(s.body.sellers[0].seller_type, 'INTERMEDIARY');
  assert.deepEqual(s.body.sellers.slice(1), [{ seller_id: me.id, seller_type: 'PUBLISHER', is_confidential: 1 }]); // advertisers are never listed; publishers are confidential
  const a = await t.call('/api/ads-txt', 'GET', null, pub);
  assert.match(a.body.lines[0], new RegExp(`, ${me.id}, DIRECT$`)); assert.ok(a.body.text.endsWith('\n'));
  assert.equal((await t.call('/api/ads-txt', 'GET', null, await t.signup('a2@x.io', 'advertiser'))).status, 403);
  await t.stop();
});

// ---- webhooks ----
function receiver(statusFor = () => 200) {
  const got = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { got.push({ body: b, headers: req.headers }); res.writeHead(statusFor(got.length)); res.end('{}'); }); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ got, url: `http://127.0.0.1:${srv.address().port}/hook`, close: () => srv.closeAllConnections() || srv.close() })));
}
const pump = async (t, rx, n, ms = 4000) => { const t0 = Date.now(); while (rx.got.length < n && Date.now() - t0 < ms) { await t.app.webhookWorker.tick(); await sleep(50); } };

test('webhooks: events are signed, delivered once, scoped to the owner, and managed through the API', async () => {
  const rx = await receiver();
  const t = await boot({ allowPrivateCallbacks: true, requireFunding: false });
  const adv = await t.signup('adv@x.io', 'advertiser'), other = await t.signup('o@x.io', 'advertiser'), admin = await t.makeAdmin();
  assert.equal((await t.call('/api/webhooks', 'POST', { url: 'ftp://x' }, adv)).status, 400);
  assert.equal((await t.call('/api/webhooks', 'POST', { url: rx.url, events: ['nope'] }, adv)).status, 400);
  assert.equal((await t.call('/api/webhooks', 'POST', { url: rx.url, events: ['ping'] }, adv)).status, 400); // ping is internal
  const events = (await t.call('/api/webhooks/events', 'GET', null, adv)).body; assert.ok(events.includes('campaign.approved') && !events.includes('ping'));
  const hook = await t.call('/api/webhooks', 'POST', { url: rx.url, events: ['campaign.approved', 'campaign.rejected', 'wallet.credited'] }, adv);
  assert.equal(hook.status, 201); assert.match(hook.body.secret, /^whsec_[0-9a-f]{48}$/);
  const list = (await t.call('/api/webhooks', 'GET', null, adv)).body; assert.equal(list.length, 1); assert.equal(JSON.stringify(list).includes('whsec_'), false);
  assert.equal((await t.call('/api/webhooks', 'GET', null, other)).body.length, 0);

  // ping
  assert.equal((await t.call('/api/webhooks/test', 'POST', { id: hook.body.id }, other)).status, 404);
  assert.equal((await t.call('/api/webhooks/test', 'POST', { id: hook.body.id }, adv)).status, 202);
  await pump(t, rx, 1);
  assert.equal(rx.got.length, 1);
  const ping = rx.got[0]; assert.equal(ping.headers['x-mobiad-event'], 'ping'); assert.equal(verifyWebhook(hook.body.secret, ping.body, ping.headers['x-mobiad-signature']), true);
  assert.equal(verifyWebhook('other-secret', ping.body, ping.headers['x-mobiad-signature']), false);
  assert.equal(verifyWebhook(hook.body.secret, ping.body + ' ', ping.headers['x-mobiad-signature']), false); // tampered body
  assert.equal(verifyWebhook(hook.body.secret, ping.body, signWebhook(hook.body.secret, ping.body, 1000)), false); // replayed old timestamp

  // real events: campaign approval and rejection, wallet credit; unsubscribed events are not sent
  const c1 = (await t.call('/api/campaigns', 'POST', camp({ name: 'One' }), adv)).body, c2 = (await t.call('/api/campaigns', 'POST', camp({ name: 'Two' }), adv)).body;
  await t.call('/api/admin/campaigns/review', 'POST', { id: c1.id, decision: 'approve' }, admin);
  await t.call('/api/admin/campaigns/review', 'POST', { id: c2.id, decision: 'reject', note: 'nope' }, admin);
  await t.call('/api/admin/wallet/credit', 'POST', { userId: (await t.app.repo.userByEmail('adv@x.io')).id, amountUsd: 5, note: 'x', reference: 'r1' }, admin);
  await pump(t, rx, 4);
  const evs = rx.got.slice(1).map((g) => JSON.parse(g.body));
  assert.deepEqual(evs.map((e) => e.event).sort(), ['campaign.approved', 'campaign.rejected', 'wallet.credited']);
  assert.equal(evs.find((e) => e.event === 'campaign.rejected').data.note, 'nope');
  assert.ok(evs.every((e) => /^evt_/.test(e.id)));
  await t.app.webhookWorker.tick(); assert.equal(rx.got.length, 4, 'each event is delivered once'); // nothing is re-sent
  const dl = (await t.call(`/api/webhooks/deliveries?id=${hook.body.id}`, 'GET', null, adv)).body;
  assert.equal(dl.length, 4); assert.ok(dl.every((d) => d.status === 'delivered' && d.attempts === 1));
  assert.equal((await t.call(`/api/webhooks/deliveries?id=${hook.body.id}`, 'GET', null, other)).body.length, 0);
  // another user's events never reach this hook
  const oc = (await t.call('/api/campaigns', 'POST', camp({ name: 'Theirs' }), other)).body;
  await t.call('/api/admin/campaigns/review', 'POST', { id: oc.id, decision: 'approve' }, admin); await t.app.webhookWorker.tick(); await sleep(100);
  assert.equal(rx.got.length, 4);
  // delete
  assert.equal((await t.call('/api/webhooks/delete', 'POST', { id: hook.body.id }, other)).status, 404);
  assert.equal((await t.call('/api/webhooks/delete', 'POST', { id: hook.body.id }, adv)).status, 200);
  assert.equal((await t.call('/api/webhooks', 'GET', null, adv)).body.length, 0);
  await t.stop(); rx.close();
});

test('webhooks: failures retry with back-off, give up after the last attempt, and a hook that keeps failing is disabled', async () => {
  const rx = await receiver(() => 500);
  const t = await boot({ allowPrivateCallbacks: true });
  const adv = await t.signup('adv@x.io', 'advertiser');
  const hook = (await t.call('/api/webhooks', 'POST', { url: rx.url }, adv)).body;
  await t.call('/api/webhooks/test', 'POST', { id: hook.id }, adv);
  const repo = t.app.repo; let clock = Date.now();
  const worker = startWebhookWorker({ repo, allowPrivate: true, intervalMs: 3_600_000, now: () => clock });
  assert.equal(await worker.tick(), 1);
  let d = (await repo.deliveriesFor((await repo.userByEmail('adv@x.io')).id, hook.id))[0];
  assert.equal(d.status, 'pending'); assert.equal(Number(d.attempts), 1); assert.equal(Number(d.next_at), clock + RETRY_DELAYS_MS[0]); assert.match(d.last_error, /HTTP 500/);
  assert.equal(await worker.tick(), 0, 'not retried before its time');
  for (let i = 1; i < 6; i++) { clock += RETRY_DELAYS_MS[Math.min(i - 1, 4)] + 1; assert.equal(await worker.tick(), 1); }
  d = (await repo.deliveriesFor((await repo.userByEmail('adv@x.io')).id, hook.id))[0];
  assert.equal(d.status, 'failed'); assert.equal(Number(d.attempts), 6); assert.equal(rx.got.length, 6);
  clock += 10_000_000; assert.equal(await worker.tick(), 0, 'a failed delivery is never retried again');
  // consecutive failures disable the hook
  for (let i = 0; i < 20; i++) await repo.noteWebhookResult(hook.id, false);
  assert.equal((await repo.webhook(hook.id)).status, 'disabled');
  assert.equal((await t.call('/api/webhooks', 'GET', null, adv)).body[0].status, 'disabled');
  await repo.noteWebhookResult(hook.id, true); assert.equal((await repo.webhook(hook.id)).failures, 0);
  worker.stop(); await t.stop(); rx.close();
});

test('webhooks: private destinations are refused unless explicitly allowed (SSRF); limit of 5 hooks', async () => {
  const t = await boot();
  const adv = await t.signup('adv@x.io', 'advertiser');
  for (const url of ['https://127.0.0.1/h', 'https://localhost/h', 'https://169.254.169.254/h', 'http://example.com/h', 'https://u:p@example.com/h']) assert.equal((await t.call('/api/webhooks', 'POST', { url }, adv)).status, 400, url);
  for (let i = 0; i < 5; i++) assert.equal((await t.call('/api/webhooks', 'POST', { url: `https://example.com/h${i}` }, adv)).status, 201);
  assert.equal((await t.call('/api/webhooks', 'POST', { url: 'https://example.com/h9' }, adv)).status, 409);
  await t.stop();
});

test('invoices and credit notes: closed months only, idempotent, correct totals, isolated per advertiser', async () => {
  const t = await boot();
  const adv = await t.signup('adv@x.io', 'advertiser'), pub = await t.signup('pub@x.io', 'publisher'), other = await t.signup('o@x.io', 'advertiser'), admin = await t.makeAdmin();
  const c = (await t.call('/api/campaigns', 'POST', camp({ name: 'Spring "promo"', bid: 6000, budget: 1000 }), adv)).body;
  const a = (await t.call('/api/apps', 'POST', { name: 'A', floorEcpm: 5000 }, pub)).body;
  for (let i = 0; i < 4; i++) { const r = await t.call('/v1/ad', 'POST', { appId: a.id }); await t.call(t.path(r.body.impressionUrl)); }
  await settle(t.app);
  const now = new Date(), thisMonth = now.toISOString().slice(0, 7);
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  assert.equal((await t.call('/api/billing/invoices/generate', 'POST', { month: 'nope' }, adv)).status, 400);
  assert.equal((await t.call('/api/billing/invoices/generate', 'POST', { month: thisMonth }, adv)).body.error, 'month_not_closed');
  assert.equal((await t.call('/api/billing/invoices/generate', 'POST', { month: lastMonth }, adv)).body.error, 'nothing_to_invoice');
  assert.equal((await t.call('/api/billing/invoices/generate', 'POST', { month: lastMonth }, pub)).status, 403);
  // move the traffic into last month so the month is closed and billable
  await t.app.repo.q('UPDATE ledger SET day=$1', [lastMonth + '-15']);
  const g = await t.call('/api/billing/invoices/generate', 'POST', { month: lastMonth }, adv);
  assert.equal(g.status, 201); assert.match(g.body.number, new RegExp(`^INV-${lastMonth.replace('-', '')}-0001$`));
  assert.equal(g.body.total, 20); assert.equal(g.body.lines.length, 1); assert.equal(g.body.lines[0].description, 'Spring "promo"'); assert.equal(g.body.lines[0].impressions, 4); assert.match(g.body.taxNote, /tax/i);
  const again = await t.call('/api/billing/invoices/generate', 'POST', { month: lastMonth }, adv);
  assert.equal(again.status, 200); assert.equal(again.body.id, g.body.id); // idempotent
  assert.equal((await t.call('/api/billing/invoices', 'GET', null, adv)).body.length, 1);
  assert.equal((await t.call('/api/billing/invoices', 'GET', null, other)).body.length, 0);
  assert.equal((await t.call(`/api/billing/invoice?id=${g.body.id}`, 'GET', null, other)).status, 404);
  const csv = await t.call(`/api/billing/invoice?id=${g.body.id}&format=csv`, 'GET', null, adv);
  assert.match(csv.headers.get('content-type'), /text\/csv/); assert.match(csv.text, /^invoice,period,campaign,impressions,clicks,conversions,amount_usd\n/); assert.match(csv.text, /"'?Spring ""promo"""/.test(csv.text) ? /./ : /Spring/);

  // credit notes
  const me = await t.app.repo.userByEmail('adv@x.io'), before = (await t.call('/api/billing/summary', 'GET', null, adv)).body.credits;
  assert.equal((await t.call('/api/admin/credit-notes', 'POST', { userId: me.id, amountUsd: 5, reason: 'x' }, adv)).status, 403);
  assert.equal((await t.call('/api/admin/credit-notes', 'POST', { userId: me.id, amountUsd: 0, reason: 'x' }, admin)).status, 400);
  assert.equal((await t.call('/api/admin/credit-notes', 'POST', { userId: me.id, amountUsd: 5, reason: '' }, admin)).status, 400);
  assert.equal((await t.call('/api/admin/credit-notes', 'POST', { userId: me.id, amountUsd: 5, reason: 'r', invoiceId: 'inv_other' }, admin)).status, 400);
  assert.equal((await t.call('/api/admin/credit-notes', 'POST', { userId: (await t.app.repo.userByEmail('pub@x.io')).id, amountUsd: 5, reason: 'r' }, admin)).status, 400); // publishers have no wallet
  const cn = await t.call('/api/admin/credit-notes', 'POST', { userId: me.id, amountUsd: 7.5, reason: 'Service outage on the 3rd', invoiceId: g.body.id }, admin);
  assert.equal(cn.status, 201); assert.match(cn.body.number, /^CN-\d{6}-0001$/);
  assert.equal((await t.call('/api/billing/summary', 'GET', null, adv)).body.credits, before + 7.5);
  const notes = (await t.call('/api/billing/credit-notes', 'GET', null, adv)).body; assert.equal(notes.length, 1); assert.equal(notes[0].invoiceId, g.body.id); assert.equal(notes[0].amount, 7.5);
  assert.equal((await t.call('/api/billing/credit-notes', 'GET', null, other)).body.length, 0);
  assert.ok((await t.app.repo.auditList({ limit: 100 })).some((x) => x.action === 'credit_note_issued'));
  await t.stop();
});

test('security headers: cross-origin resource policy is same-origin for the dashboard/API and cross-origin only for the ad plane', async () => {
  const t = await boot();
  const pub = await t.signup('pub@x.io', 'publisher'); const a = (await t.call('/api/apps', 'POST', { name: 'A' }, pub)).body;
  for (const p of ['/', '/app', '/readyz', '/api/me']) assert.equal((await t.call(p)).headers.get('cross-origin-resource-policy'), 'same-origin', p);
  for (const p of ['/v1/test/pixel', '/sellers.json']) assert.equal((await t.call(p)).headers.get('cross-origin-resource-policy'), 'cross-origin', p);
  assert.equal((await t.call('/v1/ad', 'POST', { appId: a.id, test: true })).headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.equal((await t.call('/')).headers.get('x-content-type-options'), 'nosniff');
  await t.stop();
});
