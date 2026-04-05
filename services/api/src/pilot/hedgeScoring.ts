import type {
  HedgeCandidate,
  HedgeOptimizerConfig,
  HedgeScoreBreakdown,
  HedgeSelectionDecision,
  HedgeSelectionRegime
} from "./types";

const clamp01 = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
};

const normalizeInRange = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return 1;
  const span = Math.max(1e-9, max - min);
  return clamp01((value - min) / span);
};

const invertReward = (normalizedReward: number): number => clamp01(1 - normalizedReward);

type CandidateFeatureVector = {
  expectedSubsidy: number;
  cvar95Proxy: number;
  liquidityPenalty: number;
  fillRiskPenalty: number;
  basisPenalty: number;
  carryPenalty: number;
  pnlReward: number;
  mtpdReward: number;
  tenorDriftPenalty: number;
  strikeDistancePenalty: number;
};

const toFeatureVector = (candidate: HedgeCandidate, config: HedgeOptimizerConfig): CandidateFeatureVector => {
  const ranges = config.normalization;
  const strikeDistancePct = candidate.strikeGapToTriggerPct === null ? 1 : Math.abs(candidate.strikeGapToTriggerPct);
  const riskAdjustedPremiumUsd = Math.max(candidate.premiumUsd, candidate.expectedTriggerCostUsd);
  const pnlRewardUsd = Math.max(0, candidate.expectedTriggerCreditUsd - riskAdjustedPremiumUsd);
  return {
    expectedSubsidy: normalizeInRange(
      candidate.expectedSubsidyUsd,
      ranges.expectedSubsidyUsd.min,
      ranges.expectedSubsidyUsd.max
    ),
    cvar95Proxy: normalizeInRange(candidate.expectedTriggerCostUsd, ranges.cvar95Usd.min, ranges.cvar95Usd.max),
    liquidityPenalty: normalizeInRange(
      candidate.liquidityPenalty,
      ranges.liquidityPenalty.min,
      ranges.liquidityPenalty.max
    ),
    fillRiskPenalty: normalizeInRange(candidate.fillRiskPenalty, ranges.fillRiskPenalty.min, ranges.fillRiskPenalty.max),
    basisPenalty: normalizeInRange(candidate.basisPenalty, ranges.basisPenalty.min, ranges.basisPenalty.max),
    carryPenalty: normalizeInRange(candidate.carryPenalty, ranges.carryPenalty.min, ranges.carryPenalty.max),
    pnlReward: invertReward(normalizeInRange(pnlRewardUsd, ranges.pnlRewardUsd.min, ranges.pnlRewardUsd.max)),
    mtpdReward: invertReward(normalizeInRange(candidate.tailProtectionScore, ranges.mtpdReward.min, ranges.mtpdReward.max)),
    tenorDriftPenalty: normalizeInRange(candidate.tenorDriftDays ?? 999, ranges.tenorDriftDays.min, ranges.tenorDriftDays.max),
    strikeDistancePenalty: normalizeInRange(
      strikeDistancePct,
      ranges.strikeDistancePct.min,
      ranges.strikeDistancePct.max
    )
  };
};

const weightedScore = (features: CandidateFeatureVector, config: HedgeOptimizerConfig): HedgeScoreBreakdown => {
  const w = config.weights;
  const weighted = {
    expectedSubsidy: features.expectedSubsidy * w.expectedSubsidy,
    cvar95Proxy: features.cvar95Proxy * w.cvar95,
    liquidityPenalty: features.liquidityPenalty * w.liquidityPenalty,
    fillRiskPenalty: features.fillRiskPenalty * w.fillRiskPenalty,
    basisPenalty: features.basisPenalty * w.basisPenalty,
    carryPenalty: features.carryPenalty * w.carryPenalty,
    pnlReward: features.pnlReward * w.pnlReward,
    mtpdReward: features.mtpdReward * w.mtpdReward,
    tenorDriftPenalty: features.tenorDriftPenalty * w.tenorDriftPenalty,
    strikeDistancePenalty: features.strikeDistancePenalty * w.strikeDistancePenalty
  };
  const totalScore =
    weighted.expectedSubsidy +
    weighted.cvar95Proxy +
    weighted.liquidityPenalty +
    weighted.fillRiskPenalty +
    weighted.basisPenalty +
    weighted.carryPenalty +
    weighted.pnlReward +
    weighted.mtpdReward +
    weighted.tenorDriftPenalty +
    weighted.strikeDistancePenalty;
  return {
    totalScore,
    normalized: features,
    weighted
  };
};

const passesHardConstraints = (candidate: HedgeCandidate, config: HedgeOptimizerConfig): boolean => {
  const c = config.hardConstraints;
  const strikeDistancePct = candidate.strikeGapToTriggerPct === null ? Number.POSITIVE_INFINITY : Math.abs(candidate.strikeGapToTriggerPct);
  if (candidate.premiumRatio > c.maxPremiumRatio + 1e-9) return false;
  if ((candidate.spreadPct ?? Number.POSITIVE_INFINITY) > c.maxSpreadPct + 1e-9) return false;
  if ((candidate.askSize ?? 0) + 1e-9 < c.minAskSize) return false;
  if ((candidate.tenorDriftDays ?? Number.POSITIVE_INFINITY) > c.maxTenorDriftDays + 1e-9) return false;
  if (candidate.tailProtectionScore + 1e-9 < c.minTailProtectionScore) return false;
  if (candidate.expectedSubsidyUsd > c.maxExpectedSubsidyUsd + 1e-9) return false;
  if (!Number.isFinite(strikeDistancePct)) return false;
  return true;
};

export const selectBestHedgeCandidate = (params: {
  candidates: HedgeCandidate[];
  config: HedgeOptimizerConfig;
  regime: HedgeSelectionRegime;
}): HedgeSelectionDecision | null => {
  const eligible = params.candidates.filter((candidate) => passesHardConstraints(candidate, params.config));
  if (!eligible.length) return null;
  const scored = eligible.map((candidate) => ({
    candidate,
    score: weightedScore(toFeatureVector(candidate, params.config), params.config)
  }));
  scored.sort((a, b) => a.score.totalScore - b.score.totalScore);
  const best = scored[0];
  const reason = `${params.regime}_optimizer_min_score`;
  return {
    selectedCandidateId: best.candidate.candidateId,
    regime: params.regime,
    reason,
    score: best.score,
    topAlternatives: scored.slice(0, 3).map((item) => ({
      candidateId: item.candidate.candidateId,
      score: Number(item.score.totalScore.toFixed(8)),
      hedgeMode: item.candidate.hedgeMode,
      strike: item.candidate.strike,
      tenorDays: item.candidate.tenorDays
    }))
  };
};
