/**
 * Live executor leg-submission serialization.
 *
 * Bullish requires strictly-increasing nonces per request, so submitting two Bullish
 * orders CONCURRENTLY races the nonce → one leg rejected with "invalid nonce" (observed
 * live: call REJECTED while put filled, then auto-reversed). Fix: when BOTH legs route
 * to Bullish, submit sequentially; cross-venue stays concurrent for latency.
 *
 * These tests assert max in-flight concurrency: 1 for both-Bullish, 2 for cross-venue.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { LiveStrangleExecutor, type BullishLegClient, type DeribitLegClient } from "../src/singleSide/twoSided/liveStrangleExecutor";
import { LiveCloseExecutor } from "../src/singleSide/twoSided/liveCloseExecutor";
import type { CloseStrangleRequest } from "../src/singleSide/twoSided/closeExecutor";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Shared in-flight tracker so we can detect whether two legs overlapped. */
const makeTracker = () => {
  const s = { active: 0, max: 0 };
  const fn = async () => {
    s.active++; s.max = Math.max(s.max, s.active);
    await sleep(25);
    s.active--;
    return { ok: true as const, filledAskUsdcPerBtc: 100, filledAtIso: new Date().toISOString() };
  };
  return { s, fn };
};

const buildExecutors = (fn: () => Promise<unknown>) => {
  const client = { buyLeg: fn, sellLeg: fn } as unknown;
  return {
    strangle: new LiveStrangleExecutor(client as BullishLegClient, client as DeribitLegClient),
    close: new LiveCloseExecutor(client as BullishLegClient, client as DeribitLegClient)
  };
};

const order = (putVenue: "bullish" | "deribit", callVenue: "bullish" | "deribit") => ({
  pairId: "p",
  putLeg: { venue: putVenue, symbol: "BTC-...-71000-P", strikeUsdc: 71000, contractsBtc: 0.07, maxAcceptableAskUsdcPerBtc: 540, legRole: "long_put" as const },
  callLeg: { venue: callVenue, symbol: "BTC-...-71000-C", strikeUsdc: 71000, contractsBtc: 0.07, maxAcceptableAskUsdcPerBtc: 720, legRole: "long_call" as const }
});

const closeReq = (putVenue: "bullish" | "deribit", callVenue: "bullish" | "deribit"): CloseStrangleRequest => ({
  pairId: "p",
  putLeg: { venue: putVenue, symbol: "BTC-...-71000-P", contractsBtc: 0.07, expectedSellPxUsdcPerBtc: 500, minAcceptablePxUsdcPerBtc: 400 },
  callLeg: { venue: callVenue, symbol: "BTC-...-71000-C", contractsBtc: 0.07, expectedSellPxUsdcPerBtc: 650, minAcceptablePxUsdcPerBtc: 500 }
} as unknown as CloseStrangleRequest);

test("executeStrangle: both-Bullish legs submit SEQUENTIALLY (max concurrency 1)", async () => {
  const { s, fn } = makeTracker();
  const r = await buildExecutors(fn).strangle.executeStrangle(order("bullish", "bullish"));
  assert.equal(r.ok, true);
  assert.equal(s.max, 1, "two Bullish legs must not be in flight simultaneously (nonce ordering)");
});

test("executeStrangle: cross-venue legs stay CONCURRENT (max concurrency 2)", async () => {
  const { s, fn } = makeTracker();
  const r = await buildExecutors(fn).strangle.executeStrangle(order("bullish", "deribit"));
  assert.equal(r.ok, true);
  assert.equal(s.max, 2, "cross-venue legs overlap for latency");
});

test("closeStrangle: both-Bullish legs submit SEQUENTIALLY (max concurrency 1)", async () => {
  const { s, fn } = makeTracker();
  const r = await buildExecutors(fn).close.closeStrangle(closeReq("bullish", "bullish"));
  assert.equal(r.ok, true);
  assert.equal(s.max, 1);
});

test("closeStrangle: cross-venue legs stay CONCURRENT (max concurrency 2)", async () => {
  const { s, fn } = makeTracker();
  const r = await buildExecutors(fn).close.closeStrangle(closeReq("bullish", "deribit"));
  assert.equal(r.ok, true);
  assert.equal(s.max, 2);
});
