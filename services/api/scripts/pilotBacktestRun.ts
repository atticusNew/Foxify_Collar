import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Decimal from "decimal.js";
import { computeDrawdownLossBudgetUsd } from "../src/pilot/protectionMath";

type DecimalString = string;

type TierConfig = {
  tierName: string;
  drawdownFloorPct: DecimalString;
  strictPremiumPer1kProtectedUsd: DecimalString;
  hybridPremiumPer1kProtectedUsd: DecimalString;
  fallbackHedgePremiumPer1kProtectedUsd: DecimalString;
  strictHedgeRecoveryPct: DecimalString;
  hybridHedgeRecoveryPct: DecimalString;
};

type BacktestConfig = {
  name: string;
  tenorDays: number;
  entryStepHours: number;
  notionalsUsd: DecimalString[];
  treasury: {
    startingBalanceUsd: DecimalString;
    dailySubsidyCapUsd: DecimalString;
    perQuoteSubsidyCapPct: DecimalString;
  };
  tiers: TierConfig[];
};

type PricePoint = {
  tsMs: number;
  tsIso: string;
  price: Decimal;
};

type ModelName = "strict" | "hybrid";

type RunMode = "strict_only" | "hybrid_only" | "both";

type TradeRow = {
  model: ModelName;
  tierName: string;
  entryTsIso: string;
  exitTsIso: string;
  tenorDays: number;
  protectedNotionalUsd: string;
  entryPriceUsd: string;
  triggerPriceUsd: string;
  expiryPriceUsd: string;
  premiumUsd: string;
  hedgeCostUsd: string;
  hedgeRecoveredUsd: string;
  hedgeNetCostUsd: string;
  payoutUsd: string;
  underwritingPnlUsd: string;
  subsidyNeedUsd: string;
  subsidyAppliedUsd: string;
  subsidyBlockedUsd: string;
  treasuryBalanceAfterUsd: string;
};

type SummaryModel = {
  model: ModelName;
  trades: number;
  premiumTotalUsd: string;
  payoutTotalUsd: string;
  hedgeCostTotalUsd: string;
  hedgeRecoveredTotalUsd: string;
  hedgeNetCostTotalUsd: string;
  underwritingPnlTotalUsd: string;
  underwritingPnlPerTradeUsd: string;
  subsidyNeedTotalUsd: string;
  subsidyAppliedTotalUsd: string;
  subsidyBlockedTotalUsd: string;
  subsidyHitCount: number;
  subsidyBlockedCount: number;
  triggerHitCount: number;
  triggerHitRatePct: string;
  endTreasuryBalanceUsd: string;
};

type BacktestOutput = {
  status: "ok";
  name: string;
  mode: RunMode;
  asOfIso: string;
  configPath: string;
  pricesPath: string;
  rows: TradeRow[];
  summary: SummaryModel[];
};

type Args = {
  configPath: string;
  pricesCsvPath: string;
  outJsonPath: string;
  outCsvPath: string;
  mode: RunMode;
};

const ZERO = new Decimal(0);
const ONE_THOUSAND = new Decimal(1000);
const DAY_MS = 24 * 60 * 60 * 1000;

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    configPath: "scripts/fixtures/pilot_backtest_config.example.json",
    pricesCsvPath: "artifacts/backtest/btc_usd_1h.csv",
    outJsonPath: "artifacts/backtest/pilot_backtest.json",
    outCsvPath: "artifacts/backtest/pilot_backtest.csv",
    mode: "both"
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--config" && argv[i + 1]) {
      args.configPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--prices-csv" && argv[i + 1]) {
      args.pricesCsvPath = argv[i + 1];
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
  }
  return args;
};

const parseDecimal = (raw: unknown, fieldName: string): Decimal => {
  try {
    const value = new Decimal(raw as Decimal.Value);
    if (!value.isFinite()) {
      throw new Error(`invalid_decimal:${fieldName}`);
    }
    return value;
  } catch {
    throw new Error(`invalid_decimal:${fieldName}`);
  }
};

const parsePositiveInt = (raw: unknown, fieldName: string): number => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`invalid_positive_int:${fieldName}`);
  }
  return Math.floor(n);
};

const loadConfig = async (configPath: string): Promise<BacktestConfig> => {
  const raw = await readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as BacktestConfig;

  if (!parsed?.name || !Array.isArray(parsed?.tiers) || !Array.isArray(parsed?.notionalsUsd)) {
    throw new Error("invalid_config_shape");
  }

  parsePositiveInt(parsed.tenorDays, "tenorDays");
  parsePositiveInt(parsed.entryStepHours, "entryStepHours");
  parseDecimal(parsed.treasury?.startingBalanceUsd, "treasury.startingBalanceUsd");
  parseDecimal(parsed.treasury?.dailySubsidyCapUsd, "treasury.dailySubsidyCapUsd");
  parseDecimal(parsed.treasury?.perQuoteSubsidyCapPct, "treasury.perQuoteSubsidyCapPct");

  for (const tier of parsed.tiers) {
    parseDecimal(tier.drawdownFloorPct, `${tier.tierName}.drawdownFloorPct`);
    parseDecimal(tier.strictPremiumPer1kProtectedUsd, `${tier.tierName}.strictPremiumPer1kProtectedUsd`);
    parseDecimal(tier.hybridPremiumPer1kProtectedUsd, `${tier.tierName}.hybridPremiumPer1kProtectedUsd`);
    parseDecimal(tier.fallbackHedgePremiumPer1kProtectedUsd, `${tier.tierName}.fallbackHedgePremiumPer1kProtectedUsd`);
    parseDecimal(tier.strictHedgeRecoveryPct, `${tier.tierName}.strictHedgeRecoveryPct`);
    parseDecimal(tier.hybridHedgeRecoveryPct, `${tier.tierName}.hybridHedgeRecoveryPct`);
  }

  for (const notional of parsed.notionalsUsd) {
    parseDecimal(notional, "notionalsUsd[]");
  }

  return parsed;
};

const loadPrices = async (pricesCsvPath: string): Promise<PricePoint[]> => {
  const raw = await readFile(pricesCsvPath, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= 1) {
    throw new Error("prices_csv_empty");
  }
  const out: PricePoint[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const [tsIsoRaw, priceRaw] = lines[i].split(",");
    const tsMs = Date.parse(String(tsIsoRaw || "").trim());
    if (!Number.isFinite(tsMs)) continue;
    const price = parseDecimal(String(priceRaw || "").trim(), `prices_row_${i}_price`);
    if (price.lte(0)) continue;
    out.push({
      tsMs,
      tsIso: new Date(tsMs).toISOString(),
      price
    });
  }
  out.sort((a, b) => a.tsMs - b.tsMs);
  if (!out.length) {
    throw new Error("prices_csv_no_valid_rows");
  }
  return out;
};

const toFixed = (value: Decimal): string => value.toFixed(10);

const computePayoutLong = (params: {
  protectedNotionalUsd: Decimal;
  entryPriceUsd: Decimal;
  triggerPriceUsd: Decimal;
  expiryPriceUsd: Decimal;
}): Decimal => {
  if (params.expiryPriceUsd.gte(params.triggerPriceUsd)) return ZERO;
  const belowTrigger = params.triggerPriceUsd.minus(params.expiryPriceUsd);
  return belowTrigger.div(params.entryPriceUsd).mul(params.protectedNotionalUsd);
};

const findExitIndex = (prices: PricePoint[], entryIdx: number, tenorDays: number): number | null => {
  const targetExitTs = prices[entryIdx].tsMs + tenorDays * DAY_MS;
  let chosen: number | null = null;
  for (let i = entryIdx + 1; i < prices.length; i += 1) {
    if (prices[i].tsMs >= targetExitTs) {
      chosen = i;
      break;
    }
  }
  return chosen;
};

const formatCsv = (rows: TradeRow[]): string => {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  for (const row of rows) {
    const values = headers.map((key) => {
      const raw = String((row as Record<string, unknown>)[key] ?? "");
      if (raw.includes(",") || raw.includes("\"") || raw.includes("\n")) {
        return `"${raw.replace(/"/g, "\"\"")}"`;
      }
      return raw;
    });
    lines.push(values.join(","));
  }
  return `${lines.join("\n")}\n`;
};

const ensureParentDir = async (targetPath: string) => {
  await mkdir(path.dirname(targetPath), { recursive: true });
};

const resolveModels = (mode: RunMode): ModelName[] => {
  if (mode === "strict_only") return ["strict"];
  if (mode === "hybrid_only") return ["hybrid"];
  return ["strict", "hybrid"];
};

const sumDecimals = (items: Decimal[]): Decimal => items.reduce((acc, cur) => acc.plus(cur), ZERO);

const buildSummary = (rows: TradeRow[]): SummaryModel[] => {
  const models: ModelName[] = ["strict", "hybrid"];
  const summary: SummaryModel[] = [];

  for (const model of models) {
    const subset = rows.filter((row) => row.model === model);
    if (!subset.length) continue;
    const premiums = subset.map((row) => new Decimal(row.premiumUsd));
    const payouts = subset.map((row) => new Decimal(row.payoutUsd));
    const hedgeCosts = subset.map((row) => new Decimal(row.hedgeCostUsd));
    const hedgeRecovered = subset.map((row) => new Decimal(row.hedgeRecoveredUsd));
    const hedgeNetCosts = subset.map((row) => new Decimal(row.hedgeNetCostUsd));
    const pnl = subset.map((row) => new Decimal(row.underwritingPnlUsd));
    const subsidyNeed = subset.map((row) => new Decimal(row.subsidyNeedUsd));
    const subsidyApplied = subset.map((row) => new Decimal(row.subsidyAppliedUsd));
    const subsidyBlocked = subset.map((row) => new Decimal(row.subsidyBlockedUsd));
    const triggerHits = subset.filter((row) => new Decimal(row.payoutUsd).gt(0)).length;
    const subsidyHits = subset.filter((row) => new Decimal(row.subsidyAppliedUsd).gt(0)).length;
    const subsidyBlockedCount = subset.filter((row) => new Decimal(row.subsidyBlockedUsd).gt(0)).length;
    const endBalance = new Decimal(subset[subset.length - 1].treasuryBalanceAfterUsd);
    const tradeCount = subset.length;

    summary.push({
      model,
      trades: tradeCount,
      premiumTotalUsd: toFixed(sumDecimals(premiums)),
      payoutTotalUsd: toFixed(sumDecimals(payouts)),
      hedgeCostTotalUsd: toFixed(sumDecimals(hedgeCosts)),
      hedgeRecoveredTotalUsd: toFixed(sumDecimals(hedgeRecovered)),
      hedgeNetCostTotalUsd: toFixed(sumDecimals(hedgeNetCosts)),
      underwritingPnlTotalUsd: toFixed(sumDecimals(pnl)),
      underwritingPnlPerTradeUsd: toFixed(sumDecimals(pnl).div(tradeCount)),
      subsidyNeedTotalUsd: toFixed(sumDecimals(subsidyNeed)),
      subsidyAppliedTotalUsd: toFixed(sumDecimals(subsidyApplied)),
      subsidyBlockedTotalUsd: toFixed(sumDecimals(subsidyBlocked)),
      subsidyHitCount: subsidyHits,
      subsidyBlockedCount,
      triggerHitCount: triggerHits,
      triggerHitRatePct: new Decimal(triggerHits).div(tradeCount).mul(100).toFixed(4),
      endTreasuryBalanceUsd: toFixed(endBalance)
    });
  }

  return summary;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig(args.configPath);
  const prices = await loadPrices(args.pricesCsvPath);
  const tenorDays = parsePositiveInt(config.tenorDays, "tenorDays");
  const entryStepHours = parsePositiveInt(config.entryStepHours, "entryStepHours");
  const models = resolveModels(args.mode);

  const dailyCap = parseDecimal(config.treasury.dailySubsidyCapUsd, "treasury.dailySubsidyCapUsd");
  const perQuoteCapPct = parseDecimal(config.treasury.perQuoteSubsidyCapPct, "treasury.perQuoteSubsidyCapPct");
  const startingTreasury = parseDecimal(config.treasury.startingBalanceUsd, "treasury.startingBalanceUsd");
  const rows: TradeRow[] = [];

  for (const model of models) {
    let treasuryBalance = startingTreasury;
    const dailyApplied = new Map<string, Decimal>();

    for (let entryIdx = 0; entryIdx < prices.length; entryIdx += entryStepHours) {
      const exitIdx = findExitIndex(prices, entryIdx, tenorDays);
      if (exitIdx === null) break;
      const entry = prices[entryIdx];
      const exit = prices[exitIdx];
      const dayKey = entry.tsIso.slice(0, 10);

      for (const tier of config.tiers) {
        const drawdownFloorPct = parseDecimal(tier.drawdownFloorPct, `${tier.tierName}.drawdownFloorPct`);
        for (const notionalRaw of config.notionalsUsd) {
          const protectedNotional = parseDecimal(notionalRaw, "notional");
          const protectedPer1k = protectedNotional.div(ONE_THOUSAND);
          const premiumPer1k =
            model === "strict"
              ? parseDecimal(tier.strictPremiumPer1kProtectedUsd, `${tier.tierName}.strictPremiumPer1kProtectedUsd`)
              : parseDecimal(tier.hybridPremiumPer1kProtectedUsd, `${tier.tierName}.hybridPremiumPer1kProtectedUsd`);
          const hedgePer1k = parseDecimal(
            tier.fallbackHedgePremiumPer1kProtectedUsd,
            `${tier.tierName}.fallbackHedgePremiumPer1kProtectedUsd`
          );
          const hedgeRecoveryPct =
            model === "strict"
              ? parseDecimal(tier.strictHedgeRecoveryPct, `${tier.tierName}.strictHedgeRecoveryPct`)
              : parseDecimal(tier.hybridHedgeRecoveryPct, `${tier.tierName}.hybridHedgeRecoveryPct`);

          const premiumUsd = premiumPer1k.mul(protectedPer1k);
          const hedgeCostUsd = hedgePer1k.mul(protectedPer1k);
          const triggerPriceUsd = entry.price.mul(new Decimal(1).minus(drawdownFloorPct));
          const payoutCap = computeDrawdownLossBudgetUsd(protectedNotional, drawdownFloorPct);
          const payoutRaw = computePayoutLong({
            protectedNotionalUsd: protectedNotional,
            entryPriceUsd: entry.price,
            triggerPriceUsd,
            expiryPriceUsd: exit.price
          });
          const payoutUsd = Decimal.min(payoutRaw, payoutCap);

          const hedgeRecoveredUsd = payoutUsd.mul(hedgeRecoveryPct);
          const hedgeNetCostUsd = Decimal.max(ZERO, hedgeCostUsd.minus(hedgeRecoveredUsd));
          const underwritingPnlUsd = premiumUsd.minus(payoutUsd).minus(hedgeNetCostUsd);
          const subsidyNeedUsd = Decimal.max(ZERO, underwritingPnlUsd.negated());
          const perQuoteCapUsd = premiumUsd.mul(perQuoteCapPct);
          const usedToday = dailyApplied.get(dayKey) || ZERO;
          const remainingDailyCap = Decimal.max(ZERO, dailyCap.minus(usedToday));
          const subsidyAppliedUsd = Decimal.min(subsidyNeedUsd, perQuoteCapUsd, remainingDailyCap, treasuryBalance);
          const subsidyBlockedUsd = Decimal.max(ZERO, subsidyNeedUsd.minus(subsidyAppliedUsd));

          const usedTodayAfter = usedToday.plus(subsidyAppliedUsd);
          dailyApplied.set(dayKey, usedTodayAfter);
          treasuryBalance = treasuryBalance.minus(subsidyAppliedUsd);

          rows.push({
            model,
            tierName: tier.tierName,
            entryTsIso: entry.tsIso,
            exitTsIso: exit.tsIso,
            tenorDays,
            protectedNotionalUsd: toFixed(protectedNotional),
            entryPriceUsd: toFixed(entry.price),
            triggerPriceUsd: toFixed(triggerPriceUsd),
            expiryPriceUsd: toFixed(exit.price),
            premiumUsd: toFixed(premiumUsd),
            hedgeCostUsd: toFixed(hedgeCostUsd),
            hedgeRecoveredUsd: toFixed(hedgeRecoveredUsd),
            hedgeNetCostUsd: toFixed(hedgeNetCostUsd),
            payoutUsd: toFixed(payoutUsd),
            underwritingPnlUsd: toFixed(underwritingPnlUsd),
            subsidyNeedUsd: toFixed(subsidyNeedUsd),
            subsidyAppliedUsd: toFixed(subsidyAppliedUsd),
            subsidyBlockedUsd: toFixed(subsidyBlockedUsd),
            treasuryBalanceAfterUsd: toFixed(treasuryBalance)
          });
        }
      }
    }
  }

  const summary = buildSummary(rows);
  const out: BacktestOutput = {
    status: "ok",
    name: config.name,
    mode: args.mode,
    asOfIso: new Date().toISOString(),
    configPath: args.configPath,
    pricesPath: args.pricesCsvPath,
    rows,
    summary
  };

  await ensureParentDir(args.outJsonPath);
  await ensureParentDir(args.outCsvPath);
  await writeFile(args.outJsonPath, JSON.stringify(out, null, 2), "utf8");
  await writeFile(args.outCsvPath, formatCsv(rows), "utf8");

  console.log(
    JSON.stringify(
      {
        status: "ok",
        name: config.name,
        mode: args.mode,
        rows: rows.length,
        summaries: summary,
        outJson: args.outJsonPath,
        outCsv: args.outCsvPath
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
        reason: "pilot_backtest_failed",
        message: String(error?.message || error || "unknown_error")
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
