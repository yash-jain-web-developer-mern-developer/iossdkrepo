# Integrating MobiAd in an app

## What exists today
| Platform | Status |
|---|---|
| **JavaScript / TypeScript** (web, React Native, Node 18+) | ✅ `sdk/js/mobiad-sdk.js` + `.d.ts`, 6 tests against the real server |
| **Android (Kotlin/Java), iOS (Swift), Unity, Flutter** | ❌ **Not built.** The protocol below is everything a native SDK needs; each is roughly 200–400 lines. |

## 1. Get an App ID
Create a publisher account, verify your email, then **Add app** in the dashboard (declare if it is directed to children, and which ad categories to block). Copy the App ID.

## 2. JavaScript SDK
```js
import { MobiAd } from './mobiad-sdk.js';
const ads = new MobiAd({ appId: 'app_…', baseUrl: 'https://ads.example.com' });

const ad = await ads.requestAd({ format: 'banner', country: 'US',
  consent: { gdpr: false, coppa: false },          // pass what your consent platform reports
  deviceId: consentedAdId });                       // optional; ignored unless consent allows
if (ad) {
  show(ad.creative);                                // { title, image }
  await ad.onShown();                               // when the ad is ACTUALLY visible
  button.onclick = async () => { const url = await ad.onClicked(); if (url) open(url); };
}
```
The SDK guarantees: one impression per ad view; no click before `onShown()` or sooner than 500 ms after it; failures never throw into your UI; transient 5xx are retried with backoff.

## 3. Protocol (for native SDKs)
1. **Request**: `POST {base}/v1/ad` with JSON `{ appId, format, country, deviceId?, consent? }`.
   - `204` → no ad (show nothing / fall back). `200` → `{ creative:{title,image}, impressionUrl, clickUrl, installUrl }`. `404` unknown app, `429` rate limited.
2. **Impression**: when the ad is visible (viewability is the SDK's job), `GET impressionUrl` once. Retry on network error/5xx only; repeats are harmless but never billed twice.
3. **Click**: on user tap, `GET clickUrl` (do not follow the redirect automatically; read `Location` and open it in the system browser/custom tab). **Rules that avoid invalid-traffic flags:**
   - the impression must have been reported first;
   - ≥ 500 ms after the ad was shown;
   - never auto-click, never click from a hidden view, never re-send a click.
4. **Install** (optional): `GET installUrl` from your first-open/install attribution flow.
5. **Timeouts**: 4 s per request, 2 retries with 200 ms/400 ms backoff. Never block the UI thread; never crash the app on ad errors.

## 4. Consent and privacy requirements for SDK authors
- Send `consent` as you receive it from the platform CMP: `gdpr`, `gdprConsent` (IAB TCF string), `coppa`, `usPrivacy` (CCPA string), `limitAdTracking`.
- Send `deviceId` only if the user has not limited ad tracking **and** consent allows it. The server additionally ignores it for child-directed apps, COPPA, GDPR-without-consent and US opt-outs. It is hashed with the app and day and used only for frequency capping; it is never stored.
- iOS: honor App Tracking Transparency (do not send IDFA without authorization). Android: honor the user's ad-personalization setting.
- Declare MobiAd's data practices in your Play Data-safety form / App Store privacy labels (consult your counsel for the exact wording).

## 5. Testing your integration
Use a test publisher account against the staging environment; the dashboard shows impressions, clicks and **invalid clicks** per app, so a misbehaving integration is visible within minutes.

## 6. Rich formats and conversions
- **Video**: request `format: "video"`. The creative has `videoUrl`, `durationSec`, `cta`; call `onShown()` when playback starts and `onVideoComplete()` (JS/Kotlin/Swift) at the end. Completion is counted but never billed.
- **Playable**: request `format: "playable"`. Render `creative.playableUrl` ONLY in a sandboxed iframe / WebView (no same-origin, no file access, no top-level navigation).
- **Conversions**: every accepted click opens the advertiser's landing URL with `mobiad_click_id`. The advertiser's server sends it back to `POST /v1/conversion` with a write-scope API key (see the OpenAPI spec). SDKs do not need to do anything.

## 7. Rewarded video, partner ads, targeting signals, test mode, viewability
- **Targeting signals** (all optional): `language`, `deviceType` (phone|tablet), `osVersion`, `connection` (wifi|cellular), `placementId`. A campaign that targets a dimension only matches requests that send it.
- **Rewarded**: request `format: "rewarded"` with your own `userId`; the ad has `reward: { amount, item }`. Grant the reward only when your server receives MobiAd's signed callback (see the help center).
- **Partner ads**: when `ad.external` is set (markup `html` or `vast`) there is no `creative` and no click URL: render the markup in a sandboxed iframe/WebView without same-origin access, and still call `onShown()`.
- **Test mode**: `test: true` returns a canned ad for any format; nothing is auctioned, billed or recorded.
- **Viewability (JavaScript SDK)**: `ad.reportWhenViewable(element)` reports the impression only after 50% of the element has been visible for 1 second.
- **Consent (GDPR)**: send the TCF v2 string as `consent.gdprConsent` with `consent.gdpr = true`; without a valid string granting purpose 1, no device identifier is used.
