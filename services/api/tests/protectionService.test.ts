/**
 * Shadow Protection service — activate (gating, idempotency, pricing), tick (touch/expiry), scorecard.
 * Deterministic: feed + pricing + clock are injected.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { ProtectionService, type CoverPricing, type PlanLiveHedgeFn } from "../src/singleSide/twoSided/protection/protectionService";
import type { HedgeExecutor, HedgePlan } from "../src/singleSide/twoSided/protection/hedgeExecutor";
import type { HedgeFill } from "../src/singleSide/twoSided/protection/protectionLifecycle";

const pricing: CoverPricing = { premiumUsdc: 12, hedgeCostUsdc: 11, impliedTouch: 0.18, payoutUsdc: 60, opsFeeUsdc: 1 };

const makeService = (opts: { spot: number | null; now?: number; signal?: "GO" | "WAIT" | "NA" }) => {
  let t = opts.now ?? 1_000_000;
  let id = 0;
  const svc = new ProtectionService({
    getSpot: () => opts.spot,
    priceCover: async () => pricing,
    getSignal: () => opts.signal ?? "NA",
    now: () => t,
    idGen: () => `cov-${++id}`
  });
  return { svc, advance: (ms: number) => { t += ms; } };
};

test("activate: prices + stores an active cover", async () => {
  const { svc } = makeService({ spot: 100000 });
  const r = await svc.activate({ triggerPct: 0.03, tenorDays: 1, payoutUsdc: 60 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.cover.status, "active");
  assert.equal(r.cover.barrier_price, 97000);
  assert.equal(r.cover.premium_usdc, 12);
  assert.equal((await svc.list()).length, 1);
});

test("activate: idempotent on foxifyRef", async () => {
  const { svc } = makeService({ spot: 100000 });
  const a = await svc.activate({ foxifyRef: "ref-1", triggerPct: 0.03, tenorDays: 1, payoutUsdc: 60 });
  const b = await svc.activate({ foxifyRef: "ref-1", triggerPct: 0.03, tenorDays: 1, payoutUsdc: 60 });
  assert.equal(a.ok && b.ok, true);
  if (a.ok && b.ok) { assert.equal(b.reused, true); assert.equal(a.cover.id, b.cover.id); }
  assert.equal((await svc.list()).length, 1);
});

test("activate: requireGo blocks when signal is not GO", async () => {
  const { svc } = makeService({ spot: 100000, signal: "WAIT" });
  const r = await svc.activate({ triggerPct: 0.03, tenorDays: 1, payoutUsdc: 60, requireGo: true });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error, "signal_not_go");
});

test("activate: fails on unavailable feed", async () => {
  const { svc } = makeService({ spot: null });
  const r = await svc.activate({ triggerPct: 0.03, tenorDays: 1, payoutUsdc: 60 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "feed_unavailable");
});

test("tick: settles on touch using the adverse extreme (low for long)", async () => {
  const m = makeService({ spot: 100000 });
  await m.svc.activate({ triggerPct: 0.03, tenorDays: 1, payoutUsdc: 60 });
  // spot still 100k, but the low since last tick dipped to 96.9k → touch
  const res = await m.svc.tick({ low: 96900 });
  assert.equal(res.settled.length, 1);
  assert.equal(res.settled[0].status, "settled_touch");
  assert.equal(res.settled[0].foxify_pnl_usdc, 48);
});

test("tick: expires with no touch after tenor", async () => {
  const m = makeService({ spot: 100000 });
  await m.svc.activate({ triggerPct: 0.03, tenorDays: 1, payoutUsdc: 60 });
  m.advance(24 * 3_600_000 + 1);
  const res = await m.svc.tick(); // spot 100k, no dip
  assert.equal(res.settled.length, 1);
  assert.equal(res.settled[0].status, "expired_no_touch");
  assert.equal(res.settled[0].foxify_pnl_usdc, -12);
});

// ── Live mode: real-hedge open + auto-unwind ──
const liveLegs: HedgeFill[] = [
  { role: "inner", action: "buy", venue: "deribit", instrument: "BTC-X-98000-P", strike: 98000, contractsBtc: 0.1, fillUsdcPerBtc: 1200 },
  { role: "outer", action: "sell", venue: "bullish", instrument: "BTC-X-96000-P", strike: 96000, contractsBtc: 0.1, fillUsdcPerBtc: 700 }
];
const plan: HedgePlan = {
  side: "long", contractsBtc: 0.1,
  inner: { venue: "deribit", instrument: "BTC-X-98000-P", strike: 98000, askUsdcPerBtc: 1200, bidUsdcPerBtc: 1100 },
  outer: { venue: "bullish", instrument: "BTC-X-96000-P", strike: 96000, askUsdcPerBtc: 760, bidUsdcPerBtc: 700 }
};
const makeLiveService = (opts: { spot: number; closeOk?: boolean; closeProceeds?: number }) => {
  let t = 1_000_000; let id = 0; const calls: string[] = [];
  const planLiveHedge: PlanLiveHedgeFn = async () => plan;
  const executor: HedgeExecutor = {
    mode: "live",
    openHedge: async () => { calls.push("open"); return { ok: true, mode: "live", legs: liveLegs, debit_usdc: 50, spread_width_usd: 2000, effective_payout_usdc: 200, venues: ["deribit", "bullish"] }; },
    closeHedge: async () => { calls.push("close"); return opts.closeOk === false ? { ok: false, mode: "live", error: "venue down" } as never : { ok: true, mode: "live", legs: liveLegs, proceeds_usdc: opts.closeProceeds ?? 200 }; }
  };
  const svc = new ProtectionService({
    getSpot: () => opts.spot, priceCover: async () => pricing, planLiveHedge, executor,
    defaultOpsFeeUsdc: 1, now: () => t, idGen: () => `live-${++id}`
  });
  return { svc, calls, advance: (ms: number) => { t += ms; } };
};

test("live activate: opens real hedge; payout/premium derived from fills", async () => {
  const m = makeLiveService({ spot: 100000 });
  const r = await m.svc.activate({ side: "long", triggerPct: 0.03, tenorDays: 1, payoutUsdc: 0, contractsBtc: 0.1, mode: "live" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.cover.mode, "live");
  assert.equal(r.cover.payout_usdc, 200);       // effective_payout from hedge
  assert.equal(r.cover.hedge_cost_usdc, 50);     // debit
  assert.equal(r.cover.premium_usdc, 51);        // debit + ops
  assert.equal(r.cover.hedge?.legs.length, 2);
  assert.deepEqual(m.calls, ["open"]);
});

test("live tick: auto-unwinds on touch; records realized hedge P&L", async () => {
  const m = makeLiveService({ spot: 100000, closeProceeds: 200 });
  await m.svc.activate({ side: "long", triggerPct: 0.03, tenorDays: 1, payoutUsdc: 0, contractsBtc: 0.1, mode: "live" });
  const res = await m.svc.tick({ low: 96500 }); // touches 97000 barrier
  assert.equal(res.settled.length, 1);
  assert.equal(res.settled[0].status, "settled_touch");
  assert.equal(res.settled[0].hedge_close?.proceeds_usdc, 200);
  assert.equal(res.settled[0].hedge_close?.realized_hedge_pnl_usdc, 150); // 200 − 50 debit
  assert.deepEqual(m.calls, ["open", "close"]);
});

test("live tick: leaves cover ACTIVE if unwind fails (retry next tick)", async () => {
  const m = makeLiveService({ spot: 100000, closeOk: false });
  const a = await m.svc.activate({ side: "long", triggerPct: 0.03, tenorDays: 1, payoutUsdc: 0, contractsBtc: 0.1, mode: "live" });
  const res = await m.svc.tick({ low: 96500 });
  assert.equal(res.settled.length, 0);
  if (a.ok) assert.equal((await m.svc.get(a.cover.id))?.status, "active"); // not settled while hedge open
});

test("live tick: resumable unwind — inner closes, outer fails, retry skips inner and completes", async () => {
  let t = 1_000_000; let id = 0; const calls: Array<string[]> = []; let attempt = 0;
  const planLiveHedge: PlanLiveHedgeFn = async () => plan;
  const executor: HedgeExecutor = {
    mode: "live",
    openHedge: async () => ({ ok: true, mode: "live", legs: liveLegs, debit_usdc: 50, spread_width_usd: 2000, effective_payout_usdc: 200, venues: ["deribit", "bullish"] }),
    closeHedge: async (_opened, skip = []) => {
      calls.push(skip); attempt++;
      if (attempt === 1) return { ok: false, mode: "live", proceeds_usdc: 110, closed_legs: [{ ...liveLegs[0], action: "sell", fillUsdcPerBtc: 1100 }], leg_results: [{ role: "inner", ok: true }, { role: "outer", ok: false, error: "venue down" }], error: "outer:venue down" };
      return { ok: true, mode: "live", proceeds_usdc: -75, closed_legs: [{ ...liveLegs[1], action: "buy", fillUsdcPerBtc: 750 }], leg_results: [{ role: "outer", ok: true }] };
    }
  };
  const svc = new ProtectionService({ getSpot: () => 100000, priceCover: async () => pricing, planLiveHedge, executor, defaultOpsFeeUsdc: 1, now: () => t, idGen: () => `live-${++id}` });
  const a = await svc.activate({ side: "long", triggerPct: 0.03, tenorDays: 1, payoutUsdc: 0, contractsBtc: 0.1, mode: "live" });
  assert.equal(a.ok, true); if (!a.ok) return;

  // First tick: touch → inner closes, outer fails → cover stays active with progress.
  const r1 = await svc.tick({ low: 96000 });
  assert.equal(r1.settled.length, 0);
  const mid = await svc.get(a.cover.id);
  assert.equal(mid?.status, "active");
  assert.deepEqual(mid?.close_progress?.closed_roles, ["inner"]);

  // Second tick: retry skips inner, closes outer → fully settled.
  const r2 = await svc.tick({ low: 96000 });
  assert.equal(r2.settled.length, 1);
  assert.equal(r2.settled[0].status, "settled_touch");
  assert.equal(r2.settled[0].hedge_close?.proceeds_usdc, 35);          // 110 + (−75)
  assert.equal(r2.settled[0].hedge_close?.realized_hedge_pnl_usdc, -15); // 35 − 50 debit
  assert.deepEqual(calls[1], ["inner"]);                                // inner NOT re-attempted
});

test("forceClose: manually unwinds an active live cover", async () => {
  const m = makeLiveService({ spot: 100000, closeProceeds: 40 });
  const a = await m.svc.activate({ side: "long", triggerPct: 0.03, tenorDays: 1, payoutUsdc: 0, contractsBtc: 0.1, mode: "live" });
  if (!a.ok) return;
  const r = await m.svc.forceClose(a.cover.id);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.cover.status, "expired_no_touch");
  assert.equal(r.cover.hedge_close?.realized_hedge_pnl_usdc, -10); // 40 − 50
});

test("scorecard aggregates settled covers", async () => {
  const m = makeService({ spot: 100000, signal: "GO" });
  await m.svc.activate({ foxifyRef: "a", triggerPct: 0.03, tenorDays: 1, payoutUsdc: 60 });
  await m.svc.tick({ low: 96000 }); // touch
  await m.svc.activate({ foxifyRef: "b", triggerPct: 0.03, tenorDays: 1, payoutUsdc: 60 });
  m.advance(24 * 3_600_000 + 1);
  await m.svc.tick(); // expire
  const sc = await m.svc.scorecard();
  assert.equal(sc.settled, 2);
  assert.equal(sc.touches, 1);
  assert.equal(sc.atticus_net_usdc, 2); // 2 × (12−11)
  assert.equal(sc.by_signal.GO.settled, 2);
});
