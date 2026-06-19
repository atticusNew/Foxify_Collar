/**
 * Net-credit collar pricer + skew-aware strike solver — Phase A (pure, offline, default-off).
 *
 * PRODUCT (target design, 2026-06):
 *   Foxify opens a directional perp and wants its per-position fee/ops cost (~$50-150)
 *   cushioned on losing positions, in exchange for surrendering the big-winner upside tail.
 *   The instrument is a SHORT-DATED NET-CREDIT COLLAR on the SAME position:
 *     - long perp  → Foxify is LONG a put (downside floor) + SHORT a call (upside cap)
 *     - short perp → mirror: LONG a call (ceiling) + SHORT a put (downside-of-gains)
 *   Strikes are SOLVED so Foxify receives a net credit ≈ their fee, subject to a maximum
 *   acceptable downside floor. Because BTC has downside skew, symmetric strikes produce a
 *   DEBIT, so the funding (call, for a long perp) leg sits TIGHTER than the floor (put) leg.
 *
 * RISK ATTRIBUTION (this is the bit a prior attempt got backwards — see Phase 0 review):
 *   Foxify long put + short call  ⟹  ATTICUS short put + long call.
 *   Atticus's MARKET risk leg is therefore the SHORT PUT (downside / assignment), not the call.
 *   Separately, Foxify's SHORT CALL is a COUNTERPARTY exposure ON Atticus: if price rallies
 *   past K_call, Foxify owes the call settlement. The credit is therefore NOT paid as upfront
 *   cash — it is ACCRUED to a Foxify balance held by Atticus and NETTED against the short-call
 *   leg (and/or Foxify-posted collateral) at settlement. This removes both the structural
 *   "short a free option" exposure and the financing drag of fronting cash at scale.
 *
 * ECONOMICS (honest, EV-neutral — same framing as feeRecoveryQuote.ts):
 *   A fairly-priced collar is EV-neutral. Foxify does NOT get expected fee recovery for free;
 *   it finances the central-region fee cushion + downside floor by GIVING UP the upside tail.
 *   - fairCredit  = (funding-leg mid − floor-leg mid) × contracts   (the market-fair credit)
 *   - Foxify receives credit = targetCredit (their fee), strictly LESS than fairCredit.
 *   - Atticus margin = fairCredit − targetCredit  (the embedded spread; must clear a floor).
 *   - ⟹ Foxify market-implied EV = targetCredit − fairCredit = −(Atticus margin) ≤ −margin.
 *   The guardrail is "Foxify EV ≤ −Atticus margin", NEVER "Foxify EV ≥ 0". Any parameterization
 *   that yields positive Foxify EV from the option itself is mispriced and is REJECTED.
 *
 * REBATES: Bullish rebates / fee-holidays are NOT modeled here. They are upside-only and must
 *   never be load-bearing — viability is proven with rebates = 0.
 *
 * Pure + deterministic: the per-strike vol (skew) is INJECTED as a callback. In production this
 * is wired from the Deribit per-strike mark-IV ladder; in tests a synthetic curve is supplied.
 */

import { bsPut, bsCall } from "../../../pilot/blackScholes";

export type PerpSide = "long" | "short";

/**
 * Annualized implied vol for a given strike + option kind (the skew curve).
 * Production: Deribit per-strike mark-IV ladder. Tests/sim: synthetic curve.
 */
export type SkewCurve = (strike: number, optType: "put" | "call") => number;

export type CreditCollarParams = {
  /** Foxify's perp direction. */
  side: PerpSide;
  /** Reference spot at activation (the settlement-reference price, NOT necessarily Foxify's venue). */
  spot: number;
  /** Perp notional protected, in USDC. */
  notionalUsdc: number;
  /** Cover tenor in days (e.g. 1 for a 24h cover; aligned to the hedge expiry clock in prod). */
  tenorDays: number;
  /** Foxify's fee/ops cost to cushion. Accrued to held balance + netted at settlement (NOT upfront cash). */
  targetCreditUsdc: number;
  /**
   * Maximum acceptable downside floor as a positive fraction (e.g. 0.04 = 4%). HARD constraint:
   * the floor leg may not be deeper OTM than this. Bounds Foxify's max loss AND Atticus short-leg risk.
   */
  maxFloorPct: number;
  /**
   * What the collar references. EXPLICIT — no default. Gated on Foxify's actual flow (Q2):
   *   "position"        → one collar per directional perp position (sequential-directional flow)
   *   "net_book_delta"  → collar references the net book delta (simultaneously-hedged flow)
   * Per-position collaring on a simultaneously-hedged book self-cancels (see detectSelfCancellation).
   */
  referenceMode: "position" | "net_book_delta";
};

export type AtticusSpreadConfig = {
  /** Embedded Atticus margin in bps of notional (default 1.5 bps). */
  spreadBps?: number;
  /** Absolute $/position margin floor for ops/gas (default 12). */
  minMarginUsdc?: number;
  /** Risk-free rate for BS fair value (default 0.045). */
  riskFreeRate?: number;
  /** Strike grid snap in USDC (default 500). */
  strikeGridUsdc?: number;
  /** Max OTM fraction to search the funding leg over (default 0.20 = 20%). */
  fundingSearchMaxPct?: number;
  /**
   * How the LEGS are filled when Atticus back-to-backs the hedge. This is the single biggest
   * swing in feasibility (Phase 0 review #1): back-to-back means Atticus BUYS the protective leg
   * at ASK and SELLS the funding leg at BID — crossing the spread on BOTH legs. At scale you WILL
   * pay the spread, so the default is "touch" (executable), not "mid" (optimistic).
   *   "mid"   → mid-to-mid (best case; do not trust for go-live sizing)
   *   "touch" → protective at ask, funding at bid (realistic back-to-back execution)
   */
  fillMode?: "mid" | "touch";
  /** Per-leg HALF-spread as a fraction of the leg's mid premium (default 0.10 = ±10% of premium). */
  relativeHalfSpreadPct?: number;
  /** Per-leg HALF-spread absolute floor in USDC/BTC (default 1.5) — short-dated OTM books have wide ticks. */
  absHalfSpreadUsdcPerBtc?: number;
  /**
   * MEASUREMENT-READY override: per-leg HALF-spread in USDC/BTC at the ACTUAL wing strike + tenor the
   * solver picks (OTM wings are materially wider than ATM — capturing ATM mislocates the crossover).
   * When provided, this overrides relativeHalfSpreadPct / absHalfSpreadUsdcPerBtc. Plug measured
   * Bullish wing spreads here. Receives the leg's mid so a %-of-premium model is still expressible.
   */
  legHalfSpreadUsdcPerBtc?: (ctx: {
    strike: number;
    spot: number;
    optType: "put" | "call";
    tenorDays: number;
    midPerBtc: number;
  }) => number;
};

export type CollarLegs = {
  /** Put strike (the floor for a long perp; the funding short-leg for a short perp). */
  putStrike: number;
  /** Call strike (the cap/funding short-leg for a long perp; the ceiling for a short perp). */
  callStrike: number;
  /** Which leg Foxify is LONG (the protective leg). */
  foxifyLongLeg: "put" | "call";
  /** Which leg Foxify is SHORT (the funding leg) — this is Atticus's COUNTERPARTY exposure on Foxify. */
  foxifyShortLeg: "put" | "call";
  /** Atticus's MARKET risk leg (the leg Atticus is short). */
  atticusShortLeg: "put" | "call";
};

export type CreditCollarQuote = {
  ok: true;
  position: {
    side: PerpSide;
    spot: number;
    notional_usdc: number;
    contracts_btc: number;
    tenor_days: number;
    reference_mode: "position" | "net_book_delta";
  };
  legs: CollarLegs & {
    floor_pct: number;          // how far OTM the protective floor sits
    cap_pct: number;            // how far OTM the funding cap sits (= upside Foxify surrenders)
    floor_leg_mid_usdc: number;
    funding_leg_mid_usdc: number;
  };
  fills: {
    fill_mode: "mid" | "touch";
    protective_leg_ask_usdc: number;  // Atticus BUYS the protective leg here
    funding_leg_bid_usdc: number;     // Atticus SELLS the funding leg here
    crossing_drag_usdc: number;       // fair (mid) credit − fundable (executable) credit
  };
  economics: {
    fair_credit_mid_usdc: number;    // mid-to-mid credit (funding mid − floor mid) × contracts (reference)
    fundable_credit_usdc: number;    // executable credit after crossing BOTH legs — the real basis
    foxify_credit_usdc: number;      // what Foxify actually receives (accrued, not upfront) = target
    atticus_margin_usdc: number;     // fundable_credit − foxify_credit (post-crossing embedded spread)
    atticus_margin_bps: number;      // margin / notional × 1e4
    required_margin_usdc: number;    // max(notional × spreadBps, minMarginUsdc)
    foxify_market_implied_ev_usdc: number; // = foxify_credit − fair_credit_mid = −(crossing + margin)
    rebates_included: false;
  };
  foxify_outcome: {
    /** Max protected loss (between spot and the floor, net of the credit cushion). */
    max_loss_usdc: number;
    /** Upside is capped beyond the funding strike; this is the retained gain ceiling incl. credit. */
    max_gain_usdc: number;
    /** Central-region (no touch of either strike) outcome = the credit cushion. */
    central_region_credit_usdc: number;
  };
  atticus_risk: {
    /** Atticus's short-leg market exposure if the floor is breached, per the worst in-tenor move. */
    short_leg_max_payout_usdc: number;
    /** Notional-scaled short-leg payout for a reference adverse move (1 std-ish), for reserve sizing. */
    short_leg_payout_at_floor_usdc: number;
  };
  counterparty: {
    /** Foxify's short-leg obligation grows without bound past the funding strike — this is the exposure. */
    note: string;
    /** Credit accrued to held balance (first line of defense; never paid out as upfront cash). */
    held_credit_usdc: number;
    /** Additional Foxify collateral required to cover the short leg out to `cover_move_pct`. */
    required_collateral_usdc: number;
    cover_move_pct: number;
    settlement_is_netted: true;
  };
  basis_risk: {
    /** USDC mismatch per 1% divergence between the settlement reference and Foxify's perp venue. */
    usdc_per_1pct_basis: number;
    note: string;
  };
  notes: string[];
};

export type CreditCollarError = {
  ok: false;
  error: string;
  message: string;
  /** Operator hints to make an infeasible quote feasible. */
  hints?: string[];
};

const round2 = (x: number) => +x.toFixed(2);
const round4 = (x: number) => +x.toFixed(4);
const round6 = (x: number) => +x.toFixed(6);

const snapUp = (x: number, grid: number) => Math.ceil(x / grid) * grid;
const snapDown = (x: number, grid: number) => Math.floor(x / grid) * grid;

const yearsFromDays = (d: number) => d / 365;

/** BS mid value (USDC per BTC) for a strike at the skew-curve vol. */
const legMidPerBtc = (
  optType: "put" | "call",
  spot: number,
  strike: number,
  T: number,
  r: number,
  skew: SkewCurve
): number => {
  const iv = skew(strike, optType);
  const v = optType === "put" ? bsPut(spot, strike, T, r, iv) : bsCall(spot, strike, T, r, iv);
  return Math.max(0, v);
};

/**
 * Solve + price a net-credit collar from a per-strike vol (skew) curve. Pure.
 *
 * Strategy (long perp; short perp mirrored):
 *   1. Pin the FLOOR (long put) at the deepest strike the floor cap allows — cheapest put,
 *      least Atticus short-put risk, best chance of manufacturing the credit.
 *   2. Search the FUNDING (short call) strike from far-OTM inward and choose the LOOSEST
 *      (highest) strike whose fair credit covers targetCredit + Atticus's required margin.
 *      Loosest-acceptable = best retained upside for Foxify subject to Atticus profitability.
 *   3. If even the tightest funding strike can't fund credit+margin at this floor → infeasible.
 */
export const solveAndPriceCreditCollar = (
  params: CreditCollarParams,
  skew: SkewCurve,
  config: AtticusSpreadConfig = {}
): CreditCollarQuote | CreditCollarError => {
  const { side, spot, notionalUsdc, tenorDays, targetCreditUsdc, maxFloorPct, referenceMode } = params;

  if (!(spot > 0)) return { ok: false, error: "invalid_spot", message: "spot must be > 0" };
  if (!(notionalUsdc > 0)) return { ok: false, error: "invalid_notional", message: "notional_usdc must be > 0" };
  if (!(tenorDays > 0)) return { ok: false, error: "invalid_tenor", message: "tenor_days must be > 0" };
  if (!(targetCreditUsdc > 0)) return { ok: false, error: "invalid_credit", message: "target_credit_usdc must be > 0" };
  if (!(maxFloorPct > 0 && maxFloorPct < 1)) return { ok: false, error: "invalid_floor", message: "max_floor_pct must be in (0,1)" };

  const spreadBps = config.spreadBps != null && config.spreadBps >= 0 ? config.spreadBps : 1.5;
  const minMarginUsdc = config.minMarginUsdc != null && config.minMarginUsdc >= 0 ? config.minMarginUsdc : 12;
  const r = config.riskFreeRate != null ? config.riskFreeRate : 0.045;
  const grid = config.strikeGridUsdc != null && config.strikeGridUsdc > 0 ? config.strikeGridUsdc : 500;
  const fundingSearchMaxPct = config.fundingSearchMaxPct != null && config.fundingSearchMaxPct > 0 ? config.fundingSearchMaxPct : 0.2;
  const fillMode: "mid" | "touch" = config.fillMode === "mid" ? "mid" : "touch";
  const relHalf = config.relativeHalfSpreadPct != null && config.relativeHalfSpreadPct >= 0 ? config.relativeHalfSpreadPct : 0.1;
  const absHalf = config.absHalfSpreadUsdcPerBtc != null && config.absHalfSpreadUsdcPerBtc >= 0 ? config.absHalfSpreadUsdcPerBtc : 1.5;

  const T = yearsFromDays(tenorDays);
  const contractsBtc = notionalUsdc / spot;
  const requiredMarginUsdc = Math.max((notionalUsdc * spreadBps) / 1e4, minMarginUsdc);

  // Executable per-leg prices. Atticus BUYS the protective leg (pays ask) and SELLS the funding
  // leg (receives bid). Half-spread at the ACTUAL wing strike: measured model if supplied, else
  // max(% of mid premium, absolute floor). "mid" mode = no crossing.
  const legSpreadModel = config.legHalfSpreadUsdcPerBtc;
  const halfSpreadPerBtc = (midPerBtc: number, strike: number, optType: "put" | "call") =>
    legSpreadModel
      ? Math.max(0, legSpreadModel({ strike, spot, optType, tenorDays, midPerBtc }))
      : Math.max(midPerBtc * relHalf, absHalf);
  const execAskPerBtc = (midPerBtc: number, strike: number, optType: "put" | "call") =>
    fillMode === "touch" ? midPerBtc + halfSpreadPerBtc(midPerBtc, strike, optType) : midPerBtc;
  const execBidPerBtc = (midPerBtc: number, strike: number, optType: "put" | "call") =>
    fillMode === "touch" ? Math.max(0, midPerBtc - halfSpreadPerBtc(midPerBtc, strike, optType)) : midPerBtc;

  // Leg roles by side. The protective (long) leg gives the floor/ceiling; the funding (short)
  // leg is sold to manufacture the credit and is Atticus's COUNTERPARTY exposure on Foxify.
  const protectiveType: "put" | "call" = side === "long" ? "put" : "call";
  const fundingType: "put" | "call" = side === "long" ? "call" : "put";

  // 1) Pin the protective leg at the floor cap (deepest allowed OTM).
  //    long perp  → put below spot at spot*(1−maxFloorPct), snapped UP (no deeper than the cap)
  //    short perp → call above spot at spot*(1+maxFloorPct), snapped DOWN (no higher than the cap)
  const protectiveStrike =
    side === "long"
      ? snapUp(spot * (1 - maxFloorPct), grid)
      : snapDown(spot * (1 + maxFloorPct), grid);

  if (!(protectiveStrike > 0)) {
    return { ok: false, error: "invalid_protective_strike", message: "protective strike resolved <= 0" };
  }
  const protectiveMidPerBtc = legMidPerBtc(protectiveType, spot, protectiveStrike, T, r, skew);
  const protectiveExecPerBtc = execAskPerBtc(protectiveMidPerBtc, protectiveStrike, protectiveType); // Atticus BUYS the protective leg (pays ask)

  // 2) Search the funding leg from loose (far OTM) to tight; pick the loosest that funds credit+margin
  //    at EXECUTABLE prices (funding sold at bid). Crossing both legs is the real competition for credit.
  //    long perp  → short call ABOVE spot; tighter = lower strike = more premium
  //    short perp → short put BELOW spot; tighter = higher strike = more premium
  const targetFundableCredit = targetCreditUsdc + requiredMarginUsdc;
  const steps = Math.max(1, Math.floor((spot * fundingSearchMaxPct) / grid));

  let chosenFundingStrike: number | null = null;
  let chosenFundingMidPerBtc = 0;
  let chosenFundableCredit = 0;
  let tightestFundableCredit = 0; // best (max) executable credit seen, for the infeasibility hint

  for (let i = steps; i >= 1; i--) {
    const offset = i * grid;
    const fundingStrike = side === "long" ? spot + offset : spot - offset;
    if (!(fundingStrike > 0)) continue;
    const snapped = side === "long" ? snapDown(fundingStrike, grid) : snapUp(fundingStrike, grid);
    if (side === "long" && snapped <= spot) continue;
    if (side === "short" && snapped >= spot) continue;

    const fundingMidPerBtc = legMidPerBtc(fundingType, spot, snapped, T, r, skew);
    const fundingExecPerBtc = execBidPerBtc(fundingMidPerBtc, snapped, fundingType);
    const fundableCredit = (fundingExecPerBtc - protectiveExecPerBtc) * contractsBtc;
    tightestFundableCredit = Math.max(tightestFundableCredit, fundableCredit);

    if (fundableCredit >= targetFundableCredit) {
      chosenFundingStrike = snapped;
      chosenFundingMidPerBtc = fundingMidPerBtc;
      chosenFundableCredit = fundableCredit;
      break; // first hit from the loose end = loosest acceptable = best retained upside for Foxify
    }
  }

  if (chosenFundingStrike == null) {
    return {
      ok: false,
      error: "credit_infeasible_at_floor",
      message:
        `Cannot manufacture credit ${round2(targetCreditUsdc)} + margin ${round2(requiredMarginUsdc)} ` +
        `(= ${round2(targetFundableCredit)}) at floor ${round4(maxFloorPct)} with ${fillMode} fills. ` +
        `Best executable credit achievable here ≈ ${round2(tightestFundableCredit)}.`,
      hints: [
        "Increase max_floor_pct (deeper/cheaper protective leg ⟹ more credit available).",
        "Lower target_credit_usdc (the upside tail has finite value; it can't fund an arbitrary credit).",
        "Lengthen tenor_days (more extrinsic on the funding leg).",
        "Skew/vol may be too low to fund this credit without an over-tight cap."
      ]
    };
  }

  const putStrike = side === "long" ? protectiveStrike : chosenFundingStrike;
  const callStrike = side === "long" ? chosenFundingStrike : protectiveStrike;

  // Credit Atticus can actually fund (executable, both legs crossed) vs the mid-to-mid fair credit.
  // The gap is the leg-crossing drag that goes to the market makers — Foxify bears it on top of margin.
  const fundableCreditUsdc = chosenFundableCredit;
  const fairCreditMidUsdc = (chosenFundingMidPerBtc - protectiveMidPerBtc) * contractsBtc;
  const crossingDragUsdc = Math.max(0, fairCreditMidUsdc - fundableCreditUsdc);

  const foxifyCreditUsdc = targetCreditUsdc;
  const atticusMarginUsdc = fundableCreditUsdc - foxifyCreditUsdc; // post-crossing margin Atticus keeps
  // Foxify's EV is measured against TRUE fair value (mid). It eats BOTH the crossing and the margin.
  const foxifyEvUsdc = foxifyCreditUsdc - fairCreditMidUsdc; // = −(crossingDrag + atticusMargin)

  // Guardrail 1: Atticus must keep at least the required margin AFTER paying the leg-crossing.
  if (atticusMarginUsdc < requiredMarginUsdc - 1e-6) {
    return {
      ok: false,
      error: "margin_below_floor_after_crossing",
      message:
        `Atticus post-crossing margin ${round2(atticusMarginUsdc)} < required ${round2(requiredMarginUsdc)} ` +
        `(crossing drag ${round2(crossingDragUsdc)} with ${fillMode} fills). Not viable at this credit/floor.`
    };
  }
  // Guardrail 2: EV-neutral means Foxify EV ≤ −required margin. Reject anything that drifts non-negative.
  if (foxifyEvUsdc > -requiredMarginUsdc + 1e-6) {
    return {
      ok: false,
      error: "ev_guardrail_violation",
      message:
        `Foxify market-implied EV ${round2(foxifyEvUsdc)} must be ≤ −required margin ` +
        `${round2(-requiredMarginUsdc)}. A non-negative Foxify EV is the mispricing that bled Atticus before.`
    };
  }

  // Foxify outcome bounds (per position, net of the credit cushion).
  const floorPct = Math.abs(spot - protectiveStrike) / spot;
  const capPct = Math.abs(chosenFundingStrike - spot) / spot;
  // Below the floor (long) / above the ceiling (short) Foxify is fully protected; between spot and
  // the floor it bears the move. Max protected loss = floor move on notional, minus the credit.
  const floorMoveLossUsdc = floorPct * notionalUsdc;
  const foxifyMaxLossUsdc = Math.max(0, floorMoveLossUsdc - foxifyCreditUsdc);
  const capMoveGainUsdc = capPct * notionalUsdc;
  const foxifyMaxGainUsdc = capMoveGainUsdc + foxifyCreditUsdc;

  // Atticus short-leg (the floor) market exposure. Worst case is a full move to the protective strike
  // and beyond; we report the payout at the floor strike and a deep-move bound for reserve sizing.
  const atticusShortLegType = side === "long" ? "put" : "call";
  const shortLegPayoutAtFloorUsdc = 0; // exactly at the strike the option is at-the-money: 0 intrinsic
  // Deep adverse move bound: protective strike fully in-the-money by another floorPct beyond it.
  const deepMovePct = floorPct + maxFloorPct;
  const shortLegMaxPayoutUsdc =
    side === "long"
      ? Math.max(0, (protectiveStrike - spot * (1 - deepMovePct)) / spot) * notionalUsdc
      : Math.max(0, (spot * (1 + deepMovePct) - protectiveStrike) / spot) * notionalUsdc;

  // Counterparty exposure: Foxify's short (funding) leg obligation is unbounded past the strike.
  // Required collateral to cover the funding leg out to a reference move, net of the held credit.
  const coverMovePct = 2 * maxFloorPct; // cover a move twice the floor distance by default
  const fundingObligationAtCoverUsdc =
    side === "long"
      ? Math.max(0, (spot * (1 + coverMovePct) - chosenFundingStrike) / spot) * notionalUsdc
      : Math.max(0, (chosenFundingStrike - spot * (1 - coverMovePct)) / spot) * notionalUsdc;
  const requiredCollateralUsdc = Math.max(0, fundingObligationAtCoverUsdc - foxifyCreditUsdc);

  // Basis risk: settlement reference vs Foxify's perp venue. Per 1% divergence the floor leg is
  // off by contracts × spot × 1% = notional × 1% relative to Foxify's actual perp P&L.
  const basisUsdcPer1pct = notionalUsdc * 0.01;

  return {
    ok: true,
    position: {
      side,
      spot: round2(spot),
      notional_usdc: round2(notionalUsdc),
      contracts_btc: round6(contractsBtc),
      tenor_days: tenorDays,
      reference_mode: referenceMode
    },
    legs: {
      putStrike: round2(putStrike),
      callStrike: round2(callStrike),
      foxifyLongLeg: protectiveType,
      foxifyShortLeg: fundingType,
      atticusShortLeg: atticusShortLegType,
      floor_pct: round4(floorPct),
      cap_pct: round4(capPct),
      floor_leg_mid_usdc: round2(protectiveMidPerBtc * contractsBtc),
      funding_leg_mid_usdc: round2(chosenFundingMidPerBtc * contractsBtc)
    },
    fills: {
      fill_mode: fillMode,
      protective_leg_ask_usdc: round2(protectiveExecPerBtc * contractsBtc),
      funding_leg_bid_usdc: round2(execBidPerBtc(chosenFundingMidPerBtc, chosenFundingStrike, fundingType) * contractsBtc),
      crossing_drag_usdc: round2(crossingDragUsdc)
    },
    economics: {
      fair_credit_mid_usdc: round2(fairCreditMidUsdc),
      fundable_credit_usdc: round2(fundableCreditUsdc),
      foxify_credit_usdc: round2(foxifyCreditUsdc),
      atticus_margin_usdc: round2(atticusMarginUsdc),
      atticus_margin_bps: round4((atticusMarginUsdc / notionalUsdc) * 1e4),
      required_margin_usdc: round2(requiredMarginUsdc),
      foxify_market_implied_ev_usdc: round2(foxifyEvUsdc),
      rebates_included: false
    },
    foxify_outcome: {
      max_loss_usdc: round2(foxifyMaxLossUsdc),
      max_gain_usdc: round2(foxifyMaxGainUsdc),
      central_region_credit_usdc: round2(foxifyCreditUsdc)
    },
    atticus_risk: {
      short_leg_max_payout_usdc: round2(shortLegMaxPayoutUsdc),
      short_leg_payout_at_floor_usdc: round2(shortLegPayoutAtFloorUsdc)
    },
    counterparty: {
      note:
        "Foxify's short (funding) leg obligation is unbounded past the strike. The credit is accrued " +
        "to a held balance (never upfront cash) and NETTED against this leg at settlement; collateral " +
        "covers the residual. Atticus is structurally short a free option if credit is fronted as cash.",
      held_credit_usdc: round2(foxifyCreditUsdc),
      required_collateral_usdc: round2(requiredCollateralUsdc),
      cover_move_pct: round4(coverMovePct),
      settlement_is_netted: true
    },
    basis_risk: {
      usdc_per_1pct_basis: round2(basisUsdcPer1pct),
      note:
        "Collar settles on the median-TWAP reference; Foxify's perp settles on its partner venue. " +
        "Per 1% reference-vs-venue divergence the floor offset is off by this much. Tightest fix: " +
        "settle on the venue Foxify trades. Quantify the residual in sim."
    },
    notes: [
      "Net-credit collar: Foxify long floor + short funding leg; Atticus short floor + long funding leg.",
      "Fair value at per-strike (skew) mid; Atticus margin is the explicit embedded spread on top.",
      "EV-neutral: Foxify market-implied EV = −Atticus margin (≤ −required). Positive Foxify EV is rejected.",
      "Credit is accrued + netted at settlement, NOT paid upfront — removes free-option exposure + financing drag.",
      "Rebates excluded (upside-only, never load-bearing). Phase A = pricing/sim only; no execution, no settlement."
    ]
  };
};

// ── Regime-adaptive floor ─────────────────────────────────────────────────────
// In a calm/low-vol regime the skew may not fund the target credit at the configured floor (the
// option premium isn't there). Rather than silently going infeasible, progressively DEEPEN the floor
// (a cheaper put ⟹ more credit headroom) up to a cap, and surface the floor actually used so the
// regime is VISIBLE (a deeper floor = calmer market / thinner premium). This is a real product lever,
// not just a sim convenience: in production you'd quote the deepest acceptable floor that funds the fee.

export type AdaptiveFloorConfig = {
  enabled: boolean;
  /** Hard cap on how deep the floor may go (e.g. 0.10 = 10% OTM). */
  maxFloorCapPct: number;
  /** Step to deepen by when infeasible (e.g. 0.005 = 0.5%). */
  stepPct: number;
};

export type AdaptiveCollarResult = {
  quote: CreditCollarQuote | CreditCollarError;
  floorUsedPct: number;
  deepenedFromPct: number;
  steps: number;
};

/**
 * Solve the credit collar, deepening the floor until it prices (or the cap is hit). Pure. When
 * `adaptive.enabled` is false this is a single solve at `params.maxFloorPct`.
 */
export const solveAdaptiveCreditCollar = (
  params: CreditCollarParams,
  skew: SkewCurve,
  config: AtticusSpreadConfig = {},
  adaptive?: AdaptiveFloorConfig
): AdaptiveCollarResult => {
  const startFloor = params.maxFloorPct;
  if (!adaptive?.enabled) {
    return { quote: solveAndPriceCreditCollar(params, skew, config), floorUsedPct: startFloor, deepenedFromPct: startFloor, steps: 0 };
  }
  let floor = startFloor;
  let steps = 0;
  let quote = solveAndPriceCreditCollar({ ...params, maxFloorPct: floor }, skew, config);
  while (!quote.ok && floor < adaptive.maxFloorCapPct - 1e-9) {
    floor = Math.min(adaptive.maxFloorCapPct, +(floor + adaptive.stepPct).toFixed(4));
    steps += 1;
    quote = solveAndPriceCreditCollar({ ...params, maxFloorPct: floor }, skew, config);
  }
  return { quote, floorUsedPct: floor, deepenedFromPct: startFloor, steps };
};
