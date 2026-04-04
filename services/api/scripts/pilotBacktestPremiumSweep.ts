import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import Decimal from "decimal.js";

type Regime = "stress" | "calm" | "mixed";
type PeriodProfile = "legacy" | "consistent_core" | "rolling_12m" | "rolling_24m" | "last_qtr";

type PeriodDef = {
  label: string;
  fromIso: string;
  toIso: string;
  regime: Regime;
};

type TierConfig = {
  tierName: string;
  drawdownFloorPct: string;
  strictPremiumPer1kProtectedUsd: string;
  hybridPremiumPer1kProtectedUsd: string;
  fallbackHedgePremiumPer1kProtectedUsd: string;
  strictHedgeRecoveryPct: string;
  hybridHedgeRecoveryPct: string;
};

type BacktestConfig = {
  name: string;
  tenorDays: number;
  entryStepHours: number;
  breachMode?: "expiry_only" | "path_min";
  takeProfit?: {
    enabled?: boolean;
    reboundPct?: string;
    decayPct?: string;
  };
  notionalsUsd: string[];
  treasury: {
    startingBalanceUsd: string;
    dailySubsidyCapUsd: string;
    perQuoteSubsidyCapPct: string;
  };
  tiers: TierConfig[];
};

type BacktestSummaryRow = {
  model: "strict" | "hybrid";
  trades: number;
  underwritingPnlTotalUsd: string;
  subsidyNeedTotalUsd: string;
  subsidyAppliedTotalUsd: string;
  subsidyBlockedTotalUsd: string;
  triggerHitRatePct: string;
  endTreasuryBalanceUsd: string;
};

type ExecutiveRiskRow = {
  model: "strict" | "hybrid";
  worstDaySubsidyNeedUsd: string;
  worstDaySubsidyNeedDate: string | null;
  maxDrawdownUsd: string;
  maxDrawdownPct: string;
  recommendedMinTreasuryBufferUsd: string;
};

type BacktestOutput = {
  status: "ok";
  summary: BacktestSummaryRow[];
  executiveRisk: ExecutiveRiskRow[];
};

type Args = {
  configPath: string;
  outDir: string;
  source: "auto" | "binance" | "coingecko" | "coinbase";
  tierName: string;
  bronzeGrid: Decimal[];
  notionalsUsd: string[];
  treasuryStartingBalanceUsd: Decimal | null;
  treasuryDailySubsidyCapUsd: Decimal | null;
  treasuryPerQuoteSubsidyCapPct: Decimal | null;
  stressMaxUsd: Decimal;
  stressTargetMinUsd: Decimal;
  decisionRequireNoBlockedSubsidy: boolean;
  skipFetch: boolean;
  periodProfile: PeriodProfile;
  asOfIso: string | null;
  periodLabels: string[] | null;
};

type PeriodRow = {
  bronzePremiumPer1kUsd: string;
  periodLabel: string;
  periodRegime: Regime;
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
  passesStressMaxUsd: boolean;
  inTargetStressBandUsd: boolean;
  hasAnyBlockedSubsidy: boolean;
  decisionTag: "acceptable" | "risky";
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
  projectedWorstStressQuarterSubsidyNeedUsd: string;
  projectedStressCombinedSubsidyNeedUsd: string;
  projectedRolling12mUnderwritingPnlUsd: string;
  projectedRolling12mSubsidyNeedUsd: string;
  projectedRolling12mSubsidyBlockedUsd: string;
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

type BandSelection = {
  bandLabel: string;
  lowestBronzeAny: BandProjectionRow | null;
  lowestBronzeRealistic: BandProjectionRow | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const buildRollingPeriod = (label: string, toMs: number, days: number): PeriodDef => {
  const fromMs = toMs - days * DAY_MS;
  return {
    label,
    fromIso: new Date(fromMs).toISOString(),
    toIso: new Date(toMs).toISOString(),
    regime: "mixed"
  };
};

const startOfQuarterUtc = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), Math.floor(date.getUTCMonth() / 3) * 3, 1, 0, 0, 0, 0));

const buildLastCompletedQuarterPeriod = (asOf: Date): PeriodDef => {
  const quarterStart = startOfQuarterUtc(asOf);
  const lastQuarterEnd = quarterStart;
  const lastQuarterStart = new Date(lastQuarterEnd.getTime());
  lastQuarterStart.setUTCMonth(lastQuarterStart.getUTCMonth() - 3);
  return {
    label: "last_qtr",
    fromIso: lastQuarterStart.toISOString(),
    toIso: lastQuarterEnd.toISOString(),
    regime: "mixed"
  };
};

const LEGACY_PERIODS = (toMs: number): PeriodDef[] => [
  { label: "q2_2022", fromIso: "2022-04-01T00:00:00Z", toIso: "2022-07-01T00:00:00Z", regime: "stress" },
  { label: "q4_2022", fromIso: "2022-10-01T00:00:00Z", toIso: "2023-01-01T00:00:00Z", regime: "stress" },
  { label: "q1_2023", fromIso: "2023-01-01T00:00:00Z", toIso: "2023-04-01T00:00:00Z", regime: "calm" },
  { label: "q1_2024", fromIso: "2024-01-01T00:00:00Z", toIso: "2024-04-01T00:00:00Z", regime: "calm" },
  buildRollingPeriod("rolling_12m", toMs, 365)
];

const parseAsOf = (raw: string | null): Date => {
  const value = String(raw || "").trim();
  if (!value) return new Date();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`invalid_as_of:${value}`);
  return parsed;
};

const resolvePeriodProfilePeriods = (profile: PeriodProfile, asOf: Date): PeriodDef[] => {
  const toMs = asOf.getTime();
  if (profile === "rolling_12m") return [buildRollingPeriod("rolling_12m", toMs, 365)];
  if (profile === "rolling_24m") return [buildRollingPeriod("rolling_24m", toMs, 730)];
  if (profile === "last_qtr") return [buildLastCompletedQuarterPeriod(asOf)];
  if (profile === "consistent_core") {
    return [
      buildLastCompletedQuarterPeriod(asOf),
      buildRollingPeriod("rolling_12m", toMs, 365),
      buildRollingPeriod("rolling_24m", toMs, 730)
    ];
  }
  return LEGACY_PERIODS(toMs);
};

const toDecimal = (value: string | number | null | undefined): Decimal => {
  try {
    return new Decimal(String(value ?? "0"));
  } catch {
    return new Decimal(0);
  }
};

const toFixed = (value: Decimal, dp = 10): string => value.toFixed(dp);

const parseBool = (raw: string | undefined, fallback: boolean): boolean => {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return fallback;
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  return fallback;
};

const parseGrid = (raw: string | undefined, fallback: string): Decimal[] => {
  const out = String(raw || fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => toDecimal(item))
    .filter((value) => value.gt(0));
  if (!out.length) throw new Error("invalid_bronze_grid");
  const dedup = new Map<string, Decimal>();
  for (const item of out) dedup.set(item.toFixed(4), item);
  return Array.from(dedup.values()).sort((a, b) => a.minus(b).toNumber());
};

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    configPath: "scripts/fixtures/pilot_backtest_config.example.json",
    outDir: "artifacts/desktop/premium_sweep",
    source: "coinbase",
    tierName: "Pro (Bronze)",
    bronzeGrid: parseGrid(undefined, "20,21,22,23,24,25"),
    notionalsUsd: ["1000"],
    treasuryStartingBalanceUsd: null,
    treasuryDailySubsidyCapUsd: null,
    treasuryPerQuoteSubsidyCapPct: null,
    stressMaxUsd: new Decimal("500000"),
    stressTargetMinUsd: new Decimal("400000"),
    decisionRequireNoBlockedSubsidy: false,
    skipFetch: false,
    periodProfile: "legacy",
    asOfIso: null,
    periodLabels: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--config" && argv[i + 1]) {
      args.configPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--out-dir" && argv[i + 1]) {
      args.outDir = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--source" && argv[i + 1]) {
      const source = String(argv[i + 1]).trim().toLowerCase();
      if (source === "auto" || source === "binance" || source === "coingecko" || source === "coinbase") {
        args.source = source;
      } else {
        throw new Error(`invalid_source:${source}`);
      }
      i += 1;
      continue;
    }
    if (token === "--tier-name" && argv[i + 1]) {
      args.tierName = String(argv[i + 1]).trim() || "Pro (Bronze)";
      i += 1;
      continue;
    }
    if (token === "--bronze-grid" && argv[i + 1]) {
      args.bronzeGrid = parseGrid(argv[i + 1], "20,21,22,23,24,25");
      i += 1;
      continue;
    }
    if (token === "--notionals" && argv[i + 1]) {
      const items = String(argv[i + 1])
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      if (!items.length) throw new Error("invalid_notionals");
      for (const item of items) {
        if (toDecimal(item).lte(0)) throw new Error(`invalid_notional_value:${item}`);
      }
      args.notionalsUsd = items;
      i += 1;
      continue;
    }
    if (token === "--treasury-starting-balance-usd" && argv[i + 1]) {
      const value = toDecimal(argv[i + 1]);
      if (value.lte(0)) throw new Error("invalid_treasury_starting_balance_usd");
      args.treasuryStartingBalanceUsd = value;
      i += 1;
      continue;
    }
    if (token === "--treasury-daily-subsidy-cap-usd" && argv[i + 1]) {
      const value = toDecimal(argv[i + 1]);
      if (value.lte(0)) throw new Error("invalid_treasury_daily_subsidy_cap_usd");
      args.treasuryDailySubsidyCapUsd = value;
      i += 1;
      continue;
    }
    if (token === "--treasury-per-quote-subsidy-cap-pct" && argv[i + 1]) {
      const value = toDecimal(argv[i + 1]);
      if (value.lt(0) || value.gt(1)) throw new Error("invalid_treasury_per_quote_subsidy_cap_pct");
      args.treasuryPerQuoteSubsidyCapPct = value;
      i += 1;
      continue;
    }
    if (token === "--stress-max-usd" && argv[i + 1]) {
      args.stressMaxUsd = toDecimal(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === "--stress-target-min-usd" && argv[i + 1]) {
      args.stressTargetMinUsd = toDecimal(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === "--skip-fetch" && argv[i + 1]) {
      args.skipFetch = parseBool(argv[i + 1], false);
      i += 1;
      continue;
    }
    if (token === "--period-profile" && argv[i + 1]) {
      const profile = String(argv[i + 1]).trim().toLowerCase();
      if (
        profile === "legacy" ||
        profile === "consistent_core" ||
        profile === "rolling_12m" ||
        profile === "rolling_24m" ||
        profile === "last_qtr"
      ) {
        args.periodProfile = profile;
      } else {
        throw new Error(`invalid_period_profile:${profile}`);
      }
      i += 1;
      continue;
    }
    if (token === "--as-of" && argv[i + 1]) {
      args.asOfIso = String(argv[i + 1]).trim() || null;
      i += 1;
      continue;
    }
    if (token === "--decision-require-no-blocked-subsidy" && argv[i + 1]) {
      args.decisionRequireNoBlockedSubsidy = parseBool(argv[i + 1], false);
      i += 1;
      continue;
    }
    if (token === "--periods" && argv[i + 1]) {
      args.periodLabels = String(argv[i + 1])
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      i += 1;
      continue;
    }
  }
  if (args.stressMaxUsd.lte(0)) throw new Error("invalid_stress_max_usd");
  if (args.stressTargetMinUsd.lt(0)) throw new Error("invalid_stress_target_min_usd");
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

const sumDecimals = (items: Decimal[]): Decimal => items.reduce((acc, cur) => acc.plus(cur), new Decimal(0));

const maxDecimal = (items: Decimal[]): Decimal =>
  items.reduce((acc, cur) => (cur.gt(acc) ? cur : acc), new Decimal(0));

const absDecimal = (value: Decimal): Decimal => (value.lt(0) ? value.negated() : value);

const runCommand = (command: string, args: string[], cwd: string) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`command_failed:${command}:${args.join(" ")}:exit_${code}`));
    });
  });

const fileExists = async (targetPath: string): Promise<boolean> => {
  try {
    await fs.access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const resolvePeriodDays = (period: Pick<PeriodRow, "fromIso" | "toIso">): number => {
  const fromMs = Date.parse(period.fromIso);
  const toMs = Date.parse(period.toIso);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return 1;
  return Math.max(1, Math.round((toMs - fromMs) / DAY_MS));
};

const slugifyTierName = (tierName: string): string =>
  String(tierName || "tier")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "tier";

const ensureSingleTierConfig = (
  baseConfig: BacktestConfig,
  bronzePremiumPer1k: Decimal,
  selectedTierName: string,
  overrides: {
    notionalsUsd: string[];
    treasuryStartingBalanceUsd: Decimal | null;
    treasuryDailySubsidyCapUsd: Decimal | null;
    treasuryPerQuoteSubsidyCapPct: Decimal | null;
  }
): BacktestConfig => {
  const targetTier = (baseConfig.tiers || []).find((tier) => String(tier.tierName || "").trim() === selectedTierName);
  if (!targetTier) {
    throw new Error(`tier_missing_in_config:${selectedTierName}`);
  }
  const notionals = Array.from(new Set(overrides.notionalsUsd.map((item) => String(item || "").trim()).filter(Boolean)));
  if (!notionals.length) throw new Error("no_notionals_configured");
  const tierSlug = slugifyTierName(selectedTierName);
  return {
    ...baseConfig,
    name: `${baseConfig.name || "pilot_backtest"}_${tierSlug}_${bronzePremiumPer1k.toFixed(2)}_tp_off`,
    notionalsUsd: notionals,
    takeProfit: {
      enabled: false,
      reboundPct: String(baseConfig.takeProfit?.reboundPct || "2.0"),
      decayPct: String(baseConfig.takeProfit?.decayPct || "30.0")
    },
    treasury: {
      startingBalanceUsd:
        overrides.treasuryStartingBalanceUsd?.toFixed(2) ||
        String(baseConfig.treasury?.startingBalanceUsd || "25000"),
      dailySubsidyCapUsd:
        overrides.treasuryDailySubsidyCapUsd?.toFixed(2) ||
        String(baseConfig.treasury?.dailySubsidyCapUsd || "15000"),
      perQuoteSubsidyCapPct:
        overrides.treasuryPerQuoteSubsidyCapPct?.toFixed(6) ||
        String(baseConfig.treasury?.perQuoteSubsidyCapPct || "0.7")
    },
    tiers: [
      {
        ...targetTier,
        hybridPremiumPer1kProtectedUsd: bronzePremiumPer1k.toFixed(2)
      }
    ]
  };
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const asOf = parseAsOf(args.asOfIso);
  const periods = resolvePeriodProfilePeriods(args.periodProfile, asOf);
  const selectedPeriods = args.periodLabels ? periods.filter((p) => args.periodLabels!.includes(p.label)) : periods;
  if (!selectedPeriods.length) throw new Error("no_periods_selected");

  const outDir = args.outDir;
  const tierSlug = slugifyTierName(args.tierName);
  const runsDir = path.join(outDir, "runs");
  const pricesDir = path.join(outDir, "prices");
  const configsDir = path.join(outDir, "configs");
  await mkdir(runsDir, { recursive: true });
  await mkdir(pricesDir, { recursive: true });
  await mkdir(configsDir, { recursive: true });

  const rawConfig = await readFile(args.configPath, "utf8");
  const baseConfig = JSON.parse(rawConfig) as BacktestConfig;

  for (const period of selectedPeriods) {
    const priceCsv = path.join(pricesDir, `btc_usd_${period.label}_1h.csv`);
    const shouldFetch = !args.skipFetch || !(await fileExists(priceCsv));
    if (!shouldFetch) continue;
    await runCommand(
      "npm",
      [
        "run",
        "-s",
        "pilot:backtest:fetch-btc",
        "--",
        "--from",
        period.fromIso,
        "--to",
        period.toIso,
        "--source",
        args.source,
        "--out-csv",
        priceCsv
      ],
      cwd
    );
  }

  const periodRows: PeriodRow[] = [];
  for (const bronzePremiumPer1k of args.bronzeGrid) {
    const scenarioLabel = `${tierSlug}_${bronzePremiumPer1k.toFixed(2).replace(".", "_")}`;
    const scenarioDir = path.join(runsDir, scenarioLabel);
    await mkdir(scenarioDir, { recursive: true });
    const scenarioConfig = ensureSingleTierConfig(baseConfig, bronzePremiumPer1k, args.tierName, {
      notionalsUsd: args.notionalsUsd,
      treasuryStartingBalanceUsd: args.treasuryStartingBalanceUsd,
      treasuryDailySubsidyCapUsd: args.treasuryDailySubsidyCapUsd,
      treasuryPerQuoteSubsidyCapPct: args.treasuryPerQuoteSubsidyCapPct
    });
    const scenarioConfigPath = path.join(configsDir, `backtest_config_${scenarioLabel}.json`);
    await writeFile(scenarioConfigPath, `${JSON.stringify(scenarioConfig, null, 2)}\n`, "utf8");

    for (const period of selectedPeriods) {
      const outJson = path.join(scenarioDir, `pilot_backtest_${period.label}.json`);
      const outCsv = path.join(scenarioDir, `pilot_backtest_${period.label}.csv`);
      const pricesCsv = path.join(pricesDir, `btc_usd_${period.label}_1h.csv`);
      await runCommand(
        "npm",
        [
          "run",
          "-s",
          "pilot:backtest:run",
          "--",
          "--config",
          scenarioConfigPath,
          "--prices-csv",
          pricesCsv,
          "--mode",
          "hybrid_only",
          "--tp-enabled",
          "false",
          "--out-json",
          outJson,
          "--out-csv",
          outCsv
        ],
        cwd
      );

      const parsed = JSON.parse(await readFile(outJson, "utf8")) as BacktestOutput;
      const summary = (parsed.summary || []).find((row) => row.model === "hybrid");
      const risk = (parsed.executiveRisk || []).find((row) => row.model === "hybrid");
      if (!summary || !risk) {
        throw new Error(`hybrid_summary_or_risk_missing:${scenarioLabel}:${period.label}`);
      }
      periodRows.push({
        bronzePremiumPer1kUsd: bronzePremiumPer1k.toFixed(2),
        periodLabel: period.label,
        periodRegime: period.regime,
        fromIso: period.fromIso,
        toIso: period.toIso,
        trades: Number(summary.trades || 0),
        underwritingPnlTotalUsd: summary.underwritingPnlTotalUsd,
        subsidyNeedTotalUsd: summary.subsidyNeedTotalUsd,
        subsidyAppliedTotalUsd: summary.subsidyAppliedTotalUsd,
        subsidyBlockedTotalUsd: summary.subsidyBlockedTotalUsd,
        triggerHitRatePct: summary.triggerHitRatePct,
        endTreasuryBalanceUsd: summary.endTreasuryBalanceUsd,
        worstDaySubsidyNeedUsd: risk.worstDaySubsidyNeedUsd,
        worstDaySubsidyNeedDate: String(risk.worstDaySubsidyNeedDate || ""),
        maxDrawdownUsd: risk.maxDrawdownUsd,
        maxDrawdownPct: risk.maxDrawdownPct,
        recommendedMinTreasuryBufferUsd: risk.recommendedMinTreasuryBufferUsd
      });
    }
  }

  const candidateRows: CandidateRow[] = [];
  for (const bronzePremiumPer1k of args.bronzeGrid) {
    const premium = bronzePremiumPer1k.toFixed(2);
    const rows = periodRows.filter((row) => row.bronzePremiumPer1kUsd === premium);
    const stressRows = rows.filter((row) => row.periodRegime === "stress");
    const calmRows = rows.filter((row) => row.periodRegime === "calm");
    const rolling = rows.find((row) => row.periodLabel === "rolling_12m");

    const stressSubsidyNeedTotalUsd = sumDecimals(stressRows.map((row) => toDecimal(row.subsidyNeedTotalUsd)));
    const stressSubsidyAppliedTotalUsd = sumDecimals(stressRows.map((row) => toDecimal(row.subsidyAppliedTotalUsd)));
    const stressSubsidyBlockedTotalUsd = sumDecimals(stressRows.map((row) => toDecimal(row.subsidyBlockedTotalUsd)));
    const stressWorstDaySubsidyNeedUsd = maxDecimal(stressRows.map((row) => toDecimal(row.worstDaySubsidyNeedUsd)));
    const stressWorstRecommendedMinBufferUsd = maxDecimal(
      stressRows.map((row) => toDecimal(row.recommendedMinTreasuryBufferUsd))
    );

    const calmUnderwritingPnlTotalUsd = sumDecimals(calmRows.map((row) => toDecimal(row.underwritingPnlTotalUsd)));
    const calmSubsidyNeedTotalUsd = sumDecimals(calmRows.map((row) => toDecimal(row.subsidyNeedTotalUsd)));

    const rolling12mUnderwritingPnlTotalUsd = toDecimal(rolling?.underwritingPnlTotalUsd || "0");
    const rolling12mSubsidyNeedTotalUsd = toDecimal(rolling?.subsidyNeedTotalUsd || "0");
    const rolling12mSubsidyBlockedTotalUsd = toDecimal(rolling?.subsidyBlockedTotalUsd || "0");
    const rolling12mRecommendedMinBufferUsd = toDecimal(rolling?.recommendedMinTreasuryBufferUsd || "0");

    const passesStressMaxUsd = stressSubsidyNeedTotalUsd.lte(args.stressMaxUsd);
    const inTargetStressBandUsd =
      stressSubsidyNeedTotalUsd.gte(args.stressTargetMinUsd) && stressSubsidyNeedTotalUsd.lte(args.stressMaxUsd);
    const hasAnyBlockedSubsidy = stressSubsidyBlockedTotalUsd.gt(0) || rolling12mSubsidyBlockedTotalUsd.gt(0);
    const noBlockedCheck = args.decisionRequireNoBlockedSubsidy ? !hasAnyBlockedSubsidy : true;
    const decisionTag: CandidateRow["decisionTag"] = passesStressMaxUsd && noBlockedCheck ? "acceptable" : "risky";

    candidateRows.push({
      bronzePremiumPer1kUsd: premium,
      stressSubsidyNeedTotalUsd: toFixed(stressSubsidyNeedTotalUsd),
      stressSubsidyAppliedTotalUsd: toFixed(stressSubsidyAppliedTotalUsd),
      stressSubsidyBlockedTotalUsd: toFixed(stressSubsidyBlockedTotalUsd),
      stressWorstDaySubsidyNeedUsd: toFixed(stressWorstDaySubsidyNeedUsd),
      stressWorstRecommendedMinBufferUsd: toFixed(stressWorstRecommendedMinBufferUsd),
      calmUnderwritingPnlTotalUsd: toFixed(calmUnderwritingPnlTotalUsd),
      calmSubsidyNeedTotalUsd: toFixed(calmSubsidyNeedTotalUsd),
      rolling12mUnderwritingPnlTotalUsd: toFixed(rolling12mUnderwritingPnlTotalUsd),
      rolling12mSubsidyNeedTotalUsd: toFixed(rolling12mSubsidyNeedTotalUsd),
      rolling12mSubsidyBlockedTotalUsd: toFixed(rolling12mSubsidyBlockedTotalUsd),
      rolling12mRecommendedMinBufferUsd: toFixed(rolling12mRecommendedMinBufferUsd),
      passesStressMaxUsd,
      inTargetStressBandUsd,
      hasAnyBlockedSubsidy,
      decisionTag
    });
  }

  candidateRows.sort((a, b) => {
    if (a.decisionTag !== b.decisionTag) return a.decisionTag === "acceptable" ? -1 : 1;
    return toDecimal(a.bronzePremiumPer1kUsd).minus(toDecimal(b.bronzePremiumPer1kUsd)).toNumber();
  });

  const recommended = candidateRows[0] || null;
  const assumptions = {
    source: args.source,
    tierName: args.tierName,
    tpEnabledForced: false,
    modelMode: "hybrid_only",
    notionalsUsd: args.notionalsUsd,
    treasuryStartingBalanceUsd:
      args.treasuryStartingBalanceUsd?.toFixed(2) || String(baseConfig.treasury?.startingBalanceUsd || ""),
    treasuryDailySubsidyCapUsd:
      args.treasuryDailySubsidyCapUsd?.toFixed(2) || String(baseConfig.treasury?.dailySubsidyCapUsd || ""),
    treasuryPerQuoteSubsidyCapPct:
      args.treasuryPerQuoteSubsidyCapPct?.toFixed(6) || String(baseConfig.treasury?.perQuoteSubsidyCapPct || ""),
    decisionRequireNoBlockedSubsidy: args.decisionRequireNoBlockedSubsidy,
    stressTargetMinUsd: args.stressTargetMinUsd.toFixed(2),
    stressMaxUsd: args.stressMaxUsd.toFixed(2),
    periodProfile: args.periodProfile,
    asOfIso: asOf.toISOString(),
    periods: selectedPeriods
  };

  const outJsonPath = path.join(outDir, "premium_sweep_results.json");
  const outCandidateCsvPath = path.join(outDir, "premium_sweep_candidate_summary.csv");
  const outPeriodCsvPath = path.join(outDir, "premium_sweep_period_detail.csv");
  const outOverviewMdPath = path.join(outDir, "premium_sweep_overview.md");

  await writeFile(
    outJsonPath,
    `${JSON.stringify({ status: "ok", generatedAtIso: new Date().toISOString(), assumptions, recommended, candidateRows, periodRows }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    outCandidateCsvPath,
    rowsToCsv(candidateRows as unknown as Array<Record<string, string | number | boolean>>),
    "utf8"
  );
  await writeFile(
    outPeriodCsvPath,
    rowsToCsv(periodRows as unknown as Array<Record<string, string | number | boolean>>),
    "utf8"
  );

  const overview = [
    "# Premium sweep overview (TP OFF)",
    "",
    "## Objective",
    `- Evaluate Bronze hybrid premium-per-$1k grid and find the lowest value that keeps severe-quarter treasury stress under ${args.stressMaxUsd.toFixed(2)} USD.`,
    `- Stress target band interpreted as ${args.stressTargetMinUsd.toFixed(2)} to ${args.stressMaxUsd.toFixed(2)} USD total subsidy need across stress periods.`,
    "",
    "## Plain-language readout",
    recommended
      ? `- Recommended current candidate: **Bronze ${recommended.bronzePremiumPer1kUsd} USD per $1k** (tag=${recommended.decisionTag}, stressSubsidyNeed=${recommended.stressSubsidyNeedTotalUsd}, blocked=${recommended.stressSubsidyBlockedTotalUsd}).`
      : "- No recommendation available (no candidate rows).",
    `- \`decisionTag=acceptable\` means stress cap passed${args.decisionRequireNoBlockedSubsidy ? " and blocked subsidy remained zero." : "."}`,
    `- \`decisionTag=risky\` means stress cap breached${args.decisionRequireNoBlockedSubsidy ? " or blocked subsidy appeared." : "."}`,
    "",
    "## Files",
    `- JSON: \`${outJsonPath}\``,
    `- Candidate summary CSV: \`${outCandidateCsvPath}\``,
    `- Period detail CSV: \`${outPeriodCsvPath}\``
  ].join("\n");
  await writeFile(outOverviewMdPath, `${overview}\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        status: "ok",
        outDir,
        files: {
          resultsJson: outJsonPath,
          candidateSummaryCsv: outCandidateCsvPath,
          periodDetailCsv: outPeriodCsvPath,
          overviewMd: outOverviewMdPath
        },
        recommended,
        candidateCount: candidateRows.length
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
        reason: "pilot_backtest_premium_sweep_failed",
        message: String(error?.message || error || "unknown_error")
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
