/**
 * Public-safe snapshot service — powers the UNGATED LinkedIn-shareable Protected-Leverage demo.
 *
 * Design constraints (so a public link is safe):
 *  - REAL pricing, but public requests NEVER trigger live venue calls. A background refresher
 *    recomputes a small preset matrix (side × leverage × tenor) on an interval; public requests
 *    read ONLY from this in-memory cache.
 *  - Uses OKX + Deribit ONLY (keyless public REST) — never the rate-limited/credentialed Bullish
 *    client. Public users never learn which venues are used.
 *  - SANITIZED to percentages: no venue names, no instruments, no absolute strikes/market levels.
 *    Moves are expressed as % of spot; cost as % of margin. (Pricing is collateral-independent in
 *    %, so the widget scales it to any collateral exactly.)
 *
 * READ-ONLY. No tokens. No DB. No orders.
 */

import { okxProbe } from "./okxProbe";
import { deribitPutProbe } from "./venuePutProbes";
import { buildFloorTierBundle, strikeForMarginFraction, type TradeSide, type TierPutQuote } from "./floorTiers";
import { computeWickInsurance, type VenueLegQuotes } from "./wickInsurance";

export const PUBLIC_PRESET_LEVERAGE = [5, 10, 20, 30, 40] as const;
export const PUBLIC_PRESET_TENOR = [1, 3, 7] as const;
const HIGH_LEV = 25;
const REF_COLLATERAL = 1000; // reference; everything stored as %, so scale-free
const FRACTIONS = [0.25, 0.5, 0.75];

export type PublicTier = {
  name: string;                       // Safer / Balanced / Cheapest
  recommended: boolean;
  available: boolean;
  worst_case_x_margin: number | null; // max loss ÷ margin (e.g. 0.43 = 43% of margin)
  cost_x_margin: number | null;       // premium ÷ margin
  cost_per_day_x_margin: number | null;
  protect_move_pct: number | null;    // where protection sits, as % move from spot
};

export type PublicWick = {
  single: { cost_x_margin: number; gap_proof: true } | null;
  spread: { cost_x_margin: number; survive_to_pct: number } | null;
};

export type PublicSnapshot = {
  side: TradeSide;
  leverage: number;
  tenor_days: number;
  mode: "cap" | "wick";
  liq_move_pct: number;               // |1/leverage| — the move that liquidates you, unprotected
  as_of: string;
  tiers?: PublicTier[];               // cap mode
  wick?: PublicWick;                  // wick mode
};

const cache = new Map<string, PublicSnapshot>();
const keyOf = (side: TradeSide, lev: number, tenor: number) => `${side}:${lev}:${tenor}`;

/** Nearest preset leverage (public mode snaps leverage to keep the cache small). */
export const nearestPresetLeverage = (lev: number): number =>
  PUBLIC_PRESET_LEVERAGE.reduce((b, p) => (Math.abs(p - lev) < Math.abs(b - lev) ? p : b), PUBLIC_PRESET_LEVERAGE[0]);

export const getPublicSnapshot = (side: TradeSide, lev: number, tenor: number): PublicSnapshot | null =>
  cache.get(keyOf(side, nearestPresetLeverage(lev), tenor)) ?? null;

export const publicSnapshotCount = (): number => cache.size;

/** Cheapest ask (long leg) across OKX+Deribit at a strike, with the actual strike + a bid. */
const cheapestLeg = async (spot: number, strike: number, optType: "put" | "call", tenorDays: number) => {
  const okx = await okxProbe({ spot, putStrike: strike, callStrike: strike, tenorDays }).then((o) => o.legs.find((l) => l.opt_type === optType)).catch(() => null);
  const der = await deribitPutProbe({ spot, strike, tenorDays, optType });
  const asks = [
    { ask: okx?.ask_usdc_per_btc ?? null, bid: okx?.bid_usdc_per_btc ?? null, strike: okx?.strike ?? null },
    { ask: der.ask_usdc_per_btc, bid: der.bid_usdc_per_btc ?? null, strike: der.strike ?? null }
  ].filter((q) => q.ask != null && q.ask > 0) as { ask: number; bid: number | null; strike: number | null }[];
  if (asks.length === 0) return null;
  return asks.reduce((b, q) => (q.ask < b.ask ? q : b));
};

const computeOne = async (spot: number, side: TradeSide, leverage: number, tenorDays: number): Promise<PublicSnapshot> => {
  const margin = REF_COLLATERAL;
  const sizeBtc = (REF_COLLATERAL * leverage) / spot;
  const liqMove = leverage > 0 ? 1 / leverage : 1;
  const optType: "put" | "call" = side === "short" ? "call" : "put";
  const base = { side, leverage, tenor_days: tenorDays, liq_move_pct: +liqMove.toFixed(4), as_of: new Date().toISOString() };

  if (leverage >= HIGH_LEV) {
    const k1p = Math.max(0.005, liqMove * 0.8), k2p = Math.min(0.5, liqMove * 1.6);
    const k1 = side === "short" ? spot * (1 + k1p) : spot * (1 - k1p);
    const k2 = side === "short" ? spot * (1 + k2p) : spot * (1 - k2p);
    const [l1, l2] = await Promise.all([cheapestLeg(spot, k1, optType, tenorDays), cheapestLeg(spot, k2, optType, tenorDays)]);
    const quotes: VenueLegQuotes[] = [{ venue: "blended", k1AskUsdcPerBtc: l1?.ask ?? null, k1Strike: l1?.strike ?? null, k2BidUsdcPerBtc: l2?.bid ?? null, k2Strike: l2?.strike ?? null }];
    const r = computeWickInsurance({ spot, collateralUsdc: REF_COLLATERAL, leverage, tenorDays, side }, quotes);
    const k2Dist = r.best_spread ? Math.abs((r.best_spread.k2_strike - spot) / spot) : null;
    return {
      ...base, mode: "wick",
      wick: {
        single: r.best_single ? { cost_x_margin: +(r.best_single.cost_usdc / margin).toFixed(4), gap_proof: true } : null,
        spread: r.best_spread && k2Dist != null ? { cost_x_margin: +(r.best_spread.cost_usdc / margin).toFixed(4), survive_to_pct: +k2Dist.toFixed(4) } : null
      }
    };
  }

  // cap mode
  const quotesByFraction = new Map<number, TierPutQuote | null>();
  for (const f of FRACTIONS) {
    const { strike } = strikeForMarginFraction(spot, leverage, f, side);
    const leg = await cheapestLeg(spot, strike, optType, tenorDays);
    quotesByFraction.set(f, leg ? { venue: "blended", ask_usdc_per_btc: leg.ask, strike: leg.strike } : null);
  }
  const bundle = buildFloorTierBundle({ spot, sizeBtc, leverage, tenorDays, side, fractions: FRACTIONS }, quotesByFraction);
  const tierName = (f: number) => (f <= 0.33 ? "Safer" : f <= 0.6 ? "Balanced" : "Cheapest");
  const tiers: PublicTier[] = bundle.tiers.map((t) => ({
    name: tierName(t.margin_fraction),
    recommended: t.recommended,
    available: t.available,
    worst_case_x_margin: t.max_loss_usdc != null ? +(t.max_loss_usdc / margin).toFixed(4) : null,
    cost_x_margin: t.put_cost_usdc != null ? +(t.put_cost_usdc / margin).toFixed(4) : null,
    cost_per_day_x_margin: t.cost_per_day_usdc != null ? +(t.cost_per_day_usdc / margin).toFixed(4) : null,
    protect_move_pct: t.floor_pct != null ? +t.floor_pct.toFixed(4) : null
  }));
  return { ...base, mode: "cap", tiers };
};

/** Recompute the full preset matrix and replace the cache. Call on an interval (OKX+Deribit only). */
export const refreshPublicSnapshots = async (getSpot: () => number | null | undefined): Promise<number> => {
  const spot = getSpot();
  if (!spot || spot <= 0) return 0;
  let n = 0;
  for (const side of ["long", "short"] as const) {
    for (const lev of PUBLIC_PRESET_LEVERAGE) {
      for (const tenor of PUBLIC_PRESET_TENOR) {
        try {
          const snap = await computeOne(spot, side, lev, tenor);
          cache.set(keyOf(side, lev, tenor), snap);
          n++;
        } catch { /* skip this combo this cycle */ }
      }
    }
  }
  return n;
};
