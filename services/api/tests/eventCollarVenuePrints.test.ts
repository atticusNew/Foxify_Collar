/**
 * Reference prints: an exchange with no live book, read from the day-old public tape it publishes
 * in the CFTC's format. A fake origin serves gzipped days; the shadow keeps the opposing side's
 * last print beside the live hedge's price, folds it, and says on the page that it is not a quote.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PublicPrintsClient,
  REFERENCE_PRINT_WORDS,
  indexTrades,
  jsonArrayRows,
  opposingTickerFor,
  parseWinnerTicker,
  publicPrintsSource,
  readReferencePrints,
  referencePrintSourcesFromEnv,
  type ReferencePrintSource,
} from "../src/eventCollar/crossVenue/venuePrints";
import { counterfactualsFor, type CounterfactualInputs } from "../src/eventCollar/crossVenue/shadowCounterfactuals";
import { quoteCrossWrap } from "../src/eventCollar/crossVenue/crossVenuePricer";
import { quoteLadderWrap, type NoAskLevel } from "../src/eventCollar/crossVenue/kalshiLadder";
import { DEFAULT_CROSS_CONFIG, type MatchedPair, type PmBook } from "../src/eventCollar/crossVenue/types";
import { appendShadowRecord, loadShadowPositions, summarizeCounterfactuals, summarizeShadow, type ShadowOpenRecord } from "../src/eventCollar/crossVenue/shadowLedger";
import { renderShadowReportHtml } from "../scripts/eventShadowHtml";

const LOCK = "2026-09-20T17:00:00.000Z";
const NOW = new Date("2026-09-20T11:00:00.000Z");
const CFG = { ...DEFAULT_CROSS_CONFIG, defaultTier: "tight" as const };

function pair(): MatchedPair {
  return {
    league: "mlb",
    kalshi: {
      ticker: "KXMLBGAME-26SEP20NYYBOS-NYY",
      eventTicker: "KXMLBGAME-26SEP20NYYBOS",
      seriesTicker: "KXMLBGAME",
      title: "Yankees vs Red Sox",
      subtitle: "New York",
      status: "open",
      closeTime: LOCK,
      yesBidCents: 59,
      yesAskCents: 61,
      lastPriceCents: 60,
      volume: 1000,
      openInterest: 500,
      rulesPrimary: "",
    },
    pm: {
      eventSlug: "mlb-nyy-bos-2026-09-20",
      eventTitle: "New York Yankees vs. Boston Red Sox",
      question: "New York Yankees vs. Boston Red Sox",
      conditionId: "0xdef",
      outcomes: ["Yankees", "Red Sox"],
      tokenIds: ["111", "222"],
      outcomePricesMilli: [600, 400],
      gameStartTime: LOCK,
      endDate: "2026-09-27T17:00:00Z",
      sportsMarketType: "moneyline",
      active: true,
      closed: false,
      acceptingOrders: true,
      negRisk: false,
      orderMinSizeShares: 5,
      liquidityUsd: 9000,
      volumeUsd: 100,
    },
    pmYesOutcomeIndex: 0,
    pmNoOutcomeIndex: 1,
    gameStartTime: LOCK,
    parityNote: "both venues settle on the official MLB final result for this game",
    fingerprint: "mlb:NYY:BOS:2026-09-20",
  };
}

/** the venue's rows for one day, in its own shape: cents, fractional contracts, ET timestamps */
const DAY_ROWS = [
  { ticker_name: "UDXMLBGAMEWIN_NYYBOS26SEP201300_BOS", report_ticker: "UDXMLBGAMEWIN_NYYBOS26SEP201300_BOS", date: "2026-09-19", create_ts: "2026-09-19T09:00:00.1-04:00", contracts_traded: 100, price: 38 },
  { ticker_name: "UDXMLBGAMEWIN_NYYBOS26SEP201300_BOS", report_ticker: "UDXMLBGAMEWIN_NYYBOS26SEP201300_BOS", date: "2026-09-19", create_ts: "2026-09-19T21:30:00.5-04:00", contracts_traded: 50.5, price: 41 },
  { ticker_name: "UDXMLBGAMEWIN_NYYBOS26SEP201300_BOS", report_ticker: "UDXMLBGAMEWIN_NYYBOS26SEP201300_BOS", date: "2026-09-19", create_ts: "2026-09-19T15:00:00-04:00", contracts_traded: 49.5, price: 40 },
  { ticker_name: "UDXMLBGAMEWIN_NYYBOS26SEP201300_NYY", report_ticker: "UDXMLBGAMEWIN_NYYBOS26SEP201300_NYY", date: "2026-09-19", create_ts: "2026-09-19T21:31:00-04:00", contracts_traded: 10, price: 60 },
  // a parlay, a spread and a first-half market on the same game: never a winner print
  { ticker_name: "UDXCOMBO-8241892295002598990", report_ticker: "UDXCOMBO", date: "2026-09-19", create_ts: "2026-09-19T12:00:00-04:00", contracts_traded: 700, price: 6 },
  { ticker_name: "UDXMLBSPREAD_NYYBOS26SEP201300_BOS1.5", report_ticker: "UDXMLBSPREAD_NYYBOS26SEP201300_BOS1.5", date: "2026-09-19", create_ts: "2026-09-19T12:00:00-04:00", contracts_traded: 5, price: 55 },
  { ticker_name: "UDXMLBGAMEWIN1H_NYYBOS26SEP201300_BOS", report_ticker: "UDXMLBGAMEWIN1H_NYYBOS26SEP201300_BOS", date: "2026-09-19", create_ts: "2026-09-19T12:00:00-04:00", contracts_traded: 5, price: 45 },
  // a women's league game must not read as the men's
  { ticker_name: "UDXWNBAGAMEWIN_NYLCON26SEP201900_CON", report_ticker: "UDXWNBAGAMEWIN_NYLCON26SEP201900_CON", date: "2026-09-19", create_ts: "2026-09-19T12:00:00-04:00", contracts_traded: 5, price: 45 },
  // rows the venue could publish that this module must skip, not guess at
  { ticker_name: "UDXMLBGAMEWIN_NYYBOS26SEP201300_BOS", create_ts: "2026-09-19T23:00:00-04:00", contracts_traded: 0, price: 44 },
  { ticker_name: "UDXMLBGAMEWIN_NYYBOS26SEP201300_BOS", create_ts: "2026-09-19T23:00:00-04:00", contracts_traded: 3, price: 0 },
  { ticker_name: "UDXMLBGAMEWIN_NYYBOS26SEP201300_BOS", create_ts: "not a time", contracts_traded: 3, price: 44 },
  null,
];

const gz = (body: unknown, status = 200) => new Response(gzipSync(Buffer.from(JSON.stringify(body))), { status, headers: { "content-type": "application/octet-stream" } });

// ---------------------------------------------------------------------------
// the ticker shape and the day's index
// ---------------------------------------------------------------------------

test("reference prints: winner tickers parse to league, clubs, start and outcome; everything else is left out", () => {
  const w = parseWinnerTicker("UDXNFLGAMEWIN_HOUJAX26OCT180930_JAX");
  assert.deepEqual(w, { league: "NFL", teams: "HOUJAX", startMs: Date.UTC(2026, 9, 18, 9, 30), code: "JAX" });
  assert.equal(parseWinnerTicker("UDXMLBGAMEWIN_NYYBOS26SEP201300_BOS")?.league, "MLB");
  assert.equal(parseWinnerTicker("UDXNBAGAMEWIN_BOSLAL26OCT222200_LAL")?.code, "LAL");
  assert.equal(parseWinnerTicker("UDXCOMBO-8241892295002598990"), null, "a parlay");
  assert.equal(parseWinnerTicker("UDXNFLSPREAD_HOUJAX26OCT180930_JAX3.5"), null, "a spread");
  assert.equal(parseWinnerTicker("UDXNFLGAMEWIN1H_HOUJAX26OCT180930_JAX"), null, "a first-half market");
  assert.equal(parseWinnerTicker("UDXWNBAGAMEWIN_NYLCON26SEP201900_CON"), null, "the women's league is not the men's");
  assert.equal(parseWinnerTicker("UDXNCAAMFBGAMEWIN_OSUMICH26OCT181200_OSU"), null, "a league without a template");
  assert.equal(parseWinnerTicker("UDXNFLGAMEWIN_HOUJAX26XXX180930_JAX"), null, "an unreadable month");
  assert.equal(parseWinnerTicker("NFLGAMEWIN_HOUJAX26OCT180930_JAX"), null, "no venue prefix at all");
});

test("reference prints: a day's rows index to last print, VWAP, contracts and prints per ticker, and the winner tickers by league", () => {
  const index = indexTrades("2026-09-19", DAY_ROWS);
  const bos = index.byTicker.get("UDXMLBGAMEWIN_NYYBOS26SEP201300_BOS")!;
  assert.ok(bos);
  assert.equal(bos.lastPriceCents, 41, "the last print by time, not by file order");
  assert.equal(bos.lastPrintAtIso, "2026-09-20T01:30:00.500Z");
  assert.equal(bos.dayContracts, 200);
  assert.equal(bos.prints, 3, "rows with no size, no price or no time are skipped");
  assert.equal(bos.vwapCents, Math.round(((100 * 38 + 50.5 * 41 + 49.5 * 40) / 200) * 100) / 100);
  assert.equal(bos.reportDate, "2026-09-19");
  assert.deepEqual(index.winnersByLeague.get("MLB"), ["UDXMLBGAMEWIN_NYYBOS26SEP201300_BOS", "UDXMLBGAMEWIN_NYYBOS26SEP201300_NYY"]);
  assert.equal(index.winnersByLeague.get("NBA"), undefined);
  assert.ok(!index.byTicker.has("UDXCOMBO-8241892295002598990"), "parlays, spreads and props are passed over, not kept");
  assert.equal(index.byTicker.size, 2);
});

test("reference prints: the opposing club's ticker is found by the two codes either way round, the start window and the outcome code", () => {
  const index = indexTrades("2026-09-19", DAY_ROWS);
  assert.equal(opposingTickerFor(index, pair()), "UDXMLBGAMEWIN_NYYBOS26SEP201300_BOS");
  // the venue may write home first
  const flipped = indexTrades("2026-09-19", DAY_ROWS.map((r) => (r && typeof r.ticker_name === "string" ? { ...r, ticker_name: r.ticker_name.replace("NYYBOS", "BOSNYY") } : r)));
  assert.equal(opposingTickerFor(flipped, pair()), "UDXMLBGAMEWIN_BOSNYY26SEP201300_BOS");
  // the same clubs two days later is another game
  const later = indexTrades("2026-09-19", DAY_ROWS.map((r) => (r && typeof r.ticker_name === "string" ? { ...r, ticker_name: r.ticker_name.replace("26SEP20", "26SEP23") } : r)));
  assert.equal(opposingTickerFor(later, pair()), null);
  // a pair whose league has no template is not read
  assert.equal(opposingTickerFor(index, { ...pair(), league: "cricket" }), null);
  // the second book names clubs by nickname, four letters or not
  const jets = indexTrades("2026-09-19", [{ ticker_name: "UDXNFLGAMEWIN_NYJNE26OCT181300_NYJ", create_ts: "2026-10-17T12:00:00-04:00", contracts_traded: 10, price: 25 }]);
  const ne: MatchedPair = { ...pair(), league: "nfl", kalshi: { ...pair().kalshi, ticker: "KXNFLGAME-26OCT18NYJNE-NE" }, pm: { ...pair().pm, outcomes: ["Patriots", "Jets"] }, gameStartTime: "2026-10-18T17:00:00Z" };
  assert.equal(opposingTickerFor(jets, ne), "UDXNFLGAMEWIN_NYJNE26OCT181300_NYJ");
});

// ---------------------------------------------------------------------------
// the client: one file per day, yesterday first, held when missing, decoded gzip or plain
// ---------------------------------------------------------------------------

test("reference prints: the client reads yesterday's file, falls back a day when it is not yet published, keeps the day, and holds a missing day", async () => {
  const calls: string[] = [];
  const published = new Set(["2026-09-18"]);
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    const m = /trade_data_(\d{4}-\d{2}-\d{2})\.json\.gz$/.exec(url);
    if (!m || !published.has(m[1])) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
    return gz(DAY_ROWS.map((r) => (r ? { ...r, date: m[1] } : r)));
  };
  const client = new PublicPrintsClient({ host: "https://reports.example/", fetchImpl });
  const first = await client.latestDay(NOW);
  assert.equal(first.index?.reportDate, "2026-09-18", "the 19th is not out yet; the 18th is");
  assert.equal(first.error, null);
  assert.deepEqual(calls, ["https://reports.example/reporting/trade_data_2026-09-19.json.gz", "https://reports.example/reporting/trade_data_2026-09-18.json.gz"]);

  // a second read in the same minute asks for nothing: the 19th is held, the 18th is kept
  const again = await client.latestDay(new Date(NOW.getTime() + 60_000));
  assert.equal(again.index?.reportDate, "2026-09-18");
  assert.equal(calls.length, 2);

  // once the hold lapses the 19th is asked for again, and it is out now
  published.add("2026-09-19");
  const later = await client.latestDay(new Date(NOW.getTime() + 11 * 60_000));
  assert.equal(later.index?.reportDate, "2026-09-19");
  assert.equal(calls.length, 3);

  // nothing published in the window: no index, no error (it is not a failure)
  const fresh = new PublicPrintsClient({ host: "https://reports.example", fetchImpl: async () => new Response("", { status: 404 }) });
  assert.deepEqual(await fresh.latestDay(NOW), { index: null, error: null });

  // a dropped connection is an error, and the day before is not tried behind it
  const down = new PublicPrintsClient({
    host: "https://reports.example",
    fetchImpl: async () => {
      throw new Error("ECONNRESET");
    },
  });
  const d = await down.latestDay(NOW);
  assert.equal(d.index, null);
  assert.equal(d.error, "ECONNRESET");

  // a proxy that inflated the file is read as the plain JSON it is
  const plain = new PublicPrintsClient({ host: "https://reports.example", fetchImpl: async () => new Response(JSON.stringify(DAY_ROWS), { status: 200 }) });
  assert.equal((await plain.latestDay(NOW)).index?.byTicker.size, 2);

  // the file is streamed row by row: the same answer whatever the chunking, and a bad row is skipped alone
  const bytes = Buffer.from(JSON.stringify(DAY_ROWS).replace("null]", '{"ticker_name": "UDXMLBGAMEWIN_NYYBOS26SEP201300_BOS", "price": }]'));
  for (const size of [1, 7, 64, 4096, bytes.length]) {
    const chunks = (async function* () {
      for (let i = 0; i < bytes.length; i += size) yield new Uint8Array(bytes.subarray(i, i + size));
    })();
    const rows: unknown[] = [];
    for await (const r of jsonArrayRows(chunks)) rows.push(r);
    assert.equal(rows.length, DAY_ROWS.length - 1, `chunks of ${size}: every object row, the broken one dropped`);
    assert.equal(indexTrades("2026-09-19", rows).byTicker.get("UDXMLBGAMEWIN_NYYBOS26SEP201300_BOS")?.lastPriceCents, 41);
  }
  const gzChunks = (async function* () {
    const g = gzipSync(bytes);
    for (let i = 0; i < g.length; i += 100) yield new Uint8Array(g.subarray(i, i + 100));
  })();
  let n = 0;
  for await (const _ of jsonArrayRows(gzChunks)) n += 1;
  assert.equal(n, DAY_ROWS.length - 1, "gzip is inflated on the way through");
});

test("reference prints: the source answers the opposing side's day, not_printed when the game is not on the tape, and the file's state otherwise", async () => {
  const client = new PublicPrintsClient({ host: "https://reports.example", fetchImpl: async () => gz(DAY_ROWS) });
  const src = publicPrintsSource(client);
  const hit = await src.read(pair(), NOW);
  assert.ok(hit.print, JSON.stringify(hit));
  assert.equal(hit.print.ticker, "UDXMLBGAMEWIN_NYYBOS26SEP201300_BOS");
  assert.equal(hit.print.lastPriceCents, 41);

  const other = { ...pair(), kalshi: { ...pair().kalshi, ticker: "KXMLBGAME-26SEP20NYYTOR-NYY" }, pm: { ...pair().pm, outcomes: ["Yankees", "Blue Jays"] } };
  const miss = await src.read(other, NOW);
  assert.ok(!miss.print && miss.reason === "not_printed");
  const none = await src.read({ ...pair(), league: "cricket" }, NOW);
  assert.ok(!none.print && none.reason === "league_not_covered");

  const unpublished = publicPrintsSource(new PublicPrintsClient({ host: "https://reports.example", fetchImpl: async () => new Response("", { status: 404 }) }));
  const u = await unpublished.read(pair(), NOW);
  assert.ok(!u.print && u.reason === "report_not_published");
  const down = publicPrintsSource(
    new PublicPrintsClient({
      host: "https://reports.example",
      fetchImpl: async () => {
        throw new Error("ECONNRESET");
      },
    }),
  );
  const dr = await down.read(pair(), NOW);
  assert.ok(!dr.print && dr.reason === "unreachable: ECONNRESET");
});

test("reference prints: nothing configured reads nothing; a bare host turns it on; a host that is not an origin is a note", () => {
  assert.deepEqual(referencePrintSourcesFromEnv({}), { sources: [], notes: [] });
  assert.deepEqual(referencePrintSourcesFromEnv({ REFERENCE_PRINTS_HOST: "  " }), { sources: [], notes: [] });
  const on = referencePrintSourcesFromEnv({ REFERENCE_PRINTS_HOST: "https://cftc-public-reports.example" });
  assert.equal(on.sources.length, 1);
  assert.equal(on.sources[0].id, "public_prints");
  assert.deepEqual(on.notes, []);
  const bad = referencePrintSourcesFromEnv({ REFERENCE_PRINTS_HOST: "reports.example" });
  assert.equal(bad.sources.length, 0);
  assert.match(bad.notes[0], /must be an http\(s\) origin; off/);
});

test("reference prints: readReferencePrints runs every source and turns a throw into an unreachable reason", async () => {
  const ok: ReferencePrintSource = { id: "public_prints", read: async () => ({ id: "public_prints", print: indexTrades("2026-09-19", DAY_ROWS).byTicker.get("UDXMLBGAMEWIN_NYYBOS26SEP201300_BOS")! }) };
  const down: ReferencePrintSource = {
    id: "public_prints",
    read: async () => {
      throw new Error("boom");
    },
  };
  const out = await readReferencePrints([ok, down], pair(), NOW);
  assert.ok(out[0].print);
  assert.ok(!out[1].print && out[1].reason === "unreachable: boom");
  assert.deepEqual(await readReferencePrints([], pair(), NOW), []);
});

// ---------------------------------------------------------------------------
// the shadow: the print beside the live hedge's price, folded, and said plainly on the page
// ---------------------------------------------------------------------------

const NO_ASKS: NoAskLevel[] = [
  { priceCents: 41, qtyMilli: 300_000 },
  { priceCents: 42, qtyMilli: 400_000 },
];
const PM_NO_BOOK: PmBook = { tokenId: "222", asks: [{ priceMilli: 380, sizeMilli: 300_000 }, { priceMilli: 390, sizeMilli: 500_000 }], bids: [], minOrderSizeShares: 5, tickMilli: 10 };

function inputs(overrides: Partial<CounterfactualInputs> = {}): CounterfactualInputs {
  return {
    route: "polymarket",
    ticker: "KXMLBGAME-26SEP20NYYBOS-NYY",
    lockTimeIso: LOCK,
    pair: pair(),
    markCents: 60,
    entryCents: 55,
    contracts: 150,
    now: NOW,
    config: CFG,
    books: { pmNoBook: PM_NO_BOOK, noAsks: NO_ASKS },
    ...overrides,
  };
}

const PRINT = indexTrades("2026-09-19", DAY_ROWS).byTicker.get("UDXMLBGAMEWIN_NYYBOS26SEP201300_BOS")!;

test("reference prints: counterfactualsFor keeps the print beside the live hedge's own price and never prices it as a route", () => {
  const live = quoteCrossWrap({ pair: pair(), markCents: 60, entryCents: 55, contracts: 150, now: NOW, noBook: PM_NO_BOOK, config: CFG });
  assert.ok(live.ok);
  const cf = counterfactualsFor(inputs({ books: { pmNoBook: PM_NO_BOOK, noAsks: NO_ASKS, prints: [{ id: "public_prints", print: PRINT }] } }), live);
  assert.ok(cf.prints && cf.prints.length === 1);
  const p = cf.prints[0];
  assert.ok(p.ok, JSON.stringify(p));
  assert.equal(p.lastPriceCents, 41);
  assert.equal(p.vwapCents, PRINT.vwapCents);
  assert.equal(p.dayContracts, 200);
  assert.equal(p.prints, 3);
  assert.equal(p.reportDate, "2026-09-19");
  assert.equal(p.printedAtIso, "2026-09-20T01:30:00.500Z");
  assert.equal(p.ageHours, 9.5, "01:30 to 11:00");
  const liveAvg = live.hedge.venue === "polymarket" ? live.hedge.avgPriceMilli / 10 : NaN;
  assert.equal(p.liveHedgeAvgCents, Math.round(liveAvg * 10) / 10);
  assert.equal(p.gapCents, Math.round((41 - p.liveHedgeAvgCents) * 10) / 10);
  assert.ok(p.gapCents > 0, "the venue last printed above the second book's walked average");
  assert.ok(!("terms" in p), "a print carries no terms: nothing could have been filled at it");
  // the route written is the market's own No side: its average is in cents already
  const ladder = quoteLadderWrap({ pair: { kalshi: { ticker: "KXMLBGAME-26SEP20NYYBOS-NYY" }, gameStartTime: LOCK }, markCents: 60, entryCents: 55, contracts: 150, now: NOW, noAsks: NO_ASKS, config: CFG });
  assert.ok(ladder.ok && ladder.hedge.venue === "kalshi");
  const cfK = counterfactualsFor(inputs({ route: "kalshi_self", books: { pmNoBook: PM_NO_BOOK, noAsks: NO_ASKS, prints: [{ id: "public_prints", print: PRINT }] } }), ladder);
  assert.ok(cfK.prints![0].ok && cfK.prints![0].liveHedgeAvgCents === ladder.hedge.avgPriceCents);
  // not printed keeps the reason; nothing read, the field is absent as on every record before
  const cf2 = counterfactualsFor(inputs({ books: { pmNoBook: PM_NO_BOOK, prints: [{ id: "public_prints", print: null, reason: "not_printed" }] } }), live);
  assert.deepEqual(cf2.prints, [{ id: "public_prints", ok: false, reason: "not_printed" }]);
  assert.equal(counterfactualsFor(inputs(), live).prints, undefined);
  assert.equal(counterfactualsFor(inputs({ books: { pmNoBook: PM_NO_BOOK, prints: [] } }), live).prints, undefined);
});

test("reference prints: the routing comparison counts printed apart from not, averages the gap and the age, and the page calls it a sign, not a quote", () => {
  const live = quoteCrossWrap({ pair: pair(), markCents: 60, entryCents: 55, contracts: 150, now: NOW, noBook: PM_NO_BOOK, config: CFG });
  assert.ok(live.ok);
  const cheaper = { ...PRINT, lastPriceCents: 30 };
  const withPrint = counterfactualsFor(inputs({ books: { pmNoBook: PM_NO_BOOK, noAsks: NO_ASKS, prints: [{ id: "public_prints", print: PRINT }] } }), live);
  const withCheaper = counterfactualsFor(inputs({ books: { pmNoBook: PM_NO_BOOK, noAsks: NO_ASKS, prints: [{ id: "public_prints", print: cheaper }] } }), live);
  const unprinted = counterfactualsFor(inputs({ books: { pmNoBook: PM_NO_BOOK, noAsks: NO_ASKS, prints: [{ id: "public_prints", print: null, reason: "report_not_published" }] } }), live);
  const before = counterfactualsFor(inputs(), live);
  const g1 = withPrint.prints![0];
  const g2 = withCheaper.prints![0];
  assert.ok(g1.ok && g2.ok);

  const dir = mkdtempSync(join(tmpdir(), "shadow-prints-"));
  const path = join(dir, "ledger.jsonl");
  const open = (ticker: string, at: string, cf: typeof withPrint, extra: Partial<ShadowOpenRecord> = {}): ShadowOpenRecord => ({
    type: "open",
    at,
    ticker,
    kind: "sports",
    league: "mlb",
    sideName: "Yankees",
    eventTitle: "Yankees to win",
    eventTimeIso: LOCK,
    contracts: 150,
    markCents: 60,
    floorCents: live.floorCents,
    capCents: live.capCents,
    creditCents: live.creditCents,
    evCostBps: live.evCostBps,
    route: "polymarket",
    feesCents: live.feesCents,
    takeCents: live.takeCents,
    hedgeCostCents: live.hedge.costCents + live.feesCents,
    hedgeUnitsMilli: live.hedge.venue === "polymarket" ? live.hedge.sharesMilli : 0,
    tier: live.tier,
    takeRule: live.takeRule,
    takeShareCents: live.takeShareCents,
    takeMinimumCents: live.takeMinimumCents,
    counterfactuals: cf,
    ...extra,
  });
  appendShadowRecord(path, open("P-RICHER", "2026-09-20T11:00:00.000Z", withPrint));
  appendShadowRecord(path, open("P-CHEAPER", "2026-09-20T11:01:00.000Z", withCheaper));
  appendShadowRecord(path, open("P-NONE", "2026-09-20T11:02:00.000Z", unprinted));
  appendShadowRecord(path, open("BEFORE", "2026-09-20T10:00:00.000Z", before));
  appendShadowRecord(path, open("CRYPTO", "2026-09-20T11:03:00.000Z", withPrint, { kind: "crypto", league: "crypto", route: "kalshi_self" }));

  const positions = loadShadowPositions(path);
  const r = summarizeCounterfactuals(positions).routes;
  assert.equal(r.prints.length, 1);
  const row = r.prints[0];
  assert.equal(row.id, "public_prints");
  assert.equal(row.positions, 3, "three sports opens read the tape; the record before it and the crypto strike are out");
  assert.equal(row.printed, 2);
  assert.equal(row.unprinted, 1);
  assert.equal(row.richer, 1);
  assert.equal(row.cheaper, 1);
  assert.equal(row.avgGapCents, Math.round(((g1.gapCents + g2.gapCents) / 2) * 10) / 10);
  assert.equal(row.avgAgeHours, 9.5);
  assert.equal(row.avgDayContracts, 200);
  assert.ok(!("quoted" in row) && !("refused" in row), "a print is never folded as a rule book: it quotes nothing");

  const s = summarizeShadow(positions);
  const html = renderShadowReportHtml({ atIso: "2026-09-21T00:00:00.000Z", summary: s });
  assert.ok(html.includes("<h2>Routing, measured</h2>"));
  assert.ok(html.includes(`${REFERENCE_PRINT_WORDS.public_prints} had printed the opposing side of 2 of the 3 games it was read for`));
  assert.ok(html.includes("(1 richer, 1 cheaper)"));
  assert.ok(html.includes("about 200 contracts traded that day, the print 9.5 hours old at the quote"));
  assert.ok(html.includes("a sign of where that venue trades, not a quote"));
  assert.ok(html.includes("Reference prints come from a regulated US exchange that publishes no live book"));
  assert.ok(!html.includes(`<td>${REFERENCE_PRINT_WORDS.public_prints}`), "no row in the rule table: a row would read as a hedge priced there");
  assert.doesNotMatch(html, /underdog|udx/i, "the page never names the venue");
  assert.doesNotMatch(html, /\u2014/, "no em dashes");
  assert.doesNotMatch(JSON.stringify(positions), /underdog|udx/i, "the record carries the print, never the venue's ticker");
  // a record with no prints renders the card as before
  const plain = renderShadowReportHtml({ atIso: "2026-09-21T00:00:00.000Z", summary: summarizeShadow(loadShadowPositions(path).filter((p) => p.ticker === "BEFORE")) });
  assert.ok(!plain.includes("reference prints"));
});
