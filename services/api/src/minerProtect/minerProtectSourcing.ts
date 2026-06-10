/**
 * Miner Protect — multi-venue floor sourcing + quote assembly.
 *
 * Composes the SHARED crypto probe primitives (okxProbe / venuePutProbes / perpProtectLegSelect /
 * perpProtectDepth) to source the cheapest qualifying protective put at a strike across OKX / Deribit
 * / Bullish / Bybit — the multi-venue moat applies (this is a BTC put). `assembleMinerQuote` is the
 * orchestrator and takes an INJECTED `sourcePut` so it stays unit-testable offline.
 */

import {
  buildMinerProtectQuote, costPerDayUsd, btcPerDay, breakevenPriceUsd,
  type MinerInputs, type MinerProtectQuote
} from "./minerProtectQuote";
import type { PremiumPricer } from "../singleSide/twoSided/perpProtectQuote";
import type { BullishProbeClientLike } from "../singleSide/twoSided/venuePutProbes";

/** Protective floors are OTM puts (≤ spot): we floor downside from the CURRENT price, never above it.
 *  Drawdown floors below spot, plus the breakeven price when it sits below spot (protect-to-breakeven).
 *  When breakeven ≥ spot the miner is already underwater → only drawdown floors (capped at spot). */
export const DEFAULT_FLOOR_DRAWDOWNS = [0.05, 0.1, 0.15, 0.2];

export const floorStrikeLadder = (breakevenPrice: number, spot: number, drawdowns: number[] = DEFAULT_FLOOR_DRAWDOWNS): number[] => {
  if (!(spot > 0)) return [];
  const raw: number[] = [];
  if (breakevenPrice > 0 && breakevenPrice < spot) raw.push(breakevenPrice); // protect-to-breakeven (OTM)
  for (const d of drawdowns) {
    if (!(d > 0) || d >= 1) continue;
    raw.push(spot * (1 - d));
  }
  const seen = new Set<number>();
  const out: number[] = [];
  for (const k of raw.sort((a, b) => b - a)) { // closest-to-spot first
    if (!(k > 0) || k > spot) continue;
    const key = Math.round(k);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(+k.toFixed(2));
  }
  return out;
};

export type SourcedPut = { strike: number; ask: number | null; venue: string | null; spreadPct: number | null };
export type FloorSource = { best: SourcedPut | null; considered: string[] };

/** Miner protection is inherently DEEP-OTM and longer-dated → wider spreads / coarser expiries are
 *  normal, so the selection guards are looser than the near-money perp defaults (env-overridable). */
const MINER_MAX_SPREAD_PCT = Number(process.env.MINER_PROTECT_MAX_SPREAD_PCT ?? 0.6);
const MINER_MAX_TENOR_DEV_PCT = Number(process.env.MINER_PROTECT_MAX_TENOR_DEV_PCT ?? 0.5);

/** Source the cheapest qualifying put at `strike` across venues (size-aware when depth is present). */
export const sourceFloorPut = async (
  strike: number,
  opts: { spot: number; tenorDays: number; bullishProbeClient?: BullishProbeClientLike | null; sizeBtc?: number }
): Promise<FloorSource> => {
  const { okxProbe } = await import("../singleSide/twoSided/okxProbe");
  const { deribitPutProbe, bullishPutProbe, bybitPutProbe } = await import("../singleSide/twoSided/venuePutProbes");
  const { pickBestLegs } = await import("../singleSide/twoSided/perpProtectLegSelect");
  const { vwapToFill } = await import("../singleSide/twoSided/perpProtectDepth");
  const { spot, tenorDays } = opts;
  const size = opts.sizeBtc && opts.sizeBtc > 0 ? opts.sizeBtc : null;

  const okx = await okxProbe({ spot, putStrike: strike, callStrike: strike, tenorDays })
    .then((o) => o.legs.find((l) => l.opt_type === "put")).catch(() => null);
  const [der, bull, byb] = await Promise.all([
    deribitPutProbe({ spot, strike, tenorDays, optType: "put" }),
    bullishPutProbe(opts.bullishProbeClient, { spot, strike, tenorDays, optType: "put" }),
    bybitPutProbe({ spot, strike, tenorDays, optType: "put" })
  ]);
  const eff = (askTob: number | null, levels?: Array<{ price_usdc_per_btc: number; size_btc: number }>): number | null =>
    size && levels && levels.length
      ? (vwapToFill(levels.map((l) => ({ priceUsdcPerBtc: l.price_usdc_per_btc, sizeBtc: l.size_btc })), size, "ask")?.effective_usdc_per_btc ?? askTob)
      : askTob;
  const rows = [
    { venue: "okx", ask: eff(okx?.ask_usdc_per_btc ?? null, okx?.ask_levels), bid: null, strike: okx?.strike ?? null, daysToExpiry: okx?.days_to_expiry ?? null, spreadPct: okx?.spread_pct ?? null },
    { venue: "deribit", ask: eff(der.ask_usdc_per_btc, der.ask_levels), bid: null, strike: der.strike ?? null, daysToExpiry: der.days_to_expiry ?? null, spreadPct: der.spread_pct ?? null },
    { venue: "bullish", ask: eff(bull.ask_usdc_per_btc, bull.ask_levels), bid: null, strike: bull.strike ?? null, daysToExpiry: bull.days_to_expiry ?? null, spreadPct: bull.spread_pct ?? null },
    { venue: "bybit", ask: eff(byb.ask_usdc_per_btc, byb.ask_levels), bid: null, strike: byb.strike ?? null, daysToExpiry: byb.days_to_expiry ?? null, spreadPct: byb.spread_pct ?? null }
  ];
  const considered = rows.filter((r) => r.ask != null && (r.ask as number) > 0).map((r) => r.venue);
  const { bestAsk } = pickBestLegs(rows, { targetTenorDays: tenorDays, maxSpreadPct: MINER_MAX_SPREAD_PCT, maxTenorDeviationPct: MINER_MAX_TENOR_DEV_PCT });
  const best = bestAsk && bestAsk.ask != null ? { strike: bestAsk.strike, ask: bestAsk.ask, venue: bestAsk.venue, spreadPct: bestAsk.spreadPct } : null;
  return { best, considered };
};

/**
 * Orchestrate a miner-protect quote: compute breakeven → strike ladder → source each floor (injected)
 * → assemble. `sourcePut` is injected so this is unit-testable offline; the route passes the live
 * multi-venue `sourceFloorPut`.
 */
export const assembleMinerQuote = async (
  inputs: MinerInputs,
  deps: { sourcePut: (strike: number) => Promise<FloorSource>; drawdowns?: number[]; pricer?: PremiumPricer }
): Promise<MinerProtectQuote & { breakeven_price_usd: number; floor_strikes: number[]; venues_considered: string[] }> => {
  const costDay = costPerDayUsd(inputs);
  const btcDay = btcPerDay(inputs.hashrateThs, inputs.btcPerThPerDay);
  const breakeven = breakevenPriceUsd(costDay, btcDay);
  const strikes = floorStrikeLadder(breakeven, inputs.btcPrice, deps.drawdowns);
  const sourced = await Promise.all(strikes.map((s) => deps.sourcePut(s)));
  const floors = sourced
    .map((r) => r.best)
    .filter((r): r is SourcedPut => r != null && r.ask != null && r.ask > 0)
    .map((r) => ({ strike: r.strike, askUsdcPerBtc: r.ask as number, spreadPct: r.spreadPct }));
  const venuesConsidered = [...new Set(sourced.flatMap((r) => r.considered))];
  const quote = buildMinerProtectQuote(inputs, { floors, pricer: deps.pricer });
  return { ...quote, breakeven_price_usd: quote.miner.breakeven_price_usd, floor_strikes: strikes, venues_considered: venuesConsidered };
};
