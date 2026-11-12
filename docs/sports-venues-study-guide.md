# Sports venues report: study guide

How to read the page, section by section, in plain terms, and what to say about it. Companion
to `docs/sports-venues-report.md`, which has the mechanics.

## 0. The one-paragraph version

Five US venues list the same game. A trader holding a position on one of them has to buy the
other side somewhere when they want out or want to hedge, and the cheapest place to do that
changes by game, by side, and by whether the game has started. The page reads all five books
for every game at once, puts each venue's fee on top of its price, and answers three questions
every snapshot: where is the other side cheapest and by how much; do the venues agree on the
game or is one of them off; and is there a moment where buying both sides on two different
venues costs less than a dollar. Then it keeps every snapshot so the same questions can be
answered over the window, not just now.

## 1. The strip, the key and the six tiles

**Reference** (grey) is what anyone can see by opening five tabs: bid, ask, depth, fee, and the
gaps between venues over time. **Engine** (blue) is what you get only by reading all five books
for the same game at once: all-in prices, the consensus and who sits off it, the cheapest other
side for every position with its saving, and the crosses in dollars.

The six tiles, in order:

1. **Games with a choice of venue.** How many games on the board are two-sided on at least two
   venues, how many on all five, how many live. Novig and ProphetX list the nearest games only, so
   "on all five" is roughly today's slate.
2. **Tightest book, both sides all in.** Per venue: on how many of the games it lists was buying
   both sides at all-in asks the cheapest. Read it against the denominators: Novig 13 of 13 with
   Kalshi 26 of 41 means Novig is tightest on every game it lists and Kalshi is tightest where
   Novig is absent. The small line gives the mean both-sides cost over 100¢ per venue; pre-game
   Novig's is a fraction of a cent because it charges no fee before tip-off.
3. **Cheapest other side, now.** Of the sides where two or more venues quote the other side, how
   many are cheapest somewhere other than Kalshi, and the mean saving per $1 of position. This is
   the routing number.
4. **Cheapest other side, over the window.** The same, counted over every snapshot. "Readings" is
   one side of one game in one snapshot. The in-play share is split out once games have started.
5. **Executable crosses after fees.** How many games right now have two sides on two venues that
   add to less than 100¢ after both fees, and the dollars at resting depth. Over the window, how
   often one was open and the widest.
6. **Furthest off the consensus.** The venue whose de-vigged mid is on average furthest from the
   mean of the venues. Small numbers mean the venues agree.

## 2. Section 1: the board

One game, two rows (away team, home team). Each venue column is bid / ask on that team's "wins"
contract in cents, then depth at the best level (bid size × ask size, in $1 shares) and the fee as
it applies now. "no fee" on Novig means the game has not started. ProphetX shows "fee 2% of
winnings" on NFL and NBA (nothing at the trade, 2% of what the position wins at settlement) and
"fee 3.5%" on NHL (charged per contract at the trade, the same shape as Kalshi's at half the
rate). The page counts the 2% in full on every buy, as if that side wins, so a ProphetX price is
never shown cheaper than it can turn out. Crypto.com shows "fee 2¢ a contract": its exchange
charges a fixed 2¢ on every trade before expiry whatever the price, so it is dear on a cheap
contract (2¢ on a 10¢ contract is a fifth of the price) and close to Kalshi's fee near 50¢.

**Consensus** is each venue's two mids scaled to add to 100, averaged over the venues two-sided on
the game. The gap columns are each venue's scaled mid minus that mean. With two venues the
gaps are symmetric; with more one venue can be the odd one out. A gap of 1¢ or more is coloured.
It says a venue is off its peers; it does not say it is wrong.

**Other side, cheapest** is the column to send someone to. For a holder of this row's team, it
names the venue where the other team's contract is cheapest after fee, the all-in price, and what
that saves against buying the other team on Kalshi itself. Under it: how many venues quote it and
the size at that level. Pre-game the answer is usually Novig when Novig lists the game (no fee,
half-cent ticks); after tip-off Novig's fee switches on and the answer moves.

The game header line gives each venue's both-sides cost over 100¢ (spread plus fees), the
tightest, and the best cross if one exists.

## 3. Section 2: executable crosses, in dollars

Buy the away team on venue X and the home team on venue Y, both at all-in asks. If the two prices
add to less than 100¢ the difference is yours whichever team wins, because all five settle on the
same official result. The table shows the two venues, the two prices, the locked cents per $1, the
size (the smaller of the two best levels) and the dollars.

Pre-game this table is usually empty: fees of 1.5 to 2.5¢ a side eat half-cent gaps. It fills in
play, when one venue reprices a few seconds before another, and the window line under it records
how often that happened and the widest it got.

## 4. Section 3: the hedger's view of the venues

The venue scoreboard. Per venue: games listed; mean both-sides cost; games where it was tightest;
sides on which it quotes the other side; sides on which it is the cheapest; the mean saving vs
Kalshi's own when it is; mean distance from the consensus. Kalshi is the reference, so its saving
column reads "reference".

The coverage line above the table matters: a venue that lists 13 games cannot be cheapest on 82
sides. Read counts against what each venue lists.

The window line under the table is the number to quote: over N readings, which venue was cheapest
what share of the time, the mean saving when it was not Kalshi, and the same for in-play readings
only. In play is where routing across venues earns the most and where the page has to collect for
a while before the number is steady.

## 5. Section 4: gaps over time

Kalshi's mid minus each other venue's mid on the away side, per game, every snapshot. The strip
gives the mean absolute gap per venue pair, the widest game, and how many games sit 1¢ or more
apart on average. A gap that persists is a quoting difference (one venue's makers are leaning a
way the others are not). A gap that flickers is latency. The folded table has a sparkline per
game and venue.

## 6. Section 5: a holder on each venue

The same books read from the other chair. Someone already holds a team on a venue and wants out.
One row per venue as the place they hold it, once for before the start and once for in play, and
a fold by league. This section counts every snapshot since it began, so it keeps growing after
the window sections have rolled on.

- **Sale on its own book.** What selling right there gives up against the price the venues agree
  on: half that venue's spread plus its fee. On Crypto.com before the start this read about 2.6¢
  per $1 on 11 November 2026 (a 1¢ book and the 2¢ fee); on Kalshi about 2.3¢.
- **Spread** and **Bid holds 1,000 or more.** Whether the book is there to sell into, and how
  much it takes at the best price. "N more with no bid" under the readings is the times the
  holder could not sell there at all.
- **Other side cheaper elsewhere.** How often another venue's book beats this venue's own for the
  other team, and by how much. This is what routing across venues is worth to this venue's holder
  before anyone's cost of carrying it across.
- **Room for a better bid.** The strict one. Take the holder's contract at this venue's bid, pay
  this venue's fee on it, buy the other team on the cheapest venue: is anything left? When it is,
  a bid better than the venue's own book locks after every fee, and the room is the most it could
  add. Before the start it is close to never; the in-play table is where to look.

What to say: the first three columns are the case for selling on the holder's own venue (the book
is there, it is deep, and the cost is the spread and the fee). The last two say how much a second
venue could add, and how rarely that survives the fees.

## 7. Notes and limits

Read these before sending. The honest ones: five books read within one cycle, not one instant;
best level only; the consensus is the venues' agreement, not fair value; Kalshi's per-order fee
rounding ignored; postponement and abandonment rules differ by venue and a cross across venues
carries that small tail.

## 8. What to say about it

- It reads five public books for the same game at once and puts the fee on every price, so the
  comparison is in dollars a trader would actually pay.
- The number that matters is the last column of §1 and the window line of §3: where the other
  side is cheapest and what routing saves per $1, pre-game and in play.
- §2 is the strict version: not "cheaper", but "locks after both fees". It is mostly empty before
  tip-off, which is the honest answer, and fills in play.
- Novig lists only the day's games and charges nothing before the start, so it is the pre-game
  answer on its games; after tip-off its fee switches on and the answer moves.
- ProphetX quotes within about a cent of Kalshi on the games it lists (18 of 43 on 11 November
  2026). Its fee is 2% of winnings on NFL and NBA and half Kalshi's per-contract rate on NHL.
  Before the start it was not the cheapest other side on any of those games that day, because
  Novig charges nothing then; the window sections show whether that changes in play.
- Crypto.com is the exchange behind OG and behind brokers that introduce customers to it. It
  listed every game on the board (43 of 43 on 11 November 2026) at a book 1¢ wide with tens of
  thousands of contracts at the best level on the day's games, within half a cent of Kalshi's mid
  on average. Its fixed 2¢ a side puts its both-sides cost at about 5¢ over 100, the same as
  Polymarket US and above Kalshi's 4¢.
- Nothing is modelled. Every cell is a price, a fee, or a difference.

## 9. What stays off the table

No account data, no partner mapping, no offshore venue, no venue that needs a key to read. No
spreads or totals in this version. ProphetX is read from the same unsigned endpoints its own
website uses; if the venue closes them the column goes empty and the page says so.

## 10. The Lock in pages

Not under the sports page's key. Two addresses, each with its own key:

- `/prospect` under `PROSPECT_PAGE_KEY`: the page made for Prospect. This is the link you send.
- `/lockin` under `LOCK_IN_INTERNAL_KEY`: every table, the method, and the lock card with the
  order behind it (`/lockin/lock`). Yours only. Never send this link.

Mechanics are in `docs/sports-venues-report.md` under "Lock in on the trade tape" and "Pages
with a key of their own".

**The reader's page, top to bottom.** Retail-size tickets ($500 or less) first.

1. Where customers are lost: how many tickets finished at $0, and how many of those were ahead
   at some point.
2. What Lock in is, for the customer: cash now, the rest keeps riding, done on the exchange at
   the market's price. Nobody takes the other side: not Prospect, not Atticus.
3. Two real tickets off the tape, one that lost and one that won, and the lock as a customer
   would see it for any finished game at any moment of it (or a game on the board now).
4. The replay's three main rows, how long the chance lasted, and what it costs the winners.
5. The calculator: how many lock in 100, Prospect's share of the exchange, what Prospect earns
   per contract.
6. One line: the exchange's best price nearly always has far more behind it than a retail
   ticket needs.
7. What a pilot would answer.

"Guide" steps through six of those with a short note at each for what the number means to
Prospect. Arrow keys move it, Escape closes it. "Show all notes" opens them all, and they print.

**What the page holds back, and what to say if asked.** The page shows results and not how they
are produced. It never says what order a lock places, how it is sized, where the thresholds
are, how the data is collected, or what Atticus does in the flow. None of it is hidden if they
ask; the page does not hand it over.

- The page says "Prospect" and never "broker". Prospect is the broker: its US arm is a
  registered introducing broker that sends its customers' orders to Crypto.com's exchange.
  There is no third party. But it calls itself a platform, so the page does too.
- Prospect opened to the public on 12 November 2026 (invitation-only since September). The
  games on the page so far were played before that: they are the exchange's customers, not
  Prospect's. The page does not claim otherwise, and that is why step one of the pilot reads
  "on Prospect's own customers as they trade".
- The page does not say how Prospect is paid on an order. That is not public. Ask him.
- "Is it just the customer selling part of the position?" Yes. It is their own order on the
  exchange. Which part, when, shown how, and what it does to whether they come back is the
  product and the pilot.
- "Where is the data from?" The exchange's public trade tape. Every ticket on the page can be
  checked against it: the time, the size and the price are shown.
- "Can we see the full tables?" Yes, on a call, from your internal page. Do not send that link.
- Keep in your pocket, not on the page: takers' sales are already 18% of trades in play, so
  holders do get out by hand today. Use it if they doubt the demand. It also invites "so they
  can already do it", which is why it is not written down for them.

The rest of this section describes the full tables (`/lockin`, internal).

**What the replay is.** Crypto.com's exchange publishes every trade. Each taker buy is a real
position someone opened. The page follows every one to the final whistle and shows what Lock in
would have done, at bids that were really on the book. Nothing is simulated, and nothing uses
hindsight: in play each option is taken the first time it is possible.

**How to read it, top to bottom.**

- The strip: games counted, positions opened and what was paid for them, and how many finished
  at $0. That last figure is the problem the product addresses, in the exchange's own numbers.
- Section 2, before the start: there is almost never a gain to lock before a game. A lock then
  does one thing: it turns "all or nothing" into a floor and a cap. Max upside keeps 60% riding
  with about a third of the stake as a floor; Max floor keeps 20% riding with about 70%.
- Section 3, in play: this is where a lock has something to lock. The row to point at is
  "Stake back": how many positions reached a moment where selling part returned everything
  paid, with the rest riding free, and how many of those then lost.
- Section 4: every lock is a sell order on the exchange's own book that would not otherwise be
  placed. Shown for 10 in 100 holders, because nobody should plan on all of them.

**The first 31 games** (9 to 11 November 2026: 16 NBA, 14 NHL, 1 NFL; priced at takers' sales
only, since the book was not yet being kept beside the tape):

- 32,255 positions, $1.75M paid; 43% of positions and 65% of contracts were opened in play.
- 17,461 positions (54%) finished at $0, having paid $707,166. 8,033 of them (46%) were ahead
  at some point after they were opened.
- In play, 44% of positions reached a bid where selling 80% or less returned the whole stake.
  23% of those (3,181 positions, $120,822 paid) then lost and got $0; the lock returns it all.
  The chance lasted 14 minutes on average, and ten minutes or more for a third of them.
- Retail only ($500 or less): 31,629 tickets, mean $26.76. 17,234 finished at $0, 7,918 of them
  having been ahead. 13,789 could take the stake back in play; 3,141 of those then lost,
  having paid $81,948.
- Before the start, Max upside left a floor of 36% of the stake; 7,031 positions that lost
  would have kept $75,572.
- Takers' sales are already 18% of trades in play: holders sell by hand today.
- If 10 in 100 of those who could lock in play did: 1,406 extra sell orders, about 103,000
  contracts, $2,054 in exchange fees, over 31 games.

(The stake-back counts are a few dozen lower than first reported: a stake that is not a whole
number of cents is now covered as it was charged, rounded up to the cent.)

**What not to claim from it.**

- Not that a lock makes holders money. It moves money from the games they win to the games
  they lose. On these 31 games the winners who locked gave up more ($168,528) than the losers
  kept ($120,844). That swings with which sides won and is expected to come out near the fees
  over enough games. The product is the floor, not an edge.
- Not that these are one broker's customers. It is the whole exchange, market makers included.
- Not how many would lock, or that locking brings a holder back. The first needs the product
  in front of them; the second needs a broker's account data. That is the ask.

**The lock card.** Pick a game and a side, type a position, and it shows the floor, the cash now
and the cap for each option. For a game on the board, at the bid on Crypto.com's book this
minute. For a finished game, at a bid that was there at the moment picked, with how the side
finished beside each option. Before the start it shows the three sizes; in play, once the bid
is high enough, stake back comes first.

**What not to say about the book.** Do not claim a third party can pay a holder more than
Crypto.com's own bid. Measured against the other US exchanges after every fee, there is room
for that in well under 1% of readings. What the count supports is the opposite and is good
news for a broker: the exchange's own book is the customer's best way out, so the lock is an
order on that exchange.
