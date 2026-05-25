#!/usr/bin/env tsx
/**
 * Live spread vs strangle chain probe for cell 50k_2pct_1k.
 *
 * Read-only Deribit public endpoints. Pulls real bids/asks for:
 *   - Strangle "production_now" layout (strikes snapped INWARD toward
 *     spot, mimicking current production behavior — expensive)
 *   - Strangle "trigger_aligned" layout (strikes just outside trigger
 *     range — cheaper, still protective)
 *   - Vertical spread layout (long at trigger boundary, short $2k
 *     further OTM, sized to exactly cover $1k Foxify payout)
 *
 * Across multiple tenors (1d/2d/3d/5d/7d/14d) so we can pick the sweet
 * spot for typical 0.5-2d Foxify holds.
 *
 * Output: per-tenor cost/economics table, plus aggregate
 * per-pair-Atticus-P&L comparison assuming 2-day Foxify hold + 50%
 * hedge mark recovery (no breach scenario).
 *
 * Run:
 *   npx tsx services/api/scripts/probes/spread_vs_strangle_chain_probe.ts
 */

const DERIBIT = "https://www.deribit.com/api/v2/public";

// Cell parameters: 50k_2pct_1k
const CELL_NAME = "50k_2pct_1k";
const NOTIONAL_USD = 50_000;
const TRIGGER_PCT = 0.02;
const PAYOUT_USD = 1_000;
const PREMIUM_PER_DAY_USD = 350;
const STRIKE_TICK_USD = 500;
const SPREAD_WIDTH_USD = 2_000;

// Spread sizing: contracts × width = max payout coverage
const SPREAD_CONTRACTS_BTC = PAYOUT_USD / SPREAD_WIDTH_USD; // 0.50

// Strangle sizing per current production matrix (estimated; could be
// tuned). 1.4 BTC matches the existing strangle probe — large because
// strangle is uncapped, so production sizing covers a deeper breach.
const STRANGLE_CONTRACTS_BTC = 1.4;

// Hedge mark recovery assumption for break-even modeling. Real number
// depends on volatility surface, IV crush, and time of close. Use 50%
// as midpoint estimate. Sensitivity shown at end.
const RECOVERY_PCT_DEFAULT = 0.5;

// Foxify hold time assumption for net-P&L modeling
const FOXIFY_HOLD_DAYS_DEFAULT = 2;

const TENOR_TARGETS_DAYS = [1, 2, 3, 5, 7, 14];

type Instrument = {
  instrument_name: string;
  expiration_timestamp: number;
  strike: number;
  option_type: "call" | "put";
};

type Quote = {
  best_bid_price: number;
  best_ask_price: number;
  mark_price: number;
  index_price: number;
  underlying_price: number;
  mark_iv: number;
};

const fetchJson = async <T,>(url: string): Promise<T> => {
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
  const j = await r.json();
  return j.result as T;
};

const getIndex = async (): Promise<number> => {
  const r = await fetchJson<{ index_price: number }>(
    `${DERIBIT}/get_index_price?index_name=btc_usd`
  );
  return r.index_price;
};

const listInstruments = async (): Promise<Instrument[]> => {
  return await fetchJson<Instrument[]>(
    `${DERIBIT}/get_instruments?currency=BTC&kind=option&expired=false`
  );
};

const getQuote = async (instrument: string): Promise<Quote | null> => {
  try {
    return await fetchJson<Quote>(
      `${DERIBIT}/ticker?instrument_name=${encodeURIComponent(instrument)}`
    );
  } catch {
    return null;
  }
};

const closestStrike = (
  candidates: Instrument[],
  desiredStrike: number,
  type: "call" | "put"
): Instrument | null => {
  const filtered = candidates.filter((i) => i.option_type === type);
  if (filtered.length === 0) return null;
  return filtered.reduce((best, cur) => {
    const dBest = Math.abs(best.strike - desiredStrike);
    const dCur = Math.abs(cur.strike - desiredStrike);
    return dCur < dBest ? cur : best;
  });
};

// Convert Deribit BTC-denominated premium to USD using underlying price.
const toUsd = (q: Quote | null, side: "bid" | "ask" | "mark", spot: number): number => {
  if (!q) return 0;
  const ul = q.underlying_price || spot;
  if (side === "bid") return q.best_bid_price * ul;
  if (side === "ask") return q.best_ask_price * ul;
  return q.mark_price * ul;
};

const formatUsd = (n: number): string => `$${n.toFixed(2)}`;
const formatPct = (n: number): string => `${(n * 100).toFixed(1)}%`;

const main = async (): Promise<void> => {
  const spot = await getIndex();
  console.log(`\n${"=".repeat(78)}`);
  console.log(`Spread vs Strangle Probe — Cell ${CELL_NAME}`);
  console.log(`Generated: ${new Date().toISOString()}`);
  console.log(`BTC spot (Deribit index): $${spot.toFixed(2)}`);
  console.log(`${"=".repeat(78)}\n`);

  // Compute trigger boundaries
  const triggerLow = Math.round(spot * (1 - TRIGGER_PCT));
  const triggerHigh = Math.round(spot * (1 + TRIGGER_PCT));

  // Snap to $500 tick grid
  const snapDown = (n: number) => Math.floor(n / STRIKE_TICK_USD) * STRIKE_TICK_USD;
  const snapUp = (n: number) => Math.ceil(n / STRIKE_TICK_USD) * STRIKE_TICK_USD;

  // Layout 1: "production_now" — strikes snapped INWARD (current behavior)
  //   For put: snap UP from trigger (closer to spot, more expensive)
  //   For call: snap DOWN from trigger (closer to spot, more expensive)
  //   Mirrors observed live position (e.g., $76,500 put when low trigger $75,560)
  const productionPutStrike = snapUp(triggerLow + STRIKE_TICK_USD); // $76,000 for $75,460 trigger
  const productionCallStrike = snapDown(triggerHigh - STRIKE_TICK_USD); // $78,000 for $78,540 trigger

  // Layout 2: "trigger_aligned" — strikes just OUTSIDE trigger boundary
  //   For put long: first tick at or above trigger (just at protection edge)
  //   For call long: first tick at or below trigger
  const alignedPutStrike = snapUp(triggerLow); // $75,500 for $75,460 trigger
  const alignedCallStrike = snapDown(triggerHigh); // $78,500 for $78,540 trigger

  // Layout 3: "spread" — long at trigger boundary, short $2k further OTM
  const spreadPutLong = alignedPutStrike;
  const spreadPutShort = alignedPutStrike - SPREAD_WIDTH_USD;
  const spreadCallLong = alignedCallStrike;
  const spreadCallShort = alignedCallStrike + SPREAD_WIDTH_USD;

  console.log(`Cell: ${CELL_NAME}`);
  console.log(`  Notional: $${NOTIONAL_USD.toLocaleString()} long / $${NOTIONAL_USD.toLocaleString()} short`);
  console.log(`  Payout: $${PAYOUT_USD}`);
  console.log(`  Premium: $${PREMIUM_PER_DAY_USD}/day`);
  console.log(`  Trigger range: $${triggerLow.toLocaleString()} → $${triggerHigh.toLocaleString()}\n`);

  console.log(`Layouts being tested:`);
  console.log(`  [A] production_now strangle:  put $${productionPutStrike} / call $${productionCallStrike}, ${STRANGLE_CONTRACTS_BTC} BTC`);
  console.log(`  [B] trigger_aligned strangle: put $${alignedPutStrike} / call $${alignedCallStrike}, ${STRANGLE_CONTRACTS_BTC} BTC`);
  console.log(`  [C] vertical spread:          put $${spreadPutLong}/$${spreadPutShort}, call $${spreadCallLong}/$${spreadCallShort}, ${SPREAD_CONTRACTS_BTC} BTC`);
  console.log();

  // Pull instruments (1 call) and bucket by expiry
  const all = await listInstruments();
  const byExpiry = new Map<number, Instrument[]>();
  for (const inst of all) {
    if (!byExpiry.has(inst.expiration_timestamp)) {
      byExpiry.set(inst.expiration_timestamp, []);
    }
    byExpiry.get(inst.expiration_timestamp)!.push(inst);
  }
  const expiries = [...byExpiry.keys()].sort((a, b) => a - b);
  const nowMs = Date.now();

  // Per-tenor results
  type TenorResult = {
    targetDays: number;
    actualDays: number;
    expiryDate: string;
    productionStrangleAsk: number;
    productionStrangleMid: number;
    alignedStrangleAsk: number;
    alignedStrangleMid: number;
    spreadAsk: number;
    spreadMid: number;
    detail: string[];
  };
  const results: TenorResult[] = [];

  for (const targetDays of TENOR_TARGETS_DAYS) {
    const targetMs = nowMs + targetDays * 86_400_000;
    const candidates = expiries.filter((e) => e > nowMs + 3_600_000);
    if (candidates.length === 0) continue;
    const chosenExpiry = candidates.reduce((best, cur) =>
      Math.abs(cur - targetMs) < Math.abs(best - targetMs) ? cur : best
    );
    const dActual = (chosenExpiry - nowMs) / 86_400_000;
    const expiryDate = new Date(chosenExpiry).toISOString().slice(0, 10);
    const instr = byExpiry.get(chosenExpiry)!;

    // Resolve actual instruments for each strike
    const prodPut = closestStrike(instr, productionPutStrike, "put");
    const prodCall = closestStrike(instr, productionCallStrike, "call");
    const alignPut = closestStrike(instr, alignedPutStrike, "put");
    const alignCall = closestStrike(instr, alignedCallStrike, "call");
    const sprdPutShort = closestStrike(instr, spreadPutShort, "put");
    const sprdCallShort = closestStrike(instr, spreadCallShort, "call");

    // Pull all 6 quotes in parallel (gracefully handle missing)
    const [prodPutQ, prodCallQ, alignPutQ, alignCallQ, sprdPutShortQ, sprdCallShortQ] = await Promise.all([
      prodPut ? getQuote(prodPut.instrument_name) : Promise.resolve(null),
      prodCall ? getQuote(prodCall.instrument_name) : Promise.resolve(null),
      alignPut ? getQuote(alignPut.instrument_name) : Promise.resolve(null),
      alignCall ? getQuote(alignCall.instrument_name) : Promise.resolve(null),
      sprdPutShort ? getQuote(sprdPutShort.instrument_name) : Promise.resolve(null),
      sprdCallShort ? getQuote(sprdCallShort.instrument_name) : Promise.resolve(null),
    ]);

    // Compute costs
    // Strangle "production_now": ASK side, full size
    const prodAsk = (toUsd(prodPutQ, "ask", spot) + toUsd(prodCallQ, "ask", spot)) * STRANGLE_CONTRACTS_BTC;
    const prodMidPerBtc =
      ((toUsd(prodPutQ, "bid", spot) + toUsd(prodPutQ, "ask", spot)) / 2) +
      ((toUsd(prodCallQ, "bid", spot) + toUsd(prodCallQ, "ask", spot)) / 2);
    const prodMid = prodMidPerBtc * STRANGLE_CONTRACTS_BTC;

    // Strangle "trigger_aligned": ASK, full size
    const alignAsk = (toUsd(alignPutQ, "ask", spot) + toUsd(alignCallQ, "ask", spot)) * STRANGLE_CONTRACTS_BTC;
    const alignMidPerBtc =
      ((toUsd(alignPutQ, "bid", spot) + toUsd(alignPutQ, "ask", spot)) / 2) +
      ((toUsd(alignCallQ, "bid", spot) + toUsd(alignCallQ, "ask", spot)) / 2);
    const alignMid = alignMidPerBtc * STRANGLE_CONTRACTS_BTC;

    // Spread cost: BUY long ask, SELL short bid (worst case for taker)
    const putSpreadAskPerBtc = toUsd(alignPutQ, "ask", spot) - toUsd(sprdPutShortQ, "bid", spot);
    const callSpreadAskPerBtc = toUsd(alignCallQ, "ask", spot) - toUsd(sprdCallShortQ, "bid", spot);
    const spreadAsk = (putSpreadAskPerBtc + callSpreadAskPerBtc) * SPREAD_CONTRACTS_BTC;

    // Spread cost: MID (passive limit fill expectation)
    const putSpreadMidPerBtc =
      ((toUsd(alignPutQ, "bid", spot) + toUsd(alignPutQ, "ask", spot)) / 2) -
      ((toUsd(sprdPutShortQ, "bid", spot) + toUsd(sprdPutShortQ, "ask", spot)) / 2);
    const callSpreadMidPerBtc =
      ((toUsd(alignCallQ, "bid", spot) + toUsd(alignCallQ, "ask", spot)) / 2) -
      ((toUsd(sprdCallShortQ, "bid", spot) + toUsd(sprdCallShortQ, "ask", spot)) / 2);
    const spreadMid = (putSpreadMidPerBtc + callSpreadMidPerBtc) * SPREAD_CONTRACTS_BTC;

    // Build detail strings
    const detail: string[] = [];
    detail.push(`  PUT chain:`);
    if (prodPutQ) detail.push(`    [A] $${prodPut!.strike}: bid=${formatUsd(toUsd(prodPutQ, "bid", spot))} ask=${formatUsd(toUsd(prodPutQ, "ask", spot))} mark=${formatUsd(toUsd(prodPutQ, "mark", spot))} iv=${prodPutQ.mark_iv?.toFixed(1)}%`);
    if (alignPutQ) detail.push(`    [B] $${alignPut!.strike}: bid=${formatUsd(toUsd(alignPutQ, "bid", spot))} ask=${formatUsd(toUsd(alignPutQ, "ask", spot))} mark=${formatUsd(toUsd(alignPutQ, "mark", spot))} iv=${alignPutQ.mark_iv?.toFixed(1)}%`);
    if (sprdPutShortQ) detail.push(`    [C-short] $${sprdPutShort!.strike}: bid=${formatUsd(toUsd(sprdPutShortQ, "bid", spot))} ask=${formatUsd(toUsd(sprdPutShortQ, "ask", spot))} mark=${formatUsd(toUsd(sprdPutShortQ, "mark", spot))}`);
    detail.push(`  CALL chain:`);
    if (prodCallQ) detail.push(`    [A] $${prodCall!.strike}: bid=${formatUsd(toUsd(prodCallQ, "bid", spot))} ask=${formatUsd(toUsd(prodCallQ, "ask", spot))} mark=${formatUsd(toUsd(prodCallQ, "mark", spot))} iv=${prodCallQ.mark_iv?.toFixed(1)}%`);
    if (alignCallQ) detail.push(`    [B] $${alignCall!.strike}: bid=${formatUsd(toUsd(alignCallQ, "bid", spot))} ask=${formatUsd(toUsd(alignCallQ, "ask", spot))} mark=${formatUsd(toUsd(alignCallQ, "mark", spot))} iv=${alignCallQ.mark_iv?.toFixed(1)}%`);
    if (sprdCallShortQ) detail.push(`    [C-short] $${sprdCallShort!.strike}: bid=${formatUsd(toUsd(sprdCallShortQ, "bid", spot))} ask=${formatUsd(toUsd(sprdCallShortQ, "ask", spot))} mark=${formatUsd(toUsd(sprdCallShortQ, "mark", spot))}`);

    results.push({
      targetDays,
      actualDays: dActual,
      expiryDate,
      productionStrangleAsk: prodAsk,
      productionStrangleMid: prodMid,
      alignedStrangleAsk: alignAsk,
      alignedStrangleMid: alignMid,
      spreadAsk,
      spreadMid,
      detail,
    });

    await new Promise((r) => setTimeout(r, 100));
  }

  // Print per-tenor breakdown
  for (const r of results) {
    console.log(`\n${"-".repeat(78)}`);
    console.log(`Tenor ${r.targetDays}d (actual ${r.actualDays.toFixed(2)}d, expiry ${r.expiryDate})`);
    console.log(`${"-".repeat(78)}`);
    for (const line of r.detail) console.log(line);
    console.log();
    console.log(`  HEDGE COST (full position):`);
    console.log(`    [A] production_now strangle (${STRANGLE_CONTRACTS_BTC} BTC, INWARD-snap): ASK ${formatUsd(r.productionStrangleAsk)} | MID ${formatUsd(r.productionStrangleMid)}`);
    console.log(`    [B] trigger_aligned strangle (${STRANGLE_CONTRACTS_BTC} BTC, edge-snap):   ASK ${formatUsd(r.alignedStrangleAsk)} | MID ${formatUsd(r.alignedStrangleMid)}`);
    console.log(`    [C] vertical spread (${SPREAD_CONTRACTS_BTC} BTC, sized to payout):     ASK ${formatUsd(r.spreadAsk)} | MID ${formatUsd(r.spreadMid)}`);
    console.log();
    console.log(`  SAVINGS vs production_now:`);
    console.log(`    [B] saves ${formatUsd(r.productionStrangleAsk - r.alignedStrangleAsk)} (${formatPct((r.productionStrangleAsk - r.alignedStrangleAsk) / r.productionStrangleAsk)})`);
    console.log(`    [C] saves ${formatUsd(r.productionStrangleAsk - r.spreadAsk)} (${formatPct((r.productionStrangleAsk - r.spreadAsk) / r.productionStrangleAsk)})`);
    console.log();
    console.log(`  ATTICUS NET P&L per pair (assume ${FOXIFY_HOLD_DAYS_DEFAULT}-day hold, no breach, ${formatPct(RECOVERY_PCT_DEFAULT)} hedge recovery):`);
    const premium = PREMIUM_PER_DAY_USD * FOXIFY_HOLD_DAYS_DEFAULT;
    console.log(`    Premium @ ${formatUsd(PREMIUM_PER_DAY_USD)}/d × ${FOXIFY_HOLD_DAYS_DEFAULT}d = ${formatUsd(premium)}`);
    console.log(`    [A] hedge realized loss: ${formatUsd(-r.productionStrangleAsk * (1 - RECOVERY_PCT_DEFAULT))}, NET ${formatUsd(premium - r.productionStrangleAsk * (1 - RECOVERY_PCT_DEFAULT))}`);
    console.log(`    [B] hedge realized loss: ${formatUsd(-r.alignedStrangleAsk * (1 - RECOVERY_PCT_DEFAULT))}, NET ${formatUsd(premium - r.alignedStrangleAsk * (1 - RECOVERY_PCT_DEFAULT))}`);
    console.log(`    [C] hedge realized loss: ${formatUsd(-r.spreadAsk * (1 - RECOVERY_PCT_DEFAULT))}, NET ${formatUsd(premium - r.spreadAsk * (1 - RECOVERY_PCT_DEFAULT))}`);
  }

  // Aggregate "best of all worlds" recommendation
  console.log(`\n${"=".repeat(78)}`);
  console.log(`SUMMARY — Best Atticus net P&L per pair`);
  console.log(`Assumptions: ${FOXIFY_HOLD_DAYS_DEFAULT}-day Foxify hold, no breach, ${formatPct(RECOVERY_PCT_DEFAULT)} hedge recovery`);
  console.log(`${"=".repeat(78)}\n`);
  const premium = PREMIUM_PER_DAY_USD * FOXIFY_HOLD_DAYS_DEFAULT;
  console.log(`Tenor | [A] production_now | [B] trigger_aligned | [C] spreads`);
  console.log(`------|--------------------|---------------------|------------`);
  for (const r of results) {
    const netA = premium - r.productionStrangleAsk * (1 - RECOVERY_PCT_DEFAULT);
    const netB = premium - r.alignedStrangleAsk * (1 - RECOVERY_PCT_DEFAULT);
    const netC = premium - r.spreadAsk * (1 - RECOVERY_PCT_DEFAULT);
    console.log(`${String(r.targetDays).padStart(2, " ")}d   | ${formatUsd(netA).padStart(18, " ")} | ${formatUsd(netB).padStart(19, " ")} | ${formatUsd(netC).padStart(11, " ")}`);
  }

  // Sensitivity to hedge recovery assumption
  console.log(`\n${"-".repeat(78)}`);
  console.log(`Sensitivity to hedge recovery assumption (3-day tenor, [C] spreads):`);
  const r3 = results.find((r) => r.targetDays === 3);
  if (r3) {
    for (const recovery of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
      const realized = r3.spreadAsk * (1 - recovery);
      const net = premium - realized;
      console.log(`  Recovery ${formatPct(recovery)}: hedge_loss=${formatUsd(-realized)}, NET ${formatUsd(net)}`);
    }
  }

  console.log(`\nNotes:`);
  console.log(`  - "ASK" = aggressive market-order fill; "MID" = passive limit-order fill (best case).`);
  console.log(`  - Production strangle sizing uses ${STRANGLE_CONTRACTS_BTC} BTC per leg; spread uses ${SPREAD_CONTRACTS_BTC} BTC right-sized to $${PAYOUT_USD} payout cap.`);
  console.log(`  - Real recovery depends on volatility regime; spreads typically retain MORE % of cost than strangles because long+short legs decay together.`);
  console.log(`  - This is no-breach scenario only. Breach (rare) is profitable for both designs since hedge intrinsic ≥ Atticus payout obligation.`);
  console.log(`\n${"=".repeat(78)}`);
};

main().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
