/**
 * State machine validator for two-sided pair lifecycle.
 *
 * Transitions (per types.ts header diagram):
 *   pending  →  active            (both legs filled)
 *   pending  →  cancelled         (activation failed: rollback)
 *   active   →  triggered         (trigger fires)
 *   active   →  unwinding         (Foxify early close OR expiry-4h)
 *   triggered → unwinding         (theta-aware TP fires)
 *   unwinding → settled           (terminal — all closed)
 *
 * cancelled and settled are terminal. No transitions out of either.
 *
 * Throws on illegal transitions so callers get a clear failure mode in tests
 * and production rather than silent corruption.
 */

import type { PairStatus } from "./types";

const TRANSITIONS: Record<PairStatus, ReadonlySet<PairStatus>> = {
  pending: new Set<PairStatus>(["active", "cancelled"]),
  active: new Set<PairStatus>(["triggered", "unwinding"]),
  triggered: new Set<PairStatus>(["unwinding"]),
  unwinding: new Set<PairStatus>(["settled"]),
  settled: new Set<PairStatus>(),
  cancelled: new Set<PairStatus>()
};

export class IllegalStateTransitionError extends Error {
  constructor(public readonly from: PairStatus, public readonly to: PairStatus) {
    super(`Illegal pair status transition: ${from} → ${to}`);
    this.name = "IllegalStateTransitionError";
  }
}

export const isValidTransition = (from: PairStatus, to: PairStatus): boolean =>
  TRANSITIONS[from].has(to);

export const assertValidTransition = (from: PairStatus, to: PairStatus): void => {
  if (!isValidTransition(from, to)) {
    throw new IllegalStateTransitionError(from, to);
  }
};

export const isTerminal = (status: PairStatus): boolean => status === "settled" || status === "cancelled";

export const validNextStates = (from: PairStatus): ReadonlySet<PairStatus> => TRANSITIONS[from];
