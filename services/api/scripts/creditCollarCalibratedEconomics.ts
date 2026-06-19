#!/usr/bin/env tsx
/**
 * Model-B CALIBRATED ECONOMICS — pure/offline. Feeds the MEASURED short-option initial margin (from
 * the Deribit margin sweep) into simulateModelBVolume and prints the capital-aware economics, plus an
 * isolated-vs-Portfolio-Margin comparison so the venue/account decision is quantified.
 *
 * The short-option IM is the binding capital constraint (a delta-flat OPTIONS book still posts IM on
 * BOTH short wings unless Portfolio Margin nets them), so this is the number that actually sizes
 * Atticus's capital — not the premium flow.
 *
 *   MODELB_SHORT_OPTION_IM_FRACTION=0.1393 MODELB_SHORT_OPTION_GROSS_FRACTION=1.0 \
 *   MODELB_PM_NETTING=0.45 MODELB_DAILY_NOTIONAL=50000000 MODELB_SERVICE_FEE_BPS=2 \
 *   npm --silent --workspace services/api run modelb:calibrated | jq .
 */

import { simulateModelBVolume, type ModelBConfig } from "../src/singleSide/twoSided/creditCollar/modelBVolumeSim";

const num = (v: string | undefined, d: number) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);

const baseCfg = (over: Partial<ModelBConfig>): ModelBConfig => ({
  dailyNotionalUsdc: num(process.env.MODELB_DAILY_NOTIONAL, 50_000_000),
  avgPositionNotionalUsdc: num(process.env.MODELB_AVG_POSITION, 50_000),
  spot: num(process.env.MODELB_SPOT, 63_265),
  tenorDays: num(process.env.MODELB_TENOR_DAYS, 1),
  maxFloorPct: num(process.env.MODELB_MAX_FLOOR_PCT, 0.04),
  atmIv: num(process.env.MODELB_ATM_IV, 0.55),
  skewSlopePer10pct: num(process.env.MODELB_SKEW_SLOPE, 0.12),
  serviceFeeBps: num(process.env.MODELB_SERVICE_FEE_BPS, 2.0),
  minServiceFeeUsdc: num(process.env.MODELB_MIN_SERVICE_FEE, 10),
  creditBpsOfNotional: num(process.env.MODELB_CREDIT_BPS, 20),
  steerComplianceProb: num(process.env.MODELB_STEER_COMPLIANCE, 0.95),
  flowStreakiness: num(process.env.MODELB_FLOW_STREAKINESS, 0.7),
  targetNetBandPct: num(process.env.MODELB_TARGET_BAND, 0.1),
  perpTopOfBookBps: num(process.env.MODELB_PERP_TOB_BPS, 1.5),
  perpDepthUsdc: num(process.env.MODELB_PERP_DEPTH, 5_000_000),
  perpImpactCoefBps: num(process.env.MODELB_PERP_IMPACT_COEF, 1.0),
  dailyRehedgeTurnover: num(process.env.MODELB_REHEDGE_TURNOVER, 2),
  reserveMultiple: num(process.env.MODELB_RESERVE_MULTIPLE, 1.5),
  costOfCapitalAnnual: num(process.env.MODELB_COST_OF_CAPITAL, 0.12),
  stressJumpPct: num(process.env.MODELB_STRESS_JUMP, 0.12),
  intradayTimingBufferPct: num(process.env.MODELB_TIMING_BUFFER, 0.25),
  maxDirectionalExposureBand: num(process.env.MODELB_MAX_DIR_BAND, 0.15),
  days: num(process.env.MODELB_DAYS, 250),
  seed: num(process.env.MODELB_SEED, 42),
  ...over
});

const summarize = (label: string, r: ReturnType<typeof simulateModelBVolume>) => {
  if (!r.ok) return { label, error: r.error };
  return {
    label,
    verdict: r.verdict,
    shortOptionMarginUsdc: r.shortOptionMarginUsdc,
    shortOptionMarginCostPerDayUsdc: r.shortOptionMarginCostPerDayUsdc,
    jumpReserveUsdc: +(r.reserveUsdc - r.shortOptionMarginUsdc).toFixed(2),
    totalReserveUsdc: r.reserveUsdc,
    serviceFeeRevenuePerDayUsdc: r.serviceFeeRevenuePerDayUsdc,
    perpHedgeCostPerDayUsdc: r.perpHedgeCostPerDayUsdc,
    reserveCapitalCostPerDayUsdc: r.reserveCapitalCostPerDayUsdc,
    netServiceRevenuePerDayUsdc: r.netServiceRevenuePerDayUsdc,
    annualizedNetUsdc: r.annualizedNetUsdc,
    annualizedNetBps: r.annualizedNetBps
  };
};

const main = () => {
  const imFraction = num(process.env.MODELB_SHORT_OPTION_IM_FRACTION, 0.1393); // sweep conservative (worst observed)
  const grossFraction = num(process.env.MODELB_SHORT_OPTION_GROSS_FRACTION, 1.0); // 24h tenor ⟹ ~full open book carries short-leg IM
  const pmNetting = num(process.env.MODELB_PM_NETTING, 0.45); // portfolio-margin offset of long vs short wing

  const isolated = simulateModelBVolume(baseCfg({ shortOptionImFraction: imFraction, shortOptionGrossNotionalFraction: grossFraction, portfolioMarginNettingFactor: 1.0 }));
  const portfolio = simulateModelBVolume(baseCfg({ shortOptionImFraction: imFraction, shortOptionGrossNotionalFraction: grossFraction, portfolioMarginNettingFactor: pmNetting }));
  const perpOnly = simulateModelBVolume(baseCfg({})); // legacy: no option-margin capital booked

  const out = {
    measuredInputs: { shortOptionImFraction: imFraction, shortOptionGrossNotionalFraction: grossFraction, portfolioMarginNettingFactor: pmNetting, source: "Deribit get_margins sweep" },
    scenarios: {
      perp_residual_only: summarize("perp_residual_only (no option-margin capital)", perpOnly),
      isolated_or_multiccy_margin: summarize("isolated/multi-ccy (no wing netting)", isolated),
      portfolio_margin: summarize(`portfolio_margin (netting ${pmNetting})`, portfolio)
    },
    portfolioMarginSavingsPerDayUsdc: isolated.ok && portfolio.ok ? +(portfolio.netServiceRevenuePerDayUsdc - isolated.netServiceRevenuePerDayUsdc).toFixed(2) : null,
    note: "Set MODELB_SHORT_OPTION_GROSS_FRACTION to the share of daily gross simultaneously carried as short options (≈1.0 for ~24h tenor, lower if perp-hedging more of the residual)."
  };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  if (isolated.ok && portfolio.ok) {
    console.error(`[calibrated] short-leg IM capital: isolated $${isolated.shortOptionMarginUsdc.toLocaleString()} → PM $${portfolio.shortOptionMarginUsdc.toLocaleString()}`);
    console.error(`[calibrated] net service rev/day: perp-only $${(perpOnly.ok ? perpOnly.netServiceRevenuePerDayUsdc : 0).toLocaleString()} | isolated $${isolated.netServiceRevenuePerDayUsdc.toLocaleString()} | PM $${portfolio.netServiceRevenuePerDayUsdc.toLocaleString()}`);
    console.error(`[calibrated] PM saves $${out.portfolioMarginSavingsPerDayUsdc?.toLocaleString()}/day vs isolated. verdicts: isolated=${isolated.verdict} pm=${portfolio.verdict}`);
  }
};

main();
