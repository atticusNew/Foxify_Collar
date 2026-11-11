/**
 * The realized book: our own real fills, replayed from the lock ledgers, the hedge trail and the
 * pending trail. Every line in the fixtures is written by the code that writes it in the service
 * (appendShadowRecord, the executors through appendHedgeReceipt, appendPending); the two old-shape
 * lines are copied as the trail wrote them before the fee was kept. Nothing touches a venue.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BookHedgeExecutor,
  RfqHedgeExecutor,
  appendHedgeReceipt,
  intentFromHedge,
  loadHedgeReceipts,
  sellIntentForKalshi,
  sellIntentForProphetX,
  type ExecutorClock,
  type HedgeIntent,
  type HedgeReceipt,
  type RfqClient,
} from "../src/eventCollar/crossVenue/hedgeExecutor";
import { appendPending, loadPending, pendingRecordFor } from "../src/eventCollar/crossVenue/hedgeFirst";
import { LiveHedgeExecutor, type LiveHedgeRails, type LiveOrderHook, type LiveOrderResult } from "../src/eventCollar/crossVenue/liveHedge";
import { buyCostCents, gainFeeCents, prophetxFillMoney, sumProphetXFills } from "../src/eventCollar/crossVenue/prophetxOrders";
import {
  REALIZED_MONTHLY_CSV_COLUMNS,
  buildRealizedBook,
  classifyReceipt,
  publicRealSummary,
  realizedMonthlyCsv,
  unitsDecimal,
  type RealizedBook,
  type RealizedBookInput,
} from "../src/eventCollar/crossVenue/realizedBook";
import { appendShadowRecord, loadShadowPositions, summarizeShadow, type ShadowOpenRecord } from "../src/eventCollar/crossVenue/shadowLedger";
import { renderShadowHtml } from "../scripts/eventShadowHtml";

const T = "KXNBAGAME-26NOV03BOSLAL-BOS";
const T2 = "KXNBAGAME-26NOV03BOSLAL-LAL";

function fakeClock(iso: string): ExecutorClock & { set(iso: string): void } {
  let ms = Date.parse(iso);
  return {
    now: () => new Date(ms),
    sleep: async (d: number) => {
      ms += d;
    },
    set: (next: string) => {
      ms = Date.parse(next);
    },
  };
}

const RAILS: LiveHedgeRails = { killSwitch: false, dryRun: false, allowlist: [], anyTicker: true, maxUnitsPerOrderMilli: 500_000, maxUnitsPerDayMilli: 5_000_000 };

/** 20 contracts, floor 40, cap 80: the hedge is (40 + 100 - 80) x 20 = 12 units; quoted 306c all in, take 10c, so the credit is 400 - 306 - 10 = 84c. */
const openLock = (over: Partial<ShadowOpenRecord> = {}): ShadowOpenRecord => ({
  type: "open",
  at: "2026-11-03T18:00:00.000Z",
  ticker: T,
  kind: "sports",
  league: "nba",
  sideName: "Boston Celtics",
  eventTitle: "Boston wins",
  eventTimeIso: "2026-11-04T00:30:00.000Z",
  contracts: 20,
  markCents: 60,
  floorCents: 40,
  capCents: 80,
  creditCents: 84,
  evCostBps: 250,
  route: "kalshi_self",
  feesCents: 6,
  takeCents: 10,
  hedgeCostCents: 306,
  hedgeUnitsMilli: 12_000,
  tier: "balanced",
  source: "lock",
  entryCents: 58,
  ...over,
});

const kalshiBuy = (ticker = T): HedgeIntent =>
  intentFromHedge({ action: "buy", venue: "kalshi", outcome: "No", ticker, contractsMilli: 12_000, avgPriceCents: 25, worstPriceCents: 26, costCents: 306 }, 250);

const filled =
  (over: Partial<LiveOrderResult> = {}): LiveOrderHook =>
  async (intent) => ({ orderId: "ord-1", unitsMilli: intent.unitsMilli, avgPriceMilli: 250, costCents: 300, feesCents: 5, status: "executed", ...over });

/** One working directory of ledgers, written line by line the way the service writes them, then replayed. */
function ledgers() {
  const dir = mkdtempSync(join(tmpdir(), "realized-book-"));
  const receipts = join(dir, "hedge-receipts.jsonl");
  const pending = join(dir, "lock-pending.jsonl");
  const lockPath = (holder: string | null): string => join(dir, holder ? `lock-ledger-${holder}.jsonl` : "lock-ledger.jsonl");
  const clock = fakeClock("2026-11-03T18:00:01.000Z");
  return {
    dir,
    clock,
    receipts,
    pending,
    lockPath,
    /** send an order through the real live executor with a scripted venue answer and keep the receipt */
    async live(intent: HedgeIntent, ref: string, at: string, hook: LiveOrderHook): Promise<HedgeReceipt> {
      clock.set(at);
      const r = await new LiveHedgeExecutor({ kalshi: hook, prophetx: hook, novig: hook }, RAILS, () => 0, clock).execute(intent, ref);
      appendHedgeReceipt(receipts, r);
      return r;
    },
    async paper(intent: HedgeIntent, ref: string, at: string): Promise<HedgeReceipt> {
      clock.set(at);
      const r = await new BookHedgeExecutor(null, clock).execute(intent, ref);
      appendHedgeReceipt(receipts, r);
      return r;
    },
    input(): RealizedBookInput {
      const locks = readdirSync(dir)
        .filter((n) => /^lock-ledger(-[a-z0-9_-]+)?\.jsonl$/.test(n))
        .flatMap((n) => {
          const holder = /^lock-ledger-([a-z0-9_-]+)\.jsonl$/.exec(n)?.[1] ?? null;
          return loadShadowPositions(join(dir, n)).map((p) => ({ p, holder }));
        });
      return { receipts: loadHedgeReceipts(receipts), pending: loadPending(pending), locks };
    },
    book(): RealizedBook {
      return buildRealizedBook(this.input());
    },
  };
}

/** Every number under a money or unit key is a whole number: no float ever reaches the book. */
function assertWholeMoney(v: unknown, path = "book"): void {
  if (Array.isArray(v)) return v.forEach((x, i) => assertWholeMoney(x, `${path}[${i}]`));
  if (!v || typeof v !== "object") return;
  for (const [k, x] of Object.entries(v)) {
    if (typeof x === "number" && /(Cents|Milli)$/.test(k)) assert.ok(Number.isInteger(x), `${path}.${k} = ${x} is not a whole number`);
    else assertWholeMoney(x, `${path}.${k}`);
  }
}

test("what marks a fill real: the executors' own lines, one of each kind", async () => {
  const L = ledgers();
  const real = await L.live(kalshiBuy(), T, "2026-11-03T18:00:01.000Z", filled());
  assert.deepEqual(classifyReceipt(real), { kind: "real", basis: "venue_read" });
  assert.equal(real.fill?.feesCents, 5, "the venue's fee rides on the line from now on");

  const paper = await L.paper(kalshiBuy(), T, "2026-11-03T18:00:02.000Z");
  assert.deepEqual(classifyReceipt(paper), { kind: "paper" });
  assert.equal(paper.fill?.feesCents, undefined, "a paper fill carries no venue fee");

  // dry run and a rail refusal fall back to the walked book: paper, and not listed
  L.clock.set("2026-11-03T18:00:03.000Z");
  const dry = await new LiveHedgeExecutor({ kalshi: filled() }, { ...RAILS, dryRun: true }, () => 0, L.clock).execute(kalshiBuy(), T);
  const held = await new LiveHedgeExecutor({ kalshi: filled() }, { ...RAILS, killSwitch: true }, () => 0, L.clock).execute(kalshiBuy(), T);
  assert.deepEqual([classifyReceipt(dry).kind, classifyReceipt(held).kind], ["paper", "paper"]);

  // the venue read the order to its end with nothing matched: nothing was bought, nothing to list
  const miss = await L.live(kalshiBuy(), T, "2026-11-03T18:00:04.000Z", async () => {
    throw new Error("kalshi orders: order ord-9 canceled with nothing filled at or under 26c");
  });
  assert.deepEqual(classifyReceipt(miss), { kind: "paper" });

  // the order went out and the answer was an error: the line's fill is the paper fallback, the venue may hold a real one
  const lost = await L.live(kalshiBuy(), T, "2026-11-03T18:00:05.000Z", async () => {
    throw new Error("kalshi orders: HTTP 504 POST /portfolio/events/orders");
  });
  assert.equal(lost.fill?.simulated, true);
  const c = classifyReceipt(lost);
  assert.equal(c.kind, "not_counted");
  assert.equal(c.kind === "not_counted" ? c.code : "", "order_unconfirmed");

  // an accepted quote is a real execution, costed at the quote: counted, and flagged as not the venue's read
  const client: RfqClient = {
    venue: "kalshi",
    canExecute: () => true,
    request: async () => ({ rfqId: "rfq-1" }),
    bestQuote: async () => ({ quoteId: "q-1", priceMilli: 240, unitsMilli: 12_000 }),
    accept: async () => ({ orderId: "ord-rfq" }),
    cancel: async () => undefined,
  };
  const rfq = await new RfqHedgeExecutor({ kalshi: client }, null, { waitMs: 1_000, pollMs: 500 }, L.clock).execute(kalshiBuy(), T);
  assert.equal(rfq.outcome, "filled_rfq");
  assert.deepEqual(classifyReceipt(rfq), { kind: "real", basis: "accepted_quote" });
  const refused: RfqClient = { ...client, accept: async () => Promise.reject(new Error("maker did not confirm")) };
  const rfqLost = await new RfqHedgeExecutor({ kalshi: refused }, null, { waitMs: 1_000, pollMs: 500 }, L.clock).execute(kalshiBuy(), T);
  assert.equal(classifyReceipt(rfqLost).kind, "not_counted", "an accept that errored may have executed");

  // lines that cannot be told: no mark, a mark the outcome contradicts, numbers that are not whole
  const noMark = { ...real, fill: { ...real.fill!, simulated: undefined as unknown as boolean } };
  const wrongOutcome: HedgeReceipt = { ...real, outcome: "filled_book" };
  const half: HedgeReceipt = { ...real, fill: { ...real.fill!, costCents: 300.5 } };
  const empty: HedgeReceipt = { ...real, fill: { ...real.fill!, unitsMilli: 0 } };
  const liveNoFill: HedgeReceipt = { ...paper, outcome: "filled_live" };
  const codes = [noMark, wrongOutcome, half, empty, liveNoFill].map((r) => {
    const x = classifyReceipt(r);
    return x.kind === "not_counted" ? x.code : x.kind;
  });
  assert.deepEqual(codes, ["mark_missing", "outcome_mismatch", "bad_numbers", "bad_numbers", "outcome_mismatch"]);

  // the book over this trail: one real fill counted, the unconfirmed order listed, the paper lines nowhere
  const book = L.book();
  assert.equal(book.totals.realFills, 1);
  assert.deepEqual(
    book.notCounted.map((n) => [n.code, n.id, n.clientOrderId]),
    [["order_unconfirmed", lost.id, `atticus-${lost.id}`]],
  );
  assert.equal(book.fills[0].unattachedReason, "no lock on the record for it (never written, or taken off the record by a reset)");
  assert.equal(book.totals.unattachedCostCents, 300, "a real fill with no lock is still money that left");
});

test("a real lock settled either way: our result is the take plus what the fill saved against the walk, to the cent", async () => {
  for (const result of ["no", "yes"] as const) {
    const L = ledgers();
    appendShadowRecord(L.lockPath(null), openLock());
    const r = await L.live(kalshiBuy(), T, "2026-11-03T18:00:01.000Z", filled());
    appendShadowRecord(L.lockPath(null), { type: "cash", at: "2026-11-03T18:05:00.000Z", ticker: T, leg: "credit", cents: 84, method: "venue transfer", ref: "tx-1" });

    const open = L.book();
    assert.equal(open.totals.realLocks, 1);
    assert.deepEqual([open.locks[0].state, open.locks[0].realizedCents, open.locks[0].costAtRiskCents, open.totals.openCostCents], ["open", null, 300, 300]);
    assert.equal(open.fills[0].lockKey, open.locks[0].key);

    appendShadowRecord(L.lockPath(null), { type: "settle", at: "2026-11-04T04:00:00.000Z", ticker: T, result });
    const book = L.book();
    const lock = book.locks[0];
    assert.equal(lock.state, "settled");
    assert.deepEqual([lock.venue, lock.via, lock.coverage, lock.boughtUnitsMilli, lock.cashPaidCents, lock.feesCents, lock.feesKnown], ["kalshi", "direct", "exact", 12_000, 300, 5, true]);
    assert.deepEqual(lock.fills, [r.id]);
    // no: the hedge pays 12 x $1 and we owe the floor 40 x 20; yes: the hedge pays nothing and the holder owes the slice above the cap, 20 x 20
    assert.equal(lock.payoutCents, result === "no" ? 1_200 : 0);
    assert.equal(lock.toHolderDueCents, result === "no" ? 84 + 800 : 84);
    assert.equal(lock.fromHolderDueCents, result === "no" ? 0 : 400);
    assert.equal(lock.realizedCents, 16, "take 10 + (306 quoted - 300 paid), whoever won");
    assert.equal(lock.exact, true);
    assert.equal(lock.cashSettled, false, "the settlement leg is owed and not yet on the record");
    assert.equal(book.totals.toHolderOutstandingCents, result === "no" ? 800 : 0);
    assert.equal(book.totals.fromHolderOutstandingCents, result === "no" ? 0 : 400);
    assert.equal(publicRealSummary(book)?.realizedCents, null, "not published while a payment is missing from the record");
    assert.equal(publicRealSummary(book)?.realizedWithheld, "a payment on a settled lock is not yet on the record");

    appendShadowRecord(L.lockPath(null), { type: "cash", at: "2026-11-05T15:00:00.000Z", ticker: T, leg: result === "no" ? "floor" : "handback", cents: result === "no" ? 800 : 400 });
    const paid = L.book();
    assert.equal(paid.locks[0].cashSettled, true);
    assert.deepEqual(
      paid.byDay.map((d) => [d.period, d.fills, d.boughtUnitsMilli, d.cashPaidCents, d.feesCents, d.locksEnded, d.payoutCents, d.paidToHolderCents, d.collectedFromHolderCents, d.realizedCents]),
      [
        ["2026-11-03", 1, 12_000, 300, 5, 0, 0, 84, 0, 0],
        ["2026-11-04", 0, 0, 0, 0, 1, result === "no" ? 1_200 : 0, 0, 0, 16],
        ["2026-11-05", 0, 0, 0, 0, 0, 0, result === "no" ? 800 : 0, result === "no" ? 0 : 400, 0],
      ],
    );
    assert.deepEqual(paid.byDay.map((d) => `${d.venue}/${d.via}`), ["kalshi/direct", "kalshi/direct", "kalshi/direct"]);
    assert.equal(paid.byMonth.length, 1);
    assert.deepEqual(
      [paid.byMonth[0].period, paid.byMonth[0].cashPaidCents, paid.byMonth[0].payoutCents, paid.byMonth[0].realizedCents],
      ["2026-11", 300, result === "no" ? 1_200 : 0, 16],
    );
    // the cash check: money in less money out over the lock's whole life is the same number
    const t = paid.totals;
    assert.equal(t.payoutCents + t.saleProceedsCents + t.collectedFromHolderCents - t.cashPaidCents - t.paidToHolderCents, 16);
    const pub = publicRealSummary(paid);
    assert.deepEqual(pub, {
      realLocks: 1,
      realFills: 1,
      settled: 1,
      leftEarly: 0,
      open: 0,
      unresolved: 0,
      paidForFillsCents: 300,
      receivedFromSalesCents: 0,
      paidToHoldersCents: result === "no" ? 884 : 84,
      collectedFromHoldersCents: result === "no" ? 0 : 400,
      realizedCents: 16,
      realizedWithheld: null,
    });
    assertWholeMoney(paid);
  }
});

test("left early: realized only behind a real sale of the whole hedge; without one the venue still holds it and the lock is unresolved", async () => {
  // the close line as the unwind route writes it: at the tap, then the sale's receipt
  const closeLine = (hedgeProceedsCents: number, hedgeSent: boolean) => ({
    type: "close" as const,
    at: "2026-11-03T20:00:00.000Z",
    ticker: T,
    priced: true,
    source: "unwind" as const,
    hedgeSent,
    yesMidCents: 55,
    yesFillCents: 54,
    positionProceedsCents: 1_070,
    hedgeProceedsCents,
    feesCents: 12,
    // own sale + hedge sale - the cap slice (400) + the credit (84)
    protectedAtCloseCents: 1_070 + hedgeProceedsCents - 400 + 84,
    protectedAtMidCents: 1_100,
    unwindFrictionCents: 20,
  });
  const sale = sellIntentForKalshi({ ticker: T, unitsMilli: 12_000, bestPriceCents: 45, avgPriceCents: 44, worstPriceCents: 43, grossCents: 528 });

  const sold = ledgers();
  appendShadowRecord(sold.lockPath(null), openLock());
  await sold.live(kalshiBuy(), T, "2026-11-03T18:00:01.000Z", filled());
  appendShadowRecord(sold.lockPath(null), closeLine(520, true));
  await sold.live(sale, T, "2026-11-03T20:00:01.000Z", filled({ orderId: "ord-2", avgPriceMilli: 433, costCents: 520, feesCents: 8 }));
  const book = sold.book();
  const lock = book.locks[0];
  assert.equal(lock.state, "closed");
  assert.deepEqual([lock.boughtUnitsMilli, lock.soldUnitsMilli, lock.heldUnitsMilli, lock.saleProceedsCents, lock.feesCents], [12_000, 12_000, 0, 520, 13]);
  // between the parties: the hedge sale 520 less the cap slice 400 goes to the holder, on top of the credit
  assert.deepEqual(lock.holderLegs.map((l) => [l.leg, l.to, l.dueCents]), [["credit", "holder", 84], ["close", "holder", 120]]);
  assert.equal(lock.realizedCents, 520 - 300 - 84 - 120, "the take plus the saving again: 16");
  assert.equal(lock.realizedCents, 16);
  assert.deepEqual([book.totals.closed, book.totals.settled, book.totals.soldUnitsMilli, book.totals.saleProceedsCents], [1, 0, 12_000, 520]);
  assert.deepEqual(book.byDay.map((d) => [d.period, d.fills, d.soldUnitsMilli, d.saleProceedsCents, d.realizedCents]), [["2026-11-03", 2, 12_000, 520, 16]]);
  const pub = publicRealSummary(book);
  assert.deepEqual([pub?.leftEarly, pub?.settled, pub?.paidForFillsCents, pub?.receivedFromSalesCents], [1, 0, 300, 520]);

  // the same close with the sale never sent (the operator sells by hand): the record cannot value what the venue holds
  const unsold = ledgers();
  appendShadowRecord(unsold.lockPath(null), openLock());
  await unsold.live(kalshiBuy(), T, "2026-11-03T18:00:01.000Z", filled());
  appendShadowRecord(unsold.lockPath(null), closeLine(516, false));
  await unsold.paper(sale, T, "2026-11-03T20:00:01.000Z");
  const u = unsold.book();
  assert.deepEqual([u.locks[0].state, u.locks[0].realizedCents, u.locks[0].costAtRiskCents], ["unresolved", null, 300]);
  assert.match(u.locks[0].unresolvedReason ?? "", /no real sale of the hedge is on the trail/);
  assert.deepEqual([u.totals.unresolved, u.totals.unresolvedCostCents, u.totals.realizedCents], [1, 300, 0]);
  assert.equal(publicRealSummary(u)?.realizedWithheld, "no real lock has settled yet");

  // an immediate-or-cancel sale that sold only part
  const part = ledgers();
  appendShadowRecord(part.lockPath(null), openLock());
  await part.live(kalshiBuy(), T, "2026-11-03T18:00:01.000Z", filled());
  appendShadowRecord(part.lockPath(null), closeLine(518, true));
  await part.live(sale, T, "2026-11-03T20:00:01.000Z", filled({ orderId: "ord-2", unitsMilli: 5_000, avgPriceMilli: 430, costCents: 215, feesCents: 3 }));
  const p = part.book();
  assert.equal(p.locks[0].state, "unresolved");
  assert.match(p.locks[0].unresolvedReason ?? "", /7 of 12 units were not sold for real/);

  // a void: no official result, so the hedge's payout is unknown
  const voided = ledgers();
  appendShadowRecord(voided.lockPath(null), openLock());
  await voided.live(kalshiBuy(), T, "2026-11-03T18:00:01.000Z", filled());
  appendShadowRecord(voided.lockPath(null), { type: "void", at: "2026-11-07T00:00:00.000Z", ticker: T, reason: "no official result after 72h" });
  assert.equal(voided.book().locks[0].state, "unresolved");
});

test("the pending trail decides what a fill belongs to: strays have no lock, an open attempt and a lost receipt are listed, not counted", async () => {
  const L = ledgers();
  const terms = { contracts: 20, tier: "balanced", floorCents: 40, capCents: 80, creditCents: 84 };
  const intent: HedgeIntent = { ...kalshiBuy(), allOrNone: true };

  // attempt 1: an immediate-or-cancel order filled 5 of 12; no lock was written; the part bought is a stray
  const p1 = pendingRecordFor(T, T, null, "2026-11-03T17:00:00.000Z", terms, intent);
  appendPending(L.pending, p1);
  const stray = await L.live(intent, T, "2026-11-03T17:00:01.000Z", filled({ orderId: "ord-s", unitsMilli: 5_000, costCents: 126, feesCents: 2 }));
  appendPending(L.pending, { type: "resolved", id: p1.id, at: "2026-11-03T17:00:02.000Z", outcome: "stray", detail: "5 of 12 filled; no lock written", fill: { unitsMilli: 5_000, costCents: 126, orderId: "ord-s", receiptId: stray.id }, receiptId: stray.id });

  // attempt 2, the same market a minute later: the whole hedge filled and the lock was written
  const p2 = pendingRecordFor(T, T, null, "2026-11-03T18:00:00.500Z", terms, intent);
  appendPending(L.pending, p2);
  const whole = await L.live(intent, T, "2026-11-03T18:00:01.000Z", filled());
  appendShadowRecord(L.lockPath(null), openLock());
  appendPending(L.pending, { type: "resolved", id: p2.id, at: "2026-11-03T18:00:02.000Z", outcome: "locked", detail: "the whole hedge filled: 12 for 300c", fill: { unitsMilli: 12_000, costCents: 300, orderId: "ord-1", receiptId: whole.id }, receiptId: whole.id });

  // attempt 3 on another market: the process stopped between the order and its record
  const p3 = pendingRecordFor(T2, T2, null, "2026-11-03T19:00:00.000Z", terms, { ...intent, instrument: T2 });
  appendPending(L.pending, p3);

  // attempt 4: the hedge filled, the lock could not be written, and the receipt line never landed either
  const p4 = pendingRecordFor(`${T2}@ann`, T2, "ann", "2026-11-03T19:30:00.000Z", terms, { ...intent, instrument: T2 });
  appendPending(L.pending, p4);
  appendPending(L.pending, { type: "resolved", id: p4.id, at: "2026-11-03T19:30:02.000Z", outcome: "ledger_failed", detail: "the hedge filled and the lock record could not be written", fill: { unitsMilli: 12_000, costCents: 301, orderId: "ord-x", receiptId: "feedfacefeedface" }, receiptId: "feedfacefeedface" });

  const book = L.book();
  assert.equal(book.totals.realFills, 2);
  assert.equal(book.totals.realLocks, 1);
  assert.deepEqual(book.locks[0].fills, [whole.id], "the stray an hour earlier is not folded into the lock that followed");
  assert.deepEqual(
    book.unattached.map((f) => [f.receiptId, f.unitsMilli, f.cashPaidCents, f.unattachedReason]),
    [[stray.id, 5_000, 126, "no lock was written behind it (5 of 12 filled; no lock written)"]],
  );
  assert.equal(book.totals.unattachedCostCents, 126);
  assert.equal(book.totals.cashPaidCents, 426, "the venue totals carry every real fill, attached or not");
  assert.deepEqual(
    book.notCounted.map((n) => [n.source, n.code, n.ref, n.unitsMilli, n.clientOrderId]),
    [
      ["pending_trail", "pending_unresolved", T2, 12_000, null],
      ["pending_trail", "receipt_missing", `${T2}@ann`, 12_000, "atticus-feedfacefeedface"],
    ],
  );

  // the operator clears the open attempt once checked on the venue: it leaves the list
  appendPending(L.pending, { type: "cleared", id: p3.id, at: "2026-11-03T21:00:00.000Z", note: "nothing on the venue" });
  assert.deepEqual(L.book().notCounted.map((n) => n.code), ["receipt_missing"]);
});

test("generations, holders and a member's own sale: each fill lands on the lock it was sent for", async () => {
  const L = ledgers();
  // the shared ledger: locked, left early behind a real sale, locked again
  appendShadowRecord(L.lockPath(null), openLock());
  const buy1 = await L.live(kalshiBuy(), T, "2026-11-03T18:00:01.000Z", filled());
  appendShadowRecord(L.lockPath(null), {
    type: "close",
    at: "2026-11-03T20:00:00.000Z",
    ticker: T,
    priced: true,
    source: "unwind",
    hedgeSent: true,
    positionProceedsCents: 1_070,
    hedgeProceedsCents: 520,
    feesCents: 12,
    protectedAtCloseCents: 1_274,
  });
  const sell1 = await L.live(sellIntentForKalshi({ ticker: T, unitsMilli: 12_000, bestPriceCents: 45, avgPriceCents: 44, worstPriceCents: 43, grossCents: 528 }), T, "2026-11-03T20:00:01.000Z", filled({ orderId: "ord-2", costCents: 520, avgPriceMilli: 433, feesCents: 8 }));
  appendShadowRecord(L.lockPath(null), openLock({ at: "2026-11-03T21:00:00.000Z" }));
  const buy2 = await L.live(kalshiBuy(), T, "2026-11-03T21:00:01.000Z", filled({ orderId: "ord-3", costCents: 304 }));
  // ann locked the same market in her own ledger; her hedge's ref carries her alias
  appendShadowRecord(L.lockPath("ann"), openLock({ at: "2026-11-03T18:30:00.000Z", holder: "ann" }));
  const annBuy = await L.live(kalshiBuy(), `${T}@ann`, "2026-11-03T18:30:01.000Z", filled({ orderId: "ord-4", costCents: 298 }));
  // bob's lock is a member sale: his own fills in his own account, nothing of ours
  appendShadowRecord(L.lockPath("bob"), openLock({ at: "2026-11-03T18:40:00.000Z", holder: "bob", route: "member_sale", creditCents: 0, takeCents: 0, hedgeCostCents: 0, hedgeUnitsMilli: 0 }));

  const book = L.book();
  const byKey = new Map(book.locks.map((l) => [l.key, l]));
  assert.deepEqual([...byKey.keys()].sort(), [`ann|${T}|1`, `|${T}|1`, `|${T}|2`].sort());
  assert.deepEqual(byKey.get(`|${T}|1`)?.fills, [buy1.id, sell1.id]);
  assert.deepEqual([byKey.get(`|${T}|1`)?.state, byKey.get(`|${T}|1`)?.realizedCents], ["closed", 16]);
  assert.deepEqual(byKey.get(`|${T}|2`)?.fills, [buy2.id]);
  assert.deepEqual([byKey.get(`|${T}|2`)?.state, byKey.get(`|${T}|2`)?.costAtRiskCents], ["open", 304]);
  assert.deepEqual(byKey.get(`ann|${T}|1`)?.fills, [annBuy.id]);
  assert.equal(byKey.get(`ann|${T}|1`)?.holder, "ann");
  assert.deepEqual(book.memberSales, { locks: 1, open: 1, settled: 0, closed: 0 });
  assert.deepEqual([book.totals.realLocks, book.totals.open, book.totals.closed, book.totals.openCostCents, book.totals.unattachedFills], [3, 2, 1, 602, 0]);

  // a lock taken off the record by a reset leaves its fill real and unattached
  const reset = ledgers();
  await reset.live(kalshiBuy(), T, "2026-11-03T18:00:01.000Z", filled());
  const r = reset.book();
  assert.deepEqual([r.totals.realLocks, r.totals.unattachedFills, r.totals.unattachedCostCents], [0, 1, 300]);
  assert.equal(publicRealSummary(r)?.realLocks, 0);
});

test("the hedge sent twice, a part bought, and an accepted quote: counted as what they are and flagged", async () => {
  const L = ledgers();
  appendShadowRecord(L.lockPath(null), openLock());
  await L.live(kalshiBuy(), T, "2026-11-03T18:00:01.000Z", filled());
  // the operator's resend with force: a second real buy on the same lock
  await L.live(kalshiBuy(), T, "2026-11-03T18:10:00.000Z", filled({ orderId: "ord-2", costCents: 302 }));
  appendShadowRecord(L.lockPath(null), { type: "settle", at: "2026-11-04T04:00:00.000Z", ticker: T, result: "no" });
  const lock = L.book().locks[0];
  assert.deepEqual([lock.coverage, lock.boughtUnitsMilli, lock.cashPaidCents, lock.payoutCents], ["over", 24_000, 602, 2_400]);
  assert.equal(lock.realizedCents, 2_400 - 602 - 884, "both hedges paid; the result is what the cash did");
  assert.ok(lock.notes.some((n) => n.includes("2 real buys")));

  const under = ledgers();
  appendShadowRecord(under.lockPath(null), openLock());
  await under.live(kalshiBuy(), T, "2026-11-03T18:00:01.000Z", filled({ unitsMilli: 5_000, costCents: 126, feesCents: 2 }));
  appendShadowRecord(under.lockPath(null), { type: "settle", at: "2026-11-04T04:00:00.000Z", ticker: T, result: "no" });
  const u = under.book().locks[0];
  assert.deepEqual([u.coverage, u.payoutCents, u.realizedCents], ["under", 500, 500 - 126 - 884]);

  const quoted = ledgers();
  appendShadowRecord(quoted.lockPath(null), openLock());
  const client: RfqClient = {
    venue: "kalshi",
    canExecute: () => true,
    request: async () => ({ rfqId: "rfq-1" }),
    bestQuote: async () => ({ quoteId: "q-1", priceMilli: 240, unitsMilli: 12_000 }),
    accept: async () => ({ orderId: "ord-rfq" }),
    cancel: async () => undefined,
  };
  quoted.clock.set("2026-11-03T18:00:01.000Z");
  appendHedgeReceipt(quoted.receipts, await new RfqHedgeExecutor({ kalshi: client }, null, { waitMs: 1_000, pollMs: 500 }, quoted.clock).execute(kalshiBuy(), T));
  appendShadowRecord(quoted.lockPath(null), { type: "settle", at: "2026-11-04T04:00:00.000Z", ticker: T, result: "yes" });
  const q = quoted.book();
  assert.deepEqual([q.fills[0].basis, q.fills[0].costCents, q.fills[0].feesCents, q.fills[0].orderId], ["accepted_quote", 288, null, "ord-rfq"]);
  assert.equal(q.locks[0].exact, false);
  assert.equal(q.totals.fillsWithoutFee, 1);
  assert.equal(publicRealSummary(q)?.realizedWithheld, "a figure in it is not yet the venue's own number");
});

test("ProphetX: the settlement fee is provided for in the cost and charged only on a win; an old line that does not split it is flagged", async () => {
  // 12 shares for a stake of $3.00 at no match fee: the fee on the gain is 2% of (1200 - 300) = 18c
  const sum = sumProphetXFills([{ fillId: "f1", orderId: "px-1", venueFillId: "v1", shares: "12.000000", price: "0.250000", stakeUsd: "3.00", feeUsd: "0", occurredAt: "2026-11-03T18:00:01.000Z" }]);
  assert.deepEqual(sum, { sharesMilli: 12_000, stakeCents: 300, feesCents: 0, avgPriceMicro: 250_000 });
  assert.equal(gainFeeCents(sum, 200), 18);
  const money = prophetxFillMoney(sum, 12_000, false, 200);
  assert.deepEqual(money, { unitsMilli: 12_000, avgPriceMilli: 265, costCents: 318, feesCents: 0, settlementProvisionCents: 18 });
  assert.equal(money.costCents, buyCostCents(sum, 200), "one cost function, used by the order and by the check");
  // the offset of the same hedge: 12 shares of the holder's strike at 0.56; the pair pays 12 x (1 - 0.56) = 528c, less 2% of it
  const offset = sumProphetXFills([{ fillId: "f2", orderId: "px-2", venueFillId: "v2", shares: "12.000000", price: "0.560000", stakeUsd: "6.72", feeUsd: "0", occurredAt: "2026-11-03T20:00:01.000Z" }]);
  assert.deepEqual(prophetxFillMoney(offset, 12_000, true, 200), { unitsMilli: 12_000, avgPriceMilli: 430, costCents: 517, feesCents: 11 });

  const pxLock = openLock({ route: "prophetx", hedgeStrikeId: "strike-no", hedgeOffsetStrikeId: "strike-yes", hedgeCostCents: 320, creditCents: 70 });
  const pxBuy: HedgeIntent = { venue: "prophetx", instrument: "strike-no", offsetInstrument: "strike-yes", armKey: T, outcome: "Los Angeles Lakers", unitsMilli: 12_000, book: { bestPriceMilli: 265, avgPriceMilli: 266, worstPriceMilli: 270, costCents: 320 }, maxCostCents: 320 };
  const hook = filled({ orderId: "px-1", venueOrderId: "v-1", via: "aggregator", ...money });
  for (const result of ["no", "yes"] as const) {
    const L = ledgers();
    appendShadowRecord(L.lockPath(null), pxLock);
    await L.live(pxBuy, T, "2026-11-03T18:00:01.000Z", hook);
    appendShadowRecord(L.lockPath(null), { type: "settle", at: "2026-11-04T04:00:00.000Z", ticker: T, result });
    const book = L.book();
    const f = book.fills[0];
    assert.deepEqual([f.venue, f.via, f.costCents, f.cashPaidCents, f.settlementProvisionCents, f.orderId, f.venueOrderId], ["prophetx", "aggregator", 318, 300, 18, "px-1", "v-1"]);
    const lock = book.locks[0];
    // the hedge won: 1200 less the 18 the venue takes; it lost: nothing comes back and nothing more is charged
    assert.equal(lock.payoutCents, result === "no" ? 1_182 : 0);
    assert.equal(lock.realizedCents, result === "no" ? 1_182 - 300 - 70 - 800 : -300 - 70 + 400);
    assert.equal(lock.exact, true);
    assert.ok(lock.notes.some((n) => n.includes("settles on its own venue's result")));

    // the same line as the trail wrote it before the provision was kept
    const old = loadHedgeReceipts(L.receipts)[0];
    delete old.fill!.settlementProvisionCents;
    delete old.fill!.feesCents;
    const before = buildRealizedBook({ ...L.input(), receipts: [old] });
    assert.deepEqual([before.fills[0].cashPaidCents, before.fills[0].settlementProvisionCents, before.fills[0].feesCents], [318, null, null]);
    assert.equal(before.locks[0].realizedCents, result === "no" ? 1_200 - 318 - 870 : -318 - 70 + 400);
    assert.equal(before.locks[0].exact, result === "no", "a win is the same number either way; a loss is understated by the provision the line does not show");
  }

  // left early on ProphetX: the offset's proceeds land at the game, and the fee is provided for on both sides
  const L = ledgers();
  appendShadowRecord(L.lockPath(null), pxLock);
  await L.live(pxBuy, T, "2026-11-03T18:00:01.000Z", hook);
  appendShadowRecord(L.lockPath(null), { type: "close", at: "2026-11-03T20:00:00.000Z", ticker: T, priced: true, source: "unwind", hedgeSent: true, positionProceedsCents: 1_070, hedgeProceedsCents: 517, feesCents: 12, protectedAtCloseCents: 1_070 + 517 - 400 + 70 });
  const pxSell = sellIntentForProphetX({ strikeId: "strike-no", offsetStrikeId: "strike-yes", armKey: T, unitsMilli: 12_000, bestPriceMilli: 440, avgPriceMilli: 436, worstPriceMilli: 430, grossCents: 523 });
  await L.live(pxSell, T, "2026-11-03T20:00:01.000Z", filled({ orderId: "px-2", via: "aggregator", ...prophetxFillMoney(offset, 12_000, true, 200) }));
  const closed = L.book().locks[0];
  assert.deepEqual([closed.state, closed.realizedCents, closed.exact], ["closed", 517 - 318 - 70 - 117, false]);
  assert.ok(closed.notes.some((n) => n.includes("land when the pair settles at the game")));
});

test("old ledgers replay: lines from before the fee, the provision and the pending trail existed are still real fills", () => {
  const dir = mkdtempSync(join(tmpdir(), "realized-old-"));
  const receipts = join(dir, "hedge-receipts.jsonl");
  const lock = join(dir, "lock-ledger.jsonl");
  // the lock and its hedge exactly as the service wrote them in October: no fee on the fill, no pending trail, no holder files
  appendFileSync(
    lock,
    `${JSON.stringify({ type: "open", at: "2026-10-20T23:00:00.000Z", ticker: T, kind: "sports", league: "nba", sideName: "Boston Celtics", eventTitle: "Boston wins", eventTimeIso: "2026-10-21T00:30:00.000Z", contracts: 20, markCents: 60, floorCents: 40, capCents: 80, creditCents: 84, evCostBps: 250, route: "kalshi_self", feesCents: 6, takeCents: 10, source: "lock" })}\n` +
      "{ this line was torn by a restart\n" +
      `${JSON.stringify({ type: "settle", at: "2026-10-21T04:00:00.000Z", ticker: T, result: "no" })}\n`,
  );
  appendFileSync(
    receipts,
    `${JSON.stringify({
      id: "0123456789abcdef",
      at: "2026-10-20T23:00:01.000Z",
      ref: T,
      intent: { venue: "kalshi", instrument: T, outcome: "No", unitsMilli: 12_000, book: { bestPriceMilli: 250, avgPriceMilli: 250, worstPriceMilli: 260, costCents: 306 }, maxCostCents: 306 },
      attempts: [
        { strategy: "live", step: "rails", ok: true, at: "2026-10-20T23:00:01.000Z", detail: "allowlisted" },
        { strategy: "live", step: "order", ok: true, at: "2026-10-20T23:00:01.400Z", detail: "order ord-old executed: 12 of 12 filled at 250 milli, 300c all in", orderId: "ord-old", unitsMilli: 12_000, costCents: 300 },
      ],
      fill: { strategy: "live", venue: "kalshi", instrument: T, unitsMilli: 12_000, avgPriceMilli: 250, costCents: 300, vsBookCents: 6, simulated: false, ids: { orderId: "ord-old" } },
      outcome: "filled_live",
      fallbackReason: null,
      bookWalkPenaltyCents: 6,
    })}\n` +
      // a paper line of the same month, and one before the live path existed at all
      `${JSON.stringify({ id: "aaaaaaaaaaaaaaaa", at: "2026-10-20T22:00:00.000Z", ref: T2, intent: { venue: "kalshi", instrument: T2, outcome: "No", unitsMilli: 12_000, book: { bestPriceMilli: 250, avgPriceMilli: 250, worstPriceMilli: 260, costCents: 306 }, maxCostCents: 306 }, attempts: [{ strategy: "book", step: "fill", ok: true, at: "2026-10-20T22:00:00.000Z", detail: "simulated at the walked book", costCents: 306 }], fill: { strategy: "book", venue: "kalshi", instrument: T2, unitsMilli: 12_000, avgPriceMilli: 250, costCents: 306, vsBookCents: 0, simulated: true, ids: {} }, outcome: "filled_book", fallbackReason: null, bookWalkPenaltyCents: 6 })}\n` +
      "not json at all\n",
  );
  const book = buildRealizedBook({ receipts: loadHedgeReceipts(receipts), pending: loadPending(join(dir, "lock-pending.jsonl")), locks: loadShadowPositions(lock).map((p) => ({ p, holder: null })) });
  assert.deepEqual([book.totals.realFills, book.totals.realLocks, book.totals.settled, book.notCounted.length], [1, 1, 1, 0]);
  const f = book.fills[0];
  assert.deepEqual([f.via, f.feesCents, f.settlementProvisionCents, f.cashPaidCents, f.clientOrderId], ["direct", null, 0, 300, "atticus-0123456789abcdef"]);
  const l = book.locks[0];
  // no hedgeUnitsMilli on the old open record: the pricer's sizing rule gives the 12 units
  assert.deepEqual([l.hedgeUnitsMilli, l.coverage, l.feesKnown, l.exact, l.realizedCents], [12_000, "exact", false, true, 16]);
  assert.equal(book.totals.fillsWithoutFee, 1);
  assert.deepEqual(book.byMonth.map((m) => [m.period, m.fillsWithoutFee, m.realizedCents]), [["2026-10", 1, 16]]);
  assertWholeMoney(book);

  // nothing on disk at all is an empty book, and the public page then says nothing
  const none = buildRealizedBook({ receipts: [], pending: [], locks: [] });
  assert.equal(none.totals.realFills, 0);
  assert.equal(publicRealSummary(none), null);
});

test("the monthly export: one row per venue per month, whole cents, contracts to the thousandth", async () => {
  const L = ledgers();
  // October: a Kalshi lock that settled in November
  appendShadowRecord(L.lockPath(null), openLock({ at: "2026-10-31T22:00:00.000Z" }));
  await L.live(kalshiBuy(), T, "2026-10-31T22:00:01.000Z", filled());
  appendShadowRecord(L.lockPath(null), { type: "cash", at: "2026-10-31T22:05:00.000Z", ticker: T, leg: "credit", cents: 84 });
  appendShadowRecord(L.lockPath(null), { type: "settle", at: "2026-11-01T04:00:00.000Z", ticker: T, result: "yes" });
  appendShadowRecord(L.lockPath(null), { type: "cash", at: "2026-11-02T10:00:00.000Z", ticker: T, leg: "handback", cents: 400 });
  // November: ann's lock through the pod, a part of a contract in it, still open
  appendShadowRecord(L.lockPath("ann"), openLock({ at: "2026-11-03T18:00:00.000Z", holder: "ann", hedgeUnitsMilli: 12_500 }));
  await L.live({ ...kalshiBuy(), unitsMilli: 12_500 }, `${T}@ann`, "2026-11-03T18:00:01.000Z", filled({ orderId: "px-9", venueOrderId: "k-9", via: "aggregator", costCents: 313, feesCents: 6 }));
  const book = L.book();
  const csv = realizedMonthlyCsv(book);
  assert.equal(
    csv,
    [
      REALIZED_MONTHLY_CSV_COLUMNS.join(","),
      "2026-10,kalshi,direct,1,12.000,300,5,0,0.000,0,0,0,84,0,0,0",
      "2026-11,kalshi,aggregator,1,12.500,313,6,0,0.000,0,0,0,0,0,0,0",
      "2026-11,kalshi,direct,0,0.000,0,0,0,0.000,0,1,0,0,400,16,0",
      "",
    ].join("\n"),
  );
  assert.equal(realizedMonthlyCsv(book, "2026-10").trim().split("\n").length, 2, "one month cut out of it");
  assert.equal(realizedMonthlyCsv(buildRealizedBook({ receipts: [], pending: [], locks: [] })), `${REALIZED_MONTHLY_CSV_COLUMNS.join(",")}\n`);
  assert.deepEqual([unitsDecimal(12_500), unitsDecimal(7), unitsDecimal(0), unitsDecimal(1_000_001)], ["12.500", "0.007", "0.000", "1000.001"]);
  // the months add up to the totals
  const sum = (k: "cashPaidCents" | "realizedCents" | "paidToHolderCents" | "collectedFromHolderCents"): number => book.byMonth.reduce((s, r) => s + r[k], 0);
  assert.deepEqual([sum("cashPaidCents"), sum("realizedCents"), sum("paidToHolderCents"), sum("collectedFromHolderCents")], [book.totals.cashPaidCents, book.totals.realizedCents, book.totals.paidToHolderCents, book.totals.collectedFromHolderCents]);
  assertWholeMoney(book);
});

test("the public card: counts and cash, labelled real and apart from the simulated run; no venue named; our result only when it is complete", () => {
  const page = (real: Parameters<typeof renderShadowHtml>[0]["real"]): string => renderShadowHtml({ atIso: "2026-11-06T12:00:00.000Z", summary: summarizeShadow([]), open: [], settled: [], real });
  const card = (html: string): string => {
    const at = html.indexOf("<h2>Real fills</h2>");
    assert.ok(at > 0, "the card is on the page");
    return html.slice(at, html.indexOf('<div class="card">', at));
  };
  const base = { realLocks: 4, realFills: 6, settled: 2, leftEarly: 1, open: 1, unresolved: 0, paidForFillsCents: 1_224, receivedFromSalesCents: 520, paidToHoldersCents: 2_052, collectedFromHoldersCents: 400, realizedCents: 48, realizedWithheld: null };

  // no real fill: the page is as it was, to the word
  for (const none of [undefined, null]) {
    const html = page(none);
    assert.ok(!html.includes("Real fills"));
    assert.ok(html.includes("Live prices; nothing is bought.</div>"));
    assert.ok(html.includes("<b>Simulated:</b> the positions; no venue credentials, no wallets."));
  }

  const html = page(base);
  const c = card(html);
  assert.ok(c.includes("These are real fills in our own accounts: orders that were placed and filled with real money when a holder chose to lock in. The rest of this page is a simulated run."));
  for (const piece of [
    '<div class="n">4</div><div class="l">real locks</div>',
    '<div class="n">2</div><div class="l">settled</div>',
    '<div class="n">$12.24</div><div class="l">paid for the fills, fees in</div>',
    '<div class="n green">$0.48</div><div class="l">our result, ended locks</div>',
    "<span>real orders filled</span><b>6</b>",
    "<span>real locks open now</span><b>1</b>",
    "<span>left early, hedge sold</span><b>1</b>",
    "<span>received from real sales</span><b>$5.20</b>",
    "<span>paid to holders, on the record</span><b>$20.52</b>",
    "<span>collected from holders, on the record</span><b>$4.00</b>",
    "Our result covers the 3 real locks that have ended: what the hedge paid or sold for and what the terms collected from the holder, less what the fills cost and what the terms paid the holder.",
  ])
    assert.ok(c.includes(piece), piece);
  assert.ok(!c.includes("ended and not yet valued"), "a row with nothing in it is not shown");
  assert.ok(html.includes("Live prices; nothing in the run is bought. The real fills are counted apart, in the next card."));
  // with real orders on the record the footer no longer says the service holds no venue credentials
  assert.ok(html.includes("<b>Simulated:</b> the positions. <b>Real fills:</b> counted apart, in their own card."));
  assert.ok(!html.includes("no venue credentials"));

  // a loss is shown as one, without the green
  assert.ok(card(page({ ...base, realizedCents: -20 })).includes('<div class="n ">-$0.20</div><div class="l">our result, ended locks</div>'));
  // a result that is not complete on the record is not shown, and the card says why
  const held = card(page({ ...base, unresolved: 1, realizedCents: null, realizedWithheld: "a figure in it is not yet the venue's own number" }));
  assert.ok(held.includes('<div class="n">not yet</div><div class="l">our result</div>'));
  assert.ok(held.includes("Our result on the real locks is not shown yet: a figure in it is not yet the venue's own number."));
  assert.ok(held.includes("<span>ended and not yet valued</span><b>1</b>"));
  assert.ok(!held.includes("$0.48"));

  for (const text of [c, held]) {
    assert.ok(!/kalshi|prophetx|novig|polymarket|parlayx|aggregator/i.test(text), "no venue is named");
    assert.ok(!/[\u2014\u2013]/.test(text), "no dash");
    assert.ok(!/wallet|guarantee|protect/i.test(text));
  }
});
