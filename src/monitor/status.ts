/**
 * Monitoring status — read-only derivation of system health from the immutable
 * snapshot store (AGENTS.md: explicit provenance, provider failures degrade
 * visibly). Reports, per ACTIVE token, the latest evaluation with per-component
 * diagnostics (why a component is UNAVAILABLE), whether the provider-regime
 * reference is healthy or degraded, and whether the next scheduled cycle can
 * plausibly produce a full score (e.g. accumulation acceleration requires a
 * prior snapshot at least accelerationMinLagHours old).
 *
 * No provider calls are made: status is derived purely from stored evidence.
 */
import { FEATURE_COMPONENTS, type FeatureComponentName } from '../domain/types.js';
import { FEATURE_CONFIG_V0 } from '../domain/config.js';
import type { MonitorDeps } from './cycle.js';

export type Health = 'HEALTHY' | 'DEGRADED' | 'UNKNOWN';

export interface ComponentDiagnostic {
  component: string;
  status: 'OK' | 'UNAVAILABLE';
  value: number | null;
  notes: string[];
}

export interface TokenMonitoringStatus {
  tokenId: string;
  tokenAddress: string;
  chain: string;
  symbol: string | null;
  currentState: string;
  lastObservedAt: string | null;
  lastScore: number | null;
  lastEvaluationStatus: 'SCORED' | 'INCOMPLETE' | null;
  lastSignal: string | null;
  missingInputs: string[];
  components: ComponentDiagnostic[];
  /** Earliest time a next evaluation can include accumulation acceleration (complete prior metrics + min lag). */
  accelerationReadyAt: string | null;
  /** Whether the next scheduled cycle is expected to produce a full score for this token. */
  scoreExpectedNext: Health;
  notes: string[];
}

export interface MonitoringStatus {
  generatedAt: string;
  /** Next cron tick — top of the hour; the schedule itself is configured in wrangler.jsonc. */
  nextTickAt: string;
  cronSchedule: string;
  providers: {
    enrichment: string;
    market: string;
    regime: string | null;
    regimeHealth: Health;
    regimeNotes: string[];
  };
  tokens: TokenMonitoringStatus[];
}

interface StoredComponent {
  status?: string;
  value?: number | null;
  notes?: string[];
  inputs?: { regimeNotes?: string[] };
}

function extractComponents(features: unknown): Record<string, StoredComponent> {
  const components = (features as { components?: unknown } | null)?.components;
  return typeof components === 'object' && components !== null
    ? (components as Record<string, StoredComponent>)
    : {};
}

function componentDiagnostic(component: FeatureComponentName, stored: StoredComponent | undefined, missing: string[]): ComponentDiagnostic {
  return {
    component,
    status: missing.includes(component) ? 'UNAVAILABLE' : stored?.status === 'OK' ? 'OK' : 'UNAVAILABLE',
    value: typeof stored?.value === 'number' ? stored.value : null,
    notes: [
      ...(Array.isArray(stored?.inputs?.regimeNotes) ? stored?.inputs?.regimeNotes ?? [] : []),
      ...(Array.isArray(stored?.notes) ? (stored?.notes as string[]).slice(0, 2) : []),
    ].slice(0, 3),
  };
}

function componentDiagnostics(features: unknown, missing: string[]): ComponentDiagnostic[] {
  const components = extractComponents(features);
  return FEATURE_COMPONENTS.map((component) => componentDiagnostic(component, components[component], missing));
}

/** Regime provider health from the stored marketRegime component of one snapshot. */
function regimeHealthFrom(features: unknown): { health: Health; notes: string[] } {
  const regime = extractComponents(features).marketRegime;
  if (!regime) return { health: 'UNKNOWN', notes: [] };
  if (regime.status === 'OK') return { health: 'HEALTHY', notes: [] };
  const providerNotes = Array.isArray(regime.inputs?.regimeNotes) ? regime.inputs?.regimeNotes ?? [] : [];
  const storedNotes = Array.isArray(regime.notes) ? (regime.notes as string[]) : [];
  return { health: 'DEGRADED', notes: [...providerNotes, ...storedNotes].slice(0, 3) };
}

/** Next top-of-hour tick strictly after `now` (hourly cron runs in UTC, wrangler.jsonc). */
function nextHourlyTick(now: Date): Date {
  const tick = new Date(now.getTime());
  tick.setUTCMinutes(0, 0, 0);
  tick.setUTCHours(tick.getUTCHours() + 1);
  return tick;
}

/** Components whose absence self-heals by waiting (history/provider gaps), vs token-side gaps. */
const WAIT_HEALABLE = new Set<string>(['accumulationAcceleration', 'marketRegime', 'relativeStrength']);

function tokenStatus(
  token: Awaited<ReturnType<MonitorDeps['watchlist']['listActive']>>[number],
  latest: Awaited<ReturnType<MonitorDeps['snapshots']['listRecent']>>[number] | null,
  nextTick: Date,
): TokenMonitoringStatus {
  const notes: string[] = [];
  if (!latest) {
    notes.push(
      'No snapshots yet — the first evaluation is expected INCOMPLETE: accumulation acceleration needs a prior snapshot at least ' +
        `${FEATURE_CONFIG_V0.accelerationMinLagHours}h old.`,
    );
    return {
      tokenId: token.id,
      tokenAddress: token.tokenAddress,
      chain: token.chain,
      symbol: token.symbol ?? null,
      currentState: token.currentState,
      lastObservedAt: token.lastObservedAt ?? null,
      lastScore: token.lastScore ?? null,
      lastEvaluationStatus: null,
      lastSignal: token.currentState,
      missingInputs: [],
      components: componentDiagnostics(null, []),
      accelerationReadyAt: null,
      scoreExpectedNext: 'UNKNOWN',
      notes,
    };
  }

  const missing = latest.missingInputs ?? [];
  const minLagMs = FEATURE_CONFIG_V0.accelerationMinLagHours * 3_600_000;

  // Acceleration readiness: a complete prior rate observation exists and will be
  // at least accelerationMinLagHours old at the next tick.
  let accelerationReadyAt: string | null = null;
  if (latest.metrics.netFlow24h != null && latest.metrics.totalSmartBalance != null) {
    accelerationReadyAt = new Date(Date.parse(latest.observedAt) + minLagMs).toISOString();
    notes.push(
      Date.parse(accelerationReadyAt) <= nextTick.getTime()
        ? `Accumulation acceleration will be available at the ${nextTick.toISOString()} tick (prior snapshot older than the ${FEATURE_CONFIG_V0.accelerationMinLagHours}h minimum lag).`
        : `Accumulation acceleration becomes available from ${accelerationReadyAt} (prior snapshot younger than the ${FEATURE_CONFIG_V0.accelerationMinLagHours}h minimum lag).`,
    );
  } else {
    notes.push('Prior snapshot lacks complete Smart Money rate metrics; acceleration cannot be derived from history yet.');
  }

  // Regime gaps are provider-side and recover on the next provider call; the
  // degradation is surfaced at provider level (regimeHealth), not held against
  // the token's next score. Only token-side gaps force scoreExpectedNext=DEGRADED.
  const regimeWasDegraded = regimeHealthFrom(latest.features).health === 'DEGRADED';
  if (regimeWasDegraded) {
    notes.push('Regime reference was degraded in the last cycle (provider-side; recovers on the next successful provider call).');
  }

  const stillMissingNext = missing.filter((component) => {
    if (component === 'accumulationAcceleration') {
      // Precisely computable: the prior rate observation must be at the minimum lag by the next tick.
      return !(accelerationReadyAt != null && Date.parse(accelerationReadyAt) <= nextTick.getTime());
    }
    return !WAIT_HEALABLE.has(component); // regime/relativeStrength recover on the next provider call
  });
  if (stillMissingNext.length > 0) {
    notes.push(`Next full score still blocked by: ${stillMissingNext.join(', ')}.`);
  }

  return {
    tokenId: token.id,
    tokenAddress: token.tokenAddress,
    chain: token.chain,
    symbol: token.symbol ?? null,
    currentState: token.currentState,
    lastObservedAt: latest.observedAt,
    lastScore: latest.score,
    lastEvaluationStatus: latest.evaluationStatus,
    lastSignal: latest.signal,
    missingInputs: missing,
    components: componentDiagnostics(latest.features, missing),
    accelerationReadyAt,
    scoreExpectedNext: stillMissingNext.length === 0 ? 'HEALTHY' : 'DEGRADED',
    notes,
  };
}

/**
 * Builds the full monitoring status. Read-only: every fact comes from the
 * watchlist + stored snapshots, never from a live provider call.
 */
export async function buildMonitoringStatus(deps: MonitorDeps, now: Date = deps.clock()): Promise<MonitoringStatus> {
  const nextTick = nextHourlyTick(now);
  const tokens = await deps.watchlist.listActive();

  const tokenStatuses: TokenMonitoringStatus[] = [];
  for (const token of tokens) {
    let latest = null;
    try {
      latest = (await deps.snapshots.listRecent(token.id, 1))[0] ?? null;
    } catch (error) {
      tokenStatuses.push(tokenStatus(token, null, nextTick));
      tokenStatuses[tokenStatuses.length - 1].notes.unshift(
        `Snapshot history unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    tokenStatuses.push(tokenStatus(token, latest, nextTick));
  }

  // Regime provider health from the newest stored marketRegime evidence overall.
  let regimeHealth: Health = 'UNKNOWN';
  let regimeNotes: string[] = [];
  for (const token of tokens) {
    try {
      const latest = (await deps.snapshots.listRecent(token.id, 1))[0] ?? null;
      if (!latest) continue;
      const derived = regimeHealthFrom(latest.features);
      if (derived.health === 'HEALTHY') {
        regimeHealth = 'HEALTHY';
        regimeNotes = [];
        break;
      }
      if (derived.health === 'DEGRADED' && regimeHealth !== 'HEALTHY') {
        regimeHealth = 'DEGRADED';
        regimeNotes = derived.notes;
      }
    } catch {
      // Already surfaced per token; the aggregate stays UNKNOWN/DEGRADED.
    }
  }

  return {
    generatedAt: now.toISOString(),
    nextTickAt: nextTick.toISOString(),
    cronSchedule: '0 * * * * (hourly; configured in wrangler.jsonc)',
    providers: {
      enrichment: deps.provider.providerName,
      market: 'dexscreener',
      regime: deps.marketReference ? 'market-reference' : null,
      regimeHealth,
      regimeNotes,
    },
    tokens: tokenStatuses,
  };
}

