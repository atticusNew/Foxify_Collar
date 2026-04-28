# Atticus → Polymarket: Options-Hedge Bridge (Exploratory 1-Pager)
*Generated 2026-04-28 | Standalone exploratory analysis | 32 settled Polymarket BTC markets analyzed*

---

## What this is

Atticus runs a hedge-bridge product live on Foxify (BTC perps) and built a similar pitch for Kalshi (BTC binaries). For Polymarket BTC traders, the same mechanism applies: trader buys a Polymarket BTC YES position, Atticus simultaneously buys a real Deribit BTC put-spread hedge that pays when BTC moves against the bet. **Pure pass-through — no MM behavior, no warehousing, no Polymarket-side integration required.**

---

## How it would work for a Polymarket trader

On a $100-face Polymarket BTC YES at 60¢ (≈$60 at risk):

- **Atticus fee at entry:** ~$9.12 (varies by market — calibrated against live Deribit chain)
- **Hedge:** real 30-day BTC put spread (~2%-OTM long leg, 5% width, ~6.5× sized) bought via Atticus's existing Deribit account
- **If BTC drops materially:** spread pays out, partially offsetting the user's Polymarket loss
- **If BTC stays flat or rises:** spread expires; trader loses the fee (insurance dynamic)

---

## Backtest results (the proof)

Across 32 settled Polymarket BTC monthly markets (Jan 2024 – Mar 2026):

| Metric | Value |
|---|---|
| Average Atticus fee | $9.12 per $100 face |
| Losing markets (YES outcome NO) | 24 of 32 (75%) |
| Losing markets where BTC also fell | 13 of 24 (54%) |
| Hedge triggered (BTC dropped past spread strike) | 13 of 32 (41%) |
| Avg hedge payout on **BTC-down losing markets** | **$13.51** |
| Avg net user save on BTC-down losing markets (after fee) | **$3.97** |
| Atticus gross margin | ~29% (markup over Deribit fill) |

*Honest framing: on losing markets where BTC moved AGAINST the trader's bet (the hedge's intended trigger), the hedge meaningfully reduces loss. On losing markets where BTC moved correctly but the binary still settled NO (e.g., "BTC > $100k" failed because BTC peaked at $99k), the hedge correctly expires worthless and the trader pays the fee — same dynamic as fire insurance you didn't claim.*

**Best single save:** PM-25OCT-110000 — *"Bitcoin reach $110k by Oct 31?"* — BTC -7.67%. Unprotected -$65.00 → protected -$53.26 after $9.38 fee. **Saved $11.74.**

---

## Why this is interesting for Polymarket specifically

- **Brings options depth to a market that has none.** Polymarket BTC markets have no native protection product. Closest alternative is for a trader to open a separate Deribit/CME account — high friction, low adoption.
- **Atticus is operationally ready.** We're already live with Deribit hedging on Foxify. No infrastructure ramp.
- **No Polymarket-side integration.** We work off public market data. Could shadow-pilot for several weeks before any commercial commitment.
- **Capital efficient.** Hedge cost runs ~3-5% of protected notional (vs bank-OTC verticals that run 2-5% with $50k+ minimums and 6-week procurement).

---

## What would be different from a Kalshi pitch

- **Less institutional unlock story.** Polymarket users skew degen retail; Kalshi has institutional buyers in the queue. The pitch leads with *retail capital efficiency*, not *institutional risk-policy bypass*.
- **Settlement timing risk to flag.** Polymarket settles via UMA Optimistic Oracle. A few markets historically had disputed resolutions. Atticus's hedge settles independently on Deribit; in a dispute scenario, the hedge may close before the Polymarket payout finalizes. Workable but documented.
- **Smaller market surface.** Polymarket BTC is ~95% ABOVE-style binaries. Hedge mechanism applies cleanly but we're not bringing the multi-archetype taxonomy that the Kalshi pitch leans on.

---

## The ask (15-min exploratory call)

Looking for a 15-minute conversation with someone on growth or strategic partnerships to:
- Walk through the mechanism with live Deribit pricing
- Understand whether Polymarket sees BTC-trader retention/sizing as a current product gap
- Discuss whether a zero-integration shadow pilot would be worth running

Already live with a related product on Foxify (separate pilot). Same operational pattern: Deribit-hedged, pure pass-through.

---

## Caveats & methodology (for the technical reader)

- **Curated dataset (~30 markets).** Polymarket markets are user-created and irregular — no clean schema. Each entry is sourced from publicly accessible Polymarket market pages with best-effort YES-price-at-entry estimates. Not a statistically definitive sample.
- **Outcome cross-checks.** 4 of 32 markets show a mismatch between recorded outcome and price-derived outcome (typically due to YES price approximation timing). Economics use price-derived outcome.
- **Hedge pricing.** Black-Scholes with vol-risk-premium scalar (rvol × 1.10) and skew (0.20 vol-pts/% OTM), validated against live Deribit chain in companion Kalshi/SynFutures analyses. Real production fees run 5-15% lower than backtest theoretical.
- **Single-direction (YES bets) modeled.** Polymarket users can also bet NO; the hedge mechanism is symmetric (call spread instead of put spread) but the economics here cover the dominant YES case.
- **Exploratory analysis only.** This is not a full pitch deck — it's an outreach 1-pager. A deeper analysis (multi-archetype, vol-regime stress test, premium pool simulation, capital efficiency tables) is available on request.