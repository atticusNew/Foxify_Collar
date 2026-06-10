/**
 * BTC ETF Protect — protection quote engine (pure, testable).
 *
 * SEPARATE offering from Perp Protect, but reuses the same primitives: an entry-aware worst case and
 * the transparent underwriter premium build-up (perpProtectPricing). It prices listed-options hedges
 * for a SPOT Bitcoin-ETF holding (IBIT-first): protective put, put spread, and collar.
 *
 * Differences from the crypto engine that this module handles:
 *   - Equity/ETF options are 100 shares/contract → protection is sized in whole CONTRACTS, with any
 *     residual (sub-100) shares surfaced as unhedged.
 *   - Premiums are quoted PER SHARE (× shares = USD); structures include a collar (put + short call).
 *   - American-style settlement is the default (vs European for crypto); carried as a flag.
 *   - No leverage / liquidation: worst case is measured from the position's entry (cost basis), and
 *     a put strike above entry locks in a gain (negative "loss").
 *
 * Venue/options quotes are INJECTED (per-share asks/bids) so this stays pure + unit-testable; the
 * IBKR / market-data adapters fill them in the route layer.
 */

import { makePerpProtectPricer } from "../singleSide/twoSided/perpProtectPricing";
import type { PremiumPricer, PremiumBreakdown } from "../singleSide/twoSided/perpProtectQuote";

export type SettlementStyle = "american" | "european";
export const CONTRACT_MULTIPLIER = 100; // US equity/ETF listed options: 100 shares per contract.

/** Whole-contract sizing for a share holding: hedge in 100-share lots, surface the residual. */
export const contractSizing = (shares: number): { contracts: number; hedgedShares: number; residualShares: number } => {
  const contracts = Math.max(0, Math.floor(shares / CONTRACT_MULTIPLIER));
  const hedgedShares = contracts * CONTRACT_MULTIPLIER;
  return { contracts, hedgedShares, residualShares: Math.max(0, shares - hedgedShares) };
};

export type EtfPosition = {
  symbol: string;        // e.g. "IBIT"
  shares: number;        // shares held
  price: number;         // current ETF mark (per share)
  entryPrice?: number;   // cost basis per share; defaults to mark when unknown
  tenorDays: number;
  settlementStyle?: SettlementStyle; // default "american" for listed ETF options
};

/** A single protective-put tier quote (per-share premium at a listed strike near floorPct×price). */
export type EtfPutQuote = {
  floorPct: number;          // 0.90 = protect down to 90% of price
  strike: number;            // actual listed strike
  putAskPerShare: number;    // cost to BUY the put, per share
  putBidPerShare?: number | null;
  spreadPct?: number | null; // top-of-book relative spread (liquidity signal for the pricer)
};

/** Collar legs: long put (floor) + short call (upside cap). Net per-share cost = putAsk − callBid. */
export type EtfCollarQuote = {
  floorPct: number;
  putStrike: number;
  putAskPerShare: number;
  callStrike: number;
  callBidPerShare: number;
  spreadPct?: number | null;
};

/** Put-spread legs: long put K1 (floor) + short put K2 (deeper) → cheaper, protection only K1→K2. */
export type EtfPutSpreadQuote = {
  floorPct: number;
  longStrike: number;
  longAskPerShare: number;
  shortStrike: number;
  shortBidPerShare: number;
  spreadPct?: number | null;
};

export type EtfStructure = "put" | "put_spread" | "collar";

export type EtfProtectOption = {
  id: string;
  label: string;                 // advisor-friendly, e.g. "90% floor" / "90% floor + cap $66"
  structure: EtfStructure;
  floor_pct: number;
  put_strike: number;
  call_strike: number | null;    // collar upside cap (else null)
  short_put_strike: number | null; // put-spread deeper leg (else null)
  contracts: number;
  hedged_shares: number;
  residual_shares: number;
  premium_usd: number;           // RETAIL premium the holder pays (whole position)
  hedge_cost_usd: number;        // INTERNAL: our sourced hedge cost
  premium_breakdown: PremiumBreakdown;
  /** Most you can lose on the hedged shares held to expiry (incl. premium). A put strike above entry
   *  can lock a gain → negative. For a spread, loss at the band edge; below it you're re-exposed. */
  worst_case_usd: number;
  capped: boolean;               // true = single put / collar (hard floor); false = put spread
  exposed_beyond: number | null; // put spread: price below which protection runs out
  protect_floor_price: number;   // the put strike (price floor)
  upside_cap_price: number | null; // collar call strike (else null)
  cost_pct_position: number;     // premium / hedged-share value
  recommended: boolean;
  note: string;
};

export type EtfProtectQuote = {
  position: {
    symbol: string; shares: number; price: number; entry_price: number;
    contracts: number; hedged_shares: number; residual_shares: number;
    hedged_value_usd: number; position_value_usd: number;
  };
  settlement_style: SettlementStyle;
  tenor_days: number;
  options: EtfProtectOption[];
};

const round2 = (x: number) => +x.toFixed(2);
const round4 = (x: number) => +x.toFixed(4);
const usd = (x: number) => `$${Math.round(x).toLocaleString()}`;
const pctLabel = (floorPct: number) => `${Math.round(floorPct * 100)}% floor`;

const identityBreakdown = (hedge: number): PremiumBreakdown => ({
  hedge_cost_usdc: round2(hedge), slippage_buffer_usdc: 0, tail_load_usdc: 0,
  capital_charge_usdc: 0, atticus_margin_usdc: 0, retail_premium_usdc: round2(hedge)
});

const price = (hedgeUsd: number, notionalUsd: number, tenorDays: number, spreadPct: number | null, structure: "single" | "spread", pricer?: PremiumPricer): PremiumBreakdown =>
  pricer
    ? pricer(hedgeUsd, { notionalUsdc: notionalUsd, marginUsdc: notionalUsd, tenorDays, spreadPct, structure, leverage: 1 })
    : identityBreakdown(hedgeUsd);

/** Protective put — hard floor at the strike. worst case = (entry − K)·hedgedShares + premium. */
export const buildProtectivePut = (pos: EtfPosition, q: EtfPutQuote, idx: number, pricer?: PremiumPricer): EtfProtectOption => {
  const entry = pos.entryPrice && pos.entryPrice > 0 ? pos.entryPrice : pos.price;
  const { contracts, hedgedShares, residualShares } = contractSizing(pos.shares);
  const hedgeCost = q.putAskPerShare * hedgedShares;
  const notional = hedgedShares * pos.price;
  const breakdown = price(hedgeCost, notional, pos.tenorDays, q.spreadPct ?? null, "single", pricer);
  const premium = breakdown.retail_premium_usdc;
  const worstCase = (entry - q.strike) * hedgedShares + premium;
  return {
    id: `put-${idx}`, label: pctLabel(q.floorPct), structure: "put", floor_pct: round4(q.floorPct),
    put_strike: round2(q.strike), call_strike: null, short_put_strike: null,
    contracts, hedged_shares: hedgedShares, residual_shares: residualShares,
    premium_usd: round2(premium), hedge_cost_usd: round2(breakdown.hedge_cost_usdc), premium_breakdown: breakdown,
    worst_case_usd: round2(worstCase), capped: true, exposed_beyond: null,
    protect_floor_price: round2(q.strike), upside_cap_price: null,
    cost_pct_position: notional > 0 ? round4(premium / notional) : 0, recommended: false,
    note: `Protective put: caps loss on ${contracts} contract${contracts === 1 ? "" : "s"} (${hedgedShares} sh) below ${usd(q.strike)}.${residualShares > 0 ? ` ${residualShares} residual share${residualShares === 1 ? "" : "s"} unhedged.` : ""}`
  };
};

/** Collar — long put floor + short call cap; net per-share cost = putAsk − callBid (can be ≤ 0). */
export const buildCollar = (pos: EtfPosition, q: EtfCollarQuote, pricer?: PremiumPricer): EtfProtectOption | null => {
  if (!(q.callStrike > q.putStrike)) return null; // cap must sit above the floor
  const entry = pos.entryPrice && pos.entryPrice > 0 ? pos.entryPrice : pos.price;
  const { contracts, hedgedShares, residualShares } = contractSizing(pos.shares);
  const netPerShare = q.putAskPerShare - q.callBidPerShare;
  const hedgeCost = Math.max(0, netPerShare) * hedgedShares;
  const notional = hedgedShares * pos.price;
  const breakdown = price(hedgeCost, notional, pos.tenorDays, q.spreadPct ?? null, "single", pricer);
  const premium = breakdown.retail_premium_usdc;
  const worstCase = (entry - q.putStrike) * hedgedShares + premium;
  return {
    id: "collar", label: `${pctLabel(q.floorPct)} + cap ${usd(q.callStrike)}`, structure: "collar", floor_pct: round4(q.floorPct),
    put_strike: round2(q.putStrike), call_strike: round2(q.callStrike), short_put_strike: null,
    contracts, hedged_shares: hedgedShares, residual_shares: residualShares,
    premium_usd: round2(premium), hedge_cost_usd: round2(breakdown.hedge_cost_usdc), premium_breakdown: breakdown,
    worst_case_usd: round2(worstCase), capped: true, exposed_beyond: null,
    protect_floor_price: round2(q.putStrike), upside_cap_price: round2(q.callStrike),
    cost_pct_position: notional > 0 ? round4(premium / notional) : 0, recommended: false,
    note: `Collar: floor at ${usd(q.putStrike)}, upside capped at ${usd(q.callStrike)} — lower cost, gains above the cap are forgone.`
  };
};

/** Put spread — long put K1 (floor) − short put K2 (deeper). Cheaper; protection only spans K1→K2. */
export const buildPutSpread = (pos: EtfPosition, q: EtfPutSpreadQuote, pricer?: PremiumPricer): EtfProtectOption | null => {
  if (!(q.shortStrike < q.longStrike)) return null; // short leg must be deeper (lower) than the long
  const netPerShare = q.longAskPerShare - q.shortBidPerShare;
  if (!(netPerShare > 0)) return null;
  const entry = pos.entryPrice && pos.entryPrice > 0 ? pos.entryPrice : pos.price;
  const { contracts, hedgedShares, residualShares } = contractSizing(pos.shares);
  const hedgeCost = netPerShare * hedgedShares;
  const notional = hedgedShares * pos.price;
  const breakdown = price(hedgeCost, notional, pos.tenorDays, q.spreadPct ?? null, "spread", pricer);
  const premium = breakdown.retail_premium_usdc;
  const bandEdgeLoss = (entry - q.longStrike) * hedgedShares + premium; // loss at the deeper strike K2
  return {
    id: "put-spread", label: `${pctLabel(q.floorPct)} (spread)`, structure: "put_spread", floor_pct: round4(q.floorPct),
    put_strike: round2(q.longStrike), call_strike: null, short_put_strike: round2(q.shortStrike),
    contracts, hedged_shares: hedgedShares, residual_shares: residualShares,
    premium_usd: round2(premium), hedge_cost_usd: round2(breakdown.hedge_cost_usdc), premium_breakdown: breakdown,
    worst_case_usd: round2(bandEdgeLoss), capped: false, exposed_beyond: round2(q.shortStrike),
    protect_floor_price: round2(q.longStrike), upside_cap_price: null,
    cost_pct_position: notional > 0 ? round4(premium / notional) : 0, recommended: false,
    note: `Cheaper: protects from ${usd(q.longStrike)} down to ${usd(q.shortStrike)}; re-exposed below ${usd(q.shortStrike)}.`
  };
};

/**
 * Recommend the best-value protection: the CHEAPEST capped option whose worst case is within a
 * reasonable share of the hedged position value (default 15%). Spreads are never the default (they
 * re-expose). Falls back to the lowest worst case when nothing meets the bound.
 */
export const pickRecommendedEtf = (options: EtfProtectOption[], hedgedValueUsd: number, maxWorstCasePct = 0.15): string | null => {
  const capped = options.filter((o) => o.capped);
  if (capped.length === 0) return null;
  const acceptable = hedgedValueUsd > 0 ? capped.filter((o) => o.worst_case_usd <= maxWorstCasePct * hedgedValueUsd) : [];
  const pool = acceptable.length > 0 ? acceptable : capped;
  const chosen = [...pool].sort((a, b) => a.premium_usd - b.premium_usd || a.worst_case_usd - b.worst_case_usd)[0];
  return chosen?.id ?? null;
};

export const buildEtfProtectQuote = (
  pos: EtfPosition,
  inputs: { puts: EtfPutQuote[]; collar?: EtfCollarQuote | null; putSpread?: EtfPutSpreadQuote | null; pricer?: PremiumPricer; recMaxWorstCasePct?: number }
): EtfProtectQuote => {
  const entry = pos.entryPrice && pos.entryPrice > 0 ? pos.entryPrice : pos.price;
  const { contracts, hedgedShares, residualShares } = contractSizing(pos.shares);
  const hedgedValue = hedgedShares * pos.price;
  const pricer = inputs.pricer;

  const options: EtfProtectOption[] = [];
  const seen = new Set<number>();
  inputs.puts.forEach((q, i) => {
    if (!(q.putAskPerShare > 0) || !(q.strike > 0)) return;
    const key = Math.round(q.strike);
    if (seen.has(key)) return;
    seen.add(key);
    options.push(buildProtectivePut(pos, q, i, pricer));
  });
  if (inputs.collar) { const c = buildCollar(pos, inputs.collar, pricer); if (c) options.push(c); }
  if (inputs.putSpread) { const s = buildPutSpread(pos, inputs.putSpread, pricer); if (s) options.push(s); }

  const recId = pickRecommendedEtf(options, hedgedValue, inputs.recMaxWorstCasePct ?? 0.15);
  if (recId) { const r = options.find((o) => o.id === recId); if (r) r.recommended = true; }

  return {
    position: {
      symbol: pos.symbol, shares: pos.shares, price: round2(pos.price), entry_price: round2(entry),
      contracts, hedged_shares: hedgedShares, residual_shares: residualShares,
      hedged_value_usd: round2(hedgedValue), position_value_usd: round2(pos.shares * pos.price)
    },
    settlement_style: pos.settlementStyle ?? "american",
    tenor_days: pos.tenorDays,
    options
  };
};

/** Convenience: build the default protective-put pricer (reuses the perp underwriter build-up). */
export const makeEtfPricer = (): PremiumPricer => makePerpProtectPricer();
