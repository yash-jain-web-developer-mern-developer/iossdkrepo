-- Payment lifecycle (attempts, failures, refunds, disputes) and tax invoices.
-- wallet_entries stays the single source of truth for the balance; these tables explain *why* an entry exists and let us refund exactly.
CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,                 -- stripe | test
  session_id TEXT UNIQUE,                 -- Stripe Checkout Session id (or a test id)
  payment_intent TEXT,                    -- Stripe PaymentIntent id: needed to refund and to match disputes
  amount_micros BIGINT NOT NULL,          -- what was (or will be) paid, USD
  refunded_micros BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL,                   -- pending | paid | failed | expired | partially_refunded | refunded | disputed | dispute_lost
  failure TEXT,                           -- last failure message from the provider
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX payments_user ON payments (user_id);
CREATE INDEX payments_intent ON payments (payment_intent);

CREATE TABLE disputes (
  id TEXT PRIMARY KEY,                    -- Stripe dispute id (dp_...)
  payment_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  amount_micros BIGINT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL,                   -- needs_response | under_review | won | lost | warning_closed ...
  created_at BIGINT NOT NULL,
  closed_at BIGINT
);
CREATE INDEX disputes_payment ON disputes (payment_id);

-- Stripe does not guarantee delivery order: a refund or dispute event can arrive before the "paid" event that tells us the PaymentIntent.
-- Such events are parked here (idempotent on Stripe's event id) and replayed as soon as the payment is known. Old rows are purged.
CREATE TABLE stripe_deferred (
  id TEXT PRIMARY KEY,                    -- Stripe event id
  payment_intent TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX stripe_deferred_intent ON stripe_deferred (payment_intent);

CREATE TABLE billing_profiles (
  user_id TEXT PRIMARY KEY,
  legal_name TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  tax_id TEXT NOT NULL DEFAULT '',
  updated_at BIGINT NOT NULL
);

-- Tax invoices. Older invoices keep subtotal_micros NULL (no tax shown); total_micros stays the amount paid (tax-inclusive).
ALTER TABLE invoices ADD COLUMN subtotal_micros BIGINT;
ALTER TABLE invoices ADD COLUMN tax_micros BIGINT NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN tax_rate_bp INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN tax_label TEXT;
ALTER TABLE invoices ADD COLUMN tax_note TEXT;
ALTER TABLE invoices ADD COLUMN seller JSONB;
ALTER TABLE invoices ADD COLUMN buyer JSONB;
ALTER TABLE credit_notes ADD COLUMN tax_micros BIGINT NOT NULL DEFAULT 0;
ALTER TABLE credit_notes ADD COLUMN tax_rate_bp INTEGER NOT NULL DEFAULT 0;
