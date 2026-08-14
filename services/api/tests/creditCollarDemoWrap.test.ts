import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assessDemoWrap,
  concludeWrapEarly,
  demoVestingStatus,
  failWrap,
  loadDemoWraps,
  newDemoWrap,
  paperInstId,
  paperLegsFromQuote,
  parseDemoGuardsFromEnv,
  coverOkxLots,
  uncoveredSizeNote,
  OKX_OPTION_LOT_BTC,
  pushStage,
  saveDemoWraps,
  scaledCreditTarget,
  wrapRefuseFromLive,
  type DemoGuardsConfig,
  type DemoWrapRecord
} from "../src/singleSide/twoSided/creditCollar/demoWrap";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

const guards = (over: Partial<DemoGuardsConfig> = {}): DemoGuardsConfig => ({
  enabled: true,
  executionMode: "paper",
  maxPositionNotionalUsdc: 1_000,
  maxWrapsPerDay: 3,
  cooldownMs: 30_000,
  ...over
});

const wrap = (over: Partial<DemoWrapRecord> = {}): DemoWrapRecord => ({
  ...newDemoWrap("wrap-1", NOW - 3_600_000, "hyperliquid", "0xabc", {
    coin: "BTC",
    side: "long",
    szBase: 0.001,
    entryPx: 64_000,
    markPx: 64_500,
    notionalUsdc: 64.5
  }),
  ...over
});

// ── guards ────────────────────────────────────────────────────────────────────

test("demo wrap: kill switch off refuses everything", () => {
  const res = assessDemoWrap(guards({ enabled: false }), NOW, 100, []);
  assert.equal(res.ok, false);
  assert.match((res as { reason: string }).reason, /kill switch/);
});

test("demo wrap: zero-size position refused", () => {
  const res = assessDemoWrap(guards(), NOW, 0, []);
  assert.equal(res.ok, false);
  assert.match((res as { reason: string }).reason, /no live position/);
});

test("demo wrap: hard micro cap refuses oversized notional", () => {
  const res = assessDemoWrap(guards({ maxPositionNotionalUsdc: 1_000 }), NOW, 1_500, []);
  assert.equal(res.ok, false);
  assert.match((res as { reason: string }).reason, /hard cap/);
});

test("demo wrap: one at a time — in-flight blocks", () => {
  const res = assessDemoWrap(guards(), NOW, 100, [wrap({ status: "quoting" })]);
  assert.equal(res.ok, false);
  assert.match((res as { reason: string }).reason, /in flight/);
});

test("demo wrap: one at a time — active blocks until concluded/reset", () => {
  const res = assessDemoWrap(guards(), NOW, 100, [wrap({ status: "active" })]);
  assert.equal(res.ok, false);
  assert.match((res as { reason: string }).reason, /already active/);
});

test("demo wrap: daily quota enforced (UTC day)", () => {
  const today = (i: number) => wrap({ id: `w${i}`, createdAtMs: NOW - (i + 2) * 60_000, status: "failed" });
  const res = assessDemoWrap(guards({ maxWrapsPerDay: 3 }), NOW, 100, [today(0), today(1), today(2)]);
  assert.equal(res.ok, false);
  assert.match((res as { reason: string }).reason, /quota/);
});

test("demo wrap: cooldown between attempts", () => {
  const res = assessDemoWrap(guards({ cooldownMs: 30_000 }), NOW, 100, [wrap({ createdAtMs: NOW - 10_000, status: "failed" })]);
  assert.equal(res.ok, false);
  assert.match((res as { reason: string }).reason, /cooldown/);
});

test("demo wrap: clean state permits", () => {
  // concluded/failed wraps from yesterday don't block today
  const old = wrap({ createdAtMs: NOW - 2 * DAY, status: "concluded" });
  assert.deepEqual(assessDemoWrap(guards(), NOW, 100, [old]), { ok: true });
});

// ── credit scaling ────────────────────────────────────────────────────────────

test("credit target scales proportionally ($80 on $50k geometry)", () => {
  assert.equal(scaledCreditTarget(80, 50_000, 50_000), 80);
  assert.equal(scaledCreditTarget(80, 50_000, 650), 1.04); // one OKX min clip at ~$65k spot
  assert.equal(scaledCreditTarget(80, 50_000, 25_000), 40);
});

test("credit target floors at the minimum for dust positions", () => {
  assert.equal(scaledCreditTarget(80, 50_000, 10), 0.5);
  assert.equal(scaledCreditTarget(80, 50_000, 0), 0.5);
});

// ── OKX lot cover (floor, never round up) ─────────────────────────────────────

test("coverOkxLots: refuses below one 0.01 BTC lot", () => {
  const r = coverOkxLots(0.009);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.reason, /wrap refused: this position is 0\.009 BTC/);
  assert.match(r.reason, /0\.01 BTC lots/);
});

test("coverOkxLots: 0.01 is exactly one lot; 0.012 floors to 0.01 with remainder", () => {
  const exact = coverOkxLots(0.01);
  assert.equal(exact.ok, true);
  if (!exact.ok) return;
  assert.equal(exact.lots, 1);
  assert.equal(exact.coveredBtc, 0.01);
  assert.equal(exact.remainderBtc, 0);

  const partial = coverOkxLots(0.012);
  assert.equal(partial.ok, true);
  if (!partial.ok) return;
  assert.equal(partial.lots, 1);
  assert.equal(partial.coveredBtc, 0.01);
  assert.ok(partial.remainderBtc > 0.0019 && partial.remainderBtc < 0.0021);
  assert.match(uncoveredSizeNote(0.012, partial) ?? "", /protecting 0\.01 of 0\.012 BTC/);
  assert.equal(uncoveredSizeNote(0.01, exact), null);
});

test("coverOkxLots: never rounds up (0.019 → 1 lot, not 2)", () => {
  const r = coverOkxLots(0.019);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.lots, 1);
  assert.equal(OKX_OPTION_LOT_BTC, 0.01);
});

// ── paper legs ────────────────────────────────────────────────────────────────

test("paper legs: signed premiums, labeled model instruments", () => {
  const q = { legs: { putStrike: 61_000, callStrike: 66_000, floor_leg_mid_usdc: 0.42, funding_leg_mid_usdc: 1.46 } };
  const expiry = Date.UTC(2027, 0, 15, 8, 0, 0);
  const legs = paperLegsFromQuote(q, expiry);
  assert.equal(legs.length, 2);
  const cap = legs.find((l) => l.role === "sell_call_cap")!;
  const floor = legs.find((l) => l.role === "buy_put_floor")!;
  assert.equal(cap.premiumUsdc, 1.46); // collected
  assert.equal(floor.premiumUsdc, -0.42); // paid
  assert.equal(cap.real, false);
  assert.match(cap.instId!, /66000-C \(model\)$/);
  assert.match(floor.instId!, /61000-P \(model\)$/);
  assert.equal(paperInstId(66_000, "C", expiry), "BTC-USD-15JAN27-66000-C (model)");
});

// ── vesting readout ───────────────────────────────────────────────────────────

test("vesting: null before a vesting schedule exists", () => {
  assert.equal(demoVestingStatus(wrap(), NOW), null);
});

test("vesting: 0 at start, half mid-tenor, capped at full", () => {
  const r = wrap({ vesting: { fullCreditUsdc: 1.04, startMs: NOW, endMs: NOW + DAY }, status: "active" });
  const atStart = demoVestingStatus(r, NOW)!;
  assert.equal(atStart.vestedUsdc, 0);
  assert.equal(atStart.fullyVested, false);
  const mid = demoVestingStatus(r, NOW + DAY / 2)!;
  assert.equal(mid.vestedUsdc, 0.52);
  assert.equal(mid.fraction, 0.5);
  const after = demoVestingStatus(r, NOW + 2 * DAY)!;
  assert.equal(after.vestedUsdc, 1.04);
  assert.equal(after.fullyVested, true);
  assert.equal(after.remainingMs, 0);
});

test("early close: collects vested-to-now, freezes the clock, frees the active slot", () => {
  const r = wrap({ vesting: { fullCreditUsdc: 1.04, startMs: NOW, endMs: NOW + DAY }, status: "active" });
  const v = concludeWrapEarly(r, NOW + DAY / 4)!;
  assert.equal(v.vestedUsdc, 0.26); // 25% of the tenor ⟹ 25% of the credit
  assert.equal(r.status, "concluded");
  assert.equal(r.concludedAtMs, NOW + DAY / 4);
  assert.match(r.stages[r.stages.length - 1].note!, /voluntary early close.*collected \$0\.26.*clawed back/);
  // Vesting is FROZEN at the close — polling later never shows more vested.
  const later = demoVestingStatus(r, NOW + DAY)!;
  assert.equal(later.vestedUsdc, 0.26);
  assert.equal(later.fraction, 0.25);
  // The concluded wrap no longer blocks a new one (cooldown still applies from createdAtMs).
  const res = assessDemoWrap(guards({ cooldownMs: 0 }), NOW + DAY / 2, 100, [r]);
  assert.deepEqual(res, { ok: true });
});

test("early close: refuses when nothing is active", () => {
  assert.equal(concludeWrapEarly(wrap({ status: "failed" }), NOW), null);
  assert.equal(concludeWrapEarly(wrap(), NOW), null); // quoting, no vesting yet
});

// ── record state machine ──────────────────────────────────────────────────────

test("record: stages accumulate in order; failWrap terminalizes", () => {
  const r = wrap();
  assert.deepEqual(r.stages.map((s) => s.stage), ["wrap_requested", "position_read"]);
  pushStage(r, "quoted", NOW + 1_000, "floor/cap");
  failWrap(r, NOW + 2_000, "pricer declined");
  assert.equal(r.status, "failed");
  assert.equal(r.failReason, "pricer declined");
  assert.deepEqual(r.stages.map((s) => s.stage), ["wrap_requested", "position_read", "quoted", "failed"]);
});

test("wrapRefuseFromLive: 50111 is an API key reject, not a missing option", () => {
  const msg = wrapRefuseFromLive("execution aborted_no_fill on long (pair unwound) — day skipped", [
    "place buy BTC-USD-260816-59000-P attempt 1 failed: 50111 Invalid OK-ACCESS-KEY"
  ]);
  assert.match(msg, /50111 Invalid OK-ACCESS-KEY/);
  assert.match(msg, /API key/);
  assert.doesNotMatch(msg, /pair unwound|day skipped|missing/);
});

// ── env parsing ───────────────────────────────────────────────────────────────

test("guards from env: safe defaults (paper, enabled, $1k cap)", () => {
  const g = parseDemoGuardsFromEnv({});
  assert.equal(g.executionMode, "paper");
  assert.equal(g.enabled, true);
  assert.equal(g.maxPositionNotionalUsdc, 1_000);
});

test("guards from env: okx_live only via the explicit value", () => {
  assert.equal(parseDemoGuardsFromEnv({ DEMO_EXECUTION: "okx_live" }).executionMode, "okx_live");
  assert.equal(parseDemoGuardsFromEnv({ DEMO_EXECUTION: "live" }).executionMode, "paper"); // typo ⟹ safe lane
  assert.equal(parseDemoGuardsFromEnv({ DEMO_ENABLED: "false" }).enabled, false);
});

// ── store round-trip ──────────────────────────────────────────────────────────

test("store: round-trips records; missing/corrupt file ⟹ empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "demo-wrap-"));
  const path = join(dir, "wraps.json");
  assert.deepEqual(loadDemoWraps(path), []);
  const r = wrap();
  r.vesting = { fullCreditUsdc: 1.04, startMs: NOW, endMs: NOW + DAY };
  saveDemoWraps([r], path);
  const back = loadDemoWraps(path);
  assert.equal(back.length, 1);
  assert.equal(back[0].id, r.id);
  assert.equal(back[0].vesting!.fullCreditUsdc, 1.04);
});
