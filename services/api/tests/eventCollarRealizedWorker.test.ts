/**
 * The realized book in the service: the operator's routes (token-gated), the day's check with and
 * without a venue key, the once-a-day run and the line it keeps, the health body, the alert when
 * a venue differs, the real fills card on the public page and the monthly export. The ledgers are
 * written line by line the way the service writes them; the venue is a scripted list of fills
 * behind the reader. Nothing touches a venue.
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BookHedgeExecutor, appendHedgeReceipt, intentFromHedge, type HedgeIntent, type HedgeReceipt } from "../src/eventCollar/crossVenue/hedgeExecutor";
import type { KalshiFill, KalshiFillsQuery } from "../src/eventCollar/crossVenue/kalshiOrders";
import { LiveHedgeExecutor, type LiveHedgeRails, type LiveOrderHook } from "../src/eventCollar/crossVenue/liveHedge";
import { REALIZED_MONTHLY_CSV_COLUMNS } from "../src/eventCollar/crossVenue/realizedBook";
import { reconcileDay } from "../src/eventCollar/crossVenue/realizedRecon";
import { appendReconRun, dailyCheckDue, differsAlertText, latestRunPerDay, loadReconRuns, reconRunOf } from "../src/eventCollar/crossVenue/realizedReconLog";
import { appendShadowRecord, type ShadowOpenRecord } from "../src/eventCollar/crossVenue/shadowLedger";

const T = "KXNBAGAME-26NOV03BOSLAL-BOS";
const T_OLD = "KXNBAGAME-25OCT20BOSNYK-BOS";
const RAILS: LiveHedgeRails = { killSwitch: false, dryRun: false, allowlist: [], anyTicker: true, maxUnitsPerOrderMilli: 500_000, maxUnitsPerDayMilli: 5_000_000 };

// days that have ended whenever the test runs: the route refuses a day that has not begun
const DAY_MS = 86_400_000;
const dayBack = (n: number): string => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);
const [D0, D1, D2, D3] = [6, 5, 4, 3].map(dayBack);
const startSec = (day: string): number => Date.parse(`${day}T00:00:00.000Z`) / 1000;
/** half past midnight (and a minute) on the UTC day after `day`: when the timer checks `day` */
const morningAfter = (day: string, minute = 31): Date => new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS + minute * 60_000);

const dir = mkdtempSync(join(tmpdir(), "realized-worker-"));
const PATHS = {
  scan: join(dir, "ledger.jsonl"),
  lock: join(dir, "lock-ledger.jsonl"),
  receipts: join(dir, "hedge-receipts.jsonl"),
  pending: join(dir, "lock-pending.jsonl"),
  recon: join(dir, "realized-recon.jsonl"),
};
process.env.NODE_ENV = "test";
process.env.EVENT_SHADOW_LEDGER_PATH = PATHS.scan;
process.env.EVENT_SHADOW_LOCK_LEDGER_PATH = PATHS.lock;
process.env.EVENT_LASTLEG_LEDGER_PATH = join(dir, "lastleg.jsonl");
process.env.EVENT_X_ADMIN_TOKEN = "op-secret";
for (const k of [
  "KALSHI_API_KEY_ID",
  "KALSHI_PRIVATE_KEY_PEM",
  "AGGREGATOR_TRADE_KEY_ID",
  "AGGREGATOR_TRADE_PRIVATE_KEY_HEX",
  "NOVIG_TRADE_KEY_ID",
  "NOVIG_TRADE_PRIVATE_KEY_PEM",
  "EVENT_HEDGE_RECEIPTS_PATH",
  "EVENT_SHADOW_LOCK_PENDING_PATH",
  "EVENT_REALIZED_RECON_PATH",
  "EVENT_REALIZED_RECON_DAILY",
  "EVENT_REALIZED_RECON_AFTER_MINUTES",
  "EVENT_RECON_KALSHI_SUBACCOUNTS",
  "EVENT_SHADOW_ALERT_WEBHOOK_URL",
  "EVENT_SHADOW_ALERT_TELEGRAM_BOT_TOKEN",
])
  delete process.env[k];

const workerP = import("../scripts/eventShadowWorker");
let base = "";
const ready = (async () => {
  const worker = await workerP;
  await new Promise<void>((r) => worker.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
  return worker;
})();
after(async () => {
  const worker = await workerP;
  await new Promise<void>((r) => worker.server.close(() => r()));
});

const OP = { "x-admin-token": "op-secret" };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const get = async (path: string, headers: Record<string, string> = OP): Promise<{ status: number; body: Json; type: string | null }> => {
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, body: (await res.json()) as Json, type: res.headers.get("content-type") };
};
const post = async (path: string, headers: Record<string, string> = OP): Promise<{ status: number; body: Json }> => {
  const res = await fetch(`${base}${path}`, { method: "POST", headers });
  return { status: res.status, body: (await res.json()) as Json };
};
const text = async (path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; type: string | null; disposition: string | null }> => {
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, body: await res.text(), type: res.headers.get("content-type"), disposition: res.headers.get("content-disposition") };
};
const reconLines = (): number => (existsSync(PATHS.recon) ? readFileSync(PATHS.recon, "utf8").split("\n").filter((l) => l.trim()).length : 0);
/** the card on the public page, from its heading to the next card */
const realCard = (html: string): string | null => {
  const at = html.indexOf("<h2>Real fills</h2>");
  if (at < 0) return null;
  const end = html.indexOf('<div class="card">', at);
  return html.slice(at, end < 0 ? undefined : end);
};

const openLock = (over: Partial<ShadowOpenRecord> = {}): ShadowOpenRecord => ({
  type: "open",
  at: `${D1}T18:00:00.000Z`,
  ticker: T,
  kind: "sports",
  league: "nba",
  sideName: "Boston Celtics",
  eventTitle: "Boston wins",
  eventTimeIso: `${D1}T23:30:00.000Z`,
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
/** a real order through the live executor, the venue's answer scripted: 12 at 25c, 5c of fees, 305c all in */
async function live(at: string, orderId: string, ticker = T): Promise<HedgeReceipt> {
  const ms = Date.parse(at);
  const hook: LiveOrderHook = async (intent) => ({ orderId, unitsMilli: intent.unitsMilli, avgPriceMilli: 255, costCents: 305, feesCents: 5, status: "executed" });
  const r = await new LiveHedgeExecutor({ kalshi: hook }, RAILS, () => 0, { now: () => new Date(ms), sleep: async () => undefined }).execute(kalshiBuy(ticker), ticker);
  appendHedgeReceipt(PATHS.receipts, r);
  return r;
}
const kFill = (over: Partial<KalshiFill> & Pick<KalshiFill, "fill_id" | "order_id" | "created_time">): KalshiFill => ({
  ticker: T,
  market_ticker: T,
  outcome_side: "no",
  book_side: "ask",
  count_fp: "12.00",
  yes_price_dollars: "0.7500",
  no_price_dollars: "0.2500",
  is_taker: true,
  fee_cost: "0.0500",
  subaccount_number: 0,
  ...over,
});

/** Kalshi's list of fills, scripted per UTC day; every ask is counted. */
const venue = {
  asks: [] as KalshiFillsQuery[],
  days: new Map<number, KalshiFill[] | Error>(),
  async fillsPage(q: KalshiFillsQuery): Promise<{ fills: KalshiFill[]; cursor: string | null }> {
    venue.asks.push(q);
    const day = venue.days.get((q.minTs ?? 0) + 1);
    if (day instanceof Error) throw day;
    return { fills: day ?? [], cursor: null };
  },
  async orderRead(): Promise<null> {
    return null;
  },
};

const pages: string[] = [];
const realError = console.error;
console.error = (...a: unknown[]) => {
  pages.push(a.map(String).join(" "));
};
after(() => {
  console.error = realError;
});

test("with no real fill: the routes need the operator's token, the book is empty, the public page says nothing about real fills, and the daily run keeps a line that says there was nothing to check", async () => {
  const worker = await ready;
  // a paper hedge, as the scan writes it
  appendHedgeReceipt(PATHS.receipts, await new BookHedgeExecutor(null, { now: () => new Date(`${D0}T12:00:00.000Z`), sleep: async () => undefined }).execute(kalshiBuy(), T));

  for (const path of ["/api/shadow/realized", "/api/shadow/realized.csv", "/api/shadow/realized/check"]) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 403, `${path} without the token`);
    assert.equal((await fetch(`${base}${path}`, { headers: { "x-admin-token": "wrong" } })).status, 403);
  }
  assert.equal((await fetch(`${base}/api/shadow/realized?token=op-secret`)).status, 200, "the token in the query, as on the other operator routes");

  const r = await get("/api/shadow/realized");
  assert.equal(r.status, 200);
  assert.equal(r.body.rule, "a hedge-receipts line with fill.simulated false, a filled outcome matching the fill's strategy, whole positive units and whole cents");
  assert.deepEqual([r.body.book.totals.realFills, r.body.book.fills.length, r.body.book.notCounted.length, r.body.public, r.body.days], [0, 0, 0, null, []]);
  assert.equal(r.body.check, undefined, "no day asked, no venue read");

  const page = await text("/");
  assert.equal(page.status, 200);
  assert.equal(realCard(page.body), null);
  assert.ok(page.body.includes("Live prices; nothing is bought."));
  assert.ok(!page.body.includes("Real fills"));

  // the public health body is unchanged; the operator's carries the book's counts and the check's state
  const pub = (await get("/healthz", {})).body;
  assert.deepEqual(Object.keys(pub).sort(), ["lastScanAt", "lastSettleAt", "ok", "positions", "service"]);
  const h = (await get("/healthz")).body.realized;
  assert.deepEqual([h.realFills, h.realLocks, h.notCounted], [0, 0, 0]);
  assert.deepEqual(h.dailyCheck, {
    daily: true,
    afterMinutesUtc: 30,
    path: PATHS.recon,
    exists: false,
    bytes: 0,
    records: 0,
    readers: { kalshi: "no key for kalshi", prophetx: "no key for prophetx", novig: "no key for novig", polymarket: "no reader for polymarket" },
    running: false,
    lastTickAt: null,
    lastError: null,
    lastRun: null,
    lastDiffers: null,
  });

  // ten minutes past midnight is too early; at half past the day that ended is checked, once
  assert.equal(await worker.reconTick(morningAfter(D0, 10)), null);
  assert.equal(reconLines(), 0);
  const run = await worker.reconTick(morningAfter(D0));
  assert.deepEqual([run?.day, run?.trigger, run?.verdict, run?.summary, run?.venues], [D0, "daily", "nothing_to_check", "no real fill on our ledger that day and no venue read", []]);
  assert.equal(reconLines(), 1);
  assert.equal(await worker.reconTick(morningAfter(D0, 36)), null, "a day with a kept line is not run again");
  assert.equal(reconLines(), 1);
});

test("an old record replays: a real fill from before the fee and the pending trail existed is counted, and the public page shows the card, with our result only once every payment is on the record", async () => {
  await ready;
  // the lock and its hedge as the service wrote them a year ago: no hedge units, no fee on the fill, no pending trail; one torn line
  const OLD = join(dir, "lock-ledger-ana.jsonl");
  appendFileSync(
    OLD,
    `${JSON.stringify({ type: "open", at: "2025-10-20T23:00:00.000Z", ticker: T_OLD, kind: "sports", league: "nba", sideName: "Boston Celtics", eventTitle: "Boston wins", eventTimeIso: "2025-10-21T00:30:00.000Z", contracts: 20, markCents: 60, floorCents: 40, capCents: 80, creditCents: 84, evCostBps: 250, route: "kalshi_self", feesCents: 6, takeCents: 10, source: "lock" })}\n` +
      "{ this line was torn by a restart\n" +
      `${JSON.stringify({ type: "settle", at: "2025-10-21T04:00:00.000Z", ticker: T_OLD, result: "no" })}\n`,
  );
  appendFileSync(
    PATHS.receipts,
    `${JSON.stringify({
      id: "0123456789abcdef",
      at: "2025-10-20T23:00:01.000Z",
      ref: `${T_OLD}@ana`,
      intent: { venue: "kalshi", instrument: T_OLD, outcome: "No", unitsMilli: 12_000, book: { bestPriceMilli: 250, avgPriceMilli: 250, worstPriceMilli: 260, costCents: 306 }, maxCostCents: 306 },
      attempts: [{ strategy: "live", step: "order", ok: true, at: "2025-10-20T23:00:01.400Z", detail: "order ord-old executed: 12 of 12 filled at 250 milli, 300c all in", orderId: "ord-old", unitsMilli: 12_000, costCents: 300 }],
      fill: { strategy: "live", venue: "kalshi", instrument: T_OLD, unitsMilli: 12_000, avgPriceMilli: 250, costCents: 300, vsBookCents: 6, simulated: false, ids: { orderId: "ord-old" } },
      outcome: "filled_live",
      fallbackReason: null,
      bookWalkPenaltyCents: 6,
    })}\n` + "not json at all\n",
  );
  assert.equal(existsSync(PATHS.pending), false);

  const r = (await get("/api/shadow/realized")).body;
  assert.deepEqual([r.book.totals.realFills, r.book.totals.realLocks, r.book.totals.settled, r.book.totals.realizedCents, r.book.totals.fillsWithoutFee, r.book.notCounted.length], [1, 1, 1, 16, 1, 0]);
  assert.deepEqual([r.book.locks[0].holder, r.book.locks[0].state, r.book.locks[0].hedgeUnitsMilli, r.book.locks[0].payoutCents, r.book.locks[0].cashPaidCents], ["ana", "settled", 12_000, 1_200, 300]);
  assert.deepEqual(r.public, {
    realLocks: 1,
    realFills: 1,
    settled: 1,
    leftEarly: 0,
    open: 0,
    unresolved: 0,
    paidForFillsCents: 300,
    receivedFromSalesCents: 0,
    paidToHoldersCents: 0,
    collectedFromHoldersCents: 0,
    realizedCents: null,
    realizedWithheld: "a payment on a settled lock is not yet on the record",
  });

  const before = realCard((await text("/")).body);
  assert.ok(before, "the card is on the page from the first real fill");
  assert.ok(before.includes("These are real fills in our own accounts: orders that were placed and filled with real money when a holder chose to lock in. The rest of this page is a simulated run."));
  assert.ok(before.includes('<div class="n">1</div><div class="l">real locks</div>'));
  assert.ok(before.includes('<div class="n">1</div><div class="l">settled</div>'));
  assert.ok(before.includes('<div class="n">$3.00</div><div class="l">paid for the fills, fees in</div>'));
  assert.ok(before.includes('<div class="n">not yet</div><div class="l">our result</div>'));
  assert.ok(before.includes("Our result on the real locks is not shown yet: a payment on a settled lock is not yet on the record."));

  // the credit and the floor are paid and written down: the result is complete and is shown
  appendShadowRecord(OLD, { type: "cash", at: "2025-10-20T23:05:00.000Z", ticker: T_OLD, leg: "credit", cents: 84 });
  appendShadowRecord(OLD, { type: "cash", at: "2025-10-21T15:00:00.000Z", ticker: T_OLD, leg: "floor", cents: 800 });
  const html = (await text("/")).body;
  const card = realCard(html);
  assert.ok(card);
  assert.ok(card.includes('<div class="n green">$0.16</div><div class="l">our result, ended locks</div>'));
  assert.ok(card.includes("<span>paid to holders, on the record</span><b>$8.84</b>"));
  assert.ok(card.includes("<span>collected from holders, on the record</span><b>$0.00</b>"));
  assert.ok(card.includes("<span>real orders filled</span><b>1</b>"));
  assert.ok(card.includes("Our result covers the 1 real lock that has ended: what the hedge paid or sold for, less what the fills cost, less what the terms paid the holder."));
  // the card's own words: no venue, no dash, none of the words we do not use
  assert.ok(!/kalshi|prophetx|novig|polymarket|parlayx|aggregator/i.test(card));
  assert.ok(!/[\u2014\u2013]/.test(card));
  assert.ok(!/wallet|guarantee|protect/i.test(card));
  assert.ok(html.includes("Live prices; nothing in the run is bought. The real fills are counted apart, in the next card."));
  assert.ok(html.includes("<b>Real fills:</b> counted apart, in their own card."));
  assert.ok(html.indexOf("<h1>Track record</h1>") < html.indexOf("<h2>Real fills</h2>"), "beside the run's own headline, under it");
});

test("a real fill and no venue key: the day's check says could not be checked, no key for the venue; the daily run keeps that, raises nothing and does not come back to it", async () => {
  const worker = await ready;
  appendShadowRecord(PATHS.lock, openLock());
  const line = await live(`${D1}T18:00:01.000Z`, "k-1");

  const r = await get(`/api/shadow/realized?day=${D1}`);
  assert.equal(r.status, 200);
  const c = r.body.check;
  assert.deepEqual([c.day, c.verdict, c.summary, c.kept, c.dayEnded, c.keptRun], [D1, "could not be checked", "kalshi could not be checked: no key for kalshi", false, true, null]);
  assert.deepEqual([c.venues[0].venue, c.venues[0].verdict, c.venues[0].reason, c.venues[0].matched.length], ["kalshi", "could not be checked", "no key for kalshi", 0]);
  assert.deepEqual([c.venues[0].ledgerTotals.orders, c.venues[0].ledgerTotals.paidCents], [1, 305]);
  assert.equal(c.readers.kalshi, "no key for kalshi");
  assert.equal(reconLines(), 1, "looking is not keeping");
  assert.deepEqual(r.body.book.fills.map((f: Json) => [f.receiptId, f.day, f.orderId, f.cashPaidCents]).slice(-1), [[line.id, D1, "k-1", 305]]);

  // a day that is not a day, and a day that has not begun
  assert.equal((await get("/api/shadow/realized?day=2026-13-40")).status, 400);
  assert.equal((await get(`/api/shadow/realized?day=${new Date(Date.now() + 2 * DAY_MS).toISOString().slice(0, 10)}`)).status, 400);

  const run = await worker.reconTick(morningAfter(D1));
  assert.deepEqual([run?.day, run?.verdict, run?.summary], [D1, "could_not_be_checked", "kalshi could not be checked: no key for kalshi"]);
  assert.equal(reconLines(), 2);
  assert.equal(await worker.reconTick(morningAfter(D1, 36)), null);
  assert.equal(await worker.reconTick(morningAfter(D1, 600)), null);
  assert.equal(reconLines(), 2, "one line for the day, however often the timer comes round");
  assert.deepEqual(pages.filter((p) => p.includes("venue_fills_differ")), [], "could not be checked is not differs");

  const h = (await get("/healthz")).body.realized;
  assert.deepEqual([h.realFills, h.realLocks, h.open, h.settled], [2, 2, 1, 1]);
  assert.deepEqual([h.dailyCheck.records, h.dailyCheck.lastRun.day, h.dailyCheck.lastRun.verdict, h.dailyCheck.lastRun.summary, h.dailyCheck.lastDiffers], [2, D1, "could not be checked", "kalshi could not be checked: no key for kalshi", null]);
});

test("with the venue's key: a day that agrees; the operator's kept check; a day that differs is alerted once and shown on the health body; a failed read is could not be checked and is asked once", async () => {
  const worker = await ready;
  worker.wireLockEngine({
    quoteOne: (async () => {
      throw new Error("not used");
    }) as never,
    listGameMarkets: (async () => []) as never,
    fillReaders: { readers: { kalshi: venue }, view: { kalshi: "the venue's own list of the day's fills (test)", prophetx: "no key for prophetx", novig: "no key for novig", polymarket: "no reader for polymarket" } },
  });

  // D1: the venue's list holds our order, the same 12 at 25c and the same 5c fee
  venue.days.set(startSec(D1), [kFill({ fill_id: "f1", order_id: "k-1", created_time: `${D1}T18:00:01.400Z` })]);
  const looked = (await get(`/api/shadow/realized?day=${D1}`)).body.check;
  assert.deepEqual([looked.verdict, looked.venues[0].verdict, looked.venues[0].scope, looked.venues[0].matched.length, looked.kept], ["agrees", "agrees", "whole_day", 1, false]);
  assert.equal(looked.venues[0].reason, "1 fill on our ledger, each at the venue with the same quantity, cost and fee, and the venue shows no other fill that day");
  assert.equal(looked.keptRun.verdict, "could_not_be_checked", "the line kept before the key was set still stands for the day");
  assert.equal(reconLines(), 2);

  // the operator checks the day again and keeps it: a new line, and it is the one that stands
  assert.equal((await get(`/api/shadow/realized/check?day=${D1}`)).status, 405);
  assert.equal((await post("/api/shadow/realized/check?day=nope")).status, 400);
  assert.equal((await post(`/api/shadow/realized/check?day=${new Date().toISOString().slice(0, 10)}`)).status, 400, "a day still running is not kept");
  const kept = await post(`/api/shadow/realized/check?day=${D1}`);
  assert.deepEqual([kept.status, kept.body.kept, kept.body.run.day, kept.body.run.trigger, kept.body.run.verdict], [200, true, D1, "operator", "agrees"]);
  assert.equal(reconLines(), 3);
  const onFile = loadReconRuns(PATHS.recon);
  assert.deepEqual(onFile.map((x) => [x.day, x.trigger, x.verdict]), [[D0, "daily", "nothing_to_check"], [D1, "daily", "could_not_be_checked"], [D1, "operator", "agrees"]]);
  const days = (await get("/api/shadow/realized")).body.days;
  assert.deepEqual(days.map((d: Json) => [d.day, d.verdict]), [[D1, "agrees"], [D0, "nothing to check"]]);

  // D2: we hold 12 on our ledger; the venue filled 10, and shows an order we never recorded
  const second = await live(`${D2}T19:00:00.000Z`, "k-2");
  venue.days.set(startSec(D2), [
    kFill({ fill_id: "f2", order_id: "k-2", count_fp: "10.00", fee_cost: "0.0400", created_time: `${D2}T19:00:00.300Z` }),
    kFill({ fill_id: "f3", order_id: "k-hand", count_fp: "3.00", fee_cost: "0.0100", created_time: `${D2}T20:00:00.000Z` }),
  ]);
  const asksBefore = venue.asks.length;
  const differs = await worker.reconTick(morningAfter(D2));
  assert.deepEqual([differs?.day, differs?.trigger, differs?.verdict], [D2, "daily", "differs"]);
  const v = differs!.venues[0];
  assert.deepEqual([v.differing.length, v.inLedgerNotAtVenue.length, v.atVenueNotInLedger.length], [1, 0, 1]);
  assert.deepEqual(
    v.differing[0].differences.map((d) => [d.field, d.ledger, d.venue, d.delta]),
    [
      ["quantity", 12_000, 10_000, -2_000],
      ["cost", 305, 254, -51],
      ["price", 255, 254, -1],
      ["fee", 5, 4, -1],
    ],
  );
  assert.equal(v.differing[0].receiptId, second.id);
  assert.deepEqual(v.atVenueNotInLedger.map((x) => [x.venueIds, x.unitsMilli, x.costCents]), [[["k-hand"], 3_000, 76]]);
  assert.equal(venue.asks.length, asksBefore + 1, "one read of the venue for the day");
  const alerts = () => pages.filter((p) => p.includes("venue_fills_differ"));
  assert.deepEqual(alerts(), [
    `[event-shadow] venue_fills_differ: our ledger and the venue's own fills differ for ${D2} (UTC). kalshi: 1 order(s) with a different quantity, cost or fee, 1 at the venue and not on our ledger. Detail: /api/shadow/realized?day=${D2}`,
  ]);
  assert.equal(await worker.reconTick(morningAfter(D2, 36)), null);
  assert.equal(await worker.reconTick(morningAfter(D2, 41)), null);
  assert.deepEqual([venue.asks.length, alerts().length, reconLines()], [asksBefore + 1, 1, 4], "no second read, no second alert, no second line");

  let h = (await get("/healthz")).body.realized.dailyCheck;
  assert.deepEqual([h.lastRun.day, h.lastRun.verdict, h.lastDiffers.day, h.lastError], [D2, "differs", D2, null]);
  assert.deepEqual(h.lastRun.venues, [
    { venue: "kalshi", verdict: "differs", reason: "1 order differs (quantity, cost, price, fee); 1 order is at the venue and not on our ledger", matched: 0, differing: 1, inLedgerNotAtVenue: 0, atVenueNotInLedger: 1, couldNotBeRead: 0 },
  ]);

  // D3: the venue is down. One ask, a line that says could not be checked, no alert, and no second ask
  await live(`${D3}T19:00:00.000Z`, "k-3");
  venue.days.set(startSec(D3), new Error("kalshi orders: HTTP 503 GET /portfolio/fills"));
  const down = await worker.reconTick(morningAfter(D3));
  assert.deepEqual([down?.day, down?.verdict, down?.summary], [D3, "could_not_be_checked", "kalshi could not be checked: the read failed: kalshi orders: HTTP 503 GET /portfolio/fills"]);
  assert.equal(await worker.reconTick(morningAfter(D3, 36)), null);
  assert.deepEqual([venue.asks.length, alerts().length, reconLines()], [asksBefore + 2, 1, 5]);
  h = (await get("/healthz")).body.realized.dailyCheck;
  assert.deepEqual([h.lastRun.day, h.lastRun.verdict, h.lastDiffers.day], [D3, "could not be checked", D2], "the day that differed stays in view behind a newer day");

  // every kept line is whole: nothing was rewritten, and each parses
  const lines = readFileSync(PATHS.recon, "utf8").split("\n").filter((l) => l.trim());
  assert.deepEqual(lines.map((l) => (JSON.parse(l) as Json).day), [D0, D1, D1, D2, D3]);
});

test("the accounting export: the operator's CSV, one row per venue per UTC month, whole cents; one month on request", async () => {
  await ready;
  const all = await text("/api/shadow/realized.csv", OP);
  assert.equal(all.status, 200);
  assert.equal(all.type, "text/csv; charset=utf-8");
  assert.equal(all.disposition, 'attachment; filename="event-realized-all-months.csv"');
  const rows = all.body.trim().split("\n").map((l) => l.split(","));
  assert.deepEqual(rows[0], [...REALIZED_MONTHLY_CSV_COLUMNS]);
  const col = (name: string): number => rows[0].indexOf(name);
  assert.equal(rows[1][col("month")], "2025-10");
  assert.deepEqual(
    ["venue", "real_fills", "contracts_bought", "cash_paid_cents", "fees_cents", "payouts_cents", "realized_cents"].map((n) => rows[1][col(n)]),
    ["kalshi", "1", "12.000", "300", "0", "1200", "16"],
  );
  // the three orders of this week, in the month or months they fell in: 36 contracts and 915 cents in all
  const recent = rows.slice(2);
  assert.equal(recent.reduce((a, r) => a + Number(r[col("real_fills")]), 0), 3);
  assert.equal(recent.reduce((a, r) => a + Number(r[col("cash_paid_cents")]), 0), 915);
  assert.equal(recent.reduce((a, r) => a + Number(r[col("fees_cents")]), 0), 15);
  for (const r of rows.slice(1)) for (const n of ["cash_paid_cents", "fees_cents", "payouts_cents", "realized_cents"]) assert.match(r[col(n)], /^-?\d+$/, `${n} is whole cents`);

  const one = await text("/api/shadow/realized.csv?month=2025-10", OP);
  assert.equal(one.disposition, 'attachment; filename="event-realized-2025-10.csv"');
  assert.equal(one.body.trim().split("\n").length, 2);
  assert.equal((await text("/api/shadow/realized.csv?month=2025-11", OP)).body.trim(), REALIZED_MONTHLY_CSV_COLUMNS.join(","));
  assert.equal((await text("/api/shadow/realized.csv?month=2025-13", OP)).status, 400);
});

test("the kept file and the timer's rule: append only, a torn line skipped, the last line stands for its day; a day is due once, after the wait, never twice", () => {
  const path = join(mkdtempSync(join(tmpdir(), "realized-log-")), "deep", "realized-recon.jsonl");
  assert.deepEqual(loadReconRuns(path), []);
  const view = { kalshi: "no key for kalshi", prophetx: "no key for prophetx", novig: "no key for novig", polymarket: "no reader for polymarket" };
  const empty = (day: string) => reconcileDay({ day, fills: [], notCounted: [], reads: [] });
  appendReconRun(path, reconRunOf(empty("2026-11-03"), "2026-11-04T00:31:00.000Z", "daily", view));
  appendFileSync(path, '{"type":"recon_run","day":"2026-11-0\n');
  appendFileSync(path, `${JSON.stringify({ type: "recon_run", day: "not a day", at: "x", venues: [] })}\n`);
  appendReconRun(path, reconRunOf(empty("2026-11-04"), "2026-11-05T00:31:00.000Z", "daily", view));
  appendReconRun(path, reconRunOf(empty("2026-11-03"), "2026-11-05T09:00:00.000Z", "operator", view));
  const runs = loadReconRuns(path);
  assert.deepEqual(runs.map((r) => [r.day, r.trigger]), [["2026-11-03", "daily"], ["2026-11-04", "daily"], ["2026-11-03", "operator"]]);
  assert.deepEqual(latestRunPerDay(runs).map((r) => [r.day, r.trigger]), [["2026-11-04", "daily"], ["2026-11-03", "operator"]]);
  assert.equal(differsAlertText(runs[0]), null, "nothing differs, nothing to send");

  const HALF_HOUR = 30 * 60_000;
  const none = new Set<string>();
  assert.equal(dailyCheckDue(new Date("2026-11-05T00:29:59.999Z"), HALF_HOUR, none, none), null);
  assert.equal(dailyCheckDue(new Date("2026-11-05T00:30:00.000Z"), HALF_HOUR, none, none), "2026-11-04");
  assert.equal(dailyCheckDue(new Date("2026-11-05T23:59:59.000Z"), HALF_HOUR, none, none), "2026-11-04", "a service that came up late in the day still checks the day before");
  assert.equal(dailyCheckDue(new Date("2026-11-05T00:30:00.000Z"), HALF_HOUR, new Set(["2026-11-04"]), none), null, "kept already");
  assert.equal(dailyCheckDue(new Date("2026-11-05T00:30:00.000Z"), HALF_HOUR, none, new Set(["2026-11-04"])), null, "tried already in this process");
  // the year's edge
  assert.equal(dailyCheckDue(new Date("2027-01-01T01:00:00.000Z"), HALF_HOUR, none, none), "2026-12-31");
});
