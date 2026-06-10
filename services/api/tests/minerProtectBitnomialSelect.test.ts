/**
 * Miner Protect — HUPO option selector scaffolding (symbol parse + nearest expiry/strike put).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { parseHupoSymbol, selectHashpriceFloorPut, MONTH_CODE } from "../src/minerProtect/bitnomialOptionSelect";
import type { BitnomialBook } from "../src/minerProtect/bitnomialPricefeed";

const book = (best_ask: number | null, best_bid: number | null = null): BitnomialBook =>
  ({ symbol: "x", bids: [], asks: [], best_ask, best_bid, mid: best_ask, ts: null });

test("parseHupoSymbol: both plausible formats; Z = December; null on unknown", () => {
  assert.equal(MONTH_CODE.Z, 11);
  const a = parseHupoSymbol("HUPZ26-100-P")!;
  assert.equal(a.optType, "put"); assert.equal(a.strike, 100);
  assert.equal(new Date(a.expiryMs).getUTCFullYear(), 2026);
  assert.equal(new Date(a.expiryMs).getUTCMonth(), 11);
  const b = parseHupoSymbol("HUPM27C85")!;
  assert.equal(b.optType, "call"); assert.equal(b.strike, 85);
  assert.equal(new Date(b.expiryMs).getUTCMonth(), 5); // M = June
  assert.equal(parseHupoSymbol("NOT-A-HUPO"), null);
});

test("selectHashpriceFloorPut: nearest expiry, then strike nearest target; puts only, must be quoted", () => {
  const now = Date.UTC(2026, 5, 1); // June 2026
  const targetExpiry = Date.UTC(2026, 6, 25); // ~July
  const books: Record<string, BitnomialBook> = {
    "HUPN26-90-P": book(2.0),   // July put @90  (nearest expiry; strike 90)
    "HUPN26-100-P": book(3.5),  // July put @100 (nearest expiry; strike 100 ← closest to target 95)
    "HUPN26-100-C": book(1.0),  // call → ignored
    "HUPZ26-100-P": book(5.0),  // Dec put → farther expiry
    "HUPN26-95-P": book(null, null) // no quote → ignored
  };
  const pick = selectHashpriceFloorPut(books, { targetStrikeUsdPerPhDay: 98, targetExpiryMs: targetExpiry, nowMs: now });
  assert.ok(pick);
  assert.equal(pick!.symbol, "HUPN26-100-P"); // July (nearest), strike 100 closest to 98, has an ask
  assert.equal(pick!.best_ask, 3.5);
});

test("selectHashpriceFloorPut: null when no quoted puts", () => {
  const now = Date.UTC(2026, 5, 1);
  const books: Record<string, BitnomialBook> = { "HUPN26-100-C": book(1.0), "HUPN26-100-P": book(null, null) };
  assert.equal(selectHashpriceFloorPut(books, { targetStrikeUsdPerPhDay: 100, targetExpiryMs: Date.UTC(2026, 6, 25), nowMs: now }), null);
});
