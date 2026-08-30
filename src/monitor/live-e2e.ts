/**
 * Live end-to-end validation against the real Supabase project and providers.
 * Adds the JUP token to the watchlist, runs one persisted evaluation cycle,
 * verifies the immutable snapshot + signal rows, then pauses the token to
 * leave the system clean. Run: npx tsx src/monitor/live-e2e.ts
 */
import { buildMonitorRuntime } from './runtime.js';
import { TokenMonitor } from './cycle.js';
import type { WatchlistToken } from '../store/types.js';

const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const WALLET_A = '86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY';
const WALLET_B = 'BhZRhq7AhE4LPnZP1hvDvpC5pSQtGN8kGGV5E1NQkRaj';
const WALLET_C = '3QJ3a1fA4zC5k2yq8LwZ9v4K4gkL3dF2hM5U7QwZkNQ4';

async function main(): Promise<void> {
  const { deps } = buildMonitorRuntime();

  let token: WatchlistToken | null = await deps.watchlist.findByChainAndAddress('solana', JUP_MINT);
  if (!token) {
    token = await deps.watchlist.create({
      chain: 'solana',
      tokenAddress: JUP_MINT,
      smartMoneyWallets: [WALLET_A, WALLET_B, WALLET_C],
    });
    console.log('[e2e] watchlist row created:', token.id);
  } else {
    console.log('[e2e] watchlist row already exists:', token.id);
  }
  await deps.watchlist.setStatus(token.id, 'ACTIVE');

  const monitor = new TokenMonitor(deps); // persist: true from runtime
  const result = await monitor.evaluate({ ...token, status: 'ACTIVE' });

  console.log('[e2e] evaluation:', JSON.stringify({
    status: result.status,
    symbol: result.symbol,
    score: result.score,
    interpretation: result.interpretation,
    missing: result.missing,
    gatesVerdict: result.gatesVerdict,
    state: `${result.previousState} -> ${result.state}`,
    stateChanged: result.stateChanged,
    snapshotId: result.snapshotId,
  }, null, 2));

  const [latest] = await deps.snapshots.listRecent(token.id, 1);
  if (!latest) throw new Error('expected an immutable market_snapshots row');
  console.log('[e2e] persisted snapshot:', JSON.stringify({
    id: latest.id,
    observedAt: latest.observedAt,
    source: latest.source,
    score: latest.score,
    evaluationStatus: latest.evaluationStatus,
    signal: latest.signal,
    signalChanged: latest.signalChanged,
    priceUsd: latest.metrics.priceUsd,
    liquidityUsd: latest.metrics.liquidityUsd,
    volume24hUsd: latest.metrics.volume24hUsd,
    formulaVersion: latest.formulaVersion,
    gateVersion: latest.gateVersion,
    missingInputs: latest.missingInputs,
    components: Object.keys((latest.features as { components?: unknown })?.components ?? {}),
  }, null, 2));

  const signals = await deps.signals.listRecent(token.id, 10);
  console.log('[e2e] signal events:', JSON.stringify(signals.map((s) => ({
    from: s.fromState, to: s.toState, score: s.score, reason: (s.evidence ?? {}).reason,
  })), null, 2));

  // Leave the system clean: pause monitoring for this test token.
  await deps.watchlist.setStatus(token.id, 'PAUSED');
  console.log('[e2e] token paused — monitoring disabled; snapshots preserved.');
}

main().catch((error) => {
  console.error('[e2e] FAILED:', error);
  process.exitCode = 1;
});