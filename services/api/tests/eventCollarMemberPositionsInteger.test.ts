/**
 * What a member holds, what they paid and what their account holds are read from the venue's
 * digits into integers (memberApp.ts): no float between the venue's string and a cent.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { MemberClient, memberHolderPositions } from "../src/eventCollar/crossVenue/memberApp";
import type { RawOutcomeMarket } from "../src/eventCollar/crossVenue/venueMarkets";


test("member positions and balance: sizes, what was paid and the balance are read from the venue's digits; a half cent paid goes up, a balance never shows more than the venue holds", async () => {
  const market = (id: string, maxPrice: string | null): RawOutcomeMarket => ({ market_id: id, rules: "home_winner", status: "open", competition: "NBA", max_price: maxPrice }) as RawOutcomeMarket;
  const positions = [
    // 1.005 a contract on a $2 market: 100.5 cents, where a float says 100.49999999999999
    { market_id: "a", position: "1", average_open_premium: "-1.005" },
    // 3 x 0.145 = 43.5 cents, where a float says 43.49999999999999
    { market_id: "b", position: "3", average_open_premium: "0.145" },
    // 10 x 0.0055 = 5.5 cents, where a float says 5.499999999999999
    { market_id: "c", position: "10.00", average_open_premium: "-0.0055" },
    { market_id: "d", position: 50, average_open_premium: "-0.4725" },
    { market_id: "e", position: "7.50", average_open_premium: "-0.90" },
    { market_id: "f", position: "33.337", average_open_premium: null },
    { market_id: "g", position: "0.999", average_open_premium: "0.5" },
    { market_id: "h", position: "-5.00", average_open_premium: "0.60" },
    { market_id: "i", position: "junk", average_open_premium: "0.60" },
  ];
  const markets = [market("a", "2.00"), market("b", "1.0000"), market("c", "1.0000"), market("d", null), market("e", "2.00"), market("f", "1.00"), market("g", "1.00"), market("h", "1.00"), market("i", "1.00")];
  let balance: Record<string, unknown> = { account_balance: "0.29", available_balance: "1.005" };
  const client = new MemberClient({
    host: "http://venue.test",
    token: async () => "t",
    fetchImpl: (async (input: string | URL | Request) => {
      const u = String(input);
      if (u.endsWith("/api/v1/positions")) return new Response(JSON.stringify({ positions }));
      if (u.includes("/api/v1/markets")) return new Response(JSON.stringify({ markets }));
      if (u.endsWith("/api/v1/account/balance")) return new Response(JSON.stringify({ balance }));
      return new Response("{}", { status: 404 });
    }) as typeof fetch,
  });
  assert.equal(Math.round(1.005 * 1 * 100), 100);
  assert.equal(Math.round(0.145 * 3 * 100), 43);
  assert.equal(Math.round(0.0055 * 10 * 100), 5);
  const rows = await memberHolderPositions(client, [], { nba: "NBA" });
  assert.deepEqual(
    rows.map((r) => [r.marketId, r.contracts, r.payoutCents, r.entryCents, r.costCents, r.maxPrice, r.maxPriceMicro]),
    [
      // one $2 contract is two of ours; 1.005 of $2 is 50.25 cents of $1
      ["a", 2, 200, 50, 101, 2, 2_000_000],
      ["b", 3, 300, 15, 44, 1, 1_000_000],
      // an entry under a cent shows as 1
      ["c", 10, 1000, 1, 6, 1, 1_000_000],
      // 50 x 0.4725 = $23.625
      ["d", 50, 5000, 47, 2363, 1, 1_000_000],
      // 7.5 $2 contracts are 15 of ours; 7.5 x 0.90 = $6.75
      ["e", 15, 1500, 45, 675, 2, 2_000_000],
      // no premium on the wire: the entry reads as 50, the cost as the size at it; the size keeps hundredths, the finer fraction dropped
      ["f", 33.33, 3333, 50, 1667, 1, 1_000_000],
    ],
    "under one contract, a short and an unreadable size are left out",
  );

  assert.equal(Math.floor(0.29 * 100), 28);
  let b = await client.balance();
  assert.deepEqual([b.accountCents, b.availableCents], [29, 100], "29 cents is 29; half a cent is not shown as a cent the member does not have");
  balance = { account_balance: 250, available_balance: "249.999" };
  b = await client.balance();
  assert.deepEqual([b.accountCents, b.availableCents], [25_000, 24_999]);
  balance = { account_balance: "", available_balance: null };
  b = await client.balance();
  assert.deepEqual([b.accountCents, b.availableCents], [null, null]);
  balance = { account_balance: "1e3", available_balance: "12.3.4" };
  b = await client.balance();
  assert.deepEqual([b.accountCents, b.availableCents], [null, null]);
});
