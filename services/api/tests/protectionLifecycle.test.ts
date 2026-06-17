/**
 * Shadow Protection lifecycle — open/touch/expire/settle + scorecard. Deterministic.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  barrierOf, isTouched, openCover, evaluateCover, settleCover, scorecard,
  type ProtectionCover
} from "../src/singleSide/twoSided/protection/protectionLifecycle";

const baseInput = {
  id: "cov-1", spot: 100000, triggerPct: 0.03, tenorMs: 24 * 3_600_000,
  payoutUsdc: 60, premiumUsdc: 12, hedgeCostUsdc: 11, opsFeeUsdc: 1, impliedTouch: 0.18, nowMs: 1_000_000
};

test("barrierOf + isTouched: long below, short above", () => {
  assert.equal(barrierOf("long", 100000, 0.03), 97000);
  assert.equal(barrierOf("short", 100000, 0.03), 103000);
  assert.equal(isTouched({ side: "long", barrier_price: 97000 }, 96999), true);
  assert.equal(isTouched({ side: "long", barrier_price: 97000 }, 97001), false);
  assert.equal(isTouched({ side: "short", barrier_price: 103000 }, 103001), true);
});

test("openCover: builds an active cover with barrier + expiry", () => {
  const c = openCover(baseInput);
  assert.equal(c.status, "active");
  assert.equal(c.barrier_price, 97000);
  assert.equal(c.expires_at_ms, baseInput.nowMs + baseInput.tenorMs);
  assert.equal(c.side, "long");
  assert.equal(c.mode, "shadow");
});

test("evaluateCover: touch settles with payout; foxify +payout−premium, atticus premium−hedge", () => {
  const c = openCover(baseInput);
  const settled = evaluateCover(c, 96500, baseInput.nowMs + 3_600_000); // dipped below 97000
  assert.equal(settled.status, "settled_touch");
  assert.equal(settled.touched, true);
  assert.equal(settled.foxify_pnl_usdc, 48);   // 60 − 12
  assert.equal(settled.atticus_pnl_usdc, 1);   // 12 − 11
});

test("evaluateCover: no touch before expiry stays active; expiry settles as no-touch", () => {
  const c = openCover(baseInput);
  const mid = evaluateCover(c, 98000, baseInput.nowMs + 3_600_000);
  assert.equal(mid.status, "active");
  const expired = evaluateCover(c, 98000, baseInput.nowMs + baseInput.tenorMs + 1);
  assert.equal(expired.status, "expired_no_touch");
  assert.equal(expired.foxify_pnl_usdc, -12); // lost the premium
  assert.equal(expired.atticus_pnl_usdc, 1);  // still premium − hedge
});

test("settled covers are immutable on re-evaluate", () => {
  const c = settleCover(openCover(baseInput), { touched: true, settlePrice: 97000, nowMs: baseInput.nowMs + 1 });
  const again = evaluateCover(c, 50000, baseInput.nowMs + 5);
  assert.deepEqual(again, c);
});

test("scorecard: edge = realized − implied; splits by signal", () => {
  const mk = (id: string, touched: boolean, signal: "GO" | "WAIT") =>
    settleCover(openCover({ ...baseInput, id, signal }), { touched, settlePrice: 97000, nowMs: baseInput.nowMs + 1 });
  // 5 GO: 2 touch (40% realized vs 18% implied); 5 WAIT: 0 touch
  const covers: ProtectionCover[] = [
    mk("g1", true, "GO"), mk("g2", true, "GO"), mk("g3", false, "GO"), mk("g4", false, "GO"), mk("g5", false, "GO"),
    mk("w1", false, "WAIT"), mk("w2", false, "WAIT")
  ];
  const sc = scorecard(covers);
  assert.equal(sc.settled, 7);
  assert.equal(sc.touches, 2);
  assert.equal(sc.implied_touch_rate_avg, 0.18);
  assert.equal(sc.realized_touch_rate, +(2 / 7).toFixed(4));
  assert.equal(sc.by_signal.GO.settled, 5);
  assert.equal(sc.by_signal.GO.touches, 2);
  // GO foxify net: 2×48 + 3×(−12) = 96 − 36 = 60
  assert.equal(sc.by_signal.GO.foxify_net_usdc, 60);
  // atticus net = 7 × (12−11) = 7
  assert.equal(sc.atticus_net_usdc, 7);
});
