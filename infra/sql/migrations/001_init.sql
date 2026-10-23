CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  format TEXT NOT NULL,
  model TEXT NOT NULL,
  bid DOUBLE PRECISION NOT NULL,
  budget DOUBLE PRECISION NOT NULL,
  daily_budget DOUBLE PRECISION NOT NULL DEFAULT 0,
  countries JSONB NOT NULL,
  platforms JSONB NOT NULL,
  ends_at BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  creative JSONB NOT NULL,
  spent DOUBLE PRECISION NOT NULL DEFAULT 0,
  impressions BIGINT NOT NULL DEFAULT 0,
  clicks BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  floor_ecpm DOUBLE PRECISION NOT NULL DEFAULT 0
);
-- Append-only billing ledger: source of truth for spend. token_hash UNIQUE makes writes idempotent.
-- amount_micros = USD * 1,000,000 (integer money avoids float drift).
CREATE TABLE IF NOT EXISTS ledger (
  id BIGSERIAL PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  event TEXT NOT NULL,
  amount_micros BIGINT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  day TEXT NOT NULL,
  at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_campaign_idx ON ledger (campaign_id, day);
CREATE INDEX IF NOT EXISTS ledger_app_idx ON ledger (app_id, day);
