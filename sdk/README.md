# MobiAd SDKs
| SDK | Path | Verified |
|---|---|---|
| JavaScript | `js/` | unit tests in `test/sdk.test.js`; viewability and fetch binding checked in real Chrome (`scripts/browser-viewability.mjs`) |
| Android (Kotlin) | `android/` | `MobiAd.kt` compiled with kotlinc 1.9 and run on JDK 17 against a live server (`src/test/kotlin/SmokeTest.kt`). Builds as an **AAR** and publishes to a local Maven repository (`./gradlew assembleRelease publishToMavenLocal`, Gradle 8.5 / AGP 8.2.2). The same source runs in the demo app on an Android emulator (ads, real video, viewability). Not published to a public Maven repository |
| iOS (Swift) | `ios/` | `MobiAd.swift` compiled and run with Swift 5.10 **on Linux** against a live server (`Tests/smoke.swift`). **Not** built in Xcode, Also run in an iOS simulator by the CI job (ad, impression, viewability, video completion all reached the server); **not** run on a physical iPhone. The macOS CI job (`.github/workflows/ios.yml`) builds the package for the iOS simulator with Xcode 16, runs this smoke test on macOS, and builds the SwiftUI demo app in `ios-demo-app/`: all green |

All three behave identically: impression once, only via `onShown()`; click only after the impression and >= 500 ms later; device id sent only if you pass it and consent allows; failures never throw into the UI.
Android notes: network calls are blocking (use a background thread); plain-http base URLs need a network-security config (use https in production); `org.json` is part of Android.
Viewability: `ad.onViewable()` on all three SDKs; `ViewabilityTracker` (Android `ViewabilityTracker.kt`, iOS in `MobiAd.swift`) measures 50% on screen for 1 s. Not included: view components (banner/interstitial rendering), public SDK distribution (Maven Central/CocoaPods), ProGuard rules.

## Added later
All three SDKs now support: targeting signals, `placementId`, `userId` for rewarded ads, `test` mode, partner ads (`external`), reward info and native assets. The JavaScript SDK also has `reportWhenViewable()`. Kotlin and Swift were re-verified with the smoke tests (test-mode ads) on JVM / Linux Swift.
