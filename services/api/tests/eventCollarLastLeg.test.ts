/**
 * Last-leg shadow: the public combo catalog and Gamma readers, the ticket
 * arithmetic, the deterministic ticket builder, the collar on the compressed
 * position, the ledger replay with its identity, the summary, the CSV, one
 * full tick against an in-memory venue, and the report card.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTickets,
  comboPriceMilli,
  compressedContracts,
  lastLegConfigFromEnv,
  lastLegCsv,
  legCandidates,
  marketForLeg,
  momentRecord,
  protectedPerContract,
  quoteLastLeg,
  replayLastLeg,
  runLastLegTick,
  type RoutedQuote,
  sharesFor,
  summarizeLastLeg,
  ticketIdFor,
  ticketValueCents,
  DEFAULT_LAST_LEG_CONFIG,
  type LastLegRecord,
  type LastLegTicketRecord,
  type LegCandidate,
} from "../src/eventCollar/crossVenue/lastLeg";
import { getComboLegStatus, legStatusFromGamma, parseComboMarket, type ComboLegMarket, type ComboLegStatus } from "../src/eventCollar/crossVenue/polymarketCombos";
import { lastLegCard } from "../scripts/eventShadowHtml";
import { type CrossHedgeLeg, DEFAULT_CROSS_CONFIG, PARLAY_LAST_PICK_TIER, type PmBook } from "../src/eventCollar/crossVenue/types";

// ── fixtures ──────────────────────────────────────────────────────────────────

const FRI_NOON = Date.UTC(2026, 9, 9, 12, 0, 0); // Fri 2026-10-09 12:00Z
const SAT_13 = Date.UTC(2026, 9, 10, 13, 0, 0);
const SAT_16 = Date.UTC(2026, 9, 10, 16, 0, 0);
const SAT_20 = Date.UTC(2026, 9, 10, 20, 0, 0);
const SUN_20 = Date.UTC(2026, 9, 11, 20, 0, 0); // the late game: a full day after the Saturday slate
const iso = (ms: number): string => new Date(ms).toISOString();

const catalogRow = (slug: string, cond: string, prices: [string, string], volume: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "1",
  condition_id: cond,
  position_ids: [`${cond}-yes`, `${cond}-no`],
  pending: false,
  slug,
  title: slug,
  outcomes: ["Away", "Home"],
  outcome_prices: prices,
  volume,
  tags: ["sports", "nfl", "games"],
  ...over,
});

const gammaRow = (slug: string, cond: string, startMs: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  slug,
  conditionId: cond,
  question: slug,
  outcomes: '["Away", "Home"]',
  outcomePrices: '["0.7", "0.3"]',
  clobTokenIds: `["${cond}-t0", "${cond}-t1"]`,
  gameStartTime: new Date(startMs).toISOString().replace("T", " ").replace(".000Z", "+00"),
  sportsMarketType: "moneyline",
  closed: false,
  active: true,
  umaResolutionStatus: "",
  ...over,
});

const resolvedRow = (slug: string, cond: string, startMs: number, prices: string): Record<string, unknown> =>
  gammaRow(slug, cond, startMs, { closed: true, umaResolutionStatus: "resolved", outcomePrices: prices });

/** A deep NO book at one price (milli). */
const noBook = (tokenId: string, askMilli: number, sizeShares = 100_000): PmBook => ({
  tokenId,
  asks: [{ priceMilli: askMilli, sizeMilli: sizeShares * 1000 }],
  bids: [{ priceMilli: askMilli - 20, sizeMilli: sizeShares * 1000 }],
  minOrderSizeShares: 5,
  tickMilli: 10,
});

const cand = (cond: string, startMs: number, priceMilli: number, volume: number, side: 0 | 1 = 0): LegCandidate => ({
  conditionId: cond,
  slug: `nfl-${cond}-2026-10-10`,
  title: cond,
  league: "nfl",
  side,
  outcome: side === 0 ? "Away" : "Home",
  priceMilli,
  yesTokenId: `${cond}-t${side}`,
  noTokenId: `${cond}-t${1 - side}`,
  gameStartIso: iso(startMs),
  gameStartMs: startMs,
  volumeUsd: volume,
});

// ── readers ───────────────────────────────────────────────────────────────────

test("parseComboMarket: the public catalog row becomes a leg with its league and game date; pending or one-sided rows are dropped", () => {
  const m = parseComboMarket(catalogRow("nfl-tb-dal-2026-10-09", "0xabc", ["0.195", "0.805"], 1234.5));
  assert.ok(m);
  assert.equal(m.league, "nfl");
  assert.equal(m.slugDate, "2026-10-09");
  assert.deepEqual(m.pricesMilli, [195, 805]);
  assert.deepEqual(m.positionIds, ["0xabc-yes", "0xabc-no"]);
  assert.equal(m.volumeUsd, 1234.5);
  const longDated = parseComboMarket(catalogRow("will-the-us-invade-iran-before-2027", "0x1", ["0.155", "0.845"], 1));
  assert.ok(longDated);
  assert.equal(longDated.slugDate, null, "no game date on a long-dated market");
  assert.equal(longDated.league, "will");
  assert.equal(parseComboMarket(catalogRow("x-2026-10-09", "0x2", ["0.5", "0.5"], 1, { pending: true })), null);
  assert.equal(parseComboMarket({ ...catalogRow("x-2026-10-09", "0x3", ["0.5", "0.5"], 1), position_ids: ["only-one"] }), null);
});

test("legStatusFromGamma: open, resolved 1/0, closed-but-proposed (not resolved), and a partial settlement", () => {
  const open = legStatusFromGamma(gammaRow("nfl-a-b-2026-10-10", "0xa", SAT_13));
  assert.equal(open.resolved, false);
  assert.equal(open.valueMilli, null);
  assert.equal(open.gameStartIso, iso(SAT_13));
  assert.equal(open.yesPriceMilli, 700);
  assert.deepEqual(open.tokenIds, ["0xa-t0", "0xa-t1"]);
  const won = legStatusFromGamma(resolvedRow("nfl-a-b-2026-10-10", "0xa", SAT_13, '["1", "0"]'));
  assert.equal(won.resolved, true);
  assert.equal(won.valueMilli, 1000);
  const lost = legStatusFromGamma(resolvedRow("nfl-a-b-2026-10-10", "0xa", SAT_13, '["0", "1"]'));
  assert.equal(lost.valueMilli, 0);
  const proposed = legStatusFromGamma(gammaRow("nfl-a-b-2026-10-10", "0xa", SAT_13, { closed: true, umaResolutionStatus: "proposed", outcomePrices: '["1", "0"]' }));
  assert.equal(proposed.resolved, false, "a proposal is not a result");
  assert.equal(proposed.closed, true);
  const half = legStatusFromGamma(resolvedRow("nfl-a-b-2026-10-10", "0xa", SAT_13, '["0.5", "0.5"]'));
  assert.equal(half.valueMilli, 500, "the venue's partial settlement rides as a value");
});

test("getComboLegStatus: a played leg leaves Gamma's open list, so it is read again among the closed; an unknown slug is null", async () => {
  const played = resolvedRow("nfl-tb-dal-2026-10-09", "0xdal", SAT_13, '["1", "0"]');
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const closed = url.includes("closed=true");
    const slug = new URL(url).searchParams.get("slug");
    const rows = slug === "nfl-tb-dal-2026-10-09" && closed ? [played] : slug === "nfl-open-2026-10-10" && !closed ? [gammaRow(slug, "0xo", SAT_13)] : [];
    return new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const resolved = await getComboLegStatus("nfl-tb-dal-2026-10-09", fetchImpl);
  assert.ok(resolved);
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.valueMilli, 1000);
  assert.equal(urls.length, 2, "open list first, then the closed list");
  assert.match(urls[1], /slug=nfl-tb-dal-2026-10-09&closed=true$/);

  urls.length = 0;
  const open = await getComboLegStatus("nfl-open-2026-10-10", fetchImpl);
  assert.equal(open?.resolved, false);
  assert.equal(urls.length, 1, "an open market needs one read");

  assert.equal(await getComboLegStatus("no-such-market", fetchImpl), null);
});

// ── arithmetic ────────────────────────────────────────────────────────────────

test("ticket arithmetic: price is the legs multiplied, shares are the stake over it, the compressed position is shares x decided product", () => {
  assert.equal(comboPriceMilli([700, 600, 800]), 336);
  assert.equal(comboPriceMilli([700]), 700);
  assert.equal(comboPriceMilli([0, 500]), 1, "never below one milli");
  assert.equal(sharesFor(2_000, 336), 59_523, "$20 at $0.336 buys 59.523 shares, rounded down");
  assert.equal(ticketValueCents(59_523, 1000), 5_952, "$59.52 if every leg hits");
  assert.equal(ticketValueCents(59_523, 336), 1_999, "worth the stake at the quoted price, less rounding");
  assert.equal(compressedContracts(59_523, 1000), 59, "two legs hit outright: 59 contracts of the last leg");
  assert.equal(compressedContracts(59_523, 700), 41, "a no-show leg settled at 0.70 scales the whole ticket");
  assert.equal(protectedPerContract(1000, 50, 75), 75);
  assert.equal(protectedPerContract(0, 50, 75), 50);
  assert.equal(protectedPerContract(600, 50, 75), 60, "a partial last leg pays its value inside the collar");
  assert.equal(protectedPerContract(900, 50, 75), 75, "clamped at the cap");
});

test("ticketIdFor: order-independent and side-aware", () => {
  const a = ticketIdFor([{ conditionId: "x", side: 0 }, { conditionId: "y", side: 1 }]);
  const b = ticketIdFor([{ conditionId: "y", side: 1 }, { conditionId: "x", side: 0 }]);
  const c = ticketIdFor([{ conditionId: "x", side: 1 }, { conditionId: "y", side: 1 }]);
  assert.equal(a, b);
  assert.notEqual(a, c, "the other side of a leg is a different ticket");
  assert.match(a, /^ll_[0-9a-f]{12}$/);
});

// ── candidates and the builder ────────────────────────────────────────────────

test("legCandidates: sports moneylines in the window with a favourite side; the bettor's side is the favourite, the hedge token is the other", () => {
  const cfg = DEFAULT_LAST_LEG_CONFIG;
  const mk = (slug: string, cond: string, prices: [string, string], startMs: number, statusOver: Record<string, unknown> = {}, catOver: Record<string, unknown> = {}) => ({
    market: parseComboMarket(catalogRow(slug, cond, prices, 10, catOver)) as ComboLegMarket,
    status: legStatusFromGamma(gammaRow(slug, cond, startMs, statusOver)) as ComboLegStatus,
  });
  const rows = [
    mk("nfl-a-2026-10-10", "A", ["0.7", "0.3"], SAT_13),
    mk("nfl-b-2026-10-10", "B", ["0.35", "0.65"], SAT_16), // the home side is the favourite
    mk("nfl-c-2026-10-10", "C", ["0.5", "0.5"], SAT_20), // no favourite
    mk("nfl-d-2026-10-10", "D", ["0.8", "0.2"], SAT_20, { sportsMarketType: "spread" }), // not a moneyline
    mk("nba-e-2026-10-10", "E", ["0.6", "0.4"], FRI_NOON + 30 * 60_000), // starts in 30m: under the lead
    mk("nfl-f-2026-10-10", "F", ["0.6", "0.4"], SAT_13, { closed: true, umaResolutionStatus: "resolved", outcomePrices: '["1","0"]' }),
    mk("dota2-g-2026-10-10", "G", ["0.6", "0.4"], SAT_13), // not an accepted league
  ];
  const out = legCandidates(rows, cfg, FRI_NOON);
  assert.deepEqual(out.map((c) => c.conditionId), ["A", "B"]);
  assert.equal(out[0].side, 0);
  assert.equal(out[0].noTokenId, "A-t1");
  assert.equal(out[1].side, 1);
  assert.equal(out[1].outcome, "Home");
  assert.equal(out[1].priceMilli, 650);
  assert.equal(out[1].noTokenId, "B-t0", "the hedge for a home favourite is the away token");
});

test("buildTickets: the latest game is the last leg, the biggest earlier games fill the rest, nothing is rebuilt, caps hold", () => {
  const cfg = { ...DEFAULT_LAST_LEG_CONFIG, legCounts: [2, 3], ticketsPerSize: 2, stakeCents: 2_000, maxPerGame: 10 };
  const cands = [cand("A", SAT_13, 700, 500), cand("B", SAT_16, 650, 900, 1), cand("C", SAT_20, 800, 300), cand("D", SUN_20, 600, 1000)];
  const built = buildTickets(cands, cfg, [], iso(FRI_NOON), 10);
  // size 2: D last with B (biggest), then C last with B (A and B start >= 4h before C's 20:00); size 3: D + B + A, then C + A + B
  assert.equal(built.length, 4);
  const two = built.filter((t) => t.legs.length === 2);
  assert.deepEqual(two[0].legs.map((l) => l.conditionId), ["B", "D"]);
  assert.deepEqual(two[1].legs.map((l) => l.conditionId), ["B", "C"]);
  const three = built.filter((t) => t.legs.length === 3);
  assert.deepEqual(three[0].legs.map((l) => l.conditionId), ["A", "B", "D"], "legs in start order, last leg last");
  assert.deepEqual(three[1].legs.map((l) => l.conditionId), ["A", "B", "C"]);
  assert.equal(two[0].comboPriceMilli, 390);
  assert.equal(two[0].sharesMilli, sharesFor(2_000, 390));
  assert.equal(two[0].legs[1].gameStartIso, iso(SUN_20));
  // Already on the ledger: not rebuilt. Room: the ceiling binds.
  const asOpen = built.map((t) => ({ ticketId: t.ticketId, status: "open" as const, legs: t.legs }));
  const again = buildTickets(cands, cfg, asOpen, iso(FRI_NOON), 10);
  assert.equal(again.length, 0);
  assert.equal(buildTickets(cands, cfg, [], iso(FRI_NOON), 1).length, 1);
  // The per-size ceiling counts undecided tickets, not ids: with the first two size-2 tickets still
  // open, a fresh slate builds nothing of size 2 even though its ids are new; once one of them has
  // settled, exactly one slot of that size frees up.
  const fresh = [cand("E", SAT_13, 700, 500), cand("F", SUN_20, 600, 1000)];
  assert.equal(buildTickets(fresh, { ...cfg, legCounts: [2] }, asOpen, iso(FRI_NOON), 10).length, 0);
  const oneSettled = asOpen.map((t, i) => (i === 0 && t.legs.length === 2 ? { ...t, status: "settled" as const } : t));
  const refill = buildTickets(fresh, { ...cfg, legCounts: [2] }, oneSettled, iso(FRI_NOON), 10);
  assert.equal(refill.length, 1);
  assert.deepEqual(refill[0].legs.map((l) => l.conditionId), ["E", "F"]);
  // A gap rule the slate cannot satisfy builds nothing.
  assert.equal(buildTickets(cands, { ...cfg, minGapMs: 48 * 3_600_000 }, [], iso(FRI_NOON), 10).length, 0);
});

test("buildTickets: no game sits on more than maxPerGame undecided tickets, counting the ones already on the ledger", () => {
  const cands = [cand("A", SAT_13, 700, 500), cand("B", SAT_16, 650, 900, 1), cand("C", SAT_20, 800, 300), cand("D", SUN_20, 600, 1000)];
  const legIds = (t: { legs: Array<{ conditionId: string }> }) => t.legs.map((l) => l.conditionId);
  // Unlimited, the biggest market (B) is on every ticket: one upset there would bust the whole board.
  const loose = buildTickets(cands, { ...DEFAULT_LAST_LEG_CONFIG, legCounts: [2], ticketsPerSize: 4, maxPerGame: 10 }, [], iso(FRI_NOON), 10);
  assert.deepEqual(loose.map(legIds), [["B", "D"], ["B", "C"]]);
  // Capped at one ticket per game, the second ticket takes the next market instead.
  const capped = buildTickets(cands, { ...DEFAULT_LAST_LEG_CONFIG, legCounts: [2], ticketsPerSize: 4, maxPerGame: 1 }, [], iso(FRI_NOON), 10);
  assert.deepEqual(capped.map(legIds), [["B", "D"], ["A", "C"]]);
  // Tickets already in play count against the cap; decided ones do not.
  const open = [{ ticketId: loose[0].ticketId, status: "open" as const, legs: loose[0].legs }];
  assert.deepEqual(buildTickets(cands, { ...DEFAULT_LAST_LEG_CONFIG, legCounts: [2], ticketsPerSize: 4, maxPerGame: 1 }, open, iso(FRI_NOON), 10).map(legIds), [["A", "C"]]);
  const busted = [{ ...open[0], status: "busted" as const }];
  assert.deepEqual(buildTickets(cands, { ...DEFAULT_LAST_LEG_CONFIG, legCounts: [2], ticketsPerSize: 4, maxPerGame: 1 }, busted, iso(FRI_NOON), 10).map(legIds), [["B", "C"]], "the busted ticket is never rebuilt, but its games are free again: B now leads a new ticket");
  assert.equal(DEFAULT_LAST_LEG_CONFIG.maxPerGame, 3);
  assert.equal(lastLegConfigFromEnv({ EVENT_LASTLEG_MAX_PER_GAME: "0" }).maxPerGame, 1, "never below one");
  assert.equal(lastLegConfigFromEnv({ EVENT_LASTLEG_MAX_PER_GAME: "2" }).maxPerGame, 2);
});

// ── the collar on the compressed position ─────────────────────────────────────

test("quoteLastLeg: a favourite last leg with a tight NO book funds a credit; the hedge is sized leg for leg and the identity is exact", () => {
  const q = quoteLastLeg({ contracts: 59, markCents: 70, entryCents: 34, minutesToStart: 600, noBook: noBook("D-t1", 310), noOutcome: "Home", config: DEFAULT_CROSS_CONFIG });
  assert.ok(q.ok, q.ok ? "" : q.detail);
  if (!q.ok) return;
  assert.ok(q.creditCents > 0);
  assert.ok(q.floorCents < 70 && q.capCents > 70);
  const hedge = q.hedge as { sharesMilli: number; costCents: number };
  assert.equal(hedge.sharesMilli, (q.floorCents + 100 - q.capCents) * 59 * 10, "NO shares = the digital the writer owes in the NO state");
  const funding = (100 - q.capCents) * 59;
  assert.equal(funding - hedge.costCents - q.feesCents - q.takeCents, q.creditCents, "funding - hedge - fees - take = credit");
  assert.ok(q.tiers.tight || q.tiers.balanced || q.tiers.wide);
  assert.ok(q.candidatesConsidered > 0);
  // the ticket heads with the highest floor, not the live book's default (Max upside): the holder
  // weighs the lock against cash-out, so the guaranteed figure leads; the other shapes ride along
  assert.equal(DEFAULT_CROSS_CONFIG.defaultTier, "wide", "the single's default is still the most upside");
  assert.equal(q.tier, "tight");
  assert.equal(q.floorCents, Math.max(...Object.values(q.tiers).map((t) => t.floorCents)), "no funded shape guarantees more");
  if (q.tiers.wide) assert.ok(q.tiers.wide.floorCents < q.floorCents && q.tiers.wide.capCents > q.capCents, "Max upside still offered under it");
});

test("quoteLastLeg: honest refusals — under one contract, too close to kickoff, mark out of band, empty book, unfundable book", () => {
  const base = { contracts: 59, markCents: 70, entryCents: 34, minutesToStart: 600, noBook: noBook("D-t1", 310), noOutcome: "Home", config: DEFAULT_CROSS_CONFIG };
  const none = quoteLastLeg({ ...base, contracts: 0 });
  assert.equal(none.ok, false);
  if (!none.ok) assert.equal(none.code, "credit_nonpositive");
  const late = quoteLastLeg({ ...base, minutesToStart: 5 });
  assert.equal(late.ok, false);
  if (!late.ok) assert.equal(late.code, "market_too_close_to_start");
  const rich = quoteLastLeg({ ...base, markCents: 95 });
  assert.equal(rich.ok, false);
  if (!rich.ok) assert.equal(rich.code, "mark_out_of_range");
  const empty = quoteLastLeg({ ...base, noBook: { ...noBook("D-t1", 310), asks: [] } });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.code, "pm_book_empty");
  // A NO ask far above fair (0.55 against a 0.30 fair) funds nothing.
  const wide = quoteLastLeg({ ...base, noBook: noBook("D-t1", 550) });
  assert.equal(wide.ok, false);
  if (!wide.ok) assert.equal(wide.code, "credit_nonpositive");
});

// ── replay, outcome, summary, csv ─────────────────────────────────────────────

const ticketRec = (id: string, legs: Array<[string, number, 0 | 1, number]>, at = iso(FRI_NOON)): LastLegTicketRecord => {
  const price = comboPriceMilli(legs.map((l) => l[1]));
  return {
    type: "ticket",
    at,
    ticketId: id,
    stakeCents: 2_000,
    legs: legs.map(([cond, priceMilli, side, startMs]) => ({
      conditionId: cond,
      slug: `nfl-${cond}`,
      title: cond,
      league: "nfl",
      side,
      outcome: side === 0 ? "Away" : "Home",
      priceMilli,
      yesTokenId: `${cond}-t${side}`,
      noTokenId: `${cond}-t${1 - side}`,
      gameStartIso: iso(startMs),
    })),
    comboPriceMilli: price,
    sharesMilli: sharesFor(2_000, price),
  };
};
const lines = (recs: LastLegRecord[]): string[] => recs.map((r) => JSON.stringify(r));

test("replay: legs hit, the moment opens, the first priced quote wins, the last leg settles and the writer keeps exactly the take", () => {
  const t = ticketRec("ll_one", [["A", 700, 0, SAT_13], ["B", 650, 1, SAT_16], ["D", 600, 0, SUN_20]]);
  const contracts = compressedContracts(t.sharesMilli, 1000);
  const q = quoteLastLeg({ contracts, markCents: 60, entryCents: Math.ceil(2_000 / contracts), minutesToStart: 600, noBook: noBook("D-t1", 410), noOutcome: "Home", config: DEFAULT_CROSS_CONFIG });
  assert.ok(q.ok, q.ok ? "" : q.detail);
  if (!q.ok) return;
  const base = { ticketId: "ll_one", minutesToStart: 600, decidedProductMilli: 1000, contracts, markCents: 60, entryCents: Math.ceil(2_000 / contracts) };
  const refusal = momentRecord({ ...base, at: iso(SUN_20 - 12 * 3_600_000) }, { ok: false, code: "pm_book_empty", detail: "no asks" });
  const quote = momentRecord({ ...base, at: iso(SUN_20 - 10 * 3_600_000) }, q);
  const second = momentRecord({ ...base, at: iso(SUN_20 - 9 * 3_600_000) }, { ...q, creditCents: 1 });

  const open = replayLastLeg(lines([t]));
  assert.equal(open[0].status, "open");
  const oneHit = replayLastLeg(lines([t, { type: "leg", at: iso(SAT_16), ticketId: "ll_one", conditionId: "A", valueMilli: 1000 }]));
  assert.equal(oneHit[0].status, "open");
  const bothHit = replayLastLeg(
    lines([
      t,
      { type: "leg", at: iso(SAT_16), ticketId: "ll_one", conditionId: "A", valueMilli: 1000 },
      { type: "leg", at: iso(SAT_20), ticketId: "ll_one", conditionId: "B", valueMilli: 1000 },
    ]),
  );
  assert.equal(bothHit[0].status, "last_leg");
  assert.equal(bothHit[0].decidedProductMilli, 1000);

  const quoted = replayLastLeg(
    lines([
      t,
      { type: "leg", at: iso(SAT_16), ticketId: "ll_one", conditionId: "A", valueMilli: 1000 },
      { type: "leg", at: iso(SAT_20), ticketId: "ll_one", conditionId: "B", valueMilli: 1000 },
      refusal,
      quote,
      second,
    ]),
  );
  assert.equal(quoted[0].attempts, 3);
  assert.deepEqual(quoted[0].refusals, { pm_book_empty: 1 });
  assert.equal(quoted[0].quote?.creditCents, q.creditCents, "the first priced quote is the one the ticket settles on");

  for (const [value, result] of [
    [1000, "yes"],
    [0, "no"],
  ] as const) {
    const settled = replayLastLeg(
      lines([
        t,
        { type: "leg", at: iso(SAT_16), ticketId: "ll_one", conditionId: "A", valueMilli: 1000 },
        { type: "leg", at: iso(SAT_20), ticketId: "ll_one", conditionId: "B", valueMilli: 1000 },
        quote,
        { type: "leg", at: iso(SUN_20 + 4 * 3_600_000), ticketId: "ll_one", conditionId: "D", valueMilli: value },
      ]),
    )[0];
    assert.equal(settled.status, "settled");
    assert.equal(settled.outcome?.result, result);
    const expectedProtected = (result === "yes" ? q.capCents : q.floorCents) * contracts + q.creditCents;
    assert.equal(settled.outcome?.protectedCents, expectedProtected);
    assert.equal(settled.outcome?.nakedCents, result === "yes" ? contracts * 100 : 0);
    assert.equal(settled.outcome?.writerCents, q.takeCents, `writer = take when the last leg settles ${result}`);
  }
});

test("replay: a lost early leg busts the ticket (no moment), a partial leg shrinks the position, a void closes it, scalar last leg pays inside the collar", () => {
  const t = ticketRec("ll_two", [["A", 700, 0, SAT_13], ["B", 650, 1, SAT_16], ["D", 600, 0, SUN_20]]);
  const busted = replayLastLeg(lines([t, { type: "leg", at: iso(SAT_16), ticketId: "ll_two", conditionId: "A", valueMilli: 0 }]))[0];
  assert.equal(busted.status, "busted");
  assert.equal(busted.bustedAt, iso(SAT_16));
  // Later records on a busted ticket are ignored.
  const after = replayLastLeg(lines([t, { type: "leg", at: iso(SAT_16), ticketId: "ll_two", conditionId: "A", valueMilli: 0 }, { type: "leg", at: iso(SAT_20), ticketId: "ll_two", conditionId: "B", valueMilli: 1000 }]))[0];
  assert.equal(after.status, "busted");
  assert.equal(after.legValues.B, undefined);

  const partial = replayLastLeg(
    lines([
      t,
      { type: "leg", at: iso(SAT_16), ticketId: "ll_two", conditionId: "A", valueMilli: 700 },
      { type: "leg", at: iso(SAT_20), ticketId: "ll_two", conditionId: "B", valueMilli: 1000 },
    ]),
  )[0];
  assert.equal(partial.status, "last_leg");
  assert.equal(partial.decidedProductMilli, 700);
  assert.equal(compressedContracts(partial.sharesMilli, partial.decidedProductMilli), Math.floor((partial.sharesMilli * 700) / 1_000_000));

  const voided = replayLastLeg(lines([t, { type: "void", at: iso(SUN_20 + 80 * 3_600_000), ticketId: "ll_two", reason: "legs unresolved" }]))[0];
  assert.equal(voided.status, "void");
  assert.equal(voided.voidReason, "legs unresolved");

  // Settled unquoted: naked only, on the ticket basis.
  const unquoted = replayLastLeg(
    lines([
      t,
      { type: "leg", at: iso(SAT_16), ticketId: "ll_two", conditionId: "A", valueMilli: 1000 },
      { type: "leg", at: iso(SAT_20), ticketId: "ll_two", conditionId: "B", valueMilli: 1000 },
      { type: "leg", at: iso(SUN_20 + 4 * 3_600_000), ticketId: "ll_two", conditionId: "D", valueMilli: 1000 },
    ]),
  )[0];
  assert.equal(unquoted.status, "settled");
  assert.equal(unquoted.outcome?.protectedCents, null);
  assert.equal(unquoted.outcome?.nakedCents, ticketValueCents(t.sharesMilli, 1000));

  // Scalar last leg with a quote: pays the value clamped to the collar; the writer line is left open (null).
  const contracts = compressedContracts(t.sharesMilli, 1000);
  const quote = momentRecord(
    { at: iso(SUN_20 - 10 * 3_600_000), ticketId: "ll_two", minutesToStart: 600, decidedProductMilli: 1000, contracts, markCents: 60, entryCents: 30 },
    { ...quoteLastLeg({ contracts, markCents: 60, entryCents: 30, minutesToStart: 600, noBook: noBook("D-t1", 410), noOutcome: "Home", config: DEFAULT_CROSS_CONFIG }) },
  );
  assert.ok(quote.ok);
  const scalar = replayLastLeg(
    lines([
      t,
      { type: "leg", at: iso(SAT_16), ticketId: "ll_two", conditionId: "A", valueMilli: 1000 },
      { type: "leg", at: iso(SAT_20), ticketId: "ll_two", conditionId: "B", valueMilli: 1000 },
      quote,
      { type: "leg", at: iso(SUN_20 + 4 * 3_600_000), ticketId: "ll_two", conditionId: "D", valueMilli: 500 },
    ]),
  )[0];
  assert.equal(scalar.outcome?.result, "scalar");
  assert.equal(scalar.outcome?.protectedCents, protectedPerContract(500, quote.floorCents as number, quote.capCents as number) * contracts + (quote.creditCents as number));
  assert.equal(scalar.outcome?.writerCents, null);
});

test("summary and CSV: counts by size, the reach rate, refusal reasons, average terms, the settled identity", () => {
  const a = ticketRec("ll_a", [["A", 700, 0, SAT_13], ["D", 600, 0, SUN_20]]);
  const b = ticketRec("ll_b", [["A", 700, 0, SAT_13], ["B", 650, 1, SAT_16], ["D", 600, 0, SUN_20]]);
  const c = ticketRec("ll_c", [["C", 800, 0, SAT_20], ["D", 600, 0, SUN_20]]);
  const ca = compressedContracts(a.sharesMilli, 1000);
  const qa = quoteLastLeg({ contracts: ca, markCents: 60, entryCents: Math.ceil(2_000 / ca), minutesToStart: 480, noBook: noBook("D-t1", 410), noOutcome: "Home", config: DEFAULT_CROSS_CONFIG });
  assert.ok(qa.ok);
  if (!qa.ok) return;
  const recs: LastLegRecord[] = [
    a,
    b,
    c,
    { type: "leg", at: iso(SAT_16), ticketId: "ll_a", conditionId: "A", valueMilli: 1000 },
    { type: "leg", at: iso(SAT_16), ticketId: "ll_b", conditionId: "A", valueMilli: 1000 },
    { type: "leg", at: iso(SAT_20), ticketId: "ll_b", conditionId: "B", valueMilli: 0 }, // b busts
    { type: "leg", at: iso(SUN_20 - 20 * 3_600_000), ticketId: "ll_c", conditionId: "C", valueMilli: 1000 },
    momentRecord({ at: iso(SUN_20 - 8 * 3_600_000), ticketId: "ll_a", minutesToStart: 480, decidedProductMilli: 1000, contracts: ca, markCents: 60, entryCents: Math.ceil(2_000 / ca) }, qa),
    momentRecord({ at: iso(SUN_20 - 8 * 3_600_000), ticketId: "ll_c", minutesToStart: 480, decidedProductMilli: 1000, contracts: 40, markCents: 60, entryCents: 50 }, { ok: false, code: "pm_book_too_thin", detail: "thin" }),
    { type: "leg", at: iso(SUN_20 + 4 * 3_600_000), ticketId: "ll_a", conditionId: "D", valueMilli: 0 }, // a: floor pays
    { type: "leg", at: iso(SUN_20 + 4 * 3_600_000), ticketId: "ll_c", conditionId: "D", valueMilli: 1000 }, // c: settled unquoted
  ];
  const tickets = replayLastLeg(lines(recs));
  const s = summarizeLastLeg(tickets);
  assert.equal(s.tickets, 3);
  assert.equal(s.busted, 1);
  assert.equal(s.reachedLastLeg, 2);
  assert.equal(s.reachedPctOfDecided, 66.7);
  assert.equal(s.quoted, 1);
  assert.equal(s.refusedOnly, 1);
  assert.equal(s.windowMissed, 0);
  assert.equal(s.attempts, 2);
  assert.deepEqual(s.refusalCodes, { pm_book_too_thin: 1 });
  assert.equal(s.avgMinutesToStartAtQuote, 480);
  assert.equal(s.avgCreditCents, qa.creditCents);
  assert.equal(s.avgFloorPctOfMark, (qa.floorCents * 100) / 60);
  assert.equal(s.avgCapPctOfMark, (qa.capCents * 100) / 60);
  assert.equal(s.ticketValueAtQuoteCents, ca * 60);
  assert.equal(s.settled.count, 2);
  assert.equal(s.settled.withProtection, 1);
  assert.equal(s.settled.floorSaves, 1);
  assert.equal(s.settled.capGiveups, 0);
  assert.equal(s.settled.protectedCents, qa.floorCents * ca + qa.creditCents);
  assert.equal(s.settled.nakedCents, 0);
  assert.equal(s.settled.writerCents, qa.takeCents);
  assert.equal(s.settled.takeBookedCents, qa.takeCents);
  assert.equal(s.settled.identityHolds, true);
  const two = s.bySize.find((r) => r.size === 2);
  const three = s.bySize.find((r) => r.size === 3);
  assert.deepEqual([two?.built, two?.reachedLastLeg, two?.quoted, two?.refusedOnly, two?.settled], [2, 2, 1, 1, 2]);
  assert.deepEqual([three?.built, three?.busted, three?.reachedLastLeg], [1, 1, 0]);

  const csv = lastLegCsv(tickets);
  const rows = csv.trim().split("\n");
  assert.equal(rows.length, 4);
  assert.ok(rows[0].startsWith("ticket_id,built_at,size,stake_cents,combo_price_milli,shares_milli,legs,last_leg,last_leg_start,status"));
  const aRow = rows.find((r) => r.startsWith("ll_a,")) as string;
  assert.ok(aRow.includes(",settled,"));
  assert.ok(aRow.includes(`,${qa.floorCents},${qa.capCents},${qa.creditCents},${qa.takeCents},`));
  assert.ok(aRow.includes(",no,0,0,"), "result no, last leg value 0, naked 0");
  const bRow = rows.find((r) => r.startsWith("ll_b,")) as string;
  assert.ok(bRow.includes(",busted,"));
});

// ── one tick against an in-memory venue ──────────────────────────────────────

test("runLastLegTick: builds tickets from the catalog, resolves legs, quotes the moment once, settles, and steps over venue failures", async () => {
  const ledger: string[] = [];
  const catalog = [
    parseComboMarket(catalogRow("nfl-a-2026-10-10", "A", ["0.7", "0.3"], 500)) as ComboLegMarket,
    parseComboMarket(catalogRow("nfl-b-2026-10-10", "B", ["0.35", "0.65"], 900)) as ComboLegMarket,
    parseComboMarket(catalogRow("nfl-c-2026-10-10", "C", ["0.8", "0.2"], 300)) as ComboLegMarket,
    parseComboMarket(catalogRow("nfl-d-2026-10-11", "D", ["0.6", "0.4"], 1000)) as ComboLegMarket,
    parseComboMarket(catalogRow("will-the-us-invade-iran-before-2027", "Z", ["0.155", "0.845"], 99_999)) as ComboLegMarket,
  ];
  let gamma: Record<string, Record<string, unknown>> = {
    "nfl-a-2026-10-10": gammaRow("nfl-a-2026-10-10", "A", SAT_13),
    "nfl-b-2026-10-10": gammaRow("nfl-b-2026-10-10", "B", SAT_16, { outcomePrices: '["0.35", "0.65"]' }),
    "nfl-c-2026-10-10": gammaRow("nfl-c-2026-10-10", "C", SAT_20, { outcomePrices: '["0.8", "0.2"]' }),
    "nfl-d-2026-10-11": gammaRow("nfl-d-2026-10-11", "D", SUN_20, { outcomePrices: '["0.6", "0.4"]' }),
  };
  let now = FRI_NOON;
  const calls = { catalog: 0, status: 0, book: 0 };
  const io = {
    nowMs: () => now,
    catalog: async () => {
      calls.catalog += 1;
      return { markets: catalog, pagesFetched: 1, exhausted: true };
    },
    legStatus: async (slug: string) => {
      calls.status += 1;
      if ((slug === "nfl-c-2026-10-10" || slug === "nfl-C") && now >= SUN_20 - 12 * 3_600_000 && now < SUN_20) throw new Error("gamma 502");
      const row = gamma[slug];
      return row ? legStatusFromGamma(row) : null;
    },
    noBook: async (tokenId: string) => {
      calls.book += 1;
      return noBook(tokenId, 410);
    },
    load: () => replayLastLeg(ledger),
    append: (r: LastLegRecord) => {
      ledger.push(JSON.stringify(r));
    },
  };
  const cfg = { ...DEFAULT_LAST_LEG_CONFIG, legCounts: [2, 3], ticketsPerSize: 1 };

  // Tick 1 (Friday noon): nothing to resolve; two tickets built, the long-dated market never a leg.
  const r1 = await runLastLegTick(io, cfg, DEFAULT_CROSS_CONFIG);
  assert.equal(r1.ticketsBuilt, 2);
  assert.equal(r1.candidates, 4);
  assert.equal(r1.legsChecked, 0);
  assert.deepEqual(r1.errors, []);
  let tickets = io.load();
  assert.deepEqual(tickets.map((t) => t.legs.map((l) => l.conditionId)), [["B", "D"], ["A", "B", "D"]]);
  assert.ok(tickets.every((t) => t.legs[t.legs.length - 1].conditionId === "D"), "the Sunday night game is every ticket's last leg");
  const statusCallsTick1 = calls.status;
  assert.ok(statusCallsTick1 <= 4, "one Gamma read per dated catalog row, cached within the tick");

  // Tick 2 (Sunday 08:00): Saturday's games resolved; A won (side 0), B's home side won (bettor is on side 1).
  now = SUN_20 - 12 * 3_600_000;
  gamma = {
    ...gamma,
    "nfl-a-2026-10-10": resolvedRow("nfl-a-2026-10-10", "A", SAT_13, '["1", "0"]'),
    "nfl-b-2026-10-10": resolvedRow("nfl-b-2026-10-10", "B", SAT_16, '["0", "1"]'),
  };
  const r2 = await runLastLegTick(io, cfg, DEFAULT_CROSS_CONFIG);
  assert.equal(r2.legsResolved, 3, "A on one ticket, B on both");
  assert.equal(r2.momentsAttempted, 2);
  assert.equal(r2.momentsQuoted, 2);
  assert.equal(r2.ticketsBuilt, 0, "the same slate builds nothing new");
  assert.deepEqual(r2.errors, [], "C is not on any ticket, so its 502 is never hit");
  tickets = io.load();
  for (const t of tickets) {
    assert.equal(t.status, "last_leg");
    assert.equal(t.legValues.B, 1000, "the bettor's home side won: worth 1000 even though Gamma's first outcome is 0");
    assert.ok(t.quote);
    assert.equal(t.quote?.markCents, 60);
    assert.equal(t.quote?.contracts, compressedContracts(t.sharesMilli, 1000));
    assert.equal(t.quote?.hedgeTokenId, "D-t1", "the hedge is the opposing token of the last leg");
    assert.equal(Math.round(t.quote?.minutesToStart ?? 0), 720);
  }

  // Tick 3 (Sunday 10:00): quoted tickets are not re-quoted; nothing else changes.
  now = SUN_20 - 10 * 3_600_000;
  const r3 = await runLastLegTick(io, cfg, DEFAULT_CROSS_CONFIG);
  assert.equal(r3.momentsAttempted, 0);
  assert.equal(io.load().every((t) => t.attempts === 1), true);

  // Tick 4 (Monday): the last leg settled for the bettor's side; both tickets settle, the identity holds.
  now = SUN_20 + 6 * 3_600_000;
  gamma = { ...gamma, "nfl-d-2026-10-11": resolvedRow("nfl-d-2026-10-11", "D", SUN_20, '["1", "0"]') };
  const r4 = await runLastLegTick(io, cfg, DEFAULT_CROSS_CONFIG);
  assert.equal(r4.legsResolved, 2);
  tickets = io.load();
  assert.ok(tickets.every((t) => t.status === "settled" && t.outcome?.result === "yes"));
  const s = summarizeLastLeg(tickets);
  assert.equal(s.settled.withProtection, 2);
  assert.equal(s.settled.capGiveups, 2);
  assert.equal(s.settled.identityHolds, true);
  assert.equal(s.settled.writerCents, s.settled.takeBookedCents);
  assert.equal(s.reachedPctOfDecided, 100);

  // A venue failure on a ticket's leg is recorded and stepped over; the ledger is untouched by it.
  const ledgerBefore = ledger.length;
  ledger.push(JSON.stringify(ticketRec("ll_err", [["C", 800, 0, SAT_20], ["D", 600, 0, SUN_20]], iso(FRI_NOON))));
  now = SUN_20 - 11 * 3_600_000;
  const r5 = await runLastLegTick(io, cfg, DEFAULT_CROSS_CONFIG);
  assert.equal(r5.errors.length, 1);
  assert.match(r5.errors[0], /leg nfl-C: /);
  assert.equal(ledger.length, ledgerBefore + 1, "nothing appended for the failed leg");
});

test("runLastLegTick: a ticket whose legs never resolve is voided after the grace period", async () => {
  const ledger: string[] = [JSON.stringify(ticketRec("ll_stale", [["A", 700, 0, SAT_13], ["D", 600, 0, SUN_20]]))];
  const io = {
    nowMs: () => SUN_20 + 73 * 3_600_000,
    catalog: async () => ({ markets: [], pagesFetched: 1, exhausted: true }),
    legStatus: async () => legStatusFromGamma(gammaRow("x", "X", SAT_13)), // never resolves
    noBook: async (tokenId: string) => noBook(tokenId, 410),
    load: () => replayLastLeg(ledger),
    append: (r: LastLegRecord) => {
      ledger.push(JSON.stringify(r));
    },
  };
  const r = await runLastLegTick(io, { ...DEFAULT_LAST_LEG_CONFIG, ticketsPerSize: 0 }, DEFAULT_CROSS_CONFIG);
  assert.equal(r.voided, 1);
  assert.equal(io.load()[0].status, "void");
  assert.equal(r.catalogPages, 0, "ticketsPerSize 0 never reads the catalog");
});

// ── the router: legs on the service's game markets, the moment quoted as a single ──

const NFL_MARKETS = [
  { ticker: "KXNFLGAME-26OCT10DALPHI-DAL", league: "nfl", sideName: "Dallas" },
  { ticker: "KXNFLGAME-26OCT10DALPHI-PHI", league: "nfl", sideName: "Philadelphia" },
  { ticker: "KXNFLGAME-26OCT11CHISEA-CHI", league: "nfl", sideName: "Chicago" },
  { ticker: "KXNFLGAME-26OCT11CHISEA-SEA", league: "nfl", sideName: "Seattle" },
  { ticker: "KXNHLGAME-26OCT10PITANA-PIT", league: "nhl", sideName: "Pittsburgh" },
];

test("marketForLeg: the pairing read in reverse — the leg's slug, side and outcome name pick exactly one game market; the wrong side, a doubtful name, another league or two fits pick none", () => {
  const sea = { league: "nfl", slug: "nfl-chi-sea-2026-10-11", side: 1 as const, outcome: "Seahawks" };
  assert.equal(marketForLeg(sea, NFL_MARKETS)?.ticker, "KXNFLGAME-26OCT11CHISEA-SEA");
  assert.equal(marketForLeg({ ...sea, side: 0, outcome: "Bears" }, NFL_MARKETS)?.ticker, "KXNFLGAME-26OCT11CHISEA-CHI");
  // Kalshi's ticker carries the ET date; a Polymarket slug dated the next UTC day still finds it
  assert.equal(marketForLeg({ ...sea, slug: "nfl-chi-sea-2026-10-12" }, NFL_MARKETS)?.ticker, "KXNFLGAME-26OCT11CHISEA-SEA");
  assert.equal(marketForLeg({ ...sea, slug: "nfl-chi-sea-2026-10-10" }, NFL_MARKETS), null, "the day before is another game");
  assert.equal(marketForLeg({ ...sea, outcome: "Bears" }, NFL_MARKETS), null, "the outcome name must verify against the club the side code names");
  assert.equal(marketForLeg({ ...sea, league: "nhl" }, NFL_MARKETS), null, "another league's market never fits");
  assert.equal(marketForLeg({ league: "nfl", slug: "nfl-gb-det-2026-10-10", side: 0, outcome: "Packers" }, NFL_MARKETS), null, "a game the service does not list");
  assert.equal(marketForLeg({ league: "nhl", slug: "nhl-pit-ana-2026-10-10", side: 0, outcome: "Penguins" }, NFL_MARKETS)?.ticker, "KXNHLGAME-26OCT10PITANA-PIT", "an NHL leg maps through the NHL template");
  const twice = [...NFL_MARKETS, { ticker: "KXNFLGAME-26OCT11CHISEA-SEA", league: "nfl", sideName: "Seattle" }];
  assert.equal(marketForLeg(sea, twice), null, "two fits is no fit");
});

test("runLastLegTick with a router: only legs on the service's game markets are built (their tickers kept), the moment is quoted through the router with the route on the record, and a pre-router ticket maps at its moment or is refused", async () => {
  const ledger: string[] = [];
  const catalog = [
    parseComboMarket(catalogRow("nfl-dal-phi-2026-10-10", "DP", ["0.7", "0.3"], 900, { outcomes: ["Cowboys", "Eagles"] })) as ComboLegMarket,
    parseComboMarket(catalogRow("nfl-chi-sea-2026-10-11", "CS", ["0.35", "0.65"], 1000, { outcomes: ["Bears", "Seahawks"] })) as ComboLegMarket,
    parseComboMarket(catalogRow("nfl-gb-det-2026-10-10", "GD", ["0.6", "0.4"], 500, { outcomes: ["Packers", "Lions"] })) as ComboLegMarket, // not on the service's slate
    parseComboMarket(catalogRow("epl-ars-che-2026-10-10", "AC", ["0.6", "0.4"], 5000, { outcomes: ["Arsenal", "Chelsea"], tags: ["sports", "epl"] })) as ComboLegMarket, // a league with no game markets
  ];
  let gamma: Record<string, Record<string, unknown>> = {
    "nfl-dal-phi-2026-10-10": gammaRow("nfl-dal-phi-2026-10-10", "DP", SAT_13, { outcomes: '["Cowboys", "Eagles"]' }),
    "nfl-chi-sea-2026-10-11": gammaRow("nfl-chi-sea-2026-10-11", "CS", SUN_20, { outcomes: '["Bears", "Seahawks"]', outcomePrices: '["0.35", "0.65"]' }),
    "nfl-gb-det-2026-10-10": gammaRow("nfl-gb-det-2026-10-10", "GD", SAT_16, { outcomes: '["Packers", "Lions"]', outcomePrices: '["0.6", "0.4"]' }),
    "epl-ars-che-2026-10-10": gammaRow("epl-ars-che-2026-10-10", "AC", SAT_16, { outcomes: '["Arsenal", "Chelsea"]', outcomePrices: '["0.6", "0.4"]' }),
  };
  let now = FRI_NOON;
  const quotes: Array<{ ticker: string; contracts: number; entryCents: number }> = [];
  const calls = { markets: 0, book: 0 };
  const routed = (contracts: number, entryCents: number): RoutedQuote => {
    const q = quoteLastLeg({ contracts, markCents: 60, entryCents, minutesToStart: 600, noBook: noBook("x", 410), noOutcome: "Bears", config: DEFAULT_CROSS_CONFIG });
    assert.ok(q.ok);
    const h = q.hedge as CrossHedgeLeg;
    return { ok: true, markCents: 60, route: "novig", terms: q, hedgeUnitsMilli: h.sharesMilli, hedgeCostCents: h.costCents };
  };
  const io = {
    nowMs: () => now,
    catalog: async () => ({ markets: catalog, pagesFetched: 1, exhausted: true }),
    legStatus: async (slug: string) => (gamma[slug] ? legStatusFromGamma(gamma[slug]) : null),
    noBook: async (tokenId: string) => {
      calls.book += 1;
      return noBook(tokenId, 410);
    },
    load: () => replayLastLeg(ledger),
    append: (r: LastLegRecord) => {
      ledger.push(JSON.stringify(r));
    },
    router: {
      markets: async () => {
        calls.markets += 1;
        return NFL_MARKETS;
      },
      quote: async (input: { ticker: string; contracts: number; entryCents: number }) => {
        quotes.push(input);
        return routed(input.contracts, input.entryCents);
      },
    },
  };
  const cfg = { ...DEFAULT_LAST_LEG_CONFIG, legCounts: [2], ticketsPerSize: 1 };

  // Friday: the Packers game has no market on the service, so it is never a leg; the EPL game is not even a candidate
  const r1 = await runLastLegTick(io, cfg, DEFAULT_CROSS_CONFIG);
  assert.equal(r1.ticketsBuilt, 1);
  assert.equal(r1.candidates, 2, "the two legs with a game market");
  assert.equal(r1.candidatesUnroutable, 1, "the Packers leg");
  assert.equal(calls.markets, 1, "the service's slate is read once per tick");
  let tickets = io.load();
  assert.deepEqual(tickets[0].legs.map((l) => [l.conditionId, l.ticker]), [["DP", "KXNFLGAME-26OCT10DALPHI-DAL"], ["CS", "KXNFLGAME-26OCT11CHISEA-SEA"]], "each leg keeps the market its side maps to");

  // Two tickets from before the router: one whose last leg maps to a listed game, one whose last leg does not
  ledger.push(JSON.stringify({ ...ticketRec("ll_old_ok", [["DP", 700, 0, SAT_13], ["CS", 650, 1, SUN_20]]), legs: [
    { conditionId: "DP", slug: "nfl-dal-phi-2026-10-10", title: "Cowboys vs Eagles", league: "nfl", side: 0, outcome: "Cowboys", priceMilli: 700, yesTokenId: "DP-t0", noTokenId: "DP-t1", gameStartIso: iso(SAT_13) },
    { conditionId: "CS", slug: "nfl-chi-sea-2026-10-11", title: "Bears vs Seahawks", league: "nfl", side: 1, outcome: "Seahawks", priceMilli: 650, yesTokenId: "CS-t1", noTokenId: "CS-t0", gameStartIso: iso(SUN_20) },
  ] }));
  ledger.push(JSON.stringify({ ...ticketRec("ll_old_epl", [["DP", 700, 0, SAT_13], ["AC", 600, 0, SUN_20]]), legs: [
    { conditionId: "DP", slug: "nfl-dal-phi-2026-10-10", title: "Cowboys vs Eagles", league: "nfl", side: 0, outcome: "Cowboys", priceMilli: 700, yesTokenId: "DP-t0", noTokenId: "DP-t1", gameStartIso: iso(SAT_13) },
    { conditionId: "AC", slug: "epl-ars-che-2026-10-11", title: "Arsenal vs Chelsea", league: "epl", side: 0, outcome: "Arsenal", priceMilli: 600, yesTokenId: "AC-t0", noTokenId: "AC-t1", gameStartIso: iso(SUN_20) },
  ] }));

  // Two more from before the router, already at their last pick and already priced off the NO book (no route on the quote)
  const seaLeg = { conditionId: "CS", slug: "nfl-chi-sea-2026-10-11", title: "Bears vs Seahawks", league: "nfl", side: 1 as const, outcome: "Seahawks", priceMilli: 650, yesTokenId: "CS-t1", noTokenId: "CS-t0", gameStartIso: iso(SUN_20) };
  const eplLeg = { conditionId: "AC", slug: "epl-ars-che-2026-10-11", title: "Arsenal vs Chelsea", league: "epl", side: 0 as const, outcome: "Arsenal", priceMilli: 600, yesTokenId: "AC-t0", noTokenId: "AC-t1", gameStartIso: iso(SUN_20) };
  const dpLeg = { conditionId: "DP", slug: "nfl-dal-phi-2026-10-10", title: "Cowboys vs Eagles", league: "nfl", side: 0 as const, outcome: "Cowboys", priceMilli: 700, yesTokenId: "DP-t0", noTokenId: "DP-t1", gameStartIso: iso(SAT_13) };
  for (const [id, last] of [["ll_old_priced", seaLeg], ["ll_old_priced_epl", eplLeg]] as const) {
    const rec = { ...ticketRec(id, [["DP", 700, 0, SAT_13], [last.conditionId, last.priceMilli, last.side, SUN_20]]), legs: [dpLeg, last] };
    ledger.push(JSON.stringify(rec));
    ledger.push(JSON.stringify({ type: "leg", at: iso(SAT_16), ticketId: id, conditionId: "DP", valueMilli: 1000 }));
    const c = compressedContracts(rec.sharesMilli, 1000);
    const old = quoteLastLeg({ contracts: c, markCents: 60, entryCents: Math.ceil(2_000 / c), minutesToStart: 1500, noBook: noBook("x", 410), noOutcome: "x", config: DEFAULT_CROSS_CONFIG });
    assert.ok(old.ok);
    ledger.push(JSON.stringify(momentRecord({ at: iso(SAT_16 + 3_600_000), ticketId: id, minutesToStart: 1500, decidedProductMilli: 1000, contracts: c, markCents: 60, entryCents: Math.ceil(2_000 / c) }, old)));
  }
  const pricedBefore = io.load().find((t) => t.ticketId === "ll_old_priced")!;
  assert.ok(pricedBefore.quote?.ok && !pricedBefore.quote.route, "priced before the router: a quote with no route");

  // Sunday morning: the Cowboys won; every ticket is at its last pick
  now = SUN_20 - 12 * 3_600_000;
  gamma = { ...gamma, "nfl-dal-phi-2026-10-10": resolvedRow("nfl-dal-phi-2026-10-10", "DP", SAT_13, '["1", "0"]') };
  const r2 = await runLastLegTick(io, cfg, DEFAULT_CROSS_CONFIG);
  assert.equal(r2.legsResolved, 3);
  assert.equal(r2.momentsAttempted, 5, "three first moments and the two pre-router quotes priced once more through the router");
  assert.equal(r2.momentsQuoted, 3, "the built ticket, the old ticket whose last leg maps, the re-priced one; the EPL last legs are refused");
  assert.equal(calls.book, 0, "no moment is priced off the last leg's own book when a router is present");
  assert.equal(quotes.length, 3);
  {
    const re = io.load().find((t) => t.ticketId === "ll_old_priced")!;
    assert.equal(re.attempts, 2, "both attempts stay on the record");
    assert.equal(re.quote?.route, "novig", "the routed quote supersedes the one priced before the router");
    assert.equal(re.quote?.at, iso(now), "the ticket's quote is the routed one");
    const reEpl = io.load().find((t) => t.ticketId === "ll_old_priced_epl")!;
    assert.equal(reEpl.attempts, 2);
    assert.deepEqual(reEpl.refusals, { no_matched_market: 1 });
    assert.ok(reEpl.quote?.ok && !reEpl.quote.route, "a refusal does not take away the quote the ticket already had");
    // the next tick leaves both alone: the re-pricing happens once
    const r3 = await runLastLegTick(io, cfg, DEFAULT_CROSS_CONFIG);
    assert.equal(r3.momentsAttempted, 1, "only the never-quoted EPL ticket is tried again, as before");
    assert.equal(io.load().find((t) => t.ticketId === "ll_old_priced")!.attempts, 2, "a routed quote is not priced again");
    assert.equal(io.load().find((t) => t.ticketId === "ll_old_priced_epl")!.attempts, 2, "one attempt after the old quote, and the ticket is left with it");
  }
  tickets = io.load();
  const built = tickets.find((t) => t.ticketId !== "ll_old_ok" && t.ticketId !== "ll_old_epl")!;
  const contracts = compressedContracts(built.sharesMilli, 1000);
  assert.deepEqual(quotes[0], { ticker: "KXNFLGAME-26OCT11CHISEA-SEA", contracts, entryCents: Math.ceil(2_000 / contracts) }, "the size is the compressed position, the entry what the stake paid per contract");
  assert.equal(built.status, "last_leg");
  assert.ok(built.quote?.ok);
  assert.equal(built.quote?.route, "novig", "the route the router chose is on the record");
  assert.equal(built.quote?.ticker, "KXNFLGAME-26OCT11CHISEA-SEA");
  assert.equal(built.quote?.markCents, 60);
  assert.equal(built.quote?.ticketValueCents, contracts * 60);
  assert.equal(built.quote?.hedgeTokenId, undefined);
  assert.equal(built.quote?.tier, PARLAY_LAST_PICK_TIER);
  const oldOk = tickets.find((t) => t.ticketId === "ll_old_ok")!;
  assert.equal(oldOk.quote?.ticker, "KXNFLGAME-26OCT11CHISEA-SEA", "a pre-router leg maps at its moment");
  const oldEpl = tickets.find((t) => t.ticketId === "ll_old_epl")!;
  assert.equal(oldEpl.quote, undefined);
  assert.deepEqual(oldEpl.refusals, { no_matched_market: 2 }, "a last leg on no listed game is refused (on both ticks so far), not quoted off one book");

  // Monday: the Seahawks won; the routed moment settles on the same identity as before
  now = SUN_20 + 6 * 3_600_000;
  gamma = { ...gamma, "nfl-chi-sea-2026-10-11": resolvedRow("nfl-chi-sea-2026-10-11", "CS", SUN_20, '["0", "1"]') };
  await runLastLegTick(io, cfg, DEFAULT_CROSS_CONFIG);
  const s = summarizeLastLeg(io.load());
  assert.equal(s.settled.withProtection, 3, "the built ticket, the old one mapped at its moment, the one re-priced through the router");
  assert.equal(s.settled.identityHolds, true, "the writer keeps exactly the take on a routed moment too");
  assert.match(lastLegCsv(io.load()), /,novig,/, "the route is a CSV column");
});

// ── config and the card ───────────────────────────────────────────────────────

test("lastLegConfigFromEnv: defaults, overrides, junk ignored, bands kept sane", () => {
  const d = lastLegConfigFromEnv({});
  assert.deepEqual(d, DEFAULT_LAST_LEG_CONFIG);
  const c = lastLegConfigFromEnv({
    EVENT_LASTLEG_ENABLED: "0",
    EVENT_LASTLEG_STAKE_CENTS: "5000",
    EVENT_LASTLEG_LEG_COUNTS: "3, 2, 9, junk, 1, 2",
    EVENT_LASTLEG_FAV_MIN_MILLI: "800",
    EVENT_LASTLEG_FAV_MAX_MILLI: "700",
    EVENT_LASTLEG_LEAGUES: "NBA, nhl",
    EVENT_LASTLEG_TICK_MS: "1000",
  });
  assert.equal(c.enabled, false);
  assert.equal(c.stakeCents, 5000);
  assert.deepEqual(c.legCounts, [2, 3, 9]);
  assert.equal(c.favMinMilli, 800);
  assert.equal(c.favMaxMilli, 800, "a max under the min is raised to it");
  assert.deepEqual(c.leagues, ["nba", "nhl"]);
  assert.equal(c.tickMs, 60_000, "a tick under a minute is held at a minute");
  assert.equal(lastLegConfigFromEnv({ EVENT_LASTLEG_ENABLED: "false" }).enabled, false);
  assert.equal(lastLegConfigFromEnv({ EVENT_LASTLEG_ENABLED: "1" }).enabled, true);
});

test("lastLegCard: says what is real and what is simulated, and reads the numbers in plain words", () => {
  const empty = lastLegCard({ summary: summarizeLastLeg([]), enabled: true, stakeCents: 2_000 });
  assert.ok(empty.includes("the tickets are simulated"));
  assert.ok(empty.includes("No ticket has been decided yet"));
  assert.ok(empty.includes("no tickets yet"));
  const off = lastLegCard({ summary: summarizeLastLeg([]), enabled: false, stakeCents: 2_000 });
  assert.ok(off.includes("EVENT_LASTLEG_ENABLED=0"));

  const a = ticketRec("ll_a", [["A", 700, 0, SAT_13], ["D", 600, 0, SUN_20]]);
  const ca = compressedContracts(a.sharesMilli, 1000);
  const qa = quoteLastLeg({ contracts: ca, markCents: 60, entryCents: 30, minutesToStart: 480, noBook: noBook("D-t1", 410), noOutcome: "Home", config: DEFAULT_CROSS_CONFIG });
  assert.ok(qa.ok);
  const tickets = replayLastLeg(
    lines([
      a,
      { type: "leg", at: iso(SAT_16), ticketId: "ll_a", conditionId: "A", valueMilli: 1000 },
      momentRecord({ at: iso(SUN_20 - 8 * 3_600_000), ticketId: "ll_a", minutesToStart: 480, decidedProductMilli: 1000, contracts: ca, markCents: 60, entryCents: 30 }, qa),
      { type: "leg", at: iso(SUN_20 + 4 * 3_600_000), ticketId: "ll_a", conditionId: "D", valueMilli: 0 },
    ]),
  );
  const html = lastLegCard({ summary: summarizeLastLeg(tickets), enabled: true, stakeCents: 2_000 });
  assert.ok(html.includes("1 of 1 decided tickets reached the last leg with every other leg hit (100.0%)"));
  assert.ok(html.includes("the venues funded a credit on 1 of 1 tickets quoted"));
  assert.ok(html.includes("8.0h before the last game"));
  assert.ok(html.includes("1 locked tickets settled: 1 missed the last leg and the floor paid, 0 hit it"));
  assert.ok(html.includes("the identity holds"));
  assert.ok(html.includes('href="/api/shadow/lastleg.csv"'), "the link carries no token: the operator's sign-in opens it");
  assert.ok(!html.includes("token="));
  assert.ok(!html.includes("wallet"));
});
