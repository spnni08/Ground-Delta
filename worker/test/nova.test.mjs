// Run: npm test  (node's built-in test runner, no dependencies)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleNova, resetRateLimit, RATE_LIMIT } from '../src/nova.js';

const TOKEN = 'test-token-0123456789-0123456789-abcdef'; // test fixture, not a real secret
const UID = 'uid-allowed';
const env = { NOVA_ACCESS_TOKEN: TOKEN, NOVA_ALLOWED_UID: UID };

const trades = [
  { id: 'a', status: 'closed', date: '2026-09-30', entryTime: '10:00', exitTime: '11:00', symbol: 'BTC', dir: 'Long', entry: 1, exit: 2, pnl: 5, size: 1, leverage: 1, strategyId: 's1', notes: 'PRIVATE JOURNAL TEXT', rating: 4, shot: 'data:image/png;base64,AAAA', checks: { x: true }, source: 'nova' },
  { id: 'b', status: 'open', date: '2026-10-01', entryTime: '09:00', symbol: 'ETH', dir: 'Short', entry: 3, size: 2, leverage: 5, notes: 'more private text' },
];

function makeDeps(overrides) {
  const calls = { read: 0 };
  return {
    calls,
    deps: Object.assign({
      isBlocked: async () => false,
      readState: async () => { calls.read++; return { data: structuredClone({ trades, strategies: [{ id: 's1', name: 'Breakout', criteria: ['secret rule'] }] }), version: 3 }; },
    }, overrides),
  };
}

const call = async (method, path, { headers, deps = makeDeps().deps, e = env, body } = {}) => {
  const r = new Request('https://gd.test' + path, { method, headers: headers ?? { 'X-Api-Key': TOKEN }, body });
  const res = await handleNova(r, e, new URL(r.url), deps);
  return res && { status: res.status, headers: res.headers, body: await res.json() };
};

beforeEach(() => resetRateLimit());

test('ignores non-/nova paths', async () => {
  const r = new Request('https://gd.test/api/state');
  assert.equal(await handleNova(r, env, new URL(r.url), makeDeps().deps), null);
});

test('no token / wrong token -> 401 and the journal is never read', async () => {
  const { deps, calls } = makeDeps();
  assert.equal((await call('GET', '/nova/trades?uid=' + UID, { headers: {}, deps })).status, 401);
  assert.equal((await call('GET', '/nova/trades?uid=' + UID, { headers: { 'X-Api-Key': 'nope' }, deps })).status, 401);
  assert.equal((await call('GET', '/nova/trades?uid=' + UID, { headers: { 'X-Api-Key': TOKEN + 'x' }, deps })).status, 401);
  // token in the query string is not accepted
  assert.equal((await call('GET', `/nova/trades?uid=${UID}&key=${TOKEN}`, { headers: {}, deps })).status, 401);
  // unknown routes also need the token first
  assert.equal((await call('GET', '/nova/whatever', { headers: {}, deps })).status, 401);
  assert.equal(calls.read, 0);
});

test('fails closed without a (long enough) configured token; API_KEY is not a fallback', async () => {
  assert.equal((await call('GET', '/nova/trades?uid=' + UID, { e: {} })).status, 401);
  assert.equal((await call('GET', '/nova/trades?uid=' + UID, { e: { NOVA_ACCESS_TOKEN: 'short', NOVA_ALLOWED_UID: UID }, headers: { 'X-Api-Key': 'short' } })).status, 401);
  assert.equal((await call('GET', '/nova/trades?uid=' + UID, { e: { API_KEY: TOKEN, NOVA_ALLOWED_UID: UID } })).status, 401);
});

test('valid token (X-Api-Key or Bearer) -> NOVA format, newest first', async () => {
  for (const headers of [{ 'X-Api-Key': TOKEN }, { Authorization: 'Bearer ' + TOKEN }]) {
    const r = await call('GET', '/nova/trades?uid=' + UID, { headers });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(r.body.trades.map((t) => t.id), ['b', 'a']);
    assert.deepEqual(r.body.strategies, [{ id: 's1', name: 'Breakout' }]);
    assert.deepEqual(Object.keys(r.body.trades[0]).sort(),
      ['date', 'dir', 'entry', 'entryTime', 'exit', 'exitTime', 'id', 'leverage', 'notes', 'pnl', 'session', 'size', 'sl', 'status', 'strategy', 'symbol', 'tp']);
    assert.equal(r.body.trades[1].strategy, 'Breakout');
    assert.equal(r.body.trades[0].exit, null); // open trade: null, not invented
    assert.equal(r.body.trades[0].sl, null);
  }
});

test('does not leak journal text, ratings, screenshots, rules or internals', async () => {
  const r = await call('GET', '/nova/trades?uid=' + UID);
  const raw = JSON.stringify(r.body);
  for (const secret of ['PRIVATE JOURNAL TEXT', 'more private text', 'secret rule', 'data:image', 'rating', 'checks', 'source', TOKEN]) {
    assert.ok(!raw.includes(secret), 'leaked: ' + secret);
  }
  assert.ok(r.body.trades.every((t) => t.notes === ''));
});

test('filters: status, from/to, limit; bad input -> 400', async () => {
  assert.deepEqual((await call('GET', `/nova/trades?uid=${UID}&status=open`)).body.trades.map((t) => t.id), ['b']);
  assert.deepEqual((await call('GET', `/nova/trades?uid=${UID}&status=closed`)).body.trades.map((t) => t.id), ['a']);
  assert.deepEqual((await call('GET', `/nova/trades?uid=${UID}&from=2026-09-30&to=2026-09-30`)).body.trades.map((t) => t.id), ['a']);
  assert.equal((await call('GET', `/nova/trades?uid=${UID}&limit=1`)).body.trades.length, 1);
  assert.equal((await call('GET', `/nova/trades?uid=${UID}&status=bogus`)).status, 400);
  assert.equal((await call('GET', `/nova/trades?uid=${UID}&from=yesterday`)).status, 400);
  assert.equal((await call('GET', '/nova/trades')).status, 400);
});

test('only the configured UID is readable; blocked accounts and missing config are refused', async () => {
  assert.equal((await call('GET', '/nova/trades?uid=someone-else')).status, 403);
  assert.equal((await call('GET', '/nova/trades?uid=' + UID, { deps: makeDeps({ isBlocked: async () => true }).deps })).status, 403);
  assert.equal((await call('GET', '/nova/trades?uid=' + UID, { e: { NOVA_ACCESS_TOKEN: TOKEN } })).status, 503);
});

test('unknown route with valid token -> 404', async () => {
  assert.equal((await call('GET', '/nova/nope?uid=' + UID)).status, 404);
  assert.equal((await call('GET', '/nova/trades/abc/close?uid=' + UID)).status, 404);
  assert.equal((await call('GET', '/nova/?uid=' + UID)).status, 404);
});

test('no write access: POST/PUT/PATCH/DELETE -> 405, state is never touched', async () => {
  const state = structuredClone(trades);
  const writes = [];
  const { deps, calls } = makeDeps({
    readState: async () => ({ data: { trades: state, strategies: [] }, version: 1 }),
    saveState: async () => writes.push('save'), // would be called by an old write route; must stay unused
  });
  const body = JSON.stringify({ date: '2026-10-01', symbol: 'X', dir: 'Long', entry: 1, exit: 2 });
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const path of ['/nova/trades', '/nova/trades/b', '/nova/trades/b/close']) {
      const r = await call(method, `${path}?uid=${UID}`, { deps, body });
      assert.ok(r.status === 405 || r.status === 404, `${method} ${path} -> ${r.status}`);
      if (path === '/nova/trades') { assert.equal(r.status, 405); assert.equal(r.headers.get('Allow'), 'GET'); }
    }
  }
  assert.deepEqual(writes, []);
  assert.equal(calls.read, 0);
  assert.deepEqual(state, trades);
});

test('nova.js contains no write path (static check)', () => {
  const src = readFileSync(new URL('../src/nova.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/saveState|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|\.run\(|\.batch\(|\.exec\(/i.test(src));
});

test('rate limit: 429 with Retry-After after the window quota, then recovers', async () => {
  let t = 1_000_000;
  const { deps } = makeDeps({ now: () => t });
  const h = { 'X-Api-Key': TOKEN, 'CF-Connecting-IP': '203.0.113.7' };
  for (let i = 0; i < RATE_LIMIT.max; i++) assert.equal((await call('GET', '/nova/trades?uid=' + UID, { headers: h, deps })).status, 200);
  const limited = await call('GET', '/nova/trades?uid=' + UID, { headers: h, deps });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('Retry-After')) > 0);
  // other clients are unaffected; wrong tokens count too
  assert.equal((await call('GET', '/nova/trades?uid=' + UID, { headers: { 'X-Api-Key': TOKEN, 'CF-Connecting-IP': '203.0.113.8' }, deps })).status, 200);
  t += RATE_LIMIT.windowMs;
  assert.equal((await call('GET', '/nova/trades?uid=' + UID, { headers: h, deps })).status, 200);
});
