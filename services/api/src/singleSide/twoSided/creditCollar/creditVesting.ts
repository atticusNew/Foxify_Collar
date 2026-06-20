/**
 * Credit vesting + clawback — Phase A (pure, offline, default-off). The credit Foxify receives is NOT
 * upfront cash: it is the net premium for SELLING the collar optionality over the tenor, so it vests
 * with time held (theta). This kills the open-and-grab farming attack — closing right after opening
 * vests ~nothing — and ensures Atticus never pays out a credit that wasn't earned.
 *
 *   - expiry                → fully vested (held the whole tenor)
 *   - barrier_close         → vested-to-touch (or full, if barrierFullVest is set as a product choice)
 *   - voluntary_early_close → vested fraction only; the rest is clawed back (+ optional churn penalty)
 *   - breach_forfeit        → forfeit the whole credit (didn't close on the signal — gaming)
 */

const round2 = (x: number) => +x.toFixed(2);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export type VestingCurve = "linear" | "convex"; // convex = back-loaded (more vests near expiry, theta-like)

export type CreditVestingConfig = {
  fullCreditUsdc: number;          // credit if held to natural conclusion
  tenorMs: number;                 // full position tenor
  curve?: VestingCurve;            // default "linear"
  convexity?: number;              // exponent for "convex"; default 1.5
  /** If true a barrier touch realizes the FULL credit (product choice); default false = time-vested. */
  barrierFullVest?: boolean;
  /** Extra clawback on a VOLUNTARY early close, fraction [0,1] (anti-churn). Default 0. */
  earlyClosePenaltyPct?: number;
};

export type VestingConclusion = "expiry" | "barrier_close" | "voluntary_early_close" | "breach_forfeit";

export type VestingOutcome = {
  heldMs: number;
  vestedFraction: number;          // the fraction actually realized (post conclusion rules)
  realizedCreditUsdc: number;      // what Foxify keeps
  clawbackUsdc: number;            // fullCredit − realized (unearned, returned/withheld)
  forfeited: boolean;
  reason: VestingConclusion;
};

/** Pure time-vesting fraction in [0,1]. Linear by default; convex back-loads it toward expiry. */
export const vestedTimeFraction = (heldMs: number, tenorMs: number, curve: VestingCurve = "linear", convexity = 1.5): number => {
  if (!(tenorMs > 0)) return 0;
  const t = clamp01(heldMs / tenorMs);
  return curve === "convex" ? Math.pow(t, Math.max(1, convexity)) : t;
};

/** Compute the realized credit + clawback for a concluded position. Pure. */
export const computeVestedCredit = (cfg: CreditVestingConfig, heldMs: number, reason: VestingConclusion): VestingOutcome => {
  const full = Math.max(0, cfg.fullCreditUsdc);
  if (reason === "breach_forfeit") {
    return { heldMs, vestedFraction: 0, realizedCreditUsdc: 0, clawbackUsdc: round2(full), forfeited: true, reason };
  }
  const timeFrac = vestedTimeFraction(heldMs, cfg.tenorMs, cfg.curve ?? "linear", cfg.convexity ?? 1.5);
  let frac: number;
  if (reason === "expiry") frac = 1;
  else if (reason === "barrier_close") frac = cfg.barrierFullVest ? 1 : timeFrac;
  else frac = timeFrac; // voluntary_early_close
  let realized = full * frac;
  if (reason === "voluntary_early_close" && cfg.earlyClosePenaltyPct) realized *= 1 - clamp01(cfg.earlyClosePenaltyPct);
  return {
    heldMs,
    vestedFraction: +frac.toFixed(6),
    realizedCreditUsdc: round2(realized),
    clawbackUsdc: round2(full - realized),
    forfeited: false,
    reason
  };
};
