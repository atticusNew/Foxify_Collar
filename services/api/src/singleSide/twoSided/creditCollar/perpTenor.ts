/**
 * The Earn & Protect collar's tenor: one vocabulary for the live demo, the
 * shadow record and the operator report.
 *
 * The collar has ONE shape (a useful hard floor ~6% out; the funding wing is
 * the widest listed strike that still pays, so the cap sits as far from price
 * as the book allows). It is a knock-out collar: a cap touch ends the cycle,
 * both legs unwind and protection re-arms; the trader never gives up upside.
 * So there are no tiers here, only the expiry the collar is written to: the
 * next standard daily (the product today) or the next listed weekly, where
 * the same collar is worth many times more because one-day options a few
 * percent out trade at ticks.
 */

import { nextListedWeeklyExpiryMs, nextStandardDailyExpiryMs, type OkxChainInstrument } from "./execution/okxLivePlanner";

export interface CollarGeometry {
  /** protective wing distance from spot (the holder's floor), fraction */
  floorPct: number;
  /** funding wing pin (the cap search starts here and walks WIDER while the book pays), fraction */
  capPct: number;
}

export type EpTenor = "daily" | "weekly";
export const EP_TENORS: readonly EpTenor[] = ["daily", "weekly"] as const;
export const parseTenor = (v: string | null | undefined): EpTenor => (v === "weekly" ? "weekly" : "daily");

/**
 * The expiry a tenor writes to, from the live chain. Daily is the planner's
 * default (08:00 UTC, ≥ 12h out). Weekly is the first listed Friday 08:00 UTC
 * at least 5 days out; when none is listed the daily is used and the caller
 * can see that from the returned `tenor`.
 */
export const tenorExpiry = (tenor: EpTenor, chain: OkxChainInstrument[], nowMs: number): { expiryMs: number; tenor: EpTenor } => {
  if (tenor === "weekly") {
    const weekly = nextListedWeeklyExpiryMs(chain, nowMs);
    if (weekly != null) return { expiryMs: weekly, tenor: "weekly" };
  }
  return { expiryMs: nextStandardDailyExpiryMs(nowMs), tenor: "daily" };
};

export const tenorWord = (tenor: EpTenor): string => (tenor === "weekly" ? "this week's" : "today's");

/**
 * Cap-distance guard: the funding wing must sit at least this far from price,
 * else the quote is refused rather than written with a cap that will cross on
 * noise. Defaults 2% daily / 4% weekly (EP_MIN_CAP_PCT / EP_MIN_CAP_PCT_WEEKLY,
 * as fractions). The widest-that-pays rule usually lands well beyond these;
 * the guard is for the dead book at 03:00 where nothing wider has a bid.
 */
export interface CapGuard {
  minCapPct: number;
  /** the widest strike the cap search may reach (the funding band's outer edge) */
  maxCapPct: number;
}

const numEnv = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

export const capGuardFor = (tenor: EpTenor, env: Record<string, string | undefined> = process.env): CapGuard =>
  tenor === "weekly"
    ? { minCapPct: numEnv(env.EP_MIN_CAP_PCT_WEEKLY, 0.04), maxCapPct: numEnv(env.EP_CAP_MAX_PCT_WEEKLY, 0.08) }
    : { minCapPct: numEnv(env.EP_MIN_CAP_PCT, 0.02), maxCapPct: numEnv(env.EP_CAP_MAX_PCT, 0.04) };
