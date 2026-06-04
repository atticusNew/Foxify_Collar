/**
 * OKX chain provider — window filtering, ctVal read, BTC→USDC conversion, depth (×ctVal),
 * nearest-N cap. Mock fetcher (no network).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { fetchOkxChainSnapshot, type OkxChainConfig } from "../src/singleSide/twoSided/okxChainProvider";
import type { OkxFetcher } from "../src/singleSide/twoSided/okxProbe";

const cfg: OkxChainConfig = { centerSpot: 66000, strikeWindowUsdc: 3000, centerTenorDays: 2, tenorWindowDays: 1.5, maxOrderbookFetches: 16 };

test("fetchOkxChainSnapshot: reads ctVal, filters window, converts BTC->USDC, spread + BTC depth", async () => {
  const now = Date.parse("2026-06-03T12:00:00Z");
  const fetcher: OkxFetcher = async (url) => {
    if (url.includes("/public/instruments")) {
      return { data: [
        { instId: "BTC-USD-260605-66000-C", ctVal: "0.01" },
        { instId: "BTC-USD-260605-66000-P", ctVal: "0.01" },
        { instId: "BTC-USD-260605-90000-C", ctVal: "0.01" },
        { instId: "BTC-USD-260620-66000-C", ctVal: "0.01" },
        { instId: "BTC-USD_UM-260605-66000-C", ctVal: "0.01" }
      ] };
    }
    if (url.includes("66000-C")) return { data: [{ bids: [["0.009", "944"]], asks: [["0.0095", "3992"]] }] };
    if (url.includes("66000-P")) return { data: [{ bids: [["0.017", "1805"]], asks: [["0.018", "1673"]] }] };
    return { data: [{ bids: [], asks: [] }] };
  };

  const snap = await fetchOkxChainSnapshot(66000, cfg, fetcher, now);
  assert.equal(snap.ctVal, 0.01);
  assert.equal(snap.quotes.length, 2, "only in-window 66000 call+put (coin-margined)");
  const call = snap.quotes.find((q) => q.optType === "call")!;
  assert.equal(call.bidUsdcPerBtc, 594);
  assert.equal(call.askUsdcPerBtc, 627);
  assert.ok(Math.abs(call.spreadPct - 0.054) < 0.005);
  assert.ok(Math.abs(call.bidSizeBtc - 9.44) < 1e-6);
  assert.equal(call.venue, "okx");
});

test("fetchOkxChainSnapshot: defaults ctVal to 0.01 when absent; skips zero-bid books", async () => {
  const now = Date.parse("2026-06-03T12:00:00Z");
  const fetcher: OkxFetcher = async (url) => {
    if (url.includes("/public/instruments")) return { data: [{ instId: "BTC-USD-260605-66000-C" }] };
    return { data: [{ bids: [["0", "0"]], asks: [["0.001", "10"]] }] };
  };
  const snap = await fetchOkxChainSnapshot(66000, cfg, fetcher, now);
  assert.equal(snap.ctVal, 0.01);
  assert.equal(snap.quotes.length, 0);
});
