/**
 * Step 2 of certainty plan: live probe of EXACT Phase 0 cell strikes.
 *
 * Hits Deribit + Bullish (where available) for the actual `pair_50k_2pct_itm`
 * strikes RIGHT NOW. Compares live ask to V3 prediction and PR 0b prediction.
 * Answers: is V3 charging what venues actually charge today?
 *
 * Output: docs/PHASE_1_PHASE0_LIVE_PROBE_<date>.md
 *
 * Uses no Bullish API (no creds). Deribit is the venue of record for puts +
 * calls in V3; Bullish lives in PR 0b anchors. We probe Deribit live.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { bsPut, bsCall } from "./coreEngine";
import { loadLiveMultiTenorData, livePerLegAskV3 } from "./liveCellPricingV3";
import { EMBEDDED_DEFAULT_ANCHORS, REGIME_COST_MARKUP, type LiveAnchors } from "./runTwoSidedStrangleProof";

const RFR = 0.045;

type CellProbe = {
  cellId: string;
  tenorDays: number;
  putItmPct: number;
  callItmPct: number;
  contractsBtc: number;
  strikeGrid: number;
};

const PROBES: CellProbe[] = [
  { cellId: "pair_50k_2pct_itm", tenorDays: 3, putItmPct: 0.013, callItmPct: 0.013, contractsBtc: 1.4, strikeGrid: 1_000 },
  { cellId: "pair_25k_5pct_otm_3d", tenorDays: 3, putItmPct: -0.020, callItmPct: -0.025, contractsBtc: 0.5, strikeGrid: 1_000 },
  { cellId: "pair_25k_5pct_otm_short", tenorDays: 1, putItmPct: -0.020, callItmPct: -0.025, contractsBtc: 0.5, strikeGrid: 1_000 }
];

type DeribitInstrument = { instrument_name: string; option_type: "put" | "call"; strike: number; expiration_timestamp: number };
type DeribitOB = { best_bid_price: number; best_ask_price: number; underlying_price: number; mark_iv?: number; ask_iv?: number; mark_price?: number };

const fetchJson = async <T>(url: string, timeoutMs = 6_000): Promise<T> => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as T;
  } finally { clearTimeout(t); }
};

const findInstrument = (instr: DeribitInstrument[], strike: number, optType: "put" | "call", targetTenorDays: number, now: number): DeribitInstrument | null => {
  const targetHours = targetTenorDays * 24;
  const candidates = instr.filter((i) => i.option_type === optType && i.strike === strike);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const ha = (a.expiration_timestamp - now) / 3_600_000;
    const hb = (b.expiration_timestamp - now) / 3_600_000;
    return Math.abs(ha - targetHours) - Math.abs(hb - targetHours);
  });
  return candidates[0];
};

const pr0bLegPriceForAnchor = (anchor: { strike: number; optionType: "put" | "call"; bestAskUsdcPerBtc: number; ivAnnualAtPull: number }, anchorSpot: number, currentSpot: number, strike: number, tenorDays: number, sigma: number, regime: "calm" | "moderate" | "elevated" | "stress"): number => {
  // PR 0b: BS(currentSpot, strike, sigma) * (anchor.bestAsk / BS(anchorSpot, anchorStrike, ivAtPull)) * regimeMarkup
  const T = tenorDays / 365;
  const bs = anchor.optionType === "put" ? bsPut(currentSpot, strike, T, RFR, sigma) : bsCall(currentSpot, strike, T, RFR, sigma);
  const T_anchor = tenorDays / 365; // PR 0b uses cell tenor (PAIR.hedgeTenorDays = 3) in calib
  const bsAnchor = anchor.optionType === "put"
    ? bsPut(anchorSpot, anchor.strike, T_anchor, RFR, anchor.ivAnnualAtPull)
    : bsCall(anchorSpot, anchor.strike, T_anchor, RFR, anchor.ivAnnualAtPull);
  const calib = bsAnchor > 0 ? anchor.bestAskUsdcPerBtc / bsAnchor : 1.07;
  return bs * calib * REGIME_COST_MARKUP[regime];
};

const main = async () => {
  console.log("# Phase 0 LIVE cost probe (Step 2 of certainty plan)\n");
  const now = Date.now();

  // Fetch live spot
  const idx = await fetchJson<{ result: { index_price: number } }>("https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd");
  const spot = idx.result.index_price;
  console.log(`Live spot (Deribit index): \$${spot.toFixed(2)}\n`);

  // Fetch all BTC instruments
  const instrResp = await fetchJson<{ result: DeribitInstrument[] }>("https://www.deribit.com/api/v2/public/get_instruments?currency=BTC&kind=option&expired=false");
  console.log(`Total instruments: ${instrResp.result.length}\n`);

  type ProbeResult = {
    cellId: string;
    tenorDays: number;
    putStrike: number;
    callStrike: number;
    legs: Array<{
      leg: "put" | "call";
      strike: number;
      instrument: string | null;
      live_ask_usdc: number | null;
      live_mid_usdc: number | null;
      live_iv: number | null;
      live_spread_pct: number | null;
    }>;
    live_total_usdc: number | null;
    v3_predicted_usdc: number;
    pr0b_predicted_usdc: number;
    bs_fair_calm_usdc: number;
  };
  const results: ProbeResult[] = [];

  const liveData = await loadLiveMultiTenorData();

  for (const cell of PROBES) {
    const rawPut = spot * (1 + cell.putItmPct);
    const rawCall = spot * (1 - cell.callItmPct);
    const putStrike = Math.ceil(rawPut / cell.strikeGrid) * cell.strikeGrid;
    const callStrike = Math.floor(rawCall / cell.strikeGrid) * cell.strikeGrid;
    const legs: ProbeResult["legs"] = [];
    let total = 0;
    let allFound = true;

    for (const { leg, strike } of [{ leg: "put" as const, strike: putStrike }, { leg: "call" as const, strike: callStrike }]) {
      const instr = findInstrument(instrResp.result, strike, leg, cell.tenorDays, now);
      if (!instr) {
        legs.push({ leg, strike, instrument: null, live_ask_usdc: null, live_mid_usdc: null, live_iv: null, live_spread_pct: null });
        allFound = false;
        continue;
      }
      const ob = await fetchJson<{ result: DeribitOB }>(`https://www.deribit.com/api/v2/public/get_order_book?instrument_name=${instr.instrument_name}&depth=3`);
      const o = ob.result;
      const askUsdcPerBtc = o.best_ask_price * o.underlying_price;
      const bidUsdcPerBtc = o.best_bid_price * o.underlying_price;
      const midUsdcPerBtc = (o.best_ask_price + o.best_bid_price) / 2 * o.underlying_price;
      const spreadPct = midUsdcPerBtc > 0 ? (askUsdcPerBtc - bidUsdcPerBtc) / midUsdcPerBtc : null;
      const legCost = askUsdcPerBtc * cell.contractsBtc;
      total += legCost;
      legs.push({
        leg,
        strike,
        instrument: instr.instrument_name,
        live_ask_usdc: legCost,
        live_mid_usdc: midUsdcPerBtc * cell.contractsBtc,
        live_iv: o.mark_iv ? o.mark_iv / 100 : null,
        live_spread_pct: spreadPct
      });
      await new Promise((r) => setTimeout(r, 40));
    }

    // V3 prediction at calm
    const v3Put = livePerLegAskV3(liveData, spot, putStrike, "put", cell.tenorDays, 1.0) * cell.contractsBtc;
    const v3Call = livePerLegAskV3(liveData, spot, callStrike, "call", cell.tenorDays, 1.0) * cell.contractsBtc;
    const v3Total = v3Put + v3Call;

    // PR 0b prediction at calm (using anchors)
    const pr0bPut = (() => {
      const sameType = EMBEDDED_DEFAULT_ANCHORS.anchors.filter((a) => a.optionType === "put");
      if (sameType.length === 0) return bsPut(spot, putStrike, cell.tenorDays / 365, RFR, 0.36) * 1.07 * cell.contractsBtc;
      const pick = sameType.reduce((b, a) => Math.abs(a.strike - putStrike) < Math.abs(b.strike - putStrike) ? a : b);
      return pr0bLegPriceForAnchor(pick, EMBEDDED_DEFAULT_ANCHORS.spotAtPull, spot, putStrike, cell.tenorDays, 0.35, "calm") * cell.contractsBtc;
    })();
    const pr0bCall = (() => {
      const sameType = EMBEDDED_DEFAULT_ANCHORS.anchors.filter((a) => a.optionType === "call");
      if (sameType.length === 0) return bsCall(spot, callStrike, cell.tenorDays / 365, RFR, 0.36) * 1.07 * cell.contractsBtc;
      const pick = sameType.reduce((b, a) => Math.abs(a.strike - callStrike) < Math.abs(b.strike - callStrike) ? a : b);
      return pr0bLegPriceForAnchor(pick, EMBEDDED_DEFAULT_ANCHORS.spotAtPull, spot, callStrike, cell.tenorDays, 0.35, "calm") * cell.contractsBtc;
    })();
    const pr0bTotal = pr0bPut + pr0bCall;

    // Plain BS fair (no markup, calm)
    const bsFair = (bsPut(spot, putStrike, cell.tenorDays / 365, RFR, 0.35) + bsCall(spot, callStrike, cell.tenorDays / 365, RFR, 0.35)) * cell.contractsBtc;

    results.push({
      cellId: cell.cellId,
      tenorDays: cell.tenorDays,
      putStrike,
      callStrike,
      legs,
      live_total_usdc: allFound ? total : null,
      v3_predicted_usdc: v3Total,
      pr0b_predicted_usdc: pr0bTotal,
      bs_fair_calm_usdc: bsFair
    });

    console.log(`${cell.cellId} (${cell.tenorDays}d, ${cell.contractsBtc} BTC/leg, strikes p=${putStrike} c=${callStrike}):`);
    for (const l of legs) {
      console.log(`  ${l.leg.padEnd(4)} ${l.instrument ?? "(not found)"}: ask=${l.live_ask_usdc != null ? `\$${l.live_ask_usdc.toFixed(0)}` : "—"}  iv=${l.live_iv != null ? `${(l.live_iv*100).toFixed(1)}%` : "—"}  spread=${l.live_spread_pct != null ? `${(l.live_spread_pct*100).toFixed(1)}%` : "—"}`);
    }
    if (allFound) {
      console.log(`  TOTAL: live=\$${total.toFixed(0)}  v3=\$${v3Total.toFixed(0)} (Δ${(((v3Total-total)/total)*100).toFixed(1)}%)  pr0b=\$${pr0bTotal.toFixed(0)} (Δ${(((pr0bTotal-total)/total)*100).toFixed(1)}%)  bs_fair=\$${bsFair.toFixed(0)}`);
    } else {
      console.log(`  ⚠ not all instruments found — partial data`);
    }
    console.log("");
  }

  // Write report
  const lines: string[] = [];
  lines.push(`# Phase 0 Live Cost Probe — Step 2 of certainty plan`);
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Source:** Deribit live order book (this minute)`);
  lines.push(`**Live spot:** \$${spot.toFixed(0)}`);
  lines.push("");
  lines.push(`## Per-cell live cost vs predictions`);
  lines.push("");
  lines.push(`| Cell | Tenor | Live ask | V3 predicted | Δ V3 vs live | PR 0b predicted | Δ PR0b vs live | BS_fair (σ=0.35) |`);
  lines.push(`|---|---:|---:|---:|---:|---:|---:|---:|`);
  for (const r of results) {
    const liveStr = r.live_total_usdc != null ? `\$${r.live_total_usdc.toFixed(0)}` : "—";
    const deltaV3 = r.live_total_usdc != null ? `${(((r.v3_predicted_usdc - r.live_total_usdc) / r.live_total_usdc) * 100).toFixed(1)}%` : "—";
    const deltaPr0b = r.live_total_usdc != null ? `${(((r.pr0b_predicted_usdc - r.live_total_usdc) / r.live_total_usdc) * 100).toFixed(1)}%` : "—";
    lines.push(`| ${r.cellId} | ${r.tenorDays}d | ${liveStr} | \$${r.v3_predicted_usdc.toFixed(0)} | ${deltaV3} | \$${r.pr0b_predicted_usdc.toFixed(0)} | ${deltaPr0b} | \$${r.bs_fair_calm_usdc.toFixed(0)} |`);
  }
  lines.push("");
  lines.push(`## Per-leg live detail`);
  lines.push("");
  for (const r of results) {
    lines.push(`### ${r.cellId}`);
    lines.push("");
    lines.push(`| Leg | Strike | Deribit instrument | Live ask (USDC) | Live mid (USDC) | Live IV | Spread % |`);
    lines.push(`|---|---:|---|---:|---:|---:|---:|`);
    for (const l of r.legs) {
      lines.push(`| ${l.leg} | \$${l.strike.toLocaleString()} | ${l.instrument ?? "(not found)"} | ${l.live_ask_usdc != null ? `\$${l.live_ask_usdc.toFixed(0)}` : "—"} | ${l.live_mid_usdc != null ? `\$${l.live_mid_usdc.toFixed(0)}` : "—"} | ${l.live_iv != null ? `${(l.live_iv*100).toFixed(1)}%` : "—"} | ${l.live_spread_pct != null ? `${(l.live_spread_pct*100).toFixed(1)}%` : "—"} |`);
    }
    lines.push("");
  }
  lines.push(`## Verdict`);
  lines.push("");
  for (const r of results) {
    if (r.live_total_usdc == null) continue;
    const v3Diff = ((r.v3_predicted_usdc - r.live_total_usdc) / r.live_total_usdc) * 100;
    const pr0bDiff = ((r.pr0b_predicted_usdc - r.live_total_usdc) / r.live_total_usdc) * 100;
    const v3Verdict = Math.abs(v3Diff) < 10 ? "✅ V3 within 10% of live" : Math.abs(v3Diff) < 25 ? "⚠️ V3 within 25%" : "❌ V3 off by >25%";
    const pr0bVerdict = Math.abs(pr0bDiff) < 10 ? "✅ PR 0b within 10% of live" : Math.abs(pr0bDiff) < 25 ? "⚠️ PR 0b within 25%" : "❌ PR 0b off by >25%";
    lines.push(`- **${r.cellId}**: live=\$${r.live_total_usdc.toFixed(0)} → V3 ${v3Diff > 0 ? "+" : ""}${v3Diff.toFixed(1)}% (${v3Verdict}), PR0b ${pr0bDiff > 0 ? "+" : ""}${pr0bDiff.toFixed(1)}% (${pr0bVerdict})`);
  }
  lines.push("");
  lines.push(`---`);
  lines.push(`*Generated by services/api/scripts/backtest/singleSide/probePhase0LiveCost.ts*`);

  const outPath = path.resolve(process.cwd(), "../..", `docs/PHASE_1_PHASE0_LIVE_PROBE_${new Date().toISOString().slice(0, 10)}.md`);
  await fs.writeFile(outPath, lines.join("\n"));
  console.log(`✓ Live probe report: ${outPath}`);
};

import { fileURLToPath } from "node:url";
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
