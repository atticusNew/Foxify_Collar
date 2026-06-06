/**
 * Perp Protect — cross-venue leg selection (pure, testable).
 *
 * Probes (OKX / Deribit / Bullish) each snap to their OWN nearest listed expiry + strike, so the
 * raw "cheapest ask across venues" can silently pick a SHORTER-DATED (and therefore cheaper) leg,
 * underpricing the protection and mis-routing the venue. This module makes the comparison honest:
 *
 *   A1 (expiry-normalization): reject legs whose listed expiry deviates from the requested tenor by
 *       more than `maxTenorDeviationPct`, and compare survivors on a PER-DAY basis (so a 5d leg that
 *       is cheaper in absolute terms but pricier per day does not beat a 7d leg at the target tenor).
 *   B2 (liquidity guard): reject legs whose top-of-book relative spread exceeds `maxSpreadPct`
 *       (a wide/stale quote is not a tradable price). Legs with no spread signal are allowed.
 *
 * Routing stays per-leg: BUY the long leg at the cheapest qualifying ask; SELL the short leg at the
 * highest qualifying bid (legs may live on different venues). The RETURNED price is the raw ask/bid
 * for the chosen leg's actual expiry — only the SELECTION metric is per-day-normalized.
 */

export type LegRow = {
  venue?: string | null;
  ask: number | null; // USDC per BTC
  bid: number | null; // USDC per BTC
  strike: number | null;
  daysToExpiry?: number | null;
  spreadPct?: number | null;
  /** Venue instrument id of the priced leg (kept so a later /activate can execute the SAME option). */
  instrument?: string | null;
  expiryIso?: string | null;
  /** Depth diagnostics for the size-aware (B4) effective price already reflected in ask/bid. */
  askCovered?: boolean | null;
  askSlippagePct?: number | null;
  bidCovered?: boolean | null;
  bidSlippagePct?: number | null;
};

export type LegSelectConfig = {
  targetTenorDays: number;
  /** Max |days−target|/target before a leg is rejected as off-tenor. Default 0.35. */
  maxTenorDeviationPct?: number;
  /** Max top-of-book relative spread before a leg is rejected as illiquid. Default 0.20. */
  maxSpreadPct?: number;
};

export type PickedLeg = {
  venue: string | null;
  ask: number | null;
  bid: number | null;
  strike: number;
  daysToExpiry: number | null;
  spreadPct: number | null;
  instrument: string | null;
  expiryIso: string | null;
  askCovered: boolean | null;
  askSlippagePct: number | null;
  bidCovered: boolean | null;
  bidSlippagePct: number | null;
};

export type LegSelection = {
  bestAsk: PickedLeg | null;
  bestBid: PickedLeg | null;
  consideredAsks: number; // legs that passed both filters and had a usable ask
  consideredBids: number; // legs that passed both filters and had a usable bid
};

const DEFAULT_MAX_TENOR_DEVIATION_PCT = 0.35;
const DEFAULT_MAX_SPREAD_PCT = 0.20;

/** True when the leg's listed expiry is close enough to the requested tenor (or tenor is unknown). */
const passesTenor = (days: number | null | undefined, target: number, maxDev: number): boolean => {
  if (days == null || !(days > 0) || !(target > 0)) return true; // no tenor signal → don't reject
  return Math.abs(days - target) / target <= maxDev;
};

/** True when the leg's top-of-book spread is tight enough (or there is no spread signal). */
const passesLiquidity = (spreadPct: number | null | undefined, maxSpread: number): boolean => {
  if (spreadPct == null) return true; // no liquidity signal → don't reject
  return spreadPct <= maxSpread;
};

/** Per-day price used ONLY as the selection metric; falls back to the raw price when tenor unknown. */
const perDay = (price: number, days: number | null | undefined): number => (days != null && days > 0 ? price / days : price);

/**
 * Select the cheapest qualifying ask (long leg) and the highest qualifying bid (short leg) across
 * venues, applying the expiry-normalization (A1) and liquidity (B2) guards. Pure.
 */
export const pickBestLegs = (rows: LegRow[], cfg: LegSelectConfig): LegSelection => {
  const maxDev = cfg.maxTenorDeviationPct ?? DEFAULT_MAX_TENOR_DEVIATION_PCT;
  const maxSpread = cfg.maxSpreadPct ?? DEFAULT_MAX_SPREAD_PCT;
  const target = cfg.targetTenorDays;

  const qualified = rows.filter(
    (r) => r.strike != null && r.strike > 0 && passesTenor(r.daysToExpiry, target, maxDev) && passesLiquidity(r.spreadPct, maxSpread)
  );

  const askCands = qualified.filter((r): r is LegRow & { ask: number; strike: number } => r.ask != null && r.ask > 0);
  const bidCands = qualified.filter((r): r is LegRow & { bid: number; strike: number } => r.bid != null && r.bid > 0);

  const toPicked = (r: LegRow): PickedLeg => ({
    venue: r.venue ?? null,
    ask: r.ask,
    bid: r.bid,
    strike: r.strike as number,
    daysToExpiry: r.daysToExpiry ?? null,
    spreadPct: r.spreadPct ?? null,
    instrument: r.instrument ?? null,
    expiryIso: r.expiryIso ?? null,
    askCovered: r.askCovered ?? null,
    askSlippagePct: r.askSlippagePct ?? null,
    bidCovered: r.bidCovered ?? null,
    bidSlippagePct: r.bidSlippagePct ?? null
  });

  // Cheapest ASK by per-day cost (tie → lower absolute ask).
  const bestAskRow = askCands.length
    ? askCands.reduce((best, r) => {
        const a = perDay(r.ask as number, r.daysToExpiry);
        const b = perDay(best.ask as number, best.daysToExpiry);
        if (a < b) return r;
        if (a > b) return best;
        return (r.ask as number) < (best.ask as number) ? r : best;
      })
    : null;

  // Highest BID by per-day credit (tie → higher absolute bid).
  const bestBidRow = bidCands.length
    ? bidCands.reduce((best, r) => {
        const a = perDay(r.bid as number, r.daysToExpiry);
        const b = perDay(best.bid as number, best.daysToExpiry);
        if (a > b) return r;
        if (a < b) return best;
        return (r.bid as number) > (best.bid as number) ? r : best;
      })
    : null;

  return {
    bestAsk: bestAskRow ? toPicked(bestAskRow) : null,
    bestBid: bestBidRow ? toPicked(bestBidRow) : null,
    consideredAsks: askCands.length,
    consideredBids: bidCands.length
  };
};
