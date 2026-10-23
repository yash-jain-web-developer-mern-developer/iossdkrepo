// Pure targeting rules beyond country/platform. Campaign `targeting` is a sanitized object:
//   { languages: ['en'], deviceTypes: ['phone'|'tablet'], connections: ['wifi'|'cellular'], minOs: 14, hours: [0..23] (UTC),
//     appAllow: [appId], appBlock: [appId] }
// Empty/missing lists mean "no restriction". A positive restriction on a signal the request did not send fails closed.
export const DEVICE_TYPES = ['phone', 'tablet'];
export const CONNECTIONS = ['wifi', 'cellular'];

const list = (v, max = 100) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length <= 64).slice(0, max) : []);

export function sanitizeTargeting(t = {}) {
  const out = {};
  const languages = list(t.languages, 30).map((x) => x.toLowerCase().slice(0, 2)).filter((x) => /^[a-z]{2}$/.test(x));
  if (languages.length) out.languages = [...new Set(languages)];
  const deviceTypes = list(t.deviceTypes).filter((x) => DEVICE_TYPES.includes(x)); if (deviceTypes.length) out.deviceTypes = [...new Set(deviceTypes)];
  const connections = list(t.connections).filter((x) => CONNECTIONS.includes(x)); if (connections.length) out.connections = [...new Set(connections)];
  const minOs = Number(t.minOs); if (Number.isFinite(minOs) && minOs > 0 && minOs < 1000) out.minOs = minOs;
  const hours = (Array.isArray(t.hours) ? t.hours : []).map(Number).filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);
  if (hours.length && hours.length < 24) out.hours = [...new Set(hours)].sort((a, b) => a - b);
  const allow = list(t.appAllow, 500), block = list(t.appBlock, 500);
  if (allow.length) out.appAllow = allow; if (block.length) out.appBlock = block;
  return out;
}

// "17.4.1" -> 17.4, "Android 13" -> 13. Returns NaN when unparseable.
export const osMajorMinor = (v) => { const m = String(v ?? '').match(/(\d+)(?:\.(\d+))?/); return m ? Number(m[1] + '.' + (m[2] || '0')) : NaN; };

// req: { appId, lang, deviceType, osVersion, connection, hourUtc }
export function targetingOk(t, req) {
  if (!t) return true;
  if (t.appBlock?.includes(req.appId)) return false;
  if (t.appAllow?.length && !t.appAllow.includes(req.appId)) return false;
  if (t.languages?.length && !t.languages.includes(String(req.lang || '').toLowerCase().slice(0, 2))) return false;
  if (t.deviceTypes?.length && !t.deviceTypes.includes(req.deviceType)) return false;
  if (t.connections?.length && !t.connections.includes(req.connection)) return false;
  if (t.minOs) { const v = osMajorMinor(req.osVersion); if (!(v >= t.minOs)) return false; }
  if (t.hours?.length && !t.hours.includes(req.hourUtc)) return false;
  return true;
}
