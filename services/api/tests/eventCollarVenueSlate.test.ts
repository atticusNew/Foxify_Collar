/**
 * Venue slate: the record cut to one venue's leagues (config parsing, the
 * filter, the share key), the parlay moment as lock versus sell, and the page
 * a prospect receives.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  comboPriceMilli,
  compressedContracts,
  lockVersusSell,
  momentRecord,
  quoteLastLeg,
  replayLastLeg,
  sharesFor,
  summarizeLastLeg,
  type LastLegRecord,
  type LastLegTicketRecord,
} from "../src/eventCollar/crossVenue/lastLeg";
import {
  findVenueSlate,
  onSlate,
  parseVenueSlates,
  slateAccessOk,
  slateKeyOk,
  slateLeaguesOnRecord,
  slateLinkKey,
  slatePositions,
  slateSlugOf,
} from "../src/eventCollar/crossVenue/venueSlate";
import { loadShadowPositions, summarizeShadow, type ShadowOpenRecord, type ShadowRecord } from "../src/eventCollar/crossVenue/shadowLedger";
import { renderSlateHtml } from "../scripts/eventShadowHtml";
import { DEFAULT_CROSS_CONFIG, type PmBook } from "../src/eventCollar/crossVenue/types";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── fixtures ──────────────────────────────────────────────────────────────────

const FRI_NOON = Date.UTC(2026, 9, 9, 12, 0, 0);
const SAT_13 = Date.UTC(2026, 9, 10, 13, 0, 0);
const SUN_20 = Date.UTC(2026, 9, 11, 20, 0, 0);
const iso = (ms: number): string => new Date(ms).toISOString();

const open = (ticker: string, league: string, kind: "sports" | "crypto", over: Partial<ShadowOpenRecord> = {}): ShadowOpenRecord => ({
  type: "open",
  at: "2026-09-12T16:00:00.000Z",
  ticker,
  kind,
  league,
  sideName: `${ticker} side`,
  eventTitle: `${ticker} wins`,
  eventTimeIso: "2026-09-21T00:20:00.000Z",
  contracts: 150,
  markCents: 60,
  floorCents: 52,
  capCents: 63,
  creditCents: 112,
  evCostBps: 297,
  route: "polymarket",
  feesCents: 0,
  takeCents: 12,
  ...over,
});

const ledgerWith = (records: ShadowRecord[]) => {
  const dir = mkdtempSync(join(tmpdir(), "slate-"));
  const path = join(dir, "ledger.jsonl");
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return loadShadowPositions(path);
};

const noBook = (tokenId: string, askMilli: number, sizeShares = 100_000): PmBook => ({
  tokenId,
  asks: [{ priceMilli: askMilli, sizeMilli: sizeShares * 1000 }],
  bids: [{ priceMilli: askMilli - 20, sizeMilli: sizeShares * 1000 }],
  minOrderSizeShares: 5,
  tickMilli: 10,
});

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
      title: `${cond} game`,
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

// ── config, filter, key ───────────────────────────────────────────────────────

test("parseVenueSlates: slug=Name:leagues per semicolon; bad slugs, blanks and repeats are dropped; empty leagues means every sports league", () => {
  const slates = parseVenueSlates(" wiremarkets=Wire Markets:NFL, nba,nhl,nba ; sporttrade=Sporttrade ; Bad Slug=X:nfl ; =Nameless:nfl ; wiremarkets=Again:mlb ; novig= :nfl ");
  assert.deepEqual(slates, [
    { slug: "wiremarkets", name: "Wire Markets", leagues: ["nfl", "nba", "nhl"] },
    { slug: "sporttrade", name: "Sporttrade", leagues: [] },
  ]);
  assert.deepEqual(parseVenueSlates(undefined), []);
  assert.deepEqual(parseVenueSlates(""), []);
  assert.equal(findVenueSlate(slates, "WireMarkets")?.name, "Wire Markets", "slug lookup is case-insensitive");
  assert.equal(findVenueSlate(slates, "kalshi"), null);
  assert.equal(findVenueSlate(slates, null), null);
});

test("slate filter: sports on the listed leagues only; crypto never; an empty league list is every sports league", () => {
  const wm = { slug: "wiremarkets", name: "Wire Markets", leagues: ["nfl", "nba"] };
  const all = { slug: "all", name: "All", leagues: [] };
  const positions = ledgerWith([
    open("KXNFL-A", "nfl", "sports"),
    open("KXNBA-B", "NBA", "sports"),
    open("KXMLB-C", "mlb", "sports"),
    open("KXBTC-D", "crypto", "crypto", { route: "kalshi_self" }),
  ]);
  assert.deepEqual(slatePositions(wm, positions).map((p) => p.ticker), ["KXNFL-A", "KXNBA-B"], "league match is case-insensitive");
  assert.deepEqual(slatePositions(all, positions).map((p) => p.ticker), ["KXNFL-A", "KXNBA-B", "KXMLB-C"], "crypto is never a venue's game");
  assert.equal(onSlate(wm, { kind: "crypto", league: "nfl" }), false);
  assert.deepEqual(slateLeaguesOnRecord(wm, positions), ["nba", "nfl"], "no settlements yet: alphabetical");
});

test("slateKeyOk: fail closed without a configured key; exact match only", () => {
  assert.equal(slateKeyOk(undefined, "abc"), false);
  assert.equal(slateKeyOk("", "abc"), false);
  assert.equal(slateKeyOk("abc", undefined), false);
  assert.equal(slateKeyOk("abc", ""), false);
  assert.equal(slateKeyOk("abc", "abd"), false);
  assert.equal(slateKeyOk("abc", "abcd"), false);
  assert.equal(slateKeyOk(" abc ", "abc"), true, "whitespace around the configured value is not part of the key");
  assert.equal(slateKeyOk("abc", "abc"), true);
});

test("slate link keys: derived per slate from the share key, so a branded demo link opens its own slate and no other", () => {
  const wm = slateLinkKey("share-secret", "wiremarkets");
  assert.match(wm, /^[0-9a-f]{24}$/);
  assert.equal(slateLinkKey("share-secret", "WireMarkets"), wm, "slug case does not change the key");
  assert.notEqual(slateLinkKey("share-secret", "sporttrade"), wm);
  assert.notEqual(slateLinkKey("other-secret", "wiremarkets"), wm);
  assert.equal(slateLinkKey(undefined, "wiremarkets"), "", "no share key: no link key");
  assert.equal(slateLinkKey("  ", "wiremarkets"), "");
  assert.equal(slateAccessOk("share-secret", "wiremarkets", "share-secret"), true, "the share key opens every slate");
  assert.equal(slateAccessOk("share-secret", "wiremarkets", wm), true, "the slate's own key opens it");
  assert.equal(slateAccessOk("share-secret", "sporttrade", wm), false, "and not another slate");
  assert.equal(slateAccessOk(undefined, "wiremarkets", ""), false, "no key configured: nothing opens, not even an empty key");
  assert.equal(slateAccessOk("share-secret", "wiremarkets", null), false);
  assert.equal(slateSlugOf("Wire Markets"), "wiremarkets");
  assert.equal(slateSlugOf("Crypto.com"), "cryptocom");
  assert.equal(slateSlugOf("  "), "");
});

// ── lock versus sell ──────────────────────────────────────────────────────────

test("lockVersusSell: only priced tickets appear; sell is the fair value, lock is the two endings with the credit, settled rows carry what each paid", () => {
  const a = ticketRec("ll_a", [["A", 700, 0, SAT_13], ["D", 600, 0, SUN_20]]);
  const b = ticketRec("ll_b", [["B", 650, 0, SAT_13], ["D", 600, 0, SUN_20]], iso(FRI_NOON + 60_000));
  const c = ticketRec("ll_c", [["C", 800, 0, SAT_13], ["D", 600, 0, SUN_20]], iso(FRI_NOON + 120_000));
  const ca = compressedContracts(a.sharesMilli, 1000);
  const cb = compressedContracts(b.sharesMilli, 1000);
  const qa = quoteLastLeg({ contracts: ca, markCents: 60, entryCents: 30, minutesToStart: 480, noBook: noBook("D-t1", 410), noOutcome: "Home", config: DEFAULT_CROSS_CONFIG });
  const qb = quoteLastLeg({ contracts: cb, markCents: 60, entryCents: 30, minutesToStart: 300, noBook: noBook("D-t1", 410), noOutcome: "Home", config: DEFAULT_CROSS_CONFIG });
  assert.ok(qa.ok && qb.ok);
  if (!qa.ok || !qb.ok) return;
  const base = { decidedProductMilli: 1000, markCents: 60, entryCents: 30 };
  const tickets = replayLastLeg(
    lines([
      a,
      b,
      c,
      { type: "leg", at: iso(SAT_13 + 3 * 3_600_000), ticketId: "ll_a", conditionId: "A", valueMilli: 1000 },
      { type: "leg", at: iso(SAT_13 + 3 * 3_600_000), ticketId: "ll_b", conditionId: "B", valueMilli: 1000 },
      { type: "leg", at: iso(SAT_13 + 3 * 3_600_000), ticketId: "ll_c", conditionId: "C", valueMilli: 0 },
      momentRecord({ ...base, at: iso(SUN_20 - 8 * 3_600_000), ticketId: "ll_a", minutesToStart: 480, contracts: ca }, qa),
      momentRecord({ ...base, at: iso(SUN_20 - 5 * 3_600_000), ticketId: "ll_b", minutesToStart: 300, contracts: cb }, qb),
      // a settles for the bettor (capped), b has not played yet
      { type: "leg", at: iso(SUN_20 + 4 * 3_600_000), ticketId: "ll_a", conditionId: "D", valueMilli: 1000 },
    ]),
  );
  const lv = lockVersusSell(tickets);
  assert.equal(lv.rows.length, 2, "the busted ticket never had a quote");
  assert.deepEqual(lv.rows.map((r) => r.ticketId), ["ll_b", "ll_a"], "most recent quote first");
  const ra = lv.rows[1];
  assert.equal(ra.size, 2);
  assert.equal(ra.lastLeg, "Away · D game");
  assert.equal(ra.league, "nfl");
  assert.equal(ra.minutesToStart, 480);
  assert.equal(ra.sellCents, ca * 60, "sell at fair is contracts x mark");
  assert.equal(ra.lockFloorCents, qa.floorCents * ca + qa.creditCents);
  assert.equal(ra.lockCapCents, qa.capCents * ca + qa.creditCents);
  assert.equal(ra.creditCents, qa.creditCents);
  assert.equal(ra.status, "settled");
  assert.equal(ra.result, "yes");
  assert.equal(ra.lockPaidCents, qa.capCents * ca + qa.creditCents, "the lock paid the cap ending");
  assert.equal(ra.holdPaidCents, 100 * ca, "holding paid the full ticket");
  const rb = lv.rows[0];
  assert.equal(rb.status, "last_leg");
  assert.equal(rb.lockPaidCents, undefined);
  assert.equal(lv.quoted, 2);
  assert.equal(lv.settled, 1);
  assert.equal(lv.sellCents, ra.sellCents + rb.sellCents);
  assert.equal(lv.creditsCents, qa.creditCents + qb.creditCents);
  assert.equal(lv.settledSellCents, ra.sellCents);
  assert.equal(lv.settledLockCents, ra.lockPaidCents);
  assert.equal(lv.settledHoldCents, 100 * ca);
  assert.equal(lv.lockBeatSell, 1, "cap ending above fair value: the lock beat the sell");
  assert.equal(lv.holdBeatBoth, 1, "the favourite won: holding beat both");
  assert.deepEqual(lockVersusSell([]), { ...lockVersusSell([]), rows: [], quoted: 0, settled: 0 });
});

// ── the page ──────────────────────────────────────────────────────────────────

test("renderSlateHtml: the venue's name, its leagues, the hedge venues, the identity, lock versus sell, the branded demo link; never indexed", () => {
  const wm = { slug: "wiremarkets", name: "Wire Markets", leagues: ["nfl", "nba", "nhl"] };
  const positions = ledgerWith([
    open("KXNFL-A", "nfl", "sports"),
    open("KXNBA-B", "nba", "sports", { route: "kalshi_self" }),
    open("KXMLB-C", "mlb", "sports"),
    open("KXBTC-D", "crypto", "crypto", { route: "kalshi_self" }),
    { type: "settle", at: "2026-09-21T04:00:00.000Z", ticker: "KXNFL-A", result: "no" },
    { type: "settle", at: "2026-09-21T04:00:00.000Z", ticker: "KXMLB-C", result: "yes" },
  ]);
  const onSlateRows = slatePositions(wm, positions);
  const summary = summarizeShadow(onSlateRows);
  assert.equal(summary.settledCount, 1, "the MLB settlement is off the slate");
  const a = ticketRec("ll_a", [["A", 700, 0, SAT_13], ["D", 600, 0, SUN_20]]);
  const ca = compressedContracts(a.sharesMilli, 1000);
  const qa = quoteLastLeg({ contracts: ca, markCents: 60, entryCents: 30, minutesToStart: 480, noBook: noBook("D-t1", 410), noOutcome: "Home", config: DEFAULT_CROSS_CONFIG });
  assert.ok(qa.ok);
  const tickets = replayLastLeg(
    lines([
      a,
      { type: "leg", at: iso(SAT_13 + 3 * 3_600_000), ticketId: "ll_a", conditionId: "A", valueMilli: 1000 },
      momentRecord({ at: iso(SUN_20 - 8 * 3_600_000), ticketId: "ll_a", minutesToStart: 480, decidedProductMilli: 1000, contracts: ca, markCents: 60, entryCents: 30 }, qa),
    ]),
  );
  const html = renderSlateHtml({
    atIso: "2026-10-09T01:00:00.000Z",
    slate: wm,
    leaguesOnRecord: slateLeaguesOnRecord(wm, positions),
    summary,
    settled: onSlateRows.filter((p) => p.status === "settled"),
    open: onSlateRows.filter((p) => p.status === "open"),
    lockVsSell: lockVersusSell(tickets),
    lastLeg: summarizeLastLeg(tickets),
    lastLegStakeCents: 2_000,
    hedgeVenues: ["Kalshi", "Polymarket"],
    demoUrl: "https://demo.example/?brand=Wire%20Markets",
    csvHref: "/slate/wiremarkets.csv?k=abc",
    recordUrl: "https://record.example",
  });
  assert.ok(html.includes("<title>Protection on the Wire Markets slate"));
  assert.ok(html.includes('<meta name="robots" content="noindex, nofollow" />'));
  assert.ok(html.includes("prepared for Wire Markets"));
  assert.ok(html.includes("on NFL and NBA games"), "the leagues on the record, settled first");
  assert.ok(!html.includes("MLB"), "a league off the slate is not on the page");
  assert.ok(!html.includes("Bitcoin") && !html.includes("crypto"), "crypto never appears");
  assert.ok(html.includes("Hedged leg for leg on Kalshi and Polymarket."));
  assert.ok(html.includes('<div class="n green">1</div><div class="l">games settled</div>'));
  assert.ok(html.includes("Protection paid the floor on 1 of 1 settled games (100%)."));
  assert.ok(html.includes("We carried no outcome risk on your games."));
  assert.ok(html.includes("Your ledger pays the user; the hedge pays your ledger."));
  assert.ok(html.includes('<td class="hi">NFL</td><td>1</td><td>1</td>'), "the league table has the slate's leagues");
  assert.ok(html.includes("Lock, sell or hold: the parlay moment"));
  assert.ok(html.includes("1 tickets reached the last leg with a priced lock"));
  assert.ok(html.includes("2 legs · Away · D game") && html.includes("8h before"));
  assert.ok(html.includes("last leg not played yet"));
  assert.ok(html.includes('href="https://demo.example/?brand=Wire%20Markets">Open the Wire Markets demo</a>'));
  assert.ok(html.includes('href="/slate/wiremarkets.csv?k=abc">Your slate (CSV)</a>'));
  assert.ok(html.includes("Prepared for Wire Markets; demonstration, not an offer."));

  const empty = renderSlateHtml({
    atIso: "2026-10-09T01:00:00.000Z",
    slate: wm,
    leaguesOnRecord: [],
    summary: summarizeShadow([]),
    settled: [],
    open: [],
    lockVsSell: lockVersusSell([]),
    lastLeg: summarizeLastLeg([]),
    lastLegStakeCents: 2_000,
    hedgeVenues: ["Kalshi", "Polymarket"],
    demoUrl: "https://demo.example/?brand=Wire%20Markets",
    csvHref: "/slate/wiremarkets.csv?k=abc",
    recordUrl: "https://record.example",
  });
  assert.ok(empty.includes("on the leagues you list games"));
  assert.ok(empty.includes("no positions on these leagues yet"));
  assert.ok(empty.includes("The parlay shadow has just started"));
});
