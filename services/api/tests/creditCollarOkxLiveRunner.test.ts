import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOkxLiveExecutionHook, type LiveVenueClient, type SolveSide } from "../src/singleSide/twoSided/creditCollar/execution/okxLiveRunner";
import { parseLiveGuardsFromEnv } from "../src/singleSide/twoSided/creditCollar/execution/liveGuards";
import { appendLiveRecon, loadLiveExecutions, loadLiveRecons, loadWindowState } from "../src/singleSide/twoSided/creditCollar/execution/liveExecutionStore";
import type { RegimeGateDecision } from "../src/singleSide/twoSided/creditCollar/regimeGate";

// ── Fixtures ──────────────────────────────────────────────────────────────────
const NOW = Date.UTC(2026, 6, 22, 8, 20, 0); // inside the 08:15–10:00 window
const EXPIRY = Date.UTC(2026, 6, 23, 8, 0, 0);
const SPOT = 100_000;

const gate = (regime: RegimeGateDecision["regime"]): RegimeGateDecision => ({
  regime,
  realizedMovePct: regime === "calm" ? 0.8 : regime === "elevated" ? 1.8 : 3.5,
  trailingMovePct: 0.8,
  liveMovePct: null,
  signalSource: "trailing",
  samples: 20,
  openMultiplier: regime === "calm" ? 1 : 0,
  floorPctOverride: regime === "calm" ? null : 0.1,
  reason: "test"
});

const rawChain = ["94000P", "98000P", "102000C", "106000C"].map((s) => {
  const strike = Number(s.slice(0, -1));
  const t = s.endsWith("C") ? "C" : "P";
  return { instId: `BTC-USD-260723-${strike}-${t}`, optType: t, stk: String(strike), expTime: String(EXPIRY), ctVal: "0.01", tickSz: "0.0001", lotSz: "1", minSz: "1", state: "live" };
});

type Behavior = { fill: number; px?: number; fee?: number; reject?: string };
const makeClient = (script: Record<string, Behavior[]>, unwindScript: Record<string, Behavior[]> = {}) => {
  const orders = new Map<string, { sz: number; b: Behavior; polls: number }>();
  const placed: Array<{ instId: string; side: string; ordType: string; sz: string; reduceOnly?: boolean }> = [];
  let seq = 0;
  const client: LiveVenueClient = {
    mode: "demo",
    placeOrder: async (o) => {
      placed.push({ instId: o.instId, side: o.side, ordType: o.ordType, sz: o.sz, reduceOnly: o.reduceOnly });
      const src = o.ordType === "market" ? unwindScript : script;
      const b = (src[o.instId] ?? []).shift() ?? { fill: 0 };
      if (b.reject) return { ok: false, code: "51000", msg: b.reject, data: [] };
      const ordId = `o${++seq}`;
      orders.set(ordId, { sz: Number(o.sz), b, polls: 0 });
      return { ok: true, code: "0", msg: "", data: [{ ordId }] };
    },
    getOrder: async (_i, ordId) => {
      const o = orders.get(ordId);
      if (!o) return { ok: false, data: [] };
      o.polls += 1;
      const filled = Math.min(o.b.fill, o.sz);
      if (filled >= o.sz) return { ok: true, data: [{ state: "filled", avgPx: String(o.b.px ?? 0), accFillSz: String(filled), fee: String(-(o.b.fee ?? 0)) }] };
      if (o.polls < 2) return { ok: true, data: [{ state: "live", accFillSz: "0" }] };
      return { ok: true, data: [{ state: "canceled", avgPx: filled > 0 ? String(o.b.px ?? 0) : undefined, accFillSz: String(filled), fee: String(-(o.b.fee ?? 0)) }] };
    },
    cancelOrder: async () => ({ ok: true, data: [] }),
    getBookTop: async (instId) => ({
      ok: true,
      data: [instId.endsWith("P") ? { asks: [["0.0013", "99"]], bids: [["0.0011", "99"]] } : { asks: [["0.0031", "99"]], bids: [["0.0028", "99"]] }]
    }),
    getPositions: async () => ({ ok: true, data: [] }),
    getOptionChain: async () => ({ ok: true, data: rawChain }),
    getDeliveryExerciseHistory: async () => ({ ok: true, data: [] }),
    getBills: async () => ({ ok: true, data: [] })
  };
  return { client, placed };
};

const solved = (side: "long" | "short") => ({
  ok: true as const,
  solved: {
    ref: `cc-live-${NOW}-${side}`,
    side,
    notionalUsdc: 50_000,
    putStrike: side === "long" ? 94_000 : 98_000,
    callStrike: side === "long" ? 102_000 : 106_000,
    foxifyCreditUsdc: 78,
    serviceFeeUsdc: 0,
    floorPctUsed: 0.06,
    protectiveLegMidUsdc: 60,
    fundingLegMidUsdc: 145
  }
});
const solveOk: SolveSide = (side) => solved(side);

const freshPaths = () => {
  const dir = mkdtempSync(join(tmpdir(), "live-runner-"));
  return { executions: join(dir, "exec.jsonl"), windowState: join(dir, "window.json"), alerts: join(dir, "alerts.jsonl"), recon: join(dir, "recon.jsonl"), settlements: join(dir, "settle.jsonl") };
};

const armedEnv = { LIVE_ENABLED: "true" };
const mkHook = (client: LiveVenueClient, paths: ReturnType<typeof freshPaths>, env: Record<string, string | undefined> = armedEnv) =>
  buildOkxLiveExecutionHook(env, { client, guards: parseLiveGuardsFromEnv(env), paths, fillTimeoutMs: 50, pollDelayMs: 1, sleep: async () => {} });

const ctx = (regime: "calm" | "elevated" | "halt") => ({ nowMs: NOW, spot: SPOT, regime: gate(regime), trendBias: "long" as const, solveSide: solveOk });

// ── Scenarios ─────────────────────────────────────────────────────────────────

test("runner: kill-switch off ⟹ no orders, window untouched", async () => {
  const paths = freshPaths();
  const { client, placed } = makeClient({});
  const hook = buildOkxLiveExecutionHook({}, { client, guards: parseLiveGuardsFromEnv({}), paths, sleep: async () => {} });
  const r = await hook.executeWindow(ctx("calm"));
  assert.equal(r.newOpens.length, 0);
  assert.equal(placed.length, 0);
  assert.ok(r.summary.includes("kill-switch"));
  assert.equal(loadWindowState(paths.windowState).lastAttemptDayUtc, null);
});

test("runner: outside the window ⟹ nothing (and no window consumption)", async () => {
  const paths = freshPaths();
  const { client, placed } = makeClient({});
  const hook = mkHook(client, paths);
  const r = await hook.executeWindow({ ...ctx("calm"), nowMs: Date.UTC(2026, 6, 22, 7, 0, 0) });
  assert.equal(placed.length, 0);
  assert.ok(r.summary.includes("window not due"));
});

test("runner: calm day executes the PAIR — both collars booked okx_live with real premiums", async () => {
  const paths = freshPaths();
  const { client } = makeClient({
    "BTC-USD-260723-94000-P": [{ fill: 50, px: 0.0013, fee: 0.00001 }],
    "BTC-USD-260723-102000-C": [{ fill: 50, px: 0.0028, fee: 0.00001 }],
    "BTC-USD-260723-106000-C": [{ fill: 50, px: 0.0012, fee: 0.00001 }],
    "BTC-USD-260723-98000-P": [{ fill: 50, px: 0.0026, fee: 0.00001 }]
  });
  const hook = mkHook(client, paths);
  const r = await hook.executeWindow(ctx("calm"));
  assert.equal(r.newOpens.length, 2);
  const long = r.newOpens.find((p) => p.side === "long")!;
  assert.equal(long.venue, "okx_live");
  assert.equal(long.putStrike, 94_000);
  assert.equal(long.callStrike, 102_000);
  assert.equal(long.expiresAtMs, EXPIRY);
  assert.equal(long.notionalUsdc, 50_000);
  assert.equal(long.protectiveLegPremiumUsdc, 65);   // 0.0013 × 0.5 × 100k
  assert.equal(long.fundingLegPremiumUsdc, 140);
  assert.equal(long.openFeeUsdc, 2);                  // 0.00002 BTC × 100k
  assert.equal(long.foxifyCreditUsdc, 140 - 65 - 2);  // REAL net credit
  assert.ok(long.liveMeta);
  assert.equal(long.liveMeta!.contracts, 50);
  const short = r.newOpens.find((p) => p.side === "short")!;
  assert.equal(short.putStrike, 98_000);
  assert.equal(short.callStrike, 106_000);
  // Ledger: 2 filled records; window consumed.
  const execs = loadLiveExecutions(paths.executions);
  assert.equal(execs.filter((e) => e.outcome === "filled").length, 2);
  assert.equal(loadWindowState(paths.windowState).lastOutcome, "filled");
});

test("runner: elevated day executes ONE directional single on the trend side", async () => {
  const paths = freshPaths();
  const { client } = makeClient({
    "BTC-USD-260723-94000-P": [{ fill: 50, px: 0.0013 }],
    "BTC-USD-260723-102000-C": [{ fill: 50, px: 0.0028 }]
  });
  const hook = mkHook(client, paths);
  const r = await hook.executeWindow(ctx("elevated"));
  assert.equal(r.newOpens.length, 1);
  assert.equal(r.newOpens[0].side, "long"); // trendBias
});

test("runner: halt regime ⟹ day skipped, window consumed", async () => {
  const paths = freshPaths();
  const { client, placed } = makeClient({});
  const hook = mkHook(client, paths);
  const r = await hook.executeWindow(ctx("halt"));
  assert.equal(placed.length, 0);
  assert.equal(r.newOpens.length, 0);
  assert.equal(loadWindowState(paths.windowState).lastOutcome, "halt_skip");
});

test("runner: guardrail rejection on the SECOND side unwinds the first collar (pair atomicity)", async () => {
  const paths = freshPaths();
  const { client, placed } = makeClient(
    {
      "BTC-USD-260723-94000-P": [{ fill: 50, px: 0.0013 }],
      "BTC-USD-260723-102000-C": [{ fill: 50, px: 0.0028 }]
    },
    {
      "BTC-USD-260723-94000-P": [{ fill: 50, px: 0.0012 }],
      "BTC-USD-260723-102000-C": [{ fill: 50, px: 0.0029 }]
    }
  );
  const solveSide: SolveSide = (side) => (side === "long" ? solved("long") : { ok: false, error: "ev_guardrail", message: "no" });
  const hook = mkHook(client, paths);
  const r = await hook.executeWindow({ ...ctx("calm"), solveSide });
  assert.equal(r.newOpens.length, 0); // NOTHING stands
  const unwinds = placed.filter((p) => p.ordType === "market" && p.reduceOnly);
  assert.equal(unwinds.length, 2); // both legs of collar 1 closed
  const execs = loadLiveExecutions(paths.executions);
  assert.ok(execs.some((e) => e.outcome === "pair_sibling_unwound"));
  assert.equal(loadWindowState(paths.windowState).lastOutcome, "guardrail_skip");
});

test("runner: second collar fill failure unwinds the first (both-or-neither at PAIR level)", async () => {
  const paths = freshPaths();
  const { client } = makeClient(
    {
      "BTC-USD-260723-94000-P": [{ fill: 50, px: 0.0013 }],
      "BTC-USD-260723-102000-C": [{ fill: 50, px: 0.0028 }],
      "BTC-USD-260723-106000-C": [{ fill: 0 }, { fill: 0 }], // short-side collar never fills
      "BTC-USD-260723-98000-P": [{ fill: 0 }, { fill: 0 }]
    },
    {
      "BTC-USD-260723-94000-P": [{ fill: 50, px: 0.0012 }],
      "BTC-USD-260723-102000-C": [{ fill: 50, px: 0.0029 }]
    }
  );
  const hook = mkHook(client, paths);
  const r = await hook.executeWindow(ctx("calm"));
  assert.equal(r.newOpens.length, 0);
  const execs = loadLiveExecutions(paths.executions);
  assert.ok(execs.some((e) => e.outcome === "aborted_no_fill"));
  assert.ok(execs.some((e) => e.outcome === "pair_sibling_unwound"));
});

test("runner: unresolved recon mismatch HALTS issuance (window consumed, alert raised)", async () => {
  const paths = freshPaths();
  appendLiveRecon(
    { tsMs: 1, ref: "old", putInstId: "P", callInstId: "C", ourSettlePriceUsd: 1, venueSettlePriceUsd: 1, priceDiffUsd: 0, ourPayoutUsdc: 10, venueCashFlowUsdc: 0, cashDiffUsdc: -10, toleranceUsdc: 5, status: "mismatch", notes: [] },
    paths.recon
  );
  const { client, placed } = makeClient({});
  const hook = mkHook(client, paths);
  const r = await hook.executeWindow(ctx("calm"));
  assert.equal(placed.length, 0);
  assert.ok(r.summary.includes("halted"));
  assert.equal(loadWindowState(paths.windowState).lastOutcome, "recon_halt_skip");
});

test("runner: canary contract override forces tiny size through the SAME full path", async () => {
  const paths = freshPaths();
  const { client, placed } = makeClient({
    "BTC-USD-260723-94000-P": [{ fill: 2, px: 0.0013 }],
    "BTC-USD-260723-102000-C": [{ fill: 2, px: 0.0028 }]
  });
  const env = { LIVE_ENABLED: "true", LIVE_CANARY_CONTRACTS: "2" };
  const hook = mkHook(client, paths, env);
  const r = await hook.executeWindow(ctx("elevated"));
  assert.equal(r.newOpens.length, 1);
  assert.equal(r.newOpens[0].liveMeta!.contracts, 2);
  assert.equal(r.newOpens[0].notionalUsdc, 2_000); // 2 × 0.01 BTC × 100k — honest effective notional
  assert.ok(placed.every((p) => p.sz === "2"));
});

test("runner: per-day notional cap skips the day", async () => {
  const paths = freshPaths();
  const { client, placed } = makeClient({});
  const env = { LIVE_ENABLED: "true", LIVE_MAX_DAY_NOTIONAL_USDC: "40000" }; // below one 50k position
  const hook = mkHook(client, paths, env);
  const r = await hook.executeWindow(ctx("elevated"));
  assert.equal(r.newOpens.length, 0);
  assert.equal(placed.filter((p) => p.ordType === "limit").length, 0);
  assert.equal(loadWindowState(paths.windowState).lastOutcome, "cap_skip");
});

test("runner: second attempt same day is refused (one window per day)", async () => {
  const paths = freshPaths();
  const { client } = makeClient({
    "BTC-USD-260723-94000-P": [{ fill: 50, px: 0.0013 }],
    "BTC-USD-260723-102000-C": [{ fill: 50, px: 0.0028 }]
  });
  const hook = mkHook(client, paths);
  await hook.executeWindow(ctx("elevated"));
  const r2 = await hook.executeWindow({ ...ctx("elevated"), nowMs: NOW + 10 * 60e3 });
  assert.equal(r2.newOpens.length, 0);
  assert.ok(r2.summary.includes("window not due"));
});

test("runner: reconcileSettled writes records and alerts on mismatch", async () => {
  const paths = freshPaths();
  const { client } = makeClient({});
  // Venue reports delivery at 93,050 but pays nothing on an ITM put ⟹ mismatch.
  client.getDeliveryExerciseHistory = async () => ({ ok: true, data: [{ ts: "1", details: [{ insId: "BTC-USD-260723-94000-P", px: "93050", type: "exercised" }] }] });
  client.getBills = async () => ({ ok: true, data: [{ instId: "BTC-USD-260723-94000-P", type: "3", subType: "170", balChg: "0", ts: "1" }] });
  const hook = mkHook(client, paths);
  await hook.reconcileSettled([
    {
      ref: "cc-live-x-long", side: "long", notionalUsdc: 50_000, spotAtEntry: 100_000, settlePriceUsd: 93_000, movePct: -0.07,
      putIntrinsicUsd: 500, callIntrinsicUsd: 0, payoutToFoxifyUsdc: 500, foxifyCreditUsdc: 70, netToFoxifyUsdc: 570, serviceFeeUsdc: 0,
      floorBreached: true, capBreached: false, oracleVerified: true, openedAtMs: 0, settledAtMs: 1, heldMs: 1,
      hedgeReceiptUsdc: 500, atticusOptionNetUsdc: 0, shortLegMarginUsdc: 0, capitalCostUsdc: 0, optionFeesUsdc: 2,
      atticusNetAfterCapitalUsdc: 0, atticusNetAfterFeesAndCapitalUsdc: 0, venue: "okx_live",
      liveMeta: { putInstId: "BTC-USD-260723-94000-P", callInstId: "BTC-USD-260723-102000-C", contracts: 50, ctValBtc: 0.01, mode: "live", protectiveFillPxBtc: 0.0013, fundingFillPxBtc: 0.0028, venueFeeUsdc: 2 }
    }
  ]);
  const recs = loadLiveRecons(paths.recon);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].status, "mismatch");
  // And the mismatch now halts the next window.
  const r = await hook.executeWindow({ ...ctx("calm"), nowMs: NOW + 24 * 3600e3 });
  assert.ok(r.summary.includes("halted"));
});
