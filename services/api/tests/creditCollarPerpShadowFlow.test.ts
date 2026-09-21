import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { OkxChainInstrument } from "../src/singleSide/twoSided/creditCollar/execution/okxLivePlanner";
import { archiveLedgerFile, archivePathFor, archiveStamp } from "../src/singleSide/twoSided/creditCollar/perpShadow/ledgerArchive";
import type { BookDepth, OkxListedSnapshot } from "../src/singleSide/twoSided/creditCollar/perpShadow/okxListedSnapshot";
import {
  buildBook,
  closeAtIso,
  closeOutcome,
  DEFAULT_FLOW,
  describeFlow,
  flowConfigFromEnv,
  hourKey,
  normal,
  planHourBatch,
  rng,
  seedFrom,
  shortOptionMarginUsd,
  sizeClassOf,
  summarizeFlow,
  valueClose,
} from "../src/singleSide/twoSided/creditCollar/perpShadow/perpShadowFlow";
import {
  appendPerpShadowRecord,
  loadPerpShadow,
  plannedIdsIn,
  loadPerpShadowRecords,
  summarizePerpShadow,
  type PerpShadowOpenRecord,
  type PerpShadowPosition,
} from "../src/singleSide/twoSided/creditCollar/perpShadow/perpShadowLedger";
import { perpShadowQuote } from "../src/singleSide/twoSided/creditCollar/perpShadow/perpShadowQuote";

const DAILY = Date.UTC(2026, 8, 20, 8);
const WEEKLY = Date.UTC(2026, 8, 25, 8);
const SPOT = 80_000;

const inst = (expiryMs: number, optType: "put" | "call", strike: number): OkxChainInstrument => {
  const d = new Date(expiryMs);
  const code = `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  return { instId: `BTC-USD-${code}-${strike}-${optType === "put" ? "P" : "C"}`, optType, strike, expiryMs, ctValBtc: 0.01, tickSz: 0.0001, lotSz: 1, minSz: 1, state: "live" };
};
const STRIKES = [74000, 75000, 76000, 77000, 78000, 79000, 81000, 82000, 83000, 84000];
const chain: OkxChainInstrument[] = [];
for (const e of [DAILY, WEEKLY]) for (const k of STRIKES) chain.push(inst(e, "put", k), inst(e, "call", k));

const depth = (bid: number, ask: number, sizeTop = 5): BookDepth => ({
  bids: [{ pxBtc: bid, contracts: sizeTop }, { pxBtc: bid * 0.8, contracts: 200 }],
  asks: [{ pxBtc: ask, contracts: sizeTop }, { pxBtc: ask * 1.25, contracts: 200 }],
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
const TAKE = { shareRate: 0.2, minTakeBpsOfNotional: 0, deMinimisCents: 5 };
const quoteInputs = (side: "long" | "short", contracts: number, id: string) => ({
  side,
  spot: SPOT,
  contracts,
  geometry: { floorPct: 0.06, capPct: 0.015 },
  tenor: "weekly" as const,
  capGuard: { minCapPct: 0, maxCapPct: 0.08 },
  otherTenorCapGuard: { minCapPct: 0, maxCapPct: 0.08 },
  take: TAKE,
  counterfactualMinTakeBps: 5,
  okxIndex: SPOT,
  fundingBpsPer8h: 0.1,
  nowIso: "2026-09-18T23:00:00.000Z",
  id,
});

test("perp flow: config from env, with defaults and bounds", () => {
  const off = flowConfigFromEnv({});
  assert.equal(off.enabled, false);
  assert.deepEqual({ ...off, enabled: true }, { ...DEFAULT_FLOW, enabled: true });
  const on = flowConfigFromEnv({ PERP_SHADOW_FLOW: "1", PERP_SHADOW_DAILY_NOTIONAL_USD: "5000000", PERP_SHADOW_LONG_SHARE: "1.7", PERP_SHADOW_SIZE_SIGMA: "abc", PERP_SHADOW_CLOSE_SHARE: "0" });
  assert.equal(on.enabled, true);
  assert.equal(on.dailyNotionalUsd, 5_000_000);
  assert.equal(on.longShare, 0.7, "out of range falls back to the default");
  assert.equal(on.sigma, 1.4, "junk falls back to the default");
  assert.equal(on.closeShare, 0, "zero is a valid share");
  assert.match(describeFlow(on), /\$5\.0M of wraps a day/);
  assert.match(describeFlow(on), /70% long/);
});

test("perp flow: the seeded stream is reproducible and roughly normal", () => {
  assert.equal(seedFrom("perp-flow:2026-09-21T14"), seedFrom("perp-flow:2026-09-21T14"));
  assert.notEqual(seedFrom("perp-flow:2026-09-21T14"), seedFrom("perp-flow:2026-09-21T15"));
  const a = rng(seedFrom("x"));
  const b = rng(seedFrom("x"));
  const seqA = Array.from({ length: 5 }, () => a());
  const seqB = Array.from({ length: 5 }, () => b());
  assert.deepEqual(seqA, seqB);
  for (const v of seqA) assert.ok(v >= 0 && v < 1);
  const next = rng(seedFrom("normal"));
  const zs = Array.from({ length: 4000 }, () => normal(next));
  const mean = zs.reduce((s, z) => s + z, 0) / zs.length;
  const varz = zs.reduce((s, z) => s + (z - mean) ** 2, 0) / zs.length;
  assert.ok(Math.abs(mean) < 0.08, `mean ≈ 0, got ${mean}`);
  assert.ok(Math.abs(varz - 1) < 0.12, `variance ≈ 1, got ${varz}`);
});

test("perp flow: an hour's batch reaches its share of the daily target, mixes sides and sizes, and re-plans identically", () => {
  const cfg = { ...DEFAULT_FLOW, enabled: true };
  const key = hourKey(Date.UTC(2026, 8, 21, 14, 7));
  assert.equal(key, "2026-09-21T14");
  const batch = planHourBatch(key, SPOT, 0.01, cfg);
  assert.ok(batch.length >= 1);
  const notional = batch.reduce((s, w) => s + w.contracts * 0.01 * SPOT, 0);
  assert.ok(notional >= cfg.dailyNotionalUsd / 24, "the batch fills the hour's share of the daily target");
  assert.ok(notional < cfg.dailyNotionalUsd / 24 + cfg.maxUsd + 1, "and stops within one wrap of it");
  for (const w of batch) {
    assert.match(w.id, /^2026092114-f\d+$/);
    assert.ok(w.contracts >= 1);
    assert.ok(w.targetUsd >= cfg.minUsd && w.targetUsd <= cfg.maxUsd);
    assert.equal(w.sizeClass, sizeClassOf(w.targetUsd));
    if (w.closeAtFrac != null) assert.ok(w.closeAtFrac >= 0.1 && w.closeAtFrac <= 0.9);
  }
  assert.deepEqual(planHourBatch(key, SPOT, 0.01, cfg), batch, "same key, same plan: a restart cannot double-open");
  assert.notDeepEqual(planHourBatch(hourKey(Date.UTC(2026, 8, 21, 15)), SPOT, 0.01, cfg), batch);

  // over a day the mix comes out near the dials
  const day = Array.from({ length: 24 }, (_, h) => planHourBatch(hourKey(Date.UTC(2026, 8, 21, h)), SPOT, 0.01, cfg)).flat();
  const longShare = day.filter((w) => w.side === "long").length / day.length;
  const closeShare = day.filter((w) => w.closeAtFrac != null).length / day.length;
  assert.ok(Math.abs(longShare - 0.7) < 0.15, `long share ≈ 0.7, got ${longShare.toFixed(2)} over ${day.length}`);
  assert.ok(Math.abs(closeShare - 0.3) < 0.15, `close share ≈ 0.3, got ${closeShare.toFixed(2)}`);
  const classes = new Set(day.map((w) => w.sizeClass));
  assert.ok(classes.has("small") && classes.has("medium") && classes.has("large"), "all three buckets appear in a day");
  const sizes = day.map((w) => w.targetUsd).sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)];
  assert.ok(median > 7_000 && median < 30_000, `median near $15k, got ${median}`);

  assert.equal(sizeClassOf(24_999), "small");
  assert.equal(sizeClassOf(25_000), "medium");
  assert.equal(sizeClassOf(150_000), "large");
  assert.equal(closeAtIso("2026-09-21T14:00:00.000Z", "2026-09-25T08:00:00.000Z", 0.5), "2026-09-23T11:00:00.000Z");
  assert.equal(closeAtIso("2026-09-21T14:00:00.000Z", "2026-09-25T08:00:00.000Z", null), null);
});

test("perp flow: a wrap is priced at its own size by walking the book; too big for the depth refuses", () => {
  const small = perpShadowQuote({ ...quoteInputs("long", 3, "s"), fillMode: "walk" }, snap());
  const big = perpShadowQuote({ ...quoteInputs("long", 30, "b"), fillMode: "walk" }, snap());
  assert.equal(small.type, "open");
  assert.equal(big.type, "open");
  if (small.type !== "open" || big.type !== "open") return;
  const bpsSmall = small.creditCents / small.notionalCents;
  const bpsBig = big.creditCents / big.notionalCents;
  assert.ok(bpsBig < bpsSmall, `30 lots through a 5-lot top pays less per dollar than 3 lots (${bpsBig} vs ${bpsSmall})`);
  const huge = perpShadowQuote({ ...quoteInputs("long", 500, "h"), fillMode: "walk" }, snap());
  assert.equal(huge.type, "refusal");
  if (huge.type === "refusal") assert.equal(huge.error, "depth_insufficient", "beyond the visible depth: a refusal, never a guess");
});

const openFrom = (rec: ReturnType<typeof perpShadowQuote>): PerpShadowOpenRecord => {
  assert.equal(rec.type, "open");
  return rec as PerpShadowOpenRecord;
};

test("perp flow: an early close is valued at live legs two ways, and the outcome reads off it", () => {
  const p = openFrom(perpShadowQuote({ ...quoteInputs("long", 10, "c1"), fillMode: "walk" }, snap()));
  const v = valueClose({ ...p }, snap(), 81_000);
  assert.equal(v.markCents, 8_100_000);
  assert.ok(v.legs.floorBidBtc != null && v.legs.capAskBtc != null);
  assert.ok(v.unwindImmediateCents != null && v.unwindPassiveCents != null);
  assert.ok(v.unwindPassiveCents > v.unwindImmediateCents, "mids beat crossing the spread for the one unwinding");
  const o = closeOutcome(p, v);
  const qty = 10 * 0.01;
  assert.equal(o.nakedCents, Math.round(qty * (8_100_000 - 8_000_000)));
  assert.equal(o.protectedCents, o.nakedCents + p.creditCents + (v.unwindImmediateCents as number));
  assert.equal(o.executionEdgeCents, (v.unwindPassiveCents as number) - (v.unwindImmediateCents as number));

  // a leg off the live band: unpriced, and the outcome says so instead of inventing a number
  const s2 = snap();
  delete s2.books[p.sellInstId];
  const v2 = valueClose(p, s2, 81_000);
  assert.equal(v2.legs.capAskBtc, null);
  assert.equal(v2.unwindImmediateCents, null);
  assert.equal(closeOutcome(p, v2).deltaCents, null);
});

test("perp flow: the book nets by exact instrument; a long's cap and a short's floor at one strike cancel", () => {
  const s = snap();
  const long = { ...openFrom(perpShadowQuote({ ...quoteInputs("long", 10, "L"), fillMode: "walk" }, s)), status: "open" as const };
  const short = { ...openFrom(perpShadowQuote({ ...quoteInputs("short", 4, "S"), fillMode: "walk" }, s)), status: "open" as const };
  const long2 = { ...long, id: "L2", contracts: 6 };
  const positions: PerpShadowPosition[] = [long, short, long2];
  const book = buildBook(positions, s, SPOT, "2026-09-18T23:05:00.000Z");
  assert.equal(book.type, "book");
  assert.equal(book.totals.positions, 3);
  assert.equal(book.totals.grossContracts, 2 * (10 + 4 + 6), "two legs per wrap");
  const sameFloor = long.buyInstId === long2.buyInstId;
  assert.ok(sameFloor, "two longs at one spot share the floor strike");
  const floorRow = book.instruments.find((i) => i.instId === long.buyInstId)!;
  assert.equal(floorRow.longContracts, 16);
  assert.equal(floorRow.netContracts, 16 - floorRow.shortContracts);
  const capRow = book.instruments.find((i) => i.instId === long.sellInstId)!;
  assert.equal(capRow.shortContracts, 16);
  // if the short's floor call is the long's cap call, they cancel across sides
  if (short.buyInstId === long.sellInstId) {
    assert.equal(capRow.longContracts, 4);
    assert.equal(capRow.netContracts, 12);
    assert.equal(capRow.netSign, -1);
  }
  assert.ok(book.totals.netContracts < book.totals.grossContracts, "aggregating and cancelling removed legs");
  assert.ok((book.totals.nettedShare ?? 0) > 0);
  assert.ok(book.totals.feeNetCents < book.totals.feeGrossCents);
  assert.ok(book.totals.marginNetCents <= book.totals.marginGrossCents);
  assert.ok(book.totals.slippageGrossCents != null && book.totals.slippageNetCents != null, "every instrument is on the fixture's book");
  assert.ok(book.totals.slippageNetCents <= book.totals.slippageGrossCents, "one net order per instrument never walks deeper than every leg through the same book");
  assert.equal(book.totals.unpricedInstruments, 0);
  assert.ok(book.instruments.every((i) => i.strikeCents > 0 && (i.optType === "put" || i.optType === "call")));

  const m = shortOptionMarginUsd(80_000, 84_000, "call", 0.002, 0.1);
  // OTM 4000 → max(8000, 12000 − 4000 = 8000) + 160 mark → 8160 per BTC × 0.1
  assert.equal(+m.toFixed(2), 816);

  // without a snapshot: legs, fees and margin still count; slippage is unknown, not zero
  const blind = buildBook(positions, null, SPOT, "2026-09-18T23:05:00.000Z");
  assert.equal(blind.totals.grossContracts, book.totals.grossContracts);
  assert.equal(blind.totals.slippageGrossCents, null);
  assert.ok(blind.totals.unpricedInstruments > 0);
});

test("perp flow: the ledger replays opens, flow refusals, closes and books, dedups by id, and summarizes", () => {
  const dir = mkdtempSync(join(tmpdir(), "perp-flow-"));
  const path = join(dir, "ledger.jsonl");
  const s = snap();
  const cfg = { ...DEFAULT_FLOW, enabled: true };
  const a = openFrom(perpShadowQuote({ ...quoteInputs("long", 10, "2026092114-f1"), fillMode: "walk" }, s));
  a.flow = { sizeClass: "small", targetUsd: 8_000, closeAtIso: "2026-09-20T11:00:00.000Z" };
  const b = openFrom(perpShadowQuote({ ...quoteInputs("short", 200, "2026092114-f2"), fillMode: "walk" }, s));
  b.flow = { sizeClass: "large", targetUsd: 160_000, closeAtIso: null };
  appendPerpShadowRecord(path, a);
  appendPerpShadowRecord(path, b);
  const refusal = perpShadowQuote({ ...quoteInputs("long", 500, "2026092114-f3"), fillMode: "walk" }, s);
  assert.equal(refusal.type, "refusal");
  if (refusal.type === "refusal") {
    refusal.id = "2026092114-f3";
    refusal.sizeClass = "large";
    appendPerpShadowRecord(path, refusal);
    appendPerpShadowRecord(path, refusal); // a restart re-planning the hour
  }
  appendPerpShadowRecord(path, a); // and re-opening it
  const planned = plannedIdsIn(loadPerpShadowRecords(path));
  assert.deepEqual([...planned].sort(), ["2026092114-f1", "2026092114-f2", "2026092114-f3"]);

  appendPerpShadowRecord(path, buildBook([{ ...a, status: "open" }, { ...b, status: "open" }], s, SPOT, "2026-09-18T23:05:00.000Z"));
  const v = valueClose(a, s, 81_000);
  appendPerpShadowRecord(path, { type: "close", at: "2026-09-20T11:00:00.000Z", id: a.id, valuation: v });
  appendPerpShadowRecord(path, { type: "close", at: "2026-09-20T11:05:00.000Z", id: a.id, valuation: v }); // a second close is ignored
  appendPerpShadowRecord(path, { type: "settle", at: "2026-09-25T08:20:00.000Z", id: a.id, settleCents: 7_000_000, source: "okx_delivery" }); // a closed wrap cannot settle

  const { positions, refusals, books } = loadPerpShadow(path);
  assert.equal(positions.length, 2);
  assert.equal(refusals.length, 1, "the flow refusal counted once by id");
  assert.equal(books.length, 1);
  const closed = positions.find((p) => p.id === a.id)!;
  assert.equal(closed.status, "closed");
  assert.equal(closed.closedAt, "2026-09-20T11:00:00.000Z");
  assert.equal(closed.closeOutcome?.nakedCents, Math.round(0.1 * (8_100_000 - 8_000_000)));
  assert.equal(closed.outcome, undefined, "no expiry outcome on a closed wrap");

  const summary = summarizePerpShadow(positions, refusals);
  assert.equal(summary.closed, 1);
  assert.equal(summary.open, 1);
  assert.equal(summary.settled, 0);
  assert.equal(summary.settledTakeCents, 0);
  const flow = summarizeFlow(positions, refusals, books, cfg);
  assert.equal(flow.enabled, true);
  assert.equal(flow.bySize.small.positions, 1);
  assert.equal(flow.bySize.large.positions, 1);
  assert.equal(flow.bySize.large.refused, 1);
  assert.equal(flow.depthRefusals.large, 1);
  assert.equal(flow.closes.scheduled, 1);
  assert.equal(flow.closes.done, 1);
  assert.equal(flow.closes.unpriced, 0);
  assert.equal(flow.closes.executionEdgeCents, closed.closeOutcome?.executionEdgeCents);
  assert.equal(flow.notionalByDay.length, 1);
  assert.equal(flow.notionalByDay[0].day, "2026-09-18");
  assert.equal(flow.notionalByDay[0].positions, 2);
  assert.ok(flow.book.latest && flow.book.latest.positions === 2);
  assert.equal(flow.book.snapshots, 1);
  assert.ok(flow.book.avgNettedShare != null);

  // archive, never delete
  const stamp = archiveStamp("2026-09-21T03:04:05.678Z");
  assert.equal(stamp, "2026-09-21T030405Z");
  assert.equal(archivePathFor(path, "2026-09-21T03:04:05.678Z"), join(dir, "ledger.2026-09-21T030405Z.archived.jsonl"));
  const before = readFileSync(path, "utf8");
  const r = archiveLedgerFile(path, "2026-09-21T03:04:05.678Z");
  assert.equal(r.archivedTo, join(dir, "ledger.2026-09-21T030405Z.archived.jsonl"));
  assert.ok(!existsSync(path));
  assert.equal(readFileSync(r.archivedTo as string, "utf8"), before);
  assert.deepEqual(archiveLedgerFile(path), { path, archivedTo: null }, "nothing to archive is not an error");
  assert.deepEqual(loadPerpShadow(path), { positions: [], refusals: [], books: [] });
});
