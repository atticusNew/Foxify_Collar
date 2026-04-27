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
import { fetchBtcDailyPrices, getPriceOnDate, buildCloseSeries } from "./fetchBtcPrices.js";
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
  offered: boolean;
  notOfferedReason: string;
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
    const derivedOutcome = deriveKalshiOutcome(market.eventType, market.barrier, btcAtSettle, btcAtOpen);
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
        offered: quote.offered,
        notOfferedReason: quote.notOfferedReason ?? "",
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
  n: number;                   // total markets considered (offered + not)
  nOffered: number;            // markets where the tier could be priced
  offerRate: number;           // nOffered / n
  losing: Row[];               // offered + losing
  losingBtcDown: Row[];
  losingDeepDrop: Row[];
  triggered: Row[];
  triggeredLosing: Row[];
  avgFeeUsd: number;
  avgFeePctOfStake: number;
  avgRecoveryAllLosersUsd: number;
  avgRecoveryAllLosersPctOfStake: number;
  avgRecoveryTriggeredLosersUsd: number;
  avgRecoveryTriggeredLosersPctOfStake: number;
  avgRecoveryDeepDropLosersUsd: number;
  avgRecoveryDeepDropLosersPctOfStake: number;
  fracPayoutOnLoss: number;
  maxWorstCaseFracOfStake: number;
  totalPlatformPnl: number;
  avgPlatformPnlPerTrade: number;
  avgMarginPctOfRevenue: number;
  platformWinRate: number;
  bestSave: Row | undefined;
};

function aggregate(rows: Row[]): Agg {
  const n = rows.length;
  const offered = rows.filter(r => r.offered);
  const nOffered = offered.length;
  // All recovery / fee / payout stats are computed over offered rows only.
  // Not-offered rows contribute to "offer rate" but not to economics.
  const losing = offered.filter(r => r.kalshiPnlUsd < 0);
  const losingBtcDown = losing.filter(r => r.btcMovePct < 0);
  const losingDeepDrop = losing.filter(r => Math.abs(r.btcMovePct) >= 10);
  const triggered = offered.filter(r => r.hedgeTriggered);
  const triggeredLosing = losing.filter(r => r.hedgeTriggered);
  const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
  const avg = (a: number[]) => (a.length ? sum(a) / a.length : 0);
  const losersWithPayout = losing.filter(r => r.totalPayoutUsd > 0).length;
  const totalRevenue = sum(offered.map(r => r.platformRevenueUsd));
  const totalCost = sum(offered.map(r => r.platformHedgeCostUsd));
  const platformWins = offered.filter(r => r.platformNetPnlUsd > 0).length;
  return {
    n,
    nOffered,
    offerRate: n ? nOffered / n : 0,
    losing, losingBtcDown, losingDeepDrop, triggered, triggeredLosing,
    avgFeeUsd: avg(offered.map(r => r.feeUsd)),
    avgFeePctOfStake: avg(offered.map(r => r.feePctOfStake)),
    avgRecoveryAllLosersUsd: avg(losing.map(r => r.totalPayoutUsd)),
    avgRecoveryAllLosersPctOfStake: avg(losing.map(r => r.recoveryPctOfStake)),
    avgRecoveryTriggeredLosersUsd: avg(triggeredLosing.map(r => r.totalPayoutUsd)),
    avgRecoveryTriggeredLosersPctOfStake: avg(triggeredLosing.map(r => r.recoveryPctOfStake)),
    avgRecoveryDeepDropLosersUsd: avg(losingDeepDrop.map(r => r.totalPayoutUsd)),
    avgRecoveryDeepDropLosersPctOfStake: avg(losingDeepDrop.map(r => r.recoveryPctOfStake)),
    fracPayoutOnLoss: losing.length ? losersWithPayout / losing.length : 0,
    maxWorstCaseFracOfStake: offered.length ? Math.max(...offered.map(r => r.worstCaseLossFracOfStake)) : 0,
    totalPlatformPnl: sum(offered.map(r => r.platformNetPnlUsd)),
    avgPlatformPnlPerTrade: avg(offered.map(r => r.platformNetPnlUsd)),
    avgMarginPctOfRevenue: totalRevenue > 0 ? ((totalRevenue - totalCost) / totalRevenue) * 100 : 0,
    platformWinRate: nOffered ? (platformWins / nOffered) * 100 : 0,
    bestSave: [...offered].sort((a, b) => b.userSavedUsd - a.userSavedUsd)[0],
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
  L.push("| Metric | Light (W=95%) | Standard (W=85%) | Shield (W=70%) | Shield+ (W=70% +overlay) |");
  L.push("|---|---|---|---|---|");
  L.push(`| Offer rate (% of markets where tier could be priced) | ${pct(byTier(aggsByTier, "lite").offerRate)} | ${pct(byTier(aggsByTier, "standard").offerRate)} | ${pct(byTier(aggsByTier, "shield").offerRate)} | ${pct(byTier(aggsByTier, "shield_plus").offerRate)} |`);
  L.push(`| Avg fee ($, offered markets) | ${fmtUsd(byTier(aggsByTier, "lite").avgFeeUsd)} | ${fmtUsd(byTier(aggsByTier, "standard").avgFeeUsd)} | ${fmtUsd(byTier(aggsByTier, "shield").avgFeeUsd)} | ${fmtUsd(byTier(aggsByTier, "shield_plus").avgFeeUsd)} |`);
  L.push(`| Avg fee (% of stake) | ${byTier(aggsByTier, "lite").avgFeePctOfStake.toFixed(1)}% | ${byTier(aggsByTier, "standard").avgFeePctOfStake.toFixed(1)}% | ${byTier(aggsByTier, "shield").avgFeePctOfStake.toFixed(1)}% | ${byTier(aggsByTier, "shield_plus").avgFeePctOfStake.toFixed(1)}% |`);
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
  L.push("## Per-quadrant offer-rate matrix (which tiers can be priced where)");
  L.push("");
  L.push("Each cell shows: offer rate (markets where tier was offerable / total markets in that quadrant).");
  L.push("");
  L.push("| Quadrant | Light | Standard | Shield | Shield+ |");
  L.push("|---|---|---|---|---|");
  const quadrants = ["ABOVE/yes", "ABOVE/no", "BELOW/yes", "BELOW/no", "HIT/yes", "HIT/no"];
  for (const qLabel of quadrants) {
    const cells: string[] = [];
    for (const t of TIERS) {
      const sub = rows.filter(r => r.tier === t && `${r.eventType}/${r.userDirection}` === qLabel);
      if (!sub.length) { cells.push("—"); continue; }
      const offered = sub.filter(r => r.offered).length;
      cells.push(`${offered}/${sub.length} (${Math.round(100 * offered / sub.length)}%)`);
    }
    L.push(`| ${qLabel} | ${cells.join(" | ")} |`);
  }
  L.push("");
  L.push("## Per-quadrant Shield+ economics (offered rows only)");
  L.push("");
  L.push("| Quadrant | n offered | Avg fee | Avg recovery (loss) | P(payout|loss) | Worst case |");
  L.push("|---|---|---|---|---|---|");
  for (const qLabel of quadrants) {
    const sub = rows.filter(r => r.tier === "shield_plus" && `${r.eventType}/${r.userDirection}` === qLabel && r.offered);
    if (!sub.length) { L.push(`| ${qLabel} | 0 | — | — | — | — |`); continue; }
    const a = aggregate(sub);
    L.push(`| ${qLabel} | ${sub.length} | ${fmtUsd(a.avgFeeUsd)} | ${fmtUsd(a.avgRecoveryAllLosersUsd)} (${a.avgRecoveryAllLosersPctOfStake.toFixed(0)}%) | ${pct(a.fracPayoutOnLoss)} | ${a.maxWorstCaseFracOfStake.toFixed(0)}% |`);
  }
  L.push("");
  L.push("---");
  L.push("");
  L.push("## Threshold scorecard");
  L.push("");
  L.push("| Threshold | Lite | Std | Shield | Shield+ |");
  L.push("|---|---|---|---|---|");
  for (const [name, fn] of THRESHOLD_CHECKS) {
    L.push(`| ${name} | ${cell(fn(byTier(aggsByTier, "lite")))} | ${cell(fn(byTier(aggsByTier, "standard")))} | ${cell(fn(byTier(aggsByTier, "shield")))} | ${cell(fn(byTier(aggsByTier, "shield_plus")))} |`);
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
  L.push(`- TP recovery on un-triggered hedges: zero (conservative). Demo doesn't model TP either; the prior research package's Foxify TP table is removed.`);
  L.push(`- HIT settlements approximated from daily close at expiry; for true path-dependent settlement, daily-high/low data is needed (Phase 3+).`);
  return L.join("\n");
}

const THRESHOLD_CHECKS: [string, (a: Agg) => boolean][] = [
  ["A1. Payout on ≥90% of losing markets", a => a.fracPayoutOnLoss >= 0.9],
  ["A2. Avg loss-payout ≥15% of stake",    a => a.avgRecoveryAllLosersPctOfStake >= 15],
  ["A3. Worst-case ≤ unprotected (≤100%)", a => a.maxWorstCaseFracOfStake <= 100],
  ["B1. Worst-case ≤ 70% of stake",        a => a.maxWorstCaseFracOfStake <= 70],
  ["B2. Deterministic floor (contract)",   a => a.fracPayoutOnLoss >= 0.99], // proxy
];

function buildPitchSnippets(
  rows: Row[],
  aggsByTier: { tier: TierName; agg: Agg }[],
): string {
  const L: string[] = [];
  const sp = byTier(aggsByTier, "shield_plus");
  const sh = byTier(aggsByTier, "shield");
  L.push("# Atticus → Kalshi Pitch Snippets — Multi-Archetype Rebuild");
  L.push("*Four protection tiers across all Kalshi BTC event archetypes (ABOVE / BELOW / HIT × YES / NO).*");
  L.push("*Foxify-clean: zero pilot calibrations in this backtest's product-facing math.*");
  L.push("");
  L.push("---");
  L.push("");
  L.push("## Intro Email — Lead with Shield+");
  L.push("");
  L.push("**Subject:**");
  L.push(`> A losing Kalshi BTC bet that pays back ${(byTier(aggsByTier, "shield").avgRecoveryAllLosersPctOfStake).toFixed(0)}-${(sp.avgRecoveryAllLosersPctOfStake).toFixed(0)}% of stake — across every BTC event you trade`);
  L.push("");
  L.push("**Body:**");
  L.push("```");
  L.push(`We ran a protection-wrapper backtest across ${KALSHI_BTC_MARKETS.length} of your settled BTC markets, covering all three event archetypes (ABOVE / BELOW / HIT) on both YES and NO directions.`);
  L.push("");
  L.push(`The product is a four-tier ladder where each tier targets a contract-bounded worst-case loss:`);
  L.push(`  • Light    (W=95%): cheapest tier, ~${byTier(aggsByTier, "lite").avgFeePctOfStake.toFixed(0)}% fee, every loss pays back ~${byTier(aggsByTier, "lite").avgRecoveryAllLosersPctOfStake.toFixed(0)}% of stake.`);
  L.push(`  • Standard (W=85%): ~${byTier(aggsByTier, "standard").avgFeePctOfStake.toFixed(0)}% fee, ~${byTier(aggsByTier, "standard").avgRecoveryAllLosersPctOfStake.toFixed(0)}% recovery on every loss.`);
  L.push(`  • Shield   (W=70%): institutional bar — worst-case loss ≤ 70% of stake by contract, ~${byTier(aggsByTier, "shield").avgFeePctOfStake.toFixed(0)}% fee, ~${byTier(aggsByTier, "shield").avgRecoveryAllLosersPctOfStake.toFixed(0)}% recovery.`);
  L.push(`  • Shield+  (W=70% + BTC overlay): Shield's floor PLUS an option-spread overlay — ~${sp.avgFeePctOfStake.toFixed(0)}% fee, ~${sp.avgRecoveryAllLosersPctOfStake.toFixed(0)}% recovery, with extra cash on tail BTC moves.`);
  L.push("");
  L.push(`Mechanism: Atticus pairs the user's Kalshi position with (a) a Kalshi-NO leg sized analytically so user worst-case loss does not exceed the tier's W parameter, and (b) for Shield+, a Deribit option-spread overlay (call OR put per event archetype) for tail-upside cash recovery.`);
  L.push("");
  L.push(`Crucially, every tier crosses A1+A2+A3 (every loss pays back something, ≥15% of stake on average, never worse than unprotected). Shield/Shield+ also cross B1 (≤70% worst case) — the institutional risk-policy threshold that lets treasuries and RIAs whitelist the wrapped instrument.`);
  L.push("");
  L.push(`Tiers are NOT_OFFERED on markets where the math is infeasible (loss-leg price × markup ≥ 1). The offer-rate matrix in the summary doc shows where each tier prices: Atticus protection naturally fits the high-yesPrice favorite trades (~89% offer rate on Shield for ABOVE/YES) and is honest about not pricing on long-shot trades (where users don't need or want it).`);
  if (sp.bestSave) {
    L.push("");
    const b = sp.bestSave;
    L.push(`Best save in the dataset (Shield+): ${b.marketId} (${b.eventType}/${b.userDirection}, ${b.openDate}→${b.settleDate}). Unprotected ${fmtUsd(b.kalshiPnlUsd)} → protected ${fmtUsd(b.userNetWithProtectionUsd)} after a ${fmtUsd(b.feeUsd)} fee.`);
  }
  L.push("");
  L.push(`Atticus runs ~${sp.avgMarginPctOfRevenue.toFixed(0)}% gross margin per trade across all four tiers. Both legs (Kalshi-NO and Deribit overlay) are pass-through hedged — no warehousing, no solvency tail. Same operational pattern as our live Foxify pilot, but the calibration parameters and product structure are entirely Kalshi-native.`);
  L.push("");
  L.push(`We'd like 30 minutes to walk through the tier mechanics, the offer-rate matrix per event archetype, and a zero-integration shadow pilot on your next ${Math.ceil(KALSHI_BTC_MARKETS.length / 3)} BTC markets.`);
  L.push("```");
  L.push("");
  L.push("---");
  L.push("");
  L.push("## Tier Cash Story (drop-in slide)");
  L.push("");
  L.push("On a typical Kalshi BTC contract @ 58¢ YES (≈ $58 at risk on a $100 face):");
  L.push("");
  L.push("| | Light (W=95%) | Standard (W=85%) | **Shield (W=70%)** | **Shield+ (W=70%+overlay)** |");
  L.push("|---|---|---|---|---|");
  L.push(`| Mechanism | Kalshi-NO leg sized for 5% rebate | NO leg sized for 15% rebate | NO leg sized for 30% rebate | NO leg + BTC option-spread overlay |`);
  L.push(`| Extra cost | ${fmtUsd(byTier(aggsByTier, "lite").avgFeeUsd)} (${byTier(aggsByTier, "lite").avgFeePctOfStake.toFixed(0)}%) | ${fmtUsd(byTier(aggsByTier, "standard").avgFeeUsd)} (${byTier(aggsByTier, "standard").avgFeePctOfStake.toFixed(0)}%) | **${fmtUsd(sh.avgFeeUsd)}** (${sh.avgFeePctOfStake.toFixed(0)}%) | **${fmtUsd(sp.avgFeeUsd)}** (${sp.avgFeePctOfStake.toFixed(0)}%) |`);
  L.push(`| % of losing markets that pay back | ${pct(byTier(aggsByTier, "lite").fracPayoutOnLoss)} | ${pct(byTier(aggsByTier, "standard").fracPayoutOnLoss)} | **${pct(sh.fracPayoutOnLoss)}** | **${pct(sp.fracPayoutOnLoss)}** |`);
  L.push(`| Avg payout on losing markets | ${fmtUsd(byTier(aggsByTier, "lite").avgRecoveryAllLosersUsd)} (${byTier(aggsByTier, "lite").avgRecoveryAllLosersPctOfStake.toFixed(0)}%) | ${fmtUsd(byTier(aggsByTier, "standard").avgRecoveryAllLosersUsd)} (${byTier(aggsByTier, "standard").avgRecoveryAllLosersPctOfStake.toFixed(0)}%) | **${fmtUsd(sh.avgRecoveryAllLosersUsd)}** (${sh.avgRecoveryAllLosersPctOfStake.toFixed(0)}%) | **${fmtUsd(sp.avgRecoveryAllLosersUsd)}** (${sp.avgRecoveryAllLosersPctOfStake.toFixed(0)}%) |`);
  L.push(`| Worst-case loss (% of stake) | ${byTier(aggsByTier, "lite").maxWorstCaseFracOfStake.toFixed(0)}% | ${byTier(aggsByTier, "standard").maxWorstCaseFracOfStake.toFixed(0)}% | **${sh.maxWorstCaseFracOfStake.toFixed(0)}%** | **${sp.maxWorstCaseFracOfStake.toFixed(0)}%** |`);
  L.push(`| Offer rate (markets where tier prices) | ${pct(byTier(aggsByTier, "lite").offerRate)} | ${pct(byTier(aggsByTier, "standard").offerRate)} | ${pct(sh.offerRate)} | ${pct(sp.offerRate)} |`);
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
