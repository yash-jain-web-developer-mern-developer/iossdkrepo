-- Record which version of the Terms / Privacy Policy each user accepted, and when (consent evidence).
ALTER TABLE users ADD COLUMN terms_version TEXT;
ALTER TABLE users ADD COLUMN terms_accepted_at BIGINT NOT NULL DEFAULT 0;
