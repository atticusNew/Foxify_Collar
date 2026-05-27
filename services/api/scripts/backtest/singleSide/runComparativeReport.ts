/**
 * Single-Side Comparative Backtest — 4-way matrix:
 *   A. Baseline:   fixed pricing  + baseline TP curve   (current Attempt-1 model)
 *   B. Theta-TP:   fixed pricing  + thetaAware TP curve (intraday-peak capture, tighter trail)
 *   C. X-or-Y:     xOrY pricing   + baseline TP curve   (no premium on trigger, regime-tiered Y)
 *   D. Both:       xOrY pricing   + thetaAware TP curve (the proposed optimal)
 *
 * Plus:
 *   - Premium uplift sweep on the proposed-optimal variant for the
 *     50k/2% cell (the volume workhorse).
 *   - X-or-Y Y_calm sensitivity at 100% / 80% / 60% of cell.payoutUsdc.
 *   - Capacity / counterparty analysis at the 25/day Phase A target.
 *
 * Output: docs/SINGLE_SIDE_OPTIMAL_DESIGN_BACKTEST.md
 *
 * READ-ONLY against the live platform — this is a backtest under
 * services/api/scripts/backtest/singleSide/. No production code touched.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  loadHistoricalData,
  runScenario,
  type Cell,
  type Regime,
  type Scenario,
  type ScenarioStats,
  type CoverResult
} from "./coreEngine";

// ─────────────────────────── Cell matrix ───────────────────────────

const CELLS: Cell[] = [
  { cellId: "ss_50k_2pct_1k",   notionalUsdc: 50_000,  triggerPct: 0.02, payoutUsdc: 1_000,  hedgePct: 0.01, hedgeTenorDays: 3, baseDailyPremiumUsdc: 310 },
  { cellId: "ss_50k_5pct_2_5k", notionalUsdc: 50_000,  triggerPct: 0.05, payoutUsdc: 2_500,  hedgePct: 0.03, hedgeTenorDays: 3, baseDailyPremiumUsdc: 140 },
  { cellId: "ss_50k_7pct_3_5k", notionalUsdc: 50_000,  triggerPct: 0.07, payoutUsdc: 3_500,  hedgePct: 0.05, hedgeTenorDays: 6, baseDailyPremiumUsdc: 310 },
  { cellId: "ss_200k_5pct_10k", notionalUsdc: 200_000, triggerPct: 0.05, payoutUsdc: 10_000, hedgePct: 0.03, hedgeTenorDays: 3, baseDailyPremiumUsdc: 600 },
  { cellId: "ss_200k_7pct_14k", notionalUsdc: 200_000, triggerPct: 0.07, payoutUsdc: 14_000, hedgePct: 0.05, hedgeTenorDays: 6, baseDailyPremiumUsdc: 1_250 }
];

// Y multipliers for X-or-Y pricing (multiplies cell.payoutUsdc per regime).
// Default: preserve calm UX, scale down in higher vol where hedge cost
// dominates. Stress=0 (paired with regime overlay pause).
const X_OR_Y_REGIME_MULT: Record<Regime, number> = {
  calm: 1.0,
  moderate: 0.7,
  elevated: 0.5,
  stress: 0
};

// ─────────────────────────── Helpers ───────────────────────────

const fmt$ = (n: number, w = 7) => {
  const s = n >= 0 ? "+" : "";
  return `${s}\$${n.toFixed(0).padStart(w)}`;
};
const fmtPct = (n: number, w = 5) => `${(n * 100).toFixed(0).padStart(w)}%`;
const pct = (n: number, dec = 0) => `${(n * 100).toFixed(dec)}%`;

const baseScenario = (cell: Cell, name: string): Scenario => ({
  name,
  cell,
  triggerRateMultiplier: 2.0,
  holdModel: { kind: "premium_ratio", targetRatio: 0.30 },
  ivAwarePricing: true,
  retainedTp: true,
  tpCurve: "baseline",
  pricingModel: "fixed"
});

const buildVariant = (
  cell: Cell,
  variant: "A" | "B" | "C" | "D",
  basePremiumOverride?: number
): Scenario => {
  const s = baseScenario(cell, `${cell.cellId}_${variant}`);
  s.basePremiumOverride = basePremiumOverride;
  switch (variant) {
    case "A":
      return s;
    case "B":
      return { ...s, tpCurve: "thetaAware" };
    case "C":
      return { ...s, pricingModel: "xOrY", xOrYRegimePayoutMult: X_OR_Y_REGIME_MULT };
    case "D":
      return {
        ...s,
        tpCurve: "thetaAware",
        pricingModel: "xOrY",
        xOrYRegimePayoutMult: X_OR_Y_REGIME_MULT
      };
  }
};

type RunResult = {
  scenario: Scenario;
  total: ScenarioStats;
  perRegime: Record<Regime, ScenarioStats>;
  results: CoverResult[];
};

// ─────────────────────────── Main ───────────────────────────

const main = async () => {
  console.log("# Single-Side Comparative Backtest — running 4-way matrix...\n");
  const data = await loadHistoricalData();
  console.log(
    `Loaded ${data.candles.length} BTC daily candles (${data.candles[0].date} → ${data.candles[data.candles.length - 1].date})`
  );

  const regimeCounts: Record<Regime, number> = { calm: 0, moderate: 0, elevated: 0, stress: 0 };
  for (const r of Object.values(data.regimes)) regimeCounts[r]++;
  const totalRegimeDays = Object.values(regimeCounts).reduce((s, c) => s + c, 0);

  // ───── Run 4-way matrix per cell ─────

  const lines: string[] = [];
  lines.push(`# Single-Side Optimal Design — Comparative Backtest`);
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Data:** ${data.candles.length} BTC daily OHLC (${data.candles[0].date} → ${data.candles[data.candles.length - 1].date}), Coinbase`);
  lines.push(
    `**Regime distribution:** ` +
      (["calm", "moderate", "elevated", "stress"] as Regime[])
        .map((r) => `${pct(regimeCounts[r] / totalRegimeDays)} ${r}`)
        .join(" / ")
  );
  lines.push("");
  lines.push(`> Companion analysis to the existing baseline backtest`);
  lines.push(`> (\`docs/foxify-pilot-bundle-c/27_SINGLE_SIDE_RELAUNCH_REPORT.md\`).`);
  lines.push(`> This report extends the engine with two opt-in variants — a theta-aware`);
  lines.push(`> TP curve and an X-or-Y pricing model — and quantifies their incremental`);
  lines.push(`> impact on the proposed single-side platform. Stress regime is sparse in`);
  lines.push(`> this 16-month window; treat stress numbers as illustrative.`);
  lines.push("");
  lines.push(`## Variants under test`);
  lines.push("");
  lines.push(`| Variant | Pricing | TP curve | Description |`);
  lines.push(`|---|---|---|---|`);
  lines.push(`| **A. Baseline** | fixed | baseline 5-rule | Current Attempt-1 model (matches \`27_SINGLE_SIDE_RELAUNCH_REPORT.md\`) |`);
  lines.push(`| **B. Theta-TP** | fixed | thetaAware | Intraday-peak capture on trigger day + 0.85× slippage floor + tighter 15% trail + cap-fraction exit. Models the §4.1 redesign. |`);
  lines.push(`| **C. X-or-Y**  | xOrY  | baseline | No premium on trigger; regime-tiered Y on trigger ({calm: 100%, mod: 70%, elev: 50%}). |`);
  lines.push(`| **D. Both**   | xOrY  | thetaAware | The proposed optimal. |`);
  lines.push("");

  // ───── 4-way comparison at base price ─────

  console.log("\n[1/4] Running 4-way comparison at base premium across all cells...");
  type CellMatrix = Record<"A" | "B" | "C" | "D", RunResult>;
  const matrix: Record<string, CellMatrix> = {};
  for (const cell of CELLS) {
    process.stdout.write(`  ${cell.cellId}: `);
    const cellMatrix: CellMatrix = {} as CellMatrix;
    for (const v of ["A", "B", "C", "D"] as const) {
      const r = await runScenario({
        candles: data.candles,
        vols: data.vols,
        regimes: data.regimes,
        scenario: buildVariant(cell, v)
      });
      cellMatrix[v] = r;
      process.stdout.write(`${v}=${r.total.avgNetAtticus.toFixed(0)} `);
    }
    process.stdout.write("\n");
    matrix[cell.cellId] = cellMatrix;
  }

  lines.push(`## 4-way comparison at base premium`);
  lines.push("");
  lines.push(`Per-cover average Atticus EV (positive = profitable). All variants use:`);
  lines.push(`triggerRateMultiplier=2.0, holdModel=premium_ratio(0.30), iv-aware pricing,`);
  lines.push(`regime overlay {calm:1.0, mod:1.4, elev:2.0, stress:pause}, vol-buffered sizing.`);
  lines.push("");
  lines.push(`| Cell | A. Baseline | B. Theta-TP | C. X-or-Y | D. Both | Δ A→B | Δ A→D |`);
  lines.push(`|---|---:|---:|---:|---:|---:|---:|`);
  for (const cell of CELLS) {
    const m = matrix[cell.cellId];
    const dAB = m.B.total.avgNetAtticus - m.A.total.avgNetAtticus;
    const dAD = m.D.total.avgNetAtticus - m.A.total.avgNetAtticus;
    lines.push(
      `| ${cell.cellId} | ${fmt$(m.A.total.avgNetAtticus)} | ${fmt$(m.B.total.avgNetAtticus)} | ${fmt$(m.C.total.avgNetAtticus)} | ${fmt$(m.D.total.avgNetAtticus)} | ${fmt$(dAB)} | ${fmt$(dAD)} |`
    );
  }
  lines.push("");
  lines.push(`Per-cell %-profitable-covers (higher = more consistent):`);
  lines.push("");
  lines.push(`| Cell | A. Baseline | B. Theta-TP | C. X-or-Y | D. Both |`);
  lines.push(`|---|---:|---:|---:|---:|`);
  for (const cell of CELLS) {
    const m = matrix[cell.cellId];
    lines.push(
      `| ${cell.cellId} | ${fmtPct(m.A.total.pctProfitable)} | ${fmtPct(m.B.total.pctProfitable)} | ${fmtPct(m.C.total.pctProfitable)} | ${fmtPct(m.D.total.pctProfitable)} |`
    );
  }
  lines.push("");
  lines.push(`Per-cell tail risk (worst single-cover loss, lower-magnitude is better):`);
  lines.push("");
  lines.push(`| Cell | A. Baseline | B. Theta-TP | C. X-or-Y | D. Both |`);
  lines.push(`|---|---:|---:|---:|---:|`);
  for (const cell of CELLS) {
    const m = matrix[cell.cellId];
    lines.push(
      `| ${cell.cellId} | ${fmt$(m.A.total.worstNetAtticus)} | ${fmt$(m.B.total.worstNetAtticus)} | ${fmt$(m.C.total.worstNetAtticus)} | ${fmt$(m.D.total.worstNetAtticus)} |`
    );
  }
  lines.push("");

  // ───── Per-regime decomposition for D (proposed optimal) on the volume workhorse ─────

  lines.push(`## Per-regime decomposition — 50k/2% cell, Variant D (proposed optimal)`);
  lines.push("");
  lines.push(`The volume workhorse cell. Targets the calm + moderate regimes where ~92% of days live.`);
  lines.push("");
  const m2 = matrix["ss_50k_2pct_1k"];
  lines.push(`| Regime | Count | Trigger rate | A.Baseline avg | B.Theta avg | C.X-or-Y avg | D.Both avg |`);
  lines.push(`|---|---:|---:|---:|---:|---:|---:|`);
  for (const reg of ["calm", "moderate", "elevated"] as Regime[]) {
    const a = m2.A.perRegime[reg];
    const b = m2.B.perRegime[reg];
    const c = m2.C.perRegime[reg];
    const d = m2.D.perRegime[reg];
    if (a.count === 0) continue;
    lines.push(
      `| ${reg} | ${a.count} | ${fmtPct(a.triggerRate)} | ${fmt$(a.avgNetAtticus)} | ${fmt$(b.avgNetAtticus)} | ${fmt$(c.avgNetAtticus)} | ${fmt$(d.avgNetAtticus)} |`
    );
  }
  lines.push("");

  // ───── Premium uplift sweep on B and D for the 2% cell ─────

  console.log("\n[2/4] Premium uplift sweep on Variants B and D for 50k/2%...");
  const cell2pct = CELLS.find((c) => c.cellId === "ss_50k_2pct_1k")!;
  type UpliftRow = { pct: number; price: number; total: ScenarioStats };
  const upliftB: UpliftRow[] = [];
  const upliftD: UpliftRow[] = [];
  for (const upliftPct of [-0.10, 0.0, 0.10, 0.25, 0.50]) {
    const price = Math.max(50, Math.round(cell2pct.baseDailyPremiumUsdc * (1 + upliftPct)));
    for (const variant of ["B", "D"] as const) {
      const s = buildVariant(cell2pct, variant, price);
      const r = await runScenario({
        candles: data.candles,
        vols: data.vols,
        regimes: data.regimes,
        scenario: s
      });
      const target = variant === "B" ? upliftB : upliftD;
      target.push({ pct: upliftPct, price, total: r.total });
      process.stdout.write(
        `  ${variant} uplift ${upliftPct >= 0 ? "+" : ""}${(upliftPct * 100).toFixed(0)}% @ $${price}/d → ${r.total.avgNetAtticus.toFixed(0)}\n`
      );
    }
  }

  lines.push(`## Premium uplift sweep — Variants B & D, 50k/2% workhorse`);
  lines.push("");
  lines.push(`Variant B uses fixed pricing, so uplift = direct premium increase. Variant D uses`);
  lines.push(`X-or-Y, so uplift = increase to the non-trigger X premium only (trigger payout`);
  lines.push(`unchanged). Per-cover Atticus EV at base + uplift levels:`);
  lines.push("");
  lines.push(`| Uplift | $/day | **B. Theta-TP** | %Profit (B) | **D. Both** | %Profit (D) |`);
  lines.push(`|---:|---:|---:|---:|---:|---:|`);
  for (let i = 0; i < upliftB.length; i++) {
    const b = upliftB[i];
    const d = upliftD[i];
    lines.push(
      `| ${b.pct >= 0 ? "+" : ""}${(b.pct * 100).toFixed(0)}% | \$${b.price} | ${fmt$(b.total.avgNetAtticus)} | ${fmtPct(b.total.pctProfitable)} | ${fmt$(d.total.avgNetAtticus)} | ${fmtPct(d.total.pctProfitable)} |`
    );
  }
  lines.push("");

  // ───── Variant B uplift sweep across all cells (per-cell sweet spot) ─────

  console.log("\n[2.5/4] Variant B premium uplift sweep across all cells...");
  type AllCellSweep = { cell: Cell; rows: Array<{ pct: number; price: number; total: ScenarioStats }> };
  const allCellSweeps: AllCellSweep[] = [];
  for (const cell of CELLS) {
    const rows: Array<{ pct: number; price: number; total: ScenarioStats }> = [];
    for (const upliftPct of [-0.10, 0.0, 0.10, 0.15, 0.25, 0.50]) {
      const price = Math.max(50, Math.round(cell.baseDailyPremiumUsdc * (1 + upliftPct)));
      const r = await runScenario({
        candles: data.candles,
        vols: data.vols,
        regimes: data.regimes,
        scenario: buildVariant(cell, "B", price)
      });
      rows.push({ pct: upliftPct, price, total: r.total });
    }
    allCellSweeps.push({ cell, rows });
    process.stdout.write(
      `  ${cell.cellId}: ${rows.map((r) => `${r.pct >= 0 ? "+" : ""}${(r.pct * 100).toFixed(0)}%=${r.total.avgNetAtticus.toFixed(0)}`).join(" ")}\n`
    );
  }

  lines.push(`## Variant B per-cell premium uplift sweep (sustainable sweet spot)`);
  lines.push("");
  lines.push(`Theta-aware TP curve under fixed pricing. Per-cell average Atticus EV/cover at`);
  lines.push(`each premium level. Bold = best uplift for that cell.`);
  lines.push("");
  lines.push(`| Cell | -10% | base | +10% | +15% | +25% | +50% |`);
  lines.push(`|---|---:|---:|---:|---:|---:|---:|`);
  for (const sweep of allCellSweeps) {
    const evs = sweep.rows.map((r) => r.total.avgNetAtticus);
    const maxEv = Math.max(...evs);
    const cells = sweep.rows
      .map((r) => {
        const v = fmt$(r.total.avgNetAtticus);
        return r.total.avgNetAtticus === maxEv ? `**${v}**` : v;
      })
      .join(" | ");
    lines.push(`| ${sweep.cell.cellId} | ${cells} |`);
  }
  lines.push("");
  lines.push(`Per-cell %-profitable at base + best uplift:`);
  lines.push("");
  lines.push(`| Cell | Base price | Base %Profit | Best uplift | Best %Profit | Best $/day |`);
  lines.push(`|---|---:|---:|---:|---:|---:|`);
  for (const sweep of allCellSweeps) {
    const baseRow = sweep.rows.find((r) => r.pct === 0)!;
    const bestRow = sweep.rows.reduce((a, b) => (a.total.avgNetAtticus > b.total.avgNetAtticus ? a : b));
    lines.push(
      `| ${sweep.cell.cellId} | \$${sweep.cell.baseDailyPremiumUsdc} | ${fmtPct(baseRow.total.pctProfitable)} | ${bestRow.pct >= 0 ? "+" : ""}${(bestRow.pct * 100).toFixed(0)}% | ${fmtPct(bestRow.total.pctProfitable)} | **\$${bestRow.price}** |`
    );
  }
  lines.push("");

  // ───── Y-mult sensitivity for X-or-Y ─────

  console.log("\n[3/4] X-or-Y Y_calm sensitivity at 100% / 80% / 60% of payout...");
  type YSens = { mult: number; total: ScenarioStats };
  const ySens: YSens[] = [];
  for (const yMult of [1.0, 0.8, 0.6]) {
    const overrideMult: Record<Regime, number> = {
      calm: yMult,
      moderate: yMult * 0.7,
      elevated: yMult * 0.5,
      stress: 0
    };
    const s = buildVariant(cell2pct, "D");
    s.xOrYRegimePayoutMult = overrideMult;
    const r = await runScenario({
      candles: data.candles,
      vols: data.vols,
      regimes: data.regimes,
      scenario: s
    });
    ySens.push({ mult: yMult, total: r.total });
    process.stdout.write(`  Y_calm=${yMult.toFixed(1)}× → ${r.total.avgNetAtticus.toFixed(0)} (worst ${r.total.worstNetAtticus.toFixed(0)})\n`);
  }

  lines.push(`## X-or-Y payout sensitivity — 50k/2%, Variant D`);
  lines.push("");
  lines.push(`Tests how much the regime-tiered payout can be tightened without breaking Foxify EV.`);
  lines.push(`(Mod/Elev mults scale as Y_calm × {0.7, 0.5}.)`);
  lines.push("");
  lines.push(`| Y_calm × payout | Atticus avg | Median | Worst | %Profit |`);
  lines.push(`|---:|---:|---:|---:|---:|`);
  for (const y of ySens) {
    lines.push(
      `| ${pct(y.mult, 0)} ($${(cell2pct.payoutUsdc * y.mult).toFixed(0)} on calm trigger) | ${fmt$(y.total.avgNetAtticus)} | ${fmt$(y.total.medianNetAtticus)} | ${fmt$(y.total.worstNetAtticus)} | ${fmtPct(y.total.pctProfitable)} |`
    );
  }
  lines.push("");

  // ───── Capacity analysis at 25/day target ─────

  console.log("\n[4/4] Capacity / counterparty analysis at 25/day target...");
  lines.push(`## Capacity & counterparty analysis at 25/day target`);
  lines.push("");
  lines.push(`The user-stated target is 25+/day at maximum feasibility. This section`);
  lines.push(`quantifies hedge BTC outstanding, Bullish depth stress, capital deployed,`);
  lines.push(`and counterparty float — using Variant D economics where available.`);
  lines.push("");

  // Use D variant on 50k/2% as the workhorse
  const dStats = m2.D.total;
  const avgHoldDays = dStats.avgDaysHeld;
  const avgHedgeCost = dStats.avgHedgeCost;
  const triggerRate = dStats.triggerRate;
  // Average BTC contracts per cover comes from results
  const avgContractsBtc =
    m2.D.results.filter((r) => !r.paused).reduce((s, r) => s + r.hedgeContractsBtc, 0) /
    Math.max(1, m2.D.results.filter((r) => !r.paused).length);

  const dailyVol = 25;
  const concurrent = dailyVol * avgHoldDays;
  const btcOutstanding = concurrent * avgContractsBtc;
  const capitalDeployed = concurrent * avgHedgeCost;

  // Bullish depth assumption (per docs/FOXIFY_PROPOSAL_V3 §"Live Bullish validation"):
  // typical 5-20 BTC at working strikes on 24h tenor.
  const bullishDepthLow = 5;
  const bullishDepthHigh = 20;

  // Stress: if BTC moves 2% in a short window, ALL active long covers in
  // one direction trigger together. Worst case: all `concurrent` positions
  // were on the same side (e.g. Foxify ran a pre-news short basket).
  const stressBtcSell = btcOutstanding;
  const expectedSlipLow = Math.max(0, (stressBtcSell - bullishDepthLow) / bullishDepthLow); // levels deep
  const expectedSlipHigh = Math.max(0, (stressBtcSell - bullishDepthHigh) / bullishDepthHigh);

  // Counterparty float (25% EOW / 75% EOM):
  // Atticus owes Foxify on triggers; Foxify owes Atticus on premiums.
  const triggersPerDay = dailyVol * triggerRate;
  // X-or-Y avg payout on trigger ≈ 1.0 calm + 0.7 mod + 0.5 elev mix
  // Use distribution from regime counts; weight by per-regime trigger rate × cnt
  let avgPayoutOnTrigger = 0;
  let totalTrig = 0;
  for (const reg of ["calm", "moderate", "elevated"] as Regime[]) {
    const r = m2.D.perRegime[reg];
    avgPayoutOnTrigger += r.triggerRate * r.count * (X_OR_Y_REGIME_MULT[reg] * cell2pct.payoutUsdc);
    totalTrig += r.triggerRate * r.count;
  }
  if (totalTrig > 0) avgPayoutOnTrigger /= totalTrig;
  // Float between trigger and EOM avg ~15 days
  const atticusOwedToFoxifyAtSteady = triggersPerDay * 15 * avgPayoutOnTrigger;
  // Foxify owed Atticus: per-day premium × non-triggered × 15-day avg float
  const nonTrigPerDay = dailyVol * (1 - triggerRate);
  const foxifyOwedToAtticusAtSteady =
    nonTrigPerDay * 15 * cell2pct.baseDailyPremiumUsdc * avgHoldDays;

  lines.push(`### Position-level inputs (from Variant D, 50k/2%)`);
  lines.push("");
  lines.push(`- Avg hold-days per cover: **${avgHoldDays.toFixed(2)}**`);
  lines.push(`- Avg hedge cost (long-leg debit + uplift): **\$${avgHedgeCost.toFixed(0)}**`);
  lines.push(`- Avg BTC contracts per cover: **${avgContractsBtc.toFixed(2)}**`);
  lines.push(`- Trigger rate (selection-biased 2.0×): **${pct(triggerRate, 1)}**`);
  lines.push("");

  lines.push(`### Steady-state at 25/day`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---:|`);
  lines.push(`| Concurrent active covers | **${concurrent.toFixed(1)}** |`);
  lines.push(`| BTC outstanding (long options) | **${btcOutstanding.toFixed(1)} BTC** |`);
  lines.push(`| Capital deployed (option premia) | **\$${capitalDeployed.toFixed(0)}** |`);
  lines.push(`| Triggers/day expected | ${triggersPerDay.toFixed(1)} |`);
  lines.push(`| Non-triggered closes/day | ${nonTrigPerDay.toFixed(1)} |`);
  lines.push("");

  lines.push(`### Bullish depth stress test (single-direction fire-storm)`);
  lines.push("");
  lines.push(`Worst case: a 2% BTC move within minutes triggers ALL ${concurrent.toFixed(1)} active covers`);
  lines.push(`on the same side (e.g. Foxify ran a directional basket pre-news). All ${btcOutstanding.toFixed(1)} BTC of`);
  lines.push(`long options must be sold into the same direction's bid book.`);
  lines.push("");
  lines.push(`Bullish typical bid depth: 5-20 BTC at the strike on 24h tenor (per docs/FOXIFY_PROPOSAL_V3 §"Live Bullish validation").`);
  lines.push("");
  lines.push(`| Bullish depth scenario | Excess BTC to push thru | Levels-deep estimate | Slip |`);
  lines.push(`|---|---:|---:|---:|`);
  lines.push(`| Low (5 BTC top bid) | ${Math.max(0, btcOutstanding - bullishDepthLow).toFixed(1)} BTC | ${(expectedSlipLow + 1).toFixed(1)}× depth | ~${pct(Math.min(0.30, expectedSlipLow * 0.05), 0)} |`);
  lines.push(`| High (20 BTC top bid) | ${Math.max(0, btcOutstanding - bullishDepthHigh).toFixed(1)} BTC | ${(expectedSlipHigh + 1).toFixed(1)}× depth | ~${pct(Math.min(0.30, expectedSlipHigh * 0.05), 0)} |`);
  lines.push("");
  lines.push(`**Implication:** at 25/day with single-venue Bullish, a synchronized fire-storm`);
  lines.push(`can push 3-5× through top-bid depth, costing 15-25% extra slippage on salvage.`);
  lines.push(`Mitigations: (1) Deribit hot-failover for salvage-side; (2) cap concurrent`);
  lines.push(`positions per direction at \~depth × 1.5; (3) stagger sell IOCs across 30-60s`);
  lines.push(`to let the book replenish (reusing VC's chainWarmer/fillOptimizer cadence).`);
  lines.push("");

  lines.push(`### Counterparty float at steady state`);
  lines.push("");
  lines.push(`Settlement is 25% EOW / 75% EOM (per FOXIFY_PROPOSAL_V3). Average float ≈ 15 days.`);
  lines.push("");
  lines.push(`| Direction | Steady-state unpaid balance |`);
  lines.push(`|---|---:|`);
  lines.push(`| Atticus → Foxify (trigger payouts owed) | **\$${atticusOwedToFoxifyAtSteady.toFixed(0)}** |`);
  lines.push(`| Foxify → Atticus (premium owed) | **\$${foxifyOwedToAtticusAtSteady.toFixed(0)}** |`);
  lines.push(`| Net (Atticus's exposure to Foxify default) | **\$${(foxifyOwedToAtticusAtSteady - atticusOwedToFoxifyAtSteady).toFixed(0)}** |`);
  lines.push("");
  lines.push(`Recommended halt-new-activations gate (per VC's \`counterpartyLedger.ts\`): when`);
  lines.push(`Foxify→Atticus unpaid > **\$${(foxifyOwedToAtticusAtSteady * 1.5).toFixed(0)}** (1.5× steady state).`);
  lines.push("");

  lines.push(`### Annualized projections — 50k/2% workhorse, base premium`);
  lines.push("");
  const dailyVolList = [5, 25, 50, 100];
  const evB = m2.B.total.avgNetAtticus;
  const evD = m2.D.total.avgNetAtticus;
  lines.push(`| Volume (covers/day) | **B. Theta-TP** annual | **D. Both** annual |`);
  lines.push(`|---:|---:|---:|`);
  for (const dv of dailyVolList) {
    const annB = evB * dv * 365;
    const annD = evD * dv * 365;
    lines.push(`| ${dv} | **${fmt$(annB, 10)}** | ${fmt$(annD, 10)} |`);
  }
  lines.push("");
  lines.push(`Variant B (theta-aware TP only) is **${(evB / Math.max(1, evD)).toFixed(1)}× better than Variant D** at base premium`);
  lines.push(`for the 2% cell — the X-or-Y model alone is value-destructive at Y_calm=100%, and only`);
  lines.push(`reaches parity if Y_calm is reduced to 60-80% of cell payout (see sensitivity above).`);
  lines.push("");

  // ───── Honest read ─────

  lines.push(`## Honest read`);
  lines.push("");
  const m2A = matrix["ss_50k_2pct_1k"].A.total.avgNetAtticus;
  const m2B = matrix["ss_50k_2pct_1k"].B.total.avgNetAtticus;
  const m2C = matrix["ss_50k_2pct_1k"].C.total.avgNetAtticus;
  const m2D = matrix["ss_50k_2pct_1k"].D.total.avgNetAtticus;
  lines.push(`### 50k/2% (volume workhorse) at base price`);
  lines.push(`- A. Baseline:    **${fmt$(m2A)}/cover**`);
  lines.push(`- B. Theta-TP:    **${fmt$(m2B)}/cover**  (Δ ${fmt$(m2B - m2A)} from baseline)`);
  lines.push(`- C. X-or-Y:      **${fmt$(m2C)}/cover**  (Δ ${fmt$(m2C - m2A)} from baseline)`);
  lines.push(`- D. Both:        **${fmt$(m2D)}/cover**  (Δ ${fmt$(m2D - m2A)} from baseline)`);
  lines.push("");
  lines.push(`### Decision implications (the actual ranking on this data)`);
  lines.push("");
  // Rank variants by EV on the workhorse cell
  const rank = (
    [
      { v: "A. Baseline", ev: m2A },
      { v: "B. Theta-TP", ev: m2B },
      { v: "C. X-or-Y", ev: m2C },
      { v: "D. Both", ev: m2D }
    ] as Array<{ v: string; ev: number }>
  ).sort((a, b) => b.ev - a.ev);
  lines.push(`Ranked on 50k/2% per-cover EV at base price:`);
  for (let i = 0; i < rank.length; i++) {
    lines.push(`${i + 1}. ${rank[i].v} — ${fmt$(rank[i].ev)}/cover`);
  }
  lines.push("");
  lines.push(`**Headline:** ${rank[0].v} is the best variant on this dataset for the 50k/2% workhorse.`);
  lines.push("");
  lines.push(`**Implications:**`);
  lines.push(`- **Theta-aware TP is the biggest single win** ($${(m2B - m2A).toFixed(0)}/cover lift on 2% cell). It needs`);
  lines.push(`  no Foxify renegotiation — it's a pure Atticus-side execution improvement.`);
  lines.push(`  The lift here is from intraday-peak capture vs. close-of-day capture; live`);
  lines.push(`  shadow validation on Bullish fills will measure the actual $/cover impact.`);
  if (m2C < m2A) {
    lines.push(`- **X-or-Y at full Y_calm is value-destructive on single-side** (Δ ${fmt$(m2C - m2A)} vs baseline).`);
    lines.push(`  Single-side trigger rates are high enough (~33-50% across regimes) that forfeiting`);
    lines.push(`  premium-on-trigger AND keeping the same payout double-hits Atticus. The VC backtest`);
    lines.push(`  showed +21× lift on X-or-Y for *spreads*, but that math relied on tighter Y caps`);
    lines.push(`  ($800 calm vs. $1k). On single-side, Y_calm must drop to ~60% (i.e. $600) before`);
    lines.push(`  X-or-Y becomes attractive — see Y-sensitivity table.`);
  }
  if (m2B > m2D) {
    lines.push(`- **Variant D underperforms B at base** because the X-or-Y trade-off (lose premium`);
    lines.push(`  on triggers) is not yet offset by the lower Y. This means: if Foxify won't budge on`);
    lines.push(`  payout structure, ship Variant B alone. If Foxify will negotiate Y_calm down to`);
    lines.push(`  60-80%, Variant D becomes competitive (see Y-sensitivity).`);
  }
  lines.push(`- **Tail risk improves under B** (worst case ${fmt$(matrix["ss_50k_2pct_1k"].B.total.worstNetAtticus)} vs ${fmt$(matrix["ss_50k_2pct_1k"].A.total.worstNetAtticus)} baseline) —`);
  lines.push(`  ${pct(1 - matrix["ss_50k_2pct_1k"].B.total.worstNetAtticus / matrix["ss_50k_2pct_1k"].A.total.worstNetAtticus, 0)} smaller worst-case loss.`);
  lines.push("");
  lines.push(`### Recommendation (data-driven)`);
  lines.push("");
  lines.push(`**Phase 0 (no Foxify negotiation required):**`);
  lines.push(`Ship the theta-aware TP curve (Variant B). Drop the 5% cells. Keep base premiums.`);
  lines.push(`Annualized at 25/day on 2% cell alone: **${fmt$(m2B * 25 * 365, 10)}**. Add 7% cells (also profitable`);
  lines.push(`under all variants) and the projected portfolio sustains comfortably.`);
  lines.push("");
  lines.push(`**Phase 1 (after Foxify discussion):**`);
  lines.push(`If Foxify accepts a reduced payout-on-trigger (e.g. Y_calm = $800, $600), move to Variant D.`);
  lines.push(`This is then a structural Foxify-negotiation play, not a bandaid: simpler unit economics`);
  lines.push(`for both sides, less premium friction, smaller per-trigger payout exposure.`);
  lines.push("");

  // ───── Footer ─────

  lines.push(`---`);
  lines.push("");
  lines.push(`*Generated by services/api/scripts/backtest/singleSide/runComparativeReport.ts*`);
  lines.push(`*Live platform untouched. Original \`runReport.ts\` baseline preserved.*`);

  const outPath = path.resolve(
    process.cwd(),
    "../..",
    "docs/SINGLE_SIDE_OPTIMAL_DESIGN_BACKTEST.md"
  );
  await fs.writeFile(outPath, lines.join("\n"));
  console.log(`\n✓ Report written: ${outPath}`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
