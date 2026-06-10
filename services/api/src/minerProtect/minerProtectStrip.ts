/**
 * Miner Protect PR3 — production strip (multi-tenor) + hedge monitoring / roll-trigger evaluator.
 *
 * A miner's production is ongoing, so protection is a STRIP across horizons (e.g. 30/60/90d), rolled
 * over time. `buildProductionStrip` prices a breakeven-floor quote per tenor (reusing assembleMiner
 * Quote). `evaluateHedge` is a pure monitor: given an active hedge + current state it returns the
 * protection status and a recommended action (hold / roll / take-profit / expired).
 */

import { assembleMinerQuote, type FloorSource } from "./minerProtectSourcing";
import type { MinerInputs } from "./minerProtectQuote";
import type { PremiumPricer } from "../singleSide/twoSided/perpProtectQuote";

const round2 = (x: number) => +x.toFixed(2);

export const DEFAULT_STRIP_TENORS = [30, 60, 90];

export type StripLeg = { tenor_days: number; quote: Awaited<ReturnType<typeof assembleMinerQuote>> };

/** Price a breakeven-floor quote per tenor in the strip. `sourcePut` is injected (strike, tenor). */
export const buildProductionStrip = async (
  inputs: MinerInputs,
  deps: { tenors?: number[]; sourcePut: (strike: number, tenorDays: number) => Promise<FloorSource>; pricer?: PremiumPricer }
): Promise<{ legs: StripLeg[]; total_recommended_premium_usd: number }> => {
  const tenors = (deps.tenors && deps.tenors.length ? deps.tenors : DEFAULT_STRIP_TENORS).filter((t) => t > 0);
  const legs: StripLeg[] = [];
  for (const t of tenors) {
    const quote = await assembleMinerQuote({ ...inputs, tenorDays: t }, { sourcePut: (s) => deps.sourcePut(s, t), pricer: deps.pricer });
    legs.push({ tenor_days: t, quote });
  }
  const total = legs.reduce((s, l) => s + (l.quote.options.find((o) => o.recommended)?.premium_usd ?? 0), 0);
  return { legs, total_recommended_premium_usd: round2(total) };
};

// ── Monitoring / roll triggers ──────────────────────────────────────────────

export type ActiveHedge = {
  strike: number;          // protective put strike (price floor)
  expiry_iso: string;      // ISO expiry
  premium_usd: number;     // premium paid
  hedged_btc: number;      // BTC protected
};
export type HedgeState = {
  spot: number;            // current BTC price
  now_iso?: string;        // defaults to now
  breakeven_price?: number; // miner breakeven (optional, for the below-breakeven flag)
};
export type HedgeMonitorConfig = {
  rollDaysThreshold: number;     // roll when days-to-expiry ≤ this
  takeProfitMultiple: number;    // suggest take-profit when intrinsic ≥ multiple × premium
};
export const DEFAULT_MONITOR_CONFIG: HedgeMonitorConfig = { rollDaysThreshold: 14, takeProfitMultiple: 2 };

export type HedgeStatus = {
  days_to_expiry: number;
  protection_active: boolean;   // spot below the floor → the put is in-the-money
  below_breakeven: boolean;     // spot below the miner's breakeven
  put_intrinsic_usd: number;    // max(0, strike − spot) × hedged_btc
  pnl_vs_premium_usd: number;   // intrinsic − premium (rough; ignores residual time value)
  roll_due: boolean;
  take_profit: boolean;
  action: "hold" | "roll" | "take_profit" | "expired";
};

export const evaluateHedge = (h: ActiveHedge, s: HedgeState, cfg: HedgeMonitorConfig = DEFAULT_MONITOR_CONFIG): HedgeStatus => {
  const now = s.now_iso ? Date.parse(s.now_iso) : Date.now();
  const exp = Date.parse(h.expiry_iso);
  const dte = Number.isFinite(exp) ? Math.max(0, (exp - now) / 86_400_000) : 0;
  const intrinsic = Math.max(0, h.strike - s.spot) * h.hedged_btc;
  const protectionActive = s.spot < h.strike;
  const belowBreakeven = s.breakeven_price != null && s.spot < s.breakeven_price;
  const rollDue = dte <= cfg.rollDaysThreshold;
  const takeProfit = h.premium_usd > 0 && intrinsic >= cfg.takeProfitMultiple * h.premium_usd;
  const action: HedgeStatus["action"] = dte <= 0 ? "expired" : takeProfit ? "take_profit" : rollDue ? "roll" : "hold";
  return {
    days_to_expiry: +dte.toFixed(2),
    protection_active: protectionActive,
    below_breakeven: belowBreakeven,
    put_intrinsic_usd: round2(intrinsic),
    pnl_vs_premium_usd: round2(intrinsic - h.premium_usd),
    roll_due: rollDue,
    take_profit: takeProfit,
    action
  };
};
