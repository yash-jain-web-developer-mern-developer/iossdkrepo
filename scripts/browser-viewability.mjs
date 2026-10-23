// Real-browser check of the JS SDK's viewability measurement (Chrome + IntersectionObserver) against a live MobiAd server.
//   CHROME="C:/Program Files/Google/Chrome/Application/chrome.exe" node scripts/browser-viewability.mjs
// Needs playwright-core (e.g. `npm i --no-save playwright-core`) and an installed Chrome. Exit code 1 on any failed check.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createApp } from '../src/server.js';

let chromium; try { ({ chromium } = createRequire(import.meta.url)('playwright-core')); } catch { ({ chromium } = await import(process.env.PLAYWRIGHT_CORE || '../../investor-guide/node_modules/playwright-core/index.mjs')); }
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', PORT = 8191, PW = 'Sturdy-Horse-Battery-7';
const app = await createApp({ secret: 'browser-secret-browser-secret-browser-1234', port: PORT, publicUrl: `http://127.0.0.1:${PORT}`, autoApproveCampaigns: true, requireFunding: false, requireEmailVerification: false, inviteOnly: false, rateLimit: 1_000_000, catalogRefreshMs: 300 });
await new Promise((r) => app.server.listen(PORT, '127.0.0.1', r));
const base = `http://127.0.0.1:${PORT}`;
const call = async (p, method = 'GET', body, token) => (await (await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: 'Bearer ' + token }) }, body: body && JSON.stringify(body) })).json());
const su = async (email, role) => (await call('/api/signup', 'POST', { email, password: PW, role, acceptTerms: true })).token;
const adv = await su('adv@b.io', 'advertiser'), pub = await su('pub@b.io', 'publisher');
await call('/api/campaigns', 'POST', { name: 'Browser camp', model: 'CPM', bid: 5, budget: 100, clickUrl: 'https://example.com/landing' }, adv);
const appId = (await call('/api/apps', 'POST', { name: 'web' }, pub)).id;
await new Promise((r) => setTimeout(r, 800));

let bad = 0; const check = (n, c, x = '') => { if (!c) bad++; console.log((c ? '  PASS ' : '  FAIL ') + n + (x ? ' | ' + x : '')); };
const browser = await chromium.launch({ executablePath: CHROME, headless: true }), page = await browser.newPage({ viewport: { width: 800, height: 600 } }); page.on('console', (m) => console.log('  [page]', m.text()));
const sdkSrc = readFileSync(new URL('../sdk/js/mobiad-sdk.js', import.meta.url), 'utf8');
await page.route(base + '/__t/**', (route) => route.request().url().endsWith('/sdk.js')
  ? route.fulfill({ contentType: 'text/javascript', body: sdkSrc })
  : route.fulfill({ contentType: 'text/html', body: `<body style="margin:0"><div id="top" style="height:120px">top</div><div id="spacer" style="height:2000px"></div><div id="far" style="height:100px;background:#ddd">far ad</div><div style="height:800px"></div>
    <script type="module">import { MobiAd } from '/__t/sdk.js'; window.sdk = new MobiAd({ appId: ${JSON.stringify(appId)}, baseUrl: ${JSON.stringify(base)}, minClickDelayMs: 0, onError: (e) => console.log('SDKERR ' + e.message) }); window.ready = true;</script></body>` }));
await page.goto(base + '/__t/page.html'); await page.waitForFunction(() => window.ready === true);
const stats = async () => { await app.ledger.flush(3000); const r = await call('/api/report', 'GET', null, adv); return r.total; };

// 1) an ad inside the viewport for over a second: counted as shown AND viewable
await page.evaluate(() => { const d = document.getElementById('top'); d.style.height = '200px'; });
const r1 = await page.evaluate(async () => { const ad = await window.sdk.requestAd({ format: 'banner' }); window.ad1 = ad; const t0 = performance.now(); const ok = await ad.reportWhenViewable(document.getElementById('top'), { durationMs: 1000 }); return { served: !!ad, ok, ms: Math.round(performance.now() - t0) }; });
check('banner served and the browser measured it as viewable', r1.served && r1.ok === true, r1.ms + ' ms');
check('viewability waited about one second, not less', r1.ms >= 950, r1.ms + ' ms');
let s = await stats(); check('server counted 1 impression and 1 viewable', s.impressions === 1 && s.viewables === 1, `impressions ${s.impressions}, viewables ${s.viewables}`);

// 2) an ad far below the fold is NOT reported while it is off screen
const p2 = page.evaluate(async () => { const ad = await window.sdk.requestAd({ format: 'banner' }); window.ad2 = ad; window.p2 = ad.reportWhenViewable(document.getElementById('far'), { durationMs: 1000 }); window.p2.then((v) => { window.p2v = v; }); return !!ad; });
check('second banner served', await p2);
await page.waitForTimeout(1600); s = await stats();
check('off-screen ad: no impression and no viewable counted', s.impressions === 1 && s.viewables === 1, `impressions ${s.impressions}, viewables ${s.viewables}`);
check('off-screen ad promise still pending', (await page.evaluate(() => window.p2v)) === undefined);

// 3) scroll it into view for less than a second, then away again: the timer resets, nothing is counted
await page.evaluate(() => document.getElementById('far').scrollIntoView({ block: 'center' })); await page.waitForTimeout(450);
await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(1500); s = await stats();
check('seen for under 1 s then scrolled away: nothing counted', s.impressions === 1 && s.viewables === 1, `impressions ${s.impressions}, viewables ${s.viewables}`);

// 4) scroll it in and keep it there: counted after the full second
await page.evaluate(() => document.getElementById('far').scrollIntoView({ block: 'center' }));
await page.waitForFunction(() => window.p2v === true, null, { timeout: 5000 }); s = await stats();
check('kept in view for a second: impression and viewable counted', s.impressions === 2 && s.viewables === 2, `impressions ${s.impressions}, viewables ${s.viewables}`);
check('viewability rate is 100% for two of two', Math.abs(s.viewability - 1) < 1e-9, String(s.viewability));

await browser.close(); app.server.closeAllConnections(); await app.close();
console.log(bad ? `\n${bad} FAILED` : '\nALL PASSED'); process.exit(bad ? 1 : 0);
