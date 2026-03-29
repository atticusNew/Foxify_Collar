import Fastify from "fastify";
import { z } from "zod";
import { IbGatewayClient } from "./ibGatewayClient";
import type {
  BridgeContractQuery,
  BridgeTransportMode,
  BridgeOrderPlaceRequest
} from "./types";

const healthResponseSchema = z.object({
  ok: z.boolean(),
  session: z.union([z.literal("connected"), z.literal("disconnected")]),
  transport: z.union([z.literal("synthetic"), z.literal("ib_socket")]),
  activeTransport: z.union([
    z.literal("synthetic"),
    z.literal("ib_socket"),
    z.literal("synthetic_fallback")
  ]),
  fallbackEnabled: z.boolean(),
  lastError: z.string().optional(),
  lastFallbackReason: z.string().optional(),
  asOf: z.string()
});

const qualifySchema = z.object({
  kind: z.union([z.literal("mbt_future"), z.literal("mbt_option")]),
  productFamily: z.union([z.literal("MBT"), z.literal("BFF")]).optional(),
  symbol: z.literal("BTC"),
  exchange: z.literal("CME"),
  currency: z.literal("USD"),
  tenorDays: z.number().int().min(1).max(30),
  right: z.union([z.literal("P"), z.literal("C")]).optional(),
  strike: z.number().positive().optional()
});

const conIdSchema = z.object({
  conId: z.number().int().positive()
});

const placeOrderSchema = z.object({
  accountId: z.string().trim().min(1),
  conId: z.number().int().positive(),
  side: z.union([z.literal("BUY"), z.literal("SELL")]),
  quantity: z.number().positive(),
  orderType: z.literal("LMT"),
  limitPrice: z.number().positive(),
  tif: z.union([z.literal("DAY"), z.literal("IOC")]),
  clientOrderId: z.string().trim().min(1)
});

const authToken = String(process.env.IBKR_BRIDGE_TOKEN || "").trim();
const bridgeRequireAuth = process.env.IBKR_BRIDGE_REQUIRE_AUTH !== "false";
const bridgePort = Number(process.env.IBKR_BRIDGE_PORT || "18080");
const bridgeHost = String(process.env.IBKR_BRIDGE_HOST || "0.0.0.0");
const gatewayHost = String(process.env.IBKR_GATEWAY_HOST || "127.0.0.1");
const gatewayPort = Number(process.env.IBKR_GATEWAY_PORT || "4002");
const gatewayClientId = Number(process.env.IBKR_GATEWAY_CLIENT_ID || "101");
const bridgeReadonlyMode = process.env.IBKR_BRIDGE_READONLY === "true";
const bridgeTransportModeRaw = String(process.env.IBKR_BRIDGE_TRANSPORT || "synthetic").trim();
const bridgeTransportMode: BridgeTransportMode =
  bridgeTransportModeRaw === "ib_socket" ? "ib_socket" : "synthetic";
const bridgeFallbackToSynthetic = process.env.IBKR_BRIDGE_FALLBACK_TO_SYNTHETIC !== "false";
const gatewayConnectTimeoutMs = Number(process.env.IBKR_GATEWAY_CONNECT_TIMEOUT_MS || "5000");
const gatewayRequestTimeoutMs = Number(process.env.IBKR_GATEWAY_REQUEST_TIMEOUT_MS || "6000");
const gatewayMarketDataTypeRaw = Number(process.env.IBKR_MARKET_DATA_TYPE || "1");
const gatewayMarketDataType =
  gatewayMarketDataTypeRaw === 2 ||
  gatewayMarketDataTypeRaw === 3 ||
  gatewayMarketDataTypeRaw === 4
    ? gatewayMarketDataTypeRaw
    : 1;

const ibGatewayClient = new IbGatewayClient({
  host: gatewayHost,
  port: Number.isFinite(gatewayPort) ? gatewayPort : 4002,
  clientId: Number.isFinite(gatewayClientId) ? gatewayClientId : 101,
  readonlyMode: bridgeReadonlyMode,
  transportMode: bridgeTransportMode,
  fallbackToSynthetic: bridgeFallbackToSynthetic,
  connectTimeoutMs: Number.isFinite(gatewayConnectTimeoutMs) ? gatewayConnectTimeoutMs : 5000,
  requestTimeoutMs: Number.isFinite(gatewayRequestTimeoutMs) ? gatewayRequestTimeoutMs : 6000,
  marketDataType: gatewayMarketDataType
});

const app = Fastify({ logger: true });

app.addHook("onRequest", async (req, reply) => {
  if (!bridgeRequireAuth) return;
  if (!authToken) {
    reply.code(503).send({
      status: "error",
      reason: "bridge_auth_not_configured"
    });
    return;
  }
  const header = String(req.headers.authorization || "");
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (token !== authToken) {
    reply.code(401).send({
      status: "error",
      reason: "unauthorized_bridge"
    });
    return;
  }
});

app.get("/health", async () => {
  const health = await ibGatewayClient.getHealth();
  return healthResponseSchema.parse(health);
});

app.post("/contracts/qualify", async (req) => {
  const payload = qualifySchema.parse(req.body || {}) as BridgeContractQuery;
  const contracts = await ibGatewayClient.qualifyContracts(payload);
  return { contracts };
});

app.post("/marketdata/top", async (req) => {
  const payload = conIdSchema.parse(req.body || {});
  return await ibGatewayClient.getTopOfBook(payload.conId);
});

app.post("/marketdata/depth", async (req) => {
  const payload = conIdSchema.parse(req.body || {});
  return await ibGatewayClient.getDepth(payload.conId);
});

app.post("/orders/place", async (req) => {
  const payload = placeOrderSchema.parse(req.body || {}) as BridgeOrderPlaceRequest;
  return await ibGatewayClient.placeOrder(payload);
});

app.get("/orders/:orderId", async (req) => {
  const params = req.params as { orderId?: string };
  const payload = z.object({ orderId: z.string().trim().min(1) }).parse(params);
  return await ibGatewayClient.getOrder(payload.orderId);
});

app.post("/orders/:orderId/cancel", async (req) => {
  const params = req.params as { orderId?: string };
  const payload = z.object({ orderId: z.string().trim().min(1) }).parse(params);
  return await ibGatewayClient.cancelOrder(payload.orderId);
});

const start = async (): Promise<void> => {
  await app.listen({ port: bridgePort, host: bridgeHost });
};

start().catch((error) => {
  app.log.error(error, "broker-bridge-startup-failed");
  process.exit(1);
});
