# LinkedIn drafts, three posts

Timed for days 3, 6 and 9 of the plan. Refresh every number from the record the morning each one goes out; the figures below are as of 2026-10-12 22:28 UTC. Link once, at the end. No venue other than the public record named. No dealers, no netting, nothing about what ships next.

Rules on the words: no em dash; "address", never "wallet"; "our P&L", never "writer"; "user", never "holder".

---

## Day 3: the record milestone

**739 settled. $0 gap.**

Since September 12 a protection engine has been running in public on prediction-market positions. Every quotable event gets protected at its live quoted terms, then marked against the official result when it settles. Nothing is bought; the prices, the terms and the results are real.

As of this morning: 739 positions settled. 314 of them, 42%, finished above the unprotected outcome because the floor paid. Users were paid $2,395 in cash at the tap, on $110,850 of stake.

The number I watch is the gap. Leg for leg, what we earn on a settled position has to equal the take we published at quote time: the hedge pays the floor, the cap slice pays the hedge, and nothing depends on who won. On 739 settled positions our P&L is $287.97 and the take booked is $287.97. Gap: $0.

That is the whole claim. A protection layer that carries no outcome risk, proven one position at a time, in integer cents, in public.

Record, every row, CSV included: atticus-event-shadow.onrender.com

---

## Day 6: the parlay moment

**A parlay is three bets until it is one.**

Here is a $20 four-pick ticket from the record. Jaguars, Real Betis, Texans, and Sporting CP not to win. Pays $87 if it lands.

Saturday it was a long shot. Nobody can price an honest floor on a long shot, and nobody should try.

By Sunday night three picks had hit. Now it is one game, at one game's odds, 44 hours before kickoff. At the public book that position was worth $55.68.

Three choices at that moment:

Hold: $87 or $0.
Sell: about $55, less the spread, and the ticket is gone.
Lock: keep the ticket, $40.82 if it loses, $62.57 if it wins, and $2.54 in cash now.

The lock exists at the last pick and nowhere before, because that is the only moment it can be priced honestly. The record tracks every ticket that got there and shows lock against sell against hold on each.

20 tickets so far, 12 busted on an early pick, 6 reached the last pick and were priced. The first settlements land this week.

Record: atticus-event-shadow.onrender.com (Parlays card)

---

## Day 9: what cash-out actually costs

**Cash out is a sale. Somebody is on the other side of it.**

Every sportsbook offers cash out. It sells the whole position back at a price the book chooses, and the user takes what is offered.

On the public record we have been measuring the cost of leaving a position early at a public book instead. 28 positions left before the lock, each exit a new trade at live prices that second. Crossing the books cost $142.95 against the mid on $4,200 of stake, about 3.4%, plus $66.78 in venue fees. That is with a transparent order book and no house margin. A cash-out button inside a closed book is not cheaper than that.

The lock is the third choice beside hold and cash out. The position stays open. It ends at a floor or a cap, and part of it is paid in cash now. Realized cost of protection on 350 settled games: 1.3% of stake. The user keeps the ticket, keeps the upside to the cap, and gets paid today.

Hold, sell, or lock. The record shows what each one paid.

atticus-event-shadow.onrender.com

---

### Before posting, pull fresh numbers

    curl -s https://atticus-event-shadow.onrender.com/api/shadow | python3 -c "import json,sys; s=json.load(sys.stdin)['summary']; print(s['settledCount'], s['floorSaves'], s['identity'], s['writer']['creditsPaidCents'], s['closed'])"
    curl -s https://atticus-event-shadow.onrender.com/api/shadow/parlays | python3 -c "import json,sys; print(json.load(sys.stdin)['summary'])"
