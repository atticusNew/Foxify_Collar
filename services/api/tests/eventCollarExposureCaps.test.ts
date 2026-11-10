/**
 * Exposure caps (crossVenue/exposureCaps.ts): what may be open at once on one game, on one hedge
 * venue and for one holder. The caps as the deploy sets them, the three sums read back from
 * replayed ledgers (what counts, what stops counting, what an attempt in flight holds), and the
 * check at its boundary. Pure: files in a temp directory, no venue, no server. The worker's lock
 * route behind the gate is eventCollarExposureGate.test.ts.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_EXPOSURE_CAPS,
  NO_CAP,
  SHARED_HOLDER,
  capRefusalDetail,
  capRefusalDetails,
  capRefusalWords,
  checkExposure,
  exposureCapsFromEnv,
  exposureView,
  gameCentsOf,
  gameKeyOf,
  hedgeReserveCents,
  holderCentsOf,
  openExposure,
  proposedExposure,
  uncappedSettings,
  venueCapOf,
  type ExposureAdd,
  type ExposureCaps,
  type LockOnRecord,
} from "../src/eventCollar/crossVenue/exposureCaps";
import type { HedgeReceipt } from "../src/eventCollar/crossVenue/hedgeExecutor";
import { appendPending, capRefusals, loadPending, summarizePending, type PendingRecord } from "../src/eventCollar/crossVenue/hedgeFirst";
import { appendShadowRecord, loadShadowPositions, type HedgeFillOnRecord, type ShadowOpenRecord } from "../src/eventCollar/crossVenue/shadowLedger";

const BOS = "KXNBAGAME-26OCT14LALBOS-BOS";
const LAL = "KXNBAGAME-26OCT14LALBOS-LAL";
const NYK = "KXNBAGAME-26OCT15NYKMIA-NYK";
const GAME = "nba:26OCT14LALBOS";

const caps = (over: Partial<ExposureCaps> = {}): ExposureCaps => ({ gameCents: 5_000, venueCents: 10_000, venueOverrides: {}, holderCents: 5_000, notes: [], ...over });

// ---------------------------------------------------------------------------
// the caps as set
// ---------------------------------------------------------------------------

test("caps from the env: unset is the documented default, never no cap; `none` is the only way to say no cap; anything unreadable is the default, with a note", () => {
  assert.deepEqual(DEFAULT_EXPOSURE_CAPS, { gameCents: 5_000, venueCents: 10_000, holderCents: 5_000 });
  assert.deepEqual(exposureCapsFromEnv({}), { gameCents: 5_000, venueCents: 10_000, venueOverrides: {}, holderCents: 5_000, notes: [] });
  assert.deepEqual(uncappedSettings(exposureCapsFromEnv({})), []);

  const set = exposureCapsFromEnv({
    EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_GAME: "7500",
    EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_VENUE: " 20000 ",
    EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_VENUE_NOVIG: "2500",
    EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_HOLDER: "0",
  });
  assert.equal(set.gameCents, 7_500);
  assert.equal(set.venueCents, 20_000);
  assert.equal(set.holderCents, 0, "zero is a cap: nothing may be open");
  assert.deepEqual(set.notes, []);
  assert.equal(venueCapOf(set, "kalshi"), 20_000, "a venue with no setting of its own takes the venue-wide cap");
  assert.equal(venueCapOf(set, "novig"), 2_500, "a new exchange capped lower than the rest");

  // the empty string is unset, as on a dashboard row left blank
  assert.equal(exposureCapsFromEnv({ EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_GAME: "" }).gameCents, 5_000);
  assert.equal(exposureCapsFromEnv({ EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_GAME: "   " }).gameCents, 5_000);

  for (const word of ["none", "NONE", " None "]) {
    const off = exposureCapsFromEnv({ EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_GAME: word });
    assert.equal(off.gameCents, null, `"${word}" is no cap`);
    assert.deepEqual(uncappedSettings(off), ["EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_GAME"]);
    assert.equal(off.venueCents, 10_000, "the others keep their defaults");
  }

  // nothing else is read as no cap, and nothing is guessed at
  for (const bad of ["-1", "50.5", "$50", "5e3", "unlimited", "off", "0x10", "Infinity", "no", "null", "1,000"]) {
    const c = exposureCapsFromEnv({ EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_HOLDER: bad });
    assert.equal(c.holderCents, 5_000, `"${bad}" is the default`);
    assert.equal(c.notes.length, 1);
    assert.match(c.notes[0], /^EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_HOLDER is neither a whole number of cents nor the word none; the default of 5000 cents applies$/);
    assert.ok(!c.notes[0].includes(bad) || bad === "no", "the note names the setting, not what was typed into it");
  }

  // a venue's own setting: `none` lifts that venue only; one that cannot be read never lifts anything
  const lifted = exposureCapsFromEnv({ EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_VENUE_KALSHI: "none" });
  assert.equal(venueCapOf(lifted, "kalshi"), null);
  assert.equal(venueCapOf(lifted, "novig"), 10_000);
  assert.deepEqual(uncappedSettings(lifted), ["EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_VENUE_KALSHI"]);
  const typo = exposureCapsFromEnv({ EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_VENUE: "3000", EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_VENUE_NOVIG: "25oo" });
  assert.equal(venueCapOf(typo, "novig"), 3_000, "an unreadable venue setting falls back to the venue-wide cap");
  assert.match(typo.notes[0], /EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_VENUE_NOVIG .* 3000 cents applies to Novig/);
  const typoUnderNone = exposureCapsFromEnv({ EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_VENUE: "none", EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_VENUE_NOVIG: "25oo" });
  assert.equal(venueCapOf(typoUnderNone, "novig"), 10_000, "and to the default when the venue-wide cap is none: a typo is never no cap");
  assert.equal(venueCapOf(typoUnderNone, "kalshi"), null);

  const all = exposureCapsFromEnv({
    EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_GAME: "none",
    EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_VENUE: "none",
    EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_VENUE_PROPHETX: "none",
    EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_HOLDER: "none",
  });
  assert.deepEqual(uncappedSettings(all), [
    "EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_GAME",
    "EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_VENUE",
    "EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_VENUE_PROPHETX",
    "EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_HOLDER",
  ]);
});

test("the game key: the league and the date-and-teams part of the ticker, so both sides and every market series on one game share it", () => {
  assert.equal(gameKeyOf(BOS, "nba"), GAME);
  assert.equal(gameKeyOf(LAL, "nba"), GAME, "the other side of the same game");
  assert.equal(gameKeyOf("KXNBASPREAD-26OCT14LALBOS-BOS4", "nba"), GAME, "another market series on the same game");
  assert.equal(gameKeyOf("KXEPLGAME-26NOV14ARSTOT-TIE", "EPL"), "epl:26NOV14ARSTOT", "a draw market; the league is lower-cased");
  assert.notEqual(gameKeyOf(NYK, "nba"), GAME, "another game");
  assert.notEqual(gameKeyOf("KXNHLGAME-26OCT14LALBOS-BOS", "nhl"), GAME, "the same letters in another league are another game");
  // without a league the series stands in for it: both sides still share the key
  assert.equal(gameKeyOf(BOS), "kxnbagame:26OCT14LALBOS");
  assert.equal(gameKeyOf(LAL, ""), "kxnbagame:26OCT14LALBOS");
  assert.equal(gameKeyOf("KXFOO-A-B-C", "x"), "x:A-B", "everything between the series and the outcome");
  // nothing to split: the ticker is its own game
  assert.equal(gameKeyOf("KXBTCD-26NOV1017", "crypto"), "KXBTCD-26NOV1017");
  assert.equal(gameKeyOf("ODD", "nba"), "ODD");
});

// ---------------------------------------------------------------------------
// what is open, from replayed ledgers
// ---------------------------------------------------------------------------

const OPEN: ShadowOpenRecord = {
  type: "open",
  at: "2026-11-10T01:00:00.000Z",
  ticker: BOS,
  kind: "sports",
  league: "nba",
  sideName: "Boston Celtics",
  eventTitle: "Lakers at Celtics",
  eventTimeIso: "2026-11-11T00:10:00.000Z",
  contracts: 20,
  markCents: 60,
  floorCents: 30,
  capCents: 68,
  creditCents: 99,
  evCostBps: 250,
  route: "kalshi_self",
  feesCents: 11,
  takeCents: 5,
  hedgeCostCents: 536,
  hedgeUnitsMilli: 12_400,
  tier: "balanced",
  source: "lock",
  entryCents: 58,
};

const fillOf = (receiptId: string, costCents: number, venue: HedgeFillOnRecord["venue"] = "kalshi", unitsMilli = 12_400): HedgeFillOnRecord => ({ venue, unitsMilli, costCents, orderId: `ord-${receiptId}`, receiptId });

function receipt(id: string, ref: string, at: string, costCents: number, opts: { simulated?: boolean; action?: "buy" | "sell"; venue?: HedgeFillOnRecord["venue"]; unitsMilli?: number } = {}): HedgeReceipt {
  const venue = opts.venue ?? "kalshi";
  const unitsMilli = opts.unitsMilli ?? 12_400;
  const simulated = Boolean(opts.simulated);
  return {
    id,
    at,
    ref,
    intent: { venue, instrument: ref.split("@")[0], outcome: "No", unitsMilli, book: { bestPriceMilli: 410, avgPriceMilli: 410, worstPriceMilli: 420, costCents }, maxCostCents: costCents, ...(opts.action ? { action: opts.action } : {}) },
    attempts: [],
    fill: { venue, unitsMilli, avgPriceMilli: 410, costCents, simulated, ids: simulated ? {} : { orderId: `ord-${id}` } },
    outcome: simulated ? "filled_book" : "filled_live",
    fallbackReason: simulated ? "dry run" : null,
    bookWalkPenaltyCents: 0,
  } as unknown as HedgeReceipt;
}

/** A lock ledger written line by line and replayed, as the worker reads it. */
function ledgerOf(holder: string | null, lines: Array<Parameters<typeof appendShadowRecord>[1]>): LockOnRecord[] {
  const path = join(mkdtempSync(join(tmpdir(), "exposure-")), "lock.jsonl");
  for (const l of lines) appendShadowRecord(path, l);
  return loadShadowPositions(path).map((p) => ({ p, holder }));
}

test("one lock's share of each sum: the game takes floor, credit and hedge cost; the holder takes the larger of what we can owe them and what they can owe us", () => {
  // 20 contracts, floor 30, cap 68, credit 99
  assert.equal(gameCentsOf(OPEN, 525), 30 * 20 + 99 + 525);
  assert.equal(gameCentsOf(OPEN, 0), 699);
  // we owe floor + credit = 699 if the side loses; they owe (100 - 68) x 20 = 640 if it wins
  assert.equal(holderCentsOf(OPEN), 699);
  // a high cap and a low floor: 15 x 20 + 38 = 338 against (100 - 85) x 20 = 300
  assert.equal(holderCentsOf({ ...OPEN, floorCents: 15, capCents: 85, creditCents: 38 }), 338);
  // a low cap, an underdog: 22 x 20 + 45 = 485 against (100 - 33) x 20 = 1340: the hand-back is the larger
  assert.equal(holderCentsOf({ ...OPEN, floorCents: 22, capCents: 33, creditCents: 45 }), 1_340);
  // the credit already paid is no longer owed
  assert.equal(holderCentsOf({ ...OPEN, cash: [{ at: OPEN.at, leg: "credit", cents: 99 }] }), 640, "floor alone (600) is now under the hand-back (640)");
  assert.equal(holderCentsOf({ ...OPEN, cash: [{ at: OPEN.at, leg: "credit", cents: 40 }, { at: OPEN.at, leg: "floor", cents: 500 }] }), 659, "only credit lines reduce the credit owed");
  // fractional contracts (a parlay's size): whole cents, the floor rounded half up, the hand-back down
  assert.equal(holderCentsOf({ contracts: 66.18, floorCents: 55, capCents: 88, creditCents: 25 }), Math.max(Math.round(55 * 66.18) + 25, Math.floor(12 * 66.18)));
  for (const v of [gameCentsOf({ contracts: 66.18, floorCents: 55, capCents: 88, creditCents: 25 }, 750), holderCentsOf({ contracts: 7.5, floorCents: 33, capCents: 71, creditCents: 3 })]) {
    assert.ok(Number.isInteger(v), "integer cents");
  }

  // a new lock is measured at the most its order can cost: every unit at the limit, or the walk if more, plus quoted fees
  assert.equal(hedgeReserveCents({ unitsMilli: 12_400, limitMilli: 420, maxCostCents: 515 }, 11), 521 + 11);
  assert.equal(hedgeReserveCents({ unitsMilli: 12_400, limitMilli: 420, maxCostCents: 530 }), 530);
  const add = proposedExposure({ ticker: LAL, league: "nba", holder: "alice", contracts: 20, floorCents: 30, capCents: 68, creditCents: 99, venue: "novig", hedgeReserveCents: 532 });
  assert.deepEqual(add, { game: GAME, venue: "novig", holder: "alice", gameCents: 600 + 99 + 532, venueCents: 532, holderCents: 699 });
  assert.equal(proposedExposure({ ticker: BOS, league: "nba", holder: null, contracts: 5, floorCents: 15, capCents: 85, creditCents: 10, venue: "kalshi", hedgeReserveCents: 65 }).holder, SHARED_HOLDER, "the shared key is its own holder");
});

test("what counts: an open lock behind a real fill, by its game, its venue and its holder; a simulated lock counts for nothing", () => {
  const real = ledgerOf("alice", [{ ...OPEN, holder: "alice", hedgeFill: fillOf("r1", 525) }]);
  const paper = ledgerOf("bob", [{ ...OPEN, holder: "bob" }]);
  // the simulated lock's own receipt, as fillHedge writes it on the paper path
  const receipts = [receipt("p1", `${BOS}@bob`, "2026-11-10T01:00:00.100Z", 525, { simulated: true })];
  const open = openExposure({ locks: [...real, ...paper], receipts, pending: [] });
  assert.deepEqual(open.games, { [GAME]: { game: GAME, openCents: 600 + 99 + 525, locks: 1, title: "Lakers at Celtics", eventTimeIso: OPEN.eventTimeIso } });
  assert.deepEqual(open.venues, { kalshi: 525 });
  assert.deepEqual(open.holders, { alice: { openCents: 699, locks: 1 } });
  assert.equal(open.realOpenLocks, 1);
  assert.equal(open.simulatedOpenLocks, 1);

  // nothing but simulated locks: every sum is empty
  const none = openExposure({ locks: paper, receipts, pending: [] });
  assert.deepEqual([none.games, none.venues, none.holders, none.realOpenLocks], [{}, {}, {}, 0]);
});

test("both sides of a game and every holder on it add to one game; venues and holders stay apart", () => {
  const locks = [
    ...ledgerOf("alice", [{ ...OPEN, holder: "alice", hedgeFill: fillOf("r1", 525) }]),
    ...ledgerOf("bob", [{ ...OPEN, ticker: LAL, sideName: "Los Angeles Lakers", holder: "bob", floorCents: 15, capCents: 85, creditCents: 38, hedgeFill: fillOf("r2", 257, "novig") }]),
    ...ledgerOf(null, [
      { ...OPEN, ticker: NYK, eventTitle: "Knicks at Heat", contracts: 10, creditCents: 21, hedgeFill: fillOf("r3", 129) },
      { ...OPEN, ticker: LAL, contracts: 5, floorCents: 15, capCents: 85, creditCents: 10, hedgeFill: fillOf("r4", 65) },
    ]),
  ];
  const open = openExposure({ locks, receipts: [], pending: [] });
  assert.equal(open.games[GAME].openCents, 600 + 99 + 525 + (300 + 38 + 257) + (75 + 10 + 65));
  assert.equal(open.games[GAME].locks, 3);
  assert.equal(open.games["nba:26OCT15NYKMIA"].openCents, 300 + 21 + 129);
  assert.deepEqual(open.venues, { kalshi: 525 + 129 + 65, novig: 257 });
  assert.deepEqual(open.holders, {
    alice: { openCents: 699, locks: 1 },
    bob: { openCents: 338, locks: 1 },
    [SHARED_HOLDER]: { openCents: 300 + 21 + (75 + 10), locks: 2 },
  });
  assert.equal(open.realOpenLocks, 4);
});

test("settled, voided and unwound locks stop counting the moment the ledger says so; a lock taken off the record is gone; a member's own sale never counts", () => {
  const base = { ...OPEN, hedgeFill: fillOf("r1", 525) };
  const before = openExposure({ locks: ledgerOf(null, [base]), receipts: [], pending: [] });
  assert.equal(before.games[GAME].openCents, 1_224);

  const endings: Array<[string, Parameters<typeof appendShadowRecord>[1]]> = [
    ["settled", { type: "settle", at: "2026-11-11T03:00:00.000Z", ticker: BOS, result: "no" }],
    ["void", { type: "void", at: "2026-11-11T03:00:00.000Z", ticker: BOS, reason: "postponed" }],
    ["closed", { type: "close", at: "2026-11-10T20:00:00.000Z", ticker: BOS, priced: true, positionProceedsCents: 1100, hedgeProceedsCents: 480, feesCents: 9, protectedAtCloseCents: 1150 }],
  ];
  for (const [status, line] of endings) {
    const locks = ledgerOf(null, [base, line]);
    assert.equal(locks[0].p.status, status);
    const after = openExposure({ locks, receipts: [receipt("r1", BOS, "2026-11-10T01:00:00.200Z", 525)], pending: [] });
    assert.deepEqual([after.games, after.venues, after.holders, after.realOpenLocks, after.simulatedOpenLocks], [{}, {}, {}, 0, 0], `${status}: the room is free`);
  }

  // an early close that could not be priced closes nothing: the lock still stands and still counts
  const unpriced = ledgerOf(null, [base, { type: "close", at: "2026-11-10T20:00:00.000Z", ticker: BOS, priced: false, reason: "no bids" }]);
  assert.equal(unpriced[0].p.status, "open");
  assert.equal(openExposure({ locks: unpriced, receipts: [], pending: [] }).games[GAME].openCents, 1_224);

  // a lock archived by the operator's reset is not on the ledger any more; its receipt alone counts for nothing
  const archived = openExposure({ locks: [], receipts: [receipt("r1", BOS, "2026-11-10T01:00:00.200Z", 525)], pending: [] });
  assert.deepEqual(archived.venues, {});

  // unwound, then the same market locked again: only the lock that stands counts, at its own fill
  const again = ledgerOf(null, [
    base,
    endings[2][1],
    { ...OPEN, at: "2026-11-10T21:00:00.000Z", contracts: 5, floorCents: 15, capCents: 85, creditCents: 10, hedgeFill: fillOf("r9", 65) },
  ]);
  assert.deepEqual(again.map((l) => l.p.status).sort(), ["closed", "open"]);
  const trail = [receipt("r1", BOS, "2026-11-10T01:00:00.200Z", 525), receipt("s1", BOS, "2026-11-10T20:00:00.000Z", 480, { action: "sell" }), receipt("r9", BOS, "2026-11-10T21:00:00.200Z", 65)];
  const second = openExposure({ locks: again, receipts: trail, pending: [] });
  assert.equal(second.games[GAME].openCents, 75 + 10 + 65);
  assert.deepEqual(second.venues, { kalshi: 65 }, "the unwound lock's buy is before the new lock and is not its hedge");
  assert.equal(second.realOpenLocks, 1);
  // the same second lock written before the fill was put on its line: its own receipt, and only its own
  const { hedgeFill: _f, ...bareSecond } = { ...OPEN, at: "2026-11-10T21:00:00.000Z", contracts: 5, floorCents: 15, capCents: 85, creditCents: 10, hedgeFill: fillOf("r9", 65) };
  assert.deepEqual(openExposure({ locks: ledgerOf(null, [base, endings[2][1], bareSecond]), receipts: trail, pending: [] }).venues, { kalshi: 65 });

  const sale = ledgerOf("carol", [{ ...OPEN, holder: "carol", route: "member_sale", hedgeCostCents: 0, hedgeUnitsMilli: 0, creditCents: 0 }]);
  const member = openExposure({ locks: sale, receipts: [], pending: [] });
  assert.deepEqual([member.games, member.holders, member.realOpenLocks, member.simulatedOpenLocks], [{}, {}, 0, 0], "no hedge and no cash of ours");
});

test("a lock from before the fill was written on its line counts by its receipt, or by the pending trail when the receipts were archived; one fill is counted once", () => {
  const old = ledgerOf("alice", [{ ...OPEN, holder: "alice" }]);
  const ref = `${BOS}@alice`;
  const live = receipt("r1", ref, "2026-11-10T01:00:00.200Z", 525);
  const byReceipt = openExposure({ locks: old, receipts: [live], pending: [] });
  assert.equal(byReceipt.games[GAME].openCents, 1_224);
  assert.deepEqual(byReceipt.venues, { kalshi: 525 });
  assert.equal(byReceipt.realOpenLocks, 1);

  // a receipt under another holder's ref, a sale, a simulated fill, or a fill from before the lock: none is this lock's hedge
  const others = [
    receipt("x1", BOS, "2026-11-10T01:00:00.200Z", 525),
    receipt("x2", `${BOS}@bob`, "2026-11-10T01:00:00.200Z", 525),
    receipt("x3", ref, "2026-11-10T01:00:00.200Z", 480, { action: "sell" }),
    receipt("x4", ref, "2026-11-10T01:00:00.200Z", 525, { simulated: true }),
    receipt("x5", ref, "2026-11-09T23:00:00.000Z", 525),
  ];
  const stillPaper = openExposure({ locks: old, receipts: others, pending: [] });
  assert.equal(stillPaper.realOpenLocks, 0);
  assert.equal(stillPaper.simulatedOpenLocks, 1);

  // the pending trail of the same lock: asked, then locked with its fill
  const asked: PendingRecord = { type: "pending", id: `${ref}#2026-11-10T01:00:00.050Z`, at: "2026-11-10T01:00:00.050Z", ref, ticker: BOS, holder: "alice", terms: { contracts: 20, tier: "balanced", floorCents: 30, capCents: 68, creditCents: 99 }, order: { venue: "kalshi", instrument: BOS, action: "buy", unitsMilli: 12_400, limitMilli: 420, maxCostCents: 521 } };
  const locked: PendingRecord = { type: "resolved", id: asked.id, at: "2026-11-10T01:00:00.300Z", outcome: "locked", detail: "the whole hedge filled", fill: { unitsMilli: 12_400, costCents: 525, orderId: "ord-r1", receiptId: "r1" } };
  const byTrail = openExposure({ locks: old, receipts: [], pending: [asked, locked] });
  assert.deepEqual(byTrail.venues, { kalshi: 525 }, "the receipts archived: the trail still says a real order bought this hedge");
  assert.equal(byTrail.pendingUnresolved, 0, "a resolved attempt holds nothing of its own");

  // the line, the receipt and the trail all name the same fill: once
  const withFill = ledgerOf("alice", [{ ...OPEN, holder: "alice", hedgeFill: fillOf("r1", 525) }]);
  const thrice = openExposure({ locks: withFill, receipts: [live], pending: [asked, locked] });
  assert.deepEqual(thrice.venues, { kalshi: 525 });
  assert.equal(thrice.games[GAME].openCents, 1_224);
  assert.deepEqual(thrice.holders, { alice: { openCents: 699, locks: 1 } });

  // the operator's resend bought again on another venue: a second receipt, counted on its own venue and on the game; the holder's sum does not move
  const twice = openExposure({ locks: withFill, receipts: [live, receipt("r2", ref, "2026-11-10T02:00:00.000Z", 540, { venue: "novig" })], pending: [] });
  assert.deepEqual(twice.venues, { kalshi: 525, novig: 540 });
  assert.equal(twice.games[GAME].openCents, 699 + 525 + 540);
  assert.deepEqual(twice.holders, { alice: { openCents: 699, locks: 1 } });
  assert.equal(twice.realOpenLocks, 1);
});

test("the pending trail: an attempt in flight holds what the gate set aside; a part fill and a failed lock write hold their cost; an unconfirmed order holds the most it could have cost; clearing frees it", () => {
  const terms = { contracts: 20, tier: "balanced", floorCents: 30, capCents: 68, creditCents: 99 };
  const order = { venue: "kalshi" as const, instrument: BOS, action: "buy" as const, unitsMilli: 12_400, limitMilli: 420, maxCostCents: 515 };
  const reserve = { game: GAME, gameCents: 699 + 532, venueCents: 532, holderCents: 699 };
  const mk = (n: number, holder: string | null, extra: object = {}): Extract<PendingRecord, { type: "pending" }> => {
    const at = `2026-11-10T01:0${n}:00.000Z`;
    const ref = holder ? `${BOS}@${holder}` : BOS;
    return { type: "pending", id: `${ref}#${at}`, at, ref, ticker: BOS, ...(holder ? { holder } : {}), terms, order, reserve, ...extra };
  };
  const end = (p: PendingRecord, outcome: "locked" | "refused" | "stray" | "unconfirmed" | "ledger_failed", fill?: { unitsMilli: number; costCents: number }): PendingRecord => ({
    type: "resolved",
    id: p.id,
    at: "2026-11-10T01:09:00.000Z",
    outcome,
    detail: outcome,
    ...(fill ? { fill: { ...fill, orderId: "ord-1", receiptId: `r-${p.id}` } } : {}),
  });

  // in flight (or the process stopped before the line that ends it): the whole reservation, holder included
  const flying = mk(1, "alice");
  let open = openExposure({ locks: [], receipts: [], pending: [flying] });
  assert.deepEqual(open.games[GAME], { game: GAME, openCents: 1_231, locks: 0, title: null, eventTimeIso: null });
  assert.deepEqual(open.venues, { kalshi: 532 });
  assert.deepEqual(open.holders, { alice: { openCents: 699, locks: 0 } });
  assert.equal(open.pendingUnresolved, 1);

  // a refusal left nothing
  open = openExposure({ locks: [], receipts: [], pending: [flying, end(flying, "refused")] });
  assert.deepEqual([open.games, open.venues, open.holders, open.pendingUnresolved, open.pendingLeftOver], [{}, {}, {}, 0, 0]);

  // a part fill: no lock stands, so no floor and nothing on the holder; the part bought rests on the venue and the game
  const part = mk(2, "alice");
  open = openExposure({ locks: [], receipts: [], pending: [part, end(part, "stray", { unitsMilli: 5_000, costCents: 210 })] });
  assert.deepEqual(open.venues, { kalshi: 210 });
  assert.equal(open.games[GAME].openCents, 210);
  assert.deepEqual(open.holders, {});
  assert.equal(open.pendingLeftOver, 1);

  // the hedge filled whole and the lock line could not be written: the same, at the fill's cost
  const failed = mk(3, null);
  open = openExposure({ locks: [], receipts: [], pending: [failed, end(failed, "ledger_failed", { unitsMilli: 12_400, costCents: 525 })] });
  assert.deepEqual(open.venues, { kalshi: 525 });
  assert.equal(open.games[GAME].openCents, 525);

  // not confirmed: it may have bought everything at the limit
  const unknown = mk(4, "bob");
  const unconfirmed = [unknown, end(unknown, "unconfirmed")];
  open = openExposure({ locks: [], receipts: [], pending: unconfirmed });
  assert.deepEqual(open.venues, { kalshi: 532 });
  assert.equal(open.games[GAME].openCents, 532);
  assert.deepEqual(open.holders, {});

  // the operator clears a line once checked on the venue: it holds nothing
  for (const lines of [[flying], [part, end(part, "stray", { unitsMilli: 5_000, costCents: 210 })], unconfirmed]) {
    const cleared = openExposure({ locks: [], receipts: [], pending: [...lines, { type: "cleared", id: lines[0].id, at: "2026-11-10T02:00:00.000Z", note: "checked on the venue" }] });
    assert.deepEqual([cleared.games, cleared.venues, cleared.holders], [{}, {}, {}]);
  }

  // a line from before the gate wrote what it held: the same sums from its terms and its order, the game from the lock ledger's league
  const { reserve: _none, ...bare } = mk(5, "alice");
  open = openExposure({ locks: ledgerOf("bob", [{ ...OPEN, ticker: BOS, holder: "bob" }]), receipts: [], pending: [bare] });
  assert.deepEqual(open.venues, { kalshi: 521 }, "every unit at the limit: 12.4 x 42c, rounded up");
  assert.equal(open.games[GAME].openCents, 699 + 521);
  assert.deepEqual(open.holders, { alice: { openCents: 699, locks: 0 } });
  // with no lock ever written on that market the league is not known: the series stands in, and the line still counts
  open = openExposure({ locks: [], receipts: [], pending: [bare] });
  assert.equal(open.games["kxnbagame:26OCT14LALBOS"].openCents, 1_220);

  // an amount held in memory for an order in flight with no pending line (the operator's resend)
  const hold: ExposureAdd = { game: GAME, venue: "novig", holder: "alice", gameCents: 540, venueCents: 540, holderCents: 0 };
  open = openExposure({ locks: [], receipts: [], pending: [], holds: [hold] });
  assert.deepEqual(open.venues, { novig: 540 });
  assert.equal(open.games[GAME].openCents, 540);
  assert.deepEqual(open.holders, {}, "a hold that adds nothing to the holder lists no holder");
});

test("the trail still replays: a cap refusal is a line of its own, counted apart; old lines read as before", () => {
  const path = join(mkdtempSync(join(tmpdir(), "exposure-trail-")), "lock-pending.jsonl");
  const terms = { contracts: 20, tier: "balanced", floorCents: 30, capCents: 68, creditCents: 99 };
  const order = { venue: "kalshi" as const, instrument: BOS, action: "buy" as const, unitsMilli: 12_400, limitMilli: 420, maxCostCents: 515 };
  const a: PendingRecord = { type: "pending", id: "a", at: "2026-11-10T01:00:00.000Z", ref: BOS, ticker: BOS, terms, order };
  const refusal: PendingRecord = {
    type: "cap_refused",
    id: "c",
    at: "2026-11-10T01:02:00.000Z",
    ref: `${BOS}@alice`,
    ticker: BOS,
    holder: "alice",
    source: "lock",
    terms,
    order,
    caps: [{ cap: "game", key: GAME, openCents: 4_000, addCents: 1_231, capCents: 5_000, overByCents: 231 }],
    detail: "per-game cap",
  };
  for (const l of [a, { type: "resolved", id: "a", at: "2026-11-10T01:00:01.000Z", outcome: "refused", detail: "nothing filled" } as PendingRecord, refusal]) appendPending(path, l);
  const lines = loadPending(path);
  assert.equal(lines.length, 3);
  const s = summarizePending(lines);
  assert.deepEqual(s.counts, { locked: 0, refused: 1, stray: 0, unconfirmed: 0, ledger_failed: 0 }, "a cap refusal sent no order and is not one of the order's endings");
  assert.deepEqual(s.unresolved, []);
  assert.deepEqual(s.strays, []);
  assert.deepEqual(capRefusals(lines), { count: 1, last: refusal });
  assert.deepEqual(capRefusals([a]), { count: 0, last: null });
  // a refusal holds nothing against the caps
  assert.deepEqual(openExposure({ locks: [], receipts: [], pending: lines }).venues, {});
});

// ---------------------------------------------------------------------------
// the check
// ---------------------------------------------------------------------------

test("the check: each cap passes at exactly the cap and refuses the first cent over, naming the cap and the amount; `none` never refuses", () => {
  const locks = [
    ...ledgerOf("alice", [{ ...OPEN, holder: "alice", hedgeFill: fillOf("r1", 525) }]),
    ...ledgerOf("bob", [{ ...OPEN, ticker: NYK, holder: "bob", hedgeFill: fillOf("r2", 525, "novig") }]),
  ];
  const open = openExposure({ locks, receipts: [], pending: [] });
  // open: game 1224 on LAL-BOS, 1224 on NYK-MIA; kalshi 525, novig 525; alice 699, bob 699
  const add: ExposureAdd = { game: GAME, venue: "kalshi", holder: "alice", gameCents: 1_231, venueCents: 532, holderCents: 699 };
  const roomy = caps({ gameCents: 100_000, venueCents: 100_000, holderCents: 100_000 });

  assert.deepEqual(checkExposure(open, add, roomy), []);

  // per game
  assert.deepEqual(checkExposure(open, add, { ...roomy, gameCents: 1_224 + 1_231 }), [], "exactly at the cap: passes");
  assert.deepEqual(checkExposure(open, add, { ...roomy, gameCents: 1_224 + 1_231 - 1 }), [{ cap: "game", key: GAME, openCents: 1_224, addCents: 1_231, capCents: 2_454, overByCents: 1 }], "one cent over: refused");
  // the same lock on a game with nothing open is measured against that game only
  assert.deepEqual(checkExposure(open, { ...add, game: "nba:26OCT16DENPHX" }, { ...roomy, gameCents: 1_231 }), []);

  // per venue
  assert.deepEqual(checkExposure(open, add, { ...roomy, venueCents: 525 + 532 }), []);
  assert.deepEqual(checkExposure(open, add, { ...roomy, venueCents: 525 + 532 - 1 }), [{ cap: "venue", key: "kalshi", openCents: 525, addCents: 532, capCents: 1_056, overByCents: 1 }]);
  // a venue's own cap is the one that applies to it; the other venue's lower cap does not touch this lock
  assert.deepEqual(checkExposure(open, add, { ...roomy, venueOverrides: { novig: 0 } }), []);
  assert.equal(checkExposure(open, { ...add, venue: "novig" }, { ...roomy, venueOverrides: { novig: 1_000 } })[0].overByCents, 525 + 532 - 1_000);
  assert.deepEqual(checkExposure(open, add, { ...roomy, venueCents: 0, venueOverrides: { kalshi: 1_057 } }), [], "its own cap, not the venue-wide one");

  // per holder
  assert.deepEqual(checkExposure(open, add, { ...roomy, holderCents: 699 + 699 }), []);
  assert.deepEqual(checkExposure(open, add, { ...roomy, holderCents: 699 + 699 - 1 }), [{ cap: "holder", key: "alice", openCents: 699, addCents: 699, capCents: 1_397, overByCents: 1 }]);
  assert.deepEqual(checkExposure(open, { ...add, holder: "carol" }, { ...roomy, holderCents: 699 }), [], "another holder has their own room");

  // every cap passed is named, in the order game, venue, holder
  const all = checkExposure(open, add, caps({ gameCents: 2_000, venueCents: 1_000, holderCents: 1_000 }));
  assert.deepEqual(all.map((r) => [r.cap, r.overByCents]), [["game", 455], ["venue", 57], ["holder", 398]]);

  // zero is a cap: nothing new; `none` is no cap
  assert.equal(checkExposure(open, add, caps({ gameCents: 0, venueCents: 0, holderCents: 0 })).length, 3);
  assert.deepEqual(checkExposure(open, add, caps({ gameCents: null, venueCents: null, holderCents: null })), []);
  assert.deepEqual(checkExposure(open, add, caps({ gameCents: null, venueCents: null, venueOverrides: { kalshi: 1_000 }, holderCents: null })).map((r) => r.cap), ["venue"], "a venue capped on its own under a venue-wide none");

  // a cap lowered under what is already open refuses new money and nothing else: a part that adds nothing is not refused
  assert.deepEqual(checkExposure(open, { ...add, holderCents: 0 }, { ...roomy, holderCents: 100 }), []);
});

test("the words: the operator's line names the cap, the venue and the sums; the holder's names the limit and the amount and never the venue", () => {
  const game = { cap: "game" as const, key: GAME, openCents: 4_000, addCents: 1_231, capCents: 5_000, overByCents: 231 };
  const venue = { cap: "venue" as const, key: "novig", openCents: 2_400, addCents: 532, capCents: 2_500, overByCents: 432 };
  const holder = { cap: "holder" as const, key: "alice", openCents: 4_500, addCents: 699, capCents: 5_000, overByCents: 199 };
  assert.equal(capRefusalDetail(game), "per-game cap on nba:26OCT14LALBOS: $40.00 open now plus $12.31 for this one is $52.31, over the cap of $50.00 by $2.31");
  assert.equal(capRefusalDetail(venue), "per-venue cap on Novig: $24.00 open now plus $5.32 for this one is $29.32, over the cap of $25.00 by $4.32");
  assert.equal(capRefusalDetail(holder), "per-holder cap for holder alice: $45.00 open now plus $6.99 for this one is $51.99, over the cap of $50.00 by $1.99");
  assert.match(capRefusalDetail({ ...holder, key: SHARED_HOLDER }), /^per-holder cap for the shared key: /);
  assert.equal(capRefusalDetails([game, venue]).split("; ").length, 2);

  assert.deepEqual(capRefusalWords([game]), { code: "exposure_cap", message: "This lock would go over what can be open at once: $2.31 over the limit for this game. Nothing was locked. A smaller size may fit." });
  assert.equal(capRefusalWords([holder]).message, "This lock would go over what can be open at once: $1.99 over your own limit of $50.00. Nothing was locked. A smaller size may fit.");
  assert.equal(capRefusalWords([game, venue, holder]).message, "This lock would go over what can be open at once: $2.31 over the limit for this game; $4.32 over the limit for where the other side is bought; $1.99 over your own limit of $50.00. Nothing was locked. A smaller size may fit.");
  // already at or over a cap: no size fits, so none is suggested
  assert.equal(capRefusalWords([{ ...game, openCents: 5_000, overByCents: 1_231 }]).message, "This lock would go over what can be open at once: $12.31 over the limit for this game. Nothing was locked.");

  for (const rows of [[game], [venue], [holder], [game, venue, holder]]) {
    const { message } = capRefusalWords(rows);
    assert.ok(!/kalshi|novig|polymarket|prophetx|hedge|wallet|guarantee|protect|[\u2013\u2014]/i.test(message), message);
    assert.match(message, /Nothing was locked\./);
    assert.ok(!/[\u2013\u2014]/.test(capRefusalDetails(rows)));
  }
});

// ---------------------------------------------------------------------------
// the operator's view
// ---------------------------------------------------------------------------

test("the view: open now, the cap and the room left, per game (the largest few), per venue and per holder; a cap set to none says so", () => {
  const games = ["26OCT14LALBOS", "26OCT15NYKMIA", "26OCT16DENPHX", "26OCT17GSWSAC", "26OCT18DALHOU", "26OCT19MILCHI", "26OCT20ATLORL"];
  const lines = games.map((g, i) => ({ ...OPEN, ticker: `KXNBAGAME-${g}-AAA`, eventTitle: `game ${i}`, contracts: 5 + i, hedgeFill: fillOf(`r${i}`, 100 + i, i === 3 ? "novig" : "kalshi") }));
  const locks = [...ledgerOf("alice", lines.slice(0, 4).map((l) => ({ ...l, holder: "alice" }))), ...ledgerOf(null, lines.slice(4))];
  const open = openExposure({ locks, receipts: [], pending: [] });
  const view = exposureView(open, caps({ gameCents: 450, venueOverrides: { novig: 2_500 } }), { venues: ["kalshi"], holders: ["alice", "bob"] });

  assert.deepEqual(view.caps, { perGameCents: 450, perVenueCents: { default: 10_000, novig: 2_500 }, perHolderCents: 5_000 });
  assert.equal(view.games.open, 7);
  assert.equal(view.games.top.length, 5, "compact: the largest five");
  const sums = lines.map((l) => 30 * l.contracts + 99 + (l.hedgeFill?.costCents ?? 0));
  assert.deepEqual(view.games.top.map((g) => g.openCents), [...sums].sort((a, b) => b - a).slice(0, 5));
  const top = view.games.top[0];
  assert.deepEqual(top, { game: "nba:26OCT20ATLORL", title: "game 6", locks: 1, openCents: 30 * 11 + 99 + 106, capCents: 450, roomCents: 0 }, "over the cap: no room, never a negative");
  const last = view.games.top[4];
  assert.deepEqual([last.game, last.openCents, last.roomCents], ["nba:26OCT16DENPHX", 411, 39]);

  assert.deepEqual(view.venues, [
    { venue: "kalshi", openCents: 100 + 101 + 102 + 104 + 105 + 106, capCents: 10_000, roomCents: 10_000 - 618 },
    { venue: "novig", openCents: 103, capCents: 2_500, roomCents: 2_397 },
  ]);
  const alice = 4 * 99 + 30 * (5 + 6 + 7 + 8);
  const shared = 3 * 99 + 30 * (9 + 10 + 11);
  assert.deepEqual(view.holders, [
    { holder: SHARED_HOLDER, locks: 3, openCents: shared, capCents: 5_000, roomCents: 5_000 - shared },
    { holder: "alice", locks: 4, openCents: alice, capCents: 5_000, roomCents: 5_000 - alice },
    { holder: "bob", locks: 0, openCents: 0, capCents: 5_000, roomCents: 5_000 },
  ], "the most open first; a holder with a key and nothing open is listed with all their room");
  assert.deepEqual(view.counted, { realOpenLocks: 7, simulatedOpenLocksNotCounted: 0, pendingUnresolved: 0, pendingLeftOver: 0 });

  // no cap is said in words, in the cap and in the room, and the notes ride along
  const off = exposureView(open, caps({ gameCents: null, venueCents: null, holderCents: null, venueOverrides: { novig: 2_500 }, notes: ["a note"] }), { venues: ["kalshi"] });
  assert.equal(NO_CAP, "no cap");
  assert.deepEqual(off.caps, { perGameCents: "no cap", perVenueCents: { default: "no cap", novig: 2_500 }, perHolderCents: "no cap", notes: ["a note"] });
  assert.deepEqual([off.games.top[0].capCents, off.games.top[0].roomCents], ["no cap", "no cap"]);
  assert.deepEqual(off.venues.map((v) => [v.venue, v.capCents, v.roomCents]), [["kalshi", "no cap", "no cap"], ["novig", 2_500, 2_397]]);
  assert.deepEqual([off.holders[0].capCents, off.holders[0].roomCents], ["no cap", "no cap"]);

  // nothing open: the venues with a live client and the holders with a key are still listed, with all their room
  const empty = exposureView(openExposure({ locks: [], receipts: [], pending: [] }), caps(), { venues: ["kalshi"], holders: ["alice"] });
  assert.deepEqual(empty.games, { open: 0, top: [] });
  assert.deepEqual(empty.venues, [{ venue: "kalshi", openCents: 0, capCents: 10_000, roomCents: 10_000 }]);
  assert.deepEqual(empty.holders, [{ holder: "alice", locks: 0, openCents: 0, capCents: 5_000, roomCents: 5_000 }]);
});
