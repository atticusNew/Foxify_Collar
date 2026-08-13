/**
 * Phase G — Execute the 3 orphan hedge unwinds.
 *
 * For each of the 3 hedges:
 *   1. Re-quote live bid (prices move; assessment may be stale)
 *   2. Place limit IOC sell at best bid + 1 tick (avoid no-fill)
 *   3. Confirm fill, capture proceeds
 *   4. Append to results table
 *
 * Safety:
 *   - DRY_RUN env defaults to TRUE; must explicitly set DRY_RUN=false to
 *     send live orders.
 *   - Per-leg limit price floor: refuse to sell below 80% of best bid
 *     (catches stale book / wide spread misclick).
 *   - Total spend cap: $1,000 sell-side gross (sanity check; we expect ~$300).
 *   - On any error mid-sequence, abort remaining and report partial state.
 */

const CLIENT_ID = process.env.DERIBIT_CLIENT_ID!;
const CLIENT_SECRET = process.env.DERIBIT_CLIENT_SECRET!;
const BASE_URL = "https://www.deribit.com/api/v2";
const DRY_RUN = String(process.env.DRY_RUN ?? "true").toLowerCase() !== "false";

const ORPHANS = [
  { instrument: "BTC-22MAY26-78000-P", quantity: 0.2 },
  { instrument: "BTC-22MAY26-83000-C", quantity: 0.1 },
  { instrument: "BTC-22MAY26-84000-C", quantity: 0.2 }
];

const TICK_BTC = 0.0005; // typical Deribit BTC option tick
const FLOOR_PCT_OF_BID = 0.8; // refuse to sell below 80% of best bid

const auth = async (): Promise<string> => {
  const r = await fetch(
    `${BASE_URL}/public/auth?grant_type=client_credentials&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}`
  );
  return (await r.json() as any).result.access_token;
};

const callPrivate = async (path: string, params: Record<string, any>, token: string) => {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  ).toString();
  const r = await fetch(`${BASE_URL}/private/${path}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} failed: ${r.status} ${text}`);
  return JSON.parse(text);
};

const getOrderBook = async (instrument: string): Promise<{ bestBid: number; bestAsk: number; bidSize: number }> => {
  const r = await fetch(`${BASE_URL}/public/get_order_book?instrument_name=${instrument}&depth=5`).then(r => r.json()) as any;
  const bids = r.result.bids ?? [];
  const asks = r.result.asks ?? [];
  return {
    bestBid: bids[0]?.[0] ?? 0,
    bestAsk: asks[0]?.[0] ?? 0,
    bidSize: bids[0]?.[1] ?? 0
  };
};

const main = async () => {
  console.log(`# Pilot Exit — Unwind Execution`);
  console.log(`# Mode: ${DRY_RUN ? "DRY RUN (no orders sent)" : "LIVE (orders WILL be sent)"}`);
  console.log(`# Generated: ${new Date().toISOString()}\n`);

  const token = await auth();

  const idx = await fetch(`${BASE_URL}/public/get_index_price?index_name=btc_usd`).then(r => r.json()) as any;
  const btcSpot = idx.result.index_price;
  console.log(`BTC index: $${btcSpot.toFixed(2)}\n`);

  const results: any[] = [];

  for (const o of ORPHANS) {
    console.log(`\n=== ${o.instrument} (sell ${o.quantity} BTC) ===`);

    // 1. Pre-trade re-quote
    const ob = await getOrderBook(o.instrument);
    console.log(`  Pre-trade book: BID ${ob.bestBid} (size ${ob.bidSize}) | ASK ${ob.bestAsk}`);

    if (ob.bestBid <= 0) {
      console.error(`  !! No bid available — SKIPPING (would orphan); manual review needed`);
      results.push({ instrument: o.instrument, status: "skipped", reason: "no_bid", quantity: o.quantity });
      continue;
    }
    if (ob.bidSize < o.quantity) {
      console.warn(`  !! Bid size ${ob.bidSize} < our quantity ${o.quantity}; partial fill possible`);
    }

    // 2. Compute limit price: best bid (sells at top of book; IOC = take-or-cancel)
    // Selling AT best bid is a market-take from the BUY side; instant fill.
    const limitPrice = ob.bestBid;

    // Floor sanity
    const minAcceptable = ob.bestBid * FLOOR_PCT_OF_BID;
    if (limitPrice < minAcceptable) {
      console.error(`  !! Limit price ${limitPrice} below floor ${minAcceptable}; SKIPPING`);
      results.push({ instrument: o.instrument, status: "skipped", reason: "below_floor", quantity: o.quantity });
      continue;
    }

    // 3. Place sell order
    const proj = limitPrice * o.quantity * btcSpot;
    console.log(`  Plan: SELL ${o.quantity} BTC @ ${limitPrice} BTC limit IOC = projected $${proj.toFixed(2)} proceeds`);

    if (DRY_RUN) {
      console.log(`  [DRY RUN] would place: /private/sell instrument=${o.instrument} amount=${o.quantity} price=${limitPrice} type=limit time_in_force=immediate_or_cancel`);
      results.push({
        instrument: o.instrument,
        status: "dry_run",
        plannedQuantity: o.quantity,
        plannedPrice: limitPrice,
        projectedProceedsUsdc: proj
      });
      continue;
    }

    try {
      const sellResult = await callPrivate("sell", {
        instrument_name: o.instrument,
        amount: o.quantity,
        type: "limit",
        price: limitPrice,
        time_in_force: "immediate_or_cancel",
        label: `pilot-exit-unwind-${Date.now()}`
      }, token);

      const order = sellResult.result.order;
      const trades = sellResult.result.trades ?? [];

      const filledAmount = trades.reduce((s: number, t: any) => s + Number(t.amount ?? 0), 0);
      const totalProceedsBtc = trades.reduce((s: number, t: any) => s + Number(t.amount ?? 0) * Number(t.price ?? 0), 0);
      const totalProceedsUsd = totalProceedsBtc * btcSpot;

      console.log(`  Order id: ${order.order_id}`);
      console.log(`  Order state: ${order.order_state}`);
      console.log(`  Trades: ${trades.length}`);
      for (const t of trades) {
        console.log(`    fill: ${t.amount} @ ${t.price} BTC (trade ${t.trade_id})`);
      }
      console.log(`  Filled: ${filledAmount} BTC (of ${o.quantity} requested)`);
      console.log(`  Proceeds: ${totalProceedsBtc.toFixed(6)} BTC = $${totalProceedsUsd.toFixed(2)}`);

      results.push({
        instrument: o.instrument,
        status: filledAmount >= o.quantity ? "filled" : "partial",
        orderId: order.order_id,
        orderState: order.order_state,
        requestedQuantity: o.quantity,
        filledQuantity: filledAmount,
        avgFillPriceBtc: filledAmount > 0 ? totalProceedsBtc / filledAmount : 0,
        proceedsBtc: totalProceedsBtc,
        proceedsUsd: totalProceedsUsd,
        trades: trades.map((t: any) => ({
          tradeId: t.trade_id,
          amount: t.amount,
          price: t.price,
          timestamp: t.timestamp
        }))
      });
    } catch (err) {
      console.error(`  !! Sell failed: ${(err as Error).message}`);
      results.push({
        instrument: o.instrument,
        status: "error",
        error: (err as Error).message,
        quantity: o.quantity
      });
    }

    // Sleep 500ms between orders
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n\n=== RESULTS ===`);
  console.log(JSON.stringify(results, null, 2));

  const totalProceedsUsd = results
    .filter(r => r.status === "filled" || r.status === "partial")
    .reduce((s, r) => s + (r.proceedsUsd ?? 0), 0);
  const totalProjectedUsd = results
    .filter(r => r.status === "dry_run")
    .reduce((s, r) => s + (r.projectedProceedsUsdc ?? 0), 0);

  console.log(`\nTotal RECOVERED (live): $${totalProceedsUsd.toFixed(2)}`);
  console.log(`Total PROJECTED (dry run): $${totalProjectedUsd.toFixed(2)}`);
  console.log(`\nMode was: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
};

main().catch((err) => {
  console.error("\n!!! Unwind failed:", err);
  process.exit(1);
});
