/**
 * Foxify-initiated early close handler — POST /single-side/two-sided/close
 *
 * Body: { pair_id, foxify_close_reason? }
 * Responses:
 *   200 { pair_id, status: "unwinding", initiated_at, estimated_settlement_in_s }
 *   404 { error: "pair_not_found" }
 *   409 { error: "pair_not_active", current_status }
 *
 * Behavior:
 *   - If pair status is "active" or "triggered" → request close via the runtime
 *   - If pair status is "unwinding" → 409 (already closing)
 *   - If pair status is "settled"/"cancelled" → 409 (terminal)
 *
 * The runtime registry is responsible for mapping pair_id → ExecutionRuntime
 * instance (one runtime per triggered pair). For `active` (not yet triggered)
 * pairs, the handler:
 *   - Records `foxify_closed` event
 *   - Transitions active → unwinding directly
 *   - Spawns a runtime in foxify-force-close mode (which will immediately decide
 *     "sell" with reason=foxify_close on first tick)
 *
 * The handler is testable without HTTP plumbing.
 */

import type { Pool } from "pg";
import { getPairById, recordPairEvent, updatePairStatus } from "./db";
import type { ExecutionRuntime } from "./executionRuntime";

export type CloseRequest = {
  pairId: string;
  foxifyCloseReason?: string;
};

export type CloseResponse =
  | { status: 200; body: { pair_id: string; status: "unwinding"; initiated_at: string; estimated_settlement_in_s: number } }
  | { status: 404; body: { error: "pair_not_found" } }
  | { status: 409; body: { error: "pair_not_active"; current_status: string } }
  | { status: 400; body: { error: "invalid_request"; message: string } };

export type CloseDeps = {
  pool: Pool;
  /** Returns the runtime if one is already running for the pair (triggered case). */
  getRuntime: (pairId: string) => ExecutionRuntime | null;
  /** Spawns a new runtime for a pair that was `active` (not yet triggered).
   * Will be invoked with the pair record AFTER the handler transitions
   * pending/active → unwinding. The runtime should start in foxify-force-close
   * mode so its first tick sells at current. */
  spawnRuntimeForceClose: (pairId: string) => Promise<void>;
  nowMs?: () => number;
};

export const handleClose = async (req: unknown, deps: CloseDeps): Promise<CloseResponse> => {
  if (typeof req !== "object" || req === null) {
    return { status: 400, body: { error: "invalid_request", message: "Body must be a JSON object" } };
  }
  const r = req as Record<string, unknown>;
  if (typeof r.pairId !== "string" || r.pairId.length === 0) {
    return { status: 400, body: { error: "invalid_request", message: "pairId is required" } };
  }

  const pair = await getPairById(deps.pool, r.pairId);
  if (!pair) {
    return { status: 404, body: { error: "pair_not_found" } };
  }

  const now = deps.nowMs ? deps.nowMs() : Date.now();
  const nowIso = new Date(now).toISOString();

  if (pair.status === "triggered") {
    // Runtime is already running — request force close on next tick
    const runtime = deps.getRuntime(pair.pairId);
    if (!runtime) {
      // Defensive: pair is triggered but no runtime tracked — spawn one
      await deps.spawnRuntimeForceClose(pair.pairId);
    } else {
      runtime.forceClose();
    }
    await recordPairEvent(deps.pool, {
      pairId: pair.pairId,
      kind: "foxify_closed",
      details: { initiated_at: nowIso, reason: r.foxifyCloseReason ?? "unspecified", from_status: "triggered" }
    });
    return {
      status: 200,
      body: { pair_id: pair.pairId, status: "unwinding", initiated_at: nowIso, estimated_settlement_in_s: 30 }
    };
  }

  if (pair.status === "active") {
    // Bypass trigger — go directly into close. Record event, transition to unwinding (via active path)
    // The state machine permits active → unwinding directly (PR 1 stateMachine).
    await recordPairEvent(deps.pool, {
      pairId: pair.pairId,
      kind: "foxify_closed",
      details: { initiated_at: nowIso, reason: r.foxifyCloseReason ?? "unspecified", from_status: "active" }
    });
    await updatePairStatus(deps.pool, pair.pairId, "unwinding");
    await deps.spawnRuntimeForceClose(pair.pairId);
    return {
      status: 200,
      body: { pair_id: pair.pairId, status: "unwinding", initiated_at: nowIso, estimated_settlement_in_s: 30 }
    };
  }

  return {
    status: 409,
    body: { error: "pair_not_active", current_status: pair.status }
  };
};
