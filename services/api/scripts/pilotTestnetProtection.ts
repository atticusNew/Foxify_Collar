import { BullishTradingClient } from "../src/pilot/bullish";

const config = {
  enabled: true,
  restBaseUrl: process.env.PILOT_BULLISH_REST_BASE_URL || "https://api.simnext.bullish-test.com",
  publicWsUrl: "wss://api.simnext.bullish-test.com/trading-api/v1/market-data/orderbook",
  privateWsUrl: "wss://api.simnext.bullish-test.com/trading-api/v1/private-data",
  authMode: "ecdsa" as const,
  hmacPublicKey: "",
  hmacSecret: "",
  ecdsaPublicKey: process.env.PILOT_BULLISH_ECDSA_PUBLIC_KEY || "",
  ecdsaPrivateKey: process.env.PILOT_BULLISH_ECDSA_PRIVATE_KEY || "",
  ecdsaMetadata: process.env.PILOT_BULLISH_ECDSA_METADATA || "",
  tradingAccountId: process.env.PILOT_BULLISH_TRADING_ACCOUNT_ID || "",
  defaultSymbol: "BTCUSDC",
  symbolByMarketId: { "BTC-USD": "BTCUSDC" } as Record<string, string>,
  hmacLoginPath: "/trading-api/v1/users/hmac/login",
  ecdsaLoginPath: "/trading-api/v2/users/login",
  tradingAccountsPath: "/trading-api/v1/accounts/trading-accounts",
  noncePath: "/nonce",
  commandPath: "/trading-api/v2/command",
  orderbookPathTemplate: "/trading-api/v1/markets/:symbol/orderbook/hybrid",
  enableExecution: true,
  orderTimeoutMs: 10000,
  orderTif: "GTC" as const,
  allowMargin: false
};

const main = async () => {
  const client = new BullishTradingClient(config);

  console.log("================================================================");
  console.log("  LIVE TESTNET PROTECTION EXECUTION");
  console.log("  " + new Date().toISOString());
  console.log("================================================================\n");

  console.log("STEP 1: Reference price from Bullish BTCUSDC...");
  const spotBook = await client.getHybridOrderBook("BTCUSDC");
  const spotBid = parseFloat(spotBook.bids[0]?.price || "0");
  const spotAsk = parseFloat(spotBook.asks[0]?.price || "0");
  const spotMid = (spotBid + spotAsk) / 2;
  console.log(`  Bid: $${spotBid.toFixed(2)} | Ask: $${spotAsk.toFixed(2)} | Mid: $${spotMid.toFixed(2)}\n`);

  const notional = 5000;
  const floor = 0.20;
  const premiumPer1k = 11;
  const premium = (notional / 1000) * premiumPer1k;
  const btcQty = notional / spotMid;
  const triggerPrice = spotMid * (1 - floor);
  const maxPayout = notional * floor;

  console.log("STEP 2: Position parameters");
  console.log(`  Notional:       $${notional.toLocaleString()}`);
  console.log(`  Floor:          ${floor * 100}%`);
  console.log(`  Trigger price:  $${triggerPrice.toFixed(2)}`);
  console.log(`  Max payout:     $${maxPayout.toFixed(2)}`);
  console.log(`  Premium:        $${premium.toFixed(2)} ($${premiumPer1k}/1k)`);
  console.log(`  BTC qty:        ${btcQty.toFixed(8)} BTC\n`);

  console.log("STEP 3: Scanning Bullish option chain...");
  const markets = await client.getMarkets({ forceRefresh: true });
  const now = Date.now();
  const puts = markets
    .filter((m) => {
      const sym = m.symbol || "";
      if (!sym.match(/^BTC-USDC-\d{8}-\d+-P$/)) return false;
      const exp = Date.parse(m.expiryDatetime || "");
      if (!exp || exp <= now) return false;
      const days = (exp - now) / 86400000;
      return days >= 3 && days <= 10 && m.marketEnabled && m.createOrderEnabled;
    })
    .map((m) => {
      const parts = m.symbol.split("-");
      return { symbol: m.symbol, strike: parseFloat(parts[3]), expiry: m.expiryDatetime };
    })
    .filter((p) => p.strike >= spotMid * 0.85 && p.strike <= spotMid * 1.02)
    .sort((a, b) => a.strike - b.strike);

  console.log(`  Found ${puts.length} candidate puts`);

  type PutCandidate = { symbol: string; strike: number; expiry: string | undefined; askPx: number; askQty: number; hedgeCost: number; spread: number };
  let bestPut: PutCandidate | null = null;

  for (const put of puts) {
    const book = await client.getHybridOrderBook(put.symbol);
    const ask = book.asks[0];
    if (!ask) continue;
    const askPx = parseFloat(ask.price);
    const askQty = parseFloat(ask.quantity);
    if (!askPx || !askQty) continue;
    const hedgeCost = askPx * btcQty;
    const spread = premium - hedgeCost;
    const moneyness = ((put.strike / spotMid) * 100).toFixed(1);
    console.log(
      `  $${put.strike.toLocaleString()} (${moneyness}%) ask=$${askPx.toFixed(0)} qty=${askQty.toFixed(4)} hedge=$${hedgeCost.toFixed(2)} spread=${spread >= 0 ? "+" : ""}$${spread.toFixed(2)}`
    );
    if (spread > 0 && (!bestPut || hedgeCost < bestPut.hedgeCost)) {
      bestPut = { ...put, askPx, askQty, hedgeCost, spread };
    }
  }

  if (!bestPut) {
    console.log("  No spread-positive put. Picking cheapest...");
    for (const put of puts) {
      const book = await client.getHybridOrderBook(put.symbol);
      const ask = book.asks[0];
      if (!ask) continue;
      const askPx = parseFloat(ask.price);
      const askQty = parseFloat(ask.quantity);
      const hedgeCost = askPx * btcQty;
      if (!bestPut || hedgeCost < bestPut.hedgeCost) {
        bestPut = { ...put, askPx, askQty, hedgeCost, spread: premium - hedgeCost };
      }
    }
  }

  if (!bestPut) {
    console.log("  ERROR: No puts available.");
    process.exit(1);
  }

  console.log(`\n  >>> SELECTED: ${bestPut.symbol}`);
  console.log(`      Strike: $${bestPut.strike.toLocaleString()} | Ask: $${bestPut.askPx.toFixed(2)} | Hedge: $${bestPut.hedgeCost.toFixed(2)} | Spread: ${bestPut.spread >= 0 ? "+" : ""}$${bestPut.spread.toFixed(2)}`);
  console.log(`      Expiry: ${bestPut.expiry}\n`);

  console.log("STEP 4: Account balance before...");
  try {
    const balances = await client.getAssetBalances({ timeoutMs: 8000 });
    for (const b of balances) {
      if (["USDC", "BTC", "USD"].includes(b.assetSymbol)) {
        console.log(`  ${b.assetSymbol}: ${b.availableQuantity} (locked: ${b.lockedQuantity})`);
      }
    }
  } catch (e: any) {
    console.log(`  Balance check skipped: ${e.message}`);
  }

  console.log("\nSTEP 5: PLACING HEDGE ORDER...");
  console.log(`  Symbol:   ${bestPut.symbol}`);
  console.log(`  Side:     BUY`);
  console.log(`  Price:    $${bestPut.askPx.toFixed(4)}`);
  console.log(`  Quantity: ${btcQty.toFixed(8)} BTC\n`);

  const clientOrderId = String(BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)));

  const [orderResult, fillResult] = await Promise.all([
    client.createSpotLimitOrder({
      symbol: bestPut.symbol,
      side: "BUY",
      price: bestPut.askPx.toFixed(4),
      quantity: btcQty.toFixed(8),
      clientOrderId
    }),
    client.waitForOrderFill({ clientOrderId, timeoutMs: 15000 }).catch((e: any) => ({
      status: "error" as const,
      orderId: null,
      fillPrice: null,
      fillQuantity: null,
      fees: null,
      orderStatus: null,
      raw: { error: e.message }
    }))
  ]);

  const orderRecord = orderResult as Record<string, unknown>;
  const orderId = String(
    orderRecord.orderId ||
      (orderRecord.data as Record<string, unknown> | undefined)?.orderId ||
      "unknown"
  );

  console.log("  ORDER RESPONSE:");
  console.log(JSON.stringify(orderResult, null, 2));
  console.log("\n  FILL CONFIRMATION:");
  console.log(JSON.stringify(fillResult, null, 2));

  console.log("\n================================================================");
  console.log("  PROTECTION EXECUTION SUMMARY");
  console.log("================================================================\n");
  console.log(`  Reference Price:    $${spotMid.toFixed(2)} (Bullish BTCUSDC mid)`);
  console.log(`  Position:           $${notional.toLocaleString()} long, 20% drawdown floor`);
  console.log(`  Trigger Price:      $${triggerPrice.toFixed(2)}`);
  console.log(`  Max Payout:         $${maxPayout.toFixed(2)}`);
  console.log(`  Premium Charged:    $${premium.toFixed(2)}`);
  console.log(`  Hedge Instrument:   ${bestPut.symbol}`);
  console.log(`  Hedge Strike:       $${bestPut.strike.toLocaleString()}`);
  console.log(`  Hedge Cost:         $${bestPut.hedgeCost.toFixed(2)}`);
  console.log(`  Spread:             ${bestPut.spread >= 0 ? "+" : ""}$${bestPut.spread.toFixed(2)}`);
  console.log(`  Order ID:           ${orderId}`);
  console.log(`  Fill Status:        ${fillResult.status}`);
  if (fillResult.fillPrice) console.log(`  Fill Price:         $${fillResult.fillPrice}`);
  if (fillResult.fillQuantity) console.log(`  Fill Quantity:      ${fillResult.fillQuantity} BTC`);
  if (fillResult.fees) console.log(`  Fees:               base=${fillResult.fees.baseFee} quote=${fillResult.fees.quoteFee}`);

  console.log("");
  if (fillResult.status === "filled") {
    console.log("  >>> PROTECTION ACTIVE");
    console.log(`  >>> Platform owns ${bestPut.symbol} put option`);
    console.log(`  >>> If BTC drops below $${triggerPrice.toFixed(0)}, Atticus pays user $${maxPayout}`);
    console.log(`  >>> Put covers payout + profits on approach drops`);
  } else if (orderId !== "unknown") {
    console.log(`  >>> Order placed (ID: ${orderId}), fill ${fillResult.status}`);
    console.log("  >>> Check order status on Bullish SimNext dashboard");
  } else {
    console.log("  >>> Order may not have been accepted. Review response above.");
  }
};

main().catch((e) => {
  console.error("Fatal:", e.message);
  console.error(e.stack);
  process.exit(1);
});
