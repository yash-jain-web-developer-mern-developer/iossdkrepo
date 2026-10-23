-- Creative review, brand safety, child-directed apps, fraud flags, frequency capping.
ALTER TABLE campaigns ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE campaigns ADD COLUMN review_note TEXT;
ALTER TABLE campaigns ADD COLUMN reviewed_by TEXT;
ALTER TABLE campaigns ADD COLUMN reviewed_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN category TEXT NOT NULL DEFAULT 'general';
ALTER TABLE campaigns ADD COLUMN child_safe BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE campaigns ADD COLUMN freq_cap INTEGER NOT NULL DEFAULT 0;
ALTER TABLE apps ADD COLUMN child_directed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE apps ADD COLUMN blocked_categories JSONB NOT NULL DEFAULT '[]';
ALTER TABLE apps ADD COLUMN flagged BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE apps ADD COLUMN flag_reason TEXT;
