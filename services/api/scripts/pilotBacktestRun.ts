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
  breachMode?: "expiry_only" | "path_min";
  takeProfit?: {
    enabled?: boolean;
    reboundPct?: DecimalString;
    decayPct?: DecimalString;
  };
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
type BreachMode = "expiry_only" | "path_min";
type TakeProfitRule = "none" | "rebound" | "decay" | "expiry_after_breach" | "no_breach";
type TakeProfitRuntime = {
  enabled: boolean;
  reboundPct: Decimal;
  decayPct: Decimal;
};

type TradeRow = {
  model: ModelName;
  breachMode: BreachMode;
  takeProfitEnabled: boolean;
  tierName: string;
  entryTsIso: string;
  exitTsIso: string;
  tenorDays: number;
  protectedNotionalUsd: string;
  entryPriceUsd: string;
  triggerPriceUsd: string;
  pathMinPriceUsd: string;
  payoutReferencePriceUsd: string;
  expiryPriceUsd: string;
  breachObserved: boolean;
  takeProfitTriggered: boolean;
  takeProfitRule: TakeProfitRule;
  takeProfitCloseTsIso: string;
  takeProfitClosePriceUsd: string;
  premiumUsd: string;
  hedgeCostUsd: string;
  hedgeRecoveredBaselineUsd: string;
  hedgeRecoveredTpUsd: string;
  hedgeRecoveredDeltaVsBaselineUsd: string;
  hedgeRecoveredUsd: string;
  hedgeNetCostUsd: string;
  payoutUsd: string;
  underwritingPnlBaselineUsd: string;
  underwritingPnlTpUsd: string;
  underwritingPnlDeltaVsBaselineUsd: string;
  underwritingPnlUsd: string;
  subsidyNeedBaselineUsd: string;
  subsidyNeedTpUsd: string;
  subsidyNeedDeltaVsBaselineUsd: string;
  subsidyNeedUsd: string;
  subsidyAppliedUsd: string;
  subsidyBlockedUsd: string;
  treasuryBalanceAfterUsd: string;
};

type SummaryModel = {
  model: ModelName;
  breachMode: BreachMode;
  takeProfitEnabled: boolean;
  trades: number;
  premiumTotalUsd: string;
  payoutTotalUsd: string;
  hedgeCostTotalUsd: string;
  hedgeRecoveredTotalUsd: string;
  hedgeNetCostTotalUsd: string;
  underwritingPnlTotalUsd: string;
  underwritingPnlPerTradeUsd: string;
  underwritingPnlBaselineTotalUsd: string;
  underwritingPnlTpTotalUsd: string;
  underwritingPnlImprovementUsd: string;
  subsidyNeedTotalUsd: string;
  subsidyNeedBaselineTotalUsd: string;
  subsidyNeedTpTotalUsd: string;
  subsidyNeedReductionUsd: string;
  subsidyAppliedTotalUsd: string;
  subsidyBlockedTotalUsd: string;
  hedgeRecoveredBaselineTotalUsd: string;
  hedgeRecoveredTpTotalUsd: string;
  hedgeRecoveredImprovementUsd: string;
  takeProfitTriggeredCount: number;
  takeProfitTriggeredRatePct: string;
  takeProfitUnderperformedCount: number;
  subsidyHitCount: number;
  subsidyBlockedCount: number;
  triggerHitCount: number;
  triggerHitRatePct: string;
  endTreasuryBalanceUsd: string;
};

type ExecutiveRiskModel = {
  model: ModelName;
  breachMode: BreachMode;
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
  mode: RunMode;
  breachMode: BreachMode;
  takeProfit: {
    enabled: boolean;
    reboundPct: string;
    decayPct: string;
  };
  treasury: {
    startingBalanceUsd: string;
    dailySubsidyCapUsd: string;
    perQuoteSubsidyCapPct: string;
  };
  asOfIso: string;
  configPath: string;
  pricesPath: string;
  rows: TradeRow[];
  summary: SummaryModel[];
  executiveRisk: ExecutiveRiskModel[];
};

type Args = {
  configPath: string;
  pricesCsvPath: string;
  outJsonPath: string;
  outCsvPath: string;
  mode: RunMode;
  breachModeOverride: BreachMode | null;
  tpEnabledOverride: boolean | null;
  tpReboundPctOverride: Decimal | null;
  tpDecayPctOverride: Decimal | null;
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
    mode: "both",
    breachModeOverride: null,
    tpEnabledOverride: null,
    tpReboundPctOverride: null,
    tpDecayPctOverride: null
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
    if (token === "--breach-mode" && argv[i + 1]) {
      const breachMode = String(argv[i + 1]).trim().toLowerCase();
      if (breachMode === "expiry_only" || breachMode === "path_min") {
        args.breachModeOverride = breachMode;
      } else {
        throw new Error(`invalid_breach_mode:${breachMode}`);
      }
      i += 1;
      continue;
    }
    if (token === "--tp-enabled" && argv[i + 1]) {
      const raw = String(argv[i + 1]).trim().toLowerCase();
      if (raw === "true" || raw === "1" || raw === "yes") {
        args.tpEnabledOverride = true;
      } else if (raw === "false" || raw === "0" || raw === "no") {
        args.tpEnabledOverride = false;
      } else {
        throw new Error(`invalid_tp_enabled:${raw}`);
      }
      i += 1;
      continue;
    }
    if (token === "--tp-rebound-pct" && argv[i + 1]) {
      const value = parseDecimal(argv[i + 1], "tp_rebound_pct");
      if (value.lt(0)) throw new Error("invalid_tp_rebound_pct:negative");
      args.tpReboundPctOverride = value;
      i += 1;
      continue;
    }
    if (token === "--tp-decay-pct" && argv[i + 1]) {
      const value = parseDecimal(argv[i + 1], "tp_decay_pct");
      if (value.lt(0)) throw new Error("invalid_tp_decay_pct:negative");
      args.tpDecayPctOverride = value;
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

const parseBreachMode = (raw: unknown, fallback: BreachMode): BreachMode => {
  const normalized = String(raw || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "expiry_only" || normalized === "path_min") return normalized;
  throw new Error(`invalid_breach_mode:${String(raw || "").trim() || "empty"}`);
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
  if (parsed.takeProfit) {
    if (parsed.takeProfit.reboundPct !== undefined) {
      parseDecimal(parsed.takeProfit.reboundPct, "takeProfit.reboundPct");
    }
    if (parsed.takeProfit.decayPct !== undefined) {
      parseDecimal(parsed.takeProfit.decayPct, "takeProfit.decayPct");
    }
  }

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
  payoutReferencePriceUsd: Decimal;
}): Decimal => {
  if (params.payoutReferencePriceUsd.gte(params.triggerPriceUsd)) return ZERO;
  const belowTrigger = params.triggerPriceUsd.minus(params.payoutReferencePriceUsd);
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

const findPathMinPrice = (prices: PricePoint[], entryIdx: number, exitIdx: number): Decimal => {
  let minPrice = prices[entryIdx].price;
  for (let i = entryIdx; i <= exitIdx; i += 1) {
    if (prices[i].price.lt(minPrice)) minPrice = prices[i].price;
  }
  return minPrice;
};

const resolveTakeProfitRuntime = (config: BacktestConfig, args: Args): TakeProfitRuntime => {
  const configEnabledRaw = String(config.takeProfit?.enabled ?? "false").trim().toLowerCase();
  const enabledFromConfig = configEnabledRaw === "true" || configEnabledRaw === "1" || configEnabledRaw === "yes";
  const enabled = args.tpEnabledOverride ?? enabledFromConfig;
  const reboundPct = args.tpReboundPctOverride ?? parseDecimal(config.takeProfit?.reboundPct ?? "2", "takeProfit.reboundPct");
  const decayPct = args.tpDecayPctOverride ?? parseDecimal(config.takeProfit?.decayPct ?? "2", "takeProfit.decayPct");

  if (reboundPct.lt(0)) throw new Error("invalid_take_profit_rebound_pct:negative");
  if (decayPct.lt(0)) throw new Error("invalid_take_profit_decay_pct:negative");

  return { enabled, reboundPct, decayPct };
};

const evaluateTakeProfit = (params: {
  prices: PricePoint[];
  entryIdx: number;
  exitIdx: number;
  triggerPrice: Decimal;
  tp: TakeProfitRuntime;
}): { tpTriggered: boolean; tpRule: TakeProfitRule; closeIndex: number; closePrice: Decimal } => {
  const expiryClose = {
    closeIndex: params.exitIdx,
    closePrice: params.prices[params.exitIdx].price
  };
  if (!params.tp.enabled) {
    return {
      tpTriggered: false,
      tpRule: "none",
      ...expiryClose
    };
  }

  let breached = false;
  let minAfterBreach: Decimal | null = null;
  let peakIntrinsic = ZERO;

  for (let i = params.entryIdx; i <= params.exitIdx; i += 1) {
    const px = params.prices[i].price;
    const intrinsic = Decimal.max(ZERO, params.triggerPrice.minus(px));

    if (!breached && intrinsic.gt(0)) {
      breached = true;
      minAfterBreach = px;
      peakIntrinsic = intrinsic;
    }
    if (!breached) continue;

    if (px.lt(minAfterBreach!)) minAfterBreach = px;
    if (intrinsic.gt(peakIntrinsic)) peakIntrinsic = intrinsic;

    if (params.tp.reboundPct.gt(0) && minAfterBreach!.gt(0)) {
      const reboundPct = px.minus(minAfterBreach!).div(minAfterBreach!).mul(100);
      if (reboundPct.gte(params.tp.reboundPct)) {
        return {
          tpTriggered: true,
          tpRule: "rebound",
          closeIndex: i,
          closePrice: px
        };
      }
    }

    if (params.tp.decayPct.gt(0) && peakIntrinsic.gt(0)) {
      const decayPct = peakIntrinsic.minus(intrinsic).div(peakIntrinsic).mul(100);
      if (decayPct.gte(params.tp.decayPct)) {
        return {
          tpTriggered: true,
          tpRule: "decay",
          closeIndex: i,
          closePrice: px
        };
      }
    }
  }

  if (breached) {
    return {
      tpTriggered: false,
      tpRule: "expiry_after_breach",
      ...expiryClose
    };
  }

  return {
    tpTriggered: false,
    tpRule: "no_breach",
    ...expiryClose
  };
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

const percentile = (items: Decimal[], p: number): Decimal => {
  if (!items.length) return ZERO;
  const sorted = items.slice().sort((a, b) => a.comparedTo(b));
  const clamped = Math.max(0, Math.min(1, p));
  const rank = Math.ceil(clamped * sorted.length) - 1;
  const idx = Math.max(0, Math.min(sorted.length - 1, rank));
  return sorted[idx];
};

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
    const pnlBaseline = subset.map((row) => new Decimal(row.underwritingPnlBaselineUsd));
    const pnlTp = subset.map((row) => new Decimal(row.underwritingPnlTpUsd));
    const subsidyNeedBaseline = subset.map((row) => new Decimal(row.subsidyNeedBaselineUsd));
    const subsidyNeedTp = subset.map((row) => new Decimal(row.subsidyNeedTpUsd));
    const hedgeRecoveredBaseline = subset.map((row) => new Decimal(row.hedgeRecoveredBaselineUsd));
    const hedgeRecoveredTp = subset.map((row) => new Decimal(row.hedgeRecoveredTpUsd));
    const triggerHits = subset.filter((row) => row.breachObserved).length;
    const subsidyHits = subset.filter((row) => new Decimal(row.subsidyAppliedUsd).gt(0)).length;
    const subsidyBlockedCount = subset.filter((row) => new Decimal(row.subsidyBlockedUsd).gt(0)).length;
    const endBalance = new Decimal(subset[subset.length - 1].treasuryBalanceAfterUsd);
    const tradeCount = subset.length;
    const takeProfitTriggeredCount = subset.filter((row) => row.takeProfitTriggered).length;
    const takeProfitTriggeredRatePct = new Decimal(takeProfitTriggeredCount).div(tradeCount).mul(100).toFixed(4);
    const takeProfitUnderperformedCount = subset.filter((row) => new Decimal(row.underwritingPnlDeltaVsBaselineUsd).lt(0)).length;

    const underwritingPnlBaselineTotal = sumDecimals(pnlBaseline);
    const underwritingPnlTpTotal = sumDecimals(pnlTp);
    const underwritingPnlImprovement = underwritingPnlTpTotal.minus(underwritingPnlBaselineTotal);
    const subsidyNeedBaselineTotal = sumDecimals(subsidyNeedBaseline);
    const subsidyNeedTpTotal = sumDecimals(subsidyNeedTp);
    const subsidyNeedReduction = subsidyNeedBaselineTotal.minus(subsidyNeedTpTotal);
    const hedgeRecoveredBaselineTotal = sumDecimals(hedgeRecoveredBaseline);
    const hedgeRecoveredTpTotal = sumDecimals(hedgeRecoveredTp);
    const hedgeRecoveredImprovement = hedgeRecoveredTpTotal.minus(hedgeRecoveredBaselineTotal);

    summary.push({
      model,
      breachMode: subset[0].breachMode,
      takeProfitEnabled: subset[0].takeProfitEnabled,
      trades: tradeCount,
      premiumTotalUsd: toFixed(sumDecimals(premiums)),
      payoutTotalUsd: toFixed(sumDecimals(payouts)),
      hedgeCostTotalUsd: toFixed(sumDecimals(hedgeCosts)),
      hedgeRecoveredTotalUsd: toFixed(sumDecimals(hedgeRecovered)),
      hedgeNetCostTotalUsd: toFixed(sumDecimals(hedgeNetCosts)),
      underwritingPnlTotalUsd: toFixed(sumDecimals(pnl)),
      underwritingPnlPerTradeUsd: toFixed(sumDecimals(pnl).div(tradeCount)),
      underwritingPnlBaselineTotalUsd: toFixed(underwritingPnlBaselineTotal),
      underwritingPnlTpTotalUsd: toFixed(underwritingPnlTpTotal),
      underwritingPnlImprovementUsd: toFixed(underwritingPnlImprovement),
      subsidyNeedTotalUsd: toFixed(sumDecimals(subsidyNeed)),
      subsidyNeedBaselineTotalUsd: toFixed(subsidyNeedBaselineTotal),
      subsidyNeedTpTotalUsd: toFixed(subsidyNeedTpTotal),
      subsidyNeedReductionUsd: toFixed(subsidyNeedReduction),
      subsidyAppliedTotalUsd: toFixed(sumDecimals(subsidyApplied)),
      subsidyBlockedTotalUsd: toFixed(sumDecimals(subsidyBlocked)),
      hedgeRecoveredBaselineTotalUsd: toFixed(hedgeRecoveredBaselineTotal),
      hedgeRecoveredTpTotalUsd: toFixed(hedgeRecoveredTpTotal),
      hedgeRecoveredImprovementUsd: toFixed(hedgeRecoveredImprovement),
      takeProfitTriggeredCount,
      takeProfitTriggeredRatePct,
      takeProfitUnderperformedCount,
      subsidyHitCount: subsidyHits,
      subsidyBlockedCount,
      triggerHitCount: triggerHits,
      triggerHitRatePct: new Decimal(triggerHits).div(tradeCount).mul(100).toFixed(4),
      endTreasuryBalanceUsd: toFixed(endBalance)
    });
  }

  return summary;
};

const buildExecutiveRisk = (rows: TradeRow[], startingTreasury: Decimal): ExecutiveRiskModel[] => {
  const models: ModelName[] = ["strict", "hybrid"];
  const out: ExecutiveRiskModel[] = [];
  for (const model of models) {
    const subset = rows.filter((row) => row.model === model);
    if (!subset.length) continue;

    const tradeCount = subset.length;
    const losses = subset.map((row) => Decimal.max(ZERO, new Decimal(row.underwritingPnlUsd).negated()));
    const losingTradeCount = losses.filter((value) => value.gt(0)).length;
    const losingTradeRatePct = new Decimal(losingTradeCount).div(tradeCount).mul(100).toFixed(4);
    const p95Loss = percentile(losses, 0.95);

    const dayNeeds = new Map<string, Decimal>();
    for (const row of subset) {
      const day = row.entryTsIso.slice(0, 10);
      const running = dayNeeds.get(day) || ZERO;
      dayNeeds.set(day, running.plus(new Decimal(row.subsidyNeedUsd)));
    }
    let worstDayNeed = ZERO;
    let worstDayNeedDate: string | null = null;
    for (const [day, value] of dayNeeds.entries()) {
      if (value.gt(worstDayNeed)) {
        worstDayNeed = value;
        worstDayNeedDate = day;
      }
    }

    let peak = startingTreasury;
    let maxDrawdown = ZERO;
    for (const row of subset) {
      const balance = new Decimal(row.treasuryBalanceAfterUsd);
      if (balance.gt(peak)) peak = balance;
      const dd = peak.minus(balance);
      if (dd.gt(maxDrawdown)) maxDrawdown = dd;
    }
    const maxDrawdownPct = peak.gt(0) ? maxDrawdown.div(peak).mul(100) : ZERO;

    const recommendedMinBuffer = Decimal.max(
      startingTreasury,
      worstDayNeed.mul("1.5"),
      p95Loss.mul(10),
      maxDrawdown.mul("1.25")
    );

    out.push({
      model,
      breachMode: subset[0].breachMode,
      trades: tradeCount,
      losingTradeCount,
      losingTradeRatePct,
      worstDaySubsidyNeedUsd: toFixed(worstDayNeed),
      worstDaySubsidyNeedDate: worstDayNeedDate,
      lossP95PerTradeUsd: toFixed(p95Loss),
      maxDrawdownUsd: toFixed(maxDrawdown),
      maxDrawdownPct: maxDrawdownPct.toFixed(4),
      recommendedMinTreasuryBufferUsd: toFixed(recommendedMinBuffer),
      recommendedBufferFormula:
        "max(startingTreasury, 1.5x worstDaySubsidyNeed, 10x p95LossPerTrade, 1.25x maxDrawdown)"
    });
  }
  return out;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig(args.configPath);
  const breachMode = args.breachModeOverride || parseBreachMode(config.breachMode, "path_min");
  const tp = resolveTakeProfitRuntime(config, args);
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
          const pathMinPriceUsd = findPathMinPrice(prices, entryIdx, exitIdx);
          const payoutReferencePriceUsd = breachMode === "path_min" ? pathMinPriceUsd : exit.price;
          const breachObserved = payoutReferencePriceUsd.lt(triggerPriceUsd);
          const payoutCap = computeDrawdownLossBudgetUsd(protectedNotional, drawdownFloorPct);
          const payoutRaw = computePayoutLong({
            protectedNotionalUsd: protectedNotional,
            entryPriceUsd: entry.price,
            triggerPriceUsd,
            payoutReferencePriceUsd
          });
          const payoutUsd = Decimal.min(payoutRaw, payoutCap);

          const hedgeReferenceBaselinePriceUsd = exit.price;
          const tpEval = evaluateTakeProfit({
            prices,
            entryIdx,
            exitIdx,
            triggerPrice: triggerPriceUsd,
            tp
          });
          const hedgeReferenceTpPriceUsd = tpEval.closePrice;
          const hedgeRecoveredBaselineRaw = computePayoutLong({
            protectedNotionalUsd: protectedNotional,
            entryPriceUsd: entry.price,
            triggerPriceUsd,
            payoutReferencePriceUsd: hedgeReferenceBaselinePriceUsd
          });
          const hedgeRecoveredTpRaw = computePayoutLong({
            protectedNotionalUsd: protectedNotional,
            entryPriceUsd: entry.price,
            triggerPriceUsd,
            payoutReferencePriceUsd: hedgeReferenceTpPriceUsd
          });
          const hedgeRecoveredBaselineUsd = Decimal.min(hedgeRecoveredBaselineRaw, payoutCap).mul(hedgeRecoveryPct);
          const hedgeRecoveredTpUsd = Decimal.min(hedgeRecoveredTpRaw, payoutCap).mul(hedgeRecoveryPct);
          const hedgeRecoveredDeltaVsBaselineUsd = hedgeRecoveredTpUsd.minus(hedgeRecoveredBaselineUsd);
          const hedgeRecoveredUsd = tp.enabled ? hedgeRecoveredTpUsd : hedgeRecoveredBaselineUsd;
          const hedgeNetCostBaselineUsd = Decimal.max(ZERO, hedgeCostUsd.minus(hedgeRecoveredBaselineUsd));
          const hedgeNetCostTpUsd = Decimal.max(ZERO, hedgeCostUsd.minus(hedgeRecoveredTpUsd));
          const hedgeNetCostUsd = tp.enabled ? hedgeNetCostTpUsd : hedgeNetCostBaselineUsd;
          const underwritingPnlBaselineUsd = premiumUsd.minus(payoutUsd).minus(hedgeNetCostBaselineUsd);
          const underwritingPnlTpUsd = premiumUsd.minus(payoutUsd).minus(hedgeNetCostTpUsd);
          const underwritingPnlDeltaVsBaselineUsd = underwritingPnlTpUsd.minus(underwritingPnlBaselineUsd);
          const underwritingPnlUsd = tp.enabled ? underwritingPnlTpUsd : underwritingPnlBaselineUsd;
          const subsidyNeedBaselineUsd = Decimal.max(ZERO, underwritingPnlBaselineUsd.negated());
          const subsidyNeedTpUsd = Decimal.max(ZERO, underwritingPnlTpUsd.negated());
          const subsidyNeedDeltaVsBaselineUsd = subsidyNeedTpUsd.minus(subsidyNeedBaselineUsd);
          const subsidyNeedUsd = tp.enabled ? subsidyNeedTpUsd : subsidyNeedBaselineUsd;
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
            breachMode,
            takeProfitEnabled: tp.enabled,
            tierName: tier.tierName,
            entryTsIso: entry.tsIso,
            exitTsIso: exit.tsIso,
            tenorDays,
            protectedNotionalUsd: toFixed(protectedNotional),
            entryPriceUsd: toFixed(entry.price),
            triggerPriceUsd: toFixed(triggerPriceUsd),
            pathMinPriceUsd: toFixed(pathMinPriceUsd),
            payoutReferencePriceUsd: toFixed(payoutReferencePriceUsd),
            expiryPriceUsd: toFixed(exit.price),
            breachObserved,
            takeProfitTriggered: tpEval.tpTriggered,
            takeProfitRule: tpEval.tpRule,
            takeProfitCloseTsIso: prices[tpEval.closeIndex].tsIso,
            takeProfitClosePriceUsd: toFixed(tpEval.closePrice),
            premiumUsd: toFixed(premiumUsd),
            hedgeCostUsd: toFixed(hedgeCostUsd),
            hedgeRecoveredBaselineUsd: toFixed(hedgeRecoveredBaselineUsd),
            hedgeRecoveredTpUsd: toFixed(hedgeRecoveredTpUsd),
            hedgeRecoveredDeltaVsBaselineUsd: toFixed(hedgeRecoveredDeltaVsBaselineUsd),
            hedgeRecoveredUsd: toFixed(hedgeRecoveredUsd),
            hedgeNetCostUsd: toFixed(hedgeNetCostUsd),
            payoutUsd: toFixed(payoutUsd),
            underwritingPnlBaselineUsd: toFixed(underwritingPnlBaselineUsd),
            underwritingPnlTpUsd: toFixed(underwritingPnlTpUsd),
            underwritingPnlDeltaVsBaselineUsd: toFixed(underwritingPnlDeltaVsBaselineUsd),
            underwritingPnlUsd: toFixed(underwritingPnlUsd),
            subsidyNeedBaselineUsd: toFixed(subsidyNeedBaselineUsd),
            subsidyNeedTpUsd: toFixed(subsidyNeedTpUsd),
            subsidyNeedDeltaVsBaselineUsd: toFixed(subsidyNeedDeltaVsBaselineUsd),
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
  const executiveRisk = buildExecutiveRisk(rows, startingTreasury);
  const out: BacktestOutput = {
    status: "ok",
    name: config.name,
    mode: args.mode,
    breachMode,
    takeProfit: {
      enabled: tp.enabled,
      reboundPct: toFixed(tp.reboundPct),
      decayPct: toFixed(tp.decayPct)
    },
    treasury: {
      startingBalanceUsd: toFixed(startingTreasury),
      dailySubsidyCapUsd: toFixed(dailyCap),
      perQuoteSubsidyCapPct: toFixed(perQuoteCapPct)
    },
    asOfIso: new Date().toISOString(),
    configPath: args.configPath,
    pricesPath: args.pricesCsvPath,
    rows,
    summary,
    executiveRisk
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
        breachMode,
        takeProfit: out.takeProfit,
        rows: rows.length,
        summaries: summary,
        executiveRisk,
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
