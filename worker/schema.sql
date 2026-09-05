-- Ground Delta backend schema (Cloudflare D1) — Phase 3
--
-- Single-user app, so state is stored as one JSON blob per workspace
-- rather than normalized trade/strategy tables. This keeps the webhook
-- (which needs to scan "all open trades for symbol X") and the frontend
-- sync (which reads/writes the whole trades+strategies tree at once,
-- mirroring the existing localStorage shape) both simple, at the cost
-- of not being queryable via SQL directly.
--
-- Phase 4 adds an `exchange_connections` table on top of this in a
-- follow-up migration (0002_exchanges.sql).

CREATE TABLE IF NOT EXISTS workspace_state (
  id TEXT PRIMARY KEY,          -- always 'default' for now (single workspace)
  data TEXT NOT NULL,           -- JSON: { strategies: [...], trades: [...] }
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
