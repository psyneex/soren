/**
 * Composition root for the monitoring phase: wires providers, repositories,
 * Telegram alerting, and the clock into the MonitorDeps used by the HTTP
 * handler and the scheduled worker. Business logic stays in the
 * domain/monitor modules; this file only assembles infrastructure.
 *
 * The environment is always injected by the caller — the Cloudflare Worker
 * passes its `env` bindings/secrets, local dev scripts pass `process.env` —
 * so this module never reads a global itself (Worker-compatible).
 */
import { loadEnvironment, loadTelegramConfig, type EnvSource } from '../config/env.js';
import { createDatabaseClient } from '../database/client.js';
import { TtlCache } from '../providers/cache.js';
import { CoinGeckoClient } from '../providers/coingecko.js';
import { DexScreenerClient } from '../providers/dexscreener.js';
import { createEnrichmentGateway } from '../providers/monitor-provider.js';
import {
  SupabaseOutcomeRepository,
  SupabaseSignalEventRepository,
  SupabaseSnapshotRepository,
  SupabaseSystemRunsRepository,
  SupabaseWatchlistRepository,
} from '../store/supabase.js';
import { TelegramAlerting } from '../telegram/alerting.js';
import { TelegramClient } from '../telegram/client.js';
import { SupabaseNotificationStore } from '../telegram/supabase-store.js';
import { TelegramSignalAlerter } from '../telegram/signal-alerter.js';
import type { SignalAlerter, MonitorDeps } from './cycle.js';
import type { Environment } from '../config/env.js';

export interface MonitorRuntime {
  deps: MonitorDeps;
  environment: Environment;
}

export function buildMonitorRuntime(env: EnvSource, clock: () => Date = () => new Date()): MonitorRuntime {
  const environment = loadEnvironment(env);
  const db = createDatabaseClient(environment.SUPABASE_URL, environment.SUPABASE_SERVICE_ROLE_KEY);

  const provider = createEnrichmentGateway({
    alchemyApiKey: environment.ALCHEMY_API_KEY,
    heliusApiKey: environment.HELIUS_API_KEY,
  });
  const cache = new TtlCache();
  const dexscreener = new DexScreenerClient({ cache });
  const coingecko = new CoinGeckoClient({ cache });

  let alerting: SignalAlerter | null = null;
  if (environment.TELEGRAM_BOT_TOKEN && environment.TELEGRAM_CHAT_ID) {
    const telegram = loadTelegramConfig(env);
    const client = new TelegramClient({ botToken: telegram.botToken });
    const store = new SupabaseNotificationStore(db, telegram.chatId as string);
    alerting = new TelegramSignalAlerter(new TelegramAlerting(client, telegram.chatId as string, store));
  }

  const deps: MonitorDeps = {
    provider,
    dexscreener,
    coingecko,
    watchlist: new SupabaseWatchlistRepository(db),
    snapshots: new SupabaseSnapshotRepository(db),
    signals: new SupabaseSignalEventRepository(db),
    outcomes: new SupabaseOutcomeRepository(db),
    runs: new SupabaseSystemRunsRepository(db),
    alerting,
    clock,
    persist: true,
  };

  return { deps, environment };
}
