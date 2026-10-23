// Validated runtime configuration. Fails fast on unsafe production settings.
const bool = (v, dflt) => (v == null || v === '' ? dflt : /^(1|true|yes|on)$/i.test(String(v)));
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
// {"GB":20,"DEFAULT":0} -> {GB:20,DEFAULT:0}; empty -> {}; anything invalid -> null (reported as a config error)
const parseRates = (v) => {
  if (!v) return {};
  try { const o = JSON.parse(v); const out = {}; if (!o || typeof o !== 'object' || Array.isArray(o)) return null; for (const [k, r] of Object.entries(o)) { if (!/^([A-Z]{2}|DEFAULT)$/.test(k) || typeof r !== 'number' || !(r >= 0 && r <= 100)) return null; out[k] = r; } return out; } catch { return null; }
};

export function loadConfig(env = process.env) {
  const prod = env.NODE_ENV === 'production';
  const cfg = {
    prod,
    port: +env.PORT || 8080,
    publicUrl: env.PUBLIC_URL || `http://localhost:${+env.PORT || 8080}`,
    secret: env.MOBIAD_SECRET || '',
    previousSecret: env.MOBIAD_SECRET_PREVIOUS || '',   // key rotation window: set to the OLD secret while rolling out a new MOBIAD_SECRET
    databaseUrl: env.DATABASE_URL || '',   // empty => embedded in-memory Postgres (dev/test only)
    databaseSsl: bool(env.DATABASE_SSL, false),
    redisUrl: env.REDIS_URL || '',         // empty => in-process counters (single instance only). Use rediss:// for TLS.
    corsOrigins: list(env.CORS_ORIGINS),
    rateLimit: +env.RATE_LIMIT_PER_MIN || 600,   // ad requests per client IP per minute
    trustProxyHops: +env.TRUST_PROXY_HOPS || 0,  // number of trusted reverse proxies in front
    metricsToken: env.METRICS_TOKEN || '',
    kafkaBrokers: list(env.KAFKA_BROKERS),       // empty => in-memory queue (weaker durability)
    kafkaTopic: env.KAFKA_TOPIC || 'mobiad.events',
    kafkaPartitions: +env.KAFKA_PARTITIONS || 6,
    kafkaReplication: +env.KAFKA_REPLICATION || 1,
    kafkaRetentionDays: +env.KAFKA_RETENTION_DAYS || 7,   // must exceed the longest tolerable consumer/DB outage
    kafkaSsl: bool(env.KAFKA_SSL, false),
    kafkaSasl: env.KAFKA_SASL_USERNAME ? { mechanism: env.KAFKA_SASL_MECHANISM || 'scram-sha-256', username: env.KAFKA_SASL_USERNAME, password: env.KAFKA_SASL_PASSWORD || '' } : null,
    publisherShare: env.PUBLISHER_SHARE ? +env.PUBLISHER_SHARE : 0.7,
    catalogRefreshMs: +env.CATALOG_REFRESH_MS || 2000,

    // --- account security ---
    requireEmailVerification: bool(env.REQUIRE_EMAIL_VERIFICATION, prod), // unverified users cannot create campaigns/apps or add funds
    requireAdminMfa: bool(env.REQUIRE_ADMIN_MFA, prod),
    requireTermsAcceptance: bool(env.REQUIRE_TERMS_ACCEPTANCE, prod),     // signup must carry an explicit acceptance of the current Terms/Privacy Policy
    termsVersion: env.TERMS_VERSION || '2026-10-DRAFT',                    // bump when the legal documents change materially                   // admin APIs need an MFA-enabled admin account
    smtpUrl: env.SMTP_URL || '',                                          // e.g. smtp://user:pass@smtp.example.com:587
    mailFrom: env.MAIL_FROM || 'MobiAd <no-reply@localhost>',

    // --- advertising policy ---
    autoApproveCampaigns: bool(env.AUTO_APPROVE_CAMPAIGNS, !prod),        // production: every campaign is reviewed by a human
    requireHttpsCreatives: bool(env.REQUIRE_HTTPS_CREATIVES, prod),
    blockedDomains: list(env.BLOCKED_DOMAINS),
    sellerId: env.SELLER_ID || '', sellerDomain: env.SELLER_DOMAIN || '', sellerContact: env.SELLER_CONTACT || '',
    webhookIntervalMs: +env.WEBHOOK_INTERVAL_MS || 2000,
    inviteOnly: bool(env.INVITE_ONLY, prod),  // sign-up needs an invite code from an admin (private beta). On by default in production.
    demoMode: bool(env.DEMO_MODE, false),   // shows a "Demo data" badge in the dashboard; scripts/demo.mjs turns it on
    tcfVendorId: Math.max(0, Math.floor(+env.TCF_VENDOR_ID || 0)),   // our IAB Global Vendor List id (0 = do not check the vendor list)
    allowPrivateCallbacks: bool(env.ALLOW_PRIVATE_CALLBACKS, false), // reward callbacks / webhooks / partner bidders to private addresses (tests and local dev only)
    fraudScanMs: +env.FRAUD_SCAN_MS || 5 * 60_000,

    // --- money ---
    paymentsMode: env.PAYMENTS_MODE || (prod ? 'none' : 'test'),          // none | test (instant fake credit, never in prod) | stripe
    requireFunding: bool(env.REQUIRE_FUNDING, prod),                      // campaign budgets must be covered by wallet balance
    stripeSecretKey: env.STRIPE_SECRET_KEY || '',
    stripeApiBase: (env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/+$/, ''), // only for testing against stripe-mock; production must use the real API
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    minTopupUsd: +env.MIN_TOPUP_USD || 10,
    stripePlatformCountry: (env.STRIPE_PLATFORM_COUNTRY || 'US').toUpperCase(), // country of YOUR Stripe account: publishers elsewhere are onboarded as cross-border recipients
    minPayoutUsd: +env.MIN_PAYOUT_USD || 50,
    payoutHoldDays: env.PAYOUT_HOLD_DAYS != null && env.PAYOUT_HOLD_DAYS !== '' ? Math.floor(+env.PAYOUT_HOLD_DAYS) : (prod ? 7 : 0), // earnings of the last N days are not payable yet, so advertiser chargebacks and refunds arrive before the money leaves (default 7 in production)
    requirePayoutVerification: bool(env.REQUIRE_PAYOUT_VERIFICATION, prod), // payouts need verified KYC + tax status (always in production)
    payoutsMode: env.PAYOUTS_MODE || 'manual',                            // manual (an admin sends the money and records the reference) | stripe_connect (Stripe pays publishers)
    autoPayoutMaxUsd: Math.max(0, +env.AUTO_PAYOUT_MAX_USD || 0),         // stripe_connect: payouts up to this amount are approved and sent automatically for verified publishers (0 = every payout needs an admin)
    disputeFeeUsd: Math.max(0, +env.DISPUTE_FEE_USD || 0),                // charged to the advertiser's wallet when a card dispute is LOST (0 = absorb it)

    // --- tax invoices (a mechanism, not tax advice: rates and rules must be set with your tax advisor) ---
    //   none      invoices carry no tax lines (default)
    //   inclusive amounts already paid are gross; the invoice shows net + tax extracted at the buyer country's rate
    taxMode: env.TAX_MODE || 'none',
    taxRates: parseRates(env.TAX_RATES_JSON),                              // {"GB":20,"IN":18,"DEFAULT":0}: percent by buyer country
    taxLabel: env.TAX_LABEL || 'VAT',
    taxSeller: { name: env.TAX_SELLER_NAME || '', address: env.TAX_SELLER_ADDRESS || '', country: String(env.TAX_SELLER_COUNTRY || '').toUpperCase(), taxId: env.TAX_SELLER_ID || '' },
    taxReverseCharge: bool(env.TAX_REVERSE_CHARGE, false),                 // B2B sale to a buyer abroad with a tax id: 0% and a reverse-charge note
  };
  const errs = [];
  if (!['manual', 'stripe_connect'].includes(cfg.payoutsMode)) errs.push('PAYOUTS_MODE must be manual or stripe_connect');
  if (cfg.payoutsMode === 'stripe_connect' && !cfg.stripeSecretKey) errs.push('PAYOUTS_MODE=stripe_connect needs STRIPE_SECRET_KEY');
  if (!['none', 'inclusive'].includes(cfg.taxMode)) errs.push('TAX_MODE must be none or inclusive');
  if (cfg.taxRates === null) errs.push('TAX_RATES_JSON must be a JSON object like {"GB":20,"DEFAULT":0} with rates between 0 and 100');
  if (cfg.taxMode !== 'none' && (!cfg.taxSeller.name || !cfg.taxSeller.address || !/^[A-Z]{2}$/.test(cfg.taxSeller.country) || !cfg.taxSeller.taxId)) errs.push('TAX_MODE needs TAX_SELLER_NAME, TAX_SELLER_ADDRESS, TAX_SELLER_COUNTRY (2 letters) and TAX_SELLER_ID');
  if (prod) {
    if (cfg.secret.length < 32) errs.push('MOBIAD_SECRET must be >= 32 chars in production');
    if (!cfg.databaseUrl) errs.push('DATABASE_URL is required in production');
    if (!cfg.redisUrl) errs.push('REDIS_URL is required in production');
    if (cfg.metricsToken.length < 16) errs.push('METRICS_TOKEN (>=16 chars) is required in production so /metrics is not public');
    if (!cfg.kafkaBrokers.length) errs.push('KAFKA_BROKERS is required in production (events must survive pod crashes)');
    if (!/^https:\/\//.test(cfg.publicUrl)) errs.push('PUBLIC_URL must be https in production');
    if (!cfg.smtpUrl) errs.push('SMTP_URL is required in production (email verification and password reset)');
    if (!cfg.requireEmailVerification) errs.push('REQUIRE_EMAIL_VERIFICATION cannot be disabled in production');
    if (cfg.stripeApiBase !== 'https://api.stripe.com') errs.push('STRIPE_API_BASE must be https://api.stripe.com in production');
    if (cfg.demoMode) errs.push('DEMO_MODE cannot be enabled in production');
    if (cfg.allowPrivateCallbacks) errs.push('ALLOW_PRIVATE_CALLBACKS cannot be enabled in production');
    if (!cfg.requirePayoutVerification) errs.push('REQUIRE_PAYOUT_VERIFICATION cannot be disabled in production');
    if (!cfg.requireTermsAcceptance) errs.push('REQUIRE_TERMS_ACCEPTANCE cannot be disabled in production');
    if (cfg.autoApproveCampaigns) errs.push('AUTO_APPROVE_CAMPAIGNS cannot be enabled in production (campaigns need human review)');
    if (cfg.paymentsMode === 'test') errs.push('PAYMENTS_MODE=test (fake credits) is not allowed in production');
  }
  if (cfg.previousSecret && cfg.previousSecret.length < 32) errs.push('MOBIAD_SECRET_PREVIOUS must be >= 32 chars');
  if (!['none', 'test', 'stripe'].includes(cfg.paymentsMode)) errs.push('PAYMENTS_MODE must be none, test or stripe');
  if (cfg.paymentsMode === 'stripe' && (!cfg.stripeSecretKey || !cfg.stripeWebhookSecret)) errs.push('PAYMENTS_MODE=stripe needs STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET');
  if (!(cfg.payoutHoldDays >= 0 && cfg.payoutHoldDays <= 90)) errs.push('PAYOUT_HOLD_DAYS must be between 0 and 90');
  if (!(cfg.publisherShare > 0 && cfg.publisherShare < 1)) errs.push('PUBLISHER_SHARE must be between 0 and 1');
  if (errs.length) throw new Error('Invalid configuration:\n - ' + errs.join('\n - '));
  return cfg;
}
