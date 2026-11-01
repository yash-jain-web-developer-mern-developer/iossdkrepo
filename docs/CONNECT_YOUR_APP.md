# Connect your own app and phone to MobiAd (fresh start, no demo data)

This starts MobiAd **empty**: no demo advertisers, publishers, campaigns or apps. You create your own, then connect **your own Android or iOS app**
running on a phone that is plugged into your computer (or on the same Wi-Fi). Needs Node.js 20+ (18 works). No Docker, no database.

## 1. Start an empty server on your computer
```bash
npm ci
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long passphrase 123' npm start
```
Windows PowerShell: `$env:ADMIN_EMAIL='you@example.com'; $env:ADMIN_PASSWORD='a long passphrase 123'; npm start`

It prints `http://localhost:8080`. The first start creates your **admin** login from those two values (an admin can never sign up on the site).
Everything is stored in memory and is gone when you stop the server. For data that survives, set `DATABASE_URL=postgres://...` (see `docs/HANDOVER.md`).

## 2. Create your own accounts in the browser (http://localhost:8080)
1. **Advertiser:** Sign up (use one email), then **Wallet, add funds** (test mode adds fake credit instantly), then **Campaigns, New campaign** (any headline, a landing URL such as `https://example.com`, a bid and budget). In development it is approved automatically.
2. **Publisher:** log out, sign up with a second email as **Publisher**, open **Apps, Add app**, and copy the **App ID** (`app_...`).
3. **Admin (optional):** log in with `ADMIN_EMAIL` to see payouts, reviews and users.

## 3. Let your phone reach the server
The ad response contains tracking links built from `PUBLIC_URL`, so the phone must be able to open that address.

**Android over USB (simplest):** turn on Developer options and USB debugging, plug the phone in, check `adb devices`, then
```bash
adb reverse tcp:8080 tcp:8080
```
Leave the server on its default address. In your app use `http://localhost:8080`.

**Android or iPhone over Wi-Fi:** phone and computer on the same network. Start the server with the computer's address (the server prints it as `phoneOnSameWifi`):
```bash
PUBLIC_URL=http://192.168.1.5:8080 npm start        # replace with your computer's address
```
Use that same address in the app. On Windows allow Node through the firewall when asked.

**iOS simulator:** `http://localhost:8080` works directly.

Plain `http` is blocked by default on phones, which is fine for development only:
Android: add `android:usesCleartextTraffic="true"` to `<application>` in the manifest (and `<uses-permission android:name="android.permission.INTERNET" />`).
iOS: in Info.plist add `NSAppTransportSecurity` with `NSAllowsArbitraryLoads` = YES. Use https in production.

## 4. Add the SDK to your own app
**Android (Kotlin).** Copy `sdk/android/src/main/kotlin/io/mobiad/sdk/MobiAd.kt` and `ViewabilityTracker.kt` into your app (keep the package `io.mobiad.sdk`), or build the library with `cd sdk/android && gradle assembleRelease` (output `build/outputs/aar/`). A complete small example is in `sdk/android/examples/MinimalIntegration.kt`.
```kotlin
val ads = MobiAd(appId = "app_...", baseUrl = "http://localhost:8080")
Thread {                                   // SDK calls block: never on the main thread
    val ad = ads.requestAd(format = "banner", country = "US")
    runOnUiThread {
        if (ad == null) return@runOnUiThread
        titleView.text = ad.title
        Thread { ad.onShown() }.start()    // when the ad is really on screen
        button.setOnClickListener { Thread { ad.onClicked()?.let { url -> runOnUiThread { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } } }.start() }
        ViewabilityTracker(adView) { Thread { ad.onViewable() }.start() }.start()   // optional: 50% visible for 1 s
    }
}.start()
```
Video and rewarded ads: `ad.videoUrl` (play it with ExoPlayer or any player) then `ad.onVideoComplete()` when it ends; grant the reward only after your server receives MobiAd's signed reward callback.

**iOS (Swift).** Add the package folder `sdk/ios` in Xcode (File, Add Package Dependencies, Add Local), or copy `sdk/ios/Sources/MobiAd/MobiAd.swift` into your app.
```swift
import MobiAd
let ads = try MobiAd(appId: "app_...", baseUrl: "http://localhost:8080")
Task {
    guard let ad = await ads.requestAd(format: "banner", country: "US") else { return }
    titleLabel.text = ad.title
    await ad.onShown()                                    // when the ad is really on screen
    // on tap: if let url = await ad.onClicked() { UIApplication.shared.open(URL(string: url)!) }
}
```
Viewability: `ViewabilityTracker(view: adView) { Task { await ad.onViewable() } }.start()`. Video: `ad.videoUrl`, then `await ad.onVideoComplete()`.

**Web or React Native:** `sdk/js/mobiad-sdk.js` (see `docs/SDK_INTEGRATION.md`).

## 5. Check that it works
* Quick test without any campaign: `ads.requestAd(format: "banner", test: true)` returns a canned test ad.
* From the computer: `node scripts/selfcheck.mjs http://localhost:8080 app_...` makes the same calls an app does and says what to fix.
* Run your app on the phone. In the browser, the **advertiser Reports** page shows impressions, clicks and viewability, and the **publisher Earnings** page shows what the app earned.

## Notes
* Money is fake in this setup (`PAYMENTS_MODE` defaults to `test` in development). For Stripe test cards and payouts see `docs/HANDOVER.md`.
* Sign-up is open by default in development. `INVITE_ONLY=true` requires admin-created invite codes.
