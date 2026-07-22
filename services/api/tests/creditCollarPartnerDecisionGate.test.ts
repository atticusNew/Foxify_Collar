import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLiveExecutionHook,
  type LiveVenueAdapter,
  type LiveWindowContext,
  type SolvedCollar
} from "../src/singleSide/twoSided/creditCollar/execution/liveWindowRunner";
import { parseLiveGuardsFromEnv } from "../src/singleSide/twoSided/creditCollar/execution/liveGuards";
import { loadLiveAlerts, loadLiveExecutions, loadWindowState } from "../src/singleSide/twoSided/creditCollar/execution/liveExecutionStore";
import { appendPartnerDecision, latestDecisionForDay } from "../src/singleSide/twoSided/creditCollar/execution/partnerDecisionStore";
import { settleAtBarrier, type OpenPosition } from "../src/singleSide/twoSided/creditCollar/forwardSettlement";
import type { LockDecision } from "../src/singleSide/twoSided/creditCollar/lockPolicy";
import type { RegimeGateDecision } from "../src/singleSide/twoSided/creditCollar/regimeGate";
import type { PerpSide } from "../src/singleSide/twoSided/creditCollar/creditCollarPricer";

const NOW = Date.UTC(2026, 6, 22, 8, 20, 0); // inside the 08:15–10:00 window
const DAY = "2026-07-22";
const EXPIRY = Date.UTC(2026, 6, 23, 8, 0, 0);
const SPOT = 100_000;

const gate = (regime: RegimeGateDecision["regime"]): RegimeGateDecision => ({
  regime,
  realizedMovePct: 1.8,
  trailingMovePct: 1.8,
  liveMovePct: null,
  signalSource: "trailing",
  samples: 20,
  openMultiplier: regime === "calm" ? 1 : 0,
  floorPctOverride: regime === "calm" ? null : 0.06,
  reason: "test"
});

const solved = (side: PerpSide): SolvedCollar => ({
  ref: `cc-${side}`,
  side,
  notionalUsdc: 50_000,
  putStrike: side === "long" ? 94_000 : 98_000,
  callStrike: side === "long" ? 102_000 : 106_000,
  foxifyCreditUsdc: 80,
  serviceFeeUsdc: 0,
  floorPctUsed: 0.06,
  protectiveLegMidUsdc: 60,
  fundingLegMidUsdc: 145
});

const livePos = (side: PerpSide, over: Partial<OpenPosition> = {}): OpenPosition => ({
  ref: `cc-${side}`,
  side,
  notionalUsdc: 50_000,
  spotAtEntry: SPOT,
  putStrike: side === "long" ? 94_000 : 98_000,
  callStrike: side === "long" ? 102_000 : 106_000,
  foxifyCreditUsdc: 80,
  serviceFeeUsdc: 0,
  floorPctUsed: 0.06,
  openedAtMs: NOW - 6 * 3_600_000,
  expiresAtMs: EXPIRY,
  venue: "fake_live",
  liveMeta: { putInstId: "P", callInstId: "C", contracts: 50, ctValBtc: 0.01, mode: "demo", protectiveFillPxBtc: 0.001, fundingFillPxBtc: 0.002, venueFeeUsdc: 2 },
  ...over
});

/** Fake venue: fills everything, records what it was asked to trade/unwind. */
const makeAdapter = () => {
  const executedSides: PerpSide[] = [];
  const unwoundRefs: string[] = [];
  const adapter: LiveVenueAdapter = {
    venueLabel: "fake_live",
    mode: "demo",
    plan: async (s: SolvedCollar) => ({ ok: true, plan: { effectiveNotionalUsdc: s.notionalUsdc, handle: {} } }),
    execute: async (s: SolvedCollar, _p, ctx: LiveWindowContext) => {
      executedSides.push(s.side);
      return { outcome: "filled", safe: true, pos: livePos(s.side, { openedAtMs: ctx.nowMs }), netCreditUsdc: 80, venueFeeUsdc: 2, contracts: 50, putInstId: "P", callInstId: "C" };
    },
    unwindFilled: async (pos) => {
      unwoundRefs.push(pos.ref);
      return { complete: true, notes: ["unwound"] };
    },
    reconcileSettled: async () => []
  };
  return { adapter, executedSides, unwoundRefs };
};

const freshPaths = () => {
  const dir = mkdtempSync(join(tmpdir(), "partner-gate-"));
  return {
    executions: join(dir, "exec.jsonl"),
    windowState: join(dir, "window.json"),
    alerts: join(dir, "alerts.jsonl"),
    recon: join(dir, "recon.jsonl"),
    settlements: join(dir, "settle.jsonl"),
    partnerDecisions: join(dir, "decisions.jsonl")
  };
};

const guards = parseLiveGuardsFromEnv({ LIVE_ENABLED: "true" });
const ctx = (regime: "calm" | "elevated"): LiveWindowContext => ({
  nowMs: NOW,
  spot: SPOT,
  regime: gate(regime),
  trendBias: "long",
  solveSide: (side) => ({ ok: true, solved: solved(side) })
});

// ── Partner decision gate ─────────────────────────────────────────────────────

test("partner mode: elevated with NO decision ⟹ nothing opens and the window is NOT consumed (they can still decide)", async () => {
  const paths = freshPaths();
  const { adapter, executedSides } = makeAdapter();
  const hook = buildLiveExecutionHook({ adapter, guards, directionalDecisionMode: "partner", paths });
  const r1 = await hook.executeWindow(ctx("elevated"));
  assert.equal(r1.newOpens.length, 0);
  assert.ok(r1.summary.includes("awaiting partner"));
  assert.equal(executedSides.length, 0);
  assert.equal(loadWindowState(paths.windowState).lastAttemptDayUtc, null, "window not consumed");
  // Later in the same window, a decision arrives ⟹ the SAME day still executes.
  appendPartnerDecision({ dayUtc: DAY, action: "take", side: "short", decidedAtIso: new Date(NOW).toISOString(), source: "cli" }, paths.partnerDecisions);
  const r2 = await hook.executeWindow({ ...ctx("elevated"), nowMs: NOW + 20 * 60e3 });
  assert.equal(r2.newOpens.length, 1);
  assert.equal(r2.newOpens[0].side, "short", "partner's side wins over the trend signal");
  assert.equal(loadWindowState(paths.windowState).lastOutcome, "filled");
});

test("partner mode: 'pass' consumes the window and skips the day", async () => {
  const paths = freshPaths();
  const { adapter, executedSides } = makeAdapter();
  appendPartnerDecision({ dayUtc: DAY, action: "pass", side: null, decidedAtIso: new Date(NOW).toISOString(), source: "cli" }, paths.partnerDecisions);
  const hook = buildLiveExecutionHook({ adapter, guards, directionalDecisionMode: "partner", paths });
  const r = await hook.executeWindow(ctx("elevated"));
  assert.equal(r.newOpens.length, 0);
  assert.equal(executedSides.length, 0);
  assert.equal(loadWindowState(paths.windowState).lastOutcome, "partner_pass_skip");
});

test("partner mode: 'take' without a side defers to the trend signal; calm days are untouched by the gate", async () => {
  const paths = freshPaths();
  const { adapter } = makeAdapter();
  appendPartnerDecision({ dayUtc: DAY, action: "take", side: null, decidedAtIso: new Date(NOW).toISOString(), source: "cli" }, paths.partnerDecisions);
  const hook = buildLiveExecutionHook({ adapter, guards, directionalDecisionMode: "partner", paths });
  const r = await hook.executeWindow(ctx("elevated"));
  assert.equal(r.newOpens.length, 1);
  assert.equal(r.newOpens[0].side, "long", "trendBias used when the partner leaves the side to us");

  const paths2 = freshPaths();
  const { adapter: a2 } = makeAdapter();
  const hook2 = buildLiveExecutionHook({ adapter: a2, guards, directionalDecisionMode: "partner", paths: paths2 });
  const rCalm = await hook2.executeWindow(ctx("calm"));
  assert.equal(rCalm.newOpens.length, 2, "calm pair needs no partner decision");
});

test("auto mode: elevated trades the trend side with no decision (legacy/backtest behavior)", async () => {
  const paths = freshPaths();
  const { adapter } = makeAdapter();
  const hook = buildLiveExecutionHook({ adapter, guards, directionalDecisionMode: "auto", paths });
  const r = await hook.executeWindow(ctx("elevated"));
  assert.equal(r.newOpens.length, 1);
  assert.equal(r.newOpens[0].side, "long");
});

test("decision store: the LATEST record for a day wins (partner can revise until executed)", () => {
  const paths = freshPaths();
  appendPartnerDecision({ dayUtc: DAY, action: "pass", side: null, decidedAtIso: "t1", source: "cli" }, paths.partnerDecisions);
  appendPartnerDecision({ dayUtc: DAY, action: "take", side: "short", decidedAtIso: "t2", source: "cli" }, paths.partnerDecisions);
  const d = latestDecisionForDay(DAY, paths.partnerDecisions);
  assert.equal(d?.action, "take");
  assert.equal(d?.side, "short");
});

// ── Watcher-driven unwind ─────────────────────────────────────────────────────

const lockDecision = (ref: string, over: Partial<LockDecision> = {}): LockDecision => ({
  ref,
  barrier: "ceiling",
  vestedCreditUsdc: 20,
  unvestedCreditUsdc: 60,
  unwindCostUsdc: 15,
  permitted: true,
  headroomUsdc: 45,
  netIfLockedUsdc: 65,
  payoutToFoxifyIfLockedUsdc: 20,
  lockEtaMs: 0,
  ...over
});

test("watcher unwind: a permitted lock unwinds the live position immediately and raises the CLOSE SIGNAL", async () => {
  const paths = freshPaths();
  const { adapter, unwoundRefs } = makeAdapter();
  const hook = buildLiveExecutionHook({ adapter, guards, paths });
  const pos = livePos("long");
  const results = await hook.unwindOnWatcher([pos], [lockDecision(pos.ref)], { nowMs: NOW, spot: 102_000 });
  assert.equal(results.length, 1);
  assert.equal(results[0].complete, true);
  assert.equal(results[0].barrierPriceUsd, 102_000);
  assert.equal(unwoundRefs[0], pos.ref);
  const execs = loadLiveExecutions(paths.executions);
  assert.ok(execs.some((e) => e.ref === pos.ref && e.outcome === "watcher_unwound"));
  const alerts = loadLiveAlerts(paths.alerts);
  assert.ok(alerts.some((a) => a.code === "close_signal" && a.message.includes(pos.ref)), "partner close signal raised in the same moment");
});

test("watcher unwind: ignores positions that are not ours (other venue / no liveMeta)", async () => {
  const paths = freshPaths();
  const { adapter, unwoundRefs } = makeAdapter();
  const hook = buildLiveExecutionHook({ adapter, guards, paths });
  const paper = livePos("long", { ref: "paper-1", venue: "okx_model", liveMeta: undefined });
  const results = await hook.unwindOnWatcher([paper], [lockDecision("paper-1")], { nowMs: NOW, spot: 102_000 });
  assert.equal(results.length, 0);
  assert.equal(unwoundRefs.length, 0);
});

// ── Barrier settlement ────────────────────────────────────────────────────────

test("settleAtBarrier: the collar dies at the line — zero option payout, vested credit only, tagged watcher_unwind", () => {
  const pos = livePos("long");
  const s = settleAtBarrier(pos, "ceiling", NOW, 20);
  assert.equal(s.settlePriceUsd, pos.callStrike);
  assert.equal(s.payoutToFoxifyUsdc, 0, "touched leg has zero intrinsic exactly at the line");
  assert.equal(s.foxifyCreditUsdc, 20, "partner keeps the VESTED credit");
  assert.equal(s.netToFoxifyUsdc, 20);
  assert.equal(s.closedBy, "watcher_unwind");
  assert.equal(s.liveMeta, undefined, "no liveMeta ⟹ expiry reconciliation will not flag the early close");
  assert.equal(s.capBreached, false);
  assert.ok(s.heldMs > 0 && s.settledAtMs === NOW);
  // Vested credit can never exceed the full credit.
  const clamped = settleAtBarrier(pos, "floor", NOW, 999);
  assert.equal(clamped.foxifyCreditUsdc, 80);
  assert.equal(clamped.settlePriceUsd, pos.putStrike);
});
