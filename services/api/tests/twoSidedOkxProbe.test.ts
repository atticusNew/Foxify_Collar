/**
 * OKX probe — pure-logic tests with a mock fetcher (no network): instId parsing,
 * nearest expiry/strike selection, BTC→USDC conversion, spread%.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { okxProbe, parseOkxOption, type OkxFetcher } from "../src/singleSide/twoSided/okxProbe";

test("parseOkxOption: coin-margined only; rejects _UM and malformed", () => {
  const c = parseOkxOption("BTC-USD-260605-67500-C");
  assert.ok(c && c.strike === 67500 && c.optType === "call");
  const p = parseOkxOption("BTC-USD-260605-66000-P");
  assert.ok(p && p.strike === 66000 && p.optType === "put");
  assert.equal(parseOkxOption("BTC-USD_UM-260605-67500-C"), null, "_UM excluded");
  assert.equal(parseOkxOption("ETH-USD-260605-3000-C"), null);
});

test("okxProbe: picks nearest expiry+strike, converts BTC→USDC, computes spread", async () => {
  const now = Date.parse("2026-06-03T12:00:00Z");
  const expiry = "260605"; // ~2 days out
  const fetcher: OkxFetcher = async (url) => {
    if (url.includes("/public/instruments")) {
      return { data: [
        { instId: "BTC-USD-260605-66000-C" }, { instId: "BTC-USD-260605-66000-P" },
        { instId: "BTC-USD-260605-67500-C" }, { instId: "BTC-USD-260605-67500-P" },
        { instId: "BTC-USD_UM-260605-66000-C" }, // must be ignored
        { instId: "BTC-USD-260612-66000-C" }      // far expiry, ignored for 2d target
      ] };
    }
    // order book: call 0.009/0.0095, put 0.017/0.018 (BTC)
    if (url.includes("66000-C")) return { data: [{ bids: [["0.009", "944"]], asks: [["0.0095", "3992"]] }] };
    if (url.includes("66000-P")) return { data: [{ bids: [["0.017", "1805"]], asks: [["0.018", "1673"]] }] };
    return { data: [{ bids: [], asks: [] }] };
  };

  const r = await okxProbe({ spot: 66000, putStrike: 66000, callStrike: 66000, tenorDays: 2, nowMs: now, fetcher });
  assert.equal(r.ok, true);
  assert.equal(r.expiry_iso, new Date(Date.UTC(2026, 5, 5, 8, 0, 0)).toISOString(), "nearest expiry = 260605");
  const call = r.legs.find((l) => l.opt_type === "call")!;
  const put = r.legs.find((l) => l.opt_type === "put")!;
  // BTC→USDC: 0.009 × 66000 = 594 bid, 0.0095 × 66000 = 627 ask.
  assert.equal(call.bid_usdc_per_btc, 594);
  assert.equal(call.ask_usdc_per_btc, 627);
  // spread% = (627-594)/610.5 ≈ 0.054
  assert.ok(Math.abs(call.spread_pct! - 0.054) < 0.005);
  assert.equal(call.bid_size, 944);
  assert.ok(Math.abs(put.spread_pct! - 0.0571) < 0.005);
});

test("okxProbe: empty/garbage instruments → ok:false, not a throw", async () => {
  const fetcher: OkxFetcher = async () => ({ data: [{ instId: "ETH-USD-260605-3000-C" }] });
  const r = await okxProbe({ spot: 66000, putStrike: 66000, callStrike: 66000, tenorDays: 2, fetcher });
  assert.equal(r.ok, false);
  assert.equal(r.legs.length, 0);
});
