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

-- Admin panel (src/index.js /admin/* routes) — every write an admin
-- makes to another user's workspace_state is appended here, never
-- overwritten, so there's always a record of who changed what and when.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_uid TEXT NOT NULL,      -- who made the change (always the single admin UID)
  target_uid TEXT NOT NULL,     -- whose workspace_state row was written
  version_after INTEGER NOT NULL,
  data_after TEXT NOT NULL,     -- full JSON snapshot post-write, for auditability
  created_at TEXT NOT NULL
);
