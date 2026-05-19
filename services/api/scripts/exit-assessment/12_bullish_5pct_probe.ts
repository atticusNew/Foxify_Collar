/**
 * Bullish liquidity & pricing probe for $200k @ 5% put protection.
 *
 * Discovers Bullish BTC option chains across multiple tenors, finds
 * the put strike closest to "5% below current spot", and computes
 * the per-day hedge cost to identify the optimal tenor.
 *
 * READ ONLY (public Bullish API; no auth required).
 *
 * Usage:
 *   tsx scripts/exit-assessment/12_bullish_5pct_probe.ts
 */

const BULLISH_REST = "https://api.exchange.bullish.com";
const DERIBIT_REST = "https://www.deribit.com/api/v2";

const POSITION_NOTIONAL_USD = 200_000;
const TARGET_PUT_PCT = 0.05; // 5% below spot

type BullishMarket = {
  symbol: string;
  marketId?: string;
  marketType?: string;
  optionType?: string;
  optionStrikePrice?: string;
  expiryDatetime?: string;
  underlyingBaseSymbol?: string;
  underlyingQuoteSymbol?: string;
  marketEnabled?: boolean;
  createOrderEnabled?: boolean;
};

const fetchJson = async <T,>(url: string): Promise<T> => {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${url} → ${r.status} ${await r.text().catch(() => "")}`);
  return r.json() as Promise<T>;
};

const log = (label: string, data?: any) => {
  console.log(`\n=== ${label} ===`);
  if (data !== undefined) console.log(typeof data === "string" ? data : JSON.stringify(data, null, 2));
};

const main = async () => {
  console.log("# Bullish $200k @ 5% Put Liquidity & Pricing Probe");
  console.log(`# Generated: ${new Date().toISOString()}\n`);

  // 1. Get current BTC spot from Coinbase (cleaner than Bullish for pricing reference)
  const spotPayload = await fetchJson<any>("https://api.coinbase.com/v2/prices/BTC-USD/spot");
  const btcSpot = Number(spotPayload.data.amount);
  console.log(`BTC spot (Coinbase): $${btcSpot.toFixed(2)}`);
  const targetPutStrike = btcSpot * (1 - TARGET_PUT_PCT);
  console.log(`Target put strike (5% below spot): $${targetPutStrike.toFixed(2)}`);

  // 2. Pull all Bullish markets
  console.log("\nFetching Bullish markets...");
  const markets = await fetchJson<BullishMarket[]>(`${BULLISH_REST}/trading-api/v1/markets`);
  console.log(`  Total markets: ${markets.length}`);

  // 3. Filter to BTC PUT options that are tradable
  const btcPuts = markets.filter(m =>
    m.marketType === "OPTION" &&
    m.optionType === "PUT" &&
    m.underlyingBaseSymbol === "BTC" &&
    m.marketEnabled === true &&
    m.createOrderEnabled === true &&
    m.expiryDatetime &&
    m.optionStrikePrice
  );
  console.log(`  Tradable BTC PUT options: ${btcPuts.length}`);

  if (btcPuts.length === 0) {
    console.log("\n!! No tradable BTC puts found on Bullish — fall back to Deribit.");
    return;
  }

  // 4. Group by expiry, find candidate tenors
  const byExpiry: Record<string, BullishMarket[]> = {};
  for (const p of btcPuts) {
    const e = p.expiryDatetime!;
    if (!byExpiry[e]) byExpiry[e] = [];
    byExpiry[e].push(p);
  }
  const expiries = Object.keys(byExpiry).sort();
  console.log(`\nDistinct expiries (${expiries.length}):`);
  for (const e of expiries) {
    const days = (new Date(e).getTime() - Date.now()) / 86_400_000;
    console.log(`  ${e}  (${days.toFixed(1)} days, ${byExpiry[e].length} put strikes)`);
  }

  // 5. For each expiry, find the strike CLOSEST to target put strike
  const candidates: Array<{
    expiry: string;
    daysToExpiry: number;
    symbol: string;
    strikePrice: number;
    distancePctFromTarget: number;
    distanceFromSpotPct: number;
  }> = [];
  for (const expiry of expiries) {
    const days = (new Date(expiry).getTime() - Date.now()) / 86_400_000;
    if (days < 0.5 || days > 90) continue; // Skip too-near-expiry and far expiries
    const strikes = byExpiry[expiry];
    let closest: BullishMarket | null = null;
    let minDist = Infinity;
    for (const s of strikes) {
      const sp = Number(s.optionStrikePrice);
      const dist = Math.abs(sp - targetPutStrike);
      if (dist < minDist) {
        minDist = dist;
        closest = s;
      }
    }
    if (closest) {
      const sp = Number(closest.optionStrikePrice);
      candidates.push({
        expiry,
        daysToExpiry: days,
        symbol: closest.symbol,
        strikePrice: sp,
        distancePctFromTarget: ((sp - targetPutStrike) / targetPutStrike) * 100,
        distanceFromSpotPct: ((btcSpot - sp) / btcSpot) * 100
      });
    }
  }

  console.log("\nClosest-to-5%-below-spot put per expiry:");
  for (const c of candidates) {
    console.log(
      `  ${c.expiry}  (${c.daysToExpiry.toFixed(1)}d) → ${c.symbol} strike=$${c.strikePrice.toFixed(0)} ` +
      `(${c.distanceFromSpotPct.toFixed(2)}% below spot, ${c.distancePctFromTarget >= 0 ? "+" : ""}${c.distancePctFromTarget.toFixed(2)}% from target)`
    );
  }

  // 6. For each candidate, pull orderbook and compute hedge cost for $200k notional
  console.log(`\n\nLiquidity probe per candidate (sizing for $${POSITION_NOTIONAL_USD} notional):`);
  console.log("=".repeat(120));

  // Need BTC notional: $200k / spot = ~2.5 BTC
  const btcNotionalNeeded = POSITION_NOTIONAL_USD / btcSpot;
  console.log(`BTC notional to hedge: ${btcNotionalNeeded.toFixed(4)} BTC for $${POSITION_NOTIONAL_USD}`);

  const probeResults: Array<{
    expiry: string;
    daysToExpiry: number;
    symbol: string;
    strikePrice: number;
    distanceFromSpotPct: number;
    bestAskPrice: number | null;
    bestAskSizeBtc: number | null;
    askDepthForOrderBtc: number;
    fillablePct: number;
    avgFillPriceUsd: number | null;
    totalCostUsd: number | null;
    perDayCostUsd: number | null;
    bestBidPrice: number | null;
    midPrice: number | null;
  }> = [];

  for (const c of candidates) {
    // Try the hybrid orderbook first (preferred), fall back to standard
    let ob: any = null;
    try {
      ob = await fetchJson<any>(`${BULLISH_REST}/trading-api/v1/markets/${c.symbol}/orderbook/hybrid?depth=10`);
    } catch (e) {
      try {
        ob = await fetchJson<any>(`${BULLISH_REST}/trading-api/v1/markets/${c.symbol}/orderbook?depth=10`);
      } catch (e2) {
        console.log(`  ${c.symbol}: orderbook unavailable (${(e2 as Error).message.slice(0, 80)})`);
        continue;
      }
    }

    const asks = (ob.asks ?? ob.askLevels ?? ob.sell ?? []) as Array<any>;
    const bids = (ob.bids ?? ob.bidLevels ?? ob.buy ?? []) as Array<any>;

    const parseLevel = (l: any): { price: number; size: number } | null => {
      if (Array.isArray(l)) return { price: Number(l[0]), size: Number(l[1]) };
      if (l && typeof l === "object") {
        const price = Number(l.price ?? l.p ?? l[0]);
        // Bullish uses priceLevelQuantity for size on hybrid orderbook
        const size = Number(l.priceLevelQuantity ?? l.quantity ?? l.size ?? l.q ?? l[1]);
        if (Number.isFinite(price) && Number.isFinite(size)) return { price, size };
      }
      return null;
    };
    const askLevels = asks.map(parseLevel).filter(Boolean) as Array<{ price: number; size: number }>;
    const bidLevels = bids.map(parseLevel).filter(Boolean) as Array<{ price: number; size: number }>;

    const bestAsk = askLevels[0] ?? null;
    const bestBid = bidLevels[0] ?? null;
    const mid = bestAsk && bestBid ? (bestAsk.price + bestBid.price) / 2 : null;

    // Walk the book to fill our BTC notional
    let remaining = btcNotionalNeeded;
    let totalCostUsd = 0;
    let filledBtc = 0;
    let totalDepthAvailable = 0;
    for (const lvl of askLevels) {
      totalDepthAvailable += lvl.size;
      if (remaining <= 0) continue;
      const take = Math.min(remaining, lvl.size);
      // Bullish option price = USD per option contract = USD premium per BTC of underlying
      // Multiply price by BTC quantity to get USD cost
      totalCostUsd += take * lvl.price;
      remaining -= take;
      filledBtc += take;
    }

    const fillablePct = (filledBtc / btcNotionalNeeded) * 100;
    const avgFillPriceUsd = filledBtc > 0 ? totalCostUsd / filledBtc : null;
    const perDayCostUsd = totalCostUsd > 0 ? totalCostUsd / c.daysToExpiry : null;

    probeResults.push({
      expiry: c.expiry,
      daysToExpiry: c.daysToExpiry,
      symbol: c.symbol,
      strikePrice: c.strikePrice,
      distanceFromSpotPct: c.distanceFromSpotPct,
      bestAskPrice: bestAsk?.price ?? null,
      bestAskSizeBtc: bestAsk?.size ?? null,
      askDepthForOrderBtc: totalDepthAvailable,
      fillablePct,
      avgFillPriceUsd,
      totalCostUsd: filledBtc > 0 ? totalCostUsd : null,
      perDayCostUsd,
      bestBidPrice: bestBid?.price ?? null,
      midPrice: mid
    });

    // Polite to API
    await new Promise(r => setTimeout(r, 200));
  }

  // 7. Summary table
  console.log(`\n\nSummary (sorted by per-day hedge cost, ascending):`);
  console.log("=".repeat(140));
  console.log(
    [
      "Expiry".padEnd(28),
      "Days".padEnd(7),
      "Strike".padEnd(10),
      "BestAsk".padEnd(12),
      "AskSize".padEnd(10),
      "TotalDepth".padEnd(12),
      "Fillable%".padEnd(11),
      "TotalCost".padEnd(13),
      "PerDay$".padEnd(11)
    ].join(" | ")
  );
  console.log("-".repeat(140));
  const sorted = [...probeResults].sort((a, b) => (a.perDayCostUsd ?? Infinity) - (b.perDayCostUsd ?? Infinity));
  for (const r of sorted) {
    console.log(
      [
        r.expiry.padEnd(28),
        r.daysToExpiry.toFixed(1).padEnd(7),
        `$${r.strikePrice.toFixed(0)}`.padEnd(10),
        r.bestAskPrice !== null ? `$${r.bestAskPrice.toFixed(2)}`.padEnd(12) : "(no ask)".padEnd(12),
        r.bestAskSizeBtc !== null ? `${r.bestAskSizeBtc.toFixed(2)} BTC`.padEnd(10) : "n/a".padEnd(10),
        `${r.askDepthForOrderBtc.toFixed(2)} BTC`.padEnd(12),
        `${r.fillablePct.toFixed(0)}%`.padEnd(11),
        r.totalCostUsd !== null ? `$${r.totalCostUsd.toFixed(0)}`.padEnd(13) : "n/a".padEnd(13),
        r.perDayCostUsd !== null ? `$${r.perDayCostUsd.toFixed(0)}`.padEnd(11) : "n/a".padEnd(11)
      ].join(" | ")
    );
  }

  // 8. Pick recommendation
  console.log("\n\nRECOMMENDATION ANALYSIS");
  console.log("=".repeat(120));
  const adequate = probeResults.filter(r => r.fillablePct >= 100 && r.perDayCostUsd !== null);
  const cheapest = adequate.length > 0
    ? adequate.reduce((min, r) => (r.perDayCostUsd ?? Infinity) < (min.perDayCostUsd ?? Infinity) ? r : min)
    : null;
  if (cheapest) {
    console.log(`\n  Cheapest fully-fillable tenor:`);
    console.log(`    ${cheapest.symbol}`);
    console.log(`    Expiry: ${cheapest.expiry} (${cheapest.daysToExpiry.toFixed(1)} days)`);
    console.log(`    Strike: $${cheapest.strikePrice.toFixed(0)} (${cheapest.distanceFromSpotPct.toFixed(2)}% below spot)`);
    console.log(`    Total hedge cost: $${cheapest.totalCostUsd!.toFixed(0)} for $200k @ 5% protection`);
    console.log(`    Per-day cost: $${cheapest.perDayCostUsd!.toFixed(0)}/day`);
    console.log(`    At $400/day premium target: per-trade margin = $${(400 - cheapest.perDayCostUsd!).toFixed(0)}/day`);
    console.log(`    Margin over hedge cost: ${((400 / cheapest.perDayCostUsd! - 1) * 100).toFixed(0)}%`);
  } else {
    console.log(`\n  !! No tenor has full liquidity for $${POSITION_NOTIONAL_USD} notional on Bullish.`);
    console.log(`     Largest fillable: ${probeResults.reduce((m, r) => Math.max(m, r.fillablePct), 0).toFixed(0)}%`);
    console.log(`     Recommend: Deribit primary or split orders across tenors.`);
  }

  // 9. Save full results to JSON
  const outPath = `/tmp/bullish_5pct_probe_${Date.now()}.json`;
  const fs = await import("node:fs/promises");
  await fs.writeFile(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    btcSpot,
    targetPutStrike,
    positionNotional: POSITION_NOTIONAL_USD,
    btcNotionalNeeded,
    candidates,
    probeResults,
    cheapestRecommendation: cheapest
  }, null, 2));
  console.log(`\nFull JSON saved to ${outPath}`);
};

main().catch(err => { console.error("Probe failed:", err); process.exit(1); });
