import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

type Queryable = Pick<Pool, "query">;

let schemaReady = false;

export const ensureTreasurySchema = async (pool: Queryable): Promise<void> => {
  if (schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS treasury_protections (
      id TEXT PRIMARY KEY,
      cycle_date DATE NOT NULL,
      status TEXT NOT NULL,
      notional_usd NUMERIC(28,10) NOT NULL,
      floor_pct NUMERIC(10,6) NOT NULL,
      entry_price NUMERIC(28,10),
      floor_price NUMERIC(28,10),
      strike NUMERIC(28,10),
      instrument_id TEXT,
      venue TEXT,
      tenor_days INTEGER NOT NULL DEFAULT 1,
      premium_usd NUMERIC(28,10),
      hedge_cost_usd NUMERIC(28,10),
      spread_usd NUMERIC(28,10),
      triggered BOOLEAN NOT NULL DEFAULT FALSE,
      trigger_price NUMERIC(28,10),
      trigger_at TIMESTAMPTZ,
      payout_usd NUMERIC(28,10),
      tp_sold BOOLEAN NOT NULL DEFAULT FALSE,
      tp_proceeds_usd NUMERIC(28,10),
      tp_sold_at TIMESTAMPTZ,
      settled BOOLEAN NOT NULL DEFAULT FALSE,
      expiry_at TIMESTAMPTZ,
      external_order_id TEXT,
      execution_details JSONB NOT NULL DEFAULT '{}'::jsonb,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS treasury_config_state (
      id TEXT PRIMARY KEY DEFAULT 'singleton',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      paused BOOLEAN NOT NULL DEFAULT FALSE,
      paused_at TIMESTAMPTZ,
      resumed_at TIMESTAMPTZ,
      notional_usd NUMERIC(28,10) NOT NULL DEFAULT 1000000,
      floor_pct NUMERIC(10,6) NOT NULL DEFAULT 2.0,
      last_cycle_date DATE,
      last_execution_at TIMESTAMPTZ,
      total_premiums_usd NUMERIC(28,10) NOT NULL DEFAULT 0,
      total_hedge_costs_usd NUMERIC(28,10) NOT NULL DEFAULT 0,
      total_payouts_usd NUMERIC(28,10) NOT NULL DEFAULT 0,
      total_tp_proceeds_usd NUMERIC(28,10) NOT NULL DEFAULT 0,
      total_cycles INTEGER NOT NULL DEFAULT 0,
      total_triggers INTEGER NOT NULL DEFAULT 0,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    INSERT INTO treasury_config_state (id, active, paused, notional_usd, floor_pct)
    VALUES ('singleton', true, false, 1000000, 2.0)
    ON CONFLICT (id) DO NOTHING;

    CREATE INDEX IF NOT EXISTS treasury_protections_cycle_date_idx
      ON treasury_protections(cycle_date DESC);
    CREATE INDEX IF NOT EXISTS treasury_protections_status_idx
      ON treasury_protections(status);
  `);
  schemaReady = true;
};

export type TreasuryProtection = {
  id: string;
  cycleDate: string;
  status: string;
  notionalUsd: string;
  floorPct: string;
  entryPrice: string | null;
  floorPrice: string | null;
  strike: string | null;
  instrumentId: string | null;
  venue: string | null;
  tenorDays: number;
  premiumUsd: string | null;
  hedgeCostUsd: string | null;
  spreadUsd: string | null;
  triggered: boolean;
  triggerPrice: string | null;
  triggerAt: string | null;
  payoutUsd: string | null;
  tpSold: boolean;
  tpProceedsUsd: string | null;
  tpSoldAt: string | null;
  settled: boolean;
  expiryAt: string | null;
  externalOrderId: string | null;
  executionDetails: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

const mapRow = (row: Record<string, unknown>): TreasuryProtection => ({
  id: String(row.id),
  cycleDate: String(row.cycle_date),
  status: String(row.status),
  notionalUsd: String(row.notional_usd),
  floorPct: String(row.floor_pct),
  entryPrice: row.entry_price ? String(row.entry_price) : null,
  floorPrice: row.floor_price ? String(row.floor_price) : null,
  strike: row.strike ? String(row.strike) : null,
  instrumentId: row.instrument_id ? String(row.instrument_id) : null,
  venue: row.venue ? String(row.venue) : null,
  tenorDays: Number(row.tenor_days || 1),
  premiumUsd: row.premium_usd ? String(row.premium_usd) : null,
  hedgeCostUsd: row.hedge_cost_usd ? String(row.hedge_cost_usd) : null,
  spreadUsd: row.spread_usd ? String(row.spread_usd) : null,
  triggered: Boolean(row.triggered),
  triggerPrice: row.trigger_price ? String(row.trigger_price) : null,
  triggerAt: row.trigger_at ? new Date(String(row.trigger_at)).toISOString() : null,
  payoutUsd: row.payout_usd ? String(row.payout_usd) : null,
  tpSold: Boolean(row.tp_sold),
  tpProceedsUsd: row.tp_proceeds_usd ? String(row.tp_proceeds_usd) : null,
  tpSoldAt: row.tp_sold_at ? new Date(String(row.tp_sold_at)).toISOString() : null,
  settled: Boolean(row.settled),
  expiryAt: row.expiry_at ? new Date(String(row.expiry_at)).toISOString() : null,
  externalOrderId: row.external_order_id ? String(row.external_order_id) : null,
  executionDetails: (row.execution_details || {}) as Record<string, unknown>,
  metadata: (row.metadata || {}) as Record<string, unknown>,
  createdAt: new Date(String(row.created_at)).toISOString(),
  updatedAt: new Date(String(row.updated_at)).toISOString()
});

export type TreasuryState = {
  active: boolean;
  paused: boolean;
  pausedAt: string | null;
  resumedAt: string | null;
  notionalUsd: string;
  floorPct: string;
  lastCycleDate: string | null;
  lastExecutionAt: string | null;
  totalPremiumsUsd: string;
  totalHedgeCostsUsd: string;
  totalPayoutsUsd: string;
  totalTpProceedsUsd: string;
  totalCycles: number;
  totalTriggers: number;
};

export const getTreasuryState = async (pool: Queryable): Promise<TreasuryState> => {
  const result = await pool.query(`SELECT * FROM treasury_config_state WHERE id = 'singleton'`);
  const row = result.rows[0] as Record<string, unknown>;
  return {
    active: Boolean(row.active),
    paused: Boolean(row.paused),
    pausedAt: row.paused_at ? new Date(String(row.paused_at)).toISOString() : null,
    resumedAt: row.resumed_at ? new Date(String(row.resumed_at)).toISOString() : null,
    notionalUsd: String(row.notional_usd),
    floorPct: String(row.floor_pct),
    lastCycleDate: row.last_cycle_date ? String(row.last_cycle_date) : null,
    lastExecutionAt: row.last_execution_at ? new Date(String(row.last_execution_at)).toISOString() : null,
    totalPremiumsUsd: String(row.total_premiums_usd),
    totalHedgeCostsUsd: String(row.total_hedge_costs_usd),
    totalPayoutsUsd: String(row.total_payouts_usd),
    totalTpProceedsUsd: String(row.total_tp_proceeds_usd),
    totalCycles: Number(row.total_cycles),
    totalTriggers: Number(row.total_triggers)
  };
};

export const updateTreasuryState = async (
  pool: Queryable,
  patch: Record<string, unknown>
): Promise<void> => {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (!entries.length) return;
  const fields = entries.map(([key], idx) => `${key} = $${idx + 1}`);
  fields.push("updated_at = NOW()");
  const values = entries.map(([, v]) => v);
  await pool.query(
    `UPDATE treasury_config_state SET ${fields.join(", ")} WHERE id = 'singleton'`,
    values
  );
};

export const insertTreasuryProtection = async (
  pool: Queryable,
  input: {
    cycleDate: string;
    notionalUsd: string;
    floorPct: string;
    entryPrice: string;
    floorPrice: string;
    strike: string;
    instrumentId: string;
    venue: string;
    tenorDays: number;
    premiumUsd: string;
    hedgeCostUsd: string;
    spreadUsd: string;
    expiryAt: string;
    externalOrderId: string;
    executionDetails: Record<string, unknown>;
  }
): Promise<TreasuryProtection> => {
  const id = randomUUID();
  const result = await pool.query(
    `INSERT INTO treasury_protections (
      id, cycle_date, status, notional_usd, floor_pct, entry_price, floor_price, strike,
      instrument_id, venue, tenor_days, premium_usd, hedge_cost_usd, spread_usd,
      expiry_at, external_order_id, execution_details
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
    RETURNING *`,
    [
      id, input.cycleDate, "active", input.notionalUsd, input.floorPct,
      input.entryPrice, input.floorPrice, input.strike, input.instrumentId,
      input.venue, input.tenorDays, input.premiumUsd, input.hedgeCostUsd,
      input.spreadUsd, input.expiryAt, input.externalOrderId,
      JSON.stringify(input.executionDetails)
    ]
  );
  return mapRow(result.rows[0]);
};

export const getTreasuryProtectionHistory = async (
  pool: Queryable,
  limit = 30
): Promise<TreasuryProtection[]> => {
  const result = await pool.query(
    `SELECT * FROM treasury_protections ORDER BY cycle_date DESC, created_at DESC LIMIT $1`,
    [Math.min(limit, 365)]
  );
  return result.rows.map(mapRow);
};

export const getActiveTreasuryProtection = async (
  pool: Queryable
): Promise<TreasuryProtection | null> => {
  const result = await pool.query(
    `SELECT * FROM treasury_protections WHERE status = 'active' ORDER BY created_at DESC LIMIT 1`
  );
  return result.rows.length ? mapRow(result.rows[0]) : null;
};

export const patchTreasuryProtection = async (
  pool: Queryable,
  id: string,
  patch: Record<string, unknown>
): Promise<void> => {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (!entries.length) return;
  const fields = entries.map(([key], idx) => `${key} = $${idx + 1}`);
  fields.push("updated_at = NOW()");
  const values = entries.map(([, v]) => v);
  values.push(id);
  await pool.query(
    `UPDATE treasury_protections SET ${fields.join(", ")} WHERE id = $${values.length}`,
    values
  );
};
