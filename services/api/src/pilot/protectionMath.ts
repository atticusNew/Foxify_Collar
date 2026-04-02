import Decimal from "decimal.js";
import { computeTriggerPrice, normalizeProtectionType } from "./floor";
import type { ProtectionRecord, ProtectionType } from "./types";

const ZERO = new Decimal(0);
const ONE = new Decimal(1);

const parsePositiveDecimal = (value: unknown): Decimal | null => {
  try {
    const parsed = new Decimal(value as Decimal.Value);
    if (!parsed.isFinite() || parsed.lte(0)) return null;
    return parsed;
  } catch {
    return null;
  }
};

const inferProtectionTypeFromInstrument = (instrumentId: string | null | undefined): ProtectionType => {
  const normalized = String(instrumentId || "").toUpperCase();
  return normalized.endsWith("-C") ? "short" : "long";
};

export const resolveProtectionType = (params: {
  instrumentId?: string | null;
  metadata?: Record<string, unknown>;
}): ProtectionType =>
  normalizeProtectionType(
    String(params.metadata?.protectionType || inferProtectionTypeFromInstrument(params.instrumentId))
  );

export const computeDrawdownLossBudgetUsd = (
  protectedNotional: Decimal,
  drawdownFloorPct: Decimal
): Decimal => {
  if (!protectedNotional.isFinite() || !drawdownFloorPct.isFinite()) return ZERO;
  if (protectedNotional.lte(0) || drawdownFloorPct.lte(0)) return ZERO;
  return Decimal.min(protectedNotional, protectedNotional.mul(drawdownFloorPct));
};

export const isDrawdownBreached = (params: {
  protectionType: ProtectionType;
  triggerPrice: Decimal;
  referencePrice: Decimal;
}): boolean => {
  if (!params.referencePrice.isFinite() || !params.triggerPrice.isFinite()) return false;
  if (params.referencePrice.lte(0) || params.triggerPrice.lte(0)) return false;
  return params.protectionType === "short"
    ? params.referencePrice.greaterThanOrEqualTo(params.triggerPrice)
    : params.referencePrice.lessThanOrEqualTo(params.triggerPrice);
};

export const resolveTriggerEconomicsFromProtection = (
  protection: ProtectionRecord
): {
  protectionType: ProtectionType;
  entryPrice: Decimal;
  drawdownFloorPct: Decimal;
  triggerPrice: Decimal;
  protectedNotional: Decimal;
  triggerPayoutCreditUsd: Decimal;
} | null => {
  const entryPrice = parsePositiveDecimal(protection.entryPrice);
  const protectedNotional = parsePositiveDecimal(protection.protectedNotional);
  if (!entryPrice || !protectedNotional) return null;
  const drawdownFloorPct = parsePositiveDecimal(protection.drawdownFloorPct) || new Decimal("0.2");
  const protectionType = resolveProtectionType(protection);
  const triggerPrice =
    parsePositiveDecimal(protection.floorPrice) ||
    computeTriggerPrice(entryPrice, Decimal.min(ONE, drawdownFloorPct), protectionType);
  const triggerPayoutCreditUsd = computeDrawdownLossBudgetUsd(protectedNotional, drawdownFloorPct);
  return {
    protectionType,
    entryPrice,
    drawdownFloorPct,
    triggerPrice,
    protectedNotional,
    triggerPayoutCreditUsd
  };
};

