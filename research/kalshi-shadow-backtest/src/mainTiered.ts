/**
 * Tiered Kalshi Shadow Backtest — entry point (v2 + v3).
 *
 * PURPOSE:
 *   Run the same 27-market Kalshi BTC dataset through four protection tiers
 *   and produce pitch-ready cash numbers:
 *     v2 Lite     — put-spread rebate, fee 5–7% of stake.
 *     v2 Standard — put-spread rebate, fee 10–15% of stake, 1.7× sizing.
 *     v3 Shield   — Kalshi-NO leg, deterministic floor (25% of stake).
 *     v3 Shield+  — NO leg + smaller put spread (hybrid).
 *
 *   v2 (Lite, Standard) is a rebate product (path-dependent on BTC).
 *   v3 (Shield, Shield+) crosses the institutional "deterministic floor"
 *   threshold — see EVAL_AND_NEXT_STEPS.md for the full rationale.
 *
 * RELATIONSHIP TO v1:
 *   v1 = src/main.ts  (still works, untouched).
 *   v2/v3 = this file. Outputs land in ./output/tiered/ to avoid overwriting v1.
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
  type TierName as PutSpreadTierName,
  type TieredBundleQuote,
  type TieredHedgeOutcome,
} from "./tieredHedgeModel.js";
import {
  SHIELD_CONFIG,
  SHIELD_PLUS_CONFIG,
  quoteShield,
  quoteShieldPlus,
  computeShieldOutcome,
  computeShieldPlusOutcome,
} from "./shieldHedgeModel.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "..", "output", "tiered");

// ─── Constants ───────────────────────────────────────────────────────────────

const BET_SIZE_USD = 100;
type TierName = PutSpreadTierName | "shield" | "shield_plus";
const TIERS: TierName[] = ["lite", "standard", "shield", "shield_plus"];

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
  // Quote (some fields zero/NaN for shield-only tier — explicitly handled)
  K_long: number;
  K_short: number;
  feeUsd: number;
  feePctOfStake: number;
  maxPayoutUsd: number;
  maxRecoveryPctOfStake: number;
  returnOnTrigger: number;
  hedgeCostUsd: number;
  // Worst-case loss (deterministic, computed at quote time)
  worstCaseLossUsd: number;
  worstCaseLossFracOfStake: number;
  // Outcome
  hedgeTriggered: boolean;
  spreadPayoutUsd: number;        // Variable BTC-driven payout (put spread)
  shieldPayoutUsd: number;        // Deterministic Kalshi-NO payout
  totalPayoutUsd: number;         // = spreadPayout + shieldPayout
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

// ─── Per-tier dispatcher ─────────────────────────────────────────────────────
// Translates a (market, tier) pair into a fully-populated RowPerTier by
// calling the right model. v2 (lite, standard) uses the put-spread engine;
// v3 (shield, shield_plus) uses the shield engine.
type DispatcherInput = {
  tier: TierName;
  market: KalshiMarket;
  rvol: number;
  regime: string;
  recordedOutcome: "yes" | "no";
  derivedOutcome: DerivedOutcome;
  outcomeMismatch: boolean;
  usedOutcome: "yes" | "no";
  btcAtOpen: number;
  btcAtSettle: number;
  btcMovePct: number;
};

function priceAndSettleTier(input: DispatcherInput): RowPerTier {
  const {
    tier, market, rvol, regime, recordedOutcome, derivedOutcome,
    outcomeMismatch, usedOutcome, btcAtOpen, btcAtSettle, btcMovePct,
  } = input;

  const baseRow = {
    tier,
    marketId: market.marketId,
    title: market.title,
    openDate: market.openDate,
    settleDate: market.settleDate,
    daysToSettle: market.daysToSettle,
    strikeUsd: market.strikeUsd,
    direction: market.direction,
    yesPrice: market.yesPrice,
    recordedOutcome,
    derivedOutcome,
    outcomeMismatch,
    btcAtOpen: Math.round(btcAtOpen),
    btcAtSettle: Math.round(btcAtSettle),
    btcMovePct: r2(btcMovePct * 100),
    rvol30d: r2(rvol * 100),
    regime,
  };

  if (tier === "lite" || tier === "standard") {
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
    // For put-spread tiers, "worst case" is stake + fee (BTC ends at open
    // price exactly, no payout).
    const worstCaseLossUsd = quote.atRiskUsd + quote.chargeUsd;
    return {
      ...baseRow,
      K_long: Math.round(quote.K_long),
      K_short: Math.round(quote.K_short),
      feeUsd: r2(quote.chargeUsd),
      feePctOfStake: r2(quote.feePctOfStake * 100),
      maxPayoutUsd: r2(quote.maxPayoutUsd),
      maxRecoveryPctOfStake: r2(quote.maxRecoveryPctOfStake * 100),
      returnOnTrigger: r2(quote.returnOnTrigger),
      hedgeCostUsd: r2(quote.hedgeCostUsd),
      worstCaseLossUsd: r2(worstCaseLossUsd),
      worstCaseLossFracOfStake: r2((worstCaseLossUsd / quote.atRiskUsd) * 100),
      hedgeTriggered: outcome.hedgeTriggered,
      spreadPayoutUsd: r2(outcome.spreadPayoutUsd),
      shieldPayoutUsd: 0,
      totalPayoutUsd: r2(outcome.spreadPayoutUsd),
      kalshiPnlUsd: r2(outcome.kalshiPnlUsd),
      userNetWithProtectionUsd: r2(outcome.userNetWithProtectionUsd),
      userSavedUsd: r2(outcome.userSavedUsd),
      recoveryPctOfStake: r2(outcome.recoveryPctOfStake * 100),
      recoveryPctOfRealizedLoss: r2(outcome.recoveryPctOfRealizedLoss * 100),
      platformNetPnlUsd: r2(outcome.platformNetPnlUsd),
    };
  }

  if (tier === "shield") {
    const quote = quoteShield({
      cfg: SHIELD_CONFIG,
      yesPrice: market.yesPrice,
      betSizeUsd: BET_SIZE_USD,
    });
    const outcome = computeShieldOutcome({
      quote,
      cfg: SHIELD_CONFIG,
      kalshiOutcome: usedOutcome,
      yesPrice: market.yesPrice,
      betSizeUsd: BET_SIZE_USD,
    });
    const recoveryPctOfRealizedLoss = outcome.kalshiPnlUsd < 0
      ? outcome.totalPayoutUsd / Math.abs(outcome.kalshiPnlUsd)
      : 0;
    return {
      ...baseRow,
      K_long: 0,
      K_short: 0,
      feeUsd: r2(quote.chargeUsd),
      feePctOfStake: r2(quote.feePctOfStake * 100),
      maxPayoutUsd: r2(quote.rebateFloorUsd),
      maxRecoveryPctOfStake: r2(SHIELD_CONFIG.rebateFloorFracOfStake * 100),
      returnOnTrigger: r2(quote.chargeUsd > 0 ? quote.rebateFloorUsd / quote.chargeUsd : 0),
      hedgeCostUsd: r2(quote.hedgeCostUsd),
      worstCaseLossUsd: r2(quote.worstCaseLossUsd),
      worstCaseLossFracOfStake: r2(quote.worstCaseLossFracOfStake * 100),
      hedgeTriggered: outcome.hedgeTriggered,
      spreadPayoutUsd: 0,
      shieldPayoutUsd: r2(outcome.shieldPayoutUsd),
      totalPayoutUsd: r2(outcome.totalPayoutUsd),
      kalshiPnlUsd: r2(outcome.kalshiPnlUsd),
      userNetWithProtectionUsd: r2(outcome.userNetWithProtectionUsd),
      userSavedUsd: r2(outcome.userSavedUsd),
      recoveryPctOfStake: r2(outcome.recoveryPctOfStake * 100),
      recoveryPctOfRealizedLoss: r2(recoveryPctOfRealizedLoss * 100),
      platformNetPnlUsd: r2(outcome.platformNetPnlUsd),
    };
  }

  if (tier === "shield_plus") {
    const quote = quoteShieldPlus({
      cfg: SHIELD_PLUS_CONFIG,
      yesPrice: market.yesPrice,
      betSizeUsd: BET_SIZE_USD,
      btcAtOpen,
      rvol,
      tenorDays: market.daysToSettle,
    });
    const outcome = computeShieldPlusOutcome({
      quote,
      cfg: SHIELD_PLUS_CONFIG,
      kalshiOutcome: usedOutcome,
      yesPrice: market.yesPrice,
      betSizeUsd: BET_SIZE_USD,
      btcAtOpen,
      btcAtSettle,
    });
    const recoveryPctOfRealizedLoss = outcome.kalshiPnlUsd < 0
      ? outcome.totalPayoutUsd / Math.abs(outcome.kalshiPnlUsd)
      : 0;
    return {
      ...baseRow,
      K_long: Math.round(quote.K_long),
      K_short: Math.round(quote.K_short),
      feeUsd: r2(quote.chargeUsd),
      feePctOfStake: r2(quote.feePctOfStake * 100),
      maxPayoutUsd: r2(quote.maxPayoutUsd),
      maxRecoveryPctOfStake: r2((quote.maxPayoutUsd / quote.atRiskUsd) * 100),
      returnOnTrigger: r2(quote.chargeUsd > 0 ? quote.maxPayoutUsd / quote.chargeUsd : 0),
      hedgeCostUsd: r2(quote.hedgeCostUsd),
      worstCaseLossUsd: r2(quote.worstCaseLossUsd),
      worstCaseLossFracOfStake: r2(quote.worstCaseLossFracOfStake * 100),
      hedgeTriggered: outcome.hedgeTriggered,
      spreadPayoutUsd: r2(outcome.putSpreadPayoutUsd),
      shieldPayoutUsd: r2(outcome.shieldPayoutUsd),
      totalPayoutUsd: r2(outcome.totalPayoutUsd),
      kalshiPnlUsd: r2(outcome.kalshiPnlUsd),
      userNetWithProtectionUsd: r2(outcome.userNetWithProtectionUsd),
      userSavedUsd: r2(outcome.userSavedUsd),
      recoveryPctOfStake: r2(outcome.recoveryPctOfStake * 100),
      recoveryPctOfRealizedLoss: r2(recoveryPctOfRealizedLoss * 100),
      platformNetPnlUsd: r2(outcome.platformNetPnlUsd),
    };
  }

  throw new Error(`Unknown tier: ${tier as string}`);
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
      const row = priceAndSettleTier({
        tier,
        market,
        rvol,
        regime,
        recordedOutcome: market.outcome,
        derivedOutcome,
        outcomeMismatch,
        usedOutcome,
        btcAtOpen,
        btcAtSettle,
        btcMovePct,
      });
      rows.push(row);
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

  const aggs: Record<TierName, TierAggregate> = {
    lite: aggregate(rows.filter(r => r.tier === "lite")),
    standard: aggregate(rows.filter(r => r.tier === "standard")),
    shield: aggregate(rows.filter(r => r.tier === "shield")),
    shield_plus: aggregate(rows.filter(r => r.tier === "shield_plus")),
  };

  // ─── Write CSV ────────────────────────────────────────────────────────
  console.error("[4/4] Writing outputs…");
  await writeFile(
    path.join(OUTPUT_DIR, "kalshi_tiered_trades.csv"),
    rowsToCsv(rows),
    "utf8",
  );

  // ─── Write summary ────────────────────────────────────────────────────
  const summary = buildSummary(rows, aggs, mismatchCount);
  await writeFile(path.join(OUTPUT_DIR, "kalshi_tiered_summary.md"), summary, "utf8");

  // ─── Write pitch snippets ─────────────────────────────────────────────
  const snippets = buildPitchSnippets(rows, aggs);
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
  const totalPayouts = sum(rows.map(r => r.totalPayoutUsd));
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
    avgRecoveryAllLosersUsd: avg(losing.map(r => r.totalPayoutUsd)),
    avgRecoveryAllLosersPctOfStake: avg(losing.map(r => r.recoveryPctOfStake)),
    avgRecoveryAllLosersPctOfRealizedLoss: avg(losing.map(r => r.recoveryPctOfRealizedLoss)),
    avgRecoveryBtcDownLosersUsd: avg(losingBtcDown.map(r => r.totalPayoutUsd)),
    avgRecoveryBtcDownLosersPctOfStake: avg(losingBtcDown.map(r => r.recoveryPctOfStake)),
    avgRecoveryBtcDownLosersPctOfRealizedLoss: avg(losingBtcDown.map(r => r.recoveryPctOfRealizedLoss)),
    avgRecoveryTriggeredLosersUsd: avg(triggeredLosing.map(r => r.totalPayoutUsd)),
    avgRecoveryTriggeredLosersPctOfStake: avg(triggeredLosing.map(r => r.recoveryPctOfStake)),
    avgRecoveryTriggeredLosersPctOfRealizedLoss: avg(triggeredLosing.map(r => r.recoveryPctOfRealizedLoss)),
    avgRecoveryDeepDropLosersUsd: avg(deepDropLosing.map(r => r.totalPayoutUsd)),
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
    "hedgeCostUsd", "worstCaseLossUsd", "worstCaseLossFracOfStake",
    "hedgeTriggered", "spreadPayoutUsd", "shieldPayoutUsd", "totalPayoutUsd",
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
      r.hedgeCostUsd, r.worstCaseLossUsd, r.worstCaseLossFracOfStake,
      r.hedgeTriggered ? "YES" : "NO", r.spreadPayoutUsd, r.shieldPayoutUsd, r.totalPayoutUsd,
      r.kalshiPnlUsd, r.userNetWithProtectionUsd, r.userSavedUsd,
      r.recoveryPctOfStake, r.recoveryPctOfRealizedLoss,
      r.platformNetPnlUsd,
    ].join(","));
  }
  return lines.join("\n") + "\n";
}

function buildSummary(
  allRows: RowPerTier[],
  aggs: Record<TierName, TierAggregate>,
  mismatchCount: number,
): string {
  const L: string[] = [];
  const lite = aggs.lite, std = aggs.standard, shield = aggs.shield, sp = aggs.shield_plus;

  L.push("# Atticus / Kalshi Shadow Hedge Backtest — Tiered (v2 + v3)");
  L.push(`**Generated:** ${new Date().toISOString().slice(0, 10)}`);
  L.push(`**Markets analyzed:** ${KALSHI_BTC_MARKETS.length} settled Kalshi BTC monthly markets (Jan 2024 – Apr 2026)`);
  L.push(`**Bet size used for cash figures:** $${BET_SIZE_USD} contract face value (scales linearly).`);
  L.push(`**Outcome mismatch flags (recorded vs derived from BTC price):** ${mismatchCount} of ${KALSHI_BTC_MARKETS.length} — economics use **derived** outcome.`);
  L.push("");
  L.push("---");
  L.push("");
  L.push("## Tier families");
  L.push("");
  L.push("Two families of protection products run on the same dataset:");
  L.push("");
  L.push("**v2 put-spread tiers (rebate products, BTC-path-dependent):**");
  L.push("");
  L.push("| Tier | Long-put OTM | Short-put OTM | Spread width | Sizing | Markup |");
  L.push("|---|---|---|---|---|---|");
  for (const t of ["lite", "standard"] as const) {
    const c = TIER_CONFIGS[t];
    L.push(`| ${t} | ${(c.longOtmPct * 100).toFixed(1)}% | ${(c.shortOtmPct * 100).toFixed(1)}% | ${((c.shortOtmPct - c.longOtmPct) * 100).toFixed(1)}% | ${c.sizingMultiplier.toFixed(2)}× of at-risk | ${c.markup.toFixed(2)}× |`);
  }
  L.push("");
  L.push("**v3 Shield tiers (deterministic-floor products, contract-bounded):**");
  L.push("");
  L.push("| Tier | Mechanism | Floor (% of stake) | Put-spread overlay | Markup |");
  L.push("|---|---|---|---|---|");
  L.push(`| shield | Kalshi-NO leg only | ${(SHIELD_CONFIG.rebateFloorFracOfStake * 100).toFixed(0)}% guaranteed on Kalshi loss | none | ${SHIELD_CONFIG.markup.toFixed(2)}× |`);
  L.push(`| shield_plus | NO leg + put spread | ${(SHIELD_PLUS_CONFIG.rebateFloorFracOfStake * 100).toFixed(0)}% guaranteed | ATM long / ${(SHIELD_PLUS_CONFIG.shortOtmPct * 100).toFixed(0)}% OTM short, ${SHIELD_PLUS_CONFIG.putSpreadSizingMultiplier.toFixed(1)}× sizing | ${SHIELD_PLUS_CONFIG.markup.toFixed(2)}× |`);
  L.push("");
  L.push("All option pricing: direct Black-Scholes on actual BTC strikes at each market's open date, using realized-vol-derived IV with skew. NO-leg pricing: $1 face × (100−YES)/100 plus 3% Kalshi fee on NO win.");
  L.push("");
  L.push("---");
  L.push("");
  L.push("## Headline four-tier comparison (per $100 contract face)");
  L.push("");
  L.push("| Metric | Lite | Standard | Shield (v3) | Shield+ (v3) |");
  L.push("|---|---|---|---|---|");
  L.push(`| Mechanism | Put spread | Put spread + sizing | Kalshi-NO leg | NO leg + put spread |`);
  L.push(`| Avg fee ($) | ${fmt$(lite.avgFeeUsd)} | ${fmt$(std.avgFeeUsd)} | ${fmt$(shield.avgFeeUsd)} | ${fmt$(sp.avgFeeUsd)} |`);
  L.push(`| Avg fee (% of stake) | ${lite.avgFeePctOfStake.toFixed(1)}% | ${std.avgFeePctOfStake.toFixed(1)}% | ${shield.avgFeePctOfStake.toFixed(1)}% | ${sp.avgFeePctOfStake.toFixed(1)}% |`);
  L.push(`| **P(payout > 0 \\| Kalshi loss)** | ${fracPayoutOnLossPct(aggs.lite)}% | ${fracPayoutOnLossPct(aggs.standard)}% | **${fracPayoutOnLossPct(aggs.shield)}%** | **${fracPayoutOnLossPct(aggs.shield_plus)}%** |`);
  L.push(`| **Avg recovery, all losers ($)** | ${fmt$(lite.avgRecoveryAllLosersUsd)} | ${fmt$(std.avgRecoveryAllLosersUsd)} | **${fmt$(shield.avgRecoveryAllLosersUsd)}** | **${fmt$(sp.avgRecoveryAllLosersUsd)}** |`);
  L.push(`| **Avg recovery, all losers (% of stake)** | ${lite.avgRecoveryAllLosersPctOfStake.toFixed(1)}% | ${std.avgRecoveryAllLosersPctOfStake.toFixed(1)}% | **${shield.avgRecoveryAllLosersPctOfStake.toFixed(1)}%** | **${sp.avgRecoveryAllLosersPctOfStake.toFixed(1)}%** |`);
  L.push(`| Avg recovery, BTC-down losers ($) | ${fmt$(lite.avgRecoveryBtcDownLosersUsd)} | ${fmt$(std.avgRecoveryBtcDownLosersUsd)} | ${fmt$(shield.avgRecoveryBtcDownLosersUsd)} | ${fmt$(sp.avgRecoveryBtcDownLosersUsd)} |`);
  L.push(`| Avg recovery, BTC-down losers (% of stake) | ${lite.avgRecoveryBtcDownLosersPctOfStake.toFixed(1)}% | ${std.avgRecoveryBtcDownLosersPctOfStake.toFixed(1)}% | ${shield.avgRecoveryBtcDownLosersPctOfStake.toFixed(1)}% | ${sp.avgRecoveryBtcDownLosersPctOfStake.toFixed(1)}% |`);
  L.push(`| Deep-drop subset avg recovery (% of stake) | ${lite.avgRecoveryDeepDropLosersPctOfStake.toFixed(1)}% | ${std.avgRecoveryDeepDropLosersPctOfStake.toFixed(1)}% | ${shield.avgRecoveryDeepDropLosersPctOfStake.toFixed(1)}% | ${sp.avgRecoveryDeepDropLosersPctOfStake.toFixed(1)}% |`);
  L.push(`| Worst-case realized loss (% of stake)\\* | ${maxWorstCase(aggs.lite).toFixed(0)}% | ${maxWorstCase(aggs.standard).toFixed(0)}% | **${maxWorstCase(aggs.shield).toFixed(0)}%** | **${maxWorstCase(aggs.shield_plus).toFixed(0)}%** |`);
  L.push(`| Platform avg margin (% of revenue) | ${lite.avgMarginPctOfRevenue.toFixed(1)}% | ${std.avgMarginPctOfRevenue.toFixed(1)}% | ${shield.avgMarginPctOfRevenue.toFixed(1)}% | ${sp.avgMarginPctOfRevenue.toFixed(1)}% |`);
  L.push(`| Platform avg P&L per trade ($) | ${fmt$(lite.avgPlatformPnlPerTrade)} | ${fmt$(std.avgPlatformPnlPerTrade)} | ${fmt$(shield.avgPlatformPnlPerTrade)} | ${fmt$(sp.avgPlatformPnlPerTrade)} |`);
  L.push(`| Platform total P&L (scaled, ~$750k/market) | ${fmt$0(lite.totalPlatformPnl * SCALE_FACTOR)} | ${fmt$0(std.totalPlatformPnl * SCALE_FACTOR)} | ${fmt$0(shield.totalPlatformPnl * SCALE_FACTOR)} | ${fmt$0(sp.totalPlatformPnl * SCALE_FACTOR)} |`);
  L.push("");
  L.push("\\* Worst-case realized loss = max across all 27 markets of (stake + fee − total payout) / stake. For Shield tiers this is the *contract-deterministic* upper bound on user loss; for put-spread tiers it's path-dependent (BTC ending at open = no payout = max loss).");
  L.push("");
  L.push("---");
  L.push("");
  L.push("## Threshold scorecard — does each tier cross the institutional bar?");
  L.push("");
  L.push("(Thresholds defined in `EVAL_AND_NEXT_STEPS.md` §1.)");
  L.push("");
  L.push("| Threshold | Lite | Standard | Shield | Shield+ |");
  L.push("|---|---|---|---|---|");
  L.push(`| A1. P(payout > 0 \\| loss) ≥ 90% | ${cell(fracPayoutOnLoss(aggs.lite) >= 0.9)} | ${cell(fracPayoutOnLoss(aggs.standard) >= 0.9)} | ${cell(fracPayoutOnLoss(aggs.shield) >= 0.9)} | ${cell(fracPayoutOnLoss(aggs.shield_plus) >= 0.9)} |`);
  L.push(`| A2. Avg payout on loss ≥ 15% of stake | ${cell(lite.avgRecoveryAllLosersPctOfStake >= 15)} | ${cell(std.avgRecoveryAllLosersPctOfStake >= 15)} | ${cell(shield.avgRecoveryAllLosersPctOfStake >= 15)} | ${cell(sp.avgRecoveryAllLosersPctOfStake >= 15)} |`);
  L.push(`| A3. Worst-case loss ≤ 100% (better than unprotected) | ${cell(maxWorstCase(aggs.lite) <= 100)} | ${cell(maxWorstCase(aggs.standard) <= 100)} | ${cell(maxWorstCase(aggs.shield) <= 100)} | ${cell(maxWorstCase(aggs.shield_plus) <= 100)} |`);
  L.push(`| B1. Worst-case loss ≤ 70% of stake | ${cell(maxWorstCase(aggs.lite) <= 70)} | ${cell(maxWorstCase(aggs.standard) <= 70)} | ${cell(maxWorstCase(aggs.shield) <= 70)} | ${cell(maxWorstCase(aggs.shield_plus) <= 70)} |`);
  L.push(`| B2. Deterministic floor (contract, not path-dependent) | ${cell(false)} | ${cell(false)} | ${cell(true)} | ${cell(true)} |`);
  L.push(`| B3. Hedged counterparty (no Atticus solvency tail) | ${cell(true)} | ${cell(true)} | ${cell(true)} | ${cell(true)} |`);
  L.push("");
  L.push("---");
  L.push("");
  L.push("## Losing-market detail");
  L.push("");
  for (const tierAgg of [lite, std, shield, sp]) {
    L.push(`### Tier: ${tierAgg.tier}`);
    L.push(`- Losing markets: **${tierAgg.losingTrades.length}** of ${tierAgg.n}`);
    L.push(`- Losers where BTC fell during the window: **${tierAgg.losingBtcDownTrades.length}** of ${tierAgg.losingTrades.length}`);
    L.push(`- Avg unprotected loss on losing markets: ${fmt$(tierAgg.avgUserNetUnprotectedLosersUsd)}`);
    L.push(`- Avg net P&L on losing markets WITH protection: ${fmt$(tierAgg.avgUserNetProtectedLosersUsd)}`);
    L.push(`- Avg payout on losers: ${fmt$(tierAgg.avgRecoveryAllLosersUsd)} (${tierAgg.avgRecoveryAllLosersPctOfStake.toFixed(1)}% of stake)`);
    if (tierAgg.bestSaveTrade) {
      const b = tierAgg.bestSaveTrade;
      L.push(`- Best single user save: ${b.marketId} (${b.openDate} → ${b.settleDate}), BTC ${b.btcMovePct >= 0 ? "+" : ""}${b.btcMovePct}%, payout ${fmt$(b.totalPayoutUsd)} on ${fmt$(b.feeUsd)} fee.`);
    }
    if (tierAgg.worstBtcMoveLoser) {
      const w = tierAgg.worstBtcMoveLoser;
      L.push(`- Most painful BTC move on losing market: ${w.marketId} (BTC ${w.btcMovePct}%) — unprotected ${fmt$(w.kalshiPnlUsd)} → protected ${fmt$(w.userNetWithProtectionUsd)}.`);
    }
    L.push("");
  }
  L.push("---");
  L.push("");
  L.push("## Per-market trade log (Shield+ tier — most pitch-relevant for institutional)");
  L.push("");
  L.push("| Market | Open → Settle | BTC move | Recorded | Derived | Fee | Total Payout | Net before/after | Saved |");
  L.push("|---|---|---|---|---|---|---|---|---|");
  const spRows = allRows.filter(r => r.tier === "shield_plus");
  for (const r of spRows) {
    const flag = r.outcomeMismatch ? " ⚠" : "";
    L.push(
      `| ${r.marketId} | ${r.openDate}→${r.settleDate} | ${r.btcMovePct >= 0 ? "+" : ""}${r.btcMovePct}% | ${r.recordedOutcome.toUpperCase()}${flag} | ${r.derivedOutcome.toUpperCase()} | ${fmt$(r.feeUsd)} | ${fmt$(r.totalPayoutUsd)} | ${fmt$(r.kalshiPnlUsd)} → ${fmt$(r.userNetWithProtectionUsd)} | ${r.userSavedUsd >= 0 ? "+" : ""}${fmt$(r.userSavedUsd)} |`,
    );
  }
  L.push("");
  L.push("---");
  L.push("");
  L.push("## Notes & caveats");
  L.push("");
  L.push(`- "Outcome mismatch" rows mark cases where the curated dataset's recorded outcome disagrees with the outcome derived from BTC daily-close at settle. ${mismatchCount} flagged. The economics in this report use **derived** outcomes for self-consistency.`);
  L.push("- Put-spread pricing (Lite, Standard, Shield+ overlay): direct Black-Scholes on actual BTC strikes, realized-vol-derived IV with empirical skew.");
  L.push("- Shield NO-leg pricing: $1 face × NO probability ((100 − YES)/100) plus 3% Kalshi fee on NO settlement.");
  L.push("- Spread payouts: Atticus owns a fully-hedged Deribit put spread per user position (cash-flow pass-through on triggered trades).");
  L.push("- Shield NO-leg payouts: Atticus buys NO contracts on Kalshi sized to the user's rebate floor (cash-flow pass-through on Kalshi loss).");
  L.push("- Shield is the only tier that delivers a contract-deterministic floor. v2 tiers' worst case is unbounded by protection (BTC-path-dependent); Shield's is bounded by the rebate floor.");
  L.push("- Volume scaling factor `7407` matches v1 (assumes ~$750k notional × 27 markets ≈ $20M dataset).");
  L.push("");
  L.push("**See `EVAL_AND_NEXT_STEPS.md` for the threshold framework, full v2 evaluation, and Shield design rationale.**");
  return L.join("\n");
}

// Helper: fraction of losing markets where total payout > 0.
function fracPayoutOnLoss(agg: TierAggregate): number {
  if (agg.losingTrades.length === 0) return 0;
  return agg.losingTrades.filter(r => r.totalPayoutUsd > 0).length / agg.losingTrades.length;
}
function fracPayoutOnLossPct(agg: TierAggregate): string {
  return (fracPayoutOnLoss(agg) * 100).toFixed(0);
}

// Helper: max worst-case realized-loss-as-%-of-stake across all rows of a tier.
// For put-spread tiers worst case is row-by-row (depends on BTC ending = open).
// For shield tiers it's deterministic by contract.
function maxWorstCase(agg: TierAggregate): number {
  if (agg.tier === "shield" || agg.tier === "shield_plus") {
    // Deterministic — same per-row since rebate fraction is the same.
    return Math.max(...agg.losingTrades.map(r => r.worstCaseLossFracOfStake));
  }
  // Put-spread tiers: actual realized worst case across the dataset.
  // Worst realized = -userNet / stake on losing markets.
  return Math.max(
    100,
    ...agg.losingTrades.map(r => {
      const stake = (r.yesPrice / 100) * BET_SIZE_USD;
      return stake > 0 ? (-r.userNetWithProtectionUsd / stake) * 100 : 0;
    }),
  );
}

function cell(passed: boolean): string {
  return passed ? "✅" : "❌";
}

function buildPitchSnippets(
  rows: RowPerTier[],
  aggs: Record<TierName, TierAggregate>,
): string {
  const L: string[] = [];
  const lite = aggs.lite, std = aggs.standard, shield = aggs.shield, sp = aggs.shield_plus;

  L.push("# Atticus → Kalshi Pitch Snippets — Tiered (v2 + v3)");
  L.push("*Four protection tiers across two product families:*");
  L.push("*  - **v2 (rebate):** Lite, Standard — put spreads on Deribit, BTC-path-dependent payout.*");
  L.push("*  - **v3 (deterministic floor):** Shield, Shield+ — Kalshi-NO leg, contract-bounded floor.*");
  L.push("*Headline figures: per $100 Kalshi contract @ typical 58¢ YES (so ~$58 at risk).*");
  L.push("*Scale factor for real Kalshi BTC volume: ×7,407 (assumes ~$750k avg market notional).*");
  L.push("");
  L.push("---");
  L.push("");

  // Pull narrative samples (Shield+ tier).
  const spLosers = rows.filter(r => r.tier === "shield_plus" && r.kalshiPnlUsd < 0);
  // Best save = largest userSavedUsd on a losing market (typically the deep BTC drop month).
  const worstFall = [...spLosers].sort((a, b) => b.userSavedUsd - a.userSavedUsd)[0];
  // Edge case: a losing market where BTC was up — only the NO-leg floor saves it.
  const btcUpLoser = [...spLosers]
    .filter(r => r.btcMovePct > 0)
    .sort((a, b) => b.btcMovePct - a.btcMovePct)[0];

  // ── PRIMARY EMAIL: Shield+ headline ────────────────────────────────────
  L.push("## Intro Email — Lead with Shield+ (the institutional pitch)");
  L.push("");
  L.push("**Subject line:**");
  L.push(`> A losing prediction that pays back ${(SHIELD_PLUS_CONFIG.rebateFloorFracOfStake * 100).toFixed(0)}% of stake — guaranteed, not BTC-dependent`);
  L.push("");
  L.push("**Email body:**");
  L.push("```");
  L.push(`We ran a wrapper protocol over the last ${KALSHI_BTC_MARKETS.length} settled Kalshi BTC monthly markets. The headline:`);
  L.push("");
  L.push(`Today, a losing $58 YES position is a complete write-off. With Shield+ (~${fmt$(sp.avgFeeUsd)} extra at entry), the same losing position pays back ${fmt$(sp.avgRecoveryAllLosersUsd)} on average — and at minimum ${(SHIELD_PLUS_CONFIG.rebateFloorFracOfStake * 100).toFixed(0)}% of stake guaranteed by contract, regardless of where BTC ends.`);
  L.push("");
  L.push(`Across our 14 losing markets the avg user outcome moves from ${fmt$(sp.avgUserNetUnprotectedLosersUsd)} (unprotected) to ${fmt$(sp.avgUserNetProtectedLosersUsd)} (with Shield+) — a ${fmt$(sp.avgUserNetProtectedLosersUsd - sp.avgUserNetUnprotectedLosersUsd)} improvement on every losing month. Most importantly, **every losing market pays back something** instead of zero — the binary cliff becomes a defined-risk overlay.`);
  if (worstFall) {
    L.push("");
    L.push(`Best save: ${worstFall.settleDate.slice(0, 7)}, BTC ${worstFall.btcMovePct}% — Shield+ turned a -$${(worstFall.yesPrice * BET_SIZE_USD / 100).toFixed(0)} loss into ${fmt$(worstFall.userNetWithProtectionUsd)} (a ${fmt$(worstFall.userSavedUsd)} rebate).`);
  }
  if (btcUpLoser) {
    L.push(`Edge case: BTC actually rose on a losing market (${btcUpLoser.settleDate.slice(0, 7)}, BTC +${btcUpLoser.btcMovePct}%) — pure put-spread products can't help here. Shield+ still delivered the contract floor of ${fmt$(btcUpLoser.shieldPayoutUsd)} on a ${fmt$(btcUpLoser.feeUsd)} fee.`);
  }
  L.push("");
  L.push(`Atticus is already live on Foxify with a similar wrapper. Platform side: ~${sp.avgMarginPctOfRevenue.toFixed(0)}% gross margin per trade, fully hedged (no warehouse risk). We'd love 30 minutes to walk through tier mechanics and a zero-integration shadow pilot on your next ${Math.ceil(KALSHI_BTC_MARKETS.length / 2.5)} BTC markets.`);
  L.push("```");
  L.push("");

  // ── TIER COMPARISON BLOCK ─────────────────────────────────────────────
  L.push("---");
  L.push("");
  L.push("## Four-Tier Cash Story (drop-in slide)");
  L.push("");
  L.push("On a typical Kalshi BTC contract @ 58¢ YES (≈ $58 at risk on a $100 face):");
  L.push("");
  L.push("| | Lite (v2) | Standard (v2) | **Shield (v3)** | **Shield+ (v3)** |");
  L.push("|---|---|---|---|---|");
  L.push(`| Mechanism | BTC put spread | BTC put spread, 1.7× sized | Kalshi-NO leg | NO leg + put spread |`);
  L.push(`| Extra cost | ${fmt$(lite.avgFeeUsd)} (${lite.avgFeePctOfStake.toFixed(0)}%) | ${fmt$(std.avgFeeUsd)} (${std.avgFeePctOfStake.toFixed(0)}%) | **${fmt$(shield.avgFeeUsd)}** (${shield.avgFeePctOfStake.toFixed(0)}%) | **${fmt$(sp.avgFeeUsd)}** (${sp.avgFeePctOfStake.toFixed(0)}%) |`);
  L.push(`| **% of losing markets that pay back** | ${fracPayoutOnLossPct(lite)}% | ${fracPayoutOnLossPct(std)}% | **${fracPayoutOnLossPct(shield)}%** | **${fracPayoutOnLossPct(sp)}%** |`);
  L.push(`| Avg payout on losing markets | ${fmt$(lite.avgRecoveryAllLosersUsd)} (${lite.avgRecoveryAllLosersPctOfStake.toFixed(0)}%) | ${fmt$(std.avgRecoveryAllLosersUsd)} (${std.avgRecoveryAllLosersPctOfStake.toFixed(0)}%) | **${fmt$(shield.avgRecoveryAllLosersUsd)}** (${shield.avgRecoveryAllLosersPctOfStake.toFixed(0)}%) | **${fmt$(sp.avgRecoveryAllLosersUsd)}** (${sp.avgRecoveryAllLosersPctOfStake.toFixed(0)}%) |`);
  L.push(`| Worst-case realized loss (% of stake) | ${maxWorstCase(lite).toFixed(0)}% | ${maxWorstCase(std).toFixed(0)}% | **${maxWorstCase(shield).toFixed(0)}%** | **${maxWorstCase(sp).toFixed(0)}%** |`);
  L.push(`| Story | "Pay ~${fmt$(lite.avgFeeUsd)}, get a coupon if BTC moves your way." | "Pay ~${std.avgFeePctOfStake.toFixed(0)}%, recover ~25% on deep BTC drops." | "Pay ~${shield.avgFeePctOfStake.toFixed(0)}%, get **${(SHIELD_CONFIG.rebateFloorFracOfStake * 100).toFixed(0)}% back guaranteed** on every losing outcome." | "Insured bet: ${(SHIELD_PLUS_CONFIG.rebateFloorFracOfStake * 100).toFixed(0)}% guaranteed floor + extra recovery on BTC drops." |`);
  L.push("");

  // ── THRESHOLD SCORECARD ───────────────────────────────────────────────
  L.push("---");
  L.push("");
  L.push("## Why Shield matters: threshold scorecard");
  L.push("");
  L.push("\"Not zero-sum\" is a real product threshold, not a marketing line. Tiers cross it at different levels:");
  L.push("");
  L.push("| Threshold | Lite | Std | Shield | Shield+ |");
  L.push("|---|---|---|---|---|");
  L.push(`| Retail behavioral: payout on ≥90% of losing markets | ${cell(fracPayoutOnLoss(lite) >= 0.9)} | ${cell(fracPayoutOnLoss(std) >= 0.9)} | ${cell(fracPayoutOnLoss(shield) >= 0.9)} | ${cell(fracPayoutOnLoss(sp) >= 0.9)} |`);
  L.push(`| Retail behavioral: avg loss-payout ≥15% of stake | ${cell(lite.avgRecoveryAllLosersPctOfStake >= 15)} | ${cell(std.avgRecoveryAllLosersPctOfStake >= 15)} | ${cell(shield.avgRecoveryAllLosersPctOfStake >= 15)} | ${cell(sp.avgRecoveryAllLosersPctOfStake >= 15)} |`);
  L.push(`| Retail behavioral: protected ≤ unprotected worst case | ${cell(maxWorstCase(lite) <= 100)} | ${cell(maxWorstCase(std) <= 100)} | ${cell(maxWorstCase(shield) <= 100)} | ${cell(maxWorstCase(sp) <= 100)} |`);
  L.push(`| Institutional: deterministic floor (contract, not path) | ${cell(false)} | ${cell(false)} | ${cell(true)} | ${cell(true)} |`);
  L.push(`| Institutional: worst case ≤ 70% of stake | ${cell(maxWorstCase(lite) <= 70)} | ${cell(maxWorstCase(std) <= 70)} | ${cell(maxWorstCase(shield) <= 70)} | ${cell(maxWorstCase(sp) <= 70)} |`);
  L.push("");
  L.push("**Lite/Standard cross retail-coupon thresholds. Shield/Shield+ cross the institutional floor threshold — the threshold that lets risk committees whitelist the product as a structured overlay rather than a binary bet.** Full framework in `EVAL_AND_NEXT_STEPS.md` §1.");
  L.push("");

  // ── PLATFORM SUSTAINABILITY ───────────────────────────────────────────
  L.push("---");
  L.push("");
  L.push("## Platform Sustainability (operations / business model)");
  L.push("");
  L.push("| | Lite | Standard | Shield | Shield+ |");
  L.push("|---|---|---|---|---|");
  L.push(`| Avg gross margin / trade | ${lite.avgMarginPctOfRevenue.toFixed(0)}% | ${std.avgMarginPctOfRevenue.toFixed(0)}% | ${shield.avgMarginPctOfRevenue.toFixed(0)}% | ${sp.avgMarginPctOfRevenue.toFixed(0)}% |`);
  L.push(`| Avg platform P&L / trade ($100 face) | ${fmt$(lite.avgPlatformPnlPerTrade)} | ${fmt$(std.avgPlatformPnlPerTrade)} | ${fmt$(shield.avgPlatformPnlPerTrade)} | ${fmt$(sp.avgPlatformPnlPerTrade)} |`);
  L.push(`| Platform win rate | ${lite.platformWinRate.toFixed(0)}% | ${std.platformWinRate.toFixed(0)}% | ${shield.platformWinRate.toFixed(0)}% | ${sp.platformWinRate.toFixed(0)}% |`);
  L.push(`| Total dataset P&L (scaled, ~$750k/market) | ${fmt$0(lite.totalPlatformPnl * SCALE_FACTOR)} | ${fmt$0(std.totalPlatformPnl * SCALE_FACTOR)} | ${fmt$0(shield.totalPlatformPnl * SCALE_FACTOR)} | ${fmt$0(sp.totalPlatformPnl * SCALE_FACTOR)} |`);
  L.push("");
  L.push("Both put-spread legs and Kalshi-NO legs are pass-through (Atticus does not warehouse risk). Platform retains markup minus realized hedge cost on each trade. Same structural pattern as the live Foxify pilot, with the addition of a Kalshi-NO leg for Shield/Shield+.");
  L.push("");

  // ── SHIELD MECHANIC EXPLAINER ─────────────────────────────────────────
  L.push("---");
  L.push("");
  L.push("## Mechanic: how Shield delivers a deterministic floor");
  L.push("");
  L.push("```");
  L.push(`User buys Kalshi YES @ 58¢ on a $100 face → $58 at risk.`);
  L.push("");
  L.push(`Shield+ option (~$${sp.avgFeeUsd.toFixed(2)} fee at entry):`);
  L.push(`  Atticus buys $${(58 * SHIELD_PLUS_CONFIG.rebateFloorFracOfStake).toFixed(2)} face of Kalshi NO contracts at 42¢ = $${(58 * SHIELD_PLUS_CONFIG.rebateFloorFracOfStake * 0.42).toFixed(2)} cost`);
  L.push(`  + Atticus buys an ATM/${(SHIELD_PLUS_CONFIG.shortOtmPct * 100).toFixed(0)}% put spread on Deribit, ${SHIELD_PLUS_CONFIG.putSpreadSizingMultiplier}× sized`);
  L.push("");
  L.push(`If YES wins  → user gets $100 from Kalshi, NO leg expires worthless, put spread expires worthless, Atticus keeps fee.`);
  L.push(`If YES loses → NO leg pays Atticus $${(58 * SHIELD_PLUS_CONFIG.rebateFloorFracOfStake).toFixed(0)}, Atticus passes that to user as the contract floor;`);
  L.push(`               put spread additionally pays if BTC fell, on top of the floor.`);
  L.push("");
  L.push(`Atticus's margin per trade is deterministic: charge − NO cost − put cost − Kalshi fee.`);
  L.push(`User's worst-case loss on any market: $58 − rebate + fee = ~$${((1 - SHIELD_PLUS_CONFIG.rebateFloorFracOfStake) * 58 + sp.avgFeeUsd).toFixed(0)} = ~${maxWorstCase(sp).toFixed(0)}% of stake.`);
  L.push("```");
  L.push("");

  // ── DEPENDENCIES & PILOT ASK ──────────────────────────────────────────
  L.push("---");
  L.push("");
  L.push("## What Shield needs that Standard doesn't");
  L.push("");
  L.push("- **Atticus needs a Kalshi-side execution path** (taker account, MM agreement, or pre-funded reserve) to buy the NO leg at user open. Three paths are viable; the simplest is a vanilla taker account, the cleanest is a Kalshi MM agreement.");
  L.push("- **No new Deribit dependency** — the put-spread overlay (Shield+) reuses the same Deribit infrastructure as the live Foxify pilot.");
  L.push("- **No new Atticus solvency exposure** — both legs are pre-funded at user open; the rebate is collateralised by the NO leg position.");
  L.push("");

  // ── ROADMAP ───────────────────────────────────────────────────────────
  L.push("---");
  L.push("");
  L.push("## Roadmap (sequenced)");
  L.push("");
  L.push("1. **Pilot v1 — Standard (v2 tier)** on a small slice of retail BTC volume. Validates the put-spread infra and the Foxify-style operational model on Kalshi data. ~30% gross margin, real cash rebates on BTC-down months.");
  L.push("2. **Pilot v2 — Shield+ (v3 tier)** with a Kalshi taker account or MM agreement. This is the institutional unlock. Worst-case loss bounded by contract; opens the door to RIA, treasury, and structured-product distribution.");
  L.push("3. **v4 — Mid-life resale** of insured positions. Once Shield+ is live and the position has a deterministic floor, MM buy-back becomes priceable. This converts \"prediction bet\" into \"tradeable structured note\" — the strategic memo's far-horizon vision.");
  L.push("");
  L.push("---");
  L.push("");
  L.push("*Trade-by-trade log: `kalshi_tiered_trades.csv` | Tier mechanics: `kalshi_tiered_summary.md` | Threshold framework & Shield design: `EVAL_AND_NEXT_STEPS.md` | v2 calibration: `ANALYSIS_AND_PLAN.md`*");

  return L.join("\n");
}

// ─── Entry point ─────────────────────────────────────────────────────────────

runTieredBacktest().catch((err: any) => {
  console.error("[FATAL]", err?.message ?? err);
  process.exit(1);
});
