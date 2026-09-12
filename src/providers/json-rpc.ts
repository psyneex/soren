import { getRpcUrl, type SupportedChain } from '../chains/registry.js';

export interface JsonRpcClientOptions {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}

export type RpcParams = Array<unknown> | Record<string, unknown>;

/**
 * Structural RPC caller for Alchemy so Solana enrichment helpers
 * can work with the provider.
 */
export interface RpcCaller {
  call(chain: SupportedChain, method: string, params: RpcParams, maxAttempts?: number): Promise<unknown>;
  /**
   * Batched JSON-RPC: one HTTP request (one Cloudflare subrequest) carrying
   * many RPC methods. Returns results in request order; entries that fail or
   * error resolve to null (callers must handle per-entry nulls explicitly).
   */
  callBatch(chain: SupportedChain, method: string, paramsList: RpcParams[]): Promise<Array<unknown | null>>;
}

export class AlchemyRpcError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AlchemyRpcError';
  }
}

/**
 * Minimal JSON-RPC client for Alchemy. The API key is embedded in the request
 * URL and is never included in error messages or logs.
 *
 * Handles rate limits (429), transient upstream failures (503), HTTP timeouts
 * and network errors with bounded retries and backoff.
 */
export class JsonRpcClient {
  private readonly fetcher: typeof globalThis.fetch;

  constructor(private readonly options: JsonRpcClientOptions) {
    const fallback = globalThis.fetch;
    this.fetcher = options.fetch ?? fallback.bind(globalThis);
  }

  async call(
    chain: SupportedChain,
    method: string,
    params: RpcParams,
    maxAttempts = 3,
  ): Promise<unknown> {
    const url = getRpcUrl(chain, this.options.apiKey);
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const response = await this.fetcher(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });

        const body = (await response.json().catch(() => null)) as
          | { result?: unknown; error?: { code?: number; message?: string } }
          | null;

        if (response.ok && body && body.result !== undefined) {
          return body.result;
        }

        const serverMessage = body?.error?.message ?? `HTTP ${response.status}`;
        const retryable = response.status === 429 || response.status === 503 || response.status === 408 || (response.status >= 500 && response.status !== 501);
        throw new AlchemyRpcError(
          `Alchemy ${chain} ${method} failed: ${serverMessage}`,
          body?.error?.code,
          retryable,
        );
      } catch (error) {
        lastError = error;

        const rpcError = error instanceof AlchemyRpcError ? error : null;
        const networkError = error instanceof TypeError;
        const shouldRetry = (rpcError !== null && rpcError.retryable) || networkError;
        if (!shouldRetry || attempt === maxAttempts - 1) break;

        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async callBatch(
    chain: SupportedChain,
    method: string,
    paramsList: RpcParams[],
    maxAttempts = 2,
  ): Promise<Array<unknown | null>> {
    if (paramsList.length === 0) return [];
    const url = getRpcUrl(chain, this.options.apiKey);
    const body = JSON.stringify(
      paramsList.map((params, index) => ({ jsonrpc: '2.0', id: index, method, params })),
    );
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const response = await this.fetcher(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });

        const parsed = (await response.json().catch(() => null)) as
          | Array<{ id?: number | string; result?: unknown; error?: { code?: number; message?: string } }>
          | { error?: { code?: number; message?: string } }
          | null;

        // Per-item results: ordered by id; missing/errored entries resolve to null.
        if (response.ok && Array.isArray(parsed)) {
          const byId = new Map(parsed.map((entry) => [Number(entry.id), entry]));
          return paramsList.map((_, index) => {
            const entry = byId.get(index);
            return entry && entry.error === undefined && 'result' in entry && entry.result !== undefined
              ? entry.result
              : null;
          });
        }

        const serverMessage = !Array.isArray(parsed) && parsed?.error ? parsed.error.message ?? `HTTP ${response.status}` : `HTTP ${response.status}`;
        const retryable = response.status === 429 || response.status === 503 || response.status === 408 || (response.status >= 500 && response.status !== 501);
        throw new AlchemyRpcError(
          `Alchemy ${chain} batched ${method} (${paramsList.length}) failed: ${serverMessage}`,
          !Array.isArray(parsed) ? parsed?.error?.code : undefined,
          retryable,
        );
      } catch (error) {
        lastError = error;
        const rpcError = error instanceof AlchemyRpcError ? error : null;
        const networkError = error instanceof TypeError;
        const shouldRetry = (rpcError !== null && rpcError.retryable) || networkError;
        if (!shouldRetry || attempt === maxAttempts - 1) break;
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}