# Security and privacy incident response (DRAFT — assign real owners and rehearse it)

**Roles (fill in):** Incident Commander `[ ]` · Engineering lead `[ ]` · Privacy/DPO `[ ]` · Communications `[ ]` · Legal counsel `[ ]`

## 1. Detect and triage (target: within 1 hour of an alert)
Sources: Prometheus alerts (`docs/RUNBOOK.md`), audit-log anomalies (`/api/admin/audit`), user reports to the `security.txt` contact, provider notices. Classify: **SEV1** personal-data exposure, billing-data loss or integrity failure, account-takeover wave, full outage · **SEV2** partial outage, suspected exposure · **SEV3** contained issue.

## 2. Contain (first hours)
- Revoke sessions: bump `token_version` for affected users (`POST /api/logout-all` per user, or SQL `UPDATE users SET token_version = token_version + 1`). Rotating `MOBIAD_SECRET` invalidates every JWT and tracking token.
- Disable a compromised publisher/advertiser: flag apps (`/api/admin/apps/flag`), pause campaigns, reject via `/api/admin/campaigns/review`.
- Block abusive traffic at the edge/WAF; scale or shed load.
- Preserve evidence: do not delete logs; snapshot affected databases; export the audit log.

## 3. Assess a personal-data breach
Ask: was personal data accessed, disclosed, altered, lost or destroyed? Which data (see `ROPA.md`: account emails and hashes are the main personal data; the ledger has none), how many people, which jurisdictions, is it likely to result in risk to individuals?

## 4. Notify (clock starts when you become aware)
| Who | When | Notes |
|---|---|---|
| Supervisory authority (GDPR Art. 33) | **Within 72 hours** unless unlikely to result in risk | Include nature, categories/approx. numbers, contact, consequences, measures. Phase it if details are still unknown |
| Affected individuals (Art. 34) | Without undue delay if high risk | Plain language, what to do (reset password, enable MFA) |
| Customers/processors per contract | Per DPA | |
| Other regimes (US state laws, UK ICO, etc.) | As applicable — **counsel decides** | |

## 5. Recover and learn
Fix root cause, rotate secrets, restore from backups if needed (`docs/RUNBOOK.md`), write a blameless post-mortem within 5 working days, add a regression test (every chaos-found bug in this repo has one), update this plan.

## 6. Rehearse
Run a tabletop exercise before launch and every 6 months. Record date, participants, findings: `[ ]`.
