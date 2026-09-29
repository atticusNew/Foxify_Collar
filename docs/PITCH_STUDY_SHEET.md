# Earn & Protect: pitch study sheet

**Living document.** Update it whenever any of these happen: a number on either public record moves materially, a venue or regulator does something that changes an answer, a question comes up in a real conversation that is not covered here, or an answer below turns out to be wrong. Every update goes in the changelog at the bottom with the date. Agents: when the founder reports a new development, an investor or partner question, or a market-structure change, update this sheet in the same PR as any related work.

**Last updated:** 2026-09-29. Numbers are from the live records on that date; refresh before any event.

---

## 1. The one line

- Perps: "One toggle puts a hard floor under a perp position and pays the trader a cash credit for it. The options market funds the credit; we hedge leg for leg."
- Events: "One button on a prediction-market position locks a floor and pays a cash credit at the tap. We hedge on the other side of the same game; the venue keeps the flow."
- Both: "Protection that pays. A floor under any open position, a cash credit for taking it, hedged leg for leg so nobody carries a view."

## 2. Elevator, 20 seconds

"Atticus is Earn & Protect. A trader has an open position, a BTC perp or a Kalshi position on tonight's game. One tap. They get a hard floor under it and a cash credit today. We fund the credit from the derivatives market and hedge every position leg for leg, so we carry no view on price and no view on who wins. It lives inside the venue's own app; they keep the flow and the ledger. Public track record since September, every quote and settlement recorded, our P&L equals our published take to the cent."

## 3. Explanation, 60 seconds (when they ask "how")

"Take a $100,000 long BTC perp. We buy a put 6% below price, that is the floor, and sell a call above it, that is the cap. The call is worth more than the put, so the pair produces a net credit. We pay that credit to the trader and keep a published share. If BTC drops, the put pays out and the trader never loses more than 6%. If BTC runs past the cap, the trader keeps everything up to the cap and hands back gains above it; the cycle ends and re-arms. Nothing moves. The position stays on the exchange, we hold no keys, and we never touch the perp itself. On prediction markets it is the same shape with different instruments: the floor is a slice of the opposing side of the same game or the market's own No, the credit comes from selling a slice of the upside, and it settles on the venue's official result. Both legs are placed the moment the user taps, so what we earn on any settled position equals the take we published. That identity is on the public record: $189.07 earned, $189.07 booked, gap zero."

## 4. Full pitch, 2 to 3 minutes

1. Problem (20 s). Retail runs directional positions with no protection. Existing tools (stop losses, options desks, cash-out buttons) cost money, need expertise, or move the money off the position. Industry leaders are describing this gap in print right now; nobody is shipping the fix.
2. Product (30 s). Section 3, cut to the perp example plus one sentence on events.
3. Why it works (20 s). Structural, not clever. Skew makes the upside slice worth more than the downside floor on most positions, so protection produces a credit instead of costing one. When the market cannot fund a credit, we refuse and say so. Refusals are on the record.
4. Proof (30 s). Three numbers per product from section 5, no more.
5. Distribution (20 s). API-first. Four JSON endpoints give a venue one white-label button. The venue keeps flow, ledger, relationship, and a revenue share of the published take. Embedded demo live; conversations open with sports exchanges and prediction markets.
6. Business model (15 s). A published share of the credit. On perps that ran 10.6 bps of protected notional. We never earn from the user losing.
7. Ask (15 s). See section 10. Confirm the current terms before any event.

## 5. Numbers to know cold

Refresh from the live pages before any event. Event record: the `atticus-event-shadow` service. Perp record: linked from `earnandprotect.xyz/video` ("track record").

**Events** (recording since 2026-09-12; as of 2026-09-28):
- 557 settled, 52 open. Floor paid on 237 (43%).
- Our P&L $189.07, take booked $189.07, gap $0.00. Zero outcome risk carried.
- Protection cost users 4.9% of unprotected payouts realized; 3.1% quoted up front.
- Sports slice: 223 settled, 2.89% quoted cost of expected value, -1.60% realized, our P&L $90.64 = take $90.64, $819.37 credits paid.
- Hedged on the market's own No: 388. Cross-venue on the same game: 220.

**Perps** (recording since 2026-09-21, weekly Friday expiry; as of 2026-09-28):
- 713 positions quoted, $25.6M notional protected, 506 long, 207 short. Zero refusals.
- $27,244 credited to users, 10.6 bps of notional. Our take $6,811.
- 68 settled, P&L $548.44 = take booked $548.44, gap $0.00.
- Users' P&L with collar minus without, settled: +$2,183.60.
- Floor 6% out; cap 4.1% out on average; 13 of 68 touched the cap, 1 ended past it.
- Netting: 33% of hedge legs cancel across the book; $3,454 of $10,620 OKX fees saved; margin $635k saved of $1.99M leg for leg.
- Venue spread paid 7.1 bps of notional. Basis HL mark vs OKX index 0.7 bps.

**Capital:** live event hedging needs roughly $3,500 on Kalshi and $7,500 on Polymarket at current shadow volumes. Perp hedge margin runs about 5 cents per dollar protected before netting, less after.

## 6. Objections and the answer you give

- **"So it is just a collar."** Yes, the instrument is a collar. The product is that it attaches to a position the user already holds, pays the user instead of charging them, and is hedged leg for leg so nobody carries the book. Nobody has shipped that to retail with a toggle.
- **"Why would a user pay for protection?"** They do not. They are paid. Cash at the tap, or vesting through the cycle.
- **"Where does the credit come from?"** From selling a slice of the upside. Call skew on BTC and the price of the winning side on a binary make the upside slice worth more than the floor. The market funds it, not us.
- **"Who is on the other side of the risk?"** The listed options market or the opposing side of the same event. Both legs placed when the user taps. Our P&L on any settled position equals the take we published; that identity is on the record with a zero gap.
- **"What if the hedge is not available?"** We refuse and say so. Zero refusals on 713 perp quotes; event refusals are recorded and counted. We never quote what the book cannot fund.
- **"Gap through the floor?"** The floor is a put, or the opposing side of a binary. It pays at settlement on the official print regardless of path. Gap risk sits with the option seller, who was paid for it. Our residual is basis between the perp mark and the options index, 0.7 bps at open.
- **"Counterparty risk?"** Cleared venues. OKX for options; CFTC-regulated DCMs for US events. We hold no user funds and no keys.
- **"Why won't the exchange build it?"** An exchange matches and clears; it does not want to price, hedge and warehouse a derivatives book against its own users. A partner who does that and takes a revenue share is the natural shape, the same reason exchanges do not run their own market makers.
- **"Why won't Deribit or OKX do it?"** They sell the options. They do not have the user's perp position or the venue relationship. We sit between the position and the options book.
- **"Regulatory?"** Perps: not a broker, not custodial; protection is written on listed instruments on a regulated derivatives exchange, and the user's position never leaves their venue. US events: we deploy through the venue's CFTC-regulated rails (Kalshi DCM, ProphetX DCM and DCO, Polymarket US ISV track); we do not run a US retail front door. CFTC Staff Letter 26-25 (2026-09-17) extends no-action relief to passive software front-ends; our router likely exceeds "passive" as-is and counsel review is the gate. Say "the B2B white-label path is clean; the direct-to-consumer path is a counsel question," and stop.
- **"Adverse selection."** Every quote is priced at the market's own odds and hedged at that instant. If the user knows something the market does not, the hedge counterparty carries it, not us.
- **"Low vol, tiny credits?"** We waive the take so the credit clears the minimum, or we refuse. The record shows both.
- **"Early exit?"** In the real product terms lock at the tap and the hedge is placed immediately; an early unwind is a new trade at live prices, never a free reversal. In the demo undo is free because nothing is bought.
- **"Competition?"** DeFi option vaults sell covered calls to yield hunters and do not attach to the user's own position. Bet-insurance charges a premium. Cash-out buttons take a spread. We sit on the open position, pay the user, hedge leg for leg, and publish the identity check.
- **"Traction?"** Shadow, not live volume, and every page says so. Two live demos, two public records, Polymarket builder attribution wired in, partner conversations open. The raise funds the hedge margin that turns the shadow into a live book.
- **"Why now?"** Prediction markets went mainstream and the industry is describing this problem in print. Hyperliquid has no options layer. Robinhood put a DeFi primitive (Morpho) behind a consumer product. Equities go 23/5 on December 6 and will discover that positions outlive their hedge markets. Always-on positions need always-on protection.
- **"Why you?"** Built the whole stack alone in months: pricer that walks the live book at size, cross-venue matcher, netting engine, refusal logic, public identity audit, two demos, two records. One sentence, then stop.
- **"The check is too small for us."** "Understood. I am building the relationship now so I am the first call at seed. Who in your network writes checks at this stage in this space?"
- **"Market makers will squeeze you."** The opposite. Our hedge cost is the spread we cross; every basis point SIG or DRW takes out of the book is a bigger credit to the user or a bigger take to us, with no code change. Market makers are our counterparties, and a market maker carrying sports inventory has the same unhedgeable outcome risk our users have: a hedged floor on inventory is a block product for them.
- **"Isn't a market maker already doing this?"** Market makers quote two sides of a contract. We attach a floor and a credit to a position a user already holds and settle it on the same official result. Different product; they are who we lay the hedge to.

## 7. What you can call defensible

Say these. Do not say "patent" unless a provisional is filed; if it is, "patent pending" and nothing more.

- Pricing engine: every wrap priced at its own size by walking the live book, with honest refusal when the book cannot fund a credit.
- Identity audit: our P&L must equal the published take on every settled position, checked and published on every settlement.
- Netting: 33% of hedge legs cancel across the book; fees, margin and slippage fall as the book grows. Scale moat.
- Cross-venue matching: Kalshi and Polymarket sides of the same game matched and hedged against each other.
- API-first partner shape: four endpoints, one button, revenue share. Integration is the venue's afternoon.
- The public record: append-only since September, every quote and settlement, CSV and JSON. It compounds daily and a competitor starts at zero.

## 8. Finance essentials, in the words you use

- Collar: long put at the floor, short call at the cap. Net credit when the call is worth more than the put.
- Why the credit exists on BTC: the cap is written closer than the floor (4.1% vs 6%), and skew prices upside richly.
- Why it exists on a binary: selling a slice of the winning payout above the cap funds buying the opposing side below the floor.
- EV cost (events): quoted cost of protection as a share of the position's expected value at the market's own odds. 2.89% on sports.
- User delta: realized protected minus naked, as a share of stake. Negative in a sample where favorites won; the floor is what it buys.
- The identity: writer P&L = take booked. Hedge pays the floor, cap slice pays the hedge, nothing depends on who won.
- Take: a published share of the credit, netted out before the user sees the number. The credit you see is the credit you get.
- Cycle (perps): weekly, Friday expiry at least three days out. Cap touch on a plain collar runs to expiry; the demo variant re-arms.
- P&L identity rule (house rule since 2026-09-20): any structure change that moves who keeps a payoff gets the identity re-derived and tested before it ships. The knockout collar shipped without it and measured negative-EV live; that is the incident.

## 9. Market structure: what is happening and how to talk about it

- **Market makers are already here.** Susquehanna set up a prediction-markets desk in 2023 and is Kalshi's flagship designated market maker (Kalshi said roughly 30x prior liquidity in covered markets). DRW is building a desk across Kalshi and Polymarket. Jump, Flow Traders, Wintermute active or hiring. Cantor Fitzgerald gives about 3,000 institutional clients block-trade access to Kalshi with SIG pricing (Aug 2026); Marex and Interactive Brokers connect institutions; Kalshi says institutional volume grew 800% in six months.
- **Legal on regulated DCMs**, and standard futures structure: designated market maker programs filed under exchange rules and CFTC core principles (Part 38); anti-fraud and anti-manipulation (Rule 180.1) apply to everyone; venues add insider rules for event contracts. Offshore Polymarket CLOB market makers are offshore entities; US persons and US operators cannot trade there.
- **Direction.** Spreads compress first where the maker can hedge (crypto, index, rates, FX). Sports and culture compress slower: no external hedge, real insider risk, makers skew rather than quote tight. Next: block trades and institutional risk transfer (SIG: "the next area of material growth"), FIX and FCM plumbing, DCO clearing, portfolio margin, spreads and combinations, eventually derivatives on event contracts. Cross-venue arbitrage pulls Kalshi and Polymarket prices together on the same game.
- **Gating question:** federal versus state jurisdiction on sports event contracts. CFTC Innovation Advisory Committee ran a prediction-markets session in Aug 2026. Institutions are in macro and crypto now; sports size waits on this.
- **Kalshi has a market-maker program** (kalshi.com/market-makers) with fee incentives; if live hedging qualifies, fees drop and the identity gets wider.
- **Equities always-on (Dec 6, 2026).** NYSE and Nasdaq 23/5; tokenized shares approved on the same Nasdaq book under the DTC pilot. Single-name listed options still close at 4pm, so a stock position will be open and unprotectable most of the day. Crypto never had that gap; that is why the perp product can attach protection to the position rather than to a session. Long-run tailwind, not a current wedge.

## 10. The ask

As of 2026-09-28 (founder, in conversation): $250k to $500k pre-seed at a $5M post-money cap; funds hedge margin for the founding cohort, the regulated deployment path for US event venues, and two hires. `docs/AGENT_HANDOFF.md` (2026-09-18) records "$2M seed at a $10M cap, $250K first-close tranche." Confirm which is current before any event and update both.

Fit check for the room: Strobe Ventures writes $1M to $3M first checks at 7% to 10% ownership; below that size, the ask to a fund like that is a relationship and names, not a check.

## 11. Delivery rules

- User experience first, mechanism second, proof third. Never mechanism first.
- Three numbers per product, maximum. Offer the record link for the rest.
- When you catch yourself explaining a second time, stop and ask "what would you want to see?"
- Never say "carry the risk." Say "hedged leg for leg" and "no view on price."
- Never say "simulated" without "live prices" in the same breath; never say "live" about the record without "shadow."
- Say "we refuse when the market can't fund a credit" early. It is the most credible sentence you own.
- End every conversation with one ask that costs nothing: a two-week shadow on their book, or one name.

## 12. Questions to expect as the markets mature (prepare, not yet asked)

- "Kalshi just launched X (parlays, spreads, options on contracts). Does that break or help you?" Frame: more instruments means more hedge legs and tighter replication; the identity still has to be re-derived per structure.
- "What happens to your credit when spreads go to a penny?" Bigger credits, smaller take per dollar, more volume. Model both.
- "Polymarket US is live; why do you need Kalshi?" Cross-venue is the point: two books on the same game means a tighter floor.
- "How do you handle a voided or postponed game?" Void follows the venue's official rule; both legs unwind at the venue's void price; the record shows voids separately.
- "What is your exposure to a venue outage mid-hedge?" One leg filled, one not: name the refusal-and-unwind rule and the time window. Have the number.
- "Portfolio margin at OKX: how much capital per $1M protected, netted?" Roughly 5 cents per dollar before netting; state the netted figure from the record.
- "If a sportsbook wanted to hedge liabilities through you, could they?" Yes in shape; block size and DCM access are the constraints; SIG and Cantor are building exactly that pipe.
- "Have you talked to counsel about Letter 26-25?" Answer with the gate, not a conclusion.

## 13. Changelog

- 2026-09-29: Created. Sections 1 to 11 from the study guide delivered 2026-09-28; section 9 adds the market-maker and institutional-entry picture (SIG, DRW, Cantor, Marex, IBKR), the 23/5 equities point, and Letter 26-25 wording; section 12 seeds questions to expect. Numbers as of 2026-09-28. Flagged the ask discrepancy with `AGENT_HANDOFF.md`.
