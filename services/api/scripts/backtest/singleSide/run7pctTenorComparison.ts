/**
 * 7% cell tenor backtest — does the 10d-tenor reality (forced by
 * Bullish/Deribit liquidity calendar) make the 7% cells viable in
 * Phase 0, or do they need to wait?
 *
 * What this measures:
 *   - Variant B (theta-aware TP), fixed pricing, base premium
 *   - Tenor: 6d (original cell design) vs 10d (empirical reality)
 *   - Initial hedge cost: BS-modeled (6d) vs empirical Bullish ask (10d)
 *
 * Empirical inputs (from SINGLE_SIDE_EMPIRICAL_VALIDATION.md, 2026-05-26):
 *   - 50k/7%: Bullish 10d avg ask = $465/BTC × 2.30 BTC = $1,069 / cover
 *   - 200k/7%: Bullish 10d avg ask = $465/BTC × 9.20 BTC = $4,278 / cover
 *
 * Caveat: salvage-side BS at the same σ may slightly over-estimate
 * non-trigger close-out value (vol smile), but understates winner-side
 * intrinsic capture (mostly intrinsic-driven). Net bias is conservative
 * relative to live performance.
 *
 * Output: docs/SINGLE_SIDE_7PCT_TENOR_BACKTEST.md
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  loadHistoricalData,
  runScenario,
  type Cell,
  type Regime,
  type Scenario,
  type ScenarioStats
} from "./coreEngine";

// 7% cells under test
const CELLS_7PCT: Cell[] = [
  { cellId: "ss_50k_7pct_3_5k", notionalUsdc:  50_000, triggerPct: 0.07, payoutUsdc:  3_500, hedgePct: 0.05, hedgeTenorDays: 6, baseDailyPremiumUsdc:   310 },
  { cellId: "ss_200k_7pct_14k", notionalUsdc: 200_000, triggerPct: 0.07, payoutUsdc: 14_000, hedgePct: 0.05, hedgeTenorDays: 6, baseDailyPremiumUsdc: 1_250 }
];

// Empirical 10d-tenor hedge cost (from 2026-05-26 validation)
const EMPIRICAL_10D_COST_USD: Record<string, number> = {
  ss_50k_7pct_3_5k: 1069,
  ss_200k_7pct_14k: 4278
};

const fmt$ = (n: number) => {
  const s = n >= 0 ? "+" : "";
  return `${s}\$${Math.round(n).toLocaleString()}`;
};
const fmtPct = (n: number, dec = 0) => `${(n * 100).toFixed(dec)}%`;

const buildVariant = (
  cell: Cell,
  variant: "6d_design" | "10d_empirical"
): Scenario => {
  const base: Scenario = {
    name: `${cell.cellId}_${variant}`,
    cell,
    triggerRateMultiplier: 2.0,
    holdModel: { kind: "premium_ratio", targetRatio: 0.30 },
    ivAwarePricing: true,
    retainedTp: true,
    tpCurve: "thetaAware",
    pricingModel: "fixed"
  };
  if (variant === "10d_empirical") {
    base.hedgeTenorOverride = 10;
    base.hedgeCostOverride = EMPIRICAL_10D_COST_USD[cell.cellId];
  }
  return base;
};

type CellMatrix = {
  cell: Cell;
  d6: { total: ScenarioStats; perRegime: Record<Regime, ScenarioStats> };
  d10: { total: ScenarioStats; perRegime: Record<Regime, ScenarioStats> };
};

const main = async () => {
  console.log("# 7% cell tenor comparison — running...\n");
  const data = await loadHistoricalData();
  console.log(`Loaded ${data.candles.length} BTC daily candles\n`);

  const results: CellMatrix[] = [];
  for (const cell of CELLS_7PCT) {
    process.stdout.write(`  ${cell.cellId}: `);
    const r6 = await runScenario({
      candles: data.candles,
      vols: data.vols,
      regimes: data.regimes,
      scenario: buildVariant(cell, "6d_design")
    });
    const r10 = await runScenario({
      candles: data.candles,
      vols: data.vols,
      regimes: data.regimes,
      scenario: buildVariant(cell, "10d_empirical")
    });
    results.push({ cell, d6: { total: r6.total, perRegime: r6.perRegime }, d10: { total: r10.total, perRegime: r10.perRegime } });
    process.stdout.write(`6d=${r6.total.avgNetAtticus.toFixed(0)} 10d=${r10.total.avgNetAtticus.toFixed(0)}\n`);
  }

  // ─── Build report ───

  const lines: string[] = [];
  lines.push(`# 7% Cell Tenor Comparison — 6d Design vs 10d Empirical Reality`);
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Data:** ${data.candles.length} BTC daily OHLC (Coinbase)`);
  lines.push("");
  lines.push(`> Settles whether 7% cells should be Phase 0 or Phase 1.`);
  lines.push(`> The empirical Bullish chain (\`SINGLE_SIDE_EMPIRICAL_VALIDATION.md\`)`);
  lines.push(`> showed only 10d (5 Jun) expiry available beyond the near-term 3d (29 May)`);
  lines.push(`> on Sun 25 May. The 6d-tenor cell design is therefore not currently`);
  lines.push(`> achievable; we'd hedge with 10d. This compares:`);
  lines.push(`> - **6d design** (Variant B baseline, BS-modeled hedge cost)`);
  lines.push(`> - **10d empirical** (Variant B with hedgeTenorOverride=10 and`);
  lines.push(`>   hedgeCostOverride = empirical Bullish 10d ask × contracts)`);
  lines.push(`> All other inputs identical: triggerRateMultiplier=2.0, holdModel=premium_ratio(0.30),`);
  lines.push(`> theta-aware TP, fixed pricing, regime overlay.`);
  lines.push("");

  lines.push(`## Empirical inputs`);
  lines.push("");
  lines.push(`| Cell | Per-cover hedge cost (10d empirical Bullish ask × contracts) |`);
  lines.push(`|---|---:|`);
  for (const cell of CELLS_7PCT) {
    lines.push(`| ${cell.cellId} | **\$${EMPIRICAL_10D_COST_USD[cell.cellId].toLocaleString()}** |`);
  }
  lines.push("");

  lines.push(`## Headline comparison`);
  lines.push("");
  lines.push(`| Cell | 6d design Atticus EV | **10d empirical Atticus EV** | Δ | 6d %profit | 10d %profit |`);
  lines.push(`|---|---:|---:|---:|---:|---:|`);
  for (const r of results) {
    const delta = r.d10.total.avgNetAtticus - r.d6.total.avgNetAtticus;
    lines.push(
      `| ${r.cell.cellId} | ${fmt$(r.d6.total.avgNetAtticus)} | **${fmt$(r.d10.total.avgNetAtticus)}** | ${fmt$(delta)} | ${fmtPct(r.d6.total.pctProfitable)} | ${fmtPct(r.d10.total.pctProfitable)} |`
    );
  }
  lines.push("");

  lines.push(`## Per-regime decomposition (10d empirical)`);
  lines.push("");
  for (const r of results) {
    lines.push(`### ${r.cell.cellId}`);
    lines.push("");
    lines.push(`| Regime | Count | Trigger rate | Avg EV | Median | Worst | Best | %Profit |`);
    lines.push(`|---|---:|---:|---:|---:|---:|---:|---:|`);
    for (const reg of ["calm", "moderate", "elevated"] as Regime[]) {
      const s = r.d10.perRegime[reg];
      if (s.count === 0) continue;
      lines.push(
        `| ${reg} | ${s.count} | ${fmtPct(s.triggerRate)} | ${fmt$(s.avgNetAtticus)} | ${fmt$(s.medianNetAtticus)} | ${fmt$(s.worstNetAtticus)} | ${fmt$(s.bestNetAtticus)} | ${fmtPct(s.pctProfitable)} |`
      );
    }
    lines.push("");
  }

  lines.push(`## Tail risk comparison`);
  lines.push("");
  lines.push(`| Cell | 6d worst | **10d worst** | 6d best | **10d best** | 6d salvage avg | 10d salvage avg |`);
  lines.push(`|---|---:|---:|---:|---:|---:|---:|`);
  for (const r of results) {
    lines.push(
      `| ${r.cell.cellId} | ${fmt$(r.d6.total.worstNetAtticus)} | **${fmt$(r.d10.total.worstNetAtticus)}** | ${fmt$(r.d6.total.bestNetAtticus)} | **${fmt$(r.d10.total.bestNetAtticus)}** | ${fmt$(r.d6.total.avgRetainedSalvage)} | ${fmt$(r.d10.total.avgRetainedSalvage)} |`
    );
  }
  lines.push("");

  lines.push(`## Annualized projections at 25/day target`);
  lines.push("");
  lines.push(`| Cell | 6d annual | **10d annual** | Δ |`);
  lines.push(`|---|---:|---:|---:|`);
  for (const r of results) {
    const ann6 = r.d6.total.avgNetAtticus * 25 * 365;
    const ann10 = r.d10.total.avgNetAtticus * 25 * 365;
    lines.push(`| ${r.cell.cellId} | ${fmt$(ann6)} | **${fmt$(ann10)}** | ${fmt$(ann10 - ann6)} |`);
  }
  lines.push("");

  // ─── Verdict ───

  lines.push(`## Verdict — Phase 0 vs Phase 1?`);
  lines.push("");
  for (const r of results) {
    const ev10 = r.d10.total.avgNetAtticus;
    const tail10 = r.d10.total.worstNetAtticus;
    const profitable = ev10 > 0;
    const tailManageable = tail10 > -2_500; // single-cover loss <$2.5k acceptable
    const verdict =
      profitable && tailManageable ? "✅ SHIP IN PHASE 0"
      : profitable && !tailManageable ? "⚠️ SHIP WITH TIGHTER GUARDS (tail risk material)"
      : !profitable ? "❌ DEFER TO PHASE 1 (negative EV at 10d tenor)"
      : "⚠️ REVIEW";
    lines.push(`### ${r.cell.cellId}`);
    lines.push("");
    lines.push(`- **10d empirical EV/cover:** ${fmt$(ev10)}`);
    lines.push(`- **10d empirical worst single cover:** ${fmt$(tail10)}`);
    lines.push(`- **10d empirical %profitable:** ${fmtPct(r.d10.total.pctProfitable)}`);
    lines.push(`- **Verdict:** ${verdict}`);
    lines.push("");
  }

  lines.push(`## Caveats`);
  lines.push("");
  lines.push(`1. **Salvage uses BS at calm-σ (35.2%) regardless of empirical override.** Real Bullish/Deribit asks for 7% strikes show vol smile (puts richer than calls). Salvage on retained calls may slightly over-estimate; on retained puts may slightly under-estimate. Net bias is conservative for the calls-only side.`);
  lines.push(`2. **Tenor is fixed at 10d for the 10d_empirical variant.** Real Bullish weekly cycle means the available tenor floats by activation day-of-week (Mon AM = ~5d to next Friday, Fri PM = ~7d to following Friday). Phase 0 implementation should snap to whichever expiry is closest to 5–10d window.`);
  lines.push(`3. **Backtest data = 16 months Coinbase daily.** No stress days in window (0 stress regime). Stress-regime numbers are illustrative only.`);
  lines.push(`4. **Empirical hedge cost = 2026-05-26 snapshot.** Markets move; re-run validator before any live cutover.`);
  lines.push("");

  lines.push(`---`);
  lines.push("");
  lines.push(`*Generated by services/api/scripts/backtest/singleSide/run7pctTenorComparison.ts*`);

  const outPath = path.resolve(process.cwd(), "../..", "docs/SINGLE_SIDE_7PCT_TENOR_BACKTEST.md");
  await fs.writeFile(outPath, lines.join("\n"));
  console.log(`\n✓ 7% tenor comparison report written: ${outPath}`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
