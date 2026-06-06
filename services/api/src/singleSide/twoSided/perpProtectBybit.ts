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
  ask_usdc_per_btc: number;
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
  bybit_ask_usdc_per_btc: number | null;
  bybit_premium_usdc: number | null;         // Bybit ask × size (their comparable premium to the trader)
  atticus_premium_usdc: number | null;       // our retail premium for the compared option
  atticus_hedge_cost_usdc: number | null;    // our cheapest cross-venue hedge cost
  beats_bybit_retail: boolean | null;        // our retail premium ≤ Bybit's premium (cheaper to trader)
  retail_edge_usdc: number | null;           // Bybit premium − our retail (positive = we win)
  beats_bybit_hedge: boolean | null;         // our hedge cost ≤ Bybit ask (sourcing headroom)
  hedge_edge_usdc: number | null;            // (Bybit ask − our hedge) × size
};

const round2 = (x: number): number => +x.toFixed(2);

/** Build the internal competitiveness diagnostic from our compared option + the Bybit leg (or null). */
export const compareToBybit = (args: {
  optionId: string | null;
  bybit: BybitLegQuote | null;
  sizeBtc: number;
  atticusPremiumUsdc: number;
  atticusHedgeCostUsdc: number;
}): PriceCompetitiveness => {
  const { optionId, bybit, sizeBtc, atticusPremiumUsdc, atticusHedgeCostUsdc } = args;
  if (!bybit || !(bybit.ask_usdc_per_btc > 0) || !(sizeBtc > 0)) {
    return {
      available: false,
      compared_option_id: optionId,
      bybit_symbol: bybit?.symbol ?? null,
      bybit_strike: bybit?.strike ?? null,
      bybit_ask_usdc_per_btc: bybit?.ask_usdc_per_btc ?? null,
      bybit_premium_usdc: null,
      atticus_premium_usdc: round2(atticusPremiumUsdc),
      atticus_hedge_cost_usdc: round2(atticusHedgeCostUsdc),
      beats_bybit_retail: null,
      retail_edge_usdc: null,
      beats_bybit_hedge: null,
      hedge_edge_usdc: null
    };
  }
  const bybitPremium = bybit.ask_usdc_per_btc * sizeBtc;
  const hedgeEdge = (bybit.ask_usdc_per_btc - atticusHedgeCostUsdc / sizeBtc) * sizeBtc;
  return {
    available: true,
    compared_option_id: optionId,
    bybit_symbol: bybit.symbol,
    bybit_strike: bybit.strike,
    bybit_ask_usdc_per_btc: round2(bybit.ask_usdc_per_btc),
    bybit_premium_usdc: round2(bybitPremium),
    atticus_premium_usdc: round2(atticusPremiumUsdc),
    atticus_hedge_cost_usdc: round2(atticusHedgeCostUsdc),
    beats_bybit_retail: atticusPremiumUsdc <= bybitPremium,
    retail_edge_usdc: round2(bybitPremium - atticusPremiumUsdc),
    beats_bybit_hedge: atticusHedgeCostUsdc <= bybitPremium,
    hedge_edge_usdc: round2(hedgeEdge)
  };
};
