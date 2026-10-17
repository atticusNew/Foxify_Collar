/**
 * Probability-space collar pricer for binary event markets.
 *
 * The holder owns N Kalshi YES contracts (each pays $1 or $0 at resolution).
 * A wrap sets a floor f and cap c (cents) around the current mark m and pays a
 * credit k at resolution:
 *   - resolves NO:  holder receives f + k/N per contract (instead of 0)
 *   - resolves YES: holder receives c + k/N per contract (instead of 100)
 *
 * Hedge (leg-for-leg, listed): the wrap's net obligation is (f + 100 - c) cents
 * per contract payable in the NO state. That is a digital put at the Kalshi
 * strike, replicated with the adjacent listed OKX put vertical (buy the higher
 * strike put, sell the lower). One vertical of width W dollars on a 0.01 BTC
 * contract pays exactly W cents when settled below the low strike.
 *
 * Credit identity (exact, integer cents):
 *   funding   = (100 - c) * N            (the cap slice the holder sells)
 *   hedgeCost = verticals * debit + fees (executable, book-walked, rounded up)
 *   gross     = funding - hedgeCost
 *   credit    = gross - take             (take waived when de minimis)
 * Quotes refuse honestly when gross <= 0: the market did not fund a credit.
 *
 * Verticals are rounded UP so the floor is never under-hedged; the extra cost
 * is charged to the structure, never hidden from the holder.
 */

import type {
  HedgeAlignment,
  OkxBookLevel,
  VerticalLegBooks,
  WrapLegPlan,
  WrapQuoteResult,
  WrapSearchConfig,
  WrapSettlement,
} from "./types";

export interface PricerInputs {
  marketTicker: string;
  markCents: number;
  entryCents: number;
  contracts: number;
  resolutionTime: Date;
  now: Date;
  indexPxUsd: number;
  vertical: VerticalLegBooks;
  hedgeExpiry: string;
  hedgeExpiryTime: Date;
  config: WrapSearchConfig;
}

/** Walk one side of a book for `contracts`; null when depth is insufficient. */
export function walkBook(
  levels: OkxBookLevel[],
  contracts: number,
): { avgPriceBtc: number; worstPriceBtc: number } | null {
  let remaining = contracts;
  let costBtc = 0;
  let worst = 0;
  for (const lvl of levels) {
    if (lvl.priceBtc <= 0 || lvl.sizeContracts <= 0) continue;
    const take = Math.min(remaining, lvl.sizeContracts);
    costBtc += take * lvl.priceBtc;
    worst = lvl.priceBtc;
    remaining -= take;
    if (remaining <= 0) break;
  }
  if (remaining > 0) return null;
  return { avgPriceBtc: costBtc / contracts, worstPriceBtc: worst };
}

/** Ceil division for positive integers. */
function ceilDiv(a: number, b: number): number {
  return Math.floor((a + b - 1) / b);
}

export function hedgeAlignment(
  resolutionTime: Date,
  expiryTime: Date,
  toleranceMinutes: number,
): HedgeAlignment {
  const deltaMin = Math.abs(expiryTime.getTime() - resolutionTime.getTime()) / 60_000;
  return deltaMin <= toleranceMinutes ? "expiry_aligned" : "unwind_at_resolution";
}

export function quoteWrap(inputs: PricerInputs): WrapQuoteResult {
  const { config: cfg, contracts, markCents, entryCents } = inputs;

  const minutesToResolution =
    (inputs.resolutionTime.getTime() - inputs.now.getTime()) / 60_000;
  if (minutesToResolution < cfg.minMinutesToResolution) {
    return {
      ok: false,
      code: "market_too_close_to_resolution",
      detail: `resolution in ${Math.max(0, Math.round(minutesToResolution))}m; protection needs at least ${cfg.minMinutesToResolution}m`,
    };
  }
  if (markCents < cfg.markLowerBoundCents || markCents > cfg.markUpperBoundCents) {
    return {
      ok: false,
      code: "mark_out_of_range",
      detail: `mark ${markCents}c is outside the quotable ${cfg.markLowerBoundCents}c-${cfg.markUpperBoundCents}c band`,
    };
  }

  const { vertical } = inputs;
  const widthUsd = vertical.highStrike - vertical.lowStrike;
  if (widthUsd <= 0) {
    return { ok: false, code: "no_bracketing_strikes", detail: "vertical width is not positive" };
  }
  if (vertical.highPut.asks.length === 0 || vertical.lowPut.bids.length === 0) {
    return {
      ok: false,
      code: "okx_book_empty",
      detail: `no executable side on ${vertical.highPut.instId} / ${vertical.lowPut.instId}`,
    };
  }

  const alignment = hedgeAlignment(
    inputs.resolutionTime,
    inputs.hedgeExpiryTime,
    cfg.alignmentToleranceMinutes,
  );
  // Digital cents paid per vertical when settled below the low strike:
  // 0.01 BTC * widthUsd dollars = widthUsd cents.
  const digitalCentsPerVertical = widthUsd;

  interface Candidate {
    floorCents: number;
    capCents: number;
    creditCents: number;
    grossCreditCents: number;
    takeCents: number;
    takeWaived: boolean;
    spreads: number;
    digitalPutMicro: number;
    feesCents: number;
    legs: WrapLegPlan[];
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
      const digitalCentsNeeded = (floorCents + 100 - capCents) * contracts;
      if (digitalCentsNeeded <= 0) continue;
      const spreads = ceilDiv(digitalCentsNeeded, digitalCentsPerVertical);

      const buyWalk = walkBook(vertical.highPut.asks, spreads);
      const sellWalk = walkBook(vertical.lowPut.bids, spreads);
      if (!buyWalk || !sellWalk) {
        sawThinBook = true;
        continue;
      }
      // Executable debit per vertical in cents, rounded up (cost side).
      const debitBtcPerVertical = Math.max(0, buyWalk.avgPriceBtc - sellWalk.avgPriceBtc);
      let debitCentsPerVertical = Math.ceil(debitBtcPerVertical * 0.01 * inputs.indexPxUsd * 100);
      if (alignment === "unwind_at_resolution") {
        debitCentsPerVertical = Math.ceil(
          (debitCentsPerVertical * (10_000 + cfg.unalignedHaircutBps)) / 10_000,
        );
      }
      const digitalPutMicro = Math.round(
        (debitCentsPerVertical * 1_000_000) / digitalCentsPerVertical,
      );

      const feesCents = cfg.feeCentsPerSpread * spreads;
      const fundingCents = (100 - capCents) * contracts;
      const hedgeCostCents = spreads * debitCentsPerVertical + feesCents;
      const grossCreditCents = fundingCents - hedgeCostCents;
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
        spreads,
        digitalPutMicro,
        feesCents,
        legs: [
          {
            action: "buy",
            instId: vertical.highPut.instId,
            contracts: spreads,
            premiumCents: Math.ceil(buyWalk.avgPriceBtc * spreads * 0.01 * inputs.indexPxUsd * 100),
            avgPriceBtc: buyWalk.avgPriceBtc,
          },
          {
            action: "sell",
            instId: vertical.lowPut.instId,
            contracts: spreads,
            premiumCents: Math.floor(
              sellWalk.avgPriceBtc * spreads * 0.01 * inputs.indexPxUsd * 100,
            ),
            avgPriceBtc: sellWalk.avgPriceBtc,
          },
        ],
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
          "live option books cannot fund a positive credit on any quotable floor/cap for this market right now",
        bestShortfallCents: bestShortfall,
      };
    }
    if (sawThinBook) {
      return {
        ok: false,
        code: "okx_book_too_thin",
        detail: "listed books lack the depth to hedge this size leg-for-leg",
      };
    }
    return {
      ok: false,
      code: "credit_nonpositive",
      detail: "no quotable floor/cap combination for this market",
    };
  }

  return {
    ok: true,
    marketTicker: inputs.marketTicker,
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
    digitalPutMicro: best.digitalPutMicro,
    spreads: best.spreads,
    verticalWidthUsd: widthUsd,
    hedgeExpiry: inputs.hedgeExpiry,
    alignment,
    legs: best.legs,
    feesCents: best.feesCents,
    quotedAt: inputs.now.toISOString(),
  };
}

/** Settlement math for a concluded (simulated) wrap. */
export function settleWrap(
  outcome: "yes" | "no",
  terms: { floorCents: number; capCents: number; creditCents: number; contracts: number },
): WrapSettlement {
  const protectedPayoutCents = outcome === "yes" ? terms.capCents : terms.floorCents;
  const nakedPayoutCents = outcome === "yes" ? 100 : 0;
  return {
    outcome,
    protectedPayoutCents,
    nakedPayoutCents,
    creditCents: terms.creditCents,
    contracts: terms.contracts,
    totalProtectedCents: protectedPayoutCents * terms.contracts + terms.creditCents,
    totalNakedCents: nakedPayoutCents * terms.contracts,
  };
}
