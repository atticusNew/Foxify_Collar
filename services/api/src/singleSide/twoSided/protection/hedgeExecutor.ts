/**
 * Hedge executor — places/unwinds the REAL option spread that backs a cover, routing each leg to the
 * BEST executable venue (Deribit or Bullish; OKX is priced for comparison only — no executor).
 *
 *   openHedge:  long → BUY inner put + SELL outer put   (short → calls). Each leg on its chosen venue.
 *   closeHedge: the reverse (SELL inner + BUY outer), routed to each leg's original venue.
 *
 * SimHedgeExecutor: paper fills at quoted prices (tests / shadow). MultiVenueHedgeExecutor: real orders
 * via the existing DeribitLegAdapter / BullishLegAdapter (IOC limit, tick/amount + USDC↔BTC handled
 * there). Leg clients are injected so it's unit-testable with mocks; the route wires real adapters.
 *
 * Deribit BTC options have a 0.1 BTC per-leg minimum → smallest live spread implies a payout of
 * ~$100–200 (= contracts × strike width), not $60. Live use is env-gated + size-capped by the caller.
 */

import type { TradeSide, HedgeFill } from "./protectionLifecycle";
import type { DeribitLegClient } from "../liveStrangleExecutor";
import type { BullishLegClient } from "../liveStrangleExecutor";

export type Venue = "deribit" | "bullish";
export type HedgeLegQuote = { venue: Venue; instrument: string; strike: number; askUsdcPerBtc: number; bidUsdcPerBtc: number };
export type HedgePlan = { side: TradeSide; contractsBtc: number; inner: HedgeLegQuote; outer: HedgeLegQuote };

export type HedgeOpenResult =
  | { ok: true; mode: "shadow" | "live"; legs: HedgeFill[]; debit_usdc: number; spread_width_usd: number; effective_payout_usdc: number; venues: string[] }
  | { ok: false; error: string };

/** Per-leg unwind outcome — lets the caller persist which legs already closed (resumable retry). */
export type LegCloseResult = { role: "inner" | "outer"; ok: boolean; fill?: HedgeFill; error?: string };
/** `ok` = every requested (non-skipped) leg closed THIS call. proceeds/closed_legs cover only legs
 *  closed this call (callers accumulate across retries). */
export type HedgeCloseResult = {
  ok: boolean;
  mode: "shadow" | "live";
  proceeds_usdc: number;
  closed_legs: HedgeFill[];
  leg_results: LegCloseResult[];
  error?: string;
};

export interface HedgeExecutor {
  readonly mode: "shadow" | "live";
  openHedge(plan: HedgePlan): Promise<HedgeOpenResult>;
  /** Unwind the opened legs. `skipRoles` = legs already closed on a prior attempt (skipped → resumable). */
  closeHedge(opened: HedgeFill[], skipRoles?: string[]): Promise<HedgeCloseResult>;
}

const round2 = (x: number) => +x.toFixed(2);
const widthOf = (p: HedgePlan) => Math.abs(p.inner.strike - p.outer.strike);

/** Paper executor: fills at quoted ask (buy) / bid (sell). For shadow covers + tests. */
export class SimHedgeExecutor implements HedgeExecutor {
  readonly mode = "shadow" as const;
  async openHedge(plan: HedgePlan): Promise<HedgeOpenResult> {
    const width = widthOf(plan);
    if (!(width > 0)) return { ok: false, error: "invalid_spread_width" };
    const legs: HedgeFill[] = [
      { role: "inner", action: "buy", venue: plan.inner.venue, instrument: plan.inner.instrument, strike: plan.inner.strike, contractsBtc: plan.contractsBtc, fillUsdcPerBtc: plan.inner.askUsdcPerBtc },
      { role: "outer", action: "sell", venue: plan.outer.venue, instrument: plan.outer.instrument, strike: plan.outer.strike, contractsBtc: plan.contractsBtc, fillUsdcPerBtc: plan.outer.bidUsdcPerBtc }
    ];
    const debit = round2((plan.inner.askUsdcPerBtc - plan.outer.bidUsdcPerBtc) * plan.contractsBtc);
    return { ok: true, mode: "shadow", legs, debit_usdc: debit, spread_width_usd: round2(width), effective_payout_usdc: round2(width * plan.contractsBtc), venues: [...new Set([plan.inner.venue, plan.outer.venue])] };
  }
  async closeHedge(opened: HedgeFill[], skipRoles: string[] = []): Promise<HedgeCloseResult> {
    const legResults: LegCloseResult[] = [];
    const closed: HedgeFill[] = [];
    let proceeds = 0;
    for (const l of opened) {
      if (skipRoles.includes(l.role)) continue;
      const fill: HedgeFill = { ...l, action: (l.action === "buy" ? "sell" : "buy") as "buy" | "sell" };
      closed.push(fill);
      proceeds += (fill.action === "sell" ? 1 : -1) * fill.fillUsdcPerBtc * fill.contractsBtc;
      legResults.push({ role: l.role, ok: true, fill });
    }
    return { ok: true, mode: "shadow", proceeds_usdc: round2(proceeds), closed_legs: closed, leg_results: legResults };
  }
}

/** Live executor: routes each leg to its venue's real adapter (Deribit or Bullish). */
export class MultiVenueHedgeExecutor implements HedgeExecutor {
  readonly mode = "live" as const;
  private readonly slip: number;
  constructor(private readonly clients: { deribit?: DeribitLegClient; bullish?: BullishLegClient }, opts?: { slippagePct?: number }) {
    // Headroom so IOC limits are MARKETABLE: buy ceiling above the ask, sell floor below the bid,
    // so the order crosses the resting quote (it still fills at the real top-of-book price).
    this.slip = opts?.slippagePct != null && opts.slippagePct >= 0 ? opts.slippagePct : 0.1;
  }

  private async buy(venue: Venue, instrument: string, contractsBtc: number, maxAskUsdcPerBtc: number, oid: string) {
    if (venue === "deribit") {
      if (!this.clients.deribit) throw new Error("deribit client unavailable");
      return this.clients.deribit.buyLeg({ instrument, contractsBtc, maxAcceptableAskUsdcPerBtc: maxAskUsdcPerBtc, clientOrderId: oid });
    }
    if (!this.clients.bullish) throw new Error("bullish client unavailable");
    return this.clients.bullish.buyLeg({ symbol: instrument, contractsBtc, maxAcceptableAskUsdcPerBtc: maxAskUsdcPerBtc, clientOrderId: oid });
  }
  private async sell(venue: Venue, instrument: string, contractsBtc: number, minBidUsdcPerBtc: number, oid: string) {
    if (venue === "deribit") {
      if (!this.clients.deribit) throw new Error("deribit client unavailable");
      return this.clients.deribit.sellLeg({ instrument, contractsBtc, minAcceptableBidUsdcPerBtc: minBidUsdcPerBtc, clientOrderId: oid });
    }
    if (!this.clients.bullish) throw new Error("bullish client unavailable");
    return this.clients.bullish.sellLeg({ symbol: instrument, contractsBtc, minAcceptableBidUsdcPerBtc: minBidUsdcPerBtc, clientOrderId: oid });
  }

  async openHedge(plan: HedgePlan): Promise<HedgeOpenResult> {
    const width = widthOf(plan);
    if (!(width > 0)) return { ok: false, error: "invalid_spread_width" };
    const oid = `pp-${Date.now().toString(36)}`;
    const buy = await this.buy(plan.inner.venue, plan.inner.instrument, plan.contractsBtc, plan.inner.askUsdcPerBtc * (1 + this.slip), `${oid}-bi`);
    if (!buy.ok) return { ok: false, error: `inner buy (${plan.inner.venue}) failed: ${buy.detail ?? buy.reason}` };
    const sell = await this.sell(plan.outer.venue, plan.outer.instrument, plan.contractsBtc, plan.outer.bidUsdcPerBtc * (1 - this.slip), `${oid}-so`);
    if (!sell.ok) {
      // Compensate: unwind the inner so we aren't left exposed.
      await this.sell(plan.inner.venue, plan.inner.instrument, buy.filledContractsBtc ?? plan.contractsBtc, 0, `${oid}-bi-unwind`).catch(() => null);
      return { ok: false, error: `outer sell (${plan.outer.venue}) failed (inner unwound): ${sell.detail ?? sell.reason}` };
    }
    const contracts = Math.min(buy.filledContractsBtc ?? plan.contractsBtc, sell.filledContractsBtc ?? plan.contractsBtc);
    const legs: HedgeFill[] = [
      { role: "inner", action: "buy", venue: plan.inner.venue, instrument: plan.inner.instrument, strike: plan.inner.strike, contractsBtc: buy.filledContractsBtc ?? plan.contractsBtc, fillUsdcPerBtc: buy.filledAskUsdcPerBtc ?? plan.inner.askUsdcPerBtc, orderId: buy.filledOrderId },
      { role: "outer", action: "sell", venue: plan.outer.venue, instrument: plan.outer.instrument, strike: plan.outer.strike, contractsBtc: sell.filledContractsBtc ?? plan.contractsBtc, fillUsdcPerBtc: sell.filledAskUsdcPerBtc ?? plan.outer.bidUsdcPerBtc, orderId: sell.filledOrderId }
    ];
    const debit = round2((legs[0].fillUsdcPerBtc - legs[1].fillUsdcPerBtc) * contracts);
    return { ok: true, mode: "live", legs, debit_usdc: debit, spread_width_usd: round2(width), effective_payout_usdc: round2(width * contracts), venues: [...new Set([plan.inner.venue, plan.outer.venue])] };
  }

  async closeHedge(opened: HedgeFill[], skipRoles: string[] = []): Promise<HedgeCloseResult> {
    const inner = opened.find((l) => l.role === "inner");
    const outer = opened.find((l) => l.role === "outer");
    const oid = `pp-${Date.now().toString(36)}-close`;
    const legResults: LegCloseResult[] = [];
    const closed: HedgeFill[] = [];
    let proceeds = 0;

    // Inner leg → reverse is SELL (best-effort, crosses any bid).
    if (inner && !skipRoles.includes("inner")) {
      const r = await this.sell(inner.venue as Venue, inner.instrument, inner.contractsBtc, 0, `${oid}-si`);
      if (r.ok) {
        const fill: HedgeFill = { role: "inner", action: "sell", venue: inner.venue, instrument: inner.instrument, strike: inner.strike, contractsBtc: r.filledContractsBtc ?? inner.contractsBtc, fillUsdcPerBtc: r.filledAskUsdcPerBtc ?? 0, orderId: r.filledOrderId };
        closed.push(fill); proceeds += fill.fillUsdcPerBtc * fill.contractsBtc; legResults.push({ role: "inner", ok: true, fill });
      } else legResults.push({ role: "inner", ok: false, error: r.detail ?? r.reason });
    }
    // Outer leg → reverse is BUY, at a SANE crossable ceiling (NOT ~$1M, which venues reject as
    // out-of-range and previously left a stray short). 10× the sold premium (min $100/BTC) crosses.
    if (outer && !skipRoles.includes("outer")) {
      const buyBackCeil = Math.max(outer.fillUsdcPerBtc * 10, 100);
      const r = await this.buy(outer.venue as Venue, outer.instrument, outer.contractsBtc, buyBackCeil, `${oid}-bo`);
      if (r.ok) {
        const fill: HedgeFill = { role: "outer", action: "buy", venue: outer.venue, instrument: outer.instrument, strike: outer.strike, contractsBtc: r.filledContractsBtc ?? outer.contractsBtc, fillUsdcPerBtc: r.filledAskUsdcPerBtc ?? 0, orderId: r.filledOrderId };
        closed.push(fill); proceeds -= fill.fillUsdcPerBtc * fill.contractsBtc; legResults.push({ role: "outer", ok: true, fill });
      } else legResults.push({ role: "outer", ok: false, error: r.detail ?? r.reason });
    }

    const requested = [inner && !skipRoles.includes("inner") ? "inner" : null, outer && !skipRoles.includes("outer") ? "outer" : null].filter(Boolean) as string[];
    const ok = requested.length > 0 && requested.every((role) => legResults.find((lr) => lr.role === role)?.ok);
    return {
      ok, mode: "live", proceeds_usdc: round2(proceeds), closed_legs: closed, leg_results: legResults,
      error: ok ? undefined : legResults.filter((lr) => !lr.ok).map((lr) => `${lr.role}:${lr.error}`).join("; ") || "no legs to close"
    };
  }
}
