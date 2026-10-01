// NOVA (personal assistant) access to one user's journal.
//
//   GET  /nova/trades?uid=X[&status=open|closed|all][&from=YYYY-MM-DD][&to=YYYY-MM-DD][&limit=N]
//        -> { trades: [...], strategies: [{ id, name }] }
//   POST /nova/trades?uid=X                 body: trade fields (see buildTrade) -> { trade, version }
//   POST /nova/trades/:id/close?uid=X       body: { exit, exitTime?, pnl? }     -> { trade, version }
//
// Auth: shared secret in the `X-Api-Key` header — `NOVA_API_KEY` if set,
// otherwise the existing webhook `API_KEY`. Unlike /webhook/close this
// FAILS CLOSED when no key is configured, and the key is only accepted as a
// header (never `?key=`), so it doesn't end up in request logs.
//
// Writes go through the same optimistic-lock saveState() as the frontend
// and the webhook (one retry on a version conflict), and produce trades in
// exactly the shape the frontend's saveTrade() writes, so they show up in
// the journal like hand-entered ones. NOVA can only add and close trades —
// there is deliberately no delete or arbitrary-edit route.

const uid = () => Math.random().toString(36).slice(2, 9);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const toNum = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function novaAuthOk(request, env) {
  const expected = env.NOVA_API_KEY || env.API_KEY;
  if (!expected) return false;
  const given = request.headers.get('X-Api-Key') || '';
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// Mirrors the frontend's autoPnl(): (exit-entry) * size * leverage, sign-flipped for shorts.
function autoPnl(t, exit) {
  if (!isNum(t.size) || t.size <= 0) return null;
  const lev = isNum(t.leverage) && t.leverage > 0 ? t.leverage : 1;
  const sign = t.dir === 'Short' ? -1 : 1;
  return Math.round((exit - t.entry) * sign * t.size * lev * 100) / 100;
}

/** Validates NOVA's input and returns a trade in the frontend's shape, or { error }. */
export function buildTrade(b, strategies) {
  const date = String(b.date || '');
  if (!DATE_RE.test(date)) return { error: 'date (YYYY-MM-DD) is required' };
  const symbol = String(b.symbol || '').trim().toUpperCase();
  if (!symbol) return { error: 'symbol is required' };
  const dirRaw = String(b.dir || b.direction || '').toLowerCase();
  if (dirRaw !== 'long' && dirRaw !== 'short') return { error: 'dir must be Long or Short' };
  const dir = dirRaw === 'long' ? 'Long' : 'Short';
  const entry = toNum(b.entry);
  if (!isNum(entry)) return { error: 'entry price is required' };
  const entryTime = TIME_RE.test(String(b.entryTime || '')) ? b.entryTime : '00:00';
  const lev = toNum(b.leverage);
  const size = toNum(b.size);

  let strategyId = '';
  if (b.strategyId || b.strategy) {
    const want = String(b.strategyId || b.strategy).toLowerCase();
    const s = (strategies || []).find((x) => x.id === b.strategyId || String(x.name || '').toLowerCase() === want);
    if (!s) return { error: 'unknown strategy: ' + (b.strategyId || b.strategy) };
    strategyId = s.id;
  }

  const base = {
    id: uid(), date, entryTime, symbol, dir, entry,
    sl: toNum(b.sl), tp: toNum(b.tp),
    size: isNum(size) ? size : 0, leverage: isNum(lev) && lev > 0 ? lev : 1,
    session: typeof b.session === 'string' ? b.session : '',
    strategyId, checks: {}, notes: typeof b.notes === 'string' ? b.notes.slice(0, 2000) : '', shot: null,
    source: 'nova',
  };

  const exit = toNum(b.exit);
  if (!isNum(exit)) {
    return { trade: Object.assign(base, { exitTime: '', exit: null, pnl: null, rating: null, notes: '', status: 'open' }) };
  }
  let pnl = toNum(b.pnl);
  if (!isNum(pnl)) pnl = autoPnl(base, exit);
  if (!isNum(pnl)) return { error: 'pnl or size is required to close a trade' };
  const exitTime = TIME_RE.test(String(b.exitTime || '')) ? b.exitTime : entryTime;
  return { trade: Object.assign(base, { exit, exitTime, pnl, rating: null, status: 'closed' }) };
}

function summarize(t, strategies) {
  const s = (strategies || []).find((x) => x.id === t.strategyId);
  return {
    id: t.id, date: t.date, entryTime: t.entryTime, exitTime: t.exitTime || '', symbol: t.symbol, dir: t.dir,
    entry: t.entry, exit: t.exit ?? null, sl: isNum(t.sl) ? t.sl : null, tp: isNum(t.tp) ? t.tp : null,
    size: t.size, leverage: t.leverage, pnl: t.pnl ?? null, status: t.status === 'open' ? 'open' : 'closed',
    session: t.session || '', strategy: s ? s.name : '', notes: t.notes || '', rating: t.rating ?? null,
  };
}

/** Returns a Response for /nova/* or null if the path isn't ours. */
export async function handleNova(request, env, url, origin, deps) {
  if (!url.pathname.startsWith('/nova/')) return null;
  const { getState, saveState, isBlocked, json } = deps;
  if (!novaAuthOk(request, env)) return json({ error: 'unauthorized' }, 401, origin);
  const userId = url.searchParams.get('uid');
  if (!userId) return json({ error: '?uid= query param is required' }, 400, origin);
  if (await isBlocked(env, userId)) return json({ error: 'account blocked' }, 403, origin);

  if (url.pathname === '/nova/trades' && request.method === 'GET') {
    const { data } = await getState(env, userId);
    const strategies = data.strategies || [];
    const status = url.searchParams.get('status') || 'all';
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const list = (data.trades || [])
      .filter((t) => status === 'all' || (status === 'open' ? t.status === 'open' : t.status !== 'open'))
      .filter((t) => (!from || t.date >= from) && (!to || t.date <= to))
      .sort((a, b) => (b.date + b.entryTime).localeCompare(a.date + a.entryTime))
      .slice(0, limit)
      .map((t) => summarize(t, strategies));
    return json({ trades: list, strategies: strategies.map((s) => ({ id: s.id, name: s.name })) }, 200, origin);
  }

  const closeMatch = url.pathname.match(/^\/nova\/trades\/([^/]+)\/close$/);
  const isCreate = url.pathname === '/nova/trades' && request.method === 'POST';
  if (!isCreate && !(closeMatch && request.method === 'POST')) return json({ error: 'not found' }, 404, origin);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'invalid JSON body' }, 400, origin); }
  if (!body || typeof body !== 'object') return json({ error: 'JSON object body required' }, 400, origin);

  // Retry once on a version conflict (frontend or webhook saving in the same instant).
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, version } = await getState(env, userId);
    const trades = data.trades || [];
    let trade;
    let nextTrades;
    if (isCreate) {
      const built = buildTrade(body, data.strategies);
      if (built.error) return json({ error: built.error }, 400, origin);
      trade = built.trade;
      nextTrades = trades.concat([trade]);
    } else {
      const existing = trades.find((t) => t.id === closeMatch[1]);
      if (!existing) return json({ error: 'trade not found' }, 404, origin);
      if (existing.status !== 'open') return json({ error: 'trade is already closed' }, 409, origin);
      const exit = toNum(body.exit);
      if (!isNum(exit)) return json({ error: 'numeric exit is required' }, 400, origin);
      let pnl = toNum(body.pnl);
      if (!isNum(pnl)) pnl = autoPnl(existing, exit);
      if (!isNum(pnl)) return json({ error: 'pnl is required (trade has no size)' }, 400, origin);
      const exitTime = TIME_RE.test(String(body.exitTime || '')) ? body.exitTime : existing.entryTime || '00:00';
      trade = Object.assign({}, existing, { status: 'closed', exit, exitTime, pnl });
      nextTrades = trades.map((t) => (t.id === trade.id ? trade : t));
    }
    const result = await saveState(env, userId, Object.assign({}, data, { trades: nextTrades }), version);
    if (!result.conflict) return json({ trade: summarize(trade, data.strategies), version: result.version }, 200, origin);
  }
  return json({ error: 'could not save after retry, please retry' }, 409, origin);
}
