import assert from "node:assert/strict";
import test from "node:test";
import {
  assessDemoWrap,
  capTouched,
  concludeAtExpiry,
  concludeWrapEarly,
  cyclePayable,
  demoVestingStatus,
  floorPayoutUsdc,
  knockoutWrap,
  newDemoWrap,
  renewalDecision,
  renewalStaggerOffsetMs,
  wrapCapStrike,
  wrapFloorStrike,
  type DemoGuardsConfig,
  type DemoWrapRecord
} from "../src/singleSide/twoSided/creditCollar/demoWrap";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

const guards = (over: Partial<DemoGuardsConfig> = {}): DemoGuardsConfig => ({
  enabled: true,
  executionMode: "paper",
  maxPositionNotionalUsdc: 1_000,
  maxWrapsPerDay: 10,
  maxWrapsPerDayGlobal: 500,
  cooldownMs: 0,
  maxBookNotionalUsdc: 25_000,
  maxActiveWraps: 25,
  ...over
});

/** An ACTIVE long wrap mid-cycle: spot 64.5k, floor 60.6k put, cap 65.5k call, $1.04 credit. */
const activeWrap = (over: Partial<DemoWrapRecord> = {}): DemoWrapRecord => ({
  ...newDemoWrap("wrap-ko", NOW - DAY / 2, "hyperliquid", "0x00000000000000000000000000000000000abc01", {
    coin: "BTC",
    side: "long",
    szBase: 0.01,
    entryPx: 64_000,
    markPx: 64_500,
    notionalUsdc: 645
  }),
  quote: {
    spot: 64_500,
    putStrike: 60_600,
    callStrike: 65_500,
    floorPct: 0.06,
    capPct: 0.015,
    creditUsdc: 1.04,
    quotedCreditUsdc: 1.04,
    floorStrike: 60_600,
    capStrike: 65_500,
    floorPctUsed: 0.06,
    tenorDays: 1
  },
  hedge: { venue: "okx_model", mode: "paper", netCreditUsdc: 1.04, venueFeeUsdc: 0.1, contracts: 1, sizeNote: null },
  vesting: { fullCreditUsdc: 1.04, startMs: NOW - DAY / 2, endMs: NOW + DAY / 2 },
  status: "active",
  ...over
});

/** The SHORT mirror: cap is the sold put BELOW spot, floor the bought call above. */
const activeShortWrap = (): DemoWrapRecord =>
  activeWrap({
    position: { coin: "BTC", side: "short", szBase: 0.01, entryPx: 64_000, markPx: 64_500, notionalUsdc: 645 },
    quote: {
      spot: 64_500,
      putStrike: 63_500,
      callStrike: 68_400,
      floorPct: 0.06,
      capPct: 0.015,
      creditUsdc: 1.04,
      quotedCreditUsdc: 1.04,
      floorStrike: 68_400,
      capStrike: 63_500,
      floorPctUsed: 0.06,
      tenorDays: 1
    }
  });

// ── cap touch predicate (mark-price touch, NO buffer) ─────────────────────────

test("capTouched: long — at-or-through the cap counts, below does not", () => {
  assert.equal(capTouched("long", 65_500, 65_499.99), false);
  assert.equal(capTouched("long", 65_500, 65_500), true); // exact touch, no buffer
  assert.equal(capTouched("long", 65_500, 66_000), true);
});

test("capTouched: short mirrors — cap is BELOW spot", () => {
  assert.equal(capTouched("short", 63_500, 63_500.01), false);
  assert.equal(capTouched("short", 63_500, 63_500), true);
  assert.equal(capTouched("short", 63_500, 62_000), true);
});

test("wrapCapStrike/wrapFloorStrike: side-aware, with fallback for records without display strikes", () => {
  assert.equal(wrapCapStrike(activeWrap()), 65_500);
  assert.equal(wrapFloorStrike(activeWrap()), 60_600);
  assert.equal(wrapCapStrike(activeShortWrap()), 63_500);
  assert.equal(wrapFloorStrike(activeShortWrap()), 68_400);
  // legacy record without floorStrike/capStrike: derive from side + put/call
  const legacy = activeWrap();
  delete (legacy.quote as Record<string, unknown>).capStrike;
  delete (legacy.quote as Record<string, unknown>).floorStrike;
  assert.equal(wrapCapStrike(legacy), 65_500);
  assert.equal(wrapFloorStrike(legacy), 60_600);
  assert.equal(wrapCapStrike(activeWrap({ quote: null })), null);
});

// ── knockout state machine ────────────────────────────────────────────────────

test("knockoutWrap: touch → knocked_out, vesting frozen at the touch, metadata recorded", () => {
  const r = activeWrap();
  const v = knockoutWrap(r, NOW, 65_510, null)!; // half the tenor elapsed
  assert.equal(r.status, "knocked_out");
  assert.equal(r.concludedAtMs, NOW);
  assert.equal(v.vestedUsdc, 0.52); // 50% of $1.04 vested-to-touch
  assert.deepEqual(r.knockout, { touchedAtMs: NOW, markPx: 65_510, capStrike: 65_500, unwindValueUsdc: null });
  assert.equal(r.stages[r.stages.length - 1].stage, "knocked_out");
  assert.match(r.stages[r.stages.length - 1].note!, /cap \$65500 touched at mark \$65510/);
  assert.match(r.stages[r.stages.length - 1].note!, /\$0\.52 vested-to-touch of \$1\.04/);
  // Frozen: polling later never shows more vested.
  assert.equal(demoVestingStatus(r, NOW + DAY)!.vestedUsdc, 0.52);
});

test("knockoutWrap: records the realized unwind value from the okx lanes", () => {
  const r = activeWrap();
  knockoutWrap(r, NOW, 65_510, -3.21);
  assert.equal(r.knockout!.unwindValueUsdc, -3.21);
});

test("knockoutWrap: refuses non-active wraps and wraps without a quote", () => {
  assert.equal(knockoutWrap(activeWrap({ status: "failed" }), NOW, 66_000), null);
  assert.equal(knockoutWrap(activeWrap({ vesting: null }), NOW, 66_000), null);
  assert.equal(knockoutWrap(activeWrap({ quote: null }), NOW, 66_000), null);
});

test("knocked_out frees the account: a new wrap may open (re-arm)", () => {
  const r = activeWrap();
  knockoutWrap(r, NOW, 65_510);
  const res = assessDemoWrap(guards(), NOW + 60_000, 645, [r], r.account);
  assert.deepEqual(res, { ok: true });
});

// ── re-arm via the renewal loop ───────────────────────────────────────────────

test("renewalDecision: knocked_out re-arms on the NEXT tick (skips the retry throttle once)", () => {
  const r = activeWrap();
  knockoutWrap(r, NOW, 65_510);
  // lastRenewAttemptMs predates the knockout ⟹ immediate retry_wrap
  const pref = { on: true, sinceMs: NOW - DAY, lastRenewAttemptMs: NOW - DAY / 2 };
  assert.equal(renewalDecision(pref, r, NOW + 1_000, 900_000), "retry_wrap");
  // a refused re-arm attempt stamps the throttle: no hammering afterwards
  const stamped = { ...pref, lastRenewAttemptMs: NOW + 1_000 };
  assert.equal(renewalDecision(stamped, r, NOW + 2_000, 900_000), "none");
  assert.equal(renewalDecision(stamped, r, NOW + 1_000 + 900_000, 900_000), "retry_wrap");
  // toggle off ⟹ nothing re-arms
  assert.equal(renewalDecision({ on: false, sinceMs: NOW }, r, NOW + 1_000, 900_000), "none");
});

// ── staggered renewals (decision 7) ───────────────────────────────────────────

test("renewalStaggerOffsetMs: deterministic, inside [0, window), spreads accounts", () => {
  const w = 1_800_000;
  const a = renewalStaggerOffsetMs("0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", w);
  const b = renewalStaggerOffsetMs("0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", w);
  assert.equal(a, renewalStaggerOffsetMs("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", w)); // case-insensitive, stable
  assert.ok(a >= 0 && a < w);
  assert.ok(b >= 0 && b < w);
  assert.notEqual(a, b); // different accounts land on different anchors
  assert.equal(renewalStaggerOffsetMs("0xabc", 0), 0); // window off ⟹ no offset
});

test("renewalDecision: an expired wrap waits for its stagger anchor, then renews", () => {
  const pref = { on: true, sinceMs: NOW - 2 * DAY };
  const expired = activeWrap({ vesting: { fullCreditUsdc: 1.04, startMs: NOW - DAY, endMs: NOW } });
  const offset = 600_000; // this account's anchor: 10 minutes after the fixing
  assert.equal(renewalDecision(pref, expired, NOW + 1, 900_000, offset), "none"); // inside the window
  assert.equal(renewalDecision(pref, expired, NOW + offset - 1, 900_000, offset), "none");
  assert.equal(renewalDecision(pref, expired, NOW + offset, 900_000, offset), "expire_and_renew");
  // default (no stagger arg) keeps the old behavior — existing callers unchanged
  assert.equal(renewalDecision(pref, expired, NOW + 1, 900_000), "expire_and_renew");
});

// ── floor payout ──────────────────────────────────────────────────────────────

test("floorPayoutUsdc: long pays below the floor, zero inside it", () => {
  assert.equal(floorPayoutUsdc("long", 60_600, 58_000, 0.01), 26); // (60600−58000) × 0.01
  assert.equal(floorPayoutUsdc("long", 60_600, 60_600, 0.01), 0);
  assert.equal(floorPayoutUsdc("long", 60_600, 64_000, 0.01), 0);
});

test("floorPayoutUsdc: short mirrors — pays ABOVE the floor", () => {
  assert.equal(floorPayoutUsdc("short", 68_400, 70_000, 0.01), 16); // (70000−68400) × 0.01
  assert.equal(floorPayoutUsdc("short", 68_400, 64_000, 0.01), 0);
});

test("floorPayoutUsdc: zero size or degenerate inputs pay nothing", () => {
  assert.equal(floorPayoutUsdc("long", 60_600, 58_000, 0), 0);
  assert.equal(floorPayoutUsdc("long", 0, 58_000, 0.01), 0);
});

// ── cycle settlement (what the trader is owed) ────────────────────────────────

test("cyclePayable: natural expiry inside the floor ⟹ full credit, no floor payout", () => {
  const r = activeWrap();
  concludeAtExpiry(r, NOW + DAY / 2 + 1);
  const p = cyclePayable(r, 64_800)!;
  assert.equal(p.kind, "expiry");
  assert.equal(p.creditUsdc, 1.04);
  assert.equal(p.floorPayoutUsdc, 0);
  assert.equal(p.totalUsdc, 1.04);
});

test("cyclePayable: expired THROUGH the floor ⟹ full credit + protective payout", () => {
  const r = activeWrap();
  concludeAtExpiry(r, NOW + DAY / 2 + 1);
  const p = cyclePayable(r, 58_000)!; // settle print $2,600 under the $60,600 floor × 0.01 BTC
  assert.equal(p.kind, "expiry");
  assert.equal(p.creditUsdc, 1.04);
  assert.equal(p.floorPayoutUsdc, 26);
  assert.equal(p.totalUsdc, 27.04);
});

test("cyclePayable: SHORT expiry through its (call) floor pays the mirror", () => {
  const r = activeShortWrap();
  concludeAtExpiry(r, NOW + DAY / 2 + 1);
  const p = cyclePayable(r, 70_000)!;
  assert.equal(p.floorPayoutUsdc, 16);
  assert.equal(p.totalUsdc, 17.04);
});

test("cyclePayable: knockout ⟹ vested-to-touch, no floor payout", () => {
  const r = activeWrap();
  knockoutWrap(r, NOW, 65_510); // half the tenor
  const p = cyclePayable(r, 65_510)!;
  assert.equal(p.kind, "knockout");
  assert.equal(p.creditUsdc, 0.52);
  assert.equal(p.floorPayoutUsdc, 0);
  assert.equal(p.totalUsdc, 0.52);
});

test("cyclePayable: voluntary early close ⟹ vested-to-close only", () => {
  const r = activeWrap();
  concludeWrapEarly(r, NOW - DAY / 4); // quarter of the tenor elapsed
  const p = cyclePayable(r, null)!;
  assert.equal(p.kind, "early_close");
  assert.equal(p.creditUsdc, 0.26);
  assert.equal(p.totalUsdc, 0.26);
});

test("cyclePayable: open or failed wraps owe nothing (credit is paid at conclusion, never upfront)", () => {
  assert.equal(cyclePayable(activeWrap(), 64_800), null);
  assert.equal(cyclePayable(activeWrap({ status: "failed" }), 64_800), null);
  assert.equal(cyclePayable(activeWrap({ vesting: null, status: "concluded" }), 64_800), null);
});
