#!/usr/bin/env tsx
/**
 * Phase 0 Deliverable 4 — Capital requirements model.
 *
 * Pure analysis. Read-only. No DB, no auth, no production impact.
 *
 * Translates the hedge-cost numbers from D1 (BS-modeled per-day cost
 * by regime × tier) and D2 (per-trade hedge cost in the trigger replay)
 * into a Deribit-equity-required model across realistic pilot scale
 * scenarios. Answers the operational question "with $X in the Deribit
 * account, how many concurrent biweekly trades can we hold?" and the
 * inverse "to support N concurrent trades, how much equity do we need?"
 *
 * Why this matters
 * ----------------
 * Today's Deribit account: ~$319 (per /pilot/admin/deribit-balance
 * 2026-04-29). Mean hypothetical biweekly hedge cost from D2: $471
 * per trade. The current account can't fund a single representative
 * biweekly trade, let alone a portfolio. Phase 2 (parallel beta) cannot
 * launch without sizing this honestly.
 *
 * Margin model
 * ------------
 * Deribit's cross_sm (cross-margin SM) treats LONG OPTIONS as
 * fully-paid: initial margin = premium paid, maintenance margin = $0
 * (unlike short options or futures which have variation margin). For
 * a long-options-only book (which is what we run — we BUY puts/calls
 * for hedging, never sell), the capital required is roughly the sum
 * of premiums paid across all open positions, in BTC equivalent at
 * current spot.
 *
 * Reference: Deribit cross-margin docs + the current account state
 * showing initialMarginBtc=0 maintenanceMarginBtc=0 with no open
 * positions. As soon as we hold biweekly options, initialMarginBtc
 * will rise to (sum of option premiums paid) × spot equivalent. We
 * model this directly.
 *
 * Headroom adders
 * ---------------
 * Pure premium-sum is the floor. Above that we need:
 *   - 20% buffer for vol-spike repricing (long puts gain value but
 *     long calls lose; cross-margin nets but the conservative side
 *     is the 20% number Deribit recommends in their margin guides)
 *   - 10% buffer for new-trade headroom (so we can open trade N+1
 *     without immediately tripping margin call when N concurrent)
 *   - 50% absolute floor below cap (so Deribit's auto-liquidation
 *     never fires; we want to retain operational discretion)
 *
 * Total recommended account = 1.30 × peak premium-sum × spot
 *
 * Inputs (CLI flags)
 * ------------------
 *   --concurrent N             max concurrent trades to model (default 10)
 *   --notional-mix             spread of trade notional sizes; default
 *                              "weighted-current" mirrors actual pilot
 *                              run-rate (median ~$10k, max $50k)
 *   --regime-mix               weights for low/mod/elev/high; default
 *                              matches D1's 90-day window
 *   --spot-usd                 BTC spot to convert BTC margin → USD
 *                              (default fetches live)
 *   --d1-dataset PATH          read mean hedge cost numbers from D1
 *   --tenor 14                 hedge tenor (must match D1's tenor)
 *
 * Output
 * ------
 *   docs/cfo-report/phase0/capital_requirements.json   (machine-readable)
 *   docs/cfo-report/phase0/capital_requirements.md     (human report)
 *
 * Exit codes:
 *   0 — model written
 *   1 — D1 dataset missing or live spot fetch failed
 *   2 — bad CLI args
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

// ─────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const argFlag = (name: string, fallback?: string): string | undefined => {
  const idx = argv.indexOf(name);
  if (idx === -1) return fallback;
  return argv[idx + 1];
};

const MAX_CONCURRENT = Number(argFlag("--concurrent", "10"));
const TENOR_DAYS = Number(argFlag("--tenor", "14"));
const SPOT_FLAG = argFlag("--spot-usd", "");
const D1_DATASET_DEFAULT = "../../docs/cfo-report/phase0/biweekly_pricing_dataset.json";
const D1_DATASET_PATH = argFlag("--d1-dataset", D1_DATASET_DEFAULT)!;
const OUT_DIR = argFlag("--out-dir", "../../docs/cfo-report/phase0")!;

if (!Number.isFinite(MAX_CONCURRENT) || MAX_CONCURRENT <= 0 || MAX_CONCURRENT > 100) {
  console.error("ERROR: --concurrent must be 1..100");
  process.exit(2);
}
if (!Number.isFinite(TENOR_DAYS) || TENOR_DAYS <= 0 || TENOR_DAYS > 60) {
  console.error("ERROR: --tenor must be 1..60");
  process.exit(2);
}

const log = (msg: string): void => {
  process.stderr.write(`[phase0/d4] ${msg}\n`);
};

// ─────────────────────────────────────────────────────────────────────
// D1 dataset loading
// ─────────────────────────────────────────────────────────────────────

type D1Cell = {
  regime: "low" | "moderate" | "elevated" | "high";
  slPct: 2 | 3 | 5 | 10;
  direction: "long" | "short";
  tenorDays: number;
  sampleCount: number;
  perDayUsdPer1k_mean: number;
  upfrontUsdPer1k_mean: number;
};

type D1Dataset = {
  capturedAt: string;
  inputs: { days: number; tenorDays: number };
  sampleCount: number;
  cells: D1Cell[];
};

const loadD1 = (path: string): D1Dataset | null => {
  if (!existsSync(path)) return null;
  try {
    const j = JSON.parse(readFileSync(path, "utf-8")) as D1Dataset;
    if (!Array.isArray(j?.cells) || j.cells.length === 0) return null;
    return j;
  } catch {
    return null;
  }
};

// ─────────────────────────────────────────────────────────────────────
// Live spot fetch (Deribit perpetual)
// ─────────────────────────────────────────────────────────────────────

const fetchLiveSpot = async (): Promise<number> => {
  const res = await fetch(
    "https://www.deribit.com/api/v2/public/ticker?instrument_name=BTC-PERPETUAL"
  );
  if (!res.ok) throw new Error(`deribit perpetual http ${res.status}`);
  const j: any = await res.json();
  const px = Number(j?.result?.last_price);
  if (!Number.isFinite(px) || px <= 0) throw new Error("invalid spot from deribit");
  return px;
};

// ─────────────────────────────────────────────────────────────────────
// Pilot mix definitions
// ─────────────────────────────────────────────────────────────────────

/**
 * Trade-notional mix mirroring actual pilot run-rate (per the
 * triggered-protections rollup snapshot 2026-04-29: 16 trades with
 * notionals of $10k-$50k, median $10k, mean ~$17.5k).
 */
const NOTIONAL_MIX: Array<{ notionalUsd: number; share: number }> = [
  { notionalUsd: 10000, share: 0.65 },
  { notionalUsd: 15000, share: 0.10 },
  { notionalUsd: 25000, share: 0.10 },
  { notionalUsd: 35000, share: 0.10 },
  { notionalUsd: 50000, share: 0.05 }
];

/**
 * SL tier mix mirroring observed pilot behavior (most trades 2%,
 * occasional 3%, rare 5/10%). Per the triggered-protections rollup
 * 14 of 16 were 2% and 2 were 3%. We add small 5% / 10% weight to be
 * conservative because future trades may shift.
 */
const TIER_MIX: Array<{ slPct: 2 | 3 | 5 | 10; share: number }> = [
  { slPct: 2, share: 0.75 },
  { slPct: 3, share: 0.15 },
  { slPct: 5, share: 0.07 },
  { slPct: 10, share: 0.03 }
];

/**
 * Direction mix observed in the cohort (mostly LONG; some SHORT).
 * Per the rollup: 11 LONG, 5 SHORT, so ~70/30.
 */
const DIRECTION_MIX: Array<{ direction: "long" | "short"; share: number }> = [
  { direction: "long", share: 0.70 },
  { direction: "short", share: 0.30 }
];

/**
 * Regime occupancy mix from D1's 90-day window (low 35.9%,
 * moderate 63.1%, elevated 0.7%, high 0.2%). Since concurrent-portfolio
 * exposure is dominated by the regime we're CURRENTLY in (not the
 * weighted-historical-mix), we model two scenarios:
 *   - "current" — assume we're in the live regime right now
 *   - "stress" — assume high regime (worst-case capital draw)
 */
const HISTORICAL_REGIME_MIX: Record<D1Cell["regime"], number> = {
  low: 0.359,
  moderate: 0.631,
  elevated: 0.007,
  high: 0.002
};

// ─────────────────────────────────────────────────────────────────────
// Per-trade expected hedge cost
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute the expected hedge cost (USD) for a single trade given a
 * regime, using the D1 cell's mean upfront cost per $1k notional and
 * the notional/tier/direction mix.
 *
 * E[hedge_cost] = Σ over (notional, tier, direction) of
 *   share_notional × share_tier × share_direction
 *     × notional / 1000 × upfront_usd_per_1k(regime, tier, direction)
 */
const expectedHedgeCostPerTrade = (
  regime: D1Cell["regime"],
  d1: D1Dataset
): number => {
  let cost = 0;
  for (const n of NOTIONAL_MIX) {
    for (const t of TIER_MIX) {
      for (const d of DIRECTION_MIX) {
        const cell = d1.cells.find(
          (c) => c.regime === regime && c.slPct === t.slPct && c.direction === d.direction
        );
        if (!cell || !Number.isFinite(cell.upfrontUsdPer1k_mean)) continue;
        const tradeCost = (n.notionalUsd / 1000) * cell.upfrontUsdPer1k_mean;
        cost += n.share * t.share * d.share * tradeCost;
      }
    }
  }
  return cost;
};

// ─────────────────────────────────────────────────────────────────────
// Account-equity sizing
// ─────────────────────────────────────────────────────────────────────

/**
 * Given expected per-trade hedge cost in a regime and concurrent
 * trade count, compute the recommended Deribit account equity.
 *
 *   peak_premium_sum_usd    = E[hedge_cost] × concurrent
 *   recommended_account_usd = peak_premium_sum_usd × 1.30
 *     ( 100% to fund the actual premium tied up
 *     +  20% vol-spike buffer
 *     +  10% headroom for new trades )
 */
const recommendedEquity = (perTradeCostUsd: number, concurrent: number): number => {
  return perTradeCostUsd * concurrent * 1.30;
};

// ─────────────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────────────

const fmtUsd = (n: number, places = 0): string =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: places, maximumFractionDigits: places })}`;

const renderMarkdown = (params: {
  capturedAt: string;
  spotUsd: number;
  spotSource: string;
  d1: D1Dataset;
  perTradeByRegime: Record<D1Cell["regime"], number>;
  weightedExpectedPerTrade: number;
  concurrentScenarios: Array<{
    concurrent: number;
    perTradeCostUsd_current: number;
    accountReq_current: number;
    perTradeCostUsd_stress: number;
    accountReq_stress: number;
  }>;
  currentAccountUsd: number;
  currentRegime: D1Cell["regime"];
}): string => {
  const {
    capturedAt,
    spotUsd,
    spotSource,
    d1,
    perTradeByRegime,
    weightedExpectedPerTrade,
    concurrentScenarios,
    currentAccountUsd,
    currentRegime
  } = params;

  const lines: string[] = [];
  lines.push("# Phase 0 D4 — Capital Requirements Model");
  lines.push("");
  lines.push("> Generated by `services/api/scripts/phase0/capital_requirements_model.ts`.");
  lines.push("> Pure analysis. Read-only. No production state changed.");
  lines.push("");
  lines.push(`**Captured:** ${capturedAt}`);
  lines.push(`**Inputs:** D1 pricing dataset (${d1.capturedAt}, ${d1.sampleCount} hourly samples), live BTC spot ${fmtUsd(spotUsd)} via ${spotSource}`);
  lines.push(`**Hedge tenor modeled:** ${TENOR_DAYS} days (matches D1 dataset tenor=${d1.inputs.tenorDays}d)`);
  lines.push(`**Current Deribit account equity (proxy):** ${fmtUsd(currentAccountUsd)} (set via \`--current-account-usd\` or default $319)`);
  lines.push("");
  lines.push("---");
  lines.push("");

  lines.push("## Why this matters");
  lines.push("");
  lines.push(
    "D2 showed biweekly mean hedge cost is ~$471 per trade (vs $17 today on the 1-day product). " +
      "Today's Deribit account equity is ~$319. **The current account cannot fund a single representative " +
      "biweekly trade, let alone a portfolio.** This deliverable sizes that gap."
  );
  lines.push("");

  // ── Margin model ──
  lines.push("## Margin model");
  lines.push("");
  lines.push("Deribit `cross_sm` (cross-margin SM) treats LONG options as fully-paid:");
  lines.push("");
  lines.push("- Initial margin = premium paid (USD-denominated, in BTC at the time of purchase)");
  lines.push("- Maintenance margin = 0 (unlike futures or short options)");
  lines.push("- Cross-margin nets across positions: long puts ↔ long calls partially offset on vol moves");
  lines.push("");
  lines.push(
    "We hedge by BUYING puts (for LONG protection) and BUYING calls (for SHORT protection). We never " +
      "SELL options, so we never have variation margin or assignment risk on our hedge book. Capital " +
      "required is roughly the sum of premiums currently paid across all open positions."
  );
  lines.push("");
  lines.push("**Headroom adders on top of premium-sum:**");
  lines.push("");
  lines.push("- 20% vol-spike buffer (Deribit's recommended cross-margin headroom)");
  lines.push("- 10% new-trade headroom (so trade N+1 doesn't trip margin call when N concurrent)");
  lines.push("- **Total recommended equity = 1.30 × peak premium-sum**");
  lines.push("");

  // ── Per-trade cost by regime ──
  lines.push("## Expected per-trade hedge cost by regime");
  lines.push("");
  lines.push("Computed as the weighted average over the pilot's observed notional × tier × direction mix:");
  lines.push("");
  lines.push("- **Notional mix:** $10k 65%, $15k 10%, $25k 10%, $35k 10%, $50k 5% (matches 16-trade cohort run-rate)");
  lines.push("- **Tier mix:** 2% 75%, 3% 15%, 5% 7%, 10% 3% (mostly 2% per cohort, conservative weight on wider tiers)");
  lines.push("- **Direction mix:** LONG 70%, SHORT 30% (matches 11/5 split in cohort)");
  lines.push("");
  lines.push("| Regime | Expected per-trade hedge cost |");
  lines.push("|---|---|");
  for (const r of ["low", "moderate", "elevated", "high"] as const) {
    lines.push(`| ${r} | ${fmtUsd(perTradeByRegime[r], 0)} |`);
  }
  lines.push(`| **historical-weighted avg** | **${fmtUsd(weightedExpectedPerTrade, 0)}** |`);
  lines.push("");
  lines.push(
    "Historical-weighted is a 90-day blend (35.9% low, 63.1% moderate, 0.7% elevated, 0.2% high). " +
      "Useful for long-run cost projections but **not** for capital sizing — the relevant question for " +
      "capital is 'what regime are we IN right now' and 'how bad does it get in stress'."
  );
  lines.push("");

  // ── Concurrent scaling — current regime ──
  lines.push("## Recommended account equity by concurrent-trade count");
  lines.push("");
  lines.push(
    `Two scenarios for each concurrent count: **current regime** (${currentRegime}, what we're in right ` +
      "now) and **stress regime** (high, worst-case capital draw). Recommended equity = 1.30 × concurrent " +
      "× per-trade cost in that regime."
  );
  lines.push("");
  lines.push("| Concurrent trades | Current regime cost / trade | Current regime account req | Stress (high) cost / trade | Stress account req |");
  lines.push("|---|---|---|---|---|");
  for (const s of concurrentScenarios) {
    lines.push(
      `| ${s.concurrent} | ${fmtUsd(s.perTradeCostUsd_current, 0)} | **${fmtUsd(s.accountReq_current, 0)}** | ${fmtUsd(s.perTradeCostUsd_stress, 0)} | **${fmtUsd(s.accountReq_stress, 0)}** |`
    );
  }
  lines.push("");

  // ── Today's account analysis ──
  lines.push("## Where today's account stands");
  lines.push("");
  const currentRegimePerTrade = perTradeByRegime[currentRegime];
  const concurrentSupportedCurrent = Math.floor(currentAccountUsd / (currentRegimePerTrade * 1.30));
  const concurrentSupportedStress = Math.floor(currentAccountUsd / (perTradeByRegime.high * 1.30));
  lines.push(`Current account equity: ${fmtUsd(currentAccountUsd)}`);
  lines.push(`Per-trade cost in current (${currentRegime}) regime: ${fmtUsd(currentRegimePerTrade, 0)}`);
  lines.push(`Per-trade cost in stress regime: ${fmtUsd(perTradeByRegime.high, 0)}`);
  lines.push("");
  lines.push(
    `**Current account supports ${concurrentSupportedCurrent} concurrent biweekly trade${concurrentSupportedCurrent === 1 ? "" : "s"} ` +
      `in the current regime, ${concurrentSupportedStress} in stress.**`
  );
  lines.push("");
  if (concurrentSupportedCurrent < 3) {
    lines.push(
      "_The pilot has averaged 2-3 concurrent active protections in recent weeks. Today's account " +
        "is at or below the floor for running biweekly at pilot scale even in calm regime. **Funding up " +
        "is a prerequisite for Phase 2 (parallel beta).**_"
    );
  }
  lines.push("");

  // ── Phased funding plan ──
  lines.push("## Recommended phased funding plan");
  lines.push("");
  lines.push(
    "These are **floor numbers** — fund at least this much before the corresponding pilot phase. The " +
      "20% vol-spike buffer is included; we can tune up further for additional safety margin."
  );
  lines.push("");
  lines.push("| Phase | Concurrent biweekly trades supported | Account equity needed (worst case = stress regime) |");
  lines.push("|---|---|---|");
  for (const concurrent of [1, 2, 3, 5, 8, 10] as const) {
    const stressReq = recommendedEquity(perTradeByRegime.high, concurrent);
    const tag =
      concurrent === 1
        ? " — single-trade smoke test"
        : concurrent === 3
        ? " — current pilot run-rate"
        : concurrent === 5
        ? " — Phase 2 beta target"
        : concurrent === 10
        ? " — Phase 3 production target"
        : "";
    lines.push(`| ${concurrent} concurrent${tag} | ${concurrent} | ${fmtUsd(stressReq, 0)} |`);
  }
  lines.push("");

  // ── Caveats ──
  lines.push("## Caveats and what this does NOT model");
  lines.push("");
  lines.push("- **Regime dynamics during a concurrent portfolio.** A regime spike during open trades can");
  lines.push("  inflate the mark-to-market value of long puts (good) and decay long calls (bad). Cross-margin");
  lines.push("  nets but the conservative side dominates short-term margin. The 20% buffer covers ~1-sigma vol");
  lines.push("  spikes; not 3-sigma tail events.");
  lines.push("- **Withdrawals / deposit timing.** Deribit settles instantly but deposits take 1-2 confirmations.");
  lines.push("  Don't run at the floor; keep at least 30-50% slack for operational deposits.");
  lines.push("- **PnL on the hedge book itself.** Recovered hedge proceeds (when triggers fire and we sell)");
  lines.push("  feed back into account equity. D2 showed mean recovery $610/trade; this is a positive cash");
  lines.push("  flow that grows the account over time. We're not modeling that compounding here.");
  lines.push("- **Concurrent exposure correlation.** All trades are on BTC. A 5% spot move hits every open");
  lines.push("  trade simultaneously. The model assumes independent trades for cost-summation purposes; that's");
  lines.push("  the right framing for INITIAL margin (premium-sum) but not for variation in stress.");
  lines.push("");

  return lines.join("\n");
};

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

const ensureDir = (path: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(path, { recursive: true });
};

const main = async (): Promise<void> => {
  log(`starting capital requirements model (concurrent up to ${MAX_CONCURRENT}, tenor ${TENOR_DAYS}d)`);

  log(`loading D1 dataset from ${D1_DATASET_PATH}…`);
  const d1 = loadD1(D1_DATASET_PATH);
  if (!d1) {
    log(`ERROR: D1 dataset missing or invalid at ${D1_DATASET_PATH}`);
    log("Run `npm run pilot:phase0:d1:biweekly-pricing` first, OR pass --d1-dataset PATH.");
    process.exit(1);
  }
  if (d1.inputs.tenorDays !== TENOR_DAYS) {
    log(
      `WARNING: D1 tenor=${d1.inputs.tenorDays}d but D4 modeling at ${TENOR_DAYS}d. ` +
        "Numbers are still informative but per-trade cost may not match a re-run of D1 at this tenor."
    );
  }
  log(`  → loaded ${d1.cells.length} D1 cells (${d1.sampleCount} hourly samples)`);

  let spotUsd: number;
  let spotSource = "deribit perpetual ticker";
  if (SPOT_FLAG && Number.isFinite(Number(SPOT_FLAG))) {
    spotUsd = Number(SPOT_FLAG);
    spotSource = "--spot-usd flag";
  } else {
    log("fetching live BTC spot…");
    try {
      spotUsd = await fetchLiveSpot();
      log(`  → spot ${fmtUsd(spotUsd)}`);
    } catch (e: any) {
      log(`ERROR: live spot fetch failed: ${e?.message}. Pass --spot-usd N to override.`);
      process.exit(1);
    }
  }

  // Per-trade hedge cost by regime
  const perTradeByRegime: Record<D1Cell["regime"], number> = {
    low: expectedHedgeCostPerTrade("low", d1),
    moderate: expectedHedgeCostPerTrade("moderate", d1),
    elevated: expectedHedgeCostPerTrade("elevated", d1),
    high: expectedHedgeCostPerTrade("high", d1)
  };
  const weightedExpectedPerTrade =
    perTradeByRegime.low * HISTORICAL_REGIME_MIX.low +
    perTradeByRegime.moderate * HISTORICAL_REGIME_MIX.moderate +
    perTradeByRegime.elevated * HISTORICAL_REGIME_MIX.elevated +
    perTradeByRegime.high * HISTORICAL_REGIME_MIX.high;

  // Detect current regime from the DVOL of the most recent D1 sample.
  // The D1 dataset doesn't include the latest DVOL directly, but we can
  // approximate from the cells' dvolMean for low (since live DVOL is
  // ~39 = low). For the report we explicitly fetch live DVOL.
  log("fetching live DVOL for current-regime classification…");
  let currentRegime: D1Cell["regime"] = "low";
  try {
    const res = await fetch(
      "https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&resolution=3600&start_timestamp=" +
        (Date.now() - 7200000) +
        "&end_timestamp=" +
        Date.now()
    );
    const j: any = await res.json();
    const rows: any[] = j?.result?.data ?? [];
    const lastDvol = Number(rows[rows.length - 1]?.[4]);
    if (Number.isFinite(lastDvol)) {
      log(`  → current DVOL ${lastDvol.toFixed(2)}`);
      currentRegime =
        lastDvol < 50 ? "low" : lastDvol < 65 ? "moderate" : lastDvol < 80 ? "elevated" : "high";
      log(`  → classified as '${currentRegime}'`);
    }
  } catch (e: any) {
    log(`WARNING: DVOL fetch failed (${e?.message}); defaulting current regime to 'low'`);
  }

  // Concurrent scenarios from 1 → MAX_CONCURRENT
  const concurrentScenarios = Array.from({ length: MAX_CONCURRENT }, (_, i) => i + 1).map((c) => ({
    concurrent: c,
    perTradeCostUsd_current: perTradeByRegime[currentRegime],
    accountReq_current: recommendedEquity(perTradeByRegime[currentRegime], c),
    perTradeCostUsd_stress: perTradeByRegime.high,
    accountReq_stress: recommendedEquity(perTradeByRegime.high, c)
  }));

  // Today's account proxy
  const currentAccountUsd = Number(argFlag("--current-account-usd", "319"));

  ensureDir(OUT_DIR);
  const capturedAt = new Date().toISOString();
  const jsonPath = join(OUT_DIR, "capital_requirements.json");
  const mdPath = join(OUT_DIR, "capital_requirements.md");

  const dataset = {
    capturedAt,
    inputs: {
      tenorDays: TENOR_DAYS,
      maxConcurrent: MAX_CONCURRENT,
      d1DatasetPath: D1_DATASET_PATH,
      currentAccountUsd
    },
    spot: { usd: spotUsd, source: spotSource },
    currentRegime,
    perTradeHedgeCostByRegime: perTradeByRegime,
    weightedExpectedPerTradeUsd: weightedExpectedPerTrade,
    concurrentScenarios,
    margin: {
      model: "deribit_cross_sm",
      headroomMultiplier: 1.30,
      headroomBreakdown: { volSpikeBufferPct: 20, newTradeHeadroomPct: 10 }
    },
    pilotMix: {
      notional: NOTIONAL_MIX,
      tier: TIER_MIX,
      direction: DIRECTION_MIX,
      historicalRegime: HISTORICAL_REGIME_MIX
    }
  };
  writeFileSync(jsonPath, JSON.stringify(dataset, null, 2) + "\n");
  log(`wrote ${jsonPath}`);

  const md = renderMarkdown({
    capturedAt,
    spotUsd,
    spotSource,
    d1,
    perTradeByRegime,
    weightedExpectedPerTrade,
    concurrentScenarios,
    currentAccountUsd,
    currentRegime
  });
  writeFileSync(mdPath, md);
  log(`wrote ${mdPath}`);

  log("done.");
};

main().catch((e) => {
  log(`fatal: ${e?.message ?? e}`);
  process.exit(1);
});
