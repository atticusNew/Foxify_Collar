import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Decimal from "decimal.js";

type ProjectionRow = {
  bandLabel: string;
  bronzePremiumPer1kUsd: string;
  requiredIssuanceScaleMid: string;
  projectedRolling12mLossRatioPct: string;
  projectedRolling12mUnderwritingMarginPct: string;
  projectedRolling12mSubsidyCoveragePct: string;
  projectedTreasuryCoverageRatio: string;
  projectedWorstStressQuarterSubsidyNeedUsd: string;
  projectedRolling12mUnderwritingPnlUsd: string;
  projectedRolling12mSubsidyNeedUsd: string;
};

type BandTargetsJson = {
  projectionRows: ProjectionRow[];
};

type GateConfig = {
  coverMin: Decimal;
  lossMax: Decimal;
  marginMin: Decimal;
  treasuryCoverageMin: Decimal;
  issuanceScaleMax: Decimal;
};

type Args = {
  inputJsonPath: string;
  pilotBandLabel: string;
  productionBandLabel: string;
  pilot: GateConfig;
  production: GateConfig;
  outJsonPath: string | null;
};

type GateEvaluation = {
  cover: boolean;
  loss: boolean;
  margin: boolean;
  treasuryCoverage: boolean;
  issuanceScale: boolean;
  all: boolean;
};

const toDecimal = (value: string | number | null | undefined): Decimal => {
  try {
    return new Decimal(String(value ?? "0"));
  } catch {
    return new Decimal(0);
  }
};

const toFixed = (value: Decimal, dp = 6): string => value.toFixed(dp);

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    inputJsonPath: "artifacts/desktop/premium_sweep_coinbase_tp_off_wide/premium_sweep_band_targets.json",
    pilotBandLabel: "severe_400_500",
    productionBandLabel: "severe_250_300",
    pilot: {
      coverMin: new Decimal(95),
      lossMax: new Decimal(200),
      marginMin: new Decimal(-100),
      treasuryCoverageMin: new Decimal("1.1"),
      issuanceScaleMax: new Decimal(220)
    },
    production: {
      coverMin: new Decimal(98),
      lossMax: new Decimal(190),
      marginMin: new Decimal(-90),
      treasuryCoverageMin: new Decimal("1.2"),
      issuanceScaleMax: new Decimal(200)
    },
    outJsonPath: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--input-json" && argv[i + 1]) {
      args.inputJsonPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--band" && argv[i + 1]) {
      args.pilotBandLabel = argv[i + 1];
      args.productionBandLabel = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--pilot-band" && argv[i + 1]) {
      args.pilotBandLabel = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--production-band" && argv[i + 1]) {
      args.productionBandLabel = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--out-json" && argv[i + 1]) {
      args.outJsonPath = argv[i + 1];
      i += 1;
      continue;
    }

    const parseGate = (target: GateConfig, field: keyof GateConfig) => {
      if (!argv[i + 1]) throw new Error(`missing_value:${token}`);
      target[field] = toDecimal(argv[i + 1]);
      i += 1;
    };

    if (token === "--pilot-cover-min" || token === "--pilot-cover-min-pct") parseGate(args.pilot, "coverMin");
    else if (token === "--pilot-loss-max" || token === "--pilot-loss-max-pct") parseGate(args.pilot, "lossMax");
    else if (token === "--pilot-margin-min" || token === "--pilot-margin-min-pct") parseGate(args.pilot, "marginMin");
    else if (token === "--pilot-treasury-coverage-min") parseGate(args.pilot, "treasuryCoverageMin");
    else if (token === "--pilot-issuance-scale-max") parseGate(args.pilot, "issuanceScaleMax");
    else if (token === "--production-cover-min" || token === "--production-cover-min-pct" || token === "--prod-cover-min")
      parseGate(args.production, "coverMin");
    else if (token === "--production-loss-max" || token === "--production-loss-max-pct" || token === "--prod-loss-max")
      parseGate(args.production, "lossMax");
    else if (token === "--production-margin-min" || token === "--production-margin-min-pct" || token === "--prod-margin-min")
      parseGate(args.production, "marginMin");
    else if (token === "--production-treasury-coverage-min" || token === "--prod-treasury-coverage-min")
      parseGate(args.production, "treasuryCoverageMin");
    else if (token === "--production-issuance-scale-max" || token === "--prod-issuance-scale-max")
      parseGate(args.production, "issuanceScaleMax");
  }

  return args;
};

const evaluate = (row: ProjectionRow, cfg: GateConfig): GateEvaluation => {
  const cover = toDecimal(row.projectedRolling12mSubsidyCoveragePct).gte(cfg.coverMin);
  const loss = toDecimal(row.projectedRolling12mLossRatioPct).lte(cfg.lossMax);
  const margin = toDecimal(row.projectedRolling12mUnderwritingMarginPct).gte(cfg.marginMin);
  const treasuryCoverage = toDecimal(row.projectedTreasuryCoverageRatio).gte(cfg.treasuryCoverageMin);
  const issuanceScale = toDecimal(row.requiredIssuanceScaleMid).lte(cfg.issuanceScaleMax);
  const all = cover && loss && margin && treasuryCoverage && issuanceScale;
  return { cover, loss, margin, treasuryCoverage, issuanceScale, all };
};

const ensureParentDir = async (targetPath: string) => {
  await mkdir(path.dirname(targetPath), { recursive: true });
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const raw = await readFile(args.inputJsonPath, "utf8");
  const parsed = JSON.parse(raw) as BandTargetsJson;
  const rowsForBand = (bandLabel: string) =>
    (parsed.projectionRows || [])
      .filter((row) => String(row.bandLabel || "") === bandLabel)
      .sort((a, b) => toDecimal(a.bronzePremiumPer1kUsd).minus(toDecimal(b.bronzePremiumPer1kUsd)).toNumber());

  const pilotRows = rowsForBand(args.pilotBandLabel);
  const prodRows = rowsForBand(args.productionBandLabel);

  if (!pilotRows.length) {
    throw new Error(`pilot_band_not_found:${args.pilotBandLabel}`);
  }
  if (!prodRows.length) {
    throw new Error(`production_band_not_found:${args.productionBandLabel}`);
  }

  const pilotMatch = pilotRows.find((row) => evaluate(row, args.pilot).all) || null;
  const prodMatch = prodRows.find((row) => evaluate(row, args.production).all) || null;

  const pilotInspect = pilotMatch || pilotRows[pilotRows.length - 1];
  const prodInspect = prodMatch || prodRows[prodRows.length - 1];

  const out = {
    status: "ok",
    inputJsonPath: args.inputJsonPath,
    bands: {
      pilot: args.pilotBandLabel,
      production: args.productionBandLabel
    },
    gateConfig: {
      pilot: {
        coverMinPct: toFixed(args.pilot.coverMin, 4),
        lossMaxPct: toFixed(args.pilot.lossMax, 4),
        marginMinPct: toFixed(args.pilot.marginMin, 4),
        treasuryCoverageMin: toFixed(args.pilot.treasuryCoverageMin, 4),
        issuanceScaleMax: toFixed(args.pilot.issuanceScaleMax, 4)
      },
      production: {
        coverMinPct: toFixed(args.production.coverMin, 4),
        lossMaxPct: toFixed(args.production.lossMax, 4),
        marginMinPct: toFixed(args.production.marginMin, 4),
        treasuryCoverageMin: toFixed(args.production.treasuryCoverageMin, 4),
        issuanceScaleMax: toFixed(args.production.issuanceScaleMax, 4)
      }
    },
    recommendation: {
      pilot: {
        verdict: pilotMatch ? "GO" : "NO_GO",
        bronzePremiumPer1kUsd: pilotMatch?.bronzePremiumPer1kUsd || null
      },
      production: {
        verdict: prodMatch ? "GO" : "NO_GO",
        bronzePremiumPer1kUsd: prodMatch?.bronzePremiumPer1kUsd || null
      }
    },
    gateChecks: {
      pilot: {
        inspectedBronzePremiumPer1kUsd: pilotInspect.bronzePremiumPer1kUsd,
        checks: evaluate(pilotInspect, args.pilot)
      },
      production: {
        inspectedBronzePremiumPer1kUsd: prodInspect.bronzePremiumPer1kUsd,
        checks: evaluate(prodInspect, args.production)
      }
    },
    metrics: {
      pilot: {
        issuanceScaleMid: pilotInspect.requiredIssuanceScaleMid,
        projectedWorstStressQuarterSubsidyNeedUsd: pilotInspect.projectedWorstStressQuarterSubsidyNeedUsd,
        projectedRolling12mUnderwritingPnlUsd: pilotInspect.projectedRolling12mUnderwritingPnlUsd,
        projectedRolling12mSubsidyNeedUsd: pilotInspect.projectedRolling12mSubsidyNeedUsd,
        projectedRolling12mLossRatioPct: pilotInspect.projectedRolling12mLossRatioPct,
        projectedRolling12mUnderwritingMarginPct: pilotInspect.projectedRolling12mUnderwritingMarginPct,
        projectedRolling12mSubsidyCoveragePct: pilotInspect.projectedRolling12mSubsidyCoveragePct,
        projectedTreasuryCoverageRatio: pilotInspect.projectedTreasuryCoverageRatio
      },
      production: {
        issuanceScaleMid: prodInspect.requiredIssuanceScaleMid,
        projectedWorstStressQuarterSubsidyNeedUsd: prodInspect.projectedWorstStressQuarterSubsidyNeedUsd,
        projectedRolling12mUnderwritingPnlUsd: prodInspect.projectedRolling12mUnderwritingPnlUsd,
        projectedRolling12mSubsidyNeedUsd: prodInspect.projectedRolling12mSubsidyNeedUsd,
        projectedRolling12mLossRatioPct: prodInspect.projectedRolling12mLossRatioPct,
        projectedRolling12mUnderwritingMarginPct: prodInspect.projectedRolling12mUnderwritingMarginPct,
        projectedRolling12mSubsidyCoveragePct: prodInspect.projectedRolling12mSubsidyCoveragePct,
        projectedTreasuryCoverageRatio: prodInspect.projectedTreasuryCoverageRatio
      }
    }
  };

  if (args.outJsonPath) {
    await ensureParentDir(args.outJsonPath);
    await writeFile(args.outJsonPath, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  }

  const boolToPassFail = (v: boolean) => (v ? "PASS" : "FAIL");
  console.log(`RECOMMENDED_BRONZE_PILOT=${out.recommendation.pilot.bronzePremiumPer1kUsd || "NONE"}`);
  console.log(`PILOT_VERDICT=${out.recommendation.pilot.verdict}`);
  console.log(`RECOMMENDED_BRONZE_PRODUCTION=${out.recommendation.production.bronzePremiumPer1kUsd || "NONE"}`);
  console.log(`PRODUCTION_VERDICT=${out.recommendation.production.verdict}`);
  console.log(
    `PILOT_GATES=${[
      `cover:${boolToPassFail(out.gateChecks.pilot.checks.cover)}`,
      `loss:${boolToPassFail(out.gateChecks.pilot.checks.loss)}`,
      `margin:${boolToPassFail(out.gateChecks.pilot.checks.margin)}`,
      `treasuryCoverage:${boolToPassFail(out.gateChecks.pilot.checks.treasuryCoverage)}`,
      `issuanceScale:${boolToPassFail(out.gateChecks.pilot.checks.issuanceScale)}`
    ].join(",")}`
  );
  console.log(
    `PRODUCTION_GATES=${[
      `cover:${boolToPassFail(out.gateChecks.production.checks.cover)}`,
      `loss:${boolToPassFail(out.gateChecks.production.checks.loss)}`,
      `margin:${boolToPassFail(out.gateChecks.production.checks.margin)}`,
      `treasuryCoverage:${boolToPassFail(out.gateChecks.production.checks.treasuryCoverage)}`,
      `issuanceScale:${boolToPassFail(out.gateChecks.production.checks.issuanceScale)}`
    ].join(",")}`
  );
  console.log(JSON.stringify(out, null, 2));
};

main().catch((error: any) => {
  console.error(
    JSON.stringify(
      {
        status: "error",
        reason: "pilot_backtest_launch_verdict_failed",
        message: String(error?.message || error || "unknown_error")
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});

