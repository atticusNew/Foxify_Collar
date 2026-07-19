/**
 * Lock-line watcher policy — Phase A (pure, offline). Decides whether an EARLY UNWIND ("lock") of a
 * collar position at a barrier touch is permitted, under the product rule the pilot presents to the
 * partner: the credit vests linearly over the tenor (simple, Foxify-facing) and a lock may only
 * execute when unwinding the legs AT MARKET costs no more than the credit that has NOT yet vested —
 * so the vesting schedule is never underwater and Atticus never pays out unearned credit.
 *
 * Reality check encoded here (not hidden): a CAP-side touch puts our SHORT leg exactly at-the-money,
 * where time value peaks; that buyback decays ~√(time left) while unvested credit decays linearly, so
 * the strict rule rarely permits cap-side locks — those ride to expiry (safe: the floor legs are live
 * the whole time). FLOOR-side touches put the leg we OWN at-the-money, so unwinding is cash-positive
 * and locks permit readily. `payoutToFoxifyIfLockedUsdc` additionally caps any lock payout at
 * min(vested schedule, credits − market cost), so even a manual override can't pay unearned credit.
 */

import { bsPut, bsCall } from "../../../pilot/blackScholes";
import type { OpenPosition } from "./forwardSettlement";
import type { BarrierSide } from "./barrierLifecycle";

const YEAR_MS = 365.25 * 24 * 3600 * 1000;
const round2 = (x: number) => +x.toFixed(2);

export type LockPolicyConfig = {
  /** Full position tenor (vesting denominator). */
  tenorMs: number;
  /** Safety margin on top of the unvested-credit bound, USDC. Default 0 (rule is exact). */
  bufferUsdc?: number;
  /** Half-spread paid/received on each leg unwind, as a fraction of the leg's model value. Default 0.05. */
  spreadRelPct?: number;
  /** Absolute half-spread floor per leg, USDC. Default 1. */
  minLegSpreadUsdc?: number;
  riskFreeRate?: number;
};

export type LockDecision = {
  ref: string;
  barrier: Exclude<BarrierSide, "none">;
  /** Credit earned so far under the linear schedule (what Foxify keeps on a permitted lock). */
  vestedCreditUsdc: number;
  /** Credit not yet earned — the budget the unwind must fit inside. */
  unvestedCreditUsdc: number;
  /** Market cost to unwind the legs NOW: buy back the short leg (+spread), sell the long leg (−spread). Negative = net recovery. */
  unwindCostUsdc: number;
  /** The user-facing rule: unwindCost ≤ unvested − buffer. */
  permitted: boolean;
  /** unvested − buffer − unwindCost (how much room the rule has; negative = how far underwater a lock would be). */
  headroomUsdc: number;
  /** Total lock economics if executed now: full credit − unwind cost (pair/position net of an early close). */
  netIfLockedUsdc: number;
  /** Never-underwater payout: min(vested schedule, credit − unwind cost), floored at 0. */
  payoutToFoxifyIfLockedUsdc: number;
  /** Estimated ms until the rule would permit (spot pinned at the barrier), or null if it never does before expiry. */
  lockEtaMs: number | null;
};

type IvForStrike = (strike: number, optType: "put" | "call") => number;

/** Model value of both collar legs at a given spot/time-left, split into the leg we're SHORT vs LONG. */
const legValues = (
  pos: Pick<OpenPosition, "side" | "putStrike" | "callStrike" | "notionalUsdc" | "spotAtEntry">,
  spotUsd: number,
  timeLeftMs: number,
  iv: IvForStrike,
  r: number
): { shortLegUsdc: number; longLegUsdc: number } => {
  const contractsBtc = pos.notionalUsdc / pos.spotAtEntry;
  const T = Math.max(0, timeLeftMs) / YEAR_MS;
  const callVal = bsCall(spotUsd, pos.callStrike, T, r, iv(pos.callStrike, "call")) * contractsBtc;
  const putVal = bsPut(spotUsd, pos.putStrike, T, r, iv(pos.putStrike, "put")) * contractsBtc;
  // Long-perp collar: SHORT the call (cap), LONG the put (floor). Short-perp: mirror.
  return pos.side === "long" ? { shortLegUsdc: callVal, longLegUsdc: putVal } : { shortLegUsdc: putVal, longLegUsdc: callVal };
};

/** Market unwind cost: buy back the short leg (pay value + spread), sell the long leg (receive value − spread). */
const unwindCostAt = (
  pos: Pick<OpenPosition, "side" | "putStrike" | "callStrike" | "notionalUsdc" | "spotAtEntry">,
  spotUsd: number,
  timeLeftMs: number,
  iv: IvForStrike,
  cfg: Required<Pick<LockPolicyConfig, "spreadRelPct" | "minLegSpreadUsdc" | "riskFreeRate">>
): number => {
  const { shortLegUsdc, longLegUsdc } = legValues(pos, spotUsd, timeLeftMs, iv, cfg.riskFreeRate);
  const spread = (v: number) => Math.max(cfg.minLegSpreadUsdc, cfg.spreadRelPct * v);
  const payToClose = shortLegUsdc + spread(shortLegUsdc);
  const recoverFromSale = Math.max(0, longLegUsdc - spread(longLegUsdc));
  return payToClose - recoverFromSale;
};

/**
 * Assess a lock at a confirmed barrier touch. Pure: spot, time and vol injected. The ETA scan pins
 * spot at the touched barrier (the lock scenario) and walks forward in 5-minute steps to find when
 * the √t-decaying unwind cost first fits inside the linearly-shrinking unvested credit.
 */
export const assessLock = (
  pos: Pick<OpenPosition, "ref" | "side" | "putStrike" | "callStrike" | "notionalUsdc" | "spotAtEntry" | "foxifyCreditUsdc" | "openedAtMs" | "expiresAtMs">,
  barrier: Exclude<BarrierSide, "none">,
  spotUsd: number,
  nowMs: number,
  iv: IvForStrike,
  cfg: LockPolicyConfig
): LockDecision => {
  const buffer = cfg.bufferUsdc ?? 0;
  const costCfg = { spreadRelPct: cfg.spreadRelPct ?? 0.05, minLegSpreadUsdc: cfg.minLegSpreadUsdc ?? 1, riskFreeRate: cfg.riskFreeRate ?? 0 };
  const full = Math.max(0, pos.foxifyCreditUsdc);
  const tenor = Math.max(1, cfg.tenorMs);

  const vestedAt = (t: number) => full * Math.max(0, Math.min(1, (t - pos.openedAtMs) / tenor));
  const vested = vestedAt(nowMs);
  const unvested = full - vested;

  const cost = unwindCostAt(pos, spotUsd, pos.expiresAtMs - nowMs, iv, costCfg);
  const permitted = cost <= unvested - buffer;
  const netIfLocked = full - cost;

  // ETA: earliest future time the rule permits, spot pinned at the barrier price.
  const barrierPrice = barrier === "floor" ? pos.putStrike : pos.callStrike;
  let lockEtaMs: number | null = permitted ? 0 : null;
  if (!permitted) {
    const stepMs = 5 * 60_000;
    for (let t = nowMs + stepMs; t < pos.expiresAtMs; t += stepMs) {
      const c = unwindCostAt(pos, barrierPrice, pos.expiresAtMs - t, iv, costCfg);
      if (c <= full - vestedAt(t) - buffer) {
        lockEtaMs = t - nowMs;
        break;
      }
    }
  }

  return {
    ref: pos.ref,
    barrier,
    vestedCreditUsdc: round2(vested),
    unvestedCreditUsdc: round2(unvested),
    unwindCostUsdc: round2(cost),
    permitted,
    headroomUsdc: round2(unvested - buffer - cost),
    netIfLockedUsdc: round2(netIfLocked),
    payoutToFoxifyIfLockedUsdc: round2(Math.max(0, Math.min(vested, netIfLocked))),
    lockEtaMs
  };
};

/** Cycle-level watcher summary for the shadow report / dashboard. */
export type LockWatcherReport = {
  touchesEvaluated: number;
  locksPermitted: number;
  locksDeferred: number;
  decisions: LockDecision[];
};
