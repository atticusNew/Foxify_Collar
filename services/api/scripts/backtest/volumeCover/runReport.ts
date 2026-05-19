/**
 * P2 — Volume Cover backtest harness scenario runner.
 *
 * Runs all 6 cells × 4 regime tier price points and emits the
 * 24_BACKTEST_HARNESS_REVISED_REPORT.md document.
 *
 * Per-cell tiers:
 *   - Calm (locked at matrix base)
 *   - Moderate at +20%, +30%, +40% over base
 *   - Elevated at +50%, +75%, +100% over base
 *   - Stress at +100%, +150%, pause
 *
 * Calm-base "what should it be" analysis: also runs a parallel pass
 * at +20% / +40% / +60% calm uplift to give operator the head-start
 * lever for first platform-stop hot-fix.
 *
 * Output:
 *   docs/foxify-pilot-bundle-c/24_BACKTEST_HARNESS_REVISED_REPORT.md
 *
 * Usage:
 *   npx tsx services/api/scripts/backtest/volumeCover/runReport.ts
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

// ────── Cell matrix (locked base prices per operator confirmation 2026-05-16) ──────

const CELLS: Cell[] = [
  { cellId: "50k_2pct_1k",     notionalUsdc: 50_000,  triggerPct: 0.02, payoutUsdc: 1_000,  hedgePct: 0.01, dailyPremiumUsdc: 350 },
  { cellId: "50k_5pct_2_5k",   notionalUsdc: 50_000,  triggerPct: 0.05, payoutUsdc: 2_500,  hedgePct: 0.03, dailyPremiumUsdc: 200 },
  { cellId: "50k_10pct_5k",    notionalUsdc: 50_000,  triggerPct: 0.10, payoutUsdc: 5_000,  hedgePct: 0.05, dailyPremiumUsdc: 100 },
  { cellId: "200k_5pct_10k",   notionalUsdc: 200_000, triggerPct: 0.05, payoutUsdc: 10_000, hedgePct: 0.03, dailyPremiumUsdc: 800 },
  { cellId: "200k_10pct_20k",  notionalUsdc: 200_000, triggerPct: 0.10, payoutUsdc: 20_000, hedgePct: 0.05, dailyPremiumUsdc: 400 },
  { cellId: "200k_15pct_30k",  notionalUsdc: 200_000, triggerPct: 0.15, payoutUsdc: 30_000, hedgePct: 0.07, dailyPremiumUsdc: 370 }
];

const REGIMES: Regime[] = ["calm", "moderate", "elevated", "stress"];

const fmt$ = (n: number, w = 7) => {
  const s = n >= 0 ? "+" : "";
  return `${s}\$${n.toFixed(0).padStart(w)}`;
};
const fmtPct = (n: number, w = 5) => `${(n * 100).toFixed(0).padStart(w)}%`;

const main = async () => {
  console.log("# Volume Cover P2 Backtest — running...\n");
  const data = await loadHistoricalData();
  console.log(`Loaded ${data.candles.length} BTC daily candles`);

  // Distribution of regimes in the data
  const regimeCounts: Record<Regime, number> = { calm: 0, moderate: 0, elevated: 0, stress: 0 };
  for (const r of Object.values(data.regimes)) regimeCounts[r]++;
  const total = Object.values(regimeCounts).reduce((s, c) => s + c, 0);

  const lines: string[] = [];
  lines.push(`# Volume Cover Backtest — P2 Revised Harness Report`);
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Data:** ${data.candles.length} BTC daily OHLC candles (${data.candles[0].date} → ${data.candles[data.candles.length-1].date}), Coinbase`);
  lines.push(`**Regime distribution:** ${REGIMES.map((r) => `${(regimeCounts[r] / total * 100).toFixed(0)}% ${r}`).join(" / ")}`);
  lines.push("");
  lines.push(`## Methodology — production-faithful (P1a-P1g)`);
  lines.push("");
  lines.push("- **Hedge tenor:** 14-day matched (P1a) — single hedge per cover, no rollover");
  lines.push("- **Sizing:** payout / intrinsic_at_trigger × vol-buffer (P1c) — 1.00× calm / 1.05× moderate / 1.10× elevated / 1.15× stress");
  lines.push("- **Strikes:** snapped toward spot, inside trigger band; Bullish \$200 grid (2%/5% cells) + Deribit \$1000 grid (10%/15% cells)");
  lines.push("- **Premium accrual:** proportional — `dailyPremium × actualDaysHeld` (P1d)");
  lines.push("- **Atticus retention:** post-trigger AND post-Foxify-close legs retained (P1b)");
  lines.push("- **TP rules (stub):** rule 1 (4h-to-expiry forced exit), rule 7 (loser <20% or 4h grace), rule 12 (10% hard floor), W1 (winner 24h timecap)");
  lines.push("- **Ladder netting:** 60% of closes followed by 30-min reopen; matched legs repurposed (≈40% hedge-cost savings on match)");
  lines.push("- **Hold model:** exponential mean 3 days, capped at 14");
  lines.push("");
  lines.push(`## Locked launch prices (operator commitment 2026-05-16)`);
  lines.push("");
  lines.push(`| Cell | Notional | Trigger | Payout | **Calm \$/day (LOCKED)** |`);
  lines.push(`|---|---|---|---|---|`);
  for (const c of CELLS) {
    lines.push(`| ${c.cellId} | \$${c.notionalUsdc.toLocaleString()} | ±${(c.triggerPct * 100).toFixed(0)}% | \$${c.payoutUsdc.toLocaleString()} | **\$${c.dailyPremiumUsdc}** |`);
  }
  lines.push("");

  // ────── Per-cell scenario sweep ──────

  type CellRegimeAnalysis = {
    cell: Cell;
    base: { perRegime: Record<Regime, ScenarioStats> };
    moderateUplifts: Array<{ pct: number; price: number; stats: ScenarioStats }>;
    elevatedUplifts: Array<{ pct: number; price: number; stats: ScenarioStats }>;
    stressUplifts: Array<{ pct: number; price: number; stats: ScenarioStats }>;
    calmUplifts: Array<{ pct: number; price: number; stats: ScenarioStats }>;
  };

  const cellAnalyses: CellRegimeAnalysis[] = [];

  for (const cell of CELLS) {
    console.log(`\n[${cell.cellId}] running scenarios...`);

    // Base scenario (calm price across all regimes)
    const baseResult = await runScenario({
      candles: data.candles,
      vols: data.vols,
      regimes: data.regimes,
      scenario: { name: `${cell.cellId}_base`, cell }
    });

    const moderateUplifts: Array<{ pct: number; price: number; stats: ScenarioStats }> = [];
    for (const upliftPct of [0.20, 0.30, 0.40]) {
      const price = Math.round(cell.dailyPremiumUsdc * (1 + upliftPct));
      const result = await runScenario({
        candles: data.candles,
        vols: data.vols,
        regimes: data.regimes,
        scenario: {
          name: `${cell.cellId}_mod+${upliftPct}`,
          cell,
          regimePremium: { moderate: price }
        }
      });
      moderateUplifts.push({ pct: upliftPct, price, stats: result.perRegime.moderate });
    }

    const elevatedUplifts: Array<{ pct: number; price: number; stats: ScenarioStats }> = [];
    for (const upliftPct of [0.50, 0.75, 1.00]) {
      const price = Math.round(cell.dailyPremiumUsdc * (1 + upliftPct));
      const result = await runScenario({
        candles: data.candles,
        vols: data.vols,
        regimes: data.regimes,
        scenario: {
          name: `${cell.cellId}_elev+${upliftPct}`,
          cell,
          regimePremium: { elevated: price }
        }
      });
      elevatedUplifts.push({ pct: upliftPct, price, stats: result.perRegime.elevated });
    }

    const stressUplifts: Array<{ pct: number; price: number; stats: ScenarioStats }> = [];
    for (const upliftPct of [1.00, 1.50, 2.00]) {
      const price = Math.round(cell.dailyPremiumUsdc * (1 + upliftPct));
      const result = await runScenario({
        candles: data.candles,
        vols: data.vols,
        regimes: data.regimes,
        scenario: {
          name: `${cell.cellId}_stress+${upliftPct}`,
          cell,
          regimePremium: { stress: price }
        }
      });
      stressUplifts.push({ pct: upliftPct, price, stats: result.perRegime.stress });
    }

    // Calm uplifts (head-start lever) — what calm SHOULD be
    const calmUplifts: Array<{ pct: number; price: number; stats: ScenarioStats }> = [];
    for (const upliftPct of [0.20, 0.40, 0.60]) {
      const price = Math.round(cell.dailyPremiumUsdc * (1 + upliftPct));
      const result = await runScenario({
        candles: data.candles,
        vols: data.vols,
        regimes: data.regimes,
        scenario: {
          name: `${cell.cellId}_calm+${upliftPct}`,
          cell,
          regimePremium: { calm: price }
        }
      });
      calmUplifts.push({ pct: upliftPct, price, stats: result.perRegime.calm });
    }

    cellAnalyses.push({
      cell,
      base: { perRegime: baseResult.perRegime },
      moderateUplifts,
      elevatedUplifts,
      stressUplifts,
      calmUplifts
    });
  }

  // ────── Render report ──────

  lines.push(`## Per-cell EV at base price (current matrix, all regimes)`);
  lines.push("");
  lines.push(`Reading: per-cover Atticus net P&L. Negative ⇒ losing money at base price.`);
  lines.push("");
  lines.push(`| Cell | Calm $${"".padStart(0)} | Moderate | Elevated | Stress | Calm Avg | Mod Avg | Elev Avg | Stress Avg | %Profit calm | Trig calm |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const a of cellAnalyses) {
    const r = a.base.perRegime;
    lines.push(
      `| ${a.cell.cellId} | \$${a.cell.dailyPremiumUsdc} | \$${a.cell.dailyPremiumUsdc} | \$${a.cell.dailyPremiumUsdc} | \$${a.cell.dailyPremiumUsdc} | ${fmt$(r.calm.avg)} | ${fmt$(r.moderate.avg)} | ${fmt$(r.elevated.avg)} | ${fmt$(r.stress.avg)} | ${fmtPct(r.calm.pctProfitable)} | ${fmtPct(r.calm.triggerRate)} |`
    );
  }
  lines.push("");

  // ────── Recommended regime overlays ──────

  lines.push(`## Recommended regime overlay tiers (per cell)`);
  lines.push("");
  lines.push(`Selection rule: smallest uplift that lands the per-regime avg P&L >= +\$50 (light buffer over breakeven).`);
  lines.push("");

  type Recommendation = {
    cellId: string;
    moderate: { price: number | null; avgPnL: number | null };
    elevated: { price: number | null; avgPnL: number | null };
    stress: { price: number | null; avgPnL: number | null; pause: boolean };
    calmHeadStart: { price: number | null; avgPnL: number | null };
  };

  const pickFirstAboveBreakeven = (
    uplifts: Array<{ pct: number; price: number; stats: ScenarioStats }>,
    threshold = 50
  ): { price: number | null; avgPnL: number | null } => {
    const winner = uplifts.find((u) => u.stats.avg >= threshold);
    if (winner) return { price: winner.price, avgPnL: winner.stats.avg };
    // Best of available if none break breakeven
    const best = uplifts.slice().sort((a, b) => b.stats.avg - a.stats.avg)[0];
    return best ? { price: best.price, avgPnL: best.stats.avg } : { price: null, avgPnL: null };
  };

  const recs: Recommendation[] = cellAnalyses.map((a) => {
    const mod = pickFirstAboveBreakeven(a.moderateUplifts);
    const elev = pickFirstAboveBreakeven(a.elevatedUplifts);
    const str = pickFirstAboveBreakeven(a.stressUplifts);
    const calmHs = pickFirstAboveBreakeven(a.calmUplifts);
    const stressPause = (str.avgPnL ?? -1e9) < 0;
    return {
      cellId: a.cell.cellId,
      moderate: mod,
      elevated: elev,
      stress: { ...str, pause: stressPause },
      calmHeadStart: calmHs
    };
  });

  lines.push(`| Cell | Calm (LOCKED) | Moderate | Elevated | Stress | Calm head-start (hot-fix) |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (let i = 0; i < cellAnalyses.length; i++) {
    const a = cellAnalyses[i];
    const r = recs[i];
    const stressCell = r.stress.pause
      ? `**PAUSE** (best uplift \$${r.stress.price ?? "?"} avg ${fmt$(r.stress.avgPnL ?? 0)})`
      : `\$${r.stress.price} (avg ${fmt$(r.stress.avgPnL ?? 0)})`;
    lines.push(
      `| ${a.cell.cellId} | \$${a.cell.dailyPremiumUsdc} | \$${r.moderate.price ?? "?"} (avg ${fmt$(r.moderate.avgPnL ?? 0)}) | \$${r.elevated.price ?? "?"} (avg ${fmt$(r.elevated.avgPnL ?? 0)}) | ${stressCell} | \$${r.calmHeadStart.price ?? "?"} (avg ${fmt$(r.calmHeadStart.avgPnL ?? 0)}) |`
    );
  }
  lines.push("");
  lines.push(`*Calm head-start price is the lever for first platform-stop hot-fix per operator's ask 2026-05-16.*`);
  lines.push("");

  // ────── Per-cell detailed sweeps ──────

  lines.push(`## Detailed uplift sweeps`);
  lines.push("");
  for (const a of cellAnalyses) {
    lines.push(`### ${a.cell.cellId}`);
    lines.push("");
    lines.push(`Base \$${a.cell.dailyPremiumUsdc}/day. Calm distribution (regime samples, BS-priced retained TP).`);
    lines.push("");
    lines.push(`**Moderate uplift sweep (P&L per cover, moderate regime only):**`);
    lines.push("");
    lines.push(`| Uplift | Price/day | Avg | Median | Worst | Best | %Profit | Trigger rate |`);
    lines.push(`|---|---|---|---|---|---|---|---|`);
    for (const u of a.moderateUplifts) {
      const s = u.stats;
      lines.push(
        `| +${(u.pct * 100).toFixed(0)}% | \$${u.price} | ${fmt$(s.avg)} | ${fmt$(s.median)} | ${fmt$(s.worst)} | ${fmt$(s.best)} | ${fmtPct(s.pctProfitable)} | ${fmtPct(s.triggerRate)} |`
      );
    }
    lines.push("");
    lines.push(`**Elevated uplift sweep (P&L per cover, elevated regime only):**`);
    lines.push("");
    lines.push(`| Uplift | Price/day | Avg | Median | Worst | Best | %Profit | Trigger rate |`);
    lines.push(`|---|---|---|---|---|---|---|---|`);
    for (const u of a.elevatedUplifts) {
      const s = u.stats;
      lines.push(
        `| +${(u.pct * 100).toFixed(0)}% | \$${u.price} | ${fmt$(s.avg)} | ${fmt$(s.median)} | ${fmt$(s.worst)} | ${fmt$(s.best)} | ${fmtPct(s.pctProfitable)} | ${fmtPct(s.triggerRate)} |`
      );
    }
    lines.push("");
    if (a.stressUplifts.some((u) => u.stats.count > 0)) {
      lines.push(`**Stress uplift sweep (P&L per cover, stress regime only):**`);
      lines.push("");
      lines.push(`| Uplift | Price/day | Avg | Median | Worst | Best | %Profit | Trigger rate |`);
      lines.push(`|---|---|---|---|---|---|---|---|`);
      for (const u of a.stressUplifts) {
        const s = u.stats;
        lines.push(
          `| +${(u.pct * 100).toFixed(0)}% | \$${u.price} | ${fmt$(s.avg)} | ${fmt$(s.median)} | ${fmt$(s.worst)} | ${fmt$(s.best)} | ${fmtPct(s.pctProfitable)} | ${fmtPct(s.triggerRate)} |`
        );
      }
    } else {
      lines.push(`*No stress regime samples in 487-day window (BTC didn't cross 90% annualized vol).*`);
    }
    lines.push("");
    lines.push(`**Calm head-start sweep — what calm SHOULD be (operator hot-fix lever):**`);
    lines.push("");
    lines.push(`| Uplift | Price/day | Avg | Median | Worst | %Profit | Trigger rate |`);
    lines.push(`|---|---|---|---|---|---|---|`);
    for (const u of a.calmUplifts) {
      const s = u.stats;
      lines.push(
        `| +${(u.pct * 100).toFixed(0)}% | \$${u.price} | ${fmt$(s.avg)} | ${fmt$(s.median)} | ${fmt$(s.worst)} | ${fmtPct(s.pctProfitable)} | ${fmtPct(s.triggerRate)} |`
      );
    }
    lines.push("");
  }

  // ────── Honest read for operator ──────

  const calmOK = cellAnalyses.filter((a) => a.base.perRegime.calm.avg > 0).map((a) => a.cell.cellId);
  const calmLosing = cellAnalyses.filter((a) => a.base.perRegime.calm.avg <= 0).map((a) => a.cell.cellId);

  lines.push(`## Honest read`);
  lines.push("");
  lines.push(`At LOCKED calm-base prices (no overlays applied):`);
  lines.push("");
  if (calmOK.length > 0) {
    lines.push(`- **Profitable in calm:** ${calmOK.join(", ")}`);
  }
  if (calmLosing.length > 0) {
    lines.push(`- **Losing in calm:** ${calmLosing.join(", ")} — calm head-start lever above shows the price needed to flip these positive`);
  }
  lines.push("");
  lines.push(`Phase 1 retention + ladder netting + production-faithful sizing materially change economics vs the deprecated harnesses #21/#22 which:`);
  lines.push(`- Used immediate-sell-at-trigger-spot (no retained TP capture)`);
  lines.push(`- Sized hedge at 1× notional instead of payout/intrinsic`);
  lines.push(`- Did not model ladder netting savings`);
  lines.push("");
  lines.push(`The operator's calm head-start prices (above) are the lever to keep ready for the first platform-stop event so the hot-fix is data-driven, not reactive.`);
  lines.push("");
  lines.push(`## Next steps`);
  lines.push("");
  lines.push(`1. Operator + CEO review recommended overlay prices (moderate/elevated/stress).`);
  lines.push(`2. Approved overlays deployed via env at Hour 48-72.`);
  lines.push(`3. Calm head-start values stay armed for first platform-stop hot-fix.`);
  lines.push(`4. Re-run this harness post-launch with real Day-1 trade data; compare to projection.`);
  lines.push("");
  lines.push(`---`);
  lines.push(`*Generated by services/api/scripts/backtest/volumeCover/runReport.ts*`);

  const outPath = path.resolve(
    process.cwd(),
    "docs/foxify-pilot-bundle-c/24_BACKTEST_HARNESS_REVISED_REPORT.md"
  );
  await fs.writeFile(outPath, lines.join("\n"));
  console.log(`\n✓ Report written: ${outPath}`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
