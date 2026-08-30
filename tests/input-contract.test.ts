import { describe, expect, it } from 'vitest';
import { validateWatchlistInput } from '../src/research/input.js';

const SOL_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const SOL_WALLET_1 = '3QJ3a1fA4zC5k2yq8LwZ9v4K4gkL3dF2hM5U7QwZkNQ4';
const SOL_WALLET_2 = '86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY';
const SOL_WALLET_3 = 'BhZRhq7AhE4LPnZP1hvDvpC5pSQtGN8kGGV5E1NQkRaj';
const EVM_TOKEN = '0x1234567890123456789012345678901234567890';
const EVM_WALLET = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

describe('Watchlist manual input contract', () => {
  it('accepts exactly token + 1..3 smart money wallets (no numeric market fields)', () => {
    const input = validateWatchlistInput({
      chain: 'solana',
      tokenAddress: SOL_MINT,
      smartMoneyWallet1: SOL_WALLET_1,
      smartMoneyWallet2: SOL_WALLET_2,
      smartMoneyWallet3: SOL_WALLET_3,
    });
    expect(input).toEqual({
      chain: 'solana',
      tokenAddress: SOL_MINT,
      smartMoneyWallets: [SOL_WALLET_1, SOL_WALLET_2, SOL_WALLET_3],
    });
  });

  it('accepts omitted optional wallets and defaults the chain to solana', () => {
    const input = validateWatchlistInput({
      tokenAddress: SOL_MINT,
      smartMoneyWallet1: SOL_WALLET_1,
    });
    expect(input.chain).toBe('solana');
    expect(input.smartMoneyWallets).toEqual([SOL_WALLET_1]);
  });

  it('accepts wallet1..wallet3 mailbox-style (the UI contract)', () => {
    const input = validateWatchlistInput({
      chain: 'ethereum',
      tokenAddress: EVM_TOKEN,
      smartMoneyWallet1: EVM_WALLET,
    });
    expect(input.smartMoneyWallets).toEqual([EVM_WALLET]);
  });

  it('accepts an explicit smartMoneyWallets array (programmatic contract)', () => {
    const input = validateWatchlistInput({
      chain: 'solana',
      tokenAddress: SOL_MINT,
      smartMoneyWallets: [SOL_WALLET_1, SOL_WALLET_2],
    });
    expect(input.smartMoneyWallets).toHaveLength(2);
  });

  it('rejects zero wallets', () => {
    expect(() =>
      validateWatchlistInput({ chain: 'solana', tokenAddress: SOL_MINT }),
    ).toThrow(/smart money wallet/i);
  });

  it('rejects more than three wallets', () => {
    const extra = 'APuwVwXgvTB6GxF6Wz1kA2N9fJz8b6b5b5b5b5b5b5b5b5b5b5b5b5b5b5';
    expect(() =>
      validateWatchlistInput({
        chain: 'solana',
        tokenAddress: SOL_MINT,
        smartMoneyWallet1: SOL_WALLET_1,
        smartMoneyWallet2: SOL_WALLET_2,
        smartMoneyWallet3: SOL_WALLET_3,
        smartMoneyWallets: [SOL_WALLET_1, SOL_WALLET_2, SOL_WALLET_3, extra],
      }),
    ).toThrow(/three/i);
  });

  it('rejects duplicate wallets', () => {
    expect(() =>
      validateWatchlistInput({
        chain: 'solana',
        tokenAddress: SOL_MINT,
        smartMoneyWallet1: SOL_WALLET_1,
        smartMoneyWallet2: SOL_WALLET_1,
      }),
    ).toThrow(/unique/i);
  });

  it('rejects invalid addresses for the selected chain', () => {
    expect(() =>
      validateWatchlistInput({
        chain: 'ethereum',
        tokenAddress: EVM_TOKEN,
        smartMoneyWallet1: SOL_WALLET_1, // Solana-format wallet on EVM
      }),
    ).toThrow();
  });

  it('rejects manual numeric market fields before they can creep in', () => {
    const input = validateWatchlistInput({
      chain: 'solana',
      tokenAddress: SOL_MINT,
      smartMoneyWallet1: SOL_WALLET_1,
      // Unknown extra keys are ignored silently; there is no field to accept
      // them, which is exactly the contract.
      safetyScore: 90,
      liquidity: '$1.4M',
    } as Record<string, unknown>);
    expect(input).not.toHaveProperty('safetyScore');
    expect(input).not.toHaveProperty('liquidity');
  });
});