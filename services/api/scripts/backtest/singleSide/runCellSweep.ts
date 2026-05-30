/**
 * Cell sweep MC framework (PR C2).
 *
 * Iterates ~8 candidate cell configurations × 4 regimes × N MC paths to
 * produce a ranked-EV table for the operator's Wave C cell selection.
 *
 * Candidates per PLAN.md §6 (revised with OTM/wider-trigger analysis):
 *   pair_50k_2pct_itm       — Phase 0 baseline (calm validated)
 *   pair_100k_3pct_itm_short — calm scale-up (2d tenor, 0.5% ITM)
 *   pair_50k_3pct_atm       — calm-moderate transition (ATM both)
 *   pair_50k_5pct_otm       — moderate-elevated (1.5/2% OTM, ±5% trigger)
 *   pair_25k_5pct_otm_short — elevated (smaller, 1d tenor)
 *   pair_50k_4pct_otm_short — moderate alt (1/1.5% OTM, ±4%, 1d)
 *   pair_25k_1pct_atm_micro — stress (ATM, ±1%, 4h)
 *   pair_50k_5pct_skew      — skew-asymmetric (1.5% OTM put / 2% OTM call)
 *
 * Uses fitted smile (from /tmp/two_sided_smile.json) for accurate per-strike IV.
 * Falls back to flat smile when smile file unavailable.
 *
 * Output: docs/PHASE_1_CELL_SWEEP_<date>.md ranked table per regime.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { bsPut, bsCall } from "./coreEngine";
import { fitSmile, evaluateSmile, flatSmile, type SmileFit } from "./smileModel";
import { generateBootstrapPath, generateGbmPath, load5MinBars, mulberry32, type PathConfig } from "./monteCarloEngine";

const RFR = 0.045;
const N_PATHS = 10_000; // smaller than runTwoSidedStrangleProof.ts (25k) — sweep is 8 cells × 4 regimes
const BAR_MINUTES = 5;

type CellCandidate = {
  cellId: string;
  notionalUsdcPerLeg: number;
  triggerPct: number;
  tenorDays: number;
  putStrikeOffsetPct: number; // + = ITM put (strike > spot); - = OTM put
  callStrikeOffsetPct: number; // + = ITM call (strike < spot, expressed as positive); - = OTM call
  contractsBtc: number;
  strikeGridUsdc: number;
  description: string;
};

const CANDIDATES: CellCandidate[] = [
  {
    cellId: "pair_50k_2pct_itm",
    notionalUsdcPerLeg: 50_000,
    triggerPct: 0.02,
    tenorDays: 3,
    putStrikeOffsetPct: 0.013, // 1.3% ITM
    callStrikeOffsetPct: 0.013,
    contractsBtc: 1.4,
    strikeGridUsdc: 1_000,
    description: "Phase 0 baseline — ITM guts, 3d, ±2% trigger"
  },
  {
    cellId: "pair_100k_3pct_itm_short",
    notionalUsdcPerLeg: 100_000,
    triggerPct: 0.03,
    tenorDays: 2,
    putStrikeOffsetPct: 0.005,
    callStrikeOffsetPct: 0.005,
    contractsBtc: 2.0,
    strikeGridUsdc: 1_000,
    description: "Calm scale-up — 0.5% ITM, 2d, ±3% trigger, $100k notional"
  },
  {
    cellId: "pair_50k_3pct_atm",
    notionalUsdcPerLeg: 50_000,
    triggerPct: 0.03,
    tenorDays: 2,
    putStrikeOffsetPct: 0,
    callStrikeOffsetPct: 0,
    contractsBtc: 1.0,
    strikeGridUsdc: 1_000,
    description: "Calm-moderate transition — ATM, 2d, ±3%"
  },
  {
    cellId: "pair_50k_5pct_otm",
    notionalUsdcPerLeg: 50_000,
    triggerPct: 0.05,
    tenorDays: 2,
    putStrikeOffsetPct: -0.015, // 1.5% OTM
    callStrikeOffsetPct: -0.02,  // 2% OTM (skew-aware: calls cheaper)
    contractsBtc: 1.0,
    strikeGridUsdc: 1_000,
    description: "Moderate-elevated — 1.5/2% OTM, 2d, ±5% (per OTM analysis)"
  },
  {
    cellId: "pair_25k_5pct_otm_short",
    notionalUsdcPerLeg: 25_000,
    triggerPct: 0.05,
    tenorDays: 1,
    putStrikeOffsetPct: -0.02,
    callStrikeOffsetPct: -0.025,
    contractsBtc: 0.5,
    strikeGridUsdc: 1_000,
    description: "Elevated — 2/2.5% OTM, 1d, ±5%, sized small"
  },
  {
    cellId: "pair_50k_4pct_otm_short",
    notionalUsdcPerLeg: 50_000,
    triggerPct: 0.04,
    tenorDays: 1,
    putStrikeOffsetPct: -0.01,
    callStrikeOffsetPct: -0.015,
    contractsBtc: 1.0,
    strikeGridUsdc: 1_000,
    description: "Moderate alt — 1/1.5% OTM, 1d, ±4%"
  },
  {
    cellId: "pair_25k_1pct_atm_micro",
    notionalUsdcPerLeg: 25_000,
    triggerPct: 0.01,
    tenorDays: 0.167, // 4h
    putStrikeOffsetPct: 0,
    callStrikeOffsetPct: 0,
    contractsBtc: 0.3,
    strikeGridUsdc: 1_000,
    description: "Stress micro — ATM, 4h, ±1%, very small"
  },
  {
    cellId: "pair_50k_5pct_skew",
    notionalUsdcPerLeg: 50_000,
    triggerPct: 0.05,
    tenorDays: 2,
    putStrikeOffsetPct: -0.015, // put 1.5% OTM
    callStrikeOffsetPct: -0.02,  // call 2% OTM (asymmetric per BTC put skew)
    contractsBtc: 1.0,
    strikeGridUsdc: 1_000,
    description: "Skew-asymmetric variant"
  }
];

const REGIME_SIGMAS: Record<"calm" | "moderate" | "elevated" | "stress", number> = {
  calm: 0.35,
  moderate: 0.55,
  elevated: 0.75,
  stress: 0.95
};

const REGIME_COST_MARKUP: Record<"calm" | "moderate" | "elevated" | "stress", number> = {
  calm: 1.0,
  moderate: 1.08,
  elevated: 1.20,
  stress: 1.35
};

const computeStrikes = (cell: CellCandidate, spot: number): { put: number; call: number } => {
  const rawPut = spot * (1 + cell.putStrikeOffsetPct);
  const rawCall = spot * (1 - cell.callStrikeOffsetPct);
  const put = Math.ceil(rawPut / cell.strikeGridUsdc) * cell.strikeGridUsdc;
  const call = Math.floor(rawCall / cell.strikeGridUsdc) * cell.strikeGridUsdc;
  return { put, call };
};

const loadSmile = async (spot: number): Promise<SmileFit> => {
  try {
    const raw = await fs.readFile(process.env.TWO_SIDED_SMILE_PATH ?? "/tmp/two_sided_smile.json", "utf8");
    const data = JSON.parse(raw) as { fit: SmileFit };
    return data.fit;
  } catch {
    return flatSmile(0.36, spot);
  }
};

const ivAt = (smile: SmileFit, strike: number, fallback: number): number => {
  const iv = evaluateSmile(smile, strike);
  return iv != null && iv > 0.1 && iv < 3 ? iv : fallback;
};

type SimResult = {
  hedgeCost: number;
  meanSalvage: number;
  triggerRate: number;
  meanFoxifyEv: number;
  meanAtticusEv: number;
  pctProfit: number;
  worstFoxify: number;
  bestFoxify: number;
  p5FoxifyEv: number;
};

const simulateCell = (
  cell: CellCandidate,
  spot: number,
  regime: "calm" | "moderate" | "elevated" | "stress",
  smile: SmileFit,
  bars: { close: number; high: number; low: number; open: number }[] | null,
  splitPct = 0.85,
  floorUsdc = 25
): SimResult => {
  const sigma = REGIME_SIGMAS[regime];
  const markup = REGIME_COST_MARKUP[regime];
  const { put: putStrike, call: callStrike } = computeStrikes(cell, spot);
  const T = cell.tenorDays / 365;
  const ivPut = ivAt(smile, putStrike, sigma);
  const ivCall = ivAt(smile, callStrike, sigma);
  const bsP = bsPut(spot, putStrike, T, RFR, ivPut);
  const bsC = bsCall(spot, callStrike, T, RFR, ivCall);
  const hedgeCost = (bsP + bsC) * cell.contractsBtc * markup;

  const triggerDownPx = spot * (1 - cell.triggerPct);
  const triggerUpPx = spot * (1 + cell.triggerPct);

  const rng = mulberry32(42);
  const pathConfig: PathConfig = {
    tenorDays: cell.tenorDays,
    sigmaAnnual: sigma,
    driftAnnual: 0,
    generator: regime === "calm" && bars ? "bootstrap" : "gbm",
    seed: 42
  };

  const foxifyEvs: number[] = [];
  const atticusEvs: number[] = [];
  const salvages: number[] = [];
  let triggers = 0;

  for (let p = 0; p < N_PATHS; p++) {
    const pathBars = bars && regime === "calm"
      ? generateBootstrapPath(spot, pathConfig, bars, rng)
      : generateGbmPath(spot, pathConfig, rng);
    
    // Find trigger
    let triggerBar = -1;
    let triggerSide: "down" | "up" | null = null;
    for (let i = 1; i < pathBars.closes.length; i++) {
      if (pathBars.lows[i] <= triggerDownPx) { triggerBar = i; triggerSide = "down"; break; }
      if (pathBars.highs[i] >= triggerUpPx) { triggerBar = i; triggerSide = "up"; break; }
    }
    
    let salvage = 0;
    if (triggerBar === -1) {
      // No trigger: sell at expiry-4h or end
      const sellAt = Math.max(0, pathBars.closes.length - 1 - 48); // approx expiry-4h
      const sp = pathBars.closes[sellAt];
      const remDays = ((pathBars.closes.length - 1 - sellAt) * BAR_MINUTES) / (60 * 24);
      const T2 = Math.max(0, remDays / 365);
      salvage = (Math.max(0, bsPut(sp, putStrike, T2, RFR, sigma)) + Math.max(0, bsCall(sp, callStrike, T2, RFR, sigma))) * cell.contractsBtc;
    } else {
      // Trigger fired: theta-aware TP — simplified: peak in 30-min window × 0.85 slip
      triggers++;
      const captureEnd = Math.min(triggerBar + 6, pathBars.closes.length - 1); // 30 min = 6 × 5min
      let peak = 0;
      for (let i = triggerBar; i <= captureEnd; i++) {
        const sp = triggerSide === "down" ? pathBars.lows[i] : pathBars.highs[i];
        const remBars = pathBars.closes.length - 1 - i;
        const remDays = (remBars * BAR_MINUTES) / (60 * 24);
        const T2 = Math.max(0, remDays / 365);
        const v = (Math.max(0, bsPut(sp, putStrike, T2, RFR, sigma)) + Math.max(0, bsCall(sp, callStrike, T2, RFR, sigma))) * cell.contractsBtc;
        if (v > peak) peak = v;
      }
      salvage = peak * 0.85; // depth-aware slippage approximation
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
  return {
    hedgeCost,
    meanSalvage: salvages.reduce((s, x) => s + x, 0) / salvages.length,
    triggerRate: triggers / N_PATHS,
    meanFoxifyEv: foxifyEvs.reduce((s, x) => s + x, 0) / foxifyEvs.length,
    meanAtticusEv: atticusEvs.reduce((s, x) => s + x, 0) / atticusEvs.length,
    pctProfit: foxifyEvs.filter((x) => x > 0).length / foxifyEvs.length,
    worstFoxify: sortedF[0],
    bestFoxify: sortedF[sortedF.length - 1],
    p5FoxifyEv: sortedF[Math.floor(sortedF.length * 0.05)]
  };
};

const fmt$ = (n: number) => `${n < 0 ? "-" : ""}\$${Math.round(Math.abs(n)).toLocaleString()}`;
const fmt$Signed = (n: number) => `${n < 0 ? "-" : "+"}\$${Math.round(Math.abs(n)).toLocaleString()}`;
const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;

const main = async () => {
  console.log("# Cell sweep MC\n");
  const bars = await load5MinBars().catch(() => null);
  if (bars) console.log(`Loaded ${bars.length.toLocaleString()} bars\n`);

  const spot = 75_000;
  const smile = await loadSmile(spot);
  console.log(`Smile a0=${(smile.a0 * 100).toFixed(2)}% a1=${smile.a1.toFixed(3)} a2=${smile.a2.toFixed(3)} obs=${smile.observationCount}\n`);

  const results: Record<string, Record<string, SimResult>> = {};
  for (const cell of CANDIDATES) {
    results[cell.cellId] = {};
    for (const regime of ["calm", "moderate", "elevated", "stress"] as const) {
      const r = simulateCell(cell, spot, regime, smile, bars);
      results[cell.cellId][regime] = r;
      console.log(`  ${cell.cellId.padEnd(28)} ${regime.padEnd(9)} hedge=${fmt$(r.hedgeCost)} F=${fmt$Signed(r.meanFoxifyEv)} A=${fmt$Signed(r.meanAtticusEv)} trig=${fmtPct(r.triggerRate)}`);
    }
  }

  // Write report
  const lines: string[] = [];
  lines.push(`# Phase 1 Cell Sweep`);
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Spot anchor:** \$${spot.toLocaleString()}`);
  lines.push(`**Paths per cell × regime:** ${N_PATHS.toLocaleString()}`);
  lines.push(`**Smile fit:** a0=${(smile.a0 * 100).toFixed(2)}% (ATM IV), a1=${smile.a1.toFixed(3)} (skew), a2=${smile.a2.toFixed(3)}, R²=${smile.rSquared.toFixed(2)}`);
  lines.push("");

  for (const regime of ["calm", "moderate", "elevated", "stress"] as const) {
    lines.push(`## ${regime[0].toUpperCase() + regime.slice(1)} regime (σ=${REGIME_SIGMAS[regime]})`);
    lines.push("");
    lines.push(`| Cell | Hedge cost | Trigger rate | Mean salvage | **Foxify EV** | Atticus EV | %profitable | P5 Foxify | Verdict |`);
    lines.push(`|---|---:|---:|---:|---:|---:|---:|---:|---|`);
    
    const ranked = CANDIDATES
      .map((c) => ({ cell: c, result: results[c.cellId][regime] }))
      .sort((a, b) => b.result.meanFoxifyEv - a.result.meanFoxifyEv);
    
    for (const { cell, result: r } of ranked) {
      const verdict = r.meanFoxifyEv > 200 ? "✅ PROFITABLE" : r.meanFoxifyEv > 0 ? "⚠️ MARGINAL" : "❌ LOSS";
      lines.push(
        `| ${cell.cellId} | ${fmt$(r.hedgeCost)} | ${fmtPct(r.triggerRate)} | ${fmt$(r.meanSalvage)} | **${fmt$Signed(r.meanFoxifyEv)}** | ${fmt$Signed(r.meanAtticusEv)} | ${fmtPct(r.pctProfit)} | ${fmt$Signed(r.p5FoxifyEv)} | ${verdict} |`
      );
    }
    lines.push("");
  }

  // Recommendation
  lines.push(`## Recommended cell allowlist per regime`);
  lines.push("");
  for (const regime of ["calm", "moderate", "elevated", "stress"] as const) {
    const winners = CANDIDATES
      .map((c) => ({ cell: c, result: results[c.cellId][regime] }))
      .filter((x) => x.result.meanFoxifyEv > 200)
      .sort((a, b) => b.result.meanFoxifyEv - a.result.meanFoxifyEv)
      .map((x) => x.cell.cellId);
    lines.push(`- **${regime}**: ${winners.length === 0 ? "_(no cell profitable — recommend halt)_" : winners.join(", ")}`);
  }
  lines.push("");

  // Cell descriptions
  lines.push(`## Candidate cell descriptions`);
  lines.push("");
  for (const c of CANDIDATES) lines.push(`- **${c.cellId}**: ${c.description}`);

  lines.push("");
  lines.push(`---`);
  lines.push(`*Generated by services/api/scripts/backtest/singleSide/runCellSweep.ts*`);

  const outPath = path.resolve(process.cwd(), "../..", `docs/PHASE_1_CELL_SWEEP_${new Date().toISOString().slice(0, 10)}.md`);
  await fs.writeFile(outPath, lines.join("\n"));
  console.log(`\n✓ Cell sweep report written: ${outPath}`);
};

import { fileURLToPath } from "node:url";
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
