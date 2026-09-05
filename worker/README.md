# Ground Delta Worker

Backend for Ground Delta: a Cloudflare Worker + D1 database that stores
trades/strategies and closes trades automatically from TradingView
webhook alerts. Separate Cloudflare project from WAVESCOUT — nothing
here touches that worker.

## One-time setup (run locally, requires your own Cloudflare account)

```bash
cd worker
npm install
npx wrangler login                                  # opens a browser, like `firebase login`
npx wrangler d1 create ground-delta-db               # prints a database_id
```

Paste the printed `database_id` into `wrangler.toml` (`REPLACE_WITH_D1_DATABASE_ID`), then:

```bash
npm run db:migrate:remote                            # creates the workspace_state table
npx wrangler secret put API_KEY                      # pick any long random string
npm run deploy
```

`wrangler deploy` prints your Worker's URL, e.g.
`https://ground-delta-worker.<your-subdomain>.workers.dev`. You'll need that
plus the `API_KEY` value to configure the frontend (see below) and the
TradingView alert.

## Auto-deploy on push

`.github/workflows/deploy-worker.yml` redeploys the Worker whenever
`worker/**` changes on `main`. It needs two repo secrets (GitHub →
Settings → Secrets and variables → Actions):
- `CLOUDFLARE_API_TOKEN` — a Cloudflare API token with "Edit Cloudflare Workers" permission
- `CLOUDFLARE_ACCOUNT_ID` — found on the right-hand sidebar of any page in the Cloudflare dashboard

## TradingView alert setup

Webhook URL: `https://<your-worker>.workers.dev/webhook/close?key=<your API_KEY>`

Alert message body (JSON):
```json
{ "symbol": "{{ticker}}", "price": {{close}}, "time": "{{timenow}}" }
```

The worker looks for an **open** Ground Delta trade on that symbol whose
TP or SL the alert price has reached, and closes it at that exact level
(TP checked first). If nothing matches, it responds 200 with an empty
`closed` list — no error, since most alerts won't correspond to an open
trade.

## Frontend connection

In Ground Delta's artifact settings, set:
- `apiBase` → your Worker URL (no trailing slash), e.g. `https://ground-delta-worker.you.workers.dev`
- `apiKey` → the same value you set as `API_KEY`

Leaving `apiBase` empty keeps the app exactly as before (localStorage
only) — this is opt-in.
