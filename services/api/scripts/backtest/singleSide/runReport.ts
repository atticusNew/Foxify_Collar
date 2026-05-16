/**
 * Single-Side Phase 2 backtest — sweep proposed pricing across cells,
 * regimes, hold models, and trigger rate assumptions.
 *
 * Output: docs/foxify-pilot-bundle-c/27_SINGLE_SIDE_RELAUNCH_REPORT.md
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { loadHistoricalData, runScenario, type Cell, type Regime, type Scenario, type ScenarioStats } from "./coreEngine";

const CELLS: Cell[] = [
  { cellId: "ss_50k_2pct_1k",   notionalUsdc: 50_000,  triggerPct: 0.02, payoutUsdc: 1_000,  hedgePct: 0.01, hedgeTenorDays: 3, baseDailyPremiumUsdc: 310 },
  { cellId: "ss_50k_5pct_2_5k", notionalUsdc: 50_000,  triggerPct: 0.05, payoutUsdc: 2_500,  hedgePct: 0.03, hedgeTenorDays: 3, baseDailyPremiumUsdc: 140 },
  { cellId: "ss_50k_7pct_3_5k", notionalUsdc: 50_000,  triggerPct: 0.07, payoutUsdc: 3_500,  hedgePct: 0.05, hedgeTenorDays: 6, baseDailyPremiumUsdc: 310 },
  { cellId: "ss_200k_5pct_10k", notionalUsdc: 200_000, triggerPct: 0.05, payoutUsdc: 10_000, hedgePct: 0.03, hedgeTenorDays: 3, baseDailyPremiumUsdc: 600 },
  { cellId: "ss_200k_7pct_14k", notionalUsdc: 200_000, triggerPct: 0.07, payoutUsdc: 14_000, hedgePct: 0.05, hedgeTenorDays: 6, baseDailyPremiumUsdc: 1_250 }
];

const fmt$ = (n: number, w = 7) => {
  const s = n >= 0 ? "+" : "";
  return `${s}\$${n.toFixed(0).padStart(w)}`;
};
const fmtPct = (n: number, w = 5) => `${(n * 100).toFixed(0).padStart(w)}%`;

const main = async () => {
  console.log("# Single-Side Phase 2 Backtest — running...\n");
  const data = await loadHistoricalData();
  console.log(`Loaded ${data.candles.length} BTC daily candles`);

  const regimeCounts: Record<Regime, number> = { calm: 0, moderate: 0, elevated: 0, stress: 0 };
  for (const r of Object.values(data.regimes)) regimeCounts[r]++;
  const total = Object.values(regimeCounts).reduce((s, c) => s + c, 0);

  const lines: string[] = [];
  lines.push(`# Single-Side Pilot Relaunch — Backtest Report`);
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Data:** ${data.candles.length} BTC daily OHLC candles (${data.candles[0].date} → ${data.candles[data.candles.length-1].date}), Coinbase`);
  lines.push(`**Regime distribution:** ${(["calm", "moderate", "elevated", "stress"] as Regime[]).map((r) => `${(regimeCounts[r] / total * 100).toFixed(0)}% ${r}`).join(" / ")}`);
  lines.push("");
  lines.push(`## Methodology`);
  lines.push("");
  lines.push("- **Single-side (single-leg) hedge:** put for long cover, call for short cover (50/50 random)");
  lines.push("- **Cell-conditional tenor:** 3-day for 5% trigger cells, 6-day for 7% trigger cells (Bullish liquidity)");
  lines.push("- **Vol-buffered sizing:** 1.0× calm / 1.05× moderate / 1.10× elevated / 1.15× stress");
  lines.push("- **IV-aware pricing:** base × (current_iv / 33%)^0.7 (continuous adjustment)");
  lines.push("- **Regime overlay:** ×1.0 / ×1.4 / ×2.0 / pause for calm/moderate/elevated/stress");
  lines.push("- **Bullish bid-ask uplift:** 5-12% above mid (calibrated from live Bullish data 2026-05-16)");
  lines.push("- **Retained-TP simulation:** post-exit 12-rule curve (rules 1, 5, 7, 12, W1)");
  lines.push("- **Selection-bias trigger multiplier:** 2.0× statistical baseline (Foxify entry-timing)");
  lines.push("- **Hold model:** premium-ratio (Foxify holds until premium accrued ≈ 30% of payout)");
  lines.push("");
  lines.push(`## Cell base prices (calm regime, anchored to live Bullish)`);
  lines.push("");
  lines.push(`| Cell | Notional | Trigger | Payout | **Calm \$/day** | Tenor |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const c of CELLS) {
    lines.push(`| ${c.cellId} | \$${c.notionalUsdc.toLocaleString()} | ±${(c.triggerPct * 100).toFixed(0)}% | \$${c.payoutUsdc.toLocaleString()} | **\$${c.baseDailyPremiumUsdc}** | ${c.hedgeTenorDays}d |`);
  }
  lines.push("");

  // ────── Per-cell scenario sweep ──────

  const cellResults: Array<{ cell: Cell; perRegime: Record<Regime, ScenarioStats>; total: ScenarioStats; uplifts: Array<{ pct: number; price: number; total: ScenarioStats }> }> = [];

  for (const cell of CELLS) {
    console.log(`\n[${cell.cellId}] running base scenario + uplift sweep...`);

    // Base scenario: matrix price, full IV-aware + regime overlay, premium_ratio hold
    const base = await runScenario({
      candles: data.candles,
      vols: data.vols,
      regimes: data.regimes,
      scenario: {
        name: `${cell.cellId}_base`,
        cell,
        triggerRateMultiplier: 2.0,
        holdModel: { kind: "premium_ratio", targetRatio: 0.30 },
        ivAwarePricing: true,
        retainedTp: true
      }
    });

    // Uplift sweep: -25%, -10%, 0, +10%, +25%, +50% over base price
    const uplifts: Array<{ pct: number; price: number; total: ScenarioStats }> = [];
    for (const upliftPct of [-0.25, -0.10, 0.0, 0.10, 0.25, 0.50]) {
      const price = Math.max(50, Math.round(cell.baseDailyPremiumUsdc * (1 + upliftPct)));
      const result = await runScenario({
        candles: data.candles,
        vols: data.vols,
        regimes: data.regimes,
        scenario: {
          name: `${cell.cellId}_uplift_${upliftPct}`,
          cell,
          basePremiumOverride: price,
          triggerRateMultiplier: 2.0,
          holdModel: { kind: "premium_ratio", targetRatio: 0.30 },
          ivAwarePricing: true,
          retainedTp: true
        }
      });
      uplifts.push({ pct: upliftPct, price, total: result.total });
    }

    cellResults.push({ cell, perRegime: base.perRegime, total: base.total, uplifts });
  }

  // ────── Render report ──────

  lines.push(`## Per-cell EV at base price (real Bullish, 2.0× trigger bias, premium_ratio hold)`);
  lines.push("");
  lines.push(`| Cell | Total covers | Avg P&L | Calm avg | Mod avg | Elev avg | Stress | %Profit | Trigger rate |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|`);
  for (const c of cellResults) {
    const r = c.perRegime;
    lines.push(
      `| ${c.cell.cellId} | ${c.total.count} | ${fmt$(c.total.avgNetAtticus)} | ${fmt$(r.calm.avgNetAtticus)} | ${fmt$(r.moderate.avgNetAtticus)} | ${fmt$(r.elevated.avgNetAtticus)} | paused | ${fmtPct(c.total.pctProfitable)} | ${fmtPct(c.total.triggerRate)} |`
    );
  }
  lines.push("");

  lines.push(`## Uplift sensitivity (overall avg P&L vs base price)`);
  lines.push("");
  lines.push(`| Cell | -25% | -10% | base | +10% | +25% | +50% |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  for (const c of cellResults) {
    const cells = c.uplifts.map((u) => fmt$(u.total.avgNetAtticus, 6)).join(" | ");
    lines.push(`| ${c.cell.cellId} | ${cells} |`);
  }
  lines.push("");

  // ────── Cell deep-dive ──────

  lines.push(`## Detailed per-cell sweep`);
  lines.push("");

  for (const c of cellResults) {
    lines.push(`### ${c.cell.cellId} (\$${c.cell.baseDailyPremiumUsdc}/day base, ${c.cell.hedgeTenorDays}d tenor)`);
    lines.push("");
    lines.push(`**Per-regime detail at base price:**`);
    lines.push("");
    lines.push(`| Regime | Cnt | Triggered | Avg P&L | Median | Worst | Best | %Profit |`);
    lines.push(`|---|---|---|---|---|---|---|---|`);
    for (const reg of ["calm", "moderate", "elevated"] as Regime[]) {
      const s = c.perRegime[reg];
      if (s.count === 0) continue;
      lines.push(
        `| ${reg} | ${s.count} | ${s.triggeredCount} (${fmtPct(s.triggerRate)}) | ${fmt$(s.avgNetAtticus)} | ${fmt$(s.medianNetAtticus)} | ${fmt$(s.worstNetAtticus)} | ${fmt$(s.bestNetAtticus)} | ${fmtPct(s.pctProfitable)} |`
      );
    }
    lines.push("");
    lines.push(`**Price sensitivity sweep (overall avg P&L per cover):**`);
    lines.push("");
    lines.push(`| Uplift | Price/day | Avg P&L | Median | Worst | Best | %Profit | Total P&L |`);
    lines.push(`|---|---|---|---|---|---|---|---|`);
    for (const u of c.uplifts) {
      lines.push(
        `| ${u.pct >= 0 ? "+" : ""}${(u.pct * 100).toFixed(0)}% | \$${u.price} | ${fmt$(u.total.avgNetAtticus)} | ${fmt$(u.total.medianNetAtticus)} | ${fmt$(u.total.worstNetAtticus)} | ${fmt$(u.total.bestNetAtticus)} | ${fmtPct(u.total.pctProfitable)} | ${fmt$(u.total.totalPnL)} |`
      );
    }
    lines.push("");
  }

  // ────── Honest read + recommendations ──────

  const profitableCells = cellResults.filter((c) => c.total.avgNetAtticus > 0).map((c) => c.cell.cellId);
  const losingCells = cellResults.filter((c) => c.total.avgNetAtticus <= 0).map((c) => c.cell.cellId);

  lines.push(`## Honest read`);
  lines.push("");
  if (profitableCells.length > 0) {
    lines.push(`- **Profitable at base price:** ${profitableCells.join(", ")}`);
  }
  if (losingCells.length > 0) {
    lines.push(`- **Losing at base price:** ${losingCells.join(", ")} — see uplift sweep for breakeven price`);
  }
  lines.push("");
  lines.push(`Headlines:`);
  lines.push(`- 200k/5%/\$10k average P&L per cover at \$600/day base: ${fmt$(cellResults.find((c) => c.cell.cellId === "ss_200k_5pct_10k")?.total.avgNetAtticus ?? 0)}`);
  lines.push(`- 50k/2%/\$1k (legacy comparison) at \$310/day base: ${fmt$(cellResults.find((c) => c.cell.cellId === "ss_50k_2pct_1k")?.total.avgNetAtticus ?? 0)}`);
  lines.push("");
  lines.push(`## Sensitivity to assumptions`);
  lines.push("");
  lines.push(`Run with different selection-bias trigger multipliers + hold models to test robustness:`);
  lines.push("");

  // Re-run 200k/5% with different stress tests
  const stressCell = cellResults.find((c) => c.cell.cellId === "ss_200k_5pct_10k")!.cell;
  lines.push(`| Scenario | 200k/5% Avg P&L | Trigger rate |`);
  lines.push(`|---|---|---|`);

  for (const mult of [1.0, 2.0, 3.0]) {
    for (const holdModel of [
      { kind: "fixed" as const, days: 1 },
      { kind: "fixed" as const, days: 2 },
      { kind: "fixed" as const, days: 3 },
      { kind: "premium_ratio" as const, targetRatio: 0.30 }
    ]) {
      const r = await runScenario({
        candles: data.candles,
        vols: data.vols,
        regimes: data.regimes,
        scenario: {
          name: `stress_${mult}x_${JSON.stringify(holdModel)}`,
          cell: stressCell,
          triggerRateMultiplier: mult,
          holdModel,
          ivAwarePricing: true,
          retainedTp: true
        }
      });
      const label = holdModel.kind === "fixed" ? `${holdModel.days}d hold` : `P/Po=${holdModel.targetRatio}`;
      lines.push(`| ${mult.toFixed(1)}× bias, ${label} | ${fmt$(r.total.avgNetAtticus)} | ${fmtPct(r.total.triggerRate)} |`);
    }
  }
  lines.push("");

  lines.push(`---`);
  lines.push(`*Generated by services/api/scripts/backtest/singleSide/runReport.ts*`);
  lines.push(`*Pricing anchored to live Bullish data 2026-05-16 (BULLISH_LIVE_PRICING_REPORT.md).*`);

  const outPath = path.resolve(
    process.cwd(),
    "docs/foxify-pilot-bundle-c/27_SINGLE_SIDE_RELAUNCH_REPORT.md"
  );
  await fs.writeFile(outPath, lines.join("\n"));
  console.log(`\n✓ Report written: ${outPath}`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
