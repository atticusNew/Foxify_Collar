/**
 * FalconX venue adapter for the LIVE window runner — the PRIMARY execution venue. All the rails
 * (kill-switch, window, caps, pair atomicity, recon halt) live in the shared liveWindowRunner; this
 * file only knows how to trade at FalconX's OTC desk:
 *
 *   plan    → live instrument grid at the standard 08:00 UTC daily, qty in plain BTC (no lots)
 *   execute → the collar as ONE RFQ structure (atomic at the venue: both legs or neither, always) —
 *             quote → structure-level band check vs model mid → execute within the ~5s validity →
 *             one re-quote on expiry/band-miss, then the day is skipped. NO naked-leg states exist.
 *   unwind  → the REVERSE structure quoted + executed as one trade; if it can't fill, the position
 *             rides to expiry fully hedged (the documented fail-safe)
 *   recon   → trade transactions (expired/exercised carry FalconX's settlement_price at the 08:00
 *             Deribit fixing) + derivative cash flows, per trade_id
 *
 * FalconX has NO demo environment: every execute is real money, gated by LIVE_ENABLED +
 * FALCONX_LIVE_CONFIRM. Quotes are all-in (their spread IS the fee ⟹ venueFee booked as 0; the
 * spread shows up honestly in quoted-vs-model on /positions).
 */

import type { OpenPosition, SettlementOutcome } from "../forwardSettlement";
import type { FalconxClient, FxQuoteResponse } from "./falconxClient";
import { fxPriceValue } from "./falconxClient";
import type { LiveReconRecord } from "./liveExecutionStore";
import { parseLiveGuardsFromEnv, type LiveGuardsConfig } from "./liveGuards";
import {
  buildLiveExecutionHook,
  type LiveExecutionHook,
  type LiveVenueAdapter,
  type LiveWindowContext,
  type SolvedCollar,
  type VenueExecutionResult,
  type VenuePlanResult
} from "./liveWindowRunner";
import { parseFalconxSymbol, planFalconxCollar, quotedNetCreditUsdc, quoteWithinBand, type FalconxCollarPlan } from "./falconxLivePlanner";
import { hedgePayoffUsd } from "./okxSettlementRecon";

const round2 = (x: number) => +x.toFixed(2);

export type FalconxRunnerDeps = {
  client: FalconxClient;
  guards?: LiveGuardsConfig;
  paths?: { executions?: string; windowState?: string; alerts?: string; recon?: string; settlements?: string };
  reconToleranceUsdc?: number; // default 5
};

/** Extract per-leg USD premiums from a structure quote when FalconX returns leg-level prices. Pure. */
export const legPremiumsUsdc = (
  quote: FxQuoteResponse,
  plan: FalconxCollarPlan
): { protectiveUsdc: number | null; fundingUsdc: number | null } => {
  const legs = quote.legs ?? [];
  const findLeg = (symbol: string) => legs.find((l) => l.symbol === symbol);
  // The BUY leg transacts at its ask; the SELL leg at its bid. Prices are per unit (per 1 BTC).
  const prot = findLeg(plan.protective.symbol);
  const fund = findLeg(plan.funding.symbol);
  const protPx = fxPriceValue(prot?.ask_price) ?? fxPriceValue(prot?.mark_price);
  const fundPx = fxPriceValue(fund?.bid_price) ?? fxPriceValue(fund?.mark_price);
  return {
    protectiveUsdc: protPx != null ? round2(Math.abs(protPx) * plan.qtyBtc) : null,
    fundingUsdc: fundPx != null ? round2(Math.abs(fundPx) * plan.qtyBtc) : null
  };
};

/** Book the OpenPosition row for an EXECUTED FalconX collar — real quoted net, listed strikes. */
export const bookFalconxPosition = (
  solved: SolvedCollar,
  plan: FalconxCollarPlan,
  exec: { netCreditUsdc: number; fxQuoteId: string; tradeIds: string[]; protectivePremiumUsdc: number | null; fundingPremiumUsdc: number | null },
  nowMs: number,
  spot: number
): OpenPosition => {
  const putLeg = plan.protective.optType === "put" ? plan.protective : plan.funding;
  const callLeg = plan.protective.optType === "call" ? plan.protective : plan.funding;
  return {
    ref: solved.ref,
    side: plan.side,
    notionalUsdc: plan.effectiveNotionalUsdc,
    spotAtEntry: spot,
    putStrike: putLeg.listedStrike,
    callStrike: callLeg.listedStrike,
    foxifyCreditUsdc: exec.netCreditUsdc,
    serviceFeeUsdc: solved.serviceFeeUsdc,
    floorPctUsed: round2((Math.abs(spot - plan.protective.listedStrike) / spot) * 10000) / 10000,
    openFeeUsdc: 0, // all-in RFQ pricing: FalconX's spread is embedded in the quoted net
    feesFundedByCollar: true,
    fundingLegPremiumUsdc: exec.fundingPremiumUsdc ?? undefined,
    protectiveLegPremiumUsdc: exec.protectivePremiumUsdc ?? undefined,
    venue: "falconx_live",
    openedAtMs: nowMs,
    expiresAtMs: plan.expiryMs,
    quoteMeta: {
      rfqRef: exec.fxQuoteId,
      quotedNetUsdc: exec.netCreditUsdc,
      modelNetUsdc: solved.foxifyCreditUsdc,
      quotedAtIso: new Date(nowMs).toISOString()
    },
    liveMeta: {
      putInstId: putLeg.symbol,
      callInstId: callLeg.symbol,
      contracts: plan.qtyBtc, // FalconX quantities are plain BTC
      ctValBtc: 1,
      mode: "live",
      protectiveFillPxBtc: 0, // FalconX quotes USD nets, not BTC premiums
      fundingFillPxBtc: 0,
      venueFeeUsdc: 0,
      fxQuoteId: exec.fxQuoteId,
      fxTradeIds: exec.tradeIds
    }
  };
};

/**
 * Quote → band-check → execute, with ONE re-quote on quote-expiry/band-miss. Atomic by construction
 * (one structure = both legs). Every abandoned RFQ is closed. Never throws.
 */
export const executeFalconxCollar = async (
  client: FalconxClient,
  plan: FalconxCollarPlan,
  opts: { bandPct: number; attempts?: number }
): Promise<{
  outcome: "filled" | "aborted_no_quote" | "aborted_band" | "aborted_execute_failed";
  safe: true; // an RFQ structure can never leave a naked leg
  netCreditUsdc: number | null;
  fxQuoteId: string | null;
  tradeIds: string[];
  protectivePremiumUsdc: number | null;
  fundingPremiumUsdc: number | null;
  quotedVsMidShortfallUsdc: number | null;
  errors: string[];
}> => {
  const attempts = opts.attempts ?? 2;
  const errors: string[] = [];
  let lastOutcome: "aborted_no_quote" | "aborted_band" | "aborted_execute_failed" = "aborted_no_quote";
  let lastShortfall: number | null = null;

  for (let i = 0; i < attempts; i++) {
    // "buy" the structure as listed (sell funding / buy protective) — the executable direction.
    const q = await client.requestQuote(plan.structure, plan.qtyBtc, "buy");
    if (!q.ok || q.json.fx_quote_id == null) {
      errors.push(`quote attempt ${i + 1} failed: ${q.errorMessage ?? "no fx_quote_id"}`);
      lastOutcome = "aborted_no_quote";
      continue;
    }
    const quote = q.json;
    const askPerUnit = fxPriceValue(quote.ask_price);
    const net = quotedNetCreditUsdc(askPerUnit, plan.qtyBtc);
    if (net == null) {
      errors.push(`quote attempt ${i + 1}: no ask price on the structure`);
      if (quote.rfq_id) await client.closeRfq(String(quote.rfq_id)).catch(() => undefined);
      lastOutcome = "aborted_no_quote";
      continue;
    }

    const band = quoteWithinBand(net, plan.modelMidNetUsdc, opts.bandPct);
    lastShortfall = band.shortfallUsdc;
    if (!band.ok) {
      errors.push(`quote attempt ${i + 1} OUTSIDE BAND: net $${net} vs model mid $${plan.modelMidNetUsdc} (shortfall $${band.shortfallUsdc} > allowed $${band.allowedUsdc})`);
      if (quote.rfq_id) await client.closeRfq(String(quote.rfq_id)).catch(() => undefined);
      lastOutcome = "aborted_band";
      continue;
    }

    // Execute IMMEDIATELY — the quote is firm only for seconds.
    const ex = await client.executeQuote(String(quote.fx_quote_id), "buy");
    if (!ex.ok) {
      errors.push(`execute attempt ${i + 1} failed: ${ex.errorMessage ?? "unknown"}`);
      if (quote.rfq_id) await client.closeRfq(String(quote.rfq_id)).catch(() => undefined);
      lastOutcome = "aborted_execute_failed";
      continue; // e.g. QUOTE_EXPIRED / NO_VALID_EXECUTABLE_QUOTE — re-quote once
    }

    const tradeIds = [ex.json.trade_id, ex.json.fx_trade_id].filter((t): t is string => typeof t === "string" && t.length > 0);
    const legs = legPremiumsUsdc(quote, plan);
    return {
      outcome: "filled",
      safe: true,
      netCreditUsdc: net,
      fxQuoteId: String(quote.fx_quote_id),
      tradeIds,
      protectivePremiumUsdc: legs.protectiveUsdc,
      fundingPremiumUsdc: legs.fundingUsdc,
      quotedVsMidShortfallUsdc: band.shortfallUsdc,
      errors
    };
  }

  return { outcome: lastOutcome, safe: true, netCreditUsdc: null, fxQuoteId: null, tradeIds: [], protectivePremiumUsdc: null, fundingPremiumUsdc: null, quotedVsMidShortfallUsdc: lastShortfall, errors };
};

/**
 * Unwind an open FalconX collar: quote + execute the REVERSE structure (buy back the funding leg,
 * sell the protective leg) as ONE trade. Atomic — there is no leg-ordering hazard. If it can't
 * fill, the position stays fully hedged and rides to expiry.
 */
export const unwindFalconxCollar = async (
  client: FalconxClient,
  pos: OpenPosition,
  opts: { bandPct?: number; maxCostUsdc?: number } = {}
): Promise<{ complete: boolean; deferred?: boolean; unwindValueUsdc: number | null; fxQuoteId: string | null; tradeIds: string[]; notes: string[] }> => {
  const lm = pos.liveMeta;
  const notes: string[] = [];
  if (!lm) return { complete: false, unwindValueUsdc: null, fxQuoteId: null, tradeIds: [], notes: ["no liveMeta — not a live position"] };
  const fundingSymbol = pos.side === "long" ? lm.callInstId : lm.putInstId;
  const protectiveSymbol = pos.side === "long" ? lm.putInstId : lm.callInstId;
  const qtyBtc = lm.contracts * lm.ctValBtc;

  // Reverse structure: BUY back the sold funding leg, SELL the held protective leg.
  const structure = [
    { side: "buy" as const, symbol: fundingSymbol, weight: 1 },
    { side: "sell" as const, symbol: protectiveSymbol, weight: 1 }
  ];
  const q = await client.requestQuote(structure, qtyBtc, "buy");
  if (!q.ok || q.json.fx_quote_id == null) {
    notes.push(`unwind quote failed: ${q.errorMessage ?? "no fx_quote_id"} — position rides to expiry (fully hedged)`);
    return { complete: false, unwindValueUsdc: null, fxQuoteId: null, tradeIds: [], notes };
  }
  const askPerUnit = fxPriceValue(q.json.ask_price);
  // Budget check against the REAL quote (watcher locks only when affordable): over budget — or
  // unverifiable — ⟹ decline and ride; the position stays fully hedged behind its floor.
  if (opts.maxCostUsdc != null) {
    const quotedCostUsdc = askPerUnit != null ? askPerUnit * qtyBtc : null;
    if (quotedCostUsdc == null || quotedCostUsdc > opts.maxCostUsdc) {
      notes.push(
        quotedCostUsdc == null
          ? `unwind quote has no ask price — cannot verify against budget $${opts.maxCostUsdc.toFixed(2)}; deferring`
          : `quoted unwind cost $${quotedCostUsdc.toFixed(2)} > budget $${opts.maxCostUsdc.toFixed(2)} — deferring (rides behind its floor)`
      );
      if (q.json.rfq_id) await client.closeRfq(String(q.json.rfq_id)).catch(() => undefined);
      return { complete: false, deferred: true, unwindValueUsdc: null, fxQuoteId: String(q.json.fx_quote_id), tradeIds: [], notes };
    }
  }
  const ex = await client.executeQuote(String(q.json.fx_quote_id), "buy");
  if (!ex.ok) {
    notes.push(`unwind execute failed: ${ex.errorMessage ?? "unknown"} — position rides to expiry (fully hedged)`);
    if (q.json.rfq_id) await client.closeRfq(String(q.json.rfq_id)).catch(() => undefined);
    return { complete: false, unwindValueUsdc: null, fxQuoteId: String(q.json.fx_quote_id), tradeIds: [], notes };
  }
  const tradeIds = [ex.json.trade_id, ex.json.fx_trade_id].filter((t): t is string => typeof t === "string" && t.length > 0);
  // Cost to unwind = ask × qty (positive = we pay); the value REALIZED by closing = −cost.
  const unwindValueUsdc = askPerUnit != null ? round2(-askPerUnit * qtyBtc) : null;
  notes.push(`unwound as one structure: fx_quote_id ${q.json.fx_quote_id}, value $${unwindValueUsdc}`);

  // Verify flat at the venue (net signed quantity per contract ≈ 0).
  try {
    const positions = await client.getOptionPositions();
    const rows = Array.isArray(positions.json) ? positions.json : [];
    const bySymbol = new Map<string, number>();
    for (const r of rows) {
      const name = String(r.contract_name ?? "");
      bySymbol.set(name, (bySymbol.get(name) ?? 0) + Number(r.signed_quantity ?? 0));
    }
    // contract_name format differs from the RFQ symbol; match on parsed strike/expiry/type instead.
    const residual = [fundingSymbol, protectiveSymbol].filter((sym) => {
      const p = parseFalconxSymbol(sym);
      if (!p) return false;
      for (const [name, qty] of bySymbol) {
        if (Math.abs(qty) < 1e-9) continue;
        if (name.includes(String(Math.round(p.strike))) && name.toUpperCase().includes(p.optType === "call" ? "-C-" : "-P-")) return true;
      }
      return false;
    });
    if (residual.length > 0) notes.push(`venue still reports residual quantity near: ${residual.join(", ")} — verify manually`);
    return { complete: residual.length === 0, unwindValueUsdc, fxQuoteId: String(q.json.fx_quote_id), tradeIds, notes };
  } catch (e) {
    notes.push(`flat check failed: ${(e as Error).message}`);
    return { complete: true, unwindValueUsdc, fxQuoteId: String(q.json.fx_quote_id), tradeIds, notes };
  }
};

/** Reconcile settled falconx_live positions against trade transactions + cash flows. */
export const reconcileFalconxSettlements = async (
  client: FalconxClient,
  targets: SettlementOutcome[],
  opts: { toleranceUsdc: number; nowMs: number }
): Promise<LiveReconRecord[]> => {
  const out: LiveReconRecord[] = [];

  // One cash-flow sweep for all targets (Settlement rows join on trade_id).
  let cashFlows: Array<{ amount?: number | string; currency?: string; payment_type?: string; trade_id?: string | null }> = [];
  try {
    const cf = await client.getCashFlows({});
    if (Array.isArray(cf.json)) cashFlows = cf.json;
  } catch {
    /* degrade to pending */
  }

  for (const s of targets) {
    const lm = s.liveMeta!;
    const notes: string[] = [];
    const base: Omit<LiveReconRecord, "status"> = {
      tsMs: opts.nowMs,
      ref: s.ref,
      putInstId: lm.putInstId,
      callInstId: lm.callInstId,
      ourSettlePriceUsd: s.settlePriceUsd,
      venueSettlePriceUsd: null,
      priceDiffUsd: null,
      ourPayoutUsdc: s.payoutToFoxifyUsdc,
      venueCashFlowUsdc: null,
      cashDiffUsdc: null,
      toleranceUsdc: opts.toleranceUsdc,
      notes
    };

    const put = parseFalconxSymbol(lm.putInstId);
    const call = parseFalconxSymbol(lm.callInstId);
    if (!put || !call || lm.fxTradeIds == null || lm.fxTradeIds.length === 0) {
      notes.push(!put || !call ? `could not parse strikes from ${lm.putInstId}/${lm.callInstId}` : "no FalconX trade ids on the position — cannot join venue records");
      out.push({ ...base, status: "mismatch" });
      continue;
    }

    // Venue settlement price from the trade's expired/exercised transactions.
    let venuePx: number | null = null;
    for (const tradeId of lm.fxTradeIds) {
      try {
        const tx = await client.getDerivativeTransactions(tradeId);
        const rows = Array.isArray(tx.json) ? tx.json : [];
        for (const r of rows) {
          const type = String(r.transaction_type ?? "");
          const px = Number(r.settlement_price ?? NaN);
          if ((type === "expired" || type === "exercised" || type === "settled") && Number.isFinite(px) && px > 0) venuePx = px;
        }
      } catch {
        /* keep looking */
      }
    }
    if (venuePx == null) {
      notes.push("FalconX has not published settlement transactions for this trade yet — retry next cycle");
      out.push({ ...base, status: "pending_venue_data" });
      continue;
    }

    const qtyBtc = lm.contracts * lm.ctValBtc;
    const expectedUsd = hedgePayoffUsd(s.side, put.strike, call.strike, qtyBtc, venuePx);

    // Realized settlement cash for this trade (FalconX signs from THEIR side: negative = they pay us).
    const settleFlows = cashFlows.filter((f) => f.trade_id != null && lm.fxTradeIds!.includes(String(f.trade_id)) && String(f.payment_type ?? "") === "Settlement");
    const venueCashUsd = settleFlows.length > 0 ? round2(settleFlows.reduce((sum, f) => sum + -Number(f.amount ?? 0), 0)) : null;

    const priceDiff = round2(s.settlePriceUsd - venuePx);
    if (venueCashUsd == null) {
      if (Math.abs(expectedUsd) <= opts.toleranceUsdc) {
        notes.push("no settlement cash flows and expected payoff ≈ 0 (expired OTM) — reconciled at $0");
        notes.push(`oracle-vs-venue basis: ${priceDiff} USD — informational`);
        out.push({ ...base, venueSettlePriceUsd: venuePx, priceDiffUsd: priceDiff, venueCashFlowUsdc: 0, cashDiffUsdc: round2(0 - expectedUsd), status: "matched" });
      } else {
        notes.push(`expected non-zero settlement ($${round2(expectedUsd)}) but no cash flows yet — retry next cycle`);
        out.push({ ...base, venueSettlePriceUsd: venuePx, priceDiffUsd: priceDiff, status: "pending_venue_data" });
      }
      continue;
    }

    const cashDiff = round2(venueCashUsd - expectedUsd);
    const matched = Math.abs(cashDiff) <= opts.toleranceUsdc;
    if (!matched) notes.push(`venue cash ${venueCashUsd} differs from expected payoff-at-fixing ${round2(expectedUsd)} by ${cashDiff} (tolerance ${opts.toleranceUsdc})`);
    notes.push(`oracle-vs-venue basis: ${priceDiff} USD (${round2((priceDiff / venuePx) * 1e4)} bps) — informational`);
    out.push({ ...base, venueSettlePriceUsd: venuePx, priceDiffUsd: priceDiff, venueCashFlowUsdc: venueCashUsd, cashDiffUsdc: cashDiff, status: matched ? "matched" : "mismatch" });
  }
  return out;
};

/** Build the FalconX live hook (the primary venue). */
export const buildFalconxLiveExecutionHook = (env: Record<string, string | undefined>, deps: FalconxRunnerDeps): LiveExecutionHook => {
  const guards = deps.guards ?? parseLiveGuardsFromEnv(env, "falconx");
  const reconTol = deps.reconToleranceUsdc ?? Number(env.LIVE_RECON_TOLERANCE_USDC ?? "5");

  type Handle = { plan: FalconxCollarPlan };

  const adapter: LiveVenueAdapter = {
    venueLabel: "falconx_live",
    mode: "live", // no demo environment at FalconX

    plan: async (solved: SolvedCollar, ctx: LiveWindowContext): Promise<VenuePlanResult> => {
      const inst = await deps.client.getInstruments();
      const instruments = inst.json.instruments ?? [];
      if (!inst.ok || instruments.length === 0) {
        return { ok: false, error: "instruments_fetch_failed", message: inst.errorMessage ?? "FalconX returned no instruments" };
      }
      const planRes = planFalconxCollar(instruments, {
        side: solved.side,
        spot: ctx.spot,
        notionalUsdc: solved.notionalUsdc,
        putStrike: solved.putStrike,
        callStrike: solved.callStrike,
        protectiveMidUsdc: solved.protectiveLegMidUsdc,
        fundingMidUsdc: solved.fundingLegMidUsdc,
        modelContractsBtc: solved.notionalUsdc / ctx.spot,
        nowMs: ctx.nowMs,
        maxStrikeDriftPct: guards.maxStrikeDriftPct,
        // Canary override: LIVE_CANARY_CONTRACTS is in 0.01 BTC units (same semantics as OKX).
        qtyBtcOverride: guards.canaryContracts != null ? +(guards.canaryContracts * 0.01).toFixed(4) : undefined
      });
      if (!planRes.ok) return planRes;
      return { ok: true, plan: { effectiveNotionalUsdc: planRes.plan.effectiveNotionalUsdc, handle: { plan: planRes.plan } satisfies Handle } };
    },

    execute: async (solved, venuePlan, ctx): Promise<VenueExecutionResult> => {
      const { plan } = venuePlan.handle as Handle;
      const exec = await executeFalconxCollar(deps.client, plan, { bandPct: guards.slippageBandPct });
      const putSymbol = plan.protective.optType === "put" ? plan.protective.symbol : plan.funding.symbol;
      const callSymbol = plan.protective.optType === "call" ? plan.protective.symbol : plan.funding.symbol;
      const alerts = exec.outcome === "aborted_band" ? [`FalconX quote outside the slippage band (shortfall $${exec.quotedVsMidShortfallUsdc}) — day skipped, never chase`] : [];
      return {
        outcome: exec.outcome,
        safe: true, // structure execution cannot strand a leg
        pos:
          exec.outcome === "filled" && exec.netCreditUsdc != null && exec.fxQuoteId != null
            ? bookFalconxPosition(solved, plan, { netCreditUsdc: exec.netCreditUsdc, fxQuoteId: exec.fxQuoteId, tradeIds: exec.tradeIds, protectivePremiumUsdc: exec.protectivePremiumUsdc, fundingPremiumUsdc: exec.fundingPremiumUsdc }, ctx.nowMs, ctx.spot)
            : undefined,
        netCreditUsdc: exec.netCreditUsdc,
        venueFeeUsdc: 0,
        contracts: plan.qtyBtc,
        putInstId: putSymbol,
        callInstId: callSymbol,
        alerts,
        detail: { fxQuoteId: exec.fxQuoteId, tradeIds: exec.tradeIds, quotedVsMidShortfallUsdc: exec.quotedVsMidShortfallUsdc, errors: exec.errors }
      };
    },

    unwindFilled: async (pos: OpenPosition, _ctx, opts) => {
      const rep = await unwindFalconxCollar(deps.client, pos, { maxCostUsdc: opts?.maxCostUsdc });
      return { complete: rep.complete, deferred: rep.deferred, notes: rep.notes, detail: rep };
    },

    reconcileSettled: (targets: SettlementOutcome[], nowMs: number) => reconcileFalconxSettlements(deps.client, targets, { toleranceUsdc: reconTol, nowMs })
  };

  return buildLiveExecutionHook({
    adapter,
    guards,
    // Pilot default: the partner makes the elevated-day directional call (LIVE_DIRECTIONAL_DECISION=auto opts out).
    directionalDecisionMode: (env.LIVE_DIRECTIONAL_DECISION ?? "partner").toLowerCase() === "auto" ? "auto" : "partner",
    paths: deps.paths
  });
};
