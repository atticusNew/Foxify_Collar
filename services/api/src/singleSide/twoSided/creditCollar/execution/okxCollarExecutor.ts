/**
 * OKX collar-hedge executor — Phase B (DEMO-FIRST, default-off). Places the two HEDGE legs of a
 * credit collar on OKX (buy the put, sell the call), confirms fills, measures actual slippage vs the
 * modeled prices and the real short-leg margin, and — critically — handles the ATOMICITY hazard: if
 * one leg fills and the other doesn't, it compensates (closes the orphan) so Atticus is never left
 * with a naked leg. Pure helpers (order build, fill reconciliation, outcome classification) are
 * unit-tested; the orchestration is deps-injected so it's testable without a live venue.
 */

import type { OkxLegOrder } from "./okxExecutionClient";

export type CollarHedgeSpec = {
  putInstId: string;       // the put leg Atticus BUYS (covers its short-put exposure)
  callInstId: string;      // the call leg Atticus SELLS (the funding/short leg)
  sizeContracts: string;
  putLimitPx: string;      // marketable limit (USDC or BTC per OKX option convention)
  callLimitPx: string;
  modeledPutAskUsd: number;  // what the harness modeled, for slippage measurement
  modeledCallBidUsd: number;
  tdMode?: "cross" | "isolated" | "cash";
  clOrdPrefix?: string;
};

/** Build the two leg orders. Pure. */
export const buildCollarLegOrders = (spec: CollarHedgeSpec): { putOrder: OkxLegOrder; callOrder: OkxLegOrder } => ({
  putOrder: { instId: spec.putInstId, side: "buy", ordType: "limit", sz: spec.sizeContracts, px: spec.putLimitPx, tdMode: spec.tdMode ?? "cross", clOrdId: spec.clOrdPrefix ? `${spec.clOrdPrefix}P` : undefined },
  callOrder: { instId: spec.callInstId, side: "sell", ordType: "limit", sz: spec.sizeContracts, px: spec.callLimitPx, tdMode: spec.tdMode ?? "cross", clOrdId: spec.clOrdPrefix ? `${spec.clOrdPrefix}C` : undefined }
});

export type LegFill = { filled: boolean; avgPxUsd: number | null; filledContracts: number; ordId: string | null; state: string | null };

/** Slippage of an actual fill vs the modeled price (USD per contract). Pure. Buy: pay more = +slippage. */
export const legSlippageUsd = (side: "buy" | "sell", modeledUsd: number, fill: LegFill): number | null => {
  if (!fill.filled || fill.avgPxUsd == null) return null;
  return side === "buy" ? +(fill.avgPxUsd - modeledUsd).toFixed(4) : +(modeledUsd - fill.avgPxUsd).toFixed(4);
};

export type HedgeOutcome = "both_filled" | "put_orphan" | "call_orphan" | "neither_filled";

/** Classify the two-leg result → drives compensation. Pure. */
export const classifyOutcome = (putFilled: boolean, callFilled: boolean): HedgeOutcome =>
  putFilled && callFilled ? "both_filled" : putFilled && !callFilled ? "put_orphan" : !putFilled && callFilled ? "call_orphan" : "neither_filled";

// ── Deps-injected orchestration ───────────────────────────────────────────────

export type ExecClient = {
  mode: "demo" | "live";
  placeOrder: (o: OkxLegOrder) => Promise<{ ok: boolean; code: string; msg: string; data: Array<{ ordId?: string; sCode?: string; sMsg?: string }> }>;
  getOrder: (instId: string, ordId: string) => Promise<{ ok: boolean; data: Array<{ state?: string; avgPx?: string; accFillSz?: string }> }>;
  cancelOrder: (instId: string, ordId: string) => Promise<{ ok: boolean; data: unknown[] }>;
  getPositions: (instType?: string) => Promise<{ ok: boolean; data: Array<{ instId?: string; pos?: string; mmr?: string; imr?: string }> }>;
};

export type ExecutorOpts = {
  pollTries?: number;
  pollDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type HedgeExecutionReport = {
  mode: "demo" | "live";
  outcome: HedgeOutcome;
  putFill: LegFill;
  callFill: LegFill;
  putSlippageUsd: number | null;
  callSlippageUsd: number | null;
  totalSlippageUsd: number | null;
  shortLegMarginUsd: number | null;   // measured IMR on the short call position (the real capital)
  compensated: boolean;
  compensationNote: string | null;
  safe: boolean;                       // true ⟹ no naked leg left (both filled, or orphan compensated, or none)
  errors: string[];
};

const placeAndConfirm = async (client: ExecClient, order: OkxLegOrder, opts: Required<ExecutorOpts>): Promise<LegFill> => {
  const res = await client.placeOrder(order);
  const ordId = res.data?.[0]?.ordId ?? null;
  if (!res.ok || !ordId) return { filled: false, avgPxUsd: null, filledContracts: 0, ordId, state: res.data?.[0]?.sMsg ?? res.msg ?? "place_failed" };
  for (let i = 0; i < opts.pollTries; i++) {
    const q = await client.getOrder(order.instId, ordId);
    const st = q.data?.[0];
    if (st?.state === "filled") {
      return { filled: true, avgPxUsd: st.avgPx != null ? Number(st.avgPx) : null, filledContracts: st.accFillSz != null ? Number(st.accFillSz) : 0, ordId, state: "filled" };
    }
    if (st?.state === "canceled") return { filled: false, avgPxUsd: null, filledContracts: 0, ordId, state: "canceled" };
    await opts.sleep(opts.pollDelayMs);
  }
  return { filled: false, avgPxUsd: null, filledContracts: 0, ordId, state: "unfilled_timeout" };
};

/**
 * Execute the collar hedge atomically: buy put, sell call, confirm fills, measure slippage + margin,
 * and compensate any orphan leg so no naked exposure remains. Deps-injected; works against demo or
 * (gated elsewhere) live. Returns a full report.
 */
export const executeCollarHedge = async (client: ExecClient, spec: CollarHedgeSpec, opts: ExecutorOpts = {}): Promise<HedgeExecutionReport> => {
  const o: Required<ExecutorOpts> = { pollTries: opts.pollTries ?? 5, pollDelayMs: opts.pollDelayMs ?? 500, sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))) };
  const { putOrder, callOrder } = buildCollarLegOrders(spec);
  const errors: string[] = [];

  const putFill = await placeAndConfirm(client, putOrder, o);
  const callFill = await placeAndConfirm(client, callOrder, o);
  const outcome = classifyOutcome(putFill.filled, callFill.filled);

  // Compensation: close the orphan leg so Atticus is never left naked.
  // NOTE (legacy Phase-B demo executor, NOT on the live path): OKX options reject market orders —
  // these compensations will be rejected live. The live path (okxLiveCollarExecutor/okxLiveUnwind)
  // uses book-priced reduceOnly IOC limits; migrate this the same way if this executor is revived.
  let compensated = false;
  let compensationNote: string | null = null;
  if (outcome === "put_orphan") {
    // Long put filled, short call didn't → sell the put back (reduceOnly) to flatten.
    const comp = await client.placeOrder({ instId: spec.putInstId, side: "sell", ordType: "market", sz: String(putFill.filledContracts || spec.sizeContracts), tdMode: spec.tdMode ?? "cross", reduceOnly: true });
    compensated = comp.ok;
    compensationNote = comp.ok ? "closed orphan long put" : `FAILED to close orphan put: ${comp.msg}`;
    if (!comp.ok) errors.push(compensationNote);
  } else if (outcome === "call_orphan") {
    // Short call filled, long put didn't → buy the call back (reduceOnly) to flatten.
    const comp = await client.placeOrder({ instId: spec.callInstId, side: "buy", ordType: "market", sz: String(callFill.filledContracts || spec.sizeContracts), tdMode: spec.tdMode ?? "cross", reduceOnly: true });
    compensated = comp.ok;
    compensationNote = comp.ok ? "closed orphan short call" : `FAILED to buy back orphan call: ${comp.msg}`;
    if (!comp.ok) errors.push(compensationNote);
  }

  // Measure the real short-leg margin (IMR on the short call position).
  let shortLegMarginUsd: number | null = null;
  try {
    const pos = await client.getPositions("OPTION");
    const callPos = pos.data?.find((p) => p.instId === spec.callInstId);
    if (callPos?.imr != null) shortLegMarginUsd = Number(callPos.imr);
  } catch (e) {
    errors.push(`margin read failed: ${(e as Error).message}`);
  }

  const putSlip = legSlippageUsd("buy", spec.modeledPutAskUsd, putFill);
  const callSlip = legSlippageUsd("sell", spec.modeledCallBidUsd, callFill);
  const totalSlip = putSlip != null && callSlip != null ? +(putSlip + callSlip).toFixed(4) : null;
  const safe = outcome === "both_filled" || outcome === "neither_filled" || compensated;

  return {
    mode: client.mode,
    outcome,
    putFill,
    callFill,
    putSlippageUsd: putSlip,
    callSlippageUsd: callSlip,
    totalSlippageUsd: totalSlip,
    shortLegMarginUsd,
    compensated,
    compensationNote,
    safe,
    errors
  };
};
