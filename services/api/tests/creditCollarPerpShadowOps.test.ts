/**
 * The perp shadow's "somebody is watching" half, the cap odds that move with realized vol, the
 * RFQ package, and the floor drill. Pure functions first; then the worker with injected venues.
 *
 * Identity checked throughout: trader = credit + floor payout - cap excess, writer = take.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { OkxChainInstrument } from "../src/singleSide/twoSided/creditCollar/execution/okxLivePlanner";
import { DEFAULT_CAP_ODDS_BAND, adaptCapOdds, applyCapOdds, realizedVolAnnual } from "../src/singleSide/twoSided/creditCollar/capRule";
import { DEFAULT_RFQ_ROUTE, decideRoute, packageFor, rfqConfigFromEnv, trueUpCredit } from "../src/singleSide/twoSided/creditCollar/rfqRoute";
import type { BookDepth, OkxListedSnapshot } from "../src/singleSide/twoSided/creditCollar/perpShadow/okxListedSnapshot";
import {
  appendPerpShadowRecord,
  loadPerpShadow,
  perpOutcome,
  replayPerpShadow,
  summarizePerpCounterfactuals,
  type PerpShadowOpenRecord,
  type PerpShadowPosition,
  type PerpShadowRecord,
} from "../src/singleSide/twoSided/creditCollar/perpShadow/perpShadowLedger";
import {
  DEFAULT_FRIDAY_CONFIG,
  driftAlarm,
  feeShare,
  floorDrill,
  fridayMessage,
  fridayReview,
  hlPrintAtExpiry,
  publicCapLadder,
  watchdog,
  type WatchdogInput,
} from "../src/singleSide/twoSided/creditCollar/perpShadow/perpShadowOps";
import { perpShadowQuote } from "../src/singleSide/twoSided/creditCollar/perpShadow/perpShadowQuote";
import type { Candle } from "../src/singleSide/twoSided/creditCollar/perpShadow/perpShadowPath";

// ── Fixture: the same daily/weekly chain around 80,000 the ledger tests use ──

const DAILY = Date.UTC(2026, 8, 20, 8);
const WEEKLY = Date.UTC(2026, 8, 25, 8);
const SPOT = 80_000;
const HOUR = 3_600_000;

const inst = (expiryMs: number, optType: "put" | "call", strike: number): OkxChainInstrument => {
  const d = new Date(expiryMs);
  const code = `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  return { instId: `BTC-USD-${code}-${strike}-${optType === "put" ? "P" : "C"}`, optType, strike, expiryMs, ctValBtc: 0.01, tickSz: 0.0001, lotSz: 1, minSz: 1, state: "live" };
};
const STRIKES = [74000, 75000, 76000, 77000, 78000, 79000, 81000, 82000, 83000, 84000];
const chain: OkxChainInstrument[] = [];
for (const e of [DAILY, WEEKLY]) for (const k of STRIKES) chain.push(inst(e, "put", k), inst(e, "call", k));
const depth = (bid: number, ask: number): BookDepth => ({
  bids: [{ pxBtc: bid, contracts: 5 }, { pxBtc: bid * 0.8, contracts: 200 }],
  asks: [{ pxBtc: ask, contracts: 5 }, { pxBtc: ask * 1.25, contracts: 200 }],
});
const bookFor = (c: OkxChainInstrument): BookDepth => {
  const dist = Math.abs(c.strike - SPOT) / SPOT;
  const base = Math.max(0.0002, 0.01 - dist * 0.16);
  const mid = base * (c.expiryMs === WEEKLY ? 10 : 1);
  return depth(+(mid * 0.97).toFixed(6), +(mid * 1.03).toFixed(6));
};
const snap = (): OkxListedSnapshot => {
  const books: Record<string, BookDepth> = {};
  for (const c of chain) books[c.instId] = bookFor(c);
  return { atMs: Date.UTC(2026, 8, 18, 23), expiryMs: DAILY, weeklyExpiryMs: WEEKLY, chain, books, booksMissing: 0 };
};
const quoteInputs = (side: "long" | "short", id: string, nowIso: string) => ({
  side,
  spot: SPOT,
  contracts: 3,
  geometry: { floorPct: 0.06, capPct: 0.015 },
  tenor: "daily" as const,
  capGuard: { minCapPct: 0.02, maxCapPct: 0.04 },
  otherTenorCapGuard: { minCapPct: 0.04, maxCapPct: 0.08 },
  take: { shareRate: 0.2, minTakeBpsOfNotional: 0, deMinimisCents: 5 },
  counterfactualMinTakeBps: 5,
  okxIndex: 79_970,
  fundingBpsPer8h: 0.125,
  nowIso,
  id,
});
const openRec = (side: "long" | "short", id: string, at = "2026-09-18T23:00:00.000Z", capExceedProb: number | null = 0.2): PerpShadowOpenRecord => {
  const r = perpShadowQuote(quoteInputs(side, id, at), snap());
  assert.equal(r.type, "open");
  return { ...(r as PerpShadowOpenRecord), capExceedProb };
};

const settled = (recs: PerpShadowRecord[]): PerpShadowPosition[] => replayPerpShadow(recs, { capMode: "plain" }).positions;

const flatCandles = (startMs: number, endMs: number, intervalMs: number, px: number): Candle[] => {
  const out: Candle[] = [];
  for (let t = Math.floor(startMs / intervalMs) * intervalMs; t + intervalMs <= endMs + 1; t += intervalMs) out.push({ t, o: px, h: px, l: px, c: px });
  return out;
};

// ── Watchdog ─────────────────────────────────────────────────────────────────

const quietInput = (over: Partial<WatchdogInput> = {}): WatchdogInput => ({
  nowMs: DAILY + 30 * HOUR,
  positions: [],
  lastScanAtMs: DAILY + 30 * HOUR - 60_000,
  lastSettleAtMs: DAILY + 30 * HOUR - 60_000,
  lastScanError: null,
  lastSettleError: null,
  consecutiveScanFailures: 0,
  lastBookAtMs: null,
  flowEnabled: false,
  scanMs: 5 * 60_000,
  settleGraceMs: 20 * 60_000,
  settleStallMs: 6 * HOUR,
  bootMs: DAILY,
  ...over,
});

test("perp ops watchdog: silence is the only input; nothing fires on a healthy worker", () => {
  assert.deepEqual(watchdog(quietInput()), []);
  const freshBoot = quietInput({ lastScanAtMs: null, bootMs: DAILY + 30 * HOUR - 60_000 });
  assert.deepEqual(watchdog(freshBoot), [], "a worker that booted a minute ago has not missed anything yet");
});

test("perp ops watchdog: a position past expiry + grace + stall is a settlement alarm keyed on the oldest expiry", () => {
  const a = openRec("long", "a");
  const b = openRec("short", "b", "2026-09-19T00:00:00.000Z");
  const open = settled([a, b]);
  // 6h20m past expiry: exactly at the threshold
  const atThreshold = watchdog(quietInput({ positions: open, nowMs: DAILY + 20 * 60_000 + 6 * HOUR }));
  assert.equal(atThreshold.length, 1);
  assert.equal(atThreshold[0].kind, "settlement_stalled");
  assert.equal(atThreshold[0].key, `settlement_stalled:${a.expiryIso}`);
  assert.match(atThreshold[0].message, /^2 positions past expiry and still open; oldest expiry 2026-09-20 08:00 UTC, 6h ago$/);
  assert.deepEqual(atThreshold[0].data?.expiries, { [a.expiryIso]: 2 });
  const aMinuteEarly = watchdog(quietInput({ positions: open, nowMs: DAILY + 20 * 60_000 + 6 * HOUR - 60_000 }));
  assert.deepEqual(aMinuteEarly, [], "inside the stall window the settle loop still has time");
  const withError = watchdog(quietInput({ positions: open, nowMs: DAILY + 30 * HOUR, lastSettleError: "delivery: OKX HTTP 503" }));
  assert.match(withError[0].message, /last settle error: delivery: OKX HTTP 503/);
  const afterSettle = settled([a, b, { type: "settle", at: new Date(DAILY + HOUR).toISOString(), id: "a", settleCents: 8_000_000, source: "okx_delivery" }, { type: "void", at: new Date(DAILY + HOUR).toISOString(), id: "b", reason: "x" }]);
  assert.deepEqual(watchdog(quietInput({ positions: afterSettle, nowMs: DAILY + 30 * HOUR })), [], "settled and void positions are never overdue");
});

test("perp ops watchdog: a quiet scan loop or three failures in a row is a quoting alarm; a stale book with open positions is a netting alarm only in flow mode", () => {
  const now = DAILY + 30 * HOUR;
  const quiet = watchdog(quietInput({ nowMs: now, lastScanAtMs: now - 16 * 60_000 }));
  assert.deepEqual(quiet.map((a) => a.kind), ["quote_stalled"]);
  assert.match(quiet[0].message, /no quote written for 16 minutes \(scan every 5m\)$/);
  assert.deepEqual(watchdog(quietInput({ nowMs: now, lastScanAtMs: now - 15 * 60_000 })), [], "3x the scan interval is the line, not inside it");
  const failing = watchdog(quietInput({ nowMs: now, consecutiveScanFailures: 3, lastScanError: "HL 502" }));
  assert.equal(failing[0].kind, "quote_stalled");
  assert.match(failing[0].message, /3 consecutive scan failures · last error: HL 502/);
  const neverScanned = watchdog(quietInput({ nowMs: now, lastScanAtMs: null, bootMs: now - HOUR }));
  assert.equal(neverScanned[0].kind, "quote_stalled", "an hour after boot with no scan written counts from boot");

  const open = settled([openRec("long", "a")]);
  const bookInput = quietInput({ nowMs: now, positions: open, flowEnabled: true, lastBookAtMs: now - HOUR, settleStallMs: 365 * 24 * HOUR });
  assert.deepEqual(watchdog(bookInput).map((a) => a.kind), ["netting_stale"]);
  assert.deepEqual(watchdog({ ...bookInput, flowEnabled: false }), [], "the metronome keeps no book; no netting alarm");
  assert.deepEqual(watchdog({ ...bookInput, positions: [] }), [], "nothing open: a stale book is not a risk");
  assert.deepEqual(watchdog({ ...bookInput, lastBookAtMs: now - 10 * 60_000 }), [], "a book from the last scan or two is current");
});

test("perp ops drift: one alarm names every parser that read nothing; none when all read", () => {
  assert.equal(driftAlarm([{ name: "okx_delivery_history", ok: true, detail: "12 readable prints" }]), null);
  assert.equal(driftAlarm([]), null);
  const a = driftAlarm([
    { name: "okx_index", ok: true, detail: "index 80000" },
    { name: "okx_delivery_history", ok: false, detail: "no row parsed to a date code and a price" },
    { name: "hl_candles", ok: false, detail: "0 candles in the last 2h" },
  ]);
  assert.equal(a?.kind, "venue_payload_drift");
  assert.equal(a?.key, "venue_payload_drift:hl_candles,okx_delivery_history", "the key sorts the names so the same failure set dedupes");
  assert.equal(a?.message, "venue payload drift: okx_delivery_history (no row parsed to a date code and a price); hl_candles (0 candles in the last 2h)");
});

// ── The second print source ──────────────────────────────────────────────────

test("perp ops print: the Hyperliquid mark at expiry is the close of the last candle ending at or before expiry; never a candle far away", () => {
  const expiry = DAILY;
  const candles = flatCandles(expiry - 30 * 60_000, expiry + 60_000, 60_000, 80_000);
  // the last candle that ends at or before expiry
  candles[candles.length - 2] = { ...candles[candles.length - 2], c: 80_123 }; // opens expiry - 1m, ends at expiry
  candles[candles.length - 1] = { ...candles[candles.length - 1], c: 99_999 }; // opens AT expiry, ends after: not the print
  assert.equal(hlPrintAtExpiry(candles, expiry, 60_000), 80_123);
  assert.equal(hlPrintAtExpiry([], expiry, 60_000), null);
  assert.equal(hlPrintAtExpiry(candles.slice(-1), expiry, 60_000), null, "only a candle that ends after expiry: no print");
  const stale = flatCandles(expiry - 3 * HOUR, expiry - HOUR, 60_000, 77_000);
  assert.equal(hlPrintAtExpiry(stale, expiry, 60_000), null, "an hour-old candle is not the expiry print");
  assert.equal(hlPrintAtExpiry(stale, expiry, 60_000, 2 * HOUR), 77_000, "unless the caller widens the tolerance");
  // 5m candles: the one ending at expiry
  const five = flatCandles(expiry - HOUR, expiry, 5 * 60_000, 81_000);
  assert.equal(hlPrintAtExpiry(five, expiry, 5 * 60_000), 81_000);
});

// ── The Friday review ────────────────────────────────────────────────────────

const twoFridays = (): PerpShadowRecord[] => {
  const a = openRec("long", "a"); // cap 83,000, floor ~75,200
  const b = openRec("short", "b", "2026-09-18T23:30:00.000Z"); // cap 77,000
  const c = openRec("long", "c", "2026-09-18T23:45:00.000Z", 0.3);
  // second Friday: three more opened a week later, settling at a different print
  const later = (side: "long" | "short", id: string) => ({ ...openRec(side, id, "2026-09-25T23:00:00.000Z"), expiryIso: new Date(WEEKLY + 7 * 24 * HOUR).toISOString() });
  const d = later("long", "d");
  const e = later("long", "e");
  const f = later("short", "f");
  const t1 = new Date(DAILY + 20 * 60_000).toISOString();
  const t2 = new Date(WEEKLY + 7 * 24 * HOUR + 20 * 60_000).toISOString();
  return [
    a,
    b,
    c,
    d,
    e,
    f,
    // week one prints 84,000: both longs end past their 83,000 cap, the short is between
    { type: "settle", at: t1, id: "a", settleCents: 8_400_000, source: "okx_delivery" },
    { type: "settle", at: t1, id: "b", settleCents: 8_400_000, source: "okx_delivery" },
    { type: "settle", at: t1, id: "c", settleCents: 8_400_000, source: "okx_delivery" },
    // week two prints 70,000 from the second source: the longs' floors pay, the short ends past its cap
    { type: "settle", at: t2, id: "d", settleCents: 7_000_000, source: "hl_mark" },
    { type: "settle", at: t2, id: "e", settleCents: 7_000_000, source: "hl_mark" },
    { type: "settle", at: t2, id: "f", settleCents: 7_000_000, source: "hl_mark" },
  ];
};

test("perp ops Friday review: one row per settled expiry, oldest first, said vs seen, hand-back vs take, cumulative; identity on every row", () => {
  const positions = settled(twoFridays());
  const rows = fridayReview(positions, { ...DEFAULT_FRIDAY_CONFIG, minSettledForFlags: 3 });
  assert.equal(rows.length, 2);
  const [w1, w2] = rows;
  assert.equal(w1.expiryIso, new Date(DAILY).toISOString());
  assert.deepEqual([w1.settled, w1.long, w1.short], [3, 2, 1]);
  assert.equal(w1.settleCents, 8_400_000);
  assert.equal(w1.settleSource, "okx_delivery");
  assert.equal(w1.endedPastCap, 2, "two longs ended past 83,000");
  assert.equal(w1.seenPct, 66.7);
  assert.equal(w1.saidPct, 23.3, "mean of 0.2, 0.2, 0.3");
  assert.equal(w1.floorSaves, 0);
  const byId = new Map(positions.map((p) => [p.id, p]));
  const sum = (ids: string[], f: (p: PerpShadowPosition) => number) => ids.reduce((s, id) => s + f(byId.get(id)!), 0);
  assert.equal(w1.capExcessCents, sum(["a", "c"], (p) => p.outcome!.capExcessCents));
  assert.ok(w1.capExcessCents > 0);
  assert.equal(w1.exceededCreditCents, sum(["a", "c"], (p) => Math.max(0, p.outcome!.capExcessCents - p.outcome!.paidCents)));
  assert.equal(w1.takeCents, sum(["a", "b", "c"], (p) => p.takeCents));
  assert.equal(w1.writerCents, w1.takeCents, "writer = take on the row: the hand-back is the cap excess, never ours");
  assert.equal(w1.holderDeltaCents, w1.creditCents - w1.capExcessCents, "trader net vs unprotected = credit - cap excess when no floor paid");
  assert.deepEqual(w1.cumulative, {
    settled: 3,
    takeCents: w1.takeCents,
    capExcessCents: w1.capExcessCents,
    exceededCreditCents: w1.exceededCreditCents,
    saidPct: 23.3,
    seenPct: 66.7,
    handBackOfTakePct: Math.round((1000 * w1.capExcessCents) / w1.takeCents) / 10,
  });
  assert.ok(w1.flags.includes("seen_above_said"), "66.7% seen against a 20% band");
  assert.ok(w1.flags.includes("hand_back_over_share"), "three positions handing back more than half the take");
  assert.ok(!w1.flags.includes("floor_paid"));

  assert.equal(w2.settleSource, "hl_mark", "the second source is named on the row");
  assert.equal(w2.settleCents, 7_000_000);
  assert.equal(w2.floorSaves, 2);
  assert.equal(w2.endedPastCap, 1, "the short's cap at 77,000 is below 70,000");
  assert.ok(w2.flags.includes("floor_paid"));
  assert.equal(w2.cumulative.settled, 6);
  assert.equal(w2.cumulative.seenPct, 50);
  assert.equal(w2.cumulative.takeCents, w1.takeCents + w2.takeCents);
  assert.equal(w2.cumulative.capExcessCents, w1.capExcessCents + w2.capExcessCents);
  assert.equal(w2.writerCents, w2.takeCents);
  for (const p of positions) {
    const o = p.outcome!;
    const qty = p.contracts * p.ctValBtc;
    const sign = p.side === "long" ? 1 : -1;
    const floorPayout = o.floorSave ? Math.round(qty * (p.floorStrikeCents - p.settleCents!) * sign) : 0;
    assert.ok(Math.abs(o.protectedCents - (o.nakedCents + o.paidCents + floorPayout - o.capExcessCents)) <= 1, `identity on ${p.id}: trader = naked + credit + floor payout - cap excess`);
    assert.equal(o.writerCents, p.takeCents, `writer = take on ${p.id}`);
  }

  const noFlagsYet = fridayReview(positions, DEFAULT_FRIDAY_CONFIG);
  assert.deepEqual(noFlagsYet[0].flags, [], "below minSettledForFlags (100) one Friday is one draw: no calibration flag");
  assert.deepEqual(noFlagsYet[1].flags, ["floor_paid"], "the floor paying is always said");
  assert.deepEqual(fridayReview(settled([openRec("long", "x")])), [], "open positions make no row");

  const msg = fridayMessage(w1);
  assert.match(msg, /^Friday review · expiry 2026-09-20 08:00 UTC · print \$84,000\n3 settled \(2 long, 1 short\)/);
  assert.match(msg, /cap odds: said 23.3% · seen 66.7%/);
  assert.match(msg, /record to date: 3 settled/);
  assert.match(msg, /FLAG: positions finishing past the cap more often than the published odds/);
  assert.match(msg, /FLAG: cumulative hand-back above the set share of take/);
  assert.ok(!msg.includes("—"), "no em dashes in anything the founder reads");
  const msg2 = fridayMessage(w2);
  assert.match(msg2, /print \$70,000 \(hl_mark\)/);
  assert.match(msg2, /the floor paid this week/);
  assert.ok(!msg2.includes("NaN") && !msg2.includes("undefined"));
});

// ── The public cap ladder and fees ───────────────────────────────────────────

test("perp ops ladder: the public ladder keeps settled rungs only, sorted by cap distance, with the money and the odds", () => {
  const positions = settled(twoFridays());
  const cf = summarizePerpCounterfactuals(positions);
  const ladder = publicCapLadder(cf);
  assert.ok(ladder.length >= 2);
  assert.ok(ladder.every((r) => r.settled > 0));
  assert.deepEqual(ladder.map((r) => r.capPct), [...ladder.map((r) => r.capPct)].sort((x, y) => x - y));
  for (const r of ladder) {
    assert.deepEqual(Object.keys(r).sort(), ["bucket", "capExcessCents", "capPct", "creditCents", "endedPastCap", "holderDeltaCents", "livePicks", "predictedExceedPct", "quoted", "realizedExceedPct", "settled", "takeCents", "underGuard"]);
    assert.ok(Number.isFinite(r.creditCents) && Number.isFinite(r.capExcessCents));
  }
  assert.deepEqual(publicCapLadder({ capLadder: [] }), []);
  assert.deepEqual(publicCapLadder({ capLadder: cf.capLadder.map((r) => ({ ...r, settled: 0 })) }), [], "quoted-only rungs are a report line, not a public one");
});

test("perp ops fees: venue fees as a share of the credit the market funded, and what halving them is worth", () => {
  assert.deepEqual(feeShare({ grossCreditCents: 12_942_384, venueFeeCents: 3_775_954 }), { grossCreditCents: 12_942_384, venueFeeCents: 3_775_954, feePct: 29.2, halfFeeGainCents: 1_887_977 });
  assert.deepEqual(feeShare({ grossCreditCents: 0, venueFeeCents: 0 }), { grossCreditCents: 0, venueFeeCents: 0, feePct: null, halfFeeGainCents: 0 });
});

// ── The floor drill ──────────────────────────────────────────────────────────

test("perp ops floor drill: every position re-settled at a shocked spot; the floor clamps to the cent and writer = take on every shock", () => {
  const a = openRec("long", "a");
  const b = openRec("short", "b");
  const c = openRec("long", "c");
  const positions = [a, b, c];
  const down = floorDrill(positions, -0.08);
  assert.equal(down.positions, 3);
  assert.equal(down.floorSaves, 2, "an 8% drop sits below a 6% floor: both longs are saved");
  assert.equal(down.endedPastCap, 1, "the short's cap is 3.75% below spot: an 8% drop is past it");
  assert.equal(down.between, 0);
  assert.ok(down.identityHolds && down.gapCents === 0);
  assert.ok(down.floorClampHolds);
  assert.equal(down.takeCents, a.takeCents + b.takeCents + c.takeCents);
  assert.equal(down.writerCents, down.takeCents);
  // the floor's payout on a long: (floor - settle) x qty, both longs
  const settle = Math.round(SPOT * 100 * 0.92);
  const expectedPayout = [a, c].reduce((s, p) => s + Math.round(p.contracts * p.ctValBtc * (p.floorStrikeCents - settle)), 0);
  assert.ok(Math.abs(down.floorPayoutCents - expectedPayout) <= 2, `floor payout ${down.floorPayoutCents} vs ${expectedPayout}`);
  assert.equal(down.holderDeltaCents, down.holderProtectedCents - down.holderNakedCents);
  const longsOnly = floorDrill([a, c], -0.08);
  assert.ok(longsOnly.holderProtectedCents > longsOnly.holderNakedCents, "the longs end above naked on a crash: the floor paid");
  assert.equal(longsOnly.holderDeltaCents, longsOnly.floorPayoutCents + a.creditCents + c.creditCents, "what protection did = the floor's payout plus the credit");
  assert.ok(down.holderDeltaCents < longsOnly.holderDeltaCents, "the short's cap excess on the same crash comes off the book's total");

  const up = floorDrill(positions, 0.08);
  assert.equal(up.floorSaves, 1, "the short is saved by its floor on a rally");
  assert.equal(up.endedPastCap, 2, "both longs end past their caps");
  assert.ok(up.identityHolds && up.floorClampHolds);
  assert.ok(up.capExcessCents > 0);

  const flat = floorDrill(positions, 0);
  assert.deepEqual([flat.floorSaves, flat.endedPastCap, flat.between], [0, 0, 3]);
  assert.equal(flat.holderDeltaCents, a.creditCents + b.creditCents + c.creditCents, "flat: the trader keeps the credit and nothing else moves");
  assert.ok(flat.identityHolds);
  assert.deepEqual(floorDrill([], -0.5), { ...floorDrill([], -0.5), positions: 0, identityHolds: true, floorClampHolds: true, gapCents: 0 });

  // the drill uses the same outcome function the ledger settles with
  const direct = perpOutcome(a, settle, { hasPath: false, openMs: 0, expiryMs: 0 }, "plain");
  assert.ok(direct.floorSave);
  assert.equal(direct.writerCents, a.takeCents);
});

// ── Realized vs implied: the cap odds inside the band ────────────────────────

test("cap odds: realized vol from candles, annualized; thin history is null", () => {
  // a deterministic zig-zag: +1% then -1% every hour = a known per-step vol
  const candles: Candle[] = [];
  let px = 80_000;
  for (let i = 0; i < 200; i++) {
    px = i % 2 === 0 ? px * 1.01 : px / 1.01;
    candles.push({ t: i * HOUR, o: px, h: px, l: px, c: px });
  }
  const rv = realizedVolAnnual(candles, HOUR);
  assert.ok(rv != null);
  // per-step log return alternates +-ln(1.01): stdev ~ ln(1.01) ~ 0.00995; x sqrt(8766 steps/yr) ~ 0.93
  assert.ok(Math.abs(rv! - Math.log(1.01) * Math.sqrt((365.25 * 24 * HOUR) / HOUR)) < 0.01, `rv ${rv}`);
  assert.equal(realizedVolAnnual(candles.slice(0, 40), HOUR), null, "fewer than 48 returns: no vol");
  assert.ok(realizedVolAnnual(candles.slice(0, 40), HOUR, 10) != null, "the minimum is a parameter");
  assert.equal(realizedVolAnnual([...candles].reverse(), HOUR), rv, "order on the wire does not matter");
  const flat = candles.map((c) => ({ ...c, c: 80_000 }));
  assert.equal(realizedVolAnnual(flat, HOUR), null, "a flat tape is no vol, not zero");
  assert.equal(realizedVolAnnual(candles, 0), null);
  assert.equal(realizedVolAnnual(candles.map((c, i) => (i === 5 ? { ...c, c: NaN } : c)), HOUR) != null, true, "a bad print is dropped, not propagated");
});

test("cap odds: implied over realized moves the targeted odds inside the published band and never outside it; the identity is a strike change only", () => {
  const base = 0.2;
  const fair = adaptCapOdds({ baseProb: base, impliedVolAnnual: 0.5, realizedVolAnnual: 0.5 });
  assert.deepEqual(fair, { baseProb: 0.2, impliedVolAnnual: 0.5, realizedVolAnnual: 0.5, ratio: 1, adviceProb: 0.2, band: DEFAULT_CAP_ODDS_BAND, reason: "near_fair" });
  // the record: 18.1% said, 4.2% seen is a vol ratio far above 1.5: the band's top, never past it
  const rich = adaptCapOdds({ baseProb: base, impliedVolAnnual: 0.6, realizedVolAnnual: 0.3 });
  assert.equal(rich.ratio, 2);
  assert.equal(rich.adviceProb, 0.3, "clamped at the band's top (0.2 + 0.2 x 1 = 0.4 would be outside)");
  assert.equal(rich.reason, "vol_rich");
  const mild = adaptCapOdds({ baseProb: base, impliedVolAnnual: 0.6, realizedVolAnnual: 0.5 });
  assert.equal(mild.ratio, 1.2);
  assert.equal(mild.adviceProb, 0.24);
  assert.equal(mild.reason, "vol_rich");
  const cheap = adaptCapOdds({ baseProb: base, impliedVolAnnual: 0.3, realizedVolAnnual: 0.6 });
  assert.equal(cheap.ratio, 0.5);
  assert.equal(cheap.adviceProb, 0.1, "clamped at the band's floor");
  assert.equal(cheap.reason, "vol_cheap");
  const noVol = adaptCapOdds({ baseProb: base, impliedVolAnnual: 0.5, realizedVolAnnual: null });
  assert.deepEqual([noVol.adviceProb, noVol.ratio, noVol.reason], [0.2, null, "no_vol"], "no realized vol: the published odds, unchanged");
  assert.equal(adaptCapOdds({ baseProb: base, impliedVolAnnual: 0, realizedVolAnnual: 0.5 }).reason, "no_vol");
  const brand = adaptCapOdds({ baseProb: 0.25, impliedVolAnnual: 0.9, realizedVolAnnual: 0.3, band: { lo: 0.15, hi: 0.28 } });
  assert.equal(brand.adviceProb, 0.28, "a brand's own band bounds it");
  assert.equal(adaptCapOdds({ baseProb: 0.5, impliedVolAnnual: null, realizedVolAnnual: null }).baseProb, 0.3, "a base outside the band is pulled inside before anything else");
  const slow = adaptCapOdds({ baseProb: base, impliedVolAnnual: 0.6, realizedVolAnnual: 0.5, slope: 0.05 });
  assert.equal(slow.adviceProb, 0.21);

  assert.deepEqual(applyCapOdds({ kind: "target", maxExceedProb: 0.2 }, rich), { kind: "target", maxExceedProb: 0.3 });
  assert.deepEqual(applyCapOdds({ kind: "widest" }, rich), { kind: "widest" }, "widest has no odds to move");

  // identity: whichever strike the odds pick, who keeps what is unchanged. Settle the same position
  // under two caps at the same print: credit and take are inputs, cap excess is the only mover,
  // and writer = take at both.
  const a = openRec("long", "a");
  const print = 8_400_000;
  const nearer = perpOutcome({ ...a, capStrikeCents: 8_200_000 }, print, { hasPath: false, openMs: 0, expiryMs: 0 }, "plain");
  const wider = perpOutcome({ ...a, capStrikeCents: 8_300_000 }, print, { hasPath: false, openMs: 0, expiryMs: 0 }, "plain");
  assert.equal(nearer.writerCents, a.takeCents);
  assert.equal(wider.writerCents, a.takeCents);
  assert.equal(nearer.paidCents, wider.paidCents, "the credit paid is what was quoted; the strike does not touch it");
  assert.equal(nearer.capExcessCents - wider.capExcessCents, Math.round(a.contracts * a.ctValBtc * (8_300_000 - 8_200_000)), "the strike moves the cap excess by exactly the distance between them");
});

// ── RFQ routing ──────────────────────────────────────────────────────────────

test("rfq: the collar packages as two legs for one net; the desk must beat the book by the published margin", () => {
  const long = packageFor({ side: "long", contracts: 300, ctValBtc: 0.01, notionalCents: 24_000_000_00, expiryIso: "2026-10-16T08:00:00.000Z", floorStrikeCents: 7_520_000, capStrikeCents: 8_300_000, bookNetCreditCents: 1_234_567 });
  assert.equal(long.underlying, "BTC");
  assert.equal(long.qtyBtc, 3);
  assert.deepEqual(long.legs.map((l) => [l.side, l.type, l.strikeCents]), [["buy", "put", 7_520_000], ["sell", "call", 8_300_000]]);
  assert.ok(long.legs.every((l) => l.expiryIso === "2026-10-16T08:00:00.000Z" && l.contracts === 300 && l.ctValBtc === 0.01));
  assert.equal(long.bookNetCents, 1_234_567);
  assert.equal(long.beatBookNetCents, 1_234_567 + 240_000, "1 bp of $2.4m notional ($240) is the margin when it is above the tie");
  const short = packageFor({ side: "short", underlying: "ETH", contracts: 10, ctValBtc: 0.01, notionalCents: 800_000, expiryIso: "2026-10-16T08:00:00.000Z", floorStrikeCents: 8_480_000, capStrikeCents: 7_700_000, bookNetCreditCents: 1_000 });
  assert.deepEqual(short.legs.map((l) => [l.side, l.type, l.strikeCents]), [["buy", "call", 8_480_000], ["sell", "put", 7_700_000]], "a short mirrors: floor is a call above, cap is a put below");
  assert.equal(short.underlying, "ETH");
  assert.equal(short.beatBookNetCents, 1_080, "an $8,000 wrap: 1 bp is $0.80, above the $0.50 tie, so the margin is the bp");
  assert.equal(packageFor({ ...{ side: "long" as const, contracts: 1, ctValBtc: 0.01, notionalCents: 80_000, expiryIso: "x", floorStrikeCents: 1, capStrikeCents: 2, bookNetCreditCents: 100 } }).beatBookNetCents, 150, "below the tie the tie is the margin");

  const big = { notionalCents: 24_000_000_00, bookNetCents: 1_234_567 };
  assert.deepEqual(decideRoute({ ...big, dealerNetCents: 1_500_000 }), { route: "rfq", improvementCents: 265_433, reason: "dealer_better" });
  assert.deepEqual(decideRoute({ ...big, dealerNetCents: 1_234_567 + 240_000 }), { route: "rfq", improvementCents: 240_000, reason: "dealer_better" }, "exactly the margin routes");
  assert.deepEqual(decideRoute({ ...big, dealerNetCents: 1_234_567 + 239_999 }), { route: "book", improvementCents: 239_999, reason: "within_tie" });
  assert.deepEqual(decideRoute({ ...big, dealerNetCents: 1_000_000 }), { route: "book", improvementCents: -234_567, reason: "dealer_worse" });
  assert.deepEqual(decideRoute({ ...big, dealerNetCents: null }), { route: "book", improvementCents: null, reason: "no_dealer_quote" });
  assert.deepEqual(decideRoute({ notionalCents: 4_999_999, bookNetCents: 1_000, dealerNetCents: 9_000 }), { route: "book", improvementCents: 8_000, reason: "below_size_threshold" }, "small wraps go to the book whatever the desk says");
  assert.deepEqual(decideRoute({ notionalCents: 4_999_999, bookNetCents: 1_000, dealerNetCents: 9_000 }, { ...DEFAULT_RFQ_ROUTE, sizeThresholdCents: 0 }).route, "rfq");

  assert.deepEqual(rfqConfigFromEnv({}), DEFAULT_RFQ_ROUTE);
  assert.deepEqual(rfqConfigFromEnv({ EP_RFQ_SIZE_THRESHOLD_USD: "100000", EP_RFQ_MIN_IMPROVEMENT_BPS: "2.5", EP_RFQ_TIE_USD: "1" }), { sizeThresholdCents: 10_000_000, minImprovementBps: 2.5, tieCents: 100 });
  assert.deepEqual(rfqConfigFromEnv({ EP_RFQ_SIZE_THRESHOLD_USD: "-1", EP_RFQ_MIN_IMPROVEMENT_BPS: "abc" }), DEFAULT_RFQ_ROUTE, "nonsense falls back");
});

test("rfq true-up: a better fill is shared at the take rate; a worse fill is ours; the shown credit never goes down (identity re-derived)", () => {
  const q = { shownCreditCents: 80_000, quotedTakeCents: 20_000, quotedNetCents: 100_000, takeRate: 0.2 };
  const same = trueUpCredit({ ...q, filledNetCents: 100_000 });
  assert.deepEqual(same, { creditCents: 80_000, takeCents: 20_000, fillShortfallCents: 0, holderGainCents: 0 });
  const better = trueUpCredit({ ...q, filledNetCents: 110_000 });
  assert.deepEqual(better, { creditCents: 88_000, takeCents: 22_000, fillShortfallCents: 0, holderGainCents: 8_000 });
  assert.equal(better.creditCents + better.takeCents, 110_000, "the whole fill is accounted for: trader + take = net");
  const worse = trueUpCredit({ ...q, filledNetCents: 95_000 });
  assert.deepEqual(worse, { creditCents: 80_000, takeCents: 15_000, fillShortfallCents: 5_000, holderGainCents: 0 });
  assert.equal(worse.creditCents + worse.takeCents, 95_000, "the shortfall came out of the take, not the credit");
  const badly = trueUpCredit({ ...q, filledNetCents: 70_000 });
  assert.equal(badly.creditCents, 80_000, "a fill below the shown credit still pays the shown credit");
  assert.equal(badly.takeCents, -10_000, "and the writer's P&L on the cycle is negative by the gap: the one place writer != take");
  assert.equal(badly.fillShortfallCents, 30_000);
  const odd = trueUpCredit({ ...q, filledNetCents: 100_003 });
  assert.equal(odd.creditCents + odd.takeCents, 100_003, "cents split without a remainder going missing");
});

// ── The worker: alarms, drift, the second print, the Friday post ─────────────

test("perp shadow worker: overdue positions raise an alarm to the sink and /healthz; the Hyperliquid mark settles them when OKX never prints; the Friday review posts once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perp-shadow-ops-"));
  const path = join(dir, "ledger.jsonl");
  const alerts = join(dir, "alerts.jsonl");
  process.env.NODE_ENV = "test";
  process.env.PERP_SHADOW_LEDGER_PATH = path;
  process.env.EP_ALERTS_PATH = alerts;
  process.env.EP_ADMIN_TOKEN = "op-secret";
  // the fixture expiries are weeks old; keep them inside the void window so the second source gets its turn
  process.env.PERP_SHADOW_VOID_AFTER_MS = String(10 * 365 * 24 * HOUR);
  delete process.env.ALERT_WEBHOOK_URL;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_ALERT_CHAT_ID;
  const { server, settleTick, opsTick, driftTick } = await import("../scripts/perpShadowWorker");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const readAlerts = () => (existsSync(alerts) ? readFileSync(alerts, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { kind: string; message: string; data?: Record<string, unknown> }) : []);
  try {
    let health = (await (await fetch(`${base}/healthz`)).json()) as Record<string, unknown>;
    assert.deepEqual(health.alarms, []);
    assert.deepEqual(health.alertSink, { webhook: false, telegram: false, path: alerts, cooldownMs: 6 * HOUR }, "the sink is described as booleans; no URL, no token, ever");
    assert.deepEqual(health.settlement, { graceMs: 20 * 60_000, hlPrintAfterMs: 24 * HOUR, voidAfterMs: 10 * 365 * 24 * HOUR, stallMs: 6 * HOUR });
    assert.ok(!JSON.stringify(health).includes("op-secret"));

    // drift: the real parsers against injected payloads, the _UM spelling included
    const okPayloads = {
      delivery: async () => ({ data: [{ ts: "1", details: [{ insId: "BTC-USD_UM-251002-85500-C", px: "85879.11", type: "exercised" }] }, { ts: "2", details: [{ insId: "BTC-USD-250925-80000-P", px: "80000", type: "expired_otm" }] }] }),
      hl: async () => ({ markPx: 80_000, oraclePx: 80_000, fundingBpsPer8h: 0.1, atIso: new Date().toISOString() }) as never,
      candles: async (_c: string, s: number, e: number, i: string) => flatCandles(s, e, i === "1m" ? 60_000 : 5 * 60_000, 70_000),
      index: async () => 79_990,
    };
    const checks = await driftTick(okPayloads);
    assert.deepEqual(checks.map((c) => [c.name, c.ok]), [["okx_delivery_history", true], ["hl_context", true], ["hl_candles", true], ["okx_index", true]]);
    assert.equal(checks[0].detail, "2 readable prints");
    assert.deepEqual(opsTick(Date.now()), [], "an empty ledger a moment after boot: nothing to say");

    // a renamed instrument the parser cannot read, and an index that stopped answering
    const drifted = await driftTick({ ...okPayloads, delivery: async () => ({ data: [{ ts: "1", details: [{ insId: "BTCUSD-OPT-251002-85500-C", px: "85879.11" }] }] }), index: async () => { throw new Error("OKX index-tickers HTTP 503"); } });
    assert.deepEqual(drifted.filter((c) => !c.ok).map((c) => [c.name, c.detail]), [["okx_delivery_history", "no row parsed to a date code and a price"], ["okx_index", "OKX index-tickers HTTP 503"]]);
    let alarms = opsTick(Date.now());
    assert.deepEqual(alarms.map((a) => a.kind), ["venue_payload_drift"]);
    assert.equal(readAlerts().filter((a) => a.kind === "venue_payload_drift").length, 1);
    opsTick(Date.now());
    assert.equal(readAlerts().filter((a) => a.kind === "venue_payload_drift").length, 1, "the same drift set is raised once per cooldown, not once per tick");
    health = (await (await fetch(`${base}/healthz`)).json()) as Record<string, unknown>;
    assert.deepEqual((health.alarms as Array<{ kind: string }>).map((a) => a.kind), ["venue_payload_drift"]);
    assert.equal((health.drift as { checks: unknown[] }).checks.length, 4);
    await driftTick(okPayloads);

    // two positions, long and short, expired 2026-09-20 and never settled: the stall alarm
    const a = openRec("long", "a");
    const b = openRec("short", "b", "2026-09-19T00:00:00.000Z");
    appendPerpShadowRecord(path, a);
    appendPerpShadowRecord(path, b);
    alarms = opsTick(Date.now());
    assert.deepEqual(alarms.map((a) => a.kind), ["settlement_stalled"]);
    assert.match(alarms[0].message, /^2 positions past expiry and still open; oldest expiry 2026-09-20 08:00 UTC/);
    const stalled = readAlerts().filter((x) => x.kind === "settlement_stalled");
    assert.equal(stalled.length, 1);
    assert.deepEqual(stalled[0].data?.expiries, { [a.expiryIso]: 2 });
    const ops = (await (await fetch(`${base}/api/shadow/ops`)).json()) as { ok: boolean; alarms: Array<{ kind: string }>; drift: { checks: Array<{ ok: boolean }> } };
    assert.equal(ops.ok, true);
    assert.deepEqual(ops.alarms.map((x) => x.kind), ["settlement_stalled"]);
    assert.ok(ops.drift.checks.every((c) => c.ok));

    // OKX never prints this expiry; a day past expiry the Hyperliquid mark at the expiry minute settles the group
    let deliveryCalls = 0;
    const candleCalls: Array<[number, number, string]> = [];
    await settleTick({
      delivery: async () => {
        deliveryCalls += 1;
        return null;
      },
      candles: async (_c, s, e, i) => {
        candleCalls.push([s, e, i]);
        return flatCandles(s, e, i === "1m" ? 60_000 : 5 * 60_000, 70_000);
      },
      okxAround: async () => [],
    });
    assert.equal(deliveryCalls, 1, "one delivery lookup per expiry group");
    assert.equal(candleCalls[0][2], "1m");
    assert.deepEqual([candleCalls[0][0], candleCalls[0][1]], [DAILY - 30 * 60_000, DAILY + 60_000], "the print window: the half hour into expiry");
    const { positions, reviewed } = loadPerpShadow(path, { capMode: "plain" });
    assert.deepEqual(positions.map((p) => [p.id, p.status, p.settleSource, p.settleCents]), [["a", "settled", "hl_mark", 7_000_000], ["b", "settled", "hl_mark", 7_000_000]]);
    assert.ok(positions[0].outcome?.floorSave, "the long's floor paid at 70,000");
    assert.equal(positions[0].outcome?.writerCents, a.takeCents);
    assert.equal(positions[1].outcome?.writerCents, b.takeCents);
    assert.deepEqual([...reviewed], [a.expiryIso], "the Friday review for that expiry is recorded in the ledger");
    const ledgerTypes = readFileSync(path, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { type: string }).type);
    assert.deepEqual(ledgerTypes, ["open", "open", "settle", "settle", "review"]);
    const friday = readAlerts().filter((x) => x.kind === "friday_review");
    assert.equal(friday.length, 1);
    assert.match(friday[0].message, /^Friday review · expiry 2026-09-20 08:00 UTC · print \$70,000 \(hl_mark\)\n2 settled \(1 long, 1 short\)/);
    assert.match(friday[0].message, /the floor paid this week/);
    assert.deepEqual(friday[0].data, { expiryIso: a.expiryIso, flags: ["floor_paid"] });

    // a second settle pass with nothing due posts nothing twice
    await settleTick({ delivery: async () => null, candles: async () => [], okxAround: async () => [] });
    assert.equal(readAlerts().filter((x) => x.kind === "friday_review").length, 1);
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 5, "no second review record");
    assert.deepEqual(opsTick(Date.now()), [], "settled: the stall alarm clears");
    health = (await (await fetch(`${base}/healthz`)).json()) as Record<string, unknown>;
    assert.deepEqual(health.alarms, []);

    // the public record carries the Friday rows, the ladder and the fee share
    const api = (await (await fetch(`${base}/api/shadow`)).json()) as {
      summary: { fridays: Array<{ expiryIso: string; settled: number; settleSource: string; flags: string[] }>; capLadder: Array<{ settled: number }>; feeShare: { feePct: number | null }; capOdds: { adaptApplied: boolean; latest: unknown } };
    };
    assert.equal(api.summary.fridays.length, 1);
    assert.deepEqual([api.summary.fridays[0].settled, api.summary.fridays[0].settleSource, api.summary.fridays[0].flags], [2, "hl_mark", ["floor_paid"]]);
    assert.ok(api.summary.capLadder.length >= 1 && api.summary.capLadder.every((r) => r.settled > 0));
    assert.ok(api.summary.feeShare.feePct != null && api.summary.feeShare.feePct > 0);
    assert.deepEqual(api.summary.capOdds, { adaptApplied: false, latest: null }, "EP_CAP_ODDS_ADAPT off by default: measured, not applied");
    const fridays = (await (await fetch(`${base}/api/shadow/fridays`)).json()) as { ok: boolean; fridays: unknown[]; config: { capExceedProb: number } };
    assert.equal(fridays.ok, true);
    assert.equal(fridays.fridays.length, 1);
    assert.equal(fridays.config.capExceedProb, 0.2);

    const page = await (await fetch(`${base}/`)).text();
    assert.ok(page.includes("Friday by Friday") && page.includes("The cap ladder") && page.includes("venue fees, share of gross"));
    assert.ok(page.includes("hl_mark") || page.includes("Hyperliquid mark"), "the second source is named on the page");
    assert.ok(!page.includes("NaN") && !page.includes("undefined") && !page.includes("op-secret"));
    assert.ok(!page.includes("—"), "no em dashes on the public page");
  } finally {
    delete process.env.EP_ADMIN_TOKEN;
    delete process.env.EP_ALERTS_PATH;
    delete process.env.PERP_SHADOW_VOID_AFTER_MS;
    await new Promise<void>((r) => server.close(() => r()));
  }
});
