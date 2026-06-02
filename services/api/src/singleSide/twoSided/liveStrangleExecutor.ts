/**
 * LiveStrangleExecutor — real Bullish + Deribit execution for the activate path (PR A4).
 *
 * Implements the StrangleExecutor interface for production traffic. Phase 0
 * shipped MockStrangleExecutor for tests; this is the live counterpart.
 *
 * Architecture:
 *   - Per-leg venue routing: read order.putLeg.venue + order.callLeg.venue,
 *     dispatch each to the corresponding adapter (Bullish or Deribit).
 *   - Both legs execute in Promise.all-style for ~halved wall latency.
 *   - On partial fill (one ok, one fail), the filled leg is immediately
 *     reverse-sold (per OD-2 operator decision: cancel and return Foxify to
 *     a clean state rather than holding a directionally-exposed half-hedge).
 *   - 8s poll ceiling per leg (matches existing VC pattern); 3 attempt retries
 *     handled inside the leg adapters.
 *
 * Dependency injection:
 *   constructor takes BullishLegClient + DeribitLegClient interfaces.
 *   Tests inject mocks. Server.ts wires real Bullish (via bullishIocLimit)
 *   + Deribit (via @services/connectors::DeribitConnector) at boot.
 */

import type { LegExecutionResult, StrangleExecutionResult, StrangleExecutor, StrangleOrder } from "./executor";

export type BullishLegBuyRequest = {
  symbol: string;
  contractsBtc: number;
  maxAcceptableAskUsdcPerBtc: number;
  clientOrderId: string;
};

export type BullishLegSellRequest = {
  symbol: string;
  contractsBtc: number;
  minAcceptableBidUsdcPerBtc: number;
  clientOrderId: string;
};

export type BullishLegClient = {
  /** Returns either {ok:true, fillPrice, fillQty} on success or {ok:false, reason} on fail.
   * Implementation handles all the IOC-limit + poll + retry mechanics internally. */
  buyLeg(req: BullishLegBuyRequest): Promise<LegExecutionResult>;
  /** Reverse a previously filled leg (sell back what was bought) — used in
   * partial-fill recovery. Should pick a price aggressive enough to clear
   * quickly (e.g., crossed limit-IOC at best bid). */
  sellLeg(req: BullishLegSellRequest): Promise<LegExecutionResult>;
};

export type DeribitLegBuyRequest = {
  instrument: string;
  contractsBtc: number;
  maxAcceptableAskUsdcPerBtc: number;
  clientOrderId: string;
};

export type DeribitLegSellRequest = {
  instrument: string;
  contractsBtc: number;
  minAcceptableBidUsdcPerBtc: number;
  clientOrderId: string;
};

export type DeribitLegClient = {
  buyLeg(req: DeribitLegBuyRequest): Promise<LegExecutionResult>;
  sellLeg(req: DeribitLegSellRequest): Promise<LegExecutionResult>;
};

export type LiveStrangleExecutorOpts = {
  log?: (msg: string, meta?: Record<string, unknown>) => void;
};

const safeLog = (opts: LiveStrangleExecutorOpts, msg: string, meta?: Record<string, unknown>) => {
  const fn = opts.log ?? ((m, _meta) => console.log(`[liveStrangleExecutor] ${m}`, _meta ?? ""));
  fn(msg, meta);
};

export class LiveStrangleExecutor implements StrangleExecutor {
  constructor(
    private readonly bullish: BullishLegClient,
    private readonly deribit: DeribitLegClient,
    private readonly opts: LiveStrangleExecutorOpts = {}
  ) {}

  async executeStrangle(order: StrangleOrder): Promise<StrangleExecutionResult> {
    const putClientId = `${order.pairId}-put-${Date.now()}`;
    const callClientId = `${order.pairId}-call-${Date.now()}`;

    const putReq = {
      symbol: order.putLeg.symbol,
      contractsBtc: order.putLeg.contractsBtc,
      maxAcceptableAskUsdcPerBtc: order.putLeg.maxAcceptableAskUsdcPerBtc,
      clientOrderId: putClientId
    };
    const callReq = {
      symbol: order.callLeg.symbol,
      contractsBtc: order.callLeg.contractsBtc,
      maxAcceptableAskUsdcPerBtc: order.callLeg.maxAcceptableAskUsdcPerBtc,
      clientOrderId: callClientId
    };

    // Execute both legs. Concurrent for cross-venue (halved latency), but SEQUENTIAL
    // when BOTH legs are Bullish: Bullish requires strictly-increasing nonces per
    // request, and concurrent submission races the nonce → one leg rejected with
    // "invalid nonce" (observed live). Serializing the two Bullish orders keeps the
    // nonces ordered.
    const bothBullish = order.putLeg.venue === "bullish" && order.callLeg.venue === "bullish";
    let putR: LegExecutionResult;
    let callR: LegExecutionResult;
    if (bothBullish) {
      putR = await this.buyLeg(order.putLeg.venue, "put", putReq);
      callR = await this.buyLeg(order.callLeg.venue, "call", { ...callReq, instrument: callReq.symbol });
    } else {
      [putR, callR] = await Promise.all([
        this.buyLeg(order.putLeg.venue, "put", putReq),
        this.buyLeg(order.callLeg.venue, "call", { ...callReq, instrument: callReq.symbol })
      ]);
    }

    // Happy path: both succeeded
    if (putR.ok && callR.ok) {
      return {
        ok: true,
        putLeg: { filledAskUsdcPerBtc: putR.filledAskUsdcPerBtc, filledAtIso: putR.filledAtIso, filledContractsBtc: putR.filledContractsBtc },
        callLeg: { filledAskUsdcPerBtc: callR.filledAskUsdcPerBtc, filledAtIso: callR.filledAtIso, filledContractsBtc: callR.filledContractsBtc }
      };
    }

    // Both failed
    if (!putR.ok && !callR.ok) {
      safeLog(this.opts, `both legs failed for pair=${order.pairId}: put=${putR.reason} call=${callR.reason}`);
      return { ok: false, reason: "both_failed", putLegResult: putR, callLegResult: callR };
    }

    // Partial fill — reverse the filled leg (OD-2)
    if (putR.ok && !callR.ok) {
      safeLog(this.opts, `partial fill recovery: call failed (${callR.reason}); reversing put leg for pair=${order.pairId}`);
      const reverse = await this.sellLeg(order.putLeg.venue, "put", {
        symbol: order.putLeg.symbol,
        contractsBtc: order.putLeg.contractsBtc,
        minAcceptableBidUsdcPerBtc: 0, // best-effort reverse; we accept any clearing price
        clientOrderId: `${order.pairId}-put-reverse-${Date.now()}`
      });
      const reversedDetail = reverse.ok
        ? `reversed at \$${reverse.filledAskUsdcPerBtc.toFixed(2)}/BTC`
        : `REVERSE_FAILED: ${(reverse as { reason: string }).reason}`;
      return {
        ok: false,
        reason: "call_failed",
        putLegResult: { ok: false, reason: "venue_error", detail: `put filled then reversed: ${reversedDetail}` },
        callLegResult: callR
      };
    }
    // !putR.ok && callR.ok
    safeLog(this.opts, `partial fill recovery: put failed (${(putR as { reason: string }).reason}); reversing call leg for pair=${order.pairId}`);
    const reverse = await this.sellLeg(order.callLeg.venue, "call", {
      symbol: order.callLeg.symbol,
      contractsBtc: order.callLeg.contractsBtc,
      minAcceptableBidUsdcPerBtc: 0,
      clientOrderId: `${order.pairId}-call-reverse-${Date.now()}`
    });
    const reversedDetail = reverse.ok
      ? `reversed at \$${reverse.filledAskUsdcPerBtc.toFixed(2)}/BTC`
      : `REVERSE_FAILED: ${(reverse as { reason: string }).reason}`;
    return {
      ok: false,
      reason: "put_failed",
      putLegResult: putR,
      callLegResult: { ok: false, reason: "venue_error", detail: `call filled then reversed: ${reversedDetail}` }
    };
  }

  private async buyLeg(
    venue: "bullish" | "deribit",
    role: "put" | "call",
    req: BullishLegBuyRequest & Partial<DeribitLegBuyRequest>
  ): Promise<LegExecutionResult> {
    try {
      if (venue === "bullish") return await this.bullish.buyLeg(req);
      return await this.deribit.buyLeg({
        instrument: req.instrument ?? req.symbol,
        contractsBtc: req.contractsBtc,
        maxAcceptableAskUsdcPerBtc: req.maxAcceptableAskUsdcPerBtc,
        clientOrderId: req.clientOrderId
      });
    } catch (e) {
      return { ok: false, reason: "venue_error", detail: `${venue} ${role} threw: ${(e as Error).message}` };
    }
  }

  private async sellLeg(
    venue: "bullish" | "deribit",
    role: "put" | "call",
    req: BullishLegSellRequest & Partial<DeribitLegSellRequest>
  ): Promise<LegExecutionResult> {
    try {
      if (venue === "bullish") return await this.bullish.sellLeg(req);
      return await this.deribit.sellLeg({
        instrument: req.instrument ?? req.symbol,
        contractsBtc: req.contractsBtc,
        minAcceptableBidUsdcPerBtc: req.minAcceptableBidUsdcPerBtc,
        clientOrderId: req.clientOrderId
      });
    } catch (e) {
      return { ok: false, reason: "venue_error", detail: `${venue} ${role} reverse threw: ${(e as Error).message}` };
    }
  }
}
