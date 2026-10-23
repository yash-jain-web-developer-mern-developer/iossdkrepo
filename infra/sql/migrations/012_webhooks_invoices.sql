-- Customer webhooks (signed, retried), invoices and credit notes.
CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  failures INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX webhooks_user ON webhooks (user_id);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at BIGINT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at BIGINT NOT NULL DEFAULT 0,
  delivered_at BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (status, next_at);
CREATE INDEX webhook_deliveries_hook ON webhook_deliveries (webhook_id, created_at);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  period TEXT NOT NULL,
  total_micros BIGINT NOT NULL,
  lines JSONB NOT NULL DEFAULT '[]',
  issued_at BIGINT NOT NULL,
  UNIQUE (user_id, period)
);

CREATE TABLE credit_notes (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  amount_micros BIGINT NOT NULL,
  reason TEXT NOT NULL,
  invoice_id TEXT,
  issued_at BIGINT NOT NULL,
  issued_by TEXT
);
CREATE INDEX credit_notes_user ON credit_notes (user_id);
