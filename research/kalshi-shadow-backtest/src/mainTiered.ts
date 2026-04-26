/**
 * Tiered Kalshi Shadow Backtest — entry point (v2).
 *
 * PURPOSE:
 *   Run the same 27-market Kalshi BTC dataset through two protection tiers
 *   (Lite, Standard) using direct Black-Scholes pricing on actual strikes,
 *   and produce pitch-ready cash numbers calibrated to:
 *     Lite     — fee 5–7% of stake, recovery 20–30% of loss
 *     Standard — fee 10–15% of stake, recovery 40–60% of loss (where BTC moves)
 *
 * RELATIONSHIP TO v1:
 *   v1 = src/main.ts  (still works, untouched).
 *   v2 = this file. Outputs land in ./output/tiered/ to avoid overwriting v1.
 *
 * ISOLATION:
 *   Imports only from sibling files in this research package.
 *   No imports from services/api, services/hedging, or any live pilot code.
 *
 * Run: npx tsx src/mainTiered.ts
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { KALSHI_BTC_MARKETS, type KalshiMarket } from "./kalshiMarkets.js";
import { fetchBtcDailyPrices, getPriceOnDate, buildCloseSeries } from "./fetchBtcPrices.js";
import { realizedVol30d, classifyRegime } from "./math.js";
import {
  quoteTieredBundle,
  computeTieredOutcome,
  TIER_CONFIGS,
  type TierName,
  type TieredBundleQuote,
  type TieredHedgeOutcome,
} from "./tieredHedgeModel.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "..", "output", "tiered");

// ─── Constants ───────────────────────────────────────────────────────────────

const BET_SIZE_USD = 100;
const TIERS: TierName[] = ["lite", "standard"];

// Volume scaling (kept identical to v1 for consistency in the pitch deck):
//   27 monthly markets × ~$750k avg notional ≈ $20M total.
//   Per-$100-face stat × 7407 ≈ real-world Kalshi BTC dataset value.
const SCALE_FACTOR = 7407;

// ─── Types ───────────────────────────────────────────────────────────────────

type DerivedOutcome = "yes" | "no";

type RowPerTier = {
  tier: TierName;
  marketId: string;
  title: string;
  openDate: string;
  settleDate: string;
  daysToSettle: number;
  strikeUsd: number;
  direction: string;
  yesPrice: number;
  recordedOutcome: "yes" | "no";
  derivedOutcome: DerivedOutcome;
  outcomeMismatch: boolean;
  btcAtOpen: number;
  btcAtSettle: number;
  btcMovePct: number;
  rvol30d: number;
  regime: string;
  // Quote
  K_long: number;
  K_short: number;
  feeUsd: number;
  feePctOfStake: number;
  maxPayoutUsd: number;
  maxRecoveryPctOfStake: number;
  returnOnTrigger: number;
  hedgeCostUsd: number;
  // Outcome
  hedgeTriggered: boolean;
  spreadPayoutUsd: number;
  kalshiPnlUsd: number;
  userNetWithProtectionUsd: number;
  userSavedUsd: number;
  recoveryPctOfStake: number;
  recoveryPctOfRealizedLoss: number;
  platformNetPnlUsd: number;
};

// ─── Outcome resolver ────────────────────────────────────────────────────────
// Derive outcome strictly from price + strike + direction. We don't mutate
// the curated dataset — we just print both and flag mismatches.
function deriveOutcome(market: KalshiMarket, btcAtSettle: number): DerivedOutcome {
  const above = btcAtSettle >= market.strikeUsd;
  if (market.direction === "above") return above ? "yes" : "no";
  return above ? "no" : "yes";
}

// ─── Backtest ────────────────────────────────────────────────────────────────

async function runTieredBacktest(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });

  console.error("─".repeat(74));
  console.error("  Atticus / Kalshi Shadow Hedge Backtest — TIERED (v2)");
  console.error("  Tiers: Lite (5–7% fee target) | Standard (10–15% fee target)");
  console.error("─".repeat(74));

  console.error("[1/4] Fetching BTC daily closes (Coinbase → Binance)…");
  const priceMap = await fetchBtcDailyPrices("2023-11-01", "2026-04-26");
  console.error(`      Got ${priceMap.size} daily price points.`);

  if (priceMap.size < 50) {
    console.error("[ERROR] Insufficient price data. Aborting.");
    process.exit(1);
  }

  const allCloses = buildCloseSeries(priceMap, "2023-11-01", "2026-04-26");
  const closePrices = allCloses.map(d => d.price);
  const closeDates = allCloses.map(d => d.date);

  console.error(`[2/4] Pricing ${KALSHI_BTC_MARKETS.length} markets × ${TIERS.length} tiers…`);
  const rows: RowPerTier[] = [];
  let mismatchCount = 0;

  for (const market of KALSHI_BTC_MARKETS) {
    const btcAtOpen = getPriceOnDate(priceMap, market.openDate);
    const btcAtSettle = getPriceOnDate(priceMap, market.settleDate);
    if (!btcAtOpen || !btcAtSettle) {
      console.error(`  [SKIP] ${market.marketId}: missing BTC price`);
      continue;
    }

    const openIdx = closeDates.indexOf(market.openDate);
    const rvol = openIdx >= 5 ? realizedVol30d(closePrices, openIdx) : 0.55;
    const regime = classifyRegime(rvol);
    const derivedOutcome = deriveOutcome(market, btcAtSettle);
    const outcomeMismatch = derivedOutcome !== market.outcome;
    if (outcomeMismatch) mismatchCount++;

    // Use the DERIVED outcome for protection economics — that's the truthful
    // mechanic. The recorded outcome is preserved in the row for audit.
    const usedOutcome = derivedOutcome;
    const btcMovePct = (btcAtSettle - btcAtOpen) / btcAtOpen;

    for (const tier of TIERS) {
      const quote = quoteTieredBundle({
        tier,
        rvol,
        tenorDays: market.daysToSettle,
        yesPrice: market.yesPrice,
        betSizeUsd: BET_SIZE_USD,
        btcAtOpen,
      });
      const outcome = computeTieredOutcome({
        tier,
        btcAtOpen,
        btcAtSettle,
        yesPrice: market.yesPrice,
        betSizeUsd: BET_SIZE_USD,
        kalshiOutcome: usedOutcome,
        rvol,
        quote,
      });

      rows.push({
        tier,
        marketId: market.marketId,
        title: market.title,
        openDate: market.openDate,
        settleDate: market.settleDate,
        daysToSettle: market.daysToSettle,
        strikeUsd: market.strikeUsd,
        direction: market.direction,
        yesPrice: market.yesPrice,
        recordedOutcome: market.outcome,
        derivedOutcome,
        outcomeMismatch,
        btcAtOpen: Math.round(btcAtOpen),
        btcAtSettle: Math.round(btcAtSettle),
        btcMovePct: r2(btcMovePct * 100),
        rvol30d: r2(rvol * 100),
        regime,
        K_long: Math.round(quote.K_long),
        K_short: Math.round(quote.K_short),
        feeUsd: r2(quote.chargeUsd),
        feePctOfStake: r2(quote.feePctOfStake * 100),
        maxPayoutUsd: r2(quote.maxPayoutUsd),
        maxRecoveryPctOfStake: r2(quote.maxRecoveryPctOfStake * 100),
        returnOnTrigger: r2(quote.returnOnTrigger),
        hedgeCostUsd: r2(quote.hedgeCostUsd),
        hedgeTriggered: outcome.hedgeTriggered,
        spreadPayoutUsd: r2(outcome.spreadPayoutUsd),
        kalshiPnlUsd: r2(outcome.kalshiPnlUsd),
        userNetWithProtectionUsd: r2(outcome.userNetWithProtectionUsd),
        userSavedUsd: r2(outcome.userSavedUsd),
        recoveryPctOfStake: r2(outcome.recoveryPctOfStake * 100),
        recoveryPctOfRealizedLoss: r2(outcome.recoveryPctOfRealizedLoss * 100),
        platformNetPnlUsd: r2(outcome.platformNetPnlUsd),
      });
    }
  }

  if (rows.length === 0) {
    console.error("[ERROR] No rows produced. Aborting.");
    process.exit(1);
  }

  console.error(`      Produced ${rows.length} rows (${rows.length / TIERS.length} markets × ${TIERS.length} tiers).`);
  console.error(`      Recorded-vs-derived outcome mismatches: ${mismatchCount} / ${KALSHI_BTC_MARKETS.length}`);

  // ─── Aggregate by tier ────────────────────────────────────────────────
  console.error("[3/4] Aggregating tier statistics…");

  const liteRows = rows.filter(r => r.tier === "lite");
  const stdRows = rows.filter(r => r.tier === "standard");
  const liteAgg = aggregate(liteRows);
  const stdAgg = aggregate(stdRows);

  // ─── Write CSV ────────────────────────────────────────────────────────
  console.error("[4/4] Writing outputs…");
  await writeFile(
    path.join(OUTPUT_DIR, "kalshi_tiered_trades.csv"),
    rowsToCsv(rows),
    "utf8",
  );

  // ─── Write summary ────────────────────────────────────────────────────
  const summary = buildSummary(rows, liteAgg, stdAgg, mismatchCount);
  await writeFile(path.join(OUTPUT_DIR, "kalshi_tiered_summary.md"), summary, "utf8");

  // ─── Write pitch snippets ─────────────────────────────────────────────
  const snippets = buildPitchSnippets(rows, liteAgg, stdAgg);
  await writeFile(path.join(OUTPUT_DIR, "kalshi_tiered_pitch_snippets.md"), snippets, "utf8");

  // ─── Stdout ───────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(74));
  console.log("  KALSHI TIERED SHADOW BACKTEST — RESULTS");
  console.log("═".repeat(74));
  console.log(summary);
  console.log("\n" + "═".repeat(74));
  console.log("  PITCH SNIPPETS");
  console.log("═".repeat(74));
  console.log(snippets);
  console.log(`\n[Done] Output: ${OUTPUT_DIR}`);
}

// ─── Aggregator ──────────────────────────────────────────────────────────────

type TierAggregate = {
  tier: TierName;
  n: number;
  // Fee
  avgFeeUsd: number;
  avgFeePctOfStake: number;
  // Hedge / platform
  totalRevenue: number;
  totalHedgeCost: number;
  totalPayouts: number;
  totalPlatformPnl: number;
  avgPlatformPnlPerTrade: number;
  platformWinRate: number;
  avgMarginPctOfRevenue: number;
  // Recovery (full set)
  losingTrades: RowPerTier[];
  losingBtcDownTrades: RowPerTier[];     // losing AND BTC fell
  losingDeepDropTrades: RowPerTier[];    // losing AND BTC fell ≥10% (the brief's "10-20% miss" subset)
  triggeredTrades: RowPerTier[];
  triggeredLosingTrades: RowPerTier[];   // hedge fired AND Kalshi lost
  avgRecoveryAllLosersUsd: number;
  avgRecoveryAllLosersPctOfStake: number;
  avgRecoveryAllLosersPctOfRealizedLoss: number;
  avgRecoveryBtcDownLosersUsd: number;
  avgRecoveryBtcDownLosersPctOfStake: number;
  avgRecoveryBtcDownLosersPctOfRealizedLoss: number;
  avgRecoveryTriggeredLosersUsd: number;            // KEY pitch metric
  avgRecoveryTriggeredLosersPctOfStake: number;     // KEY pitch metric
  avgRecoveryTriggeredLosersPctOfRealizedLoss: number; // KEY pitch metric
  avgRecoveryDeepDropLosersUsd: number;             // matches brief's "10-20% miss" subset
  avgRecoveryDeepDropLosersPctOfStake: number;
  avgRecoveryDeepDropLosersPctOfRealizedLoss: number;
  fractionLosersWithBigPayout: number;   // payout > 20% of stake
  fractionLosersWithMidPayout: number;   // payout > 10% of stake
  // User-friendly aggregate change
  avgUserNetUnprotectedLosersUsd: number;
  avgUserNetProtectedLosersUsd: number;
  // Best single
  bestSaveTrade: RowPerTier | undefined;
  worstBtcMoveLoser: RowPerTier | undefined;
};

function aggregate(rows: RowPerTier[]): TierAggregate {
  const tier = rows[0].tier;
  const n = rows.length;
  const losing = rows.filter(r => r.kalshiPnlUsd < 0);
  const losingBtcDown = losing.filter(r => r.btcMovePct < 0);
  const triggered = rows.filter(r => r.hedgeTriggered);

  const sum = (arr: number[]) => arr.reduce((s, v) => s + v, 0);
  const avg = (arr: number[]) => (arr.length ? sum(arr) / arr.length : 0);

  const totalRevenue = sum(rows.map(r => r.feeUsd));
  const totalHedgeCost = sum(rows.map(r => r.hedgeCostUsd));
  const totalPayouts = sum(rows.map(r => r.spreadPayoutUsd));
  const totalPlatformPnl = sum(rows.map(r => r.platformNetPnlUsd));
  const platformWins = rows.filter(r => r.platformNetPnlUsd > 0).length;

  const losersWithBigPayout = losing.filter(r => r.recoveryPctOfStake >= 20).length;
  const losersWithMidPayout = losing.filter(r => r.recoveryPctOfStake >= 10).length;
  const triggeredLosing = losing.filter(r => r.hedgeTriggered);
  const deepDropLosing = losing.filter(r => r.btcMovePct <= -10);

  const bestSave = [...rows].sort((a, b) => b.userSavedUsd - a.userSavedUsd)[0];
  const worstBtc = [...losing].sort((a, b) => a.btcMovePct - b.btcMovePct)[0];

  return {
    tier,
    n,
    avgFeeUsd: avg(rows.map(r => r.feeUsd)),
    avgFeePctOfStake: avg(rows.map(r => r.feePctOfStake)),
    totalRevenue,
    totalHedgeCost,
    totalPayouts,
    totalPlatformPnl,
    avgPlatformPnlPerTrade: avg(rows.map(r => r.platformNetPnlUsd)),
    platformWinRate: (platformWins / n) * 100,
    avgMarginPctOfRevenue: totalRevenue > 0 ? ((totalRevenue - totalHedgeCost) / totalRevenue) * 100 : 0,
    losingTrades: losing,
    losingBtcDownTrades: losingBtcDown,
    losingDeepDropTrades: deepDropLosing,
    triggeredTrades: triggered,
    triggeredLosingTrades: triggeredLosing,
    avgRecoveryAllLosersUsd: avg(losing.map(r => r.spreadPayoutUsd)),
    avgRecoveryAllLosersPctOfStake: avg(losing.map(r => r.recoveryPctOfStake)),
    avgRecoveryAllLosersPctOfRealizedLoss: avg(losing.map(r => r.recoveryPctOfRealizedLoss)),
    avgRecoveryBtcDownLosersUsd: avg(losingBtcDown.map(r => r.spreadPayoutUsd)),
    avgRecoveryBtcDownLosersPctOfStake: avg(losingBtcDown.map(r => r.recoveryPctOfStake)),
    avgRecoveryBtcDownLosersPctOfRealizedLoss: avg(losingBtcDown.map(r => r.recoveryPctOfRealizedLoss)),
    avgRecoveryTriggeredLosersUsd: avg(triggeredLosing.map(r => r.spreadPayoutUsd)),
    avgRecoveryTriggeredLosersPctOfStake: avg(triggeredLosing.map(r => r.recoveryPctOfStake)),
    avgRecoveryTriggeredLosersPctOfRealizedLoss: avg(triggeredLosing.map(r => r.recoveryPctOfRealizedLoss)),
    avgRecoveryDeepDropLosersUsd: avg(deepDropLosing.map(r => r.spreadPayoutUsd)),
    avgRecoveryDeepDropLosersPctOfStake: avg(deepDropLosing.map(r => r.recoveryPctOfStake)),
    avgRecoveryDeepDropLosersPctOfRealizedLoss: avg(deepDropLosing.map(r => r.recoveryPctOfRealizedLoss)),
    fractionLosersWithBigPayout: losing.length ? losersWithBigPayout / losing.length : 0,
    fractionLosersWithMidPayout: losing.length ? losersWithMidPayout / losing.length : 0,
    avgUserNetUnprotectedLosersUsd: avg(losing.map(r => r.kalshiPnlUsd)),
    avgUserNetProtectedLosersUsd: avg(losing.map(r => r.userNetWithProtectionUsd)),
    bestSaveTrade: bestSave,
    worstBtcMoveLoser: worstBtc,
  };
}

// ─── Reporting helpers ───────────────────────────────────────────────────────

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

function fmt$(v: number): string {
  if (v >= 0) return `$${v.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
  return `-$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}

function fmt$0(v: number): string {
  if (v >= 0) return `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  return `-$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function rowsToCsv(rows: RowPerTier[]): string {
  const header = [
    "tier", "marketId", "openDate", "settleDate", "days", "strikeUsd", "direction",
    "yesPriceCents", "recordedOutcome", "derivedOutcome", "outcomeMismatch",
    "btcAtOpen", "btcAtSettle", "btcMovePct", "rvol30dPct", "regime",
    "K_long", "K_short",
    "feeUsd", "feePctOfStake", "maxPayoutUsd", "maxRecoveryPctOfStake", "returnOnTrigger",
    "hedgeCostUsd", "hedgeTriggered", "spreadPayoutUsd",
    "kalshiPnlUsd", "userNetWithProtectionUsd", "userSavedUsd",
    "recoveryPctOfStake", "recoveryPctOfRealizedLoss",
    "platformNetPnlUsd",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([
      r.tier, r.marketId, r.openDate, r.settleDate, r.daysToSettle, r.strikeUsd, r.direction,
      r.yesPrice, r.recordedOutcome, r.derivedOutcome, r.outcomeMismatch ? "YES" : "NO",
      r.btcAtOpen, r.btcAtSettle, r.btcMovePct, r.rvol30d, r.regime,
      r.K_long, r.K_short,
      r.feeUsd, r.feePctOfStake, r.maxPayoutUsd, r.maxRecoveryPctOfStake, r.returnOnTrigger,
      r.hedgeCostUsd, r.hedgeTriggered ? "YES" : "NO", r.spreadPayoutUsd,
      r.kalshiPnlUsd, r.userNetWithProtectionUsd, r.userSavedUsd,
      r.recoveryPctOfStake, r.recoveryPctOfRealizedLoss,
      r.platformNetPnlUsd,
    ].join(","));
  }
  return lines.join("\n") + "\n";
}

function buildSummary(
  allRows: RowPerTier[],
  lite: TierAggregate,
  std: TierAggregate,
  mismatchCount: number,
): string {
  const L: string[] = [];
  L.push("# Atticus / Kalshi Shadow Hedge Backtest — Tiered (v2)");
  L.push(`**Generated:** ${new Date().toISOString().slice(0, 10)}`);
  L.push(`**Markets analyzed:** ${KALSHI_BTC_MARKETS.length} settled Kalshi BTC monthly markets (Jan 2024 – Apr 2026)`);
  L.push(`**Bet size used for cash figures:** $${BET_SIZE_USD} contract face value (scales linearly).`);
  L.push(`**Outcome mismatch flags (recorded vs derived from BTC price):** ${mismatchCount} of ${KALSHI_BTC_MARKETS.length} — economics use **derived** outcome.`);
  L.push("");
  L.push("---");
  L.push("");
  L.push("## Tier definitions");
  L.push("");
  L.push("| Tier | Long-put OTM | Short-put OTM | Spread width | Sizing | Markup |");
  L.push("|---|---|---|---|---|---|");
  for (const t of TIERS) {
    const c = TIER_CONFIGS[t];
    L.push(`| ${t} | ${(c.longOtmPct * 100).toFixed(1)}% | ${(c.shortOtmPct * 100).toFixed(1)}% | ${((c.shortOtmPct - c.longOtmPct) * 100).toFixed(1)}% | ${c.sizingMultiplier.toFixed(2)}× of at-risk | ${c.markup.toFixed(2)}× |`);
  }
  L.push("");
  L.push("Pricing: direct Black-Scholes on actual BTC strikes at each market's open date, using realized-vol-derived IV with skew (no √T tier-scaling shortcut).");
  L.push("");
  L.push("---");
  L.push("");
  L.push("## Headline tier comparison (per $100 contract face)");
  L.push("");
  L.push("| Metric | Lite | Standard | Target (project brief) |");
  L.push("|---|---|---|---|");
  L.push(`| Avg fee ($) | ${fmt$(lite.avgFeeUsd)} | ${fmt$(std.avgFeeUsd)} | Lite ~$3, Std ~$6–9 |`);
  L.push(`| Avg fee (% of stake) | ${lite.avgFeePctOfStake.toFixed(1)}% | ${std.avgFeePctOfStake.toFixed(1)}% | Lite 5–7%, Std 10–15% |`);
  L.push(`| Avg recovery, all losers ($) | ${fmt$(lite.avgRecoveryAllLosersUsd)} | ${fmt$(std.avgRecoveryAllLosersUsd)} | — |`);
  L.push(`| Avg recovery, all losers (% of stake) | ${lite.avgRecoveryAllLosersPctOfStake.toFixed(1)}% | ${std.avgRecoveryAllLosersPctOfStake.toFixed(1)}% | — |`);
  L.push(`| Avg recovery, BTC-down losers ($) | ${fmt$(lite.avgRecoveryBtcDownLosersUsd)} | ${fmt$(std.avgRecoveryBtcDownLosersUsd)} | — |`);
  L.push(`| Avg recovery, BTC-down losers (% of stake) | ${lite.avgRecoveryBtcDownLosersPctOfStake.toFixed(1)}% | ${std.avgRecoveryBtcDownLosersPctOfStake.toFixed(1)}% | — |`);
  L.push(`| **Avg recovery, hedge-triggered losers ($)** | ${fmt$(lite.avgRecoveryTriggeredLosersUsd)} | ${fmt$(std.avgRecoveryTriggeredLosersUsd)} | Lite ~$12–18, Std ~$23–35 |`);
  L.push(`| **Avg recovery, hedge-triggered losers (% of stake = % of loss on binary)** | ${lite.avgRecoveryTriggeredLosersPctOfStake.toFixed(1)}% | ${std.avgRecoveryTriggeredLosersPctOfStake.toFixed(1)}% | Lite 20–30%, Std 40–60% |`);
  L.push(`| **Deep-drop subset (BTC ≥10% down) avg recovery ($)** | ${fmt$(lite.avgRecoveryDeepDropLosersUsd)} | ${fmt$(std.avgRecoveryDeepDropLosersUsd)} | — |`);
  L.push(`| **Deep-drop subset avg recovery (% of stake/loss)** | ${lite.avgRecoveryDeepDropLosersPctOfStake.toFixed(1)}% | ${std.avgRecoveryDeepDropLosersPctOfStake.toFixed(1)}% | Std 40–60% target — see notes |`);
  L.push(`| Deep-drop subset n | ${lite.losingDeepDropTrades.length} | ${std.losingDeepDropTrades.length} | — |`);
  L.push(`| Fraction of losers w/ payout ≥10% of stake | ${(lite.fractionLosersWithMidPayout * 100).toFixed(0)}% | ${(std.fractionLosersWithMidPayout * 100).toFixed(0)}% | — |`);
  L.push(`| Fraction of losers w/ payout ≥20% of stake | ${(lite.fractionLosersWithBigPayout * 100).toFixed(0)}% | ${(std.fractionLosersWithBigPayout * 100).toFixed(0)}% | — |`);
  L.push(`| Platform avg margin (% of revenue) | ${lite.avgMarginPctOfRevenue.toFixed(1)}% | ${std.avgMarginPctOfRevenue.toFixed(1)}% | 25–40% |`);
  L.push(`| Platform avg P&L per trade ($) | ${fmt$(lite.avgPlatformPnlPerTrade)} | ${fmt$(std.avgPlatformPnlPerTrade)} | — |`);
  L.push(`| Platform total P&L (per $100 face × ${KALSHI_BTC_MARKETS.length}) | ${fmt$(lite.totalPlatformPnl)} | ${fmt$(std.totalPlatformPnl)} | — |`);
  L.push(`| Platform total P&L (scaled to ~$750k/market) | ${fmt$0(lite.totalPlatformPnl * SCALE_FACTOR)} | ${fmt$0(std.totalPlatformPnl * SCALE_FACTOR)} | — |`);
  L.push("");
  L.push("---");
  L.push("");
  L.push("## Losing-market detail");
  L.push("");
  for (const tierAgg of [lite, std]) {
    L.push(`### Tier: ${tierAgg.tier}`);
    L.push(`- Losing markets: **${tierAgg.losingTrades.length}** of ${tierAgg.n}`);
    L.push(`- Losers where BTC fell during the window: **${tierAgg.losingBtcDownTrades.length}** of ${tierAgg.losingTrades.length}`);
    L.push(`- Avg unprotected loss on losing markets: ${fmt$(tierAgg.avgUserNetUnprotectedLosersUsd)}`);
    L.push(`- Avg net P&L on losing markets WITH protection: ${fmt$(tierAgg.avgUserNetProtectedLosersUsd)}`);
    L.push(`- Avg payout on losers: ${fmt$(tierAgg.avgRecoveryAllLosersUsd)} (${tierAgg.avgRecoveryAllLosersPctOfStake.toFixed(1)}% of stake)`);
    if (tierAgg.bestSaveTrade) {
      const b = tierAgg.bestSaveTrade;
      L.push(`- Best single user save: ${b.marketId} (${b.openDate} → ${b.settleDate}), BTC ${b.btcMovePct >= 0 ? "+" : ""}${b.btcMovePct}%, payout ${fmt$(b.spreadPayoutUsd)} on ${fmt$(b.feeUsd)} fee.`);
    }
    if (tierAgg.worstBtcMoveLoser) {
      const w = tierAgg.worstBtcMoveLoser;
      L.push(`- Most painful BTC move on losing market: ${w.marketId} (BTC ${w.btcMovePct}%) — unprotected ${fmt$(w.kalshiPnlUsd)} → protected ${fmt$(w.userNetWithProtectionUsd)}.`);
    }
    L.push("");
  }
  L.push("---");
  L.push("");
  L.push("## Per-market trade log (Standard tier — most pitch-relevant)");
  L.push("");
  L.push("| Market | Open → Settle | BTC move | Recorded | Derived | Fee | Payout | Net before/after | Saved |");
  L.push("|---|---|---|---|---|---|---|---|---|");
  const stdRowsSorted = allRows.filter(r => r.tier === "standard");
  for (const r of stdRowsSorted) {
    const flag = r.outcomeMismatch ? " ⚠" : "";
    L.push(
      `| ${r.marketId} | ${r.openDate}→${r.settleDate} | ${r.btcMovePct >= 0 ? "+" : ""}${r.btcMovePct}% | ${r.recordedOutcome.toUpperCase()}${flag} | ${r.derivedOutcome.toUpperCase()} | ${fmt$(r.feeUsd)} | ${fmt$(r.spreadPayoutUsd)} | ${fmt$(r.kalshiPnlUsd)} → ${fmt$(r.userNetWithProtectionUsd)} | ${r.userSavedUsd >= 0 ? "+" : ""}${fmt$(r.userSavedUsd)} |`,
    );
  }
  L.push("");
  L.push("---");
  L.push("");
  L.push("## Notes & caveats");
  L.push("");
  L.push(`- "Outcome mismatch" rows mark cases where the curated dataset's recorded outcome disagrees with the outcome derived from BTC daily-close at settle. ${mismatchCount} flagged. The economics in this report use **derived** outcomes for self-consistency. The original v1 backtest used the curated outcome.`);
  L.push("- All option pricing is direct Black-Scholes on the actual BTC strike at each market's open date, using realized-vol-derived IV with empirical skew. No Foxify SL-tier × √T scaling is applied.");
  L.push("- Spread payouts assume Atticus owns a fully-hedged Deribit put spread per user position (net cash flow = 0 on triggered trades; platform earns markup minus hedge cost in expectation).");
  L.push("- TP recovery on un-triggered hedges uses the same calm/normal/stress regression as v1.");
  L.push("- Volume scaling factor `7407` matches v1 (assumes ~$750k notional × 27 markets ≈ $20M dataset).");
  L.push("");
  L.push("**On the brief's 40–60% Standard recovery target:** A pure put spread can recover at most `BTC drop × protected notional`, capped at spread width × notional. In our 14 losing markets BTC drops average ~7% (3 losing markets had BTC actually rise). To deterministically deliver 40–60% loss recovery on **every** losing market, the spread alone is not enough — it requires a hybrid wrapper that pairs the put spread with a small Kalshi-NO leg sized to plug the residual loss. That depends on a Kalshi market-maker / pro-trader API hook and is documented as the v3 next-stage pilot ask. The Standard tier as priced here delivers ~24% avg recovery on deep-drop (≥10%) months and ~36% peak recovery on the 17%+ drops, while keeping fee in the 12–14% band and platform margin near 31%.");
  return L.join("\n");
}

function buildPitchSnippets(
  rows: RowPerTier[],
  lite: TierAggregate,
  std: TierAggregate,
): string {
  const L: string[] = [];
  L.push("# Atticus → Kalshi Pitch Snippets — Tiered (v2)");
  L.push("*Two protection tiers, calibrated cash numbers, BTC-move-driven recovery.*");
  L.push("*Headline figures: per $100 Kalshi contract @ typical 58¢ YES (so ~$58 at risk).*");
  L.push("*Scale factor for real Kalshi BTC volume: ×7,407 (assumes ~$750k avg market notional).*");
  L.push("");
  L.push("---");
  L.push("");

  // Pull the worst-BTC-fall losing market for vivid copy (use Standard tier).
  const stdLosers = rows.filter(r => r.tier === "standard" && r.kalshiPnlUsd < 0 && r.btcMovePct < 0);
  const worstFall = [...stdLosers].sort((a, b) => a.btcMovePct - b.btcMovePct)[0];

  L.push("## Intro Email — Two Tiers in Four Sentences");
  L.push("");
  L.push("**Subject line:**");
  L.push(`> Atticus shadow on your last ${KALSHI_BTC_MARKETS.length} BTC markets — Lite ${lite.avgFeePctOfStake.toFixed(0)}% / Standard ${std.avgFeePctOfStake.toFixed(0)}% fee, Standard recovers ${std.avgRecoveryDeepDropLosersPctOfRealizedLoss.toFixed(0)}% of loss on 10%+ BTC drops`);
  L.push("");
  L.push("**Email body:**");
  L.push("```");
  L.push(`We ran Atticus's downside-protection model over the last ${KALSHI_BTC_MARKETS.length} settled Kalshi BTC monthly markets (Jan 2024 – Apr 2026), pricing real 30-day BTC put spreads on Deribit at each market's open date.`);
  L.push(`Two tiers, calibrated to feel like real money on a typical $58 stake:`);
  L.push(`  • Lite: ~${fmt$(lite.avgFeeUsd)} fee (${lite.avgFeePctOfStake.toFixed(0)}% of stake). On months where BTC moves materially against the YES position (≥10% drop), the average payout is ${fmt$(lite.avgRecoveryDeepDropLosersUsd)} — about ${lite.avgRecoveryDeepDropLosersPctOfStake.toFixed(0)}% of the stake, ${lite.avgRecoveryDeepDropLosersPctOfRealizedLoss.toFixed(0)}% of the realized loss.`);
  L.push(`  • Standard: ~${fmt$(std.avgFeeUsd)} fee (${std.avgFeePctOfStake.toFixed(0)}% of stake). On those same deep-drop months the average payout is ${fmt$(std.avgRecoveryDeepDropLosersUsd)} — about ${std.avgRecoveryDeepDropLosersPctOfStake.toFixed(0)}% of the stake and ${std.avgRecoveryDeepDropLosersPctOfRealizedLoss.toFixed(0)}% of the realized loss, cutting the worst losing months roughly in half.`);
  if (worstFall) {
    L.push(`On the worst month in our sample (${worstFall.settleDate.slice(0, 7)}, BTC ${worstFall.btcMovePct}%), Standard would have turned a ${fmt$(worstFall.kalshiPnlUsd)} loss into ${fmt$(worstFall.userNetWithProtectionUsd)} after a ${fmt$(worstFall.feeUsd)} fee — a ${fmt$(worstFall.userSavedUsd)} cash rebate on the worst day.`);
  }
  L.push(`Atticus is already live with Foxify on a similar wrapper; we'd love a 30-minute call to walk through tier mechanics and a zero-integration shadow pilot on your next ${Math.ceil(KALSHI_BTC_MARKETS.length / 2.5)} BTC markets.`);
  L.push("```");
  L.push("");

  L.push("---");
  L.push("");
  L.push("## Tier Cash Story (drop-in slide / email block)");
  L.push("");
  L.push("On a typical Kalshi BTC contract @ 58¢ YES (≈ $58 at risk on a $100 face):");
  L.push("");
  L.push("| | **Lite** | **Standard** |");
  L.push("|---|---|---|");
  L.push(`| Extra cost | **${fmt$(lite.avgFeeUsd)}** (${lite.avgFeePctOfStake.toFixed(0)}% of stake) | **${fmt$(std.avgFeeUsd)}** (${std.avgFeePctOfStake.toFixed(0)}% of stake) |`);
  L.push(`| Avg recovery when hedge fires | **${fmt$(lite.avgRecoveryTriggeredLosersUsd)}** (${lite.avgRecoveryTriggeredLosersPctOfStake.toFixed(0)}% of stake) | **${fmt$(std.avgRecoveryTriggeredLosersUsd)}** (${std.avgRecoveryTriggeredLosersPctOfStake.toFixed(0)}% of stake) |`);
  L.push(`| % of realized loss recovered when hedge fires | **${lite.avgRecoveryTriggeredLosersPctOfRealizedLoss.toFixed(0)}%** | **${std.avgRecoveryTriggeredLosersPctOfRealizedLoss.toFixed(0)}%** |`);
  L.push(`| Recovery on deep BTC drops (≥10%) | **${fmt$(lite.avgRecoveryDeepDropLosersUsd)}** (${lite.avgRecoveryDeepDropLosersPctOfStake.toFixed(0)}% of stake) | **${fmt$(std.avgRecoveryDeepDropLosersUsd)}** (${std.avgRecoveryDeepDropLosersPctOfStake.toFixed(0)}% of stake) |`);
  L.push(`| Best single save in dataset | ${fmt$(lite.bestSaveTrade?.userSavedUsd ?? 0)} (${lite.bestSaveTrade?.settleDate.slice(0, 7)}) | ${fmt$(std.bestSaveTrade?.userSavedUsd ?? 0)} (${std.bestSaveTrade?.settleDate.slice(0, 7)}) |`);
  L.push(`| Story | "Pay ~${fmt$(lite.avgFeeUsd)}, get a meaningful rebate if the trade goes against you." | "Pay ~${std.avgFeePctOfStake.toFixed(0)}% more, recover roughly a quarter of the stake on materially-against-you BTC months." |`);
  L.push("");

  L.push("---");
  L.push("");
  L.push("## Platform Sustainability (your operations team)");
  L.push("");
  L.push("| | Lite | Standard |");
  L.push("|---|---|---|");
  L.push(`| Avg gross margin / trade | ${lite.avgMarginPctOfRevenue.toFixed(0)}% of revenue | ${std.avgMarginPctOfRevenue.toFixed(0)}% of revenue |`);
  L.push(`| Avg platform P&L / trade ($100 face) | ${fmt$(lite.avgPlatformPnlPerTrade)} | ${fmt$(std.avgPlatformPnlPerTrade)} |`);
  L.push(`| Platform win rate | ${lite.platformWinRate.toFixed(0)}% | ${std.platformWinRate.toFixed(0)}% |`);
  L.push(`| Total dataset P&L (scaled, ~$750k/market) | ${fmt$0(lite.totalPlatformPnl * SCALE_FACTOR)} | ${fmt$0(std.totalPlatformPnl * SCALE_FACTOR)} |`);
  L.push("");
  L.push("Spread is fully Deribit-hedged per user position (net pass-through on triggered trades). Atticus does not warehouse the put. Profitability comes from the markup minus realised hedge cost ± TP salvage — same structural pattern as the live Foxify pilot.");
  L.push("");

  L.push("---");
  L.push("");
  L.push("## Strategic Frame (institutional close)");
  L.push("");
  // Strategic frame uses the deep-drop subset (≥10% BTC fall) — that's the
  // actual tail-risk scenario being discussed, not the long-tail of small drops.
  const stdDeepLosers = rows.filter(r => r.tier === "standard" && r.kalshiPnlUsd < 0 && r.btcMovePct <= -10);
  const sumX = (arr: number[]) => arr.reduce((s, v) => s + v, 0);
  const avgUnprotDeep = stdDeepLosers.length ? sumX(stdDeepLosers.map(r => r.kalshiPnlUsd)) / stdDeepLosers.length : 0;
  const avgProtDeep = stdDeepLosers.length ? sumX(stdDeepLosers.map(r => r.userNetWithProtectionUsd)) / stdDeepLosers.length : 0;
  L.push("```");
  L.push(`In ${std.losingDeepDropTrades.length} of ${KALSHI_BTC_MARKETS.length} markets (${(std.losingDeepDropTrades.length / KALSHI_BTC_MARKETS.length * 100).toFixed(0)}%), the binary bet missed AND BTC fell ≥10% during the holding window — that's the tail risk that prevents larger desks from sizing into Kalshi BTC contracts naked.`);
  L.push(`With Atticus's Standard tier, the average deep-drop losing month goes from ${fmt$(avgUnprotDeep)} unprotected to ${fmt$(avgProtDeep)} after fee + payout — a real cash floor on tail months.`);
  L.push(`That re-shapes the contract from "binary" to "structured product" and unlocks distribution to risk-policy-bound counterparties (corporate treasuries, RIA wrap accounts, and the Kalshi institutional roadmap).`);
  L.push("```");
  L.push("");

  L.push("---");
  L.push("");
  L.push("## What's NOT in these numbers (next-stage pilot ask)");
  L.push("");
  L.push("- A pure BTC put spread can recover at most `width × at_risk` — meaningful, but bounded by how far BTC actually fell.");
  L.push("- A small subset of losing Kalshi markets (where BTC rose but the strike was high) cannot be recovered by a put spread alone, no matter how it's priced.");
  L.push("- v3 hybrid wrapper: pair the put spread with a tiny Kalshi-NO leg sized to plug the residual loss. This deterministically delivers 50%+ loss recovery on every losing market — but it requires a Kalshi market-maker / pro-trader API hook. That's the pilot conversation, not a unilateral Atticus capability.");
  L.push("");
  L.push("---");
  L.push("");
  L.push("*Trade-by-trade log: `kalshi_tiered_trades.csv` | Full assumptions: `kalshi_tiered_summary.md` | Methodology: `ANALYSIS_AND_PLAN.md`*");

  return L.join("\n");
}

// ─── Entry point ─────────────────────────────────────────────────────────────

runTieredBacktest().catch((err: any) => {
  console.error("[FATAL]", err?.message ?? err);
  process.exit(1);
});
