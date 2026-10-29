/**
 * MINIMUM CREDIT — the one rule that decides whether a fundable collar is worth offering.
 *
 * A tier is offered only when its credit is at least `cents` and at least `bpsOfStake` of the
 * stake (100¢ × contracts). Defaults: 5¢ and 0.25%. On a 150-contract position that is 38¢; on a
 * 10-contract one, 5¢. The credit is the leftover of the collar, not its point (every cent of
 * credit is a cent of cap the holder did not keep), so the absolute line only stops pennies that
 * would not cover a transfer; below it we refuse rather than offer them.
 *
 * The rule runs SERVER-SIDE, in the scan, so the board, the embed and the shadow record all see
 * the same quote: the same tiers offered, the same default, the same refusals. The embed's page
 * script mirrors it (same numbers, passed in from the server) only so a stale client can never
 * show a tier the server would not.
 *
 * Promotion: when the default tier is under the line but another tier clears, that tier becomes
 * the top-level terms (Most upside first, then Balanced, then the highest floor). When nothing clears the
 * quote becomes a refusal, `credit_too_small`, counted in the receipts as its own reason.
 */

import type { CollarTerms, CrossQuote, CrossQuoteResult, ProtectionTier } from "./types";

export interface MinimumCreditRule {
  /** absolute floor on the credit, cents */
  cents: number;
  /** floor on the credit as bps of stake (100¢ × contracts) */
  bpsOfStake: number;
}

export const DEFAULT_MINIMUM_CREDIT: MinimumCreditRule = { cents: 5, bpsOfStake: 25 };

/** The order a promoted tier is chosen in when the quoted default is under the line: the most upside first. */
const PROMOTION_ORDER: readonly ProtectionTier[] = ["wide", "balanced", "tight"];

export function minimumCreditRuleFromEnv(env: NodeJS.ProcessEnv): MinimumCreditRule {
  const num = (v: string | undefined, dflt: number): number => {
    const n = Number(v);
    return v !== undefined && v.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  return {
    cents: Math.round(num(env.EVENT_X_MIN_CREDIT_CENTS, DEFAULT_MINIMUM_CREDIT.cents)),
    bpsOfStake: num(env.EVENT_X_MIN_CREDIT_BPS, DEFAULT_MINIMUM_CREDIT.bpsOfStake),
  };
}

/** The line for one position: the larger of the absolute floor and the stake-relative floor, cents. */
export function minimumCreditCents(contracts: number, rule: MinimumCreditRule = DEFAULT_MINIMUM_CREDIT): number {
  return Math.max(rule.cents, Math.round((contracts * 100 * rule.bpsOfStake) / 10_000));
}

export function clearsMinimumCredit(creditCents: number, contracts: number, rule: MinimumCreditRule = DEFAULT_MINIMUM_CREDIT): boolean {
  return creditCents >= minimumCreditCents(contracts, rule);
}

export function describeMinimumCredit(rule: MinimumCreditRule = DEFAULT_MINIMUM_CREDIT): string {
  return `${rule.cents}¢ and ${(rule.bpsOfStake / 100).toFixed(2)}% of stake, whichever is more`;
}

/**
 * Apply the rule to a quote. Tiers under the line are dropped; the default is kept if it clears,
 * else the first clearing tier in PROMOTION_ORDER is promoted to the top-level terms; if none
 * clears, a `credit_too_small` refusal that names the best credit and the line.
 */
export function applyMinimumCredit(quote: CrossQuoteResult, rule: MinimumCreditRule = DEFAULT_MINIMUM_CREDIT): CrossQuoteResult {
  if (!quote.ok) return quote;
  const line = minimumCreditCents(quote.contracts, rule);
  const offered: Partial<Record<ProtectionTier, CollarTerms>> = {};
  let best = quote.creditCents;
  for (const [name, t] of Object.entries(quote.tiers) as Array<[ProtectionTier, CollarTerms | undefined]>) {
    if (!t) continue;
    best = Math.max(best, t.creditCents);
    if (t.creditCents >= line) offered[name] = t;
  }
  // a quote whose top-level terms are not in `tiers` (legacy shape) is judged on its own credit
  if (Object.keys(quote.tiers).length === 0 && quote.creditCents >= line) return quote;

  if (offered[quote.tier]) {
    // nothing dropped: the same object back, so callers can tell "untouched" from "trimmed"
    return Object.keys(offered).length === Object.keys(quote.tiers).length ? quote : { ...quote, tiers: offered };
  }
  const promoted = PROMOTION_ORDER.find((name) => offered[name]);
  if (promoted) {
    const t = offered[promoted] as CollarTerms;
    const next: CrossQuote = { ...quote, ...t, tier: promoted, tiers: offered };
    return next;
  }
  const stake = (quote.contracts * 100) / 100;
  return {
    ok: false,
    code: "credit_too_small",
    detail: `the best credit is ${best}¢ on $${stake.toFixed(2)} staked; the minimum is ${line}¢ (${describeMinimumCredit(rule)})`,
  };
}
