/**
 * Leave early on an armed ticker: the hedge sale goes to the venue through the live executor
 * (a fake Kalshi hook stands in for the venue), the close line carries hedgeSent true at what the
 * venue paid, a remainder an IOC left behind is carried at the walked worst bid and named, the
 * receipt shows both the buy and the sale. The lock's own hedge fills live through the same hook.
 * The engine is faked; the routing on quote, lock and receipt rides along from hedgeRouting.ts.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EarlyCloseBooks } from "../src/eventCollar/crossVenue/earlyClose";
import { actionOf, type HedgeIntent } from "../src/eventCollar/crossVenue/hedgeExecutor";
import { DEFAULT_TAIL_PROBABILITIES, chooseRoute, tableRules, type HedgeRouting } from "../src/eventCollar/crossVenue/hedgeRouting";
import { quoteLadderWrap, type NoAskLevel } from "../src/eventCollar/crossVenue/kalshiLadder";
import { LiveHedgeExecutor, type LiveOrderHook } from "../src/eventCollar/crossVenue/liveHedge";
import { loadShadowPositions, type ShadowCloseRecord, type ShadowOpenRecord } from "../src/eventCollar/crossVenue/shadowLedger";
import { DEFAULT_CROSS_CONFIG, type CrossQuoteResult } from "../src/eventCollar/crossVenue/types";
import type { CandidateResult, GameMarketRow, OneQuoteInputs, OneQuoteResult } from "../scripts/eventProtectXDemoService";

const TICKER = "KXNBAGAME-26OCT14LALBOS-BOS";
const START = new Date(Date.now() + 3 * 3_600_000).toISOString();
const NO_ASKS: NoAskLevel[] = [
  { priceCents: 41, qtyMilli: 300_000 },
  { priceCents: 42, qtyMilli: 400_000 },
];

/** The routing the engine would judge: a holder on ProphetX, the hedge priced on Kalshi's own No side only. */
function routingFor(holderVenue: "kalshi" | "prophetx", quote: Extract<CrossQuoteResult, { ok: true }>): HedgeRouting {
  return chooseRoute({
    holderVenue,
    league: "nba",
    holderRules: tableRules(holderVenue, "nba"),
    markCents: 60,
    contracts: quote.contracts,
    probabilities: DEFAULT_TAIL_PROBABILITIES.nba,
    routes: [
      {
        route: "kalshi_self",
        ok: true,
        evCostBps: quote.evCostBps,
        hedge: { unitsMilli: quote.hedge.contractsMilli, avgPriceCents: quote.hedge.avgPriceCents, floorCents: quote.floorCents, capCents: quote.capCents },
        gates: { gameMatch: true, venueOpen: true, executable: true },
        rules: tableRules("kalshi", "nba"),
      },
      { route: "polymarket", ok: false, refusalCode: "no_matched_market", refusalDetail: "no Polymarket market for this game", evCostBps: null, gates: { gameMatch: false, venueOpen: false, executable: false }, rules: tableRules("polymarket", "nba") },
    ],
  });
}

function candidate(contracts: number, entryCents: number, holderVenue: "kalshi" | "prophetx"): CandidateResult {
  const quote: CrossQuoteResult = quoteLadderWrap({
    pair: { kalshi: { ticker: TICKER }, gameStartTime: START },
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
    market: { ticker: TICKER, eventTicker: TICKER.slice(0, TICKER.lastIndexOf("-")), title: "Winner?", subtitle: "", strike: 0, strikeType: "", status: "active", openTime: "", closeTime: START, yesBidCents: 59, yesAskCents: 61, lastPriceCents: 60, volume: 1000, openInterest: 1000, rulesPrimary: "" },
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
    routing: routingFor(holderVenue, quote),
  };
}

test("shadow worker: on an armed ticker the hedge is bought live at the lock and sold live at the leave; the close carries hedgeSent true at the venue's proceeds; the routing rides on quote, lock and receipt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-unwind-sale-"));
  const ledger = join(dir, "lock-ledger.jsonl");
  process.env.NODE_ENV = "test";
  process.env.EVENT_SHADOW_LEDGER_PATH = join(dir, "ledger.jsonl");
  process.env.EVENT_SHADOW_LOCK_LEDGER_PATH = ledger;
  process.env.EVENT_LASTLEG_LEDGER_PATH = join(dir, "lastleg.jsonl");
  process.env.EVENT_HEDGE_RECEIPTS_PATH = join(dir, "hedge-receipts.jsonl");
  process.env.EVENT_X_ADMIN_TOKEN = "op-secret";
  process.env.EVENT_SHADOW_LOCK_KEY = "lock-key-0123456789";
  // live rails: the ticker armed, sending on; a throwaway key so the env's Kalshi client exists and the
  // route is pinned to Kalshi's own No side. The executor itself is replaced below, so nothing is signed or sent.
  process.env.EVENT_HEDGE_STRATEGY = "live";
  process.env.EVENT_HEDGE_LIVE_TICKERS = TICKER;
  process.env.EVENT_HEDGE_LIVE_SEND = "yes";
  process.env.KALSHI_API_KEY_ID = "test-key-id";
  process.env.KALSHI_PRIVATE_KEY_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const worker = await import("../scripts/eventShadowWorker");

  // the fake venue: buys fill in full at 41c all in; a sale fills all but two contracts at 38c less 3c of fees
  const orders: Array<{ action: string; intent: HedgeIntent; clientOrderId: string }> = [];
  const hook: LiveOrderHook = async (intent, clientOrderId) => {
    orders.push({ action: actionOf(intent), intent, clientOrderId });
    if (actionOf(intent) === "sell") {
      const sold = intent.unitsMilli - 2_000;
      const gross = Math.floor((sold * 38) / 1000);
      return { orderId: "ord-sell-1", unitsMilli: sold, avgPriceMilli: Math.floor(((gross - 3) * 10_000) / sold), costCents: gross - 3, feesCents: 3, status: "canceled" };
    }
    const cost = Math.ceil((intent.unitsMilli * 41) / 1000);
    return { orderId: "ord-buy-1", unitsMilli: intent.unitsMilli, avgPriceMilli: 410, costCents: cost, feesCents: 0, status: "executed" };
  };
  const seen: OneQuoteInputs[] = [];
  const books: EarlyCloseBooks = { kalshi: { yesBids: [{ priceCents: 62, qtyMilli: 1_000_000 }], noBids: [{ priceCents: 38, qtyMilli: 1_000_000 }] } };
  const markets: GameMarketRow[] = [{ ticker: TICKER, league: "nba", sideName: "Boston Celtics", title: "Winner?", dateIso: "2026-10-14", closeTimeIso: START, markCents: 60, startIso: START, protectable: true, protectableUntilIso: START }];
  worker.wireLockEngine({
    listGameMarkets: async () => markets,
    quoteOne: async (inputs: OneQuoteInputs): Promise<OneQuoteResult> => {
      seen.push(inputs);
      return { ok: true, result: candidate(inputs.contracts, inputs.entryCents ?? 60, inputs.holderVenue === "prophetx" ? "prophetx" : "kalshi") };
    },
    closeBooks: async () => books,
    hedgeExecutor: new LiveHedgeExecutor({ kalshi: hook }, { killSwitch: false, dryRun: false, allowlist: [TICKER], maxUnitsPerOrderMilli: 50_000, maxUnitsPerDayMilli: 200_000 }, () => 0),
  });
  await new Promise<void>((r) => worker.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
  const key = { "x-lock-key": "lock-key-0123456789" };
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { ...key, "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    // the quote carries the holder's venue to the engine and answers with the routing in the holder's words
    const bad = await fetch(`${base}/api/shadow/quote?ticker=${TICKER}&contracts=10&venue=draftkings`, { headers: key });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { message: string }).message, /venue must be kalshi, polymarket, prophetx or novig/);
    const q = (await (await fetch(`${base}/api/shadow/quote?ticker=${TICKER}&contracts=15.95&venue=ProphetX`, { headers: key })).json()) as {
      ok: boolean;
      routing: { holderVenue: string; holderVenueName: string; hedgeVenue: string; hedgeVenueName: string; reason: string; evCostBps: number; tailChargeBps: number; allInBps: number; compatible: boolean; routes: Array<{ route: string; ok: boolean; refusal?: string }>; tails: Array<{ branch: string; text: string }>; rules: Record<string, { treatment: string; confirmed: boolean; source: string }>; route?: string };
    };
    assert.ok(q.ok, JSON.stringify(q));
    assert.equal(seen.at(-1)?.holderVenue, "prophetx", "the venue reaches the engine, lowercased");
    assert.deepEqual(seen.at(-1)?.executable, { kalshi_self: true, polymarket: false, prophetx: false, novig: false }, "armed and live: only the venue the live executor has a client for");
    assert.equal(seen.at(-1)?.route, "kalshi_self", "the armed ticker with one live venue pins the route to it: Kalshi's own No side");
    assert.deepEqual([q.routing.holderVenue, q.routing.holderVenueName, q.routing.hedgeVenue, q.routing.hedgeVenueName], ["prophetx", "ProphetX", "kalshi", "Kalshi"]);
    assert.equal(q.routing.allInBps, q.routing.evCostBps + q.routing.tailChargeBps);
    assert.ok(q.routing.tailChargeBps >= 0);
    assert.deepEqual(
      q.routing.routes.map((r) => [r.route, r.ok]),
      [
        ["kalshi_self", true],
        ["polymarket", false],
      ],
    );
    assert.equal(q.routing.routes[1].refusal, "no Polymarket market for this game");
    assert.deepEqual(
      q.routing.tails.map((t) => t.branch),
      ["tie", "postponed", "abandoned", "corrected"],
    );
    assert.ok(q.routing.tails.every((t) => t.text.length > 20), "the tails are sentences in the holder's venue's words");
    assert.equal(q.routing.rules.tie.source.length > 10, true, "the rule cells keep where the venue says it");
    assert.equal(q.routing.route, undefined, "the holder does not see the operator's route verdicts");
    const opQ = (await (await fetch(`${base}/api/shadow/quote?ticker=${TICKER}&contracts=15.95&venue=prophetx&token=op-secret`)).json()) as { routing: { route: string; pinned: string } };
    assert.deepEqual([opQ.routing.route, opQ.routing.pinned], ["kalshi_self", "kalshi_self"], "the operator does");

    // the lock: the venue on the body reaches the engine, the hedge buys live through the hook, the record carries the routing
    const lock = (await (await post("/api/shadow/lock", { ticker: TICKER, contracts: 15.95, entryCents: 60, venue: "prophetx" })).json()) as {
      ok: boolean;
      contracts: number;
      hedge: { action: string; simulated: boolean; orderId: string; via: string; venue: string; unitsMilli: number };
      routing: { holderVenue: string; hedgeVenue: string; reason: string };
    };
    assert.ok(lock.ok, JSON.stringify(lock));
    assert.equal(lock.contracts, 15.95);
    assert.equal(seen.at(-1)?.holderVenue, "prophetx");
    assert.deepEqual([lock.hedge.action, lock.hedge.simulated, lock.hedge.orderId, lock.hedge.via, lock.hedge.venue], ["buy", false, "ord-buy-1", "direct", "Kalshi"]);
    assert.deepEqual([lock.routing.holderVenue, lock.routing.hedgeVenue], ["prophetx", "kalshi"]);
    assert.deepEqual(
      orders.map((o) => o.action),
      ["buy"],
    );
    const [open] = loadShadowPositions(ledger);
    assert.equal(open.status, "open");
    const openLine = JSON.parse(readFileSync(ledger, "utf8").trim().split("\n")[0]) as ShadowOpenRecord;
    assert.equal(openLine.holderVenue, "prophetx");
    assert.equal(openLine.routing?.chosen, "kalshi_self");
    assert.equal(openLine.routing?.holderVenue, "prophetx");
    assert.equal(openLine.hedgeUnitsMilli, lock.hedge.unitsMilli);

    // the leave: quoted into the books, the sale sent through the hook (all but two contracts fill),
    // the close written at what the venue paid plus the remainder at the walked worst bid
    const pre = (await (await fetch(`${base}/api/shadow/unwind/quote?ticker=${TICKER}`, { headers: key })).json()) as { ok: boolean; unwind: { hedgeProceedsCents: number; protectedAtCloseCents: number } };
    assert.ok(pre.ok, JSON.stringify(pre));
    const done = (await (await post("/api/shadow/unwind", { ticker: TICKER })).json()) as {
      ok: boolean;
      status: string;
      unwind: { hedgeProceedsCents: number; protectedAtCloseCents: number; closeNetCents: number };
      hedge: { sent: boolean; note: string; sale: { action: string; simulated: boolean; orderId: string; unitsMilli: number; costCents: number; venue: string } };
      cash: Array<{ leg: string; to: string; dueCents: number }>;
    };
    assert.ok(done.ok, JSON.stringify(done));
    assert.equal(done.status, "closed");
    assert.equal(done.hedge.sent, true, "the sale went to the venue");
    const sale = orders.find((o) => o.action === "sell");
    assert.ok(sale, "one sale was sent");
    assert.equal(sale.intent.instrument, TICKER);
    assert.equal(sale.intent.unitsMilli, open.hedgeUnitsMilli, "the whole hedge is offered");
    assert.equal(sale.intent.book.worstPriceMilli, 380, "at or over the walked worst bid");
    const soldMilli = open.hedgeUnitsMilli - 2_000;
    const soldNet = Math.floor((soldMilli * 38) / 1000) - 3;
    assert.deepEqual([done.hedge.sale.action, done.hedge.sale.simulated, done.hedge.sale.orderId, done.hedge.sale.unitsMilli, done.hedge.sale.costCents, done.hedge.sale.venue], ["sell", false, "ord-sell-1", soldMilli, soldNet, "Kalshi"]);
    const leftCents = Math.floor((2_000 * 38) / 1000);
    assert.equal(done.unwind.hedgeProceedsCents, soldNet + leftCents, "the venue's net proceeds plus the remainder at the walked worst bid");
    assert.equal(done.unwind.protectedAtCloseCents, pre.unwind.protectedAtCloseCents + (done.unwind.hedgeProceedsCents - pre.unwind.hedgeProceedsCents), "the holder's number moves by exactly what the sale fetched against the quote");
    assert.match(done.hedge.note, /^sold on Kalshi, order ord-sell-1: /);
    assert.match(done.hedge.note, /2 of \d+(\.\d+)? left unsold, carried at the walked 38c for the operator to sell by hand$/);
    const lines = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(lines.length, 2);
    const rec = lines[1] as unknown as ShadowCloseRecord;
    assert.deepEqual([rec.type, rec.priced, rec.source, rec.hedgeSent, rec.protectedAtCloseCents], ["close", true, "unwind", true, done.unwind.protectedAtCloseCents]);
    const [closed] = loadShadowPositions(ledger);
    assert.equal(closed.closeHedgeSent, true);

    // the receipt: the buy and the sale, both from the venue, and the routing as judged at the lock
    const rcpt = (await (await fetch(`${base}/api/shadow/receipt?ticker=${TICKER}`, { headers: key })).json()) as {
      lock: { status: string; closeSource: string; closeHedgeSent: boolean };
      hedge: { action: string; orderId: string; simulated: boolean };
      hedgeSale: { action: string; orderId: string; simulated: boolean; unitsMilli: number };
      routing: { holderVenue: string; hedgeVenue: string; reason: string; tails: Array<{ branch: string }> };
    };
    assert.deepEqual([rcpt.lock.status, rcpt.lock.closeSource, rcpt.lock.closeHedgeSent], ["closed", "unwind", true]);
    assert.deepEqual([rcpt.hedge.action, rcpt.hedge.orderId, rcpt.hedge.simulated], ["buy", "ord-buy-1", false]);
    assert.deepEqual([rcpt.hedgeSale.action, rcpt.hedgeSale.orderId, rcpt.hedgeSale.simulated, rcpt.hedgeSale.unitsMilli], ["sell", "ord-sell-1", false, soldMilli]);
    assert.deepEqual([rcpt.routing.holderVenue, rcpt.routing.hedgeVenue], ["prophetx", "kalshi"]);
    assert.equal(rcpt.routing.reason, lock.routing.reason);
    assert.equal(rcpt.routing.tails.length, 4);
    // the trail holds both orders under the lock's ref
    const receipts = readFileSync(process.env.EVENT_HEDGE_RECEIPTS_PATH!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { intent: { action?: string }; fill: { ids: { orderId: string } } });
    assert.deepEqual(
      receipts.map((r) => [r.intent.action ?? "buy", r.fill.ids.orderId]),
      [
        ["buy", "ord-buy-1"],
        ["sell", "ord-sell-1"],
      ],
    );
  } finally {
    await new Promise<void>((r) => worker.server.close(() => r()));
  }
});
