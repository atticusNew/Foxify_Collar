/**
 * The board scan never sends an order, whatever the live rails arm. With EVENT_HEDGE_LIVE_TICKERS=*
 * every market the service lists is armed for a holder's tap; the hourly scan's paper positions
 * go through the same hedge path, and before this guard they would have reached the venue through
 * the pod, 25 contracts a time to the daily cap. Here: live strategy, `*`, sending on, a fake pod
 * hook that records every order. A scan tick opens a position and its receipt is a paper fill
 * that names the scan; a holder's tap on the same rails is sent. The engine is faked.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHedgeReceipts, type HedgeIntent } from "../src/eventCollar/crossVenue/hedgeExecutor";
import { quoteLadderWrap, type NoAskLevel } from "../src/eventCollar/crossVenue/kalshiLadder";
import { LiveHedgeExecutor, type LiveOrderHook } from "../src/eventCollar/crossVenue/liveHedge";
import { loadShadowPositions } from "../src/eventCollar/crossVenue/shadowLedger";
import { DEFAULT_CROSS_CONFIG, type CrossQuoteResult } from "../src/eventCollar/crossVenue/types";
import type { CandidateResult, GameMarketRow, OneQuoteInputs, OneQuoteResult, ScanState } from "../scripts/eventProtectXDemoService";

const SCAN_TICKER = "KXNBAGAME-26OCT14LALBOS-BOS";
const TAP_TICKER = "KXNBAGAME-26OCT14NYKDET-NYK";
const START = new Date(Date.now() + 3 * 3_600_000).toISOString();
const NO_ASKS: NoAskLevel[] = [
  { priceCents: 41, qtyMilli: 300_000 },
  { priceCents: 42, qtyMilli: 400_000 },
];

function candidate(ticker: string, contracts: number, entryCents: number): CandidateResult {
  const quote: CrossQuoteResult = quoteLadderWrap({ pair: { kalshi: { ticker }, gameStartTime: START }, markCents: 60, entryCents, contracts, now: new Date(), noAsks: NO_ASKS, config: DEFAULT_CROSS_CONFIG });
  assert.ok(quote.ok, JSON.stringify(quote));
  return {
    kind: "sports",
    league: "nba",
    market: { ticker, eventTicker: ticker.slice(0, ticker.lastIndexOf("-")), title: "Winner?", subtitle: "", strike: 0, strikeType: "", status: "active", openTime: "", closeTime: START, yesBidCents: 59, yesAskCents: 61, lastPriceCents: 60, volume: 1000, openInterest: 1000, rulesPrimary: "" },
    pair: null,
    sideName: "Home",
    eventTitle: "Winner?",
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

test("shadow worker scan under EVENT_HEDGE_LIVE_TICKERS=*: the board's positions are paper (no order leaves, the receipt says so); a holder's tap on the same rails is sent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-scan-paper-"));
  const scanLedger = join(dir, "ledger.jsonl");
  const receipts = join(dir, "hedge-receipts.jsonl");
  process.env.NODE_ENV = "test";
  process.env.EVENT_SHADOW_LEDGER_PATH = scanLedger;
  process.env.EVENT_SHADOW_LOCK_LEDGER_PATH = join(dir, "lock-ledger.jsonl");
  process.env.EVENT_LASTLEG_LEDGER_PATH = join(dir, "lastleg.jsonl");
  process.env.EVENT_HEDGE_RECEIPTS_PATH = receipts;
  process.env.EVENT_X_ADMIN_TOKEN = "op-secret";
  process.env.EVENT_SHADOW_LOCK_KEY = "lock-key-0123456789";
  process.env.EVENT_HEDGE_VENUES = "kalshi";
  process.env.EVENT_HEDGE_STRATEGY = "live";
  process.env.EVENT_HEDGE_LIVE_VIA = "aggregator";
  process.env.EVENT_HEDGE_LIVE_TICKERS = "*";
  process.env.EVENT_HEDGE_LIVE_SEND = "yes";
  process.env.AGGREGATOR_TRADE_KEY_ID = "7a1d2c3b-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
  process.env.AGGREGATOR_TRADE_PRIVATE_KEY_HEX = "11".repeat(32);
  delete process.env.KALSHI_API_KEY_ID;
  delete process.env.KALSHI_PRIVATE_KEY_PEM;
  const worker = await import("../scripts/eventShadowWorker");

  const orders: HedgeIntent[] = [];
  const podHook: LiveOrderHook = async (intent) => {
    orders.push(intent);
    return { orderId: `pod-${orders.length}`, venueOrderId: `v-${orders.length}`, unitsMilli: intent.unitsMilli, avgPriceMilli: intent.book.worstPriceMilli, costCents: Math.ceil((intent.unitsMilli * intent.book.worstPriceMilli) / 10_000), feesCents: 0, status: "executed", via: "aggregator" };
  };
  const markets: GameMarketRow[] = [
    { ticker: SCAN_TICKER, league: "nba", sideName: "Boston Celtics", title: "Winner?", dateIso: "2026-10-14", closeTimeIso: START, markCents: 60, startIso: START, protectable: true, protectableUntilIso: START },
    { ticker: TAP_TICKER, league: "nba", sideName: "New York Knicks", title: "Winner?", dateIso: "2026-10-14", closeTimeIso: START, markCents: 60, startIso: START, protectable: true, protectableUntilIso: START },
  ];
  let scanned: ReadonlySet<string> | undefined;
  worker.wireLockEngine({
    listGameMarkets: async () => markets,
    quoteOne: async (inputs: OneQuoteInputs): Promise<OneQuoteResult> => ({ ok: true, result: candidate(inputs.ticker, inputs.contracts, inputs.entryCents ?? 60) }),
    // the board: one quotable row, a 150-contract showcase position on the scan's ticker
    scan: async (opts): Promise<ScanState> => {
      scanned = opts?.skipTickers;
      const res = candidate(SCAN_TICKER, 150, 60);
      return { atIso: new Date().toISOString(), rows: [{ res, evBps: res.evBps }], fallback: null, fetchFailures: 0 };
    },
    hedgeExecutor: new LiveHedgeExecutor({ kalshi: podHook }, { killSwitch: false, dryRun: false, allowlist: [], anyTicker: true, maxUnitsPerOrderMilli: 250_000, maxUnitsPerDayMilli: 1_000_000 }, () => 0),
  });
  await new Promise<void>((r) => worker.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
  try {
    // the rails as the env built them: any ticker armed, nothing reserved from the scan
    const health = (await (await fetch(`${base}/healthz?token=op-secret`)).json()) as { hedge: { live: { anyTicker: boolean; venues: string[] } }; lock: { reservedTickers: string[]; anyTicker: boolean } };
    assert.deepEqual([health.hedge.live.anyTicker, health.hedge.live.venues, health.lock.reservedTickers, health.lock.anyTicker], [true, ["kalshi", "prophetx"], [], true]);

    // the scan opens its position; the hedge is paper, the pod hook never called
    await worker.scanTick();
    assert.ok(scanned instanceof Set, "the scan ran");
    const board = loadShadowPositions(scanLedger);
    assert.deepEqual(board.map((p) => [p.ticker, p.source ?? "scan", p.status]), [[SCAN_TICKER, "scan", "open"]]);
    assert.equal(orders.length, 0, "no order left for a board row");
    const [scanReceipt] = loadHedgeReceipts(receipts);
    assert.ok(scanReceipt, "the scan's hedge still has a receipt");
    assert.deepEqual([scanReceipt.ref, scanReceipt.outcome, scanReceipt.fill?.simulated, scanReceipt.fill?.strategy], [SCAN_TICKER, "filled_book", true, "book"]);
    assert.match(scanReceipt.fallbackReason ?? "", /^scan: the board's positions are paper/);
    assert.deepEqual(scanReceipt.attempts.map((a) => a.step), ["fill"], "no rails step: the live executor was never asked");

    // the trail's summary files it under its own reason, apart from the rails' refusals
    const hedges = (await (await fetch(`${base}/api/shadow/hedges?token=op-secret`)).json()) as { summary: { receipts: number; simulated: number; fallbackReasons: Record<string, number>; live: { sent: number; refused: number } } };
    assert.deepEqual([hedges.summary.receipts, hedges.summary.simulated, hedges.summary.fallbackReasons, hedges.summary.live.sent, hedges.summary.live.refused], [1, 1, { scan: 1 }, 0, 0]);

    // a holder's tap on another game, same rails: armed by `*`, sent through the pod
    const lock = (await (await fetch(`${base}/api/shadow/lock`, { method: "POST", headers: { "x-lock-key": "lock-key-0123456789", "content-type": "application/json" }, body: JSON.stringify({ ticker: TAP_TICKER, contracts: 20, entryCents: 60 }) })).json()) as { ok: boolean; hedge: { simulated: boolean; orderId: string; via: string } };
    assert.ok(lock.ok, JSON.stringify(lock));
    assert.deepEqual([lock.hedge.simulated, lock.hedge.orderId, lock.hedge.via], [false, "pod-1", "aggregator"]);
    assert.deepEqual(orders.map((o) => [o.instrument, o.outcome]), [[TAP_TICKER, "No"]]);
    const after = (await (await fetch(`${base}/api/shadow/hedges?token=op-secret`)).json()) as { summary: { receipts: number; live: { sent: number } } };
    assert.deepEqual([after.summary.receipts, after.summary.live.sent], [2, 1]);

    // a second scan tick steps over what the board and the record already hold; nothing new, nothing sent
    await worker.scanTick();
    assert.ok(scanned?.has(SCAN_TICKER) && scanned?.has(TAP_TICKER), "the board's row and the holder's lock are both stepped over");
    assert.equal(orders.length, 1);
    assert.equal(loadHedgeReceipts(receipts).length, 2);
  } finally {
    await new Promise<void>((r) => worker.server.close(() => r()));
  }
});
