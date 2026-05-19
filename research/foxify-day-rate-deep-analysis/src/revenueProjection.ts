/**
 * 12-month net revenue projections for the locked Foxify per-day pricing.
 *
 * Per-trade economics are LOCKED from the historical backtest (in the
 * companion summary doc). The bear/base/bull scenarios distinguish
 * themselves on three dimensions:
 *
 *   1. User-growth trajectory (the dominant uncertainty)
 *   2. Engagement intensity (cohorts per user per month)
 *   3. Tier mix (which protection level users gravitate to)
 *
 * Per-cohort net to Atticus, per $10k of protected position
 * (computed: locked daily fee × avg days active × realized net margin):
 *
 *   2% tier: $16.00
 *   3% tier: $49.50
 *   5% tier: $111.15
 *  10% tier: $34.50
 *
 * Position size scales linearly: $50k position → 5× the $10k per-cohort net.
 */

const NET_PER_COHORT_PER_10K_BY_TIER: Record<string, number> = {
  "0.02": 16.00,
  "0.03": 49.50,
  "0.05": 111.15,
  "0.10": 34.50,
};

export type Scenario = {
  name: "Bear" | "Base" | "Bull";
  description: string;
  // User-count trajectory (interpolated month 1 → month 12)
  startingUsers: number;
  endingUsers: number;
  growthCurve: "linear" | "exponential";
  // Engagement: protection cohorts (i.e., new positions opened) per user per month
  cohortsPerUserStart: number;
  cohortsPerUserEnd: number;
  // Average protected position size (USD), weighted across $10k/$25k/$50k
  avgPositionSizeUsd: number;
  // Tier mix (weights sum to 1.0)
  tierMix: Record<string, number>;
};

export const SCENARIOS: Scenario[] = [
  {
    name: "Bear",
    description: "Slow ramp, conservative engagement. Users hold longer, open fewer positions, lean on cheaper tiers.",
    startingUsers: 10,
    endingUsers: 60,
    growthCurve: "linear",
    cohortsPerUserStart: 2.0,
    cohortsPerUserEnd: 3.0,
    avgPositionSizeUsd: 17_500,                       // skewed toward $10k bucket
    tierMix: { "0.02": 0.05, "0.03": 0.20, "0.05": 0.30, "0.10": 0.45 },  // 10% catastrophe-tier dominant (cheap)
  },
  {
    name: "Base",
    description: "Steady growth, normal active-trader engagement, balanced tier mix.",
    startingUsers: 25,
    endingUsers: 200,
    growthCurve: "linear",
    cohortsPerUserStart: 3.0,
    cohortsPerUserEnd: 4.0,
    avgPositionSizeUsd: 22_500,                       // balanced across buckets
    tierMix: { "0.02": 0.10, "0.03": 0.25, "0.05": 0.40, "0.10": 0.25 },  // 5% tier dominant (textbook DD protection)
  },
  {
    name: "Bull",
    description: "Strong product-market-fit, viral retail adoption, frequent traders favor the high-margin 5% tier.",
    startingUsers: 50,
    endingUsers: 600,
    growthCurve: "exponential",
    cohortsPerUserStart: 4.0,
    cohortsPerUserEnd: 6.0,
    avgPositionSizeUsd: 27_500,                       // skewed toward $25-50k buckets
    tierMix: { "0.02": 0.15, "0.03": 0.25, "0.05": 0.45, "0.10": 0.15 },  // active traders prefer 5% tier
  },
];

// ─── Projection math ─────────────────────────────────────────────────────────

function interpolate(start: number, end: number, monthIdx: number, totalMonths: number, curve: "linear" | "exponential"): number {
  const t = monthIdx / totalMonths;       // 0..1
  if (curve === "linear") return start + (end - start) * t;
  // Exponential: end = start × r^totalMonths → r = (end/start)^(1/totalMonths)
  const r = Math.pow(end / start, 1 / totalMonths);
  return start * Math.pow(r, monthIdx);
}

function tierWeightedNetPer10k(tierMix: Record<string, number>): number {
  let net = 0;
  for (const [tierKey, weight] of Object.entries(tierMix)) {
    const perTier = NET_PER_COHORT_PER_10K_BY_TIER[tierKey] ?? 0;
    net += perTier * weight;
  }
  return net;
}

export type MonthlyProjection = {
  month: number;
  activeUsers: number;
  cohortsThisMonth: number;
  monthlyNetRevenueUsd: number;
  cumulativeNetRevenueUsd: number;
  reservesRequiredUsd: number;     // running reserve based on current user count
  netCashPositionUsd: number;       // cumulative revenue - reserves required
};

const RESERVE_PER_USER_USD = 374;  // ~$37.4k at 100 users (from §4 of the deep analysis)

export function projectScenario(scenario: Scenario): MonthlyProjection[] {
  const out: MonthlyProjection[] = [];
  let cumulative = 0;
  const tierWeightedPer10k = tierWeightedNetPer10k(scenario.tierMix);
  const positionSizeMultiplier = scenario.avgPositionSizeUsd / 10_000;
  const netPerCohort = tierWeightedPer10k * positionSizeMultiplier;

  for (let month = 1; month <= 12; month++) {
    const activeUsers = interpolate(scenario.startingUsers, scenario.endingUsers, month, 12, scenario.growthCurve);
    const cohortsPerUser = interpolate(scenario.cohortsPerUserStart, scenario.cohortsPerUserEnd, month, 12, "linear");
    const cohortsThisMonth = activeUsers * cohortsPerUser;
    const monthlyNetRevenueUsd = cohortsThisMonth * netPerCohort;
    cumulative += monthlyNetRevenueUsd;
    const reservesRequiredUsd = activeUsers * RESERVE_PER_USER_USD;
    const netCashPositionUsd = cumulative - reservesRequiredUsd;
    out.push({
      month,
      activeUsers: Math.round(activeUsers),
      cohortsThisMonth: Math.round(cohortsThisMonth),
      monthlyNetRevenueUsd,
      cumulativeNetRevenueUsd: cumulative,
      reservesRequiredUsd,
      netCashPositionUsd,
    });
  }
  return out;
}
