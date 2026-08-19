# Earn & Protect: One-Tap Position Protection

## A Specification and Live Record

**Atticus (atticustrade.com) · Michael [surname] · First published August 2026 · v1.0**

---

## Abstract

Earn & Protect is a protection layer for exchange positions, delivered as a single toggle inside the venue's own interface. When a trader activates it on an open position, the system buys a protective option below the position (a hard floor), sells an option above it (a cap), and pays the trader the difference as a cash credit at each daily cycle's conclusion. Protection re-prices and renews itself at each daily fixing for as long as the toggle stays on. Every leg is a real order on a listed options venue, every credit is auditable to an exchange fill, and when the market cannot fund a credit the system declines and states the reason. This document specifies the product's guarantees, records its first live executions, and states the claims we believe are novel.

## The mechanic, in one sentence

Sell a call above the position, buy a put below it, pay the trader the difference daily, and re-strike both every morning.

The trader's economics: a hard floor roughly 6% below entry (losses stop there), a credit that vests through the day and pays at the cycle's conclusion, and a cap on that single day's upside, roughly 1.5 to 2% above. If the market touches the cap, protection ends for that cycle — the hedge closes, the trader keeps the position and every gain to the cap plus the credit vested to the touch, and protection re-arms at the new price on the next renewal while the toggle stays on. No trader ever owes anything. Because the structure re-strikes daily, the cap ratchets upward in rising markets: the trader sells only each individual day's tail, never the whole rally. The credit is funded entirely by the options market. The trader pays nothing, deposits nothing, moves nothing, and keeps custody throughout.

## The guarantees

These are engineering commitments enforced in code, not policies.

1. **Honest refusal.** If live order books cannot fund a positive credit net of real venue fees, activation is declined with the reason stated. The system never manufactures a credit, never subsidizes one, and never rounds a position up to make one work.
2. **Never worse than quoted.** A fill that comes in below the quoted credit is not booked. The hedge pair is unwound and the activation is refused. Price improvements pass to the trader; degradations are rejected. In our live record to date, every fill has settled at or above its quote.
3. **Full auditability.** Every credit traces to a named instrument, a real order, and the hedge venue's own fill and settlement records. Positions are reconciled against the venue's delivery prints, to the cent.
4. **Atomic execution.** Both hedge legs fill or neither stands. Partial fills are unwound automatically, short leg first.
5. **No fee inside the structure.** The quoted credit is the market's own price. Platform economics are a separate, disclosed, venue-paid fee line. Nothing is embedded in the trader's terms.

## The live record

All events below executed on real money, on listed venues, with the position held on a live perpetuals exchange. Venue ledger screenshots accompany the published version.

- **Aug 15, 2026, 14:07 UTC.** First live activation. One-tap wrap of a 0.01 BTC long: bought BTC-USD-260816-59000-P, sold BTC-USD-260816-63400-C, both filled within seconds as taker orders. Net credit $0.04 against a $0.02 quote; the improvement passed to the position.
- **Aug 16, 08:00 UTC.** First settlement. Both legs expired out of the money at the venue's fixing of 62,993.21. Zero settlement fees. The credit was kept in full.
- **Aug 17, 08:53 UTC.** First autonomous renewal. With the toggle still on, the system concluded the expired wrap, re-read the position, re-priced the morning book, and executed a fresh pair (60000-P / 64250-C) with no human involvement. Filled $0.04 against a $0.02 quote.
- **Aug 18, 08:00 UTC.** Second settlement, again out of the money, at a fixing of 64,171.11: $79 inside the cap. Second autonomous renewal followed within a minute (60000-P / 65500-C), filled $0.06 against a $0.04 quote. Across three days of a rising market, the cap ratcheted from $63,400 to $64,250 to $65,500 and the floor from $59,000 to $60,000: the protection followed the market up.
- **Carry economics, same week.** The underlying position paid $0.33 in perpetual funding while protection credits returned $0.12, at the smallest possible position size and the least favorable pricing tier. At institutional block pricing, measured on our simulation tape at 8.4 basis points per day, the credit exceeds typical funding: the position pays its own carry.

Separately, a 30-day systems tape (simulated settlement, live market pricing, zero capital at risk) processed $4M+ of wrapped notional across 80+ positions at $50,000 scale: 100% price-feed verified, 100% reconciled, zero protection floors breached, caps reached on 2.6% of position-days, and trader outcomes net positive all-in.

Small numbers are shown deliberately. Credits scale linearly with position size, and pooled positions hedge at block pricing. The point of this record is not the size of the numbers but that every one of them is real and third-party verifiable.

## Architecture

A venue adapter reads positions (exchange API or integration); a pricing engine quotes executable protection off live listed order books; an execution layer places band-capped orders with atomic pair semantics on the hedge venue; settlement reconciles against the venue's own delivery records; a renewal loop re-strikes daily while the toggle is on. The hedge layer is venue-agnostic: live today on international listed venues, with a US-regulated path designed in through CFTC-regulated CME options and ISDA-documented OTC with a registered swap dealer. Venue integrations require position reads and one UI element; the venue's settlement rails enforce cap give-backs the way funding payments already work.

## Claims

We believe the following, in combination, are first: (1) one-tap collar protection embedded in a live exchange interface, executed with real listed options; (2) autonomous daily re-strike of retail position protection, demonstrated live; (3) a contractual never-worse-than-quoted execution guarantee enforced by automatic unwind; (4) refusal-as-a-feature: protection that declines transparently when the market cannot fund it; (5) pass-through pricing with zero spread embedded in the trader's terms. This document and its timestamps stand as the record.

## Build record — direct-to-trader engine (Phase 1, Aug 2026)

Shipped on top of the demo engine, all covered by unit tests and exercised end-to-end in paper mode:

- **Knockout cycle (Design B).** A mark-price monitor watches every active wrap; a touch of the cap (no buffer, side-aware) closes both hedge legs — the existing order-book unwind path in live lanes — marks the cycle `knocked_out`, and re-arms at the new spot on the next renewal tick while the toggle stays on.
- **Credit paid at conclusion.** Every cycle end (expiry, knockout, voluntary early close) settles through one path: full credit at expiry plus the protective payout if the fixing landed through the floor; vested-to-touch on knockout; vested-to-close on early close.
- **Payout ledger + USDC rail.** Each concluded cycle accrues exactly one ledger entry (`accrued → queued → paid → confirmed`, with a manual-verification lane for failures) payable only to the verified position-owner's address, structurally. Sends are idempotent — an entry can never pay twice — and bounded by a per-day outflow cap. Rail: Arbitrum USDC behind an explicit arming chain; simulated in paper mode.
- **Staggered renewals.** Daily options share one fixing, so each account re-wraps at its own deterministic anchor inside a configurable window, landing renewals on different strikes as spot moves instead of stacking the book on one.

## Build record — production hardening + trader clients (Phase 2, Aug 2026)

- **Caps as formulas.** Book cap = 60% of sub-account capital ÷ measured per-wrap margin rate ($10k, 12% ⟹ $50k at launch); per-wallet cap = book ÷ 25 target wallets (floor of one lot); per-strike concentration ≤30% of book. One env input per lever — raising capital raises every cap. Oversized positions wrap partially (min(position, remaining wallet cap), floored to whole lots) with plain coverage copy; the book counts hedged notional, never raw position size.
- **Cohort economics.** First 50 wallets register as founding on their first fill (10% take locked 12 months; 20% standard; the cut is waived under $0.05 a cycle); wallets beyond waitlist honestly. Every surface quotes the trader's net number; the gross/take split is recorded on the wrap.
- **Production spine.** Postgres persistence behind one store interface (JSON files remain the dev default) with a one-shot migration; boot reconciliation of open wraps against live OKX option positions; fail-closed admin auth; per-IP rate limits; idempotent wrap requests; alert fan-out (disk, webhook, Telegram) for stalled loops, payout failures, venue connectivity, unwinds, and margin utilization; a persisted kill switch (manual or margin-triggered) that pauses new wraps and renewals while conclusions and payouts keep running.
- **Two thin clients, one API.** A canonical JSON API (documented in `earn-protect-api.md`) serves the trader web app (read-only address connect, positions, one toggle, live wrap card, payout history with tx links) and the Telegram bot (address once, inline protect buttons, push notifications for every cycle event). A partner integration consumes exactly the same routes.

## Roadmap

Pooled activation: many positions netted internally, residual risk hedged as institutional blocks, with block economics inherited by every participating position. Additional venues, the US-regulated hedge stack, lending-collateral protection, and multi-asset extension via listed options.

---

*Atticus builds protection infrastructure for trading venues. The venue interface shown in our demonstrations is an overlay for placement illustration; the venue is not a partner. Positions, orders, fills, credits, and settlements referenced in the live record are real and documented. Nothing in this document is investment advice. Contact: hello@atticustrade.com.*
