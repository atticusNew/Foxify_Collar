/**
 * V5 cell sweep — liquid-picked strikes used CONSISTENTLY for cost AND salvage.
 *
 * Fixes V4's inconsistency where the picker selected liquid strikes for cost
 * but the BS salvage calculation used the original target strikes.
 *
 * For each cell: pick the liquid strikes via pickLiquidStrike, then use THOSE
 * strikes for both hedge cost (live ask) AND salvage simulation (BS at picked strikes).
 *
 * Output: docs/PHASE_1_CELL_SWEEP_V5_<date>.md
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { bsPut, bsCall } from "./coreEngine";
import {
  generateBootstrapPath,
  generateGbmPath,
  load5MinBars,
  mulberry32,
  type PathConfig
} from "./monteCarloEngine";
import { fetchFullChainSnapshot, pickLiquidStrike, type DeribitQuote } from "./liquidStrikePicker";

const RFR = 0.045;
const N_PATHS = 8_000;
const BAR_MINUTES = 5;

type Cell = {
  cellId: string;
  notionalUsdcPerLeg: number;
  triggerPct: number;
  tenorDays: number;
  putItmPct: number;
  callItmPct: number;
  contractsBtc: number;
  strikeGrid: number;
};

const CELLS: Cell[] = [
  { cellId: "pair_50k_2pct_itm", notionalUsdcPerLeg: 50_000, triggerPct: 0.02, tenorDays: 3, putItmPct: 0.013, callItmPct: 0.013, contractsBtc: 1.4, strikeGrid: 1_000 },
  { cellId: "pair_50k_3pct_atm", notionalUsdcPerLeg: 50_000, triggerPct: 0.03, tenorDays: 2, putItmPct: 0, callItmPct: 0, contractsBtc: 1.0, strikeGrid: 1_000 },
  { cellId: "pair_50k_5pct_otm", notionalUsdcPerLeg: 50_000, triggerPct: 0.05, tenorDays: 2, putItmPct: -0.015, callItmPct: -0.020, contractsBtc: 1.0, strikeGrid: 1_000 },
  { cellId: "pair_25k_5pct_otm_short", notionalUsdcPerLeg: 25_000, triggerPct: 0.05, tenorDays: 1, putItmPct: -0.020, callItmPct: -0.025, contractsBtc: 0.5, strikeGrid: 1_000 },
  { cellId: "pair_50k_4pct_otm_short", notionalUsdcPerLeg: 50_000, triggerPct: 0.04, tenorDays: 1, putItmPct: -0.010, callItmPct: -0.015, contractsBtc: 1.0, strikeGrid: 1_000 },
  { cellId: "pair_25k_5pct_otm_3d", notionalUsdcPerLeg: 25_000, triggerPct: 0.05, tenorDays: 3, putItmPct: -0.020, callItmPct: -0.025, contractsBtc: 0.5, strikeGrid: 1_000 }
];

const REGIME_SIGMAS = { calm: 0.35, moderate: 0.55, elevated: 0.75, stress: 0.95 };
const REGIME_MARKUP = { calm: 1.0, moderate: 1.15, elevated: 1.35, stress: 1.60 };

const computeNaiveStrikes = (cell: Cell, spot: number): { put: number; call: number } => {
  const rawPut = spot * (1 + cell.putItmPct);
  const rawCall = spot * (1 - cell.callItmPct);
  return {
    put: Math.ceil(rawPut / cell.strikeGrid) * cell.strikeGrid,
    call: Math.floor(rawCall / cell.strikeGrid) * cell.strikeGrid
  };
};

type SimResult = {
  hedgeCost: number;
  meanSalvage: number;
  triggerRate: number;
  meanFoxifyEv: number;
  meanAtticusEv: number;
  pctProfit: number;
  p5FoxifyEv: number;
  putStrike: number;
  callStrike: number;
  putInstr: string;
  callInstr: string;
  picker: string;
};

const simulate = async (
  cell: Cell,
  spot: number,
  regime: keyof typeof REGIME_MARKUP,
  bars: { close: number; high: number; low: number; open: number }[] | null,
  liveChain: DeribitQuote[],
  splitPct = 0.85,
  floorUsdc = 25
): Promise<SimResult> => {
  const sigma = REGIME_SIGMAS[regime];
  const markup = REGIME_MARKUP[regime];
  const { put: putTargetStrike, call: callTargetStrike } = computeNaiveStrikes(cell, spot);

  // Pick liquid strikes (with moneyness preservation)
  const putPick = pickLiquidStrike(liveChain, putTargetStrike, cell.tenorDays, "put", spot);
  const callPick = pickLiquidStrike(liveChain, callTargetStrike, cell.tenorDays, "call", spot);

  // Use the picked strikes throughout sim. If no pick (chain empty), fall back to target.
  const putStrike = putPick.picked?.strike ?? putTargetStrike;
  const callStrike = callPick.picked?.strike ?? callTargetStrike;
  const putAskPerBtc = (putPick.picked?.askUsdcPerBtc ?? 0) * markup;
  const callAskPerBtc = (callPick.picked?.askUsdcPerBtc ?? 0) * markup;
  const hedgeCost = (putAskPerBtc + callAskPerBtc) * cell.contractsBtc;
  // Slip from observed spread, capped at sensible bounds
  const slip = Math.min(
    putPick.picked ? Math.max(0.65, Math.min(0.95, 0.95 - putPick.picked.spreadPct * 1.5)) : 0.78,
    callPick.picked ? Math.max(0.65, Math.min(0.95, 0.95 - callPick.picked.spreadPct * 1.5)) : 0.78
  );

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
      // Use PICKED strikes for salvage BS
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
    hedgeCost,
    meanSalvage: mean(salvages),
    triggerRate: triggers / N_PATHS,
    meanFoxifyEv: mean(foxifyEvs),
    meanAtticusEv: mean(atticusEvs),
    pctProfit: foxifyEvs.filter((x) => x > 0).length / foxifyEvs.length,
    p5FoxifyEv: sortedF[Math.floor(sortedF.length * 0.05)],
    putStrike,
    callStrike,
    putInstr: putPick.picked?.instrument_name ?? "(none)",
    callInstr: callPick.picked?.instrument_name ?? "(none)",
    picker: `${putPick.picker}/${callPick.picker}`
  };
};

const fmt$ = (n: number) => `${n < 0 ? "-" : ""}\$${Math.round(Math.abs(n)).toLocaleString()}`;
const fmt$S = (n: number) => `${n < 0 ? "-" : "+"}\$${Math.round(Math.abs(n)).toLocaleString()}`;
const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;

const main = async () => {
  const startedAt = new Date();
  console.log(`# Cell Sweep V5 — consistent liquid-picked strikes (cost AND salvage)\n`);
  console.log(`UTC: ${startedAt.toISOString()} (hour ${startedAt.getUTCHours()}, ${startedAt.getUTCHours() < 8 || startedAt.getUTCHours() >= 21 ? "ASIA" : startedAt.getUTCHours() < 13 ? "EU" : "US"} session)\n`);
  const bars = await load5MinBars().catch(() => null);

  console.log("Fetching live Deribit chain snapshot...");
  const { spot, quotes } = await fetchFullChainSnapshot();
  console.log(`Spot: \$${spot.toFixed(0)}, ${quotes.length} quoted instruments\n`);

  const results: Record<string, Record<string, SimResult>> = {};
  for (const cell of CELLS) {
    results[cell.cellId] = {};
    for (const regime of ["calm", "moderate", "elevated", "stress"] as const) {
      const r = await simulate(cell, spot, regime, bars, quotes);
      results[cell.cellId][regime] = r;
      const strikeNote = (r.putStrike !== computeNaiveStrikes(cell, spot).put || r.callStrike !== computeNaiveStrikes(cell, spot).call)
        ? `🔀 strikes shifted to p=${r.putStrike}/c=${r.callStrike}` : "✓";
      console.log(`  ${cell.cellId.padEnd(28)} ${regime.padEnd(9)} hedge=${fmt$(r.hedgeCost).padStart(7)} F=${fmt$S(r.meanFoxifyEv).padStart(8)} A=${fmt$S(r.meanAtticusEv).padStart(7)} trig=${fmtPct(r.triggerRate).padStart(6)} ${strikeNote}`);
    }
  }

  // Build report
  const lines: string[] = [];
  lines.push(`# Phase 1 Cell Sweep V5 — CONSISTENT LIQUID-STRIKE MODEL`);
  lines.push("");
  lines.push(`**Generated:** ${startedAt.toISOString()}`);
  lines.push(`**Spot:** \$${spot.toFixed(0)}`);
  lines.push(`**UTC hour:** ${startedAt.getUTCHours()} (${startedAt.getUTCHours() < 8 || startedAt.getUTCHours() >= 21 ? "ASIA" : startedAt.getUTCHours() < 13 ? "EU" : "US"} session)`);
  lines.push(`**Chain instruments:** ${quotes.length}`);
  lines.push(`**Cost model:** liquid pick (moneyness-preserving), strikes used CONSISTENTLY for cost AND salvage`);
  lines.push("");
  lines.push(`## Per-regime sweep`);
  lines.push("");
  for (const regime of ["calm", "moderate", "elevated", "stress"] as const) {
    lines.push(`### ${regime[0].toUpperCase() + regime.slice(1)} (σ=${REGIME_SIGMAS[regime]})`);
    lines.push("");
    lines.push(`| Cell | Picker | Picked K (p/c) | Hedge | Trigger | Salvage | **Foxify EV** | Atticus EV | %profit | P5 |`);
    lines.push(`|---|---|---|---:|---:|---:|---:|---:|---:|---:|`);
    const ranked = CELLS
      .map((c) => ({ cell: c, r: results[c.cellId][regime] }))
      .sort((a, b) => b.r.meanFoxifyEv - a.r.meanFoxifyEv);
    for (const { cell, r } of ranked) {
      const targets = computeNaiveStrikes(cell, spot);
      const shift = (r.putStrike !== targets.put || r.callStrike !== targets.call) ? "🔀" : "";
      lines.push(`| ${cell.cellId} | ${r.picker} | \$${r.putStrike}/\$${r.callStrike} ${shift} | ${fmt$(r.hedgeCost)} | ${fmtPct(r.triggerRate)} | ${fmt$(r.meanSalvage)} | **${fmt$S(r.meanFoxifyEv)}** | ${fmt$S(r.meanAtticusEv)} | ${fmtPct(r.pctProfit)} | ${fmt$S(r.p5FoxifyEv)} |`);
    }
    lines.push("");
  }

  lines.push(`## Methodology note`);
  lines.push("");
  lines.push(`Unlike V4, V5 uses the LIQUID-PICKED strikes for BOTH:`);
  lines.push(`- Hedge cost (live ask × markup)`);
  lines.push(`- Salvage BS valuation (peak option value at picked strikes)`);
  lines.push("");
  lines.push(`This is internally consistent: if we'd buy 74000-P/73500-C live, we'd also salvage at those strikes.`);
  lines.push(`Foxify EV here is the honest answer to "what would we make if we deployed liquid picker in production".`);
  lines.push("");
  lines.push(`## What changed from V3 vs V4 vs V5`);
  lines.push("");
  lines.push(`| Iteration | Cost source | Salvage strikes |`);
  lines.push(`|---|---|---|`);
  lines.push(`| V3 | Smile-fit BS + avg spread, exact target strikes | exact target strikes |`);
  lines.push(`| V4 | Liquid-picked instruments | exact target strikes ❌ inconsistent |`);
  lines.push(`| V5 | Liquid-picked instruments | liquid-picked strikes ✅ consistent |`);
  lines.push("");

  lines.push(`---`);
  lines.push(`*Generated by services/api/scripts/backtest/singleSide/runCellSweepV5.ts*`);

  const outPath = path.resolve(process.cwd(), "../..", `docs/PHASE_1_CELL_SWEEP_V5_${new Date().toISOString().slice(0, 10)}.md`);
  await fs.writeFile(outPath, lines.join("\n"));
  console.log(`\n✓ V5 report: ${outPath}`);
};

import { fileURLToPath } from "node:url";
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
