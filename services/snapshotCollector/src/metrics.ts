import Decimal from "decimal.js";
import type {
  ActivePositionDetail,
  ActivePositionsDetailResponse,
  PoolLedgerResponse
} from "./types.js";

export type DerivedLeg = {
  legId: string;
  venue: string | null;
  optionKind: string | null;
  strikeUsdc: number | null;
  expiryIso: string | null;
  contractsBtc: number | null;
  status: string | null;
  buyFillPriceUsdc: number | null;
  sellFillPriceUsdc: number | null;
};

export type DerivedPosition = {
  positionId: string;
  cellId: string | null;
  status: string | null;
  salvageState: string | null;
  triggerHighBtc: number | null;
  triggerLowBtc: number | null;
  payoutUsdc: number | null;
  dailyPremiumUsdc: number | null;
  hedgeBuyUsdc: number | null;
  hedgeSellUsdc: number | null;
  realizedSalvagePct: number | null;
  totalLegs: number;
  openLegs: number;
  soldLegs: number;
  failedLegs: number;
  legs: DerivedLeg[];
};

const safeNum = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const safeStr = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

export const derivePosition = (raw: ActivePositionDetail): DerivedPosition => {
  const legs = raw.legs ?? [];
  let openLegs = 0;
  let soldLegs = 0;
  let failedLegs = 0;
  for (const leg of legs) {
    if (leg.status === "open") openLegs++;
    else if (leg.status === "sold") soldLegs++;
    else if (leg.status === "failed") failedLegs++;
  }
  const hedgeBuy = safeNum(raw.hedgeBuyUsdc);
  const hedgeSell = safeNum(raw.hedgeSellUsdc);
  const salvagePct =
    hedgeBuy !== null && hedgeBuy > 0 && hedgeSell !== null
      ? new Decimal(hedgeSell).div(hedgeBuy).toNumber()
      : null;

  return {
    positionId: raw.id,
    cellId: safeStr(raw.cellId),
    status: safeStr(raw.status),
    salvageState: safeStr(raw.salvageState),
    triggerHighBtc: safeNum(raw.triggerHighBtc),
    triggerLowBtc: safeNum(raw.triggerLowBtc),
    payoutUsdc: safeNum(raw.payoutUsdc),
    dailyPremiumUsdc: safeNum(raw.dailyPremiumUsdc),
    hedgeBuyUsdc: hedgeBuy,
    hedgeSellUsdc: hedgeSell,
    realizedSalvagePct: salvagePct,
    totalLegs: legs.length,
    openLegs,
    soldLegs,
    failedLegs,
    legs: legs.map((l) => ({
      legId: l.id,
      venue: safeStr(l.venue),
      optionKind: safeStr(l.optionKind),
      strikeUsdc: safeNum(l.strikeUsdc),
      expiryIso: safeStr(l.expiryIso),
      contractsBtc: safeNum(l.contractsBtc),
      status: safeStr(l.status),
      buyFillPriceUsdc: safeNum(l.buyFillPriceUsdc),
      sellFillPriceUsdc: safeNum(l.sellFillPriceUsdc)
    }))
  };
};

export const deriveAllPositions = (
  raw: ActivePositionsDetailResponse
): DerivedPosition[] => raw.positions.map(derivePosition);

// ─────────────────────────────────────────────────────────────────────
// Daily roll-up — computed from pool ledger entries that landed in the
// previous UTC day. Combines premium intake, hedge cost, and payout flows
// into a single Atticus P&L number per day.
// ─────────────────────────────────────────────────────────────────────

export type DerivedDailyMetrics = {
  dateUtc: string;
  cellsObserved: Record<string, number>;
  closedPositionsCount: number;
  triggeredCount: number;
  noTriggerCount: number;
  failedCount: number;
  avgSalvagePct: number | null;
  medianSalvagePct: number | null;
  totalPremiumInUsdc: number;
  totalHedgeBuyUsdc: number;
  totalHedgeSellUsdc: number;
  totalPayoutOutUsdc: number;
  netAtticusPnlUsdc: number;
  ruleFiringCounts: Record<string, number>;
};

export type DailyInput = {
  dateUtc: string;
  closedPositions: ReadonlyArray<DerivedPosition>;
  atticusLedger: PoolLedgerResponse | null;
  foxifyLedger: PoolLedgerResponse | null;
  ruleFirings: ReadonlyArray<{ rule?: number; action?: string }>;
};

const median = (xs: ReadonlyArray<number>): number | null => {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
};

const avg = (xs: ReadonlyArray<number>): number | null => {
  if (xs.length === 0) return null;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
};

export const computeDailyMetrics = (input: DailyInput): DerivedDailyMetrics => {
  const cellsObserved: Record<string, number> = {};
  let triggeredCount = 0;
  let noTriggerCount = 0;
  let failedCount = 0;
  const salvages: number[] = [];

  for (const p of input.closedPositions) {
    if (p.cellId) cellsObserved[p.cellId] = (cellsObserved[p.cellId] ?? 0) + 1;
    if (p.status === "triggered" || p.salvageState === "salvaging" || p.salvageState === "salvaged") {
      triggeredCount++;
    } else if (p.status === "closed" || p.status === "expired") {
      noTriggerCount++;
    } else if (p.status === "failed") {
      failedCount++;
    }
    if (p.realizedSalvagePct !== null) salvages.push(p.realizedSalvagePct);
  }

  const totalPremiumIn = (input.foxifyLedger?.entries ?? [])
    .filter((e) => e.kind === "premium_in")
    .reduce((s, e) => s + (e.amountUsdc ?? 0), 0);

  const totalHedgeBuy = (input.atticusLedger?.entries ?? [])
    .filter((e) => e.kind === "hedge_buy_out")
    .reduce((s, e) => s + Math.abs(e.amountUsdc ?? 0), 0);

  const totalHedgeSell = (input.atticusLedger?.entries ?? [])
    .filter((e) => e.kind === "hedge_sell_in")
    .reduce((s, e) => s + (e.amountUsdc ?? 0), 0);

  const totalPayoutOut = (input.foxifyLedger?.entries ?? [])
    .filter((e) => e.kind === "payout_out")
    .reduce((s, e) => s + Math.abs(e.amountUsdc ?? 0), 0);

  const netPnl = totalPremiumIn + totalHedgeSell - totalHedgeBuy - totalPayoutOut;

  const ruleFiringCounts: Record<string, number> = {};
  for (const r of input.ruleFirings) {
    const key = r.rule != null ? `rule_${r.rule}_${r.action ?? "unknown"}` : "rule_unknown";
    ruleFiringCounts[key] = (ruleFiringCounts[key] ?? 0) + 1;
  }

  return {
    dateUtc: input.dateUtc,
    cellsObserved,
    closedPositionsCount: triggeredCount + noTriggerCount + failedCount,
    triggeredCount,
    noTriggerCount,
    failedCount,
    avgSalvagePct: avg(salvages),
    medianSalvagePct: median(salvages),
    totalPremiumInUsdc: totalPremiumIn,
    totalHedgeBuyUsdc: totalHedgeBuy,
    totalHedgeSellUsdc: totalHedgeSell,
    totalPayoutOutUsdc: totalPayoutOut,
    netAtticusPnlUsdc: netPnl,
    ruleFiringCounts
  };
};
