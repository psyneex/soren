/**
 * Repository interfaces for the monitoring phase. The domain/monitor code
 * depends only on these interfaces; Supabase is one implementation (tests use
 * in-memory fakes), keeping infrastructure out of business logic.
 */
import type { WatchState } from '../domain/types.js';

// ---------------------------------------------------------------------------
// Watchlist
// ---------------------------------------------------------------------------

export interface WatchlistToken {
  id: string;
  chain: string;
  tokenAddress: string;
  /** Optional symbol hydraded from the latest observed metadata. */
  symbol?: string | null;
  smartMoneyWallets: string[];
  status: 'ACTIVE' | 'PAUSED';
  currentState: WatchState;
  entryPrice: number | null;
  entryAt: string | null;
  entrySnapshotId: string | null;
  lastObservedAt: string | null;
  lastScore: number | null;
  formulaVersion: string | null;
  createdAt: string;
}

export interface NewWatchlistToken {
  chain: string;
  tokenAddress: string;
  smartMoneyWallets: string[];
}

export interface MonitoringStatePatch {
  currentState: WatchState;
  lastObservedAt: string;
  lastScore: number | null;
  formulaVersion: string | null;
  entryPrice?: number | null;
  entryAt?: string | null;
  entrySnapshotId?: string | null;
}

export interface WatchlistRepository {
  list(): Promise<WatchlistToken[]>;
  listActive(): Promise<WatchlistToken[]>;
  get(id: string): Promise<WatchlistToken | null>;
  findByChainAndAddress(chain: string, tokenAddress: string): Promise<WatchlistToken | null>;
  create(input: NewWatchlistToken): Promise<WatchlistToken>;
  setStatus(id: string, status: 'ACTIVE' | 'PAUSED'): Promise<void>;
  updateMonitoringState(id: string, patch: MonitoringStatePatch): Promise<void>;
}

// ---------------------------------------------------------------------------
// Market snapshots (immutable)
// ---------------------------------------------------------------------------

export interface SnapshotMetrics {
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  netFlow24h: number | null;
  totalSmartBalance: number | null;
}

export interface NewSnapshotRecord {
  watchlistTokenId: string;
  chain: string;
  tokenAddress: string;
  observedAt: string;
  /** Provider/source provenance summary, e.g. "alchemy+dexscreener+coingecko". */
  source: string;
  raw: unknown;
  features: unknown;
  metrics: SnapshotMetrics;
  formulaVersion: string | null;
  formulaParams: unknown;
  score: number | null;
  evaluationStatus: 'SCORED' | 'INCOMPLETE';
  missingInputs: string[];
  gateResults: unknown;
  gateVersion: string | null;
  signal: WatchState;
  signalChanged: boolean;
}

export interface SnapshotRecord extends NewSnapshotRecord {
  id: string;
  createdAt: string;
}

export interface SnapshotRepository {
  /** Idempotent insert; returns null when a snapshot at that timestamp already exists. */
  insert(record: NewSnapshotRecord): Promise<SnapshotRecord | null>;
  /** Most recent snapshots, descending by observedAt. */
  listRecent(watchlistTokenId: string, limit: number): Promise<SnapshotRecord[]>;
}

// ---------------------------------------------------------------------------
// Signal events (state transitions)
// ---------------------------------------------------------------------------

export interface SignalEventRecord {
  id: string;
  watchlistTokenId: string;
  snapshotId: string | null;
  fromState: WatchState | null;
  toState: WatchState;
  generatedAt: string;
  score: number | null;
  formulaVersion: string | null;
  evidence: Record<string, unknown>;
}

export interface SignalEventRepository {
  insert(event: Omit<SignalEventRecord, 'id' | 'generatedAt'> & { generatedAt?: string }): Promise<void>;
  listRecent(watchlistTokenId: string, limit: number): Promise<SignalEventRecord[]>;
}

// ---------------------------------------------------------------------------
// Episode outcomes (triple-barrier research labels)
// ---------------------------------------------------------------------------

export interface NewEpisodeOutcome {
  watchlistTokenId: string;
  entrySnapshotId: string;
  paramsVersion: string;
  targetPct: number;
  stopPct: number;
  horizonHours: number;
  entryPrice: number;
  entryAt: string;
  regimeAtSignal: Record<string, unknown>;
}

export interface EpisodeOutcomeRecord extends NewEpisodeOutcome {
  id: string;
  status: 'PENDING' | 'TARGET_HIT' | 'STOP_HIT' | 'TIMEOUT';
  outcomeSnapshotId: string | null;
  resolvedAt: string | null;
  timeToOutcomeMinutes: number | null;
  mfePct: number | null;
  maePct: number | null;
  returnPct: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface EpisodeOutcomePatch {
  status?: 'PENDING' | 'TARGET_HIT' | 'STOP_HIT' | 'TIMEOUT';
  outcomeSnapshotId?: string | null;
  resolvedAt?: string | null;
  timeToOutcomeMinutes?: number | null;
  mfePct?: number | null;
  maePct?: number | null;
  returnPct?: number | null;
}

export interface OutcomeRepository {
  insertPending(outcome: NewEpisodeOutcome): Promise<EpisodeOutcomeRecord>;
  listPendingByToken(watchlistTokenId: string): Promise<EpisodeOutcomeRecord[]>;
  update(id: string, patch: EpisodeOutcomePatch): Promise<void>;
  listByToken(watchlistTokenId: string, limit: number): Promise<EpisodeOutcomeRecord[]>;
}

// ---------------------------------------------------------------------------
// System run provenance
// ---------------------------------------------------------------------------

export interface SystemRunsRepository {
  start(jobName: string, startedAt: string): Promise<string | null>;
  complete(
    runId: string | null,
    status: 'COMPLETED' | 'PARTIAL' | 'FAILED',
    recordsProcessed: number,
    error: unknown,
  ): Promise<void>;
}
