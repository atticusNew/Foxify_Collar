/**
 * CAPS AS FORMULAS, NOT FIXED NUMBERS (approved decision 4) — one module derives every capacity
 * limit from two measured inputs (sub-account capital, per-wrap margin rate) plus targets, so
 * raising capital raises every cap by changing ONE env var:
 *
 *   usable margin   = capital × (1 − headroom)       headroom (40%) is never lent to new wraps —
 *                                                    it absorbs renewals and breach unwinds
 *   book cap        = usable margin ÷ margin rate    ($10k, 12% ⟹ ~$50k book at launch)
 *   per-WALLET cap  = book cap ÷ target wallets      (not per-wrap: one whale must not sidestep it
 *                                                    with multiple positions); floor of one OKX lot
 *                                                    so small positions always fit
 *   per-strike cap  = ≤30% of book notional short any single strike/expiry (knockout unwinds hit
 *                     the order book, so simultaneous same-strike knockouts are the tail risk)
 *
 * Also here because they are wallet-cohort economics (decisions 3 + 6):
 *   - founding cohort: first N wallets (50) get the founding take rate (10%), locked 12 months;
 *     wallets beyond the cohort queue on the waitlist
 *   - spread take: 20% standard / 10% founding / $0 when the cut would be under $0.05 a cycle
 *   - partial wraps: positions above the per-wallet cap wrap min(position, remaining cap),
 *     rounded DOWN to whole lots — rounding up would over-hedge and create naked exposure
 *
 * NOTE: the margin rate default (12%) is the launch ESTIMATE. Phase 3 measures the real PM margin
 * per wrap and that number recalibrates every cap here.
 */

import { OKX_OPTION_LOT_BTC } from "./demoWrap";

const round2 = (x: number) => +x.toFixed(2);
const num = (v: string | undefined, d: number) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);

export type CapsInputs = {
  /** OKX sub-account capital funding the hedge book (EP_CAPITAL_USDC). */
  subAccountCapitalUsdc: number;
  /** Measured margin consumed per $1 of wrapped notional (EP_MARGIN_RATE; launch estimate 0.12). */
  marginPerWrapRate: number;
  /** Fraction of capital NEVER allocated to new wraps (EP_HEADROOM_PCT; default 0.40). */
  headroomPct: number;
  /** Concurrent-wallet target the book is sized for (EP_TARGET_WALLETS; default 25). */
  targetWallets: number;
  /** Founding cohort size — beyond this, new wallets waitlist (EP_FOUNDING_WALLETS; default 50). */
  foundingWallets: number;
  /** Max share of book notional short one strike/expiry (EP_PER_STRIKE_CAP_PCT; default 0.30). */
  perStrikeCapPct: number;
  /** Lots always allowed on a strike regardless of share — a thin book must not refuse its first wraps (EP_PER_STRIKE_FLOOR_LOTS; default 3). */
  perStrikeFloorLots: number;
  /** Standard spread take (EP_TAKE_RATE; default 0.20). */
  takeRatePct: number;
  /** Founding-cohort take (EP_FOUNDING_TAKE_RATE; default 0.10), locked for foundingLockMs. */
  foundingTakeRatePct: number;
  /** Founding-rate lock duration (default 12 months). */
  foundingLockMs: number;
  /** De minimis: a cycle cut below this is waived to $0 (default $0.05). */
  deMinimisUsdc: number;
};

export const parseCapsInputsFromEnv = (env: Record<string, string | undefined>): CapsInputs => ({
  subAccountCapitalUsdc: num(env.EP_CAPITAL_USDC, 10_000),
  marginPerWrapRate: num(env.EP_MARGIN_RATE, 0.12),
  headroomPct: num(env.EP_HEADROOM_PCT, 0.4),
  targetWallets: num(env.EP_TARGET_WALLETS, 25),
  foundingWallets: num(env.EP_FOUNDING_WALLETS, 50),
  perStrikeCapPct: num(env.EP_PER_STRIKE_CAP_PCT, 0.3),
  perStrikeFloorLots: num(env.EP_PER_STRIKE_FLOOR_LOTS, 3),
  takeRatePct: num(env.EP_TAKE_RATE, 0.2),
  foundingTakeRatePct: num(env.EP_FOUNDING_TAKE_RATE, 0.1),
  foundingLockMs: num(env.EP_FOUNDING_LOCK_MS, 365 * 86_400_000),
  deMinimisUsdc: num(env.EP_DE_MINIMIS_USDC, 0.05)
});

export type DerivedCaps = {
  usableMarginUsdc: number;
  bookCapUsdc: number;
  perWalletCapUsdc: number;
  perStrikeCapPct: number;
  maxWallets: number;
};

/** Derive every cap from the inputs. `spotUsd` sets the one-lot floor under the per-wallet cap. */
export const deriveCaps = (i: CapsInputs, spotUsd: number): DerivedCaps => {
  const usableMarginUsdc = round2(i.subAccountCapitalUsdc * (1 - i.headroomPct));
  const bookCapUsdc = round2(i.marginPerWrapRate > 0 ? usableMarginUsdc / i.marginPerWrapRate : 0);
  const oneLotUsdc = round2(OKX_OPTION_LOT_BTC * Math.max(0, spotUsd));
  const perWalletCapUsdc = round2(Math.max(i.targetWallets > 0 ? bookCapUsdc / i.targetWallets : 0, oneLotUsdc));
  return { usableMarginUsdc, bookCapUsdc, perWalletCapUsdc, perStrikeCapPct: i.perStrikeCapPct, maxWallets: i.foundingWallets };
};

// ── Partial wraps (decision 6: never refuse a position for being too big) ─────

export type PartialWrapSizing =
  | {
      ok: true;
      lots: number;
      coveredBtc: number;
      coveredNotionalUsdc: number;
      /** True when the per-wallet cap (not the position size) bounded the wrap. */
      cappedByWallet: boolean;
      /** Honest partial-coverage line for every surface, or null when fully covered. */
      coverageNote: string | null;
    }
  | { ok: false; reason: string };

/**
 * How many lots may this wallet wrap right now? min(position, remaining per-wallet cap), rounded
 * DOWN to whole lots. Refusals are only for positions below one lot (no listed clip exists) or a
 * wallet whose cap is fully consumed.
 */
export const partialWrapSizing = (
  positionBtc: number,
  positionNotionalUsdc: number,
  perWalletCapUsdc: number,
  walletOpenNotionalUsdc: number,
  spotUsd: number,
  lotBtc = OKX_OPTION_LOT_BTC
): PartialWrapSizing => {
  const posLots = Math.floor(Math.abs(positionBtc) / lotBtc + 1e-12);
  if (posLots < 1) {
    return { ok: false, reason: `wrap refused: this position is ${Math.abs(positionBtc)} BTC; OKX options trade in ${lotBtc} BTC lots (minimum one lot)` };
  }
  const lotUsdc = lotBtc * spotUsd;
  const remainingUsdc = perWalletCapUsdc - walletOpenNotionalUsdc;
  const capLots = Math.floor(remainingUsdc / lotUsdc + 1e-12);
  if (capLots < 1) {
    return { ok: false, reason: `wrap refused: this wallet's protection capacity ($${round2(perWalletCapUsdc)}) is in use — capacity frees at the next cycle conclusion` };
  }
  const lots = Math.min(posLots, capLots);
  const coveredBtc = +(lots * lotBtc).toFixed(8);
  const coveredNotionalUsdc = round2(coveredBtc * spotUsd);
  const cappedByWallet = lots < posLots && capLots < posLots;
  const fullCover = Math.abs(coveredBtc - Math.abs(positionBtc)) < 1e-8;
  const coverageNote = fullCover
    ? null
    : cappedByWallet
      ? `Protected: $${coveredNotionalUsdc.toLocaleString("en-US")} of your $${round2(positionNotionalUsdc).toLocaleString("en-US")} position — coverage limits rise as capacity grows`
      : `protecting ${coveredBtc} of ${Math.abs(positionBtc)} BTC (${lots} × ${lotBtc}); remainder unwrapped`;
  return { ok: true, lots, coveredBtc, coveredNotionalUsdc, cappedByWallet, coverageNote };
};

// ── Per-strike concentration (decision 4, third formula) ─────────────────────

export type StrikeExposure = { capStrike: number; notionalUsdc: number };

export type StrikeConcentration = { ok: true } | { ok: false; reason: string };

/**
 * May a new wrap sell `candidate.notionalUsdc` on `candidate.capStrike`? The strike's share of the
 * post-wrap book must stay ≤ perStrikeCapPct — with a small absolute floor (perStrikeFloorLots) so
 * an empty or thin book does not refuse its first wraps (share of nothing is always 100%).
 */
export const assessStrikeConcentration = (
  openExposures: StrikeExposure[],
  candidate: StrikeExposure,
  perStrikeCapPct: number,
  perStrikeFloorLots: number,
  spotUsd: number,
  lotBtc = OKX_OPTION_LOT_BTC
): StrikeConcentration => {
  const strikeNotional = openExposures.filter((e) => e.capStrike === candidate.capStrike).reduce((s, e) => s + e.notionalUsdc, 0) + candidate.notionalUsdc;
  const bookNotional = openExposures.reduce((s, e) => s + e.notionalUsdc, 0) + candidate.notionalUsdc;
  const floorUsdc = perStrikeFloorLots * lotBtc * spotUsd;
  if (strikeNotional <= floorUsdc + 1e-9) return { ok: true };
  if (strikeNotional <= perStrikeCapPct * bookNotional + 1e-9) return { ok: true };
  return {
    ok: false,
    reason:
      `wrap refused: cap strike $${candidate.capStrike} already carries $${round2(strikeNotional - candidate.notionalUsdc)} of the book` +
      ` (limit ${(perStrikeCapPct * 100).toFixed(0)}% of $${round2(bookNotional)}) — a knockout there must stay unwindable on the screen; try again shortly`
  };
};

// ── Founding cohort + waitlist (decisions 3 + 4) ──────────────────────────────

export type WalletRegistry = Record<string, { joinedAtMs: number }>; // key = account, lowercase

export type CohortDecision =
  | { ok: true; founding: boolean; joinedAtMs: number | null }
  | { ok: false; reason: string };

/**
 * May this wallet wrap, cohort-wise? Known wallets always may (their cohort slot is theirs).
 * Unknown wallets join while the cohort has room; beyond that they waitlist with honest copy.
 * Pure — registration itself happens on the first SUCCESSFUL wrap (see registerWallet).
 */
export const assessCohort = (registry: WalletRegistry, account: string, maxWallets: number): CohortDecision => {
  const key = account.toLowerCase();
  const existing = registry[key];
  if (existing) return { ok: true, founding: true, joinedAtMs: existing.joinedAtMs };
  const size = Object.keys(registry).length;
  if (size >= maxWallets) {
    return { ok: false, reason: `wrap refused: the founding cohort (${maxWallets} wallets) is full — you're on the waitlist; capacity grows with capital` };
  }
  return { ok: true, founding: false, joinedAtMs: null };
};

/** Idempotently claim a cohort slot on the wallet's first successful wrap. Mutates the registry. */
export const registerWallet = (registry: WalletRegistry, account: string, nowMs: number): void => {
  const key = account.toLowerCase();
  if (!registry[key]) registry[key] = { joinedAtMs: nowMs };
};

// ── Spread take (decision 3: 20% / 10% founding / $0 de minimis) ──────────────

export type TakeResult = {
  /** What the trader is quoted and paid. */
  traderCreditUsdc: number;
  /** Atticus's cut this cycle ($0 under the de minimis line). */
  atticusTakeUsdc: number;
  /** The rate actually applied (0 when waived). */
  appliedRatePct: number;
  founding: boolean;
};

/** The rate this wallet earned: founding rate while the 12-month lock runs, standard after. */
export const takeRateFor = (i: CapsInputs, foundingJoinedAtMs: number | null, nowMs: number): { ratePct: number; founding: boolean } =>
  foundingJoinedAtMs != null && nowMs < foundingJoinedAtMs + i.foundingLockMs
    ? { ratePct: i.foundingTakeRatePct, founding: true }
    : { ratePct: i.takeRatePct, founding: false };

/**
 * Split a gross cycle credit between the trader and Atticus. The take is the spread between the
 * executable credit and the quoted credit — published honestly ("we keep X% of the credit we
 * source"). A cut under the de minimis line is waived entirely.
 */
export const applyTake = (grossCreditUsdc: number, ratePct: number, deMinimisUsdc: number, founding = false): TakeResult => {
  const gross = Math.max(0, grossCreditUsdc);
  let take = +(gross * Math.max(0, ratePct)).toFixed(2);
  let applied = ratePct;
  if (take < deMinimisUsdc) {
    take = 0;
    applied = 0;
  }
  return { traderCreditUsdc: round2(gross - take), atticusTakeUsdc: take, appliedRatePct: applied, founding };
};
