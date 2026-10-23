# MobiAd pre-launch checklist (updated after the full build-out and verification)

Legend: ✅ built **and verified** (evidence given) · 🟡 built, partly verified · ❌ not built or not verifiable from one laptop · 👤 needs a human owner (legal, security, finance, product)

## Bottom line
**The software is feature-complete for a private beta and has been verified far beyond unit tests** (real Postgres/Redis/Kafka/SMTP, a real Kubernetes cluster, hard-kill chaos, real scanners). **It is still not ready for an unrestricted public launch with real money**, because what remains is mostly not code: a third-party penetration test, lawyer sign-off, a real payment-processor test, KYC/tax for payouts, and a production environment that has actually run on managed infrastructure. Section 1 lists exactly those.

**Recommended path:** (1) private beta: invited advertisers/publishers, manual review (already enforced), payments via manual wallet credit (supported), small caps; (2) close Section 1; (3) public launch.

---

## 1. Launch blockers — all need a person or an external system
| # | Item | Why it matters | Owner |
|---|---|---|---|
| B1 | **Independent penetration test** and fixes | Everything here is self-tested + automated scanners only | 👤 Security |
| B2 | **Lawyer review** of Privacy Policy, Terms, DPA, Acceptable-Ads Policy (`docs/legal/`, drafts) and each target jurisdiction's ad-tech rules | The drafts describe what the code does; they are not legal advice | 👤 Counsel |
| B3 | **Stripe live mode**: one small real-card payment, refund and webhook delivery with a live key; decide the refund window, who pays chargeback fees (`DISPUTE_FEE_USD`) and what happens when a chargeback arrives after the money was spent | **Done in Stripe's TEST mode** (sandbox account, Stripe CLI forwarding real signed events): checkout, declined card then retry, 3-D Secure, partial and full refund from the admin console, one dispute lost and one won, all with exact wallet amounts. Found and fixed along the way: out-of-order events, local-currency pricing mismatch. **Live mode has not been run.** | 👤 Finance + Eng |
| B4 | **Publisher payouts**: collect bank/tax details (KYC/W-8/W-9), pick payout rail, tax handling, licensing analysis | The software records payout *requests* and admin approval; it does not move money or collect banking details | 👤 Finance/Legal |
| B5 | **Production environment** on managed Postgres HA + PITR, Redis HA, 3-broker Kafka (RF=3, `min.insync.replicas=2`), ingress + TLS, secrets manager; then repeat the cluster tests there | Verified on a single-node k3s with single-replica dependencies | 👤 DevOps |
| B6 | **Hours-long soak and load test at target scale** on that environment | Longest soak so far is 10 minutes on a laptop | 👤 DevOps |
| B7 | **TCF/CMP and vendor registration** if serving EU programmatic traffic; **MRC/IVT accreditation** if brands require it | Consent signals are honored, but there is no CMP integration or accreditation | 👤 Product/Legal |
| B8 | **Mobile SDKs** for Android/iOS (Unity/Flutter if needed) | Only a JavaScript SDK exists; protocol is documented in `docs/SDK_INTEGRATION.md` | 👤 Mobile eng |
| B9 | Real mailbox for `security.txt` and privacy requests; a monitored on-call rota using the alerts and runbook | Placeholders in `public/.well-known/security.txt` and legal pages | 👤 Ops |

## 2. Account security
| Item | Status | Evidence |
|---|---|---|
| scrypt passwords; length/common-password/email-name policy; constant-work login | ✅ | 12 auth-flow tests |
| Email verification (single-use, expiring link; token travels in the URL fragment) | ✅ | tests + **real email via Mailpit in the browser UI and in the k3s cluster** |
| Password reset (no account enumeration, single-use, 30 min, revokes all sessions, **needs MFA code if enabled**) | ✅ | tests, real SMTP integration |
| TOTP MFA (RFC 6238, replay-proof), 8 one-time recovery codes, secret encrypted AES-256-GCM with pinned 16-byte tag | ✅ | **official RFC 6238/4226 test vectors**, UI flow with a real TOTP code, Semgrep-found tag-length gap fixed + test |
| Session revocation (`token_version`): password change/reset, MFA change, logout-everywhere | ✅ | tests |
| Admin accounts: never via signup; created by CLI; **MFA mandatory in production** | ✅ | tests, cluster journey |
| Rate limits: per IP, per account, per email; proxy-aware and spoof-resistant | ✅ | tests, container test |
| Audit log (append-only, signup/login/MFA/reset/review/wallet/payout/flags), exportable per user | ✅ | tests, real Postgres |
| JWT, tracking tokens, TOTP secrets use separate derived keys; **secret rotation with an overlap window and automatic MFA re-encryption** | ✅ | tests (incl. a 3-deployment rotation scenario) |

## 3. Advertising safety and traffic quality
| Item | Status | Evidence |
|---|---|---|
| Automated creative screening (no private/local/credential URLs, https in prod, blocked domains, categories) | ✅ | policy tests |
| **Mandatory manual review in production**, admin console (approve/reject with reason, advertiser emailed, audited) | ✅ | tests + driven through the real UI + cluster journey |
| Restricted categories always reviewed; child-safe rules; publisher category blocklists | ✅ | tests |
| Click-fraud rules (instant click, no impression, per-IP flooding, stale), invalid clicks recorded at zero cost and reported | ✅ | tests, cluster journey, real Kafka |
| App-level anomaly scan → flag → earnings held; admin clears | ✅ | tests |
| Frequency capping, consent signals (COPPA, GDPR string, limit-ad-tracking, US opt-out), no raw device ids stored | ✅ | tests |
| Self-dealing prevented (publisher never serves own ads) | 🟡 | Only same-account; **cannot detect collusion across separate accounts** (needs KYC) |
| Safe-browsing/URL reputation lookups, creative image scanning | ❌ | not built |

## 4. Money
| Item | Status | Evidence |
|---|---|---|
| Integer-micros append-only ledger; idempotent batched writes; second-price auction never above bid | ✅ | tests; **exact ledger==confirmed through SIGKILLs of Postgres, Kafka and Redis in a cluster** |
| Wallet derived from append-only data (no hot balance row); campaign budgets reserved from funds; release on reject/exhaust | ✅ | tests, cluster journey |
| Stripe Checkout + signed webhook (replay window, idempotent credits) | 🟡 | verified against Stripe's test-mode sandbox end to end; **live mode untested (B3)** |
| Payment lifecycle: failed/expired attempts, refunds (admin console, only unspent money), card disputes (hold, release or keep + optional fee), out-of-order event handling | 🟡 | 22 automated tests plus the real-sandbox run above; no evidence-submission UI for disputes (done in the Stripe dashboard); a chargeback after the money was spent can still cost money |
| Tax invoices (seller/buyer details, net + tax + total, frozen copy, reverse charge, credit notes reverse the tax) | 🟡 | a configuration-driven mechanism (`TAX_MODE=inclusive`, rates per country); **rates and rules not reviewed by a tax advisor**; monthly invoices only; no tax on top-ups, US sales tax, VAT-ID validation or e-invoicing formats |
| Manual credits with mandatory note and idempotent reference | ✅ | tests, UI |
| Publisher earnings (70% share), payout requests, hold for flagged apps, admin resolve, monthly CSV statements (formula-injection safe) | ✅ | tests, UI |
| Account deletion refused while money is owed either way | ✅ | tests |
| Automated payouts through Stripe Connect Express (publisher onboarding on Stripe's hosted page, transfers with an idempotency key, small payouts sent automatically, failures leave the payout approved for retry; Stripe verification counts as KYC and tax) | 🟡 | 5 tests against a stub Stripe server + request shapes accepted by Stripe's official spec validator (stripe-mock); **the Stripe calls were run against Stripe's real test mode (Express account, onboarding link, readiness, a real $12.34 transfer, idempotent repeat: 9/9 in `connect-sandbox.mjs`)**; the app's own code was also run against real Stripe test mode (`connect-app-e2e.mjs`, 10/10: status read from Stripe, KYC/tax from Stripe, a $20 automatic payout as a real transfer, a $30 payout waiting for an admin). Then the full path was run once by a person in the browser: the publisher clicked Set up payouts, completed Stripe's hosted test onboarding (it has a CAPTCHA, so it cannot be automated), real signed `account.updated` events arrived through the Stripe CLI, the app showed the account ready, and a $2 payout was paid automatically as a real transfer (verified in Stripe). **Stripe limits where a platform can create accounts: GB, DE and US worked in the test, India was refused for a US platform** (the app answers `country_unsupported`; those publishers need manual payouts). Live mode untested |
| Payout hold (`PAYOUT_HOLD_DAYS`, default 7 in production): the last N days of earnings are shown as pending and cannot be paid out, so advertiser chargebacks and refunds arrive first | ✅ | 2 tests, shown on the publisher earnings page |
| Dispute evidence submission (admin sends evidence built from our own records to Stripe once; draft option; audit-logged) | 🟡 | 1 test against a stub + request fields accepted by Stripe's official spec validator; not run against a real dispute in Stripe |
| Invite-only sign-up (hashed one-time-shown codes, per-role, optional e-mail lock, expiry, revoke, generic failure answer) | ✅ | 4 tests, admin Invites tab, `INVITE_ONLY` (default on in production) |
| Viewability measurement (50% on screen for 1 s: free `viewable` event, viewability rate in reports, breakdowns and CSV; Android and iOS view trackers, JS observer) | 🟡 | server and SDK logic tested (JS, Kotlin on a JVM, Swift on Linux); the JS tracker was checked in real Chrome (`scripts/browser-viewability.mjs`: counted after 1 s, not counted off screen or when scrolled away early; this found and fixed a real browser-only bug); the Android tracker ran on an emulator; **the iOS tracker is compiled only by the macOS CI job** |
| Real video playback (MP4 with byte ranges and an adaptive HLS sample with two renditions; Android ExoPlayer, iOS AVPlayer; reward only after the player reports the end; VAST media-file reader in all three SDKs) | 🟡 | Android verified on an emulator with an MP4 (the HLS sample is served and tested server-side, but not yet watched playing on the phone); VAST reader tested in JS, Kotlin and Swift (Linux); **iOS code has never been compiled or run (needs a Mac: `.github/workflows/ios.yml`)**; no VAST wrapper chains or quartile tracking yet |
| Dispute evidence submission, a dedicated identity-verification vendor beyond Stripe's, tax advisor sign-off | ❌ | B3/B4 |

## 5. Privacy and compliance (engineering side)
| Item | Status | Evidence |
|---|---|---|
| Data minimization (no profiles, no raw device ids, no IPs in DB) | ✅ | design + tests |
| Terms/Privacy acceptance recorded with version+time; required in production | ✅ | tests; **rejects signups without it in the production cluster** |
| Export and erasure (API + UI); ledger retained without personal data | ✅ | tests, UI |
| Retention: CronJob purge (tokens, audit), Kafka topic retention, Redis TTLs; ledger never purged | ✅ | test; **ran as a Job in the cluster under restricted pod policy** |
| Drafts: privacy policy, terms, ROPA, DPIA, retention schedule, incident response, DPA, acceptable-ads policy, ads.txt/sellers.json | 🟡 | `docs/legal/` — **drafts for counsel (B2)** |
| `security.txt` | 🟡 | served; contact is a placeholder (B9) |

## 6. Platform security scans (run for real)
| Scan | Result |
|---|---|
| `npm audit` (prod deps) | 0 vulnerabilities |
| **Trivy** image scan (OS + libraries + secrets) | 0 HIGH/CRITICAL after removing npm from the runtime image (it had 11, all in npm's own bundled packages) |
| **gitleaks** | clean (8 test-password literals replaced by a constant) |
| **Semgrep** (js, node, security-audit, OWASP) | 0 findings after fixing the GCM tag-length issue; 2 CORS flags are intentional and annotated |
| CodeQL, Trivy, SBOM, gitleaks, Semgrep in CI | 🟡 configured (`.github/workflows/ci.yml`, actionlint-clean) but **never executed on GitHub** |
| TLS to Postgres and Redis | ✅ verified (`scripts/verify-tls.sh`): plaintext refused, untrusted cert rejected, trusted CA → TLS 1.3; **Kafka TLS/SASL config exists but is untested** |
| Penetration test | ❌ B1 |

## 7. Reliability and performance (all on one laptop)
| Test | Result |
|---|---|
| 3 replicas + Kafka + Postgres + Redis, 10-min soak | ✅ 299,506 / 299,506, 0 failures, flat memory (`docs/soak-*`) |
| **Production-mode journey inside real Kubernetes** (admin MFA, email verification, funding, review, Kafka billing, fraud, wallet math, payout, audit, metrics auth) | ✅ **31/31 checks, repeated** |
| **Rolling restart under load** (k3s) | ✅ 150,193 requests, 1 failure (a connection reset), ledger exact |
| **HPA** autoscaling 3→28 pods under load | ✅ observed (capped for single-node tests) |
| **SIGKILL of Postgres, Kafka (fsync mode) and Redis under load**, twice | ✅ **0 failed requests, 0 app restarts, ledger == confirmed (158,990 and 154,136)** |
| Prometheus: 24 alert rules + 11 promtool unit-test cases; `RedisDegraded` fired and resolved live; Grafana dashboard 30/30 queries return data | ✅ |
| Production-scale load (e.g. tens of thousands req/s), multi-hour soak, Postgres failover, network partitions, multi-broker Kafka | ❌ B5/B6 |

### Bugs only these tests found (all fixed, each with a regression test or live verification)
1. Checked-out Postgres client `error` event crashed the whole process when Postgres was hard-killed (connection resets + lost in-memory events).
2. Kafka consumers died silently after a broker SIGKILL while pods stayed healthy (now supervised, with a liveness metric and a critical alert).
3. Dev-mode Redpanda skipped fsync, so acknowledged events were lost on a hard kill (production mode required; documented).
4. A replaced Kafka broker came back with auto-created **1-partition** topics (now auto-creation is off and the app re-creates topics with the right partitions every 30 s).
5. `invalid_click` events were dead-lettered by the Kafka validator (fraud records never reached reports).
6. Hot-row contention on campaign counters caused statement timeouts (now batched).
7. Redis limiter keys shared between ad and auth limiters; Redis outage stalled ad serving; and others listed in the README.

## 8. Known product gaps (not blockers for a private beta)
OpenRTB exchange side, native bids and per-exchange authentication (a banner-only bidder endpoint exists, tested in-process only) · conversion/attribution beyond the install pixel · retargeting · customer webhooks (API keys exist) · fine-grained roles/orgs (owner + admin/viewer team members exist, with dashboard UI) · per-campaign reporting dimensions · admin tooling for user support (password-reset on behalf, impersonation) · ClickHouse analytics at scale · creative asset upload/hosting (advertisers supply URLs).


## Added in the InMobi-parity phase (see docs/INMOBI_PARITY.md)
- [ ] **Real demand partners:** connect at least one real DSP in a staging exchange test; verify timeouts, price macros, win/billing notices and latency at your traffic level. Agree settlement and reporting reconciliation with each partner (not modelled here).
- [ ] **Markup safety:** partner and playable markup must be rendered in a sandboxed WebView/iframe in every SDK integration; add a review of any app-side view components.
- [ ] **Rewarded video:** have the publisher verify the callback signature and de-duplicate on transactionId; consider server-side reward limits per user.
- [ ] **Webhooks:** monitor the DemandPartnerFailing and WebhookDeliveriesFailing alerts; decide a retention policy for webhook_deliveries (not yet in the retention job).
- [ ] **Consent:** set TCF_VENDOR_ID once registered on the IAB Global Vendor List; add a CMP integration in the SDKs.
- [ ] **sellers.json / ads.txt:** set SELLER_ID, SELLER_DOMAIN, SELLER_CONTACT; confirm your legal position before listing publishers.
- [ ] **Invoices:** have finance review the invoice and credit-note wording; add tax handling where required.
- [ ] **Configuration safety:** ALLOW_PRIVATE_CALLBACKS must stay false in production (the app refuses to start otherwise).


## External-verification work (final round)
What could be verified without other people's accounts was verified; the rest needs you or third parties.

| Item | Status |
|---|---|
| Stripe code vs Stripe's **official stripe-mock** (validates requests against Stripe's OpenAPI spec): Checkout Session creation, top-up flow, webhook credit exactly once, unpaid sessions ignored | ✅ done (`test/integration/stripe-mock.test.js`, also in CI) |
| Stripe **live/test-mode** run with a real account and key | ⛔ needs your Stripe account: create a test-mode key, set `PAYMENTS_MODE=stripe`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, run one checkout and one webhook delivery, then repeat in live mode with a small amount |
| OpenRTB messages vs the **prebid/openrtb** Go library (strict decoding) + a library-built request accepted by our bidder | ✅ done (`scripts/rtb-conformance`); found and fixed a non-standard field |
| A real exchange or DSP connected end to end | ⛔ needs a commercial partner and test seat; schema conformance does not prove interoperability |
| **OWASP ZAP** automated API scan of the running app from the OpenAPI spec | ✅ done: 0 failures, 3 warnings (1 fixed, 2 accepted); see `docs/SECURITY_SCAN_ZAP.md` |
| Independent **penetration test** | ⛔ needs an independent firm; automated scans are not a substitute |
| **Lawyer review** of docs/legal | ⛔ needs a qualified lawyer |
| **Real KYC / tax provider** | ⛔ needs a vendor account (the status workflow and admin review are built; no vendor is called) |
| Moving **real money** (payouts, bank transfers) | ⛔ not done by design: it needs your payout provider/bank accounts and compliance sign-off; the system records and exports instructions for finance |
