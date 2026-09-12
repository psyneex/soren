import { describe, expect, it, vi } from 'vitest';
import { JsonRpcClient } from '../src/providers/json-rpc.js';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function client(fetchMock: typeof fetch) {
  return new JsonRpcClient({ apiKey: 'test-key', fetch: fetchMock });
}

describe('JsonRpcClient.callBatch', () => {
  it('sends one POST carrying all requests and returns results in order (null for errored entries)', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      json([
        { jsonrpc: '2.0', id: 0, result: { ok: true } },
        { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'tx not found' } },
        { jsonrpc: '2.0', id: 2, result: { ok: 'third' } },
      ]),
    );
    const results = await client(fetchMock as unknown as typeof fetch).callBatch('solana', 'getTransaction', [
      ['sig1', {}],
      ['sig2', {}],
      ['sig3', {}],
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    const sent = JSON.parse(String(init.body)) as Array<{ id: number; method: string }>;
    expect(sent).toHaveLength(3);
    expect(sent.map((entry) => entry.id)).toEqual([0, 1, 2]);
    expect(results[0]).toEqual({ ok: true });
    expect(results[1]).toBeNull(); // per-entry error → null, never fabricated
    expect(results[2]).toEqual({ ok: 'third' });
  });

  it('retries transient 429 as one request and succeeds', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json([], 429))
      .mockResolvedValueOnce(json([{ id: 0, result: 'a' }, { id: 1, result: 'b' }]));
    const results = await client(fetchMock as unknown as typeof fetch).callBatch('solana', 'getTransaction', [[
      'sig1',
    ], ['sig2']]);

    expect(results).toEqual(['a', 'b']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws after bounded attempts on persistent failure', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ error: { message: 'server down' } }, 503));
    await expect(
      client(fetchMock as unknown as typeof fetch).callBatch('solana', 'getTransaction', [['sig1']]),
    ).rejects.toThrow('batched getTransaction');
    expect(fetchMock).toHaveBeenCalledTimes(2); // default maxAttempts for batches
  });

  it('returns [] without any request for an empty batch', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const results = await client(fetchMock as unknown as typeof fetch).callBatch('solana', 'getTransaction', []);
    expect(results).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
