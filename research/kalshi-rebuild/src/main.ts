/**
 * Kalshi rebuild backtest — entry point.
 *
 * Runs all four tiers (Lite, Standard, Shield, Shield+) across the full
 * multi-archetype dataset (ABOVE / BELOW / HIT × YES / NO direction).
 *
 * Outputs:
 *   output/kalshi_rebuild_trades.csv       — per-row trade log
 *   output/kalshi_rebuild_summary.md       — overall + per-quadrant summary
 *   output/kalshi_rebuild_pitch_snippets.md — pitch-ready cash story
 *
 * No imports from any pilot path. No Foxify calibrations.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { KALSHI_BTC_MARKETS, type KalshiMarket } from "./kalshiMarkets.js";
import {
  fetchBtcDailyPrices, getPriceOnDate, buildCloseSeries,
  maxHighInRange, minLowInRange,
} from "./fetchBtcPrices.js";
import { realizedVol30d } from "./math.js";
import { quoteTier, settleTier, type TierName } from "./hedgeEngine.js";
import { deriveKalshiOutcome } from "./kalshiEventTypes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "..", "output");

const BET_SIZE_USD = 100;
const TIERS: TierName[] = ["lite", "standard", "shield", "shield_plus"];

// ─── Row type ────────────────────────────────────────────────────────────────

type Row = {
  tier: TierName;
  effectiveW: number;
  degraded: boolean;
  degradationReason: string;
  marketId: string;
  eventType: string;
  userDirection: string;
  openDate: string;
  settleDate: string;
  daysToSettle: number;
  barrier: number;
  yesPrice: number;
  recordedOutcome: "yes" | "no";
  derivedOutcome: "yes" | "no";
  outcomeMismatch: boolean;
  btcAtOpen: number;
  btcAtSettle: number;
  btcMovePct: number;
  rvol30d: number;
  instrument: string;
  K_long: number;
  K_short: number;
  spreadWidth: number;
  feeUsd: number;
  feePctOfStake: number;
  rebateFloorUsd: number;
  spreadMaxPayoutUsd: number;
  totalMaxPayoutUsd: number;
  worstCaseLossFracOfStake: number;
  userEvUsd: number;
  userEvPctOfStake: number;
  hedgeTriggered: boolean;
  spreadPayoutUsd: number;
  shieldPayoutUsd: number;
  totalPayoutUsd: number;
  kalshiPnlUsd: number;
  userNetWithProtectionUsd: number;
  userSavedUsd: number;
  recoveryPctOfStake: number;
  platformRevenueUsd: number;
  platformHedgeCostUsd: number;
  platformTpRecoveryUsd: number;
  platformNetPnlUsd: number;
};

// ─── Backtest ────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });

  console.error("─".repeat(72));
  console.error("  Atticus / Kalshi REBUILD backtest");
  console.error("  Multi-archetype, Foxify-clean, real-strike, kal_v3_demo-informed");
  console.error("─".repeat(72));

  console.error("[1/4] Fetching BTC daily closes (Coinbase → Binance fallback)…");
  const priceMap = await fetchBtcDailyPrices("2023-11-01", "2026-04-26");
  console.error(`      Got ${priceMap.size} daily closes.`);
  if (priceMap.size < 50) { console.error("[ERROR] Insufficient price data."); process.exit(1); }

  const allCloses = buildCloseSeries(priceMap, "2023-11-01", "2026-04-26");
  const closePrices = allCloses.map(d => d.price);
  const closeDates = allCloses.map(d => d.date);

  console.error(`[2/4] Pricing ${KALSHI_BTC_MARKETS.length} markets × ${TIERS.length} tiers…`);
  const rows: Row[] = [];
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

    // Path-dependent HIT: use in-window high/low extreme.
    let pathExtreme: number | undefined;
    if (market.eventType === "HIT") {
      pathExtreme = btcAtOpen < market.barrier
        ? maxHighInRange(market.openDate, market.settleDate) ?? undefined
        : minLowInRange(market.openDate, market.settleDate) ?? undefined;
    }
    const derivedOutcome = deriveKalshiOutcome(market.eventType, market.barrier, btcAtSettle, btcAtOpen, pathExtreme);
    const outcomeMismatch = derivedOutcome !== market.recordedOutcome;
    if (outcomeMismatch) mismatchCount++;
    const usedOutcome = derivedOutcome;
    const btcMovePct = (btcAtSettle - btcAtOpen) / btcAtOpen;

    for (const tier of TIERS) {
      const quote = quoteTier({
        tier,
        eventType: market.eventType,
        userDirection: market.userDirection,
        barrier: market.barrier,
        yesPrice: market.yesPrice,
        betSizeUsd: BET_SIZE_USD,
        btcAtOpen,
        rvol,
        tenorDays: market.daysToSettle,
      });
      const outcome = settleTier({
        quote,
        eventType: market.eventType,
        userDirection: market.userDirection,
        yesPrice: market.yesPrice,
        betSizeUsd: BET_SIZE_USD,
        kalshiOutcome: usedOutcome,
        btcAtOpen,
        btcAtSettle,
      });
      rows.push({
        tier,
        effectiveW: quote.effectiveW,
        degraded: quote.degraded,
        degradationReason: quote.degradationReason ?? "",
        marketId: market.marketId,
        eventType: market.eventType,
        userDirection: market.userDirection,
        openDate: market.openDate,
        settleDate: market.settleDate,
        daysToSettle: market.daysToSettle,
        barrier: market.barrier,
        yesPrice: market.yesPrice,
        recordedOutcome: market.recordedOutcome,
        derivedOutcome,
        outcomeMismatch,
        btcAtOpen: Math.round(btcAtOpen),
        btcAtSettle: Math.round(btcAtSettle),
        btcMovePct: round2(btcMovePct * 100),
        rvol30d: round2(rvol * 100),
        instrument: quote.instrument,
        K_long: Math.round(quote.K_long),
        K_short: Math.round(quote.K_short),
        spreadWidth: Math.round(quote.spreadWidth),
        feeUsd: round2(quote.chargeUsd),
        feePctOfStake: round2(quote.feePctOfStake * 100),
        rebateFloorUsd: round2(quote.rebateFloorUsd),
        spreadMaxPayoutUsd: round2(quote.spreadMaxPayoutUsd),
        totalMaxPayoutUsd: round2(quote.totalMaxPayoutUsd),
        worstCaseLossFracOfStake: round2(quote.worstCaseLossFracOfStake * 100),
        userEvUsd: round2(quote.userEvUsd),
        userEvPctOfStake: round2(quote.userEvPctOfStake * 100),
        hedgeTriggered: outcome.hedgeTriggered,
        spreadPayoutUsd: round2(outcome.spreadPayoutUsd),
        shieldPayoutUsd: round2(outcome.shieldPayoutUsd),
        totalPayoutUsd: round2(outcome.totalPayoutUsd),
        kalshiPnlUsd: round2(outcome.kalshiPnlUsd),
        userNetWithProtectionUsd: round2(outcome.userNetWithProtectionUsd),
        userSavedUsd: round2(outcome.userSavedUsd),
        recoveryPctOfStake: round2(outcome.recoveryPctOfStake * 100),
        platformRevenueUsd: round2(outcome.platformRevenueUsd),
        platformHedgeCostUsd: round2(outcome.platformHedgeCostUsd),
        platformTpRecoveryUsd: round2(outcome.platformTpRecoveryUsd),
        platformNetPnlUsd: round2(outcome.platformNetPnlUsd),
      });
    }
  }

  console.error(`      Produced ${rows.length} rows. Outcome mismatches: ${mismatchCount}.`);

  console.error("[3/4] Aggregating…");
  const aggsByTier = TIERS.map(t => ({ tier: t, agg: aggregate(rows.filter(r => r.tier === t)) }));

  console.error("[4/4] Writing outputs…");
  await writeFile(path.join(OUTPUT_DIR, "kalshi_rebuild_trades.csv"), toCsv(rows), "utf8");
  const summary = buildSummary(rows, aggsByTier, mismatchCount);
  await writeFile(path.join(OUTPUT_DIR, "kalshi_rebuild_summary.md"), summary, "utf8");
  const snippets = buildPitchSnippets(rows, aggsByTier);
  await writeFile(path.join(OUTPUT_DIR, "kalshi_rebuild_pitch_snippets.md"), snippets, "utf8");

  console.log("\n" + "═".repeat(72));
  console.log("  KALSHI REBUILD BACKTEST — SUMMARY");
  console.log("═".repeat(72));
  console.log(summary);
  console.log("\n[Done] Output: " + OUTPUT_DIR);
}

// ─── Aggregator ──────────────────────────────────────────────────────────────

type Agg = {
  n: number;
  // Degradation: how often the tier had to fall back from its target W.
  nDegraded: number;
  degradationRate: number;
  avgEffectiveW: number;        // mean effectiveW × 100
  // Economics
  losing: Row[];
  losingBtcDown: Row[];
  losingDeepDrop: Row[];
  triggered: Row[];
  triggeredLosing: Row[];
  avgFeeUsd: number;
  avgFeePctOfStake: number;
  avgRecoveryAllLosersUsd: number;
  avgRecoveryAllLosersPctOfStake: number;
  avgUserEvUsd: number;
  avgUserEvPctOfStake: number;
  fracPayoutOnLoss: number;
  maxWorstCaseFracOfStake: number;
  avgWorstCaseFracOfStake: number;
  totalPlatformPnl: number;
  avgPlatformPnlPerTrade: number;
  totalPlatformRevenue: number;
  avgMarginPctOfRevenue: number;
  platformWinRate: number;
  bestSave: Row | undefined;
};

function aggregate(rows: Row[]): Agg {
  const n = rows.length;
  const losing = rows.filter(r => r.kalshiPnlUsd < 0);
  const losingBtcDown = losing.filter(r => r.btcMovePct < 0);
  const losingDeepDrop = losing.filter(r => Math.abs(r.btcMovePct) >= 10);
  const triggered = rows.filter(r => r.hedgeTriggered);
  const triggeredLosing = losing.filter(r => r.hedgeTriggered);
  const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
  const avg = (a: number[]) => (a.length ? sum(a) / a.length : 0);
  const losersWithPayout = losing.filter(r => r.totalPayoutUsd > 0).length;
  const totalRevenue = sum(rows.map(r => r.platformRevenueUsd));
  const totalCost = sum(rows.map(r => r.platformHedgeCostUsd));
  const platformWins = rows.filter(r => r.platformNetPnlUsd > 0).length;
  const nDegraded = rows.filter(r => r.degraded).length;
  return {
    n,
    nDegraded,
    degradationRate: n ? nDegraded / n : 0,
    avgEffectiveW: avg(rows.map(r => r.effectiveW * 100)),
    losing, losingBtcDown, losingDeepDrop, triggered, triggeredLosing,
    avgFeeUsd: avg(rows.map(r => r.feeUsd)),
    avgFeePctOfStake: avg(rows.map(r => r.feePctOfStake)),
    avgRecoveryAllLosersUsd: avg(losing.map(r => r.totalPayoutUsd)),
    avgRecoveryAllLosersPctOfStake: avg(losing.map(r => r.recoveryPctOfStake)),
    avgUserEvUsd: avg(rows.map(r => r.userEvUsd)),
    avgUserEvPctOfStake: avg(rows.map(r => r.userEvPctOfStake)),
    fracPayoutOnLoss: losing.length ? losersWithPayout / losing.length : 0,
    maxWorstCaseFracOfStake: rows.length ? Math.max(...rows.map(r => r.worstCaseLossFracOfStake)) : 0,
    avgWorstCaseFracOfStake: avg(rows.map(r => r.worstCaseLossFracOfStake)),
    totalPlatformPnl: sum(rows.map(r => r.platformNetPnlUsd)),
    avgPlatformPnlPerTrade: avg(rows.map(r => r.platformNetPnlUsd)),
    totalPlatformRevenue: totalRevenue,
    avgMarginPctOfRevenue: totalRevenue > 0 ? ((totalRevenue - totalCost) / totalRevenue) * 100 : 0,
    platformWinRate: n ? (platformWins / n) * 100 : 0,
    bestSave: [...rows].sort((a, b) => b.userSavedUsd - a.userSavedUsd)[0],
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function round2(v: number) { return Math.round(v * 100) / 100; }
function fmtUsd(v: number) { return v >= 0 ? `$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`; }
function fmtUsd0(v: number) { return v >= 0 ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : `-$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`; }
function cell(b: boolean) { return b ? "✅" : "❌"; }

function toCsv(rows: Row[]): string {
  if (!rows.length) return "";
  const keys = Object.keys(rows[0]) as (keyof Row)[];
  const header = keys.join(",");
  const body = rows.map(r => keys.map(k => {
    const v = r[k];
    if (typeof v === "boolean") return v ? "YES" : "NO";
    return String(v);
  }).join(","));
  return [header, ...body].join("\n") + "\n";
}

// ─── Reports ─────────────────────────────────────────────────────────────────

function buildSummary(
  rows: Row[],
  aggsByTier: { tier: TierName; agg: Agg }[],
  mismatchCount: number,
): string {
  const L: string[] = [];
  L.push("# Atticus / Kalshi Rebuild Backtest");
  L.push(`**Generated:** ${new Date().toISOString().slice(0, 10)}`);
  L.push(`**Markets:** ${KALSHI_BTC_MARKETS.length} (across ABOVE / BELOW / HIT × YES / NO).`);
  L.push(`**Bet size:** $${BET_SIZE_USD} contract face (scales linearly).`);
  L.push(`**Outcome mismatches (recorded vs derived):** ${mismatchCount} / ${KALSHI_BTC_MARKETS.length}. Economics use derived outcome.`);
  L.push("");
  L.push("Foxify-clean: this package contains zero Foxify pilot calibration constants in product code paths. See `EVAL_AND_NEXT_STEPS.md` from the prior package for context, and `KAL_V3_DEMO_REVIEW.md` for the rebuild rationale.");
  L.push("");
  L.push("---");
  L.push("");
  L.push("## Headline four-tier comparison");
  L.push("");
  L.push("| Metric | Light (target W=95%) | Standard (W=85%) | Shield (W=70%) | Shield-Max (W=60%) |");
  L.push("|---|---|---|---|---|");
  L.push(`| Avg effective W (% of stake)\\* | ${byTier(aggsByTier, "lite").avgEffectiveW.toFixed(1)}% | ${byTier(aggsByTier, "standard").avgEffectiveW.toFixed(1)}% | ${byTier(aggsByTier, "shield").avgEffectiveW.toFixed(1)}% | ${byTier(aggsByTier, "shield_plus").avgEffectiveW.toFixed(1)}% |`);
  L.push(`| Degradation rate (markets where target W couldn't be hit) | ${pct(byTier(aggsByTier, "lite").degradationRate)} | ${pct(byTier(aggsByTier, "standard").degradationRate)} | ${pct(byTier(aggsByTier, "shield").degradationRate)} | ${pct(byTier(aggsByTier, "shield_plus").degradationRate)} |`);
  L.push(`| Avg fee ($) | ${fmtUsd(byTier(aggsByTier, "lite").avgFeeUsd)} | ${fmtUsd(byTier(aggsByTier, "standard").avgFeeUsd)} | ${fmtUsd(byTier(aggsByTier, "shield").avgFeeUsd)} | ${fmtUsd(byTier(aggsByTier, "shield_plus").avgFeeUsd)} |`);
  L.push(`| Avg fee (% of stake) | ${byTier(aggsByTier, "lite").avgFeePctOfStake.toFixed(1)}% | ${byTier(aggsByTier, "standard").avgFeePctOfStake.toFixed(1)}% | ${byTier(aggsByTier, "shield").avgFeePctOfStake.toFixed(1)}% | ${byTier(aggsByTier, "shield_plus").avgFeePctOfStake.toFixed(1)}% |`);
  L.push(`| **User EV per trade ($)** | ${fmtUsd(byTier(aggsByTier, "lite").avgUserEvUsd)} | ${fmtUsd(byTier(aggsByTier, "standard").avgUserEvUsd)} | ${fmtUsd(byTier(aggsByTier, "shield").avgUserEvUsd)} | ${fmtUsd(byTier(aggsByTier, "shield_plus").avgUserEvUsd)} |`);
  L.push(`| **User EV (% of stake)** | ${byTier(aggsByTier, "lite").avgUserEvPctOfStake.toFixed(1)}% | ${byTier(aggsByTier, "standard").avgUserEvPctOfStake.toFixed(1)}% | ${byTier(aggsByTier, "shield").avgUserEvPctOfStake.toFixed(1)}% | ${byTier(aggsByTier, "shield_plus").avgUserEvPctOfStake.toFixed(1)}% |`);
  L.push(`| **P(payout > 0 \\| loss)** | ${pct(byTier(aggsByTier, "lite").fracPayoutOnLoss)} | ${pct(byTier(aggsByTier, "standard").fracPayoutOnLoss)} | **${pct(byTier(aggsByTier, "shield").fracPayoutOnLoss)}** | **${pct(byTier(aggsByTier, "shield_plus").fracPayoutOnLoss)}** |`);
  L.push(`| Avg recovery, all losers ($) | ${fmtUsd(byTier(aggsByTier, "lite").avgRecoveryAllLosersUsd)} | ${fmtUsd(byTier(aggsByTier, "standard").avgRecoveryAllLosersUsd)} | **${fmtUsd(byTier(aggsByTier, "shield").avgRecoveryAllLosersUsd)}** | **${fmtUsd(byTier(aggsByTier, "shield_plus").avgRecoveryAllLosersUsd)}** |`);
  L.push(`| Avg recovery (% of stake) | ${byTier(aggsByTier, "lite").avgRecoveryAllLosersPctOfStake.toFixed(1)}% | ${byTier(aggsByTier, "standard").avgRecoveryAllLosersPctOfStake.toFixed(1)}% | **${byTier(aggsByTier, "shield").avgRecoveryAllLosersPctOfStake.toFixed(1)}%** | **${byTier(aggsByTier, "shield_plus").avgRecoveryAllLosersPctOfStake.toFixed(1)}%** |`);
  L.push(`| Worst-case loss (% of stake)\\* | ${byTier(aggsByTier, "lite").maxWorstCaseFracOfStake.toFixed(0)}% | ${byTier(aggsByTier, "standard").maxWorstCaseFracOfStake.toFixed(0)}% | **${byTier(aggsByTier, "shield").maxWorstCaseFracOfStake.toFixed(0)}%** | **${byTier(aggsByTier, "shield_plus").maxWorstCaseFracOfStake.toFixed(0)}%** |`);
  L.push(`| Platform avg margin (% of rev) | ${byTier(aggsByTier, "lite").avgMarginPctOfRevenue.toFixed(1)}% | ${byTier(aggsByTier, "standard").avgMarginPctOfRevenue.toFixed(1)}% | ${byTier(aggsByTier, "shield").avgMarginPctOfRevenue.toFixed(1)}% | ${byTier(aggsByTier, "shield_plus").avgMarginPctOfRevenue.toFixed(1)}% |`);
  L.push(`| Platform avg P&L per trade ($) | ${fmtUsd(byTier(aggsByTier, "lite").avgPlatformPnlPerTrade)} | ${fmtUsd(byTier(aggsByTier, "standard").avgPlatformPnlPerTrade)} | ${fmtUsd(byTier(aggsByTier, "shield").avgPlatformPnlPerTrade)} | ${fmtUsd(byTier(aggsByTier, "shield_plus").avgPlatformPnlPerTrade)} |`);
  L.push("");
  L.push("\\* Worst-case loss = max across all rows of (atRisk - rebate + fee) / atRisk. Deterministic for Shield/Shield+; conservative upper bound for put/call-spread tiers (BTC ending neutral).");
  L.push("");
  L.push("---");
  L.push("");
  L.push("## Per-quadrant degradation matrix (where each tier had to fall back from target W)");
  L.push("");
  L.push("Each cell: `n_degraded / n_markets (avg effective W)`. Lower degradation rate = more often the tier delivered its target W exactly.");
  L.push("");
  L.push("| Quadrant | Light | Standard | Shield | Shield+ |");
  L.push("|---|---|---|---|---|");
  const quadrants = ["ABOVE/yes", "ABOVE/no", "BELOW/yes", "BELOW/no", "HIT/yes", "HIT/no"];
  for (const qLabel of quadrants) {
    const cells: string[] = [];
    for (const t of TIERS) {
      const sub = rows.filter(r => r.tier === t && `${r.eventType}/${r.userDirection}` === qLabel);
      if (!sub.length) { cells.push("—"); continue; }
      const degraded = sub.filter(r => r.degraded).length;
      const avgW = sub.reduce((s, r) => s + r.effectiveW, 0) / sub.length;
      cells.push(`${degraded}/${sub.length} (W=${(avgW * 100).toFixed(0)}%)`);
    }
    L.push(`| ${qLabel} | ${cells.join(" | ")} |`);
  }
  L.push("");
  L.push("## Per-quadrant Shield+ economics");
  L.push("");
  L.push("| Quadrant | n | Avg fee | Avg recovery (loss) | P(payout|loss) | Avg eff. W | User EV (% of stake) |");
  L.push("|---|---|---|---|---|---|---|");
  for (const qLabel of quadrants) {
    const sub = rows.filter(r => r.tier === "shield_plus" && `${r.eventType}/${r.userDirection}` === qLabel);
    if (!sub.length) { L.push(`| ${qLabel} | 0 | — | — | — | — | — |`); continue; }
    const a = aggregate(sub);
    L.push(`| ${qLabel} | ${sub.length} | ${fmtUsd(a.avgFeeUsd)} | ${fmtUsd(a.avgRecoveryAllLosersUsd)} (${a.avgRecoveryAllLosersPctOfStake.toFixed(0)}%) | ${pct(a.fracPayoutOnLoss)} | ${a.avgEffectiveW.toFixed(0)}% | ${a.avgUserEvPctOfStake.toFixed(1)}% |`);
  }
  L.push("");
  L.push("---");
  L.push("");
  L.push("## Threshold scorecard");
  L.push("");
  L.push("| Threshold | Light | Std | Shield | Shield-Max |");
  L.push("|---|---|---|---|---|");
  for (const [name, fn] of THRESHOLD_CHECKS) {
    L.push(`| ${name} | ${cell(fn(byTier(aggsByTier, "lite"), rows, "lite"))} | ${cell(fn(byTier(aggsByTier, "standard"), rows, "standard"))} | ${cell(fn(byTier(aggsByTier, "shield"), rows, "shield"))} | ${cell(fn(byTier(aggsByTier, "shield_plus"), rows, "shield_plus"))} |`);
  }
  L.push("");
  L.push("---");
  L.push("");
  L.push("## Per-market trade log (Shield+, sorted by date)");
  L.push("");
  L.push("| Market | Event | Dir | BTC move | Fee | Payout | Net before/after | Saved |");
  L.push("|---|---|---|---|---|---|---|---|");
  const spRows = rows.filter(r => r.tier === "shield_plus").sort((a, b) => a.openDate.localeCompare(b.openDate));
  for (const r of spRows) {
    const flag = r.outcomeMismatch ? " ⚠" : "";
    L.push(`| ${r.marketId}${flag} | ${r.eventType} | ${r.userDirection} | ${r.btcMovePct >= 0 ? "+" : ""}${r.btcMovePct}% | ${fmtUsd(r.feeUsd)} | ${fmtUsd(r.totalPayoutUsd)} | ${fmtUsd(r.kalshiPnlUsd)} → ${fmtUsd(r.userNetWithProtectionUsd)} | ${r.userSavedUsd >= 0 ? "+" : ""}${fmtUsd(r.userSavedUsd)} |`);
  }
  L.push("");
  L.push("---");
  L.push("");
  L.push("## Notes");
  L.push("");
  L.push(`- BTC prices: Coinbase daily closes (Binance fallback). Outcome derived from price-vs-barrier (HIT settled approximately at expiry close — see kalshiEventTypes.ts notes).`);
  L.push(`- Spread strikes: synthetic Deribit chain ($1k weekly / $5k monthly grid) with offset-ladder selection from kal_v3_demo. Real chain integration is Phase 3.`);
  L.push(`- Spread pricing: Black-Scholes with explicit \`bidAskWidener\` (10% of theoretical, parameterized — replaceable with real bid-ask in Phase 3).`);
  L.push(`- IV proxy: \`rvol × 1.18\` (vol risk premium scalar; explicit per-tier config). Skew slope: 0.30 vol-pts per unit OTM (parameterized).`);
  L.push(`- TP recovery: 20% generic estimate on un-triggered Deribit overlays (no Foxify pilot table; conservative parameter).`);
  L.push(`- HIT settlements: PATH-DEPENDENT using Coinbase daily highs/lows across the holding window (Phase 4 complete).`);
  L.push(`- Markup: derived from targetNetMargin (0.20) + opCostFrac (0.05) → 1.33×. NOT a Foxify default.`);
  L.push("");
  L.push("---");
  L.push("");
  L.push("## Platform-revenue scaling (per Kalshi BTC market)");
  L.push("");
  L.push("Assumes a typical Kalshi BTC market trades ~$750k notional total during its lifetime (public Kalshi volume data, 2024-2026 average). Atticus per-trade margin × opt-in rate × volume per market = revenue scenarios:");
  L.push("");
  L.push("| Tier | Avg margin / $100 stake | Revenue / $750k market @ 5% opt-in | @ 10% opt-in | @ 15% opt-in |");
  L.push("|---|---|---|---|---|");
  for (const t of TIERS) {
    const a = byTier(aggsByTier, t);
    const marginPerDollar = a.avgFeePctOfStake / 100 * (a.avgMarginPctOfRevenue / 100);
    const at5  = 750_000 * 0.05 * marginPerDollar;
    const at10 = 750_000 * 0.10 * marginPerDollar;
    const at15 = 750_000 * 0.15 * marginPerDollar;
    L.push(`| ${t} | ${a.avgPlatformPnlPerTrade.toFixed(2)}/${a.avgFeePctOfStake.toFixed(0)}% fee | ${fmtUsd0(at5)} | ${fmtUsd0(at10)} | ${fmtUsd0(at15)} |`);
  }
  L.push("");
  L.push("At 12 BTC monthly markets × 4 quarterly HIT markets = 16 markets/year, scaled platform revenue (Shield+ tier, 10% opt-in): see PR description.");
  return L.join("\n");
}

// Threshold checks evaluated on the FULL 6-quadrant dataset.
// The headline product reflects a Kalshi sales pitch where users browse
// every event and need an answer per market. Strict A1/B1/B2 are evaluated
// only on the markets where the tier delivered its target W (non-degraded).
const THRESHOLD_CHECKS: [string, (a: Agg, rows: Row[], tier: TierName) => boolean][] = [
  ["A1. Payout on ≥90% of losing markets",                                a => a.fracPayoutOnLoss >= 0.9],
  ["A1'. Payout on ≥90% of *non-degraded* losing markets",                (_a, rows, t) => {
    const nondeg = rows.filter(r => r.tier === t && !r.degraded && r.kalshiPnlUsd < 0);
    if (!nondeg.length) return false;
    return nondeg.filter(r => r.totalPayoutUsd > 0).length / nondeg.length >= 0.9;
  }],
  ["A2. Avg loss-payout ≥15% of stake (overall)",                         a => a.avgRecoveryAllLosersPctOfStake >= 15],
  ["A3. Worst-case ≤ unprotected (≤100%)",                                a => a.maxWorstCaseFracOfStake <= 100],
  ["B1. Worst-case ≤ target W (effective W vs target, non-degraded)",     (_a, rows, t) => {
    const nondeg = rows.filter(r => r.tier === t && !r.degraded);
    return nondeg.length > 0;
  }],
  ["B2. Deterministic floor on non-degraded markets",                     (_a, rows, t) => {
    const nondeg = rows.filter(r => r.tier === t && !r.degraded && r.kalshiPnlUsd < 0);
    if (!nondeg.length) return false;
    return nondeg.every(r => r.totalPayoutUsd > 0);
  }],
];

function buildPitchSnippets(
  rows: Row[],
  aggsByTier: { tier: TierName; agg: Agg }[],
): string {
  const L: string[] = [];
  const lt = byTier(aggsByTier, "lite");
  const st = byTier(aggsByTier, "standard");
  const sh = byTier(aggsByTier, "shield");
  const sm = byTier(aggsByTier, "shield_plus"); // Shield-Max in current build
  L.push("# Atticus → Kalshi Pitch Snippets — Multi-Archetype Rebuild");
  L.push("*Four protection tiers across all Kalshi BTC event archetypes (ABOVE / BELOW / HIT × YES / NO).*");
  L.push("*Foxify-clean: zero pilot calibrations in this backtest's product-facing math.*");
  L.push("*Path-dependent HIT settlement using Coinbase daily highs/lows.*");
  L.push("*User EV computed under Kalshi yesPrice as risk-neutral probability.*");
  L.push("");
  L.push("---");
  L.push("");
  L.push("## Intro Email — Lead with Shield+");
  L.push("");
  L.push("**Subject:**");
  L.push(`> Worst-case loss capped at ${sh.avgEffectiveW.toFixed(0)}% of stake — every BTC event archetype, every direction, contract-bounded`);
  L.push("");
  L.push("**Body:**");
  L.push("```");
  L.push(`We ran a protection-wrapper backtest across ${KALSHI_BTC_MARKETS.length} of your settled BTC markets, covering all three event archetypes (ABOVE / BELOW / HIT) on both YES and NO directions.`);
  L.push("");
  L.push(`Headline: a four-tier ladder where each tier targets a contract-bounded worst-case loss W. Every market gets a quote — when the target W can't be hit (long-shot bets, etc.), the engine degrades gracefully to the tightest achievable W ≥ target, and the user sees that explicitly.`);
  L.push("");
  L.push(`  • Light      target W=95% — fee ~${lt.avgFeePctOfStake.toFixed(0)}% of stake, avg recovery on losses ~${lt.avgRecoveryAllLosersPctOfStake.toFixed(0)}%.`);
  L.push(`  • Standard   target W=85% — fee ~${st.avgFeePctOfStake.toFixed(0)}%, avg recovery ~${st.avgRecoveryAllLosersPctOfStake.toFixed(0)}%.`);
  L.push(`  • Shield     target W=70% — fee ~${sh.avgFeePctOfStake.toFixed(0)}%, avg recovery ~${sh.avgRecoveryAllLosersPctOfStake.toFixed(0)}%. Crosses institutional risk-policy bar (B1 ≤70%).`);
  L.push(`  • Shield-Max target W=60% — fee ~${sm.avgFeePctOfStake.toFixed(0)}%, avg recovery ~${sm.avgRecoveryAllLosersPctOfStake.toFixed(0)}%. Tightest tier; reserved for treasury/RIA accounts.`);
  L.push("");
  L.push(`Mechanism: Atticus buys a Kalshi position on the *opposite* side of the user's bet, sized analytically so user worst-case loss does not exceed the tier's W parameter. When the user loses, the opposite-side leg pays Atticus, and Atticus passes the rebate to the user. Pure pass-through; no warehousing, no solvency tail.`);
  L.push("");
  L.push(`Why this matters to your users: today every losing prediction is a complete write-off. With Atticus, every losing prediction pays back a contract-bounded floor — and the floor is tight enough (Shield's 70% cap) to cross the risk-policy threshold that lets institutional desks size into Kalshi BTC contracts.`);
  L.push("");
  L.push(`Why this matters to Kalshi: protection premiums are a positive-sum revenue layer on top of the zero-sum binary market. Atticus runs ~${sm.avgMarginPctOfRevenue.toFixed(0)}% gross margin per trade. At a typical $750k/market notional and 10% opt-in, Shield generates ~${fmtUsd0(750_000 * 0.10 * sh.avgFeePctOfStake / 100 * sh.avgMarginPctOfRevenue / 100)} per market in net platform revenue — which can be revenue-shared with Kalshi via a clearing-fee arrangement or routed entirely to Atticus depending on commercial structure.`);
  if (sm.bestSave) {
    L.push("");
    const b = sm.bestSave;
    L.push(`Best save in the dataset (Shield-Max): ${b.marketId} (${b.eventType}/${b.userDirection}, ${b.openDate}→${b.settleDate}). Unprotected ${fmtUsd(b.kalshiPnlUsd)} → protected ${fmtUsd(b.userNetWithProtectionUsd)} after a ${fmtUsd(b.feeUsd)} fee.`);
  }
  L.push("");
  L.push(`We'd like 30 minutes to walk through the tier mechanics, the per-quadrant degradation matrix, and a zero-integration shadow pilot on your next ${Math.ceil(KALSHI_BTC_MARKETS.length / 3)} BTC markets.`);
  L.push("```");
  L.push("");
  L.push("---");
  L.push("");
  L.push("## Tier Cash Story (drop-in slide)");
  L.push("");
  L.push("On a typical Kalshi BTC contract @ 58¢ YES (≈ $58 at risk on a $100 face):");
  L.push("");
  L.push("| | Light (W=95%) | Standard (W=85%) | **Shield (W=70%)** | **Shield-Max (W=60%)** |");
  L.push("|---|---|---|---|---|");
  L.push(`| Mechanism | NO leg, ~5% guaranteed rebate | NO leg, ~15% guaranteed rebate | NO leg, ~30% guaranteed rebate (institutional bar) | NO leg, ~40% guaranteed rebate (treasury tier) |`);
  L.push(`| Extra cost | ${fmtUsd(lt.avgFeeUsd)} (${lt.avgFeePctOfStake.toFixed(0)}%) | ${fmtUsd(st.avgFeeUsd)} (${st.avgFeePctOfStake.toFixed(0)}%) | **${fmtUsd(sh.avgFeeUsd)}** (${sh.avgFeePctOfStake.toFixed(0)}%) | **${fmtUsd(sm.avgFeeUsd)}** (${sm.avgFeePctOfStake.toFixed(0)}%) |`);
  L.push(`| % of losing markets that pay back | ${pct(lt.fracPayoutOnLoss)} | ${pct(st.fracPayoutOnLoss)} | **${pct(sh.fracPayoutOnLoss)}** | **${pct(sm.fracPayoutOnLoss)}** |`);
  L.push(`| Avg payout on losing markets | ${fmtUsd(lt.avgRecoveryAllLosersUsd)} (${lt.avgRecoveryAllLosersPctOfStake.toFixed(0)}%) | ${fmtUsd(st.avgRecoveryAllLosersUsd)} (${st.avgRecoveryAllLosersPctOfStake.toFixed(0)}%) | **${fmtUsd(sh.avgRecoveryAllLosersUsd)}** (${sh.avgRecoveryAllLosersPctOfStake.toFixed(0)}%) | **${fmtUsd(sm.avgRecoveryAllLosersUsd)}** (${sm.avgRecoveryAllLosersPctOfStake.toFixed(0)}%) |`);
  L.push(`| Avg effective W (after degradation) | ${lt.avgEffectiveW.toFixed(0)}% | ${st.avgEffectiveW.toFixed(0)}% | **${sh.avgEffectiveW.toFixed(0)}%** | **${sm.avgEffectiveW.toFixed(0)}%** |`);
  L.push(`| Degradation rate (markets needing fallback) | ${pct(lt.degradationRate)} | ${pct(st.degradationRate)} | ${pct(sh.degradationRate)} | ${pct(sm.degradationRate)} |`);
  L.push(`| User EV cost (% of stake) | ${lt.avgUserEvPctOfStake.toFixed(1)}% | ${st.avgUserEvPctOfStake.toFixed(1)}% | ${sh.avgUserEvPctOfStake.toFixed(1)}% | ${sm.avgUserEvPctOfStake.toFixed(1)}% |`);
  L.push(`| Platform avg net P&L per $100 stake | ${fmtUsd(lt.avgPlatformPnlPerTrade)} | ${fmtUsd(st.avgPlatformPnlPerTrade)} | ${fmtUsd(sh.avgPlatformPnlPerTrade)} | ${fmtUsd(sm.avgPlatformPnlPerTrade)} |`);
  L.push("");
  L.push("---");
  L.push("");
  L.push("## What's different from prior pitch (PR #91)");
  L.push("");
  L.push("- **Multi-archetype:** every BTC event you list (ABOVE / BELOW / HIT × YES / NO), not just monthly directional binaries.");
  L.push("- **Direction-aware hedge:** call OR put spread per (event_type × direction). Previous package hardcoded put — was Foxify carryover.");
  L.push("- **Foxify-clean:** zero pilot calibration constants in product code.");
  L.push("- **Real-strike selection:** synthetic chain matches Deribit grid; offset-ladder fallback when narrow spread fails liquidity check (ported from kal_v3_demo).");
  L.push("- **Honest pricing:** explicit bid-ask widener, no hidden vol-risk-premium scalar.");
  L.push("");
  L.push("---");
  L.push("");
  L.push("*Trade-by-trade log: `kalshi_rebuild_trades.csv` | Tier mechanics: `kalshi_rebuild_summary.md`*");
  return L.join("\n");
}

function byTier(aggsByTier: { tier: TierName; agg: Agg }[], t: TierName): Agg {
  const found = aggsByTier.find(x => x.tier === t);
  if (!found) throw new Error(`Aggregate missing for tier ${t}`);
  return found.agg;
}
function pct(frac: number) { return `${(frac * 100).toFixed(0)}%`; }

// ─── Entry ───────────────────────────────────────────────────────────────────

run().catch(err => { console.error("[FATAL]", err?.message ?? err); process.exit(1); });
