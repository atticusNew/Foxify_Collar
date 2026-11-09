# BTC curve report: study guide

A plain-language walk through every number on the page, in the order it appears, with the
real-world meaning, how it is computed, what it looked like on the first live day
(Nov 8, 2026), and the questions a trading-systems person will ask about it. Companion to
`docs/btc-curve-report.md` (the technical spec) and `docs/btc-curve-plain-english.md` (the
short version). Page copy is written as chart captions: fragments, standard labels. The
headings quoted below are the ones on the page as of the Nov 8 late-evening deploy.

---

## 0. The one-paragraph version

Two regulated US venues (Kalshi and Polymarket US) sell $1 contracts on where Bitcoin will be.
The listed option market (Deribit) also tells you, indirectly, where Bitcoin "should" be
priced to land. The page puts the three side by side, bucket by bucket, and then asks the
three questions a desk asks before touching it: how far apart are the venues (and can you
actually collect the difference after fees), how much does a second of delay cost, and if
you sell one of these contracts, what does it cost to hedge it two different ways. The last
section quotes our own product, Lock in, along the same ladder, so the reader sees it priced
on the same inputs as everything else.

---

## 1. The strip at the top

| On the page | What it is | Why it matters |
| --- | --- | --- |
| **BRTI $74,659.82** | The CF Benchmarks Bitcoin Real-Time Index: a once-a-second composite of several spot exchanges. | Every contract on both venues settles against this number, not against Coinbase or Binance. If you hedge against anything else, you carry basis risk to BRTI. |
| **settlement index, both venues** | Confirms both venues use the same index. | They do, but with different averaging (see §1 below). If it reads "(Deribit index this cycle)", the BRTI feed failed that minute and Deribit's index stood in. |
| **As of 6:55 PM ET · refresh 60s** | The timestamp of the snapshot you are looking at. | The page is a live read, not a report from last week. |
| **Window 237 snapshots · since …** | How many one-minute observations the time-series sections (§2 table, §3, §5) have to work with. The window survives a redeploy (it is on disk). | On day one this is small. The gaps and hedge sections become meaningful after a day. |

Where the index comes from: Polymarket US republishes BRTI one-second candles on its public
price-history endpoint, and that is what the page reads. On Nov 8 it sat $20 from Deribit's
own BTC index at the same second, which is normal (different constituent exchanges).

### CME versus BRTI: which one is "the" price

They are two different kinds of thing, and the page uses each for what it is.

- **BRTI** is a spot index: once a second, CF Benchmarks blends live trades from a set of
  spot exchanges (Coinbase, Kraken, Bitstamp, Gemini, itBit, LMAX Digital and whichever
  others pass its constituent criteria that year) into one number. It is
  what both event venues **settle** on. So "where will BRTI be at 8 PM" is the only question
  the hourly contract asks, and "where will BRTI be at midnight Dec 31" is the only question
  the year-end contract asks. There is no choice here: the reference for the probability has
  to be the thing the contract pays on.
- **CME Bitcoin futures** are a different instrument: a dated contract on the CME that
  settles on CF Benchmarks' **BRR** (the Bitcoin Reference Rate, a once-a-day 4 PM London
  fix built from the same family of exchanges), not on BRTI. A future trades at spot plus
  carry ("the basis"), typically a few percent annualised in a calm market, more when the
  market is leveraged long. It is what a Chicago desk **hedges with**, because it is
  regulated, margined, and clears where their capital already sits.

So "should we use CME instead?" splits into two answers. For the probability column: no, the
contract settles on BRTI, and the probability has to be of BRTI; using a future would put a
carry term into a question that has none. For the hedge: yes, a desk like Ted's would hold
the delta in CME futures rather than spot, and that is exactly the limit the page states
under "Reference". What a CME desk needs from us is (a) the settlement index and statistic
stated precisely, which the page does, and (b) the basis they would carry, which the page
now shows as a strip above §1: Deribit's December forward over BRTI, simple and annualised.
A Deribit dated future and the CME December future are arbitraged against each other by the
same firms, so that basis is within a handful of basis points of CME's. CME's own quotes are
licensed data, which is why the page does not print them.

The day-to-day difference between BRTI and Deribit's index (the one the options live on) is
a few basis points and random in sign; the hourly model is priced on BRTI directly so that
difference, and the few seconds between reads, do not leak into the near-the-money strikes.

---

## 2. Section 1: "Year-end 2026 curve: Kalshi vs Polymarket US vs options"

### What the contract is

"Bitcoin price at the end of 2026" is sold as 28 buckets, each $5,000 wide
(under $20k, $20–25k, …, $145–150k, $150k or above). Exactly one bucket pays $1 at midnight
ET on Dec 31; the other 27 pay $0. So each bucket's price is the market's probability that
Bitcoin finishes in that band. Kalshi's ticker series is KXBTCY; Polymarket US's event is
`btc-pricerange-yr-12-31-2026`.

### The same contract, almost

Both venues: same 28 bands, same index (BRTI), same instant (midnight ET Dec 31, which is
05:00 UTC Jan 1). The one difference, which the page states: Kalshi takes the **simple
average** of the last 60 one-second BRTI prints; Polymarket US takes the **20% trimmed mean**
of the same 60 (throw out the 12 highest and 12 lowest, average the middle 36). In a quiet
final minute these are identical to the dollar. In a disorderly one they can differ, and the
difference only matters if BRTI is within a few dollars of a $5,000 boundary at that exact
minute. It is a real difference and a reader who knows the rules will look for it; the page
names it so they do not have to.

### Reading one row

Take a row from Nov 8:

| Bucket | Kalshi bid / ask | Polymarket US bid / ask | Option-implied (Deribit smile) | Kalshi − Poly | Kalshi − model | Poly − model | Cross |
| --- | --- | --- | --- | --- | --- | --- | --- |
| $70,000 – $75,000 | 16.9 / 17 | 14 / 15 | 19.0¢ | +2.45¢ | −2.05¢ | −4.50¢ | buy Poly 15¢ → sell Kalshi 16.9¢ · +0.69¢ net · 7.7 ct |

- **Kalshi 16.9 / 17**: you can sell this bucket at 16.9¢ or buy it at 17¢. Kalshi quotes in
  sub-penny dollars (its API returns `0.1690`), and the page keeps the fraction. A 0.1¢-wide
  market is as tight as it gets. The small grey "998 × 45" under a quote is the resting size
  at the best bid and best offer, in contracts.
- **Polymarket US 14 / 15**: whole cents only (its tick is $0.01), so its spreads are 1¢ wide
  at best. That alone accounts for most of the "overround" difference below.
- **Option-implied 19.0¢**: what the listed option market says the probability is (§2.4
  below). Both venues were under it on this bucket, Polymarket US more so.
- **Kalshi − Poly +2.45¢**: Kalshi's mid (16.95) minus Poly's mid (14.5). Positive means Kalshi
  is pricing this outcome as more likely. Across the ladder these gaps were between −1.4¢ and
  +2.5¢ on Nov 8, with Kalshi closer to the option market in the body and Poly closer in the
  tails.
- **Cross**: Polymarket US's offer (15¢) is below Kalshi's bid (16.9¢). Buy on Poly, sell on
  Kalshi, pocket 1.9¢ gross. After Poly's taker fee (0.095 × 0.15 × 0.85 = 1.21¢) and
  Kalshi's (zero on this series), 0.69¢ net. "7.7 ct" is the smaller of the two resting
  sizes, so the whole opportunity is about 5 cents of profit. That is the honest picture:
  the venues do disagree, and the disagreement is worth cents, not dollars.

Where the crosses actually live, from the first evening: the deep wings. Poly's whole-cent
tick means its 1¢ bid on a bucket Kalshi quotes at 0.3/0.4¢ is a standing 0.5–1.0¢ cross,
and those wings carry thousands of contracts of Kalshi depth (for example 110–115k: buy
Kalshi 0.8¢, sell Poly 2¢, +1.01¢ net on 5,166 contracts, about $52). Near-the-money
"crosses" of +2¢ tend to sit on 0.1 contracts of Poly depth and mean nothing; the size is
printed so the reader can tell the two apart. The note under the table ("Executable
crosses: N buckets … total at resting depth $X") totals it.

Below the table, **Sum of mids**: add up all 28 mids. A perfectly fair book sums to 100¢
(exactly one bucket pays). Nov 8: Kalshi 100¢, Polymarket US 117¢, option model 100¢. Poly's
17¢ overround is mostly the mechanical effect of 1¢-wide spreads on 28 buckets (28 × 0.5¢ ≈
14¢), plus a few cents of genuine skew. This is a one-glance quality read on each venue's
market-making.

### The chart above the table

Grouped bars, one group per bucket, three bars per group: Kalshi mid (blue), Polymarket US
mid (purple), option-implied (black). The shape is the market's probability distribution for
year-end Bitcoin. On Nov 8 all three peaked at $75–80k with the mass between $60k and $95k;
the venues and the option market agree on the shape and differ at the edges by 1–2¢.

### Where "option-implied" comes from (§2.4)

Deribit lists Bitcoin options expiring Dec 25, 2026 at 08:00 UTC (the last Friday of
December), the closest listed expiry to the venue settlement. For each strike it publishes
an implied volatility. From that:

1. Build a vol smile: for each strike, take the out-of-the-money option's implied vol (puts
   below the forward, calls above), and connect them in log-strike space; beyond the furthest
   listed strikes, hold the vol flat.
2. Price a call at any strike with Black-76 on Deribit's forward for that expiry.
3. The probability Bitcoin finishes above K is the slope of the call price in K, with the
   sign flipped: P(S > K) = −∂C/∂K. Computed numerically, so the smile's skew is in the
   answer (a flat-vol digital would ignore it).
4. A bucket's probability is P(above lower bound) − P(above upper bound).

Two honest approximations, both stated on the page: the option expiry is 6 days 21 hours
before the venue settlement, so the smile's vol is kept and each bucket's own time to
settlement is used; and zero interest rate (immaterial at this horizon for a probability).

### "One-touch ladders: high and low of the year"

One-touch contracts: pays $1 if BRTI ever trades above (or below) the level before year-end.
Kalshi KXBTCMAXY / KXBTCMINY, Polymarket US `btc-hitprice-high` / `-low`. Both venues use
the trimmed-mean-per-minute rule for these, so they are directly comparable. The
option-implied column for touches is a **model** (the reflection principle: under a
lognormal, the chance of touching a barrier is roughly twice the chance of finishing beyond
it, adjusted for drift), not something read off a market. The page says "treat as
indicative" and means it.

### "Polymarket US only"

Polymarket US lists a few extra ladders Kalshi does not have as the same contract (for
example, "When will Bitcoin hit $150k" settling Dec 1). They are shown with their own
settlement date and no cross-venue column.

---

## 3. Section 2: "Hourly ladder vs options"

Kalshi's KXBTCD series: "Bitcoin above $X at the top of the hour", 120 strikes $100 apart
(the 5 PM ET daily contract in the same series has 80 strikes $250 apart), settling every
hour on the simple 60-second BRTI average. This is the contract a
desk would actually trade intraday, and it is where the option model gets a hard test:
there is no option expiring at the top of the hour, so the smile from the nearest Deribit
expiry (tomorrow 08:00 UTC) is used with the hour's own time to run.

### The vol strip (the most important numbers on the page)

Above the table, three volatilities for the same hour and the minutes left:

- **Kalshi ladder implied vol 72%.** Fit a lognormal (a centre price and a σ) to the
  ladder's two-sided mids. The fit misses by about 1¢ rms, so the ladder really is one clean
  lognormal; the centre (printed next to it) is where Kalshi's makers think spot is.
- **Deribit ATM IV 45%.** Deribit's mark IV at spot for the expiry nearest the hour
  (tomorrow 08:00 UTC).
- **BRTI realised vol, 1h 62%.** The standard deviation of BRTI's one-minute returns over
  the last 60 minutes, annualised.
- **Closes in N min.**

Those were the readings at 6:55 PM on Nov 8. Later the same evening the strip read 47% vs
38% with five minutes left, and 34% vs 34% with half an hour left. The premium Kalshi
charges over the listed market is not a constant; it moves within an hour and from hour to
hour. The gap column under the strip ("Kalshi − model", −8¢ on strikes under spot and +13¢
on strikes over it when the premium is large) is that vol difference expressed per strike,
not a model error. A writer who sells the hourly ladder at Kalshi's price and hedges at the
listed vol is collecting that premium; a buyer is paying it.

### The table under the ladder: "Ladder vol minus listed vol, by time to close, over the window"

Because the premium moves, one reading is not enough. Every minute the collector stores the
three vols with the minutes to close, and this table groups them: 45–90 min, 30–45, 15–30,
5–15, 2–5. For each band: mean Kalshi ladder IV, mean Deribit ATM IV, the premium (ladder
minus listed, in vol points) as mean and min / max, mean realised, and how many readings over
how many distinct hours. Coloured amber past 5 points, red past 10.

How to read it: if the premium is positive and grows as the close approaches, Kalshi's
makers widen into the last minutes and the writer's edge is concentrated there (and so is
the pin risk in §5). If it is flat, the premium is a per-hour fee rather than a close effect.
If it goes negative, the venue is under-pricing the hour against the options market. This
table started filling at 10:36 PM ET on Nov 8 (the earlier snapshots do not carry the
reading), so by the morning of Nov 9 it holds about ten hours. It is the one thing on the
page nobody else publishes, and it is where to start a walkthrough with a trader.

The hourly rows themselves now print depth under each quote (the resting contracts at the
best bid and offer). On the first evening the at-the-money strikes carried a few hundred to a
couple of thousand contracts a side, which is what decides whether the premium is collectible
in size.

Two model details, both already in the deployed version (they are described here so you
know they exist, not because anything is pending):

- **The near-close step cap.** The digital probability is a numerical derivative, and minutes
  before a close the digital is nearly a step. The difference step is capped at a fifth of a
  standard deviation of the remaining move so the quotient does not smear it. Before the cap,
  a digital $101 in the money with four minutes left read 71% instead of the correct 76%; a
  test now pins it within one point of the closed form.
- **The hourly is priced on BRTI, not on Deribit's forward.** For the year-end buckets the
  model uses Deribit's own forward for the expiry, because it carries the term basis the
  market is paying (shown as a strip above §1). For anything settling within a day, the carry
  is under a basis point and the contract settles on BRTI, so the model uses the BRTI reading
  itself and takes only the vol from the smile. Deribit's forward is read a few seconds apart
  from BRTI and wandered ±5 bps (about $40) around it from cycle to cycle; at five minutes to
  the close, $40 is several points of probability on the at-the-money strike. The hedge
  replay's delta uses the same spot it marks P&L in, for the same reason.

Three housekeeping points the page handles:

- The KXBTCD series also lists **tomorrow's 5 PM ET** contract a day ahead. The page only
  treats an event closing within 90 minutes as "the hourly ladder", so that 22-hour contract
  never stands in for the hour. (§6 quotes on it instead; see that section.)
- Rows with a mid under 1.5¢ or over 98.5¢ are hidden (far-out-of-the-money noise).
- Venue books, the option chain and the index are read in one cycle but not at one instant.
  BTC moves $30–60 in a typical minute; that alone is a few points on an hourly strike near
  the money in its last minutes. The page says so under "Timing" in the notes. Single-row
  gaps inside that band are noise; the vol strip and the replay averages are what survive it.

Polymarket US has documented hourly/daily/weekly BTC ladders, but as of Nov 2026 they are
in its preprod environment only. The reader will pick them up automatically when they reach
production; the note under the table says so.

---

## 4. Section 3: gaps over time

Per year-end bucket, a sparkline of (Kalshi mid − Poly mid) at every snapshot in the window,
with mean |gap|, max |gap|, and the latest value. The point of the sparkline shape:

- **A flat line away from zero** = a persistent quoting difference. One venue's makers
  simply price the bucket differently. That is a real, slow-moving opportunity or a real
  disagreement.
- **A line that flickers around zero** = latency. The venues are updating at different
  moments and the "gap" is which one has moved first. Not tradable without being fast.

On day one these are a few dozen points. After a week they are the most interesting section
for someone who builds execution systems, because the difference between those two shapes is
exactly the difference between a pricing business and a latency business.

---

## 5. Section 4: "Cost of latency"

Two tables (hourly contract, year-end contract), four rows each (1s, 5s, 15s, 60s). Columns:
"Late by", "Index move, median", "Index move, p90", "Max in window", "$1 ATM digital, median
/ p90".

From the last hour of one-second BRTI prints: how far did the index move over each horizon?
Median, 90th percentile, worst. Then: what is that move worth on a $1 at-the-money contract?

The conversion uses the option-implied **digital delta**: how much the probability of
finishing above the strike changes per $1 of spot. For an hourly contract with spot at the
strike and an hour to run, that delta is large (the outcome is a coin flip that a $50 move
tips). For the year-end contract it is tiny (a $50 move is nothing over 7 weeks).

Nov 8 late evening, median moves: 1s 0.06 bps, 5s 0.28 bps, 15s 0.83 bps, 60s 2.85 bps. On
the hourly contract that is 0.06¢, 0.30¢, 0.89¢, 3.05¢ (p90: 0.15¢, 0.71¢, 2.05¢, 7.3¢); on
year-end, 0¢, 0.01¢, 0.02¢, 0.08¢.

How to read it: on the hourly ladder, being a minute late costs more than most of the
cross-venue gaps are worth, so hourly-ladder arbitrage is an execution-speed business. On the
year-end ladder, latency is irrelevant and the gaps are about pricing. The page states that
this measures the **index**, not any venue's matching engine or API path.

---

## 6. Section 5: "Static vs dynamic hedge, per hourly contract"

This is the section a hedging-infrastructure person will spend the most time on.

### The experiment

Every hour, when Kalshi lists the next hourly ladder (with between 20 minutes and 2 hours to
run), the page "sells" one $1 contract at the strike nearest spot, at Kalshi's mid. It does
not trade; it records the price and then follows the position to settlement three ways,
using the same minute-by-minute snapshots:

1. **Naked**: keep the premium, pay $1 if the contract finishes in the money. Outcome =
   premium − payout. Over many coin flips at ~50¢ this averages near zero with huge variance
   (you either keep 50¢ or lose 50¢).
2. **Static spread**: at the moment of sale, buy a call spread on Deribit that brackets the
   strike (the nearest listed strikes $500 apart on either side), sized so it pays $1 above
   the top strike. Pay the offer. Hold. At the close, sell it back at the bid (the option
   does not expire at the top of the hour, so it is sold, not exercised). Outcome = premium
   − payout + (what the spread sold for − what it cost).
3. **Dynamic delta**: at the moment of sale, compute the option-implied digital delta and
   buy that much Bitcoin exposure. Every minute, recompute and rebalance, paying 2 basis
   points of whatever notional was traded. At the close, flatten. Outcome = premium − payout
   + hedge P&L − fees.

Settlement is the simple 60-second BRTI average Kalshi uses, computed from the same
one-second prints.

### The KPI tiles

- **Contracts settled · N in flight**: sample size. Needs to be in the double digits before
  the means mean anything.
- **Naked / Static spread / Dynamic delta, mean P&L**: average per $1 contract. Negative is
  a loss to the writer. Naked is noisy around zero.
- **mean entry cost** (under static): what the call spread cost on average.
- **mean fees** (under dynamic): the 2 bps turnover charge on average. Near the close a
  digital's delta spikes if spot is near the strike (a "pin"), the replay keeps rebalancing
  into it, and fees jump. A real desk would stop or widen there. The page says so in Notes.
- **p90 |P&L − premium|**: for each method, how far the final outcome landed from "just
  kept the premium", at the 90th percentile. This is the risk number. Naked is ~$1 on a
  near-50¢ contract (you pay out the whole dollar one time in two).

### What the first hours actually showed, and how to read it

Three settled hours on Nov 8 (local collector, same code): static spread entry cost 54–61¢
per $1 digital; dynamic fees 17–26¢ per $1 on $850–1,300 of turnover across 57–59
rebalances. Both hedges came out worse than naked over those three hours (naked −18¢ mean,
static −36¢, dynamic −35¢), and the dynamic p90 stray was 85¢ against naked's $1.

Do not read that as "the hedging doesn't work". Read it as the price of hedging one hourly
digital in isolation with listed instruments: Deribit's near-expiry bid/ask on a $500 spread
is 15–30% of its width, and a one-minute delta hedge on a one-hour digital turns over 10–25×
the hedge notional, so 2 bps becomes 20¢. A desk does not pay those per contract; it nets
delta across strikes and hours and pays them once on the net. The sentence above the tiles
says so ("Per-contract hedging is the worst case; a book nets delta across strikes and
hours"). The connection to make for a trader: the premium in §2 is what Kalshi's makers
charge to carry exactly these costs. §2 is the revenue line, §5 is the cost line, and a book
is what turns the gross into a net.

Expect the tiles to look harsh for the first day or two. Say it before he does.

### The table

Columns: Close, Strike, Sold at (with minutes to close when the position was opened),
Settled, Payout, Naked, Static (with entry cost), Dynamic (with fees and rebalances). One row
per settled hour, most recent first.

A sanity check you can do by hand on any row: if Settled ≥ Strike, Payout is $1 and Naked is
(Sold at − 100¢); otherwise Payout is $0 and Naked equals Sold at.

### What it shows and does not show

It shows, on real contracts at real prices, the trade-off a desk lives with: a static hedge
costs a known amount up front and leaves tracking error because the hedge instrument is a
$500-wide ramp rather than a step; a dynamic hedge is cheaper on average but its cost is
path-dependent and blows up near a pin.

Three things it leaves out, all stated on the page under "Notes and limits". Showing them is
the right call: each is a question a desk would ask within the first minute, and each has a
size you can put on it.

1. **CME basis is not carried.** The dynamic leg is marked against spot BRTI. A desk would
   hold the delta in CME futures (or micros) and the futures-minus-spot basis moves around
   inside the hour. How much it matters: the delta notional on an hourly $1 digital is about
   $50 one hour out and $150 with ten minutes left, so a 5 bp basis move is 2–7¢ of extra
   tracking error on that leg. It is zero-mean (it does not bias the average), but it would
   widen the p90 stray a little. Why it is not on the page: CME market data is licensed, not
   public, so the service cannot read it; Deribit's dated future stands in for the term basis
   you see above §1.
2. **Deribit's inverse settlement is approximated.** Deribit options are priced and paid in
   BTC. The replay converts to dollars at spot each snapshot. The exact treatment carries a
   second-order term, roughly (premium in BTC) × (dollar move); on a spread worth a few
   hundred dollars of notional per $1 digital that term is well under a cent.
3. **The spread's unwind is up to ~2½ minutes after the close.** The delta leg is flattened
   at the settlement value itself (exact). The static spread is sold back at Deribit's quotes
   on the first snapshot after settlement (90-second grace plus up to one 60-second cycle),
   so its unwind includes that much post-close drift, again zero-mean. Fix available if asked:
   interpolate Deribit's marks to the settlement instant.

None of these changes the direction of any finding; all three widen the error bars on §5
by a few cents. That is what "first pass" should mean to a careful reader: the shortcuts
are named, bounded and symmetric.

---

## 7. Section 6: "Lock in on the daily ladder"

Our product, quoted on Kalshi's 5 PM ET daily strikes, from the **holder's** side.

### Why most rows refuse, and the tenor

On the first evening 1 strike in 16 quoted; the rest said "refused: live option books cannot
fund a positive credit on any quotable floor/cap". The pricer is doing its job. A collar is
funded by the upside the holder gives up (everything above the cap) and spends that on the
floor, which is a put spread bought leg for leg off OKX books, plus the exchange fee on each
spread, plus a 5% haircut because the option legs expire after the contract closes, plus the
writer's margin. It searches a grid of floors and caps and quotes the best pair that leaves a
positive credit; when no pair does, it refuses. Away from the money the floor protection costs
about what it protects, so nothing clears. Near the money the contract has real optionality to
give up, and that is where the one quote appears.

Tenor was the first suspect and it was tested on Nov 8. Section 6 now quotes on Kalshi's
5 PM ET daily contract (same KXBTCD series, 80 strikes $250 apart; the contract the hourly
selector has to exclude), with the hourly only as a fallback when no daily is listed. On the
daily the legs expire 10 hours after a 20-hour contract instead of hours after a one-hour one,
so the haircut is honest rather than generous. It quoted the same way: one strike, at the
money. So the tenor was the right change (a collar on an hourly was never the product) but it
is not what drives the refusals; the cost of the floor against the value of the upside is.
Three honest ways to read that for Ted:

- Refusals are the pricer declining to write a collar that loses the writer money at the
  sizes shown. That is the opposite of a formula that always says yes.
- The economics work where the contract is worth hedging, which is near the money. The page
  quotes 100 contracts; the legs are walked through the book at that size.
- The lever that would open more strikes is on the cost side (which venue hedges the legs,
  the fee per spread, the haircut), not on the tenor. That is a build conversation, not a
  page setting.

The sentence to have ready: "it refuses when the legs cost more than the upside can fund
after fees; on these contracts that is most strikes away from the money, and the one it
quotes is the one that matters."

What the page says in the heading and the line under it: "Lock in on the daily ladder",
then "Daily close Nov 9, 5:00 PM ET · hedge legs: listed BTC option books · per $1 contract,
100 contracts". If no daily is listed the heading reads "hourly" and the current hour is
used.

- **Floor**: the least they will end up with even if the contract goes to zero.
- **Cap**: the most they will end up with even if the contract pays $1.
- **Credit to holder**: cents paid to them at settlement for accepting the cap.
- **Upside given up**: 100¢ − cap. The give-up, stated as a number, not hidden.
- **Hedge expiry**: the listed option expiry the floor and cap are built from, and whether
  it is aligned with the close (rarely) or "unwound at close" (usually).

Behind each row, the pricer buys and sells the two listed puts that bracket the strike on
OKX's public option books, leg for leg at the sizes shown, for 100 contracts. If the books
are too thin, or the strike's mark is outside the quotable band (10¢–92¢), or the hour is
too close, the row says **refused** with the reason. Showing refusals is deliberate: it says
the quotes are built from real depth, not from a formula.

What is **not** on the page: the writer's take and the hedge-leg cost. They exist in the
system (`BTC_CURVE_SHOW_TAKE=1` reveals them) and are left off for the reader on purpose.
What a sharp reader can infer: because floor, cap, credit and the option books are all
visible, they could reconstruct roughly what the legs cost and therefore roughly what the
writer keeps. That is acceptable; it is the same inference anyone can make about any
structured product, and it is not the same as handing over the formula or the rate.

---

## 8. Notes and limits (the section before the footer)

This is the "we know" list. Each item is a question a careful reader would otherwise ask:

| Note | The question it pre-empts |
| --- | --- |
| Sub-penny kept; whole-cent Poly; mids need two sides; depth is best level only | "Are you rounding?" "Is the depth the whole book?" |
| Taker fees only, unrounded; Kalshi rounds up, Poly to nearest; Poly's 0.095 is its Tier 1, Tier 4 is 0.0695 (0.64¢ narrower at 50¢); rebates ignored | "A desk pays less than retail, so your crosses understate." Correct, and quantified. |
| Smile construction; 6d 21h expiry gap; touches are a model | "Which vol did you use and how did you bridge the expiry?" |
| Model: year-end on Deribit's forward (basis strip above §1), within-a-day on the BRTI reading itself | "Which forward are you on, and does the hourly see the same price Kalshi does?" |
| Timing: books, chain and index read in one cycle, not one instant; $30–60 per minute of BTC | "Is a single hourly row gap real?" Not inside that band. |
| Replay: 20 min–2 h horizon; delta flattened at the settlement value, spread unwound up to 2½ min late; $500 strike spacing; no rebalance cap; inverse term dropped | "Is the dynamic cost realistic near a pin?" No, it is pessimistic, and says so. |
| Spot BRTI, not CME; CME data is licensed; 5 bp of basis is 2–7¢ of tracking error on the dynamic leg | "Where's the basis?" Sized, zero-mean, not in §5. |
| Latency measures the index, not a venue's path | "Is this your round-trip time?" No. |

---

## 9. Footer

**Sources**: the exact public endpoints. **Health this cycle**: each source's response time
or its error. Each source has 45 seconds per cycle; a source that does not answer is marked
down for that minute and the cycle goes on without it (one Polymarket US read hung for 14
minutes on Nov 8 before this guard existed, and stalled everything). If a source is down the
page says so in red here and keeps serving the rest. **Read-only**: there are no credentials
on the machine; the service cannot place an order or see an account. That is a design
property, not a policy.

---

## 10. Things to know cold before the walkthrough

1. **Same contract?** Same bands, same index, same instant; Kalshi simple average vs Poly
   trimmed mean of the same 60 seconds. One-touch rules match on both.
2. **Why is the hourly ladder off the model?** Because Kalshi prices the hour at a vol of
   its own, which on Nov 8 ranged from the listed vol to 1.6× it. The strip shows the
   current reading, the table under the ladder shows it by time to close over the window. It
   is a premium, and §5 is the running tally of what hedging it at the listed vol earns or
   costs.
3. **Why Deribit for fair value and OKX for the hedge?** Deribit has the deepest listed BTC
   vol surface, so it is the best fair-value reference. OKX is where our existing pricer
   already reads executable books leg by leg. Both are public reads.
4. **Why is Poly's sum 117¢?** 1¢ ticks on 28 buckets. It is a market-structure fact, not a
   mispricing, and it is why the cross column is mostly Poly-offer against Kalshi-bid.
5. **Why are the crosses so small?** Because the venues are efficient to within fees, which
   is the finding. Cents per contract, single-digit dollars at the resting depth.
6. **What would change with CME as the reference?** Nothing in §1–§4, which compare venues
   to each other and to the listed smile. In §5 the dynamic leg would pick up basis noise
   worth a few cents of tracking error and a desk's real financing; §6 would price the floor
   and cap off futures-settled options instead of Deribit/OKX's BTC-settled ones. The term
   basis itself is already on the page (the strip above §1): Deribit's December forward over
   BRTI, simple and annualised, which is the number a CME desk would compare with the
   December future.
7. **How long has it been collecting?** The strip says. Be upfront that §3, the §2 premium
   table and §5 are young, and that the §5 tiles will look harsh until the sample grows (and
   why: per-contract costs, not a book).
9. **Why does §6 mostly refuse?** Because away from the money the floor (a put spread off
   live books, plus fees, haircut and margin) costs more than the upside given up can fund;
   the pricer refuses rather than quoting a loser. It quotes the daily contract now (the
   right tenor; tested, same result), and the one strike it quotes is the at-the-money one.
8. **Is any of this trading?** No. The service has no keys. It can be audited as such.

## 11. What stays off the table

The page shows outputs. It does not show: the take rate or partner economics, any venue
relationship or conversation, any partner's volumes or timelines, the pricing formulas as
numbers, investor names, or the browser extension. If asked for the formula, the honest
answer is "it is a leg-for-leg replication on listed books with a spread on top; the spread
is ours."

---

## 12. Glossary

- **BRTI**: CF Benchmarks Bitcoin Real-Time Index, the once-a-second settlement index.
- **Bucket / strike / ladder**: one contract / its threshold / the full set at one settlement.
- **Mid**: (bid + ask) / 2.
- **Overround**: the amount a set of mutually exclusive mids sums to above 100¢.
- **Taker fee Θ·p·(1−p)**: fee per contract that is largest at 50¢ and vanishes at 0¢ / 100¢.
- **Smile**: implied volatility as a function of strike for one expiry.
- **Digital**: a contract that pays a fixed amount above (or below) a level. Every bucket is one.
- **Digital delta**: how much a digital's probability moves per $1 of spot. Large near the
  strike and near expiry, which is the whole difficulty of hedging these.
- **Static hedge**: buy once, hold, sell at the end. **Dynamic hedge**: adjust continuously.
- **Pin**: spot sitting on the strike into the close; delta becomes unstable.
- **Reflection principle**: the lognormal result that touch probability ≈ 2 × finish-beyond
  probability, adjusted for drift.
- **Collar**: floor plus cap; the holder gives up the top to protect the bottom.
