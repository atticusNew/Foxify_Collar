export type BridgeSessionState = "connected" | "disconnected";
export type BridgeTransportMode = "synthetic" | "ib_socket";
export type BridgeActiveTransport = "synthetic" | "ib_socket" | "synthetic_fallback";

export type BridgeHealth = {
  ok: boolean;
  session: BridgeSessionState;
  transport: BridgeTransportMode;
  activeTransport: BridgeActiveTransport;
  fallbackEnabled: boolean;
  lastError?: string;
  lastFallbackReason?: string;
  asOf: string;
};

export type BridgeInstrumentKind = "mbt_future" | "mbt_option";
export type BridgeOptionRight = "P" | "C";

export type BridgeContractQuery = {
  kind: BridgeInstrumentKind;
  symbol: "BTC";
  exchange: "CME";
  currency: "USD";
  tenorDays: number;
  right?: BridgeOptionRight;
  strike?: number;
};

export type BridgeQualifiedContract = {
  conId: number;
  secType: "FUT" | "FOP";
  localSymbol: string;
  expiry: string;
  strike?: number;
  right?: BridgeOptionRight;
  multiplier: string;
  minTick?: number;
};

export type BridgeTopOfBook = {
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  asOf: string;
};

export type BridgeDepthLevel = {
  level: number;
  price: number;
  size: number;
};

export type BridgeDepth = {
  bids: BridgeDepthLevel[];
  asks: BridgeDepthLevel[];
  asOf: string;
};

export type BridgePlaceOrderRequest = {
  accountId: string;
  conId: number;
  side: "BUY" | "SELL";
  quantity: number;
  orderType: "LMT";
  limitPrice: number;
  tif: "DAY" | "IOC";
  clientOrderId: string;
};

export type BridgeOrderStatus =
  | "submitted"
  | "partially_filled"
  | "filled"
  | "cancelled"
  | "rejected"
  | "inactive";

export type BridgeOrderState = {
  orderId: string;
  status: BridgeOrderStatus;
  filledQuantity: number;
  avgFillPrice: number | null;
  commissionUsd?: number | null;
  commissionCurrency?: string | null;
  commissionExecId?: string | null;
  lastUpdateAt: string;
  rejectionReason?: string;
};

export type BridgeTopRequest = { conId: number };
export type BridgeDepthRequest = { conId: number };
export type BridgeOrderRequest = { orderId: string };
export type BridgeOrderPlaceRequest = BridgePlaceOrderRequest;

export type BridgeTopOfBookResponse = BridgeTopOfBook;
export type BridgeDepthResponse = BridgeDepth;
