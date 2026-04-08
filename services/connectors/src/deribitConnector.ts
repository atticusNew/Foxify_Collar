export type DeribitEnv = "testnet" | "live";

const BASE_URLS: Record<DeribitEnv, string> = {
  testnet: "https://test.deribit.com/api/v2",
  live: "https://www.deribit.com/api/v2"
};

export interface DeribitCredentials {
  clientId: string;
  clientSecret: string;
}

export interface DeribitOrderRequest {
  instrument: string;
  amount: number;
  side: "buy" | "sell";
  type?: "limit" | "market";
  price?: number;
}

interface AccessToken {
  token: string;
  expiresAt: number;
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

const DERIBIT_TIMEOUT_MS = Number(process.env.DERIBIT_TIMEOUT_MS || "6000");
console.log("[Deribit] Timeout set to 6s (optimized for performance)");

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DERIBIT_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export interface DeribitPosition {
  instrument_name: string;
  kind: "option" | "future";
  direction: "buy" | "sell";
  size: number;
  average_price?: number;
  mark_price?: number;
  floating_profit_loss?: number;
  unrealized_pnl?: number;
}

export class DeribitConnector {
  private accessToken: AccessToken | null = null;

  constructor(
    private env: DeribitEnv,
    private paper = true,
    private credentials?: DeribitCredentials
  ) {}

  private baseUrl(): string {
    return BASE_URLS[this.env];
  }

  async getTicker(instrument: string): Promise<unknown> {
    const url = `${this.baseUrl()}/public/ticker?instrument_name=${encodeURIComponent(instrument)}`;
    return withRetry(async () => {
      const res = await fetchWithTimeout(url);
      return res.json();
    });
  }

  async listInstruments(currency = "BTC"): Promise<unknown> {
    const url = `${this.baseUrl()}/public/get_instruments?currency=${currency}&kind=option&expired=false`;
    return withRetry(async () => {
      const res = await fetchWithTimeout(url);
      return res.json();
    });
  }

  async getOrderBook(instrument: string): Promise<unknown> {
    const url = `${this.baseUrl()}/public/get_order_book?instrument_name=${encodeURIComponent(instrument)}`;
    return withRetry(async () => {
      const res = await fetchWithTimeout(url);
      return res.json();
    });
  }

  async getIndexPrice(indexName = "btc_usd"): Promise<unknown> {
    const url = `${this.baseUrl()}/public/get_index_price?index_name=${indexName}`;
    return withRetry(async () => {
      const res = await fetchWithTimeout(url);
      return res.json();
    });
  }

  async getDVOL(currency = "BTC"): Promise<{ dvol: number | null; timestamp: number | null }> {
    const url = `${this.baseUrl()}/public/get_volatility_index_data?currency=${currency}&resolution=1&start_timestamp=${Date.now() - 3600_000}&end_timestamp=${Date.now()}`;
    try {
      const data = await withRetry(async () => {
        const res = await fetchWithTimeout(url);
        return res.json();
      });
      const result = (data as any)?.result;
      if (!result?.data?.length) return { dvol: null, timestamp: null };
      const latest = result.data[result.data.length - 1];
      const dvol = Number(Array.isArray(latest) ? latest[4] ?? latest[1] : latest);
      const ts = Number(Array.isArray(latest) ? latest[0] : null);
      return {
        dvol: Number.isFinite(dvol) && dvol > 0 ? dvol : null,
        timestamp: Number.isFinite(ts) && ts > 0 ? ts : null
      };
    } catch {
      return { dvol: null, timestamp: null };
    }
  }

  async getHistoricalVolatility(currency = "BTC"): Promise<{ rvol: number | null }> {
    const url = `${this.baseUrl()}/public/get_historical_volatility?currency=${currency}`;
    try {
      const data = await withRetry(async () => {
        const res = await fetchWithTimeout(url);
        return res.json();
      });
      const result = (data as any)?.result;
      if (!Array.isArray(result) || !result.length) return { rvol: null };
      const latest = result[result.length - 1];
      const rvol = Number(Array.isArray(latest) ? latest[1] : latest);
      return { rvol: Number.isFinite(rvol) && rvol > 0 ? rvol : null };
    } catch {
      return { rvol: null };
    }
  }

  private async authenticate(): Promise<string> {
    if (!this.credentials) {
      throw new Error("Missing Deribit credentials");
    }

    if (this.accessToken && Date.now() < this.accessToken.expiresAt) {
      return this.accessToken.token;
    }

    const params = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret
    });

    const url = `${this.baseUrl()}/public/auth?${params.toString()}`;
    const data = await withRetry(async () => {
      const res = await fetchWithTimeout(url);
      return res.json();
    });

    if (!data?.result?.access_token) {
      throw new Error(`Failed to authenticate with Deribit: ${JSON.stringify(data?.error || data)}`);
    }

    const expiresIn = Number(data.result.expires_in || 0) * 1000;
    this.accessToken = {
      token: data.result.access_token,
      expiresAt: Date.now() + expiresIn - 10_000
    };

    return this.accessToken.token;
  }

  private async privateRequest(path: string, params: Record<string, string | number>): Promise<unknown> {
    const token = await this.authenticate();
    const urlParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      urlParams.set(key, String(value));
    }
    const url = `${this.baseUrl()}${path}?${urlParams.toString()}`;
    return withRetry(async () => {
      const res = await fetchWithTimeout(url, {
        headers: { Authorization: `Bearer ${token}` }
      });
      return res.json();
    });
  }

  async getPositions(currency = "BTC"): Promise<DeribitPosition[]> {
    const data = await this.privateRequest("/private/get_positions", { currency, kind: "any" });
    return (data as any)?.result || [];
  }

  async getAccountSummary(currency = "BTC"): Promise<unknown> {
    return this.privateRequest("/private/get_account_summary", { currency });
  }

  async placeOrder(request: DeribitOrderRequest): Promise<unknown> {
    if (this.paper) {
      const book = await this.getOrderBook(request.instrument);
      const orderBook = (book as any)?.result;
      const bestBid = orderBook?.bids?.[0]?.[0] ?? null;
      const bestAsk = orderBook?.asks?.[0]?.[0] ?? null;
      const bidSize = orderBook?.bids?.[0]?.[1] ?? 0;
      const askSize = orderBook?.asks?.[0]?.[1] ?? 0;
      const fillPrice = request.side === "buy" ? bestAsk : bestBid;
      const availableSize = request.side === "buy" ? askSize : bidSize;
      if (!fillPrice) {
        return {
          status: "paper_rejected",
          reason: "no_top_of_book",
          request,
          bestBid,
          bestAsk,
          availableSize,
          bookTimestamp: orderBook?.timestamp ?? null
        };
      }
      if (availableSize < request.amount) {
        if (availableSize > 0) {
          return {
            status: "paper_filled",
            reason: "partial_fill",
            request,
            fillPrice,
            filledAmount: availableSize,
            fillCurrency: "btc",
            bestBid,
            bestAsk,
            availableSize,
            bookTimestamp: orderBook?.timestamp ?? null
          };
        }
        return {
          status: "paper_rejected",
          reason: "insufficient_liquidity",
          request,
          bestBid,
          bestAsk,
          availableSize,
          bookTimestamp: orderBook?.timestamp ?? null
        };
      }
      return {
        status: "paper_filled",
        id: `paper-order-${Date.now()}`,
        request,
        fillPrice,
        fillCurrency: "btc",
        bestBid,
        bestAsk,
        availableSize,
        bookTimestamp: orderBook?.timestamp ?? null
      };
    }

    if (!this.credentials) {
      throw new Error("Missing Deribit credentials");
    }

    const path = request.side === "buy" ? "/private/buy" : "/private/sell";
    const params: Record<string, string | number> = {
      instrument_name: request.instrument,
      amount: request.amount,
      type: request.type || "limit"
    };
    if (request.price && request.type !== "market") {
      params.price = request.price;
    }

    return this.privateRequest(path, params);
  }
}
