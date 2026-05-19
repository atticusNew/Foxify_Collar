import assert from "node:assert/strict";
import test from "node:test";

import {
  setVenueOptionChainProvider,
  pickClosestStrike,
  getAvailableStrikes,
  __resetVenueStrikeGridForTests
} from "../src/volumeCover/venueStrikeGrid";
import { buildHedgeStructureWithVenueGrid } from "../src/volumeCover/tightHedge";
import { findCellById } from "../src/volumeCover/matrix";

test("venueStrikeGrid: no provider wired returns null (caller falls back)", async () => {
  __resetVenueStrikeGridForTests();
  const r = await pickClosestStrike({
    query: { venue: "bullish", expiryIso: "2026-05-30T08:00:00Z", optionKind: "put" },
    idealStrikeUsdc: 79_200,
    spotUsdc: 80_000,
    triggerBoundaryUsdc: 78_400
  });
  assert.equal(r, null);
});

test("venueStrikeGrid: pickClosestStrike returns closest in-band strike from live grid", async () => {
  __resetVenueStrikeGridForTests();
  setVenueOptionChainProvider(async (q) => {
    // Simulate Bullish PUT chain at $200 grid centered $80k
    if (q.optionKind === "put") return [78_000, 78_200, 78_400, 78_600, 78_800, 79_000, 79_200, 79_400, 79_600, 79_800, 80_000];
    return [80_000, 80_200, 80_400, 80_600, 80_800, 81_000, 81_200, 81_400, 81_600];
  });
  try {
    const put = await pickClosestStrike({
      query: { venue: "bullish", expiryIso: "2026-05-30T08:00:00Z", optionKind: "put" },
      idealStrikeUsdc: 79_200,
      spotUsdc: 80_000,
      triggerBoundaryUsdc: 78_400
    });
    // Ideal = 79,200, in-band [78,401, 80,000]; chain has 79,200 exact
    assert.equal(put, 79_200);

    const call = await pickClosestStrike({
      query: { venue: "bullish", expiryIso: "2026-05-30T08:00:00Z", optionKind: "call" },
      idealStrikeUsdc: 80_800,
      spotUsdc: 80_000,
      triggerBoundaryUsdc: 81_600
    });
    // Ideal = 80,800, in-band [80,000, 81,599]; chain has 80,800 exact
    assert.equal(call, 80_800);
  } finally {
    __resetVenueStrikeGridForTests();
  }
});

test("venueStrikeGrid: out-of-band ideal snaps to closest in-band strike", async () => {
  __resetVenueStrikeGridForTests();
  setVenueOptionChainProvider(async () => [78_000, 78_500, 79_000, 79_500, 80_000]);
  try {
    // Ideal 78,200 below band trigger 78,400; chain 79,000 closest to 78,200 in band
    const put = await pickClosestStrike({
      query: { venue: "bullish", expiryIso: "2026-05-30T08:00:00Z", optionKind: "put" },
      idealStrikeUsdc: 78_200,
      spotUsdc: 80_000,
      triggerBoundaryUsdc: 78_400
    });
    // In-band: > 78,400 and ≤ 80,000 → {78,500, 79,000, 79,500, 80,000}
    // Closest to ideal 78,200 → 78,500
    assert.equal(put, 78_500);
  } finally {
    __resetVenueStrikeGridForTests();
  }
});

test("venueStrikeGrid: empty in-band set returns null", async () => {
  __resetVenueStrikeGridForTests();
  setVenueOptionChainProvider(async () => [60_000, 70_000, 90_000]);
  try {
    const put = await pickClosestStrike({
      query: { venue: "bullish", expiryIso: "2026-05-30T08:00:00Z", optionKind: "put" },
      idealStrikeUsdc: 79_200,
      spotUsdc: 80_000,
      triggerBoundaryUsdc: 78_400
    });
    assert.equal(put, null);
  } finally {
    __resetVenueStrikeGridForTests();
  }
});

test("venueStrikeGrid: provider error returns null without throwing", async () => {
  __resetVenueStrikeGridForTests();
  setVenueOptionChainProvider(async () => {
    throw new Error("venue_api_500");
  });
  try {
    const r = await pickClosestStrike({
      query: { venue: "bullish", expiryIso: "2026-05-30T08:00:00Z", optionKind: "put" },
      idealStrikeUsdc: 79_200,
      spotUsdc: 80_000,
      triggerBoundaryUsdc: 78_400
    });
    assert.equal(r, null);
  } finally {
    __resetVenueStrikeGridForTests();
  }
});

test("venueStrikeGrid: 60s cache reduces provider calls", async () => {
  __resetVenueStrikeGridForTests();
  let callCount = 0;
  setVenueOptionChainProvider(async () => {
    callCount++;
    return [79_000, 79_200, 79_400];
  });
  try {
    const q = {
      venue: "bullish" as const,
      expiryIso: "2026-05-30T08:00:00Z",
      optionKind: "put" as const
    };
    await getAvailableStrikes(q);
    await getAvailableStrikes(q);
    await getAvailableStrikes(q);
    assert.equal(callCount, 1, "subsequent calls within TTL should hit cache");
  } finally {
    __resetVenueStrikeGridForTests();
  }
});

test("buildHedgeStructureWithVenueGrid: provider wired \u2192 strikes from live chain", async () => {
  __resetVenueStrikeGridForTests();
  setVenueOptionChainProvider(async (q) =>
    q.optionKind === "put" ? [79_100, 79_300, 79_500] : [80_700, 80_900, 81_100]
  );
  try {
    const cell = findCellById("50k_2pct_1k")!;
    const s = await buildHedgeStructureWithVenueGrid({
      positionId: "vsg-1",
      cell,
      entryBtcPrice: 80_000
    });
    const put = s.legs.find((l) => l.optionKind === "put")!;
    const call = s.legs.find((l) => l.optionKind === "call")!;
    // Ideal put 79,200 → in-band {79,100, 79,300, 79,500}; 79,100 and 79,300 tied at dist 100
    assert.ok([79_100, 79_300].includes(put.strikeUsdc), `put strike ${put.strikeUsdc}`);
    // Ideal call 80,800 → closest in-band {80,700, 80,900, 81,100} → 80,700 or 80,900 (tied dist 100)
    assert.ok([80_700, 80_900].includes(call.strikeUsdc), `call strike ${call.strikeUsdc}`);
  } finally {
    __resetVenueStrikeGridForTests();
  }
});

test("buildHedgeStructureWithVenueGrid: no provider \u2192 falls back to static grid snap", async () => {
  __resetVenueStrikeGridForTests();
  // No provider wired
  const cell = findCellById("50k_2pct_1k")!;
  const s = await buildHedgeStructureWithVenueGrid({
    positionId: "vsg-fallback",
    cell,
    entryBtcPrice: 80_000
  });
  const put = s.legs.find((l) => l.optionKind === "put")!;
  // Static path: $200 grid, ideal 79,200 → exactly 79,200
  assert.equal(put.strikeUsdc, 79_200);
});
