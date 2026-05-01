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
 * No-bid backstop (added 2026-04-30 after the 3df5cfa1 trade burned 285
 * cycles of fruitless sell attempts against an empty Deribit book).
 *
 * When a triggered protection has accumulated `noBidRetryCount` >= the
 * configured threshold, we stop attempting bounce_recovery,
 * take_profit_prime, take_profit_late, and deep_drop_tp sells on it
 * and let it ride to natural expiry. The near_expiry_salvage branch
 * (last 6h of life) is intentionally LEFT ENABLED so we still try if
 * Deribit liquidity returns near the settlement window — late liquidity
 * is real (assignees scrambling to close).
 *
 * On the cycle where we first cross the threshold we:
 *   1. Stamp `metadata.heldToExpiryReason = "deribit_persistent_no_bid"`
 *   2. Stamp `metadata.heldToExpiryAt` (ISO timestamp, for audit)
 *   3. Emit a single info-level [HedgeManager] log line
 *
 * On subsequent cycles we just print a one-line "skipped: no_bid_backstop"
 * so the cycle log stays scannable and we don't re-stamp metadata or
 * fire alerts on every 60s cycle.
 *
 * Default threshold = 60 cycles ≈ 1 hour at 60s cycle cadence.
 * Why 60: the operational warning at cycle 30 (half-hour) gives operators
 * a chance to intervene. By cycle 60 it's clear the book is structurally
 * empty for this strike. Tighter than that and we cut off legitimate
 * recovery on options that briefly became unbiddable; looser and we
 * waste more cycles. Tunable via env without redeploy.
 *
 *   PILOT_TP_NO_BID_BACKSTOP_THRESHOLD  default 60
 *   PILOT_TP_NO_BID_BACKSTOP_ENABLED    default true
 *
 * Set ENABLED=false to disable entirely (revert to old behavior of
 * retrying forever).
 */
const NO_BID_BACKSTOP_DEFAULTS = {
  enabled: true,
  threshold: 60
};

const resolveNoBidBackstopConfig = () => ({
  enabled: String(process.env.PILOT_TP_NO_BID_BACKSTOP_ENABLED ?? "true").toLowerCase() !== "false",
  threshold: Number(process.env.PILOT_TP_NO_BID_BACKSTOP_THRESHOLD || NO_BID_BACKSTOP_DEFAULTS.threshold)
});

const stampHeldToExpiry = async (
  pool: Pool,
  protectionId: string,
  reason: string,
  retryCount: number
): Promise<void> => {
  await pool.query(
    `UPDATE pilot_protections
     SET metadata = metadata || jsonb_build_object(
           'heldToExpiryReason', $2::text,
           'heldToExpiryAt', $3::text,
           'heldToExpiryNoBidCount', $4::int
         ),
         updated_at = NOW()
     WHERE id = $1`,
    [protectionId, reason, new Date().toISOString(), retryCount]
  );
};

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
  /**
   * Cumulative no_bid retry count for this protection's hedge sells.
   * Persisted in metadata.noBidRetryCount by recordNoBidRetry on every
   * cycle that executeSell returns no_bid. Read here so the no-bid
   * backstop can decide whether to keep trying or hold to expiry.
   */
  noBidRetryCount: number;
  /**
   * Hedge tenor in days. 1 = legacy 1-day product, 14 = biweekly
   * subscription product (PR 6 of biweekly cutover, 2026-04-30). Used
   * to scale TP timing constants (cooling window, prime window,
   * near-expiry salvage threshold) so the 14-day option lifecycle
   * gets appropriately longer windows than the 1-day product.
   * Defaults to 1 for legacy rows where tenor_days isn't set.
   */
  tenorDays: number;
  /**
   * Per CEO direction 2026-04-30 (PR 4 of biweekly cutover): when a
   * biweekly trigger fires, the protection closes for the user but
   * the underlying Deribit option stays open for the platform. This
   * flag, set by biweeklyClose.handleBiweeklyClose, tells the hedge
   * manager that disposition is on its own schedule (not the
   * trader's). Used to slightly extend the TP windows on retained
   * hedges since there's no user-facing urgency.
   */
  hedgeRetainedForPlatform: boolean;
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

// Tenor-aware scaling for TP timing parameters (PR 6 of biweekly
// cutover, 2026-04-30).
//
// The legacy 1-day product calibrated cooling/prime/late timing
// constants for a 24-hour option lifecycle. Biweekly options live
// 14× longer and have very different theta curves — applying the
// 1-day timings to a 14-day option causes the system to hit
// "near-expiry salvage" with 13 days left, which is wrong.
//
// Scaling rules:
//   - Cooling windows scale as sqrt(tenor) — theta is non-linear, so
//     waiting longer on a longer option captures proportionally less
//     time-value relative to total premium.
//   - Prime/late windows scale linearly — they're calendar-time concepts.
//   - Near-expiry-salvage is a fixed fraction of tenor (last 1/14 of
//     the option's life), capped at 24h.
//   - Threshold values (prime/late as % of payout) DO NOT scale —
//     they're percentages of payout regardless of tenor.
//
// For tenor=1 (legacy), all scalings = 1.0 → behavior identical to
// pre-PR-6. For tenor=14 (biweekly):
//   coolingHours: 0.5h → ~1.87h
//   primeWindowEndHours: 8h → ~7d (168h)
//   nearExpirySalvageHours: 6h → ~24h
const tenorScaledTpTimings = (tenorDays: number) => {
  const t = Math.max(1, tenorDays);
  return {
    coolingScale: Math.sqrt(t),       // sqrt scaling — theta-aware
    primeWindowScale: t,              // linear scaling — calendar time
    nearExpirySalvageScale: Math.min(t / 1.0, 4.0)  // linear, capped at 4× (= 24h for 1-day base)
  };
};

const resolveAdaptiveParams = (dvol: number, tenorDays: number = 1) => {
  const regime = resolveVolRegime(dvol);
  const sc = tenorScaledTpTimings(tenorDays);
  switch (regime) {
    case "high":
      return {
        regime,
        coolingHours: 1.0 * sc.coolingScale,
        deepDropCoolingHours: 0.25 * sc.coolingScale,
        primeThreshold: 0.35,             // % of payout — NOT scaled by tenor
        lateThreshold: 0.15,              // % of payout — NOT scaled by tenor
        primeWindowEndHours: 10 * sc.primeWindowScale
      };
    case "low":
      return {
        regime,
        coolingHours: 0.25 * sc.coolingScale,
        deepDropCoolingHours: 0.1 * sc.coolingScale,
        primeThreshold: 0.15,
        lateThreshold: 0.05,
        primeWindowEndHours: 6 * sc.primeWindowScale
      };
    default:
      return {
        regime,
        coolingHours: BASE_COOLING_HOURS * sc.coolingScale,
        deepDropCoolingHours: BASE_DEEP_DROP_COOLING_HOURS * sc.coolingScale,
        primeThreshold: BASE_PRIME_THRESHOLD_MULTIPLIER,
        lateThreshold: BASE_LATE_THRESHOLD_MULTIPLIER,
        primeWindowEndHours: PRIME_WINDOW_END_HOURS * sc.primeWindowScale
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
           floor_price,
           COALESCE(tenor_days, 1) AS tenor_days,
           COALESCE(hedge_retained_for_platform, false) AS hedge_retained_for_platform
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
      noBidRetryCount: Number(meta.noBidRetryCount ?? 0) || 0,
      // Biweekly fields (PR 6 of biweekly cutover, 2026-04-30). The
      // COALESCE in the SELECT above defaults legacy 1-day rows to
      // tenor_days=1 and hedge_retained_for_platform=false so all
      // existing logic continues to behave exactly as before.
      tenorDays: Number(row.tenor_days ?? 1) || 1,
      hedgeRetainedForPlatform: Boolean(row.hedge_retained_for_platform),
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

/**
 * Mark a hedge as expired_settled and stamp the rich expiryAutopsy
 * block in a single atomic write.
 *
 * Why JS-side read-merge-write (vs `metadata || $2::jsonb` like the
 * other helpers): pg-mem 3.x cannot execute the SQL-side `||` concat
 * operator with a parameterized JSONB RHS, so any test exercising the
 * isExpired branch through runHedgeManagementCycle was silently
 * throwing. (No prior test exercised this branch, so we only noticed
 * when adding the autopsy coverage.) Read-merge-write works in pg-mem
 * AND in real Postgres, gives identical results, and is safe at the
 * one-write-per-cycle-per-protection cadence here. Concurrent writers
 * to the same protection metadata would need SELECT … FOR UPDATE; we
 * have a single-writer guarantee for hedge_status='active' rows in the
 * triggered/active branches because the cycle holds them exclusively.
 *
 * This is the only metadata write that uses read-merge-write. Other
 * helpers (recordNoBidRetry, stampHeldToExpiry) keep using the SQL-side
 * jsonb_build_object pattern because they need atomic increment
 * semantics (noBidRetryCount) or are best-effort with cheap fail mode.
 */
const markExpiredWithAutopsy = async (
  pool: Pool,
  protectionId: string,
  expiredAtIso: string,
  autopsy: Record<string, unknown>
): Promise<void> => {
  const cur = await pool.query(
    "SELECT metadata FROM pilot_protections WHERE id = $1",
    [protectionId]
  );
  const existing = (cur.rows[0]?.metadata || {}) as Record<string, unknown>;
  const merged = {
    ...existing,
    hedgeManagerAction: "expired",
    expiredAt: expiredAtIso,
    expiryAutopsy: autopsy
  };
  await pool.query(
    `UPDATE pilot_protections
     SET hedge_status = 'expired_settled',
         metadata = $1::jsonb,
         updated_at = NOW()
     WHERE id = $2`,
    [JSON.stringify(merged), protectionId]
  );
};

/**
 * Expiry autopsy block (added 2026-04-30).
 *
 * Stamped on the protection's metadata at the moment the hedge expires
 * (the isExpired branch in runHedgeManagementCycle). Captures everything
 * we'd want to know post-mortem about a hedge that ended worthless OR
 * was held to expiry without TP firing:
 *
 *   - Was the option ITM at expiry? If yes, Deribit auto-settles and
 *     the platform got paid via account_summary even though hedgeManager
 *     didn't sell. itmAtExpiry=true means "go check the Deribit
 *     settlement history and credit this as TP recovery" — the
 *     observability fix for the recovery_ratio number being misleading
 *     when ITM expiries are uncounted.
 *
 *   - Final intrinsic value (= per-contract intrinsic × quantity) at
 *     expiry. Provides the upper bound on what auto-settlement could
 *     have paid us.
 *
 *   - Spot at expiry, strike, protection type — so a query can
 *     reconstruct the trade outcome without re-fetching market data.
 *
 *   - Total no_bid retries observed — carries forward from
 *     metadata.noBidRetryCount. Combined with heldToExpiryReason
 *     (set by the no-bid backstop when it lands) tells the full story:
 *     "we tried N times to sell, then the backstop engaged, then it
 *     held to expiry."
 *
 *   - Hours from trigger to expiry — timing context. For triggered
 *     trades this is the window the TP system had to act in; for
 *     active-then-expired trades this is null.
 *
 * Reads only what's already on the protection row + computes intrinsic
 * locally. No new persistent state, no new queries to Deribit. Pure
 * function returning a plain object that the caller merges into the
 * metadata UPDATE alongside hedgeManagerAction.
 *
 * Future query (post-deploy operational use):
 *   SELECT id,
 *          metadata->'expiryAutopsy'->>'itmAtExpiry',
 *          metadata->'expiryAutopsy'->>'intrinsicAtExpiryUsd',
 *          metadata->'expiryAutopsy'->>'totalNoBidRetries',
 *          metadata->'expiryAutopsy'->>'heldToExpiryReason'
 *   FROM pilot_protections
 *   WHERE metadata ? 'expiryAutopsy'
 *     AND (metadata->'expiryAutopsy'->>'itmAtExpiry')::bool = true
 *   ORDER BY (metadata->'expiryAutopsy'->>'expiredAt') DESC;
 *
 * That gives you every hedge that auto-settled ITM and may need
 * reconciliation against Deribit's settlement history.
 */
const buildExpiryAutopsy = (params: {
  hedge: ManagedHedge;
  currentSpot: number;
  expiredAtIso: string;
}): Record<string, unknown> => {
  const { hedge, currentSpot, expiredAtIso } = params;
  const intrinsicPerContract = hedge.protectionType === "short"
    ? Math.max(0, currentSpot - hedge.strike) // call: max(0, spot - strike)
    : Math.max(0, hedge.strike - currentSpot); // put : max(0, strike - spot)
  const intrinsicAtExpiryUsd = intrinsicPerContract * hedge.quantity;
  const itmAtExpiry = intrinsicPerContract > 0;
  const hoursTriggerToExpiry = hedge.triggerAtMs > 0
    ? (hedge.expiryMs - hedge.triggerAtMs) / 3600000
    : null;
  const heldToExpiryReason = (hedge.metadata as any)?.heldToExpiryReason ?? null;

  return {
    expiryAutopsy: {
      expiredAt: expiredAtIso,
      protectionType: hedge.protectionType,
      strike: hedge.strike,
      spotAtExpiry: currentSpot,
      intrinsicAtExpiryUsd: Number(intrinsicAtExpiryUsd.toFixed(8)),
      itmAtExpiry,
      // itmAtExpiry=true → Deribit will auto-settle the option;
      // reconcile against /private/get_settlement_history_by_instrument
      // to credit the settlement amount as TP recovery.
      autoSettlementCandidate: itmAtExpiry,
      totalNoBidRetries: Number((hedge.metadata as any)?.noBidRetryCount ?? 0) || 0,
      heldToExpiryReason,
      hoursTriggerToExpiry,
      hedgeStatus: hedge.hedgeStatus,
      finalStatus: hedge.status
    }
  };
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
  // Cycle-level adaptive params with legacy 1-day tenor — used only for
  // the cycle-complete log line. Per-hedge adaptive resolution below
  // (PR 6 of biweekly cutover, 2026-04-30) scales TP timings by the
  // hedge's actual tenor_days (1 = legacy, 14 = biweekly).
  const adaptiveBase = resolveAdaptiveParams(dvol, 1);

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

      // PR 6 (2026-04-30) — resolve adaptive TP timing PER HEDGE based on
      // its tenor_days. For legacy 1-day rows (tenor_days=1), behavior is
      // identical to pre-PR-6: coolingScale=1, primeWindowScale=1,
      // nearExpirySalvageScale=1. For biweekly (tenor_days=14):
      // sqrt(14)≈3.74× longer cooling, 14× longer prime window,
      // 4×-capped (24h) near-expiry salvage threshold.
      //
      // Additionally, hedges retained for the platform after a biweekly
      // trigger (hedgeRetainedForPlatform=true, set by biweeklyClose
      // PR 4) get a 1.5× extension on prime window since there's no
      // user-facing urgency — we can wait for better recovery.
      const adaptive = resolveAdaptiveParams(dvol, hedge.tenorDays);
      const nearExpirySalvageScale = tenorScaledTpTimings(hedge.tenorDays).nearExpirySalvageScale;
      const baseNearExpirySalvageHours = NEAR_EXPIRY_SALVAGE_HOURS * nearExpirySalvageScale;
      // Retained-for-platform extension on prime window only.
      // Cooling unchanged (we still want immediate execution opportunity).
      // Late threshold unchanged.
      const platformExtensionMult = hedge.hedgeRetainedForPlatform ? 1.5 : 1.0;
      adaptive.primeWindowEndHours = adaptive.primeWindowEndHours * platformExtensionMult;

      if (isExpired) {
        const expiredAtIso = new Date().toISOString();
        const autopsyBlock = buildExpiryAutopsy({
          hedge,
          currentSpot: params.currentSpot,
          expiredAtIso
        });
        const ap = (autopsyBlock as any).expiryAutopsy as Record<string, unknown>;
        // Atomic write: status → expired_settled, metadata gets the
        // autopsy block merged in. Read-merge-write under the hood; see
        // markExpiredWithAutopsy for why this isn't `metadata || $::jsonb`.
        await markExpiredWithAutopsy(params.pool, hedge.protectionId, expiredAtIso, ap);

        if (ap.itmAtExpiry) {
          // ITM expiries are auto-settlement candidates — log distinctly so
          // operators can spot reconciliation work needed against Deribit's
          // settlement history.
          console.log(
            `[HedgeManager] expired ITM (auto-settlement candidate): ${hedge.protectionId} ` +
            `intrinsic=$${(ap.intrinsicAtExpiryUsd as number).toFixed(2)} ` +
            `(spot $${(ap.spotAtExpiry as number).toFixed(2)} vs strike $${(ap.strike as number).toFixed(2)}, ` +
            `${hedge.protectionType}). Reconcile against Deribit settlement history.`
          );
        } else {
          console.log(
            `[HedgeManager] expired OTM: ${hedge.protectionId} ` +
            `(spot $${(ap.spotAtExpiry as number).toFixed(2)} vs strike $${(ap.strike as number).toFixed(2)}, ` +
            `${hedge.protectionType}). No auto-settlement; option dies worthless.`
          );
        }
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

        // Gap 5a-fix-1 (2026-04-30) — classify the barely-graze pattern from
        // the spot AT TRIGGER FIRE (triggerReferencePrice), not the current
        // spot. The 3df5cfa1 trade exposed the original bug: TriggerMonitor
        // runs every 3s and detects spot crossing the trigger; HedgeManager
        // runs every 60s. On a fast retrace (BTC barely grazes trigger then
        // immediately retreats), spot can be back below trigger by the first
        // HedgeManager cycle. The original guard `spotMoveThroughTriggerPct
        // >= 0` then evaluated false (spot is now BELOW trigger) and the
        // rule never fired, despite the trade being a textbook barely-graze.
        // The pattern classification ("how barely did BTC graze the
        // trigger") is set at the moment of trigger and does not change.
        // Use the trigger-time spot for that question. Live spot is still
        // tracked for logging/observability.
        const triggerTimeMovePct =
          Number.isFinite(triggerRefPrice) && triggerRefPrice > 0 && triggerPriceForGap5 > 0
            ? ((triggerRefPrice - triggerPriceForGap5) / triggerPriceForGap5) * 100
            : null;

        // Gap 5a — BARELY-GRAZE FAST EXIT
        // Pattern classified from spot-at-trigger-fire. Live conditions
        // (option still has value, still in early window) are evaluated
        // from current state.
        const gap5aWouldFire =
          triggerTimeMovePct !== null &&
          triggerTimeMovePct >= 0 &&
          triggerTimeMovePct < gap5Cfg.grazePct &&
          minutesSinceTrigger < gap5Cfg.grazeWindowMin &&
          optionVal.totalValue >= gap5Cfg.grazeMinValueUsd;
        if (gap5aWouldFire) {
          const liveCtx = spotMoveThroughTriggerPct === null
            ? "live=n/a"
            : `live ${spotMoveThroughTriggerPct.toFixed(3)}%`;
          if (gap5Cfg.enforce) {
            console.log(
              `[HedgeManager] Gap 5a ENFORCE: ${hedge.protectionId} SHORT barely-graze ` +
              `(at-trigger ${triggerTimeMovePct.toFixed(3)}% past, ${liveCtx}, ${minutesSinceTrigger.toFixed(0)}min in, ` +
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
              `(at-trigger ${triggerTimeMovePct.toFixed(3)}% past, ${liveCtx}, ${minutesSinceTrigger.toFixed(0)}min in, ` +
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

      // No-bid backstop check (2026-04-30). If we've burned through
      // >= threshold cycles trying to sell against an empty Deribit book,
      // stop the bounce_recovery / take_profit_* / deep_drop_tp branches
      // for this protection. near_expiry_salvage stays enabled below
      // (it's evaluated FIRST in the decision tree, so the backstop only
      // affects the post-cooling/prime/late branches).
      const backstopCfg = resolveNoBidBackstopConfig();
      // PR 6: use the per-hedge scaled near-expiry salvage hours.
      // For 1-day legacy: 6h (unchanged). For 14-day biweekly: 24h.
      const inNearExpiryWindow = hoursToExpiry < baseNearExpirySalvageHours;
      // 2026-05-01 — disable the no-bid backstop for biweekly (tenorDays >= 2).
      // The backstop was sized for the 1-day product where we're trading
      // same-day expiries against thin Deribit books; on a 14-day weekly
      // (Friday 08:00 UTC settlement) the bid book is consistently
      // $50k+ deep and a $1k–$1.5k hedge sell will not stress liquidity.
      // If we ever do see a no_bid streak on biweekly it's almost
      // certainly a Deribit incident, not a structural illiquidity —
      // and we'd rather keep retrying through the incident than freeze
      // the position into hold-to-expiry. The 1-day product still gets
      // the backstop unchanged.
      const isBiweeklyHedge = hedge.tenorDays >= 2;
      const backstopEngaged =
        backstopCfg.enabled &&
        !isBiweeklyHedge &&
        hedge.noBidRetryCount >= backstopCfg.threshold &&
        !inNearExpiryWindow;

      if (hoursToExpiry < baseNearExpirySalvageHours && optionVal.totalValue >= NEAR_EXPIRY_MIN_VALUE) {
        shouldSell = true;
        reason = "near_expiry_salvage";
      } else if (backstopEngaged) {
        // Backstop engaged: skip every other sell-attempt branch.
        // Stamp the held-to-expiry reason on the first crossing only
        // (subsequent cycles see the metadata already set and just
        // log a brief skip line).
        shouldSell = false;
        reason = "no_bid_backstop";
        const alreadyStamped = Boolean((hedge.metadata as any)?.heldToExpiryReason);
        if (!alreadyStamped) {
          try {
            await stampHeldToExpiry(
              params.pool,
              hedge.protectionId,
              "deribit_persistent_no_bid",
              hedge.noBidRetryCount
            );
            console.log(
              `[HedgeManager] no_bid backstop ENGAGED: ${hedge.protectionId} ` +
              `${hedge.noBidRetryCount} no_bid retries (>= threshold ${backstopCfg.threshold}). ` +
              `Halting bounce/prime/late sell attempts. near_expiry_salvage remains enabled. ` +
              `Will hold to expiry; if the option is ITM at expiry Deribit will auto-settle.`
            );
          } catch (mdErr: any) {
            console.warn(
              `[HedgeManager] no_bid backstop stamp failed for ${hedge.protectionId}: ${mdErr?.message}`
            );
          }
        }
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
        } else if (reason === "no_bid_backstop") {
          // Brief skip line on every cycle once backstop is engaged.
          // Avoids the verbose Hold log because the rich detail isn't
          // useful on a hedge we're explicitly holding to expiry.
          console.log(`[HedgeManager] no_bid_backstop holding: ${hedge.protectionId} ${hoursToExpiry.toFixed(1)}h to expiry · ${hedge.noBidRetryCount} prior no_bid retries`);
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
    `[HedgeManager] Cycle complete: scanned=${result.scanned} tpSold=${result.tpSold} salvaged=${result.salvaged} expired=${result.expired} noBid=${result.noBidRetries} errors=${result.errors} skipped=${result.skipped} vol=${adaptiveBase.regime}(${dvol.toFixed(0)})`
  );
  return result;
};
