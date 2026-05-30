import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Decimal from "decimal.js";

type TierName = "bronze" | "silver" | "gold" | "platinum";
type PhaseName = "pilot" | "production";

type ProjectionRow = {
  bandLabel: string;
  bronzePremiumPer1kUsd?: string;
  premiumPer1kUsd?: string;
  projectedRolling12mPremiumUsd?: string;
  projectedRolling12mClaimsAndHedgeUsd?: string;
  projectedRolling12mUnderwritingPnlUsd: string;
  projectedRolling12mSubsidyNeedUsd?: string;
  projectedRolling12mLossRatioPct: string;
  projectedRolling12mUnderwritingMarginPct?: string;
  projectedRolling12mSubsidyCoveragePct: string;
  projectedTreasuryCoverageRatio: string;
  requiredIssuanceScaleMid: string;
};

type BandTargetsJson = {
  projectionRows?: ProjectionRow[];
};

type VerdictTierRow = {
  tier: TierName;
  inputJsonPath: string;
  pilotBand: string;
  productionBand: string;
  pilotVerdict: "GO" | "NO_GO";
  pilotRecommendedPremiumPer1kUsd: string;
  productionVerdict: "GO" | "NO_GO";
  productionRecommendedPremiumPer1kUsd: string;
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

type VerdictJson = {
  summary?: {
    overallPilotVerdict?: "GO" | "NO_GO";
    overallProductionVerdict?: "GO" | "NO_GO";
  };
  tiers?: VerdictTierRow[];
};

type Args = {
  verdictJsonPath: string;
  outCsvPath: string | null;
};

type OutputRow = {
  tier: string;
  phase: PhaseName;
  targetBand: string;
  gateVerdict: string;
  sustainable: boolean;
  recommendedPremiumPer1kUsd: string;
  metricsPremiumPer1kUsd: string;
  issuanceScaleMid: string;
  rolling12mPremiumUsd: string;
  monthlyPremiumUsd: string;
  rolling12mClaimsAndHedgeUsd: string;
  monthlyClaimsAndHedgeUsd: string;
  rolling12mUnderwritingPnlUsd: string;
  monthlyUnderwritingPnlUsd: string;
  rolling12mSubsidyNeedUsd: string;
  monthlySubsidyNeedUsd: string;
  lossRatioPct: string;
  underwritingMarginPct: string;
  subsidyCoveragePct: string;
  treasuryCoverageRatio: string;
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
    verdictJsonPath: "artifacts/desktop/final_targeted_pass/premium_sweep_multi_tier_launch_verdict.json",
    outCsvPath: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--verdict-json" && argv[i + 1]) {
      args.verdictJsonPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--weighted-verdict-json" && argv[i + 1]) {
      args.verdictJsonPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--out-csv" && argv[i + 1]) {
      args.outCsvPath = argv[i + 1];
      i += 1;
      continue;
    }
  }
  return args;
};

const resolvePremium = (row: ProjectionRow): string => {
  const raw = String(row.premiumPer1kUsd || row.bronzePremiumPer1kUsd || "").trim();
  return raw ? toDecimal(raw).toFixed(2) : "UNKNOWN";
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

const defaultOutCsvPath = (verdictJsonPath: string): string =>
  path.join(path.dirname(verdictJsonPath), "final_candidate_monthly_economics.csv");

const resolvePathFromCwd = (targetPath: string): string =>
  path.isAbsolute(targetPath) ? targetPath : path.resolve(process.cwd(), targetPath);

const projectionKey = (band: string, premiumPer1kUsd: string): string => `${band}::${premiumPer1kUsd}`;

const buildProjectionLookup = (projectionRows: ProjectionRow[]): Map<string, ProjectionRow> => {
  const lookup = new Map<string, ProjectionRow>();
  for (const row of projectionRows) {
    const premium = resolvePremium(row);
    lookup.set(projectionKey(String(row.bandLabel || ""), premium), row);
  }
  return lookup;
};

const phaseFields = (tier: VerdictTierRow, phase: PhaseName) => {
  if (phase === "pilot") {
    return {
      band: tier.pilotBand,
      verdict: tier.pilotVerdict,
      premium: tier.pilotRecommendedPremiumPer1kUsd,
      issuanceScaleMid: tier.pilotIssuanceScaleMid,
      pnl: tier.pilotProjectedRolling12mUnderwritingPnlUsd,
      lossRatioPct: tier.pilotProjectedRolling12mLossRatioPct,
      subsidyCoveragePct: tier.pilotProjectedRolling12mSubsidyCoveragePct,
      treasuryCoverageRatio: tier.pilotProjectedTreasuryCoverageRatio
    };
  }
  return {
    band: tier.productionBand,
    verdict: tier.productionVerdict,
    premium: tier.productionRecommendedPremiumPer1kUsd,
    issuanceScaleMid: tier.productionIssuanceScaleMid,
    pnl: tier.productionProjectedRolling12mUnderwritingPnlUsd,
    lossRatioPct: tier.productionProjectedRolling12mLossRatioPct,
    subsidyCoveragePct: tier.productionProjectedRolling12mSubsidyCoveragePct,
    treasuryCoverageRatio: tier.productionProjectedTreasuryCoverageRatio
  };
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const verdictPath = resolvePathFromCwd(args.verdictJsonPath);
  const outCsvPath = resolvePathFromCwd(args.outCsvPath || defaultOutCsvPath(verdictPath));

  const verdictRaw = await readFile(verdictPath, "utf8");
  const verdict = JSON.parse(verdictRaw) as VerdictJson;
  const tierRows = Array.isArray(verdict.tiers) ? verdict.tiers : [];
  if (!tierRows.length) throw new Error("no_tiers_in_verdict");

  const bandTargetsCache = new Map<string, Map<string, ProjectionRow>>();
  const outRows: OutputRow[] = [];

  for (const tierRow of tierRows) {
    const inputAbsPath = resolvePathFromCwd(tierRow.inputJsonPath);
    let projectionLookup = bandTargetsCache.get(inputAbsPath) || null;
    if (!projectionLookup) {
      const raw = await readFile(inputAbsPath, "utf8");
      const parsed = JSON.parse(raw) as BandTargetsJson;
      const projectionRows = Array.isArray(parsed.projectionRows) ? parsed.projectionRows : [];
      projectionLookup = buildProjectionLookup(projectionRows);
      bandTargetsCache.set(inputAbsPath, projectionLookup);
    }

    for (const phase of ["pilot", "production"] as PhaseName[]) {
      const base = phaseFields(tierRow, phase);
      const premium = String(base.premium || "").trim();
      const projectionRowsForBand = Array.from(projectionLookup.values())
        .filter((row) => String(row.bandLabel || "") === base.band)
        .sort((a, b) => toDecimal(resolvePremium(a)).minus(toDecimal(resolvePremium(b))).toNumber());
      const selectedProjection =
        premium && premium !== "NONE"
          ? projectionLookup.get(projectionKey(base.band, toDecimal(premium).toFixed(2))) || null
          : projectionRowsForBand[0] || null;

      const annualPnl = toDecimal(selectedProjection?.projectedRolling12mUnderwritingPnlUsd ?? base.pnl);
      const annualPremium = toDecimal(selectedProjection?.projectedRolling12mPremiumUsd ?? "0");
      const annualClaimsAndHedge = toDecimal(selectedProjection?.projectedRolling12mClaimsAndHedgeUsd ?? "0");
      const annualSubsidyNeed = toDecimal(selectedProjection?.projectedRolling12mSubsidyNeedUsd ?? "0");

      outRows.push({
        tier: tierRow.tier,
        phase,
        targetBand: base.band,
        gateVerdict: base.verdict,
        sustainable: base.verdict === "GO",
        recommendedPremiumPer1kUsd: premium || "NONE",
        metricsPremiumPer1kUsd: selectedProjection ? resolvePremium(selectedProjection) : "UNKNOWN",
        issuanceScaleMid: String(selectedProjection?.requiredIssuanceScaleMid || base.issuanceScaleMid || "0"),
        rolling12mPremiumUsd: toFixed(annualPremium),
        monthlyPremiumUsd: toFixed(annualPremium.div(12)),
        rolling12mClaimsAndHedgeUsd: toFixed(annualClaimsAndHedge),
        monthlyClaimsAndHedgeUsd: toFixed(annualClaimsAndHedge.div(12)),
        rolling12mUnderwritingPnlUsd: toFixed(annualPnl),
        monthlyUnderwritingPnlUsd: toFixed(annualPnl.div(12)),
        rolling12mSubsidyNeedUsd: toFixed(annualSubsidyNeed),
        monthlySubsidyNeedUsd: toFixed(annualSubsidyNeed.div(12)),
        lossRatioPct: toFixed(
          toDecimal(selectedProjection?.projectedRolling12mLossRatioPct ?? base.lossRatioPct),
          6
        ),
        underwritingMarginPct: toFixed(
          toDecimal(selectedProjection?.projectedRolling12mUnderwritingMarginPct ?? "0"),
          6
        ),
        subsidyCoveragePct: toFixed(
          toDecimal(selectedProjection?.projectedRolling12mSubsidyCoveragePct ?? base.subsidyCoveragePct),
          6
        ),
        treasuryCoverageRatio: toFixed(
          toDecimal(selectedProjection?.projectedTreasuryCoverageRatio ?? base.treasuryCoverageRatio),
          6
        )
      });
    }
  }

  for (const phase of ["pilot", "production"] as PhaseName[]) {
    const phaseRows = outRows.filter((row) => row.phase === phase);
    const annualPremium = phaseRows.reduce((acc, row) => acc.plus(toDecimal(row.rolling12mPremiumUsd)), new Decimal(0));
    const annualClaimsAndHedge = phaseRows.reduce(
      (acc, row) => acc.plus(toDecimal(row.rolling12mClaimsAndHedgeUsd)),
      new Decimal(0)
    );
    const annualPnl = phaseRows.reduce((acc, row) => acc.plus(toDecimal(row.rolling12mUnderwritingPnlUsd)), new Decimal(0));
    const annualSubsidyNeed = phaseRows.reduce(
      (acc, row) => acc.plus(toDecimal(row.rolling12mSubsidyNeedUsd)),
      new Decimal(0)
    );
    const weightedLossRatioPct = annualPremium.gt(0) ? annualClaimsAndHedge.div(annualPremium).mul(100) : new Decimal(0);
    const weightedMarginPct = annualPremium.gt(0) ? annualPnl.div(annualPremium).mul(100) : new Decimal(0);

    outRows.push({
      tier: "portfolio_total",
      phase,
      targetBand: phase === "pilot" ? "severe_400_500" : "severe_250_300",
      gateVerdict:
        phase === "pilot"
          ? String(verdict.summary?.overallPilotVerdict || "NO_GO")
          : String(verdict.summary?.overallProductionVerdict || "NO_GO"),
      sustainable:
        phase === "pilot"
          ? String(verdict.summary?.overallPilotVerdict || "NO_GO") === "GO"
          : String(verdict.summary?.overallProductionVerdict || "NO_GO") === "GO",
      recommendedPremiumPer1kUsd: "n/a",
      metricsPremiumPer1kUsd: "n/a",
      issuanceScaleMid: "n/a",
      rolling12mPremiumUsd: toFixed(annualPremium),
      monthlyPremiumUsd: toFixed(annualPremium.div(12)),
      rolling12mClaimsAndHedgeUsd: toFixed(annualClaimsAndHedge),
      monthlyClaimsAndHedgeUsd: toFixed(annualClaimsAndHedge.div(12)),
      rolling12mUnderwritingPnlUsd: toFixed(annualPnl),
      monthlyUnderwritingPnlUsd: toFixed(annualPnl.div(12)),
      rolling12mSubsidyNeedUsd: toFixed(annualSubsidyNeed),
      monthlySubsidyNeedUsd: toFixed(annualSubsidyNeed.div(12)),
      lossRatioPct: toFixed(weightedLossRatioPct, 6),
      underwritingMarginPct: toFixed(weightedMarginPct, 6),
      subsidyCoveragePct: "n/a",
      treasuryCoverageRatio: "n/a"
    });
  }

  await mkdir(path.dirname(outCsvPath), { recursive: true });
  await writeFile(
    outCsvPath,
    rowsToCsv(outRows as unknown as Array<Record<string, string | number | boolean>>),
    "utf8"
  );

  console.log(
    JSON.stringify(
      {
        status: "ok",
        files: {
          verdictJson: verdictPath,
          monthlyEconomicsCsv: outCsvPath
        },
        rowsWritten: outRows.length
      },
      null,
      2
    )
  );
};

main().catch((error: any) => {
  console.error(
    JSON.stringify(
      {
        status: "error",
        reason: "pilot_backtest_final_candidate_monthly_economics_failed",
        message: String(error?.message || error || "unknown_error")
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});

