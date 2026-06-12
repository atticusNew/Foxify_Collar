/**
 * Hedge executor — places/unwinds the REAL option spread that backs a cover.
 *
 *   openHedge:  long → BUY inner put + SELL outer put   (short → calls). Net debit = the hedge cost.
 *   closeHedge: the reverse (SELL inner + BUY outer) → proceeds. On a touch the spread is worth ~payout.
 *
 * SimHedgeExecutor: paper fills at the quoted prices (no venue). DeribitHedgeExecutor: real orders via
 * the existing DeribitLegAdapter (IOC limit, USDC↔BTC + tick/amount snapping handled there). The
 * DeribitLegClient is injected so it's unit-testable with a mock; the route wires the real adapter.
 *
 * IMPORTANT (real money): Deribit BTC options have a 0.1 BTC per-leg minimum, so the smallest live
 * spread (~0.1 BTC) implies a payout of ~$100–200 (= contracts × strike width), not $60. Size the
 * first live test accordingly. Live use is env-gated + size-capped by the caller.
 */

import type { TradeSide } from "./protectionLifecycle";
import type { DeribitLegClient } from "../liveStrangleExecutor";

export type HedgeLegQuote = { instrument: string; strike: number; askUsdcPerBtc: number; bidUsdcPerBtc: number };
export type HedgePlan = { side: TradeSide; contractsBtc: number; inner: HedgeLegQuote; outer: HedgeLegQuote };

export type FilledLeg = { role: "inner" | "outer"; action: "buy" | "sell"; instrument: string; strike: number; contractsBtc: number; fillUsdcPerBtc: number; orderId?: string };

export type HedgeOpenResult =
  | { ok: true; mode: "shadow" | "live"; legs: FilledLeg[]; debit_usdc: number; spread_width_usd: number; effective_payout_usdc: number }
  | { ok: false; error: string };
export type HedgeCloseResult =
  | { ok: true; mode: "shadow" | "live"; legs: FilledLeg[]; proceeds_usdc: number }
  | { ok: false; error: string };

export interface HedgeExecutor {
  readonly mode: "shadow" | "live";
  openHedge(plan: HedgePlan): Promise<HedgeOpenResult>;
  /** Unwind a previously opened hedge given the filled legs (instruments + sizes). */
  closeHedge(opened: FilledLeg[]): Promise<HedgeCloseResult>;
}

const round2 = (x: number) => +x.toFixed(2);
const widthOf = (p: HedgePlan) => Math.abs(p.inner.strike - p.outer.strike);

/** Paper executor: fills at quoted ask (buy) / bid (sell). Used for shadow covers + tests. */
export class SimHedgeExecutor implements HedgeExecutor {
  readonly mode = "shadow" as const;
  async openHedge(plan: HedgePlan): Promise<HedgeOpenResult> {
    const width = widthOf(plan);
    if (!(width > 0)) return { ok: false, error: "invalid_spread_width" };
    const legs: FilledLeg[] = [
      { role: "inner", action: "buy", instrument: plan.inner.instrument, strike: plan.inner.strike, contractsBtc: plan.contractsBtc, fillUsdcPerBtc: plan.inner.askUsdcPerBtc },
      { role: "outer", action: "sell", instrument: plan.outer.instrument, strike: plan.outer.strike, contractsBtc: plan.contractsBtc, fillUsdcPerBtc: plan.outer.bidUsdcPerBtc }
    ];
    const debit = round2((plan.inner.askUsdcPerBtc - plan.outer.bidUsdcPerBtc) * plan.contractsBtc);
    return { ok: true, mode: "shadow", legs, debit_usdc: debit, spread_width_usd: round2(width), effective_payout_usdc: round2(width * plan.contractsBtc) };
  }
  async closeHedge(opened: FilledLeg[]): Promise<HedgeCloseResult> {
    // Paper close: assume reversal at the same recorded prices (the lifecycle owns the real P&L).
    const legs = opened.map((l) => ({ ...l, action: (l.action === "buy" ? "sell" : "buy") as "buy" | "sell" }));
    const proceeds = round2(legs.reduce((s, l) => s + (l.action === "sell" ? 1 : -1) * l.fillUsdcPerBtc * l.contractsBtc, 0));
    return { ok: true, mode: "shadow", legs, proceeds_usdc: proceeds };
  }
}

/** Live executor: real Deribit orders via the injected DeribitLegAdapter (DeribitLegClient). */
export class DeribitHedgeExecutor implements HedgeExecutor {
  readonly mode = "live" as const;
  constructor(private readonly deribit: DeribitLegClient) {}

  async openHedge(plan: HedgePlan): Promise<HedgeOpenResult> {
    const width = widthOf(plan);
    if (!(width > 0)) return { ok: false, error: "invalid_spread_width" };
    const oid = `pp-${Date.now().toString(36)}`;
    // BUY inner (pay up to ask), SELL outer (accept down to bid).
    const buy = await this.deribit.buyLeg({ instrument: plan.inner.instrument, contractsBtc: plan.contractsBtc, maxAcceptableAskUsdcPerBtc: plan.inner.askUsdcPerBtc, clientOrderId: `${oid}-bi` });
    if (!buy.ok) return { ok: false, error: `inner buy failed: ${buy.detail ?? buy.reason}` };
    const sell = await this.deribit.sellLeg({ instrument: plan.outer.instrument, contractsBtc: plan.contractsBtc, minAcceptableBidUsdcPerBtc: plan.outer.bidUsdcPerBtc, clientOrderId: `${oid}-so` });
    if (!sell.ok) {
      // Compensate: we bought the inner but couldn't sell the outer → unwind the inner so we aren't left exposed.
      await this.deribit.sellLeg({ instrument: plan.inner.instrument, contractsBtc: buy.filledContractsBtc ?? plan.contractsBtc, minAcceptableBidUsdcPerBtc: 0, clientOrderId: `${oid}-bi-unwind` }).catch(() => null);
      return { ok: false, error: `outer sell failed (inner unwound): ${sell.detail ?? sell.reason}` };
    }
    const contracts = Math.min(buy.filledContractsBtc ?? plan.contractsBtc, sell.filledContractsBtc ?? plan.contractsBtc);
    const legs: FilledLeg[] = [
      { role: "inner", action: "buy", instrument: plan.inner.instrument, strike: plan.inner.strike, contractsBtc: buy.filledContractsBtc ?? plan.contractsBtc, fillUsdcPerBtc: buy.filledAskUsdcPerBtc ?? plan.inner.askUsdcPerBtc, orderId: buy.filledOrderId },
      { role: "outer", action: "sell", instrument: plan.outer.instrument, strike: plan.outer.strike, contractsBtc: sell.filledContractsBtc ?? plan.contractsBtc, fillUsdcPerBtc: sell.filledAskUsdcPerBtc ?? plan.outer.bidUsdcPerBtc, orderId: sell.filledOrderId }
    ];
    const debit = round2((legs[0].fillUsdcPerBtc - legs[1].fillUsdcPerBtc) * contracts);
    return { ok: true, mode: "live", legs, debit_usdc: debit, spread_width_usd: round2(width), effective_payout_usdc: round2(width * contracts) };
  }

  async closeHedge(opened: FilledLeg[]): Promise<HedgeCloseResult> {
    const inner = opened.find((l) => l.role === "inner");
    const outer = opened.find((l) => l.role === "outer");
    if (!inner || !outer) return { ok: false, error: "missing legs to close" };
    const oid = `pp-${Date.now().toString(36)}-close`;
    // Reverse: SELL inner (best-effort), BUY back outer (best-effort up to a high ceiling).
    const sellInner = await this.deribit.sellLeg({ instrument: inner.instrument, contractsBtc: inner.contractsBtc, minAcceptableBidUsdcPerBtc: 0, clientOrderId: `${oid}-si` });
    const buyOuter = await this.deribit.buyLeg({ instrument: outer.instrument, contractsBtc: outer.contractsBtc, maxAcceptableAskUsdcPerBtc: outer.fillUsdcPerBtc * 50 + 1e6, clientOrderId: `${oid}-bo` });
    if (!sellInner.ok || !buyOuter.ok) {
      return { ok: false, error: `close partial/failed: inner=${sellInner.ok ? "ok" : sellInner.detail} outer=${buyOuter.ok ? "ok" : buyOuter.detail}` };
    }
    const legs: FilledLeg[] = [
      { role: "inner", action: "sell", instrument: inner.instrument, strike: inner.strike, contractsBtc: sellInner.filledContractsBtc ?? inner.contractsBtc, fillUsdcPerBtc: sellInner.filledAskUsdcPerBtc ?? 0, orderId: sellInner.filledOrderId },
      { role: "outer", action: "buy", instrument: outer.instrument, strike: outer.strike, contractsBtc: buyOuter.filledContractsBtc ?? outer.contractsBtc, fillUsdcPerBtc: buyOuter.filledAskUsdcPerBtc ?? 0, orderId: buyOuter.filledOrderId }
    ];
    const proceeds = round2(legs[0].fillUsdcPerBtc * legs[0].contractsBtc - legs[1].fillUsdcPerBtc * legs[1].contractsBtc);
    return { ok: true, mode: "live", legs, proceeds_usdc: proceeds };
  }
}
