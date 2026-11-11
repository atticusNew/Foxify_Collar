/**
 * Real-only holders (crossVenue/realOnlyHolders.ts) on the worker's lock path. The service runs
 * live, sending, with three games armed and one not, and a scripted venue behind the real
 * executor. bob is named real-only; alice is not.
 *
 *   - where the order would truly leave, bob's lock is the hedge-first lock it always was
 *   - where it would not (a game that is not armed), bob's quote says so and his tap is refused in
 *     plain words: no record, no receipt, no order, one line on the pending trail; alice's tap
 *     there is the simulated lock it always was
 *   - bob leaves a lock that holds a real hedge only behind a real sale of it: refused before the
 *     order when the sale would not be sent, nothing closed when the venue sold nothing
 *   - `*` covers the shared key and the operator too
 *
 * The engine and the venue are faked; nothing touches a venue.
 */

import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EarlyCloseBooks } from "../src/eventCollar/crossVenue/earlyClose";
import { actionOf, loadHedgeReceipts, type HedgeIntent } from "../src/eventCollar/crossVenue/hedgeExecutor";
import { hedgeExecutorFromEnv } from "../src/eventCollar/crossVenue/hedgeExecutorFromEnv";
import { loadPending, notRealRefusals, summarizePending, type PendingRecord } from "../src/eventCollar/crossVenue/hedgeFirst";
import { quoteLadderWrap, type NoAskLevel } from "../src/eventCollar/crossVenue/kalshiLadder";
import { DEFAULT_LIVE_RAILS, LiveHedgeExecutor, killSwitchFromEnv, type LiveOrderHook, type LiveOrderResult } from "../src/eventCollar/crossVenue/liveHedge";
import { LEAVE_NOT_OPEN, LEAVE_NOT_SOLD, LOCK_NOT_OPEN, isRealOnly, notRealOnly, notRealReason, realOnlyHoldersFromEnv, type RealOnlyHolders } from "../src/eventCollar/crossVenue/realOnlyHolders";
import { appendShadowRecord, loadShadowPositions } from "../src/eventCollar/crossVenue/shadowLedger";
import { DEFAULT_CROSS_CONFIG, type CrossQuoteResult } from "../src/eventCollar/crossVenue/types";
import type { CandidateResult, GameMarketRow, OneQuoteInputs, OneQuoteResult } from "../scripts/eventProtectXDemoService";

const BOS = "KXNBAGAME-26OCT14LALBOS-BOS";
const NYK = "KXNBAGAME-26OCT15NYKMIA-NYK";
const DEN = "KXNBAGAME-26OCT16DENPHX-DEN";
const GSW = "KXNBAGAME-26OCT17GSWSAC-GSW";
const ARMED = [BOS, NYK, DEN];
const TITLES: Record<string, [string, string]> = {
  [BOS]: ["Boston Celtics", "Lakers at Celtics"],
  [NYK]: ["New York Knicks", "Knicks at Heat"],
  [DEN]: ["Denver Nuggets", "Nuggets at Suns"],
  [GSW]: ["Golden State Warriors", "Warriors at Kings"],
};
const START = new Date(Date.now() + 3 * 3_600_000).toISOString();
const NO_ASKS: NoAskLevel[] = [
  { priceCents: 41, qtyMilli: 300_000 },
  { priceCents: 42, qtyMilli: 400_000 },
];
const SHARED_KEY = "lock-key-0123456789";
const ALICE_KEY = "alice-key-0123456789";
const BOB_KEY = "bob-key-0123456789ab";
const BOB_ONLY: RealOnlyHolders = { all: false, holders: ["bob"], notes: [] };

function quoteFor(ticker: string, contracts: number, entryCents = 58): Extract<CrossQuoteResult, { ok: true }> {
  const quote = quoteLadderWrap({ pair: { kalshi: { ticker }, gameStartTime: START }, markCents: 60, entryCents, contracts, now: new Date(), noAsks: NO_ASKS, config: DEFAULT_CROSS_CONFIG });
  assert.ok(quote.ok, JSON.stringify(quote));
  return quote;
}

function candidate(ticker: string, contracts: number, entryCents: number): CandidateResult {
  const quote = quoteFor(ticker, contracts, entryCents);
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

type Answer = { status: number; body: Record<string, unknown> & { hedge?: Record<string, unknown> } };
type Health = {
  lock: {
    realOnly: { everyone: boolean; holders: string[]; notRealOnly: string[]; notes?: string[]; refusals: { count: number; last: { at: string; ref: string; source: string; detail: string } | null } };
    hedgeFirst: { counts: Record<string, number>; unresolved: string[]; strays: string[] };
  };
  hedge: { killSwitch: boolean };
};

let dir: string;
let base: string;
let worker: typeof import("../scripts/eventShadowWorker");
const sent: HedgeIntent[] = [];
/** each order takes the next scripted answer; with none scripted the venue fills a buy whole at the walk's cost and sells the whole hedge at 38c */
const script: Array<(i: HedgeIntent) => LiveOrderResult | Promise<LiveOrderResult>> = [];
let orders = 0;
const filled = (intent: HedgeIntent): LiveOrderResult =>
  actionOf(intent) === "sell"
    ? { orderId: `ord-${++orders}`, unitsMilli: intent.unitsMilli, avgPriceMilli: 380, costCents: Math.floor((intent.unitsMilli * 38) / 1000), feesCents: 0, status: "executed" }
    : { orderId: `ord-${++orders}`, unitsMilli: intent.unitsMilli, avgPriceMilli: Math.ceil((intent.book.costCents * 10_000) / intent.unitsMilli), costCents: intent.book.costCents, feesCents: 0, status: "executed" };
const hook: LiveOrderHook = async (intent) => {
  sent.push(intent);
  const step = script.shift();
  return step ? step(intent) : filled(intent);
};
const CLOSE_BOOKS: EarlyCloseBooks = { kalshi: { yesBids: [{ priceCents: 62, qtyMilli: 1_000_000 }], noBids: [{ priceCents: 38, qtyMilli: 1_000_000 }] } };
const engine = {
  listGameMarkets: async (): Promise<GameMarketRow[]> =>
    Object.keys(TITLES).map((ticker) => ({ ticker, league: "nba", sideName: TITLES[ticker][0], title: `${TITLES[ticker][1]} Winner?`, dateIso: "2026-10-14", closeTimeIso: START, markCents: 60, startIso: START, protectable: true, protectableUntilIso: START })),
  quoteOne: async (inputs: OneQuoteInputs): Promise<OneQuoteResult> => ({ ok: true, result: candidate(inputs.ticker, inputs.contracts, inputs.entryCents ?? 58) }),
  closeBooks: async () => CLOSE_BOOKS,
};
const setRealOnly = (realOnly: RealOnlyHolders): void => worker.wireLockEngine({ ...engine, realOnly });

const ledgerOf = (holder: string | null): string => join(dir, holder ? `lock-ledger-${holder}.jsonl` : "lock-ledger.jsonl");
const receipts = () => loadHedgeReceipts(join(dir, "hedge-receipts.jsonl"));
const trail = (): PendingRecord[] => loadPending(join(dir, "lock-pending.jsonl"));
const notRealLines = () => trail().filter((r): r is Extract<PendingRecord, { type: "not_real_refused" }> => r.type === "not_real_refused");
const health = async (): Promise<Health> => (await (await fetch(`${base}/healthz?token=op-secret`)).json()) as Health;
const keyOf = (holder: string | null): string => (holder === "alice" ? ALICE_KEY : holder === "bob" ? BOB_KEY : SHARED_KEY);
const headersOf = (holder: string | null) => ({ "x-lock-key": keyOf(holder), "content-type": "application/json" });
async function call(holder: string | null, method: "GET" | "POST", path: string, body?: unknown): Promise<Answer> {
  const res = await fetch(`${base}${path}`, { method, headers: headersOf(holder), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as Answer["body"] };
}
const tap = (holder: string | null, ticker: string, contracts = 20) => call(holder, "POST", "/api/shadow/lock", { ticker, contracts, entryCents: 58 });
const quote = (holder: string | null, ticker: string, contracts = 20) => call(holder, "GET", `/api/shadow/quote?ticker=${ticker}&contracts=${contracts}&entry=58`);
const leave = (holder: string | null, ticker: string) => call(holder, "POST", "/api/shadow/unwind", { ticker });
const leaveQuote = (holder: string | null, ticker: string) => call(holder, "GET", `/api/shadow/unwind/quote?ticker=${ticker}`);
/** a refusal a holder reads: the code, the exact words, and none of the operator's detail, the terms or a venue's name */
const holderRefusal = (a: Answer, words: { code: string; message: string }, label: string): void => {
  assert.equal(a.status, 200, label);
  assert.equal(a.body.ok, false, `${label}: ${JSON.stringify(a.body)}`);
  assert.equal(a.body.code, words.code, label);
  assert.equal(a.body.message, words.message, label);
  assert.ok(!("detail" in a.body) && !("hedge" in a.body) && !("floorCents" in a.body), `${label}: no detail, no hedge, no terms`);
  assert.ok(!/kalshi|novig|prophetx|polymarket|armed|switch|[\u2013\u2014]/i.test(String(a.body.message)), String(a.body.message));
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "real-only-"));
  process.env.NODE_ENV = "test";
  process.env.EVENT_SHADOW_LEDGER_PATH = join(dir, "ledger.jsonl");
  process.env.EVENT_SHADOW_LOCK_LEDGER_PATH = ledgerOf(null);
  process.env.EVENT_LASTLEG_LEDGER_PATH = join(dir, "lastleg.jsonl");
  process.env.EVENT_X_ADMIN_TOKEN = "op-secret";
  process.env.EVENT_SHADOW_LOCK_KEY = SHARED_KEY;
  process.env.EVENT_SHADOW_HOLDER_KEYS = `alice:${ALICE_KEY},bob:${BOB_KEY}`;
  // the setting as the deploy spells it: read at start
  process.env.EVENT_SHADOW_REAL_ONLY_HOLDERS = "Bob";
  process.env.EVENT_HEDGE_STRATEGY = "live";
  process.env.EVENT_HEDGE_LIVE_TICKERS = ARMED.join(",");
  process.env.EVENT_HEDGE_LIVE_SEND = "yes";
  delete process.env.EVENT_HEDGE_KILL_SWITCH;
  for (const k of Object.keys(process.env)) if (k.startsWith("EVENT_HEDGE_LIVE_MAX_OPEN_CENTS")) delete process.env[k];
  process.env.KALSHI_API_KEY_ID = "test-key-id";
  process.env.KALSHI_PRIVATE_KEY_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  worker = await import("../scripts/eventShadowWorker");
  worker.wireLockEngine({ ...engine, hedgeExecutor: new LiveHedgeExecutor({ kalshi: hook }, { ...DEFAULT_LIVE_RAILS, dryRun: false, allowlist: ARMED }, () => 0) });
  await new Promise<void>((r) => worker.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => worker.server.close(() => r()));
});

beforeEach(() => {
  for (const name of readdirSync(dir)) if (name.endsWith(".jsonl")) rmSync(join(dir, name));
  sent.length = 0;
  script.length = 0;
  setRealOnly(BOB_ONLY);
});

test("the setting: aliases, or * for everyone; unset is nobody; an entry that cannot be read is read as everyone and said", () => {
  const known = ["alice", "bob"];
  assert.deepEqual(realOnlyHoldersFromEnv({}, known), { all: false, holders: [], notes: [] });
  assert.deepEqual(realOnlyHoldersFromEnv({ EVENT_SHADOW_REAL_ONLY_HOLDERS: "  " }, known), { all: false, holders: [], notes: [] });
  assert.deepEqual(realOnlyHoldersFromEnv({ EVENT_SHADOW_REAL_ONLY_HOLDERS: "Bob, alice\nbob" }, known), { all: false, holders: ["bob", "alice"], notes: [] });
  assert.deepEqual(realOnlyHoldersFromEnv({ EVENT_SHADOW_REAL_ONLY_HOLDERS: "*" }, known), { all: true, holders: [], notes: [] });
  assert.deepEqual(realOnlyHoldersFromEnv({ EVENT_SHADOW_REAL_ONLY_HOLDERS: "bob,*" }, known).all, true);

  // a name with no key is kept: the operator can act for a holder by name
  const carol = realOnlyHoldersFromEnv({ EVENT_SHADOW_REAL_ONLY_HOLDERS: "carol" }, known);
  assert.deepEqual([carol.all, carol.holders], [false, ["carol"]]);
  assert.match(carol.notes[0], /^EVENT_SHADOW_REAL_ONLY_HOLDERS: carol has no key in EVENT_SHADOW_HOLDER_KEYS; kept/);

  // not an alias and not *: the safe side, and it says which entry
  for (const bad of ["bob;alice", "all", "yes!", "b", "true=1"].filter((b) => !/^[a-z0-9][a-z0-9_-]{1,23}$/.test(b))) {
    const r = realOnlyHoldersFromEnv({ EVENT_SHADOW_REAL_ONLY_HOLDERS: `bob,${bad}` }, known);
    assert.equal(r.all, true, bad);
    assert.deepEqual(r.holders, ["bob"]);
    assert.match(r.notes.join(" "), /is neither a holder alias .* nor \*; read as \*, so every caller is real-only until it is corrected/);
  }

  const cfg: RealOnlyHolders = { all: false, holders: ["bob"], notes: [] };
  assert.equal(isRealOnly(cfg, "bob"), true);
  assert.equal(isRealOnly(cfg, "alice"), false);
  assert.equal(isRealOnly(cfg, null), false, "the shared key and the operator acting for nobody are not a named holder");
  assert.equal(isRealOnly({ ...cfg, all: true }, null), true);
  assert.equal(isRealOnly({ ...cfg, all: true }, "alice"), true);
  assert.deepEqual(notRealOnly(cfg, known), ["alice"]);
  assert.deepEqual(notRealOnly({ ...cfg, all: true }, known), []);

  // the operator's reasons name the setting; the holder's words name nothing
  assert.match(notRealReason("kill_switch"), /EVENT_HEDGE_KILL_SWITCH/);
  assert.match(notRealReason("dry_run"), /EVENT_HEDGE_LIVE_SEND/);
  assert.match(notRealReason("not_armed"), /EVENT_HEDGE_LIVE_TICKERS/);
  assert.match(notRealReason("not_live"), /EVENT_HEDGE_STRATEGY/);
  assert.equal(notRealReason("no_client", "polymarket"), "there is no key to send with on Polymarket");
  assert.match(notRealReason("no_intent"), /could not be built/);
  for (const w of [LOCK_NOT_OPEN, LEAVE_NOT_OPEN, LEAVE_NOT_SOLD]) assert.ok(!/EVENT_|kalshi|hedge|[\u2013\u2014]/i.test(w.message), w.message);
});

test("the kill switch stands in front of the request-for-quote strategy: with a key it builds no client and names no venue; off, it does", () => {
  const env = { EVENT_HEDGE_STRATEGY: "rfq", KALSHI_API_KEY_ID: "made-up-key-id", KALSHI_PRIVATE_KEY_PEM: "made-up" };
  const off = hedgeExecutorFromEnv(env);
  assert.deepEqual([off.strategy, off.executor.strategy, off.killSwitch, off.rfqVenues], ["rfq", "rfq", false, ["kalshi"]]);
  for (const word of ["1", "true", "YES", "on"]) {
    const on = hedgeExecutorFromEnv({ ...env, EVENT_HEDGE_KILL_SWITCH: word });
    assert.deepEqual([on.strategy, on.executor.strategy, on.killSwitch, on.rfqVenues, on.live], ["rfq", "book", true, [], null], word);
    assert.match(on.notes[0], /^rfq: KILL SWITCH ON; no request is sent and no quote can be accepted; every hedge is simulated at the book$/);
  }
  for (const word of ["", "0", "false", "off", "no"]) assert.equal(hedgeExecutorFromEnv({ ...env, EVENT_HEDGE_KILL_SWITCH: word }).rfqVenues.length, 1, `"${word}" is off`);
  // one reading for every strategy
  assert.equal(killSwitchFromEnv({ EVENT_HEDGE_KILL_SWITCH: "1" }), true);
  assert.equal(killSwitchFromEnv({}), false);
  assert.equal(hedgeExecutorFromEnv({ EVENT_HEDGE_STRATEGY: "live", EVENT_HEDGE_KILL_SWITCH: "1" }).killSwitch, true);
  assert.equal(hedgeExecutorFromEnv({ EVENT_HEDGE_KILL_SWITCH: "1" }).killSwitch, true, "said in the book strategy too, where nothing leaves anyway");
});

test("where the order would truly leave, a real-only holder's lock is the hedge-first lock it always was", async () => {
  const q = await quote("bob", BOS);
  assert.equal(q.body.ok, true, JSON.stringify(q.body));
  const a = await tap("bob", BOS);
  assert.equal(a.body.ok, true, JSON.stringify(a.body));
  assert.equal(a.body.hedge?.simulated, false);
  assert.equal(sent.length, 1);
  const [lock] = loadShadowPositions(ledgerOf("bob"));
  assert.equal(lock.hedgeFill?.orderId, a.body.hedge?.orderId);
  assert.deepEqual(summarizePending(trail()).counts, { locked: 1, refused: 0, stray: 0, unconfirmed: 0, ledger_failed: 0 });
  assert.equal(notRealLines().length, 0);

  // the venue filling nothing is the refusal it always was, not this one
  script.push(() => {
    throw new Error("kalshi orders: order ord-0 canceled with nothing filled at or under 42c");
  });
  const miss = await tap("bob", NYK);
  assert.equal(miss.body.code, "hedge_not_filled");
  assert.equal(loadShadowPositions(ledgerOf("bob")).length, 1);
});

test("where it would not, the quote says so and the tap is refused: no record, no receipt, no order, one line on the trail; a holder not named is locked on paper as before", async () => {
  // GSW is not armed
  const q = await quote("bob", GSW);
  holderRefusal({ status: q.status, body: q.body }, { code: "lock_not_open", message: "Lock in is not open on this position right now." }, "bob's quote");
  assert.equal(trail().length, 0, "a quote writes nothing");

  const a = await tap("bob", GSW);
  holderRefusal(a, LOCK_NOT_OPEN, "bob's tap");
  assert.equal(a.body.message, "Lock in is not open on this position right now. Nothing was locked.");
  assert.equal(sent.length, 0, "no order was built");
  assert.ok(!existsSync(ledgerOf("bob")), "no lock was written");
  assert.equal(receipts().length, 0, "the executor was never asked, so there is no simulated receipt either");
  assert.equal(trail().length, 1);
  const [line] = notRealLines();
  assert.deepEqual([line.ref, line.ticker, line.holder, line.source, line.why], [`${GSW}@bob`, GSW, "bob", "lock", "not_armed"]);
  assert.equal(line.detail, "bob is real-only and the hedge would not truly be bought: this game is not armed (EVENT_HEDGE_LIVE_TICKERS)");
  // it is not an order's ending and holds nothing against a cap
  assert.deepEqual(summarizePending(trail()), { unresolved: [], strays: [], counts: { locked: 0, refused: 0, stray: 0, unconfirmed: 0, ledger_failed: 0 } });

  // alice is not named: the simulated lock, exactly as before
  const paper = await tap("alice", GSW);
  assert.equal(paper.body.ok, true, JSON.stringify(paper.body));
  assert.equal(paper.body.hedge?.simulated, true);
  assert.equal((await quote("alice", GSW)).body.ok, true);
  assert.equal(sent.length, 0);
  assert.equal(notRealLines().length, 1, "no line for alice");
  const raw = readFileSync(ledgerOf("alice"), "utf8").trim().split("\n");
  assert.equal(raw.length, 1);
  assert.ok(!raw[0].includes("hedgeFill"));

  // the operator acting for bob reads the reason; acting for nobody, the operator is not a named holder
  const forBob = await fetch(`${base}/api/shadow/lock?token=op-secret&holder=bob`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticker: GSW, contracts: 5, entryCents: 58 }) });
  const forBobBody = (await forBob.json()) as { ok: boolean; code: string; detail?: string };
  assert.deepEqual([forBobBody.ok, forBobBody.code], [false, "lock_not_open"]);
  assert.equal(forBobBody.detail, "bob is real-only and the hedge would not truly be bought: this game is not armed (EVENT_HEDGE_LIVE_TICKERS)");
  const opQuote = (await (await fetch(`${base}/api/shadow/quote?token=op-secret&holder=bob&ticker=${GSW}&contracts=5`)).json()) as { ok: boolean; code: string; detail?: string };
  assert.deepEqual([opQuote.ok, opQuote.code, opQuote.detail], [false, "lock_not_open", "this game is not armed (EVENT_HEDGE_LIVE_TICKERS)"]);

  // the status page: who is named, who is not, and the refusals
  const h = await health();
  assert.deepEqual([h.lock.realOnly.everyone, h.lock.realOnly.holders, h.lock.realOnly.notRealOnly], [false, ["bob"], ["alice"]]);
  assert.equal(h.lock.realOnly.refusals.count, 2);
  assert.equal(h.lock.realOnly.refusals.last?.ref, `${GSW}@bob`);
  assert.equal(h.hedge.killSwitch, false);
  assert.deepEqual(notRealRefusals(trail()).count, 2);
  const pub = (await (await fetch(`${base}/healthz`)).json()) as Record<string, unknown>;
  assert.ok(!("lock" in pub), "who is real-only is the operator's");
});

test("* is everyone: the shared key, every holder, and the operator acting for nobody", async () => {
  setRealOnly({ all: true, holders: [], notes: [] });
  holderRefusal(await tap(null, GSW), LOCK_NOT_OPEN, "the shared key");
  holderRefusal(await tap("alice", GSW), LOCK_NOT_OPEN, "alice");
  const op = await fetch(`${base}/api/shadow/lock?token=op-secret`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticker: GSW, contracts: 5, entryCents: 58 }) });
  const opBody = (await op.json()) as { ok: boolean; code: string; detail?: string };
  assert.deepEqual([opBody.ok, opBody.code], [false, "lock_not_open"]);
  assert.match(opBody.detail ?? "", /^the caller is real-only and the hedge would not truly be bought: this game is not armed/);
  assert.equal(sent.length, 0);
  assert.ok(!existsSync(ledgerOf(null)) && !existsSync(ledgerOf("alice")));
  assert.deepEqual(notRealLines().map((l) => l.holder ?? null), [null, "alice", null]);
  assert.deepEqual((await health()).lock.realOnly.notRealOnly, []);
  // an armed game still locks for real
  assert.equal((await tap(null, BOS)).body.hedge?.simulated, false);
});

test("leaving early: a real-only holder's real hedge is sold for real or the lock stands; a holder not named keeps the old ending", async () => {
  // bob's real lock on an armed game: the leave sells the hedge at the venue and the close is written
  assert.equal((await tap("bob", BOS)).body.ok, true);
  assert.equal((await leaveQuote("bob", BOS)).body.ok, true);
  const done = await leave("bob", BOS);
  assert.equal(done.body.ok, true, JSON.stringify(done.body));
  assert.equal((done.body.hedge as { sent: boolean }).sent, true);
  assert.equal(loadShadowPositions(ledgerOf("bob"))[0].status, "closed");
  assert.deepEqual(sent.map(actionOf), ["buy", "sell"]);

  // the venue sells nothing: nothing is closed, the lock stands, the trail says so
  assert.equal((await tap("bob", NYK)).body.ok, true);
  script.push(() => {
    throw new Error("kalshi orders: order ord-0 canceled with nothing sold at or over 38c");
  });
  const unsold = await leave("bob", NYK);
  holderRefusal(unsold, LEAVE_NOT_SOLD, "the venue sold nothing");
  const nyk = loadShadowPositions(ledgerOf("bob")).find((p) => p.ticker === NYK);
  assert.equal(nyk?.status, "open", "the lock stands");
  assert.equal(readFileSync(ledgerOf("bob"), "utf8").trim().split("\n").length, 3, "open, close, open: no close line for the leave that sold nothing");
  const unsoldLine = notRealLines().at(-1);
  assert.deepEqual([unsoldLine?.ref, unsoldLine?.source, unsoldLine?.why], [`${NYK}@bob`, "leave", "not_sold"]);
  assert.match(unsoldLine?.detail ?? "", /^bob is real-only and the hedge could not truly be sold: the hedge sale is recorded at the book's price and not sent/);
  // tried again with the venue answering, it closes
  assert.equal((await leave("bob", NYK)).body.ok, true);

  // a real hedge on a game that is no longer armed (the line as a real lock leaves it): refused before any order
  const q = quoteFor(GSW, 20);
  assert.ok(q.hedge.venue === "kalshi");
  const hedgeLeg = q.hedge;
  const realLine = (holder: string): Parameters<typeof appendShadowRecord>[1] => ({
    type: "open",
    at: new Date().toISOString(),
    ticker: GSW,
    kind: "sports",
    league: "nba",
    sideName: "Golden State Warriors",
    eventTitle: "Warriors at Kings",
    eventTimeIso: START,
    contracts: 20,
    markCents: 60,
    floorCents: q.floorCents,
    capCents: q.capCents,
    creditCents: q.creditCents,
    evCostBps: q.evCostBps,
    route: "kalshi_self",
    feesCents: q.feesCents,
    takeCents: q.takeCents,
    hedgeCostCents: hedgeLeg.costCents,
    hedgeUnitsMilli: hedgeLeg.contractsMilli,
    tier: q.tier,
    source: "lock",
    entryCents: 58,
    holder,
    hedgeFill: { venue: "kalshi", unitsMilli: hedgeLeg.contractsMilli, costCents: hedgeLeg.costCents, orderId: "ord-earlier", receiptId: "rcpt-earlier" },
  });
  appendShadowRecord(ledgerOf("bob"), realLine("bob"));
  const before = sent.length;
  const linesBefore = readFileSync(ledgerOf("bob"), "utf8").trim().split("\n").length;
  holderRefusal(await leaveQuote("bob", GSW), LEAVE_NOT_OPEN, "bob's leave quote, the sale would not be sent");
  holderRefusal(await leave("bob", GSW), LEAVE_NOT_OPEN, "bob's leave, the sale would not be sent");
  assert.equal(sent.length, before, "no order was built");
  assert.equal(readFileSync(ledgerOf("bob"), "utf8").trim().split("\n").length, linesBefore, "nothing was written to the ledger");
  assert.equal(loadShadowPositions(ledgerOf("bob")).find((p) => p.ticker === GSW)?.status, "open");
  assert.deepEqual([notRealLines().at(-1)?.source, notRealLines().at(-1)?.why], ["leave", "not_armed"]);

  // alice is not named: the same line closes on the record with the sale not sent, as it always did
  appendShadowRecord(ledgerOf("alice"), realLine("alice"));
  const old = await leave("alice", GSW);
  assert.equal(old.body.ok, true, JSON.stringify(old.body));
  assert.equal((old.body.hedge as { sent: boolean }).sent, false);
  assert.equal(loadShadowPositions(ledgerOf("alice"))[0].status, "closed");

  // a real-only holder's lock with no real hedge behind it (written before they were named): nothing to sell, so it leaves on paper
  rmSync(ledgerOf("bob"));
  const { hedgeFill: _none, ...paperLine } = realLine("bob") as Record<string, unknown>;
  appendShadowRecord(ledgerOf("bob"), paperLine as Parameters<typeof appendShadowRecord>[1]);
  const paper = await leave("bob", GSW);
  assert.equal(paper.body.ok, true, JSON.stringify(paper.body));
  assert.equal(loadShadowPositions(ledgerOf("bob"))[0].status, "closed");
});

test("a wrong operator token on the status page is said, and the public view is all it gets", async () => {
  const plain = (await (await fetch(`${base}/healthz`)).json()) as Record<string, unknown>;
  assert.ok(!("operator" in plain) && !("note" in plain), "no token sent: the public view as it always was");
  for (const res of [await fetch(`${base}/healthz?token=wrong`), await fetch(`${base}/healthz`, { headers: { "x-admin-token": "wrong" } }), await fetch(`${base}/healthz`, { headers: { authorization: "Bearer wrong" } })]) {
    assert.equal(res.status, 200, "the host's health check must still read 200");
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.operator, false);
    assert.equal(body.note, "The token sent was not accepted. This is the public view.");
    assert.deepEqual(Object.keys(body).sort(), [...Object.keys(plain), "note", "operator"].sort(), "nothing of the operator's view");
  }
  const op = (await (await fetch(`${base}/healthz?token=op-secret`)).json()) as Record<string, unknown>;
  assert.ok("lock" in op && !("note" in op));
});
