/**
 * Scorecard writer — formats one or more ScenarioScorecards as a Markdown
 * report suitable for Gate 1 operator review.
 */

import type { ScenarioScorecard, BacktestRegime } from "./types";
import { ATTICUS_HEDGE_CAP_USD } from "./types";

const fmtUsd = (n: number, decimals = 0): string => {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString("en-US", {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals
  })}`;
};

const fmtPct = (n: number, decimals = 1): string =>
  `${(n * 100).toFixed(decimals)}%`;

export const writeMarkdownReport = (scorecards: ScenarioScorecard[]): string => {
  const lines: string[] = [];

  lines.push("# WS#9 Backtest Harness — Bundle C Scenario Comparison");
  lines.push("");
  lines.push(`> **Generated:** ${new Date().toISOString()}`);
  lines.push(`> **Scope:** ${scorecards[0]?.totalDays ?? 0}-day pilot window, 2 × $50k positions/day baseline.`);
  lines.push(`> **Atticus capital cap:** ${fmtUsd(ATTICUS_HEDGE_CAP_USD)}.`);
  lines.push(">");
  lines.push("> **Methodology:** expected-value math over historical 1,558-day BTC distribution.");
  lines.push("> Per-tier trigger rates and BS hedge costs sourced from");
  lines.push("> `docs/pilot-reports/backtest_1day_tiered_results.txt`.");
  lines.push("> Bullish hedge cost markup +15% vs Deribit baseline (per 2026-05-13 live snapshot).");
  lines.push("> TP recovery rate 68% (R1 baseline).");
  lines.push("");
  lines.push("---");
  lines.push("");

  // ── Summary comparison table ──
  lines.push("## Headline comparison");
  lines.push("");
  lines.push("| Scenario | 28-day P&L | Daily avg | Worst regime | Cap utilization | Bot defense |");
  lines.push("|---|---|---|---|---|---|");
  for (const s of scorecards) {
    const isProfitable = s.pilotPnLProjected > 0;
    const marker = isProfitable ? "✅" : "❌";
    lines.push(
      `| ${marker} **${s.scenarioName}** | ${fmtUsd(s.pilotPnLProjected, 0)} | ${fmtUsd(s.pilotPnLPerDay, 0)} | ${fmtUsd(s.worstSingleRegimeLossUsd, 0)} | ${s.capUtilizationPct.toFixed(1)}% | ${s.botBlockedByDefense ? "ENFORCE" : "OFF"} |`
    );
  }
  lines.push("");

  // Best scenario
  const best = [...scorecards].sort((a, b) => b.pilotPnLProjected - a.pilotPnLProjected)[0];
  if (best) {
    lines.push(`**Best projected scenario: ${best.scenarioName}** (${fmtUsd(best.pilotPnLProjected)} over 28 days).`);
    lines.push("");
  }

  // ── Per-scenario detail ──
  for (const s of scorecards) {
    lines.push(`---`);
    lines.push("");
    lines.push(`## Scenario: ${s.scenarioName}`);
    lines.push("");
    lines.push(`> ${s.description}`);
    lines.push("");

    lines.push(`**Volume:**`);
    lines.push(`- Total protections opened: ${s.totalProtectionsOpened.toFixed(0)}`);
    lines.push(`- Total notional: ${fmtUsd(s.totalNotionalUsd)}`);
    lines.push(`- Total triggers fired: ${s.totalTriggersFired.toFixed(1)} (${fmtPct(s.triggerRateBlended)} of opens)`);
    lines.push("");

    lines.push(`**Day distribution:**`);
    lines.push(`- Calm: ${s.daysByRegime.calm} days | Normal: ${s.daysByRegime.normal} days | Stress: ${s.daysByRegime.stress} days`);
    lines.push("");

    lines.push(`**Economics:**`);
    lines.push(`| Component | USD |`);
    lines.push(`|---|---|`);
    lines.push(`| Premium income | ${fmtUsd(s.totalPremiumIncomeUsd)} |`);
    lines.push(`| Hedge cost | ${fmtUsd(-s.totalHedgeCostUsd)} |`);
    lines.push(`| Expected payouts | ${fmtUsd(-s.totalPayoutOutUsd)} |`);
    lines.push(`| TP recovery | ${fmtUsd(s.totalTpRecoveryUsd)} |`);
    lines.push(`| Bot extraction (no defense) | ${fmtUsd(-s.botExpectedPnLUsd)} |`);
    lines.push(`| **Net pilot P&L** | **${fmtUsd(s.pilotPnLProjected)}** |`);
    lines.push(`| Daily P&L average | ${fmtUsd(s.pilotPnLPerDay)} |`);
    lines.push("");

    lines.push(`**Per-regime breakdown (P&L):**`);
    lines.push(`| Regime | Days | Trades | Premium | Hedge | Payouts | Recovery | Net P&L |`);
    lines.push(`|---|---|---|---|---|---|---|---|`);
    for (const r of ["calm", "normal", "stress"] as const) {
      const m = s.perRegimeTotals[r];
      lines.push(
        `| ${r} | ${s.daysByRegime[r]} | ${m.trades.toFixed(0)} | ${fmtUsd(m.totalPremium)} | ${fmtUsd(-m.totalHedgeCost)} | ${fmtUsd(-m.totalExpectedPayout)} | ${fmtUsd(m.totalTpRecovery)} | **${fmtUsd(m.netPnL)}** |`
      );
    }
    lines.push("");

    lines.push(`**Per-tier breakdown (P&L):**`);
    lines.push(`| Tier | Trades | Premium | Hedge | Payouts | Recovery | Net P&L | Per-trade avg |`);
    lines.push(`|---|---|---|---|---|---|---|---|`);
    for (const tier of Object.keys(s.perTierTotals).map(Number).sort((a, b) => a - b)) {
      const m = (s.perTierTotals as any)[tier];
      const perTradeAvg = m.trades > 0 ? m.netPnL / m.trades : 0;
      lines.push(
        `| ${tier}% | ${m.trades.toFixed(0)} | ${fmtUsd(m.totalPremium)} | ${fmtUsd(-m.totalHedgeCost)} | ${fmtUsd(-m.totalExpectedPayout)} | ${fmtUsd(m.totalTpRecovery)} | **${fmtUsd(m.netPnL)}** | ${fmtUsd(perTradeAvg, 2)} |`
      );
    }
    lines.push("");

    lines.push(`**Risk:**`);
    lines.push(`- Worst single-regime loss: ${fmtUsd(s.worstSingleRegimeLossUsd)}`);
    lines.push(`- Cap utilization: ${s.capUtilizationPct.toFixed(1)}% of $${ATTICUS_HEDGE_CAP_USD.toLocaleString()}`);
    if (s.capUtilizationPct > 100) {
      lines.push(`- ⚠️ **CAP EXCEEDED** — gross hedge spend would exceed Atticus pool by ${(s.capUtilizationPct - 100).toFixed(1)}%`);
    } else if (s.capUtilizationPct > 75) {
      lines.push(`- ⚠️ **HIGH CAP UTILIZATION** — leaves only ${(100 - s.capUtilizationPct).toFixed(1)}% headroom`);
    }
    lines.push("");
  }

  // ── Gate 1 decision support ──
  lines.push("---");
  lines.push("");
  lines.push("## Gate 1 decision support");
  lines.push("");

  const profitable = scorecards.filter((s) => s.pilotPnLProjected > 0);
  const loss = scorecards.filter((s) => s.pilotPnLProjected <= 0);
  const capExceeded = scorecards.filter((s) => s.capUtilizationPct > 100);

  lines.push(`- **Profitable scenarios:** ${profitable.length}/${scorecards.length} (${profitable.map((s) => s.scenarioName).join(", ") || "none"})`);
  lines.push(`- **Loss scenarios:** ${loss.length}/${scorecards.length} (${loss.map((s) => s.scenarioName).join(", ") || "none"})`);
  lines.push(`- **Cap-exceeding scenarios:** ${capExceeded.length}/${scorecards.length} (${capExceeded.map((s) => s.scenarioName).join(", ") || "none"})`);
  lines.push("");

  if (best) {
    lines.push(`**Recommendation:** Choose **${best.scenarioName}** for Gate 1 sign-off.`);
    lines.push("");
    lines.push(`Reasoning: produces highest projected pilot P&L (${fmtUsd(best.pilotPnLProjected)}) ` +
               `with ${best.capUtilizationPct.toFixed(1)}% cap utilization. ` +
               `Worst-regime loss bounded at ${fmtUsd(best.worstSingleRegimeLossUsd)}.`);
    lines.push("");
  }

  lines.push("**Operator action:** Approve a pricing scenario, then proceed to Day 6 of execution. " +
             "If you want to revisit any assumption (tier mix, Bullish parity drag, TP recovery rate), " +
             "edit the corresponding scenario config and re-run the harness.");
  lines.push("");

  return lines.join("\n");
};
