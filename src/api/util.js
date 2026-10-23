import { randomBytes, createHash } from 'node:crypto';

export const id = (p) => `${p}_${randomBytes(8).toString('hex')}`;
export const strs = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string').slice(0, 250) : []);
export const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]{2,}$/;
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const newOneTimeToken = () => randomBytes(32).toString('base64url');
export const microsToUsd = (m) => Math.round(m) / 1e6;
export const usdToMicros = (u) => Math.round(Number(u) * 1e6);
export const monthRe = /^\d{4}-(0[1-9]|1[0-2])$/;

const COMMON = new Set(['password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwertyuiop', 'qwerty123', 'iloveyou1', 'admin1234', 'welcome123', 'letmein123', 'abc12345', 'password1234', 'changeme123', 'passw0rd', 'p@ssw0rd', '11111111', '00000000']);
// Returns a human-readable problem or null. Length matters more than composition rules (NIST 800-63B).
export function passwordProblem(pw, email = '') {
  const p = String(pw || '');
  if (p.length < 10) return 'password must be at least 10 characters';
  if (p.length > 200) return 'password must be at most 200 characters';
  const lower = p.toLowerCase();
  if (COMMON.has(lower)) return 'password is too common';
  if (email && (lower.includes(email.split('@')[0].toLowerCase()) && email.split('@')[0].length >= 4)) return 'password must not contain your email name';
  if (/^(.)\1+$/.test(p)) return 'password is too repetitive';
  return null;
}

// CSV with formula-injection protection (campaign/app names are user-controlled and may be opened in Excel).
export function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export const toCsv = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
