/**
 * Alchemy Prices API client (REST, `api.g.alchemy.com/prices/v1`).
 * The API key is sent as a Bearer token and is never logged.
 */

export interface HistoricalPricePoint {
  value: number | null;
  timestamp: string | null;
  marketCapUsd: number | null;
  totalVolumeUsd: number | null;
}

export interface AlchemyPricesClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export class AlchemyPricesClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(
    private readonly apiKey: string,
    options: AlchemyPricesClientOptions = {},
  ) {
    this.baseUrl = options.baseUrl ?? 'https://api.g.alchemy.com/prices/v1';
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  async getPricesByAddress(
    network: string,
    addresses: string[],
  ): Promise<Map<string, number | null>> {
    if (addresses.length === 0) return new Map();

    const response = await this.fetcher(`${this.baseUrl}/tokens/by-address`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        addresses: addresses.map((address) => ({ network, address })),
      }),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => '');
      throw new Error(`Alchemy Prices by-address failed (${response.status}): ${message.slice(0, 200)}`);
    }

    const body = (await response.json()) as {
      data?: Array<{
        network: string;
        address: string;
        prices?: Array<{ currency: string; value: string; lastUpdatedAt: string }>;
        error?: { message?: string };
      }>;
    };

    const result = new Map<string, number | null>();
    for (const item of body.data ?? []) {
      const price = item.prices?.[0];
      result.set(item.address, price?.value ? Number(price.value) : null);
    }
    return result;
  }

  async getHistorical(
    network: string,
    address: string,
    request: {
      startTime: string;
      endTime: string;
      interval?: string;
      withMarketData?: boolean;
    },
  ): Promise<HistoricalPricePoint[]> {
    const response = await this.fetcher(`${this.baseUrl}/tokens/historical`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        network,
        address,
        startTime: request.startTime,
        endTime: request.endTime,
        interval: request.interval ?? '1d',
        withMarketData: request.withMarketData ?? true,
      }),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => '');
      throw new Error(`Alchemy Prices historical failed (${response.status}): ${message.slice(0, 200)}`);
    }

    const body = (await response.json()) as {
      data?: Array<{ value: string; timestamp: string; marketCap?: string; totalVolume?: string }>;
    };

    return (body.data ?? []).map((point) => ({
      value: point.value ? Number(point.value) : null,
      timestamp: point.timestamp ?? null,
      marketCapUsd: point.marketCap ? Number(point.marketCap) : null,
      totalVolumeUsd: point.totalVolume ? Number(point.totalVolume) : null,
    }));
  }
}