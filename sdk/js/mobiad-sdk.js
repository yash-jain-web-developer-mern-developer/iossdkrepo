// MobiAd JavaScript SDK (browsers, React Native, Node 18+). Zero dependencies.
//
//   import { MobiAd } from './mobiad-sdk.js';
//   const ads = new MobiAd({ appId: 'app_…', baseUrl: 'https://ads.example.com' });
//   const ad = await ads.requestAd({ format: 'banner', country: 'US', consent: { gdpr: false } });
//   if (ad) { render(ad.creative); ad.onShown(); /* when the ad is actually visible */ button.onclick = () => ad.onClicked(); }
//
// The SDK enforces the rules the ad server relies on, so integrators cannot accidentally generate invalid traffic:
//   • the impression is reported at most once, and only when you call onShown();
//   • a click is only reported after the impression and not sooner than minClickDelayMs (humans cannot tap instantly);
//   • no device identifier is sent unless you pass one AND consent allows it (never for child-directed apps / COPPA).
// Tracking calls retry with backoff; a failure never throws into your UI.

const DEFAULTS = { timeoutMs: 4000, retries: 2, minClickDelayMs: 500 };

export class MobiAd {
  /** @param {{ appId: string, baseUrl: string, fetch?: typeof fetch, timeoutMs?: number, retries?: number, minClickDelayMs?: number, onError?: (e: Error) => void }} opts */
  constructor(opts) {
    if (!opts?.appId) throw new Error('appId is required');
    if (!opts?.baseUrl || !/^https?:\/\//.test(opts.baseUrl)) throw new Error('baseUrl must be an http(s) URL');
    this.appId = opts.appId;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.cfg = { ...DEFAULTS, ...Object.fromEntries(['timeoutMs', 'retries', 'minClickDelayMs'].filter((k) => opts[k] != null).map((k) => [k, opts[k]])) };
    this.fetch = opts.fetch || globalThis.fetch?.bind(globalThis); // bound: browsers throw "Illegal invocation" when fetch is called as a method of another object
    this.onError = opts.onError || (() => {});
    if (typeof this.fetch !== 'function') throw new Error('no fetch available; pass opts.fetch');
  }

  /**
   * Request an ad. Resolves to an Ad, or null when there is no fill (HTTP 204). Rejects only on programmer errors;
   * network failures resolve to null so a missing ad never breaks the host app.
   * @param {{ format?: 'banner'|'interstitial'|'native'|'video'|'playable'|'rewarded', country?: string, deviceId?: string, placementId?: string, language?: string, deviceType?: 'phone'|'tablet', osVersion?: string, connection?: 'wifi'|'cellular', userId?: string, test?: boolean, consent?: { gdpr?: boolean, gdprConsent?: string, coppa?: boolean, usPrivacy?: string, limitAdTracking?: boolean } }} [req]
   */
  async requestAd(req = {}) {
    const body = { appId: this.appId, format: req.format || 'banner' };
    if (req.country) body.country = String(req.country).toUpperCase().slice(0, 2);
    if (req.consent) body.consent = req.consent;
    if (req.deviceId) body.deviceId = req.deviceId; // the server ignores it unless consent and app settings allow
    for (const k of ['placementId', 'language', 'deviceType', 'osVersion', 'connection', 'userId']) if (req[k]) body[k] = String(req[k]); // targeting signals and (for rewarded ads) your own user id
    if (req.test === true) body.test = true;   // test mode: canned ads, no auction, no billing
    let res;
    try { res = await this._request(`${this.baseUrl}/v1/ad`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
    catch (e) { this.onError(e); return null; }
    if (res.status === 204) return null;
    if (!res.ok) { this.onError(new Error(`ad request failed: HTTP ${res.status}`)); return null; }
    const j = await res.json();
    return new Ad(this, j);
  }

  async _request(url, init, attempt = 0) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs);
    try {
      const r = await this.fetch(url, { ...init, signal: ctl.signal, redirect: init.redirect || 'follow' });
      if (r.status >= 500 && attempt < this.cfg.retries) throw new Error('server error ' + r.status);
      return r;
    } catch (e) {
      if (attempt >= this.cfg.retries) throw e;
      await new Promise((r) => setTimeout(r, 200 * 2 ** attempt)); // 200 ms, 400 ms, …
      return this._request(url, init, attempt + 1);
    } finally { clearTimeout(timer); }
  }
}

/** Minimal VAST reader: the playable file of a partner video ad (HLS preferred, then MP4/WebM). Only http(s) files; otherwise null. */
export function vastMediaUrl(vast) {
  const files = []; const re = /<MediaFile((?: [^>]*)?)>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/MediaFile>/gi; let m;
  while ((m = re.exec(String(vast || '')))) if (/^https?:\/\//i.test(m[2])) files.push([m[1].toLowerCase(), m[2]]);
  const ext = (u) => u.split('?')[0].toLowerCase();
  return (files.find(([t, u]) => t.includes('mpegurl') || ext(u).endsWith('.m3u8')) || files.find(([t, u]) => t.includes('mp4') || ext(u).endsWith('.mp4')) || files[0] || [])[1] || null;
}

export class Ad {
  constructor(sdk, j) {
    this.sdk = sdk;
    this.test = !!j.test;                // true for test-mode ads
    this.external = j.external || null;  // partner demand: { markup: 'html'|'vast', adm, width?, height? } - render ONLY in a sandboxed iframe/WebView
    this.reward = j.reward || null;      // rewarded slots: { amount, item }; grant it only after your server receives the signed reward callback
    this.creative = j.creative || null;           // { title, image, videoUrl?, durationSec?, playableUrl?, cta? } - render playableUrl ONLY in a sandboxed iframe/WebView
    this._urls = { impression: j.impressionUrl, click: j.clickUrl, install: j.installUrl, videoComplete: j.videoCompleteUrl, viewable: j.viewableUrl };
    this._shownAt = 0; this._clicked = false;
    this.vastMediaUrl = this.external?.markup === 'vast' ? vastMediaUrl(this.external.adm) : null; // partner VAST video: the file to play
  }
  /** Call when the ad is actually visible to the user. Idempotent. */
  async onShown() {
    if (this._shownAt) return true;
    this._shownAt = Date.now();
    try { const r = await this.sdk._request(this._urls.impression, { method: 'GET' }); return r.ok; }
    catch (e) { this.sdk.onError(e); return false; }
  }
  /**
   * Call when the user taps the ad. Returns the landing-page URL to open (or null if the click was not accepted by the SDK).
   * The click is reported to the server (which validates it); the SDK refuses clicks that could not be human.
   */
  async onClicked() {
    if (this.external) return null; // partner ads handle their own clicks inside the markup
    if (!this._shownAt) { this.sdk.onError(new Error('onClicked() before onShown(): ignored')); return null; }
    if (this._clicked) return null;
    const wait = this.sdk.cfg.minClickDelayMs - (Date.now() - this._shownAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this._clicked = true;
    try {
      const r = await this.sdk._request(this._urls.click, { method: 'GET', redirect: 'manual' });
      // The tracker answers 302 with the landing page; fetch exposes it as an opaque redirect in browsers, so also expose the tracker URL.
      return r.headers?.get?.('location') || this._urls.click;
    } catch (e) { this.sdk.onError(e); return null; }
  }
  /**
   * Report the impression only once the ad is really on screen: at least `threshold` (default 50%) of it visible for `durationMs`
   * (default 1 s) without interruption (the usual display-viewability rule). Resolves true after onShown(); resolves false if cancel() is called.
   * Needs IntersectionObserver (browsers, WebViews); pass opts.IntersectionObserver elsewhere.
   */
  reportWhenViewable(element, { threshold = 0.5, durationMs = 1000, IntersectionObserver: IO = globalThis.IntersectionObserver, setTimeout: st = globalThis.setTimeout, clearTimeout: ct = globalThis.clearTimeout } = {}) {
    let done, timer = null, obs = null;
    const finish = (v) => { if (timer) ct(timer); obs?.disconnect(); done(v); };
    const promise = new Promise((resolve) => { done = resolve; });
    if (typeof IO !== 'function') { this.sdk.onError(new Error('IntersectionObserver unavailable: reporting the impression immediately')); this.onShown().then(() => done(true)); return Object.assign(promise, { cancel() {} }); }
    obs = new IO((entries) => {
      const e = entries[entries.length - 1];
      if (e.isIntersecting && e.intersectionRatio >= threshold) { if (!timer) timer = st(() => { obs.disconnect(); this.onShown().then(() => this.onViewable()).then(() => done(true)); }, durationMs); }
      else if (timer) { ct(timer); timer = null; }
    }, { threshold: [0, threshold, 1] });
    obs.observe(element);
    return Object.assign(promise, { cancel: () => finish(false) });
  }
  /**
   * Viewability: once the impression was reported, fires the (unbilled) viewable event after >= 50% of the element was visible for 1 s in a row.
   * Same options as reportWhenViewable; resolves true when the server accepted it, false if cancelled or unsupported.
   */
  async onViewable() {
    if (!this._urls.viewable || !this._shownAt || this._viewable) return false;
    this._viewable = true;
    try { const r = await this.sdk._request(this._urls.viewable, { method: 'GET' }); return r.ok; } catch (e) { this.sdk.onError(e); return false; }
  }
  /** Call when a video ad has played to the end (video ads only). Idempotent. Never billed. */
  async onVideoComplete() {
    if (!this._urls.videoComplete || !this._shownAt || this._completed) return false;
    this._completed = true;
    try { const r = await this.sdk._request(this._urls.videoComplete, { method: 'GET' }); return r.ok; } catch (e) { this.sdk.onError(e); return false; }
  }
  /** Report an install attributed to this ad (call from your install/first-open flow). */
  async onInstalled() {
    try { const r = await this.sdk._request(this._urls.install, { method: 'GET' }); return r.ok; } catch (e) { this.sdk.onError(e); return false; }
  }
}
