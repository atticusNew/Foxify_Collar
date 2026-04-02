import Decimal from "decimal.js";
import { DeribitConnector } from "@foxify/connectors";
import { resolvePremiumPricing } from "./pricingPolicy";
import { normalizeTierName, resolveDrawdownFloorPct } from "./floor";
import { pilotConfig } from "./config";

export type PricingComparisonInput = {
  scenarioId: string;
  tierName: string;
  protectedNotionalUsd: Decimal;
  drawdownFloorPct: Decimal;
  hedgePremiumUsd: Decimal;
  brokerFeesUsd: Decimal;
  spotPriceUsd?: Decimal | null;
  quoteInstrumentId?: string | null;
};

export type PricingComparisonRow = {
  scenarioId: string;
  asOfIso: string;
  tierName: string;
  protectedNotionalUsd: string;
  drawdownFloorPct: string;
  hedgePremiumUsd: string;
  brokerFeesUsd: string;
  strictClientPremiumUsd: string;
  hybridClientPremiumUsd: string;
  strictMethod: string;
  hybridMethod: string;
  premiumDeltaUsd: string;
  premiumDeltaPct: string;
  strictExpectedClaimsUsd: string;
  hybridExpectedClaimsUsd: string;
  strictTriggerProb: string;
  hybridTriggerProb: string;
  quoteInstrumentId: string | null;
  spotPriceUsd: string | null;
};

export type ComparisonOutput = {
  asOfIso: string;
  rows: PricingComparisonRow[];
  summary: {
    nRows: number;
    strictMeanPremiumUsd: string;
    hybridMeanPremiumUsd: string;
    meanDeltaUsd: string;
    medianDeltaUsd: string;
    positiveDeltaCount: number;
    negativeDeltaCount: number;
    zeroDeltaCount: number;
  };
};

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const toFixed = (value: Decimal.Value, dp = 10): string => new Decimal(value).toFixed(dp);

const parseDecimal = (value: unknown, fallback: Decimal): Decimal => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return new Decimal(n);
};

const parsePositiveDecimal = (value: unknown, fallback: Decimal): Decimal => {
  const parsed = parseDecimal(value, fallback);
  return parsed.gt(0) ? parsed : fallback;
};

const median = (items: Decimal[]): Decimal => {
  if (items.length === 0) return new Decimal(0);
  const sorted = items.slice().sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : sorted[mid - 1].plus(sorted[mid]).div(2);
};

const buildSummary = (rows: PricingComparisonRow[]) => {
  const strictPremiums = rows.map((row) => new Decimal(row.strictClientPremiumUsd));
  const hybridPremiums = rows.map((row) => new Decimal(row.hybridClientPremiumUsd));
  const deltas = rows.map((row) => new Decimal(row.premiumDeltaUsd));
  const n = rows.length;
  const strictMean = n > 0 ? strictPremiums.reduce((acc, cur) => acc.plus(cur), new Decimal(0)).div(n) : new Decimal(0);
  const hybridMean = n > 0 ? hybridPremiums.reduce((acc, cur) => acc.plus(cur), new Decimal(0)).div(n) : new Decimal(0);
  const meanDelta = n > 0 ? deltas.reduce((acc, cur) => acc.plus(cur), new Decimal(0)).div(n) : new Decimal(0);
  const medianDelta = median(deltas);
  const positiveDeltaCount = deltas.filter((item) => item.gt(0)).length;
  const negativeDeltaCount = deltas.filter((item) => item.lt(0)).length;
  const zeroDeltaCount = deltas.length - positiveDeltaCount - negativeDeltaCount;
  return {
    nRows: n,
    strictMeanPremiumUsd: toFixed(strictMean),
    hybridMeanPremiumUsd: toFixed(hybridMean),
    meanDeltaUsd: toFixed(meanDelta),
    medianDeltaUsd: toFixed(medianDelta),
    positiveDeltaCount,
    negativeDeltaCount,
    zeroDeltaCount
  };
};

export const comparePricingModels = (inputs: PricingComparisonInput[], asOfIso = new Date().toISOString()): ComparisonOutput => {
  const rows: PricingComparisonRow[] = inputs.map((input) => {
    const strict = resolvePremiumPricing({
      pricingMode: "actuarial_strict",
      tierName: input.tierName,
      protectedNotional: input.protectedNotionalUsd,
      drawdownFloorPct: input.drawdownFloorPct,
      hedgePremium: input.hedgePremiumUsd,
      brokerFees: input.brokerFeesUsd
    });
    const hybrid = resolvePremiumPricing({
      pricingMode: "hybrid_otm_treasury",
      tierName: input.tierName,
      protectedNotional: input.protectedNotionalUsd,
      drawdownFloorPct: input.drawdownFloorPct,
      hedgePremium: input.hedgePremiumUsd,
      brokerFees: input.brokerFeesUsd
    });
    const deltaUsd = hybrid.clientPremiumUsd.minus(strict.clientPremiumUsd);
    const deltaPct = strict.clientPremiumUsd.gt(0) ? deltaUsd.div(strict.clientPremiumUsd) : new Decimal(0);
    return {
      scenarioId: input.scenarioId,
      asOfIso,
      tierName: input.tierName,
      protectedNotionalUsd: toFixed(input.protectedNotionalUsd),
      drawdownFloorPct: toFixed(input.drawdownFloorPct),
      hedgePremiumUsd: toFixed(input.hedgePremiumUsd),
      brokerFeesUsd: toFixed(input.brokerFeesUsd),
      strictClientPremiumUsd: toFixed(strict.clientPremiumUsd),
      hybridClientPremiumUsd: toFixed(hybrid.clientPremiumUsd),
      strictMethod: strict.method,
      hybridMethod: hybrid.method,
      premiumDeltaUsd: toFixed(deltaUsd),
      premiumDeltaPct: toFixed(deltaPct),
      strictExpectedClaimsUsd: toFixed(strict.expectedClaimsUsd),
      hybridExpectedClaimsUsd: toFixed(hybrid.expectedClaimsUsd),
      strictTriggerProb: toFixed(strict.expectedTriggerProbCapped),
      hybridTriggerProb: toFixed(hybrid.expectedTriggerProbCapped),
      quoteInstrumentId: input.quoteInstrumentId || null,
      spotPriceUsd: input.spotPriceUsd ? toFixed(input.spotPriceUsd) : null
    };
  });
  return { asOfIso, rows, summary: buildSummary(rows) };
};

const escapeCsv = (value: string): string => {
  if (!value.includes(",") && !value.includes("\"") && !value.includes("\n")) return value;
  return `"${value.replace(/"/g, "\"\"")}"`;
};

export const comparisonRowsToCsv = (rows: PricingComparisonRow[]): string => {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  for (const row of rows) {
    const values = headers.map((header) => {
      const raw = (row as unknown as Record<string, unknown>)[header];
      if (raw === null || raw === undefined) return "";
      return escapeCsv(String(raw));
    });
    lines.push(values.join(","));
  }
  return lines.join("\n");
};

export const parseComparisonInputFixture = (raw: unknown): PricingComparisonInput[] => {
  const data = raw as { scenarios?: Array<Record<string, JsonValue>> };
  const scenarios = Array.isArray(data?.scenarios) ? data.scenarios : [];
  return scenarios.map((scenario, idx) => {
    const tierName = normalizeTierName(String(scenario.tierName || "Pro (Bronze)"));
    const protectedNotionalUsd = parsePositiveDecimal(scenario.protectedNotionalUsd, new Decimal(5000));
    const drawdownFloorPct = resolveDrawdownFloorPct({
      tierName,
      drawdownFloorPct: Number(scenario.drawdownFloorPct ?? NaN)
    });
    const hedgePremiumUsd = parsePositiveDecimal(scenario.hedgePremiumUsd, new Decimal(40));
    const brokerFeesUsd = parseDecimal(scenario.brokerFeesUsd, new Decimal(0));
    const spotPriceRaw = Number(scenario.spotPriceUsd ?? NaN);
    return {
      scenarioId: String(scenario.scenarioId || `scenario_${idx + 1}`),
      tierName,
      protectedNotionalUsd,
      drawdownFloorPct,
      hedgePremiumUsd,
      brokerFeesUsd,
      quoteInstrumentId: scenario.quoteInstrumentId ? String(scenario.quoteInstrumentId) : null,
      spotPriceUsd: Number.isFinite(spotPriceRaw) && spotPriceRaw > 0 ? new Decimal(spotPriceRaw) : null
    };
  });
};

const formatDeribitExpiryCode = (targetDate: Date): string => {
  const day = targetDate.getUTCDate();
  const year = targetDate.getUTCFullYear() % 100;
  const monthCode = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][
    targetDate.getUTCMonth()
  ];
  return `${day}${monthCode}${String(year).padStart(2, "0")}`;
};

const buildFallbackInstrumentId = (spot: number, tenorDays: number, floorPct: Decimal): string => {
  const expiry = new Date(Date.now() + tenorDays * 86400000);
  const expiryCode = formatDeribitExpiryCode(expiry);
  const strike = Math.max(1000, Math.round((spot * (1 - floorPct.toNumber())) / 250) * 250);
  return `BTC-${expiryCode}-${strike}-P`;
};

export const buildLiveDeribitComparisonInputs = async (params: {
  deribit: DeribitConnector;
  scenarios: Array<{
    scenarioId: string;
    tierName: string;
    protectedNotionalUsd: number;
    tenorDays?: number;
    quoteInstrumentId?: string;
    brokerFeesUsd?: number;
    drawdownFloorPct?: number;
  }>;
}): Promise<PricingComparisonInput[]> => {
  const spotPayload = (await params.deribit.getIndexPrice("btc_usd")) as any;
  const spot = Number(spotPayload?.result?.index_price ?? NaN);
  if (!Number.isFinite(spot) || spot <= 0) {
    throw new Error("compare_models_spot_unavailable");
  }
  const result: PricingComparisonInput[] = [];
  for (const scenario of params.scenarios) {
    const tierName = normalizeTierName(scenario.tierName);
    const drawdownFloorPct = resolveDrawdownFloorPct({
      tierName,
      drawdownFloorPct: scenario.drawdownFloorPct
    });
    const protectedNotionalUsd = new Decimal(Math.max(1, Number(scenario.protectedNotionalUsd || 0)));
    const quantity = protectedNotionalUsd.div(new Decimal(spot)).toDecimalPlaces(8).toNumber();
    const instrumentId =
      scenario.quoteInstrumentId || buildFallbackInstrumentId(spot, Math.max(1, Number(scenario.tenorDays || 7)), drawdownFloorPct);
    const book = (await params.deribit.getOrderBook(instrumentId)) as any;
    const bestAskBtc = Number(book?.result?.asks?.[0]?.[0] ?? book?.result?.best_ask_price ?? NaN);
    const markBtc = Number(book?.result?.mark_price ?? NaN);
    const unitBtc = Number.isFinite(bestAskBtc) && bestAskBtc > 0 ? bestAskBtc : markBtc;
    if (!Number.isFinite(unitBtc) || unitBtc <= 0) {
      throw new Error(`compare_models_orderbook_unavailable:${instrumentId}`);
    }
    const hedgePremiumUsd = new Decimal(unitBtc).mul(new Decimal(spot)).mul(new Decimal(quantity));
    result.push({
      scenarioId: scenario.scenarioId,
      tierName,
      protectedNotionalUsd,
      drawdownFloorPct,
      hedgePremiumUsd,
      brokerFeesUsd: new Decimal(Math.max(0, Number(scenario.brokerFeesUsd ?? pilotConfig.ibkrFeePerOrderUsd))),
      quoteInstrumentId: instrumentId,
      spotPriceUsd: new Decimal(spot)
    });
  }
  return result;
};
