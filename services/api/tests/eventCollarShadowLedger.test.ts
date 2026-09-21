/**
 * Event shadow ledger — settlement math, replay discipline, summary honesty.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  POSITIONS_CSV_COLUMNS,
  appendShadowRecord,
  hedgeCostOf,
  hedgeUnitsOf,
  loadShadowPositions,
  positionsCsv,
  settlePayouts,
  summarizeShadow,
  writerPayouts,
  type ShadowOpenRecord,
} from "../src/eventCollar/crossVenue/shadowLedger";
import { getMarketResult } from "../src/eventCollar/kalshiPublic";
import { renderShadowHtml } from "../scripts/eventShadowHtml";

const OPEN_FIXTURE: ShadowOpenRecord = {
  type: "open",
  at: "2026-09-12T16:00:00.000Z",
  ticker: "KXMLBGAME-TEST-TB",
  kind: "sports",
  league: "mlb",
  sideName: "Tampa Bay Rays",
  eventTitle: "Tampa Bay Rays to win",
  eventTimeIso: "2026-09-13T17:40:00.000Z",
  contracts: 150,
  markCents: 60,
  floorCents: 52,
  capCents: 63,
  creditCents: 112,
  evCostBps: 297,
  route: "polymarket",
  feesCents: 0,
  takeCents: 12,
};

test("shadow: settle payouts match the app's outcome totals", () => {
  // Same numbers the drawer shows: with $95.62 / $79.12, without $150.00 / $0.00
  const yes = settlePayouts(OPEN_FIXTURE, "yes");
  assert.equal(yes.protectedCents, 63 * 150 + 112); // 9562
  assert.equal(yes.nakedCents, 15_000);
  assert.equal(yes.deltaCents, 9562 - 15_000); // capped: gave up upside
  const no = settlePayouts(OPEN_FIXTURE, "no");
  assert.equal(no.protectedCents, 52 * 150 + 112); // 7912
  assert.equal(no.nakedCents, 0);
  assert.equal(no.deltaCents, 7912); // the floor save
});

test("shadow: writer nets the published take whether the holder won or lost", () => {
  // Fixture identity: funding (100-63)*150 = 5550; credit 112 + take 12 => hedge cost 5426.
  assert.equal(hedgeCostOf(OPEN_FIXTURE), 5426, "legacy record: hedge cost recovered from the credit identity");
  // Hedge sizing rule: (floor + 100 - cap) * N / 100 = (52+100-63)*150/100 = 133.5 -> 133,500 milli
  assert.equal(hedgeUnitsOf(OPEN_FIXTURE), 133_500);

  const yes = writerPayouts(OPEN_FIXTURE, "yes");
  assert.equal(yes.fundingCents, 5550);
  assert.equal(yes.hedgePayoutCents, 0);
  assert.equal(yes.writerCents, 5550 - 112 - 5426, "cap slice kept minus credit minus hedge = take");
  assert.equal(yes.writerCents, OPEN_FIXTURE.takeCents);

  const no = writerPayouts(OPEN_FIXTURE, "no");
  assert.equal(no.hedgePayoutCents, 13_350, "133.5 units pay $1 each");
  assert.equal(no.writerCents, -52 * 150 + 13_350 - 112 - 5426, "floor paid, hedge collected, credit and hedge cost out");
  assert.equal(no.writerCents, OPEN_FIXTURE.takeCents, "same number as the YES state: leg-for-leg");

  // New records carry the quoted hedge leg; the round-up on units shows as a small NO-state surplus.
  const withLeg: ShadowOpenRecord = { ...OPEN_FIXTURE, hedgeCostCents: 5426, hedgeUnitsMilli: 134_000 };
  assert.equal(writerPayouts(withLeg, "yes").writerCents, 12);
  assert.equal(writerPayouts(withLeg, "no").writerCents, 12 + 50, "half a unit rounded up pays 50c extra on NO");
});

test("shadow: replay carries writer P&L; summary splits it by outcome and league; CSV is one row per position", () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-writer-"));
  const path = join(dir, "ledger.jsonl");
  appendShadowRecord(path, OPEN_FIXTURE);
  appendShadowRecord(path, { ...OPEN_FIXTURE, ticker: "KXNFLGAME-TEST-KC", league: "nfl", sideName: "Chiefs", at: "2026-09-13T16:00:00.000Z", takeCents: 20, creditCents: 104 });
  appendShadowRecord(path, { ...OPEN_FIXTURE, ticker: "KXNFLGAME-TEST-OPEN", league: "nfl", sideName: "Bills", at: "2026-09-14T16:00:00.000Z", takeCents: 7 });
  appendShadowRecord(path, { type: "settle", at: "2026-09-13T21:00:00.000Z", ticker: OPEN_FIXTURE.ticker, result: "no" });
  appendShadowRecord(path, { type: "settle", at: "2026-09-14T04:00:00.000Z", ticker: "KXNFLGAME-TEST-KC", result: "yes" });

  const positions = loadShadowPositions(path);
  const rays = positions.find((p) => p.ticker === OPEN_FIXTURE.ticker)!;
  assert.equal(rays.writerCents, 12);
  assert.equal(rays.hedgePayoutCents, 13_350);
  const kc = positions.find((p) => p.ticker === "KXNFLGAME-TEST-KC")!;
  assert.equal(kc.writerCents, 20);
  assert.equal(positions.find((p) => p.ticker === "KXNFLGAME-TEST-OPEN")!.writerCents, undefined, "open positions carry no realized P&L");

  const s = summarizeShadow(positions);
  const w = s.writer;
  assert.equal(w.settledPnlCents, 32);
  assert.equal(w.takeBookedCents, 32, "realized equals the published take, before round-up");
  assert.equal(w.pnlWhenHolderLostCents, 12);
  assert.equal(w.pnlWhenHolderWonCents, 20);
  assert.equal(w.settledWhenHolderLost, 1);
  assert.equal(w.settledWhenHolderWon, 1);
  assert.equal(w.floorsPaidCents, 52 * 150);
  assert.equal(w.capSlicesKeptCents, 37 * 150);
  assert.equal(w.creditsPaidCents, 112 + 104);
  assert.equal(w.hedgePayoutsCents, 13_350);
  assert.equal(w.hedgeCostCents, 5426 + (5550 - 104 - 20));
  assert.equal(w.takeLockedOpenCents, 7);
  assert.equal(w.settledPnlBpsOfStake, Math.round((32 / 30_000) * 10_000));
  assert.deepEqual(w.byLeague.mlb, { settled: 1, open: 0, pnlCents: 12, stakeCents: 15_000 });
  assert.deepEqual(w.byLeague.nfl, { settled: 1, open: 1, pnlCents: 20, stakeCents: 15_000 });

  // the hedge-layer identity: writer P&L equals take booked, leg for leg
  assert.deepEqual(s.identity, {
    settled: 2,
    writerPnlCents: 32,
    takeBookedCents: 32,
    gapCents: 0,
    gapBpsOfStake: 0,
    hedgeNetCents: 13_350 - (5426 + (5550 - 104 - 20)),
    holderLegsNetCents: 37 * 150 - 52 * 150 - (112 + 104),
    holds: true,
  });
  assert.equal(s.identity.hedgeNetCents + s.identity.holderLegsNetCents, s.identity.writerPnlCents, "the two nets add up to the writer's P&L");

  // segments: the same book by route and by league, quoted EV cost and realized holder delta
  assert.deepEqual(Object.keys(s.segments.byRoute), ["polymarket"]);
  const pm = s.segments.byRoute.polymarket;
  assert.equal(pm.opened, 3);
  assert.equal(pm.settled, 2);
  assert.equal(pm.quotedAvgEvBps, 297);
  assert.equal(pm.stakeSettledCents, 30_000);
  assert.equal(pm.holderDeltaCents, 7912 + (63 * 150 + 104 - 15_000));
  assert.equal(pm.holderDeltaBpsOfStake, Math.round((pm.holderDeltaCents / 30_000) * 10_000));
  assert.equal(pm.creditsCents, 112 + 104);
  assert.equal(pm.takeCents, 32);
  assert.equal(pm.writerPnlCents, 32);
  assert.deepEqual(Object.keys(s.segments.byLeague).sort(), ["mlb", "nfl"]);
  assert.equal(s.segments.byLeague.nfl.opened, 2);
  assert.equal(s.segments.byLeague.nfl.settled, 1);
  assert.equal(s.segments.byLeague.mlb.holderDeltaCents, 7912);

  const csv = positionsCsv(positions);
  const lines = csv.trimEnd().split("\n");
  assert.equal(lines[0], POSITIONS_CSV_COLUMNS.join(","));
  assert.equal(lines.length, 4, "header + one row per position");
  const cols = lines[1].split(",");
  assert.equal(cols[0], OPEN_FIXTURE.ticker, "oldest open first");
  const idx = (name: (typeof POSITIONS_CSV_COLUMNS)[number]) => POSITIONS_CSV_COLUMNS.indexOf(name);
  assert.equal(cols[idx("status")], "settled");
  assert.equal(cols[idx("result")], "no");
  assert.equal(cols[idx("hedge_cost_c")], "5426");
  assert.equal(cols[idx("hedge_payout_c")], "13350");
  assert.equal(cols[idx("writer_pnl_c")], "12");
  assert.equal(cols[idx("holder_delta_c")], "7912");
  const openCols = lines[3].split(",");
  assert.equal(openCols[idx("status")], "open");
  assert.equal(openCols[idx("writer_pnl_c")], "", "no realized P&L on open rows");
  assert.equal(openCols[idx("hedge_cost_c")], String(5550 - 112 - 7), "hedge cost is known at open");

  // quoting: a side name with a comma survives the round trip
  const quoted = positionsCsv([{ ...positions[0], sideName: 'Rays, "the" team' }]);
  assert.ok(quoted.includes('"Rays, ""the"" team"'));

  const html = renderShadowHtml({ atIso: "2026-09-15T00:00:00.000Z", summary: s, open: positions.filter((p) => p.status === "open"), settled: positions.filter((p) => p.status === "settled") });
  assert.ok(!html.includes("The writer's book") && !html.includes("cap slices kept (holder won)"), "the line-by-line book moved to the operator report");
  assert.ok(html.includes("$0.32"), "our P&L shows in dollars");
  assert.ok(html.includes("We carry no outcome risk"), "the identity leads the page");
  assert.ok(html.includes("our P&amp;L, settled") && !/writer|holder/i.test(html.replace(/writerPnl|holderDelta/g, "")), "public words: our P&L and user, never writer and holder");
  assert.ok(html.includes("<th>user Δ</th>") && html.includes("<th>our P&amp;L</th>"));
  assert.ok(html.includes("a gap of $0.00. The hedge layer carried no outcome risk."), "and reads the gap in one sentence");
  assert.ok(html.includes("Where protection is cheap and where it is rich"), "EV cost by route and league");
  assert.ok(html.includes("<td>MLB</td>") && html.includes("<td>NFL</td>"), "league rows");
  assert.ok(html.includes("hedged cross-venue on the same game"), "route rows in public words");
  assert.ok(!html.includes("Polymarket") && !html.includes("(Kalshi)"), "the hedge venue is not named on the public record");
  assert.ok(html.includes("2026-09-12 to 2026-09-14 UTC"), "the period line names the window");
  assert.ok(html.includes('href="/api/shadow/positions.csv"'));
});

test("shadow: replay opens once per ticker, settles, voids, skips bad lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-"));
  const path = join(dir, "ledger.jsonl");
  appendShadowRecord(path, OPEN_FIXTURE);
  // duplicate open must not double-book
  appendShadowRecord(path, { ...OPEN_FIXTURE, creditCents: 999 });
  appendShadowRecord(path, {
    ...OPEN_FIXTURE,
    ticker: "KXBTCD-TEST",
    kind: "crypto",
    league: "crypto",
    sideName: "Bitcoin $86,750 or above",
    route: "kalshi_self",
    evCostBps: -12,
  });
  appendShadowRecord(path, {
    ...OPEN_FIXTURE,
    ticker: "KXMLBGAME-TEST-VOID",
    sideName: "Postponed Team",
  });
  appendShadowRecord(path, {
    type: "settle",
    at: "2026-09-13T21:00:00.000Z",
    ticker: OPEN_FIXTURE.ticker,
    result: "no",
  });
  appendShadowRecord(path, {
    type: "void",
    at: "2026-09-16T21:00:00.000Z",
    ticker: "KXMLBGAME-TEST-VOID",
    reason: "no official result 72h after the event",
  });
  // settle for an unknown ticker and a corrupt line are both ignored
  appendShadowRecord(path, { type: "settle", at: "x", ticker: "UNKNOWN", result: "yes" });
  writeFileSync(path, `${"{not json"}\n`, { flag: "a" });

  const positions = loadShadowPositions(path);
  assert.equal(positions.length, 3);
  const rays = positions.find((p) => p.ticker === OPEN_FIXTURE.ticker);
  assert.ok(rays);
  assert.equal(rays.status, "settled");
  assert.equal(rays.creditCents, 112, "first open wins; duplicate ignored");
  assert.equal(rays.protectedCents, 7912);
  assert.equal(rays.nakedCents, 0);
  const voided = positions.find((p) => p.ticker === "KXMLBGAME-TEST-VOID");
  assert.equal(voided?.status, "void");
  const btc = positions.find((p) => p.ticker === "KXBTCD-TEST");
  assert.equal(btc?.status, "open");

  const s = summarizeShadow(positions);
  assert.equal(s.openCount, 1);
  assert.equal(s.settledCount, 1);
  assert.equal(s.voidCount, 1);
  assert.equal(s.floorSaves, 1);
  assert.equal(s.capGiveups, 0);
  assert.equal(s.protectedTotalCents, 7912);
  assert.equal(s.nakedTotalCents, 0);
  assert.equal(s.deltaTotalCents, 7912);
  // 7912 delta on 15000 staked = 5275 bps ahead
  assert.equal(s.realizedDeltaBpsOfStake, 5275);
  assert.deepEqual(s.routeSplit, { polymarket: 2, kalshi_self: 1 });
});

test("shadow: kalshi result fetch parses finalized and pending markets", async () => {
  const finalized = {
    market: { ticker: "T-1", status: "finalized", result: "no" },
  };
  const pending = { market: { ticker: "T-2", status: "active", result: "" } };
  const stub = (body: unknown) =>
    (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
  const r1 = await getMarketResult("T-1", stub(finalized));
  assert.equal(r1.result, "no");
  assert.equal(r1.status, "finalized");
  const r2 = await getMarketResult("T-2", stub(pending));
  assert.equal(r2.result, "");
});

test("shadow: page renders the honest record", () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-html-"));
  const path = join(dir, "ledger.jsonl");
  appendShadowRecord(path, OPEN_FIXTURE);
  appendShadowRecord(path, {
    type: "settle",
    at: "2026-09-13T21:00:00.000Z",
    ticker: OPEN_FIXTURE.ticker,
    result: "no",
  });
  const positions = loadShadowPositions(path);
  const html = renderShadowHtml({
    atIso: "2026-09-13T22:00:00.000Z",
    summary: summarizeShadow(positions),
    open: positions.filter((p) => p.status === "open"),
    settled: positions.filter((p) => p.status === "settled"),
  });
  assert.ok(html.includes("Track record") && !html.includes("Shadow record"), "page title");
  assert.ok(html.includes("floor saves"), "the save count is a hero number");
  assert.ok(html.includes("floor paid"), "settled row tags the save");
  assert.ok(html.includes("$79.12"), "protected payout shown");
  assert.ok(html.includes("vs $0.00 naked"), "naked comparison shown");
  assert.ok(html.includes("<b>Real:</b>") && html.includes("<b>Simulated:</b>"), "honesty footer");
  assert.ok(html.includes("nothing is bought"), "simulation disclosed");
  assert.ok(html.includes("Demonstration, not an offer."), "not an offer");
  assert.ok(!html.includes("\u2014"), "no em dashes in visible copy");
  assert.ok(!/resolution/i.test(html), "banned vocabulary");
  assert.ok(html.includes(`href="https://event.earnandprotect.xyz/">back to the demo</a>`), "back link goes to the front door (the embed), not the board");
});
