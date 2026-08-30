/**
 * Supabase implementation of the monitoring repositories. Postgres numerics
 * come back from PostgREST as strings, so every numeric column is coerced
 * explicitly.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WatchState } from '../domain/types.js';
import type {
  EpisodeOutcomePatch,
  EpisodeOutcomeRecord,
  MonitoringStatePatch,
  NewEpisodeOutcome,
  NewSnapshotRecord,
  NewWatchlistToken,
  OutcomeRepository,
  SignalEventRecord,
  SignalEventRepository,
  SnapshotRecord,
  SnapshotRepository,
  SystemRunsRepository,
  WatchlistRepository,
  WatchlistToken,
} from './types.js';

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toJson(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

function toArray(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

// ---------------------------------------------------------------------------
// Watchlist
// ---------------------------------------------------------------------------

type WatchlistRow = {
  id: string;
  chain: string;
  token_address: string;
  smart_money_wallets: unknown;
  status: string;
  current_state: string;
  entry_price: unknown;
  entry_at: string | null;
  entry_snapshot_id: string | null;
  last_observed_at: string | null;
  last_score: unknown;
  formula_version: string | null;
  created_at: string;
};

function mapWatchlistToken(row: WatchlistRow): WatchlistToken {
  return {
    id: row.id,
    chain: row.chain,
    tokenAddress: row.token_address,
    smartMoneyWallets: toArray(row.smart_money_wallets),
    status: row.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE',
    currentState: row.current_state as WatchState,
    entryPrice: toNumber(row.entry_price),
    entryAt: row.entry_at,
    entrySnapshotId: row.entry_snapshot_id,
    lastObservedAt: row.last_observed_at,
    lastScore: toNumber(row.last_score),
    formulaVersion: row.formula_version,
    createdAt: row.created_at,
  };
}

export class SupabaseWatchlistRepository implements WatchlistRepository {
  constructor(private readonly client: SupabaseClient) {}

  private select() {
    return this.client.from('watchlist_tokens').select('*');
  }

  async list(): Promise<WatchlistToken[]> {
    const { data, error } = await this.select().order('created_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map((row) => mapWatchlistToken(row as WatchlistRow));
  }

  async listActive(): Promise<WatchlistToken[]> {
    const { data, error } = await this.select().eq('status', 'ACTIVE').order('created_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map((row) => mapWatchlistToken(row as WatchlistRow));
  }

  async get(id: string): Promise<WatchlistToken | null> {
    const { data, error } = await this.select().eq('id', id).maybeSingle();
    if (error) throw error;
    return data ? mapWatchlistToken(data as WatchlistRow) : null;
  }

  async findByChainAndAddress(chain: string, tokenAddress: string): Promise<WatchlistToken | null> {
    const { data, error } = await this.select()
      .eq('chain', chain)
      .eq('token_address', tokenAddress)
      .maybeSingle();
    if (error) throw error;
    return data ? mapWatchlistToken(data as WatchlistRow) : null;
  }

  async create(input: NewWatchlistToken): Promise<WatchlistToken> {
    const { data, error } = await this.client
      .from('watchlist_tokens')
      .insert({
        chain: input.chain,
        token_address: input.tokenAddress,
        smart_money_wallets: input.smartMoneyWallets,
      })
      .select('*')
      .single();
    if (error) throw error;
    return mapWatchlistToken(data as WatchlistRow);
  }

  async setStatus(id: string, status: 'ACTIVE' | 'PAUSED'): Promise<void> {
    const { error } = await this.client
      .from('watchlist_tokens')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
  }

  async updateMonitoringState(id: string, patch: MonitoringStatePatch): Promise<void> {
    const row: Record<string, unknown> = {
      current_state: patch.currentState,
      last_observed_at: patch.lastObservedAt,
      last_score: patch.lastScore,
      formula_version: patch.formulaVersion,
      updated_at: new Date().toISOString(),
    };
    if (patch.entryPrice !== undefined) row.entry_price = patch.entryPrice;
    if (patch.entryAt !== undefined) row.entry_at = patch.entryAt;
    if (patch.entrySnapshotId !== undefined) row.entry_snapshot_id = patch.entrySnapshotId;
    const { error } = await this.client.from('watchlist_tokens').update(row).eq('id', id);
    if (error) throw error;
  }
}


// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

type SnapshotRow = Record<string, unknown>;

function mapSnapshot(row: SnapshotRow): SnapshotRecord {
  const metrics = toJson(row.metrics);
  return {
    id: row.id as string,
    watchlistTokenId: row.watchlist_token_id as string,
    chain: row.chain as string,
    tokenAddress: row.token_address as string,
    observedAt: row.observed_at as string,
    source: row.source as string,
    raw: toJson(row.raw),
    features: toJson(row.features),
    metrics: {
      priceUsd: toNumber(metrics.priceUsd),
      liquidityUsd: toNumber(metrics.liquidityUsd),
      volume24hUsd: toNumber(metrics.volume24hUsd),
      netFlow24h: toNumber(metrics.netFlow24h),
      totalSmartBalance: toNumber(metrics.totalSmartBalance),
    },
    formulaVersion: (row.formula_version as string | null) ?? null,
    formulaParams: toJson(row.formula_params),
    score: toNumber(row.score),
    evaluationStatus: row.evaluation_status === 'SCORED' ? 'SCORED' : 'INCOMPLETE',
    missingInputs: toArray(row.missing_inputs),
    gateResults: row.gate_results ?? [],
    gateVersion: (row.gate_version as string | null) ?? null,
    signal: row.signal as WatchState,
    signalChanged: row.signal_changed === true,
    createdAt: row.created_at as string,
  };
}

export class SupabaseSnapshotRepository implements SnapshotRepository {
  constructor(private readonly client: SupabaseClient) {}

  async insert(record: NewSnapshotRecord): Promise<SnapshotRecord | null> {
    const { data, error } = await this.client
      .from('market_snapshots')
      .upsert(
        {
          watchlist_token_id: record.watchlistTokenId,
          chain: record.chain,
          token_address: record.tokenAddress,
          observed_at: record.observedAt,
          source: record.source,
          raw: toJson(record.raw),
          features: toJson(record.features),
          metrics: toJson(record.metrics),
          formula_version: record.formulaVersion,
          formula_params: toJson(record.formulaParams),
          score: record.score,
          evaluation_status: record.evaluationStatus,
          missing_inputs: record.missingInputs,
          gate_results: record.gateResults ?? [],
          gate_version: record.gateVersion,
          signal: record.signal,
          signal_changed: record.signalChanged,
        },
        { onConflict: 'watchlist_token_id,observed_at', ignoreDuplicates: true },
      )
      .select('*')
      .maybeSingle();
    if (error) throw error;
    return data ? mapSnapshot(data as SnapshotRow) : null;
  }

  async listRecent(watchlistTokenId: string, limit: number): Promise<SnapshotRecord[]> {
    const { data, error } = await this.client
      .from('market_snapshots')
      .select('*')
      .eq('watchlist_token_id', watchlistTokenId)
      .order('observed_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []).map((row) => mapSnapshot(row as SnapshotRow));
  }
}

// ---------------------------------------------------------------------------
// Signal events
// ---------------------------------------------------------------------------

type SignalRow = Record<string, unknown>;

function mapSignalEvent(row: SignalRow): SignalEventRecord {
  return {
    id: row.id as string,
    watchlistTokenId: row.watchlist_token_id as string,
    snapshotId: (row.snapshot_id as string | null) ?? null,
    fromState: (row.from_state as WatchState | null) ?? null,
    toState: row.to_state as WatchState,
    generatedAt: row.generated_at as string,
    score: toNumber(row.score),
    formulaVersion: (row.formula_version as string | null) ?? null,
    evidence: toJson(row.evidence),
  };
}

export class SupabaseSignalEventRepository implements SignalEventRepository {
  constructor(private readonly client: SupabaseClient) {}

  async insert(
    event: Omit<SignalEventRecord, 'id' | 'generatedAt'> & { generatedAt?: string },
  ): Promise<void> {
    const { error } = await this.client.from('signal_events').insert({
      watchlist_token_id: event.watchlistTokenId,
      snapshot_id: event.snapshotId,
      from_state: event.fromState,
      to_state: event.toState,
      generated_at: event.generatedAt ?? new Date().toISOString(),
      score: event.score,
      formula_version: event.formulaVersion,
      evidence: toJson(event.evidence),
    });
    if (error) throw error;
  }

  async listRecent(watchlistTokenId: string, limit: number): Promise<SignalEventRecord[]> {
    const { data, error } = await this.client
      .from('signal_events')
      .select('*')
      .eq('watchlist_token_id', watchlistTokenId)
      .order('generated_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []).map((row) => mapSignalEvent(row as SignalRow));
  }
}


// ---------------------------------------------------------------------------
// Episode outcomes
// ---------------------------------------------------------------------------

function mapOutcome(row: SignalRow): EpisodeOutcomeRecord {
  return {
    id: row.id as string,
    watchlistTokenId: row.watchlist_token_id as string,
    entrySnapshotId: row.entry_snapshot_id as string,
    paramsVersion: row.params_version as string,
    targetPct: toNumber(row.target_pct) as number,
    stopPct: toNumber(row.stop_pct) as number,
    horizonHours: toNumber(row.horizon_hours) as number,
    entryPrice: toNumber(row.entry_price) as number,
    entryAt: row.entry_at as string,
    regimeAtSignal: toJson(row.regime_at_signal),
    status: (row.status as EpisodeOutcomeRecord['status']) ?? 'PENDING',
    outcomeSnapshotId: (row.outcome_snapshot_id as string | null) ?? null,
    resolvedAt: (row.resolved_at as string | null) ?? null,
    timeToOutcomeMinutes: toNumber(row.time_to_outcome_minutes),
    mfePct: toNumber(row.mfe_pct),
    maePct: toNumber(row.mae_pct),
    returnPct: toNumber(row.return_pct),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export class SupabaseOutcomeRepository implements OutcomeRepository {
  constructor(private readonly client: SupabaseClient) {}

  async insertPending(outcome: NewEpisodeOutcome): Promise<EpisodeOutcomeRecord> {
    const { data, error } = await this.client
      .from('episode_outcomes')
      .insert({
        watchlist_token_id: outcome.watchlistTokenId,
        entry_snapshot_id: outcome.entrySnapshotId,
        params_version: outcome.paramsVersion,
        target_pct: outcome.targetPct,
        stop_pct: outcome.stopPct,
        horizon_hours: outcome.horizonHours,
        entry_price: outcome.entryPrice,
        entry_at: outcome.entryAt,
        regime_at_signal: toJson(outcome.regimeAtSignal),
        status: 'PENDING',
      })
      .select('*')
      .single();
    if (error) throw error;
    return mapOutcome(data as SignalRow);
  }

  async listPendingByToken(watchlistTokenId: string): Promise<EpisodeOutcomeRecord[]> {
    const { data, error } = await this.client
      .from('episode_outcomes')
      .select('*')
      .eq('watchlist_token_id', watchlistTokenId)
      .eq('status', 'PENDING')
      .order('entry_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map((row) => mapOutcome(row as SignalRow));
  }

  async update(id: string, patch: EpisodeOutcomePatch): Promise<void> {
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.outcomeSnapshotId !== undefined) row.outcome_snapshot_id = patch.outcomeSnapshotId;
    if (patch.resolvedAt !== undefined) row.resolved_at = patch.resolvedAt;
    if (patch.timeToOutcomeMinutes !== undefined) row.time_to_outcome_minutes = patch.timeToOutcomeMinutes;
    if (patch.mfePct !== undefined) row.mfe_pct = patch.mfePct;
    if (patch.maePct !== undefined) row.mae_pct = patch.maePct;
    if (patch.returnPct !== undefined) row.return_pct = patch.returnPct;
    const { error } = await this.client.from('episode_outcomes').update(row).eq('id', id);
    if (error) throw error;
  }

  async listByToken(watchlistTokenId: string, limit: number): Promise<EpisodeOutcomeRecord[]> {
    const { data, error } = await this.client
      .from('episode_outcomes')
      .select('*')
      .eq('watchlist_token_id', watchlistTokenId)
      .order('entry_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []).map((row) => mapOutcome(row as SignalRow));
  }
}

// ---------------------------------------------------------------------------
// System runs (provenance of scheduled work)
// ---------------------------------------------------------------------------

export class SupabaseSystemRunsRepository implements SystemRunsRepository {
  constructor(private readonly client: SupabaseClient) {}

  async start(jobName: string, startedAt: string): Promise<string | null> {
    try {
      const { data, error } = await this.client
        .from('system_runs')
        .insert({ job_name: jobName, started_at: startedAt, status: 'RUNNING' })
        .select('id')
        .single();
      if (error) throw error;
      return (data as { id: string } | null)?.id ?? null;
    } catch {
      // Run provenance is best-effort and must never block monitoring.
      return null;
    }
  }

  async complete(
    runId: string | null,
    status: 'COMPLETED' | 'PARTIAL' | 'FAILED',
    recordsProcessed: number,
    error: unknown,
  ): Promise<void> {
    if (!runId) return;
    try {
      await this.client
        .from('system_runs')
        .update({
          status,
          completed_at: new Date().toISOString(),
          records_processed: recordsProcessed,
          error: error == null ? null : { message: error instanceof Error ? error.message : String(error) },
        })
        .eq('id', runId);
    } catch {
      // best-effort
    }
  }
}

