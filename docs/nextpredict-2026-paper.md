# What the Stage Said, and What We Built

## A receipt from NEXTPredict New York, October 22–23, 2026

*Earn & Protect, by Atticus*

---

### Abstract

NEXTPredict New York gathered roughly 2,500 attendees and 200 speakers across five stages for two days, two weeks before the US midterm elections. Exchanges, market makers, sportsbooks, banks, lawyers, regulators and economists described, from their separate vantage points, the same set of gaps in the prediction-market product: positions that can only be won or lost, hedges that remain bespoke and institutional, capital locked up by full collateralization, retention bought with marketing rather than earned with product, combination contracts outgrowing the rails that fill them, and trader protection framed as a limit rather than a benefit. This paper sets what was said on stage, quoted as reported, beside what Earn & Protect has running today: a protected position with a floor on the losing side and a credit paid for a reduced payout on the winning side, built by one tap, hedged automatically in our own account on a regulated venue, routed across venues to the cheaper book, and written to a public, re-checkable record. It closes with the summit's own prognostications and where we stand against each.

---

### 1. The numbers, and what they leave out

Bank of America research analyst Julie Hoover put the growth in one line: prediction markets did $28bn of volume in the week of the summit, "up nearly 30 times from just a year ago today." Annualised, "that's $1.5tn. We published a $1tn TAM number a year ago, and we were like, maybe it'll get there in 2030, and it's already happened less than a year later." Kalshi holds about 75–80% of the US market, Polymarket 10–15%, and sports is still about 80% of volume. (Prediction Markets: The Public Markets Perspective.)

Eagle's View Asset Management president Neal Berger went further: "I'm going to make a crazy statement here, that I and people that I know in the industry think that there is a possibility that this grows bigger than the stock market." He added that investors in a market this new expect net returns above 25%: "Nobody's going to invest in this for 12% a year." (The Year Wall Street Bought In.)

Two speakers then qualified the headline. Sam Schwartz of The PM Pulse said 60% of the last 30 days' volume came from combination contracts, where small stakes generate outsized notional figures; without them, Kalshi's share falls from about 74% to about 64%. Manhattan Athletic Group CEO Henry Kerins said notional volume counts collateral on both sides, so "these numbers are to some degree spoofable," and that "the big thing is sitting on a pile of cash." (The PM Scoreboard.)

The number that mattered most for product was about people, not dollars. Opening the retention panel, NEXTPredict's Kim Yuhl cited Polymarket's 2024 cohort: of new wallets, "about 50% were active in two months, but only 17% in three. What that tells us is that many first-time users are settling, cashing out, and not coming back." Her framing: "Getting people in the door doesn't seem to be the problem, but keeping them is." (The Second Trade.)

AQR principal Tobias Moskowitz supplied the structural reason. Asked whether the win–loss split in sports markets is unusually skewed, he answered, "Compared to what? Do you think it's less skewed in the stock market? It's the same." The bigger difference, as reported, is that stocks offer a risk premium you can buy and hold, which only some prediction markets do. (Wisdom of the Crowds.)

**What we built.** A binary contract pays everything or nothing, which is why a first-time holder settles, cashes out and does not come back. Earn & Protect changes the shape of the position the holder already has. On the losing side they get a floor; on the winning side they accept a reduced payout and are paid a credit for it, now. The position stays on their venue and in their account. It becomes something that can be held through the result rather than only won or lost. Terms are priced from live order books at the moment of the tap and refused when the books cannot fund them.

---

### 2. The hedge is the institutional use case, and it is still bespoke

The clearest statement of the hedging thesis came from the firm that priced the summit's own flight-cancellation cover. "The ability to effectively manage risk depends on efficient markets and reliable liquidity," said Joe Grubb, head of business development at Susquehanna Predictions, in the announcement. "Prediction markets have paved the way for the novel price discovery and market structure needed to transfer institutional risk that historically had no path for execution." On stage he was candid about the stage of the market: Susquehanna is increasingly pricing bespoke hedges for businesses, as reported, with about half of its institutional enquiries relating to AI risks such as data-centre moratoriums and legislation, but "we're still in the top of the first when it comes to institutional trading and institutional interest in prediction markets." (As reported by NEXT.io.)

Cantor Fitzgerald's Matt DeCicco, who leads the firm's prediction-markets business, described the demand from the credit side: funds that have historically hedged with swaps or CDS, now looking at event contracts "rather than trading a CDS basket on 15 underlying issuers." He returned repeatedly to insurance as "one of the largest opportunity sets for these products," and said "the ship has left port on institutional usage for prediction markets, regardless of what the outcome is at the state level for sports." (Beyond Sports.)

Cboe's JJ Kinahan took the same idea down to the individual: "Those just are such natural hedges for the individual, and once brokerage firms start educating people how to use hedges in their own life day to day, I think that's really going to be where you see these explode." (Beyond Sports.)

Berger, on the opening panel, called event contracts "liquid insurance": cover against unfavourable weather or an economic print without negotiating a customised policy. (The Year Wall Street Bought In, as reported by NEXTPredict.) The organisers' pre-summit speaker-trail report, built from off-the-record conversations with speakers in September, collected the rest. A hedge fund manager used the same phrase, "liquid insurance": on-demand cover against a slow, intermediated alternative. An independent quantitative researcher flagged that "prediction-market positions are starting to be used as collateral, but nobody has worked out how to model that yet." The published session briefs put it plainly: "Risk, sizing, portfolio fit, and the hedging use-cases beyond speculation" (Does the Capital Stay?); "Hedge funds are trading event contracts – you just can't see them yet" (Wall Street Is Here: Institutional Block Trades).

And from the Startup Hub, Will Hall of Game Point Capital, which insures college athletic departments and sponsors against player bonuses and NIL costs, said less than 1% of sports risk globally is hedged, "so the opportunity is still massive." (The Next Billion-Dollar Opportunity in Prediction Markets.)

**What we built.** Every voice above describes a hedge that someone with a desk, a lawyer and a market-maker relationship can arrange. We build it for the holder, automatically, at their size. Behind one tap our service buys the opposing side on a listed venue in our own account, writes the record and pays the credit. The holder never touches a derivative, never opens a second account and never leaves their venue. The receipt carries the venue's own order id. Every open on the record is priced on more than one route and the cheaper one is written; the same instant is also re-priced on other regulated venues' books and kept beside it, so the record says what each venue would have cost before any capital goes there. Kinahan's "brokerage firms educating people how to use hedges" is, in our product, a toggle that shows the worst case before the tap.

---

### 3. Capital: everyone is posting all the money

Wedbush's Bob Fitzsimmons stated the market makers' complaint for them: "All prediction markets today are fully paid for, right? It is a resounding complaint from all the market makers. We will use the example, Bears playing Green Bay, market maker sells the Bears, they sell Green Bay. Essentially, they are flat. But right now, they are posting all the money on … it is pretty capital intensive." (Beyond Sports.)

Crypto.com's chief business officer Joe Anzures said institutions will need "really clear" regulation first, and pointed to the capital inefficiency of fully collateralised contracts as a barrier for market makers and institutions; what he hears most from market makers is "really locking the capital up for extended periods of time." Combination contracts are where the constraint bites hardest: "if we had that liquidity option to some of these market makers, I think we would see a lot more liquidity coming through on the combo side." (The Road to the Mainstream.)

Sharp Alpha's Lloyd Danzig described how the biggest market makers are funding the collateral: "if you want to offer 47-leg combos fully collateralized, you need a decent amount of cash," and many have taken on senior structured notes to do it. (The Coming Wave of Event-Market M&A.)

The responses are under way but partial. Cboe's Kinahan said Cboe Clear US had, "as of about an hour ago," received permission to clear securities trades, and that the firm "will do what is best for capital efficiency," with regulators preferring that exchanges "crawl, walk, run a little bit." Cantor's DeCicco pointed to Kalshi's filing with the CFTC, "several weeks ago," for margin relief on longer-dated non-sports contracts. (Beyond Sports.) Underdog's Levine described the same limit from the operator's side, on the longer-duration sports market he has long wanted to build: "There's collateral challenges. There's tying up money for a long period of time challenges … We're still exploring. We haven't found the answer yet or else we'd be doing it." (The Road to the Mainstream.)

**What we built.** We do not solve collateral at the exchange layer; we change the shape of the position so that the capital behind it is smaller and legible. A collared position has a known worst case and a known best case. That is the shape a collateral desk can model and a risk officer can sign, which is the gap the quantitative researcher named. On the cross-venue path, the hedge leg on the cheaper venue costs less than a hedge on the holder's own venue: in the current shadow, 1.89% against 3.15% of notional for the same protection. A cheaper hedge is a larger credit to the holder and less capital held per dollar protected. Our own hedges are fully collateralised, as the rules require; the efficiency comes from routing, not leverage.

---

### 4. Retention is the problem; marketing is the wrong answer

Underdog founder Jeremy Levine said the industry is repeating the post-PASPA sportsbook spending war and "multiplying it": "The amount of money being splashed around right now is, it's going to work for one or two, it's not going to work for all." He put the NFL-season figure at "well over $1 billion spent on marketing prediction markets already." Underdog tries not to "just compete on dollars": "We can all go compete for the New York Knicks deal. We all know that's going to be expensive." (The Road to the Mainstream.)

Kerins was more specific about the price of share: "You have to sign Sydney Sweeney to a two-year marketing deal to win 1% of the market share." And on structure: every operator wants its own designated contract market because "fee extraction also happens at the DCM layer … It's just not that terribly hard to build." (The PM Scoreboard.)

ProphetX co-founder Jake Benzaquen counted the exchanges: around ten operating and "another 20 in the queue," which is "obviously… not sustainable." He expects specialisation, "Poly for crypto, maybe use us for sports, Kalshi for politics," and a steady state of "four to six … but it's certainly not 10, it's certainly not 30." (What Comes After Yes or No?)

On what keeps a customer, Betr founder Joey Levy argued for a super-app: "you could use generosity from one product to help retention for another product," because the economics of a standalone prediction market are thin and "market makers are making a lot of money that the exchanges would otherwise want to retain for themselves." His case for the model: more revenue per user, less dependence on any one product line, and a way "to also hedge the regulatory exposure." Optimove's Tomer Imber: "The unit economics is going to be the king in that space. It's going to differentiate the losers and the winners." (The Second Trade.)

Levine also named the product failure that costs trust fastest. A customer who spends time building a parlay, "especially in-game," and then cannot get a quote has had their time wasted, "and I actually think wasting their time is probably one of the fastest ways to destroy trust." (The Road to the Mainstream.)

Acies Investments' Chris Grove said the current product, "two boxes in a box, yes and no," is not "a long term sustainable entertainment product." (What Comes After Yes or No?)

Odditt's Matt Bresler explained why the sportsbook retention toolkit does not transfer. A sportsbook is "a closed ecosystem" where a losing bonus bet recoups "their own funny money"; on an exchange, "there's a market maker on the other end collecting those winnings," and the CFTC is restricting promotions in any case. That leaves product as the retention tool: "Constant product velocity, new things, social experiences, overall product stickiness and experience become absolutely critical." Value, he argued, accrues "where the eyeballs go and where people are already retained." (The PM Scoreboard, as reported by NEXTPredict.)

**What we built.** A white-label line in the operator's own interface: a toggle, or one API call. The operator keeps the customer, the balance and the fee; we hold the hedge risk. The credit is Levy's "generosity," except that it is funded by the hedge rather than by the marketing budget, so it does not run out when the promo does; it is also the one form of generosity Bresler's exchange economics allow, because the market maker on the other side is us, and we are paid by the hedge. A holder with a floor under their position does not move to the venue with the celebrity. When the books cannot fund a credit, the answer is immediate and honest, "No honest credit right now, nothing opened," never a quote that fails to arrive. Benzaquen's four to six specialised exchanges is the world our router is built for: the hedge goes to whichever venue has the book, and the record shows which.

---

### 5. Combination contracts carry the risk

White Swan Predicts founder Bernard Marantelli, one of the largest quoters of request-for-quote flow, said combination contracts on regulated prediction markets carried about $18bn of risk across the industry in the seven days to Tuesday, up 20% week on week through the first five weeks of the NFL season, from around $100m of maximum daily liability in February. "It's going to be $30bn by Christmas or early January. The growth rate is out of control, really." Polymarket US RFQ technical lead Jacob Meleka said the exchange handles "thousands of RFQs a second, tens of thousands of quotes per second," with hundreds of market makers quoting. (RFQs: The Next Market Structure?)

Bank of America's Shaun Kelley recalled how the product arrived: at a BofA conference in September 2025, DraftKings and Flutter told investors prediction markets could not offer parlays because contracts had to be fully collateralised. "That became Wall Street ethos … Three weeks later, that's exactly what happened… Kalshi launched parlays through RFQ mechanism, and the rest was history." Since that "breakout point," he said, Flutter's shares are down 75% and DraftKings' down 60%. (Prediction Markets: The Public Markets Perspective.)

ProphetX CEO Dean Sisun said competition between market makers means exchange parlays beat sportsbook prices "95 out of 100 times." (As reported by NEXT.io.)

**What we built.** Protection on a single leg exists today. The parlay surface, leg resolution and the last-leg shadow exist in the codebase; protection on a combination, priced the same way and refused the same way, is the next product. The RFQ rails described on stage are how the hedge on a multi-leg position gets filled at size, and Marantelli's $30bn is the size of the position book that has no floor under it.

---

### 6. Who protects the trader

DraftKings CEO Jason Robins said prediction markets "absolutely" need the same protections as sports betting, and that DraftKings applies them without being required to: "It's literally the same playbook … You don't necessarily have to reinvent the wheel here." (In Conversation with DraftKings.)

Novig's Adam Warrington, who previously led responsible gaming at FanDuel and Underdog, called for a national self-exclusion system and described why limits do not get set: "Why would I set the deposit limit? I don't have a problem. So it's much like, why would I wear a seat belt? I'm a good driver … We need to educate." Sporttrade's Kane said he would prefer margin trading "not really get introduced" to binary event contracts, and that one- and five-minute Bitcoin markets share "characteristics … with a slot machine." (Who Protects the Trader?)

Smarkets founder Jason Trost was blunter: "I think a reckoning is coming in this industry for good reason. I think there's going to be a backlash from the public," citing "irresponsible advertising" and mention markets that "don't serve the public good." Kerins predicted "All the PMs are going to be 21-plus and there'll be a bunch of other rules around advertising and whatnot to clean everyone's act up." Former Rep. Mondaire Jones expects legislation to "gain more momentum in January" with "categorical prohibitions." (The World Beyond Wall Street; The PM Scoreboard; Markets Under Watch.)

**What we built.** A protection tool the trader wants to use, because it pays them. The worst case is on screen before the tap: "$14.71 instead of $0." No leverage, no margin, no new instrument in the holder's hands, no second account. Toggle off at any time and keep what has vested. Read from the operator's side, the same product is a responsible-trading feature with an attach rate instead of a limit with an opt-out. When the rules Kerins and Jones expect arrive, a product that reduces the holder's downside is on the right side of them.

---

### 7. Rails, data and integrity

Cboe's Joe Green warned that today's contract count is "nothing compared to what's coming": "There's going to be an avalanche of contracts. There's going to be an avalanche of data that's needed to settle those contracts." And: "Best data in the world is not gonna save a poorly created contract." (The Data Integrity Layer.) Patomak's Pamela Geraghty, a former CFTC official, said the agency is "looking at product certifications very closely" and that many new exchanges have found self-certifying contracts "a lot harder than I anticipated"; Gemini's Brigitte Weyls, also formerly of the agency, said it "seems a lot more involved these days," including on clearing, back office and contract specifications. (Keeping the Market Honest.) The What Comes After Retail? brief: the rails that could bring institutional capital in "are only now being built, creating a race to solve the infrastructure gaps around liquidity, market data, execution and access."

On integrity, CFTC Director of Enforcement David Miller settled the first question: "Prior to this year … there was a lot of confusion as to whether or not insider trading market manipulation rules and laws applied in the prediction markets. Short answer: They do, and we are on the job policing fraud." The agency remains "very pro innovation." (View from the CFTC.) Polymarket's Olivia Chalos said that on-chain, "I can't think of a single case where we didn't identify the individual almost within minutes." (The Insider Threat.) Former CFTC commissioner Dan Berkovitz reminded the room that hedging is the point: "If you totally prohibited anybody who had any inside information from participating in a commodity market, people couldn't hedge." (Off the Table.) And The Conference Board's PJ Tabit relayed a bank CFO's position: the bank does not allow accounts to interact with prediction markets "because there are huge compliance concerns." (The Settlement Layer.)

**What we built.** We are a rails customer and a flow source. Our matcher aligns the same game across venues; an aggregator partner's feed now sits in front of our direct venue reads, aligned by one lookup on our ticker, with the direct read behind it for anything the feed cannot supply. Settlement is on the official result only, from a whitelist of resolution rules the record pins at open. Since the summit the record has gained two things the rooms above asked for. Each protected position is re-read on every venue two hours before lock and the read is stored beside the open-time read, so the record shows how each book moved between the terms written and the start. And on the cross-venue route, a guard defers protection on games more than a day out when no venue yet has a real book, rather than writing terms against a book that is not there. On integrity: nothing in the product gives anyone a position they did not already have or a view into information they did not already hold. The holder's venue account is never read or used; our hedges sit in our own accounts on regulated venues; every record is public and re-checkable against the venue's own fills.

---

### 8. The prognostications, and where we stand

The summit made predictions. They are listed here so they can be checked.

**Combination risk reaches $30bn a week by Christmas or early January** (Marantelli). Where we stand: single-leg protection is live; combination protection is the next build on the parlay surface already in the codebase.

**Four to six exchanges survive, specialised by category** (Benzaquen). Where we stand: the cross-venue router already prices each open on more than one venue and writes the cheaper one; specialisation makes the router more valuable, not less.

**Non-sports contracts are the majority of activity by 2029** (three of four Beyond Sports panellists). Where we stand: the collar is contract-agnostic; it runs today on a perpetuals venue and on sports event contracts, and the same shape fits a KPI, a rate decision or a weather strike.

**The industry goes 21+, with advertising rules** (Kerins); **a reckoning is coming** (Trost); **legislation gains momentum in January** (Jones). Where we stand: a product that reduces the holder's downside and shows it before the tap is the kind of feature that survives a tightening.

**Capital efficiency arrives through clearing and margin relief** (Kinahan; Kalshi's filing, per DeCicco). Where we stand: we do not wait for it; routing to the cheaper book already lowers the capital behind each protected dollar.

**Prediction markets embed in larger platforms rather than stand alone** (main-stage summary); **buying is faster than building** (Danzig). Where we stand: the product is a white-label line, built to sit inside someone else's interface.

**AI agents reach 20% of Moomoo's volume by year end** (Moomoo's Neil McDonald); **AI forecasting overtakes markets for serious forecasting** (Hypermind's Emile Servan-Schreiber). Where we stand: an agent that holds a position needs a floor as much as a person does, and reads our API the same way.

---

### 9. What is missing, and what we have

Set side by side, the two days describe five gaps.

**A hedge the holder does not have to build.** The institutional hedge exists; the retail hedge does not. We build it behind one tap, at the holder's size, in our own account.

**A position shape that capital can model.** Fully collateralised binaries lock capital and resist modelling as collateral. A collar has a known worst and best case; routing to the cheaper book lowers the capital per protected dollar.

**Retention that is not a promo.** Marketing works for one or two operators. A floor under the position keeps the holder where they are, and the credit is paid by the hedge, not the budget.

**Protection the trader wants.** Limits are opted out of. A protection that pays, with the worst case shown first, is opted into.

**A record that can be checked.** Rails, data and certification are "only now being built." Every open on our record shows the route taken, the routes checked, the venue's own order id, and now the pre-lock read on every venue.

Where we stand: live on a perpetuals venue with one toggle, a hard floor and a daily credit; running on a public record across event-contract venues; and the next product, protection on a combination, specified by the stage itself.

---

### Where to see it

- Live on a perpetuals venue: one toggle, a hard floor, a daily credit.
- Event contracts: the public record of settled cycles, each with the route taken, the routes checked, and the hedge receipt.
- On request: the cross-venue hedge-cost comparison (1.89% against 3.15%) and the per-venue reference reads, including the pre-lock read.

---

### Method

Quotations are taken from the NEXTPredict live blogs for both days, NEXTPredict's own panel write-ups, the summit's published session briefs, the organisers' pre-summit speaker-trail report of September 21, 2026, the NEXT.io and SCCG Management day recaps, the Investing.com transcript of the main stage, the Legal Sports Report account of day one, and the July 2026 announcement of the flight-cancellation hedge, all accessed October 24–25, 2026. Where a source paraphrased rather than quoted, the passage is marked "as reported." Speakers are identified by the name, title and session given in the source. Product statements describe Earn & Protect as deployed on the date of writing.

### References

1. NEXTPredict, "NEXTPredict NYC 2026 Live: Day 1," nextpredict.io/market-news/industry/nextpredict-nyc-2026-day-1-live/
2. NEXTPredict, "NEXTPredict NYC 2026 Live: Day 2," nextpredict.io/market-news/industry/nextpredict-nyc-2026-day-2-live/
3. NEXTPredict, "Signals from the NEXTPredict Speaker Trail: Win, lose or hedge," September 21, 2026, nextpredict.io/market-news/industry/insights-nextpredict-speakers-win-lose-hedge/
4. NEXT.io, "Who wins in prediction markets? Day one at NEXTPredict Summit New York," next.io/news/features/who-wins-prediction-markets-nextpredict-new-york/
5. NEXT.io, "Who draws the line? Day two at NEXTPredict Summit New York," next.io/news/features/who-draws-line-day-two-nextpredict-summit/
6. SCCG Management, "NEXTPredict New York, Day 1: Regulators, Sportsbooks and Wall Street Share One Stage," sccgmanagement.com/sccg-articles/2026/10/22/nextpredict-new-york-2026-day-1-recap/
7. SCCG Management, "NEXTPredict New York, Day 2: The Courts, the Midterms and a $1.5 Trillion Market," sccgmanagement.com/sccg-articles/2026/10/23/nextpredict-new-york-2026-day-2-recap/
8. Investing.com, "DraftKings at NEXTPredict Summit NYC 2026: rapid gains, big risks" (main-stage transcript), investing.com/news/transcripts/draftkings-at-nextpredict-summit-nyc-2026-rapid-gains-big-risks-93CH-4967551
9. Legal Sports Report, "CFTC, Prediction Markets Address Oversight At Industry Conference," legalsportsreport.com/283718/
10. NEXTPredict, "NEXTPredict executes first-ever conference hedge through Kalshi, securing $3m in coverage with Susquehanna as market maker," July 28, 2026, nextpredict.io/market-news/industry/nextpredict-executes-first-ever-conference-hedge-through-kalshi/
11. NEXTPredict published agenda and session briefs: The Year Wall Street Bought In; Does the Capital Stay?; What Comes After Retail?; Wall Street Is Here: Institutional Block Trades; RFQs: The Next Market Structure?; Who Protects the Trader?; The Data Integrity Layer; Hedging the Unhedgeable
12. NEXTPredict, "Prediction markets could outgrow stocks says hedge fund manager," October 22, 2026, nextpredict.io/market-news/industry/prediction-markets-could-outgrow-stocks-says-hedge-fund-manager/
13. NEXTPredict, "'Not one perfect metric': Is Kalshi's 74% share overstated?," October 23, 2026, nextpredict.io/market-news/industry/not-one-perfect-metric-is-kalshi-share-overstated/
