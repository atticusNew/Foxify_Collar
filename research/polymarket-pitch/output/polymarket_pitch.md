# Atticus → Polymarket: Options-Hedge Bridge (Exploratory 1-Pager)
*Generated 2026-04-28 | 32 settled Polymarket BTC markets, Jan 2024 – Mar 2026 | Two tiers tested*

---

## What this is

Atticus runs a hedge-bridge product live on Foxify (BTC perps) and built a similar pitch for Kalshi (BTC binaries, PR companion). For Polymarket BTC traders, the same mechanism applies: trader buys a Polymarket BTC YES position, Atticus simultaneously buys a real Deribit BTC put-spread sized to that bet. **Pure pass-through — no MM behavior, no warehousing, no Polymarket-side integration required.**

---

## The two tiers, in one table

Reported in **% of trader's at-risk stake** so the numbers are stake-size-agnostic.
Recovery numbers report **median** (not just average) to avoid a single outlier inflating the story.

| | Standard | Shield |
|---|---|---|
| **Fee** (median, % of stake) | 14.2% | 20.5% |
| **Median hedge payout on BTC-adverse losers** (% of stake) | 25.0% | **35.8%** |
| **Median net save after fee** (% of stake) | 10.0% | **14.1%** |
| Trigger rate on BTC-adverse losers | 100% | 100% |
| Atticus gross margin per bet | ~28% | ~28% |

**Read the bottom row first.** On Polymarket BTC markets where the trader bet YES and BTC moved AGAINST that bet, Standard typically gives back ~10% of stake net of fee, Shield ~14%.

---

## What this looks like in dollars

Median BTC-adverse losing market, scaled to typical Polymarket stake sizes:

| Stake | Unprotected loss | Standard fee | Standard net loss | Shield fee | Shield net loss |
|---|---|---|---|---|---|
| $40 | -$40 | $5.70 | -$35.70 | $8.21 | -$33.91 |
| $100 | -$100 | $14.24 | -$89.24 | $20.52 | -$84.77 |
| $250 | -$250 | $35.60 | -$223.10 | $51.29 | -$211.91 |

On a **$100 stake** in a typical BTC-adverse losing month, Shield reduces a -$100 loss to roughly -$84.77 after fee.

---

## Single-market case study (best save in dataset)

**PM-25OCT-110000** — *"Bitcoin reach $110k by Oct 31?"* (2025-10-01 → 2025-10-31)
BTC moved **-7.67%** from $118,660 to $109,555 during the market window.

On a $100-face YES bet at 65¢ ($65 at risk):

- **Unprotected:** -$65.00 (full at-risk loss)
- **Standard:** fee $7.16, hedge paid $16.25. Net: -$55.91
- **Shield:** fee $10.35, hedge paid $23.40. Net: -$51.95

---

## Where the hedge does NOT help (and why we lead with that)

Of the 24 losing markets in the dataset, only **13** had BTC actually move against the bet by enough for the hedge to engage. The other 11 losing markets were what we call "OTM-target losers" — e.g., `BTC > $120k by Jan 31` resolves NO if BTC stays at $100k. The trader lost on the binary, but BTC didn't move against them in the way an option can hedge.

**This is the most important sentence in the pitch:** Atticus protection is BTC-direction insurance, not Polymarket-outcome insurance. For markets where YES requires a specific BTC level move, the hedge fires when BTC moves against the trader. For markets where YES is OTM-target ('will BTC reach X?'), the hedge protects against further drawdown but does not refund the OTM-bet loss itself. Communicating this honestly is what keeps the product credible (and what we got right after iterating with Kalshi feedback).

---

## Why this is interesting for Polymarket specifically

- **No native protection product on the venue.** Closest alternative for a Polymarket BTC trader is opening a separate Deribit/CME account — high friction, near-zero adoption.
- **Atticus is operationally ready.** Already live with Deribit hedging on Foxify (BTC perps). No infra ramp.
- **Zero Polymarket-side integration to start.** We work off public market data + each user's own bet ticket. Could shadow-pilot for several weeks before any commercial commitment.
- **Capital efficient vs OTC.** Hedge cost runs ~3-5% of protected notional vs bank-OTC verticals at 2-5% with $50k+ minimums and 6-week procurement.

---

## What's different from a Kalshi pitch

- **Drops institutional-unlock framing.** Polymarket users skew degen retail; the value prop is *meaningful rebate on bad days*, not *risk-policy bypass for institutional desks*.
- **Settlement-timing risk to flag.** Polymarket settles via UMA Optimistic Oracle. A few historical markets had disputed resolutions. The Atticus hedge settles independently on Deribit and is unaffected by oracle disputes.
- **Smaller market surface.** Polymarket BTC is ~95% ABOVE-style binaries. We hedge those cleanly but won't bring the multi-archetype taxonomy that the Kalshi pitch leans on.

---

## The ask

15-min exploratory call with growth or strategic-partnerships:
- Walk through the mechanism with live Deribit pricing
- Understand if Polymarket sees BTC-trader retention/sizing as a current product gap
- Discuss whether a zero-integration shadow pilot is worth running

Already live with a related product on Foxify (separate pilot). Same operational pattern: Deribit-hedged, pure pass-through.

---

## Caveats & methodology

- **Curated dataset (32 markets).** Polymarket markets are user-created and irregular — no clean schema. YES-price-at-entry estimates are best-effort from public market history. Not a statistically definitive sample — exploratory artifact for outreach, not a research paper.
- **Median over average** for recovery numbers, to keep a single outlier from inflating the story. Both reported in the underlying data.
- **BTC-adverse losing subset only** for the headline numbers. The full subset is in the per-trade CSV (writable on request).
- **Hedge pricing.** Black-Scholes with vol-risk-premium scalar (rvol × 1.10) and skew (0.20 vol-pts/% OTM), validated against live Deribit chain in companion Kalshi/SynFutures analyses (real production fees run 5-15% lower than backtest theoretical).
- **YES-direction only modeled.** Polymarket users can also bet NO; mechanism is symmetric (call spread instead of put spread) — same-shape economics expected.