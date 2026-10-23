-- Evidence sent to Stripe for a card dispute (what, when, by whom). The evidence text itself is kept in the audit log.
ALTER TABLE disputes ADD COLUMN evidence_status TEXT;      -- draft | submitted
ALTER TABLE disputes ADD COLUMN evidence_at BIGINT;
ALTER TABLE disputes ADD COLUMN evidence_by TEXT;
