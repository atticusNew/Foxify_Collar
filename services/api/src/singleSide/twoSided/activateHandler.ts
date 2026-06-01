/**
 * Activate handler — pure(ish) function called by the Fastify route.
 *
 * Separated from the Fastify plugin for unit-testability without HTTP plumbing.
 *
 * Flow (per TRIGGER_SOURCE_AND_FEED_SPEC.md §4):
 *   1. Validate input (cell_id known, foxify_pair_ref present, max_cost > 0).
 *   2. Idempotency check: if foxify_pair_ref already exists → 409 with existing record.
 *   3. Get canonical feed snapshot → spot_at_activation.
 *      If feed unavailable → 503 "feed_unavailable".
 *   4. Resolve current tier (per-activation lookup).
 *   5. Build quote via quoteEngine (pulls per-leg anchors, picks venues, depth check).
 *      If depth/no_venue → 503 with details.
 *   6. Check max_acceptable_hedge_cost_usdc cap.
 *      If exceeded → 422 "price_exceeded".
 *   7. Insert pair record with status=pending.
 *   8. Execute strangle via injected executor.
 *      If full fail → updatePairStatus(pending→cancelled) + 503.
 *   9. Insert pair_leg rows + updatePairStatus(pending→active).
 *   10. Return 201 with full pair payload.
 */

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { getCellOrThrow, PHASE_0_CELLS } from "./cellConfig";
import {
  getPairByFoxifyRef,
  insertPair,
  insertPairLeg,
  recordPairEvent,
  updatePairStatus
} from "./db";
import { buildQuote, type LiveAnchorProvider, type QuoteResult } from "./quoteEngine";
import { resolveCurrentTier } from "./tierResolver";
import type { StrangleExecutor } from "./executor";
import type { AggregatedFeed } from "./feedAggregator";
import { getMetrics, METRIC_NAMES } from "./metrics";

/**
 * Calm is a VALIDATED permanent stand-down (2026-05-31): no option structure is
 * profitable in calm — long (theta + friction beat appreciation) AND short premium
 * (iron-condor probe: negative EV that WORSENS with size, 0% profitable at 150k).
 * Activation in calm is therefore hard-disabled by default. Escape hatch for
 * deliberate research/loss-leader volume only: SS_TWO_SIDED_ALLOW_CALM=true.
 */
export const isCalmActivationAllowed = (): boolean =>
  String(process.env.SS_TWO_SIDED_ALLOW_CALM ?? "false").toLowerCase() === "true";

/**
 * Calm SHADOW activation is allowed by DEFAULT (separate from the LIVE block
 * above). Shadow fires risk no real money (gated by SS_TWO_SIDED_LIVE_ENABLED),
 * but they generate valuable close-stack + realized-vs-MC reconciliation data
 * while the market sits in calm (which is most of the time). Set
 * SS_TWO_SIDED_ALLOW_CALM_SHADOW=false to suppress even shadow calm fires.
 * NOTE: calm LIVE remains hard-disabled regardless of this flag.
 */
export const isCalmShadowAllowed = (): boolean =>
  String(process.env.SS_TWO_SIDED_ALLOW_CALM_SHADOW ?? "true").toLowerCase() === "true";

/**
 * Calm LOSS-LEADER mode (Phase 3). When enabled, calm activation is permitted —
 * but ONLY for cells whose premium (= the position's bounded max loss) is within
 * SS_TWO_SIDED_CALM_MAX_LOSS_USDC. This lets the CEO buy perp volume in calm at a
 * known, capped per-pair cost, while everything outside budget still stands down.
 * Independent of SS_TWO_SIDED_ALLOW_CALM (which is a blanket allow). Default off.
 */
export const isCalmLossLeaderEnabled = (): boolean =>
  String(process.env.SS_TWO_SIDED_CALM_LOSS_LEADER ?? "false").toLowerCase() === "true";

/** Per-pair max acceptable calm loss-leader cost (USDC). Default 25. */
export const calmMaxLossUsdc = (): number => {
  const v = Number(process.env.SS_TWO_SIDED_CALM_MAX_LOSS_USDC ?? "25");
  return Number.isFinite(v) && v >= 0 ? v : 25;
};

export type ActivateRequest = {
  cellId: string;
  maxAcceptableHedgeCostUsdc: number;
  foxifyPairRef: string;
  metadata?: Record<string, unknown>;
  /** If true, runs as a shadow trade (no real venue orders; uses ShadowStrangleExecutor).
   * The pair gets is_shadow=true and segregates from live metrics downstream. */
  isShadow?: boolean;
  /**
   * Explicit regime to STAMP onto the pair's regime_at_activation, independent of
   * deps.getCurrentRegime (which the shadow path omits to bypass allowlist
   * enforcement). Without this, shadow pairs settle UNTAGGED and the realized-vs-MC
   * gate (regime-filtered) can never see them. Shadow callers pass gate.regime here.
   * Does NOT trigger allowlist/calm enforcement (that's keyed on deps.getCurrentRegime).
   */
  regimeAtActivationOverride?: "calm" | "moderate" | "elevated" | "stress" | null;
};

export type ActivateResponse =
  | { status: 201; body: ActivatedPairPayload }
  | { status: 409; body: { error: "duplicate_foxify_pair_ref"; existing_pair_id: string; existing_status: string; existing_activated_at: string | null } }
  | { status: 422; body: { error: "price_exceeded"; message: string; live_quoted_cost_usdc: number; max_acceptable_usdc: number; feed_snapshot: Record<string, unknown> } }
  | { status: 503; body: { error: string; message: string; retry_after_s?: number; halt_reason_code?: string | null; details?: Record<string, unknown> } }
  | { status: 400; body: { error: "invalid_request"; message: string; details?: Record<string, unknown> } };

export type ActivatedPairPayload = {
  pair_id: string;
  status: "active";
  cell_id: string;
  foxify_pair_ref: string;
  activated_at: string;
  spot_at_activation: number;
  feed_version: string;
  put_strike: number;
  call_strike: number;
  contracts_btc: number;
  put_leg: { venue: string; symbol: string; ask_filled_usdc_per_btc: number; contracts_btc: number; leg_cost_usdc: number; filled_at: string };
  call_leg: { venue: string; symbol: string; ask_filled_usdc_per_btc: number; contracts_btc: number; leg_cost_usdc: number; filled_at: string };
  total_hedge_cost_usdc: number;
  trigger_down_price: number;
  trigger_up_price: number;
  tier_at_activation: string;
  atticus_split_pct: number;
  atticus_floor_usdc: number;
  foxify_split_pct: number;
  hedge_tenor_days: number;
  expires_at: string;
  tp_force_exit_at: string;
};

export type ActivateDeps = {
  pool: Pool;
  anchorProvider: LiveAnchorProvider;
  executor: StrangleExecutor;
  getFeed: () => AggregatedFeed | null;
  feedVersion?: string;
  nowMs?: () => number;
  /**
   * Optional liquid-strike chain cache. When provided, buildQuote refines
   * target strikes to nearest liquid Deribit strike (within ±$3k, preserving
   * moneyness side). Fixes the V3 illiquid-strike cost over-estimate.
   * Tests omit this; production wires it.
   */
  liquidChainCache?: import("./liquidChainCache").LiquidChainCache | null;
  /** Optional PR 9 hook — if injected, blocks activation when canActivate returns ok=false.
   * Tests can omit this. Production wires to the real guardrails module. */
  preActivateGuard?: (ctx: { pairHedgeCostUsdc: number; spot: number; isShadow: boolean }) => Promise<{ ok: boolean; reason?: string; details?: Record<string, unknown> }>;
  /** Optional PR C3: returns current regime for cell-allowlist enforcement. Tests can omit. */
  getCurrentRegime?: () => "calm" | "moderate" | "elevated" | "stress" | null;
};

const isValidRequest = (req: unknown): req is ActivateRequest => {
  if (typeof req !== "object" || req === null) return false;
  const r = req as Record<string, unknown>;
  return (
    typeof r.cellId === "string" &&
    typeof r.foxifyPairRef === "string" &&
    typeof r.maxAcceptableHedgeCostUsdc === "number" &&
    r.maxAcceptableHedgeCostUsdc > 0
  );
};

const TP_FORCE_BUFFER_MS = 4 * 3_600_000; // expiry - 4h

export const handleActivate = async (req: unknown, deps: ActivateDeps): Promise<ActivateResponse> => {
  if (!isValidRequest(req)) {
    return {
      status: 400,
      body: {
        error: "invalid_request",
        message: "Body must include cellId (string), foxifyPairRef (string), maxAcceptableHedgeCostUsdc (positive number)."
      }
    };
  }

  const now = deps.nowMs ? deps.nowMs() : Date.now();
  const feedVersion = deps.feedVersion ?? "v1.0.0";

  if (!PHASE_0_CELLS[req.cellId]?.enabled) {
    return {
      status: 400,
      body: { error: "invalid_request", message: `Unknown or disabled cell: ${req.cellId}` }
    };
  }
  const cell = getCellOrThrow(req.cellId);

  // 1.5: Regime-cell allowlist check (PR C3)
  // Only applies when DvolService has a current regime — otherwise skip silently
  // (legacy compat for tests that don't wire DvolService).
  // We resolve regime from the feed snapshot below.

  // 2. Idempotency
  const existing = await getPairByFoxifyRef(deps.pool, req.foxifyPairRef);
  if (existing) {
    getMetrics().incrementCounter(METRIC_NAMES.ACTIVATIONS_BLOCKED_TOTAL, { reason: "duplicate_ref" });
    return {
      status: 409,
      body: {
        error: "duplicate_foxify_pair_ref",
        existing_pair_id: existing.pairId,
        existing_status: existing.status,
        existing_activated_at: existing.createdAt
      }
    };
  }

  // 3. Feed snapshot
  const feed = deps.getFeed();
  if (!feed || feed.canonicalPrice == null) {
    return {
      status: 503,
      body: {
        error: "feed_unavailable",
        message: "Canonical feed has no current price; cannot activate.",
        retry_after_s: 5,
        halt_reason_code: feed?.health === "degraded" ? "feed_degraded" : "feed_unavailable"
      }
    };
  }
  const spot = feed.canonicalPrice;

  // 3.5: Regime-cell allowlist enforcement (PR C3)
  // Determine current regime from DVOL (if available via injected callback). Hoisted
  // so the calm loss-leader budget check (post-quote) can reuse it.
  const currentRegime = deps.getCurrentRegime ? deps.getCurrentRegime() : null;
  if (currentRegime) {
    const regime = currentRegime;
    // CALM gate: hard-disabled UNLESS blanket-allow (SS_TWO_SIDED_ALLOW_CALM) OR
    // loss-leader mode (SS_TWO_SIDED_CALM_LOSS_LEADER). Checked BEFORE the allowlist
    // so a DB override can't silently re-enable calm. In loss-leader mode the
    // per-pair budget is still enforced after the quote (below).
    if (regime === "calm" && !isCalmActivationAllowed() && !isCalmLossLeaderEnabled()) {
      getMetrics().incrementCounter(METRIC_NAMES.ACTIVATIONS_BLOCKED_TOTAL, { reason: "calm_regime_disabled" });
      return {
        status: 503,
        body: {
          error: "calm_regime_disabled",
          message: "Activation is hard-disabled in calm regime (validated permanent stand-down). Set SS_TWO_SIDED_ALLOW_CALM=true (blanket) or SS_TWO_SIDED_CALM_LOSS_LEADER=true (budgeted) to enable.",
          retry_after_s: 0,
          details: { regime, cell_id: cell.cellId }
        }
      };
    }
    if (regime) {
      const { isCellAllowedInRegime } = await import("./cellAllowlist");
      const check = await isCellAllowedInRegime(deps.pool, cell.cellId, regime);
      if (!check.allowed) {
        return {
          status: 503,
          body: {
            error: "cell_disabled_in_regime",
            message: `Cell '${cell.cellId}' is not enabled in '${regime}' regime. Try a suggested cell.`,
            retry_after_s: 0,
            details: {
              regime,
              cell_id: cell.cellId,
              suggested_cells: check.suggestedCells
            }
          }
        };
      }
    }
  }

  // 4. Tier
  const tier = await resolveCurrentTier(deps.pool, now);

  // 5. Quote — ALWAYS fresh for actual activation. The operator-visibility
  // endpoints (gate_with_ev, cell-costs) intentionally use the stability cache
  // for stable display. The activation path should ALWAYS quote live.
  const quote: QuoteResult = await buildQuote({
    cell,
    spot,
    anchorProvider: deps.anchorProvider,
    tier,
    nowMs: now,
    liquidChainCache: deps.liquidChainCache ?? null,
    useStabilityCache: false
  });
  if (!quote.ok) {
    return {
      status: 503,
      body: {
        error: quote.reason.startsWith("depth_") ? "depth_insufficient" : "venue_unavailable",
        message: `Quote failed: ${quote.reason}`,
        retry_after_s: 30,
        details: quote.details
      }
    };
  }

  // 5.4 CALM LOSS-LEADER BUDGET (Phase 3). In calm loss-leader mode (and not blanket
  // allow), the position's premium = its bounded max loss; reject if it exceeds the
  // per-pair budget. This makes calm a CAPPED volume cost, not open-ended bleed.
  if (currentRegime === "calm" && isCalmLossLeaderEnabled() && !isCalmActivationAllowed()) {
    const budget = calmMaxLossUsdc();
    if (quote.totalHedgeCostUsdc > budget) {
      getMetrics().incrementCounter(METRIC_NAMES.ACTIVATIONS_BLOCKED_TOTAL, { reason: "calm_loss_exceeds_budget" });
      return {
        status: 503,
        body: {
          error: "calm_loss_exceeds_budget",
          message: `Calm loss-leader: premium ${quote.totalHedgeCostUsdc.toFixed(2)} exceeds per-pair budget ${budget.toFixed(2)} (SS_TWO_SIDED_CALM_MAX_LOSS_USDC). Use a cheaper cell or raise the budget.`,
          retry_after_s: 0,
          details: { regime: currentRegime, cell_id: cell.cellId, premium_usdc: +quote.totalHedgeCostUsdc.toFixed(2), budget_usdc: budget }
        }
      };
    }
  }

  // 5.5 PR 9 guardrails gate (DVOL/capital pool/halts) — after quote so we know cost
  if (deps.preActivateGuard) {
    const guard = await deps.preActivateGuard({
      pairHedgeCostUsdc: quote.totalHedgeCostUsdc,
      spot,
      isShadow: req.isShadow ?? false
    });
    if (!guard.ok) {
      return {
        status: 503,
        body: {
          error: "atticus_halt",
          message: `Activation blocked by guardrail: ${guard.reason ?? "unknown"}`,
          retry_after_s: 60,
          halt_reason_code: guard.reason ?? null,
          details: guard.details
        }
      };
    }
  }

  // 6. Price cap
  if (quote.totalHedgeCostUsdc > req.maxAcceptableHedgeCostUsdc) {
    return {
      status: 422,
      body: {
        error: "price_exceeded",
        message: "Live hedge cost exceeds max_acceptable_hedge_cost_usdc.",
        live_quoted_cost_usdc: quote.totalHedgeCostUsdc,
        max_acceptable_usdc: req.maxAcceptableHedgeCostUsdc,
        feed_snapshot: { canonical_price: spot, as_of_ms: feed.asOfMs, health: feed.health }
      }
    };
  }

  // 7. Insert pending pair
  const pairId = randomUUID();
  const expiresAtMs = now + cell.hedgeTenorDays * 86_400_000;
  const pair = await insertPair(deps.pool, {
    pairId,
    cellId: cell.cellId,
    foxifyPairRef: req.foxifyPairRef,
    isShadow: req.isShadow ?? false,
    spotAtActivation: spot,
    feedSnapshotAtActivation: {
      feed_version: feedVersion,
      canonical_price: spot,
      as_of_ms: feed.asOfMs,
      health: feed.health,
      sources: feed.sources.map((s) => ({ source: s.source, price: s.price, ts: s.ts }))
    },
    triggerDownPrice: quote.triggerDownPrice,
    triggerUpPrice: quote.triggerUpPrice,
    hedgeTenorDays: cell.hedgeTenorDays,
    expiresAt: new Date(expiresAtMs).toISOString(),
    tpForceExitAt: new Date(expiresAtMs - TP_FORCE_BUFFER_MS).toISOString(),
    hedgeCostTotalUsdc: quote.totalHedgeCostUsdc,
    foxifyCapitalFundedUsdc: quote.totalHedgeCostUsdc,
    tierAtActivation: tier.label,
    atticusFloorUsdc: tier.atticusFloorUsdc,
    metadata: req.metadata ?? {},
    // Tag regime: explicit override (shadow path) wins, else the live getCurrentRegime.
    regimeAtActivation: req.regimeAtActivationOverride ?? (deps.getCurrentRegime ? deps.getCurrentRegime() : null),
    status: "pending"
  });

  // Record counterparty ledger: Foxify funded the hedge (PR C6)
  try {
    const { recordActivateEntries } = await import("./counterpartyLedger");
    await recordActivateEntries(deps.pool, pair.pairId, quote.totalHedgeCostUsdc);
  } catch (e) {
    // Ledger failure should not block activation — pool may not have schema yet (tests)
  }

  // 8. Execute strangle
  const execResult = await deps.executor.executeStrangle({
    pairId: pair.pairId,
    putLeg: {
      venue: quote.putLeg.venue,
      symbol: quote.putLeg.symbol,
      strikeUsdc: quote.putStrike,
      contractsBtc: quote.contractsBtc,
      maxAcceptableAskUsdcPerBtc: quote.putLeg.askUsdcPerBtc,
      legRole: "long_put"
    },
    callLeg: {
      venue: quote.callLeg.venue,
      symbol: quote.callLeg.symbol,
      strikeUsdc: quote.callStrike,
      contractsBtc: quote.contractsBtc,
      maxAcceptableAskUsdcPerBtc: quote.callLeg.askUsdcPerBtc,
      legRole: "long_call"
    }
  });

  if (!execResult.ok) {
    // Mark cancelled, emit event, return 503
    await updatePairStatus(deps.pool, pair.pairId, "cancelled");
    await recordPairEvent(deps.pool, {
      pairId: pair.pairId,
      kind: "cancelled",
      details: { reason: execResult.reason, put_leg_result: execResult.putLegResult, call_leg_result: execResult.callLegResult }
    });
    return {
      status: 503,
      body: {
        error: "execution_failed",
        message: `Strangle execution failed: ${execResult.reason}`,
        retry_after_s: 30,
        details: { reason: execResult.reason }
      }
    };
  }

  // 9. Insert legs + transition to active
  await insertPairLeg(deps.pool, {
    legId: randomUUID(),
    pairId: pair.pairId,
    legRole: "long_put",
    venue: quote.putLeg.venue,
    symbol: quote.putLeg.symbol,
    strikeUsdc: quote.putStrike,
    contractsBtc: quote.contractsBtc,
    buyAskUsdcPerBtc: execResult.putLeg.filledAskUsdcPerBtc,
    buyCostUsdc: execResult.putLeg.filledAskUsdcPerBtc * quote.contractsBtc,
    buyFilledAt: execResult.putLeg.filledAtIso,
    liveAnchorAskUsdcPerBtc: quote.putLeg.askUsdcPerBtc,
    liveAnchorPulledAt: quote.putLeg.pulledAt,
    metadata: { quote_id: quote.quoteId }
  });
  await insertPairLeg(deps.pool, {
    legId: randomUUID(),
    pairId: pair.pairId,
    legRole: "long_call",
    venue: quote.callLeg.venue,
    symbol: quote.callLeg.symbol,
    strikeUsdc: quote.callStrike,
    contractsBtc: quote.contractsBtc,
    buyAskUsdcPerBtc: execResult.callLeg.filledAskUsdcPerBtc,
    buyCostUsdc: execResult.callLeg.filledAskUsdcPerBtc * quote.contractsBtc,
    buyFilledAt: execResult.callLeg.filledAtIso,
    liveAnchorAskUsdcPerBtc: quote.callLeg.askUsdcPerBtc,
    liveAnchorPulledAt: quote.callLeg.pulledAt,
    metadata: { quote_id: quote.quoteId }
  });

  await updatePairStatus(deps.pool, pair.pairId, "active");
  await recordPairEvent(deps.pool, {
    pairId: pair.pairId,
    kind: "activated",
    details: {
      spot,
      total_hedge_cost: quote.totalHedgeCostUsdc,
      put_fill: execResult.putLeg.filledAskUsdcPerBtc,
      call_fill: execResult.callLeg.filledAskUsdcPerBtc,
      tier: tier.label
    }
  });

  // 10. Build 201 payload
  const actualPutCost = execResult.putLeg.filledAskUsdcPerBtc * quote.contractsBtc;
  const actualCallCost = execResult.callLeg.filledAskUsdcPerBtc * quote.contractsBtc;
  const actualTotalCost = actualPutCost + actualCallCost;
  const m = getMetrics();
  m.incrementCounter(METRIC_NAMES.PAIRS_ACTIVATED_TOTAL, { cell_id: cell.cellId, tier: tier.label });
  m.incrementGauge(METRIC_NAMES.ACTIVE_PAIRS, { cell_id: cell.cellId });
  m.observeHistogram(METRIC_NAMES.ACTIVATE_LATENCY_MS, Date.now() - now, { cell_id: cell.cellId });

  // Foxify ACTIVATION-time signal (fire-and-forget; retries in background; no-op
  // if no webhook configured). MUST never block or fail the 201 activation.
  try {
    const { deliverPairActivated } = await import("./webhookDelivery");
    void deliverPairActivated(deps.pool, {
      pair_id: pair.pairId,
      foxify_pair_ref: req.foxifyPairRef,
      cell_id: cell.cellId,
      activated_at: new Date(now).toISOString(),
      spot_at_activation: spot,
      put_strike: quote.putStrike,
      call_strike: quote.callStrike,
      contracts_btc: quote.contractsBtc,
      total_hedge_cost_usdc: actualTotalCost,
      trigger_down_price: quote.triggerDownPrice,
      trigger_up_price: quote.triggerUpPrice,
      tier_at_activation: tier.label,
      hedge_tenor_days: cell.hedgeTenorDays,
      expires_at: pair.expiresAt,
      is_shadow: req.isShadow ?? false
    }).catch(() => { /* delivery logs + retries internally; never block activation */ });
  } catch { /* webhook module optional — never block activation */ }

  return {
    status: 201,
    body: {
      pair_id: pair.pairId,
      status: "active",
      cell_id: cell.cellId,
      foxify_pair_ref: req.foxifyPairRef,
      activated_at: new Date(now).toISOString(),
      spot_at_activation: spot,
      feed_version: feedVersion,
      put_strike: quote.putStrike,
      call_strike: quote.callStrike,
      contracts_btc: quote.contractsBtc,
      put_leg: {
        venue: quote.putLeg.venue,
        symbol: quote.putLeg.symbol,
        ask_filled_usdc_per_btc: execResult.putLeg.filledAskUsdcPerBtc,
        contracts_btc: quote.contractsBtc,
        leg_cost_usdc: actualPutCost,
        filled_at: execResult.putLeg.filledAtIso
      },
      call_leg: {
        venue: quote.callLeg.venue,
        symbol: quote.callLeg.symbol,
        ask_filled_usdc_per_btc: execResult.callLeg.filledAskUsdcPerBtc,
        contracts_btc: quote.contractsBtc,
        leg_cost_usdc: actualCallCost,
        filled_at: execResult.callLeg.filledAtIso
      },
      total_hedge_cost_usdc: actualTotalCost,
      trigger_down_price: quote.triggerDownPrice,
      trigger_up_price: quote.triggerUpPrice,
      tier_at_activation: tier.label,
      atticus_split_pct: tier.atticusPct,
      atticus_floor_usdc: tier.atticusFloorUsdc,
      foxify_split_pct: tier.foxifyPct,
      hedge_tenor_days: cell.hedgeTenorDays,
      expires_at: pair.expiresAt,
      tp_force_exit_at: pair.tpForceExitAt
    }
  };
};
