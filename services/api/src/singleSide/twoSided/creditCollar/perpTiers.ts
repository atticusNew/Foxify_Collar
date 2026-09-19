/**
 * The Earn & Protect collar's three shapes and two tenors: one vocabulary for
 * the live demo, the shadow record and the operator report.
 *
 * Every tier is a floor / cap geometry inside the live demo's listed bands
 * (protective wing 2–8% out, funding wing 0.5–4% out). Balanced IS the
 * product as shipped (6% / 1.5%). The tenor is the expiry the collar is
 * written to: the next standard daily (the product today) or the next listed
 * weekly, where the same collar is worth many times more because one-day
 * options a few percent out trade at ticks.
 */

import { nextListedWeeklyExpiryMs, nextStandardDailyExpiryMs, type OkxChainInstrument } from "./execution/okxLivePlanner";

export type PerpTier = "tight" | "balanced" | "wide";
export const PERP_TIERS: readonly PerpTier[] = ["tight", "balanced", "wide"] as const;

export interface CollarGeometry {
  /** protective wing distance from spot (the holder's floor), fraction */
  floorPct: number;
  /** funding wing distance from spot (the holder's cap), fraction */
  capPct: number;
}

export const PERP_TIER_GEOMETRY: Record<PerpTier, CollarGeometry> = {
  tight: { floorPct: 0.03, capPct: 0.01 },
  balanced: { floorPct: 0.06, capPct: 0.015 },
  wide: { floorPct: 0.08, capPct: 0.03 },
};

/** Outcome-named, the way the holder reads them. */
export const PERP_TIER_WORDS: Record<PerpTier, string> = {
  tight: "Safest",
  balanced: "Balanced",
  wide: "Most upside",
};

export const PERP_TIER_RULES: Record<PerpTier, string> = {
  tight: "floor 3% below entry, cap as wide as the book funds from 1%: the most protection the venue will pay for",
  balanced: "floor 6% below, cap from 1.5%: the live product's terms",
  wide: "floor 8% below, cap from 3%: the most upside kept, the deepest floor",
};

export const parsePerpTier = (v: string | null | undefined, fallback: PerpTier = "balanced"): PerpTier =>
  v === "tight" || v === "balanced" || v === "wide" ? v : fallback;

export type EpTenor = "daily" | "weekly";
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
