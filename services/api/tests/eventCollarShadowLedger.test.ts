/**
 * Event shadow ledger — settlement math, replay discipline, summary honesty.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendShadowRecord,
  loadShadowPositions,
  settlePayouts,
  summarizeShadow,
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
  assert.ok(html.includes("Shadow record"), "page title");
  assert.ok(html.includes("floor saves"), "the save count is a hero number");
  assert.ok(html.includes("floor paid"), "settled row tags the save");
  assert.ok(html.includes("$79.12"), "protected payout shown");
  assert.ok(html.includes("vs $0.00 naked"), "naked comparison shown");
  assert.ok(html.includes("What is real"), "honesty footer");
  assert.ok(html.includes("nothing is bought"), "simulation disclosed");
  assert.ok(html.includes("Demonstration, not an offer."), "not an offer");
  assert.ok(!html.includes("\u2014"), "no em dashes in visible copy");
  assert.ok(!/resolution/i.test(html), "banned vocabulary");
});
