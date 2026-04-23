/**
 * Cumulative hedge-budget cap enforcement (Foxify Pilot Agreement v2 §3.1).
 *
 * The agreement specifies that Atticus's real-money hedge spend during
 * the pilot is capped on a cumulative basis to ensure responsible
 * scale-up:
 *
 *   Day 1-2:   $100 USD cumulative
 *   Day 3-7:   $1,000 USD cumulative
 *   Day 8-21:  $10,000 USD cumulative
 *   Day 22-28: No additional cap (within position limits)
 *
 * "Day" is measured from the pilot start date (PILOT_LIVE_START_DATE
 * env var, ISO format), counted in 24-hour blocks. If no env var is
 * set we fall back to the earliest live BUY execution timestamp in
 * the database (auto-detected pilot start).
 *
 * This module is pure policy — no DB calls, no I/O. The activate path
 * supplies the current cumulative hedge spend (queried separately) and
 * we return the verdict.
 */

export type HedgeBudgetCapVerdict = {
  allowed: boolean;
  pilotDay: number; // 1-indexed; day 1 = first 24h
  capUsd: number | null; // null = no cap (Day 22+)
  cumulativeSpentUsd: number;
  remainingUsd: number | null; // null = no cap
  projectedAfterUsd: number;
  reason?: "would_exceed_cap";
  message?: string;
};

export type HedgeBudgetCapConfig = {
  /** ISO timestamp string. If null/missing, caller should auto-detect from earliest live execution. */
  pilotStartIso: string | null;
  /** Optional override — if set, completely bypasses cap enforcement. Default false. */
  enforce: boolean;
  /** Override schedule for tests / future ramps. Default = the v2 agreement schedule. */
  schedule: Array<{ throughDay: number; capUsd: number | null }>;
};

const DEFAULT_SCHEDULE: HedgeBudgetCapConfig["schedule"] = [
  { throughDay: 2, capUsd: 100 },
  { throughDay: 7, capUsd: 1000 },
  { throughDay: 21, capUsd: 10000 },
  { throughDay: Number.POSITIVE_INFINITY, capUsd: null }
];

let configured: HedgeBudgetCapConfig = {
  pilotStartIso: process.env.PILOT_LIVE_START_DATE || null,
  enforce: String(process.env.PILOT_HEDGE_BUDGET_CAP_ENABLED || "true").toLowerCase() === "true",
  schedule: DEFAULT_SCHEDULE
};

export const configureHedgeBudgetCap = (params: Partial<HedgeBudgetCapConfig>): void => {
  configured = {
    pilotStartIso: params.pilotStartIso ?? configured.pilotStartIso,
    enforce: params.enforce ?? configured.enforce,
    schedule: params.schedule ?? configured.schedule
  };
};

export const getHedgeBudgetCapConfig = (): HedgeBudgetCapConfig => ({ ...configured });

/**
 * Compute the pilot day (1-indexed) given a current timestamp and the
 * pilot start. Day 1 = first 24h after start. If start is in the
 * future or null, returns 1.
 */
export const computePilotDay = (
  pilotStartMsEpoch: number | null,
  nowMsEpoch: number = Date.now()
): number => {
  if (pilotStartMsEpoch === null || nowMsEpoch < pilotStartMsEpoch) return 1;
  const elapsedMs = nowMsEpoch - pilotStartMsEpoch;
  const elapsedDays = elapsedMs / (24 * 3600 * 1000);
  // Day 1 covers 0 to <1 day elapsed; day 2 covers 1 to <2; etc.
  return Math.floor(elapsedDays) + 1;
};

/**
 * Look up the cap that applies to a given pilot day.
 */
export const getCapForDay = (
  day: number,
  schedule: HedgeBudgetCapConfig["schedule"] = configured.schedule
): number | null => {
  for (const tier of schedule) {
    if (day <= tier.throughDay) return tier.capUsd;
  }
  return null;
};

/**
 * Decide whether a new hedge spend is allowed given current cumulative
 * spend, pilot day, and configured cap. Pure function — no I/O.
 *
 * If enforce=false, always returns allowed:true regardless of spend
 * (still populates the diagnostic fields so observability is intact).
 */
export const evaluateHedgeBudgetCap = (params: {
  pilotStartMsEpoch: number | null;
  cumulativeSpentUsd: number;
  prospectiveHedgeCostUsd: number;
  nowMsEpoch?: number;
}): HedgeBudgetCapVerdict => {
  const now = params.nowMsEpoch ?? Date.now();
  const pilotDay = computePilotDay(params.pilotStartMsEpoch, now);
  const capUsd = getCapForDay(pilotDay);
  const projectedAfter = params.cumulativeSpentUsd + params.prospectiveHedgeCostUsd;
  const remaining = capUsd === null ? null : Math.max(0, capUsd - params.cumulativeSpentUsd);

  // Bypass if not enforcing
  if (!configured.enforce) {
    return {
      allowed: true,
      pilotDay,
      capUsd,
      cumulativeSpentUsd: params.cumulativeSpentUsd,
      remainingUsd: remaining,
      projectedAfterUsd: projectedAfter
    };
  }

  // No cap on the current day
  if (capUsd === null) {
    return {
      allowed: true,
      pilotDay,
      capUsd: null,
      cumulativeSpentUsd: params.cumulativeSpentUsd,
      remainingUsd: null,
      projectedAfterUsd: projectedAfter
    };
  }

  if (projectedAfter > capUsd) {
    return {
      allowed: false,
      pilotDay,
      capUsd,
      cumulativeSpentUsd: params.cumulativeSpentUsd,
      remainingUsd: remaining,
      projectedAfterUsd: projectedAfter,
      reason: "would_exceed_cap",
      message:
        `Hedge budget cap reached for pilot Day ${pilotDay}: ` +
        `$${params.cumulativeSpentUsd.toFixed(2)} of $${capUsd.toFixed(2)} spent. ` +
        `This trade would push spend to $${projectedAfter.toFixed(2)}. ` +
        `Try a smaller position, a wider SL tier (lower hedge cost), or wait for the next pilot phase.`
    };
  }

  return {
    allowed: true,
    pilotDay,
    capUsd,
    cumulativeSpentUsd: params.cumulativeSpentUsd,
    remainingUsd: remaining,
    projectedAfterUsd: projectedAfter
  };
};
