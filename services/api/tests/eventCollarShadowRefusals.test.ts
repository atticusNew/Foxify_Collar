/**
 * Refusals on the record: the scan's declined candidates are kept one per market, folded to public
 * reasons, excluded once the ledger holds the market, and read at the top of the track record page
 * beside what locked positions kept.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRefusals, recordScanRefusals, refusalReason, saveRefusals, summarizeRefusals, type RefusalMap } from "../src/eventCollar/crossVenue/shadowRefusals";
import { summarizeShadow } from "../src/eventCollar/crossVenue/shadowLedger";
import { renderShadowHtml } from "../scripts/eventShadowHtml";

const r = (ticker: string, code: string, kind: "sports" | "crypto" = "sports") => ({ ticker, kind, league: kind === "crypto" ? "crypto" : "nfl", sideName: ticker, eventTimeIso: "2026-11-02T18:00:00.000Z", code });

test("refusals: reason codes fold to a few public phrases, never a venue", () => {
  assert.equal(refusalReason("protection_too_rich"), "too rich to offer");
  assert.equal(refusalReason("credit_too_small"), "credit too small to offer");
  assert.equal(refusalReason("credit_nonpositive"), "credit too small to offer");
  for (const c of ["pm_book_empty", "kalshi_book_too_thin", "prophetx_book_empty", "novig_book_too_thin", "far_out_no_book", "route_gated", "route_not_offered"]) assert.equal(refusalReason(c), "no book could fund it", c);
  for (const c of ["no_matched_market", "market_too_close_to_start", "mark_out_of_range", "mark_disagreement", "resolution_mismatch", "market_not_active"]) assert.equal(refusalReason(c), "not a market we lock in", c);
  assert.equal(refusalReason("something_new"), "other");
});

test("refusals: one entry per market, re-stamped on every scan; a market later quoted is offered, not refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "refusals-"));
  const path = join(dir, "scan-refusals.json");
  assert.deepEqual(loadRefusals(path), {}, "no file, empty map");
  let map: RefusalMap = recordScanRefusals(loadRefusals(path), [r("A", "protection_too_rich"), r("B", "credit_too_small"), r("C", "pm_book_empty", "crypto")], "2026-11-01T00:00:00.000Z");
  saveRefusals(path, map);
  assert.ok(existsSync(path) && !existsSync(`${path}.tmp`), "written atomically");
  map = recordScanRefusals(loadRefusals(path), [r("A", "credit_too_small"), r("D", "market_too_close_to_start")], "2026-11-01T00:10:00.000Z");
  saveRefusals(path, map);
  const again = loadRefusals(path);
  assert.equal(again.A.times, 2, "A refused twice");
  assert.equal(again.A.code, "credit_too_small", "the latest reason stands");
  assert.equal(again.A.firstAt, "2026-11-01T00:00:00.000Z");
  assert.equal(again.A.lastAt, "2026-11-01T00:10:00.000Z");
  assert.equal(Object.keys(again).length, 4);
  // B was later quoted and sits on the ledger; it counts as offered
  const sum = summarizeRefusals(again, [
    { ticker: "B", kind: "sports" },
    { ticker: "X", kind: "sports" },
    { ticker: "Y", kind: "crypto" },
  ]);
  assert.equal(sum.offered, 3);
  assert.equal(sum.refused, 3, "A, C, D");
  assert.equal(sum.priced, 6);
  assert.equal(sum.refusedPct, 50);
  assert.deepEqual(sum.byReason, [
    { reason: "credit too small to offer", count: 1 },
    { reason: "no book could fund it", count: 1 },
    { reason: "not a market we lock in", count: 1 },
  ]);
  assert.deepEqual(sum.byKind, { sports: { refused: 2, offered: 2 }, crypto: { refused: 1, offered: 1 } });
  assert.equal(sum.since, "2026-11-01T00:00:00.000Z");
  assert.equal(JSON.stringify(JSON.parse(readFileSync(path, "utf8"))), JSON.stringify(again), "the file is the map");
  const empty = summarizeRefusals({}, []);
  assert.equal(empty.refusedPct, null);
  assert.deepEqual(empty.byReason, []);
});

test("track record: the kept block leads the page, in public words, with the refusal share", () => {
  const refusals = summarizeRefusals(recordScanRefusals({}, [r("A", "protection_too_rich"), r("B", "credit_too_small"), r("C", "pm_book_empty")], "2026-11-01T00:00:00.000Z"), [{ ticker: "Z", kind: "sports" }]);
  const html = renderShadowHtml({ atIso: "2026-11-01T00:00:00.000Z", summary: summarizeShadow([]), open: [], settled: [], closed: [], refusals });
  const kept = html.indexOf("<h2>What a locked position actually kept</h2>");
  assert.ok(kept > 0 && kept < html.indexOf("<h2>We carry no outcome risk</h2>"), "the kept block sits above the identity card");
  assert.ok(html.includes("Nothing has settled yet. This block fills as events settle against their official results."), "empty book, said plainly");
  assert.ok(html.includes("Of 4 events the engine priced, 3 (75%) were refused rather than offered: too rich to offer 1, credit too small to offer 1, no book could fund it 1. A refusal is written down like an offer, so the record is the whole board."), "the refusal line counts and names the reasons");
  assert.ok(html.includes('<div class="n">75%</div><div class="l">of events priced were refused</div>'), "the share is a headline number");
  assert.ok(!/writer|holder/i.test(html.replace(/writerPnl|holderDelta/g, "")), "public words only");
  assert.ok(!html.includes("Polymarket") && !html.includes("Kalshi"), "no venue named in the reasons");
  const none = renderShadowHtml({ atIso: "2026-11-01T00:00:00.000Z", summary: summarizeShadow([]), open: [], settled: [], closed: [] });
  assert.ok(none.includes("<h2>What a locked position actually kept</h2>") && none.includes('<div class="n">n/a</div><div class="l">of events priced were refused</div>'), "without a refusal summary the cell reads a dash, the block still leads");
  assert.ok(!none.includes("events the engine priced"), "and no refusal sentence is invented");
});
