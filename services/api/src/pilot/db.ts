import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import Decimal from "decimal.js";
import type {
  LedgerEntryType,
  PriceSnapshotRecord,
  PriceSnapshotType,
  ProtectionRecord,
  ProtectionStatus,
  VenueExecution,
  VenueQuote
} from "./types";

let poolSingleton: Pool | null = null;
let schemaReady = false;
type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

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
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

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

    CREATE INDEX IF NOT EXISTS pilot_protections_status_idx ON pilot_protections(status);
    CREATE INDEX IF NOT EXISTS pilot_protections_expiry_idx ON pilot_protections(expiry_at);
    CREATE INDEX IF NOT EXISTS pilot_ledger_entries_protection_idx ON pilot_ledger_entries(protection_id);
    CREATE INDEX IF NOT EXISTS pilot_price_snapshots_protection_idx ON pilot_price_snapshots(protection_id);
  `);
  schemaReady = true;
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
  const result = await pool.query(
    `
      INSERT INTO pilot_protections (
        id, user_hash, hash_version, status, tier_name, drawdown_floor_pct, market_id, protected_notional, foxify_exposure_notional,
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
      JSON.stringify(input.metadata || {})
    ]
  );
  return mapProtection(result.rows[0]);
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
  pool: Queryable
): Promise<{
  totalProtections: string;
  activeProtections: string;
  protectedNotionalTotalUsdc: string;
  protectedNotionalActiveUsdc: string;
  hedgePremiumTotalUsdc: string;
  premiumDueTotalUsdc: string;
  premiumSettledTotalUsdc: string;
  payoutDueTotalUsdc: string;
  payoutSettledTotalUsdc: string;
  netSettledCashUsdc: string;
}> => {
  const result = await pool.query(
    `
      SELECT
        COUNT(*)::text AS total_protections,
        COUNT(*) FILTER (WHERE status = 'active')::text AS active_protections,
        COALESCE(SUM(protected_notional), 0)::text AS protected_notional_total_usdc,
        COALESCE(SUM(CASE WHEN status = 'active' THEN protected_notional ELSE 0 END), 0)::text AS protected_notional_active_usdc,
        COALESCE(SUM(premium), 0)::text AS hedge_premium_total_usdc,
        COALESCE(SUM(COALESCE(payout_due_amount, 0)), 0)::text AS payout_due_total_usdc,
        COALESCE(SUM(COALESCE(payout_settled_amount, 0)), 0)::text AS payout_settled_total_usdc
      FROM pilot_protections
    `
  );
  const ledger = await pool.query(
    `
      SELECT
        COALESCE(SUM(CASE WHEN entry_type = 'premium_due' THEN amount ELSE 0 END), 0)::text AS premium_due_total_usdc,
        COALESCE(SUM(CASE WHEN entry_type = 'premium_settled' THEN amount ELSE 0 END), 0)::text AS premium_settled_total_usdc
      FROM pilot_ledger_entries
    `
  );
  const row = result.rows[0] || {};
  const ledgerRow = ledger.rows[0] || {};
  const premiumSettled = String(ledgerRow.premium_settled_total_usdc || "0");
  const payoutSettled = String(row.payout_settled_total_usdc || "0");
  const netSettledCashUsdc = new Decimal(premiumSettled).minus(new Decimal(payoutSettled)).toFixed(10);
  return {
    totalProtections: String(row.total_protections || "0"),
    activeProtections: String(row.active_protections || "0"),
    protectedNotionalTotalUsdc: String(row.protected_notional_total_usdc || "0"),
    protectedNotionalActiveUsdc: String(row.protected_notional_active_usdc || "0"),
    hedgePremiumTotalUsdc: String(row.hedge_premium_total_usdc || "0"),
    premiumDueTotalUsdc: String(ledgerRow.premium_due_total_usdc || "0"),
    premiumSettledTotalUsdc: premiumSettled,
    payoutDueTotalUsdc: String(row.payout_due_total_usdc || "0"),
    payoutSettledTotalUsdc: payoutSettled,
    netSettledCashUsdc
  };
};

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

export const getVenueQuoteByQuoteId = async (
  pool: Queryable,
  quoteId: string
): Promise<(VenueQuote & { protectionId: string | null }) | null> => {
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
    protectionId: row.protection_id ? String(row.protection_id) : null
  };
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

const mapProtection = (row: Record<string, unknown>): ProtectionRecord => ({
  id: String(row.id),
  userHash: String(row.user_hash),
  hashVersion: Number(row.hash_version),
  status: row.status as ProtectionStatus,
  tierName: row.tier_name ? String(row.tier_name) : null,
  drawdownFloorPct: row.drawdown_floor_pct === null ? null : String(row.drawdown_floor_pct),
  floorPrice: row.floor_price === null ? null : String(row.floor_price),
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

