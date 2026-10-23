# Data retention schedule (DRAFT — periods in [brackets] need counsel/finance confirmation)

| Data | Where | Period | How it is enforced |
|---|---|---|---|
| Account (email, hash, flags, terms acceptance) | Postgres `users` | While the account exists; deleted on request | `DELETE /api/account` (UI: Security → Delete) |
| Apps, campaigns, creatives | Postgres | While the account exists | Same; campaigns are paused and apps deleted immediately and propagated to every replica |
| **Billing ledger** (campaign id, app id, event, amount, time, token hash) | Postgres `ledger` | **[7 years]** (tax/accounting) — kept after account deletion; holds no personal data | Never purged by code; archive/partition policy is an operations decision |
| Wallet entries, payouts | Postgres | **[7 years]** | As above |
| One-time tokens (email verify, reset) | Postgres | Expire in 24 h / 30 min; rows deleted 30 days after expiry | `scripts/retention.js`, daily CronJob `mobiad-retention` |
| Audit log | Postgres | **400 days** | Same job (`RETENTION_AUDIT_DAYS`) |
| Event stream | Kafka `mobiad.events` | **7 days** (must exceed the longest tolerated DB/consumer outage) | Topic `retention.ms` set by the app at creation (`KAFKA_RETENTION_DAYS`) |
| Dead letters | Kafka `mobiad.events.dlq` | 30 days | Topic `retention.ms` |
| Frequency-cap counters | Redis | ≤ 24 h | Key TTL |
| Rate-limit / click-flood counters (contain IPs) | Redis | ≤ 2 minutes | Key TTL |
| Redis dedupe keys | Redis | 24 h | Key TTL |
| Application logs (JSON) | stdout → log platform | **[30 days]** | Configure in the log platform; logs contain request ids and error text, not request bodies or IPs |
| Load-balancer / WAF logs | Infrastructure | **[30 days]** — may contain IPs | Configure at the provider |
| Backups | Provider | **[35 days]** PITR; account deletions age out of backups | Provider setting; document in the privacy policy |

## Operating notes
- Run `node scripts/retention.js` manually once after deploying to confirm it works (`removed` counts are printed).
- Erasure requests must also be applied to backups on restore (re-run deletions recorded in the audit log).
- Review this table whenever a new table or topic is added (CI does not check this automatically).
