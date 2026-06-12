/**
 * Shadow Protection service — activate (gating, idempotency, pricing), tick (touch/expiry), scorecard.
 * Deterministic: feed + pricing + clock are injected.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { ProtectionService, type CoverPricing } from "../src/singleSide/twoSided/protection/protectionService";

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
  assert.equal(svc.list().length, 1);
});

test("activate: idempotent on foxifyRef", async () => {
  const { svc } = makeService({ spot: 100000 });
  const a = await svc.activate({ foxifyRef: "ref-1", triggerPct: 0.03, tenorDays: 1, payoutUsdc: 60 });
  const b = await svc.activate({ foxifyRef: "ref-1", triggerPct: 0.03, tenorDays: 1, payoutUsdc: 60 });
  assert.equal(a.ok && b.ok, true);
  if (a.ok && b.ok) { assert.equal(b.reused, true); assert.equal(a.cover.id, b.cover.id); }
  assert.equal(svc.list().length, 1);
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
  const res = m.svc.tick({ low: 96900 });
  assert.equal(res.settled.length, 1);
  assert.equal(res.settled[0].status, "settled_touch");
  assert.equal(res.settled[0].foxify_pnl_usdc, 48);
});

test("tick: expires with no touch after tenor", async () => {
  const m = makeService({ spot: 100000 });
  await m.svc.activate({ triggerPct: 0.03, tenorDays: 1, payoutUsdc: 60 });
  m.advance(24 * 3_600_000 + 1);
  const res = m.svc.tick(); // spot 100k, no dip
  assert.equal(res.settled.length, 1);
  assert.equal(res.settled[0].status, "expired_no_touch");
  assert.equal(res.settled[0].foxify_pnl_usdc, -12);
});

test("scorecard aggregates settled covers", async () => {
  const m = makeService({ spot: 100000, signal: "GO" });
  await m.svc.activate({ foxifyRef: "a", triggerPct: 0.03, tenorDays: 1, payoutUsdc: 60 });
  m.svc.tick({ low: 96000 }); // touch
  await m.svc.activate({ foxifyRef: "b", triggerPct: 0.03, tenorDays: 1, payoutUsdc: 60 });
  m.advance(24 * 3_600_000 + 1);
  m.svc.tick(); // expire
  const sc = m.svc.scorecard();
  assert.equal(sc.settled, 2);
  assert.equal(sc.touches, 1);
  assert.equal(sc.atticus_net_usdc, 2); // 2 × (12−11)
  assert.equal(sc.by_signal.GO.settled, 2);
});
