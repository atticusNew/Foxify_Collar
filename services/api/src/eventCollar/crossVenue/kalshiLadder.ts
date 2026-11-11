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
} from "./types";
import { enumerateCollars, refuseUnfunded, selectTiers, tierCreditLineCents } from "./collarSearch";

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
 * Kalshi maker fee on one fill of a resting order, exact:
 * M * 0.0175 * C * p * (1 - p) dollars, rounded up to the cent. M is the
 * market's multiplier, 1 on a standard market. Charged only when the resting
 * order executes; a cancelled order pays nothing. The venue rebates round-up
 * excess over $10 in a month; that rebate is not counted here, so this is
 * never under what the venue takes.
 *
 * With qty in milli contracts, p in cents and M in thousandths, the cents
 * value is 175 * Mmilli * qtyMilli * p * (100 - p) / 10^12. BigInt: the
 * product passes 2^53 at sizes a ledger can hold.
 */
export function kalshiMakerFeeCents(qtyMilli: number, priceCents: number, multiplier = 1): number {
  if (qtyMilli <= 0 || priceCents <= 0 || priceCents >= 100) return 0;
  if (!Number.isFinite(multiplier) || multiplier <= 0) throw new Error("kalshi maker fee: the multiplier has to be a positive number");
  const multiplierMilli = Math.ceil(multiplier * 1000);
  const num = 175n * BigInt(multiplierMilli) * BigInt(Math.ceil(qtyMilli)) * BigInt(Math.round(priceCents)) * BigInt(100 - Math.round(priceCents));
  const den = 1_000_000_000_000n;
  return Number((num + den - 1n) / den);
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

/**
 * The self-hedge route needs no cross-venue pairing, so it accepts a minimal
 * structural subset of MatchedPair: the protected market's ticker, the moment
 * protection must lock (game start for sports, market close for crypto), and
 * the Polymarket slug only when one exists.
 */
export interface LadderPricerInputs {
  pair: {
    kalshi: { ticker: string };
    gameStartTime: string;
    pm?: { eventSlug: string };
  };
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
      detail: `this market locks in ${Math.max(0, Math.round(minutesToStart))}m; the lock needs at least ${cfg.minMinutesToStart}m`,
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

  const search = enumerateCollars({
    markCents,
    contracts,
    config: cfg,
    hedgeFor: (digitalCents) => {
      // digitalCents cents of NO-state payout = digitalCents * 10 milli
      // contracts ($1 per contract in the NO state). Rounded up via integer
      // construction, clamped to the venue minimum - never under-hedged.
      const contractsMilli = Math.max(digitalCents * 10, MIN_CONTRACTS_MILLI);
      const walk = walkNoAsks(inputs.noAsks, contractsMilli);
      if (!walk) return { ok: false };
      const feesCents =
        walk.feeCents +
        cfg.hedgeFeeFlatCents +
        Math.ceil((walk.costCents * cfg.hedgeFeeBps) / 10_000);
      const hedge: KalshiSelfHedgeLeg = {
        action: "buy",
        venue: "kalshi",
        outcome: "No",
        ticker: pair.kalshi.ticker,
        contractsMilli,
        avgPriceCents: walk.avgPriceCents,
        worstPriceCents: walk.worstPriceCents,
        costCents: walk.costCents,
      };
      return { ok: true, costCents: walk.costCents, feesCents, hedge };
    },
  });

  if (search.candidates.length === 0) {
    return refuseUnfunded(search, cfg, {
      shortfall:
        "this market's own No side cannot fund a positive credit on any quotable floor/cap right now",
      thin: "kalshi_book_too_thin",
      thinDetail: "this market's No side lacks the depth to hedge this size leg-for-leg",
      none: "no quotable floor/cap combination on the self-hedge route",
    });
  }

  const sel = selectTiers(search.candidates, entryCents, cfg.defaultTier, tierCreditLineCents(cfg, contracts));
  return {
    ok: true,
    kalshiTicker: pair.kalshi.ticker,
    pmEventSlug: pair.pm?.eventSlug ?? "",
    contracts,
    markCents,
    entryCents,
    ...sel.terms,
    takeBps: cfg.takeBps,
    minTakeBpsOfStake: cfg.minTakeBpsOfStake,
    tier: sel.tier,
    tiers: sel.tiers,
    candidatesConsidered: search.candidates.length,
    parityNote: "the hedge is the locked market's own No side; settlement is identical by construction",
    quotedAt: inputs.now.toISOString(),
  };
}
