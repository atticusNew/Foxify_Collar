/**
 * In play on the lock path (crossVenue/lockWindow.ts): a game can be locked in while it is being
 * played, by default. The window (pure), the venue fee that only applies once a game is live, and
 * the worker's lock route during a game: the market list says the game is in play, a real-money
 * lock buys its hedge first and is refused when the book moved, a parlay's last pick may be under
 * way, and the switch turns all of it off. The engine and the venue are faked; nothing touches a venue.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HedgeIntent } from "../src/eventCollar/crossVenue/hedgeExecutor";
import { loadPending, summarizePending } from "../src/eventCollar/crossVenue/hedgeFirst";
import type { KalshiSettledMarket } from "../src/eventCollar/kalshiPublic";
import { quoteLadderWrap, type NoAskLevel } from "../src/eventCollar/crossVenue/kalshiLadder";
import { DEFAULT_LIVE_RAILS, LiveHedgeExecutor, type LiveOrderHook, type LiveOrderResult } from "../src/eventCollar/crossVenue/liveHedge";
import { DEFAULT_IN_PLAY_HOURS, PROTECT_WINDOW_MINUTES, inPlayFromEnv, inPlayMaxMsFromEnv, lockWindow, protectWindow } from "../src/eventCollar/crossVenue/lockWindow";
import { planNovigOrder, rawAskMilliOf } from "../src/eventCollar/crossVenue/novigOrders";
import { inPlayConfig } from "../src/eventCollar/crossVenue/shadowCounterfactuals";
import { loadShadowPositions } from "../src/eventCollar/crossVenue/shadowLedger";
import { DEFAULT_CROSS_CONFIG, type CrossQuoteResult } from "../src/eventCollar/crossVenue/types";
import { signedAsksForOpposing, signedBidsForOpposing, signedEventLive, signedFeeAppliesLive, signedFeeAppliesPreGame, signedFeeMilli } from "../src/eventCollar/crossVenue/venueBooks";
import type { CandidateResult, GameMarketRow, OneQuoteInputs, OneQuoteResult } from "../scripts/eventProtectXDemoService";

test("in play is on unless the switch says off; the bound after the start is four hours unless set", () => {
  assert.equal(inPlayFromEnv({}), true, "unset: on");
  assert.equal(inPlayFromEnv({ EVENT_X_IN_PLAY: "1" }), true);
  assert.equal(inPlayFromEnv({ EVENT_X_IN_PLAY: "true" }), true);
  assert.equal(inPlayFromEnv({ EVENT_X_IN_PLAY: "" }), true);
  for (const off of ["0", "false", "no", "off", "OFF", " 0 "]) assert.equal(inPlayFromEnv({ EVENT_X_IN_PLAY: off }), false, `"${off}" turns it off`);
  assert.equal(DEFAULT_IN_PLAY_HOURS, 4);
  assert.equal(inPlayMaxMsFromEnv({}), 4 * 3_600_000);
  assert.equal(inPlayMaxMsFromEnv({ EVENT_X_IN_PLAY_HOURS: "3" }), 3 * 3_600_000);
  assert.equal(inPlayMaxMsFromEnv({ EVENT_X_IN_PLAY_HOURS: "2.5" }), 2.5 * 3_600_000);
  for (const bad of ["0", "-1", "abc"]) assert.equal(inPlayMaxMsFromEnv({ EVENT_X_IN_PLAY_HOURS: bad }), 4 * 3_600_000, `"${bad}" is the default, never an open-ended window`);
});

test("lock window: with in play on a game is open from seven days out, through the cutoff and the game, to the bound; off, it closes 45 minutes before the start", () => {
  const kick = Date.UTC(2026, 10, 10, 0, 10); // Mon Nov 9 2026 7:10pm ET
  const start = new Date(kick).toISOString();
  const at = (minutesBefore: number) => new Date(kick - minutesBefore * 60_000);
  const bound = new Date(kick + 4 * 3_600_000).toISOString();
  const cutoff = new Date(kick - 45 * 60_000).toISOString();
  assert.equal(PROTECT_WINDOW_MINUTES.min, 45);

  // in play on
  assert.deepEqual(lockWindow(start, at(3 * 60), true), { open: true, live: false, pastCutoff: false, untilIso: bound }, "pre-game: open, and it stays open until the bound");
  assert.deepEqual(lockWindow(start, at(45), true), { open: true, live: false, pastCutoff: false, untilIso: bound });
  assert.deepEqual(lockWindow(start, at(44), true), { open: true, live: false, pastCutoff: true, untilIso: bound }, "inside the old cutoff: open, not yet live, the lead-time gate set aside");
  assert.deepEqual(lockWindow(start, at(1), true), { open: true, live: false, pastCutoff: true, untilIso: bound });
  assert.deepEqual(lockWindow(start, at(0), true), { open: true, live: true, pastCutoff: true, untilIso: bound }, "the start itself is live");
  assert.deepEqual(lockWindow(start, at(-90), true), { open: true, live: true, pastCutoff: true, untilIso: bound }, "the second half");
  assert.deepEqual(lockWindow(start, at(-240), true), { open: true, live: true, pastCutoff: true, untilIso: bound }, "the bound's last minute");
  assert.deepEqual(lockWindow(start, at(-241), true), { open: false, live: false, pastCutoff: false, why: "in_progress", untilIso: bound }, "past the bound: closed");
  assert.deepEqual(lockWindow(start, at(7 * 24 * 60 + 1), true), { open: false, live: false, pastCutoff: false, why: "far_out", untilIso: bound });
  assert.equal(lockWindow(start, at(-100), true, 90 * 60_000).open, false, "the bound is the caller's");
  assert.equal(lockWindow(start, at(-80), true, 90 * 60_000).live, true);

  // in play off: the pre-game window, word for word
  for (const m of [3 * 60, 45, 44, 1, 0, -90, 7 * 24 * 60 + 1]) {
    const pre = protectWindow(start, at(m));
    assert.deepEqual(lockWindow(start, at(m), false), { open: pre.open, live: false, pastCutoff: false, ...(pre.why ? { why: pre.why } : {}), untilIso: cutoff }, `off, ${m} minutes before`);
  }
  assert.equal(lockWindow(start, at(-30), false).open, false, "off: a started game cannot be locked in");
  assert.equal(lockWindow(start, at(44), false).why, "too_close");
});

test("the pricer in play: refused past the start under the pre-game config, priced under the in-play one; a game nearly decided is still out of the band", () => {
  const TICKER = "KXNBAGAME-26NOV09LALBOS-BOS";
  const start = new Date(Date.now() - 30 * 60_000).toISOString();
  const noAsks: NoAskLevel[] = [
    { priceCents: 41, qtyMilli: 300_000 },
    { priceCents: 42, qtyMilli: 400_000 },
  ];
  const base = { pair: { kalshi: { ticker: TICKER }, gameStartTime: start }, markCents: 60, entryCents: 58, contracts: 20, now: new Date(), noAsks };
  const pre = quoteLadderWrap({ ...base, config: DEFAULT_CROSS_CONFIG });
  assert.ok(!pre.ok && pre.code === "market_too_close_to_start");
  const live = quoteLadderWrap({ ...base, config: inPlayConfig(DEFAULT_CROSS_CONFIG) });
  assert.ok(live.ok, JSON.stringify(live));
  const decided = quoteLadderWrap({ ...base, markCents: 97, config: inPlayConfig(DEFAULT_CROSS_CONFIG) });
  assert.ok(!decided.ok && decided.code === "mark_out_of_range");
});

test("a fee charged only once the game is live is in the price in play, and the order's limit comes back out at the venue's own ask", () => {
  const fee = { coefficient: 0.06, charged: "WHEN_LIVE" };
  const book = { marketId: "m", orders: { ours: [{ orderId: "a", price: "0.620", qty: 2000 }], theirs: [{ orderId: "d", price: "0.350", qty: 9000 }] } };
  // before the game: no fee, the ask is 1 - our bid
  assert.equal(signedFeeAppliesPreGame(fee), false);
  assert.deepEqual(signedAsksForOpposing(book, "ours", fee), [{ priceMilli: 380, sizeMilli: 20_000 }]);
  assert.deepEqual(signedAsksForOpposing(book, "ours", fee, false), [{ priceMilli: 380, sizeMilli: 20_000 }]);
  // in play: c x P x (1 - P) a unit, rounded up against the credit
  assert.equal(signedFeeAppliesLive(fee), true);
  const feeMilli = signedFeeMilli(0.06, 380);
  assert.equal(feeMilli, 15);
  assert.deepEqual(signedAsksForOpposing(book, "ours", fee, true), [{ priceMilli: 395, sizeMilli: 20_000 }]);
  // a hedge that leaves in play is paid the bid less the fee
  assert.deepEqual(signedBidsForOpposing(book, "theirs", fee, false), [{ priceMilli: 350, sizeMilli: 90_000 }]);
  assert.deepEqual(signedBidsForOpposing(book, "theirs", fee, true), [{ priceMilli: 350 - signedFeeMilli(0.06, 350), sizeMilli: 90_000 }]);
  // a market that never charges is never charged; an unknown rule is charged either way
  assert.equal(signedFeeAppliesLive({ charged: "NEVER" }), false);
  assert.equal(signedAsksForOpposing(book, "ours", { coefficient: 0.06, charged: "NEVER" }, true)[0].priceMilli, 380);
  assert.equal(signedAsksForOpposing(book, "ours", undefined, true)[0].priceMilli, 395);
  assert.equal(signedAsksForOpposing(book, "ours", { coefficient: 0.06, charged: "ALWAYS" }, false)[0].priceMilli, 395);

  // live is the venue's own word or our clock past the start, whichever comes first
  const start = "2026-11-10T00:10:00.000Z";
  assert.equal(signedEventLive(["OPEN"], start, new Date("2026-11-10T00:09:59.000Z")), false);
  assert.equal(signedEventLive(["OPEN"], start, new Date("2026-11-10T00:10:00.000Z")), true, "our clock past the start");
  assert.equal(signedEventLive(["IN_GAME"], start, new Date("2026-11-09T23:00:00.000Z")), true, "the venue's word, early");
  assert.equal(signedEventLive([undefined, "LIVE"], undefined, new Date()), true);
  assert.equal(signedEventLive([undefined], undefined, new Date()), false, "no word and no start: not live");

  // the order: the walked worst price carries the fee; the limit sent is the venue's raw ask, so a fill-or-kill can match
  assert.equal(rawAskMilliOf(395, { coefficient: 0.06, charged: true }), 380);
  const intent: HedgeIntent = {
    venue: "novig",
    instrument: "o-theirs",
    offsetInstrument: "o-ours",
    marketId: "m",
    armKey: "KXNBAGAME-26NOV09LALBOS-BOS",
    outcome: "LAL",
    unitsMilli: 13_000,
    book: { bestPriceMilli: 395, avgPriceMilli: 395, worstPriceMilli: 395, costCents: 514 },
    maxCostCents: 514,
  };
  const liveOrder = planNovigOrder(intent, { coefficient: 0.06, charged: true }, "atticus-x");
  assert.equal(liveOrder.limitMilli, 380, "in play: the fee comes off the walked price, the limit is the venue's ask");
  assert.equal(liveOrder.body.tif, "FOK");
  // had the price been walked without the fee (the old pre-game fold used in play), the limit would sit under the ask and never fill
  const stale = planNovigOrder({ ...intent, book: { ...intent.book, worstPriceMilli: 380 } }, { coefficient: 0.06, charged: true }, "atticus-x");
  assert.ok(stale.limitMilli < 380, "a fee-less walk sent in play undercuts the book");
});

// ---------------------------------------------------------------------------
// the worker's lock route during a game
// ---------------------------------------------------------------------------

const BOS = "KXNBAGAME-26NOV09LALBOS-BOS";
const BAL = "KXNFLGAME-26NOV05JAXBAL-BAL";
const SEA = "KXNFLGAME-26NOV02CHISEA-SEA";
const NO_ASKS: NoAskLevel[] = [
  { priceCents: 41, qtyMilli: 300_000 },
  { priceCents: 42, qtyMilli: 400_000 },
];

/** A candidate as quoteOne builds it for a game that began `minutesIn` ago: priced under the in-play config, flagged in play. */
function liveCandidate(ticker: string, contracts: number, entryCents: number, startIso: string): CandidateResult {
  const quote: CrossQuoteResult = quoteLadderWrap({
    pair: { kalshi: { ticker }, gameStartTime: startIso },
    markCents: 60,
    entryCents,
    contracts,
    now: new Date(),
    noAsks: NO_ASKS,
    config: inPlayConfig(DEFAULT_CROSS_CONFIG),
  });
  assert.ok(quote.ok, JSON.stringify(quote));
  return {
    kind: "sports",
    league: ticker.startsWith("KXNBA") ? "nba" : "nfl",
    market: {
      ticker,
      eventTicker: ticker.slice(0, ticker.lastIndexOf("-")),
      title: "Winner?",
      subtitle: "Side",
      strike: 0,
      strikeType: "",
      status: "active",
      openTime: "",
      closeTime: startIso,
      yesBidCents: 59,
      yesAskCents: 61,
      lastPriceCents: 60,
      volume: 1000,
      openInterest: 1000,
      rulesPrimary: "wins",
    },
    pair: null,
    sideName: ticker === BOS ? "Boston Celtics" : "Baltimore",
    eventTitle: ticker === BOS ? "Lakers at Celtics" : "Jaguars at Ravens",
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
    inPlay: true,
  };
}

test("lock route, a game under way: the list marks it in play, the book that moved locks nothing, the fill locks it, a parlay's last pick may be live; the switch off refuses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "in-play-"));
  const ledger = join(dir, "lock-ledger.jsonl");
  process.env.NODE_ENV = "test";
  process.env.EVENT_SHADOW_LEDGER_PATH = join(dir, "ledger.jsonl");
  process.env.EVENT_SHADOW_LOCK_LEDGER_PATH = ledger;
  process.env.EVENT_LASTLEG_LEDGER_PATH = join(dir, "lastleg.jsonl");
  process.env.EVENT_X_ADMIN_TOKEN = "op-secret";
  process.env.EVENT_SHADOW_LOCK_KEY = "lock-key-0123456789";
  process.env.EVENT_HEDGE_STRATEGY = "live";
  process.env.EVENT_HEDGE_LIVE_TICKERS = `${BOS},${BAL}`;
  process.env.EVENT_HEDGE_LIVE_SEND = "yes";
  delete process.env.EVENT_HEDGE_KILL_SWITCH;
  delete process.env.EVENT_X_IN_PLAY;
  process.env.KALSHI_API_KEY_ID = "test-key-id";
  process.env.KALSHI_PRIVATE_KEY_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const worker = await import("../scripts/eventShadowWorker");

  const started = new Date(Date.now() - 30 * 60_000).toISOString(); // both games began half an hour ago
  const until = new Date(Date.parse(started) + 4 * 3_600_000).toISOString();
  const markets: GameMarketRow[] = [
    { ticker: BOS, league: "nba", sideName: "Boston Celtics", title: "Lakers at Celtics Winner?", dateIso: "2026-11-09", closeTimeIso: until, markCents: 60, startIso: started, protectable: true, protectableUntilIso: until, inPlay: true },
    { ticker: BAL, league: "nfl", sideName: "Baltimore", title: "Jaguars at Ravens Winner?", dateIso: "2026-11-05", closeTimeIso: until, markCents: 60, startIso: started, protectable: true, protectableUntilIso: until, inPlay: true },
  ];
  const settledMarkets = async (series: string): Promise<KalshiSettledMarket[]> =>
    series === "KXNFLGAME"
      ? [{ ticker: SEA, eventTicker: "KXNFLGAME-26NOV02CHISEA", title: "Bears at Seahawks Winner?", subtitle: "Seattle", strike: 0, strikeType: "", status: "settled", openTime: "", closeTime: "2026-11-03T01:15:00.000Z", yesBidCents: 0, yesAskCents: 0, lastPriceCents: 0, volume: 0, openInterest: 0, rulesPrimary: "", rulesSecondary: "", result: "yes" }]
      : [];
  const script: Array<(i: HedgeIntent) => LiveOrderResult> = [];
  const sent: HedgeIntent[] = [];
  const hook: LiveOrderHook = async (intent) => {
    sent.push(intent);
    const step = script.shift();
    if (!step) throw new Error("unexpected order");
    return step(intent);
  };
  const fill = (i: HedgeIntent): LiveOrderResult => ({ orderId: `ord-${sent.length}`, unitsMilli: i.unitsMilli, avgPriceMilli: Math.ceil((i.book.costCents * 10_000) / i.unitsMilli), costCents: i.book.costCents, feesCents: 0, status: "executed" });
  const engine = {
    listGameMarkets: async () => markets,
    quoteOne: async (inputs: OneQuoteInputs): Promise<OneQuoteResult> => ({ ok: true, result: liveCandidate(inputs.ticker, inputs.contracts, inputs.entryCents ?? 58, started) }),
    settledMarkets,
    hedgeExecutor: new LiveHedgeExecutor({ kalshi: hook }, { ...DEFAULT_LIVE_RAILS, dryRun: false, allowlist: [BOS, BAL], maxUnitsPerOrderMilli: 100_000 }, () => 0),
  };
  worker.wireLockEngine(engine);
  await new Promise<void>((r) => worker.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
  const key = { "x-lock-key": "lock-key-0123456789", "content-type": "application/json" };
  const post = async (body: unknown) => {
    const res = await fetch(`${base}/api/shadow/lock`, { method: "POST", headers: key, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> & { hedge?: Record<string, unknown> } };
  };
  try {
    // the list the extension marks games from: in play is on, and the game under way is open to lock in
    const m = (await (await fetch(`${base}/api/shadow/markets`, { headers: key })).json()) as { ext: Record<string, unknown>; markets: Array<Record<string, unknown>> };
    assert.equal(m.ext.inPlay, true, "on unless the service says off");
    assert.equal(m.ext.cutoffMinutes, 45);
    assert.equal(m.markets[0].inPlay, true);
    assert.equal(m.markets[0].protectable, true);
    assert.equal(m.markets[0].protectableUntilIso, until);

    // the quote says the game is under way
    const q = (await (await fetch(`${base}/api/shadow/quote?ticker=${BOS}&contracts=20&entry=58`, { headers: key })).json()) as Record<string, unknown>;
    assert.equal(q.ok, true);
    assert.equal(q.inPlay, true);

    // the book moved between the read and the send: the order fills nothing, and nothing is locked
    script.push(() => {
      throw new Error("kalshi orders: order ord-0 canceled with nothing filled at or under 42c");
    });
    const miss = await post({ ticker: BOS, contracts: 20, entryCents: 58 });
    assert.equal(miss.body.ok, false);
    assert.equal(miss.body.code, "hedge_not_filled");
    assert.equal(loadShadowPositions(ledger).length, 0, "a moved book writes no lock");

    // the next tap fills whole: locked, in play, behind a real hedge
    script.push(fill);
    const ok = await post({ ticker: BOS, contracts: 20, entryCents: 58 });
    assert.equal(ok.body.ok, true, JSON.stringify(ok.body));
    assert.equal(ok.body.inPlay, true, "the answer says the game was under way");
    assert.equal(ok.body.hedge?.simulated, false);
    assert.equal(sent.at(-1)?.allOrNone, true);
    const lock = loadShadowPositions(ledger)[0];
    assert.equal(lock.ticker, BOS);
    assert.ok(lock.at > lock.eventTimeIso, "the record itself says the lock came after the start");
    assert.deepEqual(summarizePending(loadPending(join(dir, "lock-pending.jsonl"))).counts, { locked: 1, refused: 1, stray: 0, unconfirmed: 0, ledger_failed: 0 });

    // a parlay whose last pick is under way: with the switch off it is refused before anything is priced or sent
    const parlay = { picks: [{ code: "SEA", opp: "CHI", day: "Mon" }, { code: "BAL", opp: "JAX", day: "Thu" }], stakeCents: 1000, payoutCents: 6618 };
    const view = (await (await fetch(`${base}/api/shadow/picks?picks=SEA:CHI:Mon,BAL:JAX:Thu`, { headers: key })).json()) as { state: string; lastPick: { ticker: string; live?: boolean } | null };
    assert.equal(view.state, "last_pick");
    assert.equal(view.lastPick?.ticker, BAL);
    assert.equal(view.lastPick?.live, true, "the last pick's game is under way");
    worker.wireLockEngine({ ...engine, inPlay: false });
    const off = (await (await fetch(`${base}/api/shadow/markets`, { headers: key })).json()) as { ext: Record<string, unknown> };
    assert.equal(off.ext.inPlay, false, "the switch off reaches the extension");
    const before = sent.length;
    const refused = await post({ ticker: BAL, contracts: 66.18, entryCents: 15, parlay });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, "parlay_in_play");
    assert.equal(sent.length, before, "no order for a refused ticket");

    // on (the default): the ticket is one position on the last game; the hedge fills and it is locked
    worker.wireLockEngine({ ...engine, inPlay: true });
    script.push(fill);
    const ticket = await post({ ticker: BAL, contracts: 66.18, entryCents: 15, parlay });
    assert.equal(ticket.status, 200, JSON.stringify(ticket.body));
    assert.equal(ticket.body.ok, true);
    assert.equal(ticket.body.inPlay, true);
    assert.equal(ticket.body.hedge?.simulated, false);
    const locks = loadShadowPositions(ledger);
    assert.equal(locks.length, 2);
    assert.ok(locks.find((p) => p.ticker === BAL)?.parlay, "the record carries the picks");
  } finally {
    await new Promise<void>((r) => worker.server.close(() => r()));
  }
});
