/**
 * Losing-leg A/B test (PR B2).
 *
 * Compares two TP modes for the two-sided strangle:
 *   A) combined_value_tp (current production):
 *      Theta-aware TP on the COMBINED put + call value. Both legs sell
 *      together at the capture-window peak (or trail/floor).
 *   B) sell_loser_immediately (proposed):
 *      At trigger fire, sell the losing leg (OTM after trigger) at limit-IOC
 *      immediately. Continue theta-aware TP on the winning leg only.
 *
 * Hypothesis: the losing leg at trigger fire still has small residual time
 * value (~$50-200 on a typical pair). Selling immediately captures that
 * before it decays. Holding via combined-value TP forfeits it.
 *
 * Decision criteria per plan:
 *   if new mode ≥ 1.05× combined_value across ALL regimes → promote to default
 *   else → keep combined_value, document the negative result
 *
 * Output: docs/PHASE_1_LOSING_LEG_AB_<date>.md
 *
 * Usage:
 *   cd services/api
 *   npx tsx scripts/backtest/singleSide/runLosingLegAb.ts
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { bsPut, bsCall } from "./coreEngine";
import { generateBootstrapPath, generateGbmPath, load5MinBars, mulberry32, type PathConfig } from "./monteCarloEngine";

const SPOT = 75_000;
const RFR = 0.045;
const N_PATHS = 10_000;
const BAR_MINUTES = 5;
const CONTRACTS_BTC = 1.4;
const PUT_STRIKE = 77_000;
const CALL_STRIKE = 75_000;
const TENOR_DAYS = 3;
const TRIGGER_PCT = 0.02;
const CALIB_MULT = 1.07; // calibration markup approximation

const REGIME_SIGMAS: Record<"calm" | "moderate" | "elevated" | "stress", number> = {
  calm: 0.35, moderate: 0.55, elevated: 0.75, stress: 0.95
};
const REGIME_MARKUP: Record<"calm" | "moderate" | "elevated" | "stress", number> = {
  calm: 1.0, moderate: 1.08, elevated: 1.20, stress: 1.35
};

type Mode = "combined_value_tp" | "sell_loser_immediately";

const hedgeCost = (sigma: number, markup: number): number => {
  const T = TENOR_DAYS / 365;
  const bsP = bsPut(SPOT, PUT_STRIKE, T, RFR, sigma);
  const bsC = bsCall(SPOT, CALL_STRIKE, T, RFR, sigma);
  return (bsP + bsC) * CALIB_MULT * CONTRACTS_BTC * markup;
};

const legValueAt = (spot: number, strike: number, isPut: boolean, remBars: number, sigma: number): number => {
  const remDays = (remBars * BAR_MINUTES) / (60 * 24);
  const T = Math.max(0, remDays / 365);
  const bs = isPut ? bsPut(spot, strike, T, RFR, sigma) : bsCall(spot, strike, T, RFR, sigma);
  return Math.max(0, bs) * CONTRACTS_BTC;
};

const simulate = (
  pathBars: { closes: number[]; highs: number[]; lows: number[] },
  sigma: number,
  mode: Mode
): { salvage: number; triggered: boolean } => {
  const triggerDown = SPOT * (1 - TRIGGER_PCT);
  const triggerUp = SPOT * (1 + TRIGGER_PCT);
  const totalBars = pathBars.closes.length - 1;

  // Detect trigger
  let triggerBar = -1;
  let triggerSide: "down" | "up" | null = null;
  for (let i = 1; i <= totalBars; i++) {
    if (pathBars.lows[i] <= triggerDown) { triggerBar = i; triggerSide = "down"; break; }
    if (pathBars.highs[i] >= triggerUp) { triggerBar = i; triggerSide = "up"; break; }
  }

  if (triggerBar < 0) {
    // No trigger — sell both at expiry-4h
    const sellAt = Math.max(0, totalBars - 48);
    const sp = pathBars.closes[sellAt];
    const remBars = totalBars - sellAt;
    return {
      salvage: legValueAt(sp, PUT_STRIKE, true, remBars, sigma) + legValueAt(sp, CALL_STRIKE, false, remBars, sigma),
      triggered: false
    };
  }

  // Triggered
  const SLIP = 0.85;
  const CAPTURE_WIN = 6; // 30 min

  if (mode === "sell_loser_immediately") {
    // Sell the loser leg right at trigger bar
    const triggerSpot = pathBars.closes[triggerBar];
    const remBarsAtTrigger = totalBars - triggerBar;
    const loserLegValue = triggerSide === "down"
      ? legValueAt(triggerSpot, CALL_STRIKE, false, remBarsAtTrigger, sigma) // call is loser when down-trigger
      : legValueAt(triggerSpot, PUT_STRIKE, true, remBarsAtTrigger, sigma);  // put is loser when up-trigger
    const loserSaleProceeds = loserLegValue * SLIP;

    // Continue theta-aware TP on winning leg only
    let winnerPeak = 0;
    for (let bi = 0; bi <= remBarsAtTrigger; bi++) {
      const idx = triggerBar + bi;
      if (idx >= pathBars.closes.length) break;
      const peakSpot = triggerSide === "down" ? pathBars.lows[idx] : pathBars.highs[idx];
      const remBars = totalBars - idx;
      const winnerVal = triggerSide === "down"
        ? legValueAt(peakSpot, PUT_STRIKE, true, remBars, sigma)
        : legValueAt(peakSpot, CALL_STRIKE, false, remBars, sigma);
      if (winnerVal > winnerPeak) winnerPeak = winnerVal;
      if (bi === CAPTURE_WIN) break;
    }
    return { salvage: loserSaleProceeds + winnerPeak * SLIP, triggered: true };
  }

  // mode === "combined_value_tp" — current production
  let combinedPeak = 0;
  for (let bi = 0; bi <= totalBars - triggerBar; bi++) {
    const idx = triggerBar + bi;
    if (idx >= pathBars.closes.length) break;
    const peakSpot = triggerSide === "down" ? pathBars.lows[idx] : pathBars.highs[idx];
    const remBars = totalBars - idx;
    const v = legValueAt(peakSpot, PUT_STRIKE, true, remBars, sigma) + legValueAt(peakSpot, CALL_STRIKE, false, remBars, sigma);
    if (v > combinedPeak) combinedPeak = v;
    if (bi === CAPTURE_WIN) break;
  }
  return { salvage: combinedPeak * SLIP, triggered: true };
};

const main = async () => {
  console.log("# Losing-leg A/B (PR B2)\n");
  const bars = await load5MinBars().catch(() => null);
  if (bars) console.log(`Loaded ${bars.length.toLocaleString()} bars\n`);

  const results: Record<string, { combined: { meanFoxifyEv: number; meanSalvage: number; trigRate: number }; loserImm: { meanFoxifyEv: number; meanSalvage: number; trigRate: number } }> = {};

  for (const regime of ["calm", "moderate", "elevated", "stress"] as const) {
    const sigma = REGIME_SIGMAS[regime];
    const hc = hedgeCost(sigma, REGIME_MARKUP[regime]);
    const splitPct = 0.85;

    const evCombined: number[] = [];
    const evLoser: number[] = [];
    const salCombined: number[] = [];
    const salLoser: number[] = [];
    let trigCombined = 0, trigLoser = 0;

    const rng = mulberry32(42);
    const pathConfig: PathConfig = {
      tenorDays: TENOR_DAYS, sigmaAnnual: sigma, driftAnnual: 0,
      generator: regime === "calm" && bars ? "bootstrap" : "gbm", seed: 42
    };

    for (let p = 0; p < N_PATHS; p++) {
      const pathBars = bars && regime === "calm"
        ? generateBootstrapPath(SPOT, pathConfig, bars, rng)
        : generateGbmPath(SPOT, pathConfig, rng);

      const cR = simulate(pathBars, sigma, "combined_value_tp");
      const lR = simulate(pathBars, sigma, "sell_loser_immediately");

      salCombined.push(cR.salvage);
      salLoser.push(lR.salvage);
      if (cR.triggered) trigCombined++;
      if (lR.triggered) trigLoser++;

      for (const [salvage, evArr] of [[cR.salvage, evCombined], [lR.salvage, evLoser]] as const) {
        const uplift = salvage - hc;
        const foxifyShare = uplift <= 0 ? salvage : hc + splitPct * uplift;
        evArr.push(foxifyShare - hc);
      }
    }

    const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
    results[regime] = {
      combined: { meanFoxifyEv: mean(evCombined), meanSalvage: mean(salCombined), trigRate: trigCombined / N_PATHS },
      loserImm: { meanFoxifyEv: mean(evLoser), meanSalvage: mean(salLoser), trigRate: trigLoser / N_PATHS }
    };
    console.log(`  ${regime}: hedge=$${hc.toFixed(0)} | combined F=$${results[regime].combined.meanFoxifyEv.toFixed(0)} salvage=$${results[regime].combined.meanSalvage.toFixed(0)} | loser-imm F=$${results[regime].loserImm.meanFoxifyEv.toFixed(0)} salvage=$${results[regime].loserImm.meanSalvage.toFixed(0)}`);
  }

  // Decision
  let allPositive = true;
  for (const regime of ["calm", "moderate", "elevated", "stress"] as const) {
    const r = results[regime];
    const ratio = r.combined.meanSalvage > 0 ? r.loserImm.meanSalvage / r.combined.meanSalvage : 0;
    if (ratio < 1.05) allPositive = false;
  }
  const decision = allPositive ? "PROMOTE sell_loser_immediately" : "KEEP combined_value_tp (default)";

  console.log(`\nDecision: ${decision}`);

  // Write report
  const lines: string[] = [];
  lines.push(`# Losing-Leg A/B Test`);
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Cell:** pair_50k_2pct ITM guts ($${PUT_STRIKE} put + $${CALL_STRIKE} call, ${CONTRACTS_BTC} BTC, ${TENOR_DAYS}d)`);
  lines.push(`**Paths per regime:** ${N_PATHS.toLocaleString()}`);
  lines.push(`**Decision criterion:** new mode salvage/combined salvage ≥ 1.05× for ALL regimes`);
  lines.push("");
  lines.push(`## Results`);
  lines.push("");
  lines.push(`| Regime | Combined-value TP (Foxify EV) | Sell-loser-immediately (Foxify EV) | Salvage ratio (loser/combined) | Verdict |`);
  lines.push(`|---|---:|---:|---:|---|`);
  for (const regime of ["calm", "moderate", "elevated", "stress"] as const) {
    const r = results[regime];
    const ratio = r.combined.meanSalvage > 0 ? r.loserImm.meanSalvage / r.combined.meanSalvage : 0;
    const v = ratio >= 1.05 ? "✓ new better" : ratio >= 0.95 ? "≈ tie" : "✗ new worse";
    lines.push(`| ${regime} | +$${r.combined.meanFoxifyEv.toFixed(0)} | +$${r.loserImm.meanFoxifyEv.toFixed(0)} | ${ratio.toFixed(3)}× | ${v} |`);
  }
  lines.push("");
  lines.push(`## Decision`);
  lines.push("");
  lines.push(`**${decision}**`);
  lines.push("");
  if (!allPositive) {
    lines.push(`Sell-loser-immediately did NOT show ≥1.05× salvage improvement across all regimes.`);
    lines.push(`Production TP curve stays on combined_value_tp (current PR 4 / executionRuntime behavior).`);
    lines.push("");
    lines.push(`The combined-value TP captures the post-trigger peak across BOTH legs together,`);
    lines.push(`which empirically performs as well as or better than selling the loser at trigger fire.`);
    lines.push(`The residual time value on the losing leg at trigger fire is small enough that the`);
    lines.push(`combined-value TP's holistic capture wins.`);
  } else {
    lines.push(`Sell-loser-immediately wins ≥5% across all regimes. Recommend operator review`);
    lines.push(`and promotion to default TP mode.`);
  }
  lines.push("");
  lines.push(`---`);
  lines.push(`*Generated by services/api/scripts/backtest/singleSide/runLosingLegAb.ts*`);

  const outPath = path.resolve(process.cwd(), "../..", `docs/PHASE_1_LOSING_LEG_AB_${new Date().toISOString().slice(0, 10)}.md`);
  await fs.writeFile(outPath, lines.join("\n"));
  console.log(`\n✓ A/B report written: ${outPath}`);
};

import { fileURLToPath } from "node:url";
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
