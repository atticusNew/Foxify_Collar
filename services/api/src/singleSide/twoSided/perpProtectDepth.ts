/**
 * Perp Protect — depth-aware effective pricing (B4, pure + testable).
 *
 * Top-of-book understates the true fill cost for a size that walks the book. This computes a
 * size-weighted average price (VWAP) over order-book levels up to the requested size, and reports
 * whether the displayed book can actually cover it.
 *
 * Contract→BTC multipliers (CONFIRMED from each venue's PUBLIC instrument endpoint — no creds):
 *   - OKX  coin-margined BTC-USD options: ctVal=1, ctMult=0.01, ctValCcy=BTC  ⇒ 1 contract = 0.01 BTC.
 *   - Deribit BTC options: contract_size = 1.0                                  ⇒ amount is in BTC.
 *   - Bullish: TBD (needs Render); callers pass already-BTC sizes or omit depth.
 * Prices in every level are normalized to USDC per BTC (premium per unit underlying), matching the
 * rest of the engine.
 */

/** Confirmed contract size in BTC per 1 contract, by venue (public-API verified). */
export const VENUE_CONTRACT_BTC: Record<string, number> = { okx: 0.01, deribit: 1.0 };

export type BookLevel = { priceUsdcPerBtc: number; sizeBtc: number };

export type VwapResult = {
  /** Size-weighted average price (USDC/BTC) to fill up to `sizeBtc`; null if no usable levels. */
  effective_usdc_per_btc: number | null;
  /** BTC actually fillable from the displayed book (≤ sizeBtc). */
  filled_btc: number;
  /** True when the displayed book covers the full requested size. */
  covered: boolean;
  /** Top-of-book price (USDC/BTC) for reference. */
  top_of_book_usdc_per_btc: number | null;
  /** effective / top − 1: how much worse than top-of-book the size-aware fill is. */
  slippage_vs_top_pct: number | null;
};

/**
 * VWAP to fill `sizeBtc` by walking the book in execution order: ASK (buy) = cheapest first; BID
 * (sell) = highest first. Levels may be passed unsorted. `slippage_vs_top_pct` is the fill's cost
 * relative to top-of-book in the adverse direction (positive = worse: pay more / receive less). Pure.
 */
export const vwapToFill = (levels: BookLevel[], sizeBtc: number, side: "ask" | "bid" = "ask"): VwapResult => {
  const usable = levels
    .filter((l) => l.priceUsdcPerBtc > 0 && l.sizeBtc > 0)
    .sort((a, b) => (side === "bid" ? b.priceUsdcPerBtc - a.priceUsdcPerBtc : a.priceUsdcPerBtc - b.priceUsdcPerBtc));
  const top = usable.length ? usable[0].priceUsdcPerBtc : null;
  if (!(sizeBtc > 0) || usable.length === 0) {
    return { effective_usdc_per_btc: top, filled_btc: 0, covered: false, top_of_book_usdc_per_btc: top, slippage_vs_top_pct: top != null ? 0 : null };
  }
  let remaining = sizeBtc;
  let cost = 0;
  let filled = 0;
  for (const lvl of usable) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, lvl.sizeBtc);
    cost += take * lvl.priceUsdcPerBtc;
    filled += take;
    remaining -= take;
  }
  const covered = remaining <= 1e-12;
  const effective = filled > 0 ? cost / filled : top;
  // Adverse-direction slippage: ask pays MORE than top (effective/top−1); bid receives LESS (top/effective−1).
  const slippage = effective != null && top != null && top > 0 && effective > 0
    ? +((side === "bid" ? top / effective : effective / top) - 1).toFixed(4)
    : null;
  return {
    effective_usdc_per_btc: effective != null ? +effective.toFixed(2) : null,
    filled_btc: +filled.toFixed(8),
    covered,
    top_of_book_usdc_per_btc: top != null ? +top.toFixed(2) : null,
    slippage_vs_top_pct: slippage
  };
};

/** Convert raw [priceUnderlying-in-USDC-per-BTC, sizeInContracts] rows to BTC-sized BookLevels. */
export const levelsToBtc = (raw: Array<{ priceUsdcPerBtc: number; sizeContracts: number }>, contractBtc: number): BookLevel[] =>
  raw
    .filter((r) => r.priceUsdcPerBtc > 0 && r.sizeContracts > 0)
    .map((r) => ({ priceUsdcPerBtc: r.priceUsdcPerBtc, sizeBtc: r.sizeContracts * contractBtc }));
