import { IBApi, EventName, SecType, type OrderAction, type OrderType, type TimeInForce } from "@stoqey/ib";
import type { Contract, ContractDetails } from "@stoqey/ib";
import type { CommissionReport } from "@stoqey/ib/dist/api/report/commissionReport";
import type { Execution } from "@stoqey/ib/dist/api/order/execution";
import type {
  BridgeActiveTransport,
  BridgeContractQuery,
  BridgeDepth,
  BridgeHealth,
  BridgeOrderState,
  BridgeOrderStatus,
  BridgePlaceOrderRequest,
  BridgeQualifiedContract,
  BridgeSessionState,
  BridgeTopOfBook,
  BridgeTransportMode
} from "./types";

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

const resolveProductSymbol = (productFamily: "MBT" | "BFF" | undefined): "MBT" | "BFF" =>
  productFamily === "BFF" ? "BFF" : "MBT";

const normalizeExpiry = (value: unknown, fallback: string): string => {
  const raw = String(value || "").replace(/[^0-9]/g, "");
  if (raw.length >= 8) return raw.slice(0, 8);
  if (raw.length === 6) return `${raw}01`;
  return fallback;
};

const syntheticConId = (seed: string): number => {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) + 10_000;
};

const finiteOrNull = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const positiveOrNull = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const toBridgeOrderStatus = (value: unknown, filled: number): BridgeOrderStatus => {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "filled") return "filled";
  if (normalized === "cancelled" || normalized === "apicancelled" || normalized === "pendingcancel") {
    return "cancelled";
  }
  if (normalized === "inactive") return "inactive";
  if (normalized === "presubmitted" || normalized === "submitted" || normalized === "pendingsubmit") {
    return filled > 0 ? "partially_filled" : "submitted";
  }
  return filled > 0 ? "partially_filled" : "submitted";
};

const isTerminalOrderStatus = (status: BridgeOrderStatus): boolean =>
  status === "filled" || status === "partially_filled" || status === "cancelled" || status === "rejected" || status === "inactive";

type IbConfig = {
  host: string;
  port: number;
  clientId: number;
  readonlyMode: boolean;
  transportMode: BridgeTransportMode;
  fallbackToSynthetic: boolean;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  marketDataType: 1 | 2 | 3 | 4;
  contractExchangeAliases: string[];
};

type DepthRow = { level: number; price: number; size: number };

const normalizeReqId = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  return null;
};

const normalizeExchangeAlias = (raw: string | undefined | null): string => String(raw || "").trim().toUpperCase();

/**
 * Hybrid IB gateway client:
 * - synthetic mode: deterministic fixtures for offline/dev.
 * - ib_socket mode: direct TWS/IB Gateway transport via socket API.
 * Fallback can route runtime transport errors back to synthetic responses.
 */
export class IbGatewayClient {
  private session: BridgeSessionState = "disconnected";
  private activeTransport: BridgeActiveTransport;
  private ib: IBApi | null = null;
  private nextReqId = 10000;
  private nextOrderId: number | null = null;
  private lastError: string | null = null;
  private lastFallbackReason: string | null = null;
  private readonly ordersByExternalId = new Map<string, BridgeOrderState>();
  private readonly orderIdToExternalId = new Map<number, string>();
  private readonly execIdToOrderExternalId = new Map<string, string>();
  private connectPromise: Promise<void> | null = null;

  constructor(private readonly config: IbConfig) {
    this.activeTransport = this.config.transportMode;
  }

  async connect(): Promise<void> {
    if (this.config.transportMode === "synthetic") {
      this.session = "connected";
      this.activeTransport = "synthetic";
      return;
    }
    await this.ensureIbConnected();
  }

  async getHealth(): Promise<BridgeHealth> {
    if (this.config.transportMode === "synthetic") {
      if (this.session === "disconnected") {
        await this.connect();
      }
      return {
        ok: true,
        session: this.session,
        transport: "synthetic",
        activeTransport: this.activeTransport,
        fallbackEnabled: this.config.fallbackToSynthetic,
        lastError: this.lastError || undefined,
        lastFallbackReason: this.lastFallbackReason || undefined,
        asOf: nowIso()
      };
    }

    try {
      await this.ensureIbConnected();
    } catch (error) {
      this.lastError = String((error as Error)?.message || error || "ib_connect_failed");
      if (this.config.fallbackToSynthetic) {
        this.session = "connected";
        this.activeTransport = "synthetic_fallback";
        this.lastFallbackReason = `health:${this.lastError}`;
      } else {
        this.session = "disconnected";
      }
    }

    return {
      ok: true,
      session: this.session,
      transport: this.config.transportMode,
      activeTransport: this.activeTransport,
      fallbackEnabled: this.config.fallbackToSynthetic,
      lastError: this.lastError || undefined,
      lastFallbackReason: this.lastFallbackReason || undefined,
      asOf: nowIso()
    };
  }

  async qualifyContracts(query: BridgeContractQuery): Promise<BridgeQualifiedContract[]> {
    return this.runWithTransport(
      "qualifyContracts",
      () => this.qualifyContractsIb(query),
      () => this.qualifyContractsSynthetic(query)
    );
  }

  async getTopOfBook(conId: number): Promise<BridgeTopOfBook> {
    return this.runWithTransport(
      "getTopOfBook",
      () => this.getTopOfBookIb(conId),
      () => this.getTopOfBookSynthetic(conId)
    );
  }

  async getDepth(conId: number): Promise<BridgeDepth> {
    return this.runWithTransport(
      "getDepth",
      () => this.getDepthIb(conId),
      () => this.getDepthSynthetic(conId)
    );
  }

  async placeOrder(req: BridgePlaceOrderRequest): Promise<{ orderId: string; submittedAt: string }> {
    if (this.config.readonlyMode) {
      throw new Error("bridge_readonly_mode");
    }
    if (!Number.isFinite(req.quantity) || req.quantity <= 0) {
      throw new Error("invalid_order_quantity");
    }
    if (!Number.isFinite(req.limitPrice) || req.limitPrice <= 0) {
      throw new Error("invalid_order_limit_price");
    }

    return this.runWithTransport(
      "placeOrder",
      () => this.placeOrderIb(req),
      () => this.placeOrderSynthetic(req)
    );
  }

  async getOrder(orderId: string): Promise<BridgeOrderState> {
    return this.runWithTransport("getOrder", () => this.getOrderIb(orderId), () => this.getOrderSynthetic(orderId));
  }

  async cancelOrder(orderId: string): Promise<{ cancelled: boolean; asOf: string }> {
    if (this.config.readonlyMode) {
      return { cancelled: false, asOf: nowIso() };
    }
    return this.runWithTransport(
      "cancelOrder",
      () => this.cancelOrderIb(orderId),
      () => this.cancelOrderSynthetic(orderId)
    );
  }

  private async runWithTransport<T>(
    opName: string,
    ibOp: () => Promise<T>,
    syntheticOp: () => Promise<T>
  ): Promise<T> {
    if (this.config.transportMode === "synthetic") {
      this.activeTransport = "synthetic";
      this.session = "connected";
      return await syntheticOp();
    }

    try {
      await this.ensureIbConnected();
      this.activeTransport = "ib_socket";
      return await ibOp();
    } catch (error) {
      this.lastError = String((error as Error)?.message || error || "ib_socket_error");
      if (!this.config.fallbackToSynthetic) {
        throw error;
      }
      this.lastFallbackReason = `${opName}:${this.lastError}`;
      this.activeTransport = "synthetic_fallback";
      this.session = "connected";
      return await syntheticOp();
    }
  }

  private async ensureIbConnected(): Promise<void> {
    if (this.ib?.isConnected) {
      this.session = "connected";
      this.activeTransport = "ib_socket";
      return;
    }
    if (this.connectPromise) {
      return await this.connectPromise;
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const ib = new IBApi({
        host: this.config.host,
        port: this.config.port,
        clientId: this.config.clientId
      });
      this.ib = ib;

      const timeoutMs = Math.max(800, Math.floor(this.config.connectTimeoutMs || 0));
      const timeoutHandle = setTimeout(() => {
        cleanup();
        this.session = "disconnected";
        reject(new Error("ib_connect_timeout"));
      }, timeoutMs);

      const cleanup = (): void => {
        clearTimeout(timeoutHandle);
        ib.off(EventName.connected, onConnected);
        ib.off(EventName.error, onError);
      };

      const onConnected = (): void => {
        cleanup();
        this.registerBaseListeners(ib);
        this.session = "connected";
        this.activeTransport = "ib_socket";
        this.lastError = null;
        this.lastFallbackReason = null;
        try {
          ib.reqMarketDataType(this.config.marketDataType as unknown as number);
        } catch {
          // Keep connection alive even if market data type switch is unsupported.
        }
        resolve();
      };

      const onError = (...args: unknown[]): void => {
        const message = this.extractIbErrorMessage(args);
        const code = this.extractIbErrorCode(args);
        if (code === 502 || message.includes("Couldn't connect")) {
          cleanup();
          this.session = "disconnected";
          reject(new Error(`ib_connect_failed:${message || "unknown"}`));
        } else {
          this.lastError = message || this.lastError;
        }
      };

      ib.once(EventName.connected, onConnected);
      ib.on(EventName.error, onError);
      ib.connect(this.config.clientId);
    })
      .finally(() => {
        this.connectPromise = null;
      })
      .catch((error) => {
        this.session = "disconnected";
        throw error;
      });

    return await this.connectPromise;
  }

  private registerBaseListeners(ib: IBApi): void {
    ib.on(EventName.disconnected, () => {
      this.session = "disconnected";
      this.lastError = "ib_disconnected";
    });

    ib.on(EventName.nextValidId, (orderId: number) => {
      if (Number.isFinite(orderId) && orderId > 0) {
        if (this.nextOrderId === null || orderId > this.nextOrderId) {
          this.nextOrderId = orderId;
        }
      }
    });

    ib.on(
      EventName.orderStatus,
      (
        orderId: number,
        status: unknown,
        filled: number,
        remaining: number,
        avgFillPrice: number,
        _permId?: number,
        _parentId?: number,
        _lastFillPrice?: number
      ) => {
        const externalId = this.orderIdToExternalId.get(orderId);
        if (!externalId) return;
        const fillQty = Math.max(0, Number(filled || 0));
        const current = this.ordersByExternalId.get(externalId);
        const mappedStatus = toBridgeOrderStatus(status, fillQty);
        const normalizedStatus =
          mappedStatus === "submitted" && fillQty > 0 && Number(remaining || 0) > 0
            ? "partially_filled"
            : mappedStatus;
        this.ordersByExternalId.set(externalId, {
          orderId: externalId,
          status: normalizedStatus,
          filledQuantity: fillQty,
          avgFillPrice: positiveOrNull(avgFillPrice),
          lastUpdateAt: nowIso(),
          rejectionReason: current?.rejectionReason,
          commissionUsd: current?.commissionUsd ?? null,
          commissionCurrency: current?.commissionCurrency ?? null,
          commissionUpdatedAt: current?.commissionUpdatedAt ?? null
        });
      }
    );

    ib.on(EventName.execDetails, (reqId: number, _contract: Contract, execution: Execution) => {
      if (reqId !== -1) return;
      const execId = String(execution?.execId || "").trim();
      if (!execId) return;
      const orderId = Number(execution?.orderId);
      if (!Number.isFinite(orderId) || orderId <= 0) return;
      const externalId = this.orderIdToExternalId.get(Math.floor(orderId));
      if (!externalId) return;
      this.execIdToOrderExternalId.set(execId, externalId);
    });

    ib.on(EventName.commissionReport, (commissionReport: CommissionReport) => {
      const execId = String(commissionReport?.execId || "").trim();
      if (!execId) return;
      const externalId = this.execIdToOrderExternalId.get(execId);
      if (!externalId) return;
      const current = this.ordersByExternalId.get(externalId);
      if (!current) return;
      const commissionValue = finiteOrNull(commissionReport?.commission);
      const currency = String(commissionReport?.currency || "").trim().toUpperCase();
      const hasCommission = commissionValue !== null && Number.isFinite(commissionValue);
      if (!hasCommission && !currency) return;
      const nextCommission =
        (current.commissionUsd ?? 0) + (hasCommission ? Math.max(0, Number(commissionValue)) : 0);
      this.ordersByExternalId.set(externalId, {
        ...current,
        commissionUsd: Number(nextCommission.toFixed(10)),
        commissionCurrency: currency || current.commissionCurrency || null,
        commissionUpdatedAt: nowIso(),
        lastUpdateAt: nowIso()
      });
    });

    ib.on(EventName.error, (...args: unknown[]) => {
      const code = this.extractIbErrorCode(args);
      const reqId = this.extractIbReqId(args);
      const message = this.extractIbErrorMessage(args);
      if (message) {
        this.lastError = code ? `${code}:${message}` : message;
      }

      if (reqId !== null && reqId >= 0) {
        const externalId = this.orderIdToExternalId.get(reqId);
        if (!externalId) return;
        const current = this.ordersByExternalId.get(externalId);
        const existingTerminal = current ? isTerminalOrderStatus(current.status) : false;
        const existingReason = String(current?.rejectionReason || "").trim();
        this.ordersByExternalId.set(externalId, {
          orderId: externalId,
          status: existingTerminal ? current!.status : "rejected",
          filledQuantity: current?.filledQuantity ?? 0,
          avgFillPrice: current?.avgFillPrice ?? null,
          lastUpdateAt: nowIso(),
          rejectionReason: existingReason || message || "ib_order_rejected",
          commissionUsd: current?.commissionUsd ?? null,
          commissionCurrency: current?.commissionCurrency ?? null,
          commissionUpdatedAt: current?.commissionUpdatedAt ?? null
        });
      }
    });
  }

  private extractIbErrorCode(args: unknown[]): number | null {
    if (typeof args[1] === "number") return args[1];
    if (typeof args[0] === "number") return args[0];
    return null;
  }

  private extractIbReqId(args: unknown[]): number | null {
    const reqIdCandidates = [args[2], args[0]];
    for (const value of reqIdCandidates) {
      const normalized = normalizeReqId(value);
      if (normalized !== null) return normalized;
    }
    return null;
  }

  private reqIdMatches(expectedReqId: number, value: unknown): boolean {
    const normalized = normalizeReqId(value);
    return normalized !== null && normalized === expectedReqId;
  }

  private extractIbErrorMessage(args: unknown[]): string {
    if (typeof args[0] === "object" && args[0] !== null && "message" in (args[0] as Record<string, unknown>)) {
      const message = String((args[0] as { message?: string }).message || "").trim();
      if (message) return message;
    }
    if (typeof args[2] === "string") return args[2];
    if (typeof args[0] === "string") return args[0];
    return "";
  }

  private nextRequestId(): number {
    this.nextReqId += 1;
    return this.nextReqId;
  }

  private async requireOrderId(): Promise<number> {
    if (this.nextOrderId !== null && this.nextOrderId > 0) {
      const id = this.nextOrderId;
      this.nextOrderId += 1;
      return id;
    }
    const ib = await this.requireIb();
    return await new Promise<number>((resolve, reject) => {
      const timeoutMs = Math.max(800, Math.floor(this.config.requestTimeoutMs || 0));
      const timeoutHandle = setTimeout(() => {
        cleanup();
        reject(new Error("ib_next_valid_id_timeout"));
      }, timeoutMs);

      const cleanup = (): void => {
        clearTimeout(timeoutHandle);
        ib.off(EventName.nextValidId, onNextValidId);
      };

      const onNextValidId = (orderId: number): void => {
        cleanup();
        this.nextOrderId = orderId + 1;
        resolve(orderId);
      };

      ib.once(EventName.nextValidId, onNextValidId);
      ib.reqIds();
    });
  }

  private async requireIb(): Promise<IBApi> {
    await this.ensureIbConnected();
    if (!this.ib) throw new Error("ib_not_initialized");
    return this.ib;
  }

  private buildSyntheticOrderState(orderId: string): BridgeOrderState {
    return {
      orderId,
      status: "filled",
      filledQuantity: 1,
      avgFillPrice: 101,
      lastUpdateAt: nowIso()
    };
  }

  private async qualifyContractsSynthetic(query: BridgeContractQuery): Promise<BridgeQualifiedContract[]> {
    const expiry = buildMbtExpiry(query.tenorDays);
    const productSymbol = resolveProductSymbol(query.productFamily);
    if (query.kind === "mbt_future") {
      const localSymbol = `${productSymbol} ${expiry}`;
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
    const localSymbol = `${productSymbol} ${expiry} ${query.right}${strike}`;
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

  private async getTopOfBookSynthetic(conId: number): Promise<BridgeTopOfBook> {
    const base = 100 + (conId % 10);
    return {
      bid: base,
      ask: base + 1,
      bidSize: 10,
      askSize: 8,
      asOf: nowIso()
    };
  }

  private async getDepthSynthetic(conId: number): Promise<BridgeDepth> {
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

  private async placeOrderSynthetic(_req: BridgePlaceOrderRequest): Promise<{ orderId: string; submittedAt: string }> {
    const orderId = `IB-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const submittedAt = nowIso();
    this.ordersByExternalId.set(orderId, this.buildSyntheticOrderState(orderId));
    return { orderId, submittedAt };
  }

  private async getOrderSynthetic(orderId: string): Promise<BridgeOrderState> {
    return this.ordersByExternalId.get(orderId) || this.buildSyntheticOrderState(orderId);
  }

  private async cancelOrderSynthetic(orderId: string): Promise<{ cancelled: boolean; asOf: string }> {
    const current = this.ordersByExternalId.get(orderId);
    this.ordersByExternalId.set(orderId, {
      orderId,
      status: "cancelled",
      filledQuantity: current?.filledQuantity ?? 0,
      avgFillPrice: current?.avgFillPrice ?? null,
      lastUpdateAt: nowIso()
    });
    return { cancelled: true, asOf: nowIso() };
  }

  private async qualifyContractsIb(query: BridgeContractQuery): Promise<BridgeQualifiedContract[]> {
    const ib = await this.requireIb();
    const fallbackExpiry = buildMbtExpiry(query.tenorDays);
    const productSymbol = resolveProductSymbol(query.productFamily);
    const symbolCandidates = Array.from(
      new Set(
        [productSymbol, String(query.symbol || "").trim().toUpperCase()]
          .map((item) => String(item || "").trim().toUpperCase())
          .filter(Boolean)
      )
    );
    if (!symbolCandidates.length) {
      symbolCandidates.push(productSymbol);
    }
    const exchangeCandidates = Array.from(
      new Set(
        [query.exchange, ...this.config.contractExchangeAliases]
          .map((item) => normalizeExchangeAlias(item))
          .filter(Boolean)
      )
    );
    if (!exchangeCandidates.length) {
      exchangeCandidates.push("CME");
    }
    const fetchContractDetails = async (targetContract: Contract): Promise<ContractDetails[]> => {
      const reqId = this.nextRequestId();
      return await new Promise<ContractDetails[]>((resolve, reject) => {
        const timeoutMs = Math.max(1200, Math.floor(this.config.requestTimeoutMs || 0));
        const rows: ContractDetails[] = [];
        const timeoutHandle = setTimeout(() => {
          cleanup();
          reject(new Error("ib_contract_details_timeout"));
        }, timeoutMs);

        const cleanup = (): void => {
          clearTimeout(timeoutHandle);
          ib.off(EventName.contractDetails, onDetails);
          ib.off(EventName.contractDetailsEnd, onEnd);
          ib.off(EventName.error, onError);
        };

        const onDetails = (eventReqId: number, detail: ContractDetails): void => {
          if (!this.reqIdMatches(reqId, eventReqId)) return;
          rows.push(detail);
        };

        const onEnd = (eventReqId: number): void => {
          if (!this.reqIdMatches(reqId, eventReqId)) return;
          cleanup();
          resolve(rows);
        };

        const onError = (...args: unknown[]): void => {
          const eventReqId = this.extractIbReqId(args);
          if (!this.reqIdMatches(reqId, eventReqId) && !this.reqIdMatches(-1, eventReqId)) return;
          const message = this.extractIbErrorMessage(args);
          const code = this.extractIbErrorCode(args);
          // Ignore generic connection status broadcasts.
          if (code === 2104 || code === 2106 || code === 2107 || code === 2158) return;
          // No security definition should be treated as "zero results", not a hard bridge failure.
          if (String(message).toLowerCase().includes("no security definition has been found for the request")) {
            cleanup();
            resolve([]);
            return;
          }
          cleanup();
          reject(new Error(`ib_contract_details_error:${message || code || "unknown"}`));
        };

        ib.on(EventName.contractDetails, onDetails);
        ib.on(EventName.contractDetailsEnd, onEnd);
        ib.on(EventName.error, onError);
        ib.reqContractDetails(reqId, targetContract);
      });
    };

    const resolvedDetails: ContractDetails[] = [];
    for (const exchange of exchangeCandidates) {
      for (const symbolCandidate of symbolCandidates) {
        if (query.kind === "mbt_option") {
          const optionContractWithExactExpiry: Contract = {
            secType: SecType.FOP,
            symbol: symbolCandidate,
            exchange,
            currency: query.currency,
            lastTradeDateOrContractMonth: fallbackExpiry,
            strike: Number(query.strike || 0),
            right: query.right
          };

          const optionContractAnyExpiry: Contract = {
            secType: SecType.FOP,
            symbol: symbolCandidate,
            exchange,
            currency: query.currency,
            strike: Number(query.strike || 0),
            right: query.right
          };

          let details = await fetchContractDetails(optionContractWithExactExpiry);
          if (details.length === 0) {
            // Retry without forcing exact expiry (e.g. weekend/holiday tenor target).
            details = await fetchContractDetails(optionContractAnyExpiry);
          }
          resolvedDetails.push(...details);
          continue;
        }

        const futureContractAnyExpiry: Contract = {
          secType: SecType.FUT,
          symbol: symbolCandidate,
          exchange,
          currency: query.currency
        };
        const details = await fetchContractDetails(futureContractAnyExpiry);
        resolvedDetails.push(...details);
      }
    }

    const seenConIds = new Set<number>();
    const mapped = resolvedDetails
      .map((item) => {
        const contract = item.contract || {};
        const secType = String(contract.secType || (query.kind === "mbt_option" ? "FOP" : "FUT")).toUpperCase();
        const strike = positiveOrNull(contract.strike);
        const right = String(contract.right || "").toUpperCase();
        const expiry = normalizeExpiry(
          contract.lastTradeDateOrContractMonth || contract.lastTradeDate || item.contractMonth,
          fallbackExpiry
        );
        const localSymbol = String(contract.localSymbol || `${productSymbol} ${expiry}`).trim();
        const conId = positiveOrNull(contract.conId);
        if (!conId) return null;
        const normalizedRight = right === "P" || right === "C" ? (right as "P" | "C") : undefined;
        const normalizedSecType = secType === "FOP" ? "FOP" : "FUT";
        return {
          conId,
          secType: normalizedSecType,
          localSymbol,
          expiry,
          strike: strike ?? undefined,
          right: normalizedRight,
          multiplier: String(contract.multiplier || "0.1"),
          minTick: positiveOrNull(item.minTick) ?? undefined
        } satisfies BridgeQualifiedContract;
      })
      .filter((row): row is BridgeQualifiedContract => {
        if (!row) return false;
        if (seenConIds.has(row.conId)) return false;
        seenConIds.add(row.conId);
        return true;
      });

    const targetExpiryNum = Number(fallbackExpiry);
    const sortedByNearestTenor = [...mapped].sort((a, b) => {
      const aExp = Number(a.expiry || 0);
      const bExp = Number(b.expiry || 0);
      const aScore = Number.isFinite(aExp) ? (aExp >= targetExpiryNum ? aExp - targetExpiryNum : 1_000_000 + targetExpiryNum - aExp) : 9_000_000;
      const bScore = Number.isFinite(bExp) ? (bExp >= targetExpiryNum ? bExp - targetExpiryNum : 1_000_000 + targetExpiryNum - bExp) : 9_000_000;
      if (aScore !== bScore) return aScore - bScore;
      return aExp - bExp;
    });

    if (query.kind === "mbt_option") {
      const targetStrike = positiveOrNull(query.strike);
      const targetRight = query.right;
      return sortedByNearestTenor.filter((row) => {
        if (row.secType !== "FOP") return false;
        if (targetRight && row.right !== targetRight) return false;
        if (targetStrike && row.strike && Math.abs(row.strike - targetStrike) > 1e-9) return false;
        return true;
      });
    }

    return sortedByNearestTenor.filter((row) => row.secType === "FUT");
  }

  private async getTopOfBookIb(conId: number): Promise<BridgeTopOfBook> {
    const ib = await this.requireIb();
    const reqId = this.nextRequestId();
    const contract: Contract = {
      conId,
      exchange: "CME",
      currency: "USD"
    };

    const snapshot = await new Promise<BridgeTopOfBook>((resolve, reject) => {
      const timeoutMs = Math.max(1000, Math.floor(this.config.requestTimeoutMs || 0));
      const state: BridgeTopOfBook = {
        bid: null,
        ask: null,
        bidSize: null,
        askSize: null,
        asOf: nowIso()
      };
      const timeoutHandle = setTimeout(() => {
        cleanup();
        resolve({ ...state, asOf: nowIso() });
      }, timeoutMs);

      const cleanup = (): void => {
        clearTimeout(timeoutHandle);
        ib.off(EventName.tickPrice, onTickPrice);
        ib.off(EventName.tickSize, onTickSize);
        ib.off(EventName.tickSnapshotEnd, onSnapshotEnd);
        ib.off(EventName.error, onError);
        try {
          ib.cancelMktData(reqId);
        } catch {
          // ignore cancellation failures
        }
      };

      const onTickPrice = (eventReqId: number, field: number, value: number): void => {
        if (!this.reqIdMatches(reqId, eventReqId)) return;
        if (!Number.isFinite(value) || value <= 0) return;
        if (field === 1 || field === 66) state.bid = value;
        if (field === 2 || field === 67) state.ask = value;
      };

      const onTickSize = (eventReqId: number, field?: number, value?: number): void => {
        if (!this.reqIdMatches(reqId, eventReqId)) return;
        if (!Number.isFinite(Number(value))) return;
        if (field === 0 || field === 69) state.bidSize = Number(value);
        if (field === 3 || field === 70) state.askSize = Number(value);
      };

      const onSnapshotEnd = (eventReqId: number): void => {
        if (!this.reqIdMatches(reqId, eventReqId)) return;
        cleanup();
        resolve({ ...state, asOf: nowIso() });
      };

      const onError = (...args: unknown[]): void => {
        const eventReqId = this.extractIbReqId(args);
        if (!this.reqIdMatches(reqId, eventReqId) && !this.reqIdMatches(-1, eventReqId)) return;
        const code = this.extractIbErrorCode(args);
        const message = this.extractIbErrorMessage(args);
        if (code === 2104 || code === 2106 || code === 2107 || code === 2158 || code === 10167) return;
        cleanup();
        reject(new Error(`ib_mktdata_error:${message || code || "unknown"}`));
      };

      ib.on(EventName.tickPrice, onTickPrice);
      ib.on(EventName.tickSize, onTickSize);
      ib.on(EventName.tickSnapshotEnd, onSnapshotEnd);
      ib.on(EventName.error, onError);
      ib.reqMktData(reqId, contract, "", true, false);
    });

    return snapshot;
  }

  private async getDepthIb(conId: number): Promise<BridgeDepth> {
    const ib = await this.requireIb();
    const reqId = this.nextRequestId();
    const contract: Contract = {
      conId,
      exchange: "CME",
      currency: "USD"
    };
    const bidsByLevel = new Map<number, DepthRow>();
    const asksByLevel = new Map<number, DepthRow>();

    await new Promise<void>((resolve, reject) => {
      const timeoutMs = Math.max(1000, Math.floor(this.config.requestTimeoutMs || 0));
      const timeoutHandle = setTimeout(() => {
        cleanup();
        resolve();
      }, timeoutMs);

      const cleanup = (): void => {
        clearTimeout(timeoutHandle);
        ib.off(EventName.updateMktDepth, onDepth);
        ib.off(EventName.updateMktDepthL2, onDepthL2);
        ib.off(EventName.error, onError);
        try {
          ib.cancelMktDepth(reqId, false);
        } catch {
          // ignore
        }
      };

      const applyLevel = (position: number, operation: number, side: number, price: number, size: number): void => {
        const target = side === 1 ? bidsByLevel : asksByLevel;
        if (operation === 2 || !Number.isFinite(price) || !Number.isFinite(size) || size <= 0 || price <= 0) {
          target.delete(position);
          return;
        }
        target.set(position, { level: position, price, size });
      };

      const onDepth = (
        eventReqId: number,
        position: number,
        operation: number,
        side: number,
        price: number,
        size: number
      ): void => {
        if (!this.reqIdMatches(reqId, eventReqId)) return;
        applyLevel(position, operation, side, price, size);
      };

      const onDepthL2 = (
        eventReqId: number,
        position: number,
        _marketMaker: string,
        operation: number,
        side: number,
        price: number,
        size: number
      ): void => {
        if (!this.reqIdMatches(reqId, eventReqId)) return;
        applyLevel(position, operation, side, price, size);
      };

      const onError = (...args: unknown[]): void => {
        const eventReqId = this.extractIbReqId(args);
        if (!this.reqIdMatches(reqId, eventReqId) && !this.reqIdMatches(-1, eventReqId)) return;
        const code = this.extractIbErrorCode(args);
        const message = this.extractIbErrorMessage(args);
        if (code === 2104 || code === 2106 || code === 2107 || code === 2158 || code === 309) return;
        cleanup();
        reject(new Error(`ib_depth_error:${message || code || "unknown"}`));
      };

      ib.on(EventName.updateMktDepth, onDepth);
      ib.on(EventName.updateMktDepthL2, onDepthL2);
      ib.on(EventName.error, onError);
      ib.reqMktDepth(reqId, contract, 5, false);
    });

    const bids = Array.from(bidsByLevel.values()).sort((a, b) => a.level - b.level).slice(0, 5);
    const asks = Array.from(asksByLevel.values()).sort((a, b) => a.level - b.level).slice(0, 5);

    // Avoid recursively invoking top-of-book here. The API quote path already probes top
    // and depth, so calling top again from depth can add another full timeout window.
    return { bids, asks, asOf: nowIso() };
  }

  private async placeOrderIb(req: BridgePlaceOrderRequest): Promise<{ orderId: string; submittedAt: string }> {
    const ib = await this.requireIb();
    const orderId = await this.requireOrderId();
    const externalOrderId = String(orderId);
    this.orderIdToExternalId.set(orderId, externalOrderId);
    this.ordersByExternalId.set(externalOrderId, {
      orderId: externalOrderId,
      status: "submitted",
      filledQuantity: 0,
      avgFillPrice: null,
      lastUpdateAt: nowIso()
    });

    const contract: Contract = {
      conId: req.conId,
      exchange: "CME",
      currency: "USD"
    };
    ib.placeOrder(orderId, contract, {
      orderId,
      action: req.side as OrderAction,
      orderType: req.orderType as OrderType,
      totalQuantity: req.quantity,
      lmtPrice: req.limitPrice,
      tif: req.tif as TimeInForce,
      account: req.accountId,
      orderRef: req.clientOrderId,
      transmit: true
    });

    return { orderId: externalOrderId, submittedAt: nowIso() };
  }

  private async getOrderIb(orderId: string): Promise<BridgeOrderState> {
    const current = this.ordersByExternalId.get(orderId);
    if (current) {
      return {
        ...current,
        avgFillPrice: finiteOrNull(current.avgFillPrice),
        lastUpdateAt: nowIso()
      };
    }
    return {
      orderId,
      status: "submitted",
      filledQuantity: 0,
      avgFillPrice: null,
      lastUpdateAt: nowIso()
    };
  }

  private async cancelOrderIb(orderId: string): Promise<{ cancelled: boolean; asOf: string }> {
    const current = this.ordersByExternalId.get(orderId);
    if (current && isTerminalOrderStatus(current.status)) {
      return { cancelled: false, asOf: nowIso() };
    }
    const numericOrderId = Number(orderId);
    const ib = await this.requireIb();
    if (Number.isFinite(numericOrderId) && numericOrderId > 0) {
      ib.cancelOrder(Math.floor(numericOrderId));
    }
    const updated = this.ordersByExternalId.get(orderId);
    this.ordersByExternalId.set(orderId, {
      orderId,
      status: "cancelled",
      filledQuantity: updated?.filledQuantity ?? 0,
      avgFillPrice: finiteOrNull(updated?.avgFillPrice),
      lastUpdateAt: nowIso(),
      rejectionReason: updated?.rejectionReason,
      commissionUsd: updated?.commissionUsd ?? null,
      commissionCurrency: updated?.commissionCurrency ?? null,
      commissionUpdatedAt: updated?.commissionUpdatedAt ?? null
    });
    return { cancelled: true, asOf: nowIso() };
  }
}
