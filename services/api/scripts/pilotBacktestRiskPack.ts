import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Decimal from "decimal.js";
import * as XLSX from "xlsx";

type ModelName = "strict" | "hybrid";

type BacktestTradeRow = {
  model: ModelName;
  breachMode: "expiry_only" | "path_min";
  entryTsIso: string;
  expiryPriceUsd: string;
  triggerPriceUsd: string;
  pathMinPriceUsd: string;
  breachObserved: boolean;
  premiumUsd: string;
  payoutUsd: string;
  subsidyNeedUsd: string;
  subsidyAppliedUsd: string;
  subsidyBlockedUsd: string;
  underwritingPnlUsd: string;
  hedgeNetCostUsd: string;
  treasuryBalanceAfterUsd: string;
};

type BacktestSummaryRow = {
  model: ModelName;
  breachMode: "expiry_only" | "path_min";
  trades: number;
  premiumTotalUsd: string;
  payoutTotalUsd: string;
  hedgeNetCostTotalUsd: string;
  underwritingPnlTotalUsd: string;
  subsidyNeedTotalUsd: string;
  subsidyAppliedTotalUsd: string;
  subsidyBlockedTotalUsd: string;
  triggerHitRatePct: string;
  endTreasuryBalanceUsd: string;
};

type ExecutiveRiskRow = {
  model: ModelName;
  breachMode: "expiry_only" | "path_min";
  trades: number;
  losingTradeCount: number;
  losingTradeRatePct: string;
  worstDaySubsidyNeedUsd: string;
  worstDaySubsidyNeedDate: string | null;
  lossP95PerTradeUsd: string;
  maxDrawdownUsd: string;
  maxDrawdownPct: string;
  recommendedMinTreasuryBufferUsd: string;
  recommendedBufferFormula: string;
};

type BacktestOutput = {
  status: "ok";
  name: string;
  breachMode: "expiry_only" | "path_min";
  treasury?: {
    startingBalanceUsd: string;
    dailySubsidyCapUsd: string;
    perQuoteSubsidyCapPct: string;
  };
  summary: BacktestSummaryRow[];
  executiveRisk?: ExecutiveRiskRow[];
  rows: BacktestTradeRow[];
};

type Args = {
  inputPaths: string[];
  outDir: string;
  rollingDays: number;
  fallbackTriggerHitRatePct: number;
  pauseTriggerHitRatePct: number;
  fallbackSubsidyUtilizationPct: number;
  pauseSubsidyUtilizationPct: number;
  fallbackDrawdownPct: number;
  pauseDrawdownPct: number;
  pauseWhenSubsidyBlocked: boolean;
  takeProfitReboundPct: number;
  outXlsxPath: string | null;
};

type DailyAgg = {
  period: string;
  model: ModelName;
  breachMode: "expiry_only" | "path_min";
  day: string;
  trades: number;
  triggers: number;
  premiumUsd: Decimal;
  payoutUsd: Decimal;
  subsidyNeedUsd: Decimal;
  subsidyAppliedUsd: Decimal;
  subsidyBlockedUsd: Decimal;
  treasuryEndBalanceUsd: Decimal;
  triggerHitRatePct: Decimal;
  rollingTriggerHitRatePct: Decimal;
  dailySubsidyUtilizationPct: Decimal;
  drawdownUsd: Decimal;
  drawdownPct: Decimal;
  fallbackFlag: boolean;
  pauseFlag: boolean;
  recommendedAction: "normal_hybrid_ok" | "strict_fallback" | "issuance_pause";
};

type SummaryCsvRow = {
  period: string;
  model: ModelName;
  breachMode: string;
  trades: number;
  premiumTotalUsd: string;
  payoutTotalUsd: string;
  hedgeNetCostTotalUsd: string;
  underwritingPnlTotalUsd: string;
  pnlMarginPct: string;
  subsidyNeedTotalUsd: string;
  subsidyAppliedTotalUsd: string;
  subsidyBlockedTotalUsd: string;
  triggerHitRatePct: string;
  worstDaySubsidyNeedUsd: string;
  worstDaySubsidyNeedDate: string;
  lossP95PerTradeUsd: string;
  maxDrawdownUsd: string;
  maxDrawdownPct: string;
  maxDailySubsidyUtilizationPct: string;
  fallbackDays: number;
  pauseDays: number;
  firstPauseDate: string;
  endTreasuryBalanceUsd: string;
  treasuryConsumptionUsd: string;
  treasuryConsumptionPct: string;
  recommendedMinTreasuryBufferUsd: string;
  recommendedBufferFormula: string;
};

type BreachReboundCsvRow = {
  period: string;
  model: ModelName;
  breachMode: string;
  breachedTrades: number;
  breachThenReboundCount: number;
  breachRecoveredAboveTriggerCount: number;
  breachStillBelowTriggerCount: number;
  takeProfitOpportunityCount: number;
  takeProfitOpportunityRatePct: string;
  meanReboundFromPathMinPct: string;
  p95ReboundFromPathMinPct: string;
  meanStillBelowTriggerPct: string;
};

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    inputPaths: [],
    outDir: "artifacts/backtest/risk-pack",
    rollingDays: 7,
    fallbackTriggerHitRatePct: 8,
    pauseTriggerHitRatePct: 15,
    fallbackSubsidyUtilizationPct: 50,
    pauseSubsidyUtilizationPct: 85,
    fallbackDrawdownPct: 25,
    pauseDrawdownPct: 50,
    pauseWhenSubsidyBlocked: true,
    takeProfitReboundPct: 2,
    outXlsxPath: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--input" && argv[i + 1]) {
      args.inputPaths.push(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === "--inputs" && argv[i + 1]) {
      const list = String(argv[i + 1])
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      args.inputPaths.push(...list);
      i += 1;
      continue;
    }
    if (token === "--out-dir" && argv[i + 1]) {
      args.outDir = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--rolling-days" && argv[i + 1]) {
      args.rollingDays = Math.max(1, Math.floor(Number(argv[i + 1]) || 7));
      i += 1;
      continue;
    }
    if (token === "--fallback-trigger-hit-rate-pct" && argv[i + 1]) {
      args.fallbackTriggerHitRatePct = Number(argv[i + 1]) || args.fallbackTriggerHitRatePct;
      i += 1;
      continue;
    }
    if (token === "--pause-trigger-hit-rate-pct" && argv[i + 1]) {
      args.pauseTriggerHitRatePct = Number(argv[i + 1]) || args.pauseTriggerHitRatePct;
      i += 1;
      continue;
    }
    if (token === "--fallback-subsidy-utilization-pct" && argv[i + 1]) {
      args.fallbackSubsidyUtilizationPct = Number(argv[i + 1]) || args.fallbackSubsidyUtilizationPct;
      i += 1;
      continue;
    }
    if (token === "--pause-subsidy-utilization-pct" && argv[i + 1]) {
      args.pauseSubsidyUtilizationPct = Number(argv[i + 1]) || args.pauseSubsidyUtilizationPct;
      i += 1;
      continue;
    }
    if (token === "--fallback-drawdown-pct" && argv[i + 1]) {
      args.fallbackDrawdownPct = Number(argv[i + 1]) || args.fallbackDrawdownPct;
      i += 1;
      continue;
    }
    if (token === "--pause-drawdown-pct" && argv[i + 1]) {
      args.pauseDrawdownPct = Number(argv[i + 1]) || args.pauseDrawdownPct;
      i += 1;
      continue;
    }
    if (token === "--pause-when-subsidy-blocked" && argv[i + 1]) {
      args.pauseWhenSubsidyBlocked = String(argv[i + 1]).trim().toLowerCase() !== "false";
      i += 1;
      continue;
    }
    if (token === "--take-profit-rebound-pct" && argv[i + 1]) {
      args.takeProfitReboundPct = Number(argv[i + 1]) || args.takeProfitReboundPct;
      i += 1;
      continue;
    }
    if (token === "--out-xlsx" && argv[i + 1]) {
      args.outXlsxPath = argv[i + 1];
      i += 1;
      continue;
    }
  }
  args.inputPaths = Array.from(new Set(args.inputPaths));
  if (!args.inputPaths.length) {
    throw new Error("risk_pack_requires_input_paths");
  }
  return args;
};

const toDecimal = (value: string | number | boolean | null | undefined): Decimal => {
  try {
    return new Decimal(String(value ?? "0"));
  } catch {
    return new Decimal(0);
  }
};

const toFixed = (value: Decimal, dp = 10): string => value.toFixed(dp);

const percentile = (items: Decimal[], p: number): Decimal => {
  if (!items.length) return new Decimal(0);
  const sorted = items.slice().sort((a, b) => a.comparedTo(b));
  const clamped = Math.max(0, Math.min(1, p));
  const rank = Math.ceil(clamped * sorted.length) - 1;
  const idx = Math.max(0, Math.min(sorted.length - 1, rank));
  return sorted[idx];
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
    const values = headers.map((key) => escapeCsv(String(row[key] ?? "")));
    lines.push(values.join(","));
  }
  return `${lines.join("\n")}\n`;
};

const rowsToSheet = (rows: Array<Record<string, string | number | boolean>>) => XLSX.utils.json_to_sheet(rows);

const writeWorkbook = (params: {
  outPath: string;
  summaryRows: SummaryCsvRow[];
  dailyRows: Array<Record<string, string | number | boolean>>;
  reboundRows: BreachReboundCsvRow[];
}) => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    rowsToSheet(params.summaryRows as unknown as Array<Record<string, string | number | boolean>>),
    "summary"
  );
  XLSX.utils.book_append_sheet(workbook, rowsToSheet(params.dailyRows), "daily");
  XLSX.utils.book_append_sheet(
    workbook,
    rowsToSheet(params.reboundRows as unknown as Array<Record<string, string | number | boolean>>),
    "breach_rebound"
  );
  XLSX.writeFile(workbook, params.outPath);
};

const periodFromPath = (filePath: string): string => path.basename(filePath, path.extname(filePath));

const buildDailyAgg = (params: {
  period: string;
  model: ModelName;
  breachMode: "expiry_only" | "path_min";
  rows: BacktestTradeRow[];
  startingTreasury: Decimal;
  dailyCap: Decimal;
  args: Args;
}): DailyAgg[] => {
  const grouped = new Map<string, DailyAgg>();
  for (const row of params.rows) {
    const day = row.entryTsIso.slice(0, 10);
    const existing = grouped.get(day);
    if (!existing) {
      grouped.set(day, {
        period: params.period,
        model: params.model,
        breachMode: params.breachMode,
        day,
        trades: 0,
        triggers: 0,
        premiumUsd: new Decimal(0),
        payoutUsd: new Decimal(0),
        subsidyNeedUsd: new Decimal(0),
        subsidyAppliedUsd: new Decimal(0),
        subsidyBlockedUsd: new Decimal(0),
        treasuryEndBalanceUsd: toDecimal(row.treasuryBalanceAfterUsd),
        triggerHitRatePct: new Decimal(0),
        rollingTriggerHitRatePct: new Decimal(0),
        dailySubsidyUtilizationPct: new Decimal(0),
        drawdownUsd: new Decimal(0),
        drawdownPct: new Decimal(0),
        fallbackFlag: false,
        pauseFlag: false,
        recommendedAction: "normal_hybrid_ok"
      });
    }
    const agg = grouped.get(day)!;
    agg.trades += 1;
    if (row.breachObserved) agg.triggers += 1;
    agg.premiumUsd = agg.premiumUsd.plus(toDecimal(row.premiumUsd));
    agg.payoutUsd = agg.payoutUsd.plus(toDecimal(row.payoutUsd));
    agg.subsidyNeedUsd = agg.subsidyNeedUsd.plus(toDecimal(row.subsidyNeedUsd));
    agg.subsidyAppliedUsd = agg.subsidyAppliedUsd.plus(toDecimal(row.subsidyAppliedUsd));
    agg.subsidyBlockedUsd = agg.subsidyBlockedUsd.plus(toDecimal(row.subsidyBlockedUsd));
    agg.treasuryEndBalanceUsd = toDecimal(row.treasuryBalanceAfterUsd);
  }

  const days = Array.from(grouped.keys()).sort();
  const ordered = days.map((day) => grouped.get(day)!);

  // Rolling trigger hit rate and policy flags
  let rollingPeak = params.startingTreasury;
  for (let i = 0; i < ordered.length; i += 1) {
    const dayAgg = ordered[i];
    dayAgg.triggerHitRatePct =
      dayAgg.trades > 0 ? new Decimal(dayAgg.triggers).div(dayAgg.trades).mul(100) : new Decimal(0);
    dayAgg.dailySubsidyUtilizationPct =
      params.dailyCap.gt(0) ? dayAgg.subsidyAppliedUsd.div(params.dailyCap).mul(100) : new Decimal(0);

    const from = Math.max(0, i - params.args.rollingDays + 1);
    let rollingTrades = 0;
    let rollingTriggers = 0;
    for (let j = from; j <= i; j += 1) {
      rollingTrades += ordered[j].trades;
      rollingTriggers += ordered[j].triggers;
    }
    dayAgg.rollingTriggerHitRatePct =
      rollingTrades > 0 ? new Decimal(rollingTriggers).div(rollingTrades).mul(100) : new Decimal(0);

    if (dayAgg.treasuryEndBalanceUsd.gt(rollingPeak)) rollingPeak = dayAgg.treasuryEndBalanceUsd;
    dayAgg.drawdownUsd = rollingPeak.minus(dayAgg.treasuryEndBalanceUsd);
    dayAgg.drawdownPct = rollingPeak.gt(0) ? dayAgg.drawdownUsd.div(rollingPeak).mul(100) : new Decimal(0);

    const fallbackFlag =
      dayAgg.rollingTriggerHitRatePct.gte(params.args.fallbackTriggerHitRatePct) ||
      dayAgg.dailySubsidyUtilizationPct.gte(params.args.fallbackSubsidyUtilizationPct) ||
      dayAgg.drawdownPct.gte(params.args.fallbackDrawdownPct);
    const pauseFlag =
      dayAgg.rollingTriggerHitRatePct.gte(params.args.pauseTriggerHitRatePct) ||
      dayAgg.dailySubsidyUtilizationPct.gte(params.args.pauseSubsidyUtilizationPct) ||
      dayAgg.drawdownPct.gte(params.args.pauseDrawdownPct) ||
      (params.args.pauseWhenSubsidyBlocked && dayAgg.subsidyBlockedUsd.gt(0));
    dayAgg.fallbackFlag = fallbackFlag;
    dayAgg.pauseFlag = pauseFlag;
    dayAgg.recommendedAction = pauseFlag ? "issuance_pause" : fallbackFlag ? "strict_fallback" : "normal_hybrid_ok";
  }

  return ordered;
};

const buildBreachRebound = (params: {
  period: string;
  model: ModelName;
  breachMode: "expiry_only" | "path_min";
  rows: BacktestTradeRow[];
  takeProfitReboundPct: number;
}): BreachReboundCsvRow => {
  const breached = params.rows.filter((row) => row.breachObserved);
  const reboundPcts: Decimal[] = [];
  const stillBelowTriggerPcts: Decimal[] = [];
  let breachThenReboundCount = 0;
  let breachRecoveredAboveTriggerCount = 0;
  let breachStillBelowTriggerCount = 0;
  let takeProfitOpportunityCount = 0;

  for (const row of breached) {
    const pathMin = toDecimal(row.pathMinPriceUsd);
    const expiry = toDecimal(row.expiryPriceUsd);
    const trigger = toDecimal(row.triggerPriceUsd);
    const reboundPct = pathMin.gt(0) ? expiry.minus(pathMin).div(pathMin).mul(100) : new Decimal(0);
    reboundPcts.push(reboundPct);
    if (expiry.gt(pathMin)) breachThenReboundCount += 1;
    if (expiry.gte(trigger)) {
      breachRecoveredAboveTriggerCount += 1;
    } else {
      breachStillBelowTriggerCount += 1;
      const stillBelowPct = trigger.gt(0) ? trigger.minus(expiry).div(trigger).mul(100) : new Decimal(0);
      stillBelowTriggerPcts.push(stillBelowPct);
    }
    if (reboundPct.gte(params.takeProfitReboundPct)) takeProfitOpportunityCount += 1;
  }

  const breachedTrades = breached.length;
  return {
    period: params.period,
    model: params.model,
    breachMode: params.breachMode,
    breachedTrades,
    breachThenReboundCount,
    breachRecoveredAboveTriggerCount,
    breachStillBelowTriggerCount,
    takeProfitOpportunityCount,
    takeProfitOpportunityRatePct:
      breachedTrades > 0 ? toFixed(new Decimal(takeProfitOpportunityCount).div(breachedTrades).mul(100), 4) : "0.0000",
    meanReboundFromPathMinPct:
      reboundPcts.length > 0
        ? toFixed(reboundPcts.reduce((acc, cur) => acc.plus(cur), new Decimal(0)).div(reboundPcts.length), 4)
        : "0.0000",
    p95ReboundFromPathMinPct: toFixed(percentile(reboundPcts, 0.95), 4),
    meanStillBelowTriggerPct:
      stillBelowTriggerPcts.length > 0
        ? toFixed(
            stillBelowTriggerPcts.reduce((acc, cur) => acc.plus(cur), new Decimal(0)).div(stillBelowTriggerPcts.length),
            4
          )
        : "0.0000"
  };
};

const toDailyCsvRows = (items: DailyAgg[]): Array<Record<string, string | number | boolean>> =>
  items.map((row) => ({
    period: row.period,
    model: row.model,
    breachMode: row.breachMode,
    day: row.day,
    trades: row.trades,
    triggers: row.triggers,
    triggerHitRatePct: toFixed(row.triggerHitRatePct, 4),
    rollingTriggerHitRatePct: toFixed(row.rollingTriggerHitRatePct, 4),
    premiumUsd: toFixed(row.premiumUsd),
    payoutUsd: toFixed(row.payoutUsd),
    subsidyNeedUsd: toFixed(row.subsidyNeedUsd),
    subsidyAppliedUsd: toFixed(row.subsidyAppliedUsd),
    subsidyBlockedUsd: toFixed(row.subsidyBlockedUsd),
    dailySubsidyUtilizationPct: toFixed(row.dailySubsidyUtilizationPct, 4),
    treasuryEndBalanceUsd: toFixed(row.treasuryEndBalanceUsd),
    drawdownUsd: toFixed(row.drawdownUsd),
    drawdownPct: toFixed(row.drawdownPct, 4),
    fallbackFlag: row.fallbackFlag,
    pauseFlag: row.pauseFlag,
    recommendedAction: row.recommendedAction
  }));

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.outDir, { recursive: true });

  const summaryRows: SummaryCsvRow[] = [];
  const dailyRows: DailyAgg[] = [];
  const reboundRows: BreachReboundCsvRow[] = [];

  for (const inputPath of args.inputPaths) {
    const raw = await readFile(inputPath, "utf8");
    const parsed = JSON.parse(raw) as BacktestOutput;
    if (!Array.isArray(parsed.summary) || !Array.isArray(parsed.rows)) {
      throw new Error(`invalid_backtest_json:${inputPath}`);
    }

    const period = periodFromPath(inputPath);
    const startingTreasury = toDecimal(parsed.treasury?.startingBalanceUsd || "25000");
    const dailyCap = toDecimal(parsed.treasury?.dailySubsidyCapUsd || "15000");
    const execByModel = new Map<ModelName, ExecutiveRiskRow>();
    for (const er of parsed.executiveRisk || []) {
      execByModel.set(er.model, er);
    }

    for (const model of ["strict", "hybrid"] as ModelName[]) {
      const modelSummary = parsed.summary.find((row) => row.model === model);
      if (!modelSummary) continue;
      const modelRows = parsed.rows.filter((row) => row.model === model);
      const modelDaily = buildDailyAgg({
        period,
        model,
        breachMode: modelSummary.breachMode,
        rows: modelRows,
        startingTreasury,
        dailyCap,
        args
      });
      dailyRows.push(...modelDaily);

      const maxDailyUtil = modelDaily.reduce(
        (acc, cur) => (cur.dailySubsidyUtilizationPct.gt(acc) ? cur.dailySubsidyUtilizationPct : acc),
        new Decimal(0)
      );
      const fallbackDays = modelDaily.filter((row) => row.fallbackFlag).length;
      const pauseDays = modelDaily.filter((row) => row.pauseFlag).length;
      const firstPauseDate = modelDaily.find((row) => row.pauseFlag)?.day || "";
      const pnl = toDecimal(modelSummary.underwritingPnlTotalUsd);
      const premium = toDecimal(modelSummary.premiumTotalUsd);
      const pnlMarginPct = premium.gt(0) ? pnl.div(premium).mul(100) : new Decimal(0);
      const endTreasury = toDecimal(modelSummary.endTreasuryBalanceUsd);
      const treasuryConsumption = Decimal.max(new Decimal(0), startingTreasury.minus(endTreasury));
      const treasuryConsumptionPct = startingTreasury.gt(0)
        ? treasuryConsumption.div(startingTreasury).mul(100)
        : new Decimal(0);

      const er = execByModel.get(model);
      summaryRows.push({
        period,
        model,
        breachMode: modelSummary.breachMode,
        trades: modelSummary.trades,
        premiumTotalUsd: modelSummary.premiumTotalUsd,
        payoutTotalUsd: modelSummary.payoutTotalUsd,
        hedgeNetCostTotalUsd: modelSummary.hedgeNetCostTotalUsd,
        underwritingPnlTotalUsd: modelSummary.underwritingPnlTotalUsd,
        pnlMarginPct: toFixed(pnlMarginPct, 4),
        subsidyNeedTotalUsd: modelSummary.subsidyNeedTotalUsd,
        subsidyAppliedTotalUsd: modelSummary.subsidyAppliedTotalUsd,
        subsidyBlockedTotalUsd: modelSummary.subsidyBlockedTotalUsd,
        triggerHitRatePct: modelSummary.triggerHitRatePct,
        worstDaySubsidyNeedUsd: er?.worstDaySubsidyNeedUsd || "0.0000000000",
        worstDaySubsidyNeedDate: er?.worstDaySubsidyNeedDate || "",
        lossP95PerTradeUsd: er?.lossP95PerTradeUsd || "0.0000000000",
        maxDrawdownUsd: er?.maxDrawdownUsd || "0.0000000000",
        maxDrawdownPct: er?.maxDrawdownPct || "0.0000",
        maxDailySubsidyUtilizationPct: toFixed(maxDailyUtil, 4),
        fallbackDays,
        pauseDays,
        firstPauseDate,
        endTreasuryBalanceUsd: modelSummary.endTreasuryBalanceUsd,
        treasuryConsumptionUsd: toFixed(treasuryConsumption),
        treasuryConsumptionPct: toFixed(treasuryConsumptionPct, 4),
        recommendedMinTreasuryBufferUsd: er?.recommendedMinTreasuryBufferUsd || toFixed(startingTreasury),
        recommendedBufferFormula: er?.recommendedBufferFormula || "n/a"
      });

      reboundRows.push(
        buildBreachRebound({
          period,
          model,
          breachMode: modelSummary.breachMode,
          rows: modelRows,
          takeProfitReboundPct: args.takeProfitReboundPct
        })
      );
    }
  }

  summaryRows.sort((a, b) => (a.period === b.period ? a.model.localeCompare(b.model) : a.period.localeCompare(b.period)));
  dailyRows.sort((a, b) =>
    a.period === b.period ? (a.day === b.day ? a.model.localeCompare(b.model) : a.day.localeCompare(b.day)) : a.period.localeCompare(b.period)
  );
  reboundRows.sort((a, b) => (a.period === b.period ? a.model.localeCompare(b.model) : a.period.localeCompare(b.period)));

  const summaryCsvPath = path.join(args.outDir, "risk_pack_summary.csv");
  const dailyCsvPath = path.join(args.outDir, "risk_pack_daily.csv");
  const reboundCsvPath = path.join(args.outDir, "risk_pack_breach_rebound.csv");
  const overviewMdPath = path.join(args.outDir, "risk_pack_overview.md");
  const defaultXlsxPath = path.join(args.outDir, "risk_pack.xlsx");
  const outXlsxPath = args.outXlsxPath || defaultXlsxPath;

  const dailyCsvRows = toDailyCsvRows(dailyRows);

  await writeFile(summaryCsvPath, rowsToCsv(summaryRows as unknown as Array<Record<string, string | number | boolean>>), "utf8");
  await writeFile(dailyCsvPath, rowsToCsv(dailyCsvRows), "utf8");
  await writeFile(reboundCsvPath, rowsToCsv(reboundRows as unknown as Array<Record<string, string | number | boolean>>), "utf8");
  writeWorkbook({
    outPath: outXlsxPath,
    summaryRows,
    dailyRows: dailyCsvRows,
    reboundRows
  });

  const top = summaryRows
    .map(
      (row) =>
        `| ${row.period} | ${row.model} | ${row.triggerHitRatePct} | ${row.subsidyNeedTotalUsd} | ${row.worstDaySubsidyNeedUsd} | ${row.maxDrawdownPct} | ${row.recommendedMinTreasuryBufferUsd} | ${row.pauseDays} |`
    )
    .join("\n");
  const overview = [
    "# Pilot backtest risk pack",
    "",
    "## Policy thresholds used",
    `- rolling trigger hit fallback/pause: ${args.fallbackTriggerHitRatePct}% / ${args.pauseTriggerHitRatePct}%`,
    `- daily subsidy utilization fallback/pause: ${args.fallbackSubsidyUtilizationPct}% / ${args.pauseSubsidyUtilizationPct}%`,
    `- treasury drawdown fallback/pause: ${args.fallbackDrawdownPct}% / ${args.pauseDrawdownPct}%`,
    `- pause when subsidy blocked: ${args.pauseWhenSubsidyBlocked ? "true" : "false"}`,
    `- take-profit opportunity rebound threshold: ${args.takeProfitReboundPct}%`,
    "",
    "## Executive summary table",
    "| period | model | triggerHitRatePct | subsidyNeedTotalUsd | worstDaySubsidyNeedUsd | maxDrawdownPct | recommendedMinTreasuryBufferUsd | pauseDays |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    top || "| n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |",
    "",
    "## Files",
    `- summary: \`${summaryCsvPath}\``,
    `- daily: \`${dailyCsvPath}\``,
    `- breach/rebound: \`${reboundCsvPath}\``,
    `- workbook: \`${outXlsxPath}\``
  ].join("\n");
  await writeFile(overviewMdPath, overview, "utf8");

  console.log(
    JSON.stringify(
      {
        status: "ok",
        inputs: args.inputPaths,
        outDir: args.outDir,
        files: {
          summaryCsv: summaryCsvPath,
          dailyCsv: dailyCsvPath,
          breachReboundCsv: reboundCsvPath,
          overviewMd: overviewMdPath,
          workbookXlsx: outXlsxPath
        },
        rows: {
          summary: summaryRows.length,
          daily: dailyRows.length,
          breachRebound: reboundRows.length
        }
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
        reason: "pilot_backtest_risk_pack_failed",
        message: String(error?.message || error || "unknown_error")
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});

