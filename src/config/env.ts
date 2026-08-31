import { z } from 'zod';
import { SUPPORTED_CHAINS } from '../chains/types.js';

/**
 * Raw environment shape as supplied by the runtime. Cloudflare Workers pass
 * bindings/secrets as a flat Record<string, string | undefined>; local dev
 * scripts and the Node test suite pass a process.env-like object. Both fit.
 */
export type EnvSource = Record<string, string | undefined>;

const environmentSchema = z
  .object({
    /**
     * Alchemy key: multi-chain enrichment (EVM RPC + Prices API + Solana RPC).
     * This is the primary and only on-chain provider.
     */
    ALCHEMY_API_KEY: z.string().min(1),
    SUPABASE_URL: z.string().url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_CHAT_ID: z.string().optional(),
    /** Monitoring cadence for the worker (free-tier friendly; cached providers). */
    WATCHLIST_OBSERVATION_INTERVAL_MINUTES: z.coerce.number().int().positive().default(60),
    DEFAULT_CHAIN: z.enum(SUPPORTED_CHAINS).default('solana'),
    API_PORT: z.coerce.number().int().positive().default(3000),
  });

export type Environment = z.infer<typeof environmentSchema>;

export function loadTelegramConfig(source: EnvSource): {
  botToken: string;
  chatId?: string;
} {
  return z
    .object({
      TELEGRAM_BOT_TOKEN: z.string().min(1),
      TELEGRAM_CHAT_ID: z.string().optional(),
    })
    .transform(({ TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID }) => ({
      botToken: TELEGRAM_BOT_TOKEN,
      chatId: TELEGRAM_CHAT_ID,
    }))
    .parse(source);
}

function optionalKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function loadEnvironment(source: EnvSource): Environment {
  const normalized = {
    ...source,
    ALCHEMY_API_KEY: optionalKey(source.ALCHEMY_API_KEY) ?? optionalKey(source.Alchemy_API_KEY),
  };

  return environmentSchema.parse(normalized);
}

