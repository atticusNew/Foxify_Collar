/**
 * Perp Protect — INTERNAL Bybit price-competitiveness check (pure + testable).
 *
 * This is NOT surfaced to the trader. It exists so we can verify, on a like-for-like basis, that
 * Atticus's cross-venue-sourced protection is cheaper than Bybit's comparable listed option — both
 * the raw hedge (margin headroom) and the retail premium (what each charges the trader).
 *
 * Bybit BTC options quote the premium in USDC per 1 BTC of underlying (orderbook price in USDC,
 * size in BTC), so the ask is already directly comparable to our normalized USDC-per-BTC asks — no
 * contract-multiplier conversion is required. If that ever changes, normalize before calling this.
 */

export type BybitLegQuote = {
  /** The ask used for the premium comparison — SIZE-AWARE (VWAP walked for the requested size),
   *  consistent with how we source our own hedge. Falls back to top-of-book when no depth. */
  ask_usdc_per_btc: number;
  /** Top-of-book ask (for the spread/fillability check only; the headline a thin book advertises). */
  tob_ask_usdc_per_btc?: number | null;
  bid_usdc_per_btc: number | null;
  strike: number;
  expiry_ms: number;
  symbol: string;
};

export type PriceCompetitiveness = {
  available: boolean;                       // false when Bybit data couldn't be sourced (local/region)
  compared_option_id: string | null;        // which option this compares (the recommended single)
  bybit_symbol: string | null;
  bybit_strike: number | null;
  bybit_ask_usdc_per_btc: number | null;     // SIZE-AWARE effective ask (VWAP for the requested size)
  bybit_tob_ask_usdc_per_btc: number | null; // top-of-book ask (headline; for reference + spread)
  bybit_bid_usdc_per_btc: number | null;     // top-of-book bid (for the fillability check)
  bybit_spread_pct: number | null;           // (ask−bid)/mid; null when a side is missing
  bybit_fillable: boolean | null;            // false when the book is too wide for the ask to be a real fill
  bybit_premium_usdc: number | null;         // Bybit ask × size (their comparable premium to the trader)
  atticus_premium_usdc: number | null;       // our retail premium for the compared option
  atticus_hedge_cost_usdc: number | null;    // our cheapest cross-venue hedge cost
  beats_bybit_retail: boolean | null;        // our retail premium ≤ Bybit's premium (cheaper to trader)
  retail_edge_usdc: number | null;           // Bybit premium − our retail (positive = we win)
  beats_bybit_hedge: boolean | null;         // our hedge cost ≤ Bybit ask (sourcing headroom)
  hedge_edge_usdc: number | null;            // (Bybit ask − our hedge) × size
  hedge_venue: string | null;                // venue we sourced the compared option's hedge from
  note: string | null;                       // caveat when the hedge was sourced ON Bybit (see below)
};

/** Max top-of-book spread for Bybit's ask to be treated as a real, fillable price (else it's a
 *  wide/illiquid quote and "Bybit cheaper" on the ask is misleading). Env-tunable. */
const FILLABLE_MAX_SPREAD_PCT = Number(process.env.PERP_PROTECT_BYBIT_MAX_SPREAD_PCT ?? 0.30);

const round2 = (x: number): number => +x.toFixed(2);
const round4 = (x: number): number => +x.toFixed(4);

/** Top-of-book relative spread (ask−bid)/mid; null unless both sides are present and positive. */
const spreadPctOf = (ask: number | null, bid: number | null): number | null => {
  if (ask == null || bid == null || ask <= 0 || bid <= 0) return null;
  const mid = (ask + bid) / 2;
  return mid > 0 ? round4((ask - bid) / mid) : null;
};

/** Build the internal competitiveness diagnostic from our compared option + the Bybit leg (or null). */
export const compareToBybit = (args: {
  optionId: string | null;
  bybit: BybitLegQuote | null;
  sizeBtc: number;
  atticusPremiumUsdc: number;
  atticusHedgeCostUsdc: number;
  /** Venue the compared option's hedge was sourced from. When "bybit", the head-to-head is circular
   *  (we'd be buying on Bybit's own book), so the comparison degrades to a hedge-cost FLOOR check. */
  hedgeVenue?: string | null;
}): PriceCompetitiveness => {
  const { optionId, bybit, sizeBtc, atticusPremiumUsdc, atticusHedgeCostUsdc } = args;
  const hedgeVenue = args.hedgeVenue ?? null;
  const bybitSourcedNote = hedgeVenue === "bybit"
    ? "Hedge sourced ON Bybit → edge vs Bybit is ~0 by construction; this is a hedge-cost floor check, not a head-to-head."
    : null;
  if (!bybit || !(bybit.ask_usdc_per_btc > 0) || !(sizeBtc > 0)) {
    return {
      available: false,
      compared_option_id: optionId,
      bybit_symbol: bybit?.symbol ?? null,
      bybit_strike: bybit?.strike ?? null,
      bybit_ask_usdc_per_btc: bybit?.ask_usdc_per_btc ?? null,
      bybit_tob_ask_usdc_per_btc: bybit?.tob_ask_usdc_per_btc ?? null,
      bybit_bid_usdc_per_btc: bybit?.bid_usdc_per_btc ?? null,
      bybit_spread_pct: null,
      bybit_fillable: null,
      bybit_premium_usdc: null,
      atticus_premium_usdc: round2(atticusPremiumUsdc),
      atticus_hedge_cost_usdc: round2(atticusHedgeCostUsdc),
      beats_bybit_retail: null,
      retail_edge_usdc: null,
      beats_bybit_hedge: null,
      hedge_edge_usdc: null,
      hedge_venue: hedgeVenue,
      note: bybitSourcedNote
    };
  }
  const bybitPremium = bybit.ask_usdc_per_btc * sizeBtc;
  const hedgeEdge = (bybit.ask_usdc_per_btc - atticusHedgeCostUsdc / sizeBtc) * sizeBtc;
  // Spread/fillability is judged on the TOP-OF-BOOK quote (the headline), not the size-aware ask.
  const spreadPct = spreadPctOf(bybit.tob_ask_usdc_per_btc ?? bybit.ask_usdc_per_btc, bybit.bid_usdc_per_btc);
  // Fillable only when the book is two-sided AND tight enough; a wide/one-sided ask is not a real
  // price, so "Bybit cheaper" on that ask would be misleading.
  const fillable = spreadPct == null ? false : spreadPct <= FILLABLE_MAX_SPREAD_PCT;
  return {
    available: true,
    compared_option_id: optionId,
    bybit_symbol: bybit.symbol,
    bybit_strike: bybit.strike,
    bybit_ask_usdc_per_btc: round2(bybit.ask_usdc_per_btc),
    bybit_tob_ask_usdc_per_btc: bybit.tob_ask_usdc_per_btc != null ? round2(bybit.tob_ask_usdc_per_btc) : round2(bybit.ask_usdc_per_btc),
    bybit_bid_usdc_per_btc: bybit.bid_usdc_per_btc != null ? round2(bybit.bid_usdc_per_btc) : null,
    bybit_spread_pct: spreadPct,
    bybit_fillable: fillable,
    bybit_premium_usdc: round2(bybitPremium),
    atticus_premium_usdc: round2(atticusPremiumUsdc),
    atticus_hedge_cost_usdc: round2(atticusHedgeCostUsdc),
    beats_bybit_retail: atticusPremiumUsdc <= bybitPremium,
    retail_edge_usdc: round2(bybitPremium - atticusPremiumUsdc),
    beats_bybit_hedge: atticusHedgeCostUsdc <= bybitPremium,
    hedge_edge_usdc: round2(hedgeEdge),
    hedge_venue: hedgeVenue,
    note: bybitSourcedNote
  };
};
