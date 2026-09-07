-- Ground Delta backend schema (Cloudflare D1)
--
-- One JSON blob per user rather than normalized trade/strategy tables.
-- This keeps the webhook (which needs to scan "all open trades for
-- symbol X, for user Y") and the frontend sync (which reads/writes the
-- whole trades+strategies tree at once, mirroring the existing
-- localStorage shape) both simple, at the cost of not being queryable
-- via SQL directly.
--
-- `id` is the Firebase UID (the JWT's `sub` claim, verified in
-- src/index.js) — no schema change was needed to go from a single
-- shared workspace to per-user rows, since `id` was already an
-- arbitrary TEXT primary key; only the application code changed to
-- use the authenticated UID instead of a fixed 'default' string.
--
-- Phase 4 adds an `exchange_connections` table on top of this in a
-- follow-up migration (0002_exchanges.sql).

CREATE TABLE IF NOT EXISTS workspace_state (
  id TEXT PRIMARY KEY,          -- Firebase UID
  data TEXT NOT NULL,           -- JSON: { strategies: [...], trades: [...] }
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
