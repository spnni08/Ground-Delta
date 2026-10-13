// NOVA (personal assistant) READ-ONLY access to one user's journal.
//
//   GET /nova/trades?uid=X[&status=open|closed|all][&from=YYYY-MM-DD][&to=YYYY-MM-DD][&limit=N]
//       -> { trades: [...], strategies: [{ id, name }] }
//
// This is the only route. Every other method on it answers 405, every other
// path 404 (after authentication). Nothing in this file writes: the handler
// gets a `readState` dependency (a plain SELECT) and no save function.
//
// Auth: a dedicated secret `NOVA_ACCESS_TOKEN`, sent in the `X-Api-Key`
// header (what NOVA's worker sends) or as `Authorization: Bearer <token>`.
// It is separate from `API_KEY` (TradingView webhook) and from the Firebase
// login, and never accepted as a `?key=` query param. Compared in constant
// time (SHA-256 digests, so the length doesn't leak either). Fails closed:
// no token configured, or one shorter than MIN_TOKEN_LENGTH -> always 401.
//
// Scope: the token only opens the journal of the single UID configured in
// `NOVA_ALLOWED_UID`; any other `?uid=` is 403. NOVA's request format
// (`?uid=`) is kept as is.
//
// Output is minimised: notes (free text), rating, screenshots, rule checks and
// the internal `source` field are never returned. `notes` stays in the
// response as "" because NOVA's type expects the field.
//
// Rate limit: fixed window per client IP, counted before authentication so
// brute-force attempts are limited too. It lives in the memory of one Worker
// isolate, i.e. it is best effort, not a global limit.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_TOKEN_LENGTH = 32;
export const RATE_LIMIT = { max: 60, windowMs: 60_000 };

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v) => (isNum(v) ? v : null);

const buckets = new Map();
export function resetRateLimit() { buckets.clear(); }

/** Returns seconds to wait if the client is over the limit, else 0. */
function rateLimited(key, now) {
  if (buckets.size > 1000) {
    for (const [k, b] of buckets) if (now - b.start >= RATE_LIMIT.windowMs) buckets.delete(k);
  }
  let b = buckets.get(key);
  if (!b || now - b.start >= RATE_LIMIT.windowMs) { b = { start: now, count: 0 }; buckets.set(key, b); }
  b.count++;
  return b.count > RATE_LIMIT.max ? Math.ceil((b.start + RATE_LIMIT.windowMs - now) / 1000) : 0;
}

async function digest(s) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

async function tokenOk(request, env) {
  const expected = env.NOVA_ACCESS_TOKEN;
  if (typeof expected !== 'string' || expected.length < MIN_TOKEN_LENGTH) return false;
  const bearer = (request.headers.get('Authorization') || '').match(/^Bearer (.+)$/i);
  const given = request.headers.get('X-Api-Key') || (bearer ? bearer[1] : '');
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function reply(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, extraHeaders),
  });
}

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

/**
 * Returns a Response for /nova/* or null if the path isn't ours.
 * deps: { readState(env, uid) -> { data }, isBlocked(env, uid), now?() }
 */
export async function handleNova(request, env, url, deps) {
  if (url.pathname !== '/nova' && !url.pathname.startsWith('/nova/')) return null;
  const now = deps.now ? deps.now() : Date.now();

  const wait = rateLimited(request.headers.get('CF-Connecting-IP') || 'unknown', now);
  if (wait) return reply({ error: 'rate limit exceeded' }, 429, { 'Retry-After': String(wait) });

  if (!(await tokenOk(request, env))) return reply({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });

  if (url.pathname !== '/nova/trades') return reply({ error: 'not found' }, 404);
  if (request.method !== 'GET') {
    return reply({ error: 'read-only: NOVA access cannot create, change or delete anything' }, 405, { Allow: 'GET' });
  }

  if (!env.NOVA_ALLOWED_UID) return reply({ error: 'NOVA access is not configured (NOVA_ALLOWED_UID missing)' }, 503);
  const userId = url.searchParams.get('uid');
  if (!userId) return reply({ error: '?uid= query param is required' }, 400);
  if (userId !== env.NOVA_ALLOWED_UID) return reply({ error: 'forbidden' }, 403);
  if (await deps.isBlocked(env, userId)) return reply({ error: 'account blocked' }, 403);

  const status = url.searchParams.get('status') || 'all';
  if (!['all', 'open', 'closed'].includes(status)) return reply({ error: 'status must be open, closed or all' }, 400);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) return reply({ error: 'from/to must be YYYY-MM-DD' }, 400);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));

  const { data } = await deps.readState(env, userId);
  const strategies = data.strategies || [];
  const list = (data.trades || [])
    .filter((t) => status === 'all' || (status === 'open' ? t.status === 'open' : t.status !== 'open'))
    .filter((t) => (!from || t.date >= from) && (!to || t.date <= to))
    .sort((a, b) => ((b.date || '') + (b.entryTime || '')).localeCompare((a.date || '') + (a.entryTime || '')))
    .slice(0, limit)
    .map((t) => summarize(t, strategies));
  return reply({ trades: list, strategies: strategies.map((s) => ({ id: s.id, name: s.name })) }, 200);
}
