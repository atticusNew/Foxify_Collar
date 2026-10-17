/**
 * LIVE window runner (venue-agnostic) — the one place where the validated auto-strategy output
 * becomes REAL orders, regardless of venue. The guarded brain lives here and is shared:
 *
 *   kill-switch → live-money confirm → window due (one attempt/day, never chase) → recon-mismatch
 *   halt → strategy (calm ⟹ pair · elevated ⟹ directional single · halt ⟹ skip) → EV/credit
 *   guardrails (a rejection SKIPS the day, never forces) → venue plan (fail-closed) → notional caps →
 *   venue execution → PAIR atomicity (collar 2 fails ⟹ collar 1 unwound).
 *
 * Venue specifics (instrument mapping, order/RFQ mechanics, unwind, settlement reconciliation) are
 * behind LiveVenueAdapter: OKX = CLOB legs with band-capped limits; FalconX = the collar as ONE
 * RFQ structure (atomic at the venue) with a band-checked quote acceptance.
 *
 * Filled collars book into the SAME open-positions ledger as the shadow (venue "<venue>_live",
 * REAL premiums/fees/credit, listed 08:00 UTC expiry) so they settle through the normal pipeline
 * and appear on /positions. Settled live positions reconcile against the venue's own settlement;
 * any mismatch halts further issuance.
 */

import type { PerpSide } from "../creditCollarPricer";
import type { OpenPosition, SettlementOutcome } from "../forwardSettlement";
import type { RegimeGateDecision } from "../regimeGate";
import type { LockDecision } from "../lockPolicy";
import { loadSettlements } from "../forwardSettlementStore";
import { latestDecisionForDay } from "./partnerDecisionStore";
import { appendPartnerSignal, daySignalEmitted, loadPartnerSignals } from "./partnerSignalStore";
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
  type LiveReconRecord
} from "./liveExecutionStore";
import { checkNotionalCaps, executionArmed, isWindowDue, type LiveGuardsConfig } from "./liveGuards";

const round2c = (x: number) => +x.toFixed(2);

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
  /** Venue place/fill errors from the last execute attempt (demo wrap surfaces these). */
  venueErrors?: string[];
};

export type WatcherUnwindResult = {
  ref: string;
  complete: boolean;              // hedge legs fully closed at the venue
  barrier: "floor" | "ceiling";
  barrierPriceUsd: number;
  vestedCreditUsdc: number;
};

export type LiveExecutionHook = {
  executeWindow: (ctx: LiveWindowContext) => Promise<LiveWindowResult>;
  reconcileSettled: (settledThisCycle: SettlementOutcome[]) => Promise<void>;
  /**
   * Touch handling — TWO decoupled halves:
   *   CLIENT: every confirmed touch emits the partner CLOSE SIGNAL immediately (deduped per ref) —
   *   the partner's exit at the line is contractual and never waits on our hedge economics.
   *   OURS: the watcher-permitted, budget-checked hedge unwind executes on its own schedule; a
   *   deferred/expensive unwind rides behind its wings and changes nothing for the partner.
   * Takes ALL touch decisions (permitted and deferred).
   */
  unwindOnWatcher: (open: OpenPosition[], decisions: LockDecision[], ctx: { nowMs: number; spot: number }) => Promise<WatcherUnwindResult[]>;
  /**
   * Partner perp CLOSED (position feed) ⟹ our hedge lost its client mirror and is now naked
   * exposure — unwind it MANDATORILY (no budget gate; the budget logic only applies while riding
   * is safe, i.e. while the client mirror exists). Returns the refs that are ours to conclude.
   */
  unwindForPartnerClose: (open: OpenPosition[], closedRefs: string[], ctx: { nowMs: number; spot: number }) => Promise<Array<{ ref: string; complete: boolean }>>;
};

// ── Venue adapter contract ────────────────────────────────────────────────────

export type VenuePlan = {
  effectiveNotionalUsdc: number;  // contract/qty-rounded — what the caps check
  handle: unknown;                // venue-private plan payload passed back to execute()
};

export type VenuePlanResult = { ok: true; plan: VenuePlan } | { ok: false; error: string; message: string };

export type VenueExecutionResult = {
  /** "filled" books pos; any other value = nothing stands. safe=false ⟹ CRITICAL (manual action). */
  outcome: "filled" | string;
  safe: boolean;
  pos?: OpenPosition;             // required when outcome === "filled"
  netCreditUsdc?: number | null;
  venueFeeUsdc?: number | null;
  contracts?: number;
  putInstId?: string | null;
  callInstId?: string | null;
  alerts?: string[];              // raised by the runner (CRITICAL when the string contains it)
  detail?: unknown;               // persisted to the executions ledger
};

export type LiveVenueAdapter = {
  /** e.g. "okx_live" / "falconx_live" — the venue tag on booked positions. */
  venueLabel: string;
  mode: "demo" | "live";
  /** Map a solved collar to venue instruments/size. Fail-closed. */
  plan: (solved: SolvedCollar, ctx: LiveWindowContext) => Promise<VenuePlanResult>;
  /** Execute atomically (both legs or neither — enforced by the venue or by unwind-on-partial). */
  execute: (solved: SolvedCollar, plan: VenuePlan, ctx: LiveWindowContext) => Promise<VenueExecutionResult>;
  /**
   * Unwind an already-booked position (pair-atomicity abort, or a watcher-permitted lock). When
   * `opts.maxCostUsdc` is set the venue must verify the REAL unwind cost (its quote / book top)
   * against that budget BEFORE executing — over budget ⟹ decline with `deferred: true` (the
   * position stays fully hedged and rides; the watcher re-evaluates next cycle).
   */
  unwindFilled: (pos: OpenPosition, ctx: LiveWindowContext, opts?: { maxCostUsdc?: number }) => Promise<{ complete: boolean; deferred?: boolean; notes: string[]; detail?: unknown }>;
  /** Reconcile settled live positions against the venue's own settlement data. */
  reconcileSettled: (targets: SettlementOutcome[], nowMs: number) => Promise<LiveReconRecord[]>;
};

export type LiveRunnerDeps = {
  adapter: LiveVenueAdapter;
  guards: LiveGuardsConfig;
  /**
   * Who makes the ELEVATED-day directional call. "partner" (pilot default): wait inside the daily
   * window for an explicit partner decision (take/pass via the partner-decision store); no decision
   * by window close ⟹ day skipped. "auto": legacy — trend signal decides (shadow/backtest behavior).
   */
  directionalDecisionMode?: "partner" | "auto";
  paths?: { executions?: string; windowState?: string; alerts?: string; recon?: string; settlements?: string; partnerDecisions?: string; partnerSignals?: string };
};

/** Build the live hook from a venue adapter. All the rails live here; the venue only trades. */
export const buildLiveExecutionHook = (deps: LiveRunnerDeps): LiveExecutionHook => {
  const { adapter, guards } = deps;
  const paths = deps.paths ?? {};

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
    const partnerMode = (deps.directionalDecisionMode ?? "partner") === "partner";
    const emitDaySignal = (intent: "pair" | "directional_proposal" | "no_open") => {
      if (partnerMode && !daySignalEmitted(window.dayUtc, paths.partnerSignals)) {
        appendPartnerSignal({ kind: "day_signal", tsMs: ctx.nowMs, dayUtc: window.dayUtc, regime, intent, trendSide: regime === "elevated" ? ctx.trendBias : null }, paths.partnerSignals);
      }
    };
    if (regime === "halt") {
      emitDaySignal("no_open"); // notice only — STRESS is always a pass, no ask
      saveWindowState({ lastAttemptDayUtc: window.dayUtc, lastAttemptTsMs: ctx.nowMs, lastOutcome: "halt_skip" }, paths.windowState);
      return none(`regime HALT (${ctx.regime?.reason ?? ""}) — day skipped`);
    }
    // The PARTNER speaks before anything opens (pilot default; "auto" = legacy trend-auto for
    // shadow/backtests). CALM needs their pair ACK (auto-confirm on their side, but a silent bot
    // must fail closed — we never lock hedges against a partner who can't open perps). ELEVATED
    // needs take/pass. No decision ⟹ the window is NOT consumed (they can decide until it closes;
    // a day that closes undecided is skipped by never-chase). The day_signal outbox record is what
    // their bot answers — transport (poll/webhook) is a separate skin.
    let directionalSide: PerpSide = ctx.trendBias;
    if (partnerMode) {
      const decision = latestDecisionForDay(window.dayUtc, paths.partnerDecisions);
      if (regime === "calm") {
        emitDaySignal("pair");
        if (!decision) return none(`calm: awaiting partner pair ACK (fail-closed — no ACK, no hedge)`);
        if (decision.action === "pass") {
          saveWindowState({ lastAttemptDayUtc: window.dayUtc, lastAttemptTsMs: ctx.nowMs, lastOutcome: "partner_pass_skip" }, paths.windowState);
          return none(`calm: partner passed — day skipped`);
        }
      } else {
        emitDaySignal("directional_proposal");
        if (!decision) return none(`elevated: awaiting partner directional decision (take/pass — window open until close)`);
        if (decision.action === "pass") {
          saveWindowState({ lastAttemptDayUtc: window.dayUtc, lastAttemptTsMs: ctx.nowMs, lastOutcome: "partner_pass_skip" }, paths.windowState);
          return none(`elevated: partner passed on today's directional — day skipped`);
        }
        if (decision.action === "confirm") {
          // A pair ACK is not a directional decision — keep waiting for an explicit take/pass.
          return none(`elevated: partner sent a calm ACK — need an explicit take/pass for a directional day`);
        }
        directionalSide = decision.side ?? ctx.trendBias;
      }
    }
    const sides: PerpSide[] = regime === "calm" ? ["long", "short"] : [directionalSide];
    const pairAtomic = sides.length === 2;

    // Consume the window FIRST (crash-safe: never a double window on restart).
    saveWindowState({ lastAttemptDayUtc: window.dayUtc, lastAttemptTsMs: ctx.nowMs, lastOutcome: "in_progress" }, paths.windowState);

    const bookedToday = bookedNotionalForDay(loadLiveExecutions(paths.executions), window.dayUtc);
    const newOpens: OpenPosition[] = [];
    const rejectionsByReason: Record<string, number> = {};
    let rejected = 0;
    let summary = "";

    const finish = (outcome: string, s: string, venueErrors?: string[]): LiveWindowResult => {
      saveWindowState({ lastAttemptDayUtc: window.dayUtc, lastAttemptTsMs: ctx.nowMs, lastOutcome: outcome }, paths.windowState);
      return { attempted: sides.length, newOpens, rejected, rejectionsByReason, summary: s, ...(venueErrors?.length ? { venueErrors } : {}) };
    };

    // Pair atomicity on ABORT: unwind every already-booked collar of this window.
    const unwindFilled = async (reason: string): Promise<void> => {
      for (const pos of newOpens) {
        raiseLiveAlert({ tsMs: ctx.nowMs, level: "critical", code: "pair_abort_unwind", message: `unwinding ${pos.ref} (${reason}) — pair atomicity`, data: { ref: pos.ref } }, paths.alerts);
        const rep = await adapter.unwindFilled(pos, ctx);
        appendLiveExecution(
          {
            tsMs: ctx.nowMs,
            dayUtc: window.dayUtc,
            ref: pos.ref,
            side: pos.side,
            outcome: "pair_sibling_unwound",
            mode: adapter.mode,
            effectiveNotionalUsdc: 0,
            contracts: pos.liveMeta?.contracts ?? 0,
            putInstId: pos.liveMeta?.putInstId ?? null,
            callInstId: pos.liveMeta?.callInstId ?? null,
            netCreditUsdc: null,
            venueFeeUsdc: null,
            detail: rep.detail ?? rep.notes
          },
          paths.executions
        );
        if (!rep.complete) {
          raiseLiveAlert({ tsMs: ctx.nowMs, level: "critical", code: "pair_unwind_incomplete", message: `pair unwind of ${pos.ref} INCOMPLETE — ${rep.notes.join("; ")}`, data: rep }, paths.alerts);
        }
      }
      newOpens.length = 0; // nothing from this window stands
    };

    let windowNotional = 0;
    for (const side of sides) {
      // 1) Strategy solve (existing EV/credit guardrails). A rejection SKIPS THE DAY — never force.
      const solvedRes = ctx.solveSide(side);
      if (!solvedRes.ok) {
        rejected += 1;
        rejectionsByReason[solvedRes.error] = (rejectionsByReason[solvedRes.error] ?? 0) + 1;
        raiseLiveAlert({ tsMs: ctx.nowMs, level: "warn", code: "solve_rejected", message: `side ${side} rejected by guardrails (${solvedRes.error}: ${solvedRes.message}) — DAY SKIPPED` }, paths.alerts);
        if (newOpens.length > 0) await unwindFilled(`sibling ${side} rejected: ${solvedRes.error}`);
        return finish("guardrail_skip", `guardrail rejection on ${side} (${solvedRes.error}) — day skipped`);
      }
      const solved = solvedRes.solved;

      // 2) Venue plan (instrument mapping / sizing). Fail-closed.
      const planRes = await adapter.plan(solved, ctx);
      if (!planRes.ok) {
        rejected += 1;
        rejectionsByReason[planRes.error] = (rejectionsByReason[planRes.error] ?? 0) + 1;
        raiseLiveAlert({ tsMs: ctx.nowMs, level: "warn", code: "plan_failed", message: `venue plan failed on ${side} (${planRes.error}: ${planRes.message}) — day skipped` }, paths.alerts);
        if (newOpens.length > 0) await unwindFilled(`sibling plan failed: ${planRes.error}`);
        return finish("plan_skip", `venue plan failed (${planRes.error}) — day skipped`);
      }
      const plan = planRes.plan;

      // 3) Notional caps on the EFFECTIVE (rounded) notional.
      const caps = checkNotionalCaps(plan.effectiveNotionalUsdc, bookedToday + windowNotional, guards);
      if (!caps.ok) {
        raiseLiveAlert({ tsMs: ctx.nowMs, level: "warn", code: "notional_cap", message: `${caps.reason} — day skipped` }, paths.alerts);
        if (newOpens.length > 0) await unwindFilled(`sibling over cap: ${caps.reason}`);
        return finish("cap_skip", `notional cap: ${caps.reason}`);
      }

      // 4) Execute atomically at the venue.
      const exec = await adapter.execute(solved, plan, ctx);
      for (const a of exec.alerts ?? []) {
        raiseLiveAlert({ tsMs: ctx.nowMs, level: a.includes("CRITICAL") ? "critical" : "warn", code: "execution", message: a }, paths.alerts);
      }
      appendLiveExecution(
        {
          tsMs: ctx.nowMs,
          dayUtc: window.dayUtc,
          ref: solved.ref,
          side,
          outcome: exec.outcome,
          mode: adapter.mode,
          effectiveNotionalUsdc: exec.outcome === "filled" ? plan.effectiveNotionalUsdc : 0,
          contracts: exec.contracts ?? 0,
          putInstId: exec.putInstId ?? null,
          callInstId: exec.callInstId ?? null,
          netCreditUsdc: exec.netCreditUsdc ?? null,
          venueFeeUsdc: exec.venueFeeUsdc ?? null,
          detail: exec.detail
        },
        paths.executions
      );

      if (exec.outcome !== "filled" || !exec.pos) {
        if (!exec.safe) {
          raiseLiveAlert({ tsMs: ctx.nowMs, level: "critical", code: "naked_leg", message: `UNSAFE EXECUTION STATE on ${solved.ref} (${exec.outcome}) — manual intervention required NOW`, data: exec.detail }, paths.alerts);
        }
        if (newOpens.length > 0 && pairAtomic) await unwindFilled(`sibling ${side} did not fill (${exec.outcome})`);
        const detail = exec.detail as { errors?: unknown } | undefined;
        const venueErrors = Array.isArray(detail?.errors) ? detail.errors.map((e) => String(e)) : [];
        return finish(
          exec.safe ? "fill_failed_skip" : "NAKED_LEG",
          `execution ${exec.outcome} on ${side} — day skipped${pairAtomic && newOpens.length === 0 ? "" : " (pair unwound)"}`,
          venueErrors
        );
      }

      newOpens.push(exec.pos);
      windowNotional += plan.effectiveNotionalUsdc;
      summary += `${side}: filled net $${exec.netCreditUsdc} (fees $${exec.venueFeeUsdc}); `;
    }

    // GREEN LIGHT: hedge locked FIRST, partner opens perps SECOND — never the other way around.
    // Final terms attached so their bot opens against exactly what was executed, not an estimate.
    appendPartnerSignal(
      {
        kind: "green_light",
        tsMs: ctx.nowMs,
        dayUtc: window.dayUtc,
        positions: newOpens.map((p) => ({ ref: p.ref, side: p.side, notionalUsdc: p.notionalUsdc, putStrike: p.putStrike, callStrike: p.callStrike, creditUsdc: p.foxifyCreditUsdc, expiresAtMs: p.expiresAtMs }))
      },
      paths.partnerSignals
    );

    return finish("filled", `window executed: ${summary.trim()}`);
  };

  const reconcileSettled = async (settledThisCycle: SettlementOutcome[]): Promise<void> => {
    const nowMs = Date.now();
    // This cycle's live settlements + previously pending ones (venue data can lag the fixing).
    const targets = new Map<string, SettlementOutcome>();
    for (const s of settledThisCycle) if (s.venue === adapter.venueLabel && s.liveMeta) targets.set(s.ref, s);
    const recons = loadLiveRecons(paths.recon);
    const latestByRef = new Map<string, { tsMs: number; status: string }>();
    for (const r of recons) {
      const prev = latestByRef.get(r.ref);
      if (!prev || r.tsMs >= prev.tsMs) latestByRef.set(r.ref, { tsMs: r.tsMs, status: r.status });
    }
    const pendingRefs = [...latestByRef.entries()].filter(([, v]) => v.status === "pending_venue_data").map(([ref]) => ref);
    if (pendingRefs.length > 0) {
      for (const s of loadSettlements(paths.settlements)) {
        if (pendingRefs.includes(s.ref) && s.venue === adapter.venueLabel && s.liveMeta && !targets.has(s.ref)) targets.set(s.ref, s);
      }
    }
    if (targets.size === 0) return;

    const records = await adapter.reconcileSettled([...targets.values()], nowMs);
    for (const rec of records) {
      appendLiveRecon(rec, paths.recon);
      if (rec.status === "mismatch") {
        raiseLiveAlert({ tsMs: nowMs, level: "critical", code: "recon_mismatch", message: `settlement reconciliation MISMATCH on ${rec.ref} (cash diff ${rec.cashDiffUsdc}, tolerance ${rec.toleranceUsdc}) — issuance will halt`, data: rec }, paths.alerts);
      } else if (rec.status === "matched") {
        console.error(`[live] recon ${rec.ref}: MATCHED (venue cash ${rec.venueCashFlowUsdc}, basis ${rec.priceDiffUsd} USD)`);
      } else {
        console.error(`[live] recon ${rec.ref}: pending venue data — will retry`);
      }
    }
  };

  // Minimal window context for venue unwinds (solveSide is never consulted on an unwind).
  const unwindCtx = (ctx: { nowMs: number; spot: number }): LiveWindowContext => ({
    nowMs: ctx.nowMs,
    spot: ctx.spot,
    regime: undefined,
    trendBias: "long",
    solveSide: () => ({ ok: false, error: "not_applicable", message: "unwind context has no solver" })
  });

  /**
   * Touch handling, decoupled. CLIENT half: every confirmed touch emits the partner CLOSE SIGNAL
   * immediately (deduped per ref across cycles) — their exit at the line is contractual and does
   * not wait on our hedge. OUR half: the watcher-permitted unwind runs budget-checked against the
   * real venue price; expensive ⟹ the hedge rides behind its wings — invisible to the partner.
   */
  const unwindOnWatcher = async (open: OpenPosition[], decisions: LockDecision[], ctx: { nowMs: number; spot: number }): Promise<WatcherUnwindResult[]> => {
    const results: WatcherUnwindResult[] = [];
    if (decisions.length === 0) return results;
    const byRef = new Map(open.map((p) => [p.ref, p]));
    const alreadySignaled = new Set(
      loadPartnerSignals(paths.partnerSignals)
        .filter((s) => s.kind === "close_signal")
        .map((s) => (s.kind === "close_signal" ? s.ref : ""))
    );
    for (const d of decisions) {
      const pos = byRef.get(d.ref);
      if (!pos || pos.venue !== adapter.venueLabel || !pos.liveMeta) continue; // only OUR live positions
      const barrierPrice = d.barrier === "floor" ? pos.putStrike : pos.callStrike;

      // ── CLIENT: the touch itself triggers the mandatory close signal — once, unconditionally.
      if (!alreadySignaled.has(pos.ref)) {
        alreadySignaled.add(pos.ref);
        appendPartnerSignal(
          { kind: "close_signal", tsMs: ctx.nowMs, ref: pos.ref, side: pos.side, barrier: d.barrier, barrierPriceUsd: barrierPrice, vestedCreditUsdc: d.vestedCreditUsdc },
          paths.partnerSignals
        );
        raiseLiveAlert(
          {
            tsMs: ctx.nowMs,
            level: "warn",
            code: "close_signal",
            message: `CLOSE SIGNAL ${pos.ref}: ${d.barrier} touched @ $${barrierPrice} — partner must close the perp within the SLA; earned credit $${d.vestedCreditUsdc} concludes at the line. (Our hedge is handled separately.)`,
            data: d
          },
          paths.alerts
        );
      }

      // ── OURS: watcher-permitted, budget-checked hedge unwind. Not permitted ⟹ ride (no action).
      if (!d.permitted) continue;
      // Budget for the REAL unwind (venue quote/book, not the model): the unvested credit minus the
      // policy buffer — recoverable from the decision as modelCost + headroom. Over budget ⟹ the
      // venue declines (deferred) and the hedge rides behind its wings; never lock at a loss.
      const maxCostUsdc = d.unwindCostUsdc + d.headroomUsdc;
      const rep = await adapter.unwindFilled(pos, unwindCtx(ctx), { maxCostUsdc });
      appendLiveExecution(
        {
          tsMs: ctx.nowMs,
          dayUtc: new Date(ctx.nowMs).toISOString().slice(0, 10),
          ref: pos.ref,
          side: pos.side,
          outcome: rep.complete ? "watcher_unwound" : rep.deferred ? "watcher_unwind_deferred_budget" : "watcher_unwind_incomplete",
          mode: adapter.mode,
          effectiveNotionalUsdc: 0,
          contracts: pos.liveMeta?.contracts ?? 0,
          putInstId: pos.liveMeta?.putInstId ?? null,
          callInstId: pos.liveMeta?.callInstId ?? null,
          netCreditUsdc: null,
          venueFeeUsdc: null,
          detail: { decision: d, maxCostUsdc, unwind: rep.detail ?? rep.notes }
        },
        paths.executions
      );
      if (rep.deferred) {
        raiseLiveAlert({ tsMs: ctx.nowMs, level: "warn", code: "watcher_unwind_deferred", message: `hedge unwind of ${pos.ref} DEFERRED — real unwind cost exceeded budget $${round2c(maxCostUsdc)} (${rep.notes.join("; ")}) — hedge rides behind its wings (client outcome unaffected)`, data: rep }, paths.alerts);
      } else if (!rep.complete) {
        raiseLiveAlert({ tsMs: ctx.nowMs, level: "critical", code: "watcher_unwind_incomplete", message: `hedge unwind of ${pos.ref} INCOMPLETE — ${rep.notes.join("; ")} — manual action required`, data: rep }, paths.alerts);
      }
      results.push({ ref: pos.ref, complete: rep.complete, barrier: d.barrier, barrierPriceUsd: barrierPrice, vestedCreditUsdc: d.vestedCreditUsdc });
    }
    return results;
  };

  /**
   * Partner perp closed (position feed) ⟹ the client mirror is gone and our hedge is naked
   * exposure. Unwind MANDATORILY — no budget gate: the ride-safely economics only exist while the
   * client side mirrors us. Incomplete unwinds escalate critical; the client conclusion proceeds
   * regardless (their perp being closed is a fact, not a request).
   */
  const unwindForPartnerClose = async (open: OpenPosition[], closedRefs: string[], ctx: { nowMs: number; spot: number }): Promise<Array<{ ref: string; complete: boolean }>> => {
    const out: Array<{ ref: string; complete: boolean }> = [];
    const closed = new Set(closedRefs);
    for (const pos of open) {
      if (!closed.has(pos.ref) || pos.venue !== adapter.venueLabel || !pos.liveMeta) continue;
      raiseLiveAlert(
        { tsMs: ctx.nowMs, level: "warn", code: "partner_close_unwind", message: `partner perp on ${pos.ref} is CLOSED — hedge lost its mirror; unwinding now (mandatory, no budget gate)` },
        paths.alerts
      );
      const rep = await adapter.unwindFilled(pos, unwindCtx(ctx)); // no maxCostUsdc — mandatory
      appendLiveExecution(
        {
          tsMs: ctx.nowMs,
          dayUtc: new Date(ctx.nowMs).toISOString().slice(0, 10),
          ref: pos.ref,
          side: pos.side,
          outcome: rep.complete ? "partner_close_unwound" : "partner_close_unwind_incomplete",
          mode: adapter.mode,
          effectiveNotionalUsdc: 0,
          contracts: pos.liveMeta?.contracts ?? 0,
          putInstId: pos.liveMeta?.putInstId ?? null,
          callInstId: pos.liveMeta?.callInstId ?? null,
          netCreditUsdc: null,
          venueFeeUsdc: null,
          detail: rep.detail ?? rep.notes
        },
        paths.executions
      );
      if (!rep.complete) {
        raiseLiveAlert({ tsMs: ctx.nowMs, level: "critical", code: "partner_close_unwind_incomplete", message: `mandatory unwind of ${pos.ref} INCOMPLETE — ${rep.notes.join("; ")} — naked hedge risk, manual action required NOW`, data: rep }, paths.alerts);
      }
      out.push({ ref: pos.ref, complete: rep.complete });
    }
    return out;
  };

  return { executeWindow, reconcileSettled, unwindOnWatcher, unwindForPartnerClose };
};
