# Plan: next feature phases

Goal: close the biggest functional gaps against a mature mobile ad platform, in the order agreed. Each phase ships with
tests, OpenAPI, SDK/UI updates and an honest status line in README and LAUNCH_CHECKLIST. A phase is **done** only when its
tests pass (hermetic suite and, for data-model changes, the real-Postgres integration run).

Out of scope here (cannot be solved with code): scale and demand relationships, MRC/TCF accreditation, lawyer review,
pen test, live payment-processor and bank integrations, managed production infrastructure.

## Phase 1 - Rich formats: video and playable (HTML5)
- Creative model: `videoUrl` (https mp4/webm/m3u8), `durationSec` (<=60), `playableUrl` (https HTML5 bundle), `cta`, `width/height`.
- Policy: https only, no credentials/`javascript:`/`data:` URLs, file-type check by extension, video length cap, playable
  always goes to manual review in production (it runs third-party code); SDKs render it in a sandboxed WebView/iframe (no top navigation, no same-origin).
- Ad response carries the rich creative; OpenRTB bid returns `adm` as VAST 4.2 for video (and a sandboxed iframe snippet for playable).
- Tracking: new event `video_complete` (`/t/v/:token`, unbilled, idempotent, counted in reports as `videoCompletes`, completion rate).
- SDKs (JS, Kotlin, Swift): expose the new creative fields and `onVideoComplete()`.
- Dashboard: campaign form fields for video/playable; reports show completes.
- Tests: policy rules, auction by format, VAST output validity, event idempotency, report column, SDK smoke tests.

## Phase 2 - Conversion events and attribution
- Campaign-level conversion definitions: event name (`install`, `purchase`, `signup`, `custom`), optional value.
- Server-to-server postback `POST /v1/conversion` (campaign API key or signed token) and the existing `/t/x/:token` pixel.
- Attribution: last-click within a configurable window (default 7 days), view-through window (default 1 day, off by default),
  dedupe per (campaign, device-key, event, id); conversions with no matching click/impression are recorded as unattributed, never billed.
- New pricing model `CPA` (pay per attributed conversion) in addition to CPM/CPC; auction uses a conservative eCPM from observed conversion rate.
- Reports: conversions, conversion rate, revenue (value), ROAS; CSV columns.
- Tests: windows, dedupe, replay, CPA billing exactness, forged tokens, privacy (no raw device ids stored).

## Phase 3 - Publisher payouts: KYC/tax status and payout workflow
- Publisher payout profile: legal name, country, payout method (bank/PayPal reference as opaque text), tax form status
  (`none` / `submitted` / `verified` / `rejected`), KYC status (same states). **No documents or tax IDs are stored in MobiAd**; only status + provider reference.
- Payout request is refused until KYC and tax status are `verified`; admin verifies via the console (manual process) and every change is audited.
- Payout state machine: `requested -> approved -> paid | rejected`, with holds on flagged apps, minimum thresholds, and idempotent mark-paid with an external reference.
- Statements: publisher payout statement CSV; admin payout export.
- Explicitly NOT built: moving real money, calling a KYC/tax vendor, withholding calculation. The interface leaves a clear seam for those.
- Tests: refusals, state machine, audit, idempotency, held earnings, CSV injection.

## Cross-cutting
- Migrations 008-009, tested on real Postgres.
- Keep `docs/openapi.yaml` in lockstep (drift test), docs/LAUNCH_CHECKLIST honest about what is verified.
- Final: full hermetic suite, real-infra integration, scanners (npm audit, Semgrep), updated README.

## Status (updated after implementation)
- Phase 1 **done**: video + playable creatives, VAST 4.2 for OpenRTB video, `/t/v` completion tracking, SDK (JS, Kotlin, Swift) and dashboard support. Verified: hermetic tests, SDK smoke tests against a live server (JVM, Linux Swift), real Postgres/Kafka run.
- Phase 2 **done**: `mobiad_click_id`, `POST /v1/conversion`, CPA model, reports. Verified the same way. View-through attribution and MMP integrations were not built.
- Phase 3 **done as a workflow**: profile, KYC/tax status, approval states, CSV export, admin UI. Real KYC/tax vendors and money movement are explicitly not built.
- Migrations 008 (conversions) and 009 (payout profiles) applied on real Postgres.
