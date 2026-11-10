Draft for the founder's review. Not sent. 10 November 2026.

# Earn & Protect for Prospect Markets: Lock in during a live game

To: [addressee]
From: Michael, Atticus Trade, Inc.

A bettor who holds a position taps Lock in, before or during the game. "Win it all or lose it all" becomes a known floor and a known cap.

## Lock in during a live game, as it stands today

- **Running now.** Our demo board quotes games in play from live books. No orders.
- **Built and on by default, in a test environment, no real money.** A member who connects their venue account can Lock in while the game is on. The lock is their own limit order to sell part of the position.
- **Built, not yet deployed.** Our hedged path opens from seven days before the start until four hours after it. A real-money lock buys the other side first, all or none, at a limit price. The lock is written only after the whole order fills.
- **The gates.** No whole fill, no lock. We refuse when the odds are out of range or the cost is above our ceiling. Hedge orders are capped by default at 25 contracts an order and 100 a day. One switch stops them all.
- **Simulated and real.** Our public record is simulated and pre-game. In-play orders are tested against a scripted venue, not a live one. No real-money lock has been taken during a game.

## What the bettor sees: three numbers

Floor, cash now, cap. One lock from our record: 18 contracts that would pay $18 or $0. The holder sold 7 at 61 cents. Cash now and floor: $4.27, before a 17 cent venue fee. Cap: $15.27, below the full win, shown before the tap.

## What your venue gets

- **Flow.** By default the holder sells on your venue, in their own account. Every lock is a sell order on your book.
- **Fees.** Your trading fees on those orders.
- **No balance-sheet use.** We hold nothing and fund nothing. Neither do you.
- **A record you can check.** Since 12 September 2026, 1,811 simulated positions put 162,297 contracts and $76,655 onto public books. Cost to holders: 2.95% of expected value quoted, 3.6% realized.

## What we ask for

1. A pilot on [founder to fill: leagues or markets].
2. A way to place that sale from our Lock in line: a link to your sell ticket, or account connection with the member's consent.
3. Your rules for orders placed during a game.
4. A referral or builder fee on trades we originate: [founder to fill: fee]. Own sale earns us nothing by itself.

Two other shapes need a signed agreement. Nothing here is an offer to trade.

## Sources

Not for pasting. Record figures were read from the public route `https://atticus-event-shadow.onrender.com/api/shadow` on 10 November 2026 at 22:55 UTC.

- 1,811 positions; 162,297 contracts; $76,655: `summary.flow.allTime` (`positions` 1811, `contracts` 162297, `hedgeNotionalCents` 7665544, `since` 2026-09-12). All simulated.
- 2.95% quoted: `summary.quotedAvgEvBps` 295, basis points of the unhedged position's expected value (`evCostBps` in `services/api/src/eventCollar/crossVenue/collarSearch.ts`). The record page rounds it to 3.0%.
- 3.6% realized: `summary.deltaTotalCents` (-442828) over `summary.nakedTotalCents` (12134035), which is 3.65% of what the same positions paid with no lock; the record page prints 3.6% (`services/api/scripts/eventShadowHtml.ts`). The same cost is 2.05% of stake (`realizedDeltaBpsOfStake` -205).
- The 18-contract lock: public record, ticker `KXNFLGAME-26NOV08NYGPHI-NYG`, opened 2026-11-06T22:08:54Z, route `member_sale`: `soldContracts` 7, `avgPriceCents` 61, `cashNowCents` 427, `feeCents` 17, `capTotalCents` 1527. Taken in a venue's demo environment, no real money (`docs/AGENT_HANDOFF.md` section 3).
- Seven days, four hours, hedge first, all or none: `lockWindow.ts` and `hedgeFirst.ts` on branch `cursor/event-stx-combo-rfq-default-18af` (pull requests #399 and #400, open, not merged).
- Odds range (10 to 92 cents) and cost ceiling (3% of expected value on the demo service): `DEFAULT_CROSS_CONFIG` in `services/api/src/eventCollar/crossVenue/types.ts`; `EVENT_X_MAX_EV_COST_BPS` in `render-event-demos.yaml`.
- 25 an order and 100 a day: `DEFAULT_LIVE_RAILS` in `services/api/src/eventCollar/crossVenue/liveHedge.ts`. The values set in Render may differ.
- In play on the demo board: `EVENT_X_IN_PLAY` in `render-event-demos.yaml`. In play on the member page: `MEMBER_APP_IN_PLAY`, same file.
- "Tested against a scripted venue, not a live one": the body of pull request #400.
- "No real-money lock has been taken during a game": the deployed hedged path closes 45 minutes before the start until #400 merges (`protectCutoffMinutes`, 45, and the comment at "IN-GAME RE-READ", both in `services/api/scripts/eventShadowWorker.ts`), and the member page runs in a venue's demo environment only.
- The two other shapes (better bid, collar) and the order the founder approved them in: the brief for this pack, 10 November 2026; not yet in the handoff.
- Prospect Markets and the thread: `docs/AGENT_HANDOFF.md` section 4.
