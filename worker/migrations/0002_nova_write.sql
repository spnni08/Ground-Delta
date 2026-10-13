-- NOVA write access (POST /nova/trades, POST /nova/trades/:id/close):
-- idempotency results (kept 24 h) and an audit trail of every write attempt.
--
--   wrangler d1 execute ground-delta-db --local  --file=./migrations/0002_nova_write.sql
--   wrangler d1 execute ground-delta-db --remote --file=./migrations/0002_nova_write.sql
--
-- Safe to re-run (CREATE ... IF NOT EXISTS). Run it BEFORE deploying the worker
-- version that serves the NOVA write routes.
CREATE TABLE IF NOT EXISTS nova_idempotency (
  key TEXT PRIMARY KEY,         -- Idempotency-Key header value
  request_hash TEXT NOT NULL,   -- SHA-256 of method + path + validated body
  status INTEGER,               -- NULL while the first request is still running
  body TEXT,                    -- the first response body (JSON)
  created_at INTEGER NOT NULL   -- epoch ms
);

CREATE TABLE IF NOT EXISTS nova_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,             -- ISO timestamp
  source TEXT NOT NULL,         -- always 'nova'
  action TEXT NOT NULL,         -- trade_add | trade_close
  uid TEXT NOT NULL,
  trade_id TEXT,
  idempotency_key TEXT,
  outcome TEXT NOT NULL,        -- ok | replay | rejected
  status INTEGER NOT NULL,      -- HTTP status returned
  detail TEXT                   -- short reason for rejections, never journal text
);
