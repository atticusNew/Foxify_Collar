/**
 * Fee-Recovery Cover — exchange-priced pricing model (Phase 1, quote-only).
 *
 * PRODUCT (Foxify's concrete ask, 2026-06):
 *   - Trader opens a directional perp (e.g. $50k) with a stop-loss at the trigger distance (e.g. 3%).
 *   - They buy a short-dated (e.g. 24h) ONE-TOUCH cover from Atticus on the SAME trade, one-sided
 *     (long position → downside cover; short → upside cover).
 *   - If the index TOUCHES the trigger (e.g. -3%) any time before expiry, Atticus pays Foxify a
 *     FIXED cash amount (the fee/slippage budget, ~$50–150). Otherwise the cover expires worthless.
 *   - Objective: refund the trading costs (fees + slippage) on the positions that move the wrong way.
 *
 * PRICING — NO Black-Scholes. The fair value is derived from REAL, LISTED exchange option quotes.
 *   A fixed-payout digital at barrier K is REPLICATED by a tight vertical option spread straddling
 *   K (long the leg just inside K, short the leg just beyond K), sized so the spread's max payout
 *   equals the cover payout. The spread's cost — computed from live venue ask/bid — is the
 *   exchange-implied fair value of a EUROPEAN (at-expiry) digital. A ONE-TOUCH (pays the instant K
 *   trades, even if price reverts) is worth more; we scale by `touchMultiplier` (reflection-
 *   principle ratio ≈ 2 for a driftless barrier; operator-tunable and calibratable from realized
 *   touch-vs-expiry data). This keeps the option leg 100% exchange-derived.
 *
 * ECONOMICS — the model is explicit and honest:
 *   - premium = fairValue × (1 + load). The load is Atticus's gross margin.
 *   - Across all trades Foxify pays the premium; on a touch they receive the fixed payout.
 *     Net to Foxify per trade = (touch_rate × payout) − premium. At the exchange-implied touch
 *     rate this is exactly −load (insurance is never free). It becomes +EV for Foxify only if their
 *     REAL trigger-hit rate exceeds `breakeven_touch_rate = premium / payout` (i.e. their entries
 *     are hit more often than the market prices in). The model surfaces that bar directly.
 *
 * Pure + deterministic: exchange quotes are INJECTED (the route fetches them live). Easy to test.
 */

export type TradeSide = "long" | "short";

export type FeeRecoveryParams = {
  /** "long" → downside (put) cover; "short" → upside (call) cover. */
  side: TradeSide;
  /** Current index / mark price. */
  spot: number;
  /** Perp position notional in USDC (e.g. 50000). */
  notionalUsdc: number;
  /** Trigger / stop distance as a positive fraction (e.g. 0.03 for 3%). */
  triggerPct: number;
  /** Cover tenor in days (e.g. 1 for a 24h cover). */
  tenorDays: number;
  /** FIXED cash paid on touch — the fee/slippage budget to refund (e.g. 100). */
  payoutUsdc: number;
};

/**
 * Real, LISTED exchange quotes for the vertical that replicates the digital at the barrier.
 * Both legs are the SAME option kind (puts for a long-position cover, calls for a short-position
 * cover). `longStrike` is the leg Atticus BUYS (pay ask); `shortStrike` is the leg Atticus SELLS
 * (receive bid) and must be strictly BEYOND the barrier (further OTM): lower strike for puts,
 * higher strike for calls. Premia are USDC per BTC (as the venue probes return them).
 */
export type HedgeSpreadQuote = {
  longStrike: number;
  longAskUsdcPerBtc: number;
  shortStrike: number;
  shortBidUsdcPerBtc: number;
};

export type FeeRecoveryConfig = {
  /** Atticus margin over exchange fair value (default 0.40 = 40%). */
  loadPct?: number;
  /** One-touch / European-digital value ratio (default 2.0; calibratable). */
  touchMultiplier?: number;
  /** Absolute premium floor in USDC (default 0). Covers fixed execution cost at tiny sizes. */
  minPremiumUsdc?: number;
};

export type FeeRecoveryEconInputs = {
  /** Foxify's expected covers per day at scale (for daily aggregates). */
  tradesPerDay?: number;
  /** Foxify's MEASURED real trigger-hit rate. When provided, used for "actual" economics;
   *  otherwise the exchange-implied touch probability is used. */
  foxifyRealTouchRate?: number | null;
};

export type FeeRecoveryQuote = {
  ok: true;
  position: {
    side: TradeSide;
    spot: number;
    notional_usdc: number;
    trigger_pct: number;
    barrier_price: number;       // the touch level (spot ± trigger)
    tenor_days: number;
    payout_usdc: number;
  };
  hedge: {
    /** The real vertical Atticus buys to replicate the digital. */
    structure: "put_spread" | "call_spread";
    long_strike: number;
    short_strike: number;
    spread_width_usd: number;
    contracts_btc: number;       // payout / width
    long_ask_usdc_per_btc: number;
    short_bid_usdc_per_btc: number;
    net_debit_usdc_per_btc: number;
    european_digital_cost_usdc: number;   // exchange-derived (spread debit × contracts)
    one_touch_hedge_cost_usdc: number;    // × touchMultiplier
    touch_multiplier: number;
  };
  pricing: {
    /** Exchange-implied P(expire beyond barrier) = european cost / payout. */
    implied_digital_prob: number;
    /** Exchange-implied P(touch barrier) = implied_digital_prob × touchMultiplier (capped at 1). */
    implied_touch_prob: number;
    fair_value_usdc: number;     // = one_touch_hedge_cost_usdc
    load_pct: number;
    premium_usdc: number;        // what Foxify pays
    atticus_margin_usdc: number; // premium − fair value
    cost_pct_notional: number;   // premium / notional
    premium_as_pct_of_payout: number;
  };
  economics: {
    touch_rate_used: number;
    touch_rate_source: "foxify_measured" | "exchange_implied";
    /** the bar Foxify's real hit-rate must clear to be +EV on the cover cashflows. */
    breakeven_touch_rate: number;
    foxify: {
      premium_per_trade_usdc: number;
      expected_payout_per_trade_usdc: number;
      net_ev_per_trade_usdc: number;     // expected payout − premium
      trades_per_day: number | null;
      net_ev_per_day_usdc: number | null;
    };
    atticus: {
      premium_per_trade_usdc: number;
      hedge_cost_per_trade_usdc: number; // fair value (the exchange hedge)
      expected_gross_margin_per_trade_usdc: number;
      trades_per_day: number | null;
      expected_gross_margin_per_day_usdc: number | null;
      max_payout_liability_per_cover_usdc: number;
    };
  };
  notes: string[];
};

export type FeeRecoveryError = {
  ok: false;
  error: string;
  message: string;
};

const round2 = (x: number) => +x.toFixed(2);
const round4 = (x: number) => +x.toFixed(4);
const round6 = (x: number) => +x.toFixed(6);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Barrier (touch) price for the cover. Long → below spot; short → above spot. */
export const barrierPrice = (side: TradeSide, spot: number, triggerPct: number): number =>
  side === "short" ? spot * (1 + triggerPct) : spot * (1 - triggerPct);

/**
 * Price the fee-recovery one-touch cover from REAL exchange spread quotes. Pure.
 * Returns a discriminated union so callers handle the "not priceable" case explicitly
 * (no live quote on one leg, malformed spread, etc.) rather than NaNs leaking out.
 */
export const buildFeeRecoveryQuote = (
  params: FeeRecoveryParams,
  hedge: HedgeSpreadQuote,
  config: FeeRecoveryConfig = {},
  econ: FeeRecoveryEconInputs = {}
): FeeRecoveryQuote | FeeRecoveryError => {
  const { side, spot, notionalUsdc, triggerPct, tenorDays, payoutUsdc } = params;

  if (!(spot > 0)) return { ok: false, error: "invalid_spot", message: "spot must be > 0" };
  if (!(notionalUsdc > 0)) return { ok: false, error: "invalid_notional", message: "notional_usdc must be > 0" };
  if (!(triggerPct > 0 && triggerPct < 1)) return { ok: false, error: "invalid_trigger", message: "trigger_pct must be in (0,1)" };
  if (!(tenorDays > 0)) return { ok: false, error: "invalid_tenor", message: "tenor_days must be > 0" };
  if (!(payoutUsdc > 0)) return { ok: false, error: "invalid_payout", message: "payout_usdc must be > 0" };

  const loadPct = config.loadPct != null && config.loadPct >= 0 ? config.loadPct : 0.4;
  const touchMultiplier = config.touchMultiplier != null && config.touchMultiplier > 0 ? config.touchMultiplier : 2.0;
  const minPremiumUsdc = config.minPremiumUsdc != null && config.minPremiumUsdc >= 0 ? config.minPremiumUsdc : 0;

  // Validate the replicating spread: same kind both legs, short leg strictly BEYOND the long leg.
  const width = side === "short" ? hedge.shortStrike - hedge.longStrike : hedge.longStrike - hedge.shortStrike;
  if (!(width > 0)) {
    return { ok: false, error: "invalid_spread", message: side === "short"
      ? "short call strike must be higher than long call strike"
      : "short put strike must be lower than long put strike" };
  }
  if (!(hedge.longAskUsdcPerBtc > 0)) return { ok: false, error: "no_long_quote", message: "no live ask on the long leg" };
  if (!(hedge.shortBidUsdcPerBtc > 0)) return { ok: false, error: "no_short_quote", message: "no live bid on the short leg" };

  const netDebitPerBtc = hedge.longAskUsdcPerBtc - hedge.shortBidUsdcPerBtc;
  if (!(netDebitPerBtc > 0)) {
    return { ok: false, error: "non_positive_debit", message: "spread net debit must be > 0 (long ask must exceed short bid)" };
  }

  // Contracts so the spread's MAX payout (width × contracts) equals the cover payout.
  const contractsBtc = payoutUsdc / width;
  const europeanDigitalCostUsdc = contractsBtc * netDebitPerBtc;
  const oneTouchHedgeCostUsdc = europeanDigitalCostUsdc * touchMultiplier;

  const impliedDigitalProb = clamp01(europeanDigitalCostUsdc / payoutUsdc);
  const impliedTouchProb = clamp01(impliedDigitalProb * touchMultiplier);

  const fairValueUsdc = oneTouchHedgeCostUsdc;
  const premiumUsdc = Math.max(minPremiumUsdc, fairValueUsdc * (1 + loadPct));
  const atticusMarginUsdc = premiumUsdc - fairValueUsdc;
  const breakevenTouchRate = clamp01(premiumUsdc / payoutUsdc);

  const realTouch = econ.foxifyRealTouchRate;
  const useMeasured = realTouch != null && Number.isFinite(realTouch) && realTouch >= 0;
  const touchRateUsed = useMeasured ? clamp01(realTouch as number) : impliedTouchProb;

  const tradesPerDay = econ.tradesPerDay != null && econ.tradesPerDay > 0 ? econ.tradesPerDay : null;

  const foxifyExpectedPayout = touchRateUsed * payoutUsdc;
  const foxifyNetEvPerTrade = foxifyExpectedPayout - premiumUsdc;
  // Atticus collects premium and pays the exchange hedge (fair value); residual is its margin.
  const atticusGrossMarginPerTrade = premiumUsdc - fairValueUsdc;

  const structure: "put_spread" | "call_spread" = side === "short" ? "call_spread" : "put_spread";

  return {
    ok: true,
    position: {
      side, spot: round2(spot), notional_usdc: round2(notionalUsdc), trigger_pct: round4(triggerPct),
      barrier_price: round2(barrierPrice(side, spot, triggerPct)), tenor_days: tenorDays, payout_usdc: round2(payoutUsdc)
    },
    hedge: {
      structure,
      long_strike: round2(hedge.longStrike),
      short_strike: round2(hedge.shortStrike),
      spread_width_usd: round2(width),
      contracts_btc: round6(contractsBtc),
      long_ask_usdc_per_btc: round2(hedge.longAskUsdcPerBtc),
      short_bid_usdc_per_btc: round2(hedge.shortBidUsdcPerBtc),
      net_debit_usdc_per_btc: round2(netDebitPerBtc),
      european_digital_cost_usdc: round2(europeanDigitalCostUsdc),
      one_touch_hedge_cost_usdc: round2(oneTouchHedgeCostUsdc),
      touch_multiplier: touchMultiplier
    },
    pricing: {
      implied_digital_prob: round4(impliedDigitalProb),
      implied_touch_prob: round4(impliedTouchProb),
      fair_value_usdc: round2(fairValueUsdc),
      load_pct: round4(loadPct),
      premium_usdc: round2(premiumUsdc),
      atticus_margin_usdc: round2(atticusMarginUsdc),
      cost_pct_notional: round6(premiumUsdc / notionalUsdc),
      premium_as_pct_of_payout: round4(premiumUsdc / payoutUsdc)
    },
    economics: {
      touch_rate_used: round4(touchRateUsed),
      touch_rate_source: useMeasured ? "foxify_measured" : "exchange_implied",
      breakeven_touch_rate: round4(breakevenTouchRate),
      foxify: {
        premium_per_trade_usdc: round2(premiumUsdc),
        expected_payout_per_trade_usdc: round2(foxifyExpectedPayout),
        net_ev_per_trade_usdc: round2(foxifyNetEvPerTrade),
        trades_per_day: tradesPerDay,
        net_ev_per_day_usdc: tradesPerDay != null ? round2(foxifyNetEvPerTrade * tradesPerDay) : null
      },
      atticus: {
        premium_per_trade_usdc: round2(premiumUsdc),
        hedge_cost_per_trade_usdc: round2(fairValueUsdc),
        expected_gross_margin_per_trade_usdc: round2(atticusGrossMarginPerTrade),
        trades_per_day: tradesPerDay,
        expected_gross_margin_per_day_usdc: tradesPerDay != null ? round2(atticusGrossMarginPerTrade * tradesPerDay) : null,
        max_payout_liability_per_cover_usdc: round2(payoutUsdc)
      }
    },
    notes: [
      "Option leg priced from REAL exchange quotes (replicating vertical), not Black-Scholes.",
      "fair_value = european digital cost (spread debit × contracts) × touch_multiplier. premium = fair_value × (1+load).",
      "Foxify is +EV on the cover only if their REAL trigger-hit rate exceeds breakeven_touch_rate. At the exchange-implied rate the cover costs Foxify the load (insurance is never free).",
      "touch_multiplier (one-touch vs european-digital) defaults to 2.0; calibrate from realized touch-vs-expiry data. The option cost itself stays exchange-derived.",
      "Phase 1 = QUOTE ONLY. No execution, no settlement, no payout."
    ]
  };
};
