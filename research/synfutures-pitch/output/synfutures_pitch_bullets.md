# SynFutures Pitch — Email Bullet Inventory

Drop-in bullets organized by category. Pick and combine for the email.

---

## A. Subject lines
- Real options hedging for SynFutures BTC/ETH perp traders, no integration required
- A 1-ticket Deribit hedge for your BTC/ETH perp users
- Cutting realized drawdowns ~30-50% on adverse-move SynFutures perps
- Bringing Deribit options depth to your perp traders

## B. Trader-value bullets (drawdown story)
- Across 500 simulated SynFutures-style retail perp trades on BTC/ETH (Jan 2024 – Apr 2026), our protection cuts median drawdown by **52% of margin** on adverse-move trades, with the inter-quartile range 27-100%.
- 94 of 500 simulated unhedged trades would have liquidated; the hedge prevented 88 of those (94%) liquidations.
- A trader on a $5k 10× BTC long who suffers a -10% adverse move loses 100% of margin unhedged; with our spread the realized loss drops to ~30-50% of margin.

## C. Capital efficiency bullets
- Average premium is **5.40% of protected notional** (single-premium tier) and **5.28%** (day-rate tier). Both sit at the bottom of bank-OTC vertical-spread pricing (typical 2-5%).
- For a typical $5k notional perp, premium runs ~$270-264 for 7-14 days of protection.

## D. Venue-revenue bullets
- Premium runs 323-437 bps of notional traded across our dataset; under a 50/50 rev-share that's 162-218 bps to the venue.
- At $20M monthly perp volume with 50/50 rev-share: **$323,324/month** of incremental venue revenue (single-premium tier; day-rate similar).
- At $50M monthly perp volume with 50/50 rev-share: **$808,309/month** of incremental venue revenue (single-premium tier; day-rate similar).
- At $100M monthly perp volume with 50/50 rev-share: **$1,616,619/month** of incremental venue revenue (single-premium tier; day-rate similar).

## E. Mechanism bullets
- We use Deribit's public API for live pricing and our existing Deribit account for execution. No SynFutures credentials, no integration on your side.
- Pure pass-through: we don't take the other side of perp positions, don't make markets, don't warehouse risk. The Deribit hedge is funded at user entry and settles independently.
- Two product variants: single premium (one fee at entry, residual refunded on early close) or pay-as-you-go day rate. Side-by-side benchmarked in the deck.

## F. Pilot proposal
- Zero-integration shadow pilot on your settled perp data: we publish a 'what if Atticus had been live' trade log over 4-6 weeks before any commercial commitment.
- Already live with a related drawdown-protection product on Foxify (separate pilot, same operational pattern: Deribit-hedged, pure pass-through).