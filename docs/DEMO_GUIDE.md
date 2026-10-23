# Investor demo guide

## Start it (one command)
```bash
node scripts/demo.mjs          # or double-click start-demo.cmd on Windows
```
Opens at **http://localhost:8080** (site `/`, dashboard `/app`, help `/help`). It builds ~6,000 simulated ad events through the real ad server, spreads them over two weeks, and keeps adding live traffic every few seconds. Stop with Ctrl+C; everything resets on the next start. `DEMO_EVENTS=12000` makes the history bigger, `DEMO_LIVE=0` turns the live traffic off.

| Role | Login | Password |
|---|---|---|
| Advertiser | demo-advertiser@mobiad.test | Demo-Pass-Phrase-2026 |
| Publisher | demo-publisher@mobiad.test | Demo-Pass-Phrase-2026 |
| Admin | admin@mobiad.test | Admin-Pass-Phrase-2026 |
| Advertiser 2 / Publisher 2 | northwind-ads@mobiad.test / pixelforge-games@mobiad.test | Demo-Pass-Phrase-2026 |

The dashboard shows a **"Demo environment: simulated data"** badge, on purpose. Do not remove it.

## From a phone or your own app (same Wi-Fi)
The demo prints a second address, for example `http://192.168.1.15:8080`: that is what a phone must use (`localhost` only works on the computer). It is also put into the tracking links, so impressions and clicks from a phone are recorded.
- **Check the wiring in 30 seconds:** `node scripts/selfcheck.mjs http://192.168.1.15:8080 <App ID>` runs the same calls an app makes and says what to fix.
- **Ready-made phone app:** build `android-demo-app` (or use the `MobiAd-Demo.apk` shipped with the investor PDF), type the address and your App ID, tap *End user*.
- **Your own Android app:** copy `sdk/android/src/main/kotlin/io/mobiad/sdk/MobiAd.kt`, add the INTERNET permission (and `usesCleartextTraffic` for plain http), and use the sample `android-demo-app/.../MinimalIntegration.kt` (compiled with every build).
- The full step-by-step, feature tick-list and troubleshooting table are in the investor PDF (`investor-guide/MobiAd-Investor-Story.pdf`, built by `investor-guide/build-story-pdf.mjs`).

Before the meeting: close other programs using port 8080 (a Windows service sometimes does; use `PORT=8090 node scripts/demo.mjs`), use a wide browser window, and rehearse once.

## 12-minute walkthrough
1. **The pitch (1 min), website `/`.** Two-sided mobile ad platform: advertisers buy, publishers earn, a fair second-price auction in the middle, every event in an auditable ledger. Scroll the formats and the "how it works" section.
2. **Advertiser (4 min).** Log in as the advertiser.
   - *Overview:* spend, impressions, clicks, CTR, conversions, a 14-day chart.
   - *Campaigns:* seven campaigns across formats (banner, video, native, CPA). Open **Creatives** on "Summer Sale" to show A/B rotation. Click **New campaign** and walk the 4 steps with the live preview; stop before submitting, or submit one to show it going live.
   - *Reports:* switch the **Breakdown** between campaign, creative, country and format.
   - *Wallet:* balance, an invoice for last month (View / print), statements.
   - *Developers:* API keys, webhooks, and the conversion postback.
3. **Publisher (3 min).** Log out, log in as the publisher.
   - *Apps:* App IDs and copy-ready code in JavaScript, Kotlin and Swift; open **Placements, rewarded video and test ad** and press **Send test ad request**.
   - *Earnings and payouts:* earned/payable, verified payout details, one paid payout and one waiting.
   - *Reports:* earnings by app and country (publishers never see advertiser spend).
4. **Admin (3 min).** Log out, log in as the admin.
   - *Review:* the "Lucky Spin Promo" gambling campaign is waiting; approve or reject it. Explain restricted categories always get a human.
   - *Payouts:* the KYC queue (PixelForge) and a payout request: approve, then mark paid with a reference.
   - *Partners:* the simulated external DSP competing in the same auction; pause and resume it.
   - *Audit log:* every action recorded.
5. **Close (1 min), `/help` and the roadmap.** What's built, what needs servers and partners (below).

## What is real and what is simulated (say this out loud)
| Real, running code | Simulated or not yet done |
|---|---|
| Auction, tracking, fraud rules, billing ledger, reports, invoices, roles, payout workflow, webhooks, API | All users, companies, apps, traffic and money in this demo |
| Tested: 154 automated tests, real Postgres/Redis/Kafka runs, chaos tests on a real Kubernetes cluster, an automated security scan | The "external DSP" is a script on this laptop |
| | No real money moves; Stripe was verified only against Stripe's test mock |
| | No customers yet; never run on production servers or under production traffic |
| | Legal documents are drafts under review; no independent penetration test yet |

## Likely investor questions
- **"Is this live?"** No: a working product running locally. The money you raise buys the servers, legal, security test and the first customers.
- **"How is it different from InMobi / AppLovin / Unity?"** It is not at their scale and is not claiming to be. Position: a transparent, privacy-first ad network for a focus segment (state yours), with an auditable ledger.
- **"What does it cost to launch?"** Cloud (managed Postgres, Redis, Kafka, Kubernetes), an email provider, a penetration test, legal, KYC/payments provider fees. Get quotes first; `docs/RUNBOOK.md` lists the components.
- **"Where is the demand?"** Honest answer: not yet; that is go-to-market work (direct advertisers or partner DSPs).
- **"Is it secure / compliant?"** Built with consent signals (GDPR/TCF, COPPA), hashed identifiers, MFA, audit log; automated scan clean; independent pen test and lawyer review are planned.
