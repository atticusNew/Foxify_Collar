import assert from "node:assert/strict";
import test from "node:test";

import {
  setVenueOptionChainProvider,
  __resetVenueStrikeGridForTests,
  getAvailableStrikes
} from "../src/volumeCover/venueStrikeGrid";
import { runChainWarmerTick } from "../src/volumeCover/chainWarmer";

test("chainWarmer: runs without provider — succeeded=0, attempted>0", async () => {
  __resetVenueStrikeGridForTests();
  const r = await runChainWarmerTick();
  assert.ok(r.queriesAttempted >= 12); // 2 venues × 3 expiries × 2 kinds = 12
  assert.equal(r.queriesSucceeded, 0); // no provider wired
});

test("chainWarmer: with provider wired — fills cache for both venues + put/call", async () => {
  __resetVenueStrikeGridForTests();
  const calls: string[] = [];
  setVenueOptionChainProvider(async (q) => {
    calls.push(`${q.venue}|${q.optionKind}`);
    return [78_000, 79_000, 80_000, 81_000, 82_000];
  });
  try {
    const r = await runChainWarmerTick();
    assert.ok(r.queriesAttempted >= 12);
    assert.ok(r.queriesSucceeded >= 12);
    // At least 4 distinct (venue, kind) tuples should have been called
    const distinct = new Set(calls);
    assert.equal(distinct.size, 4); // bullish-put, bullish-call, deribit-put, deribit-call
  } finally {
    __resetVenueStrikeGridForTests();
  }
});

test("chainWarmer: cache is hot after warming — subsequent getAvailableStrikes hits cache", async () => {
  __resetVenueStrikeGridForTests();
  let providerCallCount = 0;
  setVenueOptionChainProvider(async () => {
    providerCallCount++;
    return [79_000, 80_000, 81_000];
  });
  try {
    // Warm
    await runChainWarmerTick();
    const callsAfterWarm = providerCallCount;

    // Now call getAvailableStrikes for one of the warmed (venue, expiry, kind) tuples
    const expiries = [13, 14, 15].map((d) => {
      const dt = new Date(Date.now() + d * 86_400_000);
      dt.setUTCHours(8, 0, 0, 0);
      if (dt.getTime() < Date.now()) dt.setUTCDate(dt.getUTCDate() + 1);
      return dt.toISOString();
    });
    const strikes = await getAvailableStrikes({
      venue: "bullish",
      expiryIso: expiries[1],
      optionKind: "put"
    });
    assert.ok(strikes !== null && strikes.length > 0);
    // Should be cache hit, no new provider call
    assert.equal(providerCallCount, callsAfterWarm);
  } finally {
    __resetVenueStrikeGridForTests();
  }
});
