import { createApp } from '../../src/server.js';
import { hashPw } from '../../src/http.js';
import { totpAt } from '../../src/auth/totp.js';

export const PW = 'Sturdy-Horse-Battery-7';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const human = () => sleep(450); // a person needs a moment between seeing an ad and tapping it

export async function boot(overrides = {}) {
  const app = await createApp({ secret: 'test-secret-test-secret-test-secret-1234', catalogRefreshMs: 60000, ...overrides });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  app.setPublicUrl(base);
  const call = async (path, method = 'GET', body, token, raw, headers = {}) => {
    const r = await fetch(path.startsWith('http') ? path : base + path, {
      method, redirect: 'manual',
      headers: { 'content-type': 'application/json', ...(token && { authorization: 'Bearer ' + token }), ...headers },
      body: raw ?? (body && JSON.stringify(body)),
    });
    const ct = r.headers.get('content-type') || '';
    const text = r.status === 204 ? '' : await r.text();
    return { status: r.status, headers: r.headers, text, body: ct.includes('json') && text ? JSON.parse(text) : text };
  };
  const signup = async (email, role) => (await call('/api/signup', 'POST', { email, password: PW, role })).body.token;
  const stop = async () => { app.server.closeAllConnections(); await app.close(); };
  // Create an admin directly in the database (admins can never be created through public signup).
  const makeAdmin = async (email = 'admin@mobiad.io') => {
    await app.repo.createUser({ id: 'usr_admin_' + Math.random().toString(36).slice(2, 8), email, role: 'admin', ...hashPw(PW), emailVerified: true });
    const r = await call('/api/login', 'POST', { email, password: PW });
    return r.body.token;
  };
  // Latest email sent to an address, and the one-time token inside its link (tokens travel in the URL fragment).
  const lastMail = (to) => [...app.mailer.outbox].reverse().find((m) => m.to === to);
  const tokenFrom = (to, kind) => { const m = lastMail(to)?.text.match(new RegExp(`#${kind}=([A-Za-z0-9_-]+)`)); return m && m[1]; };
  return { app, base, call, signup, stop, makeAdmin, lastMail, tokenFrom, path: (u) => u.slice(base.length) };
}
export const settle = (app) => app.ledger.flush(3000);
export const codeNow = (secret, offsetSteps = 0) => totpAt(secret, Date.now() + offsetSteps * 30_000);

// Run one ad request and optionally fire impression/click like a real SDK would.
export async function serve(t, appId, { imp = true, click = false, extra = {} } = {}) {
  const r = await t.call('/v1/ad', 'POST', { appId, format: 'banner', country: 'US', ...extra });
  if (r.status !== 200) return { status: r.status };
  if (imp) await t.call(t.path(r.body.impressionUrl));
  if (click) { await human(); return { status: 200, ad: r.body, click: await t.call(t.path(r.body.clickUrl)) }; }
  return { status: 200, ad: r.body };
}
