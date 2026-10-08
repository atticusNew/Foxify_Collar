/**
 * The Earn & Protect collar's tenor: one vocabulary for the live demo, the
 * shadow record and the operator report.
 *
 * The collar has ONE shape (a useful hard floor ~6% out; the funding wing is
 * the widest listed strike that still pays, so the cap sits as far from price
 * as the book allows). It is a knock-out collar: a cap touch ends the cycle,
 * both legs unwind and protection re-arms; the trader never gives up upside.
 * So there are no tiers here, only the expiry the collar is written to. The
 * WEEKLY is the default: the same collar is worth many times more there
 * because one-day options a few percent out trade at ticks (measured live:
 * $0.15 vs $2.71 on 0.03 BTC, same floor, a wider cap), and one hedge
 * round-trip a week instead of seven. EP_TENOR=daily opts back into the
 * daily.
 */

import {
  nextListedMonthlyExpiryMs,
  nextListedTwoWeeklyExpiryMs,
  nextListedWeeklyExpiryMs,
  nextStandardDailyExpiryMs,
  type OkxChainInstrument,
} from "./execution/okxLivePlanner";

export interface CollarGeometry {
  /** protective wing distance from spot (the holder's floor), fraction */
  floorPct: number;
  /** funding wing pin (the cap search starts here and walks WIDER while the book pays), fraction */
  capPct: number;
}

export type EpTenor = "daily" | "weekly";
export const EP_TENORS: readonly EpTenor[] = ["daily", "weekly"] as const;
/** `daily` opts out; anything else (unset, junk) is the weekly default. */
export const parseTenor = (v: string | null | undefined): EpTenor => (v === "daily" ? "daily" : "weekly");
export const otherTenor = (t: EpTenor): EpTenor => (t === "weekly" ? "daily" : "weekly");

/**
 * The expiry a tenor writes to, from the live chain. Daily is the planner's
 * default (08:00 UTC, ≥ 12h out). Weekly is the nearest listed Friday 08:00 UTC
 * at least 3 days out (so a cycle runs 3–10 days, never a Friday two days off
 * that prices like a daily); when none is listed the daily is used and the
 * caller can see that from the returned `tenor`.
 */
export const tenorExpiry = (tenor: EpTenor, chain: OkxChainInstrument[], nowMs: number): { expiryMs: number; tenor: EpTenor } => {
  if (tenor === "weekly") {
    const weekly = nextListedWeeklyExpiryMs(chain, nowMs);
    if (weekly != null) return { expiryMs: weekly, tenor: "weekly" };
  }
  return { expiryMs: nextStandardDailyExpiryMs(nowMs), tenor: "daily" };
};

export const tenorWord = (tenor: EpTenor): string => (tenor === "weekly" ? "this week's" : "today's");

/** A brand's tenor band: the cycle runs to the nearest listed Friday at least `minDays` and at most `maxDays` out (epBranding.ts). */
export type TenorBand = { minDays: number; maxDays: number };

/**
 * The nearest LISTED Friday 08:00 UTC expiry inside the band, or null when none sits there. Pure.
 * The default band (3–14) is the live weekly rule: the nearest Friday at least 3 days out is
 * always under 10 days off, so a brand that does not dial the band gets today's product.
 */
export const listedWeeklyExpiryInBand = (chain: OkxChainInstrument[], nowMs: number, band: TenorBand): number | null => {
  const lo = Math.max(0, band.minDays) * 86_400_000;
  const hi = Math.max(band.minDays, band.maxDays) * 86_400_000;
  const listed = [...new Set(chain.filter((c) => c.state === "live").map((c) => c.expiryMs))].sort((a, b) => a - b);
  for (const e of listed) {
    const d = new Date(e);
    const off = e - nowMs;
    if (d.getUTCDay() === 5 && d.getUTCHours() === 8 && off >= lo && off <= hi) return e;
  }
  return null;
};

/**
 * Longer tenors the shadow MEASURES and the product does not write (2026-10-08): the same
 * collar re-quoted at the two-weekly (the listed Friday after the weekly's, 10–17 days) and the
 * monthly (the last Friday of a month, 21–52 days), from the same snapshot. The floor stays at
 * the live depth; the cap search may reach further out, because the same 20% market odds of
 * finishing past the cap sit at a wider strike when there is more time — a band as narrow as
 * the weekly's would force the cap in and understate what a longer cycle pays. Quoted terms
 * only: a longer cycle settles on a different print, so nothing here is settled. The rows exist
 * so the tenor band (3–14 days) is set by a number, not an argument.
 */
export type AltTenor = "two_weekly" | "monthly";
export const ALT_TENORS: ReadonlyArray<{ label: AltTenor; maxCapPct: number; words: string }> = [
  { label: "two_weekly", maxCapPct: 0.1, words: "two-weekly" },
  { label: "monthly", maxCapPct: 0.15, words: "monthly" },
];
export const altTenorWords = (label: string): string => ALT_TENORS.find((t) => t.label === label)?.words ?? label.replace(/_/g, "-");
/** The widest the snapshot's band and the cap search reach for any tenor the shadow prices. */
export const ALT_TENOR_MAX_OTM_PCT = Math.max(...ALT_TENORS.map((t) => t.maxCapPct));

/** The expiry each measured tenor would write to, from the live chain; absent when none is listed. Pure. */
export const altTenorExpiries = (chain: OkxChainInstrument[], nowMs: number): Partial<Record<AltTenor, number>> => {
  const out: Partial<Record<AltTenor, number>> = {};
  const twoWeekly = nextListedTwoWeeklyExpiryMs(chain, nowMs);
  if (twoWeekly != null) out.two_weekly = twoWeekly;
  const monthly = nextListedMonthlyExpiryMs(chain, nowMs);
  if (monthly != null && monthly !== twoWeekly) out.monthly = monthly;
  return out;
};

/**
 * Cap-distance guard. The cap search always takes the WIDEST listed strike that still pays;
 * `maxCapPct` is how far out it may look. `minCapPct` refuses a quote whose widest paying
 * strike sits closer than this — a KNOCKOUT rule: there a close cap means frequent, expensive
 * buy-backs. Under the plain collar a touch closes nothing and costs nothing, so the distance
 * is information on the card (the cap %), not a reason to refuse: minCapPct defaults to 0 and
 * only the funding band's 0.5% ATM hard stop applies. A hard threshold is also finer than the
 * listed strike grid ($500 ≈ 0.6% at $80k), so a fixed line refuses one whole side of the book
 * whenever the widest bid lands a few bps inside it — measured 2026-09-20: every short refused
 * at 3.93% against a 4.0% line while the same book paid $64.91 on $100k. Env still raises it
 * deliberately (EP_MIN_CAP_PCT / EP_MIN_CAP_PCT_WEEKLY, fractions); knockout keeps 2% / 4%.
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

export const capGuardFor = (
  tenor: EpTenor,
  env: Record<string, string | undefined> = process.env,
  capMode: "plain" | "knockout" = "plain"
): CapGuard => {
  const refuseUnder = capMode === "knockout";
  return tenor === "weekly"
    ? { minCapPct: numEnv(env.EP_MIN_CAP_PCT_WEEKLY, refuseUnder ? 0.04 : 0), maxCapPct: numEnv(env.EP_CAP_MAX_PCT_WEEKLY, 0.08) }
    : { minCapPct: numEnv(env.EP_MIN_CAP_PCT, refuseUnder ? 0.02 : 0), maxCapPct: numEnv(env.EP_CAP_MAX_PCT, 0.04) };
};
