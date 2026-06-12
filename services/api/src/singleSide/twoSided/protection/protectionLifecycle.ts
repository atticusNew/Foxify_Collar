/**
 * Shadow Protection — lifecycle (Phase 2). PURE + deterministic.
 *
 * A "cover" is one fee-recovery one-touch on one perp position for one tenor window. This module
 * is the state machine: open → (touch | expire) → settled, with the per-cover P&L for BOTH sides,
 * and a scorecard that aggregates a live track record (the validation artifact).
 *
 * SHADOW mode: covers are priced from REAL option quotes and monitored against the REAL BTC feed,
 * but settled on paper (no venue order). This validates the signal + economics live with zero
 * capital. The SAME records/feeds drive a real venue executor later — settlement logic is identical.
 *
 * Atticus is pass-through + ops fee: its hedge (a put-spread) costs `hedge_cost` and, on a touch,
 * is worth ~payout (it funds the payout). So Atticus P&L ≈ premium − hedge_cost in both outcomes
 * (the ops/markup), modulo basis/slippage which the live executor will realize for real.
 */

export type TradeSide = "long" | "short";
export type SignalState = "GO" | "WAIT" | "NA";
export type CoverStatus = "active" | "settled_touch" | "expired_no_touch" | "cancelled";

/** One executed option leg of the replicating spread (open or close), with the venue it routed to. */
export type HedgeFill = {
  role: "inner" | "outer";
  action: "buy" | "sell";
  venue: string;            // "deribit" | "bullish"
  instrument: string;
  strike: number;
  contractsBtc: number;
  fillUsdcPerBtc: number;
  orderId?: string;
};

/** Real hedge attached to a LIVE cover at activation (the spread Atticus actually bought). */
export type HedgeRecord = { debit_usdc: number; effective_payout_usdc: number; venues: string[]; legs: HedgeFill[] };
/** Hedge unwind result attached at settlement. */
export type HedgeClose = { proceeds_usdc: number; realized_hedge_pnl_usdc: number; legs: HedgeFill[] };

export type ProtectionCover = {
  id: string;
  foxify_ref: string | null;        // idempotency / external reference
  created_at_ms: number;
  side: TradeSide;
  spot_at_entry: number;
  trigger_pct: number;
  barrier_price: number;            // long: entry×(1−trig); short: entry×(1+trig)
  tenor_ms: number;
  expires_at_ms: number;
  payout_usdc: number;
  premium_usdc: number;             // what Foxify pays
  hedge_cost_usdc: number;          // what Atticus's hedge costs (fair value)
  ops_fee_usdc: number;
  implied_touch: number;            // priced-in stop probability (from the quote)
  signal: SignalState;              // signal state at activation
  mode: "shadow" | "live";
  status: CoverStatus;
  // settlement (filled on settle)
  settled_at_ms?: number;
  touched?: boolean;
  settle_price?: number;
  foxify_pnl_usdc?: number;         // (touched? payout : 0) − premium
  atticus_pnl_usdc?: number;        // premium − hedge_cost (hedge funds payout on touch)
  /** LIVE covers only: the real spread bought at activation + its unwind at settlement. */
  hedge?: HedgeRecord;
  hedge_close?: HedgeClose;
};

export type OpenCoverInput = {
  id: string;
  foxifyRef?: string | null;
  side?: TradeSide;
  spot: number;
  triggerPct: number;
  tenorMs: number;
  payoutUsdc: number;
  premiumUsdc: number;
  hedgeCostUsdc: number;
  opsFeeUsdc: number;
  impliedTouch: number;
  signal?: SignalState;
  mode?: "shadow" | "live";
  hedge?: HedgeRecord;
  nowMs: number;
};

const round2 = (x: number) => +x.toFixed(2);
const round4 = (x: number) => +x.toFixed(4);

/** Barrier price for the cover. long → below entry; short → above entry. */
export const barrierOf = (side: TradeSide, spot: number, triggerPct: number): number =>
  side === "short" ? spot * (1 + triggerPct) : spot * (1 - triggerPct);

/** Has the barrier been touched at this observed price? long: price ≤ barrier; short: price ≥ barrier. */
export const isTouched = (cover: Pick<ProtectionCover, "side" | "barrier_price">, price: number): boolean =>
  cover.side === "short" ? price >= cover.barrier_price : price <= cover.barrier_price;

export const openCover = (i: OpenCoverInput): ProtectionCover => {
  const side: TradeSide = i.side === "short" ? "short" : "long";
  if (!(i.spot > 0)) throw new Error("openCover: spot must be > 0");
  if (!(i.triggerPct > 0 && i.triggerPct < 1)) throw new Error("openCover: triggerPct in (0,1)");
  if (!(i.tenorMs > 0)) throw new Error("openCover: tenorMs > 0");
  if (!(i.payoutUsdc > 0)) throw new Error("openCover: payoutUsdc > 0");
  return {
    id: i.id,
    foxify_ref: i.foxifyRef ?? null,
    created_at_ms: i.nowMs,
    side,
    spot_at_entry: round2(i.spot),
    trigger_pct: round4(i.triggerPct),
    barrier_price: round2(barrierOf(side, i.spot, i.triggerPct)),
    tenor_ms: i.tenorMs,
    expires_at_ms: i.nowMs + i.tenorMs,
    payout_usdc: round2(i.payoutUsdc),
    premium_usdc: round2(i.premiumUsdc),
    hedge_cost_usdc: round2(i.hedgeCostUsdc),
    ops_fee_usdc: round2(i.opsFeeUsdc),
    implied_touch: round4(i.impliedTouch),
    signal: i.signal ?? "NA",
    mode: i.mode ?? "shadow",
    status: "active",
    ...(i.hedge ? { hedge: i.hedge } : {})
  };
};

/**
 * Evaluate an active cover against an observed price at a point in time. Returns a settled copy if
 * it touched (any time) or expired; otherwise returns the cover unchanged. `observedExtreme` should
 * be the most adverse price seen since the last evaluation (low for long, high for short) so
 * intra-tick wicks aren't missed; pass the spot if you only have point samples.
 */
export const evaluateCover = (
  cover: ProtectionCover,
  observedExtreme: number,
  nowMs: number
): ProtectionCover => {
  if (cover.status !== "active") return cover;
  if (isTouched(cover, observedExtreme)) {
    return settleCover(cover, { touched: true, settlePrice: cover.barrier_price, nowMs });
  }
  if (nowMs >= cover.expires_at_ms) {
    return settleCover(cover, { touched: false, settlePrice: observedExtreme, nowMs });
  }
  return cover;
};

export const settleCover = (
  cover: ProtectionCover,
  opts: { touched: boolean; settlePrice: number; nowMs: number }
): ProtectionCover => {
  const foxifyPnl = (opts.touched ? cover.payout_usdc : 0) - cover.premium_usdc;
  // Pass-through: the hedge funds the payout on a touch → Atticus nets premium − hedge_cost either way.
  const atticusPnl = cover.premium_usdc - cover.hedge_cost_usdc;
  return {
    ...cover,
    status: opts.touched ? "settled_touch" : "expired_no_touch",
    settled_at_ms: opts.nowMs,
    touched: opts.touched,
    settle_price: round2(opts.settlePrice),
    foxify_pnl_usdc: round2(foxifyPnl),
    atticus_pnl_usdc: round2(atticusPnl)
  };
};

/** Attach the real hedge-unwind result to a settled LIVE cover (realized = proceeds − debit paid). */
export const attachHedgeClose = (cover: ProtectionCover, close: { proceeds_usdc: number; legs: HedgeFill[] }): ProtectionCover => {
  const debit = cover.hedge?.debit_usdc ?? 0;
  return {
    ...cover,
    hedge_close: { proceeds_usdc: round2(close.proceeds_usdc), realized_hedge_pnl_usdc: round2(close.proceeds_usdc - debit), legs: close.legs }
  };
};

export type ProtectionScorecard = {
  total: number;
  active: number;
  settled: number;
  touches: number;
  realized_touch_rate: number | null;     // touches / settled
  implied_touch_rate_avg: number | null;  // avg priced-in stop prob over settled
  edge_pts: number | null;                // realized − implied (the validation number)
  foxify_net_usdc: number;                // sum settled foxify P&L
  foxify_net_per_settled_usdc: number | null;
  atticus_net_usdc: number;               // sum settled atticus P&L (the ops margin)
  premium_collected_usdc: number;
  payouts_paid_usdc: number;
  by_signal: Record<SignalState, { settled: number; touches: number; foxify_net_usdc: number }>;
};

export const scorecard = (covers: ProtectionCover[]): ProtectionScorecard => {
  const settled = covers.filter((c) => c.status === "settled_touch" || c.status === "expired_no_touch");
  const touches = settled.filter((c) => c.touched).length;
  const impliedAvg = settled.length ? settled.reduce((s, c) => s + c.implied_touch, 0) / settled.length : null;
  const realized = settled.length ? touches / settled.length : null;
  const foxifyNet = settled.reduce((s, c) => s + (c.foxify_pnl_usdc ?? 0), 0);
  const atticusNet = settled.reduce((s, c) => s + (c.atticus_pnl_usdc ?? 0), 0);
  const premium = settled.reduce((s, c) => s + c.premium_usdc, 0);
  const payouts = settled.reduce((s, c) => s + (c.touched ? c.payout_usdc : 0), 0);

  const bySignal = { GO: z(), WAIT: z(), NA: z() } as Record<SignalState, { settled: number; touches: number; foxify_net_usdc: number }>;
  for (const c of settled) {
    const b = bySignal[c.signal];
    b.settled += 1; b.touches += c.touched ? 1 : 0; b.foxify_net_usdc = round2(b.foxify_net_usdc + (c.foxify_pnl_usdc ?? 0));
  }

  return {
    total: covers.length,
    active: covers.filter((c) => c.status === "active").length,
    settled: settled.length,
    touches,
    realized_touch_rate: realized != null ? round4(realized) : null,
    implied_touch_rate_avg: impliedAvg != null ? round4(impliedAvg) : null,
    edge_pts: realized != null && impliedAvg != null ? round4(realized - impliedAvg) : null,
    foxify_net_usdc: round2(foxifyNet),
    foxify_net_per_settled_usdc: settled.length ? round2(foxifyNet / settled.length) : null,
    atticus_net_usdc: round2(atticusNet),
    premium_collected_usdc: round2(premium),
    payouts_paid_usdc: round2(payouts),
    by_signal: bySignal
  };
};

function z() { return { settled: 0, touches: 0, foxify_net_usdc: 0 }; }
