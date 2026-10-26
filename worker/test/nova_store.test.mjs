// Runs the real D1 SQL of nova_store.js against SQLite (node:sqlite); skipped where unavailable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { d1NovaStore, IDEMPOTENCY_TTL_MS, PENDING_TTL_MS } from '../src/nova_store.js';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch (e) { /* older Node */ }

function fakeD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  return {
    sqlite,
    prepare: (sql) => ({
      bind: (...args) => ({
        run: async () => { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
        first: async () => sqlite.prepare(sql).get(...args) ?? null,
      }),
    }),
  };
}

test('d1 store: claim / complete / replay / release / expiry / audit', { skip: !DatabaseSync }, async () => {
  const db = fakeD1();
  const s = d1NovaStore({ DB: db });
  const t0 = 1_700_000_000_000;

  assert.deepEqual(await s.claim('k1', 'h1', t0), { state: 'new' });
  assert.equal((await s.claim('k1', 'h1', t0 + 1000)).state, 'pending');
  await s.complete('k1', 200, '{"trade":{"id":"x"}}');
  assert.deepEqual(await s.claim('k1', 'h1', t0 + 2000), { state: 'done', hash: 'h1', status: 200, body: '{"trade":{"id":"x"}}' });
  assert.equal((await s.claim('k1', 'other', t0 + 3000)).hash, 'h1'); // caller compares hashes -> 422

  await s.release('k1'); // completed rows are not released
  assert.equal((await s.claim('k1', 'h1', t0 + 4000)).state, 'done');

  assert.equal((await s.claim('k2', 'h2', t0)).state, 'new');
  await s.release('k2');
  assert.equal((await s.claim('k2', 'h2', t0)).state, 'new');

  // a first request that never finished is taken over after PENDING_TTL_MS
  assert.equal((await s.claim('k3', 'h3', t0)).state, 'new');
  assert.equal((await s.claim('k3', 'h3', t0 + PENDING_TTL_MS - 1)).state, 'pending');
  assert.equal((await s.claim('k3', 'h3', t0 + PENDING_TTL_MS + 1)).state, 'new');

  // finished results are purged after 24 h
  assert.equal((await s.claim('k1', 'h1', t0 + IDEMPOTENCY_TTL_MS + 10)).state, 'new');

  await s.audit({ ts: '2026-10-13T10:00:00.000Z', action: 'trade_add', uid: 'u', tradeId: 't', key: 'k1', outcome: 'ok', status: 200 });
  const row = db.sqlite.prepare('SELECT * FROM nova_audit_log').get();
  assert.equal(row.source, 'nova');
  assert.equal(row.action, 'trade_add');
  assert.equal(row.trade_id, 't');
  assert.equal(row.ts, '2026-10-13T10:00:00.000Z');
});
