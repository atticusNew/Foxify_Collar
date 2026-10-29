/**
 * Cross-venue probability-space collar pricer (Tier 2).
 *
 * The holder owns N Kalshi YES contracts on a whitelisted game market. A wrap
 * sets floor f and cap c (cents) and pays a credit at settlement:
 *   - settles NO:  holder receives f + credit/N per contract (instead of 0)
 *   - settles YES: holder receives c + credit/N per contract (instead of 100)
 *
 * Hedge (leg-for-leg, cross-venue): the wrap's net obligation is
 * (f + 100 - c) cents per contract payable in the NO state. On Tier 1 that
 * digital was replicated with listed option verticals; here the instrument
 * exists outright: the OPPOSING outcome token on Polymarket pays exactly $1
 * in the NO state. Shares needed = (f + 100 - c) * N / 100, rounded UP and
 * clamped to the venue's minimum order size - never under-hedged.
 *
 * Credit identity (exact, integer units):
 *   funding   = (100 - c) * N cents        (the cap slice the holder sells)
 *   hedgeCost = walked NO-token ask, micro dollars -> cents rounded up, + fees
 *   gross     = funding - hedgeCost
 *   credit    = gross - take               (take = max(share, minimum), waived when tiny)
 * Quotes refuse honestly when gross <= 0: the venues did not fund a credit.
 * The grid walk, fee rule and tier selection are shared with the self-hedge
 * route (collarSearch.ts); this file only knows how to price the hedge.
 *
 * Unit discipline: prices and sizes in integer milli units; their product is
 * exact micro dollars; one conversion to cents, rounded against the credit.
 */

import type {
  CrossHedgeLeg,
  CrossQuoteResult,
  CrossSearchConfig,
  HedgeLeg,
  PmBook,
  PmBookLevel,
  ProphetXHedgeLeg,
} from "./types";
import type { MatchedPair } from "./types";
import { enumerateCollars, evCostBps, refuseUnfunded, selectTiers } from "./collarSearch";

/**
 * The ProphetX route priced through the same walk: the opposing strike's asks (fee folded by the
 * caller, prophetxOrders.ts) in the book's shape, the leg a ProphetX leg, the refusals ProphetX's.
 */
export interface ProphetXHedgeOn {
  venue: "prophetx";
  strikeId: string;
  offsetStrikeId?: string;
  outcome: string;
}

export interface CrossPricerInputs {
  pair: MatchedPair;
  markCents: number;
  entryCents: number;
  contracts: number;
  now: Date;
  /** live CLOB book for the OPPOSING outcome token (the hedge instrument) */
  noBook: PmBook;
  config: CrossSearchConfig;
  /** absent: Polymarket's opposing token (tokenId from the pair); given: the ProphetX strike */
  hedgeOn?: ProphetXHedgeOn;
}

/**
 * Walk ask levels (best-first) for sharesMilli; exact micro-dollar cost.
 * Null when the visible book cannot fill the size.
 */
export function walkPmAsks(
  asks: PmBookLevel[],
  sharesMilli: number,
): { costMicroUsd: number; avgPriceMilli: number; worstPriceMilli: number } | null {
  let remaining = sharesMilli;
  let costMicroUsd = 0;
  let worst = 0;
  for (const lvl of asks) {
    if (lvl.priceMilli <= 0 || lvl.sizeMilli <= 0) continue;
    const take = Math.min(remaining, lvl.sizeMilli);
    costMicroUsd += take * lvl.priceMilli; // milli * milli = micro dollars, exact
    worst = lvl.priceMilli;
    remaining -= take;
    if (remaining <= 0) break;
  }
  if (remaining > 0) return null;
  return {
    costMicroUsd,
    avgPriceMilli: Math.ceil(costMicroUsd / sharesMilli),
    worstPriceMilli: worst,
  };
}

export { evCostBps };

export function quoteCrossWrap(inputs: CrossPricerInputs): CrossQuoteResult {
  const { config: cfg, contracts, markCents, entryCents, pair } = inputs;

  const minutesToStart =
    (new Date(pair.gameStartTime).getTime() - inputs.now.getTime()) / 60_000;
  if (minutesToStart < cfg.minMinutesToStart) {
    return {
      ok: false,
      code: "market_too_close_to_start",
      detail: `the game starts in ${Math.max(0, Math.round(minutesToStart))}m; pre-game protection needs at least ${cfg.minMinutesToStart}m`,
    };
  }
  if (markCents < cfg.markLowerBoundCents || markCents > cfg.markUpperBoundCents) {
    return {
      ok: false,
      code: "mark_out_of_range",
      detail: `mark ${markCents}c is outside the quotable ${cfg.markLowerBoundCents}c-${cfg.markUpperBoundCents}c band`,
    };
  }
  const { noBook, hedgeOn } = inputs;
  const opposing = hedgeOn ? hedgeOn.outcome : pair.pm.outcomes[pair.pmNoOutcomeIndex];
  if (noBook.asks.length === 0) {
    return {
      ok: false,
      code: hedgeOn ? "prophetx_book_empty" : "pm_book_empty",
      detail: hedgeOn ? `no executable asks on the opposing strike (${opposing}) on ProphetX` : `no executable asks on the opposing outcome (${opposing})`,
    };
  }

  const minSharesMilli = Math.max(1, noBook.minOrderSizeShares) * 1000;
  const legFor = (walk: NonNullable<ReturnType<typeof walkPmAsks>>, sharesMilli: number, hedgeCostCents: number): HedgeLeg => {
    if (hedgeOn) {
      const leg: ProphetXHedgeLeg = {
        action: "buy",
        venue: "prophetx",
        outcome: hedgeOn.outcome,
        strikeId: hedgeOn.strikeId,
        ...(hedgeOn.offsetStrikeId ? { offsetStrikeId: hedgeOn.offsetStrikeId } : {}),
        sharesMilli,
        avgPriceMilli: walk.avgPriceMilli,
        worstPriceMilli: walk.worstPriceMilli,
        costCents: hedgeCostCents,
      };
      return leg;
    }
    const leg: CrossHedgeLeg = {
      action: "buy",
      venue: "polymarket",
      outcome: opposing,
      tokenId: pair.pm.tokenIds[pair.pmNoOutcomeIndex],
      sharesMilli,
      avgPriceMilli: walk.avgPriceMilli,
      worstPriceMilli: walk.worstPriceMilli,
      costCents: hedgeCostCents,
    };
    return leg;
  };

  const search = enumerateCollars({
    markCents,
    contracts,
    config: cfg,
    hedgeFor: (digitalCents) => {
      // digitalCents cents of NO-state payout = digitalCents * 10 milli-shares
      // ($1 per share in the NO state). Rounded up via integer construction,
      // clamped to the venue minimum order size - never under-hedged.
      const sharesMilli = Math.max(digitalCents * 10, minSharesMilli);
      const walk = walkPmAsks(noBook.asks, sharesMilli);
      if (!walk) return { ok: false };
      const hedgeCostCents = Math.ceil(walk.costMicroUsd / 10_000);
      const feesCents =
        cfg.hedgeFeeFlatCents + Math.ceil((hedgeCostCents * cfg.hedgeFeeBps) / 10_000);
      return { ok: true, costCents: hedgeCostCents, feesCents, hedge: legFor(walk, sharesMilli, hedgeCostCents) };
    },
  });

  if (search.candidates.length === 0) {
    const venueWords = hedgeOn ? "ProphetX's" : "the opposing venue's";
    return refuseUnfunded(search, cfg, {
      shortfall: `${venueWords} live book cannot fund a positive credit on any quotable floor/cap right now`,
      thin: hedgeOn ? "prophetx_book_too_thin" : "pm_book_too_thin",
      thinDetail: `${venueWords} book lacks the depth to hedge this size leg-for-leg`,
      none: "no quotable floor/cap combination for this pair",
    });
  }

  const sel = selectTiers(search.candidates, entryCents, cfg.defaultTier);
  return {
    ok: true,
    kalshiTicker: pair.kalshi.ticker,
    pmEventSlug: pair.pm.eventSlug,
    contracts,
    markCents,
    entryCents,
    ...sel.terms,
    takeBps: cfg.takeBps,
    minTakeBpsOfStake: cfg.minTakeBpsOfStake,
    tier: sel.tier,
    tiers: sel.tiers,
    candidatesConsidered: search.candidates.length,
    parityNote: pair.parityNote,
    quotedAt: inputs.now.toISOString(),
  };
}
