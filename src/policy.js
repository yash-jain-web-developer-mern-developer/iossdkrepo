// Advertising policy: automated screening of campaign creatives and categories.
// Hard failures are rejected at submission (HTTP 400). Soft flags and restricted categories always go to manual review.

export const CATEGORIES = ['general', 'games', 'shopping', 'travel', 'education', 'entertainment', 'utilities', 'health', 'finance', 'gambling', 'adult', 'alcohol', 'tobacco', 'crypto', 'political'];
// These can never be auto-approved, and can never be shown in child-directed apps.
export const RESTRICTED = new Set(['gambling', 'adult', 'alcohol', 'tobacco', 'crypto', 'political', 'finance', 'health']);
export const NEVER_CHILD = new Set(['gambling', 'adult', 'alcohol', 'tobacco', 'crypto', 'political', 'finance']);

const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'rebrand.ly', 'cutt.ly', 'shorturl.at', 'rb.gy']);
const DEFAULT_KEYWORDS = ['free money', 'guaranteed returns', 'get rich quick', 'miracle cure', 'you have won', 'virus detected', 'your device is infected', 'click here to claim'];

function ipv4(host) { const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/); return m ? m.slice(1).map(Number) : null; }
export function isPrivateOrLocalHost(hostRaw) {
  const host = hostRaw.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return true;
  const ip = ipv4(host);
  if (ip) {
    const [a, b] = ip;
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (host.includes(':')) return true; // any IPv6 literal: not a legitimate advertiser landing page
  return false;
}

// Returns { hard: string[], soft: string[] }.
export const VIDEO_EXT = /\.(mp4|webm|m3u8)$/i, MAX_VIDEO_SEC = 60;

export function screenCreative({ clickUrl, image, name, title, category, videoUrl, playableUrl, durationSec, format, iconUrl, body, sponsor, rating }, { requireHttps = false, blockedDomains = [], blockedKeywords = DEFAULT_KEYWORDS, allowLocal = false } = {}) {
  const hard = [], soft = [];
  const checkUrl = (label, raw, required) => {
    if (!raw) { if (required) hard.push(`${label} is required`); return; }
    if (String(raw).length > 2048) { hard.push(`${label} is too long`); return; }
    let u; try { u = new URL(raw); } catch { hard.push(`${label} is not a valid URL`); return; }
    if (!['http:', 'https:'].includes(u.protocol)) { hard.push(`${label} must be http(s)`); return; }
    if (requireHttps && u.protocol !== 'https:') hard.push(`${label} must use https`);
    if (u.username || u.password) hard.push(`${label} must not contain credentials`);
    if (!allowLocal && isPrivateOrLocalHost(u.hostname)) hard.push(`${label} must not point to a private or local address`);
    const host = u.hostname.toLowerCase();
    if (blockedDomains.some((d) => host === d || host.endsWith('.' + d))) hard.push(`${label} domain is blocked`);
    if (label === 'clickUrl' && SHORTENERS.has(host)) soft.push('clickUrl uses a URL shortener');
    if (host.startsWith('xn--') || host.includes('.xn--')) soft.push(`${label} uses an internationalized (punycode) domain`);
  };
  checkUrl('clickUrl', clickUrl, true);
  checkUrl('image', image, false);
  checkUrl('iconUrl', iconUrl, false);
  if (iconUrl && !/^https:/i.test(iconUrl)) hard.push('iconUrl must use https');
  if (body != null && String(body).length > 200) hard.push('body must be at most 200 characters');
  if (sponsor != null && String(sponsor).length > 60) hard.push('sponsor must be at most 60 characters');
  if (rating != null && !(Number(rating) >= 0 && Number(rating) <= 5)) hard.push('rating must be between 0 and 5');
  if (format === 'native' && !(title || name)) hard.push('native ads need a headline');
  checkUrl('videoUrl', videoUrl, format === 'video');
  checkUrl('playableUrl', playableUrl, format === 'playable');
  const needHttps = (label, raw) => { if (!raw || /^https:/i.test(raw)) return; let local = false; try { local = allowLocal && isPrivateOrLocalHost(new URL(raw).hostname); } catch { /* reported above */ } if (!local) hard.push(`${label} must use https`); }; // local development servers (allowLocal) may serve rich media over plain http
  needHttps('videoUrl', videoUrl); needHttps('playableUrl', playableUrl); // rich media is always https (mixed content, tampering)
  if (videoUrl) {
    let p = ''; try { p = new URL(videoUrl).pathname; } catch { /* reported above */ }
    if (p && !VIDEO_EXT.test(p)) hard.push('videoUrl must point to an .mp4, .webm or .m3u8 file');
    const d = Number(durationSec);
    if (!(d > 0) || d > MAX_VIDEO_SEC) hard.push(`durationSec is required and must be 1-${MAX_VIDEO_SEC}`);
  }
  if (format === 'video' && !videoUrl) hard.push('format video requires videoUrl');
  if (format === 'playable' && !playableUrl) hard.push('format playable requires playableUrl');
  if (playableUrl) soft.push('playable ads run third-party code and always need manual review');
  if (!CATEGORIES.includes(category)) hard.push(`category must be one of: ${CATEGORIES.join(', ')}`);
  const text = `${name || ''} ${title || ''} ${body || ''}`.toLowerCase();
  for (const k of blockedKeywords) if (text.includes(k)) soft.push(`text contains flagged phrase "${k}"`);
  if (RESTRICTED.has(category)) soft.push(`category "${category}" requires manual review`);
  return { hard, soft };
}

// Decide initial review state for a new campaign.
export const initialReview = ({ soft }, { autoApprove }) => (soft.length === 0 && autoApprove ? 'approved' : 'pending');
