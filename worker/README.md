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
npm run db:migrate:remote                            # creates the workspace_state table
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
