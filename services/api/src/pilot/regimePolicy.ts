import type { HedgeSelectionRegime } from "./types";

export type RegimeInput = {
  triggerHitRatePct: number;
  subsidyUtilizationPct: number;
  treasuryDrawdownPct: number;
  iv30d: number | null;
  ivSkew: number | null;
};

export type RegimeDecision = {
  regime: HedgeSelectionRegime;
  stressScore: number;
  reasons: string[];
};

const normalize = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return 0;
  if (max <= min) return 0;
  const ratio = (value - min) / (max - min);
  return Math.max(0, Math.min(1, ratio));
};

export const resolveHedgeRegime = (input: RegimeInput): RegimeDecision => {
  const triggerScore = normalize(input.triggerHitRatePct, 2, 20);
  const subsidyScore = normalize(input.subsidyUtilizationPct, 10, 90);
  const drawdownScore = normalize(input.treasuryDrawdownPct, 5, 60);
  const ivScore = input.iv30d === null ? 0 : normalize(input.iv30d, 45, 110);
  const skewScore = input.ivSkew === null ? 0 : normalize(input.ivSkew, 2, 18);
  const stressScore = Number(
    (
      triggerScore * 0.34 +
      subsidyScore * 0.24 +
      drawdownScore * 0.18 +
      ivScore * 0.16 +
      skewScore * 0.08
    ).toFixed(6)
  );

  const reasons: string[] = [];
  if (input.triggerHitRatePct >= 12) reasons.push("trigger_rate_elevated");
  if (input.subsidyUtilizationPct >= 60) reasons.push("subsidy_utilization_elevated");
  if (input.treasuryDrawdownPct >= 35) reasons.push("treasury_drawdown_elevated");
  if (input.iv30d !== null && input.iv30d >= 80) reasons.push("iv_elevated");
  if (input.ivSkew !== null && input.ivSkew >= 10) reasons.push("skew_elevated");

  let regime: HedgeSelectionRegime = "calm";
  if (stressScore >= 0.66) {
    regime = "stress";
  } else if (stressScore >= 0.33) {
    regime = "neutral";
  }

  return { regime, stressScore, reasons };
};

