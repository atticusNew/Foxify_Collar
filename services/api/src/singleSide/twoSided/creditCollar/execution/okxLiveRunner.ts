/**
 * OKX venue adapter for the LIVE window runner — kept as the FALLBACK execution venue (FalconX is
 * primary). All the rails (kill-switch, window, caps, pair atomicity, recon halt) live in the shared
 * liveWindowRunner; this file only knows how to trade on OKX:
 *
 *   plan     → listed-chain mapping + 0.01-BTC lot rounding (okxLivePlanner)
 *   execute  → two band-capped CLOB legs, atomic with unwind-on-partial (okxLiveCollarExecutor)
 *   unwind   → short-leg-first close (okxLiveUnwind)
 *   recon    → OKX delivery price + account bills (okxSettlementRecon)
 */

import type { OpenPosition, SettlementOutcome } from "../forwardSettlement";
import type { LiveReconRecord } from "./liveExecutionStore";
import { parseLiveGuardsFromEnv, type LiveGuardsConfig } from "./liveGuards";
import {
  buildLiveExecutionHook,
  type LiveExecutionHook,
  type LiveVenueAdapter,
  type LiveWindowContext,
  type SolvedCollar,
  type VenuePlanResult,
  type VenueExecutionResult
} from "./liveWindowRunner";
import { executeLiveCollar, type LiveExecClient } from "./okxLiveCollarExecutor";
import { parseOkxChain, planLiveCollar, type LiveCollarPlan } from "./okxLivePlanner";
import { fetchOkxSettlementData, reconcileLiveSettlement, type ReconFetchers } from "./okxSettlementRecon";
import { unwindLiveCollar } from "./okxLiveUnwind";

// Re-exports so existing callers (service, canary, tests) keep one import site.
export type { LiveExecutionHook, LiveWindowContext, LiveWindowResult, SolvedCollar, SolveSide } from "./liveWindowRunner";

export type LiveVenueClient = LiveExecClient &
  ReconFetchers & {
    getOptionChain: (uly?: string) => Promise<{ ok: boolean; data: Array<{ instId?: string; optType?: string; stk?: string; expTime?: string; ctVal?: string; ctMult?: string; tickSz?: string; lotSz?: string; minSz?: string; state?: string }> }>;
  };

export type LiveRunnerDeps = {
  client: LiveVenueClient;
  guards?: LiveGuardsConfig;      // default: parsed from env
  paths?: { executions?: string; windowState?: string; alerts?: string; recon?: string; settlements?: string };
  reconToleranceUsdc?: number;    // default 5
  fillTimeoutMs?: number;
  pollDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const round2 = (x: number) => +x.toFixed(2);

/** Build the OpenPosition row for a FILLED live collar — real premiums, fees, credit, listed strikes. */
export const bookLivePosition = (
  solved: SolvedCollar,
  plan: LiveCollarPlan,
  exec: Awaited<ReturnType<typeof executeLiveCollar>>,
  nowMs: number,
  spot: number,
  mode: "demo" | "live",
  clOrdPrefix: string
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
    foxifyCreditUsdc: exec.netCreditUsdc ?? 0,
    serviceFeeUsdc: solved.serviceFeeUsdc,
    floorPctUsed: round2((Math.abs(spot - plan.protective.listedStrike) / spot) * 10000) / 10000,
    openFeeUsdc: exec.venueFeeUsdc ?? 0,
    feesFundedByCollar: true,
    fundingLegPremiumUsdc: exec.fundingPremiumUsdc ?? 0,
    protectiveLegPremiumUsdc: exec.protectivePremiumUsdc ?? 0,
    venue: "okx_live",
    openedAtMs: nowMs,
    expiresAtMs: plan.expiryMs,
    quoteMeta: {
      rfqRef: clOrdPrefix,
      quotedNetUsdc: exec.netCreditUsdc ?? 0,
      modelNetUsdc: solved.foxifyCreditUsdc,
      quotedAtIso: new Date(nowMs).toISOString()
    },
    liveMeta: {
      putInstId: putLeg.instId,
      callInstId: callLeg.instId,
      contracts: plan.contracts,
      ctValBtc: plan.ctValBtc,
      mode,
      protectiveFillPxBtc: exec.protective.avgPxBtc ?? 0,
      fundingFillPxBtc: exec.funding.avgPxBtc ?? 0,
      venueFeeUsdc: exec.venueFeeUsdc ?? 0,
      clOrdPrefix
    }
  };
};

/** OKX adapter over the shared window runner. Same public signature as before the venue split. */
export const buildOkxLiveExecutionHook = (env: Record<string, string | undefined>, deps: LiveRunnerDeps): LiveExecutionHook => {
  const guards = deps.guards ?? parseLiveGuardsFromEnv(env, "okx");
  const reconTol = deps.reconToleranceUsdc ?? Number(env.LIVE_RECON_TOLERANCE_USDC ?? "5");

  type Handle = { plan: LiveCollarPlan };

  const adapter: LiveVenueAdapter = {
    venueLabel: "okx_live",
    mode: deps.client.mode,

    plan: async (solved: SolvedCollar, ctx: LiveWindowContext): Promise<VenuePlanResult> => {
      const chainRes = await deps.client.getOptionChain("BTC-USD");
      if (!chainRes.ok) return { ok: false, error: "chain_fetch_failed", message: "OKX option chain fetch failed" };
      const planRes = planLiveCollar(parseOkxChain(chainRes.data ?? []), {
        side: solved.side,
        spot: ctx.spot,
        notionalUsdc: solved.notionalUsdc,
        putStrike: solved.putStrike,
        callStrike: solved.callStrike,
        protectiveMidUsdc: solved.protectiveLegMidUsdc,
        fundingMidUsdc: solved.fundingLegMidUsdc,
        modelContractsBtc: solved.notionalUsdc / ctx.spot,
        nowMs: ctx.nowMs,
        maxStrikeDriftPct: guards.maxStrikeDriftPct
      });
      if (!planRes.ok) return planRes;
      let plan = planRes.plan;
      // Canary size override (Mon/Tue go/no-go: a tiny real collar through the FULL path).
      if (guards.canaryContracts != null) {
        const contracts = guards.canaryContracts;
        const contractsBtc = +(contracts * plan.ctValBtc).toFixed(6);
        plan = { ...plan, contracts, contractsBtc, effectiveNotionalUsdc: round2(contractsBtc * ctx.spot) };
      }
      return { ok: true, plan: { effectiveNotionalUsdc: plan.effectiveNotionalUsdc, handle: { plan } satisfies Handle } };
    },

    execute: async (solved, venuePlan, ctx): Promise<VenueExecutionResult> => {
      const { plan } = venuePlan.handle as Handle;
      const clOrdPrefix = `al${ctx.nowMs.toString(36)}${solved.side === "long" ? "L" : "S"}`;
      const exec = await executeLiveCollar(deps.client, plan, {
        bandPct: guards.slippageBandPct,
        fillTimeoutMs: deps.fillTimeoutMs,
        pollDelayMs: deps.pollDelayMs,
        spotUsd: ctx.spot,
        clOrdPrefix,
        sleep: deps.sleep
      });
      const putInstId = plan.protective.optType === "put" ? plan.protective.instId : plan.funding.instId;
      const callInstId = plan.protective.optType === "call" ? plan.protective.instId : plan.funding.instId;
      return {
        outcome: exec.outcome,
        safe: exec.safe,
        pos: exec.outcome === "filled" ? bookLivePosition(solved, plan, exec, ctx.nowMs, ctx.spot, deps.client.mode, clOrdPrefix) : undefined,
        netCreditUsdc: exec.netCreditUsdc,
        venueFeeUsdc: exec.venueFeeUsdc,
        contracts: plan.contracts,
        putInstId,
        callInstId,
        alerts: exec.alerts,
        detail: { protective: exec.protective, funding: exec.funding, unwind: exec.unwind, errors: exec.errors }
      };
    },

    unwindFilled: async (pos: OpenPosition, ctx: LiveWindowContext) => {
      const lm = pos.liveMeta!;
      const rep = await unwindLiveCollar(
        deps.client,
        { side: pos.side, putInstId: lm.putInstId, callInstId: lm.callInstId, contracts: lm.contracts, ctValBtc: lm.ctValBtc },
        { spotUsd: ctx.spot, sleep: deps.sleep }
      );
      return { complete: rep.complete, notes: rep.notes, detail: rep };
    },

    reconcileSettled: async (targets: SettlementOutcome[], nowMs: number): Promise<LiveReconRecord[]> => {
      const instIds = targets.flatMap((s) => [s.liveMeta!.putInstId, s.liveMeta!.callInstId]);
      const venueData = await fetchOkxSettlementData(deps.client, instIds);
      return targets.map((s) => reconcileLiveSettlement(s, venueData, { toleranceUsdc: reconTol, nowMs }));
    }
  };

  return buildLiveExecutionHook({ adapter, guards, paths: deps.paths });
};
