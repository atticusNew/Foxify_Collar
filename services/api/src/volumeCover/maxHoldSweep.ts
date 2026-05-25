/**
 * Volume Cover max-hold sweeper (PR-G, 2026-05-25).
 *
 * Tail-risk guard for Foxify pair protection. The 4-leg [DB] spread is
 * sized for a 3-day expiry; if Foxify rolls a position beyond that,
 * the hedge expires while the protection contractually continues —
 * uncovered exposure. The sweep enforces an Atticus-side max hold:
 * any `status='active'` position older than `VC_MAX_HOLD_HOURS`
 * (default 72h) is auto-closed via the standard `closePosition` path.
 *
 * Foxify can immediately reopen on a fresh pair if they want continued
 * protection; nothing prevents that. The boundary is purely operational:
 * it caps Atticus's tail risk at the hedge expiry boundary while
 * preserving Foxify's flexibility within the paid window.
 *
 * Triggered positions are NOT swept (they're already terminal lifecycle-
 * wise; the hedge manager TP curve disposes of retained legs).
 *
 * Per-tick safety:
 *   - Sweeps are sequential, with try/catch around each close so one
 *     bad close doesn't halt the loop.
 *   - `maxClosesPerCycle` caps the number of positions closed in any
 *     single sweep (default 5) to bound wall-clock impact on the
 *     trigger-detector loop.
 *   - Max-hold reason tagged on the close so audit trails clearly
 *     distinguish from foxify_close / admin_close.
 */

import type { Pool } from "pg";
import { listActivePositions, type PositionRow } from "./volumeCoverDb";
import { closePosition } from "./positionLifecycle";
import type { HedgeExecutor } from "./tightHedge";

export type MaxHoldConfig = {
  enabled: boolean;
  maxHoldHours: number;
  maxClosesPerCycle: number;
};

const DEFAULTS: MaxHoldConfig = {
  enabled: true,
  maxHoldHours: 72,
  maxClosesPerCycle: 5
};

const readNumber = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const readBool = (key: string, fallback: boolean): boolean => {
  const raw = process.env[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  return String(raw).trim().toLowerCase() !== "false";
};

export const getConfiguredMaxHold = (): MaxHoldConfig => ({
  enabled: readBool("VC_MAX_HOLD_ENABLED", DEFAULTS.enabled),
  maxHoldHours: readNumber("VC_MAX_HOLD_HOURS", DEFAULTS.maxHoldHours),
  maxClosesPerCycle: readNumber("VC_MAX_HOLD_CLOSES_PER_CYCLE", DEFAULTS.maxClosesPerCycle)
});

/**
 * Pure decision: is this position past its max-hold deadline right now?
 * Only `status='active'` positions are eligible — triggered/closed
 * positions are skipped (covered by other lifecycle paths).
 */
export const evaluateMaxHoldExpired = (params: {
  position: PositionRow;
  nowMs?: number;
  cfg?: MaxHoldConfig;
}): { expired: boolean; ageMs: number; deadlineMs: number; reason: string | null } => {
  const cfg = params.cfg ?? getConfiguredMaxHold();
  const nowMs = params.nowMs ?? Date.now();
  const openedAtMs = new Date(params.position.openedAt).getTime();
  if (!Number.isFinite(openedAtMs)) {
    return { expired: false, ageMs: 0, deadlineMs: 0, reason: "invalid_opened_at" };
  }
  const ageMs = Math.max(0, nowMs - openedAtMs);
  const deadlineMs = cfg.maxHoldHours * 3_600_000;
  if (!cfg.enabled) {
    return { expired: false, ageMs, deadlineMs, reason: "disabled" };
  }
  if (params.position.status !== "active") {
    return { expired: false, ageMs, deadlineMs, reason: "not_active" };
  }
  if (ageMs < deadlineMs) {
    return { expired: false, ageMs, deadlineMs, reason: null };
  }
  return { expired: true, ageMs, deadlineMs, reason: "max_hold_exceeded" };
};

export type MaxHoldSweepResult = {
  cycledAt: string;
  scanned: number;
  expired: number;
  closed: number;
  skipped: number;
  errors: Array<{ positionId: string; error: string }>;
  closures: Array<{
    positionId: string;
    cellId: string;
    ageMs: number;
    closedAtIso: string;
    daysBilled: number;
  }>;
  capReached: boolean;
};

/**
 * Sweep all currently-active VC positions; auto-close any past the
 * max-hold deadline. Returns telemetry for /admin observability.
 *
 * Defensive on every step:
 *   - Empty active list → return zero counts, no DB writes.
 *   - Per-position close failure → log + continue with next position.
 *   - Cap on closes-per-cycle to keep loop wall-clock bounded.
 */
export const sweepMaxHoldExpiry = async (params: {
  pool: Pool;
  executor: HedgeExecutor;
  currentSpotBtc?: number | null;
  nowMs?: number;
  cfg?: MaxHoldConfig;
}): Promise<MaxHoldSweepResult> => {
  const cfg = params.cfg ?? getConfiguredMaxHold();
  const cycledAt = new Date().toISOString();
  const result: MaxHoldSweepResult = {
    cycledAt,
    scanned: 0,
    expired: 0,
    closed: 0,
    skipped: 0,
    errors: [],
    closures: [],
    capReached: false
  };

  if (!cfg.enabled) return result;

  const active = await listActivePositions(params.pool);
  result.scanned = active.length;

  for (const position of active) {
    const verdict = evaluateMaxHoldExpired({ position, nowMs: params.nowMs, cfg });
    if (!verdict.expired) {
      result.skipped += 1;
      continue;
    }
    result.expired += 1;
    if (result.closed >= cfg.maxClosesPerCycle) {
      result.capReached = true;
      // Stop mid-loop; remaining expired positions will be picked up
      // in the next sweep cycle.
      break;
    }
    try {
      const closeResult = await closePosition(params.pool, params.executor, {
        position,
        reason: `atticus_max_hold_expired:${cfg.maxHoldHours}h`,
        currentSpotBtc:
          typeof params.currentSpotBtc === "number" && params.currentSpotBtc > 0
            ? params.currentSpotBtc
            : undefined
      });
      result.closed += 1;
      result.closures.push({
        positionId: position.id,
        cellId: position.cellId,
        ageMs: verdict.ageMs,
        closedAtIso: closeResult.coverageThroughIso,
        daysBilled: closeResult.daysHeld
      });
      console.log(
        `[volumeCover/maxHoldSweep] auto-closed position ${position.id} cell=${position.cellId} ` +
          `ageHrs=${(verdict.ageMs / 3_600_000).toFixed(1)} ` +
          `cap=${cfg.maxHoldHours}h daysBilled=${closeResult.daysHeld}`
      );
    } catch (err) {
      const message = (err as Error).message;
      result.errors.push({ positionId: position.id, error: message });
      console.error(
        `[volumeCover/maxHoldSweep] auto-close failed for position ${position.id}: ${message}`
      );
    }
  }

  return result;
};
