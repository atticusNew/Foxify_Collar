import assert from "node:assert/strict";
import test from "node:test";

import type { LiveExecClient } from "../src/singleSide/twoSided/creditCollar/execution/okxLiveCollarExecutor";
import {
  DEFAULT_UNWIND_QUEUE,
  applyRecycle,
  passiveDecision,
  passivePxBtc,
  planUnwindJob,
  realizedUsdc,
  recyclePlan,
  stepUnwindJob,
  summarizeUnwindQueue,
  unwindQueueConfigFromEnv,
  type UnwindJob,
} from "../src/singleSide/twoSided/creditCollar/execution/unwindQueue";

const T0 = Date.UTC(2026, 8, 21, 12);
const SPOT = 81_200;
const FLOOR = "BTC-USD-260925-75500-P";
const CAP = "BTC-USD-260925-85000-C";

test("unwind queue: config from env — off by default, flag on, junk keeps defaults", () => {
  assert.deepEqual(unwindQueueConfigFromEnv({}), DEFAULT_UNWIND_QUEUE);
  assert.equal(DEFAULT_UNWIND_QUEUE.enabled, false, "flag-guarded: the previous path runs unless EP_UNWIND_QUEUE=1");
  const c = unwindQueueConfigFromEnv({ EP_UNWIND_QUEUE: "1", EP_UNWIND_PASSIVE_MS: "120000", EP_UNWIND_REPRICE_TICKS: "3", EP_UNWIND_IOC_ATTEMPTS: "2" });
  assert.equal(c.enabled, true);
  assert.equal(c.passiveMs, 120_000);
  assert.equal(c.repriceTicks, 3);
  assert.equal(c.maxIocAttempts, 2);
  const junk = unwindQueueConfigFromEnv({ EP_UNWIND_QUEUE: "maybe", EP_UNWIND_PASSIVE_MS: "soon", EP_UNWIND_REPRICE_TICKS: "0" });
  assert.equal(junk.enabled, false);
  assert.equal(junk.passiveMs, DEFAULT_UNWIND_QUEUE.passiveMs);
  assert.equal(junk.repriceTicks, 1, "at least one tick");
});

test("unwind queue: the passive price is the mid on a tick and never crosses, for a buy or a sell", () => {
  assert.equal(passivePxBtc("buy", { bidBtc: 0.001, askBtc: 0.0014 }), 0.0012);
  assert.equal(passivePxBtc("sell", { bidBtc: 0.001, askBtc: 0.0014 }), 0.0012);
  assert.equal(passivePxBtc("buy", { bidBtc: 0.001, askBtc: 0.0011 }), 0.001, "one-tick spread: a buy sits on the bid");
  assert.equal(passivePxBtc("sell", { bidBtc: 0.001, askBtc: 0.0011 }), 0.0011, "one-tick spread: a sell sits on the ask");
  assert.equal(passivePxBtc("buy", { bidBtc: 0.00105, askBtc: 0.0011 }), 0.001, "an off-tick mid floors under the ask for a buy");
  assert.equal(passivePxBtc("sell", { bidBtc: 0.00105, askBtc: 0.0011 }), 0.0011, "and ceils over the bid for a sell");
  assert.equal(passivePxBtc("buy", { bidBtc: null, askBtc: 0.0014 }), 0.0013, "no bid: one tick under the ask");
  assert.equal(passivePxBtc("sell", { bidBtc: 0.001, askBtc: null }), 0.0011, "no ask: one tick over the bid");
  assert.equal(passivePxBtc("buy", { bidBtc: 0.001, askBtc: null }), null, "a buy with no ask rests nothing");
  assert.equal(passivePxBtc("sell", { bidBtc: null, askBtc: 0.0014 }), null, "a sell with no bid rests nothing");
});

const job = (over: Partial<Parameters<typeof planUnwindJob>[0]> = {}): UnwindJob =>
  planUnwindJob({ wrapId: "w1", account: "0xabc", nowMs: T0, spotUsd: SPOT, mtmValueUsdc: 40, floorInstId: FLOOR, capInstId: CAP, contracts: 3, cappedContracts: 3, cfg: DEFAULT_UNWIND_QUEUE, ...over })!;

test("unwind queue: the plan sells the floor leg and buys back what is still capped; a released cap has no buy leg", () => {
  const j = job();
  assert.deepEqual(j.legs.map((l) => [l.instId, l.action, l.contracts]), [[FLOOR, "sell", 3], [CAP, "buy", 3]]);
  assert.equal(j.phase, "passive");
  assert.equal(j.passiveUntilMs, T0 + DEFAULT_UNWIND_QUEUE.passiveMs);
  assert.equal(j.receipts[0].kind, "queued");
  assert.match(j.receipts[0].note, /trader settled at the book \(\$40\)/);
  const released = job({ cappedContracts: 0 });
  assert.deepEqual(released.legs.map((l) => l.action), ["sell"]);
  assert.equal(planUnwindJob({ wrapId: "w", account: "a", nowMs: T0, spotUsd: SPOT, mtmValueUsdc: null, floorInstId: null, capInstId: null, contracts: 3, cappedContracts: 3, cfg: DEFAULT_UNWIND_QUEUE }), null, "no legs, no job");
});

test("unwind queue: passive decision — rest at the mid, hold inside the reprice band, replace when the mid walks, nothing against an empty side", () => {
  const j = job();
  const floor = j.legs[0];
  const book = { bidBtc: 0.001, askBtc: 0.0014 };
  assert.deepEqual(passiveDecision(floor, book, DEFAULT_UNWIND_QUEUE), { kind: "rest", pxBtc: 0.0012, contracts: 3, reason: "rest sell 3 at the mid 0.0012" });
  assert.equal(passiveDecision(floor, { bidBtc: null, askBtc: 0.0014 }, DEFAULT_UNWIND_QUEUE).kind, "none", "a sell with no bid");
  assert.equal(passiveDecision(floor, null, DEFAULT_UNWIND_QUEUE).kind, "none", "no book read");
  floor.working = { ordId: "o1", pxBtc: 0.0012, contracts: 3, restedAtMs: T0, filledSeen: 0 };
  assert.equal(passiveDecision(floor, book, DEFAULT_UNWIND_QUEUE).kind, "hold");
  assert.equal(passiveDecision(floor, { bidBtc: 0.001, askBtc: 0.0015 }, DEFAULT_UNWIND_QUEUE).kind, "hold", "one tick is inside the band");
  const rep = passiveDecision(floor, { bidBtc: 0.0012, askBtc: 0.0018 }, DEFAULT_UNWIND_QUEUE);
  assert.equal(rep.kind, "replace");
  assert.equal((rep as { pxBtc: number }).pxBtc, 0.0015);
  floor.filledContracts = 3;
  assert.equal(passiveDecision(floor, book, DEFAULT_UNWIND_QUEUE).kind, "none", "flat leg");
});

test("unwind queue: recycle is full-or-nothing per wrap, opposite side on the same instrument, fills at the mid with no fee, and finishes the job when it empties", () => {
  const j = job();
  const jobs = new Map([[j.id, j]]);
  const needs = [{ instId: FLOOR, action: "buy" as const, contracts: 3 }, { instId: CAP, action: "sell" as const, contracts: 3 }];
  const plan = recyclePlan(jobs.values(), needs);
  assert.deepEqual(plan, [{ jobId: j.id, instId: FLOOR, contracts: 3 }, { jobId: j.id, instId: CAP, contracts: 3 }]);
  assert.equal(recyclePlan(jobs.values(), [{ instId: FLOOR, action: "buy", contracts: 4 }, needs[1]]), null, "more lots than the queue holds: nothing");
  assert.equal(recyclePlan(jobs.values(), [{ instId: FLOOR, action: "sell", contracts: 3 }]), null, "same side: nothing to net");
  assert.equal(recyclePlan(jobs.values(), [{ instId: "BTC-USD-260925-76000-P", action: "buy", contracts: 3 }]), null, "another strike: nothing");
  assert.equal(recyclePlan(jobs.values(), []), null);
  j.legs[0].working = { ordId: "o", pxBtc: 0.0012, contracts: 3, restedAtMs: T0, filledSeen: 0 };
  assert.equal(recyclePlan(jobs.values(), needs), null, "a leg with an order resting is not recycled (it would double-fill)");
  j.legs[0].working = null;

  applyRecycle(jobs, plan!, { [FLOOR]: 0.0012, [CAP]: 0.003 }, "w2", T0 + 1000);
  assert.equal(j.phase, "done");
  assert.equal(j.legs[0].filledContracts, 3);
  assert.equal(j.legs[0].avgPxBtc, 0.0012);
  assert.equal(j.legs[0].feeUsdc, 0, "no fee on a transfer");
  // sells 3 × 0.01 × 81200 × 0.0012 = $2.92; buys 3 × 0.01 × 81200 × 0.003 = $7.31 → −4.38
  assert.equal(j.realizedUsdc, realizedUsdc(j));
  assert.equal(j.realizedUsdc, -4.38);
  assert.equal(j.executionEdgeUsdc, -44.38, "against a $40 MTM the trader was settled at");
  assert.deepEqual(j.receipts.map((r) => r.kind), ["queued", "recycled", "recycled", "done"]);
  const s = summarizeUnwindQueue(jobs.values());
  assert.equal(s.recycledContracts, 6);
  assert.equal(s.done, 1);
});

// ── a fake venue for the stepper ──────────────────────────────────────────────

type Order = { instId: string; side: string; px: number; sz: number; acc: number; state: string };
const venue = () => {
  const orders = new Map<string, Order>();
  let n = 0;
  const books: Record<string, { bidBtc: number | null; askBtc: number | null }> = {
    [FLOOR]: { bidBtc: 0.001, askBtc: 0.0014 },
    [CAP]: { bidBtc: 0.0028, askBtc: 0.0032 },
  };
  const client: LiveExecClient = {
    mode: "demo",
    placeOrder: async (o) => {
      const id = `o${++n}`;
      orders.set(id, { instId: o.instId, side: o.side, px: Number(o.px), sz: Number(o.sz), acc: 0, state: "live" });
      return { ok: true, code: "0", msg: "", data: [{ ordId: id }] };
    },
    getOrder: async (_i, ordId) => {
      const o = orders.get(ordId);
      return { ok: !!o, data: o ? [{ state: o.state, avgPx: String(o.px), accFillSz: String(o.acc), fee: "0", feeCcy: "BTC" }] : [] };
    },
    cancelOrder: async (_i, ordId) => {
      const o = orders.get(ordId);
      if (o && o.state === "live") o.state = "canceled";
      return { ok: true, data: [] };
    },
    getBookTop: async (instId) => ({ ok: true, data: [{ bids: books[instId]?.bidBtc ? [[String(books[instId].bidBtc), "9"]] : [], asks: books[instId]?.askBtc ? [[String(books[instId].askBtc), "9"]] : [] }] }),
    getPositions: async () => ({ ok: true, data: [] }),
  };
  const fill = (ordId: string, sz: number) => {
    const o = orders.get(ordId)!;
    o.acc = Math.min(o.sz, o.acc + sz);
    if (o.acc >= o.sz) o.state = "filled";
  };
  return { client, orders, books, fill, readBook: async (instId: string) => books[instId] ?? null };
};

test("unwind queue: passive-first — orders rest at the mid, fills are folded from venue truth, the job finishes when both legs are flat", async () => {
  const v = venue();
  const j = job();
  const cfg = { ...DEFAULT_UNWIND_QUEUE, enabled: true };
  const ioc = async () => {
    throw new Error("IOC must not run while the passive window is open");
  };
  await stepUnwindJob(j, { client: v.client, readBook: v.readBook, ioc, nowMs: T0 + 1000, cfg });
  assert.equal(v.orders.size, 2, "one resting order per leg");
  const [floorOrd, capOrd] = [...v.orders.entries()];
  assert.equal(floorOrd[1].side, "sell");
  assert.equal(floorOrd[1].px, 0.0012, "sell at the mid");
  assert.equal(capOrd[1].side, "buy");
  assert.equal(capOrd[1].px, 0.003, "buy at the mid");
  assert.deepEqual(j.receipts.slice(1).map((r) => r.kind), ["passive_rested", "passive_rested"]);

  v.fill(floorOrd[0], 2); // a partial on the floor leg
  await stepUnwindJob(j, { client: v.client, readBook: v.readBook, ioc, nowMs: T0 + 2000, cfg });
  assert.equal(j.legs[0].filledContracts, 2);
  assert.equal(j.legs[0].avgPxBtc, 0.0012);
  assert.ok(j.legs[0].feeUsdc > 0, "a venue fill pays the taker-model fee");
  assert.equal(j.legs[0].working?.ordId, floorOrd[0], "the same order keeps resting for the last lot");
  assert.equal(j.receipts.filter((r) => r.kind === "passive_filled").length, 1);

  // the cap book walks two ticks: the buy is re-priced
  v.books[CAP] = { bidBtc: 0.0024, askBtc: 0.0028 };
  await stepUnwindJob(j, { client: v.client, readBook: v.readBook, ioc, nowMs: T0 + 3000, cfg });
  assert.equal(v.orders.get(capOrd[0])!.state, "canceled");
  const capNow = j.legs[1].working!;
  assert.notEqual(capNow.ordId, capOrd[0]);
  assert.equal(capNow.pxBtc, 0.0026);
  assert.ok(j.receipts.some((r) => r.kind === "passive_repriced"));

  v.fill(floorOrd[0], 1);
  v.fill(capNow.ordId, 3);
  await stepUnwindJob(j, { client: v.client, readBook: v.readBook, ioc, nowMs: T0 + 4000, cfg });
  assert.equal(j.phase, "done");
  assert.equal(j.legs[0].filledContracts, 3);
  assert.equal(j.legs[1].filledContracts, 3);
  assert.equal(j.legs[1].avgPxBtc, 0.0026);
  assert.equal(j.realizedUsdc, realizedUsdc(j));
  assert.equal(j.executionEdgeUsdc, +(j.realizedUsdc! - 40).toFixed(2));
  assert.equal(j.receipts[j.receipts.length - 1].kind, "done");
});

test("unwind queue: when the passive window closes, resting orders are recalled and the remainder goes to the IOC, venue truth first; the IOC's fills fold in", async () => {
  const v = venue();
  const j = job();
  const cfg = { ...DEFAULT_UNWIND_QUEUE, enabled: true, passiveMs: 60_000 };
  j.passiveUntilMs = T0 + 60_000;
  let iocCalls: Array<{ instId: string; left: number }[]> = [];
  const ioc = async (legs: UnwindJob["legs"]) => {
    iocCalls.push(legs.map((l) => ({ instId: l.instId, left: l.contracts - l.filledContracts })));
    return { complete: true, fills: legs.map((l) => ({ instId: l.instId, contracts: l.contracts - l.filledContracts, avgPxBtc: l.action === "sell" ? 0.001 : 0.0032, feeUsdc: 0.1 })), note: "closed at the touch" };
  };
  await stepUnwindJob(j, { client: v.client, readBook: v.readBook, ioc, nowMs: T0 + 1000, cfg });
  const floorOrd = j.legs[0].working!.ordId;
  v.fill(floorOrd, 1);
  // the window ends: recall, then IOC on the next tick
  await stepUnwindJob(j, { client: v.client, readBook: v.readBook, ioc, nowMs: T0 + 61_000, cfg });
  assert.equal(j.phase, "ioc");
  assert.equal(j.legs[0].filledContracts, 1, "the passive fill before the recall is kept");
  assert.equal(j.legs[0].working, null);
  assert.equal(j.legs[1].working, null);
  assert.equal(v.orders.get(floorOrd)!.state, "canceled");
  assert.equal(iocCalls.length, 0, "the recall tick does not also fire the IOC");
  await stepUnwindJob(j, { client: v.client, readBook: v.readBook, ioc, nowMs: T0 + 62_000, cfg });
  assert.deepEqual(iocCalls, [[{ instId: FLOOR, left: 2 }, { instId: CAP, left: 3 }]], "the IOC gets only what is left");
  assert.equal(j.phase, "done");
  assert.equal(j.legs[0].filledContracts, 3);
  assert.equal(j.legs[0].avgPxBtc, +((0.0012 * 1 + 0.001 * 2) / 3).toFixed(8), "volume-weighted across passive and IOC");
  assert.ok(j.receipts.some((r) => r.kind === "ioc_closed"));
  assert.ok(j.executionEdgeUsdc! < 0, "a market close under the MTM: the writer's line shows it");
});

test("unwind queue: an IOC that cannot finish counts attempts with a retry gap, then fails and is left to the operator — the trader is already settled", async () => {
  const v = venue();
  const j = job();
  const cfg = { ...DEFAULT_UNWIND_QUEUE, enabled: true, passiveMs: 0, maxIocAttempts: 2, iocRetryMs: 10_000 };
  j.passiveUntilMs = T0;
  const ioc = async () => ({ complete: false, fills: [], note: "no bid on the floor leg" });
  await stepUnwindJob(j, { client: v.client, readBook: v.readBook, ioc, nowMs: T0 + 1, cfg });
  assert.equal(j.phase, "ioc");
  await stepUnwindJob(j, { client: v.client, readBook: v.readBook, ioc, nowMs: T0 + 2, cfg });
  assert.equal(j.iocAttempts, 1);
  await stepUnwindJob(j, { client: v.client, readBook: v.readBook, ioc, nowMs: T0 + 5_000, cfg });
  assert.equal(j.iocAttempts, 1, "inside the retry gap: no second attempt");
  await stepUnwindJob(j, { client: v.client, readBook: v.readBook, ioc, nowMs: T0 + 20_000, cfg });
  assert.equal(j.iocAttempts, 2);
  assert.equal(j.phase, "failed");
  assert.match(j.receipts[j.receipts.length - 1].note, /left to the operator/);
  const s = summarizeUnwindQueue([j]);
  assert.deepEqual([s.open, s.failed, s.done], [0, 1, 0]);
  // a closed job is never stepped again
  await stepUnwindJob(j, { client: v.client, readBook: v.readBook, ioc, nowMs: T0 + 40_000, cfg });
  assert.equal(j.iocAttempts, 2);
});
