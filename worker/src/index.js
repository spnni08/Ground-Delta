// Ground Delta backend worker — Phase 3 + Firebase Auth.
//
// Stores the { strategies, trades } tree as one JSON blob per Firebase
// user (D1 row keyed by UID — see schema.sql), guarded by an
// optimistic-lock `version` column so a stale frontend write can't
// silently clobber a trade the webhook just closed. Exposes:
//   GET  /api/state              -> { data, version }              [Firebase ID token required]
//   PUT  /api/state              -> { data, expectedVersion } -> { version } | 409   [Firebase ID token required]
//   POST /webhook/close          -> TradingView alert -> closes matching open trade(s)  [API_KEY + ?uid= required]
//
// /api/state authenticates the caller via a Firebase ID token
// (`Authorization: Bearer <token>`), verified here against Google's
// public JWKS using Web Crypto only — no Firebase Admin SDK needed
// (its Node dependencies don't run in the Workers runtime anyway).
// The verified token's `sub` claim (the Firebase UID) is the D1 row
// key, so each user's trades are isolated automatically.
//
// /webhook/close can't carry a user's login (TradingView can't log
// in), so it keeps the shared-secret `API_KEY` (`X-Api-Key` header or
// `?key=` query param) plus an explicit `?uid=` telling it whose
// trades to search — put both in the TradingView alert's webhook URL.

const FIREBASE_PROJECT_ID_DEFAULT = 'ground-delta-journal';
const DEFAULT_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Api-Key,Authorization',
    'Access-Control-Max-Age': '86400'
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders(origin))
  });
}

function webhookAuthOk(request, env, url) {
  if (!env.API_KEY) return true; // no key configured yet — dev/first-deploy convenience
  const header = request.headers.get('X-Api-Key');
  const query = url.searchParams.get('key');
  return header === env.API_KEY || query === env.API_KEY;
}

// ---- Firebase ID token verification (JWKS + Web Crypto, no Admin SDK) ----

let jwksCache = { keys: null, fetchedAt: 0 };

async function getJwks(env) {
  const now = Date.now();
  if (jwksCache.keys && now - jwksCache.fetchedAt < 3600 * 1000) return jwksCache.keys;
  const url = env.FIREBASE_JWKS_URL || DEFAULT_JWKS_URL;
  const res = await fetch(url);
  if (!res.ok) throw new Error('failed to fetch JWKS: ' + res.status);
  const data = await res.json();
  jwksCache = { keys: data.keys, fetchedAt: now };
  return data.keys;
}

function b64urlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64url.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function b64urlToJson(b64url) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(b64url)));
}

async function verifyFirebaseToken(idToken, env) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [headerB64, payloadB64, sigB64] = parts;
  const header = b64urlToJson(headerB64);
  const payload = b64urlToJson(payloadB64);
  if (header.alg !== 'RS256') throw new Error('unexpected alg ' + header.alg);

  const keys = await getJwks(env);
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('unknown key id');

  const cryptoKey = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
  );
  const signedData = new TextEncoder().encode(headerB64 + '.' + payloadB64);
  const signature = b64urlToBytes(sigB64);
  const validSig = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signature, signedData);
  if (!validSig) throw new Error('invalid signature');

  const projectId = env.FIREBASE_PROJECT_ID || FIREBASE_PROJECT_ID_DEFAULT;
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId) throw new Error('wrong audience');
  if (payload.iss !== 'https://securetoken.google.com/' + projectId) throw new Error('wrong issuer');
  if (typeof payload.exp !== 'number' || payload.exp < now) throw new Error('token expired');
  if (typeof payload.iat !== 'number' || payload.iat > now + 60) throw new Error('token not yet valid');
  if (typeof payload.auth_time !== 'number' || payload.auth_time > now + 60) throw new Error('bad auth_time');
  if (!payload.sub) throw new Error('missing subject');
  return { uid: payload.sub, email: payload.email || null };
}

async function requireUser(request, env) {
  const header = request.headers.get('Authorization') || '';
  const m = header.match(/^Bearer (.+)$/);
  if (!m) throw new Error('missing bearer token');
  return verifyFirebaseToken(m[1], env);
}

// ---- state storage (per-user row, keyed by Firebase UID) ----

const LEGACY_WORKSPACE_ID = 'default';

// One-time upgrade path: anyone who deployed Phase 3 before auth
// existed has their data sitting under the fixed row id 'default'.
// The first time a real user's row comes up empty, adopt that legacy
// row as theirs (copy it under their UID) rather than presenting them
// with an empty journal. Safe to run on every empty-state read: once
// the legacy row's data has been copied over, this is a no-op.
async function migrateLegacyRow(env, uid) {
  const legacy = await env.DB.prepare('SELECT data FROM workspace_state WHERE id = ?')
    .bind(LEGACY_WORKSPACE_ID).first();
  if (!legacy) return null;
  const data = JSON.parse(legacy.data);
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO workspace_state (id, data, version, updated_at) VALUES (?, ?, 1, ?) ' +
    'ON CONFLICT(id) DO NOTHING'
  ).bind(uid, legacy.data, now).run();
  return data;
}

async function getState(env, uid) {
  const row = await env.DB.prepare('SELECT data, version FROM workspace_state WHERE id = ?')
    .bind(uid).first();
  if (row) return { data: JSON.parse(row.data), version: row.version };
  const legacyData = await migrateLegacyRow(env, uid);
  if (legacyData) return { data: legacyData, version: 1 };
  return { data: { strategies: [], trades: [] }, version: 0 };
}

async function saveState(env, uid, data, expectedVersion) {
  const now = new Date().toISOString();
  const existing = await env.DB.prepare('SELECT version FROM workspace_state WHERE id = ?')
    .bind(uid).first();
  const currentVersion = existing ? existing.version : 0;
  if (expectedVersion != null && expectedVersion !== currentVersion) {
    return { conflict: true, version: currentVersion };
  }
  const nextVersion = currentVersion + 1;
  await env.DB.prepare(
    'INSERT INTO workspace_state (id, data, version, updated_at) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET data = excluded.data, version = excluded.version, updated_at = excluded.updated_at'
  ).bind(uid, JSON.stringify(data), nextVersion, now).run();
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

async function handleWebhookClose(request, env, origin, uid) {
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
    const { data, version } = await getState(env, uid);
    const { updated, closedIds } = closeHitTrades(data.trades || [], symbol, price, time);
    if (closedIds.length === 0) return json({ closed: [], message: 'no open trade on ' + symbol + ' hit TP/SL at ' + price }, 200, origin);
    const result = await saveState(env, uid, Object.assign({}, data, { trades: updated }), version);
    if (!result.conflict) return json({ closed: closedIds, version: result.version }, 200, origin);
  }
  return json({ error: 'could not save after retry, please retry the alert' }, 409, origin);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(origin) });

    if (url.pathname === '/api/state' && (request.method === 'GET' || request.method === 'PUT')) {
      let uid;
      try { ({ uid } = await requireUser(request, env)); }
      catch (e) { return json({ error: 'unauthorized: ' + e.message }, 401, origin); }

      if (request.method === 'GET') {
        return json(await getState(env, uid), 200, origin);
      }
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'invalid JSON body' }, 400, origin); }
      if (!body || typeof body !== 'object' || !body.data) return json({ error: '"data" is required' }, 400, origin);
      const result = await saveState(env, uid, body.data, body.expectedVersion);
      if (result.conflict) return json({ error: 'version conflict', version: result.version }, 409, origin);
      return json({ version: result.version }, 200, origin);
    }

    if (url.pathname === '/webhook/close' && request.method === 'POST') {
      if (!webhookAuthOk(request, env, url)) return json({ error: 'unauthorized' }, 401, origin);
      const uid = url.searchParams.get('uid');
      if (!uid) return json({ error: '?uid= query param is required' }, 400, origin);
      return handleWebhookClose(request, env, origin, uid);
    }

    return json({ error: 'not found' }, 404, origin);
  }
};
