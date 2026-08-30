/**
 * Soren monitoring worker — performs the actual scheduled monitoring work.
 *
 * Every WATCHLIST_OBSERVATION_INTERVAL_MINUTES (default 60) it walks the ACTIVE
 * watchlist sequentially: for each token it collects an observation, computes
 * features from snapshot history, scores with the Golden Formula, evaluates
 * risk gates, advances the watch state, persists an immutable snapshot, emits
 * Telegram notifications for state transitions, and updates triple-barrier
 * episode outcomes. Provider usage is bounded and cached (AGENTS.md Cost
 * Control): one token at a time, one regime request per cycle, DexScreener
 * responses memoized for the duration of a cycle.
 */
import { MonitorRunner } from '../monitor/cycle.js';
import { buildMonitorRuntime } from '../monitor/runtime.js';

const { deps, environment } = buildMonitorRuntime();
const runner = new MonitorRunner(deps);

async function runCycle(): Promise<void> {
  const summary = await runner.runOnce();
  const log = {
    event: 'monitor_cycle',
    startedAt: summary.startedAt,
    completedAt: summary.completedAt,
    tokens: summary.tokens,
    scored: summary.scored,
    incomplete: summary.incomplete,
    failed: summary.failed,
    stateChanges: summary.stateChanges,
    results: summary.results.map((result) => ({
      token: result.symbol ?? result.tokenAddress,
      chain: result.chain,
      status: result.status,
      score: result.score,
      state: `${result.previousState}→${result.state}`,
      changed: result.stateChanged,
      gates: result.gatesVerdict,
      missing: result.missing.length > 0 ? result.missing : undefined,
      notes: result.notes.length > 0 ? result.notes : undefined,
    })),
  };
  if (summary.failed > 0) {
    console.error(JSON.stringify(log));
  } else {
    console.log(JSON.stringify(log));
  }
}

console.log(
  JSON.stringify({
    status: 'ready',
    service: 'soren-worker',
    providers: {
      enrichment: deps.provider.providerName,
      market: 'dexscreener',
      regime: deps.coingecko ? 'coingecko' : null,
    },
    defaultChain: environment.DEFAULT_CHAIN,
    watchlistObservationIntervalMinutes: environment.WATCHLIST_OBSERVATION_INTERVAL_MINUTES,
    telegramConfigured: Boolean(environment.TELEGRAM_BOT_TOKEN && environment.TELEGRAM_CHAT_ID),
  }),
);

const runOnStart =
  process.env.RUN_MONITOR_ON_START === 'true' || process.env.RUN_RESEARCH_ON_START === 'true';
if (runOnStart) {
  await runCycle();
}
setInterval(() => {
  void runCycle();
}, environment.WATCHLIST_OBSERVATION_INTERVAL_MINUTES * 60_000);
