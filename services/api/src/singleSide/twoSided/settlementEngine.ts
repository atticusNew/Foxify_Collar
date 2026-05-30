/**
 * Settlement engine (PR 6).
 *
 * Pure functions encoding the cooperative split mechanic from PLAN.md §3:
 *
 *   uplift = salvage_proceeds - hedge_cost_total
 *   if uplift <= 0:
 *     atticus = 0   (Atticus does NOT collect on loss paths)
 *     foxify  = salvage  (Foxify eats the loss vs hedge_cost)
 *   else:
 *     atticus_proportional = tier.atticusPct × uplift
 *     atticus_floored      = max(atticus_proportional, tier.atticusFloorUsdc)
 *     atticus              = min(uplift, atticus_floored)   (clamp so Foxify never < 0)
 *     foxify               = hedge_cost + (uplift - atticus)
 *
 * Returns full breakdown for audit (proportional vs floored, was floor binding, etc.).
 */

import type { TierDefinition } from "./types";

export type SplitInput = {
  salvageProceedsUsdc: number;
  hedgeCostUsdc: number;
  tier: TierDefinition;
};

export type SplitResult = {
  salvageProceedsUsdc: number;
  hedgeCostUsdc: number;
  upliftUsdc: number;
  atticusShareUsdc: number;
  foxifyShareUsdc: number;
  atticusProportionalUsdc: number;
  atticusFlooredUsdc: number;
  floorWasBinding: boolean;
  upliftClampApplied: boolean;
  outcomeCategory: "uplift_positive" | "uplift_zero" | "uplift_negative";
};

export const computeSplit = (input: SplitInput): SplitResult => {
  const { salvageProceedsUsdc, hedgeCostUsdc, tier } = input;
  const uplift = salvageProceedsUsdc - hedgeCostUsdc;

  if (uplift < 0) {
    return {
      salvageProceedsUsdc,
      hedgeCostUsdc,
      upliftUsdc: uplift,
      atticusShareUsdc: 0,
      foxifyShareUsdc: salvageProceedsUsdc,
      atticusProportionalUsdc: 0,
      atticusFlooredUsdc: 0,
      floorWasBinding: false,
      upliftClampApplied: false,
      outcomeCategory: "uplift_negative"
    };
  }
  if (uplift === 0) {
    return {
      salvageProceedsUsdc,
      hedgeCostUsdc,
      upliftUsdc: 0,
      atticusShareUsdc: 0,
      foxifyShareUsdc: hedgeCostUsdc,
      atticusProportionalUsdc: 0,
      atticusFlooredUsdc: 0,
      floorWasBinding: false,
      upliftClampApplied: false,
      outcomeCategory: "uplift_zero"
    };
  }

  const proportional = tier.atticusPct * uplift;
  const floored = Math.max(proportional, tier.atticusFloorUsdc);
  const atticus = Math.min(uplift, floored);
  const foxify = hedgeCostUsdc + (uplift - atticus);

  return {
    salvageProceedsUsdc,
    hedgeCostUsdc,
    upliftUsdc: uplift,
    atticusShareUsdc: atticus,
    foxifyShareUsdc: foxify,
    atticusProportionalUsdc: proportional,
    atticusFlooredUsdc: floored,
    floorWasBinding: floored > proportional,
    upliftClampApplied: floored > uplift,
    outcomeCategory: "uplift_positive"
  };
};

/** Sanity invariant for tests + runtime assertions. Should always hold. */
export const assertSplitInvariant = (result: SplitResult): void => {
  const sum = result.atticusShareUsdc + result.foxifyShareUsdc;
  const expected = result.salvageProceedsUsdc;
  if (Math.abs(sum - expected) > 1e-6) {
    throw new Error(
      `Split invariant violated: atticus=${result.atticusShareUsdc} + foxify=${result.foxifyShareUsdc} = ${sum} ≠ salvage=${expected}`
    );
  }
  if (result.atticusShareUsdc < 0) throw new Error(`Negative atticus share: ${result.atticusShareUsdc}`);
  if (result.foxifyShareUsdc < 0) throw new Error(`Negative foxify share: ${result.foxifyShareUsdc}`);
};
