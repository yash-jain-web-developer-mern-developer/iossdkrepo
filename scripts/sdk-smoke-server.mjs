// Starts a throwaway MobiAd server with the fixtures the Kotlin and Swift smoke tests expect, and prints "<baseUrl> <appId>".
//   node scripts/sdk-smoke-server.mjs [port]      (stop it with Ctrl+C)
import { createApp } from '../src/server.js';
const port = Number(process.argv[2] || 8190), HOST = process.env.SMOKE_HOST || 'host.docker.internal'; // the name the SDK under test uses to reach this server (a Mac runner: 127.0.0.1)
const app = await createApp({ secret: 'smoke-secret-smoke-secret-smoke-secret-12', port, publicUrl: `http://${HOST}:${port}`, allowPrivateCallbacks: true, autoApproveCampaigns: true, requireFunding: false, requireEmailVerification: false, rateLimit: 1_000_000, catalogRefreshMs: 500 });
await new Promise((r) => app.server.listen(port, '0.0.0.0', r));
const base = `http://127.0.0.1:${port}`, PW = 'Sturdy-Horse-Battery-7';
const call = async (p, method = 'GET', body, token) => (await (await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: 'Bearer ' + token }) }, body: body && JSON.stringify(body) })).json());
const su = async (email, role) => (await call('/api/signup', 'POST', { email, password: PW, role })).token;
const adv = await su('adv@smoke.io', 'advertiser'), pub = await su('pub@smoke.io', 'publisher');
await call('/api/campaigns', 'POST', { name: 'Smoke banner', model: 'CPC', bid: 1, budget: 100, clickUrl: 'https://example.com/landing' }, adv);
await call('/api/campaigns', 'POST', { name: 'Smoke video', model: 'CPM', bid: 50, budget: 100, clickUrl: 'https://example.com/l', format: 'video', videoUrl: 'https://cdn.example.com/a.mp4', durationSec: 12, cta: 'Go' }, adv);
const a = await call('/api/apps', 'POST', { name: 'smoke' }, pub);
await new Promise((r) => setTimeout(r, 1200));
console.log(`READY http://${HOST}:${port} ${a.id}`);
