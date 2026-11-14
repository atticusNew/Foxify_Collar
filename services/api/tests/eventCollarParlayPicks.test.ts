/**
 * Parlay picks: a venue's parlay card read as the games it names (parlayPicks.ts), and the lock
 * path at the last pick through the shadow worker with a fake engine. Nothing touches venues.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quoteLadderWrap, type NoAskLevel } from "../src/eventCollar/crossVenue/kalshiLadder";
import { parseLockRequest } from "../src/eventCollar/crossVenue/lockGate";
import { parsePickQueries, resolvePicks, verifyParlayLock, type PickMarket } from "../src/eventCollar/crossVenue/parlayPicks";
import { loadShadowPositions } from "../src/eventCollar/crossVenue/shadowLedger";
import { DEFAULT_CROSS_CONFIG, PARLAY_LAST_PICK_TIER, type CrossQuoteResult } from "../src/eventCollar/crossVenue/types";
import { forbiddenKeysIn } from "../src/eventCollar/retailShowcase";
import type { KalshiSettledMarket } from "../src/eventCollar/kalshiPublic";
import type { CandidateResult, GameMarketRow, OneQuoteInputs, OneQuoteResult } from "../scripts/eventProtectXDemoService";

const NOW = new Date("2026-11-03T15:00:00Z"); // Tuesday morning ET: the Monday game is played, Thursday's is not
const MON = "2026-11-03T01:15:00.000Z"; // Mon Nov 2, 8:15pm ET
const THU = "2026-11-06T01:15:00.000Z"; // Thu Nov 5, 8:15pm ET
const SEA = "KXNFLGAME-26NOV02CHISEA-SEA";
const CHI = "KXNFLGAME-26NOV02CHISEA-CHI";
const BAL = "KXNFLGAME-26NOV05JAXBAL-BAL";
const JAX = "KXNFLGAME-26NOV05JAXBAL-JAX";
const SEA_NEXT = "KXNFLGAME-26NOV08ARISEA-SEA";

const open = (ticker: string, sideName: string, title: string, startIso: string): PickMarket => ({ ticker, league: "nfl", sideName, title, startIso, settled: false });
const done = (ticker: string, sideName: string, title: string, result: "yes" | "no" | ""): PickMarket => ({ ticker, league: "nfl", sideName, title, startIso: null, settled: true, result });

test("pick queries: codes with optional opponent and day; anything else is refused", () => {
  assert.deepEqual(parsePickQueries("SEA:CHI:Mon,BAL:JAX:Thu"), [
    { code: "SEA", opp: "CHI", day: "Mon" },
    { code: "BAL", opp: "JAX", day: "Thu" },
  ]);
  assert.deepEqual(parsePickQueries("sea, bal"), [{ code: "SEA" }, { code: "BAL" }]);
  assert.deepEqual(parsePickQueries("SEA::today"), [{ code: "SEA", day: "Today" }]);
  assert.equal(parsePickQueries(""), null);
  assert.equal(parsePickQueries("S,BAL"), null);
  assert.equal(parsePickQueries("SEA:CHI:Someday"), null);
  assert.equal(parsePickQueries(Array.from({ length: 13 }, () => "SEA").join(",")), null, "twelve picks at most");
});

test("resolve picks: both games ahead is open; the first played and won is the last pick; lost is busted", () => {
  const ahead = [open(SEA, "Seattle", "Bears at Seahawks Winner?", MON), open(CHI, "Chicago", "Bears at Seahawks Winner?", MON), open(BAL, "Baltimore", "Jaguars at Ravens Winner?", THU), open(JAX, "Jacksonville", "Jaguars at Ravens Winner?", THU)];
  const q = parsePickQueries("SEA:CHI:Mon,BAL:JAX:Thu")!;
  const sunday = new Date("2026-11-01T20:00:00Z");
  const both = resolvePicks(q, ahead, sunday);
  assert.equal(both.state, "open");
  assert.equal(both.open, 2);
  assert.equal(both.lastPick, null);
  assert.deepEqual(both.picks.map((p) => [p.ticker, p.state, p.startsIso]), [[SEA, "open", MON], [BAL, "open", THU]]);
  assert.equal(both.picks[0].sideName, "Seattle");
  assert.equal(both.picks[0].eventTitle, "Bears at Seahawks Winner?");

  // Monday night, the game in play: open still, flagged live
  const inPlay = resolvePicks(q, ahead, new Date("2026-11-03T02:00:00Z"));
  assert.equal(inPlay.picks[0].state, "open");
  assert.equal(inPlay.picks[0].live, true);
  assert.equal(inPlay.state, "open");

  // Tuesday: the Seahawks market is settled (gone from the open list), the Ravens game ahead; the
  // Seahawks' next game is listed too and must not be taken for the pick
  const tuesday = [open(BAL, "Baltimore", "Jaguars at Ravens Winner?", THU), open(JAX, "Jacksonville", "Jaguars at Ravens Winner?", THU), open(SEA_NEXT, "Seattle", "Cardinals at Seahawks Winner?", "2026-11-08T21:05:00.000Z"), done(SEA, "Seattle", "Bears at Seahawks Winner?", "yes"), done(CHI, "Chicago", "Bears at Seahawks Winner?", "no")];
  const last = resolvePicks(q, tuesday, NOW);
  assert.equal(last.state, "last_pick");
  assert.equal(last.open, 1);
  assert.equal(last.lastPick?.ticker, BAL);
  assert.deepEqual(last.picks.map((p) => [p.ticker, p.state]), [[SEA, "won"], [BAL, "open"]]);

  const busted = resolvePicks(q, [...tuesday.filter((m) => m.ticker !== SEA && m.ticker !== CHI), done(SEA, "Seattle", "Bears at Seahawks Winner?", "no"), done(CHI, "Chicago", "Bears at Seahawks Winner?", "yes")], NOW);
  assert.equal(busted.state, "busted");
  assert.equal(busted.picks[0].state, "lost");

  // every pick hit: the ticket is settled, not open
  const won = resolvePicks(q, [done(SEA, "Seattle", "", "yes"), done(BAL, "Baltimore", "", "yes")], NOW);
  assert.equal(won.state, "won");

  // the result not official yet: unknown, with the reason
  const pending = resolvePicks(q, [done(SEA, "Seattle", "", ""), open(BAL, "Baltimore", "", THU)], NOW);
  assert.equal(pending.state, "unknown");
  assert.match(pending.picks[0].why ?? "", /not posted yet/);
});

test("resolve picks: a bare code that fits two games is unknown, the opponent or the day settles it; venue spellings map to Kalshi's", () => {
  const markets = [open(BAL, "Baltimore", "", THU), open(SEA_NEXT, "Seattle", "", "2026-11-08T21:05:00.000Z"), done(SEA, "Seattle", "", "yes"), done("KXNFLGAME-26NOV01WASSEA-SEA", "Seattle", "", "no")];
  const bare = resolvePicks(parsePickQueries("SEA,BAL")!, markets, NOW);
  assert.equal(bare.picks[0].state, "unknown");
  assert.match(bare.picks[0].why ?? "", /3 games fit/);
  assert.equal(bare.picks[1].state, "open", "one Ravens game listed: the bare code is enough");
  assert.equal(bare.state, "unknown");
  const byOpp = resolvePicks(parsePickQueries("SEA:CHI,BAL")!, markets, NOW);
  assert.equal(byOpp.picks[0].ticker, SEA);
  assert.equal(byOpp.state, "last_pick");
  const byDay = resolvePicks(parsePickQueries("SEA::Mon,BAL")!, markets, NOW);
  assert.equal(byDay.picks[0].ticker, SEA);
  // the venue writes WSH where Kalshi writes WAS, JAC for JAX
  const spelled = resolvePicks(parsePickQueries("SEA:WSH:Sun,BAL:JAC")!, markets, NOW);
  assert.equal(spelled.picks[0].ticker, "KXNFLGAME-26NOV01WASSEA-SEA");
  assert.equal(spelled.picks[0].state, "lost");
  assert.equal(spelled.picks[1].ticker, BAL);
  // a club the service lists no game for
  const none = resolvePicks(parsePickQueries("NYG,BAL")!, markets, NOW);
  assert.equal(none.picks[0].state, "unknown");
  assert.match(none.picks[0].why ?? "", /no listed game/);
});

test("verify a parlay lock: last pick only, on that market, before the start, at most the payout", () => {
  const q = parsePickQueries("SEA:CHI:Mon,BAL:JAX:Thu")!;
  const tuesday = [open(BAL, "Baltimore", "", THU), done(SEA, "Seattle", "", "yes")];
  const view = resolvePicks(q, tuesday, NOW);
  assert.deepEqual(verifyParlayLock(view, BAL, 66.18, 1000, 6618), { ok: true });
  assert.equal((verifyParlayLock(view, BAL, 66.19, 1000, 6618) as { code: string }).code, "parlay_size");
  assert.equal((verifyParlayLock(view, BAL, 10, 1000, 900) as { code: string }).code, "parlay_size");
  assert.equal((verifyParlayLock(view, SEA, 66.18, 1000, 6618) as { code: string }).code, "parlay_not_last_pick");
  assert.equal((verifyParlayLock(resolvePicks(q, [open(BAL, "Baltimore", "", THU), open(SEA, "Seattle", "", MON)], new Date("2026-11-01T20:00:00Z")), BAL, 10, 1000, 6618) as { code: string }).code, "parlay_not_last_pick");
  assert.equal((verifyParlayLock(resolvePicks(q, [open(BAL, "Baltimore", "", THU), done(SEA, "Seattle", "", "no")], NOW), BAL, 10, 1000, 6618) as { code: string }).code, "parlay_busted");
  assert.equal((verifyParlayLock(resolvePicks(q, [open(BAL, "Baltimore", "", THU), done(SEA, "Seattle", "", "")], NOW), BAL, 10, 1000, 6618) as { code: string }).code, "parlay_pick_unknown");
  const underWay = resolvePicks(q, [open(BAL, "Baltimore", "", THU), done(SEA, "Seattle", "", "yes")], new Date("2026-11-06T02:00:00Z"));
  assert.equal((verifyParlayLock(underWay, BAL, 10, 1000, 6618) as { code: string }).code, "parlay_in_play", "in play off (or not said): the last pick must not have started");
  assert.equal((verifyParlayLock(underWay, BAL, 10, 1000, 6618, { inPlay: false }) as { code: string }).code, "parlay_in_play");
  // in play on: the ticket is still one position on the last game; the quote decides whether the books fund it now
  assert.deepEqual(verifyParlayLock(underWay, BAL, 10, 1000, 6618, { inPlay: true }), { ok: true });
  assert.equal((verifyParlayLock(underWay, BAL, 66.19, 1000, 6618, { inPlay: true }) as { code: string }).code, "parlay_size", "every other check stands in play");
  assert.equal((verifyParlayLock(underWay, SEA, 10, 1000, 6618, { inPlay: true }) as { code: string }).code, "parlay_not_last_pick");
});

test("lock request: the parlay block is validated; picks as codes with optional opponent and day", () => {
  const ok = parseLockRequest({ ticker: BAL, contracts: 66.18, entryCents: 15, venue: "novig", parlay: { picks: [{ code: "sea", opp: "chi", day: "mon" }, { code: "BAL", opp: "JAX", day: "Thu" }], stakeCents: 1000, payoutCents: 6618 } });
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok ? ok.value.parlay : null, { picks: [{ code: "SEA", opp: "CHI", day: "Mon" }, { code: "BAL", opp: "JAX", day: "Thu" }], stakeCents: 1000, payoutCents: 6618 });
  assert.equal(parseLockRequest({ ticker: BAL, contracts: 1 }).ok, true, "no parlay block is a single");
  for (const [parlay, re] of [
    [{ picks: [{ code: "SEA" }], stakeCents: 1000, payoutCents: 6618 }, /at least two/],
    [{ picks: [{ code: "SEA" }, { code: "B" }], stakeCents: 1000, payoutCents: 6618 }, /club codes/],
    [{ picks: [{ code: "SEA" }, { code: "BAL" }], stakeCents: 1000, payoutCents: 999 }, /payout above the stake/],
    [{ picks: [{ code: "SEA" }, { code: "BAL" }], stakeCents: 10.5, payoutCents: 6618 }, /whole cents/],
    ["x", /object/],
  ] as Array<[unknown, RegExp]>) {
    const r = parseLockRequest({ ticker: BAL, contracts: 1, parlay });
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, re);
  }
});

// ---------------------------------------------------------------------------
// the worker: /api/shadow/picks and a parlay lock at the last pick, fake engine
// ---------------------------------------------------------------------------

const NO_ASKS: NoAskLevel[] = [
  { priceCents: 31, qtyMilli: 300_000 },
  { priceCents: 32, qtyMilli: 400_000 },
];

function candidate(ticker: string, contracts: number, entryCents: number, startIso: string): CandidateResult {
  const quote: CrossQuoteResult = quoteLadderWrap({
    pair: { kalshi: { ticker }, gameStartTime: startIso },
    markCents: 70,
    entryCents,
    contracts,
    now: new Date(),
    noAsks: NO_ASKS,
    config: DEFAULT_CROSS_CONFIG,
  });
  assert.ok(quote.ok, JSON.stringify(quote));
  return {
    kind: "sports",
    league: "nfl",
    market: { ticker, eventTicker: ticker.slice(0, ticker.lastIndexOf("-")), title: "Jaguars at Ravens Winner?", subtitle: "Baltimore", strike: 0, strikeType: "", status: "active", openTime: "", closeTime: startIso, yesBidCents: 69, yesAskCents: 71, lastPriceCents: 70, volume: 1000, openInterest: 1000, rulesPrimary: "Ravens win" },
    pair: null,
    sideName: "Baltimore",
    eventTitle: "Jaguars at Ravens",
    eventTimeIso: startIso,
    parityNote: "",
    fingerprint: `test:${ticker}`,
    markCents: 70,
    position: { contracts, entryCents, entrySource: "entered_now", entryTime: null },
    quote,
    route: "kalshi_self",
    evBps: quote.evCostBps,
    routesChecked: [],
    books: { noAsks: NO_ASKS },
  };
}

test("shadow worker: /api/shadow/picks places a parlay's picks; the lock at the last pick writes the parlay on the record, and is refused before it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-parlay-"));
  process.env.NODE_ENV = "test";
  process.env.EVENT_SHADOW_LEDGER_PATH = join(dir, "ledger.jsonl");
  process.env.EVENT_SHADOW_LOCK_LEDGER_PATH = join(dir, "lock-ledger.jsonl");
  process.env.EVENT_LASTLEG_LEDGER_PATH = join(dir, "lastleg.jsonl");
  process.env.EVENT_X_ADMIN_TOKEN = "op-secret";
  process.env.EVENT_SHADOW_LOCK_KEY = "lock-key-0123456789";
  process.env.EVENT_HEDGE_STRATEGY = "live";
  process.env.EVENT_HEDGE_LIVE_TICKERS = BAL;
  delete process.env.EVENT_HEDGE_LIVE_SEND;
  process.env.KALSHI_API_KEY_ID = "test-key-id";
  process.env.KALSHI_PRIVATE_KEY_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const worker = await import("../scripts/eventShadowWorker");
  // the games as the week stands: the Ravens game ahead (a real start a few hours out so the quote
  // is inside the window), the Seahawks game settled; the settled list is what the parlay reads results from
  const start = new Date(Date.now() + 3 * 3_600_000).toISOString();
  const markets: GameMarketRow[] = [
    { ticker: BAL, league: "nfl", sideName: "Baltimore", title: "Jaguars at Ravens Winner?", dateIso: "2026-11-05", closeTimeIso: start, markCents: 70, startIso: start, protectable: true, protectableUntilIso: start },
    { ticker: JAX, league: "nfl", sideName: "Jacksonville", title: "Jaguars at Ravens Winner?", dateIso: "2026-11-05", closeTimeIso: start, markCents: 30, startIso: start, protectable: true, protectableUntilIso: start },
  ];
  let seattleResult: "yes" | "no" | "" = "";
  let seattleSettled = false;
  const settledMarkets = async (series: string): Promise<KalshiSettledMarket[]> =>
    series === "KXNFLGAME" && seattleSettled
      ? [{ ticker: SEA, eventTicker: "KXNFLGAME-26NOV02CHISEA", title: "Bears at Seahawks Winner?", subtitle: "Seattle", strike: 0, strikeType: "", status: "settled", openTime: "", closeTime: MON, yesBidCents: 0, yesAskCents: 0, lastPriceCents: 0, volume: 0, openInterest: 0, rulesPrimary: "", rulesSecondary: "", result: seattleResult }]
      : [];
  const seen: OneQuoteInputs[] = [];
  worker.wireLockEngine({
    listGameMarkets: async () => markets,
    quoteOne: async (inputs: OneQuoteInputs): Promise<OneQuoteResult> => {
      seen.push(inputs);
      return { ok: true, result: candidate(inputs.ticker, inputs.contracts, inputs.entryCents ?? 70, start) };
    },
    settledMarkets,
  });
  await new Promise<void>((r) => worker.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
  const key = { "x-lock-key": "lock-key-0123456789" };
  const post = (body: unknown) => fetch(`${base}/api/shadow/lock`, { method: "POST", headers: { ...key, "content-type": "application/json" }, body: JSON.stringify(body) });
  const parlay = { picks: [{ code: "SEA", opp: "CHI", day: "Mon" }, { code: "BAL", opp: "JAX", day: "Thu" }], stakeCents: 1000, payoutCents: 6618 };
  try {
    assert.equal((await fetch(`${base}/api/shadow/picks?picks=SEA,BAL`)).status, 403, "the picks route is behind the lock key");
    assert.equal((await fetch(`${base}/api/shadow/picks?picks=SEA`, { headers: key })).status, 400, "one code is not a parlay");
    assert.equal((await fetch(`${base}/api/shadow/picks`, { headers: key })).status, 400);

    // before the Seahawks game is settled, the Seahawks pick fits no listed game: unknown, said so
    const early = (await (await fetch(`${base}/api/shadow/picks?picks=SEA:CHI:Mon,BAL:JAX:Thu`, { headers: key })).json()) as { ok: boolean; state: string; picks: Array<{ state: string; why?: string; ticker: string | null }> };
    assert.equal(early.ok, true);
    assert.equal(early.state, "unknown");
    assert.equal(early.picks[0].state, "unknown");
    assert.match(early.picks[0].why ?? "", /no listed game/);
    assert.equal(early.picks[1].ticker, BAL);
    const refusedEarly = await post({ ticker: BAL, contracts: 66.18, entryCents: 15, venue: "novig", parlay });
    assert.equal(refusedEarly.status, 409);
    assert.equal(((await refusedEarly.json()) as { error: string }).error, "parlay_pick_unknown");

    // the Seahawks settled yes: the ticket is at its last pick, the Ravens
    seattleSettled = true;
    seattleResult = "yes";
    worker.wireLockEngine({ listGameMarkets: async () => markets, quoteOne: async (inputs) => ({ ok: true, result: candidate(inputs.ticker, inputs.contracts, inputs.entryCents ?? 70, start) }), settledMarkets });
    const view = (await (await fetch(`${base}/api/shadow/picks?picks=SEA:CHI:Mon,BAL:JAX:Thu`, { headers: key })).json()) as { state: string; open: number; lastPick: { ticker: string; sideName: string } | null; picks: Array<{ ticker: string; state: string; sideName: string; eventTitle: string }> };
    assert.equal(view.state, "last_pick");
    assert.equal(view.open, 1);
    assert.equal(view.lastPick?.ticker, BAL);
    assert.deepEqual(view.picks.map((p) => [p.ticker, p.state, p.sideName]), [[SEA, "won", "Seattle"], [BAL, "open", "Baltimore"]]);
    assert.deepEqual(forbiddenKeysIn(view), [], "the picks view carries no hedge keys");

    // too big for the ticket: refused before anything is quoted
    const big = await post({ ticker: BAL, contracts: 70, venue: "novig", parlay });
    assert.equal(big.status, 409);
    assert.equal(((await big.json()) as { error: string }).error, "parlay_size");
    // the wrong market for the last pick
    const wrong = await post({ ticker: JAX, contracts: 10, venue: "novig", parlay });
    assert.equal(wrong.status, 409);
    assert.equal(((await wrong.json()) as { error: string }).error, "parlay_not_last_pick");
    assert.equal(seen.length, 0, "nothing was priced for a refused parlay");

    // the quote for a ticket at its last pick heads with the highest floor (parlay=1); a single keeps the default
    type Q = { ok: boolean; quote: { tier: string; floorCents: number; capCents: number; tiers: Record<string, { floorCents: number; capCents: number }> } };
    const single = (await (await fetch(`${base}/api/shadow/quote?ticker=${BAL}&contracts=66.18&entry=15&venue=novig`, { headers: key })).json()) as Q;
    const ticket = (await (await fetch(`${base}/api/shadow/quote?ticker=${BAL}&contracts=66.18&entry=15&venue=novig&parlay=1`, { headers: key })).json()) as Q;
    assert.equal(single.quote.tier, "wide", "a single heads with the most upside");
    assert.equal(ticket.quote.tier, "tight", "a parlay at its last pick heads with the highest floor");
    assert.ok(ticket.quote.floorCents > single.quote.floorCents && ticket.quote.capCents < single.quote.capCents);
    assert.deepEqual(ticket.quote.tiers, single.quote.tiers, "the same shapes ride along under either heading");
    assert.deepEqual(forbiddenKeysIn(ticket), []);

    // a parlay lock with no tier named takes the highest floor; the record says which tier it is
    const lockRes = await post({ ticker: BAL, contracts: 66.18, entryCents: 15, venue: "novig", parlay });
    assert.equal(lockRes.status, 200, await lockRes.clone().text());
    const lock = (await lockRes.json()) as { ok: boolean; ticker: string; contracts: number; tier?: string; floorCents?: number; parlay: { picks: Array<{ ticker: string; state: string }>; stakeCents: number; payoutCents: number } };
    assert.equal(lock.ok, true);
    assert.equal(lock.ticker, BAL);
    assert.equal(lock.contracts, 66.18);
    assert.equal(lock.floorCents, ticket.quote.floorCents, "locked at the highest floor");
    assert.deepEqual(lock.parlay, { picks: [{ ticker: SEA, sideName: "Seattle", eventTitle: "Bears at Seahawks Winner?", state: "won" }, { ticker: BAL, sideName: "Baltimore", eventTitle: "Jaguars at Ravens Winner?", state: "open" }], stakeCents: 1000, payoutCents: 6618 });
    assert.deepEqual(forbiddenKeysIn(lock.parlay), []);

    const positions = loadShadowPositions(process.env.EVENT_SHADOW_LOCK_LEDGER_PATH);
    assert.equal(positions.length, 1);
    assert.equal(positions[0].source, "lock");
    assert.equal(positions[0].ticker, BAL);
    assert.deepEqual(positions[0].parlay, lock.parlay, "the record carries the picks");

    // the public record carries the parlay block and nothing of the hedge
    const pub = (await (await fetch(`${base}/api/shadow`)).json()) as { open: Array<{ ticker: string; parlay?: unknown; holder?: string }> };
    const onRecord = pub.open.find((p) => p.ticker === BAL);
    assert.ok(onRecord, "the lock is on the public record");
    assert.deepEqual(onRecord.parlay, lock.parlay);
    assert.equal("holder" in onRecord, false);
    assert.deepEqual(forbiddenKeysIn(onRecord.parlay), []);
    const words = JSON.stringify(onRecord.parlay).toLowerCase();
    assert.ok(!/writer|holder|novig|kalshi|prophetx/.test(words), "the parlay block is in a holder's words");

    // a busted ticket is refused even on a fresh market
    seattleResult = "no";
    worker.wireLockEngine({ listGameMarkets: async () => markets, quoteOne: async (inputs) => ({ ok: true, result: candidate(inputs.ticker, inputs.contracts, inputs.entryCents ?? 70, start) }), settledMarkets });
    const busted = await post({ ticker: JAX, contracts: 10, venue: "novig", parlay: { ...parlay, picks: [parlay.picks[0], { code: "JAX", opp: "BAL", day: "Thu" }] } });
    assert.equal(busted.status, 409);
    assert.equal(((await busted.json()) as { error: string }).error, "parlay_busted");
  } finally {
    await new Promise<void>((r) => worker.server.close(() => r()));
  }
});

test("shadow worker: the last-leg router prices a simulated ticket's moment through the engine as a single, headed at the parlay tier", async () => {
  process.env.NODE_ENV = "test";
  process.env.EVENT_HEDGE_STRATEGY = "live";
  process.env.EVENT_HEDGE_LIVE_TICKERS = BAL;
  delete process.env.EVENT_HEDGE_LIVE_SEND;
  const worker = await import("../scripts/eventShadowWorker");
  const start = new Date(Date.now() + 3 * 3_600_000).toISOString();
  const markets: GameMarketRow[] = [
    { ticker: BAL, league: "nfl", sideName: "Baltimore", title: "Jaguars at Ravens Winner?", dateIso: "2026-11-05", closeTimeIso: start, markCents: 70, startIso: start, protectable: true, protectableUntilIso: start },
  ];
  const seen: OneQuoteInputs[] = [];
  let answer: OneQuoteResult | null = null;
  worker.wireLockEngine({
    listGameMarkets: async () => markets,
    quoteOne: async (inputs: OneQuoteInputs): Promise<OneQuoteResult> => {
      seen.push(inputs);
      return answer ?? { ok: true, result: candidate(inputs.ticker, inputs.contracts, inputs.entryCents ?? 70, start) };
    },
    settledMarkets: async () => [],
  });
  const router = worker.lastLegRouter();
  assert.ok(router, "wired engine: the router is there");
  assert.deepEqual((await router.markets()).map((m) => m.ticker), [BAL], "legs are built from the engine's own game list");

  const q = await router.quote({ ticker: BAL, contracts: 66, entryCents: 15 });
  assert.ok(q.ok, JSON.stringify(q));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ticker, BAL);
  assert.equal(seen[0].contracts, 66);
  assert.equal(seen[0].entryCents, 15);
  assert.equal(seen[0].holderVenue, "kalshi");
  assert.equal(seen[0].route, "kalshi_self", "the pinned live route for this ticker, as a lock would take");
  assert.equal(q.route, "kalshi_self");
  assert.equal(q.markCents, 70);
  assert.equal(q.terms.tier, PARLAY_LAST_PICK_TIER, "headed at the highest floor, as the extension's parlay quote is");
  assert.equal(q.terms.tier, "tight");
  assert.ok(q.hedgeUnitsMilli > 0, "Kalshi self-hedge: units from contractsMilli");
  assert.ok(q.hedgeCostCents > 0);
  assert.equal("hedgeTokenId" in q, false, "no Polymarket token on a Kalshi route");
  assert.deepEqual(forbiddenKeysIn({ venue: q.route }), [], "a route name is not a forbidden key");

  answer = { ok: false, code: "route_not_offered", detail: "polymarket is not offered tonight" };
  const refused = await router.quote({ ticker: BAL, contracts: 66, entryCents: 15 });
  assert.deepEqual(refused, { ok: false, code: "route_not_offered", detail: "polymarket is not offered tonight" }, "the engine's refusal passes through to the moment record");
});
