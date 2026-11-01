# MobiAd: handover for the developer who sets it up

MobiAd is an ad platform: advertisers fund campaigns on a website, publishers (app developers) earn by showing ads through an SDK, an admin
controls the money, and end users see ads inside a mobile app. It is a Node.js server (no framework, one small `npm` dependency list), a
web app in `public/`, SDKs for JavaScript, Android (Kotlin) and iOS (Swift) in `sdk/`, and an example for connecting your own app. There is **no demo data and no demo app** in this project: it starts empty.

**Read first:** `docs/LAUNCH_CHECKLIST.md` (what is verified and what is not) and the investor PDF `MobiAd-Investor-Story.pdf` (the whole flow with screenshots).

## 1. Run it on one computer in 5 minutes (empty, nothing preloaded)
Needs: **Node.js 20 or newer** (18 works). Nothing else.
```bash
git clone https://github.com/yash-jain-web-developer-mern-developer/iossdkrepo.git
cd iossdkrepo
npm ci
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long passphrase 123' npm start
```
Open http://localhost:8080 . It starts empty: sign up your own advertiser and publisher in the browser; the admin is the email and password above.
Data is in memory and disappears when you stop it. **Connecting your own app and phone, step by step: `docs/CONNECT_YOUR_APP.md`.** Check everything works: `npm test` (about 180 tests, 10 seconds, needs no Docker).

## 2. Let testers use it with fake money (recommended next step)
Testers need a public address, a database that keeps data, and Stripe's **test mode** (test cards only, no real money).

1. **Hosting:** any small Linux server or container host with Node 20+ and a Postgres database (Postgres 14+). Put it behind HTTPS (Caddy, nginx or the host's own TLS).
2. **Environment variables** (never commit them):
   ```
   NODE_ENV=development                     # keeps test conveniences; use production only after the checklist is done
   PORT=8080
   PUBLIC_URL=https://YOUR-ADDRESS          # exactly the public address
   MOBIAD_SECRET=<64 random characters>     # openssl rand -hex 32
   DATABASE_URL=postgres://user:pass@host:5432/mobiad
   PAYMENTS_MODE=stripe
   STRIPE_SECRET_KEY=sk_test_...            # TEST key from the Stripe dashboard (test mode), never a live key yet
   STRIPE_WEBHOOK_SECRET=whsec_...          # from the webhook in step 3
   INVITE_ONLY=false                        # true = sign-up needs an admin-created invite code
   ```
   Start with `npm start` (migrations run automatically). Create the first admin: `DATABASE_URL=... ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long passphrase' node scripts/create-admin.js`.
3. **Stripe webhook** (Stripe dashboard, test mode, Developers, Webhooks): endpoint `https://YOUR-ADDRESS/api/webhooks/stripe`, events
   `checkout.session.completed, checkout.session.async_payment_succeeded, checkout.session.async_payment_failed, checkout.session.expired, payment_intent.payment_failed, charge.refunded, charge.dispute.created, charge.dispute.closed`
   (and `account.updated` and `transfer.reversed` as **Connect** events if you use automated payouts). Copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
4. **Test cards:** `4242 4242 4242 4242` works; `4000 0000 0000 0002` is declined; `4000 0027 6000 3184` asks for 3-D Secure. Any future date, any CVC.
5. **Automated publisher payouts (optional):** enable Connect in the Stripe dashboard (test mode), then add `PAYOUTS_MODE=stripe_connect`, `AUTO_PAYOUT_MAX_USD=25`, `PAYOUT_HOLD_DAYS=0` (7 is the production default). Publishers onboard on Stripe's hosted page using "use test data". Stripe only onboards publishers in some countries for a US platform (GB, DE and US worked; India was refused): others need manual payouts.
6. **Email:** set `SMTP_URL` (any SMTP service) or verification and invite emails are only logged. For a quick test set `REQUIRE_EMAIL_VERIFICATION=false`.
7. **Optional for scale:** `REDIS_URL` and `KAFKA_BROKERS` (see `infra/docker-compose.deps.yml` for a local copy). Not needed for a tester trial.

Alternative with Docker: `docker build -t mobiad .` then run it with the variables above. `infra/k8s/` has Kubernetes manifests, `docs/RUNBOOK.md` the deployment steps.

## 3. Apps for phones
* **Your own app:** follow `docs/CONNECT_YOUR_APP.md` (USB with `adb reverse`, or Wi-Fi). A small code example is in `sdk/android/examples/MinimalIntegration.kt`.
* **Android SDK** (library, AAR): `sdk/android/` (`gradle assembleRelease`). **JavaScript SDK:** `sdk/js/`. Integration guide: `docs/SDK_INTEGRATION.md`.
* **iOS:** `sdk/ios/` (Swift package). It builds on a Mac and its smoke test passes against a live server in the GitHub Actions workflow `.github/workflows/ios.yml`. It was also run inside an iOS simulator with a small demo app (since removed from this project; it is in the git history); it has **not** been run on a physical iPhone.

## 4. Before real money (not needed for a fake-money trial)
Stripe live mode test (one small real payment, refund, webhook), tax advisor review of invoices, penetration test, lawyer review of terms and privacy, managed Postgres/Redis/Kafka with backups, `NODE_ENV=production` (it refuses to start with unsafe settings), `INVITE_ONLY=true`. Details in `docs/LAUNCH_CHECKLIST.md`.

## 5. Where things are
`src/` server (`api/` routes, `adserver/` auction and tracking, `billing/` Stripe and tax, `db/repo.js` all SQL), `public/` web app, `infra/sql/migrations/` database,
`test/` automated tests, `docs/openapi.yaml` the API, `scripts/` admin creation, connection self-check, SDK smoke-test server. GitHub Actions in `.github/workflows/` run tests, security scans, the OpenAPI lint, integration tests with real Postgres/Redis/Kafka/mail, and the iOS build and simulator run.

## 6. Secrets
Never put keys in files or chat. Stripe keys, `MOBIAD_SECRET`, database passwords and webhook secrets go into the host's environment settings only. If a key was ever shared, roll it in the Stripe dashboard.
