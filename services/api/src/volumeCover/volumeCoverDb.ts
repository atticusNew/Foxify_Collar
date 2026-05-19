/**
 * Volume Cover database — schema + CRUD.
 *
 * Four additive tables:
 *
 *   volume_cover_cell           — matrix definitions (seeded from matrix.ts at boot)
 *   volume_cover_position       — active and historical Foxify positions
 *   volume_cover_hedge_leg      — option legs hedging each position (one or two)
 *   volume_cover_salvage_event  — immutable audit log of every trigger event
 *
 * All schema operations idempotent (CREATE TABLE IF NOT EXISTS, ON CONFLICT DO).
 * Index creation wrapped in try/catch for pg-mem compatibility (existing
 * pilot pattern).
 *
 * No destructive migrations. New tables only; safe to run on every boot.
 */

import type { Pool, PoolClient } from "pg";
import { MATRIX, type CellId } from "./matrix";

export type DbExecutor = Pool | PoolClient;

// ────────────────────── Schema ──────────────────────

export const ensureVolumeCoverSchema = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS volume_cover_cell (
      cell_id TEXT PRIMARY KEY,
      notional_usdc NUMERIC(20, 8) NOT NULL,
      trigger_pct NUMERIC(8, 6) NOT NULL,
      payout_usdc NUMERIC(20, 8) NOT NULL,
      hedge_pct NUMERIC(8, 6) NOT NULL,
      daily_premium_usdc NUMERIC(20, 8) NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      throttle_max_per_day INTEGER NOT NULL DEFAULT 5,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS volume_cover_position (
      id TEXT PRIMARY KEY,
      cell_id TEXT NOT NULL REFERENCES volume_cover_cell(cell_id),
      foxify_pair_id TEXT NOT NULL,
      pair_long_notional_usdc NUMERIC(20, 8) NOT NULL,
      pair_short_notional_usdc NUMERIC(20, 8) NOT NULL,
      pair_entry_btc_price NUMERIC(20, 8) NOT NULL,
      trigger_high_btc NUMERIC(20, 8) NOT NULL,
      trigger_low_btc NUMERIC(20, 8) NOT NULL,
      daily_premium_usdc NUMERIC(20, 8) NOT NULL,
      payout_usdc NUMERIC(20, 8) NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      triggered_at TIMESTAMPTZ,
      triggered_direction TEXT,
      closed_at TIMESTAMPTZ,
      close_reason TEXT,
      fingerprint_hash TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      CONSTRAINT volume_cover_position_status_check
        CHECK (status IN ('active', 'triggered', 'closed', 'cancelled')),
      CONSTRAINT volume_cover_position_direction_check
        CHECK (triggered_direction IS NULL OR triggered_direction IN ('high', 'low'))
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS volume_cover_hedge_leg (
      id TEXT PRIMARY KEY,
      position_id TEXT NOT NULL REFERENCES volume_cover_position(id),
      venue TEXT NOT NULL,
      option_kind TEXT NOT NULL,
      strike_usdc NUMERIC(20, 8) NOT NULL,
      expiry_iso TIMESTAMPTZ NOT NULL,
      contracts NUMERIC(20, 8) NOT NULL,
      buy_price_usdc NUMERIC(20, 8) NOT NULL,
      buy_order_id TEXT,
      sell_price_usdc NUMERIC(20, 8),
      sell_order_id TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      CONSTRAINT volume_cover_hedge_leg_kind_check
        CHECK (option_kind IN ('put', 'call')),
      CONSTRAINT volume_cover_hedge_leg_status_check
        CHECK (status IN ('open', 'sold', 'expired', 'failed'))
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS volume_cover_salvage_event (
      id TEXT PRIMARY KEY,
      position_id TEXT NOT NULL REFERENCES volume_cover_position(id),
      triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      triggered_direction TEXT NOT NULL,
      payout_owed_usdc NUMERIC(20, 8) NOT NULL,
      hedge_sale_proceeds_usdc NUMERIC(20, 8) NOT NULL,
      salvage_pct NUMERIC(8, 6) NOT NULL,
      net_atticus_loss_usdc NUMERIC(20, 8) NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      CONSTRAINT volume_cover_salvage_event_direction_check
        CHECK (triggered_direction IN ('high', 'low'))
    );
  `);

  // ─── P1b (2026-05-16): Atticus retention columns on hedge_leg ───
  // Spec: Foxify close OR trigger does NOT auto-sell hedge legs;
  // Atticus retains and runs TP/salvage. Adds `retained` flag,
  // retention timestamp + reason, and post-retention role tag.
  // Additive only — legacy rows default to retained=false.
  //
  // P1e (2026-05-16): ladder netting columns. When same-fingerprint
  // same-cell reopen happens within 30 min, retained legs are
  // repurposed back to status='open' under the new position_id.
  // ladder_hop_count caps re-use to 1 hop per leg lineage.
  const safeAlter = async (sql: string): Promise<void> => {
    try { await pool.query(sql); } catch { /* column likely exists */ }
  };
  await safeAlter(`ALTER TABLE volume_cover_hedge_leg ADD COLUMN retained BOOLEAN NOT NULL DEFAULT FALSE`);
  await safeAlter(`ALTER TABLE volume_cover_hedge_leg ADD COLUMN retained_at TIMESTAMPTZ`);
  await safeAlter(`ALTER TABLE volume_cover_hedge_leg ADD COLUMN retained_reason TEXT`);
  await safeAlter(`ALTER TABLE volume_cover_hedge_leg ADD COLUMN retained_role TEXT`);
  await safeAlter(`ALTER TABLE volume_cover_hedge_leg ADD COLUMN repurposed_from_position_id TEXT`);
  await safeAlter(`ALTER TABLE volume_cover_hedge_leg ADD COLUMN ladder_hop_count INTEGER NOT NULL DEFAULT 0`);
  // ─── P2.5 (2026-05-16): full TP curve state ───
  await safeAlter(`ALTER TABLE volume_cover_hedge_leg ADD COLUMN running_max_value_usdc NUMERIC(20, 8)`);
  await safeAlter(`ALTER TABLE volume_cover_hedge_leg ADD COLUMN last_value_usdc NUMERIC(20, 8)`);
  await safeAlter(`ALTER TABLE volume_cover_hedge_leg ADD COLUMN last_value_at TIMESTAMPTZ`);

  // Hedge-retained ledger info for audit (no balance impact). Not its
  // own table; we use the existing pilot capital_pool_ledger via
  // metadata. See positionLifecycle.

  // ─── P1d (2026-05-16): premium accrual rollup audit per position
  // (the canonical source of truth is the position row itself —
  // (closed_at - opened_at) × dailyPremium — but we cache rollups
  // for fast weekly-reconciler reads). Schema added in P1d.

  // ─── P1e (2026-05-16): ladder netting events (audit + savings) ───
  await pool.query(`
    CREATE TABLE IF NOT EXISTS volume_cover_ladder_netting_event (
      id TEXT PRIMARY KEY,
      prior_position_id TEXT NOT NULL,
      new_position_id TEXT NOT NULL,
      fingerprint_hash TEXT,
      cell_id TEXT NOT NULL,
      legs_repurposed JSONB NOT NULL,
      estimated_savings_usdc NUMERIC(20, 8) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // ─── P1g (2026-05-16): anti-bot fingerprint state ───
  await pool.query(`
    CREATE TABLE IF NOT EXISTS volume_cover_fingerprint_state (
      fingerprint_hash TEXT PRIMARY KEY,
      last_activate_at TIMESTAMPTZ,
      last_activate_cell_id TEXT,
      next_allowed_activate_at TIMESTAMPTZ,
      last_trigger_at TIMESTAMPTZ,
      pattern_strikes INTEGER NOT NULL DEFAULT 0,
      surcharge_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // ─── 2026-05-16 follow-up: pair-event audit log (timing breakdown) ───
  // One row per /activate request. Captures wall-clock timing across
  // the hot-path stages so we can monitor P50/P95/P99 latency live
  // and reconcile against Foxify's perp-open timestamps.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS volume_cover_pair_event (
      id TEXT PRIMARY KEY,
      foxify_pair_id TEXT NOT NULL,
      cell_id TEXT NOT NULL,
      fingerprint_hash TEXT,
      pair_entry_btc_price NUMERIC(20, 8),
      result TEXT NOT NULL,
      reject_reason TEXT,
      position_id TEXT,
      received_at TIMESTAMPTZ NOT NULL,
      guards_passed_at TIMESTAMPTZ,
      hedge_buy_submitted_at TIMESTAMPTZ,
      hedge_fill_at TIMESTAMPTZ,
      response_sent_at TIMESTAMPTZ NOT NULL,
      total_latency_ms INTEGER NOT NULL,
      laddered BOOLEAN NOT NULL DEFAULT FALSE,
      ladder_savings_usdc NUMERIC(20, 8) DEFAULT 0,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      CONSTRAINT volume_cover_pair_event_result_check
        CHECK (result IN ('activated', 'idempotent', 'rejected', 'failed'))
    );
  `);

  // ─── P1f (2026-05-16): hedge manager telemetry (per-tick log) ───
  await pool.query(`
    CREATE TABLE IF NOT EXISTS volume_cover_hedge_leg_telemetry (
      id BIGSERIAL PRIMARY KEY,
      leg_id TEXT NOT NULL,
      position_id TEXT NOT NULL,
      retained_role TEXT,
      current_value_usdc NUMERIC(20, 8),
      initial_cost_usdc NUMERIC(20, 8),
      spot_btc NUMERIC(20, 8),
      iv_annualized NUMERIC(8, 6),
      rule_evaluated TEXT NOT NULL,
      action TEXT NOT NULL,
      cycled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Index creation — best-effort, pg-mem compatible.
  const safeIdx = async (sql: string): Promise<void> => {
    try { await pool.query(sql); } catch { /* index may already exist */ }
  };
  await safeIdx(`CREATE INDEX idx_volume_cover_position_status ON volume_cover_position (status)`);
  await safeIdx(`CREATE INDEX idx_volume_cover_position_cell ON volume_cover_position (cell_id, opened_at)`);
  await safeIdx(`CREATE INDEX idx_volume_cover_position_pair ON volume_cover_position (foxify_pair_id)`);
  await safeIdx(`CREATE INDEX idx_volume_cover_hedge_position ON volume_cover_hedge_leg (position_id, status)`);
  await safeIdx(`CREATE INDEX idx_volume_cover_hedge_retained ON volume_cover_hedge_leg (retained, expiry_iso) WHERE retained = TRUE`);
  await safeIdx(`CREATE INDEX idx_volume_cover_salvage_pos ON volume_cover_salvage_event (position_id)`);
  await safeIdx(`CREATE INDEX idx_volume_cover_salvage_time ON volume_cover_salvage_event (triggered_at DESC)`);
  await safeIdx(`CREATE INDEX idx_vc_ladder_fingerprint ON volume_cover_ladder_netting_event (fingerprint_hash, created_at)`);
  await safeIdx(`CREATE INDEX idx_vc_hm_telem_leg ON volume_cover_hedge_leg_telemetry (leg_id, cycled_at DESC)`);
  await safeIdx(`CREATE INDEX idx_vc_hm_telem_time ON volume_cover_hedge_leg_telemetry (cycled_at DESC)`);
  await safeIdx(`CREATE INDEX idx_vc_fp_next_allowed ON volume_cover_fingerprint_state (next_allowed_activate_at)`);
  await safeIdx(`CREATE INDEX idx_vc_pair_event_received ON volume_cover_pair_event (received_at DESC)`);
  await safeIdx(`CREATE INDEX idx_vc_pair_event_position ON volume_cover_pair_event (position_id)`);
  await safeIdx(`CREATE INDEX idx_vc_pair_event_fingerprint ON volume_cover_pair_event (fingerprint_hash, received_at DESC)`);
};

/**
 * Seed cells from MATRIX. Idempotent. New cells inserted; existing cells
 * left alone (ON CONFLICT DO NOTHING) so operator runtime overrides
 * (enabled flag, daily_premium_usdc, throttle_max_per_day) survive a
 * redeploy.
 */
export const seedVolumeCoverCellsIfNeeded = async (pool: Pool): Promise<void> => {
  for (const cell of MATRIX) {
    await pool.query(
      `INSERT INTO volume_cover_cell
         (cell_id, notional_usdc, trigger_pct, payout_usdc, hedge_pct,
          daily_premium_usdc, enabled, throttle_max_per_day)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (cell_id) DO NOTHING`,
      [
        cell.cellId,
        cell.notionalUsdc,
        cell.triggerPct,
        cell.payoutUsdc,
        cell.hedgePct,
        cell.dailyPremiumUsdc,
        // Default-enabled controlled per-cell. Test/diagnostic cells
        // (e.g. 1k_2pct_20) opt out via defaultEnabled:false so they
        // can't be accidentally activated until operator opts in.
        cell.defaultEnabled ?? true,
        cell.defaultThrottleMaxPerDay
      ]
    );
  }
};

// ────────────────────── CRUD: Cells ──────────────────────

export type CellRow = {
  cellId: string;
  notionalUsdc: number;
  triggerPct: number;
  payoutUsdc: number;
  hedgePct: number;
  dailyPremiumUsdc: number;
  enabled: boolean;
  throttleMaxPerDay: number;
  createdAt: string;
  updatedAt: string;
};

const rowToCell = (r: any): CellRow => ({
  cellId: String(r.cell_id),
  notionalUsdc: Number(r.notional_usdc),
  triggerPct: Number(r.trigger_pct),
  payoutUsdc: Number(r.payout_usdc),
  hedgePct: Number(r.hedge_pct),
  dailyPremiumUsdc: Number(r.daily_premium_usdc),
  enabled: Boolean(r.enabled),
  throttleMaxPerDay: Number(r.throttle_max_per_day),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at)
});

export const listCells = async (pool: DbExecutor): Promise<CellRow[]> => {
  const r = await pool.query(`SELECT * FROM volume_cover_cell ORDER BY notional_usdc, trigger_pct`);
  return r.rows.map(rowToCell);
};

export const getCell = async (
  pool: DbExecutor,
  cellId: string
): Promise<CellRow | null> => {
  const r = await pool.query(`SELECT * FROM volume_cover_cell WHERE cell_id = $1`, [cellId]);
  return r.rows[0] ? rowToCell(r.rows[0]) : null;
};

export const updateCell = async (
  pool: DbExecutor,
  cellId: string,
  updates: { enabled?: boolean; dailyPremiumUsdc?: number; throttleMaxPerDay?: number }
): Promise<CellRow | null> => {
  const sets: string[] = [];
  const values: any[] = [];
  let idx = 1;
  if (typeof updates.enabled === "boolean") {
    sets.push(`enabled = $${idx++}`);
    values.push(updates.enabled);
  }
  if (typeof updates.dailyPremiumUsdc === "number") {
    sets.push(`daily_premium_usdc = $${idx++}`);
    values.push(updates.dailyPremiumUsdc);
  }
  if (typeof updates.throttleMaxPerDay === "number") {
    sets.push(`throttle_max_per_day = $${idx++}`);
    values.push(updates.throttleMaxPerDay);
  }
  if (sets.length === 0) return getCell(pool, cellId);
  sets.push(`updated_at = NOW()`);
  values.push(cellId);
  const r = await pool.query(
    `UPDATE volume_cover_cell SET ${sets.join(", ")} WHERE cell_id = $${idx} RETURNING *`,
    values
  );
  return r.rows[0] ? rowToCell(r.rows[0]) : null;
};

// ────────────────────── CRUD: Positions ──────────────────────

export type PositionRow = {
  id: string;
  cellId: string;
  foxifyPairId: string;
  pairLongNotionalUsdc: number;
  pairShortNotionalUsdc: number;
  pairEntryBtcPrice: number;
  triggerHighBtc: number;
  triggerLowBtc: number;
  dailyPremiumUsdc: number;
  payoutUsdc: number;
  status: "active" | "triggered" | "closed" | "cancelled";
  openedAt: string;
  triggeredAt: string | null;
  triggeredDirection: "high" | "low" | null;
  closedAt: string | null;
  closeReason: string | null;
  fingerprintHash: string | null;
  metadata: Record<string, unknown>;
};

const rowToPosition = (r: any): PositionRow => ({
  id: String(r.id),
  cellId: String(r.cell_id),
  foxifyPairId: String(r.foxify_pair_id),
  pairLongNotionalUsdc: Number(r.pair_long_notional_usdc),
  pairShortNotionalUsdc: Number(r.pair_short_notional_usdc),
  pairEntryBtcPrice: Number(r.pair_entry_btc_price),
  triggerHighBtc: Number(r.trigger_high_btc),
  triggerLowBtc: Number(r.trigger_low_btc),
  dailyPremiumUsdc: Number(r.daily_premium_usdc),
  payoutUsdc: Number(r.payout_usdc),
  status: String(r.status) as PositionRow["status"],
  openedAt: String(r.opened_at),
  triggeredAt: r.triggered_at ? String(r.triggered_at) : null,
  triggeredDirection: r.triggered_direction ? (String(r.triggered_direction) as "high" | "low") : null,
  closedAt: r.closed_at ? String(r.closed_at) : null,
  closeReason: r.close_reason ? String(r.close_reason) : null,
  fingerprintHash: r.fingerprint_hash ? String(r.fingerprint_hash) : null,
  metadata: typeof r.metadata === "string" ? JSON.parse(r.metadata) : (r.metadata ?? {})
});

export const insertPosition = async (
  pool: DbExecutor,
  position: {
    id: string;
    cellId: string;
    foxifyPairId: string;
    pairLongNotionalUsdc: number;
    pairShortNotionalUsdc: number;
    pairEntryBtcPrice: number;
    triggerHighBtc: number;
    triggerLowBtc: number;
    dailyPremiumUsdc: number;
    payoutUsdc: number;
    fingerprintHash?: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<PositionRow> => {
  const r = await pool.query(
    `INSERT INTO volume_cover_position
       (id, cell_id, foxify_pair_id,
        pair_long_notional_usdc, pair_short_notional_usdc, pair_entry_btc_price,
        trigger_high_btc, trigger_low_btc,
        daily_premium_usdc, payout_usdc,
        fingerprint_hash, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      position.id,
      position.cellId,
      position.foxifyPairId,
      position.pairLongNotionalUsdc,
      position.pairShortNotionalUsdc,
      position.pairEntryBtcPrice,
      position.triggerHighBtc,
      position.triggerLowBtc,
      position.dailyPremiumUsdc,
      position.payoutUsdc,
      position.fingerprintHash ?? null,
      JSON.stringify(position.metadata ?? {})
    ]
  );
  return rowToPosition(r.rows[0]);
};

export const getPosition = async (
  pool: DbExecutor,
  id: string
): Promise<PositionRow | null> => {
  const r = await pool.query(`SELECT * FROM volume_cover_position WHERE id = $1`, [id]);
  return r.rows[0] ? rowToPosition(r.rows[0]) : null;
};

export const getPositionByPairId = async (
  pool: DbExecutor,
  foxifyPairId: string
): Promise<PositionRow | null> => {
  const r = await pool.query(
    `SELECT * FROM volume_cover_position
     WHERE foxify_pair_id = $1
     ORDER BY opened_at DESC
     LIMIT 1`,
    [foxifyPairId]
  );
  return r.rows[0] ? rowToPosition(r.rows[0]) : null;
};

export const listActivePositions = async (pool: DbExecutor): Promise<PositionRow[]> => {
  const r = await pool.query(
    `SELECT * FROM volume_cover_position WHERE status = 'active' ORDER BY opened_at`
  );
  return r.rows.map(rowToPosition);
};

export const listPositionsForCellToday = async (
  pool: DbExecutor,
  params: { cellId: string; sinceIso: string }
): Promise<PositionRow[]> => {
  const r = await pool.query(
    `SELECT * FROM volume_cover_position
     WHERE cell_id = $1 AND opened_at >= $2
     ORDER BY opened_at`,
    [params.cellId, params.sinceIso]
  );
  return r.rows.map(rowToPosition);
};

export const sumActivePayoutLiability = async (pool: DbExecutor): Promise<number> => {
  const r = await pool.query(
    `SELECT COALESCE(SUM(payout_usdc), 0) AS total FROM volume_cover_position WHERE status = 'active'`
  );
  return Number(r.rows[0].total);
};

export const markPositionTriggered = async (
  pool: DbExecutor,
  params: { id: string; direction: "high" | "low"; triggeredAtIso?: string }
): Promise<PositionRow | null> => {
  const r = await pool.query(
    `UPDATE volume_cover_position
     SET status = 'triggered',
         triggered_direction = $2,
         triggered_at = COALESCE($3::timestamptz, NOW())
     WHERE id = $1 AND status = 'active'
     RETURNING *`,
    [params.id, params.direction, params.triggeredAtIso ?? null]
  );
  return r.rows[0] ? rowToPosition(r.rows[0]) : null;
};

export const markPositionClosed = async (
  pool: DbExecutor,
  params: { id: string; reason: string; closedAtIso?: string }
): Promise<PositionRow | null> => {
  const r = await pool.query(
    `UPDATE volume_cover_position
     SET status = 'closed',
         close_reason = $2,
         closed_at = COALESCE($3::timestamptz, NOW())
     WHERE id = $1
     RETURNING *`,
    [params.id, params.reason, params.closedAtIso ?? null]
  );
  return r.rows[0] ? rowToPosition(r.rows[0]) : null;
};

// ────────────────────── CRUD: Hedge legs ──────────────────────

export type RetainedRole = "winner_post_trigger" | "loser_post_trigger" | "near_atm_post_close" | "stale_post_close";

export type HedgeLegRow = {
  id: string;
  positionId: string;
  venue: string;
  optionKind: "put" | "call";
  strikeUsdc: number;
  expiryIso: string;
  contracts: number;
  buyPriceUsdc: number;
  buyOrderId: string | null;
  sellPriceUsdc: number | null;
  sellOrderId: string | null;
  status: "open" | "sold" | "expired" | "failed";
  openedAt: string;
  closedAt: string | null;
  metadata: Record<string, unknown>;
  // P1b retention fields
  retained: boolean;
  retainedAt: string | null;
  retainedReason: string | null;
  retainedRole: RetainedRole | null;
  // P1e ladder fields
  repurposedFromPositionId: string | null;
  ladderHopCount: number;
  // P2.5 TP state
  runningMaxValueUsdc: number | null;
  lastValueUsdc: number | null;
  lastValueAt: string | null;
};

const rowToHedgeLeg = (r: any): HedgeLegRow => ({
  id: String(r.id),
  positionId: String(r.position_id),
  venue: String(r.venue),
  optionKind: String(r.option_kind) as "put" | "call",
  strikeUsdc: Number(r.strike_usdc),
  expiryIso: String(r.expiry_iso),
  contracts: Number(r.contracts),
  buyPriceUsdc: Number(r.buy_price_usdc),
  buyOrderId: r.buy_order_id ? String(r.buy_order_id) : null,
  sellPriceUsdc: r.sell_price_usdc !== null && r.sell_price_usdc !== undefined ? Number(r.sell_price_usdc) : null,
  sellOrderId: r.sell_order_id ? String(r.sell_order_id) : null,
  status: String(r.status) as HedgeLegRow["status"],
  openedAt: String(r.opened_at),
  closedAt: r.closed_at ? String(r.closed_at) : null,
  metadata: typeof r.metadata === "string" ? JSON.parse(r.metadata) : (r.metadata ?? {}),
  retained: Boolean(r.retained ?? false),
  retainedAt: r.retained_at ? String(r.retained_at) : null,
  retainedReason: r.retained_reason ? String(r.retained_reason) : null,
  retainedRole: r.retained_role ? (String(r.retained_role) as RetainedRole) : null,
  repurposedFromPositionId: r.repurposed_from_position_id ? String(r.repurposed_from_position_id) : null,
  ladderHopCount: Number(r.ladder_hop_count ?? 0),
  runningMaxValueUsdc: r.running_max_value_usdc !== null && r.running_max_value_usdc !== undefined
    ? Number(r.running_max_value_usdc)
    : null,
  lastValueUsdc: r.last_value_usdc !== null && r.last_value_usdc !== undefined
    ? Number(r.last_value_usdc)
    : null,
  lastValueAt: r.last_value_at ? String(r.last_value_at) : null
});

export const insertHedgeLeg = async (
  pool: DbExecutor,
  leg: {
    id: string;
    positionId: string;
    venue: string;
    optionKind: "put" | "call";
    strikeUsdc: number;
    expiryIso: string;
    contracts: number;
    buyPriceUsdc: number;
    buyOrderId?: string | null;
    status?: "open" | "failed";
    metadata?: Record<string, unknown>;
  }
): Promise<HedgeLegRow> => {
  const r = await pool.query(
    `INSERT INTO volume_cover_hedge_leg
       (id, position_id, venue, option_kind, strike_usdc, expiry_iso,
        contracts, buy_price_usdc, buy_order_id, status, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      leg.id,
      leg.positionId,
      leg.venue,
      leg.optionKind,
      leg.strikeUsdc,
      leg.expiryIso,
      leg.contracts,
      leg.buyPriceUsdc,
      leg.buyOrderId ?? null,
      leg.status ?? "open",
      JSON.stringify(leg.metadata ?? {})
    ]
  );
  return rowToHedgeLeg(r.rows[0]);
};

export const listHedgeLegsForPosition = async (
  pool: DbExecutor,
  positionId: string
): Promise<HedgeLegRow[]> => {
  const r = await pool.query(
    `SELECT * FROM volume_cover_hedge_leg WHERE position_id = $1 ORDER BY opened_at`,
    [positionId]
  );
  return r.rows.map(rowToHedgeLeg);
};

export const markHedgeLegSold = async (
  pool: DbExecutor,
  params: {
    id: string;
    sellPriceUsdc: number;
    sellOrderId?: string | null;
  }
): Promise<HedgeLegRow | null> => {
  const r = await pool.query(
    `UPDATE volume_cover_hedge_leg
     SET status = 'sold',
         sell_price_usdc = $2,
         sell_order_id = $3,
         closed_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [params.id, params.sellPriceUsdc, params.sellOrderId ?? null]
  );
  return r.rows[0] ? rowToHedgeLeg(r.rows[0]) : null;
};

/**
 * P1b: mark a hedge leg as Atticus-retained (post-trigger or
 * post-Foxify-close). Status stays 'open' (because it's still a live
 * option Atticus owns), but retained=true flags it for the VC hedge
 * manager. retained_role tags it for TP-rule dispatch.
 */
export const markHedgeLegRetained = async (
  pool: DbExecutor,
  params: {
    id: string;
    retainedReason: "foxify_close" | "trigger" | "natural_expiry" | string;
    retainedRole: RetainedRole;
    retainedAtIso?: string;
  }
): Promise<HedgeLegRow | null> => {
  const r = await pool.query(
    `UPDATE volume_cover_hedge_leg
     SET retained = TRUE,
         retained_at = COALESCE($2::timestamptz, NOW()),
         retained_reason = $3,
         retained_role = $4
     WHERE id = $1 AND status = 'open'
     RETURNING *`,
    [params.id, params.retainedAtIso ?? null, params.retainedReason, params.retainedRole]
  );
  return r.rows[0] ? rowToHedgeLeg(r.rows[0]) : null;
};

/**
 * P1b: list legs currently retained by Atticus. Used by VC hedge
 * manager (60s tick) and ladder netting (match check).
 */
export const listRetainedHedgeLegs = async (
  pool: DbExecutor,
  filter: {
    fingerprintHash?: string | null;
    cellId?: string;
    expiryAfterIso?: string;
    retainedAfterIso?: string;
    optionKind?: "put" | "call";
  } = {}
): Promise<HedgeLegRow[]> => {
  const where: string[] = [`l.retained = TRUE`, `l.status = 'open'`];
  const values: any[] = [];
  let idx = 1;
  if (filter.fingerprintHash !== undefined && filter.fingerprintHash !== null) {
    where.push(`p.fingerprint_hash = $${idx++}`);
    values.push(filter.fingerprintHash);
  }
  if (filter.cellId) {
    where.push(`p.cell_id = $${idx++}`);
    values.push(filter.cellId);
  }
  if (filter.expiryAfterIso) {
    where.push(`l.expiry_iso >= $${idx++}::timestamptz`);
    values.push(filter.expiryAfterIso);
  }
  if (filter.retainedAfterIso) {
    where.push(`l.retained_at >= $${idx++}::timestamptz`);
    values.push(filter.retainedAfterIso);
  }
  if (filter.optionKind) {
    where.push(`l.option_kind = $${idx++}`);
    values.push(filter.optionKind);
  }
  const sql = `
    SELECT l.*
    FROM volume_cover_hedge_leg l
    JOIN volume_cover_position p ON p.id = l.position_id
    WHERE ${where.join(" AND ")}
    ORDER BY l.retained_at DESC NULLS LAST
  `;
  const r = await pool.query(sql, values);
  return r.rows.map(rowToHedgeLeg);
};

/**
 * P1e: repurpose a retained leg under a new position_id (ladder netting).
 * Atomically: clear retention flags, point at new position, increment
 * ladder_hop_count, record original position id. Idempotent failure
 * (returns null if leg is no longer retained or already hopped).
 */
export const repurposeHedgeLeg = async (
  pool: DbExecutor,
  params: {
    legId: string;
    newPositionId: string;
    /** Max hops permitted; default 1 (one repurpose per lineage). */
    maxHops?: number;
  }
): Promise<HedgeLegRow | null> => {
  const maxHops = params.maxHops ?? 1;
  const r = await pool.query(
    `UPDATE volume_cover_hedge_leg
     SET repurposed_from_position_id = position_id,
         position_id = $2,
         retained = FALSE,
         retained_at = NULL,
         retained_reason = NULL,
         retained_role = NULL,
         ladder_hop_count = ladder_hop_count + 1
     WHERE id = $1
       AND retained = TRUE
       AND status = 'open'
       AND ladder_hop_count < $3
     RETURNING *`,
    [params.legId, params.newPositionId, maxHops]
  );
  return r.rows[0] ? rowToHedgeLeg(r.rows[0]) : null;
};

/**
 * P2.5: update per-leg running max + last value (TP rule 5/6 inputs).
 */
export const updateHedgeLegTpState = async (
  pool: DbExecutor,
  params: {
    legId: string;
    currentValueUsdc: number;
  }
): Promise<void> => {
  await pool.query(
    `UPDATE volume_cover_hedge_leg
     SET running_max_value_usdc = GREATEST(COALESCE(running_max_value_usdc, 0), $2),
         last_value_usdc = $2,
         last_value_at = NOW()
     WHERE id = $1`,
    [params.legId, params.currentValueUsdc]
  );
};

/**
 * Pair-event audit log helpers (per-/activate timing breakdown).
 */
export type PairEventResult = "activated" | "idempotent" | "rejected" | "failed";

export type PairEventRow = {
  id: string;
  foxifyPairId: string;
  cellId: string;
  fingerprintHash: string | null;
  pairEntryBtcPrice: number | null;
  result: PairEventResult;
  rejectReason: string | null;
  positionId: string | null;
  receivedAtIso: string;
  guardsPassedAtIso: string | null;
  hedgeBuySubmittedAtIso: string | null;
  hedgeFillAtIso: string | null;
  responseSentAtIso: string;
  totalLatencyMs: number;
  laddered: boolean;
  ladderSavingsUsdc: number;
  metadata: Record<string, unknown>;
};

export const insertPairEvent = async (
  pool: DbExecutor,
  ev: Omit<PairEventRow, "id"> & { id?: string }
): Promise<{ id: string }> => {
  const id = ev.id ?? `vc-evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await pool.query(
    `INSERT INTO volume_cover_pair_event
       (id, foxify_pair_id, cell_id, fingerprint_hash, pair_entry_btc_price,
        result, reject_reason, position_id,
        received_at, guards_passed_at, hedge_buy_submitted_at, hedge_fill_at,
        response_sent_at, total_latency_ms, laddered, ladder_savings_usdc, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             $9::timestamptz, $10::timestamptz, $11::timestamptz, $12::timestamptz,
             $13::timestamptz, $14, $15, $16, $17)`,
    [
      id,
      ev.foxifyPairId,
      ev.cellId,
      ev.fingerprintHash,
      ev.pairEntryBtcPrice,
      ev.result,
      ev.rejectReason,
      ev.positionId,
      ev.receivedAtIso,
      ev.guardsPassedAtIso,
      ev.hedgeBuySubmittedAtIso,
      ev.hedgeFillAtIso,
      ev.responseSentAtIso,
      Math.round(ev.totalLatencyMs),
      ev.laddered,
      ev.ladderSavingsUsdc,
      JSON.stringify(ev.metadata ?? {})
    ]
  );
  return { id };
};

const rowToPairEvent = (r: any): PairEventRow => ({
  id: String(r.id),
  foxifyPairId: String(r.foxify_pair_id),
  cellId: String(r.cell_id),
  fingerprintHash: r.fingerprint_hash ? String(r.fingerprint_hash) : null,
  pairEntryBtcPrice: r.pair_entry_btc_price !== null && r.pair_entry_btc_price !== undefined ? Number(r.pair_entry_btc_price) : null,
  result: String(r.result) as PairEventResult,
  rejectReason: r.reject_reason ? String(r.reject_reason) : null,
  positionId: r.position_id ? String(r.position_id) : null,
  receivedAtIso: String(r.received_at),
  guardsPassedAtIso: r.guards_passed_at ? String(r.guards_passed_at) : null,
  hedgeBuySubmittedAtIso: r.hedge_buy_submitted_at ? String(r.hedge_buy_submitted_at) : null,
  hedgeFillAtIso: r.hedge_fill_at ? String(r.hedge_fill_at) : null,
  responseSentAtIso: String(r.response_sent_at),
  totalLatencyMs: Number(r.total_latency_ms ?? 0),
  laddered: Boolean(r.laddered ?? false),
  ladderSavingsUsdc: Number(r.ladder_savings_usdc ?? 0),
  metadata: typeof r.metadata === "string" ? JSON.parse(r.metadata) : (r.metadata ?? {})
});

export const listRecentPairEvents = async (
  pool: DbExecutor,
  limit = 100
): Promise<PairEventRow[]> => {
  const r = await pool.query(
    `SELECT * FROM volume_cover_pair_event ORDER BY received_at DESC LIMIT $1`,
    [limit]
  );
  return r.rows.map(rowToPairEvent);
};

export const computePairEventLatencyStats = async (
  pool: DbExecutor,
  windowHours = 24
): Promise<{
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  avgMs: number | null;
}> => {
  const r = await pool.query(
    `SELECT total_latency_ms FROM volume_cover_pair_event
     WHERE received_at >= NOW() - ($1 || ' hours')::interval
       AND result = 'activated'
     ORDER BY total_latency_ms ASC`,
    [String(windowHours)]
  );
  const samples = r.rows.map((row: any) => Number(row.total_latency_ms));
  const n = samples.length;
  if (n === 0) return { count: 0, p50Ms: null, p95Ms: null, p99Ms: null, avgMs: null };
  const pct = (p: number) => samples[Math.min(n - 1, Math.floor(n * p))];
  const sum = samples.reduce((s, x) => s + x, 0);
  return {
    count: n,
    p50Ms: pct(0.5),
    p95Ms: pct(0.95),
    p99Ms: pct(0.99),
    avgMs: Math.round(sum / n)
  };
};

/**
 * P1e: insert ladder netting audit event.
 */
export const insertLadderNettingEvent = async (
  pool: DbExecutor,
  event: {
    id: string;
    priorPositionId: string;
    newPositionId: string;
    fingerprintHash?: string | null;
    cellId: string;
    legsRepurposed: Array<{ legId: string; optionKind: "put" | "call"; strikeUsdc: number; contractsBtc: number }>;
    estimatedSavingsUsdc: number;
  }
): Promise<{ id: string }> => {
  const r = await pool.query(
    `INSERT INTO volume_cover_ladder_netting_event
       (id, prior_position_id, new_position_id, fingerprint_hash, cell_id,
        legs_repurposed, estimated_savings_usdc)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      event.id,
      event.priorPositionId,
      event.newPositionId,
      event.fingerprintHash ?? null,
      event.cellId,
      JSON.stringify(event.legsRepurposed),
      event.estimatedSavingsUsdc
    ]
  );
  return { id: String(r.rows[0].id) };
};

// ────────────────────── CRUD: Salvage events ──────────────────────

export type SalvageEventRow = {
  id: string;
  positionId: string;
  triggeredAt: string;
  triggeredDirection: "high" | "low";
  payoutOwedUsdc: number;
  hedgeSaleProceedsUsdc: number;
  salvagePct: number;
  netAtticusLossUsdc: number;
  metadata: Record<string, unknown>;
};

const rowToSalvage = (r: any): SalvageEventRow => ({
  id: String(r.id),
  positionId: String(r.position_id),
  triggeredAt: String(r.triggered_at),
  triggeredDirection: String(r.triggered_direction) as "high" | "low",
  payoutOwedUsdc: Number(r.payout_owed_usdc),
  hedgeSaleProceedsUsdc: Number(r.hedge_sale_proceeds_usdc),
  salvagePct: Number(r.salvage_pct),
  netAtticusLossUsdc: Number(r.net_atticus_loss_usdc),
  metadata: typeof r.metadata === "string" ? JSON.parse(r.metadata) : (r.metadata ?? {})
});

export const insertSalvageEvent = async (
  pool: DbExecutor,
  event: {
    id: string;
    positionId: string;
    triggeredDirection: "high" | "low";
    payoutOwedUsdc: number;
    hedgeSaleProceedsUsdc: number;
    metadata?: Record<string, unknown>;
  }
): Promise<SalvageEventRow> => {
  const salvagePct =
    event.payoutOwedUsdc > 0
      ? event.hedgeSaleProceedsUsdc / event.payoutOwedUsdc
      : 0;
  const netLoss = Math.max(0, event.payoutOwedUsdc - event.hedgeSaleProceedsUsdc);
  const r = await pool.query(
    `INSERT INTO volume_cover_salvage_event
       (id, position_id, triggered_direction, payout_owed_usdc,
        hedge_sale_proceeds_usdc, salvage_pct, net_atticus_loss_usdc, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      event.id,
      event.positionId,
      event.triggeredDirection,
      event.payoutOwedUsdc,
      event.hedgeSaleProceedsUsdc,
      salvagePct,
      netLoss,
      JSON.stringify(event.metadata ?? {})
    ]
  );
  return rowToSalvage(r.rows[0]);
};

/**
 * Finalize a salvage event by adding realized proceeds from a sold
 * retained leg. Called by the hedge manager after each successful
 * sellOptionLeg + ledger entry.
 *
 * Increments `hedge_sale_proceeds_usdc` and recomputes both
 * `salvage_pct` and `net_atticus_loss_usdc` server-side so Guard B
 * (rolling salvage rate) and Guard A (rolling 7d loss) read the truth
 * rather than the 0 placeholder written at trigger time.
 *
 * Returns null if no salvage_event row exists for the position (e.g.,
 * leg was a courtesy-close pre-trigger sale — those don't have a salvage
 * record). Caller treats null as a no-op.
 *
 * Idempotency note: this writes an INCREMENT, so calling it twice for
 * the same leg would double-count. Hedge manager calls it once per
 * successful sell, immediately after the hedge_sell_in ledger insert,
 * guarded by the same try/catch block; if the increment fails the
 * ledger row is already in place so the weekly reconciler will still
 * see realized proceeds in the ledger. Tradeoff accepted: prefer
 * accurate guards-typical-case over rare double-count edge.
 */
export const finalizeSalvageProceedsForPosition = async (
  pool: DbExecutor,
  params: {
    positionId: string;
    proceedsUsdcDelta: number;
    legId?: string;
    legProceedsBreakdown?: Record<string, number>;
  }
): Promise<SalvageEventRow | null> => {
  if (!Number.isFinite(params.proceedsUsdcDelta) || params.proceedsUsdcDelta <= 0) {
    return null;
  }
  // Two-step (SELECT id, then UPDATE by id) for pg-mem compatibility and
  // clarity. salvage_event rows are otherwise insert-only in production,
  // so there is no concurrent-update race between the two statements.
  const find = await pool.query(
    `SELECT id, payout_owed_usdc, hedge_sale_proceeds_usdc
       FROM volume_cover_salvage_event
      WHERE position_id = $1
      ORDER BY triggered_at DESC
      LIMIT 1`,
    [params.positionId]
  );
  if (find.rows.length === 0) return null;
  const target = find.rows[0];
  const payoutOwedUsdc = Number(target.payout_owed_usdc);
  const newProceeds = Number(target.hedge_sale_proceeds_usdc) + params.proceedsUsdcDelta;
  const newSalvagePct = payoutOwedUsdc > 0 ? newProceeds / payoutOwedUsdc : 0;
  const newNetLoss = Math.max(0, payoutOwedUsdc - newProceeds);
  const upd = await pool.query(
    `UPDATE volume_cover_salvage_event
        SET hedge_sale_proceeds_usdc = $2,
            salvage_pct = $3,
            net_atticus_loss_usdc = $4
      WHERE id = $1
      RETURNING *`,
    [
      String(target.id),
      newProceeds,
      newSalvagePct,
      newNetLoss
    ]
  );
  if (upd.rows.length === 0) return null;
  return rowToSalvage(upd.rows[0]);
};

export const listRecentSalvageEvents = async (
  pool: DbExecutor,
  limit = 50
): Promise<SalvageEventRow[]> => {
  const r = await pool.query(
    `SELECT * FROM volume_cover_salvage_event ORDER BY triggered_at DESC LIMIT $1`,
    [limit]
  );
  return r.rows.map(rowToSalvage);
};

export const computeRollingSalvageStats = async (
  pool: DbExecutor,
  rollingCount = 5
): Promise<{
  count: number;
  avgSalvagePct: number | null;
  totalNetLossUsdc: number;
  avgPayoutUsdc: number | null;
}> => {
  const r = await pool.query(
    `SELECT
       COUNT(*) AS cnt,
       AVG(salvage_pct) AS avg_salvage,
       SUM(net_atticus_loss_usdc) AS total_loss,
       AVG(payout_owed_usdc) AS avg_payout
     FROM (
       SELECT salvage_pct, net_atticus_loss_usdc, payout_owed_usdc
       FROM volume_cover_salvage_event
       ORDER BY triggered_at DESC
       LIMIT $1
     ) recent`,
    [rollingCount]
  );
  const row = r.rows[0];
  const cnt = Number(row.cnt);
  return {
    count: cnt,
    avgSalvagePct: cnt > 0 ? Number(row.avg_salvage) : null,
    totalNetLossUsdc: Number(row.total_loss ?? 0),
    avgPayoutUsdc: cnt > 0 ? Number(row.avg_payout) : null
  };
};

export const countTriggersInWindow = async (
  pool: DbExecutor,
  windowHours: number
): Promise<number> => {
  const r = await pool.query(
    `SELECT COUNT(*) AS cnt FROM volume_cover_salvage_event
     WHERE triggered_at >= NOW() - ($1 || ' hours')::interval`,
    [String(windowHours)]
  );
  return Number(r.rows[0].cnt);
};

export const sumNetLossInWindow = async (
  pool: DbExecutor,
  windowHours: number
): Promise<number> => {
  const r = await pool.query(
    `SELECT COALESCE(SUM(net_atticus_loss_usdc), 0) AS total
     FROM volume_cover_salvage_event
     WHERE triggered_at >= NOW() - ($1 || ' hours')::interval`,
    [String(windowHours)]
  );
  return Number(r.rows[0].total);
};

// ────────────────────── Type aliases for external consumers ──────────────────────

export type { CellId };
