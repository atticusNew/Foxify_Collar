import { parseBooleanEnv, parsePositiveFinite, parsePositiveIntInRange, parseNonNegativeFinite } from "./config";

export type TreasuryStructure = "pass_through" | "fixed_payout";

export type TreasuryConfig = {
  enabled: boolean;
  structure: TreasuryStructure;
  notionalUsd: number;
  floorPct: number;
  tenorDays: number;
  dailyPremiumBps: number;
  executionTimeUtcHour: number;
  executionTimeUtcMinute: number;
  checkIntervalMs: number;
  triggerMonitorIntervalMs: number;
  tpThresholdMultiplier: number;
  autoSellOnTriggerPct: number;
  maxHoldAfterTriggerHours: number;
  venue: "deribit" | "falconx";
  clientName: string;
  adminToken: string;
};

export const parseTreasuryConfig = (): TreasuryConfig => ({
  enabled: parseBooleanEnv(process.env.TREASURY_ENABLED, false),
  structure: String(process.env.TREASURY_STRUCTURE || "pass_through") === "fixed_payout" ? "fixed_payout" : "pass_through",
  notionalUsd: parsePositiveFinite(
    process.env.TREASURY_NOTIONAL_USD,
    1000000,
    "invalid_treasury_notional_usd"
  ),
  floorPct: parsePositiveFinite(
    process.env.TREASURY_FLOOR_PCT,
    2,
    "invalid_treasury_floor_pct"
  ),
  tenorDays: parsePositiveIntInRange(
    process.env.TREASURY_TENOR_DAYS,
    1,
    1,
    7,
    "invalid_treasury_tenor_days"
  ),
  dailyPremiumBps: parseNonNegativeFinite(
    process.env.TREASURY_DAILY_PREMIUM_BPS,
    25,
    "invalid_treasury_daily_premium_bps"
  ),
  executionTimeUtcHour: parsePositiveIntInRange(
    process.env.TREASURY_EXECUTION_HOUR_UTC,
    0,
    0,
    23,
    "invalid_treasury_execution_hour"
  ),
  executionTimeUtcMinute: parsePositiveIntInRange(
    process.env.TREASURY_EXECUTION_MINUTE_UTC,
    5,
    0,
    59,
    "invalid_treasury_execution_minute"
  ),
  checkIntervalMs: parsePositiveIntInRange(
    process.env.TREASURY_CHECK_INTERVAL_MS,
    300000,
    60000,
    3600000,
    "invalid_treasury_check_interval_ms"
  ),
  triggerMonitorIntervalMs: parsePositiveIntInRange(
    process.env.TREASURY_TRIGGER_MONITOR_INTERVAL_MS,
    30000,
    5000,
    300000,
    "invalid_treasury_trigger_monitor_interval_ms"
  ),
  tpThresholdMultiplier: parsePositiveFinite(
    process.env.TREASURY_TP_THRESHOLD_MULTIPLIER,
    1.3,
    "invalid_treasury_tp_threshold_multiplier"
  ),
  autoSellOnTriggerPct: parsePositiveFinite(
    process.env.TREASURY_AUTO_SELL_ON_TRIGGER_PCT,
    80,
    "invalid_treasury_auto_sell_on_trigger_pct"
  ),
  maxHoldAfterTriggerHours: parsePositiveIntInRange(
    process.env.TREASURY_MAX_HOLD_AFTER_TRIGGER_HOURS,
    24,
    1,
    72,
    "invalid_treasury_max_hold_after_trigger_hours"
  ),
  venue: String(process.env.TREASURY_VENUE || "deribit") === "falconx" ? "falconx" : "deribit",
  clientName: String(process.env.TREASURY_CLIENT_NAME || "Foxify").trim(),
  adminToken: String(process.env.TREASURY_ADMIN_TOKEN || process.env.PILOT_ADMIN_TOKEN || "").trim()
});
