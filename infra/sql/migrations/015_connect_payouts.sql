-- Automated publisher payouts through Stripe Connect (Express accounts). Stripe collects and verifies identity and tax details;
-- we only keep the account id and the readiness flags it reports, never documents or tax numbers.
CREATE TABLE connect_accounts (
  user_id TEXT PRIMARY KEY,
  stripe_account TEXT NOT NULL UNIQUE,
  details_submitted BOOLEAN NOT NULL DEFAULT false,
  payouts_enabled BOOLEAN NOT NULL DEFAULT false,
  charges_enabled BOOLEAN NOT NULL DEFAULT false,
  requirements TEXT NOT NULL DEFAULT '[]',   -- JSON array of what Stripe still needs
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
