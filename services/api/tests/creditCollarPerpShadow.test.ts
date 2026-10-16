import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { OkxChainInstrument } from "../src/singleSide/twoSided/creditCollar/execution/okxLivePlanner";
import {
  instrumentsInBand,
  nextListedWeeklyExpiryMs,
  parseDepth,
  quoteCollarFromSnapshot,
  walkBook,
  type BookDepth,
  type OkxListedSnapshot,
} from "../src/singleSide/twoSided/creditCollar/perpShadow/okxListedSnapshot";
import {
  PERP_CSV_COLUMNS,
  PERP_CSV_PUBLIC_COLUMNS,
  appendPerpShadowRecord,
  buybackEstimateCents,
  capBucket,
  loadPerpShadow,
  nearestAtm,
  perpOutcome,
  perpPositionsCsv,
  replayPerpShadow,
  summarizePerpShadow,
  type PerpPath,
  type PerpShadowOpenRecord,
  type PerpShadowRecord,
} from "../src/singleSide/twoSided/creditCollar/perpShadow/perpShadowLedger";
import {
  dateCodeForExpiry,
  deliveryPriceFor,
  parseHlContext,
  parseOkxIndex,
} from "../src/singleSide/twoSided/creditCollar/perpShadow/perpShadowMarket";
import {
  candleIntervalFor,
  firstTouches,
  okxConfirms,
  parseHlCandles,
  parseOkxIndexCandles,
  pathRange,
  type Candle,
} from "../src/singleSide/twoSided/creditCollar/perpShadow/perpShadowPath";
import { feeRuleText, perpShadowQuote, perpTake } from "../src/singleSide/twoSided/creditCollar/perpShadow/perpShadowQuote";
import { renderPerpShadowReportHtml } from "../scripts/perpShadowHtml";

// ── Fixture: a daily and a weekly chain around spot 80,000 ──────────────────

const DAILY = Date.UTC(2026, 8, 20, 8); // Sun 2026-09-20 08:00Z
const WEEKLY = Date.UTC(2026, 8, 25, 8); // Fri 2026-09-25 08:00Z
const SPOT = 80_000;

const inst = (expiryMs: number, optType: "put" | "call", strike: number): OkxChainInstrument => {
  const d = new Date(expiryMs);
  const code = `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  return { instId: `BTC-USD-${code}-${strike}-${optType === "put" ? "P" : "C"}`, optType, strike, expiryMs, ctValBtc: 0.01, tickSz: 0.0001, lotSz: 1, minSz: 1, state: "live" };
};
const STRIKES = [74000, 75000, 76000, 77000, 78000, 79000, 81000, 82000, 83000, 84000];
const chain: OkxChainInstrument[] = [];
for (const e of [DAILY, WEEKLY]) for (const k of STRIKES) chain.push(inst(e, "put", k), inst(e, "call", k));

const depth = (bid: number | null, ask: number | null, sizeTop = 5, deeper = true): BookDepth => ({
  bids: bid == null ? [] : [{ pxBtc: bid, contracts: sizeTop }, ...(deeper ? [{ pxBtc: bid * 0.8, contracts: 200 }] : [])],
  asks: ask == null ? [] : [{ pxBtc: ask, contracts: sizeTop }, ...(deeper ? [{ pxBtc: ask * 1.25, contracts: 200 }] : [])],
});

/** wings get pricier nearer spot (steeply, as one-day options do), 3% half-spread; the weekly is 10× the daily */
const bookFor = (c: OkxChainInstrument): BookDepth => {
  const dist = Math.abs(c.strike - SPOT) / SPOT; // 0.0125 .. 0.075
  const base = Math.max(0.0002, 0.01 - dist * 0.16); // 0.008 at 1.25% .. 0.0002 from 6% out
  const mid = base * (c.expiryMs === WEEKLY ? 10 : 1);
  return depth(+(mid * 0.97).toFixed(6), +(mid * 1.03).toFixed(6));
};

const snap = (overrides: Partial<OkxListedSnapshot> = {}): OkxListedSnapshot => {
  const books: Record<string, BookDepth> = {};
  for (const c of chain) books[c.instId] = bookFor(c);
  return { atMs: Date.UTC(2026, 8, 18, 23), expiryMs: DAILY, weeklyExpiryMs: WEEKLY, chain, books, booksMissing: 0, ...overrides };
};

const TAKE = { shareRate: 0.2, minTakeBpsOfNotional: 0, deMinimisCents: 5 };

test("perp shadow: depth parsing and the walk down the book", () => {
  const d = parseDepth({ data: [{ bids: [["0.0030", "4", "0", "1"], ["0.0028", "10", "0", "2"]], asks: [["0.0032", "3", "0", "1"]] }] });
  assert.deepEqual(d.bids, [{ pxBtc: 0.003, contracts: 4 }, { pxBtc: 0.0028, contracts: 10 }]);
  assert.deepEqual(walkBook(d.bids, 4), { avgPxBtc: 0.003, levelsUsed: 1, topPxBtc: 0.003 });
  const w = walkBook(d.bids, 9)!;
  assert.equal(w.levelsUsed, 2);
  assert.ok(Math.abs(w.avgPxBtc - (4 * 0.003 + 5 * 0.0028) / 9) < 1e-12, "size-weighted average across levels");
  assert.equal(walkBook(d.bids, 15), null, "the visible depth does not cover the size: null, never a guess");
  assert.equal(walkBook([], 1), null);
  assert.equal(instrumentsInBand(chain, DAILY, SPOT).length, STRIKES.length * 2, "every fixture strike sits inside the union band");
  assert.equal(nextListedWeeklyExpiryMs(chain, Date.UTC(2026, 8, 18, 23)), WEEKLY, "the Friday 08:00 ≥ 3 days out");
  assert.equal(nextListedWeeklyExpiryMs(chain, Date.UTC(2026, 8, 22, 23)), null, "a weekly 2.4 days out is not a weekly tenor");
});

test("perp shadow: a long collar from the snapshot mirrors the live demo's wing selection", () => {
  const q = quoteCollarFromSnapshot({ side: "long", spot: SPOT, contracts: 3, geometry: { floorPct: 0.06, capPct: 0.015 } }, snap());
  assert.ok(q.ok);
  if (!q.ok) return;
  assert.equal(q.buyInstId, "BTC-USD-260920-75000-P", "protective wing: nearest listed to 6% below with an ask");
  // funding wing: the WIDEST in-band call whose net credit clears fees. Fixture calls fall to 0.0002 deep,
  // so far strikes cannot fund the 75000 put's ask; the pick walks in to the widest that does.
  assert.equal(q.sellInstId.endsWith("-C"), true);
  assert.ok(q.sellStrike > SPOT && q.buyStrike < SPOT);
  assert.ok(q.netCreditUsdc > 0);
  assert.equal(q.grossCreditUsdc, +((q.sellPxBtc - q.buyPxBtc) * 3 * 0.01 * SPOT).toFixed(2));
  assert.ok(q.venueFeeUsdc > 0 && q.netCreditUsdc === +(q.grossCreditUsdc - q.venueFeeUsdc).toFixed(2));
  assert.ok(q.midCreditUsdc != null && q.midCreditUsdc > q.netCreditUsdc, "the collar at mids is worth more than at the touch: the spread we pay");
  assert.deepEqual(q.levelsUsed, { buy: 1, sell: 1 });
  assert.equal(q.expiryMs, DAILY);

  const s = quoteCollarFromSnapshot({ side: "short", spot: SPOT, contracts: 3, geometry: { floorPct: 0.06, capPct: 0.015 } }, snap());
  assert.ok(s.ok);
  if (!s.ok) return;
  assert.ok(s.buyInstId.endsWith("-C") && s.sellInstId.endsWith("-P"), "a short buys the call and sells the put");
  assert.ok(s.buyStrike > SPOT && s.sellStrike < SPOT);

  const weekly = quoteCollarFromSnapshot({ side: "long", spot: SPOT, contracts: 3, geometry: { floorPct: 0.06, capPct: 0.015 }, expiryMs: WEEKLY }, snap());
  assert.ok(weekly.ok);
  if (!weekly.ok) return;
  assert.equal(weekly.expiryMs, WEEKLY);
  assert.ok(weekly.buyInstId.includes("260925") && weekly.sellInstId.includes("260925"));
  assert.ok(weekly.netCreditUsdc > q.netCreditUsdc * 5, "the weekly funds several times the daily's credit");
});

test("perp shadow: walking the depth for size costs more than the top, and beyond the depth it refuses", () => {
  const top = quoteCollarFromSnapshot({ side: "long", spot: SPOT, contracts: 30, geometry: { floorPct: 0.06, capPct: 0.015 }, mode: "top" }, snap());
  const walk = quoteCollarFromSnapshot({ side: "long", spot: SPOT, contracts: 30, geometry: { floorPct: 0.06, capPct: 0.015 }, mode: "walk" }, snap());
  assert.ok(top.ok && walk.ok);
  if (!top.ok || !walk.ok) return;
  assert.equal(walk.buyInstId, top.buyInstId, "the protective wing is the nearest with an ask in both modes");
  assert.ok(walk.buyPxBtc > top.buyPxBtc, "buying 30 through a 5-lot top pays more than the top");
  assert.ok(walk.levelsUsed.buy === 2 && walk.levelsUsed.sell === 2);
  // the funding pick is the widest strike that still clears after the walk; on the same strike it receives less
  if (walk.sellInstId === top.sellInstId) assert.ok(walk.sellPxBtc < top.sellPxBtc, "selling 30 receives less");
  else assert.ok(Math.abs(walk.sellStrike - SPOT) <= Math.abs(top.sellStrike - SPOT), "walking can only shrink the set of wings that clear");
  assert.ok(walk.midCreditUsdc! - walk.netCreditUsdc > top.midCreditUsdc! - top.netCreditUsdc, "the spread paid grows with size");
  const huge = quoteCollarFromSnapshot({ side: "long", spot: SPOT, contracts: 5000, geometry: { floorPct: 0.06, capPct: 0.015 }, mode: "walk" }, snap());
  assert.ok(!huge.ok && huge.error === "depth_insufficient");
});

test("perp shadow: refusals name the reason; a missing book is never priced", () => {
  const empty = snap({ books: {} });
  const q = quoteCollarFromSnapshot({ side: "long", spot: SPOT, contracts: 3, geometry: { floorPct: 0.06, capPct: 0.015 } }, empty);
  assert.ok(!q.ok && q.error === "listed_book_empty");
  // a book where every call bid is below the put ask cannot fund a credit
  const books: Record<string, BookDepth> = {};
  for (const c of chain) books[c.instId] = c.optType === "call" ? depth(0.0001, 0.0002) : depth(0.001, 0.002);
  const nonpos = quoteCollarFromSnapshot({ side: "long", spot: SPOT, contracts: 3, geometry: { floorPct: 0.06, capPct: 0.015 } }, snap({ books }));
  assert.ok(!nonpos.ok && nonpos.error === "listed_credit_nonpositive");
  assert.match(nonpos.message, /≤ 0/);
  const zero = quoteCollarFromSnapshot({ side: "long", spot: SPOT, contracts: 0, geometry: { floorPct: 0.06, capPct: 0.015 } }, snap());
  assert.ok(!zero.ok && zero.error === "below_min_lot");
});

test("perp shadow: the take is the larger of share and minimum, waived when tiny, never more than the credit", () => {
  assert.deepEqual(perpTake(1000, 250_000, TAKE), { takeCents: 200, takeShareCents: 200, takeMinimumCents: 0, takeRule: "share", creditCents: 800 });
  assert.deepEqual(perpTake(1000, 250_000, { ...TAKE, minTakeBpsOfNotional: 5 }), { takeCents: 200, takeShareCents: 200, takeMinimumCents: 125, takeRule: "share", creditCents: 800 });
  assert.deepEqual(perpTake(100, 250_000, { ...TAKE, minTakeBpsOfNotional: 5 }), { takeCents: 100, takeShareCents: 20, takeMinimumCents: 125, takeRule: "minimum", creditCents: 0 });
  assert.deepEqual(perpTake(9, 250_000, TAKE), { takeCents: 0, takeShareCents: 2, takeMinimumCents: 0, takeRule: "waived", creditCents: 9 });
  assert.equal(feeRuleText("min_5bps").name, "share or 0.05% of notional");
  assert.equal(feeRuleText("share_only").name, "share only");
  assert.equal(feeRuleText("mystery").name, "mystery");
});

const GUARD = { minCapPct: 0.02, maxCapPct: 0.04 };
const quoteInputs = (side: "long" | "short", id = `t-${side}`) => ({
  side,
  spot: SPOT,
  contracts: 3,
  geometry: { floorPct: 0.06, capPct: 0.015 },
  tenor: "daily" as const,
  capGuard: GUARD,
  otherTenorCapGuard: { minCapPct: 0.04, maxCapPct: 0.08 },
  take: TAKE,
  counterfactualMinTakeBps: 5,
  okxIndex: 79_970,
  fundingBpsPer8h: 0.125,
  nowIso: "2026-09-18T23:00:00.000Z",
  id,
});

test("perp shadow: one snapshot becomes one open record with every counterfactual from the same books", () => {
  const rec = perpShadowQuote(quoteInputs("long"), snap());
  assert.equal(rec.type, "open");
  if (rec.type !== "open") return;
  assert.equal(rec.capGuardPct, 0.02);
  assert.equal(rec.contracts, 3);
  assert.equal(rec.notionalCents, 240_000);
  assert.equal(rec.spotCents, 8_000_000);
  assert.equal(rec.okxIndexCents, 7_997_000);
  assert.equal(rec.basisBps, 3.8, "(80000 − 79970) / 79970 in bps");
  assert.equal(rec.fundingBpsPer8h, 0.125);
  // 33h to expiry = 4.125 funding periods on $2,400 at 0.125 bps/8h → 12¢, the holder pays
  assert.equal(rec.fundingCycleCents, Math.round(240_000 * (0.125 / 10000) * (33 / 8)));
  assert.ok(rec.atmRef && rec.atmRef.callAskPxBtc! > 0 && rec.atmRef.putAskPxBtc! > 0 && rec.atmRef.hoursToExpiry === 33);
  assert.equal(rec.expiryIso, new Date(DAILY).toISOString());
  assert.equal(rec.creditCents, rec.netCreditCents - rec.takeCents, "the holder gets net minus take");
  assert.equal(rec.netCreditCents, rec.grossCreditCents - rec.venueFeeCents);
  assert.ok(rec.midCreditCents != null && rec.midCreditCents > rec.netCreditCents);
  const cf = rec.counterfactuals!;
  assert.equal(cf.version, 2);
  // the cap ladder: every listed call above spot inside the 4% band, nearest first, floor held
  assert.deepEqual(cf.capLadder.map((r) => r.capStrikeCents), [8_100_000, 8_200_000, 8_300_000]);
  assert.deepEqual(cf.capLadder.map((r) => r.capPct), [0.0125, 0.025, 0.0375]);
  assert.deepEqual(cf.capLadder.map((r) => r.underGuard), [true, false, false], "1.25% sits under the 2% guard");
  const liveRung = cf.capLadder.find((r) => r.live)!;
  assert.equal(liveRung.sellInstId, rec.sellInstId, "the live pick is a rung");
  assert.ok(liveRung.terms.ok && liveRung.terms.creditCents === rec.creditCents);
  assert.ok(rec.capPct >= 0.02, "the live pick clears the guard");
  for (const r of cf.capLadder) if (r.terms.ok) assert.equal(r.terms.floorStrikeCents, rec.floorStrikeCents, "every rung keeps the live floor");
  const closer = cf.capLadder[0].terms;
  assert.ok(closer.ok && closer.creditCents > rec.creditCents, "the closer cap pays more cash; the shadow will show what it costs in knock-outs");
  // fee rules hold the collar and change only the split
  assert.deepEqual(Object.keys(cf.feeRules), ["share_only", "min_5bps"]);
  assert.equal(cf.feeRules.share_only.takeCents, rec.takeShareCents);
  assert.equal(cf.feeRules.share_only.creditCents + cf.feeRules.share_only.takeCents, rec.netCreditCents);
  assert.equal(cf.feeRules.min_5bps.creditCents + cf.feeRules.min_5bps.takeCents, rec.netCreditCents);
  assert.equal(cf.feeRules.min_5bps.refused, cf.feeRules.min_5bps.creditCents <= 0);
  // size ladder walks the depth
  assert.deepEqual(cf.sizeLadder.map((s) => s.mult), [1, 10, 50]);
  assert.deepEqual(cf.sizeLadder.map((s) => s.contracts), [3, 30, 150]);
  const one = cf.sizeLadder[0].terms;
  assert.ok(one.ok && one.creditCents === rec.creditCents, "1× walked equals the live top when the top covers the size");
  const ten = cf.sizeLadder[1].terms;
  assert.ok(ten.ok && ten.levelsUsed.buy === 2, "10× has to go a level deeper");
  // tenor
  const weekly = cf.tenors.weekly;
  assert.ok(weekly.ok && weekly.expiryIso === new Date(WEEKLY).toISOString());
  assert.ok(weekly.ok && weekly.creditCents > rec.creditCents * 5, "the weekly is where the credit is real");

  assert.equal(rec.tenor, "daily");
  // the floor ladder: the same collar with the floor at 5/6/7/8%, the cap re-found at each; 6% is the live shape
  const fl = cf.floorLadder!;
  assert.deepEqual(fl.map((r) => r.floorPct), [0.05, 0.06, 0.07, 0.08]);
  assert.deepEqual(fl.map((r) => r.live), [false, true, false, false]);
  const fLive = fl[1].terms;
  assert.ok(fLive.ok && fLive.creditCents === rec.creditCents && fLive.floorStrikeCents === rec.floorStrikeCents, "the live rung is the live quote");
  const f5 = fl[0].terms;
  const f8 = fl[3].terms;
  assert.ok(f5.ok && f8.ok);
  assert.ok(f5.floorStrikeCents > fLive.floorStrikeCents && f8.floorStrikeCents < fLive.floorStrikeCents, "shallower floor sits higher, deeper lower");
  assert.ok(fLive.creditCents > f5.creditCents, "the shallower floor costs more, so it pays less at the same cap");
  assert.ok(f8.creditCents >= fLive.creditCents, "a deeper floor is never dearer (this fixture's wings flatten past 6%, so it ties)");
  for (const r of fl) if (r.terms.ok) assert.equal(r.terms.capStrikeCents, rec.capStrikeCents, "on this fixture the widest paying cap is the same at every depth");
  assert.ok(rec.capRuleApplied === "widest" && rec.capExceedProb === null, "no vols on this snapshot: the widest rule decided, no odds invented");
  // the counterfactual floor rule, judged on that ladder: tightest depth whose credit clears 5 bps, else the best paying
  assert.ok(rec.floorRulePick, "every quote carries the floor rule's verdict");
  assert.match(rec.floorRulePick!.rule, /tightest floor in 5–8%/);
  assert.ok(["clears_minimum", "best_paying"].includes(rec.floorRulePick!.by), "on a fixture where every depth pays, the rule lands on a depth");
  assert.ok(rec.floorRulePick!.floorPct != null && fl.some((r) => r.floorPct === rec.floorRulePick!.floorPct), "the pick is one of the depths tried");

  const noWeekly = perpShadowQuote(quoteInputs("long"), snap({ weeklyExpiryMs: null }));
  assert.ok(noWeekly.type === "open" && Object.keys(noWeekly.counterfactuals!.tenors).length === 0, "no weekly listed: no tenor counterfactual, nothing invented");

  // The live product written to the weekly (the default): the legs, the cap ladder and the ATM
  // reference are all at the Friday; the daily becomes the counterfactual, in its own band.
  const WEEKLY_GUARD = { minCapPct: 0.04, maxCapPct: 0.08 };
  const wk = perpShadowQuote({ ...quoteInputs("long", "t-wk"), tenor: "weekly", capGuard: WEEKLY_GUARD, otherTenorCapGuard: GUARD }, snap());
  assert.equal(wk.type, "open");
  if (wk.type !== "open") return;
  assert.equal(wk.tenor, "weekly");
  assert.equal(wk.expiryIso, new Date(WEEKLY).toISOString());
  assert.ok(wk.buyInstId.includes("260925") && wk.sellInstId.includes("260925"), "both legs at the Friday");
  assert.ok(wk.counterfactuals!.capLadder.every((r) => r.sellInstId.includes("260925")), "the cap ladder walks the weekly's strikes");
  assert.ok(wk.counterfactuals!.capLadder.some((r) => r.live), "the live pick is one rung");
  assert.equal(wk.capGuardPct, 0.04);
  const dailyAlt = wk.counterfactuals!.tenors.daily;
  assert.ok(dailyAlt && dailyAlt.ok && dailyAlt.expiryIso === new Date(DAILY).toISOString(), "the other tenor is the daily");
  assert.ok(dailyAlt.ok && dailyAlt.creditCents === rec.creditCents, "and it is the daily quote, to the cent");
  assert.equal(wk.counterfactuals!.tenors.weekly, undefined, "no weekly-vs-weekly row");
  assert.ok(wk.creditCents > rec.creditCents * 5, "the live weekly pays what the counterfactual promised");
  assert.ok(wk.atmRef.hoursToExpiry > 100, "the ATM reference is the weekly's time value");

  // The minimum cap distance moves the pick, it does not refuse: with vols on the chain the 20% odds
  // rule alone takes the 3.75% call (the most credit under the ceiling); at least 4.5% out it takes
  // the 5% call, the closer rungs stay on the ladder marked under guard, and the daily counterfactual
  // keeps its own guard.
  const markVols: Record<string, number> = {};
  for (const c of chain) markVols[c.instId] = 0.3;
  const odds = { kind: "target" as const, maxExceedProb: 0.2 };
  const free = perpShadowQuote({ ...quoteInputs("long", "t-free"), tenor: "weekly", capGuard: { minCapPct: 0, maxCapPct: 0.08 }, otherTenorCapGuard: GUARD, capRule: odds }, snap({ markVols }));
  assert.ok(free.type === "open" && free.capStrikeCents === 8_300_000 && free.capRuleApplied === "target", "no floor: the odds rule writes the 3.75% cap");
  const floored = perpShadowQuote({ ...quoteInputs("long", "t-floored"), tenor: "weekly", capGuard: { minCapPct: 0.045, maxCapPct: 0.08 }, otherTenorCapGuard: GUARD, capRule: odds }, snap({ markVols }));
  assert.equal(floored.type, "open", "a paying strike beyond the line exists, so nothing is refused");
  if (floored.type === "open") {
    assert.equal(floored.capStrikeCents, 8_400_000, "the cap moves out to the first paying strike at or beyond 4.5%");
    assert.equal(floored.capRuleApplied, "target");
    assert.equal(floored.capGuardPct, 0.045, "the position records the guard it was written under");
    assert.ok(floored.creditCents < (free as { creditCents: number }).creditCents, "less credit for the wider cap, as the ladder says");
    const ladder = floored.counterfactuals!.capLadder;
    assert.ok(ladder.some((r) => r.underGuard && !r.live && r.terms.ok), "closer rungs are still priced on the ladder, marked under guard");
    assert.ok(ladder.find((r) => r.live)!.capPct >= 0.045);
    const daily = floored.counterfactuals!.tenors.daily;
    assert.ok(daily && daily.ok, "the daily counterfactual is quoted under the daily guard, not the weekly minimum");
  }
  const tooFar = perpShadowQuote({ ...quoteInputs("long", "t-far"), tenor: "weekly", capGuard: { minCapPct: 0.06, maxCapPct: 0.08 }, otherTenorCapGuard: GUARD, capRule: odds }, snap({ markVols }));
  assert.ok(tooFar.type === "refusal" && tooFar.error === "cap_too_close" && /84000-C sits 5\.00% from price, under the 6\.0% guard/.test(tooFar.message), "nothing at or beyond the line pays: refused, with the distance");

  const wkNoFriday = perpShadowQuote({ ...quoteInputs("long", "t-wk2"), tenor: "weekly", capGuard: WEEKLY_GUARD }, snap({ weeklyExpiryMs: null }));
  assert.ok(wkNoFriday.type === "open" && wkNoFriday.tenor === "daily" && wkNoFriday.expiryIso === new Date(DAILY).toISOString(), "no Friday listed: the daily is written and the record says so");

  const refusal = perpShadowQuote(quoteInputs("long"), snap({ books: {} }));
  assert.equal(refusal.type, "refusal");
  if (refusal.type === "refusal") {
    assert.equal(refusal.error, "listed_book_empty");
    assert.equal(refusal.spotCents, 8_000_000);
  }

  // The cap guard in the shadow: when only the 1.25% call pays, the live rule refuses rather than write it.
  const books: Record<string, BookDepth> = {};
  for (const c of chain) books[c.instId] = c.optType === "call" && c.strike > 81000 ? depth(null, null) : bookFor(c);
  const tooClose = perpShadowQuote(quoteInputs("long"), snap({ books }));
  assert.equal(tooClose.type, "refusal");
  if (tooClose.type === "refusal") {
    assert.equal(tooClose.error, "cap_too_close");
    assert.match(tooClose.message, /81000-C sits 1\.25% from price, under the 2\.0% guard/);
  }
  const noGuard = perpShadowQuote({ ...quoteInputs("long"), capGuard: { minCapPct: 0, maxCapPct: 0.04 } }, snap({ books }));
  assert.ok(noGuard.type === "open" && noGuard.capStrikeCents === 8_100_000, "without a guard the same book writes the 1.25% cap");
});

test("perp shadow: plain collar (the product) — the exit is clamped at both wings, the full credit is paid, the writer's side is the take", () => {
  const base = { contracts: 3, ctValBtc: 0.01, spotCents: 8_000_000, creditCents: 650, takeCents: 162 };
  const long = { ...base, side: "long" as const, floorStrikeCents: 7_500_000, capStrikeCents: 8_400_000 };
  const flat = { knockedOut: false, touchedAtIso: null, vestedFraction: 1, paidCents: 650, buybackCents: 0, writerCents: 162 };
  // crash to 70,000: naked −$300, protected floors at 75,000 → −$150 + $6.50 credit — identical to the knock-out collar on the loss side
  let o = perpOutcome(long, 7_000_000);
  assert.deepEqual(o, { nakedCents: -30_000, protectedCents: -15_000 + 650, deltaCents: 15_650, floorSave: true, capHit: false, capExcessCents: 0, ...flat });
  assert.deepEqual(perpOutcome(long, 7_000_000, undefined, "plain"), o, "plain is the default mode");
  // rally to 90,000: the exit is clamped at the 84,000 cap; $180 of gains above it are handed back (they paid for the floor); the writer is flat
  o = perpOutcome(long, 9_000_000);
  assert.deepEqual(o, { nakedCents: 30_000, protectedCents: 12_000 + 650, deltaCents: -18_000 + 650, floorSave: false, capHit: true, capExcessCents: 18_000, ...flat });
  // between: only the credit differs
  o = perpOutcome(long, 8_100_000);
  assert.deepEqual(o, { nakedCents: 3_000, protectedCents: 3_650, deltaCents: 650, floorSave: false, capHit: false, capExcessCents: 0, ...flat });

  const short = { ...base, side: "short" as const, floorStrikeCents: 8_500_000, capStrikeCents: 7_700_000 };
  o = perpOutcome(short, 9_000_000); // rally hurts a short: floor at 85,000 saves it
  assert.deepEqual(o, { nakedCents: -30_000, protectedCents: -15_000 + 650, deltaCents: 15_650, floorSave: true, capHit: false, capExcessCents: 0, ...flat });
  o = perpOutcome(short, 7_000_000); // crash pays a short: clamped at the 77,000 cap, $210 handed back
  assert.equal(o.capHit, true);
  assert.equal(o.knockedOut, false);
  assert.equal(o.nakedCents, 30_000);
  assert.equal(o.capExcessCents, 21_000);
  assert.equal(o.protectedCents, 9_000 + 650);
  assert.equal(o.writerCents, 162);

  // a touch on the path closes nothing in plain mode: it is the moment a release was on offer, priced at the ATM ask for the time left
  const openMs = Date.UTC(2026, 8, 18, 23);
  const expiryMs = DAILY;
  const touchMs = openMs + 11 * 3_600_000;
  const touch = { capStrikeCents: 8_400_000, atIso: new Date(touchMs).toISOString(), hlPxCents: 8_401_000, okxPxCents: 8_399_000, okxConfirmed: false, okxGapBps: -1.2 };
  const atm = { askPxBtc: 0.006, hoursToExpiry: 33 };
  const back = perpOutcome(long, 8_050_000, { touch, hasPath: true, openMs, expiryMs, atm });
  assert.equal(back.knockedOut, false);
  assert.equal(back.capHit, false, "the print came back inside: nothing was handed back");
  assert.equal(back.touchedAtIso, touch.atIso);
  assert.equal(back.paidCents, 650, "the full credit: nothing vests early in a plain collar");
  assert.equal(back.buybackCents, buybackEstimateCents(0.03, 8_400_000, 22, atm), "what releasing at the touch would have cost (informational; nobody paid it)");
  assert.equal(back.writerCents, 162);
  assert.equal(back.protectedCents, 1_500 + 650);
});

test("perp shadow: knock-out mode (EP_CAP_MODE=knockout) — settlement math for a long and a short at floor, cap and between (no path: the print decides)", () => {
  const base = { contracts: 3, ctValBtc: 0.01, spotCents: 8_000_000, creditCents: 650, takeCents: 162 };
  const long = { ...base, side: "long" as const, floorStrikeCents: 7_500_000, capStrikeCents: 8_400_000 };
  const ran = { knockedOut: false, touchedAtIso: null, vestedFraction: 1, paidCents: 650, buybackCents: 0, capExcessCents: 0 };
  // crash to 70,000: naked −$300, protected floors at 75,000 → −$150 + $6.50 credit
  let o = perpOutcome(long, 7_000_000, undefined, "knockout");
  assert.deepEqual(o, { nakedCents: -30_000, protectedCents: -15_000 + 650, deltaCents: 15_650, floorSave: true, capHit: false, writerCents: 162, ...ran });
  // rally to 90,000 with no path: a knock-out at expiry; the holder keeps every gain plus the credit, the writer pays the intrinsic
  o = perpOutcome(long, 9_000_000, undefined, "knockout");
  assert.deepEqual(o, {
    nakedCents: 30_000,
    protectedCents: 30_000 + 650,
    deltaCents: 650,
    floorSave: false,
    capHit: true,
    knockedOut: true,
    touchedAtIso: null,
    vestedFraction: 1,
    paidCents: 650,
    buybackCents: 18_000,
    capExcessCents: 0,
    writerCents: 162 - 18_000,
  });
  // between: only the credit differs
  o = perpOutcome(long, 8_100_000, undefined, "knockout");
  assert.deepEqual(o, { nakedCents: 3_000, protectedCents: 3_650, deltaCents: 650, floorSave: false, capHit: false, writerCents: 162, ...ran });

  const short = { ...base, side: "short" as const, floorStrikeCents: 8_500_000, capStrikeCents: 7_700_000 };
  o = perpOutcome(short, 9_000_000, undefined, "knockout"); // rally hurts a short: floor at 85,000 saves it
  assert.deepEqual(o, { nakedCents: -30_000, protectedCents: -15_000 + 650, deltaCents: 15_650, floorSave: true, capHit: false, writerCents: 162, ...ran });
  o = perpOutcome(short, 7_000_000, undefined, "knockout"); // crash pays a short; the cap was crossed
  assert.equal(o.knockedOut, true);
  assert.equal(o.nakedCents, 30_000);
  assert.equal(o.buybackCents, 21_000);
});

test("perp shadow: knock-out mode — on the path a cap touch is a knock-out at the touch — vested credit paid, unvested kept, buyback at the money", () => {
  const openMs = Date.UTC(2026, 8, 18, 23);
  const expiryMs = DAILY; // 33h later
  const long = { side: "long" as const, contracts: 3, ctValBtc: 0.01, spotCents: 8_000_000, floorStrikeCents: 7_500_000, capStrikeCents: 8_200_000, creditCents: 660, takeCents: 165 };
  const touchMs = openMs + 11 * 3_600_000; // a third of the way
  const touch = { capStrikeCents: 8_200_000, atIso: new Date(touchMs).toISOString(), hlPxCents: 8_201_000, okxPxCents: 8_199_000, okxConfirmed: false, okxGapBps: -1.2 };
  const atm = { askPxBtc: 0.006, hoursToExpiry: 33 };
  // the print came back to 80,500: without the path this is "closed between"; with it, the cycle ended at the touch
  const o = perpOutcome(long, 8_050_000, { touch, hasPath: true, openMs, expiryMs, atm }, "knockout");
  assert.equal(o.knockedOut, true);
  assert.equal(o.capHit, true);
  assert.equal(o.floorSave, false);
  assert.equal(o.touchedAtIso, touch.atIso);
  assert.equal(o.vestedFraction, 0.3333);
  assert.equal(o.paidCents, 220, "a third of the credit had vested");
  assert.equal(o.nakedCents, 1_500);
  assert.equal(o.protectedCents, 1_500 + 220, "the holder keeps the position and every gain, plus what vested");
  assert.equal(o.deltaCents, 220);
  // buyback: ATM ask 0.006 BTC/BTC at 33h, scaled by √(22/33), on 0.03 BTC at the 82,000 cap
  const expectBuyback = Math.round(0.006 * Math.sqrt(22 / 33) * 0.03 * 8_200_000);
  assert.equal(o.buybackCents, expectBuyback);
  assert.equal(buybackEstimateCents(0.03, 8_200_000, 22, atm), expectBuyback);
  assert.equal(buybackEstimateCents(0.03, 8_200_000, 22, null), 0, "no ATM reference: 0, and the summary counts it as priced blind");
  assert.equal(o.writerCents, 165 + (660 - 220) - expectBuyback, "take + unvested kept − buyback");

  // the same position on a path WITHOUT a touch, printing between: floor only, full credit, writer = take
  const ran = perpOutcome(long, 8_050_000, { touch: null, hasPath: true, openMs, expiryMs, atm }, "knockout");
  assert.deepEqual(ran, { nakedCents: 1_500, protectedCents: 2_160, deltaCents: 660, floorSave: false, capHit: false, knockedOut: false, touchedAtIso: null, vestedFraction: 1, paidCents: 660, buybackCents: 0, capExcessCents: 0, writerCents: 165 });
  // a path with no touch but a print beyond the cap: the last candle carried it there — knock-out at expiry, intrinsic buyback
  const gap = perpOutcome(long, 8_300_000, { touch: null, hasPath: true, openMs, expiryMs, atm }, "knockout");
  assert.equal(gap.knockedOut, true);
  assert.equal(gap.touchedAtIso, new Date(expiryMs).toISOString());
  assert.equal(gap.buybackCents, 3_000);
  assert.equal(gap.writerCents, 165 - 3_000);

  // nearestAtm picks the scan closest to the touch that saw an ask for the leg we are short
  const scans = [
    { at: new Date(openMs).toISOString(), expiryIso: new Date(expiryMs).toISOString(), atmRef: { callAskPxBtc: 0.006, putAskPxBtc: 0.005, hoursToExpiry: 33 } },
    { at: new Date(openMs + 10 * 3_600_000).toISOString(), expiryIso: new Date(expiryMs).toISOString(), atmRef: { callAskPxBtc: 0.0045, putAskPxBtc: null, hoursToExpiry: 23 } },
    { at: new Date(openMs + 12 * 3_600_000).toISOString(), expiryIso: "other", atmRef: { callAskPxBtc: 0.001, putAskPxBtc: 0.001, hoursToExpiry: 100 } },
  ];
  assert.deepEqual(nearestAtm(scans, "long", scans[0].expiryIso, touchMs), { askPxBtc: 0.0045, hoursToExpiry: 23 });
  assert.deepEqual(nearestAtm(scans, "short", scans[0].expiryIso, touchMs), { askPxBtc: 0.005, hoursToExpiry: 33 }, "the 10h scan had no put ask; the open's is the nearest that did");
  assert.equal(nearestAtm(scans, "long", "nothing", touchMs), null);
  assert.equal(capBucket(0.0125), "1.5%");
  assert.equal(capBucket(0.0225), "2.5%");
  assert.equal(capBucket(0.0375), "4.0%");
  assert.equal(capBucket(0.031), "3.0%");
});

test("perp shadow path: candles parse, the first touch per cap is found, OKX confirms or stays short", () => {
  const t0 = Date.UTC(2026, 8, 19, 0);
  const hl = parseHlCandles([
    { t: t0, T: t0 + 59_999, s: "BTC", i: "1m", o: "80000", c: "80100", h: "80150", l: "79950", v: "1", n: 1 },
    { t: t0 + 60_000, o: "80100", c: "80900", h: "81000", l: "80050" },
    { t: t0 + 120_000, o: "80900", c: "82100", h: "82250", l: "80800" },
    { t: t0 + 180_000, o: "82100", c: "79000", h: "82100", l: "78900" },
    { t: "junk", o: "x" },
  ]);
  assert.equal(hl.length, 4, "the malformed row is dropped");
  assert.deepEqual(firstTouches(hl, "long", [8_100_000, 8_200_000, 8_500_000], t0, t0 + 3_600_000).map((t) => [t.capStrikeCents, t.atMs - t0, t.hlPxCents]), [
    [8_100_000, 60_000, 8_100_000],
    [8_200_000, 120_000, 8_225_000],
  ]);
  assert.deepEqual(firstTouches(hl, "short", [7_900_000], t0, t0 + 3_600_000).map((t) => [t.atMs - t0, t.hlPxCents]), [[180_000, 7_890_000]], "a short's cap is below: the low reaches it");
  assert.deepEqual(firstTouches(hl, "long", [8_100_000], t0 + 120_000, t0 + 3_600_000).map((t) => t.atMs - t0), [120_000], "candles before the open do not count");
  assert.deepEqual(pathRange(hl, t0, t0 + 3_600_000), { hiCents: 8_225_000, loCents: 7_890_000, candles: 4 });
  assert.equal(pathRange(hl, t0 + 86_400_000, t0 + 2 * 86_400_000), null);
  assert.equal(candleIntervalFor(33 * 3_600_000), "1m");
  assert.equal(candleIntervalFor(6 * 86_400_000), "5m");

  const okx = parseOkxIndexCandles({ data: [[String(t0 + 120_000), "80900", "81990", "80790", "81900", "1"], [String(t0 + 60_000), "80100", "80950", "80040", "80880", "1"]] });
  assert.equal(okx.length, 2);
  assert.ok(okx[0].t < okx[1].t, "sorted oldest first");
  assert.deepEqual(okxConfirms(okx, "long", 8_200_000, t0 + 120_000), { okxPxCents: 8_199_000, confirmed: false, gapBps: -1.2 }, "OKX's high stayed 10 dollars short of the cap");
  assert.deepEqual(okxConfirms(okx, "long", 8_100_000, t0 + 60_000), { okxPxCents: 8_199_000, confirmed: true, gapBps: 122.2 }, "the ±3 minute window includes the next candle's high");
  assert.deepEqual(okxConfirms(okx, "long", 8_100_000, t0 + 3_600_000), { okxPxCents: null, confirmed: null, gapBps: null }, "no candle in the window: unknown, never guessed");
  const c: Candle = okx[0];
  assert.equal(c.o, 80_100);
});

const openRec = (side: "long" | "short", id: string, at: string): PerpShadowOpenRecord => {
  const r = perpShadowQuote({ ...quoteInputs(side, id), nowIso: at }, snap());
  assert.equal(r.type, "open");
  return r as PerpShadowOpenRecord;
};

/** A path where the LONG's cap and every closer rung got touched 11h in (high 83,050); the OKX index stopped at 82,995, short of the live cap. */
const touchedPath = (a: PerpShadowOpenRecord): PerpPath => {
  const touchIso = new Date(Date.parse(a.at) + 11 * 3_600_000).toISOString();
  const caps = [a.capStrikeCents, ...a.counterfactuals!.capLadder.map((r) => r.capStrikeCents)].filter((c) => c <= 8_305_000);
  return {
    source: "hl_candles",
    interval: "1m",
    candles: 1980,
    hiCents: 8_305_000,
    loCents: 6_950_000,
    touches: [...new Set(caps)].map((cap) => ({ capStrikeCents: cap, atIso: touchIso, hlPxCents: 8_305_000, okxPxCents: 8_299_500, okxConfirmed: cap <= 8_299_500, okxGapBps: +(((8_299_500 - cap) / cap) * 10000).toFixed(1) })),
  };
};

const shortTouchedPath = (b: PerpShadowOpenRecord): PerpPath => {
  const touchIso = new Date(Date.parse(b.at) + 30 * 3_600_000).toISOString();
  const caps = [...new Set([b.capStrikeCents, ...b.counterfactuals!.capLadder.map((r) => r.capStrikeCents)])];
  return {
    source: "hl_candles",
    interval: "1m",
    candles: 1980,
    hiCents: 8_205_000,
    loCents: 6_950_000,
    touches: caps.map((cap) => ({ capStrikeCents: cap, atIso: touchIso, hlPxCents: 6_950_000, okxPxCents: 6_960_000, okxConfirmed: true, okxGapBps: +(((cap - 6_960_000) / cap) * 10000).toFixed(1) })),
  };
};

test("perp shadow: the ledger replays opens, settles (on the path) and voids; the summary and CSVs fold them", () => {
  const dir = mkdtempSync(join(tmpdir(), "perp-shadow-"));
  const path = join(dir, "ledger.jsonl");
  // the fixture snapshot carries no vols; stamp the market's odds at open so the calibration line has an input
  const a: PerpShadowOpenRecord = { ...openRec("long", "a", "2026-09-18T23:00:00.000Z"), capExceedProb: 0.2 };
  const b: PerpShadowOpenRecord = { ...openRec("short", "b", "2026-09-18T23:00:00.000Z"), capExceedProb: 0.1 };
  const c = openRec("long", "c", "2026-09-19T00:00:00.000Z");
  assert.equal(a.capStrikeCents, 8_300_000, "the fixture's widest paying call inside 4% (3.75%), clear of the 2% guard");
  assert.equal(b.capStrikeCents, 7_700_000);
  const records: PerpShadowRecord[] = [
    a,
    b,
    { type: "refusal", at: "2026-09-18T22:00:00.000Z", side: "long", contracts: 3, spotCents: 8_000_000, error: "listed_book_empty", message: "no ask" },
    c,
    // the print is 70,000: the long's floor would have saved it — but its cap was touched 11h in, so it was knocked out before the crash
    { type: "settle", at: "2026-09-20T08:20:00.000Z", id: "a", settleCents: 7_000_000, source: "okx_delivery", path: touchedPath(a) },
    // the short's caps sit below; the crash reached them 30h in, and the OKX index agreed
    { type: "settle", at: "2026-09-20T08:20:00.000Z", id: "b", settleCents: 7_000_000, source: "okx_delivery", path: shortTouchedPath(b) },
    { type: "void", at: "2026-09-23T08:00:00.000Z", id: "c", reason: "no delivery price published" },
    { type: "settle", at: "2026-09-23T09:00:00.000Z", id: "c", settleCents: 8_000_000, source: "okx_delivery" }, // ignored: already void
    { ...a, id: "a" }, // duplicate open ignored
  ];
  for (const r of records) appendPerpShadowRecord(path, r);
  assert.equal(readFileSync(path, "utf8").trim().split("\n").length, records.length, "append-only, one line per record");

  // The product (plain, the default): the same ledger read the way the writer actually carries it.
  {
    const { positions: plain, refusals: pr } = loadPerpShadow(path);
    assert.equal(plain.length, 3);
    const a1 = plain.find((p) => p.id === "a")!.outcome!;
    const b1 = plain.find((p) => p.id === "b")!.outcome!;
    assert.ok(!a1.knockedOut && a1.floorSave, "plain: the touch closed nothing, so the floor was still there for the crash");
    assert.equal(a1.touchedAtIso, "2026-09-19T10:00:00.000Z", "…but the touch is on the record: a release was on offer");
    assert.equal(a1.paidCents, a.creditCents, "the full credit");
    assert.ok(a1.buybackCents > 0, "and what releasing then would have cost");
    assert.equal(a1.capExcessCents, 0, "the print came back inside the cap: nothing handed back");
    assert.equal(a1.writerCents, a.takeCents, "the writer is flat: hedged leg for leg");
    assert.ok(b1.capHit && !b1.knockedOut, "plain: the short printed past its cap");
    assert.equal(b1.capExcessCents, Math.round(0.03 * (b.capStrikeCents - 7_000_000)), "gains below the cap on 0.03 BTC handed back");
    assert.equal(b1.protectedCents, Math.round(0.03 * (8_000_000 - b.capStrikeCents)) + b.creditCents);
    assert.equal(b1.writerCents, b.takeCents);
    const sp = summarizePerpShadow(plain, pr);
    assert.equal(sp.capMode, "plain");
    assert.equal(sp.knockouts, 0);
    assert.equal(sp.floorSaves, 1);
    assert.equal(sp.capHits, 1);
    assert.equal(sp.writerCents, a.takeCents + b.takeCents);
    assert.equal(sp.paidCents, a.creditCents + b.creditCents);
    assert.ok(b1.capExcessCents > b.creditCents, "the short's crash handed back more than its credit");
    assert.deepEqual(
      { ...sp.capDetail, releaseAtTouchCents: undefined },
      {
        touched: 2,
        endedPastCap: 1,
        capExcessCents: b1.capExcessCents,
        releaseAtTouchCents: undefined,
        avgHoursToTouch: 20.5,
        okxConfirmed: 1,
        hlOnly: 1,
        creditOnPastCapCents: b.creditCents,
        // the credit nets the first slice at close; what remains is the balance a one-way rail would carry
        exceededCredit: 1,
        exceededCreditCents: b1.capExcessCents - b.creditCents,
        largestExceededCreditCents: b1.capExcessCents - b.creditCents,
        // said 15% on average (0.2, 0.1), seen 1 of 2 settled past the cap
        predictedExceedPct: 15,
        realizedExceedPct: 50,
      },
    );
    assert.equal(sp.capDetail.releaseAtTouchCents, a1.buybackCents + b1.buybackCents);
    assert.equal(sp.counterfactuals.baseline.knockouts, 0);
    assert.equal(sp.counterfactuals.capLadder[0].knockouts, 0, "no rung knocks out in plain mode…");
    const r15p = sp.counterfactuals.capLadder[0];
    assert.equal(r15p.okxConfirmedTouches + r15p.hlOnlyTouches, 2, "…the touches are still counted, per rung");
    assert.ok(r15p.capExcessCents > 0, "and the closest rung handed the most upside back on the short's crash");
    const pubPlain = perpPositionsCsv(plain, "public").trimEnd().split("\n");
    assert.ok(pubPlain[0].endsWith(",cap_excess_c,writer_c"));
    assert.ok(pubPlain.find((l) => l.startsWith("a,long,"))!.includes(",0,2026-09-19T10:00:00.000Z,1,"), "not knocked out, touched, fully vested");
  }

  // Knock-out mode (EP_CAP_MODE=knockout): the cycle ends at the touch.
  const KO = { capMode: "knockout" as const };
  const { positions, refusals } = loadPerpShadow(path, KO);
  assert.equal(positions.length, 3);
  assert.equal(refusals.length, 1);
  const pa = positions.find((p) => p.id === "a")!;
  const pb = positions.find((p) => p.id === "b")!;
  const pc = positions.find((p) => p.id === "c")!;
  assert.equal(pa.status, "settled");
  const oa = pa.outcome!;
  assert.ok(oa.knockedOut && !oa.floorSave, "the long was knocked out at the touch; the later crash found it unprotected (re-arming is the next cycle)");
  assert.equal(oa.touchedAtIso, "2026-09-19T10:00:00.000Z");
  assert.equal(oa.vestedFraction, 0.3333);
  assert.equal(oa.paidCents, Math.round(a.creditCents / 3));
  assert.ok(oa.buybackCents > 0, "the buyback is priced from the nearest scan's ATM ask (c, one hour later, or a itself)");
  const nearest = nearestAtm(positions, "long", a.expiryIso, Date.parse(oa.touchedAtIso!))!;
  assert.equal(oa.buybackCents, buybackEstimateCents(0.03, a.capStrikeCents, 22, nearest));
  assert.equal(oa.writerCents, a.takeCents + (a.creditCents - oa.paidCents) - oa.buybackCents);
  assert.equal(pb.status, "settled");
  const ob = pb.outcome!;
  assert.ok(ob.knockedOut, "the short was knocked out when the crash reached its cap");
  assert.equal(ob.vestedFraction, 0.9091);
  assert.ok(ob.nakedCents === 30_000 && ob.protectedCents === 30_000 + ob.paidCents, "a short keeps every gain of the crash plus what vested");
  assert.equal(pc.status, "void");
  assert.equal(pc.voidReason, "no delivery price published");
  assert.equal(pc.outcome, undefined);

  const s = summarizePerpShadow(positions, refusals, KO);
  assert.equal(s.positions, 3);
  assert.equal(s.settled, 2);
  assert.equal(s.void, 1);
  assert.equal(s.open, 0);
  assert.equal(s.refusals, 1);
  assert.deepEqual(s.refusalReasons, { listed_book_empty: 1 });
  assert.equal(s.floorSaves, 0);
  assert.equal(s.capHits, 2);
  assert.equal(s.knockouts, 2);
  assert.equal(s.paidCents, oa.paidCents + ob.paidCents, "what holders were actually paid: vested at the touch");
  assert.equal(s.holderDeltaCents, oa.deltaCents + ob.deltaCents);
  assert.equal(s.writerCents, oa.writerCents + ob.writerCents, "the writer's side: take + unvested kept − buybacks");
  assert.equal(s.avgCapPct, +((a.capPct + b.capPct + c.capPct) / 3).toFixed(4));
  const ko = s.knockoutDetail;
  assert.equal(ko.knockouts, 2);
  assert.equal(ko.okxConfirmed, 1, "the short's touch was confirmed by the OKX index");
  assert.equal(ko.hlOnly, 1, "the long's touch was Hyperliquid-only: OKX stayed short of the cap");
  assert.equal(ko.touchHours, 2);
  assert.equal(ko.maxInOneHour, 1);
  assert.equal(ko.avgHoursToTouch, 20.5, "(11h + 30h) / 2");
  assert.equal(ko.buybackCents, oa.buybackCents + ob.buybackCents);
  assert.equal(ko.unvestedKeptCents, a.creditCents - oa.paidCents + (b.creditCents - ob.paidCents));
  assert.equal(ko.pricedBlind, 0);
  assert.ok(ko.avgOkxGapBps != null);
  assert.equal(s.bySide.long.knockouts, 1);
  assert.equal(s.bySide.short.knockouts, 1);
  // same-strike coincidence: c (an hour after a, same expiry) landed on a's funding strike while a was still live
  assert.deepEqual(s.sameStrike, { opens: 3, sharedSellStrike: 1, maxOpenOnOneStrike: 2 });
  assert.equal(s.creditCents, a.creditCents + b.creditCents + c.creditCents);
  assert.equal(s.notionalCents, 3 * 240_000);
  assert.equal(s.firstAt, "2026-09-18T22:00:00.000Z", "the refusal is part of the record's period");
  assert.equal(s.bySide.long.positions, 2);
  assert.equal(s.bySide.short.settled, 1);
  assert.equal(s.avgFundingBpsPer8h, 0.125);
  assert.equal(s.avgBasisBps, 3.8);
  assert.ok(s.spreadCostBps != null && s.spreadCostBps > 0);

  const cf = s.counterfactuals;
  assert.equal(cf.positionsWithCounterfactuals, 3);
  assert.equal(cf.baseline.quoted, 3);
  assert.equal(cf.baseline.settled, 2);
  assert.equal(cf.baseline.creditCents, s.creditCents);
  assert.equal(cf.baseline.knockouts, 2);
  assert.equal(cf.baseline.knockoutRatePct, 100);
  // the cap ladder, bucketed by distance: 1.5% (the 81000 / 79000 rungs), 2.5%, 4.0%
  assert.deepEqual(cf.capLadder.map((r) => r.bucket), ["1.5%", "2.5%", "4.0%"]);
  const r15 = cf.capLadder[0];
  assert.equal(r15.quoted + r15.refused, 3);
  assert.equal(r15.underGuard, 3, "the 1.25% rung sits under the 2% guard on every quote");
  assert.equal(r15.livePicks, 0);
  const r25 = cf.capLadder[1];
  assert.equal(r25.livePicks, 0);
  assert.equal(r25.underGuard, 0);
  const r40 = cf.capLadder[2];
  assert.equal(r40.livePicks, 3, "3.75% was the live pick every time in this fixture: the widest that paid");
  assert.equal(r40.creditCents, cf.baseline.creditCents, "the live rung's book equals the baseline");
  assert.equal(r40.knockouts, 2);
  assert.equal(r40.okxConfirmedTouches, 1, "the short's touch: OKX agreed");
  assert.equal(r40.hlOnlyTouches, 1, "the long's touch: OKX stopped at 82,995");
  assert.ok(r15.creditBpsOfNotional! > r25.creditBpsOfNotional! && r25.creditBpsOfNotional! > r40.creditBpsOfNotional!, "the closer the cap, the more cash…");
  assert.equal(r15.knockouts, 2, "…and every closer rung was touched on both paths too");
  assert.equal(r25.knockouts, 2);
  assert.equal(r15.okxConfirmedTouches, 2, "OKX reached the closer rungs on both paths");
  assert.ok(r15.avgHoursToTouch != null && r15.avgHoursToTouch > 0);
  assert.ok(r15.buybackCents > 0 && r40.buybackCents > 0, "every touched rung carries a buyback estimate (ATM ask at the time left; the strike moves it only marginally)");
  assert.equal(r15.predictedExceedPct, null, "no vols in this fixture: no predicted odds");
  assert.equal(r40.realizedExceedPct, 100, "both settled paths ended past the 3.75% cap");
  // the floor ladder, one row per depth, the live 6% flagged, settled on the same paths
  assert.deepEqual(cf.floorLadder.map((r) => r.floorPct), [0.05, 0.06, 0.07, 0.08]);
  const f6 = cf.floorLadder[1];
  assert.equal(f6.livePicks, 3);
  assert.equal(f6.creditCents, cf.baseline.creditCents, "the live depth's book equals the baseline");
  assert.equal(f6.settled, 2);
  assert.ok(f6.avgCapPct != null && Math.abs(f6.avgCapPct - 0.0375) < 1e-6);
  const f8 = cf.floorLadder[3];
  assert.equal(f8.livePicks, 0);
  assert.equal(f8.quoted, 3);
  assert.ok(f8.creditBpsOfNotional! >= f6.creditBpsOfNotional!, "the deeper floor is never dearer per dollar protected");
  assert.ok(cf.floorLadder[0].creditBpsOfNotional! < f6.creditBpsOfNotional!, "the 5% floor pays less");
  assert.equal(f8.settled, 2, "and is settled on the same two paths");
  // the floor rule summary: every quote judged, picks tallied by depth, agreement with the live 6% counted
  assert.equal(cf.floorRule.judged, 3);
  assert.match(cf.floorRule.rule ?? "", /tightest floor/);
  assert.equal(Object.values(cf.floorRule.picks).reduce((s, n) => s + n, 0), 3, "every judged quote lands in exactly one bucket");
  assert.ok(cf.floorRule.agreesWithLive >= 0 && cf.floorRule.agreesWithLive <= 3);
  // the funding rule: at 0.125 bps/8h over 33h the cycle costs 12¢ on a long (a short receives it)
  assert.deepEqual(cf.fundingRule, { judged: 3, wouldRefuse: 0, creditCents: s.creditCents, fundingCents: a.fundingCycleCents! + c.fundingCycleCents! });
  assert.equal(cf.feeRules.share_only.quoted + cf.feeRules.share_only.refused, 3);
  assert.equal(cf.feeRules.share_only.creditCents + cf.feeRules.share_only.takeCents, cf.baseline.netCreditCents, "the fee rule only moves money between credit and take");
  assert.deepEqual(cf.capacity.map((r) => r.mult), [1, 10, 50]);
  assert.equal(cf.capacity[0].creditCents, cf.baseline.creditCents, "1× walked equals the live book here");
  assert.ok(cf.capacity[1].avgSpreadCostBps! >= cf.capacity[0].avgSpreadCostBps!, "size costs spread");
  assert.equal(cf.tenors.weekly.quoted, 3);
  assert.equal(cf.tenors.weekly.settled, 0, "tenor alternatives are never settled against the daily print");
  assert.equal(cf.tenors.weekly.avgDays, 6.4);

  const pub = perpPositionsCsv(positions, "public", KO).trimEnd().split("\n");
  assert.equal(pub[0], PERP_CSV_PUBLIC_COLUMNS.join(","));
  assert.equal(pub.length, 4);
  assert.ok(pub[0].includes(",knocked_out,touched_at_utc,vested_frac,paid_c,") && pub[0].endsWith(",writer_c"));
  assert.ok(!pub[0].includes("cap_ladder") && !pub[0].includes("alt_tenor_credit_c") && !pub[0].includes("buyback_c"));
  const rowA = pub.find((l) => l.startsWith("a,long,"))!;
  assert.ok(rowA.includes(",1,2026-09-19T10:00:00.000Z,0.3333,"), "knocked out at the touch, a third vested");
  const full = perpPositionsCsv(positions, "full", KO).trimEnd().split("\n");
  assert.equal(full[0], PERP_CSV_COLUMNS.join(","));
  assert.equal(full[0].split(",").length, PERP_CSV_COLUMNS.length);
  for (const line of full.slice(1)) assert.equal(line.split(",").length >= PERP_CSV_COLUMNS.length, true, "every row has every column (JSON cells are quoted)");
  assert.ok(full[0].includes("alt_tenor_credit_c") && full[0].includes("cap_ladder") && full[0].includes("buyback_c") && full[0].includes("fee_rules"));
  assert.ok(full.find((l) => l.startsWith("a,long,"))!.includes('""ko"":true'), "the ladder cell carries each rung's knock-out");

  // replay is pure: the same records in memory give the same positions
  assert.deepEqual(replayPerpShadow(records, KO).positions.map((p) => [p.id, p.status]), [["a", "settled"], ["b", "settled"], ["c", "void"]]);
});

test("perp shadow: longer tenors (two-weekly, monthly) are quoted from the same snapshot, summarized per day, and read on the operator report; never settled", () => {
  // Fri 2026-10-02 (13.4d out) is the two-weekly; Fri 2026-10-30 (41.4d, October's last Friday) the monthly.
  const TWO_WEEKLY = Date.UTC(2026, 9, 2, 8);
  const MONTHLY = Date.UTC(2026, 9, 30, 8);
  const wideStrikes = [68000, 70000, 72000, 74000, 75000, 76000, 77000, 78000, 79000, 81000, 82000, 83000, 84000, 86000, 88000, 90000, 92000];
  const longChain = [...chain];
  for (const e of [TWO_WEEKLY, MONTHLY]) for (const k of wideStrikes) longChain.push(inst(e, "put", k), inst(e, "call", k));
  // Longer options are worth more and decay slower with distance, so the far calls still carry a bid; puts
  // are cheaper than calls here (an upside skew) so the widest paying cap sits well past the 6% floor.
  const longBook = (c: OkxChainInstrument): BookDepth => {
    if (c.expiryMs !== TWO_WEEKLY && c.expiryMs !== MONTHLY) return bookFor(c);
    const dist = Math.abs(c.strike - SPOT) / SPOT;
    const scale = c.expiryMs === MONTHLY ? 0.08 : 0.05;
    const decay = c.optType === "put" ? 30 : c.expiryMs === MONTHLY ? 14 : 22;
    const mid = Math.max(0.0003, scale * Math.exp(-dist * decay));
    return depth(+(mid * 0.97).toFixed(6), +(mid * 1.03).toFixed(6));
  };
  const books: Record<string, BookDepth> = {};
  for (const c of longChain) books[c.instId] = longBook(c);
  const longSnap: OkxListedSnapshot = { ...snap(), chain: longChain, books, altExpiries: { two_weekly: TWO_WEEKLY, monthly: MONTHLY } };
  const WEEKLY_GUARD = { minCapPct: 0, maxCapPct: 0.08 };

  const rec = perpShadowQuote({ ...quoteInputs("long", "t-long"), tenor: "weekly", capGuard: WEEKLY_GUARD, otherTenorCapGuard: GUARD }, longSnap);
  assert.equal(rec.type, "open");
  if (rec.type !== "open") return;
  assert.equal(rec.tenor, "weekly");
  assert.equal(rec.expiryIso, new Date(WEEKLY).toISOString(), "the live book is still the weekly");
  const t = rec.counterfactuals!.tenors;
  assert.deepEqual(Object.keys(t), ["daily", "two_weekly", "monthly"], "the other tenor first, then the longer cycles");
  const tw = t.two_weekly;
  const mo = t.monthly;
  assert.ok(tw.ok && tw.expiryIso === new Date(TWO_WEEKLY).toISOString(), tw.ok ? "" : `${tw.error}: ${tw.message}`);
  assert.ok(mo.ok && mo.expiryIso === new Date(MONTHLY).toISOString(), mo.ok ? "" : `${mo.error}: ${mo.message}`);
  if (!tw.ok || !mo.ok) return;
  assert.ok(tw.buyInstId.includes("261002") && tw.sellInstId.includes("261002"), "both two-weekly legs at its Friday");
  assert.ok(mo.buyInstId.includes("261030") && mo.sellInstId.includes("261030"), "both monthly legs at its Friday");
  assert.ok(Math.abs(tw.floorPct - 0.06) < 0.011 && Math.abs(mo.floorPct - 0.06) < 0.011, "the floor stays at the live depth");
  assert.ok(mo.capPct > 0.08 + 1e-9, `the monthly's cap search reaches past the weekly's 8% band (got ${mo.capPct})`);
  assert.ok(mo.capPct <= 0.15 + 1e-9, "and no further than its own band");
  assert.ok(tw.capPct <= 0.1 + 1e-9);
  assert.equal(tw.capPct, 0.075, "two-weekly: the widest paying call in a 10% band is 86,000");
  assert.equal(mo.capPct, 0.125, "monthly: the widest paying call in a 15% band is 90,000");
  assert.ok(tw.creditCents > 0 && mo.creditCents > 0, "the widest paying strike pays, by construction, little: the rule buys distance, not cash");
  assert.equal(rec.counterfactuals!.capLadder.every((r) => r.sellInstId.includes("260925")), true, "the cap ladder stays at the live expiry");
  // A snapshot without the longer expiries: no rows, nothing invented.
  const bare = perpShadowQuote({ ...quoteInputs("long", "t-bare"), tenor: "weekly", capGuard: WEEKLY_GUARD, otherTenorCapGuard: GUARD }, snap());
  assert.ok(bare.type === "open" && Object.keys(bare.counterfactuals!.tenors).join() === "daily");

  // Summary: per-day footing, where the cap landed, and never settled.
  const dir = mkdtempSync(join(tmpdir(), "perp-shadow-long-"));
  const path = join(dir, "ledger.jsonl");
  appendPerpShadowRecord(path, rec);
  appendPerpShadowRecord(path, { ...rec, id: "t-long-2", at: "2026-09-19T23:00:00.000Z" } as PerpShadowOpenRecord);
  const { positions, refusals } = loadPerpShadow(path);
  const s = summarizePerpShadow(positions, refusals);
  const cf = s.counterfactuals;
  assert.equal(cf.baselineDays.avgDays, 5.9, "the live weekly from 18th/19th 23:00 to Fri 25th 08:00: (6.4 + 5.4) / 2");
  assert.equal(cf.baselineDays.creditBpsPerDay, +((cf.baseline.creditBpsOfNotional ?? 0) / 5.9).toFixed(2));
  const twRow = cf.tenors.two_weekly;
  const moRow = cf.tenors.monthly;
  assert.equal(twRow.quoted, 2);
  assert.equal(twRow.settled, 0, "a longer cycle settles on a different print: never settled here");
  assert.equal(twRow.avgDays, 12.9, "(13.4 + 12.4) / 2");
  assert.equal(moRow.avgDays, 40.9);
  assert.equal(twRow.creditBpsPerDay, +((twRow.creditBpsOfNotional ?? 0) / 12.9).toFixed(2));
  assert.equal(moRow.creditBpsPerDay, +((moRow.creditBpsOfNotional ?? 0) / 40.9).toFixed(2));
  assert.ok(moRow.avgCapPct != null && Math.abs(moRow.avgCapPct - mo.capPct) < 1e-6);
  assert.equal(moRow.predictedExceedPct, null, "no vols on this snapshot: no odds invented");
  assert.equal(cf.tenors.daily.quoted, 2, "the other tenor's row is unchanged");

  // The CSV's alt-tenor columns still carry the OTHER tenor (the daily), not a longer one.
  const full = perpPositionsCsv(positions, "full").trimEnd().split("\n");
  assert.ok(full[1].includes(`,daily,${new Date(DAILY).toISOString()},`), "alt_tenor, alt_tenor_expiry_utc: the daily");
  assert.ok(!full[1].includes(",two_weekly,") && !full[1].includes(",monthly,"), "the longer tenors ride the JSON report, not the CSV");

  // Operator report: a row per tenor in cycle order with days and bps/day, and the longer-cycles sentence.
  const html = renderPerpShadowReportHtml({ atIso: "2026-09-20T00:00:00.000Z", summary: s, token: "op-secret", capGuard: WEEKLY_GUARD, tenor: "weekly" });
  const tenorCard = html.slice(html.indexOf("<h2>Tenor</h2>"), html.indexOf("<h2>", html.indexOf("<h2>Tenor</h2>") + 1));
  const order = ["<td>daily", "live book", "<td>two-weekly", "<td>monthly"].map((k) => tenorCard.indexOf(k));
  assert.ok(order.every((i) => i >= 0), `every tenor row is on the card: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "rows in cycle order: daily, live weekly, two-weekly, monthly");
  assert.ok(tenorCard.includes("12.9d") && tenorCard.includes("40.9d") && tenorCard.includes("bps/day"), "days and per-day cash on each row");
  assert.ok(tenorCard.includes(`cap ${(mo.capPct * 100).toFixed(1)}%`), "where the monthly's cap landed");
  assert.ok(tenorCard.includes("Longer cycles from the same snapshot") && tenorCard.includes("the monthly (40.9 days) pays"), "the longer-cycles sentence");
  assert.ok(/pays (more|the most) per day protected/.test(tenorCard), "a per-day verdict against the live book");
  assert.ok(tenorCard.includes("Quoted terms only"), "and says it is not settled");
  assert.ok(!tenorCard.includes("two_weekly") && !tenorCard.includes("holder"), "plain words, no labels or holder/writer on the card");
  assert.ok(!html.includes("NaN") && !html.includes("undefined"));
});

test("perp shadow: market parsers read venue payloads and refuse to invent a print", () => {
  const hl = parseHlContext(
    [{ universe: [{ name: "ETH" }, { name: "BTC" }] }, [{ markPx: "4000" }, { markPx: "81161.5", oraclePx: "81130.3", funding: "0.0000125" }]],
    "BTC",
  );
  assert.deepEqual(hl, { markPx: 81161.5, oraclePx: 81130.3, fundingBpsPer8h: 0.125 });
  assert.equal(parseHlContext([{ universe: [{ name: "ETH" }] }, [{ markPx: "4000" }]], "BTC"), null);
  assert.equal(parseOkxIndex({ data: [{ idxPx: "81130.3" }] }), 81130.3);
  assert.equal(parseOkxIndex({ data: [] }), null);
  assert.equal(dateCodeForExpiry(DAILY), "260920");
  const hist = {
    data: [
      { ts: "1", details: [{ insId: "BTC-USD-260919-80000-C", px: "80500.1", type: "exercised" }] },
      { ts: "2", details: [{ insId: "BTC-USD-260920-76000-P", px: "79800.4", type: "expired" }, { insId: "BTC-USD-260920-84000-C", px: "79800.4", type: "expired" }] },
    ],
  };
  assert.equal(deliveryPriceFor(hist, DAILY), 79800.4, "the print for the expiry's date code");
  assert.equal(deliveryPriceFor(hist, WEEKLY), null, "no print yet: null, and the position stays open");
  // OKX renamed the delivered instruments with a margin-mode suffix (BTC-USD_UM-...) in 2026-10; the
  // print must still be found or every weekly position sits open until the void window swallows it.
  const histUm = {
    data: [
      { ts: "3", details: [{ insId: "BTC-USD_UM-260920-68000-C", px: "82485.9362690241718889", type: "exercised" }, { insId: "BTC-USD_UM-260920-68000-P", px: "82485.9362690241718889", type: "expired_otm" }] },
    ],
  };
  assert.equal(deliveryPriceFor(histUm, DAILY), 82485.9362690241718889, "the suffixed spelling is the same expiry");
  assert.equal(deliveryPriceFor({ data: [{ ts: "4", details: [{ insId: "ETH-USD_UM-260920-4000-C", px: "4000", type: "exercised" }] }] }, DAILY), null, "another underlying is never our print");
});

test("perp shadow worker: public record vs operator views over HTTP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perp-shadow-worker-"));
  const path = join(dir, "ledger.jsonl");
  process.env.NODE_ENV = "test";
  process.env.PERP_SHADOW_LEDGER_PATH = path;
  process.env.EP_ADMIN_TOKEN = "op-secret";
  const { server } = await import("../scripts/perpShadowWorker");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const op = { headers: { "x-admin-token": "op-secret" } };
  try {
    for (const p of ["/report", "/api/shadow/report", "/api/shadow/export", "/api/shadow/reset"]) {
      assert.equal((await fetch(`${base}${p}`)).status, 403, `${p} without a token`);
      assert.equal((await fetch(`${base}${p}?token=wrong`)).status, 403);
    }
    assert.equal((await fetch(`${base}/api/shadow/reset?token=op-secret`)).status, 405, "GET without confirm=reset does nothing");
    let health = (await (await fetch(`${base}/healthz`)).json()) as Record<string, unknown>;
    assert.equal(health.ok, true);
    assert.equal(health.positions, 0);
    assert.deepEqual(health.ledger, { path, exists: false, bytes: 0, records: 0 });
    const terms = health.terms as { geometry: { floorPct: number; capPct: number }; tenor: string; capMode: string; capGuard: { minCapPct: number; maxCapPct: number } };
    assert.deepEqual(terms.geometry, { floorPct: 0.06, capPct: 0.015 });
    assert.equal(terms.tenor, "weekly", "the weekly is the default tenor");
    assert.equal(terms.capMode, "plain", "the plain collar is the product; knockout is the opt-in rule");
    assert.deepEqual(terms.capGuard, { minCapPct: 0.045, maxCapPct: 0.08 }, "plain weekly: the cap at least 4.5% out, searched to 8%");
    const ruleReport = (await (await fetch(`${base}/api/shadow/report?token=op-secret`)).json()) as { rules: { capRule: string; capGuard: { minCapPct: number } } };
    assert.ok(ruleReport.rules.capRule.endsWith("never closer than 4.5% from price (refused when nothing at or beyond that pays)"), "the published rule names the minimum");
    assert.equal(ruleReport.rules.capGuard.minCapPct, 0.045);
    const emptyPage = await fetch(`${base}/`);
    assert.equal(emptyPage.status, 200);
    const emptyHtml = await emptyPage.text();
    assert.ok(emptyHtml.includes("not started"));
    assert.ok(emptyHtml.includes("a hard floor 6% out, the cap at least 4.5% out, the most credit the book pays from there, cash credit either way"), "the headline states where the cap sits");
    assert.ok(!emptyHtml.includes("(since "), "no position yet, so no date on the rule");

    const a = openRec("long", "a", "2026-09-18T23:00:00.000Z");
    appendPerpShadowRecord(path, a);
    appendPerpShadowRecord(path, { type: "settle", at: "2026-09-20T08:20:00.000Z", id: "a", settleCents: 7_000_000, source: "okx_delivery" });
    const b = openRec("short", "b", "2026-09-19T00:00:00.000Z");
    // the venue reference as the worker records it: Deribit $30/BTC better than OKX, Bullish missing the cap bid
    b.venueReference = {
      okx: { buyAskCents: 100_000, sellBidCents: 80_000, netCents: -20_000 },
      venues: {
        deribit: { ok: true, buy: { instrument: "BTC-25SEP26-75000-P", bidCents: 95_000, askCents: 98_000 }, sell: { instrument: "BTC-25SEP26-86000-C", bidCents: 81_000, askCents: 84_000 }, netCents: -17_000, vsOkxCents: 3_000, vsOkxBps: 3.75 },
        bullish: { ok: true, buy: { instrument: "BTC-USDC-20260925-75000-P", bidCents: 90_000, askCents: 105_000 }, sell: { instrument: "BTC-USDC-20260925-86000-C", bidCents: null, askCents: 90_000 }, netCents: null, vsOkxCents: null, vsOkxBps: null },
      },
    };
    appendPerpShadowRecord(path, b);

    health = (await (await fetch(`${base}/healthz`)).json()) as Record<string, unknown>;
    assert.equal(health.positions, 2);
    assert.equal(health.open, 1);

    const api = (await (await fetch(`${base}/api/shadow`)).json()) as {
      summary: { settled: number; floorSaves: number; writerCents: number; counterfactuals: Record<string, unknown> };
      settled: Array<Record<string, unknown>>;
      open: Array<Record<string, unknown>>;
    };
    assert.equal(api.summary.settled, 1);
    assert.equal(api.summary.floorSaves, 1);
    assert.equal(api.summary.writerCents, a.takeCents);
    assert.deepEqual(Object.keys(api.summary.counterfactuals).sort(), ["positionsWithCounterfactuals", "recordedSince"]);
    assert.equal(api.settled.length, 1);
    assert.equal(api.open.length, 1);
    assert.ok(!("counterfactuals" in api.settled[0]) && !("counterfactuals" in api.open[0]), "public positions carry no rule books");
    assert.ok(!("venueReference" in api.summary), "the venue reference is an operator measurement, not part of the public record");

    const csv = await fetch(`${base}/api/shadow/positions.csv`);
    assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
    const csvHead = (await csv.text()).split("\n")[0];
    assert.ok(csvHead.endsWith(",path_lo_c,cap_excess_c,writer_c") && csvHead.includes(",knocked_out,") && !csvHead.includes("alt_tenor_credit_c") && !csvHead.includes("buyback_c"));
    assert.ok(!(await (await fetch(`${base}/api/shadow/positions.csv?scope=full`)).text()).includes("alt_tenor_credit_c"), "scope=full without the token is public");
    const full = await fetch(`${base}/api/shadow/positions.csv?scope=full&token=op-secret`);
    assert.match(full.headers.get("content-disposition") ?? "", /perp-shadow-positions-full-/);
    assert.ok((await full.text()).split("\n")[0].includes("alt_tenor_credit_c"));

    const page = await (await fetch(`${base}/`)).text();
    assert.ok(page.includes("<h1>Track record</h1>") && page.includes("· track record") && !page.includes("shadow record"), "the public page is the track record");
    assert.ok(page.includes("We carry no outcome risk") && page.includes("our P&amp;L, settled") && page.includes("take booked at quote"), "the identity card leads");
    assert.ok(!page.includes("holder") && !page.includes("writer"), "user and our P&L, not holder and writer, on the public page");
    assert.ok(!page.includes("Run as a book"), "flow mode off: no book card");
    assert.ok(page.includes("rule comparison") && page.includes("report on request"));
    assert.ok(!page.includes('href="/report"') && !page.includes('href="/api/shadow/export"'));
    assert.ok(page.includes("floor save"), "the settled long was saved by its floor");
    assert.ok(page.includes("the cap at least 4.5% out, the most credit the book pays from there") && !page.includes("(since "), "both positions were quoted under a 2% guard, so the 4.5% rule has no start date yet");
    assert.ok(!page.includes("NaN") && !page.includes("undefined"));

    const report = (await (await fetch(`${base}/api/shadow/report`, op)).json()) as {
      ok: boolean;
      rules: { capLadder: string; capGuard: { minCapPct: number; maxCapPct: number }; fundingRule: string; feeRules: Record<string, { name: string }> };
      counterfactuals: { baseline: { quoted: number; settled: number }; capLadder: Array<{ capBucket: string }>; tenors: Record<string, { quoted: number }>; capacity: Array<{ mult: number }> };
    };
    assert.equal(report.ok, true);
    assert.equal(report.counterfactuals.baseline.quoted, 2);
    assert.equal(report.counterfactuals.baseline.settled, 1);
    assert.equal(report.counterfactuals.tenors.weekly.quoted, 2);
    assert.deepEqual(report.counterfactuals.capacity.map((c) => c.mult), [1, 10, 50]);
    assert.ok(report.counterfactuals.capLadder.length >= 2, "every listed cap distance in the band is a rung");
    assert.deepEqual(report.rules.capGuard, { minCapPct: 0.045, maxCapPct: 0.08 });
    assert.ok(report.rules.capLadder.includes("handed back") && !report.rules.capLadder.includes("knock-out rate") && report.rules.fundingRule.includes("clear"));
    assert.equal((report as unknown as { rules: { capMode: string; settlement: string } }).rules.capMode, "plain");
    assert.ok((report as unknown as { rules: { settlement: string } }).rules.settlement.includes("runs to expiry"));
    assert.ok(report.rules.feeRules.min_5bps.name === "share or 0.05% of notional");
    const vref = (report as unknown as { rules: { venueReference: string }; counterfactuals: { venueReference: Record<string, { read: number; priced: number; beatOkx: number; avgVsOkxBps: number | null }> } });
    assert.match(vref.rules.venueReference, /Deribit and Bullish/);
    assert.deepEqual(vref.counterfactuals.venueReference.deribit, { read: 1, priced: 1, beatOkx: 1, avgVsOkxBps: 3.75, avgVsOkxCents: 3_000, buyAskPct: 100, sellBidPct: 100, errors: 0 });
    assert.deepEqual(vref.counterfactuals.venueReference.bullish, { read: 1, priced: 0, beatOkx: 0, avgVsOkxBps: null, avgVsOkxCents: null, buyAskPct: 100, sellBidPct: 0, errors: 0 });
    const reportPage = await fetch(`${base}/report?token=op-secret`);
    assert.equal(reportPage.status, 200);
    const reportHtml = await reportPage.text();
    assert.ok(reportHtml.includes("What each rule would have done") && reportHtml.includes("Cap distance") && reportHtml.includes("The cap"));
    assert.ok(!reportHtml.includes("Knock-outs") && !reportHtml.includes("knocked out"), "plain mode: no knock-out card on the report");
    assert.ok(reportHtml.includes("touched on the path") && reportHtml.includes("release at the touch"));
    assert.ok(reportHtml.includes("Does the math make sense") && reportHtml.includes("Tenor") && reportHtml.includes("Capacity"));
    assert.ok(!reportHtml.includes("Safest") && !reportHtml.includes("Most upside") && !reportHtml.includes("tier"), "no tiers anywhere in the perp shadow");
    assert.ok(reportHtml.includes('href="/api/shadow/export?token=op-secret"'));
    assert.ok(reportHtml.includes("Venue reference") && reportHtml.includes("Deribit would have paid the holder 3.75 bps of spot more than OKX"), "the operator card reads the reference in one sentence");
    assert.ok(!reportHtml.includes("NaN") && !reportHtml.includes("undefined"));

    const exp = await fetch(`${base}/api/shadow/export`, op);
    assert.equal(exp.status, 200);
    assert.equal(await exp.text(), readFileSync(path, "utf8"), "byte for byte the ledger");

    // Reset: archive, never delete. The old file is renamed beside itself; the record starts empty.
    const before = readFileSync(path, "utf8");
    const reset = await fetch(`${base}/api/shadow/reset?token=op-secret`, { method: "POST" });
    assert.equal(reset.status, 200);
    const resetBody = (await reset.json()) as { ok: boolean; archived: Array<{ from: string; to: string }>; rules: { capMode: string; flow: string } };
    assert.equal(resetBody.ok, true);
    assert.equal(resetBody.archived.length, 1);
    assert.equal(resetBody.archived[0].from, path);
    assert.match(resetBody.archived[0].to, /ledger\.\d{4}-\d{2}-\d{2}T\d{6}Z\.archived\.jsonl$/);
    assert.equal(readFileSync(resetBody.archived[0].to, "utf8"), before, "the archive is the old ledger byte for byte");
    assert.equal(resetBody.rules.capMode, "plain");
    assert.match(resetBody.rules.flow, /metronome/);
    // the reset kicks a scan, which will fail here (no network in tests) and must not write a ledger
    await new Promise((r) => setTimeout(r, 50));
    const afterHealth = (await (await fetch(`${base}/healthz`)).json()) as { positions: number };
    assert.equal(afterHealth.positions, 0, "a fresh record after the reset");
  } finally {
    delete process.env.EP_ADMIN_TOKEN;
    await new Promise<void>((r) => server.close(() => r()));
  }
});
