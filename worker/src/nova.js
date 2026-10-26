// NOVA (personal assistant) access to ONE user's journal.
//
//   GET  /nova/trades?uid=X[&status=open|closed|all][&from=YYYY-MM-DD][&to=YYYY-MM-DD][&limit=N]
//        -> { trades: [...], strategies: [{ id, name }] }                      [read token]
//   POST /nova/trades?uid=X                body: new trade (see sanitizeAdd)    [write token]
//        -> { trade, version }
//   POST /nova/trades/:id/close?uid=X      body: { exit, exitTime?, pnl? }      [write token]
//        -> { trade, version }
//
// There is no delete and no general edit: NOVA can read, add and close, nothing else.
//
// Two separate secrets, each sent as `X-Api-Key` (or `Authorization: Bearer`),
// never as a query param, compared in constant time (SHA-256 digests):
//   NOVA_ACCESS_TOKEN  read token  -> only GET /nova/trades        (403 on the write routes)
//   NOVA_WRITE_TOKEN   write token -> only the two POST routes     (403 on GET)
// Both must be >= 32 chars; the write token must differ from the read token
// (otherwise writes stay disabled). Unset/short tokens never match (fail closed).
// Unknown token -> 401. Wrong token kind for a route -> 403.
//
// Both token kinds only ever touch the journal of NOVA_ALLOWED_UID (?uid= must match).
//
// Writes:
//  - require an `Idempotency-Key` header (8-128 chars [A-Za-z0-9._:-]). The first
//    successful result is stored for 24 h; the same key + same request returns it
//    again (header `Idempotent-Replay: true`) instead of creating another trade; the
//    same key with a different request is 422; while the first request is still running 409.
//  - validate strictly (required fields, JSON types, ranges, lengths); unknown fields are dropped.
//  - closing needs an open trade: unknown id 404, already closed 409.
//  - are logged to nova_audit_log (timestamp, source 'nova', action, uid, trade id, key, outcome).
//  - use the same optimistic-lock saveState() as the frontend (one retry on a version conflict).
//
// Reads return a minimal shape: journal notes are blanked, no rating/screenshot/rules/credentials.
//
// Rate limit: fixed window per client IP, counted before authentication, in the
// memory of one Worker isolate (best effort, not global): reads 60/min, writes 10/min.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const SYMBOL_RE = /^[A-Z0-9][A-Z0-9._:/-]{0,23}$/;
const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const MIN_TOKEN_LENGTH = 32;
const MAX_BODY_BYTES = 8192;
const MAX_PRICE = 1e9;
export const RATE_LIMIT = { read: { max: 60, windowMs: 60_000 }, write: { max: 10, windowMs: 60_000 } };

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v) => (isNum(v) ? v : null);
const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);

// ---------- rate limit ----------

const buckets = new Map();
export function resetRateLimit() { buckets.clear(); }

/** Returns seconds to wait if the client is over the limit, else 0. */
function rateLimited(kind, ip, now) {
  const { max, windowMs } = RATE_LIMIT[kind];
  if (buckets.size > 1000) {
    for (const [k, b] of buckets) if (now - b.start >= b.windowMs) buckets.delete(k);
  }
  const key = kind + ':' + ip;
  let b = buckets.get(key);
  if (!b || now - b.start >= windowMs) { b = { start: now, count: 0, windowMs }; buckets.set(key, b); }
  b.count++;
  return b.count > max ? Math.ceil((b.start + windowMs - now) / 1000) : 0;
}

// ---------- auth ----------

async function digest(s) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}
const sameBytes = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; };
const usable = (t) => typeof t === 'string' && t.length >= MIN_TOKEN_LENGTH;

/** -> 'read' | 'write' | null. Always hashes everything so timing doesn't tell which token matched. */
async function tokenRole(request, env) {
  const bearer = (request.headers.get('Authorization') || '').match(/^Bearer (.+)$/i);
  const given = request.headers.get('X-Api-Key') || (bearer ? bearer[1] : '');
  const writeEnabled = usable(env.NOVA_WRITE_TOKEN) && env.NOVA_WRITE_TOKEN !== env.NOVA_ACCESS_TOKEN;
  const [g, r, w] = await Promise.all([digest(given), digest(env.NOVA_ACCESS_TOKEN || ''), digest(env.NOVA_WRITE_TOKEN || '')]);
  const isRead = usable(env.NOVA_ACCESS_TOKEN) && sameBytes(g, r);
  const isWrite = writeEnabled && sameBytes(g, w);
  return isRead ? 'read' : isWrite ? 'write' : null;
}

function reply(data, status, extraHeaders) {
  return new Response(typeof data === 'string' ? data : JSON.stringify(data), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, extraHeaders),
  });
}

// ---------- read ----------

// Only what NOVA's GdTrade type needs. Free-text notes are deliberately blanked.
function summarize(t, strategies) {
  const s = (strategies || []).find((x) => x.id === t.strategyId);
  return {
    id: t.id, date: t.date, entryTime: t.entryTime || '', exitTime: t.exitTime || '', symbol: t.symbol, dir: t.dir,
    entry: t.entry, exit: numOrNull(t.exit), sl: numOrNull(t.sl), tp: numOrNull(t.tp),
    size: t.size, leverage: t.leverage, pnl: numOrNull(t.pnl), status: t.status === 'open' ? 'open' : 'closed',
    session: t.session || '', strategy: s ? s.name : '', notes: '',
  };
}

async function handleList(url, userId, deps) {
  const status = url.searchParams.get('status') || 'all';
  if (!['all', 'open', 'closed'].includes(status)) return reply({ error: 'status must be open, closed or all' }, 400);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) return reply({ error: 'from/to must be YYYY-MM-DD' }, 400);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));

  const { data } = await deps.readState(deps.env, userId);
  const strategies = data.strategies || [];
  const list = (data.trades || [])
    .filter((t) => status === 'all' || (status === 'open' ? t.status === 'open' : t.status !== 'open'))
    .filter((t) => (!from || t.date >= from) && (!to || t.date <= to))
    .sort((a, b) => ((b.date || '') + (b.entryTime || '')).localeCompare((a.date || '') + (a.entryTime || '')))
    .slice(0, limit)
    .map((t) => summarize(t, strategies));
  return reply({ trades: list, strategies: strategies.map((s) => ({ id: s.id, name: s.name })) }, 200);
}

// ---------- write: validation ----------

function validDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && d.getUTCFullYear() >= 2000;
}

/** Optional field helper: absent/null -> undefined; wrong type/range -> pushes an error. */
function field(b, name, errors, check) {
  const v = b[name];
  if (v === undefined || v === null) return undefined;
  const msg = check(v);
  if (msg) { errors.push(name + ' ' + msg); return undefined; }
  return v;
}
const price = (v) => (!isNum(v) ? 'must be a number' : v <= 0 || v > MAX_PRICE ? 'must be > 0 and <= ' + MAX_PRICE : null);
const timeHM = (v) => (typeof v !== 'string' || !TIME_RE.test(v) ? 'must be HH:MM' : null);
const text = (max) => (v) => (typeof v !== 'string' ? 'must be a string' : v.length > max ? 'must be at most ' + max + ' characters' : null);

/** -> { value } with only the known fields, or { errors: [...] }. */
export function sanitizeAdd(b, strategies) {
  const errors = [];
  const out = {};
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { errors: ['body must be a JSON object'] };

  if (!validDate(b.date)) errors.push('date is required (YYYY-MM-DD)'); else out.date = b.date;
  if (typeof b.symbol !== 'string' || !SYMBOL_RE.test(b.symbol.trim().toUpperCase())) errors.push('symbol is required (1-24 chars: A-Z, 0-9, . _ : / -)');
  else out.symbol = b.symbol.trim().toUpperCase();
  const dir = typeof b.dir === 'string' ? b.dir.toLowerCase() : '';
  if (dir !== 'long' && dir !== 'short') errors.push('dir is required (Long or Short)'); else out.dir = dir === 'long' ? 'Long' : 'Short';
  if (!isNum(b.entry) || b.entry <= 0 || b.entry > MAX_PRICE) errors.push('entry is required (number > 0 and <= ' + MAX_PRICE + ')'); else out.entry = b.entry;

  for (const k of ['sl', 'tp', 'exit']) { const v = field(b, k, errors, price); if (v !== undefined) out[k] = v; }
  for (const k of ['entryTime', 'exitTime']) { const v = field(b, k, errors, timeHM); if (v !== undefined) out[k] = v; }
  const size = field(b, 'size', errors, price); if (size !== undefined) out.size = size;
  const lev = field(b, 'leverage', errors, (v) => (!isNum(v) ? 'must be a number' : v < 1 || v > 1000 ? 'must be between 1 and 1000' : null));
  if (lev !== undefined) out.leverage = lev;
  const pnl = field(b, 'pnl', errors, (v) => (!isNum(v) ? 'must be a number' : Math.abs(v) > MAX_PRICE ? 'is out of range' : null));
  if (pnl !== undefined) out.pnl = pnl;
  for (const [k, max] of [['session', 40], ['strategy', 60], ['notes', 2000]]) { const v = field(b, k, errors, text(max)); if (v !== undefined) out[k] = v; }

  if (out.strategy) {
    const want = out.strategy.toLowerCase();
    const s = (strategies || []).find((x) => x.id === out.strategy || String(x.name || '').toLowerCase() === want);
    if (!s) errors.push('strategy is unknown: ' + out.strategy.slice(0, 60)); else out.strategyId = s.id;
  }
  if (out.exit !== undefined && out.pnl === undefined && out.size === undefined) errors.push('pnl or size is required to enter a closed trade');
  return errors.length ? { errors } : { value: out };
}

export function sanitizeClose(b) {
  const errors = [];
  const out = {};
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { errors: ['body must be a JSON object'] };
  if (!isNum(b.exit) || b.exit <= 0 || b.exit > MAX_PRICE) errors.push('exit is required (number > 0 and <= ' + MAX_PRICE + ')'); else out.exit = b.exit;
  const t = field(b, 'exitTime', errors, timeHM); if (t !== undefined) out.exitTime = t;
  const pnl = field(b, 'pnl', errors, (v) => (!isNum(v) ? 'must be a number' : Math.abs(v) > MAX_PRICE ? 'is out of range' : null));
  if (pnl !== undefined) out.pnl = pnl;
  return errors.length ? { errors } : { value: out };
}

// Mirrors the frontend's autoPnl(): (exit-entry) * size * leverage, sign-flipped for shorts.
function autoPnl(t, exit) {
  if (!isNum(t.size) || t.size <= 0) return null;
  const lev = isNum(t.leverage) && t.leverage > 0 ? t.leverage : 1;
  const sign = t.dir === 'Short' ? -1 : 1;
  return Math.round((exit - t.entry) * sign * t.size * lev * 100) / 100;
}

function buildTrade(v, nowIso) {
  const base = {
    id: newId(), date: v.date, entryTime: v.entryTime || '00:00', symbol: v.symbol, dir: v.dir, entry: v.entry,
    sl: v.sl ?? NaN, tp: v.tp ?? NaN, size: v.size ?? 0, leverage: v.leverage ?? 1,
    session: v.session || '', strategyId: v.strategyId || '', checks: {}, notes: v.notes || '', shot: null,
    source: 'nova', novaCreatedAt: nowIso,
  };
  if (v.exit === undefined) return Object.assign(base, { exitTime: '', exit: null, pnl: null, rating: null, status: 'open' });
  return Object.assign(base, {
    exit: v.exit, exitTime: v.exitTime || '', pnl: v.pnl ?? autoPnl(base, v.exit), rating: null, status: 'closed',
  });
}

// ---------- write: handler ----------

async function sha256Hex(s) {
  return Array.from(await digest(s), (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Canonical JSON (sorted keys) so the same logical request always hashes the same. */
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

async function handleWrite(request, url, userId, closeId, deps) {
  const nowIso = new Date(deps.now()).toISOString();
  const action = closeId === null ? 'trade_add' : 'trade_close';
  const key = request.headers.get('Idempotency-Key') || '';
  const log = async (outcome, status, detail, tradeId) => {
    try { await deps.store.audit({ ts: nowIso, action, uid: userId, tradeId, key: KEY_RE.test(key) ? key : null, outcome, status, detail }); }
    catch (e) { console.error('nova audit failed', e && e.message); }
  };
  const reject = async (status, error, tradeId) => {
    await log('rejected', status, error.slice(0, 200), tradeId);
    return reply({ error }, status);
  };

  if (!KEY_RE.test(key)) return reject(400, 'Idempotency-Key header is required (8-128 chars: A-Z a-z 0-9 . _ : -)');

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return reject(413, 'body too large');
  let body;
  try { body = JSON.parse(raw); } catch (e) { return reject(400, 'invalid JSON body'); }

  // Strategies are needed to validate an add; read them once up front.
  let strategies = [];
  if (closeId === null) strategies = ((await deps.readState(deps.env, userId)).data.strategies) || [];
  const parsed = closeId === null ? sanitizeAdd(body, strategies) : sanitizeClose(body);
  if (parsed.errors) return reject(400, 'invalid request: ' + parsed.errors.join('; '), closeId);

  const hash = await sha256Hex(['POST', closeId === null ? '/nova/trades' : '/nova/trades/' + closeId + '/close', userId, canon(parsed.value)].join('\n'));
  const claim = await deps.store.claim(key, hash, deps.now());
  if (claim.state === 'done') {
    if (claim.hash !== hash) return reject(422, 'Idempotency-Key was already used for a different request', closeId);
    await log('replay', claim.status, null, closeId);
    return reply(claim.body, claim.status, { 'Idempotent-Replay': 'true' });
  }
  if (claim.state === 'pending') return reply({ error: 'a request with this Idempotency-Key is still in progress, retry shortly' }, 409, { 'Retry-After': '1' });

  const fail = async (status, error) => { await deps.store.release(key); return reject(status, error, closeId); };
  try {
    // Retry once on a version conflict (frontend or webhook saving in the same instant).
    for (let attempt = 0; attempt < 2; attempt++) {
      const { data, version } = await deps.readState(deps.env, userId);
      const trades = data.trades || [];
      let trade;
      let nextTrades;
      if (closeId === null) {
        trade = buildTrade(parsed.value, nowIso);
        if (trade.status === 'closed' && !isNum(trade.pnl)) return await fail(400, 'invalid request: pnl or size is required to enter a closed trade');
        nextTrades = trades.concat([trade]);
      } else {
        const existing = trades.find((t) => t.id === closeId);
        if (!existing) return await fail(404, 'trade not found');
        if (existing.status !== 'open') return await fail(409, 'trade is already closed');
        const pnl = parsed.value.pnl ?? autoPnl(existing, parsed.value.exit);
        if (!isNum(pnl)) return await fail(400, 'invalid request: pnl is required (trade has no size)');
        trade = Object.assign({}, existing, {
          status: 'closed', exit: parsed.value.exit, pnl,
          exitTime: parsed.value.exitTime || nowIso.slice(11, 16), closedSource: 'nova', novaClosedAt: nowIso,
        });
        nextTrades = trades.map((t) => (t.id === trade.id ? trade : t));
      }
      const result = await deps.saveState(deps.env, userId, Object.assign({}, data, { trades: nextTrades }), version);
      if (result.conflict) continue;
      const out = JSON.stringify({ trade: summarize(trade, data.strategies), version: result.version });
      await log('ok', 200, null, trade.id);
      await deps.store.complete(key, 200, out);
      return reply(out, 200);
    }
    return await fail(409, 'could not save after retry, please retry');
  } catch (e) {
    await deps.store.release(key).catch(() => {});
    console.error('nova write failed', e && e.message);
    return reply({ error: 'internal error' }, 500);
  }
}

// ---------- router ----------

/**
 * Returns a Response for /nova/* or null if the path isn't ours.
 * deps: { env, readState(env, uid), saveState(env, uid, data, expectedVersion),
 *         isBlocked(env, uid), store: { claim, complete, release, audit }, now?() }
 */
export async function handleNova(request, env, url, deps) {
  if (url.pathname !== '/nova' && !url.pathname.startsWith('/nova/')) return null;
  deps = Object.assign({ env, now: Date.now }, deps);
  const now = deps.now();

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const isPost = request.method === 'POST';
  const wait = rateLimited(isPost ? 'write' : 'read', ip, now);
  if (wait) return reply({ error: 'rate limit exceeded' }, 429, { 'Retry-After': String(wait) });

  const role = await tokenRole(request, env);
  if (!role) return reply({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });

  let closeId = null; // null = not a close route
  let route;
  if (url.pathname === '/nova/trades') route = 'trades';
  else {
    const m = url.pathname.match(/^\/nova\/trades\/([^/]+)\/close$/);
    if (m) {
      route = 'close';
      try { closeId = decodeURIComponent(m[1]); } catch (e) { return reply({ error: 'not found' }, 404); }
      if (closeId.length > 64) return reply({ error: 'not found' }, 404);
    }
  }
  if (!route) return reply({ error: 'not found' }, 404);

  const allowed = route === 'trades' ? ['GET', 'POST'] : ['POST'];
  if (!allowed.includes(request.method)) return reply({ error: 'method not allowed' }, 405, { Allow: allowed.join(', ') });

  const needs = request.method === 'GET' ? 'read' : 'write';
  if (role !== needs) {
    return reply({ error: needs === 'write' ? 'forbidden: the read token cannot write' : 'forbidden: the write token cannot read' }, 403);
  }

  if (!env.NOVA_ALLOWED_UID) return reply({ error: 'NOVA access is not configured (NOVA_ALLOWED_UID missing)' }, 503);
  const userId = url.searchParams.get('uid');
  if (!userId) return reply({ error: '?uid= query param is required' }, 400);
  if (userId !== env.NOVA_ALLOWED_UID) return reply({ error: 'forbidden' }, 403);
  if (await deps.isBlocked(env, userId)) return reply({ error: 'account blocked' }, 403);

  return needs === 'read' ? handleList(url, userId, deps) : handleWrite(request, url, userId, route === 'close' ? closeId : null, deps);
}
