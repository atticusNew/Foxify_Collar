/**
 * Kalshi self-hedge (ladder) route — the wrap's digital obligation hedged on
 * the SAME market being protected: buy No contracts, which pay exactly $1 in
 * the NO state. Same instrument, same settlement rule, zero basis risk, and
 * (unlike the cross-venue route) fully inside one regulated venue.
 *
 * Buying No crosses the market's live yes bids: a resting yes bid at p cents
 * fills a No buy at (100 - p) cents. Depth for the hedge is therefore the yes
 * bid ladder, walked best (highest bid) first.
 *
 * Unit discipline: quantities in integer milli contracts (1000 = 1 contract,
 * Kalshi's fixed-point book has fractional dust), prices integer cents. Cost
 * products land in milli cents, converted once to cents rounded AGAINST the
 * holder's credit. Kalshi's taker fee (0.07 * C * p * (1 - p), rounded up) is
 * computed exactly on the walked fills.
 */

import { dollarsToCents, fetchJsonWithRetry, kalshiBase } from "../kalshiPublic";
import { decimalToMilli } from "./polymarketPublic";
import type {
  CrossQuoteResult,
  CrossSearchConfig,
  KalshiSelfHedgeLeg,
  MatchedPair,
} from "./types";

/** One level of No-side executable depth (derived from a yes bid). */
export interface NoAskLevel {
  priceCents: number; // what a No buy pays at this level (100 - yes bid)
  qtyMilli: number; // 1000 = 1 contract, truncated down (against the depth we trust)
}

/**
 * Parse a raw orderbook response into No-side asks, best (cheapest) first.
 * Supports the fixed-point shape ({ orderbook_fp: { yes_dollars: [["0.5900","86245.13"], ...] } })
 * and the integer-cents shape ({ orderbook: { yes: [[59, 86245], ...] } }).
 */
export function parseNoAsks(raw: Record<string, unknown>): NoAskLevel[] {
  const out: NoAskLevel[] = [];
  const fp = raw.orderbook_fp as Record<string, unknown> | undefined;
  const legacy = raw.orderbook as Record<string, unknown> | undefined;
  if (fp && Array.isArray(fp.yes_dollars)) {
    for (const lvl of fp.yes_dollars as Array<[string, string]>) {
      const bidCents = dollarsToCents(lvl?.[0]);
      const qtyMilli = decimalToMilli(lvl?.[1], false);
      if (bidCents > 0 && bidCents < 100 && qtyMilli > 0) {
        out.push({ priceCents: 100 - bidCents, qtyMilli });
      }
    }
  } else if (legacy && Array.isArray(legacy.yes)) {
    for (const lvl of legacy.yes as Array<[number, number]>) {
      const bidCents = Number(lvl?.[0]);
      const qty = Number(lvl?.[1]);
      if (Number.isInteger(bidCents) && bidCents > 0 && bidCents < 100 && qty > 0) {
        out.push({ priceCents: 100 - bidCents, qtyMilli: Math.floor(qty * 1000) });
      }
    }
  }
  return out.sort((a, b) => a.priceCents - b.priceCents);
}

/** Live No-side executable depth for one market. */
export async function getNoAsks(
  ticker: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NoAskLevel[]> {
  const url = `${kalshiBase()}/markets/${encodeURIComponent(ticker)}/orderbook`;
  const data = (await fetchJsonWithRetry(url, fetchImpl)) as Record<string, unknown>;
  return parseNoAsks(data);
}

/**
 * Kalshi taker fee on one fill, exact: 0.07 * C * p * (1 - p) dollars, rounded
 * up to the cent. With qty in milli contracts and p in cents, the cents value
 * is 7 * qtyMilli * p * (100 - p) / 10_000_000.
 */
export function kalshiTakerFeeCents(qtyMilli: number, priceCents: number): number {
  if (qtyMilli <= 0 || priceCents <= 0 || priceCents >= 100) return 0;
  return Math.ceil((7 * qtyMilli * priceCents * (100 - priceCents)) / 10_000_000);
}

/**
 * Walk No asks (best-first) for contractsMilli; exact milli-cent cost plus the
 * exact taker fee on each fill. Null when the visible depth cannot fill.
 */
export function walkNoAsks(
  levels: NoAskLevel[],
  contractsMilli: number,
): { costCents: number; feeCents: number; avgPriceCents: number; worstPriceCents: number } | null {
  let remaining = contractsMilli;
  let costMilliCents = 0;
  let feeCents = 0;
  let worst = 0;
  for (const lvl of levels) {
    if (lvl.priceCents <= 0 || lvl.qtyMilli <= 0) continue;
    const take = Math.min(remaining, lvl.qtyMilli);
    costMilliCents += take * lvl.priceCents; // milli contracts * cents = milli cents, exact
    feeCents += kalshiTakerFeeCents(take, lvl.priceCents);
    worst = lvl.priceCents;
    remaining -= take;
    if (remaining <= 0) break;
  }
  if (remaining > 0) return null;
  return {
    costCents: Math.ceil(costMilliCents / 1000),
    feeCents,
    avgPriceCents: Math.ceil(costMilliCents / contractsMilli),
    worstPriceCents: worst,
  };
}

export interface LadderPricerInputs {
  pair: MatchedPair;
  markCents: number;
  entryCents: number;
  contracts: number;
  now: Date;
  /** live No-side executable depth for the protected market itself */
  noAsks: NoAskLevel[];
  config: CrossSearchConfig;
}

/** Quote the wrap hedged on the protected market's own No side. */
export function quoteLadderWrap(inputs: LadderPricerInputs): CrossQuoteResult {
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
  if (inputs.noAsks.length === 0) {
    return {
      ok: false,
      code: "kalshi_book_empty",
      detail: "no executable depth on this market's No side",
    };
  }

  const MIN_CONTRACTS_MILLI = 1000; // Kalshi minimum order: 1 contract

  interface Candidate {
    floorCents: number;
    capCents: number;
    creditCents: number;
    grossCreditCents: number;
    takeCents: number;
    takeWaived: boolean;
    feesCents: number;
    hedge: KalshiSelfHedgeLeg;
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
      // digitalCents cents of NO-state payout = digitalCents * 10 milli
      // contracts ($1 per contract in the NO state). Rounded up via integer
      // construction, clamped to the venue minimum - never under-hedged.
      const contractsMilli = Math.max(digitalCents * 10, MIN_CONTRACTS_MILLI);

      const walk = walkNoAsks(inputs.noAsks, contractsMilli);
      if (!walk) {
        sawThinBook = true;
        continue;
      }
      const feesCents =
        walk.feeCents +
        cfg.hedgeFeeFlatCents +
        Math.ceil((walk.costCents * cfg.hedgeFeeBps) / 10_000);

      const fundingCents = (100 - capCents) * contracts;
      const grossCreditCents = fundingCents - walk.costCents - feesCents;
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
          venue: "kalshi",
          outcome: "No",
          ticker: pair.kalshi.ticker,
          contractsMilli,
          avgPriceCents: walk.avgPriceCents,
          worstPriceCents: walk.worstPriceCents,
          costCents: walk.costCents,
        },
      };

      // Same selection discipline as the cross-venue route: protect the
      // holder's gains first, then the largest credit at that floor.
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
          "this market's own No side cannot fund a positive credit on any quotable floor/cap right now",
        bestShortfallCents: bestShortfall,
      };
    }
    if (sawThinBook) {
      return {
        ok: false,
        code: "kalshi_book_too_thin",
        detail: "this market's No side lacks the depth to hedge this size leg-for-leg",
      };
    }
    return {
      ok: false,
      code: "credit_nonpositive",
      detail: "no quotable floor/cap combination on the self-hedge route",
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
    parityNote: "the hedge is the protected market's own No side; settlement is identical by construction",
    quotedAt: inputs.now.toISOString(),
  };
}
