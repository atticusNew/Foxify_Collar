import assert from "node:assert/strict";
import test from "node:test";
import { CreditCollarActivationScaffold, type ScaffoldConfig } from "../src/singleSide/twoSided/creditCollar/activationScaffold";
import { linearDownsideSkew } from "../src/singleSide/twoSided/creditCollar/skew";
import { aggregateOracle, signSnapshot, generateOracleKeyPair, type PriceSample, type OracleTick } from "../src/singleSide/twoSided/creditCollar/referenceOracle";

const SPOT = 100_000;
const skew = linearDownsideSkew(SPOT, 0.55, 0.12);

const cfg = (over: Partial<ScaffoldConfig> = {}): ScaffoldConfig => ({
  tiers: [
    { tier: 0, maxDailyNotionalUsdc: 1_000_000, live: false },
    { tier: 1, maxDailyNotionalUsdc: 5_000_000, live: true }
  ],
  policy: { targetNetBandPct: 0.1, allowDirectionalBias: false, directionalTiltSigned: 0 },
  breaker: { warnBandPct: 0.1, haltBandPct: 0.15, resumeBandPct: 0.08, minGrossNotionalUsd: 150_000 },
  serviceFeeBps: 2,
  minServiceFeeUsdc: 10,
  maxFloorPct: 0.04,
  tenorDays: 1,
  liveEnabled: false, // DEFAULT-OFF: everything shadow regardless of tier.live
  ...over
});

test("scaffold: default-off ⟹ activations are shadow even on a live-marked tier", () => {
  const s = new CreditCollarActivationScaffold(cfg(), skew);
  const instr = s.nextInstruction(50_000);
  assert.ok(instr.ok);
  if (!instr.ok) return;
  const rec = s.activate({ ref: instr.ref, side: instr.side, notionalUsdc: 50_000, spot: SPOT });
  assert.ok("status" in rec && rec.status === "active");
  if ("mode" in rec) assert.equal(rec.mode, "shadow", "liveEnabled=false ⟹ shadow");
});

test("scaffold: instruction stream steers net flat", () => {
  const s = new CreditCollarActivationScaffold(cfg(), skew);
  // First open long; the next instruction should steer short to flatten.
  const i1 = s.nextInstruction(50_000);
  assert.ok(i1.ok);
  if (!i1.ok) return;
  s.activate({ ref: i1.ref, side: "long", notionalUsdc: 50_000, spot: SPOT });
  const i2 = s.nextInstruction(50_000);
  assert.ok(i2.ok);
  if (!i2.ok) return;
  assert.equal(i2.side, "short", "after a long, steer short to flatten net delta");
});

test("scaffold: manufactured offsetting pair is HARD-rejected (short-gamma bleed)", () => {
  const s = new CreditCollarActivationScaffold(cfg(), skew);
  s.activate({ ref: "a", side: "long", notionalUsdc: 50_000, spot: SPOT });
  const rej = s.activate({ ref: "b", side: "short", notionalUsdc: 50_000, spot: SPOT, pairedWithRef: "a" });
  assert.equal("ok" in rej && rej.ok === false, true);
  if ("error" in rej) assert.equal(rej.error, "manufactured_pair_rejected");
});

test("scaffold: exposure breaker halts new opens when the book goes directional", () => {
  const s = new CreditCollarActivationScaffold(cfg(), skew);
  // Pile several same-side opens to push exposure past the halt band.
  for (let i = 0; i < 5; i++) {
    const instr = s.nextInstruction(50_000);
    // Force directional: ignore the steer recommendation and always open long.
    if (instr.ok) s.activate({ ref: `d${i}`, side: "long", notionalUsdc: 50_000, spot: SPOT });
  }
  const next = s.nextInstruction(50_000);
  assert.equal(next.ok, false, "breaker must halt new instructions once the book is directional");
  if (!next.ok) assert.equal(next.halted, true);
});

test("scaffold: settlement requires a VALID ECDSA oracle snapshot (fail-closed) and nets the credit", () => {
  const s = new CreditCollarActivationScaffold(cfg(), skew);
  const rec = s.activate({ ref: "p1", side: "long", notionalUsdc: 50_000, spot: SPOT, instrument: "BTC-PERP", tsMs: Date.now() });
  assert.ok("status" in rec && rec.status === "active");
  if (!("putStrike" in rec)) return;

  const now = 2_000_000;
  const samples: PriceSample[] = [
    { source: "bullish", priceUsd: 92_000, tsMs: now - 200 },
    { source: "deribit", priceUsd: 92_050, tsMs: now - 200 },
    { source: "coinbase", priceUsd: 91_980, tsMs: now - 200 }
  ];
  const snap = aggregateOracle(samples, now);
  const atticus = generateOracleKeyPair();
  const sig = signSnapshot(snap, atticus.privateKeyPem);
  const ticks: OracleTick[] = [
    { tsMs: 0, priceUsd: 92_000 },
    { tsMs: 900_000, priceUsd: 92_000 }
  ];

  // Wrong public key ⟹ fail-closed.
  const impostor = generateOracleKeyPair();
  const bad = s.settle({
    ref: "p1", side: "long", notionalUsdc: 50_000, spotAtEntry: SPOT, putStrike: rec.putStrike, callStrike: rec.callStrike,
    foxifyCreditUsdc: rec.foxifyCreditUsdc, settlementTwapTicks: ticks, windowStartMs: 0, windowEndMs: 1_800_000,
    signedSnapshot: { snapshot: snap, signatureHex: sig }, oraclePublicKeyPem: impostor.publicKeyPem, venueLegs: []
  });
  assert.equal("ok" in bad && bad.ok === false, true);

  // Correct public key ⟹ settles; deep down-move ⟹ long put pays; credit netted in.
  const good = s.settle({
    ref: "p1", side: "long", notionalUsdc: 50_000, spotAtEntry: SPOT, putStrike: rec.putStrike, callStrike: rec.callStrike,
    foxifyCreditUsdc: rec.foxifyCreditUsdc, settlementTwapTicks: ticks, windowStartMs: 0, windowEndMs: 1_800_000,
    signedSnapshot: { snapshot: snap, signatureHex: sig }, oraclePublicKeyPem: atticus.publicKeyPem,
    venueLegs: [{ ref: "p1", kind: "put", venue: "paper", filled: true }, { ref: "p1", kind: "call", venue: "paper", filled: true }]
  });
  assert.ok("status" in good && good.status === "settled");
  if ("payoutToFoxifyUsdc" in good) {
    assert.ok(good.oracleVerified);
    assert.ok(good.payoutToFoxifyUsdc > 0, "−8% move below the put floor ⟹ positive payout to Foxify");
    assert.equal(good.reconciliation.matched, true, "both legs reconcile");
  }
});
