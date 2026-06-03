/**
 * Option structures — the single source of truth for how each hedge structure is
 * priced and valued. Lets the MC + sweep compare the two-sided straddle against
 * cheaper directional structures (one-sided protection, collar).
 *
 * Approach (A) — we model the HEDGE OPTION LEGS only. The protected position (Foxify's
 * directional perp bet) is Foxify's own P&L and is NOT modeled here; this module answers
 * "what does the hedge cost / how does it decay / what does it pay" so structures are
 * comparable apples-to-apples.
 *
 *   straddle / strangle / straddle_gamma_scalp : long put + long call   (value = P + C)
 *   one_sided_put                              : long put               (value = P)
 *   one_sided_call                             : long call              (value = C)
 *   collar                                     : long put − SHORT call  (value = P − C)
 *
 * The collar's short call makes it DIRECTIONAL (loses if spot rallies past the short
 * strike) but ~theta-neutral (short-call decay offsets long-put decay) — exactly the
 * "protect one side without paying a guaranteed-losing two-sided hedge" idea.
 */

import { bsPut, bsCall } from "../../../scripts/backtest/singleSide/coreEngine";

export type OptionStructure =
  | "strangle"
  | "straddle"
  | "straddle_gamma_scalp"
  | "one_sided_put"
  | "one_sided_call"
  | "collar"
  | "vertical_spread_call"   // bull call DEBIT spread: long call @ callStrike − short call @ shortStrike(OTM up)
  | "vertical_spread_put";   // bear put DEBIT spread: long put @ putStrike − short put @ shortStrike(OTM down)

const RFR = Number(process.env.BS_RISK_FREE_RATE ?? "0.045");
const MS_PER_YEAR = 365 * 86_400_000;

/** Is this a two-long-legs structure (put + call)? */
const isTwoLeg = (s: OptionStructure): boolean =>
  s === "strangle" || s === "straddle" || s === "straddle_gamma_scalp";

/**
 * Per-structure option value (USDC) at a hypothetical path spot, via Black-Scholes ×
 * realism. The short call in a collar is a LIABILITY (subtracted) → value falls as spot
 * rises. Mirrors the MC's per-tick valuation convention (BS × realism, not a chain call).
 */
export const structureValueAt = (
  structure: OptionStructure,
  spot: number,
  putStrike: number,
  callStrike: number,
  contractsBtc: number,
  remainingMs: number,
  sigma: number,
  realismMultiplier: number,
  /** Short-leg strike for vertical spreads (the OTM leg sold). Ignored by other structures. */
  shortStrike?: number
): number => {
  const T = Math.max(0, remainingMs / MS_PER_YEAR);
  const bsP = Math.max(0, bsPut(spot, putStrike, T, RFR, sigma));
  const bsC = Math.max(0, bsCall(spot, callStrike, T, RFR, sigma));
  let perBtc: number;
  if (isTwoLeg(structure)) perBtc = bsP + bsC;
  else if (structure === "one_sided_put") perBtc = bsP;
  else if (structure === "one_sided_call") perBtc = bsC;
  else if (structure === "collar") perBtc = bsP - bsC; // long put − short call (can be negative)
  else if (structure === "vertical_spread_call") {
    // bull call debit spread: long call(callStrike) − short call(shortStrike, OTM up)
    const bsShort = Math.max(0, bsCall(spot, shortStrike ?? callStrike, T, RFR, sigma));
    perBtc = bsC - bsShort;
  } else {
    // vertical_spread_put — bear put debit spread: long put(putStrike) − short put(shortStrike, OTM down)
    const bsShort = Math.max(0, bsPut(spot, shortStrike ?? putStrike, T, RFR, sigma));
    perBtc = bsP - bsShort;
  }
  return perBtc * contractsBtc * realismMultiplier;
};

/** Leg-level real prices (USDC/BTC) needed to derive structure cost + realism. */
export type LegPrices = {
  putAskPerBtc: number;
  callAskPerBtc: number;
  putBidPerBtc: number;
  callBidPerBtc: number;
  bsPutPerBtc: number;
  bsCallPerBtc: number;
  /** Short-leg (OTM) prices for vertical spreads — same option type as the long leg. */
  shortAskPerBtc?: number;
  shortBidPerBtc?: number;
  shortBsPerBtc?: number;
};

export type StructureCost = {
  /** Net premium to enter the structure (USDC). Can be ≤ 0 for a collar (credit). */
  hedgeCostUsdc: number;
  /** Realism multiplier (real combined bid / BS combined) for the MC valuation. */
  salvageRealismMultiplier: number;
};

/**
 * Net entry premium + realism for a structure, derived from per-leg real prices.
 *   - long legs cost the ASK; the collar's SHORT call earns the BID (credit).
 *   - realism = real (signed) combined bid value / BS (signed) combined, clamped.
 */
export const structureCostAndRealism = (
  legs: LegPrices,
  structure: OptionStructure,
  contractsBtc: number
): StructureCost => {
  let costPerBtc: number;
  let realBid: number;   // signed liquidation value at bid-side
  let bsCombined: number;
  if (isTwoLeg(structure)) {
    costPerBtc = legs.putAskPerBtc + legs.callAskPerBtc;
    realBid = legs.putBidPerBtc + legs.callBidPerBtc;
    bsCombined = legs.bsPutPerBtc + legs.bsCallPerBtc;
  } else if (structure === "one_sided_put") {
    costPerBtc = legs.putAskPerBtc;
    realBid = legs.putBidPerBtc;
    bsCombined = legs.bsPutPerBtc;
  } else if (structure === "one_sided_call") {
    costPerBtc = legs.callAskPerBtc;
    realBid = legs.callBidPerBtc;
    bsCombined = legs.bsCallPerBtc;
  } else if (structure === "collar") {
    // collar: pay put ask, receive call bid (short) → net premium. A single net real/bs
    // ratio is ill-defined for a mixed long/short (it can go negative), so anchor the
    // realism multiplier to the LONG PROTECTIVE PUT (the dominant risk leg); the short
    // call is modeled at BS. This keeps the multiplier positive + meaningful.
    costPerBtc = legs.putAskPerBtc - legs.callBidPerBtc;
    realBid = legs.putBidPerBtc;
    bsCombined = legs.bsPutPerBtc;
  } else if (structure === "vertical_spread_call") {
    // bull call debit spread: pay long call ask, collect short call bid (net debit ≥ 0).
    // Realism anchored to the long (dominant) leg.
    costPerBtc = legs.callAskPerBtc - (legs.shortBidPerBtc ?? 0);
    realBid = legs.callBidPerBtc;
    bsCombined = legs.bsCallPerBtc;
  } else {
    // vertical_spread_put — bear put debit spread.
    costPerBtc = legs.putAskPerBtc - (legs.shortBidPerBtc ?? 0);
    realBid = legs.putBidPerBtc;
    bsCombined = legs.bsPutPerBtc;
  }
  // Realism = real/bs, clamped to [0,1.5]. For signed values near zero, fall back to 1.0
  // to avoid blow-ups when bsCombined ≈ 0.
  const realism = Math.abs(bsCombined) > 1e-6
    ? Math.max(0, Math.min(1.5, realBid / bsCombined))
    : 1.0;
  return {
    hedgeCostUsdc: costPerBtc * contractsBtc,
    salvageRealismMultiplier: realism
  };
};

/**
 * Value lost over one day at FLAT spot — the operator's "how fast does theta bite"
 * question, per structure. Positive = value decays (long theta drag); for a collar this
 * is ≈ 0 (the short call's decay offsets the long put's).
 */
export const theta1dUsdc = (
  structure: OptionStructure,
  spot: number,
  putStrike: number,
  callStrike: number,
  contractsBtc: number,
  tenorDays: number,
  sigma: number,
  realismMultiplier: number,
  shortStrike?: number
): number => {
  const fullMs = tenorDays * 86_400_000;
  const dayMs = 86_400_000;
  if (fullMs <= dayMs) return structureValueAt(structure, spot, putStrike, callStrike, contractsBtc, fullMs, sigma, realismMultiplier, shortStrike);
  const now = structureValueAt(structure, spot, putStrike, callStrike, contractsBtc, fullMs, sigma, realismMultiplier, shortStrike);
  const inOneDay = structureValueAt(structure, spot, putStrike, callStrike, contractsBtc, fullMs - dayMs, sigma, realismMultiplier, shortStrike);
  return +(now - inOneDay).toFixed(2);
};
