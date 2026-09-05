// Ground Delta backend worker — Phase 3.
//
// Stores the whole { strategies, trades } tree as one JSON blob in D1
// (see schema.sql for why), guarded by an optimistic-lock `version`
// column so a stale frontend write can't silently clobber a trade the
// webhook just closed. Exposes:
//   GET  /api/state              -> { data, version }
//   PUT  /api/state              -> { data, expectedVersion } -> { version } | 409
//   POST /webhook/close          -> TradingView alert -> closes matching open trade(s)
//
// Every route except the CORS preflight requires the shared secret
// (`API_KEY`, set via `wrangler secret put API_KEY`) as either the
// `X-Api-Key` header or a `?key=` query param — TradingView's webhook
// delivery can't set custom headers, so the query param exists for it.

const WORKSPACE_ID = 'default';

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Api-Key',
    'Access-Control-Max-Age': '86400'
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders(origin))
  });
}

function authOk(request, env, url) {
  if (!env.API_KEY) return true; // no key configured yet — dev/first-deploy convenience
  const header = request.headers.get('X-Api-Key');
  const query = url.searchParams.get('key');
  return header === env.API_KEY || query === env.API_KEY;
}

async function getState(env) {
  const row = await env.DB.prepare('SELECT data, version FROM workspace_state WHERE id = ?')
    .bind(WORKSPACE_ID).first();
  if (!row) return { data: { strategies: [], trades: [] }, version: 0 };
  return { data: JSON.parse(row.data), version: row.version };
}

async function saveState(env, data, expectedVersion) {
  const now = new Date().toISOString();
  const existing = await env.DB.prepare('SELECT version FROM workspace_state WHERE id = ?')
    .bind(WORKSPACE_ID).first();
  const currentVersion = existing ? existing.version : 0;
  if (expectedVersion != null && expectedVersion !== currentVersion) {
    return { conflict: true, version: currentVersion };
  }
  const nextVersion = currentVersion + 1;
  await env.DB.prepare(
    'INSERT INTO workspace_state (id, data, version, updated_at) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET data = excluded.data, version = excluded.version, updated_at = excluded.updated_at'
  ).bind(WORKSPACE_ID, JSON.stringify(data), nextVersion, now).run();
  return { conflict: false, version: nextVersion };
}

function isFinite_(v) { return typeof v === 'number' && Number.isFinite(v); }

// Mirrors the frontend's autoPnl(): (exit-entry) * size * leverage,
// sign-flipped for shorts.
function calcPnl(trade, exit) {
  const size = isFinite_(trade.size) ? trade.size : 0;
  const leverage = isFinite_(trade.leverage) && trade.leverage > 0 ? trade.leverage : 1;
  const sign = trade.dir === 'Short' ? -1 : 1;
  return Math.round((exit - trade.entry) * sign * size * leverage * 100) / 100;
}

// Given a TradingView alert (symbol + price), find open trades on that
// symbol whose TP or SL the price has reached or crossed, and close
// each at that level (TP takes priority if both are somehow hit in the
// same tick — shouldn't happen in practice, but SL is the safety net).
function closeHitTrades(trades, symbol, price, timeIso) {
  const closedIds = [];
  const updated = trades.map(t => {
    if (t.status !== 'open' || t.symbol !== symbol) return t;
    const long = t.dir !== 'Short';
    const tpHit = isFinite_(t.tp) && (long ? price >= t.tp : price <= t.tp);
    const slHit = isFinite_(t.sl) && (long ? price <= t.sl : price >= t.sl);
    if (!tpHit && !slHit) return t;
    const exitLevel = tpHit ? t.tp : t.sl;
    closedIds.push(t.id);
    const d = new Date(timeIso);
    const hh = String(d.getUTCHours()).padStart(2, '0'), mm = String(d.getUTCMinutes()).padStart(2, '0');
    return Object.assign({}, t, {
      status: 'closed', exit: exitLevel, exitTime: hh + ':' + mm,
      pnl: calcPnl(t, exitLevel), rating: null, notes: t.notes || ''
    });
  });
  return { updated, closedIds };
}

async function handleWebhookClose(request, env, origin) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'invalid JSON body' }, 400, origin); }
  const symbol = String(body.symbol || '').trim().toUpperCase();
  const price = Number(body.price);
  const time = body.time || new Date().toISOString();
  if (!symbol || !isFinite_(price)) return json({ error: 'symbol and numeric price are required' }, 400, origin);

  // Retry once on a version conflict (a frontend save landing in the
  // same instant) — the webhook always wins the retry since it re-reads
  // the just-written state.
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, version } = await getState(env);
    const { updated, closedIds } = closeHitTrades(data.trades || [], symbol, price, time);
    if (closedIds.length === 0) return json({ closed: [], message: 'no open trade on ' + symbol + ' hit TP/SL at ' + price }, 200, origin);
    const result = await saveState(env, Object.assign({}, data, { trades: updated }), version);
    if (!result.conflict) return json({ closed: closedIds, version: result.version }, 200, origin);
  }
  return json({ error: 'could not save after retry, please retry the alert' }, 409, origin);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(origin) });

    if (!authOk(request, env, url)) return json({ error: 'unauthorized' }, 401, origin);

    if (url.pathname === '/api/state' && request.method === 'GET') {
      const state = await getState(env);
      return json(state, 200, origin);
    }

    if (url.pathname === '/api/state' && request.method === 'PUT') {
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'invalid JSON body' }, 400, origin); }
      if (!body || typeof body !== 'object' || !body.data) return json({ error: '"data" is required' }, 400, origin);
      const result = await saveState(env, body.data, body.expectedVersion);
      if (result.conflict) return json({ error: 'version conflict', version: result.version }, 409, origin);
      return json({ version: result.version }, 200, origin);
    }

    if (url.pathname === '/webhook/close' && request.method === 'POST') {
      return handleWebhookClose(request, env, origin);
    }

    return json({ error: 'not found' }, 404, origin);
  }
};
