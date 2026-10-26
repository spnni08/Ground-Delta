#!/usr/bin/env bash
# Exports every D1 table that holds trade data to ./backups/<timestamp>/*.json
# Usage: CLOUDFLARE_API_TOKEN=... ./scripts/backup-trades.sh   (run from worker/)
set -euo pipefail
DB=ground-delta-db
OUT="backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"
for q in \
  "workspace_state:SELECT * FROM workspace_state" \
  "nova_idempotency:SELECT * FROM nova_idempotency" \
  "nova_audit_log:SELECT * FROM nova_audit_log" \
  "admin_audit_log:SELECT * FROM admin_audit_log"; do
  name="${q%%:*}"; sql="${q#*:}"
  npx wrangler d1 execute "$DB" --remote --json --command "$sql" > "$OUT/$name.json"
done
echo "Backup: $(pwd)/$OUT"
