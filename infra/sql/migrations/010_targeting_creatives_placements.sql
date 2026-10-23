-- Targeting dimensions, creative sets, reporting dimensions on the ledger, ad placements and rewarded-video configuration.
ALTER TABLE campaigns ADD COLUMN targeting JSONB NOT NULL DEFAULT '{}';
ALTER TABLE campaigns ADD COLUMN creatives JSONB NOT NULL DEFAULT '[]';

ALTER TABLE ledger ADD COLUMN creative_id TEXT NOT NULL DEFAULT '';
ALTER TABLE ledger ADD COLUMN placement_id TEXT NOT NULL DEFAULT '';
ALTER TABLE ledger ADD COLUMN country TEXT NOT NULL DEFAULT '';
ALTER TABLE ledger ADD COLUMN format TEXT NOT NULL DEFAULT '';

ALTER TABLE apps ADD COLUMN reward_callback_url TEXT;
ALTER TABLE apps ADD COLUMN reward_secret TEXT;
ALTER TABLE apps ADD COLUMN reward_amount INTEGER NOT NULL DEFAULT 1;
ALTER TABLE apps ADD COLUMN reward_item TEXT NOT NULL DEFAULT 'reward';

CREATE TABLE placements (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  name TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'banner',
  floor_ecpm DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX placements_app ON placements (app_id);
