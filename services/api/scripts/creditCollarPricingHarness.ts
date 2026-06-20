#!/usr/bin/env tsx
/**
 * Credit-collar pricing harness — Render entrypoint (READ/QUOTE-ONLY, NO trading).
 *
 * On a single run: pulls live public quotes from Bullish + Deribit + OKX, captures option wing
 * half-spreads (per tenor, prioritizing daily) + the daily-option-listing answer + perp depth/impact
 * at the ramp clip sizes, then feeds the existing solver/comparison/Model-B and prints the report:
 *   measured spreads/depth · daily listing · $50k/$<fee> credit+feasibility · service-fee-survives
 *   verdict per ramp tier · routing recommendation · Tier-1 greenlight flag.
 *
 * Fee is PARAMETERIZED: set HARNESS_FEE_USDC=75 when Foxify confirms. Run:
 *   HARNESS_FEE_USDC=75 npm run -w @foxify/api harness:pricing
 */

import { buildDataset, type WingCaptureConfig } from "../src/singleSide/twoSided/creditCollar/pricingHarness/capture";
import { captureLive } from "../src/singleSide/twoSided/creditCollar/pricingHarness/liveFetchers";
import { runPricingReport, type HarnessReportConfig } from "../src/singleSide/twoSided/creditCollar/pricingHarness/report";

const num = (v: string | undefined, d: number) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);

const wingCfg: WingCaptureConfig = {
  floorPcts: [0.03, 0.04, 0.05],
  capPcts: [0.01, 0.015, 0.02, 0.025],
  tenorsDays: [1, 2, 7],
  dailyMaxHours: 30
};

const rampTiersDailyUsd = [100_000, 1_000_000, 5_000_000, 25_000_000, 50_000_000];
const peakResidualPct = num(process.env.HARNESS_PEAK_RESIDUAL_PCT, 0.11);
const clipsUsd = rampTiersDailyUsd.map((t) => t * peakResidualPct);

const reportCfg: HarnessReportConfig = {
  positionNotionalUsdc: num(process.env.HARNESS_POSITION_USDC, 50_000),
  feeUsdc: process.env.HARNESS_FEE_USDC != null ? Number(process.env.HARNESS_FEE_USDC) : null,
  serviceFeeBps: num(process.env.HARNESS_SERVICE_FEE_BPS, 2),
  minServiceFeeUsdc: num(process.env.HARNESS_MIN_SERVICE_FEE_USDC, 10),
  tenorDays: num(process.env.HARNESS_TENOR_DAYS, 1),
  maxFloorPct: num(process.env.HARNESS_MAX_FLOOR_PCT, 0.04),
  rampTiersDailyUsd,
  peakResidualPct,
  reserveMultiple: num(process.env.HARNESS_RESERVE_MULTIPLE, 1.5),
  costOfCapitalAnnual: num(process.env.HARNESS_COC_ANNUAL, 0.12),
  stressJumpPct: num(process.env.HARNESS_STRESS_JUMP_PCT, 0.12),
  intradayTimingBufferPct: num(process.env.HARNESS_TIMING_BUFFER_PCT, 0.25),
  routing: { bullishWeight: num(process.env.HARNESS_BULLISH_WEIGHT, 0.15), materialMarginPct: num(process.env.HARNESS_MATERIAL_MARGIN_PCT, 0.2) }
};

const main = async () => {
  console.error("[harness] capturing live public quotes (Bullish + Deribit + OKX), quote-only…");
  const live = await captureLive(wingCfg);
  const dataset = buildDataset(live.optionSnapshots, live.perpSnapshots, wingCfg, clipsUsd);
  // Bullish daily-listing observation comes from the markets feed (orderbook quotes may be absent).
  dataset.dailyListing.bullish = dataset.dailyListing.bullish || live.bullishDailyListingObserved;

  const report = runPricingReport(dataset, reportCfg);
  const out = { fetchErrors: live.errors, dataset: { options: dataset.options, perp: dataset.perp, dailyListing: dataset.dailyListing, venuesSeen: dataset.venuesSeen }, report };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");

  console.error(`[harness] greenlightTier1=${report.greenlightTier1} blockers=${report.blockers.length}`);
  if (live.errors.length) console.error(`[harness] venue fetch errors: ${live.errors.map((e) => `${e.venue}/${e.feed}: ${e.error}`).join("; ")}`);
};

main().catch((e) => {
  console.error("[harness] fatal:", e);
  process.exit(1);
});
