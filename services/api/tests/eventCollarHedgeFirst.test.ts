/**
 * Hedge first (crossVenue/hedgeFirst.ts): on a real-money lock the hedge is bought before the
 * lock is written. The pure pieces first (when it applies, what a receipt means, the pending
 * trail, the identity per ending), then the worker's lock route against a scripted venue: a miss,
 * a part fill, an unconfirmed order and a rail refusal each write no lock; a whole fill writes it.
 * The venue is a fake hook behind the real live executor; nothing touches a venue.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { intentFromHedge, loadHedgeReceipts, type HedgeIntent, type HedgeReceipt } from "../src/eventCollar/crossVenue/hedgeExecutor";
import {
  appendPending,
  clearable,
  judgeHedge,
  loadPending,
  lockMode,
  pendingRecordFor,
  refusalWords,
  summarizePending,
  type LiveRailsView,
  type PendingRecord,
} from "../src/eventCollar/crossVenue/hedgeFirst";
import { KalshiOrderClient } from "../src/eventCollar/crossVenue/kalshiOrders";
import { quoteLadderWrap, type NoAskLevel } from "../src/eventCollar/crossVenue/kalshiLadder";
import { DEFAULT_LIVE_RAILS, LiveHedgeExecutor, type LiveOrderHook, type LiveOrderResult } from "../src/eventCollar/crossVenue/liveHedge";
import { loadShadowPositions } from "../src/eventCollar/crossVenue/shadowLedger";
import { DEFAULT_CROSS_CONFIG, type CrossQuoteResult } from "../src/eventCollar/crossVenue/types";
import type { CandidateResult, GameMarketRow, OneQuoteInputs, OneQuoteResult } from "../scripts/eventProtectXDemoService";

const TICKER = "KXNBAGAME-26OCT14LALBOS-BOS";
const START = new Date(Date.now() + 3 * 3_600_000).toISOString();
const NO_ASKS: NoAskLevel[] = [
  { priceCents: 41, qtyMilli: 300_000 },
  { priceCents: 42, qtyMilli: 400_000 },
];

function quoteFor(contracts: number, entryCents = 60): Extract<CrossQuoteResult, { ok: true }> {
  const quote = quoteLadderWrap({
    pair: { kalshi: { ticker: TICKER }, gameStartTime: START },
    markCents: 60,
    entryCents,
    contracts,
    now: new Date(),
    noAsks: NO_ASKS,
    config: DEFAULT_CROSS_CONFIG,
  });
  assert.ok(quote.ok, JSON.stringify(quote));
  return quote;
}

const intentFor = (contracts: number): HedgeIntent => intentFromHedge(quoteFor(contracts).hedge, NO_ASKS[0].priceCents * 10);

const LIVE: LiveRailsView = { killSwitch: false, dryRun: false, allowlist: [TICKER], anyTicker: false, venues: ["kalshi"] };

test("hedge first applies only when the order would truly leave: live, send on, kill switch off, a client for the venue, the game armed", () => {
  const intent = intentFor(20);
  assert.deepEqual(lockMode(LIVE, intent), { real: true });
  assert.deepEqual(lockMode(null, intent), { real: false, why: "not_live" });
  assert.deepEqual(lockMode({ ...LIVE, killSwitch: true }, intent), { real: false, why: "kill_switch" });
  assert.deepEqual(lockMode({ ...LIVE, dryRun: true }, intent), { real: false, why: "dry_run" });
  assert.deepEqual(lockMode({ ...LIVE, venues: ["novig"] }, intent), { real: false, why: "no_client" });
  assert.deepEqual(lockMode({ ...LIVE, allowlist: ["KX-OTHER"] }, intent), { real: false, why: "not_armed" });
  assert.deepEqual(lockMode({ ...LIVE, allowlist: [], anyTicker: true }, intent), { real: true }, "* arms any game");
  // a leg on another venue is armed by the game's Kalshi ticker, not by its own instrument
  const away: HedgeIntent = { ...intent, venue: "novig", instrument: "outcome-123", armKey: TICKER };
  assert.deepEqual(lockMode({ ...LIVE, venues: ["novig"] }, away), { real: true });
  assert.deepEqual(lockMode({ ...LIVE, venues: ["novig"] }, { ...away, armKey: "KX-OTHER" }), { real: false, why: "not_armed" });
});

/** A receipt from the real live executor with a scripted venue behind it. */
async function receiptFrom(intent: HedgeIntent, hook: LiveOrderHook | null, rails = {}): Promise<HedgeReceipt> {
  const exec = new LiveHedgeExecutor(hook ? { kalshi: hook } : {}, { ...DEFAULT_LIVE_RAILS, dryRun: false, allowlist: [TICKER], ...rails }, () => 0);
  return exec.execute(intent, TICKER);
}

const filled = (intent: HedgeIntent, unitsMilli = intent.unitsMilli, costCents = intent.book.costCents): LiveOrderResult => ({
  orderId: "ord-1",
  unitsMilli,
  avgPriceMilli: Math.ceil((costCents * 10_000) / unitsMilli),
  costCents,
  feesCents: 0,
  status: "executed",
});

test("what a receipt means: only a real fill of the whole size is a fill; a simulated one never counts; an errored order is unconfirmed unless the venue's final state showed nothing", async () => {
  const intent = intentFor(20);

  const whole = judgeHedge(intent, await receiptFrom(intent, async (i) => filled(i)));
  assert.deepEqual(whole, { kind: "filled", unitsMilli: intent.unitsMilli, costCents: intent.book.costCents, orderId: "ord-1" });

  const part = judgeHedge(intent, await receiptFrom(intent, async (i) => filled(i, 5_000, 210)));
  assert.deepEqual(part, { kind: "partial", unitsMilli: 5_000, wantedMilli: intent.unitsMilli, costCents: 210, orderId: "ord-1" });
  assert.equal(refusalWords(part as Exclude<typeof part, { kind: "filled" }>).code, "hedge_partial");

  // the venue client's own words for an order read to its end with nothing matched
  const miss = await receiptFrom(intent, async () => {
    throw new Error("kalshi orders: order ord-0 canceled with nothing filled at or under 42c");
  });
  assert.equal(miss.outcome, "filled_book", "the executor falls back to a simulated fill, as it always has");
  assert.equal(miss.fill?.simulated, true);
  const missed = judgeHedge(intent, miss);
  assert.equal(missed.kind, "not_filled", "a simulated fill is never a hedge for a real-money lock");
  assert.equal(missed.kind === "not_filled" && missed.code, "hedge_not_filled");

  // an error after the order went out: the venue may hold a fill
  for (const msg of ["kalshi orders: HTTP 503 POST /portfolio/events/orders", "The operation was aborted due to timeout", "kalshi orders: create returned no order id"]) {
    const v = judgeHedge(intent, await receiptFrom(intent, async () => {
      throw new Error(msg);
    }));
    assert.deepEqual(v, { kind: "unconfirmed", detail: msg });
    assert.equal(refusalWords(v as Exclude<typeof v, { kind: "filled" }>).code, "hedge_unconfirmed");
  }
  assert.equal(judgeHedge(intent, null).kind, "unconfirmed", "an executor that threw is not known to have sent nothing");

  // a rail held the order before it left: nothing was bought, and the holder is not told to try again at once
  const capped = judgeHedge(intent, await receiptFrom(intent, async (i) => filled(i), { maxUnitsPerOrderMilli: 1_000 }));
  assert.equal(capped.kind === "not_filled" && capped.code, "hedge_held_by_rail");
  assert.match(capped.kind === "not_filled" ? capped.detail : "", /per-order cap/);
  assert.equal(refusalWords(capped as Exclude<typeof capped, { kind: "filled" }>).code, "hedge_held");
  const dry = judgeHedge(intent, await receiptFrom(intent, async (i) => filled(i), { dryRun: true }));
  assert.equal(dry.kind === "not_filled" && dry.code, "hedge_held_by_rail", "a dry run sent nothing");

  // the holder's words never name a venue or an order
  for (const v of [part, missed, capped]) {
    const words = refusalWords(v as Exclude<typeof v, { kind: "filled" }>);
    assert.ok(!/kalshi|ord-|\u2014/i.test(words.message), words.message);
    assert.match(words.message, /Nothing was locked/);
  }
});

test("the identity per ending: on a whole fill the writer keeps the take plus what the fill saved against the walk, the same either way the game goes; with no fill nobody owes anything", () => {
  for (const contracts of [20, 7, 100]) {
    const q = quoteFor(contracts);
    const N = q.contracts;
    const fundingCents = (100 - q.capCents) * N;
    const walkedCents = q.hedge.costCents + q.feesCents; // Xq, all in
    assert.equal(q.creditCents, fundingCents - walkedCents - q.takeCents, "the quote's own identity: credit = funding - walked cost - take");
    const hedgePaysCents = ("contractsMilli" in q.hedge ? q.hedge.contractsMilli : q.hedge.sharesMilli) / 10;
    assert.ok(hedgePaysCents >= N * (100 - q.capCents + q.floorCents), "the hedge is never short of the losing-state payout");
    for (const fillCents of [walkedCents, walkedCents - 3]) {
      // holder's side wins: the holder keeps cap x N + credit of the 100 x N the venue pays; the hedge expires worthless
      const writerWin = fundingCents - q.creditCents - fillCents;
      // holder's side loses: the writer pays floor x N + credit and the hedge pays 100 a unit
      const writerLose = hedgePaysCents - q.floorCents * N - q.creditCents - fillCents;
      assert.equal(writerWin, q.takeCents + (walkedCents - fillCents), "the take, plus what the fill saved against the walk");
      assert.ok(writerLose >= writerWin && writerLose - writerWin < 1, "the same in both outcomes, up to the hedge's round-up");
    }
  }
});

test("the pending trail: a line before the order, a line when it ends; open lines and strays are reported until the operator clears them", () => {
  const dir = mkdtempSync(join(tmpdir(), "pending-"));
  const path = join(dir, "lock-pending.jsonl");
  assert.deepEqual(loadPending(path), []);
  const intent = { ...intentFor(20), allOrNone: true };
  const terms = { contracts: 20, tier: "balanced", floorCents: 45, capCents: 80, creditCents: 31 };
  const mk = (at: string, holder: string | null = null) => pendingRecordFor(holder ? `${TICKER}@${holder}` : TICKER, TICKER, holder, at, terms, intent);
  const a = mk("2026-11-10T01:00:00.000Z");
  const b = mk("2026-11-10T01:01:00.000Z");
  const c = mk("2026-11-10T01:02:00.000Z", "founder");
  const d = mk("2026-11-10T01:03:00.000Z");
  assert.equal(a.id, `${TICKER}#2026-11-10T01:00:00.000Z`);
  assert.equal(c.holder, "founder");
  assert.deepEqual(a.order, { venue: "kalshi", instrument: TICKER, action: "buy", unitsMilli: intent.unitsMilli, limitMilli: intent.book.worstPriceMilli, maxCostCents: intent.maxCostCents });
  const lines: PendingRecord[] = [
    a,
    { type: "resolved", id: a.id, at: "2026-11-10T01:00:01.000Z", outcome: "refused", detail: "nothing filled" },
    b,
    { type: "resolved", id: b.id, at: "2026-11-10T01:01:01.000Z", outcome: "locked", detail: "filled", fill: { unitsMilli: intent.unitsMilli, costCents: 540, orderId: "ord-1", receiptId: "r1" } },
    c,
    { type: "resolved", id: c.id, at: "2026-11-10T01:02:01.000Z", outcome: "stray", detail: "5 of 13 filled", fill: { unitsMilli: 5_000, costCents: 210, orderId: "ord-2", receiptId: "r2" } },
    d, // the process stopped here
  ];
  for (const l of lines) appendPending(path, l);
  const s = summarizePending(loadPending(path));
  assert.deepEqual(s.counts, { locked: 1, refused: 1, stray: 1, unconfirmed: 0, ledger_failed: 0 });
  assert.deepEqual(s.unresolved.map((p) => p.id), [d.id]);
  assert.deepEqual(s.strays.map((x) => x.pending.id), [c.id]);
  assert.equal(clearable(loadPending(path), a.id), false, "a refusal left nothing to clear");
  assert.equal(clearable(loadPending(path), b.id), false, "a lock is not a stray");
  assert.equal(clearable(loadPending(path), c.id), true);
  assert.equal(clearable(loadPending(path), d.id), true);
  appendPending(path, { type: "cleared", id: c.id, at: "2026-11-10T02:00:00.000Z", note: "sold 5 at 40c on the venue" });
  appendPending(path, { type: "cleared", id: d.id, at: "2026-11-10T02:01:00.000Z", note: "no order on the venue under that id" });
  const after = summarizePending(loadPending(path));
  assert.deepEqual(after.unresolved, []);
  assert.deepEqual(after.strays, []);
  assert.deepEqual(after.counts, s.counts, "clearing stops the page; how each attempt ended stays on the trail");
  assert.equal(readFileSync(path, "utf8").trim().split("\n").length, lines.length + 2, "append-only: nothing rewritten");
});

test("kalshi orders: a lock's hedge is sent fill or kill; anything else stays immediate or cancel", () => {
  const intent = intentFor(20);
  assert.equal(KalshiOrderClient.orderBody(intent, "x").time_in_force, "immediate_or_cancel");
  assert.equal(KalshiOrderClient.orderBody({ ...intent, allOrNone: true }, "x").time_in_force, "fill_or_kill");
  assert.equal(KalshiOrderClient.orderBody({ ...intent, action: "sell" }, "x").time_in_force, "immediate_or_cancel");
});

// ---------------------------------------------------------------------------
// the worker's lock route, real-money mode, a scripted venue
// ---------------------------------------------------------------------------

function candidate(contracts: number, entryCents: number): CandidateResult {
  const quote = quoteFor(contracts, entryCents);
  return {
    kind: "sports",
    league: "nba",
    market: {
      ticker: TICKER,
      eventTicker: "KXNBAGAME-26OCT14LALBOS",
      title: "Lakers at Celtics Winner?",
      subtitle: "Boston Celtics",
      strike: 0,
      strikeType: "",
      status: "active",
      openTime: "",
      closeTime: START,
      yesBidCents: 59,
      yesAskCents: 61,
      lastPriceCents: 60,
      volume: 1000,
      openInterest: 1000,
      rulesPrimary: "Celtics win",
    },
    pair: null,
    sideName: "Boston Celtics",
    eventTitle: "Lakers at Celtics",
    eventTimeIso: START,
    parityNote: "",
    fingerprint: `test:${TICKER}`,
    markCents: 60,
    position: { contracts, entryCents, entrySource: "entered_now", entryTime: null },
    quote,
    route: "kalshi_self",
    evBps: quote.evCostBps,
    routesChecked: [],
    books: { noAsks: NO_ASKS },
  };
}

test("lock route, real money: a miss, a part fill, an unconfirmed order and a rail refusal write no lock; the whole fill writes it, after the hedge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hedge-first-"));
  const ledger = join(dir, "lock-ledger.jsonl");
  const pendingPath = join(dir, "lock-pending.jsonl");
  const receiptsPath = join(dir, "hedge-receipts.jsonl");
  process.env.NODE_ENV = "test";
  process.env.EVENT_SHADOW_LEDGER_PATH = join(dir, "ledger.jsonl");
  process.env.EVENT_SHADOW_LOCK_LEDGER_PATH = ledger;
  process.env.EVENT_LASTLEG_LEDGER_PATH = join(dir, "lastleg.jsonl");
  process.env.EVENT_X_ADMIN_TOKEN = "op-secret";
  process.env.EVENT_SHADOW_LOCK_KEY = "lock-key-0123456789";
  // everything that lets an order leave, set at once: live, armed, send on
  process.env.EVENT_HEDGE_STRATEGY = "live";
  process.env.EVENT_HEDGE_LIVE_TICKERS = TICKER;
  process.env.EVENT_HEDGE_LIVE_SEND = "yes";
  delete process.env.EVENT_HEDGE_KILL_SWITCH;
  // a throwaway key so the Kalshi client exists; the executor below replaces it, so it signs nothing
  process.env.KALSHI_API_KEY_ID = "test-key-id";
  process.env.KALSHI_PRIVATE_KEY_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const worker = await import("../scripts/eventShadowWorker");

  // the venue, scripted: each lock attempt takes the next answer
  const script: Array<(i: HedgeIntent) => LiveOrderResult> = [];
  const sent: HedgeIntent[] = [];
  /** what was on the lock ledger at the moment each order reached the venue */
  const locksWhenSent: number[] = [];
  const hook: LiveOrderHook = async (intent) => {
    sent.push(intent);
    locksWhenSent.push(loadShadowPositions(ledger).length);
    const step = script.shift();
    if (!step) throw new Error("unexpected order");
    return step(intent);
  };
  const markets: GameMarketRow[] = [
    { ticker: TICKER, league: "nba", sideName: "Boston Celtics", title: "Lakers at Celtics Winner?", dateIso: "2026-10-14", closeTimeIso: START, markCents: 60, startIso: START, protectable: true, protectableUntilIso: START },
  ];
  worker.wireLockEngine({
    listGameMarkets: async () => markets,
    quoteOne: async (inputs: OneQuoteInputs): Promise<OneQuoteResult> => ({ ok: true, result: candidate(inputs.contracts, inputs.entryCents ?? 60) }),
    hedgeExecutor: new LiveHedgeExecutor({ kalshi: hook }, { ...DEFAULT_LIVE_RAILS, dryRun: false, allowlist: [TICKER] }, () => 0),
  });
  await new Promise<void>((r) => worker.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
  const key = { "x-lock-key": "lock-key-0123456789", "content-type": "application/json" };
  const tap = async (contracts: number) => {
    const res = await fetch(`${base}/api/shadow/lock`, { method: "POST", headers: key, body: JSON.stringify({ ticker: TICKER, contracts, entryCents: 58 }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> & { hedge?: Record<string, unknown> } };
  };
  const trail = () => summarizePending(loadPending(pendingPath));
  // the pages, as the alerter logs them (no sink is configured in a test)
  const pages: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => {
    pages.push(a.map(String).join(" "));
  };
  const health = async () => ((await (await fetch(`${base}/healthz?token=op-secret`)).json()) as { lock: { hedgeFirst: { counts: Record<string, number>; unresolved: string[]; strays: string[] } } }).lock.hedgeFirst;
  try {
    assert.equal(existsSync(pendingPath), false, "no trail before the first real-money tap");

    // 1. the book moved: the venue read the order to its end and matched nothing
    script.push(() => {
      throw new Error("kalshi orders: order ord-0 canceled with nothing filled at or under 42c");
    });
    const miss = await tap(20);
    assert.equal(miss.status, 200);
    assert.equal(miss.body.ok, false);
    assert.equal(miss.body.code, "hedge_not_filled");
    assert.match(String(miss.body.message), /Nothing was locked\. Try again\./);
    assert.ok(!("hedge" in miss.body) && !("floorCents" in miss.body), "a refusal carries no terms and no hedge");
    assert.equal(loadShadowPositions(ledger).length, 0, "no lock was written");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].allOrNone, true, "a lock's hedge is sent all or none");
    assert.deepEqual(trail().counts, { locked: 0, refused: 1, stray: 0, unconfirmed: 0, ledger_failed: 0 });
    assert.deepEqual(await health(), { path: pendingPath, counts: trail().counts, unresolved: [], strays: [] });

    // 2. an immediate-or-cancel venue matched part of the size: a stray hedge, no lock
    script.push((i) => filled(i, 5_000, 210));
    const part = await tap(20);
    assert.equal(part.body.ok, false);
    assert.equal(part.body.code, "hedge_partial");
    assert.equal(loadShadowPositions(ledger).length, 0);
    const strays = trail().strays;
    assert.equal(strays.length, 1);
    assert.equal(strays[0].resolved.outcome, "stray");
    assert.deepEqual({ ...strays[0].resolved.fill, receiptId: "" }, { unitsMilli: 5_000, costCents: 210, orderId: "ord-1", receiptId: "" });
    assert.deepEqual((await health()).strays, [strays[0].pending.id], "the status page names the stray");

    // 3. the order went out and the answer was an error: not known, so not locked, and the operator's to check
    script.push(() => {
      throw new Error("kalshi orders: HTTP 503 POST /portfolio/events/orders");
    });
    const unknown = await tap(20);
    assert.equal(unknown.body.ok, false);
    assert.equal(unknown.body.code, "hedge_unconfirmed");
    assert.equal(loadShadowPositions(ledger).length, 0);
    assert.equal(trail().counts.unconfirmed, 1);
    assert.equal(trail().strays.length, 2);
    // both were paged, a second apart at most: a stray is never folded into an earlier one
    const strayPages = pages.filter((p) => p.includes("hedge_stray"));
    assert.equal(strayPages.length, 2, pages.join("\n"));
    assert.match(strayPages[0], /5 of 6 filled on kalshi .* for 210c \(order ord-1\)\. No lock was written\. Sell the part that filled, then clear /);
    assert.match(strayPages[1], /went out and was not confirmed \(kalshi orders: HTTP 503 .*\)\. No lock was written\. Look for client order atticus-[0-9a-f]+ on the venue/);
    assert.equal(pages.filter((p) => p.includes("hedge_not_filled") || p.includes("refused")).length, 0, "a clean miss pages nobody");

    // 4. over the per-order cap (25): the rail holds the order; nothing leaves, nothing is locked
    const big = await tap(100);
    assert.equal(big.body.ok, false);
    assert.equal(big.body.code, "hedge_held");
    assert.equal(sent.length, 3, "no order left for the capped size");
    assert.equal(loadShadowPositions(ledger).length, 0);
    assert.equal(trail().counts.refused, 2);

    // the operator's view of the trail, and clearing what was dealt with
    assert.equal((await fetch(`${base}/api/shadow/lock/pending`)).status, 403, "the trail is the operator's");
    const view = (await (await fetch(`${base}/api/shadow/lock/pending?token=op-secret`)).json()) as { ok: boolean; strays: Array<{ pending: { id: string } }>; recent: PendingRecord[] };
    assert.equal(view.ok, true);
    assert.equal(view.strays.length, 2);
    assert.equal(view.recent.length, 8, "four attempts, two lines each");
    const clear = (id: string, note: string, method = "POST") => fetch(`${base}/api/shadow/lock/pending/clear?token=op-secret&id=${encodeURIComponent(id)}&note=${encodeURIComponent(note)}`, { method });
    assert.equal((await clear(view.strays[0].pending.id, "sold", "GET")).status, 405);
    assert.equal((await clear(view.strays[0].pending.id, "")).status, 400, "a clear says what was done");
    assert.equal((await clear("nope", "x")).status, 404);
    for (const s of view.strays) assert.equal((await clear(s.pending.id, "checked on the venue; sold what filled")).status, 200);
    assert.equal((await clear(view.strays[0].pending.id, "again")).status, 404, "a cleared line is not cleared twice");
    assert.deepEqual((await health()).strays, []);

    // 5. the whole size fills, 3 cents under the walk: now, and only now, the lock is written
    script.push((i) => filled(i, i.unitsMilli, i.book.costCents - 3));
    const ok = await tap(20);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true, JSON.stringify(ok.body));
    assert.equal(ok.body.hedge?.outcome, "filled_live");
    assert.equal(ok.body.hedge?.simulated, false);
    assert.equal(ok.body.hedge?.orderId, "ord-1");
    assert.deepEqual(locksWhenSent, [0, 0, 0, 0], "every order reached the venue before any lock was on the record");
    const locks = loadShadowPositions(ledger);
    assert.equal(locks.length, 1);
    assert.equal(locks[0].source, "lock");
    assert.equal(locks[0].contracts, 20);
    assert.equal(locks[0].floorCents, ok.body.floorCents, "the lock is at the quoted terms");
    assert.equal(locks[0].creditCents, ok.body.creditCents);
    assert.equal(trail().counts.locked, 1);
    assert.deepEqual(trail().unresolved, []);

    // the receipt a holder opens later is the real fill, not an earlier attempt's simulated fallback
    const rcpt = (await (await fetch(`${base}/api/shadow/receipt?ticker=${TICKER}`, { headers: key })).json()) as { ok: boolean; hedge: { simulated: boolean; receiptId: string; orderId: string } };
    assert.equal(rcpt.ok, true);
    assert.equal(rcpt.hedge.simulated, false);
    assert.equal(rcpt.hedge.receiptId, ok.body.hedge?.receiptId);
    const receipts = loadHedgeReceipts(receiptsPath);
    assert.equal(receipts.length, 5, "every attempt is on the hedge trail, sent or held");
    assert.equal(receipts.filter((r) => r.fill && !r.fill.simulated).length, 2, "two real fills: the stray part and the lock's hedge");

    // one lock per market still holds
    const again = await tap(20);
    assert.equal(again.status, 409);
    assert.equal(again.body.error, "already_on_record");
    assert.equal(sent.length, 4, "no order for a market already locked");
  } finally {
    console.error = realError;
    await new Promise<void>((r) => worker.server.close(() => r()));
  }
});
