import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Decimal from "decimal.js";

type BandSpec = {
  label: string;
  minPerStressQuarterUsd: Decimal;
  maxPerStressQuarterUsd: Decimal;
};

type Args = {
  sweepResultsPath: string;
  outDir: string | null;
  bands: BandSpec[];
  issuanceScaleGrid: Decimal[];
  realismHighMax: Decimal;
  realismMediumMax: Decimal;
  allowSmallBandUsd: boolean;
};

type CandidateRow = {
  bronzePremiumPer1kUsd: string;
  stressSubsidyNeedTotalUsd: string;
  stressSubsidyAppliedTotalUsd: string;
  stressSubsidyBlockedTotalUsd: string;
  stressWorstDaySubsidyNeedUsd: string;
  stressWorstRecommendedMinBufferUsd: string;
  calmUnderwritingPnlTotalUsd: string;
  calmSubsidyNeedTotalUsd: string;
  rolling12mUnderwritingPnlTotalUsd: string;
  rolling12mSubsidyNeedTotalUsd: string;
  rolling12mSubsidyBlockedTotalUsd: string;
  rolling12mRecommendedMinBufferUsd: string;
};

type PeriodRow = {
  bronzePremiumPer1kUsd: string;
  periodLabel: string;
  periodRegime: "stress" | "calm" | "mixed";
  fromIso: string;
  toIso: string;
  trades: number;
  underwritingPnlTotalUsd: string;
  subsidyNeedTotalUsd: string;
  subsidyAppliedTotalUsd: string;
  subsidyBlockedTotalUsd: string;
  triggerHitRatePct: string;
  endTreasuryBalanceUsd: string;
  worstDaySubsidyNeedUsd: string;
  worstDaySubsidyNeedDate: string;
  maxDrawdownUsd: string;
  maxDrawdownPct: string;
  recommendedMinTreasuryBufferUsd: string;
};

type SweepResults = {
  assumptions?: {
    treasuryStartingBalanceUsd?: string;
    tierName?: string;
  };
  candidateRows: CandidateRow[];
  periodRows: PeriodRow[];
};

type RunSummaryHybrid = {
  premiumTotalUsd: string;
  payoutTotalUsd: string;
  hedgeNetCostTotalUsd: string;
  underwritingPnlTotalUsd: string;
  subsidyNeedTotalUsd: string;
  subsidyBlockedTotalUsd: string;
};

type RunJson = {
  summary?: Array<{
    model: string;
    premiumTotalUsd?: string;
    payoutTotalUsd?: string;
    hedgeNetCostTotalUsd?: string;
    underwritingPnlTotalUsd?: string;
    subsidyNeedTotalUsd?: string;
    subsidyBlockedTotalUsd?: string;
  }>;
};

type BandProjectionRow = {
  bandLabel: string;
  bronzePremiumPer1kUsd: string;
  targetMinPerStressQuarterUsd: string;
  targetMaxPerStressQuarterUsd: string;
  stressAnchorQuarterLabel: string;
  stressAnchorQuarterBaseSubsidyNeedUsd: string;
  requiredIssuanceScaleMin: string;
  requiredIssuanceScaleMax: string;
  requiredIssuanceScaleMid: string;
  withinScaleGrid: boolean;
  projectedWorstStressQuarterSubsidyNeedUsd: string;
  projectedStressCombinedSubsidyNeedUsd: string;
  projectedRolling12mPremiumUsd: string;
  projectedRolling12mClaimsAndHedgeUsd: string;
  projectedRolling12mUnderwritingPnlUsd: string;
  projectedRolling12mUnderwritingMarginPct: string;
  projectedRolling12mLossRatioPct: string;
  projectedRolling12mSubsidyNeedUsd: string;
  projectedRolling12mSubsidyBlockedUsd: string;
  projectedRolling12mSubsidyCoveragePct: string;
  projectedRolling12mTreasuryUsagePct: string;
  projectedStressWorstDaySubsidyNeedUsd: string;
  projectedStressBufferFromWorstDayUsd: string;
  configuredStartingTreasuryUsd: string;
  projectedTreasuryCoverageRatio: string;
  projectedAnnualSubsidyToPnlAbsRatio: string;
  baseAnchorQuarterProtectedNotionalUsd: string;
  projectedAnchorQuarterProtectedNotionalMinUsd: string;
  projectedAnchorQuarterProtectedNotionalMaxUsd: string;
  projectedAnchorDailyProtectedNotionalMinUsd: string;
  projectedAnchorDailyProtectedNotionalMaxUsd: string;
  realismTag: "high" | "medium" | "low";
};

type BandSelectionRow = {
  bandLabel: string;
  selectionType: "lowest_bronze_any" | "lowest_bronze_realistic";
  bronzePremiumPer1kUsd: string;
  requiredIssuanceScaleMid: string;
  realismTag: string;
  projectedWorstStressQuarterSubsidyNeedUsd: string;
  projectedRolling12mUnderwritingPnlUsd: string;
  projectedRolling12mSubsidyNeedUsd: string;
  projectedRolling12mLossRatioPct: string;
  projectedRolling12mUnderwritingMarginPct: string;
  projectedRolling12mSubsidyCoveragePct: string;
  projectedAnnualSubsidyToPnlAbsRatio: string;
  projectedTreasuryCoverageRatio: string;
};

const toDecimal = (value: string | number | null | undefined): Decimal => {
  try {
    return new Decimal(String(value ?? "0"));
  } catch {
    return new Decimal(0);
  }
};

const toFixed = (value: Decimal, dp = 10): string => value.toFixed(dp);
const absDecimal = (value: Decimal): Decimal => (value.lt(0) ? value.negated() : value);
const parseBool = (raw: string | undefined, fallback: boolean): boolean => {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return fallback;
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  return fallback;
};

const parseDecimalList = (raw: string | undefined, fallback: string): Decimal[] => {
  const out = String(raw || fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => toDecimal(item))
    .filter((item) => item.gt(0));
  const dedup = new Map<string, Decimal>();
  for (const item of out) dedup.set(item.toFixed(6), item);
  return Array.from(dedup.values()).sort((a, b) => a.minus(b).toNumber());
};

const parseUsdAmount = (raw: string): Decimal => {
  const value = String(raw || "").trim();
  const match = value.match(/^(-?\d+(?:\.\d+)?)\s*([kKmMbB]?)$/);
  if (!match) return toDecimal(value);
  const base = toDecimal(match[1]);
  const unit = String(match[2] || "").toLowerCase();
  if (unit === "k") return base.mul(1000);
  if (unit === "m") return base.mul(1_000_000);
  if (unit === "b") return base.mul(1_000_000_000);
  return base;
};

const parseBands = (raw: string | undefined, allowSmallBandUsd: boolean): BandSpec[] => {
  const source = String(raw || "severe_400_500:400000-500000,severe_250_300:250000-300000");
  const out: BandSpec[] = [];
  for (const token of source.split(",")) {
    const part = token.trim();
    if (!part) continue;
    const [labelRaw, rangeRaw] = part.includes(":") ? part.split(":", 2) : [part, part];
    const [minRaw, maxRaw] = String(rangeRaw || "")
      .split("-", 2)
      .map((v) => v.trim());
    const minValue = parseUsdAmount(minRaw);
    const maxValue = parseUsdAmount(maxRaw);
    if (minValue.lte(0) || maxValue.lte(0) || maxValue.lt(minValue)) {
      throw new Error(`invalid_band:${part}`);
    }
    const likelyUnintendedTinyBand = maxValue.lt(1000);
    if (likelyUnintendedTinyBand && !allowSmallBandUsd) {
      throw new Error(
        `band_values_too_small:${part}:use_full_usd_or_suffix_e.g._200000-250000_or_200k-250k_or_pass_--allow-small-band-usd_true`
      );
    }
    const label = String(labelRaw || `${minRaw}_${maxRaw}`)
      .trim()
      .replace(/[^a-zA-Z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "");
    out.push({
      label: label || `band_${minRaw}_${maxRaw}`,
      minPerStressQuarterUsd: minValue,
      maxPerStressQuarterUsd: maxValue
    });
  }
  if (!out.length) throw new Error("no_bands");
  return out;
};

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    sweepResultsPath: "artifacts/desktop/premium_sweep_coinbase_tp_off_scaled/premium_sweep_results.json",
    outDir: null,
    bands: [],
    issuanceScaleGrid: parseDecimalList(undefined, "25,50,75,100,125,150,175,200"),
    realismHighMax: new Decimal(150),
    realismMediumMax: new Decimal(300),
    allowSmallBandUsd: false
  };
  let rawBands: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--results-json" && argv[i + 1]) {
      args.sweepResultsPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--out-dir" && argv[i + 1]) {
      args.outDir = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--bands" && argv[i + 1]) {
      rawBands = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--allow-small-band-usd" && argv[i + 1]) {
      args.allowSmallBandUsd = parseBool(argv[i + 1], false);
      i += 1;
      continue;
    }
    if (token === "--issuance-scale-grid" && argv[i + 1]) {
      args.issuanceScaleGrid = parseDecimalList(argv[i + 1], "25,50,75,100,125,150,175,200");
      i += 1;
      continue;
    }
    if (token === "--realism-high-max" && argv[i + 1]) {
      const value = toDecimal(argv[i + 1]);
      if (value.lte(0)) throw new Error("invalid_realism_high_max");
      args.realismHighMax = value;
      i += 1;
      continue;
    }
    if (token === "--realism-medium-max" && argv[i + 1]) {
      const value = toDecimal(argv[i + 1]);
      if (value.lte(0)) throw new Error("invalid_realism_medium_max");
      args.realismMediumMax = value;
      i += 1;
      continue;
    }
  }
  args.bands = parseBands(rawBands, args.allowSmallBandUsd);
  return args;
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

const resolvePeriodDays = (period: Pick<PeriodRow, "fromIso" | "toIso">): number => {
  const fromMs = Date.parse(period.fromIso);
  const toMs = Date.parse(period.toIso);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return 1;
  return Math.max(1, Math.round((toMs - fromMs) / (24 * 60 * 60 * 1000)));
};

const slugifyTierName = (tierName: string): string =>
  String(tierName || "tier")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "tier";

const scenarioLabelCandidates = (premium: string, tierName?: string): string[] => {
  const normalized = toDecimal(premium).toFixed(2).replace(".", "_");
  const out = new Set<string>();
  if (tierName) out.add(`${slugifyTierName(tierName)}_${normalized}`);
  out.add(`bronze_${normalized}`); // legacy fallback
  return Array.from(out.values());
};

const parseHybridSummary = (runJson: RunJson): RunSummaryHybrid => {
  const hybrid = (runJson.summary || []).find((row) => String(row.model || "").toLowerCase() === "hybrid");
  if (!hybrid) throw new Error("hybrid_summary_missing");
  return {
    premiumTotalUsd: String(hybrid.premiumTotalUsd || "0"),
    payoutTotalUsd: String(hybrid.payoutTotalUsd || "0"),
    hedgeNetCostTotalUsd: String(hybrid.hedgeNetCostTotalUsd || "0"),
    underwritingPnlTotalUsd: String(hybrid.underwritingPnlTotalUsd || "0"),
    subsidyNeedTotalUsd: String(hybrid.subsidyNeedTotalUsd || "0"),
    subsidyBlockedTotalUsd: String(hybrid.subsidyBlockedTotalUsd || "0")
  };
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const resultsRaw = await readFile(args.sweepResultsPath, "utf8");
  const results = JSON.parse(resultsRaw) as SweepResults;
  const outDir = args.outDir || path.dirname(args.sweepResultsPath);
  await mkdir(outDir, { recursive: true });

  const startingTreasury = toDecimal(results.assumptions?.treasuryStartingBalanceUsd || "0");
  const periodRows = Array.isArray(results.periodRows) ? results.periodRows : [];
  const candidateRows = Array.isArray(results.candidateRows) ? results.candidateRows : [];
  const runJsonCache = new Map<string, RunSummaryHybrid>();
  const runsDir = path.join(path.dirname(args.sweepResultsPath), "runs");
  const runScenarioDirs = await readdir(runsDir).catch(() => []);

  const readRunSummary = async (bronzePremium: string, periodLabel: string): Promise<RunSummaryHybrid> => {
    const cacheKey = `${bronzePremium}:${periodLabel}`;
    const cached = runJsonCache.get(cacheKey);
    if (cached) return cached;
    const normalized = toDecimal(bronzePremium).toFixed(2).replace(".", "_");
    const candidates = scenarioLabelCandidates(bronzePremium, results.assumptions?.tierName);
    // Also accept any scenario dir that ends with the normalized premium token.
    for (const dir of runScenarioDirs) {
      if (String(dir).endsWith(`_${normalized}`)) candidates.push(String(dir));
    }
    let parsed: RunJson | null = null;
    for (const scenarioDir of candidates) {
      const runPath = path.join(runsDir, scenarioDir, `pilot_backtest_${periodLabel}.json`);
      try {
        parsed = JSON.parse(await readFile(runPath, "utf8")) as RunJson;
        break;
      } catch {
        // try next candidate
      }
    }
    if (!parsed) {
      throw new Error(`run_json_not_found:${bronzePremium}:${periodLabel}`);
    }
    const summary = parseHybridSummary(parsed);
    runJsonCache.set(cacheKey, summary);
    return summary;
  };

  const projectionRows: BandProjectionRow[] = [];
  for (const candidate of candidateRows) {
    const bronzePremium = String(candidate.bronzePremiumPer1kUsd || "").trim();
    if (!bronzePremium) continue;
    const byPremium = periodRows.filter((row) => row.bronzePremiumPer1kUsd === bronzePremium);
    const stressRows = byPremium.filter((row) => row.periodRegime === "stress");
    const rolling = byPremium.find((row) => row.periodLabel === "rolling_12m");
    if (!stressRows.length || !rolling) continue;

    const anchor = [...stressRows].sort(
      (a, b) => toDecimal(b.subsidyNeedTotalUsd).minus(toDecimal(a.subsidyNeedTotalUsd)).toNumber()
    )[0];
    const anchorSubsidyNeed = toDecimal(anchor.subsidyNeedTotalUsd);
    if (anchorSubsidyNeed.lte(0)) continue;

    const anchorRun = await readRunSummary(bronzePremium, anchor.periodLabel);
    const rollingRun = await readRunSummary(bronzePremium, "rolling_12m");
    const bronzePremiumDec = toDecimal(bronzePremium);
    const premiumTotalAnchor = toDecimal(anchorRun.premiumTotalUsd);
    const anchorProtectedNotionalBase = bronzePremiumDec.gt(0)
      ? premiumTotalAnchor.div(bronzePremiumDec).mul(1000)
      : new Decimal(0);
    const anchorDays = resolvePeriodDays(anchor);

    const stressCombinedBaseNeed = stressRows.reduce((acc, row) => acc.plus(toDecimal(row.subsidyNeedTotalUsd)), new Decimal(0));
    const stressWorstDayBase = stressRows.reduce(
      (acc, row) => Decimal.max(acc, toDecimal(row.worstDaySubsidyNeedUsd)),
      new Decimal(0)
    );
    const rollingPnlBase = toDecimal(rollingRun.underwritingPnlTotalUsd);
    const rollingNeedBase = toDecimal(rollingRun.subsidyNeedTotalUsd);
    const rollingBlockedBase = toDecimal(rollingRun.subsidyBlockedTotalUsd);
    const rollingPremiumBase = toDecimal(rollingRun.premiumTotalUsd);
    const rollingClaimsAndHedgeBase = toDecimal(rollingRun.payoutTotalUsd).plus(toDecimal(rollingRun.hedgeNetCostTotalUsd));

    for (const band of args.bands) {
      const scaleMin = band.minPerStressQuarterUsd.div(anchorSubsidyNeed);
      const scaleMax = band.maxPerStressQuarterUsd.div(anchorSubsidyNeed);
      const scaleMid = scaleMin.plus(scaleMax).div(2);
      const gridMin = args.issuanceScaleGrid[0] || new Decimal(0);
      const gridMax = args.issuanceScaleGrid[args.issuanceScaleGrid.length - 1] || new Decimal(0);
      const withinScaleGrid = scaleMid.gte(gridMin) && scaleMid.lte(gridMax);
      const realismTag: BandProjectionRow["realismTag"] = scaleMid.lte(args.realismHighMax)
        ? "high"
        : scaleMid.lte(args.realismMediumMax)
          ? "medium"
          : "low";

      const projectedWorstStressQuarterNeed = anchorSubsidyNeed.mul(scaleMid);
      const projectedStressCombinedNeed = stressCombinedBaseNeed.mul(scaleMid);
      const projectedRollingPremium = rollingPremiumBase.mul(scaleMid);
      const projectedRollingClaimsAndHedge = rollingClaimsAndHedgeBase.mul(scaleMid);
      const projectedRollingPnl = rollingPnlBase.mul(scaleMid);
      const projectedRollingNeed = rollingNeedBase.mul(scaleMid);
      const projectedRollingBlocked = rollingBlockedBase.mul(scaleMid);
      const projectedStressWorstDayNeed = stressWorstDayBase.mul(scaleMid);
      const projectedStressBuffer = startingTreasury.minus(projectedStressWorstDayNeed.mul("1.5"));

      const projectedLossRatioPct = projectedRollingPremium.gt(0)
        ? projectedRollingClaimsAndHedge.div(projectedRollingPremium).mul(100)
        : new Decimal(0);
      const projectedUnderwritingMarginPct = projectedRollingPremium.gt(0)
        ? projectedRollingPnl.div(projectedRollingPremium).mul(100)
        : new Decimal(0);
      const projectedSubsidyCoveragePct = projectedRollingNeed.gt(0)
        ? projectedRollingNeed.minus(projectedRollingBlocked).div(projectedRollingNeed).mul(100)
        : new Decimal(100);
      const projectedTreasuryUsagePct = startingTreasury.gt(0)
        ? projectedRollingNeed.div(startingTreasury).mul(100)
        : new Decimal(0);
      const projectedTreasuryCoverageRatio = projectedWorstStressQuarterNeed.gt(0)
        ? startingTreasury.div(projectedWorstStressQuarterNeed)
        : new Decimal(0);
      const projectedAnnualSubsidyToPnlAbsRatio = absDecimal(projectedRollingPnl).gt(0)
        ? projectedRollingNeed.div(absDecimal(projectedRollingPnl))
        : new Decimal(0);

      projectionRows.push({
        bandLabel: band.label,
        bronzePremiumPer1kUsd: bronzePremium,
        targetMinPerStressQuarterUsd: toFixed(band.minPerStressQuarterUsd, 2),
        targetMaxPerStressQuarterUsd: toFixed(band.maxPerStressQuarterUsd, 2),
        stressAnchorQuarterLabel: anchor.periodLabel,
        stressAnchorQuarterBaseSubsidyNeedUsd: toFixed(anchorSubsidyNeed),
        requiredIssuanceScaleMin: toFixed(scaleMin),
        requiredIssuanceScaleMax: toFixed(scaleMax),
        requiredIssuanceScaleMid: toFixed(scaleMid),
        withinScaleGrid,
        projectedWorstStressQuarterSubsidyNeedUsd: toFixed(projectedWorstStressQuarterNeed),
        projectedStressCombinedSubsidyNeedUsd: toFixed(projectedStressCombinedNeed),
        projectedRolling12mPremiumUsd: toFixed(projectedRollingPremium),
        projectedRolling12mClaimsAndHedgeUsd: toFixed(projectedRollingClaimsAndHedge),
        projectedRolling12mUnderwritingPnlUsd: toFixed(projectedRollingPnl),
        projectedRolling12mUnderwritingMarginPct: toFixed(projectedUnderwritingMarginPct, 6),
        projectedRolling12mLossRatioPct: toFixed(projectedLossRatioPct, 6),
        projectedRolling12mSubsidyNeedUsd: toFixed(projectedRollingNeed),
        projectedRolling12mSubsidyBlockedUsd: toFixed(projectedRollingBlocked),
        projectedRolling12mSubsidyCoveragePct: toFixed(projectedSubsidyCoveragePct, 6),
        projectedRolling12mTreasuryUsagePct: toFixed(projectedTreasuryUsagePct, 6),
        projectedStressWorstDaySubsidyNeedUsd: toFixed(projectedStressWorstDayNeed),
        projectedStressBufferFromWorstDayUsd: toFixed(projectedStressBuffer),
        configuredStartingTreasuryUsd: toFixed(startingTreasury),
        projectedTreasuryCoverageRatio: toFixed(projectedTreasuryCoverageRatio, 6),
        projectedAnnualSubsidyToPnlAbsRatio: toFixed(projectedAnnualSubsidyToPnlAbsRatio, 6),
        baseAnchorQuarterProtectedNotionalUsd: toFixed(anchorProtectedNotionalBase),
        projectedAnchorQuarterProtectedNotionalMinUsd: toFixed(anchorProtectedNotionalBase.mul(scaleMin)),
        projectedAnchorQuarterProtectedNotionalMaxUsd: toFixed(anchorProtectedNotionalBase.mul(scaleMax)),
        projectedAnchorDailyProtectedNotionalMinUsd: toFixed(anchorProtectedNotionalBase.mul(scaleMin).div(anchorDays)),
        projectedAnchorDailyProtectedNotionalMaxUsd: toFixed(anchorProtectedNotionalBase.mul(scaleMax).div(anchorDays)),
        realismTag
      });
    }
  }

  const selectionRows: BandSelectionRow[] = [];
  const uniqueBands = Array.from(new Set(projectionRows.map((row) => row.bandLabel)));
  for (const bandLabel of uniqueBands) {
    const rows = projectionRows
      .filter((row) => row.bandLabel === bandLabel)
      .sort((a, b) => toDecimal(a.bronzePremiumPer1kUsd).minus(toDecimal(b.bronzePremiumPer1kUsd)).toNumber());
    const any = rows[0] || null;
    const realistic = rows.find((row) => row.realismTag !== "low") || null;
    if (any) {
      selectionRows.push({
        bandLabel,
        selectionType: "lowest_bronze_any",
        bronzePremiumPer1kUsd: any.bronzePremiumPer1kUsd,
        requiredIssuanceScaleMid: any.requiredIssuanceScaleMid,
        realismTag: any.realismTag,
        projectedWorstStressQuarterSubsidyNeedUsd: any.projectedWorstStressQuarterSubsidyNeedUsd,
        projectedRolling12mUnderwritingPnlUsd: any.projectedRolling12mUnderwritingPnlUsd,
        projectedRolling12mSubsidyNeedUsd: any.projectedRolling12mSubsidyNeedUsd,
        projectedRolling12mLossRatioPct: any.projectedRolling12mLossRatioPct,
        projectedRolling12mUnderwritingMarginPct: any.projectedRolling12mUnderwritingMarginPct,
        projectedRolling12mSubsidyCoveragePct: any.projectedRolling12mSubsidyCoveragePct,
        projectedAnnualSubsidyToPnlAbsRatio: any.projectedAnnualSubsidyToPnlAbsRatio,
        projectedTreasuryCoverageRatio: any.projectedTreasuryCoverageRatio
      });
    }
    if (realistic) {
      selectionRows.push({
        bandLabel,
        selectionType: "lowest_bronze_realistic",
        bronzePremiumPer1kUsd: realistic.bronzePremiumPer1kUsd,
        requiredIssuanceScaleMid: realistic.requiredIssuanceScaleMid,
        realismTag: realistic.realismTag,
        projectedWorstStressQuarterSubsidyNeedUsd: realistic.projectedWorstStressQuarterSubsidyNeedUsd,
        projectedRolling12mUnderwritingPnlUsd: realistic.projectedRolling12mUnderwritingPnlUsd,
        projectedRolling12mSubsidyNeedUsd: realistic.projectedRolling12mSubsidyNeedUsd,
        projectedRolling12mLossRatioPct: realistic.projectedRolling12mLossRatioPct,
        projectedRolling12mUnderwritingMarginPct: realistic.projectedRolling12mUnderwritingMarginPct,
        projectedRolling12mSubsidyCoveragePct: realistic.projectedRolling12mSubsidyCoveragePct,
        projectedAnnualSubsidyToPnlAbsRatio: realistic.projectedAnnualSubsidyToPnlAbsRatio,
        projectedTreasuryCoverageRatio: realistic.projectedTreasuryCoverageRatio
      });
    }
  }

  const outJsonPath = path.join(outDir, "premium_sweep_band_targets.json");
  const outProjectionCsvPath = path.join(outDir, "premium_sweep_band_projections.csv");
  const outSelectionCsvPath = path.join(outDir, "premium_sweep_band_recommendations.csv");
  const outOverviewMdPath = path.join(outDir, "premium_sweep_band_overview.md");

  await writeFile(
    outJsonPath,
    `${JSON.stringify(
      {
        status: "ok",
        generatedAtIso: new Date().toISOString(),
        assumptions: {
          sourceResultsPath: args.sweepResultsPath,
          issuanceScaleGrid: args.issuanceScaleGrid.map((v) => toFixed(v, 2)),
          realismHighMax: toFixed(args.realismHighMax, 2),
          realismMediumMax: toFixed(args.realismMediumMax, 2),
          bands: args.bands.map((b) => ({
            label: b.label,
            minPerStressQuarterUsd: toFixed(b.minPerStressQuarterUsd, 2),
            maxPerStressQuarterUsd: toFixed(b.maxPerStressQuarterUsd, 2)
          }))
        },
        selectionRows,
        projectionRows
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    outProjectionCsvPath,
    rowsToCsv(projectionRows as unknown as Array<Record<string, string | number | boolean>>),
    "utf8"
  );
  await writeFile(
    outSelectionCsvPath,
    rowsToCsv(selectionRows as unknown as Array<Record<string, string | number | boolean>>),
    "utf8"
  );

  const overview = [
    "# Premium sweep band targets",
    "",
    "## What this does",
    "- Converts baseline stress-quarter results into issuance-scale projections for target subsidy bands.",
    "- Reports lowest Bronze premium per band under two views: any scale and realistic scale.",
    "- Adds production metrics: projected loss ratio, underwriting margin, subsidy coverage, treasury coverage ratio, and subsidy-to-PnL ratio.",
    "",
    "## Files",
    `- JSON: \`${outJsonPath}\``,
    `- Projections CSV: \`${outProjectionCsvPath}\``,
    `- Recommendations CSV: \`${outSelectionCsvPath}\``
  ].join("\n");
  await writeFile(outOverviewMdPath, `${overview}\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        status: "ok",
        files: {
          bandTargetsJson: outJsonPath,
          bandProjectionsCsv: outProjectionCsvPath,
          bandRecommendationsCsv: outSelectionCsvPath,
          bandOverviewMd: outOverviewMdPath
        },
        selectionRows: selectionRows.length,
        projectionRows: projectionRows.length
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
        reason: "pilot_backtest_band_targets_failed",
        message: String(error?.message || error || "unknown_error")
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});

