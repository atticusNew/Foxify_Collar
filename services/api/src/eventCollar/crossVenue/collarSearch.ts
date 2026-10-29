/**
 * Collar search shared by every hedge route.
 *
 * A route knows one thing the search does not: what it costs to buy D cents
 * of NO-state payout on its venue right now (walked through the live book,
 * fees exact). Everything else — the floor/cap grid, the credit identity, the
 * fee rule, the true EV cost, and which collars become the holder's tiers —
 * is the same math on both venues and lives here so the routes cannot drift.
 *
 * Credit identity (exact, integer units):
 *   funding = (100 - cap) x N          the cap slice the holder sells
 *   gross   = funding - hedgeCost - fees
 *   take    = max(share of gross, minimum on notional), waived when tiny
 *   credit  = gross - take              must be > 0 or the collar is not offered
 */

import type {
  CollarTerms,
  CrossRefusal,
  CrossSearchConfig,
  HedgeLeg,
  ProtectionTier,
  TakeRule,
} from "./types";
import { centsDownOf, centsUpOf, PROTECTION_TIERS } from "./types";

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

export interface TakeBreakdown {
  takeCents: number;
  takeShareCents: number;
  takeMinimumCents: number;
  takeRule: TakeRule;
  takeWaived: boolean;
}

/**
 * The fee rule. The share is rounded down (against the writer); the minimum
 * is rounded up (it is a floor). Whichever is larger is the take, unless it
 * is below the de minimis threshold, in which case nothing is charged.
 */
export function computeTake(
  grossCreditCents: number,
  contracts: number,
  cfg: Pick<CrossSearchConfig, "takeBps" | "minTakeBpsOfStake" | "deMinimisTakeCents">,
): TakeBreakdown {
  const takeShareCents = Math.floor((grossCreditCents * cfg.takeBps) / 10_000);
  const stakeCents = 100 * contracts;
  const takeMinimumCents =
    cfg.minTakeBpsOfStake > 0 ? Math.ceil((stakeCents * cfg.minTakeBpsOfStake) / 10_000) : 0;
  let takeCents = Math.max(takeShareCents, takeMinimumCents);
  let takeRule: TakeRule = takeMinimumCents > takeShareCents ? "minimum" : "share";
  const takeWaived = takeCents < cfg.deMinimisTakeCents;
  if (takeWaived) {
    takeCents = 0;
    takeRule = "waived";
  }
  return { takeCents, takeShareCents, takeMinimumCents, takeRule, takeWaived };
}

/** What a route reports for one collar's hedge: the leg as it would fill, or that the book is too thin. */
export type HedgeProbe = { ok: true; costCents: number; feesCents: number; hedge: HedgeLeg } | { ok: false };

export interface CollarSearchInputs {
  markCents: number;
  contracts: number;
  config: CrossSearchConfig;
  /** price the hedge for `digitalCents` of NO-state payout (already x contracts) */
  hedgeFor: (digitalCents: number) => HedgeProbe;
}

export interface CollarSearchResult {
  /** every collar the venue funds with a positive credit after the fee rule */
  candidates: CollarTerms[];
  /** the smallest gross shortfall seen (+Infinity when every gross was positive) */
  bestShortfallCents: number;
  /** collars whose gross was positive but did not cover the take */
  feeEaten: number;
  sawThinBook: boolean;
}

/** Walk the floor/cap grid and keep every collar the venue can fund. */
export function enumerateCollars(inputs: CollarSearchInputs): CollarSearchResult {
  const { config: cfg, contracts, markCents } = inputs;
  const candidates: CollarTerms[] = [];
  let bestShortfallCents = Number.POSITIVE_INFINITY;
  let feeEaten = 0;
  let sawThinBook = false;

  const floors = cfg.floorOffsetsCents
    .map((off) => markCents - off)
    .filter((f) => f >= cfg.minFloorCents && f < markCents);
  const caps = cfg.capOffsetsCents
    .map((off) => markCents + off)
    .filter((c) => c <= cfg.maxCapCents && c >= markCents + cfg.minCapHeadroomCents);

  for (const floorCents of floors) {
    for (const capCents of caps) {
      // the NO-state payout the writer must hold, never short; the funding the cap releases, never
      // over-counted (a fractional size can put either on a half cent)
      const digitalCents = centsUpOf(floorCents + 100 - capCents, contracts);
      if (digitalCents <= 0) continue;
      const probe = inputs.hedgeFor(digitalCents);
      if (!probe.ok) {
        sawThinBook = true;
        continue;
      }
      const fundingCents = centsDownOf(100 - capCents, contracts);
      const grossCreditCents = fundingCents - probe.costCents - probe.feesCents;
      if (grossCreditCents <= 0) {
        bestShortfallCents = Math.min(bestShortfallCents, -grossCreditCents);
        continue;
      }
      const take = computeTake(grossCreditCents, contracts, cfg);
      const creditCents = grossCreditCents - take.takeCents;
      if (creditCents <= 0) {
        feeEaten += 1;
        continue;
      }
      candidates.push({
        floorCents,
        capCents,
        creditCents,
        grossCreditCents,
        ...take,
        hedge: probe.hedge,
        feesCents: probe.feesCents,
        evCostBps: evCostBps(markCents, floorCents, capCents, creditCents, contracts),
      });
    }
  }
  return { candidates, bestShortfallCents, feeEaten, sawThinBook };
}

/** Today's rule: protect the holder's gains first, then the highest floor, then the largest credit. */
function tightBetter(cand: CollarTerms, best: CollarTerms, entryCents: number): boolean {
  const candProtectsEntry = cand.floorCents >= entryCents ? 1 : 0;
  const bestProtectsEntry = best.floorCents >= entryCents ? 1 : 0;
  if (candProtectsEntry !== bestProtectsEntry) return candProtectsEntry > bestProtectsEntry;
  if (cand.floorCents !== best.floorCents) return cand.floorCents > best.floorCents;
  return cand.creditCents > best.creditCents;
}

/** The lowest floor offered; at it, the most upside (highest cap), then the larger credit. */
function wideBetter(cand: CollarTerms, best: CollarTerms): boolean {
  if (cand.floorCents !== best.floorCents) return cand.floorCents < best.floorCents;
  if (cand.capCents !== best.capCents) return cand.capCents > best.capCents;
  return cand.creditCents > best.creditCents;
}

function pick(cands: CollarTerms[], better: (c: CollarTerms, b: CollarTerms) => boolean): CollarTerms | null {
  let best: CollarTerms | null = null;
  for (const c of cands) if (!best || better(c, best)) best = c;
  return best;
}

/** The value in `values` nearest `target`; ties resolved by `preferLower`. */
function nearest(values: number[], target: number, preferLower: boolean): number {
  return values.reduce((best, v) => {
    const d = Math.abs(v - target);
    const bd = Math.abs(best - target);
    if (d !== bd) return d < bd ? v : best;
    return preferLower ? Math.min(v, best) : Math.max(v, best);
  }, values[0]);
}

export const TIER_RULES: Record<ProtectionTier, string> = {
  tight: "most protection: the highest floor the venues fund, and the largest credit at it",
  balanced: "the middle: a floor halfway between tight and wide, and a cap halfway between the least and the most the venues fund at that floor",
  wide: "most upside: the lowest floor offered, with the highest cap the venues fund at it",
};

export interface TierSelection {
  /** the tier whose terms head the quote */
  tier: ProtectionTier;
  terms: CollarTerms;
  /** distinct tiers only; a tier that resolves to another's collar is dropped */
  tiers: Partial<Record<ProtectionTier, CollarTerms>>;
}

/**
 * Resolve the three tiers from the fundable set. Requires at least one
 * candidate. The requested default always resolves (to whichever surviving
 * tier owns its collar when it collapsed into another).
 *
 * The tiers live on the floor axis because that is the question a holder is
 * really answering ("how far below today's value may I fall?"); the cap is
 * then whatever the venues fund at that floor, chosen by each tier's rule.
 */
export function selectTiers(
  candidates: CollarTerms[],
  entryCents: number,
  defaultTier: ProtectionTier,
): TierSelection {
  if (candidates.length === 0) throw new Error("selectTiers needs at least one candidate");
  const tight = pick(candidates, (c, b) => tightBetter(c, b, entryCents)) as CollarTerms;
  const wide = pick(candidates, wideBetter) as CollarTerms;
  // Balanced: the fundable floor nearest the midpoint of tight's and wide's
  // (ties toward more protection), then the fundable cap at that floor nearest
  // the midpoint of the least and the most the venues fund there (ties toward
  // the larger credit). A midpoint on both axes, so it is a real middle rather
  // than a rule that quietly slides to one pole.
  const floors = [...new Set(candidates.map((c) => c.floorCents))];
  const midFloor = nearest(floors, (tight.floorCents + wide.floorCents) / 2, false);
  const atFloor = candidates.filter((c) => c.floorCents === midFloor);
  const caps = atFloor.map((c) => c.capCents);
  const midCap = nearest(caps, (Math.min(...caps) + Math.max(...caps)) / 2, true);
  const balanced = atFloor.find((c) => c.capCents === midCap) as CollarTerms;

  const all: Record<ProtectionTier, CollarTerms> = { tight, balanced, wide };
  const sameCollar = (a: CollarTerms, b: CollarTerms): boolean =>
    a.floorCents === b.floorCents && a.capCents === b.capCents;

  // Dedupe in tier order; remember which surviving name owns each collar.
  const tiers: Partial<Record<ProtectionTier, CollarTerms>> = {};
  const owner: Record<ProtectionTier, ProtectionTier> = { tight: "tight", balanced: "balanced", wide: "wide" };
  for (const name of PROTECTION_TIERS) {
    const dup = PROTECTION_TIERS.find((other) => tiers[other] && sameCollar(tiers[other] as CollarTerms, all[name]));
    if (dup) {
      owner[name] = dup;
    } else {
      tiers[name] = all[name];
    }
  }
  const tier = owner[defaultTier];
  return { tier, terms: tiers[tier] as CollarTerms, tiers };
}

/**
 * The honest refusal when the search found nothing to offer, worded for the
 * route. A positive gross eaten by the minimum fee is called out as such: the
 * venues did fund something, the fee rule declined it.
 */
export function refuseUnfunded(
  search: CollarSearchResult,
  cfg: CrossSearchConfig,
  words: { shortfall: string; thin: "pm_book_too_thin" | "kalshi_book_too_thin" | "prophetx_book_too_thin" | "novig_book_too_thin"; thinDetail: string; none: string },
): CrossRefusal {
  if (search.feeEaten > 0) {
    return {
      ok: false,
      code: "credit_nonpositive",
      detail: `the venues funded a small credit, but not one that covers the minimum fee (${cfg.minTakeBpsOfStake} bps of stake); refusing rather than charging more than the protection is worth`,
      bestShortfallCents: 1,
    };
  }
  if (Number.isFinite(search.bestShortfallCents)) {
    return {
      ok: false,
      code: "credit_nonpositive",
      detail: words.shortfall,
      bestShortfallCents: search.bestShortfallCents,
    };
  }
  if (search.sawThinBook) {
    return { ok: false, code: words.thin, detail: words.thinDetail };
  }
  return { ok: false, code: "credit_nonpositive", detail: words.none };
}
