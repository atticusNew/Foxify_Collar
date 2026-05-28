/**
 * Reconciliation autopsy — Step 1 of the V3 certainty plan.
 *
 * Re-runs PR 0b's cost model AND V3's cost model on the same cell, same inputs,
 * and emits a per-leg, per-component decomposition so we can see EXACTLY where
 * they diverge.
 *
 * Output: docs/PHASE_1_RECONCILIATION_AUTOPSY_<date>.md
 *
 * Usage: npx tsx scripts/backtest/singleSide/reconciliationAutopsy.ts
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { bsPut, bsCall } from "./coreEngine";
import {
  EMBEDDED_DEFAULT_ANCHORS,
  REGIME_COST_MARKUP,
  type LiveAnchors
} from "./runTwoSidedStrangleProof";
import * as fsSync from "node:fs";

const loadAnchors = async (): Promise<LiveAnchors> => {
  try {
    const raw = fsSync.readFileSync("/tmp/two_sided_anchors.json", "utf8");
    return JSON.parse(raw) as LiveAnchors;
  } catch {
    return EMBEDDED_DEFAULT_ANCHORS;
  }
};
import { loadLiveMultiTenorData, livePerLegAskV3, liveSlippageHaircutV3 } from "./liveCellPricingV3";

const RFR = 0.045;

// The cells under autopsy — focus on the ones with biggest V1 vs V3 disagreement
type AuditCell = {
  cellId: string;
  notionalUsdcPerLeg: number;
  triggerPct: number;
  tenorDays: number;
  putItmPct: number;        // > 0 = ITM put; < 0 = OTM put
  callItmPct: number;       // > 0 = ITM call; < 0 = OTM call
  contractsBtc: number;
  strikeGrid: number;
};

const CELLS: AuditCell[] = [
  // Old Phase 0 baseline — biggest disagreement ($543 vs -$1,834)
  { cellId: "pair_50k_2pct_itm", notionalUsdcPerLeg: 50_000, triggerPct: 0.02, tenorDays: 3, putItmPct: 0.013, callItmPct: 0.013, contractsBtc: 1.4, strikeGrid: 1_000 },
  // V3 moderate winner
  { cellId: "pair_25k_5pct_otm_3d", notionalUsdcPerLeg: 25_000, triggerPct: 0.05, tenorDays: 3, putItmPct: -0.020, callItmPct: -0.025, contractsBtc: 0.5, strikeGrid: 1_000 },
  // Short-tenor cell (V3 says marginal, V2 said broken)
  { cellId: "pair_25k_5pct_otm_short", notionalUsdcPerLeg: 25_000, triggerPct: 0.05, tenorDays: 1, putItmPct: -0.020, callItmPct: -0.025, contractsBtc: 0.5, strikeGrid: 1_000 },
  // Micro cell — V3 says broken everywhere
  { cellId: "pair_25k_1pct_atm_micro", notionalUsdcPerLeg: 25_000, triggerPct: 0.01, tenorDays: 0.25, putItmPct: 0, callItmPct: 0, contractsBtc: 0.3, strikeGrid: 1_000 }
];

const computeStrikes = (cell: AuditCell, spot: number): { put: number; call: number } => {
  const rawPut = spot * (1 + cell.putItmPct);
  const rawCall = spot * (1 - cell.callItmPct);
  return {
    put: Math.ceil(rawPut / cell.strikeGrid) * cell.strikeGrid,
    call: Math.floor(rawCall / cell.strikeGrid) * cell.strikeGrid
  };
};

// Replicate PR 0b's calibLeg + findCalibForLeg + computeStrangleCostDetailed
const calibLegForAnchor = (anchor: { strike: number; optionType: "put" | "call"; bestAskUsdcPerBtc: number; ivAnnualAtPull: number }, spot: number, tenorDays: number): number => {
  const T = tenorDays / 365;
  const bs = anchor.optionType === "put"
    ? bsPut(spot, anchor.strike, T, RFR, anchor.ivAnnualAtPull)
    : bsCall(spot, anchor.strike, T, RFR, anchor.ivAnnualAtPull);
  if (bs <= 0) return 1.0;
  return anchor.bestAskUsdcPerBtc / bs;
};

const pr0bLegCost = (
  spot: number,
  strike: number,
  optType: "put" | "call",
  tenorDays: number,
  sigma: number,
  contractsBtc: number,
  regime: "calm" | "moderate" | "elevated" | "stress",
  anchors: LiveAnchors
): { perBtc: number; calib: number; markup: number; bsFair: number; total: number; anchorStrike: number } => {
  const T = tenorDays / 365;
  const bs = optType === "put" ? bsPut(spot, strike, T, RFR, sigma) : bsCall(spot, strike, T, RFR, sigma);
  const sameType = anchors.anchors.filter((a) => a.optionType === optType);
  let calib = 1.07;
  let anchorStrike = 0;
  if (sameType.length > 0) {
    const exact = sameType.find((a) => a.strike === strike);
    const pick = exact ?? sameType.reduce((best, a) => Math.abs(a.strike - strike) < Math.abs(best.strike - strike) ? a : best);
    calib = calibLegForAnchor(pick, spot, tenorDays);
    anchorStrike = pick.strike;
  }
  const markup = REGIME_COST_MARKUP[regime];
  const perBtc = bs * calib * markup;
  return { perBtc, calib, markup, bsFair: bs, total: perBtc * contractsBtc, anchorStrike };
};

const fmt$ = (n: number, digits = 0) => `${n < 0 ? "-" : ""}\$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits })}`;
const fmtPct = (n: number) => `${(n * 100).toFixed(2)}%`;

const REGIME_SIGMAS = { calm: 0.35, moderate: 0.55, elevated: 0.75, stress: 0.95 };

const main = async () => {
  console.log("# Reconciliation Autopsy — PR 0b vs V3\n");

  const liveData = await loadLiveMultiTenorData();
  const anchors = await loadAnchors().catch(() => EMBEDDED_DEFAULT_ANCHORS);
  if (!liveData) {
    console.log("⚠ /tmp/two_sided_smile_multi.json not present — run probeDeribitSmileMultiTenor.ts first");
    process.exit(1);
  }

  const spot = liveData.spotAtPull;
  console.log(`Spot: \$${spot.toFixed(0)}\n`);
  console.log(`PR 0b anchors generated: ${anchors.generatedAt} (${anchors.anchors.length} per-leg anchors)`);
  console.log(`V3 multi-tenor data generated: ${liveData.generatedAt} (${liveData.buckets.map((b) => `${b.label}=${b.smileObservations.length}`).join(", ")})\n`);

  const lines: string[] = [];
  lines.push(`# Reconciliation Autopsy — PR 0b vs V3 (Step 1 of certainty plan)`);
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Spot:** \$${spot.toFixed(0)}`);
  lines.push(`**PR 0b anchors:** ${anchors.generatedAt} (${anchors.anchors.length} per-leg anchors)`);
  lines.push(`**V3 multi-tenor data:** ${liveData.generatedAt}`);
  lines.push("");
  lines.push(`## Per-cell cost decomposition`);
  lines.push("");
  lines.push(`For each cell, we run both PR 0b's model and V3's model on the same inputs.`);
  lines.push(`The "Δ" column shows V3 minus PR 0b. Positive Δ = V3 charges more.`);
  lines.push("");

  for (const cell of CELLS) {
    const { put: putStrike, call: callStrike } = computeStrikes(cell, spot);
    lines.push(`### ${cell.cellId}`);
    lines.push("");
    lines.push(`Strikes: put=\$${putStrike.toLocaleString()} (${(((putStrike / spot) - 1) * 100).toFixed(2)}% from spot), call=\$${callStrike.toLocaleString()} (${(((callStrike / spot) - 1) * 100).toFixed(2)}%)`);
    lines.push(`Contracts: ${cell.contractsBtc} BTC/leg, tenor: ${cell.tenorDays}d`);
    lines.push("");
    lines.push(`| Regime | Leg | σ | BS_fair (USD/BTC) | PR 0b calib | PR 0b regime mkup | **PR 0b cost** | V3 ask (USD/BTC) | V3 regime mkup | **V3 cost** | Δ V3-PR0b |`);
    lines.push(`|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|`);

    for (const regime of ["calm", "moderate", "elevated", "stress"] as const) {
      const sigma = REGIME_SIGMAS[regime];
      const pr0bPut = pr0bLegCost(spot, putStrike, "put", cell.tenorDays, sigma, cell.contractsBtc, regime, anchors);
      const pr0bCall = pr0bLegCost(spot, callStrike, "call", cell.tenorDays, sigma, cell.contractsBtc, regime, anchors);
      const v3PutAsk = livePerLegAskV3(liveData, spot, putStrike, "put", cell.tenorDays, REGIME_COST_MARKUP[regime]);
      const v3CallAsk = livePerLegAskV3(liveData, spot, callStrike, "call", cell.tenorDays, REGIME_COST_MARKUP[regime]);
      const v3Put = v3PutAsk * cell.contractsBtc;
      const v3Call = v3CallAsk * cell.contractsBtc;
      lines.push(`| ${regime} | put | ${sigma} | ${fmt$(pr0bPut.bsFair, 0)} | ${pr0bPut.calib.toFixed(3)} | ${pr0bPut.markup} | **${fmt$(pr0bPut.total)}** | ${fmt$(v3PutAsk)} | ${REGIME_COST_MARKUP[regime]} | **${fmt$(v3Put)}** | ${v3Put - pr0bPut.total >= 0 ? "+" : ""}${fmt$(v3Put - pr0bPut.total)} |`);
      lines.push(`| ${regime} | call | ${sigma} | ${fmt$(pr0bCall.bsFair, 0)} | ${pr0bCall.calib.toFixed(3)} | ${pr0bCall.markup} | **${fmt$(pr0bCall.total)}** | ${fmt$(v3CallAsk)} | ${REGIME_COST_MARKUP[regime]} | **${fmt$(v3Call)}** | ${v3Call - pr0bCall.total >= 0 ? "+" : ""}${fmt$(v3Call - pr0bCall.total)} |`);
      const pr0bTotal = pr0bPut.total + pr0bCall.total;
      const v3Total = v3Put + v3Call;
      lines.push(`| ${regime} | **TOTAL** | — | — | — | — | **${fmt$(pr0bTotal)}** | — | — | **${fmt$(v3Total)}** | **${v3Total - pr0bTotal >= 0 ? "+" : ""}${fmt$(v3Total - pr0bTotal)} (${(((v3Total - pr0bTotal) / pr0bTotal) * 100).toFixed(1)}%)** |`);
    }
    lines.push("");
  }

  // Methodology comparison table
  lines.push(`## Methodology comparison`);
  lines.push("");
  lines.push(`| Aspect | PR 0b | V3 |`);
  lines.push(`|---|---|---|`);
  lines.push(`| Cost source | BS_fair × per-leg anchor calibration multiplier × regime markup | Live ask (direct) OR smile interp + BS + avg ask/mid × regime markup |`);
  lines.push(`| Anchor data freshness | ${anchors.generatedAt} (probe of one moment) | ${liveData.generatedAt} (multi-tenor probe) |`);
  lines.push(`| Per-tenor smile | NO (single anchor per leg, BS-rescaled to tenor) | YES (separate smile fit at 6h/1d/2d/3d) |`);
  lines.push(`| Bid-ask spread cost | Folded into calibration mult | Explicit — uses ASK side, not mid |`);
  lines.push(`| Salvage slip | Constant 0.85 | Tenor-bucket spread-dependent (0.65-0.95) |`);
  lines.push(`| Atticus floor in sim | YES | YES (same logic) |`);
  lines.push(`| MC paths | bootstrap (calm) / GBM | bootstrap (calm) / GBM (same engine) |`);
  lines.push("");

  lines.push(`## Diagnostic questions answered`);
  lines.push("");
  lines.push(`1. **Does V3 systematically charge more than PR 0b?**`);
  lines.push(`   Look at the Δ column in each table. If consistently positive → V3 is more conservative.`);
  lines.push(`   If consistently negative → V3 is more aggressive (unexpected — investigate immediately).`);
  lines.push("");
  lines.push(`2. **Where does the biggest disagreement live?**`);
  lines.push(`   For pair_50k_2pct_itm (the old Phase 0 cell), look at the calm row.`);
  lines.push(`   PR 0b said this was profitable; V3 says broken. The cost Δ explains the EV flip.`);
  lines.push("");
  lines.push(`3. **Are V3's ITM put quotes inflated?**`);
  lines.push(`   For ITM put legs in pair_50k_2pct_itm, compare:`);
  lines.push(`     - PR 0b BS_fair × calib × markup`);
  lines.push(`     - V3 ask (direct or smile-interp)`);
  lines.push(`   If V3 ask ≫ BS_fair × 1.3 (typical ITM markup), V3 may be over-paying for ITM puts.`);
  lines.push(`   Cross-check via Step 2 (live probe of these exact strikes).`);
  lines.push("");

  lines.push(`---`);
  lines.push(`*Generated by services/api/scripts/backtest/singleSide/reconciliationAutopsy.ts*`);
  lines.push(`*Next: Step 2 — live probe of Phase 0 cell strikes (live ask, today, this minute)*`);

  const outPath = path.resolve(process.cwd(), "../..", `docs/PHASE_1_RECONCILIATION_AUTOPSY_${new Date().toISOString().slice(0, 10)}.md`);
  await fs.writeFile(outPath, lines.join("\n"));
  console.log(`✓ Autopsy report: ${outPath}`);
};

import { fileURLToPath } from "node:url";
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
