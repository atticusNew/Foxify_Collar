/**
 * The lock path: a real holder's tap opens a position at their size through the shadow worker,
 * gated by the lock key, written with source "lock", hedged through the executor (dry run here),
 * answered with the terms and the receipt's outcome. The engine is faked; nothing touches venues.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendHedgeReceipt, type HedgeReceipt } from "../src/eventCollar/crossVenue/hedgeExecutor";
import { quoteLadderWrap, type NoAskLevel } from "../src/eventCollar/crossVenue/kalshiLadder";
import { lockAuthorized, lockKeyFromEnv, parseLockRequest } from "../src/eventCollar/crossVenue/lockGate";
import { appendShadowRecord, loadShadowPositions } from "../src/eventCollar/crossVenue/shadowLedger";
import { DEFAULT_CROSS_CONFIG, type CrossQuoteResult } from "../src/eventCollar/crossVenue/types";
import type { CandidateResult, GameMarketRow, OneQuoteInputs, OneQuoteResult } from "../scripts/eventProtectXDemoService";

test("lock gate: a key under 12 chars is no key; header or query must match exactly; a null key authorizes nothing", () => {
  assert.equal(lockKeyFromEnv({}), null);
  assert.equal(lockKeyFromEnv({ EVENT_SHADOW_LOCK_KEY: "short" }), null);
  assert.equal(lockKeyFromEnv({ EVENT_SHADOW_LOCK_KEY: "  lock-key-0123456789  " }), "lock-key-0123456789");
  const key = "lock-key-0123456789";
  assert.equal(lockAuthorized(key, { "x-lock-key": key }, null), true);
  assert.equal(lockAuthorized(key, {}, key), true);
  assert.equal(lockAuthorized(key, { "x-lock-key": "lock-key-012345678" }, null), false);
  assert.equal(lockAuthorized(key, { "x-lock-key": `${key}x` }, null), false);
  assert.equal(lockAuthorized(key, {}, null), false);
  assert.equal(lockAuthorized(null, { "x-lock-key": "" }, ""), false);
});

test("lock request: ticker upper-cased and shaped; contracts, entry and tier validated by name", () => {
  const ok = parseLockRequest({ ticker: " kxnbagame-26oct14lalbos-bos ", contracts: 20, entryCents: 58, tier: "balanced" });
  assert.deepEqual(ok, { ok: true, value: { ticker: "KXNBAGAME-26OCT14LALBOS-BOS", contracts: 20, entryCents: 58, tier: "balanced" } });
  assert.deepEqual(parseLockRequest({ ticker: "KX-A", contracts: "20" }), { ok: true, value: { ticker: "KX-A", contracts: 20 } });
  for (const [body, re] of [
    [null, /JSON object/],
    [{ ticker: "", contracts: 1 }, /ticker/],
    [{ ticker: "KX-A", contracts: 0 }, /contracts/],
    [{ ticker: "KX-A", contracts: 2.5 }, /contracts/],
    [{ ticker: "KX-A", contracts: 10_001 }, /contracts/],
    [{ ticker: "KX-A", contracts: 1, entryCents: 100 }, /entryCents/],
    [{ ticker: "KX-A", contracts: 1, tier: "loose" }, /tier/],
  ] as Array<[unknown, RegExp]>) {
    const r = parseLockRequest(body);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, re);
  }
});

// ---------------------------------------------------------------------------
// the worker's lock routes with a fake engine
// ---------------------------------------------------------------------------

const TICKER = "KXNBAGAME-26OCT14LALBOS-BOS";
const START = new Date(Date.now() + 3 * 3_600_000).toISOString();
const NO_ASKS: NoAskLevel[] = [
  { priceCents: 41, qtyMilli: 300_000 },
  { priceCents: 42, qtyMilli: 400_000 },
];

function candidate(contracts: number, entryCents: number): CandidateResult {
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
    market: {
      ticker: TICKER,
      eventTicker: "KXNBAGAME-26OCT14LALBOS",
      title: "Lakers at Celtics Winner?",
      subtitle: "Boston Celtics",
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
      rulesPrimary: "Celtics win",
    },
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
  };
}

test("shadow worker lock routes: 404 without a key, 403 with the wrong one; markets, quote and lock answer to the key; the lock writes source=lock and hedges dry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-lock-"));
  const scanLedger = join(dir, "ledger.jsonl");
  const ledger = join(dir, "lock-ledger.jsonl");
  process.env.NODE_ENV = "test";
  process.env.EVENT_SHADOW_LEDGER_PATH = scanLedger;
  process.env.EVENT_SHADOW_LOCK_LEDGER_PATH = ledger;
  // the scan already holds this market as a showcase position; a holder may still lock it
  const scanOpen = candidate(150, 60);
  appendShadowRecord(scanLedger, {
    type: "open",
    at: "2026-10-13T12:00:00.000Z",
    ticker: TICKER,
    kind: "sports",
    league: "nba",
    sideName: "Boston Celtics",
    eventTitle: "Lakers at Celtics Winner?",
    eventTimeIso: START,
    contracts: 150,
    markCents: 60,
    entryCents: 60,
    floorCents: scanOpen.quote.ok ? scanOpen.quote.floorCents : 40,
    capCents: scanOpen.quote.ok ? scanOpen.quote.capCents : 80,
    creditCents: scanOpen.quote.ok ? scanOpen.quote.creditCents : 100,
    takeCents: 7,
    feesCents: 0,
    hedgeCostCents: 0,
    evCostBps: 300,
    route: "kalshi_self",
    tier: "balanced",
  } as Parameters<typeof appendShadowRecord>[1]);
  process.env.EVENT_LASTLEG_LEDGER_PATH = join(dir, "lastleg.jsonl");
  process.env.EVENT_X_ADMIN_TOKEN = "op-secret";
  process.env.EVENT_SHADOW_LOCK_KEY = "lock-key-0123456789";
  process.env.EVENT_HEDGE_STRATEGY = "live";
  process.env.EVENT_HEDGE_LIVE_TICKERS = TICKER;
  delete process.env.EVENT_HEDGE_LIVE_SEND;
  // a throwaway key so the Kalshi client exists; dry run means it signs nothing
  process.env.KALSHI_API_KEY_ID = "test-key-id";
  process.env.KALSHI_PRIVATE_KEY_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const worker = await import("../scripts/eventShadowWorker");
  const seen: OneQuoteInputs[] = [];
  const markets: GameMarketRow[] = [
    { ticker: TICKER, league: "nba", sideName: "Boston Celtics", title: "Lakers at Celtics Winner?", dateIso: "2026-10-14", closeTimeIso: START, markCents: 60 },
    { ticker: "KXNBAGAME-26OCT14LALBOS-LAL", league: "nba", sideName: "Los Angeles Lakers", title: "Lakers at Celtics Winner?", dateIso: "2026-10-14", closeTimeIso: START, markCents: 40 },
  ];
  worker.wireLockEngine({
    listGameMarkets: async (league?: string) => markets.filter((m) => !league || m.league === league),
    quoteOne: async (inputs: OneQuoteInputs): Promise<OneQuoteResult> => {
      seen.push(inputs);
      if (inputs.ticker === "KXNBAGAME-26OCT14LALBOS-LAL") return { ok: false, code: "no_matched_market", detail: "Protection isn't offered on this event yet." };
      return { ok: true, result: candidate(inputs.contracts, inputs.entryCents ?? 60) };
    },
  });
  await new Promise<void>((r) => worker.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
  const key = { "x-lock-key": "lock-key-0123456789" };
  try {
    for (const p of ["/api/shadow/markets", "/api/shadow/quote?ticker=X&contracts=1", "/api/shadow/lock"]) {
      assert.equal((await fetch(`${base}${p}`)).status, 403, `${p} without the key`);
      assert.equal((await fetch(`${base}${p}`, { headers: { "x-lock-key": "lock-key-012345678x" } })).status, 403, `${p} with the wrong key`);
    }
    // healthz (operator) says the lock routes are on and which tickers the scan leaves to the tap
    const health = (await (await fetch(`${base}/healthz?token=op-secret`)).json()) as { lock: { enabled: boolean; reservedTickers: string[]; positions: number } };
    assert.equal(health.lock.enabled, true);
    assert.deepEqual(health.lock.reservedTickers, [TICKER]);
    assert.equal(health.lock.positions, 0);
    assert.ok(!JSON.stringify(await (await fetch(`${base}/healthz`)).json()).includes("lock"), "public healthz says nothing about it");

    // preflight (operator) prices the ticker on the Kalshi route at the given size and, with scan=1,
    // lists every game in the window that route is offered on
    const pre = (await (await fetch(`${base}/api/shadow/hedges/preflight?ticker=${TICKER}&contracts=7&scan=1&token=op-secret`)).json()) as {
      ticker: { allowlisted: boolean; onRecord: boolean; contracts: number; kalshiRoute: { offered: boolean; sideName?: string; creditCents?: number; hedgeUnitsMilli?: number } };
      scan: { contracts: number; checked: number; offered: Array<{ ticker: string; armed: boolean }>; refused: Record<string, number> };
    };
    assert.equal(pre.ticker.allowlisted, true);
    assert.equal(pre.ticker.onRecord, false);
    assert.equal(pre.ticker.contracts, 7);
    assert.equal(pre.ticker.kalshiRoute.offered, true);
    assert.equal(pre.ticker.kalshiRoute.sideName, "Boston Celtics");
    assert.ok(typeof pre.ticker.kalshiRoute.creditCents === "number" && typeof pre.ticker.kalshiRoute.hedgeUnitsMilli === "number");
    assert.ok(seen.every((s) => s.route === "kalshi_self" && s.contracts === 7), "preflight prices on the Kalshi route at the asked size");
    assert.equal(pre.scan.checked, 2);
    assert.deepEqual(pre.scan.offered.map((o) => [o.ticker, o.armed]), [[TICKER, true]]);
    assert.deepEqual(pre.scan.refused, { no_matched_market: 1 });
    seen.length = 0;

    const m = (await (await fetch(`${base}/api/shadow/markets?league=nba`, { headers: key })).json()) as { ok: boolean; markets: Array<Record<string, unknown>> };
    assert.equal(m.ok, true);
    assert.equal(m.markets.length, 2);
    assert.equal(m.markets[0].onRecord, false, "the scan's showcase position does not block a holder's lock");
    assert.equal(m.markets[0].live, true, "the allowlisted ticker is flagged");
    assert.equal(m.markets[1].live, false);

    const bad = await fetch(`${base}/api/shadow/quote?ticker=${TICKER}&contracts=0`, { headers: key });
    assert.equal(bad.status, 400);
    const q = (await (await fetch(`${base}/api/shadow/quote?ticker=${TICKER}&contracts=20&entry=58&lock=lock-key-0123456789`)).json()) as Record<string, unknown> & {
      quote: { ok: boolean; contracts: number; tiers: Record<string, unknown>; floorCents: number };
    };
    assert.equal(q.ok, true);
    assert.equal(q.onRecord, false);
    assert.equal(q.contracts, 20);
    assert.equal(q.entryCents, 58);
    assert.equal(q.quote.ok, true);
    assert.equal(q.quote.contracts, 20);
    assert.deepEqual(Object.keys(q).sort(), ["at", "contracts", "entryCents", "evCostBps", "eventTimeIso", "eventTitle", "kind", "league", "markCents", "ok", "onRecord", "quote", "sideName", "ticker"]);
    assert.ok(!("hedge" in q.quote) && !("takeCents" in q.quote), "retail shape: no hedge leg, no take");
    assert.deepEqual(seen.at(-1), { ticker: TICKER, contracts: 20, entryCents: 58, route: "kalshi_self" }, "an armed ticker is priced on the route the executor can send to");

    const refused = (await (await fetch(`${base}/api/shadow/quote?ticker=KXNBAGAME-26OCT14LALBOS-LAL&contracts=20`, { headers: key })).json()) as Record<string, unknown>;
    assert.equal(refused.ok, false);
    assert.equal(refused.code, "no_matched_market");
    assert.equal(seen.at(-1)?.route, undefined, "a ticker that is not armed keeps the board's cheaper-route rule");

    assert.equal((await fetch(`${base}/api/shadow/lock`, { headers: key })).status, 405, "GET is not a lock");
    const badBody = await fetch(`${base}/api/shadow/lock`, { method: "POST", headers: { ...key, "content-type": "application/json" }, body: "{not json" });
    assert.equal(badBody.status, 400);

    const lockRes = await fetch(`${base}/api/shadow/lock`, {
      method: "POST",
      headers: { ...key, "content-type": "application/json" },
      body: JSON.stringify({ ticker: TICKER.toLowerCase(), contracts: 20, entryCents: 58, tier: "wide" }),
    });
    assert.equal(lockRes.status, 200);
    const lock = (await lockRes.json()) as Record<string, unknown> & { hedge: Record<string, unknown> };
    assert.equal(lock.ok, true);
    assert.equal(lock.ticker, TICKER);
    assert.equal(lock.contracts, 20);
    assert.equal(lock.sideName, "Boston Celtics");
    assert.ok(typeof lock.floorCents === "number" && typeof lock.capCents === "number" && typeof lock.creditCents === "number");
    assert.equal(lock.hedge.outcome, "filled_book");
    assert.equal(lock.hedge.simulated, true);
    assert.equal(lock.hedge.fallbackReason, "dry run", "live mode, allowlisted ticker, dry run: built and held");
    assert.equal(lock.hedge.orderId, null);
    assert.equal(lock.hedge.route, "kalshi_self");
    assert.equal(lock.hedge.venue, "Kalshi", "the holder's receipt names where the other side is bought");
    assert.ok(typeof lock.hedge.at === "string" && typeof lock.hedge.receiptId === "string" && typeof lock.hedge.avgPriceMilli === "number");

    // RECEIPT (lock key): the same terms and the same hedge view, any time after the tap
    assert.equal((await fetch(`${base}/api/shadow/receipt?ticker=${TICKER}`)).status, 403);
    assert.equal((await fetch(`${base}/api/shadow/receipt?ticker=KXNBAGAME-26OCT14LALBOS-LAL`, { headers: key })).status, 404);
    const rcpt = (await (await fetch(`${base}/api/shadow/receipt?ticker=${TICKER.toLowerCase()}`, { headers: key })).json()) as {
      ok: boolean;
      lock: { status: string; contracts: number; floorCents: number; tier: string };
      hedge: { receiptId: string; simulated: boolean; venue: string; unitsMilli: number; costCents: number };
    };
    assert.equal(rcpt.ok, true);
    assert.equal(rcpt.lock.status, "open");
    assert.equal(rcpt.lock.contracts, 20);
    assert.equal(rcpt.lock.floorCents, lock.floorCents);
    assert.equal(rcpt.hedge.receiptId, lock.hedge.receiptId, "the receipt the tap answered with");
    assert.equal(rcpt.hedge.simulated, true);
    assert.equal(rcpt.hedge.venue, "Kalshi");
    assert.ok(rcpt.hedge.unitsMilli > 0 && rcpt.hedge.costCents > 0);

    const positions = loadShadowPositions(ledger);
    assert.equal(positions.length, 1, "the lock lives in its own ledger");
    assert.equal(loadShadowPositions(scanLedger).length, 1, "the scan's ledger is untouched");
    assert.equal(positions[0].ticker, TICKER);
    assert.equal(positions[0].contracts, 20);
    assert.equal(positions[0].source, "lock");
    assert.equal(positions[0].entryCents, 58, "the holder's own cost is on the record");
    assert.equal(positions[0].status, "open");
    const requested = positions[0].tier;
    assert.ok(requested === "wide" || requested === "balanced" || requested === "tight");
    assert.equal(positions[0].floorCents, lock.floorCents);
    assert.equal(positions[0].creditCents, lock.creditCents);
    assert.ok(positions[0].rule, "the venue's rule is pinned like any scan open");
    const raw = readFileSync(ledger, "utf8").trim().split("\n");
    assert.equal(raw.length, 1);
    assert.equal((JSON.parse(raw[0]) as { source: string }).source, "lock");

    // one position per market: the second tap is refused, nothing written
    const again = await fetch(`${base}/api/shadow/lock`, { method: "POST", headers: { ...key, "content-type": "application/json" }, body: JSON.stringify({ ticker: TICKER, contracts: 5 }) });
    assert.equal(again.status, 409);
    assert.equal(((await again.json()) as { error: string }).error, "already_on_record");
    assert.equal(readFileSync(ledger, "utf8").trim().split("\n").length, 1);
    const afterQuote = (await (await fetch(`${base}/api/shadow/quote?ticker=${TICKER}&contracts=20`, { headers: key })).json()) as { onRecord: boolean };
    assert.equal(afterQuote.onRecord, true);
    const afterMarkets = (await (await fetch(`${base}/api/shadow/markets`, { headers: key })).json()) as { markets: Array<{ onRecord: boolean }> };
    assert.equal(afterMarkets.markets[0].onRecord, true);

    // a refused quote at the tap locks nothing
    const refusedLock = (await (await fetch(`${base}/api/shadow/lock`, { method: "POST", headers: { ...key, "content-type": "application/json" }, body: JSON.stringify({ ticker: "KXNBAGAME-26OCT14LALBOS-LAL", contracts: 20 }) })).json()) as Record<string, unknown>;
    assert.equal(refusedLock.ok, false);
    assert.equal(refusedLock.code, "no_matched_market");
    assert.equal(loadShadowPositions(ledger).length, 1);

    // the hedge trail carries the lock's receipt: live rails passed, dry run held it
    const hedges = (await (await fetch(`${base}/api/shadow/hedges?token=op-secret`)).json()) as { summary: { receipts: number; live: { dryRun: number; sent: number } }; recent: Array<{ ref: string }> };
    assert.equal(hedges.summary.receipts, 1);
    assert.equal(hedges.summary.live.dryRun, 1);
    assert.equal(hedges.summary.live.sent, 0);
    assert.equal(hedges.recent[0].ref, TICKER);

    // RESEND (operator): a lock whose hedge did not reach the venue is hedged again at the lock's
    // size and entry on the Kalshi route; the record is untouched, the trail gains one receipt
    const op = { "x-admin-token": "op-secret" };
    seen.length = 0;
    assert.equal((await fetch(`${base}/api/shadow/hedges/resend?ticker=${TICKER}`, { method: "POST" })).status, 403, "operator only");
    assert.equal((await fetch(`${base}/api/shadow/hedges/resend?ticker=${TICKER}`, { headers: op })).status, 405, "GET sends nothing");
    assert.equal((await fetch(`${base}/api/shadow/hedges/resend?ticker=KXNBAGAME-26OCT14LALBOS-LAL`, { method: "POST", headers: op })).status, 404, "no lock, nothing to resend");
    assert.equal(seen.length, 0, "nothing priced before the lock is found");
    const resendRes = await fetch(`${base}/api/shadow/hedges/resend?ticker=${TICKER.toLowerCase()}`, { method: "POST", headers: op });
    assert.equal(resendRes.status, 200);
    const resend = (await resendRes.json()) as {
      ok: boolean;
      ticker: string;
      allowlisted: boolean;
      priorReceipts: number;
      lock: { contracts: number; entryCents: number; floorCents: number; hedgeUnitsMilli: number };
      repriced: { hedgeUnitsMilli: number; tier: string };
      hedge: { outcome: string; simulated: boolean; fallbackReason: string; route: string; receiptId: string; attempts: Array<{ step: string; ok: boolean }> };
    };
    assert.equal(resend.ok, true);
    assert.equal(resend.ticker, TICKER);
    assert.equal(resend.allowlisted, true);
    assert.equal(resend.priorReceipts, 1);
    assert.equal(resend.lock.contracts, 20);
    assert.equal(resend.lock.entryCents, 58);
    assert.equal(resend.lock.floorCents, lock.floorCents);
    assert.deepEqual(seen.at(-1), { ticker: TICKER, contracts: 20, entryCents: 58, route: "kalshi_self" }, "priced as the lock was taken, on the route the executor sends to");
    assert.equal(resend.repriced.tier, requested, "the holder's tier");
    assert.equal(resend.repriced.hedgeUnitsMilli, resend.lock.hedgeUnitsMilli, "same book in the fake: same size");
    assert.equal(resend.hedge.route, "kalshi_self");
    assert.equal(resend.hedge.outcome, "filled_book");
    assert.equal(resend.hedge.simulated, true);
    assert.equal(resend.hedge.fallbackReason, "dry run");
    assert.deepEqual(resend.hedge.attempts.map((a) => [a.step, a.ok]), [["rails", true], ["dry_run", true], ["fill", true]], "rails passed, held dry, simulated at the book");
    assert.equal(readFileSync(ledger, "utf8").trim().split("\n").length, 1, "no record written: the lock's terms stand");
    const trail = (await (await fetch(`${base}/api/shadow/hedges?token=op-secret`)).json()) as { summary: { receipts: number }; recent: Array<HedgeReceipt> };
    assert.equal(trail.summary.receipts, 2);
    assert.deepEqual(trail.recent.map((r) => r.ref), [TICKER, TICKER]);
    assert.equal(trail.recent[0].id, resend.hedge.receiptId);

    // once a live fill is on the trail the resend refuses (the venue holds the hedge) unless forced
    const liveFill: HedgeReceipt = { ...trail.recent[0], id: "live-1", fill: { ...trail.recent[0].fill!, simulated: false, strategy: "live", ids: { orderId: "ord-live" } }, outcome: "filled_live", fallbackReason: null };
    appendHedgeReceipt(join(dir, "hedge-receipts.jsonl"), liveFill);
    const held = await fetch(`${base}/api/shadow/hedges/resend?ticker=${TICKER}`, { method: "POST", headers: op });
    assert.equal(held.status, 409);
    const heldBody = (await held.json()) as { error: string; liveFills: Array<{ orderId: string; receiptId: string }> };
    assert.equal(heldBody.error, "already_live");
    assert.deepEqual(heldBody.liveFills.map((f) => [f.receiptId, f.orderId]), [["live-1", "ord-live"]]);
    const forced = (await (await fetch(`${base}/api/shadow/hedges/resend?ticker=${TICKER}&force=1`, { method: "POST", headers: op })).json()) as { ok: boolean; priorReceipts: number };
    assert.equal(forced.ok, true);
    assert.equal(forced.priorReceipts, 3);
    // the holder's receipt now stands on the live fill, not the later dry run
    const rcptLive = (await (await fetch(`${base}/api/shadow/receipt?ticker=${TICKER}`, { headers: key })).json()) as { hedge: { receiptId: string; simulated: boolean; orderId: string } };
    assert.deepEqual([rcptLive.hedge.receiptId, rcptLive.hedge.simulated, rcptLive.hedge.orderId], ["live-1", false, "ord-live"]);

    // LOCK RESET (operator): the lock's lines move to an archive beside the ledger; the market opens
    // again; the old lock's live fill is named so the operator settles the venue side by hand
    assert.equal((await fetch(`${base}/api/shadow/lock/reset?ticker=${TICKER}`, { method: "POST" })).status, 403, "operator only");
    assert.equal((await fetch(`${base}/api/shadow/lock/reset?ticker=${TICKER}`, { headers: op })).status, 405, "GET resets nothing");
    assert.equal((await fetch(`${base}/api/shadow/lock/reset?ticker=KXNBAGAME-26OCT14LALBOS-LAL`, { method: "POST", headers: op })).status, 404);
    const resetRes = await fetch(`${base}/api/shadow/lock/reset?ticker=${TICKER.toLowerCase()}`, { method: "POST", headers: op });
    assert.equal(resetRes.status, 200);
    const reset = (await resetRes.json()) as { ok: boolean; archived: { to: string; records: number; kept: number }; lock: { contracts: number }; liveFills: Array<{ orderId: string }>; message: string };
    assert.equal(reset.ok, true);
    assert.equal(reset.archived.records, 1);
    assert.equal(reset.archived.kept, 0);
    assert.match(reset.archived.to, /lock-ledger\.\d{4}-\d{2}-\d{2}T\d{6}Z\.KXNBAGAME-26OCT14LALBOS-BOS\.archived\.jsonl$/);
    assert.equal((JSON.parse(readFileSync(reset.archived.to, "utf8").trim()) as { source: string; contracts: number }).contracts, 20, "the old lock is kept, not deleted");
    assert.equal(reset.lock.contracts, 20);
    assert.deepEqual(reset.liveFills.map((f) => f.orderId), ["ord-live"]);
    assert.match(reset.message, /1 live fill\(s\) remain at the venue/);
    assert.equal(loadShadowPositions(ledger).length, 0, "off the record");
    assert.equal(readFileSync(ledger, "utf8"), "");
    assert.equal((await fetch(`${base}/api/shadow/receipt?ticker=${TICKER}`, { headers: key })).status, 404, "no lock, no receipt");
    assert.equal(((await (await fetch(`${base}/api/shadow/quote?ticker=${TICKER}&contracts=20`, { headers: key })).json()) as { onRecord: boolean }).onRecord, false);
    assert.equal((await fetch(`${base}/api/shadow/lock/reset?ticker=${TICKER}`, { method: "POST", headers: op })).status, 404, "nothing left to reset");

    // the market locks again as if for the first time; the new lock's receipt is its own, never the old live fill
    const relock = (await (await fetch(`${base}/api/shadow/lock`, { method: "POST", headers: { ...key, "content-type": "application/json" }, body: JSON.stringify({ ticker: TICKER, contracts: 20, entryCents: 58, tier: "wide" }) })).json()) as { ok: boolean; hedge: { receiptId: string; simulated: boolean } };
    assert.equal(relock.ok, true);
    assert.equal(relock.hedge.simulated, true);
    assert.equal(readFileSync(ledger, "utf8").trim().split("\n").length, 1);
    const rcptNew = (await (await fetch(`${base}/api/shadow/receipt?ticker=${TICKER}`, { headers: key })).json()) as { hedge: { receiptId: string; simulated: boolean; fallbackReason: string } };
    assert.equal(rcptNew.hedge.receiptId, relock.hedge.receiptId);
    assert.equal(rcptNew.hedge.simulated, true);
    assert.equal(rcptNew.hedge.fallbackReason, "dry run");

    // the public record shows both positions on the market: the scan's showcase and the holder's lock
    const pub = (await (await fetch(`${base}/api/shadow`)).json()) as { open: Array<Record<string, unknown>> };
    assert.equal(pub.open.length, 2);
    assert.deepEqual(pub.open.map((p) => [p.ticker, p.contracts]).sort((a, b) => Number(a[1]) - Number(b[1])), [[TICKER, 20], [TICKER, 150]]);
    const health2 = (await (await fetch(`${base}/healthz?token=op-secret`)).json()) as { positions: number; lock: { positions: number } };
    assert.equal(health2.positions, 2);
    assert.equal(health2.lock.positions, 1);
    const exported = await (await fetch(`${base}/api/shadow/export?ledger=lock&token=op-secret`)).text();
    assert.equal(exported.trim().split("\n").length, 1);
    assert.equal((JSON.parse(exported.trim()) as { source: string }).source, "lock");
    assert.ok(!JSON.stringify(pub).includes("novig"));
  } finally {
    await new Promise<void>((r) => worker.server.close(() => r()));
  }
});
