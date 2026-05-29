/**
 * Shadow auto-activator — signal-driven shadow pair opener.
 *
 * Purpose:
 *   Validates the full end-to-end activation lifecycle in production without
 *   any real-money risk. When the activation signal flips favorable AND the
 *   signal has been sustained for SUSTAINED_GOOD_SEC_REQUIRED seconds, this
 *   loop fires a shadow activation against an eligible cell, writing every
 *   decision (and skip) to two_sided_shadow_audit for visibility.
 *
 * Default state: OFF. Gated behind env flag SHADOW_AUTO_ACTIVATE=true.
 *
 * Gating logic (all must hold to activate):
 *   1. gate.good_to_activate === true                  (positive tier OR non-calm)
 *   2. NOT halted (foxify OR atticus)
 *   3. trends.consecutive_good_seconds ≥ SUSTAINED_GOOD_SEC_REQUIRED
 *   4. activations-in-current-good-window < MAX_PER_GOOD_WINDOW
 *   5. at least one recommended cell with triggerPct ≤ MAX_CELL_TRIGGER_PCT
 *      AND present in the current regime's effective allowlist
 *
 * Audit row written every tick regardless of decision, so the operator can
 * see exactly why no activation fired in any given window.
 */

import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { handleActivate, type ActivateDeps } from "./activateHandler";
import { computeActivationGate } from "./activationGate";
import { getEffectiveAllowlist } from "./cellAllowlist";
import { PHASE_0_CELLS } from "./cellConfig";
import type { DvolService } from "./dvolService";
import type { FeedService } from "./feedService";
import { computeConsecutiveGoodSeconds, recordGateSnapshot } from "./gateHistory";
import { getHaltState } from "./guardrails";
import type { LiquidChainCache } from "./liquidChainCache";
import type { LiveAnchorProvider } from "./quoteEngine";
import type { RvService } from "./rvService";
import { ShadowStrangleExecutor } from "./shadowExecutor";

// ─── Tunable constants (env-overridable) ───────────────────────────────────

const DEFAULT_POLL_MS = 60_000;
const DEFAULT_SUSTAINED_GOOD_SEC = 60;
const DEFAULT_MAX_PER_WINDOW = 3;
const DEFAULT_MAX_CELL_TRIGGER_PCT = 0.05;
const DEFAULT_MAX_COST_USDC = 100_000; // shadow doesn't risk capital, generous cap

export type AutoActivatorConfig = {
  enabled: boolean;
  pollMs: number;
  sustainedGoodSeconds: number;
  maxPerGoodWindow: number;
  maxCellTriggerPct: number;
  maxShadowCostUsdc: number;
};

export const readAutoActivatorConfig = (env: NodeJS.ProcessEnv = process.env): AutoActivatorConfig => ({
  enabled: env.SHADOW_AUTO_ACTIVATE === "true",
  pollMs: Number(env.SHADOW_AUTO_POLL_MS ?? DEFAULT_POLL_MS),
  sustainedGoodSeconds: Number(env.SHADOW_AUTO_SUSTAINED_SEC ?? DEFAULT_SUSTAINED_GOOD_SEC),
  maxPerGoodWindow: Number(env.SHADOW_AUTO_MAX_PER_WINDOW ?? DEFAULT_MAX_PER_WINDOW),
  maxCellTriggerPct: Number(env.SHADOW_AUTO_MAX_CELL_TRIGGER_PCT ?? DEFAULT_MAX_CELL_TRIGGER_PCT),
  maxShadowCostUsdc: Number(env.SHADOW_AUTO_MAX_COST_USDC ?? DEFAULT_MAX_COST_USDC)
});

// ─── DB schema ─────────────────────────────────────────────────────────────

export const ensureShadowAuditSchema = async (pool: Pool): Promise<void> => {
  // NOTE: two_sided_pair.pair_id is TEXT (not UUID) in the production schema.
  // Use TEXT for both audit_id and pair_id here to match, and to keep the
  // FK constraint valid. audit_id default uses gen_random_uuid()::text.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS two_sided_shadow_audit (
      audit_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      good_to_activate BOOLEAN NOT NULL,
      signal_tier TEXT NOT NULL,
      signal_score NUMERIC(8,4) NOT NULL,
      vrp NUMERIC(8,5),
      regime TEXT,
      dvol NUMERIC(8,3),
      consecutive_good_seconds NUMERIC,
      recommended_cells JSONB NOT NULL DEFAULT '[]'::jsonb,
      decision TEXT NOT NULL,
      chosen_cell_id TEXT,
      pair_id TEXT REFERENCES two_sided_pair(pair_id) ON DELETE SET NULL,
      details JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX IF NOT EXISTS idx_two_sided_shadow_audit_checked_at
      ON two_sided_shadow_audit(checked_at DESC);
    CREATE INDEX IF NOT EXISTS idx_two_sided_shadow_audit_pair_id
      ON two_sided_shadow_audit(pair_id) WHERE pair_id IS NOT NULL;
  `);
};

export type AuditRow = {
  audit_id: string;
  checked_at: string;
  good_to_activate: boolean;
  signal_tier: string;
  signal_score: number;
  vrp: number | null;
  regime: string | null;
  dvol: number | null;
  consecutive_good_seconds: number | null;
  recommended_cells: string[];
  decision: string;
  chosen_cell_id: string | null;
  pair_id: string | null;
  details: Record<string, unknown>;
};

// ─── Cell eligibility ──────────────────────────────────────────────────────

export const pickEligibleCell = (
  recommendedCells: ReadonlyArray<string>,
  regimeAllowlist: ReadonlyArray<string>,
  maxTriggerPct: number
): string | null => {
  for (const cellId of recommendedCells) {
    const cell = PHASE_0_CELLS[cellId];
    if (!cell || !cell.enabled) continue;
    if (cell.triggerPctDown > maxTriggerPct) continue;
    if (cell.triggerPctUp > maxTriggerPct) continue;
    if (regimeAllowlist.length > 0 && !regimeAllowlist.includes(cellId)) continue;
    return cellId;
  }
  return null;
};

// ─── Window-based rate limit ───────────────────────────────────────────────

export const countActivationsInCurrentWindow = async (
  pool: Pool,
  consecutiveGoodSeconds: number,
  nowMs: number = Date.now()
): Promise<number> => {
  // "Current good window" = from (now - consecutiveGoodSeconds) onward.
  // We count successful auto-activator activations in that window.
  const windowStartMs = nowMs - consecutiveGoodSeconds * 1000;
  const windowStartIso = new Date(windowStartMs).toISOString();
  const result = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM two_sided_shadow_audit
      WHERE checked_at >= $1
        AND decision = 'activated'`,
    [windowStartIso]
  );
  return result.rows[0]?.n ?? 0;
};

// ─── Audit row writer ──────────────────────────────────────────────────────

const insertAuditRow = async (
  pool: Pool,
  row: Omit<AuditRow, "audit_id" | "checked_at"> & { checkedAtIso?: string }
): Promise<string> => {
  const checkedAt = row.checkedAtIso ?? new Date().toISOString();
  const result = await pool.query<{ audit_id: string }>(
    `INSERT INTO two_sided_shadow_audit (
      checked_at, good_to_activate, signal_tier, signal_score,
      vrp, regime, dvol, consecutive_good_seconds,
      recommended_cells, decision, chosen_cell_id, pair_id, details
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13::jsonb)
    RETURNING audit_id`,
    [
      checkedAt,
      row.good_to_activate,
      row.signal_tier,
      row.signal_score,
      row.vrp,
      row.regime,
      row.dvol,
      row.consecutive_good_seconds,
      JSON.stringify(row.recommended_cells),
      row.decision,
      row.chosen_cell_id,
      row.pair_id,
      JSON.stringify(row.details)
    ]
  );
  return result.rows[0].audit_id;
};

// ─── Core tick (testable) ──────────────────────────────────────────────────

export type TickDeps = {
  pool: Pool;
  dvolService: DvolService;
  rvService: RvService;
  feedService: FeedService;
  liquidChainCache: LiquidChainCache | null;
  anchorProvider: LiveAnchorProvider;
  config: AutoActivatorConfig;
  /** Override for tests. */
  nowMs?: () => number;
  /** Override for tests: pre-built activate deps (without executor).
   *  Production builds these inline. */
  activateDepsOverride?: (executor: ShadowStrangleExecutor) => ActivateDeps;
};

export type TickResult = {
  audit_id: string;
  decision: string;
  pair_id: string | null;
  chosen_cell_id: string | null;
  signal_tier: string;
};

export const runAutoActivatorTick = async (deps: TickDeps): Promise<TickResult> => {
  const now = (deps.nowMs ?? Date.now)();
  const { pool, config } = deps;

  // 1. Compute gate (cell-agnostic global signal)
  const gate = await computeActivationGate({
    dvolService: deps.dvolService,
    rvService: deps.rvService,
    liquidChainCache: deps.liquidChainCache,
    nowMs: now
  });

  // Record snapshot so consecutive_good_seconds is accurate even when no
  // external poller is hitting /foxify/v2/should_activate.
  recordGateSnapshot({
    asOfMs: now,
    vrp: gate.vrp,
    goodToActivate: gate.good_to_activate,
    regime: gate.regime
  });
  const consecutiveGoodSeconds = computeConsecutiveGoodSeconds(now);

  // 2. Halt state
  const halt = await getHaltState(pool);
  const haltActive = halt.foxifyHalt || halt.atticusHalt;

  // 3. Decision tree
  const auditBase = {
    good_to_activate: gate.good_to_activate,
    signal_tier: gate.signal_tier,
    signal_score: gate.signal_score,
    vrp: gate.vrp,
    regime: gate.regime,
    dvol: gate.dvol,
    consecutive_good_seconds: consecutiveGoodSeconds,
    recommended_cells: gate.recommended_cells
  };

  if (haltActive) {
    const decision = `skipped:halt:${halt.atticusHalt ? "atticus" : "foxify"}`;
    const auditId = await insertAuditRow(pool, {
      ...auditBase,
      decision,
      chosen_cell_id: null,
      pair_id: null,
      details: {
        atticus_halt_reason: halt.atticusHaltReason,
        foxify_halt_reason: halt.foxifyHaltReason
      }
    });
    return { audit_id: auditId, decision, pair_id: null, chosen_cell_id: null, signal_tier: gate.signal_tier };
  }

  if (!gate.good_to_activate) {
    const decision = `skipped:not_good:${gate.signal_tier}`;
    const auditId = await insertAuditRow(pool, {
      ...auditBase,
      decision,
      chosen_cell_id: null,
      pair_id: null,
      details: { reason: gate.reason }
    });
    return { audit_id: auditId, decision, pair_id: null, chosen_cell_id: null, signal_tier: gate.signal_tier };
  }

  if (consecutiveGoodSeconds == null || consecutiveGoodSeconds < config.sustainedGoodSeconds) {
    const decision = "skipped:not_sustained";
    const auditId = await insertAuditRow(pool, {
      ...auditBase,
      decision,
      chosen_cell_id: null,
      pair_id: null,
      details: {
        sustained_required_s: config.sustainedGoodSeconds,
        sustained_actual_s: consecutiveGoodSeconds
      }
    });
    return { audit_id: auditId, decision, pair_id: null, chosen_cell_id: null, signal_tier: gate.signal_tier };
  }

  const recentCount = await countActivationsInCurrentWindow(pool, consecutiveGoodSeconds, now);
  if (recentCount >= config.maxPerGoodWindow) {
    const decision = "skipped:rate_limit";
    const auditId = await insertAuditRow(pool, {
      ...auditBase,
      decision,
      chosen_cell_id: null,
      pair_id: null,
      details: {
        recent_activations: recentCount,
        max_per_window: config.maxPerGoodWindow,
        window_seconds: consecutiveGoodSeconds
      }
    });
    return { audit_id: auditId, decision, pair_id: null, chosen_cell_id: null, signal_tier: gate.signal_tier };
  }

  // 4. Pick eligible cell
  const regime = gate.regime ?? "calm";
  const allowlist = await getEffectiveAllowlist(pool, regime);
  const chosenCell = pickEligibleCell(gate.recommended_cells, allowlist, config.maxCellTriggerPct);
  if (!chosenCell) {
    const decision = "skipped:no_eligible_cell";
    const auditId = await insertAuditRow(pool, {
      ...auditBase,
      decision,
      chosen_cell_id: null,
      pair_id: null,
      details: {
        recommended: gate.recommended_cells,
        allowlist,
        max_trigger_pct: config.maxCellTriggerPct
      }
    });
    return { audit_id: auditId, decision, pair_id: null, chosen_cell_id: null, signal_tier: gate.signal_tier };
  }

  // 5. Fire shadow activation
  const shadowExecutor = new ShadowStrangleExecutor();
  const activateDeps: ActivateDeps = deps.activateDepsOverride
    ? deps.activateDepsOverride(shadowExecutor)
    : {
        pool,
        anchorProvider: deps.anchorProvider,
        executor: shadowExecutor,
        getFeed: () => deps.feedService.getCurrentFeed(),
        feedVersion: "v1.0.0",
        nowMs: () => now,
        liquidChainCache: deps.liquidChainCache,
        getCurrentRegime: () => deps.dvolService.getCurrentDvol(now)?.regime ?? null
        // preActivateGuard intentionally omitted for shadow — guardrails enforce
        // capital limits etc. which don't apply to no-risk shadow activations.
      };

  const foxifyPairRef = `auto-shadow-${Date.now()}-${randomBytes(4).toString("hex")}`;
  try {
    const result = await handleActivate(
      {
        cellId: chosenCell,
        maxAcceptableHedgeCostUsdc: config.maxShadowCostUsdc,
        foxifyPairRef,
        isShadow: true,
        metadata: {
          source: "shadow_auto_activator",
          signal_tier: gate.signal_tier,
          signal_score: gate.signal_score,
          vrp: gate.vrp,
          regime: gate.regime,
          consecutive_good_seconds: consecutiveGoodSeconds
        }
      },
      activateDeps
    );

    if (result.status === 201) {
      const decision = "activated";
      const auditId = await insertAuditRow(pool, {
        ...auditBase,
        decision,
        chosen_cell_id: chosenCell,
        pair_id: result.body.pair_id,
        details: {
          foxify_pair_ref: foxifyPairRef,
          hedge_cost_usdc: result.body.total_hedge_cost_usdc,
          spot_at_activation: result.body.spot_at_activation,
          trigger_down: result.body.trigger_down_price,
          trigger_up: result.body.trigger_up_price,
          expires_at: result.body.expires_at
        }
      });
      return { audit_id: auditId, decision, pair_id: result.body.pair_id, chosen_cell_id: chosenCell, signal_tier: gate.signal_tier };
    }

    // Non-201: log structured failure
    const decision = `skipped:activate_failed:${result.status}`;
    const auditId = await insertAuditRow(pool, {
      ...auditBase,
      decision,
      chosen_cell_id: chosenCell,
      pair_id: null,
      details: {
        status: result.status,
        body: result.body
      }
    });
    return { audit_id: auditId, decision, pair_id: null, chosen_cell_id: chosenCell, signal_tier: gate.signal_tier };
  } catch (err) {
    const decision = "skipped:activate_error";
    const auditId = await insertAuditRow(pool, {
      ...auditBase,
      decision,
      chosen_cell_id: chosenCell,
      pair_id: null,
      details: {
        error: (err as Error).message?.slice(0, 500) ?? String(err)
      }
    });
    return { audit_id: auditId, decision, pair_id: null, chosen_cell_id: chosenCell, signal_tier: gate.signal_tier };
  }
};

// ─── Test-only force-fire helper ───────────────────────────────────────────

/**
 * Force-fire a shadow activation, bypassing the signal gate, sustained-good,
 * rate-limit, and regime-allowlist checks. Still respects:
 *   - cell exists + enabled + triggerPct ≤ maxCellTriggerPct
 *   - halt state (still skipped if Atticus halt is active)
 *
 * Writes an audit row with decision = "test_activated" or "test_skipped:<reason>"
 * so the entry is clearly distinguishable from automatic activations.
 *
 * Intended for operator use via POST /admin/foxify/v2/shadow-auto/test-activate
 * when the real signal won't fire (e.g. calm market) and the operator needs
 * to observe end-to-end shadow lifecycle behavior.
 */
export const forceShadowActivation = async (
  deps: TickDeps,
  opts: { cellId?: string; ignoreHalt?: boolean } = {}
): Promise<TickResult> => {
  const now = (deps.nowMs ?? Date.now)();
  const { pool, config } = deps;

  const gate = await computeActivationGate({
    dvolService: deps.dvolService,
    rvService: deps.rvService,
    liquidChainCache: deps.liquidChainCache,
    nowMs: now
  });

  const halt = await getHaltState(pool);
  const haltActive = halt.foxifyHalt || halt.atticusHalt;

  const auditBase = {
    good_to_activate: gate.good_to_activate,
    signal_tier: gate.signal_tier,
    signal_score: gate.signal_score,
    vrp: gate.vrp,
    regime: gate.regime,
    dvol: gate.dvol,
    consecutive_good_seconds: null as number | null,
    recommended_cells: gate.recommended_cells
  };

  if (haltActive && !opts.ignoreHalt) {
    const decision = `test_skipped:halt:${halt.atticusHalt ? "atticus" : "foxify"}`;
    const auditId = await insertAuditRow(pool, {
      ...auditBase,
      decision,
      chosen_cell_id: null,
      pair_id: null,
      details: {
        source: "test_activate",
        atticus_halt_reason: halt.atticusHaltReason,
        foxify_halt_reason: halt.foxifyHaltReason
      }
    });
    return { audit_id: auditId, decision, pair_id: null, chosen_cell_id: null, signal_tier: gate.signal_tier };
  }

  // Pick a cell: operator-specified OR first eligible from recommended OR first ≤5% enabled cell
  let chosenCell: string | null = opts.cellId ?? null;
  if (chosenCell) {
    const cell = PHASE_0_CELLS[chosenCell];
    if (!cell || !cell.enabled) {
      const decision = `test_skipped:invalid_cell:${chosenCell}`;
      const auditId = await insertAuditRow(pool, {
        ...auditBase,
        decision,
        chosen_cell_id: null,
        pair_id: null,
        details: { source: "test_activate", requested_cell: chosenCell, reason: cell ? "disabled" : "not_in_registry" }
      });
      return { audit_id: auditId, decision, pair_id: null, chosen_cell_id: null, signal_tier: gate.signal_tier };
    }
    if (cell.triggerPctDown > config.maxCellTriggerPct || cell.triggerPctUp > config.maxCellTriggerPct) {
      const decision = `test_skipped:trigger_too_wide:${chosenCell}`;
      const auditId = await insertAuditRow(pool, {
        ...auditBase,
        decision,
        chosen_cell_id: null,
        pair_id: null,
        details: { source: "test_activate", requested_cell: chosenCell, max_trigger_pct: config.maxCellTriggerPct, cell_trigger_pct: Math.max(cell.triggerPctDown, cell.triggerPctUp) }
      });
      return { audit_id: auditId, decision, pair_id: null, chosen_cell_id: null, signal_tier: gate.signal_tier };
    }
  } else {
    // Auto-pick order of preference:
    //   1. Highest-EV PROFITABLE cell from the current cell_opportunities list
    //      (real economic ranking — what a smart operator would actually fire)
    //   2. Fall back to gate.recommended_cells (global signal recommendations)
    //   3. Final fallback: first registered enabled cell ≤ maxTriggerPct
    try {
      const { computeCellOpportunities } = await import("./cellOpportunities");
      const { resolveCurrentTier } = await import("./tierResolver");
      const tier = await resolveCurrentTier(pool, now);
      const feed = deps.feedService.getCurrentFeed();
      if (feed && feed.canonicalPrice != null) {
        const opps = await computeCellOpportunities({
          spot: feed.canonicalPrice,
          regime: (gate.regime ?? "calm") as "calm" | "moderate" | "elevated" | "stress",
          anchorProvider: deps.anchorProvider,
          liquidChainCache: deps.liquidChainCache,
          tier,
          nowMs: now
        });
        // Already sorted by EV% DESC; take the first PROFITABLE or MARGINAL_PROFITABLE
        const best = opps.opportunities.find((o) =>
          o.verdict === "PROFITABLE" || o.verdict === "MARGINAL_PROFITABLE"
        );
        if (best) {
          const cell = PHASE_0_CELLS[best.cell_id];
          if (
            cell && cell.enabled &&
            cell.triggerPctDown <= config.maxCellTriggerPct &&
            cell.triggerPctUp <= config.maxCellTriggerPct
          ) {
            chosenCell = best.cell_id;
          }
        }
      }
    } catch {
      // Fall through to next strategy on any failure (opps not yet computed, etc.)
    }
    if (!chosenCell) {
      chosenCell = pickEligibleCell(gate.recommended_cells, [], config.maxCellTriggerPct);
    }
    if (!chosenCell) {
      // Final fallback — pick first registered enabled cell ≤ maxTriggerPct
      for (const [id, cell] of Object.entries(PHASE_0_CELLS)) {
        if (!cell.enabled) continue;
        if (cell.triggerPctDown > config.maxCellTriggerPct || cell.triggerPctUp > config.maxCellTriggerPct) continue;
        chosenCell = id;
        break;
      }
    }
    if (!chosenCell) {
      const decision = "test_skipped:no_eligible_cell";
      const auditId = await insertAuditRow(pool, {
        ...auditBase,
        decision,
        chosen_cell_id: null,
        pair_id: null,
        details: { source: "test_activate", max_trigger_pct: config.maxCellTriggerPct }
      });
      return { audit_id: auditId, decision, pair_id: null, chosen_cell_id: null, signal_tier: gate.signal_tier };
    }
  }

  // Fire shadow activation. Test path INTENTIONALLY omits getCurrentRegime
  // so the activate handler skips the regime-allowlist check — the whole
  // point of test-fire is to bypass signal-side gates including allowlist.
  const shadowExecutor = new ShadowStrangleExecutor();
  const activateDeps: ActivateDeps = deps.activateDepsOverride
    ? deps.activateDepsOverride(shadowExecutor)
    : {
        pool,
        anchorProvider: deps.anchorProvider,
        executor: shadowExecutor,
        getFeed: () => deps.feedService.getCurrentFeed(),
        feedVersion: "v1.0.0",
        nowMs: () => now,
        liquidChainCache: deps.liquidChainCache
        // getCurrentRegime intentionally omitted to bypass regime allowlist for test-fire
      };

  const foxifyPairRef = `test-shadow-${Date.now()}-${randomBytes(4).toString("hex")}`;
  try {
    const result = await handleActivate(
      {
        cellId: chosenCell,
        maxAcceptableHedgeCostUsdc: config.maxShadowCostUsdc,
        foxifyPairRef,
        isShadow: true,
        metadata: {
          source: "shadow_test_activate",
          signal_tier_at_test: gate.signal_tier,
          signal_score_at_test: gate.signal_score,
          vrp: gate.vrp,
          regime: gate.regime,
          bypassed_signal_gate: true,
          bypassed_regime_allowlist: true
        }
      },
      activateDeps
    );

    if (result.status === 201) {
      const decision = "test_activated";
      const auditId = await insertAuditRow(pool, {
        ...auditBase,
        decision,
        chosen_cell_id: chosenCell,
        pair_id: result.body.pair_id,
        details: {
          source: "test_activate",
          foxify_pair_ref: foxifyPairRef,
          hedge_cost_usdc: result.body.total_hedge_cost_usdc,
          spot_at_activation: result.body.spot_at_activation,
          trigger_down: result.body.trigger_down_price,
          trigger_up: result.body.trigger_up_price,
          expires_at: result.body.expires_at,
          bypassed_signal_gate: true
        }
      });
      return { audit_id: auditId, decision, pair_id: result.body.pair_id, chosen_cell_id: chosenCell, signal_tier: gate.signal_tier };
    }

    const decision = `test_skipped:activate_failed:${result.status}`;
    const auditId = await insertAuditRow(pool, {
      ...auditBase,
      decision,
      chosen_cell_id: chosenCell,
      pair_id: null,
      details: { source: "test_activate", status: result.status, body: result.body }
    });
    return { audit_id: auditId, decision, pair_id: null, chosen_cell_id: chosenCell, signal_tier: gate.signal_tier };
  } catch (err) {
    const decision = "test_skipped:activate_error";
    const auditId = await insertAuditRow(pool, {
      ...auditBase,
      decision,
      chosen_cell_id: chosenCell,
      pair_id: null,
      details: { source: "test_activate", error: (err as Error).message?.slice(0, 500) ?? String(err) }
    });
    return { audit_id: auditId, decision, pair_id: null, chosen_cell_id: chosenCell, signal_tier: gate.signal_tier };
  }
};

// ─── Long-running loop ─────────────────────────────────────────────────────

export class ShadowAutoActivator {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: TickDeps) {}

  start(): void {
    if (!this.deps.config.enabled) {
      console.log("[ShadowAutoActivator] DISABLED (SHADOW_AUTO_ACTIVATE != true). Use admin API to inspect; loop will not run.");
      return;
    }
    if (this.timer) return;
    console.log(
      `[ShadowAutoActivator] STARTED (poll=${this.deps.config.pollMs}ms, sustainedSec=${this.deps.config.sustainedGoodSeconds}, maxPerWindow=${this.deps.config.maxPerGoodWindow}, maxTriggerPct=${this.deps.config.maxCellTriggerPct})`
    );
    this.timer = setInterval(() => {
      void this.tickOnce();
    }, this.deps.config.pollMs);
    // Fire immediately on start (no need to wait the full pollMs)
    void this.tickOnce();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tickOnce(): Promise<void> {
    if (this.running) return; // re-entrancy guard
    this.running = true;
    try {
      const result = await runAutoActivatorTick(this.deps);
      if (result.decision === "activated") {
        console.log(`[ShadowAutoActivator] ✓ activated cell=${result.chosen_cell_id} pair=${result.pair_id}`);
      } else if (!result.decision.startsWith("skipped:not_good") && !result.decision.startsWith("skipped:not_sustained")) {
        // Log non-trivial skips (halt, rate-limit, errors); the quiet skips happen every poll and aren't useful in logs.
        console.log(`[ShadowAutoActivator] ${result.decision} (tier=${result.signal_tier})`);
      }
    } catch (err) {
      console.error(`[ShadowAutoActivator] tick FAILED: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

// ─── Status reader (for admin endpoint) ────────────────────────────────────

export type StatusSummary = {
  enabled: boolean;
  config: AutoActivatorConfig;
  last_check: AuditRow | null;
  last_activation: AuditRow | null;
  recent_audit: AuditRow[];
  totals: {
    last_24h: number;
    activations_last_24h: number;
    test_activations_last_24h?: number;
    auto_activations_last_24h?: number;
    activations_today_utc: number;
  };
};

const normalizeAuditRow = (row: Record<string, unknown>): AuditRow => ({
  audit_id: String(row.audit_id),
  checked_at: row.checked_at instanceof Date ? row.checked_at.toISOString() : String(row.checked_at),
  good_to_activate: Boolean(row.good_to_activate),
  signal_tier: String(row.signal_tier),
  signal_score: Number(row.signal_score),
  vrp: row.vrp == null ? null : Number(row.vrp),
  regime: row.regime == null ? null : String(row.regime),
  dvol: row.dvol == null ? null : Number(row.dvol),
  consecutive_good_seconds: row.consecutive_good_seconds == null ? null : Number(row.consecutive_good_seconds),
  recommended_cells: Array.isArray(row.recommended_cells) ? row.recommended_cells as string[] : [],
  decision: String(row.decision),
  chosen_cell_id: row.chosen_cell_id == null ? null : String(row.chosen_cell_id),
  pair_id: row.pair_id == null ? null : String(row.pair_id),
  details: typeof row.details === "object" && row.details !== null ? row.details as Record<string, unknown> : {}
});

export const readAutoActivatorStatus = async (
  pool: Pool,
  config: AutoActivatorConfig,
  limit: number = 20
): Promise<StatusSummary> => {
  const recent = await pool.query(
    `SELECT audit_id, checked_at, good_to_activate, signal_tier, signal_score,
            vrp, regime, dvol, consecutive_good_seconds,
            recommended_cells, decision, chosen_cell_id, pair_id, details
       FROM two_sided_shadow_audit
      ORDER BY checked_at DESC
      LIMIT $1`,
    [limit]
  );
  // Both 'activated' (auto-loop) and 'test_activated' (operator force-fire) count as activations.
  const lastActivationRes = await pool.query(
    `SELECT audit_id, checked_at, good_to_activate, signal_tier, signal_score,
            vrp, regime, dvol, consecutive_good_seconds,
            recommended_cells, decision, chosen_cell_id, pair_id, details
       FROM two_sided_shadow_audit
      WHERE decision IN ('activated', 'test_activated')
      ORDER BY checked_at DESC
      LIMIT 1`
  );
  const totalsRes = await pool.query<{
    last_24h: number;
    activations_last_24h: number;
    test_activations_last_24h: number;
    auto_activations_last_24h: number;
    activations_today_utc: number;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE checked_at >= NOW() - INTERVAL '24 hours')::int                                                   AS last_24h,
       COUNT(*) FILTER (WHERE checked_at >= NOW() - INTERVAL '24 hours' AND decision IN ('activated', 'test_activated'))::int   AS activations_last_24h,
       COUNT(*) FILTER (WHERE checked_at >= NOW() - INTERVAL '24 hours' AND decision = 'test_activated')::int                   AS test_activations_last_24h,
       COUNT(*) FILTER (WHERE checked_at >= NOW() - INTERVAL '24 hours' AND decision = 'activated')::int                        AS auto_activations_last_24h,
       COUNT(*) FILTER (WHERE checked_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AND decision IN ('activated', 'test_activated'))::int AS activations_today_utc
     FROM two_sided_shadow_audit`
  );
  const recentRows = recent.rows.map(normalizeAuditRow);
  return {
    enabled: config.enabled,
    config,
    last_check: recentRows[0] ?? null,
    last_activation: lastActivationRes.rows[0] ? normalizeAuditRow(lastActivationRes.rows[0]) : null,
    recent_audit: recentRows,
    totals: totalsRes.rows[0] ?? {
      last_24h: 0,
      activations_last_24h: 0,
      test_activations_last_24h: 0,
      auto_activations_last_24h: 0,
      activations_today_utc: 0
    }
  };
};
