import type {
  BridgeContractQuery,
  BridgeDepth,
  BridgeOrderState,
  BridgePlaceOrderRequest,
  BridgeQualifiedContract,
  BridgeTopOfBook
} from "./types";

type SessionState = "connected" | "disconnected";

const nowIso = (): string => new Date().toISOString();

const normalizeTenorDays = (raw: number): number => {
  if (!Number.isFinite(raw)) return 1;
  return Math.max(1, Math.min(30, Math.floor(raw)));
};

const buildMbtExpiry = (tenorDays: number): string => {
  const target = new Date(Date.now() + normalizeTenorDays(tenorDays) * 86400000);
  const y = target.getUTCFullYear();
  const m = String(target.getUTCMonth() + 1).padStart(2, "0");
  const d = String(target.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
};

const syntheticConId = (seed: string): number => {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) + 10_000;
};

/**
 * Thin IB gateway facade.
 * This scaffold intentionally returns deterministic synthetic responses
 * until live TWS/IB Gateway transport is wired.
 */
export class IbGatewayClient {
  private session: SessionState = "disconnected";

  constructor(
    private readonly config: {
      host: string;
      port: number;
      clientId: number;
      readonlyMode: boolean;
    }
  ) {}

  async connect(): Promise<void> {
    // Placeholder; production wiring will open/verify a real TWS socket session.
    this.session = "connected";
  }

  async getHealth(): Promise<{ ok: boolean; session: SessionState; asOf: string }> {
    if (this.session === "disconnected") {
      await this.connect();
    }
    return { ok: true, session: this.session, asOf: nowIso() };
  }

  async qualifyContracts(query: BridgeContractQuery): Promise<BridgeQualifiedContract[]> {
    if (this.session === "disconnected") {
      await this.connect();
    }
    const expiry = buildMbtExpiry(query.tenorDays);
    if (query.kind === "mbt_future") {
      const localSymbol = `MBT ${expiry}`;
      return [
        {
          conId: syntheticConId(`FUT:${localSymbol}`),
          secType: "FUT",
          localSymbol,
          expiry,
          multiplier: "0.1",
          minTick: 5
        }
      ];
    }
    if (!query.right || !Number.isFinite(Number(query.strike)) || Number(query.strike) <= 0) {
      return [];
    }
    const strike = Math.floor(Number(query.strike));
    const localSymbol = `MBT ${expiry} ${query.right}${strike}`;
    return [
      {
        conId: syntheticConId(`FOP:${localSymbol}`),
        secType: "FOP",
        localSymbol,
        expiry,
        strike,
        right: query.right,
        multiplier: "0.1",
        minTick: 5
      }
    ];
  }

  async getTopOfBook(conId: number): Promise<BridgeTopOfBook> {
    if (this.session === "disconnected") {
      await this.connect();
    }
    const base = 100 + (conId % 10);
    return {
      bid: base,
      ask: base + 1,
      bidSize: 10,
      askSize: 8,
      asOf: nowIso()
    };
  }

  async getDepth(conId: number): Promise<BridgeDepth> {
    if (this.session === "disconnected") {
      await this.connect();
    }
    const base = 100 + (conId % 10);
    return {
      bids: [
        { level: 0, price: base, size: 10 },
        { level: 1, price: base - 1, size: 12 }
      ],
      asks: [
        { level: 0, price: base + 1, size: 8 },
        { level: 1, price: base + 2, size: 11 }
      ],
      asOf: nowIso()
    };
  }

  async placeOrder(req: BridgePlaceOrderRequest): Promise<{ orderId: string; submittedAt: string }> {
    if (this.session === "disconnected") {
      await this.connect();
    }
    if (this.config.readonlyMode) {
      throw new Error("bridge_readonly_mode");
    }
    if (!Number.isFinite(req.quantity) || req.quantity <= 0) {
      throw new Error("invalid_order_quantity");
    }
    if (!Number.isFinite(req.limitPrice) || req.limitPrice <= 0) {
      throw new Error("invalid_order_limit_price");
    }
    return {
      orderId: `IB-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      submittedAt: nowIso()
    };
  }

  async getOrder(orderId: string): Promise<BridgeOrderState> {
    if (this.session === "disconnected") {
      await this.connect();
    }
    return {
      orderId,
      status: "filled",
      filledQuantity: 1,
      avgFillPrice: 101,
      lastUpdateAt: nowIso()
    };
  }

  async cancelOrder(orderId: string): Promise<{ cancelled: boolean; asOf: string }> {
    if (this.session === "disconnected") {
      await this.connect();
    }
    if (this.config.readonlyMode) {
      return { cancelled: false, asOf: nowIso() };
    }
    return { cancelled: true, asOf: nowIso() };
  }
}
