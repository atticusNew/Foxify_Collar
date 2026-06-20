/**
 * Lifecycle-state persistence — the FSM state per position, carried ACROSS cycles. The close-SLA spans
 * cycles (a barrier is signalled in one cycle; the partner perp close is confirmed in a later one), so
 * the coordinator must remember each position's state (proposed/open/close_signaled/…) and the moment a
 * close was signalled. Disk-backed (Render disk) with the same writable-fallback as the other stores.
 *
 * A tracked position is a LifecyclePosition plus the credit it carries (so vesting/forfeit can be
 * computed at conclusion without re-deriving it from the economic open book, which may have already
 * settled the collar leg at a touch).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolveWritablePath } from "./shadowStore";
import type { BarrierSide, LifecyclePosition } from "./barrierLifecycle";

export type TrackedPosition = LifecyclePosition & { foxifyCreditUsdc: number };

/** Cross-cycle history for the cherry-pick (asymmetric compliance) + reopen-cooldown detectors. */
export type LifecycleHistory = {
  closeHistory: Array<{ barrier: BarrierSide; closedOnTime: boolean }>;
  lastCloseByRef: Record<string, number>;
};

export const DEFAULT_LIFECYCLE_STATE_PATH = process.env.SHADOW_LIFECYCLE_STATE_PATH ?? "./logs/shadow-lifecycle-state.json";
export const DEFAULT_LIFECYCLE_HISTORY_PATH = process.env.SHADOW_LIFECYCLE_HISTORY_PATH ?? "./logs/shadow-lifecycle-history.json";

/** Keep the close history bounded — the detectors only need a recent window. */
const MAX_CLOSE_HISTORY = 500;

export const loadLifecycleStates = (path = DEFAULT_LIFECYCLE_STATE_PATH): Record<string, TrackedPosition> => {
  const eff = resolveWritablePath(path);
  if (!existsSync(eff)) return {};
  try {
    const parsed = JSON.parse(readFileSync(eff, "utf8")) as Record<string, TrackedPosition>;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, TrackedPosition> = {};
    for (const [ref, p] of Object.entries(parsed)) if (p && p.ref) out[ref] = p;
    return out;
  } catch {
    return {};
  }
};

export const saveLifecycleStates = (states: Record<string, TrackedPosition>, path = DEFAULT_LIFECYCLE_STATE_PATH): void => {
  const eff = resolveWritablePath(path);
  try {
    writeFileSync(eff, JSON.stringify(states), "utf8");
  } catch (e) {
    console.warn(`[lifecycle-state] save failed (${(e as Error).message})`);
  }
};

export const loadLifecycleHistory = (path = DEFAULT_LIFECYCLE_HISTORY_PATH): LifecycleHistory => {
  const eff = resolveWritablePath(path);
  if (!existsSync(eff)) return { closeHistory: [], lastCloseByRef: {} };
  try {
    const parsed = JSON.parse(readFileSync(eff, "utf8")) as LifecycleHistory;
    return {
      closeHistory: Array.isArray(parsed?.closeHistory) ? parsed.closeHistory : [],
      lastCloseByRef: parsed?.lastCloseByRef && typeof parsed.lastCloseByRef === "object" ? parsed.lastCloseByRef : {}
    };
  } catch {
    return { closeHistory: [], lastCloseByRef: {} };
  }
};

export const saveLifecycleHistory = (history: LifecycleHistory, path = DEFAULT_LIFECYCLE_HISTORY_PATH): void => {
  const eff = resolveWritablePath(path);
  const trimmed: LifecycleHistory = {
    closeHistory: history.closeHistory.slice(-MAX_CLOSE_HISTORY),
    lastCloseByRef: history.lastCloseByRef
  };
  try {
    writeFileSync(eff, JSON.stringify(trimmed), "utf8");
  } catch (e) {
    console.warn(`[lifecycle-history] save failed (${(e as Error).message})`);
  }
};
