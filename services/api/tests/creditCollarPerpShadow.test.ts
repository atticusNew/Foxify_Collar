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
  loadPerpShadow,
  perpOutcome,
  perpPositionsCsv,
  replayPerpShadow,
  summarizePerpShadow,
  type PerpShadowOpenRecord,
  type PerpShadowRecord,
} from "../src/singleSide/twoSided/creditCollar/perpShadow/perpShadowLedger";
import {
  dateCodeForExpiry,
  deliveryPriceFor,
  parseHlContext,
  parseOkxIndex,
} from "../src/singleSide/twoSided/creditCollar/perpShadow/perpShadowMarket";
import { feeRuleText, perpShadowQuote, perpTake } from "../src/singleSide/twoSided/creditCollar/perpShadow/perpShadowQuote";

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
  assert.equal(nextListedWeeklyExpiryMs(chain, Date.UTC(2026, 8, 18, 23)), WEEKLY, "the Friday 08:00 ≥ 5 days out");
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

const quoteInputs = (side: "long" | "short", id = `t-${side}`) => ({
  side,
  spot: SPOT,
  contracts: 3,
  liveTier: "balanced" as const,
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
  assert.equal(rec.tier, "balanced");
  assert.equal(rec.contracts, 3);
  assert.equal(rec.notionalCents, 240_000);
  assert.equal(rec.spotCents, 8_000_000);
  assert.equal(rec.okxIndexCents, 7_997_000);
  assert.equal(rec.basisBps, 3.8, "(80000 − 79970) / 79970 in bps");
  assert.equal(rec.fundingBpsPer8h, 0.125);
  assert.equal(rec.expiryIso, new Date(DAILY).toISOString());
  assert.equal(rec.creditCents, rec.netCreditCents - rec.takeCents, "the holder gets net minus take");
  assert.equal(rec.netCreditCents, rec.grossCreditCents - rec.venueFeeCents);
  assert.ok(rec.midCreditCents != null && rec.midCreditCents > rec.netCreditCents);
  const cf = rec.counterfactuals!;
  assert.deepEqual(Object.keys(cf.tiers), ["tight", "balanced", "wide"]);
  const bal = cf.tiers.balanced;
  assert.ok(bal.ok && bal.creditCents === rec.creditCents && bal.buyInstId === rec.buyInstId, "the live tier's counterfactual is the live quote itself");
  const tight = cf.tiers.tight;
  assert.ok(tight.ok && tight.floorStrikeCents > rec.floorStrikeCents, "tight: a floor closer to entry");
  const wide = cf.tiers.wide;
  assert.ok(wide.ok && wide.floorStrikeCents < rec.floorStrikeCents, "wide: a deeper floor");
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

  const noWeekly = perpShadowQuote(quoteInputs("long"), snap({ weeklyExpiryMs: null }));
  assert.ok(noWeekly.type === "open" && Object.keys(noWeekly.counterfactuals!.tenors).length === 0, "no weekly listed: no tenor counterfactual, nothing invented");

  const refusal = perpShadowQuote(quoteInputs("long"), snap({ books: {} }));
  assert.equal(refusal.type, "refusal");
  if (refusal.type === "refusal") {
    assert.equal(refusal.error, "listed_book_empty");
    assert.equal(refusal.spotCents, 8_000_000);
  }
});

test("perp shadow: settlement math for a long and a short at floor, cap and between", () => {
  const base = { contracts: 3, ctValBtc: 0.01, spotCents: 8_000_000, creditCents: 650, takeCents: 162 };
  const long = { ...base, side: "long" as const, floorStrikeCents: 7_500_000, capStrikeCents: 8_400_000 };
  // crash to 70,000: naked −$300, protected floors at 75,000 → −$150 + $6.50 credit
  let o = perpOutcome(long, 7_000_000);
  assert.deepEqual(o, { nakedCents: -30_000, protectedCents: -15_000 + 650, deltaCents: 15_650, floorSave: true, capHit: false, writerCents: 162 });
  // rally to 90,000: naked +$300, protected capped at 84,000 → +$120 + credit
  o = perpOutcome(long, 9_000_000);
  assert.deepEqual(o, { nakedCents: 30_000, protectedCents: 12_000 + 650, deltaCents: -17_350, floorSave: false, capHit: true, writerCents: 162 });
  // between: only the credit differs
  o = perpOutcome(long, 8_100_000);
  assert.deepEqual(o, { nakedCents: 3_000, protectedCents: 3_650, deltaCents: 650, floorSave: false, capHit: false, writerCents: 162 });

  const short = { ...base, side: "short" as const, floorStrikeCents: 8_500_000, capStrikeCents: 7_700_000 };
  o = perpOutcome(short, 9_000_000); // rally hurts a short: floor at 85,000 saves it
  assert.deepEqual(o, { nakedCents: -30_000, protectedCents: -15_000 + 650, deltaCents: 15_650, floorSave: true, capHit: false, writerCents: 162 });
  o = perpOutcome(short, 7_000_000); // crash pays a short; capped at 77,000
  assert.deepEqual(o, { nakedCents: 30_000, protectedCents: 9_000 + 650, deltaCents: -20_350, floorSave: false, capHit: true, writerCents: 162 });
});

const openRec = (side: "long" | "short", id: string, at: string): PerpShadowOpenRecord => {
  const r = perpShadowQuote({ ...quoteInputs(side, id), nowIso: at }, snap());
  assert.equal(r.type, "open");
  return r as PerpShadowOpenRecord;
};

test("perp shadow: the ledger replays opens, settles and voids; the summary and CSVs fold them", () => {
  const dir = mkdtempSync(join(tmpdir(), "perp-shadow-"));
  const path = join(dir, "ledger.jsonl");
  const a = openRec("long", "a", "2026-09-18T23:00:00.000Z");
  const b = openRec("short", "b", "2026-09-18T23:00:00.000Z");
  const c = openRec("long", "c", "2026-09-19T00:00:00.000Z");
  const records: PerpShadowRecord[] = [
    a,
    b,
    { type: "refusal", at: "2026-09-18T22:00:00.000Z", side: "long", contracts: 3, spotCents: 8_000_000, error: "listed_book_empty", message: "no ask" },
    c,
    { type: "settle", at: "2026-09-20T08:20:00.000Z", id: "a", settleCents: 7_000_000, source: "okx_delivery" },
    { type: "settle", at: "2026-09-20T08:20:00.000Z", id: "b", settleCents: 7_000_000, source: "okx_delivery" },
    { type: "void", at: "2026-09-23T08:00:00.000Z", id: "c", reason: "no delivery price published" },
    { type: "settle", at: "2026-09-23T09:00:00.000Z", id: "c", settleCents: 8_000_000, source: "okx_delivery" }, // ignored: already void
    { ...a, id: "a" }, // duplicate open ignored
  ];
  for (const r of records) appendPerpShadowRecord(path, r);
  assert.equal(readFileSync(path, "utf8").trim().split("\n").length, records.length, "append-only, one line per record");

  const { positions, refusals } = loadPerpShadow(path);
  assert.equal(positions.length, 3);
  assert.equal(refusals.length, 1);
  const pa = positions.find((p) => p.id === "a")!;
  const pb = positions.find((p) => p.id === "b")!;
  const pc = positions.find((p) => p.id === "c")!;
  assert.equal(pa.status, "settled");
  assert.ok(pa.outcome!.floorSave, "a long settling at 70,000 was saved by its floor");
  assert.equal(pb.status, "settled");
  assert.ok(pb.outcome!.capHit, "a short settling at 70,000 was capped");
  assert.equal(pc.status, "void");
  assert.equal(pc.voidReason, "no delivery price published");
  assert.equal(pc.outcome, undefined);

  const s = summarizePerpShadow(positions, refusals);
  assert.equal(s.positions, 3);
  assert.equal(s.settled, 2);
  assert.equal(s.void, 1);
  assert.equal(s.open, 0);
  assert.equal(s.refusals, 1);
  assert.deepEqual(s.refusalReasons, { listed_book_empty: 1 });
  assert.equal(s.floorSaves, 1);
  assert.equal(s.capHits, 1);
  assert.equal(s.holderDeltaCents, pa.outcome!.deltaCents + pb.outcome!.deltaCents);
  assert.equal(s.writerCents, pa.takeCents + pb.takeCents, "the writer's realized result is the take, leg for leg");
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
  assert.equal(cf.tiers.balanced.creditCents, cf.baseline.creditCents, "the live tier's book equals the baseline");
  assert.ok(cf.tiers.tight.quoted + cf.tiers.tight.refused === 3);
  assert.equal(cf.feeRules.share_only.quoted + cf.feeRules.share_only.refused, 3);
  assert.equal(cf.feeRules.share_only.creditCents + cf.feeRules.share_only.takeCents, cf.baseline.netCreditCents, "the fee rule only moves money between credit and take");
  assert.deepEqual(cf.capacity.map((r) => r.mult), [1, 10, 50]);
  assert.equal(cf.capacity[0].creditCents, cf.baseline.creditCents, "1× walked equals the live book here");
  assert.ok(cf.capacity[1].avgSpreadCostBps! >= cf.capacity[0].avgSpreadCostBps!, "size costs spread");
  assert.equal(cf.tenors.weekly.quoted, 3);
  assert.equal(cf.tenors.weekly.settled, 0, "tenor alternatives are never settled against the daily print");
  assert.equal(cf.tenors.weekly.avgDays, 6.4);

  const pub = perpPositionsCsv(positions, "public").trimEnd().split("\n");
  assert.equal(pub[0], PERP_CSV_PUBLIC_COLUMNS.join(","));
  assert.equal(pub.length, 4);
  assert.ok(pub[0].endsWith(",writer_c,tier"));
  assert.ok(!pub[0].includes("tight_floor_c") && !pub[0].includes("weekly_credit_c"));
  const full = perpPositionsCsv(positions, "full").trimEnd().split("\n");
  assert.equal(full[0], PERP_CSV_COLUMNS.join(","));
  assert.equal(full[0].split(",").length, PERP_CSV_COLUMNS.length);
  for (const line of full.slice(1)) assert.equal(line.split(",").length >= PERP_CSV_COLUMNS.length, true, "every row has every column (JSON cells are quoted)");
  assert.ok(full[0].includes("weekly_credit_c") && full[0].includes("min_5bps") === false && full[0].includes("fee_rules"));

  // replay is pure: the same records in memory give the same positions
  assert.deepEqual(replayPerpShadow(records).positions.map((p) => [p.id, p.status]), [["a", "settled"], ["b", "settled"], ["c", "void"]]);
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
    for (const p of ["/report", "/api/shadow/report", "/api/shadow/export"]) {
      assert.equal((await fetch(`${base}${p}`)).status, 403, `${p} without a token`);
      assert.equal((await fetch(`${base}${p}?token=wrong`)).status, 403);
    }
    let health = (await (await fetch(`${base}/healthz`)).json()) as Record<string, unknown>;
    assert.equal(health.ok, true);
    assert.equal(health.positions, 0);
    assert.deepEqual(health.ledger, { path, exists: false, bytes: 0, records: 0 });
    assert.equal((health.terms as { tier: string }).tier, "balanced");
    const emptyPage = await fetch(`${base}/`);
    assert.equal(emptyPage.status, 200);
    assert.ok((await emptyPage.text()).includes("not started"));

    const a = openRec("long", "a", "2026-09-18T23:00:00.000Z");
    appendPerpShadowRecord(path, a);
    appendPerpShadowRecord(path, { type: "settle", at: "2026-09-20T08:20:00.000Z", id: "a", settleCents: 7_000_000, source: "okx_delivery" });
    appendPerpShadowRecord(path, openRec("short", "b", "2026-09-19T00:00:00.000Z"));

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

    const csv = await fetch(`${base}/api/shadow/positions.csv`);
    assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
    const csvHead = (await csv.text()).split("\n")[0];
    assert.ok(csvHead.endsWith(",writer_c,tier") && !csvHead.includes("weekly_credit_c"));
    assert.ok(!(await (await fetch(`${base}/api/shadow/positions.csv?scope=full`)).text()).includes("weekly_credit_c"), "scope=full without the token is public");
    const full = await fetch(`${base}/api/shadow/positions.csv?scope=full&token=op-secret`);
    assert.match(full.headers.get("content-disposition") ?? "", /perp-shadow-positions-full-/);
    assert.ok((await full.text()).split("\n")[0].includes("weekly_credit_c"));

    const page = await (await fetch(`${base}/`)).text();
    assert.ok(page.includes("What protection did, quote by quote"));
    assert.ok(page.includes("rule comparison") && page.includes("report on request"));
    assert.ok(!page.includes('href="/report"') && !page.includes('href="/api/shadow/export"'));
    assert.ok(page.includes("floor save"), "the settled long was saved by its floor");
    assert.ok(!page.includes("NaN") && !page.includes("undefined"));

    const report = (await (await fetch(`${base}/api/shadow/report`, op)).json()) as {
      ok: boolean;
      rules: { tiers: Record<string, string>; feeRules: Record<string, { name: string }> };
      counterfactuals: { baseline: { quoted: number; settled: number }; tenors: Record<string, { quoted: number }>; capacity: Array<{ mult: number }> };
    };
    assert.equal(report.ok, true);
    assert.equal(report.counterfactuals.baseline.quoted, 2);
    assert.equal(report.counterfactuals.baseline.settled, 1);
    assert.equal(report.counterfactuals.tenors.weekly.quoted, 2);
    assert.deepEqual(report.counterfactuals.capacity.map((c) => c.mult), [1, 10, 50]);
    assert.ok(report.rules.tiers.tight && report.rules.feeRules.min_5bps.name === "share or 0.05% of notional");
    const reportPage = await fetch(`${base}/report?token=op-secret`);
    assert.equal(reportPage.status, 200);
    const reportHtml = await reportPage.text();
    assert.ok(reportHtml.includes("What each rule would have done") && reportHtml.includes("Tenor") && reportHtml.includes("Capacity"));
    assert.ok(reportHtml.includes('href="/api/shadow/export?token=op-secret"'));
    assert.ok(!reportHtml.includes("NaN") && !reportHtml.includes("undefined"));

    const exp = await fetch(`${base}/api/shadow/export`, op);
    assert.equal(exp.status, 200);
    assert.equal(await exp.text(), readFileSync(path, "utf8"), "byte for byte the ledger");
  } finally {
    delete process.env.EP_ADMIN_TOKEN;
    await new Promise<void>((r) => server.close(() => r()));
  }
});
