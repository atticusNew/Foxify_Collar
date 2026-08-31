import assert from "node:assert/strict";
import test from "node:test";
import { parseLeaderboardTop, parseShowcaseOverride } from "../src/singleSide/twoSided/creditCollar/epShowcase";

test("showcase: extracts top leaderboard addresses by account value from raw JSON text", () => {
  const raw = JSON.stringify({
    leaderboardRows: [
      { ethAddress: "0x" + "a".repeat(40), accountValue: "1000.50", windowPerformances: [], prize: 0, displayName: null },
      { ethAddress: "0x" + "B".repeat(40), accountValue: "99999.01", windowPerformances: [], prize: 0, displayName: "whale" },
      { ethAddress: "0x" + "c".repeat(40), accountValue: "5.25", windowPerformances: [], prize: 0, displayName: null }
    ]
  });
  const top = parseLeaderboardTop(raw, 2);
  assert.equal(top.length, 2);
  assert.equal(top[0].address, "0x" + "b".repeat(40)); // lowercased, biggest first
  assert.equal(top[0].accountValueUsd, 99999.01);
  assert.equal(top[1].address, "0x" + "a".repeat(40));
});

test("showcase: garbage rows and non-positive values never make the list", () => {
  const raw = '"ethAddress": "not-an-address", "accountValue": "50" ' +
    '"ethAddress": "0x' + "d".repeat(40) + '", "accountValue": "0" ' +
    '"ethAddress": "0x' + "e".repeat(40) + '", "accountValue": "12.5"';
  const top = parseLeaderboardTop(raw, 10);
  assert.equal(top.length, 1);
  assert.equal(top[0].address, "0x" + "e".repeat(40));
});

test("showcase: env override parses messy comma lists and drops invalid entries", () => {
  const addr = "0x" + "f".repeat(40);
  assert.deepEqual(parseShowcaseOverride(` ${addr.toUpperCase()} , nope, `), [addr]);
  assert.deepEqual(parseShowcaseOverride(undefined), []);
});
