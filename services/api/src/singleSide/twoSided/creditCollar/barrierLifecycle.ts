/**
 * Barrier-lifecycle coordinator — Phase A (pure, offline, default-off). Coordinates the cross-venue
 * lifecycle: the PERP lives on a partner exchange; the COLLAR is oracle-settled and hedged by Atticus.
 * They are linked only by the oracle price + the bot's open/close signals, so the structure is only
 * EV-neutral if the perp actually opens and closes WITH the protection. This module is the state
 * machine + the accountability checks that hold Foxify to that.
 *
 * Why closing matters even though Atticus unwinds at the touch: unwinding locks ATTICUS's P&L, but if
 * the perp isn't closed at the barrier the trader is left holding an asymmetric FREE option —
 *   - floor touch, no close, price rebounds ⟹ collected protection + rode the recovery (free put);
 *   - ceiling touch, no close ⟹ uncapped upside after selling the cap for the credit (free credit).
 * So protection must open AND close with the perp, symmetrically on both barriers, within an SLA,
 * reconciled against partner-exchange position data. Pure: no I/O; inputs injected.
 */

import { confirmTrigger, type OracleTick } from "./referenceOracle";

export type CollarSide = "long" | "short"; // the trader's PERP side

export type LifecycleState =
  | "proposed"        // signaled to open; perp not yet confirmed on the partner exchange
  | "open"            // perp confirmed open + collar live
  | "close_signaled"  // a barrier confirmed; close signal emitted; awaiting perp close
  | "closed"          // perp close confirmed within SLA; collar settled at the barrier
  | "breached"        // SLA exceeded — perp not closed in time; gap is Foxify's
  | "expired"         // reached expiry with no barrier touch; European settle
  | "cancelled";      // perp closed without a barrier/signal ⟹ collar cancelled (orphan-protection guard)

export type BarrierSide = "floor" | "ceiling" | "none";

export type LifecyclePosition = {
  ref: string;
  side: CollarSide;
  putStrike: number;   // floor
  callStrike: number;  // ceiling
  spotAtEntry: number;
  notionalUsdc: number;
  openedAtMs: number;
  expiresAtMs: number;
  state: LifecycleState;
  barrierTouched: BarrierSide;
  closeSignaledAtMs: number | null;
};

/** What the partner exchange reports for this position (reconciliation source). */
export type PartnerPositionState = {
  isOpen: boolean;
  sizeUsd: number;
  markPriceUsd: number | null;
};

export type LifecycleConfig = {
  /** Persistence (oracle ticks) required to confirm a barrier touch (anti-wick). Default 3. */
  persistTicks?: number;
  /** Max ms between close signal and confirmed perp close before it's a BREACH. Default 30_000. */
  closeSlaMs?: number;
  /** Min ms between a close and the next open for the same line (anti-churn). Default 60_000. */
  reopenCooldownMs?: number;
  /** Notional band for the partner size vs collar notional reconciliation (fraction). Default 0.02. */
  sizeTolerancePct?: number;
};

export const newLifecyclePosition = (
  p: Omit<LifecyclePosition, "state" | "barrierTouched" | "closeSignaledAtMs">
): LifecyclePosition => ({ ...p, state: "proposed", barrierTouched: "none", closeSignaledAtMs: null });

// ── Barrier detection ─────────────────────────────────────────────────────────

/** Confirmed barrier touch (tick-persistent, anti-wick). Floor = price ≤ put; ceiling = price ≥ call. */
export const detectBarrier = (
  ticks: OracleTick[],
  putStrike: number,
  callStrike: number,
  persistTicks: number
): { barrier: BarrierSide; confirmTsMs: number | null } => {
  const floor = confirmTrigger(ticks, putStrike, "down", persistTicks);
  const ceil = confirmTrigger(ticks, callStrike, "up", persistTicks);
  // If somehow both confirm in the window, take the earlier confirmation.
  if (floor.triggered && ceil.triggered) {
    return (floor.firstConfirmTsMs ?? Infinity) <= (ceil.firstConfirmTsMs ?? Infinity)
      ? { barrier: "floor", confirmTsMs: floor.firstConfirmTsMs }
      : { barrier: "ceiling", confirmTsMs: ceil.firstConfirmTsMs };
  }
  if (floor.triggered) return { barrier: "floor", confirmTsMs: floor.firstConfirmTsMs };
  if (ceil.triggered) return { barrier: "ceiling", confirmTsMs: ceil.firstConfirmTsMs };
  return { barrier: "none", confirmTsMs: null };
};

// ── Close-SLA + gap accountability ────────────────────────────────────────────

export type CloseAccountability = {
  onTime: boolean;
  latencyMs: number;
  /** Adverse gap between the barrier and the realized close price, in USDC over the position. */
  gapUsdc: number;
  /** Who bears the gap: "reserve" (within SLA → Atticus's timing reserve) or "foxify" (SLA breach). */
  bearer: "reserve" | "foxify" | "none";
};

/**
 * Accountability for a barrier close. The adverse gap is how far PAST the barrier the perp actually
 * closed (slippage beyond the protected level). Within the SLA the gap is covered by Atticus's timing
 * reserve; beyond the SLA it is Foxify's cost (they held the free look). Pure.
 */
export const assessClose = (
  barrier: BarrierSide,
  barrierPriceUsd: number,
  closePriceUsd: number,
  contractsBtc: number,
  signalTsMs: number,
  closeConfirmTsMs: number,
  closeSlaMs: number
): CloseAccountability => {
  const latencyMs = Math.max(0, closeConfirmTsMs - signalTsMs);
  const onTime = latencyMs <= closeSlaMs;
  // Adverse direction: floor closes below the floor; ceiling closes above the ceiling.
  const adverse = barrier === "floor" ? Math.max(0, barrierPriceUsd - closePriceUsd) : barrier === "ceiling" ? Math.max(0, closePriceUsd - barrierPriceUsd) : 0;
  const gapUsdc = +(adverse * contractsBtc).toFixed(2);
  const bearer: CloseAccountability["bearer"] = gapUsdc <= 0 ? "none" : onTime ? "reserve" : "foxify";
  return { onTime, latencyMs, gapUsdc, bearer };
};

// ── Gaming detectors (reconciliation against the partner exchange) ─────────────

export type GamingFlag =
  | { kind: "phantom_position"; ref: string; detail: string }
  | { kind: "orphan_protection"; ref: string; detail: string }
  | { kind: "size_mismatch"; ref: string; detail: string }
  | { kind: "churn_cooldown"; ref: string; detail: string }
  | { kind: "asymmetric_compliance"; detail: string };

/** Collar live but the partner exchange shows NO perp ⟹ phantom (credit claimed without a position). */
export const detectPhantom = (pos: LifecyclePosition, partner: PartnerPositionState): GamingFlag | null =>
  (pos.state === "open" || pos.state === "proposed") && !partner.isOpen
    ? { kind: "phantom_position", ref: pos.ref, detail: "collar active but partner exchange shows no open perp" }
    : null;

/** Perp closed on the partner exchange with NO barrier/close-signal ⟹ Foxify closed early to keep a
 *  naked protection leg. The collar must be cancelled (not left as a free option). */
export const detectOrphanProtection = (pos: LifecyclePosition, partner: PartnerPositionState): GamingFlag | null =>
  pos.state === "open" && !partner.isOpen && pos.barrierTouched === "none"
    ? { kind: "orphan_protection", ref: pos.ref, detail: "perp closed with no barrier/signal — collar must cancel (no free protection)" }
    : null;

/** Partner perp size must match the collar notional within tolerance (no under/over-hedged claims). */
export const detectSizeMismatch = (pos: LifecyclePosition, partner: PartnerPositionState, tolPct: number): GamingFlag | null => {
  if (!partner.isOpen || pos.notionalUsdc <= 0) return null;
  const rel = Math.abs(Math.abs(partner.sizeUsd) - pos.notionalUsdc) / pos.notionalUsdc;
  return rel > tolPct ? { kind: "size_mismatch", ref: pos.ref, detail: `partner size $${partner.sizeUsd} vs collar $${pos.notionalUsdc} (${(rel * 100).toFixed(1)}% off)` } : null;
};

/** Anti-churn: a new open for a line within the cooldown of its last close is credit-farming. */
export const enforceReopenCooldown = (ref: string, lastCloseMs: number | null, nextOpenMs: number, cooldownMs: number): GamingFlag | null =>
  lastCloseMs != null && nextOpenMs - lastCloseMs < cooldownMs
    ? { kind: "churn_cooldown", ref, detail: `reopen ${nextOpenMs - lastCloseMs}ms after close < ${cooldownMs}ms cooldown` }
    : null;

/**
 * Cherry-picking detector: a trader who closes reliably on the FLOOR (to lock protection) but not on
 * the CEILING (to keep upside) is gaming the structure. Flags when per-side close-compliance diverges.
 */
export const detectAsymmetricCompliance = (
  history: Array<{ barrier: BarrierSide; closedOnTime: boolean }>,
  minPerSide = 5,
  maxGap = 0.2
): GamingFlag | null => {
  const side = (b: BarrierSide) => history.filter((h) => h.barrier === b);
  const rate = (arr: Array<{ closedOnTime: boolean }>) => (arr.length ? arr.filter((h) => h.closedOnTime).length / arr.length : null);
  const floor = side("floor"), ceil = side("ceiling");
  const rf = rate(floor), rc = rate(ceil);
  if (rf == null || rc == null || floor.length < minPerSide || ceil.length < minPerSide) return null;
  return Math.abs(rf - rc) > maxGap
    ? { kind: "asymmetric_compliance", detail: `floor close-rate ${(rf * 100).toFixed(0)}% vs ceiling ${(rc * 100).toFixed(0)}% — cherry-picking` }
    : null;
};

// ── State machine step ────────────────────────────────────────────────────────

export type LifecycleContext = {
  nowMs: number;
  ticks: OracleTick[];                 // oracle ticks over the observation window
  partner: PartnerPositionState;        // partner-exchange reconciliation
  settlePriceUsd?: number | null;       // realized close/settlement price (oracle or partner mark)
  cfg?: LifecycleConfig;
};

export type LifecycleStep = {
  pos: LifecyclePosition;
  actions: Array<"confirm_open" | "emit_close_signal" | "unwind_hedge" | "settle" | "cancel_collar">;
  flags: GamingFlag[];
  accountability: CloseAccountability | null;
};

/**
 * Advance one position one step. Pure + deterministic. Drives: confirm open (reconciled), detect a
 * barrier and emit the close signal + unwind, enforce the close SLA (gap accountability), settle on
 * close/expiry, and guard the orphan/phantom gaming cases.
 */
export const stepLifecycle = (pos: LifecyclePosition, ctx: LifecycleContext): LifecycleStep => {
  const cfg = ctx.cfg ?? {};
  const persist = cfg.persistTicks ?? 3;
  const sla = cfg.closeSlaMs ?? 30_000;
  const tol = cfg.sizeTolerancePct ?? 0.02;
  const actions: LifecycleStep["actions"] = [];
  const flags: GamingFlag[] = [];
  let accountability: CloseAccountability | null = null;
  let next = { ...pos };

  // Reconciliation guards apply in any live state.
  const phantom = detectPhantom(pos, ctx.partner);
  if (phantom) flags.push(phantom);
  const sizeFlag = detectSizeMismatch(pos, ctx.partner, tol);
  if (sizeFlag) flags.push(sizeFlag);

  switch (pos.state) {
    case "proposed": {
      if (ctx.partner.isOpen) {
        next.state = "open";
        actions.push("confirm_open");
      }
      break;
    }
    case "open": {
      // Orphan-protection: perp gone with no barrier ⟹ cancel the collar (no free protection).
      const orphan = detectOrphanProtection(pos, ctx.partner);
      if (orphan) {
        flags.push(orphan);
        next.state = "cancelled";
        actions.push("cancel_collar", "unwind_hedge");
        break;
      }
      const { barrier, confirmTsMs } = detectBarrier(ctx.ticks, pos.putStrike, pos.callStrike, persist);
      if (barrier !== "none") {
        next.state = "close_signaled";
        next.barrierTouched = barrier;
        next.closeSignaledAtMs = confirmTsMs ?? ctx.nowMs;
        actions.push("emit_close_signal", "unwind_hedge"); // Atticus locks its side immediately
      } else if (ctx.nowMs >= pos.expiresAtMs) {
        next.state = "expired";
        actions.push("settle"); // European settle on the oracle TWAP
      }
      break;
    }
    case "close_signaled": {
      const barrierPrice = pos.barrierTouched === "floor" ? pos.putStrike : pos.callStrike;
      const contractsBtc = pos.notionalUsdc / pos.spotAtEntry;
      if (!ctx.partner.isOpen) {
        // Perp closed — assess SLA + gap against the realized close price.
        const closePrice = ctx.settlePriceUsd ?? ctx.partner.markPriceUsd ?? barrierPrice;
        accountability = assessClose(pos.barrierTouched, barrierPrice, closePrice, contractsBtc, pos.closeSignaledAtMs ?? ctx.nowMs, ctx.nowMs, sla);
        next.state = accountability.onTime ? "closed" : "breached";
        actions.push("settle");
      } else if (ctx.nowMs - (pos.closeSignaledAtMs ?? ctx.nowMs) > sla) {
        // Still open past the SLA — breach; the gap from here is Foxify's.
        const closePrice = ctx.settlePriceUsd ?? ctx.partner.markPriceUsd ?? barrierPrice;
        accountability = assessClose(pos.barrierTouched, barrierPrice, closePrice, contractsBtc, pos.closeSignaledAtMs ?? ctx.nowMs, ctx.nowMs, sla);
        next.state = "breached";
        actions.push("settle");
      }
      break;
    }
    default:
      break; // terminal states: closed | breached | expired | cancelled
  }

  return { pos: next, actions, flags, accountability };
};
