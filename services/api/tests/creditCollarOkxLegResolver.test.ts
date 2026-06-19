import assert from "node:assert/strict";
import test from "node:test";
import {
  selectCollarInstruments,
  resolveCollarLegs,
  isOptionsNotActivatedMsg
} from "../src/singleSide/twoSided/creditCollar/execution/okxLegResolver";

const DAY = 86_400_000;
const now = Date.UTC(2026, 5, 19, 0, 0, 0); // 2026-06-19

// Two expiries: 2026-06-20 (1d) and 2026-06-26 (7d), each 08:00 UTC OKX convention.
const universe = [
  "BTC-USD-260620-60000-P",
  "BTC-USD-260620-61000-P",
  "BTC-USD-260620-63000-C",
  "BTC-USD-260620-64000-C",
  "BTC-USD-260626-61000-P",
  "BTC-USD-260626-64000-C",
  "ETH-USD-260620-3000-C",            // wrong underlying / unparsable as BTC-USD → ignored
  "BTC-USD-260620-62000-C_UM"         // unified-margin variant → unparsable → ignored
];

test("selectCollarInstruments: nearest expiry + nearest strikes", () => {
  const sel = selectCollarInstruments(universe, { nowMs: now, tenorDays: 1, putTarget: 60800, callTarget: 63600 });
  assert.ok(sel);
  assert.equal(sel!.putInstId, "BTC-USD-260620-61000-P"); // 61000 closer to 60800 than 60000
  assert.equal(sel!.callInstId, "BTC-USD-260620-64000-C"); // 64000 closer to 63600 than 63000
  assert.equal(sel!.putStrike, 61000);
  assert.equal(sel!.callStrike, 64000);
});

test("selectCollarInstruments: longer tenor picks the far expiry", () => {
  const sel = selectCollarInstruments(universe, { nowMs: now, tenorDays: 7, putTarget: 61000, callTarget: 64000 });
  assert.ok(sel);
  assert.equal(sel!.putInstId, "BTC-USD-260626-61000-P");
  assert.equal(sel!.callInstId, "BTC-USD-260626-64000-C");
});

test("selectCollarInstruments: returns null when no put+call exist", () => {
  assert.equal(selectCollarInstruments(["ETH-USD-260620-3000-C"], { nowMs: now, tenorDays: 1, putTarget: 1, callTarget: 1 }), null);
  assert.equal(selectCollarInstruments([], { nowMs: now, tenorDays: 1, putTarget: 1, callTarget: 1 }), null);
});

test("resolveCollarLegs: pulls instIds from the ACTIVE env list + top-of-book quotes", async () => {
  const list = async () => ({ ok: true, data: universe.map((instId) => ({ instId })) });
  const readBook = async (instId: string) => ({
    ok: true,
    data: [{ bids: [["0.0009", "5"]], asks: [["0.0011", "5"]] }]
  });
  const r = await resolveCollarLegs(list, readBook, { nowMs: now, tenorDays: 1, putTarget: 61000, callTarget: 64000 });
  assert.ok(r.ok && r.legs);
  assert.equal(r.legs!.putInstId, "BTC-USD-260620-61000-P");
  assert.equal(r.legs!.putAskBtc, 0.0011);  // ask used for the bought put
  assert.equal(r.legs!.callBidBtc, 0.0009); // bid used for the sold call
});

test("resolveCollarLegs: empty env list ⟹ no_matching_instruments_in_env (the demo 51001 case)", async () => {
  const list = async () => ({ ok: true, data: [] as Array<{ instId?: string }> });
  const readBook = async () => ({ ok: true, data: [] as Array<{ bids?: string[][]; asks?: string[][] }> });
  const r = await resolveCollarLegs(list, readBook, { nowMs: now, tenorDays: 1, putTarget: 61000, callTarget: 64000 });
  assert.equal(r.ok, false);
  assert.equal(r.error, "no_matching_instruments_in_env");
});

test("resolveCollarLegs: instruments fetch failure surfaces cleanly", async () => {
  const list = async () => ({ ok: false, data: [] as Array<{ instId?: string }> });
  const readBook = async () => ({ ok: true, data: [] as Array<{ bids?: string[][]; asks?: string[][] }> });
  const r = await resolveCollarLegs(list, readBook, { nowMs: now, tenorDays: 1, putTarget: 61000, callTarget: 64000 });
  assert.equal(r.ok, false);
  assert.equal(r.error, "instruments_fetch_failed");
});

test("isOptionsNotActivatedMsg detects the OKX activation prompt", () => {
  assert.equal(isOptionsNotActivatedMsg("Visit the options trading page on the app or web, then click any symbol on the options chain to activate trading. "), true);
  assert.equal(isOptionsNotActivatedMsg("Order placed"), false);
  assert.equal(isOptionsNotActivatedMsg(null), false);
});
