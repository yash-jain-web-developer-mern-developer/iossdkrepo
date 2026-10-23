# Legal and compliance pack — DRAFTS FOR COUNSEL

**None of these documents is legal advice, and none makes MobiAd compliant by itself.** They describe what the software actually does today (so a lawyer can review facts instead of guessing) and give a starting structure. A qualified privacy/ad-tech lawyer in each target jurisdiction must review and adapt them before launch. Placeholders look like `[THIS]`.

| Document | Purpose |
|---|---|
| `public/privacy.html`, `public/terms.html` | User-facing drafts served at `/privacy` and `/terms` (carry a DRAFT banner; remove it only after review) |
| [ACCEPTABLE_ADVERTISING_POLICY.md](ACCEPTABLE_ADVERTISING_POLICY.md) | Content rules; mirrors what the automated screening and the review queue enforce |
| [DATA_RETENTION.md](DATA_RETENTION.md) | Retention schedule and how each period is enforced in code/config |
| [ROPA.md](ROPA.md) | GDPR Art. 30 record of processing activities, from the real data flows |
| [DPIA_DRAFT.md](DPIA_DRAFT.md) | Data-protection impact assessment draft |
| [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md) | Security/privacy incident and 72-hour breach-notification procedure |
| [DPA_TEMPLATE.md](DPA_TEMPLATE.md) | Data-processing addendum skeleton (controller/processor roles) |
| [ADS_TXT_AND_SELLERS_JSON.md](ADS_TXT_AND_SELLERS_JSON.md) | Supply-chain transparency files: what they are and templates |

## What the software already does that helps compliance
Data minimization (no profiles, no raw device ids, no IPs in the database) · purpose-limited hashed frequency-capping key (≤24 h) · consent-signal handling (GDPR/TCF string present, COPPA, limit-ad-tracking, US-privacy opt-out, child-directed apps) · terms acceptance recorded with version and time · data export and erasure endpoints and UI · audit log · retention job · MFA, scrypt, encrypted secrets, TLS-capable datastores.

## What it does NOT do (needs people/process)
Lawful-basis decisions, DPAs with every processor, DPO appointment if required, DPIA sign-off, TCF **vendor registration** and CMP integration for programmatic EU traffic, cross-border transfer mechanisms, cookie/consent UI for any future cookies, tax and money-transmission analysis for payouts, ad-fraud accreditation (MRC), app-store privacy declarations, and a published contact mailbox for `security.txt` and privacy requests.
