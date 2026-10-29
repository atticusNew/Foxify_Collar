/**
 * Leave early through the lock routes: the holder's open lock priced into the live books
 * (GET /api/shadow/unwind/quote), then written as a close with source "unwind" (POST
 * /api/shadow/unwind). The books come through the test seam; the pricer is earlyClose.ts.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EarlyCloseBooks } from "../src/eventCollar/crossVenue/earlyClose";
import { quoteLadderWrap, type NoAskLevel } from "../src/eventCollar/crossVenue/kalshiLadder";
import { appendShadowRecord, loadShadowPositions, type ShadowCloseRecord } from "../src/eventCollar/crossVenue/shadowLedger";
import { DEFAULT_CROSS_CONFIG, capTotalCents, floorTotalCents, type CrossQuoteResult } from "../src/eventCollar/crossVenue/types";
import type { CandidateResult, GameMarketRow, OneQuoteInputs, OneQuoteResult } from "../scripts/eventProtectXDemoService";

const TICKER = "KXNBAGAME-26OCT14LALBOS-BOS";
const SOON = "KXNBAGAME-26OCT14NYKMIA-NYK";
const START = new Date(Date.now() + 3 * 3_600_000).toISOString();
/** inside the early-close margin (15 minutes before the start by default) */
const START_SOON = new Date(Date.now() + 10 * 60_000).toISOString();
const NO_ASKS: NoAskLevel[] = [
  { priceCents: 41, qtyMilli: 300_000 },
  { priceCents: 42, qtyMilli: 400_000 },
];

function candidate(ticker: string, startIso: string, contracts: number, entryCents: number): CandidateResult {
  const quote: CrossQuoteResult = quoteLadderWrap({
    pair: { kalshi: { ticker }, gameStartTime: startIso },
    markCents: 60,
    entryCents,
    contracts,
    now: new Date(),
    noAsks: NO_ASKS,
    config: DEFAULT_CROSS_CONFIG,
  });
  assert.ok(quote.ok, JSON.stringify(quote));
  return {
    kind: "sports",
    league: "nba",
    market: { ticker, eventTicker: ticker.slice(0, ticker.lastIndexOf("-")), title: "Winner?", subtitle: "", strike: 0, strikeType: "", status: "active", openTime: "", closeTime: startIso, yesBidCents: 59, yesAskCents: 61, lastPriceCents: 60, volume: 1000, openInterest: 1000, rulesPrimary: "" },
    pair: null,
    sideName: "Boston Celtics",
    eventTitle: "Lakers at Celtics",
    eventTimeIso: startIso,
    parityNote: "",
    fingerprint: `test:${ticker}`,
    markCents: 60,
    position: { contracts, entryCents, entrySource: "entered_now", entryTime: null },
    quote,
    route: "kalshi_self",
    evBps: quote.evCostBps,
    routesChecked: [],
    books: { noAsks: NO_ASKS },
  };
}

test("shadow worker unwind routes: a lock is priced into the live books, then closed with source=unwind; refusals before, after, and inside the margin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-unwind-"));
  const ledger = join(dir, "lock-ledger.jsonl");
  process.env.NODE_ENV = "test";
  process.env.EVENT_SHADOW_LEDGER_PATH = join(dir, "ledger.jsonl");
  process.env.EVENT_SHADOW_LOCK_LEDGER_PATH = ledger;
  process.env.EVENT_LASTLEG_LEDGER_PATH = join(dir, "lastleg.jsonl");
  process.env.EVENT_X_ADMIN_TOKEN = "op-secret";
  process.env.EVENT_SHADOW_LOCK_KEY = "lock-key-0123456789";
  delete process.env.EVENT_HEDGE_STRATEGY;
  const worker = await import("../scripts/eventShadowWorker");
  // the books the seam answers with; the test moves them between calls
  let books: EarlyCloseBooks = {
    kalshi: { yesBids: [{ priceCents: 62, qtyMilli: 1_000_000 }], noBids: [{ priceCents: 38, qtyMilli: 1_000_000 }] },
  };
  const booksAsked: string[] = [];
  const markets: GameMarketRow[] = [
    { ticker: TICKER, league: "nba", sideName: "Boston Celtics", title: "Winner?", dateIso: "2026-10-14", closeTimeIso: START, markCents: 60, startIso: START, protectable: true, protectableUntilIso: START },
    { ticker: SOON, league: "nba", sideName: "New York Knicks", title: "Winner?", dateIso: "2026-10-14", closeTimeIso: START_SOON, markCents: 60, startIso: START_SOON, protectable: true, protectableUntilIso: START_SOON },
  ];
  worker.wireLockEngine({
    listGameMarkets: async () => markets,
    quoteOne: async (inputs: OneQuoteInputs): Promise<OneQuoteResult> => ({ ok: true, result: candidate(inputs.ticker, inputs.ticker === SOON ? START_SOON : START, inputs.contracts, inputs.entryCents ?? 60) }),
    closeBooks: async (p) => {
      booksAsked.push(p.ticker);
      return books;
    },
  });
  await new Promise<void>((r) => worker.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
  const key = { "x-lock-key": "lock-key-0123456789" };
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { ...key, "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(`${base}/api/shadow/unwind/quote?ticker=${TICKER}`)).status, 403, "the key gates the quote");
    assert.equal((await fetch(`${base}/api/shadow/unwind`, { method: "POST" })).status, 403, "and the unwind");
    assert.equal((await fetch(`${base}/api/shadow/unwind/quote?ticker=${TICKER}`, { headers: key })).status, 404, "nothing locked yet");
    assert.equal((await fetch(`${base}/api/shadow/unwind`, { headers: key })).status, 405, "GET closes nothing");
    assert.equal((await post("/api/shadow/unwind", {})).status, 400, "ticker names the lock");

    // 15.95 contracts at 60c, the fractional lock
    const lock = (await (await post("/api/shadow/lock", { ticker: TICKER, contracts: 15.95, entryCents: 60 })).json()) as { ok: boolean; contracts: number; floorCents: number; capCents: number; creditCents: number };
    assert.ok(lock.ok, JSON.stringify(lock));
    assert.equal(lock.contracts, 15.95);
    const [open] = loadShadowPositions(ledger);
    assert.equal(open.status, "open");

    // the quote: both legs into the books, nothing written
    const q = (await (await fetch(`${base}/api/shadow/unwind/quote?ticker=${TICKER.toLowerCase()}`, { headers: key })).json()) as {
      ok: boolean;
      lastIso: string;
      unwind: { contracts: number; yesFillCents: number; positionProceedsCents: number; hedgeProceedsCents: number; fundingCents: number; closeNetCents: number; creditCents: number; protectedAtCloseCents: number; nakedAtCloseCents: number; protectedAtMidCents: number; unwindFrictionCents: number; stayFloorCents: number; stayCapCents: number };
    };
    assert.ok(q.ok, JSON.stringify(q));
    assert.deepEqual(booksAsked, [TICKER]);
    const u = q.unwind;
    assert.equal(u.contracts, 15.95);
    assert.equal(u.yesFillCents, 62);
    assert.equal(u.nakedAtCloseCents, u.positionProceedsCents, "leaving with no protection is the same sale");
    assert.equal(u.closeNetCents, u.hedgeProceedsCents - u.fundingCents);
    assert.equal(u.protectedAtCloseCents, u.positionProceedsCents + u.closeNetCents + u.creditCents, "own sale + what moves between us + the credit");
    assert.equal(u.stayFloorCents, floorTotalCents(open));
    assert.equal(u.stayCapCents, capTotalCents(open));
    assert.ok(u.protectedAtCloseCents > u.stayFloorCents && u.protectedAtCloseCents < u.stayCapCents, "at a 62c mid the holder leaves between the floor and the cap");
    assert.ok(u.unwindFrictionCents > 0, "crossing both books costs something against the mid");
    assert.equal(Date.parse(q.lastIso), Date.parse(START) - 15 * 60_000);
    assert.equal(readFileSync(ledger, "utf8").trim().split("\n").length, 1, "a quote writes nothing");

    // a thin book: the quote refuses; the tap records the attempt and closes nothing
    books = { kalshi: { yesBids: [{ priceCents: 62, qtyMilli: 5_000 }], noBids: [{ priceCents: 38, qtyMilli: 1_000_000 }] } };
    const thinQ = (await (await fetch(`${base}/api/shadow/unwind/quote?ticker=${TICKER}`, { headers: key })).json()) as { ok: boolean; code: string; leg: string };
    assert.deepEqual([thinQ.ok, thinQ.code, thinQ.leg], [false, "book_too_thin", "position"]);
    const thinTap = (await (await post("/api/shadow/unwind", { ticker: TICKER })).json()) as { ok: boolean; code: string; message: string };
    assert.equal(thinTap.ok, false);
    assert.equal(thinTap.code, "book_too_thin");
    assert.match(thinTap.message, /Nothing was closed/);
    let lines = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(lines.length, 2);
    assert.deepEqual([lines[1].type, lines[1].priced, lines[1].source], ["close", false, "unwind"]);
    assert.equal(loadShadowPositions(ledger)[0].status, "open", "the position runs on");

    // the books are back: the tap closes it
    books = { kalshi: { yesBids: [{ priceCents: 61, qtyMilli: 1_000_000 }], noBids: [{ priceCents: 38, qtyMilli: 1_000_000 }] } };
    const done = (await (await post("/api/shadow/unwind", { ticker: TICKER })).json()) as {
      ok: boolean;
      status: string;
      unwind: { yesFillCents: number; protectedAtCloseCents: number; closeNetCents: number; creditCents: number; positionProceedsCents: number };
      hedge: { sent: boolean; note: string; sale?: { action: string; simulated: boolean; via: string; unitsMilli: number } };
      cash: Array<{ leg: string; to: string; dueCents: number }>;
    };
    assert.ok(done.ok, JSON.stringify(done));
    assert.equal(done.status, "closed");
    assert.equal(done.unwind.yesFillCents, 61, "priced again at the tap, not from the quote the holder read");
    assert.equal(done.hedge.sent, false, "the book executor simulates: the hedge sale is on the record, not at the venue");
    assert.match(done.hedge.note, /recorded at the book's price and not sent \(.*\); the operator sells it by hand$/);
    assert.deepEqual([done.hedge.sale?.action, done.hedge.sale?.simulated, done.hedge.sale?.via, done.hedge.sale?.unitsMilli], ["sell", true, "book", open.hedgeUnitsMilli], "the sale's receipt is on the trail all the same");
    const closeLeg = done.cash.find((c) => c.leg === "close");
    assert.ok(closeLeg, "the close leg is owed");
    assert.equal(closeLeg.dueCents, Math.abs(done.unwind.closeNetCents));
    assert.equal(closeLeg.to, done.unwind.closeNetCents > 0 ? "holder" : "writer");
    lines = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(lines.length, 3);
    const rec = lines[2] as unknown as ShadowCloseRecord;
    assert.deepEqual([rec.type, rec.priced, rec.source, rec.hedgeSent, rec.yesFillCents, rec.protectedAtCloseCents], ["close", true, "unwind", false, 61, done.unwind.protectedAtCloseCents]);
    const [closed] = loadShadowPositions(ledger);
    assert.equal(closed.status, "closed");
    assert.equal(closed.closeSource, "unwind");
    assert.equal(closed.closeHedgeSent, false);
    assert.equal(closed.protectedCents, done.unwind.protectedAtCloseCents);
    assert.equal(closed.nakedCents, done.unwind.positionProceedsCents);

    // the receipt carries the close; a second leave is refused, so is a second quote
    const rcpt = (await (await fetch(`${base}/api/shadow/receipt?ticker=${TICKER}`, { headers: key })).json()) as {
      lock: { status: string; closedAt: string; protectedCents: number; closeNetCents: number; closeYesFillCents: number; closeSource: string; closeHedgeSent: boolean; eventTimeIso: string };
      hedge: { action: string };
      hedgeSale: { action: string; simulated: boolean } | null;
      cash: Array<{ leg: string }>;
    };
    assert.equal(rcpt.lock.status, "closed");
    assert.equal(rcpt.hedge.action, "buy");
    assert.deepEqual([rcpt.hedgeSale?.action, rcpt.hedgeSale?.simulated], ["sell", true], "the receipt carries the sale beside the buy");
    assert.equal(rcpt.lock.closedAt, rec.at);
    assert.equal(rcpt.lock.closeYesFillCents, 61);
    assert.equal(rcpt.lock.closeSource, "unwind");
    assert.equal(rcpt.lock.closeHedgeSent, false);
    assert.equal(rcpt.lock.closeNetCents, done.unwind.closeNetCents);
    assert.equal(rcpt.lock.eventTimeIso, START);
    assert.deepEqual(rcpt.cash.map((c) => c.leg), ["credit", ...(done.unwind.closeNetCents === 0 ? [] : ["close"])]);
    const again = await post("/api/shadow/unwind", { ticker: TICKER });
    assert.equal(again.status, 409);
    assert.equal(((await again.json()) as { error: string }).error, "not_open");
    assert.equal((await fetch(`${base}/api/shadow/unwind/quote?ticker=${TICKER}`, { headers: key })).status, 409);
    assert.equal(readFileSync(ledger, "utf8").trim().split("\n").length, 3, "a refused leave writes nothing");

    // the protection removed, the market is this holder's to lock again: the markets list offers it, the quote
    // says it is not on record, the lock writes a second generation; the first stays on the record, closed
    const marketsAfter = (await (await fetch(`${base}/api/shadow/markets`, { headers: key })).json()) as { markets: Array<{ ticker: string; onRecord: boolean; protectable: boolean }> };
    const offered = marketsAfter.markets.find((m) => m.ticker === TICKER);
    assert.deepEqual([offered?.onRecord, offered?.protectable], [false, true], "a market left early is offered again");
    const requote = (await (await fetch(`${base}/api/shadow/quote?ticker=${TICKER}&contracts=8&entryCents=61`, { headers: key })).json()) as { ok: boolean; onRecord: boolean };
    assert.deepEqual([requote.ok, requote.onRecord], [true, false]);
    const relock = (await (await post("/api/shadow/lock", { ticker: TICKER, contracts: 8, entryCents: 61 })).json()) as { ok: boolean; contracts: number; status?: string };
    assert.ok(relock.ok, JSON.stringify(relock));
    assert.equal(relock.contracts, 8);
    const gens = loadShadowPositions(ledger);
    assert.deepEqual(gens.map((p) => [p.status, p.contracts, p.generation]), [["open", 8, 2], ["closed", 15.95, undefined]], "the new lock first, the removed one behind it");
    const rcpt2 = (await (await fetch(`${base}/api/shadow/receipt?ticker=${TICKER}`, { headers: key })).json()) as { lock: { status: string; contracts: number; generation?: number }; hedge: { action: string; at: string } };
    assert.deepEqual([rcpt2.lock.status, rcpt2.lock.contracts, rcpt2.lock.generation], ["open", 8, 2], "the receipt is the current lock's");
    assert.equal(rcpt2.hedge.action, "buy");
    assert.ok(rcpt2.hedge.at >= rec.at, "the receipt's hedge is the new lock's, not the removed one's");
    assert.equal(((await post("/api/shadow/lock", { ticker: TICKER, contracts: 8, entryCents: 61 })).status), 409, "one open lock per market still");
    // the second lock can leave too; both generations then sit closed on the record and the market is open to a third
    const leftAgain = (await (await post("/api/shadow/unwind", { ticker: TICKER })).json()) as { ok: boolean; status: string };
    assert.deepEqual([leftAgain.ok, leftAgain.status], [true, "closed"]);
    assert.deepEqual(loadShadowPositions(ledger).map((p) => [p.status, p.generation ?? 1]), [["closed", 2], ["closed", 1]]);
    assert.equal(((await (await fetch(`${base}/api/shadow/markets`, { headers: key })).json()) as { markets: Array<{ ticker: string; protectable: boolean }> }).markets.find((m) => m.ticker === TICKER)?.protectable, true);

    // inside the margin before the start (a lock written three hours ago, the start ten minutes out): too late
    // to leave, the protection runs to settlement
    const { status: _s, ...openRec } = open;
    appendShadowRecord(ledger, { ...openRec, type: "open", ticker: SOON, at: new Date(Date.now() - 3 * 3_600_000).toISOString(), eventTimeIso: START_SOON, contracts: 4 });
    assert.equal(loadShadowPositions(ledger).find((p) => p.ticker === SOON)?.status, "open");
    const late = await fetch(`${base}/api/shadow/unwind/quote?ticker=${SOON}`, { headers: key });
    assert.equal(late.status, 409);
    const lateBody = (await late.json()) as { error: string; lastIso: string };
    assert.equal(lateBody.error, "too_late");
    assert.equal(Date.parse(lateBody.lastIso), Date.parse(START_SOON) - 15 * 60_000);
    assert.equal((await post("/api/shadow/unwind", { ticker: SOON })).status, 409);
    assert.deepEqual(booksAsked, [TICKER, TICKER, TICKER, TICKER, TICKER], "no book is read for a refusal (the fifth read is the second generation's leave)");
  } finally {
    await new Promise<void>((r) => worker.server.close(() => r()));
  }
});
