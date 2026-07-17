/**
 * OKX LIVE collar planner — pure functions that turn a solved collar (pricer strikes + model premiums)
 * into an executable OKX order plan:
 *   - expiry snapped to the standard 08:00 UTC daily (the grid OKX lists),
 *   - solver strikes mapped to LISTED instruments (nearest strike, drift-tolerance checked),
 *   - contracts rounded to the 0.01 BTC lot (effective notional recomputed honestly),
 *   - limit prices = cross-to-touch CAPPED by a max-slippage band vs the MODEL MID (env-tunable) —
 *     a fill can never be worse than the band by construction (the limit price enforces it).
 *
 * Price convention: OKX coin-margined BTC-USD options quote the premium in BTC per 1 BTC of underlying
 * (like Deribit); one contract = ctVal BTC (0.01). Premium in USD = px × contracts × ctVal × spot.
 * Everything here is PURE (no I/O) so the whole mapping is unit-testable against fixture chains.
 */

import type { PerpSide } from "../creditCollarPricer";

const round2 = (x: number) => +x.toFixed(2);
const round6 = (x: number) => +x.toFixed(6);

/** One listed OKX option instrument, parsed from GET /public/instruments. */
export type OkxChainInstrument = {
  instId: string;
  optType: "put" | "call";
  strike: number;
  expiryMs: number;
  ctValBtc: number;   // contract size in BTC (0.01 for BTC-USD options)
  tickSz: number;
  lotSz: number;
  minSz: number;
  state: string;      // "live" = tradeable
};

/** Parse the raw instruments payload into typed chain rows (skips malformed/non-live-parsable rows). */
export const parseOkxChain = (
  raw: Array<{ instId?: string; optType?: string; stk?: string; expTime?: string; ctVal?: string; tickSz?: string; lotSz?: string; minSz?: string; state?: string }>
): OkxChainInstrument[] =>
  raw
    .map((r) => ({
      instId: String(r.instId ?? ""),
      optType: r.optType === "C" ? ("call" as const) : r.optType === "P" ? ("put" as const) : null,
      strike: Number(r.stk ?? NaN),
      expiryMs: Number(r.expTime ?? NaN),
      ctValBtc: Number(r.ctVal ?? NaN),
      tickSz: Number(r.tickSz ?? NaN),
      lotSz: Number(r.lotSz ?? 1),
      minSz: Number(r.minSz ?? 1),
      state: String(r.state ?? "")
    }))
    .filter(
      (r): r is OkxChainInstrument =>
        r.optType != null && r.instId !== "" && Number.isFinite(r.strike) && r.strike > 0 && Number.isFinite(r.expiryMs) && r.expiryMs > 0 && Number.isFinite(r.ctValBtc) && r.ctValBtc > 0
    );

/**
 * Next standard 08:00 UTC daily expiry at least `minHoursToExpiry` out (running at the 08:15 window
 * ⟹ ~24h tenor). Mirrors the G-20 RFQ expiry snap so every venue settles on the same clock.
 */
export const nextStandardDailyExpiryMs = (nowMs: number, minHoursToExpiry = 12): number => {
  const d = new Date(nowMs);
  d.setUTCHours(8, 0, 0, 0);
  while (d.getTime() - nowMs < minHoursToExpiry * 3_600_000) d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime();
};

/** Round contracts to the venue lot; effective notional recomputed from the ROUNDED size. Pure. */
export const contractsForNotional = (
  notionalUsdc: number,
  spot: number,
  ctValBtc: number
): { contracts: number; contractsBtc: number; effectiveNotionalUsdc: number } => {
  const contracts = Math.round(notionalUsdc / spot / ctValBtc);
  const contractsBtc = contracts * ctValBtc;
  return { contracts, contractsBtc: round6(contractsBtc), effectiveNotionalUsdc: round2(contractsBtc * spot) };
};

/** USD premium of a fill/quote: px (BTC per BTC underlying) × contracts × ctVal × spot. Pure. */
export const premiumUsd = (pxBtc: number, contracts: number, ctValBtc: number, spot: number): number =>
  round2(pxBtc * contracts * ctValBtc * spot);

const floorToTick = (px: number, tickSz: number): number => (tickSz > 0 ? Math.floor(px / tickSz + 1e-9) * tickSz : px);
const ceilToTick = (px: number, tickSz: number): number => (tickSz > 0 ? Math.ceil(px / tickSz - 1e-9) * tickSz : px);
const roundPx = (px: number) => +px.toFixed(8);

/**
 * Band-capped marketable limit price (BTC per BTC underlying). Crosses to the touch but NEVER beyond
 * modelMid × (1 ± band): a buy pays at most modelMid×(1+band); a sell receives at least modelMid×(1−band).
 * If the touch sits outside the band the order rests at the band edge (⟹ timeout → retry → abort, never
 * a fill outside the band). Rounding is CONSERVATIVE (buy floors, sell ceils to tick, then floors at the
 * band cap) so the tick rounding can't push a price through the band.
 */
export const bandCappedLimitPxBtc = (
  action: "buy" | "sell",
  modelMidPxBtc: number,
  touchPxBtc: number | null,
  bandPct: number,
  tickSz: number
): number => {
  if (action === "buy") {
    const cap = modelMidPxBtc * (1 + bandPct);
    const want = touchPxBtc != null ? Math.min(touchPxBtc, cap) : cap;
    return roundPx(Math.max(tickSz > 0 ? tickSz : 0.0001, floorToTick(want, tickSz)));
  }
  const floor = modelMidPxBtc * (1 - bandPct);
  const want = touchPxBtc != null ? Math.max(touchPxBtc, floor) : floor;
  return roundPx(Math.max(tickSz > 0 ? tickSz : 0.0001, ceilToTick(want, tickSz)));
};

/** Was a fill inside the slippage band vs the model mid? (Belt-and-braces — the limit px enforces it.) */
export const fillWithinBand = (action: "buy" | "sell", avgPxBtc: number, modelMidPxBtc: number, bandPct: number): boolean =>
  action === "buy" ? avgPxBtc <= modelMidPxBtc * (1 + bandPct) + 1e-12 : avgPxBtc >= modelMidPxBtc * (1 - bandPct) - 1e-12;

export type PlannedLeg = {
  instId: string;
  optType: "put" | "call";
  action: "buy" | "sell";        // Atticus's side of the hedge leg
  role: "protective" | "funding"; // protective = the leg Atticus BUYS (client floor); funding = the leg Atticus SELLS
  listedStrike: number;
  solverStrike: number;
  strikeDriftPct: number;         // |listed − solver| / solver
  modelMidPxBtc: number;          // model mid, BTC per BTC underlying (slippage reference)
  tickSz: number;
};

export type LiveCollarPlan = {
  side: PerpSide;
  expiryMs: number;
  expiryIso: string;
  contracts: number;
  ctValBtc: number;
  contractsBtc: number;
  effectiveNotionalUsdc: number;
  protective: PlannedLeg;
  funding: PlannedLeg;
};

export type PlanInput = {
  side: PerpSide;
  spot: number;
  notionalUsdc: number;
  /** Solver strikes (USD) from the pricer quote. */
  putStrike: number;
  callStrike: number;
  /** Model MID premiums for the whole position in USDC (pricer legs.floor_leg_mid_usdc / funding_leg_mid_usdc). */
  protectiveMidUsdc: number;
  fundingMidUsdc: number;
  /** Model contracts (notional/spot) the premiums were computed at — converts USDC totals back to px/BTC. */
  modelContractsBtc: number;
  nowMs: number;
  minHoursToExpiry?: number;   // default 12
  maxStrikeDriftPct?: number;  // default 0.01 (1% of spot-relative strike drift)
};

export type PlanResult = { ok: true; plan: LiveCollarPlan } | { ok: false; error: string; message: string };

/**
 * Map a solved collar to listed OKX instruments. The protective leg is the one Atticus BUYS
 * (put for a long-perp client, call for a short-perp client); the funding leg is SOLD.
 * Fails closed on: no expiry listed, missing strikes, excessive strike drift, zero contracts,
 * or inconsistent contract sizes between the two legs.
 */
export const planLiveCollar = (chain: OkxChainInstrument[], input: PlanInput): PlanResult => {
  const expiryMs = nextStandardDailyExpiryMs(input.nowMs, input.minHoursToExpiry ?? 12);
  const live = chain.filter((c) => c.state === "live" && c.expiryMs === expiryMs);
  if (live.length === 0) {
    return { ok: false, error: "expiry_not_listed", message: `no live OKX BTC-USD options at ${new Date(expiryMs).toISOString()} — daily not listed yet or chain fetch incomplete` };
  }

  const protectiveType: "put" | "call" = input.side === "long" ? "put" : "call";
  const fundingType: "put" | "call" = input.side === "long" ? "call" : "put";
  const protectiveSolver = protectiveType === "put" ? input.putStrike : input.callStrike;
  const fundingSolver = fundingType === "call" ? input.callStrike : input.putStrike;

  const nearest = (optType: "put" | "call", target: number): OkxChainInstrument | null =>
    live.filter((c) => c.optType === optType).sort((a, b) => Math.abs(a.strike - target) - Math.abs(b.strike - target))[0] ?? null;

  const prot = nearest(protectiveType, protectiveSolver);
  const fund = nearest(fundingType, fundingSolver);
  if (!prot || !fund) return { ok: false, error: "strikes_not_listed", message: `no listed ${!prot ? protectiveType : fundingType} near ${!prot ? protectiveSolver : fundingSolver} at that expiry` };

  const maxDrift = input.maxStrikeDriftPct ?? 0.01;
  const protDrift = Math.abs(prot.strike - protectiveSolver) / input.spot;
  const fundDrift = Math.abs(fund.strike - fundingSolver) / input.spot;
  if (protDrift > maxDrift || fundDrift > maxDrift) {
    return {
      ok: false,
      error: "strike_drift_too_large",
      message: `nearest listed strike drifts ${round6(Math.max(protDrift, fundDrift) * 100)}% of spot from the solver strike (max ${maxDrift * 100}%) — grid too coarse here, skip rather than misprice`
    };
  }
  // Funding strike must stay on the correct side of spot after snapping (an inverted collar is not the product).
  if (fundingType === "call" && fund.strike <= input.spot) return { ok: false, error: "funding_strike_through_spot", message: `listed call ${fund.strike} ≤ spot ${input.spot}` };
  if (fundingType === "put" && fund.strike >= input.spot) return { ok: false, error: "funding_strike_through_spot", message: `listed put ${fund.strike} ≥ spot ${input.spot}` };

  if (prot.ctValBtc !== fund.ctValBtc) return { ok: false, error: "ctval_mismatch", message: `legs disagree on contract size (${prot.ctValBtc} vs ${fund.ctValBtc})` };

  const size = contractsForNotional(input.notionalUsdc, input.spot, prot.ctValBtc);
  if (size.contracts < 1) return { ok: false, error: "size_rounds_to_zero", message: `notional ${input.notionalUsdc} rounds to 0 contracts of ${prot.ctValBtc} BTC` };

  // Model USDC totals → px in BTC per BTC underlying (size-independent, so rounding contracts is safe).
  const toPxBtc = (midUsdc: number) => (input.modelContractsBtc > 0 && input.spot > 0 ? midUsdc / input.modelContractsBtc / input.spot : 0);
  const protMidPxBtc = toPxBtc(input.protectiveMidUsdc);
  const fundMidPxBtc = toPxBtc(input.fundingMidUsdc);
  if (!(protMidPxBtc > 0) || !(fundMidPxBtc > 0)) return { ok: false, error: "model_mid_invalid", message: "model mids must be positive to anchor the slippage band" };

  const leg = (inst: OkxChainInstrument, action: "buy" | "sell", role: "protective" | "funding", solverStrike: number, drift: number, midPxBtc: number): PlannedLeg => ({
    instId: inst.instId,
    optType: inst.optType,
    action,
    role,
    listedStrike: inst.strike,
    solverStrike,
    strikeDriftPct: round6(drift),
    modelMidPxBtc: roundTo8(midPxBtc),
    tickSz: inst.tickSz
  });

  return {
    ok: true,
    plan: {
      side: input.side,
      expiryMs,
      expiryIso: new Date(expiryMs).toISOString(),
      contracts: size.contracts,
      ctValBtc: prot.ctValBtc,
      contractsBtc: size.contractsBtc,
      effectiveNotionalUsdc: size.effectiveNotionalUsdc,
      protective: leg(prot, "buy", "protective", protectiveSolver, protDrift, protMidPxBtc),
      funding: leg(fund, "sell", "funding", fundingSolver, fundDrift, fundMidPxBtc)
    }
  };
};

const roundTo8 = (x: number) => +x.toFixed(8);
