/**
 * ONE SCALE FOR EVERY SHAPE: the share of the position sold.
 *
 * The two shapes a holder can be shown name their three tiers the same way (Max upside,
 * Balanced, Max floor) and mean different amounts by them. A member's own sale sells 40, 60 or
 * 80 percent of the position (crossVenue/memberSale.SALE_SHARE_PERCENT). A hedged lock sells nothing of the
 * holder's; it is hedged with as many contracts of the other side as (floor + 100 - cap) per 100
 * held, which is the sale it is equal to: the holder's two results differ by the same sum under
 * either (crossVenue/shadowSaleAlternatives.ts, "HOW MUCH IS SOLD"). Its default tier comes to about 15.
 *
 * So every tier on every surface carries one number, `sharePercent`, and one sentence:
 *
 *   own sale      "sells 40% of your position"
 *   hedged lock   "like selling 15% of your position"
 *
 * It sits beside retailShowcase.ts, outside crossVenue/, because every event service that
 * serves a retail quote imports it (the deploy filters test holds each service to its paths).
 *
 * This file is the only place the number is worked out. It changes no price: the tiers, their
 * floors, caps and credits are what they were. A whole percent, rounded to the nearest.
 */

const clampPercent = (n: number): number => Math.min(100, Math.max(0, Math.round(n)));

/** A hedged lock's tier: floor and cap in cents per contract. The sale it is equal to, percent of the position. */
export function collarSharePercent(floorCents: number, capCents: number): number | null {
  if (!Number.isFinite(floorCents) || !Number.isFinite(capCents)) return null;
  return clampPercent(floorCents + 100 - capCents);
}

/** A member's own sale: contracts sold of contracts held. Percent of the position, as it fills (a thin book sells less than the tier asks). */
export function saleSharePercent(soldContracts: number, heldContracts: number): number | null {
  if (!Number.isFinite(soldContracts) || !Number.isFinite(heldContracts) || heldContracts <= 0 || soldContracts < 0) return null;
  // a part sold never reads as nothing sold, and a part kept never reads as everything sold
  if (soldContracts === 0) return 0;
  if (soldContracts >= heldContracts) return 100;
  return Math.min(99, Math.max(1, clampPercent((100 * soldContracts) / heldContracts)));
}

/** The sentence beside a tier. The pages carry the same two sentences in their own script; the tests hold them to these. */
export const SHARE_WORDS = {
  sale: (percent: number): string => `sells ${percent}% of your position`,
  lock: (percent: number): string => `like selling ${percent}% of your position`,
} as const;
