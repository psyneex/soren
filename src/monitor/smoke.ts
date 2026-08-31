/**
 * Live smoke test — exercises the full monitoring pipeline against real
 * providers WITHOUT persisting anything. Run: npx tsx src/monitor/smoke.ts
 *
 * Reads configuration from the environment (env vars or a .env file loaded by
 * tsx --env-file). No Cloudflare-specific APIs are used, so this runs anywhere
 * the Supabase and provider keys are set.
 */
import { buildMonitorRuntime } from './runtime.js';
import { TokenMonitor } from './cycle.js';
import type { WatchlistToken } from '../store/types.js';

const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const WALLET_A = '86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY';
const WALLET_B = 'BhZRhq7AhE4LPnZP1hvDvpC5pSQtGN8kGGV5E1NQkRaj';
const WALLET_C = '3QJ3a1fA4zC5k2yq8LwZ9v4K4gkL3dF2hM5U7QwZkNQ4';
// Valid UUID shape so the preview history query types are accepted by PostgREST.
const PREVIEW_ID = '00000000-0000-4000-8000-000000000001';

async function main(): Promise<void> {
  const { deps } = buildMonitorRuntime(process.env);
  console.log('[smoke] provider:', deps.provider.providerName, 'telegram:', deps.alerting ? 'yes' : 'no');

  const entry: WatchlistToken = {
    id: PREVIEW_ID,
    chain: 'solana',
    tokenAddress: JUP_MINT,
    smartMoneyWallets: [WALLET_A, WALLET_B, WALLET_C],
    status: 'ACTIVE',
    currentState: 'NEW',
    entryPrice: null,
    entryAt: null,
    entrySnapshotId: null,
    lastObservedAt: null,
    lastScore: null,
    formulaVersion: null,
    createdAt: new Date().toISOString(),
  };

  const monitor = new TokenMonitor({ ...deps, persist: false, clock: () => new Date() });
  const result = await monitor.evaluate(entry);

  console.log(JSON.stringify({
    status: result.status,
    symbol: result.symbol,
    score: result.score,
    interpretation: result.interpretation,
    missing: result.missing,
    gatesVerdict: result.gatesVerdict,
    state: `${result.previousState} -> ${result.state}`,
    notes: result.notes.slice(0, 12),
  }, null, 2));
}

main().catch((error) => {
  console.error('[smoke] FAILED:', error);
  process.exitCode = 1;
});