/**
 * Pre-lock re-read: every open game priced again on both routes and every reference a fixed time
 * before its lock, from fresh books at the position's size, written beside the open-time read.
 * Pure pricing (rereadQuotesFor), the ledger's fold (prelock), the venues layout (a second read
 * per cell, per-venue totals at the pre-lock read), and the worker's tick with a fake engine.
 * Then the held books: the worker's hold tick against a fake feed source, the book-open re-read
 * it writes when a held book opens, its fold (bookOpen), and the venues layout of that read.
 * Then the in-game read: the same read a fixed number of minutes after the start, its fold
 * (inGame), the venues layout and CSV of it, and the worker's tick with a fake engine, which asks
 * the engine with the window set aside and writes nothing to the public record.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { quoteCrossWrap } from "../src/eventCollar/crossVenue/crossVenuePricer";
import { quoteLadderWrap, type NoAskLevel } from "../src/eventCollar/crossVenue/kalshiLadder";
import { counterfactualsFor, inPlayConfig, rereadQuotesFor, type CounterfactualInputs, type ShadowAltTerms } from "../src/eventCollar/crossVenue/shadowCounterfactuals";
import { appendShadowRecord, loadShadowPositions, type ShadowOpenRecord, type ShadowPosition } from "../src/eventCollar/crossVenue/shadowLedger";
import { venueBreakdown, venueBreakdownCsv, venueInGameFor, venuePrelockFor, venueRowFor } from "../src/eventCollar/crossVenue/shadowVenues";
import { DEFAULT_CROSS_CONFIG, type CrossQuoteResult, type MatchedPair, type PmBook } from "../src/eventCollar/crossVenue/types";
import type { ReferenceBook } from "../src/eventCollar/crossVenue/venueBooks";
import type { AggregatorBookSource, ReferenceStream } from "../src/eventCollar/crossVenue/aggregatorBooks";
import type { HeldBookOpen } from "../src/eventCollar/crossVenue/aggregatorHeldBooks";
import type { MarketStream } from "../src/eventCollar/crossVenue/aggregatorMarkets";
import type { CandidateResult, OneQuoteInputs, OneQuoteResult } from "../scripts/eventProtectXDemoService";

const LOCK = "2026-09-20T17:00:00.000Z";
const NOW = new Date("2026-09-20T15:00:00.000Z");
const CFG = { ...DEFAULT_CROSS_CONFIG, defaultTier: "tight" as const };
const NO_ASKS: NoAskLevel[] = [
  { priceCents: 41, qtyMilli: 300_000 },
  { priceCents: 42, qtyMilli: 400_000 },
  { priceCents: 43, qtyMilli: 400_000 },
];
const PM_NO_BOOK: PmBook = {
  tokenId: "222",
  asks: [
    { priceMilli: 380, sizeMilli: 300_000 },
    { priceMilli: 390, sizeMilli: 500_000 },
  ],
  bids: [{ priceMilli: 370, sizeMilli: 200_000 }],
  minOrderSizeShares: 5,
  tickMilli: 10,
};
/** a reference book a touch richer than the second venue's */
const REF_BOOK: PmBook = { ...PM_NO_BOOK, tokenId: "ref", asks: [{ priceMilli: 370, sizeMilli: 900_000 }] };

function pmPair(ticker = "KXMLBGAME-26SEP20NYYBOS-NYY", start = LOCK): MatchedPair {
  return {
    league: "mlb",
    kalshi: {
      ticker,
      eventTicker: "KXMLBGAME-26SEP20NYYBOS",
      title: "Yankees win",
      subtitle: "Yankees",
      strike: 0,
      strikeType: "",
      status: "active",
      openTime: "",
      closeTime: start,
      yesBidCents: 59,
      yesAskCents: 61,
      lastPriceCents: 60,
      volume: 1000,
      openInterest: 500,
      rulesPrimary: "",
    },
    pm: {
      eventSlug: "mlb-nyy-bos-2026-09-20",
      eventTitle: "New York Yankees vs. Boston Red Sox",
      question: "New York Yankees vs. Boston Red Sox",
      conditionId: "0xdef",
      outcomes: ["New York Yankees", "Boston Red Sox"],
      tokenIds: ["111", "222"],
      outcomePricesMilli: [600, 400],
      gameStartTime: start,
      endDate: "2026-09-27T17:00:00Z",
      sportsMarketType: "moneyline",
      active: true,
      closed: false,
      acceptingOrders: true,
      negRisk: false,
      orderMinSizeShares: 5,
      liquidityUsd: 9000,
      volumeUsd: 100,
    },
    pmYesOutcomeIndex: 0,
    pmNoOutcomeIndex: 1,
    gameStartTime: start,
    parityNote: "both venues settle on the official MLB final result for this game",
    fingerprint: "mlb:NYY:BOS:2026-09-20",
  };
}

const references: ReferenceBook[] = [
  { id: "aggregated_mm", book: REF_BOOK },
  { id: "signed_v3", book: null, reason: "not_listed" },
] as ReferenceBook[];

function inputs(over: Partial<CounterfactualInputs> = {}): CounterfactualInputs {
  return {
    route: "polymarket",
    ticker: "KXMLBGAME-26SEP20NYYBOS-NYY",
    lockTimeIso: LOCK,
    pair: pmPair(),
    markCents: 60,
    entryCents: 55,
    contracts: 150,
    now: NOW,
    config: CFG,
    books: { pmNoBook: PM_NO_BOOK, noAsks: NO_ASKS, references },
    ...over,
  };
}

test("rereadQuotesFor: both routes re-priced from the fresh books, every reference beside them; a missing book is unreachable, no pair is not offered", () => {
  const r = rereadQuotesFor(inputs());
  const pm = quoteCrossWrap({ pair: pmPair(), markCents: 60, entryCents: 55, contracts: 150, now: NOW, noBook: PM_NO_BOOK, config: CFG });
  const k = quoteLadderWrap({ pair: { kalshi: { ticker: "KXMLBGAME-26SEP20NYYBOS-NYY" }, gameStartTime: LOCK }, markCents: 60, entryCents: 55, contracts: 150, now: NOW, noAsks: NO_ASKS, config: CFG });
  assert.ok(pm.ok && k.ok);
  assert.ok(r.routes.polymarket.ok && r.routes.kalshi_self.ok);
  assert.equal(r.routes.polymarket.creditCents, pm.creditCents);
  assert.equal(r.routes.kalshi_self.creditCents, k.creditCents);
  assert.ok(r.references);
  assert.equal(r.references.length, 2);
  const ref = r.references.find((x) => x.id === "aggregated_mm");
  assert.ok(ref?.terms.ok);
  assert.ok(ref.terms.creditCents > pm.creditCents, "the richer book pays more credit");
  assert.equal(ref.bestAskMilli, 370);
  assert.ok(!r.references.find((x) => x.id === "signed_v3")?.terms.ok);

  const noPm = rereadQuotesFor(inputs({ books: { noAsks: NO_ASKS } }));
  assert.ok(!noPm.routes.polymarket.ok && noPm.routes.polymarket.refused === "unreachable");
  assert.ok(noPm.routes.kalshi_self.ok);
  assert.equal(noPm.references, undefined);
  const noPair = rereadQuotesFor(inputs({ pair: null, books: { noAsks: NO_ASKS } }));
  assert.ok(!noPair.routes.polymarket.ok && noPair.routes.polymarket.refused === "route_not_offered");
});

function openRecord(ticker: string, start: string, live: Extract<CrossQuoteResult, { ok: true }>, extra: Partial<ShadowOpenRecord> = {}): ShadowOpenRecord {
  return {
    type: "open",
    at: "2026-09-18T12:00:00.000Z",
    ticker,
    kind: "sports",
    league: "mlb",
    sideName: "Yankees",
    eventTitle: "New York Yankees vs. Boston Red Sox",
    eventTimeIso: start,
    contracts: 150,
    markCents: 60,
    floorCents: live.floorCents,
    capCents: live.capCents,
    creditCents: live.creditCents,
    evCostBps: live.evCostBps,
    route: "polymarket",
    feesCents: live.feesCents,
    takeCents: live.takeCents,
    hedgeCostCents: live.hedge.costCents + live.feesCents,
    hedgeUnitsMilli: "sharesMilli" in live.hedge ? live.hedge.sharesMilli : live.hedge.contractsMilli,
    tier: live.tier,
    counterfactuals: counterfactualsFor(inputs({ ticker, lockTimeIso: start, pair: pmPair(ticker, start) }), live),
    ...extra,
  };
}

test("ledger: a reread folds onto the position as prelock, first one wins, in any state; the unread form is kept as is", () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-reread-"));
  const path = join(dir, "ledger.jsonl");
  const live = quoteCrossWrap({ pair: pmPair(), markCents: 60, entryCents: 55, contracts: 150, now: NOW, noBook: PM_NO_BOOK, config: CFG });
  assert.ok(live.ok);
  appendShadowRecord(path, openRecord("A", LOCK, live));
  appendShadowRecord(path, openRecord("B", LOCK, live));
  const fresh = rereadQuotesFor(inputs({ ticker: "A" }));
  appendShadowRecord(path, { type: "reread", at: "2026-09-20T15:00:00.000Z", ticker: "A", phase: "prelock", hoursToLock: 2, markCents: 58, ...fresh });
  appendShadowRecord(path, { type: "reread", at: "2026-09-20T15:30:00.000Z", ticker: "A", phase: "prelock", hoursToLock: 1.5, markCents: 57, ...fresh });
  appendShadowRecord(path, { type: "settle", at: "2026-09-20T21:00:00.000Z", ticker: "A", result: "yes" });
  appendShadowRecord(path, { type: "reread", at: "2026-09-20T16:30:00.000Z", ticker: "B", phase: "prelock", hoursToLock: 0.5, unread: "market_too_close_to_start" });
  appendShadowRecord(path, { type: "reread", at: "2026-09-20T16:30:00.000Z", ticker: "Z", phase: "prelock", hoursToLock: 0.5, unread: "x" });
  const byTicker = new Map(loadShadowPositions(path).map((p) => [p.ticker, p]));
  const a = byTicker.get("A");
  assert.ok(a?.prelock && !("unread" in a.prelock));
  assert.equal(a.status, "settled", "settling after the read keeps it");
  assert.equal(a.prelock.hoursToLock, 2, "the first read stands");
  assert.equal(a.prelock.markCents, 58);
  assert.deepEqual(a.prelock.routes, fresh.routes);
  const b = byTicker.get("B");
  assert.ok(b?.prelock && "unread" in b.prelock);
  assert.equal(b.prelock.unread, "market_too_close_to_start");
  assert.equal(byTicker.has("Z"), false, "a read on no position is noise");
});

test("venues: the pre-lock read is laid out under the open-time one, deltas against the route written as it priced then; totals count both reads", () => {
  const live = quoteCrossWrap({ pair: pmPair(), markCents: 60, entryCents: 55, contracts: 150, now: NOW, noBook: PM_NO_BOOK, config: CFG });
  assert.ok(live.ok);
  const open = openRecord("A", LOCK, live);
  const { type: _t, ...fields } = open;
  // at the pre-lock read the second venue's book is a tick richer and Kalshi's side is gone
  const richer: PmBook = { ...PM_NO_BOOK, asks: [{ priceMilli: 360, sizeMilli: 900_000 }] };
  const fresh = rereadQuotesFor(inputs({ books: { pmNoBook: richer, references } }));
  assert.ok(fresh.routes.polymarket.ok && !fresh.routes.kalshi_self.ok);
  const position: ShadowPosition = { ...fields, status: "open", prelock: { at: "2026-09-20T15:00:00.000Z", hoursToLock: 2, markCents: 58, ...fresh, bookOrigins: { polymarket: "aggregator", kalshi: "direct" } } };
  const row = venueRowFor(position);
  assert.ok(row?.prelock);
  assert.equal(row.prelock.unread, null);
  assert.equal(row.prelock.markCents, 58);
  assert.equal(row.prelock.writtenCreditCents, fresh.routes.polymarket.creditCents);
  assert.deepEqual(
    row.prelock.cells.map((c) => c.id),
    row.cells.map((c) => c.id),
    "same columns, same order, as the open-time read",
  );
  const pmPre = row.prelock.cells.find((c) => c.id === "polymarket")!;
  assert.equal(pmPre.written, true);
  assert.equal(pmPre.deltaCents, 0);
  const kPre = row.prelock.cells.find((c) => c.id === "kalshi_self")!;
  assert.equal(kPre.read, true);
  assert.equal(kPre.creditCents, null);
  assert.equal(kPre.refused, "unreachable");
  const refPre = row.prelock.cells.find((c) => c.id === "aggregated_mm")!;
  assert.ok(refPre.creditCents !== null && refPre.deltaCents !== null);
  assert.equal(refPre.deltaCents, refPre.creditCents - (fresh.routes.polymarket.ok ? fresh.routes.polymarket.creditCents : 0), "against the written route at the SAME read, not the credit written at open");
  assert.ok(refPre.deltaCents < 0, "the second venue's fresher book (36¢) beats the reference (37¢) at this read");
  assert.equal(row.prelock.best, "polymarket");
  assert.equal(refPre.bestAskCents, 37);
  assert.equal(refPre.depthShares, 900);

  // the open-time cells are untouched by the pre-lock read
  const pmOpen = row.cells.find((c) => c.id === "polymarket")!;
  assert.equal(pmOpen.creditCents, live.creditCents);

  // when the written route refused at the pre-lock read there is nothing to compare to
  const unreachable = rereadQuotesFor(inputs({ books: { noAsks: NO_ASKS, references } }));
  const pl = venuePrelockFor({ at: "x", hoursToLock: 2, markCents: 58, ...unreachable }, "polymarket");
  assert.equal(pl.writtenCreditCents, null);
  assert.ok(pl.cells.every((c) => c.deltaCents === null));
  assert.ok(pl.cells.find((c) => c.id === "kalshi_self")?.creditCents !== null, "the other route still priced");
  // the unread form
  const un = venuePrelockFor({ at: "x", hoursToLock: 0.5, unread: "market_too_close_to_start" }, "polymarket");
  assert.equal(un.unread, "market_too_close_to_start");
  assert.ok(un.cells.every((c) => !c.read));

  // totals: one game with a pre-lock read, one without, one unread
  const b = venueBreakdown(
    [
      position,
      { ...fields, ticker: "B", status: "open" },
      { ...fields, ticker: "C", status: "open", prelock: { at: "x", hoursToLock: 0.5, unread: "market_not_active" } },
    ],
    new Date("2026-09-20T16:00:00.000Z"),
  );
  assert.deepEqual(b.prelock, { read: 1, unread: 1 });
  const t = Object.fromEntries(b.totals.map((x) => [x.id, x]));
  assert.equal(t.polymarket.read, 3, "open-time reads unchanged");
  assert.equal(t.polymarket.prelock.read, 1);
  assert.equal(t.polymarket.prelock.quoted, 1);
  assert.equal(t.kalshi_self.prelock.read, 1);
  assert.equal(t.kalshi_self.prelock.quoted, 0);
  assert.equal(t.aggregated_mm.prelock.read, 1);
  assert.equal(t.aggregated_mm.prelock.quoted, 1);
  assert.equal(t.polymarket.prelock.best, 1, "the second venue's book was cheapest at the pre-lock read");
  assert.equal(t.aggregated_mm.prelock.best, 0);
  assert.equal(t.aggregated_mm.prelock.bothQuoted, 1);
  assert.equal(t.aggregated_mm.prelock.avgDeltaCents, refPre.deltaCents);
  assert.equal(t.signed_v3.prelock.read, 1);
  assert.equal(t.signed_v3.prelock.listed, 0);
  assert.equal(b.rows.find((r) => r.ticker === "A")?.prelock?.cells.length, b.rows.find((r) => r.ticker === "A")?.cells.length);
  assert.equal(b.rows.find((r) => r.ticker === "B")?.prelock, undefined);
});

// ---------------------------------------------------------------------------
// the worker's tick with a fake engine
// ---------------------------------------------------------------------------

function candidate(ticker: string, start: string, over: Partial<CandidateResult> = {}, config = DEFAULT_CROSS_CONFIG): CandidateResult {
  const pair = pmPair(ticker, start);
  const quote = quoteCrossWrap({ pair, markCents: 58, entryCents: 58, contracts: 150, now: new Date(), noBook: PM_NO_BOOK, config });
  assert.ok(quote.ok, JSON.stringify(quote));
  return {
    kind: "sports",
    league: "mlb",
    market: pair.kalshi,
    pair,
    sideName: "Yankees",
    eventTitle: pair.pm.eventTitle,
    eventTimeIso: start,
    parityNote: "",
    fingerprint: `test:${ticker}`,
    markCents: 58,
    position: { contracts: 150, entryCents: 58, entrySource: "entered_now", entryTime: null },
    quote,
    route: "polymarket",
    evBps: quote.evCostBps,
    routesChecked: [],
    books: { pmNoBook: PM_NO_BOOK, noAsks: NO_ASKS, references },
    bookOrigins: { polymarket: "aggregator", kalshi: "direct" },
    ...over,
  };
}

test("shadow worker reread tick: games inside the window are read once, at their size, and written beside the open; structural refusals are final; an unreachable venue is retried; the read is the operator's", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-reread-worker-"));
  const scanLedger = join(dir, "ledger.jsonl");
  const lockLedger = join(dir, "lock-ledger.jsonl");
  process.env.NODE_ENV = "test";
  process.env.EVENT_SHADOW_LEDGER_PATH = scanLedger;
  process.env.EVENT_SHADOW_LOCK_LEDGER_PATH = lockLedger;
  process.env.EVENT_LASTLEG_LEDGER_PATH = join(dir, "lastleg.jsonl");
  process.env.EVENT_X_ADMIN_TOKEN = "op-secret";
  process.env.EVENT_SHADOW_REREAD_HOURS = "2";
  const h = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
  const live = quoteCrossWrap({ pair: pmPair("A", h(1.5)), markCents: 60, entryCents: 55, contracts: 150, now: new Date(), noBook: PM_NO_BOOK, config: CFG });
  assert.ok(live.ok, JSON.stringify(live));
  // A: due (1.5h out). B: not yet (5h). C: due, the engine refuses structurally. D: due, the venues down once. E: crypto, never. F: a holder's lock, due.
  const opened = { at: h(-30) };
  appendShadowRecord(scanLedger, openRecord("A", h(1.5), live, opened));
  appendShadowRecord(scanLedger, openRecord("B", h(5), live, opened));
  appendShadowRecord(scanLedger, openRecord("C", h(0.6), live, opened));
  appendShadowRecord(scanLedger, openRecord("D", h(1), live, opened));
  appendShadowRecord(scanLedger, { ...openRecord("E", h(1), live, opened), kind: "crypto", league: "crypto", route: "kalshi_self" });
  appendShadowRecord(lockLedger, openRecord("F", h(1.2), live, { ...opened, source: "lock", entryCents: 52, contracts: 20 }));

  const worker = await import("../scripts/eventShadowWorker");
  const seen: OneQuoteInputs[] = [];
  let dDown = true;
  worker.wireLockEngine({
    listGameMarkets: async () => [],
    quoteOne: async (inputs: OneQuoteInputs): Promise<OneQuoteResult> => {
      seen.push(inputs);
      if (inputs.ticker === "C") return { ok: false, code: "market_too_close_to_start", detail: "too soon" };
      if (inputs.ticker === "D" && dDown) throw new Error("venue unreachable");
      return { ok: true, result: candidate(inputs.ticker, h(1)) };
    },
  });

  await worker.rereadTick();
  assert.deepEqual(seen.map((s) => s.ticker).sort(), ["A", "C", "D", "F"], "only open games inside the window, on both ledgers");
  assert.equal(seen.find((s) => s.ticker === "F")?.contracts, 20, "at the holder's size");
  assert.equal(seen.find((s) => s.ticker === "F")?.entryCents, 52, "and their entry");
  assert.equal(seen.find((s) => s.ticker === "A")?.entryCents, undefined, "the scan's positions carry none");

  const scan1 = new Map(loadShadowPositions(scanLedger).map((p) => [p.ticker, p]));
  const a = scan1.get("A")?.prelock;
  assert.ok(a && !("unread" in a), "A has its read");
  assert.ok(a.hoursToLock >= 1.4 && a.hoursToLock <= 1.5, `hours to lock ${a.hoursToLock}`);
  assert.equal(a.markCents, 58);
  assert.ok(a.routes.polymarket.ok && a.routes.kalshi_self.ok);
  assert.equal(a.references?.length, 2);
  assert.deepEqual(a.bookOrigins, { polymarket: "aggregator", kalshi: "direct" });
  assert.equal(scan1.get("B")?.prelock, undefined);
  const c = scan1.get("C")?.prelock;
  assert.ok(c && "unread" in c && c.unread === "market_too_close_to_start");
  assert.equal(scan1.get("D")?.prelock, undefined, "the unreachable one is not written");
  assert.equal(scan1.get("E")?.prelock, undefined);
  const f = loadShadowPositions(lockLedger).find((p) => p.ticker === "F")?.prelock;
  assert.ok(f && !("unread" in f), "the lock ledger got its own line");
  assert.equal(readFileSync(scanLedger, "utf8").split("\n").filter((l) => l.includes('"reread"')).length, 2, "A and C on the scan ledger");

  // next tick: D's venue is back; A, C and F are not asked again
  dDown = false;
  seen.length = 0;
  await worker.rereadTick();
  assert.deepEqual(seen.map((s) => s.ticker), ["D"]);
  assert.ok(loadShadowPositions(scanLedger).find((p) => p.ticker === "D")?.prelock);
  seen.length = 0;
  await worker.rereadTick();
  assert.deepEqual(seen, [], "nothing left to read");

  await new Promise<void>((r) => worker.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
  try {
    // the venues JSON carries the pre-lock read per row and per venue
    const v = (await (await fetch(`${base}/api/shadow/venues?token=op-secret`)).json()) as {
      prelock: { read: number; unread: number };
      totals: Array<{ id: string; prelock: { read: number; quoted: number; best: number } }>;
      rows: Array<{ ticker: string; prelock?: { hoursToLock: number; unread: string | null; cells: Array<{ id: string; creditCents: number | null }> } }>;
    };
    assert.deepEqual(v.prelock, { read: 3, unread: 1 });
    const rowA = v.rows.find((r) => r.ticker === "A");
    assert.ok(rowA?.prelock && rowA.prelock.unread === null);
    assert.ok(rowA.prelock.cells.find((x) => x.id === "aggregated_mm")?.creditCents);
    assert.ok(v.totals.find((t) => t.id === "aggregated_mm")!.prelock.quoted === 3);
    // the page shows the second read under the first, marked by its hours to lock
    const html = await (await fetch(`${base}/venues?token=op-secret`)).text();
    assert.match(html, /T-1\.[45]h/);
    assert.match(html, /priced again before the lock/);
    assert.match(html, /By venue, at the pre-lock read/);
    assert.match(html, /too close to start/);
    // the operator's health carries the tick's counters; the public one and the public record say nothing of it
    const health = (await (await fetch(`${base}/healthz?token=op-secret`)).json()) as { reread: { hours: number; dueLastTick: number; writtenLastTick: number; lastError: string | null } };
    assert.equal(health.reread.hours, 2);
    assert.equal(health.reread.lastError, null);
    const publicHealth = JSON.stringify(await (await fetch(`${base}/healthz`)).json());
    assert.ok(!publicHealth.includes("reread"));
    const pub = JSON.stringify(await (await fetch(`${base}/api/shadow`)).json());
    assert.ok(!pub.includes("prelock"), "the public record never carries the pre-lock read");
    assert.ok(!pub.includes("aggregated_mm") && !pub.includes("signed_v3"));
  } finally {
    await new Promise<void>((r) => worker.server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// held books: the worker's hold tick and the book-open re-read
// ---------------------------------------------------------------------------

/** An in-memory stand-in for the held-books connection: the test fires the opens itself. */
function fakeHeldSource(streamsFor: (ticker: string) => ReferenceStream[] | null) {
  const held = new Map<string, MarketStream>();
  const released: string[] = [];
  const lookups: string[] = [];
  let onOpen: ((ev: HeldBookOpen) => void) | null = null;
  let closed = 0;
  const phases = () => ({ pending: 0, empty: held.size, open: 0, not_yet_open: 0, unavailable: 0, closed: 0, stopped: 0 });
  const source: AggregatorBookSource = {
    read: async () => ({ references: [], notes: [], readAtIso: new Date().toISOString() }),
    status: () => ({ configured: true, host: "fake", keyIdTail: "abcdef", publicKeyHex: "00", lastReadAt: null, lastError: null, reads: 0, readsWithBooks: 0, mappingMismatches: 0 }),
    referenceStreams: async (ticker) => {
      lookups.push(ticker);
      return streamsFor(ticker);
    },
    heldBooks: (opts) => {
      onOpen = opts?.onOpen ?? null;
      return {
        hold: (key, market) => {
          if (held.has(key)) return "already";
          held.set(key, market);
          return "held";
        },
        release: (key) => {
          if (held.delete(key)) released.push(key);
        },
        get: () => undefined,
        list: () => [],
        status: () => ({ connected: true, connectionId: "fake-1", connects: 1, held: held.size, byPhase: phases(), opens: 0, frames: 0, lastFrameAt: null, lastError: null, lastGoodbye: null, stopped: null, overCap: 0 }),
        close: () => {
          closed += 1;
        },
      };
    },
  };
  const open = (key: string, caught: "live" | "at_hold", book = { bids: [{ price: 0.37, size: 100 }], asks: [{ price: 0.42, size: 150 }, { price: 0.43, size: 50 }] }) => {
    assert.ok(onOpen, "the worker wired its onOpen");
    onOpen!({ key, market: held.get(key) ?? { venue: "PROPHETX", strikeId: "?" }, book, atIso: new Date().toISOString(), sinceIso: new Date(Date.now() - 60_000).toISOString(), caught });
  };
  return { source, held, released, lookups, open, closedCount: () => closed };
}

test("shadow worker hold tick: every open game inside the hold window is held on the feed, one hold per reference venue; the open the stream reports is priced at that second and written as a book_open re-read with how it was caught; the holds are then released; unmapped games are asked again; an unreachable read is retried", async () => {
  const scanLedger = process.env.EVENT_SHADOW_LEDGER_PATH!;
  const lockLedger = process.env.EVENT_SHADOW_LOCK_LEDGER_PATH!;
  const h = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
  const live = quoteCrossWrap({ pair: pmPair("G", h(30)), markCents: 60, entryCents: 55, contracts: 150, now: new Date(), noBook: PM_NO_BOOK, config: CFG });
  assert.ok(live.ok);
  const opened = { at: h(-10) };
  // G: 30h out, mapped on the late venue. H: 20h out, mapped; the engine will refuse at the open. I: 10h out, mapped but no reference listing yet.
  // J: 60h out, outside the window. K: 26h out, mapped; the venues are down at its open, once. L: a holder's lock, 12h out, mapped.
  appendShadowRecord(scanLedger, openRecord("G", h(30), live, opened));
  appendShadowRecord(scanLedger, openRecord("H", h(20), live, opened));
  appendShadowRecord(scanLedger, openRecord("I", h(10), live, opened));
  appendShadowRecord(scanLedger, openRecord("J", h(60), live, opened));
  appendShadowRecord(scanLedger, openRecord("K", h(26), live, opened));
  appendShadowRecord(lockLedger, openRecord("L", h(12), live, { ...opened, source: "lock", entryCents: 52, contracts: 20 }));

  const worker = await import("../scripts/eventShadowWorker");
  const px = (s: string): ReferenceStream => ({ id: "aggregated_mm", stream: { venue: "PROPHETX", strikeId: s } });
  const fake = fakeHeldSource((t) => (t === "G" || t === "H" || t === "K" || t === "L" ? [px(t.toLowerCase())] : t === "I" ? [] : null));
  const seen: OneQuoteInputs[] = [];
  let kDown = true;
  worker.wireLockEngine({
    listGameMarkets: async () => [],
    quoteOne: async (inputs: OneQuoteInputs): Promise<OneQuoteResult> => {
      seen.push(inputs);
      if (inputs.ticker === "H") return { ok: false, code: "market_not_active", detail: "closed" };
      if (inputs.ticker === "K" && kDown) throw new Error("venue unreachable");
      return { ok: true, result: candidate(inputs.ticker, h(1)) };
    },
  });
  worker.wireHeldBooks(fake.source);
  try {
    await worker.holdTick();
    // held: G, H, K, L (one reference venue each); I has no listing yet; J is outside the window; the earlier tests' games (A..F, inside 48h) were looked up and found unmapped
    assert.deepEqual([...fake.held.keys()].sort(), ["G|aggregated_mm", "H|aggregated_mm", "K|aggregated_mm", "L|aggregated_mm"]);
    assert.ok(fake.lookups.includes("I") && !fake.lookups.includes("J"));
    assert.deepEqual(seen, [], "holding reads nothing");

    // G opens live; L had levels at its first snapshot
    fake.open("G|aggregated_mm", "live");
    fake.open("L|aggregated_mm", "at_hold");
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(seen.map((s) => s.ticker), ["G", "L"]);
    assert.equal(seen[1].contracts, 20, "the holder's size");
    const g = loadShadowPositions(scanLedger).find((p) => p.ticker === "G")!;
    assert.ok(g.bookOpen && !("unread" in g.bookOpen), "G has its book-open read");
    assert.equal(g.bookOpen.opened.venue, "aggregated_mm");
    assert.equal(g.bookOpen.opened.caught, "live");
    assert.equal(g.bookOpen.opened.bestAskCents, 42);
    assert.equal(g.bookOpen.opened.bestBidCents, 37);
    assert.equal(g.bookOpen.opened.depthShares, 200);
    assert.ok(g.bookOpen.hoursToLock > 29 && g.bookOpen.hoursToLock <= 30, `hours to lock ${g.bookOpen.hoursToLock}`);
    assert.ok(g.bookOpen.routes.polymarket.ok && g.bookOpen.references?.length === 2);
    assert.equal(g.prelock, undefined, "the pre-lock read is a different line");
    const l = loadShadowPositions(lockLedger).find((p) => p.ticker === "L")!;
    assert.equal(l.bookOpen?.opened.caught, "at_hold");
    assert.deepEqual(fake.released.sort(), ["G|aggregated_mm", "L|aggregated_mm"], "a priced open releases the game's holds");

    // H opens; the engine refuses structurally: written as unread, released. K opens; the venues are down: kept, retried next tick.
    fake.open("H|aggregated_mm", "live");
    fake.open("K|aggregated_mm", "live");
    await new Promise((r) => setTimeout(r, 50));
    const hPos = loadShadowPositions(scanLedger).find((p) => p.ticker === "H")!;
    assert.ok(hPos.bookOpen && "unread" in hPos.bookOpen && hPos.bookOpen.unread === "market_not_active");
    assert.equal(hPos.bookOpen.opened.venue, "aggregated_mm");
    assert.equal(loadShadowPositions(scanLedger).find((p) => p.ticker === "K")!.bookOpen, undefined);
    assert.ok(fake.held.has("K|aggregated_mm"), "K stays held while its read is retried");
    kDown = false;
    seen.length = 0;
    await worker.holdTick();
    assert.deepEqual(seen.map((s) => s.ticker), ["K"]);
    assert.ok(loadShadowPositions(scanLedger).find((p) => p.ticker === "K")!.bookOpen);
    assert.ok(!fake.held.has("K|aggregated_mm"));
    // games with their read are not held again; I is asked about again (its mapping may have landed)
    fake.lookups.length = 0;
    await worker.holdTick();
    assert.ok(!fake.held.has("G|aggregated_mm") && !fake.held.has("H|aggregated_mm"));
    assert.ok(fake.lookups.includes("I"));
    assert.equal(fake.held.size, 0);

    await new Promise<void>((r) => worker.server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
    try {
      const v = (await (await fetch(`${base}/api/shadow/venues?token=op-secret`)).json()) as {
        bookOpen: { read: number; unread: number; live: number; atHold: number; avgHoursToLock: number | null; avgHoursToLockLive: number | null };
        heldBooks: { connected: boolean; held: number } | null;
        totals: Array<{ id: string; bookOpen: { read: number; quoted: number; best: number } }>;
        rows: Array<{ ticker: string; bookOpen?: { hoursToLock: number; unread: string | null; opened: { venue: string; caught: string }; cells: Array<{ id: string; creditCents: number | null }> } }>;
      };
      assert.deepEqual({ read: v.bookOpen.read, unread: v.bookOpen.unread, live: v.bookOpen.live, atHold: v.bookOpen.atHold }, { read: 3, unread: 1, live: 3, atHold: 1 });
      assert.ok(v.bookOpen.avgHoursToLock! > 20 && v.bookOpen.avgHoursToLock! < 23, `avg hours ${v.bookOpen.avgHoursToLock}`);
      assert.ok(v.heldBooks && v.heldBooks.connected);
      const rowG = v.rows.find((r) => r.ticker === "G")!;
      assert.equal(rowG.bookOpen?.opened.caught, "live");
      assert.ok(rowG.bookOpen!.cells.find((c) => c.id === "aggregated_mm")?.creditCents);
      assert.equal(v.totals.find((t) => t.id === "aggregated_mm")!.bookOpen.quoted, 3);
      assert.ok(v.rows.find((r) => r.ticker === "J")!.bookOpen === undefined);

      const html = await (await fetch(`${base}/venues?token=op-secret`)).text();
      assert.match(html, /By venue, the moment a book opened/);
      assert.match(html, /ProphetX opened T-(29\.\d|30)h/);
      assert.match(html, /before the hold/);
      assert.match(html, /caught a reference book opening: 3 seen live, 1 already open/);
      assert.match(html, /<b>opened T-/);

      const health = (await (await fetch(`${base}/healthz?token=op-secret`)).json()) as { heldBooks: { on: boolean; hours: number; holding: number; bookOpensWritten: number; notMappedLastTick: number; stream: { connected: boolean } | null } };
      assert.equal(health.heldBooks.on, true);
      assert.equal(health.heldBooks.hours, 48);
      assert.equal(health.heldBooks.bookOpensWritten, 4);
      assert.equal(health.heldBooks.holding, 0);
      assert.ok(health.heldBooks.notMappedLastTick >= 1);
      assert.ok(health.heldBooks.stream?.connected);
      const publicHealth = JSON.stringify(await (await fetch(`${base}/healthz`)).json());
      assert.ok(!publicHealth.includes("heldBooks"));
      const pub = JSON.stringify(await (await fetch(`${base}/api/shadow`)).json());
      assert.ok(!pub.includes("bookOpen") && !pub.includes("heldSince"), "the public record never carries the book-open read");
    } finally {
      await new Promise<void>((r) => worker.server.close(() => r()));
    }
  } finally {
    worker.wireHeldBooks(null);
  }
  assert.equal(fake.closedCount(), 1, "the connection is closed when the source is unwired");
});

// ---------------------------------------------------------------------------
// the in-game read: fold, layout, and the worker's tick
// ---------------------------------------------------------------------------

test("inPlayConfig: both pricers refuse past the start under the record's config and price under the in-play one; the mark band and the rest still apply", () => {
  const start = "2026-09-20T17:00:00.000Z";
  const inPlay = new Date("2026-09-20T17:20:00.000Z");
  const pair = pmPair("KXMLBGAME-26SEP20NYYBOS-NYY", start);
  const pm = quoteCrossWrap({ pair, markCents: 66, entryCents: 55, contracts: 150, now: inPlay, noBook: PM_NO_BOOK, config: CFG });
  assert.ok(!pm.ok && pm.code === "market_too_close_to_start");
  const k = quoteLadderWrap({ pair: { kalshi: { ticker: pair.kalshi.ticker }, gameStartTime: start }, markCents: 66, entryCents: 55, contracts: 150, now: inPlay, noAsks: NO_ASKS, config: CFG });
  assert.ok(!k.ok && k.code === "market_too_close_to_start");
  const cfg = inPlayConfig(CFG);
  assert.equal(cfg.defaultTier, CFG.defaultTier, "only the lead-time gate changes");
  const pmIn = quoteCrossWrap({ pair, markCents: 66, entryCents: 55, contracts: 150, now: inPlay, noBook: PM_NO_BOOK, config: cfg });
  assert.ok(pmIn.ok, JSON.stringify(pmIn));
  const kIn = quoteLadderWrap({ pair: { kalshi: { ticker: pair.kalshi.ticker }, gameStartTime: start }, markCents: 66, entryCents: 55, contracts: 150, now: inPlay, noAsks: NO_ASKS, config: cfg });
  assert.ok(kIn.ok, JSON.stringify(kIn));
  const wide = quoteCrossWrap({ pair, markCents: 97, entryCents: 55, contracts: 150, now: inPlay, noBook: PM_NO_BOOK, config: cfg });
  assert.ok(!wide.ok && wide.code === "mark_out_of_range", "a game nearly decided is still out of the band");
  // the re-read prices every route and reference the same way
  const r = rereadQuotesFor(inputs({ markCents: 66, now: inPlay, config: cfg }));
  assert.ok(r.routes.polymarket.ok && r.routes.kalshi_self.ok);
  assert.ok(r.references?.find((x) => x.id === "aggregated_mm")?.terms.ok);
  const rOld = rereadQuotesFor(inputs({ markCents: 66, now: inPlay }));
  assert.ok(!rOld.routes.polymarket.ok && !rOld.routes.kalshi_self.ok, "under the record's config nothing prices in play");
});

test("ledger: an in_game reread folds onto the position as inGame beside the pre-lock read, first one wins; the unread form is kept as is", () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-ingame-"));
  const path = join(dir, "ledger.jsonl");
  const live = quoteCrossWrap({ pair: pmPair(), markCents: 60, entryCents: 55, contracts: 150, now: NOW, noBook: PM_NO_BOOK, config: CFG });
  assert.ok(live.ok);
  appendShadowRecord(path, openRecord("A", LOCK, live));
  appendShadowRecord(path, openRecord("B", LOCK, live));
  const fresh = rereadQuotesFor(inputs({ ticker: "A" }));
  appendShadowRecord(path, { type: "reread", at: "2026-09-20T15:00:00.000Z", ticker: "A", phase: "prelock", hoursToLock: 2, markCents: 58, ...fresh });
  appendShadowRecord(path, { type: "reread", at: "2026-09-20T17:20:00.000Z", ticker: "A", phase: "in_game", hoursToLock: -0.3, minutesIn: 20, markCents: 66, protectedBook: { yesBidCents: 63, yesAskCents: 69 }, ...fresh });
  appendShadowRecord(path, { type: "reread", at: "2026-09-20T17:40:00.000Z", ticker: "A", phase: "in_game", hoursToLock: -0.7, minutesIn: 40, markCents: 70, ...fresh });
  appendShadowRecord(path, { type: "settle", at: "2026-09-20T21:00:00.000Z", ticker: "A", result: "yes" });
  appendShadowRecord(path, { type: "reread", at: "2026-09-20T17:20:00.000Z", ticker: "B", phase: "in_game", hoursToLock: -0.3, minutesIn: 20.2, unread: "market_not_active" });
  const byTicker = new Map(loadShadowPositions(path).map((p) => [p.ticker, p]));
  const a = byTicker.get("A");
  assert.ok(a?.inGame && !("unread" in a.inGame));
  assert.ok(a.prelock, "the pre-lock read is kept beside it");
  assert.equal(a.status, "settled");
  assert.equal(a.inGame.minutesIn, 20, "the first in-game read stands");
  assert.equal(a.inGame.hoursToLock, -0.3);
  assert.equal(a.inGame.markCents, 66);
  assert.deepEqual(a.inGame.protectedBook, { yesBidCents: 63, yesAskCents: 69 });
  assert.deepEqual(a.inGame.routes, fresh.routes);
  const b = byTicker.get("B");
  assert.ok(b?.inGame && "unread" in b.inGame);
  assert.equal(b.inGame.unread, "market_not_active");
  assert.equal(b.inGame.minutesIn, 20.2);
});

test("venues: the in-game read is laid out under the others with its minutes and the protected market's spread; totals and the CSV carry it; a game without one is unchanged", () => {
  const live = quoteCrossWrap({ pair: pmPair(), markCents: 60, entryCents: 55, contracts: 150, now: NOW, noBook: PM_NO_BOOK, config: CFG });
  assert.ok(live.ok);
  const { type: _t, ...fields } = openRecord("A", LOCK, live);
  // in play the second venue's book is still there, a touch dearer; Kalshi's No side is gone; the reference still lists
  const dearer: PmBook = { ...PM_NO_BOOK, asks: [{ priceMilli: 420, sizeMilli: 600_000 }] };
  const fresh = rereadQuotesFor(inputs({ markCents: 66, books: { pmNoBook: dearer, references } }));
  assert.ok(fresh.routes.polymarket.ok && !fresh.routes.kalshi_self.ok);
  const read = { at: "2026-09-20T17:20:00.000Z", hoursToLock: -0.3, minutesIn: 20, markCents: 66, protectedBook: { yesBidCents: 63, yesAskCents: 69 }, ...fresh };
  const ig = venueInGameFor(read, "polymarket");
  assert.equal(ig.minutesIn, 20);
  assert.deepEqual(ig.protectedBook, { yesBidCents: 63, yesAskCents: 69 });
  assert.equal(ig.markCents, 66);
  assert.equal(ig.writtenCreditCents, fresh.routes.polymarket.creditCents);
  assert.equal(ig.cells.find((c) => c.id === "polymarket")?.written, true);
  assert.equal(ig.cells.find((c) => c.id === "kalshi_self")?.refused, "unreachable");
  assert.ok((ig.cells.find((c) => c.id === "aggregated_mm")?.creditCents ?? 0) > 0);
  const un = venueInGameFor({ at: "x", hoursToLock: -0.4, minutesIn: 23.5, unread: "mark_out_of_range" }, "polymarket");
  assert.equal(un.unread, "mark_out_of_range");
  assert.equal(un.protectedBook, null);
  assert.ok(un.cells.every((c) => !c.read));

  const position: ShadowPosition = { ...fields, status: "open", inGame: read };
  const row = venueRowFor(position);
  assert.ok(row?.inGame);
  assert.equal(row.prelock, undefined);
  assert.deepEqual(row.inGame.cells.map((c) => c.id), row.cells.map((c) => c.id), "same columns, same order");

  const b = venueBreakdown(
    [position, { ...fields, ticker: "B", status: "open" }, { ...fields, ticker: "C", status: "settled", result: "yes", inGame: { at: "x", hoursToLock: -0.4, minutesIn: 24, unread: "market_not_active" } }],
    new Date("2026-09-20T18:00:00.000Z"),
  );
  assert.deepEqual(b.inGame, { read: 1, unread: 1, avgMinutesIn: 22, avgSpreadCents: 6 });
  assert.deepEqual(b.prelock, { read: 0, unread: 0 }, "the pre-lock totals do not count it");
  const t = Object.fromEntries(b.totals.map((x) => [x.id, x]));
  assert.equal(t.polymarket.read, 3, "open-time reads unchanged");
  assert.equal(t.polymarket.inGame.read, 1);
  assert.equal(t.polymarket.inGame.quoted, 1);
  assert.equal(t.polymarket.prelock.read, 0);
  assert.equal(t.kalshi_self.inGame.read, 1);
  assert.equal(t.kalshi_self.inGame.quoted, 0);
  assert.equal(t.aggregated_mm.inGame.read, 1);
  assert.equal(t.aggregated_mm.inGame.quoted, 1);
  assert.equal(t.aggregated_mm.inGame.bothQuoted, 1);
  assert.equal(t.aggregated_mm.inGame.avgDeltaCents, ig.cells.find((c) => c.id === "aggregated_mm")?.deltaCents);
  assert.equal(b.rows.find((r) => r.ticker === "B")?.inGame, undefined);

  const csv = venueBreakdownCsv(b).split("\n");
  const inGameLines = csv.filter((l) => l.includes(",in_game,"));
  const kept = b.rows.find((r) => r.ticker === "A")!.cells.length;
  assert.equal(inGameLines.length, 2 * kept, "one line per kept venue for each game read in play, the unread one included");
  const pmLine = inGameLines.find((l) => l.startsWith("A,") && l.includes(",polymarket,"))!;
  assert.ok(pmLine.includes(",-0.3,"), `hours to lock negative past the start: ${pmLine}`);
  assert.ok(pmLine.includes(",quoted,"));
  const openLinesA = csv.filter((l) => l.startsWith("A,") && l.includes(",open,open,"));
  assert.equal(openLinesA.length, kept, "the open-time lines are unchanged");
});

test("shadow worker in-game tick: open games a fixed number of minutes into play are read once, with the window set aside, at their size, and written beside the open; too early or too late is not read; structural refusals are final; an unreachable venue is retried; the read is the operator's", async () => {
  const scanLedger = process.env.EVENT_SHADOW_LEDGER_PATH!;
  const lockLedger = process.env.EVENT_SHADOW_LOCK_LEDGER_PATH!;
  const m = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
  // the open-time terms, written days before the start as the record does
  const live = quoteCrossWrap({ pair: pmPair("M", m(600)), markCents: 60, entryCents: 55, contracts: 150, now: new Date(), noBook: PM_NO_BOOK, config: CFG });
  assert.ok(live.ok, JSON.stringify(live));
  const opened = { at: m(-600) };
  // M: 25 minutes in, due. N: 5 minutes in, not yet. O: 70 minutes in, past the late margin, never. P: due, the engine refuses structurally (the market closed on the result).
  // Q: due, the venues down once. R: crypto, never. S: a holder's lock, 30 minutes in, due. T: 40 minutes out, not started.
  // U: due by the record's start, but the pairing says the start was pushed back: asked again, nothing written.
  appendShadowRecord(scanLedger, openRecord("M", m(-25), live, opened));
  appendShadowRecord(scanLedger, openRecord("N", m(-5), live, opened));
  appendShadowRecord(scanLedger, openRecord("O", m(-70), live, opened));
  appendShadowRecord(scanLedger, openRecord("P", m(-30), live, opened));
  appendShadowRecord(scanLedger, openRecord("Q", m(-35), live, opened));
  appendShadowRecord(scanLedger, { ...openRecord("R", m(-25), live, opened), kind: "crypto", league: "crypto", route: "kalshi_self" });
  appendShadowRecord(lockLedger, openRecord("S", m(-30), live, { ...opened, source: "lock", entryCents: 52, contracts: 20 }));
  appendShadowRecord(scanLedger, openRecord("T", m(40), live, opened));
  appendShadowRecord(scanLedger, openRecord("U", m(-22), live, opened));

  const worker = await import("../scripts/eventShadowWorker");
  const seen: OneQuoteInputs[] = [];
  let qDown = true;
  worker.wireLockEngine({
    listGameMarkets: async () => [],
    quoteOne: async (inputs: OneQuoteInputs): Promise<OneQuoteResult> => {
      seen.push(inputs);
      if (inputs.ticker === "P") return { ok: false, code: "market_not_active", detail: "closed" };
      if (inputs.ticker === "U") return { ok: false, code: "not_started", detail: "delayed" };
      if (inputs.ticker === "Q" && qDown) throw new Error("venue unreachable");
      const start = inputs.ticker === "S" ? m(-30) : m(-25);
      const pair = pmPair(inputs.ticker, start);
      // the engine's own quote refuses in play (the lead-time gate); the books it read still come back, which is what the shadow re-prices from
      const refused: CrossQuoteResult = { ok: false, code: "market_too_close_to_start", detail: "the game starts in 0m; pre-game protection needs at least 10m" };
      return { ok: true, result: { ...candidate(inputs.ticker, start, {}, inPlayConfig(DEFAULT_CROSS_CONFIG)), markCents: 66, market: { ...pair.kalshi, yesBidCents: 63, yesAskCents: 69 }, quote: refused, route: null, evBps: null } };
    },
  });

  await worker.inGameTick();
  assert.deepEqual(seen.map((s) => s.ticker).sort(), ["M", "P", "Q", "S", "U"], "only open games inside their in-game minute, on both ledgers");
  assert.ok(seen.every((s) => s.inGame === true), "every ask has the window set aside");
  assert.equal(seen.find((s) => s.ticker === "S")?.contracts, 20, "at the holder's size");
  assert.equal(seen.find((s) => s.ticker === "S")?.entryCents, 52, "and their entry");

  const scan1 = new Map(loadShadowPositions(scanLedger).map((p) => [p.ticker, p]));
  const mRead = scan1.get("M")?.inGame;
  assert.ok(mRead && !("unread" in mRead), "M has its read");
  assert.ok(mRead.minutesIn >= 25 && mRead.minutesIn <= 25.5, `minutes in ${mRead.minutesIn}`);
  assert.ok(mRead.hoursToLock <= -0.4 && mRead.hoursToLock >= -0.5, `hours to lock ${mRead.hoursToLock}`);
  assert.equal(mRead.markCents, 66);
  assert.deepEqual(mRead.protectedBook, { yesBidCents: 63, yesAskCents: 69 });
  assert.ok(mRead.routes.polymarket.ok && mRead.routes.kalshi_self.ok);
  assert.equal(mRead.references?.length, 2);
  assert.equal(scan1.get("M")?.prelock, undefined, "the in-game read is its own phase");
  assert.equal(scan1.get("N")?.inGame, undefined, "too early");
  assert.equal(scan1.get("O")?.inGame, undefined, "too late: the read is of its minute or not at all");
  const pRead = scan1.get("P")?.inGame;
  assert.ok(pRead && "unread" in pRead && pRead.unread === "market_not_active");
  assert.equal(scan1.get("Q")?.inGame, undefined, "the unreachable one is not written");
  assert.equal(scan1.get("R")?.inGame, undefined);
  assert.equal(scan1.get("T")?.inGame, undefined);
  assert.equal(scan1.get("U")?.inGame, undefined, "a start pushed back is not an unread");
  const sRead = loadShadowPositions(lockLedger).find((p) => p.ticker === "S")?.inGame;
  assert.ok(sRead && !("unread" in sRead), "the lock ledger got its own line");

  // next tick: Q's venue is back; M, P and S are not asked again
  qDown = false;
  seen.length = 0;
  await worker.inGameTick();
  assert.deepEqual(seen.map((s) => s.ticker).sort(), ["Q", "U"]);
  assert.ok(loadShadowPositions(scanLedger).find((p) => p.ticker === "Q")?.inGame);
  seen.length = 0;
  await worker.inGameTick();
  assert.deepEqual(seen.map((s) => s.ticker), ["U"], "only the delayed start is still asked");
  // the pre-lock tick leaves games in play alone
  await worker.rereadTick();
  assert.ok(!seen.some((s) => ["M", "P", "Q", "S", "O"].includes(s.ticker)), "nothing in play is read for the pre-lock");

  await new Promise<void>((r) => worker.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
  try {
    const v = (await (await fetch(`${base}/api/shadow/venues?token=op-secret`)).json()) as {
      inGame: { read: number; unread: number; avgMinutesIn: number | null; avgSpreadCents: number | null };
      totals: Array<{ id: string; inGame: { read: number; quoted: number } }>;
      rows: Array<{ ticker: string; inGame?: { minutesIn: number; unread: string | null; protectedBook: { yesBidCents: number; yesAskCents: number } | null; cells: Array<{ id: string; creditCents: number | null }> } }>;
    };
    assert.equal(v.inGame.read, 3, "M, Q and S");
    assert.equal(v.inGame.unread, 1, "P");
    assert.equal(v.inGame.avgSpreadCents, 6);
    const rowM = v.rows.find((r) => r.ticker === "M");
    assert.ok(rowM?.inGame && rowM.inGame.unread === null);
    assert.deepEqual(rowM.inGame.protectedBook, { yesBidCents: 63, yesAskCents: 69 });
    assert.ok(rowM.inGame.cells.find((x) => x.id === "aggregated_mm")?.creditCents);
    assert.equal(v.totals.find((t) => t.id === "aggregated_mm")!.inGame.quoted, 3);
    const html = await (await fetch(`${base}/venues?token=op-secret`)).text();
    assert.match(html, /By venue, in play/);
    assert.match(html, /in play T\+25(\.\d)?m/);
    assert.match(html, /\(63\/69\)/);
    assert.match(html, /priced again in play/);
    assert.match(html, /market closed/);
    const csv = await (await fetch(`${base}/api/shadow/venues.csv?token=op-secret`)).text();
    assert.ok(csv.split("\n").some((l) => l.startsWith("M,") && l.includes(",in_game,")));
    const health = (await (await fetch(`${base}/healthz?token=op-secret`)).json()) as { inGame: { minutes: number; lateMinutes: number; dueLastTick: number; writtenLastTick: number; lastError: string | null } };
    assert.equal(health.inGame.minutes, 20);
    assert.equal(health.inGame.lateMinutes, 30);
    assert.equal(health.inGame.lastError, null);
    const publicHealth = JSON.stringify(await (await fetch(`${base}/healthz`)).json());
    assert.ok(!publicHealth.includes("inGame"));
    const pub = JSON.stringify(await (await fetch(`${base}/api/shadow`)).json());
    assert.ok(!pub.includes("inGame") && !pub.includes("protectedBook") && !pub.includes("minutesIn"), "the public record never carries the in-game read");
  } finally {
    await new Promise<void>((r) => worker.server.close(() => r()));
  }
});
