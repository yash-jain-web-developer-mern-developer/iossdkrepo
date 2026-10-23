# Data Processing Addendum — SKELETON (DRAFT; counsel must complete)

**Parties:** `[CUSTOMER]` ("Controller") and `[COMPANY LEGAL NAME]` ("Processor"). Applies where Processor processes personal data on Controller's behalf under the Terms of Service.

1. **Subject matter and duration** — providing the MobiAd platform for the term of the agreement.
2. **Nature and purpose** — hosting campaign/app configuration, serving and measuring ads, billing; see `ROPA.md` rows 3–7.
3. **Types of personal data** — account contacts of Controller's users; transient technical data of end users (app id, country, IP for abuse limits, optional hashed device key where consent allows).
4. **Controller's instructions and consent signals** — Controller (publisher/app owner) is responsible for lawful basis and for passing accurate consent signals (`gdpr`, `gdprConsent`, `coppa`, `usPrivacy`, `limitAdTracking`) and the child-directed flag. Processor honors them as described in `docs/SDK_INTEGRATION.md`.
5. **Confidentiality** — personnel bound by confidentiality; access on least privilege.
6. **Security** — measures in `docs/LAUNCH_CHECKLIST.md` §2 and `docs/legal/DPIA_DRAFT.md` §3; no certification is claimed (e.g. ISO 27001/SOC 2) unless obtained.
7. **Sub-processors** — `[LIST: hosting, email, payments]`; Controller notified of changes `[30]` days in advance with a right to object.
8. **Assistance** — data-subject requests via the in-product export/erasure tools or support; DPIA assistance; breach notification to Controller without undue delay and within `[48]` hours of awareness (`INCIDENT_RESPONSE.md`).
9. **Return/deletion** — on termination Processor deletes account data per `DATA_RETENTION.md` (billing ledger retained as required by law, containing no personal data).
10. **Audits** — information provided on request; audits `[once per year, with notice]`.
11. **International transfers** — `[SCCs/UK Addendum/adequacy as applicable]`.
12. **Liability and governing law** — `[per Terms]`.
