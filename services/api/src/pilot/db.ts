import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import Decimal from "decimal.js";
import type {
  ExecutionQualityRecord,
  HedgeMode,
  LedgerEntryType,
  OptionsChainSnapshotRecord,
  PriceSnapshotRecord,
  PriceSnapshotType,
  PremiumPolicyDiagnostics,
  ProtectionRecord,
  ProtectionStatus,
  SimPositionRecord,
  SimPositionStatus,
  SimTreasuryEntryType,
  SimTreasuryLedgerRecord,
  TenorPolicyTenorRow,
  VenueFillRecord,
  VenueQuoteRecord,
  VenueExecution,
  VenueQuote
} from "./types";

let poolSingleton: Pool | null = null;
let schemaReady = false;
type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export const __setPilotPoolForTests = (pool: Pool | null): void => {
  poolSingleton = pool;
  schemaReady = false;
};

const toRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
};

export const getPilotPool = (connectionString: string): Pool => {
  if (poolSingleton) return poolSingleton;
  if (!connectionString) throw new Error("postgres_url_missing");
  const connectTimeoutMs = Number(process.env.PILOT_DB_CONNECT_TIMEOUT_MS || "3000");
  const queryTimeoutMs = Number(process.env.PILOT_DB_QUERY_TIMEOUT_MS || "7000");
  poolSingleton = new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: Number.isFinite(connectTimeoutMs) ? connectTimeoutMs : 3000,
    query_timeout: Number.isFinite(queryTimeoutMs) ? queryTimeoutMs : 7000
  });
  return poolSingleton;
};

export const ensurePilotSchema = async (pool: Queryable): Promise<void> => {
  if (schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pilot_protections (
      id TEXT PRIMARY KEY,
      user_hash TEXT NOT NULL,
      hash_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      tier_name TEXT,
      drawdown_floor_pct NUMERIC(10,6),
      floor_price NUMERIC(28,10),
      market_id TEXT NOT NULL,
      protected_notional NUMERIC(28,10) NOT NULL,
      foxify_exposure_notional NUMERIC(28,10) NOT NULL,
      entry_price NUMERIC(28,10),
      entry_price_source TEXT,
      entry_price_timestamp TIMESTAMPTZ,
      expiry_at TIMESTAMPTZ NOT NULL,
      expiry_price NUMERIC(28,10),
      expiry_price_source TEXT,
      expiry_price_timestamp TIMESTAMPTZ,
      auto_renew BOOLEAN NOT NULL DEFAULT FALSE,
      renew_window_minutes INTEGER NOT NULL DEFAULT 1440,
      venue TEXT,
      instrument_id TEXT,
      side TEXT,
      size NUMERIC(28,10),
      execution_price NUMERIC(28,10),
      premium NUMERIC(28,10),
      executed_at TIMESTAMPTZ,
      external_order_id TEXT,
      external_execution_id TEXT,
      payout_due_amount NUMERIC(28,10),
      payout_settled_amount NUMERIC(28,10),
      payout_settled_at TIMESTAMPTZ,
      payout_tx_ref TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE pilot_protections ADD COLUMN IF NOT EXISTS tier_name TEXT;
    ALTER TABLE pilot_protections ADD COLUMN IF NOT EXISTS drawdown_floor_pct NUMERIC(10,6);
    ALTER TABLE pilot_protections ADD COLUMN IF NOT EXISTS floor_price NUMERIC(28,10);
    ALTER TABLE pilot_protections ADD COLUMN IF NOT EXISTS sl_pct NUMERIC(10,4);
    ALTER TABLE pilot_protections ADD COLUMN IF NOT EXISTS hedge_status TEXT;
    ALTER TABLE pilot_protections ADD COLUMN IF NOT EXISTS regime TEXT;
    ALTER TABLE pilot_protections ADD COLUMN IF NOT EXISTS regime_source TEXT;
    ALTER TABLE pilot_protections ADD COLUMN IF NOT EXISTS dvol_at_purchase NUMERIC(10,4);

    CREATE TABLE IF NOT EXISTS pilot_price_snapshots (
      id TEXT PRIMARY KEY,
      protection_id TEXT NOT NULL REFERENCES pilot_protections(id) ON DELETE CASCADE,
      snapshot_type TEXT NOT NULL,
      price NUMERIC(28,10) NOT NULL,
      market_id TEXT NOT NULL,
      price_source TEXT NOT NULL,
      price_source_detail TEXT NOT NULL,
      endpoint_version TEXT NOT NULL,
      request_id TEXT NOT NULL,
      price_timestamp TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pilot_ledger_entries (
      id TEXT PRIMARY KEY,
      protection_id TEXT NOT NULL REFERENCES pilot_protections(id) ON DELETE CASCADE,
      entry_type TEXT NOT NULL,
      amount NUMERIC(28,10) NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USDC',
      reference TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      settled_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS pilot_venue_quotes (
      id TEXT PRIMARY KEY,
      protection_id TEXT,
      venue TEXT NOT NULL,
      quote_id TEXT NOT NULL,
      rfq_id TEXT,
      instrument_id TEXT NOT NULL,
      side TEXT NOT NULL,
      quantity NUMERIC(28,10) NOT NULL,
      premium NUMERIC(28,10) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      quote_ts TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      consumed_by_protection_id TEXT,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE pilot_venue_quotes ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;
    ALTER TABLE pilot_venue_quotes ADD COLUMN IF NOT EXISTS consumed_by_protection_id TEXT;

    CREATE TABLE IF NOT EXISTS pilot_venue_executions (
      id TEXT PRIMARY KEY,
      protection_id TEXT NOT NULL REFERENCES pilot_protections(id) ON DELETE CASCADE,
      venue TEXT NOT NULL,
      status TEXT NOT NULL,
      quote_id TEXT NOT NULL,
      rfq_id TEXT,
      instrument_id TEXT NOT NULL,
      side TEXT NOT NULL,
      quantity NUMERIC(28,10) NOT NULL,
      execution_price NUMERIC(28,10) NOT NULL,
      premium NUMERIC(28,10) NOT NULL,
      executed_at TIMESTAMPTZ NOT NULL,
      external_order_id TEXT NOT NULL,
      external_execution_id TEXT NOT NULL,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pilot_admin_actions (
      id TEXT PRIMARY KEY,
      protection_id TEXT,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      actor_ip TEXT,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pilot_user_day_locks (
      lock_key TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pilot_daily_usage (
      user_hash TEXT NOT NULL,
      day_start DATE NOT NULL,
      used_notional NUMERIC(28,10) NOT NULL DEFAULT 0,
      PRIMARY KEY (user_hash, day_start)
    );

    CREATE TABLE IF NOT EXISTS pilot_daily_treasury_subsidy_usage (
      user_hash TEXT NOT NULL,
      day_start DATE NOT NULL,
      used_subsidy NUMERIC(28,10) NOT NULL DEFAULT 0,
      PRIMARY KEY (user_hash, day_start)
    );

    CREATE TABLE IF NOT EXISTS pilot_sim_positions (
      id TEXT PRIMARY KEY,
      user_hash TEXT NOT NULL,
      hash_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      market_id TEXT NOT NULL,
      side TEXT NOT NULL,
      notional_usd NUMERIC(28,10) NOT NULL,
      entry_price NUMERIC(28,10) NOT NULL,
      tier_name TEXT,
      drawdown_floor_pct NUMERIC(10,6),
      floor_price NUMERIC(28,10),
      protection_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      protection_id TEXT REFERENCES pilot_protections(id) ON DELETE SET NULL,
      protection_premium_usd NUMERIC(28,10),
      protected_loss_usd NUMERIC(28,10),
      trigger_credited_usd NUMERIC(28,10) NOT NULL DEFAULT 0,
      trigger_credited_at TIMESTAMPTZ,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE pilot_sim_positions ADD COLUMN IF NOT EXISTS sl_pct NUMERIC(10,4);

    CREATE TABLE IF NOT EXISTS pilot_sim_treasury_ledger (
      id TEXT PRIMARY KEY,
      sim_position_id TEXT NOT NULL REFERENCES pilot_sim_positions(id) ON DELETE CASCADE,
      user_hash TEXT NOT NULL,
      protection_id TEXT REFERENCES pilot_protections(id) ON DELETE SET NULL,
      entry_type TEXT NOT NULL,
      amount_usd NUMERIC(28,10) NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pilot_terms_acceptances (
      id TEXT PRIMARY KEY,
      user_hash TEXT NOT NULL,
      hash_version INTEGER NOT NULL,
      terms_version TEXT NOT NULL,
      accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      accepted_ip TEXT,
      user_agent TEXT,
      source TEXT NOT NULL DEFAULT 'pilot_web',
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_hash, terms_version)
    );

    CREATE TABLE IF NOT EXISTS pilot_options_chain_snapshots (
      id TEXT PRIMARY KEY,
      venue TEXT NOT NULL,
      market_id TEXT NOT NULL,
      as_of_ts TIMESTAMPTZ NOT NULL,
      tenor_days NUMERIC(14,6),
      strike NUMERIC(28,10),
      option_right TEXT,
      bid NUMERIC(28,10),
      ask NUMERIC(28,10),
      mark NUMERIC(28,10),
      bid_size NUMERIC(28,10),
      ask_size NUMERIC(28,10),
      iv NUMERIC(28,10),
      delta NUMERIC(28,10),
      gamma NUMERIC(28,10),
      vega NUMERIC(28,10),
      theta NUMERIC(28,10),
      source_ref TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pilot_rfq_quotes (
      id TEXT PRIMARY KEY,
      venue TEXT NOT NULL,
      market_id TEXT NOT NULL,
      quote_id TEXT NOT NULL,
      rfq_id TEXT,
      instrument_id TEXT NOT NULL,
      side TEXT NOT NULL,
      quantity NUMERIC(28,10) NOT NULL,
      premium NUMERIC(28,10),
      expires_at TIMESTAMPTZ,
      quote_ts TIMESTAMPTZ NOT NULL,
      latency_ms INTEGER,
      status TEXT,
      source_ref TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pilot_rfq_fills (
      id TEXT PRIMARY KEY,
      venue TEXT NOT NULL,
      market_id TEXT NOT NULL,
      quote_id TEXT,
      rfq_id TEXT,
      fill_id TEXT NOT NULL,
      instrument_id TEXT NOT NULL,
      side TEXT NOT NULL,
      quantity NUMERIC(28,10) NOT NULL,
      fill_price NUMERIC(28,10) NOT NULL,
      premium NUMERIC(28,10),
      slippage_bps NUMERIC(18,8),
      status TEXT,
      fill_ts TIMESTAMPTZ NOT NULL,
      source_ref TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pilot_hedge_decisions (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      quote_id TEXT,
      venue TEXT NOT NULL,
      regime TEXT NOT NULL,
      selector_mode TEXT NOT NULL,
      selected_candidate_id TEXT NOT NULL,
      selected_hedge_mode TEXT NOT NULL,
      selected_strike NUMERIC(28,10),
      selected_tenor_days NUMERIC(14,6),
      selected_score NUMERIC(28,10),
      decision_reason TEXT,
      score_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
      candidate_set JSONB NOT NULL DEFAULT '[]'::jsonb,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pilot_execution_quality_daily (
      id TEXT PRIMARY KEY,
      venue TEXT NOT NULL,
      day DATE NOT NULL,
      hedge_mode TEXT NOT NULL DEFAULT 'default',
      avg_slippage_bps NUMERIC(18,8),
      p95_slippage_bps NUMERIC(18,8),
      fill_success_rate_pct NUMERIC(18,8),
      avg_spread_pct NUMERIC(18,8),
      avg_top_book_depth NUMERIC(18,8),
      sample_count INTEGER NOT NULL DEFAULT 0,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (day, venue, hedge_mode)
    );

    ALTER TABLE pilot_execution_quality_daily ADD COLUMN IF NOT EXISTS hedge_mode TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE pilot_execution_quality_daily ADD COLUMN IF NOT EXISTS fill_success_rate_pct NUMERIC(18,8);
    ALTER TABLE pilot_execution_quality_daily ADD COLUMN IF NOT EXISTS avg_spread_pct NUMERIC(18,8);
    ALTER TABLE pilot_execution_quality_daily ADD COLUMN IF NOT EXISTS avg_top_book_depth NUMERIC(18,8);
    ALTER TABLE pilot_execution_quality_daily ADD COLUMN IF NOT EXISTS sample_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE pilot_execution_quality_daily ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

    ALTER TABLE pilot_terms_acceptances ADD COLUMN IF NOT EXISTS accepted_ip TEXT;
    ALTER TABLE pilot_terms_acceptances ADD COLUMN IF NOT EXISTS user_agent TEXT;
    ALTER TABLE pilot_terms_acceptances ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'pilot_web';
    ALTER TABLE pilot_terms_acceptances ADD COLUMN IF NOT EXISTS details JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE pilot_terms_acceptances ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE pilot_terms_acceptances ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

    CREATE INDEX IF NOT EXISTS pilot_protections_status_idx ON pilot_protections(status);
    CREATE INDEX IF NOT EXISTS pilot_protections_expiry_idx ON pilot_protections(expiry_at);
    CREATE INDEX IF NOT EXISTS pilot_protections_user_hash_created_idx ON pilot_protections(user_hash, created_at);
    CREATE INDEX IF NOT EXISTS pilot_ledger_entries_protection_idx ON pilot_ledger_entries(protection_id);
    CREATE INDEX IF NOT EXISTS pilot_price_snapshots_protection_idx ON pilot_price_snapshots(protection_id);
    CREATE INDEX IF NOT EXISTS pilot_venue_quotes_quote_id_idx ON pilot_venue_quotes(quote_id);
    CREATE INDEX IF NOT EXISTS pilot_venue_executions_protection_idx ON pilot_venue_executions(protection_id);
    CREATE UNIQUE INDEX IF NOT EXISTS pilot_venue_quotes_venue_quote_id_uidx ON pilot_venue_quotes(venue, quote_id);
    CREATE UNIQUE INDEX IF NOT EXISTS pilot_terms_acceptances_user_terms_uidx
      ON pilot_terms_acceptances(user_hash, terms_version);
    CREATE INDEX IF NOT EXISTS pilot_terms_acceptances_accepted_at_idx
      ON pilot_terms_acceptances(accepted_at DESC);
    CREATE INDEX IF NOT EXISTS pilot_sim_positions_user_hash_created_idx
      ON pilot_sim_positions(user_hash, created_at DESC);
    CREATE INDEX IF NOT EXISTS pilot_sim_positions_status_idx
      ON pilot_sim_positions(status);
    CREATE INDEX IF NOT EXISTS pilot_sim_treasury_ledger_user_hash_created_idx
      ON pilot_sim_treasury_ledger(user_hash, created_at DESC);
    CREATE INDEX IF NOT EXISTS pilot_sim_treasury_ledger_position_idx
      ON pilot_sim_treasury_ledger(sim_position_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS pilot_options_chain_snapshots_venue_asof_idx
      ON pilot_options_chain_snapshots(venue, as_of_ts DESC);
    CREATE INDEX IF NOT EXISTS pilot_options_chain_snapshots_market_idx
      ON pilot_options_chain_snapshots(market_id, as_of_ts DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS pilot_rfq_quotes_venue_quote_uidx
      ON pilot_rfq_quotes(venue, quote_id);
    CREATE INDEX IF NOT EXISTS pilot_rfq_quotes_rfq_idx
      ON pilot_rfq_quotes(rfq_id, quote_ts DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS pilot_rfq_fills_venue_fill_uidx
      ON pilot_rfq_fills(venue, fill_id);
    CREATE INDEX IF NOT EXISTS pilot_rfq_fills_quote_idx
      ON pilot_rfq_fills(quote_id, fill_ts DESC);
    CREATE INDEX IF NOT EXISTS pilot_hedge_decisions_request_idx
      ON pilot_hedge_decisions(request_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS pilot_hedge_decisions_quote_idx
      ON pilot_hedge_decisions(quote_id, created_at DESC);
  `);
  schemaReady = true;
};

export const resetPilotData = async (pool: Queryable): Promise<{ tablesCleared: string[] }> => {
  const tables = [
    "pilot_ledger_entries",
    "pilot_price_snapshots",
    "pilot_venue_executions",
    "pilot_venue_quotes",
    "pilot_rfq_fills",
    "pilot_rfq_quotes",
    "pilot_options_chain_snapshots",
    "pilot_hedge_decisions",
    "pilot_execution_quality_daily",
    "pilot_sim_treasury_ledger",
    "pilot_sim_positions",
    "pilot_admin_actions",
    "pilot_daily_usage",
    "pilot_daily_treasury_subsidy_usage",
    "pilot_user_day_locks",
    "pilot_protections"
  ];
  for (const table of tables) {
    await pool.query(`DELETE FROM ${table}`);
  }
  console.log(`[DB] Pilot data reset: ${tables.length} tables cleared`);
  return { tablesCleared: tables };
};

export const insertProtection = async (
  pool: Queryable,
  input: {
    id?: string;
    userHash: string;
    hashVersion: number;
    status: ProtectionStatus;
    tierName?: string | null;
    drawdownFloorPct?: string | null;
    slPct?: number | null;
    hedgeStatus?: string | null;
    regime?: string | null;
    regimeSource?: string | null;
    dvolAtPurchase?: number | null;
    marketId: string;
    protectedNotional: string;
    foxifyExposureNotional: string;
    expiryAt: string;
    autoRenew: boolean;
    renewWindowMinutes: number;
    metadata?: Record<string, unknown>;
  }
): Promise<ProtectionRecord> => {
  const id = input.id || randomUUID();
  const v7Meta = {
    ...(input.metadata || {}),
    ...(input.slPct != null ? { slPct: input.slPct } : {}),
    ...(input.hedgeStatus ? { hedgeStatus: input.hedgeStatus } : {}),
    ...(input.regime ? { regime: input.regime } : {}),
    ...(input.regimeSource ? { regimeSource: input.regimeSource } : {}),
    ...(input.dvolAtPurchase != null ? { dvolAtPurchase: input.dvolAtPurchase } : {})
  };
  try {
    const result = await pool.query(
      `
        INSERT INTO pilot_protections (
          id, user_hash, hash_version, status, tier_name, drawdown_floor_pct, sl_pct, hedge_status, regime, regime_source, dvol_at_purchase,
          market_id, protected_notional, foxify_exposure_notional,
          expiry_at, auto_renew, renew_window_minutes, metadata
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)
        RETURNING *
      `,
      [
        id,
        input.userHash,
        input.hashVersion,
        input.status,
        input.tierName ?? null,
        input.drawdownFloorPct ?? null,
        input.slPct ?? null,
        input.hedgeStatus ?? null,
        input.regime ?? null,
        input.regimeSource ?? null,
        input.dvolAtPurchase ?? null,
        input.marketId,
        input.protectedNotional,
        input.foxifyExposureNotional,
        input.expiryAt,
        input.autoRenew,
        input.renewWindowMinutes,
        JSON.stringify(v7Meta)
      ]
    );
    return mapProtection(result.rows[0]);
  } catch (err: any) {
    if (String(err?.message || "").includes("column") && String(err?.message || "").includes("does not exist")) {
      console.warn("[insertProtection] V7 columns not yet migrated, falling back to base insert. V7 fields stored in metadata.");
      const result = await pool.query(
        `
          INSERT INTO pilot_protections (
            id, user_hash, hash_version, status, tier_name, drawdown_floor_pct,
            market_id, protected_notional, foxify_exposure_notional,
            expiry_at, auto_renew, renew_window_minutes, metadata
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
          RETURNING *
        `,
        [
          id,
          input.userHash,
          input.hashVersion,
          input.status,
          input.tierName ?? null,
          input.drawdownFloorPct ?? null,
          input.marketId,
          input.protectedNotional,
          input.foxifyExposureNotional,
          input.expiryAt,
          input.autoRenew,
          input.renewWindowMinutes,
          JSON.stringify(v7Meta)
        ]
      );
      return mapProtection(result.rows[0]);
    }
    throw err;
  }
};

export const patchProtection = async (
  pool: Queryable,
  id: string,
  patch: Record<string, unknown>
): Promise<ProtectionRecord | null> => {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (!entries.length) return getProtection(pool, id);
  const fields: string[] = [];
  const values: unknown[] = [];
  entries.forEach(([key, value], idx) => {
    fields.push(`${key} = $${idx + 1}`);
    values.push(value);
  });
  fields.push(`updated_at = NOW()`);
  values.push(id);
  const query = `
    UPDATE pilot_protections
    SET ${fields.join(", ")}
    WHERE id = $${values.length}
    RETURNING *
  `;
  const updated = await pool.query(query, values);
  if (updated.rowCount === 0) return null;
  return mapProtection(updated.rows[0]);
};

export const getProtection = async (pool: Queryable, id: string): Promise<ProtectionRecord | null> => {
  const result = await pool.query(`SELECT * FROM pilot_protections WHERE id = $1`, [id]);
  if (!result.rowCount) return null;
  return mapProtection(result.rows[0]);
};

export const patchProtectionForStatus = async (
  pool: Queryable,
  params: {
    id: string;
    expectedStatus: ProtectionStatus | ProtectionStatus[];
    patch: Record<string, unknown>;
  }
): Promise<ProtectionRecord | null> => {
  const entries = Object.entries(params.patch).filter(([, value]) => value !== undefined);
  if (!entries.length) return null;
  const fields: string[] = [];
  const values: unknown[] = [];
  entries.forEach(([key, value], idx) => {
    fields.push(`${key} = $${idx + 1}`);
    values.push(value);
  });
  fields.push(`updated_at = NOW()`);
  const statusValues = Array.isArray(params.expectedStatus) ? params.expectedStatus : [params.expectedStatus];
  values.push(params.id);
  const idParam = values.length;
  const statusParamStart = values.length + 1;
  values.push(...statusValues);
  const statusParams = statusValues.map((_, idx) => `$${statusParamStart + idx}`).join(", ");
  const query = `
    UPDATE pilot_protections
    SET ${fields.join(", ")}
    WHERE id = $${idParam}
      AND status IN (${statusParams})
    RETURNING *
  `;
  const updated = await pool.query(query, values);
  if (updated.rowCount === 0) return null;
  return mapProtection(updated.rows[0]);
};

export const listActiveProtectionsForTriggerMonitor = async (
  pool: Queryable,
  params: { limit?: number } = {}
): Promise<ProtectionRecord[]> => {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 500));
  const result = await pool.query(
    `
      SELECT *
      FROM pilot_protections
      WHERE status = 'active'
        AND entry_price IS NOT NULL
        AND (drawdown_floor_pct IS NOT NULL OR floor_price IS NOT NULL)
      ORDER BY updated_at ASC
      LIMIT $1
    `,
    [limit]
  );
  return result.rows.map(mapProtection);
};

export const listProtections = async (
  pool: Queryable,
  opts: { limit?: number } = {}
): Promise<ProtectionRecord[]> => {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  const result = await pool.query(
    `SELECT * FROM pilot_protections ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows.map(mapProtection);
};

export const listProtectionsByUserHash = async (
  pool: Queryable,
  userHash: string,
  opts: { limit?: number } = {}
): Promise<ProtectionRecord[]> => {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const result = await pool.query(
    `SELECT * FROM pilot_protections WHERE user_hash = $1 ORDER BY created_at DESC LIMIT $2`,
    [userHash, limit]
  );
  return result.rows.map(mapProtection);
};

export type AdminProtectionScope = "active" | "open" | "all";

const OPEN_PROTECTION_STATUSES: ProtectionStatus[] = [
  "pending_activation",
  "active",
  "triggered",
  "reconcile_pending",
  "awaiting_renew_decision",
  "awaiting_expiry_price"
];

export const listProtectionsByUserHashForAdmin = async (
  pool: Queryable,
  userHash: string,
  opts: {
    limit?: number;
    scope?: AdminProtectionScope;
    status?: ProtectionStatus | "all";
    includeArchived?: boolean;
  } = {}
): Promise<ProtectionRecord[]> => {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  const scope: AdminProtectionScope = opts.scope || "active";
  const status = opts.status || "all";
  const includeArchived = opts.includeArchived === true;
  const values: unknown[] = [userHash];
  const clauses: string[] = ["user_hash = $1"];

  if (!includeArchived) {
    clauses.push(`COALESCE(metadata->>'archivedAt', '') = ''`);
  }

  if (scope === "active") {
    clauses.push(`status = 'active'`);
  } else if (scope === "open") {
    clauses.push(`status = ANY($${values.length + 1}::text[])`);
    values.push(OPEN_PROTECTION_STATUSES as unknown as string[]);
  }

  if (status !== "all") {
    clauses.push(`status = $${values.length + 1}`);
    values.push(status);
  }

  values.push(limit);
  const result = await pool.query(
    `SELECT * FROM pilot_protections WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT $${values.length}`,
    values
  );
  return result.rows.map(mapProtection);
};

export const archiveProtectionsByUserHashExcept = async (
  pool: Queryable,
  input: {
    userHash: string;
    keepProtectionId: string | null;
    reason?: string;
    actor?: string;
  }
): Promise<number> => {
  const archivedAt = new Date().toISOString();
  const reason = String(input.reason || "admin_cleanup");
  const actor = String(input.actor || "admin");
  const values: Array<string> = [input.userHash];
  const clauses: string[] = [
    "user_hash = $1",
    "COALESCE(metadata->>'archivedAt', '') = ''"
  ];

  if (input.keepProtectionId) {
    clauses.push(`id <> $${values.length + 1}`);
    values.push(input.keepProtectionId);
  }

  const candidates = await pool.query(
    `
      SELECT id, metadata
      FROM pilot_protections
      WHERE ${clauses.join(" AND ")}
    `,
    values
  );
  let archivedCount = 0;
  for (const row of candidates.rows) {
    const metadata = toRecord(row.metadata);
    const merged = {
      ...metadata,
      archivedAt,
      archivedReason: reason,
      archivedBy: actor
    };
    const updated = await pool.query(
      `
        UPDATE pilot_protections
        SET metadata = $1::jsonb,
            updated_at = NOW()
        WHERE id = $2
      `,
      [JSON.stringify(merged), String(row.id)]
    );
    archivedCount += Number(updated.rowCount || 0);
  }
  return archivedCount;
};

export const getDailyProtectedNotionalForUser = async (
  pool: Queryable,
  userHash: string,
  dayStartIso: string,
  dayEndIso: string
): Promise<string> => {
  const result = await pool.query(
    `
      SELECT COALESCE(SUM(protected_notional), 0)::text AS total
      FROM pilot_protections
      WHERE user_hash = $1
        AND created_at >= $2::timestamptz
        AND created_at < $3::timestamptz
    `,
    [userHash, dayStartIso, dayEndIso]
  );
  return String(result.rows[0]?.total || "0");
};

export const getDailyTreasurySubsidyUsageForUser = async (
  pool: Queryable,
  userHash: string,
  dayStartIso: string
): Promise<string> => {
  const result = await pool.query(
    `
      SELECT COALESCE(used_subsidy, 0)::text AS used_subsidy
      FROM pilot_daily_treasury_subsidy_usage
      WHERE user_hash = $1
        AND day_start = $2::date
      LIMIT 1
    `,
    [userHash, dayStartIso]
  );
  return String(result.rows[0]?.used_subsidy || "0");
};

export const insertPriceSnapshot = async (
  pool: Queryable,
  input: Omit<PriceSnapshotRecord, "id" | "createdAt"> & { id?: string }
): Promise<PriceSnapshotRecord> => {
  const id = input.id || randomUUID();
  const result = await pool.query(
    `
      INSERT INTO pilot_price_snapshots (
        id, protection_id, snapshot_type, price, market_id, price_source, price_source_detail,
        endpoint_version, request_id, price_timestamp
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
    `,
    [
      id,
      input.protectionId,
      input.snapshotType,
      input.price,
      input.marketId,
      input.priceSource,
      input.priceSourceDetail,
      input.endpointVersion,
      input.requestId,
      input.priceTimestamp
    ]
  );
  return mapSnapshot(result.rows[0]);
};

export const listSnapshotsForProtection = async (
  pool: Queryable,
  protectionId: string
): Promise<PriceSnapshotRecord[]> => {
  const result = await pool.query(
    `
      SELECT * FROM pilot_price_snapshots
      WHERE protection_id = $1
      ORDER BY created_at ASC
    `,
    [protectionId]
  );
  return result.rows.map(mapSnapshot);
};

export const insertLedgerEntry = async (pool: Queryable, input: {
  id?: string;
  protectionId: string;
  entryType: LedgerEntryType;
  amount: string;
  currency?: string;
  reference?: string | null;
  settledAt?: string | null;
}): Promise<void> => {
  await pool.query(
    `
      INSERT INTO pilot_ledger_entries (
        id, protection_id, entry_type, amount, currency, reference, settled_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `,
    [
      input.id || randomUUID(),
      input.protectionId,
      input.entryType,
      input.amount,
      input.currency || "USDC",
      input.reference ?? null,
      input.settledAt ?? null
    ]
  );
};

export const listLedgerForProtection = async (
  pool: Queryable,
  protectionId: string
): Promise<
  Array<{
    id: string;
    protectionId: string;
    entryType: LedgerEntryType;
    amount: string;
    currency: string;
    reference: string | null;
    createdAt: string;
    settledAt: string | null;
  }>
> => {
  const result = await pool.query(
    `
      SELECT * FROM pilot_ledger_entries
      WHERE protection_id = $1
      ORDER BY created_at ASC
    `,
    [protectionId]
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    protectionId: String(row.protection_id),
    entryType: row.entry_type as LedgerEntryType,
    amount: String(row.amount),
    currency: String(row.currency),
    reference: row.reference ? String(row.reference) : null,
    createdAt: new Date(row.created_at).toISOString(),
    settledAt: row.settled_at ? new Date(row.settled_at).toISOString() : null
  }));
};

export const getPilotAdminMetrics = async (
  pool: Queryable,
  opts: { startingReserveUsdc: number; userHash: string; scope?: "all" | "active" | "open" }
): Promise<{
  totalProtections: string;
  activeProtections: string;
  protectedNotionalTotalUsdc: string;
  protectedNotionalActiveUsdc: string;
  clientPremiumTotalUsdc: string;
  hedgePremiumTotalUsdc: string;
  bookedMarginUsdc: string;
  bookedMarginPct: string;
  premiumDueTotalUsdc: string;
  premiumSettledTotalUsdc: string;
  payoutDueTotalUsdc: string;
  payoutSettledTotalUsdc: string;
  pendingPremiumReceivableUsdc: string;
  openPayoutLiabilityUsdc: string;
  startingReserveUsdc: string;
  availableReserveUsdc: string;
  reserveAfterOpenPayoutLiabilityUsdc: string;
  netSettledCashUsdc: string;
}> => {
  const scope = opts.scope === "all" ? "all" : opts.scope === "open" ? "open" : "active";
  const protectionScopeSql =
    scope === "all"
      ? "user_hash = $1 AND COALESCE(metadata->>'archivedAt', '') = ''"
      : scope === "open"
        ? "user_hash = $1 AND COALESCE(metadata->>'archivedAt', '') = '' AND status IN ('pending_activation', 'active', 'triggered', 'reconcile_pending', 'awaiting_renew_decision', 'awaiting_expiry_price')"
        : "user_hash = $1 AND COALESCE(metadata->>'archivedAt', '') = '' AND status = 'active'";
  const result = await pool.query(
    `
      WITH filtered_protections AS (
        SELECT *
        FROM pilot_protections
        WHERE ${protectionScopeSql}
      )
      SELECT
        COUNT(*)::text AS total_protections,
        COUNT(*) FILTER (WHERE status = 'active')::text AS active_protections,
        COALESCE(SUM(protected_notional), 0)::text AS protected_notional_total_usdc,
        COALESCE(SUM(CASE WHEN status = 'active' THEN protected_notional ELSE 0 END), 0)::text AS protected_notional_active_usdc,
        COALESCE(SUM(premium), 0)::text AS client_premium_total_usdc,
        (
          SELECT COALESCE(SUM(e.premium), 0)::text
          FROM pilot_venue_executions e
          INNER JOIN filtered_protections fp ON fp.id = e.protection_id
        ) AS hedge_premium_total_usdc,
        COALESCE(SUM(COALESCE(payout_due_amount, 0)), 0)::text AS payout_due_total_usdc
      FROM filtered_protections
    `,
    [opts.userHash]
  );
  const ledger = await pool.query(
    `
      WITH filtered_protections AS (
        SELECT id
        FROM pilot_protections
        WHERE ${protectionScopeSql}
      )
      SELECT
        COALESCE(SUM(CASE WHEN entry_type = 'premium_due' THEN amount ELSE 0 END), 0)::text AS premium_due_total_usdc,
        COALESCE(SUM(CASE WHEN entry_type = 'premium_settled' THEN amount ELSE 0 END), 0)::text AS premium_settled_total_usdc,
        COALESCE(SUM(CASE WHEN entry_type = 'payout_settled' THEN amount ELSE 0 END), 0)::text AS payout_settled_total_usdc
      FROM pilot_ledger_entries le
      INNER JOIN filtered_protections fp ON fp.id = le.protection_id
    `,
    [opts.userHash]
  );
  const row = result.rows[0] || {};
  const ledgerRow = ledger.rows[0] || {};
  const startingReserve = new Decimal(opts.startingReserveUsdc || 0);
  const hedgePremium = new Decimal(String(row.hedge_premium_total_usdc || "0"));
  const clientPremium = new Decimal(String(row.client_premium_total_usdc || "0"));
  const bookedMargin = clientPremium.minus(hedgePremium);
  const bookedMarginPct = clientPremium.gt(0) ? bookedMargin.div(clientPremium).mul(100) : new Decimal(0);
  const premiumDue = new Decimal(String(ledgerRow.premium_due_total_usdc || "0"));
  const premiumSettled = String(ledgerRow.premium_settled_total_usdc || "0");
  const premiumSettledDecimal = new Decimal(premiumSettled);
  const payoutSettled = String(ledgerRow.payout_settled_total_usdc || "0");
  const payoutSettledDecimal = new Decimal(payoutSettled);
  const payoutDue = new Decimal(String(row.payout_due_total_usdc || "0"));
  const pendingPremiumReceivableUsdc = premiumDue.minus(premiumSettledDecimal).toFixed(10);
  const openPayoutLiabilityUsdc = payoutDue.minus(payoutSettledDecimal).toFixed(10);
  const availableReserveUsdc = startingReserve
    .minus(hedgePremium)
    .plus(premiumSettledDecimal)
    .minus(payoutSettledDecimal)
    .toFixed(10);
  const reserveAfterOpenPayoutLiabilityUsdc = new Decimal(availableReserveUsdc)
    .minus(new Decimal(openPayoutLiabilityUsdc))
    .toFixed(10);
  const netSettledCashUsdc = premiumSettledDecimal.minus(payoutSettledDecimal).toFixed(10);
  return {
    totalProtections: String(row.total_protections || "0"),
    activeProtections: String(row.active_protections || "0"),
    protectedNotionalTotalUsdc: String(row.protected_notional_total_usdc || "0"),
    protectedNotionalActiveUsdc: String(row.protected_notional_active_usdc || "0"),
    clientPremiumTotalUsdc: clientPremium.toFixed(10),
    hedgePremiumTotalUsdc: String(row.hedge_premium_total_usdc || "0"),
    bookedMarginUsdc: bookedMargin.toFixed(10),
    bookedMarginPct: bookedMarginPct.toFixed(6),
    premiumDueTotalUsdc: String(ledgerRow.premium_due_total_usdc || "0"),
    premiumSettledTotalUsdc: premiumSettled,
    payoutDueTotalUsdc: String(row.payout_due_total_usdc || "0"),
    payoutSettledTotalUsdc: payoutSettled,
    pendingPremiumReceivableUsdc,
    openPayoutLiabilityUsdc,
    startingReserveUsdc: startingReserve.toFixed(10),
    availableReserveUsdc,
    reserveAfterOpenPayoutLiabilityUsdc,
    netSettledCashUsdc
  };
};

export type PilotAdminMetrics = Awaited<ReturnType<typeof getPilotAdminMetrics>>;

export const insertVenueQuote = async (
  pool: Queryable,
  input: VenueQuote & { protectionId?: string | null }
): Promise<void> => {
  await pool.query(
    `
      INSERT INTO pilot_venue_quotes (
        id, protection_id, venue, quote_id, rfq_id, instrument_id, side, quantity, premium, expires_at, quote_ts, details
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
    `,
    [
      randomUUID(),
      input.protectionId ?? null,
      input.venue,
      input.quoteId,
      input.rfqId ?? null,
      input.instrumentId,
      input.side,
      input.quantity.toString(),
      input.premium.toString(),
      input.expiresAt,
      input.quoteTs,
      JSON.stringify(input.details || {})
    ]
  );
};

export const insertOptionsChainSnapshot = async (
  pool: Queryable,
  input: {
    id?: string;
    venue: string;
    marketId: string;
    asOfTs: string;
    tenorDays: number | null;
    strike: string | null;
    optionRight: "P" | "C" | null;
    bidPxUsd: string | null;
    askPxUsd: string | null;
    markPxUsd: string | null;
    iv: string | null;
    delta: string | null;
    gamma: string | null;
    vega: string | null;
    theta: string | null;
    bidSize: string | null;
    askSize: string | null;
    source: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<void> => {
  await pool.query(
    `
      INSERT INTO pilot_options_chain_snapshots (
        id, venue, market_id, as_of_ts, tenor_days, strike, option_right, bid_px_usd, ask_px_usd, mark_px_usd,
        iv, delta, gamma, vega, theta, bid_size, ask_size, source, metadata
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb)
    `,
    [
      input.id || randomUUID(),
      input.venue,
      input.marketId,
      input.asOfTs,
      input.tenorDays,
      input.strike,
      input.optionRight,
      input.bidPxUsd,
      input.askPxUsd,
      input.markPxUsd,
      input.iv,
      input.delta,
      input.gamma,
      input.vega,
      input.theta,
      input.bidSize,
      input.askSize,
      input.source,
      JSON.stringify(input.metadata || {})
    ]
  );
};

export const insertRfqQuote = async (
  pool: Queryable,
  input: {
    id?: string;
    venue: string;
    quoteId: string;
    rfqId: string | null;
    marketId: string;
    instrumentId: string | null;
    side: "buy" | "sell";
    quantity: string;
    quotePxUsd: string;
    quoteTs: string;
    expiresTs: string | null;
    source: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<void> => {
  await pool.query(
    `
      INSERT INTO pilot_rfq_quotes (
        id, venue, quote_id, rfq_id, market_id, instrument_id, side, quantity, quote_px_usd, quote_ts, expires_ts, source, metadata
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
      ON CONFLICT (venue, quote_id) DO NOTHING
    `,
    [
      input.id || randomUUID(),
      input.venue,
      input.quoteId,
      input.rfqId,
      input.marketId,
      input.instrumentId,
      input.side,
      input.quantity,
      input.quotePxUsd,
      input.quoteTs,
      input.expiresTs,
      input.source,
      JSON.stringify(input.metadata || {})
    ]
  );
};

export const insertRfqFill = async (
  pool: Queryable,
  input: {
    id?: string;
    venue: string;
    fillId: string;
    quoteId: string | null;
    rfqId: string | null;
    marketId: string;
    instrumentId: string | null;
    side: "buy" | "sell";
    quantity: string;
    fillPxUsd: string;
    fillTs: string;
    feeUsd: string | null;
    slippageBps: string | null;
    source: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<void> => {
  await pool.query(
    `
      INSERT INTO pilot_rfq_fills (
        id, venue, fill_id, quote_id, rfq_id, market_id, instrument_id, side, quantity, fill_px_usd, fill_ts, fee_usd, slippage_bps, source, metadata
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
      ON CONFLICT (venue, fill_id) DO NOTHING
    `,
    [
      input.id || randomUUID(),
      input.venue,
      input.fillId,
      input.quoteId,
      input.rfqId,
      input.marketId,
      input.instrumentId,
      input.side,
      input.quantity,
      input.fillPxUsd,
      input.fillTs,
      input.feeUsd,
      input.slippageBps,
      input.source,
      JSON.stringify(input.metadata || {})
    ]
  );
};

export const upsertExecutionQualityDaily = async (
  pool: Queryable,
  input: {
    day?: string;
    dayIso?: string;
    venue: string;
    hedgeMode: HedgeMode;
    avgSlippageBps: string | number | null;
    p95SlippageBps?: string | number | null;
    fillSuccessRatePct?: string | number | null;
    avgSpreadPct?: string | number | null;
    avgTopBookDepth?: string | number | null;
    sampleCount?: number;
    quotes?: number;
    fills?: number;
    rejects?: number;
    avgLatencyMs?: string | number | null;
    notes?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }
): Promise<void> => {
  const dayRaw = String(input.day || input.dayIso || "").trim();
  if (!dayRaw) {
    throw new Error("invalid_execution_quality_day");
  }
  const day = dayRaw.slice(0, 10);
  const toNullableString = (value: string | number | null | undefined): string | null => {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return String(n);
  };
  const quotes = Math.max(0, Math.floor(Number(input.quotes || 0)));
  const fills = Math.max(0, Math.floor(Number(input.fills || 0)));
  const rejects = Math.max(0, Math.floor(Number(input.rejects || 0)));
  const sampleCount = Math.max(
    0,
    Math.floor(
      Number(
        input.sampleCount ??
          (quotes > 0 ? quotes : fills + rejects > 0 ? fills + rejects : 1)
      )
    )
  );
  const fillSuccessRatePct =
    input.fillSuccessRatePct !== undefined
      ? toNullableString(input.fillSuccessRatePct)
      : quotes > 0
        ? String((fills / Math.max(1, quotes)) * 100)
        : null;
  const metadata = {
    ...(input.metadata || {}),
    ...(input.notes || {}),
    quotes,
    fills,
    rejects,
    ...(input.avgLatencyMs !== undefined
      ? { avgLatencyMs: toNullableString(input.avgLatencyMs) }
      : {})
  };
  // The pilot_execution_quality_daily.id column is TEXT PRIMARY KEY with no
  // DEFAULT (see schema definition above). The original upsert omitted `id`,
  // which produced a silent NOT NULL violation on every activation:
  //   "[Activate] Execution quality upsert failed: null value in column \"id\"
  //    of relation \"pilot_execution_quality_daily\" violates not-null
  //    constraint"
  // Activations themselves succeeded (the caller catches this error and
  // logs it without rolling back the trade), but the diagnostics rollup
  // stayed empty across the entire pilot. Fix: generate a UUID in code
  // and include it in the INSERT. Identity for ON CONFLICT remains the
  // composite UNIQUE (day, venue, hedge_mode) — `id` is purely a row PK.
  const id = randomUUID();
  await pool.query(
    `
      INSERT INTO pilot_execution_quality_daily (
        id, day, venue, hedge_mode, avg_slippage_bps, p95_slippage_bps, fill_success_rate_pct,
        avg_spread_pct, avg_top_book_depth, sample_count, metadata
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
      ON CONFLICT (day, venue, hedge_mode) DO UPDATE SET
        avg_slippage_bps = EXCLUDED.avg_slippage_bps,
        p95_slippage_bps = EXCLUDED.p95_slippage_bps,
        fill_success_rate_pct = EXCLUDED.fill_success_rate_pct,
        avg_spread_pct = EXCLUDED.avg_spread_pct,
        avg_top_book_depth = EXCLUDED.avg_top_book_depth,
        sample_count = EXCLUDED.sample_count,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
    `,
    [
      id,
      day,
      input.venue,
      input.hedgeMode,
      toNullableString(input.avgSlippageBps),
      toNullableString(input.p95SlippageBps),
      fillSuccessRatePct,
      toNullableString(input.avgSpreadPct),
      toNullableString(input.avgTopBookDepth),
      sampleCount,
      JSON.stringify(metadata)
    ]
  );
};

/**
 * Append a single per-trade observation to the daily rollup row, accumulating:
 *  - sample_count        sums by 1
 *  - quotes/fills/rejects accumulate in metadata
 *  - avg_slippage_bps    weighted-average across all observations on that day
 *  - avg_spread_pct      weighted-average across all observations on that day
 *  - avg_top_book_depth  weighted-average across all observations on that day
 *  - fill_success_rate_pct  recomputed from running sum of fills/quotes
 *  - p95_slippage_bps    recomputed from a per-trade slippage array kept in metadata.slippageSamples
 *  - per-trade audit trail in metadata.tradeIds (capped at 200 entries)
 *  - latest protectionId / quoteId always overwrites for traceability of the most recent fill
 *  - updated_at advances on every call
 *
 * Use this from the activate path (one observation per successful activation).
 * For backfill (where each input row is already an aggregate), continue to use
 * upsertExecutionQualityDaily which has overwrite semantics.
 *
 * Identity for ON CONFLICT remains the composite UNIQUE (day, venue, hedge_mode);
 * the id column is filled with a generated UUID on first insert and preserved
 * on subsequent updates.
 */
export const incrementExecutionQualityDaily = async (
  pool: Queryable,
  input: {
    day?: string;
    dayIso?: string;
    venue: string;
    hedgeMode: HedgeMode;
    /** This single trade's slippage in bps. Aggregator computes daily weighted avg + p95. */
    slippageBps: number;
    /** This single trade's quote→fill latency in ms. Aggregator computes daily avg. */
    latencyMs?: number;
    /** This single trade's quote spread, if known (otherwise undefined). */
    spreadPct?: number;
    /** Top-of-book depth observed at fill time, if known. */
    topBookDepth?: number;
    /** True if the activation produced a fill; false if it was a quote-only / reject. */
    filled: boolean;
    /** Optional cross-references for audit. */
    protectionId?: string;
    quoteId?: string;
    /** Free-form notes merged into metadata. */
    notes?: Record<string, unknown>;
  }
): Promise<void> => {
  const dayRaw = String(input.day || input.dayIso || "").trim();
  if (!dayRaw) throw new Error("invalid_execution_quality_day");
  const day = dayRaw.slice(0, 10);
  const id = randomUUID();
  const slip = Number.isFinite(Number(input.slippageBps)) ? Number(input.slippageBps) : 0;
  const filled = !!input.filled;
  const quotesDelta = 1;
  const fillsDelta = filled ? 1 : 0;
  const rejectsDelta = filled ? 0 : 1;

  // Read existing row (single row per day/venue/hedge_mode key) so we can
  // recompute aggregates in code. This is two round-trips per activation, but
  // activate is already a multi-step path and the alternative (computing in
  // SQL with jsonb arithmetic) becomes hard to reason about for percentile
  // and array-append semantics. Two round-trips is acceptable at pilot
  // throughput.
  const existing = await pool.query(
    `SELECT sample_count, avg_slippage_bps, avg_spread_pct, avg_top_book_depth, metadata
     FROM pilot_execution_quality_daily
     WHERE day = $1 AND venue = $2 AND hedge_mode = $3
     LIMIT 1`,
    [day, input.venue, input.hedgeMode]
  );

  const prev = existing.rows[0] as
    | {
        sample_count: number | string;
        avg_slippage_bps: string | null;
        avg_spread_pct: string | null;
        avg_top_book_depth: string | null;
        metadata: Record<string, unknown> | null;
      }
    | undefined;

  const prevN = prev ? Math.max(0, Math.floor(Number(prev.sample_count) || 0)) : 0;
  const prevMeta = (prev?.metadata || {}) as Record<string, unknown>;
  const prevQuotes = Math.max(0, Math.floor(Number((prevMeta as any).quotes || 0)));
  const prevFills = Math.max(0, Math.floor(Number((prevMeta as any).fills || 0)));
  const prevRejects = Math.max(0, Math.floor(Number((prevMeta as any).rejects || 0)));
  const prevSlippageSamples = Array.isArray((prevMeta as any).slippageSamples)
    ? ((prevMeta as any).slippageSamples as number[]).filter((n) => Number.isFinite(n))
    : [];
  const prevTradeIds = Array.isArray((prevMeta as any).tradeIds)
    ? ((prevMeta as any).tradeIds as Array<Record<string, unknown>>)
    : [];
  const prevAvgLatencyMs = Number.isFinite(Number((prevMeta as any).avgLatencyMs))
    ? Number((prevMeta as any).avgLatencyMs)
    : null;

  const newN = prevN + 1;

  // Quote/fill/reject counters always advance.
  const newQuotes = prevQuotes + quotesDelta;
  const newFills = prevFills + fillsDelta;
  const newRejects = prevRejects + rejectsDelta;
  const newFillRatePct = newQuotes > 0 ? (newFills / newQuotes) * 100 : null;

  // Slippage / spread / top-book-depth are only meaningful for FILLED trades.
  // A reject contributes nothing to the slippage distribution (no fill happened),
  // so we exclude it from weighted averages and from the p95 sample array.
  // Without this guard, a reject would push slip=0 into the array and dilute
  // both avg_slippage_bps and p95_slippage_bps toward zero, masking real fill
  // quality issues.
  const fillsForAvg = prevFills; // weighted-avg denominator for previous fills
  const newFillsForAvg = newFills;

  const weighted = (
    prevAvg: string | null | undefined,
    sample: number | undefined,
    countPrev: number,
    countNew: number
  ): number | null => {
    if (sample === undefined || !Number.isFinite(sample)) {
      return prevAvg === null || prevAvg === undefined ? null : Number(prevAvg);
    }
    if (countNew <= 0) return null;
    const prevNum = prevAvg === null || prevAvg === undefined ? null : Number(prevAvg);
    if (prevNum === null || countPrev <= 0) return sample;
    return (prevNum * countPrev + sample) / countNew;
  };

  const newAvgSlippageBps = filled
    ? (weighted(prev?.avg_slippage_bps, slip, fillsForAvg, newFillsForAvg) ?? 0)
    : (prev?.avg_slippage_bps ? Number(prev.avg_slippage_bps) : 0);
  const newAvgSpreadPct = filled
    ? weighted(prev?.avg_spread_pct, input.spreadPct, fillsForAvg, newFillsForAvg)
    : (prev?.avg_spread_pct ? Number(prev.avg_spread_pct) : null);
  const newAvgTopBookDepth = filled
    ? weighted(prev?.avg_top_book_depth, input.topBookDepth, fillsForAvg, newFillsForAvg)
    : (prev?.avg_top_book_depth ? Number(prev.avg_top_book_depth) : null);

  // Append slippage sample only on fills (cap at 500 to bound row size); recompute p95.
  const slippageSamples = filled
    ? [...prevSlippageSamples, slip].slice(-500)
    : prevSlippageSamples;
  const sortedSamples = [...slippageSamples].sort((a, b) => a - b);
  const p95Idx = Math.min(
    sortedSamples.length - 1,
    Math.max(0, Math.floor(0.95 * (sortedSamples.length - 1)))
  );
  const newP95SlippageBps = sortedSamples.length > 0 ? sortedSamples[p95Idx] : null;

  // Append trade-id audit (cap at 200).
  const tradeAudit: Record<string, unknown> = { ts: new Date().toISOString() };
  if (input.protectionId) tradeAudit.protectionId = input.protectionId;
  if (input.quoteId) tradeAudit.quoteId = input.quoteId;
  if (input.latencyMs !== undefined && Number.isFinite(input.latencyMs)) {
    tradeAudit.latencyMs = Math.max(0, Math.floor(input.latencyMs));
  }
  tradeAudit.slippageBps = slip;
  tradeAudit.filled = filled;
  const tradeIds = [...prevTradeIds, tradeAudit].slice(-200);

  // Running average latency, computed across FILLED trades only (rejects don't
  // produce a meaningful "fill latency" — they may have failed before any
  // venue round-trip happened, or after a long timeout that's not representative
  // of normal fill behavior). Counters always advance so fill rate stays right.
  const latencyMs = filled && Number.isFinite(Number(input.latencyMs)) ? Number(input.latencyMs) : null;
  const newAvgLatencyMs =
    latencyMs === null
      ? prevAvgLatencyMs
      : prevAvgLatencyMs === null || fillsForAvg <= 0
        ? latencyMs
        : (prevAvgLatencyMs * fillsForAvg + latencyMs) / newFillsForAvg;

  const metadata = {
    ...prevMeta,
    ...(input.notes || {}),
    quotes: newQuotes,
    fills: newFills,
    rejects: newRejects,
    avgLatencyMs: newAvgLatencyMs === null ? null : String(newAvgLatencyMs),
    slippageSamples,
    tradeIds,
    // Latest-trade traceability fields (always overwritten):
    lastProtectionId: input.protectionId ?? (prevMeta as any).lastProtectionId ?? null,
    lastQuoteId: input.quoteId ?? (prevMeta as any).lastQuoteId ?? null,
    lastUpdatedAt: new Date().toISOString()
  };

  await pool.query(
    `
      INSERT INTO pilot_execution_quality_daily (
        id, day, venue, hedge_mode, avg_slippage_bps, p95_slippage_bps, fill_success_rate_pct,
        avg_spread_pct, avg_top_book_depth, sample_count, metadata
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
      ON CONFLICT (day, venue, hedge_mode) DO UPDATE SET
        avg_slippage_bps      = EXCLUDED.avg_slippage_bps,
        p95_slippage_bps      = EXCLUDED.p95_slippage_bps,
        fill_success_rate_pct = EXCLUDED.fill_success_rate_pct,
        avg_spread_pct        = EXCLUDED.avg_spread_pct,
        avg_top_book_depth    = EXCLUDED.avg_top_book_depth,
        sample_count          = EXCLUDED.sample_count,
        metadata              = EXCLUDED.metadata,
        updated_at            = NOW()
    `,
    [
      id,
      day,
      input.venue,
      input.hedgeMode,
      String(newAvgSlippageBps),
      newP95SlippageBps === null ? null : String(newP95SlippageBps),
      newFillRatePct === null ? null : String(newFillRatePct),
      newAvgSpreadPct === null ? null : String(newAvgSpreadPct),
      newAvgTopBookDepth === null ? null : String(newAvgTopBookDepth),
      newN,
      JSON.stringify(metadata)
    ]
  );
};

export const listExecutionQualityRecent = async (
  pool: Queryable,
  params: {
    lookbackDays: number;
    limit?: number;
  }
): Promise<ExecutionQualityRecord[]> => {
  const lookbackDays = Math.max(1, Math.min(365, Math.floor(params.lookbackDays || 30)));
  const limit = Math.max(1, Math.min(3650, Math.floor(params.limit || 365)));
  const result = await pool.query(
    `
      SELECT *
      FROM pilot_execution_quality_daily
      WHERE day >= (CURRENT_DATE - ($1::int || ' days')::interval)::date
      ORDER BY day DESC, venue ASC, hedge_mode ASC
      LIMIT $2::int
    `,
    [lookbackDays, limit]
  );
  return result.rows.map((row) => ({
    day: new Date(String(row.day)).toISOString().slice(0, 10),
    venue: String(row.venue),
    hedgeMode: String(row.hedge_mode) as HedgeMode,
    avgSlippageBps: row.avg_slippage_bps === null ? null : String(row.avg_slippage_bps),
    p95SlippageBps: row.p95_slippage_bps === null ? null : String(row.p95_slippage_bps),
    fillSuccessRatePct: row.fill_success_rate_pct === null ? null : String(row.fill_success_rate_pct),
    avgSpreadPct: row.avg_spread_pct === null ? null : String(row.avg_spread_pct),
    avgTopBookDepth: row.avg_top_book_depth === null ? null : String(row.avg_top_book_depth),
    sampleCount: Number(row.sample_count || 0),
    metadata: toRecord(row.metadata),
    updatedAt: new Date(String(row.updated_at)).toISOString()
  }));
};

export type VenueQuoteRecord = VenueQuote & {
  id: string;
  protectionId: string | null;
  consumedAt: string | null;
  consumedByProtectionId: string | null;
};

export type TenorDiagnosticsSample = {
  requestedTenorDays: number;
  selectedTenorDays: number | null;
  driftDays: number | null;
  hedgeMode: HedgeMode | "unknown";
  premiumRatio: number | null;
  treasuryQuoteSubsidyUsd: number;
  subsidyCapUsd: number;
  subsidyUtilizationPct: number;
  treasuryReserveAfterOpenLiabilityUsdc: number;
  treasuryDrawdownPct: number;
  quoteTs: string | null;
  status: "ok";
};

export const listRecentQuoteDiagnostics = async (
  pool: Queryable,
  params: {
    lookbackMinutes: number;
    limit?: number;
  }
): Promise<TenorDiagnosticsSample[]> => {
  const lookbackMinutes = Math.max(1, Math.min(24 * 60, Math.floor(Number(params.lookbackMinutes || 0) || 60)));
  const limit = Math.max(10, Math.min(5000, Math.floor(Number(params.limit || 2000) || 2000)));
  const cutoffIso = new Date(Date.now() - lookbackMinutes * 60_000).toISOString();
  const result = await pool.query(
    `
      SELECT details, premium, quote_ts
      FROM pilot_venue_quotes
      WHERE created_at >= $1::timestamptz
      ORDER BY created_at DESC
      LIMIT $2::int
    `,
    [cutoffIso, limit]
  );
  const rows: TenorDiagnosticsSample[] = [];
  for (const row of result.rows) {
    const details = toRecord(row.details);
    const lockContext = toRecord(details.lockContext);
    const requested = safeNumber(lockContext.requestedTenorDays);
    if (requested === null || requested <= 0) continue;
    const selected =
      safeNumber(details.selectedTenorDays) ??
      safeNumber(details.selectedTenorDaysActual) ??
      safeNumber(lockContext.selectedTenorDays);
    const drift = selected !== null ? Math.abs(selected - requested) : null;
    const modeRaw = String(details.hedgeMode || lockContext.hedgeMode || "").trim();
    const hedgeMode: HedgeMode | "unknown" =
      modeRaw === "options_native" || modeRaw === "futures_synthetic" ? modeRaw : "unknown";
    const clientPremiumUsd =
      safeNumber(lockContext.clientPremiumUsd) ??
      safeNumber(toRecord(details.pricingBreakdown).clientPremiumUsd) ??
      safeNumber(row.premium);
    const protectedNotional = safeNumber(lockContext.protectedNotional);
    const premiumRatio =
      clientPremiumUsd !== null && protectedNotional !== null && protectedNotional > 0
        ? clientPremiumUsd / protectedNotional
        : null;
    const pricingBreakdown = toRecord(details.pricingBreakdown);
    const treasuryQuoteSubsidyUsd = safeNumber(pricingBreakdown.treasuryQuoteSubsidyUsd) ?? 0;
    const subsidyCapUsd = safeNumber(pricingBreakdown.treasuryPerQuoteSubsidyCapUsd) ?? 0;
    const subsidyUtilizationPct = subsidyCapUsd > 0 ? (treasuryQuoteSubsidyUsd / subsidyCapUsd) * 100 : 0;
    const reserveAfterOpenLiabilityUsdc = safeNumber(pricingBreakdown.treasuryReserveAfterOpenLiabilityUsdc) ?? 0;
    const startingReserveUsdc = safeNumber(pricingBreakdown.treasuryStartingReserveUsdc) ?? 0;
    const treasuryDrawdownPct =
      startingReserveUsdc > 0
        ? Math.max(0, Math.min(100, ((startingReserveUsdc - reserveAfterOpenLiabilityUsdc) / startingReserveUsdc) * 100))
        : 0;
    const quoteTsIso =
      typeof row.quote_ts === "string" || row.quote_ts instanceof Date ? new Date(String(row.quote_ts)).toISOString() : null;
    rows.push({
      requestedTenorDays: Math.floor(requested),
      selectedTenorDays: selected,
      driftDays: drift,
      hedgeMode,
      premiumRatio,
      treasuryQuoteSubsidyUsd,
      subsidyCapUsd,
      subsidyUtilizationPct,
      treasuryReserveAfterOpenLiabilityUsdc: reserveAfterOpenLiabilityUsdc,
      treasuryDrawdownPct,
      quoteTs: quoteTsIso,
      status: "ok"
    });
  }
  return rows;
};

export const getVenueQuoteByQuoteId = async (
  pool: Queryable,
  quoteId: string
): Promise<VenueQuoteRecord | null> => {
  const result = await pool.query(
    `
      SELECT * FROM pilot_venue_quotes
      WHERE quote_id = $1
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [quoteId]
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return {
    id: String(row.id),
    venue: String(row.venue) as VenueQuote["venue"],
    quoteId: String(row.quote_id),
    rfqId: row.rfq_id ? String(row.rfq_id) : null,
    instrumentId: String(row.instrument_id),
    side: String(row.side) as VenueQuote["side"],
    quantity: Number(row.quantity),
    premium: Number(row.premium),
    expiresAt: new Date(row.expires_at).toISOString(),
    quoteTs: new Date(row.quote_ts).toISOString(),
    details: toRecord(row.details),
    protectionId: row.protection_id ? String(row.protection_id) : null,
    consumedAt: row.consumed_at ? new Date(row.consumed_at).toISOString() : null,
    consumedByProtectionId: row.consumed_by_protection_id ? String(row.consumed_by_protection_id) : null
  };
};

export const getVenueQuoteByQuoteIdForUpdate = async (
  pool: Queryable,
  quoteId: string
): Promise<VenueQuoteRecord | null> => {
  const result = await pool.query(
    `
      SELECT * FROM pilot_venue_quotes
      WHERE quote_id = $1
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE
    `,
    [quoteId]
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return {
    id: String(row.id),
    venue: String(row.venue) as VenueQuote["venue"],
    quoteId: String(row.quote_id),
    rfqId: row.rfq_id ? String(row.rfq_id) : null,
    instrumentId: String(row.instrument_id),
    side: String(row.side) as VenueQuote["side"],
    quantity: Number(row.quantity),
    premium: Number(row.premium),
    expiresAt: new Date(row.expires_at).toISOString(),
    quoteTs: new Date(row.quote_ts).toISOString(),
    details: toRecord(row.details),
    protectionId: row.protection_id ? String(row.protection_id) : null,
    consumedAt: row.consumed_at ? new Date(row.consumed_at).toISOString() : null,
    consumedByProtectionId: row.consumed_by_protection_id ? String(row.consumed_by_protection_id) : null
  };
};

export const consumeVenueQuote = async (
  pool: Queryable,
  venueQuoteRowId: string,
  protectionId: string
): Promise<boolean> => {
  const result = await pool.query(
    `
      UPDATE pilot_venue_quotes
      SET consumed_at = NOW(), consumed_by_protection_id = $2, protection_id = COALESCE(protection_id, $2)
      WHERE id = $1
        AND consumed_at IS NULL
      RETURNING id
    `,
    [venueQuoteRowId, protectionId]
  );
  return Number(result.rowCount || 0) > 0;
};

export const reserveDailyActivationCapacity = async (
  pool: Queryable,
  params: {
    userHash: string;
    dayStartIso: string;
    protectedNotional: string;
    maxDailyNotional: string;
  }
): Promise<{ ok: true; usedAfter: string } | { ok: false; usedNow: string }> => {
  await pool.query(
    `
      INSERT INTO pilot_daily_usage (user_hash, day_start, used_notional)
      VALUES ($1, $2::date, 0)
      ON CONFLICT (user_hash, day_start) DO NOTHING
    `,
    [params.userHash, params.dayStartIso]
  );
  const updated = await pool.query(
    `
      UPDATE pilot_daily_usage
      SET used_notional = used_notional + $3::numeric
      WHERE user_hash = $1
        AND day_start = $2::date
        AND used_notional + $3::numeric <= $4::numeric
      RETURNING used_notional::text AS used_after
    `,
    [params.userHash, params.dayStartIso, params.protectedNotional, params.maxDailyNotional]
  );
  if (updated.rowCount && updated.rows[0]?.used_after) {
    return { ok: true, usedAfter: String(updated.rows[0].used_after) };
  }
  const current = await pool.query(
    `
      SELECT used_notional::text AS used_now
      FROM pilot_daily_usage
      WHERE user_hash = $1
        AND day_start = $2::date
      LIMIT 1
    `,
    [params.userHash, params.dayStartIso]
  );
  return { ok: false, usedNow: String(current.rows[0]?.used_now || "0") };
};

export const releaseDailyActivationCapacity = async (
  pool: Queryable,
  params: {
    userHash: string;
    dayStartIso: string;
    protectedNotional: string;
  }
): Promise<void> => {
  await pool.query(
    `
      UPDATE pilot_daily_usage
      SET used_notional = GREATEST(0, used_notional - $3::numeric)
      WHERE user_hash = $1
        AND day_start = $2::date
    `,
    [params.userHash, params.dayStartIso, params.protectedNotional]
  );
};

export const reserveDailyTreasurySubsidyCapacity = async (
  pool: Queryable,
  params: {
    userHash: string;
    dayStartIso: string;
    subsidyAmount: string;
    maxDailySubsidy: string;
  }
): Promise<{ ok: true; usedAfter: string } | { ok: false; usedNow: string }> => {
  await pool.query(
    `
      INSERT INTO pilot_daily_treasury_subsidy_usage (user_hash, day_start, used_subsidy)
      VALUES ($1, $2::date, 0)
      ON CONFLICT (user_hash, day_start) DO NOTHING
    `,
    [params.userHash, params.dayStartIso]
  );
  const updated = await pool.query(
    `
      UPDATE pilot_daily_treasury_subsidy_usage
      SET used_subsidy = used_subsidy + $3::numeric
      WHERE user_hash = $1
        AND day_start = $2::date
        AND used_subsidy + $3::numeric <= $4::numeric
      RETURNING used_subsidy::text AS used_after
    `,
    [params.userHash, params.dayStartIso, params.subsidyAmount, params.maxDailySubsidy]
  );
  if (updated.rowCount && updated.rows[0]?.used_after) {
    return { ok: true, usedAfter: String(updated.rows[0].used_after) };
  }
  const current = await pool.query(
    `
      SELECT used_subsidy::text AS used_now
      FROM pilot_daily_treasury_subsidy_usage
      WHERE user_hash = $1
        AND day_start = $2::date
      LIMIT 1
    `,
    [params.userHash, params.dayStartIso]
  );
  return { ok: false, usedNow: String(current.rows[0]?.used_now || "0") };
};

export const releaseDailyTreasurySubsidyCapacity = async (
  pool: Queryable,
  params: {
    userHash: string;
    dayStartIso: string;
    subsidyAmount: string;
  }
): Promise<void> => {
  await pool.query(
    `
      UPDATE pilot_daily_treasury_subsidy_usage
      SET used_subsidy = GREATEST(0, used_subsidy - $3::numeric)
      WHERE user_hash = $1
        AND day_start = $2::date
    `,
    [params.userHash, params.dayStartIso, params.subsidyAmount]
  );
};

export const insertSimPosition = async (
  pool: Queryable,
  input: {
    id?: string;
    userHash: string;
    hashVersion: number;
    status: SimPositionStatus;
    marketId: string;
    side: "long" | "short";
    notionalUsd: string;
    entryPrice: string;
    tierName?: string | null;
    drawdownFloorPct?: string | null;
    floorPrice?: string | null;
    protectionEnabled: boolean;
    protectionId?: string | null;
    protectionPremiumUsd?: string | null;
    protectedLossUsd?: string | null;
    triggerCreditedUsd?: string;
    triggerCreditedAt?: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<SimPositionRecord> => {
  const id = input.id || randomUUID();
  const inserted = await pool.query(
    `
      INSERT INTO pilot_sim_positions (
        id, user_hash, hash_version, status, market_id, side, notional_usd, entry_price,
        tier_name, drawdown_floor_pct, floor_price, protection_enabled, protection_id,
        protection_premium_usd, protected_loss_usd, trigger_credited_usd, trigger_credited_at, metadata
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,
        $9,$10,$11,$12,$13,
        $14,$15,$16,$17,$18::jsonb
      )
      RETURNING *
    `,
    [
      id,
      input.userHash,
      input.hashVersion,
      input.status,
      input.marketId,
      input.side,
      input.notionalUsd,
      input.entryPrice,
      input.tierName ?? null,
      input.drawdownFloorPct ?? null,
      input.floorPrice ?? null,
      input.protectionEnabled,
      input.protectionId ?? null,
      input.protectionPremiumUsd ?? null,
      input.protectedLossUsd ?? null,
      input.triggerCreditedUsd ?? "0",
      input.triggerCreditedAt ?? null,
      JSON.stringify(input.metadata || {})
    ]
  );
  return mapSimPosition(inserted.rows[0]);
};

export const getSimPosition = async (pool: Queryable, id: string): Promise<SimPositionRecord | null> => {
  const result = await pool.query(`SELECT * FROM pilot_sim_positions WHERE id = $1 LIMIT 1`, [id]);
  if (!result.rowCount) return null;
  return mapSimPosition(result.rows[0]);
};

export const patchSimPosition = async (
  pool: Queryable,
  id: string,
  patch: Record<string, unknown>
): Promise<SimPositionRecord | null> => {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (!entries.length) return getSimPosition(pool, id);
  const fields: string[] = [];
  const values: unknown[] = [];
  entries.forEach(([key, value], idx) => {
    fields.push(`${key} = $${idx + 1}`);
    values.push(value);
  });
  fields.push("updated_at = NOW()");
  values.push(id);
  const updated = await pool.query(
    `
      UPDATE pilot_sim_positions
      SET ${fields.join(", ")}
      WHERE id = $${values.length}
      RETURNING *
    `,
    values
  );
  if (!updated.rowCount) return null;
  return mapSimPosition(updated.rows[0]);
};

export const listSimPositionsByUserHash = async (
  pool: Queryable,
  userHash: string,
  opts: { limit?: number } = {}
): Promise<SimPositionRecord[]> => {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const result = await pool.query(
    `
      SELECT * FROM pilot_sim_positions
      WHERE user_hash = $1
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [userHash, limit]
  );
  return result.rows.map(mapSimPosition);
};

export const listSimOpenProtectedPositionsByUserHash = async (
  pool: Queryable,
  userHash: string,
  opts: { limit?: number } = {}
): Promise<SimPositionRecord[]> => {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 500));
  const result = await pool.query(
    `
      SELECT * FROM pilot_sim_positions
      WHERE user_hash = $1
        AND status = 'open'
        AND protection_enabled = TRUE
      ORDER BY created_at ASC
      LIMIT $2
    `,
    [userHash, limit]
  );
  return result.rows.map(mapSimPosition);
};

export const creditSimPositionForTrigger = async (
  pool: Queryable,
  params: {
    id: string;
    triggerCreditUsd: string;
    metadata: Record<string, unknown>;
  }
): Promise<SimPositionRecord | null> => {
  const updated = await pool.query(
    `
      UPDATE pilot_sim_positions
      SET
        status = 'triggered',
        trigger_credited_usd = $2::numeric,
        trigger_credited_at = NOW(),
        metadata = $3::jsonb,
        updated_at = NOW()
      WHERE id = $1
        AND status = 'open'
        AND protection_enabled = TRUE
        AND COALESCE(trigger_credited_usd, 0) = 0
      RETURNING *
    `,
    [params.id, params.triggerCreditUsd, JSON.stringify(params.metadata || {})]
  );
  if (!updated.rowCount) return null;
  return mapSimPosition(updated.rows[0]);
};

export const insertSimTreasuryLedgerEntry = async (
  pool: Queryable,
  input: {
    id?: string;
    simPositionId: string;
    userHash: string;
    protectionId?: string | null;
    entryType: SimTreasuryEntryType;
    amountUsd: string;
    metadata?: Record<string, unknown>;
  }
): Promise<SimTreasuryLedgerRecord> => {
  const inserted = await pool.query(
    `
      INSERT INTO pilot_sim_treasury_ledger (
        id, sim_position_id, user_hash, protection_id, entry_type, amount_usd, metadata
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
      RETURNING *
    `,
    [
      input.id || randomUUID(),
      input.simPositionId,
      input.userHash,
      input.protectionId ?? null,
      input.entryType,
      input.amountUsd,
      JSON.stringify(input.metadata || {})
    ]
  );
  return mapSimTreasuryLedger(inserted.rows[0]);
};

export const listSimTreasuryLedgerByUserHash = async (
  pool: Queryable,
  userHash: string,
  opts: { limit?: number } = {}
): Promise<SimTreasuryLedgerRecord[]> => {
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 2000));
  const result = await pool.query(
    `
      SELECT * FROM pilot_sim_treasury_ledger
      WHERE user_hash = $1
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [userHash, limit]
  );
  return result.rows.map(mapSimTreasuryLedger);
};

export const getSimPlatformMetrics = async (
  pool: Queryable,
  userHash: string
): Promise<{
  totalPositions: string;
  openPositions: string;
  triggeredPositions: string;
  protectedPositions: string;
  premiumCollectedUsd: string;
  triggerCreditPaidUsd: string;
  treasuryNetUsd: string;
}> => {
  const counts = await pool.query(
    `
      SELECT
        COUNT(*)::text AS total_positions,
        COUNT(*) FILTER (WHERE status = 'open')::text AS open_positions,
        COUNT(*) FILTER (WHERE status = 'triggered')::text AS triggered_positions,
        COUNT(*) FILTER (WHERE protection_enabled = TRUE)::text AS protected_positions
      FROM pilot_sim_positions
      WHERE user_hash = $1
    `,
    [userHash]
  );
  const ledger = await pool.query(
    `
      SELECT
        COALESCE(SUM(CASE WHEN entry_type = 'premium_collected' THEN amount_usd ELSE 0 END), 0)::text AS premium_collected_usd,
        COALESCE(SUM(CASE WHEN entry_type = 'trigger_credit' THEN amount_usd ELSE 0 END), 0)::text AS trigger_credit_paid_usd
      FROM pilot_sim_treasury_ledger
      WHERE user_hash = $1
    `,
    [userHash]
  );
  const countsRow = counts.rows[0] || {};
  const ledgerRow = ledger.rows[0] || {};
  const premiumCollected = new Decimal(String(ledgerRow.premium_collected_usd || "0"));
  const triggerCreditPaid = new Decimal(String(ledgerRow.trigger_credit_paid_usd || "0"));
  return {
    totalPositions: String(countsRow.total_positions || "0"),
    openPositions: String(countsRow.open_positions || "0"),
    triggeredPositions: String(countsRow.triggered_positions || "0"),
    protectedPositions: String(countsRow.protected_positions || "0"),
    premiumCollectedUsd: premiumCollected.toFixed(10),
    triggerCreditPaidUsd: triggerCreditPaid.toFixed(10),
    treasuryNetUsd: premiumCollected.minus(triggerCreditPaid).toFixed(10)
  };
};

export type PilotTermsAcceptanceRecord = {
  id: string;
  userHash: string;
  hashVersion: number;
  termsVersion: string;
  acceptedAt: string;
  acceptedIp: string | null;
  userAgent: string | null;
  source: string;
  details: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export const getPilotTermsAcceptance = async (
  pool: Queryable,
  params: { userHash: string; termsVersion: string }
): Promise<PilotTermsAcceptanceRecord | null> => {
  const result = await pool.query(
    `
      SELECT *
      FROM pilot_terms_acceptances
      WHERE user_hash = $1
        AND terms_version = $2
      LIMIT 1
    `,
    [params.userHash, params.termsVersion]
  );
  if (!result.rowCount) return null;
  return mapPilotTermsAcceptance(result.rows[0]);
};

export const createPilotTermsAcceptanceIfMissing = async (
  pool: Queryable,
  input: {
    userHash: string;
    hashVersion: number;
    termsVersion: string;
    acceptedIp?: string | null;
    userAgent?: string | null;
    source?: string;
    details?: Record<string, unknown>;
  }
): Promise<{ record: PilotTermsAcceptanceRecord; created: boolean }> => {
  const existing = await getPilotTermsAcceptance(pool, {
    userHash: input.userHash,
    termsVersion: input.termsVersion
  });
  if (existing) {
    return { record: existing, created: false };
  }
  const inserted = await pool.query(
    `
      INSERT INTO pilot_terms_acceptances (
        id, user_hash, hash_version, terms_version, accepted_ip, user_agent, source, details
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
      ON CONFLICT (user_hash, terms_version) DO NOTHING
      RETURNING *
    `,
    [
      randomUUID(),
      input.userHash,
      input.hashVersion,
      input.termsVersion,
      input.acceptedIp ?? null,
      input.userAgent ?? null,
      input.source || "pilot_web",
      JSON.stringify(input.details || {})
    ]
  );
  if (Number(inserted.rowCount || 0) > 0) {
    return { record: mapPilotTermsAcceptance(inserted.rows[0]), created: true };
  }
  const postInsertExisting = await getPilotTermsAcceptance(pool, {
    userHash: input.userHash,
    termsVersion: input.termsVersion
  });
  if (!postInsertExisting) {
    throw new Error("terms_acceptance_read_after_insert_failed");
  }
  return { record: postInsertExisting, created: false };
};

export const insertVenueExecution = async (
  pool: Queryable,
  protectionId: string,
  input: VenueExecution
): Promise<void> => {
  await pool.query(
    `
      INSERT INTO pilot_venue_executions (
        id, protection_id, venue, status, quote_id, rfq_id, instrument_id, side, quantity, execution_price, premium,
        executed_at, external_order_id, external_execution_id, details
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
    `,
    [
      randomUUID(),
      protectionId,
      input.venue,
      input.status,
      input.quoteId,
      input.rfqId ?? null,
      input.instrumentId,
      input.side,
      input.quantity.toString(),
      input.executionPrice.toString(),
      input.premium.toString(),
      input.executedAt,
      input.externalOrderId,
      input.externalExecutionId,
      JSON.stringify(input.details || {})
    ]
  );
};

const percentileContLinear = (sorted: number[], p: number): number | null => {
  if (!sorted.length) return null;
  const clamped = Math.max(0, Math.min(1, p));
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * clamped;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
};

const safeNumber = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export const listRecentTenorPolicyRows = async (
  pool: Queryable,
  params: {
    lookbackMinutes: number;
    candidateTenors: number[];
  }
): Promise<TenorPolicyTenorRow[]> => {
  const lookbackMinutes = Math.max(5, Math.min(24 * 60, Math.floor(Number(params.lookbackMinutes || 0) || 60)));
  const cutoffIso = new Date(Date.now() - lookbackMinutes * 60_000).toISOString();
  const normalizedCandidates = Array.from(
    new Set(
      (params.candidateTenors || [])
        .map((n) => Math.floor(Number(n)))
        .filter((n) => Number.isFinite(n) && n > 0 && n <= 60)
    )
  ).sort((a, b) => a - b);
  if (!normalizedCandidates.length) return [];
  const result = await pool.query(
    `
      SELECT details
      FROM pilot_venue_quotes
      WHERE created_at >= $1::timestamptz
      ORDER BY created_at DESC
      LIMIT 2000
    `,
    [cutoffIso]
  );
  type Running = {
    sampleCount: number;
    okCount: number;
    optionsNativeCount: number;
    futuresSyntheticCount: number;
    negativeMatchedCount: number;
    premiumRatios: number[];
    driftDays: number[];
    matchedTenorDays: number[];
  };
  const buckets = new Map<number, Running>();
  for (const tenor of normalizedCandidates) {
    buckets.set(tenor, {
      sampleCount: 0,
      okCount: 0,
      optionsNativeCount: 0,
      futuresSyntheticCount: 0,
      negativeMatchedCount: 0,
      premiumRatios: [],
      driftDays: [],
      matchedTenorDays: []
    });
  }
  for (const row of result.rows) {
    const details = toRecord(row.details);
    const lockContext = toRecord(details.lockContext);
    const requestedRaw = safeNumber(lockContext.requestedTenorDays);
    if (requestedRaw === null) continue;
    const requested = Math.floor(requestedRaw);
    if (!buckets.has(requested)) continue;
    const bucket = buckets.get(requested)!;
    bucket.sampleCount += 1;
    bucket.okCount += 1;
    const quoteDetails = toRecord(details);
    const hedgeModeRaw = String(quoteDetails.hedgeMode || lockContext.hedgeMode || "");
    if (hedgeModeRaw === "options_native") {
      bucket.optionsNativeCount += 1;
    } else if (hedgeModeRaw === "futures_synthetic") {
      bucket.futuresSyntheticCount += 1;
    }
    const selectedTenor =
      safeNumber(quoteDetails.selectedTenorDays) ??
      safeNumber(quoteDetails.selectedTenorDaysActual) ??
      safeNumber(lockContext.selectedTenorDays);
    if (selectedTenor !== null) {
      bucket.matchedTenorDays.push(selectedTenor);
      if (selectedTenor <= 0) bucket.negativeMatchedCount += 1;
      const drift = Math.abs(selectedTenor - requestedRaw);
      if (Number.isFinite(drift)) bucket.driftDays.push(drift);
    }
    const clientPremiumUsd =
      safeNumber(lockContext.clientPremiumUsd) ??
      safeNumber(toRecord(quoteDetails.pricingBreakdown).clientPremiumUsd) ??
      safeNumber(row.premium);
    const protectedNotional = safeNumber(lockContext.protectedNotional);
    if (
      clientPremiumUsd !== null &&
      protectedNotional !== null &&
      protectedNotional > 0 &&
      Number.isFinite(clientPremiumUsd)
    ) {
      bucket.premiumRatios.push(clientPremiumUsd / protectedNotional);
    }
  }
  const rows: TenorPolicyTenorRow[] = [];
  for (const tenor of normalizedCandidates) {
    const bucket = buckets.get(tenor)!;
    const sampleCount = bucket.sampleCount;
    const premiumSorted = [...bucket.premiumRatios].sort((a, b) => a - b);
    const driftSorted = [...bucket.driftDays].sort((a, b) => a - b);
    const matchedSorted = [...bucket.matchedTenorDays].sort((a, b) => a - b);
    rows.push({
      tenorDays: tenor,
      sampleCount,
      metrics: {
        okRate: sampleCount > 0 ? bucket.okCount / sampleCount : 0,
        optionsNativeRate: sampleCount > 0 ? bucket.optionsNativeCount / sampleCount : 0,
        futuresSyntheticRate: sampleCount > 0 ? bucket.futuresSyntheticCount / sampleCount : 0,
        medianPremiumRatio: percentileContLinear(premiumSorted, 0.5),
        medianDriftDays: percentileContLinear(driftSorted, 0.5),
        negativeMatchedTenorRate: sampleCount > 0 ? bucket.negativeMatchedCount / sampleCount : 0,
        medianMatchedTenorDays: percentileContLinear(matchedSorted, 0.5)
      },
      score: null,
      eligible: false,
      reasons: []
    });
  }
  return rows;
};

export const extractLatestPremiumPolicyDiagnostics = async (
  pool: Queryable,
  quoteId: string
): Promise<PremiumPolicyDiagnostics | null> => {
  const result = await pool.query(
    `
      SELECT details
      FROM pilot_venue_quotes
      WHERE quote_id = $1
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [quoteId]
  );
  const details = toRecord(result.rows[0]?.details);
  const lockContext = toRecord(details.lockContext);
  const premiumPolicy = toRecord(lockContext.premiumPolicy);
  if (!Object.keys(premiumPolicy).length) return null;
  return premiumPolicy as PremiumPolicyDiagnostics;
};

export const insertAdminAction = async (pool: Queryable, input: {
  protectionId?: string | null;
  action: string;
  actor: string;
  actorIp?: string | null;
  details?: Record<string, unknown>;
}): Promise<void> => {
  await pool.query(
    `
      INSERT INTO pilot_admin_actions (
        id, protection_id, action, actor, actor_ip, details
      )
      VALUES ($1,$2,$3,$4,$5,$6::jsonb)
    `,
    [
      randomUUID(),
      input.protectionId ?? null,
      input.action,
      input.actor,
      input.actorIp ?? null,
      JSON.stringify(input.details || {})
    ]
  );
};

export const getProofPayload = async (pool: Queryable, protectionId: string): Promise<Record<string, unknown> | null> => {
  const protection = await getProtection(pool, protectionId);
  if (!protection) return null;
  const [snapshots, ledger, executions] = await Promise.all([
    listSnapshotsForProtection(pool, protectionId),
    listLedgerForProtection(pool, protectionId),
    pool.query(
      `SELECT * FROM pilot_venue_executions WHERE protection_id = $1 ORDER BY created_at ASC`,
      [protectionId]
    )
  ]);
  return {
    protection,
    snapshots,
    ledger,
    executions: executions.rows.map((row) => ({
      id: String(row.id),
      venue: String(row.venue),
      status: String(row.status),
      quoteId: String(row.quote_id),
      rfqId: row.rfq_id ? String(row.rfq_id) : null,
      instrumentId: String(row.instrument_id),
      side: String(row.side),
      quantity: String(row.quantity),
      executionPrice: String(row.execution_price),
      premium: String(row.premium),
      executedAt: new Date(row.executed_at).toISOString(),
      externalOrderId: String(row.external_order_id),
      externalExecutionId: String(row.external_execution_id),
      details: toRecord(row.details)
    }))
  };
};

export const getEssentialProofPayload = async (
  pool: Queryable,
  protectionId: string
): Promise<Record<string, unknown> | null> => {
  const protection = await getProtection(pool, protectionId);
  if (!protection) return null;
  const [snapshots, executions] = await Promise.all([
    listSnapshotsForProtection(pool, protectionId),
    pool.query(
      `SELECT * FROM pilot_venue_executions WHERE protection_id = $1 ORDER BY created_at ASC`,
      [protectionId]
    )
  ]);
  const latestExecution = executions.rows.length ? executions.rows[executions.rows.length - 1] : null;
  return {
    protection: {
      id: protection.id,
      status: protection.status,
      marketId: protection.marketId,
      tierName: protection.tierName,
      drawdownFloorPct: protection.drawdownFloorPct,
      floorPrice: protection.floorPrice,
      entryPrice: protection.entryPrice,
      entryPriceSource: protection.entryPriceSource,
      entryPriceTimestamp: protection.entryPriceTimestamp,
      expiryAt: protection.expiryAt,
      expiryPrice: protection.expiryPrice,
      expiryPriceSource: protection.expiryPriceSource,
      expiryPriceTimestamp: protection.expiryPriceTimestamp,
      protectedNotional: protection.protectedNotional,
      venue: protection.venue,
      instrumentId: protection.instrumentId,
      side: protection.side,
      size: protection.size,
      executedAt: protection.executedAt
    },
    snapshots: snapshots.map((snapshot) => ({
      snapshotType: snapshot.snapshotType,
      price: snapshot.price,
      marketId: snapshot.marketId,
      priceSource: snapshot.priceSource,
      priceSourceDetail: snapshot.priceSourceDetail,
      requestId: snapshot.requestId,
      endpointVersion: snapshot.endpointVersion,
      priceTimestamp: snapshot.priceTimestamp
    })),
    execution: latestExecution
      ? {
          venue: String(latestExecution.venue),
          status: String(latestExecution.status),
          quoteId: String(latestExecution.quote_id),
          rfqId: latestExecution.rfq_id ? String(latestExecution.rfq_id) : null,
          instrumentId: String(latestExecution.instrument_id),
          side: String(latestExecution.side),
          quantity: String(latestExecution.quantity),
          executionPrice: String(latestExecution.execution_price),
          executedAt: new Date(latestExecution.executed_at).toISOString(),
          externalOrderId: String(latestExecution.external_order_id),
          externalExecutionId: String(latestExecution.external_execution_id)
        }
      : null
  };
};

const mapPilotTermsAcceptance = (row: Record<string, unknown>): PilotTermsAcceptanceRecord => ({
  id: String(row.id),
  userHash: String(row.user_hash),
  hashVersion: Number(row.hash_version),
  termsVersion: String(row.terms_version),
  acceptedAt: new Date(String(row.accepted_at)).toISOString(),
  acceptedIp: row.accepted_ip ? String(row.accepted_ip) : null,
  userAgent: row.user_agent ? String(row.user_agent) : null,
  source: String(row.source || "pilot_web"),
  details: toRecord(row.details),
  createdAt: new Date(String(row.created_at)).toISOString(),
  updatedAt: new Date(String(row.updated_at)).toISOString()
});

const mapSimPosition = (row: Record<string, unknown>): SimPositionRecord => ({
  id: String(row.id),
  userHash: String(row.user_hash),
  hashVersion: Number(row.hash_version),
  status: String(row.status) as SimPositionStatus,
  marketId: String(row.market_id),
  side: String(row.side) as "long" | "short",
  notionalUsd: String(row.notional_usd),
  entryPrice: String(row.entry_price),
  tierName: row.tier_name ? String(row.tier_name) : null,
  drawdownFloorPct: row.drawdown_floor_pct === null ? null : String(row.drawdown_floor_pct),
  floorPrice: row.floor_price === null ? null : String(row.floor_price),
  protectionEnabled: Boolean(row.protection_enabled),
  protectionId: row.protection_id ? String(row.protection_id) : null,
  protectionPremiumUsd: row.protection_premium_usd === null ? null : String(row.protection_premium_usd),
  protectedLossUsd: row.protected_loss_usd === null ? null : String(row.protected_loss_usd),
  triggerCreditedUsd: String(row.trigger_credited_usd),
  triggerCreditedAt: row.trigger_credited_at ? new Date(String(row.trigger_credited_at)).toISOString() : null,
  metadata: toRecord(row.metadata),
  createdAt: new Date(String(row.created_at)).toISOString(),
  updatedAt: new Date(String(row.updated_at)).toISOString()
});

const mapSimTreasuryLedger = (row: Record<string, unknown>): SimTreasuryLedgerRecord => ({
  id: String(row.id),
  simPositionId: String(row.sim_position_id),
  userHash: String(row.user_hash),
  protectionId: row.protection_id ? String(row.protection_id) : null,
  entryType: String(row.entry_type) as SimTreasuryEntryType,
  amountUsd: String(row.amount_usd),
  metadata: toRecord(row.metadata),
  createdAt: new Date(String(row.created_at)).toISOString()
});

const mapProtection = (row: Record<string, unknown>): ProtectionRecord => ({
  id: String(row.id),
  userHash: String(row.user_hash),
  hashVersion: Number(row.hash_version),
  status: row.status as ProtectionStatus,
  tierName: row.tier_name ? String(row.tier_name) : null,
  drawdownFloorPct: row.drawdown_floor_pct === null ? null : String(row.drawdown_floor_pct),
  floorPrice: row.floor_price === null ? null : String(row.floor_price),
  slPct: row.sl_pct === null || row.sl_pct === undefined ? null : Number(row.sl_pct),
  hedgeStatus: row.hedge_status ? String(row.hedge_status) : null,
  regime: row.regime ? String(row.regime) : null,
  regimeSource: row.regime_source ? String(row.regime_source) : null,
  dvolAtPurchase: row.dvol_at_purchase === null || row.dvol_at_purchase === undefined ? null : Number(row.dvol_at_purchase),
  marketId: String(row.market_id),
  protectedNotional: String(row.protected_notional),
  entryPrice: row.entry_price === null ? null : String(row.entry_price),
  entryPriceSource: row.entry_price_source ? String(row.entry_price_source) : null,
  entryPriceTimestamp: row.entry_price_timestamp
    ? new Date(String(row.entry_price_timestamp)).toISOString()
    : null,
  expiryAt: new Date(String(row.expiry_at)).toISOString(),
  expiryPrice: row.expiry_price === null ? null : String(row.expiry_price),
  expiryPriceSource: row.expiry_price_source ? String(row.expiry_price_source) : null,
  expiryPriceTimestamp: row.expiry_price_timestamp
    ? new Date(String(row.expiry_price_timestamp)).toISOString()
    : null,
  autoRenew: Boolean(row.auto_renew),
  renewWindowMinutes: Number(row.renew_window_minutes || 1440),
  venue: row.venue ? String(row.venue) : null,
  instrumentId: row.instrument_id ? String(row.instrument_id) : null,
  side: row.side ? String(row.side) : null,
  size: row.size === null ? null : String(row.size),
  executionPrice: row.execution_price === null ? null : String(row.execution_price),
  premium: row.premium === null ? null : String(row.premium),
  executedAt: row.executed_at ? new Date(String(row.executed_at)).toISOString() : null,
  externalOrderId: row.external_order_id ? String(row.external_order_id) : null,
  externalExecutionId: row.external_execution_id ? String(row.external_execution_id) : null,
  payoutDueAmount: row.payout_due_amount === null ? null : String(row.payout_due_amount),
  payoutSettledAmount: row.payout_settled_amount === null ? null : String(row.payout_settled_amount),
  payoutSettledAt: row.payout_settled_at ? new Date(String(row.payout_settled_at)).toISOString() : null,
  payoutTxRef: row.payout_tx_ref ? String(row.payout_tx_ref) : null,
  foxifyExposureNotional: String(row.foxify_exposure_notional),
  metadata: toRecord(row.metadata),
  createdAt: new Date(String(row.created_at)).toISOString(),
  updatedAt: new Date(String(row.updated_at)).toISOString()
});

const mapSnapshot = (row: Record<string, unknown>): PriceSnapshotRecord => ({
  id: String(row.id),
  protectionId: String(row.protection_id),
  snapshotType: row.snapshot_type as PriceSnapshotType,
  price: String(row.price),
  marketId: String(row.market_id),
  priceSource: row.price_source as PriceSnapshotRecord["priceSource"],
  priceSourceDetail: String(row.price_source_detail),
  endpointVersion: String(row.endpoint_version),
  requestId: String(row.request_id),
  priceTimestamp: new Date(String(row.price_timestamp)).toISOString(),
  createdAt: new Date(String(row.created_at)).toISOString()
});

