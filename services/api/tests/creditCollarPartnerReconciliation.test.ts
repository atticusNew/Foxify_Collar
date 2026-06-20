import assert from "node:assert/strict";
import test from "node:test";
import {
  reconcilePositions,
  StaticPartnerFeed,
  RestPartnerFeed,
  type PartnerPositionRecord
} from "../src/singleSide/twoSided/creditCollar/partnerReconciliation";

const NOW = 1_800_000_000_000;
const book = [{ ref: "a", notionalUsdc: 50_000 }, { ref: "b", notionalUsdc: 50_000 }];

const rec = (over: Partial<PartnerPositionRecord> & { ref: string }): PartnerPositionRecord => ({
  isOpen: true,
  sizeUsd: 50_000,
  markPriceUsd: 63_000,
  tsMs: NOW - 1000,
  ...over
});

test("reconcile: fresh open records pass through, feed healthy", () => {
  const r = reconcilePositions(book, [rec({ ref: "a" }), rec({ ref: "b" })], NOW);
  assert.equal(r.summary.fresh, 2);
  assert.equal(r.summary.feedHealthy, true);
  assert.equal(r.byRef["a"].isOpen, true);
});

test("reconcile: a closed record surfaces isOpen=false (drives orphan detection downstream)", () => {
  const r = reconcilePositions(book, [rec({ ref: "a", isOpen: false, sizeUsd: 0 }), rec({ ref: "b" })], NOW);
  assert.equal(r.byRef["a"].isOpen, false);
  assert.equal(r.summary.fresh, 2);
});

test("reconcile: MISSING record fails-closed (assume still open) + flag, feed unhealthy", () => {
  const r = reconcilePositions(book, [rec({ ref: "a" })], NOW); // no record for b
  assert.equal(r.byRef["b"].isOpen, true, "missing ⟹ assume open (never assume a close on bad data)");
  assert.equal(r.summary.missing, 1);
  assert.equal(r.summary.feedHealthy, false);
  assert.ok(r.positions.find((p) => p.ref === "b")!.flags.includes("missing_record"));
});

test("reconcile: STALE record fails-closed (assume open) + flag", () => {
  const r = reconcilePositions(book, [rec({ ref: "a" }), rec({ ref: "b", tsMs: NOW - 60_000 })], NOW, { maxStalenessMs: 15_000 });
  const b = r.positions.find((p) => p.ref === "b")!;
  assert.equal(b.dataQuality, "stale");
  assert.equal(b.partner.isOpen, true);
  assert.equal(r.summary.feedHealthy, false);
});

test("reconcile: size mismatch flagged on a fresh open record", () => {
  const r = reconcilePositions(book, [rec({ ref: "a", sizeUsd: 70_000 }), rec({ ref: "b" })], NOW, { sizeTolerancePct: 0.02 });
  assert.ok(r.positions.find((p) => p.ref === "a")!.flags.some((f) => /size_mismatch/.test(f)));
});

test("StaticPartnerFeed: returns set records filtered by ref", async () => {
  const feed = new StaticPartnerFeed();
  feed.setMany([rec({ ref: "a" }), rec({ ref: "c" })]);
  const got = await feed.fetchPositions(["a", "b"]);
  assert.equal(got.length, 1);
  assert.equal(got[0].ref, "a");
});

test("RestPartnerFeed: deps-injected fetcher+parser; network failure ⟹ empty (fails closed)", async () => {
  const good = new RestPartnerFeed(
    () => "http://x",
    (raw) => (raw as { positions: PartnerPositionRecord[] }).positions,
    async () => ({ positions: [rec({ ref: "a" }), rec({ ref: "z" })] })
  );
  const got = await good.fetchPositions(["a"]);
  assert.equal(got.length, 1);
  assert.equal(got[0].ref, "a");

  const bad = new RestPartnerFeed(() => "http://x", () => [], async () => { throw new Error("net down"); });
  assert.deepEqual(await bad.fetchPositions(["a"]), []);
});
