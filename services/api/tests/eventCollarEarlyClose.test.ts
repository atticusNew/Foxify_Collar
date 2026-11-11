/**
 * Early close at live prices: the pricer's identity, the schedule's determinism, the ledger's
 * replay of close records, the record page's card, and the demo's close-quote endpoint.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  DEFAULT_EARLY_CLOSE_RULE,
  earlyCloseRuleFromEnv,
  earlyCloseSchedule,
  parseKalshiBookSides,
  quoteEarlyClose,
  tickerHash,
  walkKalshiBids,
  walkPmBids,
  type EarlyCloseTerms,
} from "../src/eventCollar/crossVenue/earlyClose";
import {
  POSITIONS_CSV_PUBLIC_COLUMNS,
  appendShadowRecord,
  loadShadowPositions,
  positionsCsv,
  summarizeShadow,
  type ShadowOpenRecord,
} from "../src/eventCollar/crossVenue/shadowLedger";
import { renderShadowHtml } from "../scripts/eventShadowHtml";

process.env.NODE_ENV = "test";
const TMP_DIR = mkdtempSync(join(tmpdir(), "event-early-close-"));
process.env.EVENT_X_FUNNEL_PATH = join(TMP_DIR, "funnel.json");
process.env.EVENT_X_LEDGER_PATH = join(TMP_DIR, "ledger.jsonl");
process.env.EVENT_X_ADMIN_TOKEN = "t0ken";

/** The ledger test fixture: 150 contracts, floor 52, cap 63, credit $1.12, take 12c. */
const TERMS: EarlyCloseTerms = {
  contracts: 150,
  floorCents: 52,
  capCents: 63,
  creditCents: 112,
  takeCents: 12,
  hedgeUnitsMilli: (52 + 100 - 63) * 150 * 10, // 133,500
  route: "kalshi_self",
};

test("early close: both Kalshi book shapes parse into yes bids and no bids, best first", () => {
  const fp = parseKalshiBookSides({
    orderbook_fp: {
      yes_dollars: [["0.5800", "100.5"], ["0.6000", "50.25"]],
      no_dollars: [["0.3900", "10"], ["0.4000", "20"]],
    },
  });
  assert.deepEqual(fp.yesBids, [
    { priceCents: 60, qtyMilli: 50_250 },
    { priceCents: 58, qtyMilli: 100_500 },
  ]);
  assert.deepEqual(fp.noBids, [
    { priceCents: 40, qtyMilli: 20_000 },
    { priceCents: 39, qtyMilli: 10_000 },
  ]);
  const legacy = parseKalshiBookSides({ orderbook: { yes: [[59, 5], [60, 7]], no: [[40, 3]] } });
  assert.deepEqual(legacy.yesBids, [
    { priceCents: 60, qtyMilli: 7000 },
    { priceCents: 59, qtyMilli: 5000 },
  ]);
  assert.deepEqual(legacy.noBids, [{ priceCents: 40, qtyMilli: 3000 }]);
  assert.deepEqual(parseKalshiBookSides({}), { yesBids: [], noBids: [] });
});

test("early close: bid walks round proceeds down, charge the exact taker fee, refuse when thin", () => {
  const k = walkKalshiBids([{ priceCents: 60, qtyMilli: 100_000 }, { priceCents: 58, qtyMilli: 100_000 }], 150_000);
  assert.ok(k);
  // 100 x 60 + 50 x 58 = 8900c; fee: ceil(7*100000*60*40/1e7)=168 + ceil(7*50000*58*42/1e7)=ceil(85.26)=86
  assert.equal(k.proceedsCents, 8900);
  assert.equal(k.feeCents, 168 + 86);
  assert.equal(k.avgPriceCents, 59); // 8,900,000 / 150,000 = 59.33 floored
  assert.equal(k.worstPriceCents, 58);
  assert.equal(walkKalshiBids([{ priceCents: 60, qtyMilli: 1000 }], 150_000), null, "thin book refuses");
  assert.equal(walkKalshiBids([{ priceCents: 60, qtyMilli: 1000 }], 0), null);

  const pm = walkPmBids([{ priceMilli: 405, sizeMilli: 100_000 }, { priceMilli: 400, sizeMilli: 100_000 }], 133_500);
  assert.ok(pm);
  // 100,000 x 405 + 33,500 x 400 = 40,500,000 + 13,400,000 = 53,900,000 micro USD = 5390c
  assert.equal(pm.proceedsCents, 5390);
  assert.equal(pm.worstPriceMilli, 400);
  assert.equal(walkPmBids([{ priceMilli: 405, sizeMilli: 10 }], 133_500), null);
});

test("early close: with no spread the user leaves with the reshape at the mid, less venue fees only", () => {
  const q = quoteEarlyClose(TERMS, {
    kalshi: { yesBids: [{ priceCents: 60, qtyMilli: 1_000_000 }], noBids: [{ priceCents: 40, qtyMilli: 1_000_000 }] },
  });
  assert.ok(q.ok);
  // user's leg: 150 x 60c = 9000c, fee ceil(7*150000*60*40/1e7) = 252 -> 8748
  assert.equal(q.positionProceedsCents, 8748);
  assert.equal(q.positionFeesCents, 252);
  // hedge leg: 133.5 x 40c = 5340c, fee ceil(7*133500*40*60/1e7) = ceil(224.28) = 225 -> 5115
  assert.equal(q.hedgeProceedsCents, 5115);
  assert.equal(q.hedgeFeesCents, 225);
  assert.equal(q.fundingCents, (100 - 63) * 150); // 5550
  // identity: 8748 + 5115 - 5550 + 112
  assert.equal(q.protectedAtCloseCents, 8425);
  assert.equal(q.nakedAtCloseCents, 8748);
  // reshape at the mid: kept 150 x 11 / 100 = 16.5 contracts x 60c = 990 + floor 7800 + credit 112
  assert.equal(q.yesMidCents, 60);
  assert.equal(q.protectedAtMidCents, 8902);
  assert.equal(q.unwindFrictionCents, 8902 - 8425);
  assert.equal(q.unwindFrictionCents, q.positionFeesCents + q.hedgeFeesCents, "zero spread: friction is the fees and nothing else");
  assert.equal(q.writerCents, 12, "the writer keeps the published take on the way out");
});

test("early close: a spread is paid by the user on both legs; the writer's result does not move", () => {
  const q = quoteEarlyClose(TERMS, {
    kalshi: { yesBids: [{ priceCents: 59, qtyMilli: 1_000_000 }], noBids: [{ priceCents: 39, qtyMilli: 1_000_000 }] },
  });
  assert.ok(q.ok);
  assert.equal(q.yesMidCents, 60, "59 bid, 61 ask");
  // 150 x 59 = 8850, fee ceil(7*150000*59*41/1e7) = ceil(253.995) = 254 -> 8596
  assert.equal(q.positionProceedsCents, 8596);
  // 133.5 x 39 = 5206.5 -> 5206 floored; fee ceil(7*133500*39*61/1e7) = ceil(222.3) = 223 -> 4983
  assert.equal(q.hedgeProceedsCents, 4983);
  assert.equal(q.protectedAtCloseCents, 8596 + 4983 - 5550 + 112); // 8141
  assert.equal(q.protectedAtMidCents, 8902);
  assert.equal(q.unwindFrictionCents, 761);
  assert.ok((q.unwindFrictionCents as number) > q.positionFeesCents + q.hedgeFeesCents, "the spread shows up as friction beyond the fees");
  assert.equal(q.writerCents, 12);
});

test("early close: a fractional size is priced to the hundredth, with the tap's rounding on funding and the floor line", () => {
  // Kalshi's 15.95 contracts, floor 45 cap 80 credit 30c, hedge (45+100-80) x 15.95 = 1036.75 -> 1037 units
  const frac: EarlyCloseTerms = { contracts: 15.95, floorCents: 45, capCents: 80, creditCents: 30, takeCents: 5, hedgeUnitsMilli: 10_370, route: "kalshi_self" };
  const q = quoteEarlyClose(frac, {
    kalshi: { yesBids: [{ priceCents: 62, qtyMilli: 1_000_000 }], noBids: [{ priceCents: 38, qtyMilli: 1_000_000 }] },
  });
  assert.ok(q.ok);
  // own sale: 15,950 milli x 62c = 988,900 milli cents -> 988c; fee ceil(7 x 15950 x 62 x 38 / 1e7) = ceil(26.3) = 27
  assert.equal(q.positionProceedsCents, 988 - 27);
  assert.equal(q.positionFeesCents, 27);
  // hedge: 10,370 milli x 38c = 394,060 -> 394c; fee ceil(7 x 10370 x 38 x 62 / 1e7) = ceil(17.1) = 18
  assert.equal(q.hedgeProceedsCents, 394 - 18);
  // funding rounds down like the tap: 20 x 15.95 = 319.0
  assert.equal(q.fundingCents, 319);
  assert.equal(q.protectedAtCloseCents, 961 + 376 - 319 + 30);
  // at the mid: kept 15.95 x 35 / 100 = 5.5825 contracts x 62c = 346.1 -> 346; floor 45 x 15.95 = 717.75 -> 718; + 30
  assert.equal(q.yesMidCents, 62);
  assert.equal(q.protectedAtMidCents, 346 + 718 + 30);
  assert.equal(q.unwindFrictionCents, 1094 - 1048);
  const thin = quoteEarlyClose(frac, { kalshi: { yesBids: [{ priceCents: 62, qtyMilli: 15_940 }], noBids: [{ priceCents: 38, qtyMilli: 1_000_000 }] } });
  assert.ok(!thin.ok && thin.code === "book_too_thin", "15.94 contracts of depth do not take 15.95");
});

test("early close: the cross-venue hedge sells into the Polymarket book; a missing token or thin book is an honest refusal", () => {
  const pmTerms: EarlyCloseTerms = { ...TERMS, route: "polymarket" };
  const kalshi = { yesBids: [{ priceCents: 60, qtyMilli: 1_000_000 }], noBids: [] as Array<{ priceCents: number; qtyMilli: number }> };
  const ok = quoteEarlyClose(pmTerms, {
    kalshi,
    pmNoBook: { tokenId: "t", asks: [], bids: [{ priceMilli: 400, sizeMilli: 1_000_000 }], minOrderSizeShares: 5, tickMilli: 10 },
  });
  assert.ok(ok.ok);
  assert.equal(ok.hedgeProceedsCents, 5340, "133.5 shares x $0.400 = $53.40, no taker fee on Polymarket");
  assert.equal(ok.hedgeFeesCents, 0);
  assert.equal(ok.yesMidCents, null, "no No bids on Kalshi: no mid, no friction figure");
  assert.equal(ok.unwindFrictionCents, null);
  assert.equal(ok.protectedAtCloseCents, 8748 + 5340 - 5550 + 112);

  const unlocatable = quoteEarlyClose(pmTerms, { kalshi });
  assert.ok(!unlocatable.ok && unlocatable.leg === "hedge" && unlocatable.code === "hedge_unlocatable");
  const thin = quoteEarlyClose(pmTerms, {
    kalshi,
    pmNoBook: { tokenId: "t", asks: [], bids: [{ priceMilli: 400, sizeMilli: 10 }], minOrderSizeShares: 5, tickMilli: 10 },
  });
  assert.ok(!thin.ok && thin.leg === "hedge" && thin.code === "book_too_thin");
  const emptyPos = quoteEarlyClose(TERMS, { kalshi: { yesBids: [], noBids: [{ priceCents: 40, qtyMilli: 1_000_000 }] } });
  assert.ok(!emptyPos.ok && emptyPos.leg === "position" && emptyPos.code === "book_empty");
  const thinPos = quoteEarlyClose(TERMS, { kalshi: { yesBids: [{ priceCents: 60, qtyMilli: 1000 }], noBids: [{ priceCents: 40, qtyMilli: 1_000_000 }] } });
  assert.ok(!thinPos.ok && thinPos.leg === "position" && thinPos.code === "book_too_thin");
  const noHedgeBids = quoteEarlyClose(TERMS, { kalshi: { yesBids: [{ priceCents: 60, qtyMilli: 1_000_000 }], noBids: [] } });
  assert.ok(!noHedgeBids.ok && noHedgeBids.leg === "hedge" && noHedgeBids.code === "book_empty");
});

test("early close: a ProphetX hedge is priced on the strike's fee-folded bids and hands the order its offset; no strike on record or no book is an honest refusal", () => {
  const pxTerms: EarlyCloseTerms = { ...TERMS, route: "prophetx", hedgeStrikeId: "strike-no-1" };
  const kalshi = { yesBids: [{ priceCents: 60, qtyMilli: 1_000_000 }], noBids: [] as Array<{ priceCents: number; qtyMilli: number }> };
  // the worker folds the fee before handing the book over: a raw 0.40 bid reads 392 here
  const pxNoBook = { tokenId: "strike-no-1", asks: [], bids: [{ priceMilli: 392, sizeMilli: 1_000_000 }], minOrderSizeShares: 1, tickMilli: 1 };
  const ok = quoteEarlyClose(pxTerms, { kalshi, pxNoBook });
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.equal(ok.hedgeProceedsCents, Math.floor((133_500 * 392) / 10_000), "133.5 shares x $0.392, the settlement fee inside the folded bid");
  assert.equal(ok.hedgeFeesCents, 0);
  assert.deepEqual(ok.hedgeSale, { venue: "prophetx", strikeId: "strike-no-1", bestPriceMilli: 392, avgPriceMilli: 392, worstPriceMilli: 392, grossCents: ok.hedgeProceedsCents, settlesAtGame: true });
  assert.equal(ok.protectedAtCloseCents, 8748 + ok.hedgeProceedsCents - 5550 + 112);

  const noBook = quoteEarlyClose(pxTerms, { kalshi });
  assert.ok(!noBook.ok && noBook.leg === "hedge" && noBook.code === "hedge_unlocatable");
  assert.match(!noBook.ok ? noBook.detail : "", /could not be read through the aggregator/);
  const noStrike = quoteEarlyClose({ ...pxTerms, hedgeStrikeId: undefined }, { kalshi, pxNoBook });
  assert.ok(!noStrike.ok && noStrike.leg === "hedge" && noStrike.code === "hedge_unlocatable");
  assert.match(!noStrike.ok ? noStrike.detail : "", /not on record/);
  const thin = quoteEarlyClose(pxTerms, { kalshi, pxNoBook: { ...pxNoBook, bids: [{ priceMilli: 392, sizeMilli: 10 }] } });
  assert.ok(!thin.ok && thin.leg === "hedge" && thin.code === "book_too_thin");
  const empty = quoteEarlyClose(pxTerms, { kalshi, pxNoBook: { ...pxNoBook, bids: [] } });
  assert.ok(!empty.ok && empty.leg === "hedge" && empty.code === "book_empty");
});

test("early close: the schedule is a deterministic draw per ticker, inside the window, off when the share is 0", () => {
  assert.equal(tickerHash("KXMLBGAME-TEST-TB"), tickerHash("KXMLBGAME-TEST-TB"));
  assert.notEqual(tickerHash("A"), tickerHash("B"));
  const open = "2026-09-12T16:00:00.000Z";
  const lock = "2026-09-13T17:40:00.000Z";
  const all = { sharePct: 100, marginMs: 15 * 60_000 };
  const s1 = earlyCloseSchedule("KXMLBGAME-TEST-TB", open, lock, all);
  const s2 = earlyCloseSchedule("KXMLBGAME-TEST-TB", open, lock, all);
  assert.deepEqual(s1, s2, "a restart replays the same schedule");
  assert.ok(s1.selected && s1.closeAtMs !== null);
  const openMs = Date.parse(open);
  const lastMs = Date.parse(lock) - all.marginMs;
  const frac = ((s1.closeAtMs as number) - openMs) / (lastMs - openMs);
  assert.ok(frac >= 0.15 && frac <= 0.85, `close lands between 15% and 85% of the window (${frac.toFixed(3)})`);
  assert.deepEqual(earlyCloseSchedule("KXMLBGAME-TEST-TB", open, lock, { sharePct: 0, marginMs: 0 }), { selected: false, closeAtMs: null });
  assert.deepEqual(earlyCloseSchedule("KXMLBGAME-TEST-TB", open, "2026-09-12T16:10:00.000Z", all), { selected: false, closeAtMs: null }, "lock inside the margin: nothing to schedule");
  // the share is a share: across many tickers roughly sharePct are selected
  let picked = 0;
  for (let i = 0; i < 1000; i += 1) if (earlyCloseSchedule(`T-${i}`, open, lock, { sharePct: 20, marginMs: 0 }).selected) picked += 1;
  assert.ok(picked > 150 && picked < 250, `about 20% selected (${picked} of 1000)`);

  assert.deepEqual(earlyCloseRuleFromEnv({}), DEFAULT_EARLY_CLOSE_RULE);
  assert.deepEqual(earlyCloseRuleFromEnv({ EVENT_SHADOW_EARLY_CLOSE_SHARE_PCT: "35", EVENT_SHADOW_EARLY_CLOSE_MARGIN_MS: "60000" }), { sharePct: 35, marginMs: 60_000 });
  assert.equal(earlyCloseRuleFromEnv({ EVENT_SHADOW_EARLY_CLOSE_SHARE_PCT: "250" }).sharePct, 100, "clamped");
  assert.equal(earlyCloseRuleFromEnv({ EVENT_SHADOW_EARLY_CLOSE_SHARE_PCT: "nope" }).sharePct, 20, "garbage falls back");
});

const OPEN: ShadowOpenRecord = {
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
  route: "kalshi_self",
  feesCents: 0,
  takeCents: 12,
};

test("early close: the ledger replays a priced close as a closed position; an unpriced attempt leaves it to settle", () => {
  const path = join(TMP_DIR, "closes.jsonl");
  appendShadowRecord(path, OPEN);
  appendShadowRecord(path, { ...OPEN, ticker: "KXNFLGAME-TEST-NE", league: "nfl", sideName: "New England Patriots" });
  appendShadowRecord(path, { ...OPEN, ticker: "KXBTCD-TEST", kind: "crypto", league: "crypto", sideName: "Bitcoin above 110k" });
  appendShadowRecord(path, {
    type: "close",
    at: "2026-09-13T01:00:00.000Z",
    ticker: OPEN.ticker,
    priced: true,
    yesMidCents: 60,
    yesFillCents: 59,
    positionProceedsCents: 8596,
    hedgeProceedsCents: 4983,
    feesCents: 477,
    protectedAtCloseCents: 8141,
    protectedAtMidCents: 8902,
    unwindFrictionCents: 761,
  });
  // a settle after a close is ignored: the position is gone
  appendShadowRecord(path, { type: "settle", at: "2026-09-13T22:00:00.000Z", ticker: OPEN.ticker, result: "yes" });
  // the second position's exit found no depth; it then settles as usual
  appendShadowRecord(path, { type: "close", at: "2026-09-13T01:00:00.000Z", ticker: "KXNFLGAME-TEST-NE", priced: false, reason: "hedge leg: no resting No bids" });
  appendShadowRecord(path, { type: "settle", at: "2026-09-13T22:00:00.000Z", ticker: "KXNFLGAME-TEST-NE", result: "no" });

  const positions = loadShadowPositions(path);
  const closed = positions.find((p) => p.ticker === OPEN.ticker);
  assert.ok(closed);
  assert.equal(closed.status, "closed");
  assert.equal(closed.closedAt, "2026-09-13T01:00:00.000Z");
  assert.equal(closed.protectedCents, 8141);
  assert.equal(closed.nakedCents, 8596);
  assert.equal(closed.deltaCents, 8141 - 8596);
  assert.equal(closed.writerCents, 12, "the writer's result on a close is the take");
  assert.equal(closed.closeUnwindFrictionCents, 761);
  assert.equal(closed.result, undefined, "the later settle did not apply");

  const unpriced = positions.find((p) => p.ticker === "KXNFLGAME-TEST-NE");
  assert.ok(unpriced);
  assert.equal(unpriced.status, "settled");
  assert.deepEqual(unpriced.closeUnpriced, { at: "2026-09-13T01:00:00.000Z", reason: "hedge leg: no resting No bids" });
  assert.equal(unpriced.protectedCents, 52 * 150 + 112, "settled on the floor as usual");

  const s = summarizeShadow(positions);
  assert.equal(s.openCount, 1);
  assert.equal(s.settledCount, 1);
  assert.equal(s.closed.count, 1);
  assert.equal(s.closed.unpriced, 1);
  assert.equal(s.closed.protectedAtCloseCents, 8141);
  assert.equal(s.closed.nakedAtCloseCents, 8596);
  assert.equal(s.closed.deltaCents, -455);
  assert.equal(s.closed.withMid, 1);
  assert.equal(s.closed.unwindFrictionCents, 761);
  assert.equal(s.closed.feesCents, 477);
  assert.equal(s.closed.writerPnlCents, 12);
  assert.equal(s.closed.takeBookedCents, 12);
  assert.equal(s.closed.stakeCents, 15_000);
  assert.deepEqual(s.closed.byKind, { sports: { closed: 1, unpriced: 1 }, crypto: { closed: 0, unpriced: 0 } });
  assert.equal(s.identity.settled, 1, "the identity card stays on settled events");
  assert.equal(s.writer.takeLockedOpenCents, 12, "only the still-open position's take is locked");

  const csv = positionsCsv(positions, "public");
  const header = csv.split("\n")[0].split(",");
  assert.deepEqual(header, [...POSITIONS_CSV_PUBLIC_COLUMNS]);
  const row = csv.split("\n").find((l) => l.startsWith(OPEN.ticker)) as string;
  const cells = row.split(",");
  const col = (name: string) => cells[header.indexOf(name)];
  assert.equal(col("status"), "closed");
  assert.equal(col("holder_protected_c"), "8141");
  assert.equal(col("holder_naked_c"), "8596");
  // the public sheet is the holder's side: where the other side was bought and our own side of the row are the operator's
  for (const name of ["route", "take_c", "fees_c", "hedge_units_milli", "hedge_cost_c", "hedge_payout_c", "writer_pnl_c"]) assert.equal(header.indexOf(name), -1, name);
  assert.equal(col("shape"), "hedged lock");
  assert.ok(!/polymarket|kalshi_self|prophetx|novig/.test(csv), "no route on any public row");
  const fullCsv = positionsCsv(positions, "full").split("\n");
  assert.equal(fullCsv.find((l) => l.startsWith(OPEN.ticker))?.split(",")[fullCsv[0].split(",").indexOf("writer_pnl_c")], "12");
  assert.equal(col("closed_at_utc"), "2026-09-13T01:00:00.000Z");
  assert.equal(col("close_mid_c"), "60");
  assert.equal(col("close_fill_c"), "59");
  assert.equal(col("close_fees_c"), "477");
  assert.equal(col("close_friction_c"), "761");
  const settledRow = csv.split("\n").find((l) => l.startsWith("KXNFLGAME-TEST-NE")) as string;
  assert.equal(settledRow.split(",")[header.indexOf("closed_at_utc")], "", "a settled row leaves the close columns blank");

  const html = renderShadowHtml({
    atIso: "2026-09-14T00:00:00.000Z",
    summary: s,
    open: positions.filter((p) => p.status === "open"),
    settled: positions.filter((p) => p.status === "settled"),
    closed: positions.filter((p) => p.status === "closed"),
  });
  assert.ok(html.includes("<h2>Closed early at live prices</h2>"), "the card");
  assert.ok(html.includes('Tampa Bay Rays <span class="tag">left early</span>'), "the row");
  assert.ok(html.includes("$81.41 <i>vs $85.96 without the lock</i>"), "what they left with against selling unprotected");
  assert.ok(html.includes("1 position left before the lock.") && html.includes("Crossing both books cost $7.61 against the mid (5.07% of stake)."), "the read line");
  assert.ok(html.includes("1 other scheduled exit found no depth on a leg and ran to settlement instead."), "unpriced attempts are counted, not hidden");
  assert.ok(html.includes("1 left before the game at live prices; see the early closes below."), "the sports card points at it");
  assert.ok(html.includes("only opened, closed early at live prices, and settled"), "the footer's append-only line includes closes");
  assert.ok(!html.includes("—"), "no em dash");

  const empty = renderShadowHtml({ atIso: "2026-09-14T00:00:00.000Z", summary: summarizeShadow([]), open: [], settled: [], closed: [] });
  assert.ok(!empty.includes("Closed early at live prices"), "no card until something closes or tries to");
});

test("early close: the shadow worker closes due positions from the live books, once, and records unpriced legs honestly", async () => {
  const stub = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      (req.url ?? "").includes("/orderbook")
        ? JSON.stringify({ orderbook_fp: { yes_dollars: [["0.5900", "100000"]], no_dollars: [["0.3900", "100000"]] } })
        : "{}",
    );
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", () => r()));
  const ledger = join(TMP_DIR, "worker-ledger.jsonl");
  process.env.KALSHI_REST_BASE = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/trade-api/v2`;
  process.env.EVENT_SHADOW_LEDGER_PATH = ledger;
  process.env.EVENT_SHADOW_EARLY_CLOSE_SHARE_PCT = "100";
  try {
    const { closeTick } = await import("../scripts/eventShadowWorker");
    const now = Date.now();
    const DAY = 86_400_000;
    // opened ten days ago, locks tomorrow: every draw in the 15%..85% window is already past
    const due = { ...OPEN, at: new Date(now - 10 * DAY).toISOString(), eventTimeIso: new Date(now + DAY).toISOString() };
    appendShadowRecord(ledger, due);
    // a cross-venue position from before hedge tokens were recorded: its hedge leg cannot be located
    appendShadowRecord(ledger, { ...due, ticker: "KXNFLGAME-OLD-PM", league: "nfl", route: "polymarket" });
    // opened just now: its draw is still ahead
    appendShadowRecord(ledger, { ...due, ticker: "KXBTCD-FRESH", kind: "crypto", league: "crypto", at: new Date(now).toISOString() });

    await closeTick();
    let positions = loadShadowPositions(ledger);
    const closed = positions.find((p) => p.ticker === OPEN.ticker);
    assert.ok(closed && closed.status === "closed", "the due position closed");
    assert.equal(closed.protectedCents, 8141, "priced from the stub's 59/39 book exactly as the pricer test");
    assert.equal(closed.nakedCents, 8596);
    assert.equal(closed.closeYesMidCents, 60);
    assert.equal(closed.closeUnwindFrictionCents, 761);
    assert.equal(closed.writerCents, 12);
    const old = positions.find((p) => p.ticker === "KXNFLGAME-OLD-PM");
    assert.ok(old && old.status === "open", "the unlocatable hedge leaves the position open");
    assert.match(old.closeUnpriced?.reason ?? "", /^hedge leg: the hedge token for this position is not on record/);
    const fresh = positions.find((p) => p.ticker === "KXBTCD-FRESH");
    assert.ok(fresh && fresh.status === "open" && !fresh.closeUnpriced, "not due yet: untouched");

    const linesAfterFirst = readLedgerLines(ledger);
    assert.equal(linesAfterFirst, 5, "three opens, one priced close, one unpriced close");
    await closeTick();
    assert.equal(readLedgerLines(ledger), 5, "a second tick writes nothing: closed stays closed, unpriced is not retried");
    positions = loadShadowPositions(ledger);
    assert.equal(positions.filter((p) => p.status === "closed").length, 1);
  } finally {
    await new Promise<void>((r) => stub.close(() => r()));
    delete process.env.KALSHI_REST_BASE;
  }
});

function readLedgerLines(path: string): number {
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).length;
}

test("early close: /api/close-quote prices the locked terms from the live books; bad input and unknown rows refuse", async () => {
  // A stub Kalshi: one orderbook for every market, both sides deep, 59 bid / 61 ask.
  const stub = createServer((req, res) => {
    if ((req.url ?? "").includes("/orderbook")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ orderbook_fp: { yes_dollars: [["0.5900", "100000"]], no_dollars: [["0.3900", "100000"]] } }));
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", () => r()));
  process.env.KALSHI_REST_BASE = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/trade-api/v2`;

  const { server, primeScanForTests } = await import("../scripts/eventProtectXDemoService");
  const market = {
    ticker: "KXMLBGAME-TEST-TB",
    eventTicker: "KXMLBGAME-TEST",
    title: "Tampa Bay Rays at Boston Red Sox",
    subtitle: "Tampa Bay Rays",
    strike: 0,
    strikeType: "",
    status: "open",
    openTime: "2026-09-12T00:00:00.000Z",
    closeTime: "2026-09-13T17:40:00.000Z",
    yesBidCents: 59,
    yesAskCents: 61,
    lastPriceCents: 60,
    volume: 1000,
    openInterest: 500,
    rulesPrimary: "",
  };
  const terms = {
    floorCents: 52,
    capCents: 63,
    creditCents: 112,
    grossCreditCents: 124,
    takeCents: 12,
    takeShareCents: 12,
    takeMinimumCents: 4,
    takeRule: "share" as const,
    takeWaived: false,
    hedge: { action: "buy" as const, venue: "kalshi" as const, outcome: "No" as const, ticker: market.ticker, contractsMilli: 133_500, avgPriceCents: 40, worstPriceCents: 40, costCents: 5340 },
    feesCents: 86,
    evCostBps: 297,
  };
  primeScanForTests({
    atIso: "2026-09-12T16:00:00.000Z",
    rows: [
      {
        evBps: 297,
        res: {
          kind: "sports",
          league: "mlb",
          market,
          pair: null,
          sideName: "Tampa Bay Rays",
          eventTitle: "Tampa Bay Rays at Boston Red Sox",
          eventTimeIso: "2026-09-13T17:40:00.000Z",
          parityNote: "",
          fingerprint: "mlb:tb:bos:2026-09-13",
          markCents: 60,
          position: { contracts: 150, entryCents: 55, entrySource: "real_print", entryTime: "2026-09-12T15:00:00.000Z" },
          quote: {
            ok: true,
            kalshiTicker: market.ticker,
            pmEventSlug: "",
            contracts: 150,
            markCents: 60,
            entryCents: 55,
            ...terms,
            takeBps: 1000,
            minTakeBpsOfStake: 25,
            tier: "balanced",
            tiers: { balanced: terms },
            candidatesConsidered: 3,
            parityNote: "",
            quotedAt: "2026-09-12T16:00:00.000Z",
          },
          route: "kalshi_self",
          evBps: 297,
          routesChecked: [],
          books: {},
        },
      },
    ],
    fallback: null,
    fetchFailures: 0,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const good = await fetch(`${base}/api/close-quote?ticker=KXMLBGAME-TEST-TB&floor=52&cap=63&credit=112`);
    assert.equal(good.status, 200);
    const q = (await good.json()) as Record<string, unknown>;
    assert.equal(q.ok, true);
    assert.equal(q.contracts, 150);
    // same books as the pricer test with a 59/39 spread: 8596 + 4983 - 5550 + 112
    assert.equal(q.leaveWithCents, 8141);
    assert.equal(q.withoutProtectionCents, 8596);
    assert.equal(q.midCents, 60);
    assert.equal(q.fillCents, 59);
    assert.equal(q.feesCents, 477);
    assert.equal(q.atMidCents, 8902);
    assert.equal(q.costVsMidCents, 761);
    assert.equal(q.legs, undefined, "the leg-by-leg quote is the operator's");
    assert.equal(q.route, undefined);
    assert.ok(!JSON.stringify(q).toLowerCase().includes("hedge"), "retail JSON carries no hedge vocabulary");

    const op = (await (await fetch(`${base}/api/close-quote?ticker=KXMLBGAME-TEST-TB&floor=52&cap=63&credit=112&token=t0ken`)).json()) as { legs: { writerCents: number; hedgeProceedsCents: number }; route: string };
    assert.equal(op.route, "kalshi_self");
    assert.equal(op.legs.hedgeProceedsCents, 4983);

    assert.equal((await fetch(`${base}/api/close-quote?ticker=NOPE&floor=52&cap=63&credit=112`)).status, 404);
    assert.equal((await fetch(`${base}/api/close-quote?ticker=KXMLBGAME-TEST-TB&floor=63&cap=52&credit=112`)).status, 400, "floor above cap");
    assert.equal((await fetch(`${base}/api/close-quote?ticker=KXMLBGAME-TEST-TB&floor=52&cap=63&credit=99999999`)).status, 400, "credit beyond the stake");
    assert.equal((await fetch(`${base}/api/close-quote?ticker=KXMLBGAME-TEST-TB&floor=52.5&cap=63&credit=112`)).status, 400, "cents are integers");

    // the funnel accepts the two new actions
    for (const action of ["close_quote", "close_early"]) {
      const r = await fetch(`${base}/api/metrics`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sid: "closeclos", action, ticker: "KXMLBGAME-TEST-TB", tier: "balanced" }),
      });
      assert.equal(r.status, 204, action);
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => stub.close(() => r()));
    delete process.env.KALSHI_REST_BASE;
  }
});