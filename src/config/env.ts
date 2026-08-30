import 'dotenv/config';
import { z } from 'zod';
import { SUPPORTED_CHAINS } from '../chains/types.js';

const environmentSchema = z
  .object({
    /**
     * Optional Alchemy key: multi-chain enrichment (EVM RPC + Prices API +
     * Solana RPC). Provider-agnostic per AGENTS.md — never a domain dependency.
     */
    ALCHEMY_API_KEY: z.string().min(1).optional(),
    /** Optional Helius key: Solana holder census + bounded 30-day flow enrichment. */
    HELIUS_API_KEY: z.string().min(1).optional(),
    SUPABASE_URL: z.string().url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_CHAT_ID: z.string().optional(),
    /** Monitoring cadence for the worker (free-tier friendly; cached providers). */
    WATCHLIST_OBSERVATION_INTERVAL_MINUTES: z.coerce.number().int().positive().default(60),
    DEFAULT_CHAIN: z.enum(SUPPORTED_CHAINS).default('solana'),
    API_PORT: z.coerce.number().int().positive().default(3000),
  })
  .refine((value) => Boolean(value.ALCHEMY_API_KEY || value.HELIUS_API_KEY), {
    message:
      'At least one on-chain provider key is required: ALCHEMY_API_KEY (multi-chain) or HELIUS_API_KEY (Solana).',
  });

export type Environment = z.infer<typeof environmentSchema>;

export function loadTelegramConfig(source: NodeJS.ProcessEnv = process.env): {
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

export function loadEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  const normalized = {
    ...source,
    ALCHEMY_API_KEY: optionalKey(source.ALCHEMY_API_KEY) ?? optionalKey(source.Alchemy_API_KEY),
    HELIUS_API_KEY: optionalKey(source.HELIUS_API_KEY),
  } as NodeJS.ProcessEnv;

  return environmentSchema.parse(normalized);
}

