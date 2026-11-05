/**
 * The member app (memberApp.ts, memberSale.ts) and its routes on the shadow worker: a member of
 * the outcome-market exchange ("STX") connects their account through the venue's OAuth (PKCE), the
 * lock is their own limit sell of part of the position into the venue's bid (route "member_sale"),
 * the record is written from the fills (a partial fill is a smaller sale, no fill writes nothing),
 * the comparison on the hedge routes is written beside it and never sent, Leave early buys the
 * contracts back, the public record carries the figures and never the venue's ids. A fake venue
 * stands in for the exchange: its OAuth token endpoint, positions, markets, orders, fills.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TAIL_PROBABILITIES, chooseRoute, rulesFor, tableRules, type HedgeRouting } from "../src/eventCollar/crossVenue/hedgeRouting";
import { quoteLadderWrap, type NoAskLevel } from "../src/eventCollar/crossVenue/kalshiLadder";
import {
  MemberClient,
  MemberSessions,
  MemberTokenStore,
  authorizeUrl,
  ComboLegMemory,
  comboLegs,
  comboPickWords,
  comboTickerOf,
  isComboMarket,
  leagueOfCompetition,
  legMarketFor,
  matchMemberMarket,
  memberAppConfigFromEnv,
  memberHolderPositions,
  pkcePair,
  tokenKeyFrom,
  marketResultWord,
  type RawMemberOrder,
  type RawMemberPosition,
  type RawMemberRfq,
} from "../src/eventCollar/crossVenue/memberApp";
import { memberTailTerms, quoteBuyBack, quoteSaleTiers, saleEvCostBps, walkLevels } from "../src/eventCollar/crossVenue/memberSale";
import { appendShadowRecord, cashDue, loadShadowPositions, settlePayouts, writerPayouts } from "../src/eventCollar/crossVenue/shadowLedger";
import { DEFAULT_CROSS_CONFIG, type CrossQuoteResult } from "../src/eventCollar/crossVenue/types";
import type { RawOutcomeMarket } from "../src/eventCollar/crossVenue/venueMarkets";
import type { CandidateResult, GameMarketRow, OneQuoteInputs, OneQuoteResult } from "../scripts/eventProtectXDemoService";

const KEY_HEX = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const TICKER = "KXNBAGAME-26OCT14LALBOS-BOS";
const TICKER2 = "KXNBAGAME-26OCT14NYKMIA-MIA";
const TICKER3 = "KXNBAGAME-26OCT14CHIDET-DET";
const SOON = "KXNBAGAME-26OCT14PHXDEN-DEN";
const START = new Date(Date.now() + 3 * 3_600_000).toISOString();
const START_SOON = new Date(Date.now() + 30 * 60_000).toISOString();
const NO_ASKS: NoAskLevel[] = [
  { priceCents: 41, qtyMilli: 300_000 },
  { priceCents: 42, qtyMilli: 400_000 },
];

// ---------------------------------------------------------------------------
// the fake venue
// ---------------------------------------------------------------------------

type FillMode = "full" | "partial" | "none";

interface FakeVenue {
  base: string;
  close(): void;
  fillMode: FillMode;
  /** every order the venue received, as sent */
  orders: Array<Record<string, unknown>>;
  /** what the browser would get from the venue's authorize page: a code bound to the challenge */
  issueCode(authorizeUrlStr: string): { code: string; state: string };
  tokensIssued: number;
  refreshes: number;
  revoked: string[];
  positions: RawMemberPosition[];
  markets: Record<string, RawOutcomeMarket>;
  /** the account's balance in dollars, as the venue would say it */
  balance: string;
  balanceReads: number;
  catalogueReads: number;
  /** the combo request-for-quote path (assumed shape): every request received, and how the venue answers the next one */
  rfqs: Array<Record<string, unknown>>;
  rfqMode: "quote" | "pending" | "decline" | "off";
  /** the makers' price per contract, and the most they take (partials); the quote's life */
  rfqPrice: string;
  rfqTake: number | null;
  rfqLifeMs: number;
  /** how the venue answers an accept: fill it, or say the quote lapsed */
  acceptMode: "fill" | "expired";
}

function market(id: string, home: string, away: string, start: string, bids: Array<[string, string]>, offers: Array<[string, string]>, maxPrice = "1.00"): RawOutcomeMarket {
  return {
    market_id: id,
    event_id: `ev-${id}`,
    rules: "home_winner",
    status: "open",
    trading: true,
    event_start: start,
    event_title: `${away} at ${home}`,
    competition: "NBA",
    sport: "basketball",
    max_price: maxPrice,
    bids: bids.map(([price, quantity]) => ({ price, quantity })),
    offers: offers.map(([price, quantity]) => ({ price, quantity })),
    participants: [
      { name: home, role: "home" },
      { name: away, role: "away" },
    ],
  };
}

async function fakeVenue(): Promise<FakeVenue> {
  const codes = new Map<string, { challenge: string }>();
  const access = new Map<string, number>();
  const refresh = new Set<string>();
  const orders = new Map<string, RawMemberOrder & { fills: Array<{ price: string; filled: string }> }>();
  let seq = 0;
  const V: FakeVenue = {
    base: "",
    close: () => undefined,
    fillMode: "full",
    orders: [],
    issueCode: (u) => {
      const url = new URL(u);
      const code = `code-${++seq}`;
      codes.set(code, { challenge: url.searchParams.get("code_challenge") ?? "" });
      return { code, state: url.searchParams.get("state") ?? "" };
    },
    tokensIssued: 0,
    refreshes: 0,
    revoked: [],
    positions: [],
    markets: {},
    balance: "250.00",
    balanceReads: 0,
    catalogueReads: 0,
    rfqs: [],
    rfqMode: "quote",
    rfqPrice: "0.30",
    rfqTake: null,
    rfqLifeMs: 30_000,
    acceptMode: "fill",
  };
  const rfqs = new Map<string, RawMemberRfq & { pending: boolean }>();
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let s = "";
      req.on("data", (c) => (s += c));
      req.on("end", () => resolve(s));
    });
  const issue = (res: ServerResponse) => {
    V.tokensIssued += 1;
    const at = `stxapp_at_${V.tokensIssued}_${"x".repeat(20)}`;
    const rt = `stxapp_rt_${V.tokensIssued}_${"y".repeat(20)}`;
    access.set(at, Date.now());
    refresh.add(rt);
    json(res, 200, { access_token: at, refresh_token: rt, token_type: "Bearer", expires_in: 3600, scope: "profile.read balance.read portfolio.read orders.read orders.write" });
  };
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://fake");
      if (url.pathname === "/oauth/token" && req.method === "POST") {
        const basic = Buffer.from(`cid:sec`).toString("base64");
        if (req.headers.authorization !== `Basic ${basic}`) return json(res, 401, { error: "invalid_client" });
        const form = new URLSearchParams(await readBody(req));
        if (form.get("grant_type") === "authorization_code") {
          const c = codes.get(form.get("code") ?? "");
          if (!c) return json(res, 400, { error: "invalid_grant", error_description: "unknown code" });
          codes.delete(form.get("code") ?? "");
          const challenge = createHash("sha256").update(form.get("code_verifier") ?? "", "ascii").digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
          if (challenge !== c.challenge) return json(res, 400, { error: "invalid_grant", error_description: "verifier mismatch" });
          if (form.get("redirect_uri") !== "http://127.0.0.1/cb") return json(res, 400, { error: "invalid_grant", error_description: "redirect mismatch" });
          return issue(res);
        }
        if (form.get("grant_type") === "refresh_token") {
          const rt = form.get("refresh_token") ?? "";
          if (!refresh.has(rt)) return json(res, 400, { error: "invalid_grant", error_description: "refresh token reused or unknown" });
          refresh.delete(rt);
          V.refreshes += 1;
          return issue(res);
        }
        return json(res, 400, { error: "unsupported_grant_type" });
      }
      if (url.pathname === "/oauth/revoke" && req.method === "POST") {
        V.revoked.push(new URLSearchParams(await readBody(req)).get("token") ?? "");
        return json(res, 200, {});
      }
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!access.has(bearer)) return json(res, 401, { error: "Missing or invalid OAuth access token" });
      if (url.pathname === "/api/v1/me") return json(res, 200, { me: { user_id: "u1", account_id: "a1", handle: "celtics_fan", avatar_url: "/avatars/u1.png" } });
      if (url.pathname === "/api/v1/account/balance") {
        V.balanceReads += 1;
        return json(res, 200, { balance: { account_balance: V.balance, available_balance: V.balance } });
      }
      if (url.pathname === "/api/v1/positions") return json(res, 200, { positions: V.positions });
      if (url.pathname === "/api/v1/markets") {
        const competitions = url.searchParams.get("competitions");
        if (competitions) {
          // the public catalogue, one page: every listed market of the competition
          V.catalogueReads += 1;
          const statuses = (url.searchParams.get("status") ?? "").split(",");
          return json(res, 200, { cursor: null, markets: Object.values(V.markets).filter((m) => m.competition === competitions && statuses.includes(m.status ?? "")) });
        }
        const ids = (url.searchParams.get("market_ids") ?? "").split(",");
        return json(res, 200, { markets: ids.map((id) => V.markets[id]).filter(Boolean) });
      }
      if (url.pathname === "/api/v1/orders" && req.method === "POST") {
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        V.orders.push(body);
        const id = `ord-${++seq}`;
        const want = Number(body.quantity);
        const m = V.markets[String(body.market_id)];
        const levels = (body.action === "sell" ? (m?.bids ?? []) : (m?.offers ?? [])) ?? [];
        const fills: Array<{ price: string; filled: string }> = [];
        let left = V.fillMode === "none" ? 0 : V.fillMode === "partial" ? Math.max(0, want - 2) : want;
        for (const l of levels) {
          if (left <= 0) break;
          const ok = body.action === "sell" ? Number(l.price) >= Number(body.price) : Number(l.price) <= Number(body.price);
          if (!ok) continue;
          const q = Math.min(left, Number(l.quantity));
          fills.push({ price: l.price, filled: String(q) });
          left -= q;
        }
        const filled = fills.reduce((s, f) => s + Number(f.filled), 0);
        const o = { id, status: filled >= want ? "filled" : "open", action: String(body.action), market_id: String(body.market_id), order_type: "limit", price: String(body.price), quantity: String(want), filled: String(filled), avg_price: filled > 0 ? (fills.reduce((s, f) => s + Number(f.filled) * Number(f.price), 0) / filled).toFixed(4) : null, client_order_id: String(body.client_order_id), fills };
        orders.set(id, o);
        // the position shrinks or grows at the venue as the fills land
        const pos = V.positions.find((p) => p.market_id === body.market_id);
        if (pos) pos.position = (Number(pos.position) + (body.action === "sell" ? -filled : filled)).toFixed(2);
        const moved = fills.reduce((s, f) => s + Number(f.filled) * Number(f.price), 0);
        V.balance = (Number(V.balance) + (body.action === "sell" ? moved : -moved)).toFixed(2);
        const { fills: _f, ...pub } = o;
        return json(res, 201, { order: pub });
      }
      const one = /^\/api\/v1\/orders\/([^/]+)$/.exec(url.pathname);
      if (one && req.method === "GET") {
        const o = orders.get(decodeURIComponent(one[1]));
        if (!o) return json(res, 404, { error: "not found" });
        const { fills: _f, ...pub } = o;
        return json(res, 200, { order: pub });
      }
      if (one && req.method === "DELETE") {
        const o = orders.get(decodeURIComponent(one[1]));
        if (!o) return json(res, 404, { error: "not found" });
        o.status = Number(o.filled) > 0 ? "partially_cancelled" : "cancelled";
        return json(res, 200, { order_id: o.id, status: o.status });
      }
      if (url.pathname === "/api/v1/fills") {
        const ids = (url.searchParams.get("order_ids") ?? "").split(",");
        const fills = ids.flatMap((id) => (orders.get(id)?.fills ?? []).map((f, i) => ({ trade_id: `${id}-t${i}`, order_id: id, action: orders.get(id)?.action, price: f.price, filled: f.filled, trade_fee: "0.00", time: new Date().toISOString() })));
        return json(res, 200, { fills });
      }
      if (url.pathname === "/api/v1/portfolio/settlements") return json(res, 200, { settlements: [] });
      // THE COMBO QUOTE PATH, as assumed (memberApp.ts, RawMemberRfq): a bid asked on a size, priced at once or on the
      // next read, for at most what the makers take; accepted, the fill posts as a regular order, so the ticket shrinks
      // in the positions read and the balance moves, like any sale
      if (url.pathname === "/api/v1/rfqs" && req.method === "POST") {
        if (V.rfqMode === "off") return json(res, 404, { error: "not found" });
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        V.rfqs.push(body);
        const id = `rfq-${++seq}`;
        const want = Number(body.quantity);
        const take = V.rfqTake === null ? want : Math.min(want, V.rfqTake);
        const q: RawMemberRfq & { pending: boolean } =
          V.rfqMode === "decline"
            ? { id, status: "declined", market_id: String(body.market_id), action: "sell", quantity: null, price: null, client_rfq_id: String(body.client_rfq_id), rejection_reason: "no maker", pending: false }
            : { id, status: V.rfqMode === "pending" ? "pending" : "quoted", market_id: String(body.market_id), action: "sell", quantity: V.rfqMode === "pending" ? null : String(take), price: V.rfqMode === "pending" ? null : V.rfqPrice, expires_at: new Date(Date.now() + V.rfqLifeMs).toISOString(), client_rfq_id: String(body.client_rfq_id), pending: V.rfqMode === "pending" };
        rfqs.set(id, q);
        const { pending: _p, ...pub } = q;
        return json(res, 201, { rfq: pub });
      }
      const rfqOne = /^\/api\/v1\/rfqs\/([^/]+)$/.exec(url.pathname);
      if (rfqOne && req.method === "GET") {
        const q = rfqs.get(decodeURIComponent(rfqOne[1]));
        if (!q) return json(res, 404, { error: "not found" });
        if (q.pending) {
          // priced on the read after the request
          const want = Number(V.rfqs.at(-1)?.quantity);
          Object.assign(q, { pending: false, status: "quoted", price: V.rfqPrice, quantity: String(V.rfqTake === null ? want : Math.min(want, V.rfqTake)) });
        }
        const { pending: _p, ...pub } = q;
        return json(res, 200, { rfq: pub });
      }
      const rfqAccept = /^\/api\/v1\/rfqs\/([^/]+)\/accept$/.exec(url.pathname);
      if (rfqAccept && req.method === "POST") {
        const q = rfqs.get(decodeURIComponent(rfqAccept[1]));
        if (!q) return json(res, 404, { error: "not found" });
        const body = JSON.parse(await readBody(req)) as { quantity: string; price: string };
        if (V.acceptMode === "expired" || q.status !== "quoted" || Date.parse(q.expires_at ?? "") <= Date.now()) return json(res, 410, { error: "rfq expired" });
        if (Number(body.quantity) > Number(q.quantity) || body.price !== q.price) return json(res, 400, { error: "accept does not match the quote" });
        q.status = "accepted";
        const id = `ord-${++seq}`;
        const filled = Number(body.quantity);
        const o = { id, status: "filled", action: "sell", market_id: String(q.market_id), order_type: "rfq", price: q.price ?? "", quantity: String(filled), filled: String(filled), avg_price: q.price, client_order_id: q.client_rfq_id ?? null, fills: [{ price: q.price ?? "", filled: String(filled) }] };
        orders.set(id, o);
        const pos = V.positions.find((p) => p.market_id === q.market_id);
        if (pos) pos.position = (Number(pos.position) - filled).toFixed(2);
        V.balance = (Number(V.balance) + filled * Number(q.price)).toFixed(2);
        const { fills: _f, ...pub } = o;
        return json(res, 201, { order: pub });
      }
      return json(res, 404, { error: "not found" });
    })().catch((err: unknown) => json(res, 500, { error: String(err) }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  V.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  V.close = () => server.close();
  return V;
}

// ---------------------------------------------------------------------------
// units
// ---------------------------------------------------------------------------

test("member app: the token key reads hex or base64 and refuses the rest; the config needs host, id, secret and key and never notes a value; the authorize URL carries PKCE S256 and the exact redirect", () => {
  assert.equal(tokenKeyFrom(KEY_HEX)?.length, 32);
  assert.equal(tokenKeyFrom(Buffer.from(KEY_HEX, "hex").toString("base64"))?.length, 32);
  assert.equal(tokenKeyFrom("short"), null);
  assert.equal(tokenKeyFrom(undefined), null);
  const dflt = { redirectUri: "https://svc/api/shadow/member/callback", storePath: "/tmp/x.json" };
  assert.deepEqual(memberAppConfigFromEnv({}, dflt), { config: null, notes: [] }, "nothing set: off, silently");
  const partial = memberAppConfigFromEnv({ MEMBER_APP_HOST: "https://demo.stxapp.io", MEMBER_APP_CLIENT_ID: "cid" }, dflt);
  assert.equal(partial.config, null);
  assert.match(partial.notes[0], /MEMBER_APP_CLIENT_SECRET unset; off/);
  const noKey = memberAppConfigFromEnv({ MEMBER_APP_HOST: "https://demo.stxapp.io", MEMBER_APP_CLIENT_ID: "cid", MEMBER_APP_CLIENT_SECRET: "sec" }, dflt);
  assert.equal(noKey.config, null);
  assert.match(noKey.notes[0], /MEMBER_APP_TOKEN_KEY must be 32 bytes/);
  assert.ok(!noKey.notes.join(" ").includes("sec"), "notes never carry a value");
  const full = memberAppConfigFromEnv({ MEMBER_APP_HOST: "https://demo.stxapp.io/", MEMBER_APP_CLIENT_ID: "cid", MEMBER_APP_CLIENT_SECRET: "sec", MEMBER_APP_TOKEN_KEY: KEY_HEX, REFERENCE_BOOK_OUTCOME_COMPETITIONS: "nba=NBA" }, dflt);
  assert.ok(full.config);
  assert.deepEqual([full.config.host, full.config.redirectUri, full.config.storePath, full.config.scopes], ["https://demo.stxapp.io", dflt.redirectUri, dflt.storePath, "profile.read balance.read portfolio.read orders.read orders.write"]);
  assert.deepEqual(full.config.competitionCodes, { nba: "NBA" });
  const { verifier, challenge } = pkcePair();
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  assert.equal(challenge, createHash("sha256").update(verifier, "ascii").digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
  const u = new URL(authorizeUrl(full.config, { state: "st-1", challenge }));
  assert.equal(`${u.origin}${u.pathname}`, "https://demo.stxapp.io/oauth/authorize");
  assert.deepEqual(
    ["response_type", "client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method"].map((k) => u.searchParams.get(k)),
    ["code", "cid", dflt.redirectUri, "profile.read balance.read portfolio.read orders.read orders.write", "st-1", challenge, "S256"],
  );
});

test("member token store: sealed per member under the key, bound to the member, a tampered entry reads as absent, a wrong key reads as absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "member-store-"));
  const path = join(dir, "tokens.json");
  const key = tokenKeyFrom(KEY_HEX) as Buffer;
  const store = new MemberTokenStore(path, key);
  const grant = { accessToken: "stxapp_at_abc", refreshToken: "stxapp_rt_def", expiresAtMs: 1_800_000_000_000, scope: "orders.read", connectedAtIso: "2026-11-03T12:00:00.000Z", userId: "u1", accountId: "a1" };
  store.set("ann", grant);
  assert.deepEqual(new MemberTokenStore(path, key).get("ann"), grant, "a second store on the same file reads the grant back");
  const raw = readFileSync(path, "utf8");
  assert.ok(!raw.includes("stxapp_at_abc") && !raw.includes("stxapp_rt_def"), "the file never carries a token in the clear");
  assert.equal(new MemberTokenStore(path, Buffer.alloc(32, 7)).get("ann"), null, "another key opens nothing");
  // an entry moved under another member does not open: the member is the additional data
  const file = JSON.parse(raw) as { members: Record<string, unknown> };
  file.members.bob = file.members.ann;
  writeFileSync(path, JSON.stringify(file));
  const moved = new MemberTokenStore(path, key);
  assert.equal(moved.get("bob"), null);
  assert.deepEqual(moved.get("ann"), grant);
  assert.deepEqual(moved.members(), ["ann"]);
  assert.equal(moved.delete("ann"), true);
  assert.equal(moved.get("ann"), null);
});

test("member sale arithmetic: the tiers sell 40/60/80% of the position into the bids, cash floored, the cap adds $1 on every riding contract; a thin book is depth-limited; the buy-back rounds up and stays under max_price; the tails say the sold contracts stay sold", () => {
  const bids = [
    { price: 0.54, quantity: 25 },
    { price: 0.53, quantity: 40 },
  ];
  const t = quoteSaleTiers({ positionContracts: 50, maxPrice: 1, bids });
  assert.deepEqual(
    [t.wide, t.balanced, t.tight].map((q) => q && [q.soldContracts, q.keptContracts, q.limitPriceCents, q.avgPriceCents, q.cashNowCents, q.floorTotalCents, q.capTotalCents, q.depthLimited]),
    [
      [20, 30, 54, 54, 1080, 1080, 4080, false],
      [30, 20, 53, 53, 1615, 1615, 3615, false],
      [40, 10, 53, 53, 2145, 2145, 3145, false],
    ],
  );
  // a book of 25 funds the wide tier whole and the others as far as it goes
  const thin = quoteSaleTiers({ positionContracts: 50, maxPrice: 1, bids: bids.slice(0, 1) });
  assert.deepEqual([thin.balanced?.soldContracts, thin.balanced?.depthLimited, thin.tight?.soldContracts], [25, true, 25]);
  assert.deepEqual(quoteSaleTiers({ positionContracts: 50, maxPrice: 1, bids: [] }), { wide: null, balanced: null, tight: null });
  // a $2 contract: the venue's own units in, so 10 venue contracts at $1.08 are $10.80 of cash
  const two = quoteSaleTiers({ positionContracts: 25, maxPrice: 2, bids: [{ price: 1.08, quantity: 100 }] });
  assert.deepEqual([two.wide?.soldContracts, two.wide?.cashNowCents, two.wide?.capTotalCents], [10, 1080, 1080 + 15 * 200]);
  assert.equal(walkLevels([], 5), null);
  const bb = quoteBuyBack(
    [
      { price: 0.56, quantity: 10 },
      { price: 0.571, quantity: 100 },
    ],
    30,
    1,
  );
  assert.deepEqual(bb && [bb.wantContracts, bb.contracts, bb.limitPriceCents, bb.avgPriceCents, bb.costCents, bb.depthLimited], [30, 30, 58, 57, 1702, false]);
  assert.equal(quoteBuyBack([{ price: 0.995, quantity: 100 }], 5, 1)?.limitPriceCents, 99, "the limit never reaches max_price");
  assert.equal(saleEvCostBps({ soldContracts: 30, cashNowCents: 1615 }, 50, 1, 55), Math.round(((30 * 55 - 1615) * 10_000) / (50 * 55)));
  const tails = memberTailTerms("STX", rulesFor("stx", "nba"), 20);
  assert.deepEqual(
    tails.map((x) => x.branch),
    ["tie", "postponed", "abandoned", "corrected"],
  );
  for (const x of tails) assert.ok(x.text.includes("your 20 riding contracts") && x.text.endsWith("The contracts you sold stay sold."), x.text);
});

test("member positions: longs on full-game winner markets map to our market by league, club and date; shorts and other markets are left out; a $2 contract is two of ours; the entry is the average open premium", async () => {
  const codes = { nba: "NBA" };
  assert.equal(leagueOfCompetition("NBA", codes), "nba");
  assert.equal(leagueOfCompetition("nfl", {}), "nfl", "a code that is a league we know stands on its own");
  assert.equal(leagueOfCompetition("EPL", {}), null);
  const protectable = [
    { ticker: TICKER, league: "nba", sideName: "Boston Celtics", title: "Winner?", dateIso: "2026-10-14" },
    { ticker: "KXNBAGAME-26OCT14LALBOS-LAL", league: "nba", sideName: "Los Angeles Lakers", title: "Winner?", dateIso: "2026-10-14" },
  ];
  const m = market("m-bos", "Boston Celtics", "Los Angeles Lakers", "2026-10-14T23:30:00Z", [["0.54", "25"]], [["0.56", "100"]]);
  assert.deepEqual(matchMemberMarket(m, "nba", protectable), { ticker: TICKER });
  assert.deepEqual(matchMemberMarket({ ...m, rules: "total_over" }, "nba", protectable), { ticker: null, reason: "market_not_covered" });
  assert.deepEqual(matchMemberMarket(m, null, protectable), { ticker: null, reason: "league_not_covered" });
  const away = { ...m, market_id: "m-lal", rules: "away_winner" };
  assert.deepEqual(matchMemberMarket(away, "nba", protectable), { ticker: "KXNBAGAME-26OCT14LALBOS-LAL" });
  const two = market("m-two", "Boston Celtics", "Los Angeles Lakers", "2026-10-14T23:30:00Z", [["1.08", "100"]], [["1.12", "100"]], "2.00");
  const client = new MemberClient({
    host: "http://fake",
    token: async () => "t",
    fetchImpl: (async (input: string | URL | Request) => {
      const u = String(input);
      if (u.endsWith("/api/v1/positions")) return new Response(JSON.stringify({ positions: [{ market_id: "m-bos", position: "50.00", average_open_premium: "0.42" }, { market_id: "m-lal", position: "-5.00", average_open_premium: "0.60" }, { market_id: "m-two", position: "10.00", average_open_premium: "0.90" }] }));
      if (u.includes("/api/v1/markets")) return new Response(JSON.stringify({ markets: [m, away, two] }));
      return new Response("{}", { status: 404 });
    }) as typeof fetch,
  });
  const rows = await memberHolderPositions(client, protectable, codes);
  assert.deepEqual(
    rows.map((r) => [r.marketId, r.ticker, r.contracts, r.entryCents, r.payoutCents, r.costCents, r.league, r.side, r.event, r.maxPrice]),
    [
      ["m-bos", TICKER, 50, 42, 5000, 2100, "nba", "Boston Celtics", "Los Angeles Lakers at Boston Celtics", 1],
      // ten $2 contracts are twenty of ours; 90c of $2 is 45c of $1
      ["m-two", TICKER, 20, 45, 2000, 900, "nba", "Boston Celtics", "Los Angeles Lakers at Boston Celtics", 2],
    ],
  );
  assert.ok(rows[0].market, "the market read with the positions rides along for the sale's book");

  // a combination as the venue sends it (the demo account's 4-leg, trimmed): no legs, the picks in words
  const combo: RawOutcomeMarket = {
    market_id: "f12ab7b4", position: "Won / Won / Won / Won", grouping_name: "Combo", symbol: "STXCOMBO-E09F1490A68-FFBD3361B3B", price: "0.1055", result: "pending", max_price: "1.0000", group_title: "Combo", rules: "combo_rule",
    event_title: "4-Leg Combo", event_start: "2026-11-08T21:05:00.000000Z", question: "Broncos, Hawks, Texans, Falcons", description: "A combination settling into its ceiling only if every leg lands: Broncos Won, Hawks Won, Texans Won, Falcons Won.",
    event_type: "combo", competition: "Combo", event_status: "in_progress", specifier: "WON|WON|WON|WON", status: "open", sport: "Combo", offers: [], bids: [], participants: [],
    recent_trades: [{ timestamp: "2026-11-04T04:19:17.999535Z", quantity: "9.00", price: "0.1055" }],
  };
  assert.equal(isComboMarket(combo), true);
  assert.deepEqual(comboPickWords(combo), ["Broncos", "Hawks", "Texans", "Falcons"]);
  assert.deepEqual(comboPickWords({ ...combo, question: "Will the Broncos win?" }), ["Broncos", "Hawks", "Texans", "Falcons"], "a question that is a question: the description names the legs");
  assert.deepEqual(comboPickWords({ ...combo, question: null, description: null }), ["Leg 1", "Leg 2", "Leg 3", "Leg 4"], "the specifier still counts them");
  const nfl = (id: string, home: string, away: string, start: string, rules: "home_winner" | "away_winner", status = "scheduled"): RawOutcomeMarket => ({
    ...market(id, home, away, start, [], []), rules, competition: "NFL", event_status: status,
    participants: [{ name: home, role: "home", short_name: home.split(" ").pop() }, { name: away, role: "away", short_name: away.split(" ").pop() }],
  });
  const listings = [
    nfl("den-1", "Carolina Panthers", "Denver Broncos", "2026-11-08T18:00:00Z", "away_winner"),
    nfl("den-2", "Denver Broncos", "Las Vegas Raiders", "2026-11-15T21:25:00Z", "home_winner"), // the week after: not the ticket's game
    nfl("den-0", "Denver Broncos", "Houston Texans", "2026-11-01T21:25:00Z", "home_winner"), // before the buy: not the ticket's game
    { ...nfl("atl-1", "Washington Wizards", "Atlanta Hawks", "2026-11-05T00:00:00Z", "away_winner", "in_progress"), competition: "NBA" },
    nfl("hou-1", "Jacksonville Jaguars", "Houston Texans", "2026-11-08T18:00:00Z", "home_winner"), // the Texans are the away side; the home winner is the Jaguars' market
    nfl("hou-2", "Jacksonville Jaguars", "Houston Texans", "2026-11-08T18:00:00Z", "away_winner"),
  ];
  const at = Date.parse("2026-11-05T01:00:00Z");
  assert.equal(legMarketFor("Broncos", combo, listings, at)?.market_id, "den-1", "the club's first game after the buy and before the ticket's last leg");
  assert.equal(legMarketFor("Hawks", combo, listings, at)?.market_id, "atl-1");
  assert.equal(legMarketFor("Texans", combo, listings, at)?.market_id, "hou-2", "the market on the pick's own side");
  assert.equal(legMarketFor("Falcons", combo, listings, at), null, "no game listed: the pick stays a word");
  const legs = await comboLegs(client, combo, new Map(), async () => listings);
  assert.deepEqual(
    legs.map((l) => [l.marketId, l.side, l.event, l.state]),
    [["den-1", "Denver Broncos", "Denver Broncos at Carolina Panthers", "pending"], ["atl-1", "Atlanta Hawks", "Atlanta Hawks at Washington Wizards", "live"], ["hou-2", "Houston Texans", "Houston Texans at Jacksonville Jaguars", "pending"], [null, "Falcons", "", "pending"]],
  );
  assert.deepEqual((await comboLegs(client, combo, new Map())).map((l) => [l.marketId, l.side, l.state]), [[null, "Broncos", "pending"], [null, "Hawks", "pending"], [null, "Texans", "pending"], [null, "Falcons", "pending"]], "no listings: the words alone");
  assert.deepEqual(legs.map((l) => l.priceCents), [null, null, null, null], "the fixture's markets carry no price");

  // the placements are remembered: once a leg's game has been played it leaves the open listing, and the leg is
  // read again by id for its result (the settlement price when the result word is not one we know)
  const memDir = mkdtempSync(join(tmpdir(), "combo-legs-"));
  const memPath = join(memDir, "member-combo-legs.json");
  const priced = listings.map((l) => (l.market_id === "den-1" ? { ...l, last_traded_price: "0.6100" } : l));
  const byId = new Map(priced.map((l) => [l.market_id, l]));
  const idReads: string[][] = [];
  const idClient = { markets: async (ids: string[]) => { idReads.push(ids); return ids.map((id) => byId.get(id)).filter((x): x is RawOutcomeMarket => Boolean(x)); } } as unknown as MemberClient;
  const first = await comboLegs(idClient, combo, new Map(), async () => priced, new ComboLegMemory(memPath));
  assert.deepEqual(first.map((l) => [l.marketId, l.priceCents]), [["den-1", 61], ["atl-1", null], ["hou-2", null], [null, null]], "the leg's price rides along");
  assert.deepEqual(JSON.parse(readFileSync(memPath, "utf8")).combos[combo.market_id], { Broncos: "den-1", Hawks: "atl-1", Texans: "hou-2" }, "placements on disk, by combination then pick");
  // the games are played: the Broncos won (the venue's word), the Hawks lost (settled at zero, no word we know), the Texans are still open
  byId.set("den-1", { ...byId.get("den-1")!, status: "settled", event_status: "completed", result: "won", last_traded_price: "1.0000" });
  byId.set("atl-1", { ...byId.get("atl-1")!, status: "settled", event_status: "completed", result: "resolved", settled_at: "2026-11-05T03:00:00Z", price: "0.0000", last_traded_price: "0.0000" });
  idReads.length = 0;
  const second = await comboLegs(idClient, combo, new Map(), async () => [byId.get("hou-2")!], new ComboLegMemory(memPath));
  assert.deepEqual(idReads, [["den-1", "atl-1", "hou-2"]], "a fresh memory re-reads every placed leg by id");
  assert.deepEqual(second.map((l) => [l.marketId, l.state, l.priceCents]), [["den-1", "won", null], ["atl-1", "lost", null], ["hou-2", "pending", null], [null, "pending", null]]);
});

test("member sale on the ledger: settlement pays the sale's own totals, the writer owes and takes nothing, cashDue is empty, a buy-back close carries its facts", () => {
  const dir = mkdtempSync(join(tmpdir(), "member-ledger-"));
  const path = join(dir, "ledger.jsonl");
  const sale = { marketId: "m-bos", maxPriceCents: 100, soldContracts: 30, keptContracts: 20, limitPriceCents: 53, avgPriceCents: 53, cashNowCents: 1615, floorTotalCents: 1615, capTotalCents: 3615, orderId: "ord-1", clientOrderId: "atticus-lock-x", status: "filled", requestedContracts: 30 };
  const open = { type: "open" as const, at: "2026-11-03T12:00:00.000Z", ticker: TICKER, kind: "sports" as const, league: "nba", sideName: "Boston Celtics", eventTitle: "Lakers at Celtics", eventTimeIso: START, contracts: 50, markCents: 55, floorCents: 32, capCents: 72, creditCents: 0, evCostBps: 0, route: "member_sale" as const, feesCents: 0, takeCents: 0, hedgeCostCents: 0, hedgeUnitsMilli: 0, tier: "balanced" as const, holderVenue: "stx" as const, source: "lock" as const, entryCents: 42, memberSale: sale };
  assert.deepEqual(settlePayouts(open, "yes"), { protectedCents: 3615, nakedCents: 5000, deltaCents: -1385 });
  assert.deepEqual(settlePayouts(open, "no"), { protectedCents: 1615, nakedCents: 0, deltaCents: 1615 });
  assert.deepEqual(writerPayouts(open, "yes"), writerPayouts(open, "no"));
  assert.equal(Object.values(writerPayouts(open, "yes")).every((v) => v === 0), true, "nothing moves on the writer's book");
  appendShadowRecord(path, open);
  appendShadowRecord(path, { type: "settle", at: "2026-11-04T04:00:00.000Z", ticker: TICKER, result: "yes" });
  const [p] = loadShadowPositions(path);
  assert.deepEqual([p.status, p.protectedCents, p.nakedCents, p.route], ["settled", 3615, 5000, "member_sale"]);
  assert.deepEqual(cashDue(p), [], "no leg is owed between the parties: the venue paid the member");
  const path2 = join(dir, "ledger2.jsonl");
  appendShadowRecord(path2, open);
  appendShadowRecord(path2, { type: "close", at: "2026-11-03T13:00:00.000Z", ticker: TICKER, priced: true, source: "unwind", hedgeSent: false, yesMidCents: 55, yesFillCents: 56, positionProceedsCents: 0, hedgeProceedsCents: 0, feesCents: 0, protectedAtCloseCents: -65, protectedAtMidCents: -35, unwindFrictionCents: 30, memberBuyBack: { requestedContracts: 30, boughtContracts: 30, limitPriceCents: 56, avgPriceCents: 56, costCents: 1680, orderId: "ord-2", clientOrderId: "atticus-leave-x", status: "filled" } });
  const [c] = loadShadowPositions(path2);
  assert.deepEqual([c.status, c.protectedCents, c.nakedCents, c.closeMemberBuyBack?.boughtContracts, c.closeMemberBuyBack?.costCents], ["closed", -65, 0, 30, 1680]);
  assert.deepEqual(cashDue(c), []);
});

// ---------------------------------------------------------------------------
// the worker's routes against the fake venue
// ---------------------------------------------------------------------------

function routingFor(quote: Extract<CrossQuoteResult, { ok: true }>): HedgeRouting {
  return chooseRoute({
    holderVenue: "stx",
    league: "nba",
    holderRules: tableRules("stx", "nba"),
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

function candidate(ticker: string, contracts: number, entryCents: number): CandidateResult {
  const quote: CrossQuoteResult = quoteLadderWrap({ pair: { kalshi: { ticker }, gameStartTime: START }, markCents: 60, entryCents, contracts, now: new Date(), noAsks: NO_ASKS, config: DEFAULT_CROSS_CONFIG });
  assert.ok(quote.ok, JSON.stringify(quote));
  return {
    kind: "sports",
    league: "nba",
    market: { ticker, eventTicker: ticker.slice(0, ticker.lastIndexOf("-")), title: "Winner?", subtitle: "", strike: 0, strikeType: "", status: "active", openTime: "", closeTime: START, yesBidCents: 59, yesAskCents: 61, lastPriceCents: 60, volume: 1000, openInterest: 1000, rulesPrimary: "The market resolves Yes if the home club wins." },
    pair: null,
    sideName: "Boston Celtics",
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
    routing: routingFor(quote),
  };
}

test("shadow worker member routes: connect through the venue's OAuth, read the member's positions, quote the sale tiers with the comparison beside them, lock as the member's own sell (full, partial, none), receipt and public record, leave early as a buy-back, disconnect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-member-"));
  const ledger = join(dir, "lock-ledger.jsonl");
  process.env.NODE_ENV = "test";
  process.env.EVENT_SHADOW_LEDGER_PATH = join(dir, "ledger.jsonl");
  process.env.EVENT_SHADOW_LOCK_LEDGER_PATH = ledger;
  process.env.EVENT_LASTLEG_LEDGER_PATH = join(dir, "lastleg.jsonl");
  process.env.EVENT_HEDGE_RECEIPTS_PATH = join(dir, "hedge-receipts.jsonl");
  process.env.EVENT_X_ADMIN_TOKEN = "op-secret";
  process.env.EVENT_SHADOW_LOCK_KEY = "lock-key-0123456789";
  // a combo record settles as soon as its last leg has started, so the combo block below can read the venue's word; every other record here is hours out
  process.env.EVENT_SHADOW_SETTLE_GRACE_MS = "0";
  delete process.env.MEMBER_APP_HOST;
  process.env.MEMBER_APP_VENUE_URL = "https://demo.venue.test/";
  process.env.MEMBER_APP_HOSTNAME = "https://stx.lockin.test/";
  const worker = await import("../scripts/eventShadowWorker");
  const venue = await fakeVenue();
  venue.markets["m-bos"] = market("m-bos", "Boston Celtics", "Los Angeles Lakers", START, [["0.54", "25"], ["0.53", "40"]], [["0.56", "100"]]);
  venue.markets["m-mia"] = market("m-mia", "Miami Heat", "New York Knicks", START, [["0.61", "100"]], [["0.63", "100"]]);
  venue.markets["m-det"] = market("m-det", "Detroit Pistons", "Chicago Bulls", START, [["0.48", "100"]], [["0.50", "100"]]);
  venue.markets["m-den"] = market("m-den", "Denver Nuggets", "Phoenix Suns", START_SOON, [["0.70", "100"]], [["0.72", "100"]]);
  // listed on the venue, protectable here, not held by the member: the Games tab's "Buy on STX" row
  venue.markets["m-sac"] = market("m-sac", "Sacramento Kings", "Golden State Warriors", START, [["0.45", "60"]], [["0.47", "60"]]);
  // a combo (parlay): a multi-leg market the member holds; shown, never protected
  venue.markets["m-combo"] = { ...market("m-combo", "", "", START, [], []), rules: "combo", event_title: "", symbol: "BOS / MIA / DET combo", participants: [], legs: [{ market_id: "m-bos" }, { market_id: "m-mia" }, { market_id: "m-det" }] } as RawOutcomeMarket;
  // a combo as the venue really sends it (read off the demo account): no leg list, the picks as words in the
  // question and description, the specifier counting them, its own start set to the last leg's; one pick
  // (the Suns) is a club the venue does not list a game for in the window, so it stays a word
  venue.markets["m-combo-wire"] = {
    ...market("m-combo-wire", "", "", START_SOON, [], []), rules: "combo_rule", event_type: "combo", competition: "Combo", sport: "Combo", event_title: "3-Leg Combo", group_title: "Combo", symbol: "STXCOMBO-AAA-BBB",
    question: "Celtics, Kings, Suns", description: "A combination settling into its ceiling only if every leg lands: Celtics Won, Kings Won, Suns Won.", specifier: "WON|WON|WON", result: "pending", event_status: "in_progress", participants: [],
    recent_trades: [{ timestamp: new Date(Date.now() - 3_600_000).toISOString(), price: "0.1055", quantity: "9.00" }],
  } as RawOutcomeMarket;
  // the venue writes a long's premium negative (cash out); the size is the entry
  venue.positions = [
    { market_id: "m-bos", position: "50.00", average_open_premium: "-0.42" },
    { market_id: "m-mia", position: "40.00", average_open_premium: "0.55" },
    { market_id: "m-det", position: "10.00", average_open_premium: "-0.45" },
    { market_id: "m-den", position: "10.00", average_open_premium: "0.65" },
    { market_id: "m-combo", position: "5.00", average_open_premium: "0.20" },
    { market_id: "m-combo-wire", position: "9.00", average_open_premium: "-0.1100", premium: "-0.9495", multiplier: 9.47 },
  ];
  const { config } = memberAppConfigFromEnv(
    { MEMBER_APP_HOST: venue.base, MEMBER_APP_CLIENT_ID: "cid", MEMBER_APP_CLIENT_SECRET: "sec", MEMBER_APP_TOKEN_KEY: KEY_HEX, MEMBER_APP_TOKENS_PATH: join(dir, "member-tokens.json"), REFERENCE_BOOK_OUTCOME_COMPETITIONS: "nba=NBA" },
    { redirectUri: "http://127.0.0.1/cb", storePath: join(dir, "unused.json") },
  );
  assert.ok(config);
  const sessions = new MemberSessions(config);
  const row = (ticker: string, sideName: string, startIso: string): GameMarketRow => ({ ticker, league: "nba", sideName, title: "Winner?", dateIso: startIso.slice(0, 10), closeTimeIso: startIso, markCents: 60, startIso, protectable: true, protectableUntilIso: startIso });
  const markets: GameMarketRow[] = [row(TICKER, "Boston Celtics", START), row(TICKER2, "Miami Heat", START), row(TICKER3, "Detroit Pistons", START), row(SOON, "Denver Nuggets", START_SOON), row("KXNBAGAME-26OCT14GSWSAC-SAC", "Sacramento Kings", START)];
  const seen: OneQuoteInputs[] = [];
  worker.wireLockEngine({
    listGameMarkets: async () => markets,
    quoteOne: async (inputs: OneQuoteInputs): Promise<OneQuoteResult> => {
      seen.push(inputs);
      return { ok: true, result: candidate(inputs.ticker, inputs.contracts, inputs.entryCents ?? 60) };
    },
    venueClient: null,
    memberSessions: sessions,
    memberOrder: { waitMs: 60, pollMs: 5 },
    memberInPlay: false, // pre-game only for the first checks; the in-play block turns it on (the service's own default)
  });
  await new Promise<void>((r) => worker.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
  const key = { "x-lock-key": "lock-key-0123456789" };
  const get = async <T,>(path: string, headers: Record<string, string> = key) => {
    const r = await fetch(`${base}${path}`, { headers });
    return { status: r.status, body: (await r.json()) as T };
  };
  const post = async <T,>(path: string, body: unknown) => {
    const r = await fetch(`${base}${path}`, { method: "POST", headers: { ...key, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as T };
  };
  type Any = Record<string, any>;
  try {
    // not connected yet: the member block says so on the member route and on positions (which has nothing to read)
    let m = await get<Any>("/api/shadow/member");
    assert.deepEqual([m.status, m.body.member.venue, m.body.member.venueName, m.body.member.configured, m.body.member.connected, m.body.member.reason], [200, "stx", "STX", true, false, "not_connected"]);
    let pos = await get<Any>("/api/shadow/positions");
    assert.deepEqual([pos.body.configured, pos.body.positions, pos.body.member.connected], [false, [], false]);
    const acct0 = await get<Any>("/api/shadow/member/account");
    assert.deepEqual([acct0.status, acct0.body.code], [409, "member_not_connected"]);
    const games0 = await get<Any>("/api/shadow/member/games");
    assert.equal(games0.status, 409);
    // a quote before connecting is refused in words
    let q = await get<Any>(`/api/shadow/quote?ticker=${TICKER}&contracts=50&venue=stx`);
    assert.deepEqual([q.status, q.body.code, q.body.message], [409, "member_not_connected", "Connect your STX account first."]);

    // connect: the service builds the authorize URL; the browser comes back to the callback with the code
    const c = await get<Any>("/api/shadow/member/connect");
    assert.equal(c.status, 200);
    const au = new URL(c.body.url);
    assert.equal(`${au.origin}${au.pathname}`, `${venue.base}/oauth/authorize`);
    assert.equal(au.searchParams.get("code_challenge_method"), "S256");
    assert.equal(au.searchParams.get("redirect_uri"), "http://127.0.0.1/cb");
    const bad = await fetch(`${base}/api/shadow/member/callback?code=whatever&state=not-ours`);
    assert.equal(bad.status, 400, "a state the service did not issue connects nothing");
    assert.match(await bad.text(), /Not connected/);
    const { code, state } = venue.issueCode(c.body.url);
    const cb = await fetch(`${base}/api/shadow/member/callback?code=${code}&state=${state}`);
    assert.equal(cb.status, 200, "keyless: the browser arrives from the venue");
    const cbHtml = await cb.text();
    assert.match(cbHtml, /Your STX account is connected/);
    assert.ok(!cbHtml.includes("stxapp_"), "the page carries nothing of the grant");
    const again = await fetch(`${base}/api/shadow/member/callback?code=${code}&state=${state}`);
    assert.equal(again.status, 400, "the state is one-time");
    m = await get<Any>("/api/shadow/member");
    assert.deepEqual([m.body.member.connected, m.body.member.userId, m.body.member.accountId, m.body.member.scope], [true, "u1", "a1", "profile.read balance.read portfolio.read orders.read orders.write"]);
    assert.deepEqual([m.body.member.handle, m.body.member.avatarUrl], ["celtics_fan", `${venue.base}/avatars/u1.png`], "the handle and avatar the venue shows them under; a relative avatar is made absolute on the venue");
    assert.equal(venue.tokensIssued, 1);

    // the account line: the handle and the balance the sale lands in, cents; the balance is kept ten seconds unless asked fresh
    let acct = await get<Any>("/api/shadow/member/account");
    assert.equal(acct.status, 200, JSON.stringify(acct.body));
    assert.deepEqual([acct.body.profile.handle, acct.body.balance.accountCents, acct.body.balance.availableCents, acct.body.balanceScope], ["celtics_fan", 25000, 25000, true]);
    acct = await get<Any>("/api/shadow/member/account");
    assert.equal(venue.balanceReads, 1, "cached");
    acct = await get<Any>("/api/shadow/member/account?fresh=1");
    assert.equal(venue.balanceReads, 2);

    // positions: the member's longs on our markets, each carrying its venue, none locked yet
    pos = await get<Any>("/api/shadow/positions");
    assert.equal(pos.body.configured, true);
    assert.deepEqual(
      pos.body.positions.map((p: Any) => [p.ticker, p.venue, p.contracts, p.entryCents, p.lock]),
      [
        [TICKER, "stx", 50, 42, null],
        [TICKER2, "stx", 40, 55, null],
        [TICKER3, "stx", 10, 45, null],
        [SOON, "stx", 10, 65, null],
        // the parlays are on the list too, so the page mirrors the account; each says why it has no Lock in line
        [null, "stx", 5, 20, null],
        [null, "stx", 9, 11, null],
      ],
      "a negative premium is the entry's size",
    );
    assert.deepEqual(pos.body.positions.map((p: Any) => p.costCents), [2100, 2200, 450, 650, 100, 99], "cost is what was paid, never negative");
    assert.deepEqual([pos.body.positions[4].reason, pos.body.positions[4].event, typeof pos.body.cutoffMinutes], ["parlay", "BOS / MIA / DET combo", "number"]);
    // the combo's legs, as the page lists them: each leg's club (read from the leg's market), its game and where it stands
    assert.deepEqual(
      pos.body.positions[4].legs.map((l: Any) => [l.marketId, l.side, l.event, l.startsIso, l.state]),
      [["m-bos", "Boston Celtics", "Los Angeles Lakers at Boston Celtics", START, "pending"], ["m-mia", "Miami Heat", "New York Knicks at Miami Heat", START, "pending"], ["m-det", "Detroit Pistons", "Chicago Bulls at Detroit Pistons", START, "pending"]],
    );
    // the venue's own combo: the picks come as words and are placed on the venue's listings (the club's next game
    // after the buy); a pick with no listed game stays a word; the row's start is the first leg's, not the ticket's
    const wire = pos.body.positions[5];
    assert.deepEqual([wire.reason, wire.side, wire.multiplier, wire.startsIso], ["parlay", "Combo", 9.47, START]);
    assert.deepEqual(
      wire.legs.map((l: Any) => [l.marketId, l.side, l.event, l.startsIso, l.state]),
      [["m-bos", "Boston Celtics", "Los Angeles Lakers at Boston Celtics", START, "pending"], ["m-sac", "Sacramento Kings", "Golden State Warriors at Sacramento Kings", START, "pending"], [null, "Suns", "", null, "pending"]],
    );
    assert.equal(pos.body.positions[0].legs, undefined, "a single market has no legs");
    assert.equal(pos.body.positions[0].multiplier, undefined);
    assert.equal(pos.body.positions[0].market, undefined, "the venue's market payload stays on the service");

    // the games a member could protect: our protectable markets the venue lists too, each with the venue's event
    // to buy on (we never buy for anyone), its best bid and what a Max floor lock keeps of it; held ones say so
    const games = await get<Any>("/api/shadow/member/games");
    assert.equal(games.status, 200, JSON.stringify(games.body));
    assert.deepEqual([games.body.venueUrl, games.body.leagues, typeof games.body.cutoffMinutes], ["https://demo.venue.test", ["nba"], "number"]);
    assert.deepEqual(
      games.body.games.map((g: Any) => [g.ticker, g.side, g.event, g.held, g.venue.marketId, g.venue.url, g.venue.bestBidCents, g.venue.floorFromCents]),
      // soonest game first, then by event name; the game inside the cutoff (Denver, 30 min out) is not listed
      [
        [TICKER3, "Detroit Pistons", "Chicago Bulls at Detroit Pistons", true, "m-det", "https://demo.venue.test/events/ev-m-det", 48, 38],
        ["KXNBAGAME-26OCT14GSWSAC-SAC", "Sacramento Kings", "Golden State Warriors at Sacramento Kings", false, "m-sac", "https://demo.venue.test/events/ev-m-sac", 45, 36],
        [TICKER, "Boston Celtics", "Los Angeles Lakers at Boston Celtics", true, "m-bos", "https://demo.venue.test/events/ev-m-bos", 54, 43],
        [TICKER2, "Miami Heat", "New York Knicks at Miami Heat", true, "m-mia", "https://demo.venue.test/events/ev-m-mia", 61, 48],
      ],
    );
    assert.equal(venue.catalogueReads, 1);
    await get<Any>("/api/shadow/member/games");
    assert.equal(venue.catalogueReads, 1, "the catalogue is shared and kept");
    // the club as the venue names it, and which side of the game it is, so the row reads as the portfolio does
    assert.deepEqual(games.body.games.map((g: Any) => [g.side, g.opponent, g.home]), [["Detroit Pistons", "Chicago Bulls", true], ["Sacramento Kings", "Golden State Warriors", true], ["Boston Celtics", "Los Angeles Lakers", true], ["Miami Heat", "New York Knicks", true]]);

    // the quote: three tiers from the bids, the comparison priced on the hedge routes beside them, nothing sent
    q = await get<Any>(`/api/shadow/quote?ticker=${TICKER}&contracts=50&venue=stx`);
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.deepEqual([q.body.ok, q.body.route, q.body.onRecord, q.body.contracts, q.body.entryCents, q.body.sideName, q.body.eventTimeIso], [true, "member_sale", false, 50, 42, "Boston Celtics", START]);
    assert.deepEqual(
      ["wide", "balanced", "tight"].map((k) => {
        const t = q.body.quote.tiers[k];
        return [t.soldContracts, t.keptContracts, t.limitPriceCents, t.cashNowCents, t.floorTotalCents, t.capTotalCents, t.creditCents];
      }),
      [
        [20, 30, 54, 1080, 1080, 4080, 0],
        [30, 20, 53, 1615, 1615, 3615, 0],
        [40, 10, 53, 2145, 2145, 3145, 0],
      ],
    );
    assert.equal(q.body.quote.tier, "wide", "the engine's default heads the quote");
    assert.deepEqual([q.body.quote.floorCents, q.body.quote.capCents, q.body.quote.creditCents], [Math.round(1080 / 50), Math.round(4080 / 50), 0]);
    assert.deepEqual([q.body.member.connected, q.body.member.held, q.body.member.bestBidCents, q.body.member.bidDepth], [true, 50, 54, 65]);
    assert.equal(q.body.tails.length, 4);
    assert.ok(q.body.tails[0].text.includes("your 30 riding contracts"), q.body.tails[0].text);
    assert.deepEqual(Object.keys(q.body.rules).sort(), ["abandoned", "corrected", "postponed", "tie"]);
    assert.deepEqual([q.body.compared.ok, q.body.compared.sent, q.body.compared.chosen, q.body.compared.chosenName, q.body.compared.priced], [true, false, "kalshi_self", "Kalshi", 1]);
    assert.ok(q.body.compared.creditCents > 0 && q.body.compared.floorTotalCents > 0);
    assert.equal(seen.at(-1)?.holderVenue, "stx", "the comparison is priced against the member's venue's rules");

    // refusals before any book is read: a market the member does not hold, more than they hold, a game inside the cutoff
    q = await get<Any>(`/api/shadow/quote?ticker=KXNBAGAME-26OCT14LALBOS-LAL&contracts=5&venue=stx`);
    assert.deepEqual([q.status, q.body.code, q.body.heldTicker], [409, "wrong_side", TICKER]);
    q = await get<Any>(`/api/shadow/quote?ticker=KXNBAGAME-26OCT14GSWSAC-SAC&contracts=5&venue=stx`);
    assert.deepEqual([q.status, q.body.code], [409, "not_held"]);
    q = await get<Any>(`/api/shadow/quote?ticker=${TICKER}&contracts=60&venue=stx`);
    assert.deepEqual([q.status, q.body.code, q.body.held], [409, "size", 50]);
    q = await get<Any>(`/api/shadow/quote?ticker=${SOON}&contracts=10&venue=stx`);
    assert.deepEqual([q.status, q.body.ok, q.body.code], [200, false, "market_too_close_to_start"]);

    // the lock: the member's own sell, one limit order at the walked price for the tier's share, filled whole
    const lock = await post<Any>("/api/shadow/lock", { ticker: TICKER, contracts: 50, entryCents: 42, tier: "balanced", venue: "stx" });
    assert.equal(lock.status, 200, JSON.stringify(lock.body));
    assert.deepEqual([lock.body.ok, lock.body.route, lock.body.tier, lock.body.contracts, lock.body.creditCents, lock.body.partial], [true, "member_sale", "balanced", 50, 0, false]);
    assert.deepEqual([lock.body.floorTotalCents, lock.body.capTotalCents, lock.body.floorCents, lock.body.capCents], [1615, 3615, 32, 72]);
    const s = lock.body.memberSale;
    assert.deepEqual([s.soldContracts, s.keptContracts, s.requestedContracts, s.limitPriceCents, s.avgPriceCents, s.cashNowCents, s.feeCents, s.status, s.venue, s.venueName], [30, 20, 30, 53, 53, 1615, 0, "filled", "stx", "STX"]);
    assert.ok(typeof s.orderId === "string" && s.orderId.startsWith("ord-"), "the member's own order id is on their receipt");
    assert.equal(s.marketId, undefined, "the venue's market id stays in the ledger");
    assert.equal(s.clientOrderId, undefined);
    assert.deepEqual([lock.body.hedge, lock.body.routing], [null, null]);
    // the balance moved by the sale's cash; the page reads it fresh after a lock
    acct = await get<Any>("/api/shadow/member/account?fresh=1");
    assert.equal(acct.body.balance.accountCents, 25000 + 1615);
    assert.deepEqual([lock.body.compared.ok, lock.body.compared.sent], [true, false]);
    assert.deepEqual([lock.body.rule.venue, lock.body.rule.venueName, lock.body.rule.basis], ["stx", "STX", "rules"]);
    assert.equal(lock.body.tails.length, 4);
    const sent = venue.orders.at(-1) as Any;
    assert.deepEqual([sent.action, sent.market_id, sent.order_type, sent.price, sent.quantity], ["sell", "m-bos", "limit", "0.53", "30"]);
    assert.match(String(sent.client_order_id), /^atticus-lock-/);
    // the ledger: the record as written, with the venue's ids and the comparison
    let recs = loadShadowPositions(ledger);
    assert.equal(recs.length, 1);
    const R = recs[0];
    assert.deepEqual([R.route, R.holderVenue, R.source, R.creditCents, R.takeCents, R.feesCents, R.hedgeCostCents, R.hedgeUnitsMilli, R.tier, R.entryCents, R.contracts, R.floorCents, R.capCents], ["member_sale", "stx", "lock", 0, 0, 0, 0, 0, "balanced", 42, 50, 32, 72]);
    assert.deepEqual([R.memberSale?.marketId, R.memberSale?.maxPriceCents, R.memberSale?.orderId, R.memberSale?.compared?.ok, R.memberSale?.compared?.sent, R.memberSale?.compared?.chosen], ["m-bos", 100, s.orderId, true, false, "kalshi_self"]);
    assert.equal(R.rule?.basis, "rules");
    assert.ok(R.referenceRule, "the Kalshi market the result is read from is pinned too, from the comparison's read");
    assert.equal(R.routing, undefined, "no hedge routing on a member's own sale");

    // positions now show the lock; a second lock on the market is refused
    pos = await get<Any>("/api/shadow/positions");
    const bos = pos.body.positions.find((p: Any) => p.ticker === TICKER);
    assert.deepEqual([bos.contracts, bos.lock.status, bos.lock.route, bos.lock.floorTotalCents, bos.lock.capTotalCents, bos.lock.memberSale.soldContracts], [20, "open", "member_sale", 1615, 3615, 30]);
    const twice = await post<Any>("/api/shadow/lock", { ticker: TICKER, contracts: 20, venue: "stx" });
    assert.deepEqual([twice.status, twice.body.error], [409, "already_on_record"]);

    // the receipt, and the public record: figures yes, the venue's ids no
    const rc = await get<Any>(`/api/shadow/receipt?ticker=${TICKER}`);
    assert.deepEqual([rc.body.route, rc.body.lock.status, rc.body.lock.route, rc.body.memberSale.soldContracts, rc.body.memberSale.orderId, rc.body.compared.ok, rc.body.tails.length, rc.body.venueSettlement, rc.body.hedge, rc.body.cash], ["member_sale", "open", "member_sale", 30, s.orderId, true, 4, null, null, []]);
    const pub = await get<Any>("/api/shadow", {});
    const pubRow = pub.body.open.find((p: Any) => p.ticker === TICKER);
    assert.ok(pubRow, "the lock is on the public record");
    assert.deepEqual([pubRow.route, pubRow.memberSale.soldContracts, pubRow.memberSale.cashNowCents, pubRow.memberSale.orderId, pubRow.memberSale.marketId, pubRow.memberSale.clientOrderId, pubRow.holder, pubRow.cashDue], ["member_sale", 30, 1615, null, "", "", undefined, []]);
    const pubText = JSON.stringify(pub.body);
    assert.ok(!pubText.includes("ord-") && !pubText.includes("atticus-lock-"), "no venue order id or client id on the public record");

    // a partial fill is written as the smaller sale it was; the rest was cancelled
    venue.fillMode = "partial";
    const part = await post<Any>("/api/shadow/lock", { ticker: TICKER2, contracts: 40, tier: "tight", venue: "stx" });
    assert.equal(part.status, 200, JSON.stringify(part.body));
    assert.deepEqual([part.body.ok, part.body.partial, part.body.memberSale.requestedContracts, part.body.memberSale.soldContracts, part.body.memberSale.keptContracts, part.body.memberSale.status, part.body.memberSale.cashNowCents, part.body.floorTotalCents, part.body.capTotalCents], [true, true, 32, 30, 10, "partially_cancelled", 1830, 1830, 2830]);
    assert.ok(part.body.tails[0].text.includes("your 10 riding contracts"));

    // no fill writes nothing
    venue.fillMode = "none";
    const none = await post<Any>("/api/shadow/lock", { ticker: TICKER3, contracts: 10, venue: "stx" });
    assert.deepEqual([none.status, none.body.ok, none.body.code, none.body.order.status], [200, false, "not_filled", "cancelled"]);
    assert.match(none.body.message, /nothing was sold/);
    recs = loadShadowPositions(ledger);
    assert.deepEqual(recs.map((r) => r.ticker).sort(), [TICKER, TICKER2].sort());
    venue.fillMode = "full";

    // the operator's health: the member app on, who is connected by alias and venue id, never a token
    const health = await get<Any>("/healthz", { "x-admin-token": "op-secret" });
    assert.deepEqual([health.body.lock.member.configured, health.body.lock.member.venue, health.body.lock.member.host, health.body.lock.member.members.length, health.body.lock.member.members[0].member, health.body.lock.member.members[0].userId], [true, "stx", venue.base, 1, "shared", "u1"]);
    assert.ok(!JSON.stringify(health.body).includes("stxapp_"), "no token in the health body");
    // the page's host, and what the listing endpoint's books looked like (the 48c question: do listed winners carry distinct best bids?)
    assert.equal(health.body.lock.member.hostname, "stx.lockin.test");
    const cat = health.body.lock.member.catalogue.NBA;
    assert.deepEqual([cat.markets, cat.winners, cat.winnersWithBids, cat.distinctBestBids, cat.sample.marketId, cat.sample.bids[0]], [6, 5, 5, 5, "m-bos", { price: "0.54", quantity: "25" }]);
    const holders = await get<Any>("/api/shadow/holders", { "x-admin-token": "op-secret" });
    assert.deepEqual(holders.body.holders[0].positions.map((p: Any) => [p.ticker, p.route, p.cash]).sort(), [[TICKER, "member_sale", []], [TICKER2, "member_sale", []]].sort());

    // leave early: the contracts sold are bought back from the offers; the round trip's net is what it left in the balance
    const uq = await get<Any>(`/api/shadow/unwind/quote?ticker=${TICKER}`);
    assert.equal(uq.status, 200, JSON.stringify(uq.body));
    const u = uq.body.unwind;
    assert.deepEqual([u.route, u.venueName, u.contracts, u.soldContracts, u.buyBack.contracts, u.buyBack.limitPriceCents, u.buyBack.costCents, u.cashNowCents, u.protectedAtCloseCents, u.closeNetCents, u.stayFloorCents, u.stayCapCents, u.yesMidCents], ["member_sale", "STX", 50, 30, 30, 56, 1680, 1615, -65, -65, 1615, 3615, 55]);
    const un = await post<Any>("/api/shadow/unwind", { ticker: TICKER });
    assert.equal(un.status, 200, JSON.stringify(un.body));
    assert.deepEqual([un.body.ok, un.body.status, un.body.route, un.body.partial, un.body.memberBuyBack.boughtContracts, un.body.memberBuyBack.costCents, un.body.memberBuyBack.status, un.body.unwind.protectedAtCloseCents, un.body.hedge.sent, un.body.cash], [true, "closed", "member_sale", false, 30, 1680, "filled", -65, false, []]);
    const buy = venue.orders.at(-1) as Any;
    assert.deepEqual([buy.action, buy.market_id, buy.price, buy.quantity], ["buy", "m-bos", "0.56", "30"]);
    assert.match(String(buy.client_order_id), /^atticus-leave-/);
    const closed = loadShadowPositions(ledger).find((r) => r.ticker === TICKER)!;
    assert.deepEqual([closed.status, closed.protectedCents, closed.nakedCents, closed.closeSource, closed.closeHedgeSent, closed.closeMemberBuyBack?.boughtContracts], ["closed", -65, 0, "unwind", false, 30]);
    assert.deepEqual(cashDue(closed), []);
    const rc2 = await get<Any>(`/api/shadow/receipt?ticker=${TICKER}`);
    assert.deepEqual([rc2.body.lock.status, rc2.body.memberBuyBack.boughtContracts, rc2.body.lock.closeNetCents], ["closed", 30, -65]);
    pos = await get<Any>("/api/shadow/positions");
    assert.equal(pos.body.positions.find((p: Any) => p.ticker === TICKER).contracts, 50, "the position is back to its size at the venue");
    const leaveTwice = await post<Any>("/api/shadow/unwind", { ticker: TICKER });
    assert.deepEqual([leaveTwice.status, leaveTwice.body.error], [409, "not_open"]);
    // history: every lock this member made, newest first, with its state
    const hist = await get<Any>("/api/shadow/member/history");
    assert.equal(hist.status, 200);
    assert.deepEqual(hist.body.records.map((r: Any) => [r.ticker, r.side, r.status, r.route, r.tier, r.memberSale?.soldContracts]), [
      [TICKER2, "Miami Heat", "open", "member_sale", "tight", 30],
      [TICKER, "Boston Celtics", "closed", "member_sale", "balanced", 30],
    ]);
    assert.deepEqual([hist.body.records[1].memberSale.marketId, hist.body.records[1].memberSale.clientOrderId, hist.body.records[1].memberBuyBack.boughtContracts, hist.body.records[1].closeNetCents], [undefined, undefined, 30, -65], "the member's own order ids ride along, the venue's market id does not");

    // the bearer is rotated when it runs short, through the refresh, once
    const grant = sessions.store.get("shared")!;
    sessions.store.set("shared", { ...grant, expiresAtMs: Date.now() + 10_000 });
    pos = await get<Any>("/api/shadow/positions?fresh=1");
    assert.equal(pos.body.ok, true);
    assert.equal(venue.refreshes, 1);
    assert.notEqual(sessions.store.get("shared")!.accessToken, grant.accessToken);

    // disconnect: revoked at the venue, dropped here; the routes answer not connected again
    const dc = await post<Any>("/api/shadow/member/disconnect", {});
    assert.deepEqual([dc.status, dc.body.disconnected, dc.body.member.connected], [200, true, false]);
    assert.equal(venue.revoked.length, 2, "the refresh token and the access token");
    pos = await get<Any>("/api/shadow/positions");
    assert.deepEqual([pos.body.configured, pos.body.member.connected], [false, false]);
    q = await get<Any>(`/api/shadow/quote?ticker=${TICKER2}&contracts=10&venue=stx`);
    assert.equal(q.body.code, "member_not_connected");
    assert.equal(readFileSync(join(dir, "member-tokens.json"), "utf8").includes("stxapp_"), false);

    // THE HOSTED PAGE (/app): the service sets a session cookie, once; the cookie is the caller on the
    // member routes, as an alias m-<hex>, and its lane is the member venue's alone
    const page = await fetch(`${base}/app`);
    assert.equal(page.status, 200);
    const setCookie = page.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /^ael_member=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax(; Secure)?$/, "HttpOnly, Lax; Secure only behind https");
    const html = await page.text();
    assert.ok(html.includes("Lock in · STX positions") && html.includes("Protection by Atticus") && html.includes('"venueName":"STX"'), "the page's words");
    assert.ok(!html.includes("lock-key-") && !html.includes("stxapp_") && !html.includes("op-secret"), "no key of any kind on the page");
    // the row's figures sit inside the open panel (chipsHtml), not under the header; the header is club, game, pays
    assert.ok(html.includes("const chipsHtml = (p) =>") && html.includes(`'<div class="ael-panel ael-on">' + chipsHtml(p) + (p.combo ? legsHtml(p) : "") + slipRows(nick, o, p.contracts, false, p.combo)`) && !html.includes(`"</div></div>" +\n      '<div class="chips">'`), "chips live in the panel");
    assert.ok(html.includes('<div class="ael-dl">Elsewhere</div>') && html.includes("priced for the record, nothing sent; your position is on ") && html.includes("filled where you hold the position, on STX"), "every venue priced, filled where held");
    assert.ok(html.includes("const isLive = (p) => !!(S.inPlay && p.ticker") && html.includes('case "market_suspended": return ["Paused"') && html.includes("Live price · never less than shown"), "the page knows the in-play words");
    // the word budget: one line under a parlay's legs with the why under Details; Games is a heading, one line and a ? for bid and floor; the group header is two words
    assert.ok(html.includes("Rides to settlement on ' + esc(VN) + '.</span>") && html.includes('<div class="ael-dl">Why</div>') && !html.includes("Last-leg protection through this service is a separate step"), "a parlay's panel is one line, the why behind Details");
    assert.ok(html.includes("It lands here with its Lock in line.</p>") && html.includes('id="g-help" aria-expanded="false" aria-label="What bid and floor mean">\' + INFO + "</button>') && html.includes('id="g-help-p" hidden><b>Bid</b> is') && html.includes(">Not protectable</h2>"), "Games is one line with an i");
    assert.ok(html.includes('[["held", "Portfolio"]]') && html.includes("data-tab=\"portfolio\">' + TICK + \"Held</a>\"") && html.includes(".side .buy, .side .have { order: 3; flex: none; margin-left: auto; }") && html.includes(".gbar { flex-wrap: nowrap; overflow-x: auto;"), "short pills; the tile's action on the first row, the filter bar one row");
    assert.ok(html.includes("Leave early buys it back any time before it settles.") && html.includes('isLive(p) ? " · live price, never more than shown"'), "leaving stands during the game");
    assert.ok(html.includes('let pickedTier = "wide";') && html.includes("tier: pickedTier,") && !html.includes("ael_tier"), "every row opens on Max upside; nothing remembered across visits");
    assert.ok(html.includes("the rest rides</div>") && html.includes('"Bought back " + c.contracts + " at " + cents(c.avgPriceCents) + " · net <b>" + signed(c.netCents) + "</b>", false)'), "the helper lines are one line each; the left row is its line, folded");
    assert.ok(html.includes('<span class="ael-l">Net to your \' + esc(VN) + \' balance</span>') && !html.includes("<s>in your balance</s>") && html.includes("st.leave = false; st.open = false; st.details = false; st.rules = false; st.how = false;"), "the leave box has no note column; the row forgets its panel on the leave");
    // how it works: one sheet in the page, opened from the foot and the empty portfolio
    assert.ok(html.includes('<div class="sheet" id="how" hidden role="dialog"') && html.includes("How Lock in works") && html.includes("Keep the floor, win or lose") && html.includes('id="about-tg">How it works</button>') && !html.includes('id="about" hidden'), "the sheet replaces the foot's paragraphs");
    assert.ok(html.includes('const TSTEPS = \'<ol class="tsteps">') && html.includes('id="empty-how">how it works</a>') && !html.includes("tourHtml") && !html.includes("ael_tour"), "the empty portfolio carries the steps; no strip on first open");
    // the edge hairline on the controls; the shape control is an equal-cell grid on a phone
    assert.ok(html.includes("--ael-edge: rgba(255, 255, 255, 0.13)") && html.includes(".ael-go.ael-quiet { display: inline-flex; width: auto; height: 40px; margin: 0; padding: 0 14px; border: 1px solid var(--ael-edge)") && html.includes(".gbar .f { font-size: 12.5px; padding: 6px 11px; border-radius: 999px; border: 1px solid var(--ael-edge)") && html.includes(".ael-shape { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); width: 100%;"), "the edge and the shape grid");
    assert.ok(html.includes('rel="manifest" href="/app/manifest.webmanifest"') && html.includes('src="/app/stx.png"') && html.includes('src="/app/bird.png"'), "the marks and the manifest are the page's own files");
    // the page's files: the marks, the icons, the manifest; anything else under /app/ is not found
    const manifest = await fetch(`${base}/app/manifest.webmanifest`);
    assert.equal(manifest.headers.get("content-type"), "application/manifest+json");
    const mj = (await manifest.json()) as Any;
    assert.deepEqual([mj.name, mj.short_name, mj.start_url, mj.scope, mj.display, mj.icons.length], ["Lock in · STX", "Lock in", "/app?source=home", "/app", "standalone", 2]);
    for (const f of ["stx.png", "bird.png", "atticus.png", "icon-180.png", "icon-192.png", "icon-512.png"]) {
      const r = await fetch(`${base}/app/${f}`);
      const bytes = Buffer.from(await r.arrayBuffer());
      assert.deepEqual([f, r.status, r.headers.get("content-type"), bytes.subarray(1, 4).toString("ascii")], [f, 200, "image/png", "PNG"]);
    }
    assert.equal((await fetch(`${base}/app/nope.png`)).status, 404);
    const ck = { cookie: setCookie.split(";")[0] };
    // THE PAGE'S OWN HOST (MEMBER_APP_HOSTNAME): the root is the page, the page's files and the API answer
    // as always, and any other path is sent to the record URL, so nothing venue-neutral is served under a venue's name
    // (fetch drops a custom Host header, so the raw client; Render fronts the service, so x-forwarded-host counts too)
    const onHost = (path: string, hostHeader: Record<string, string> = { host: "stx.lockin.test" }) =>
      new Promise<{ status: number; location: string | null; text: string }>((resolve, reject) => {
        const req = httpRequest(`${base}${path}`, { headers: hostHeader, setHost: false }, (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, location: (res.headers.location as string | undefined) ?? null, text }));
        });
        req.on("error", reject);
        req.end();
      });
    const rootOnHost = await onHost("/");
    assert.equal(rootOnHost.status, 200);
    assert.ok(rootOnHost.text.includes("Lock in · STX positions"), "the root on the page's host is the page");
    assert.equal((await onHost("/app/stx.png")).status, 200);
    assert.equal((await onHost("/api/shadow/member")).status, 403, "the API stays on the host (no cookie here, so refused there, not redirected)");
    const embed = await onHost("/embed/event-lockin.js?x=1");
    assert.deepEqual([embed.status, embed.location], [302, "https://atticus-event-shadow.onrender.com/embed/event-lockin.js?x=1"]);
    const forwarded = await onHost("/", { host: "atticus-event-shadow.onrender.com", "x-forwarded-host": "stx.lockin.test" });
    assert.ok(forwarded.status === 200 && forwarded.text.includes("Lock in · STX positions"), "behind the proxy, the forwarded host names the page");
    const dflt = await onHost("/embed/event-lockin.js", { host: "atticus-event-shadow.onrender.com" });
    assert.notEqual(dflt.status, 302, "the default host is untouched");
    // a connect begun on the page's host comes back to the page's host after the venue's callback (the cookie lives there),
    // even though the callback itself is registered on the record URL
    const hostCookieRaw = await new Promise<string>((resolve, reject) => {
      const req = httpRequest(`${base}/`, { headers: { host: "stx.lockin.test" }, setHost: false }, (res) => { res.resume(); res.on("end", () => resolve(String(res.headers["set-cookie"]?.[0] ?? "").split(";")[0])); });
      req.on("error", reject); req.end();
    });
    const hostConnect = await onHost("/api/shadow/member/connect", { host: "stx.lockin.test", cookie: hostCookieRaw, "x-member-app": "1" });
    assert.equal(hostConnect.status, 200, hostConnect.text);
    const hostCode = venue.issueCode(JSON.parse(hostConnect.text).url);
    const hostBack = await fetch(`${base}/api/shadow/member/callback?code=${hostCode.code}&state=${hostCode.state}`, { redirect: "manual" });
    assert.deepEqual([hostBack.status, hostBack.headers.get("location")], [302, "https://stx.lockin.test/app?connected=1"]);
    // the privacy page: at /privacy on the page's host, /app/privacy everywhere; linked from the page's foot
    const privHost = await onHost("/privacy");
    assert.ok(privHost.status === 200 && privHost.text.includes("<h1>Privacy</h1>") && privHost.text.includes('href="/"'), "privacy on the page's host, back to /");
    const privDflt = await fetch(`${base}/app/privacy`);
    assert.ok(privDflt.status === 200 && (await privDflt.text()).includes("Your funds stay in your STX account"), "privacy on the default host");
    assert.ok(html.includes('href="/app/privacy">Privacy</a>'), "the foot links it");

    // THE OPERATOR'S RAW READ of a member's venue account: operator only; the positions list unfiltered, the
    // markets for their ids and which were missing, the probes, the catalogue sample; no token anywhere
    assert.equal((await get<Any>("/api/shadow/member/raw")).status, 403, "lock key is not enough");
    const rawNo = await get<Any>("/api/shadow/member/raw?holder=m-nobody", { "x-admin-token": "op-secret" });
    assert.deepEqual([rawNo.status, rawNo.body.error, rawNo.body.members.length], [400, "member", 1]);
    const raw = await get<Any>("/api/shadow/member/raw", { "x-admin-token": "op-secret" });
    assert.equal(raw.status, 200, JSON.stringify(raw.body).slice(0, 300));
    assert.deepEqual([raw.body.positions.count, raw.body.positions.dropped.length, raw.body.markets.asked, raw.body.markets.returned, raw.body.markets.missing, Object.keys(raw.body.probes).length, typeof raw.body.catalogue.NBA.distinctBestBids], [6, 0, 6, 6, [], 5, "number"]);
    assert.ok(!JSON.stringify(raw.body).includes("stxapp_"), "no token in the raw read");
    const revisit = await fetch(`${base}/app`, { headers: ck });
    assert.equal(revisit.headers.get("set-cookie"), null, "a returning cookie is kept, not replaced");
    let cm = await get<Any>("/api/shadow/member", ck);
    assert.equal(cm.status, 200);
    assert.match(cm.body.holder, /^m-[0-9a-f]{16}$/, "the cookie's alias is a hash of it");
    assert.equal(cm.body.member.connected, false);
    const alias = cm.body.holder as string;
    // a POST from the cookie alone is refused: the page sends its own header, a cross-site form cannot
    const noHeader = await fetch(`${base}/api/shadow/member/disconnect`, { method: "POST", headers: { ...ck, "content-type": "application/json" }, body: "{}" });
    assert.equal(noHeader.status, 403);
    // beyond the member lane: a quote or a lock the protection would hedge with our capital is refused
    const otherQuote = await get<Any>(`/api/shadow/quote?ticker=${TICKER}&contracts=10&venue=kalshi`, ck);
    assert.deepEqual([otherQuote.status, otherQuote.body.code], [403, "member_only"]);
    const pageHeaders = { ...ck, "x-member-app": "1", "content-type": "application/json" };
    const otherLock = await fetch(`${base}/api/shadow/lock`, { method: "POST", headers: pageHeaders, body: JSON.stringify({ ticker: TICKER, contracts: 10, venue: "kalshi" }) });
    assert.equal(otherLock.status, 403);
    // connect from the page: the venue's redirect sends a page member back to the page, not to the one-line tab
    const cc = await get<Any>("/api/shadow/member/connect", ck);
    assert.equal(cc.status, 200);
    const issued = venue.issueCode(cc.body.url);
    const back = await fetch(`${base}/api/shadow/member/callback?code=${issued.code}&state=${issued.state}`, { redirect: "manual" });
    assert.deepEqual([back.status, back.headers.get("location")], [302, "/app?connected=1"]);
    cm = await get<Any>("/api/shadow/member", ck);
    assert.equal(cm.body.member.connected, true);
    // positions: the member's own venue rows, every one marked with the venue; no holder-key account of ours is read
    const cp = await get<Any>("/api/shadow/positions", ck);
    assert.ok(cp.body.ok && cp.body.positions.length >= 3 && cp.body.positions.every((p: Any) => p.venue === "stx"), JSON.stringify(cp.body));
    // a lock from the page: the member's own sale, written to the alias's own ledger; the shared ledger is untouched
    const sharedBefore = loadShadowPositions(ledger).length;
    const cl = await fetch(`${base}/api/shadow/lock`, { method: "POST", headers: pageHeaders, body: JSON.stringify({ ticker: TICKER, contracts: 50, venue: "stx" }) });
    const clb = (await cl.json()) as Any;
    assert.equal(cl.status, 200, JSON.stringify(clb));
    assert.deepEqual([clb.ok, clb.route, clb.holder, clb.memberSale.soldContracts], [true, "member_sale", alias, 20]);
    assert.ok(existsSync(join(dir, `lock-ledger-${alias}.jsonl`)), "the alias's own ledger");
    assert.equal(loadShadowPositions(ledger).length, sharedBefore);
    const cpos = await get<Any>("/api/shadow/positions", ck);
    assert.equal(cpos.body.positions.find((p: Any) => p.ticker === TICKER).lock.status, "open");
    // disconnect from the page, with its header
    const cdc = await fetch(`${base}/api/shadow/member/disconnect`, { method: "POST", headers: pageHeaders, body: "{}" });
    assert.equal(cdc.status, 200);
    cm = await get<Any>("/api/shadow/member", ck);
    assert.equal(cm.body.member.connected, false);

    // IN PLAY (MEMBER_APP_IN_PLAY): a lock while the game is on is the same limit sell into the venue's
    // bids; the cutoff no longer applies; the venue's hold on in-play orders is waited out; a paused or
    // finished market is refused in words. Off (the default), a started game is still pre-game only.
    const LIVE = "KXNBAGAME-26OCT14INDMIL-MIL";
    const START_LIVE = new Date(Date.now() - 20 * 60_000).toISOString();
    venue.markets["m-mil"] = { ...market("m-mil", "Milwaukee Bucks", "Indiana Pacers", START_LIVE, [["0.66", "100"]], [["0.68", "100"]]), event_status: "in_progress", in_play_delay_sec: 5 };
    venue.markets["m-mil-paused"] = { ...market("m-mil-paused", "Orlando Magic", "Atlanta Hawks", START_LIVE, [["0.40", "100"]], [["0.42", "100"]]), event_status: "in_progress", trading: false, in_play_delay_sec: 5 };
    venue.markets["m-mil-over"] = { ...market("m-mil-over", "Utah Jazz", "Portland Trail Blazers", START_LIVE, [], []), status: "closed", event_status: "completed" };
    venue.positions.push({ market_id: "m-mil", position: "20.00", average_open_premium: "-0.60" }, { market_id: "m-mil-paused", position: "10.00", average_open_premium: "-0.35" }, { market_id: "m-mil-over", position: "10.00", average_open_premium: "-0.50" });
    markets.push(row(LIVE, "Milwaukee Bucks", START_LIVE), row("KXNBAGAME-26OCT14ATLORL-ORL", "Orlando Magic", START_LIVE), row("KXNBAGAME-26OCT14PORUTA-UTA", "Utah Jazz", START_LIVE));
    const liveConnect = await get<Any>("/api/shadow/member/connect");
    const rcode = venue.issueCode(liveConnect.body.url);
    assert.equal((await fetch(`${base}/api/shadow/member/callback?code=${rcode.code}&state=${rcode.state}`)).status, 200);
    pos = await get<Any>("/api/shadow/positions?fresh=1");
    assert.equal(pos.body.inPlay, false, "off, as wired for the pre-game checks");
    assert.ok(/let memberInPlay = !\/\^\(0\|false\|no\|off\)\$\/i\.test\(process\.env\.MEMBER_APP_IN_PLAY/.test(readFileSync(new URL("../scripts/eventShadowWorker.ts", import.meta.url), "utf8")), "in play is on unless MEMBER_APP_IN_PLAY=0");
    assert.ok(pos.body.positions.some((p: Any) => p.ticker === LIVE), "a started game the member holds is on the list");
    q = await get<Any>(`/api/shadow/quote?ticker=${LIVE}&contracts=20&venue=stx`);
    assert.deepEqual([q.body.ok, q.body.code, q.body.message], [false, "market_not_active", "This game has started; the lock is pre-game only."]);
    q = await get<Any>(`/api/shadow/quote?ticker=${SOON}&contracts=10&venue=stx`);
    assert.equal(q.body.code, "market_too_close_to_start");
    // on
    worker.wireLockEngine({ listGameMarkets: async () => markets, quoteOne: async (inputs: OneQuoteInputs): Promise<OneQuoteResult> => ({ ok: true, result: candidate(inputs.ticker, inputs.contracts, inputs.entryCents ?? 60) }), memberInPlay: true });
    pos = await get<Any>("/api/shadow/positions");
    assert.equal(pos.body.inPlay, true);
    q = await get<Any>(`/api/shadow/quote?ticker=${SOON}&contracts=10&venue=stx`);
    assert.deepEqual([q.status, q.body.ok, q.body.live], [200, true, false], "inside the old cutoff, pre-game: quoted, not live");
    q = await get<Any>(`/api/shadow/quote?ticker=${LIVE}&contracts=20&venue=stx`);
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.deepEqual([q.body.ok, q.body.live, q.body.inPlayDelaySec, q.body.quote.tiers.balanced.limitPriceCents], [true, true, 5, 66], "the game on: priced from the bids as they stand, the venue's hold named");
    q = await get<Any>(`/api/shadow/quote?ticker=KXNBAGAME-26OCT14ATLORL-ORL&contracts=10&venue=stx`);
    assert.deepEqual([q.body.ok, q.body.code, q.body.message], [false, "market_suspended", "STX has paused this market for the moment; try again in a few seconds."]);
    q = await get<Any>(`/api/shadow/quote?ticker=KXNBAGAME-26OCT14PORUTA-UTA&contracts=10&venue=stx`);
    assert.deepEqual([q.body.ok, q.body.code, q.body.message], [false, "market_not_active", "This game is over; STX is settling it."]);
    const liveLock = await post<Any>("/api/shadow/lock", { ticker: LIVE, contracts: 20, tier: "balanced", venue: "stx" });
    assert.equal(liveLock.status, 200, JSON.stringify(liveLock.body));
    assert.deepEqual([liveLock.body.ok, liveLock.body.route, liveLock.body.live, liveLock.body.inPlayDelaySec, liveLock.body.memberSale.soldContracts, liveLock.body.memberSale.limitPriceCents], [true, "member_sale", true, 5, 12, 66], "the sale is the member's own limit sell, as pre-game");
    const liveOrder = venue.orders.find((o: Any) => o.market_id === "m-mil");
    assert.deepEqual([liveOrder.action, liveOrder.order_type, liveOrder.price, liveOrder.quantity], ["sell", "limit", "0.66", "12"]);
    // leave early during the game: the pre-start margin is the hedged routes' last moment, not a member sale's while in play is on; off, it stands for the sale too
    worker.wireLockEngine({ listGameMarkets: async () => markets, quoteOne: async (inputs: OneQuoteInputs): Promise<OneQuoteResult> => ({ ok: true, result: candidate(inputs.ticker, inputs.contracts, inputs.entryCents ?? 60) }), memberInPlay: false });
    let luq = await get<Any>(`/api/shadow/unwind/quote?ticker=${LIVE}`);
    assert.deepEqual([luq.status, luq.body.error], [409, "too_late"], "in play off: the margin before the start closes the leave");
    worker.wireLockEngine({ listGameMarkets: async () => markets, quoteOne: async (inputs: OneQuoteInputs): Promise<OneQuoteResult> => ({ ok: true, result: candidate(inputs.ticker, inputs.contracts, inputs.entryCents ?? 60) }), memberInPlay: true });
    luq = await get<Any>(`/api/shadow/unwind/quote?ticker=${LIVE}`);
    assert.equal(luq.status, 200, JSON.stringify(luq.body));
    assert.deepEqual([luq.body.ok, luq.body.lastIso, luq.body.unwind.soldContracts, luq.body.unwind.buyBack.contracts, luq.body.unwind.buyBack.limitPriceCents], [true, null, 12, 12, 68], "the buy-back priced from the offers as they stand; no last moment");
    const lun = await post<Any>("/api/shadow/unwind", { ticker: LIVE });
    assert.equal(lun.status, 200, JSON.stringify(lun.body));
    assert.deepEqual([lun.body.ok, lun.body.status, lun.body.route, lun.body.memberBuyBack.boughtContracts], [true, "closed", "member_sale", 12]);
    const liveBuy = venue.orders.at(-1) as Any;
    assert.deepEqual([liveBuy.action, liveBuy.market_id, liveBuy.price, liveBuy.quantity], ["buy", "m-mil", "0.68", "12"], "the buy-back is a limit at the offer, in the member's own account");
    worker.wireLockEngine({ listGameMarkets: async () => markets, quoteOne: async (inputs: OneQuoteInputs): Promise<OneQuoteResult> => ({ ok: true, result: candidate(inputs.ticker, inputs.contracts, inputs.entryCents ?? 60) }), memberInPlay: false });

    // ---- a combination ticket, protected through the venue's quote (MEMBER_APP_COMBO_RFQ) ----
    // Off (the default): a combo row reads as it always has, no ticker, riding to settlement; its synthetic ticker is refused.
    const COMBO = comboTickerOf("m-combo");
    assert.equal(COMBO, "STXCOMBO-M-COMBO");
    const wireCombo = (on: boolean) => worker.wireLockEngine({ listGameMarkets: async () => markets, quoteOne: async (inputs: OneQuoteInputs): Promise<OneQuoteResult> => ({ ok: true, result: candidate(inputs.ticker, inputs.contracts, inputs.entryCents ?? 60) }), memberInPlay: true, memberComboRfq: on });
    pos = await get<Any>("/api/shadow/positions?fresh=1");
    const comboOff = pos.body.positions.find((p: Any) => p.event === "BOS / MIA / DET combo");
    assert.deepEqual([comboOff.ticker, comboOff.reason, comboOff.combo, pos.body.comboRfq], [null, "parlay", undefined, undefined], "off: the combo is shown, not protected");
    q = await get<Any>(`/api/shadow/quote?ticker=${COMBO}&contracts=5&venue=stx`);
    assert.deepEqual([q.status, q.body.code], [409, "parlay_unsupported"]);
    assert.ok(/let memberComboRfq = \/\^\(1\|true\|yes\|on\)\$\/i\.test\(process\.env\.MEMBER_APP_COMBO_RFQ/.test(readFileSync(new URL("../scripts/eventShadowWorker.ts", import.meta.url), "utf8")), "off unless MEMBER_APP_COMBO_RFQ is set");
    // on: the combo row carries its synthetic ticker and the combo mark; the legs still read as a combo's
    wireCombo(true);
    pos = await get<Any>("/api/shadow/positions?fresh=1");
    const comboOn = pos.body.positions.find((p: Any) => p.event === "BOS / MIA / DET combo");
    assert.deepEqual([comboOn.ticker, comboOn.combo, comboOn.reason, comboOn.legs.length, comboOn.contracts, pos.body.comboRfq], [COMBO, true, "parlay", 3, 5, true], "on: quotable, still a combo on the page");
    // the venue has not shipped the quote path: its 404 is "not yet", not an outage
    venue.rfqMode = "off";
    q = await get<Any>(`/api/shadow/quote?ticker=${COMBO}&contracts=5&venue=stx`);
    assert.deepEqual([q.status, q.body.ok, q.body.code], [200, false, "combo_quotes_unavailable"]);
    // quoted: one bid asked on the largest shape's size (80% of 5 = 4), read as one level, the three shapes walked from it
    venue.rfqMode = "quote";
    venue.rfqPrice = "0.30";
    q = await get<Any>(`/api/shadow/quote?ticker=${COMBO}&contracts=5&venue=stx`);
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.deepEqual([q.body.ok, q.body.combo, q.body.route, q.body.rfq.quantity, q.body.rfq.priceCents, q.body.rfq.legs, typeof q.body.rfq.expiresAtIso], [true, true, "member_sale", 4, 30, 3, "string"]);
    const T = q.body.quote.tiers;
    assert.deepEqual(
      [T.wide.soldContracts, T.wide.cashNowCents, T.wide.capTotalCents, T.balanced.soldContracts, T.balanced.cashNowCents, T.tight.soldContracts, T.tight.cashNowCents, T.tight.capTotalCents, T.tight.depthLimited],
      [2, 60, 360, 3, 90, 4, 120, 220, false],
      "cash now is the quote on the sold share; the cap adds $1 on every riding contract",
    );
    assert.deepEqual([q.body.tails, q.body.rules, typeof q.body.comboNote, q.body.compared], [[], {}, "string", null], "no league tails and no Kalshi comparison on a combo: one sentence on the venue's combo rules");
    assert.deepEqual([q.body.league, q.body.sideName, q.body.eventTitle, q.body.eventTimeIso], [q.body.league, "3-leg combo", "BOS / MIA / DET combo", START], "the record settles after the last leg");
    const askedFirst = venue.rfqs.at(-1) as Any;
    assert.deepEqual([askedFirst.market_id, askedFirst.action, askedFirst.quantity, /^atticus-rfq-/.test(askedFirst.client_rfq_id)], ["m-combo", "sell", "4", true], "the request names the ticket, the sell side, the size and our id");
    // partials: the makers take 3 of the 4 asked; Max floor is depth-limited, Max upside is not
    venue.rfqTake = 3;
    q = await get<Any>(`/api/shadow/quote?ticker=${COMBO}&contracts=5&venue=stx`);
    assert.deepEqual([q.body.quote.tiers.tight.soldContracts, q.body.quote.tiers.tight.depthLimited, q.body.quote.tiers.wide.soldContracts, q.body.quote.tiers.wide.depthLimited, q.body.rfq.quantity], [3, true, 2, false, 3]);
    venue.rfqTake = null;
    // priced on the read after the request: the same answer, one poll later
    venue.rfqMode = "pending";
    q = await get<Any>(`/api/shadow/quote?ticker=${COMBO}&contracts=5&venue=stx`);
    assert.deepEqual([q.body.ok, q.body.quote.tiers.balanced.cashNowCents], [true, 90], "a quote priced after the request is read on the poll");
    // declined: no shape, in words
    venue.rfqMode = "decline";
    q = await get<Any>(`/api/shadow/quote?ticker=${COMBO}&contracts=5&venue=stx`);
    assert.deepEqual([q.body.ok, q.body.code, q.body.rfq, q.body.message], [false, "no_bids", "declined", "STX's makers passed on this ticket right now."]);
    // the lock: a fresh quote at the tap, accepted for the shape's size; the fill posts as a regular order, so the
    // ticket shrinks in the positions read and the balance rises by the cash, like any sale
    venue.rfqMode = "quote";
    const balBefore = Number(venue.balance);
    const ordersBefore = venue.orders.length;
    const clk = await post<Any>("/api/shadow/lock", { ticker: COMBO, contracts: 5, tier: "balanced", venue: "stx" });
    assert.equal(clk.status, 200, JSON.stringify(clk.body));
    assert.deepEqual(
      [clk.body.ok, clk.body.combo, clk.body.route, clk.body.tier, clk.body.memberSale.soldContracts, clk.body.memberSale.keptContracts, clk.body.memberSale.cashNowCents, clk.body.floorTotalCents, clk.body.capTotalCents, clk.body.partial],
      [true, true, "member_sale", "balanced", 3, 2, 90, 90, 290, false],
      "3 of 5 sold at the quoted 30¢: $0.90 now, $2.90 if every leg hits",
    );
    assert.deepEqual([clk.body.memberSale.combo.quotedPriceCents, clk.body.memberSale.combo.legs, typeof clk.body.memberSale.combo.rfqId, clk.body.compared.ok, clk.body.compared.reason, clk.body.tails, typeof clk.body.comboNote], [30, 3, "string", false, "combo", [], "string"]);
    assert.equal(venue.orders.length, ordersBefore, "no order of ours was placed: the accept is the venue's");
    assert.equal(venue.balance, (balBefore + 0.9).toFixed(2), "the quote's cash landed in the member's balance");
    assert.equal(venue.positions.find((p) => p.market_id === "m-combo")!.position, "2.00", "the ticket's size dropped at the venue");
    pos = await get<Any>("/api/shadow/positions?fresh=1");
    const comboLocked = pos.body.positions.find((p: Any) => p.ticker === COMBO);
    assert.deepEqual([comboLocked.contracts, comboLocked.lock.status, comboLocked.lock.route, comboLocked.lock.floorCents], [2, "open", "member_sale", clk.body.floorCents], "the positions read shows the smaller ticket with its lock");
    assert.deepEqual([clk.body.rule.venue, clk.body.rule.basis, typeof clk.body.rule.sha256], ["stx", "market", "string"], "the ticket's own text pinned, as the venue describes it");
    // the receipt and the history carry it; a second lock on the same ticket is refused; leave early has nothing to buy back from
    const crc = await get<Any>(`/api/shadow/receipt?ticker=${COMBO}`);
    assert.deepEqual([crc.status, crc.body.combo, crc.body.memberSale.soldContracts, crc.body.tails, typeof crc.body.comboNote, crc.body.memberSale.marketId], [200, true, 3, [], "string", undefined]);
    const chist = await get<Any>("/api/shadow/member/history");
    assert.ok(chist.body.records.some((r: Any) => r.ticker === COMBO && r.memberSale?.combo?.legs === 3), "the combo lock is on the member's history, marked as one");
    const again2 = await post<Any>("/api/shadow/lock", { ticker: COMBO, contracts: 2, tier: "wide", venue: "stx" });
    assert.deepEqual([again2.status, again2.body.error], [409, "already_on_record"]);
    const cuq = await get<Any>(`/api/shadow/unwind/quote?ticker=${COMBO}`);
    assert.deepEqual([cuq.status, cuq.body.code], [409, "combo_no_buyback"]);
    const cun = await post<Any>("/api/shadow/unwind", { ticker: COMBO });
    assert.deepEqual([cun.status, cun.body.code], [409, "combo_no_buyback"]);
    // the quote lapses between the tap and the accept: nothing sold, said in words, the ticket untouched
    const COMBO2 = comboTickerOf("m-combo-wire");
    venue.acceptMode = "expired";
    const lapsed = await post<Any>("/api/shadow/lock", { ticker: COMBO2, contracts: 9, tier: "wide", venue: "stx" });
    assert.deepEqual([lapsed.status, lapsed.body.ok, lapsed.body.code], [200, false, "quote_lapsed"], JSON.stringify(lapsed.body));
    assert.equal(venue.positions.find((p) => p.market_id === "m-combo-wire")!.position, "9.00");
    venue.acceptMode = "fill";
    // a ticket with a leg already missed, or every leg in, is not quoted
    venue.markets["m-combo-missed"] = { ...market("m-combo-missed", "", "", START, [], []), rules: "combo", event_title: "", symbol: "UTA / POR combo", participants: [], legs: [{ market_id: "m-mil-over", result: "lost" }, { market_id: "m-det" }] } as RawOutcomeMarket;
    venue.positions.push({ market_id: "m-combo-missed", position: "4.00", average_open_premium: "0.25" });
    pos = await get<Any>("/api/shadow/positions?fresh=1");
    const missed = pos.body.positions.find((p: Any) => p.event === "UTA / POR combo");
    assert.deepEqual([missed.ticker, missed.combo, missed.legs.map((l: Any) => l.state)], [null, undefined, ["lost", "pending"]], "a missed leg: shown as it always was, nothing to protect");
    // settlement: the record settles after the last leg on the venue's own word for the ticket, the pinned text checked.
    // A ticket whose legs are on (in play) settles as soon as the venue says; here the venue says the ticket won.
    venue.markets["m-combo-live"] = { ...market("m-combo-live", "", "", START_LIVE, [], []), rules: "combo", event_title: "", symbol: "MIL / ORL combo", participants: [], description: "A combination settling into its ceiling only if every leg lands: Bucks Won, Magic Won.", legs: [{ market_id: "m-mil" }, { market_id: "m-mil-paused" }] } as RawOutcomeMarket;
    venue.positions.push({ market_id: "m-combo-live", position: "10.00", average_open_premium: "0.20" });
    const COMBO3 = comboTickerOf("m-combo-live");
    venue.rfqPrice = "0.45";
    const ll = await post<Any>("/api/shadow/lock", { ticker: COMBO3, contracts: 10, tier: "wide", venue: "stx" });
    assert.equal(ll.status, 200, JSON.stringify(ll.body));
    assert.deepEqual([ll.body.ok, ll.body.live, ll.body.memberSale.soldContracts, ll.body.memberSale.cashNowCents, ll.body.eventTimeIso], [true, true, 4, 180, START_LIVE], "legs in play: quoted and sold, the record dated to the last leg's start");
    await worker.settleTick();
    let ledgerNow = loadShadowPositions(ledger);
    assert.equal(ledgerNow.find((p) => p.ticker === COMBO3)?.status, "open", "no word from the venue yet: the record waits");
    venue.markets["m-combo-live"] = { ...venue.markets["m-combo-live"], status: "settled", result: "won", settled_at: new Date().toISOString() };
    assert.equal(marketResultWord(venue.markets["m-combo-live"]), "yes");
    await worker.settleTick();
    ledgerNow = loadShadowPositions(ledger);
    const settledCombo = ledgerNow.find((p) => p.ticker === COMBO3)!;
    assert.deepEqual([settledCombo.status, settledCombo.result, settledCombo.ruleCheck?.unchanged], ["settled", "yes", true], "settled on the venue's word, the ticket's text unchanged since the pin");
    assert.equal(ledgerNow.find((p) => p.ticker === COMBO)?.status, "open", "the other combo's last leg is hours out: untouched");
    // off again2: the locked combo still reads as locked on the page (the record stands), the unlocked ones as they always have
    wireCombo(false);
    pos = await get<Any>("/api/shadow/positions?fresh=1");
    assert.deepEqual([pos.body.positions.find((p: Any) => p.event === "BOS / MIA / DET combo").ticker, pos.body.comboRfq], [null, undefined]);
    worker.wireLockEngine({ listGameMarkets: async () => markets, quoteOne: async (inputs: OneQuoteInputs): Promise<OneQuoteResult> => ({ ok: true, result: candidate(inputs.ticker, inputs.contracts, inputs.entryCents ?? 60) }), memberInPlay: false, memberComboRfq: false });
  } finally {
    worker.server.close();
    venue.close();
    worker.wireLockEngine({ quoteOne: (async () => ({ ok: false, code: "not_offered", detail: "test" })) as never, listGameMarkets: async () => [], venueClient: null, memberSessions: null });
  }
});
