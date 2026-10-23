// Outbound HTTP to customer-supplied URLs (reward callbacks, webhooks, partner bidders) with SSRF protection:
// the hostname is resolved first, every address must be public, and the connection is pinned to the address we checked
// (so a DNS rebind between check and connect cannot reach an internal service). Redirects are never followed.
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isPrivateOrLocalHost } from '../policy.js';

export function isPrivateIp(ip) {
  const s = String(ip).toLowerCase();
  if (s.includes(':')) {
    if (s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb')) return true;
    const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); return m ? isPrivateOrLocalHost(m[1]) : false;
  }
  return isPrivateOrLocalHost(s);
}

export function validateOutboundUrl(raw, { allowPrivate = false, allowHttp = false } = {}) {
  let u; try { u = new URL(raw); } catch { return 'not a valid URL'; }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) return 'must be an https URL';
  if (u.username || u.password) return 'must not contain credentials';
  if (!allowPrivate && isPrivateOrLocalHost(u.hostname)) return 'must not point to a private or local address';
  if (String(raw).length > 2048) return 'is too long';
  return null;
}

// Returns { status, body }. Rejects on network error, timeout, oversized response, or private destination.
export async function safePost(rawUrl, { body, headers = {}, timeoutMs = 3000, allowPrivate = false, allowHttp = false, maxBytes = 262144, method = 'POST' } = {}) {
  const problem = validateOutboundUrl(rawUrl, { allowPrivate, allowHttp });
  if (problem) throw new Error('blocked: URL ' + problem);
  const u = new URL(rawUrl);
  const addrs = await dns.lookup(u.hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (!addrs.length) throw new Error('blocked: no address');
  if (!allowPrivate && addrs.some((a) => isPrivateIp(a.address))) throw new Error('blocked: resolves to a private address');
  const pick = addrs[0];
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request({ method, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || undefined, path: u.pathname + u.search, headers: { 'content-type': 'application/json', ...headers, ...(body != null ? { 'content-length': Buffer.byteLength(body) } : {}) },
      lookup: (_h, _o, cb) => cb(null, pick.address, pick.family), timeout: timeoutMs }, (res) => {
      const chunks = []; let n = 0;
      res.on('data', (d) => { n += d.length; if (n > maxBytes) { req.destroy(new Error('response too large')); return; } chunks.push(d); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}
