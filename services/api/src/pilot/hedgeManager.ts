import Decimal from "decimal.js";
import type { Pool } from "pg";
import { pilotConfig } from "./config";
import { computePutRecoveryValue } from "./blackScholes";
import { bsCall } from "./blackScholes";
import type { PilotVenueAdapter } from "./venue";
import { getSpotMovePct, recordSpotSample } from "./spotHistory";

/**
 * PR C — Active TP gaps configuration.
 *
 * Both gaps default to OBSERVE-ONLY mode for the pilot. In observe-only
 * mode the cycle logs every "would have fired" event with the same
 * detail as a real fire, so we accumulate calibration data without
 * taking the action risk. Flip ENFORCE flags to true after we see
 * enough observe-only data to validate the thresholds.
 *
 * Gap 1 (volatility-spike forced exit):
 *   When BTC has moved more than gap1MovePct over gap1WindowMs and
 *   the option being held is worth at least gap1MinValueUsd, sell
 *   immediately. Catches the fast-move scenario where bouncing
 *   waiting bleeds time value while the option is still valuable.
 *
 *   PILOT_TP_GAP1_ENFORCE        default 'false' (observe-only)
 *   PILOT_TP_GAP1_MOVE_PCT       default 3.0 (% absolute spot move)
 *   PILOT_TP_GAP1_WINDOW_HOURS   default 2
 *   PILOT_TP_GAP1_MIN_VALUE_USD  default 50
 *
 * Gap 3 (price-direction cooling shrink):
 *   When BTC is down more than gap3DownPct over gap3WindowMs, halve
 *   the cooling window for triggered protections. Reduces the wait
 *   time before bounce_recovery / take_profit_prime branches can
 *   fire during sustained downtrends.
 *
 *   PILOT_TP_GAP3_ENFORCE        default 'false' (observe-only)
 *   PILOT_TP_GAP3_DOWN_PCT       default 5.0 (% spot fell over window)
 *   PILOT_TP_GAP3_WINDOW_HOURS   default 24
 *   PILOT_TP_GAP3_SHRINK_FACTOR  default 0.5 (multiply cooling by this)
 *
 * Gap 5 — SHORT-specific TP rules (added 2026-04-21 after the c84dbbe9
 * trade exposed that LONG-style "wait for bounce" behavior is wrong for
 * SHORT triggers, which historically continue UP rather than retrace).
 *
 *   Gap 5a — SHORT barely-graze fast exit:
 *     If a SHORT-protection trigger fires and BTC has only moved past
 *     the trigger by <gap5GrazePct (default 0.3%) AND we're still in
 *     the early window (<gap5GrazeWindowMin, default 30 min) AND the
 *     option still has value (>=gap5MinValueUsd), sell IMMEDIATELY.
 *     Captures the tiny intrinsic value before time decay erodes it,
 *     based on the empirical observation that barely-graze SHORT
 *     triggers tend to retrace rather than bounce favorably.
 *
 *   Gap 5b — SHORT clear-breakout extended hold:
 *     If a SHORT-protection trigger fires and BTC has moved >=
 *     gap5BreakoutPct (default 1.0%) past trigger AND option value is
 *     still rising (intrinsic >= gap5BreakoutMinIntrinsic, default
 *     $50), extend cooling window by gap5BreakoutHoldMultiplier
 *     (default 1.5×). Lets us ride the momentum continuation that's
 *     historically common after SHORT breakouts.
 *
 *   PILOT_TP_GAP5_ENFORCE              default 'false' (observe-only)
 *   PILOT_TP_GAP5_GRAZE_PCT            default 0.3
 *   PILOT_TP_GAP5_GRAZE_WINDOW_MIN     default 30
 *   PILOT_TP_GAP5_GRAZE_MIN_VALUE_USD  default 15
 *   PILOT_TP_GAP5_BREAKOUT_PCT         default 1.0
 *   PILOT_TP_GAP5_BREAKOUT_MIN_INTRINSIC_USD default 50
 *   PILOT_TP_GAP5_BREAKOUT_HOLD_MULT   default 1.5
 *
 *   Validation plan: ship observe-only. After n>=5 SHORT triggers the
 *   per-direction recovery roll-up in PR #79's Triggered Trades tab
 *   will show whether SHORT recovery is materially worse than LONG
 *   (indicating Gap 5 is needed) or comparable (indicating LONG TP is
 *   already adequate for SHORT). If indicated, flip enforce to true
 *   one trade at a time and compare recovery vs the observe-only
 *   baseline.
 */
const TP_GAP_DEFAULTS = {
  gap1: {
    enforce: false,
    movePct: 3.0,
    windowHours: 2,
    minValueUsd: 50
  },
  gap3: {
    enforce: false,
    downPct: 5.0,
    windowHours: 24,
    shrinkFactor: 0.5
  },
  gap5: {
    enforce: false,
    grazePct: 0.3,
    grazeWindowMin: 30,
    grazeMinValueUsd: 15,
    breakoutPct: 1.0,
    breakoutMinIntrinsicUsd: 50,
    breakoutHoldMult: 1.5
  }
};

const resolveGap1Config = () => ({
  enforce: String(process.env.PILOT_TP_GAP1_ENFORCE || "").toLowerCase() === "true",
  movePct: Number(process.env.PILOT_TP_GAP1_MOVE_PCT || TP_GAP_DEFAULTS.gap1.movePct),
  windowHours: Number(process.env.PILOT_TP_GAP1_WINDOW_HOURS || TP_GAP_DEFAULTS.gap1.windowHours),
  minValueUsd: Number(process.env.PILOT_TP_GAP1_MIN_VALUE_USD || TP_GAP_DEFAULTS.gap1.minValueUsd)
});

const resolveGap3Config = () => ({
  enforce: String(process.env.PILOT_TP_GAP3_ENFORCE || "").toLowerCase() === "true",
  downPct: Number(process.env.PILOT_TP_GAP3_DOWN_PCT || TP_GAP_DEFAULTS.gap3.downPct),
  windowHours: Number(process.env.PILOT_TP_GAP3_WINDOW_HOURS || TP_GAP_DEFAULTS.gap3.windowHours),
  shrinkFactor: Number(process.env.PILOT_TP_GAP3_SHRINK_FACTOR || TP_GAP_DEFAULTS.gap3.shrinkFactor)
});

const resolveGap5Config = () => ({
  enforce: String(process.env.PILOT_TP_GAP5_ENFORCE || "").toLowerCase() === "true",
  grazePct: Number(process.env.PILOT_TP_GAP5_GRAZE_PCT || TP_GAP_DEFAULTS.gap5.grazePct),
  grazeWindowMin: Number(process.env.PILOT_TP_GAP5_GRAZE_WINDOW_MIN || TP_GAP_DEFAULTS.gap5.grazeWindowMin),
  grazeMinValueUsd: Number(process.env.PILOT_TP_GAP5_GRAZE_MIN_VALUE_USD || TP_GAP_DEFAULTS.gap5.grazeMinValueUsd),
  breakoutPct: Number(process.env.PILOT_TP_GAP5_BREAKOUT_PCT || TP_GAP_DEFAULTS.gap5.breakoutPct),
  breakoutMinIntrinsicUsd: Number(process.env.PILOT_TP_GAP5_BREAKOUT_MIN_INTRINSIC_USD || TP_GAP_DEFAULTS.gap5.breakoutMinIntrinsicUsd),
  breakoutHoldMult: Number(process.env.PILOT_TP_GAP5_BREAKOUT_HOLD_MULT || TP_GAP_DEFAULTS.gap5.breakoutHoldMult)
});

/**
 * Compute spot move BEYOND trigger price (signed: positive = past
 * trigger in adverse direction, negative = retraced back to safe side).
 * Pulled from the trigger snapshot stored in metadata at trigger fire
 * time so we can measure "where was BTC when this fired" against
 * "where is BTC now."
 */
const computeSpotMoveThroughTriggerPct = (
  protectionType: string,
  triggerReferencePrice: number | null,
  triggerPrice: number,
  currentSpot: number
): number | null => {
  if (!triggerReferencePrice || triggerReferencePrice <= 0) return null;
  if (!triggerPrice || triggerPrice <= 0) return null;
  // We use CURRENT spot vs trigger price (not vs the trigger reference
  // spot). The "barely_graze vs clear_breakout" question is "how far
  // past the trigger has BTC ACTUALLY GONE", evaluated continuously,
  // not just at the moment of fire.
  const moveBeyondTrigger = protectionType === "short"
    ? currentSpot - triggerPrice
    : triggerPrice - currentSpot;
  return (moveBeyondTrigger / triggerPrice) * 100;
};

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
// Minimum BS-modeled option value to bother selling on the bounce-recovery
// branch. Raised from $3 → $5 based on Phase 0 v6 TP-optimization analysis
// (n=9 triggers + 4 chain samples): observed Deribit bid-ask spread on
// short-dated options runs 18-80% of mid, so a BS-modeled $3 net of fees
// often realizes ~$1.50-2.00 — sub-economical given Deribit's ~$0.03
// per-contract option fee. $5 BS aligns the threshold with what we'll
// actually receive (~$3-4 net) and removes a class of always-losing
// micro-sales without affecting any larger-value sale.
const BOUNCE_RECOVERY_MIN_VALUE = 5;
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

/**
 * R3.C — Persist no-bid retry count and emit threshold warnings.
 *
 * Without this, the hedge manager retries no-bid sells every 60s forever
 * with no metadata trail and no operator visibility. Phase 2 chain samples
 * showed bid is null in 4 of 8 tier×side combos on every snapshot — for
 * SL 5%+ shorts and SL 10%+ positions this is the NORM, not the exception.
 *
 * This function:
 *   1. Increments metadata.noBidRetryCount on the protection row.
 *   2. Stamps metadata.lastNoBidAt + lastNoBidInstrument for traceability.
 *   3. Logs single-line WARN at threshold cycle counts (30, 60, 120) so
 *      operators grepping for [HedgeManager] WARN can spot stuck positions
 *      without log spam every cycle.
 *
 * Threshold cadence (60s cycles):
 *   30 cycles  ≈ 30 minutes  — first warning
 *   60 cycles  ≈ 1 hour      — second warning
 *   120 cycles ≈ 2 hours     — third warning (likely going to expire no-bid)
 */
const NO_BID_WARN_THRESHOLDS = new Set([30, 60, 120]);
const recordNoBidRetry = async (
  pool: Pool,
  protectionId: string,
  instrumentId: string
): Promise<void> => {
  const result = await pool.query(
    `UPDATE pilot_protections
     SET metadata = metadata || jsonb_build_object(
           'noBidRetryCount', COALESCE((metadata->>'noBidRetryCount')::int, 0) + 1,
           'lastNoBidAt', $2::text,
           'lastNoBidInstrument', $3::text
         ),
         updated_at = NOW()
     WHERE id = $1
     RETURNING (metadata->>'noBidRetryCount')::int AS count`,
    [protectionId, new Date().toISOString(), instrumentId]
  );
  const count = Number(result.rows[0]?.count ?? 0);
  if (NO_BID_WARN_THRESHOLDS.has(count)) {
    const minutes = count; // 60s cycles → cycles ≈ minutes
    console.warn(
      `[HedgeManager] WARN: protection ${protectionId} (${instrumentId}) has been no-bid for ${count} cycles (~${minutes} minutes). ` +
      `Likely a thin short-dated strike with no buyers. ` +
      `Position will auto-settle on Deribit at expiry; reconcile via account statement.`
    );
  }
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
      // R3.C — persist retry count + threshold warnings (best-effort; the
      // sell-decision flow continues regardless of metadata write success).
      try {
        await recordNoBidRetry(pool, hedge.protectionId, hedge.instrumentId);
      } catch (mdErr: any) {
        console.warn(`[HedgeManager] noBid metadata write failed for ${hedge.protectionId}: ${mdErr?.message}`);
      }
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

  // PR C — record this cycle's spot sample for Gap 1 and Gap 3 lookbacks.
  recordSpotSample(params.currentSpot);
  const gap1Cfg = resolveGap1Config();
  const gap3Cfg = resolveGap3Config();
  const gap5Cfg = resolveGap5Config();
  // Compute the lookback once at top of cycle so every protection
  // sees the same value (cleaner audit log).
  const gap1MovePct = getSpotMovePct(gap1Cfg.windowHours * 3600_000);
  const gap3MovePct = getSpotMovePct(gap3Cfg.windowHours * 3600_000);
  // Gap 3 fires when spot has dropped more than the threshold
  // (negative move >= downPct).
  const gap3Active = gap3MovePct !== null && gap3MovePct <= -gap3Cfg.downPct;
  if (gap3Active) {
    console.log(
      `[HedgeManager] Gap 3: spot down ${(-(gap3MovePct as number)).toFixed(2)}% over ${gap3Cfg.windowHours}h ` +
      `(threshold ${gap3Cfg.downPct}%). Cooling windows ${gap3Cfg.enforce ? "SHRUNK" : "would shrink (observe-only)"} ` +
      `by factor ${gap3Cfg.shrinkFactor}.`
    );
  }

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
      let effectiveCooling = gapInDeadZone
        ? adaptive.coolingHours + GAP_COOLING_EXTENSION_HOURS
        : adaptive.coolingHours;

      // PR C — Gap 3: shrink cooling window during sustained drops.
      // Only for LONG protections — for shorts, a 24h spot drop is
      // beneficial (the option moves away from trigger), not adverse.
      if (gap3Active && hedge.protectionType !== "short") {
        const shrunk = effectiveCooling * gap3Cfg.shrinkFactor;
        if (gap3Cfg.enforce) {
          console.log(
            `[HedgeManager] Gap 3 ENFORCE: ${hedge.protectionId} cooling ${effectiveCooling.toFixed(2)}h → ${shrunk.toFixed(2)}h ` +
            `(spot down ${(-(gap3MovePct as number)).toFixed(2)}% over ${gap3Cfg.windowHours}h)`
          );
          effectiveCooling = shrunk;
        } else {
          console.log(
            `[HedgeManager] Gap 3 OBSERVE: ${hedge.protectionId} cooling would shrink ${effectiveCooling.toFixed(2)}h → ${shrunk.toFixed(2)}h ` +
            `(observe-only; set PILOT_TP_GAP3_ENFORCE=true to act)`
          );
        }
      }

      // PR C — Gap 1: force-exit on volatility spike. Long protections
      // benefit when BTC drops fast; short protections benefit when BTC
      // rises fast. We measure the absolute move and use the sign that's
      // adverse to the trader's underlying position (i.e. the move that
      // makes the OPTION valuable).
      const adverseMoveDirection = hedge.protectionType === "short" ? 1 : -1;
      const adverseMovePct = gap1MovePct !== null ? gap1MovePct * adverseMoveDirection : null;
      const gap1WouldFire =
        adverseMovePct !== null &&
        adverseMovePct >= gap1Cfg.movePct &&
        optionVal.totalValue >= gap1Cfg.minValueUsd;
      if (gap1WouldFire) {
        if (gap1Cfg.enforce) {
          console.log(
            `[HedgeManager] Gap 1 ENFORCE: ${hedge.protectionId} adverseMove=${adverseMovePct.toFixed(2)}% over ${gap1Cfg.windowHours}h ` +
            `value=$${optionVal.totalValue.toFixed(2)} (>= ${gap1Cfg.minValueUsd}). Forcing sale.`
          );
          const sellStatus = await executeSell(hedge, "vol_spike_forced_exit", optionVal, params.sellOption, params.pool);
          if (sellStatus === "sold") { result.tpSold++; }
          else if (sellStatus === "no_bid") { result.noBidRetries++; }
          else { result.errors++; }
          continue;
        } else {
          console.log(
            `[HedgeManager] Gap 1 OBSERVE: ${hedge.protectionId} would force-sell — adverseMove=${adverseMovePct.toFixed(2)}% over ${gap1Cfg.windowHours}h ` +
            `value=$${optionVal.totalValue.toFixed(2)} (observe-only; set PILOT_TP_GAP1_ENFORCE=true to act)`
          );
        }
      }

      // ── Gap 5: SHORT-specific TP rules ──
      // Only evaluated when protectionType === 'short'. Two sub-rules:
      //   5a) BARELY-GRAZE FAST EXIT: if BTC has barely crossed the
      //       trigger (< grazePct past it) AND we're early
      //       (< grazeWindowMin since trigger) AND option still has
      //       value, sell now. This avoids the c84dbbe9 trap where
      //       waiting for a bounce just lets time decay erode the
      //       small intrinsic value the trigger captured.
      //   5b) CLEAR-BREAKOUT EXTENDED HOLD: if BTC has moved decisively
      //       past trigger (>= breakoutPct) AND option intrinsic is
      //       healthy, extend cooling by breakoutHoldMult to let the
      //       continuation play out.
      // Default: observe-only. Validation criteria documented in the
      // configuration block above.
      let gap5BreakoutModifiedCooling = false;
      if (hedge.protectionType === "short") {
        const triggerRefRaw = (hedge.metadata as any)?.triggerReferencePrice;
        const triggerRefPrice = Number(triggerRefRaw);
        const triggerPriceForGap5 = hedge.floorPrice;
        const spotMoveThroughTriggerPct = computeSpotMoveThroughTriggerPct(
          hedge.protectionType,
          Number.isFinite(triggerRefPrice) ? triggerRefPrice : null,
          triggerPriceForGap5,
          params.currentSpot
        );
        const minutesSinceTrigger = hoursSinceTrigger * 60;

        // Gap 5a — BARELY-GRAZE FAST EXIT
        const gap5aWouldFire =
          spotMoveThroughTriggerPct !== null &&
          spotMoveThroughTriggerPct >= 0 &&
          spotMoveThroughTriggerPct < gap5Cfg.grazePct &&
          minutesSinceTrigger < gap5Cfg.grazeWindowMin &&
          optionVal.totalValue >= gap5Cfg.grazeMinValueUsd;
        if (gap5aWouldFire) {
          if (gap5Cfg.enforce) {
            console.log(
              `[HedgeManager] Gap 5a ENFORCE: ${hedge.protectionId} SHORT barely-graze ` +
              `(spot ${spotMoveThroughTriggerPct.toFixed(3)}% past trigger, ${minutesSinceTrigger.toFixed(0)}min in, ` +
              `value=$${optionVal.totalValue.toFixed(2)}). Selling immediately to capture intrinsic before retrace.`
            );
            const sellStatus = await executeSell(hedge, "short_barely_graze_fast_exit", optionVal, params.sellOption, params.pool);
            if (sellStatus === "sold") { result.tpSold++; }
            else if (sellStatus === "no_bid") { result.noBidRetries++; }
            else { result.errors++; }
            continue;
          } else {
            console.log(
              `[HedgeManager] Gap 5a OBSERVE: ${hedge.protectionId} SHORT barely-graze would fast-exit ` +
              `(spot ${spotMoveThroughTriggerPct.toFixed(3)}% past trigger, ${minutesSinceTrigger.toFixed(0)}min in, ` +
              `value=$${optionVal.totalValue.toFixed(2)}; observe-only; set PILOT_TP_GAP5_ENFORCE=true to act)`
            );
          }
        }

        // Gap 5b — CLEAR-BREAKOUT EXTENDED HOLD
        const gap5bWouldFire =
          spotMoveThroughTriggerPct !== null &&
          spotMoveThroughTriggerPct >= gap5Cfg.breakoutPct &&
          optionVal.intrinsicValue >= gap5Cfg.breakoutMinIntrinsicUsd &&
          hoursSinceTrigger < effectiveCooling * gap5Cfg.breakoutHoldMult;
        if (gap5bWouldFire) {
          const extendedCooling = effectiveCooling * gap5Cfg.breakoutHoldMult;
          if (gap5Cfg.enforce) {
            console.log(
              `[HedgeManager] Gap 5b ENFORCE: ${hedge.protectionId} SHORT clear-breakout ` +
              `(spot ${spotMoveThroughTriggerPct.toFixed(2)}% past trigger, intrinsic=$${optionVal.intrinsicValue.toFixed(2)}). ` +
              `Cooling extended ${effectiveCooling.toFixed(2)}h → ${extendedCooling.toFixed(2)}h.`
            );
            effectiveCooling = extendedCooling;
            gap5BreakoutModifiedCooling = true;
          } else {
            console.log(
              `[HedgeManager] Gap 5b OBSERVE: ${hedge.protectionId} SHORT clear-breakout would extend cooling ` +
              `${effectiveCooling.toFixed(2)}h → ${extendedCooling.toFixed(2)}h ` +
              `(spot ${spotMoveThroughTriggerPct.toFixed(2)}% past trigger, intrinsic=$${optionVal.intrinsicValue.toFixed(2)}; ` +
              `observe-only; set PILOT_TP_GAP5_ENFORCE=true to act)`
            );
          }
        }
      }
      // Suppress unused-var lint noise on the audit flag — it's there
      // so future TP-decision logging can include the fact that cooling
      // was lengthened by Gap 5b vs the standard tree.
      void gap5BreakoutModifiedCooling;

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
