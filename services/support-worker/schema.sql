CREATE TABLE IF NOT EXISTS support_payments (
  event_hash TEXT PRIMARY KEY,
  claim TEXT NOT NULL,
  paid_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS support_claim_expiry ON support_payments(claim, expires_at);
CREATE TABLE IF NOT EXISTS support_webhook_checks (
  provider TEXT PRIMARY KEY CHECK (provider IN ('stripe', 'kofi')),
  verified_at INTEGER NOT NULL
);
