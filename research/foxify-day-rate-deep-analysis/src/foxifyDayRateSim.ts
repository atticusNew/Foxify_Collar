/**
 * Foxify day-rate simulator.
 *
 * For each (entry date × SL tier × position size × strike geometry) combination,
 * simulate the protection lifecycle:
 *
 *   Day 0: Atticus buys a 14-day Deribit put spread at user entry. User pays
 *          daily fee starting today.
 *   Each subsequent day: check if BTC's daily LOW crossed the SL trigger
 *          threshold (entry × (1 - SL%)). If yes:
 *            - User receives instant payout: SL% × notional
 *            - Atticus sells the put spread back to Deribit at intrinsic value
 *              (capped at spread width, minus 5% bid-ask haircut for the unwind)
 *            - Atticus net P&L on this trigger = TP recovery − SL payout − option entry cost (already paid)
 *            - Position closes
 *   If 7 days pass without trigger: position closes.
 *            - Atticus sells residual option spread (mostly time value remaining)
 *              minus 5% haircut.
 *
 * Per-position-day Atticus cash flow:
 *   IN:  user daily fee
 *   OUT: 0 (option already bought at entry; theta is opportunity cost, not cash)
 * On position close (trigger or expiry):
 *   IN:  TP recovery from Deribit
 *   OUT: SL payout to user (only if trigger fired)
 *
 * Strike geometry options tested per tier:
 *   "ITM_long":  long leg 1% closer to spot than the SL threshold
 *                (so when SL fires, the option is already in-the-money by 1%
 *                 of spot → TP recovery is meaningful)
 *   "ATM_long":  long leg exactly at the SL threshold
 *                (option is right at-the-money when SL fires; intrinsic ≈ 0,
 *                 TP recovery = remaining time value)
 *   "OTM_long":  long leg 1% past the SL threshold
 *                (option just barely engaged at SL; minimal TP recovery)
 * Short leg: always 5% below the long leg.
 *
 * Pricing: BS-theoretical with rvol-derived IV (rvol × 1.10) + skew (0.20 vol-pts/% OTM).
 * Validated against live Deribit chain in the broader synfutures package.
 */

import { putSpreadCost, bsPut, realizedVolN } from "./math.js";
import type { DailyOhlc } from "./fetchPrices.js";

// ─── Config ──────────────────────────────────────────────────────────────────

export const SL_TIERS = [0.02, 0.03, 0.05, 0.10] as const;
export type SlTier = typeof SL_TIERS[number];

export const POSITION_SIZES = [10_000, 25_000, 50_000] as const;

export const STRIKE_GEOMETRIES = ["ITM_long", "ATM_long", "OTM_long"] as const;
export type StrikeGeometry = typeof STRIKE_GEOMETRIES[number];

export const HEDGE_TENOR_DAYS = 14;
export const HOLD_WINDOW_DAYS = 7;
export const RISK_FREE_RATE = 0.045;
export const IV_OVER_RVOL = 1.10;
export const SKEW_SLOPE = 0.20;
export const UNWIND_HAIRCUT = 0.05;

// ─── Types ───────────────────────────────────────────────────────────────────

export type SimRow = {
  entryDate: string;
  slTier: SlTier;
  positionSizeUsd: number;
  strikeGeometry: StrikeGeometry;
  rvolAtEntry: number;
  vol_regime: "calm" | "moderate" | "high" | "stress";
  spotAtEntry: number;
  K_long: number;
  K_short: number;
  spreadWidth: number;
  // Atticus economics
  optionEntryCostUsd: number;       // Atticus pays Deribit at entry
  // Outcome
  triggered: boolean;
  daysToTrigger: number;            // 1..HOLD_WINDOW_DAYS, or HOLD_WINDOW_DAYS+1 if no trigger
  triggerSpot: number;              // 0 if no trigger
  slPayoutToUserUsd: number;        // 0 if no trigger
  tpRecoveryUsd: number;            // recovered from selling option back to Deribit
  // Daily fee accumulation
  daysActive: number;               // = daysToTrigger if triggered, else HOLD_WINDOW_DAYS
};

// ─── Strike construction per tier × geometry ────────────────────────────────

export function strikesFor(spot: number, slTier: SlTier, geometry: StrikeGeometry): { K_long: number; K_short: number } {
  const slDrop = spot * slTier;
  // SL trigger spot = spot - slDrop (for a long position; user loses if BTC < trigger)
  // Strike geometry positions long-leg relative to that trigger:
  //   ITM_long: long leg 1% above SL threshold (closer to spot, more expensive)
  //   ATM_long: long leg exactly at SL threshold
  //   OTM_long: long leg 1% below SL threshold (further OTM, cheaper but less TP recovery)
  let K_long: number;
  switch (geometry) {
    case "ITM_long": K_long = spot - slDrop + spot * 0.01; break;
    case "ATM_long": K_long = spot - slDrop; break;
    case "OTM_long": K_long = spot - slDrop - spot * 0.01; break;
  }
  const K_short = K_long - spot * 0.05;  // 5% spread width below long leg
  return { K_long, K_short };
}

// ─── Vol regime classification ───────────────────────────────────────────────

export function classifyRegime(rvol: number): "calm" | "moderate" | "high" | "stress" {
  if (rvol < 0.40) return "calm";
  if (rvol < 0.65) return "moderate";
  if (rvol < 0.90) return "high";
  return "stress";
}

// ─── Simulate one position ──────────────────────────────────────────────────

export function simulateOne(args: {
  entryIdx: number;
  ohlc: DailyOhlc[];
  closes: number[];
  slTier: SlTier;
  positionSizeUsd: number;
  strikeGeometry: StrikeGeometry;
}): SimRow | null {
  const { entryIdx, ohlc, closes, slTier, positionSizeUsd, strikeGeometry } = args;
  if (entryIdx + HOLD_WINDOW_DAYS >= ohlc.length) return null;

  const entry = ohlc[entryIdx];
  const spotAtEntry = entry.close;
  const triggerSpot = spotAtEntry * (1 - slTier);

  const { K_long, K_short } = strikesFor(spotAtEntry, slTier, strikeGeometry);
  const spreadWidth = K_long - K_short;

  // Realized vol → IV
  const rvol = entryIdx >= 5 ? realizedVolN(closes, entryIdx, 30) : 0.55;
  const regime = classifyRegime(rvol);
  const atmIv = rvol * IV_OVER_RVOL;
  const otmLong = Math.max(0, (spotAtEntry - K_long) / spotAtEntry);
  const otmShort = Math.max(0, (spotAtEntry - K_short) / spotAtEntry);
  const ivLong = atmIv + SKEW_SLOPE * otmLong;
  const ivShort = atmIv + SKEW_SLOPE * otmShort;

  // Initial option cost: priced at spot, on a 1-BTC notional basis × position size.
  // We hedge with notional matched to position size (1× sizing — matches the
  // current Foxify design where SL payout = SL% × notional and the option
  // intrinsic at trigger ≈ same fraction of notional).
  const T = HEDGE_TENOR_DAYS / 365;
  const optionPxPerSpot = putSpreadCost(spotAtEntry, K_long, K_short, T, RISK_FREE_RATE, ivLong, ivShort);
  const optionEntryCostUsd = (optionPxPerSpot / spotAtEntry) * positionSizeUsd;

  // Walk forward day-by-day, check trigger.
  let triggered = false;
  let daysToTrigger = HOLD_WINDOW_DAYS + 1;
  let triggerSpotActual = 0;
  let slPayoutToUserUsd = 0;
  let tpRecoveryUsd = 0;
  for (let d = 1; d <= HOLD_WINDOW_DAYS; d++) {
    const day = ohlc[entryIdx + d];
    if (!day) break;
    if (day.low <= triggerSpot) {
      triggered = true;
      daysToTrigger = d;
      // Conservative: trigger price = the SL threshold itself (instant payout based
      // on declared SL%, regardless of how much further BTC fell intra-day).
      triggerSpotActual = triggerSpot;
      slPayoutToUserUsd = positionSizeUsd * slTier;
      // TP recovery: sell put spread back at intrinsic + remaining time value.
      // Approximation: option value at trigger ≈ intrinsic at the trigger spot
      // plus residual time-decay value. Use BS at remaining tenor.
      const remainingTenor = (HEDGE_TENOR_DAYS - d) / 365;
      // Re-price at the trigger spot.
      const optPxAtTrigger = putSpreadCost(
        triggerSpotActual, K_long, K_short, remainingTenor, RISK_FREE_RATE, ivLong, ivShort
      );
      const grossTp = (optPxAtTrigger / spotAtEntry) * positionSizeUsd;
      tpRecoveryUsd = grossTp * (1 - UNWIND_HAIRCUT);
      break;
    }
  }
  // No trigger: position closes after HOLD_WINDOW_DAYS. Sell residual.
  if (!triggered) {
    const day = ohlc[entryIdx + HOLD_WINDOW_DAYS];
    const closeSpot = day?.close ?? spotAtEntry;
    const remainingTenor = (HEDGE_TENOR_DAYS - HOLD_WINDOW_DAYS) / 365;
    const optPxAtClose = putSpreadCost(
      closeSpot, K_long, K_short, remainingTenor, RISK_FREE_RATE, ivLong, ivShort
    );
    const grossTp = (optPxAtClose / spotAtEntry) * positionSizeUsd;
    tpRecoveryUsd = grossTp * (1 - UNWIND_HAIRCUT);
  }

  return {
    entryDate: entry.date,
    slTier,
    positionSizeUsd,
    strikeGeometry,
    rvolAtEntry: rvol,
    vol_regime: regime,
    spotAtEntry,
    K_long,
    K_short,
    spreadWidth,
    optionEntryCostUsd,
    triggered,
    daysToTrigger,
    triggerSpot: triggerSpotActual,
    slPayoutToUserUsd,
    tpRecoveryUsd,
    daysActive: triggered ? daysToTrigger : HOLD_WINDOW_DAYS,
  };
}

// ─── Atticus economics per row given a daily fee ─────────────────────────────

export type EconomicsForFee = {
  atticusRevenueUsd: number;       // user fees collected over daysActive
  atticusOutflowUsd: number;       // option entry cost + SL payout (if any)
  atticusInflowUsd: number;        // TP recovery
  atticusNetPnlUsd: number;        // revenue + inflow - outflow
};

/**
 * Given a sim row and a daily fee (USD per day), compute Atticus's net P&L
 * for that position.
 *
 *   Atticus net = (dailyFee × daysActive)
 *               + tpRecoveryUsd
 *               − optionEntryCostUsd
 *               − slPayoutToUserUsd
 */
export function applyDailyFee(row: SimRow, dailyFeeUsd: number): EconomicsForFee {
  const atticusRevenueUsd = dailyFeeUsd * row.daysActive;
  const atticusOutflowUsd = row.optionEntryCostUsd + row.slPayoutToUserUsd;
  const atticusInflowUsd = row.tpRecoveryUsd;
  const atticusNetPnlUsd = atticusRevenueUsd + atticusInflowUsd - atticusOutflowUsd;
  return { atticusRevenueUsd, atticusOutflowUsd, atticusInflowUsd, atticusNetPnlUsd };
}
