import type { HedgeCandidate } from "./types";

const roundTo = (value: number, digits = 8): number => {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export const buildStrikeLadderCandidates = (params: {
  baseStrike: number;
  right: "P" | "C";
  step: number;
  itmSteps: number;
  otmSteps: number;
}): number[] => {
  const step = Math.max(1, Math.floor(params.step));
  const itm = Math.max(0, Math.floor(params.itmSteps));
  const otm = Math.max(0, Math.floor(params.otmSteps));
  const ladder: number[] = [Math.max(1000, Math.floor(params.baseStrike))];
  const seen = new Set<number>(ladder);
  const push = (strike: number): void => {
    const normalized = Math.max(1000, Math.floor(strike));
    if (seen.has(normalized)) return;
    seen.add(normalized);
    ladder.push(normalized);
  };
  for (let i = 1; i <= Math.max(itm, otm); i += 1) {
    if (params.right === "P") {
      if (i <= itm) push(params.baseStrike + i * step);
      if (i <= otm) push(params.baseStrike - i * step);
    } else {
      if (i <= itm) push(params.baseStrike - i * step);
      if (i <= otm) push(params.baseStrike + i * step);
    }
  }
  return ladder;
};

export const toHedgeCandidate = (params: {
  candidateId: string;
  hedgeMode: HedgeCandidate["hedgeMode"];
  hedgeInstrumentFamily: HedgeCandidate["hedgeInstrumentFamily"];
  strike: number | null;
  triggerPrice: number | null;
  tenorDays: number | null;
  tenorDriftDays: number | null;
  belowTargetTenor: boolean;
  ask: number;
  bid: number | null;
  askSize: number | null;
  spreadPct: number | null;
  premiumUsd: number;
  premiumRatio: number;
  expectedTriggerCostUsd: number;
  expectedTriggerCreditUsd: number;
  premiumProfitabilityTargetUsd: number;
  expectedSubsidyUsd: number;
  liquidityPenalty: number;
  carryPenalty: number;
  basisPenalty: number;
  fillRiskPenalty: number;
  tailProtectionScore: number;
}): HedgeCandidate => {
  const strikeGapToTriggerPct =
    params.strike !== null && params.triggerPrice !== null && params.triggerPrice > 0
      ? roundTo((params.strike - params.triggerPrice) / params.triggerPrice, 8)
      : null;
  return {
    candidateId: params.candidateId,
    hedgeMode: params.hedgeMode,
    hedgeInstrumentFamily: params.hedgeInstrumentFamily,
    strike: params.strike,
    triggerPrice: params.triggerPrice,
    strikeGapToTriggerPct,
    tenorDays: params.tenorDays,
    tenorDriftDays: params.tenorDriftDays,
    belowTargetTenor: params.belowTargetTenor,
    ask: params.ask,
    bid: params.bid,
    askSize: params.askSize,
    spreadPct: params.spreadPct,
    premiumUsd: params.premiumUsd,
    premiumRatio: params.premiumRatio,
    expectedTriggerCostUsd: params.expectedTriggerCostUsd,
    expectedTriggerCreditUsd: params.expectedTriggerCreditUsd,
    premiumProfitabilityTargetUsd: params.premiumProfitabilityTargetUsd,
    expectedSubsidyUsd: params.expectedSubsidyUsd,
    liquidityPenalty: params.liquidityPenalty,
    carryPenalty: params.carryPenalty,
    basisPenalty: params.basisPenalty,
    fillRiskPenalty: params.fillRiskPenalty,
    tailProtectionScore: params.tailProtectionScore
  };
};
