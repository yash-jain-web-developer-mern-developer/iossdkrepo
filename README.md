# MobiAd

A mobile advertising platform: **advertisers** fund and run campaigns, **publishers** monetize apps, a real-time **second-price auction** picks each ad, and every impression/click is billed idempotently from an append-only **Postgres ledger** fed through **Kafka**. Includes accounts with MFA, creative review, fraud detection, a prepaid wallet, publisher payouts, an admin console, a JavaScript SDK, monitoring, and Kubernetes manifests.

> **Status: private-beta ready; not ready for an unrestricted public launch.** The remaining blockers are mostly people and external systems (penetration test, lawyer review, live payment-processor test, KYC/tax for payouts, a managed production environment). See **[docs/LAUNCH_CHECKLIST.md](docs/LAUNCH_CHECKLIST.md)** for the exact, evidence-backed list.

## Quick start (development)
```bash
npm install
npm start                    # http://localhost:8080  (site /, dashboard /app) — in-memory database, test-mode payments
node scripts/demo-seed.js    # optional demo accounts + traffic
npm test                     # 151 tests (146 run hermetically, 5 need real infra) (in-memory Postgres/Redis stand-ins)
```
Real infrastructure for integration tests: `docker compose -f infra/docker-compose.deps.yml up -d`, then see the header of `test/integration/real-infra.test.js`.

## What is built
| Area | Details |
|---|---|
| **Ad serving** | Second-price auction (floors, CPM/CPC via smoothed CTR), pacing, targeting, frequency caps, brand-safety category blocklists, child-directed apps, consent signals (TCF v2 aware), language/device/OS/connection/hour/app-list targeting, creative rotation (A/B), native assets, rewarded video, placements; no database on the hot path |
| **Tracking & billing** | HMAC-signed expiring tokens; replay-safe; Kafka (acks=all) → idempotent batched Postgres ledger in integer micro-dollars; counters flushed in batches |
| **Accounts & security** | scrypt, email verification, password reset, TOTP MFA + recovery codes (mandatory for admins in production), session revocation, rate limiting, audit log, terms acceptance record |
| **Advertiser tools** | Campaigns with automated policy screening → manual review (production), wallet with funding reservations, Stripe Checkout or manual credit, reports + CSV, monthly statements |
| **Publisher tools** | Apps (child-directed flag, blocked categories), earnings (70% share), payout requests, invalid-traffic visibility |
| **Fraud / IVT** | Click rules (instant, no impression, IP flooding, stale), app anomaly scan → flag → earnings held |
| **Supply side** | Unified second-price auction across MobiAd campaigns and external OpenRTB demand partners, partner registry with timeouts and circuit breakers, rewarded-video server callbacks, sellers.json and app-ads.txt lines, test-mode ads |
| **Developer tools** | Scoped API keys, signed webhooks (retried), conversion postback, breakdown reports by campaign/app/creative/placement/country/format, invoices and credit notes, help center |
| **Admin console** | Review queue, flagged apps, payouts, wallet credits, users, audit log |
| **SDK & API** | JavaScript SDK (`sdk/js`), OpenAPI spec (`docs/openapi.yaml`, linted, drift-tested), integration guide |
| **Operations** | Structured logs, Prometheus metrics, **26 alert rules** (unit-tested), Grafana dashboard, health/readiness, graceful shutdown, retention job, runbook |
| **Deployment** | Hardened Docker image, Kubernetes (kustomize base + overlay; restricted Pod Security, NetworkPolicy, HPA, PDB, probes), CI with scanners |
| **Compliance pack** | `docs/legal/`: privacy policy & terms (served as DRAFT pages), ROPA, DPIA, retention, incident response, DPA, ad policy |

## Verified (with evidence in `docs/` and the checklist)
- **151 automated tests** (146 hermetic); 5 real-infra tests (real Postgres, Redis, Kafka and **real SMTP**) pass repeatedly.
- **Real Kubernetes (k3s) cluster**, production-mode config: a 31-check business journey (admin MFA → verified emails → funding → review → Kafka billing → fraud → wallet → payout → audit) passes repeatedly; **rolling restart under load: 150,193 requests, 1 failure**; HPA autoscaled 3→28; **SIGKILL of Postgres, Kafka and Redis under load, twice: 0 failed requests, 0 restarts, ledger exactly equal to confirmed events**.
- Scanners run for real: `npm audit` 0, **Trivy 0 HIGH/CRITICAL**, **gitleaks clean**, **Semgrep 0**; TLS to Postgres and Redis verified against real TLS servers.
- Dashboard/admin UI driven in a real browser (sign-up, real email link, funding, review, MFA login).

### Bugs found only by real-infra and chaos testing (all fixed)
Hard-killing Postgres crashed every pod (unhandled event on a checked-out client) · Kafka consumers died silently after a broker kill (now supervised + alerted) · dev-mode Redpanda skipped fsync and lost acknowledged events · a replaced broker auto-created 1-partition topics · fraud events dead-lettered by a validator · hot-row contention on campaign counters · shared Redis limiter keys · ad serving stalled when Redis was down · apps loaded lazily from Postgres · all replicas crashed on Postgres restart · and more (see the checklist).

## Not built / not verified
- **Not verified:** a live Stripe call (the code IS verified against Stripe's official stripe-mock); any managed/HA production infrastructure; hours-long soak; anything at production scale (all numbers are from one laptop); Kafka TLS/SASL; CI never executed on GitHub.
- **UI:** redesigned marketing site and dashboard (sidebar shell, charts, campaign wizard, dark mode, mobile layout); checked in an embedded Chromium only, no automated accessibility audit.
- **Partial (built and tested, but never used with a real partner):** OpenRTB 2.6 *bidder* endpoint (`POST /rtb/v2.6/bid`: banner and video via VAST 4.2, USD; no exchange has connected to it, no native, no per-exchange auth). Video and playable (HTML5) creative formats with completion tracking (no transcoding/hosting, no viewability, playables always need manual review). Conversion tracking: click-id attribution (last-click, 1-30 day window), server-to-server postback, CPA pricing; no view-through, no MMP integrations, no multi-touch.
- **Partial:** publisher payouts: payout profile, KYC/tax *status* workflow with admin review, requested -> approved -> paid state machine with an external reference, finance CSV export. **No money is moved and no KYC/tax vendor is called**; documents and tax IDs are never stored.
- **Partial:** native Android (Kotlin) and iOS (Swift) SDK cores in `sdk/` (API client + traffic-quality rules; verified on JVM and Linux only; no view components, no device/emulator run, no package publishing).
- **Partial:** unified auction with external DSPs, rewarded video, webhooks, TCF v2 core parsing, creative rotation, invoices: built and tested against mocks and real Postgres/Kafka, never used with real partners; see `docs/INMOBI_PARITY.md` for the full feature inventory and limits.
- **Not built:** actual payout execution, KYC/tax vendor integration and withholding, invoicing, refunds/chargebacks, URL-reputation and image scanning, TCF/CMP integration, multiple organizations per user, finer-grained roles (customer API keys and simple team members exist, with a dashboard page; verified on real Postgres).

## Configuration
See `infra/k8s/base/configmap.yaml` for the full list. `NODE_ENV=production` **enforces safe settings** (it refuses to start otherwise): strong `MOBIAD_SECRET`, `DATABASE_URL`, `REDIS_URL`, `KAFKA_BROKERS`, `METRICS_TOKEN`, `SMTP_URL`, https `PUBLIC_URL`, email verification, terms acceptance, admin MFA, manual campaign review, funded wallets, no test payments.
Useful: `TRUST_PROXY_HOPS`, `RATE_LIMIT_PER_MIN`, `PAYMENTS_MODE` (`none`|`stripe`), `MIN_PAYOUT_USD`, `KAFKA_RETENTION_DAYS`, `DATABASE_SSL`, `CORS_ORIGINS`.

## Scripts
| Script | Purpose |
|---|---|
| `scripts/migrate.js` | Apply migrations (deploy-time job; also runs at boot under an advisory lock) |
| `scripts/create-admin.js` | Create an admin (never possible via signup) |
| `scripts/retention.js` | Purge expired tokens/old audit entries (never the ledger) |
| `scripts/reconcile.js` | Rebuild campaign counters from the ledger |
| `scripts/loadtest.js`, `chaos.js`, `soak.sh` | Load, hard-kill chaos (docker compose) and soak tests |
| `scripts/prod-e2e.mjs`, `k3s-e2e.sh` | Production-mode end-to-end journey / load as a pod in a cluster |
| `scripts/verify-tls.sh`, `check-dashboard.cjs` | TLS verification; evaluates every Grafana query against live Prometheus |

## Documentation
[LAUNCH_CHECKLIST](docs/LAUNCH_CHECKLIST.md) · [ARCHITECTURE](docs/ARCHITECTURE.md) · [RUNBOOK](docs/RUNBOOK.md) · [SDK_INTEGRATION](docs/SDK_INTEGRATION.md) · [openapi.yaml](docs/openapi.yaml) · [legal pack](docs/legal/README.md)
