/**
 * Manual input contract (AGENTS.md Manual Input Contract).
 *
 * The user provides ONLY a token address and up to three Smart Money wallet
 * addresses (smartMoneyWallet1..3 in the UI; a programmatic `smartMoneyWallets`
 * array is also accepted). No manual numeric market data exists anywhere in
 * the system: price, market cap, FDV, liquidity, volume, age, holders, flows,
 * balances and activity are all retrieved or calculated automatically.
 *
 * Human-readable compact values remain supported wherever a provider returns
 * them, but the scoring pipeline itself consumes normalized numbers only.
 */
import { z } from 'zod';
import { SUPPORTED_CHAINS } from '../chains/types.js';
import { assertSupportedChain, getChainKind, isValidAddress } from '../chains/registry.js';

const trimString = (value: unknown): unknown =>
  typeof value === 'string' ? value.trim() : value;

const emptyToUndefined = (value: unknown): unknown =>
  value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
    ? undefined
    : value;

const walletAddress = z.preprocess(emptyToUndefined, z.string().optional());

export const WatchlistInputSchema = z
  .object({
    chain: z
      .preprocess(
        (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
        z.enum(SUPPORTED_CHAINS),
      )
      .default('solana'),
    tokenAddress: z.preprocess(trimString, z.string().min(1, 'Token address is required.')),
    smartMoneyWallet1: walletAddress,
    smartMoneyWallet2: walletAddress,
    smartMoneyWallet3: walletAddress,
    /** Alternative programmatic form: comma-separated string or array, 1–3 wallets. */
    smartMoneyWallets: z.union([z.string(), z.array(z.unknown())]).optional(),
  })
  .transform((value) => {
    let wallets: string[];
    if (value.smartMoneyWallets !== undefined) {
      const raw =
        typeof value.smartMoneyWallets === 'string'
          ? value.smartMoneyWallets.split(',')
          : value.smartMoneyWallets;
      wallets = raw.map((wallet) => String(wallet).trim()).filter(Boolean);
    } else {
      wallets = [value.smartMoneyWallet1, value.smartMoneyWallet2, value.smartMoneyWallet3].filter(
        (wallet): wallet is string => typeof wallet === 'string',
      );
    }
    return { chain: value.chain, tokenAddress: value.tokenAddress, smartMoneyWallets: wallets };
  })
  .superRefine((value, ctx) => {
    try {
      assertSupportedChain(value.chain);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['chain'],
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (!isValidAddress(value.tokenAddress, value.chain)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tokenAddress'],
        message: 'Token address is not valid for the selected chain.',
      });
    }

    if (value.smartMoneyWallets.length < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['smartMoneyWallet1'],
        message: 'At least one Smart Money wallet address is required.',
      });
    }
    if (value.smartMoneyWallets.length > 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['smartMoneyWallets'],
        message: 'At most three Smart Money wallet addresses are supported.',
      });
    }

    value.smartMoneyWallets.forEach((wallet, index) => {
      if (!isValidAddress(wallet, value.chain)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['smartMoneyWallets', index],
          message: 'All Smart Money wallet addresses must be valid for the selected chain.',
        });
      }
    });

    const exact = new Set(value.smartMoneyWallets);
    const comparable = new Set(
      value.smartMoneyWallets.map((wallet) =>
        getChainKind(value.chain) === 'evm' ? wallet.toLowerCase() : wallet,
      ),
    );
    if (exact.size !== value.smartMoneyWallets.length || comparable.size !== value.smartMoneyWallets.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['smartMoneyWallets'],
        message: 'Smart Money wallet addresses must be unique.',
      });
    }
  });

export interface WatchlistInput {
  chain: z.infer<typeof WatchlistInputSchema>['chain'];
  tokenAddress: string;
  smartMoneyWallets: string[];
}

export function validateWatchlistInput(input: unknown): WatchlistInput {
  const parsed = WatchlistInputSchema.parse(input);
  return {
    chain: parsed.chain,
    tokenAddress: parsed.tokenAddress,
    smartMoneyWallets: parsed.smartMoneyWallets,
  };
}
