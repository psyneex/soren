# Soren

Research-only token monitoring and predictive-signal system for crypto-token timing.

The system detects **favorable entry and exit conditions** from a small set of measurable
features. It never trades, never holds keys, and does not invent missing data.

## Manual input

The user enters only:

- Token address (mint / contract)
- Up to three Smart Money wallet addresses

Everything else — price, market cap, FDV, liquidity, volume, holders, flows, balances,
activity — is retrieved or calculated automatically from free/public providers
(Alchemy RPC, DexScreener, CoinGecko). Nansen is **not** a runtime dependency.

## Commands

```sh
npm install
npm run typecheck
npm test
npm run build        # emits dist/ (library build; the Worker is bundled by Wrangler)
npm run dev          # `wrangler dev` — local Worker with cron + HTTP
npm run deploy       # `wrangler deploy` — publish to Cloudflare
```

## Cloudflare deployment

Soren runs as a stateless **Cloudflare Worker** with a `scheduled` cron handler
(one monitoring cycle per tick) and a `fetch` HTTP handler (health, status, and
the watchlist API). A single Worker replaces the old Fastify API and the
`setInterval` worker.

### Prerequisites

- Node.js 20+
- A Cloudflare account with Workers enabled
- A Supabase project with the migrations in `supabase/migrations/` applied
- An Alchemy API key (multi-chain: EVM + Solana)

### Authentication

```sh
npx wrangler login
```

### Secret configuration

Secrets are **never** committed. Production secrets are set via Wrangler; local
development uses `.dev.vars` (git-ignored).

**Production** (set each secret — Wrangler encrypts and stores them):

```sh
echo "https://your-project.supabase.co"     | wrangler secret put SUPABASE_URL
echo "your-service-role-key"                | wrangler secret put SUPABASE_SERVICE_ROLE_KEY
echo "your-alchemy-key"                     | wrangler secret put ALCHEMY_API_KEY
# Optional:
echo "your-bot-token"                       | wrangler secret put TELEGRAM_BOT_TOKEN
echo "your-chat-id"                         | wrangler secret put TELEGRAM_CHAT_ID

```

**Local development** — copy `.dev.vars.example` to `.dev.vars` and fill in real
values. `wrangler dev` reads `.dev.vars` automatically. `.dev.vars` is
git-ignored and must never be committed; production uses `wrangler secret`, not
this file.

### Cron configuration

The schedule is configured in `wrangler.jsonc` under `triggers.crons` (not in
application logic). Default: every hour (`0 * * * *`). Edit the array and
redeploy to change it. Cloudflare supports standard 5-field cron expressions.

### Local development

```sh
npm run dev        # starts the Worker locally on http://8787 with cron + HTTP
```

Test the HTTP endpoints:

```sh
curl http://localhost:8787/health
curl http://localhost:8787/status
```

Trigger a manual monitoring cycle (dev/inspection only):

```sh
curl http://localhost:8787/run
```

The smoke and e2e scripts read from the environment (use `tsx --env-file .env`):

```sh
npx tsx --env-file .env src/monitor/smoke.ts
```

### Deployment

```sh
npm run deploy
```

After deploy, the Worker URL and cron are visible in the Cloudflare dashboard
under Workers & Pages → soren → Triggers / Settings.

### GitHub automatic deployment

Cloudflare Workers Builds can deploy automatically from a connected production
branch — no GitHub Actions required. In the Cloudflare dashboard, link the
GitHub repository under Workers & Pages → soren → Settings → Builds & deployments
and choose the production branch. Wrangler reads `wrangler.jsonc` from the repo
root, so each push to that branch triggers a build and deploy. Production secrets
are pulled from Cloudflare's secret store (set via `wrangler secret put`), not
from the repository.

### Required production secrets

| Secret | Required | Purpose |
|---|---|---|
| `SUPABASE_URL` | yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Supabase service-role key |
| `ALCHEMY_API_KEY` | yes | Multi-chain enrichment (EVM + Solana) |
| `TELEGRAM_BOT_TOKEN` | no | Enables Telegram signal alerts |
| `TELEGRAM_CHAT_ID` | no | Telegram chat/channel for alerts |

## Architecture

- **Watchlist** — tokens are added once and monitored continuously.
- **Snapshot store** — immutable, versioned market snapshots with full provenance
  (raw observations, features, formula version, gate results, signal, score, source).
- **Feature engine** — five deterministic feature groups, each normalized 0–100
  (Smart Money Accumulation 30%, Accumulation Acceleration 20%, Relative Strength 20%,
  Volume Confirmation 15%, Market Regime 15%).
- **Golden Formula V0** — the fixed weighted score from `AGENTS.md`. Experimental
  thresholds: 80–100 BUY CANDIDATE, 65–79 WATCH, <65 IGNORE. The score is an
  interpretable proxy for `P(target before stop within horizon)` — **not** a probability.
- **Risk gates** — independent of the score; a failing gate emits INVALIDATED.
- **Signal engine** — state transitions (BUY CANDIDATE / ACTIVE WATCH / TAKE PROFIT /
  STOP LOSS / EXIT / HOLD / INVALIDATED ...); deterioration of a previously-BUY token
  produces EXIT. Only real state changes emit Telegram events and are stored.
- **Triple-barrier outcomes** — experimental labels with target +15%, stop −8%, horizon
  48h; the first barrier reached inside the horizon decides. Versioned parameters.
- **Worker** — performs all scheduled monitoring (bounded, cached, free-tier friendly).

## Chains

Solana is the default chain. The domain model and provider adapters remain
chain-agnostic; set `DEFAULT_CHAIN` and provide the appropriate provider key
(`ALCHEMY_API_KEY` for EVM chains) to add other chains to the watchlist.

No trading execution is included.
