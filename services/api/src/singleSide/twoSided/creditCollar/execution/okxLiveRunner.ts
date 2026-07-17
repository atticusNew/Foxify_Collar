/**
 * OKX LIVE window runner — the one place where the validated auto-strategy output becomes REAL
 * orders. Runs inside the normal forward cycle (same gate, same pricer, same stores) but only ever
 * acts inside the daily window, behind every guard:
 *
 *   kill-switch → live-confirm → window due (one attempt/day, never chase) → recon-mismatch halt →
 *   strategy (calm ⟹ pair · elevated ⟹ directional single · halt ⟹ skip) → EV/credit guardrails
 *   (a rejection SKIPS the day, never forces) → instrument mapping (fail-closed) → notional caps →
 *   atomic execution (both legs or neither) → PAIR atomicity (collar 2 fails ⟹ collar 1 unwound).
 *
 * Filled collars are booked into the SAME open-positions ledger as the shadow (venue "okx_live",
 * REAL premiums/fees/credit, expiry = the listed 08:00 UTC instrument expiry) so they flow through
 * the normal settlement pipeline and dashboards. Settled live positions are reconciled against OKX's
 * own delivery price + bills; any mismatch halts further issuance.
 */

import type { PerpSide } from "../creditCollarPricer";
import type { OpenPosition, SettlementOutcome } from "../forwardSettlement";
import type { RegimeGateDecision } from "../regimeGate";
import { loadSettlements } from "../forwardSettlementStore";
import {
  appendLiveExecution,
  appendLiveRecon,
  bookedNotionalForDay,
  hasUnresolvedReconMismatch,
  loadLiveExecutions,
  loadLiveRecons,
  loadWindowState,
  raiseLiveAlert,
  saveWindowState,
  type LiveExecutionRecord
} from "./liveExecutionStore";
import { checkNotionalCaps, executionArmed, isWindowDue, parseLiveGuardsFromEnv, type LiveGuardsConfig } from "./liveGuards";
import { executeLiveCollar, type LiveExecClient } from "./okxLiveCollarExecutor";
import { parseOkxChain, planLiveCollar, type LiveCollarPlan } from "./okxLivePlanner";
import { fetchOkxSettlementData, reconcileLiveSettlement, type ReconFetchers } from "./okxSettlementRecon";
import { unwindLiveCollar } from "./okxLiveUnwind";

export type SolvedCollar = {
  ref: string;
  side: PerpSide;
  notionalUsdc: number;
  putStrike: number;
  callStrike: number;
  foxifyCreditUsdc: number;      // model credit (becomes quoteMeta.modelNetUsdc)
  serviceFeeUsdc: number;
  floorPctUsed: number;
  protectiveLegMidUsdc: number;  // model MID totals — the slippage-band anchor
  fundingLegMidUsdc: number;
};

export type SolveSide = (side: PerpSide) => { ok: true; solved: SolvedCollar } | { ok: false; error: string; message: string };

export type LiveWindowContext = {
  nowMs: number;
  spot: number;
  regime: RegimeGateDecision | undefined;
  trendBias: PerpSide;           // side for elevated-day directional singles
  solveSide: SolveSide;
};

export type LiveWindowResult = {
  attempted: number;
  newOpens: OpenPosition[];
  rejected: number;
  rejectionsByReason: Record<string, number>;
  summary: string;
};

export type LiveExecutionHook = {
  executeWindow: (ctx: LiveWindowContext) => Promise<LiveWindowResult>;
  reconcileSettled: (settledThisCycle: SettlementOutcome[]) => Promise<void>;
};

export type LiveVenueClient = LiveExecClient &
  ReconFetchers & {
    getOptionChain: (uly?: string) => Promise<{ ok: boolean; data: Array<{ instId?: string; optType?: string; stk?: string; expTime?: string; ctVal?: string; tickSz?: string; lotSz?: string; minSz?: string; state?: string }> }>;
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
  const protectiveFillPx = exec.protective.avgPxBtc ?? 0;
  const fundingFillPx = exec.funding.avgPxBtc ?? 0;
  return {
    ref: solved.ref,
    side: plan.side,
    notionalUsdc: plan.effectiveNotionalUsdc,
    spotAtEntry: spot,
    putStrike: putLeg.listedStrike,
    callStrike: callLeg.listedStrike,
    foxifyCreditUsdc: exec.netCreditUsdc ?? 0,
    serviceFeeUsdc: solved.serviceFeeUsdc,
    floorPctUsed: round2(Math.abs(spot - (plan.protective.listedStrike)) / spot * 10000) / 10000,
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
      protectiveFillPxBtc: protectiveFillPx,
      fundingFillPxBtc: fundingFillPx,
      venueFeeUsdc: exec.venueFeeUsdc ?? 0,
      clOrdPrefix
    }
  };
};

/** Construct the live hook. Everything defaults from env; deps are injectable for tests. */
export const buildOkxLiveExecutionHook = (env: Record<string, string | undefined>, deps: LiveRunnerDeps): LiveExecutionHook => {
  const guards = deps.guards ?? parseLiveGuardsFromEnv(env);
  const paths = deps.paths ?? {};
  const reconTol = deps.reconToleranceUsdc ?? Number(env.LIVE_RECON_TOLERANCE_USDC ?? "5");

  const executeWindow = async (ctx: LiveWindowContext): Promise<LiveWindowResult> => {
    const none = (summary: string): LiveWindowResult => ({ attempted: 0, newOpens: [], rejected: 0, rejectionsByReason: {}, summary });

    const armed = executionArmed(guards);
    if (!armed.armed) return none(`live execution disarmed: ${armed.reason}`);

    const windowState = loadWindowState(paths.windowState);
    const window = isWindowDue(ctx.nowMs, windowState, guards);
    if (!window.due) return none(`window not due: ${window.reason}`);

    // Reconciliation-mismatch halt: unresolved mismatch ⟹ no new issuance (window consumed, day skipped).
    if (hasUnresolvedReconMismatch(loadLiveRecons(paths.recon))) {
      raiseLiveAlert({ tsMs: ctx.nowMs, level: "critical", code: "recon_halt", message: "unresolved settlement-reconciliation mismatch — issuance HALTED (window skipped)" }, paths.alerts);
      saveWindowState({ lastAttemptDayUtc: window.dayUtc, lastAttemptTsMs: ctx.nowMs, lastOutcome: "recon_halt_skip" }, paths.windowState);
      return none("issuance halted by reconciliation mismatch");
    }

    // Strategy: HALT ⟹ skip · CALM ⟹ neutral pair (both-or-neither) · ELEVATED ⟹ one directional single.
    const regime = ctx.regime?.regime ?? "calm";
    if (regime === "halt") {
      saveWindowState({ lastAttemptDayUtc: window.dayUtc, lastAttemptTsMs: ctx.nowMs, lastOutcome: "halt_skip" }, paths.windowState);
      return none(`regime HALT (${ctx.regime?.reason ?? ""}) — day skipped`);
    }
    const sides: PerpSide[] = regime === "calm" ? ["long", "short"] : [ctx.trendBias];
    const pairAtomic = sides.length === 2;

    // Consume the window FIRST (crash-safe: never a double window on restart).
    saveWindowState({ lastAttemptDayUtc: window.dayUtc, lastAttemptTsMs: ctx.nowMs, lastOutcome: "in_progress" }, paths.windowState);

    const bookedToday = bookedNotionalForDay(loadLiveExecutions(paths.executions), window.dayUtc);
    const newOpens: OpenPosition[] = [];
    const rejectionsByReason: Record<string, number> = {};
    const filled: Array<{ solved: SolvedCollar; plan: LiveCollarPlan }> = [];
    let rejected = 0;
    let summary = "";

    const finish = (outcome: string, s: string): LiveWindowResult => {
      saveWindowState({ lastAttemptDayUtc: window.dayUtc, lastAttemptTsMs: ctx.nowMs, lastOutcome: outcome }, paths.windowState);
      return { attempted: sides.length, newOpens, rejected, rejectionsByReason, summary: s };
    };

    // Pair atomicity on ABORT: unwind every already-filled collar of this window.
    const unwindFilled = async (reason: string): Promise<void> => {
      for (const f of filled) {
        const lm = newOpens.find((p) => p.ref === f.solved.ref)?.liveMeta;
        const putInstId = lm?.putInstId ?? (f.plan.protective.optType === "put" ? f.plan.protective.instId : f.plan.funding.instId);
        const callInstId = lm?.callInstId ?? (f.plan.protective.optType === "call" ? f.plan.protective.instId : f.plan.funding.instId);
        raiseLiveAlert({ tsMs: ctx.nowMs, level: "critical", code: "pair_abort_unwind", message: `unwinding ${f.solved.ref} (${reason}) — pair atomicity`, data: { ref: f.solved.ref } }, paths.alerts);
        const rep = await unwindLiveCollar(deps.client, { side: f.plan.side, putInstId, callInstId, contracts: f.plan.contracts, ctValBtc: f.plan.ctValBtc }, { spotUsd: ctx.spot, sleep: deps.sleep });
        appendLiveExecution(
          {
            tsMs: ctx.nowMs,
            dayUtc: window.dayUtc,
            ref: f.solved.ref,
            side: f.plan.side,
            outcome: "pair_sibling_unwound",
            mode: deps.client.mode,
            effectiveNotionalUsdc: 0,
            contracts: f.plan.contracts,
            putInstId,
            callInstId,
            netCreditUsdc: null,
            venueFeeUsdc: null,
            detail: rep
          },
          paths.executions
        );
        if (!rep.complete) {
          raiseLiveAlert({ tsMs: ctx.nowMs, level: "critical", code: "pair_unwind_incomplete", message: `pair unwind of ${f.solved.ref} INCOMPLETE (${rep.outcome}) — ${rep.notes.join("; ")}`, data: rep }, paths.alerts);
        }
      }
      // Nothing from this window stands.
      newOpens.length = 0;
      filled.length = 0;
    };

    let windowNotional = 0;
    for (const side of sides) {
      // 1) Strategy solve (existing EV/credit guardrails). A rejection SKIPS THE DAY — never force.
      const solvedRes = ctx.solveSide(side);
      if (!solvedRes.ok) {
        rejected += 1;
        rejectionsByReason[solvedRes.error] = (rejectionsByReason[solvedRes.error] ?? 0) + 1;
        raiseLiveAlert({ tsMs: ctx.nowMs, level: "warn", code: "solve_rejected", message: `side ${side} rejected by guardrails (${solvedRes.error}: ${solvedRes.message}) — DAY SKIPPED` }, paths.alerts);
        if (filled.length > 0) await unwindFilled(`sibling ${side} rejected: ${solvedRes.error}`);
        return finish("guardrail_skip", `guardrail rejection on ${side} (${solvedRes.error}) — day skipped`);
      }
      const solved = solvedRes.solved;

      // 2) Instrument mapping (fail-closed).
      const chainRes = await deps.client.getOptionChain("BTC-USD");
      if (!chainRes.ok) {
        raiseLiveAlert({ tsMs: ctx.nowMs, level: "warn", code: "chain_fetch_failed", message: "OKX option chain fetch failed — day skipped" }, paths.alerts);
        if (filled.length > 0) await unwindFilled("chain fetch failed for sibling");
        return finish("venue_error_skip", "chain fetch failed — day skipped");
      }
      const planRes = planLiveCollar(parseOkxChain(chainRes.data ?? []), {
        side,
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
      if (!planRes.ok) {
        rejected += 1;
        rejectionsByReason[planRes.error] = (rejectionsByReason[planRes.error] ?? 0) + 1;
        raiseLiveAlert({ tsMs: ctx.nowMs, level: "warn", code: "plan_failed", message: `instrument mapping failed on ${side} (${planRes.error}: ${planRes.message}) — day skipped` }, paths.alerts);
        if (filled.length > 0) await unwindFilled(`sibling plan failed: ${planRes.error}`);
        return finish("plan_skip", `instrument mapping failed (${planRes.error}) — day skipped`);
      }
      let plan = planRes.plan;

      // 3) Canary size override (Mon/Tue go/no-go: a tiny real collar through the FULL path).
      if (guards.canaryContracts != null) {
        const contracts = guards.canaryContracts;
        const contractsBtc = +(contracts * plan.ctValBtc).toFixed(6);
        plan = { ...plan, contracts, contractsBtc, effectiveNotionalUsdc: round2(contractsBtc * ctx.spot) };
      }

      // 4) Notional caps on the EFFECTIVE (rounded) notional.
      const caps = checkNotionalCaps(plan.effectiveNotionalUsdc, bookedToday + windowNotional, guards);
      if (!caps.ok) {
        raiseLiveAlert({ tsMs: ctx.nowMs, level: "warn", code: "notional_cap", message: `${caps.reason} — day skipped` }, paths.alerts);
        if (filled.length > 0) await unwindFilled(`sibling over cap: ${caps.reason}`);
        return finish("cap_skip", `notional cap: ${caps.reason}`);
      }

      // 5) Execute atomically.
      const clOrdPrefix = `al${ctx.nowMs.toString(36)}${side === "long" ? "L" : "S"}`;
      const exec = await executeLiveCollar(deps.client, plan, {
        bandPct: guards.slippageBandPct,
        fillTimeoutMs: deps.fillTimeoutMs,
        pollDelayMs: deps.pollDelayMs,
        spotUsd: ctx.spot,
        clOrdPrefix,
        sleep: deps.sleep
      });
      for (const a of exec.alerts) raiseLiveAlert({ tsMs: ctx.nowMs, level: a.includes("CRITICAL") ? "critical" : "warn", code: "execution", message: a }, paths.alerts);

      appendLiveExecution(
        {
          tsMs: ctx.nowMs,
          dayUtc: window.dayUtc,
          ref: solved.ref,
          side,
          outcome: exec.outcome === "filled" ? "filled" : exec.outcome,
          mode: deps.client.mode,
          effectiveNotionalUsdc: exec.outcome === "filled" ? plan.effectiveNotionalUsdc : 0,
          contracts: plan.contracts,
          putInstId: plan.protective.optType === "put" ? plan.protective.instId : plan.funding.instId,
          callInstId: plan.protective.optType === "call" ? plan.protective.instId : plan.funding.instId,
          netCreditUsdc: exec.netCreditUsdc,
          venueFeeUsdc: exec.venueFeeUsdc,
          detail: { protective: exec.protective, funding: exec.funding, unwind: exec.unwind, errors: exec.errors }
        } satisfies LiveExecutionRecord,
        paths.executions
      );

      if (exec.outcome !== "filled") {
        if (!exec.safe) {
          raiseLiveAlert({ tsMs: ctx.nowMs, level: "critical", code: "naked_leg", message: `NAKED LEG UNRESOLVED on ${solved.ref} — manual intervention required NOW`, data: exec }, paths.alerts);
        }
        if (filled.length > 0 && pairAtomic) await unwindFilled(`sibling ${side} did not fill (${exec.outcome})`);
        return finish(exec.safe ? "fill_failed_skip" : "NAKED_LEG", `execution ${exec.outcome} on ${side} — day skipped${pairAtomic && filled.length === 0 ? "" : " (pair unwound)"}`);
      }

      const pos = bookLivePosition(solved, plan, exec, ctx.nowMs, ctx.spot, deps.client.mode, clOrdPrefix);
      newOpens.push(pos);
      filled.push({ solved, plan });
      windowNotional += plan.effectiveNotionalUsdc;
      summary += `${side}: filled ${plan.contracts}×${plan.ctValBtc}BTC net $${exec.netCreditUsdc} (fees $${exec.venueFeeUsdc}); `;
    }

    return finish("filled", `window executed: ${summary.trim()}`);
  };

  const reconcileSettled = async (settledThisCycle: SettlementOutcome[]): Promise<void> => {
    const nowMs = Date.now();
    // This cycle's live settlements + previously pending ones (venue data lags the fixing).
    const targets = new Map<string, SettlementOutcome>();
    for (const s of settledThisCycle) if (s.venue === "okx_live" && s.liveMeta) targets.set(s.ref, s);
    const recons = loadLiveRecons(paths.recon);
    const latestByRef = new Map<string, { tsMs: number; status: string }>();
    for (const r of recons) {
      const prev = latestByRef.get(r.ref);
      if (!prev || r.tsMs >= prev.tsMs) latestByRef.set(r.ref, { tsMs: r.tsMs, status: r.status });
    }
    const pendingRefs = [...latestByRef.entries()].filter(([, v]) => v.status === "pending_venue_data").map(([ref]) => ref);
    if (pendingRefs.length > 0) {
      for (const s of loadSettlements(paths.settlements)) {
        if (pendingRefs.includes(s.ref) && s.venue === "okx_live" && s.liveMeta && !targets.has(s.ref)) targets.set(s.ref, s);
      }
    }
    if (targets.size === 0) return;

    const instIds = [...targets.values()].flatMap((s) => [s.liveMeta!.putInstId, s.liveMeta!.callInstId]);
    const venueData = await fetchOkxSettlementData(deps.client, instIds);
    for (const s of targets.values()) {
      const rec = reconcileLiveSettlement(s, venueData, { toleranceUsdc: reconTol, nowMs });
      appendLiveRecon(rec, paths.recon);
      if (rec.status === "mismatch") {
        raiseLiveAlert({ tsMs: nowMs, level: "critical", code: "recon_mismatch", message: `settlement reconciliation MISMATCH on ${s.ref} (cash diff ${rec.cashDiffUsdc}, tolerance ${rec.toleranceUsdc}) — issuance will halt`, data: rec }, paths.alerts);
      } else if (rec.status === "matched") {
        console.error(`[okx-live] recon ${s.ref}: MATCHED (venue cash ${rec.okxCashFlowUsdc}, basis ${rec.priceDiffUsd} USD)`);
      } else {
        console.error(`[okx-live] recon ${s.ref}: pending venue data — will retry`);
      }
    }
  };

  return { executeWindow, reconcileSettled };
};
