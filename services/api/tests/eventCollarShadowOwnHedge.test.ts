/**
 * The lock guard for the protection's own hedge on Novig (eventShadowWorker.ts, ownHedgeOn): the
 * other side of an open lock held elsewhere and hedged on Novig shows in the holder's Novig
 * Portfolio as a card of theirs (the hedge subaccount sits in their account); a lock on it is refused.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendShadowRecord } from "../src/eventCollar/crossVenue/shadowLedger";

const START = Date.UTC(2026, 9, 18, 17, 0, 0);
const protectable = [
  { ticker: "KXNFLGAME-26OCT25HOUIND-HOU", league: "nfl", sideName: "Houston", title: "Texans at Colts Winner?", dateIso: "2026-10-25" },
  { ticker: "KXNBAGAME-26OCT18HOUSAS-HOU", league: "nba", sideName: "Houston", title: "Rockets at Spurs Winner?", dateIso: "2026-10-18" },
  { ticker: "KXNBAGAME-26OCT18HOUSAS-SAS", league: "nba", sideName: "San Antonio", title: "Rockets at Spurs Winner?", dateIso: "2026-10-18" },
];

test("shadow worker /api/shadow/lock: on Novig, the other side of an open lock held elsewhere and hedged on Novig is the protection's own hedge, refused own_hedge; the same card from another venue, and a lock hedged elsewhere, pass", async () => {
  // its own file: the worker binds its ledger paths on first import, and the open locks written here are this test's alone
  const dir = mkdtempSync(join(tmpdir(), "shadow-own-hedge-"));
  process.env.NODE_ENV = "test";
  process.env.EVENT_SHADOW_LEDGER_PATH = join(dir, "ledger.jsonl");
  const ledger = join(dir, "lock-ledger.jsonl");
  process.env.EVENT_SHADOW_LOCK_LEDGER_PATH = ledger;
  process.env.EVENT_SHADOW_LOCK_KEY = "lock-key-for-positions-test";
  delete process.env.VENUE_API_HOST;
  const worker = await import("../scripts/eventShadowWorker");
  const all = [...protectable, { ticker: "KXNFLGAME-26OCT25HOUIND-IND", league: "nfl", sideName: "Indianapolis", title: "Texans at Colts Winner?", dateIso: "2026-10-25" }];
  const listGameMarkets = async () => all.map((m) => ({ ...m, closeTimeIso: new Date(START).toISOString(), markCents: 57 }));
  const quoteOne = async () => ({ ok: false as const, code: "not_offered" as const, detail: "test" });
  const openLock = (ticker: string, sideName: string, holderVenue: string, chosen: string) =>
    ({
      type: "open",
      at: "2026-10-14T12:00:00.000Z",
      ticker,
      kind: "sports",
      league: "nfl",
      sideName,
      eventTitle: "Winner?",
      eventTimeIso: new Date(START).toISOString(),
      contracts: 20,
      markCents: 57,
      entryCents: 57,
      floorCents: 40,
      capCents: 68,
      creditCents: 60,
      takeCents: 7,
      feesCents: 0,
      hedgeCostCents: 0,
      evCostBps: 300,
      route: chosen,
      tier: "balanced",
      source: "lock",
      holderVenue,
      routing: { holderVenue, league: "nfl", chosen, reason: "test", routes: [], probabilities: { estimate: true }, holderRules: {}, tails: [] },
    }) as unknown as Parameters<typeof appendShadowRecord>[1];
  // a ProphetX holder's Texans (HOU at IND), hedged on Novig: the Colts on Novig are the service's hedge
  appendShadowRecord(ledger, openLock("KXNFLGAME-26OCT25HOUIND-HOU", "Houston", "prophetx", "novig"));
  // a Kalshi holder's Rockets, hedged on Kalshi's own No side: the Spurs on Novig are nobody's hedge
  appendShadowRecord(ledger, openLock("KXNBAGAME-26OCT18HOUSAS-HOU", "Houston", "kalshi", "kalshi_self"));
  worker.wireLockEngine({ quoteOne: quoteOne as never, listGameMarkets: listGameMarkets as never, venueClient: null });
  await new Promise<void>((resolve) => worker.server.listen(0, "127.0.0.1", () => resolve()));
  const port = (worker.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const lock = (ticker: string, venue: string) =>
    fetch(`${base}/api/shadow/lock`, { method: "POST", headers: { "x-lock-key": "lock-key-for-positions-test", "content-type": "application/json" }, body: JSON.stringify({ ticker, contracts: 10, venue }) });
  try {
    let r = await lock("KXNFLGAME-26OCT25HOUIND-IND", "novig");
    assert.equal(r.status, 409);
    let body = (await r.json()) as { ok: boolean; error?: string; code?: string; message?: string; lockTicker?: string };
    assert.deepEqual([body.ok, body.error, body.code, body.lockTicker], [false, "own_hedge", "own_hedge", "KXNFLGAME-26OCT25HOUIND-HOU"]);
    assert.equal(body.message, "This position is the protection's own hedge for your Houston on ProphetX.");
    // the same card read on another venue is a position of theirs there: the guard is Novig's only
    r = await lock("KXNFLGAME-26OCT25HOUIND-IND", "kalshi");
    assert.equal(r.status, 200);
    body = (await r.json()) as typeof body;
    assert.equal(body.code, "not_offered");
    // the Spurs on Novig: the Rockets lock's hedge went to Kalshi, so this is not it
    r = await lock("KXNBAGAME-26OCT18HOUSAS-SAS", "novig");
    assert.equal(r.status, 200);
    body = (await r.json()) as typeof body;
    assert.equal(body.code, "not_offered");
  } finally {
    worker.server.close();
    worker.wireLockEngine({ quoteOne: quoteOne as never, listGameMarkets: listGameMarkets as never, venueClient: null });
  }
});
