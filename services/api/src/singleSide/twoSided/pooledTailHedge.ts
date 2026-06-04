/**
 * Pooled tail-hedge model — the platform-level catastrophe backstop behind "comprehensive
 * protection at value" (Sai integration, Phase 2).
 *
 * Per-trader cover (wick spread / single put) handles the common case cheaply. The rare
 * DEEP-CRASH tail — beyond each trader's protected band — is pooled at the book level instead
 * of every trader pre-paying for it. The key economics:
 *
 *   Leveraged traders sit on BOTH sides. A crash hurts the longs but HELPS the shorts, so the
 *   platform's real tail exposure is the NET book |long − short|, not the gross. The platform
 *   buys deep-OTM index puts on that NET notional at the band-edge strike (where per-trader
 *   cover ends), so everything below the band is hedged. Because net << gross, this costs a
 *   fraction of everyone self-insuring their own gross tail.
 *
 * PURE (put price injected → fully testable). READ-ONLY platform economics / research.
 *
 * v1 assumption: net-LONG book hedged with PUTS (the leveraged-long crash tail — the product's
 * focus). A net-SHORT book is the mirror image (CALLS); flagged in `note`, not yet priced.
 */

export type PooledTailInputs = {
  spot: number;
  longNotionalUsdc: number;        // gross long notional across all protected traders
  shortNotionalUsdc: number;       // gross short notional
  bandPct: number;                 // where per-trader cover ends (e.g. 0.04 = −4%); the pooled strike
  tenorDays: number;
  premiumsCollectedUsdc?: number;  // optional: premiums collected from per-trader cover (funding check)
  /** Stress haircut [0..1]: in a violent gap the offsetting side doesn't fully offset (shorts
   *  de-risk / get closed), so hedge a fraction of (gross−net) on top of the raw net. 0 = pure
   *  net (perfect offset), 1 = hedge the full gross (no offset credit). Default 0. */
  stressHaircut?: number;
};

export type PooledTailResult = {
  gross_notional_usdc: number;
  net_notional_usdc: number;
  net_side: "long" | "short" | "flat";
  /** What the platform buys to hedge the tail: PUT for net-long/flat (crash), CALL for net-short (pump). */
  hedge_side: "put" | "call";
  /** Notional actually hedged = net + stress_haircut × (gross − net). */
  hedged_notional_usdc: number;
  stress_haircut: number;
  band_strike: number;
  band_pct: number;
  // ── Cost of hedging the tail below the band ──
  pooled_hedge_cost_usdc: number;       // deep put on NET notional
  gross_selfinsure_cost_usdc: number;   // if every gross position hedged its own tail
  savings_usdc: number;                 // gross − pooled
  pooled_vs_gross_pct: number;          // pooled / gross (lower = cheaper)
  cost_bps_of_book: number;             // pooled cost ÷ gross book, in bps (per-$ cost to traders)
  // ── Funding (when premiums provided) ──
  premiums_collected_usdc: number | null;
  net_after_hedge_usdc: number | null;  // premiums − pooled cost (platform margin on the backstop)
  funded: boolean | null;
  summary: string;
};

const round2 = (x: number) => +x.toFixed(2);
const round4 = (x: number) => +x.toFixed(4);
const usd = (x: number) => `$${Math.round(x).toLocaleString()}`;
const pctStr = (x: number) => `${(x * 100).toFixed(1)}%`;

export const computePooledTailHedge = (inputs: PooledTailInputs, hedgeOptionAskUsdcPerBtc: number): PooledTailResult => {
  const { spot, longNotionalUsdc, shortNotionalUsdc, bandPct, premiumsCollectedUsdc } = inputs;
  const stressHaircut = Math.min(1, Math.max(0, inputs.stressHaircut ?? 0));
  const gross = Math.max(0, longNotionalUsdc) + Math.max(0, shortNotionalUsdc);
  const netSigned = longNotionalUsdc - shortNotionalUsdc;
  const net = Math.abs(netSigned);
  const netSide: "long" | "short" | "flat" = net < 1e-9 ? "flat" : netSigned > 0 ? "long" : "short";
  // Net-short books are hurt by a PUMP → hedge with CALLS; net-long/flat are hurt by a CRASH → PUTS.
  const hedgeSide: "put" | "call" = netSide === "short" ? "call" : "put";
  const bandStrike = hedgeSide === "call" ? spot * (1 + bandPct) : spot * (1 - bandPct);

  // Hedge the net exposure plus a stress fraction of the offsetting (gross−net) book.
  const hedgedNotional = net + stressHaircut * (gross - net);

  const perBtc = hedgeOptionAskUsdcPerBtc;
  const hedgedSizeBtc = spot > 0 ? hedgedNotional / spot : 0;
  const grossSizeBtc = spot > 0 ? gross / spot : 0;

  const pooledCost = perBtc * hedgedSizeBtc;     // hedge net (+ stress) directional tail
  const grossCost = perBtc * grossSizeBtc;       // if everyone self-insured their gross tail
  const savings = grossCost - pooledCost;
  const pooledVsGross = grossCost > 0 ? pooledCost / grossCost : 0;
  const costBps = gross > 0 ? (pooledCost / gross) * 10_000 : 0;

  const premiums = premiumsCollectedUsdc != null ? premiumsCollectedUsdc : null;
  const netAfter = premiums != null ? premiums - pooledCost : null;
  const funded = premiums != null ? premiums >= pooledCost : null;

  const sideWord = hedgeSide === "call" ? "above" : "below";
  const summary =
    pooledCost < 1
      ? `Book is delta-flat (long ≈ short, ${usd(gross)} gross) with no stress haircut: the tail self-hedges — pooled hedge ≈ $0. Premiums are pure margin.`
      : `${usd(gross)} gross book nets to ${usd(net)} ${netSide}${stressHaircut > 0 ? ` (hedging ${usd(hedgedNotional)} with a ${(stressHaircut * 100).toFixed(0)}% stress haircut)` : ""}. Hedging the tail ${sideWord} ${hedgeSide === "call" ? "+" : "−"}${pctStr(bandPct)} with ${hedgeSide}s costs ${usd(pooledCost)} — ${(pooledVsGross * 100).toFixed(0)}% of the ${usd(grossCost)} for every position to self-insure (${usd(savings)} saved, ${costBps.toFixed(1)} bps of book).${premiums != null ? ` Premiums ${usd(premiums)} ⇒ ${funded ? "fully fund" : "short of"} the hedge (${usd(netAfter as number)} net).` : ""}`;

  return {
    gross_notional_usdc: round2(gross),
    net_notional_usdc: round2(net),
    net_side: netSide,
    hedge_side: hedgeSide,
    hedged_notional_usdc: round2(hedgedNotional),
    stress_haircut: round4(stressHaircut),
    band_strike: round2(bandStrike),
    band_pct: round4(bandPct),
    pooled_hedge_cost_usdc: round2(pooledCost),
    gross_selfinsure_cost_usdc: round2(grossCost),
    savings_usdc: round2(savings),
    pooled_vs_gross_pct: round4(pooledVsGross),
    cost_bps_of_book: round2(costBps),
    premiums_collected_usdc: premiums != null ? round2(premiums) : null,
    net_after_hedge_usdc: netAfter != null ? round2(netAfter) : null,
    funded,
    summary
  };
};
