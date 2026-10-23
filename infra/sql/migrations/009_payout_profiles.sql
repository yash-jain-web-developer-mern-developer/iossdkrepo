-- Publisher payout profile + verification STATUS. MobiAd never stores identity documents, tax IDs or full bank numbers:
-- those stay with the (external) KYC/tax provider or the finance team; here we keep only the outcome and an opaque reference.
CREATE TABLE payout_profiles (
  user_id TEXT PRIMARY KEY,
  legal_name TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT '',
  method_ref TEXT NOT NULL DEFAULT '',
  kyc_status TEXT NOT NULL DEFAULT 'none',
  tax_status TEXT NOT NULL DEFAULT 'none',
  review_note TEXT,
  updated_at BIGINT NOT NULL DEFAULT 0
);
ALTER TABLE payouts ADD COLUMN reference TEXT;
ALTER TABLE payouts ADD COLUMN approved_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE payouts ADD COLUMN resolved_by TEXT;
