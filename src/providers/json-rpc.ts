import { getRpcUrl, type SupportedChain } from '../chains/registry.js';

export interface JsonRpcClientOptions {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}

export type RpcParams = Array<unknown> | Record<string, unknown>;

/**
 * Structural RPC caller shared by the Alchemy and Helius clients so Solana
 * enrichment helpers can be provider-agnostic.
 */
export interface RpcCaller {
  call(chain: SupportedChain, method: string, params: RpcParams, maxAttempts?: number): Promise<unknown>;
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
    this.fetcher = options.fetch ?? globalThis.fetch;
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
}