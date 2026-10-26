/**
 * Holders on the lock path: each pilot user gets their own key (EVENT_SHADOW_HOLDER_KEYS), their
 * locks land in their own ledger, two holders may lock the same market, one holder may not lock
 * it twice, the operator's cash/reset/resend/export routes name the holder, /api/shadow/holders
 * totals what is owed each way, and `*` on the live allowlist arms any ticker the engine priced.
 * The engine is faked; nothing touches venues. Runs in its own process: the worker reads env at import.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quoteLadderWrap, type NoAskLevel } from "../src/eventCollar/crossVenue/kalshiLadder";
import { liveRailsFromEnv, tickerArmed } from "../src/eventCollar/crossVenue/liveHedge";
import { holderKeysFromEnv, lockCaller } from "../src/eventCollar/crossVenue/lockGate";
import { appendShadowRecord, loadShadowPositions } from "../src/eventCollar/crossVenue/shadowLedger";
import { DEFAULT_CROSS_CONFIG, type CrossQuoteResult } from "../src/eventCollar/crossVenue/types";
import type { CandidateResult, GameMarketRow, OneQuoteInputs, OneQuoteResult } from "../scripts/eventProtectXDemoService";

const SHARED = "shared-key-0123456789";
const ANN = "ann-key-abcdefghijklmnop";
const BOB = "bob-key-qrstuvwxyz012345";

test("holder keys: alias:key pairs parsed; bad alias, short key, the shared key, a repeated alias and a repeated key are each dropped with a note", () => {
  const r = holderKeysFromEnv({ EVENT_SHADOW_HOLDER_KEYS: ` Ann:${ANN}, bob:${BOB}\n x:short-key-0123456789 cat:tiny dan:${SHARED} ann:another-key-0123456 eve:${BOB} ` }, SHARED);
  assert.deepEqual(r.holders, [
    { holder: "ann", key: ANN },
    { holder: "bob", key: BOB },
  ]);
  assert.deepEqual(
    r.notes.map((n) => n.replace(/^holder keys: /, "")),
    ['alias "x" is not 2-24 of a-z 0-9 _ -; dropped', "cat: key under 12 chars; dropped", "dan: key equals the shared lock key; dropped", "ann: alias listed twice; second dropped", "eve: key already belongs to another holder; dropped"],
  );
  assert.deepEqual(holderKeysFromEnv({}, null), { holders: [], notes: [] });
  const holders = r.holders;
  assert.deepEqual(lockCaller(SHARED, holders, { "x-lock-key": SHARED }, null), { kind: "shared", holder: null });
  assert.deepEqual(lockCaller(SHARED, holders, { "x-lock-key": ANN }, null), { kind: "holder", holder: "ann" });
  assert.deepEqual(lockCaller(SHARED, holders, {}, BOB), { kind: "holder", holder: "bob" });
  assert.equal(lockCaller(SHARED, holders, { "x-lock-key": `${ANN}x` }, null), null);
  assert.equal(lockCaller(null, holders, { "x-lock-key": SHARED }, null), null, "no shared key configured: the old shared value opens nothing");
  assert.equal(lockCaller(SHARED, holders, {}, null), null);
});

test("live rails: `*` arms any ticker and keeps the named ones out of the scan's step-over list; a plain allowlist arms only what it names", () => {
  const any = liveRailsFromEnv({ EVENT_HEDGE_LIVE_TICKERS: "*" });
  assert.equal(any.anyTicker, true);
  assert.deepEqual(any.allowlist, []);
  assert.equal(tickerArmed(any, "KXNBAGAME-26OCT14LALBOS-BOS"), true);
  const mixed = liveRailsFromEnv({ EVENT_HEDGE_LIVE_TICKERS: "KX-A, *, kx-b" });
  assert.equal(mixed.anyTicker, true);
  assert.deepEqual(mixed.allowlist, ["KX-A", "KX-B"]);
  const named = liveRailsFromEnv({ EVENT_HEDGE_LIVE_TICKERS: "KX-A" });
  assert.equal(named.anyTicker, false);
  assert.equal(tickerArmed(named, "KX-A"), true);
  assert.equal(tickerArmed(named, "KX-B"), false);
  assert.equal(tickerArmed(liveRailsFromEnv({}), "KX-A"), false, "nothing set arms nothing");
});

// ---------------------------------------------------------------------------
// the worker with two holders, a shared key and any ticker armed
// ---------------------------------------------------------------------------

const TICKER = "KXNBAGAME-26OCT14LALBOS-BOS";
const OTHER = "KXNBAGAME-26OCT14LALBOS-LAL";
const START = new Date(Date.now() + 3 * 3_600_000).toISOString();
const NO_ASKS: NoAskLevel[] = [
  { priceCents: 41, qtyMilli: 300_000 },
  { priceCents: 42, qtyMilli: 400_000 },
];

function candidate(ticker: string, contracts: number, entryCents: number): CandidateResult {
  const side = ticker === TICKER ? "Boston Celtics" : "Los Angeles Lakers";
  const quote: CrossQuoteResult = quoteLadderWrap({
    pair: { kalshi: { ticker }, gameStartTime: START },
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
    market: {
      ticker,
      eventTicker: "KXNBAGAME-26OCT14LALBOS",
      title: "Lakers at Celtics Winner?",
      subtitle: side,
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
      rulesPrimary: `${side} win`,
    },
    pair: null,
    sideName: side,
    eventTitle: "Lakers at Celtics",
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

test("shadow worker holders: a key names its holder; locks land in the holder's ledger; one market, two holders; cash, reset, resend and export by holder; /api/shadow/holders totals; nothing public names anyone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-holders-"));
  const scanLedger = join(dir, "ledger.jsonl");
  const shared = join(dir, "lock-ledger.jsonl");
  const annLedger = join(dir, "lock-ledger-ann.jsonl");
  const bobLedger = join(dir, "lock-ledger-bob.jsonl");
  process.env.NODE_ENV = "test";
  process.env.EVENT_SHADOW_LEDGER_PATH = scanLedger;
  process.env.EVENT_SHADOW_LOCK_LEDGER_PATH = shared;
  process.env.EVENT_LASTLEG_LEDGER_PATH = join(dir, "lastleg.jsonl");
  process.env.EVENT_X_ADMIN_TOKEN = "op-secret";
  process.env.EVENT_SHADOW_LOCK_KEY = SHARED;
  process.env.EVENT_SHADOW_HOLDER_KEYS = `ann:${ANN},bob:${BOB},zed:tiny`;
  process.env.EVENT_HEDGE_STRATEGY = "live";
  process.env.EVENT_HEDGE_LIVE_TICKERS = "*";
  delete process.env.EVENT_HEDGE_LIVE_SEND;
  process.env.KALSHI_API_KEY_ID = "test-key-id";
  process.env.KALSHI_PRIVATE_KEY_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const worker = await import("../scripts/eventShadowWorker");
  const seen: OneQuoteInputs[] = [];
  const markets: GameMarketRow[] = [
    { ticker: TICKER, league: "nba", sideName: "Boston Celtics", title: "Lakers at Celtics Winner?", dateIso: "2026-10-14", closeTimeIso: START, markCents: 60, startIso: START, protectable: true, protectableUntilIso: START },
    { ticker: OTHER, league: "nba", sideName: "Los Angeles Lakers", title: "Lakers at Celtics Winner?", dateIso: "2026-10-14", closeTimeIso: START, markCents: 40, startIso: START, protectable: true, protectableUntilIso: START },
  ];
  worker.wireLockEngine({
    listGameMarkets: async (league?: string) => markets.filter((m) => !league || m.league === league),
    quoteOne: async (inputs: OneQuoteInputs): Promise<OneQuoteResult> => {
      seen.push(inputs);
      return { ok: true, result: candidate(inputs.ticker, inputs.contracts, inputs.entryCents ?? 60) };
    },
  });
  await new Promise<void>((r) => worker.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
  const ann = { "x-lock-key": ANN };
  const bob = { "x-lock-key": BOB };
  const sharedKey = { "x-lock-key": SHARED };
  const op = { "x-admin-token": "op-secret" };
  const json = { "content-type": "application/json" };
  const post = (path: string, body: unknown, headers: Record<string, string>) => fetch(`${base}${path}`, { method: "POST", headers: { ...headers, ...json }, body: JSON.stringify(body) });
  const lockBody = (ticker: string, contracts: number) => ({ ticker, contracts, entryCents: 58, tier: "balanced" });
  try {
    // healthz: the lock routes are on, two holders stand (zed's short key was dropped with a note), any ticker is armed
    const health = (await (await fetch(`${base}/healthz?token=op-secret`)).json()) as {
      lock: { enabled: boolean; sharedKey: boolean; reservedTickers: string[]; anyTicker: boolean; positions: number; holders: Array<{ holder: string; positions: number; ledger: { path: string } }>; holderNotes?: string[] };
    };
    assert.equal(health.lock.enabled, true);
    assert.equal(health.lock.sharedKey, true);
    assert.equal(health.lock.anyTicker, true);
    assert.deepEqual(health.lock.reservedTickers, []);
    assert.deepEqual(health.lock.holders.map((h) => [h.holder, h.positions, h.ledger.path]), [["ann", 0, annLedger], ["bob", 0, bobLedger]]);
    assert.deepEqual(health.lock.holderNotes, ["holder keys: zed: key under 12 chars; dropped"]);
    assert.ok(!JSON.stringify(health).includes(ANN) && !JSON.stringify(health).includes(BOB), "keys never leave the env");
    assert.ok(!JSON.stringify(await (await fetch(`${base}/healthz`)).json()).includes("ann"), "public healthz names nobody");

    // every market is live for the tap when any ticker is armed; a wrong key is still 403
    assert.equal((await fetch(`${base}/api/shadow/markets`, { headers: { "x-lock-key": `${ANN}x` } })).status, 403);
    const m = (await (await fetch(`${base}/api/shadow/markets`, { headers: ann })).json()) as { markets: Array<{ ticker: string; live: boolean; onRecord: boolean }> };
    assert.deepEqual(m.markets.map((x) => [x.ticker, x.live, x.onRecord]), [[TICKER, true, false], [OTHER, true, false]]);
    seen.length = 0;
    const q = (await (await fetch(`${base}/api/shadow/quote?ticker=${OTHER}&contracts=20`, { headers: bob })).json()) as { ok: boolean; holder?: string };
    assert.equal(q.ok, true);
    assert.equal(seen.at(-1)?.route, "kalshi_self", "any ticker armed: priced on the route the executor sends to");

    // ann locks; the record lands in her ledger with her alias; the shared and bob's ledgers do not exist
    const annLock = (await (await post("/api/shadow/lock", lockBody(TICKER, 20), ann)).json()) as { ok: boolean; holder?: string; creditCents: number; floorCents: number; capCents: number; hedge: { outcome: string; simulated: boolean; receiptId: string } };
    assert.equal(annLock.ok, true);
    assert.equal(annLock.holder, "ann");
    assert.equal(annLock.hedge.outcome, "filled_book");
    assert.equal(annLock.hedge.simulated, true, "dry run: nothing sent");
    assert.equal(loadShadowPositions(annLedger).length, 1);
    assert.equal(loadShadowPositions(annLedger)[0].holder, "ann");
    assert.equal(loadShadowPositions(annLedger)[0].source, "lock");
    assert.ok(!existsSync(shared) || loadShadowPositions(shared).length === 0, "nothing in the shared ledger");
    assert.ok(!existsSync(bobLedger));

    // ann again on the same market: refused; bob on the same market: his own lock, his own ledger
    const annAgain = await post("/api/shadow/lock", lockBody(TICKER, 5), ann);
    assert.equal(annAgain.status, 409);
    assert.equal(((await annAgain.json()) as { error: string }).error, "already_on_record");
    const bobLock = (await (await post("/api/shadow/lock", lockBody(TICKER, 10), bob)).json()) as { ok: boolean; holder?: string; creditCents: number; hedge: { receiptId: string } };
    assert.equal(bobLock.ok, true);
    assert.equal(bobLock.holder, "bob");
    assert.equal(loadShadowPositions(bobLedger).length, 1);
    assert.equal(loadShadowPositions(bobLedger)[0].contracts, 10);
    assert.notEqual(bobLock.hedge.receiptId, annLock.hedge.receiptId, "each holder's hedge has its own receipt");
    // and the shared key is a third party on the same market
    const sharedLock = (await (await post("/api/shadow/lock", lockBody(TICKER, 7), sharedKey)).json()) as { ok: boolean; holder?: string };
    assert.equal(sharedLock.ok, true);
    assert.equal(sharedLock.holder, undefined, "the shared key names nobody");
    assert.equal(loadShadowPositions(shared).length, 1);
    assert.equal(loadShadowPositions(shared)[0].holder, undefined);

    // each key sees only its own: markets' onRecord, positions, the receipt
    const annMarkets = (await (await fetch(`${base}/api/shadow/markets`, { headers: ann })).json()) as { markets: Array<{ ticker: string; onRecord: boolean }> };
    assert.deepEqual(annMarkets.markets.map((x) => [x.ticker, x.onRecord]), [[TICKER, true], [OTHER, false]]);
    const bobMarkets = (await (await fetch(`${base}/api/shadow/markets`, { headers: bob })).json()) as { holder?: string; markets: Array<{ ticker: string; onRecord: boolean }> };
    assert.equal(bobMarkets.holder, "bob");
    assert.deepEqual(bobMarkets.markets.map((x) => [x.ticker, x.onRecord]), [[TICKER, true], [OTHER, false]]);
    const annRcpt = (await (await fetch(`${base}/api/shadow/receipt?ticker=${TICKER}`, { headers: ann })).json()) as { holder?: string; lock: { contracts: number }; hedge: { receiptId: string; via: string } };
    assert.equal(annRcpt.holder, "ann");
    assert.equal(annRcpt.lock.contracts, 20);
    assert.equal(annRcpt.hedge.receiptId, annLock.hedge.receiptId, "her receipt, not bob's");
    const bobRcpt = (await (await fetch(`${base}/api/shadow/receipt?ticker=${TICKER}`, { headers: bob })).json()) as { lock: { contracts: number }; hedge: { receiptId: string } };
    assert.equal(bobRcpt.lock.contracts, 10);
    assert.equal(bobRcpt.hedge.receiptId, bobLock.hedge.receiptId);
    assert.equal((await fetch(`${base}/api/shadow/receipt?ticker=${OTHER}`, { headers: bob })).status, 404);

    // the operator acts as a holder with ?holder=, and never without naming one when it matters
    const asBob = (await (await fetch(`${base}/api/shadow/receipt?ticker=${TICKER}&holder=bob&token=op-secret`)).json()) as { holder?: string; lock: { contracts: number } };
    assert.deepEqual([asBob.holder, asBob.lock.contracts], ["bob", 10]);
    assert.equal((await fetch(`${base}/api/shadow/receipt?ticker=${TICKER}&holder=Bad%20Alias&token=op-secret`)).status, 400);
    const opLock = (await (await post("/api/shadow/lock?holder=ann", lockBody(OTHER, 3), op)).json()) as { ok: boolean; holder?: string };
    assert.deepEqual([opLock.ok, opLock.holder], [true, "ann"], "a lock entered for a person by hand lands in her ledger");
    assert.equal(loadShadowPositions(annLedger).length, 2);

    // the public record: every lock is there, nobody is named
    const pub = (await (await fetch(`${base}/api/shadow`)).json()) as { open: Array<Record<string, unknown>> };
    assert.deepEqual(pub.open.map((p) => [p.ticker, p.contracts]).sort((a, b) => String(a[0]).localeCompare(String(b[0])) || Number(a[1]) - Number(b[1])), [[TICKER, 7], [TICKER, 10], [TICKER, 20], [OTHER, 3]]);
    const pubText = JSON.stringify(pub);
    assert.ok(!pubText.includes('"holder":') && !pubText.includes("ann") && !pubText.includes("bob"), "no alias, no holder field, on anything public");
    const health2 = (await (await fetch(`${base}/healthz?token=op-secret`)).json()) as { positions: number; lock: { positions: number; holders: Array<{ holder: string; positions: number }> } };
    assert.equal(health2.positions, 4);
    assert.equal(health2.lock.positions, 4);
    assert.deepEqual(health2.lock.holders.map((h) => [h.holder, h.positions]), [["ann", 2], ["bob", 1]]);

    // CASH by holder: the same ticker is three locks; the operator names whose
    type Due = { leg: string; to: string; dueCents: number; paidCents: number; outstandingCents: number };
    const ambiguous = await post("/api/shadow/cash", { ticker: TICKER, leg: "credit", cents: 1 }, op);
    assert.equal(ambiguous.status, 409);
    const amb = (await ambiguous.json()) as { error: string; holders: string[] };
    assert.equal(amb.error, "ambiguous");
    assert.deepEqual(amb.holders.sort(), ["(shared)", "ann", "bob"]);
    assert.equal((await post("/api/shadow/cash", { ticker: TICKER, holder: "cat", leg: "credit", cents: 1 }, op)).status, 404);
    const paid = (await (await post("/api/shadow/cash", { ticker: TICKER, holder: "ann", leg: "credit", cents: annLock.creditCents, method: "venmo" }, op)).json()) as { ok: boolean; holder?: string; cash: Due[] };
    assert.equal(paid.ok, true);
    assert.equal(paid.holder, "ann");
    assert.deepEqual(paid.cash.map((d) => [d.leg, d.outstandingCents]), [["credit", 0]]);
    assert.equal(readFileSync(annLedger, "utf8").trim().split("\n").length, 3, "the payment is on her ledger");
    assert.equal(readFileSync(bobLedger, "utf8").trim().split("\n").length, 1, "not on his");
    const bobDue = (await (await fetch(`${base}/api/shadow/receipt?ticker=${TICKER}`, { headers: bob })).json()) as { cash: Due[] };
    assert.deepEqual(bobDue.cash.map((d) => [d.leg, d.outstandingCents]), [["credit", bobLock.creditCents]], "bob is still owed his credit");
    // the other ticker is one holder's alone: no ?holder= needed
    const unique = (await (await post("/api/shadow/cash", { ticker: OTHER, leg: "credit", cents: 1 }, op)).json()) as { ok: boolean; holder?: string };
    assert.deepEqual([unique.ok, unique.holder], [true, "ann"]);

    // HOLDERS (operator): who is owed what; bob's lock settles lost so the floor comes due
    appendShadowRecord(bobLedger, { type: "settle", at: new Date().toISOString(), ticker: TICKER, result: "no" });
    const bobTerms = loadShadowPositions(bobLedger)[0];
    assert.equal((await fetch(`${base}/api/shadow/holders`)).status, 403, "operator only");
    const hs = (await (await fetch(`${base}/api/shadow/holders?token=op-secret`)).json()) as {
      ok: boolean;
      holders: Array<{ holder: string; configured: boolean; locks: number; open: number; settled: number; outstanding: { toHolderCents: number; toWriterCents: number; netToHolderCents: number }; positions: Array<{ ticker: string; contracts: number; ledger: string; cash: Due[] }> }>;
      totals: { locks: number; toHolderCents: number; toWriterCents: number };
    };
    assert.equal(hs.ok, true);
    assert.deepEqual(hs.holders.map((h) => [h.holder, h.configured, h.locks, h.open, h.settled]), [["(shared)", true, 1, 1, 0], ["ann", true, 2, 2, 0], ["bob", true, 1, 0, 1]]);
    const annRow = hs.holders.find((h) => h.holder === "ann")!;
    const bobRow = hs.holders.find((h) => h.holder === "bob")!;
    const otherCredit = annRow.positions.find((p) => p.ticker === OTHER)!.cash.find((c) => c.leg === "credit")!.dueCents;
    assert.deepEqual(annRow.outstanding, { toHolderCents: otherCredit - 1, toWriterCents: 0, netToHolderCents: otherCredit - 1 }, "her credit on the first lock is paid; the second is owed less the $0.01 recorded");
    assert.deepEqual(bobRow.outstanding, { toHolderCents: bobTerms.creditCents + bobTerms.floorCents * 10, toWriterCents: 0, netToHolderCents: bobTerms.creditCents + bobTerms.floorCents * 10 }, "credit never paid plus the floor on the loss");
    assert.ok(annRow.positions.every((p) => p.ledger === annLedger));
    assert.equal(hs.totals.locks, 4);
    assert.equal(hs.totals.toHolderCents, hs.holders.reduce((s, h) => s + h.outstanding.toHolderCents, 0));
    assert.ok(!JSON.stringify(hs).includes(ANN));
    // the same, as the page the pay run reads: every alias, the standing per lock, the totals
    assert.equal((await fetch(`${base}/holders`)).status, 403, "operator only");
    const page = await (await fetch(`${base}/holders?token=op-secret`)).text();
    assert.match(page, /<title>Holders · operator/);
    assert.match(page, /<h2>ann<\/h2>/);
    assert.match(page, /<h2>bob<\/h2>/);
    assert.match(page, /<h2>shared key<\/h2>/);
    assert.match(page, /owed to holder/);
    assert.match(page, /square/);
    assert.ok(page.includes(`$${((bobTerms.creditCents + bobTerms.floorCents * 10) / 100).toFixed(2)}`), "bob's credit plus floor is on the page");
    assert.ok(!page.includes(ANN) && !page.includes(BOB), "no key on the page");
    // the receipt says how the other side reached the venue: nothing was sent here, so "book"
    assert.equal(annRcpt.hedge.via, "book");

    // RESEND and RESET by holder
    const resendAmb = await fetch(`${base}/api/shadow/hedges/resend?ticker=${TICKER}`, { method: "POST", headers: op });
    assert.equal(resendAmb.status, 409);
    assert.equal(((await resendAmb.json()) as { error: string }).error, "ambiguous");
    const resent = (await (await fetch(`${base}/api/shadow/hedges/resend?ticker=${TICKER}&holder=ann`, { method: "POST", headers: op })).json()) as { ok: boolean; holder?: string; allowlisted: boolean; priorReceipts: number; hedge: { simulated: boolean } };
    assert.deepEqual([resent.ok, resent.holder, resent.allowlisted, resent.priorReceipts, resent.hedge.simulated], [true, "ann", true, 1, true]);
    const resentTwice = (await (await fetch(`${base}/api/shadow/hedges/resend?ticker=${TICKER}&holder=ann`, { method: "POST", headers: op })).json()) as { ok: boolean; priorReceipts: number };
    assert.deepEqual([resentTwice.ok, resentTwice.priorReceipts], [true, 2], "the in-flight mark is cleared after each send");
    const resetShared = (await (await fetch(`${base}/api/shadow/lock/reset?ticker=${TICKER}&holder=shared`, { method: "POST", headers: op })).json()) as { ok: boolean; archived: { to: string; records: number } };
    assert.equal(resetShared.ok, true);
    assert.equal(resetShared.archived.records, 1);
    assert.match(resetShared.archived.to, /lock-ledger\.\d{4}-\d{2}-\d{2}T\d{6}Z\..*\.archived\.jsonl$/);
    assert.equal(loadShadowPositions(shared).length, 0);
    assert.equal(loadShadowPositions(annLedger).length, 2, "ann's lock on the same market stands");
    assert.equal(loadShadowPositions(bobLedger).length, 1);
    const resetAnn = (await (await fetch(`${base}/api/shadow/lock/reset?ticker=${TICKER}&holder=ann`, { method: "POST", headers: op })).json()) as { ok: boolean; archived: { to: string; records: number; kept: number } };
    assert.equal(resetAnn.ok, true);
    assert.match(resetAnn.archived.to, /lock-ledger-ann\./);
    assert.equal(resetAnn.archived.records, 2, "her lock and its cash line");
    assert.equal(resetAnn.archived.kept, 2, "the other market's open and cash line stay");
    assert.deepEqual(loadShadowPositions(annLedger).map((p) => p.ticker), [OTHER]);
    const annAfter = (await (await fetch(`${base}/api/shadow/holders?token=op-secret`)).json()) as { holders: Array<{ holder: string; locks: number }> };
    assert.deepEqual(annAfter.holders.map((h) => [h.holder, h.locks]), [["(shared)", 0], ["ann", 1], ["bob", 1]], "archives are never read as a holder's ledger");

    // EXPORT by holder
    const annExport = (await (await fetch(`${base}/api/shadow/export?ledger=lock&holder=ann&token=op-secret`)).text()).trim().split("\n");
    assert.equal(annExport.length, 2);
    assert.equal((JSON.parse(annExport[0]) as { ticker: string; holder: string }).holder, "ann");
    assert.equal((await (await fetch(`${base}/api/shadow/export?ledger=lock&token=op-secret`)).text()).trim(), "", "the shared ledger is empty after its reset");
    assert.equal((await fetch(`${base}/api/shadow/export?ledger=lock&holder=Bad%20Alias&token=op-secret`)).status, 400);
    assert.equal((await fetch(`${base}/api/shadow/export?ledger=lock&holder=cat&token=op-secret`)).status, 200, "a holder with no ledger exports nothing, not an error");
  } finally {
    await new Promise<void>((r) => worker.server.close(() => r()));
  }
});
