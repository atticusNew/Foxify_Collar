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
  | "vertical_spread_put"    // bear put DEBIT spread: long put @ putStrike − short put @ shortStrike(OTM down)
  | "credit_spread_put"      // bull put CREDIT spread: short put @ putStrike − long put @ shortStrike(OTM down). +EV-up/flat, capped.
  | "credit_spread_call"     // bear call CREDIT spread: short call @ callStrike − long call @ shortStrike(OTM up).
  | "short_strangle";        // short put + short call (sell premium / VRP harvest; non-directional)

const RFR = Number(process.env.BS_RISK_FREE_RATE ?? "0.045");
const MS_PER_YEAR = 365 * 86_400_000;

/** Is this a two-long-legs structure (put + call)? */
const isTwoLeg = (s: OptionStructure): boolean =>
  s === "strangle" || s === "straddle" || s === "straddle_gamma_scalp";

/**
 * The directional view a structure expresses (for the win-rate→drift edge):
 *   +1 = bullish/up (long call, bull call debit, bull put credit)
 *   −1 = bearish/down (long put, bear put debit, bear call credit, collar)
 *    0 = non-directional (straddle, short strangle — no side is "predicted")
 */
export const favoredDirection = (s: OptionStructure): -1 | 0 | 1 => {
  if (s === "one_sided_call" || s === "vertical_spread_call" || s === "credit_spread_put") return 1;
  if (s === "one_sided_put" || s === "vertical_spread_put" || s === "credit_spread_call" || s === "collar") return -1;
  return 0; // straddle, strangle, gamma, short_strangle
};

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
  } else if (structure === "vertical_spread_put") {
    // bear put debit spread: long put(putStrike) − short put(shortStrike, OTM down)
    const bsShort = Math.max(0, bsPut(spot, shortStrike ?? putStrike, T, RFR, sigma));
    perBtc = bsP - bsShort;
  } else if (structure === "credit_spread_put") {
    // bull put credit spread: SHORT put(putStrike) + LONG put(shortStrike, OTM down).
    // Liability to close = −short + long = bsWing − bsNear (≤ 0).
    const bsWing = Math.max(0, bsPut(spot, shortStrike ?? putStrike, T, RFR, sigma));
    perBtc = bsWing - bsP;
  } else if (structure === "credit_spread_call") {
    // bear call credit spread: SHORT call(callStrike) + LONG call(shortStrike, OTM up).
    const bsWing = Math.max(0, bsCall(spot, shortStrike ?? callStrike, T, RFR, sigma));
    perBtc = bsWing - bsC;
  } else {
    // short_strangle: short put + short call → liability = −(P + C)
    perBtc = -(bsP + bsC);
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
  contractsBtc: number,
  /** Frictionless: trade at MID (no bid-ask spread paid), value anchored to mid. */
  frictionless = false
): StructureCost => {
  // Per-leg price selectors. Normal: pay ASK (long), receive BID (short), value at BID.
  // Frictionless: every leg trades at MID (no spread). `anchorPx` is the value-side price.
  const mid = (ask: number, bid: number) => (ask + bid) / 2;
  const pay = (ask: number, bid: number) => (frictionless ? mid(ask, bid) : ask);
  const recv = (ask: number, bid: number) => (frictionless ? mid(ask, bid) : bid);
  const anchorPx = (ask: number, bid: number) => (frictionless ? mid(ask, bid) : bid);
  const sAsk = legs.shortAskPerBtc ?? 0, sBid = legs.shortBidPerBtc ?? 0;

  let costPerBtc: number;
  let realAnchor: number;   // value-side real price of the anchor leg(s)
  let bsAnchor: number;
  if (isTwoLeg(structure)) {
    costPerBtc = pay(legs.putAskPerBtc, legs.putBidPerBtc) + pay(legs.callAskPerBtc, legs.callBidPerBtc);
    realAnchor = anchorPx(legs.putAskPerBtc, legs.putBidPerBtc) + anchorPx(legs.callAskPerBtc, legs.callBidPerBtc);
    bsAnchor = legs.bsPutPerBtc + legs.bsCallPerBtc;
  } else if (structure === "one_sided_put") {
    costPerBtc = pay(legs.putAskPerBtc, legs.putBidPerBtc);
    realAnchor = anchorPx(legs.putAskPerBtc, legs.putBidPerBtc); bsAnchor = legs.bsPutPerBtc;
  } else if (structure === "one_sided_call") {
    costPerBtc = pay(legs.callAskPerBtc, legs.callBidPerBtc);
    realAnchor = anchorPx(legs.callAskPerBtc, legs.callBidPerBtc); bsAnchor = legs.bsCallPerBtc;
  } else if (structure === "collar") {
    costPerBtc = pay(legs.putAskPerBtc, legs.putBidPerBtc) - recv(legs.callAskPerBtc, legs.callBidPerBtc);
    realAnchor = anchorPx(legs.putAskPerBtc, legs.putBidPerBtc); bsAnchor = legs.bsPutPerBtc;
  } else if (structure === "vertical_spread_call") {
    costPerBtc = pay(legs.callAskPerBtc, legs.callBidPerBtc) - recv(sAsk, sBid);
    realAnchor = anchorPx(legs.callAskPerBtc, legs.callBidPerBtc); bsAnchor = legs.bsCallPerBtc;
  } else if (structure === "vertical_spread_put") {
    costPerBtc = pay(legs.putAskPerBtc, legs.putBidPerBtc) - recv(sAsk, sBid);
    realAnchor = anchorPx(legs.putAskPerBtc, legs.putBidPerBtc); bsAnchor = legs.bsPutPerBtc;
  } else if (structure === "credit_spread_put") {
    // SHORT near put (receive bid) + LONG wing put (pay ask) → net CREDIT (cost ≤ 0).
    costPerBtc = pay(sAsk, sBid) - recv(legs.putAskPerBtc, legs.putBidPerBtc);
    realAnchor = anchorPx(legs.putAskPerBtc, legs.putBidPerBtc); bsAnchor = legs.bsPutPerBtc;
  } else if (structure === "credit_spread_call") {
    costPerBtc = pay(sAsk, sBid) - recv(legs.callAskPerBtc, legs.callBidPerBtc);
    realAnchor = anchorPx(legs.callAskPerBtc, legs.callBidPerBtc); bsAnchor = legs.bsCallPerBtc;
  } else {
    // short_strangle: SELL put + call → net CREDIT.
    costPerBtc = -(recv(legs.putAskPerBtc, legs.putBidPerBtc) + recv(legs.callAskPerBtc, legs.callBidPerBtc));
    realAnchor = anchorPx(legs.putAskPerBtc, legs.putBidPerBtc) + anchorPx(legs.callAskPerBtc, legs.callBidPerBtc);
    bsAnchor = legs.bsPutPerBtc + legs.bsCallPerBtc;
  }
  const realism = Math.abs(bsAnchor) > 1e-6 ? Math.max(0, Math.min(1.5, realAnchor / bsAnchor)) : 1.0;
  return { hedgeCostUsdc: costPerBtc * contractsBtc, salvageRealismMultiplier: realism };
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
