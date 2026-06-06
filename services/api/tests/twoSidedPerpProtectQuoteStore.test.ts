/**
 * Perp Protect quote snapshot store — TTL get/put/prune (Phase-2 /activate enabler).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryPerpProtectQuoteStore, type PerpProtectQuoteSnapshot } from "../src/singleSide/twoSided/perpProtectQuoteStore";

const snap = (id: string, expiresAtMs: number): PerpProtectQuoteSnapshot => ({
  quote_id: id,
  created_at_ms: expiresAtMs - 30_000,
  expires_at_ms: expiresAtMs,
  position: { side: "long", size_btc: 0.5, entry_price: 60000, leverage: 20, tenor_days: 7, spot: 60000, settlement_style: "european", liquidation_prevented: false },
  options: [{
    id: "single-0", structure: "put", strike: 58000, short_strike: null, premium_usdc: 400, hedge_cost_usdc: 350,
    legs: [{ role: "long", venue: "deribit", instrument: "BTC-7JUN26-58000-P", strike: 58000, expiry_iso: "2026-06-07T08:00:00.000Z", ask_usdc_per_btc: 700, bid_usdc_per_btc: null }]
  }]
});

test("put then get within TTL returns the snapshot with its legs", () => {
  const s = new InMemoryPerpProtectQuoteStore();
  s.put(snap("q1", 1_000_000));
  const got = s.get("q1", 999_000);
  assert.ok(got);
  assert.equal(got!.options[0].legs[0].instrument, "BTC-7JUN26-58000-P");
  assert.equal(got!.options[0].legs[0].venue, "deribit");
});

test("get after expiry returns null and evicts", () => {
  const s = new InMemoryPerpProtectQuoteStore();
  s.put(snap("q2", 1_000_000));
  assert.equal(s.get("q2", 1_000_001), null);
  assert.equal(s.size(), 0);
});

test("get unknown id returns null", () => {
  const s = new InMemoryPerpProtectQuoteStore();
  assert.equal(s.get("nope"), null);
});

test("prune drops only expired entries", () => {
  const s = new InMemoryPerpProtectQuoteStore();
  s.put(snap("old", 1_000_000));
  s.put(snap("new", 2_000_000));
  const pruned = s.prune(1_500_000);
  assert.equal(pruned, 1);
  assert.equal(s.get("new", 1_500_000)?.quote_id, "new");
  assert.equal(s.size(), 1);
});

test("capacity bound evicts to make room", () => {
  const s = new InMemoryPerpProtectQuoteStore(2);
  s.put(snap("a", 1_000_000));
  s.put(snap("b", 1_100_000));
  s.put(snap("c", 1_200_000)); // exceeds cap of 2 → evicts oldest-by-expiry (a)
  assert.ok(s.size() <= 2);
  assert.equal(s.get("a", 900_000), null);
});
