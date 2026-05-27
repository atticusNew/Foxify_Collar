/**
 * Type definitions for the two-sided cooperative volume facility.
 *
 * Pair = Foxify activation (long perp + short perp on partner exchange)
 *        hedged by an Atticus strangle (long put + long call).
 *
 * State machine:
 *
 *   pending  →  active            (both legs filled)
 *   active   →  triggered         (canonical-feed crossed ±2% boundary)
 *   active   →  unwinding         (Foxify early-close OR expiry-4h)
 *   triggered → unwinding         (theta-aware TP fires)
 *   unwinding → settled           (all legs closed, salvage + split recorded)
 *
 * Terminal: settled. Cancelled is a separate terminal for legs that never fully fill.
 */

export type PairStatus =
  | "pending"
  | "active"
  | "triggered"
  | "unwinding"
  | "settled"
  | "cancelled";

export type TriggerSide = "down" | "up";

export type CloseReason = "trigger" | "foxify_close" | "expiry" | "atticus_halt";

export type LegRole = "long_put" | "long_call";

export type Venue = "bullish" | "deribit";

export type ExitMode =
  | "capture_window_peak"
  | "trail_retrace"
  | "hard_floor"
  | "force_expiry"
  | "foxify_close"
  | "no_trigger_expiry";

export type PairEventKind =
  | "activated"
  | "trigger_detected"
  | "unwinding_started"
  | "settled"
  | "foxify_closed"
  | "atticus_halt"
  | "execution_stuck"
  | "leg_fill_partial"
  | "leg_fill_complete"
  | "cancelled";

// ─── Tier configuration (PLAN.md §3) ───

export type TierLabel = "tier_1" | "tier_2" | "tier_3" | "tier_4" | "tier_5";

export type TierDefinition = {
  label: TierLabel;
  minPairsPerDay: number;        // inclusive
  maxPairsPerDay: number | null; // exclusive; null = open-ended
  atticusPct: number;            // 0.15 = 15%
  foxifyPct: number;             // 0.85 = 85%
  atticusFloorUsdc: number;      // per-pair $ floor when uplift > 0
};

export const TIERS: ReadonlyArray<TierDefinition> = [
  { label: "tier_1", minPairsPerDay: 0,    maxPairsPerDay: 25,   atticusPct: 0.15, foxifyPct: 0.85, atticusFloorUsdc: 25 },
  { label: "tier_2", minPairsPerDay: 25,   maxPairsPerDay: 100,  atticusPct: 0.13, foxifyPct: 0.87, atticusFloorUsdc: 30 },
  { label: "tier_3", minPairsPerDay: 100,  maxPairsPerDay: 250,  atticusPct: 0.11, foxifyPct: 0.89, atticusFloorUsdc: 35 },
  { label: "tier_4", minPairsPerDay: 250,  maxPairsPerDay: 500,  atticusPct: 0.09, foxifyPct: 0.91, atticusFloorUsdc: 40 },
  { label: "tier_5", minPairsPerDay: 500,  maxPairsPerDay: null, atticusPct: 0.08, foxifyPct: 0.92, atticusFloorUsdc: 45 }
];

// ─── Pair record (row in `pair` table) ───

export type PairRecord = {
  pairId: string;
  cellId: string;
  status: PairStatus;
  foxifyPairRef: string;                     // idempotency key from Foxify
  spotAtActivation: number;
  feedSnapshotAtActivation: Record<string, unknown>;
  triggerDownPrice: number;
  triggerUpPrice: number;
  hedgeTenorDays: number;
  expiresAt: string;                          // ISO
  tpForceExitAt: string;                      // ISO = expiresAt - 4h
  hedgeCostTotalUsdc: number;
  foxifyCapitalFundedUsdc: number;
  tierAtActivation: TierLabel;
  atticusFloorUsdc: number;
  triggeredAt: string | null;
  triggerSide: TriggerSide | null;
  triggerFeedSnapshot: Record<string, unknown> | null;
  closedAt: string | null;
  closedReason: CloseReason | null;
  salvageProceedsUsdc: number | null;
  upliftUsdc: number | null;
  foxifyShareUsdc: number | null;
  atticusShareUsdc: number | null;
  exitMode: ExitMode | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

// ─── Pair leg record (row in `pair_leg` table) ───

export type PairLegRecord = {
  legId: string;
  pairId: string;
  legRole: LegRole;
  venue: Venue;
  symbol: string;
  strikeUsdc: number;
  contractsBtc: number;
  buyAskUsdcPerBtc: number;            // live anchor / fill ask
  buyCostUsdc: number;
  buyFilledAt: string | null;
  sellAskUsdcPerBtc: number | null;
  sellProceedsUsdc: number | null;
  sellFilledAt: string | null;
  liveAnchorAskUsdcPerBtc: number;     // audit: the anchor used at activation
  liveAnchorPulledAt: string;
  metadata: Record<string, unknown>;
};

// ─── Pair event record (row in `pair_event` table) ───

export type PairEventRecord = {
  eventId: string;
  pairId: string;
  occurredAt: string;
  kind: PairEventKind;
  details: Record<string, unknown>;
};
