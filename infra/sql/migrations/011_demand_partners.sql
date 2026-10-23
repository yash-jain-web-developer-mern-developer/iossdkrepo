-- External demand partners (DSPs reached over OpenRTB) for the unified auction. Revenue from them is booked in the ledger under
-- campaign_id = 'ext_<partner id>', so publisher earnings are derived exactly like for MobiAd's own campaigns and advertiser wallets are untouched.
CREATE TABLE demand_partners (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  endpoint_url TEXT NOT NULL,
  auth_header TEXT,
  timeout_ms INTEGER NOT NULL DEFAULT 150,
  formats JSONB NOT NULL DEFAULT '[]',
  child_safe BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'active',
  created_at BIGINT NOT NULL DEFAULT 0
);
