/**
 * The exposure caps on the worker's real-money lock path (crossVenue/exposureCaps.ts, step 0 of
 * hedgeFirst.ts). The service runs live, armed and sending, with a scripted venue behind the real
 * executor: each cap refuses the first cent over and passes at the cap, before any order is
 * built; the refusal is on the pending trail and on the status page; a settled, voided or
 * unwound lock frees its room; two locks arriving together are measured against each other; a
 * simulated lock is written exactly as before, whatever the caps; the operator's resend of a
 * hedge passes the same gate. The engine and the venue are faked; nothing touches a venue.
 */

import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costCentsAt, loadHedgeReceipts, type HedgeIntent } from "../src/eventCollar/crossVenue/hedgeExecutor";
import { SHARED_HOLDER, type ExposureCaps, type ExposureView } from "../src/eventCollar/crossVenue/exposureCaps";
import { loadPending, summarizePending, type CapRefusalLine, type PendingRecord } from "../src/eventCollar/crossVenue/hedgeFirst";
import { quoteLadderWrap, type NoAskLevel } from "../src/eventCollar/crossVenue/kalshiLadder";
import { DEFAULT_LIVE_RAILS, LiveHedgeExecutor, type LiveOrderHook, type LiveOrderResult } from "../src/eventCollar/crossVenue/liveHedge";
import { appendShadowRecord, loadShadowPositions } from "../src/eventCollar/crossVenue/shadowLedger";
import { DEFAULT_CROSS_CONFIG, type CrossQuoteResult } from "../src/eventCollar/crossVenue/types";
import type { CandidateResult, GameMarketRow, OneQuoteInputs, OneQuoteResult } from "../scripts/eventProtectXDemoService";

// one game, both sides; two more games; one game the live rails do not arm (its locks are simulated)
const BOS = "KXNBAGAME-26OCT14LALBOS-BOS";
const LAL = "KXNBAGAME-26OCT14LALBOS-LAL";
const NYK = "KXNBAGAME-26OCT15NYKMIA-NYK";
const DEN = "KXNBAGAME-26OCT16DENPHX-DEN";
const GSW = "KXNBAGAME-26OCT17GSWSAC-GSW";
const ARMED = [BOS, LAL, NYK, DEN];
const GAME = "nba:26OCT14LALBOS";
const TITLES: Record<string, [string, string]> = {
  [BOS]: ["Boston Celtics", "Lakers at Celtics"],
  [LAL]: ["Los Angeles Lakers", "Lakers at Celtics"],
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

/**
 * What a lock of this size adds to each sum, worked here from the quote alone (the module under
 * test is not asked): at the gate the hedge is counted at the most its order can cost; once
 * filled, at what the venue charged (`fill`, the walk's cost in this file's scripted venue).
 */
function sumsFor(contracts: number) {
  const q = quoteFor(BOS, contracts);
  assert.ok(q.hedge.venue === "kalshi");
  const reserve = Math.max(q.hedge.costCents, costCentsAt(q.hedge.contractsMilli, q.hedge.worstPriceCents * 10)) + q.feesCents;
  const floorOwed = Math.round(q.floorCents * q.contracts);
  const holder = Math.max(floorOwed + q.creditCents, Math.floor((100 - q.capCents) * q.contracts));
  return {
    gameAdd: floorOwed + q.creditCents + reserve,
    venueAdd: reserve,
    holderAdd: holder,
    fill: q.hedge.costCents,
    gameOpen: floorOwed + q.creditCents + q.hedge.costCents,
    unitsMilli: q.hedge.contractsMilli,
  };
}
const S20 = sumsFor(20);
const S5 = sumsFor(5);

const ROOMY: ExposureCaps = { gameCents: 1_000_000, venueCents: 1_000_000, venueOverrides: {}, holderCents: 1_000_000, notes: [] };

type Health = { exposure: ExposureView & { refusals: { count: number; last: { at: string; ref: string; source: string; detail: string } | null } }; lock: { hedgeFirst: { counts: Record<string, number>; unresolved: string[]; strays: string[] } } };
type LockAnswer = { status: number; body: Record<string, unknown> & { hedge?: Record<string, unknown> } };

let dir: string;
let base: string;
let worker: typeof import("../scripts/eventShadowWorker");
const sent: HedgeIntent[] = [];
/** each order takes the next scripted answer; with none scripted the venue fills the whole size at the walk's cost */
const script: Array<(i: HedgeIntent) => LiveOrderResult | Promise<LiveOrderResult>> = [];
let orders = 0;
const filled = (intent: HedgeIntent, unitsMilli = intent.unitsMilli, costCents = intent.book.costCents): LiveOrderResult => ({
  orderId: `ord-${++orders}`,
  unitsMilli,
  avgPriceMilli: Math.ceil((costCents * 10_000) / unitsMilli),
  costCents,
  feesCents: 0,
  status: "executed",
});
const hook: LiveOrderHook = async (intent) => {
  sent.push(intent);
  const step = script.shift();
  return step ? step(intent) : filled(intent);
};
const engine = {
  listGameMarkets: async (): Promise<GameMarketRow[]> =>
    Object.keys(TITLES).map((ticker) => ({ ticker, league: "nba", sideName: TITLES[ticker][0], title: `${TITLES[ticker][1]} Winner?`, dateIso: "2026-10-14", closeTimeIso: START, markCents: 60, startIso: START, protectable: true, protectableUntilIso: START })),
  quoteOne: async (inputs: OneQuoteInputs): Promise<OneQuoteResult> => ({ ok: true, result: candidate(inputs.ticker, inputs.contracts, inputs.entryCents ?? 58) }),
};
const setCaps = (caps: Partial<ExposureCaps>): void => worker.wireLockEngine({ ...engine, exposureCaps: { ...ROOMY, ...caps } });

const ledgerOf = (holder: string | null): string => join(dir, holder ? `lock-ledger-${holder}.jsonl` : "lock-ledger.jsonl");
const pendingPath = (): string => join(dir, "lock-pending.jsonl");
const trail = (): PendingRecord[] => loadPending(pendingPath());
const capLines = () => trail().filter((r): r is Extract<PendingRecord, { type: "cap_refused" }> => r.type === "cap_refused");
const health = async (): Promise<Health> => (await (await fetch(`${base}/healthz?token=op-secret`)).json()) as Health;
const keyOf = (holder: string | null): string => (holder === "alice" ? ALICE_KEY : holder === "bob" ? BOB_KEY : SHARED_KEY);
async function tap(holder: string | null, ticker: string, contracts = 20): Promise<LockAnswer> {
  const res = await fetch(`${base}/api/shadow/lock`, { method: "POST", headers: { "x-lock-key": keyOf(holder), "content-type": "application/json" }, body: JSON.stringify({ ticker, contracts, entryCents: 58 }) });
  return { status: res.status, body: (await res.json()) as LockAnswer["body"] };
}
const refused = (a: LockAnswer, label: string): void => {
  assert.equal(a.status, 200, label);
  assert.equal(a.body.ok, false, label);
  assert.equal(a.body.code, "exposure_cap", `${label}: ${JSON.stringify(a.body)}`);
  assert.match(String(a.body.message), /Nothing was locked\./);
  assert.ok(!("hedge" in a.body) && !("floorCents" in a.body) && !("detail" in a.body), "a holder's refusal carries no terms, no hedge and none of the operator's detail");
  assert.ok(!/kalshi|novig|[\u2013\u2014]/i.test(String(a.body.message)), String(a.body.message));
};
const locked = (a: LockAnswer, label: string): void => {
  assert.equal(a.body.ok, true, `${label}: ${JSON.stringify(a.body)}`);
  assert.equal(a.body.hedge?.simulated, false, label);
};
const lastCap = (): CapRefusalLine[] => capLines().at(-1)?.caps ?? [];
const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond(), "timed out waiting");
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "exposure-gate-"));
  process.env.NODE_ENV = "test";
  process.env.EVENT_SHADOW_LEDGER_PATH = join(dir, "ledger.jsonl");
  process.env.EVENT_SHADOW_LOCK_LEDGER_PATH = ledgerOf(null);
  process.env.EVENT_LASTLEG_LEDGER_PATH = join(dir, "lastleg.jsonl");
  process.env.EVENT_X_ADMIN_TOKEN = "op-secret";
  process.env.EVENT_SHADOW_LOCK_KEY = SHARED_KEY;
  process.env.EVENT_SHADOW_HOLDER_KEYS = `alice:${ALICE_KEY},bob:${BOB_KEY}`;
  // everything that lets an order leave: live, armed (four markets; GSW is not), send on
  process.env.EVENT_HEDGE_STRATEGY = "live";
  process.env.EVENT_HEDGE_LIVE_TICKERS = ARMED.join(",");
  process.env.EVENT_HEDGE_LIVE_SEND = "yes";
  delete process.env.EVENT_HEDGE_KILL_SWITCH;
  // no cap is set in this env: the service starts on the documented defaults
  for (const k of Object.keys(process.env)) if (k.startsWith("EVENT_HEDGE_LIVE_MAX_OPEN_CENTS")) delete process.env[k];
  // a throwaway key so the Kalshi client exists; the executor below replaces it, so it signs nothing
  process.env.KALSHI_API_KEY_ID = "test-key-id";
  process.env.KALSHI_PRIVATE_KEY_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  worker = await import("../scripts/eventShadowWorker");
  // the executor counts what it has sent itself today (liveHedge.ts); this file is about the exposure caps, so the day's rail is set out of the way
  worker.wireLockEngine({ ...engine, hedgeExecutor: new LiveHedgeExecutor({ kalshi: hook }, { ...DEFAULT_LIVE_RAILS, dryRun: false, allowlist: ARMED, maxUnitsPerDayMilli: 100_000_000 }, () => 0) });
  await new Promise<void>((r) => worker.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => worker.server.close(() => r()));
});

// every test starts from an empty record: this file's own temp directory, never a ledger anyone keeps
beforeEach(() => {
  for (const name of readdirSync(dir)) if (name.endsWith(".jsonl")) rmSync(join(dir, name));
  sent.length = 0;
  script.length = 0;
});

test("unset, the service runs on the default caps; the operator's status page shows open, cap and room; the public one shows none of it", async () => {
  const h = await health();
  assert.deepEqual(h.exposure.caps, { perGameCents: 5_000, perVenueCents: { default: 10_000 }, perHolderCents: 5_000 });
  assert.deepEqual(h.exposure.games, { open: 0, top: [] });
  assert.deepEqual(h.exposure.venues, [{ venue: "kalshi", openCents: 0, capCents: 10_000, roomCents: 10_000 }], "the venue with a live client, with all its room");
  assert.deepEqual(h.exposure.holders, [
    { holder: "alice", locks: 0, openCents: 0, capCents: 5_000, roomCents: 5_000 },
    { holder: "bob", locks: 0, openCents: 0, capCents: 5_000, roomCents: 5_000 },
  ]);
  assert.deepEqual(h.exposure.counted, { realOpenLocks: 0, simulatedOpenLocksNotCounted: 0, pendingUnresolved: 0, pendingLeftOver: 0 });
  assert.deepEqual(h.exposure.refusals, { count: 0, last: null });

  const pub = await fetch(`${base}/healthz`);
  assert.equal(pub.status, 200);
  assert.ok(!("exposure" in ((await pub.json()) as object)), "who has what open is the operator's");

  // on the defaults a $12 position locks, and the page says what it took
  locked(await tap("alice", BOS), "20 contracts under the default caps");
  const after = await health();
  assert.deepEqual(after.exposure.games.top, [{ game: GAME, title: "Lakers at Celtics", locks: 1, openCents: S20.gameOpen, capCents: 5_000, roomCents: 5_000 - S20.gameOpen }]);
  assert.deepEqual(after.exposure.venues, [{ venue: "kalshi", openCents: S20.fill, capCents: 10_000, roomCents: 10_000 - S20.fill }]);
  assert.deepEqual(after.exposure.holders[0], { holder: "alice", locks: 1, openCents: S20.holderAdd, capCents: 5_000, roomCents: 5_000 - S20.holderAdd });
  assert.deepEqual(after.exposure.counted, { realOpenLocks: 1, simulatedOpenLocksNotCounted: 0, pendingUnresolved: 0, pendingLeftOver: 0 });

  // a cap set to none says so, in the cap and in the room
  setCaps({ gameCents: null, venueOverrides: { kalshi: null } });
  const off = await health();
  assert.equal(off.exposure.caps.perGameCents, "no cap");
  assert.deepEqual(off.exposure.caps.perVenueCents, { default: 1_000_000, kalshi: "no cap" });
  assert.deepEqual([off.exposure.games.top[0].capCents, off.exposure.games.top[0].roomCents], ["no cap", "no cap"]);
  assert.deepEqual([off.exposure.venues[0].capCents, off.exposure.venues[0].roomCents], ["no cap", "no cap"]);
});

test("per game: one cent over is refused before any order, on the record; at the cap it locks; the other side of the game by another holder counts on the same game", async () => {
  // nothing open: the lock alone, one cent over
  setCaps({ gameCents: S20.gameAdd - 1 });
  const over = await tap("alice", BOS);
  refused(over, "one cent over the game cap");
  assert.match(String(over.body.message), /^This lock would go over what can be open at once: \$0\.01 over the limit for this game\. Nothing was locked\. A smaller size may fit\.$/);
  assert.equal(sent.length, 0, "no order was built, let alone sent");
  assert.equal(loadShadowPositions(ledgerOf("alice")).length, 0, "no lock was written");
  assert.equal(loadHedgeReceipts(join(dir, "hedge-receipts.jsonl")).length, 0, "the executor was never asked");

  // on the record: one line on the pending trail, complete in itself
  assert.equal(trail().length, 1);
  const [line] = capLines();
  assert.equal(line.ref, `${BOS}@alice`);
  assert.equal(line.holder, "alice");
  assert.equal(line.source, "lock");
  assert.deepEqual(line.terms, { contracts: 20, tier: quoteFor(BOS, 20).tier, floorCents: quoteFor(BOS, 20).floorCents, capCents: quoteFor(BOS, 20).capCents, creditCents: quoteFor(BOS, 20).creditCents });
  assert.equal(line.order.venue, "kalshi");
  assert.equal(line.order.unitsMilli, S20.unitsMilli);
  assert.deepEqual(line.caps, [{ cap: "game", key: GAME, openCents: 0, addCents: S20.gameAdd, capCents: S20.gameAdd - 1, overByCents: 1 }]);
  assert.match(line.detail, /^per-game cap on nba:26OCT14LALBOS: \$0\.00 open now plus \$\d+\.\d\d for this one is \$\d+\.\d\d, over the cap of \$\d+\.\d\d by \$0\.01$/);
  // and on the status page; it is not one of an order's endings, so the hedge-first counts do not move
  const h = await health();
  assert.equal(h.exposure.refusals.count, 1);
  assert.deepEqual(h.exposure.refusals.last, { at: line.at, ref: line.ref, source: "lock", detail: line.detail });
  assert.deepEqual(h.lock.hedgeFirst.counts, { locked: 0, refused: 0, stray: 0, unconfirmed: 0, ledger_failed: 0 });
  assert.deepEqual([h.lock.hedgeFirst.unresolved, h.lock.hedgeFirst.strays], [[], []], "nothing for the operator to clear");

  // exactly at the cap: it locks, and the line carries the fill that bought its hedge
  setCaps({ gameCents: S20.gameAdd });
  const ok = await tap("alice", BOS);
  locked(ok, "exactly at the game cap");
  assert.equal(sent.length, 1);
  const [lock] = loadShadowPositions(ledgerOf("alice"));
  assert.deepEqual(lock.hedgeFill, { venue: "kalshi", unitsMilli: S20.unitsMilli, costCents: S20.fill, orderId: ok.body.hedge?.orderId, receiptId: ok.body.hedge?.receiptId });
  // the attempt's own line said what it held while the order was out
  const asked = trail().find((r) => r.type === "pending") as Extract<PendingRecord, { type: "pending" }>;
  assert.deepEqual(asked.reserve, { game: GAME, gameCents: S20.gameAdd, venueCents: S20.venueAdd, holderCents: S20.holderAdd });
  assert.equal((await health()).exposure.games.top[0].openCents, S20.gameOpen, "once filled, the game holds the fill's own cost");

  // bob, the other side of the same game: measured on top of alice's lock
  setCaps({ gameCents: S20.gameOpen + S20.gameAdd - 1 });
  refused(await tap("bob", LAL), "the other side, one cent over");
  assert.deepEqual(lastCap(), [{ cap: "game", key: GAME, openCents: S20.gameOpen, addCents: S20.gameAdd, capCents: S20.gameOpen + S20.gameAdd - 1, overByCents: 1 }]);
  assert.equal(sent.length, 1);
  // a smaller one fits under the same cap
  locked(await tap("bob", LAL, 5), "a smaller size fits");
  // and another game is not this game
  locked(await tap("bob", NYK), "another game has its own room");
  const end = await health();
  assert.deepEqual(end.exposure.games.top.map((g) => [g.game, g.locks, g.openCents]), [[GAME, 2, S20.gameOpen + S5.gameOpen], ["nba:26OCT15NYKMIA", 1, S20.gameOpen]]);
  assert.equal(end.exposure.games.top[0].roomCents, S20.gameAdd - 1 - S5.gameOpen);
  assert.equal(end.exposure.refusals.count, 2);
});

test("per venue: one cent over is refused, at the cap it locks; a venue's own cap is the one that binds it; the holder is not told which venue", async () => {
  // the venue-wide cap is roomy; this venue's own is one cent short
  setCaps({ venueOverrides: { kalshi: S20.venueAdd - 1 } });
  const over = await tap("alice", BOS);
  refused(over, "one cent over the venue's own cap");
  assert.equal(over.body.message, "This lock would go over what can be open at once: $0.01 over the limit for where the other side is bought. Nothing was locked. A smaller size may fit.");
  assert.deepEqual(lastCap(), [{ cap: "venue", key: "kalshi", openCents: 0, addCents: S20.venueAdd, capCents: S20.venueAdd - 1, overByCents: 1 }]);
  assert.match(capLines()[0].detail, /^per-venue cap on Kalshi: /, "the operator's line names the venue");
  assert.equal(sent.length, 0);

  setCaps({ venueOverrides: { kalshi: S20.venueAdd } });
  locked(await tap("alice", BOS), "exactly at the venue cap");

  // what rests on the venue now is what the fill cost (the quoted fees were set aside and not charged), and the next lock is measured on top of it
  assert.ok(S20.fill < S20.venueAdd);
  setCaps({ venueCents: S20.fill + S20.venueAdd - 1 });
  refused(await tap("bob", NYK), "another game, the same venue, one cent over");
  assert.deepEqual(lastCap(), [{ cap: "venue", key: "kalshi", openCents: S20.fill, addCents: S20.venueAdd, capCents: S20.fill + S20.venueAdd - 1, overByCents: 1 }]);
  setCaps({ venueCents: S20.fill + S20.venueAdd });
  locked(await tap("bob", NYK), "exactly at the venue cap");
  // another venue capped at nothing does not touch a lock hedged here
  setCaps({ venueOverrides: { novig: 0, prophetx: 0, polymarket: 0 } });
  locked(await tap(null, DEN), "other venues' caps are theirs");
  const h = await health();
  assert.equal(h.exposure.venues.find((v) => v.venue === "kalshi")?.openCents, 3 * S20.fill);
  assert.deepEqual(h.exposure.venues.find((v) => v.venue === "novig"), { venue: "novig", openCents: 0, capCents: 0, roomCents: 0 }, "a venue with its own cap is listed");
  assert.equal(sent.length, 3);
});

test("per holder: one cent over is refused, at the cap it locks; each holder, and the shared key, has their own room", async () => {
  setCaps({ holderCents: S20.holderAdd - 1 });
  const over = await tap("alice", BOS);
  refused(over, "one cent over the holder cap");
  assert.match(String(over.body.message), /^This lock would go over what can be open at once: \$0\.01 over your own limit of \$\d+\.\d\d\. Nothing was locked\. A smaller size may fit\.$/);
  assert.deepEqual(lastCap(), [{ cap: "holder", key: "alice", openCents: 0, addCents: S20.holderAdd, capCents: S20.holderAdd - 1, overByCents: 1 }]);
  assert.equal(sent.length, 0);

  setCaps({ holderCents: S20.holderAdd });
  locked(await tap("alice", BOS), "exactly at the holder cap");
  // alice is full: another game is refused for her, with no smaller size suggested
  const full = await tap("alice", NYK, 5);
  refused(full, "alice has no room left");
  assert.ok(!/smaller size/.test(String(full.body.message)));
  assert.deepEqual(lastCap(), [{ cap: "holder", key: "alice", openCents: S20.holderAdd, addCents: S5.holderAdd, capCents: S20.holderAdd, overByCents: S5.holderAdd }]);
  // bob and the shared key each have their own
  locked(await tap("bob", NYK), "bob's room is his own");
  locked(await tap(null, DEN), "the shared key is a holder of its own");
  refused(await tap(null, LAL, 5), "and it is full too");
  assert.equal(lastCap()[0].key, SHARED_HOLDER);
  assert.match(capLines().at(-1)?.detail ?? "", /^per-holder cap for the shared key: /);
  const h = await health();
  assert.deepEqual(h.exposure.holders.map((x) => [x.holder, x.locks, x.openCents, x.roomCents]), [[SHARED_HOLDER, 1, S20.holderAdd, 0], ["alice", 1, S20.holderAdd, 0], ["bob", 1, S20.holderAdd, 0]]);
  assert.equal(sent.length, 3);

  // every cap passed is named, in order, to the operator; the operator's own tap also reads the detail
  setCaps({ gameCents: 0, venueCents: 0, holderCents: 0 });
  const res = await fetch(`${base}/api/shadow/lock?token=op-secret`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticker: BOS, contracts: 5, entryCents: 58 }) });
  const body = (await res.json()) as { ok: boolean; code: string; message: string; detail?: string };
  assert.equal(body.code, "exposure_cap");
  assert.deepEqual(lastCap().map((c) => c.cap), ["game", "venue", "holder"]);
  assert.match(body.detail ?? "", /^per-game cap on .*; per-venue cap on Kalshi: .*; per-holder cap for the shared key: /);
  assert.equal(sent.length, 3);
});

test("a settled, a voided and an unwound lock each free their room, on the game, the venue and the holder", async () => {
  // room for exactly one lock of this size on each sum
  setCaps({ gameCents: S20.gameAdd, venueCents: S20.venueAdd, holderCents: S20.holderAdd });
  const endings: Array<[string, (ticker: string) => Parameters<typeof appendShadowRecord>[1]]> = [
    ["settled", (ticker) => ({ type: "settle", at: new Date().toISOString(), ticker, result: "no" })],
    ["void", (ticker) => ({ type: "void", at: new Date().toISOString(), ticker, reason: "postponed and rebooked" })],
    ["closed", (ticker) => ({ type: "close", at: new Date().toISOString(), ticker, priced: true, positionProceedsCents: 1_100, hedgeProceedsCents: 230, feesCents: 9, protectedAtCloseCents: 1_150 })],
  ];
  let orders = 0;
  for (const [i, [status, line]] of endings.entries()) {
    const first = [BOS, NYK, DEN][i];
    const next = [NYK, DEN, LAL][i];
    locked(await tap("alice", first), `${status}: the lock that fills the room`);
    orders += 1;
    // full on all three: the same holder on another game, the same venue
    refused(await tap("alice", next), `${status}: no room while it stands`);
    assert.deepEqual(lastCap().map((c) => c.cap), ["venue", "holder"]);
    // and the other side of the same game by someone else
    refused(await tap("bob", first === BOS ? LAL : first), `${status}: the game is full too`);
    assert.ok(lastCap().some((c) => c.cap === (first === BOS ? "game" : "venue")));
    assert.equal(sent.length, orders, "no order for either refusal");
    const full = await health();
    assert.deepEqual([full.exposure.games.open, full.exposure.venues[0].roomCents, full.exposure.holders.find((h) => h.holder === "alice")?.roomCents], [1, S20.venueAdd - S20.fill, 0]);

    // the ledger says it ended: one appended line, nothing edited
    appendShadowRecord(ledgerOf("alice"), line(first));
    assert.equal(loadShadowPositions(ledgerOf("alice")).find((p) => p.ticker === first)?.status, status);
    const freed = await health();
    assert.deepEqual(freed.exposure.games, { open: 0, top: [] }, `${status}: nothing open on any game`);
    assert.deepEqual(freed.exposure.venues, [{ venue: "kalshi", openCents: 0, capCents: S20.venueAdd, roomCents: S20.venueAdd }]);
    assert.deepEqual(freed.exposure.holders.find((h) => h.holder === "alice"), { holder: "alice", locks: 0, openCents: 0, capCents: S20.holderAdd, roomCents: S20.holderAdd });
    assert.equal(freed.exposure.counted.realOpenLocks, 0);
  }
  // the room freed three times over was used three times: the last lock stands on what the unwound one left
  locked(await tap("alice", LAL), "the room an unwound lock left");
  assert.equal(sent.length, 4);
});

test("two locks arriving together are measured against each other: the first one's order in flight holds its room, and gives it back if nothing fills", async () => {
  // room for one lock of this size on the game, on the venue and for one holder; not for two
  setCaps({ gameCents: 2 * S20.gameAdd - 1, venueCents: 2 * S20.venueAdd - 1, holderCents: 2 * S20.holderAdd - 1 });
  const venue = { answer: () => {} };
  const held = (i: HedgeIntent): Promise<LiveOrderResult> => new Promise((r) => (venue.answer = () => r(filled(i))));

  // alice's order is out and the venue has not answered
  script.push(held);
  const first = tap("alice", BOS);
  try {
    await until(() => sent.length === 1);
    assert.equal(loadShadowPositions(ledgerOf("alice")).length, 0, "no lock yet: the hedge is bought first");
    const flying = await health();
    assert.deepEqual(flying.exposure.counted, { realOpenLocks: 0, simulatedOpenLocksNotCounted: 0, pendingUnresolved: 1, pendingLeftOver: 0 });
    assert.deepEqual(flying.exposure.games.top, [{ game: GAME, title: null, locks: 0, openCents: S20.gameAdd, capCents: 2 * S20.gameAdd - 1, roomCents: S20.gameAdd - 1 }], "the attempt holds what the gate set aside");
    assert.equal(flying.exposure.venues[0].openCents, S20.venueAdd);
    assert.deepEqual(flying.exposure.holders[0], { holder: "alice", locks: 0, openCents: S20.holderAdd, capCents: 2 * S20.holderAdd - 1, roomCents: S20.holderAdd - 1 });

    // bob arrives on the other side of the same game while it is out: refused against alice's attempt, no order
    const second = await tap("bob", LAL);
    refused(second, "the second lock while the first is in flight");
    assert.deepEqual(lastCap(), [
      { cap: "game", key: GAME, openCents: S20.gameAdd, addCents: S20.gameAdd, capCents: 2 * S20.gameAdd - 1, overByCents: 1 },
      { cap: "venue", key: "kalshi", openCents: S20.venueAdd, addCents: S20.venueAdd, capCents: 2 * S20.venueAdd - 1, overByCents: 1 },
    ]);
    assert.equal(sent.length, 1);
    // alice herself, on another game, is refused on the venue and on her own cap for the same reason
    refused(await tap("alice", NYK), "the same holder while her first is in flight");
    assert.deepEqual(lastCap().map((c) => [c.cap, c.openCents, c.overByCents]), [["venue", S20.venueAdd, 1], ["holder", S20.holderAdd, 1]]);
    assert.equal(sent.length, 1);

  } finally {
    // the venue answers (also when a check above failed: an order left out would hold the server open)
    venue.answer();
  }
  // alice's lock stands, at the fill's cost
  locked(await first, "the first lock");
  assert.deepEqual((await health()).exposure.counted, { realOpenLocks: 1, simulatedOpenLocksNotCounted: 0, pendingUnresolved: 0, pendingLeftOver: 0 });

  // the same race with nothing awaited between the two taps, the venue slow to answer both: exactly
  // one passes, whichever the server read first. The caps fit one lock and not two, whether the
  // first is still out (held at the most it can cost) or already filled (at what it cost).
  for (const name of readdirSync(dir)) if (name.endsWith(".jsonl")) rmSync(join(dir, name));
  sent.length = 0;
  setCaps({ gameCents: S20.gameOpen + S20.gameAdd - 1, venueCents: S20.fill + S20.venueAdd - 1 });
  const slow = async (i: HedgeIntent): Promise<LiveOrderResult> => {
    await new Promise((r) => setTimeout(r, 40));
    return filled(i);
  };
  script.push(slow, slow);
  const both = await Promise.all([tap("alice", BOS), tap("bob", LAL)]);
  assert.deepEqual(both.map((b) => b.body.ok).sort(), [false, true], JSON.stringify(both.map((b) => b.body)));
  assert.equal(both.find((b) => !b.body.ok)?.body.code, "exposure_cap");
  assert.equal(sent.length, 1, "one order, not two");
  assert.equal(loadShadowPositions(ledgerOf("alice")).length + loadShadowPositions(ledgerOf("bob")).length, 1, "one lock, not two");
  // three more at once, on other games: the venue holds one lock already and none of them fits beside it
  script.length = 0;
  script.push(slow, slow, slow);
  const three = await Promise.all([tap(null, NYK), tap(null, DEN), tap("bob", NYK)]);
  assert.deepEqual(three.map((b) => b.body.code), ["exposure_cap", "exposure_cap", "exposure_cap"]);
  assert.equal(sent.length, 1);
  // and with room on the venue for exactly one more, three at once on three games: one passes
  setCaps({ venueCents: 2 * S20.venueAdd });
  const oneOfThree = await Promise.all([tap(null, NYK), tap(null, DEN), tap("bob", NYK)]);
  assert.equal(oneOfThree.filter((b) => b.body.ok).length, 1, JSON.stringify(oneOfThree.map((b) => b.body.code ?? "locked")));
  assert.equal(sent.length, 2);
  script.length = 0;

  // an order that fills nothing gives its room back at once
  for (const name of readdirSync(dir)) if (name.endsWith(".jsonl")) rmSync(join(dir, name));
  sent.length = 0;
  setCaps({ gameCents: S20.gameAdd, venueCents: S20.fill + S20.venueAdd });
  script.push(() => {
    throw new Error("kalshi orders: order ord-0 canceled with nothing filled at or under 42c");
  });
  const miss = await tap("alice", BOS);
  assert.equal(miss.body.code, "hedge_not_filled");
  assert.deepEqual((await health()).exposure.games, { open: 0, top: [] }, "a refused attempt holds nothing");
  locked(await tap("bob", LAL), "the room is there for the next lock");

  // an order that may have filled keeps its room, on the venue and the game, until the operator clears it
  script.push(() => {
    throw new Error("kalshi orders: HTTP 503 POST /portfolio/events/orders");
  });
  const realError = console.error;
  console.error = () => {};
  try {
    const unknown = await tap(null, NYK);
    assert.equal(unknown.body.code, "hedge_unconfirmed");
  } finally {
    console.error = realError;
  }
  const stray = await health();
  assert.equal(stray.exposure.counted.pendingLeftOver, 1);
  assert.equal(stray.exposure.venues[0].openCents, S20.fill + S20.venueAdd, "the most the unconfirmed order could have bought");
  assert.ok(!stray.exposure.holders.some((h) => h.holder === SHARED_HOLDER && h.openCents > 0), "no lock stands, so nothing rides on the holder");
  refused(await tap(null, DEN), "the venue has no room while the unconfirmed order is unexplained");
  const id = summarizePending(trail()).strays[0].pending.id;
  assert.equal((await fetch(`${base}/api/shadow/lock/pending/clear?token=op-secret&id=${encodeURIComponent(id)}&note=${encodeURIComponent("no order on the venue under that id")}`, { method: "POST" })).status, 200);
  assert.equal((await health()).exposure.venues[0].openCents, S20.fill);
  locked(await tap(null, DEN), "cleared: the room is back");
});

test("a simulated lock is written as it always was, whatever the caps: no gate, no trail, no fill on its line, nothing counted", async () => {
  // every cap at nothing: a real-money lock cannot pass
  setCaps({ gameCents: 0, venueCents: 0, holderCents: 0 });
  refused(await tap("alice", BOS, 5), "real money, caps at zero");
  const linesBefore = trail().length;

  // GSW is not armed: its lock is the simulated record, and the caps are not asked
  const paper = await tap("alice", GSW);
  assert.equal(paper.status, 200);
  assert.equal(paper.body.ok, true, JSON.stringify(paper.body));
  assert.equal(paper.body.hedge?.simulated, true);
  assert.equal(paper.body.hedge?.outcome, "filled_book");
  assert.equal(sent.length, 0, "nothing was sent");
  assert.equal(trail().length, linesBefore, "no line on the pending trail for a simulated lock");
  const raw = readFileSync(ledgerOf("alice"), "utf8").trim().split("\n");
  assert.equal(raw.length, 1);
  assert.ok(!raw[0].includes("hedgeFill"), "the line carries no fill: none was bought");
  const line = JSON.parse(raw[0]) as Record<string, unknown>;
  assert.equal(line.type, "open");
  assert.equal(line.source, "lock");
  assert.equal(line.holder, "alice");
  assert.equal(Object.keys(line).at(-1), "holder", "the line ends where it always ended");
  // a second simulated lock, and a much larger one: still no cap
  assert.equal((await tap("bob", GSW, 25)).body.ok, true);

  const h = await health();
  assert.deepEqual(h.exposure.games, { open: 0, top: [] });
  assert.deepEqual(h.exposure.venues.map((v) => v.openCents), [0]);
  assert.deepEqual(h.exposure.holders.map((x) => [x.holder, x.openCents, x.locks]), [["alice", 0, 0], ["bob", 0, 0]]);
  assert.deepEqual(h.exposure.counted, { realOpenLocks: 0, simulatedOpenLocksNotCounted: 2, pendingUnresolved: 0, pendingLeftOver: 0 });
  assert.equal(h.exposure.refusals.count, 1, "only the real-money attempt was refused");

  // and simulated locks take no room from real ones
  setCaps({ gameCents: S20.gameAdd, venueCents: S20.venueAdd, holderCents: S20.holderAdd });
  locked(await tap("alice", BOS), "the simulated locks left the caps untouched");
});

test("the public record does not carry the fill; the operator's resend of a hedge passes the same gate", async () => {
  setCaps({});
  locked(await tap("alice", BOS), "a real-money lock");
  const pub = await (await fetch(`${base}/api/shadow`)).text();
  assert.ok(pub.includes(BOS), "the lock is on the public record");
  assert.ok(!pub.includes("hedgeFill") && !pub.includes("receiptId"), "the order behind its hedge is not");

  // a lock written while the service was simulating (before real money was switched on): on the ledger, no real hedge behind it
  const q = quoteFor(DEN, 20);
  appendShadowRecord(ledgerOf("bob"), {
    type: "open",
    at: new Date().toISOString(),
    ticker: DEN,
    kind: "sports",
    league: "nba",
    sideName: "Denver Nuggets",
    eventTitle: "Nuggets at Suns",
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
    hedgeCostCents: S20.venueAdd,
    hedgeUnitsMilli: S20.unitsMilli,
    tier: q.tier,
    source: "lock",
    entryCents: 58,
    holder: "bob",
  });
  assert.equal((await health()).exposure.counted.simulatedOpenLocksNotCounted, 1);
  const resend = (extra = "") => fetch(`${base}/api/shadow/hedges/resend?token=op-secret&ticker=${DEN}&holder=bob${extra}`, { method: "POST" });
  const before = sent.length;

  // sending its hedge for real makes it a real-money lock: measured whole, against bob's cap too
  setCaps({ holderCents: S20.holderAdd - 1 });
  const held = await resend();
  assert.equal(held.status, 409);
  const heldBody = (await held.json()) as { ok: boolean; error: string; message: string; caps: CapRefusalLine[] };
  assert.equal(heldBody.error, "exposure_cap");
  assert.deepEqual(heldBody.caps, [{ cap: "holder", key: "bob", openCents: 0, addCents: S20.holderAdd, capCents: S20.holderAdd - 1, overByCents: 1 }]);
  assert.match(heldBody.message, /^nothing was sent: per-holder cap for holder bob: /);
  assert.equal(sent.length, before, "no order left");
  const line = capLines().at(-1);
  assert.equal(line?.source, "resend");
  assert.equal(line?.ref, `${DEN}@bob`);
  // the game it is on, with alice's lock elsewhere: one cent short on the game
  setCaps({ gameCents: S20.gameAdd - 1 });
  assert.equal((await resend()).status, 409);
  assert.deepEqual(lastCap().map((c) => [c.cap, c.key, c.overByCents]), [["game", "nba:26OCT16DENPHX", 1]]);

  // with room: it is sent, and from the receipt on the lock counts as real money
  setCaps({ gameCents: S20.gameAdd, holderCents: S20.holderAdd, venueCents: S20.fill + S20.venueAdd });
  const okRes = await resend();
  assert.equal(okRes.status, 200);
  assert.equal(((await okRes.json()) as { hedge: { simulated: boolean } }).hedge.simulated, false);
  assert.equal(sent.length, before + 1);
  const h = await health();
  assert.deepEqual(h.exposure.counted, { realOpenLocks: 2, simulatedOpenLocksNotCounted: 0, pendingUnresolved: 0, pendingLeftOver: 0 });
  assert.deepEqual(h.exposure.holders.find((x) => x.holder === "bob"), { holder: "bob", locks: 1, openCents: S20.holderAdd, capCents: S20.holderAdd, roomCents: 0 });
  assert.equal(h.exposure.venues[0].openCents, 2 * S20.fill);
  assert.equal(h.exposure.games.top.find((g) => g.game === "nba:26OCT16DENPHX")?.openCents, S20.gameOpen);

  // a second buy on a lock that already has one (?force=1) adds its cost to the venue and the game, and nothing to the holder, who is at their cap already
  setCaps({ gameCents: 1_000_000, holderCents: S20.holderAdd, venueCents: 2 * S20.fill + S20.venueAdd - 1 });
  assert.equal((await resend("&force=1")).status, 409);
  assert.deepEqual(lastCap().map((c) => [c.cap, c.openCents, c.addCents, c.overByCents]), [["venue", 2 * S20.fill, S20.venueAdd, 1]]);
  setCaps({ gameCents: 1_000_000, holderCents: S20.holderAdd, venueCents: 2 * S20.fill + S20.venueAdd });
  assert.equal((await resend("&force=1")).status, 200);
  const twice = await health();
  assert.equal(twice.exposure.venues[0].openCents, 3 * S20.fill);
  assert.equal(twice.exposure.games.top[0].openCents, S20.gameOpen + S20.fill, "both buys rest on the game");
  assert.equal(twice.exposure.holders.find((x) => x.holder === "bob")?.openCents, S20.holderAdd, "the holder's sum did not move");
  assert.equal(twice.exposure.counted.realOpenLocks, 2);
  assert.ok(existsSync(pendingPath()));
});
