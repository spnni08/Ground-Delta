// Run: npm test  (node's built-in test runner, no dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrade, handleNova } from '../src/nova.js';

const json = (data, status) => new Response(JSON.stringify(data), { status: status || 200 });

function fakeStore(initial) {
  let state = { data: initial, version: 3 };
  return {
    get state() { return state; },
    deps: {
      json,
      isBlocked: async () => false,
      getState: async () => structuredClone(state),
      saveState: async (_env, _uid, data, expected) => {
        if (expected !== state.version) return { conflict: true, version: state.version };
        state = { data, version: state.version + 1 };
        return { conflict: false, version: state.version };
      },
    },
  };
}

const env = { NOVA_API_KEY: 'secret-key' };
const req = (method, path, body, key = 'secret-key') =>
  new Request('https://gd.test' + path, { method, headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const call = async (store, method, path, body, key) => {
  const r = req(method, path, body, key);
  const res = await handleNova(r, env, new URL(r.url), null, store.deps);
  return { status: res.status, body: await res.json() };
};

test('ignores non-/nova paths', async () => {
  const r = req('GET', '/api/state');
  assert.equal(await handleNova(r, env, new URL(r.url), null, fakeStore({}).deps), null);
});

test('rejects wrong key, missing key config, and ?key= in the URL', async () => {
  const store = fakeStore({ trades: [], strategies: [] });
  assert.equal((await call(store, 'GET', '/nova/trades?uid=u1', null, 'nope')).status, 401);
  const r = new Request('https://gd.test/nova/trades?uid=u1&key=secret-key');
  assert.equal((await handleNova(r, env, new URL(r.url), null, store.deps)).status, 401);
  const r2 = req('GET', '/nova/trades?uid=u1');
  assert.equal((await handleNova(r2, {}, new URL(r2.url), null, store.deps)).status, 401); // fails closed
});

test('creates an open trade in the frontend shape, resolving strategy by name', async () => {
  const store = fakeStore({ trades: [], strategies: [{ id: 's1', name: 'Breakout', criteria: [] }] });
  const r = await call(store, 'POST', '/nova/trades?uid=u1', { date: '2026-10-01', entryTime: '15:31', symbol: 'nas100', dir: 'long', entry: 20100.5, sl: 20050, tp: 20200, size: 1, strategy: 'breakout' });
  assert.equal(r.status, 200);
  const t = store.state.data.trades[0];
  assert.equal(t.status, 'open');
  assert.equal(t.symbol, 'NAS100');
  assert.equal(t.dir, 'Long');
  assert.equal(t.strategyId, 's1');
  assert.equal(t.exit, null);
  assert.equal(t.source, 'nova');
  assert.equal(r.body.trade.strategy, 'Breakout');
  assert.equal(store.state.version, 4);
});

test('closes an open trade with auto P&L, refuses to close twice', async () => {
  const store = fakeStore({ trades: [{ id: 'abc', status: 'open', date: '2026-10-01', entryTime: '09:00', symbol: 'EURUSD', dir: 'Short', entry: 1.1, size: 1000, leverage: 1 }], strategies: [] });
  const r = await call(store, 'POST', '/nova/trades/abc/close?uid=u1', { exit: 1.09, exitTime: '10:15' });
  assert.equal(r.status, 200);
  const t = store.state.data.trades[0];
  assert.equal(t.status, 'closed');
  assert.equal(t.pnl, 10);
  assert.equal(t.exitTime, '10:15');
  assert.equal((await call(store, 'POST', '/nova/trades/abc/close?uid=u1', { exit: 1.08 })).status, 409);
});

test('lists trades newest first with filters', async () => {
  const store = fakeStore({
    trades: [
      { id: 'a', status: 'closed', date: '2026-09-30', entryTime: '10:00', symbol: 'BTC', dir: 'Long', entry: 1, exit: 2, pnl: 5 },
      { id: 'b', status: 'open', date: '2026-10-01', entryTime: '09:00', symbol: 'ETH', dir: 'Short', entry: 3 },
    ],
    strategies: [],
  });
  const all = await call(store, 'GET', '/nova/trades?uid=u1');
  assert.deepEqual(all.body.trades.map((t) => t.id), ['b', 'a']);
  const open = await call(store, 'GET', '/nova/trades?uid=u1&status=open');
  assert.deepEqual(open.body.trades.map((t) => t.id), ['b']);
  const range = await call(store, 'GET', '/nova/trades?uid=u1&from=2026-09-30&to=2026-09-30');
  assert.deepEqual(range.body.trades.map((t) => t.id), ['a']);
});

test('validation errors', () => {
  assert.match(buildTrade({ symbol: 'X', dir: 'Long', entry: 1 }, []).error, /date/);
  assert.match(buildTrade({ date: '2026-10-01', symbol: 'X', dir: 'Sideways', entry: 1 }, []).error, /dir/);
  assert.match(buildTrade({ date: '2026-10-01', symbol: 'X', dir: 'Long', entry: 1, exit: 2 }, []).error, /pnl or size/);
  assert.match(buildTrade({ date: '2026-10-01', symbol: 'X', dir: 'Long', entry: 1, strategy: 'nope' }, []).error, /unknown strategy/);
});
