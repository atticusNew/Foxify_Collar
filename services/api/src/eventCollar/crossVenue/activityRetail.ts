/**
 * ACTIVITY, RETAIL SHAPE — the record's finished positions as a bettor's app lists them.
 *
 * Every real positions app has an Activity tab: what finished, and how. The demo's used to
 * answer with a toast. This module turns the public record's settled and closed positions
 * (the shadow's /api/shadow body, or the positions themselves) into that tab: one row per
 * finished position, most recent first, saying what it ended at with the lock and what it
 * would have ended at without, and what was paid at open.
 *
 * Phone copy is outcomes, never mechanics: no hedge, no take, no route, no counterfactual
 * rule books. The shadow's full objects carry all of those; only the fields named here cross
 * over, and the retail tripwire (RETAIL_FORBIDDEN_KEYS) is run over the result in tests.
 * Money is integer cents. Nothing here prices or settles anything.
 */

import { capTotalCents, floorTotalCents } from "./types";

export type ActivityState = "settled" | "closed";
export type ActivityOutcome = "won" | "lost" | "closed";

export interface ActivityRow {
  /** the venue's key for the position (the same id the Positions tab uses) */
  id: string;
  kind: "sports" | "crypto";
  league: string;
  /** the side the position was on, "Eagles" */
  name: string;
  /** the matchup or strike, "Eagles vs. Jaguars" */
  game: string;
  startsIso: string;
  state: ActivityState;
  /** settled: the venue's result for the side; closed: the user left before the result */
  outcome: ActivityOutcome;
  /** when it finished: settlement time, or the early close */
  atIso: string;
  contracts: number;
  /** total with the lock: floor or cap times contracts plus the credit; closed: what the user left with */
  endedCents: number;
  /** the same position with no lock ever bought */
  withoutCents: number;
  /** paid at open, already inside endedCents */
  creditCents: number;
  /** the two endings the lock set at open */
  floorTotalCents: number;
  capTotalCents: number;
}

export interface ActivityPayload {
  rows: ActivityRow[];
  /** finished positions on the record, before the row cap */
  settledCount: number;
  closedCount: number;
}

/** The fields this module reads off a record position; the shadow's objects carry many more. */
export interface ActivitySource {
  ticker: string;
  kind: string;
  league: string;
  sideName: string;
  eventTitle: string;
  eventTimeIso: string;
  contracts: number;
  floorCents: number;
  capCents: number;
  creditCents: number;
  status: string;
  result?: "yes" | "no";
  settledAt?: string;
  closedAt?: string;
  protectedCents?: number;
  nakedCents?: number;
}

export const ACTIVITY_ROW_CAP = 60;

const isFinite_ = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** One record position to one row; null when it has not finished or its totals are missing. */
export function activityRow(p: ActivitySource): ActivityRow | null {
  if (p.status !== "settled" && p.status !== "closed") return null;
  if (!isFinite_(p.protectedCents) || !isFinite_(p.nakedCents)) return null;
  const atIso = p.status === "settled" ? p.settledAt : p.closedAt;
  if (!atIso) return null;
  if (p.status === "settled" && p.result !== "yes" && p.result !== "no") return null;
  return {
    id: p.ticker,
    kind: p.kind === "crypto" ? "crypto" : "sports",
    league: p.league,
    name: p.sideName,
    game: p.eventTitle,
    startsIso: p.eventTimeIso,
    state: p.status,
    outcome: p.status === "closed" ? "closed" : p.result === "yes" ? "won" : "lost",
    atIso,
    contracts: p.contracts,
    endedCents: p.protectedCents,
    withoutCents: p.nakedCents,
    creditCents: p.creditCents,
    floorTotalCents: floorTotalCents(p),
    capTotalCents: capTotalCents(p),
  };
}

/** The finished positions, most recent first, capped. Pure. */
export function retailActivity(positions: ReadonlyArray<ActivitySource>, cap: number = ACTIVITY_ROW_CAP): ActivityPayload {
  const rows: ActivityRow[] = [];
  let settledCount = 0;
  let closedCount = 0;
  for (const p of positions) {
    const row = activityRow(p);
    if (!row) continue;
    if (row.state === "settled") settledCount += 1;
    else closedCount += 1;
    rows.push(row);
  }
  rows.sort((a, b) => b.atIso.localeCompare(a.atIso) || a.id.localeCompare(b.id));
  return { rows: rows.slice(0, Math.max(0, cap)), settledCount, closedCount };
}

/**
 * The shadow's public /api/shadow body carries `settled`, `open` and `closed` lists of full
 * positions; the activity feed wants the first and the last. Tolerant of a body that lacks
 * either (an older shadow, or a fresh one with nothing finished).
 */
export function activityFromShadowBody(body: unknown, cap: number = ACTIVITY_ROW_CAP): ActivityPayload {
  const b = (body ?? {}) as { settled?: unknown; closed?: unknown };
  const list = (v: unknown): ActivitySource[] => (Array.isArray(v) ? (v as ActivitySource[]) : []);
  return retailActivity([...list(b.settled), ...list(b.closed)], cap);
}
