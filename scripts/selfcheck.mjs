// Connection and integration self-check. Run it from the computer or phone-side machine that will call MobiAd:
//   node scripts/selfcheck.mjs http://192.168.1.20:8080 app_xxxxxxxxxxxxxxxx
// It makes the same calls an app's SDK makes and says, step by step, what works and what to fix. Needs Node 18+, no installs.
const [base0, appId] = process.argv.slice(2);
if (!base0 || !appId) { console.log('Usage: node scripts/selfcheck.mjs <server address> <App ID>\n  e.g.  node scripts/selfcheck.mjs http://192.168.1.20:8080 app_0123456789abcdef'); process.exit(2); }
const base = base0.replace(/\/+$/, ''); let failed = 0, warned = 0;
const ok = (m) => console.log('  PASS  ' + m), bad = (m, fix) => { failed++; console.log('  FAIL  ' + m + (fix ? '\n        Fix: ' + fix : '')); }, warn = (m) => { warned++; console.log('  WARN  ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hit = async (url, init = {}) => { const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000); try { return await fetch(url, { ...init, signal: ctl.signal }); } finally { clearTimeout(t); } };
console.log(`MobiAd self-check\n  server: ${base}\n  app:    ${appId}\n`);

console.log('1. Can this machine reach the server?');
try { const r = await hit(base + '/healthz'); if (r.ok) ok('server answered /healthz'); else bad('server answered with HTTP ' + r.status, 'make sure the demo is running (start-demo.cmd) and the address is right'); }
catch (e) { bad('no answer from ' + base + ' (' + (e.name === 'AbortError' ? 'timed out' : e.message) + ')', 'use the phone address printed by the demo (not localhost); phone and computer must be on the same Wi-Fi; when Windows asks, allow Node.js through the firewall'); }
if (failed) { console.log('\nStopped: fix step 1 first.'); process.exit(1); }

console.log('\n2. Test ad (never billed, proves the App ID and the wiring)');
let r = await hit(base + '/v1/ad', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appId, format: 'banner', test: true }) }).catch((e) => ({ status: 0, err: e }));
if (r.status === 200) { const j = await r.json(); ok(`test ad received: "${j.creative?.title}"`); }
else bad('test ad request returned HTTP ' + r.status, r.status === 404 || r.status === 400 ? 'the App ID is not known to this server: copy it again from Publisher > Apps (the demo forgets everything when it restarts)' : 'check the server window for errors');

console.log('\n3. Real ad (this one is auctioned and billed)');
r = await hit(base + '/v1/ad', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appId, format: 'banner', country: 'US', language: 'en', deviceType: 'phone', osVersion: '14', connection: 'wifi' }) }).catch((e) => ({ status: 0, err: e }));
let ad = null;
if (r.status === 200) { ad = await r.json(); ok(ad.external ? 'a partner (outside bidder) ad won the auction' : `an advertiser ad won the auction: "${ad.creative?.title}"`); }
else if (r.status === 204) warn('no ad matched (HTTP 204 "no fill"). This is normal when no campaign targets this app, or all campaigns are paused or out of budget. Create a campaign as an advertiser (it is approved automatically in the demo) and run this again.');
else bad('ad request returned HTTP ' + r.status);

if (ad) {
  console.log('\n4. Tracking links (impression and click)');
  const host = (u) => { try { return new URL(u).host; } catch { return ''; } };
  const baseHost = host(base);
  for (const [k, u] of [['impressionUrl', ad.impressionUrl], ['clickUrl', ad.clickUrl]]) {
    if (!u) continue;
    if (/^(localhost|127\.)/.test(host(u)) && !/^(localhost|127\.)/.test(baseHost)) bad(`${k} points to ${host(u)}, which another device cannot reach`, 'restart the demo; it prints the phone address and uses it in links (or set DEMO_PUBLIC_URL to that address)');
    else if (host(u) !== baseHost) warn(`${k} uses ${host(u)} while you called ${baseHost}; that is fine only if both reach the same server`);
  }
  try { const imp = await hit(ad.impressionUrl); if (imp.status < 300) ok('impression recorded (HTTP ' + imp.status + ')'); else bad('impression link returned HTTP ' + imp.status); }
  catch (e) { bad('impression link unreachable (' + e.message + ')', 'the link host must be reachable from this machine'); }
  if (ad.clickUrl) {
    await sleep(700); // a click must come a human moment after the impression
    try { const c = await hit(ad.clickUrl, { redirect: 'manual' }); const loc = c.headers.get('location'); if (c.status === 302 && loc) ok('click accepted, advertiser landing page: ' + loc.slice(0, 70)); else warn('click answered HTTP ' + c.status + ' (a click can be rejected as invalid: for example repeated clicks from one device)'); }
    catch (e) { bad('click link unreachable (' + e.message + ')'); }
  }
}
console.log(`\n${failed ? 'RESULT: ' + failed + ' problem(s) to fix (see "Fix" lines above).' : 'RESULT: everything this check can see works.'}${warned ? ' ' + warned + ' note(s).' : ''}`);
if (!failed) console.log('Now open the dashboards: the publisher sees the impression under Apps, the advertiser sees spend under Overview.');
process.exit(failed ? 1 : 0);
