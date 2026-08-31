# Soren — Agent Instructions

## Project Goal

Soren is a research and signal-generation system for crypto-token timing.

The objective is not to rank tokens by general quality. The objective is to detect **favorable entry and exit conditions early enough to create measurable predictive edge**.

The system must remain research-only. No private keys, automated trading, or trade execution.

## Core Architecture

The system consists of:

1. **Manual Research Input**
2. **Market Data Providers**
3. **On-chain Data Providers**
4. **Snapshot Store**
5. **Feature Engine**
6. **Golden Formula**
7. **Risk Gates**
8. **Signal Engine**
9. **Outcome / Backtesting Engine**
10. **Telegram Alerting**

The architecture must remain provider-agnostic and chain-agnostic.

Solana is the primary/default chain, but the domain model must support additional chains.

## Manual Input Contract

The user manually provides only:

* `tokenAddress`
* `smartMoneyWallet1`
* `smartMoneyWallet2`
* `smartMoneyWallet3`

No manual numeric market data is required.

Do not require the user to manually enter:

* price
* market cap
* FDV
* liquidity
* volume
* token age
* holders
* flows
* balances
* wallet activity
* safety score
* Smart Money flow
* Smart Money balance
* Smart Money activity

All available values must be obtained or calculated automatically.

The UI must accept human-readable numeric values from providers such as `5B`, `320M`, `$5.2M`, etc. Internal calculations must use normalized numeric values.

## Provider Strategy

### Nansen

Nansen is a **manual research source**, not a runtime API dependency.

The user uses Nansen to identify three Smart Money wallets and enters their addresses.

Do not require Nansen API access.

### Market Data

Use free/public market-data providers.

Primary Solana market-data source:

* DexScreener

The system should retrieve, when available:

* price
* price change
* liquidity
* market cap
* FDV
* volume
* transaction activity

### On-chain Data

Use free RPC/indexing providers where useful.

Alchemy is the primary on-chain provider for all chains (EVM + Solana).

## Snapshot Model

A token is added to a watchlist once.

The system periodically creates market snapshots.

Each snapshot must preserve:

* token
* chain
* timestamp
* provider/source
* raw observations
* normalized features
* formula version
* score
* gate results
* signal
* later outcome

Historical snapshots must never be overwritten.

The system must support comparing the current snapshot with previous snapshots.

## Feature Engine

The first implementation must calculate these five feature groups:

### 1. Smart Money Accumulation — 30%

Measure whether the three supplied Smart Money wallets are accumulating or distributing the token.

Consider:

* net token position change
* buying vs selling activity
* wallet-level contribution
* consistency across wallets

### 2. Accumulation Acceleration — 20%

Measure whether Smart Money accumulation is increasing or decreasing over time.

Use multiple observation windows where available.

The important signal is **change in accumulation rate**, not only absolute accumulated value.

### 3. Relative Strength — 20%

Measure token performance relative to its relevant market benchmark.

For Solana, use SOL and broader crypto-market references where available.

Prefer relative performance over absolute token return.

### 4. Volume Confirmation — 15%

Measure whether price movement is supported by meaningful trading activity.

Consider:

* relative volume
* volume change
* price/volume confirmation
* abnormal volume

### 5. Market Regime — 15%

Estimate whether the broader market environment is favorable.

The initial regime model should consider:

* BTC trend
* SOL trend
* broad market direction
* market volatility

Do not over-engineer the first version.

## Golden Formula V0

The initial hypothesis is:

`GoldenScore =
0.30 * SmartMoneyAccumulation +
0.20 * AccumulationAcceleration +
0.20 * RelativeStrength +
0.15 * VolumeConfirmation +
0.15 * MarketRegime`

Every component must be normalized to `0–100`.

Initial interpretation:

* `80–100`: BUY CANDIDATE
* `65–79`: WATCH
* `<65`: IGNORE

These thresholds are experimental parameters, not established facts.

Store formula version and parameters with every score.

Do not silently change weights or thresholds.

## Risk Gates

Risk is separate from the opportunity score.

A dangerous condition must be able to reject a BUY candidate regardless of its score.

Initial gates may include:

* insufficient liquidity
* extreme concentration when reliably measurable
* unavailable critical data
* abnormal market conditions
* invalid token/provider data

Never fabricate missing values.

Never convert unavailable data into zero.

When required data is unavailable, return `INCOMPLETE` rather than inventing a score.

## Signal Model

Signals are state transitions, not simply repeated scores.

The system should detect:

* WATCH
* BUY CANDIDATE
* ACTIVE WATCH
* TAKE PROFIT
* EXIT
* STOP LOSS
* HOLD
* INVALIDATED

A token that previously generated a BUY signal must be continuously evaluated.

The system must therefore be capable of generating an EXIT signal for a previously recommended token when its conditions deteriorate.

## Entry / Exit Research Model

Initial research labels use a Triple-Barrier-style evaluation.

Initial experimental parameters:

* target: `+15%`
* stop: `-8%`
* horizon: `48h`

The first barrier reached determines the outcome.

These parameters must be configurable and versioned.

Do not claim that the initial parameters are optimal.

## Prediction Objective

The primary evaluation target is:

`P(Target reached before Stop within Horizon)`

The Golden Score is an interpretable proxy for this probability.

Do not represent the score as an actual probability until calibration has been performed.

## Backtesting

Every generated signal must eventually be evaluated against subsequent market data.

Track at minimum:

* target hit
* stop hit
* timeout
* time to outcome
* maximum favorable excursion
* maximum adverse excursion
* return after signal
* market regime at signal time

Evaluate the system using out-of-sample data.

Avoid look-ahead bias.

Never use future information when constructing a historical snapshot.

## Data Integrity

Every calculated feature must retain provenance.

Never:

* invent missing data
* silently substitute incomparable metrics
* mix timestamps without recording them
* use future observations
* treat current data as historical truth

Provider failures must degrade explicitly.

## Cost Control

The system must prioritize free/public providers.

No polling loop should consume paid API credits unnecessarily.

Use:

* caching
* deduplication
* bounded requests
* configurable observation intervals

The system must be usable with approximately `$0` operating cost.

## Telegram

Telegram is the primary user notification interface for the current phase.

Notifications should be emitted only for meaningful state changes or configured alerts.

Persist notification delivery state and suppress duplicate events.

## Engineering Principles

* TypeScript
* modular provider adapters
* deterministic feature calculations
* deterministic scoring
* versioned formulas
* explicit provenance
* testable pure functions
* no hidden business logic in UI
* no hard-coded provider assumptions in domain logic

Before changing the scoring methodology, document the hypothesis and test it against stored historical data.

The objective is not to build the most complicated system.

The objective is to discover whether a small number of measurable features can produce statistically meaningful predictive edge.
