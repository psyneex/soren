import { describe, expect, it, vi } from 'vitest';
import {
  CENSUS_PAGE_LIMIT,
  SPL_TOKEN_2022_PROGRAM,
  SPL_TOKEN_PROGRAM,
  decodeHolderSlice,
  fetchHolderCensus,
  mergeCensusAccounts,
  summarizeHolderCensus,
} from '../src/providers/helius.js';
import { HeliusRpcClient, HeliusRpcError } from '../src/providers/helius.js';
import { TtlCache } from '../src/providers/cache.js';

const OWNER_A = 'aa'.repeat(32);
const OWNER_B = 'bb'.repeat(32);

function sliceBase64(ownerHex: string, amount: bigint): string {
  const owner = Buffer.from(ownerHex, 'hex');
  const buf = Buffer.alloc(40);
  owner.copy(buf, 0);
  buf.writeBigUInt64LE(amount, 32);
  return buf.toString('base64');
}

function censusRow(pubkey: string, ownerHex: string, amount: bigint) {
  return { pubkey, account: { data: [sliceBase64(ownerHex, amount), 'base64'] } };
}

const json = (result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('holder census decoding', () => {
  it('decodes a 40-byte owner+amount slice', () => {
    const decoded = decodeHolderSlice(sliceBase64(OWNER_A, 123456789n));
    expect(decoded).toEqual({ owner: OWNER_A, amount: 123456789n });
  });

  it('returns null for malformed slices instead of guessing', () => {
    expect(decodeHolderSlice(Buffer.alloc(10).toString('base64'))).toBeNull();
  });
});

describe('mergeCensusAccounts', () => {
  it('deduplicates token accounts by pubkey keeping the max amount', () => {
    const merged = mergeCensusAccounts([
      { pubkey: 'pk1', owner: OWNER_A, amount: 100n },
      { pubkey: 'pk1', owner: OWNER_A, amount: 300n },
      { pubkey: 'pk2', owner: OWNER_B, amount: 50n },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.find((a) => a.pubkey === 'pk1')?.amount).toBe(300n);
  });
});

describe('summarizeHolderCensus', () => {
  const accounts = [
    { pubkey: 'pk1', owner: OWNER_A, amount: 60n },
    { pubkey: 'pk2', owner: OWNER_B, amount: 30n },
    { pubkey: 'pk3', owner: OWNER_A, amount: 40n }, // second account, same owner
    { pubkey: 'pk4', owner: 'cc'.repeat(32), amount: 10n },
  ];

  it('aggregates per owner and reports exact metrics for a complete census', () => {
    const summary = summarizeHolderCensus({ accounts, accountsScanned: 4, complete: true }, 100n);
    expect(summary.uniqueHolders).toBe(3); // OWNER_A counted once (max 60)
    expect(summary.holderCount).toBe(3);
    expect(summary.top100RawSum).toBe(100n); // 60 + 30 + 10
    expect(summary.top100ConcentrationPercent).toBe(100);
  });

  it('withholds holder count and concentration for a bounded census', () => {
    const summary = summarizeHolderCensus({ accounts, accountsScanned: 4, complete: false }, 100n);
    expect(summary.holderCount).toBeNull();
    expect(summary.top100ConcentrationPercent).toBeNull();
    expect(summary.uniqueHolders).toBe(3);
    expect(summary.top100RawSum).toBe(100n);
  });

  it('withholds concentration when supply is unknown', () => {
    const summary = summarizeHolderCensus({ accounts, accountsScanned: 4, complete: true }, null);
    expect(summary.holderCount).toBe(3);
    expect(summary.top100ConcentrationPercent).toBeNull();
  });
});

describe('fetchHolderCensus (paginated getProgramAccountsV2)', () => {
  function fullPage(rows: number, cursor: string | null, prefix = 'a') {
    const accounts = Array.from({ length: rows }, (_, i) => censusRow(`pk-${prefix}-${i}`, OWNER_A, BigInt(i + 1)));
    return { accounts, paginationKey: cursor, count: rows };
  }

  it('paginates via paginationKey, scans both token programs, and completes', async () => {
    const calls: Array<{ method: string; program: string; config: Record<string, unknown> }> = [];
    const rpc = {
      call: vi.fn(async (_chain: string, method: string, params: [string, Record<string, unknown>]) => {
        const [program, config] = params;
        calls.push({ method, program, config });
        if (program === SPL_TOKEN_PROGRAM) {
          if (config.paginationKey === 'cursor-1') return fullPage(300, null, 'b');
          return fullPage(CENSUS_PAGE_LIMIT, 'cursor-1', 'a');
        }
        return fullPage(0, null); // Token-2022: no accounts
      }),
    };

    const census = await fetchHolderCensus(rpc, new TtlCache(), 'solana', 'MINT');
    expect(census.complete).toBe(true);
    expect(census.accountsScanned).toBe(CENSUS_PAGE_LIMIT + 300);

    expect(calls[0].method).toBe('getProgramAccountsV2');
    expect(calls[0].program).toBe(SPL_TOKEN_PROGRAM);
    expect(calls[0].config.dataSlice).toEqual({ offset: 32, length: 40 });
    expect(calls[0].config.limit).toBe(CENSUS_PAGE_LIMIT);
    expect(calls[1].config.paginationKey).toBe('cursor-1');
    expect(calls.at(-1)?.program).toBe(SPL_TOKEN_2022_PROGRAM);
  });

  it('marks the census bounded when the page budget exhausts on full pages', async () => {
    let splCalls = 0;
    const rpc = {
      call: vi.fn(async (_chain: string, _method: string, params: [string, Record<string, unknown>]) => {
        const [program] = params;
        if (program === SPL_TOKEN_PROGRAM) {
          splCalls += 1;
          return fullPage(CENSUS_PAGE_LIMIT, 'next', String(splCalls));
        }
        return fullPage(0, null);
      }),
    };
    const census = await fetchHolderCensus(rpc, new TtlCache(), 'solana', 'MINT');
    expect(census.complete).toBe(false);
    // 3 full pages for SPL + 1 empty Token-2022 page.
    expect(census.accountsScanned).toBe(3 * CENSUS_PAGE_LIMIT);
  });
});

describe('HeliusRpcClient', () => {
  it('retries once after a 429 and then succeeds', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 429, message: 'rate limited' } }), { status: 429 }))
      .mockResolvedValueOnce(json({ ok: 1 }));
    const client = new HeliusRpcClient({ apiKey: 'secret-key', fetch: fetchMock });
    await expect(client.call('solana', 'getTokenSupply', ['MINT'])).resolves.toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails fast on non-retryable errors and never leaks the API key', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: -32602, message: 'invalid params' } }), { status: 400 }),
    );
    const client = new HeliusRpcClient({ apiKey: 'secret-key', fetch: fetchMock });
    const error = await client.call('solana', 'getTokenSupply', ['MINT']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HeliusRpcError);
    expect((error as Error).message).not.toContain('secret-key');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

