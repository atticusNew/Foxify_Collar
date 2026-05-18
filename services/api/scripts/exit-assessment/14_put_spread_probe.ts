/**
 * Bullish put-spread probe for $200k @ 5% cover.
 *
 * For each candidate tenor, compute the LIVE put-spread debit:
 *   - Long ATM put (strike near current spot)
 *   - Short put at trigger strike (5% below spot)
 *
 * Reports actual market-cost vs my Black-Scholes estimates.
 *
 * READ ONLY (public Bullish endpoints; no auth).
 */

const BULLISH = "https://api.exchange.bullish.com";
const NOTIONAL_USD = 200_000;
const TARGET_PUT_PCT = 0.05;

const fetchJson = async <T,>(url: string): Promise<T> => {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json() as Promise<T>;
};

type Mkt = {
  symbol: string;
  marketEnabled?: boolean;
  createOrderEnabled?: boolean;
  marketType?: string;
  optionType?: string;
  underlyingBaseSymbol?: string;
  optionStrikePrice?: string;
  expiryDatetime?: string;
};

const parseLevel = (l: any) => {
  if (!l) return null;
  const price = Number(l.price ?? l.p ?? l[0]);
  const size = Number(l.priceLevelQuantity ?? l.quantity ?? l.size ?? l[1]);
  return Number.isFinite(price) && Number.isFinite(size) ? { price, size } : null;
};

const main = async () => {
  console.log("# Bullish put-spread probe (long ATM put + short trigger put)\n");

  const cb = await fetchJson<any>("https://api.coinbase.com/v2/prices/BTC-USD/spot");
  const spot = Number(cb.data.amount);
  const triggerStrike = Math.round(spot * (1 - TARGET_PUT_PCT) / 1000) * 1000;
  console.log(`BTC spot: $${spot.toFixed(2)}`);
  console.log(`Trigger strike (5% below, snapped to $1k grid): $${triggerStrike}`);

  const btcNotional = NOTIONAL_USD / spot;
  console.log(`BTC notional needed: ${btcNotional.toFixed(4)}\n`);

  const markets = await fetchJson<Mkt[]>(`${BULLISH}/trading-api/v1/markets`);
  const btcPuts = markets.filter(m =>
    m.marketType === "OPTION" && m.optionType === "PUT" &&
    m.underlyingBaseSymbol === "BTC" &&
    m.marketEnabled === true && m.createOrderEnabled === true &&
    m.expiryDatetime && m.optionStrikePrice
  );

  // Group by expiry
  const byExpiry: Record<string, Mkt[]> = {};
  for (const p of btcPuts) {
    const e = p.expiryDatetime!;
    if (!byExpiry[e]) byExpiry[e] = [];
    byExpiry[e].push(p);
  }

  // For each expiry, find ATM (closest to spot) and TRIGGER (closest to triggerStrike)
  const tenorsOfInterest = Object.keys(byExpiry).filter(e => {
    const days = (new Date(e).getTime() - Date.now()) / 86_400_000;
    return days >= 0.5 && days <= 30;
  }).sort();

  console.log(`Probing ${tenorsOfInterest.length} expiries\n`);

  type Result = {
    expiry: string;
    days: number;
    atmStrike: number;
    triggerStrike: number;
    atmAsk: number | null;
    atmAskDepth: number;
    triggerBid: number | null;
    triggerBidDepth: number;
    longLegCostUsd: number | null;
    shortLegCreditUsd: number | null;
    spreadDebitUsd: number | null;
    spreadDebitPerDayUsd: number | null;
    maxPayoutUsd: number;
    fillable: boolean;
  };
  const results: Result[] = [];

  for (const expiry of tenorsOfInterest) {
    const days = (new Date(expiry).getTime() - Date.now()) / 86_400_000;
    const strikes = byExpiry[expiry];

    // Find ATM = closest to spot
    let atmStrike: Mkt | null = null;
    let atmDist = Infinity;
    for (const s of strikes) {
      const d = Math.abs(Number(s.optionStrikePrice) - spot);
      if (d < atmDist) { atmDist = d; atmStrike = s; }
    }

    // Find trigger = closest to triggerStrike
    let trigStrike: Mkt | null = null;
    let trigDist = Infinity;
    for (const s of strikes) {
      const d = Math.abs(Number(s.optionStrikePrice) - triggerStrike);
      if (d < trigDist) { trigDist = d; trigStrike = s; }
    }
    if (!atmStrike || !trigStrike) continue;

    const atmStrikeNum = Number(atmStrike.optionStrikePrice);
    const trigStrikeNum = Number(trigStrike.optionStrikePrice);
    if (atmStrikeNum === trigStrikeNum) continue;

    // Get orderbooks for both legs
    let atmOb: any = null;
    let trigOb: any = null;
    try {
      atmOb = await fetchJson<any>(`${BULLISH}/trading-api/v1/markets/${atmStrike.symbol}/orderbook/hybrid?depth=10`);
    } catch {}
    try {
      trigOb = await fetchJson<any>(`${BULLISH}/trading-api/v1/markets/${trigStrike.symbol}/orderbook/hybrid?depth=10`);
    } catch {}

    const atmAsks = (atmOb?.asks ?? []).map(parseLevel).filter(Boolean) as any[];
    const trigBids = (trigOb?.bids ?? []).map(parseLevel).filter(Boolean) as any[];

    // Walk asks for long leg
    let remaining = btcNotional;
    let longCost = 0;
    let atmDepth = 0;
    for (const lvl of atmAsks) {
      atmDepth += lvl.size;
      if (remaining <= 0) continue;
      const take = Math.min(remaining, lvl.size);
      longCost += take * lvl.price;
      remaining -= take;
    }
    const longFillable = remaining <= 0.001;

    // Walk bids for short leg
    let remainingShort = btcNotional;
    let shortCredit = 0;
    let trigDepth = 0;
    for (const lvl of trigBids) {
      trigDepth += lvl.size;
      if (remainingShort <= 0) continue;
      const take = Math.min(remainingShort, lvl.size);
      shortCredit += take * lvl.price;
      remainingShort -= take;
    }
    const shortFillable = remainingShort <= 0.001;

    const spreadWidth = atmStrikeNum - trigStrikeNum;
    const maxPayout = spreadWidth * btcNotional;
    const debit = longCost - shortCredit;

    results.push({
      expiry,
      days,
      atmStrike: atmStrikeNum,
      triggerStrike: trigStrikeNum,
      atmAsk: atmAsks[0]?.price ?? null,
      atmAskDepth: atmDepth,
      triggerBid: trigBids[0]?.price ?? null,
      triggerBidDepth: trigDepth,
      longLegCostUsd: longFillable ? longCost : null,
      shortLegCreditUsd: shortFillable ? shortCredit : null,
      spreadDebitUsd: longFillable && shortFillable ? debit : null,
      spreadDebitPerDayUsd: longFillable && shortFillable ? debit / days : null,
      maxPayoutUsd: maxPayout,
      fillable: longFillable && shortFillable
    });

    await new Promise(r => setTimeout(r, 200));
  }

  console.log("Results (long ATM put + short 5%-OTM put = put debit spread):");
  console.log("=".repeat(160));
  console.log(
    "Expiry".padEnd(28),
    "| Days  | LongStrike | ShortStrike | LongAsk | ShortBid | LongCost | ShortCredit | SpreadDebit | SpreadDebit/day | Max Payout | Fillable"
  );
  console.log("-".repeat(160));
  for (const r of results) {
    console.log(
      r.expiry.padEnd(28),
      `| ${r.days.toFixed(1).padEnd(5)} | $${r.atmStrike.toString().padEnd(9)} | $${r.triggerStrike.toString().padEnd(10)} | $${(r.atmAsk ?? "n/a").toString().padEnd(7)} | $${(r.triggerBid ?? "n/a").toString().padEnd(8)} | ${r.longLegCostUsd !== null ? `$${r.longLegCostUsd.toFixed(0)}` : "n/a".padEnd(9)} | ${r.shortLegCreditUsd !== null ? `$${r.shortLegCreditUsd.toFixed(0)}` : "n/a".padEnd(11)} | ${r.spreadDebitUsd !== null ? `$${r.spreadDebitUsd.toFixed(0)}` : "n/a".padEnd(11)} | ${r.spreadDebitPerDayUsd !== null ? `$${r.spreadDebitPerDayUsd.toFixed(0)}/day` : "n/a"} | $${r.maxPayoutUsd.toFixed(0)} | ${r.fillable ? "YES" : "no"}`
    );
  }

  // Pick the recommended tenor
  const fillable = results.filter(r => r.fillable);
  const fillableSorted = fillable.sort((a, b) => (a.spreadDebitPerDayUsd ?? Infinity) - (b.spreadDebitPerDayUsd ?? Infinity));

  console.log(`\n\nSorted by spread debit per day:`);
  for (const r of fillableSorted) {
    console.log(`  ${r.days.toFixed(1)}d → $${r.spreadDebitPerDayUsd!.toFixed(0)}/day | total debit $${r.spreadDebitUsd!.toFixed(0)} | max payout $${r.maxPayoutUsd.toFixed(0)}`);
  }

  // Compare to single-leg ATM cost (from earlier probe)
  console.log("\n\nCompared to single-leg ATM put (from earlier probe):");
  console.log("  7-day single ATM put cost: ~$2,800");
  console.log("  7-day put SPREAD debit (computed above): see table");
  console.log("  Savings = single-ATM cost − spread debit (capital efficiency lever)");
};

main().catch(e => { console.error(e); process.exit(1); });
