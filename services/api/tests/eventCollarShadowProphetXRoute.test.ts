/**
 * The ProphetX route end to end on the shadow worker, as tonight's demo runs it: a holder on a
 * Novig page, Kalshi and ProphetX both live through the aggregator's pod (two fake hooks stand in
 * for the pod), the ticker armed. With two live venues nothing is pinned: the routing competes
 * them, ProphetX pays more for the same protection and wins, the quote carries the comparison in
 * one line, the lock buys the ProphetX strike live (the rails read the game's Kalshi ticker as the
 * arm key), the record keeps both strike ids, the leave is priced on the strike's book and sent
 * as the OFFSET buy of the holder's strike, the close says the pair settles at the game, and the
 * receipt names ProphetX on both legs. The engine is faked; the routing is hedgeRouting's own.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quoteCrossWrap } from "../src/eventCollar/crossVenue/crossVenuePricer";
import type { EarlyCloseBooks } from "../src/eventCollar/crossVenue/earlyClose";
import { actionOf, type HedgeIntent } from "../src/eventCollar/crossVenue/hedgeExecutor";
import { DEFAULT_TAIL_PROBABILITIES, chooseRoute, tableRules, type HedgeRouting } from "../src/eventCollar/crossVenue/hedgeRouting";
import { quoteLadderWrap, type NoAskLevel } from "../src/eventCollar/crossVenue/kalshiLadder";
import { LiveHedgeExecutor, type LiveOrderHook } from "../src/eventCollar/crossVenue/liveHedge";
import { foldProphetXFee } from "../src/eventCollar/crossVenue/prophetxOrders";
import { loadShadowPositions, type ShadowCloseRecord, type ShadowOpenRecord } from "../src/eventCollar/crossVenue/shadowLedger";
import { DEFAULT_CROSS_CONFIG, type CrossQuoteResult, type KalshiMarket, type MatchedPair, type PmBook } from "../src/eventCollar/crossVenue/types";
import type { CandidateResult, GameMarketRow, OneQuoteInputs, OneQuoteResult } from "../scripts/eventProtectXDemoService";

const TICKER = "KXNBAGAME-26OCT14LALBOS-BOS";
const START = new Date(Date.now() + 3 * 3_600_000).toISOString();
const STRIKES = { hedgeStrikeId: "px-strike-lal", offsetStrikeId: "px-strike-bos", executable: true };
/** Kalshi's No side: 41c then 42c. */
const NO_ASKS: NoAskLevel[] = [
  { priceCents: 41, qtyMilli: 300_000 },
  { priceCents: 42, qtyMilli: 400_000 },
];
/** ProphetX's opposing strike, raw venue prices: a deeper, cheaper book (36c), bids at 34c. */
const PX_RAW: PmBook = { tokenId: STRIKES.hedgeStrikeId, asks: [{ priceMilli: 360, sizeMilli: 2_000_000 }], bids: [{ priceMilli: 340, sizeMilli: 2_000_000 }], minOrderSizeShares: 1, tickMilli: 1 };

function pair(): MatchedPair {
  const kalshi: KalshiMarket = { ticker: TICKER, eventTicker: TICKER.slice(0, TICKER.lastIndexOf("-")), title: "Winner?", subtitle: "Boston", strike: 0, strikeType: "", status: "active", openTime: "", closeTime: START, yesBidCents: 59, yesAskCents: 61, lastPriceCents: 60, volume: 1000, openInterest: 1000, rulesPrimary: "" };
  return {
    league: "nba",
    kalshi,
    pm: { eventSlug: "nba-lal-bos", eventTitle: "Lakers at Celtics", question: "Lakers at Celtics", conditionId: "0x1", outcomes: ["Boston Celtics", "Los Angeles Lakers"], tokenIds: ["t-bos", "t-lal"], outcomePricesMilli: [600, 400], gameStartTime: START, endDate: START, sportsMarketType: "moneyline", active: true, closed: false, acceptingOrders: true, negRisk: false, orderMinSizeShares: 5, liquidityUsd: 9000, volumeUsd: 100 },
    pmYesOutcomeIndex: 0,
    pmNoOutcomeIndex: 1,
    gameStartTime: START,
    parityNote: "",
    fingerprint: `test:${TICKER}`,
  };
}

/** Both offered routes priced from their books, judged by hedgeRouting against a Novig holder. */
function candidate(contracts: number, entryCents: number): CandidateResult {
  const p = pair();
  const base = { markCents: 60, entryCents, contracts, now: new Date(), config: DEFAULT_CROSS_CONFIG };
  const kq: CrossQuoteResult = quoteLadderWrap({ ...base, pair: { kalshi: { ticker: TICKER }, gameStartTime: START }, noAsks: NO_ASKS });
  const pxq: CrossQuoteResult = quoteCrossWrap({ ...base, pair: p, noBook: foldProphetXFee(PX_RAW, 200), hedgeOn: { venue: "prophetx", strikeId: STRIKES.hedgeStrikeId, offsetStrikeId: STRIKES.offsetStrikeId, outcome: "Los Angeles Lakers" } });
  assert.ok(kq.ok && pxq.ok, JSON.stringify({ kq, pxq }));
  assert.ok(pxq.creditCents > kq.creditCents, "the fixture: ProphetX pays the holder more");
  const routing: HedgeRouting = chooseRoute({
    holderVenue: "novig",
    league: "nba",
    holderRules: tableRules("novig", "nba"),
    markCents: 60,
    contracts,
    probabilities: DEFAULT_TAIL_PROBABILITIES.nba,
    routes: [
      { route: "kalshi_self", ok: true, evCostBps: kq.evCostBps, creditCents: kq.creditCents, hedge: { unitsMilli: kq.hedge.venue === "kalshi" ? kq.hedge.contractsMilli : 0, avgPriceCents: kq.hedge.venue === "kalshi" ? kq.hedge.avgPriceCents : 0, floorCents: kq.floorCents, capCents: kq.capCents }, gates: { gameMatch: true, venueOpen: true, executable: true }, rules: tableRules("kalshi", "nba") },
      { route: "prophetx", ok: true, evCostBps: pxq.evCostBps, creditCents: pxq.creditCents, hedge: { unitsMilli: pxq.hedge.venue === "prophetx" ? pxq.hedge.sharesMilli : 0, avgPriceCents: pxq.hedge.venue === "prophetx" ? Math.ceil(pxq.hedge.avgPriceMilli / 10) : 0, floorCents: pxq.floorCents, capCents: pxq.capCents }, gates: { gameMatch: true, venueOpen: true, executable: true }, rules: tableRules("prophetx", "nba") },
    ],
  });
  assert.equal(routing.chosen, "prophetx");
  return {
    kind: "sports",
    league: "nba",
    market: p.kalshi,
    pair: p,
    sideName: "Boston Celtics",
    eventTitle: "Lakers at Celtics",
    eventTimeIso: START,
    parityNote: "",
    fingerprint: `test:${TICKER}`,
    markCents: 60,
    position: { contracts, entryCents, entrySource: "entered_now", entryTime: null },
    quote: pxq,
    route: "prophetx",
    evBps: pxq.evCostBps,
    routesChecked: [],
    books: { noAsks: NO_ASKS, pxNoBook: PX_RAW, prophetx: STRIKES },
    routing,
  };
}

test("shadow worker, ProphetX route: two live venues compete (no pin), the lock buys the strike live, the leave buys the offset, the record and receipt name ProphetX and the pair that settles at the game", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-prophetx-route-"));
  const ledger = join(dir, "lock-ledger.jsonl");
  process.env.NODE_ENV = "test";
  process.env.EVENT_SHADOW_LEDGER_PATH = join(dir, "ledger.jsonl");
  process.env.EVENT_SHADOW_LOCK_LEDGER_PATH = ledger;
  process.env.EVENT_LASTLEG_LEDGER_PATH = join(dir, "lastleg.jsonl");
  process.env.EVENT_HEDGE_RECEIPTS_PATH = join(dir, "hedge-receipts.jsonl");
  process.env.EVENT_X_ADMIN_TOKEN = "op-secret";
  process.env.EVENT_SHADOW_LOCK_KEY = "lock-key-0123456789";
  process.env.EVENT_HEDGE_VENUES = "kalshi,prophetx";
  // tonight's rails: live through the aggregator's pod, both venues, the ticker armed, sending on.
  // A throwaway TRADE key so the env builds both clients; the executor is replaced below, nothing is signed or sent.
  process.env.EVENT_HEDGE_STRATEGY = "live";
  process.env.EVENT_HEDGE_LIVE_VIA = "aggregator";
  process.env.EVENT_HEDGE_LIVE_TICKERS = TICKER;
  process.env.EVENT_HEDGE_LIVE_SEND = "yes";
  process.env.AGGREGATOR_TRADE_KEY_ID = "7a1d2c3b-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
  process.env.AGGREGATOR_TRADE_PRIVATE_KEY_HEX = "11".repeat(32);
  delete process.env.KALSHI_API_KEY_ID;
  delete process.env.KALSHI_PRIVATE_KEY_PEM;
  const worker = await import("../scripts/eventShadowWorker");

  // the fake pod: a ProphetX buy fills in full at the raw 0.36 (costed with 2% of the gain); the offset
  // fills in full at 1 - 0.34 = 0.66, its proceeds the 34c less the fee on that gain, at the game
  const orders: Array<{ action: string; intent: HedgeIntent; clientOrderId: string }> = [];
  const pxHook: LiveOrderHook = async (intent, clientOrderId) => {
    orders.push({ action: actionOf(intent), intent, clientOrderId });
    if (actionOf(intent) === "sell") {
      const gross = Math.floor((intent.unitsMilli * 340) / 10_000);
      const fee = Math.ceil((gross * 200) / 10_000);
      return { orderId: "px-offset-1", venueOrderId: "pxv-2", unitsMilli: intent.unitsMilli, avgPriceMilli: Math.floor(((gross - fee) * 10_000) / intent.unitsMilli), costCents: gross - fee, feesCents: fee, status: "executed", via: "aggregator", note: `offset bought: ${intent.unitsMilli / 1000} shares of strike ${intent.offsetInstrument}; the pair settles at the game` };
    }
    const stake = Math.ceil((intent.unitsMilli * 360) / 10_000);
    const gain = Math.floor(intent.unitsMilli / 10) - stake;
    const cost = stake + Math.ceil((gain * 200) / 10_000);
    return { orderId: "px-buy-1", venueOrderId: "pxv-1", unitsMilli: intent.unitsMilli, avgPriceMilli: Math.ceil((cost * 10_000) / intent.unitsMilli), costCents: cost, feesCents: 0, status: "executed", via: "aggregator" };
  };
  const kalshiHook: LiveOrderHook = async () => {
    throw new Error("the Kalshi hook must not be called: the routing chose ProphetX");
  };
  const seen: OneQuoteInputs[] = [];
  const closeBooksSeen: Array<{ route: string; hedgeStrikeId?: string }> = [];
  const books: EarlyCloseBooks = { kalshi: { yesBids: [{ priceCents: 62, qtyMilli: 1_000_000 }], noBids: [{ priceCents: 38, qtyMilli: 1_000_000 }] }, pxNoBook: foldProphetXFee(PX_RAW, 200) };
  const markets: GameMarketRow[] = [{ ticker: TICKER, league: "nba", sideName: "Boston Celtics", title: "Winner?", dateIso: "2026-10-14", closeTimeIso: START, markCents: 60, startIso: START, protectable: true, protectableUntilIso: START }];
  worker.wireLockEngine({
    listGameMarkets: async () => markets,
    quoteOne: async (inputs: OneQuoteInputs): Promise<OneQuoteResult> => {
      seen.push(inputs);
      return { ok: true, result: candidate(inputs.contracts, inputs.entryCents ?? 60) };
    },
    closeBooks: async (p) => {
      closeBooksSeen.push({ route: p.route, hedgeStrikeId: p.hedgeStrikeId });
      return books;
    },
    hedgeExecutor: new LiveHedgeExecutor({ kalshi: kalshiHook, prophetx: pxHook }, { killSwitch: false, dryRun: false, allowlist: [TICKER], maxUnitsPerOrderMilli: 50_000, maxUnitsPerDayMilli: 200_000 }, () => 0),
  });
  await new Promise<void>((r) => worker.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
  const key = { "x-lock-key": "lock-key-0123456789" };
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { ...key, "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    // the status page says which venues compete tonight
    const health = (await (await fetch(`${base}/healthz?token=op-secret`)).json()) as { hedge: { offeredVenues: string[]; offeredVenuesSource: string; prophetxFeeBps: number; live: { venues: string[] } } };
    assert.deepEqual([health.hedge.offeredVenues, health.hedge.offeredVenuesSource, health.hedge.prophetxFeeBps], [["Kalshi", "ProphetX"], "env", 200]);
    assert.deepEqual(health.hedge.live.venues, ["kalshi", "prophetx"], "both live through the pod");

    // the quote: nothing pinned with two live venues; both executable; the comparison in one line
    const q = (await (await fetch(`${base}/api/shadow/quote?ticker=${TICKER}&contracts=20&venue=novig`, { headers: key })).json()) as {
      ok: boolean;
      routing: { holderVenue: string; hedgeVenue: string; hedgeVenueName: string; reason: string; comparison: string; routes: Array<{ route: string; hedgeVenueName: string; ok: boolean; creditCents: number | null; terms: { floorCents: number; capCents: number } | null }> };
    };
    assert.ok(q.ok, JSON.stringify(q));
    assert.equal(seen.at(-1)?.route, undefined, "two live venues: the routing competes, nothing is pinned");
    assert.deepEqual(seen.at(-1)?.executable, { kalshi_self: true, polymarket: false, prophetx: true, novig: false });
    assert.deepEqual([q.routing.holderVenue, q.routing.hedgeVenue, q.routing.hedgeVenueName], ["novig", "prophetx", "ProphetX"]);
    assert.match(q.routing.reason, /^ProphetX: cheaper all in/);
    const px = q.routing.routes.find((r) => r.route === "prophetx")!;
    const ks = q.routing.routes.find((r) => r.route === "kalshi_self")!;
    assert.ok(px.creditCents !== null && ks.creditCents !== null && px.creditCents > ks.creditCents);
    assert.ok(px.terms && ks.terms, "each route carries the collar its book funded");
    assert.equal(q.routing.comparison, `ProphetX $${(px.creditCents / 100).toFixed(2)} vs Kalshi $${(ks.creditCents / 100).toFixed(2)}, hedged on ProphetX`);

    // the lock: the ProphetX strike bought live through the pod's hook, armed by the game's Kalshi ticker
    const lock = (await (await post("/api/shadow/lock", { ticker: TICKER, contracts: 20, entryCents: 60, venue: "novig" })).json()) as {
      ok: boolean;
      creditCents: number;
      hedge: { action: string; simulated: boolean; orderId: string; via: string; venue: string; route: string; unitsMilli: number; costCents: number };
      routing: { hedgeVenue: string; comparison: string };
    };
    assert.ok(lock.ok, JSON.stringify(lock));
    assert.equal(lock.creditCents, px.creditCents);
    assert.deepEqual([lock.hedge.action, lock.hedge.simulated, lock.hedge.orderId, lock.hedge.via, lock.hedge.venue, lock.hedge.route], ["buy", false, "px-buy-1", "aggregator", "ProphetX", "prophetx"]);
    assert.equal(lock.routing.hedgeVenue, "prophetx");
    assert.equal(orders.length, 1);
    const buy = orders[0];
    assert.deepEqual([buy.action, buy.intent.venue, buy.intent.instrument, buy.intent.offsetInstrument, buy.intent.armKey], ["buy", "prophetx", STRIKES.hedgeStrikeId, STRIKES.offsetStrikeId, TICKER]);
    assert.equal(buy.intent.book.bestPriceMilli, foldProphetXFee(PX_RAW, 200).asks[0].priceMilli, "the best is the fee-folded top of the strike's book");
    const [open] = loadShadowPositions(ledger);
    assert.deepEqual([open.route, open.hedgeStrikeId, open.hedgeOffsetStrikeId, open.holderVenue], ["prophetx", STRIKES.hedgeStrikeId, STRIKES.offsetStrikeId, "novig"]);
    const openLine = JSON.parse(readFileSync(ledger, "utf8").trim().split("\n")[0]) as ShadowOpenRecord;
    assert.equal(openLine.routing?.chosen, "prophetx");
    assert.equal(openLine.counterfactuals?.routes.prophetx.ok, true, "the live route's counterfactual is the live terms");
    assert.equal(openLine.counterfactuals?.routes.kalshi_self.ok, true, "Kalshi re-priced from the same books");

    // the public record never carries the venue's strike ids
    const pub = (await (await fetch(`${base}/api/shadow`)).json()) as { open: Array<Record<string, unknown>> };
    const pubText = JSON.stringify(pub);
    assert.ok(!pubText.includes(STRIKES.hedgeStrikeId) && !pubText.includes(STRIKES.offsetStrikeId));

    // the leave: priced on the strike's book read by its id, sent as the offset buy
    const pre = (await (await fetch(`${base}/api/shadow/unwind/quote?ticker=${TICKER}`, { headers: key })).json()) as { ok: boolean; unwind: { hedgeProceedsCents: number; protectedAtCloseCents: number } };
    assert.ok(pre.ok, JSON.stringify(pre));
    assert.deepEqual(closeBooksSeen.at(-1), { route: "prophetx", hedgeStrikeId: STRIKES.hedgeStrikeId });
    const foldedBid = foldProphetXFee(PX_RAW, 200).bids[0].priceMilli;
    assert.equal(pre.unwind.hedgeProceedsCents, Math.floor((open.hedgeUnitsMilli * foldedBid) / 10_000));
    const done = (await (await post("/api/shadow/unwind", { ticker: TICKER })).json()) as {
      ok: boolean;
      status: string;
      unwind: { hedgeProceedsCents: number; protectedAtCloseCents: number };
      hedge: { sent: boolean; note: string; sale: { action: string; simulated: boolean; orderId: string; venue: string; route: string; settlesAtGame?: boolean; costCents: number; unitsMilli: number } };
    };
    assert.ok(done.ok, JSON.stringify(done));
    assert.equal(done.status, "closed");
    assert.equal(done.hedge.sent, true);
    const offset = orders.find((o) => o.action === "sell")!;
    assert.ok(offset, "the offset was sent");
    assert.deepEqual([offset.intent.venue, offset.intent.instrument, offset.intent.offsetInstrument, offset.intent.armKey, offset.intent.unitsMilli], ["prophetx", STRIKES.hedgeStrikeId, STRIKES.offsetStrikeId, TICKER, open.hedgeUnitsMilli]);
    assert.equal(offset.intent.book.worstPriceMilli, foldedBid, "the walk's worst fee-folded bid rides on the intent");
    assert.deepEqual([done.hedge.sale.action, done.hedge.sale.simulated, done.hedge.sale.orderId, done.hedge.sale.venue, done.hedge.sale.route, done.hedge.sale.settlesAtGame], ["sell", false, "px-offset-1", "ProphetX", "prophetx", true]);
    const gross = Math.floor((open.hedgeUnitsMilli * 340) / 10_000);
    const net = gross - Math.ceil((gross * 200) / 10_000);
    assert.equal(done.hedge.sale.costCents, net);
    assert.equal(done.unwind.hedgeProceedsCents, net, "the close is written at what the offset fetches at the game, nothing left over");
    assert.equal(done.unwind.protectedAtCloseCents, pre.unwind.protectedAtCloseCents + (net - pre.unwind.hedgeProceedsCents));
    assert.match(done.hedge.note, /^offset on ProphetX, order px-offset-1 via the aggregator's pod: /);
    assert.match(done.hedge.note, /net when the pair settles at the game$/);
    const lines = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const rec = lines[1] as unknown as ShadowCloseRecord;
    assert.deepEqual([rec.type, rec.priced, rec.source, rec.hedgeSent, rec.hedgeProceedsCents], ["close", true, "unwind", true, net]);

    // the receipt: both legs on ProphetX, the sale marked as settling at the game, the comparison kept
    const rcpt = (await (await fetch(`${base}/api/shadow/receipt?ticker=${TICKER}`, { headers: key })).json()) as {
      hedge: { venue: string; orderId: string; simulated: boolean };
      hedgeSale: { venue: string; orderId: string; settlesAtGame?: boolean };
      routing: { hedgeVenue: string; comparison: string };
    };
    assert.deepEqual([rcpt.hedge.venue, rcpt.hedge.orderId, rcpt.hedge.simulated], ["ProphetX", "px-buy-1", false]);
    assert.deepEqual([rcpt.hedgeSale.venue, rcpt.hedgeSale.orderId, rcpt.hedgeSale.settlesAtGame], ["ProphetX", "px-offset-1", true]);
    assert.equal(rcpt.routing.comparison, q.routing.comparison);
  } finally {
    await new Promise<void>((r) => worker.server.close(() => r()));
  }
});
