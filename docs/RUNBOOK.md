# Runbook

Alert rules: `infra/observability/alerts.yml` (26 rules, unit-tested) · Dashboard: `infra/observability/grafana/dashboards/mobiad.json`. Incident handling for security/privacy events: `docs/legal/INCIDENT_RESPONSE.md`.

## Deploy
1. Provision **managed** Postgres 16 (HA, PITR, TLS), Redis 7 (HA, TLS), Kafka (3 brokers, TLS/SASL, RF=3, `min.insync.replicas=2`, **fsync on — never developer/dev-container mode**, `auto.create.topics.enable=false`), an SMTP provider and (optionally) Stripe.
2. Create namespace + Secret `mobiad-secrets` with `MOBIAD_SECRET` (`openssl rand -hex 32`), `DATABASE_URL`, `REDIS_URL`, `KAFKA_BROKERS`, `METRICS_TOKEN` (≥16 chars), `SMTP_URL` (+ `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` if `PAYMENTS_MODE=stripe`). Edit `infra/k8s/base/configmap.yaml` (public URL, from-address, payments mode…); the app **refuses to start** in production with unsafe settings.
3. Build and push the image (pin to a digest). Run the migration Job first (`infra/k8s/base/migrate-job.yaml`), then `kubectl apply -k <your overlay of infra/k8s/base>`; apply `ingress.yaml` once an ingress controller + cert-manager exist.
4. Create the first admin: `kubectl -n mobiad exec deploy/mobiad -- env ADMIN_EMAIL=… ADMIN_PASSWORD=… node scripts/create-admin.js`, log in, **enable two-step login** (admin APIs are refused until you do).
5. Smoke test the whole business flow: `scripts/prod-e2e.mjs` (see `scripts/k3s-e2e.sh` for how it is run as an in-cluster pod). Check `/readyz`, `/metrics` (needs the token) and the Grafana dashboard.
6. Point Prometheus at the pods (annotations are in the Deployment) and route alerts.

Rolling deploys are zero-downtime (`maxUnavailable: 0`, pre-stop drain, graceful shutdown with ledger flush); expect single connection resets at most (measured: 1 in 150k requests). A full 3-pod rollout takes ~2 minutes (start-up probes wait for Postgres/Kafka).

## Daily operations
- **Campaign review queue**: Admin console → Review. Alert `ReviewQueueBacklog` fires when >20 wait for an hour. Approve/reject with a reason; advertisers are emailed; every decision is audited.
- **Flagged apps** (earnings held): Admin → Flagged apps. Investigate (invalid-click share and CTR are in the reason), then clear or keep.
- **Payouts**: Admin → Payouts. Pay out-of-band, then mark paid with a reference. Wallet credits (bank transfers etc.): Admin → Wallet credit (note + unique reference required).
- **Retention**: CronJob `mobiad-retention` runs daily. Check the last Job log for the `removed` counts.

## Rotate the signing secret (no lockout; tested)
`MOBIAD_SECRET` derives the keys for sessions (JWT), tracking links and the encryption of stored MFA secrets. Rotate with an overlap window:
1. Generate the new secret (`openssl rand -hex 32`).
2. Deploy with `MOBIAD_SECRET=<new>` **and** `MOBIAD_SECRET_PREVIOUS=<old>`. Sessions, in-flight tracking links and MFA users keep working; each MFA secret is re-encrypted with the new key the first time its owner logs in.
3. Wait until sessions have turned over (1 h) and tracking links have expired (24 h); ideally until every MFA user has logged in once (find stragglers: `SELECT email FROM users WHERE totp_enabled` and check the audit log for `login_success` since the rollout).
4. Remove `MOBIAD_SECRET_PREVIOUS`. Anything still on the old key at that point is rejected (users log in again; **MFA users who never logged in during the window must be reset by an admin**).
All pods must use the same pair at all times. Rotate immediately (skip the window, accept the re-login) if the secret may be compromised.

## Alerts and what to do
| Alert | Meaning | First actions |
|---|---|---|
| `MobiAdDown`, `HighServerErrorRate` | Outage | Check pods/events, recent deploy (roll back), dependency health |
| `LedgerEventsDropped` | **Billing data loss** (queue full) | Page immediately; reconcile from tracker logs; see Reconciliation |
| `LedgerBacklogGrowing`, `LedgerWriteFailures` | Postgres slow/down | See "Postgres down" |
| `KafkaLedgerConsumerDown` | **No pod is draining Kafka into the ledger**: events are safe in Kafka but billing/reports go stale | `rpk group describe mobiad-ledger` (members 0?); check pod logs for `ledger consumer is down; rebuilding`; the supervisor rebuilds consumers with backoff, but if the broker is unreachable fix the broker; as a last resort `kubectl rollout restart deployment/mobiad` |
| `KafkaLedgerConsumerFlapping/Degraded` | Consumers repeatedly crashing / a pod stuck | Look for rebalance storms and broker health |
| `KafkaDeadLetters` | Events rejected as malformed (fraud/billing records not landing) | `rpk topic consume mobiad.events.dlq`; fix the producer; replay manually (replays are idempotent) |
| `KafkaFallbackActive` | Kafka unreachable: trackers use in-memory queues (**a pod crash now can lose its queued events**) | Restore Kafka; do not roll pods meanwhile |
| `RedisDegraded` | Redis unavailable: local fallbacks active | See "Redis down" |
| `InvalidClickRateHigh`, `ForgedTokenSpike` | Fraud or a broken SDK integration / secret mismatch across pods | Inspect by app in the dashboard; flag apps; verify all pods share `MOBIAD_SECRET` |
| `FillRateLow` | Budgets exhausted, campaigns stuck in review, targeting too narrow | Review queue; ask advertisers to top up |
| `AdServingLatencyHigh`, `EventLoopLagHigh`, `DatabasePoolSaturated`, `PodMemoryHigh` | Capacity | Scale out (HPA), raise `PG_POOL_MAX`, check slow queries / leaks |

## Reconciliation
The ledger is the truth. Campaign counters (`impressions`, `clicks`, `spent`) are denormalized, flushed every second; alert `CampaignCounterDrift` fires if flushes fail. After a pod crash (lost in-memory deltas) or any drift run `DATABASE_URL=… node scripts/reconcile.js` (safe any time). Spend per campaign: `SELECT campaign_id, SUM(amount_micros)/1e6 FROM ledger GROUP BY 1`. Wallet and earnings are always derived from the ledger and `wallet_entries`, so they cannot drift.

## Incident: Redis down (verified by SIGKILL under load)
Every Redis call has a 250–300 ms timeout and a circuit breaker; ad serving, tracking and login continue on per-replica in-memory fallbacks (rate limits and dedupe become per-replica; spend counters are local and reconcile from the ledger; clicks get the benefit of the doubt on the "impression seen" rule). Limits while degraded: budgets/daily pacing can overshoot slightly across replicas; billing stays exact because the ledger `token_hash` is UNIQUE. Redis restart without persistence resets counters; the catalog re-bases on `campaigns.spent` from Postgres.

## Incident: Postgres down (verified by SIGKILL under load)
Pods stay up and `/readyz` returns 200 with `"db":"down"`. Ad serving and tracking continue from the in-process catalog; confirmed events wait safely in Kafka and the consumer drains them after recovery. The control plane (login, campaigns, reports, admin) returns 5xx. New pods started during the outage wait up to 60 s for Postgres and then restart until it is back (they recover on their own). A half-dead Postgres in "smart shutdown" (refusing new connections) looks the same: restart the database container.

## Incident: Kafka down / replaced (verified by SIGKILL under load)
Trackers fall back to the per-pod in-memory queue (breaker opens after 2 failures; expect a 2–3 s latency blip). **Do not restart pods during this window** (their queued events would be lost). Consumers are supervised and rejoin; the app re-creates topics (6 partitions) every 30 s if the broker lost them. Replays are safe.

## Kafka operations
- Topics `mobiad.events` (6 partitions, 7-day retention) and `mobiad.events.dlq` (30 days). Group `mobiad-ledger`; run up to 6 consumers (one per partition).
- Lag: `rpk group describe mobiad-ledger` (TOTAL-LAG should be ~0).
- **Never use developer/dev-container mode for the real broker**: it skips fsync and **acknowledged events can be lost on a crash**.

## Backups / restore
PITR on Postgres with a quarterly restore drill (including re-applying account deletions from the audit log). Redis and Kafka are rebuildable: Kafka holds only unconsumed events (consumed ones are in the ledger).

## Demand partners (external DSPs)
Admin → Partners. Add an HTTPS OpenRTB 2.6 endpoint, a timeout (50-500 ms; slower partners cost ad latency), the formats it may bid on, and whether it is approved for child-directed apps. Pause a misbehaving partner immediately: the change reaches every replica within seconds. Alert `DemandPartnerFailing`: check the partner's status page, then pause it; each partner also has an in-process circuit breaker (opens after 5 consecutive failures for 10 s). Partner revenue is booked in the ledger as `ext_<partner id>`; reconcile it against the partner's own report monthly (settlement is manual).

## Webhooks and reward callbacks
Webhook events are rows in `webhook_deliveries` processed by a worker in every pod (lease-based, so pods do not double-send). Retries: 1 m, 5 m, 30 m, 2 h, 12 h; a webhook with 20 consecutive failures is disabled (the customer re-creates it). Alert `WebhookDeliveriesFailing` usually means customer endpoints are down or outbound networking is broken. Reward callbacks (rewarded video) retry 0.5 s and 2 s on 5xx/network errors and are not retried on 4xx. Private/internal destinations are blocked (SSRF); keep ALLOW_PRIVATE_CALLBACKS=false.

## New configuration
`TCF_VENDOR_ID` (our IAB vendor id; 0 = do not check), `SELLER_ID`, `SELLER_DOMAIN`, `SELLER_CONTACT` (sellers.json), `WEBHOOK_INTERVAL_MS` (default 2000), `ALLOW_PRIVATE_CALLBACKS` (tests/local only; forbidden in production).
