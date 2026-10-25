/**
 * The aggregator's feed as the first source of the books a sports quote is priced from
 * (crossVenue/aggregatorBooks.ts): the arithmetic from stream levels to the pricers' shapes, the
 * alignment of our ticker to the opposing outcome on every venue, and one read end to end against
 * a fake partner (signed REST lookup + signed stream) covering the happy path, a mapping that
 * disagrees with ours (direct read used, never the aggregator's book), a stale snapshot, a partner
 * that is down, and the env gate.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createPrivateKey, generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket as WsClient } from "ws";
import {
  MAPPED_NO_BOOK,
  MAX_SNAPSHOT_AGE_MS,
  NOT_MAPPED,
  aggregatorBookSource,
  aggregatorBookSourceFromEnv,
  alignPair,
  noAsksFromSnapshot,
  pmBookFromSnapshot,
  snapshotFresh,
} from "../src/eventCollar/crossVenue/aggregatorBooks";
import { EMPTY_SHA256, signerFromSecret, sortedQuery, type Market, type MarketStream, type WsLike } from "../src/eventCollar/crossVenue/aggregatorMarkets";
import type { MatchedPair } from "../src/eventCollar/crossVenue/types";

const keypair = (() => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  return { publicKey, seedHex: der.subarray(der.length - 32).toString("hex") };
})();
const KEY_ID = "c0ffee00-1111-4222-8333-444455556666";
const verifies = (canonical: string, sigHex: string) => cryptoVerify(null, Buffer.from(canonical, "utf8"), keypair.publicKey, Buffer.from(sigHex, "hex"));

const TICKER = "KXNFLGAME-26OCT18TENIND-IND";
const PM_TITANS = "7777777777777777777777777777777777777777777777777777777777777777777777777777";
const PM_COLTS = "1888007975022782998388403485115474386302094698277990526159547283548454167529";
const PX_TITANS = "f1542026d62d185858836622ee2285f3";

const MARKET: Market = {
  id: "mkt_tenind",
  title: "Titans @ Colts",
  outcomes: [
    {
      name: "Colts",
      listings: [
        { venue: "KALSHI", ticker: TICKER, side: "YES", bookSide: "BID", executable: true },
        { venue: "PROPHETX", strikeId: "ab39fb9a7b4eb6a26d7e26f885c601c1", executable: true },
        { venue: "POLYMARKET", tokenId: PM_COLTS, executable: false },
      ],
    },
    {
      name: "Titans",
      listings: [
        { venue: "KALSHI", ticker: TICKER, side: "NO", bookSide: "ASK", executable: true },
        { venue: "PROPHETX", strikeId: PX_TITANS, executable: true },
        { venue: "POLYMARKET", tokenId: PM_TITANS, executable: false },
      ],
    },
  ],
};

const pairWith = (noTokenId: string): MatchedPair => ({
  league: "nfl",
  kalshi: { ticker: TICKER } as MatchedPair["kalshi"],
  pm: { eventSlug: "nfl-ten-ind-2026-10-18", eventTitle: "Titans @ Colts", outcomes: ["Colts", "Titans"], tokenIds: [PM_COLTS, noTokenId] } as MatchedPair["pm"],
  pmYesOutcomeIndex: 0,
  pmNoOutcomeIndex: 1,
  gameStartTime: "2026-10-18T17:00:00Z",
  parityNote: "",
  fingerprint: "nfl:ten:ind:2026-10-18",
});

// ---------------------------------------------------------------------------
// arithmetic
// ---------------------------------------------------------------------------

test("aggregator books: stream levels become the pricer's milli units, best ask first; sizes truncate down, prices off the open interval are dropped", () => {
  const book = pmBookFromSnapshot("tok", {
    bids: [{ price: 0.52, size: 1250 }, { price: 0.51, size: 900.9 }],
    asks: [{ price: 0.54, size: 1500 }, { price: 0.53, size: 800 }, { price: 1, size: 5 }, { price: 0.6, size: 0 }],
  });
  assert.equal(book.tokenId, "tok");
  assert.deepEqual(book.asks, [{ priceMilli: 530, sizeMilli: 800_000 }, { priceMilli: 540, sizeMilli: 1_500_000 }]);
  assert.deepEqual(book.bids, [{ priceMilli: 520, sizeMilli: 1_250_000 }, { priceMilli: 510, sizeMilli: 900_900 }]);
  assert.equal(book.minOrderSizeShares, 5);
});

test("aggregator books: the No side of our market comes from the YES bids (100 minus the bid, the bid's size), cheapest first", () => {
  const asks = noAsksFromSnapshot({ bids: [{ price: 0.52, size: 1250 }, { price: 0.51, size: 900 }], asks: [{ price: 0.53, size: 800 }] });
  assert.deepEqual(asks, [{ priceCents: 48, qtyMilli: 1_250_000 }, { priceCents: 49, qtyMilli: 900_000 }]);
});

test("aggregator books: a snapshot is fresh within the bound in seconds or milliseconds, and unstamped snapshots are taken as of the read", () => {
  const now = 1_760_000_000_000;
  const base = { bids: [], asks: [], seq: 1 };
  assert.ok(snapshotFresh({ ...base, serverTimestamp: now, venueTimestamp: now - 10_000 }, now));
  assert.ok(snapshotFresh({ ...base, serverTimestamp: 0, venueTimestamp: Math.floor((now - 10_000) / 1000) }, now), "seconds");
  assert.ok(!snapshotFresh({ ...base, serverTimestamp: now, venueTimestamp: now - MAX_SNAPSHOT_AGE_MS - 1 }, now));
  assert.ok(snapshotFresh({ ...base, serverTimestamp: now - MAX_SNAPSHOT_AGE_MS - 1, venueTimestamp: now }, now), "the venue stamp is the one that counts");
  assert.ok(snapshotFresh({ ...base, serverTimestamp: 0, venueTimestamp: 0 }, now));
});

test("aggregator books: alignment finds the other outcome of our ticker's two-outcome market on every venue; a three-way market or an unknown ticker aligns nothing", () => {
  const a = alignPair([MARKET], TICKER);
  assert.ok(a);
  assert.equal(a.title, "Titans @ Colts");
  assert.deepEqual(a.ours.map((l) => l.venue), ["KALSHI", "PROPHETX", "POLYMARKET"]);
  assert.deepEqual(a.opposing.map((l) => l.venue), ["KALSHI", "PROPHETX", "POLYMARKET"]);
  assert.equal((a.opposing[2] as { tokenId: string }).tokenId, PM_TITANS);
  assert.equal(alignPair([MARKET], "KXNFLGAME-26OCT18TENIND-TEN"), null, "the No side's ticker is not our YES side");
  const threeWay: Market = { ...MARKET, id: "mkt_3way", outcomes: [...MARKET.outcomes, { name: "Draw", listings: [] }] };
  assert.equal(alignPair([threeWay], TICKER), null);
});

// ---------------------------------------------------------------------------
// a fake partner: signed REST lookup and signed stream
// ---------------------------------------------------------------------------

interface Fake {
  rest: Server;
  stop: () => void;
  host: string;
  streamUrl: string;
  restCalls: string[];
  subscribed: MarketStream[][];
  /** per stream key: a book, "stale", "error" or "silent" */
  books: Map<string, "stale" | "error" | "silent" | { bids: { price: number; size: number }[]; asks: { price: number; size: number }[] }>;
  down: boolean;
  /** what the lookup answers for our ticker; MARKET unless a test narrows the mapping */
  market: Market;
}

interface ServerSocket {
  send(data: string): void;
  on(event: "message", cb: (raw: Buffer) => void): void;
  terminate(): void;
}

const streamKeyOf = (m: MarketStream) => (m.venue === "KALSHI" ? `KALSHI:${m.ticker}` : m.venue === "POLYMARKET" ? `POLYMARKET:${m.tokenId}` : m.venue === "PROPHETX" ? `PROPHETX:${m.strikeId}` : "LIMITLESS");

async function startFake(): Promise<Fake> {
  const fake = { restCalls: [], subscribed: [], books: new Map(), down: false, market: MARKET } as unknown as Fake;
  const rest = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    fake.restCalls.push(u.pathname + u.search);
    if (fake.down) return send(503, { error: { code: "UNAVAILABLE", message: "maintenance" } });
    const ts = req.headers["px-timestamp"];
    const sig = String(req.headers["px-signature"] ?? "");
    const isTime = u.pathname === "/v1/time";
    const canonical = [req.method ?? "GET", u.pathname, sortedQuery(u.search.slice(1)), isTime ? "" : String(ts), EMPTY_SHA256].join("\n");
    if (req.headers["px-key-id"] !== KEY_ID || !verifies(canonical, sig)) return send(401, { error: { code: "UNAUTHORIZED", message: "signature" } });
    if (isTime) return send(200, { time: Math.floor(Date.now() / 1000) });
    if (u.pathname === "/v1/markets") return send(200, { markets: u.searchParams.get("ticker") === TICKER ? [fake.market] : [] });
    send(404, { error: { code: "NOT_FOUND", message: u.pathname } });
  });
  const wss = new WebSocketServer({ noServer: true });
  rest.on("upgrade", (req, socket, head) => {
    const u = new URL(req.url ?? "/", "http://x");
    const ts = u.searchParams.get("timestamp") ?? "";
    const ok = u.searchParams.get("keyId") === KEY_ID && verifies(["WS", u.pathname, "", ts, EMPTY_SHA256].join("\n"), u.searchParams.get("signature") ?? "");
    if (!ok || fake.down) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: ServerSocket) => wss.emit("connection", ws, req));
  });
  wss.on("connection", (ws: ServerSocket) => {
    const now = Date.now();
    ws.send(JSON.stringify({ type: "WELCOME", v: 1, serverTimestamp: now }));
    ws.on("message", (raw: Buffer) => {
      const f = JSON.parse(raw.toString("utf8")) as { type: string; markets?: MarketStream[] };
      if (f.type !== "SUBSCRIBE") return;
      fake.subscribed.push(f.markets ?? []);
      let n = 0;
      for (const m of f.markets ?? []) {
        n += 1;
        const subscriptionId = `sub-${n}`;
        ws.send(JSON.stringify({ type: "SUBSCRIBED", v: 1, serverTimestamp: now, market: m, subscriptionId }));
        const spec = fake.books.get(streamKeyOf(m));
        if (spec === undefined || spec === "silent") continue;
        if (spec === "error") {
          ws.send(JSON.stringify({ type: "ERROR", v: 1, serverTimestamp: now, subscriptionId, code: "MARKET_NOT_YET_OPEN", message: "books open nearer the start" }));
          continue;
        }
        const venueTimestamp = spec === "stale" ? now - MAX_SNAPSHOT_AGE_MS - 5_000 : now - 2_000;
        const book = spec === "stale" ? { bids: [{ price: 0.5, size: 10 }], asks: [{ price: 0.51, size: 10 }] } : spec;
        ws.send(JSON.stringify({ type: "SNAPSHOT", v: 1, serverTimestamp: now, subscriptionId, seq: 1, venueTimestamp, ...book, status: "LIVE" }));
      }
    });
  });
  await new Promise<void>((r) => rest.listen(0, "127.0.0.1", () => r()));
  const port = (rest.address() as AddressInfo).port;
  fake.rest = rest;
  fake.host = `http://127.0.0.1:${port}`;
  fake.streamUrl = `ws://127.0.0.1:${port}/v1/orderbook`;
  fake.stop = () => {
    for (const c of wss.clients) c.terminate();
    wss.close();
    rest.closeAllConnections();
    rest.close();
  };
  return fake;
}

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

const KALSHI_BOOK = { bids: [{ price: 0.6, size: 500 }, { price: 0.59, size: 300 }], asks: [{ price: 0.62, size: 400 }] };
const PM_BOOK = { bids: [{ price: 0.38, size: 2000 }], asks: [{ price: 0.4, size: 1200 }, { price: 0.41, size: 3000 }] };
const PX_BOOK = { bids: [{ price: 0.37, size: 100 }], asks: [{ price: 0.42, size: 150 }] };

test("aggregator books: one read supplies the second venue's No book, our market's No side and the third venue as a reference; the lookup is cached and every call was signed", async () => {
  const fake = await startFake();
  try {
    fake.books.set(`KALSHI:${TICKER}`, KALSHI_BOOK);
    fake.books.set(`POLYMARKET:${PM_TITANS}`, PM_BOOK);
    fake.books.set(`PROPHETX:${PX_TITANS}`, PX_BOOK);
    const src = aggregatorBookSource(signerFromSecret(KEY_ID, keypair.seedHex), fake.host, { streamUrl: fake.streamUrl, wsFactory, streamTimeoutMs: 2_000 });
    const now = new Date();
    const r = await src.read(pairWith(PM_TITANS), now);

    assert.deepEqual(r.notes, []);
    assert.ok(r.pmNoBook);
    assert.equal(r.pmNoBook.tokenId, PM_TITANS, "the hedge instrument is the opposing outcome's token");
    assert.deepEqual(r.pmNoBook.asks, [{ priceMilli: 400, sizeMilli: 1_200_000 }, { priceMilli: 410, sizeMilli: 3_000_000 }]);
    assert.deepEqual(r.noAsks, [{ priceCents: 40, qtyMilli: 500_000 }, { priceCents: 41, qtyMilli: 300_000 }], "No at 100 minus each YES bid");
    assert.equal(r.references.length, 1);
    assert.equal(r.references[0].id, "aggregated_mm");
    assert.ok(r.references[0].book);
    assert.deepEqual(r.references[0].book.asks, [{ priceMilli: 420, sizeMilli: 150_000 }]);
    assert.ok(r.references[0].ageSec !== undefined && r.references[0].ageSec >= 2 && r.references[0].ageSec <= 5, `the snapshot's age rides on the reference: ${r.references[0].ageSec}`);
    assert.deepEqual(fake.subscribed[0].map((m) => m.venue), ["KALSHI", "POLYMARKET", "PROPHETX"]);

    // the mapping holds: a second read on the same ticker streams again but looks nothing up
    const callsAfterFirst = fake.restCalls.length;
    assert.deepEqual(fake.restCalls.map((c) => c.split("?")[0]), ["/v1/time", "/v1/markets"]);
    await src.read(pairWith(PM_TITANS), new Date());
    assert.equal(fake.restCalls.length, callsAfterFirst);
    assert.equal(fake.subscribed.length, 2);

    const st = src.status();
    assert.equal(st.configured, true);
    assert.equal(st.reads, 2);
    assert.equal(st.readsWithBooks, 2);
    assert.equal(st.mappingMismatches, 0);
    assert.equal(st.lastError, null);
  } finally {
    fake.stop();
  }
});

test("aggregator books: a second-venue token that differs from the pair's is never priced from; the mismatch is noted and counted while our own No side still comes through", async () => {
  const fake = await startFake();
  try {
    fake.books.set(`KALSHI:${TICKER}`, KALSHI_BOOK);
    fake.books.set(`POLYMARKET:${PM_TITANS}`, PM_BOOK);
    const src = aggregatorBookSource(signerFromSecret(KEY_ID, keypair.seedHex), fake.host, { streamUrl: fake.streamUrl, wsFactory, streamTimeoutMs: 2_000 });
    const r = await src.read(pairWith("999999"), new Date());
    assert.equal(r.pmNoBook, undefined);
    assert.ok(r.noAsks && r.noAsks.length === 2);
    assert.ok(r.notes.some((n) => /differs from the pair/.test(n)), r.notes.join(" | "));
    assert.ok(!fake.subscribed[0].some((m) => m.venue === "POLYMARKET"), "the mismatched token is not even streamed");
    assert.equal(src.status().mappingMismatches, 1);
  } finally {
    fake.stop();
  }
});

test("aggregator books: a stale snapshot, a book that errors and a silent one each leave that book out with a note; the others still price", async () => {
  const fake = await startFake();
  try {
    fake.books.set(`KALSHI:${TICKER}`, "stale");
    fake.books.set(`POLYMARKET:${PM_TITANS}`, PM_BOOK);
    fake.books.set(`PROPHETX:${PX_TITANS}`, "error");
    const src = aggregatorBookSource(signerFromSecret(KEY_ID, keypair.seedHex), fake.host, { streamUrl: fake.streamUrl, wsFactory, streamTimeoutMs: 2_000 });
    const r = await src.read(pairWith(PM_TITANS), new Date());
    assert.equal(r.noAsks, undefined);
    assert.ok(r.notes.some((n) => /own market: snapshot stale/.test(n)), r.notes.join(" | "));
    assert.ok(r.pmNoBook);
    assert.deepEqual(r.references, [{ id: "aggregated_mm", book: null, reason: "stream_market_not_yet_open" }]);

    fake.books.set(`POLYMARKET:${PM_TITANS}`, "silent");
    const r2 = await src.read(pairWith(PM_TITANS), new Date());
    assert.equal(r2.pmNoBook, undefined);
    assert.ok(r2.notes.some((n) => /second venue: UNAVAILABLE/.test(n)), r2.notes.join(" | "));

    // a stale REFERENCE is kept and dated, not dropped: it is compared, never filled on
    fake.books.set(`KALSHI:${TICKER}`, "stale");
    fake.books.set(`POLYMARKET:${PM_TITANS}`, PM_BOOK);
    fake.books.set(`PROPHETX:${PX_TITANS}`, "stale");
    const r3 = await src.read(pairWith(PM_TITANS), new Date());
    assert.equal(r3.noAsks, undefined, "the route's stale book is still dropped");
    assert.equal(r3.references.length, 1);
    const ref = r3.references[0];
    assert.ok(ref.book, "the reference's stale book stands");
    assert.deepEqual(ref.book.asks, [{ priceMilli: 510, sizeMilli: 10_000 }]);
    const staleSec = Math.floor((MAX_SNAPSHOT_AGE_MS + 5_000) / 1000);
    assert.ok(ref.ageSec !== undefined && ref.ageSec >= staleSec && ref.ageSec <= staleSec + 3, `dated past the routes' bound: ${ref.ageSec}s`);
    assert.ok(!r3.notes.some((n) => /stale/.test(n) && !/own market/.test(n)), "no stale note for the reference");
  } finally {
    fake.stop();
  }
});

test("aggregator books: the partner's four mapping states are kept apart on the reference: no listing is 'not mapped', an empty snapshot is 'mapped, no book', not-yet-open and unavailable keep their stream codes; none of them is ever a priced book", async () => {
  const fake = await startFake();
  try {
    fake.books.set(`KALSHI:${TICKER}`, KALSHI_BOOK);
    fake.books.set(`POLYMARKET:${PM_TITANS}`, PM_BOOK);

    // mapped, empty book: a listing whose SNAPSHOT carries no levels; the venue itself has not opened the line
    fake.books.set(`PROPHETX:${PX_TITANS}`, { bids: [], asks: [] });
    const src = aggregatorBookSource(signerFromSecret(KEY_ID, keypair.seedHex), fake.host, { streamUrl: fake.streamUrl, wsFactory, streamTimeoutMs: 2_000 });
    const empty = await src.read(pairWith(PM_TITANS), new Date());
    assert.deepEqual(empty.references, [{ id: "aggregated_mm", book: null, reason: MAPPED_NO_BOOK }]);
    assert.ok(empty.pmNoBook && empty.noAsks, "the routes' books are untouched by a reference's state");
    assert.ok(fake.subscribed[0].some((m) => m.venue === "PROPHETX"), "the listing was streamed: it is mapped");

    // not mapped: the lookup carries no listing for the venue on the opposing outcome, so nothing is streamed for it
    fake.market = {
      ...MARKET,
      outcomes: MARKET.outcomes.map((o) => (o.name === "Titans" ? { ...o, listings: o.listings.filter((l) => l.venue !== "PROPHETX") } : o)),
    };
    const unmapped = aggregatorBookSource(signerFromSecret(KEY_ID, keypair.seedHex), fake.host, { streamUrl: fake.streamUrl, wsFactory, streamTimeoutMs: 2_000 });
    const none = await unmapped.read(pairWith(PM_TITANS), new Date());
    assert.deepEqual(none.references, [{ id: "aggregated_mm", book: null, reason: NOT_MAPPED }]);
    assert.ok(!fake.subscribed[1].some((m) => m.venue === "PROPHETX"), "nothing to subscribe to");
    assert.ok(none.pmNoBook && none.noAsks);

    // a reference with one ask and no bids is still a book: only a snapshot empty on both sides is the "no book yet" state
    fake.market = MARKET;
    fake.books.set(`PROPHETX:${PX_TITANS}`, { bids: [], asks: [{ price: 0.42, size: 150 }] });
    const oneSided = aggregatorBookSource(signerFromSecret(KEY_ID, keypair.seedHex), fake.host, { streamUrl: fake.streamUrl, wsFactory, streamTimeoutMs: 2_000 });
    const r3 = await oneSided.read(pairWith(PM_TITANS), new Date());
    assert.ok(r3.references[0].book);
    assert.deepEqual(r3.references[0].book.asks, [{ priceMilli: 420, sizeMilli: 150_000 }]);
  } finally {
    fake.stop();
  }
});

test("aggregator books: a partner that is down, or a key it does not know, returns no books and a note; nothing throws and the status keeps the error", async () => {
  const fake = await startFake();
  try {
    fake.down = true;
    const src = aggregatorBookSource(signerFromSecret(KEY_ID, keypair.seedHex), fake.host, { streamUrl: fake.streamUrl, wsFactory, streamTimeoutMs: 2_000 });
    const r = await src.read(pairWith(PM_TITANS), new Date());
    assert.equal(r.pmNoBook, undefined);
    assert.equal(r.noAsks, undefined);
    assert.deepEqual(r.references, []);
    assert.match(r.notes[0], /^aggregator lookup: 503 UNAVAILABLE/);
    assert.equal(src.status().lastError, "503 UNAVAILABLE");
    assert.equal(src.status().readsWithBooks, 0);

    fake.down = false;
    const wrongKey = aggregatorBookSource(signerFromSecret("not-our-key", keypair.seedHex), fake.host, { streamUrl: fake.streamUrl, wsFactory, streamTimeoutMs: 2_000 });
    const r2 = await wrongKey.read(pairWith(PM_TITANS), new Date());
    assert.match(r2.notes[0], /^aggregator lookup: 401 UNAUTHORIZED/);

    const unmapped = aggregatorBookSource(signerFromSecret(KEY_ID, keypair.seedHex), fake.host, { streamUrl: fake.streamUrl, wsFactory, streamTimeoutMs: 2_000 });
    const r3 = await unmapped.read({ ...pairWith(PM_TITANS), kalshi: { ticker: "KX-UNKNOWN" } as MatchedPair["kalshi"] }, new Date());
    assert.deepEqual(r3.notes, ["aggregator lookup: ticker not mapped"]);
  } finally {
    fake.stop();
  }
});

test("aggregator books env: nothing set reads nothing; half a key is a note and off; a bad secret is a note and off; a full key builds the source", () => {
  assert.deepEqual(aggregatorBookSourceFromEnv({}), { source: null, notes: [] });
  assert.deepEqual(aggregatorBookSourceFromEnv({ AGGREGATOR_KEY_ID: KEY_ID }).source, null);
  assert.match(aggregatorBookSourceFromEnv({ AGGREGATOR_KEY_ID: KEY_ID }).notes[0], /both be set/);
  const bad = aggregatorBookSourceFromEnv({ AGGREGATOR_KEY_ID: KEY_ID, AGGREGATOR_PRIVATE_KEY_HEX: "zz" });
  assert.equal(bad.source, null);
  assert.match(bad.notes[0], /key unusable/);
  const ok = aggregatorBookSourceFromEnv({ AGGREGATOR_KEY_ID: KEY_ID, AGGREGATOR_PRIVATE_KEY_HEX: keypair.seedHex, AGGREGATOR_API_HOST: "https://api.example.test/" });
  assert.ok(ok.source);
  assert.equal(ok.source.status().host, "https://api.example.test");
  assert.deepEqual(ok.notes, []);
  // the status carries what an operator needs to check a 401 against the partner's portal, never the secret
  assert.equal(ok.source.status().keyIdTail, KEY_ID.slice(-6));
  assert.equal(ok.source.status().publicKeyHex, keypair.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex"));
  assert.ok(!JSON.stringify(ok.source.status()).includes(keypair.seedHex));
});

test("aggregator signer: the public key it derives is the RFC 8032 one for a known seed, from the hex seed and from a PEM alike", () => {
  const seed = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
  const pub = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
  assert.equal(signerFromSecret(KEY_ID, seed).publicKeyHex, pub);
  const pem = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed, "hex")]), format: "der", type: "pkcs8" }).export({ format: "pem", type: "pkcs8" }) as string;
  assert.equal(signerFromSecret(KEY_ID, pem).publicKeyHex, pub);
});
