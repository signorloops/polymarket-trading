CREATE TABLE IF NOT EXISTS order_idempotency (
  key TEXT PRIMARY KEY,
  request_hash CHAR(64) NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('claimed', 'submitted', 'unknown', 'terminal')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  exchange_order_id TEXT,
  terminal_status TEXT CHECK (
    terminal_status IS NULL OR terminal_status IN ('filled', 'cancelled', 'rejected')
  ),
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS order_idempotency_unresolved_idx
  ON order_idempotency (created_at, key)
  WHERE state <> 'terminal';
