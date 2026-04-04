import { BullishTradingClient } from "../src/pilot/bullish";

type Args = {
  symbol: string;
  withPrivateWs: boolean;
  withPublicWs: boolean;
  placeTestOrder: boolean;
  cancelTestOrder: boolean;
};

const parseBoolean = (raw: string | undefined, fallback: boolean): boolean => {
  const normalized = String(raw ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  return fallback;
};

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    symbol: process.env.BULLISH_SMOKE_SYMBOL || "BTCUSDC",
    withPrivateWs: false,
    withPublicWs: false,
    placeTestOrder: false,
    cancelTestOrder: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--symbol" && argv[i + 1]) {
      args.symbol = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--with-private-ws" && argv[i + 1]) {
      args.withPrivateWs = parseBoolean(argv[i + 1], false);
      i += 1;
      continue;
    }
    if (token === "--with-public-ws" && argv[i + 1]) {
      args.withPublicWs = parseBoolean(argv[i + 1], false);
      i += 1;
      continue;
    }
    if (token === "--place-test-order" && argv[i + 1]) {
      args.placeTestOrder = parseBoolean(argv[i + 1], false);
      i += 1;
      continue;
    }
    if (token === "--cancel-test-order" && argv[i + 1]) {
      args.cancelTestOrder = parseBoolean(argv[i + 1], false);
      i += 1;
      continue;
    }
  }
  return args;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const authMode =
    (process.env.PILOT_BULLISH_AUTH_MODE || process.env.BULLISH_AUTH_METHOD || "ecdsa").trim().toLowerCase() === "hmac"
      ? "hmac"
      : "ecdsa";
  const client = new BullishTradingClient({
    enabled: true,
    restBaseUrl:
      process.env.PILOT_BULLISH_REST_BASE_URL ||
      process.env.PILOT_BULLISH_API_HOSTNAME ||
      process.env.BULLISH_TESTNET_API_HOSTNAME ||
      process.env.BULLISH_API_HOSTNAME ||
      "",
    publicWsUrl:
      process.env.PILOT_BULLISH_PUBLIC_WS_URL ||
      process.env.BULLISH_TESTNET_PUBLIC_WS_URL ||
      process.env.BULLISH_PUBLIC_WS_URL ||
      "",
    privateWsUrl:
      process.env.PILOT_BULLISH_PRIVATE_WS_URL ||
      process.env.BULLISH_TESTNET_PRIVATE_WS_URL ||
      process.env.BULLISH_PRIVATE_WS_URL ||
      "",
    authMode,
    ecdsaPublicKey: process.env.PILOT_BULLISH_ECDSA_PUBLIC_KEY || "",
    ecdsaPrivateKey: process.env.PILOT_BULLISH_ECDSA_PRIVATE_KEY || "",
    ecdsaMetadata: process.env.PILOT_BULLISH_ECDSA_METADATA || "",
    hmacPublicKey: process.env.PILOT_BULLISH_HMAC_PUBLIC_KEY || process.env.BULLISH_HMAC_PUBLIC_KEY || "",
    hmacSecret: process.env.PILOT_BULLISH_HMAC_SECRET || process.env.BULLISH_HMAC_SECRET || "",
    tradingAccountId: process.env.PILOT_BULLISH_TRADING_ACCOUNT_ID || process.env.BULLISH_TRADING_ACCOUNT_ID || "",
    defaultSymbol:
      process.env.PILOT_BULLISH_DEFAULT_SYMBOL || process.env.BULLISH_SMOKE_SYMBOL || "BTCUSDC",
    symbolByMarketId: {
      "BTC-USD":
        process.env.PILOT_BULLISH_SYMBOL_BTC_USD || process.env.PILOT_BULLISH_DEFAULT_SYMBOL || "BTCUSDC"
    },
    orderTimeoutMs: Number(process.env.PILOT_BULLISH_ORDER_TIMEOUT_MS || process.env.BULLISH_TIMEOUT_MS || "5000"),
    orderTif: (process.env.PILOT_BULLISH_ORDER_TIF || "GTC").trim() || "GTC",
    allowMargin: String(process.env.PILOT_BULLISH_ALLOW_MARGIN || "false").trim().toLowerCase() === "true",
    hmacLoginPath: "/trading-api/v1/users/hmac/login",
    ecdsaLoginPath: "/trading-api/v2/users/login",
    tradingAccountsPath: "/trading-api/v1/accounts/trading-accounts",
    orderbookPathTemplate: "/trading-api/v1/markets/:symbol/orderbook/hybrid",
    commandPath: "/trading-api/v2/command",
    noncePath: "/nonce"
  });

  const summary: Record<string, unknown> = {
    status: "ok",
    symbol: args.symbol,
    steps: {} as Record<string, unknown>
  };
  const steps = summary.steps as Record<string, unknown>;

  const accountsPayload = await client.getTradingAccounts();
  const accounts = Array.isArray((accountsPayload as any)?.data)
    ? ((accountsPayload as any).data as Array<Record<string, unknown>>)
    : Array.isArray(accountsPayload)
      ? (accountsPayload as Array<Record<string, unknown>>)
      : [];
  steps.auth = {
    mode: authMode === "ecdsa" ? "jwt_via_ecdsa_login" : "jwt_via_hmac_login"
  };
  steps.tradingAccounts = {
    count: accounts.length,
    tradingAccountIds: accounts.map((item) => String(item.tradingAccountId || ""))
  };

  const orderbook = await client.getHybridOrderBook(args.symbol);
  steps.orderbook = {
    bids: orderbook.bids.slice(0, 3),
    asks: orderbook.asks.slice(0, 3),
    sequenceNumber: orderbook.sequenceNumber,
    timestamp: orderbook.timestamp
  };

  if (args.withPublicWs) {
    steps.publicWs = await client.waitForPublicOrderbookSnapshot({
      symbol: args.symbol,
      topic: "l2Orderbook"
    });
  }

  if (args.withPrivateWs) {
    steps.privateWs = await client.waitForPrivateTopicSnapshot({
      topic: "tradingAccounts"
    });
  }

  if (args.placeTestOrder) {
    const tradingAccountId =
      client.getConfiguredTradingAccountId() || String(accounts[0]?.tradingAccountId || "");
    if (!tradingAccountId) {
      throw new Error("bullish_smoke_missing_trading_account_id");
    }
    const created = await client.createSpotLimitOrder({
      symbol: args.symbol,
      side: "BUY",
      price: process.env.BULLISH_SMOKE_LIMIT_PRICE || "1.0000",
      quantity: process.env.BULLISH_SMOKE_LIMIT_QUANTITY || "0.00010000"
    });
    steps.createOrder = created;
    if (args.cancelTestOrder) {
      const orderId =
        typeof created?.orderId === "string" && created.orderId
          ? created.orderId
          : typeof created?.data?.orderId === "string"
            ? created.data.orderId
            : "";
      if (!orderId) {
        throw new Error("bullish_smoke_missing_order_id_for_cancel");
      }
      steps.cancelOrder = await client.cancelOrder({
        orderId,
        symbol: args.symbol
      });
    }
  }

  console.log(JSON.stringify(summary, null, 2));
};

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        status: "error",
        reason: "bullish_smoke_failed",
        message: String((error as Error)?.message || error)
      },
      null,
      2
    )
  );
  process.exit(1);
});
