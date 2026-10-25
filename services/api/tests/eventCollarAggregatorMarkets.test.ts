/**
 * Aggregator markets: the partner's canonical string against the worked example in their docs, the
 * seed-hex key, the signed headers and the signed stream handshake verified against the public key,
 * the discovery client and the lookup against a fake server that checks every signature, retry on a
 * 429, a data key's 403 on a venue path, the stream reader against a fake stream (snapshot, error,
 * timeout), the Kalshi No view, and the env fail-closed. Nothing touches the partner.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createPublicKey, generateKeyPairSync, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket as WsClient } from "ws";
import {
  AggregatorApiError,
  AggregatorClient,
  EMPTY_SHA256,
  aggregatorConfigFromEnv,
  alignedByTicker,
  bestOf,
  canonicalString,
  kalshiNoView,
  readSnapshots,
  sha256Hex,
  signedHeaders,
  signedStreamUrl,
  signerFromSecret,
  sortedQuery,
  streamFor,
  type Market,
  type MarketStream,
  type WsLike,
} from "../src/eventCollar/crossVenue/aggregatorMarkets";

// ---------------------------------------------------------------------------
// a keypair whose seed we know, as the partner issues it
// ---------------------------------------------------------------------------

const keypair = (() => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  return { seedHex: der.subarray(der.length - 32).toString("hex"), publicKey, publicPem: publicKey.export({ format: "pem", type: "spki" }) as string };
})();
const KEY_ID = "3f7c1b2a-9d4e-4a61-b8f0-2c5d7e91a4b3";
const verifies = (canonical: string, sigHex: string, pub: KeyObject = keypair.publicKey) => cryptoVerify(null, Buffer.from(canonical, "utf8"), pub, Buffer.from(sigHex, "hex"));

// ---------------------------------------------------------------------------
// signing
// ---------------------------------------------------------------------------

test("aggregator signing: the docs' worked example (POST with an idempotency key) is reproduced byte for byte", () => {
  const body = "{}";
  const s = canonicalString({ method: "post", path: "/v1/polymarket/orders", query: "", timestamp: "1727150000", body, idempotencyKey: " order-2f9c1a " });
  const lines = s.split("\n");
  assert.equal(lines.length, 6);
  assert.deepEqual(lines.slice(0, 4), ["POST", "/v1/polymarket/orders", "", "1727150000"]);
  assert.equal(lines[4], sha256Hex(body));
  assert.equal(lines[5], "order-2f9c1a");
  assert.ok(!s.endsWith("\n"));
  // without the header the string stops at five lines
  assert.equal(canonicalString({ method: "POST", path: "/v1/polymarket/orders", query: "", timestamp: "1727150000", body }).split("\n").length, 5);
});

test("aggregator signing: an empty body hashes to the empty string's sha256; the query is sorted by key then value", () => {
  assert.equal(canonicalString({ method: "GET", path: "/v1/whoami", query: "", timestamp: "1", body: "" }).split("\n")[4], EMPTY_SHA256);
  assert.equal(sortedQuery("ticker=KX-B&eventId=evt_1&ticker=KX-A"), "eventId=evt_1&ticker=KX-A&ticker=KX-B");
  assert.equal(sortedQuery("?b=2&a=1"), "a=1&b=2");
  assert.equal(sortedQuery(""), "");
  assert.equal(sortedQuery("flag&a=1"), "a=1&flag");
});

test("aggregator signing: the seed-hex key signs, the signature is lowercase hex and verifies against the public key; a PEM builds the same signer", () => {
  const signer = signerFromSecret(KEY_ID, keypair.seedHex.toUpperCase());
  const sig = signer.sign("hello");
  assert.match(sig, /^[0-9a-f]{128}$/);
  assert.ok(verifies("hello", sig));
  const { privateKey } = generateKeyPairSync("ed25519");
  const pemSigner = signerFromSecret(KEY_ID, privateKey.export({ format: "pem", type: "pkcs8" }) as string);
  assert.ok(verifies("x", pemSigner.sign("x"), createPublicKey(privateKey)));
  assert.throws(() => signerFromSecret(KEY_ID, "not-a-key"), /64-hex|PKCS8/);
  const { privateKey: ec } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  assert.throws(() => signerFromSecret(KEY_ID, ec.export({ format: "pem", type: "pkcs8" }) as string), /Ed25519/);
});

test("aggregator signing: signed headers carry the four PX-* headers; GET /v1/time signs an empty timestamp line and sends no PX-Timestamp", () => {
  const signer = signerFromSecret(KEY_ID, keypair.seedHex);
  const h = signedHeaders(signer, { method: "GET", path: "/v1/sports/events", query: "competitionId=cmp_nfl" }, 1_727_150_000);
  assert.equal(h["PX-Key-Id"], KEY_ID);
  assert.equal(h["PX-Timestamp"], "1727150000");
  assert.equal(h["PX-Content-Sha256"], EMPTY_SHA256);
  assert.ok(verifies(["GET", "/v1/sports/events", "competitionId=cmp_nfl", "1727150000", EMPTY_SHA256].join("\n"), h["PX-Signature"]));

  const t = signedHeaders(signer, { method: "GET", path: "/v1/time" }, 1_727_150_000);
  assert.equal(t["PX-Timestamp"], undefined);
  assert.ok(verifies(["GET", "/v1/time", "", "", EMPTY_SHA256].join("\n"), t["PX-Signature"]));

  const p = signedHeaders(signer, { method: "POST", path: "/v1/x", body: '{"a":1}', idempotencyKey: "k-1" }, 5);
  assert.equal(p["Idempotency-Key"], "k-1");
  assert.equal(p["PX-Content-Sha256"], sha256Hex('{"a":1}'));
  assert.ok(verifies(["POST", "/v1/x", "", "5", sha256Hex('{"a":1}'), "k-1"].join("\n"), p["PX-Signature"]));
});

test("aggregator signing: the stream handshake signs WS over the path with the credential params excluded, and rides in the query", () => {
  const signer = signerFromSecret(KEY_ID, keypair.seedHex);
  const url = new URL(signedStreamUrl(signer, "wss://stream.example/v1/orderbook", 1_727_150_000));
  assert.equal(url.searchParams.get("keyId"), KEY_ID);
  assert.equal(url.searchParams.get("timestamp"), "1727150000");
  const sig = url.searchParams.get("signature")!;
  assert.ok(verifies(["WS", "/v1/orderbook", "", "1727150000", EMPTY_SHA256].join("\n"), sig));
  // a REST signature on the same path does not verify as a handshake, and vice versa
  assert.ok(!verifies(["GET", "/v1/orderbook", "", "1727150000", EMPTY_SHA256].join("\n"), sig));
});

// ---------------------------------------------------------------------------
// a fake partner that checks every signature
// ---------------------------------------------------------------------------

const NFL_MARKETS: Market[] = [
  {
    id: "mkt_tenind",
    title: "Titans @ Colts: Moneyline",
    outcomes: [
      {
        name: "Colts",
        listings: [
          { venue: "KALSHI", ticker: "KXNFLGAME-26OCT18TENIND-IND", side: "YES", bookSide: "BID", executable: true },
          { venue: "PROPHETX", strikeId: "ab39fb9a7b4eb6a26d7e26f885c601c1", executable: true },
          { venue: "POLYMARKET", tokenId: "18880079750227829983884034851154743863020946982779905261595472835484541675290", executable: false },
        ],
      },
      {
        name: "Titans",
        listings: [
          { venue: "KALSHI", ticker: "KXNFLGAME-26OCT18TENIND-IND", side: "NO", bookSide: "ASK", executable: true },
          { venue: "PROPHETX", strikeId: "f1542026d62d185858836622ee2285f3", executable: true },
        ],
      },
    ],
  },
  { id: "mkt_total", title: "Titans @ Colts: Total O/U 44.5", line: "44.5", outcomes: [{ name: "Over", listings: [] }, { name: "Under", listings: [] }] },
];

interface FakeState {
  calls: Array<{ path: string; query: string; ok: boolean; why?: string }>;
  rateLimitOnce: boolean;
  serverOffsetSec: number;
  capability: "data" | "trade";
}

/** close() alone waits on fetch's keep-alive sockets; drop them so the test process can exit */
const stop = (server: Server) => {
  server.closeAllConnections();
  server.close();
};

function startFakeRest(state: FakeState): Promise<{ server: Server; host: string }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? "/", "http://x");
    const query = u.search.slice(1);
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    const auth = (): string | null => {
      const keyId = req.headers["px-key-id"];
      const ts = req.headers["px-timestamp"];
      const sha = req.headers["px-content-sha256"];
      const sig = req.headers["px-signature"];
      if (typeof keyId !== "string" || typeof sha !== "string" || typeof sig !== "string") return "missing headers";
      if (keyId !== KEY_ID) return "unknown key";
      if (sha !== EMPTY_SHA256) return "body hash";
      const isTime = u.pathname === "/v1/time";
      if (!isTime) {
        if (typeof ts !== "string") return "missing timestamp";
        const serverNow = Math.floor(Date.now() / 1000) + state.serverOffsetSec;
        if (Math.abs(Number(ts) - serverNow) > 30) return "stale timestamp";
      } else if (ts !== undefined) return "time endpoint carries no timestamp";
      const canonical = [req.method ?? "GET", u.pathname, sortedQuery(query), isTime ? "" : String(ts), sha].join("\n");
      return verifies(canonical, sig) ? null : "signature";
    };
    const why = auth();
    state.calls.push({ path: u.pathname, query, ok: !why, why: why ?? undefined });
    if (why) return send(401, { error: { code: "UNAUTHORIZED", message: why } });
    if (u.pathname.startsWith("/v1/kalshi/") || u.pathname.startsWith("/v1/prophetx/") || u.pathname.startsWith("/v1/polymarket/")) {
      if (state.capability === "data") return send(403, { error: { code: "FORBIDDEN", message: "data key" } });
    }
    if (u.pathname === "/v1/whoami") return send(200, { keyId: KEY_ID, credentialId: "cred_1", podId: "pod_abc123", scope: "trader", capabilities: [state.capability] });
    if (u.pathname === "/v1/time") return send(200, { time: Math.floor(Date.now() / 1000) + state.serverOffsetSec });
    if (u.pathname === "/v1/sports") return send(200, { sports: [{ id: "spt_football", name: "Football" }, { id: "spt_baseball", name: "Baseball" }] });
    if (u.pathname === "/v1/sports/competitions") {
      const all = [{ id: "cmp_nfl", name: "NFL", sportId: "spt_football" }, { id: "cmp_mlb", name: "MLB", sportId: "spt_baseball" }];
      const sport = u.searchParams.get("sport");
      return send(200, { competitions: sport ? all.filter((c) => c.sportId === sport) : all });
    }
    if (u.pathname === "/v1/sports/events") {
      if (!u.searchParams.get("competitionId")) return send(400, { error: { code: "INVALID_REQUEST", message: "competitionId" } });
      if (state.rateLimitOnce) {
        state.rateLimitOnce = false;
        return send(429, { error: { code: "RATE_LIMITED", message: "slow down" } }, { "retry-after": "1" });
      }
      return send(200, { events: [{ id: "evt_tenind", name: "Titans @ Colts", competitionId: "cmp_nfl", startTime: "2026-10-18T17:00:00Z", status: "SCHEDULED" }] });
    }
    if (u.pathname === "/v1/sports/events/evt_tenind/markets") return send(200, { markets: NFL_MARKETS });
    if (u.pathname === "/v1/markets") {
      const ticker = u.searchParams.get("ticker");
      if (ticker === "KXNFLGAME-26OCT18TENIND-IND") return send(200, { markets: [NFL_MARKETS[0]] });
      if (u.searchParams.get("strikeId") && !u.searchParams.get("eventId")) return send(400, { error: { code: "INVALID_REQUEST", message: "strikeId needs eventId" } });
      return send(200, { markets: [] });
    }
    send(404, { error: { code: "NOT_FOUND", message: u.pathname } });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, host: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

test("aggregator client: whoami, time (offset applied), discovery, the lookup aligned by ticker, a 429 retried once, a data key's 403 on a venue path", async () => {
  const state: FakeState = { calls: [], rateLimitOnce: true, serverOffsetSec: 25, capability: "data" };
  const { server, host } = await startFakeRest(state);
  try {
    const signer = signerFromSecret(KEY_ID, keypair.seedHex);
    const client = new AggregatorClient({ host, signer });

    const who = await client.whoami();
    assert.deepEqual(who.capabilities, ["data"]);
    assert.equal(who.podId, "pod_abc123");

    // the server runs 25s ahead: inside the window before time() is called, in step after
    await client.time();
    assert.equal(client.clockOffsetSec, 25);

    const sports = await client.listSports();
    assert.equal(sports.length, 2);
    const comps = await client.listCompetitions("spt_football");
    assert.deepEqual(comps.map((c) => c.name), ["NFL"]);

    const t0 = Date.now();
    const events = await client.listEvents("cmp_nfl");
    assert.ok(Date.now() - t0 >= 900, "the 429's Retry-After was honoured");
    assert.equal(events[0].name, "Titans @ Colts");

    const markets = await client.listEventMarkets("evt_tenind");
    assert.equal(markets.length, 2);

    const found = await client.lookupMarket({ ticker: "KXNFLGAME-26OCT18TENIND-IND" });
    const aligned = alignedByTicker(found, "KXNFLGAME-26OCT18TENIND-IND");
    assert.ok(aligned);
    assert.equal(aligned.outcome, "Colts");
    assert.deepEqual(aligned.listings.map((l) => l.venue), ["KALSHI", "PROPHETX", "POLYMARKET"]);
    assert.equal(alignedByTicker(found, "KXNFLGAME-26OCT18TENIND-TEN"), null, "the NO side's ticker is not our YES side");
    assert.deepEqual(await client.lookupMarket({ ticker: "KX-NOPE" }), []);
    await assert.rejects(client.lookupMarket({ strikeId: "abc", eventId: "" } as never), (e: unknown) => e instanceof AggregatorApiError && e.status === 400 && e.code === "INVALID_REQUEST");

    // the client never calls venue paths; show the server would refuse a data key anyway
    await assert.rejects(
      (client as unknown as { request: (m: string, p: string) => Promise<unknown> }).request("GET", "/v1/kalshi/positions"),
      (e: unknown) => e instanceof AggregatorApiError && e.status === 403 && e.code === "FORBIDDEN",
    );

    assert.ok(state.calls.every((c) => c.ok), `every request verified: ${JSON.stringify(state.calls.filter((c) => !c.ok))}`);
    assert.equal(state.calls.filter((c) => c.path === "/v1/sports/events").length, 2, "one 429 then one success");
    assert.ok(state.calls.some((c) => c.path === "/v1/markets" && c.query === "ticker=KXNFLGAME-26OCT18TENIND-IND"));
  } finally {
    stop(server);
  }
});

test("aggregator client: a wrong key id, a stale clock and a tampered signature all come back 401 UNAUTHORIZED", async () => {
  const state: FakeState = { calls: [], rateLimitOnce: false, serverOffsetSec: 0, capability: "data" };
  const { server, host } = await startFakeRest(state);
  try {
    const good = signerFromSecret(KEY_ID, keypair.seedHex);
    await assert.rejects(new AggregatorClient({ host, signer: signerFromSecret("other-key", keypair.seedHex) }).whoami(), (e: unknown) => e instanceof AggregatorApiError && e.status === 401 && e.code === "UNAUTHORIZED");
    await assert.rejects(new AggregatorClient({ host, signer: good, nowSec: () => Math.floor(Date.now() / 1000) - 120 }).whoami(), (e: unknown) => e instanceof AggregatorApiError && e.status === 401);
    const other = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }) as string;
    await assert.rejects(new AggregatorClient({ host, signer: signerFromSecret(KEY_ID, other) }).whoami(), (e: unknown) => e instanceof AggregatorApiError && e.status === 401);
    assert.deepEqual(state.calls.map((c) => c.why), ["unknown key", "stale timestamp", "signature"]);
  } finally {
    stop(server);
  }
});

// ---------------------------------------------------------------------------
// a fake stream
// ---------------------------------------------------------------------------

/** Adapt the `ws` client to the reader's minimal surface (Node's global WebSocket already has it). */
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

/** the slice of a `ws` server-side socket the fake uses (the package ships no types here) */
interface ServerSocket {
  send(data: string): void;
  on(event: "message", cb: (raw: Buffer) => void): void;
  terminate(): void;
}

function startFakeStream(opts: { silentFor?: Set<string>; unavailableTimes?: Map<string, number> } = {}): Promise<{ stop: () => void; url: string; handshakes: Array<{ ok: boolean; why?: string }>; subscribes: MarketStream[][] }> {
  const handshakes: Array<{ ok: boolean; why?: string }> = [];
  const subscribes: MarketStream[][] = [];
  const unavailableLeft = new Map(opts.unavailableTimes ?? []);
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const u = new URL(req.url ?? "/", "http://x");
    const keyId = u.searchParams.get("keyId");
    const ts = u.searchParams.get("timestamp");
    const sig = u.searchParams.get("signature");
    const why = !keyId || !ts || !sig ? "missing" : keyId !== KEY_ID ? "key" : Math.abs(Number(ts) - Math.floor(Date.now() / 1000)) > 30 ? "stale" : !verifies(["WS", u.pathname, "", ts, EMPTY_SHA256].join("\n"), sig) ? "signature" : null;
    handshakes.push({ ok: !why, why: why ?? undefined });
    if (why) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: ServerSocket) => wss.emit("connection", ws, req));
  });
  wss.on("connection", (ws: ServerSocket) => {
    const now = Date.now();
    let subN = 0;
    ws.send(JSON.stringify({ type: "WELCOME", v: 1, serverTimestamp: now, connectionId: "conn-1", limits: { maxSubscriptionsPerConnection: 200, maxConnections: 20, connectionTtlSeconds: 28800 } }));
    ws.on("message", (raw: Buffer) => {
      const f = JSON.parse(raw.toString("utf8")) as { type: string; markets?: MarketStream[]; requestId?: string };
      if (f.type !== "SUBSCRIBE") return;
      subscribes.push(f.markets ?? []);
      for (const m of f.markets ?? []) {
        subN += 1;
        const key = JSON.stringify(m);
        if (m.venue === "POLYMARKET" && m.tokenId === "bad") {
          ws.send(JSON.stringify({ type: "ERROR", v: 1, serverTimestamp: now, market: m, channel: "BOOK", code: "UNKNOWN_MARKET", message: "no such token" }));
          continue;
        }
        const subscriptionId = `sub-${subN}`;
        ws.send(JSON.stringify({ type: "SUBSCRIBED", v: 1, serverTimestamp: now, market: m, channel: "BOOK", subscriptionId, snapshotPending: true }));
        const left = unavailableLeft.get(key) ?? 0;
        if (left > 0) {
          unavailableLeft.set(key, left - 1);
          ws.send(JSON.stringify({ type: "ERROR", v: 1, serverTimestamp: now, subscriptionId, code: "UNAVAILABLE", message: "no book for that line right now" }));
          continue;
        }
        if (opts.silentFor?.has(key)) continue;
        if (m.venue === "PROPHETX") {
          ws.send(JSON.stringify({ type: "ERROR", v: 1, serverTimestamp: now, subscriptionId, code: "MARKET_NOT_YET_OPEN", message: "books open nearer the start" }));
          continue;
        }
        ws.send(
          JSON.stringify({
            type: "SNAPSHOT",
            v: 1,
            serverTimestamp: now,
            subscriptionId,
            seq: 4287,
            venueTimestamp: now - 90_000,
            bids: [{ price: 0.52, size: 1250 }, { price: 0.51, size: 900 }],
            asks: [{ price: 0.53, size: 800 }, { price: 0.54, size: 1500 }],
            status: "LIVE",
          }),
        );
        // a delta after the snapshot must not disturb a first-snapshot read
        ws.send(JSON.stringify({ type: "DELTA", v: 1, serverTimestamp: now + 1, subscriptionId, seq: 4288, venueTimestamp: now, changes: [{ side: "BID", price: 0.52, size: 0 }] }));
      }
    });
  });
  const stopAll = () => {
    for (const c of wss.clients) c.terminate();
    wss.close();
    stop(server);
  };
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ stop: stopAll, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/orderbook`, handshakes, subscribes })));
}

test("aggregator stream: UNAVAILABLE is transient by the partner's word, so that one market is subscribed once more inside the read; a second UNAVAILABLE is final, and the retry never stretches the timeout", async () => {
  const once = { venue: "KALSHI", ticker: "KX-ONCE" } as const;
  const twice = { venue: "KALSHI", ticker: "KX-TWICE" } as const;
  const steady = { venue: "KALSHI", ticker: "KX-STEADY" } as const;
  const { stop: stopStream, url, subscribes } = await startFakeStream({
    unavailableTimes: new Map([
      [JSON.stringify(once), 1],
      [JSON.stringify(twice), 2],
    ]),
  });
  try {
    const signer = signerFromSecret(KEY_ID, keypair.seedHex);
    const t0 = Date.now();
    const out = await readSnapshots(signer, [once, twice, steady], { streamUrl: url, wsFactory, timeoutMs: 2_000, retryDelayMs: 200 });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 180 && elapsed < 1_500, `settled after the one retry, before the timeout (${elapsed}ms)`);
    const [a, b, c] = out;
    assert.ok(a.book, "the retry caught the book the first SUBSCRIBE missed");
    assert.equal(a.book.seq, 4287);
    assert.equal(b.book, null);
    assert.equal(b.error?.code, "UNAVAILABLE");
    assert.match(b.error?.message ?? "", /twice/);
    assert.ok(c.book, "a market that answered first time is untouched");
    // one SUBSCRIBE for the batch, then one per retried market carrying only that market
    assert.equal(subscribes.length, 3);
    assert.deepEqual(subscribes[0], [once, twice, steady]);
    assert.deepEqual(subscribes.slice(1).map((s) => s.length), [1, 1]);
    assert.deepEqual(new Set(subscribes.slice(1).map((s) => (s[0] as { ticker: string }).ticker)), new Set(["KX-ONCE", "KX-TWICE"]));
  } finally {
    stopStream();
  }
});

test("aggregator stream: a signed handshake, WELCOME then SUBSCRIBE, one snapshot per market, an unknown market's error, a not-yet-open book, and a silent one times out as UNAVAILABLE", async () => {
  const { stop: stopStream, url, handshakes } = await startFakeStream({ silentFor: new Set([JSON.stringify({ venue: "KALSHI", ticker: "KX-SILENT" })]) });
  try {
    const signer = signerFromSecret(KEY_ID, keypair.seedHex);
    const markets: MarketStream[] = [
      { venue: "KALSHI", ticker: "KXNFLGAME-26OCT18TENIND-IND" },
      { venue: "PROPHETX", strikeId: "ab39fb9a7b4eb6a26d7e26f885c601c1" },
      { venue: "POLYMARKET", tokenId: "bad" },
      { venue: "KALSHI", ticker: "KX-SILENT" },
    ];
    const t0 = Date.now();
    const out = await readSnapshots(signer, markets, { streamUrl: url, wsFactory, timeoutMs: 1_500 });
    assert.ok(Date.now() - t0 >= 1_400, "waited for the silent market until the timeout");
    assert.deepEqual(handshakes, [{ ok: true, why: undefined }]);
    assert.equal(out.length, 4);

    const [kalshi, px, poly, silent] = out;
    assert.ok(kalshi.book);
    assert.equal(kalshi.book.seq, 4287, "the first snapshot, not the delta after it");
    assert.deepEqual(bestOf(kalshi.book), { bidCents: 52, askCents: 53, bidSize: 1250, askSize: 800 });
    assert.equal(kalshi.book.serverTimestamp - kalshi.book.venueTimestamp, 90_000);
    assert.equal(px.book, null);
    assert.equal(px.error?.code, "MARKET_NOT_YET_OPEN");
    assert.equal(poly.book, null);
    assert.equal(poly.error?.code, "UNKNOWN_MARKET");
    assert.equal(silent.book, null);
    assert.equal(silent.error?.code, "UNAVAILABLE");
  } finally {
    stopStream();
  }
});

test("aggregator stream: a handshake signed with the wrong key is refused at the upgrade and the reader rejects; no markets means no connection", async () => {
  const { stop: stopStream, url, handshakes } = await startFakeStream();
  try {
    const wrong = signerFromSecret(KEY_ID, generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }) as string);
    await assert.rejects(readSnapshots(wrong, [{ venue: "KALSHI", ticker: "KX" }], { streamUrl: url, wsFactory, timeoutMs: 1_000 }), /aggregator stream/);
    assert.deepEqual(handshakes, [{ ok: false, why: "signature" }]);
    assert.deepEqual(await readSnapshots(wrong, [], { streamUrl: url, wsFactory }), []);
    assert.equal(handshakes.length, 1);
  } finally {
    stopStream();
  }
});

// ---------------------------------------------------------------------------
// book arithmetic, stream entries, env
// ---------------------------------------------------------------------------

test("aggregator books: the Kalshi No view flips price and swaps sides with size unchanged; the docs' three checks hold", () => {
  const yes = { bids: [{ price: 0.52, size: 1250 }, { price: 0.51, size: 900 }], asks: [{ price: 0.53, size: 800 }, { price: 0.54, size: 1500 }] };
  const no = kalshiNoView(yes);
  assert.deepEqual(no.bids, [{ price: 0.47, size: 800 }, { price: 0.46, size: 1500 }]);
  assert.deepEqual(no.asks, [{ price: 0.48, size: 1250 }, { price: 0.49, size: 900 }]);
  const y = bestOf(yes);
  const n = bestOf(no);
  assert.equal(y.askCents! + n.bidCents!, 100);
  assert.equal(y.bidCents! + n.askCents!, 100);
  assert.equal(y.askCents! - y.bidCents!, n.askCents! - n.bidCents!);
  assert.deepEqual(bestOf({ bids: [], asks: [] }), { bidCents: null, askCents: null, bidSize: 0, askSize: 0 });
});

test("aggregator stream entries: a listing becomes the stream entry its venue needs; an unknown venue has none", () => {
  const colts = NFL_MARKETS[0].outcomes[0].listings;
  assert.deepEqual(colts.map(streamFor), [
    { venue: "KALSHI", ticker: "KXNFLGAME-26OCT18TENIND-IND" },
    { venue: "PROPHETX", strikeId: "ab39fb9a7b4eb6a26d7e26f885c601c1" },
    { venue: "POLYMARKET", tokenId: "18880079750227829983884034851154743863020946982779905261595472835484541675290" },
  ]);
  assert.equal(streamFor({ venue: "SOMEWHERE", executable: true }), null);
});

test("aggregator env: null unless both halves of the key are set; the hosts default to the partner's", () => {
  assert.equal(aggregatorConfigFromEnv({}), null);
  assert.equal(aggregatorConfigFromEnv({ AGGREGATOR_KEY_ID: "k" }), null);
  assert.equal(aggregatorConfigFromEnv({ AGGREGATOR_PRIVATE_KEY_HEX: "ab" }), null);
  const cfg = aggregatorConfigFromEnv({ AGGREGATOR_KEY_ID: " k ", AGGREGATOR_PRIVATE_KEY_HEX: keypair.seedHex, AGGREGATOR_API_HOST: "https://h.example/" });
  assert.deepEqual(cfg, { host: "https://h.example", streamUrl: "wss://wss.parlayx.com/v1/orderbook", keyId: "k", secret: keypair.seedHex });
  assert.equal(aggregatorConfigFromEnv({ AGGREGATOR_KEY_ID: "k", AGGREGATOR_PRIVATE_KEY_HEX: keypair.seedHex })?.host, "https://api.parlayx.com");
});
