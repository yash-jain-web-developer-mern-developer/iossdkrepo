// IAB TCF v2 consent string (TC string) decoding: just the core segment, enough to answer "did the user consent to purpose N / vendor V?".
// A string that cannot be parsed is treated as NO consent. Encoding is provided so tests and tooling can build valid strings.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function toBits(b64url) {
  let bits = '';
  for (const ch of b64url) { const v = B64.indexOf(ch); if (v < 0) return null; bits += v.toString(2).padStart(6, '0'); }
  return bits;
}
const int = (bits, pos, len) => parseInt(bits.slice(pos, pos + len), 2);

export function parseTcString(str) {
  if (typeof str !== 'string' || str.length < 20 || str.length > 6000) return null;
  const core = str.split('.')[0], bits = toBits(core);
  if (!bits || bits.length < 230) return null;
  const version = int(bits, 0, 6);
  if (version !== 2) return null;
  const out = {
    version, created: int(bits, 6, 36) * 100, updated: int(bits, 42, 36) * 100, cmpId: int(bits, 78, 12), vendorListVersion: int(bits, 114, 12), tcfPolicyVersion: int(bits, 126, 6),
    purposesConsent: new Set(), purposesLI: new Set(), vendorConsents: new Set(),
  };
  for (let i = 0; i < 24; i++) { if (bits[152 + i] === '1') out.purposesConsent.add(i + 1); if (bits[176 + i] === '1') out.purposesLI.add(i + 1); }
  const maxVendor = int(bits, 213, 16), range = bits[229] === '1';
  if (!range) {
    if (bits.length < 230 + maxVendor) return null;
    for (let i = 0; i < maxVendor; i++) if (bits[230 + i] === '1') out.vendorConsents.add(i + 1);
  } else {
    let pos = 230; const n = int(bits, pos, 12); pos += 12;
    for (let k = 0; k < n; k++) {
      if (pos + 1 > bits.length) return null;
      const isRange = bits[pos] === '1'; pos += 1;
      if (isRange) { const a = int(bits, pos, 16), b = int(bits, pos + 16, 16); pos += 32; if (!(a >= 1 && b >= a && b <= maxVendor && b - a < 5000)) return null; for (let v = a; v <= b; v++) out.vendorConsents.add(v); }
      else { out.vendorConsents.add(int(bits, pos, 16)); pos += 16; }
    }
  }
  return out;
}

// May we store/access information on the device (purpose 1) for this request? vendorId 0 = do not check the vendor list.
export function tcfAllowsDeviceId(str, { vendorId = 0, purposes = [1] } = {}) {
  const t = parseTcString(str);
  if (!t) return false;
  if (!purposes.every((p) => t.purposesConsent.has(p))) return false;
  return vendorId ? t.vendorConsents.has(vendorId) : true;
}

// Test/tooling helper: build a version-2 TC string.
export function encodeTcString({ purposes = [], vendors = [], maxVendor = 0, cmpId = 7, now = Date.now() } = {}) {
  const w = (n, len) => Math.max(0, Math.floor(n)).toString(2).padStart(len, '0').slice(-len);
  const mv = maxVendor || Math.max(0, ...vendors);
  let bits = w(2, 6) + w(now / 100, 36) + w(now / 100, 36) + w(cmpId, 12) + w(1, 12) + w(1, 6) + w(0, 12) + w(1, 12) + w(2, 6) + w(1, 1) + w(0, 1) + w(0, 12);
  bits += Array.from({ length: 24 }, (_, i) => (purposes.includes(i + 1) ? '1' : '0')).join('') + '0'.repeat(24) + '0' + w(0, 12);
  bits += w(mv, 16) + '0' + Array.from({ length: mv }, (_, i) => (vendors.includes(i + 1) ? '1' : '0')).join('');
  while (bits.length % 6) bits += '0';
  let out = ''; for (let i = 0; i < bits.length; i += 6) out += B64[parseInt(bits.slice(i, i + 6), 2)];
  return out;
}
