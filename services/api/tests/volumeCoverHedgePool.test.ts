import assert from "node:assert/strict";
import test from "node:test";

import type { HedgePoolLegRecord } from "../src/volumeCover/hedgePool";

test("HedgePoolLegRecord shape: long_put + short_put + long_call + short_call", () => {
  const legs: HedgePoolLegRecord[] = [
    {
      symbol: "BTC-USDC-20260526-75000-P",
      side: "BUY",
      strikeUsdc: 75_000,
      optionKind: "put",
      legRole: "long_put",
      fillPriceUsdc: 680,
      contractsBtc: 0.01,
      bullishOrderId: "978106358611574785"
    },
    {
      symbol: "BTC-USDC-20260526-74000-P",
      side: "SELL",
      strikeUsdc: 74_000,
      optionKind: "put",
      legRole: "short_put",
      fillPriceUsdc: 330,
      contractsBtc: 0.01,
      bullishOrderId: "978106368476578817"
    },
    {
      symbol: "BTC-USDC-20260526-77000-C",
      side: "BUY",
      strikeUsdc: 77_000,
      optionKind: "call",
      legRole: "long_call",
      fillPriceUsdc: 250,
      contractsBtc: 0.01,
      bullishOrderId: "978106378312221697"
    },
    {
      symbol: "BTC-USDC-20260526-78000-C",
      side: "SELL",
      strikeUsdc: 78_000,
      optionKind: "call",
      legRole: "short_call",
      fillPriceUsdc: 80,
      contractsBtc: 0.01,
      bullishOrderId: "978106388131087361"
    }
  ];
  assert.equal(legs.length, 4);

  // Invariants from the spread executor's safety model:
  //   long put strike > short put strike
  //   long call strike < short call strike
  const longPut = legs.find((l) => l.legRole === "long_put")!;
  const shortPut = legs.find((l) => l.legRole === "short_put")!;
  const longCall = legs.find((l) => l.legRole === "long_call")!;
  const shortCall = legs.find((l) => l.legRole === "short_call")!;
  assert.ok(longPut.strikeUsdc > shortPut.strikeUsdc);
  assert.ok(longCall.strikeUsdc < shortCall.strikeUsdc);

  // Sides
  assert.equal(longPut.side, "BUY");
  assert.equal(shortPut.side, "SELL");
  assert.equal(longCall.side, "BUY");
  assert.equal(shortCall.side, "SELL");
});

test("HedgePool: band coverage invariant", () => {
  // coverage_band_low = short_put_strike (worst-case downside)
  // coverage_band_high = short_call_strike (worst-case upside)
  // A new Foxify band ⊆ [coverage_band_low + 1*step, coverage_band_high - 1*step]
  // can be safely covered (long-put / long-call kick in inside that interval).
  const shortPutStrike = 74_000;
  const longPutStrike = 75_000;
  const longCallStrike = 77_000;
  const shortCallStrike = 78_000;

  const coverageBandLow = shortPutStrike;
  const coverageBandHigh = shortCallStrike;

  // Atticus's protective band (defined by the long legs)
  const protectiveLow = longPutStrike;
  const protectiveHigh = longCallStrike;

  assert.ok(coverageBandLow < protectiveLow);
  assert.ok(coverageBandHigh > protectiveHigh);

  // Foxify band example: trigger band is ±2% of spot 76,000 → [74,480, 77,520]
  const newBandLow = 74_480;
  const newBandHigh = 77_520;

  // Containment check for selection query:
  // coverage_band_low <= newBandLow  AND  coverage_band_high >= newBandHigh
  assert.ok(coverageBandLow <= newBandLow);
  assert.ok(coverageBandHigh >= newBandHigh);
});
