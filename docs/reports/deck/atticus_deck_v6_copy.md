# Atticus deck v6: slide copy and build notes

Pre-seed deck. Ten slides plus two optional appendix slides. Numbers below are the live public records as of 2026-09-25 18:49 UTC, after the first weekly perp settlement; refresh the proof numbers the morning you send.

Screenshots for the slides are in `assets/` next to this file (all captured from the live demos and records at 2x on 2026-09-25):

- `slide3_perp_headline_and_card.png`: the landing headline and the toggled card together.
- `slide3_perp_card_toggled.png`: the card alone. Long BTC $128,484, this week's credit $192.58, floor $79,000, cap $87,000, pays Friday.
- `slide5_perp_record_kpis_2026-09-25.png` and `slide5_perp_record_identity_2026-09-25.png`: the perp track record top block and the "we carry no outcome risk" row.
- `slide5_event_record_kpis_2026-09-25.png`: the event track record top block and identity.
- `slide6_event_phone_protected.png` and `slide6_event_protect_sheet.png`: the embed with the Astros row protected and the confirmation sheet.
- `slide8_hyperliquid_trailing_stops_with_reply.png`: Hyperliquid's trailing-stop announcement with our reply beneath it (phone capture, September 21).
- `slide8_robinhood_hood_summit.png`: Robinhood's "The retail trader is evolving, and so is the options market" post for HOOD Summit (phone capture, September 25).

Slide map: 1 title, 2 problem, 3 solution (perps), 4 versus the tools venues ship, 5 proof, 6 event markets, 7 business model, 8 why now, 9 team, 10 ask. Team and ask stay separate slides.

## How the two products differ (a build note, not a slide)

Slide 3 shows the perp product and slide 6 shows the event product; the difference is seen, not explained. Do not add a slide for this.

- Perps: one toggle. The engine finds the floor and the cap on the live options book. The trader picks nothing. The credit unlocks through the week and pays Friday at the cycle close, never up front. The collar runs to Friday; the cap can be bought back at the live listed price, and that is shown on the institutional skin only. Nothing to manage.
- Events: one tap on the position row. The floor and the cash are shown before the tap; the cash is added to the balance at protect time. Where the market supports it the embed offers three floor tiers (tight, balanced, wide) with the default chosen for the trader.

## Build rules

- One idea per slide. Headline states the idea in plain words; body is at most 40 words.
- One number per slide where a number exists. Never two competing numbers.
- Real screenshots only (the retail card, the two track-record pages). No generated art, no stock photos, no icons.
- Black text, white background, the gold accent used once per slide at most.
- Every claim on slides 5 and 8 has a public URL. Put the URL in small type on the slide.
- Corrections to v5 that must not survive: "daily credit" (it is a weekly Friday tenor; the credit unlocks through the week and pays Friday), "knockout" (there is none; the collar runs to Friday and the cap can be bought back at the live price), "10% published, 20% founding" fee lines (live take is 20% of the net credit, nothing else), "live on Hyperliquid rails" (we wrap Hyperliquid positions; the hedge is on listed BTC options), the three side products on the solution slide (Leverage Extension, Bad-Debt Shield, Volume Facility go to an appendix or get cut).
- Never write "pick a floor" for perps. The engine picks. Never show a release button; the retail card has none.

---

## Slide 1: Title

**One toggle. A hard floor. And it pays.**

Atticus | Earn & Protect

A hard floor and a cash credit on any open position. Nothing to manage. Hedged leg for leg.

Pre-seed · September 2026 · Michael William · michael@atticustrade.com

Speaker note: Say the headline and stop. The whole deck is that sentence.

---

## Slide 2: Problem

**Every venue sells leverage. Nobody sells the floor.**

- A stop-loss is an exit, not protection. It fires on the wick and puts you out before the recovery.
- Traders will not pay for insurance. So they trade with none.
- October 10, 2025: $19 billion of leveraged positions liquidated in 24 hours, 1.6 million traders, the largest single day on record. Not one of those positions had a floor under it.
- Liquidations end accounts. Ended accounts do not come back.

Footer line: Hyperliquid's newest answer, September 21, 2026: trailing stops. Still an exit.

Speaker note: The venue has a growth problem, not a protection problem. Liquidated users are lost lifetime value. Keep the trader in the trade and the venue keeps the trader.

---

## Slide 3: Solution

**One toggle. A hard floor. And it pays.**

[Screenshot: `assets/slide3_perp_card_toggled.png`. Long BTC, $192.58 this week's credit, $79,000 floor, $87,000 cap, pays Friday.]

- Flip protection on any perp position. The engine finds the floor and the cap on the live options book.
- A hard floor under the position to Friday. Losses stop there.
- A credit, funded by the options market, unlocks through the week and pays Friday.
- Nothing to set. Nothing to manage. Refuses when the market cannot fund an honest credit.

Small type: Under the hood it is a collar on listed options, netted across holders and hedged leg for leg. Atticus carries zero market risk.

Speaker note: This headline is the landing page; keep the deck and the product saying the same sentence. Do not explain options. If asked "how", one sentence: we buy the put and sell the call for them on a listed venue, and we never hold the difference. If asked "can the trader change the floor", the answer is no, and that is the point: the trailing stop asks for three settings, this asks for none.

---

## Slide 4: Why this beats the tools venues are shipping

**A stop gets you out. A floor keeps you in and pays you.**

| | Trailing stop | Earn & Protect |
|---|---|---|
| On a wick | Sells you out at the low | Floor holds. You stay in. |
| Cost | Free, then you eat the exit | Pays you a credit every week |
| Setup | Distance, activation price, size | One toggle. The engine picks the floor and the cap. |
| Undo | Re-enter and pay the spread again | The cap can be bought back at the live listed price; the floor stays either way |
| Who hedges it | Nobody. Your risk. | Atticus, leg for leg, on a listed book |

Footer line: A trailing stop is a promise you make to sell into a falling market. A floor is a promise someone else already made to buy.

(That is our public reply to Hyperliquid's trailing-stop announcement on September 21, the day our perp record restarted. The screenshot of both is on slide 8.)

Speaker note: This is the "why us and not the venue" slide. Venues ship exits because exits are free to build. A floor needs an options book, netting and a hedge desk. That is us. The "undo" row is a pocket fact, not a feature: the retail card does not show a release button, by design.

---

## Slide 5: Proof, two live public records

**Both products run in public. Append-only. Never re-marked.**

Perps (facility.atticustrade.com), since September 21:

- 410 positions protected · $16.3M notional · 0 quotes refused
- $14,763 credit to holders · 9.1 bps of notional · 45 early closes priced at the live book
- First weekly settlement, September 25: 68 settled · our P&L $548.44 = booked take $548.44 · gap $0.00

Event contracts (atticus-event-shadow.onrender.com), since September 12:

- 516 positions protected · 427 settled · 180 floor saves (42%)
- Our P&L on settled positions $116.83 = booked take $116.83 · gap $0.00
- Every hedge leg priced off Kalshi or Polymarket depth at the time of the trade

[Layout: the "we carry no outcome risk" images are this slide. Perp identity row (`assets/slide5_perp_record_identity_2026-09-25.png`) across the top, event identity block (`assets/slide5_event_record_kpis_2026-09-25.png`) beside or under it, both reading P&L = take, gap $0.00. Cut the bullets to two per product if the slide is crowded. This is the only slide that carries these images; slide 7 points back to it.]

Speaker note: The identity line is the whole slide. Our P&L equals our published take to the cent, on both products, because we never hold risk. Anyone can download the CSV and sum it. Refresh these numbers the morning you send. If asked about the first perp settlement: 68 positions, none fell to the floor, one ended past the cap and handed back $10.00 of gains against $13.71 of credit, 67 settled between the wings with the full credit; $2,193.60 went to holders.

---

## Slide 6: Event markets, embed instead of aggregate

**$16B a week now trades on Kalshi and Polymarket. Their traders have no floor.**

- New apps are showing up around the venues: aggregators, third markets, hedge tools. Every one pulls the trader off the venue and keeps the spread.
- We embed inside the venue. The trader never leaves. The venue earns a share of our take. Our hedge legs land on the venue's own book.
- A third-market app will not share revenue. A venue will not send its traders elsewhere to hedge. We solve both.

[Screenshot: `assets/slide6_event_phone_protected.png`. The Astros row protected inside "Your Exchange", the sheet reading "ends $70.59 or $102.09, +$4.59 added to your cash, Nothing to manage."]

One tap on the position row. Floor and cash shown before the tap. Three floor tiers when the market supports them; the default is chosen for the trader.

Small type: Kalshi and Polymarket Global weekly contract volume, September 14 to 20, 2026: $16.4B (Kalshi $15.3B). Roughly a third of Kalshi's daily flow arrives through Robinhood. Distribution wins this market; we are a feature inside the distribution.

Speaker note: Sports and crypto event markets settle in hours, so floor saves show up fast. Our record: 180 floor saves in 427 settled contracts. No venue offers this today and none can build it without a hedge desk.

---

## Slide 7: Business model

**We keep 20% of the credit. The trader keeps 80%. Venue fees pass through at cost.**

Live record, five days, $16.3M wrapped:

- Gross credit from the options book: $27,949
- Venue fees, passed through: $9,495
- Credit to holders, paid at each Friday close: $14,763
- Atticus: $3,691 (about 2.3 bps of notional wrapped)

- Fees fall with RFQ pricing and volume tiers. Every basis point saved goes to the trader and to us, in the same 80/20.
- Embedded venues take a share of our 20%. Set per partner.

Illustrative: $50M a day wrapped at today's take is about $4M a year. That is one mid-size venue.

Speaker note: Revenue is never trading P&L. The first Friday close booked $548.44 of take on 68 settled positions and our P&L was $548.44. If a partner asks what happens in a crash, the answer is on slide 5: the floor pays because the put pays; our number does not move.

---

## Slide 8: Why now

**The venues are saying it themselves.**

Three screenshots across the slide, one line under each:

1. `assets/slide8_hyperliquid_trailing_stops_with_reply.png`. Hyperliquid, September 21: "Trailing stops are now available for perp markets." Our reply beneath it. Line: The biggest perp venue ships exits. We ship the floor.
2. `assets/slide8_robinhood_hood_summit.png`. Robinhood, September 25: "The retail trader is evolving, and so is the options market." Steve Quirk with Cboe at HOOD Summit, September 29, on 0DTE and expanded access. Line: The biggest retail broker says options are the retail product now.
3. David Knox, CFO, Hyperion DeFi (Nasdaq: HYPD), public post, September 2026: bring non-native infrastructure teams onto Hyperliquid. Line: We replied. He took it to his CEO the same day.

Small type under the images: Hyperliquid about $240B perp volume in 30 days, roughly a third of all perp DEX volume. Kalshi and Polymarket $16.4B in one week, Kalshi's first $3B day September 20, a third of its flow arriving through Robinhood.

Footer line: We started 18 months ago. Both products run in public today.

Speaker note: Say each screenshot in one sentence and move on; the images do the work. The Knox item is the strongest line in the deck. Say it exactly as it happened and no more. Do not say a deal is in progress. Pocket facts if asked "why now" a second time: Kraken simplified options (July), Binance US stock options (September), SGX perps filed with the CFTC (September), the CFTC path for Hyperliquid via Bitnomial (Bloomberg Businessweek, September 24).

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
- "What breaks in a crash?" Our P&L is the published take, not the hedge. The records show the gap at $0.00 across 427 event settlements and the first 68 perp settlements. A crash pays floors from puts we already bought.
- "Can the trader undo it?" The position is the trader's the whole time; the collar runs to Friday. The cap can be bought back at the live listed price (shown on the institutional skin). Turning the toggle off is not a free exit and the card does not pretend it is.
- "Why is the fee drag 34% of gross credit?" Because we pay taker fees on a listed book with no volume tier. RFQ and tiers cut that, and the saving goes 80/20 to the trader and us.
- "Who is the customer?" The venue. The trader is the venue's customer and stays that way.

## Footer references, slide by slide

Short form is what goes in the slide footer. Long form is for the appendix or for anyone who asks. Every number on a slide has one line here; if a number is not here, it should not be on a slide.

### Slide 2: Problem

- $19 billion liquidated in 24 hours, 1.6 million traders, October 10, 2025, largest on record. Short: CoinGlass, Oct 10, 2025; Bloomberg, Oct 10, 2025. Long: CoinGlass data ($19.13B, 1,618,240 traders), reported in Bloomberg "Trump Tariffs Upend Crypto Market, Trigger Record Liquidations" (Pan, Shen, Weeks), October 10, 2025. About $16.6B of the total was long positions.
- Hyperliquid trailing stops. Short: Hyperliquid announcement, Sep 21, 2026. Long: app.hyperliquid.xyz/announcement, "New order type: Trailing stop", 9/21/2026.

### Slide 4: Versus the tools venues ship

- Trailing stop mechanics (distance or percentage, optional activation price, market order on retrace). Short: Hyperliquid announcement, Sep 21, 2026.
- Everything in the Earn & Protect column is our product; no external footer. Cite the demo URL in small type: earnandprotect.xyz.

### Slide 5: Proof

- All perp numbers. Short: facility.atticustrade.com, 2026-09-25 18:49 UTC. Long: public summary at /api/shadow and CSV at /api/shadow/positions.csv on the same host; ledger is append-only and every close is priced at the live OKX book at the time.
- All event numbers. Short: atticus-event-shadow.onrender.com, 2026-09-25 18:49 UTC. Long: same paths on that host.
- Write the timestamp on the slide. It is the honest way to show a number that moves every hour.

### Slide 6: Event markets

- $16.4B weekly contract volume, Kalshi and Polymarket Global, September 14 to 20, 2026; Kalshi $15.27B (92.9%); Kalshi's first $3B day, $3.17B on September 20. Short: DefiRate, Sep 2026. Long: DefiRate weekly prediction-market volume report for the week of September 14 to 20, 2026, citing platform data.
- Kalshi distribution through Robinhood, Coinbase, Webull, Moomoo; roughly one third of Kalshi's daily flow via Robinhood. Short: Artemis, Sep 2026. Long: Artemis data for the week ending September 13, 2026 (Kalshi $9.6B of $10.0B non-sports volume), as reported by Gate News and NBTC News, September 22, 2026. This is the softest number on the slide; if you want only hard footers, drop "one third" and keep the four partner names.

### Slide 7: Business model

- Gross credit $27,949, venue fees $9,495, credit to holders $14,763, Atticus $3,691, $16.3M notional. Short: facility.atticustrade.com, 2026-09-25.
- 2.3 bps of notional: $3,691 / $16.31M, our arithmetic.
- $50M a day is about $4M a year: 2.3 bps x $50M x 365 = $4.2M, our arithmetic; label it "illustrative" on the slide.
- 20% take: the live published share of the net credit; visible on every position in the public ledger (takeRule "share").

### Slide 8: Why now

- Hyperliquid about $240B perp volume in 30 days, about 36% of tracked perp DEX volume. Short: DeFiLlama, Sep 17, 2026. Long: DeFiLlama 30-day perp volume $239.2B as of September 17, 2026, reported by The Crypto Times (Sep 17) and Gate News (Sep 18). Rolling 30-day figures on DeFiLlama moved between $178B and $240B during September; use "about $240B" with the date or "over $175B" without one.
- Hyperliquid trailing stops. Short: Hyperliquid, Sep 21, 2026.
- Robinhood post. Short: @RobinhoodApp on X, Sep 25, 2026. Long: "The retail trader is evolving, and so is the options market," announcing Steve Quirk with Cboe's Rob Hocking and Henry Schwartz at HOOD Summit '26, September 29, 2026.
- David Knox post. Short: D. Knox (CFO, Hyperion DeFi, Nasdaq: HYPD), LinkedIn, Sep 2026. Long: public LinkedIn post; quote it from the screenshot, not from memory. Your reply and his answer are public comments on that post.
- Kalshi and Polymarket weekly figures: as slide 6.
- Perps $62 trillion in 2025 versus about $19 trillion spot (if used). Short: Bloomberg Businessweek, Sep 24, 2026. Long: Ryan Weeks, "US Embraces Perps, a $62 Trillion Crypto Trade Taking on Stocks," Bloomberg Businessweek, September 24, 2026; underlying figure from Pantera Capital citing CryptoQuant, 2025 centralized-exchange perp volume.
- CFTC path for Hyperliquid (if used). Short: Bloomberg, Aug 19 and Aug 31, 2026. Long: Trump at a White House event, August 19, 2026: CFTC Chair Michael Selig "working to bring Hyperliquid into the United States in a fully compliant and legal fashion" (Bloomberg, Aug 19); Payward (Kraken) in talks to route Hyperliquid-linked contracts through Bitnomial (Bloomberg, Aug 31).
- Speaker-note items. Kraken options: CoinDesk, Jul 19, 2026, USD-settled BTC and ETH options on Kraken Pro via RFQ; Alexia Theodorou: "The gap in crypto options isn't demand, it's design." Binance stock options: Binance press release, Sep 1, 2026, options on 1,000+ US stocks and ETFs for eligible non-US users via its ADGM broker-dealer (not available to US users; say "Binance adds US stock options", not "in the US"). SGX perps: CoinDesk, Sep 10, 2026, SGX obtained CFTC authorization under Regulation 48.10 to open its BTC and ETH perpetuals to US institutions (v5 said "files with the CFTC"; it is authorized, trading onboarding over the following one to two months).

### Slide 10: Ask

- No external numbers. The $50k collateral line is our estimate of initial margin for the first live hedge book at OKX and Kalshi; if asked, the perp record's netting card shows margin saved and margin used per snapshot.

### Not sourced, so not on a slide

- "1.6K demo sessions last week" (v5 slide 4): keep only if you have the analytics export.
- "Thirty years of retail data" (an earlier draft of slide 2): removed; there is no single source for it.
