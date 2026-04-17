import Decimal from "decimal.js";
import type { Pool } from "pg";
import { pilotConfig } from "./config";
import { computePutRecoveryValue } from "./blackScholes";
import { bsCall } from "./blackScholes";
import type { PilotVenueAdapter } from "./venue";

type ManagedHedge = {
  protectionId: string;
  instrumentId: string;
  venue: string;
  quantity: number;
  entryPremium: number;
  strike: number;
  floorPrice: number;
  expiryMs: number;
  hedgeStatus: string;
  slPct: number | null;
  payoutDueAmount: number;
  protectionType: string;
  status: string;
  triggerAtMs: number;
  metadata: Record<string, unknown>;
};

type HedgeManagementResult = {
  scanned: number;
  tpSold: number;
  salvaged: number;
  expired: number;
  errors: number;
  noBidRetries: number;
  skipped: number;
};

const RISK_FREE_RATE = 0;

// ── Base TP Timing Parameters (normal vol: DVOL 35-60) ──
const BASE_COOLING_HOURS = 0.5;
const BASE_DEEP_DROP_COOLING_HOURS = 0.167;
const BASE_PRIME_THRESHOLD_MULTIPLIER = 0.25;
const BASE_LATE_THRESHOLD_MULTIPLIER = 0.10;

// ── Fixed parameters (not vol-adjusted) ──
const DEEP_DROP_THRESHOLD_PCT = 1.5;
const BOUNCE_RECOVERY_MIN_VALUE = 3;
const PRIME_WINDOW_END_HOURS = 8;
const NEAR_EXPIRY_SALVAGE_HOURS = 6;
const NEAR_EXPIRY_MIN_VALUE = 3;
const ACTIVE_SALVAGE_HOURS = 4;
const ACTIVE_SALVAGE_MIN_VALUE = 5;

// ── DVOL regime boundaries ──
const DVOL_LOW = 35;
const DVOL_HIGH = 60;

// ── Gap-aware hold parameters ──
const GAP_SIGNIFICANT_PCT = 0.3;
const GAP_COOLING_EXTENSION_HOURS = 0.5;

type VolRegime = "low" | "normal" | "high";

const resolveVolRegime = (dvol: number): VolRegime => {
  if (dvol < DVOL_LOW) return "low";
  if (dvol > DVOL_HIGH) return "high";
  return "normal";
};

const resolveAdaptiveParams = (dvol: number) => {
  const regime = resolveVolRegime(dvol);
  switch (regime) {
    case "high":
      return {
        regime,
        coolingHours: 1.0,
        deepDropCoolingHours: 0.25,
        primeThreshold: 0.35,
        lateThreshold: 0.15,
        primeWindowEndHours: 10
      };
    case "low":
      return {
        regime,
        coolingHours: 0.25,
        deepDropCoolingHours: 0.1,
        primeThreshold: 0.15,
        lateThreshold: 0.05,
        primeWindowEndHours: 6
      };
    default:
      return {
        regime,
        coolingHours: BASE_COOLING_HOURS,
        deepDropCoolingHours: BASE_DEEP_DROP_COOLING_HOURS,
        primeThreshold: BASE_PRIME_THRESHOLD_MULTIPLIER,
        lateThreshold: BASE_LATE_THRESHOLD_MULTIPLIER,
        primeWindowEndHours: PRIME_WINDOW_END_HOURS
      };
  }
};

const computeStrikeFloorGapPct = (
  protectionType: string,
  strike: number,
  floorPrice: number
): number => {
  if (floorPrice <= 0 || strike <= 0) return 0;
  return Math.abs(strike - floorPrice) / floorPrice * 100;
};

const queryManagedHedges = async (pool: Pool): Promise<ManagedHedge[]> => {
  const result = await pool.query(`
    SELECT id, instrument_id, venue, size, premium, metadata, side,
           expiry_at, hedge_status, sl_pct, payout_due_amount, status,
           floor_price
    FROM pilot_protections
    WHERE hedge_status = 'active'
      AND instrument_id IS NOT NULL
      AND size IS NOT NULL
      AND (status = 'triggered' OR status = 'active' OR status LIKE 'expired%')
    ORDER BY expiry_at ASC
    LIMIT 200
  `);
  return result.rows.map((row: Record<string, unknown>) => {
    const meta = (row.metadata || {}) as Record<string, unknown>;
    const protType = String(meta.protectionType || row.side || "long");
    const instrumentId = String(row.instrument_id || "");
    const strikeMatch = instrumentId.match(/(\d+)-(P|C)$/);
    const optionStrike = strikeMatch ? Number(strikeMatch[1]) : 0;
    const floorRaw = Number(row.floor_price || meta.triggerPrice || meta.floorPrice || 0);
    return {
      protectionId: String(row.id),
      instrumentId,
      venue: String(row.venue || ""),
      quantity: Number(row.size || 0),
      entryPremium: Number(row.premium || 0),
      strike: optionStrike || Number(meta.triggerPrice || meta.floorPrice || 0),
      floorPrice: Number.isFinite(floorRaw) && floorRaw > 0 ? floorRaw : (optionStrike || 0),
      expiryMs: new Date(String(row.expiry_at)).getTime(),
      hedgeStatus: String(row.hedge_status || "active"),
      slPct: row.sl_pct !== null && row.sl_pct !== undefined ? Number(row.sl_pct) : null,
      payoutDueAmount: Number(row.payout_due_amount || 0),
      protectionType: protType === "short" ? "short" : "long",
      status: String(row.status || "active"),
      triggerAtMs: meta.triggerMonitorAt ? new Date(String(meta.triggerMonitorAt)).getTime() : (meta.triggerAt ? new Date(String(meta.triggerAt)).getTime() : 0),
      metadata: meta
    };
  });
};

const updateHedgeStatus = async (
  pool: Pool,
  protectionId: string,
  hedgeStatus: string,
  metadata: Record<string, unknown>
): Promise<void> => {
  await pool.query(
    `UPDATE pilot_protections
     SET hedge_status = $1, metadata = metadata || $2::jsonb, updated_at = NOW()
     WHERE id = $3`,
    [hedgeStatus, JSON.stringify(metadata), protectionId]
  );
};

const computeOptionValue = (params: {
  protectionType: string;
  currentSpot: number;
  strike: number;
  expiryMs: number;
  sigma: number;
  quantity: number;
  nowMs: number;
}): { totalValue: number; intrinsicValue: number; timeValue: number } => {
  if (params.protectionType === "short") {
    const T = Math.max(0, params.expiryMs - params.nowMs) / (365.25 * 24 * 3600 * 1000);
    const intrinsic = Math.max(0, params.currentSpot - params.strike);
    const total = T > 0 && params.sigma > 0
      ? bsCall(params.currentSpot, params.strike, T, RISK_FREE_RATE, params.sigma)
      : intrinsic;
    const timeVal = Math.max(0, total - intrinsic);
    return {
      totalValue: Math.max(intrinsic, total) * params.quantity,
      intrinsicValue: intrinsic * params.quantity,
      timeValue: timeVal * params.quantity
    };
  }
  const recovery = computePutRecoveryValue({
    currentSpot: params.currentSpot,
    strike: params.strike,
    expiryMs: params.expiryMs,
    sigma: params.sigma,
    riskFreeRate: RISK_FREE_RATE,
    nowMs: params.nowMs
  });
  return {
    totalValue: recovery.totalValue * params.quantity,
    intrinsicValue: recovery.intrinsicValue * params.quantity,
    timeValue: recovery.timeValue * params.quantity
  };
};

const computeDropDepthFromFloor = (
  protectionType: string,
  currentSpot: number,
  floorPrice: number
): number => {
  if (floorPrice <= 0) return 0;
  if (protectionType === "short") {
    return ((currentSpot - floorPrice) / floorPrice) * 100;
  }
  return ((floorPrice - currentSpot) / floorPrice) * 100;
};

const isProtectionBounced = (
  protectionType: string,
  currentSpot: number,
  floorPrice: number
): boolean => {
  if (protectionType === "short") return currentSpot < floorPrice;
  return currentSpot > floorPrice;
};

const isOptionOtm = (protectionType: string, currentSpot: number, strike: number): boolean => {
  if (protectionType === "short") return currentSpot < strike;
  return currentSpot > strike;
};

const executeSell = async (
  hedge: ManagedHedge,
  reason: string,
  optionVal: { totalValue: number; intrinsicValue: number; timeValue: number },
  sellOption: (p: { instrumentId: string; quantity: number }) => Promise<{ status: string; fillPrice: number; totalProceeds: number; orderId: string | null; details: Record<string, unknown> }>,
  pool: Pool
): Promise<"sold" | "no_bid" | "failed"> => {
  const sellQty = Math.max(0.1, Math.floor(hedge.quantity * 10) / 10);
  console.log(`[HedgeManager] Selling (${reason}): ${hedge.protectionId} instrument=${hedge.instrumentId} qty=${sellQty} value=$${optionVal.totalValue.toFixed(2)} intrinsic=$${optionVal.intrinsicValue.toFixed(2)} timeVal=$${optionVal.timeValue.toFixed(2)}`);

  try {
    const sellResult = await sellOption({
      instrumentId: hedge.instrumentId,
      quantity: sellQty
    });

    console.log(`[HedgeManager] Sell result: status=${sellResult.status} fillPrice=${sellResult.fillPrice.toFixed(2)} proceeds=${sellResult.totalProceeds.toFixed(2)} orderId=${sellResult.orderId}`);

    if (sellResult.status === "sold") {
      await updateHedgeStatus(pool, hedge.protectionId, "tp_sold", {
        hedgeManagerAction: reason,
        sellResult: {
          fillPrice: sellResult.fillPrice,
          totalProceeds: sellResult.totalProceeds,
          orderId: sellResult.orderId
        },
        bsRecovery: {
          totalValue: optionVal.totalValue,
          intrinsicValue: optionVal.intrinsicValue,
          timeValue: optionVal.timeValue
        },
        soldAt: new Date().toISOString()
      });
      return "sold";
    }

    const isNoBid = sellResult.details?.reason === "no_bid" || sellResult.details?.reason === "no_bid_available";
    if (isNoBid) {
      console.log(`[HedgeManager] No bid for ${hedge.protectionId} (${hedge.instrumentId}) — will retry next cycle`);
      return "no_bid";
    }

    console.warn(`[HedgeManager] Sell FAILED for ${hedge.protectionId}: ${JSON.stringify(sellResult.details).slice(0, 300)}`);
    return "failed";
  } catch (sellErr: any) {
    console.error(`[HedgeManager] sellOption THREW for ${hedge.protectionId}: ${sellErr?.message}`);
    return "failed";
  }
};

export const runHedgeManagementCycle = async (params: {
  pool: Pool;
  venue: PilotVenueAdapter;
  sellOption: (p: { instrumentId: string; quantity: number }) => Promise<{ status: string; fillPrice: number; totalProceeds: number; orderId: string | null; details: Record<string, unknown> }>;
  currentSpot: number;
  currentIV: number;
}): Promise<HedgeManagementResult> => {
  const result: HedgeManagementResult = { scanned: 0, tpSold: 0, salvaged: 0, expired: 0, errors: 0, noBidRetries: 0, skipped: 0 };

  const dvol = params.currentIV;
  const adaptive = resolveAdaptiveParams(dvol);

  let hedges: ManagedHedge[];
  try {
    hedges = await queryManagedHedges(params.pool);
  } catch (err: any) {
    console.error(`[HedgeManager] Failed to query hedges: ${err?.message}`);
    return result;
  }
  result.scanned = hedges.length;
  if (!hedges.length) return result;

  for (const hedge of hedges) {
    try {
      const now = Date.now();
      const isExpired = hedge.expiryMs <= now;
      const hoursToExpiry = (hedge.expiryMs - now) / 3600000;

      if (isExpired) {
        await updateHedgeStatus(params.pool, hedge.protectionId, "expired_settled", {
          hedgeManagerAction: "expired",
          expiredAt: new Date().toISOString()
        });
        result.expired++;
        continue;
      }

      if (hedge.quantity <= 0 || hedge.strike <= 0) {
        result.skipped++;
        continue;
      }

      const optionVal = computeOptionValue({
        protectionType: hedge.protectionType,
        currentSpot: params.currentSpot,
        strike: hedge.strike,
        expiryMs: hedge.expiryMs,
        sigma: dvol / 100,
        quantity: hedge.quantity,
        nowMs: now
      });

      // ── ACTIVE positions: salvage time value before expiry ──
      if (hedge.status === "active") {
        if (hoursToExpiry <= ACTIVE_SALVAGE_HOURS && optionVal.totalValue >= ACTIVE_SALVAGE_MIN_VALUE) {
          console.log(`[HedgeManager] Active salvage candidate: ${hedge.protectionId} hoursLeft=${hoursToExpiry.toFixed(1)} value=$${optionVal.totalValue.toFixed(2)} (intrinsic=$${optionVal.intrinsicValue.toFixed(2)} time=$${optionVal.timeValue.toFixed(2)})`);
          const sellStatus = await executeSell(hedge, "active_salvage", optionVal, params.sellOption, params.pool);
          if (sellStatus === "sold") { result.salvaged++; }
          else if (sellStatus === "no_bid") { result.noBidRetries++; }
          else { result.errors++; }
        } else {
          result.skipped++;
        }
        continue;
      }

      // ── TRIGGERED positions: TP logic ──
      if (hedge.status !== "triggered") {
        result.skipped++;
        continue;
      }

      const hoursSinceTrigger = hedge.triggerAtMs > 0 ? (now - hedge.triggerAtMs) / 3600000 : 999;
      const payout = hedge.payoutDueAmount > 0 ? hedge.payoutDueAmount : hedge.entryPremium;

      const dropFromFloorPct = computeDropDepthFromFloor(hedge.protectionType, params.currentSpot, hedge.floorPrice);
      const dropFromStrikePct = hedge.strike > 0 ? (hedge.protectionType === "short"
        ? ((params.currentSpot - hedge.strike) / hedge.strike) * 100
        : ((hedge.strike - params.currentSpot) / hedge.strike) * 100) : 0;
      const isDeepDrop = dropFromFloorPct >= DEEP_DROP_THRESHOLD_PCT;
      const bounced = isProtectionBounced(hedge.protectionType, params.currentSpot, hedge.floorPrice);
      const optionIsOtm = isOptionOtm(hedge.protectionType, params.currentSpot, hedge.strike);

      const gapPct = computeStrikeFloorGapPct(hedge.protectionType, hedge.strike, hedge.floorPrice);
      const hasSignificantGap = gapPct >= GAP_SIGNIFICANT_PCT;
      const gapInDeadZone = hasSignificantGap && !bounced && optionIsOtm;
      const effectiveCooling = gapInDeadZone
        ? adaptive.coolingHours + GAP_COOLING_EXTENSION_HOURS
        : adaptive.coolingHours;

      let shouldSell = false;
      let reason = "";

      if (hoursToExpiry < NEAR_EXPIRY_SALVAGE_HOURS && optionVal.totalValue >= NEAR_EXPIRY_MIN_VALUE) {
        shouldSell = true;
        reason = "near_expiry_salvage";
      } else if (isDeepDrop && hoursSinceTrigger >= adaptive.deepDropCoolingHours && optionVal.totalValue >= payout * adaptive.primeThreshold) {
        shouldSell = true;
        reason = "deep_drop_tp";
      } else if (hoursSinceTrigger < effectiveCooling) {
        shouldSell = false;
        reason = gapInDeadZone ? "gap_extended_cooling" : "cooling_period";
      } else if (bounced && hoursSinceTrigger >= effectiveCooling && optionVal.totalValue >= BOUNCE_RECOVERY_MIN_VALUE) {
        shouldSell = true;
        reason = "bounce_recovery";
      } else if (hoursSinceTrigger >= effectiveCooling && hoursSinceTrigger < adaptive.primeWindowEndHours) {
        if (optionVal.totalValue >= payout * adaptive.primeThreshold) {
          shouldSell = true;
          reason = "take_profit_prime";
        }
      } else if (hoursSinceTrigger >= adaptive.primeWindowEndHours) {
        if (optionVal.totalValue >= payout * adaptive.lateThreshold) {
          shouldSell = true;
          reason = "take_profit_late";
        }
      }

      if (!shouldSell) {
        const thresholdUsd = payout * (hoursSinceTrigger < adaptive.primeWindowEndHours ? adaptive.primeThreshold : adaptive.lateThreshold);
        if (reason === "cooling_period" || reason === "gap_extended_cooling") {
          console.log(`[HedgeManager] ${reason}: ${hedge.protectionId} ${hoursSinceTrigger.toFixed(1)}h/${effectiveCooling.toFixed(1)}h cooling, floorDrop=${dropFromFloorPct.toFixed(2)}% strikeDrop=${dropFromStrikePct.toFixed(2)}% value=$${optionVal.totalValue.toFixed(2)} vol=${adaptive.regime}(${dvol.toFixed(0)}) gap=${gapPct.toFixed(2)}%`);
        } else {
          console.log(`[HedgeManager] Hold: ${hedge.protectionId} sinceTrigger=${hoursSinceTrigger.toFixed(1)}h toExpiry=${hoursToExpiry.toFixed(1)}h value=$${optionVal.totalValue.toFixed(2)} threshold=$${thresholdUsd.toFixed(2)} floorDrop=${dropFromFloorPct.toFixed(2)}% strikeDrop=${dropFromStrikePct.toFixed(2)}% bounced=${bounced} optionOtm=${optionIsOtm} vol=${adaptive.regime}(${dvol.toFixed(0)}) gap=${gapPct.toFixed(2)}%`);
        }
        result.skipped++;
        continue;
      }

      console.log(`[HedgeManager] TP decision (${reason}): ${hedge.protectionId} vol=${adaptive.regime}(${dvol.toFixed(0)}) gap=${gapPct.toFixed(2)}% floorDrop=${dropFromFloorPct.toFixed(2)}% strikeDrop=${dropFromStrikePct.toFixed(2)}%`);
      const sellStatus = await executeSell(hedge, reason, optionVal, params.sellOption, params.pool);
      if (sellStatus === "sold") { result.tpSold++; }
      else if (sellStatus === "no_bid") { result.noBidRetries++; }
      else { result.errors++; }
    } catch (err: any) {
      console.error(`[HedgeManager] Error processing ${hedge.protectionId}: ${err?.message}`);
      result.errors++;
    }
  }

  console.log(
    `[HedgeManager] Cycle complete: scanned=${result.scanned} tpSold=${result.tpSold} salvaged=${result.salvaged} expired=${result.expired} noBid=${result.noBidRetries} errors=${result.errors} skipped=${result.skipped} vol=${adaptive.regime}(${dvol.toFixed(0)})`
  );
  return result;
};
