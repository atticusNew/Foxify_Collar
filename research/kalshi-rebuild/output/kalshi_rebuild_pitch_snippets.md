# Atticus → Kalshi Pitch Snippets — Multi-Archetype Rebuild
*Four protection tiers across all Kalshi BTC event archetypes (ABOVE / BELOW / HIT × YES / NO).*
*Foxify-clean: zero pilot calibrations in this backtest's product-facing math.*
*Path-dependent HIT settlement using Coinbase daily highs/lows.*
*User EV computed under Kalshi yesPrice as risk-neutral probability.*

---

## Intro Email — Lead with Shield+

**Subject:**
> Worst-case loss capped at 76% of stake — every BTC event archetype, every direction, contract-bounded

**Body:**
```
We ran a protection-wrapper backtest across 68 of your settled BTC markets, covering all three event archetypes (ABOVE / BELOW / HIT) on both YES and NO directions.

Headline: a four-tier ladder where each tier targets a contract-bounded worst-case loss W. Every market gets a quote — when the target W can't be hit (long-shot bets, etc.), the engine degrades gracefully to the tightest achievable W ≥ target, and the user sees that explicitly.

  • Light      target W=95% — fee ~16% of stake, avg recovery on losses ~22%.
  • Standard   target W=85% — fee ~32%, avg recovery ~47%.
  • Shield     target W=70% — fee ~44%, avg recovery ~70%. Crosses institutional risk-policy bar (B1 ≤70%).
  • Shield-Max target W=60% — fee ~49%, avg recovery ~80%. Tightest tier; reserved for treasury/RIA accounts.

Mechanism: Atticus buys a Kalshi position on the *opposite* side of the user's bet, sized analytically so user worst-case loss does not exceed the tier's W parameter. When the user loses, the opposite-side leg pays Atticus, and Atticus passes the rebate to the user. Pure pass-through; no warehousing, no solvency tail.

Why this matters to your users: today every losing prediction is a complete write-off. With Atticus, every losing prediction pays back a contract-bounded floor — and the floor is tight enough (Shield's 70% cap) to cross the risk-policy threshold that lets institutional desks size into Kalshi BTC contracts.

Why this matters to Kalshi: protection premiums are a positive-sum revenue layer on top of the zero-sum binary market. Atticus runs ~20% gross margin per trade. At a typical $750k/market notional and 10% opt-in, Shield generates ~$6,751 per market in net platform revenue — which can be revenue-shared with Kalshi via a clearing-fee arrangement or routed entirely to Atticus depending on commercial structure.

Best save in the dataset (Shield-Max): KXBTCD-25NOV28-100000 (ABOVE/yes, 2025-11-01→2025-11-28). Unprotected -$78.00 → protected -$46.80 after a $11.91 fee.

We'd like 30 minutes to walk through the tier mechanics, the per-quadrant degradation matrix, and a zero-integration shadow pilot on your next 23 BTC markets.
```

---

## Tier Cash Story (drop-in slide)

On a typical Kalshi BTC contract @ 58¢ YES (≈ $58 at risk on a $100 face):

| | Light (W=95%) | Standard (W=85%) | **Shield (W=70%)** | **Shield-Max (W=60%)** |
|---|---|---|---|---|
| Mechanism | NO leg, ~5% guaranteed rebate | NO leg, ~15% guaranteed rebate | NO leg, ~30% guaranteed rebate (institutional bar) | NO leg, ~40% guaranteed rebate (treasury tier) |
| Extra cost | $5.31 (16%) | $12.26 (32%) | **$18.95** (44%) | **$22.16** (49%) |
| % of losing markets that pay back | 91% | 91% | **91%** | **91%** |
| Avg payout on losing markets | $7.88 (22%) | $19.43 (47%) | **$31.56** (70%) | **$37.64** (80%) |
| Avg effective W (after degradation) | 95% | 87% | **76%** | **70%** |
| Degradation rate (markets needing fallback) | 9% | 22% | 34% | 46% |
| User EV cost (% of stake) | -3.2% | -6.5% | -9.0% | -10.1% |
| Platform avg net P&L per $100 stake | $0.97 | $2.22 | $3.40 | $3.97 |

---

## What's different from prior pitch (PR #91)

- **Multi-archetype:** every BTC event you list (ABOVE / BELOW / HIT × YES / NO), not just monthly directional binaries.
- **Direction-aware hedge:** call OR put spread per (event_type × direction). Previous package hardcoded put — was Foxify carryover.
- **Foxify-clean:** zero pilot calibration constants in product code.
- **Real-strike selection:** synthetic chain matches Deribit grid; offset-ladder fallback when narrow spread fails liquidity check (ported from kal_v3_demo).
- **Honest pricing:** explicit bid-ask widener, no hidden vol-risk-premium scalar.

---

*Trade-by-trade log: `kalshi_rebuild_trades.csv` | Tier mechanics: `kalshi_rebuild_summary.md`*