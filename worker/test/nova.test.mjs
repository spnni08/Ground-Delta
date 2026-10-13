// Run: npm test  (node's built-in test runner, no dependencies)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleNova, resetRateLimit, RATE_LIMIT, sanitizeAdd } from '../src/nova.js';

const READ = 'read-token-0123456789-0123456789-abcdef'; // test fixtures, not real secrets
const WRITE = 'write-token-0123456789-0123456789-abcde';
const UID = 'uid-allowed';
const env = { NOVA_ACCESS_TOKEN: READ, NOVA_WRITE_TOKEN: WRITE, NOVA_ALLOWED_UID: UID };

const seedTrades = () => [
  { id: 'a', status: 'closed', date: '2026-09-30', entryTime: '10:00', exitTime: '11:00', symbol: 'BTC', dir: 'Long', entry: 1, exit: 2, pnl: 5, size: 1, leverage: 1, strategyId: 's1', notes: 'PRIVATE JOURNAL TEXT', rating: 4, shot: 'data:image/png;base64,AAAA', checks: { x: true }, source: 'nova' },
  { id: 'b', status: 'open', date: '2026-10-01', entryTime: '09:00', symbol: 'ETH', dir: 'Short', entry: 3, sl: 3.5, size: 2, leverage: 5, notes: 'more private text' },
];

/** In-memory stand-in for D1 (state, idempotency, audit) with the same semantics as the real store. */
function makeWorld(opts = {}) {
  const w = {
    version: 1,
    data: { trades: seedTrades(), strategies: [{ id: 's1', name: 'Breakout', criteria: ['secret rule'] }] },
    idem: new Map(), audit: [], saves: 0, clock: 1_700_000_000_000, conflictOnce: !!opts.conflictOnce,
  };
  w.deps = {
    now: () => w.clock,
    isBlocked: async () => false,
    readState: async () => ({ data: structuredClone(w.data), version: w.version }),
    saveState: async (_e, _u, data, expected) => {
      if (w.conflictOnce) { w.conflictOnce = false; w.version++; return { conflict: true, version: w.version }; }
      if (expected !== w.version) return { conflict: true, version: w.version };
      w.data = structuredClone(data); w.version++; w.saves++;
      return { conflict: false, version: w.version };
    },
    store: {
      async claim(key, hash, now) {
        for (const [k, r] of w.idem) if (now - r.at > 24 * 3600e3 || (r.status == null && now - r.at > 60e3)) w.idem.delete(k);
        const r = w.idem.get(key);
        if (!r) { w.idem.set(key, { hash, at: now, status: null }); return { state: 'new' }; }
        return r.status == null ? { state: 'pending' } : { state: 'done', hash: r.hash, status: r.status, body: r.body };
      },
      async complete(key, status, body) { Object.assign(w.idem.get(key), { status, body }); },
      async release(key) { if (w.idem.get(key)?.status == null) w.idem.delete(key); },
      async audit(e) { w.audit.push(e); },
    },
  };
  return w;
}

let world;
beforeEach(() => { resetRateLimit(); world = makeWorld(); });

const call = async (method, path, { token = READ, headers, body, e = env, w = world, key } = {}) => {
  const h = Object.assign({}, token ? { 'X-Api-Key': token } : {}, key ? { 'Idempotency-Key': key } : {}, headers);
  const r = new Request('https://gd.test' + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const res = await handleNova(r, e, new URL(r.url), w.deps);
  return res && { status: res.status, headers: res.headers, body: await res.json() };
};
const post = (path, body, o = {}) => call('POST', path, Object.assign({ token: WRITE, key: 'idem-key-0001', body }, o));
const ADD = { date: '2026-10-13', symbol: 'nas100', dir: 'long', entry: 20100.5, sl: 20050, tp: 20200, entryTime: '15:31' };
const ADDP = `/nova/trades?uid=${UID}`;
const CLOSEP = (id) => `/nova/trades/${id}/close?uid=${UID}`;

// ---------- reading (unchanged behaviour) ----------

test('ignores non-/nova paths', async () => {
  const r = new Request('https://gd.test/api/state');
  assert.equal(await handleNova(r, env, new URL(r.url), world.deps), null);
});

test('read: no/wrong token -> 401, fails closed, API_KEY is no fallback', async () => {
  assert.equal((await call('GET', ADDP, { token: null })).status, 401);
  assert.equal((await call('GET', ADDP, { token: 'nope' })).status, 401);
  assert.equal((await call('GET', `${ADDP}&key=${READ}`, { token: null })).status, 401);
  assert.equal((await call('GET', ADDP, { e: {} })).status, 401);
  assert.equal((await call('GET', ADDP, { e: { NOVA_ACCESS_TOKEN: 'short', NOVA_ALLOWED_UID: UID }, token: 'short' })).status, 401);
  assert.equal((await call('GET', ADDP, { e: { API_KEY: READ, NOVA_ALLOWED_UID: UID } })).status, 401);
});

test('read: valid read token (X-Api-Key or Bearer) -> NOVA format, no private fields', async () => {
  for (const o of [{}, { token: null, headers: { Authorization: 'Bearer ' + READ } }]) {
    const r = await call('GET', ADDP, o);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.trades.map((t) => t.id), ['b', 'a']);
    assert.deepEqual(r.body.strategies, [{ id: 's1', name: 'Breakout' }]);
    const raw = JSON.stringify(r.body);
    for (const s of ['PRIVATE JOURNAL TEXT', 'more private text', 'secret rule', 'data:image', 'rating', 'checks', 'source', READ, WRITE]) assert.ok(!raw.includes(s), 'leaked: ' + s);
  }
});

test('read: filters and bad input', async () => {
  assert.deepEqual((await call('GET', `${ADDP}&status=open`)).body.trades.map((t) => t.id), ['b']);
  assert.deepEqual((await call('GET', `${ADDP}&from=2026-09-30&to=2026-09-30`)).body.trades.map((t) => t.id), ['a']);
  assert.equal((await call('GET', `${ADDP}&status=bogus`)).status, 400);
  assert.equal((await call('GET', '/nova/trades')).status, 400);
});

test('only the configured UID; blocked account; missing config', async () => {
  assert.equal((await call('GET', '/nova/trades?uid=other')).status, 403);
  assert.equal((await post('/nova/trades?uid=other', ADD)).status, 403);
  world.deps.isBlocked = async () => true;
  assert.equal((await call('GET', ADDP)).status, 403);
  assert.equal((await post(ADDP, ADD)).status, 403);
  assert.equal((await call('GET', ADDP, { e: { NOVA_ACCESS_TOKEN: READ } })).status, 503);
});

test('unknown route -> 404 (after auth), wrong method -> 405', async () => {
  assert.equal((await call('GET', '/nova/nope?uid=' + UID, { token: null })).status, 401);
  assert.equal((await call('GET', '/nova/nope?uid=' + UID)).status, 404);
  assert.equal((await call('GET', `/nova/trades/b/close?uid=${UID}`)).status, 405);
  for (const m of ['PUT', 'PATCH', 'DELETE']) {
    const r = await call(m, ADDP);
    assert.equal(r.status, 405);
    assert.equal(r.headers.get('Allow'), 'GET, POST');
    assert.equal((await call(m, '/nova/trades/b?uid=' + UID)).status, 404); // no per-trade route, so no delete/edit
  }
  assert.equal(world.saves, 0);
});

// ---------- token separation ----------

test('wrong or missing token on write routes -> 401, nothing saved', async () => {
  assert.equal((await post(ADDP, ADD, { token: null })).status, 401);
  assert.equal((await post(ADDP, ADD, { token: 'nope' })).status, 401);
  assert.equal((await post(ADDP, ADD, { token: WRITE + 'x' })).status, 401);
  assert.equal((await post(CLOSEP('b'), { exit: 3 }, { token: null })).status, 401);
  assert.equal((await post(ADDP, ADD, { e: { NOVA_ACCESS_TOKEN: READ, NOVA_ALLOWED_UID: UID } })).status, 401); // no write token configured
  assert.equal((await post(ADDP, ADD, { e: { NOVA_ACCESS_TOKEN: READ, NOVA_WRITE_TOKEN: 'short', NOVA_ALLOWED_UID: UID }, token: 'short' })).status, 401);
  assert.equal(world.saves, 0);
  assert.equal(world.idem.size, 0);
});

test('read token cannot write (403), write token cannot read (403)', async () => {
  const a = await post(ADDP, ADD, { token: READ });
  assert.equal(a.status, 403);
  assert.match(a.body.error, /read token cannot write/);
  assert.equal((await post(CLOSEP('b'), { exit: 3 }, { token: READ })).status, 403);
  assert.equal((await call('GET', ADDP, { token: WRITE })).status, 403);
  assert.equal(world.saves, 0);
  assert.equal(world.idem.size, 0);
});

test('write token equal to read token disables writes', async () => {
  const same = { NOVA_ACCESS_TOKEN: READ, NOVA_WRITE_TOKEN: READ, NOVA_ALLOWED_UID: UID };
  assert.equal((await post(ADDP, ADD, { token: READ, e: same })).status, 403);
  assert.equal(world.saves, 0);
});

// ---------- add ----------

test('add: creates an open trade in the frontend shape, resolving strategy by name', async () => {
  const r = await post(ADDP, Object.assign({ strategy: 'breakout', size: 1, notes: 'n', bogus: 'dropped', rating: 5 }, ADD));
  assert.equal(r.status, 200);
  assert.equal(r.body.trade.symbol, 'NAS100');
  assert.equal(r.body.trade.dir, 'Long');
  assert.equal(r.body.trade.status, 'open');
  assert.equal(r.body.trade.strategy, 'Breakout');
  assert.equal(r.body.trade.notes, ''); // never echoed back
  const t = world.data.trades.at(-1);
  assert.equal(t.source, 'nova');
  assert.equal(t.strategyId, 's1');
  assert.equal(t.notes, 'n');
  assert.equal(t.exit, null);
  assert.ok(!('bogus' in t) && t.rating === null);
  assert.equal(world.version, 2);
});

test('add: closed trade with auto P&L; version conflict is retried once', async () => {
  world = makeWorld({ conflictOnce: true });
  const r = await post(ADDP, { date: '2026-10-13', symbol: 'EURUSD', dir: 'Short', entry: 1.1, exit: 1.09, size: 1000 });
  assert.equal(r.status, 200);
  assert.equal(r.body.trade.status, 'closed');
  assert.equal(r.body.trade.pnl, 10);
  assert.equal(world.data.trades.length, 3);
});

test('add: strict validation -> 400 with reasons, nothing stored', async () => {
  const bad = [
    [{}, /date/], [{ ...ADD, date: '2026-02-30' }, /date/], [{ ...ADD, date: '13.10.2026' }, /date/],
    [{ ...ADD, symbol: '' }, /symbol/], [{ ...ADD, symbol: 'A'.repeat(30) }, /symbol/], [{ ...ADD, symbol: '<script>' }, /symbol/],
    [{ ...ADD, dir: 'Sideways' }, /dir/], [{ ...ADD, entry: '20100' }, /entry/], [{ ...ADD, entry: 0 }, /entry/],
    [{ ...ADD, entry: -5 }, /entry/], [{ ...ADD, entry: 1e12 }, /entry/], [{ ...ADD, entry: null }, /entry/],
    [{ ...ADD, sl: 'x' }, /sl/], [{ ...ADD, tp: -1 }, /tp/], [{ ...ADD, size: 0 }, /size/], [{ ...ADD, leverage: 0.5 }, /leverage/], [{ ...ADD, leverage: 5000 }, /leverage/],
    [{ ...ADD, entryTime: '25:00' }, /entryTime/], [{ ...ADD, exitTime: 'noon' }, /exitTime/],
    [{ ...ADD, session: 's'.repeat(41) }, /session/], [{ ...ADD, notes: 'n'.repeat(2001) }, /notes/], [{ ...ADD, notes: 5 }, /notes/],
    [{ ...ADD, strategy: 'does-not-exist' }, /strategy/], [{ ...ADD, exit: 20200 }, /pnl or size/], [{ ...ADD, exit: 20200, pnl: 1e12 }, /pnl/],
  ];
  for (const [b, re] of bad) {
    resetRateLimit();
    const r = await post(ADDP, b);
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.match(r.body.error, re, JSON.stringify(b));
  }
  assert.equal((await post(ADDP, [1, 2])).status, 400);
  assert.equal((await post(ADDP, 'not json')).status, 400);
  assert.equal((await post(ADDP, { ...ADD, notes: 'x'.repeat(9000) })).status, 413);
  assert.equal(world.saves, 0);
  assert.equal(world.idem.size, 0); // rejected requests never occupy a key
});

test('sanitizeAdd drops unknown fields', () => {
  const r = sanitizeAdd({ ...ADD, uid: 'evil', status: 'closed', id: 'x', source: 'y', __proto__: { a: 1 } }, []);
  assert.deepEqual(Object.keys(r.value).sort(), ['date', 'dir', 'entry', 'entryTime', 'sl', 'symbol', 'tp']);
});

test('write routes require an Idempotency-Key', async () => {
  for (const key of ['', 'short', 'has spaces in it!', 'x'.repeat(200)]) {
    const r = await call('POST', ADDP, { token: WRITE, body: ADD, key: key || undefined });
    assert.equal(r.status, 400, key);
    assert.match(r.body.error, /Idempotency-Key/);
  }
  assert.equal((await call('POST', CLOSEP('b'), { token: WRITE, body: { exit: 3 } })).status, 400);
  assert.equal(world.saves, 0);
});

// ---------- idempotency ----------

test('same key + same request -> first result, no second trade', async () => {
  const first = await post(ADDP, ADD);
  const again = await post(ADDP, { ...ADD, bogus: 'ignored field does not change the request' });
  assert.equal(first.status, 200);
  assert.equal(again.status, 200);
  assert.equal(again.headers.get('Idempotent-Replay'), 'true');
  assert.equal(again.body.trade.id, first.body.trade.id);
  assert.equal(world.data.trades.length, 3);
  assert.equal(world.saves, 1);
});

test('same key + different request -> 422; different key -> new trade', async () => {
  await post(ADDP, ADD);
  const r = await post(ADDP, { ...ADD, entry: 99 });
  assert.equal(r.status, 422);
  assert.equal(world.data.trades.length, 3);
  assert.equal((await post(ADDP, ADD, { key: 'idem-key-0002' })).status, 200);
  assert.equal(world.data.trades.length, 4);
});

test('idempotency results expire after 24 h', async () => {
  const first = await post(ADDP, ADD);
  world.clock += 23 * 3600e3;
  assert.equal((await post(ADDP, ADD)).body.trade.id, first.body.trade.id);
  world.clock += 2 * 3600e3;
  const later = await post(ADDP, ADD);
  assert.notEqual(later.body.trade.id, first.body.trade.id);
});

test('a key whose first request is still running -> 409; failures free the key', async () => {
  world.idem.set('idem-key-0001', { hash: 'h', at: world.clock, status: null });
  const r = await post(ADDP, ADD);
  assert.equal(r.status, 409);
  assert.equal(r.headers.get('Retry-After'), '1');
  world.idem.clear();
  assert.equal((await post(CLOSEP('missing'), { exit: 1 })).status, 404);
  assert.equal(world.idem.size, 0);
  assert.equal((await post(ADDP, ADD)).status, 200); // key is usable again
});

test('a crash between claim and save frees the key, no trade is stored', async () => {
  world.deps.saveState = async () => { throw new Error('d1 down'); };
  assert.equal((await post(ADDP, ADD)).status, 500);
  assert.equal(world.idem.size, 0);
  assert.equal(world.data.trades.length, 2);
});

// ---------- close ----------

test('close: open trade -> closed with auto P&L; replay returns the first result', async () => {
  const r = await post(CLOSEP('b'), { exit: 2.5, exitTime: '10:15', bogus: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.body.trade.status, 'closed');
  assert.equal(r.body.trade.pnl, 5); // Short 3 -> 2.5, size 2, lev 5
  assert.equal(r.body.trade.exitTime, '10:15');
  const t = world.data.trades.find((x) => x.id === 'b');
  assert.equal(t.status, 'closed');
  assert.equal(t.closedSource, 'nova');
  const replay = await post(CLOSEP('b'), { exit: 2.5, exitTime: '10:15' });
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('Idempotent-Replay'), 'true');
  assert.equal(world.saves, 1);
});

test('close: already closed -> 409, unknown id -> 404, bad input -> 400, no size and no pnl -> 400', async () => {
  const closed = await post(CLOSEP('a'), { exit: 3 });
  assert.equal(closed.status, 409);
  assert.match(closed.body.error, /already closed/);
  assert.equal((await post(CLOSEP('zzz'), { exit: 3 })).status, 404);
  assert.equal((await post(CLOSEP('b'), {})).status, 400);
  assert.equal((await post(CLOSEP('b'), { exit: 'x' })).status, 400);
  assert.equal((await post(CLOSEP('b'), { exit: -1 })).status, 400);
  assert.equal((await post(CLOSEP('b'), { exit: 3, exitTime: '99:99' })).status, 400);
  world.data.trades.push({ id: 'ns', status: 'open', date: '2026-10-01', entryTime: '09:00', symbol: 'X', dir: 'Long', entry: 1, size: 0, leverage: 1 });
  assert.equal((await post(CLOSEP('ns'), { exit: 2 })).status, 400);
  assert.equal((await post(CLOSEP('ns'), { exit: 2, pnl: 7 })).status, 200);
  assert.equal(world.saves, 1);
});

test('close: a second request with a NEW key for a trade closed meanwhile -> 409', async () => {
  assert.equal((await post(CLOSEP('b'), { exit: 2.5 })).status, 200);
  assert.equal((await post(CLOSEP('b'), { exit: 2.5 }, { key: 'idem-key-0002' })).status, 409);
});

// ---------- audit + rate limit ----------

test('every write attempt is logged with timestamp and source, never with journal text', async () => {
  await post(ADDP, { ...ADD, notes: 'PRIVATE NOTE' });
  await post(ADDP, { ...ADD, notes: 'PRIVATE NOTE' }); // replay
  await post(CLOSEP('a'), { exit: 3 }, { key: 'idem-key-0009' }); // 409
  await post(ADDP, { ...ADD, entry: -1 }, { key: 'idem-key-0010' }); // 400
  assert.deepEqual(world.audit.map((a) => [a.action, a.outcome, a.status]), [
    ['trade_add', 'ok', 200], ['trade_add', 'replay', 200], ['trade_close', 'rejected', 409], ['trade_add', 'rejected', 400],
  ]);
  for (const a of world.audit) {
    assert.equal(a.uid, UID);
    assert.match(a.ts, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(a.key);
  }
  assert.ok(world.audit[0].tradeId);
  assert.ok(!JSON.stringify(world.audit).includes('PRIVATE NOTE'));
});

test('an audit failure does not lose the write', async () => {
  world.deps.store.audit = async () => { throw new Error('audit table missing'); };
  const r = await post(ADDP, ADD);
  assert.equal(r.status, 200);
  assert.equal(world.data.trades.length, 3);
});

test('rate limit: writes are stricter than reads, buckets are separate, recovery after the window', async () => {
  assert.ok(RATE_LIMIT.write.max < RATE_LIMIT.read.max);
  const ip = { 'CF-Connecting-IP': '203.0.113.7' };
  for (let i = 0; i < RATE_LIMIT.write.max; i++) {
    assert.equal((await post(ADDP, ADD, { key: 'idem-key-' + String(i).padStart(4, '0'), headers: ip })).status, 200);
  }
  const limited = await post(ADDP, ADD, { key: 'idem-key-9999', headers: ip });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('Retry-After')) > 0);
  assert.equal((await call('GET', ADDP, { headers: ip })).status, 200); // reads unaffected
  assert.equal((await post(ADDP, ADD, { key: 'idem-key-9998', headers: { 'CF-Connecting-IP': '203.0.113.8' } })).status, 200);
  world.clock += RATE_LIMIT.write.windowMs;
  assert.equal((await post(ADDP, ADD, { key: 'idem-key-9997', headers: ip })).status, 200);
});

test('rate limit: reads', async () => {
  const ip = { 'CF-Connecting-IP': '203.0.113.9' };
  for (let i = 0; i < RATE_LIMIT.read.max; i++) assert.equal((await call('GET', ADDP, { headers: ip })).status, 200);
  assert.equal((await call('GET', ADDP, { headers: ip })).status, 429);
  world.clock += RATE_LIMIT.read.windowMs;
  assert.equal((await call('GET', ADDP, { headers: ip })).status, 200);
});
