/**
 * Plain collar + cap release (the C decision): the pure pieces.
 *
 *   - cyclePayable in plain mode: gains above the cap are handed back at expiry, netted against
 *     the credit; a release removes the cap and its cost is owed; early close carries the
 *     collar's mark-to-market; a negative total is a balance owed
 *   - knockout-mode records (legacy, no capMode) settle exactly as before
 *   - releaseQuoteFromBook / closeValueFromBooks price from the live ask/bid, never invent one
 *   - buyBackLeg: one IOC buy of the sold leg, reduce-only, the floor leg untouched; partials reported
 *   - owed balance, touch and release bookkeeping
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buyBackLeg,
  capExplainer,
  closeValueFromBooks,
  legFeeUsdc,
  listedInstId,
  releaseQuoteFromBook,
  wrapLegs
} from "../src/singleSide/twoSided/creditCollar/capRelease";
import {
  capExcessUsdc,
  cappedContracts,
  concludeAtExpiry,
  concludeWrapEarly,
  cyclePayable,
  knockoutWrap,
  newDemoWrap,
  noteCapTouch,
  owedBalanceUsdc,
  owedRemainingUsdc,
  assessOwedCarry,
  netOwedAgainstPayout,
  summarizeOwedRecovery,
  parseOwedCarryCycles,
  DEFAULT_OWED_CARRY_CYCLES,
  parseCapMode,
  releaseCap,
  wrapCapActive,
  wrapCapMode,
  type DemoWrapRecord
} from "../src/singleSide/twoSided/creditCollar/demoWrap";
import { accrueWrapPayout } from "../src/singleSide/twoSided/creditCollar/settlement/payoutLedger";
import type { LiveExecClient } from "../src/singleSide/twoSided/creditCollar/execution/okxLiveCollarExecutor";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const ACCT = "0x00000000000000000000000000000000000abc01";

/** An ACTIVE long plain-mode wrap mid-cycle: spot 64.5k, floor 60.6k put, cap 65.5k call, 3 lots, $3.12 credit. */
const plainWrap = (over: Partial<DemoWrapRecord> = {}): DemoWrapRecord => ({
  ...newDemoWrap("wrap-plain", NOW - DAY / 2, "hyperliquid", ACCT, { coin: "BTC", side: "long", szBase: 0.03, entryPx: 64_000, markPx: 64_500, notionalUsdc: 1_935 }),
  capMode: "plain",
  quote: { spot: 64_500, putStrike: 60_600, callStrike: 65_500, floorPct: 0.06, capPct: 0.015, creditUsdc: 3.12, quotedCreditUsdc: 3.12, floorStrike: 60_600, capStrike: 65_500, floorPctUsed: 0.06, tenorDays: 1 },
  hedge: { venue: "okx_model", mode: "paper", netCreditUsdc: 3.9, venueFeeUsdc: 0.3, contracts: 3, sizeNote: null },
  legs: [
    { role: "sell_call_cap", instId: "BTC-USD-260925-65500-C", orderId: null, premiumUsdc: 9, real: false },
    { role: "buy_put_floor", instId: "BTC-USD-260925-60600-P", orderId: null, premiumUsdc: -5.1, real: false }
  ],
  vesting: { fullCreditUsdc: 3.12, startMs: NOW - DAY / 2, endMs: NOW + DAY / 2 },
  status: "active",
  ...over
});

test("parseCapMode / wrapCapMode: plain is the default; legacy records without a mode are knockout", () => {
  assert.equal(parseCapMode(undefined), "plain");
  assert.equal(parseCapMode(""), "plain");
  assert.equal(parseCapMode("knockout"), "knockout");
  assert.equal(parseCapMode("KNOCKOUT"), "plain", "strict: only the exact word");
  assert.equal(wrapCapMode({}), "knockout");
  assert.equal(wrapCapMode({ capMode: "plain" }), "plain");
  const hedge = { venue: "okx_model", mode: "paper" as const, netCreditUsdc: 1, venueFeeUsdc: 0, contracts: 3, sizeNote: null };
  assert.equal(wrapCapActive({ capMode: "plain", release: null, hedge }), true);
  assert.equal(wrapCapActive({ capMode: "plain", hedge, release: { atMs: 1, markPx: 1, instId: null, contracts: 3, costUsdc: 1, source: "model" } }), false);
  assert.equal(wrapCapActive({ capMode: "plain", hedge, release: { atMs: 1, markPx: 1, instId: null, contracts: 1, costUsdc: 1, source: "model" } }), true, "a partial release leaves the rest capped");
  assert.equal(cappedContracts({ capMode: "plain", hedge, release: { atMs: 1, markPx: 1, instId: null, contracts: 1, costUsdc: 1, source: "model" } }), 2);
  assert.equal(wrapCapActive({ hedge }), true, "knockout-mode caps always bind (they end the cycle instead)");
});

test("capExcessUsdc: gains above the cap on the covered size, side-aware, zero inside", () => {
  assert.equal(capExcessUsdc("long", 65_500, 67_000, 0.03), 45);
  assert.equal(capExcessUsdc("long", 65_500, 65_000, 0.03), 0);
  assert.equal(capExcessUsdc("short", 63_500, 62_000, 0.03), 45);
  assert.equal(capExcessUsdc("short", 63_500, 64_000, 0.03), 0);
  assert.equal(capExcessUsdc("long", 65_500, 67_000, 0), 0);
});

test("cyclePayable (plain): expiry inside both wings ⟹ the full credit, nothing owed", () => {
  const r = plainWrap();
  concludeAtExpiry(r, NOW + DAY / 2 + 1);
  const p = cyclePayable(r, 64_800)!;
  assert.equal(p.kind, "expiry");
  assert.deepEqual([p.creditUsdc, p.floorPayoutUsdc, p.capOwedUsdc, p.releaseCostUsdc, p.totalUsdc], [3.12, 0, 0, 0, 3.12]);
});

test("cyclePayable (plain): expiry through the floor ⟹ credit + protective payout; through the cap ⟹ gains above it handed back", () => {
  const floor = plainWrap();
  concludeAtExpiry(floor, NOW + DAY / 2 + 1);
  const pf = cyclePayable(floor, 58_000)!; // $2,600 under the floor × 0.03
  assert.equal(pf.floorPayoutUsdc, 78);
  assert.equal(pf.totalUsdc, 81.12);

  const cap = plainWrap();
  concludeAtExpiry(cap, NOW + DAY / 2 + 1);
  const pc = cyclePayable(cap, 67_000)!; // $1,500 over the cap × 0.03
  assert.equal(pc.capOwedUsdc, 45);
  assert.equal(pc.creditUsdc, 3.12);
  assert.equal(pc.totalUsdc, -41.88, "the credit nets against what is handed back; the rest is owed");
});

test("cyclePayable (plain): a release removes the cap — nothing handed back at expiry, the release cost is owed", () => {
  const r = plainWrap();
  assert.ok(releaseCap(r, { atMs: NOW, markPx: 65_400, instId: "BTC-USD-260925-65500-C", contracts: 3, costUsdc: 21.5, source: "okx_book" }));
  assert.equal(r.stages.at(-1)!.stage, "cap_released");
  assert.ok(!releaseCap(r, { atMs: NOW + 1, markPx: 65_400, instId: null, contracts: 3, costUsdc: 1, source: "model" }), "a fully released cap refuses another release");
  concludeAtExpiry(r, NOW + DAY / 2 + 1);
  const p = cyclePayable(r, 67_000)!;
  assert.equal(p.capOwedUsdc, 0, "released: the gains above the old cap are the holder's");
  assert.equal(p.releaseCostUsdc, 21.5);
  assert.equal(p.totalUsdc, -18.38);

  // A partial fill: 1 of 3 contracts released; the other 2 stay capped and are topped up later.
  const part = plainWrap();
  assert.ok(releaseCap(part, { atMs: NOW, markPx: 65_400, instId: "X", contracts: 1, costUsdc: 7, source: "okx_fill", note: "1/3 filled" }));
  assert.equal(cappedContracts(part), 2);
  assert.ok(releaseCap(part, { atMs: NOW + 5, markPx: 65_450, instId: "X", contracts: 5, costUsdc: 14.2, source: "okx_fill" }), "top-up, clipped to what is still held");
  assert.deepEqual([part.release!.contracts, part.release!.costUsdc, cappedContracts(part)], [3, 21.2, 0]);
  const half = plainWrap();
  releaseCap(half, { atMs: NOW, markPx: 65_400, instId: "X", contracts: 1, costUsdc: 7, source: "okx_fill" });
  concludeAtExpiry(half, NOW + DAY / 2 + 1);
  const ph = cyclePayable(half, 67_000)!;
  assert.equal(ph.capOwedUsdc, 30, "gains above the cap on the 2 contracts still capped");
  assert.equal(ph.releaseCostUsdc, 7);
});

test("cyclePayable (plain): early close carries the collar's mark-to-market (+ paid / − owed) with the vested credit", () => {
  const owed = plainWrap();
  owed.closeValue = { atMs: NOW - DAY / 4, valueUsdc: -12.4, source: "okx_book" };
  concludeWrapEarly(owed, NOW - DAY / 4); // quarter of the tenor elapsed
  const po = cyclePayable(owed, null)!;
  assert.equal(po.kind, "early_close");
  assert.equal(po.creditUsdc, 0.78);
  assert.equal(po.closeValueUsdc, -12.4);
  assert.equal(po.totalUsdc, -11.62);

  const paid = plainWrap();
  paid.closeValue = { atMs: NOW - DAY / 4, valueUsdc: 4, source: "okx_fill" };
  concludeWrapEarly(paid, NOW - DAY / 4);
  assert.equal(cyclePayable(paid, null)!.totalUsdc, 4.78);

  const unvalued = plainWrap();
  unvalued.closeValue = { atMs: NOW - DAY / 4, valueUsdc: null, source: "unvalued" };
  concludeWrapEarly(unvalued, NOW - DAY / 4);
  assert.equal(cyclePayable(unvalued, null)!.totalUsdc, 0.78, "an unvalued unwind adds nothing (never invents a charge)");
});

test("cyclePayable (knockout, legacy): unchanged — vested-to-touch, never owes", () => {
  const r = plainWrap({ capMode: undefined });
  knockoutWrap(r, NOW, 65_510);
  const p = cyclePayable(r, 65_510)!;
  assert.equal(p.kind, "knockout");
  assert.deepEqual([p.creditUsdc, p.capOwedUsdc, p.releaseCostUsdc, p.totalUsdc], [1.56, 0, 0, 1.56]);
  const e = plainWrap({ capMode: undefined });
  concludeAtExpiry(e, NOW + DAY / 2 + 1);
  assert.equal(cyclePayable(e, 67_000)!.capOwedUsdc, 0, "knockout mode never hands gains back at the print");
});

test("owed balance + payout ledger: a negative total is never a payout; the owed sum is per account and clears when settled", () => {
  const r = plainWrap();
  concludeAtExpiry(r, NOW + DAY / 2 + 1);
  const p = cyclePayable(r, 67_000)!;
  const entries: Parameters<typeof accrueWrapPayout>[0] = [];
  const res = accrueWrapPayout(entries, r, p, NOW);
  assert.ok(!res.ok && /nothing to pay/.test(res.reason), "the ledger refuses a negative amount — the caller books it as owed");
  r.owed = { amountUsdc: -p.totalUsdc, status: "owed", createdAtMs: NOW, settledAtMs: null, ref: null };
  const other = plainWrap({ id: "wrap-2", account: "0x00000000000000000000000000000000000abc02" });
  assert.equal(owedBalanceUsdc([r, other], ACCT), 41.88);
  assert.equal(owedBalanceUsdc([r, other], ACCT.toUpperCase()), 41.88, "case-insensitive");
  assert.equal(owedBalanceUsdc([r, other], other.account), 0);
  r.owed.status = "settled";
  assert.equal(owedBalanceUsdc([r], ACCT), 0);

  const pos = plainWrap({ id: "wrap-3" });
  concludeAtExpiry(pos, NOW + DAY / 2 + 1);
  const ok = accrueWrapPayout(entries, pos, cyclePayable(pos, 66_500)!, NOW); // $1,000 over the cap × 0.03 = $30 owed vs $3.12 credit → owed, not paid
  assert.ok(!ok.ok);
  const inside = accrueWrapPayout(entries, pos, cyclePayable(pos, 64_900)!, NOW);
  assert.ok(inside.ok && inside.created && inside.entry.amountUsdc === 3.12);
});

test("carry-forward: EP_OWED_CARRY_CYCLES parses to a non-negative number of cycles, default 3", () => {
  assert.equal(DEFAULT_OWED_CARRY_CYCLES, 3);
  assert.equal(parseOwedCarryCycles(undefined), 3);
  assert.equal(parseOwedCarryCycles(""), 3);
  assert.equal(parseOwedCarryCycles("abc"), 3);
  assert.equal(parseOwedCarryCycles("-1"), 3);
  assert.equal(parseOwedCarryCycles("0"), 0, "0 = any balance gates (the pre-October rule)");
  assert.equal(parseOwedCarryCycles("1.5"), 1.5);
});

test("carry-forward: a balance rides along while it is at most N cycles of the new wrap's credit; 0 restores gate-on-any-balance", () => {
  assert.deepEqual(assessOwedCarry(0, 3.12, 3), { ok: true, owedUsdc: 0, capUsdc: 9.36 });
  assert.deepEqual(assessOwedCarry(9.36, 3.12, 3), { ok: true, owedUsdc: 9.36, capUsdc: 9.36 }, "exactly the cap still rides");
  const over = assessOwedCarry(9.37, 3.12, 3);
  assert.ok(!over.ok && over.capUsdc === 9.36 && /\$9\.37 .*more than we carry \(\$9\.36, 3 cycles of this credit\)/.test(over.reason));
  const one = assessOwedCarry(5, 3.12, 1);
  assert.ok(!one.ok && /1 cycle of this credit/.test(one.reason), "singular");
  const none = assessOwedCarry(0.01, 3.12, 0);
  assert.ok(!none.ok && none.capUsdc === 0 && /from a settled cycle is still owed .* settle it before protection can restart/.test(none.reason), "0 cycles: the old sentence, any balance refuses");
  assert.ok(assessOwedCarry(-5, 3.12, 0).ok, "a negative balance is no balance");
  assert.ok(!assessOwedCarry(1, 0, 3).ok, "no credit quoted → nothing to carry against");
});

test("carry-forward: later cycles' payouts pay the account's balances down oldest first; the remainder reaches the holder; idempotent per concluding wrap", () => {
  const older = plainWrap({ id: "wrap-older" });
  older.owed = { amountUsdc: 5, status: "owed", createdAtMs: NOW - 2 * DAY, settledAtMs: null, ref: null };
  const newer = plainWrap({ id: "wrap-newer" });
  newer.owed = { amountUsdc: 4, status: "owed", createdAtMs: NOW - DAY, settledAtMs: null, ref: "ops note" };
  const stranger = plainWrap({ id: "wrap-x", account: "0x00000000000000000000000000000000000abc02" });
  stranger.owed = { amountUsdc: 100, status: "owed", createdAtMs: NOW - 3 * DAY, settledAtMs: null, ref: null };
  const records = [newer, stranger, older];
  assert.equal(owedBalanceUsdc(records, ACCT), 9);

  // cycle A pays $3.12: all of it goes to the OLDEST balance, nothing reaches the holder
  const a = netOwedAgainstPayout(records, ACCT, 3.12, NOW, "wrap-a");
  assert.deepEqual(a, { paidToHolderUsdc: 0, appliedUsdc: 3.12, applied: [{ wrapId: "wrap-older", amountUsdc: 3.12, remainingUsdc: 1.88 }] });
  assert.equal(owedRemainingUsdc(older.owed), 1.88);
  assert.equal(older.owed.paidDownUsdc, 3.12);
  assert.deepEqual(older.owed.history, [{ atMs: NOW, amountUsdc: 3.12, fromWrapId: "wrap-a" }]);
  assert.equal(older.owed.status, "owed");
  assert.equal(owedBalanceUsdc(records, ACCT), 5.88, "the account balance is what is still outstanding");
  assert.equal(owedBalanceUsdc(records, stranger.account), 100, "another account's balance is untouched");

  // the same conclusion again applies nothing twice
  const again = netOwedAgainstPayout(records, ACCT, 3.12, NOW + 1, "wrap-a");
  assert.deepEqual(again, { paidToHolderUsdc: 3.12, appliedUsdc: 0, applied: [] });
  assert.equal(owedBalanceUsdc(records, ACCT), 5.88);

  // cycle B pays $4: clears the older ($1.88, settled, ref appended), then $2.12 on the newer; nothing left over
  const b = netOwedAgainstPayout(records, ACCT, 4, NOW + DAY, "wrap-b");
  assert.deepEqual(b, {
    paidToHolderUsdc: 0,
    appliedUsdc: 4,
    applied: [
      { wrapId: "wrap-older", amountUsdc: 1.88, remainingUsdc: 0 },
      { wrapId: "wrap-newer", amountUsdc: 2.12, remainingUsdc: 1.88 }
    ]
  });
  assert.equal(older.owed.status, "settled");
  assert.equal(older.owed.settledAtMs, NOW + DAY);
  assert.equal(older.owed.ref, "netted from cycle credits (last: wrap-b)");
  assert.equal(older.owed.amountUsdc, 5, "the booked amount is history, never rewritten");
  assert.equal(newer.owed.ref, "ops note", "an open balance keeps its note");
  assert.equal(owedBalanceUsdc(records, ACCT), 1.88);

  // cycle C pays $10: clears the rest, $8.12 reaches the holder
  const c = netOwedAgainstPayout(records, ACCT, 10, NOW + 2 * DAY, "wrap-c");
  assert.deepEqual([c.paidToHolderUsdc, c.appliedUsdc], [8.12, 1.88]);
  assert.equal(newer.owed.status, "settled");
  assert.equal(newer.owed.ref, "ops note · netted from cycle credits (last: wrap-c)");
  assert.equal(owedBalanceUsdc(records, ACCT), 0);

  // nothing outstanding: the whole payout reaches the holder; a non-positive total applies nothing
  assert.deepEqual(netOwedAgainstPayout(records, ACCT, 2, NOW + 3 * DAY, "wrap-d"), { paidToHolderUsdc: 2, appliedUsdc: 0, applied: [] });
  assert.deepEqual(netOwedAgainstPayout(records, stranger.account, -3, NOW, "wrap-e"), { paidToHolderUsdc: 0, appliedUsdc: 0, applied: [] });
  assert.equal(stranger.owed.paidDownUsdc, undefined);

  // a concluding wrap never pays down its own balance
  const self = plainWrap({ id: "wrap-self" });
  self.owed = { amountUsdc: 3, status: "owed", createdAtMs: NOW, settledAtMs: null, ref: null };
  assert.equal(netOwedAgainstPayout([self], ACCT, 3, NOW, "wrap-self").appliedUsdc, 0);
  // records from before 2026-10-08 (no paidDownUsdc) read as fully outstanding
  assert.equal(owedRemainingUsdc({ amountUsdc: 7.5, status: "owed", createdAtMs: NOW, settledAtMs: null, ref: null }), 7.5);
  assert.equal(owedRemainingUsdc({ amountUsdc: 7.5, status: "written_off", createdAtMs: NOW, settledAtMs: null, ref: null }), 0);
  assert.equal(owedRemainingUsdc(null), 0);
});

test("carry-forward: the recovery stat says how much of what was recorded came back, by dollars and by account", () => {
  assert.deepEqual(summarizeOwedRecovery([plainWrap()]), { booked: 0, bookedUsdc: 0, recoveredUsdc: 0, settledOtherwiseUsdc: 0, writtenOffUsdc: 0, outstandingUsdc: 0, recoveryPct: null, accountsWithBalance: 0, accountsReturned: 0, accountsOutstanding: 0 });
  const other = "0x00000000000000000000000000000000000abc02";
  const third = "0x00000000000000000000000000000000000abc03";
  const recs = [
    // booked $5, $3.12 came back through a later credit, $1.88 still owed
    { ...plainWrap({ id: "w1" }), owed: { amountUsdc: 5, status: "owed" as const, createdAtMs: NOW, settledAtMs: null, ref: null, paidDownUsdc: 3.12 } },
    // booked $4, fully paid down and settled by carry-forward
    { ...plainWrap({ id: "w2" }), owed: { amountUsdc: 4, status: "settled" as const, createdAtMs: NOW, settledAtMs: NOW + DAY, ref: "netted from cycle credits (last: w9)", paidDownUsdc: 4 } },
    // another account: booked $10, settled by a venue debit, nothing through credits
    { ...plainWrap({ id: "w3", account: other }), owed: { amountUsdc: 10, status: "settled" as const, createdAtMs: NOW, settledAtMs: NOW + DAY, ref: "venue debit 0xabc" } },
    // a third: booked $2, never came back, written off
    { ...plainWrap({ id: "w4", account: third }), owed: { amountUsdc: 2, status: "written_off" as const, createdAtMs: NOW, settledAtMs: NOW + DAY, ref: null } },
    // the third again, uppercased on the wire: $1 outstanding, same account
    { ...plainWrap({ id: "w5", account: third.toUpperCase() }), owed: { amountUsdc: 1, status: "owed" as const, createdAtMs: NOW, settledAtMs: null, ref: null } }
  ];
  const r = summarizeOwedRecovery(recs);
  assert.deepEqual(r, {
    booked: 5,
    bookedUsdc: 22,
    recoveredUsdc: 7.12,
    settledOtherwiseUsdc: 10,
    writtenOffUsdc: 2,
    outstandingUsdc: 2.88,
    recoveryPct: 32.4,
    accountsWithBalance: 3,
    accountsReturned: 1,
    accountsOutstanding: 2
  });
  assert.equal(r.recoveredUsdc + r.settledOtherwiseUsdc + r.writtenOffUsdc + r.outstandingUsdc, r.bookedUsdc, "every booked dollar is in exactly one bucket");
});

test("carry-forward: the payout ledger books the cycle net of what paid balances down, and says so; a fully applied cycle books nothing", () => {
  const pos = plainWrap({ id: "wrap-net" });
  concludeAtExpiry(pos, NOW + DAY / 2 + 1);
  const p = cyclePayable(pos, 64_900)!; // $3.12 credit, inside the band
  const entries: Parameters<typeof accrueWrapPayout>[0] = [];
  const partial = accrueWrapPayout(entries, pos, { ...p, owedAppliedUsdc: 1.12 }, NOW);
  assert.ok(partial.ok && partial.created);
  assert.equal(partial.entry.amountUsdc, 2);
  assert.ok(partial.entry.notes.includes("net of $1.12 carried from earlier cycles (paid down first)"));
  const all = accrueWrapPayout([], plainWrap({ id: "wrap-all", status: "expired" }), { ...p, owedAppliedUsdc: 3.12 }, NOW);
  assert.ok(!all.ok && /the whole \$3\.12 paid down earlier cycles' balances; nothing left to pay/.test(all.reason));
  const none = accrueWrapPayout([], plainWrap({ id: "wrap-none", status: "expired" }), { ...p, owedAppliedUsdc: 0 }, NOW);
  assert.ok(none.ok && none.entry.amountUsdc === 3.12 && !none.entry.notes.some((n) => /carried/.test(n)), "no carry, no note");
});

test("noteCapTouch: the first touch is stamped and staged once; later touches only count", () => {
  const r = plainWrap();
  assert.equal(noteCapTouch(r, NOW, 65_520), true);
  assert.equal(r.stages.at(-1)!.stage, "cap_touched");
  assert.equal(noteCapTouch(r, NOW + 60_000, 65_600), false);
  assert.deepEqual(r.capTouch, { firstTouchedAtMs: NOW, markPx: 65_520, touches: 2 });
  assert.equal(r.status, "active", "nothing closes");
});

test("releaseQuoteFromBook: the sold leg's ask × size × spot plus the taker fee; no ask ⟹ no price", () => {
  const q = releaseQuoteFromBook({ contracts: 3, spotUsd: 65_400, top: { bidPxBtc: 0.0098, askPxBtc: 0.0105 }, instId: "BTC-USD-260925-65500-C" });
  assert.ok(q.ok);
  if (!q.ok) return;
  assert.equal(q.premiumUsdc, 20.6); // 0.0105 × 0.03 × 65,400
  assert.equal(q.feeUsdc, +legFeeUsdc(0.03 * 65_400, 20.6).toFixed(2));
  assert.ok(q.feeUsdc > 0 && q.feeUsdc < 2);
  assert.equal(q.costUsdc, +(q.premiumUsdc + q.feeUsdc).toFixed(2));
  const none = releaseQuoteFromBook({ contracts: 3, spotUsd: 65_400, top: { bidPxBtc: 0.0098, askPxBtc: null }, instId: null });
  assert.ok(!none.ok && /no ask/.test(none.reason));
  assert.ok(!releaseQuoteFromBook({ contracts: 0, spotUsd: 65_400, top: { bidPxBtc: 1, askPxBtc: 1 }, instId: null }).ok);
});

test("closeValueFromBooks: floor sold at the bid, cap bought at the ask (if held), fees off; a held cap with no ask cannot be valued", () => {
  const held = closeValueFromBooks({ contracts: 3, spotUsd: 65_400, floorTop: { bidPxBtc: 0.001, askPxBtc: 0.0012 }, capTop: { bidPxBtc: 0.0098, askPxBtc: 0.0105 }, capHeld: true });
  assert.ok(held != null && held < 0, "near the cap the collar is a liability on the way out");
  const released = closeValueFromBooks({ contracts: 3, spotUsd: 65_400, floorTop: { bidPxBtc: 0.001, askPxBtc: 0.0012 }, capTop: null, capHeld: false });
  assert.ok(released != null && released > 0 && released < 1.962, "released: only the floor leg's bid, less its fee");
  assert.equal(closeValueFromBooks({ contracts: 3, spotUsd: 65_400, floorTop: { bidPxBtc: 0.001, askPxBtc: null }, capTop: { bidPxBtc: null, askPxBtc: null }, capHeld: true }), null);
  const noBid = closeValueFromBooks({ contracts: 3, spotUsd: 65_400, floorTop: { bidPxBtc: null, askPxBtc: 0.0012 }, capTop: null, capHeld: false });
  assert.equal(noBid, 0, "a floor leg with no bid is worth zero on the way out, never negative");
});

test("listedInstId: a paper '(model)' id maps to the OKX-listed contract; real ids pass through", () => {
  assert.equal(listedInstId("BTC-USD-25SEP26-78000-P (model)"), "BTC-USD-260925-78000-P");
  assert.equal(listedInstId("BTC-USD-02OCT26-86000-C (model)"), "BTC-USD-261002-86000-C");
  assert.equal(listedInstId("BTC-USD-260925-78000-P"), "BTC-USD-260925-78000-P", "a live leg's id is already listed");
  assert.equal(listedInstId("ETH-USD-15JAN27-3000-C (model)"), "ETH-USD-270115-3000-C");
  assert.equal(listedInstId("something else (model)"), "something else", "unknown shapes only lose the label");
  assert.equal(listedInstId(null), null);
  assert.equal(listedInstId(""), null);
  const paper = wrapLegs({
    position: { side: "short" } as DemoWrapRecord["position"],
    legs: [
      { role: "sell_put_cap", instId: "BTC-USD-25SEP26-78000-P (model)", orderId: null, premiumUsdc: 4.8, real: false },
      { role: "buy_call_floor", instId: "BTC-USD-25SEP26-86000-C (model)", orderId: null, premiumUsdc: -3.5, real: false }
    ]
  });
  assert.equal(paper.capLeg?.instId, "BTC-USD-260925-78000-P", "the release prices the listed book behind a paper leg");
  assert.equal(paper.floorLeg?.instId, "BTC-USD-260925-86000-C");
  assert.equal(paper.capLeg?.real, false, "…without dressing it as a fill");
});

test("wrapLegs / capExplainer: roles by side; plain words", () => {
  const long = wrapLegs(plainWrap());
  assert.equal(long.capLeg?.instId, "BTC-USD-260925-65500-C");
  assert.equal(long.floorLeg?.instId, "BTC-USD-260925-60600-P");
  const short = wrapLegs({ position: { side: "short" } as DemoWrapRecord["position"], legs: [{ role: "sell_put_cap", instId: "P", orderId: null, premiumUsdc: 1, real: false }, { role: "buy_call_floor", instId: "C", orderId: null, premiumUsdc: -1, real: false }] });
  assert.equal(short.capLeg?.instId, "P");
  assert.equal(short.floorLeg?.instId, "C");
  assert.match(capExplainer("long", 65_500, "this week"), /above \$65,500 this week pay for your floor/);
  assert.match(capExplainer("short", 63_500, "today"), /below \$63,500 today/);
});

const fakeClient = (script: { book?: { bid?: string; ask?: string }; mark?: string; fills: Array<{ state: "filled" | "canceled"; accFillSz?: string; avgPx?: string; fee?: string }>; reject?: boolean }) => {
  const placed: Array<{ instId: string; side: string; ordType: string; px?: string; sz: string; reduceOnly?: boolean }> = [];
  let n = 0;
  const client = {
    mode: "demo",
    placeOrder: async (o: { instId: string; side: "buy" | "sell"; ordType: string; px?: string; sz: string; reduceOnly?: boolean }) => {
      placed.push(o);
      if (script.reject) return { ok: false, code: "51000", msg: "rejected", data: [{ sMsg: "bad px" }] };
      return { ok: true, code: "0", msg: "", data: [{ ordId: `o${placed.length}` }] };
    },
    getOrder: async () => ({ ok: true, data: [script.fills[Math.min(n++, script.fills.length - 1)]] }),
    cancelOrder: async () => ({ ok: true, data: [] }),
    getBookTop: async () => ({ ok: true, data: [{ bids: script.book?.bid ? [[script.book.bid, "1"]] : [], asks: script.book?.ask ? [[script.book.ask, "1"]] : [] }] }),
    getPositions: async () => ({ ok: true, data: [] }),
    ...(script.mark ? { getMarkPrice: async () => ({ data: [{ markPx: script.mark }] }) } : {})
  } as unknown as LiveExecClient;
  return { client, placed };
};

test("buyBackLeg: one reduce-only IOC BUY at the crossed ask; a full fill prices premium + fee at spot", async () => {
  const { client, placed } = fakeClient({ book: { bid: "0.0098", ask: "0.0100" }, fills: [{ state: "filled", accFillSz: "3", avgPx: "0.0100", fee: "-0.00001" }] });
  const r = await buyBackLeg(client, { instId: "BTC-USD-260925-65500-C", contracts: 3, spotUsd: 65_400, clOrdPrefix: "t", sleep: async () => {} });
  assert.equal(placed.length, 1);
  assert.deepEqual([placed[0].side, placed[0].ordType, placed[0].reduceOnly, placed[0].sz, placed[0].px], ["buy", "ioc", true, "3", "0.0105"]);
  assert.ok(r.ok && r.filledContracts === 3 && r.avgPxBtc === 0.01);
  assert.equal(r.costUsdc, +((0.01 * 3 * 0.01 + 0.00001) * 65_400).toFixed(2));
});

test("buyBackLeg: an empty book walks to mark × 1.1; a partial fill is reported, not ok; a rejection on every rung buys nothing", async () => {
  const a = fakeClient({ book: {}, mark: "0.0100", fills: [{ state: "canceled", accFillSz: "1", avgPx: "0.0110", fee: "-0.000003" }] });
  const r = await buyBackLeg(a.client, { instId: "X", contracts: 3, spotUsd: 65_400, sleep: async () => {} });
  assert.equal(a.placed[0].px, "0.011");
  assert.ok(!r.ok && r.filledContracts === 1 && r.costUsdc != null && r.costUsdc > 0);
  assert.match(r.notes.join(" "), /canceled at 1\/3/);

  const b = fakeClient({ book: { ask: "0.0100" }, mark: "0.0100", fills: [], reject: true });
  const rb = await buyBackLeg(b.client, { instId: "X", contracts: 3, spotUsd: 65_400, sleep: async () => {} });
  assert.ok(!rb.ok && rb.filledContracts === 0 && rb.costUsdc == null);
  assert.equal(b.placed.length, 2, "book rung and mark rung both tried");

  const c = fakeClient({ book: {}, fills: [] });
  const rc = await buyBackLeg(c.client, { instId: "X", contracts: 3, spotUsd: 65_400, sleep: async () => {} });
  assert.equal(c.placed.length, 0, "no reference price ⟹ no order");
  assert.match(rc.notes[0], /empty book/);
});
