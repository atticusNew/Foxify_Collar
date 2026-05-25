/**
 * Newborn-trigger review (PR-D, 2026-05-24).
 *
 * Goal: after a fresh deploy, the operator must manually inspect the
 * outcome of the FIRST few triggers before the system continues taking
 * new activations. This catches regressions in trigger-close ordering,
 * spread liquidity, slippage floors, etc. that pre-deploy unit tests
 * might miss but that show up under live venue/market conditions.
 *
 * Behavior:
 *   - Each time `fireTrigger` completes successfully, call
 *     `recordTriggerForReview`. If review is enabled AND the review
 *     budget is not yet exhausted, the function calls
 *     `setManualHalt({halted:true})` on the global guardrails halt and
 *     logs a structured `[VC NEWBORN]` line so the operator can find
 *     it in Render logs.
 *   - The operator reviews the trigger outcome (closed shorts, sold
 *     longs, ledger entries, salvage record) and clears the halt via
 *     `POST /volume-cover/admin/halt/clear` once satisfied.
 *   - After `budget` triggers have been auto-halted-and-cleared, the
 *     system "graduates" — no more auto-halts. Counter is in-memory so
 *     a process restart resets the budget (intentionally conservative).
 *
 * Env knobs:
 *   - VC_NEWBORN_TRIGGER_REVIEW=true|false   (default false; opt-in)
 *   - VC_NEWBORN_REVIEW_BUDGET=N             (default 3 triggers)
 *
 * Coupling:
 *   - Uses the existing manual-halt guardrails as the auto-halt
 *     mechanism. This means /admin/halt/clear is the correct clear
 *     endpoint — operators don't need to learn a new one.
 *   - Independent of the cumulative-loss kill-switch (Guard A) and the
 *     daily trigger-surge pause (Guard C) — those have their own
 *     thresholds and clearing semantics.
 */

import { setManualHalt, getManualHalt } from "./volumeCoverGuardrails";

let triggerCount = 0;

const isReviewEnabled = (): boolean => {
  const raw = process.env.VC_NEWBORN_TRIGGER_REVIEW;
  if (raw === undefined || raw === null || raw === "") return false; // default OFF
  return String(raw).trim().toLowerCase() === "true";
};

const getReviewBudget = (): number => {
  const raw = process.env.VC_NEWBORN_REVIEW_BUDGET;
  if (raw === undefined || raw === null || raw === "") return 3;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return 3;
  return n;
};

export type NewbornReviewState = {
  enabled: boolean;
  budget: number;
  triggersSoFar: number;
  graduated: boolean;
  // True if the LAST recorded trigger triggered the auto-halt path.
  lastTriggerAutoHalted: boolean;
};

let lastTriggerAutoHalted = false;

/**
 * Called by `fireTrigger` after the trigger lifecycle has completed
 * successfully. Increments the in-memory counter and, if newborn review
 * is enabled and the budget is not exhausted, sets the global manual
 * halt.
 *
 * Returns a snapshot of the resulting review state for callers that
 * want to log or surface it.
 */
export const recordTriggerForReview = (params: {
  positionId: string;
}): NewbornReviewState => {
  triggerCount += 1;
  const enabled = isReviewEnabled();
  const budget = getReviewBudget();

  // graduated = "we've already auto-halted enough times". Note the
  // strict-greater-than: with budget=3, we auto-halt on triggers 1, 2, 3.
  const wouldHaltThisTrigger = enabled && triggerCount <= budget;
  lastTriggerAutoHalted = wouldHaltThisTrigger;

  if (wouldHaltThisTrigger) {
    const reason = `newborn_trigger_review:${triggerCount}/${budget} positionId=${params.positionId}`;
    // Idempotent: setManualHalt overrides any existing halt with the
    // newer reason. If operator was already halted for a different
    // cause, they'll see the most-recent halt reason on review.
    setManualHalt({ halted: true, reason });
    console.warn(
      `[VC NEWBORN] auto-halted after trigger ${triggerCount}/${budget} ` +
        `for positionId=${params.positionId}. Operator must review outcome ` +
        `(closed shorts, sold longs, ledger, salvage) and clear via ` +
        `POST /volume-cover/admin/halt/clear before next activation.`
    );
  }

  return {
    enabled,
    budget,
    triggersSoFar: triggerCount,
    graduated: triggerCount > budget,
    lastTriggerAutoHalted
  };
};

export const getNewbornReviewState = (): NewbornReviewState => {
  const enabled = isReviewEnabled();
  const budget = getReviewBudget();
  return {
    enabled,
    budget,
    triggersSoFar: triggerCount,
    graduated: triggerCount > budget,
    lastTriggerAutoHalted
  };
};

/**
 * Surface for /volume-cover/health: combines newborn review state with
 * the current manual-halt state for at-a-glance operator clarity.
 */
export const getNewbornReviewHealthSurface = (): {
  newbornReview: NewbornReviewState;
  manualHalt: ReturnType<typeof getManualHalt>;
} => ({
  newbornReview: getNewbornReviewState(),
  manualHalt: getManualHalt()
});

/**
 * Test-only: reset in-memory state. Production code MUST NOT call this.
 */
export const __resetNewbornReviewForTests = (): void => {
  triggerCount = 0;
  lastTriggerAutoHalted = false;
};
