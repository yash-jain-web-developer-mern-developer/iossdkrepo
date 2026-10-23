# InMobi feature inventory and MobiAd parity plan

Sources: InMobi's public sites (inmobi.com, advertising.inmobi.com: Brand Building, Growth Marketing, Ad Monetization; resources; support
docs for DSP, exchange, mediation) and general industry knowledge of mobile ad platforms. InMobi does not publish a complete product list,
so this inventory is a best effort, grouped by area. **Parity is not fully reachable by code**: scale, demand relationships, data,
accreditations and people-run services are marked "Out of reach".

Legend: ✅ built before this plan · 🛠 built in this plan · 🔶 partial · ⛔ out of reach / not code · ➖ deliberately not built

## 1. Buy side (DSP: growth marketing, brand building)
| Feature | Status |
|---|---|
| Campaign management, budgets, daily caps, pacing, frequency caps | ✅ |
| CPM / CPC / CPA pricing, second-price auction, smoothed CTR/CVR prediction | ✅ |
| Formats: banner, interstitial, native, video, playable | ✅ (native assets 🛠) |
| Rewarded video | 🛠 |
| Targeting: country, platform, category, child-safe | ✅ |
| Targeting: language, device type, OS version, connectivity, day-parting, app allow/block lists | 🛠 |
| Creative sets with rotation / A-B testing, per-creative reporting | 🛠 |
| Conversion tracking, click-id attribution, S2S postback | ✅ |
| Reporting breakdowns (by campaign, app, creative, format) | 🛠 |
| Invoices, credit notes / refunds | 🛠 |
| Webhooks and API keys for automation | 🛠 webhooks (keys ✅) |
| Team members with roles | ✅ |
| Machine-learned bidding on large data, lookalike/retargeting audiences, DCO with AI | ⛔ (needs data and models at scale) |
| Managed service, creative studio, strategy team | ⛔ people |
| Brand-safety vendors (IAS, DoubleVerify), third-party verification | ⛔ vendor contracts |
| CTV / omnichannel exchange, web and DOOH inventory | ⛔ |
| MMP integrations (AppsFlyer, Adjust, Branch) | ➖ (postback endpoint is generic) |

## 2. Sell side (exchange, mediation, ad monetisation)
| Feature | Status |
|---|---|
| Apps, floors, category blocklists, child-directed apps | ✅ |
| Earnings, payout workflow, KYC/tax status | ✅ |
| Unified auction: MobiAd demand + external DSPs over OpenRTB (header-bidding style) | 🛠 |
| Demand-partner (DSP) registry, timeouts, win/loss notices | 🛠 |
| Ad units / placements with their own floors | 🛠 |
| Bidder endpoint for exchanges (OpenRTB 2.6, banner and video) | ✅ |
| sellers.json and ads.txt / app-ads.txt generation | 🛠 |
| SDK-side viewability measurement | 🛠 |
| Mediation adapters for third-party ad-network SDKs (AdMob, AppLovin, ironSource...) | ⛔ (needs each network's SDK and agreements) |
| 200+ DSP connections, 5,000+ buyers | ⛔ (commercial) |
| Waterfall management UI | ➖ (replaced by the unified auction) |

## 3. SDKs and developer tools
| Feature | Status |
|---|---|
| JavaScript, Kotlin, Swift SDK cores | ✅ (rewarded, native assets, viewability 🛠) |
| OpenAPI spec, API keys, OpenRTB endpoint | ✅ |
| Unity, Flutter, React Native wrappers | ⛔ (not built; JS SDK works in React Native) |
| Banner/interstitial view components, test mode/test ads | 🔶 test ads 🛠, views ⛔ |

## 4. Privacy, trust and quality
| Feature | Status |
|---|---|
| GDPR/COPPA/US-privacy signal handling, hashed device keys | ✅ |
| TCF v2 consent-string parsing (purpose 1 / vendor consent) | 🛠 |
| Invalid-traffic detection, held earnings, audit log, MFA, RBAC | ✅ |
| MRC accreditation, TAG certification, ISO 27001 / SOC 2 | ⛔ audits |

## 5. Platform and operations
Kafka ledger, Postgres, Redis, Kubernetes, observability, retention, runbook: ✅. Help center / resource library: 🛠 (static articles). Support desk, InMobi University style courses: ⛔ people and content.

## Delivery plan (executed in this order)
A. Targeting suite, creative sets, native assets, rewarded video, placements.
B. Unified auction with external DSP partners.
C. Webhooks, invoices/credit notes, breakdown reports, sellers.json/ads.txt, TCF parser, viewability helper.
D. Dashboard UI for all of the above, help center, SDK and OpenAPI updates, docs.
Every item ships with tests; data-model changes are applied on real Postgres.

## Final status (after implementation)
Everything marked 🛠 above was built and tested (hermetic suite, real Postgres + Redis + Kafka + SMTP integration run, native SDK smoke tests, promtool alert tests, Semgrep 0 findings, browser walk-through of the dashboard).
Honest limits of what was built:
- **Unified auction / partners:** exercised against mock OpenRTB DSPs only; never connected to a real exchange or DSP. Partner settlement (money owed by/to partners) is not modelled: the ledger records publisher revenue on impression, and reconciling with a partner's own report is a manual finance task. Partner markup is untrusted third-party code: SDK integrators must render it in a sandbox.
- **Rewarded video:** reward callbacks are signed and SSRF-protected, but fraud around rewards (device farms) is limited to the existing click/impression rules plus a minimum-watch-time check.
- **Webhooks:** at-least-once delivery, persisted in Postgres, lease-based claiming for several replicas; verified on real Postgres with one worker, not under multi-replica load.
- **TCF:** only the core segment is parsed (purpose 1 + optional vendor id). Publisher-restriction segments, legitimate-interest rules and a CMP are not implemented.
- **Invoices:** simple monthly spend documents, not tax invoices. No PDF generation (the dashboard has a print view).
- **Viewability:** SDK-side 50%/1 s helper for the JavaScript SDK only; no MRC-accredited measurement.
- **Still out of reach:** see ⛔ rows (data, scale, vendors, accreditations, third-party mediation adapters, people-run services).
