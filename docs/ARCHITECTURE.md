# MobiAd Platform – Architecture

## 1. Goals and what has actually been demonstrated
| Goal | Target | Demonstrated (one laptop; see `LAUNCH_CHECKLIST.md`) |
|---|---|---|
| Ad-request latency | p99 < 100 ms | p99 ≈ 30–60 ms at ~500–1,400 req/s (in-process catalog, no DB on the hot path) |
| Never lose a confirmed billable event | exact ledger | Ledger == client-confirmed through SIGKILLs of Postgres, Kafka (fsync) and Redis under load, twice |
| Survive dependency failure | degrade, don't stop | 0 failed requests during those kills; ad serving continues from the catalog with local fallbacks |
| Money correctness | idempotent, auditable | Integer micro-dollar append-only ledger; unique token hash; wallet and earnings *derived*, not stored |
| Safe by default | refuse unsafe config | Production mode aborts startup unless MFA, review, verification, terms, funding, TLS-url, etc. are on |
| Scale | tens of thousands req/s per region | **Not demonstrated** (laptop only) |

## 2. System design
```
 App SDK ──► Edge/LB/WAF ──► mobiad pods (N, stateless) ───────────────┐
                              │  /v1/ad : auction on an in-process catalog snapshot
                              │  /t/*   : verify signed token → fraud rules → publish event
                              │  /api/* : control plane (auth, campaigns, wallet, admin)
                              ▼
        Kafka topic mobiad.events (acks=all, fsync, 6 partitions, 7-day retention)
                              │  (fallback: per-pod in-memory queue if Kafka is unreachable)
                              ▼
        supervised ledger consumers (1 per pod) ──► PostgreSQL ledger (idempotent batched INSERT … ON CONFLICT DO NOTHING)
                                                          │
   Redis: dedupe (SET NX), spend counters, rate limits,   ├─ campaigns / apps / users / wallet_entries / payouts / audit_log
          frequency caps, catalog-change pub/sub          └─ reports, statements, balances are queries over append-only tables
```
- **Control plane vs data plane.** The ad path never queries Postgres: campaigns and apps are preloaded into each pod and refreshed every 2 s *and* immediately via Redis pub/sub when an admin/advertiser/publisher changes something.
- **Ports and adapters.** Hot state (dedupe, limits, counters, spend) has memory and Redis adapters behind a circuit breaker with local fallbacks; the repository is the only Postgres code.
- **Durable event pipeline.** The tracker answers only after Kafka acknowledges (acks=all). The consumer commits offsets only after Postgres accepted the batch; the ledger's unique token hash makes replays harmless. Malformed events go to a dead-letter topic. The consumer is **supervised** (rebuilt with backoff) and exported as a liveness metric.
- **Derived money.** `wallet = credits − ledger spend − unspent reserved budget`; publisher earnings = share of ledger spend, excluding flagged apps minus payouts. No balance row exists to contend on or drift.
- **Hot-row avoidance.** Per-campaign counters are accumulated in memory and flushed once per second; the ledger stays the source of truth (`scripts/reconcile.js` rebuilds them).

## 3. Security model
- Roles: advertiser, publisher, admin (CLI-created, MFA required in production). Tenant isolation by owner on every query.
- Sessions are JWTs with a `token_version`; password change/reset, MFA change and logout-everywhere revoke all of them. Separate derived keys for JWT, tracking tokens and TOTP encryption.
- Tracking links are HMAC-signed and expiring; clicks pass invalid-traffic rules before billing; invalid events are stored at zero cost.
- Content: automated URL/category screening → mandatory human review in production; restricted categories always reviewed; child-directed apps only get child-safe ads.
- Transport and platform: TLS-capable Postgres/Redis/Kafka configuration (Postgres and Redis verified), restricted Pod Security, default-deny NetworkPolicy, read-only root filesystem, non-root, no npm in the runtime image, Trivy/gitleaks/Semgrep clean.

## 4. Data model (migrations in `infra/sql/migrations`)
`001` users, campaigns, apps, ledger · `002` MFA, email verification, one-time tokens, audit log · `003` review status, categories, child-directed, fraud flags, frequency caps · `004` wallet entries, payouts · `005` terms acceptance. Forward-only, serialized by a Postgres advisory lock; applied at boot and by a deploy-time Job.

## 5. Scaling and capacity notes
- Pods are CPU-bound on the ad path (single Node thread each): scale with the HPA (observed 3→28 under load). Consumers scale to the partition count (6).
- Throughput per pod on a laptop ≈ 500–1,400 requests/s including tracking; real capacity must be measured on production hardware (checklist B6).
- Redis is a hot-state store, not a system of record; Kafka holds only unconsumed events; Postgres is the system of record.

## 6. Failure behaviour (all verified by hard kills)
| Failure | Behaviour |
|---|---|
| Redis down | Breaker opens in ≤ 3 failed calls; local fallbacks; no failed requests; auto-recovery |
| Postgres down | Ad serving continues; events wait in Kafka; control plane 5xx; pods stay ready (degraded) |
| Kafka down | Trackers use in-memory queues (durability reduced; alert); consumers rejoin; topics re-created if lost |
| Pod killed / rolling deploy | Pre-stop drain + graceful ledger flush; ≈ 1 connection reset per 150k requests |
| Postgres client connection dies mid-write | Handled (previously crashed the process); batch retried |

## 7. Roadmap
OpenRTB bidder/exchange · multi-broker/HA validation on managed services · ClickHouse analytics consumer on the same topic · KYC and payout execution · creative hosting and image scanning.
