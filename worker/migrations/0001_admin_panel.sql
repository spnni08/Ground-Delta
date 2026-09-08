-- Run this ONCE against a DB that was created before the extended
-- admin panel (block/unblock, create-user, revoke-sessions,
-- reset-password, delete-user, last-seen/online status) existed.
--
-- schema.sql's CREATE TABLE IF NOT EXISTS statements are no-ops against
-- an already-existing admin_audit_log table, so the new `action` column
-- has to be added explicitly here instead. admin_users is brand new, so
-- CREATE TABLE IF NOT EXISTS for it is safe to just pull from schema.sql
-- (included below too, so this file is a complete, self-contained
-- upgrade step).
--
--   wrangler d1 execute ground-delta-db --local  --file=./migrations/0001_admin_panel.sql
--   wrangler d1 execute ground-delta-db --remote --file=./migrations/0001_admin_panel.sql
--
-- Safe to re-run against a DB that already has these: the ALTER TABLE
-- will fail with "duplicate column name" (harmless, just re-run without
-- it) but the CREATE TABLE IF NOT EXISTS is idempotent.

ALTER TABLE admin_audit_log ADD COLUMN action TEXT NOT NULL DEFAULT 'edit';

CREATE TABLE IF NOT EXISTS admin_users (
  uid TEXT PRIMARY KEY,
  blocked INTEGER NOT NULL DEFAULT 0,
  last_seen TEXT
);
