/**
 * A real fill's line keeps the venue's fee, and on ProphetX the part of the cost that is charged
 * only at settlement. The money of an order comes from one function per venue, so a later read of
 * the same fills gives the same cents the order wrote.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { intentFromHedge, type ExecutorClock } from "../src/eventCollar/crossVenue/hedgeExecutor";
import { LiveHedgeExecutor, type LiveHedgeRails, type LiveOrderHook, type LiveOrderResult } from "../src/eventCollar/crossVenue/liveHedge";
import { novigFillMoney, sumNovigFills } from "../src/eventCollar/crossVenue/novigOrders";
import { buyCostCents, gainFeeCents, prophetxFillMoney, sumProphetXFills } from "../src/eventCollar/crossVenue/prophetxOrders";

const CLOCK: ExecutorClock = { now: () => new Date("2026-11-03T18:00:01.000Z"), sleep: async () => undefined };
const RAILS: LiveHedgeRails = { killSwitch: false, dryRun: false, allowlist: [], anyTicker: true, maxUnitsPerOrderMilli: 500_000, maxUnitsPerDayMilli: 5_000_000 };
const INTENT = intentFromHedge({ action: "buy", venue: "kalshi", outcome: "No", ticker: "KXNBAGAME-26NOV03BOSLAL-BOS", contractsMilli: 12_000, avgPriceCents: 25, worstPriceCents: 26, costCents: 306 }, 250);

const answer =
  (over: Partial<LiveOrderResult>): LiveOrderHook =>
  async (intent) => ({ orderId: "ord-1", unitsMilli: intent.unitsMilli, avgPriceMilli: 250, costCents: 300, feesCents: 5, status: "executed", ...over });
const run = (hook: LiveOrderHook) => new LiveHedgeExecutor({ kalshi: hook }, RAILS, () => 0, CLOCK).execute(INTENT, "ref");

test("live executor: the venue's fee and a settlement provision ride on the real fill's line; nothing invented when the venue gave none", async () => {
  const plain = await run(answer({}));
  assert.equal(plain.fill?.feesCents, 5);
  assert.equal("settlementProvisionCents" in plain.fill!, false, "no provision where the venue has no settlement fee");

  const provided = await run(answer({ costCents: 318, feesCents: 0, settlementProvisionCents: 18 }));
  assert.deepEqual([provided.fill?.costCents, provided.fill?.feesCents, provided.fill?.settlementProvisionCents], [318, 0, 18]);

  // a fee that is not whole cents is left off the line rather than written wrong
  const odd = await run(answer({ feesCents: 4.5, settlementProvisionCents: -1 }));
  assert.equal("feesCents" in odd.fill!, false);
  assert.equal("settlementProvisionCents" in odd.fill!, false);

  // the paper fallback behind a failed order carries no venue fee
  const failed = await run(async () => {
    throw new Error("kalshi orders: HTTP 400 POST /portfolio/events/orders insufficient_balance");
  });
  assert.equal(failed.fill?.simulated, true);
  assert.equal("feesCents" in failed.fill!, false);
});

test("ProphetX: one cost function for the order and the check; the fee on the gain is provided for on a buy and taken off the offset", () => {
  // 12 shares for a stake of $3.00 and a 4c match fee: the fee on the gain is 2% of (1200 - 300) = 18c
  const sum = sumProphetXFills([
    { fillId: "f1", orderId: "px-1", venueFillId: "v1", shares: "7.000000", price: "0.250000", stakeUsd: "1.75", feeUsd: "0.03", occurredAt: "2026-11-03T18:00:01.000Z" },
    { fillId: "f2", orderId: "px-1", venueFillId: "v2", shares: "5.000000", price: "0.250000", stakeUsd: "1.25", feeUsd: "0.01", occurredAt: "2026-11-03T18:00:01.200Z" },
  ]);
  assert.deepEqual(sum, { sharesMilli: 12_000, stakeCents: 300, feesCents: 4, avgPriceMicro: 250_000 });
  assert.equal(gainFeeCents(sum, 200), 18);
  const buy = prophetxFillMoney(sum, 12_000, false, 200);
  assert.deepEqual(buy, { unitsMilli: 12_000, avgPriceMilli: 269, costCents: 322, feesCents: 4, settlementProvisionCents: 18 });
  assert.equal(buy.costCents, buyCostCents(sum, 200));
  assert.equal(buy.costCents - buy.settlementProvisionCents!, 304, "what left the account at the fill: the stake and the match fee");

  // the offset: 12 shares of the holder's strike at 0.56; the pair pays 12 x (1 - 0.56) = 528c at the game, less 2% of it
  const offset = sumProphetXFills([{ fillId: "f3", orderId: "px-2", venueFillId: "v3", shares: "12.000000", price: "0.560000", stakeUsd: "6.72", feeUsd: "0", occurredAt: "2026-11-03T20:00:01.000Z" }]);
  assert.deepEqual(prophetxFillMoney(offset, 12_000, true, 200), { unitsMilli: 12_000, avgPriceMilli: 430, costCents: 517, feesCents: 11 });
  // a windfall of shares over the hedge's own size offsets only the hedge
  assert.equal(prophetxFillMoney(offset, 10_000, true, 200).unitsMilli, 10_000);
  // nothing filled is nothing, not a division by zero
  assert.deepEqual(prophetxFillMoney(sumProphetXFills([]), 12_000, false, 200), { unitsMilli: 0, avgPriceMilli: 0, costCents: 0, feesCents: 0, settlementProvisionCents: 0 });
});

test("Novig: one cost function for the order and the check; contracts pay one cent", () => {
  const sum = sumNovigFills([
    { fillId: "f1", orderId: "nv-1", marketId: "m", outcomeId: "o", qty: 700, cost: "1.75000", fee: "0.02100", taker: true, ts: 1_793_728_801_000 },
    { fillId: "f2", orderId: "nv-1", marketId: "m", outcomeId: "o", qty: 500, cost: "1.27500", taker: true, ts: 1_793_728_801_500 },
  ]);
  assert.deepEqual(sum, { contracts: 1_200, costMicro: 3_025_000, feeMicro: 21_000 });
  // 1200 one-cent contracts are 12 units; $3.046 paid is 305c against us, the 2.1c fee is 3c
  assert.deepEqual(novigFillMoney(sum, 12_000, false), { unitsMilli: 12_000, avgPriceMilli: 255, costCents: 305, feesCents: 3 });
  // the offset: the pair pays 1200 cents at the game, less the 304.6c paid, rounded down
  assert.deepEqual(novigFillMoney(sum, 12_000, true), { unitsMilli: 12_000, avgPriceMilli: 745, costCents: 895, feesCents: 3 });
  assert.deepEqual(novigFillMoney(sumNovigFills([]), 12_000, false), { unitsMilli: 0, avgPriceMilli: 0, costCents: 0, feesCents: 0 });
});
