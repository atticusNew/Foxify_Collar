/**
 * Replay of member-sale ledger lines in the shape the service writes today.
 *
 * The fixture's first nine lines were written by the member lock and leave routes themselves
 * (10 November 2026): single-market sales (filled, partial), two leaves with their buy-backs, a
 * combination sold on a quote, a second lock on a market left earlier, a holder's own ledger
 * line. The last two are settle lines in the same shape as the one the routes wrote. The state
 * file beside it is what those lines replayed to on the day they were written. A change to how a
 * sale is priced or recorded must leave both alone: the production disk holds lines like these.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { cashDue, loadShadowPositions, settlePayouts } from "../src/eventCollar/crossVenue/shadowLedger";

const LEDGER = fileURLToPath(new URL("./fixtures/member-sale-ledger-nov-2026.jsonl", import.meta.url));
const STATE = fileURLToPath(new URL("./fixtures/member-sale-ledger-nov-2026.state.json", import.meta.url));

test("member sale ledger: lines in today's shape replay to the state they replayed to when they were written", () => {
  const lines = readFileSync(LEDGER, "utf8").split("\n").filter((l) => l.trim().length > 0);
  assert.equal(lines.length, 11);
  assert.deepEqual(
    lines.map((l) => (JSON.parse(l) as { type: string }).type),
    ["open", "open", "close", "open", "close", "open", "open", "settle", "open", "settle", "settle"],
  );
  const state = JSON.parse(JSON.stringify(loadShadowPositions(LEDGER))) as unknown;
  assert.deepEqual(state, JSON.parse(readFileSync(STATE, "utf8")));
});

test("member sale ledger: a replayed sale settles on its own whole-contract totals, the leave on the sale less the buy-back, and nothing is owed between the parties", () => {
  const rows = loadShadowPositions(LEDGER);
  const row = (ticker: string, generation = 1) => {
    const r = rows.find((p) => p.ticker === ticker && (p.generation ?? 1) === generation);
    assert.ok(r, `${ticker} generation ${generation}`);
    return r;
  };

  // 30 of 50 sold at 53 cents for $16.15, bought back at 56 cents for $16.80: the round trip left 65 cents less
  const left = row("KXNBAGAME-26OCT14LALBOS-BOS");
  assert.deepEqual(
    [left.status, left.closeSource, left.memberSale?.soldContracts, left.memberSale?.keptContracts, left.memberSale?.cashNowCents, left.memberSale?.capTotalCents, left.closeMemberBuyBack?.boughtContracts, left.closeMemberBuyBack?.costCents, left.protectedCents, left.nakedCents, left.deltaCents],
    ["closed", "unwind", 30, 20, 1615, 3615, 30, 1680, -65, 0, -65],
  );

  // locked again after the leave: 20 of 50 sold at 54 cents for $10.80; the side lost, the cash is what stands
  const again = row("KXNBAGAME-26OCT14LALBOS-BOS", 2);
  assert.deepEqual([again.status, again.result, again.holder, again.memberSale?.cashNowCents, again.memberSale?.capTotalCents, again.protectedCents, again.nakedCents, again.deltaCents], ["settled", "no", "m-a75cab2d7c6bcbb5", 1080, 4080, 1080, 0, 1080]);

  // a partial: 30 of the 32 asked filled at 61 cents; the side won: $18.30 in hand plus $1 on each of the 10 riding
  const won = row("KXNBAGAME-26OCT14NYKMIA-MIA");
  assert.deepEqual(
    [won.status, won.result, won.memberSale?.status, won.memberSale?.requestedContracts, won.memberSale?.soldContracts, won.memberSale?.keptContracts, won.memberSale?.cashNowCents, won.memberSale?.capTotalCents, won.protectedCents, won.nakedCents, won.deltaCents],
    ["settled", "yes", "partially_cancelled", 32, 30, 10, 1830, 2830, 2830, 4000, -1170],
  );

  // a combination sold on the venue's quote, every leg hit
  const combo = row("STXCOMBO-M-COMBO-LIVE");
  assert.deepEqual([combo.status, combo.result, combo.memberSale?.combo?.legs, combo.memberSale?.cashNowCents, combo.memberSale?.capTotalCents, combo.protectedCents, combo.nakedCents], ["settled", "yes", 2, 180, 780, 780, 1000]);
  const open = row("STXCOMBO-M-COMBO");
  assert.deepEqual([open.status, open.memberSale?.combo?.rfqId, open.memberSale?.combo?.quotedPriceCents, open.memberSale?.combo?.legs, open.memberSale?.cashNowCents, open.memberSale?.capTotalCents], ["open", "rfq-18", 30, 3, 90, 290]);

  for (const p of rows) {
    const s = p.memberSale;
    assert.ok(s, `${p.ticker} carries its sale`);
    // the floor plus $1 on every riding contract is the cap, to the cent, on every line already written
    assert.equal(s.floorTotalCents, s.cashNowCents);
    assert.equal(s.floorTotalCents + s.keptContracts * 100, s.capTotalCents);
    assert.deepEqual(settlePayouts(p, "yes"), { protectedCents: s.capTotalCents, nakedCents: p.contracts * 100, deltaCents: s.capTotalCents - p.contracts * 100 });
    assert.deepEqual(settlePayouts(p, "no"), { protectedCents: s.floorTotalCents, nakedCents: 0, deltaCents: s.floorTotalCents });
    assert.deepEqual(cashDue(p), []);
  }
});
