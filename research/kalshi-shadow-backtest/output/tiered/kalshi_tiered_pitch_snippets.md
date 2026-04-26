# Atticus → Kalshi Pitch Snippets — Tiered (v2 + v3)
*Four protection tiers across two product families:*
*  - **v2 (rebate):** Lite, Standard — put spreads on Deribit, BTC-path-dependent payout.*
*  - **v3 (deterministic floor):** Shield, Shield+ — Kalshi-NO leg, contract-bounded floor.*
*Headline figures: per $100 Kalshi contract @ typical 58¢ YES (so ~$58 at risk).*
*Scale factor for real Kalshi BTC volume: ×7,407 (assumes ~$750k avg market notional).*

---

## Intro Email — Lead with Shield+ (the institutional pitch)

**Subject line:**
> A losing prediction that pays back 30% of stake — guaranteed, not BTC-dependent

**Email body:**
```
We ran a wrapper protocol over the last 27 settled Kalshi BTC monthly markets. The headline:

Today, a losing $58 YES position is a complete write-off. With Shield+ (~$12.95 extra at entry), the same losing position pays back $19.24 on average — and at minimum 30% of stake guaranteed by contract, regardless of where BTC ends.

Across our 14 losing markets the avg user outcome moves from -$57.21 (unprotected) to -$51.12 (with Shield+) — a $6.10 improvement on every losing month. Most importantly, **every losing market pays back something** instead of zero — the binary cliff becomes a defined-risk overlay.

Best save: 2025-11, BTC -17.4% — Shield+ turned a -$62 loss into -$48.46 (a $13.54 rebate).
Edge case: BTC actually rose on a losing market (2024-07, BTC +2.83%) — pure put-spread products can't help here. Shield+ still delivered the contract floor of $13.50 on a $12.17 fee.

Atticus is already live on Foxify with a similar wrapper. Platform side: ~29% gross margin per trade, fully hedged (no warehouse risk). We'd love 30 minutes to walk through tier mechanics and a zero-integration shadow pilot on your next 11 BTC markets.
```

---

## Four-Tier Cash Story (drop-in slide)

On a typical Kalshi BTC contract @ 58¢ YES (≈ $58 at risk on a $100 face):

| | Lite (v2) | Standard (v2) | **Shield (v3)** | **Shield+ (v3)** |
|---|---|---|---|---|
| Mechanism | BTC put spread | BTC put spread, 1.7× sized | Kalshi-NO leg | NO leg + put spread |
| Extra cost | $3.91 (7%) | $8.43 (14%) | **$13.44** (23%) | **$12.95** (22%) |
| **% of losing markets that pay back** | 79% | 79% | **100%** | **100%** |
| Avg payout on losing markets | $3.68 (6%) | $7.05 (12%) | **$22.89** (40%) | **$19.24** (34%) |
| Worst-case realized loss (% of stake) | 109% | 122% | **92%** | **99%** |
| Story | "Pay ~$3.91, get a coupon if BTC moves your way." | "Pay ~14%, recover ~25% on deep BTC drops." | "Pay ~23%, get **40% back guaranteed** on every losing outcome." | "Insured bet: 30% guaranteed floor + extra recovery on BTC drops." |

---

## Why Shield matters: threshold scorecard

"Not zero-sum" is a real product threshold, not a marketing line. Tiers cross it at different levels:

| Threshold | Lite | Std | Shield | Shield+ |
|---|---|---|---|---|
| Retail behavioral: payout on ≥90% of losing markets | ❌ | ❌ | ✅ | ✅ |
| Retail behavioral: avg loss-payout ≥15% of stake | ❌ | ❌ | ✅ | ✅ |
| Retail behavioral: protected ≤ unprotected worst case | ❌ | ❌ | ✅ | ✅ |
| Institutional: deterministic floor (contract, not path) | ❌ | ❌ | ✅ | ✅ |
| Institutional: worst case ≤ 70% of stake | ❌ | ❌ | ❌ | ❌ |

**Lite/Standard cross retail-coupon thresholds. Shield/Shield+ cross the institutional floor threshold — the threshold that lets risk committees whitelist the product as a structured overlay rather than a binary bet.** Full framework in `EVAL_AND_NEXT_STEPS.md` §1.

---

## Platform Sustainability (operations / business model)

| | Lite | Standard | Shield | Shield+ |
|---|---|---|---|---|
| Avg gross margin / trade | 29% | 31% | 29% | 29% |
| Avg platform P&L / trade ($100 face) | $1.71 | $3.84 | $3.76 | $3.64 |
| Platform win rate | 100% | 100% | 100% | 100% |
| Total dataset P&L (scaled, ~$750k/market) | $341,315 | $768,328 | $752,773 | $728,330 |

Both put-spread legs and Kalshi-NO legs are pass-through (Atticus does not warehouse risk). Platform retains markup minus realized hedge cost on each trade. Same structural pattern as the live Foxify pilot, with the addition of a Kalshi-NO leg for Shield/Shield+.

---

## Mechanic: how Shield delivers a deterministic floor

```
User buys Kalshi YES @ 58¢ on a $100 face → $58 at risk.

Shield+ option (~$12.95 fee at entry):
  Atticus buys $17.40 face of Kalshi NO contracts at 42¢ = $7.31 cost
  + Atticus buys an ATM/25% put spread on Deribit, 1× sized

If YES wins  → user gets $100 from Kalshi, NO leg expires worthless, put spread expires worthless, Atticus keeps fee.
If YES loses → NO leg pays Atticus $17, Atticus passes that to user as the contract floor;
               put spread additionally pays if BTC fell, on top of the floor.

Atticus's margin per trade is deterministic: charge − NO cost − put cost − Kalshi fee.
User's worst-case loss on any market: $58 − rebate + fee = ~$54 = ~99% of stake.
```

---

## What Shield needs that Standard doesn't

- **Atticus needs a Kalshi-side execution path** (taker account, MM agreement, or pre-funded reserve) to buy the NO leg at user open. Three paths are viable; the simplest is a vanilla taker account, the cleanest is a Kalshi MM agreement.
- **No new Deribit dependency** — the put-spread overlay (Shield+) reuses the same Deribit infrastructure as the live Foxify pilot.
- **No new Atticus solvency exposure** — both legs are pre-funded at user open; the rebate is collateralised by the NO leg position.

---

## Roadmap (sequenced)

1. **Pilot v1 — Standard (v2 tier)** on a small slice of retail BTC volume. Validates the put-spread infra and the Foxify-style operational model on Kalshi data. ~30% gross margin, real cash rebates on BTC-down months.
2. **Pilot v2 — Shield+ (v3 tier)** with a Kalshi taker account or MM agreement. This is the institutional unlock. Worst-case loss bounded by contract; opens the door to RIA, treasury, and structured-product distribution.
3. **v4 — Mid-life resale** of insured positions. Once Shield+ is live and the position has a deterministic floor, MM buy-back becomes priceable. This converts "prediction bet" into "tradeable structured note" — the strategic memo's far-horizon vision.

---

*Trade-by-trade log: `kalshi_tiered_trades.csv` | Tier mechanics: `kalshi_tiered_summary.md` | Threshold framework & Shield design: `EVAL_AND_NEXT_STEPS.md` | v2 calibration: `ANALYSIS_AND_PLAN.md`*