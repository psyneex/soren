# Role

You are the primary software architect and implementation agent for a **low-cost deterministic crypto opportunity detection system**.

Build the system for a user with a total available capital of **$1**.

The system's purpose is to determine whether Nansen on-chain data can be converted into a useful, measurable, and eventually profitable crypto trading signal.

The first implementation must prioritize **zero/near-zero operating cost, Nansen API credit efficiency, deterministic scoring, historical validation, and reproducibility**.

---

# 1. Project Goal

Build a quantitative crypto-intelligence platform using:

* **Nansen API**
* **Nansen Free API access during initial development**
* **Supabase PostgreSQL**
* **TypeScript / Node.js**
* **Fastify**
* **Telegram Bot API in Phase 2**

The system should:

1. Discover potentially valuable wallets/tokens using data available through the Nansen Free API.
2. Evaluate wallet historical performance.
3. Detect accumulation and distribution behavior.
4. Calculate token and market risk.
5. Generate deterministic scores.
6. Produce a final **Opportunity Score from 0–100**.
7. Generate BUY and SELL/EXIT signals.
8. Track every signal historically.
9. Measure what happened after each signal.
10. Provide Telegram alerts in Phase 2.
11. Establish whether the scoring methodology has predictive value before real capital is deployed.

The core hypothesis is:

> **Can publicly available/on-chain Nansen data, analyzed deterministically, identify statistically meaningful crypto opportunities even with extremely limited capital?**

Do not assume the hypothesis is true. The system must test it.

---

# 2. Capital Constraint

The available capital is **$1**.

This constraint must influence the architecture.

The system is not intended to maximize the number of trades.

Priorities are:

1. Preserve capital.
2. Minimize transaction and execution costs.
3. Avoid unnecessary Nansen API consumption.
4. Identify high-quality opportunities.
5. Build statistical evidence before risking capital.
6. Eventually determine whether the strategy can scale from very small capital.

The $1 should initially be treated primarily as **experimental capital**, not as a reason to execute frequent trades.

Do not design assumptions around large portfolio sizes.

---

# 3. Nansen Free Tier Constraint

During development, assume that only the **Nansen Free API access** is available.

Do not build the architecture around paid-only Nansen functionality.

In particular:

> **Do not require Token God Mode or premium Smart Money/label functionality if it is unavailable under the Free API access.**

Use only endpoints and fields that are actually available to the account/API tier being used.

Before implementing an endpoint, verify its current availability and requirements against the current Nansen API documentation.

The system must have a clear capability boundary between:

```text
FREE AVAILABLE DATA
```

and:

```text
PAID / PREMIUM DATA
```

The Free-compatible implementation is the baseline product.

If a useful metric requires a paid endpoint, treat it as an optional future enhancement rather than making it a dependency.

---

# 4. Nansen Integration

Create a dedicated Nansen adapter.

No domain service should directly communicate with Nansen.

The adapter must handle:

* API authentication
* endpoint calls
* request validation
* response validation
* normalization
* timeouts
* retries
* exponential backoff
* rate limiting
* credit tracking
* error handling
* request logging
* caching/deduplication where appropriate

Use only the currently available Free-tier endpoints required by the scoring strategy.

Potential data categories include, where available:

* token data
* wallet/profiler information
* token holders
* flows
* DEX activity
* wallet transactions
* historical data

Do not assume that an endpoint listed in Nansen documentation is available to the Free tier.

---

# 5. API Credit Efficiency

API credits are a first-class system constraint.

Create an internal API usage model recording:

* endpoint
* timestamp
* request parameters
* token/wallet
* response status
* credits consumed
* cache hit/miss
* analytical purpose

The system must avoid:

* unnecessary polling
* duplicate requests
* repeated retrieval of unchanged data
* scanning every token continuously
* expensive analysis before inexpensive filtering

Use a staged candidate-selection strategy.

Conceptually:

```text
cheap/broad data
      ↓
candidate filtering
      ↓
more detailed analysis
      ↓
scoring
```

The exact implementation must be based on the endpoints actually available under the Free API access.

---

# 6. Architecture

The system consists of these logical domains:

1. Nansen Integration
2. Data Acquisition
3. Data Normalization
4. Wallet Intelligence
5. Token Intelligence
6. Feature Engine
7. Accumulation / Distribution Engine
8. Risk Engine
9. Opportunity & Exit Scoring Engine
10. Historical Data & Backtesting
11. Signal Management
12. Telegram Alerting
13. Configuration & Versioning
14. Observability

Keep these domains separated.

---

# 7. Technology Stack

Use:

* TypeScript
* Node.js
* Fastify
* Supabase PostgreSQL
* Nansen API
* Telegram Bot API
* Zod
* Pino
* Vitest

Do not introduce additional infrastructure unless there is a demonstrated requirement.

Supabase PostgreSQL is the system of record.

---

# 8. Data Acquisition

Implement scheduled collection appropriate to the Free API credit budget.

The acquisition layer should:

* identify required datasets
* determine collection frequency
* retrieve only necessary information
* avoid duplicate collection
* persist timestamps
* preserve historical observations
* record API usage

Historical state is essential.

A current token value alone cannot determine whether accumulation or distribution is occurring.

---

# 9. Wallet Intelligence

Build a deterministic wallet-quality model using only available Nansen data.

Potential metrics:

* realized P&L
* trade count
* win rate
* average return
* median return
* consistency
* drawdown
* holding period
* early-entry behavior
* historical token-selection performance

Do not rank wallets solely by absolute profit.

Account for:

* sample size
* consistency
* risk
* repeated successful behavior

Produce:

```text
Wallet Quality Score: 0–100
```

The scoring methodology must be configurable and versioned.

---

# 10. Token Intelligence

Maintain canonical token records and historical snapshots.

Where the Free API provides them, track:

* token address
* chain
* symbol
* price
* market cap
* FDV
* liquidity
* volume
* holder count
* holder changes
* transaction activity
* wallet activity
* flow metrics
* relevant DEX metrics

Do not assume all fields are available.

The database model should allow optional fields.

---

# 11. Feature Engine

Convert raw observations into deterministic features.

Potential features include:

* price change
* volume change
* liquidity change
* holder growth
* wallet accumulation
* wallet distribution
* buy/sell ratio
* netflow
* transaction growth
* wallet-quality-weighted activity
* concentration
* volatility
* momentum
* price/flow divergence

Only implement features supported by actual available data.

Every feature must have:

* timestamp
* source
* calculation definition
* version

Features must be reproducible from stored observations.

---

# 12. Accumulation / Distribution Engine

Build two separate deterministic measurements.

### Accumulation

Evaluate evidence such as:

* increasing buying activity
* increasing net inflows
* increasing number of relevant buyers
* repeated purchases
* quality of participating wallets
* holder growth
* liquidity confirmation
* price/flow divergence

Produce:

```text
Accumulation Score: 0–100
```

### Distribution

Evaluate:

* selling activity
* net outflows
* repeated selling
* wallet-quality-weighted selling
* declining holdings
* deteriorating buyer/seller ratio
* holder behavior
* liquidity deterioration

Produce:

```text
Distribution Score: 0–100
```

Selling must not simply be represented as "lack of accumulation."

---

# 13. Risk Engine

Build a deterministic risk model independent of the opportunity score.

Potential risk factors:

* low liquidity
* concentration
* excessive volatility
* abnormal volume
* token age
* wallet concentration
* deteriorating liquidity
* distribution
* market conditions

Output:

```text
Risk Score: 0–100
Risk Level
Hard Reject
Risk Factors
```

Hard-reject conditions must prevent normal BUY signals.

Risk thresholds must be configurable and versioned.

---

# 14. Opportunity Engine

Create a deterministic **Opportunity Score from 0–100**.

The score should combine measurable components such as:

* wallet quality
* accumulation
* market structure
* risk
* other validated predictive features

Initial weighting can be configurable, for example:

```text
Wallet Quality      35%
Accumulation        30%
Market Structure    15%
Risk Adjustment     20%
```

Do not treat these weights as scientifically established.

They are initial parameters to be tested through historical evaluation.

Every score must preserve:

* component scores
* weights
* final score
* configuration version
* source timestamps
* feature version

A score must always be explainable.

---

# 15. BUY Signal

A BUY signal represents a sufficiently strong opportunity according to the current scoring configuration.

Example conceptual requirements:

```text
Opportunity Score >= BUY threshold
AND
Risk < maximum risk
AND
Hard Reject = false
```

The actual thresholds must be configurable.

A BUY signal must contain:

* token
* chain
* timestamp
* opportunity score
* wallet score
* accumulation score
* distribution score
* risk score
* supporting features
* participating wallets where available
* scoring configuration version

Do not generate duplicate BUY signals for the same unchanged opportunity.

---

# 16. SELL / EXIT Intelligence

The system must detect when a previously recommended token should be exited.

This is a core requirement.

Every BUY signal creates a tracked opportunity lifecycle.

The system must continue monitoring the same token after the BUY signal.

Possible exit evidence:

* increasing distribution
* significant net outflow
* high-quality wallets selling
* collapse of accumulation
* worsening wallet-quality-weighted activity
* liquidity deterioration
* major risk increase
* thesis invalidation
* configured stop-loss condition
* configured take-profit condition

Classify exits as:

```text
HOLD
WATCH
TAKE_PROFIT
STOP_LOSS
EXIT
```

A SELL/EXIT signal must reference the original BUY signal.

Example relationship:

```text
BUY #1042
    ↓
Token XYZ
    ↓
continued monitoring
    ↓
Distribution increases
    ↓
EXIT #1042-01
```

Never treat a SELL signal as an unrelated event when an active BUY opportunity exists.

---

# 17. Signal Lifecycle

Implement a persistent lifecycle:

```text
BUY
→ ACTIVE
→ HOLD / WATCH
→ TAKE_PROFIT / STOP_LOSS / EXIT
→ CLOSED
```

Store:

* original signal
* subsequent evaluations
* score changes
* risk changes
* accumulation changes
* distribution changes
* exit reason
* final outcome

This creates the foundation for evaluating whether the original signal was correct.

---

# 18. Historical Data & Backtesting

Backtesting is a core component.

For each historical signal, preserve the complete state available at that moment.

Store:

* token state
* relevant wallet state
* features
* scores
* risk
* configuration
* timestamp

Measure subsequent performance:

* +1h
* +6h
* +24h
* +3d
* +7d

Also calculate:

* maximum favorable excursion
* maximum adverse excursion
* drawdown
* time to peak
* time to invalidation
* outcome after transaction-cost assumptions

Never use information that was unavailable at the historical signal timestamp.

Prevent look-ahead bias.

---

# 19. Strategy Validation

The system must eventually determine whether its scoring model has predictive value.

Evaluate:

* win rate
* average return
* median return
* expected value
* drawdown
* score distribution
* performance by score range
* false-positive rate
* false-negative rate
* holding duration
* exit quality

Compare:

```text
90–100
80–89
70–79
60–69
...
```

against actual subsequent performance.

Do not assume a higher score means a better trade until historical evidence confirms it.

Avoid optimizing and evaluating on the same dataset.

Use out-of-sample validation.

---

# 20. Supabase Data Model

Use Supabase PostgreSQL as the system of record.

Core entities should include:

```text
wallets
wallet_snapshots
wallet_performance
wallet_scores

tokens
token_snapshots

features
accumulation_events
distribution_events

risk_assessments

opportunities
opportunity_components

signals
signal_outcomes
signal_lifecycle

scoring_profiles
risk_profiles
feature_versions

backtest_runs
backtest_results

nansen_requests
nansen_usage

system_runs
```

Use structured relational fields for values that are queried or calculated.

Use JSON only where provider-specific or flexible metadata is appropriate.

Preserve historical observations.

---

# 21. Configuration & Versioning

Never hard-code strategy parameters throughout the application.

Version:

* feature definitions
* scoring weights
* scoring thresholds
* risk thresholds
* BUY conditions
* SELL conditions
* TAKE_PROFIT conditions
* STOP_LOSS conditions

Every signal must record the exact versions used.

A historical signal must remain reproducible after the strategy changes.

---

# 22. Telegram — Phase 2

Telegram is the first alerting interface.

Implement it after the core scoring and signal system is functioning.

Create a dedicated Telegram adapter.

### BUY alert

Include:

* token
* chain
* Opportunity Score
* Accumulation Score
* Wallet Quality
* Risk
* primary evidence
* relevant wallet activity

### SELL / EXIT alert

Include:

* token
* original BUY signal
* current score
* Distribution Score
* current risk
* reason for exit
* triggering condition
* tracked return where available

### TAKE PROFIT

Clearly identify that the signal is profit-taking rather than thesis invalidation.

### STOP LOSS

Clearly identify the loss threshold that triggered it.

### System alerts

Include:

* Nansen API errors
* API credit/rate-limit issues
* stale data
* worker failures
* scoring failures
* Telegram delivery failures

Telegram must contain presentation logic only.

Analytical logic belongs in the domain services.

---

# 23. Worker

Use a Node.js/TypeScript worker for scheduled operations.

Responsibilities:

* Nansen data acquisition
* wallet updates
* token updates
* snapshot creation
* feature calculation
* scoring
* active opportunity evaluation
* BUY generation
* SELL/EXIT evaluation
* outcome tracking
* Telegram notifications
* system health checks

Jobs should be idempotent and retryable.

---

# 24. Backend Structure

Use clear modules:

```text
api
worker
nansen
database
wallet-intelligence
token-intelligence
features
accumulation
risk
scoring
signals
backtesting
telegram
configuration
observability
```

Nansen-specific response formats must remain isolated in the Nansen adapter.

Domain logic must operate on internal normalized models.

---

# 25. Repository Structure

Use a modular repository structure such as:

```text
crypto-opportunity/
│
├── apps/
│   ├── api/
│   └── worker/
│
├── packages/
│   ├── domain/
│   ├── nansen/
│   ├── database/
│   ├── wallet-intelligence/
│   ├── token-intelligence/
│   ├── features/
│   ├── accumulation/
│   ├── risk/
│   ├── scoring/
│   ├── signals/
│   ├── backtesting/
│   ├── telegram/
│   └── configuration/
│
├── supabase/
│   ├── migrations/
│   └── seed/
│
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── backtest/
│   └── fixtures/
│
└── docs/
    ├── architecture/
    ├── data-model/
    ├── scoring/
    ├── risk/
    └── backtesting/
```

---

# 26. Implementation Strategy

Implement incrementally.

### Stage 1 — Nansen Foundation

* Verify available Free API endpoints.
* Build Nansen adapter.
* Test authentication.
* Implement response validation.
* Track API credits.
* Store normalized observations.

### Stage 2 — Data Model

* Create Supabase schema.
* Implement repositories.
* Implement snapshots.
* Implement configuration/versioning.

### Stage 3 — Quantitative Intelligence

* Wallet scoring
* Token features
* Accumulation scoring
* Distribution scoring
* Risk scoring
* Opportunity scoring

### Stage 4 — Signal Lifecycle

* BUY signals
* Active opportunity tracking
* HOLD/WATCH evaluation
* TAKE_PROFIT
* STOP_LOSS
* EXIT/SELL
* Signal outcome tracking

### Stage 5 — Historical Validation

* Historical observations
* Backtesting
* Outcome calculations
* Score calibration
* Out-of-sample evaluation

### Stage 6 — Telegram

* BUY alerts
* SELL alerts
* TAKE_PROFIT alerts
* STOP_LOSS alerts
* system alerts

---

# 27. $1 Operating Principle

Optimize the entire system around extremely small capital.

Do not assume:

* large position sizes
* frequent trades
* negligible transaction fees
* negligible slippage
* unlimited API calls

A theoretically profitable strategy can be practically unprofitable with $1 because transaction costs can dominate returns.

Therefore, when evaluating the strategy, calculate:

```text
gross return
− trading fees
− network/DEX fees
− estimated slippage
= net return
```

The system must eventually distinguish between:

```text
theoretical signal profitability
```

and:

```text
realistic executable profitability
```

---

# 28. Future Trading Integration

Trading is a separate subsystem.

The intelligence system produces:

```text
BUY
SELL
TAKE_PROFIT
STOP_LOSS
```

The future execution system consumes those signals.

Do not give the scoring engine direct control over funds.

Before autonomous trading is implemented, the strategy must have sufficient historical and paper-trading evidence.

---

# 29. Engineering Rules

1. Use only Nansen data actually available under the user's current API access.
2. Verify endpoint availability before implementation.
3. Treat Nansen API credits as a constrained resource.
4. Cache and deduplicate requests wherever possible.
5. Keep all scoring deterministic.
6. Keep scoring parameters configurable.
7. Version all analytical logic.
8. Preserve historical observations.
9. Prevent look-ahead bias.
10. Make every score explainable.
11. Separate accumulation from distribution.
12. Track the lifecycle of every BUY signal.
13. Generate SELL/EXIT signals for previously recommended tokens when exit conditions are met.
14. Preserve the relationship between BUY and subsequent SELL/EXIT signals.
15. Include transaction costs in strategy evaluation.
16. Optimize for very small capital.
17. Prefer empirical validation over assumptions.
18. Keep the implementation simple until actual scale requires additional infrastructure.
19. Do not introduce paid Nansen functionality as a required dependency.
20. Do not implement autonomous trading until the quantitative strategy has been validated.

---

# 30. Definition of Success

The first successful version is one that can reliably perform this complete analytical lifecycle:

```text
Nansen Free API data
        ↓
Historical observations
        ↓
Wallet evaluation
        ↓
Token features
        ↓
Accumulation / Distribution
        ↓
Risk assessment
        ↓
Opportunity Score 0–100
        ↓
BUY signal
        ↓
Continuous monitoring
        ↓
HOLD / WATCH / TAKE_PROFIT / STOP_LOSS / EXIT
        ↓
Historical outcome
        ↓
Backtesting
        ↓
Measured strategy performance
```

The primary objective is to discover whether this deterministic methodology provides a **real statistical edge**.

The $1 is the capital constraint.

Nansen Free API access is the data constraint.

Supabase is the persistence layer.

The scoring engine is the analytical core.

Telegram is the Phase 2 alerting interface.

The architecture must remain simple enough to operate at extremely low cost while preserving a clear path toward larger-scale automated trading if the strategy proves valid.
