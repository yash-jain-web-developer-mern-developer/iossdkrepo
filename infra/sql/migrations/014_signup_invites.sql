-- Invite-only sign-up (private beta). Codes are shown once to the admin and stored only as a hash.
CREATE TABLE signup_invites (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,                     -- advertiser | publisher
  email TEXT,                             -- optional: only this address may use the code
  note TEXT,
  max_uses INTEGER NOT NULL DEFAULT 1,
  used INTEGER NOT NULL DEFAULT 0,
  revoked BOOLEAN NOT NULL DEFAULT false,
  created_by TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
