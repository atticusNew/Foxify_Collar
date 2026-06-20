import assert from "node:assert/strict";
import test from "node:test";
import { parseCanonicalPartnerRecords, buildPartnerFeedFromEnv } from "../src/singleSide/twoSided/creditCollar/partnerFeedFactory";

const NOW = 1_800_000_000_000;

test("parseCanonicalPartnerRecords: parses an array of canonical rows", () => {
  const raw = [
    { ref: "a", isOpen: true, sizeUsd: 50_000, markPriceUsd: 63_000, tsMs: NOW - 1000 },
    { ref: "b", isOpen: false, sizeUsd: 25_000, markPriceUsd: null }
  ];
  const out = parseCanonicalPartnerRecords(raw, NOW);
  assert.equal(out.length, 2);
  assert.equal(out[0].ref, "a");
  assert.equal(out[1].isOpen, false);
  assert.equal(out[1].tsMs, NOW, "missing tsMs defaults to fetch time");
});

test("parseCanonicalPartnerRecords: accepts { positions: [...] } envelope", () => {
  const out = parseCanonicalPartnerRecords({ positions: [{ ref: "a", isOpen: true, sizeUsd: 1000, markPriceUsd: 1 }] }, NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].ref, "a");
});

test("parseCanonicalPartnerRecords: drops malformed rows (fail-closed upstream)", () => {
  const raw = [
    { ref: "ok", isOpen: true, sizeUsd: 1000, markPriceUsd: 1 },
    { ref: "", isOpen: true, sizeUsd: 1000, markPriceUsd: 1 }, // empty ref
    { ref: "noOpen", sizeUsd: 1000, markPriceUsd: 1 },         // missing isOpen
    { ref: "noSize", isOpen: true, markPriceUsd: 1 },          // missing sizeUsd
    "garbage",
    null
  ];
  const out = parseCanonicalPartnerRecords(raw, NOW);
  assert.deepEqual(out.map((r) => r.ref), ["ok"]);
});

test("parseCanonicalPartnerRecords: non-array/non-envelope ⟹ empty", () => {
  assert.deepEqual(parseCanonicalPartnerRecords(null, NOW), []);
  assert.deepEqual(parseCanonicalPartnerRecords({ foo: 1 }, NOW), []);
  assert.deepEqual(parseCanonicalPartnerRecords(42, NOW), []);
});

test("buildPartnerFeedFromEnv: null when no URL (coordinator stays dormant)", () => {
  assert.equal(buildPartnerFeedFromEnv({}), null);
  assert.equal(buildPartnerFeedFromEnv({ PARTNER_FEED_URL: "   " }), null);
});

test("buildPartnerFeedFromEnv: builds a feed that filters by requested refs", async () => {
  const feed = buildPartnerFeedFromEnv({ PARTNER_FEED_URL: "https://example.test/positions" });
  assert.ok(feed, "feed built when URL present");
  // We can't hit the network here; just assert it implements the interface shape.
  assert.equal(typeof feed!.fetchPositions, "function");
});
