-- Conversion tracking and attribution. Billing for CPA campaigns goes through the ledger (event 'conversion'); this table holds the details.
ALTER TABLE campaigns ADD COLUMN conversions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN conversion_event TEXT NOT NULL DEFAULT 'install';
ALTER TABLE campaigns ADD COLUMN attribution_days INTEGER NOT NULL DEFAULT 7;
CREATE TABLE conversions (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  event TEXT NOT NULL,
  event_id TEXT NOT NULL DEFAULT '',
  value_micros BIGINT NOT NULL DEFAULT 0,
  token_hash TEXT NOT NULL UNIQUE,
  day TEXT NOT NULL,
  at BIGINT NOT NULL
);
CREATE INDEX conversions_campaign_day ON conversions (campaign_id, day);
