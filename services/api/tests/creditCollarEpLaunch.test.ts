import assert from "node:assert/strict";
import test from "node:test";
import {
  assessGeofence,
  buildCountryResolver,
  isPrivateIp,
  parseGeofenceFromEnv,
  type GeofenceConfig
} from "../src/singleSide/twoSided/creditCollar/epGeofence";
import {
  buildCalibrationReport,
  calibrationSamples,
  capDistanceBucket,
  parsePublishGateFromEnv,
  renderCalibrationMarkdown
} from "../src/singleSide/twoSided/creditCollar/epCalibration";
import {
  measureMarginRate,
  parsePositionBuilderImrUsd,
  sumLivePositionsImrUsd
} from "../src/singleSide/twoSided/creditCollar/epMarginMeasure";
import { buildNettingPlan, intentLegs, intentsFromWraps } from "../src/singleSide/twoSided/creditCollar/epRfqNetting";
import { tosPrompt } from "../src/singleSide/twoSided/creditCollar/epBot";
import { newDemoWrap, type DemoWrapRecord } from "../src/singleSide/twoSided/creditCollar/demoWrap";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

// ── Geofence ──────────────────────────────────────────────────────────────────

const geoCfg = (over: Partial<GeofenceConfig> = {}): GeofenceConfig => ({
  ...parseGeofenceFromEnv({ EP_GEOFENCE: "true" }),
  ...over
});

test("geofence: env defaults — off in dev, US+OFAC blocklist, FAIL-CLOSED on unknown", () => {
  const off = parseGeofenceFromEnv({});
  assert.equal(off.enabled, false);
  assert.equal(off.mode, "off");
  assert.deepEqual(off.blockedCountries, ["US", "CU", "IR", "KP", "SY"]);
  assert.equal(off.failOpen, false);
});

test("geofence: three modes — notice (banner only) vs enforce (blocks); EP_GEOFENCE=true stays enforce", () => {
  assert.equal(parseGeofenceFromEnv({ EP_GEOFENCE_MODE: "notice" }).mode, "notice");
  assert.equal(parseGeofenceFromEnv({ EP_GEOFENCE_MODE: "notice" }).enabled, true);
  assert.equal(parseGeofenceFromEnv({ EP_GEOFENCE_MODE: "enforce" }).mode, "enforce");
  assert.equal(parseGeofenceFromEnv({ EP_GEOFENCE: "true" }).mode, "enforce"); // backward compat
  assert.equal(parseGeofenceFromEnv({ EP_GEOFENCE_MODE: "garbage" }).mode, "off"); // typo ⟹ safe lane
});

test("geofence: blocked countries refuse with honest copy; others pass; disabled allows all", () => {
  const cfg = geoCfg();
  const us = assessGeofence(cfg, "US");
  assert.ok(!us.allowed && /not available in your region \(US\)/.test((us as { reason: string }).reason));
  assert.ok(!assessGeofence(cfg, "IR").allowed);
  assert.ok(assessGeofence(cfg, "DE").allowed);
  assert.ok(assessGeofence(cfg, "SG").allowed);
  assert.ok(assessGeofence(geoCfg({ enabled: false }), "US").allowed);
});

test("geofence: unknown location FAILS CLOSED by default; failOpen is explicit; LOCAL always allowed", () => {
  const closed = assessGeofence(geoCfg(), null);
  assert.ok(!closed.allowed && /couldn't verify your location/.test((closed as { reason: string }).reason));
  assert.ok(assessGeofence(geoCfg({ failOpen: true }), null).allowed);
  assert.ok(assessGeofence(geoCfg(), "LOCAL").allowed);
});

test("geofence: private/loopback IPs are LOCAL", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.9", "172.16.5.5", "::1", "::ffff:127.0.0.1", "localhost", ""]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  assert.equal(isPrivateIp("8.8.8.8"), false);
  assert.equal(isPrivateIp("172.32.0.1"), false); // just outside RFC-1918
});

test("geofence resolver: trusted header wins; lookup is cached; lookup failure ⟹ null (unknown)", async () => {
  let calls = 0;
  const fakeFetch = (async (url: unknown) => {
    calls++;
    return { ok: true, text: async () => (String(url).includes("1.2.3.4") ? "sg\n" : "xx-bad") } as Response;
  }) as unknown as typeof fetch;
  const resolve = buildCountryResolver(geoCfg(), fakeFetch);
  // header path — no lookup fired
  assert.equal(await resolve({ "cf-ipcountry": "DE" }, "1.2.3.4"), "DE");
  assert.equal(calls, 0);
  // private ip
  assert.equal(await resolve({}, "127.0.0.1"), "LOCAL");
  // lookup path, then cache
  assert.equal(await resolve({}, "1.2.3.4"), "SG");
  assert.equal(await resolve({}, "1.2.3.4"), "SG");
  assert.equal(calls, 1);
  // unparseable body ⟹ null (fail-closed upstream)
  assert.equal(await resolve({}, "5.6.7.8"), null);
});

// ── ToS bot prompt ────────────────────────────────────────────────────────────

test("tos prompt: carries the version, the /tos link, and one accept button", () => {
  const p = tosPrompt("2026-08-draft", "http://localhost:8788/");
  assert.match(p.text, /http:\/\/localhost:8788\/tos \(version 2026-08-draft\)/);
  assert.equal(p.keyboard[0][0].callback_data, "tos");
  assert.match(p.keyboard[0][0].text, /I accept the Terms \(2026-08-draft\)/);
});

// ── Credit calibration ────────────────────────────────────────────────────────

const pricedWrap = (id: string, over: { tsMs?: number; lane?: string; lots?: number; gross?: number; capPct?: number; status?: DemoWrapRecord["status"]; concludedAtMs?: number | null } = {}): DemoWrapRecord => {
  const base = newDemoWrap(id, over.tsMs ?? NOW, "hyperliquid", "0x" + "a".repeat(40), {
    coin: "BTC",
    side: "long",
    szBase: 0.02,
    entryPx: 64_000,
    markPx: 64_500,
    notionalUsdc: 1_290
  });
  base.status = over.status ?? "concluded";
  base.concludedAtMs = over.concludedAtMs === undefined ? (over.tsMs ?? NOW) + DAY : over.concludedAtMs;
  base.vesting = { fullCreditUsdc: over.gross ?? 0.2, startMs: over.tsMs ?? NOW, endMs: (over.tsMs ?? NOW) + DAY };
  base.quote = {
    spot: 64_500,
    putStrike: 60_600,
    callStrike: 65_500,
    floorPct: 0.06,
    capPct: over.capPct ?? 0.0155,
    creditUsdc: over.gross ?? 0.2,
    floorPctUsed: 0.06,
    tenorDays: 1
  };
  base.hedge = { venue: "x", mode: over.lane ?? "okx_live", netCreditUsdc: over.gross ?? 0.2, venueFeeUsdc: 0.1, contracts: over.lots ?? 2, sizeNote: null };
  base.economics = { grossCreditUsdc: over.gross ?? 0.2, atticusTakeUsdc: 0, takeRatePct: 0, founding: true };
  return base;
};

test("calibration: samples carry per-lot gross credit, hour, lane, conclusion", () => {
  const s = calibrationSamples([
    pricedWrap("w1", { gross: 0.3, lots: 3, tsMs: Date.UTC(2026, 7, 19, 14, 30) }),
    pricedWrap("w2", { status: "knocked_out", concludedAtMs: NOW + HOUR }),
    newDemoWrap("w3-unpriced", NOW, "hyperliquid", "0x" + "a".repeat(40), { coin: "BTC", side: "long", szBase: 0.001, entryPx: 1, markPx: 1, notionalUsdc: 1 })
  ]);
  assert.equal(s.length, 2); // unpriced wrap excluded
  assert.equal(s[0].perLotUsdc, 0.1);
  assert.equal(s[0].hourUtc, 14);
  assert.equal(s[1].conclusion, "knockout");
});

test("calibration: publish gate refuses thin data with specific reasons", () => {
  const gate = parsePublishGateFromEnv({});
  const r = buildCalibrationReport([pricedWrap("w1"), pricedWrap("w2", { lane: "paper" })], gate, NOW);
  assert.equal(r.publishGate.passed, false);
  assert.equal(r.liveSamples, 1); // paper never counts toward the gate
  assert.ok(r.publishGate.reasons.some((x) => /1\/30 live wraps/.test(x)));
  assert.ok(r.publishGate.reasons.some((x) => /distinct market hours/.test(x)));
  assert.ok(r.publishGate.reasons.some((x) => /span/.test(x)));
  const md = renderCalibrationMarkdown(r);
  assert.match(md, /NOT ENOUGH DATA — do not publish credit expectations/);
  assert.match(md, /typically cents to a few dollars per day/); // approved interim framing survives
});

test("calibration: the gate passes with a full week of coverage and blesses the live numbers", () => {
  const wraps: DemoWrapRecord[] = [];
  for (let i = 0; i < 36; i++) {
    wraps.push(pricedWrap(`w${i}`, { tsMs: NOW + i * 5 * HOUR, gross: 0.1 + (i % 4) * 0.05, lots: 1 + (i % 3) }));
  }
  const r = buildCalibrationReport(wraps, parsePublishGateFromEnv({}), NOW + 8 * DAY);
  assert.equal(r.publishGate.passed, true);
  assert.ok(r.liveOverall!.n >= 30);
  assert.ok(new Set(Object.keys(r.byHourUtc)).size >= 18);
  const md = renderCalibrationMarkdown(r);
  assert.match(md, /PUBLISH GATE: PASSED/);
});

test("calibration: cap-distance buckets in 0.25% steps", () => {
  assert.equal(capDistanceBucket(0.0155), "1.50–1.75%");
  assert.equal(capDistanceBucket(0.02), "2.00–2.25%");
});

// ── PM margin measurement ─────────────────────────────────────────────────────

test("margin: position-builder parsing is defensive — numbers in, null on junk", () => {
  assert.equal(parsePositionBuilderImrUsd([{ imr: "163.2" }]), 163.2);
  assert.equal(parsePositionBuilderImrUsd([{ marginRequirement: { imr: 90 } }]), 90);
  assert.equal(parsePositionBuilderImrUsd([]), null);
  assert.equal(parsePositionBuilderImrUsd([{ imr: "not-a-number" }]), null);
  assert.equal(parsePositionBuilderImrUsd(undefined), null);
  assert.equal(sumLivePositionsImrUsd([{ imr: "100.5" }, { imr: "49.5" }, { imr: "junk" }]), 150);
  assert.equal(sumLivePositionsImrUsd([{ imr: "junk" }]), null);
});

test("margin: the measured rate re-derives the book cap (decision 4 recalibration)", () => {
  // $163.2 IMR on $1,360 wrapped ⟹ 12% ⟹ $10k capital × 60% ÷ 12% = $50k book (launch estimate confirmed)
  const m = measureMarginRate("builder", 163.2, 1_360, 10_000, 0.4, NOW)!;
  assert.equal(m.marginRate, 0.12);
  assert.equal(m.impliedBookCapUsdc, 50_000);
  // a HIGHER measured rate shrinks the book — the honest direction
  const worse = measureMarginRate("live", 204, 1_360, 10_000, 0.4, NOW)!;
  assert.equal(worse.marginRate, 0.15);
  assert.equal(worse.impliedBookCapUsdc, 40_000);
  assert.equal(measureMarginRate("live", 100, 0, 10_000, 0.4, NOW), null); // degenerate ⟹ never guess
});

// ── RFQ book-level netting (decision 7) ───────────────────────────────────────

test("netting: a long wrap sells the call / buys the put; a short mirrors", () => {
  const long = intentLegs({ ref: "a", side: "long", lots: 2, putStrike: 60_000, callStrike: 66_000, expiryMs: NOW });
  assert.deepEqual(long.map((l) => [l.optType, l.strike, l.signedLots]), [["C", 66_000, -2], ["P", 60_000, 2]]);
  const short = intentLegs({ ref: "b", side: "short", lots: 3, putStrike: 63_000, callStrike: 68_000, expiryMs: NOW });
  assert.deepEqual(short.map((l) => [l.optType, l.strike, l.signedLots]), [["P", 63_000, -3], ["C", 68_000, 3]]);
});

test("netting: longs offset shorts; same-strike wraps combine; zeroed legs disappear", () => {
  const intents = [
    { ref: "a", side: "long" as const, lots: 5, putStrike: 60_000, callStrike: 66_000, expiryMs: NOW },
    { ref: "b", side: "long" as const, lots: 3, putStrike: 60_000, callStrike: 66_000, expiryMs: NOW }, // same strikes: combine
    { ref: "c", side: "short" as const, lots: 8, putStrike: 62_000, callStrike: 66_000, expiryMs: NOW } // its long call EXACTLY offsets the sold calls
  ];
  const plan = buildNettingPlan(intents, 64_000, 50_000);
  // C@66000: -5 -3 +8 = 0 ⟹ gone entirely (8 lots × 2 sides netted away)
  assert.ok(!plan.legs.some((l) => l.key.startsWith("C:66000")));
  assert.equal(plan.nettedAwayLots, 16);
  // P@60000: +8 (combined buys), P@62000: -8 (sold put cap)
  const p60 = plan.legs.find((l) => l.key.startsWith("P:60000"))!;
  const p62 = plan.legs.find((l) => l.key.startsWith("P:62000"))!;
  assert.equal(p60.netLots, 8);
  assert.equal(p62.netLots, -8);
});

test("netting: block routing — only net legs clearing the minimum go to RFQ; the rest stay on screen", () => {
  const intents = [
    { ref: "a", side: "long" as const, lots: 90, putStrike: 60_000, callStrike: 66_000, expiryMs: NOW }, // 90 lots ≈ $57.6k/leg
    { ref: "b", side: "long" as const, lots: 2, putStrike: 61_000, callStrike: 67_000, expiryMs: NOW } // $1.3k/leg
  ];
  const plan = buildNettingPlan(intents, 64_000, 50_000);
  assert.equal(plan.blockLegs.length, 2); // both 90-lot legs clear $50k
  assert.equal(plan.screenLegs.length, 2); // the 2-lot legs stay on the order book
  assert.ok(plan.blockLegs.every((l) => l.notionalUsdc >= 50_000 && l.route === "rfq_block"));
});

test("netting: intentsFromWraps reads only OPEN priced wraps", () => {
  const open = pricedWrap("w1", { status: "active", concludedAtMs: null });
  const done = pricedWrap("w2");
  const intents = intentsFromWraps([open, done]);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].ref, "w1");
  assert.equal(intents[0].lots, 2);
});
