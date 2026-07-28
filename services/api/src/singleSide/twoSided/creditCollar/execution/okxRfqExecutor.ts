/**
 * OKX block-RFQ collar executor — the RFQ lane confirmed with the OKX BD (auto-quoting makers on
 * daily-expiry multi-leg; $50k min notional per trade). The whole 2-leg collar goes out as ONE RFQ
 * (atomic by construction — a block trade fills all legs or none), makers respond with package
 * quotes, and we execute the best quote whose BOTH legs sit inside the same slippage band the CLOB
 * path enforces. Anything less than a banded, executable quote by the deadline ⟹ cancel the RFQ
 * and report a SAFE non-fill — the caller falls back to the order-book executor.
 *
 * Same report shape as the CLOB executor so booking/recon/alerting reuse unchanged. Never throws on
 * venue errors; they land in report.errors and drive the outcome.
 */

import type { OkxResponse } from "./okxExecutionClient";
import { fillWithinBand, premiumUsd, type LiveCollarPlan, type PlannedLeg } from "./okxLivePlanner";
import type { LiveCollarExecutionReport, LiveLegResult } from "./okxLiveCollarExecutor";

export type RfqLegSpec = { instId: string; sz: string; side: "buy" | "sell" };
export type RfqQuoteLeg = { instId?: string; px?: string; sz?: string; side?: string; fee?: string };
export type RfqQuote = { quoteId?: string; rfqId?: string; state?: string; validUntil?: string; legs?: RfqQuoteLeg[] };

export type RfqExecClient = {
  mode: "demo" | "live";
  getRfqCounterparties: () => Promise<OkxResponse<{ traderCode?: string }>>;
  createRfq: (body: { counterparties: string[]; anonymous: boolean; clRfqId?: string; allowPartialExecution: false; legs: RfqLegSpec[] }) => Promise<OkxResponse<{ rfqId?: string; state?: string }>>;
  getRfqQuotes: (rfqId: string) => Promise<OkxResponse<RfqQuote>>;
  executeRfqQuote: (rfqId: string, quoteId: string) => Promise<OkxResponse<{ blockTdId?: string; legs?: RfqQuoteLeg[] }>>;
  cancelRfq: (rfqId: string) => Promise<OkxResponse<{ rfqId?: string }>>;
};

export type RfqExecutorOpts = {
  bandPct: number;              // same slippage band as the CLOB path — per leg, vs model mid
  spotUsd: number;
  quoteWaitMs?: number;         // total time to wait for an acceptable quote (default 15s)
  pollDelayMs?: number;         // default 1s
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const parseNum = (v: string | undefined | null): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** OKX options taker fee: 0.03% of underlying notional, capped at 12.5% of premium (fee estimate when
 *  the venue response omits per-leg fees; the bills reconciliation trues it up post-settlement). */
const estimateLegFeeUsd = (qtyBtc: number, spotUsd: number, legPremiumUsd: number): number =>
  +Math.min(0.0003 * qtyBtc * spotUsd, 0.125 * Math.abs(legPremiumUsd)).toFixed(2);

const legResultFromQuote = (leg: PlannedLeg, plan: LiveCollarPlan, pxBtc: number | null, feeBtc: number, ids: string[], bandPct: number, state: string): LiveLegResult => ({
  instId: leg.instId,
  action: leg.action,
  requestedContracts: plan.contracts,
  filledContracts: pxBtc != null ? plan.contracts : 0,
  avgPxBtc: pxBtc != null ? +pxBtc.toFixed(8) : null,
  feeBtc: +feeBtc.toFixed(8),
  ordIds: ids,
  withinBand: pxBtc != null ? fillWithinBand(leg.action, pxBtc, leg.modelMidPxBtc, bandPct) : null,
  slippagePctVsMid: pxBtc != null && leg.modelMidPxBtc > 0 ? +(((leg.action === "buy" ? pxBtc - leg.modelMidPxBtc : leg.modelMidPxBtc - pxBtc) / leg.modelMidPxBtc)).toFixed(6) : null,
  lastState: state
});

/** Pull a quote's price for one leg (BTC per BTC underlying — same convention as the book). */
const quoteLegPx = (q: RfqQuote, instId: string): number | null => {
  const leg = (q.legs ?? []).find((l) => l.instId === instId);
  return leg ? parseNum(leg.px) : null;
};

/** Both legs quoted AND both inside the band ⟹ the quote is executable by our own standard. */
const quoteAcceptable = (q: RfqQuote, plan: LiveCollarPlan, bandPct: number): boolean => {
  const prot = quoteLegPx(q, plan.protective.instId);
  const fund = quoteLegPx(q, plan.funding.instId);
  if (prot == null || fund == null) return false;
  return fillWithinBand("buy", prot, plan.protective.modelMidPxBtc, bandPct) && fillWithinBand("sell", fund, plan.funding.modelMidPxBtc, bandPct);
};

/** Net package credit of a quote in USD (what we receive for the cap minus what we pay for the floor). */
export const quoteNetCreditUsd = (q: RfqQuote, plan: LiveCollarPlan, spotUsd: number): number | null => {
  const prot = quoteLegPx(q, plan.protective.instId);
  const fund = quoteLegPx(q, plan.funding.instId);
  if (prot == null || fund == null) return null;
  return +(premiumUsd(fund, plan.contracts, plan.ctValBtc, spotUsd) - premiumUsd(prot, plan.contracts, plan.ctValBtc, spotUsd)).toFixed(2);
};

export const executeRfqCollar = async (
  client: RfqExecClient,
  plan: LiveCollarPlan,
  opts: RfqExecutorOpts
): Promise<LiveCollarExecutionReport & { rfqId?: string | null; blockTdId?: string | null }> => {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const quoteWaitMs = opts.quoteWaitMs ?? 15_000;
  const pollDelayMs = opts.pollDelayMs ?? 1_000;
  const errors: string[] = [];
  const alerts: string[] = [];

  const abort = (why: string): LiveCollarExecutionReport & { rfqId?: string | null; blockTdId?: string | null } => ({
    mode: client.mode,
    outcome: "aborted_no_fill", // nothing stands — a block trade is all-or-none, so a non-fill is always SAFE
    safe: true,
    protective: legResultFromQuote(plan.protective, plan, null, 0, [], opts.bandPct, why),
    funding: legResultFromQuote(plan.funding, plan, null, 0, [], opts.bandPct, why),
    unwind: null,
    protectivePremiumUsdc: null,
    fundingPremiumUsdc: null,
    venueFeeUsdc: null,
    netCreditUsdc: null,
    alerts,
    errors: [...errors, why],
    rfqId: null,
    blockTdId: null
  });

  // 1) Makers available to this account?
  const cps = await client.getRfqCounterparties();
  const traderCodes = (cps.data ?? []).map((c) => c.traderCode).filter((t): t is string => typeof t === "string" && t.length > 0);
  if (!cps.ok || traderCodes.length === 0) return abort(`no RFQ counterparties (${cps.code}: ${cps.msg})`);

  // 2) One RFQ, both legs, atomic. Protective = we BUY (client floor); funding = we SELL (client cap).
  const legs: RfqLegSpec[] = [
    { instId: plan.protective.instId, sz: String(plan.contracts), side: "buy" },
    { instId: plan.funding.instId, sz: String(plan.contracts), side: "sell" }
  ];
  const created = await client.createRfq({ counterparties: traderCodes, anonymous: true, allowPartialExecution: false, legs });
  const rfqId = created.data?.[0]?.rfqId;
  if (!created.ok || !rfqId) return abort(`create-rfq failed (${created.code}: ${created.msg})`);

  // 3) Poll for the best acceptable quote until the deadline.
  const deadline = now() + quoteWaitMs;
  let best: { quote: RfqQuote; netUsd: number } | null = null;
  while (now() < deadline) {
    const qr = await client.getRfqQuotes(rfqId);
    for (const q of qr.data ?? []) {
      if ((q.state ?? "active") !== "active" || !q.quoteId) continue;
      if (!quoteAcceptable(q, plan, opts.bandPct)) continue;
      const netUsd = quoteNetCreditUsd(q, plan, opts.spotUsd);
      if (netUsd == null) continue;
      if (best == null || netUsd > best.netUsd) best = { quote: q, netUsd };
    }
    if (best != null) break; // first acceptable sweep wins — quotes are firm ~seconds, don't shop them stale
    await sleep(pollDelayMs);
  }
  if (best == null) {
    await client.cancelRfq(rfqId).catch(() => undefined);
    return { ...abort("no acceptable quote inside the band by the deadline"), rfqId };
  }

  // 4) Execute the quote — atomic block trade, all legs or none.
  const ex = await client.executeRfqQuote(rfqId, String(best.quote.quoteId));
  const blockTdId = ex.data?.[0]?.blockTdId ?? null;
  if (!ex.ok) {
    await client.cancelRfq(rfqId).catch(() => undefined);
    return { ...abort(`execute-quote failed (${ex.code}: ${ex.msg}) — nothing stands`), rfqId };
  }

  // 5) Realized economics from the executed legs (fall back to the quote's own prices — identical for
  // a block fill), fees from the response when present, else the deterministic estimate (bills recon
  // trues it up at settlement).
  const exLegs = ex.data?.[0]?.legs ?? best.quote.legs ?? [];
  const px = (instId: string): number | null => parseNum(exLegs.find((l) => l.instId === instId)?.px) ?? quoteLegPx(best!.quote, instId);
  const feeOf = (instId: string): number | null => parseNum(exLegs.find((l) => l.instId === instId)?.fee);
  const protPx = px(plan.protective.instId);
  const fundPx = px(plan.funding.instId);
  const qtyBtc = plan.contracts * plan.ctValBtc;
  const protUsd = protPx != null ? premiumUsd(protPx, plan.contracts, plan.ctValBtc, opts.spotUsd) : 0;
  const fundUsd = fundPx != null ? premiumUsd(fundPx, plan.contracts, plan.ctValBtc, opts.spotUsd) : 0;
  const protFeeUsd = feeOf(plan.protective.instId) != null ? Math.abs(feeOf(plan.protective.instId)!) * opts.spotUsd : estimateLegFeeUsd(qtyBtc, opts.spotUsd, protUsd);
  const fundFeeUsd = feeOf(plan.funding.instId) != null ? Math.abs(feeOf(plan.funding.instId)!) * opts.spotUsd : estimateLegFeeUsd(qtyBtc, opts.spotUsd, fundUsd);
  const venueFeeUsdc = +(protFeeUsd + fundFeeUsd).toFixed(2);
  const ids = [blockTdId ?? rfqId];

  alerts.push(`RFQ filled as one block (${traderCodes.length} makers polled): net $${(fundUsd - protUsd - venueFeeUsdc).toFixed(2)}`);
  return {
    mode: client.mode,
    outcome: "filled",
    safe: true,
    protective: legResultFromQuote(plan.protective, plan, protPx, protFeeUsd / Math.max(opts.spotUsd, 1e-9), ids, opts.bandPct, "filled"),
    funding: legResultFromQuote(plan.funding, plan, fundPx, fundFeeUsd / Math.max(opts.spotUsd, 1e-9), ids, opts.bandPct, "filled"),
    unwind: null,
    protectivePremiumUsdc: +protUsd.toFixed(2),
    fundingPremiumUsdc: +fundUsd.toFixed(2),
    venueFeeUsdc,
    netCreditUsdc: +(fundUsd - protUsd - venueFeeUsdc).toFixed(2),
    alerts,
    errors,
    rfqId,
    blockTdId
  };
};
