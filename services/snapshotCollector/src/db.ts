import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type {
  ActivePositionsDetailResponse,
  AllOpenLegsResponse,
  DashboardResponse,
  EndpointKind,
  HealthResponse,
  HedgeManagerDryRunResponse,
  PoolLedgerResponse
} from "./types.js";
import type { DerivedPosition, DerivedDailyMetrics } from "./metrics.js";

const { Pool } = pg;

let cachedPool: pg.Pool | null = null;

export const getPool = (): pg.Pool => {
  if (cachedPool) return cachedPool;
  const url = process.env.SNAPSHOT_POSTGRES_URL ?? process.env.POSTGRES_URL;
  if (!url) throw new Error("missing_env:SNAPSHOT_POSTGRES_URL");
  cachedPool = new Pool({
    connectionString: url,
    max: parseInt(process.env.SNAPSHOT_DB_POOL_MAX ?? "4", 10),
    idleTimeoutMillis: 10_000,
    ssl: url.includes("render.com") || process.env.SNAPSHOT_DB_SSL === "true"
      ? { rejectUnauthorized: false }
      : undefined
  });
  return cachedPool;
};

export const closePool = async (): Promise<void> => {
  if (cachedPool) {
    await cachedPool.end();
    cachedPool = null;
  }
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const runMigrations = async (): Promise<void> => {
  const sql = readFileSync(join(__dirname, "..", "migrations", "001_init.sql"), "utf8");
  const pool = getPool();
  await pool.query(sql);
};

export const startRun = async (
  sourceUrl: string,
  pollKind: "full" | "fast" | "manual"
): Promise<number> => {
  const pool = getPool();
  const res = await pool.query<{ id: number }>(
    `INSERT INTO snapshot_run (source_url, poll_kind) VALUES ($1, $2) RETURNING id`,
    [sourceUrl, pollKind]
  );
  return res.rows[0]!.id;
};

export const completeRun = async (
  runId: number,
  ok: boolean,
  errorMessage: string | null
): Promise<void> => {
  const pool = getPool();
  await pool.query(
    `UPDATE snapshot_run SET completed_at = now(), ok = $2, error_message = $3 WHERE id = $1`,
    [runId, ok, errorMessage]
  );
};

export const insertRaw = async (
  runId: number,
  endpoint: EndpointKind,
  httpStatus: number,
  payload: unknown
): Promise<void> => {
  const pool = getPool();
  await pool.query(
    `INSERT INTO snapshot_raw (run_id, endpoint, http_status, payload_jsonb) VALUES ($1, $2, $3, $4)`,
    [runId, endpoint, httpStatus, JSON.stringify(payload ?? null)]
  );
};

export const insertDerivedPositions = async (
  runId: number,
  positions: ReadonlyArray<DerivedPosition>
): Promise<void> => {
  if (positions.length === 0) return;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const p of positions) {
      await client.query(
        `INSERT INTO snapshot_position (
          run_id, position_id, cell_id, status, salvage_state,
          trigger_high_btc, trigger_low_btc, payout_usdc, daily_premium_usdc,
          hedge_buy_usdc, hedge_sell_usdc, realized_salvage_pct,
          total_legs, open_legs, sold_legs, failed_legs
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
        )`,
        [
          runId,
          p.positionId,
          p.cellId,
          p.status,
          p.salvageState,
          p.triggerHighBtc,
          p.triggerLowBtc,
          p.payoutUsdc,
          p.dailyPremiumUsdc,
          p.hedgeBuyUsdc,
          p.hedgeSellUsdc,
          p.realizedSalvagePct,
          p.totalLegs,
          p.openLegs,
          p.soldLegs,
          p.failedLegs
        ]
      );
      for (const leg of p.legs) {
        await client.query(
          `INSERT INTO snapshot_leg (
            run_id, leg_id, position_id, venue, option_kind, strike_usdc,
            expiry_iso, contracts_btc, status, buy_fill_price_usdc, sell_fill_price_usdc
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
          )`,
          [
            runId,
            leg.legId,
            p.positionId,
            leg.venue,
            leg.optionKind,
            leg.strikeUsdc,
            leg.expiryIso,
            leg.contractsBtc,
            leg.status,
            leg.buyFillPriceUsdc,
            leg.sellFillPriceUsdc
          ]
        );
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

export const insertHealth = async (
  runId: number,
  health: HealthResponse | null,
  dashboard: DashboardResponse | null
): Promise<void> => {
  const pool = getPool();
  await pool.query(
    `INSERT INTO snapshot_health (
      run_id, halted, active_position_count, spot_btc_usdc, guard_statuses_jsonb
    ) VALUES ($1, $2, $3, $4, $5)`,
    [
      runId,
      dashboard?.halted ?? null,
      dashboard?.activePositions ?? null,
      health?.spotBtcUsdc ?? null,
      JSON.stringify((dashboard as Record<string, unknown> | null)?.["guardStatuses"] ?? null)
    ]
  );
};

export const insertPoolLedger = async (
  runId: number,
  poolId: "atticus_hedge" | "foxify_trader",
  ledger: PoolLedgerResponse | null
): Promise<void> => {
  if (!ledger?.entries || ledger.entries.length === 0) return;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const e of ledger.entries) {
      await client.query(
        `INSERT INTO snapshot_pool_ledger (
          run_id, pool_id, entry_id, ts, kind, amount_usdc,
          position_id, leg_id, metadata_jsonb
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9
        )`,
        [
          runId,
          poolId,
          e.id ?? null,
          e.ts ?? null,
          e.kind ?? null,
          e.amountUsdc ?? null,
          e.positionId ?? null,
          e.legId ?? null,
          JSON.stringify(e)
        ]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

export const insertRuleFirings = async (
  runId: number,
  hm: HedgeManagerDryRunResponse | null
): Promise<void> => {
  if (!hm?.actions || hm.actions.length === 0) return;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const a of hm.actions) {
      await client.query(
        `INSERT INTO snapshot_rule_firing (run_id, leg_id, rule, action, reason)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          runId,
          a.legId ?? null,
          a.rule ?? null,
          a.action ?? null,
          a.reason ?? null
        ]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

export const upsertDailyMetrics = async (m: DerivedDailyMetrics): Promise<void> => {
  const pool = getPool();
  await pool.query(
    `INSERT INTO daily_metrics (
      date_utc, cells_observed_jsonb, closed_positions_count, triggered_count,
      no_trigger_count, failed_count, avg_salvage_pct, median_salvage_pct,
      total_premium_in_usdc, total_hedge_buy_usdc, total_hedge_sell_usdc,
      total_payout_out_usdc, net_atticus_pnl_usdc, rule_firing_count_jsonb,
      computed_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now()
    )
    ON CONFLICT (date_utc) DO UPDATE SET
      cells_observed_jsonb = EXCLUDED.cells_observed_jsonb,
      closed_positions_count = EXCLUDED.closed_positions_count,
      triggered_count = EXCLUDED.triggered_count,
      no_trigger_count = EXCLUDED.no_trigger_count,
      failed_count = EXCLUDED.failed_count,
      avg_salvage_pct = EXCLUDED.avg_salvage_pct,
      median_salvage_pct = EXCLUDED.median_salvage_pct,
      total_premium_in_usdc = EXCLUDED.total_premium_in_usdc,
      total_hedge_buy_usdc = EXCLUDED.total_hedge_buy_usdc,
      total_hedge_sell_usdc = EXCLUDED.total_hedge_sell_usdc,
      total_payout_out_usdc = EXCLUDED.total_payout_out_usdc,
      net_atticus_pnl_usdc = EXCLUDED.net_atticus_pnl_usdc,
      rule_firing_count_jsonb = EXCLUDED.rule_firing_count_jsonb,
      computed_at = now()`,
    [
      m.dateUtc,
      JSON.stringify(m.cellsObserved),
      m.closedPositionsCount,
      m.triggeredCount,
      m.noTriggerCount,
      m.failedCount,
      m.avgSalvagePct,
      m.medianSalvagePct,
      m.totalPremiumInUsdc,
      m.totalHedgeBuyUsdc,
      m.totalHedgeSellUsdc,
      m.totalPayoutOutUsdc,
      m.netAtticusPnlUsdc,
      JSON.stringify(m.ruleFiringCounts)
    ]
  );
};
