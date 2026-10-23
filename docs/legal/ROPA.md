# Record of Processing Activities (GDPR Art. 30) — DRAFT

Controller: **[COMPANY LEGAL NAME]**, [ADDRESS] · Contact: **[PRIVACY CONTACT]** · DPO (if required): **[NAME]**

| # | Activity | Data subjects | Personal data | Purpose | Lawful basis (counsel to confirm) | Recipients / processors | Transfers | Retention | Security measures |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Account management | Advertiser and publisher users | Email, password hash, role, terms acceptance, verification flag | Provide the service, authenticate, communicate | Contract | Hosting **[ ]**, email provider **[ ]** | **[ ]** | Life of account | scrypt, TLS, MFA, RBAC, audit log |
| 2 | Account security | Users | Encrypted TOTP secret, hashed recovery codes, audit events (account id, action, time), hash of email on failed login | Prevent unauthorised access | Legitimate interests | Hosting | **[ ]** | 400 days (audit) | AES-256-GCM, access control |
| 3 | Campaign & app management | Users (and company contacts) | Campaign/app configuration, creative URLs | Provide the service | Contract | Hosting | **[ ]** | Life of account | RBAC, tenant isolation |
| 4 | Billing and payouts | Users | Wallet entries, spend, payout requests (bank details are **not** collected by the software yet) | Charge advertisers, pay publishers | Contract; legal obligation | Payment processor **[Stripe]** | **[ ]** | **[7 years]** | Integer-micros ledger, idempotent writes, audit log |
| 5 | Ad serving (contextual) | End users of apps | App id, country, format, consent flags; IP (transient) | Select and deliver an ad | Legitimate interests; honors consent signals | Hosting | **[ ]** | Not stored with identity | No profiling; IP only in memory/cache |
| 6 | Frequency capping | End users (only where consent allows) | Hashed device key (device id + app + day + secret) as a counter key | Limit repeats of an ad | Consent / legitimate interests per jurisdiction | Redis (hosting) | **[ ]** | ≤ 24 h | Raw id never stored; daily-rotating hash |
| 7 | Invalid-traffic detection | End users, publishers | IP (transient counters), click timing, impression/click counts per app | Prevent fraud, protect advertisers | Legitimate interests | Hosting | **[ ]** | ≤ 2 min (IP); aggregate counts in ledger | Rules-based; human review before holding earnings |
| 8 | Transactional email | Users | Email address, message content | Verification, resets, notices | Contract | Email provider | **[ ]** | Per provider **[ ]** | TLS to SMTP |

**Special categories / children:** the platform stores no special-category data. For child-directed apps device identifiers are ignored and only child-safe ads are eligible; counsel to confirm COPPA/GDPR-K obligations for the apps your publishers register.
