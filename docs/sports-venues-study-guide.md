# Sports venues report: study guide

How to read the page, section by section, in plain terms, and what to say about it. Companion
to `docs/sports-venues-report.md`, which has the mechanics.

## 0. The one-paragraph version

Four US venues list the same game. A trader holding a position on one of them has to buy the
other side somewhere when they want out or want to hedge, and the cheapest place to do that
changes by game, by side, and by whether the game has started. The page reads all four books
for every game at once, puts each venue's fee on top of its price, and answers three questions
every snapshot: where is the other side cheapest and by how much; do the venues agree on the
game or is one of them off; and is there a moment where buying both sides on two different
venues costs less than a dollar. Then it keeps every snapshot so the same questions can be
answered over the window, not just now.

## 1. The strip, the key and the six tiles

**Reference** (grey) is what anyone can see by opening four tabs: bid, ask, depth, fee, and the
gaps between venues over time. **Engine** (blue) is what you get only by reading all four books
for the same game at once: all-in prices, the consensus and who sits off it, the cheapest other
side for every position with its saving, and the crosses in dollars.

The six tiles, in order:

1. **Games with a choice of venue.** How many games on the board are two-sided on at least two
   venues, how many on all four, how many live. Novig and ProphetX list the nearest games only, so
   "on all four" is roughly today's slate.
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
never shown cheaper than it can turn out.

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
add to less than 100¢ the difference is yours whichever team wins, because all four settle on the
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

## 6. Notes and limits

Read these before sending. The honest ones: four books read within one cycle, not one instant;
best level only; the consensus is the venues' agreement, not fair value; Kalshi's per-order fee
rounding ignored; postponement and abandonment rules differ by venue and a cross across venues
carries that small tail.

## 7. What to say about it

- It reads four public books for the same game at once and puts the fee on every price, so the
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
- Nothing is modelled. Every cell is a price, a fee, or a difference.

## 8. What stays off the table

No account data, no partner mapping, no offshore venue, no venue that needs a key to read. No
spreads or totals in this version. ProphetX is read from the same unsigned endpoints its own
website uses; if the venue closes them the column goes empty and the page says so.
