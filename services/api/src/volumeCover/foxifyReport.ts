/**
 * Foxify daily report builder (Atticus-only consumption per rev 2 lock).
 *
 * Produces a single JSON document for a given UTC date covering:
 *   - Position activity (opened/triggered/closed)
 *   - Premium accrued + payouts owed
 *   - Salvage telemetry + state
 *   - Atticus P&L (today + 7d rolling)
 *   - Cell status (enabled, throttle, opened today)
 *   - Active guardrails (which guards are blocking activations)
 *   - Settlement schedule
 *
 * No PII, no secrets. Safe to share if Foxify ever asks for visibility,
 * but per current scope only YOU (admin) can pull this.
 */

import type { Pool } from "pg";
import {
  listCells,
  listPositionsForCellToday,
  sumActivePayoutLiability
} from "./volumeCoverDb";
import { summarizeSalvageForReport } from "./salvageTracker";
import {
  checkAllGuardsForVolumeCoverActivate,
  getManualHalt
} from "./volumeCoverGuardrails";
import { isCircuitBreakerActive, getCircuitBreakerState } from "../pilot/circuitBreaker";

export type FoxifyDailyReport = {
  reportDate: string;
  reportGeneratedAt: string;
  positionsOpenedToday: number;
  positionsActiveAtEod: number;
  positionsTriggeredToday: number;
  positionsClosedToday: number;
  totalPremiumBilledToFoxifyUsdc: number;
  totalPayoutsOwedToFoxifyUsdc: number;
  weeklySettlementDueIso: string;
  monthlySettlementDueIso: string;
  salvageStatsRolling5: {
    triggerCount: number;
    avgSalvagePct: number | null;
    state: "normal" | "throttle" | "halt";
  };
  atticusPnlTodayUsdc: number;
  atticusPnl7dayRollingUsdc: number;
  guardrailsActive: Array<{ name: string; reason: string; details?: Record<string, unknown> }>;
  cellsStatus: Array<{
    cellId: string;
    enabled: boolean;
    throttleMaxPerDay: number;
    openedToday: number;
    activeNow: number;
    dailyPremiumUsdc: number;
    payoutUsdc: number;
  }>;
};

const startOfUtcDay = (dateIso: string): Date => {
  const d = new Date(dateIso);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

const startOfNextUtcDay = (dateIso: string): Date => {
  const d = startOfUtcDay(dateIso);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
};

const nextWeeklySettlementIso = (fromDate: Date): string => {
  // Next Monday at 00:00 UTC
  const d = new Date(fromDate);
  const dayOfWeek = d.getUTCDay(); // 0 = Sun, 1 = Mon
  const daysUntilMonday = (8 - dayOfWeek) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + daysUntilMonday);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
};

const nextMonthlySettlementIso = (fromDate: Date): string => {
  // First day of next month at 00:00 UTC
  const d = new Date(fromDate);
  d.setUTCMonth(d.getUTCMonth() + 1, 1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
};

/**
 * Build a daily report for a given UTC date (YYYY-MM-DD).
 * If reportDate is "today", uses current UTC date.
 */
export const buildFoxifyDailyReport = async (params: {
  pool: Pool;
  reportDate: string; // YYYY-MM-DD
}): Promise<FoxifyDailyReport> => {
  const dayStart = startOfUtcDay(params.reportDate + "T00:00:00Z");
  const dayEnd = startOfNextUtcDay(params.reportDate + "T00:00:00Z");

  const cells = await listCells(params.pool);
  const cellsStatus: FoxifyDailyReport["cellsStatus"] = [];

  let positionsOpenedToday = 0;
  let totalPremiumToday = 0;

  for (const cell of cells) {
    const todayPositions = await listPositionsForCellToday(params.pool, {
      cellId: cell.cellId,
      sinceIso: dayStart.toISOString()
    });
    const openedToday = todayPositions.filter(
      (p) => new Date(p.openedAt) < dayEnd
    ).length;
    const activeNow = todayPositions.filter((p) => p.status === "active").length;
    positionsOpenedToday += openedToday;
    totalPremiumToday += openedToday * cell.dailyPremiumUsdc;
    cellsStatus.push({
      cellId: cell.cellId,
      enabled: cell.enabled,
      throttleMaxPerDay: cell.throttleMaxPerDay,
      openedToday,
      activeNow,
      dailyPremiumUsdc: cell.dailyPremiumUsdc,
      payoutUsdc: cell.payoutUsdc
    });
  }

  // Today's triggers, closes, payouts
  const todayTriggersResult = await params.pool.query(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(payout_owed_usdc), 0) AS total_payouts,
            COALESCE(SUM(net_atticus_loss_usdc), 0) AS total_loss
     FROM volume_cover_salvage_event
     WHERE triggered_at >= $1 AND triggered_at < $2`,
    [dayStart.toISOString(), dayEnd.toISOString()]
  );
  const positionsTriggeredToday = Number(todayTriggersResult.rows[0].cnt);
  const totalPayoutsOwedToday = Number(todayTriggersResult.rows[0].total_payouts);
  const todayLoss = Number(todayTriggersResult.rows[0].total_loss);

  const todayClosesResult = await params.pool.query(
    `SELECT COUNT(*) AS cnt FROM volume_cover_position
     WHERE closed_at >= $1 AND closed_at < $2`,
    [dayStart.toISOString(), dayEnd.toISOString()]
  );
  const positionsClosedToday = Number(todayClosesResult.rows[0].cnt);

  const activeAtEodResult = await params.pool.query(
    `SELECT COUNT(*) AS cnt FROM volume_cover_position
     WHERE status = 'active' AND opened_at < $1`,
    [dayEnd.toISOString()]
  );
  const positionsActiveAtEod = Number(activeAtEodResult.rows[0].cnt);

  // Salvage summary
  const { rolling5 } = await summarizeSalvageForReport(params.pool);

  // 7-day Atticus P&L (premium income - payouts - net hedge loss)
  const sevenDayAgo = new Date(dayEnd);
  sevenDayAgo.setUTCDate(sevenDayAgo.getUTCDate() - 7);
  const sevenDayLossResult = await params.pool.query(
    `SELECT COALESCE(SUM(net_atticus_loss_usdc), 0) AS total
     FROM volume_cover_salvage_event
     WHERE triggered_at >= $1 AND triggered_at < $2`,
    [sevenDayAgo.toISOString(), dayEnd.toISOString()]
  );
  const sevenDayLoss = Number(sevenDayLossResult.rows[0].total);
  const sevenDayPremiumResult = await params.pool.query(
    `SELECT COALESCE(SUM(daily_premium_usdc), 0) AS total
     FROM volume_cover_position
     WHERE opened_at >= $1 AND opened_at < $2`,
    [sevenDayAgo.toISOString(), dayEnd.toISOString()]
  );
  const sevenDayPremium = Number(sevenDayPremiumResult.rows[0].total);
  const atticusPnl7day = sevenDayPremium - sevenDayLoss;
  const atticusPnlToday = totalPremiumToday - todayLoss;

  // Active guardrails
  const totalActiveLiability = await sumActivePayoutLiability(params.pool);
  const guardrailsActive: FoxifyDailyReport["guardrailsActive"] = [];
  if (isCircuitBreakerActive()) {
    const cb = getCircuitBreakerState();
    guardrailsActive.push({
      name: "circuit_breaker",
      reason: cb.tripped ? cb.reason : "tripped",
      details: cb.tripped ? { lossPct: cb.lossPct } : undefined
    });
  }
  const halt = getManualHalt();
  if (halt.halted) {
    guardrailsActive.push({
      name: "manual_halt",
      reason: halt.reason ?? "operator_halt"
    });
  }
  // Probe with current metrics to surface active guards
  const guardCheck = checkAllGuardsForVolumeCoverActivate({
    foxifyPoolBalanceUsdc: 0,
    totalActivePayoutLiabilityUsdc: totalActiveLiability,
    newPayoutLiabilityUsdc: 0,
    dbTrackedAtticusBalanceUsdc: null,
    venueReportedAtticusBalanceUsdc: null,
    currentDvol: 0,
    lastDvolThresholdCrossingMs: null,
    bullishHealth: { recent5xxRate: 0, recentP95LatencyMs: 0, sampleCount: 0 },
    todayPremiumIncomeUsdc: 0,
    rollingAvgPremiumIncomeUsdc: 0,
    rolling7dayAtticusLossUsdc: sevenDayLoss,
    rolling5TriggerSalvagePct: rolling5.rolling5TriggerSalvagePct,
    rolling5TriggerSampleCount: rolling5.rolling5TriggerSampleCount,
    rolling24hTriggerCount: rolling5.rolling24hTriggerCount
  });
  if (!guardCheck.allowed && guardCheck.reason && guardCheck.reason !== "manual_halt") {
    guardrailsActive.push({
      name: guardCheck.reason,
      reason: guardCheck.message ?? guardCheck.reason,
      details: guardCheck.details
    });
  }
  if (guardCheck.salvageState === "throttle") {
    guardrailsActive.push({
      name: "salvage_rate_throttle",
      reason: `Salvage rate ${(rolling5.rolling5TriggerSalvagePct! * 100).toFixed(1)}% in throttle band; per-cell cap reduced`,
      details: { throttleOverridePerDay: guardCheck.throttleOverridePerDay }
    });
  }

  return {
    reportDate: params.reportDate,
    reportGeneratedAt: new Date().toISOString(),
    positionsOpenedToday,
    positionsActiveAtEod,
    positionsTriggeredToday,
    positionsClosedToday,
    totalPremiumBilledToFoxifyUsdc: Number(totalPremiumToday.toFixed(2)),
    totalPayoutsOwedToFoxifyUsdc: Number(totalPayoutsOwedToday.toFixed(2)),
    weeklySettlementDueIso: nextWeeklySettlementIso(dayEnd),
    monthlySettlementDueIso: nextMonthlySettlementIso(dayEnd),
    salvageStatsRolling5: {
      triggerCount: rolling5.rolling5TriggerSampleCount,
      avgSalvagePct: rolling5.rolling5TriggerSalvagePct,
      state: rolling5.state
    },
    atticusPnlTodayUsdc: Number(atticusPnlToday.toFixed(2)),
    atticusPnl7dayRollingUsdc: Number(atticusPnl7day.toFixed(2)),
    guardrailsActive,
    cellsStatus
  };
};

/**
 * Build a multi-day report by aggregating per-day reports.
 * For range queries from /admin/foxify-report/range.
 */
export const buildFoxifyRangeReport = async (params: {
  pool: Pool;
  fromDate: string; // YYYY-MM-DD inclusive
  toDate: string;   // YYYY-MM-DD inclusive
}): Promise<{
  fromDate: string;
  toDate: string;
  totals: {
    positionsOpened: number;
    positionsTriggered: number;
    totalPremiumUsdc: number;
    totalPayoutsUsdc: number;
    atticusPnlUsdc: number;
  };
  byDay: FoxifyDailyReport[];
}> => {
  const days: FoxifyDailyReport[] = [];
  const cur = new Date(params.fromDate + "T00:00:00Z");
  const end = new Date(params.toDate + "T00:00:00Z");
  while (cur <= end) {
    const iso = cur.toISOString().slice(0, 10);
    const day = await buildFoxifyDailyReport({ pool: params.pool, reportDate: iso });
    days.push(day);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  const totals = days.reduce(
    (acc, d) => ({
      positionsOpened: acc.positionsOpened + d.positionsOpenedToday,
      positionsTriggered: acc.positionsTriggered + d.positionsTriggeredToday,
      totalPremiumUsdc: acc.totalPremiumUsdc + d.totalPremiumBilledToFoxifyUsdc,
      totalPayoutsUsdc: acc.totalPayoutsUsdc + d.totalPayoutsOwedToFoxifyUsdc,
      atticusPnlUsdc: acc.atticusPnlUsdc + d.atticusPnlTodayUsdc
    }),
    { positionsOpened: 0, positionsTriggered: 0, totalPremiumUsdc: 0, totalPayoutsUsdc: 0, atticusPnlUsdc: 0 }
  );
  return {
    fromDate: params.fromDate,
    toDate: params.toDate,
    totals,
    byDay: days
  };
};
