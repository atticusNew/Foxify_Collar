import assert from "node:assert/strict";
import test from "node:test";
import { computeBasisBps, assessBasis, partnerMarksToSamples } from "../src/singleSide/twoSided/creditCollar/basisGuard";

test("computeBasisBps: signed basis in bps", () => {
  assert.equal(computeBasisBps(63_000, 63_063), 10); // +10 bps
  assert.equal(computeBasisBps(63_000, 62_937), -10);
  assert.equal(computeBasisBps(0, 63_000), 0);
});

test("assessBasis: within tolerance ⟹ safe; wide basis ⟹ defer", () => {
  const ok = assessBasis(63_000, [{ venue: "binance", priceUsd: 63_010 }, { venue: "bybit", priceUsd: 62_995 }], 10);
  assert.equal(ok.withinTolerance, true);
  assert.equal(ok.safeToSettle, true);
  const wide = assessBasis(63_000, [{ venue: "thin", priceUsd: 63_500 }], 10); // ~79 bps
  assert.equal(wide.withinTolerance, false);
  assert.equal(wide.safeToSettle, false, "wide basis ⟹ do not settle on a divergent price");
  assert.ok(wide.maxAbsBasisBps > 10);
});

test("partnerMarksToSamples: tags partner sources for the oracle, drops junk", () => {
  const samples = partnerMarksToSamples([{ venue: "binance", priceUsd: 63_000 }, { venue: "bad", priceUsd: 0 }], 1000);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].source, "partner:binance");
  assert.equal(samples[0].tsMs, 1000);
});
