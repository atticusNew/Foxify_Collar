/**
 * Venue plays: the bearer-token venue API (session login, open matched plays, events and markets)
 * read into our units and matched to our markets. The fake venue below answers the venue's
 * published shapes; no network.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PlaysClient, asVenueMarket, holderPlays, payoutMultiple, playSize, playsConfigFromEnv, type RawMarket, type RawPlay, type RawSportEvent } from "../src/eventCollar/crossVenue/venuePlays";
import type { ProtectableMarket } from "../src/eventCollar/crossVenue/venuePositions";

const START = Date.UTC(2026, 9, 18, 17, 0);

const protectable: ProtectableMarket[] = [
  { ticker: "KXNFLGAME-26OCT18TENIND-IND", league: "nfl", sideName: "Colts", title: "Titans at Colts Winner?", dateIso: "2026-10-18" },
  { ticker: "KXNFLGAME-26OCT18TENIND-TEN", league: "nfl", sideName: "Titans", title: "Titans at Colts Winner?", dateIso: "2026-10-18" },
  { ticker: "KXNFLGAME-26OCT18HOUJAC-HOU", league: "nfl", sideName: "Texans", title: "Texans at Jaguars Winner?", dateIso: "2026-10-18" },
];

const colts: RawSportEvent = {
  event_id: 5001,
  name: "Tennessee Titans vs Indianapolis Colts",
  display_name: "Titans @ Colts",
  scheduled: new Date(START).toISOString(),
  status: "not_started",
  tournament_id: 31,
  tournament_name: "NFL",
  sport_name: "American Football",
  competitors: [
    { id: 11, name: "Tennessee Titans", display_name: "Titans", abbreviation: "TEN", side: "away" },
    { id: 12, name: "Indianapolis Colts", display_name: "Colts", abbreviation: "IND", side: "home" },
  ],
};

const coltsMarkets: RawMarket[] = [
  {
    id: 9001,
    name: "Moneyline",
    type: "moneyline",
    status: "open",
    selections: [
      [{ outcome_id: 1, competitor_id: 11, name: "Tennessee Titans", display_name: "Titans", display_price: "+250", price: 250, strike_id: "s-ten" }],
      [{ outcome_id: 2, competitor_id: 12, name: "Indianapolis Colts", display_name: "Colts", display_price: "-300", price: -300, strike_id: "s-ind" }],
    ],
  },
  {
    id: 9002,
    name: "Spread",
    type: "spread",
    status: "open",
    selections: [
      [{ outcome_id: 3, competitor_id: 11, name: "Tennessee Titans", display_name: "Titans +6.5", strike_id: "s-ten-sp" }],
      [{ outcome_id: 4, competitor_id: 12, name: "Indianapolis Colts", display_name: "Colts -6.5", strike_id: "s-ind-sp" }],
    ],
  },
];

interface FakeVenue {
  client: PlaysClient;
  calls: string[];
  logins: number;
}

/** the venue's partner API: /auth/login, /auth/refresh, wagers, tournaments, events, markets */
function fakeVenue(plays: RawPlay[], opts: { accessTtlSec?: number; now?: () => number; tournaments?: Array<{ id: number; name: string }> } = {}): FakeVenue {
  const calls: string[] = [];
  const state = { logins: 0, token: 0 };
  const now = opts.now ?? Date.now;
  const tournaments = opts.tournaments ?? [
    { id: 31, name: "NFL" },
    { id: 999, name: "Darts" },
  ];
  const fetchImpl: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    calls.push(path);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    if (url.pathname === "/partner/auth/login") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { access_key?: string; secret_key?: string };
      if (body.access_key !== "ak_test" || body.secret_key !== "sk_test") return json(401, { error: "unauthorized", message: "Unauthorized" });
      state.logins++;
      state.token++;
      const t = Math.floor(now() / 1000);
      return json(200, { data: { access_token: `tok-${state.token}`, access_expire_time: t + (opts.accessTtlSec ?? 600), refresh_token: `ref-${state.token}`, refresh_expire_time: t + 3 * 86400 } });
    }
    if (url.pathname === "/partner/auth/refresh") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { refresh_token?: string };
      if (body.refresh_token !== `ref-${state.token}`) return json(401, { error: "unauthorized", message: "Unauthorized" });
      state.token++;
      const t = Math.floor(now() / 1000);
      return json(200, { data: { access_token: `tok-${state.token}`, access_expire_time: t + (opts.accessTtlSec ?? 600), refresh_token: `ref-${state.token}`, refresh_expire_time: t + 3 * 86400 } });
    }
    if (auth !== `Bearer tok-${state.token}`) return json(401, { error: "unauthorized", message: "Unauthorized" });
    if (url.pathname === "/partner/v2/mm/get_wager_histories") {
      assert.equal(url.searchParams.get("status"), "open");
      return json(200, { data: { wagers: plays, next_cursor: "" }, last_synced_at: new Date(now()).toISOString() });
    }
    if (url.pathname === "/partner/mm/get_tournaments") return json(200, { data: { tournaments } });
    if (url.pathname === "/partner/mm/get_sport_events") {
      const id = url.searchParams.get("tournament_id");
      return json(200, { data: { sport_events: id === "31" ? [colts] : [] } });
    }
    if (url.pathname === "/partner/v4/mm/get_markets") {
      const id = url.searchParams.get("event_id");
      if (id === "5001") return json(200, { data: { event_id: 5001, markets: coltsMarkets } });
      return json(404, { error: "data_not_found", message: "Not found: sport_event" });
    }
    return json(404, { error: "data_not_found", message: path });
  }) as typeof fetch;
  const client = new PlaysClient({ host: "https://venue.test/partner", accessKey: "ak_test", secretKey: "sk_test", fetchImpl, now });
  return {
    client,
    calls,
    get logins() {
      return state.logins;
    },
  };
}

test("odds to payout: American outside -99..99, decimal inside, nothing else", () => {
  assert.equal(payoutMultiple(-300), 1 + 100 / 300);
  assert.equal(payoutMultiple(150), 2.5);
  assert.equal(payoutMultiple(100), 2);
  assert.equal(payoutMultiple(-100), 2);
  assert.equal(payoutMultiple(1.33), 1.33);
  assert.equal(payoutMultiple(0), null);
  assert.equal(payoutMultiple(50), null);
  assert.equal(payoutMultiple(-50), null);
  assert.equal(payoutMultiple(1), null);
  assert.equal(payoutMultiple(Number.NaN), null);
});

test("play size: matched stake at the venue's odds in our dollars-per-contract units", () => {
  // $20 at -300 wins $6.67: payout $26.67, 27 contracts at 75c
  assert.deepEqual(playSize({ stake: 20, matched_stake: 20, odds: -300, matching_status: "fully_matched" }), { contracts: 27, entryCents: 75, payoutCents: 2667, costCents: 2000 });
  // $5 at +292 pays $19.60: 20 contracts at 26c
  assert.deepEqual(playSize({ stake: 5, matched_stake: 5, odds: 292, matching_status: "fully_matched" }), { contracts: 20, entryCents: 26, payoutCents: 1960, costCents: 500 });
  // partially matched: only the matched part is a position
  assert.deepEqual(playSize({ stake: 20, matched_stake: 10, odds: 127, matching_status: "partially_matched" }), { contracts: 23, entryCents: 44, payoutCents: 2270, costCents: 1000 });
  // unmatched: a resting order, not a position
  assert.equal(playSize({ stake: 20, matched_stake: 0, odds: -300, matching_status: "unmatched" }), null);
  // no matching fields at all (older shape): the stake is taken as matched
  assert.deepEqual(playSize({ stake: 10, odds: 1.79 }), { contracts: 18, entryCents: 56, payoutCents: 1790, costCents: 1000 });
  // too small to be one contract
  assert.equal(playSize({ stake: 0.2, matched_stake: 0.2, odds: 150, matching_status: "fully_matched" }), null);
});

test("config: host, access key and secret key, all three or nothing", () => {
  assert.equal(playsConfigFromEnv({}), null);
  assert.equal(playsConfigFromEnv({ VENUE_API_HOST: "https://x/partner", VENUE_API_ACCESS_KEY: "a" }), null);
  assert.deepEqual(playsConfigFromEnv({ VENUE_API_HOST: "https://x/partner/", VENUE_API_ACCESS_KEY: " a ", VENUE_API_SECRET_KEY: "b" }), { host: "https://x/partner", accessKey: "a", secretKey: "b" });
});

test("market shape: selections flattened to outcomes named as the venue displays them", () => {
  const vm = asVenueMarket(coltsMarkets[0], colts);
  assert.equal(vm.marketId, "9001");
  assert.equal(vm.eventId, "5001");
  assert.equal(vm.marketType, "moneyline");
  assert.equal(vm.startsTs, START);
  assert.deepEqual(
    vm.outcomes.map((o) => [o.outcomeId, o.name]),
    [
      ["1", "Titans"],
      ["2", "Colts"],
    ],
  );
});

test("holderPlays: login once, read open plays, size the matched part, match to our ticker; spread and unmatched handled", async () => {
  const plays: RawPlay[] = [
    { wager_id: "w1", market_id: 9001, sport_event_id: 5001, outcome_id: 2, odds: -300, stake: 20, matched_stake: 20, unmatched_stake: 0, profit: 6.67, status: "open", matching_status: "fully_matched", winning_status: "tbd" },
    { wager_id: "w2", market_id: 9002, sport_event_id: 5001, outcome_id: 4, odds: -115, stake: 10, matched_stake: 10, unmatched_stake: 0, status: "open", matching_status: "fully_matched", winning_status: "tbd" },
    { wager_id: "w3", market_id: 9001, sport_event_id: 5001, outcome_id: 1, odds: 300, stake: 5, matched_stake: 0, unmatched_stake: 5, status: "open", matching_status: "unmatched", winning_status: "tbd" },
    { wager_id: "w4", market_id: 7777, sport_event_id: 6001, outcome_id: 9, odds: 110, stake: 4, matched_stake: 4, status: "open", matching_status: "fully_matched" },
  ];
  const v = fakeVenue(plays);
  const rows = await holderPlays(v.client, protectable);
  assert.equal(v.logins, 1);
  // the unmatched play is not a position
  assert.equal(rows.length, 3);
  const ind = rows.find((r) => r.ticker === "KXNFLGAME-26OCT18TENIND-IND");
  assert.ok(ind);
  assert.equal(ind.contracts, 27);
  assert.equal(ind.entryCents, 75);
  assert.equal(ind.payoutCents, 2667);
  assert.equal(ind.costCents, 2000);
  assert.equal(ind.side, "Colts");
  assert.equal(ind.event, "Titans @ Colts");
  assert.equal(ind.league, "nfl");
  assert.equal(ind.startsIso, new Date(START).toISOString());
  assert.equal(ind.marketType, "moneyline");
  assert.equal(ind.id.length, 16);
  const sp = rows.find((r) => r.marketType === "spread");
  assert.ok(sp);
  assert.equal(sp.ticker, null);
  assert.equal(sp.reason, "market_not_covered");
  const other = rows.find((r) => r.reason === "league_not_covered");
  assert.ok(other);
  assert.equal(other.contracts, 8);
  // nothing in the rows carries the venue's ids
  const text = JSON.stringify(rows);
  assert.equal(text.includes("9001"), false);
  assert.equal(text.includes("w1"), false);
  // the catalog was read once: a second pass hits only the plays route and no login
  const before = v.calls.length;
  await holderPlays(v.client, protectable);
  const after = v.calls.slice(before);
  assert.deepEqual(after.map((c) => c.split("?")[0]), ["/partner/v2/mm/get_wager_histories"]);
  assert.equal(v.logins, 1);
});

test("session: the token is refreshed before it lapses and re-login happens when the refresh is refused", async () => {
  let t = Date.UTC(2026, 9, 14, 12, 0, 0);
  const now = () => t;
  const v = fakeVenue([], { accessTtlSec: 600, now });
  await v.client.listOpenPlays();
  assert.equal(v.logins, 1);
  // 9.5 minutes later the token is inside the one-minute margin: refresh, not login
  t += 9.5 * 60_000;
  await v.client.listOpenPlays();
  assert.equal(v.logins, 1);
  assert.ok(v.calls.includes("/partner/auth/refresh"));
  // a venue that forgets the refresh token: the client logs in again rather than failing
  const bad = fakeVenue([], { accessTtlSec: 600, now });
  await bad.client.listOpenPlays();
  t += 9.5 * 60_000;
  // break the refresh by advancing past the refresh expiry
  t += 4 * 86_400_000;
  await bad.client.listOpenPlays();
  assert.equal(bad.logins, 2);
});

test("bad credentials surface as a venue error, not a crash, and carry the venue's code", async () => {
  const v = fakeVenue([]);
  const wrong = new PlaysClient({ host: "https://venue.test/partner", accessKey: "nope", secretKey: "nope", fetchImpl: (v.client as unknown as { fetchImpl: typeof fetch }).fetchImpl });
  await assert.rejects(() => wrong.listOpenPlays(), (err: Error & { status?: number; code?: string }) => err.status === 401 && err.code === "unauthorized");
});
