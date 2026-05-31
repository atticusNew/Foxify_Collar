# Hyperliquid Pitch — Email Bullet Inventory

Drop-in bullets organized by category. Pick and combine for the email.

---

## A. Subject lines
- Drawdown floors for HL perp traders, no integration required
- Cutting median liquidation rate on HL BTC/ETH perps with a Deribit-hedged overlay
- A defined-risk product wrapper for HL perps that doesn't touch HLP
- Atticus → HL: live-tested perp protection, ready for shadow pilot

## B. Trader-value bullets (drawdown story)
- Across 500 simulated HL-style retail+whale perp trades on BTC/ETH (Nov 2023 – Apr 2026), our protection cuts median drawdown by **52% of margin** on adverse-move trades, with the inter-quartile range 27-100%.
- 89 of 500 simulated unhedged trades would have liquidated; the hedge prevented 84 of those (94%) liquidations.
- A trader on a $5k 10× BTC long who suffers a -10% adverse move loses 100% of margin unhedged; with our spread the realized loss drops to ~30-50% of margin.

## C. Capital efficiency bullets
- Average premium is **5.55% of protected notional** (single-premium tier) and **5.38%** (day-rate tier). Both sit at the bottom of bank-OTC vertical-spread pricing (typical 2-5%).
- For a typical $5k notional perp, premium runs ~$277-269 for 7-14 days of protection.

## D. Venue-revenue bullets (HL-scale)
- Premium runs 302-404 bps of notional traded across our dataset; under a 50/50 rev-share that's 151-202 bps to HL.
- At $50B/month perp volume with 50/50 rev-share and 3% adoption: **$22,650,845/month** of incremental venue revenue.
- At $150B/month perp volume with 50/50 rev-share and 3% adoption: **$67,952,534/month** of incremental venue revenue.
- At $300B/month perp volume with 50/50 rev-share and 3% adoption: **$135,905,069/month** of incremental venue revenue.

## E. Mechanism bullets (HL-specific)
- We use Deribit's public API for live pricing and our existing Deribit account for execution. No HL credentials, no smart-contract integration, no impact on HLP.
- Pure pass-through: we don't take the other side of perp positions, don't make markets, don't warehouse risk. The Deribit hedge is funded at user entry and settles independently.
- Sits orthogonal to HLP — unlike a venue-internal hedging product, this doesn't compete with HLP for fills or affect HLP's risk profile.
- Two product variants: single premium (one fee at entry, residual refunded on early close) or pay-as-you-go day rate. Side-by-side benchmarked in the deck.

## F. Pilot proposal
- Zero-integration shadow pilot on HL public trade-stream data: we publish a 'what if Atticus had been live' trade log over 4-6 weeks before any commercial commitment. HL's public API + ws stream make this trivially easy on your side.
- Already live with a related drawdown-protection product on Foxify (separate pilot, same operational pattern: Deribit-hedged, pure pass-through).
- Optional ecosystem alignment: rev-share tilted toward HYPE token holders / HL builders code, structured as a partner integration rather than competing product.