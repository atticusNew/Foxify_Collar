import Decimal from "decimal.js";
import { DeribitConnector } from "@foxify/connectors";
import { normalizeTierName, resolveDrawdownFloorPct } from "./floor";
import { resolvePremiumPricing } from "./pricingPolicy";

type DeribitInstrumentPayload = {
  instrument_name?: string;
};

type TenorInstrumentCandidate = {
  instrumentId: string;
  expiry: Date;
  strikeUsd: number;
};

export type TenorComparisonRow = {
  scenarioId: string;
  asOfIso: string;
  tenorDaysRequested: number;
  tenorDaysSelected: string;
  tenorDriftDays: string;
  tierName: string;
  protectedNotionalUsd: string;
  instrumentId: string | null;
  expiryIso: string | null;
  spotPriceUsd: string;
  strikeUsd: string | null;
  hedgePremiumUsd: string | null;
  strictPremiumUsd: string | null;
  hybridPremiumUsd: string | null;
  premiumDeltaUsd: string | null;
  strictMethod: string | null;
  hybridMethod: string | null;
  hybridClaimsFloorHit: boolean;
  hybridImpliedSubsidyGapUsd: string | null;
  error: string | null;
};

export type TenorComparisonOutput = {
  asOfIso: string;
  venue: "deribit";
  env: "testnet" | "live";
  spotPriceUsd: string;
  tenorsRequestedDays: number[];
  tiers: string[];
  notionalsUsd: string[];
  rows: TenorComparisonRow[];
  summaryByTenor: Array<{
    tenorDaysRequested: number;
    nRows: number;
    nErrors: number;
    strictMeanPremiumUsd: string;
    hybridMeanPremiumUsd: string;
    meanDeltaUsd: string;
    meanImpliedSubsidyGapUsd: string;
  }>;
};

const MONTH_CODE_TO_INDEX: Record<string, number> = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11
};

const toFixed = (value: Decimal.Value, dp = 10): string => new Decimal(value).toFixed(dp);

const parseDeribitExpiryCode = (expiryCode: string): Date | null => {
  const normalized = String(expiryCode || "").trim().toUpperCase();
  if (normalized.length < 6 || normalized.length > 7) return null;
  const dayPart = normalized.slice(0, normalized.length - 5);
  const monthPart = normalized.slice(normalized.length - 5, normalized.length - 2);
  const yearPart = normalized.slice(normalized.length - 2);
  const day = Number(dayPart);
  const month = MONTH_CODE_TO_INDEX[monthPart];
  const year = 2000 + Number(yearPart);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  if (!Number.isInteger(month)) return null;
  if (!Number.isInteger(year) || year < 2000 || year > 2099) return null;
  return new Date(Date.UTC(year, month, day, 8, 0, 0, 0));
};

const parseDeribitPutInstrument = (instrumentId: string): TenorInstrumentCandidate | null => {
  const parts = String(instrumentId || "").trim().split("-");
  if (parts.length !== 4) return null;
  const [currency, expiryCode, strikeRaw, optionType] = parts;
  if (currency !== "BTC" || optionType !== "P") return null;
  const expiry = parseDeribitExpiryCode(expiryCode);
  const strikeUsd = Number(strikeRaw);
  if (!expiry || !Number.isFinite(strikeUsd) || strikeUsd <= 0) return null;
  return {
    instrumentId,
    expiry,
    strikeUsd
  };
};

const listPutCandidates = async (deribit: DeribitConnector): Promise<TenorInstrumentCandidate[]> => {
  const payload = (await deribit.listInstruments("BTC")) as { result?: DeribitInstrumentPayload[] };
  const rawInstruments = Array.isArray(payload?.result) ? payload.result : [];
  return rawInstruments
    .map((item) => parseDeribitPutInstrument(String(item?.instrument_name || "")))
    .filter((item): item is TenorInstrumentCandidate => Boolean(item));
};

const resolveBestAskBtc = async (
  deribit: DeribitConnector,
  instrumentId: string
): Promise<{ ok: true; unitPremiumBtc: number } | { ok: false }> => {
  const book = (await deribit.getOrderBook(instrumentId)) as any;
  const bestAskBtc = Number(book?.result?.asks?.[0]?.[0] ?? book?.result?.best_ask_price ?? NaN);
  const markBtc = Number(book?.result?.mark_price ?? NaN);
  const unitPremiumBtc = Number.isFinite(bestAskBtc) && bestAskBtc > 0 ? bestAskBtc : markBtc;
  if (!Number.isFinite(unitPremiumBtc) || unitPremiumBtc <= 0) {
    return { ok: false };
  }
  return { ok: true, unitPremiumBtc };
};

const selectCandidate = (params: {
  candidates: TenorInstrumentCandidate[];
  spotPriceUsd: Decimal;
  triggerPriceUsd: Decimal;
  requestedTenorDays: number;
  now: Date;
}): TenorInstrumentCandidate | null => {
  if (!params.candidates.length) return null;
  const targetTime = params.now.getTime() + params.requestedTenorDays * 86400000;
  const trigger = params.triggerPriceUsd.toNumber();
  const spot = params.spotPriceUsd.toNumber();
  const ranked = params.candidates
    .map((candidate) => {
      const tenorDistanceDays = Math.abs((candidate.expiry.getTime() - targetTime) / 86400000);
      const strikePenalty = candidate.strikeUsd < trigger ? 1000 : 0;
      const strikeDistancePct = Math.abs(candidate.strikeUsd - trigger) / spot;
      return {
        candidate,
        score: tenorDistanceDays * 10 + strikePenalty + strikeDistancePct
      };
    })
    .sort((a, b) => a.score - b.score);
  return ranked[0]?.candidate || null;
};

export const compareLiveDeribitByTenor = async (params: {
  deribit: DeribitConnector;
  env: "testnet" | "live";
  tenorsDays: number[];
  notionalsUsd: number[];
  tiers: string[];
  asOf?: Date;
}): Promise<TenorComparisonOutput> => {
  const now = params.asOf || new Date();
  const asOfIso = now.toISOString();
  const tenorsDays = Array.from(new Set(params.tenorsDays.map((value) => Math.max(1, Math.floor(value))))).sort(
    (a, b) => a - b
  );
  const notionalsUsd = Array.from(new Set(params.notionalsUsd.map((value) => Math.max(1, Math.floor(value))))).sort(
    (a, b) => a - b
  );
  const tiers = params.tiers.map((tier) => normalizeTierName(tier));
  const spotPayload = (await params.deribit.getIndexPrice("btc_usd")) as any;
  const spot = Number(spotPayload?.result?.index_price ?? NaN);
  if (!Number.isFinite(spot) || spot <= 0) {
    throw new Error("compare_tenors_spot_unavailable");
  }
  const spotPriceUsd = new Decimal(spot);
  const candidates = await listPutCandidates(params.deribit);
  const bookCache = new Map<string, { ok: true; unitPremiumBtc: number } | { ok: false }>();
  const rows: TenorComparisonRow[] = [];

  for (const tenorDays of tenorsDays) {
    for (const tierName of tiers) {
      const drawdownFloorPct = resolveDrawdownFloorPct({ tierName, drawdownFloorPct: undefined });
      const triggerPriceUsd = spotPriceUsd.mul(new Decimal(1).minus(drawdownFloorPct));
      const selected = selectCandidate({
        candidates,
        spotPriceUsd,
        triggerPriceUsd,
        requestedTenorDays: tenorDays,
        now
      });
      for (const notional of notionalsUsd) {
        const scenarioId = `${tierName.replace(/[^\w]+/g, "_").toLowerCase()}_${notional}_${tenorDays}d`;
        if (!selected) {
          rows.push({
            scenarioId,
            asOfIso,
            tenorDaysRequested: tenorDays,
            tenorDaysSelected: "",
            tenorDriftDays: "",
            tierName,
            protectedNotionalUsd: toFixed(notional, 2),
            instrumentId: null,
            expiryIso: null,
            spotPriceUsd: toFixed(spotPriceUsd, 4),
            strikeUsd: null,
            hedgePremiumUsd: null,
            strictPremiumUsd: null,
            hybridPremiumUsd: null,
            premiumDeltaUsd: null,
            strictMethod: null,
            hybridMethod: null,
            hybridClaimsFloorHit: false,
            hybridImpliedSubsidyGapUsd: null,
            error: "no_instrument_candidate"
          });
          continue;
        }
        if (!bookCache.has(selected.instrumentId)) {
          bookCache.set(selected.instrumentId, await resolveBestAskBtc(params.deribit, selected.instrumentId));
        }
        const cachedBook = bookCache.get(selected.instrumentId)!;
        if (!cachedBook.ok) {
          rows.push({
            scenarioId,
            asOfIso,
            tenorDaysRequested: tenorDays,
            tenorDaysSelected: "",
            tenorDriftDays: "",
            tierName,
            protectedNotionalUsd: toFixed(notional, 2),
            instrumentId: selected.instrumentId,
            expiryIso: selected.expiry.toISOString(),
            spotPriceUsd: toFixed(spotPriceUsd, 4),
            strikeUsd: toFixed(selected.strikeUsd, 2),
            hedgePremiumUsd: null,
            strictPremiumUsd: null,
            hybridPremiumUsd: null,
            premiumDeltaUsd: null,
            strictMethod: null,
            hybridMethod: null,
            hybridClaimsFloorHit: false,
            hybridImpliedSubsidyGapUsd: null,
            error: "orderbook_unavailable"
          });
          continue;
        }
        const protectedNotionalUsd = new Decimal(notional);
        const quantity = protectedNotionalUsd.div(spotPriceUsd);
        const hedgePremiumUsd = new Decimal(cachedBook.unitPremiumBtc).mul(spotPriceUsd).mul(quantity);
        const strict = resolvePremiumPricing({
          pricingMode: "actuarial_strict",
          tierName,
          protectedNotional: protectedNotionalUsd,
          drawdownFloorPct,
          hedgePremium: hedgePremiumUsd,
          brokerFees: new Decimal(0)
        });
        const hybrid = resolvePremiumPricing({
          pricingMode: "hybrid_otm_treasury",
          tierName,
          protectedNotional: protectedNotionalUsd,
          drawdownFloorPct,
          hedgePremium: hedgePremiumUsd,
          brokerFees: new Decimal(0)
        });
        const premiumDeltaUsd = hybrid.clientPremiumUsd.minus(strict.clientPremiumUsd);
        const hybridImpliedSubsidyGapUsd = Decimal.max(
          new Decimal(0),
          hybrid.premiumProfitabilityTargetUsd.minus(hybrid.clientPremiumUsd)
        );
        const tenorDaysSelected = new Decimal(selected.expiry.getTime() - now.getTime()).div(86400000);
        const tenorDaysSelectedRounded = tenorDaysSelected.toDecimalPlaces(4);
        rows.push({
          scenarioId,
          asOfIso,
          tenorDaysRequested: tenorDays,
          tenorDaysSelected: toFixed(tenorDaysSelectedRounded, 4),
          tenorDriftDays: toFixed(tenorDaysSelectedRounded.minus(tenorDays).abs(), 4),
          tierName,
          protectedNotionalUsd: toFixed(protectedNotionalUsd, 2),
          instrumentId: selected.instrumentId,
          expiryIso: selected.expiry.toISOString(),
          spotPriceUsd: toFixed(spotPriceUsd, 4),
          strikeUsd: toFixed(selected.strikeUsd, 2),
          hedgePremiumUsd: toFixed(hedgePremiumUsd, 10),
          strictPremiumUsd: toFixed(strict.clientPremiumUsd, 10),
          hybridPremiumUsd: toFixed(hybrid.clientPremiumUsd, 10),
          premiumDeltaUsd: toFixed(premiumDeltaUsd, 10),
          strictMethod: strict.method,
          hybridMethod: hybrid.method,
          hybridClaimsFloorHit: hybrid.method === "hybrid_claims_floor",
          hybridImpliedSubsidyGapUsd: toFixed(hybridImpliedSubsidyGapUsd, 10),
          error: null
        });
      }
    }
  }

  const summaryByTenor = tenorsDays.map((tenorDaysRequested) => {
    const scopedRows = rows.filter((row) => row.tenorDaysRequested === tenorDaysRequested);
    const okRows = scopedRows.filter((row) => !row.error);
    const nRows = okRows.length;
    const nErrors = scopedRows.length - nRows;
    const strictMean =
      nRows > 0
        ? okRows.reduce((acc, row) => acc.plus(new Decimal(row.strictPremiumUsd || 0)), new Decimal(0)).div(nRows)
        : new Decimal(0);
    const hybridMean =
      nRows > 0
        ? okRows.reduce((acc, row) => acc.plus(new Decimal(row.hybridPremiumUsd || 0)), new Decimal(0)).div(nRows)
        : new Decimal(0);
    const meanDelta =
      nRows > 0
        ? okRows.reduce((acc, row) => acc.plus(new Decimal(row.premiumDeltaUsd || 0)), new Decimal(0)).div(nRows)
        : new Decimal(0);
    const meanImpliedSubsidyGap =
      nRows > 0
        ? okRows
            .reduce((acc, row) => acc.plus(new Decimal(row.hybridImpliedSubsidyGapUsd || 0)), new Decimal(0))
            .div(nRows)
        : new Decimal(0);
    return {
      tenorDaysRequested,
      nRows,
      nErrors,
      strictMeanPremiumUsd: toFixed(strictMean, 10),
      hybridMeanPremiumUsd: toFixed(hybridMean, 10),
      meanDeltaUsd: toFixed(meanDelta, 10),
      meanImpliedSubsidyGapUsd: toFixed(meanImpliedSubsidyGap, 10)
    };
  });

  return {
    asOfIso,
    venue: "deribit",
    env: params.env,
    spotPriceUsd: toFixed(spotPriceUsd, 10),
    tenorsRequestedDays: tenorsDays,
    tiers,
    notionalsUsd: notionalsUsd.map((item) => toFixed(item, 2)),
    rows,
    summaryByTenor
  };
};
