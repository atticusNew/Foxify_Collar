# What the stage said, and what we built

NEXTPredict New York, October 22 and 23, 2026. Two days, five stages, about 200 speakers. The
lines below are what was said on stage or published around the summit, quoted as said. Next to
each is what Earn & Protect does about it today. Speakers are given by role, not name; sources
are listed at the end.

The short version: the industry spent two days describing a position that can be held, a hedge a
holder does not have to build, retention an operator does not have to buy, and a product that
protects the trader without limiting them. That is the product. It is live on a perpetuals venue,
and it runs on a public record across event-contract venues.

## 1. The money has arrived; the positions cannot be held

> "up nearly 30 times from just a year ago today"
> bank research analyst, on $28bn of weekly volume, $1.5tn annualised

> "I'm going to make a crazy statement here, that I and people that I know in the industry think that there is a possibility that this grows bigger than the stock market."
> asset manager, The Year Wall Street Bought In

> "stocks offer a risk premium you can buy and hold, which only some prediction markets do"
> quantitative asset manager, Wisdom of the Crowds (as reported)

**What we do.** A binary position pays everything or nothing. We give the holder a floor on the
losing side and pay them a credit for taking a reduced payout on the winning side. The position
stays where it is; it becomes something that can be held through the result rather than only won
or lost. The terms are priced from live order books at the moment of the tap and refused when the
books cannot fund them.

## 2. Hedging is the institutional use case, and it is still bespoke

> "The ability to effectively manage risk depends on efficient markets and reliable liquidity. Prediction markets have paved the way for the novel price discovery and market structure needed to transfer institutional risk that historically had no path for execution."
> head of business development, the market maker behind the summit's own flight-cancellation hedge

> "liquid insurance"
> a hedge fund manager's phrase for event cover, as reported in the summit's own trend piece

> "Risk, sizing, portfolio fit, and the hedging use-cases beyond speculation."
> session brief, Does the Capital Stay?

> "Hedge funds are trading event contracts - you just can't see them yet."
> session brief, Wall Street Is Here: Institutional Block Trades

**What we do.** The hedge is built for the holder, automatically, at their size. Behind one tap
our service buys the opposing side on a listed venue in our own account, writes the record and
pays the credit. The holder never touches a derivative and never leaves their venue. The receipt
shows the venue's own order id. Every open on the record is priced on more than one route and the
cheaper one is written; the same instant is also re-priced on other regulated venues' books and
kept beside it, so the record says what each venue would have cost before any capital goes there.

## 3. Capital efficiency and collateral

> institutions will need "really clear" regulation first; the capital inefficiency of fully collateralized contracts is a barrier for market makers and institutions
> exchange chief business officer, The Road to the Mainstream (as reported)

> prediction-market positions are starting to be used as collateral, but nobody has worked out how to model that yet
> independent quantitative researcher, as reported in the summit's trend piece

**What we do.** A collared position has a known worst case and a known best case. That is the
shape a collateral desk can model and a risk officer can sign. On the cross-venue path, the hedge
leg on the cheaper venue costs less than a hedge on the holder's own venue: in the current shadow,
1.89% against 3.15% of notional for the same protection. Lower hedge cost is a bigger credit to the
holder and less capital held per dollar protected.

## 4. Retention is the problem; marketing is the wrong answer

> every operator wants to own its own exchange "because that's where the fees are", and winning even 1% of the market now takes a celebrity-sized marketing budget
> market maker CEO, The PM Scoreboard (as reported)

> "The amount of money being splashed around right now is, it's going to work for one or two, it's not going to work for all."
> operator founder, The Road to the Mainstream

> "We can all go compete for the New York Knicks deal. We all know that's going to be expensive."
> same speaker

> "wasting their time is probably one of the fastest ways to destroy trust."
> same speaker, on customers who build a parlay and cannot get a quote

> operators need complementary products to retain customers, expand revenue per user and hedge regulatory risk
> panel summary, retention and sustainable economics (as reported)

**What we do.** A white-label line in the operator's own UI: a toggle, or one API call. The
operator keeps the customer, the balance and the fee; we hold the hedge risk. A holder with a
floor under their position does not move to the venue with the promo. When the books cannot fund
a credit, the answer is immediate and honest, "No honest credit right now, nothing opened", never
a quote that fails to arrive.

## 5. Combination contracts carry the risk

> "It's going to be $30bn by Christmas or early January. The growth rate is out of control, really."
> RFQ market maker CEO, on $18bn of weekly parlay risk

> 60% of the last 30 days' volume came from combination contracts
> prediction-markets analyst, The PM Scoreboard (as reported)

> "thousands of RFQs a second, tens of thousands of quotes per second"
> RFQ platform lead at a US exchange

**What we do.** Protection on a single leg exists today. The parlay surface, leg resolution and
last-leg shadow exist in the codebase; protection on a combination, priced the same way and
refused the same way, is the next product, and the RFQ rails described on stage are how the hedge
on a multi-leg position gets filled at size.

## 6. Who protects the trader

> "It's literally the same playbook." ... "You don't necessarily have to reinvent the wheel here."
> sportsbook CEO, on applying responsible-gaming tools to prediction markets

> "Why would I set the deposit limit? I don't have a problem. So it's much like, why would I wear a seat belt? I'm a good driver." ... "We need to educate."
> exchange SVP for external affairs, Who Protects the Trader?

> he would prefer margin trading "not really get introduced" to binary event contracts
> exchange CEO (newly approved as a derivatives clearing organization), Who Protects the Trader? (as reported)

**What we do.** A protection tool the trader wants to use, because it pays them. The worst case is
on screen before the tap ("$14.71 instead of $0"). No leverage, no margin, no new instrument in
the holder's hands. Toggle off any time and keep what has vested. The same product, read from the
operator's side, is a responsible-trading feature with an attach rate instead of a limit with an
opt-out.

## 7. Rails, data and the avalanche of contracts

> "There's going to be an avalanche of contracts. There's going to be an avalanche of data that's needed to settle those contracts." ... "Best data in the world is not gonna save a poorly created contract."
> exchange head of prediction markets, The Data Integrity Layer

> the rails that could bring institutional capital in "are only now being built, creating a race to solve the infrastructure gaps around liquidity, market data, execution and access"
> session brief, What Comes After Retail?

**What we do.** We are a rails customer and a flow source. Our matcher aligns the same game across
venues; an aggregator partner's feed now sits in front of our direct venue reads, aligned by one
lookup on our ticker, with the direct read behind it for anything the feed cannot supply. Settlement
is on the official result only, from a whitelist of resolution rules the record pins at open.

## 8. Regulation and integrity, briefly

> "Short answer: They do, and we are on the job policing fraud." ... the agency remains "very pro innovation"
> CFTC director of enforcement, on whether insider-trading and manipulation rules apply

> "Is there any better fact check than the markets themselves?"
> summit host

**What we do.** Nothing in the product gives anyone a position they did not already have, or a
view into information they did not already hold. The holder's venue account is never read or
used; our hedges sit in our own accounts on regulated venues; every record is public and
re-checkable against the venue's own fills.

## Where to see it

- Live on a perpetuals venue: one toggle, a hard floor, a daily credit.
- Event contracts: the public record of settled cycles, each with the route taken, the routes
  checked, and the hedge receipt.
- Ask for the cross-venue hedge-cost comparison (1.89% vs 3.15%) and the per-venue reference
  reads.

---

## The post

*For LinkedIn. No names, the sessions do the attribution.*

Two days at NEXTPredict New York and nearly every panel I sat in described the same product.

"Liquid insurance." "The hedging use-cases beyond speculation." "Risk, sizing, portfolio fit." "Positions are starting to be used as collateral, but nobody has worked out how to model that yet."

"Every operator wants to own its own exchange, because that's where the fees are." Winning 1% of the market now takes a celebrity-sized marketing budget. "Wasting their time is probably one of the fastest ways to destroy trust."

"It's literally the same playbook." "Why would I wear a seat belt? I'm a good driver." "We need to educate."

Here is what we built, and have running:

A binary position pays everything or nothing. We give the holder a floor on the losing side and pay them a credit for taking a smaller payout on the winning side. One tap. The position stays on their venue. We build the hedge in our own account on a listed venue, write the record, and pay the credit now. The worst case is on the screen before they tap.

For the trader it is protection that pays. For the operator it is a line in their own UI that keeps the customer without buying them. For the desk it is a position with a known worst case and a known best case, which is the shape you can model as collateral.

It runs today on a perpetuals venue, and on a public record across event-contract venues where every settled cycle shows the route taken, the routes checked, and the venue's own order id.

If you were on one of those stages and this sounds like what you were describing, it is. Twenty minutes next week.

#predictionmarkets #NEXTPredict #hedging #marketstructure

---

## Sources

- NEXTPredict NYC 2026 live blog, day one (nextpredict.io/market-news/industry/nextpredict-nyc-2026-day-1-live)
- NEXTPredict New York day one and day two recaps (sccgmanagement.com)
- "Prediction market trends: Winners, losers, hedging and regulation" (nextpredict.io)
- NEXTPredict flight-cancellation hedge press release (finance.yahoo.com) and the exchange CEO's response (nextpredict.io)
- Session briefs from the published agenda (The Year Wall Street Bought In; Does the Capital Stay?; What Comes After Retail?; Wall Street Is Here; RFQs: The Next Market Structure?; Who Protects the Trader?; The Data Integrity Layer; Hedging the Unhedgeable)
- DraftKings NEXTPredict Summit NYC 2026 summary (quartr.com)
- Items marked "as reported" are paraphrased by the source rather than quoted verbatim.
