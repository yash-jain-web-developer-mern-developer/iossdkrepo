-- Account security: email verification, session revocation, TOTP MFA, one-time tokens, audit log.
ALTER TABLE users ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN totp_secret_enc TEXT;
ALTER TABLE users ADD COLUMN totp_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN totp_last_step BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN recovery_hashes JSONB NOT NULL DEFAULT '[]';
CREATE TABLE IF NOT EXISTS one_time_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at BIGINT NOT NULL,
  used_at BIGINT
);
CREATE INDEX IF NOT EXISTS ott_user_idx ON one_time_tokens (user_id, purpose);
-- Append-only trail of security- and money-relevant actions. Never updated or deleted by the application.
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  at BIGINT NOT NULL,
  actor TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail JSONB
);
CREATE INDEX IF NOT EXISTS audit_at_idx ON audit_log (at);
CREATE INDEX IF NOT EXISTS audit_actor_idx ON audit_log (actor, at);
