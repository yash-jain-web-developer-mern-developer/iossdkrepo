# Data Protection Impact Assessment — DRAFT for review

**System:** MobiAd advertising platform · **Assessor:** [NAME] · **Date:** [ ] · **Status:** draft, not signed off

## 1. Description
Contextual mobile advertising: advertisers fund campaigns, publishers register apps, an auction picks an ad per request, impressions/clicks are billed from an append-only ledger. See `ROPA.md` for the data flows.

## 2. Necessity and proportionality
- **No profiling:** ads are chosen from app, country, format, category and price only. There is no user-level targeting.
- **Minimal data about end users:** app id, coarse country, format, consent flags; IP only transiently for abuse limits. The optional device id is used solely as a 24-hour hashed counter key for frequency capping and is ignored for children, COPPA, GDPR-without-consent, limit-ad-tracking and US opt-outs.
- **Purpose limitation and retention:** see `DATA_RETENTION.md`; ledger rows contain no personal data.

## 3. Risks and mitigations
| Risk | Likelihood | Severity | Mitigation in place | Residual / action |
|---|---|---|---|---|
| Account takeover of advertiser/publisher accounts | Medium | High (money, data) | scrypt, per-IP and per-account throttling, MFA (mandatory for admins), session revocation, reset needs MFA, audit log | Offer mandatory MFA for payouts **[decision]** |
| Re-identification via device key | Low | Medium | Hash includes app, day and a server secret; counter only; never stored | Keep secret in a secrets manager; rotate yearly |
| Unlawful processing of children's data | Low–Medium | High | Child-directed flag disables device ids and restricts to child-safe ads; restricted categories never child-safe | Counsel review of the declaration flow; consider verification of declarations |
| Disclosure of billing/personal data in a breach | Low | High | TLS, least-privilege access, no PII in ledger, backups encrypted by provider | Pen test (not yet done) |
| Advertiser content causing harm to end users | Medium | Medium | Automated URL/content screening, mandatory human review in production, takedown by admin, audit trail | Add safe-browsing reputation lookups **[not built]** |
| Over-retention | Medium | Low | Retention job, Kafka retention, Redis TTLs | Verify provider log/backup retention **[ops]** |
| Cross-border transfers | Depends | Medium | n/a in software | Choose regions; SCCs/DPAs with processors **[legal]** |

## 4. Consultation and sign-off
DPO opinion: [ ] · Supervisory authority prior consultation needed: [ ] · Approved by: [ ] on [ ]
