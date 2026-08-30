/**
 * Monitoring pipeline — the core scheduled work (AGENTS.md Core Architecture).
 *
 * For each watchlist token, one evaluation:
 *   1. load prior snapshot history (never the current observation),
 *   2. collect a fresh observation (enrichment + DexScreener + regime),
 *   3. compute the five feature groups from history + observation,
 *   4. score with the Golden Formula (INCOMPLETE when inputs are missing),
 *   5. evaluate the independent risk gates,
 *   6. advance the watch state (barriers → horizon → gates → score),
 *   7. persist an IMMUTABLE market snapshot with full provenance,
 *   8. persist + notify a signal event only on state changes,
 *   9. maintain the pending triple-barrier episode outcomes.
 */
import { TRIPLE_BARRIER_V0 } from '../domain/config.js';
import { computeFeatures } from '../domain/features.js';
import { scoreGoldenFormula } from '../domain/golden-formula.js';
import { evaluateRiskGates } from '../domain/risk-gates.js';
import { advanceWatchState } from '../domain/signal-engine.js';
import { evaluateTripleBarrier } from '../domain/triple-barrier.js';
import type {
  BarrierSnapshot,
  FeatureVector,
  FormulaEvaluation,
  GateEvaluation,
  HistoryPoint,
  WatchState,
} from '../domain/types.js';
import { collectObservation, type ObservationDeps, type TokenObservation } from './observation.js';
import type {
  EpisodeOutcomePatch,
  MonitoringStatePatch,
  NewSnapshotRecord,
  OutcomeRepository,
  SignalEventRepository,
  SnapshotRepository,
  SystemRunsRepository,
  WatchlistRepository,
  WatchlistToken,
} from '../store/types.js';

export const SNAPSHOT_HISTORY_LIMIT = 30;

export interface SignalNotification {
  tokenId: string;
  snapshotId: string;
  chain: string;
  tokenAddress: string;
  symbol: string | null;
  observedAt: string;
  fromState: WatchState;
  toState: WatchState;
  reason: string;
  score: number | null;
  formulaVersion: string;
  components: Record<string, number | null>;
  gatesVerdict: string;
  entryPrice: number | null;
  currentPrice: number | null;
  evaluationStatus: 'SCORED' | 'INCOMPLETE';
}

export interface SignalAlerter {
  notify(notification: SignalNotification): Promise<void>;
}

export interface MonitorDeps extends ObservationDeps {
  watchlist: WatchlistRepository;
  snapshots: SnapshotRepository;
  signals: SignalEventRepository;
  outcomes: OutcomeRepository;
  alerting: SignalAlerter | null;
  runs?: SystemRunsRepository;
  clock: () => Date;
  /** Preview mode (API) computes everything but writes nothing. */
  persist: boolean;
}

export interface TokenEvaluationResult {
  tokenId: string;
  tokenAddress: string;
  chain: string;
  symbol: string | null;
  status: 'SCORED' | 'INCOMPLETE' | 'FAILED';
  score: number | null;
  interpretation: string | null;
  missing: string[];
  gatesVerdict: string | null;
  previousState: WatchState;
  state: WatchState;
  stateChanged: boolean;
  snapshotId: string | null;
  notes: string[];
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const candidate = (error as { message?: unknown }).message;
    if (typeof candidate === 'string') return candidate;
  }
  return String(error);
}

function componentValues(features: FeatureVector): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [name, result] of Object.entries(features.components)) {
    out[name] = result.value;
  }
  return out;
}

function aggregateNetFlow(observation: TokenObservation): number | null {
  const known = observation.smartMoney.filter((entry) => typeof entry.netFlow24h === 'number');
  if (known.length === 0) return null;
  return known.reduce((sum, entry) => sum + (entry.netFlow24h as number), 0);
}

function aggregateBalance(observation: TokenObservation): number | null {
  const known = observation.smartMoney.filter((entry) => typeof entry.balance === 'number');
  if (known.length === 0) return null;
  return known.reduce((sum, entry) => sum + (entry.balance as number), 0);
}

export class TokenMonitor {
  constructor(private readonly deps: MonitorDeps) {}

  async evaluate(entry: WatchlistToken): Promise<TokenEvaluationResult> {
    const notes: string[] = [];
    const now = this.deps.clock();
    try {
      // History: prior snapshots only — the current observation is never in it.
      // History is best-effort context (acceleration/regime inputs); when the
      // snapshot store is unreachable the evaluation degrades to an empty
      // history with a note rather than failing the whole token.
      let historyRecords: Awaited<ReturnType<MonitorDeps['snapshots']['listRecent']>> = [];
      try {
        historyRecords = (await this.deps.snapshots.listRecent(entry.id, SNAPSHOT_HISTORY_LIMIT)).reverse();
      } catch (error) {
        notes.push(`Prior snapshot history unavailable: ${message(error)}`);
      }
      const history: HistoryPoint[] = historyRecords.map((record) => ({
        observedAt: record.observedAt,
        priceUsd: record.metrics.priceUsd,
        netFlow24h: record.metrics.netFlow24h,
        totalSmartBalance: record.metrics.totalSmartBalance,
      }));

      const observation = await collectObservation(
        this.deps,
        entry.chain,
        entry.tokenAddress,
        entry.smartMoneyWallets,
        now,
      );
      notes.push(...observation.notes);

      const features = computeFeatures({
        market: observation.market,
        regime: observation.regime,
        smartMoney: observation.smartMoney,
        history,
        now: now.toISOString(),
      });
      const evaluation = scoreGoldenFormula(features);
      const gates = evaluateRiskGates(observation.market, observation.holders);

      const entryRef =
        entry.entryPrice != null && entry.entryAt != null ? { price: entry.entryPrice, at: entry.entryAt } : null;
      const engine = advanceWatchState({
        previousState: entry.currentState,
        evaluation,
        gates,
        priceUsd: observation.market.priceUsd,
        entry: entryRef,
        now: now.toISOString(),
      });

      let snapshotId: string | null = null;
      if (this.deps.persist) {
        snapshotId = await this.persistCycle(entry, observation, features, evaluation, gates, engine, notes);
      }

      return {
        tokenId: entry.id,
        tokenAddress: entry.tokenAddress,
        chain: entry.chain,
        symbol: observation.symbol,
        status: evaluation.status,
        score: evaluation.score,
        interpretation: evaluation.interpretation,
        missing: evaluation.missing,
        gatesVerdict: gates.verdict,
        previousState: entry.currentState,
        state: engine.state,
        stateChanged: engine.transition.changed,
        snapshotId,
        notes,
      };
    } catch (error) {
      return {
        tokenId: entry.id,
        tokenAddress: entry.tokenAddress,
        chain: entry.chain,
        symbol: null,
        status: 'FAILED',
        score: null,
        interpretation: null,
        missing: [],
        gatesVerdict: null,
        previousState: entry.currentState,
        state: entry.currentState,
        stateChanged: false,
        snapshotId: null,
        notes: [...notes, message(error)],
      };
    }
  }

  private async persistCycle(
    entry: WatchlistToken,
    observation: TokenObservation,
    features: FeatureVector,
    evaluation: FormulaEvaluation,
    gates: GateEvaluation,
    engine: ReturnType<typeof advanceWatchState>,
    notes: string[],
  ): Promise<string | null> {
    const record: NewSnapshotRecord = {
      watchlistTokenId: entry.id,
      chain: entry.chain,
      tokenAddress: entry.tokenAddress,
      observedAt: observation.observedAt,
      source: [
        observation.enrichmentProvider,
        observation.market.provider,
        observation.regime?.provider,
      ]
        .filter(Boolean)
        .join('+'),
      raw: {
        enrichment: observation.enrichment,
        market: observation.market,
        regime: observation.regime,
      },
      features,
      metrics: {
        priceUsd: observation.market.priceUsd,
        liquidityUsd: observation.market.liquidityUsd,
        volume24hUsd: observation.market.volume24hUsd,
        netFlow24h: aggregateNetFlow(observation),
        totalSmartBalance: aggregateBalance(observation),
      },
      formulaVersion: evaluation.formulaVersion,
      formulaParams: evaluation.formulaParams,
      score: evaluation.score,
      evaluationStatus: evaluation.status,
      missingInputs: evaluation.missing,
      gateResults: gates.gates,
      gateVersion: gates.gateVersion,
      signal: engine.state,
      signalChanged: engine.transition.changed,
    };

    const inserted = await this.deps.snapshots.insert(record);
    if (!inserted) {
      notes.push('Snapshot already existed for this timestamp (idempotent re-run); writes skipped.');
      return null;
    }

    if (engine.transition.changed) {
      await this.deps.signals.insert({
        watchlistTokenId: entry.id,
        snapshotId: inserted.id,
        fromState: engine.transition.from,
        toState: engine.transition.to,
        score: evaluation.score,
        formulaVersion: evaluation.formulaVersion,
        evidence: {
          reason: engine.transition.reason,
          interpretation: evaluation.interpretation,
          gates: gates.gates,
          components: componentValues(features),
        },
      });
      if (this.deps.alerting) {
        try {
          await this.deps.alerting.notify({
            tokenId: entry.id,
            snapshotId: inserted.id,
            chain: entry.chain,
            tokenAddress: entry.tokenAddress,
            symbol: observation.symbol,
            observedAt: observation.observedAt,
            fromState: engine.transition.from,
            toState: engine.transition.to,
            reason: engine.transition.reason,
            score: evaluation.score,
            formulaVersion: evaluation.formulaVersion,
            components: componentValues(features),
            gatesVerdict: gates.verdict,
            entryPrice: engine.episode.started ? engine.episode.entryPrice : entry.entryPrice,
            currentPrice: observation.market.priceUsd,
            evaluationStatus: evaluation.status,
          });
        } catch (error) {
          notes.push(`Telegram notification failed: ${message(error)}`);
        }
      }
    }

    const patch: MonitoringStatePatch = {
      currentState: engine.state,
      lastObservedAt: observation.observedAt,
      lastScore: evaluation.score,
      formulaVersion: evaluation.formulaVersion,
    };
    if (engine.episode.started) {
      patch.entryPrice = engine.episode.entryPrice;
      patch.entryAt = engine.episode.entryAt;
      patch.entrySnapshotId = inserted.id;
    }
    if (engine.episode.ended) {
      patch.entryPrice = null;
      patch.entryAt = null;
      patch.entrySnapshotId = null;
    }
    await this.deps.watchlist.updateMonitoringState(entry.id, patch);

    await this.updateOutcomes(entry, observation, features, inserted.id, engine, notes);
    return inserted.id;
  }

  private async updateOutcomes(
    entry: WatchlistToken,
    observation: TokenObservation,
    features: FeatureVector,
    entrySnapshotId: string,
    engine: ReturnType<typeof advanceWatchState>,
    notes: string[],
  ): Promise<void> {
    // A newly started episode opens a pending triple-barrier outcome whose
    // entry reference is the snapshot that produced the BUY candidate. The
    // regime at signal time is preserved for later backtesting analysis.
    if (engine.episode.started && engine.episode.entryPrice != null && engine.episode.entryAt != null) {
      try {
        await this.deps.outcomes.insertPending({
          watchlistTokenId: entry.id,
          entrySnapshotId,
          paramsVersion: TRIPLE_BARRIER_V0.id,
          targetPct: TRIPLE_BARRIER_V0.targetPct,
          stopPct: TRIPLE_BARRIER_V0.stopPct,
          horizonHours: TRIPLE_BARRIER_V0.horizonHours,
          entryPrice: engine.episode.entryPrice,
          entryAt: engine.episode.entryAt,
          regimeAtSignal: {
            value: features.components.marketRegime.value,
            inputs: features.components.marketRegime.inputs,
          },
        });
      } catch (error) {
        notes.push(`Episode outcome record unavailable: ${message(error)}`);
      }
      return;
    }
    try {
      await this.evaluatePendingOutcomes(entry, observation, notes);
    } catch (error) {
      notes.push(`Episode outcome evaluation unavailable: ${message(error)}`);
    }
  }

  private async evaluatePendingOutcomes(
    entry: WatchlistToken,
    observation: TokenObservation,
    notes: string[],
  ): Promise<void> {
    const pending = await this.deps.outcomes.listPendingByToken(entry.id);
    if (pending.length === 0) return;

    // Barrier evaluation consumes stored snapshots strictly after the entry
    // plus the current observation — future information cannot exist here.
    const history = await this.deps.snapshots.listRecent(entry.id, SNAPSHOT_HISTORY_LIMIT);
    const points: BarrierSnapshot[] = [];
    for (const record of history) {
      if (record.metrics.priceUsd != null && record.metrics.priceUsd > 0) {
        points.push({ observedAt: record.observedAt, priceUsd: record.metrics.priceUsd });
      }
    }
    if (observation.market.priceUsd != null && observation.market.priceUsd > 0) {
      points.push({ observedAt: observation.observedAt, priceUsd: observation.market.priceUsd });
    }

    for (const outcome of pending) {
      const result = evaluateTripleBarrier(
        { priceUsd: outcome.entryPrice, entryAt: outcome.entryAt },
        points,
        TRIPLE_BARRIER_V0,
        observation.observedAt,
      );
      const patch: EpisodeOutcomePatch = { mfePct: result.mfePct, maePct: result.maePct };
      if (result.status !== 'PENDING') {
        const outcomeSnapshot = history.find((record) => record.observedAt === result.outcomeAt);
        patch.status = result.status;
        patch.outcomeSnapshotId = outcomeSnapshot?.id ?? null;
        patch.resolvedAt = observation.observedAt;
        patch.timeToOutcomeMinutes = result.timeToOutcomeMinutes;
        patch.returnPct = result.returnPct;
        notes.push(`Episode outcome resolved: ${result.status} after ${result.timeToOutcomeMinutes ?? '?'} min.`);
      }
      await this.deps.outcomes.update(outcome.id, patch);
    }
  }
}

export interface MonitorRunSummary {
  startedAt: string;
  completedAt: string;
  tokens: number;
  scored: number;
  incomplete: number;
  failed: number;
  stateChanges: number;
  results: TokenEvaluationResult[];
}

/**
 * Scheduled runner: iterates the ACTIVE watchlist sequentially (bounded and
 * cache-friendly — one token at a time keeps every provider well inside free
 * rate limits), recording run provenance in system_runs.
 */
export class MonitorRunner {
  private readonly monitor: TokenMonitor;

  constructor(private readonly deps: MonitorDeps) {
    this.monitor = new TokenMonitor(deps);
  }

  async runOnce(): Promise<MonitorRunSummary> {
    const startedAt = this.deps.clock();
    const runId = (await this.deps.runs?.start('monitor_cycle', startedAt.toISOString())) ?? null;
    let firstError: unknown = null;
    const results: TokenEvaluationResult[] = [];

    try {
      const tokens = await this.deps.watchlist.listActive();
      for (const token of tokens) {
        try {
          results.push(await this.monitor.evaluate(token));
        } catch (error) {
          firstError ??= error;
          results.push({
            tokenId: token.id,
            tokenAddress: token.tokenAddress,
            chain: token.chain,
            symbol: null,
            status: 'FAILED',
            score: null,
            interpretation: null,
            missing: [],
            gatesVerdict: null,
            previousState: token.currentState,
            state: token.currentState,
            stateChanged: false,
            snapshotId: null,
            notes: [message(error)],
          });
        }
      }
    } catch (error) {
      firstError ??= error;
    }

    const completedAt = this.deps.clock();
    const scored = results.filter((result) => result.status === 'SCORED').length;
    const incomplete = results.filter((result) => result.status === 'INCOMPLETE').length;
    const failed = results.filter((result) => result.status === 'FAILED').length;
    const stateChanges = results.filter((result) => result.stateChanged).length;
    const status = failed === 0 ? 'COMPLETED' : scored + incomplete > 0 ? 'PARTIAL' : 'FAILED';
    await this.deps.runs?.complete(runId, status, results.length, firstError);

    return {
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      tokens: results.length,
      scored,
      incomplete,
      failed,
      stateChanges,
      results,
    };
  }
}
