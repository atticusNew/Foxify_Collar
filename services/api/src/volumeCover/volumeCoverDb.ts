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

  // Index creation — best-effort, pg-mem compatible.
  const safeIdx = async (sql: string): Promise<void> => {
    try { await pool.query(sql); } catch { /* index may already exist */ }
  };
  await safeIdx(`CREATE INDEX idx_volume_cover_position_status ON volume_cover_position (status)`);
  await safeIdx(`CREATE INDEX idx_volume_cover_position_cell ON volume_cover_position (cell_id, opened_at)`);
  await safeIdx(`CREATE INDEX idx_volume_cover_position_pair ON volume_cover_position (foxify_pair_id)`);
  await safeIdx(`CREATE INDEX idx_volume_cover_hedge_position ON volume_cover_hedge_leg (position_id, status)`);
  await safeIdx(`CREATE INDEX idx_volume_cover_salvage_pos ON volume_cover_salvage_event (position_id)`);
  await safeIdx(`CREATE INDEX idx_volume_cover_salvage_time ON volume_cover_salvage_event (triggered_at DESC)`);
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
        true, // all 6 enabled at Day 1 per rev 2
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
  sellPriceUsdc: r.sell_price_usdc !== null ? Number(r.sell_price_usdc) : null,
  sellOrderId: r.sell_order_id ? String(r.sell_order_id) : null,
  status: String(r.status) as HedgeLegRow["status"],
  openedAt: String(r.opened_at),
  closedAt: r.closed_at ? String(r.closed_at) : null,
  metadata: typeof r.metadata === "string" ? JSON.parse(r.metadata) : (r.metadata ?? {})
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
