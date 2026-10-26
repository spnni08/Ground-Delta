-- Initial D1 schema (idempotent: every statement is CREATE TABLE IF NOT EXISTS).
-- Replaces the former schema.sql + 0001_admin_panel.sql + 0002_nova_write.sql.
-- Applied via `wrangler d1 migrations apply ground-delta-db --remote`; databases
-- created by the old files already contain these tables, so this is a no-op there.
-- Note: trades live as JSON inside workspace_state.data ({ strategies, trades }),
-- there is no separate trade table.

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

-- Admin panel (src/index.js /admin/* routes) — every admin action
-- (not just state edits: block/unblock, create-user, revoke-sessions,
-- reset-password, delete-user too) is appended here, never
-- overwritten, so there's always a record of who did what and when.
-- `action` distinguishes them ('edit' for the original /admin/state
-- PUT path). NOTE: if you already have a deployed DB from before this
-- column existed, CREATE TABLE IF NOT EXISTS below is a no-op against
-- it — run migrations/0001_admin_panel.sql once against that DB instead
-- (it ALTERs the existing table rather than recreating it).
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_uid TEXT NOT NULL,      -- who made the change (always the single admin UID)
  target_uid TEXT NOT NULL,     -- whose account/row was affected
  action TEXT NOT NULL DEFAULT 'edit',  -- edit | create-user | block | unblock | revoke-sessions(-attempt) | reset-password(-attempt) | delete-user(-attempt)
  version_after INTEGER NOT NULL DEFAULT 0,
  data_after TEXT NOT NULL DEFAULT '{}', -- context snapshot post-action, for auditability (full state JSON for 'edit', small metadata for the rest)
  created_at TEXT NOT NULL
);

-- Per-user admin metadata that doesn't belong in workspace_state (which
-- is keyed 1:1 to synced trade data and gets copied around by the
-- legacy-row migration). One row per Firebase UID the admin has ever
-- blocked, created, or that has synced at least once since this table
-- was added.
CREATE TABLE IF NOT EXISTS admin_users (
  uid TEXT PRIMARY KEY,           -- Firebase UID
  blocked INTEGER NOT NULL DEFAULT 0,  -- 1 => /api/state returns 403 for this uid
  last_seen TEXT                  -- ISO timestamp of the most recent successful /api/state call; NULL until first sync
);

-- NOVA write access (see migrations/0002_nova_write.sql, which holds the same two tables).
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
