# Atticus deck v6: slide copy and build notes

Pre-seed deck. Ten slides plus two optional appendix slides. Numbers below are the live public records as of 2026-09-24 23:28 UTC; refresh the two proof numbers the morning you send.

## Build rules

- One idea per slide. Headline states the idea in plain words; body is at most 40 words.
- One number per slide where a number exists. Never two competing numbers.
- Real screenshots only (the retail card, the two track-record pages). No generated art, no stock photos, no icons.
- Black text, white background, the gold accent used once per slide at most.
- Every claim on slides 5 and 8 has a public URL. Put the URL in small type on the slide.
- Corrections to v5 that must not survive: "daily credit" (it is a weekly Friday tenor, credit paid up front), "knockout" (there is none; the holder can release upside at the live price any time), "10% published, 20% founding" fee lines (live take is 20% of the net credit, nothing else), "live on Hyperliquid rails" (we wrap Hyperliquid positions; the hedge is on listed BTC options), the three side products on the solution slide (Leverage Extension, Bad-Debt Shield, Volume Facility go to an appendix or get cut).

---

## Slide 1: Title

**Protection that pays the trader.**

Atticus | Earn & Protect

A hard floor and a cash credit on any open position. One tap. Hedged leg for leg.

Pre-seed · September 2026 · Michael William · michael@atticustrade.com

Speaker note: Say the headline and stop. The whole deck is that sentence.

---

## Slide 2: Problem

**Every venue sells leverage. Nobody sells the floor.**

- A stop-loss is an exit, not protection. It fires on the wick and puts you out before the recovery.
- Traders will not pay for insurance. Thirty years of retail data says so.
- So venues run on liquidations. Liquidations end accounts. Ended accounts do not come back.

Footer line: Hyperliquid's newest answer, September 21, 2026: trailing stops. Still an exit.

Speaker note: The venue has a growth problem, not a protection problem. Liquidated users are lost lifetime value. Keep the trader in the trade and the venue keeps the trader.

---

## Slide 3: Solution

**Pick a floor. Get paid today. Keep your position.**

[Screenshot: the retail card, mid-tap, showing floor, credit, and "Release my upside".]

- Hard floor to Friday. If price falls through it, the floor pays.
- Cash credit paid up front for selling upside you were not going to use.
- Release my upside any time at the live price. One tap on, one tap off.

Small type: Under the hood it is a collar on listed options, netted across holders and hedged leg for leg. Atticus carries zero market risk.

Speaker note: Do not explain options. Explain the three bullets. If asked "how", the answer is one sentence: we buy the put and sell the call for them on a listed venue, and we never hold the difference.

---

## Slide 4: Why this beats the tools venues are shipping

**A stop gets you out. A floor keeps you in and pays you.**

| | Trailing stop | Earn & Protect |
|---|---|---|
| On a wick | Sells you out at the low | Floor holds. You stay in. |
| Cost | Free, then you eat the exit | Pays you cash up front |
| Setup | Distance, activation price, size | One tap |
| Undo | Re-enter and pay the spread again | Release my upside at the live price |
| Who hedges it | Nobody. Your risk. | Atticus, leg for leg, on a listed book |

Footer line: Hyperliquid shipped trailing stops on September 21. Our perp record restarted the same day. Simpler for the trader, and the trader gets paid.

Speaker note: This is the "why us and not the venue" slide. Venues ship exits because exits are free to build. A floor needs an options book, netting and a hedge desk. That is us.

---

## Slide 5: Proof, two live public records

**Both products run in public. Append-only. Never re-marked.**

Perps (facility.atticustrade.com), since September 21:

- 343 positions protected · $13.9M notional · 0 quotes refused
- $12,398 credit paid to holders · 8.9 bps of notional
- 37 early releases priced at the live book · first weekly settlement Friday, September 25

Event contracts (atticus-event-shadow.onrender.com), since September 12:

- 491 positions protected · 400 settled · 169 floor saves (42%)
- Our P&L on settled positions $102.50 = booked take $102.50 · gap $0.00
- Every hedge leg priced off Kalshi or Polymarket depth at the time of the trade

Speaker note: The identity line is the whole slide. Our P&L equals our published take to the cent because we never hold risk. Anyone can download the CSV and sum it. Refresh these six numbers the morning you send.

---

## Slide 6: Event markets, embed instead of aggregate

**$16B a week now trades on Kalshi and Polymarket. Their traders have no floor.**

- New apps are showing up around the venues: aggregators, third markets, hedge tools. Every one pulls the trader off the venue and keeps the spread.
- We embed inside the venue. The trader never leaves. The venue earns a share of our take. Our hedge legs land on the venue's own book.
- A third-market app will not share revenue. A venue will not send its traders elsewhere to hedge. We solve both.

Small type: Kalshi and Polymarket Global weekly contract volume, September 14 to 20, 2026: $16.4B (Kalshi $15.3B). Roughly a third of Kalshi's daily flow arrives through Robinhood. Distribution wins this market; we are a feature inside the distribution.

Speaker note: Sports and crypto event markets settle in hours, so floor saves show up fast. Our record: 169 floor saves in 400 settled contracts. No venue offers this today and none can build it without a hedge desk.

---

## Slide 7: Business model

**We keep 20% of the credit. The trader keeps 80%. Venue fees pass through at cost.**

Live record, four days, $13.9M wrapped:

- Gross credit from the options book: $23,593
- Venue fees, passed through: $8,095
- Paid to traders: $12,398
- Atticus: $3,100 (about 2.2 bps of notional wrapped)

- Fees fall with RFQ pricing and volume tiers. Every basis point saved goes to the trader and to us, in the same 80/20.
- Embedded venues take a share of our 20%. Set per partner.

Illustrative: $50M a day wrapped at today's take is about $4M a year. That is one mid-size venue.

Speaker note: Revenue is never trading P&L. If a partner asks what happens in a crash, the answer is on slide 5: the floor pays because the put pays; our number does not move.

---

## Slide 8: Why now

**Venues are racing to become derivatives exchanges. They are building the spot layer. We are the derivatives layer above all of them.**

- Hyperliquid: about $240B in perp volume in the last 30 days, roughly a third of all perp DEX volume. September 21: trailing stops.
- Hyperion DeFi (Nasdaq: HYPD), CFO David Knox, public post September 2026: bring non-native infrastructure teams onto Hyperliquid. We replied. He took it to his CEO the same day.
- Kalshi: first $3B day, September 20. Distribution through Robinhood, Coinbase, Webull, Moomoo. Prediction markets are becoming brokerage features, and features need protection.
- Kraken simplified options (July), Binance US stock options (September), SGX perps filed with the CFTC (September).

Footer line: We started 18 months ago. Both products run in public today.

Speaker note: The Knox item is the strongest line in the deck. Say it exactly as it happened and no more. Do not say a deal is in progress.

---

## Slide 9: Team

**Michael William, founder. Sole builder of everything that is live.**

- Built and runs both public records: perp protection wrapping Hyperliquid positions with hedges on listed BTC options; cross-venue event protection routing Kalshi and Polymarket; append-only public ledgers for both.
- Co-founded William Ting Capital: hedge fund access for the digital-wealth generation.
- Built audiences before markets: EP, writer and animator with CollegeHumor and Machinima; co-created a 12-episode animated series for El Rey Network. The same skill runs Atticus distribution.

First hires with this round: founding engineer (execution infrastructure) and a markets/BD lead.

Speaker note: Investors at this stage are buying the founder. The proof that you can ship alone is slide 5.

---

## Slide 10: The ask

**$400k pre-seed SAFE. The check turns on live hedging.**

- $50k: hedge collateral at OKX and Kalshi. A deposit, not burn. Turns the shadow book live.
- $200k: founding engineer, 12 months.
- $100k: founder salary, travel, legal and compliance path.
- $50k: reserve for a second hedge venue (Bullish or Deribit) and an RFQ line.

Three milestones, twelve months:

1. First live hedged positions on both records, same public ledgers.
2. First venue embed live with a signed revenue share.
3. RFQ dealer line that cuts venue fee drag by half.

Footer line: Accepting $250k to $500k. $5M post-money cap. First close at $250k committed.

Speaker note: Say "the platform is running; this is the collateral and the first hire." Then stop talking and let them ask about the cap.

---

## Appendix A (optional): Trade flow

Trader taps Protect → venue passes the position to the Atticus API → live-book pricing on listed options → hedge legs placed leg for leg → weekly settlement against the venue's own mark → floor pays or upside is released.

Keep the v5 diagram, remove "regime gate" and "7.8% margin netting factor" from the slide. Those are answers to questions, not slide copy.

## Appendix B (optional): Who else does this

- Venues (Kalshi, Polymarket, Hyperliquid, Coinbase): rails, not rivals. They have the traders and no options book.
- Aggregators and third-market apps: take the trader off the venue and keep the spread. Venues will not integrate them.
- Legacy structurers (buffer ETFs, OTC desks): monthly tenors, minimum tickets, no retail card.
- Options vaults: sell upside for yield with no floor. That is half the product and the wrong half.
- Status quo: stop-losses and hope.

Neutrality is the moat. We hedge on whichever venue is best for that trade and share revenue with the venue that sent it.

---

## Why the smaller ask closes faster

- $2M seed for a solo founder with no revenue asks a fund to lead. Leads take months and want a co-founder. $250k to $500k fills with four to eight angel and micro-fund checks, each of which can close in a week.
- The use of funds is checkable. $50k of it is a deposit that comes back. The engineer is the only real burn. That is a story an angel repeats to the next angel in one sentence.
- Milestones are binary and public. "First live hedged position on the same ledger" is a link, not a slide. Every check written after that is on a live book.
- A $5M cap is defensible with two public records and zero revenue. Push higher only after the first embed signs.

## Five answers to keep in your pocket

- "Why won't the venue build this?" A floor needs an options book, netting across holders and a hedge desk. Venues ship exits because exits are free. Hyperliquid's trailing stops are the evidence.
- "Where is the regulatory risk?" We are a protection feature on a position the trader already holds, hedged on regulated or listed venues. The venue owns the customer and the KYC.
- "What breaks in a crash?" Our P&L is the published take, not the hedge. The record shows the gap at $0.00 across 400 settlements. A crash pays floors from puts we already bought.
- "Why is the fee drag 34% of gross credit?" Because we pay taker fees on a listed book with no volume tier. RFQ and tiers cut that, and the saving goes 80/20 to the trader and us.
- "Who is the customer?" The venue. The trader is the venue's customer and stays that way.

## Source lines for the market slide

- Hyperliquid 30-day perp volume about $239B, 36% of tracked perp DEX volume: DeFiLlama snapshot reported September 17, 2026.
- Hyperliquid trailing stops: app.hyperliquid.xyz announcement dated 9/21/2026.
- Kalshi and Polymarket Global weekly contract volume $16.43B, September 14 to 20, 2026; Kalshi $15.27B; first $3B day September 20: DefiRate weekly report.
- Kalshi distribution via Robinhood, Coinbase, Webull, Moomoo; roughly a third of daily flow via Robinhood: Artemis data as reported week ending September 13, 2026.
