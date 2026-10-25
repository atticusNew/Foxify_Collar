/**
 * FAR-OUT GUARD — no cross-venue route on a game nobody has a real book for yet.
 *
 * Days before tip, a game's books are placeholders: the market's own No side is empty or too
 * wide to fund a credit, the aggregator's feed has nothing for it, and the second venue shows a
 * resting ask that no one would fill at size. Priced off that ask, the cross-venue route writes a
 * credit of $6 to $17 at an EV cost of -3% to -23%, which is a hedge that would never fill, not a
 * cheap one. The record's identity still holds on paper; a live holder's hedge would not.
 *
 * The rule: a sports quote whose cheaper route is the second venue, with the game more than
 * `hours` away, is deferred when the market's own No side could not fund the default tier AND the
 * feed supplied no book for the second venue. Deferred is a refusal with its own code, so the
 * board does not carry the row and the scan does not open it; the next scan prices it again, and
 * it opens the moment a real book appears or the window is reached. Nothing is lost: the game is
 * still on the record once inside the window, where a hedge could actually be placed.
 *
 * Pure: takes what the quote already knows, returns a verdict.
 */

import type { HedgeRoute } from "./types";

export interface FarOutGuardRule {
  /** games further away than this are held to the rule; 0 disables the rule */
  hours: number;
}

export const DEFAULT_FAR_OUT_GUARD: FarOutGuardRule = { hours: 24 };

export function farOutGuardFromEnv(env: NodeJS.ProcessEnv): FarOutGuardRule {
  const raw = env.EVENT_X_FAR_OUT_HOURS;
  const n = Number(raw);
  const hours = raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= 24 * 14 ? n : DEFAULT_FAR_OUT_GUARD.hours;
  return { hours };
}

export interface FarOutGuardInputs {
  kind: "sports" | "crypto";
  /** the route the quote chose; null when every route refused */
  route: HedgeRoute | null;
  eventTimeIso: string;
  nowMs: number;
  /** the market's own No side funded the default tier at this size */
  kalshiRouteOk: boolean;
  /** the aggregator's feed supplied the second venue's book (a direct read did not) */
  feedSuppliedPmBook: boolean;
}

export type FarOutVerdict =
  | { defer: false }
  | {
      defer: true;
      code: "far_out_no_book";
      detail: string;
      hoursToStart: number;
    };

export function farOutVerdict(inputs: FarOutGuardInputs, rule: FarOutGuardRule = DEFAULT_FAR_OUT_GUARD): FarOutVerdict {
  if (rule.hours <= 0 || inputs.kind !== "sports" || inputs.route !== "polymarket") return { defer: false };
  const eventMs = Date.parse(inputs.eventTimeIso);
  if (!Number.isFinite(eventMs)) return { defer: false };
  const hoursToStart = (eventMs - inputs.nowMs) / 3_600_000;
  if (hoursToStart <= rule.hours) return { defer: false };
  if (inputs.kalshiRouteOk || inputs.feedSuppliedPmBook) return { defer: false };
  const rounded = Math.round(hoursToStart * 10) / 10;
  return {
    defer: true,
    code: "far_out_no_book",
    hoursToStart: rounded,
    detail: `${rounded}h to start and no venue has a real book yet: the market's own No side could not fund it and the feed had none; the cross-venue route opens inside ${rule.hours}h`,
  };
}
