/**
 * Cell sweep V3 — multi-tenor smile-aware live pricing.
 *
 * Replaces V2 (single 3d smile) with per-cell tenor-correct smile from
 * /tmp/two_sided_smile_multi.json. Produces docs/PHASE_1_CELL_SWEEP_V3_<date>.md.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { bsPut, bsCall } from "./coreEngine";
import { generateBootstrapPath, generateGbmPath, load5MinBars, mulberry32, type PathConfig } from "./monteCarloEngine";
import { loadLiveMultiTenorData, livePerLegAskV3, liveSlippageHaircutV3 } from "./liveCellPricingV3";

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
  { cellId: "pair_50k_2pct_itm", notionalUsdcPerLeg: 50_000, triggerPct: 0.02, tenorDays: 3, putStrikeOffsetPct: 0.013, callStrikeOffsetPct: 0.013, contractsBtc: 1.4, strikeGridUsdc: 1_000, description: "Phase 0 baseline ITM guts 3d ±2%" },
  { cellId: "pair_100k_3pct_itm_short", notionalUsdcPerLeg: 100_000, triggerPct: 0.03, tenorDays: 2, putStrikeOffsetPct: 0.005, callStrikeOffsetPct: 0.005, contractsBtc: 2.0, strikeGridUsdc: 1_000, description: "0.5% ITM 2d ±3%" },
  { cellId: "pair_50k_3pct_atm", notionalUsdcPerLeg: 50_000, triggerPct: 0.03, tenorDays: 2, putStrikeOffsetPct: 0, callStrikeOffsetPct: 0, contractsBtc: 1.0, strikeGridUsdc: 1_000, description: "ATM 2d ±3%" },
  { cellId: "pair_50k_5pct_otm", notionalUsdcPerLeg: 50_000, triggerPct: 0.05, tenorDays: 2, putStrikeOffsetPct: -0.015, callStrikeOffsetPct: -0.020, contractsBtc: 1.0, strikeGridUsdc: 1_000, description: "OTM 2d ±5%" },
  { cellId: "pair_25k_5pct_otm_short", notionalUsdcPerLeg: 25_000, triggerPct: 0.05, tenorDays: 1, putStrikeOffsetPct: -0.020, callStrikeOffsetPct: -0.025, contractsBtc: 0.5, strikeGridUsdc: 1_000, description: "OTM 1d ±5% small" },
  { cellId: "pair_50k_4pct_otm_short", notionalUsdcPerLeg: 50_000, triggerPct: 0.04, tenorDays: 1, putStrikeOffsetPct: -0.010, callStrikeOffsetPct: -0.015, contractsBtc: 1.0, strikeGridUsdc: 1_000, description: "OTM 1d ±4%" },
  { cellId: "pair_25k_1pct_atm_micro", notionalUsdcPerLeg: 25_000, triggerPct: 0.01, tenorDays: 0.25, putStrikeOffsetPct: 0, callStrikeOffsetPct: 0, contractsBtc: 0.3, strikeGridUsdc: 1_000, description: "ATM 6h ±1% micro" }
];

const REGIME_SIGMAS = { calm: 0.35, moderate: 0.55, elevated: 0.75, stress: 0.95 };
const REGIME_MARKUP = { calm: 1.0, moderate: 1.15, elevated: 1.35, stress: 1.60 };

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
  bucketUsed: string;
};

const simulateV3 = async (
  cell: CellCandidate,
  spot: number,
  regime: "calm" | "moderate" | "elevated" | "stress",
  bars: { close: number; high: number; low: number; open: number }[] | null,
  splitPct = 0.85,
  floorUsdc = 25
): Promise<SimResult> => {
  const sigma = REGIME_SIGMAS[regime];
  const markup = REGIME_MARKUP[regime];
  const data = await loadLiveMultiTenorData();
  const { put: putStrike, call: callStrike } = computeStrikes(cell, spot);
  const putAskPerBtc = livePerLegAskV3(data, spot, putStrike, "put", cell.tenorDays, markup);
  const callAskPerBtc = livePerLegAskV3(data, spot, callStrike, "call", cell.tenorDays, markup);
  const putLegCost = putAskPerBtc * cell.contractsBtc;
  const callLegCost = callAskPerBtc * cell.contractsBtc;
  const hedgeCost = putLegCost + callLegCost;
  const putSlip = liveSlippageHaircutV3(data, putStrike, "put", cell.contractsBtc, cell.tenorDays);
  const callSlip = liveSlippageHaircutV3(data, callStrike, "call", cell.contractsBtc, cell.tenorDays);
  const slip = Math.min(putSlip, callSlip);
  const bucketUsed = data
    ? `${[...data.buckets].sort((a, b) => Math.abs(a.targetHours/24 - cell.tenorDays) - Math.abs(b.targetHours/24 - cell.tenorDays))[0].label}`
    : "fallback";

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
    effectiveSlip: slip, bucketUsed
  };
};

const fmt$ = (n: number) => `${n < 0 ? "-" : ""}\$${Math.round(Math.abs(n)).toLocaleString()}`;
const fmt$Signed = (n: number) => `${n < 0 ? "-" : "+"}\$${Math.round(Math.abs(n)).toLocaleString()}`;
const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;

const main = async () => {
  console.log("# Cell sweep V3 (multi-tenor live spreads)\n");
  const bars = await load5MinBars().catch(() => null);
  const data = await loadLiveMultiTenorData();
  if (!data) { console.log("⚠ no multi-tenor data; aborting"); process.exit(1); }
  const spot = data.spotAtPull;
  console.log(`Spot: \$${spot.toFixed(0)}, buckets: ${data.buckets.map(b => `${b.label}(${b.smileObservations.length} obs)`).join(", ")}\n`);

  const results: Record<string, Record<string, SimResult>> = {};
  for (const cell of CANDIDATES) {
    results[cell.cellId] = {};
    for (const regime of ["calm", "moderate", "elevated", "stress"] as const) {
      const r = await simulateV3(cell, spot, regime, bars);
      results[cell.cellId][regime] = r;
      console.log(`  ${cell.cellId.padEnd(28)} ${regime.padEnd(9)} hedge=${fmt$(r.hedgeCost)} bucket=${r.bucketUsed} slip=${r.effectiveSlip.toFixed(2)} F=${fmt$Signed(r.meanFoxifyEv)} A=${fmt$Signed(r.meanAtticusEv)} trig=${fmtPct(r.triggerRate)}`);
    }
  }

  const lines: string[] = [];
  lines.push(`# Phase 1 Cell Sweep V3 — MULTI-TENOR LIVE SPREADS`);
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Spot:** \$${spot.toFixed(0)}`);
  lines.push(`**Multi-tenor buckets:** ${data.buckets.map(b => `${b.label} (${b.smileObservations.length} smile obs)`).join(", ")}`);
  lines.push(`**Cost model:** per-tenor smile fit + live ask + observed spread + depth-aware slip`);
  lines.push(`**Regime markup:** calm 1.00x, moderate 1.15x, elevated 1.35x, stress 1.60x`);
  lines.push("");

  for (const regime of ["calm", "moderate", "elevated", "stress"] as const) {
    lines.push(`## ${regime[0].toUpperCase() + regime.slice(1)} regime (σ=${REGIME_SIGMAS[regime]})`);
    lines.push("");
    lines.push(`| Cell | Tenor bucket | Hedge | Slip | Trigger | Salvage | **Foxify EV** | Atticus EV | %profit | P5 | Verdict |`);
    lines.push(`|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|`);
    const ranked = CANDIDATES
      .map((c) => ({ cell: c, result: results[c.cellId][regime] }))
      .sort((a, b) => b.result.meanFoxifyEv - a.result.meanFoxifyEv);
    for (const { cell, result: r } of ranked) {
      const verdict = r.meanFoxifyEv > 100 ? "✅ PROFITABLE" : r.meanFoxifyEv > 0 ? "⚠️ MARGINAL" : "❌ LOSS";
      lines.push(`| ${cell.cellId} | ${r.bucketUsed} | ${fmt$(r.hedgeCost)} | ${r.effectiveSlip.toFixed(2)} | ${fmtPct(r.triggerRate)} | ${fmt$(r.meanSalvage)} | **${fmt$Signed(r.meanFoxifyEv)}** | ${fmt$Signed(r.meanAtticusEv)} | ${fmtPct(r.pctProfit)} | ${fmt$Signed(r.p5FoxifyEv)} | ${verdict} |`);
    }
    lines.push("");
  }

  lines.push(`## Recommended cell allowlist (V3)`);
  lines.push("");
  for (const regime of ["calm", "moderate", "elevated", "stress"] as const) {
    const winners = CANDIDATES
      .map((c) => ({ cell: c, result: results[c.cellId][regime] }))
      .filter((x) => x.result.meanFoxifyEv > 0)
      .sort((a, b) => b.result.meanFoxifyEv - a.result.meanFoxifyEv)
      .map((x) => `${x.cell.cellId} (${fmt$Signed(x.result.meanFoxifyEv)})`);
    lines.push(`- **${regime}**: ${winners.length === 0 ? "_(no positive cell)_" : winners.join(", ")}`);
  }
  lines.push("");

  lines.push(`---`);
  lines.push(`*Generated by services/api/scripts/backtest/singleSide/runCellSweepV3.ts*`);
  lines.push(`*Supersedes V1 (BS+1.07 fudge) and V2 (single 3d smile).*`);

  const outPath = path.resolve(process.cwd(), "../..", `docs/PHASE_1_CELL_SWEEP_V3_${new Date().toISOString().slice(0, 10)}.md`);
  await fs.writeFile(outPath, lines.join("\n"));
  console.log(`\n✓ V3 report: ${outPath}`);
};

import { fileURLToPath } from "node:url";
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
