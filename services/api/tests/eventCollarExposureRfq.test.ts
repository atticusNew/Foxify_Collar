/**
 * The exposure caps on the request-for-quote strategy (EVENT_HEDGE_STRATEGY=rfq). That strategy
 * is not the live executor: the lock is written first and the hedge is then asked for, and with
 * a venue key it can accept a real quote. It has no rails of its own, so the same caps stand in
 * front of it: over a cap, no record and no request; under it, the record as before, and a real
 * fill then counts from the receipt trail. The venue is faked; nothing touches one.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BookHedgeExecutor, costCentsAt, type HedgeIntent } from "../src/eventCollar/crossVenue/hedgeExecutor";
import type { ExposureCaps, ExposureView } from "../src/eventCollar/crossVenue/exposureCaps";
import { loadPending } from "../src/eventCollar/crossVenue/hedgeFirst";
import { quoteLadderWrap, type NoAskLevel } from "../src/eventCollar/crossVenue/kalshiLadder";
import { loadShadowPositions } from "../src/eventCollar/crossVenue/shadowLedger";
import { DEFAULT_CROSS_CONFIG, type CrossQuoteResult } from "../src/eventCollar/crossVenue/types";
import type { CandidateResult, GameMarketRow, OneQuoteInputs, OneQuoteResult } from "../scripts/eventProtectXDemoService";

const BOS = "KXNBAGAME-26OCT14LALBOS-BOS";
const LAL = "KXNBAGAME-26OCT14LALBOS-LAL";
const START = new Date(Date.now() + 3 * 3_600_000).toISOString();
const NO_ASKS: NoAskLevel[] = [
  { priceCents: 41, qtyMilli: 300_000 },
  { priceCents: 42, qtyMilli: 400_000 },
];

function quoteFor(ticker: string, contracts: number): Extract<CrossQuoteResult, { ok: true }> {
  const quote = quoteLadderWrap({ pair: { kalshi: { ticker }, gameStartTime: START }, markCents: 60, entryCents: 58, contracts, now: new Date(), noAsks: NO_ASKS, config: DEFAULT_CROSS_CONFIG });
  assert.ok(quote.ok, JSON.stringify(quote));
  return quote;
}

function candidate(ticker: string, contracts: number, entryCents: number): CandidateResult {
  const quote = quoteFor(ticker, contracts);
  const sideName = ticker === BOS ? "Boston Celtics" : "Los Angeles Lakers";
  return {
    kind: "sports",
    league: "nba",
    market: { ticker, eventTicker: "KXNBAGAME-26OCT14LALBOS", title: "Lakers at Celtics Winner?", subtitle: sideName, strike: 0, strikeType: "", status: "active", openTime: "", closeTime: START, yesBidCents: 59, yesAskCents: 61, lastPriceCents: 60, volume: 1000, openInterest: 1000, rulesPrimary: `${sideName} win` },
    pair: null,
    sideName,
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

test("request-for-quote strategy: a lock that could be hedged with a real quote passes the exposure caps before its record is written", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exposure-rfq-"));
  const ledger = join(dir, "lock-ledger.jsonl");
  process.env.NODE_ENV = "test";
  process.env.EVENT_SHADOW_LEDGER_PATH = join(dir, "ledger.jsonl");
  process.env.EVENT_SHADOW_LOCK_LEDGER_PATH = ledger;
  process.env.EVENT_LASTLEG_LEDGER_PATH = join(dir, "lastleg.jsonl");
  process.env.EVENT_X_ADMIN_TOKEN = "op-secret";
  process.env.EVENT_SHADOW_LOCK_KEY = "lock-key-0123456789";
  process.env.EVENT_HEDGE_STRATEGY = "rfq";
  for (const k of Object.keys(process.env)) if (k.startsWith("EVENT_HEDGE_LIVE_")) delete process.env[k];
  delete process.env.EVENT_HEDGE_KILL_SWITCH;
  // a throwaway key: the strategy then has a Kalshi client that could accept a quote; the executor below stands in for it
  process.env.KALSHI_API_KEY_ID = "test-key-id";
  process.env.KALSHI_PRIVATE_KEY_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const worker = await import("../scripts/eventShadowWorker");

  // the venue, faked: every request is filled for real at the walk's cost
  const placed: HedgeIntent[] = [];
  const engine = {
    listGameMarkets: async (): Promise<GameMarketRow[]> => [],
    quoteOne: async (inputs: OneQuoteInputs): Promise<OneQuoteResult> => ({ ok: true, result: candidate(inputs.ticker, inputs.contracts, inputs.entryCents ?? 58) }),
  };
  worker.wireLockEngine({
    ...engine,
    hedgeExecutor: new BookHedgeExecutor(async (intent) => {
      placed.push(intent);
      return { orderId: `ord-${placed.length}`, avgPriceMilli: intent.book.avgPriceMilli, costCents: intent.book.costCents };
    }),
  });
  const roomy: ExposureCaps = { gameCents: 1_000_000, venueCents: 1_000_000, venueOverrides: {}, holderCents: 1_000_000, notes: [] };
  const setCaps = (caps: Partial<ExposureCaps>): void => worker.wireLockEngine({ ...engine, exposureCaps: { ...roomy, ...caps } });
  await new Promise<void>((r) => worker.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
  const tap = async (ticker: string, contracts = 20) => {
    const res = await fetch(`${base}/api/shadow/lock`, { method: "POST", headers: { "x-lock-key": "lock-key-0123456789", "content-type": "application/json" }, body: JSON.stringify({ ticker, contracts, entryCents: 58 }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> & { hedge?: Record<string, unknown> } };
  };
  const exposure = async () => ((await (await fetch(`${base}/healthz?token=op-secret`)).json()) as { exposure: ExposureView & { refusals: { count: number } } }).exposure;

  const q = quoteFor(BOS, 20);
  assert.ok(q.hedge.venue === "kalshi");
  const reserve = Math.max(q.hedge.costCents, costCentsAt(q.hedge.contractsMilli, q.hedge.worstPriceCents * 10)) + q.feesCents;
  const gameAdd = Math.round(q.floorCents * 20) + q.creditCents + reserve;
  const gameOpen = Math.round(q.floorCents * 20) + q.creditCents + q.hedge.costCents;
  try {
    // one cent over: no record, no request, the refusal on the trail
    setCaps({ gameCents: gameAdd - 1 });
    const over = await tap(BOS);
    assert.equal(over.status, 200);
    assert.equal(over.body.ok, false);
    assert.equal(over.body.code, "exposure_cap");
    assert.match(String(over.body.message), /\$0\.01 over the limit for this game\. Nothing was locked\./);
    assert.equal(loadShadowPositions(ledger).length, 0, "the record is not written first and refused after");
    assert.equal(placed.length, 0);
    const lines = loadPending(join(dir, "lock-pending.jsonl"));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].type, "cap_refused");

    // at the cap: the record, then the hedge, as this strategy always did; the fill is real and counts from the receipt
    setCaps({ gameCents: gameAdd });
    const ok = await tap(BOS);
    assert.equal(ok.body.ok, true, JSON.stringify(ok.body));
    assert.equal(ok.body.hedge?.simulated, false);
    assert.equal(placed.length, 1);
    const [lock] = loadShadowPositions(ledger);
    assert.equal(lock.hedgeFill, undefined, "written before the hedge, so it carries no fill of its own");
    assert.equal(loadPending(join(dir, "lock-pending.jsonl")).length, 1, "no pending line: this strategy is not hedge first");
    const after = await exposure();
    assert.deepEqual(after.counted, { realOpenLocks: 1, simulatedOpenLocksNotCounted: 0, pendingUnresolved: 0, pendingLeftOver: 0 });
    assert.equal(after.games.top[0].openCents, gameOpen);
    assert.deepEqual(after.venues.map((v) => [v.venue, v.openCents]), [["kalshi", q.hedge.costCents]]);

    // the other side of the game: measured on top of it
    setCaps({ gameCents: gameOpen + gameAdd - 1 });
    assert.equal((await tap(LAL)).body.code, "exposure_cap");
    assert.equal(placed.length, 1);
    setCaps({ gameCents: gameOpen + gameAdd });
    assert.equal((await tap(LAL)).body.ok, true);
    assert.equal((await exposure()).refusals.count, 2);
  } finally {
    await new Promise<void>((r) => worker.server.close(() => r()));
  }
});
