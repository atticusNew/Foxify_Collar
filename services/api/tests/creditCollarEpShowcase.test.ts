import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCOUNT_BANDS_USD,
  bucketOf,
  candidatesForBucket,
  dayKey,
  parseLeaderboardAll,
  heroIndex,
  missingBuckets,
  nextRotationIso,
  parseLeaderboardTop,
  parseShowcaseOverride,
  pickShowcaseSet,
  SHOWCASE_BUCKETS,
  SHOWCASE_SLOTS,
  type ShowcaseWallet,
} from "../src/singleSide/twoSided/creditCollar/epShowcase";

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

const w = (i: number, side: "long" | "short", notionalUsdc: number): ShowcaseWallet => ({ address: "0x" + String(i).padStart(40, "0"), side, szBase: notionalUsdc / 80_000, notionalUsdc });

test("showcase: three slots, longs only — two mediums and a large, in medium, large, medium order; small is classified but never lands", () => {
  assert.equal(bucketOf(4_999), null, "dust is outside every band");
  assert.equal(bucketOf(5_000), "small");
  assert.equal(bucketOf(24_999.99), "small");
  assert.equal(bucketOf(25_000), "medium");
  assert.equal(bucketOf(149_999), "medium");
  assert.equal(bucketOf(150_000), "large");
  assert.equal(bucketOf(750_000), null, "a nine-figure whale is not a relatable landing");
  assert.deepEqual(SHOWCASE_SLOTS, ["medium", "large", "medium"], "consecutive hours never repeat a size");
  assert.deepEqual(SHOWCASE_BUCKETS, ["medium", "large"]);

  const set = pickShowcaseSet([
    w(1, "short", 40_000), // a short: never the landing
    w(2, "long", 90_000_000), // whale: out of band
    w(3, "long", 60_000), // first medium
    w(4, "long", 70_000), // second medium: the third slot
    w(5, "long", 300_000), // large
    w(6, "long", 12_000), // small: a $12k long pays a thin credit; not the landing
    w(7, "long", 80_000), // a third medium: no slot left
  ]);
  assert.deepEqual(
    set.map((x) => [x.address.slice(-1), x.bucket]),
    [
      ["3", "medium"],
      ["5", "large"],
      ["4", "medium"],
    ],
  );
  assert.ok(set.every((x) => x.side === "long"));
  assert.deepEqual(missingBuckets(set), []);

  const partial = pickShowcaseSet([w(1, "long", 60_000), w(2, "long", 12_000)]);
  assert.deepEqual(partial.map((x) => x.bucket), ["medium"]);
  assert.deepEqual(missingBuckets(partial), ["large", "medium"], "one medium slot and the large slot still open: the scan keeps reading both bands");
  assert.deepEqual(missingBuckets(pickShowcaseSet([w(1, "long", 60_000), w(2, "long", 61_000)])), ["large"], "both mediums filled: only the large band is still read");

  const fallback = pickShowcaseSet([w(1, "long", 90_000_000), w(2, "short", 12_000), w(3, "long", 1_000), w(4, "long", 200_000_000), w(5, "long", 2_000)]);
  assert.deepEqual(fallback.map((x) => [x.address.slice(-1), x.bucket]), [["1", null], ["3", null], ["4", null]], "nothing in band: the first three longs, unlabelled, so the landing never goes dark");

  assert.deepEqual(pickShowcaseSet([w(1, "short", 40_000)]), [], "shorts alone leave the landing to the connect-first page");
  assert.deepEqual(pickShowcaseSet([w(1, "short", 40_000)], { sides: ["long", "short"] }).map((x) => x.bucket), ["medium"], "curated sets may include shorts");
});

test("showcase: the hour picks the hero, deterministically, and says when it rotates", () => {
  const t = Date.UTC(2026, 8, 21, 14, 37);
  assert.equal(heroIndex(3, t), Math.floor(t / 3_600_000) % 3);
  assert.equal(heroIndex(3, t), heroIndex(3, t + 20 * 60_000), "the same hour, the same hero");
  assert.equal((heroIndex(3, t) + 1) % 3, heroIndex(3, t + 3_600_000), "the next hour, the next one");
  assert.equal(heroIndex(0, t), 0);
  assert.equal(nextRotationIso(t), "2026-09-21T15:00:00.000Z");
});

test("showcase: the full parse reads the pretty-printed leaderboard with the day's volume; bands pick active accounts in a day-seeded order", () => {
  const row = (addr: string, value: string, vlm: string) =>
    `    {\n      "ethAddress": "${addr}",\n      "accountValue": "${value}",\n      "windowPerformances": [\n        [\n          "day",\n          {\n            "pnl": "1.0",\n            "roi": "0.01",\n            "vlm": "${vlm}"\n          }\n        ],\n        [\n          "week",\n          {\n            "pnl": "2.0",\n            "roi": "0.02",\n            "vlm": "999"\n          }\n        ]\n      ],\n      "prize": 0,\n      "displayName": null\n    }`;
  const A = "0x" + "a".repeat(40);
  const B = "0x" + "b".repeat(40);
  const C = "0x" + "c".repeat(40);
  const D = "0x" + "d".repeat(40);
  const raw = `{\n  "leaderboardRows": [\n${[row(A, "12000.5", "0.0"), row(B, "20000", "1500.25"), row(C, "45000", "80.0"), row(D, "0", "10")].join(",\n")}\n  ]\n}`;
  const all = parseLeaderboardAll(raw);
  assert.deepEqual(all, [
    { address: A, accountValueUsd: 12000.5, dayVolumeUsd: 0 },
    { address: B, accountValueUsd: 20000, dayVolumeUsd: 1500.25 },
    { address: C, accountValueUsd: 45000, dayVolumeUsd: 80 },
  ]);
  assert.deepEqual(parseLeaderboardAll('"ethAddress": "' + A + '", "accountValue": "50"'), [{ address: A, accountValueUsd: 50 }], "no window: volume absent, not zero");

  const small = candidatesForBucket(all, "small", "2026-09-21", 10);
  assert.ok(!small.includes(A), "no volume today: not a candidate");
  assert.deepEqual([...small].sort(), [B, C].sort(), `both active accounts sit in the small band (${ACCOUNT_BANDS_USD.small.minUsd}–${ACCOUNT_BANDS_USD.small.maxUsd})`);
  assert.deepEqual(candidatesForBucket(all, "small", "2026-09-21", 10), small, "same day, same order");
  assert.deepEqual(candidatesForBucket(all, "medium", "2026-09-21", 10), [C], "medium band starts at $30k");
  assert.deepEqual(candidatesForBucket(all, "large", "2026-09-21", 10), []);
  assert.deepEqual(candidatesForBucket([{ address: A, accountValueUsd: 20000 }], "small", "2026-09-21", 10), [A], "a parse without volume does not filter on it");
  assert.equal(dayKey(Date.UTC(2026, 8, 21, 23, 59)), "2026-09-21");
});
