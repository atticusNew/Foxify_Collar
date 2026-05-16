/**
 * P1d — Volume Cover weekly reconciler.
 *
 * Premium accrual semantics (operator-confirmed 2026-05-16):
 *   "Premium is NOT upfront. Foxify only pays for held days. Premiums
 *   and Atticus settlements are reconciled weekly with Atticus paying
 *   25% if owed per week and the other 75% at EOM."
 *
 * Source of truth for premium is the position row itself:
 *   premium_accrued_for_period = dailyPremium × (days_active_in_period)
 *
 *   For a position opened day X, closed (or triggered) day Y, the days
 *   active in a given week W are the intersection of [X, Y] with W.
 *   Days are counted in whole-day units rounded UP (any partial day
 *   counts; matches Foxify per-day billing convention).
 *
 * This module computes a settlement record for any week given the
 * positions table — no scheduler required, no per-day ledger writes.
 * Output is the canonical input for the 25% / 75% Atticus settlement
 * cycle.
 *
 * Outputs:
 *   - per-position rollup: days active, premium owed, payout owed
 *   - per-week totals: gross premium in, gross payout out, hedge_buy_out, hedge_sell_in
 *   - net Atticus obligation = (payout_out + hedge_buy_out) - (premium_in + hedge_sell_in)
 *   - 25% partial settlement amount
 */

import type { Pool } from "pg";
import Decimal from "decimal.js";

export type WeekRange = {
  /** ISO week start (Monday 00:00 UTC). */
  startIso: string;
  /** ISO week end (next Monday 00:00 UTC, exclusive). */
  endIso: string;
  /** Human-readable week label, e.g., "2026-W20". */
  label: string;
};

export type PositionWeekRollup = {
  positionId: string;
  cellId: string;
  foxifyPairId: string;
  fingerprintHash: string | null;
  /** Whole days active during the week (rounded UP from partial days). */
  daysActiveInWeek: number;
  dailyPremiumUsdc: number;
  premiumOwedUsdc: number;
  payoutOwedUsdc: number;
  triggered: boolean;
};

export type WeeklySettlement = {
  week: WeekRange;
  perPosition: PositionWeekRollup[];
  totals: {
    grossPremiumInUsdc: number;
    grossPayoutOutUsdc: number;
    grossHedgeBuyOutUsdc: number;
    grossHedgeSellInUsdc: number;
    /** Net Atticus obligation: positive = Atticus owes Foxify-side. */
    netAtticusObligationUsdc: number;
  };
  /** 25% partial settlement amount; remaining 75% settles at EOM. */
  partial25PctUsdc: number;
  /**
   * P3 §12.4 reconciliation drift halt input. Populated when
   * VenueBalanceFetcher provided. Compares venue balance to
   * ledger-derived expected balance; if drift > driftHaltPct
   * (default 1%), emits driftHalt=true.
   */
  reconciliation: {
    checked: boolean;
    venueReportedBalanceUsdc: number | null;
    ledgerExpectedBalanceUsdc: number | null;
    driftPct: number | null;
    driftHalt: boolean;
    driftMessage: string | null;
  };
  generatedAtIso: string;
};

/**
 * P3: optional venue balance fetcher. Operator wires this to actual
 * Bullish/Deribit balance APIs. Returns the COMBINED USDC-equivalent
 * working balance Atticus has across all hedge venues.
 *
 * Implementations should pull from venue REST endpoints; a 5s timeout
 * is recommended. If the fetch fails, the reconciler treats it as
 * "checked=false" — does NOT auto-halt the platform on a transient
 * venue API blip.
 */
export type VenueBalanceFetcher = () => Promise<number>;

/**
 * Snap a date to the nearest prior Monday 00:00 UTC.
 */
const snapToMondayStart = (d: Date): Date => {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  // getUTCDay: Sun=0, Mon=1, ... Sat=6
  const dayOfWeek = out.getUTCDay();
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  out.setUTCDate(out.getUTCDate() - daysSinceMonday);
  return out;
};

/**
 * Resolve a week label like "YYYY-WW" to a [startIso, endIso] range.
 *
 * Uses ISO 8601 weeks (Mon-start, week 1 = first week with Thursday
 * in the new year). Roughly approximates with snap-to-Monday for
 * simplicity; off-by-one at year boundaries is acceptable since
 * week labels are operator-driven.
 */
export const resolveWeekRange = (label: string): WeekRange => {
  // Format: YYYY-Www  (e.g., 2026-W20)
  const m = /^(\d{4})-W(\d{1,2})$/.exec(label);
  if (!m) {
    throw new Error(`Invalid week label "${label}"; expected YYYY-Www`);
  }
  const year = Number(m[1]);
  const weekNum = Number(m[2]);
  // Jan 4th is always in ISO week 1
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week1Monday = snapToMondayStart(jan4);
  const start = new Date(week1Monday);
  start.setUTCDate(start.getUTCDate() + (weekNum - 1) * 7);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    label
  };
};

/**
 * Compute days active in a week interval given position open/close.
 * Days are whole-day units rounded UP. If position is still active
 * at endIso, treat endIso as the implicit close timestamp.
 */
export const daysActiveInWindow = (params: {
  openedAtIso: string;
  closedAtIso: string | null;
  windowStartIso: string;
  windowEndIso: string;
  /** "now" override for tests. */
  nowMs?: number;
}): number => {
  const opened = new Date(params.openedAtIso).getTime();
  const closed = params.closedAtIso
    ? new Date(params.closedAtIso).getTime()
    : (params.nowMs ?? Date.now());
  const winStart = new Date(params.windowStartIso).getTime();
  const winEnd = new Date(params.windowEndIso).getTime();
  // Intersection of [opened, closed] with [winStart, winEnd)
  const overlapStart = Math.max(opened, winStart);
  const overlapEnd = Math.min(closed, winEnd);
  const overlapMs = overlapEnd - overlapStart;
  if (overlapMs <= 0) return 0;
  // Round UP partial days (Foxify per-day billing)
  return Math.ceil(overlapMs / 86_400_000);
};

/**
 * Build a weekly settlement record from positions + ledger entries.
 * Pure function over DB state; idempotent.
 */
export const buildWeeklySettlement = async (params: {
  pool: Pool;
  weekLabel: string;
  /** Override "now" for tests / deterministic billing. */
  nowMs?: number;
  /**
   * P3: venue balance fetcher for reconciliation drift halt.
   * If omitted, reconciliation.checked=false; settlement still emits.
   */
  venueBalanceFetcher?: VenueBalanceFetcher;
  /**
   * Drift halt threshold (fraction). Default 0.01 (1%) per PLAN §12.4.
   */
  driftHaltPct?: number;
}): Promise<WeeklySettlement> => {
  const week = resolveWeekRange(params.weekLabel);
  const nowMs = params.nowMs ?? Date.now();

  // Positions touching the week (opened before week end, and either
  // still active OR closed/triggered after week start).
  const posResult = await params.pool.query(
    `SELECT id, cell_id, foxify_pair_id, fingerprint_hash,
            daily_premium_usdc, payout_usdc, status,
            opened_at, closed_at, triggered_at
     FROM volume_cover_position
     WHERE opened_at < $2::timestamptz
       AND (closed_at IS NULL OR closed_at >= $1::timestamptz)
       AND (triggered_at IS NULL OR triggered_at >= $1::timestamptz)
     ORDER BY opened_at`,
    [week.startIso, week.endIso]
  );

  const perPosition: PositionWeekRollup[] = [];
  let grossPremium = new Decimal(0);
  let grossPayout = new Decimal(0);

  for (const row of posResult.rows) {
    // Effective close = min(closed_at, triggered_at) if either exists.
    const closeTimes: number[] = [];
    if (row.closed_at) closeTimes.push(new Date(row.closed_at).getTime());
    if (row.triggered_at) closeTimes.push(new Date(row.triggered_at).getTime());
    const effectiveCloseIso = closeTimes.length
      ? new Date(Math.min(...closeTimes)).toISOString()
      : null;

    const days = daysActiveInWindow({
      openedAtIso: String(row.opened_at),
      closedAtIso: effectiveCloseIso,
      windowStartIso: week.startIso,
      windowEndIso: week.endIso,
      nowMs
    });

    const dailyPremium = Number(row.daily_premium_usdc);
    const premium = new Decimal(dailyPremium).mul(days);
    const triggered = row.triggered_at !== null;
    const payoutInWindow =
      triggered &&
      new Date(row.triggered_at).getTime() >= new Date(week.startIso).getTime() &&
      new Date(row.triggered_at).getTime() < new Date(week.endIso).getTime()
        ? Number(row.payout_usdc)
        : 0;

    grossPremium = grossPremium.plus(premium);
    grossPayout = grossPayout.plus(payoutInWindow);

    perPosition.push({
      positionId: String(row.id),
      cellId: String(row.cell_id),
      foxifyPairId: String(row.foxify_pair_id),
      fingerprintHash: row.fingerprint_hash ? String(row.fingerprint_hash) : null,
      daysActiveInWeek: days,
      dailyPremiumUsdc: dailyPremium,
      premiumOwedUsdc: premium.toNumber(),
      payoutOwedUsdc: payoutInWindow,
      triggered
    });
  }

  // Hedge ledger entries created in the week. Includes hedge_buy_out
  // (Atticus debit at open) and hedge_sell_in (Atticus credit when
  // hedge manager sells retained legs). Both are positive amounts;
  // hedge_buy_out is stored as negative in the pilot ledger.
  const ledgerResult = await params.pool.query(
    `SELECT entry_type, COALESCE(SUM(amount_usdc), 0) AS total
     FROM pilot_pool_ledger
     WHERE pool_id = 'atticus_hedge'
       AND reference LIKE 'vc_%'
       AND effective_at >= $1::timestamptz
       AND effective_at < $2::timestamptz
     GROUP BY entry_type`,
    [week.startIso, week.endIso]
  );
  let grossHedgeBuyOut = new Decimal(0);
  let grossHedgeSellIn = new Decimal(0);
  for (const r of ledgerResult.rows) {
    const t = String(r.entry_type);
    const amt = new Decimal(Number(r.total));
    // amount stored as negative for outflows; flip sign to get gross magnitude
    if (t === "hedge_buy_out") grossHedgeBuyOut = grossHedgeBuyOut.plus(amt.abs());
    if (t === "hedge_sell_in") grossHedgeSellIn = grossHedgeSellIn.plus(amt);
  }

  // Net obligation: positive = Atticus owes
  // Atticus pays out: payout_out + hedge_buy_out
  // Atticus receives: premium_in + hedge_sell_in
  // (premium_in is Foxify-pool side, but it's a flow IN to the pilot
  //  pool ledger that we credit against Atticus net obligation per
  //  the operator's 25/75 settlement model.)
  const netAtticusObligation = grossPayout
    .plus(grossHedgeBuyOut)
    .minus(grossPremium)
    .minus(grossHedgeSellIn);

  const partial25 = Decimal.max(0, netAtticusObligation.mul(0.25));

  // P3 §12.4 — Reconciliation drift halt. Compares actual venue
  // balance to ledger-derived expected balance. The expected balance
  // is the sum of hedge_sell_in - hedge_buy_out flows on atticus_hedge
  // pool (i.e., what Atticus's Bullish + Deribit account SHOULD show).
  let reconciliation: WeeklySettlement["reconciliation"] = {
    checked: false,
    venueReportedBalanceUsdc: null,
    ledgerExpectedBalanceUsdc: null,
    driftPct: null,
    driftHalt: false,
    driftMessage: null
  };

  if (params.venueBalanceFetcher) {
    const driftThreshold = params.driftHaltPct ?? 0.01;
    try {
      const ledgerBalanceResult = await params.pool.query(
        `SELECT COALESCE(SUM(amount_usdc), 0) AS balance
         FROM pilot_pool_ledger
         WHERE pool_id = 'atticus_hedge'
           AND reference LIKE 'vc_%'`
      );
      // hedge_buy_out is stored negative; hedge_sell_in positive.
      // Sum gives net cash position relative to start (ignoring
      // initial deposits which aren't tagged 'vc_'). For drift
      // purposes, compare the absolute change from baseline to the
      // venue's realized balance.
      const ledgerBalance = Number(ledgerBalanceResult.rows[0].balance);
      const venueBalance = await params.venueBalanceFetcher();
      const driftAbs = Math.abs(venueBalance - ledgerBalance);
      const denom = Math.max(1, Math.abs(venueBalance), Math.abs(ledgerBalance));
      const driftPct = driftAbs / denom;
      const halt = driftPct > driftThreshold;
      reconciliation = {
        checked: true,
        venueReportedBalanceUsdc: venueBalance,
        ledgerExpectedBalanceUsdc: ledgerBalance,
        driftPct,
        driftHalt: halt,
        driftMessage: halt
          ? `Venue \$${venueBalance.toFixed(2)} vs ledger \$${ledgerBalance.toFixed(2)} drift ${(driftPct * 100).toFixed(2)}% > ${(driftThreshold * 100).toFixed(2)}% threshold`
          : null
      };
    } catch (err) {
      // Non-fatal: do NOT auto-halt on venue API failure.
      reconciliation = {
        checked: false,
        venueReportedBalanceUsdc: null,
        ledgerExpectedBalanceUsdc: null,
        driftPct: null,
        driftHalt: false,
        driftMessage: `venue_balance_fetch_failed: ${(err as Error).message}`
      };
    }
  }

  return {
    week,
    perPosition,
    totals: {
      grossPremiumInUsdc: grossPremium.toNumber(),
      grossPayoutOutUsdc: grossPayout.toNumber(),
      grossHedgeBuyOutUsdc: grossHedgeBuyOut.toNumber(),
      grossHedgeSellInUsdc: grossHedgeSellIn.toNumber(),
      netAtticusObligationUsdc: netAtticusObligation.toNumber()
    },
    partial25PctUsdc: partial25.toNumber(),
    reconciliation,
    generatedAtIso: new Date(nowMs).toISOString()
  };
};

/**
 * Render a Markdown summary of a weekly settlement.
 */
export const renderWeeklySettlementMarkdown = (settlement: WeeklySettlement): string => {
  const fmt = (n: number) => `\$${n.toFixed(2)}`;
  const lines: string[] = [];
  lines.push(`# Volume Cover — Weekly Settlement (${settlement.week.label})`);
  lines.push("");
  lines.push(`**Window:** ${settlement.week.startIso} → ${settlement.week.endIso}`);
  lines.push(`**Generated:** ${settlement.generatedAtIso}`);
  lines.push("");
  lines.push(`## Totals`);
  lines.push("");
  lines.push(`| Stream | Amount |`);
  lines.push(`|---|---|`);
  lines.push(`| Gross premium in (Foxify → Atticus) | ${fmt(settlement.totals.grossPremiumInUsdc)} |`);
  lines.push(`| Gross payout out (Atticus → Foxify) | ${fmt(settlement.totals.grossPayoutOutUsdc)} |`);
  lines.push(`| Gross hedge buy-out (Atticus pool debit) | ${fmt(settlement.totals.grossHedgeBuyOutUsdc)} |`);
  lines.push(`| Gross hedge sell-in (Atticus pool credit) | ${fmt(settlement.totals.grossHedgeSellInUsdc)} |`);
  lines.push(`| **Net Atticus obligation** | **${fmt(settlement.totals.netAtticusObligationUsdc)}** |`);
  lines.push(`| **25% partial settlement** | **${fmt(settlement.partial25PctUsdc)}** (remaining 75% at EOM) |`);
  lines.push("");
  lines.push(`## Reconciliation drift check`);
  lines.push("");
  if (!settlement.reconciliation.checked) {
    lines.push(`Not run this period (no venue balance fetcher wired).`);
  } else {
    const r = settlement.reconciliation;
    lines.push(`- Venue reported: ${fmt(r.venueReportedBalanceUsdc ?? 0)}`);
    lines.push(`- Ledger expected: ${fmt(r.ledgerExpectedBalanceUsdc ?? 0)}`);
    lines.push(`- Drift: ${(r.driftPct! * 100).toFixed(2)}%`);
    lines.push(`- Halt status: ${r.driftHalt ? "**HALTED**" : "OK"}`);
    if (r.driftMessage) lines.push(`- Message: ${r.driftMessage}`);
  }
  lines.push("");
  lines.push(`## Per-position rollup (${settlement.perPosition.length} positions)`);
  lines.push("");
  lines.push(`| Position | Cell | Days | Premium | Triggered | Payout |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const p of settlement.perPosition) {
    lines.push(
      `| ${p.positionId.slice(0, 16)} | ${p.cellId} | ${p.daysActiveInWeek} | ${fmt(p.premiumOwedUsdc)} | ${p.triggered ? "yes" : "no"} | ${fmt(p.payoutOwedUsdc)} |`
    );
  }
  return lines.join("\n");
};
