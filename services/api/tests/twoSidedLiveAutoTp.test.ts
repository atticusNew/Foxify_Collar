/**
 * Tests — LiveAutoTpHandler (server-side take-profit / trailing-stop for LIVE pairs).
 *
 * Pure-logic tests via decide()/tick() with injected MTM + closePair spy — no DB.
 * Covers: TP-threshold close, trailing-stop arm+giveback, shadow exclusion,
 * below-threshold no-op, pair scoping, maxPerTick, and the real-close-path call.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { LiveAutoTpHandler, type LiveAutoTpConfig, type LiveMtmRow } from "../src/singleSide/twoSided/liveAutoTpHandler";

const cfg = (over: Partial<LiveAutoTpConfig> = {}): LiveAutoTpConfig => ({
  enabled: true, pollMs: 60_000, tpThresholdPct: 0.40, trailArmPct: 0.25,
  trailGivebackPct: 0.12, maxPerTick: 10, pairIds: [], ...over
});

const row = (id: string, pnlPct: number, isShadow = false): LiveMtmRow => ({
  pair_id: id, is_shadow: isShadow, pnl_pct: pnlPct,
  pnl_if_close_now_usdc: pnlPct * 250, estimated_salvage_usdc: 250 * (1 + pnlPct)
});

const mk = (config: LiveAutoTpConfig, rowsSeq: LiveMtmRow[][]) => {
  const closed: Array<{ pairId: string; reason: string }> = [];
  let i = 0;
  const h = new LiveAutoTpHandler({
    config,
    getActivePairsMtm: async () => rowsSeq[Math.min(i++, rowsSeq.length - 1)],
    closePair: async (pairId, reason) => { closed.push({ pairId, reason }); },
    log: () => {}
  });
  return { h, closed };
};

test("liveAutoTp: closes on take-profit threshold (pnl >= tp)", async () => {
  const { h, closed } = mk(cfg(), [[row("p1", 0.45), row("p2", 0.30)]]);
  await h.tick();
  assert.equal(closed.length, 1);
  assert.equal(closed[0].pairId, "p1");
  assert.equal(closed[0].reason, "auto_tp");
});

test("liveAutoTp: trailing-stop fires after peak retraces past giveback", async () => {
  // Tick1: +30% (arms trailing, peak=0.30, below tp 0.40 → no close).
  // Tick2: +16% → retraced 14pp from peak 0.30 > giveback 0.12 → auto_trail close.
  const { h, closed } = mk(cfg(), [[row("p1", 0.30)], [row("p1", 0.16)]]);
  await h.tick();
  assert.equal(closed.length, 0, "tick1: armed, not closed");
  await h.tick();
  assert.equal(closed.length, 1, "tick2: trailing fired");
  assert.equal(closed[0].reason, "auto_trail");
});

test("liveAutoTp: trailing does NOT fire if peak never armed", async () => {
  // peak 0.20 (< trailArm 0.25), then drops to 0.05 — retrace big but never armed.
  const { h, closed } = mk(cfg(), [[row("p1", 0.20)], [row("p1", 0.05)]]);
  await h.tick(); await h.tick();
  assert.equal(closed.length, 0);
});

test("liveAutoTp: NEVER closes shadow pairs", async () => {
  const { h, closed } = mk(cfg(), [[row("shadow1", 0.90, true), row("live1", 0.50, false)]]);
  await h.tick();
  assert.equal(closed.length, 1);
  assert.equal(closed[0].pairId, "live1", "only the live pair closed; shadow ignored");
});

test("liveAutoTp: below all thresholds → no close", async () => {
  const { h, closed } = mk(cfg(), [[row("p1", 0.10), row("p2", -0.20)]]);
  await h.tick();
  assert.equal(closed.length, 0);
});

test("liveAutoTp: pair scoping limits to configured ids", async () => {
  const { h, closed } = mk(cfg({ pairIds: ["only-this"] }), [[row("only-this", 0.50), row("other", 0.50)]]);
  await h.tick();
  assert.equal(closed.length, 1);
  assert.equal(closed[0].pairId, "only-this");
});

test("liveAutoTp: maxPerTick caps closes", async () => {
  const { h, closed } = mk(cfg({ maxPerTick: 2 }), [[row("a", 0.5), row("b", 0.5), row("c", 0.5)]]);
  await h.tick();
  assert.equal(closed.length, 2);
});

test("liveAutoTp: forgets peak for pairs that disappear (no leak / no stale trail)", async () => {
  const { h } = mk(cfg(), [[row("p1", 0.30)], []]);
  await h.tick();
  assert.equal(h.stats().tracked, 1);
  await h.tick(); // p1 gone from MTM (closed elsewhere) → peak forgotten
  assert.equal(h.stats().tracked, 0);
});

test("liveAutoTp: disabled config → start() is a no-op (no timer)", () => {
  const { h } = mk(cfg({ enabled: false }), [[]]);
  h.start();
  assert.equal(h.stats().ticksRun, 0);
  h.stop();
});
