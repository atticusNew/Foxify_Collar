/**
 * Counterparty ledger for two-sided cooperative volume facility (PR C6).
 *
 * Per-counterparty (Foxify, Atticus) economic event log + balance computation.
 * Every USDC movement is recorded as a ledger entry with party + kind + amount
 * + pair_id reference. Balances are computed from entries (event-sourced).
 *
 * Entry kinds (USDC flow):
 *   hedge_funded       — Foxify funds hedge at activate                  (Foxify -X, no Atticus entry)
 *   salvage_received   — Atticus receives gross salvage at close         (Atticus +Y, no Foxify entry)
 *   tier_split_foxify  — Foxify gets their share at settle               (Foxify +Z)
 *   tier_split_atticus — Atticus gets their share at settle              (Atticus +W)
 *   pool_accrual       — Atticus share accrued in deferred pool          (informational)
 *   pool_settlement    — Pool drained, Atticus gets accrued balance      (Atticus +pool_total)
 *
 * Balance = SUM(amount_usdc) per party (with sign convention: positive = inflow).
 *
 * Atomicity: settle should write all 4 entries (received, split_f, split_a,
 * and Foxify return-of-hedge-cost) in a transaction via withTransaction.
 *
 * Hold (per OD-5): payout mechanics (USDC wire vs on-chain vs Bullish subaccount
 * transfer) deferred — this ledger tracks economic OWED state, not actual money
 * movement. Operator settles + records pool_settlement when payout completes.
 */

import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";

export type CounterpartyParty = "foxify" | "atticus";

export type LedgerEntryKind =
  | "hedge_funded"        // Foxify side: -amount (capital deployed at activate)
  | "salvage_received"    // Atticus side: +amount (gross salvage at close)
  | "tier_split_foxify"   // Foxify side: +amount (their share at settle)
  | "tier_split_atticus"  // Atticus side: +amount (their share at settle)
  | "pool_accrual"        // Atticus side: informational (deferred mode)
  | "pool_settlement";    // Atticus side: +pool_total (operator settles pool)

export type LedgerEntry = {
  entryId: string;
  party: CounterpartyParty;
  kind: LedgerEntryKind;
  amountUsdc: number;     // signed: + = inflow, - = outflow
  pairId: string | null;
  occurredAt: string;
  details: Record<string, unknown>;
};

export const ensureCounterpartyLedgerSchema = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS two_sided_counterparty_ledger (
      entry_id TEXT PRIMARY KEY,
      party TEXT NOT NULL,
      kind TEXT NOT NULL,
      amount_usdc NUMERIC(20, 8) NOT NULL,
      pair_id TEXT,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      CONSTRAINT two_sided_counterparty_ledger_party_check
        CHECK (party IN ('foxify', 'atticus')),
      CONSTRAINT two_sided_counterparty_ledger_kind_check
        CHECK (kind IN ('hedge_funded', 'salvage_received', 'tier_split_foxify', 'tier_split_atticus', 'pool_accrual', 'pool_settlement'))
    );
  `);
  try {
    await pool.query(`CREATE INDEX IF NOT EXISTS two_sided_counterparty_ledger_party_idx ON two_sided_counterparty_ledger(party);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS two_sided_counterparty_ledger_pair_idx ON two_sided_counterparty_ledger(pair_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS two_sided_counterparty_ledger_occurred_idx ON two_sided_counterparty_ledger(occurred_at);`);
  } catch { /* pg-mem may not support index */ }
};

export const recordEntry = async (
  exec: Pool | PoolClient,
  input: { party: CounterpartyParty; kind: LedgerEntryKind; amountUsdc: number; pairId?: string | null; details?: Record<string, unknown> }
): Promise<LedgerEntry> => {
  const entryId = randomUUID();
  await exec.query(
    `INSERT INTO two_sided_counterparty_ledger (entry_id, party, kind, amount_usdc, pair_id, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [entryId, input.party, input.kind, input.amountUsdc, input.pairId ?? null, JSON.stringify(input.details ?? {})]
  );
  return {
    entryId,
    party: input.party,
    kind: input.kind,
    amountUsdc: input.amountUsdc,
    pairId: input.pairId ?? null,
    occurredAt: new Date().toISOString(),
    details: input.details ?? {}
  };
};

/**
 * Convenience: record the full set of entries for an activate event.
 * Foxify funds the hedge (negative — capital out).
 */
export const recordActivateEntries = async (
  exec: Pool | PoolClient,
  pairId: string,
  hedgeCostUsdc: number
): Promise<void> => {
  await recordEntry(exec, {
    party: "foxify",
    kind: "hedge_funded",
    amountUsdc: -hedgeCostUsdc,
    pairId,
    details: { hedge_cost: hedgeCostUsdc }
  });
};

/**
 * Convenience: record the full set of entries for a settle event.
 *   salvage_received: Atticus +salvage (gross — represents money received from venue close)
 *   tier_split_foxify: Foxify +foxifyShare (their economic share at settle)
 *   tier_split_atticus: Atticus +atticusShare (their economic share)
 *
 * Note: Atticus has BOTH salvage_received (+salvage) AND a virtual -X for the
 * foxify share transfer, but for simplicity and audit clarity we record only the
 * NET economic flow per party. To keep Atticus's net = atticus_share, we use:
 *   - Atticus: tier_split_atticus +atticusShare
 *   - Foxify: tier_split_foxify +foxifyShare
 * And skip the gross salvage_received (it's recoverable from pair record).
 *
 * If you want full gross flows for auditing, pass `includeGross: true`.
 */
export const recordSettleEntries = async (
  exec: Pool | PoolClient,
  input: {
    pairId: string;
    salvageProceedsUsdc: number;
    foxifyShareUsdc: number;
    atticusShareUsdc: number;
    upliftUsdc: number;
    isDeferredPoolActive?: boolean;
    includeGross?: boolean;
  }
): Promise<void> => {
  const { pairId } = input;
  if (input.includeGross) {
    await recordEntry(exec, {
      party: "atticus",
      kind: "salvage_received",
      amountUsdc: input.salvageProceedsUsdc,
      pairId,
      details: { salvage: input.salvageProceedsUsdc }
    });
  }
  await recordEntry(exec, {
    party: "foxify",
    kind: "tier_split_foxify",
    amountUsdc: input.foxifyShareUsdc,
    pairId,
    details: { share: input.foxifyShareUsdc, uplift: input.upliftUsdc }
  });
  if (input.isDeferredPoolActive) {
    await recordEntry(exec, {
      party: "atticus",
      kind: "pool_accrual",
      amountUsdc: 0, // informational; balance contribution comes from pool_settlement later
      pairId,
      details: { share_accrued: input.atticusShareUsdc, uplift: input.upliftUsdc }
    });
  } else {
    await recordEntry(exec, {
      party: "atticus",
      kind: "tier_split_atticus",
      amountUsdc: input.atticusShareUsdc,
      pairId,
      details: { share: input.atticusShareUsdc, uplift: input.upliftUsdc }
    });
  }
};

export const recordPoolSettlement = async (
  exec: Pool | PoolClient,
  totalAccruedUsdc: number,
  details: Record<string, unknown> = {}
): Promise<LedgerEntry> => {
  return recordEntry(exec, {
    party: "atticus",
    kind: "pool_settlement",
    amountUsdc: totalAccruedUsdc,
    pairId: null,
    details
  });
};

export const getBalance = async (exec: Pool | PoolClient, party: CounterpartyParty, asOfIso?: string): Promise<number> => {
  const args = asOfIso ? [party, asOfIso] : [party];
  const q = asOfIso
    ? `SELECT COALESCE(SUM(amount_usdc), 0) AS bal FROM two_sided_counterparty_ledger WHERE party = $1 AND occurred_at <= $2`
    : `SELECT COALESCE(SUM(amount_usdc), 0) AS bal FROM two_sided_counterparty_ledger WHERE party = $1`;
  const r = await exec.query(q, args);
  return Number(r.rows[0]?.bal ?? 0);
};

export const getStatement = async (
  exec: Pool | PoolClient,
  party: CounterpartyParty,
  opts: { sinceIso?: string; untilIso?: string; limit?: number } = {}
): Promise<LedgerEntry[]> => {
  const args: unknown[] = [party];
  const where: string[] = ["party = $1"];
  let idx = 2;
  if (opts.sinceIso) { where.push(`occurred_at >= $${idx++}`); args.push(opts.sinceIso); }
  if (opts.untilIso) { where.push(`occurred_at <= $${idx++}`); args.push(opts.untilIso); }
  const limit = opts.limit ?? 1000;
  const r = await exec.query(
    `SELECT * FROM two_sided_counterparty_ledger WHERE ${where.join(" AND ")} ORDER BY occurred_at DESC, entry_id DESC LIMIT ${limit}`,
    args
  );
  return r.rows.map((row) => ({
    entryId: row.entry_id,
    party: row.party,
    kind: row.kind,
    amountUsdc: Number(row.amount_usdc),
    pairId: row.pair_id ?? null,
    occurredAt: row.occurred_at,
    details: row.details ?? {}
  }));
};
