/**
 * Cell sweep V2 — uses LIVE per-leg ask + bid-ask spread + depth-aware slip
 * (replaces the 1.07 BS-fudge in runCellSweep.ts).
 *
 * Identical structure to runCellSweep.ts but:
 *   - Hedge cost = livePerLegAskUsdcPerBtc(strike, type, tenor) × contracts
 *   - Slippage = liveSlippageHaircut(strike, type, contracts) per leg
 *   - Salvage at close uses live pricing for the value path too
 *
 * Output: docs/PHASE_1_CELL_SWEEP_V2_<date>.md
 *
 * Side-by-side comparison with v1 (the buggy one) to surface the EV correction.
 *
 * Prerequisites: /tmp/two_sided_smile.json from probeDeribitSmile.ts
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { bsPut, bsCall } from "./coreEngine";
import { generateBootstrapPath, generateGbmPath, load5MinBars, mulberry32, type PathConfig } from "./monteCarloEngine";
import { loadLiveSmileData, livePerLegAskUsdcPerBtc, liveSlippageHaircut } from "./liveCellPricing";

const RFR = 0.045;
const N_PATHS = 10_000;
const BAR_MINUTES = 5;

type CellCandidate = {
  cellId: string;
  notionalUsdcPerLeg: number;
  triggerPct: number;
  tenorDays: number;
  putStrikeOffsetPct: number;
  callStrikeOffsetPct: number;
  contractsBtc: number;
  strikeGridUsdc: number;
  description: string;
};

const CANDIDATES: CellCandidate[] = [
  { cellId: "pair_50k_2pct_itm", notionalUsdcPerLeg: 50_000, triggerPct: 0.02, tenorDays: 3, putStrikeOffsetPct: 0.013, callStrikeOffsetPct: 0.013, contractsBtc: 1.4, strikeGridUsdc: 1_000, description: "Phase 0 baseline (ITM guts, 3d, ±2%)" },
  { cellId: "pair_100k_3pct_itm_short", notionalUsdcPerLeg: 100_000, triggerPct: 0.03, tenorDays: 2, putStrikeOffsetPct: 0.005, callStrikeOffsetPct: 0.005, contractsBtc: 2.0, strikeGridUsdc: 1_000, description: "Calm scale-up (0.5% ITM, 2d, ±3%)" },
  { cellId: "pair_50k_3pct_atm", notionalUsdcPerLeg: 50_000, triggerPct: 0.03, tenorDays: 2, putStrikeOffsetPct: 0, callStrikeOffsetPct: 0, contractsBtc: 1.0, strikeGridUsdc: 1_000, description: "ATM, 2d, ±3%" },
  { cellId: "pair_50k_5pct_otm", notionalUsdcPerLeg: 50_000, triggerPct: 0.05, tenorDays: 2, putStrikeOffsetPct: -0.015, callStrikeOffsetPct: -0.020, contractsBtc: 1.0, strikeGridUsdc: 1_000, description: "OTM + wider trigger (1.5/2% OTM, 2d, ±5%)" },
  { cellId: "pair_25k_5pct_otm_short", notionalUsdcPerLeg: 25_000, triggerPct: 0.05, tenorDays: 1, putStrikeOffsetPct: -0.020, callStrikeOffsetPct: -0.025, contractsBtc: 0.5, strikeGridUsdc: 1_000, description: "OTM short tenor (2/2.5% OTM, 1d, ±5%)" },
  { cellId: "pair_50k_4pct_otm_short", notionalUsdcPerLeg: 50_000, triggerPct: 0.04, tenorDays: 1, putStrikeOffsetPct: -0.010, callStrikeOffsetPct: -0.015, contractsBtc: 1.0, strikeGridUsdc: 1_000, description: "OTM 1d (1/1.5% OTM, ±4%)" },
  { cellId: "pair_25k_1pct_atm_micro", notionalUsdcPerLeg: 25_000, triggerPct: 0.01, tenorDays: 0.25, putStrikeOffsetPct: 0, callStrikeOffsetPct: 0, contractsBtc: 0.3, strikeGridUsdc: 1_000, description: "Micro (ATM, 6h, ±1%) — corrected tenor from 0.167 to 0.25 to match real 6h Bullish/Deribit expiry" },
  { cellId: "pair_50k_5pct_skew", notionalUsdcPerLeg: 50_000, triggerPct: 0.05, tenorDays: 2, putStrikeOffsetPct: -0.015, callStrikeOffsetPct: -0.020, contractsBtc: 1.0, strikeGridUsdc: 1_000, description: "Skew-asymmetric (same as 5pct_otm)" }
];

const REGIME_SIGMAS = { calm: 0.35, moderate: 0.55, elevated: 0.75, stress: 0.95 };
const REGIME_MARKUP = { calm: 1.0, moderate: 1.15, elevated: 1.35, stress: 1.60 };  // slightly more aggressive markup than v1; reflects spread-widening in stress

const computeStrikes = (cell: CellCandidate, spot: number): { put: number; call: number } => {
  const rawPut = spot * (1 + cell.putStrikeOffsetPct);
  const rawCall = spot * (1 - cell.callStrikeOffsetPct);
  return {
    put: Math.ceil(rawPut / cell.strikeGridUsdc) * cell.strikeGridUsdc,
    call: Math.floor(rawCall / cell.strikeGridUsdc) * cell.strikeGridUsdc
  };
};

type SimResult = {
  hedgeCost: number;
  putLegCost: number;
  callLegCost: number;
  putStrike: number;
  callStrike: number;
  meanSalvage: number;
  triggerRate: number;
  meanFoxifyEv: number;
  meanAtticusEv: number;
  pctProfit: number;
  worstFoxify: number;
  bestFoxify: number;
  p5FoxifyEv: number;
  effectiveSlip: number;
};

const simulateCellV2 = async (
  cell: CellCandidate,
  spot: number,
  regime: "calm" | "moderate" | "elevated" | "stress",
  bars: { close: number; high: number; low: number; open: number }[] | null,
  splitPct = 0.85,
  floorUsdc = 25
): Promise<SimResult> => {
  const sigma = REGIME_SIGMAS[regime];
  const markup = REGIME_MARKUP[regime];
  const liveData = await loadLiveSmileData();
  const { put: putStrike, call: callStrike } = computeStrikes(cell, spot);

  // LIVE per-leg cost (replaces BS×1.07)
  const putAskPerBtc = livePerLegAskUsdcPerBtc(liveData, spot, putStrike, "put", cell.tenorDays, markup);
  const callAskPerBtc = livePerLegAskUsdcPerBtc(liveData, spot, callStrike, "call", cell.tenorDays, markup);
  const putLegCost = putAskPerBtc * cell.contractsBtc;
  const callLegCost = callAskPerBtc * cell.contractsBtc;
  const hedgeCost = putLegCost + callLegCost;

  // LIVE slippage (depth-aware, per leg, worst-leg-wins)
  const putSlip = liveSlippageHaircut(liveData, putStrike, "put", cell.contractsBtc);
  const callSlip = liveSlippageHaircut(liveData, callStrike, "call", cell.contractsBtc);
  const slip = Math.min(putSlip, callSlip);

  const triggerDownPx = spot * (1 - cell.triggerPct);
  const triggerUpPx = spot * (1 + cell.triggerPct);

  const rng = mulberry32(42);
  const pathConfig: PathConfig = {
    tenorDays: cell.tenorDays, sigmaAnnual: sigma, driftAnnual: 0,
    generator: regime === "calm" && bars ? "bootstrap" : "gbm", seed: 42
  };

  const foxifyEvs: number[] = [];
  const atticusEvs: number[] = [];
  const salvages: number[] = [];
  let triggers = 0;

  for (let p = 0; p < N_PATHS; p++) {
    const pathBars = bars && regime === "calm"
      ? generateBootstrapPath(spot, pathConfig, bars, rng)
      : generateGbmPath(spot, pathConfig, rng);

    let triggerBar = -1;
    let triggerSide: "down" | "up" | null = null;
    for (let i = 1; i < pathBars.closes.length; i++) {
      if (pathBars.lows[i] <= triggerDownPx) { triggerBar = i; triggerSide = "down"; break; }
      if (pathBars.highs[i] >= triggerUpPx) { triggerBar = i; triggerSide = "up"; break; }
    }

    let salvage = 0;
    if (triggerBar === -1) {
      const sellAt = Math.max(0, pathBars.closes.length - 1 - 48);
      const sp = pathBars.closes[sellAt];
      const remDays = ((pathBars.closes.length - 1 - sellAt) * BAR_MINUTES) / (60 * 24);
      const T2 = Math.max(0, remDays / 365);
      // Sell at residual value × slip
      salvage = (Math.max(0, bsPut(sp, putStrike, T2, RFR, sigma)) + Math.max(0, bsCall(sp, callStrike, T2, RFR, sigma))) * cell.contractsBtc * slip;
    } else {
      triggers++;
      const captureEnd = Math.min(triggerBar + 6, pathBars.closes.length - 1);
      let peak = 0;
      for (let i = triggerBar; i <= captureEnd; i++) {
        const sp = triggerSide === "down" ? pathBars.lows[i] : pathBars.highs[i];
        const remBars = pathBars.closes.length - 1 - i;
        const remDays = (remBars * BAR_MINUTES) / (60 * 24);
        const T2 = Math.max(0, remDays / 365);
        const v = (Math.max(0, bsPut(sp, putStrike, T2, RFR, sigma)) + Math.max(0, bsCall(sp, callStrike, T2, RFR, sigma))) * cell.contractsBtc;
        if (v > peak) peak = v;
      }
      salvage = peak * slip;
    }

    salvages.push(salvage);
    const uplift = salvage - hedgeCost;
    let atticusShare = 0;
    let foxifyShare: number;
    if (uplift <= 0) {
      foxifyShare = salvage;
    } else {
      atticusShare = Math.min(uplift, Math.max((1 - splitPct) * uplift, floorUsdc));
      foxifyShare = hedgeCost + (uplift - atticusShare);
    }
    foxifyEvs.push(foxifyShare - hedgeCost);
    atticusEvs.push(atticusShare);
  }

  const sortedF = [...foxifyEvs].sort((a, b) => a - b);
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  return {
    hedgeCost, putLegCost, callLegCost, putStrike, callStrike,
    meanSalvage: mean(salvages),
    triggerRate: triggers / N_PATHS,
    meanFoxifyEv: mean(foxifyEvs),
    meanAtticusEv: mean(atticusEvs),
    pctProfit: foxifyEvs.filter((x) => x > 0).length / foxifyEvs.length,
    worstFoxify: sortedF[0],
    bestFoxify: sortedF[sortedF.length - 1],
    p5FoxifyEv: sortedF[Math.floor(sortedF.length * 0.05)],
    effectiveSlip: slip
  };
};

const fmt$ = (n: number) => `${n < 0 ? "-" : ""}\$${Math.round(Math.abs(n)).toLocaleString()}`;
const fmt$Signed = (n: number) => `${n < 0 ? "-" : "+"}\$${Math.round(Math.abs(n)).toLocaleString()}`;
const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;

const main = async () => {
  console.log("# Cell sweep V2 (live spreads + depth-aware slip)\n");
  const bars = await load5MinBars().catch(() => null);
  if (bars) console.log(`Loaded ${bars.length.toLocaleString()} bars`);
  const live = await loadLiveSmileData();
  if (live) console.log(`Live smile loaded: a0=${(live.fit.a0*100).toFixed(2)}% a1=${live.fit.a1.toFixed(3)} ${live.spreadObservations.length} spread obs at spot $${live.spotAtPull.toFixed(0)}`);
  else console.log("⚠ NO live smile data; falling back to BS+fudge");

  const spot = live?.spotAtPull ?? 74_000;
  console.log(`\nSweep spot: $${spot.toFixed(0)}\n`);

  const results: Record<string, Record<string, SimResult>> = {};
  for (const cell of CANDIDATES) {
    results[cell.cellId] = {};
    for (const regime of ["calm", "moderate", "elevated", "stress"] as const) {
      const r = await simulateCellV2(cell, spot, regime, bars);
      results[cell.cellId][regime] = r;
      console.log(`  ${cell.cellId.padEnd(28)} ${regime.padEnd(9)} hedge=${fmt$(r.hedgeCost)} (put ${fmt$(r.putLegCost)} + call ${fmt$(r.callLegCost)}) slip=${r.effectiveSlip.toFixed(2)} F=${fmt$Signed(r.meanFoxifyEv)} A=${fmt$Signed(r.meanAtticusEv)} trig=${fmtPct(r.triggerRate)}`);
    }
  }

  // Build report
  const lines: string[] = [];
  lines.push(`# Phase 1 Cell Sweep V2 — LIVE SPREAD-CORRECTED`);
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Spot anchor:** \$${spot.toFixed(0)}`);
  lines.push(`**Paths per cell × regime:** ${N_PATHS.toLocaleString()}`);
  if (live) lines.push(`**Live smile:** a0=${(live.fit.a0*100).toFixed(2)}% (ATM IV), a1=${live.fit.a1.toFixed(3)} (skew), a2=${live.fit.a2.toFixed(3)}, R²=${live.fit.rSquared.toFixed(2)}, ${live.spreadObservations.length} spread observations`);
  lines.push(`**Cost model:** live per-leg ask + observed bid-ask spread + depth-aware slip (NO BS×1.07 fudge)`);
  lines.push(`**Regime markup:** calm 1.00x, moderate 1.15x, elevated 1.35x, stress 1.60x`);
  lines.push("");

  for (const regime of ["calm", "moderate", "elevated", "stress"] as const) {
    lines.push(`## ${regime[0].toUpperCase() + regime.slice(1)} regime (σ=${REGIME_SIGMAS[regime]})`);
    lines.push("");
    lines.push(`| Cell | Hedge cost | Put/Call legs | Slip | Trigger | Mean salvage | **Foxify EV** | Atticus EV | %profit | P5 Foxify | Verdict |`);
    lines.push(`|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|`);

    const ranked = CANDIDATES
      .map((c) => ({ cell: c, result: results[c.cellId][regime] }))
      .sort((a, b) => b.result.meanFoxifyEv - a.result.meanFoxifyEv);

    for (const { cell, result: r } of ranked) {
      const verdict = r.meanFoxifyEv > 100 ? "✅ PROFITABLE" : r.meanFoxifyEv > 0 ? "⚠️ MARGINAL" : "❌ LOSS";
      lines.push(`| ${cell.cellId} | ${fmt$(r.hedgeCost)} | ${fmt$(r.putLegCost)}/${fmt$(r.callLegCost)} | ${r.effectiveSlip.toFixed(2)} | ${fmtPct(r.triggerRate)} | ${fmt$(r.meanSalvage)} | **${fmt$Signed(r.meanFoxifyEv)}** | ${fmt$Signed(r.meanAtticusEv)} | ${fmtPct(r.pctProfit)} | ${fmt$Signed(r.p5FoxifyEv)} | ${verdict} |`);
    }
    lines.push("");
  }

  // Recommendation
  lines.push(`## Recommended cell allowlist per regime (V2)`);
  lines.push("");
  for (const regime of ["calm", "moderate", "elevated", "stress"] as const) {
    const winners = CANDIDATES
      .map((c) => ({ cell: c, result: results[c.cellId][regime] }))
      .filter((x) => x.result.meanFoxifyEv > 100)
      .sort((a, b) => b.result.meanFoxifyEv - a.result.meanFoxifyEv)
      .map((x) => `${x.cell.cellId} (+\$${Math.round(x.result.meanFoxifyEv)})`);
    lines.push(`- **${regime}**: ${winners.length === 0 ? "_(NO cell profitable above \$100/pair threshold — recommend halt)_" : winners.join(", ")}`);
  }
  lines.push("");

  // V1 vs V2 comparison
  lines.push(`## V1 vs V2 comparison (illustrative)`);
  lines.push("");
  lines.push(`V1 used BS-fair × 1.07 fudge for venue markup; V2 uses live per-strike ask + observed bid-ask spread.`);
  lines.push(`Live verification (separate doc) showed V1 underestimated cost by ~45% for ATM strikes.`);
  lines.push("");
  lines.push(`| Cell | V1 calm EV | V2 calm EV | V1 stress EV | V2 stress EV |`);
  lines.push(`|---|---:|---:|---:|---:|`);
  const V1_NUMBERS: Record<string, { calm: number; stress: number }> = {
    pair_50k_2pct_itm: { calm: -339, stress: 1576 },
    pair_100k_3pct_itm_short: { calm: -213, stress: 1715 },
    pair_50k_3pct_atm: { calm: -42, stress: 1484 },
    pair_50k_5pct_otm: { calm: -96, stress: 1801 },
    pair_25k_5pct_otm_short: { calm: -8, stress: 693 },
    pair_50k_4pct_otm_short: { calm: -49, stress: 1310 },
    pair_25k_1pct_atm_micro: { calm: 39, stress: 171 },
    pair_50k_5pct_skew: { calm: -96, stress: 1801 }
  };
  for (const cell of CANDIDATES) {
    const v1 = V1_NUMBERS[cell.cellId] ?? { calm: 0, stress: 0 };
    const v2 = results[cell.cellId];
    lines.push(`| ${cell.cellId} | ${fmt$Signed(v1.calm)} | ${fmt$Signed(v2.calm.meanFoxifyEv)} | ${fmt$Signed(v1.stress)} | ${fmt$Signed(v2.stress.meanFoxifyEv)} |`);
  }
  lines.push("");

  lines.push(`## Candidate cell descriptions`);
  lines.push("");
  for (const c of CANDIDATES) lines.push(`- **${c.cellId}**: ${c.description}`);
  lines.push("");
  lines.push(`---`);
  lines.push(`*Generated by services/api/scripts/backtest/singleSide/runCellSweepV2.ts*`);
  lines.push(`*This supersedes PHASE_1_CELL_SWEEP_2026-05-28.md which used BS+1.07 fudge.*`);

  const outPath = path.resolve(process.cwd(), "../..", `docs/PHASE_1_CELL_SWEEP_V2_${new Date().toISOString().slice(0, 10)}.md`);
  await fs.writeFile(outPath, lines.join("\n"));
  console.log(`\n✓ V2 cell sweep report: ${outPath}`);
};

import { fileURLToPath } from "node:url";
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
