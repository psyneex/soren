/**
 * Soren monitoring API.
 *
 * The user enters only a token address and up to three Smart Money wallets
 * (AGENTS.md Manual Input Contract). The API manages the persistent watchlist
 * and exposes snapshots, signal events, and triple-barrier outcomes; all
 * scoring logic lives in the domain/monitor modules (no hidden business logic
 * in the UI or the HTTP layer).
 */
import Fastify from 'fastify';
import { z } from 'zod';
import { getDefaultChain } from '../chains/registry.js';
import { TokenMonitor } from '../monitor/cycle.js';
import { buildMonitorRuntime } from '../monitor/runtime.js';
import { renderAppPage, renderWatchDetailPage } from '../research/ui.js';
import { validateWatchlistInput } from '../research/input.js';
import type { WatchlistToken } from '../store/types.js';

const { deps, environment } = buildMonitorRuntime();
const app = Fastify({ logger: true });
const monitor = new TokenMonitor(deps);

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof z.ZodError) {
    return reply.code(400).send({ error: 'validation_failed', issues: error.issues });
  }
  const statusCode = (error as { statusCode?: number }).statusCode;
  if (statusCode && statusCode < 500) {
    return reply.code(statusCode).send({ error: (error as Error).message });
  }
  app.log.error(error);
  return reply.code(500).send({ error: (error as Error).message ?? 'internal_error' });
});

app.get('/health', async () => ({ status: 'ok', service: 'soren-api' }));

app.get('/status', async () => {
  let watchlistCount: number | null = null;
  try {
    watchlistCount = (await deps.watchlist.list()).length;
  } catch {
    watchlistCount = null;
  }
  return {
    api: { status: 'ok', service: 'soren-api' },
    providers: {
      enrichment: deps.provider.providerName,
      market: 'dexscreener',
      regime: deps.coingecko ? 'coingecko' : null,
    },
    defaultChain: getDefaultChain(),
    telegramConfigured: Boolean(environment.TELEGRAM_BOT_TOKEN && environment.TELEGRAM_CHAT_ID),
    watchlistObservationIntervalMinutes: environment.WATCHLIST_OBSERVATION_INTERVAL_MINUTES,
    watchlistCount,
  };
});

app.get('/', async (_request, reply) => {
  reply.type('text/html');
  return renderAppPage();
});

app.get('/research', async (_request, reply) => {
  reply.type('text/html');
  return renderAppPage();
});

// ---------------------------------------------------------------------------
// Watchlist management
// ---------------------------------------------------------------------------

app.post('/watchlist', async (request, reply) => {
  const input = validateWatchlistInput(request.body as unknown);
  const existing = await deps.watchlist.findByChainAndAddress(input.chain, input.tokenAddress);
  if (existing) {
    return reply.code(200).send({
      status: 'exists',
      token: existing,
      note: 'Token is already on the watchlist (added once, monitored continuously).',
    });
  }
  const token = await deps.watchlist.create({
    chain: input.chain,
    tokenAddress: input.tokenAddress,
    smartMoneyWallets: input.smartMoneyWallets,
  });
  return reply.code(201).send({ status: 'created', token });
});

app.get('/watchlist', async () => {
  const tokens = await deps.watchlist.list();
  const withLatest = await Promise.all(
    tokens.map(async (token) => {
      const [latest] = await deps.snapshots.listRecent(token.id, 1);
      const raw = latest?.raw as { enrichment?: { metadata?: { symbol?: string } } } | undefined;
      const symbol = raw?.enrichment?.metadata?.symbol ?? null;
      return {
        ...token,
        symbol: token.symbol ?? symbol,
        latestSnapshot: latest
          ? {
              id: latest.id,
              observedAt: latest.observedAt,
              score: latest.score,
              evaluationStatus: latest.evaluationStatus,
              missingInputs: latest.missingInputs,
              signal: latest.signal,
              gateVersion: latest.gateVersion,
              priceUsd: latest.metrics.priceUsd,
            }
          : null,
      };
    }),
  );
  return { tokens: withLatest };
});

async function loadTokenOr404(id: string): Promise<WatchlistToken | null> {
  return deps.watchlist.get(id);
}

app.get('/watchlist/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  const token = await loadTokenOr404(id);
  if (!token) return reply.code(404).send({ error: 'watchlist_token_not_found' });
  const [snapshots, signals, outcomes] = await Promise.all([
    deps.snapshots.listRecent(token.id, 50),
    deps.signals.listRecent(token.id, 50),
    deps.outcomes.listByToken(token.id, 50),
  ]);
  return { token, snapshots, signals, outcomes };
});

const statusPatchSchema = z.object({ status: z.enum(['ACTIVE', 'PAUSED']) });

app.patch('/watchlist/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  const token = await loadTokenOr404(id);
  if (!token) return reply.code(404).send({ error: 'watchlist_token_not_found' });
  const { status } = statusPatchSchema.parse(request.body as unknown);
  await deps.watchlist.setStatus(id, status);
  return { status };

// ---------------------------------------------------------------------------
// History and outcomes
// ---------------------------------------------------------------------------

const limitSchema = z.coerce.number().int().min(1).max(200).default(50);

app.get('/watchlist/:id/snapshots', async (request, reply) => {
  const { id } = request.params as { id: string };
  const token = await loadTokenOr404(id);
  if (!token) return reply.code(404).send({ error: 'watchlist_token_not_found' });
  const limit = limitSchema.parse((request.query as { limit?: string }).limit);
  const snapshots = await deps.snapshots.listRecent(token.id, limit);
  return { token: { id: token.id, chain: token.chain, tokenAddress: token.tokenAddress }, snapshots };
});

app.get('/watchlist/:id/signals', async (request, reply) => {
  const { id } = request.params as { id: string };
  const token = await loadTokenOr404(id);
  if (!token) return reply.code(404).send({ error: 'watchlist_token_not_found' });
  const limit = limitSchema.parse((request.query as { limit?: string }).limit);
  return { signals: await deps.signals.listRecent(token.id, limit) };
});

app.get('/watchlist/:id/outcomes', async (request, reply) => {
  const { id } = request.params as { id: string };
  const token = await loadTokenOr404(id);
  if (!token) return reply.code(404).send({ error: 'watchlist_token_not_found' });
  const limit = limitSchema.parse((request.query as { limit?: string }).limit);
  return { outcomes: await deps.outcomes.listByToken(token.id, limit) };
});

// ---------------------------------------------------------------------------
// Evaluations
// ---------------------------------------------------------------------------

app.post('/watchlist/:id/evaluate', async (request, reply) => {
  const { id } = request.params as { id: string };
  const token = await loadTokenOr404(id);
  if (!token) return reply.code(404).send({ error: 'watchlist_token_not_found' });
  const result = await monitor.evaluate(token);
  return { status: result.status === 'FAILED' ? 502 : 200, result };
});

/**
 * Ephemeral preview: full evaluation pipeline (observation → features → score →
 * gates → state transition) without persisting anything. Uses stored history
 * and state when the token is already on the watchlist.
 */
app.post('/evaluate', async (request) => {
  const input = validateWatchlistInput(request.body as unknown);
  const existing = await deps.watchlist.findByChainAndAddress(input.chain, input.tokenAddress);
  const entry: WatchlistToken =
    existing ?? {
      id: 'preview',
      chain: input.chain,
      tokenAddress: input.tokenAddress,
      smartMoneyWallets: input.smartMoneyWallets,
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
  const previewMonitor = new TokenMonitor({ ...deps, persist: false });
  return previewMonitor.evaluate(entry);
});

app.get('/watchlist/:id/view', async (request, reply) => {
  const { id } = request.params as { id: string };
  const token = await loadTokenOr404(id);
  if (!token) return reply.code(404).send({ error: 'watchlist_token_not_found' });
  reply.type('text/html');
  return renderWatchDetailPage(token);
});

await app.listen({ host: '127.0.0.1', port: environment.API_PORT });

});

app.delete('/watchlist/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  const token = await loadTokenOr404(id);
  if (!token) return reply.code(404).send({ error: 'watchlist_token_not_found' });
  // Soft pause: historical snapshots are research data and are never deleted.
  await deps.watchlist.setStatus(id, 'PAUSED');
  return { status: 'PAUSED', note: 'Token paused; snapshot history preserved.' };
});
