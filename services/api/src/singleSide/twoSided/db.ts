/**
 * Two-sided cooperative volume facility — database schema + CRUD.
 *
 * Three additive tables:
 *
 *   two_sided_pair        — Foxify activations (one per pair)
 *   two_sided_pair_leg    — one row per option leg (long_put + long_call)
 *   two_sided_pair_event  — append-only event log for audit + Foxify drill-in
 *
 * All schema operations are idempotent (CREATE TABLE IF NOT EXISTS). Safe to
 * run on every boot. No destructive migrations.
 *
 * Indexes wrapped in try/catch for pg-mem compatibility (pilot pattern).
 *
 * NOTE: This file does NOT modify any tables under volume_cover_*. The two_sided_*
 * tables are entirely separate. Live VC continues to operate uninterrupted.
 */

import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { assertValidTransition } from "./stateMachine";
import type {
  CloseReason,
  ExitMode,
  PairEventKind,
  PairEventRecord,
  PairLegRecord,
  PairRecord,
  PairStatus,
  TierLabel,
  TriggerSide
} from "./types";

export type DbExecutor = Pool | PoolClient;

// ────────────────────── Schema ──────────────────────

export const ensureTwoSidedSchema = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS two_sided_pair (
      pair_id                              TEXT PRIMARY KEY,
      cell_id                              TEXT NOT NULL,
      status                               TEXT NOT NULL DEFAULT 'pending',
      foxify_pair_ref                      TEXT NOT NULL UNIQUE,

      spot_at_activation                   NUMERIC(20, 8) NOT NULL,
      feed_snapshot_at_activation          JSONB NOT NULL DEFAULT '{}'::jsonb,
      trigger_down_price                   NUMERIC(20, 8) NOT NULL,
      trigger_up_price                     NUMERIC(20, 8) NOT NULL,
      hedge_tenor_days                     NUMERIC(10, 4) NOT NULL,
      expires_at                           TIMESTAMPTZ NOT NULL,
      tp_force_exit_at                     TIMESTAMPTZ NOT NULL,

      hedge_cost_total_usdc                NUMERIC(20, 8) NOT NULL,
      foxify_capital_funded_usdc           NUMERIC(20, 8) NOT NULL,
      tier_at_activation                   TEXT NOT NULL,
      atticus_floor_usdc                   NUMERIC(20, 8) NOT NULL,

      triggered_at                         TIMESTAMPTZ,
      trigger_side                         TEXT,
      trigger_feed_snapshot                JSONB,

      closed_at                            TIMESTAMPTZ,
      closed_reason                        TEXT,
      salvage_proceeds_usdc                NUMERIC(20, 8),
      uplift_usdc                          NUMERIC(20, 8),
      foxify_share_usdc                    NUMERIC(20, 8),
      atticus_share_usdc                   NUMERIC(20, 8),
      exit_mode                            TEXT,

      is_shadow                            BOOLEAN NOT NULL DEFAULT FALSE,
      metadata                             JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at                           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at                           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT two_sided_pair_status_check
        CHECK (status IN ('pending', 'active', 'triggered', 'unwinding', 'settled', 'cancelled')),
      CONSTRAINT two_sided_pair_trigger_side_check
        CHECK (trigger_side IS NULL OR trigger_side IN ('down', 'up')),
      CONSTRAINT two_sided_pair_closed_reason_check
        CHECK (closed_reason IS NULL OR closed_reason IN ('trigger', 'foxify_close', 'expiry', 'atticus_halt')),
      CONSTRAINT two_sided_pair_tier_check
        CHECK (tier_at_activation IN ('tier_1', 'tier_2', 'tier_3', 'tier_4', 'tier_5')),
      CONSTRAINT two_sided_pair_exit_mode_check
        CHECK (exit_mode IS NULL OR exit_mode IN ('capture_window_peak', 'trail_retrace', 'hard_floor', 'force_expiry', 'foxify_close', 'no_trigger_expiry'))
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS two_sided_pair_leg (
      leg_id                                TEXT PRIMARY KEY,
      pair_id                               TEXT NOT NULL REFERENCES two_sided_pair(pair_id),
      leg_role                              TEXT NOT NULL,
      venue                                 TEXT NOT NULL,
      symbol                                TEXT NOT NULL,
      strike_usdc                           NUMERIC(20, 8) NOT NULL,
      contracts_btc                         NUMERIC(20, 8) NOT NULL,

      buy_ask_usdc_per_btc                  NUMERIC(20, 8) NOT NULL,
      buy_cost_usdc                         NUMERIC(20, 8) NOT NULL,
      buy_filled_at                         TIMESTAMPTZ,

      sell_ask_usdc_per_btc                 NUMERIC(20, 8),
      sell_proceeds_usdc                    NUMERIC(20, 8),
      sell_filled_at                        TIMESTAMPTZ,

      live_anchor_ask_usdc_per_btc          NUMERIC(20, 8) NOT NULL,
      live_anchor_pulled_at                 TIMESTAMPTZ NOT NULL,

      metadata                              JSONB NOT NULL DEFAULT '{}'::jsonb,

      CONSTRAINT two_sided_pair_leg_role_check
        CHECK (leg_role IN ('long_put', 'long_call')),
      CONSTRAINT two_sided_pair_leg_venue_check
        CHECK (venue IN ('bullish', 'deribit'))
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS two_sided_pair_event (
      event_id      TEXT PRIMARY KEY,
      pair_id       TEXT NOT NULL REFERENCES two_sided_pair(pair_id),
      occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      kind          TEXT NOT NULL,
      details       JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);

  // Indexes — wrapped in try/catch for pg-mem compat
  const safeIndex = async (sql: string) => {
    try {
      await pool.query(sql);
    } catch {
      /* pg-mem may not support all index syntax — production Postgres does */
    }
  };
  // Idempotent column addition for existing databases (production Postgres only — pg-mem ignores via safeIndex catch).
  await safeIndex(`ALTER TABLE two_sided_pair ADD COLUMN IF NOT EXISTS is_shadow BOOLEAN NOT NULL DEFAULT FALSE;`);
  await safeIndex(`ALTER TABLE two_sided_pair ADD COLUMN IF NOT EXISTS regime_at_activation TEXT;`);
  await safeIndex(`CREATE INDEX IF NOT EXISTS two_sided_pair_regime_idx ON two_sided_pair(regime_at_activation);`);
  await safeIndex(`CREATE INDEX IF NOT EXISTS two_sided_pair_status_idx ON two_sided_pair(status);`);
  await safeIndex(`CREATE INDEX IF NOT EXISTS two_sided_pair_is_shadow_idx ON two_sided_pair(is_shadow);`);
  await safeIndex(`CREATE INDEX IF NOT EXISTS two_sided_pair_cell_idx ON two_sided_pair(cell_id);`);
  await safeIndex(`CREATE INDEX IF NOT EXISTS two_sided_pair_created_at_idx ON two_sided_pair(created_at);`);
  await safeIndex(`CREATE INDEX IF NOT EXISTS two_sided_pair_leg_pair_idx ON two_sided_pair_leg(pair_id);`);
  await safeIndex(`CREATE INDEX IF NOT EXISTS two_sided_pair_event_pair_idx ON two_sided_pair_event(pair_id);`);
};

// ────────────────────── Row mappers ──────────────────────

const rowToPair = (r: Record<string, unknown>): PairRecord => ({
  pairId: r.pair_id as string,
  cellId: r.cell_id as string,
  status: r.status as PairStatus,
  foxifyPairRef: r.foxify_pair_ref as string,
  spotAtActivation: Number(r.spot_at_activation),
  feedSnapshotAtActivation: (r.feed_snapshot_at_activation as Record<string, unknown>) ?? {},
  triggerDownPrice: Number(r.trigger_down_price),
  triggerUpPrice: Number(r.trigger_up_price),
  hedgeTenorDays: Number(r.hedge_tenor_days),
  expiresAt: r.expires_at as string,
  tpForceExitAt: r.tp_force_exit_at as string,
  hedgeCostTotalUsdc: Number(r.hedge_cost_total_usdc),
  foxifyCapitalFundedUsdc: Number(r.foxify_capital_funded_usdc),
  tierAtActivation: r.tier_at_activation as TierLabel,
  atticusFloorUsdc: Number(r.atticus_floor_usdc),
  triggeredAt: (r.triggered_at as string | null) ?? null,
  triggerSide: (r.trigger_side as TriggerSide | null) ?? null,
  triggerFeedSnapshot: (r.trigger_feed_snapshot as Record<string, unknown> | null) ?? null,
  closedAt: (r.closed_at as string | null) ?? null,
  closedReason: (r.closed_reason as CloseReason | null) ?? null,
  salvageProceedsUsdc: r.salvage_proceeds_usdc == null ? null : Number(r.salvage_proceeds_usdc),
  upliftUsdc: r.uplift_usdc == null ? null : Number(r.uplift_usdc),
  foxifyShareUsdc: r.foxify_share_usdc == null ? null : Number(r.foxify_share_usdc),
  atticusShareUsdc: r.atticus_share_usdc == null ? null : Number(r.atticus_share_usdc),
  exitMode: (r.exit_mode as ExitMode | null) ?? null,
  isShadow: Boolean(r.is_shadow),
  regimeAtActivation: (r.regime_at_activation as PairRecord["regimeAtActivation"]) ?? null,
  metadata: (r.metadata as Record<string, unknown>) ?? {},
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string
});

const rowToLeg = (r: Record<string, unknown>): PairLegRecord => ({
  legId: r.leg_id as string,
  pairId: r.pair_id as string,
  legRole: r.leg_role as PairLegRecord["legRole"],
  venue: r.venue as PairLegRecord["venue"],
  symbol: r.symbol as string,
  strikeUsdc: Number(r.strike_usdc),
  contractsBtc: Number(r.contracts_btc),
  buyAskUsdcPerBtc: Number(r.buy_ask_usdc_per_btc),
  buyCostUsdc: Number(r.buy_cost_usdc),
  buyFilledAt: (r.buy_filled_at as string | null) ?? null,
  sellAskUsdcPerBtc: r.sell_ask_usdc_per_btc == null ? null : Number(r.sell_ask_usdc_per_btc),
  sellProceedsUsdc: r.sell_proceeds_usdc == null ? null : Number(r.sell_proceeds_usdc),
  sellFilledAt: (r.sell_filled_at as string | null) ?? null,
  liveAnchorAskUsdcPerBtc: Number(r.live_anchor_ask_usdc_per_btc),
  liveAnchorPulledAt: r.live_anchor_pulled_at as string,
  metadata: (r.metadata as Record<string, unknown>) ?? {}
});

const rowToEvent = (r: Record<string, unknown>): PairEventRecord => ({
  eventId: r.event_id as string,
  pairId: r.pair_id as string,
  occurredAt: r.occurred_at as string,
  kind: r.kind as PairEventKind,
  details: (r.details as Record<string, unknown>) ?? {}
});

// ────────────────────── CRUD ──────────────────────

export const insertPair = async (
  exec: DbExecutor,
  input: Omit<PairRecord, "createdAt" | "updatedAt" | "status" | "triggeredAt" | "triggerSide" | "triggerFeedSnapshot" | "closedAt" | "closedReason" | "salvageProceedsUsdc" | "upliftUsdc" | "foxifyShareUsdc" | "atticusShareUsdc" | "exitMode" | "isShadow" | "regimeAtActivation"> & { status?: PairStatus; isShadow?: boolean; regimeAtActivation?: PairRecord["regimeAtActivation"] }
): Promise<PairRecord> => {
  const res = await exec.query(
    `
    INSERT INTO two_sided_pair (
      pair_id, cell_id, status, foxify_pair_ref,
      spot_at_activation, feed_snapshot_at_activation,
      trigger_down_price, trigger_up_price,
      hedge_tenor_days, expires_at, tp_force_exit_at,
      hedge_cost_total_usdc, foxify_capital_funded_usdc,
      tier_at_activation, atticus_floor_usdc,
      metadata, is_shadow, regime_at_activation
    ) VALUES (
      $1, $2, $3, $4,
      $5, $6,
      $7, $8,
      $9, $10, $11,
      $12, $13,
      $14, $15,
      $16, $17, $18
    ) RETURNING *;
    `,
    [
      input.pairId,
      input.cellId,
      input.status ?? "pending",
      input.foxifyPairRef,
      input.spotAtActivation,
      JSON.stringify(input.feedSnapshotAtActivation ?? {}),
      input.triggerDownPrice,
      input.triggerUpPrice,
      input.hedgeTenorDays,
      input.expiresAt,
      input.tpForceExitAt,
      input.hedgeCostTotalUsdc,
      input.foxifyCapitalFundedUsdc,
      input.tierAtActivation,
      input.atticusFloorUsdc,
      JSON.stringify(input.metadata ?? {}),
      input.isShadow ?? false,
      input.regimeAtActivation ?? null
    ]
  );
  return rowToPair(res.rows[0]);
};

export const getPairById = async (exec: DbExecutor, pairId: string): Promise<PairRecord | null> => {
  const res = await exec.query(`SELECT * FROM two_sided_pair WHERE pair_id = $1`, [pairId]);
  return res.rows.length === 0 ? null : rowToPair(res.rows[0]);
};

export const getPairByFoxifyRef = async (exec: DbExecutor, foxifyPairRef: string): Promise<PairRecord | null> => {
  const res = await exec.query(`SELECT * FROM two_sided_pair WHERE foxify_pair_ref = $1`, [foxifyPairRef]);
  return res.rows.length === 0 ? null : rowToPair(res.rows[0]);
};

/**
 * Count REAL (non-shadow) pairs activated since UTC midnight today, excluding
 * cancelled (failed-execution) pairs. Used by the live-activation gate to enforce
 * SS_TWO_SIDED_MAX_PAIRS_PER_DAY — the hard daily cap on real-money pairs.
 */
export const countLivePairsToday = async (exec: DbExecutor, nowMs: number = Date.now()): Promise<number> => {
  const dayStart = new Date(nowMs);
  dayStart.setUTCHours(0, 0, 0, 0);
  const res = await exec.query(
    `SELECT COUNT(*)::int AS n
       FROM two_sided_pair
      WHERE is_shadow = FALSE
        AND created_at >= $1
        AND status <> 'cancelled'`,
    [dayStart.toISOString()]
  );
  return res.rows[0]?.n ?? 0;
};

export const updatePairStatus = async (
  exec: DbExecutor,
  pairId: string,
  newStatus: PairStatus,
  patch: Partial<{
    triggeredAt: string;
    triggerSide: TriggerSide;
    triggerFeedSnapshot: Record<string, unknown>;
    closedAt: string;
    closedReason: CloseReason;
    salvageProceedsUsdc: number;
    upliftUsdc: number;
    foxifyShareUsdc: number;
    atticusShareUsdc: number;
    exitMode: ExitMode;
  }> = {}
): Promise<PairRecord> => {
  const current = await getPairById(exec, pairId);
  if (!current) throw new Error(`Pair ${pairId} not found`);
  assertValidTransition(current.status, newStatus);

  // Build dynamic SET
  const sets: string[] = ["status = $2", "updated_at = NOW()"];
  const params: unknown[] = [pairId, newStatus];
  let idx = 3;
  const add = (col: string, val: unknown) => {
    sets.push(`${col} = $${idx++}`);
    params.push(val);
  };
  if (patch.triggeredAt !== undefined) add("triggered_at", patch.triggeredAt);
  if (patch.triggerSide !== undefined) add("trigger_side", patch.triggerSide);
  if (patch.triggerFeedSnapshot !== undefined) add("trigger_feed_snapshot", JSON.stringify(patch.triggerFeedSnapshot));
  if (patch.closedAt !== undefined) add("closed_at", patch.closedAt);
  if (patch.closedReason !== undefined) add("closed_reason", patch.closedReason);
  if (patch.salvageProceedsUsdc !== undefined) add("salvage_proceeds_usdc", patch.salvageProceedsUsdc);
  if (patch.upliftUsdc !== undefined) add("uplift_usdc", patch.upliftUsdc);
  if (patch.foxifyShareUsdc !== undefined) add("foxify_share_usdc", patch.foxifyShareUsdc);
  if (patch.atticusShareUsdc !== undefined) add("atticus_share_usdc", patch.atticusShareUsdc);
  if (patch.exitMode !== undefined) add("exit_mode", patch.exitMode);

  const res = await exec.query(
    `UPDATE two_sided_pair SET ${sets.join(", ")} WHERE pair_id = $1 RETURNING *;`,
    params
  );
  return rowToPair(res.rows[0]);
};

export const insertPairLeg = async (
  exec: DbExecutor,
  input: Omit<PairLegRecord, "sellAskUsdcPerBtc" | "sellProceedsUsdc" | "sellFilledAt"> & { legId?: string }
): Promise<PairLegRecord> => {
  const legId = input.legId ?? randomUUID();
  const res = await exec.query(
    `
    INSERT INTO two_sided_pair_leg (
      leg_id, pair_id, leg_role, venue, symbol, strike_usdc, contracts_btc,
      buy_ask_usdc_per_btc, buy_cost_usdc, buy_filled_at,
      live_anchor_ask_usdc_per_btc, live_anchor_pulled_at,
      metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    RETURNING *;
    `,
    [
      legId,
      input.pairId,
      input.legRole,
      input.venue,
      input.symbol,
      input.strikeUsdc,
      input.contractsBtc,
      input.buyAskUsdcPerBtc,
      input.buyCostUsdc,
      input.buyFilledAt,
      input.liveAnchorAskUsdcPerBtc,
      input.liveAnchorPulledAt,
      JSON.stringify(input.metadata ?? {})
    ]
  );
  return rowToLeg(res.rows[0]);
};

export const getLegsForPair = async (exec: DbExecutor, pairId: string): Promise<PairLegRecord[]> => {
  const res = await exec.query(`SELECT * FROM two_sided_pair_leg WHERE pair_id = $1 ORDER BY leg_role`, [pairId]);
  return res.rows.map(rowToLeg);
};

export const recordPairEvent = async (
  exec: DbExecutor,
  input: { pairId: string; kind: PairEventKind; details?: Record<string, unknown>; occurredAt?: string }
): Promise<PairEventRecord> => {
  const res = await exec.query(
    `
    INSERT INTO two_sided_pair_event (event_id, pair_id, occurred_at, kind, details)
    VALUES ($1, $2, COALESCE($3::timestamptz, NOW()), $4, $5)
    RETURNING *;
    `,
    [
      randomUUID(),
      input.pairId,
      input.occurredAt ?? null,
      input.kind,
      JSON.stringify(input.details ?? {})
    ]
  );
  return rowToEvent(res.rows[0]);
};

export const getEventsForPair = async (exec: DbExecutor, pairId: string): Promise<PairEventRecord[]> => {
  const res = await exec.query(
    `SELECT * FROM two_sided_pair_event WHERE pair_id = $1 ORDER BY occurred_at, event_id`,
    [pairId]
  );
  return res.rows.map(rowToEvent);
};
