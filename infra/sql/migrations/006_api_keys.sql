-- Customer API keys for programmatic access. Only a SHA-256 of the secret is stored (secrets are 256-bit random, so a fast hash is safe).
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  scope TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL DEFAULT 0,
  last_used_at BIGINT NOT NULL DEFAULT 0,
  revoked_at BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX api_keys_user ON api_keys (user_id);
