import { mkdir, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import Decimal from "decimal.js";
import * as XLSX from "xlsx";

type ModelName = "strict" | "hybrid";

type QuarterDef = {
  label: string;
  fromIso: string;
  toIso: string;
  regime: "stress" | "calm";
};

type BacktestSummaryRow = {
  model: ModelName;
  breachMode: "expiry_only" | "path_min";
  takeProfitEnabled?: boolean;
  trades: number;
  triggerHitRatePct: string;
  underwritingPnlTotalUsd: string;
  underwritingPnlImprovementUsd?: string;
  subsidyNeedTotalUsd: string;
  subsidyNeedReductionUsd?: string;
  takeProfitTriggeredRatePct?: string;
  takeProfitUnderperformedCount?: number;
  endTreasuryBalanceUsd: string;
};

type ExecutiveRiskRow = {
  model: ModelName;
  recommendedMinTreasuryBufferUsd: string;
};

type BacktestOutput = {
  status: "ok";
  summary: BacktestSummaryRow[];
  executiveRisk?: ExecutiveRiskRow[];
};

type Args = {
  configPath: string;
  outDir: string;
  outXlsxPath: string | null;
  source: "auto" | "binance" | "coingecko" | "coinbase";
  mode: "strict_only" | "hybrid_only" | "both";
  reboundGrid: Decimal[];
  decayGrid: Decimal[];
  skipFetch: boolean;
  quarterLabels: string[] | null;
};

type PeriodDetailRow = {
  combo: string;
  reboundPct: string;
  decayPct: string;
  quarter: string;
  regime: "stress" | "calm";
  model: ModelName;
  trades: number;
  triggerHitRatePct: string;
  takeProfitTriggeredRatePct: string;
  takeProfitUnderperformedCount: number;
  underwritingPnlTotalUsd: string;
  underwritingPnlImprovementUsd: string;
  subsidyNeedTotalUsd: string;
  subsidyNeedReductionUsd: string;
  recommendedMinTreasuryBufferUsd: string;
  endTreasuryBalanceUsd: string;
};

type ComboSummaryRow = {
  combo: string;
  model: ModelName;
  reboundPct: string;
  decayPct: string;
  preserveCalmUpside: boolean;
  stressSubsidyNeedTpUsd: string;
  stressSubsidyNeedReductionUsd: string;
  stressWorstRecommendedMinBufferUsd: string;
  calmUnderwritingPnlImprovementUsd: string;
  calmSubsidyNeedReductionUsd: string;
  totalUnderwritingPnlTpUsd: string;
  totalUnderwritingPnlImprovementUsd: string;
  stressTriggerHitRatePct: string;
  calmTriggerHitRatePct: string;
  avgTakeProfitTriggeredRatePct: string;
  totalTakeProfitUnderperformedCount: number;
};

const DEFAULT_QUARTERS: QuarterDef[] = [
  { label: "q2_2022", fromIso: "2022-04-01T00:00:00Z", toIso: "2022-07-01T00:00:00Z", regime: "stress" },
  { label: "q4_2022", fromIso: "2022-10-01T00:00:00Z", toIso: "2023-01-01T00:00:00Z", regime: "stress" },
  { label: "q1_2023", fromIso: "2023-01-01T00:00:00Z", toIso: "2023-04-01T00:00:00Z", regime: "calm" },
  { label: "q1_2024", fromIso: "2024-01-01T00:00:00Z", toIso: "2024-04-01T00:00:00Z", regime: "calm" }
];

const toDecimal = (value: string | number | undefined): Decimal => {
  try {
    return new Decimal(String(value ?? "0"));
  } catch {
    return new Decimal(0);
  }
};

const toFixed = (value: Decimal, dp = 10): string => value.toFixed(dp);

const rowsToSheet = (rows: Array<Record<string, string | number | boolean>>) => XLSX.utils.json_to_sheet(rows);

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

const parseBool = (raw: string | undefined, fallback: boolean): boolean => {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return fallback;
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  return fallback;
};

const parseGrid = (raw: string | undefined, fallback: string): Decimal[] => {
  const source = String(raw || fallback);
  const out = source
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => toDecimal(item))
    .filter((value) => value.gte(0));
  if (!out.length) {
    throw new Error("invalid_grid_values");
  }
  return out;
};

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    configPath: "scripts/fixtures/pilot_backtest_config.example.json",
    outDir: "artifacts/backtest/stress_tp/sweep",
    outXlsxPath: null,
    source: "coinbase",
    mode: "both",
    reboundGrid: parseGrid(undefined, "1,2,3,4"),
    decayGrid: parseGrid(undefined, "10,20,30,40"),
    skipFetch: false,
    quarterLabels: null
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
    if (token === "--out-xlsx" && argv[i + 1]) {
      args.outXlsxPath = argv[i + 1];
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
    if (token === "--mode" && argv[i + 1]) {
      const mode = String(argv[i + 1]).trim().toLowerCase();
      if (mode === "strict_only" || mode === "hybrid_only" || mode === "both") {
        args.mode = mode;
      } else {
        throw new Error(`invalid_mode:${mode}`);
      }
      i += 1;
      continue;
    }
    if (token === "--rebound-grid" && argv[i + 1]) {
      args.reboundGrid = parseGrid(argv[i + 1], "1,2,3,4");
      i += 1;
      continue;
    }
    if (token === "--decay-grid" && argv[i + 1]) {
      args.decayGrid = parseGrid(argv[i + 1], "10,20,30,40");
      i += 1;
      continue;
    }
    if (token === "--skip-fetch" && argv[i + 1]) {
      args.skipFetch = parseBool(argv[i + 1], false);
      i += 1;
      continue;
    }
    if (token === "--quarters" && argv[i + 1]) {
      args.quarterLabels = String(argv[i + 1])
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      i += 1;
      continue;
    }
  }
  return args;
};

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

const weightedRatePct = (items: Array<{ trades: number; ratePct: Decimal }>): Decimal => {
  const totalTrades = items.reduce((acc, cur) => acc + cur.trades, 0);
  if (totalTrades <= 0) return new Decimal(0);
  const weighted = items.reduce((acc, cur) => acc.plus(cur.ratePct.mul(cur.trades)), new Decimal(0));
  return weighted.div(totalTrades);
};

const buildWorkbook = (params: {
  outPath: string;
  assumptions: Array<Record<string, string | number | boolean>>;
  periodRows: PeriodDetailRow[];
  comboRows: ComboSummaryRow[];
  rankingHybrid: Array<Record<string, string | number | boolean>>;
  rankingStrict: Array<Record<string, string | number | boolean>>;
  recommendations: Array<Record<string, string | number | boolean>>;
  treasuryProjectionRows: Array<Record<string, string | number | boolean>>;
}) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, rowsToSheet(params.assumptions), "assumptions");
  XLSX.utils.book_append_sheet(
    wb,
    rowsToSheet(params.periodRows as unknown as Array<Record<string, string | number | boolean>>),
    "period_detail"
  );
  XLSX.utils.book_append_sheet(
    wb,
    rowsToSheet(params.comboRows as unknown as Array<Record<string, string | number | boolean>>),
    "combo_summary"
  );
  XLSX.utils.book_append_sheet(wb, rowsToSheet(params.rankingHybrid), "ranking_hybrid");
  XLSX.utils.book_append_sheet(wb, rowsToSheet(params.rankingStrict), "ranking_strict");
  XLSX.utils.book_append_sheet(wb, rowsToSheet(params.recommendations), "recommendations");
  XLSX.utils.book_append_sheet(wb, rowsToSheet(params.treasuryProjectionRows), "treasury_projection");
  XLSX.writeFile(wb, params.outPath);
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const selectedQuarters = args.quarterLabels
    ? DEFAULT_QUARTERS.filter((quarter) => args.quarterLabels!.includes(quarter.label))
    : DEFAULT_QUARTERS;
  if (!selectedQuarters.length) {
    throw new Error("no_quarters_selected");
  }

  const runsDir = path.join(args.outDir, "runs");
  const pricesDir = path.join(args.outDir, "prices");
  await mkdir(runsDir, { recursive: true });
  await mkdir(pricesDir, { recursive: true });

  for (const quarter of selectedQuarters) {
    const outCsv = path.join(pricesDir, `btc_usd_${quarter.label}_1h.csv`);
    const shouldFetch = !args.skipFetch || !(await fileExists(outCsv));
    if (!shouldFetch) continue;
    await runCommand(
      "npm",
      [
        "run",
        "-s",
        "pilot:backtest:fetch-btc",
        "--",
        "--from",
        quarter.fromIso,
        "--to",
        quarter.toIso,
        "--source",
        args.source,
        "--out-csv",
        outCsv
      ],
      cwd
    );
  }

  const periodRows: PeriodDetailRow[] = [];
  for (const rebound of args.reboundGrid) {
    for (const decay of args.decayGrid) {
      const combo = `r${rebound.toFixed(2)}_d${decay.toFixed(2)}`;
      const comboDir = path.join(runsDir, combo);
      await mkdir(comboDir, { recursive: true });

      for (const quarter of selectedQuarters) {
        const pricesCsv = path.join(pricesDir, `btc_usd_${quarter.label}_1h.csv`);
        const outJson = path.join(comboDir, `pilot_backtest_${quarter.label}.json`);
        const outCsv = path.join(comboDir, `pilot_backtest_${quarter.label}.csv`);
        await runCommand(
          "npm",
          [
            "run",
            "-s",
            "pilot:backtest:run",
            "--",
            "--config",
            args.configPath,
            "--prices-csv",
            pricesCsv,
            "--mode",
            args.mode,
            "--tp-enabled",
            "true",
            "--tp-rebound-pct",
            rebound.toString(),
            "--tp-decay-pct",
            decay.toString(),
            "--out-json",
            outJson,
            "--out-csv",
            outCsv
          ],
          cwd
        );

        const parsed = JSON.parse(await readFile(outJson, "utf8")) as BacktestOutput;
        const execByModel = new Map<ModelName, ExecutiveRiskRow>();
        for (const er of parsed.executiveRisk || []) {
          execByModel.set(er.model, er);
        }
        for (const summary of parsed.summary) {
          const er = execByModel.get(summary.model);
          periodRows.push({
            combo,
            reboundPct: rebound.toFixed(2),
            decayPct: decay.toFixed(2),
            quarter: quarter.label,
            regime: quarter.regime,
            model: summary.model,
            trades: summary.trades,
            triggerHitRatePct: String(summary.triggerHitRatePct),
            takeProfitTriggeredRatePct: String(summary.takeProfitTriggeredRatePct || "0.0000"),
            takeProfitUnderperformedCount: Number(summary.takeProfitUnderperformedCount || 0),
            underwritingPnlTotalUsd: String(summary.underwritingPnlTotalUsd),
            underwritingPnlImprovementUsd: String(summary.underwritingPnlImprovementUsd || "0.0000000000"),
            subsidyNeedTotalUsd: String(summary.subsidyNeedTotalUsd),
            subsidyNeedReductionUsd: String(summary.subsidyNeedReductionUsd || "0.0000000000"),
            recommendedMinTreasuryBufferUsd: String(er?.recommendedMinTreasuryBufferUsd || "0.0000000000"),
            endTreasuryBalanceUsd: String(summary.endTreasuryBalanceUsd)
          });
        }
      }
    }
  }

  const byComboModel = new Map<string, ComboSummaryRow>();
  for (const row of periodRows) {
    const key = `${row.combo}::${row.model}`;
    const existing = byComboModel.get(key);
    if (!existing) {
      byComboModel.set(key, {
        combo: row.combo,
        model: row.model,
        reboundPct: row.reboundPct,
        decayPct: row.decayPct,
        preserveCalmUpside: true,
        stressSubsidyNeedTpUsd: "0.0000000000",
        stressSubsidyNeedReductionUsd: "0.0000000000",
        stressWorstRecommendedMinBufferUsd: "0.0000000000",
        calmUnderwritingPnlImprovementUsd: "0.0000000000",
        calmSubsidyNeedReductionUsd: "0.0000000000",
        totalUnderwritingPnlTpUsd: "0.0000000000",
        totalUnderwritingPnlImprovementUsd: "0.0000000000",
        stressTriggerHitRatePct: "0.0000",
        calmTriggerHitRatePct: "0.0000",
        avgTakeProfitTriggeredRatePct: "0.0000",
        totalTakeProfitUnderperformedCount: 0
      });
    }
    const agg = byComboModel.get(key)!;
    const pnlTp = toDecimal(agg.totalUnderwritingPnlTpUsd).plus(toDecimal(row.underwritingPnlTotalUsd));
    const pnlImp = toDecimal(agg.totalUnderwritingPnlImprovementUsd).plus(toDecimal(row.underwritingPnlImprovementUsd));
    agg.totalUnderwritingPnlTpUsd = toFixed(pnlTp);
    agg.totalUnderwritingPnlImprovementUsd = toFixed(pnlImp);
    agg.totalTakeProfitUnderperformedCount += row.takeProfitUnderperformedCount;

    if (row.regime === "stress") {
      agg.stressSubsidyNeedTpUsd = toFixed(toDecimal(agg.stressSubsidyNeedTpUsd).plus(toDecimal(row.subsidyNeedTotalUsd)));
      agg.stressSubsidyNeedReductionUsd = toFixed(
        toDecimal(agg.stressSubsidyNeedReductionUsd).plus(toDecimal(row.subsidyNeedReductionUsd))
      );
      const currentWorst = toDecimal(agg.stressWorstRecommendedMinBufferUsd);
      const nextValue = toDecimal(row.recommendedMinTreasuryBufferUsd);
      agg.stressWorstRecommendedMinBufferUsd = toFixed(Decimal.max(currentWorst, nextValue));
    } else {
      agg.calmUnderwritingPnlImprovementUsd = toFixed(
        toDecimal(agg.calmUnderwritingPnlImprovementUsd).plus(toDecimal(row.underwritingPnlImprovementUsd))
      );
      agg.calmSubsidyNeedReductionUsd = toFixed(
        toDecimal(agg.calmSubsidyNeedReductionUsd).plus(toDecimal(row.subsidyNeedReductionUsd))
      );
    }
  }

  const comboRows = Array.from(byComboModel.values());
  for (const agg of comboRows) {
    const modelRows = periodRows.filter((row) => row.combo === agg.combo && row.model === agg.model);
    const stressRates = modelRows
      .filter((row) => row.regime === "stress")
      .map((row) => ({ trades: row.trades, ratePct: toDecimal(row.triggerHitRatePct) }));
    const calmRates = modelRows
      .filter((row) => row.regime === "calm")
      .map((row) => ({ trades: row.trades, ratePct: toDecimal(row.triggerHitRatePct) }));
    const tpRates = modelRows.map((row) => ({ trades: row.trades, ratePct: toDecimal(row.takeProfitTriggeredRatePct) }));
    agg.stressTriggerHitRatePct = weightedRatePct(stressRates).toFixed(4);
    agg.calmTriggerHitRatePct = weightedRatePct(calmRates).toFixed(4);
    agg.avgTakeProfitTriggeredRatePct = weightedRatePct(tpRates).toFixed(4);
    agg.preserveCalmUpside = toDecimal(agg.calmUnderwritingPnlImprovementUsd).gte(0);
  }

  const comparator = (a: ComboSummaryRow, b: ComboSummaryRow): number => {
    if (a.preserveCalmUpside !== b.preserveCalmUpside) return a.preserveCalmUpside ? -1 : 1;
    const stressNeed = toDecimal(a.stressSubsidyNeedTpUsd).comparedTo(toDecimal(b.stressSubsidyNeedTpUsd));
    if (stressNeed !== 0) return stressNeed;
    const calmPnl = toDecimal(b.calmUnderwritingPnlImprovementUsd).comparedTo(toDecimal(a.calmUnderwritingPnlImprovementUsd));
    if (calmPnl !== 0) return calmPnl;
    return toDecimal(b.totalUnderwritingPnlImprovementUsd).comparedTo(toDecimal(a.totalUnderwritingPnlImprovementUsd));
  };

  const rankingRows = (model: ModelName) => {
    const filtered = comboRows.filter((row) => row.model === model).sort(comparator);
    return filtered.map((row, idx) => ({
      rank: idx + 1,
      ...row
    }));
  };
  const rankingHybrid = rankingRows("hybrid");
  const rankingStrict = rankingRows("strict");

  const recommendations = [
    {
      model: "hybrid",
      recommendationRank1: rankingHybrid[0]?.combo || "n/a",
      reboundPct: rankingHybrid[0]?.reboundPct || "n/a",
      decayPct: rankingHybrid[0]?.decayPct || "n/a",
      preserveCalmUpside: rankingHybrid[0]?.preserveCalmUpside ?? false,
      stressSubsidyNeedTpUsd: rankingHybrid[0]?.stressSubsidyNeedTpUsd || "n/a",
      calmUnderwritingPnlImprovementUsd: rankingHybrid[0]?.calmUnderwritingPnlImprovementUsd || "n/a",
      stressWorstRecommendedMinBufferUsd: rankingHybrid[0]?.stressWorstRecommendedMinBufferUsd || "n/a"
    },
    {
      model: "strict",
      recommendationRank1: rankingStrict[0]?.combo || "n/a",
      reboundPct: rankingStrict[0]?.reboundPct || "n/a",
      decayPct: rankingStrict[0]?.decayPct || "n/a",
      preserveCalmUpside: rankingStrict[0]?.preserveCalmUpside ?? false,
      stressSubsidyNeedTpUsd: rankingStrict[0]?.stressSubsidyNeedTpUsd || "n/a",
      calmUnderwritingPnlImprovementUsd: rankingStrict[0]?.calmUnderwritingPnlImprovementUsd || "n/a",
      stressWorstRecommendedMinBufferUsd: rankingStrict[0]?.stressWorstRecommendedMinBufferUsd || "n/a"
    }
  ];

  const projectionScales = [0.5, 1, 1.5, 2];
  const topByModel: Record<ModelName, ComboSummaryRow | null> = {
    hybrid: rankingHybrid[0] || null,
    strict: rankingStrict[0] || null
  };
  const treasuryProjectionRows: Array<Record<string, string | number | boolean>> = [];
  for (const model of ["hybrid", "strict"] as ModelName[]) {
    const top = topByModel[model];
    const baseBuffer = toDecimal(top?.stressWorstRecommendedMinBufferUsd || "0");
    for (const scale of projectionScales) {
      const scaled = baseBuffer.mul(scale);
      treasuryProjectionRows.push({
        model,
        combo: top?.combo || "n/a",
        reboundPct: top?.reboundPct || "n/a",
        decayPct: top?.decayPct || "n/a",
        baseStressWorstRecommendedMinBufferUsd: toFixed(baseBuffer),
        issuanceScale: scale,
        minBufferUsd: toFixed(scaled),
        targetBuffer30PctCushionUsd: toFixed(scaled.mul("1.30")),
        targetBuffer50PctCushionUsd: toFixed(scaled.mul("1.50"))
      });
    }
  }

  comboRows.sort((a, b) =>
    a.model === b.model ? a.combo.localeCompare(b.combo) : a.model.localeCompare(b.model)
  );
  periodRows.sort((a, b) =>
    a.combo === b.combo
      ? a.quarter === b.quarter
        ? a.model.localeCompare(b.model)
        : a.quarter.localeCompare(b.quarter)
      : a.combo.localeCompare(b.combo)
  );

  const outXlsxPath = args.outXlsxPath || path.join(args.outDir, "tp_sweep_combined.xlsx");
  const assumptions = [
    { key: "objective", value: "Minimize stress subsidy need while preserving calm-quarter upside" },
    { key: "tp_definition", value: "TP closes hedge before expiry on rebound/decay rules after breach dynamics" },
    { key: "stress_quarters", value: selectedQuarters.filter((q) => q.regime === "stress").map((q) => q.label).join(",") },
    { key: "calm_quarters", value: selectedQuarters.filter((q) => q.regime === "calm").map((q) => q.label).join(",") },
    { key: "rebound_grid_pct", value: args.reboundGrid.map((v) => v.toFixed(2)).join(",") },
    { key: "decay_grid_pct", value: args.decayGrid.map((v) => v.toFixed(2)).join(",") },
    { key: "source", value: args.source },
    { key: "mode", value: args.mode }
  ];

  const comboCsvPath = path.join(args.outDir, "tp_sweep_combo_summary.csv");
  const periodCsvPath = path.join(args.outDir, "tp_sweep_period_detail.csv");
  const rankingHybridCsvPath = path.join(args.outDir, "tp_sweep_ranking_hybrid.csv");
  const rankingStrictCsvPath = path.join(args.outDir, "tp_sweep_ranking_strict.csv");
  const treasuryProjectionCsvPath = path.join(args.outDir, "tp_sweep_treasury_projection.csv");
  const overviewMdPath = path.join(args.outDir, "tp_sweep_overview.md");
  await writeFile(comboCsvPath, rowsToCsv(comboRows as unknown as Array<Record<string, string | number | boolean>>), "utf8");
  await writeFile(periodCsvPath, rowsToCsv(periodRows as unknown as Array<Record<string, string | number | boolean>>), "utf8");
  await writeFile(
    rankingHybridCsvPath,
    rowsToCsv(rankingHybrid as unknown as Array<Record<string, string | number | boolean>>),
    "utf8"
  );
  await writeFile(
    rankingStrictCsvPath,
    rowsToCsv(rankingStrict as unknown as Array<Record<string, string | number | boolean>>),
    "utf8"
  );
  await writeFile(treasuryProjectionCsvPath, rowsToCsv(treasuryProjectionRows), "utf8");

  buildWorkbook({
    outPath: outXlsxPath,
    assumptions,
    periodRows,
    comboRows,
    rankingHybrid,
    rankingStrict,
    recommendations,
    treasuryProjectionRows
  });

  const overview = [
    "# TP sweep overview",
    "",
    "## What this sweep identifies",
    "- Finds TP rule combinations (rebound%, decay%) that reduce stress-quarter subsidy burden.",
    "- Enforces calm-quarter upside preservation via ranking preference (`preserveCalmUpside=true`).",
    "- Provides per-period and aggregated model impact for strict and hybrid.",
    "",
    "## Rank logic",
    "1) preserve calm upside (true first)",
    "2) lower stress subsidy need total",
    "3) higher calm-quarter PnL improvement",
    "4) higher total PnL improvement",
    "",
    "## Top recommendations",
    ...recommendations.map(
      (row) =>
        `- ${row.model}: ${row.recommendationRank1} (rebound=${row.reboundPct}%, decay=${row.decayPct}%, preserveCalmUpside=${String(row.preserveCalmUpside)})`
    ),
    "",
    "## Files",
    `- combo summary csv: \`${comboCsvPath}\``,
    `- period detail csv: \`${periodCsvPath}\``,
    `- ranking hybrid csv: \`${rankingHybridCsvPath}\``,
    `- ranking strict csv: \`${rankingStrictCsvPath}\``,
    `- treasury projection csv: \`${treasuryProjectionCsvPath}\``,
    `- workbook: \`${outXlsxPath}\``
  ].join("\n");
  await writeFile(overviewMdPath, overview, "utf8");

  console.log(
    JSON.stringify(
      {
        status: "ok",
        quarters: selectedQuarters.map((q) => ({ label: q.label, regime: q.regime })),
        combos: args.reboundGrid.length * args.decayGrid.length,
        files: {
          comboSummaryCsv: comboCsvPath,
          periodDetailCsv: periodCsvPath,
          rankingHybridCsv: rankingHybridCsvPath,
          rankingStrictCsv: rankingStrictCsvPath,
          treasuryProjectionCsv: treasuryProjectionCsvPath,
          overviewMd: overviewMdPath,
          workbookXlsx: outXlsxPath
        },
        top: {
          hybrid: rankingHybrid[0] || null,
          strict: rankingStrict[0] || null
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
        reason: "pilot_backtest_tp_sweep_failed",
        message: String(error?.message || error || "unknown_error")
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});

