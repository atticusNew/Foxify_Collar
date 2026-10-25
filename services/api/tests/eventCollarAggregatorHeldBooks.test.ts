/**
 * Held books (crossVenue/aggregatorHeldBooks.ts): one connection to the aggregator's stream kept
 * open with markets held on it, against a fake partner speaking the documented protocol. The
 * book arithmetic (snapshot, delta, seq gap), the open event (live, and already open at the first
 * snapshot), the per-code cadences (MARKET_NOT_YET_OPEN slow, UNAVAILABLE with backoff, a final
 * refusal), STATUS (RESYNCING, CLOSED), GOODBYE and reconnect with every hold subscribed again,
 * release with UNSUBSCRIBE, the cap, and the source's referenceStreams / heldBooks seams.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket as WsClient } from "ws";
import { applyDelta, heldBooks, type HeldBookOpen } from "../src/eventCollar/crossVenue/aggregatorHeldBooks";
import { aggregatorBookSource, referenceStreamsOf, alignPair } from "../src/eventCollar/crossVenue/aggregatorBooks";
import { signerFromSecret, type Market, type MarketStream, type WsLike } from "../src/eventCollar/crossVenue/aggregatorMarkets";

const keypair = (() => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  return { seedHex: der.subarray(der.length - 32).toString("hex") };
})();
const KEY_ID = "held-books-key";
const signer = signerFromSecret(KEY_ID, keypair.seedHex);

const wsFactory = (url: string): WsLike => {
  const c = new WsClient(url);
  return {
    send: (d) => c.send(d),
    close: (code, reason) => c.close(code, reason),
    addEventListener: ((type: string, listener: (ev: never) => void) => {
      if (type === "message") c.on("message", (data: Buffer) => listener({ data: data.toString("utf8") } as never));
      else if (type === "close") c.on("close", (code: number, reason: Buffer) => listener({ code, reason: reason.toString() } as never));
      else if (type === "error") c.on("error", (err: Error) => listener({ message: err.message } as never));
      else c.on("open", () => listener({} as never));
    }) as WsLike["addEventListener"],
  };
};

interface ServerSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", cb: (raw: Buffer) => void): void;
  terminate(): void;
}

type Frame = Record<string, unknown>;
interface Conn {
  ws: ServerSocket;
  id: string;
  received: Frame[];
  /** subscriptionId by stream key, as this connection acked them */
  subs: Map<string, string>;
}

const sk = (m: MarketStream) => (m.venue === "KALSHI" ? `KALSHI:${m.ticker}` : m.venue === "POLYMARKET" ? `POLYMARKET:${m.tokenId}` : m.venue === "PROPHETX" ? `PROPHETX:${m.strikeId}` : "LIMITLESS");

/**
 * A fake stream: WELCOME on connect, SUBSCRIBED per market, then whatever the `answer` hook
 * decides per market (a frame list, sent in order), UNSUBSCRIBED on UNSUBSCRIBE. Tests drive the
 * rest by hand with `conn.ws.send`.
 */
async function startFake(opts: { ttlSec?: number; answer?: (m: MarketStream, subscriptionId: string, conn: Conn) => Frame[] } = {}) {
  const server: Server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const conns: Conn[] = [];
  let n = 0;
  let subN = 0;
  server.on("upgrade", (req, socket, head) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.searchParams.get("keyId") !== KEY_ID) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: ServerSocket) => wss.emit("connection", ws, req));
  });
  wss.on("connection", (ws: ServerSocket) => {
    n += 1;
    const conn: Conn = { ws, id: `conn-${n}`, received: [], subs: new Map() };
    conns.push(conn);
    const now = Date.now();
    ws.send(JSON.stringify({ type: "WELCOME", v: 1, serverTimestamp: now, connectionId: conn.id, limits: { maxSubscriptionsPerConnection: 200, maxConnections: 20, connectionTtlSeconds: opts.ttlSec ?? 28800 } }));
    ws.on("message", (raw: Buffer) => {
      const f = JSON.parse(raw.toString("utf8")) as Frame & { markets?: MarketStream[]; subscriptionIds?: string[] };
      conn.received.push(f);
      if (f.type === "SUBSCRIBE") {
        for (const m of f.markets ?? []) {
          subN += 1;
          const subscriptionId = `sub-${subN}`;
          conn.subs.set(sk(m), subscriptionId);
          ws.send(JSON.stringify({ type: "SUBSCRIBED", v: 1, serverTimestamp: now, market: m, channel: "BOOK", subscriptionId, snapshotPending: true }));
          for (const fr of opts.answer?.(m, subscriptionId, conn) ?? []) ws.send(JSON.stringify({ v: 1, serverTimestamp: Date.now(), subscriptionId, ...fr }));
        }
      } else if (f.type === "UNSUBSCRIBE") {
        for (const id of f.subscriptionIds ?? []) ws.send(JSON.stringify({ type: "UNSUBSCRIBED", v: 1, serverTimestamp: now, subscriptionId: id }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/orderbook`;
  const stop = () => {
    for (const c of wss.clients) c.terminate();
    wss.close();
    server.closeAllConnections();
    server.close();
  };
  return { url, stop, conns, last: () => conns[conns.length - 1] };
}

const until = async (pred: () => boolean, ms = 2_000, what = "condition"): Promise<void> => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PX_A: MarketStream = { venue: "PROPHETX", strikeId: "aaaa" };
const PX_B: MarketStream = { venue: "PROPHETX", strikeId: "bbbb" };
const PX_C: MarketStream = { venue: "PROPHETX", strikeId: "cccc" };
const EMPTY = { type: "SNAPSHOT", seq: 1, venueTimestamp: 0, bids: [], asks: [], status: "LIVE" };
const LEVELS = { type: "SNAPSHOT", seq: 10, venueTimestamp: Date.now(), bids: [{ price: 0.37, size: 100 }], asks: [{ price: 0.42, size: 150 }], status: "LIVE" };

test("held books: applyDelta sets, replaces and removes levels and keeps both sides best first", () => {
  const book = { bids: [{ price: 0.5, size: 10 }], asks: [{ price: 0.52, size: 5 }] };
  applyDelta(book, [
    { side: "BID", price: 0.51, size: 20 },
    { side: "BID", price: 0.5, size: 0 },
    { side: "ASK", price: 0.52, size: 7 },
    { side: "ASK", price: 0.53, size: 1 },
    { side: "ASK", price: "x", size: 1 },
  ]);
  assert.deepEqual(book, { bids: [{ price: 0.51, size: 20 }], asks: [{ price: 0.52, size: 7 }, { price: 0.53, size: 1 }] });
});

test("held books: an empty snapshot is 'mapped, no book'; the delta that adds the first level is the open, reported once, caught live; a seq gap drops the book until the next snapshot; RESYNCING does the same", async () => {
  const fake = await startFake({ answer: (m) => (sk(m) === sk(PX_A) ? [EMPTY] : []) });
  const opens: HeldBookOpen[] = [];
  const hb = heldBooks(signer, { streamUrl: fake.url, wsFactory, onOpen: (ev) => opens.push(ev) });
  try {
    assert.equal(hb.hold("A", PX_A), "held");
    assert.equal(hb.hold("A", PX_A), "already");
    await until(() => hb.get("A")?.phase === "empty", 2_000, "empty snapshot");
    assert.equal(opens.length, 0);
    const conn = fake.last();
    const sub = conn.subs.get(sk(PX_A))!;
    // a delta that adds a level: the venue opened the line
    conn.ws.send(JSON.stringify({ type: "DELTA", v: 1, serverTimestamp: Date.now(), subscriptionId: sub, seq: 2, venueTimestamp: Date.now(), changes: [{ side: "ASK", price: 0.44, size: 50 }] }));
    await until(() => opens.length === 1, 2_000, "open event");
    assert.equal(opens[0].key, "A");
    assert.equal(opens[0].caught, "live");
    assert.deepEqual(opens[0].book, { bids: [], asks: [{ price: 0.44, size: 50 }] });
    assert.equal(hb.get("A")?.phase, "open");
    assert.equal(hb.get("A")?.seq, 2);
    // more deltas: applied, no second open event
    conn.ws.send(JSON.stringify({ type: "DELTA", v: 1, serverTimestamp: Date.now(), subscriptionId: sub, seq: 3, venueTimestamp: Date.now(), changes: [{ side: "BID", price: 0.40, size: 30 }] }));
    await until(() => hb.get("A")?.seq === 3, 2_000, "seq 3");
    assert.deepEqual(hb.get("A")?.book, { bids: [{ price: 0.4, size: 30 }], asks: [{ price: 0.44, size: 50 }] });
    assert.equal(opens.length, 1);
    // a gap: seq 5 after 3; the book is dropped and the contract's snapshot restores it
    conn.ws.send(JSON.stringify({ type: "DELTA", v: 1, serverTimestamp: Date.now(), subscriptionId: sub, seq: 5, venueTimestamp: Date.now(), changes: [{ side: "BID", price: 0.41, size: 30 }] }));
    await until(() => hb.get("A")?.phase === "pending", 2_000, "gap dropped the book");
    assert.equal(hb.get("A")?.book, null);
    conn.ws.send(JSON.stringify({ ...LEVELS, v: 1, serverTimestamp: Date.now(), subscriptionId: sub, seq: 6 }));
    await until(() => hb.get("A")?.phase === "open", 2_000, "snapshot after the gap");
    assert.equal(hb.get("A")?.seq, 6);
    assert.equal(opens.length, 1, "the open is reported once per hold");
    // RESYNCING: drop, then the snapshot
    conn.ws.send(JSON.stringify({ type: "STATUS", v: 1, serverTimestamp: Date.now(), subscriptionId: sub, state: "RESYNCING", reason: "connectDown" }));
    await until(() => hb.get("A")?.phase === "pending", 2_000, "resyncing");
    conn.ws.send(JSON.stringify({ ...LEVELS, v: 1, serverTimestamp: Date.now(), subscriptionId: sub, seq: 100 }));
    await until(() => hb.get("A")?.phase === "open" && hb.get("A")?.seq === 100, 2_000, "resynced");
    assert.equal(hb.status().opens, 1);
    assert.ok(hb.status().connected);
    assert.equal(hb.status().connectionId, "conn-1");
  } finally {
    hb.close();
    fake.stop();
  }
});

test("held books: levels on the very first snapshot are an open that predates the hold (caught at_hold); CLOSED ends the hold; release sends UNSUBSCRIBE; the cap refuses", async () => {
  const fake = await startFake({ answer: (m) => (sk(m) === sk(PX_A) ? [LEVELS] : [EMPTY]) });
  const opens: HeldBookOpen[] = [];
  const hb = heldBooks(signer, { streamUrl: fake.url, wsFactory, maxHeld: 2, onOpen: (ev) => opens.push(ev) });
  try {
    hb.hold("A", PX_A);
    hb.hold("B", PX_B);
    assert.equal(hb.hold("C", PX_C), "over_cap");
    assert.equal(hb.status().overCap, 1);
    await until(() => opens.length === 1 && hb.get("B")?.phase === "empty", 2_000, "first snapshots");
    assert.equal(opens[0].caught, "at_hold");
    assert.equal(hb.get("A")?.openBeforeHold, true);
    const conn = fake.last();
    // both holds went in ONE subscribe frame
    assert.equal(conn.received.filter((f) => f.type === "SUBSCRIBE").length, 1);
    assert.deepEqual((conn.received[0].markets as MarketStream[]).map(sk).sort(), [sk(PX_A), sk(PX_B)].sort());
    // B settles
    conn.ws.send(JSON.stringify({ type: "STATUS", v: 1, serverTimestamp: Date.now(), subscriptionId: conn.subs.get(sk(PX_B)), state: "CLOSED" }));
    await until(() => hb.get("B")?.phase === "closed", 2_000, "closed");
    // A released: the server is told
    hb.release("A");
    await until(() => conn.received.some((f) => f.type === "UNSUBSCRIBE"), 2_000, "unsubscribe");
    assert.deepEqual(conn.received.find((f) => f.type === "UNSUBSCRIBE")!.subscriptionIds, [conn.subs.get(sk(PX_A))]);
    assert.equal(hb.get("A"), undefined);
    assert.equal(hb.list().length, 1);
    // room again under the cap
    assert.equal(hb.hold("C", PX_C), "held");
  } finally {
    hb.close();
    fake.stop();
  }
});

test("held books: MARKET_NOT_YET_OPEN is asked again on the slow cadence and the book is caught when it then streams; UNAVAILABLE backs off and doubles; UNKNOWN_MARKET is final", async () => {
  let aAnswers = 0;
  let bAnswers = 0;
  const fake = await startFake({
    answer: (m) => {
      if (sk(m) === sk(PX_A)) {
        aAnswers += 1;
        return aAnswers <= 2 ? [{ type: "ERROR", code: "MARKET_NOT_YET_OPEN", message: "books open nearer the start" }] : [EMPTY];
      }
      if (sk(m) === sk(PX_B)) {
        bAnswers += 1;
        return bAnswers <= 3 ? [{ type: "ERROR", code: "UNAVAILABLE", message: "no book for that line right now" }] : [LEVELS];
      }
      return [{ type: "ERROR", code: "UNKNOWN_MARKET", message: "no such strike" }];
    },
  });
  const opens: HeldBookOpen[] = [];
  const hb = heldBooks(signer, { streamUrl: fake.url, wsFactory, notYetOpenRetryMs: 150, unavailableRetryMs: 50, unavailableRetryCapMs: 10_000, onOpen: (ev) => opens.push(ev) });
  try {
    hb.hold("A", PX_A);
    hb.hold("B", PX_B);
    hb.hold("C", PX_C);
    await until(() => hb.get("C")?.phase === "stopped", 2_000, "C stopped");
    assert.equal(hb.get("C")?.lastCode, "UNKNOWN_MARKET");
    await until(() => hb.get("A")?.phase === "not_yet_open", 2_000, "A deferred");
    assert.ok((hb.get("A")?.nextRetryAtMs ?? 0) > Date.now() + 50);
    // A: two refusals 150ms apart, then the empty snapshot (mapped, no book)
    await until(() => hb.get("A")?.phase === "empty", 3_000, "A streams after its window");
    assert.equal(aAnswers, 3);
    // B: 50, 100, 200ms waits then the book
    await until(() => hb.get("B")?.phase === "open", 3_000, "B after backoff");
    assert.equal(bAnswers, 4);
    assert.equal(hb.get("B")?.retries, 3);
    assert.equal(opens.length, 1);
    assert.equal(opens[0].key, "B");
    // each retry was its own single-market SUBSCRIBE (coalesced only when due together)
    const conn = fake.last();
    const subs = conn.received.filter((f) => f.type === "SUBSCRIBE");
    assert.equal((subs[0].markets as MarketStream[]).length, 3, "the first frame carried every hold");
    assert.ok(subs.length >= 5, `retries each went out (${subs.length} frames)`);
    assert.equal(hb.status().byPhase.stopped, 1);
    assert.equal(hb.status().byPhase.empty, 1);
    assert.equal(hb.status().byPhase.open, 1);
  } finally {
    hb.close();
    fake.stop();
  }
});

test("held books: GOODBYE TTL (and the proactive TTL timer) reconnect at once with every live hold subscribed again and its book rebuilt; a plain close reconnects with backoff; AUTH_REVOKED stops for good", async () => {
  const fake = await startFake({ ttlSec: 1, answer: (m) => (sk(m) === sk(PX_A) ? [LEVELS] : [EMPTY]) });
  const opens: HeldBookOpen[] = [];
  const logs: string[] = [];
  // ttlSec 1 with a 500ms margin: the client reconnects itself ~500ms after WELCOME, ahead of the server's deadline
  const hb = heldBooks(signer, { streamUrl: fake.url, wsFactory, ttlMarginMs: 500, reconnectBaseMs: 100, onOpen: (ev) => opens.push(ev), onLog: (l) => logs.push(l) });
  try {
    hb.hold("A", PX_A);
    hb.hold("B", PX_B);
    await until(() => hb.get("A")?.phase === "open" && hb.get("B")?.phase === "empty", 2_000, "first books");
    assert.equal(fake.conns.length, 1);
    // the proactive TTL reconnect
    await until(() => fake.conns.length === 2 && hb.status().connectionId === "conn-2", 3_000, "ttl reconnect");
    await until(() => hb.get("A")?.phase === "open" && hb.get("B")?.phase === "empty", 2_000, "books rebuilt on conn-2");
    assert.equal(opens.length, 1, "a rebuild is not a new open");
    assert.ok(logs.some((l) => /ahead of the connection's TTL/.test(l)));
    // the server's own GOODBYE SHUTDOWN then close: at once
    const c2 = fake.conns[1];
    c2.ws.send(JSON.stringify({ type: "GOODBYE", v: 1, serverTimestamp: Date.now(), reason: "SHUTDOWN" }));
    c2.ws.close(1001, "shutdown");
    await until(() => fake.conns.length === 3 && hb.status().connectionId === "conn-3", 3_000, "shutdown reconnect");
    assert.equal(hb.status().lastGoodbye, "SHUTDOWN");
    await until(() => hb.get("A")?.phase === "open", 2_000, "books on conn-3");
    // a plain close: backoff, then again
    fake.conns[2].ws.terminate();
    await until(() => fake.conns.length === 4, 3_000, "backoff reconnect");
    await until(() => hb.get("B")?.phase === "empty", 2_000, "books on conn-4");
    // the key is revoked: no fifth connection
    const c4 = fake.conns[3];
    c4.ws.send(JSON.stringify({ type: "GOODBYE", v: 1, serverTimestamp: Date.now(), reason: "AUTH_REVOKED" }));
    c4.ws.close(1008, "revoked");
    await until(() => hb.status().stopped === "AUTH_REVOKED" && !hb.status().connected, 2_000, "stopped");
    await sleep(600);
    assert.equal(fake.conns.length, 4);
    assert.equal(hb.hold("C", PX_C), "stopped");
    assert.ok(hb.status().connects >= 4);
  } finally {
    hb.close();
    fake.stop();
  }
});

test("held books: a partner that refuses the handshake is retried with backoff and never throws; with nothing held there is no connection", async () => {
  const fake = await startFake();
  const wrong = signerFromSecret("not-our-key", keypair.seedHex);
  const hb = heldBooks(wrong, { streamUrl: fake.url, wsFactory, reconnectBaseMs: 50, reconnectCapMs: 200 });
  try {
    assert.equal(hb.status().connected, false);
    hb.hold("A", PX_A);
    await sleep(700);
    assert.equal(hb.status().connected, false);
    assert.ok(hb.status().lastError, "the refusal is recorded");
    assert.equal(fake.conns.length, 0, "never accepted");
    assert.equal(hb.get("A")?.phase, "pending");
  } finally {
    hb.close();
    fake.stop();
  }
});

// ---------------------------------------------------------------------------
// the source's seams
// ---------------------------------------------------------------------------

const TICKER = "KXNFLGAME-26OCT18TENIND-IND";
const MARKET: Market = {
  id: "mkt_tenind",
  title: "Titans @ Colts",
  outcomes: [
    {
      name: "Colts",
      listings: [
        { venue: "KALSHI", ticker: TICKER, side: "YES", bookSide: "BID", executable: true },
        { venue: "PROPHETX", strikeId: "colts-strike", executable: true },
      ],
    },
    {
      name: "Titans",
      listings: [
        { venue: "KALSHI", ticker: TICKER, side: "NO", bookSide: "ASK", executable: true },
        { venue: "PROPHETX", strikeId: "titans-strike", executable: true },
        { venue: "POLYMARKET", tokenId: "777", executable: false },
        { venue: "LIMITLESS", kind: "CLOB", marketId: "x", outcomeId: "y", executable: false },
      ],
    },
  ],
};

test("held books: referenceStreamsOf names the opposing outcome's reference venues only; the source's referenceStreams answers from the cached lookup and heldBooks opens on the source's key", async () => {
  const aligned = alignPair([MARKET], TICKER)!;
  assert.deepEqual(referenceStreamsOf(aligned), [{ id: "aggregated_mm", stream: { venue: "PROPHETX", strikeId: "titans-strike" } }]);

  // a REST fake answering the lookup, plus the stream fake
  const stream = await startFake({ answer: () => [EMPTY] });
  let lookups = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const u = new URL(String(input));
    if (u.pathname === "/v1/time") return new Response(JSON.stringify({ time: Math.floor(Date.now() / 1000) }), { status: 200 });
    if (u.pathname === "/v1/markets") {
      lookups += 1;
      return new Response(JSON.stringify({ markets: u.searchParams.get("ticker") === TICKER ? [MARKET] : [] }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
  const src = aggregatorBookSource(signer, "http://fake", { fetchImpl, streamUrl: stream.url, wsFactory });
  let hb: ReturnType<typeof src.heldBooks> | null = null;
  try {
    assert.deepEqual(await src.referenceStreams(TICKER), [{ id: "aggregated_mm", stream: { venue: "PROPHETX", strikeId: "titans-strike" } }]);
    await src.referenceStreams(TICKER);
    assert.equal(lookups, 1, "the second ask is served from the cached lookup");
    assert.equal(await src.referenceStreams("KX-UNKNOWN"), null);
    hb = src.heldBooks({});
    hb.hold(`${TICKER}|aggregated_mm`, { venue: "PROPHETX", strikeId: "titans-strike" });
    await until(() => hb!.get(`${TICKER}|aggregated_mm`)?.phase === "empty", 2_000, "held through the source");
    assert.equal(stream.conns.length, 1);
  } finally {
    hb?.close();
    stream.stop();
  }
});
