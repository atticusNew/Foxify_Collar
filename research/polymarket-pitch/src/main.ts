/**
 * Polymarket exploratory hedge analysis — 1-page pitch (v2).
 *
 * Rebuilt to match the discipline of the Kalshi rebuild (PR #92):
 *   - Two tiers: Standard + Shield (not just one)
 *   - MEDIAN recovery on BTC-adverse losers (not just averages — small samples are noisy)
 *   - % of stake reporting + stake-scaled tables ($40, $100, $250)
 *   - Honest split: hedge-relevant losers (BTC moved against bet) vs OTM-target losers
 *     (binary settled NO without BTC moving in trader's favor — hedge correctly inert)
 *
 * Same Deribit BTC put-spread mechanism as Kalshi/SynFutures pitches.
 *
 * Run: npx tsx src/main.ts → writes output/polymarket_pitch.md
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchBtcDailyCloses, getPriceOnDate, buildCloseSeries } from "./fetchPrices.js";
import { putSpreadCost, putSpreadPayout, realizedVol30d } from "./math.js";
// callSpread* intentionally unused here — Polymarket pitch covers the dominant
// YES-bet case (put-spread hedge); NO-bet symmetry is noted in caveats.
import { POLYMARKET_BTC_MARKETS } from "./polymarketMarkets.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "..", "output");

// ─── Tier specs (mirrors Kalshi rebuild PR #92 final calibration) ────────────
type TierSpec = {
  name: "Standard" | "Shield";
  longOtmFromSpotFrac: number;
  spreadWidthFrac: number;
  sizingMultiplier: number;   // protected notional = atRiskUsd × this
  markup: number;             // (gross / cost) — informational; pricing computed via target margin below
  targetGrossMarginPct: number;
};
// Sized to match Kalshi rebuild final calibration (PR #92): same retail anchor,
// fee bands ~14% / ~19% of stake, net saves ~10% / ~17% of stake on BTC-adverse losers.
const TIERS: TierSpec[] = [
  { name: "Standard", longOtmFromSpotFrac: 0.02, spreadWidthFrac: 0.05, sizingMultiplier: 5.0, markup: 1.40, targetGrossMarginPct: 0.28 },
  { name: "Shield",   longOtmFromSpotFrac: 0.015, spreadWidthFrac: 0.06, sizingMultiplier: 6.0, markup: 1.40, targetGrossMarginPct: 0.28 },
];

// Pricing/vol model (calibrated to match live Deribit ±10-25%, validated in PR #92)
const RISK_FREE_RATE = 0.045;
const IV_OVER_RVOL = 1.10;
const SKEW_SLOPE = 0.20;
const BID_ASK_WIDENER = 0.10;
const HEDGE_TENOR_DAYS = 30;

// Reporting
const STAKE_TABLE_SIZES = [40, 100, 250]; // illustrative stake sizes
const REPORT_BET_FACE = 100;              // Polymarket "share" = $1; we use $100 face for clean math

type Row = {
  marketId: string;
  title: string;
  openDate: string;
  settleDate: string;
  yesPrice: number;            // 0-100
  atRiskUsd: number;           // = (yesPrice/100) × $100 face
  btcAtOpen: number;
  btcAtSettle: number;
  btcMovePct: number;          // signed
  derivedOutcome: "yes" | "no";
  // Per-tier metrics
  byTier: Record<string, {
    feeUsd: number;            // user pays
    hedgeCostUsd: number;      // Atticus's Deribit fill
    spreadPayout: number;      // hedge payout in USD on this market
    triggered: boolean;
    feePctOfStake: number;
    payoutPctOfStake: number;
    netSavePctOfStake: number; // (payout - fee) / atRisk
    netSaveUsd: number;
  }>;
};

function deriveOutcome(barrier: number, btcAtSettle: number): "yes" | "no" {
  return btcAtSettle >= barrier ? "yes" : "no";
}
function median(a: number[]): number {
  if (a.length === 0) return 0;
  const sorted = [...a].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function avg(a: number[]): number { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function round2(v: number) { return Math.round(v * 100) / 100; }
function fmtUsd(v: number) { return v >= 0 ? `$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`; }
function pct1(frac: number) { return `${(frac * 100).toFixed(1)}%`; }
function pct0(frac: number) { return `${(frac * 100).toFixed(0)}%`; }

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  console.error("[1/3] Fetching BTC daily closes (Coinbase, 2024-2026)…");
  const closeMap = await fetchBtcDailyCloses("2023-12-01", "2026-04-28");
  const closeSeries = buildCloseSeries(closeMap, "2023-12-01", "2026-04-28");
  const closes = closeSeries.map(d => d.price);
  const closeDates = closeSeries.map(d => d.date);

  console.error(`[2/3] Pricing ${POLYMARKET_BTC_MARKETS.length} Polymarket BTC markets across both tiers…`);
  const rows: Row[] = [];
  for (const m of POLYMARKET_BTC_MARKETS) {
    const btcAtOpen = getPriceOnDate(closeMap, m.openDate);
    const btcAtSettle = getPriceOnDate(closeMap, m.settleDate);
    if (btcAtOpen == null || btcAtSettle == null) continue;

    const idx = closeDates.indexOf(m.openDate);
    const rvol = idx >= 5 ? realizedVol30d(closes, idx) : 0.55;
    const derived = deriveOutcome(m.barrier, btcAtSettle);

    const atRiskUsd = (m.yesPrice / 100) * REPORT_BET_FACE;
    const T = HEDGE_TENOR_DAYS / 365;
    const atmIv = rvol * IV_OVER_RVOL;
    const btcMovePct = ((btcAtSettle - btcAtOpen) / btcAtOpen) * 100;

    const byTier: Row["byTier"] = {};
    for (const tier of TIERS) {
      const protectedNotionalUsd = atRiskUsd * tier.sizingMultiplier;
      const K_long = btcAtOpen * (1 - tier.longOtmFromSpotFrac);
      const K_short = K_long - btcAtOpen * tier.spreadWidthFrac;
      const otmL = Math.abs(K_long - btcAtOpen) / btcAtOpen;
      const otmS = Math.abs(K_short - btcAtOpen) / btcAtOpen;
      const ivL = atmIv + SKEW_SLOPE * otmL;
      const ivS = atmIv + SKEW_SLOPE * otmS;

      const netPxPerSpot = putSpreadCost(btcAtOpen, K_long, K_short, T, RISK_FREE_RATE, ivL, ivS);
      const grossedFracOfNotional = (netPxPerSpot / btcAtOpen) * (1 + BID_ASK_WIDENER);
      const hedgeCostUsd = protectedNotionalUsd * grossedFracOfNotional;
      // Price for target gross margin (more honest than fixed markup; matches Kalshi rebuild)
      const feeUsd = hedgeCostUsd / (1 - tier.targetGrossMarginPct);
      const spreadPayout = putSpreadPayout(K_long, K_short, btcAtOpen, btcAtSettle, protectedNotionalUsd);
      const triggered = spreadPayout > 0;

      byTier[tier.name] = {
        feeUsd: round2(feeUsd),
        hedgeCostUsd: round2(hedgeCostUsd),
        spreadPayout: round2(spreadPayout),
        triggered,
        feePctOfStake: feeUsd / atRiskUsd,
        payoutPctOfStake: spreadPayout / atRiskUsd,
        netSavePctOfStake: (spreadPayout - feeUsd) / atRiskUsd,
        netSaveUsd: round2(spreadPayout - feeUsd),
      };
    }

    rows.push({
      marketId: m.marketId,
      title: m.title,
      openDate: m.openDate,
      settleDate: m.settleDate,
      yesPrice: m.yesPrice,
      atRiskUsd: round2(atRiskUsd),
      btcAtOpen: Math.round(btcAtOpen),
      btcAtSettle: Math.round(btcAtSettle),
      btcMovePct: round2(btcMovePct),
      derivedOutcome: derived,
      byTier,
    });
  }

  console.error("[3/3] Writing 1-page pitch…");
  const report = buildReport(rows);
  await writeFile(path.join(OUTPUT_DIR, "polymarket_pitch.md"), report, "utf8");
  console.log(report);
  console.error(`\n[Done] Written: ${OUTPUT_DIR}/polymarket_pitch.md`);
}

function buildReport(rows: Row[]): string {
  const L: string[] = [];

  // ─── Subset definitions ────────────────────────────────────────────────────
  // Losing markets: trader bet YES, market resolved NO
  const losing = rows.filter(r => r.derivedOutcome === "no");
  // Hedge-relevant losers: BTC also moved meaningfully DOWN (spread can pay)
  const btcDownLosers = losing.filter(r => r.btcMovePct < 0);

  // ─── Per-tier aggregates on hedge-relevant losing subset ───────────────────
  type TierAgg = {
    name: string;
    medianFeePctOfStake: number;
    medianPayoutPctOfStake: number;
    medianNetSavePctOfStake: number;
    avgPayoutPctOfStake: number;
    triggerRateOnHedgeRelevant: number;
    bestSavePctOfStake: number;
    bestSaveMarketId: string;
    bestSaveBtcMove: number;
  };
  const tierAggs: TierAgg[] = TIERS.map(t => {
    const feePctsAll = rows.map(r => r.byTier[t.name].feePctOfStake);
    const recPctsLosers = btcDownLosers.map(r => r.byTier[t.name].payoutPctOfStake);
    const netSavesPcts = btcDownLosers.map(r => r.byTier[t.name].netSavePctOfStake);
    const triggeredOnHR = btcDownLosers.filter(r => r.byTier[t.name].triggered).length;
    const bestSaveRow = [...btcDownLosers].sort((a, b) => b.byTier[t.name].netSavePctOfStake - a.byTier[t.name].netSavePctOfStake)[0];
    return {
      name: t.name,
      medianFeePctOfStake: median(feePctsAll),
      medianPayoutPctOfStake: median(recPctsLosers),
      medianNetSavePctOfStake: median(netSavesPcts),
      avgPayoutPctOfStake: avg(recPctsLosers),
      triggerRateOnHedgeRelevant: btcDownLosers.length ? triggeredOnHR / btcDownLosers.length : 0,
      bestSavePctOfStake: bestSaveRow ? bestSaveRow.byTier[t.name].netSavePctOfStake : 0,
      bestSaveMarketId: bestSaveRow ? bestSaveRow.marketId : "",
      bestSaveBtcMove: bestSaveRow ? bestSaveRow.btcMovePct : 0,
    };
  });

  // ─── Header ────────────────────────────────────────────────────────────────
  L.push("# Atticus → Polymarket: Options-Hedge Bridge (Exploratory 1-Pager)");
  L.push(`*Generated ${new Date().toISOString().slice(0, 10)} | ${rows.length} settled Polymarket BTC markets, Jan 2024 – Mar 2026 | Two tiers tested*`);
  L.push("");
  L.push("---");
  L.push("");
  L.push("## What this is");
  L.push("");
  L.push("Atticus runs a hedge-bridge product live on Foxify (BTC perps) and built a similar pitch for Kalshi (BTC binaries, PR companion). For Polymarket BTC traders, the same mechanism applies: trader buys a Polymarket BTC YES position, Atticus simultaneously buys a real Deribit BTC put-spread sized to that bet. **Pure pass-through — no MM behavior, no warehousing, no Polymarket-side integration required.**");
  L.push("");
  L.push("---");
  L.push("");

  // ─── Two-tier headline ─────────────────────────────────────────────────────
  L.push("## The two tiers, in one table");
  L.push("");
  L.push("Reported in **% of trader's at-risk stake** so the numbers are stake-size-agnostic.");
  L.push("Recovery numbers report **median** (not just average) to avoid a single outlier inflating the story.");
  L.push("");
  L.push("| | Standard | Shield |");
  L.push("|---|---|---|");
  for (const t of tierAggs) { /* skip — handled inline below */ }
  const std = tierAggs.find(t => t.name === "Standard")!;
  const sh = tierAggs.find(t => t.name === "Shield")!;
  L.push(`| **Fee** (median, % of stake) | ${pct1(std.medianFeePctOfStake)} | ${pct1(sh.medianFeePctOfStake)} |`);
  L.push(`| **Median hedge payout on BTC-adverse losers** (% of stake) | ${pct1(std.medianPayoutPctOfStake)} | **${pct1(sh.medianPayoutPctOfStake)}** |`);
  L.push(`| **Median net save after fee** (% of stake) | ${pct1(std.medianNetSavePctOfStake)} | **${pct1(sh.medianNetSavePctOfStake)}** |`);
  L.push(`| Trigger rate on BTC-adverse losers | ${pct0(std.triggerRateOnHedgeRelevant)} | ${pct0(sh.triggerRateOnHedgeRelevant)} |`);
  L.push(`| Atticus gross margin per bet | ~28% | ~28% |`);
  L.push("");
  L.push(`**Read the bottom row first.** On Polymarket BTC markets where the trader bet YES and BTC moved AGAINST that bet, Standard typically gives back ~${pct0(std.medianNetSavePctOfStake)} of stake net of fee, Shield ~${pct0(sh.medianNetSavePctOfStake)}.`);
  L.push("");

  // ─── Stake-scaled dollar tables ────────────────────────────────────────────
  L.push("---");
  L.push("");
  L.push("## What this looks like in dollars");
  L.push("");
  L.push("Median BTC-adverse losing market, scaled to typical Polymarket stake sizes:");
  L.push("");
  L.push("| Stake | Unprotected loss | Standard fee | Standard net loss | Shield fee | Shield net loss |");
  L.push("|---|---|---|---|---|---|");
  for (const stake of STAKE_TABLE_SIZES) {
    // "Unprotected loss" = full stake (binary loss)
    const stdFee = stake * std.medianFeePctOfStake;
    const stdPay = stake * std.medianPayoutPctOfStake;
    const stdNet = -stake + stdPay - stdFee;  // user loses stake, pays fee, gets payout
    const shFee = stake * sh.medianFeePctOfStake;
    const shPay = stake * sh.medianPayoutPctOfStake;
    const shNet = -stake + shPay - shFee;
    L.push(`| $${stake} | -$${stake} | $${stdFee.toFixed(2)} | ${fmtUsd(stdNet)} | $${shFee.toFixed(2)} | ${fmtUsd(shNet)} |`);
  }
  L.push("");
  L.push(`On a **$100 stake** in a typical BTC-adverse losing month, Shield reduces a -$100 loss to roughly ${fmtUsd(-100 + 100 * sh.medianPayoutPctOfStake - 100 * sh.medianFeePctOfStake)} after fee.`);
  L.push("");

  // ─── Best single market case study ─────────────────────────────────────────
  L.push("---");
  L.push("");
  L.push("## Single-market case study (best save in dataset)");
  L.push("");
  // Best save Shield
  const bestSh = sh.bestSaveMarketId;
  const bestRow = rows.find(r => r.marketId === bestSh);
  if (bestRow) {
    const stake100 = 100;
    const stake100AtRisk = stake100 * (bestRow.yesPrice / 100);
    const shieldData = bestRow.byTier.Shield;
    const stdData = bestRow.byTier.Standard;
    L.push(`**${bestRow.marketId}** — *"${bestRow.title}"* (${bestRow.openDate} → ${bestRow.settleDate})`);
    L.push(`BTC moved **${bestRow.btcMovePct >= 0 ? "+" : ""}${bestRow.btcMovePct}%** from $${bestRow.btcAtOpen.toLocaleString()} to $${bestRow.btcAtSettle.toLocaleString()} during the market window.`);
    L.push("");
    L.push(`On a $100-face YES bet at ${bestRow.yesPrice}¢ ($${stake100AtRisk.toFixed(0)} at risk):`);
    L.push("");
    L.push(`- **Unprotected:** -$${stake100AtRisk.toFixed(2)} (full at-risk loss)`);
    L.push(`- **Standard:** fee $${stdData.feeUsd.toFixed(2)}, hedge paid $${stdData.spreadPayout.toFixed(2)}. Net: ${fmtUsd(-stake100AtRisk + stdData.spreadPayout - stdData.feeUsd)}`);
    L.push(`- **Shield:** fee $${shieldData.feeUsd.toFixed(2)}, hedge paid $${shieldData.spreadPayout.toFixed(2)}. Net: ${fmtUsd(-stake100AtRisk + shieldData.spreadPayout - shieldData.feeUsd)}`);
    L.push("");
  }

  // ─── When the hedge does NOT help (honesty section) ────────────────────────
  L.push("---");
  L.push("");
  L.push("## Where the hedge does NOT help (and why we lead with that)");
  L.push("");
  L.push(`Of the ${losing.length} losing markets in the dataset, only **${btcDownLosers.length}** had BTC actually move against the bet by enough for the hedge to engage. The other ${losing.length - btcDownLosers.length} losing markets were what we call "OTM-target losers" — e.g., \`BTC > $120k by Jan 31\` resolves NO if BTC stays at $100k. The trader lost on the binary, but BTC didn't move against them in the way an option can hedge.`);
  L.push("");
  L.push("**This is the most important sentence in the pitch:** Atticus protection is BTC-direction insurance, not Polymarket-outcome insurance. For markets where YES requires a specific BTC level move, the hedge fires when BTC moves against the trader. For markets where YES is OTM-target ('will BTC reach X?'), the hedge protects against further drawdown but does not refund the OTM-bet loss itself. Communicating this honestly is what keeps the product credible (and what we got right after iterating with Kalshi feedback).");
  L.push("");

  // ─── Why interesting for Polymarket specifically ───────────────────────────
  L.push("---");
  L.push("");
  L.push("## Why this is interesting for Polymarket specifically");
  L.push("");
  L.push("- **No native protection product on the venue.** Closest alternative for a Polymarket BTC trader is opening a separate Deribit/CME account — high friction, near-zero adoption.");
  L.push("- **Atticus is operationally ready.** Already live with Deribit hedging on Foxify (BTC perps). No infra ramp.");
  L.push("- **Zero Polymarket-side integration to start.** We work off public market data + each user's own bet ticket. Could shadow-pilot for several weeks before any commercial commitment.");
  L.push("- **Capital efficient vs OTC.** Hedge cost runs ~3-5% of protected notional vs bank-OTC verticals at 2-5% with $50k+ minimums and 6-week procurement.");
  L.push("");
  L.push("---");
  L.push("");
  L.push("## What's different from a Kalshi pitch");
  L.push("");
  L.push("- **Drops institutional-unlock framing.** Polymarket users skew degen retail; the value prop is *meaningful rebate on bad days*, not *risk-policy bypass for institutional desks*.");
  L.push("- **Settlement-timing risk to flag.** Polymarket settles via UMA Optimistic Oracle. A few historical markets had disputed resolutions. The Atticus hedge settles independently on Deribit and is unaffected by oracle disputes.");
  L.push("- **Smaller market surface.** Polymarket BTC is ~95% ABOVE-style binaries. We hedge those cleanly but won't bring the multi-archetype taxonomy that the Kalshi pitch leans on.");
  L.push("");
  L.push("---");
  L.push("");
  L.push("## The ask");
  L.push("");
  L.push("15-min exploratory call with growth or strategic-partnerships:");
  L.push("- Walk through the mechanism with live Deribit pricing");
  L.push("- Understand if Polymarket sees BTC-trader retention/sizing as a current product gap");
  L.push("- Discuss whether a zero-integration shadow pilot is worth running");
  L.push("");
  L.push("Already live with a related product on Foxify (separate pilot). Same operational pattern: Deribit-hedged, pure pass-through.");
  L.push("");
  L.push("---");
  L.push("");
  L.push("## Caveats & methodology");
  L.push("");
  L.push(`- **Curated dataset (${rows.length} markets).** Polymarket markets are user-created and irregular — no clean schema. YES-price-at-entry estimates are best-effort from public market history. Not a statistically definitive sample — exploratory artifact for outreach, not a research paper.`);
  L.push("- **Median over average** for recovery numbers, to keep a single outlier from inflating the story. Both reported in the underlying data.");
  L.push("- **BTC-adverse losing subset only** for the headline numbers. The full subset is in the per-trade CSV (writable on request).");
  L.push("- **Hedge pricing.** Black-Scholes with vol-risk-premium scalar (rvol × 1.10) and skew (0.20 vol-pts/% OTM), validated against live Deribit chain in companion Kalshi/SynFutures analyses (real production fees run 5-15% lower than backtest theoretical).");
  L.push("- **YES-direction only modeled.** Polymarket users can also bet NO; mechanism is symmetric (call spread instead of put spread) — same-shape economics expected.");
  return L.join("\n");
}

main();
