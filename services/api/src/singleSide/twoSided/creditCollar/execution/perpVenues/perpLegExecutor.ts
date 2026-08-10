/**
 * Venue-agnostic perp-leg executor — the contract every perp venue adapter implements.
 *
 * The credit-collar facility opens REAL perp legs (one-sided per venue; neutrality spans venues)
 * and wraps them in options collars hedged elsewhere. This interface is the seam between the
 * strategy layer (which decides "long 0.5 BTC on venue A / short on venue B") and each venue's
 * plumbing (auth, order shapes, rounding, funding). Adapters are additive: Hyperliquid first,
 * dYdX/GRVT/etc. as design-partner or grant work lands. NOT wired into the running shadow
 * service — consumed by the principal-mode runner when live capital arrives.
 */

export type PerpLegSide = "long" | "short";

export type PerpLegFill = {
  status: "filled" | "partial" | "unfilled" | "error";
  requestedSz: number;
  filledSz: number;
  avgPx: number | null;
  /** Venue order id when available (for audit trail + cancels). */
  oid?: number | string | null;
  message?: string;
  raw?: unknown;
};

export type OpenLegRequest = {
  coin: string; // venue-native coin symbol, e.g. "BTC"
  side: PerpLegSide;
  notionalUsdc: number;
  /** Aggressive-IOC limit distance from mid (fraction, e.g. 0.005 = 50 bps). Default per adapter. */
  slippagePct?: number;
};

export type CloseLegRequest = {
  coin: string;
  side: PerpLegSide; // side of the OPEN leg being closed (adapter sends the opposite, reduce-only)
  sz: number; // base size to close
  slippagePct?: number;
};

export interface PerpLegExecutor {
  readonly venue: string;
  midPx(coin: string): Promise<number>;
  /** Open a leg as an aggressive IOC limit (market orders are venue-inconsistent; IOC is our house pattern). */
  openLeg(req: OpenLegRequest): Promise<PerpLegFill>;
  /** Close (reduce-only, aggressive IOC). Never increases exposure. */
  closeLeg(req: CloseLegRequest): Promise<PerpLegFill>;
  /** Signed position size in base units (+long / −short / 0 flat). */
  positionSz(coin: string): Promise<number>;
  /** Current funding rate in bps per 8h (null when the venue doesn't expose it cleanly). */
  fundingBpsPer8h(coin: string): Promise<number | null>;
}
