// D1-backed idempotency + audit storage for the NOVA write routes.
// Tables: migrations/0001_init.sql.

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const PENDING_TTL_MS = 60 * 1000; // a first request that never finished

export function d1NovaStore(env) {
  const db = env.DB;
  return {
    /** -> { state: 'new' } | { state: 'pending' } | { state: 'done', hash, status, body } */
    async claim(key, hash, now) {
      await db.prepare('DELETE FROM nova_idempotency WHERE created_at < ? OR (status IS NULL AND created_at < ?)')
        .bind(now - IDEMPOTENCY_TTL_MS, now - PENDING_TTL_MS).run();
      const ins = await db.prepare('INSERT OR IGNORE INTO nova_idempotency (key, request_hash, created_at) VALUES (?, ?, ?)')
        .bind(key, hash, now).run();
      if (ins.meta && ins.meta.changes > 0) return { state: 'new' };
      const row = await db.prepare('SELECT request_hash, status, body FROM nova_idempotency WHERE key = ?').bind(key).first();
      if (!row) return { state: 'pending' }; // purged between the two statements; caller retries
      if (row.status == null) return { state: 'pending', hash: row.request_hash };
      return { state: 'done', hash: row.request_hash, status: row.status, body: row.body };
    },
    async complete(key, status, body) {
      await db.prepare('UPDATE nova_idempotency SET status = ?, body = ? WHERE key = ?').bind(status, body, key).run();
    },
    async release(key) {
      await db.prepare('DELETE FROM nova_idempotency WHERE key = ? AND status IS NULL').bind(key).run();
    },
    async audit(e) {
      await db.prepare(
        'INSERT INTO nova_audit_log (ts, source, action, uid, trade_id, idempotency_key, outcome, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(e.ts, 'nova', e.action, e.uid, e.tradeId || null, e.key || null, e.outcome, e.status, e.detail || null).run();
    },
  };
}
