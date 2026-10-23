-- Team members: a member user belongs to an account owner (account_id) and acts on that account's data with a limited role.
ALTER TABLE users ADD COLUMN account_id TEXT;
ALTER TABLE users ADD COLUMN team_role TEXT;
CREATE TABLE team_invites (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  email TEXT NOT NULL,
  team_role TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at BIGINT NOT NULL,
  used_at BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX team_invites_account ON team_invites (account_id);
CREATE INDEX users_account ON users (account_id);
