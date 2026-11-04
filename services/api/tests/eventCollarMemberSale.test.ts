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
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
  leagueOfCompetition,
  matchMemberMarket,
  memberAppConfigFromEnv,
  memberHolderPositions,
  pkcePair,
  tokenKeyFrom,
  type RawMemberOrder,
  type RawMemberPosition,
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
  };
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
  delete process.env.MEMBER_APP_HOST;
  process.env.MEMBER_APP_VENUE_URL = "https://demo.venue.test/";
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
  venue.positions = [
    { market_id: "m-bos", position: "50.00", average_open_premium: "0.42" },
    { market_id: "m-mia", position: "40.00", average_open_premium: "0.55" },
    { market_id: "m-det", position: "10.00", average_open_premium: "0.45" },
    { market_id: "m-den", position: "10.00", average_open_premium: "0.65" },
    { market_id: "m-combo", position: "5.00", average_open_premium: "0.20" },
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
        // the parlay is on the list too, so the page mirrors the account; it says why it has no Lock in line
        [null, "stx", 5, 20, null],
      ],
    );
    assert.deepEqual([pos.body.positions[4].reason, pos.body.positions[4].event, typeof pos.body.cutoffMinutes], ["parlay", "BOS / MIA / DET combo", "number"]);
    assert.equal(pos.body.positions[0].market, undefined, "the venue's market payload stays on the service");

    // the games a member could protect: our protectable markets the venue lists too, each with the venue's event
    // to buy on (we never buy for anyone), its best bid and what a Max floor lock keeps of it; held ones say so
    const games = await get<Any>("/api/shadow/member/games");
    assert.equal(games.status, 200, JSON.stringify(games.body));
    assert.deepEqual([games.body.venueUrl, games.body.leagues, typeof games.body.cutoffMinutes], ["https://demo.venue.test", ["nba"], "number"]);
    assert.deepEqual(
      games.body.games.map((g: Any) => [g.ticker, g.side, g.event, g.held, g.venue.marketId, g.venue.url, g.venue.bestBidCents, g.venue.floorFromCents]),
      // soonest game first, then by event name
      [
        [SOON, "Denver Nuggets", "Phoenix Suns at Denver Nuggets", true, "m-den", "https://demo.venue.test/events/ev-m-den", 70, 56],
        [TICKER3, "Detroit Pistons", "Chicago Bulls at Detroit Pistons", true, "m-det", "https://demo.venue.test/events/ev-m-det", 48, 38],
        ["KXNBAGAME-26OCT14GSWSAC-SAC", "Sacramento Kings", "Golden State Warriors at Sacramento Kings", false, "m-sac", "https://demo.venue.test/events/ev-m-sac", 45, 36],
        [TICKER, "Boston Celtics", "Los Angeles Lakers at Boston Celtics", true, "m-bos", "https://demo.venue.test/events/ev-m-bos", 54, 43],
        [TICKER2, "Miami Heat", "New York Knicks at Miami Heat", true, "m-mia", "https://demo.venue.test/events/ev-m-mia", 61, 48],
      ],
    );
    assert.equal(venue.catalogueReads, 1);
    await get<Any>("/api/shadow/member/games");
    assert.equal(venue.catalogueReads, 1, "the catalogue is shared and kept");

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
  } finally {
    worker.server.close();
    venue.close();
    worker.wireLockEngine({ quoteOne: (async () => ({ ok: false, code: "not_offered", detail: "test" })) as never, listGameMarkets: async () => [], venueClient: null, memberSessions: null });
  }
});
