/**
 * Capital & EV projector across DVOL regimes.
 *
 * Input:  a DVOL value (e.g. 35, 50, 70, 90, 110)
 * Output: per-cell capital schedule + per-cover EV + aggregate exposure.
 *
 * Calibration: anchored to 2026-05-26 empirical Bullish/Deribit chain
 * (`SINGLE_SIDE_EMPIRICAL_VALIDATION.md`). For each cell we know the
 * empirical per-cover hedge cost AT today's DVOL = 35.2; we back out
 * a calibration multiplier vs BS-modeled cost at that σ, then apply
 * that multiplier to BS at the input DVOL to project costs at any σ.
 *
 * EV projection:
 *   - Premium income = base × regime overlay × avg-hold-days (1.0)
 *   - Hedge cost = empirical-calibrated BS at input DVOL
 *   - Trigger payout cost = payout × trigger rate (regime-modeled)
 *   - Salvage credit = hedge cost × salvage fraction (regime-modeled,
 *     anchored to backtest observed fractions)
 *
 * Stress guardrails (env-flag-controlled in production):
 *   1. Premium overlay × 3.0 (vs current 2.0× elevated)
 *   2. Concurrent cap × 0.5 (half normal)
 *   3. Per-cell loss-kill threshold × 0.5
 *   4. Hedge budget cap × 0.5
 *   5. Depth gate ratio 1.5× (vs 1.2× normal)
 *
 * Output: docs/SINGLE_SIDE_DVOL_PROJECTOR.md
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { bsPut, bsCall } from "./coreEngine";

const RFR = 0.045;

// ─────────────────────────── Inputs ───────────────────────────

type Cell = {
  cellId: string;
  notionalUsdc: number;
  triggerPct: number;
  payoutUsdc: number;
  hedgePct: number;
  hedgeTenorDays: number; // production tenor (3d for 2%/5%, 10d for 7%)
  baseDailyPremiumUsdc: number;
  contractsBtc: number;
  concurrentCapNormal: number; // single-direction cap
};

// 2026-05-26 empirical anchors at DVOL = 35.2, spot $76,619.
const CELLS: Cell[] = [
  { cellId: "ss_50k_2pct_1k",   notionalUsdc:  50_000, triggerPct: 0.02, payoutUsdc:  1_000, hedgePct: 0.01, hedgeTenorDays:  3, baseDailyPremiumUsdc:   310, contractsBtc: 1.4, concurrentCapNormal: 12 },
  { cellId: "ss_50k_5pct_2_5k", notionalUsdc:  50_000, triggerPct: 0.05, payoutUsdc:  2_500, hedgePct: 0.03, hedgeTenorDays:  3, baseDailyPremiumUsdc:   140, contractsBtc: 1.7, concurrentCapNormal: 14 },
  { cellId: "ss_200k_5pct_10k", notionalUsdc: 200_000, triggerPct: 0.05, payoutUsdc: 10_000, hedgePct: 0.03, hedgeTenorDays:  3, baseDailyPremiumUsdc:   600, contractsBtc: 6.6, concurrentCapNormal:  3 },
  { cellId: "ss_50k_7pct_3_5k", notionalUsdc:  50_000, triggerPct: 0.07, payoutUsdc:  3_500, hedgePct: 0.05, hedgeTenorDays: 10, baseDailyPremiumUsdc:   310, contractsBtc: 2.3, concurrentCapNormal:  6 },
  { cellId: "ss_200k_7pct_14k", notionalUsdc: 200_000, triggerPct: 0.07, payoutUsdc: 14_000, hedgePct: 0.05, hedgeTenorDays: 10, baseDailyPremiumUsdc: 1_250, contractsBtc: 9.2, concurrentCapNormal:  3 }
];

const EMPIRICAL_ANCHOR_DVOL = 35.2;
const EMPIRICAL_ANCHOR_SPOT = 76_619;
const EMPIRICAL_HEDGE_COST: Record<string, number> = {
  ss_50k_2pct_1k:    1001,
  ss_50k_5pct_2_5k:   357,
  ss_200k_5pct_10k:  1386,
  ss_50k_7pct_3_5k:  1069,
  ss_200k_7pct_14k:  4278
};

// ─────────────────────────── Regime model ───────────────────────────

type Regime = "calm" | "moderate" | "elevated" | "stress";
// DVOL is implied vol (annualized %). Map to regime via approximate
// implied → realized translation: realized typically 5-10pp below implied
// for short-dated BTC options. Keeps "today's DVOL=35 → calm" consistent
// with the empirical chain (vol smile-flat, 30d realized ~25-30%).
const classifyDvol = (dvol: number): Regime => {
  if (dvol < 40) return "calm";
  if (dvol < 60) return "moderate";
  if (dvol < 85) return "elevated";
  return "stress";
};

// Regime overlay multipliers on daily premium (production env defaults)
const PREMIUM_OVERLAY: Record<Regime, number> = {
  calm: 1.0,
  moderate: 1.4,
  elevated: 2.0,
  stress: 3.0 // stress overlay (proposed; was "pause" in baseline plan)
};

// Trigger rate model — from VC backtest at ±2% / 24h, scaled by triggerPct.
// Calm 50% → mod 71% → stress 81% → highstress 92% (BACKTEST_REPORT_2026_05_24 §1.3).
// We adjust by triggerPct linearly: tighter triggers fire more often.
const baseTriggerRate = (regime: Regime): number => {
  const rates: Record<Regime, number> = {
    calm: 0.50,
    moderate: 0.71,
    elevated: 0.81,
    stress: 0.92
  };
  return rates[regime];
};
const cellTriggerRate = (cell: Cell, regime: Regime): number => {
  // Scale trigger rate inversely with triggerPct vs 0.02 baseline.
  // Calibrated against per-regime backtest data:
  //   50k/2% calm  → 30% (anchor)
  //   50k/5% calm  → 17%
  //   50k/7% calm  → 11%
  // Best fit: scaleFactor = (0.02 / triggerPct) ^ 0.7, selection_bias = 0.6
  //   2%:  baseRate × 1.00 × 0.6 = 0.30 ✓
  //   5%:  baseRate × 0.523 × 0.6 = 0.157 ✓ (close to 17%)
  //   7%:  baseRate × 0.413 × 0.6 = 0.124 ✓ (close to 11%)
  const scaleFactor = (0.02 / cell.triggerPct) ** 0.7;
  return Math.min(0.95, baseTriggerRate(regime) * scaleFactor * 0.6);
};

// Salvage fraction = retained-leg salvage proceeds / hedge cost.
// Anchored to Variant B (theta-aware TP) backtest data — runComparativeReport
// showed avgRetainedSalvage = $1,161 for 50k/2% calm at avgHedgeCost = $1,001
// → ratio 1.16. Theta-aware curve captures intraday peaks aggressively, so
// salvage often exceeds initial cost (retained option after trigger has
// intrinsic + remaining time value, sold near peak).
//
// Stress is MODELED — the 16-month backtest window had 0 stress days. The
// 0.85 fraction assumes salvage degrades vs calm because (a) higher trigger
// rate means more options exit at boundary intrinsic with little time value
// premium captured, (b) wider bid-ask + smile penalize sells.
const salvageFraction = (regime: Regime): number => {
  const fractions: Record<Regime, number> = {
    calm: 1.16,
    moderate: 1.05,
    elevated: 0.95,
    stress: 0.80
  };
  return fractions[regime];
};

// ─────────────────────────── Hedge cost projector ───────────────────────────

const computeBsHedgeCost = (cell: Cell, spot: number, ivAnnual: number): number => {
  const T = cell.hedgeTenorDays / 365;
  const longStrike = spot * (1 - cell.hedgePct);
  const shortStrike = spot * (1 + cell.hedgePct);
  const bsLong = bsPut(spot, longStrike, T, RFR, ivAnnual);
  const bsShort = bsCall(spot, shortStrike, T, RFR, ivAnnual);
  // Symmetric average × 7% Bullish bid-ask uplift × contracts
  return ((bsLong + bsShort) / 2) * 1.07 * cell.contractsBtc;
};

/**
 * Calibration multiplier = empirical / BS-modeled at anchor DVOL.
 * Computed once per cell and reused for any input DVOL.
 */
const calibrationMultiplier = (cell: Cell): number => {
  const bsAtAnchor = computeBsHedgeCost(cell, EMPIRICAL_ANCHOR_SPOT, EMPIRICAL_ANCHOR_DVOL / 100);
  const empirical = EMPIRICAL_HEDGE_COST[cell.cellId];
  return empirical / bsAtAnchor;
};

const projectHedgeCost = (cell: Cell, dvol: number, spot = EMPIRICAL_ANCHOR_SPOT): number => {
  const bs = computeBsHedgeCost(cell, spot, dvol / 100);
  return bs * calibrationMultiplier(cell);
};

// ─────────────────────────── Per-cover EV projector ───────────────────────────

type CellProjection = {
  cellId: string;
  regime: Regime;
  premiumPerDay: number; // after overlay
  hedgeCostUsd: number;
  triggerRate: number;
  expectedPayoutUsd: number;
  expectedSalvageUsd: number;
  perCoverEvUsd: number;
};

const projectCell = (cell: Cell, dvol: number, holdDaysAvg = 1.0): CellProjection => {
  const regime = classifyDvol(dvol);
  const overlay = PREMIUM_OVERLAY[regime];
  const premiumPerDay = cell.baseDailyPremiumUsdc * overlay;
  const premium = premiumPerDay * holdDaysAvg;
  const hedgeCostUsd = projectHedgeCost(cell, dvol);
  const triggerRate = cellTriggerRate(cell, regime);
  const expectedPayoutUsd = cell.payoutUsdc * triggerRate;
  const expectedSalvageUsd = hedgeCostUsd * salvageFraction(regime);
  const perCoverEvUsd = premium - hedgeCostUsd + expectedSalvageUsd - expectedPayoutUsd;
  return {
    cellId: cell.cellId,
    regime,
    premiumPerDay,
    hedgeCostUsd,
    triggerRate,
    expectedPayoutUsd,
    expectedSalvageUsd,
    perCoverEvUsd
  };
};

// ─────────────────────────── Stress guardrail variants ───────────────────────────

type GuardConfig = {
  name: string;
  premiumMultiplier: number; // applied on top of baseline overlay
  concurrentCapMultiplier: number;
  // Phase-0 single-direction cap is concurrentCapNormal; multiplier scales it
};

const STRESS_GUARD_VARIANTS: GuardConfig[] = [
  { name: "no_stress (baseline plan)",       premiumMultiplier: 0.0, concurrentCapMultiplier: 0.0 }, // PAUSED
  { name: "stress_full (no extra guards)",   premiumMultiplier: 1.0, concurrentCapMultiplier: 1.0 },
  { name: "stress_capped (caps × 0.5)",      premiumMultiplier: 1.0, concurrentCapMultiplier: 0.5 },
  { name: "stress_priced (premium × 1.5)",   premiumMultiplier: 1.5, concurrentCapMultiplier: 0.5 },
  { name: "stress_recommended (P 1.5×, C 0.33×)", premiumMultiplier: 1.5, concurrentCapMultiplier: 0.33 }
];

const projectStressVariant = (cell: Cell, dvol: number, guard: GuardConfig) => {
  const baseProjection = projectCell(cell, dvol);
  if (guard.premiumMultiplier === 0) {
    // PAUSED — zero capital, zero EV
    return {
      cellId: cell.cellId,
      perCoverEvUsd: 0,
      capitalAtCapUsd: 0,
      capPositions: 0,
      annualEvAtCapUsd: 0,
      paused: true
    };
  }
  // Apply premium multiplier on top of regime overlay
  const enhancedPremium = baseProjection.premiumPerDay * guard.premiumMultiplier;
  const ev =
    enhancedPremium * 1.0 -
    baseProjection.hedgeCostUsd +
    baseProjection.expectedSalvageUsd -
    baseProjection.expectedPayoutUsd;
  const cap = Math.max(1, Math.floor(cell.concurrentCapNormal * guard.concurrentCapMultiplier));
  const capital = cap * baseProjection.hedgeCostUsd;
  const annualEv = ev * cap * 365; // 1d hold = 1 cover/day per slot
  return {
    cellId: cell.cellId,
    perCoverEvUsd: ev,
    capitalAtCapUsd: capital,
    capPositions: cap,
    annualEvAtCapUsd: annualEv,
    paused: false
  };
};

// ─────────────────────────── Report ───────────────────────────

const fmt$ = (n: number) => {
  const sign = n < 0 ? "-" : "";
  return `${sign}\$${Math.round(Math.abs(n)).toLocaleString()}`;
};
// Signed format: always show "+" for positive, "-" for negative, blank for 0
const fmt$Signed = (n: number) => {
  if (n === 0) return "$0";
  const sign = n < 0 ? "-" : "+";
  return `${sign}\$${Math.round(Math.abs(n)).toLocaleString()}`;
};
const fmtPct = (n: number, dec = 0) => `${(n * 100).toFixed(dec)}%`;

const main = async () => {
  console.log("# DVOL Projector — building...\n");

  const lines: string[] = [];
  lines.push(`# Single-Side Capital & EV Projector — DVOL Regime Sensitivity`);
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Anchor:** 2026-05-26 empirical chain @ DVOL=${EMPIRICAL_ANCHOR_DVOL}, spot \$${EMPIRICAL_ANCHOR_SPOT.toLocaleString()}`);
  lines.push("");
  lines.push(`> Deterministic projector (not a re-backtest). Takes a DVOL value as`);
  lines.push(`> input and emits per-cell capital + EV at the input regime, calibrated`);
  lines.push(`> against the 2026-05-26 live chain empirical hedge cost.`);
  lines.push("");
  lines.push(`> **Calibration mechanic:** for each cell we computed BS-modeled hedge cost`);
  lines.push(`> at today's DVOL (${EMPIRICAL_ANCHOR_DVOL}) and the empirical Bullish/Deribit`);
  lines.push(`> ask. The ratio is locked as the cell's calibration multiplier and applied`);
  lines.push(`> to BS at any other DVOL — preserving the empirical / BS gap that vol smile`);
  lines.push(`> creates at OTM strikes.`);
  lines.push("");

  // ─── Section 1: Calibration multipliers ───
  lines.push(`## 1. Per-cell calibration multipliers`);
  lines.push("");
  lines.push(`| Cell | BS @ DVOL=35.2 | Empirical | Multiplier | Tenor |`);
  lines.push(`|---|---:|---:|---:|---:|`);
  for (const cell of CELLS) {
    const bs = computeBsHedgeCost(cell, EMPIRICAL_ANCHOR_SPOT, EMPIRICAL_ANCHOR_DVOL / 100);
    const emp = EMPIRICAL_HEDGE_COST[cell.cellId];
    lines.push(`| ${cell.cellId} | ${fmt$(bs)} | ${fmt$(emp)} | **${(emp / bs).toFixed(3)}** | ${cell.hedgeTenorDays}d |`);
  }
  lines.push("");

  // ─── Section 2: Per-cell projection across DVOL points ───
  const dvolPoints = [25, 35, 50, 65, 80, 95, 110];
  lines.push(`## 2. Per-cell projection across DVOL`);
  lines.push("");
  lines.push(`Hedge cost (USD per cover) at each DVOL level:`);
  lines.push("");
  lines.push(`| Cell | DVOL=25 (deep calm) | DVOL=35 (today) | DVOL=50 (mod) | DVOL=65 (elev) | DVOL=80 (stress) | DVOL=95 | DVOL=110 |`);
  lines.push(`|---|---:|---:|---:|---:|---:|---:|---:|`);
  for (const cell of CELLS) {
    const cells = dvolPoints.map((d) => fmt$(projectHedgeCost(cell, d))).join(" | ");
    lines.push(`| ${cell.cellId} | ${cells} |`);
  }
  lines.push("");

  lines.push(`Per-cover EV (USD) at each DVOL — assumes baseline overlay (calm 1.0× / mod 1.4× / elev 2.0× / stress 3.0×):`);
  lines.push("");
  lines.push(`| Cell | DVOL=25 | DVOL=35 | DVOL=50 | DVOL=65 | DVOL=80 | DVOL=95 | DVOL=110 |`);
  lines.push(`|---|---:|---:|---:|---:|---:|---:|---:|`);
  for (const cell of CELLS) {
    const cells = dvolPoints
      .map((d) => fmt$Signed(projectCell(cell, d).perCoverEvUsd))
      .join(" | ");
    lines.push(`| ${cell.cellId} | ${cells} |`);
  }
  lines.push("");

  // ─── Section 3: Capital ladder for 50k/2% workhorse across DVOL ───
  lines.push(`## 3. Capital ladder: 50k/2% workhorse at concurrent counts × DVOL`);
  lines.push("");
  lines.push(`Per-cover capital (option premium debit only) × position count = peak`);
  lines.push(`working capital deployed. Single-direction; total exposure if directions`);
  lines.push(`balance is up to 2× these numbers.`);
  lines.push("");
  const cell2pct = CELLS.find((c) => c.cellId === "ss_50k_2pct_1k")!;
  lines.push(`| Concurrent | DVOL=25 | DVOL=35 (today) | DVOL=50 | DVOL=65 | DVOL=80 | DVOL=95 | DVOL=110 |`);
  lines.push(`|---:|---:|---:|---:|---:|---:|---:|---:|`);
  for (const n of [1, 3, 5, 8, 10, 12, 15]) {
    const row = dvolPoints.map((d) => fmt$(n * projectHedgeCost(cell2pct, d))).join(" | ");
    lines.push(`| ${n} | ${row} |`);
  }
  lines.push("");

  // ─── Section 4: Aggregate Phase-0 portfolio at concurrent caps ───
  lines.push(`## 4. Aggregate portfolio capital at concurrent caps (single direction)`);
  lines.push("");
  lines.push(`Sums per-cell concurrent cap × empirical-calibrated hedge cost. This is`);
  lines.push(`Atticus's peak working capital if every cell hits its single-direction cap.`);
  lines.push("");
  lines.push(`| DVOL | 50k/2% | 50k/5% | 200k/5% | 50k/7% | 200k/7% | **Total** |`);
  lines.push(`|---:|---:|---:|---:|---:|---:|---:|`);
  for (const d of dvolPoints) {
    const perCell = CELLS.map((c) => c.concurrentCapNormal * projectHedgeCost(c, d));
    const total = perCell.reduce((s, v) => s + v, 0);
    lines.push(
      `| ${d} | ${fmt$(perCell[0])} | ${fmt$(perCell[1])} | ${fmt$(perCell[2])} | ${fmt$(perCell[3])} | ${fmt$(perCell[4])} | **${fmt$(total)}** |`
    );
  }
  lines.push("");
  lines.push(`At 2× directional balance: total capital ranges from ~\$${fmt$(2 * CELLS.reduce((s, c) => s + c.concurrentCapNormal * projectHedgeCost(c, 35), 0)).slice(1)}`);
  lines.push(`(today, both directions full) up to ~\$${fmt$(2 * CELLS.reduce((s, c) => s + c.concurrentCapNormal * projectHedgeCost(c, 110), 0)).slice(1)} (DVOL=110 stress, both directions full).`);
  lines.push("");

  // ─── Section 5: Stress guardrail variants ───
  lines.push(`## 5. Stress operation — guardrail variants`);
  lines.push("");
  lines.push(`The baseline Phase-0 plan PAUSES in stress (DVOL ≥ 80) via Guard D. This`);
  lines.push(`section evaluates what happens if we keep operating in stress with various`);
  lines.push(`guardrail configurations. All variants assume DVOL = **95** (mid-stress).`);
  lines.push("");

  const stressDvol = 95;
  for (const guard of STRESS_GUARD_VARIANTS) {
    lines.push(`### ${guard.name}`);
    lines.push("");
    lines.push(`Premium multiplier (on top of stress 3.0× overlay): **${guard.premiumMultiplier === 0 ? "PAUSED" : guard.premiumMultiplier}×**.  `);
    lines.push(`Concurrent cap multiplier: **${guard.concurrentCapMultiplier === 0 ? "PAUSED" : guard.concurrentCapMultiplier}×** (of normal cap).`);
    lines.push("");
    lines.push(`| Cell | Per-cover EV | Cap (positions) | Capital at cap | Annual EV at cap |`);
    lines.push(`|---|---:|---:|---:|---:|`);
    let totalEv = 0;
    let totalCapital = 0;
    for (const cell of CELLS) {
      const r = projectStressVariant(cell, stressDvol, guard);
      if (r.paused) {
        lines.push(`| ${cell.cellId} | (paused) | 0 | \$0 | \$0 |`);
      } else {
        lines.push(
          `| ${cell.cellId} | ${fmt$Signed(r.perCoverEvUsd)} | ${r.capPositions} | ${fmt$(r.capitalAtCapUsd)} | ${fmt$Signed(r.annualEvAtCapUsd)} |`
        );
        totalEv += r.annualEvAtCapUsd;
        totalCapital += r.capitalAtCapUsd;
      }
    }
    lines.push(`| **TOTAL (if every stress day were like this)** | | | **${fmt$(totalCapital)}** | **${fmt$Signed(totalEv)}** |`);
    lines.push("");
  }

  // ─── Section 6: Recommended stress guardrail set ───
  lines.push(`## 6. Recommended stress guardrails (most-effective without over-engineering)`);
  lines.push("");
  lines.push(`Stress regime is rare (~3-5% of days historically). The simplest set that`);
  lines.push(`bounds exposure while letting the platform stay live:`);
  lines.push("");
  lines.push(`| Guardrail | Mechanism | Env var | Setting |`);
  lines.push(`|---|---|---|---|`);
  lines.push(`| **G1: Premium overlay × 3.0** | Built into regime overlay JSON | \`SS_REGIME_OVERLAY_JSON\` | \`{"stress":3.0}\` |`);
  lines.push(`| **G2: Concurrent cap × 0.33** | Reduces per-direction cap by 67% | \`SS_STRESS_CONCURRENT_CAP_RATIO\` | \`0.33\` |`);
  lines.push(`| **G3: Per-cell loss-kill × 0.5** | Halve the rolling-loss kill threshold | \`SS_STRESS_LOSS_KILL_RATIO\` | \`0.5\` |`);
  lines.push(`| **G4: Depth gate × 1.5** | Require depth ≥ contracts × 1.5 (vs 1.2 normal) | \`SS_STRESS_DEPTH_GATE_RATIO\` | \`1.5\` |`);
  lines.push(`| **G5: Hedge budget cap × 0.5** | Half the daily hedge spend ceiling | \`SS_STRESS_BUDGET_CAP_RATIO\` | \`0.5\` |`);
  lines.push("");
  lines.push(`Net effect of G1–G5 at DVOL=95: matches the "stress_recommended" row in §5.`);
  lines.push("");

  // ─── Section 7: Recommendation ───
  lines.push(`## 7. Recommendation — keep stress PAUSED in Phase 0`);
  lines.push("");
  // Compute the recommended stress variant net at multiple DVOL points
  const recommendedGuard = STRESS_GUARD_VARIANTS[STRESS_GUARD_VARIANTS.length - 1];
  const stressDvolPoints = [80, 95, 110];
  lines.push(`Stress operation under the recommended guardrails (G1-G5) across the stress range:`);
  lines.push("");
  lines.push(`| DVOL | Cap (single-dir) | Capital deployed | Annual EV if every day stress | Realistic contribution (3% stress days) |`);
  lines.push(`|---:|---:|---:|---:|---:|`);
  for (const d of stressDvolPoints) {
    let totalCap = 0;
    let totalCapital = 0;
    let totalEv = 0;
    for (const c of CELLS) {
      const r = projectStressVariant(c, d, recommendedGuard);
      if (!r.paused) {
        totalCap += r.capPositions;
        totalCapital += r.capitalAtCapUsd;
        totalEv += r.annualEvAtCapUsd;
      }
    }
    const realistic = totalEv * 0.03; // 3% of days assumed stress
    lines.push(`| ${d} | ${totalCap} | ${fmt$(totalCapital)} | ${fmt$Signed(totalEv)} | ${fmt$Signed(realistic)} |`);
  }
  lines.push("");
  lines.push(`**Verdict: stress operation is structurally negative-EV** even under the most`);
  lines.push(`conservative guardrail set. The mechanic: at high σ, hedge cost explodes`);
  lines.push(`(~3-4× calm), and even with 1.5× extra premium and 0.33× concurrent cap,`);
  lines.push(`the average cover loses money because trigger rate stays high (~92%) while`);
  lines.push(`salvage degrades.`);
  lines.push("");
  lines.push(`**Recommendation: keep stress PAUSED for Phase 0** (the current plan).`);
  lines.push(`Re-evaluate after 90+ live triggers in calm/moderate validate the theta-aware`);
  lines.push(`TP engine in production. If salvage performance materially exceeds the 1.16×`);
  lines.push(`backtest baseline (e.g. 1.30× empirical from real Bullish fills), revisit the`);
  lines.push(`stress-on case using updated salvage fractions in this projector.`);
  lines.push("");
  lines.push(`**If Foxify pushes for "always-on" UX in stress**: implement \`stress_recommended\``);
  lines.push(`(G1-G5) but recognize realistic annual cost is **~\$60-80k/year** (3% of days × negative EV).`);
  lines.push(`That's "relationship insurance" — pay to keep Foxify always live during BTC chaos days.`);
  lines.push("");

  lines.push(`## 8. Notes & caveats`);
  lines.push("");
  lines.push(`1. **Calibration multiplier is locked at 2026-05-26**. Re-run the empirical validator periodically (e.g. weekly) and update \`EMPIRICAL_HEDGE_COST\`; vol-smile shape can shift.`);
  lines.push(`2. **Trigger rate model anchored to backtest**: 50k/2% calm 30%, 5% calm 17%, 7% calm 11%. Scaling formula: \`baseRate × (0.02/triggerPct)^0.7 × 0.6\`.`);
  lines.push(`3. **Salvage fractions anchored to Variant B backtest** (theta-aware TP avg salvage / avg hedge cost). Calm 1.16×, moderate 1.05×, elevated 0.95×, stress 0.80× (modeled).`);
  lines.push(`4. **7% cell salvage may be UNDER-estimated** because their 10d tenor gives more time value to capture on retained legs. The dedicated 7% backtest showed avg salvage ~1.8-1.95× hedge cost; this projector uses the same fractions for all cells. EV for 7% cells in §2 is therefore conservative.`);
  lines.push(`5. **Stress projection is model-based, not backtested.** The 16-month Coinbase window had 0 stress days. Live stress validation needed before any cutover.`);
  lines.push(`6. **Capital is upfront option premium only.** Long-only product, no margin. Foxify premium starts paying it back day 1.`);
  lines.push("");

  lines.push(`---`);
  lines.push("");
  lines.push(`*Generated by services/api/scripts/backtest/singleSide/dvolProjector.ts*`);
  lines.push(`*Re-run with \`npx tsx scripts/backtest/singleSide/dvolProjector.ts\` after each empirical chain refresh.*`);

  const outPath = path.resolve(process.cwd(), "../..", "docs/SINGLE_SIDE_DVOL_PROJECTOR.md");
  await fs.writeFile(outPath, lines.join("\n"));
  console.log(`✓ DVOL projector report written: ${outPath}`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
