type HttpMethod = "GET" | "POST";

export type IbkrBridgeAuth = { token: string };

export type IbkrBridgeConfig = {
  baseUrl: string;
  timeoutMs: number;
  auth: IbkrBridgeAuth;
  accountId: string;
};

export type IbkrInstrumentKind = "mbt_future" | "mbt_option";
export type IbkrOptionRight = "P" | "C";
export type IbkrProductFamily = "MBT" | "BFF";

export type IbkrContractQuery = {
  kind: IbkrInstrumentKind;
  productFamily?: IbkrProductFamily;
  symbol: "BTC";
  exchange: "CME";
  currency: "USD";
  tenorDays: number;
  right?: IbkrOptionRight;
  strike?: number;
};

export type IbkrQualifiedContract = {
  conId: number;
  secType: "FUT" | "FOP";
  localSymbol: string;
  expiry: string;
  strike?: number;
  right?: IbkrOptionRight;
  multiplier: string;
  minTick?: number;
};

export type IbkrTopOfBook = {
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  asOf: string;
};

export type IbkrDepthLevel = { level: number; price: number; size: number };
export type IbkrDepth = { bids: IbkrDepthLevel[]; asks: IbkrDepthLevel[]; asOf: string };

export type IbkrPlaceOrderRequest = {
  accountId: string;
  conId: number;
  side: "BUY" | "SELL";
  quantity: number;
  orderType: "LMT";
  limitPrice: number;
  tif: "DAY" | "IOC";
  clientOrderId: string;
};

export type IbkrOrderStatus =
  | "submitted"
  | "partially_filled"
  | "filled"
  | "cancelled"
  | "rejected"
  | "inactive";

export type IbkrOrderState = {
  orderId: string;
  status: IbkrOrderStatus;
  filledQuantity: number;
  avgFillPrice: number | null;
  lastUpdateAt: string;
  rejectionReason?: string;
  commissionUsd?: number | null;
  commissionCurrency?: string | null;
  commissionUpdatedAt?: string | null;
};

const joinUrl = (baseUrl: string, path: string): string => {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const suffix = String(path || "").startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
};

export class IbkrConnector {
  constructor(private cfg: IbkrBridgeConfig) {}

  private async request<T>(method: HttpMethod, path: string, body?: Record<string, unknown>): Promise<T> {
    const timeoutMs = Math.max(500, Number(this.cfg.timeoutMs || 0));
    const headers: Record<string, string> = {
      ...(this.cfg.auth.token ? { Authorization: `Bearer ${this.cfg.auth.token}` } : {})
    };
    const serializedBody = body ? JSON.stringify(body) : undefined;
    if (serializedBody) {
      headers["Content-Type"] = "application/json";
    }

    // A single transient bridge timeout should not fail the whole quote path.
    // Keep retries small and bounded to avoid request fanout.
    const maxAttempts = 2;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(joinUrl(this.cfg.baseUrl, path), {
          method,
          signal: controller.signal,
          headers,
          body: serializedBody
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`ibkr_bridge_http_${res.status}:${text}`);
        }
        const text = await res.text();
        return (text ? JSON.parse(text) : {}) as T;
      } catch (error) {
        lastError = error;
        if (attempt >= maxAttempts) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 120));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("ibkr_bridge_request_failed");
  }

  async getHealth(): Promise<{ ok: boolean; session: "connected" | "disconnected"; asOf: string }> {
    return this.request("GET", "/health");
  }

  async assertLiveTransportRequired(): Promise<void> {
    const health = await this.request<{
      transport?: string;
      activeTransport?: string;
      fallbackEnabled?: boolean;
      lastError?: string;
      lastFallbackReason?: string;
    }>("GET", "/health");
    const transport = String(health.transport || "");
    const activeTransport = String(health.activeTransport || "");
    if (transport !== "ib_socket" || activeTransport !== "ib_socket") {
      const detail = [
        `transport=${transport || "unknown"}`,
        `activeTransport=${activeTransport || "unknown"}`,
        `fallbackEnabled=${String(Boolean(health.fallbackEnabled))}`,
        `lastError=${String(health.lastError || "")}`,
        `lastFallbackReason=${String(health.lastFallbackReason || "")}`
      ]
        .filter((part) => !part.endsWith("="))
        .join(" ");
      throw new Error(`ibkr_transport_not_live:${detail}`);
    }
  }

  async qualifyContracts(query: IbkrContractQuery): Promise<IbkrQualifiedContract[]> {
    const payload = await this.request<{ contracts?: IbkrQualifiedContract[] }>("POST", "/contracts/qualify", query);
    return Array.isArray(payload.contracts) ? payload.contracts : [];
  }

  async getTopOfBook(conId: number): Promise<IbkrTopOfBook> {
    return this.request("POST", "/marketdata/top", { conId });
  }

  async getDepth(conId: number): Promise<IbkrDepth> {
    return this.request("POST", "/marketdata/depth", { conId });
  }

  async placeOrder(req: IbkrPlaceOrderRequest): Promise<{ orderId: string; submittedAt: string }> {
    return this.request("POST", "/orders/place", req);
  }

  async getOrder(orderId: string): Promise<IbkrOrderState> {
    return this.request("GET", `/orders/${encodeURIComponent(orderId)}`);
  }

  async cancelOrder(orderId: string): Promise<{ cancelled: boolean; asOf: string }> {
    return this.request("POST", `/orders/${encodeURIComponent(orderId)}/cancel`);
  }
}
