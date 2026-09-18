/**
 * Shadow counterfactuals — what each proposed rule would have done, recorded
 * at the moment the live quote was.
 *
 * The shadow run opens one simulated position per market at its live terms.
 * That is the baseline. To evaluate a change (a different tier, a different
 * fee rule, a bigger size) honestly, the same books at the same instant are
 * re-priced under the alternative and the result is written next to the
 * baseline in the same ledger record. No extra venue calls; the books the
 * scanner already fetched are reused. When the market settles, every
 * alternative is marked against the same official result, so the comparison
 * is between rules, not between market conditions.
 *
 * Pure: takes books and terms, returns numbers. Nothing here trades.
 */

import { computeTake, evCostBps } from "./collarSearch";
import { quoteCrossWrap } from "./crossVenuePricer";
import { quoteLadderWrap, type NoAskLevel } from "./kalshiLadder";
import type {
  CollarTerms,
  CrossQuoteResult,
  CrossSearchConfig,
  HedgeRoute,
  MatchedPair,
  PmBook,
  ProtectionTier,
  TakeRule,
} from "./types";
import { PROTECTION_TIERS } from "./types";

/** One alternative collar as it would have been written, or why it was not. */
export type ShadowAltTerms =
  | {
      ok: true;
      floorCents: number;
      capCents: number;
      creditCents: number;
      grossCreditCents: number;
      takeCents: number;
      takeRule: TakeRule;
      feesCents: number;
      /** venue fees included */
      hedgeCostCents: number;
      hedgeUnitsMilli: number;
      evCostBps: number;
    }
  | { ok: false; refused: string };

/** Fee rules the shadow compares. Labels are stable ledger keys. */
export const FEE_RULE_LABELS = ["share_only", "min_25bps"] as const;
export type FeeRuleLabel = (typeof FEE_RULE_LABELS)[number];
const FEE_RULES: Record<FeeRuleLabel, Partial<CrossSearchConfig>> = {
  share_only: { minTakeBpsOfStake: 0 },
  min_25bps: { minTakeBpsOfStake: 25 },
};

/** Size multiples probed for the capacity curve (1x is the live position itself). */
export const SIZE_LADDER_MULTS = [1, 5, 20] as const;

export interface ShadowSizeProbe {
  mult: number;
  contracts: number;
  terms: ShadowAltTerms;
}

export interface ShadowCounterfactuals {
  /** every distinct tier the venues funded at open, keyed by tier name */
  alternatives: Partial<Record<ProtectionTier, ShadowAltTerms>>;
  /** the default tier re-priced under each fee rule */
  feeRules: Record<FeeRuleLabel, ShadowAltTerms>;
  /** the default tier re-priced at larger sizes on the same route and books */
  sizeLadder: ShadowSizeProbe[];
}

export interface CounterfactualInputs {
  route: HedgeRoute;
  ticker: string;
  /** when protection locks: game start (sports) or market close (crypto), ISO */
  lockTimeIso: string;
  /** the verified cross-venue pair; required for the polymarket route, null for crypto */
  pair: MatchedPair | null;
  markCents: number;
  entryCents: number;
  contracts: number;
  now: Date;
  config: CrossSearchConfig;
  books: { pmNoBook?: PmBook; noAsks?: NoAskLevel[] };
}

export function hedgeUnitsOfTerms(t: CollarTerms): number {
  return t.hedge.venue === "kalshi" ? t.hedge.contractsMilli : t.hedge.sharesMilli;
}

export function altFromTerms(t: CollarTerms): ShadowAltTerms {
  return {
    ok: true,
    floorCents: t.floorCents,
    capCents: t.capCents,
    creditCents: t.creditCents,
    grossCreditCents: t.grossCreditCents,
    takeCents: t.takeCents,
    takeRule: t.takeRule,
    feesCents: t.feesCents,
    hedgeCostCents: t.hedge.costCents + t.feesCents,
    hedgeUnitsMilli: hedgeUnitsOfTerms(t),
    evCostBps: t.evCostBps,
  };
}

function altFromQuote(q: CrossQuoteResult): ShadowAltTerms {
  return q.ok ? altFromTerms(q) : { ok: false, refused: q.code };
}

/** Re-quote on the recorded route with the given config and size. Null when that route's book was not kept. */
export function requote(inputs: CounterfactualInputs, config: CrossSearchConfig, contracts: number): CrossQuoteResult | null {
  const base = { markCents: inputs.markCents, entryCents: inputs.entryCents, contracts, now: inputs.now, config };
  if (inputs.route === "polymarket") {
    if (!inputs.books.pmNoBook || !inputs.pair) return null;
    return quoteCrossWrap({ ...base, pair: inputs.pair, noBook: inputs.books.pmNoBook });
  }
  if (!inputs.books.noAsks) return null;
  return quoteLadderWrap({
    ...base,
    pair: {
      kalshi: { ticker: inputs.ticker },
      gameStartTime: inputs.lockTimeIso,
      ...(inputs.pair ? { pm: { eventSlug: inputs.pair.pm.eventSlug } } : {}),
    },
    noAsks: inputs.books.noAsks,
  });
}

const UNAVAILABLE: ShadowAltTerms = { ok: false, refused: "book_not_retained" };

/**
 * Everything the report needs, from one live quote's books. `live` is the
 * quote actually recorded; its tiers are the alternatives (no re-pricing
 * needed for those, they came from the same search).
 */
export function counterfactualsFor(
  inputs: CounterfactualInputs,
  live: Extract<CrossQuoteResult, { ok: true }>,
): ShadowCounterfactuals {
  const alternatives: Partial<Record<ProtectionTier, ShadowAltTerms>> = {};
  for (const tier of PROTECTION_TIERS) {
    const t = live.tiers[tier];
    if (t) alternatives[tier] = altFromTerms(t);
  }

  // Fee rules are compared on the SAME collar: same floor, cap and hedge, only
  // the take recomputed. That isolates the fee's effect exactly; letting the
  // search re-pick a collar under the other rule would mix two changes.
  const feeRules = {} as Record<FeeRuleLabel, ShadowAltTerms>;
  for (const label of FEE_RULE_LABELS) {
    const cfg = { ...inputs.config, ...FEE_RULES[label] };
    const take = computeTake(live.grossCreditCents, inputs.contracts, cfg);
    const creditCents = live.grossCreditCents - take.takeCents;
    const same = altFromTerms(live) as Extract<ShadowAltTerms, { ok: true }>;
    feeRules[label] =
      creditCents > 0
        ? {
            ...same,
            creditCents,
            takeCents: take.takeCents,
            takeRule: take.takeRule,
            evCostBps: evCostBps(inputs.markCents, live.floorCents, live.capCents, creditCents, inputs.contracts),
          }
        : { ok: false, refused: "fee_exceeds_gross" };
  }

  const sizeLadder: ShadowSizeProbe[] = SIZE_LADDER_MULTS.map((mult) => {
    const contracts = inputs.contracts * mult;
    if (mult === 1) return { mult, contracts, terms: altFromTerms(live) };
    const q = requote(inputs, inputs.config, contracts);
    return { mult, contracts, terms: q ? altFromQuote(q) : UNAVAILABLE };
  });

  return { alternatives, feeRules, sizeLadder };
}
