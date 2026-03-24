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

export type IbkrContractQuery = {
  kind: IbkrInstrumentKind;
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
};

const joinUrl = (baseUrl: string, path: string): string => {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const suffix = String(path || "").startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
};

export class IbkrConnector {
  constructor(private cfg: IbkrBridgeConfig) {}

  private async request<T>(method: HttpMethod, path: string, body?: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timeoutMs = Math.max(500, Number(this.cfg.timeoutMs || 0));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(joinUrl(this.cfg.baseUrl, path), {
        method,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(this.cfg.auth.token ? { Authorization: `Bearer ${this.cfg.auth.token}` } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`ibkr_bridge_http_${res.status}:${text}`);
      }
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async getHealth(): Promise<{ ok: boolean; session: "connected" | "disconnected"; asOf: string }> {
    return this.request("GET", "/health");
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
