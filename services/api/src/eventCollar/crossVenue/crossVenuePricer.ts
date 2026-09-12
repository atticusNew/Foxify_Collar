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
 *   credit    = gross - take               (take waived when de minimis)
 * Quotes refuse honestly when gross <= 0: the venues did not fund a credit.
 *
 * Unit discipline: prices and sizes in integer milli units; their product is
 * exact micro dollars; one conversion to cents, rounded against the credit.
 */

import type {
  CrossHedgeLeg,
  CrossQuoteResult,
  CrossSearchConfig,
  PmBook,
  PmBookLevel,
} from "./types";
import type { MatchedPair } from "./types";

export interface CrossPricerInputs {
  pair: MatchedPair;
  markCents: number;
  entryCents: number;
  contracts: number;
  now: Date;
  /** live CLOB book for the OPPOSING outcome token (the hedge instrument) */
  noBook: PmBook;
  config: CrossSearchConfig;
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

/**
 * The true cost of the protection in expected-value terms at the market's own
 * odds, in basis points of the naked position's expected value. Exact integer
 * math in centi-cent units; positive = the insurance costs EV, negative = the
 * venue gap is fat enough that the protected position beats the naked one.
 *
 *   nakedEV     = mark * N                      (per contract: 100c w.p. mark/100)
 *   protectedEV = (cap*N + credit) * mark/100 + (floor*N + credit) * (100-mark)/100
 */
export function evCostBps(
  markCents: number,
  floorCents: number,
  capCents: number,
  creditCents: number,
  contracts: number,
): number {
  const nakedX = 100 * contracts * markCents; // centi-cents
  if (nakedX <= 0) return 0;
  const protX =
    (capCents * contracts + creditCents) * markCents +
    (floorCents * contracts + creditCents) * (100 - markCents);
  return Math.round(((nakedX - protX) * 10_000) / nakedX);
}

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
  const { noBook } = inputs;
  if (noBook.asks.length === 0) {
    return {
      ok: false,
      code: "pm_book_empty",
      detail: `no executable asks on the opposing outcome (${pair.pm.outcomes[pair.pmNoOutcomeIndex]})`,
    };
  }

  const minSharesMilli = Math.max(1, noBook.minOrderSizeShares) * 1000;

  interface Candidate {
    floorCents: number;
    capCents: number;
    creditCents: number;
    grossCreditCents: number;
    takeCents: number;
    takeWaived: boolean;
    feesCents: number;
    hedge: CrossHedgeLeg;
  }

  let best: Candidate | null = null;
  let bestShortfall = Number.POSITIVE_INFINITY;
  let sawThinBook = false;

  const floors = cfg.floorOffsetsCents
    .map((off) => markCents - off)
    .filter((f) => f >= cfg.minFloorCents && f < markCents);
  const caps = cfg.capOffsetsCents
    .map((off) => markCents + off)
    .filter((c) => c <= cfg.maxCapCents && c >= markCents + cfg.minCapHeadroomCents);

  for (const floorCents of floors) {
    for (const capCents of caps) {
      const digitalCents = (floorCents + 100 - capCents) * contracts;
      if (digitalCents <= 0) continue;
      // digitalCents cents of NO-state payout = digitalCents * 10 milli-shares
      // ($1 per share in the NO state). Rounded up via integer construction,
      // clamped to the venue minimum order size - never under-hedged.
      const sharesMilli = Math.max(digitalCents * 10, minSharesMilli);

      const walk = walkPmAsks(noBook.asks, sharesMilli);
      if (!walk) {
        sawThinBook = true;
        continue;
      }
      const hedgeCostCents = Math.ceil(walk.costMicroUsd / 10_000);
      const feesCents =
        cfg.hedgeFeeFlatCents + Math.ceil((hedgeCostCents * cfg.hedgeFeeBps) / 10_000);

      const fundingCents = (100 - capCents) * contracts;
      const grossCreditCents = fundingCents - hedgeCostCents - feesCents;
      if (grossCreditCents <= 0) {
        bestShortfall = Math.min(bestShortfall, -grossCreditCents);
        continue;
      }
      let takeCents = Math.floor((grossCreditCents * cfg.takeBps) / 10_000);
      const takeWaived = takeCents < cfg.deMinimisTakeCents;
      if (takeWaived) takeCents = 0;
      const creditCents = grossCreditCents - takeCents;
      if (creditCents <= 0) {
        bestShortfall = Math.min(bestShortfall, 1);
        continue;
      }

      const candidate: Candidate = {
        floorCents,
        capCents,
        creditCents,
        grossCreditCents,
        takeCents,
        takeWaived,
        feesCents,
        hedge: {
          action: "buy",
          venue: "polymarket",
          outcome: pair.pm.outcomes[pair.pmNoOutcomeIndex],
          tokenId: pair.pm.tokenIds[pair.pmNoOutcomeIndex],
          sharesMilli,
          avgPriceMilli: walk.avgPriceMilli,
          worstPriceMilli: walk.worstPriceMilli,
          costCents: hedgeCostCents,
        },
      };

      // Selection: protect the holder's gains first (highest floor at or above
      // entry when the market funds it), then the largest credit at that floor.
      const better = (() => {
        if (!best) return true;
        const candProtectsEntry = candidate.floorCents >= entryCents ? 1 : 0;
        const bestProtectsEntry = best.floorCents >= entryCents ? 1 : 0;
        if (candProtectsEntry !== bestProtectsEntry) return candProtectsEntry > bestProtectsEntry;
        if (candidate.floorCents !== best.floorCents) {
          return candidate.floorCents > best.floorCents;
        }
        return candidate.creditCents > best.creditCents;
      })();
      if (better) best = candidate;
    }
  }

  if (!best) {
    if (Number.isFinite(bestShortfall)) {
      return {
        ok: false,
        code: "credit_nonpositive",
        detail:
          "the opposing venue's live book cannot fund a positive credit on any quotable floor/cap right now",
        bestShortfallCents: bestShortfall,
      };
    }
    if (sawThinBook) {
      return {
        ok: false,
        code: "pm_book_too_thin",
        detail: "the opposing venue's book lacks the depth to hedge this size leg-for-leg",
      };
    }
    return {
      ok: false,
      code: "credit_nonpositive",
      detail: "no quotable floor/cap combination for this pair",
    };
  }

  return {
    ok: true,
    kalshiTicker: pair.kalshi.ticker,
    pmEventSlug: pair.pm.eventSlug,
    contracts,
    markCents,
    entryCents,
    floorCents: best.floorCents,
    capCents: best.capCents,
    creditCents: best.creditCents,
    grossCreditCents: best.grossCreditCents,
    takeCents: best.takeCents,
    takeBps: cfg.takeBps,
    takeWaived: best.takeWaived,
    hedge: best.hedge,
    feesCents: best.feesCents,
    parityNote: pair.parityNote,
    quotedAt: inputs.now.toISOString(),
  };
}
