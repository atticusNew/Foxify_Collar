# BTC curve report: study guide

A plain-language walk through every number on the page, in the order it appears, with the
real-world meaning, how it is computed, what it looked like on the first live day
(Nov 8, 2026), and the questions a trading-systems person will ask about it. Companion to
`docs/btc-curve-report.md`, which is the technical spec.

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
| **settlement index of both venues** | Confirms both venues use the same index. | They do, but with different averaging (see §1 below). |
| **as of 6:55 PM ET · refreshes every 60s** | The timestamp of the snapshot you are looking at. | The page is a live read, not a report from last week. |
| **window 56 snapshots · collecting since …** | How many one-minute observations the time-series sections (§3, §5) have to work with. | On day one this is small. The gaps and hedge sections become meaningful after a day. |

Where the index comes from: Polymarket US republishes BRTI one-second candles on its public
price-history endpoint, and that is what the page reads. On Nov 8 it sat $20 from Deribit's
own BTC index at the same second, which is normal (different constituent exchanges).

---

## 2. Section 1: the curve

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

| Bucket | Kalshi bid / ask | Polymarket US bid / ask | Option-implied | Kalshi − Poly | Kalshi − model | Poly − model | Cross |
| --- | --- | --- | --- | --- | --- | --- | --- |
| $70,000 – $75,000 | 16.9 / 17 | 14 / 15 | 19.0¢ | +2.45¢ | −2.05¢ | −4.50¢ | buy Poly 15¢ → sell Kalshi 16.9¢ · +0.69¢ net · 7.7 ct |

- **Kalshi 16.9 / 17**: you can sell this bucket at 16.9¢ or buy it at 17¢. Kalshi quotes in
  sub-penny dollars (its API returns `0.1690`), and the page keeps the fraction. A 0.1¢-wide
  market is as tight as it gets.
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

### "How high this year" / "how low this year"

One-touch contracts: pays $1 if BRTI ever trades above (or below) the level before year-end.
Kalshi KXBTCMAXY / KXBTCMINY, Polymarket US `btc-hitprice-high` / `-low`. Both venues use
the trimmed-mean-per-minute rule for these, so they are directly comparable. The
option-implied column for touches is a **model** (the reflection principle: under a
lognormal, the chance of touching a barrier is roughly twice the chance of finishing beyond
it, adjusted for drift), not something read off a market. The page says "treat as
indicative" and means it.

### "Listed on Polymarket US only"

Polymarket US lists a few extra ladders Kalshi does not have as the same contract (for
example, "When will Bitcoin hit $150k" settling Dec 1). They are shown with their own
settlement date and no cross-venue column.

---

## 3. Section 2: the hourly ladder

Kalshi's KXBTCD series: "Bitcoin above $X at the top of the hour", 120 strikes $100 apart
(the 5 PM ET daily contract in the same series has 80 strikes $250 apart), settling every
hour on the simple 60-second BRTI average. This is the contract a
desk would actually trade intraday, and it is where the option model gets a hard test:
there is no option expiring at the top of the hour, so the smile from the nearest Deribit
expiry (tomorrow 08:00 UTC) is used with the hour's own time to run.

Nov 8: across 23 two-sided strikes, Kalshi's mid was on average 0.13¢ from the model and
never more than 3.2¢ away. That is the single most reassuring number on the page for an
options person: the retail hourly ladder is priced consistently with the listed vol
surface.

Two housekeeping points the page handles:

- The KXBTCD series also lists **tomorrow's 5 PM ET** contract a day ahead. The page only
  treats an event closing within 90 minutes as "the hourly ladder", so that 22-hour contract
  never stands in for the hour.
- Rows with a mid under 1.5¢ or over 98.5¢ are hidden (far-out-of-the-money noise).

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

## 5. Section 4: what being late costs

Two tables (hourly contract, year-end contract), four rows each (1s, 5s, 15s, 60s).

From the last hour of one-second BRTI prints: how far did the index move over each horizon?
Median, 90th percentile, worst. Then: what is that move worth on a $1 at-the-money contract?

The conversion uses the option-implied **digital delta**: how much the probability of
finishing above the strike changes per $1 of spot. For an hourly contract with spot at the
strike and an hour to run, that delta is large (the outcome is a coin flip that a $50 move
tips). For the year-end contract it is tiny (a $50 move is nothing over 7 weeks).

Nov 8, median moves: 1s 0.08 bps, 5s 0.42 bps, 15s 1.2 bps, 60s 4.0 bps. On the hourly
contract that is 0.02¢, 0.08¢, 0.21¢, 0.71¢; on year-end, 0¢, 0.01¢, 0.03¢, 0.11¢.

How to read it: on the hourly ladder, being a minute late costs more than most of the
cross-venue gaps are worth, so hourly-ladder arbitrage is an execution-speed business. On the
year-end ladder, latency is irrelevant and the gaps are about pricing. The page states that
this measures the **index**, not any venue's matching engine or API path.

---

## 6. Section 5: static vs dynamic hedge

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

- **contracts replayed · N in flight**: sample size. Needs to be in the double digits before
  the means mean anything.
- **mean outcome, naked / static / dynamic**: average per $1 sold. Negative is a loss to the
  writer. Expect naked to be noisy around zero, static to be slightly negative (you pay the
  spread's bid-ask twice), dynamic to be slightly negative (fees) with a smaller spread of
  outcomes.
- **up-front cost** (under static): what the call spread cost on average. This is the price
  of certainty.
- **fees paid** (under dynamic): the 2 bps turnover charge on average. Watch this: near the
  close, a digital's delta spikes if spot is near the strike (a "pin"), the replay keeps
  rebalancing into it, and fees jump. A real desk would stop or widen there. The page says so
  in Notes.
- **p90 stray from premium**: for each method, how far the final outcome landed from "just
  kept the premium", at the 90th percentile. This is the risk number. Naked will be ~50¢
  (you lose the whole thing one time in two). The hedged versions should be a few cents.
  The ratio between them is the argument for hedging infrastructure in one number.

### The table

One row per settled hour: close time, strike, what it sold for and how many minutes before
the close the position was opened, the settlement value, whether it paid, and the three
outcomes. Under Static, the spread's entry cost; under Dynamic, fees paid and the number of
rebalances.

A sanity check you can do by hand on any row: if Settled ≥ Strike, Paid should be $1 and
Naked should be (Sold at − 100¢); otherwise Paid is $0 and Naked equals Sold at.

### What it shows and does not show

It shows, on real contracts at real prices, the trade-off a desk lives with: a static hedge
costs a known amount up front and leaves tracking error because the hedge instrument is a
$500-wide ramp rather than a step; a dynamic hedge is cheaper on average but its cost is
path-dependent and blows up near a pin. It does **not** model CME basis (it hedges to spot
BRTI), does not model Deribit's inverse-settlement nuance beyond converting BTC-denominated
prices at spot, and takes the first snapshot after the close (up to ~2½ minutes late) for
the unwind.

---

## 7. Section 6: Lock in along the ladder

Our product, quoted on the same hourly strikes, from the **holder's** side.

A holder owns a Kalshi "above $X" contract currently worth, say, 45¢. Lock in offers them:

- **Floor**: the least they will end up with even if the contract goes to zero.
- **Cap**: the most they will end up with even if the contract pays $1.
- **Credit to holder**: cents paid to them at settlement for accepting the cap.
- **Upside given up**: 100¢ − cap. The give-up, stated as a number, not hidden.
- **Hedge expiry**: the listed option expiry the floor and cap are built from, and whether
  it is aligned with the hour (rarely) or unwound at the close (usually).

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
| Replay: 20 min–2 h horizon, unwind up to 2½ min late, $500 strike spacing, no rebalance cap | "Is the dynamic cost realistic near a pin?" No, it is pessimistic, and says so. |
| Spot BRTI, not CME | "Where's the basis?" Deferred to the production version, affects §5–§6 only. |
| Latency measures the index, not a venue's path | "Is this your round-trip time?" No. |

---

## 9. Footer

**Sources**: the exact public endpoints. **Health this cycle**: each source's response time
or its error. If Polymarket US is slow or down, that line says so and the page keeps serving
the last good snapshot. **Read-only**: there are no credentials on the machine; the service
cannot place an order or see an account. That is a design property, not a policy.

---

## 10. Things to know cold before the walkthrough

1. **Same contract?** Same bands, same index, same instant; Kalshi simple average vs Poly
   trimmed mean of the same 60 seconds. One-touch rules match on both.
2. **Why Deribit for fair value and OKX for the hedge?** Deribit has the deepest listed BTC
   vol surface, so it is the best fair-value reference. OKX is where our existing pricer
   already reads executable books leg by leg. Both are public reads.
3. **Why is Poly's sum 117¢?** 1¢ ticks on 28 buckets. It is a market-structure fact, not a
   mispricing, and it is why the cross column is mostly Poly-offer against Kalshi-bid.
4. **Why are the crosses so small?** Because the venues are efficient to within fees, which
   is the finding. Cents per contract, single-digit dollars at the resting depth.
5. **What would change with CME as the reference?** §5 and §6 numbers (basis and carry);
   nothing in §1–§4.
6. **How long has it been collecting?** The strip says. Be upfront that §3 and §5 are
   young.
7. **Is any of this trading?** No. The service has no keys. It can be audited as such.

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
