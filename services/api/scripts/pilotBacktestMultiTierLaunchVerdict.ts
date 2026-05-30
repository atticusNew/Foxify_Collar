import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Decimal from "decimal.js";

type TierName = "bronze" | "silver" | "gold" | "platinum";

type ProjectionRow = {
  bandLabel: string;
  bronzePremiumPer1kUsd?: string;
  premiumPer1kUsd?: string;
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
  tierInputs: Record<TierName, string | null>;
  pilotBand: string;
  productionBand: string;
  pilot: GateConfig;
  production: GateConfig;
  outJsonPath: string | null;
  outCsvPath: string | null;
};

type GateEvaluation = {
  cover: boolean;
  loss: boolean;
  margin: boolean;
  treasuryCoverage: boolean;
  issuanceScale: boolean;
  all: boolean;
};

type TierVerdictRow = {
  tier: TierName;
  inputJsonPath: string;
  pilotBand: string;
  productionBand: string;
  pilotVerdict: "GO" | "NO_GO";
  pilotRecommendedPremiumPer1kUsd: string;
  productionVerdict: "GO" | "NO_GO";
  productionRecommendedPremiumPer1kUsd: string;
  pilotCoverPass: boolean;
  pilotLossPass: boolean;
  pilotMarginPass: boolean;
  pilotTreasuryCoveragePass: boolean;
  pilotIssuanceScalePass: boolean;
  productionCoverPass: boolean;
  productionLossPass: boolean;
  productionMarginPass: boolean;
  productionTreasuryCoveragePass: boolean;
  productionIssuanceScalePass: boolean;
  pilotIssuanceScaleMid: string;
  productionIssuanceScaleMid: string;
  pilotProjectedRolling12mUnderwritingPnlUsd: string;
  productionProjectedRolling12mUnderwritingPnlUsd: string;
  pilotProjectedRolling12mLossRatioPct: string;
  productionProjectedRolling12mLossRatioPct: string;
  pilotProjectedRolling12mSubsidyCoveragePct: string;
  productionProjectedRolling12mSubsidyCoveragePct: string;
  pilotProjectedTreasuryCoverageRatio: string;
  productionProjectedTreasuryCoverageRatio: string;
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
    tierInputs: {
      bronze: "artifacts/desktop/premium_sweep_coinbase_tp_off_wide/premium_sweep_band_targets.json",
      silver: null,
      gold: null,
      platinum: null
    },
    pilotBand: "severe_400_500",
    productionBand: "severe_250_300",
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
    outJsonPath: null,
    outCsvPath: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--tier" && argv[i + 1]) {
      const raw = String(argv[i + 1]).trim();
      const splitIdx = raw.indexOf(":");
      if (splitIdx <= 0 || splitIdx >= raw.length - 1) {
        throw new Error(`invalid_tier_arg:${raw}`);
      }
      const tier = raw.slice(0, splitIdx).trim().toLowerCase();
      const inputPath = raw.slice(splitIdx + 1).trim();
      if (tier !== "bronze" && tier !== "silver" && tier !== "gold" && tier !== "platinum") {
        throw new Error(`invalid_tier_name:${tier}`);
      }
      args.tierInputs[tier] = inputPath;
      i += 1;
      continue;
    }
    if (token === "--bronze-targets-json" && argv[i + 1]) {
      args.tierInputs.bronze = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--silver-targets-json" && argv[i + 1]) {
      args.tierInputs.silver = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--gold-targets-json" && argv[i + 1]) {
      args.tierInputs.gold = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--platinum-targets-json" && argv[i + 1]) {
      args.tierInputs.platinum = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--pilot-band" && argv[i + 1]) {
      args.pilotBand = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--production-band" && argv[i + 1]) {
      args.productionBand = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--out-json" && argv[i + 1]) {
      args.outJsonPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--out-csv" && argv[i + 1]) {
      args.outCsvPath = argv[i + 1];
      i += 1;
      continue;
    }

    const parseGate = (target: GateConfig, field: keyof GateConfig) => {
      if (!argv[i + 1]) throw new Error(`missing_value:${token}`);
      target[field] = toDecimal(argv[i + 1]);
      i += 1;
    };

    if (token === "--pilot-cover-min-pct") parseGate(args.pilot, "coverMin");
    else if (token === "--pilot-loss-max-pct") parseGate(args.pilot, "lossMax");
    else if (token === "--pilot-margin-min-pct") parseGate(args.pilot, "marginMin");
    else if (token === "--pilot-treasury-coverage-min") parseGate(args.pilot, "treasuryCoverageMin");
    else if (token === "--pilot-issuance-scale-max") parseGate(args.pilot, "issuanceScaleMax");
    else if (token === "--production-cover-min-pct") parseGate(args.production, "coverMin");
    else if (token === "--production-loss-max-pct") parseGate(args.production, "lossMax");
    else if (token === "--production-margin-min-pct") parseGate(args.production, "marginMin");
    else if (token === "--production-treasury-coverage-min") parseGate(args.production, "treasuryCoverageMin");
    else if (token === "--production-issuance-scale-max") parseGate(args.production, "issuanceScaleMax");
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

const resolvePremium = (row: ProjectionRow): string => {
  const value = String(row.premiumPer1kUsd || row.bronzePremiumPer1kUsd || "").trim();
  if (!value) return "UNKNOWN";
  return toDecimal(value).toFixed(2);
};

const escapeCsv = (raw: string): string => {
  if (!raw.includes(",") && !raw.includes("\"") && !raw.includes("\n")) return raw;
  return `"${raw.replace(/"/g, "\"\"")}"`;
};

const rowsToCsv = (rows: Array<Record<string, string | number | boolean>>): string => {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((key) => escapeCsv(String(row[key] ?? ""))).join(","));
  }
  return `${lines.join("\n")}\n`;
};

const ensureParentDir = async (targetPath: string) => {
  await mkdir(path.dirname(targetPath), { recursive: true });
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const tierVerdicts: TierVerdictRow[] = [];
  const tiers: TierName[] = ["bronze", "silver", "gold", "platinum"];

  for (const tier of tiers) {
    const inputPath = args.tierInputs[tier];
    if (!inputPath) continue;
    const raw = await readFile(inputPath, "utf8");
    const parsed = JSON.parse(raw) as BandTargetsJson;
    const projectionRows = Array.isArray(parsed.projectionRows) ? parsed.projectionRows : [];
    const pilotRows = projectionRows
      .filter((row) => String(row.bandLabel || "") === args.pilotBand)
      .sort((a, b) => toDecimal(resolvePremium(a)).minus(toDecimal(resolvePremium(b))).toNumber());
    const productionRows = projectionRows
      .filter((row) => String(row.bandLabel || "") === args.productionBand)
      .sort((a, b) => toDecimal(resolvePremium(a)).minus(toDecimal(resolvePremium(b))).toNumber());

    if (!pilotRows.length || !productionRows.length) {
      throw new Error(`missing_band_rows_for_tier:${tier}`);
    }

    const pilotMatch = pilotRows.find((row) => evaluate(row, args.pilot).all) || null;
    const productionMatch = productionRows.find((row) => evaluate(row, args.production).all) || null;
    const pilotInspect = pilotMatch || pilotRows[0];
    const productionInspect = productionMatch || productionRows[0];
    const pilotChecks = evaluate(pilotInspect, args.pilot);
    const productionChecks = evaluate(productionInspect, args.production);

    tierVerdicts.push({
      tier,
      inputJsonPath: inputPath,
      pilotBand: args.pilotBand,
      productionBand: args.productionBand,
      pilotVerdict: pilotMatch ? "GO" : "NO_GO",
      pilotRecommendedPremiumPer1kUsd: pilotMatch ? resolvePremium(pilotMatch) : "NONE",
      productionVerdict: productionMatch ? "GO" : "NO_GO",
      productionRecommendedPremiumPer1kUsd: productionMatch ? resolvePremium(productionMatch) : "NONE",
      pilotCoverPass: pilotChecks.cover,
      pilotLossPass: pilotChecks.loss,
      pilotMarginPass: pilotChecks.margin,
      pilotTreasuryCoveragePass: pilotChecks.treasuryCoverage,
      pilotIssuanceScalePass: pilotChecks.issuanceScale,
      productionCoverPass: productionChecks.cover,
      productionLossPass: productionChecks.loss,
      productionMarginPass: productionChecks.margin,
      productionTreasuryCoveragePass: productionChecks.treasuryCoverage,
      productionIssuanceScalePass: productionChecks.issuanceScale,
      pilotIssuanceScaleMid: pilotInspect.requiredIssuanceScaleMid,
      productionIssuanceScaleMid: productionInspect.requiredIssuanceScaleMid,
      pilotProjectedRolling12mUnderwritingPnlUsd: pilotInspect.projectedRolling12mUnderwritingPnlUsd,
      productionProjectedRolling12mUnderwritingPnlUsd: productionInspect.projectedRolling12mUnderwritingPnlUsd,
      pilotProjectedRolling12mLossRatioPct: pilotInspect.projectedRolling12mLossRatioPct,
      productionProjectedRolling12mLossRatioPct: productionInspect.projectedRolling12mLossRatioPct,
      pilotProjectedRolling12mSubsidyCoveragePct: pilotInspect.projectedRolling12mSubsidyCoveragePct,
      productionProjectedRolling12mSubsidyCoveragePct: productionInspect.projectedRolling12mSubsidyCoveragePct,
      pilotProjectedTreasuryCoverageRatio: pilotInspect.projectedTreasuryCoverageRatio,
      productionProjectedTreasuryCoverageRatio: productionInspect.projectedTreasuryCoverageRatio
    });
  }

  if (!tierVerdicts.length) {
    throw new Error("no_tier_inputs_provided");
  }

  const overallPilotGo = tierVerdicts.every((row) => row.pilotVerdict === "GO");
  const overallProductionGo = tierVerdicts.every((row) => row.productionVerdict === "GO");

  const out = {
    status: "ok",
    generatedAtIso: new Date().toISOString(),
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
    bands: {
      pilot: args.pilotBand,
      production: args.productionBand
    },
    summary: {
      evaluatedTiers: tierVerdicts.map((row) => row.tier),
      overallPilotVerdict: overallPilotGo ? "GO" : "NO_GO",
      overallProductionVerdict: overallProductionGo ? "GO" : "NO_GO"
    },
    tiers: tierVerdicts
  };

  if (args.outJsonPath) {
    await ensureParentDir(args.outJsonPath);
    await writeFile(args.outJsonPath, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  }
  if (args.outCsvPath) {
    await ensureParentDir(args.outCsvPath);
    await writeFile(
      args.outCsvPath,
      rowsToCsv(tierVerdicts as unknown as Array<Record<string, string | number | boolean>>),
      "utf8"
    );
  }

  console.log(`OVERALL_PILOT_VERDICT=${out.summary.overallPilotVerdict}`);
  console.log(`OVERALL_PRODUCTION_VERDICT=${out.summary.overallProductionVerdict}`);
  for (const row of tierVerdicts) {
    console.log(
      `${row.tier.toUpperCase()}_PILOT=${row.pilotRecommendedPremiumPer1kUsd}(${row.pilotVerdict}) ` +
        `${row.tier.toUpperCase()}_PRODUCTION=${row.productionRecommendedPremiumPer1kUsd}(${row.productionVerdict})`
    );
  }
  console.log(JSON.stringify(out, null, 2));
};

main().catch((error: any) => {
  console.error(
    JSON.stringify(
      {
        status: "error",
        reason: "pilot_backtest_multi_tier_launch_verdict_failed",
        message: String(error?.message || error || "unknown_error")
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});

