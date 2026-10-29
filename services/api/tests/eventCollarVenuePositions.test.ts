/**
 * Holder positions read from the venue's API: the V3 canonical string against the venue's published
 * vectors (and their published signatures against the published public keys), our signer round trip,
 * the cents-per-contract to dollars-per-contract conversion, the club matcher, and the worker's
 * /api/shadow/positions route with a fake venue. Nothing touches a venue.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createPublicKey, generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VenueClient,
  canonicalQuery,
  canonicalString,
  clubMatches,
  holderPositions,
  matchPosition,
  positionSize,
  signedHeaders,
  signerFromPem,
  templateForLeague,
  venueConfigFromEnv,
  type RawVenueEvent,
  type RawVenueMarket,
  type RawVenuePosition,
} from "../src/eventCollar/crossVenue/venuePositions";
import { LEAGUE_TEMPLATES } from "../src/eventCollar/crossVenue/resolutionWhitelist";
import { appendShadowRecord } from "../src/eventCollar/crossVenue/shadowLedger";

interface Vector {
  id: string;
  algorithm: string;
  keypair_id: string;
  input: { timestamp: number; method: string; path: string; query: string; body: string };
  string_to_sign: string;
  signature: string;
}
const fixture = JSON.parse(readFileSync(new URL("./fixtures/venue-signing-vectors.json", import.meta.url), "utf8")) as {
  keypairs: Record<string, { algorithm: string; public_key_spki_pem: string }>;
  vectors: Vector[];
};

test("venue signing: every published vector's canonical string is reproduced byte for byte", () => {
  assert.equal(fixture.vectors.length, 30);
  for (const v of fixture.vectors) {
    const ours = canonicalString({ timestampMs: v.input.timestamp, method: v.input.method, path: v.input.path, query: v.input.query, body: v.input.body });
    assert.equal(ours, v.string_to_sign, v.id);
  }
});

test("venue signing: the published signatures verify against the published public keys (Ed25519 raw, P-256 DER)", () => {
  for (const v of fixture.vectors) {
    const kp = fixture.keypairs[v.keypair_id];
    const pub = createPublicKey(kp.public_key_spki_pem);
    const data = Buffer.from(v.string_to_sign, "utf8");
    const sig = Buffer.from(v.signature, "base64");
    const ok = v.algorithm === "ed25519" ? cryptoVerify(null, data, pub, sig) : cryptoVerify("sha256", data, { key: pub, dsaEncoding: "der" }, sig);
    assert.equal(ok, true, v.id);
  }
});

test("venue signing: canonical query edge cases by hand", () => {
  assert.equal(canonicalQuery(""), "");
  assert.equal(canonicalQuery("b=2&a=1"), "a=1&b=2");
  assert.equal(canonicalQuery("a=2&a=1"), "a=1&a=2");
  assert.equal(canonicalQuery("flag"), "flag=");
  assert.equal(canonicalQuery("token=abc="), "token=abc%3D");
  assert.equal(canonicalQuery("q=a+b"), "q=a%2Bb");
  assert.equal(canonicalQuery("q=a%20b"), "q=a%20b");
  assert.equal(canonicalQuery("q=%2f"), "q=%2F");
  assert.equal(canonicalQuery("Z=1&a=1"), "Z=1&a=1");
  assert.equal(canonicalQuery("u=%C3%BC"), "u=%C3%BC");
  assert.equal(canonicalQuery("t=a.b-c_d~e"), "t=a.b-c_d~e");
});

test("venue signing: our Ed25519 and P-256 signers produce headers the venue's verifier would accept", () => {
  for (const type of ["ed25519", "ec"] as const) {
    const { publicKey, privateKey } = type === "ed25519" ? generateKeyPairSync("ed25519") : generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const signer = signerFromPem("11111111-2222-3333-4444-555555555555", pem);
    assert.equal(signer.algorithm, type === "ed25519" ? "Ed25519" : "P-256");
    const now = 1_755_000_000_000;
    const h = signedHeaders(signer, { method: "GET", path: "/v3/portfolio/positions", query: "", body: "" }, now);
    assert.equal(h["Novig-Key-Id"], "11111111-2222-3333-4444-555555555555");
    assert.equal(h["Novig-Timestamp"], "1755000000000");
    const canon = canonicalString({ timestampMs: now, method: "GET", path: "/v3/portfolio/positions", query: "", body: "" });
    const sig = Buffer.from(h["Novig-Signature"], "base64");
    const ok = type === "ed25519" ? cryptoVerify(null, Buffer.from(canon), publicKey, sig) : cryptoVerify("sha256", Buffer.from(canon), { key: publicKey, dsaEncoding: "der" }, sig);
    assert.equal(ok, true);
    // standard base64 with padding, as the venue requires
    assert.match(h["Novig-Signature"], /^[A-Za-z0-9+/]+=*$/);
  }
  // escaped newlines in an env var are accepted
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString().replace(/\n/g, "\\n");
  assert.equal(signerFromPem("k", pem).algorithm, "Ed25519");
});

test("venue config: all three of host, key id and PEM or nothing", () => {
  assert.equal(venueConfigFromEnv({}), null);
  assert.equal(venueConfigFromEnv({ VENUE_API_HOST: "https://api.example", VENUE_API_KEY_ID: "k" }), null);
  assert.deepEqual(venueConfigFromEnv({ VENUE_API_HOST: "https://api.example/", VENUE_API_KEY_ID: " k ", VENUE_API_PRIVATE_KEY_PEM: "pem" }), { host: "https://api.example", keyId: "k", pem: "pem" });
});

test("units: the venue's 1-cent contracts become our $1 contracts to the hundredth; qty 2000 at $11.40 is 20 contracts at 57c paying $20, qty 3703 is 37.03", () => {
  assert.deepEqual(positionSize(2000, "11.40000"), { contracts: 20, entryCents: 57, payoutCents: 2000, costCents: 1140 });
  assert.deepEqual(positionSize(3703, "20.00000"), { contracts: 37.03, entryCents: 54, payoutCents: 3703, costCents: 2000 });
  assert.deepEqual(positionSize(1595, "9.89"), { contracts: 15.95, entryCents: 62, payoutCents: 1595, costCents: 989 });
  assert.deepEqual(positionSize(150, "0.99"), { contracts: 1.5, entryCents: 66, payoutCents: 150, costCents: 99 });
  assert.equal(positionSize(40, "0.20"), null);
  assert.equal(positionSize(99, "0.50"), null);
  assert.equal(positionSize(0, "0"), null);
  assert.equal(positionSize(2000, "abc"), null);
});

test("club matcher: nickname or full name matches, a shared city word does not, bare codes resolve through the aliases", () => {
  const nfl = templateForLeague("NFL");
  assert.ok(nfl);
  const giants = nfl.teamNames.NYG;
  const jets = nfl.teamNames.NYJ;
  assert.equal(clubMatches(nfl, jets, "New York Jets"), true);
  assert.equal(clubMatches(nfl, jets, "NYJ Jets"), true);
  assert.equal(clubMatches(nfl, jets, "Jets"), true);
  assert.equal(clubMatches(nfl, jets, "New York Giants"), false);
  assert.equal(clubMatches(nfl, giants, "New York Jets"), false);
  assert.equal(clubMatches(nfl, nfl.teamNames.HOU, "Houston"), true);
  assert.equal(clubMatches(nfl, nfl.teamNames.LAR, "Los Angeles"), false); // Rams and Chargers share it
  assert.equal(clubMatches(nfl, nfl.teamNames.LAR, "LA Rams"), true);
  const mlb = templateForLeague("mlb");
  assert.ok(mlb);
  assert.equal(clubMatches(mlb, mlb.teamNames.BOS, "Red Sox"), true);
  assert.equal(clubMatches(mlb, mlb.teamNames.BOS, "White Sox"), false);
  assert.equal(clubMatches(mlb, mlb.teamNames.CWS, "Chicago White Sox"), true);
  assert.equal(clubMatches(mlb, mlb.teamNames.CWS, "Chicago"), false); // Cubs share it
  assert.equal(templateForLeague("NHL"), null);
});

const START = Date.UTC(2026, 9, 18, 13, 30); // Sun Oct 18 2026 9:30am ET
const market = (over: Partial<RawVenueMarket> = {}): RawVenueMarket => ({
  marketId: "m-1",
  eventId: "e-1",
  description: "Texans vs. Jaguars",
  marketType: "WINNER",
  status: "OPEN",
  startsTs: START,
  outcomes: [
    { outcomeId: "o-hou", name: "HOU Texans", status: "TBD" },
    { outcomeId: "o-jax", name: "JAX Jaguars", status: "TBD" },
  ],
  ...over,
});
const event: RawVenueEvent = { eventId: "e-1", description: "Texans vs. Jaguars", sport: "Football", league: "NFL", status: "OPEN_PREGAME", startsTs: START };
const protectable = [
  { ticker: "KXNFLGAME-26OCT18HOUJAC-HOU", league: "nfl", sideName: "Houston", title: "Texans at Jaguars Winner?", dateIso: "2026-10-18" },
  { ticker: "KXNFLGAME-26OCT18HOUJAC-JAC", league: "nfl", sideName: "Jacksonville", title: "Texans at Jaguars Winner?", dateIso: "2026-10-18" },
  { ticker: "KXNFLGAME-26OCT25HOUIND-HOU", league: "nfl", sideName: "Houston", title: "Texans at Colts Winner?", dateIso: "2026-10-25" },
  { ticker: "KXNBAGAME-26OCT18HOUSAS-HOU", league: "nba", sideName: "Houston", title: "Rockets at Spurs Winner?", dateIso: "2026-10-18" },
  { ticker: "KXNBAGAME-26OCT18HOUSAS-SAS", league: "nba", sideName: "San Antonio", title: "Rockets at Spurs Winner?", dateIso: "2026-10-18" },
];

test("matcher: the venue's winner outcome maps to our market for that club on that day; spreads, other leagues and far dates do not", () => {
  assert.deepEqual(matchPosition(market(), event, "o-hou", protectable), { ticker: "KXNFLGAME-26OCT18HOUJAC-HOU" });
  assert.deepEqual(matchPosition(market(), event, "o-jax", protectable), { ticker: "KXNFLGAME-26OCT18HOUJAC-JAC" });
  assert.deepEqual(matchPosition(market({ marketType: "SPREAD" }), event, "o-hou", protectable), { ticker: null, reason: "market_not_covered" });
  // the production catalog's word for the winner market
  assert.deepEqual(matchPosition(market({ marketType: "MONEY" }), event, "o-jax", protectable), { ticker: "KXNFLGAME-26OCT18HOUJAC-JAC" });
  assert.deepEqual(matchPosition(market(), { ...event, league: "NHL" }, "o-hou", protectable), { ticker: null, reason: "league_not_covered" });
  assert.deepEqual(matchPosition(market({ startsTs: START + 7 * 86_400_000 }), event, "o-hou", protectable), { ticker: "KXNFLGAME-26OCT25HOUIND-HOU" });
  assert.deepEqual(matchPosition(market({ startsTs: START + 3 * 86_400_000 }), event, "o-hou", protectable), { ticker: null, reason: "no_protectable_market" });
  assert.deepEqual(matchPosition(market(), event, "o-nope", protectable), { ticker: null, reason: "outcome_unknown" });
});

/** A venue that answers the three routes from memory and records what it was asked. */
function fakeVenue(positions: RawVenuePosition[] | Record<string, RawVenuePosition[]>, markets: RawVenueMarket[], events: RawVenueEvent[]) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    const h = init?.headers as Record<string, string>;
    if (!h["Novig-Key-Id"] || !h["Novig-Timestamp"] || !h["Novig-Signature"]) return new Response(JSON.stringify({ code: "SIGNATURE_REJECTED", message: "no" }), { status: 401 });
    if (url.pathname === "/v3/portfolio/positions") return new Response(JSON.stringify(positions), { status: 200 });
    const m = /^\/v3\/catalog\/markets\/(.+)$/.exec(url.pathname);
    if (m) {
      const hit = markets.find((x) => x.marketId === decodeURIComponent(m[1]));
      return hit ? new Response(JSON.stringify(hit), { status: 200 }) : new Response(JSON.stringify({ code: "MARKET_NOT_FOUND", message: "no" }), { status: 404 });
    }
    const e = /^\/v3\/catalog\/events\/(.+)$/.exec(url.pathname);
    if (e) {
      const hit = events.find((x) => x.eventId === decodeURIComponent(e[1]));
      return hit ? new Response(JSON.stringify(hit), { status: 200 }) : new Response(JSON.stringify({ code: "EVENT_NOT_FOUND", message: "no" }), { status: 404 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const { privateKey } = generateKeyPairSync("ed25519");
  const client = new VenueClient({ host: "https://venue.test", signer: signerFromPem("key-1", privateKey.export({ type: "pkcs8", format: "pem" }).toString()), fetchImpl });
  return { client, calls };
}

test("holder positions: a management-scope answer (object by wallet) is flattened, sized, matched, cached; a missing market keeps the row with a reason", async () => {
  const spread = market({ marketId: "m-2", marketType: "SPREAD", outcomes: [{ outcomeId: "o-hou-sp", name: "HOU Texans -2.5", status: "TBD" }] });
  const { client, calls } = fakeVenue(
    {
      "wallet-cash": [
        { marketId: "m-1", outcomeId: "o-hou", qty: 2000, cost: "11.40000" },
        { marketId: "m-2", outcomeId: "o-hou-sp", qty: 1000, cost: "5.00000" },
      ],
      "wallet-sub": [{ marketId: "m-gone", outcomeId: "o-x", qty: 500, cost: "2.50000" }],
    },
    [market(), spread],
    [event],
  );
  const rows = await holderPositions(client, protectable);
  assert.equal(rows.length, 3);
  const hou = rows.find((r) => r.ticker === "KXNFLGAME-26OCT18HOUJAC-HOU");
  assert.ok(hou);
  assert.equal(hou.contracts, 20);
  assert.equal(hou.entryCents, 57);
  assert.equal(hou.payoutCents, 2000);
  assert.equal(hou.costCents, 1140);
  assert.equal(hou.side, "HOU Texans");
  assert.equal(hou.event, "Texans vs. Jaguars");
  assert.equal(hou.league, "nfl");
  assert.equal(hou.startsIso, new Date(START).toISOString());
  assert.equal(hou.id.length, 16);
  const sp = rows.find((r) => r.marketType === "SPREAD");
  assert.ok(sp);
  assert.equal(sp.ticker, null);
  assert.equal(sp.reason, "market_not_covered");
  const gone = rows.find((r) => r.reason === "market_lookup_failed");
  assert.ok(gone);
  assert.equal(gone.contracts, 5);
  // the event was fetched once for the two markets that share it
  assert.equal(calls.filter((c) => c === "/v3/catalog/events/e-1").length, 1);
  await holderPositions(client, protectable);
  assert.equal(calls.filter((c) => c.startsWith("/v3/catalog/markets/m-1")).length, 1);
});

test("shadow worker /api/shadow/positions: configured:false without a venue key; with one, the rows carry our ticker and any lock already on the record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-positions-"));
  const ledger = join(dir, "lock-ledger.jsonl");
  process.env.NODE_ENV = "test";
  process.env.EVENT_SHADOW_LEDGER_PATH = join(dir, "ledger.jsonl");
  process.env.EVENT_SHADOW_LOCK_LEDGER_PATH = ledger;
  process.env.EVENT_SHADOW_LOCK_KEY = "lock-key-for-positions-test";
  delete process.env.VENUE_API_HOST;
  const worker = await import("../scripts/eventShadowWorker");
  const listGameMarkets = async () => protectable.map((m) => ({ ...m, closeTimeIso: new Date(START).toISOString(), markCents: 57 }));
  const quoteOne = async () => ({ ok: false as const, code: "not_offered" as const, detail: "test" });
  worker.wireLockEngine({ quoteOne: quoteOne as never, listGameMarkets: listGameMarkets as never, venueClient: null });
  await new Promise<void>((resolve) => worker.server.listen(0, "127.0.0.1", () => resolve()));
  const port = (worker.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    let r = await fetch(`${base}/api/shadow/positions`);
    assert.equal(r.status, 403);
    r = await fetch(`${base}/api/shadow/positions`, { headers: { "x-lock-key": "lock-key-for-positions-test" } });
    assert.equal(r.status, 200);
    let body = (await r.json()) as { ok: boolean; configured: boolean; positions: unknown[] };
    assert.equal(body.configured, false);
    assert.deepEqual(body.positions, []);

    appendShadowRecord(ledger, {
      type: "open",
      at: "2026-10-14T12:00:00.000Z",
      ticker: "KXNFLGAME-26OCT18HOUJAC-HOU",
      kind: "sports",
      league: "nfl",
      sideName: "Houston",
      eventTitle: "Texans at Jaguars Winner?",
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
      route: "kalshi_self",
      tier: "balanced",
      source: "lock",
    } as Parameters<typeof appendShadowRecord>[1]);
    const { client } = fakeVenue([{ marketId: "m-1", outcomeId: "o-hou", qty: 2000, cost: "11.40000" }], [market()], [event]);
    worker.wireLockEngine({ quoteOne: quoteOne as never, listGameMarkets: listGameMarkets as never, venueClient: { kind: "signed", holderPositions: (p) => holderPositions(client, p) } });
    r = await fetch(`${base}/api/shadow/positions`, { headers: { "x-lock-key": "lock-key-for-positions-test" } });
    const full = (await r.json()) as { ok: boolean; configured: boolean; positions: Array<{ ticker: string | null; contracts: number; lock: { status: string; creditCents: number } | null }> };
    assert.equal(full.configured, true);
    assert.equal(full.positions.length, 1);
    assert.equal(full.positions[0].ticker, "KXNFLGAME-26OCT18HOUJAC-HOU");
    assert.equal(full.positions[0].contracts, 20);
    assert.equal(full.positions[0].lock?.status, "open");
    assert.equal(full.positions[0].lock?.creditCents, 60);
    // nothing in the answer names the venue or carries its ids
    const text = JSON.stringify(full).toLowerCase();
    assert.equal(text.includes("novig"), false);
    assert.equal(text.includes("m-1"), false);
    body = full;
    assert.ok(body.ok);
  } finally {
    worker.server.close();
    worker.wireLockEngine({ quoteOne: quoteOne as never, listGameMarkets: listGameMarkets as never, venueClient: null });
  }
});

test("shadow worker /api/shadow/lock: with the holder's account readable, a lock on the club they do not hold while they hold the other is refused wrong_side; their own side and an unread game pass the guard", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-wrong-side-"));
  process.env.NODE_ENV = "test";
  process.env.EVENT_SHADOW_LEDGER_PATH = join(dir, "ledger.jsonl");
  process.env.EVENT_SHADOW_LOCK_LEDGER_PATH = join(dir, "lock-ledger.jsonl");
  process.env.EVENT_SHADOW_LOCK_KEY = "lock-key-for-positions-test";
  delete process.env.VENUE_API_HOST;
  const worker = await import("../scripts/eventShadowWorker");
  const listGameMarkets = async () => protectable.map((m) => ({ ...m, closeTimeIso: new Date(START).toISOString(), markCents: 57 }));
  // the quote never offers: a request that reaches it answers not_offered, which is the proof it passed the side guard
  const quoteOne = async () => ({ ok: false as const, code: "not_offered" as const, detail: "test" });
  // the venue says the holder has the Texans (o-hou) on the Texans/Jaguars game and the Spurs (o-sas) on the Rockets/Spurs game
  const nbaMarket = market({ marketId: "m-3", eventId: "e-3", description: "Rockets vs. Spurs", outcomes: [{ outcomeId: "o-hou3", name: "HOU Rockets", status: "TBD" }, { outcomeId: "o-sas", name: "SAS Spurs", status: "TBD" }] });
  const nbaEvent: RawVenueEvent = { eventId: "e-3", description: "Rockets vs. Spurs", sport: "Basketball", league: "NBA", status: "OPEN_PREGAME", startsTs: START };
  const { client } = fakeVenue(
    [
      { marketId: "m-1", outcomeId: "o-hou", qty: 2000, cost: "11.40000" },
      { marketId: "m-3", outcomeId: "o-sas", qty: 1000, cost: "5.00000" },
    ],
    [market(), nbaMarket],
    [event, nbaEvent],
  );
  worker.wireLockEngine({ quoteOne: quoteOne as never, listGameMarkets: listGameMarkets as never, venueClient: { kind: "signed", holderPositions: (p) => holderPositions(client, p) } });
  await new Promise<void>((resolve) => worker.server.listen(0, "127.0.0.1", () => resolve()));
  const port = (worker.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const lock = (ticker: string) =>
    fetch(`${base}/api/shadow/lock`, { method: "POST", headers: { "x-lock-key": "lock-key-for-positions-test", "content-type": "application/json" }, body: JSON.stringify({ ticker, contracts: 10, venue: "novig" }) });
  try {
    // the Jaguars side: the venue holds the other club for this holder
    let r = await lock("KXNFLGAME-26OCT18HOUJAC-JAC");
    assert.equal(r.status, 409);
    let body = (await r.json()) as { ok: boolean; error?: string; code?: string; message?: string; heldTicker?: string };
    assert.equal(body.ok, false);
    assert.equal(body.error, "wrong_side");
    assert.equal(body.code, "wrong_side");
    assert.equal(body.heldTicker, "KXNFLGAME-26OCT18HOUJAC-HOU");
    assert.match(body.message ?? "", /Your pick on this game is HOU Texans/);
    // nothing of the venue leaks in the refusal
    assert.equal(JSON.stringify(body).toLowerCase().includes("novig"), false);
    // the Rockets side of the other game: the venue holds the Spurs for this holder
    r = await lock("KXNBAGAME-26OCT18HOUSAS-HOU");
    assert.equal(r.status, 409);
    body = (await r.json()) as typeof body;
    assert.equal(body.error, "wrong_side");
    assert.equal(body.heldTicker, "KXNBAGAME-26OCT18HOUSAS-SAS");
    // the Spurs side: their own club, the guard lets it through to the quote
    r = await lock("KXNBAGAME-26OCT18HOUSAS-SAS");
    assert.equal(r.status, 200);
    body = (await r.json()) as typeof body;
    assert.equal(body.code, "not_offered");
    // a game the venue shows no position on: not the guard's business
    r = await lock("KXNFLGAME-26OCT25HOUIND-HOU");
    assert.equal(r.status, 200);
    body = (await r.json()) as typeof body;
    assert.equal(body.code, "not_offered");
  } finally {
    worker.server.close();
    worker.wireLockEngine({ quoteOne: quoteOne as never, listGameMarkets: listGameMarkets as never, venueClient: null });
  }
});

test("shadow worker /api/shadow/positions: a read on which the venue fails to describe a position's market keeps the match the last read made", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-positions-carry-"));
  process.env.NODE_ENV = "test";
  process.env.EVENT_SHADOW_LEDGER_PATH = join(dir, "ledger.jsonl");
  process.env.EVENT_SHADOW_LOCK_LEDGER_PATH = join(dir, "lock-ledger.jsonl");
  process.env.EVENT_SHADOW_LOCK_KEY = "lock-key-for-positions-test";
  delete process.env.VENUE_API_HOST;
  const worker = await import("../scripts/eventShadowWorker");
  const listGameMarkets = async () => protectable.map((m) => ({ ...m, closeTimeIso: new Date(START).toISOString(), markCents: 57 }));
  const quoteOne = async () => ({ ok: false as const, code: "not_offered" as const, detail: "test" });
  const { client } = fakeVenue([{ marketId: "m-1", outcomeId: "o-hou", qty: 2000, cost: "11.40000" }], [market()], [event]);
  let venueDown = false;
  const flaky = {
    listPositions: () => client.listPositions(),
    getEvent: (id: string) => client.getEvent(id),
    getMarket: async (id: string) => {
      if (venueDown) throw new Error("timeout");
      return client.getMarket(id);
    },
  };
  worker.wireLockEngine({ quoteOne: quoteOne as never, listGameMarkets: listGameMarkets as never, venueClient: { kind: "signed", holderPositions: (p) => holderPositions(flaky as never, p) } });
  await new Promise<void>((resolve) => worker.server.listen(0, "127.0.0.1", () => resolve()));
  const port = (worker.server.address() as AddressInfo).port;
  const read = async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/shadow/positions?fresh=1`, { headers: { "x-lock-key": "lock-key-for-positions-test" } });
    assert.equal(r.status, 200);
    return (await r.json()) as { ok: boolean; configured: boolean; positions: Array<{ id: string; ticker: string | null; reason?: string; contracts: number }> };
  };
  try {
    let body = await read();
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.positions.length, 1);
    assert.equal(body.positions[0].ticker, "KXNFLGAME-26OCT18HOUJAC-HOU");
    assert.equal(body.positions[0].contracts, 20);
    // the venue's market lookup fails on the next read: the position keeps its market, the figures are this read's
    venueDown = true;
    body = await read();
    assert.equal(body.ok, true);
    assert.equal(body.positions.length, 1);
    assert.equal(body.positions[0].ticker, "KXNFLGAME-26OCT18HOUJAC-HOU");
    assert.equal(body.positions[0].reason, undefined);
    assert.equal(body.positions[0].contracts, 20);
    // and the venue back: the same answer
    venueDown = false;
    body = await read();
    assert.equal(body.positions[0].ticker, "KXNFLGAME-26OCT18HOUJAC-HOU");
  } finally {
    worker.server.close();
    worker.wireLockEngine({ quoteOne: quoteOne as never, listGameMarkets: listGameMarkets as never, venueClient: null });
  }
});

test("league templates expose the names the matcher relies on", () => {
  for (const t of LEAGUE_TEMPLATES) assert.ok(Object.keys(t.teamNames).length >= 30, t.league);
});
