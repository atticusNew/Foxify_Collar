/**
 * Concurrent-unwind FIFO queue with deadline priority (PR B1).
 *
 * Phase 0 had a basic counter-based throttle (canUnwind in guardrails.ts).
 * This is the production-grade scheduler that:
 *   - Maintains a FIFO queue ordered by triggered_at (oldest waits longest = wins next slot)
 *   - Honors a per-regime concurrent-slot budget (calm 2/min, elevated 3/30s, etc.)
 *   - Force-grants slots that have waited longer than maxWaitMs (protects
 *     capture-window-peak opportunity from being missed due to throttle saturation)
 *   - Exposes stats for /admin/foxify/v2/diagnostics
 *
 * Runtime integration:
 *   ExecutionRuntime calls await queue.requestSlot(pairId, triggeredAtMs)
 *   - If granted: proceeds with closeExecutor
 *   - If denied: re-emits 'wait' decision; next tick will retry
 *   ExecutionRuntime calls queue.releaseSlot(pairId) after close terminal state.
 *
 * Thread-safety: single Node process, single-threaded — no locks needed. The
 * queue mutates state only inside requestSlot/releaseSlot, both sync.
 */

import { classifyRegime, type Regime } from "./featureFlag";

export type UnwindWindowPolicy = {
  windowMs: number;        // rolling window for concurrent count
  maxConcurrent: number;   // max grants per window
};

export const DEFAULT_REGIME_POLICY: Record<Regime, UnwindWindowPolicy> = {
  calm: { windowMs: 60_000, maxConcurrent: 2 },
  moderate: { windowMs: 60_000, maxConcurrent: 2 },
  elevated: { windowMs: 30_000, maxConcurrent: 3 },
  stress: { windowMs: 20_000, maxConcurrent: 4 }
};

export const DEFAULT_MAX_WAIT_MS = 20 * 60_000; // 20 min — deadline force-grant

type QueuedEntry = {
  pairId: string;
  triggeredAtMs: number;
  requestedAtMs: number;
  granted: boolean;
  grantedAtMs: number | null;
  forceGranted: boolean;
};

export type UnwindQueueOpts = {
  policy?: Record<Regime, UnwindWindowPolicy>;
  maxWaitMs?: number;
  /** Returns current regime for policy lookup. */
  getCurrentRegime?: () => Regime | null;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
};

export class UnwindQueue {
  /** All entries ever seen, keyed by pairId. */
  private entries = new Map<string, QueuedEntry>();
  /** History of grant timestamps for in-window counting. */
  private grantTimestampsMs: number[] = [];
  private totalGranted = 0;
  private totalForceGranted = 0;
  private totalDenied = 0;

  constructor(private readonly opts: UnwindQueueOpts = {}) {}

  /**
   * Request a slot for the given pair. Synchronous, returns:
   *   { granted: true } — proceed with close
   *   { granted: false, reason, queueDepth, waitMs } — wait, retry next tick
   *
   * If already granted previously (idempotent), returns granted=true.
   */
  requestSlot(pairId: string, triggeredAtMs: number, nowMs?: number): { granted: boolean; reason?: string; queueDepth: number; waitMs: number; forceGranted?: boolean } {
    const now = nowMs ?? Date.now();
    const existing = this.entries.get(pairId);
    if (existing?.granted) {
      return { granted: true, queueDepth: this.queueDepth(now), waitMs: 0 };
    }

    if (!existing) {
      this.entries.set(pairId, {
        pairId,
        triggeredAtMs,
        requestedAtMs: now,
        granted: false,
        grantedAtMs: null,
        forceGranted: false
      });
    }
    const entry = this.entries.get(pairId)!;
    const waitMs = now - entry.requestedAtMs;

    // Deadline check: force-grant if waited too long
    const maxWait = this.opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    if (waitMs >= maxWait) {
      entry.granted = true;
      entry.grantedAtMs = now;
      entry.forceGranted = true;
      this.grantTimestampsMs.push(now);
      this.totalGranted++;
      this.totalForceGranted++;
      this.log(`force-granted pair=${pairId} after waiting ${waitMs}ms (deadline=${maxWait}ms)`, { pairId, waitMs });
      return { granted: true, queueDepth: this.queueDepth(now), waitMs, forceGranted: true };
    }

    // FIFO check: this pair must be the next-oldest in the queue (by triggered_at)
    // to be considered for a slot.
    const queueOrdered = Array.from(this.entries.values())
      .filter((e) => !e.granted)
      .sort((a, b) => a.triggeredAtMs - b.triggeredAtMs);
    const nextInLine = queueOrdered[0];
    if (nextInLine && nextInLine.pairId !== pairId) {
      this.totalDenied++;
      return {
        granted: false,
        reason: `queue_position (next=${nextInLine.pairId} triggered earlier)`,
        queueDepth: queueOrdered.length,
        waitMs
      };
    }

    // Concurrent slot availability check per regime policy
    const policyMap = this.opts.policy ?? DEFAULT_REGIME_POLICY;
    const regime = this.opts.getCurrentRegime?.() ?? "calm";
    const policy = policyMap[regime] ?? DEFAULT_REGIME_POLICY.calm;
    // Prune timestamps outside window
    const cutoff = now - policy.windowMs;
    this.grantTimestampsMs = this.grantTimestampsMs.filter((t) => t > cutoff);
    if (this.grantTimestampsMs.length >= policy.maxConcurrent) {
      this.totalDenied++;
      return {
        granted: false,
        reason: `policy_window_full (${this.grantTimestampsMs.length}/${policy.maxConcurrent} in last ${policy.windowMs}ms, regime=${regime})`,
        queueDepth: queueOrdered.length,
        waitMs
      };
    }

    // Grant!
    entry.granted = true;
    entry.grantedAtMs = now;
    this.grantTimestampsMs.push(now);
    this.totalGranted++;
    this.log(`granted pair=${pairId} regime=${regime} window_slots=${this.grantTimestampsMs.length}/${policy.maxConcurrent}`, { pairId, regime });
    return { granted: true, queueDepth: queueOrdered.length - 1, waitMs };
  }

  /** Called by runtime after close terminal state. Removes from queue. */
  releaseSlot(pairId: string): void {
    this.entries.delete(pairId);
  }

  /** Current queue depth (entries not yet granted). */
  queueDepth(nowMs?: number): number {
    return Array.from(this.entries.values()).filter((e) => !e.granted).length;
  }

  /** Longest wait among currently-queued entries. */
  longestWaitMs(nowMs?: number): number {
    const now = nowMs ?? Date.now();
    let max = 0;
    for (const e of this.entries.values()) {
      if (!e.granted) max = Math.max(max, now - e.requestedAtMs);
    }
    return max;
  }

  stats(nowMs?: number): {
    queueDepth: number;
    longestWaitMs: number;
    totalGranted: number;
    totalForceGranted: number;
    totalDenied: number;
    currentlyInWindow: number;
  } {
    const now = nowMs ?? Date.now();
    const policyMap = this.opts.policy ?? DEFAULT_REGIME_POLICY;
    const regime = this.opts.getCurrentRegime?.() ?? "calm";
    const policy = policyMap[regime] ?? DEFAULT_REGIME_POLICY.calm;
    const cutoff = now - policy.windowMs;
    const currentlyInWindow = this.grantTimestampsMs.filter((t) => t > cutoff).length;
    return {
      queueDepth: this.queueDepth(now),
      longestWaitMs: this.longestWaitMs(now),
      totalGranted: this.totalGranted,
      totalForceGranted: this.totalForceGranted,
      totalDenied: this.totalDenied,
      currentlyInWindow
    };
  }

  /** Reset state. Tests only. */
  reset(): void {
    this.entries.clear();
    this.grantTimestampsMs = [];
    this.totalGranted = 0;
    this.totalForceGranted = 0;
    this.totalDenied = 0;
  }

  private log(msg: string, meta?: Record<string, unknown>): void {
    const fn = this.opts.log ?? ((m, _meta) => console.log(`[unwindQueue] ${m}`, _meta ?? ""));
    fn(msg, meta);
  }
}

// ─── Singleton ─────────────────

let _instance: UnwindQueue | null = null;

export const getUnwindQueue = (opts?: UnwindQueueOpts): UnwindQueue => {
  if (!_instance) _instance = new UnwindQueue(opts);
  return _instance;
};

export const __resetUnwindQueueForTests = (): void => {
  if (_instance) _instance.reset();
  _instance = null;
};
