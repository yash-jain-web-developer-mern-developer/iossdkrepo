import { createHmac, scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
export const json = (res, code, body, extra = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...extra });
  res.end(code === 204 ? undefined : JSON.stringify(body));
};
export const readJson = (req, limit = 64 * 1024) => new Promise((ok, bad) => {
  let b = '', n = 0, over = false;
  req.on('data', (c) => { n += c.length; if (over) return; if (n > limit) { over = true; b = ''; } else b += c; }); // keep draining so we can answer 413
  req.on('end', () => {
    if (over) return bad(new Error('too large'));
    try { ok(b ? JSON.parse(b) : {}); } catch { bad(new Error('bad json')); }
  });
  req.on('error', bad);
});
// Behind a load balancer the socket address is the LB's. With TRUST_PROXY_HOPS=n we take the
// n-th entry from the right of X-Forwarded-For (the part appended by our own trusted proxies;
// anything further left is client-controlled and spoofable).
let trustedHops = 0;
export const setTrustedHops = (n) => { trustedHops = n; };
// Raw body (needed to verify webhook signatures byte-for-byte).
export const readRaw = (req, limit = 64 * 1024) => new Promise((ok, bad) => {
  let b = '', n = 0, over = false;
  req.on('data', (c) => { n += c.length; if (over) return; if (n > limit) { over = true; b = ''; } else b += c; });
  req.on('end', () => (over ? bad(new Error('too large')) : ok(b)));
  req.on('error', bad);
});
export const clientIp = (req) => {
  if (trustedHops > 0) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length >= trustedHops) return xff[xff.length - trustedHops];
  }
  return req.socket.remoteAddress || 'unknown';
};

// Minimal HS256 JWT (swap for OIDC / SSO in enterprise deployments).
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
export function jwtSign(claims, secret, ttlSec = 3600) {
  const h = enc({ alg: 'HS256', typ: 'JWT' }), p = enc({ ...claims, exp: Math.floor(Date.now() / 1000) + ttlSec });
  return `${h}.${p}.${createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`;
}
export function jwtVerify(t, secret) {
  const [h, p, s] = String(t).split('.');
  if (!h || !p || !s) return null;
  const good = createHmac('sha256', secret).update(`${h}.${p}`).digest(), got = Buffer.from(s, 'base64url');
  if (got.length !== good.length || !timingSafeEqual(got, good)) return null;
  const c = JSON.parse(Buffer.from(p, 'base64url').toString());
  return c.exp > Date.now() / 1000 ? c : null;
}
export const hashPw = (pw, salt = randomBytes(16).toString('hex')) => ({ salt, hash: scryptSync(pw, salt, 64).toString('hex') });
export const checkPw = (pw, u) => {
  const a = Buffer.from(scryptSync(pw, u.salt, 64).toString('hex')), b = Buffer.from(u.hash);
  return a.length === b.length && timingSafeEqual(a, b);
};
