/**
 * Soren Cloudflare Worker — scheduled monitoring plus a minimal HTTP API.
 *
 * The Cron Trigger configured in wrangler.jsonc invokes `scheduled`, which
 * runs one monitoring cycle over the ACTIVE watchlist: observation -> features
 * -> Golden Formula score -> risk gates -> state transition -> immutable
 * snapshot -> Telegram alert on real state changes -> triple-barrier outcome
 * update. Provider usage is bounded and cached (AGENTS.md Cost Control).
 *
 * `fetch` serves health/status plus the watchlist HTTP API, so a single
 * Worker replaces both the old scheduled worker and the Fastify API.
 *
 * The Worker is stateless: every invocation rebuilds MonitorDeps from the
 * `env` bindings. Nothing persists between invocations except the Supabase
 * rows the cycle writes.
 */
import { getDefaultChain } from '../chains/registry.js';
import { MonitorRunner, TokenMonitor } from '../monitor/cycle.js';
import { buildMonitorRuntime } from '../monitor/runtime.js';
import { renderAppPage, renderWatchDetailPage } from '../research/ui.js';
import { validateWatchlistInput } from '../research/input.js';
import type { WatchlistToken } from '../store/types.js';
import type { EnvSource } from '../config/env.js';

export interface WorkerEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ALCHEMY_API_KEY?: string;
  Alchemy_API_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  DEFAULT_CHAIN?: string;
}

function toEnvSource(env: WorkerEnv): EnvSource {
  return env as unknown as EnvSource;
}

async function runMonitoringCycle(env: WorkerEnv): Promise<void> {
  const { deps, environment } = buildMonitorRuntime(toEnvSource(env));
  const runner = new MonitorRunner(deps);
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
      state: `${result.previousState}->${result.state}`,
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
  console.log(JSON.stringify({
    status: 'ready',
    service: 'soren-worker',
    providers: {
      enrichment: deps.provider.providerName,
      market: 'dexscreener',
      regime: deps.coingecko ? 'coingecko' : null,
    },
    defaultChain: environment.DEFAULT_CHAIN,
    telegramConfigured: Boolean(environment.TELEGRAM_BOT_TOKEN && environment.TELEGRAM_CHAT_ID),
  }));
}

interface ScheduledEvent {
  cron: string;
  scheduledTime: number;
}

export async function scheduled(event: ScheduledEvent, env: WorkerEnv): Promise<void> {
  try {
    await runMonitoringCycle(env);
  } catch (error) {
    console.error(JSON.stringify({
      event: 'monitor_cycle_failed',
      cron: event.cron,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

const limitSchema = {
  parse(value: string | undefined | null): number {
    const n = Number(value && value.trim() !== '' ? value : '10');
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 100) : 10;
  },
};

async function loadTokenOr404(deps: ReturnType<typeof buildMonitorRuntime>['deps'], id: string) {
  return (await deps.watchlist.get(id)) ?? null;
}

async function handleApi(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const { deps, environment } = buildMonitorRuntime(toEnvSource(env));
  const monitor = new TokenMonitor(deps);
  const path = url.pathname;
  const method = request.method;

  if (path === '/health' && method === 'GET') {
    return json({ status: 'ok', service: 'soren-worker' });
  }
  if (path === '/status' && method === 'GET') {
    let watchlistCount: number | null = null;
    try {
      watchlistCount = (await deps.watchlist.list()).length;
    } catch {
      watchlistCount = null;
    }
    return json({
      api: { status: 'ok', service: 'soren-worker' },
      providers: { enrichment: deps.provider.providerName, market: 'dexscreener', regime: deps.coingecko ? 'coingecko' : null },
      defaultChain: getDefaultChain(),
      telegramConfigured: Boolean(environment.TELEGRAM_BOT_TOKEN && environment.TELEGRAM_CHAT_ID),
      watchlistObservationIntervalMinutes: environment.WATCHLIST_OBSERVATION_INTERVAL_MINUTES,
      watchlistCount,
    });
  }
  if (path === '/watchlist' && method === 'POST') {
    const input = validateWatchlistInput(await request.json().catch(() => null));
    const existing = await deps.watchlist.findByChainAndAddress(input.chain, input.tokenAddress);
    if (existing) {
      return json({ status: 'exists', token: existing, note: 'Token is already on the watchlist (added once, monitored continuously).' });
    }
    const token = await deps.watchlist.create({ chain: input.chain, tokenAddress: input.tokenAddress, smartMoneyWallets: input.smartMoneyWallets });
    return json({ status: 'created', token }, 201);
  }
  if (path === '/watchlist' && method === 'GET') {
    const tokens = await deps.watchlist.list();
    return json({ count: tokens.length, tokens: tokens.map((t) => ({ id: t.id, chain: t.chain, tokenAddress: t.tokenAddress, status: t.status, currentState: t.currentState, lastObservedAt: t.lastObservedAt, lastScore: t.lastScore, formulaVersion: t.formulaVersion, createdAt: t.createdAt })) });
  }
  if (path === '/evaluate' && method === 'POST') {
    const input = validateWatchlistInput(await request.json().catch(() => null));
    const existing = await deps.watchlist.findByChainAndAddress(input.chain, input.tokenAddress);
    const entry: WatchlistToken = existing ?? {
      id: crypto.randomUUID(), chain: input.chain, tokenAddress: input.tokenAddress, smartMoneyWallets: input.smartMoneyWallets,
      status: 'ACTIVE', currentState: 'NEW', entryPrice: null, entryAt: null, entrySnapshotId: null,
      lastObservedAt: null, lastScore: null, formulaVersion: null, createdAt: new Date().toISOString(),
    };
    const result = await new TokenMonitor({ ...deps, persist: false }).evaluate(entry);
    return json({ status: result.status === 'FAILED' ? 502 : 200, result });
  }
  if ((path === '/' || path === '/research') && method === 'GET') {
    return html(renderAppPage());
  }
  if (path === '/run' && method === 'GET') {
    await runMonitoringCycle(env);
    return json({ status: 'ran', note: 'monitoring cycle executed; inspect Worker logs.' });
  }

  const watchlistMatch = path.match(/^\/watchlist\/([^/]+)$/);
  if (watchlistMatch && method === 'GET') {
    const token = await loadTokenOr404(deps, watchlistMatch[1]);
    if (!token) return json({ error: 'watchlist_token_not_found' }, 404);
    return json({ token });
  }
  if (watchlistMatch && method === 'DELETE') {
    const token = await loadTokenOr404(deps, watchlistMatch[1]);
    if (!token) return json({ error: 'watchlist_token_not_found' }, 404);
    await deps.watchlist.setStatus(watchlistMatch[1], 'PAUSED');
    return json({ status: 'PAUSED', note: 'Token paused; snapshot history preserved.' });
  }

  const snapshotsMatch = path.match(/^\/watchlist\/([^/]+)\/snapshots$/);
  if (snapshotsMatch && method === 'GET') {
    const token = await loadTokenOr404(deps, snapshotsMatch[1]);
    if (!token) return json({ error: 'watchlist_token_not_found' }, 404);
    const limit = limitSchema.parse(url.searchParams.get('limit'));
    const snapshots = await deps.snapshots.listRecent(token.id, limit);
    return json({ token: { id: token.id, chain: token.chain, tokenAddress: token.tokenAddress }, snapshots });
  }

  const signalsMatch = path.match(/^\/watchlist\/([^/]+)\/signals$/);
  if (signalsMatch && method === 'GET') {
    const token = await loadTokenOr404(deps, signalsMatch[1]);
    if (!token) return json({ error: 'watchlist_token_not_found' }, 404);
    const limit = limitSchema.parse(url.searchParams.get('limit'));
    return json({ signals: await deps.signals.listRecent(token.id, limit) });
  }

  const outcomesMatch = path.match(/^\/watchlist\/([^/]+)\/outcomes$/);
  if (outcomesMatch && method === 'GET') {
    const token = await loadTokenOr404(deps, outcomesMatch[1]);
    if (!token) return json({ error: 'watchlist_token_not_found' }, 404);
    const limit = limitSchema.parse(url.searchParams.get('limit'));
    return json({ outcomes: await deps.outcomes.listByToken(token.id, limit) });
  }

  const evaluateMatch = path.match(/^\/watchlist\/([^/]+)\/evaluate$/);
  if (evaluateMatch && method === 'POST') {
    const token = await loadTokenOr404(deps, evaluateMatch[1]);
    if (!token) return json({ error: 'watchlist_token_not_found' }, 404);
    const result = await monitor.evaluate({ ...token, status: token.status ?? 'ACTIVE' });
    return json({ status: result.status === 'FAILED' ? 502 : 200, result });
  }

  const viewMatch = path.match(/^\/watchlist\/([^/]+)\/view$/);
  if (viewMatch && method === 'GET') {
    const token = await loadTokenOr404(deps, viewMatch[1]);
    if (!token) return json({ error: 'watchlist_token_not_found' }, 404);
    return html(renderWatchDetailPage(token));
  }

  return json({ error: 'not_found', path, method }, 404);
}

export async function fetch(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  try {
    return await handleApi(request, env, url);
  } catch (error) {
    console.error(JSON.stringify({ event: 'request_failed', path: url.pathname, method: request.method, error: error instanceof Error ? error.message : String(error) }));
    return json({ error: 'internal_error' }, 500);
  }
}

export default { fetch, scheduled };
