/**
 * Volume Cover hedge pool architecture (2026-05-23).
 *
 * Atticus has full hedge pool authority (Item 3, 2026-05-22 product
 * spec). One Bullish [DB] spread can protect MULTIPLE sequential
 * Foxify positions when their bands overlap AND the hedge has
 * remaining payout capacity + sufficient expiry life.
 *
 * Two tables:
 *
 *   volume_cover_bullish_hedge_pool    — one row per open Bullish spread
 *   volume_cover_hedge_pool_links      — many-to-one linkage from a
 *                                        Foxify cycle to a pool entry
 *
 * Pool lifecycle:
 *
 *   1. Spread opens (by executor or test) → INSERT pool row
 *      status='active', remaining_payout_capacity_usdc = spread payout cap
 *   2. Foxify cycle starts, query getApplicableHedgeForBand(...)
 *      returns the best matching pool row (band ⊃ new band, expiry
 *      ≥ now + minLifetimeMs, capacity > 0)
 *   3. On match: INSERT link row (no Bullish orders sent — reuse pool)
 *   4. On trigger: decrement capacity, set status='consumed' (Item 1:
 *      close-both — both Foxify protections close; pool spread's
 *      payout cap is consumed for this trigger; Atticus may still
 *      salvage the legs)
 *   5. On Foxify cycle close without trigger: unlink (pool stays
 *      'active' and ready for the next cycle)
 *   6. Expiry-cron: pool rows whose expiry_iso < now+gracePeriod are
 *      marked 'expired'; executor closes them at next sweep
 *
 * Expected efficiency gain at 25% per-day trigger rate:
 *   average cycles protected per hedge ≈ 2.7
 *   friction per Foxify cycle: $60 → $22
 *   net savings per cell: ~$1140/month
 */

import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

// ─── Types ───────────────────────────────────────────────────────────

export type HedgePoolStatus = "active" | "consumed" | "expired" | "closed";

export type HedgePoolLegRecord = {
  symbol: string;
  side: "BUY" | "SELL";
  strikeUsdc: number;
  optionKind: "put" | "call";
  legRole: "long_put" | "short_put" | "long_call" | "short_call";
  fillPriceUsdc: number;
  contractsBtc: number;
  bullishOrderId: string | null;
};

export type HedgePoolRow = {
  hedgeId: string;
  createdAtIso: string;
  expiryIso: string;
  coverageBandLowUsdc: number;
  coverageBandHighUsdc: number;
  totalContractsBtc: number;
  legs: HedgePoolLegRecord[];
  status: HedgePoolStatus;
  remainingPayoutCapacityUsdc: number;
  spreadGroupId: string;
  cellId: string | null;
  metadata: Record<string, unknown>;
  consumedAtIso: string | null;
  closedAtIso: string | null;
};

export type HedgePoolLinkRow = {
  linkId: string;
  hedgeId: string;
  foxifyPositionId: string;
  cycleId: string;
  linkedAtIso: string;
  unlinkedAtIso: string | null;
  unlinkReason: string | null;
};

// ─── Schema ──────────────────────────────────────────────────────────

export const ensureHedgePoolSchema = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS volume_cover_bullish_hedge_pool (
      hedge_id                          TEXT PRIMARY KEY,
      created_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expiry_iso                        TIMESTAMPTZ NOT NULL,
      coverage_band_low_usdc            NUMERIC(20, 8) NOT NULL,
      coverage_band_high_usdc           NUMERIC(20, 8) NOT NULL,
      total_contracts_btc               NUMERIC(20, 8) NOT NULL,
      legs                              JSONB NOT NULL,
      status                            TEXT NOT NULL DEFAULT 'active',
      remaining_payout_capacity_usdc    NUMERIC(20, 8) NOT NULL,
      spread_group_id                   TEXT NOT NULL,
      cell_id                           TEXT,
      metadata                          JSONB NOT NULL DEFAULT '{}'::jsonb,
      consumed_at                       TIMESTAMPTZ,
      closed_at                         TIMESTAMPTZ
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS volume_cover_hedge_pool_links (
      link_id                           TEXT PRIMARY KEY,
      hedge_id                          TEXT NOT NULL REFERENCES volume_cover_bullish_hedge_pool(hedge_id),
      foxify_position_id                TEXT NOT NULL,
      cycle_id                          TEXT NOT NULL,
      linked_at                         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      unlinked_at                       TIMESTAMPTZ,
      unlink_reason                     TEXT
    );
  `);
  const safeIdx = async (sql: string): Promise<void> => {
    try { await pool.query(sql); } catch { /* exists */ }
  };
  await safeIdx(`CREATE INDEX idx_vc_hp_status ON volume_cover_bullish_hedge_pool (status, expiry_iso)`);
  await safeIdx(`CREATE INDEX idx_vc_hp_band ON volume_cover_bullish_hedge_pool (coverage_band_low_usdc, coverage_band_high_usdc)`);
  await safeIdx(`CREATE INDEX idx_vc_hp_cell ON volume_cover_bullish_hedge_pool (cell_id)`);
  await safeIdx(`CREATE UNIQUE INDEX uniq_vc_hp_link_active ON volume_cover_hedge_pool_links (foxify_position_id) WHERE unlinked_at IS NULL`);
  await safeIdx(`CREATE INDEX idx_vc_hp_link_hedge ON volume_cover_hedge_pool_links (hedge_id, unlinked_at)`);
};

// ─── Pool insert/update ──────────────────────────────────────────────

export type InsertHedgePoolParams = {
  pool: Pool | PoolClient;
  hedgeId?: string;
  spreadGroupId: string;
  cellId?: string | null;
  expiryIso: string;
  coverageBandLowUsdc: number;
  coverageBandHighUsdc: number;
  totalContractsBtc: number;
  legs: HedgePoolLegRecord[];
  initialPayoutCapacityUsdc: number;
  metadata?: Record<string, unknown>;
};

export const insertHedgePoolEntry = async (params: InsertHedgePoolParams): Promise<string> => {
  const hedgeId = params.hedgeId ?? `vc-hp-${randomUUID()}`;
  await params.pool.query(
    `INSERT INTO volume_cover_bullish_hedge_pool
       (hedge_id, expiry_iso, coverage_band_low_usdc, coverage_band_high_usdc,
        total_contracts_btc, legs, status, remaining_payout_capacity_usdc,
        spread_group_id, cell_id, metadata)
     VALUES ($1, $2::timestamptz, $3, $4, $5, $6::jsonb, 'active', $7, $8, $9, $10::jsonb)`,
    [
      hedgeId,
      params.expiryIso,
      params.coverageBandLowUsdc,
      params.coverageBandHighUsdc,
      params.totalContractsBtc,
      JSON.stringify(params.legs),
      params.initialPayoutCapacityUsdc,
      params.spreadGroupId,
      params.cellId ?? null,
      JSON.stringify(params.metadata ?? {})
    ]
  );
  return hedgeId;
};

const parsePoolRow = (row: Record<string, unknown>): HedgePoolRow => ({
  hedgeId: String(row.hedge_id),
  createdAtIso: new Date(row.created_at as string | Date).toISOString(),
  expiryIso: new Date(row.expiry_iso as string | Date).toISOString(),
  coverageBandLowUsdc: Number(row.coverage_band_low_usdc),
  coverageBandHighUsdc: Number(row.coverage_band_high_usdc),
  totalContractsBtc: Number(row.total_contracts_btc),
  legs: Array.isArray(row.legs) ? (row.legs as HedgePoolLegRecord[]) : [],
  status: row.status as HedgePoolStatus,
  remainingPayoutCapacityUsdc: Number(row.remaining_payout_capacity_usdc),
  spreadGroupId: String(row.spread_group_id),
  cellId: row.cell_id ? String(row.cell_id) : null,
  metadata: (row.metadata as Record<string, unknown>) ?? {},
  consumedAtIso: row.consumed_at ? new Date(row.consumed_at as string | Date).toISOString() : null,
  closedAtIso: row.closed_at ? new Date(row.closed_at as string | Date).toISOString() : null
});

// ─── Selection query ─────────────────────────────────────────────────

export type GetApplicableHedgeParams = {
  pool: Pool;
  /** New Foxify position's band lower edge (strict). */
  newBandLowUsdc: number;
  /** New Foxify position's band upper edge (strict). */
  newBandHighUsdc: number;
  /** Minimum hedge expiry lifetime remaining (ms). e.g. 24h = 86_400_000. */
  minLifetimeMs: number;
  /** Required remaining payout capacity (e.g. cell payoutUsdc). */
  requiredCapacityUsdc: number;
  cellId?: string | null;
  nowMs?: number;
};

/**
 * Find an existing active hedge pool entry that fully covers the new
 * band and has sufficient capacity + expiry life. Returns the BEST
 * match (= closest band fit minimizes wasted capacity).
 *
 * Returns null if no match.
 */
export const getApplicableHedgeForBand = async (
  params: GetApplicableHedgeParams
): Promise<HedgePoolRow | null> => {
  const nowMs = params.nowMs ?? Date.now();
  const minExpiryIso = new Date(nowMs + params.minLifetimeMs).toISOString();

  const wheres: string[] = [
    `status = 'active'`,
    `coverage_band_low_usdc <= $1`,
    `coverage_band_high_usdc >= $2`,
    `expiry_iso >= $3::timestamptz`,
    `remaining_payout_capacity_usdc >= $4`
  ];
  const args: unknown[] = [
    params.newBandLowUsdc,
    params.newBandHighUsdc,
    minExpiryIso,
    params.requiredCapacityUsdc
  ];
  if (params.cellId) {
    args.push(params.cellId);
    wheres.push(`(cell_id IS NULL OR cell_id = $${args.length})`);
  }

  const r = await params.pool.query(
    `SELECT hedge_id, created_at, expiry_iso, coverage_band_low_usdc,
            coverage_band_high_usdc, total_contracts_btc, legs, status,
            remaining_payout_capacity_usdc, spread_group_id, cell_id,
            metadata, consumed_at, closed_at
       FROM volume_cover_bullish_hedge_pool
      WHERE ${wheres.join(" AND ")}
   ORDER BY
       (coverage_band_high_usdc - coverage_band_low_usdc) ASC,
       remaining_payout_capacity_usdc DESC,
       expiry_iso ASC
      LIMIT 1`,
    args
  );
  if (r.rows.length === 0) return null;
  return parsePoolRow(r.rows[0]);
};

// ─── Linking ─────────────────────────────────────────────────────────

export type LinkParams = {
  pool: Pool | PoolClient;
  hedgeId: string;
  foxifyPositionId: string;
  cycleId: string;
};

export const linkPositionToHedge = async (params: LinkParams): Promise<string> => {
  const linkId = `vc-hpl-${randomUUID()}`;
  await params.pool.query(
    `INSERT INTO volume_cover_hedge_pool_links
       (link_id, hedge_id, foxify_position_id, cycle_id)
     VALUES ($1, $2, $3, $4)`,
    [linkId, params.hedgeId, params.foxifyPositionId, params.cycleId]
  );
  return linkId;
};

export type UnlinkParams = {
  pool: Pool | PoolClient;
  foxifyPositionId: string;
  reason: "cycle_closed" | "trigger_consumed" | "expired" | "replaced" | "manual_admin";
  nowMs?: number;
};

export const unlinkPosition = async (params: UnlinkParams): Promise<boolean> => {
  const nowIso = new Date(params.nowMs ?? Date.now()).toISOString();
  const r = await params.pool.query(
    `UPDATE volume_cover_hedge_pool_links
        SET unlinked_at = $2::timestamptz, unlink_reason = $3
      WHERE foxify_position_id = $1 AND unlinked_at IS NULL
      RETURNING link_id`,
    [params.foxifyPositionId, nowIso, params.reason]
  );
  return (r.rowCount ?? 0) > 0;
};

// ─── Consumption / closure ───────────────────────────────────────────

export type ConsumeHedgeParams = {
  pool: Pool | PoolClient;
  hedgeId: string;
  consumedAmountUsdc: number;
  nowMs?: number;
};

/**
 * Decrement remaining payout capacity by consumedAmountUsdc. When
 * remaining hits zero, transition status to 'consumed' and stamp
 * consumed_at. Returns the post-update capacity.
 */
export const consumeHedgeCapacity = async (
  params: ConsumeHedgeParams
): Promise<{ remainingCapacityUsdc: number; status: HedgePoolStatus } | null> => {
  const nowIso = new Date(params.nowMs ?? Date.now()).toISOString();
  const r = await params.pool.query<{
    remaining_payout_capacity_usdc: string;
    status: HedgePoolStatus;
  }>(
    `UPDATE volume_cover_bullish_hedge_pool
        SET remaining_payout_capacity_usdc =
              GREATEST(0, remaining_payout_capacity_usdc - $2::numeric),
            status = CASE
              WHEN remaining_payout_capacity_usdc - $2::numeric <= 0 THEN 'consumed'
              ELSE status
            END,
            consumed_at = CASE
              WHEN remaining_payout_capacity_usdc - $2::numeric <= 0 THEN $3::timestamptz
              ELSE consumed_at
            END
      WHERE hedge_id = $1
      RETURNING remaining_payout_capacity_usdc, status`,
    [params.hedgeId, params.consumedAmountUsdc, nowIso]
  );
  if (r.rows.length === 0) return null;
  return {
    remainingCapacityUsdc: Number(r.rows[0].remaining_payout_capacity_usdc),
    status: r.rows[0].status
  };
};

export type MarkClosedParams = {
  pool: Pool | PoolClient;
  hedgeId: string;
  reason: "manual" | "expired" | "executor_close";
  nowMs?: number;
};

export const markHedgePoolClosed = async (params: MarkClosedParams): Promise<boolean> => {
  const nowIso = new Date(params.nowMs ?? Date.now()).toISOString();
  const r = await params.pool.query(
    `UPDATE volume_cover_bullish_hedge_pool
        SET status = 'closed', closed_at = $2::timestamptz,
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('close_reason', $3::text)
      WHERE hedge_id = $1 AND status != 'closed'
      RETURNING hedge_id`,
    [params.hedgeId, nowIso, params.reason]
  );
  return (r.rowCount ?? 0) > 0;
};

// ─── Reporting ───────────────────────────────────────────────────────

export const listActiveHedges = async (params: {
  pool: Pool;
  cellId?: string;
}): Promise<HedgePoolRow[]> => {
  const args: unknown[] = [];
  let cellFilter = "";
  if (params.cellId) {
    args.push(params.cellId);
    cellFilter = ` AND (cell_id IS NULL OR cell_id = $${args.length})`;
  }
  const r = await params.pool.query(
    `SELECT hedge_id, created_at, expiry_iso, coverage_band_low_usdc,
            coverage_band_high_usdc, total_contracts_btc, legs, status,
            remaining_payout_capacity_usdc, spread_group_id, cell_id,
            metadata, consumed_at, closed_at
       FROM volume_cover_bullish_hedge_pool
      WHERE status = 'active' ${cellFilter}
   ORDER BY created_at DESC`,
    args
  );
  return r.rows.map(parsePoolRow);
};

export const listLinksForHedge = async (params: {
  pool: Pool;
  hedgeId: string;
  activeOnly?: boolean;
}): Promise<HedgePoolLinkRow[]> => {
  const whereActive = params.activeOnly ? " AND unlinked_at IS NULL" : "";
  const r = await params.pool.query(
    `SELECT link_id, hedge_id, foxify_position_id, cycle_id, linked_at,
            unlinked_at, unlink_reason
       FROM volume_cover_hedge_pool_links
      WHERE hedge_id = $1 ${whereActive}
   ORDER BY linked_at DESC`,
    [params.hedgeId]
  );
  return r.rows.map((row) => ({
    linkId: String(row.link_id),
    hedgeId: String(row.hedge_id),
    foxifyPositionId: String(row.foxify_position_id),
    cycleId: String(row.cycle_id),
    linkedAtIso: new Date(row.linked_at).toISOString(),
    unlinkedAtIso: row.unlinked_at ? new Date(row.unlinked_at).toISOString() : null,
    unlinkReason: row.unlink_reason ?? null
  }));
};

export type HedgePoolEfficiencyMetrics = {
  totalActiveHedges: number;
  totalLinksLifetime: number;
  averageCyclesPerHedge: number;
  totalRemainingCapacityUsdc: number;
};

export const computeHedgePoolEfficiency = async (params: {
  pool: Pool;
}): Promise<HedgePoolEfficiencyMetrics> => {
  const hedgeCount = await params.pool.query<{ n: string; capacity: string }>(
    `SELECT COUNT(*)::bigint AS n,
            COALESCE(SUM(remaining_payout_capacity_usdc), 0)::numeric AS capacity
       FROM volume_cover_bullish_hedge_pool
      WHERE status = 'active'`
  );
  const linkCount = await params.pool.query<{ n: string }>(
    `SELECT COUNT(*)::bigint AS n FROM volume_cover_hedge_pool_links`
  );
  const allTimeHedges = await params.pool.query<{ n: string }>(
    `SELECT COUNT(*)::bigint AS n FROM volume_cover_bullish_hedge_pool`
  );

  const activeHedges = Number(hedgeCount.rows[0]?.n ?? 0);
  const lifetimeLinks = Number(linkCount.rows[0]?.n ?? 0);
  const lifetimeHedges = Number(allTimeHedges.rows[0]?.n ?? 0);
  const totalRemainingCapacity = Number(hedgeCount.rows[0]?.capacity ?? 0);

  return {
    totalActiveHedges: activeHedges,
    totalLinksLifetime: lifetimeLinks,
    averageCyclesPerHedge: lifetimeHedges > 0
      ? Number((lifetimeLinks / lifetimeHedges).toFixed(2))
      : 0,
    totalRemainingCapacityUsdc: Number(totalRemainingCapacity.toFixed(2))
  };
};
