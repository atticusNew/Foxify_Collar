/**
 * RFQ routing for the collar: the pricer finds the structure, a desk is asked
 * for one net price on it, and the better of desk and book executes.
 *
 * Today the hedge is "walk the OKX book and take". A request for quote (FalconX,
 * OKX block, Bullish) prices the same two legs as ONE package: no leg risk, no
 * spread from walking depth, size without depth refusals, dealer fees instead
 * of taker fees. What it costs is a firm window of a few seconds against a user
 * who taps when they tap, so the user's terms come from the model with a buffer
 * and the fill trues them up afterwards, never down.
 *
 * P&L IDENTITY (re-derived; this module changes WHERE the hedge fills, never who
 * keeps a payoff at settlement). Per cycle with credit C shown at the tap, net
 * fill N (after venue or dealer fees), take rate r:
 *   shown:   C = (1 - r) * N_quoted            take_quoted = r * N_quoted
 *   fill better by d = N - N_quoted > 0:
 *            trader += (1 - r) * d              writer take += r * d
 *            (writer = take still, on the larger net)
 *   fill worse by d < 0:
 *            trader keeps C                     writer = take_quoted + d  (the shortfall is ours)
 * So the one place writer != take is a fill below the quote, bounded by the
 * buffer the quote carried, and it is recorded per position as fillShortfallCents.
 * Nothing here touches the floor, the cap or the hand-back.
 *
 * Pure. Money in integer cents. No venue calls; adapters live in scripts.
 */

export type RfqLegType = "put" | "call";
export type RfqLegSide = "buy" | "sell";

export interface RfqLeg {
  side: RfqLegSide;
  type: RfqLegType;
  strikeCents: number;
  expiryIso: string;
  /** option contracts (OKX lot = 0.01 BTC) */
  contracts: number;
  ctValBtc: number;
}

export interface RfqPackage {
  underlying: string;
  legs: [RfqLeg, RfqLeg];
  /** contracts x ctVal, BTC: the size every quote is for */
  qtyBtc: number;
  /** the net the book offered for the same package after fees, cents (the reference price) */
  bookNetCents: number;
  /** the net a desk must beat for the package to route to it, cents */
  beatBookNetCents: number;
}

export interface RfqRouteConfig {
  /** route to RFQ only above this notional (cents); small wraps go to the book */
  sizeThresholdCents: number;
  /** the desk must improve on the book by at least this many bps of notional */
  minImprovementBps: number;
  /** when the desk and the book are within this many cents, prefer the book (one less relationship on the fill) */
  tieCents: number;
}

export const DEFAULT_RFQ_ROUTE: RfqRouteConfig = { sizeThresholdCents: 5_000_000, minImprovementBps: 1, tieCents: 50 };

export const rfqConfigFromEnv = (env: Record<string, string | undefined> = process.env): RfqRouteConfig => {
  const n = (v: string | undefined, d: number) => (v != null && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  return {
    sizeThresholdCents: Math.round(n(env.EP_RFQ_SIZE_THRESHOLD_USD, DEFAULT_RFQ_ROUTE.sizeThresholdCents / 100) * 100),
    minImprovementBps: n(env.EP_RFQ_MIN_IMPROVEMENT_BPS, DEFAULT_RFQ_ROUTE.minImprovementBps),
    tieCents: Math.round(n(env.EP_RFQ_TIE_USD, DEFAULT_RFQ_ROUTE.tieCents / 100) * 100),
  };
};

export interface CollarForRfq {
  side: "long" | "short";
  underlying?: string;
  contracts: number;
  ctValBtc: number;
  notionalCents: number;
  expiryIso: string;
  floorStrikeCents: number;
  capStrikeCents: number;
  /** gross - venue fees on the book, cents: what walking the book would net */
  bookNetCreditCents: number;
}

/**
 * The collar as one package: a long position buys its floor put and sells its cap call; a short
 * mirrors (buys the floor call, sells the cap put). The desk is asked for the net on both.
 */
export function packageFor(c: CollarForRfq, cfg: RfqRouteConfig = DEFAULT_RFQ_ROUTE): RfqPackage {
  const base = { expiryIso: c.expiryIso, contracts: c.contracts, ctValBtc: c.ctValBtc };
  const legs: [RfqLeg, RfqLeg] =
    c.side === "long"
      ? [
          { side: "buy", type: "put", strikeCents: c.floorStrikeCents, ...base },
          { side: "sell", type: "call", strikeCents: c.capStrikeCents, ...base },
        ]
      : [
          { side: "buy", type: "call", strikeCents: c.floorStrikeCents, ...base },
          { side: "sell", type: "put", strikeCents: c.capStrikeCents, ...base },
        ];
  const minImprovement = Math.round((c.notionalCents * cfg.minImprovementBps) / 10_000);
  return {
    underlying: c.underlying ?? "BTC",
    legs,
    qtyBtc: +(c.contracts * c.ctValBtc).toFixed(8),
    bookNetCents: c.bookNetCreditCents,
    beatBookNetCents: c.bookNetCreditCents + Math.max(minImprovement, cfg.tieCents),
  };
}

export type RfqRoute = "rfq" | "book";

export interface RfqDecision {
  route: RfqRoute;
  /** desk net minus book net, cents (positive = the desk pays the holder more) */
  improvementCents: number | null;
  reason: "below_size_threshold" | "no_dealer_quote" | "dealer_worse" | "within_tie" | "dealer_better";
}

/** Which venue fills the hedge. The desk wins only when it clears the book by the published margin. */
export function decideRoute(
  input: { notionalCents: number; bookNetCents: number; dealerNetCents: number | null },
  cfg: RfqRouteConfig = DEFAULT_RFQ_ROUTE,
): RfqDecision {
  if (input.notionalCents < cfg.sizeThresholdCents) return { route: "book", improvementCents: input.dealerNetCents == null ? null : input.dealerNetCents - input.bookNetCents, reason: "below_size_threshold" };
  if (input.dealerNetCents == null) return { route: "book", improvementCents: null, reason: "no_dealer_quote" };
  const improvement = input.dealerNetCents - input.bookNetCents;
  const minImprovement = Math.max(Math.round((input.notionalCents * cfg.minImprovementBps) / 10_000), cfg.tieCents);
  if (improvement < 0) return { route: "book", improvementCents: improvement, reason: "dealer_worse" };
  if (improvement < minImprovement) return { route: "book", improvementCents: improvement, reason: "within_tie" };
  return { route: "rfq", improvementCents: improvement, reason: "dealer_better" };
}

export interface TrueUp {
  /** the credit the holder receives, cents: never below what was shown */
  creditCents: number;
  /** our take after the fill, cents */
  takeCents: number;
  /** a fill below the quote: what we absorbed, cents (0 when the fill met or beat the quote) */
  fillShortfallCents: number;
  /** a fill above the quote: what the holder gained from it, cents */
  holderGainCents: number;
}

/**
 * The fill against the quote. Better fills are shared at the take rate (the holder gets 1 - r of
 * the improvement, we get r); worse fills are ours. The shown credit is a floor on what the
 * holder receives, so a user never sees a number go down after the tap.
 */
export function trueUpCredit(input: { shownCreditCents: number; quotedTakeCents: number; quotedNetCents: number; filledNetCents: number; takeRate: number }): TrueUp {
  const d = input.filledNetCents - input.quotedNetCents;
  if (d >= 0) {
    const takeGain = Math.round(d * input.takeRate);
    const holderGain = d - takeGain;
    return { creditCents: input.shownCreditCents + holderGain, takeCents: input.quotedTakeCents + takeGain, fillShortfallCents: 0, holderGainCents: holderGain };
  }
  return { creditCents: input.shownCreditCents, takeCents: input.quotedTakeCents + d, fillShortfallCents: -d, holderGainCents: 0 };
}
