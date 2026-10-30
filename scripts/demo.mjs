// One-command investor demo: starts MobiAd locally with realistic, SIMULATED data and a gentle live traffic simulator.
//   node scripts/demo.mjs              -> http://localhost:8080   (Ctrl+C to stop; everything resets next start)
//   DEMO_EVENTS=12000 node scripts/demo.mjs     more history;  DEMO_LIVE=0 disables the live simulator
// All accounts, companies, apps and numbers are fictional test data. Never use this script or these credentials in production.
import http from 'node:http';
import os from 'node:os';
import { createApp } from '../src/server.js';
import { hashPw } from '../src/http.js';

const PORT = +process.env.PORT || 8080, BASE = `http://localhost:${PORT}`, PW = 'Demo-Pass-Phrase-2026', ADMIN_PW = 'Admin-Pass-Phrase-2026';
const EVENTS = +process.env.DEMO_EVENTS || 6000, LIVE = process.env.DEMO_LIVE !== '0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a), pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const ipv4 = () => `${Math.floor(rnd(11, 223))}.${Math.floor(rnd(0, 255))}.${Math.floor(rnd(0, 255))}.${Math.floor(rnd(1, 254))}`;

// A simulated external DSP so the unified auction visibly works (it bids on banners/interstitials).
const dsp = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => {
    if (req.method !== 'POST') { res.writeHead(200); return res.end(); }
    const j = JSON.parse(b || '{}');
    if (Math.random() < 0.35) { res.writeHead(204); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: j.id, cur: 'USD', seatbid: [{ bid: [{ impid: '1', price: +rnd(2.5, 9).toFixed(2), adm: '<a href="https://example.com/partner"><img alt="Partner ad" src="https://example.com/p.png"></a>', crid: 'sim-' + Math.floor(rnd(1, 99)), w: 320, h: 50 }] }] }));
  });
});
await new Promise((r) => dsp.listen(0, '127.0.0.1', r));

// Other devices (a real phone on the same Wi-Fi) cannot use "localhost": tracking links must carry this computer's network address.
// Private ranges are preferred (home/office Wi-Fi first, virtual adapters last). Override with DEMO_PUBLIC_URL (e.g. http://10.0.2.2:8080 for an Android emulator).
const lanRank = (a) => (/^192\.168\.65\./.test(a) ? 9 : /^192\.168\./.test(a) ? 0 : /^10\./.test(a) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 2 : 5);
const LAN_IPS = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')).map((i) => i.address).sort((a, b) => lanRank(a) - lanRank(b));
const PUBLIC = process.env.DEMO_PUBLIC_URL || (LAN_IPS[0] ? `http://${LAN_IPS[0]}:${PORT}` : BASE);
const app = await createApp({ port: PORT, publicUrl: PUBLIC, trustProxyHops: 1, allowPrivateCallbacks: true, autoApproveCampaigns: true, requireFunding: false, minPayoutUsd: 1, rateLimit: 1_000_000, demoMode: true, requireEmailVerification: false, inviteOnly: /^(1|true)$/i.test(process.env.INVITE_ONLY || ''), // off by default: anyone can sign up in the demo; set INVITE_ONLY=true to require invite codes
  // tax invoices on, with a clearly fictional seller and example rates (never real tax advice)
  taxMode: 'inclusive', taxLabel: 'VAT', taxRates: { GB: 20, IN: 18, DEFAULT: 0 }, taxReverseCharge: true,
  taxSeller: { name: 'MobiAd Demo Ltd (fictional)', address: '1 Example Street, London, UK', country: 'GB', taxId: 'GB000000000 (demo)' } });
app.setPublicUrl(PUBLIC);
const repo = app.repo;
await repo.createUser({ id: 'usr_dev_admin', email: 'admin@mobiad.test', role: 'admin', ...hashPw(ADMIN_PW), emailVerified: true });
await new Promise((r) => app.server.listen(PORT, r));

// Tracking URLs carry the PUBLIC url (10.0.2.2 for an emulator); this script runs on the host, so it talks to localhost instead.
const local = (u) => (typeof u === 'string' ? u.replace(PUBLIC, BASE) : u);
const call = async (p, m = 'GET', b, t, h = {}) => {
  const r = await fetch(BASE + p, { method: m, redirect: 'manual', headers: { 'content-type': 'application/json', 'x-forwarded-for': ipv4(), ...(t && { authorization: 'Bearer ' + t }), ...h }, body: b && JSON.stringify(b) });
  const ct = r.headers.get('content-type') || '';
  return { s: r.status, h: r.headers, b: r.status !== 204 && ct.includes('json') ? await r.json().catch(() => null) : null };
};
const adminLogin = async () => (await call('/api/login', 'POST', { email: 'admin@mobiad.test', password: ADMIN_PW })).b.token;
// private beta: sign-up needs an invite code, so the seeding script asks the admin API for one per account
const signup = async (email, role) => { const inv = (await call('/api/admin/invites', 'POST', { role, email, note: 'demo seed' }, await adminLogin())).b; return (await call('/api/signup', 'POST', { email, password: PW, role, acceptTerms: true, inviteCode: inv.code })).b.token; };

console.log('Seeding demo data...');
const adv = await signup('demo-advertiser@mobiad.test', 'advertiser'), adv2 = await signup('northwind-ads@mobiad.test', 'advertiser');
const pub = await signup('demo-publisher@mobiad.test', 'publisher'), pub2 = await signup('pixelforge-games@mobiad.test', 'publisher');
const admin = (await call('/api/login', 'POST', { email: 'admin@mobiad.test', password: ADMIN_PW })).b.token;
const advUser = await repo.userByEmail('demo-advertiser@mobiad.test'), adv2User = await repo.userByEmail('northwind-ads@mobiad.test');
for (const [u, usd] of [[advUser, 20000], [adv2User, 8000]]) await repo.addWalletEntry({ id: 'wal_demo_' + u.id, userId: u.id, kind: 'topup', amountMicros: usd * 1e6, provider: 'manual', providerRef: 'demo:' + u.id, note: 'Demo funding' });

const key = (await call('/api/keys', 'POST', { name: 'Conversion postback', scope: 'write' }, adv)).b.key;
const mk = async (token, o) => (await call('/api/campaigns', 'POST', { clickUrl: 'https://example.com/landing', countries: [], ...o }, token)).b;
const camps = {
  summer: await mk(adv, { name: 'Summer Sale 2026', model: 'CPM', bid: 7, budget: 2500, dailyBudget: 400, category: 'shopping', creatives: [{ title: 'Summer Sale: up to 50% off', cta: 'Shop now' }, { title: 'Last days of summer prices', cta: 'See deals' }, { title: 'Your summer wardrobe, sorted', cta: 'Browse' }] }),
  install: await mk(adv, { name: 'FitTrack App Install', model: 'CPC', bid: 0.45, budget: 1500, category: 'general', title: 'Train smarter. Install FitTrack', cta: 'Install' }),
  interstitial: await mk(adv, { name: 'Weekend Flash Sale (interstitial)', model: 'CPM', bid: 8, budget: 900, format: 'interstitial', title: 'Weekend flash sale: 40% off', body: 'Two days only', cta: 'Shop now', category: 'shopping' }),
  video: await mk(adv, { name: 'Product Story (video)', model: 'CPM', bid: 9, budget: 1800, format: 'video', videoUrl: `${PUBLIC}/media/hls/master.m3u8`, durationSec: 5, title: 'Meet the new collection', cta: 'Watch more', category: 'shopping' }),
  native: await mk(adv, { name: 'Recipe Box (native)', model: 'CPM', bid: 5, budget: 900, format: 'native', title: 'Dinner in 20 minutes', body: 'Fresh ingredients delivered weekly', sponsor: 'GreenLeaf Foods', rating: 4.7, cta: 'Try free', category: 'general' }),
  cpa: await mk(adv, { name: 'Checkout Conversions (CPA)', model: 'CPA', bid: 3.5, budget: 1200, conversionEvent: 'purchase', attributionDays: 7, title: 'Complete your order, free shipping today', category: 'shopping' }),
  brand: await mk(adv2, { name: 'Northwind Brand Awareness', model: 'CPM', bid: 4.5, budget: 2000, title: 'Northwind: built to last', category: 'general' }),
  casino: await mk(adv2, { name: 'Lucky Spin Promo', model: 'CPM', bid: 8, budget: 600, category: 'gambling', title: 'Spin to win' }), // restricted category -> waits in the admin review queue
};
const pubUser0 = await repo.userByEmail('demo-publisher@mobiad.test');
// Puzzle Quest gets a fixed id because the Android demo app is built with it (like a real integration's App ID)
await repo.createApp({ id: 'app_puzzlequest', owner: pubUser0.id, name: 'Puzzle Quest', platform: 'android', floorEcpm: 1, childDirected: false, blockedCategories: [] });
const apps = [
  { id: 'app_puzzlequest', name: 'Puzzle Quest' },
  (await call('/api/apps', 'POST', { name: 'FitTrack', platform: 'ios', floorEcpm: 1.5 }, pub)).b,
  (await call('/api/apps', 'POST', { name: 'Kids Colouring', platform: 'android', floorEcpm: 0.5, childDirected: true }, pub2)).b,
  (await call('/api/apps', 'POST', { name: 'Pixel Racer', platform: 'ios', floorEcpm: 2 }, pub2)).b,
];
const plc = (await call('/api/placements', 'POST', { appId: apps[0].id, name: 'Level complete', format: 'interstitial', floorEcpm: 2 }, pub)).b;
await call('/api/apps/reward', 'POST', { id: apps[0].id, callbackUrl: `http://127.0.0.1:${dsp.address().port}/reward`, amount: 50, item: 'coins' }, pub);
await call('/api/apps/reward', 'POST', { id: apps[3].id, callbackUrl: `http://127.0.0.1:${dsp.address().port}/reward`, amount: 50, item: 'coins' }, pub2);
await call('/api/admin/partners', 'POST', { name: 'Demo DSP (simulated)', endpointUrl: `http://127.0.0.1:${dsp.address().port}/bid`, formats: ['banner', 'interstitial'], timeoutMs: 200 }, admin);
await call('/api/webhooks', 'POST', { url: `http://127.0.0.1:${dsp.address().port}/webhook`, events: ['campaign.approved', 'payout.paid', 'wallet.credited'] }, adv);

// ---- history: generate events through the real ad server, then spread them over the last 14 days and the previous month ----
console.log(`Generating ${EVENTS} events through the real ad server...`);
const formats = [['banner', 62], ['interstitial', 8], ['video', 12], ['native', 10], ['rewarded', 8]];
const pickFormat = () => { let r = Math.random() * 100; for (const [f, w] of formats) { if ((r -= w) < 0) return f; } return 'banner'; };
const clicks = [];
async function oneRequest() {
  const a = pick(apps), format = a.childDirected ? 'banner' : pickFormat();
  const r = await call('/v1/ad', 'POST', { appId: a.id, format, country: pick(['US', 'US', 'US', 'GB', 'IN', 'DE', 'BR', 'CA']), language: 'en', deviceType: pick(['phone', 'phone', 'tablet']), osVersion: pick(['16.4', '17.2', '13', '14']), connection: pick(['wifi', 'wifi', 'cellular']), ...(format === 'rewarded' ? { userId: 'demo-user-' + Math.floor(rnd(1, 500)) } : {}), ...(Math.random() < 0.5 ? { placementId: a.id === apps[0].id ? plc.id : undefined } : {}) });
  if (r.s !== 200 || !r.b) return;
  await fetch(local(r.b.impressionUrl));
  if (r.b.viewableUrl && Math.random() < 0.72) await fetch(local(r.b.viewableUrl)); // the SDK measured the ad as viewable (50% on screen for 1 s)
  if (r.b.clickUrl && Math.random() < 0.07) clicks.push(local(r.b.clickUrl));
  if (r.b.videoCompleteUrl && Math.random() < 0.7) clicks.push({ video: local(r.b.videoCompleteUrl) });
}
for (let i = 0; i < EVENTS; i += 24) await Promise.all(Array.from({ length: Math.min(24, EVENTS - i) }, oneRequest));
await sleep(700); // a click must come a human moment after its impression
const convert = [];
for (const c of clicks) {
  if (typeof c === 'object') { await fetch(c.video); continue; }
  const r = await fetch(c, { redirect: 'manual', headers: { 'x-forwarded-for': ipv4() } });
  const id = new URL(r.headers.get('location') || 'https://x/').searchParams.get('mobiad_click_id');
  if (id && Math.random() < 0.3) convert.push(id);
}
for (const clickId of convert) await call('/v1/conversion', 'POST', { clickId, event: 'purchase', eventId: 'ord-' + Math.random().toString(36).slice(2, 8), value: +rnd(12, 140).toFixed(2) }, key);
await app.ledger.flush(5000);

// spread the history: heavier towards today, and ~15% in the previous month (so an invoice exists)
const rows = (await repo.q('SELECT id FROM ledger')).rows.map((r) => Number(r.id));
const dayOf = (offset) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
const buckets = new Map();
for (const id of rows) {
  const u = Math.random(); const off = u < 0.15 ? 32 + Math.floor(rnd(0, 10)) : Math.floor(Math.pow(Math.random(), 1.6) * 14);
  const d = dayOf(off); if (!buckets.has(d)) buckets.set(d, []); buckets.get(d).push(id);
}
for (const [d, ids] of buckets) for (let i = 0; i < ids.length; i += 500) await repo.q(`UPDATE ledger SET day=$1 WHERE id IN (${ids.slice(i, i + 500).map(Number).filter(Number.isFinite).join(',')})`, [d]); // ids are our own integers

// ---- back office: invoice, payouts, KYC queue ----
const lastMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
await repo.q("UPDATE ledger SET day=$1 WHERE id IN (SELECT id FROM ledger WHERE day < $2 ORDER BY id LIMIT 600)", [lastMonth + '-12', dayOf(14)]).catch(() => {});
await call('/api/billing/profile', 'POST', { legalName: 'Demo Advertiser Ltd', address: '12 Sample Road, London EC1A 1AA', country: 'GB', taxId: 'GB123456789' }, adv); // a tax invoice needs the buyer's details
await call('/api/billing/invoices/generate', 'POST', { month: lastMonth }, adv);
const pubUser = await repo.userByEmail('demo-publisher@mobiad.test'), pub2User = await repo.userByEmail('pixelforge-games@mobiad.test');
await call('/api/billing/payout-profile', 'POST', { legalName: 'Demo Publisher Ltd', country: 'GB', method: 'paypal', methodRef: 'payments@demo-publisher.example' }, pub);
for (const kind of ['kyc', 'tax']) { await call('/api/billing/payout-profile/submit', 'POST', { kind }, pub); await call('/api/admin/payout-profiles/review', 'POST', { userId: pubUser.id, kind, status: 'verified' }, admin); }
const bal = (await call('/api/billing/summary', 'GET', null, pub)).b;
const first = await call('/api/billing/payout', 'POST', { amountUsd: Math.max(1, Math.floor(bal.payable * 0.4)) }, pub);
if (first.b?.id) { await call('/api/admin/payouts/resolve', 'POST', { id: first.b.id, status: 'approved' }, admin); await call('/api/admin/payouts/resolve', 'POST', { id: first.b.id, status: 'paid', reference: 'PAYPAL-DEMO-48213' }, admin); }
await call('/api/billing/payout', 'POST', { amountUsd: Math.max(1, Math.floor(bal.payable * 0.2)) }, pub); // waiting for the admin
await call('/api/billing/payout-profile', 'POST', { legalName: 'PixelForge Games Inc', country: 'US', method: 'bank', methodRef: 'bank ending 4821' }, pub2);
await call('/api/billing/payout-profile/submit', 'POST', { kind: 'kyc' }, pub2); // sits in the admin review queue
void pub2User;
await call('/api/admin/apps/flag', 'POST', { id: apps[3].id, flagged: false }, admin);
await app.ledger.flush(5000); await app.catalog.refresh();

console.log(`
============================================================
 MobiAd investor demo is running:  ${BASE}
   Website   ${BASE}/          Dashboard ${BASE}/app          Help ${BASE}/help
 FROM A PHONE OR ANOTHER COMPUTER (same Wi-Fi), use this address instead of localhost:
   ${PUBLIC}${LAN_IPS.length > 1 && !process.env.DEMO_PUBLIC_URL ? '    (other addresses of this computer: ' + LAN_IPS.slice(1).join(', ') + ')' : ''}
   Open the dashboard at ${PUBLIC}/app so the integration code shows the address your phone must use.
   Check the connection from any device:  node scripts/selfcheck.mjs ${PUBLIC} <App ID>   (Windows may ask to allow Node through the firewall: choose Allow)
 Logins (all fictional):
   Advertiser  demo-advertiser@mobiad.test   ${PW}
   Publisher   demo-publisher@mobiad.test    ${PW}
   Admin       admin@mobiad.test             ${ADMIN_PW}
 Extra: northwind-ads@mobiad.test (advertiser 2), pixelforge-games@mobiad.test (publisher 2), same password
 Live traffic simulator: ${LIVE ? 'ON (new impressions every few seconds)' : 'off'}.  Stop with Ctrl+C.
============================================================`);

if (LIVE) {
  setInterval(() => { for (let i = 0; i < 3; i++) oneRequest().catch(() => {}); if (Math.random() < 0.4 && clicks.length) { const c = clicks.pop(); if (typeof c === 'string') fetch(c, { redirect: 'manual', headers: { 'x-forwarded-for': ipv4() } }).catch(() => {}); } }, 2500).unref?.();
  setInterval(() => { clicks.length = 0; }, 60_000).unref?.();
}
process.on('SIGINT', async () => { console.log('\nStopping...'); await app.close().catch(() => {}); dsp.close(); process.exit(0); });
