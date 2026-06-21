/**
 * Lifecycle coordinator — Phase A (pure, offline, default-off). Drives the barrier-lifecycle FSM
 * (`stepLifecycle`) over the whole tracked book each cycle, fed by the LIVE partner-position feed, the
 * rolling oracle ticks, and the collateral ledger. This is what turns the coded-but-dormant state
 * machine into the running perp↔collar coordination:
 *
 *   - OPEN CONFIRMATION / PHANTOM — a collar is only "open" once the partner perp is confirmed.
 *   - ORPHAN CANCELLATION — partner perp closed with NO barrier ⟹ cancel the collar (no free leg).
 *   - CLOSE-SLA + GAP ALLOCATION — a barrier signals a close; if the perp closes within SLA the gap
 *     is the reserve's, if it's late the gap is debited to Foxify's collateral and the credit forfeits.
 *   - GAMING DETECTORS — phantom/size every step; cherry-pick over the accumulated close history.
 *
 * Pure: prior FSM states + open book + partner states + ledger are injected; no I/O. The caller
 * persists the returned states/ledger/history. Coordination is signal + economic enforcement (Atticus
 * cannot close Foxify's perp) — the FSM produces the actions/gaps/forfeits that hold Foxify to the SLA.
 */

import {
  stepLifecycle,
  newLifecyclePosition,
  detectAsymmetricCompliance,
  enforceReopenCooldown,
  type LifecyclePosition,
  type LifecycleState,
  type LifecycleConfig,
  type BarrierSide,
  type PartnerPositionState,
  type GamingFlag
} from "./barrierLifecycle";
import { applyGap, type CollateralLedger, type CollateralConfig } from "./collateralLedger";
import type { VestingCurve, VestingOutcome } from "./creditVesting";
import type { OracleTick } from "./referenceOracle";
import type { OpenPosition } from "./forwardSettlement";
import type { TrackedPosition } from "./lifecycleStateStore";

const round2 = (x: number) => +x.toFixed(2);

const TERMINAL: ReadonlySet<LifecycleState> = new Set(["closed", "breached", "expired", "cancelled"]);

export type CoordinatorConfig = {
  lifecycle?: LifecycleConfig;            // persistTicks, closeSlaMs, reopenCooldownMs, sizeTolerancePct
  vesting?: { curve?: VestingCurve; convexity?: number; barrierFullVest?: boolean; earlyClosePenaltyPct?: number };
  collateral?: CollateralConfig;
  cherryPick?: { minPerSide?: number; maxGap?: number };
};

export type CoordinatorContext = {
  nowMs: number;
  ticks: OracleTick[];
  /** Reconciled partner-perp state by ref (fail-closed: missing/stale ⟹ assume still open). */
  partnerStates: Record<string, PartnerPositionState>;
  settlePriceUsd: number | null;
  ledger: CollateralLedger;
  /** Accumulated barrier-close history (for the cherry-pick detector), carried across cycles. */
  closeHistory?: Array<{ barrier: BarrierSide; closedOnTime: boolean }>;
  /** Last terminal-close time per ref, for the reopen-cooldown anti-churn check. */
  lastCloseByRef?: Record<string, number>;
};

export type ConcludedPosition = {
  ref: string;
  state: LifecycleState;
  creditOutcome: VestingOutcome | null;
  gapUsdc: number;
  gapBearer: "reserve" | "foxify" | "none";
  onTime: boolean | null;
};

export type CoordinatorOutcome = {
  /** Non-terminal FSM states to persist (terminal ones drop out, recorded in `concluded`). */
  states: Record<string, TrackedPosition>;
  ledger: CollateralLedger;
  concluded: ConcludedPosition[];
  /** Refs cancelled (orphan/early close) — must be EXCLUDED from economic settlement. */
  cancelledRefs: string[];
  /** Refs that breached the close SLA — credit forfeited, gap debited to Foxify. */
  breachedRefs: string[];
  flags: GamingFlag[];
  actionsByRef: Record<string, string[]>;
  closeHistory: Array<{ barrier: BarrierSide; closedOnTime: boolean }>;
  lastCloseByRef: Record<string, number>;
  summary: {
    tracked: number;
    open: number;
    closeSignaled: number;
    concluded: number;
    orphanCancelled: number;
    breached: number;
    expired: number;
    closedOnTime: number;
    phantom: number;
    sizeMismatch: number;
    gapToReserveUsdc: number;
    gapToFoxifyUsdc: number;
  };
  /** Cherry-pick (asymmetric floor/ceiling compliance) flag, if the history warrants it. Null otherwise. */
  cherryPickFlag: GamingFlag | null;
};

/** Build a fresh tracked position (state "proposed") from an economic open-book position. Pure. */
export const seedTracked = (p: OpenPosition): TrackedPosition => ({
  ...newLifecyclePosition({
    ref: p.ref,
    side: p.side,
    putStrike: p.putStrike,
    callStrike: p.callStrike,
    spotAtEntry: p.spotAtEntry,
    notionalUsdc: p.notionalUsdc,
    openedAtMs: p.openedAtMs,
    expiresAtMs: p.expiresAtMs
  }),
  foxifyCreditUsdc: p.foxifyCreditUsdc
});

/**
 * Drive the FSM one step over the whole tracked book. The working set is the UNION of the prior
 * (persisted) states and the current open book — so a position whose collar already settled at a touch
 * but whose perp close is still pending stays tracked until it concludes (the cross-cycle SLA). Pure.
 */
export const stepLifecycleBook = (
  priorStates: Record<string, TrackedPosition>,
  openBook: OpenPosition[],
  ctx: CoordinatorContext,
  cfg: CoordinatorConfig = {}
): CoordinatorOutcome => {
  // Working set: carry prior FSM states; seed any new open-book ref as "proposed".
  const working: Record<string, TrackedPosition> = {};
  for (const [ref, p] of Object.entries(priorStates)) working[ref] = p;
  for (const p of openBook) if (!working[p.ref]) working[p.ref] = seedTracked(p);

  const states: Record<string, TrackedPosition> = {};
  const concluded: ConcludedPosition[] = [];
  const cancelledRefs: string[] = [];
  const breachedRefs: string[] = [];
  const flags: GamingFlag[] = [];
  const actionsByRef: Record<string, string[]> = {};
  const closeHistory = [...(ctx.closeHistory ?? [])];
  const lastCloseByRef = { ...(ctx.lastCloseByRef ?? {}) };

  let ledger = ctx.ledger;
  let open = 0;
  let closeSignaled = 0;
  let orphanCancelled = 0;
  let breached = 0;
  let expired = 0;
  let closedOnTime = 0;
  let phantom = 0;
  let sizeMismatch = 0;
  let gapToReserve = 0;
  let gapToFoxify = 0;

  for (const tracked of Object.values(working)) {
    // Fail-closed default: a position with no partner record is assumed STILL OPEN (never infer a
    // close/cancel on missing data). reconcilePositions already encodes this upstream.
    const partner: PartnerPositionState = ctx.partnerStates[tracked.ref] ?? { isOpen: true, sizeUsd: tracked.notionalUsdc, markPriceUsd: null };

    const step = stepLifecycle(tracked, {
      nowMs: ctx.nowMs,
      ticks: ctx.ticks,
      partner,
      settlePriceUsd: ctx.settlePriceUsd,
      cfg: cfg.lifecycle,
      vesting: {
        fullCreditUsdc: tracked.foxifyCreditUsdc,
        tenorMs: Math.max(1, tracked.expiresAtMs - tracked.openedAtMs),
        curve: cfg.vesting?.curve,
        convexity: cfg.vesting?.convexity,
        barrierFullVest: cfg.vesting?.barrierFullVest,
        earlyClosePenaltyPct: cfg.vesting?.earlyClosePenaltyPct
      }
    });

    if (step.actions.length) actionsByRef[tracked.ref] = step.actions;
    for (const f of step.flags) {
      flags.push(f);
      if (f.kind === "phantom_position") phantom += 1;
      if (f.kind === "size_mismatch") sizeMismatch += 1;
    }

    // Route any gap from a barrier close through the collateral waterfall.
    if (step.gapEvent) {
      const a = applyGap(ledger, step.gapEvent, cfg.collateral);
      ledger = a.ledger;
      if (a.bearer === "reserve") gapToReserve += step.gapEvent.gapUsdc;
      if (a.bearer === "foxify") gapToFoxify += a.debitedUsdc;
    }

    const next = { ...tracked, ...step.pos } as TrackedPosition;

    if (TERMINAL.has(next.state)) {
      const acc = step.accountability;
      concluded.push({
        ref: next.ref,
        state: next.state,
        creditOutcome: step.creditOutcome,
        gapUsdc: acc ? acc.gapUsdc : 0,
        gapBearer: acc ? acc.bearer : "none",
        onTime: acc ? acc.onTime : null
      });
      lastCloseByRef[next.ref] = ctx.nowMs;
      if (next.state === "cancelled") {
        cancelledRefs.push(next.ref);
        orphanCancelled += 1;
      } else if (next.state === "breached") {
        breachedRefs.push(next.ref);
        breached += 1;
      } else if (next.state === "expired") {
        expired += 1;
      }
      // Record floor/ceiling close compliance for the cherry-pick detector (barrier closes only).
      if ((next.state === "closed" || next.state === "breached") && next.barrierTouched !== "none") {
        closeHistory.push({ barrier: next.barrierTouched, closedOnTime: acc ? acc.onTime : false });
        if (next.state === "closed" && acc?.onTime) closedOnTime += 1;
      }
      // terminal ⟹ drop from persisted states
    } else {
      states[next.ref] = next;
      if (next.state === "open") open += 1;
      if (next.state === "close_signaled") closeSignaled += 1;
    }
  }

  const cherryPickFlag = detectAsymmetricCompliance(closeHistory, cfg.cherryPick?.minPerSide, cfg.cherryPick?.maxGap);
  if (cherryPickFlag) flags.push(cherryPickFlag);

  return {
    states,
    ledger,
    concluded,
    cancelledRefs,
    breachedRefs,
    flags,
    actionsByRef,
    closeHistory,
    lastCloseByRef,
    summary: {
      tracked: Object.keys(working).length,
      open,
      closeSignaled,
      concluded: concluded.length,
      orphanCancelled,
      breached,
      expired,
      closedOnTime,
      phantom,
      sizeMismatch,
      gapToReserveUsdc: round2(gapToReserve),
      gapToFoxifyUsdc: round2(gapToFoxify)
    },
    cherryPickFlag
  };
};

/**
 * Anti-churn check for a batch of NEW opens against the last-close-by-ref ledger. Returns one
 * churn_cooldown flag per ref reopened within the cooldown. Kept separate from the per-step driver
 * because cooldown is an OPEN-time gate (it needs the proposed open times), not a state transition.
 */
export const checkReopenCooldowns = (
  newOpens: Array<{ ref: string; openedAtMs: number }>,
  lastCloseByRef: Record<string, number>,
  cooldownMs: number
): GamingFlag[] => {
  const out: GamingFlag[] = [];
  for (const o of newOpens) {
    const flag = enforceReopenCooldown(o.ref, lastCloseByRef[o.ref] ?? null, o.openedAtMs, cooldownMs);
    if (flag) out.push(flag);
  }
  return out;
};
