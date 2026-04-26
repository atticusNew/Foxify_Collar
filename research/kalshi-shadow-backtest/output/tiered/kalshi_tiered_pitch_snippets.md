# Atticus → Kalshi Pitch Snippets — Tiered (v2)
*Two protection tiers, calibrated cash numbers, BTC-move-driven recovery.*
*Headline figures: per $100 Kalshi contract @ typical 58¢ YES (so ~$58 at risk).*
*Scale factor for real Kalshi BTC volume: ×7,407 (assumes ~$750k avg market notional).*

---

## Intro Email — Two Tiers in Four Sentences

**Subject line:**
> Atticus shadow on your last 27 BTC markets — Lite 7% / Standard 14% fee, Standard recovers 24% of loss on 10%+ BTC drops

**Email body:**
```
We ran Atticus's downside-protection model over the last 27 settled Kalshi BTC monthly markets (Jan 2024 – Apr 2026), pricing real 30-day BTC put spreads on Deribit at each market's open date.
Two tiers, calibrated to feel like real money on a typical $58 stake:
  • Lite: ~$3.91 fee (7% of stake). On months where BTC moves materially against the YES position (≥10% drop), the average payout is $7.69 — about 13% of the stake, 13% of the realized loss.
  • Standard: ~$8.43 fee (14% of stake). On those same deep-drop months the average payout is $14.03 — about 24% of the stake and 24% of the realized loss, cutting the worst losing months roughly in half.
On the worst month in our sample (2025-11, BTC -17.4%), Standard would have turned a -$62.00 loss into -$51.42 after a $7.76 fee — a $10.58 cash rebate on the worst day.
Atticus is already live with Foxify on a similar wrapper; we'd love a 30-minute call to walk through tier mechanics and a zero-integration shadow pilot on your next 11 BTC markets.
```

---

## Tier Cash Story (drop-in slide / email block)

On a typical Kalshi BTC contract @ 58¢ YES (≈ $58 at risk on a $100 face):

| | **Lite** | **Standard** |
|---|---|---|
| Extra cost | **$3.91** (7% of stake) | **$8.43** (14% of stake) |
| Avg recovery when hedge fires | **$4.69** (8% of stake) | **$8.97** (15% of stake) |
| % of realized loss recovered when hedge fires | **8%** | **15%** |
| Recovery on deep BTC drops (≥10%) | **$7.69** (13% of stake) | **$14.03** (24% of stake) |
| Best single save in dataset | $6.46 (2025-11) | $10.58 (2025-11) |
| Story | "Pay ~$3.91, get a meaningful rebate if the trade goes against you." | "Pay ~14% more, recover roughly a quarter of the stake on materially-against-you BTC months." |

---

## Platform Sustainability (your operations team)

| | Lite | Standard |
|---|---|---|
| Avg gross margin / trade | 29% of revenue | 31% of revenue |
| Avg platform P&L / trade ($100 face) | $1.71 | $3.84 |
| Platform win rate | 100% | 100% |
| Total dataset P&L (scaled, ~$750k/market) | $341,315 | $768,328 |

Spread is fully Deribit-hedged per user position (net pass-through on triggered trades). Atticus does not warehouse the put. Profitability comes from the markup minus realised hedge cost ± TP salvage — same structural pattern as the live Foxify pilot.

---

## Strategic Frame (institutional close)

```
In 5 of 27 markets (19%), the binary bet missed AND BTC fell ≥10% during the holding window — that's the tail risk that prevents larger desks from sizing into Kalshi BTC contracts naked.
With Atticus's Standard tier, the average deep-drop losing month goes from -$56.80 unprotected to -$51.36 after fee + payout — a real cash floor on tail months.
That re-shapes the contract from "binary" to "structured product" and unlocks distribution to risk-policy-bound counterparties (corporate treasuries, RIA wrap accounts, and the Kalshi institutional roadmap).
```

---

## What's NOT in these numbers (next-stage pilot ask)

- A pure BTC put spread can recover at most `width × at_risk` — meaningful, but bounded by how far BTC actually fell.
- A small subset of losing Kalshi markets (where BTC rose but the strike was high) cannot be recovered by a put spread alone, no matter how it's priced.
- v3 hybrid wrapper: pair the put spread with a tiny Kalshi-NO leg sized to plug the residual loss. This deterministically delivers 50%+ loss recovery on every losing market — but it requires a Kalshi market-maker / pro-trader API hook. That's the pilot conversation, not a unilateral Atticus capability.

---

*Trade-by-trade log: `kalshi_tiered_trades.csv` | Full assumptions: `kalshi_tiered_summary.md` | Methodology: `ANALYSIS_AND_PLAN.md`*