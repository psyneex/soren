# Current Capabilities — Monitoring Phase

## Manual input contract

The user provides only:

- Token address (mint / contract)
- Up to three Smart Money wallet addresses (Nansen is a manual research source; no Nansen API)

No manual numeric market data exists anywhere in the system. Price, market cap,
FDV, liquidity, volume, age, holders, flows, balances and activity are all
retrieved or calculated automatically.

## Providers (provider-agnostic, chain-agnostic)

- DexScreener — primary free market data (price, liquidity, volume, price change,
  pair age, taker counts) on every chain, cached per cycle.
- Alchemy — primary on-chain provider for all chains (EVM RPC + Prices API + Solana RPC).
  Provides wallet balances, activity, and bounded 30-day wallet flow via standard RPC.
- CoinGecko — free market-regime reference data (BTC, chain-native benchmark, broad
  market cap), cached for 10 minutes (≈2 requests per 60-minute cycle).

## Monitoring pipeline (worker)

Every `WATCHLIST_OBSERVATION_INTERVAL_MINUTES` (default 60) the worker walks the
ACTIVE watchlist sequentially and for each token:

1. loads prior snapshot history (never the current observation),
2. collects a fresh observation (enrichment + DexScreener + regime),
3. computes the five Golden Formula feature groups (each normalized 0–100),
4. scores with Golden Formula V0 (0.30/0.20/0.20/0.15/0.15),
5. evaluates the independent risk gates (liquidity, concentration, validity, crash),
6. advances the watch state deterministically (barriers → horizon → gates → score),
7. persists an immutable market snapshot with full provenance,
8. persists + notifies Telegram on real state transitions only,
9. maintains pending triple-barrier episode outcomes (target +15%, stop −8%, 48h).

## Persisted data

- `watchlist_tokens` — added once, monitored continuously, pausable.
- `market_snapshots` — immutable (DB trigger rejects updates), versioned,
  provenance-complete.
- `signal_events` — state transitions only.
- `episode_outcomes` — research labels evaluated against subsequent snapshots only
  (no look-ahead; observations strictly after the entry within the horizon).

## Integrity

Missing data is never fabricated or converted into zero. Evaluations with missing
inputs return `INCOMPLETE` instead of a score. Provider failures degrade explicitly
with notes. The Golden Score is an interpretable proxy for
`P(target before stop within horizon)` — not a calibrated probability.