// Ground Delta backend worker — Phase 3 + Firebase Auth + admin panel.
//
// Stores the { strategies, trades } tree as one JSON blob per Firebase
// user (D1 row keyed by UID — see schema.sql), guarded by an
// optimistic-lock `version` column so a stale frontend write can't
// silently clobber a trade the webhook just closed. Exposes:
//   GET    /api/state                      -> { data, version }              [Firebase ID token required]
//   PUT    /api/state                      -> { data, expectedVersion } -> { version } | 409   [Firebase ID token required]
//   POST   /webhook/close                  -> TradingView alert -> closes matching open trade(s)  [API_KEY + ?uid= required]
//   GET    /admin/users                    -> [{ uid, tradeCount, strategyCount, version, updatedAt, blocked, lastSeen, online }]  [admin UID only]
//   GET    /admin/state?uid=X              -> { data, version }                                          [admin UID only]
//   PUT    /admin/state?uid=X              -> { data, expectedVersion } -> { version } | 409             [admin UID only]
//   GET    /admin/stats                    -> { userCount, tradeCount, strategyCount }                   [admin UID only]
//   POST   /admin/users                    -> { email, password } -> { uid }                             [admin UID only]
//   POST   /admin/users/:uid/block         -> {}                                                         [admin UID only]
//   POST   /admin/users/:uid/unblock       -> {}                                                         [admin UID only]
//   POST   /admin/users/:uid/revoke-sessions -> {} (force logout everywhere)                             [admin UID only]
//   POST   /admin/users/:uid/reset-password -> { newPassword } -> {}                                     [admin UID only]
//   DELETE /admin/users/:uid               -> {} (deletes trades/state AND the Firebase Auth account)    [admin UID only]
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
//
// /admin/* is gated by a single hardcoded ADMIN_UID (below), not a
// role stored in D1 — there's exactly one admin account, deliberately
// created outside any normal trading workflow, so no code path can
// accidentally promote a regular user into it. Every /admin/* request
// still goes through the same requireUser() Firebase-token check as
// /api/state; the only difference is an extra uid === ADMIN_UID gate
// (403 for anyone else, including other valid, logged-in users).
//
// A handful of the newer admin actions (creating a user, forcing a
// logout everywhere, resetting a password, deleting a Firebase Auth
// account) can't be done with just the Web API key this worker already
// used for token verification — Google's Identity Toolkit REST API
// only allows those *administrative* operations (acting on an
// arbitrary target UID, not "the currently signed-in user") when the
// caller authenticates with an OAuth2 access token minted from a
// Firebase/GCP *service account*. See getServiceAccountToken() below
// for exactly what that needs and how it degrades (loudly, not
// silently) when it isn't configured.

const FIREBASE_PROJECT_ID_DEFAULT = 'ground-delta-journal';
const DEFAULT_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const IDENTITY_TOOLKIT_BASE = 'https://identitytoolkit.googleapis.com/v1';
const ONLINE_WINDOW_MS = 5 * 60 * 1000; // "online" = /api/state seen in the last 5 minutes

// The one and only admin account's Firebase UID (admin@grounddelta.de,
// registered specifically as an internal tool — not a real trading
// account). Whoever controls this UID can read/write every user's
// trades, so treat it like a secret even though it isn't one
// technically: don't publish it, and if it ever needs to change,
// update it here and redeploy.
const ADMIN_UID = 'jD5DYwkIm6dAj20yZ0UIGGh9ArG2';

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET,PUT,POST,DELETE,OPTIONS',
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

function bytesToB64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

// Same Firebase-token check as requireUser(), plus the admin-UID gate.
// Throws (never returns a non-admin uid) so callers can treat any
// failure here identically to an auth failure.
async function requireAdmin(request, env) {
  const { uid, email } = await requireUser(request, env);
  if (uid !== ADMIN_UID) throw new Error('forbidden: not the admin account');
  return { uid, email };
}

// ---- service-account OAuth2 (Identity Toolkit *admin* operations) ----
//
// The JWKS check above only ever *verifies* a token Firebase already
// issued to its rightful owner. Creating a user needs no special
// privilege (any client with the public Web API key can sign someone
// up), so createFirebaseUser() below just uses env.FIREBASE_API_KEY.
// But forcing a logout, resetting a password, or deleting an account
// that ISN'T the caller's own requires Identity Toolkit's admin
// surface, which only accepts a Google OAuth2 access token obtained
// via a service account's private key — there is no way to do this
// with the browser API key alone, and Cloudflare Workers can't run the
// Node-based firebase-admin SDK. So:
//
//   1. In the Firebase console: Project settings -> Service accounts
//      -> "Generate new private key" -> downloads a JSON file.
//   2. `wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON` and paste
//      the ENTIRE file contents as the secret value.
//
// Until that secret is set, revokeSessions/resetPassword/
// deleteFirebaseUser all throw a clear, descriptive error (surfaced as
// a 500 with that message) instead of silently doing nothing.
let saTokenCache = { token: null, expiresAt: 0 };

function pemToDer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function getServiceAccountToken(env) {
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw new Error(
      'this action requires a Firebase service account: set the FIREBASE_SERVICE_ACCOUNT_JSON secret ' +
      '(Firebase console -> Project settings -> Service accounts -> Generate new private key), ' +
      'see the comment above getServiceAccountToken() in src/index.js'
    );
  }
  const now = Date.now();
  if (saTokenCache.token && saTokenCache.expiresAt - 60000 > now) return saTokenCache.token;

  let sa;
  try { sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON); }
  catch (e) { throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON'); }
  if (!sa.client_email || !sa.private_key) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is missing client_email/private_key');

  const iat = Math.floor(now / 1000);
  const exp = iat + 3600;
  const enc = (obj) => bytesToB64url(new TextEncoder().encode(JSON.stringify(obj)));
  const unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/firebase',
    aud: 'https://oauth2.googleapis.com/token',
    iat, exp
  });
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToDer(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const jwt = unsigned + '.' + bytesToB64url(new Uint8Array(sigBuf));

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt
  });
  const tokenData = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('service-account token exchange failed: ' + res.status + ' ' + JSON.stringify(tokenData));
  saTokenCache = { token: tokenData.access_token, expiresAt: now + tokenData.expires_in * 1000 };
  return tokenData.access_token;
}

async function identityToolkitCall(env, endpoint, body, useServiceAccount) {
  let headers = { 'Content-Type': 'application/json' };
  let url = IDENTITY_TOOLKIT_BASE + '/' + endpoint;
  if (useServiceAccount) {
    headers.Authorization = 'Bearer ' + (await getServiceAccountToken(env));
  } else {
    if (!env.FIREBASE_API_KEY) throw new Error('FIREBASE_API_KEY is not configured (wrangler secret put FIREBASE_API_KEY)');
    url += '?key=' + encodeURIComponent(env.FIREBASE_API_KEY);
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || (endpoint + ' failed: ' + res.status));
  return data;
}

// No elevated privilege needed — signUp with the public Web API key is
// exactly how any normal client registers a new account.
function createFirebaseUser(env, email, password) {
  return identityToolkitCall(env, 'accounts:signUp', { email, password, returnSecureToken: false }, false);
}

// `validSince` invalidates every refresh token issued before this
// instant, which is Firebase's actual "force logout everywhere"
// mechanism (existing ID tokens still work until they expire on their
// own — normally within the hour — since Firebase doesn't check
// validSince on every single request, only on refresh; this is the
// real, documented limit of server-side revocation, not a corner we
// cut).
function revokeSessions(env, uid) {
  return identityToolkitCall(env, 'accounts:update', { localId: uid, validSince: String(Math.floor(Date.now() / 1000)) }, true);
}

function resetPasswordFirebase(env, uid, newPassword) {
  return identityToolkitCall(env, 'accounts:update', { localId: uid, password: newPassword }, true);
}

function deleteFirebaseUser(env, uid) {
  return identityToolkitCall(env, 'accounts:delete', { localId: uid }, true);
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

// ---- admin_users (block flag + last-seen, keyed by Firebase UID) ----

async function isBlocked(env, uid) {
  const row = await env.DB.prepare('SELECT blocked FROM admin_users WHERE uid = ?').bind(uid).first();
  return !!(row && row.blocked);
}

// Cheap, direct D1 upsert on every successful /api/state call — no
// caching layer, since a stray extra write per request is far simpler
// (and cheap enough on D1) than getting a cache invalidation story
// right for something used only to show a "last seen" timestamp.
async function touchLastSeen(env, uid) {
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      'INSERT INTO admin_users (uid, blocked, last_seen) VALUES (?, 0, ?) ' +
      'ON CONFLICT(uid) DO UPDATE SET last_seen = excluded.last_seen'
    ).bind(uid, now).run();
  } catch (e) { console.error('touchLastSeen failed:', e); }
}

async function setBlocked(env, uid, blocked) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO admin_users (uid, blocked, last_seen) VALUES (?, ?, NULL) ' +
    'ON CONFLICT(uid) DO UPDATE SET blocked = excluded.blocked'
  ).bind(uid, blocked ? 1 : 0).run();
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

// ---- admin panel (single hardcoded ADMIN_UID, see requireAdmin()) ----

async function logAdminAction(env, adminUid, targetUid, action, extra) {
  // Audit log is append-only and best-effort: a logging failure must
  // never undo or mask an action that already succeeded (or block one
  // about to happen), so it's logged to the console rather than turned
  // into an error response. For destructive actions (delete-user) the
  // caller logs BEFORE performing the action, so there's a record even
  // if the delete itself partially fails.
  try {
    await env.DB.prepare(
      'INSERT INTO admin_audit_log (admin_uid, target_uid, action, version_after, data_after, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(
      adminUid, targetUid, action,
      extra && extra.version != null ? extra.version : 0,
      extra && extra.data !== undefined ? JSON.stringify(extra.data) : '{}',
      new Date().toISOString()
    ).run();
  } catch (e) { console.error('admin_audit_log insert failed:', e); }
}

async function handleAdminUsers(env, origin) {
  const [{ results: stateRows }, { results: adminRows }] = await Promise.all([
    env.DB.prepare('SELECT id, data, version, updated_at FROM workspace_state ORDER BY updated_at DESC').all(),
    env.DB.prepare('SELECT uid, blocked, last_seen FROM admin_users').all()
  ]);
  const meta = new Map(adminRows.map(r => [r.uid, r]));
  const now = Date.now();
  const users = stateRows.map((row) => {
    let tradeCount = 0, strategyCount = 0;
    try {
      const data = JSON.parse(row.data);
      tradeCount = Array.isArray(data.trades) ? data.trades.length : 0;
      strategyCount = Array.isArray(data.strategies) ? data.strategies.length : 0;
    } catch (e) { /* malformed row — report zero counts rather than failing the whole list */ }
    const m = meta.get(row.id);
    const lastSeen = m && m.last_seen ? m.last_seen : null;
    return {
      uid: row.id,
      tradeCount, strategyCount,
      version: row.version, updatedAt: row.updated_at,
      blocked: !!(m && m.blocked),
      lastSeen,
      online: !!(lastSeen && now - Date.parse(lastSeen) < ONLINE_WINDOW_MS)
    };
  });
  // Surface admin_users rows with no workspace_state yet too (e.g. a
  // freshly created or blocked user who never synced) so the list
  // always reflects every account the admin has touched.
  for (const r of adminRows) {
    if (!users.some(u => u.uid === r.uid)) {
      const lastSeen = r.last_seen || null;
      users.push({
        uid: r.uid, tradeCount: 0, strategyCount: 0, version: 0, updatedAt: null,
        blocked: !!r.blocked, lastSeen,
        online: !!(lastSeen && now - Date.parse(lastSeen) < ONLINE_WINDOW_MS)
      });
    }
  }
  return json({ users }, 200, origin);
}

async function handleAdminStats(env, origin) {
  const { results } = await env.DB.prepare('SELECT data FROM workspace_state').all();
  let tradeCount = 0, strategyCount = 0;
  for (const row of results) {
    try {
      const data = JSON.parse(row.data);
      tradeCount += Array.isArray(data.trades) ? data.trades.length : 0;
      strategyCount += Array.isArray(data.strategies) ? data.strategies.length : 0;
    } catch (e) { /* skip malformed row */ }
  }
  return json({ userCount: results.length, tradeCount, strategyCount }, 200, origin);
}

async function handleAdminPutState(request, env, origin, adminUid, targetUid) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'invalid JSON body' }, 400, origin); }
  if (!body || typeof body !== 'object' || !body.data) return json({ error: '"data" is required' }, 400, origin);
  const result = await saveState(env, targetUid, body.data, body.expectedVersion);
  if (result.conflict) return json({ error: 'version conflict', version: result.version }, 409, origin);
  await logAdminAction(env, adminUid, targetUid, 'edit', { version: result.version, data: body.data });
  return json({ version: result.version }, 200, origin);
}

async function handleAdminCreateUser(request, env, origin, adminUid) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'invalid JSON body' }, 400, origin); }
  const email = String((body && body.email) || '').trim();
  const password = String((body && body.password) || '');
  if (!email || !password) return json({ error: 'email and password are required' }, 400, origin);
  try {
    const result = await createFirebaseUser(env, email, password);
    await logAdminAction(env, adminUid, result.localId, 'create-user', { data: { email } });
    return json({ uid: result.localId, email: result.email }, 200, origin);
  } catch (e) { return json({ error: e.message }, 500, origin); }
}

async function handleAdminBlock(env, origin, adminUid, targetUid, blocked) {
  await setBlocked(env, targetUid, blocked);
  await logAdminAction(env, adminUid, targetUid, blocked ? 'block' : 'unblock', {});
  return json({ uid: targetUid, blocked }, 200, origin);
}

async function handleAdminRevokeSessions(env, origin, adminUid, targetUid) {
  // Log first — this is the "log prominently before performing the
  // delete/action in case it partially fails" rule from the task: if
  // the Identity Toolkit call below throws, the audit trail still
  // shows the attempt.
  await logAdminAction(env, adminUid, targetUid, 'revoke-sessions-attempt', {});
  try {
    await revokeSessions(env, targetUid);
    await logAdminAction(env, adminUid, targetUid, 'revoke-sessions', {});
    return json({ uid: targetUid, revoked: true }, 200, origin);
  } catch (e) { return json({ error: e.message }, 500, origin); }
}

async function handleAdminResetPassword(request, env, origin, adminUid, targetUid) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'invalid JSON body' }, 400, origin); }
  const newPassword = String((body && body.newPassword) || '');
  if (!newPassword || newPassword.length < 6) return json({ error: 'newPassword (min 6 chars) is required' }, 400, origin);
  await logAdminAction(env, adminUid, targetUid, 'reset-password-attempt', {});
  try {
    await resetPasswordFirebase(env, targetUid, newPassword);
    await logAdminAction(env, adminUid, targetUid, 'reset-password', {});
    return json({ uid: targetUid, reset: true }, 200, origin);
  } catch (e) { return json({ error: e.message }, 500, origin); }
}

async function handleAdminDeleteUser(env, origin, adminUid, targetUid) {
  // Prominent, before-the-fact audit entry: if any of the deletes below
  // fail partway through, this row is the record that an admin-driven
  // deletion of this UID was in flight.
  await logAdminAction(env, adminUid, targetUid, 'delete-user-attempt', {});
  try {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM workspace_state WHERE id = ?').bind(targetUid),
      env.DB.prepare('DELETE FROM admin_users WHERE uid = ?').bind(targetUid)
    ]);
    let authDeleted = false, authError = null;
    try { await deleteFirebaseUser(env, targetUid); authDeleted = true; }
    catch (e) { authError = e.message; } // D1 rows are gone either way; report the auth-side failure rather than hiding it
    await logAdminAction(env, adminUid, targetUid, 'delete-user', { data: { authDeleted, authError } });
    return json({ uid: targetUid, deleted: true, authDeleted, authError }, 200, origin);
  } catch (e) { return json({ error: e.message }, 500, origin); }
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

      if (await isBlocked(env, uid)) return json({ error: 'account blocked' }, 403, origin);

      if (request.method === 'GET') {
        const state = await getState(env, uid);
        await touchLastSeen(env, uid);
        return json(state, 200, origin);
      }
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'invalid JSON body' }, 400, origin); }
      if (!body || typeof body !== 'object' || !body.data) return json({ error: '"data" is required' }, 400, origin);
      const result = await saveState(env, uid, body.data, body.expectedVersion);
      if (result.conflict) return json({ error: 'version conflict', version: result.version }, 409, origin);
      await touchLastSeen(env, uid);
      return json({ version: result.version }, 200, origin);
    }

    if (url.pathname === '/webhook/close' && request.method === 'POST') {
      if (!webhookAuthOk(request, env, url)) return json({ error: 'unauthorized' }, 401, origin);
      const uid = url.searchParams.get('uid');
      if (!uid) return json({ error: '?uid= query param is required' }, 400, origin);
      return handleWebhookClose(request, env, origin, uid);
    }

    // ---- /admin/* — every branch below gates on requireAdmin() first and
    // returns a plain 403 on any failure (never 401), so a non-admin
    // caller can't distinguish "not logged in" from "logged in but not
    // the admin account". ----

    if (url.pathname === '/admin/users' && request.method === 'GET') {
      try { await requireAdmin(request, env); }
      catch (e) { return json({ error: 'forbidden' }, 403, origin); }
      return handleAdminUsers(env, origin);
    }

    if (url.pathname === '/admin/users' && request.method === 'POST') {
      let adminUid;
      try { ({ uid: adminUid } = await requireAdmin(request, env)); }
      catch (e) { return json({ error: 'forbidden' }, 403, origin); }
      return handleAdminCreateUser(request, env, origin, adminUid);
    }

    if (url.pathname === '/admin/stats' && request.method === 'GET') {
      try { await requireAdmin(request, env); }
      catch (e) { return json({ error: 'forbidden' }, 403, origin); }
      return handleAdminStats(env, origin);
    }

    if (url.pathname === '/admin/state' && (request.method === 'GET' || request.method === 'PUT')) {
      let adminUid;
      try { ({ uid: adminUid } = await requireAdmin(request, env)); }
      catch (e) { return json({ error: 'forbidden' }, 403, origin); }
      const targetUid = url.searchParams.get('uid');
      if (!targetUid) return json({ error: '?uid= query param is required' }, 400, origin);
      if (request.method === 'GET') return json(await getState(env, targetUid), 200, origin);
      return handleAdminPutState(request, env, origin, adminUid, targetUid);
    }

    // /admin/users/:uid/<action> and DELETE /admin/users/:uid
    const userActionMatch = url.pathname.match(/^\/admin\/users\/([^/]+)(?:\/([a-z-]+))?$/);
    if (userActionMatch) {
      let adminUid;
      try { ({ uid: adminUid } = await requireAdmin(request, env)); }
      catch (e) { return json({ error: 'forbidden' }, 403, origin); }
      const targetUid = decodeURIComponent(userActionMatch[1]);
      const action = userActionMatch[2] || null;

      if (!action && request.method === 'DELETE') return handleAdminDeleteUser(env, origin, adminUid, targetUid);
      if (action === 'block' && request.method === 'POST') return handleAdminBlock(env, origin, adminUid, targetUid, true);
      if (action === 'unblock' && request.method === 'POST') return handleAdminBlock(env, origin, adminUid, targetUid, false);
      if (action === 'revoke-sessions' && request.method === 'POST') return handleAdminRevokeSessions(env, origin, adminUid, targetUid);
      if (action === 'reset-password' && request.method === 'POST') return handleAdminResetPassword(request, env, origin, adminUid, targetUid);
      return json({ error: 'not found' }, 404, origin);
    }

    return json({ error: 'not found' }, 404, origin);
  }
};
