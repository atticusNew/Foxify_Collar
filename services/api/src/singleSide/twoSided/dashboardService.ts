/**
 * Foxify-facing dashboard service layer (PR 8).
 *
 * Pure-ish functions producing the payloads documented in
 * TRIGGER_SOURCE_AND_FEED_SPEC.md §5 / §7 and the Foxify daily report
 * format from the handoff §9.
 *
 * Route plumbing (Fastify) is operator-side; this module returns shaped
 * data objects that a route can JSON-serialize directly.
 */

import type { Pool } from "pg";
import { getEventsForPair, getLegsForPair, getPairById } from "./db";
import { getPoolBalance, getPoolState } from "./deferredPool";
import { TIERS, type TierLabel } from "./types";

// ───────────────── GET /foxify-status ─────────────────

export type FoxifyStatus = {
  asOf: string;
  todayPairsActivated: number;
  todayPairsTriggered: number;
  todayPairsSettled: number;
  todayFoxifyPnlUsdc: number;
  rollingPnlUsdc: { p7d: number; p30d: number; ytd: number };
  currentTier: { label: TierLabel; atticusPct: number; foxifyPct: number; atticusFloorUsdc: number };
  rolling24hPairsCount: number;
  capitalPosition: {
    activeDeployedUsdc: number;
    deferredPoolBalanceUsdc: number;
    deferredPoolActive: boolean;
  };
  haltStatus: { foxifyHalt: boolean; atticusHalt: boolean; reason: string | null };
};

const startOfTodayUtcIso = (nowMs: number): string => {
  const d = new Date(nowMs);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
};

export const computeFoxifyStatus = async (
  pool: Pool,
  opts: {
    nowMs?: number;
    haltStatus?: { foxifyHalt: boolean; atticusHalt: boolean; reason: string | null };
    excludeShadowFromMetrics?: boolean;
  } = {}
): Promise<FoxifyStatus> => {
  const now = opts.nowMs ?? Date.now();
  const todayStart = startOfTodayUtcIso(now);
  const sinceShadow = opts.excludeShadowFromMetrics !== false; // default exclude shadow
  const shadowFilter = sinceShadow ? "AND is_shadow = FALSE" : "";

  const todayQ = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN created_at >= $1 THEN 1 ELSE 0 END), 0)::int AS activated,
       COALESCE(SUM(CASE WHEN triggered_at IS NOT NULL AND triggered_at >= $1 THEN 1 ELSE 0 END), 0)::int AS triggered,
       COALESCE(SUM(CASE WHEN closed_at >= $1 AND status = 'settled' THEN 1 ELSE 0 END), 0)::int AS settled,
       COALESCE(SUM(CASE WHEN status = 'settled' AND closed_at >= $1 THEN foxify_share_usdc - hedge_cost_total_usdc ELSE 0 END), 0) AS today_pnl
     FROM two_sided_pair
     WHERE 1=1 ${shadowFilter}`,
    [todayStart]
  );
  const today = todayQ.rows[0];

  const since7 = new Date(now - 7 * 86_400_000).toISOString();
  const since30 = new Date(now - 30 * 86_400_000).toISOString();
  const sinceYtd = new Date(new Date(now).getUTCFullYear(), 0, 1).toISOString();
  const rollingQ = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN closed_at >= $1 THEN foxify_share_usdc - hedge_cost_total_usdc ELSE 0 END), 0) AS p7,
       COALESCE(SUM(CASE WHEN closed_at >= $2 THEN foxify_share_usdc - hedge_cost_total_usdc ELSE 0 END), 0) AS p30,
       COALESCE(SUM(CASE WHEN closed_at >= $3 THEN foxify_share_usdc - hedge_cost_total_usdc ELSE 0 END), 0) AS pytd
     FROM two_sided_pair
     WHERE status = 'settled' ${shadowFilter}`,
    [since7, since30, sinceYtd]
  );
  const rolling = rollingQ.rows[0];

  const since24h = new Date(now - 24 * 3_600_000).toISOString();
  const tierQ = await pool.query(
    `SELECT COUNT(*)::int AS n FROM two_sided_pair WHERE created_at >= $1 AND status <> 'cancelled' ${shadowFilter}`,
    [since24h]
  );
  const rolling24hCount = tierQ.rows[0]?.n ?? 0;
  // Look up tier for this volume — without importing tierResolver to keep this module self-contained
  let currentTier = TIERS[0];
  for (let i = 0; i < TIERS.length; i++) {
    const upper = TIERS[i].maxPairsPerDay ?? Infinity;
    if (rolling24hCount >= TIERS[i].minPairsPerDay && rolling24hCount < upper) {
      currentTier = TIERS[i];
      break;
    }
  }

  const activeCapitalQ = await pool.query(
    `SELECT COALESCE(SUM(foxify_capital_funded_usdc), 0) AS deployed
     FROM two_sided_pair
     WHERE status IN ('active', 'triggered', 'unwinding') ${shadowFilter}`
  );
  const activeDeployed = Number(activeCapitalQ.rows[0]?.deployed ?? 0);
  const poolBalance = await getPoolBalance(pool).catch(() => ({ unsettledUsdc: 0, entryCount: 0 }));
  const poolState = await getPoolState(pool).catch(() => ({ active: false, activatedAt: null, deactivatedAt: null, notes: "" }));

  return {
    asOf: new Date(now).toISOString(),
    todayPairsActivated: today.activated,
    todayPairsTriggered: today.triggered,
    todayPairsSettled: today.settled,
    todayFoxifyPnlUsdc: Number(today.today_pnl),
    rollingPnlUsdc: {
      p7d: Number(rolling.p7),
      p30d: Number(rolling.p30),
      ytd: Number(rolling.pytd)
    },
    currentTier: {
      label: currentTier.label,
      atticusPct: currentTier.atticusPct,
      foxifyPct: currentTier.foxifyPct,
      atticusFloorUsdc: currentTier.atticusFloorUsdc
    },
    rolling24hPairsCount: rolling24hCount,
    capitalPosition: {
      activeDeployedUsdc: activeDeployed,
      deferredPoolBalanceUsdc: poolBalance.unsettledUsdc,
      deferredPoolActive: poolState.active
    },
    haltStatus: opts.haltStatus ?? { foxifyHalt: false, atticusHalt: false, reason: null }
  };
};

// ───────────────── GET /pairs/:pair_id ─────────────────

export const getPairDetail = async (pool: Pool, pairId: string) => {
  const pair = await getPairById(pool, pairId);
  if (!pair) return null;
  const legs = await getLegsForPair(pool, pairId);
  return { pair, legs };
};

// ───────────────── GET /pairs/:pair_id/events ─────────────────

export const getPairEventTimeline = async (pool: Pool, pairId: string) => {
  const pair = await getPairById(pool, pairId);
  if (!pair) return null;
  const events = await getEventsForPair(pool, pairId);
  return { pair, events };
};

// ───────────────── GET /pairs/:pair_id/explain ─────────────────

export type LossExplanation = {
  pairId: string;
  outcome: "win" | "loss" | "breakeven" | "not_settled";
  hedgeCostUsdc: number;
  salvageProceedsUsdc: number | null;
  upliftUsdc: number | null;
  foxifyShareUsdc: number | null;
  foxifyNetUsdc: number | null;
  why: string;
  pathStats: {
    spotAtActivation: number;
    triggerDownPrice: number;
    triggerUpPrice: number;
    triggered: boolean;
    triggerSide: "down" | "up" | null;
    exitMode: string | null;
  };
};

export const explainPairOutcome = async (pool: Pool, pairId: string): Promise<LossExplanation | null> => {
  const pair = await getPairById(pool, pairId);
  if (!pair) return null;

  let outcome: LossExplanation["outcome"];
  let why: string;
  if (pair.status !== "settled") {
    outcome = "not_settled";
    why = `Pair is still ${pair.status}; outcome not yet known.`;
  } else if (pair.upliftUsdc != null && pair.upliftUsdc > 0) {
    outcome = "win";
    why = pair.triggerSide
      ? `Trigger fired on ${pair.triggerSide} side. ${pair.exitMode ?? "exit"} captured \$${pair.upliftUsdc.toFixed(0)} uplift.`
      : `No trigger but option time-value preserved enough to exceed hedge cost (+\$${pair.upliftUsdc.toFixed(0)}).`;
  } else if (pair.upliftUsdc != null && pair.upliftUsdc < 0) {
    outcome = "loss";
    why = pair.triggerSide
      ? `Trigger fired on ${pair.triggerSide} side but salvage at exit was below hedge cost (-\$${Math.abs(pair.upliftUsdc).toFixed(0)}). Likely shallow trigger or unfavorable subsequent move.`
      : `Pair did not trigger within ${pair.hedgeTenorDays}-day tenor. Theta decay reduced option value below hedge cost (-\$${Math.abs(pair.upliftUsdc).toFixed(0)}). This is in the loss tail (~5-10% of calm-regime paths per MC).`;
  } else {
    outcome = "breakeven";
    why = "Salvage proceeds exactly equaled hedge cost. Atticus collected no share; Foxify recovered capital fully.";
  }

  return {
    pairId,
    outcome,
    hedgeCostUsdc: pair.hedgeCostTotalUsdc,
    salvageProceedsUsdc: pair.salvageProceedsUsdc,
    upliftUsdc: pair.upliftUsdc,
    foxifyShareUsdc: pair.foxifyShareUsdc,
    foxifyNetUsdc: pair.foxifyShareUsdc != null ? pair.foxifyShareUsdc - pair.hedgeCostTotalUsdc : null,
    why,
    pathStats: {
      spotAtActivation: pair.spotAtActivation,
      triggerDownPrice: pair.triggerDownPrice,
      triggerUpPrice: pair.triggerUpPrice,
      triggered: pair.triggerSide != null,
      triggerSide: pair.triggerSide,
      exitMode: pair.exitMode
    }
  };
};

// ───────────────── Per-cell metrics (PR C9) ─────────────────

export type CellMetrics = {
  cellId: string;
  pairsActivated: number;
  pairsSettled: number;
  pairsTriggered: number;
  meanFoxifyEvUsdc: number;
  totalFoxifyEvUsdc: number;
  meanSalvageRatio: number;
  triggerRate: number;
};

export const getCellMetrics = async (
  pool: Pool,
  cellId: string,
  opts: { sinceIso?: string; untilIso?: string } = {}
): Promise<CellMetrics> => {
  const since = opts.sinceIso ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
  const until = opts.untilIso ?? new Date().toISOString();
  const r = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN created_at BETWEEN $2 AND $3 AND status <> 'cancelled' THEN 1 ELSE 0 END), 0)::int AS activated,
       COALESCE(SUM(CASE WHEN status = 'settled' AND closed_at BETWEEN $2 AND $3 THEN 1 ELSE 0 END), 0)::int AS settled,
       COALESCE(SUM(CASE WHEN triggered_at IS NOT NULL AND triggered_at BETWEEN $2 AND $3 THEN 1 ELSE 0 END), 0)::int AS triggered,
       COALESCE(SUM(CASE WHEN status = 'settled' AND closed_at BETWEEN $2 AND $3 THEN foxify_share_usdc - hedge_cost_total_usdc ELSE 0 END), 0) AS total_foxify_ev,
       COALESCE(AVG(CASE WHEN status = 'settled' AND closed_at BETWEEN $2 AND $3 THEN foxify_share_usdc - hedge_cost_total_usdc END), 0) AS mean_foxify_ev,
       COALESCE(AVG(CASE WHEN status = 'settled' AND closed_at BETWEEN $2 AND $3 AND hedge_cost_total_usdc > 0 THEN salvage_proceeds_usdc / hedge_cost_total_usdc END), 0) AS mean_salvage_ratio
     FROM two_sided_pair
     WHERE cell_id = $1 AND is_shadow = FALSE`,
    [cellId, since, until]
  );
  const row = r.rows[0];
  const activated = Number(row.activated);
  const triggered = Number(row.triggered);
  return {
    cellId,
    pairsActivated: activated,
    pairsSettled: Number(row.settled),
    pairsTriggered: triggered,
    meanFoxifyEvUsdc: Number(row.mean_foxify_ev),
    totalFoxifyEvUsdc: Number(row.total_foxify_ev),
    meanSalvageRatio: Number(row.mean_salvage_ratio),
    triggerRate: activated > 0 ? triggered / activated : 0
  };
};

export const getAllActiveCellMetrics = async (pool: Pool, opts: { sinceIso?: string; untilIso?: string } = {}): Promise<CellMetrics[]> => {
  const since = opts.sinceIso ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
  const r = await pool.query(
    `SELECT DISTINCT cell_id FROM two_sided_pair WHERE is_shadow = FALSE AND created_at >= $1`,
    [since]
  );
  const cells = r.rows.map((row) => row.cell_id);
  return Promise.all(cells.map((c) => getCellMetrics(pool, c, opts)));
};

// ───────────────── Daily report (00:30 UTC cron output) ─────────────────

export const generateDailyReport = async (pool: Pool, opts: { nowMs?: number } = {}): Promise<string> => {
  const now = opts.nowMs ?? Date.now();
  const status = await computeFoxifyStatus(pool, { nowMs: now });
  const dateStr = new Date(now).toISOString().slice(0, 10);

  const lines: string[] = [];
  lines.push(`=== Foxify Volume Facility — Daily Summary ${dateStr} ===`);
  lines.push("");
  lines.push(`Activity today:`);
  lines.push(`  Pairs activated:      ${status.todayPairsActivated}`);
  lines.push(`  Pairs triggered:      ${status.todayPairsTriggered}`);
  lines.push(`  Pairs settled:        ${status.todayPairsSettled}`);
  lines.push("");
  lines.push(`Economics today:`);
  lines.push(`  Foxify net P&L:       ${fmt$(status.todayFoxifyPnlUsdc, true)}`);
  lines.push("");
  lines.push(`Rolling totals:`);
  lines.push(`  7-day:                ${fmt$(status.rollingPnlUsdc.p7d, true)}`);
  lines.push(`  30-day:               ${fmt$(status.rollingPnlUsdc.p30d, true)}`);
  lines.push(`  YTD:                  ${fmt$(status.rollingPnlUsdc.ytd, true)}`);
  lines.push("");
  lines.push(`Tier: ${status.currentTier.label} (Atticus ${(status.currentTier.atticusPct * 100).toFixed(0)}% / Foxify ${(status.currentTier.foxifyPct * 100).toFixed(0)}%, floor \$${status.currentTier.atticusFloorUsdc})`);
  lines.push(`24h rolling pairs:    ${status.rolling24hPairsCount}`);
  lines.push("");
  lines.push(`Capital:`);
  lines.push(`  Active deployed:      ${fmt$(status.capitalPosition.activeDeployedUsdc, false)}`);
  lines.push(`  Deferred pool active: ${status.capitalPosition.deferredPoolActive ? "YES" : "no"}`);
  lines.push(`  Deferred pool bal:    ${fmt$(status.capitalPosition.deferredPoolBalanceUsdc, false)}`);
  lines.push("");
  lines.push(`Halts: foxify=${status.haltStatus.foxifyHalt ? "ACTIVE" : "off"} atticus=${status.haltStatus.atticusHalt ? "ACTIVE" : "off"}${status.haltStatus.reason ? ` (${status.haltStatus.reason})` : ""}`);

  // PR C9: per-cell rolling-7d breakdown
  const cellMetrics = await getAllActiveCellMetrics(pool, { sinceIso: new Date(now - 7 * 86_400_000).toISOString() });
  if (cellMetrics.length > 0) {
    lines.push("");
    lines.push(`Per-cell breakdown (rolling 7d):`);
    for (const m of cellMetrics) {
      lines.push(`  ${m.cellId}: ${m.pairsActivated} activated, ${m.pairsTriggered} triggered (${(m.triggerRate * 100).toFixed(0)}%), mean Foxify EV ${fmt$(m.meanFoxifyEvUsdc, true)}, total ${fmt$(m.totalFoxifyEvUsdc, true)}`);
    }
  }

  return lines.join("\n");
};

const fmt$ = (n: number, signed = false): string => {
  const sign = signed ? (n >= 0 ? "+" : "-") : "";
  return `${sign}\$${Math.abs(Math.round(n)).toLocaleString()}`;
};
