/**
 * Volume Cover counterparty credit ledger (2026-05-23).
 *
 * Models the deferred-payment relationship between Atticus and Foxify
 * agreed during the 2026-05-22 product spec discussion:
 *
 *   On trigger:  Atticus owes Foxify the cell payout (e.g. $1,000)
 *                25% due NEXT FRIDAY, 75% due END OF MONTH
 *
 *   On premium:  Foxify owes Atticus the per-day billable premium
 *                25% due NEXT FRIDAY, 75% due END OF MONTH
 *
 * Each obligation is materialized as TWO rows in the ledger — one for
 * each tranche. Settlement marks the row by entry_id; aging buckets
 * read from due_date.
 *
 * Why two rows instead of one row with a "fraction_settled" column:
 *   - Each tranche has a distinct due_date → cleaner aging buckets
 *   - Settlement is row-grained → can settle the weekly tranche
 *     independently of the monthly tranche
 *   - Aging reports group by (party_owes, status, due_date_bucket)
 *
 * Idempotency: inserts use a unique key on (category, source_event_id,
 * tranche) so the same trigger or premium-day cannot accidentally
 * insert twice.
 */

import type { Pool, PoolClient } from "pg";

// ─── Types ───────────────────────────────────────────────────────────

export type CounterpartyDirection = "atticus_to_foxify" | "foxify_to_atticus";

export type CounterpartyCategory =
  | "trigger_payout"
  | "premium_billing"
  | "adjustment_manual";

export type CounterpartyTranche = "weekly_25" | "monthly_75";

export type CounterpartyLedgerEntry = {
  entryId: string;
  createdAtIso: string;
  partyOwes: CounterpartyDirection;
  amountUsdc: number;
  category: CounterpartyCategory;
  tranche: CounterpartyTranche;
  cellId: string | null;
  foxifyPositionId: string | null;
  triggerEventId: string | null;
  sourceEventId: string;
  dueDateIso: string; // YYYY-MM-DD
  settledAtIso: string | null;
  settledAmountUsdc: number | null;
  paymentReference: string | null;
  notes: string | null;
};

// ─── Tranche split ───────────────────────────────────────────────────

const DEFAULT_WEEKLY_FRACTION = 0.25;
const DEFAULT_MONTHLY_FRACTION = 0.75;

const fractionsValid = (w: number, m: number): boolean =>
  Number.isFinite(w) && Number.isFinite(m) && w >= 0 && m >= 0 && Math.abs(w + m - 1) < 1e-9;

export const getConfiguredTrancheFractions = (): { weekly: number; monthly: number } => {
  const w = Number(process.env.VC_COUNTERPARTY_WEEKLY_FRACTION ?? DEFAULT_WEEKLY_FRACTION);
  const m = Number(process.env.VC_COUNTERPARTY_MONTHLY_FRACTION ?? DEFAULT_MONTHLY_FRACTION);
  if (!fractionsValid(w, m)) {
    return { weekly: DEFAULT_WEEKLY_FRACTION, monthly: DEFAULT_MONTHLY_FRACTION };
  }
  return { weekly: w, monthly: m };
};

// ─── Due-date computation ────────────────────────────────────────────

/**
 * Compute the next Friday (UTC) from the given Date. If today is Friday,
 * returns the SAME day (assume settlement runs end-of-day Friday).
 */
export const nextFridayUtc = (from: Date): Date => {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  // UTC day: 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
  const dow = d.getUTCDay();
  const daysUntilFriday = (5 - dow + 7) % 7; // 0 if today is Friday
  d.setUTCDate(d.getUTCDate() + daysUntilFriday);
  return d;
};

/**
 * Compute the end-of-month (UTC) from the given Date. If today is the
 * last day of the month, returns the same day. Time component zeroed
 * to midnight UTC.
 */
export const endOfMonthUtc = (from: Date): Date => {
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  // Subtract one day to land on the last day of the source month
  next.setUTCDate(next.getUTCDate() - 1);
  return next;
};

const toDateIso = (d: Date): string => d.toISOString().slice(0, 10);

// ─── Schema ──────────────────────────────────────────────────────────

export const ensureCounterpartyLedgerSchema = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS counterparty_credit_ledger (
      entry_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      party_owes          TEXT NOT NULL,
      amount_usdc         NUMERIC(20, 8) NOT NULL,
      category            TEXT NOT NULL,
      tranche             TEXT NOT NULL,
      cell_id             TEXT,
      foxify_position_id  TEXT,
      trigger_event_id    TEXT,
      source_event_id     TEXT NOT NULL,
      due_date            DATE NOT NULL,
      settled_at          TIMESTAMPTZ,
      settled_amount_usdc NUMERIC(20, 8),
      payment_reference   TEXT,
      notes               TEXT,
      metadata            JSONB
    );
  `);
  const safeIdx = async (sql: string): Promise<void> => {
    try { await pool.query(sql); } catch { /* exists */ }
  };
  await safeIdx(`
    CREATE UNIQUE INDEX uniq_counterparty_event_tranche
    ON counterparty_credit_ledger (category, source_event_id, tranche)
  `);
  await safeIdx(`CREATE INDEX idx_counterparty_due_date ON counterparty_credit_ledger (due_date)`);
  await safeIdx(`CREATE INDEX idx_counterparty_party ON counterparty_credit_ledger (party_owes, settled_at)`);
  await safeIdx(`CREATE INDEX idx_counterparty_cell ON counterparty_credit_ledger (cell_id)`);
};

// ─── Insert API ──────────────────────────────────────────────────────

export type RecordObligationParams = {
  pool: Pool | PoolClient;
  partyOwes: CounterpartyDirection;
  amountUsdc: number;
  category: CounterpartyCategory;
  /**
   * Stable unique key for this obligation event. e.g. for trigger payouts:
   *   `trigger:${positionId}`
   * For daily premium accrual:
   *   `premium:${positionId}:${utcDateYYYYMMDD}`
   */
  sourceEventId: string;
  cellId?: string | null;
  foxifyPositionId?: string | null;
  triggerEventId?: string | null;
  nowMs?: number;
  notes?: string | null;
};

/**
 * Record an obligation with 25%/75% deferred-payment schedule. Inserts
 * TWO rows (weekly_25 + monthly_75). On unique-key conflict (same source
 * event already recorded) returns the existing entry IDs.
 */
export const recordObligationWithDeferralSchedule = async (
  params: RecordObligationParams
): Promise<{ weeklyEntryId: string | null; monthlyEntryId: string | null }> => {
  if (!Number.isFinite(params.amountUsdc) || params.amountUsdc <= 0) {
    return { weeklyEntryId: null, monthlyEntryId: null };
  }
  const fractions = getConfiguredTrancheFractions();
  const now = new Date(params.nowMs ?? Date.now());
  const weeklyDue = toDateIso(nextFridayUtc(now));
  const monthlyDue = toDateIso(endOfMonthUtc(now));

  const weeklyAmount = Number((params.amountUsdc * fractions.weekly).toFixed(8));
  const monthlyAmount = Number((params.amountUsdc * fractions.monthly).toFixed(8));

  const insert = async (
    amount: number,
    tranche: CounterpartyTranche,
    dueDate: string
  ): Promise<string | null> => {
    const r = await params.pool.query<{ entry_id: string }>(
      `INSERT INTO counterparty_credit_ledger
         (party_owes, amount_usdc, category, tranche, cell_id,
          foxify_position_id, trigger_event_id, source_event_id,
          due_date, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10)
       ON CONFLICT (category, source_event_id, tranche) DO NOTHING
       RETURNING entry_id`,
      [
        params.partyOwes,
        amount,
        params.category,
        tranche,
        params.cellId ?? null,
        params.foxifyPositionId ?? null,
        params.triggerEventId ?? null,
        params.sourceEventId,
        dueDate,
        params.notes ?? null
      ]
    );
    return r.rows[0]?.entry_id ?? null;
  };

  const weeklyEntryId = weeklyAmount > 0 ? await insert(weeklyAmount, "weekly_25", weeklyDue) : null;
  const monthlyEntryId = monthlyAmount > 0 ? await insert(monthlyAmount, "monthly_75", monthlyDue) : null;
  return { weeklyEntryId, monthlyEntryId };
};

// ─── Settlement API ──────────────────────────────────────────────────

export type SettleEntryParams = {
  pool: Pool | PoolClient;
  entryId: string;
  settledAmountUsdc?: number;
  paymentReference?: string | null;
  notes?: string | null;
  nowMs?: number;
};

export const settleLedgerEntry = async (params: SettleEntryParams): Promise<boolean> => {
  const nowIso = new Date(params.nowMs ?? Date.now()).toISOString();
  const r = await params.pool.query(
    `UPDATE counterparty_credit_ledger
        SET settled_at = $2::timestamptz,
            settled_amount_usdc = COALESCE($3::numeric, amount_usdc),
            payment_reference = $4,
            notes = COALESCE($5, notes)
      WHERE entry_id = $1::uuid AND settled_at IS NULL
      RETURNING entry_id`,
    [
      params.entryId,
      nowIso,
      params.settledAmountUsdc ?? null,
      params.paymentReference ?? null,
      params.notes ?? null
    ]
  );
  return (r.rowCount ?? 0) > 0;
};

// ─── Reporting API ───────────────────────────────────────────────────

export type CounterpartySummary = {
  generatedAtIso: string;
  atticusOwesFoxifyTotalUsdc: number;
  foxifyOwesAtticusTotalUsdc: number;
  netExposureUsdc: number; // Foxify→Atticus minus Atticus→Foxify
  byDirection: Record<CounterpartyDirection, DirectionSummary>;
};

export type DirectionSummary = {
  unsettledTotalUsdc: number;
  unsettledByAgeBucket: {
    notYetDue: number;
    dueWithin7Days: number;
    overdue1To7Days: number;
    overdue8To30Days: number;
    overdueOver30Days: number;
  };
  unsettledByCategory: Record<CounterpartyCategory, number>;
};

const ZERO_BUCKETS = (): DirectionSummary["unsettledByAgeBucket"] => ({
  notYetDue: 0,
  dueWithin7Days: 0,
  overdue1To7Days: 0,
  overdue8To30Days: 0,
  overdueOver30Days: 0
});

const ZERO_CATEGORY_TOTALS = (): Record<CounterpartyCategory, number> => ({
  trigger_payout: 0,
  premium_billing: 0,
  adjustment_manual: 0
});

const ageBucketOf = (
  dueDate: Date,
  now: Date
): keyof DirectionSummary["unsettledByAgeBucket"] => {
  const diffDays = Math.floor((now.getTime() - dueDate.getTime()) / 86_400_000);
  if (diffDays < -7) return "notYetDue";
  if (diffDays <= 0) return "dueWithin7Days";
  if (diffDays <= 7) return "overdue1To7Days";
  if (diffDays <= 30) return "overdue8To30Days";
  return "overdueOver30Days";
};

export const summarizeCounterpartyCredit = async (params: {
  pool: Pool;
  nowMs?: number;
}): Promise<CounterpartySummary> => {
  const now = new Date(params.nowMs ?? Date.now());
  const r = await params.pool.query<{
    party_owes: CounterpartyDirection;
    category: CounterpartyCategory;
    amount_usdc: string;
    due_date: string;
  }>(
    `SELECT party_owes, category, amount_usdc, due_date
     FROM counterparty_credit_ledger
     WHERE settled_at IS NULL`
  );

  const byDirection: Record<CounterpartyDirection, DirectionSummary> = {
    atticus_to_foxify: {
      unsettledTotalUsdc: 0,
      unsettledByAgeBucket: ZERO_BUCKETS(),
      unsettledByCategory: ZERO_CATEGORY_TOTALS()
    },
    foxify_to_atticus: {
      unsettledTotalUsdc: 0,
      unsettledByAgeBucket: ZERO_BUCKETS(),
      unsettledByCategory: ZERO_CATEGORY_TOTALS()
    }
  };

  for (const row of r.rows) {
    const amount = Number(row.amount_usdc);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const dir = byDirection[row.party_owes];
    if (!dir) continue;
    dir.unsettledTotalUsdc = Number((dir.unsettledTotalUsdc + amount).toFixed(8));
    dir.unsettledByCategory[row.category] = Number(
      (dir.unsettledByCategory[row.category] + amount).toFixed(8)
    );
    const dueDate = new Date(row.due_date + "T00:00:00Z");
    const bucket = ageBucketOf(dueDate, now);
    dir.unsettledByAgeBucket[bucket] = Number(
      (dir.unsettledByAgeBucket[bucket] + amount).toFixed(8)
    );
  }

  const atticus = byDirection.atticus_to_foxify.unsettledTotalUsdc;
  const foxify = byDirection.foxify_to_atticus.unsettledTotalUsdc;
  return {
    generatedAtIso: now.toISOString(),
    atticusOwesFoxifyTotalUsdc: atticus,
    foxifyOwesAtticusTotalUsdc: foxify,
    netExposureUsdc: Number((foxify - atticus).toFixed(8)),
    byDirection
  };
};

/**
 * Halt-new-cells decision support. Returns true if the unsettled
 * Foxify→Atticus exposure exceeds the configured threshold (default
 * $25k, configurable via VC_COUNTERPARTY_HALT_THRESHOLD_USDC). When
 * true, the activation handler should reject new openings until
 * Foxify catches up.
 */
export const shouldHaltDueToCounterpartyExposure = (summary: CounterpartySummary): {
  halt: boolean;
  thresholdUsdc: number;
  unsettledUsdc: number;
} => {
  const thresholdRaw = Number(process.env.VC_COUNTERPARTY_HALT_THRESHOLD_USDC ?? 25_000);
  const threshold = Number.isFinite(thresholdRaw) && thresholdRaw > 0 ? thresholdRaw : 25_000;
  return {
    halt: summary.foxifyOwesAtticusTotalUsdc > threshold,
    thresholdUsdc: threshold,
    unsettledUsdc: summary.foxifyOwesAtticusTotalUsdc
  };
};

export const listLedgerEntries = async (params: {
  pool: Pool;
  partyOwes?: CounterpartyDirection;
  category?: CounterpartyCategory;
  settled?: boolean | null;
  limit?: number;
}): Promise<CounterpartyLedgerEntry[]> => {
  const wheres: string[] = [];
  const args: unknown[] = [];
  if (params.partyOwes) {
    args.push(params.partyOwes);
    wheres.push(`party_owes = $${args.length}`);
  }
  if (params.category) {
    args.push(params.category);
    wheres.push(`category = $${args.length}`);
  }
  if (params.settled === true) {
    wheres.push(`settled_at IS NOT NULL`);
  } else if (params.settled === false) {
    wheres.push(`settled_at IS NULL`);
  }
  const where = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(1000, params.limit ?? 200));
  const r = await params.pool.query(
    `SELECT entry_id, created_at, party_owes, amount_usdc, category, tranche,
            cell_id, foxify_position_id, trigger_event_id, source_event_id,
            due_date, settled_at, settled_amount_usdc, payment_reference, notes
       FROM counterparty_credit_ledger
       ${where}
       ORDER BY created_at DESC
       LIMIT ${limit}`,
    args
  );
  return r.rows.map((row) => ({
    entryId: String(row.entry_id),
    createdAtIso: new Date(row.created_at).toISOString(),
    partyOwes: row.party_owes as CounterpartyDirection,
    amountUsdc: Number(row.amount_usdc),
    category: row.category as CounterpartyCategory,
    tranche: row.tranche as CounterpartyTranche,
    cellId: row.cell_id ?? null,
    foxifyPositionId: row.foxify_position_id ?? null,
    triggerEventId: row.trigger_event_id ?? null,
    sourceEventId: String(row.source_event_id),
    dueDateIso:
      row.due_date instanceof Date
        ? row.due_date.toISOString().slice(0, 10)
        : String(row.due_date).slice(0, 10),
    settledAtIso: row.settled_at ? new Date(row.settled_at).toISOString() : null,
    settledAmountUsdc: row.settled_amount_usdc !== null ? Number(row.settled_amount_usdc) : null,
    paymentReference: row.payment_reference ?? null,
    notes: row.notes ?? null
  }));
};
