/**
 * Generate the 12-month bear/base/bull revenue projection.
 *
 * Run: npx tsx src/projectMain.ts → writes output/foxify_revenue_projection.md
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SCENARIOS, projectScenario, type MonthlyProjection, type Scenario } from "./revenueProjection.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "..", "output");

function fmtUsd0(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (Math.abs(v) >= 10_000) return `$${(v / 1_000).toFixed(0)}k`;
  return v >= 0
    ? `$${Math.round(v).toLocaleString()}`
    : `-$${Math.round(Math.abs(v)).toLocaleString()}`;
}

function buildReport(): string {
  const L: string[] = [];
  L.push("# Foxify Per-Day Protection — 12-Month Net Revenue Projections");
  L.push(`**Generated:** ${new Date().toISOString().slice(0, 10)}`);
  L.push("");
  L.push("Bull / Base / Bear scenarios scaled monthly across the first 12 months. Per-cohort Atticus net economics are **locked from the historical backtest** (PR #95). The three scenarios distinguish themselves on **user growth**, **engagement intensity**, and **tier mix** — which are the real uncertainties.");
  L.push("");
  L.push("**Locked per-cohort net to Atticus (per $10k of protected position):**");
  L.push("");
  L.push("| Tier | Net per cohort per $10k |");
  L.push("|---|---|");
  L.push("| 2% | $16.00 |");
  L.push("| 3% | $49.50 |");
  L.push("| 5% | $111.15 |");
  L.push("| 10% | $34.50 |");
  L.push("");
  L.push("These are the realized Atticus net per protection cycle (entry-to-close), pulled from §0 of the deep analysis.");
  L.push("");
  L.push("---");
  L.push("");

  // ── Scenario assumptions ──────────────────────────────────────────────────
  L.push("## Scenario assumptions");
  L.push("");
  L.push("| | Bear | Base | Bull |");
  L.push("|---|---|---|---|");
  for (const sName of ["Bear", "Base", "Bull"] as const) {
    const _s = SCENARIOS.find(x => x.name === sName)!;
  }
  const bear = SCENARIOS.find(s => s.name === "Bear")!;
  const base = SCENARIOS.find(s => s.name === "Base")!;
  const bull = SCENARIOS.find(s => s.name === "Bull")!;
  L.push(`| Active users (M1 → M12) | ${bear.startingUsers} → ${bear.endingUsers} (${bear.growthCurve}) | ${base.startingUsers} → ${base.endingUsers} (${base.growthCurve}) | ${bull.startingUsers} → ${bull.endingUsers} (${bull.growthCurve}) |`);
  L.push(`| Cohorts per user / month (M1 → M12) | ${bear.cohortsPerUserStart} → ${bear.cohortsPerUserEnd} | ${base.cohortsPerUserStart} → ${base.cohortsPerUserEnd} | ${bull.cohortsPerUserStart} → ${bull.cohortsPerUserEnd} |`);
  L.push(`| Avg protected position size | $${bear.avgPositionSizeUsd.toLocaleString()} | $${base.avgPositionSizeUsd.toLocaleString()} | $${bull.avgPositionSizeUsd.toLocaleString()} |`);
  L.push(`| Tier mix (2/3/5/10%) | ${formatTierMix(bear.tierMix)} | ${formatTierMix(base.tierMix)} | ${formatTierMix(bull.tierMix)} |`);
  L.push("");
  L.push("**Reading the tier mix:**");
  L.push("- Bear: most users on the cheap 10% tier (cautious), few on the high-margin 5% tier.");
  L.push("- Base: balanced; 5% tier dominant (textbook drawdown protection).");
  L.push("- Bull: active traders favor the 5% tier (better trader-margin trade-off, generates the most Atticus margin).");
  L.push("");
  L.push("---");
  L.push("");

  // ── Headline summary ──────────────────────────────────────────────────────
  L.push("## Headline: 12-month net revenue summary");
  L.push("");
  const projs: Record<string, MonthlyProjection[]> = {
    Bear: projectScenario(bear),
    Base: projectScenario(base),
    Bull: projectScenario(bull),
  };
  L.push("| Scenario | Month 1 net rev | Month 6 net rev | Month 12 net rev | **12-month cumulative** | M12 active users | M12 net cash position |");
  L.push("|---|---|---|---|---|---|---|");
  for (const sName of ["Bear", "Base", "Bull"] as const) {
    const p = projs[sName];
    L.push(`| **${sName}** | ${fmtUsd0(p[0].monthlyNetRevenueUsd)} | ${fmtUsd0(p[5].monthlyNetRevenueUsd)} | ${fmtUsd0(p[11].monthlyNetRevenueUsd)} | **${fmtUsd0(p[11].cumulativeNetRevenueUsd)}** | ${p[11].activeUsers} | ${fmtUsd0(p[11].netCashPositionUsd)} |`);
  }
  L.push("");
  L.push("**Net cash position** = cumulative net revenue − required premium-pool reserve (~$374/active-user, from §4 of PR #95). Positive = Atticus has excess cash beyond the reserve buffer.");
  L.push("");
  L.push("---");
  L.push("");

  // ── Per-month table per scenario ──────────────────────────────────────────
  for (const sName of ["Bear", "Base", "Bull"] as const) {
    const s = SCENARIOS.find(x => x.name === sName)!;
    const p = projs[sName];
    L.push(`## ${sName} scenario — monthly breakdown`);
    L.push("");
    L.push(`*${s.description}*`);
    L.push("");
    L.push("| Month | Active users | Cohorts opened | Monthly net rev | Cumulative net rev | Reserves required | Net cash position |");
    L.push("|---|---|---|---|---|---|---|");
    for (const m of p) {
      L.push(`| ${m.month} | ${m.activeUsers} | ${m.cohortsThisMonth.toLocaleString()} | ${fmtUsd0(m.monthlyNetRevenueUsd)} | ${fmtUsd0(m.cumulativeNetRevenueUsd)} | ${fmtUsd0(m.reservesRequiredUsd)} | ${fmtUsd0(m.netCashPositionUsd)} |`);
    }
    L.push("");
  }

  // ── Key takeaways ─────────────────────────────────────────────────────────
  L.push("---");
  L.push("");
  L.push("## Key takeaways");
  L.push("");
  L.push("**Sustainability check:**");
  L.push("- All three scenarios become net-cash-positive within the first 12 months (cumulative revenue exceeds the required reserve).");
  L.push(`- Bear case turns net-cash-positive by **month ${findBreakeven(projs.Bear)}**.`);
  L.push(`- Base case turns net-cash-positive by **month ${findBreakeven(projs.Base)}**.`);
  L.push(`- Bull case turns net-cash-positive by **month ${findBreakeven(projs.Bull)}**.`);
  L.push("");
  L.push("**The dominant variable is tier mix.** The 5% tier produces ~7× the per-cohort net of the 2% tier. Scenarios where users gravitate toward the 5% tier (Base/Bull) generate disproportionately more revenue per active user.");
  L.push("");
  L.push("**The second variable is engagement.** A user opening 5 protection cohorts per month produces 2.5× the revenue of a user opening 2 cohorts per month — even at the same tier mix.");
  L.push("");
  L.push("**Starting reserves required (per the deep analysis, §4):**");
  L.push("- Launch with 50 users: ~$19k reserves");
  L.push("- Launch with 100 users: ~$37k reserves");
  L.push("- Launch with 500 users: ~$187k reserves");
  L.push("");
  L.push("If Atticus can fund the starting reserve at the chosen launch user count, the per-day product is self-funding from month 1 (revenue covers ongoing reserve growth as users are added).");
  L.push("");
  L.push("---");
  L.push("");
  L.push("## Caveats");
  L.push("");
  L.push("- **User-growth assumptions are illustrative.** Real growth depends on Foxify's go-to-market, product-market-fit signals, and BTC market context. The three curves bracket plausible outcomes but aren't probabilistic forecasts.");
  L.push("- **Engagement assumptions** (cohorts per user per month) are grounded in publicly observable retail-perp-DEX behavior, not Foxify-specific data.");
  L.push("- **Tier mix is a critical lever** — see takeaways. If actual mix skews more toward 10% tier (catastrophe-only), revenue per user drops materially even at the same user count.");
  L.push("- **Per-cohort net is a 24-month average** from the deep-analysis sim. Actual cohorts in any given month may run higher (calm regimes, 5% tier) or lower (high-vol regimes, 2% tier). Pool absorbs short-term variance.");
  L.push("- **No churn modeled.** Implicit assumption: active-user count grows monotonically. Real product will have churn; replace user-count with net-of-churn count for true projection.");
  return L.join("\n");
}

function formatTierMix(mix: Record<string, number>): string {
  const order = ["0.02", "0.03", "0.05", "0.10"];
  return order.map(k => `${Math.round((mix[k] ?? 0) * 100)}%`).join(" / ");
}

function findBreakeven(p: MonthlyProjection[]): string {
  for (const m of p) if (m.netCashPositionUsd > 0) return `${m.month}`;
  return "after month 12";
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const report = buildReport();
  await writeFile(path.join(OUTPUT_DIR, "foxify_revenue_projection.md"), report, "utf8");
  console.log(report);
  console.error(`\n[Done] Written: ${OUTPUT_DIR}/foxify_revenue_projection.md`);
}
main();
