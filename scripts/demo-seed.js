// Seeds demo accounts + traffic into a running local server: node scripts/demo-seed.js [baseUrl]
// Logins: demo-advertiser@mobiad.test / demo-publisher@mobiad.test, password: Demo-Pass-Phrase-2026
const base = process.argv[2] || 'http://localhost:8080', pw = 'Demo-Pass-Phrase-2026';
const call = async (p, m = 'GET', b, t) => { const r = await fetch(base + p, { method: m, redirect: 'manual', headers: { 'content-type': 'application/json', ...(t && { authorization: 'Bearer ' + t }) }, body: b && JSON.stringify(b) }); return { s: r.status, b: r.status < 300 && r.status !== 204 && (r.headers.get('content-type') || '').includes('json') ? await r.json() : null }; };
const auth = async (email, role) => (await call('/api/signup', 'POST', { email, password: pw, role })).b?.token || (await call('/api/login', 'POST', { email, password: pw })).b.token;
const adv = await auth('demo-advertiser@mobiad.test', 'advertiser'), pub = await auth('demo-publisher@mobiad.test', 'publisher');
const camps = [['Summer Sale 2026', 'CPM', 6, 500], ['App Install Boost', 'CPC', 0.4, 300], ['Brand Awareness', 'CPM', 4, 800]];
for (const [name, model, bid, budget] of camps) await call('/api/campaigns', 'POST', { name, model, bid, budget, dailyBudget: budget / 5, clickUrl: 'https://example.com/' + name.split(' ')[0].toLowerCase(), countries: [] }, adv);
const apps = [['Puzzle Quest', 'android', 1], ['FitTrack', 'ios', 1.5]];
const created = []; for (const [name, platform, floorEcpm] of apps) created.push((await call('/api/apps', 'POST', { name, platform, floorEcpm }, pub)).b);
let imps = 0, clicks = 0;
for (let i = 0; i < 400; i++) {
  const app = created[i % created.length];
  const ad = await call('/v1/ad', 'POST', { appId: app.id, format: 'banner', country: 'US' }); if (!ad.b) continue;
  await fetch(ad.b.impressionUrl); imps++;
  if (Math.random() < 0.06) { await fetch(ad.b.clickUrl, { redirect: 'manual' }); clicks++; }
}
console.log(JSON.stringify({ impressions: imps, clicks, apps: created.map((a) => a.id) }));
