# Ground Delta Worker

Backend for Ground Delta: a Cloudflare Worker + D1 database that stores
each user's trades/strategies (isolated by Firebase UID) and closes
trades automatically from TradingView webhook alerts. Separate
Cloudflare project from WAVESCOUT — nothing here touches that worker.

## 1. Firebase Authentication (Firebase Console — manual, one-time)

The `ground-delta-journal` Firebase project already exists (it's what
Hosting runs on). You need to turn on Authentication in it:

1. https://console.firebase.google.com/project/ground-delta-journal/authentication → **Get started**
2. **Sign-in method** tab → enable **Email/Password**
3. Same tab → enable **Google** — pick a support email when prompted (Firebase provisions the OAuth client for you, no separate Google Cloud OAuth setup needed for the basic flow)
4. **Project settings** (gear icon) → **General** → scroll to **Your apps** → if there's no Web app yet, click **Add app → Web**, give it any nickname, skip hosting setup (already done)
5. From that Web app's config snippet, copy the `apiKey` value — that's not a secret, it's the public per-project key the JS SDK needs. You'll paste it into the frontend settings (see step 4 below).
6. **Authentication → Settings → Authorized domains**: confirm `ground-delta-journal.web.app` (and `ground-delta-journal.firebaseapp.com`) are listed — they should be by default for a project's own Hosting domains.

## 2. Backend setup (run locally, requires your own Cloudflare account)

```bash
cd worker
npm install
npx wrangler login                                  # opens a browser, like `firebase login`
npx wrangler d1 create ground-delta-db               # prints a database_id
```

Paste the printed `database_id` into `wrangler.toml` (`REPLACE_WITH_D1_DATABASE_ID`), then:

```bash
npm run db:migrate:remote                            # applies migrations/ (creates all tables)
npx wrangler secret put API_KEY                      # pick any long random string — for the TradingView webhook only
npm run deploy
```

`wrangler deploy` prints your Worker's URL, e.g.
`https://ground-delta-worker.<your-subdomain>.workers.dev`. `/api/state`
(what the logged-in frontend talks to) needs no secret from you — it
verifies each request's Firebase ID token itself against Google's
public keys. Only the TradingView webhook route uses `API_KEY`.

## 3. Auto-deploy on push

`.github/workflows/deploy-worker.yml` redeploys the Worker whenever
`worker/**` changes on `main`. It needs two repo secrets (GitHub →
Settings → Secrets and variables → Actions):
- `CLOUDFLARE_API_TOKEN` — a Cloudflare API token with "Edit Cloudflare Workers" permission
- `CLOUDFLARE_ACCOUNT_ID` — found on the right-hand sidebar of any page in the Cloudflare dashboard

## 4. Frontend connection

In Ground Delta's artifact settings, set:
- `apiBase` → your Worker URL (no trailing slash), e.g. `https://ground-delta-worker.you.workers.dev`
- `firebaseApiKey` → the Web API key from step 1.5 above
- `firebaseAuthDomain` → defaults to `ground-delta-journal.firebaseapp.com`, only change this if you used a different Firebase project
- `firebaseProjectId` → defaults to `ground-delta-journal`

Once `firebaseApiKey` is set, the app shows a login screen (email/password
or Google) before anything else. Leaving it empty keeps the app exactly
as before (no login, localStorage only) — this is opt-in, nothing
breaks if you don't set it up yet.

**Upgrading from Phase 3 (no-login) data:** if you already used Ground
Delta with just `apiBase` configured (no login), your trades are sitting
in D1 under a fixed row rather than tied to any account. The first time
you log in for real, the backend automatically adopts that old data
into your new account — you won't lose anything, no manual migration
step needed.

## 5. TradingView alert setup

TradingView can't log in, so the webhook keeps the shared-secret
`API_KEY` from step 2, plus your Firebase UID (find it in the Firebase
Console → Authentication → Users table, or in Ground Delta's browser
console via `firebase.auth().currentUser.uid` while logged in) so it
knows whose trades to search:

Webhook URL: `https://<your-worker>.workers.dev/webhook/close?key=<your API_KEY>&uid=<your Firebase UID>`

Alert message body (JSON):
```json
{ "symbol": "{{ticker}}", "price": {{close}}, "time": "{{timenow}}" }
```

The worker looks for an **open** Ground Delta trade on that symbol whose
TP or SL the alert price has reached, and closes it at that exact level
(TP checked first). If nothing matches, it responds 200 with an empty
`closed` list — no error, since most alerts won't correspond to an open
trade.

## 6. NOVA (personal assistant) access

NOVA can **read** one user's trades, **add** a trade and **close** an open one — nothing else
(no delete, no general edit). Routes, validation and limits are documented at the top of `src/nova.js`.

| Route | Token | Purpose |
| --- | --- | --- |
| `GET /nova/trades?uid=…[&status=&from=&to=&limit=]` | read (`NOVA_ACCESS_TOKEN`) | list trades, minimal shape, notes always `""` |
| `POST /nova/trades?uid=…` | write (`NOVA_WRITE_TOKEN`) | add a trade (open, or closed if `exit` is given) |
| `POST /nova/trades/:id/close?uid=…` | write (`NOVA_WRITE_TOKEN`) | close an **open** trade |

- Two separate secrets (each ≥ 32 chars, different from each other and from `API_KEY`), sent as
  `X-Api-Key` header (or `Authorization: Bearer`), never as `?key=`, compared in constant time.
  Unknown token → 401. The read token on a write route, or the write token on `GET` → 403.
  Fails closed: an unset write token disables writes.
- `NOVA_ALLOWED_UID`: the only Firebase UID NOVA may read or write (`?uid=` must match, else 403).
- Writes need an `Idempotency-Key` header (8–128 chars `A-Za-z0-9._:-`). The first successful
  result is kept for 24 h: the same key + same request returns it again (`Idempotent-Replay: true`)
  instead of creating another trade; same key + different request → 422; first request still
  running → 409. Rejected requests do not occupy a key.
- Strict validation (400 with reasons): required `date`, `symbol`, `dir`, `entry`; JSON number types
  (no numeric strings); prices > 0; `leverage` 1–1000; `HH:MM` times; `session` ≤ 40, `strategy` ≤ 60,
  `notes` ≤ 2000 chars; body ≤ 8 KB. Unknown fields are dropped. Closing an already closed trade → 409,
  unknown id → 404.
- Every write attempt (ok / replay / rejected) is stored in `nova_audit_log` with timestamp, source
  `nova`, action, UID, trade id and key — never with journal text. Trades written by NOVA carry
  `source: "nova"`.
- Rate limit per client IP, counted before authentication (best effort per Worker isolate):
  reads 60/min, writes 10/min → 429 + `Retry-After`.

Setup (order matters — the migration first):

```bash
cd worker
npm run db:migrate:remote                       # creates nova_idempotency + nova_audit_log (already part of 0001_init.sql)
npx wrangler secret put NOVA_ACCESS_TOKEN       # read token,  e.g. openssl rand -hex 32
npx wrangler secret put NOVA_WRITE_TOKEN        # write token, a different openssl rand -hex 32
npx wrangler secret put NOVA_ALLOWED_UID        # your Firebase UID
npm run deploy

BASE=https://ground-delta-worker.<subdomain>.workers.dev
curl -H "X-Api-Key: {{NOVA_ACCESS_TOKEN}}" "$BASE/nova/trades?uid={{NOVA_ALLOWED_UID}}&status=open&limit=5"
curl -X POST -H "X-Api-Key: {{NOVA_WRITE_TOKEN}}" -H "Idempotency-Key: test-0001" -H "Content-Type: application/json" \
  -d '{"date":"2026-10-13","symbol":"NAS100","dir":"Long","entry":20100.5,"sl":20050,"tp":20200}' \
  "$BASE/nova/trades?uid={{NOVA_ALLOWED_UID}}"
```

Tests: `npm test` (Node's built-in test runner, no dependencies; the D1 SQL test needs Node ≥ 22.5 and is skipped otherwise).
