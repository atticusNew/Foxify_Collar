> Internal reference, not for prospects. Names other venues, dealers and timing that stay off every public and prospect-facing surface.

# Prediction market stack: reference chart

Volume shares are 30-day exchange-reported notional through Oct 11, 2026 (Volume Race, DeFi Rate).

## Table 1: The layers

| Layer | What it does | Who is in it | How it connects | Relevance to us | What we need from it | When |
|---|---|---|---|---|---|---|
| Regulator | Licenses exchanges (DCM) and clearinghouses (DCO), sets what contracts can list, decides the state-vs-federal fight | CFTC; state AGs and tribes on the other side | Everyone below exists by its permission | Decides whether sports contracts survive; decides what we are (software layer vs IB vs swap counterparty) | A counsel memo: who is the counterparty to the retail user, and are we soliciting | Before first live venue |
| Exchange (DCM/DCO) | Lists the binary contracts, runs the order book, clears and settles at $1 or $0 | Kalshi, Polymarket US, Polymarket intl, Crypto.com CDNA, Novig, Railbird (DK), Rothera, Underdog, ProphetX, Gemini, ForecastEx | Storefronts route orders in; market makers quote on it; we buy hedges on it | Where our hedges execute and where official results come from. We are flow to them, not a customer | Market data, partner API and fee tier, block or RFQ access later, tolerance of our hedging | Now (data) to 6 months (partner API) |
| Storefront | Owns the trader, the app, the brand; sells the exchange's contracts in its own UI | Coinbase, Webull, PrizePicks, Robinhood (also part exchange owner), FanDuel, Fanatics, Truth Predict, Players' Lounge, sportsbooks | Routes orders to one exchange; keeps the customer | Our customer. The embed lives in their app under their brand | Integration, placement in the position screen and parlay flow, rev share on take, payout pass-through terms | Now; two or three live in the next quarter |
| Integrated venue | Owns both the storefront and the exchange | Kalshi, Polymarket, DraftKings via Railbird, Underdog, Novig, ProphetX, Crypto.com | One company, both roles | Both a hedge venue and a possible customer; also the likeliest copier (a button on its own book) | Same as storefront, plus willingness to let a neutral layer sit on their book | Mid-tier now; Kalshi and Polymarket only after storefront wins |
| Market maker / liquidity provider | Quotes two-sided on the books; block-size liquidity; prices bespoke risk | Susquehanna (largest, 45% of Rothera), Wintermute, Jane Street, IMC, Jump; FalconX as OTC dealer | Sits on every exchange; bilateral with institutions | Today: the other side of our hedges, invisibly. Later: RFQ counterparty for net residuals. Also a possible rival for the venue relationship as a structured-product seller | Quote-only RFQ feed that must beat the public book; nothing until flow and LOI | After LOI; blocks only when net residual exceeds 25k contracts |
| Execution and prime | Algos, consolidated risk, OTC access for institutions | Kemet (execution), FalconX (prime and OTC), Cantor (IB for blocks) | Plumb institutions into exchanges and dealers | Not needed at our size; relevant when net hedges move thin books | Nothing now | 12 months plus |
| Clearing and settlement | Holds collateral, pays $1 or $0, finalizes the result | The DCOs | Under every exchange | Official results are our settlement source; rule text we pin comes from here | Stable result APIs, rule text at a URL | Now (have it) |
| Protection layer | Floor, cap, cash credit on any position; last-leg lock on parlays; hedged leg for leg across books; identity published | Us. Nobody else today | Embedded in storefronts; hedges on exchanges; later routes residuals to dealers | This is the seat | Live integrations, flow, a counsel paragraph, a data room | Now |
| Data and reporting | Volume trackers, press, conferences | Volume Race, DeFi Rate, DefiLlama, NEXTPredict, trade press, LinkedIn | Shape which venues are seen as winning | Where "first to build it" gets written down; where storefronts learn they need a feature | Our record cited; our flow line counted | Ongoing |

## Table 2: The players

| Player | Layer | Owns or routes | Scale (30 days) | Will last? | Relevance to us | What we want | Ask | When |
|---|---|---|---|---|---|---|---|---|
| Kalshi | Integrated venue | Owns exchange and app; Coinbase, Webull, PrizePicks route here | 76% | Yes | Hedge venue, result source, likeliest native copier; pitched Dec 2025, silent since | Be visible flow; partner API later | None now. Show up with a routed storefront live | After first storefront win |
| Polymarket (US and intl) | Integrated venue | Owns both; builder program for third parties | 12% US, 5% intl | Yes (ICE $1.6B) | Hedge venue for sports today; US entity is the live-product path | Builder-program access, fee tier | Builder application when live | 3 to 6 months |
| Robinhood | Storefront, part exchange owner, FCM | Owns part of Rothera; routes partly to Kalshi and ForecastEx; stakes in Crypto.com and OG | 1.4% own exchange plus routed | Yes | White whale: options-literate retail, multi-venue, FCM | Embed in the event-contract position screen | Warm intro only; no cold pitch | 6 to 18 months |
| Rothera | Exchange and clearinghouse, institutional only | Owned by Robinhood, SIG (45%), MIAX; serves FCMs and MMs, no retail app | 1.2% | Yes | Future hedge venue via an FCM host; SIG is in the building | Access through a host FCM | None directly | When a host is on it |
| DraftKings (Railbird) | Integrated venue | Owns exchange and app | 3%, up 6.8x | Yes | Top acquirer and partner fit; 61% combos; cash-out replacement | Last-leg lock in the parlay flow | Slate built, meeting at NEXTPredict | Now |
| IG, Underdog, tastytrade | Integrated venue plus broker parent | Underdog owns its exchange; IG acquiring; tastytrade is defined-risk culture | 1% | Yes (public parent) | Best cultural fit, most reachable whale | Pilot on Underdog's app; tastytrade audience later | Slate built, meeting at NEXTPredict | Now |
| Crypto.com (CDNA) | Exchange, white-label hub | Owns exchange; FanDuel, Fanatics, Truth Predict route here | 2% | Yes | One deal, several storefronts; needs the brand to say yes too | Protection as a primitive in their white-label stack | Intro via any of their brands | 3 to 9 months |
| FanDuel | Storefront | Routes to CDNA; CME behind the product | Inside CDNA's 2% | Yes | Big brand, dependent economics | Embed, with CDNA's blessing | After CDNA or after a DK win | 6 to 12 months |
| Fanatics | Storefront | Routes to CDNA | Inside CDNA's 2% | Yes | Partners more than builds | Embed | Direct, after a slate | 3 to 9 months |
| Coinbase | Storefront | Routes to Kalshi | Counted at Kalshi | Yes | Crypto strikes and the perp collar; huge base; slow builder | Embed for crypto line first | Warm intro | 6 to 12 months |
| PrizePicks | Storefront | Routes to Kalshi | Counted at Kalshi | Likely | Parlay-native users, no exchange; last-leg lock bullseye; same-venue hedge | Embed in pick'em flow | Direct, slate built | Now |
| Webull | Storefront | Routes to Kalshi | Counted at Kalshi | Likely | Trader audience, options-literate | Embed | Direct | 3 to 6 months |
| Novig | Integrated venue | Owns exchange, sports only | 2%, raising at $2B | Likely | Strong tier-two partner, tech-forward | Pilot | Meeting at NEXTPredict | Now |
| ProphetX | Integrated venue, B2B push | Owns exchange and clearing; $35M; distributing via Players' Lounge | 0.3% | Possible | Thinks in layers already; partner or distributor of us | Pilot and B2B co-sell | Meeting at NEXTPredict | Now |
| Gemini, ForecastEx (IBKR) | Exchanges | Own | under 0.1% | IBKR yes, Gemini unclear | Low priority; IBKR audience is pro | Nothing now | None | Later |
| Limitless, Predict, WagerWire, ESX | Long tail (on-chain or niche) | Various | Not tracked | Mostly no | Proof-of-concept hosts at zero cost; non-exclusive only | Cheap integrations, no dependence | Rev share, short terms | Opportunistic |
| Susquehanna (SIG Predictions) | Market maker | Quotes on Kalshi and others; 45% of Rothera; prices bespoke risk for brokers and insurers | Largest MM in the space | Yes | Future RFQ counterparty; possible rival for the venue relationship; conflicted by construction | Quote-only feed that must beat the book | Nothing until LOI | After LOI |
| Wintermute, Jane Street, IMC, Jump | Market makers | Quote on exchanges, crypto-native books | Large | Yes | Second-tier RFQ counterparties, crypto side | Same | Nothing now | After LOI |
| FalconX | Prime and OTC dealer | OTC event contracts for ECPs; backs Kemet | Institutional | Yes | Dealer for the crypto line and perp collar; already an adapter in our code | Quote-only | Nothing until LOI | After LOI |
| Kemet | Execution platform | Algos into Kalshi, Deribit, OKX, Hyperliquid, one risk book | Institutional | Likely | Only when our net hedges move thin books | Nothing | None | 12 months plus |
| Cantor | Introducing broker for blocks | Kalshi blocks with SIG pricing | Institutional | Yes | Block path when net residual is block-sized | Nothing | None | 12 months plus |
| CME, ICE, MIAX | Traditional market infrastructure | CME behind FanDuel, ICE in Polymarket, MIAX in Rothera | Capital, not volume | Yes | Proof the institutional thesis is real; names for the podcast | Nothing | None | Narrative now |
| Kambi, OpenBet, cash-out engines | Sportsbook platform vendors | Serve books, not exchanges | n/a | Yes | Could add hedged cash-out for book clients; slow | Watch | None | 2027 |
| NEXTPredict, trade press, Volume Race | Data and reporting | Rank venues, write the narrative | n/a | Yes | Where "first" gets recorded and where storefronts learn they need us | Record cited, flow line counted | Timeline to one reporter | 10 days |

## Table 3: How it connects (follow one protected position)

| Step | Who | What happens | Our role |
|---|---|---|---|
| 1 | Trader in a storefront app | Holds 150 Chiefs contracts bought on the exchange the storefront routes to | None yet |
| 2 | Storefront (our embed) | Shows "Protect": floor, cap, cash credit, priced from the public books across exchanges | Pricing engine, UI under their brand |
| 3 | Trader taps | Credit lands in the trader's account at the venue; terms locked | Credit identity; take published inside it |
| 4 | Exchange(s) | We buy the hedge leg on the public book the same second, on Kalshi or Polymarket, whichever is better after fees; a market maker is on the other side | Hedge executor; rule text pinned |
| 5 | Dealer (later) | If the net residual across many positions is large, we RFQ it; the dealer must beat the book | Netting and RFQ module |
| 6 | Clearinghouse | Game ends; contract settles $1 or $0 officially | Read the result and the rule text again |
| 7 | Storefront | Trader receives cap if right, floor if wrong, credit kept either way; venue pays through its own balance | Settlement math, receipt, record |
| 8 | Public record | Position appears on the ledger; identity checked: our result equals the take whoever won | Proof |

## Table 4: Where we sit

| Question | Answer |
|---|---|
| What are we | The protection layer: floor, cap, cash credit on any position; last-leg lock on parlays; hedged leg for leg; identity published |
| Who is our customer | Storefronts and integrated venues. Never the trader directly |
| Who is our supplier | Exchanges (hedge venues and results), later dealers |
| Who do we compete with | Nobody today. Tomorrow: a native button on an exchange's own book, house cash-out, dealer-structured protection |
| Why exchanges should want us alive | We put contracts on their books. Measure it, publish it |
| Why storefronts need us | They all sell the same contract; we are the feature routing can't copy |
| Why market makers should want us | Net residual flow in size, with a public price to beat |
| What we must never become | A consumer destination, a routing fee, a toll on someone else's product (the Fireplace pattern) |
| The one paragraph to know cold | Who is the counterparty to the retail user, and why we are not soliciting trades on a DCM |
| Our moat, in order | Live integrations, the parlay flow, the public ledger and identity, cross-venue pricing and later execution quality, the protected-trader data |

## Numbers to carry

- Record live since Sep 12, 2026: 739 settled, identity gap $0, 314 floor saves, 425 cap give-ups
- Protection cost to the user: about 1.3% of stake on sports, 2.4% overall
- Median sports credit: about 6% of position value at the tap; median floor about 65% of position value; median cap about 115%
- Take: a quarter of a percent of stake, ten percent of gross credit, published
- Netting measured: 120 two-sided games, same-window pairs cost 101.6c per matched dollar
- Market: Q3 2026 $189B notional, +81% QoQ; Kalshi 76%, Kalshi plus Polymarket 93%; combos 58% of volume
