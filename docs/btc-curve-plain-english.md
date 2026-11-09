# The BTC curve page, in plain English

A companion to `btc-curve-study-guide.md`. That one explains every number. This one explains
what each part of the page *is*, the way you would say it across a table, with one real-world
picture per idea and the one sentence to say if someone asks. Read this first; go to the study
guide when you want the mechanics.

---

## The whole page in one breath

Two regulated venues sell the same bet on where Bitcoin ends the year. We read both order
books every minute, line them up bucket by bucket, and put next to them what the options
market thinks the same odds are. Then we show how far apart the three are, what one second
of lateness costs, and what actually happens when you sell one of these bets and hedge it two
different ways. Nothing on the page trades. It only reads.

---

## Strip at the top: the scoreboard

**What it is.** The price of Bitcoin right now according to the index both venues pay out on,
the time of the snapshot you are looking at, and how long we have been collecting.

**Picture.** The clock and the scoreboard at a game. Everything below refers to this moment.

**If asked "why this price and not Coinbase's?"** Because the contracts don't pay on
Coinbase. They pay on BRTI, a once-a-second blend of several exchanges. If you hedge against
anything else you own the difference.

---

## Section 1: the curve

**What it is.** Bitcoin's year-end price chopped into 28 bands, $5,000 wide. Exactly one band
wins. Each band's price is the market's probability it wins. Kalshi's price, Polymarket US's
price, and the options market's implied probability for the same band, side by side.

**Picture.** Three bookmakers posting odds on the same horse race. Two of them (Kalshi,
Polymarket US) are the venues; the third (Deribit options) is the deep professional market
that has traded Bitcoin odds for years. If the two venues agree with the pro market, they're
priced fairly. If one is off, there's a trade.

**The line above the table (Deribit forward vs BRTI).** The options market's expected
Bitcoin price for late December, compared to the price today. The difference is "the basis":
what the market charges to be long until then. It's there because the professional reader
will want to know which forward we priced the year-end bands on, and because it's the number
a CME desk compares with their own December future.

**The chart.** The same three probability curves as bars. The hump is where the market thinks
Bitcoin will end up; the tails are the long shots.

**The "Sum of mids" row.** Add up all 28 bands. If the market were perfectly fair the total is
exactly 100¢ (one band must win). Kalshi sums to about 100¢; Polymarket US to about 117¢.
That 17¢ is not a mispricing to pounce on, it's the cost of quoting in whole cents on 28 bands
when most are worth a cent or less. It tells you Poly's wings are expensive to buy and
reasonable to sell.

**The "Cross" column.** Where you could buy a band on one venue and sell the same band on
the other for more, after both venues' fees, at the size actually resting in the books. These
are a few cents on a few hundred dollars. That's the finding: the two venues are efficient
to within fees. A big number here would mean something was wrong.

**Fees.** Kalshi's year-end bands are fee-free. Everything else charges a fee that's biggest
at 50¢ and shrinks toward 0¢ and 100¢. We use the published retail rate and say so; a
high-volume firm pays less (the note gives the lower tier and how much it would narrow a cross).

**If asked "same contract?"** Same bands, same index, same instant. One footnote: Kalshi
averages the last 60 seconds plainly; Polymarket US throws out the top and bottom 20% first.
In a quiet final minute they're identical. We state it so no one has to find it.

**"How high / how low this year."** Separate bands for "does Bitcoin *touch* $X at any
point", not "does it *finish* there". Touching is roughly twice as likely as finishing
beyond. The model for those is a formula, not a market read, and the page says so.

---

## Section 2: the hourly ladder

**What it is.** Kalshi also sells "will Bitcoin be above $X at the top of the hour", a new
ladder every hour, strikes $100 apart. The page shows the current hour's ladder against the
options model.

**Picture.** The year-end market is a season-long bet. The hourly is a bet on the next
play. Same underlying, totally different speed.

**The four numbers above the table (the vol strip).** This is the heart of the pricing story.

- *Kalshi's ladder is priced at ~X% vol.* Back out, from Kalshi's own prices, how wild they
  think the next hour is.
- *Listed options at the money: ~Y%.* How wild the professional options market says the
  same period is.
- *Index realised, last hour: ~Z%.* How wild it actually was over the past hour.

When X is well above Y, Kalshi's buyers are paying a premium over the pro market for the
same hour. That premium is what a writer who sells on Kalshi and hedges in the options
market collects. When Z is between them, the writer is being paid fairly for the risk.

**If asked "why is the hourly so far from your model?"** Because Kalshi prices the hour at a
higher vol than the options market does. The strip shows both. It's a premium, not a model
error, and Section 5 is the running tally of what collecting it earns or costs.

**Fine print that matters here.** Near the top of the hour, with a few minutes left, a $40
move in Bitcoin swings an at-the-money strike by several points. Our reads of the book and
the index are a few seconds apart, so single-row differences in the last minutes are inside
the noise. The page says this under "Timing" in the notes.

---

## Section 3: gaps over time

**What it is.** The Kalshi-minus-Poly and venue-minus-model differences for the main bands,
tracked over time.

**Picture.** A heart-rate chart. A healthy market shows small noise around zero. A persistent
offset is a venue that's slow or thin. A spike that reverts is a one-off.

**On day one it is thin.** Say so. It fills in as the collector runs.

---

## Section 4: what being late costs

**What it is.** How far the settlement index moved in 1, 5, 15 and 60 seconds over the past
hour, and what that move is worth in cents on a $1 at-the-money contract, separately for an
hourly contract and a year-end one.

**Picture.** You're standing at a counter buying a ticket at a posted price. How much does the
price move while you reach for your wallet? On a year-end bet, almost nothing: a 60-second
Bitcoin wobble barely changes the odds of ending the year in a $5,000 band. On the hourly,
the same wobble is worth several cents.

**If asked "is this your system's latency?"** No. It's how fast the *index* moves. It says
what being any amount late costs on each contract, so you can judge what speed is worth
paying for and where.

---

## Section 5: static vs dynamic hedge

**What it is.** Every hour, the page pretends to sell one $1 at-the-money hourly contract at
Kalshi's price and then protects itself two ways using the actual option prices at the time.
After the hour settles it shows what each way made or lost, per $1 sold.

**Picture.** You've promised to pay a friend $1 if it rains at 8 PM, and he paid you 50¢ for
the promise. Two ways to cover yourself:

- *Static*: buy an umbrella now (a listed call spread around the strike). You know the cost
  up front and you're done. But the umbrella isn't a perfect match for the promise: Deribit's
  strikes are $500 apart, so the cover is a ramp, not a cliff. Some tracking error.
- *Dynamic*: don't buy anything up front; instead keep adjusting a position in Bitcoin itself
  every minute as the odds change. Cheaper on average, but you pay a small fee on every
  adjustment, and if Bitcoin sits right on the strike as the hour ends, the adjustments get
  violent and expensive.
- *Naked* is the third column: do nothing and hope. Over many hours it shows the raw edge in
  selling at Kalshi's price.

**The tiles.** How many hours have been replayed; the average outcome per $1 for each way;
and the "p90 stray", which is how far from the premium the result landed on a bad hour. A
small stray is a hedge that worked. A big stray is a hedge that didn't.

**Sanity check you can do live.** If "Settled" is at or above "Strike", "Paid" is $1 and
"Naked" is sold-price minus 100¢. Otherwise "Paid" is $0 and "Naked" equals the sold price.

**What's left out, and how big each is.** The page lists these under "Hedge replay" and
"Reference". Three items: it hedges against spot, not CME futures (a few cents of extra
noise on the dynamic leg if you held futures instead, zero on average); Deribit options are
paid in Bitcoin, not dollars, and the replay converts at spot (a fraction of a cent); the
umbrella is sold back up to two and a half minutes after the hour (some after-the-bell drift,
zero on average). None changes the direction of a result; each widens the error bars a bit.

**If asked "why is the count small?"** Because it only counts real hours that have actually
settled since the collector started. It's not back-tested. One an hour, honestly.

---

## Section 6: Lock in along the ladder

**What it is.** Our product, quoted on the same hourly strikes, from the customer's side.
Someone holds a Kalshi "above $X" contract worth 45¢. We offer: a floor (the least they'll
walk away with), a cap (the most), and a credit (cents paid to them for accepting the cap).
"Upside given up" is stated plainly as 100¢ minus the cap.

**Picture.** Insurance on a lottery ticket you already hold. We guarantee you won't go below
the floor, in exchange for giving up the part above the cap, and we pay you a little for the
trade. Every quote is built by actually pricing the two option legs that back it on a live
public book, at the sizes shown.

**Refusals.** When the books can't fund a quote, or the strike's too far out, or the hour's
too close, the row says "refused" and why. Refusals on the page are a feature: they prove
the quotes come from real depth, not from a formula that always says yes.

**What's not shown.** Our take and the exact leg costs. A sharp reader can estimate them from
what is shown; that's fine and normal for any structured product. We don't print the formula
or the rate.

---

## Notes and limits

**What it is.** Every shortcut, assumption and known gap, named and sized.

**Picture.** The "known issues" page a good engineer hands you before you find them yourself.

**Why it's there.** For a reader like Ted, this section does more for credibility than any
other. It says we know where the edges are. Each line answers a question he would have asked
within a minute: are you rounding, which fee tier, which vol, which forward, is the hedge
cost realistic near a pin, where's the basis, is latency yours or the index's.

---

## The footer

The public endpoints we read, how fast each responded this cycle, and the sentence that
matters most to a risk person: *no credentials are loaded; the service cannot place an order,
move funds or see an account.* That isn't a policy. There's nothing on the machine that could.

---

## Ten things to be able to say without looking

1. Same contract on both venues; same index, same instant; one averaging footnote.
2. Kalshi's year-end sums to ~100¢, Poly's to ~117¢; that's whole-cent ticks, not alpha.
3. Crosses are cents on hundreds of dollars; the venues are efficient to within fees.
4. The hourly trades at a higher vol than the options market; that's the writer's premium.
5. A second of lateness is nothing on year-end and cents on the hourly; the table sizes it.
6. Static hedge: known cost, ramp not cliff. Dynamic: cheaper, path-dependent, bad near a pin.
7. The replay is live hours only, not a back-test. The count is small because it's honest.
8. Lock in's refusals are real; the quotes come from live books at shown sizes.
9. BRTI is the settlement price; CME is the hedge instrument; the basis between them is on
   the page.
10. Nothing trades. No keys exist on the service.

---

## What stays off the table

Take rate, partner share, volumes, counterparties, the formula, the pricing constants, which
venues we are talking to, investor names, the extension. If the conversation heads there, the
answer is "that's the commercial layer; happy to go there under NDA" and back to the page.
