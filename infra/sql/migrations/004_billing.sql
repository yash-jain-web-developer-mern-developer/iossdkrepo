-- Advertiser wallet and publisher payouts. All amounts are integer micro-USD (USD * 1,000,000).
-- Wallet balance is DERIVED: SUM(wallet_entries) - SUM(ledger spend). No hot balance row to contend on.
CREATE TABLE IF NOT EXISTS wallet_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,             -- topup | refund | adjustment
  amount_micros BIGINT NOT NULL,  -- signed: refunds/adjustments may be negative
  provider TEXT,
  provider_ref TEXT UNIQUE,       -- idempotency key from the payment provider (webhook retries cannot double-credit)
  note TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS wallet_user_idx ON wallet_entries (user_id);
CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount_micros BIGINT NOT NULL,
  status TEXT NOT NULL,           -- requested | paid | rejected
  note TEXT,
  created_at BIGINT NOT NULL,
  resolved_at BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS payouts_user_idx ON payouts (user_id);
