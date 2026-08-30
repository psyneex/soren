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
(DexScreener, Helius/Alchemy RPC, CoinGecko). Nansen is **not** a runtime dependency.

## Commands

```sh
npm install
npm run typecheck
npm test
npm run build
npm run dev:api     # API on http://127.0.0.1:3000
npm run dev:worker  # scheduled monitoring worker
```

The API and worker require the variables in `.env.example`:

- `ALCHEMY_API_KEY` (multi-chain) **or** `HELIUS_API_KEY` (Solana-only mode)
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
- `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (optional; enables signal alerts)

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
