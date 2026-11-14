/**
 * THE LOCK PATH'S RAILS, END TO END. The record service runs in-process against fake venues
 * (nothing leaves this machine) with the live executor wired as production wires it, and each
 * test is one way real money could have gone out of step with the record:
 *
 *   - an order the venue took and whose end was never read is unconfirmed, never "nothing filled"
 *   - two taps on one position while the first is still reading send one order
 *   - the day's contract rail counts an order from the moment it leaves, not from its receipt
 *   - a leave whose sale was not confirmed closes nothing and sends no second sale
 *   - a leave that closes with hedge still on the venue pages, and that hedge stays counted
 *   - `shared` in EVENT_SHADOW_REAL_ONLY_HOLDERS covers the shared key
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadHedgeReceipts, intentFromHedge } from "../src/eventCollar/crossVenue/hedgeExecutor";
import { loadPending, summarizePending, judgeHedge } from "../src/eventCollar/crossVenue/hedgeFirst";
import { quoteLadderWrap } from "../src/eventCollar/crossVenue/kalshiLadder";
import { DEFAULT_LIVE_RAILS, LiveHedgeExecutor, sentUnitsMilliOn } from "../src/eventCollar/crossVenue/liveHedge";
import { loadShadowPositions } from "../src/eventCollar/crossVenue/shadowLedger";
import { DEFAULT_CROSS_CONFIG } from "../src/eventCollar/crossVenue/types";
import { AggregatorOrderClient } from "../src/eventCollar/crossVenue/aggregatorOrders";
import { NovigOrderClient } from "../src/eventCollar/crossVenue/novigOrders";
import { signerFromPem } from "../src/eventCollar/crossVenue/venuePositions";
import { realOnlyHoldersFromEnv, isRealOnly } from "../src/eventCollar/crossVenue/realOnlyHolders";

const BOS = "KXNBAGAME-26OCT14LALBOS-BOS";
const NYK = "KXNBAGAME-26OCT15NYKMIA-NYK";
const DEN = "KXNBAGAME-26OCT16DENPHX-DEN";
const GSW = "KXNBAGAME-26OCT17GSWSAC-GSW";
const ARMED = [BOS, NYK, DEN];
const TITLES: Record<string, [string, string]> = { [BOS]: ["Boston Celtics", "Lakers at Celtics"], [NYK]: ["New York Knicks", "Knicks at Heat"], [DEN]: ["Denver Nuggets", "Nuggets at Suns"], [GSW]: ["Golden State Warriors", "Warriors at Kings"] };
const START = new Date(Date.now() + 3 * 3_600_000).toISOString();
const NO_ASKS = [
  { priceCents: 41, qtyMilli: 300_000 },
  { priceCents: 42, qtyMilli: 400_000 },
];
const SHARED_KEY = "lock-key-0123456789";
const ALICE_KEY = "alice-key-0123456789";
const BOB_KEY = "bob-key-0123456789ab";

function candidate(ticker: string, contracts: number, entryCents: number) {
  const quote = quoteLadderWrap({ pair: { kalshi: { ticker }, gameStartTime: START }, markCents: 60, entryCents, contracts, now: new Date(), noAsks: NO_ASKS, config: DEFAULT_CROSS_CONFIG });
  assert.ok(quote.ok, JSON.stringify(quote));
  const [sideName, eventTitle] = TITLES[ticker];
  return {
    kind: "sports",
    league: "nba",
    market: { ticker, eventTicker: ticker.slice(0, ticker.lastIndexOf("-")), title: `${eventTitle} Winner?`, subtitle: sideName, strike: 0, strikeType: "", status: "active", openTime: "", closeTime: START, yesBidCents: 59, yesAskCents: 61, lastPriceCents: 60, volume: 1000, openInterest: 1000, rulesPrimary: `${sideName} win` },
    pair: null,
    sideName,
    eventTitle,
    eventTimeIso: START,
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

let dir: string;
let base: string;
let worker: any;
type Sent = { action: string; unitsMilli: number; instrument: string };
const sent: Sent[] = [];
let orders = 0;
const filled = (intent: any, unitsMilli = intent.unitsMilli, costCents = intent.book.costCents) => ({ orderId: `ord-${++orders}`, unitsMilli, avgPriceMilli: Math.ceil((costCents * 10_000) / unitsMilli), costCents, feesCents: 0, status: "executed" });
/** the venue behind the real executor; each scenario swaps `venue` */
let venue: (intent: any, clientOrderId: string) => Promise<any> = async (i) => filled(i);
const hook = async (intent: any, clientOrderId: string) => {
  sent.push({ action: intent.action ?? "buy", unitsMilli: intent.unitsMilli, instrument: intent.instrument });
  return venue(intent, clientOrderId);
};
const engine = {
  listGameMarkets: async () => Object.keys(TITLES).map((ticker) => ({ ticker, league: "nba", sideName: TITLES[ticker][0], title: `${TITLES[ticker][1]} Winner?`, dateIso: "2026-10-14", closeTimeIso: START, markCents: 60, startIso: START, protectable: true, protectableUntilIso: START })),
  quoteOne: async (inputs: any) => ({ ok: true, result: candidate(inputs.ticker, inputs.contracts, inputs.entryCents ?? 58) }),
};
const ROOMY = { gameCents: 1_000_000, venueCents: 1_000_000, venueOverrides: {}, holderCents: 1_000_000, notes: [] };
const receiptsPath = () => join(dir, "hedge-receipts.jsonl");
const pendingPath = () => join(dir, "lock-pending.jsonl");
const ledgerOf = (holder: string | null) => join(dir, holder ? `lock-ledger-${holder}.jsonl` : "lock-ledger.jsonl");
const keyOf = (holder: string | null) => (holder === "alice" ? ALICE_KEY : holder === "bob" ? BOB_KEY : SHARED_KEY);
const tap = async (holder: string | null, ticker: string, contracts = 20) => {
  const res = await fetch(`${base}/api/shadow/lock`, { method: "POST", headers: { "x-lock-key": keyOf(holder), "content-type": "application/json" }, body: JSON.stringify({ ticker, contracts, entryCents: 58 }) });
  return (await res.json()) as any;
};
const leave = async (holder: string | null, ticker: string) => {
  const res = await fetch(`${base}/api/shadow/unwind`, { method: "POST", headers: { "x-lock-key": keyOf(holder), "content-type": "application/json" }, body: JSON.stringify({ ticker }) });
  return (await res.json()) as any;
};
const health = async () => (await (await fetch(`${base}/healthz`, { headers: { "x-admin-token": "op-secret" } })).json()) as any;
/** the executor as hedgeExecutorFromEnv builds it in production: the day's count read from the receipt trail */
const prodExecutor = (rails: Record<string, unknown> = {}) =>
  new LiveHedgeExecutor({ kalshi: hook }, { ...DEFAULT_LIVE_RAILS, dryRun: false, allowlist: ARMED, ...rails }, (day: string) => sentUnitsMilliOn(loadHedgeReceipts(receiptsPath()), day));
const wire = (extra: Record<string, unknown> = {}) =>
  worker.wireLockEngine({ ...engine, exposureCaps: ROOMY, realOnly: { all: false, holders: [], notes: [] }, closeBooks: async () => ({ kalshi: { yesBids: [{ priceCents: 62, qtyMilli: 1_000_000 }], noBids: [{ priceCents: 38, qtyMilli: 1_000_000 }] } }), hedgeExecutor: prodExecutor(), ...extra });

/** every operator page (alerter with no channel set writes to stderr) */
const pages: string[] = [];
const realError = console.error;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "event-lock-rails-"));
  process.env.NODE_ENV = "test";
  process.env.EVENT_SHADOW_LEDGER_PATH = join(dir, "ledger.jsonl");
  process.env.EVENT_SHADOW_LOCK_LEDGER_PATH = ledgerOf(null);
  process.env.EVENT_LASTLEG_LEDGER_PATH = join(dir, "lastleg.jsonl");
  process.env.EVENT_X_ADMIN_TOKEN = "op-secret";
  process.env.EVENT_SHADOW_LOCK_KEY = SHARED_KEY;
  process.env.EVENT_SHADOW_HOLDER_KEYS = `alice:${ALICE_KEY},bob:${BOB_KEY}`;
  process.env.EVENT_HEDGE_STRATEGY = "live";
  process.env.EVENT_HEDGE_LIVE_TICKERS = ARMED.join(",");
  process.env.EVENT_HEDGE_LIVE_SEND = "yes";
  delete process.env.EVENT_HEDGE_KILL_SWITCH;
  process.env.KALSHI_API_KEY_ID = "test-key-id";
  process.env.KALSHI_PRIVATE_KEY_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  worker = await import("../scripts/eventShadowWorker");
  wire();
  await new Promise<void>((r) => worker.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
  console.error = (...a: unknown[]) => void pages.push(a.map(String).join(" "));
});
after(async () => {
  console.error = realError;
  await new Promise<void>((r) => worker.server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  for (const name of readdirSync(dir)) if (name.endsWith(".jsonl")) rmSync(join(dir, name));
  sent.length = 0;
  pages.length = 0;
  venue = async (i) => filled(i);
  wire();
});

const keypair = (() => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  return der.subarray(der.length - 32).toString("hex");
})();
const jsonRes = (status: number, body?: unknown) => new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const MISS = /with nothing (filled|sold)/;
const pod = (fetchImpl: typeof fetch) => new AggregatorOrderClient({ host: "https://pod.invalid", keyId: "7a1d2c3b-4e5f-4a6b-8c9d-0e1f2a3b4c5d", secret: keypair }, { fetchImpl, sleep: async () => {} });
const clear = async (id: string) => (await (await fetch(`${base}/api/shadow/lock/pending/clear?id=${encodeURIComponent(id)}&note=${encodeURIComponent("checked on the venue")}`, { method: "POST", headers: { "x-admin-token": "op-secret" } })).json()) as any;
const venueOpenCents = (h: any): number => h.exposure.venues.find((v: any) => v.venue === "kalshi")?.openCents ?? 0;

test("an order the pod took and never let us read is unconfirmed: counted, paged, and a second tap is not invited as after a miss", async () => {
  const podCalls: string[] = [];
  venue = pod((async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const key = `${(init?.method ?? "GET").toUpperCase()} ${u.pathname}`;
    podCalls.push(key);
    if (key === "GET /v1/time") return jsonRes(200, { time: Math.floor(Date.now() / 1000) });
    if (key === "POST /v1/kalshi/orders") return jsonRes(201, { orderId: "pod-1", status: "PENDING", filledCount: null, remainingCount: null, averagePrice: null });
    return jsonRes(502, { error: { code: "BAD_GATEWAY", message: "upstream" } });
  }) as typeof fetch).hook();
  const first = await tap("alice", BOS);
  assert.deepEqual([first.ok, first.code], [false, "hedge_unconfirmed"]);
  const trail = loadPending(pendingPath());
  const ending = trail.find((r: any) => r.type === "resolved") as any;
  assert.equal(ending.outcome, "unconfirmed");
  assert.match(ending.detail, /order pod-1 was sent and its end was not read \(every read of it failed; last seen PENDING\); it may have filled/);
  assert.doesNotMatch(ending.detail, MISS);
  const h = await health();
  assert.equal(h.lock.hedgeFirst.strays.length, 1, "the status page shows it");
  assert.ok(venueOpenCents(h) > 0, "the order is counted against the venue's cap at the most it could have cost");
  assert.equal(pages.length, 1, "the operator is paged once");
  assert.match(pages[0], /went out and was not confirmed/);
  assert.equal(loadShadowPositions(ledgerOf("alice")).length, 0, "no lock was written");
});

test("an order still pending after every read, whose cancel fails, is unconfirmed too", async () => {
  const podCalls: string[] = [];
  const pendingOrder = { orderId: "pod-2", ticker: BOS, side: "ASK", count: "6.00", status: "PENDING", venueOrderId: null, filledCount: null, averageYesPrice: null, averageNoPrice: null, feesCents: null, feesUsd: null, clientOrderId: null };
  venue = pod((async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const key = `${(init?.method ?? "GET").toUpperCase()} ${u.pathname}`;
    podCalls.push(key);
    if (key === "GET /v1/time") return jsonRes(200, { time: Math.floor(Date.now() / 1000) });
    if (key === "POST /v1/kalshi/orders") return jsonRes(201, { orderId: "pod-2", status: "PENDING", filledCount: null, remainingCount: null, averagePrice: null });
    if (key === "GET /v1/kalshi/orders/pod-2") return jsonRes(200, pendingOrder);
    return jsonRes(502, { error: { code: "BAD_GATEWAY", message: "upstream" } });
  }) as typeof fetch).hook();
  const first = await tap("bob", BOS);
  assert.deepEqual([first.ok, first.code], [false, "hedge_unconfirmed"]);
  assert.equal(podCalls.filter((c) => c.startsWith("DELETE")).length, 1, "the cancel was tried");
  assert.deepEqual(loadPending(pendingPath()).map((r: any) => r.outcome ?? r.type), ["pending", "unconfirmed"]);
  assert.equal((await health()).lock.hedgeFirst.strays.length, 1);
  assert.equal(pages.length, 1);
});

test("a filled order whose fills cannot be read is unconfirmed at the judge, never a miss", async () => {
  const MARKET = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
  const OURS = "0b3f5f20-9c1b-4d6e-8f3a-5c2d1e7b4a90";
  const OPP = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const key = `${(init?.method ?? "GET").toUpperCase()} ${u.pathname}`;
    if (key === "POST /v3/orders") return jsonRes(201, { orderId: "ord-1" });
    if (key === "GET /v3/orders/ord-1") return jsonRes(200, { orderId: "ord-1", marketId: MARKET, outcomeId: OPP, price: "0.400", qty: 2000, remaining: 0, status: "FILLED", tif: "FOK", createdTs: 1 });
    if (key === "GET /v3/portfolio/fills") return jsonRes(503, { code: "UNAVAILABLE", message: "try later" });
    return jsonRes(404, { code: "NOT_FOUND", message: key });
  }) as typeof fetch;
  const novig = new NovigOrderClient({ host: "https://novig.invalid", signer: signerFromPem("5d1f8a2c-7b3e-4c9a-9e2d-1a4b6c8d0e2f", pem), fetchImpl, settleWaitMs: 0, sleep: async () => {} });
  const intent = { ...intentFromHedge({ action: "buy", venue: "novig", outcome: "BOS", marketId: MARKET, outcomeId: OPP, offsetOutcomeId: OURS, sharesMilli: 20_000, avgPriceMilli: 395, worstPriceMilli: 400, costCents: 790 }, 390, NYK), allOrNone: true };
  const exec = new LiveHedgeExecutor({ novig: novig.hook() }, { ...DEFAULT_LIVE_RAILS, dryRun: false, allowlist: [NYK] }, () => 0);
  const receipt = await exec.execute(intent, `${NYK}@alice`);
  const verdict = judgeHedge(intent, receipt);
  assert.equal(verdict.kind, "unconfirmed");
  assert.match((verdict as { detail: string }).detail, /order ord-1 was sent and its end was not read \(the order shows a match and its fills could not be read; last seen FILLED\)/);
});

test("the day's contract rail holds while orders are out: two taps at once with room for one send one order", async () => {
  const probe = (candidate(BOS, 20, 58).quote.hedge as { contractsMilli: number }).contractsMilli;
  wire({ hedgeExecutor: prodExecutor({ maxUnitsPerDayMilli: probe + 1_000, maxUnitsPerOrderMilli: probe }) });
  venue = async (i) => {
    await new Promise((r) => setTimeout(r, 60));
    return filled(i);
  };
  const [a, b] = await Promise.all([tap("alice", BOS), tap("bob", NYK)]);
  assert.deepEqual([a.ok, b.ok].sort(), [false, true], JSON.stringify([a, b]));
  assert.equal([a, b].find((x) => !x.ok).code, "hedge_held", "the second is held by the rail before anything leaves");
  assert.equal(sent.length, 1, "one order left");
  const day = new Date().toISOString().slice(0, 10);
  assert.equal(sentUnitsMilliOn(loadHedgeReceipts(receiptsPath()), day), probe);
  const c = await tap(null, DEN);
  assert.equal(c.ok && c.hedge?.simulated === false, false, "a third, afterwards, sends nothing either");
  assert.equal(sent.length, 1);
  // the same executor counts what it sent before the trail carries it, and an order from before it started
  let onTrail = 3_000;
  const exec = new LiveHedgeExecutor({ kalshi: async (i: any) => (await new Promise((r) => setTimeout(r, 20)), filled(i)) }, { ...DEFAULT_LIVE_RAILS, dryRun: false, allowlist: ARMED, maxUnitsPerOrderMilli: 5_000, maxUnitsPerDayMilli: 12_000 }, () => onTrail);
  const intent = (ticker: string) => intentFromHedge({ venue: "kalshi", ticker, contractsMilli: 5_000, avgPriceCents: 41, worstPriceCents: 42, costCents: 205 } as any, 200);
  const three = await Promise.all([exec.execute(intent(BOS), "a"), exec.execute(intent(NYK), "b"), exec.execute(intent(DEN), "c")]);
  assert.deepEqual(three.map((r) => r.outcome), ["filled_live", "filled_book", "filled_book"], "3 on the trail + 5 + 5 would pass 12: the second and third are held");
  assert.match(three[1].fallbackReason ?? "", /rail per_day: 8 sent today plus 5 would pass the daily cap of 12/);
  onTrail = 8_000;
  assert.match((await exec.execute(intent(BOS), "d")).fallbackReason ?? "", /rail per_day: 8 sent today/, "once the receipt is on the trail it is counted once, not twice");
});

test("leave early: a sale that went out and was not confirmed closes nothing, pages, and no second sale is sent until it is cleared", async () => {
  wire({ realOnly: { all: false, holders: ["alice"], notes: [] } });
  assert.equal((await tap("alice", BOS)).ok, true);
  assert.equal((await tap("bob", NYK)).ok, true);
  pages.length = 0;
  venue = async (i) => {
    if ((i.action ?? "buy") === "sell") throw new Error("kalshi orders: HTTP 503 POST /portfolio/events/orders");
    return filled(i);
  };
  // a real-only holder and one who is not: the same ending for both
  for (const who of ["alice", "bob"] as const) {
    const ticker = who === "alice" ? BOS : NYK;
    const first = await leave(who, ticker);
    assert.deepEqual([first.ok, first.code], [false, "leave_unconfirmed"], JSON.stringify(first));
    assert.doesNotMatch(first.message, /kalshi|503|order/i, "the holder is told nothing of the venue");
    assert.equal(loadShadowPositions(ledgerOf(who)).find((p: any) => p.ticker === ticker)!.status, "open", "the lock stands");
  }
  const lines = loadPending(pendingPath()).filter((r: any) => r.type === "sale_left") as any[];
  assert.deepEqual(lines.map((l) => [l.outcome, l.ticker, l.venue]), [["unconfirmed", BOS, "kalshi"], ["unconfirmed", NYK, "kalshi"]]);
  assert.equal(pages.length, 2, "the operator is paged for each");
  assert.match(pages[0], /went out and was not confirmed.*Nothing was closed; the lock stands and no second sale will be sent/);
  const h = await health();
  assert.deepEqual(h.lock.hedgeFirst.strays, lines.map((l) => l.id), "the status page shows both");
  // the holder taps again: nothing is sent
  const sells = () => sent.filter((s) => s.action === "sell").length;
  assert.equal(sells(), 2);
  const again = await leave("alice", BOS);
  assert.deepEqual([again.ok, again.code], [false, "leave_being_checked"]);
  assert.equal(sells(), 2, "no second sale for the same hedge");
  // the operator looked at the venue and cleared the line: the holder may leave, and the sale goes out once
  assert.equal((await clear(lines[0].id)).ok, true);
  venue = async (i) => filled(i, i.unitsMilli, Math.floor((i.unitsMilli * 38) / 1000));
  const third = await leave("alice", BOS);
  assert.deepEqual([third.ok, third.status], [true, "closed"], JSON.stringify(third));
  assert.equal(sells(), 3);
  assert.equal((await leave("bob", NYK)).code, "leave_being_checked", "bob's line is still his own");
});

test("leave early: a lock closed with hedge still on the venue pages the operator, and that hedge stays counted until cleared", async () => {
  wire({ realOnly: { all: false, holders: ["alice"], notes: [] } });
  assert.equal((await tap("alice", BOS)).ok, true);
  assert.equal((await tap("bob", NYK)).ok, true);
  const hedgeMilli = sent.filter((s) => s.action === "buy").map((s) => s.unitsMilli);
  const before = await health();
  const costEach = venueOpenCents(before) / 2;
  pages.length = 0;
  // alice (real-only): the venue sells 2 contracts of her hedge and cancels the rest. bob: the sale reads to its end with nothing sold
  venue = async (i) => {
    if (i.instrument === NYK) throw new Error("kalshi orders: order ord-x canceled with nothing sold at or over 38c");
    return filled(i, 2_000, 73);
  };
  const a = await leave("alice", BOS);
  const b = await leave("bob", NYK);
  assert.deepEqual([a.ok, a.status, a.hedge.sent], [true, "closed", true], JSON.stringify(a));
  assert.deepEqual([b.ok, b.status, b.hedge.sent], [true, "closed", false], JSON.stringify(b));
  const lines = loadPending(pendingPath()).filter((r: any) => r.type === "sale_left") as any[];
  assert.deepEqual(lines.map((l) => [l.outcome, l.ticker, l.unitsMilli]), [["left_over", BOS, hedgeMilli[0] - 2_000], ["left_over", NYK, hedgeMilli[1]]]);
  assert.equal(lines[0].costCents, Math.ceil((costEach * (hedgeMilli[0] - 2_000)) / hedgeMilli[0]), "at what it cost, pro rata");
  assert.equal(lines[1].costCents, costEach, "the whole hedge, at what it cost");
  assert.equal(pages.length, 2);
  assert.match(pages[0], /the lock was closed on the record and \d+(\.\d+)? of its hedge .* is still on the venue.*Sell it by hand, then clear/);
  const afterLeave = await health();
  assert.equal(venueOpenCents(afterLeave), lines[0].costCents + lines[1].costCents, "what is left on the venue is still counted against its cap");
  assert.equal(afterLeave.exposure.counted.pendingLeftOver, 2);
  assert.equal(afterLeave.exposure.counted.realOpenLocks, 0);
  // sold by hand and cleared: the room comes back
  assert.equal((await clear(lines[0].id)).ok, true);
  assert.equal((await clear(lines[1].id)).ok, true);
  const cleared = await health();
  assert.deepEqual([venueOpenCents(cleared), cleared.exposure.counted.pendingLeftOver, cleared.lock.hedgeFirst.strays.length], [0, 0, 0]);
  // a whole sale leaves nothing behind and pages nobody
  venue = async (i) => filled(i);
  assert.equal((await tap("bob", DEN)).ok, true);
  pages.length = 0;
  venue = async (i) => filled(i, i.unitsMilli, Math.floor((i.unitsMilli * 38) / 1000));
  assert.equal((await leave("bob", DEN)).ok, true);
  assert.equal(pages.length, 0);
  assert.equal(loadPending(pendingPath()).filter((r: any) => r.type === "sale_left").length, 2);
});

test("real-only: the word shared covers the shared key and the operator acting for nobody", async () => {
  const cfg = realOnlyHoldersFromEnv({ EVENT_SHADOW_REAL_ONLY_HOLDERS: "alice,shared" } as NodeJS.ProcessEnv, ["alice", "bob"]);
  assert.deepEqual(cfg, { all: false, holders: ["alice"], shared: true, notes: [] });
  assert.deepEqual([isRealOnly(cfg, null), isRealOnly(cfg, "alice"), isRealOnly(cfg, "bob")], [true, true, false]);
  assert.equal(isRealOnly(realOnlyHoldersFromEnv({ EVENT_SHADOW_REAL_ONLY_HOLDERS: "alice" } as NodeJS.ProcessEnv, ["alice"]), null), false, "unnamed, the shared key is as it was");
  // a holder who was given the alias "shared" is covered as any alias is, and so is the shared key
  assert.deepEqual(realOnlyHoldersFromEnv({ EVENT_SHADOW_REAL_ONLY_HOLDERS: "shared" } as NodeJS.ProcessEnv, ["shared"]), { all: false, holders: ["shared"], shared: true, notes: [] });
  wire({ realOnly: cfg });
  // GSW is not armed: nothing can be sent there
  const paper = await tap(null, GSW);
  assert.deepEqual([paper.ok, paper.code], [false, "lock_not_open"], JSON.stringify(paper));
  assert.equal((await tap("alice", GSW)).code, "lock_not_open");
  const bob = await tap("bob", GSW);
  assert.deepEqual([bob.ok, bob.hedge?.simulated], [true, true], "a holder not named is as before");
  assert.equal((await health()).lock.realOnly.sharedKeyRealOnly, true);
});

test("a double tap while the holder's venue positions are being read sends one hedge order and writes one lock", async () => {
  // the holder's own venue account is readable and slow, which is where the guard used to be set too late
  wire({ venueClient: { kind: "signed", holderPositions: async () => (await new Promise((r) => setTimeout(r, 80)), []) }, realOnly: { all: false, holders: ["alice"], notes: [] } });
  const [a, b] = await Promise.all([tap("alice", BOS), tap("alice", BOS)]);
  assert.deepEqual([a.ok, b.ok].sort(), [false, true], JSON.stringify([a, b]));
  assert.equal([a, b].find((x) => !x.ok).error, "lock_in_flight");
  assert.equal(sent.filter((s) => s.action === "buy").length, 1, "one hedge order");
  const raw = readFileSync(ledgerOf("alice"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(raw.filter((r: any) => r.type === "open").length, 1, "one open line");
  assert.equal(pages.length, 0);
  // the guard is released: the same holder locks another market straight after
  assert.equal((await tap("alice", NYK)).ok, true);
  wire({ venueClient: null });
});
