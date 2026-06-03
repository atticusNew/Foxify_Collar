/**
 * Size-aware market-impact model for the executable MTM mark.
 *
 * WHY: our close value is the top-of-book venue BID. For a SMALL order (e.g. the 10k
 * cell ≈ 0.14 BTC) the top-of-book bid is achievable. For a LARGE order (the 150k cell
 * ≈ 2+ BTC) the sale WALKS DOWN the book — the realized price is below the top bid. A
 * single top-of-book mark therefore OVERSTATES the realizable value for large cells,
 * which would make TP fire on a price we can't get at size.
 *
 * IDEAL: value at the VWAP for our actual size from the full order-book ladder. We do
 * NOT currently store multi-level depth (the chain snapshot is top-of-book only), so
 * this is an explicit MARKET-IMPACT MODEL, not real depth:
 *
 *   impact_fraction = clamp( per_btc × max(0, contractsBtc − free_btc), 0, max_fraction )
 *   executable_mark = top_of_book_mark × (1 − impact_fraction)
 *
 *   - free_btc      : size that fills at ~top-of-book with no impact (≈ typical ATM
 *                     top-of-book depth). Default 1.0 → small cells get ZERO impact.
 *   - per_btc       : fraction of value lost per BTC of size ABOVE free_btc. Default 0.05.
 *   - max_fraction  : cap. Default 0.20.
 *
 * All env-tunable; calibrate against realized large-cell close fills as they accrue
 * (closeFillCalibration), or replace with true ladder-VWAP once multi-level depth is
 * stored. Default-on but a NO-OP for sub-free_btc sizes, so current (small) live pairs
 * are unaffected.
 */

const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

export type SizeImpactConfig = { enabled: boolean; freeBtc: number; perBtc: number; maxFraction: number };

export const getSizeImpactConfig = (env: NodeJS.ProcessEnv = process.env): SizeImpactConfig => ({
  enabled: String(env.SS_MTM_SIZE_IMPACT ?? "true").toLowerCase() !== "false",
  freeBtc: num(env.SS_MTM_SIZE_IMPACT_FREE_BTC, 1.0),
  perBtc: num(env.SS_MTM_SIZE_IMPACT_PER_BTC, 0.05),
  maxFraction: num(env.SS_MTM_SIZE_IMPACT_MAX, 0.20)
});

/** Fraction (0..maxFraction) of value lost to market impact when SELLING contractsBtc. */
export const sizeImpactFraction = (contractsBtc: number, cfg: SizeImpactConfig = getSizeImpactConfig()): number => {
  if (!cfg.enabled || !Number.isFinite(contractsBtc) || contractsBtc <= 0) return 0;
  const excess = Math.max(0, contractsBtc - cfg.freeBtc);
  return Math.min(cfg.maxFraction, cfg.perBtc * excess);
};

/** Multiplier (≤1) to apply to the top-of-book executable mark for a SELL of contractsBtc. */
export const sizeImpactMultiplier = (contractsBtc: number, cfg?: SizeImpactConfig): number =>
  1 - sizeImpactFraction(contractsBtc, cfg);
