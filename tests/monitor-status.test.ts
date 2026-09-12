import { describe, expect, it, vi } from 'vitest';
import { buildMonitoringStatus, type MonitoringStatus, type TokenMonitoringStatus } from '../src/monitor/status.js';
import { FEATURE_CONFIG_V0 } from '../src/domain/config.js';
import type { MonitorDeps } from '../src/monitor/cycle.js';
import type { NewSnapshotRecord, SnapshotRecord, WatchlistToken } from '../src/store/types.js';

const NOW = new Date('2026-09-12T10:30:00Z'); // next hourly tick: 11:00Z

function watchToken(overrides: Partial<WatchlistToken> = {}): WatchlistToken {
  return {
    id: 'token-1',
    chain: 'solana',
    tokenAddress: 'MINT111111111111111111111111111111111111111',
    smartMoneyWallets: ['WALLET1'],
    status: 'ACTIVE',
    currentState: 'NEW',
    entryPrice: null,
    entryAt: null,
    entrySnapshotId: null,
    lastObservedAt: null,
    lastScore: null,
    formulaVersion: null,
    createdAt: '2026-09-12T09:00:00Z',
    ...overrides,
  };
}

function snapshot(overrides: Partial<NewSnapshotRecord> = {}): SnapshotRecord {
  return {
    id: 'snap-1',
    watchlistTokenId: 'token-1',
    chain: 'solana',
    tokenAddress: 'MINT111111111111111111111111111111111111111',
    observedAt: '2026-09-12T09:10:14Z',
    source: 'alchemy+dexscreener+coingecko',
    raw: {},
    features: {
      components: {
        smartMoneyAccumulation: { component: 'smartMoneyAccumulation', value: 50, status: 'OK', inputs: {}, notes: [] },
        accumulationAcceleration: {
          component: 'accumulationAcceleration', value: null, status: 'UNAVAILABLE', inputs: {},
          notes: ['No comparable prior snapshot within the lookback window and no complete 30-day baseline; acceleration withheld.'],
        },
        relativeStrength: { component: 'relativeStrength', value: null, status: 'UNAVAILABLE', inputs: {}, notes: [] },
        volumeConfirmation: { component: 'volumeConfirmation', value: 62.63, status: 'OK', inputs: {}, notes: [] },
        marketRegime: {
          component: 'marketRegime', value: null, status: 'UNAVAILABLE',
          inputs: { regimeNotes: ['CoinGecko unavailable: CoinGecko HTTP 403 for /coins/markets'] },
          notes: ['All regime reference inputs (BTC, chain-native, broad market) were unavailable.'],
        },
      },
    },
    metrics: { priceUsd: 0.0068, liquidityUsd: 866_662, volume24hUsd: 3_728_161, netFlow24h: 0, totalSmartBalance: 628_357.96 },
    formulaVersion: 'golden_formula_v0',
    formulaParams: {},
    score: null,
    evaluationStatus: 'INCOMPLETE',
    missingInputs: ['accumulationAcceleration', 'relativeStrength', 'marketRegime'],
    gateResults: [],
    gateVersion: 'risk_gates_v0',
    signal: 'NEW',
    signalChanged: false,
    createdAt: '2026-09-12T09:10:14Z',
    ...overrides,
  };
}

function deps(tokens: WatchlistToken[], snapshotsByToken: Record<string, SnapshotRecord[]>, clock = () => NOW): MonitorDeps {
  return {
    provider: { providerName: 'alchemy' } as MonitorDeps['provider'],
    dexscreener: {} as MonitorDeps['dexscreener'],
    coingecko: null,
    watchlist: {
      list: vi.fn(), listActive: vi.fn().mockResolvedValue(tokens),
      get: vi.fn(), findByChainAndAddress: vi.fn(), create: vi.fn(), setStatus: vi.fn(), updateMonitoringState: vi.fn(),
    },
    snapshots: {
      insert: vi.fn(),
      listRecent: vi.fn().mockImplementation((tokenId: string) => Promise.resolve(snapshotsByToken[tokenId] ?? [])),
    },
    signals: { insert: vi.fn(), listRecent: vi.fn() },
    outcomes: { insert: vi.fn(), listByToken: vi.fn(), update: vi.fn(), listPending: vi.fn() },
    alerting: null,
    clock,
    persist: false,
  } as unknown as MonitorDeps;
}

describe('buildMonitoringStatus', () => {
  it('reports regime DEGRADED with provider notes and acceleration readiness for the 403-recovery scenario', async () => {
    const token = watchToken();
    const status: MonitoringStatus = await buildMonitoringStatus(deps([token], { 'token-1': [snapshot()] }), NOW);

    expect(status.nextTickAt).toBe('2026-09-12T11:00:00.000Z');
    expect(status.providers.regimeHealth).toBe('DEGRADED');
    expect(status.providers.regimeNotes[0]).toContain('403');

    const entry: TokenMonitoringStatus = status.tokens[0];
    expect(entry.lastEvaluationStatus).toBe('INCOMPLETE');
    expect(entry.missingInputs).toEqual(['accumulationAcceleration', 'relativeStrength', 'marketRegime']);
    // accelerationReadyAt = observedAt + min lag (1h); 10:10Z < 11:00Z tick -> ready next tick.
    expect(entry.accelerationReadyAt).toBe('2026-09-12T10:10:14.000Z');
    expect(entry.scoreExpectedNext).toBe('HEALTHY');
    expect(entry.notes.join(' ')).toContain('available at the 2026-09-12T11:00:00.000Z tick');

    const regime = entry.components.find((component) => component.component === 'marketRegime');
    expect(regime?.status).toBe('UNAVAILABLE');
    expect(regime?.notes[0]).toContain('403');
  });

  it('reports score NOT expected next when the prior snapshot is younger than the acceleration minimum lag', async () => {
    const token = watchToken({ id: 'token-2' });
    const fresh = snapshot({
      watchlistTokenId: 'token-2',
      observedAt: '2026-09-12T10:20:00Z', // ready 11:20Z > next tick 11:00Z
    });
    const status = await buildMonitoringStatus(deps([token], { 'token-2': [fresh] }), NOW);
    const entry = status.tokens[0];

    expect(entry.accelerationReadyAt).toBe('2026-09-12T11:20:00.000Z');
    expect(entry.scoreExpectedNext).toBe('DEGRADED');
    expect(entry.notes.join(' ')).toContain(FEATURE_CONFIG_V0.accelerationMinLagHours + 'h minimum lag');
  });

  it('reports UNKNOWN for a token without snapshots (expected first-evaluation INCOMPLETE)', async () => {
    const token = watchToken({ id: 'token-3' });
    const status = await buildMonitoringStatus(deps([token], {}), NOW);

    const entry = status.tokens[0];
    expect(entry.lastEvaluationStatus).toBeNull();
    expect(entry.scoreExpectedNext).toBe('UNKNOWN');
    expect(entry.notes[0]).toContain('first evaluation is expected INCOMPLETE');
  });
});


