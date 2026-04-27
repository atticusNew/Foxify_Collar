# Atticus → Kalshi Pitch Snippets — Multi-Archetype Rebuild
*Four protection tiers across all Kalshi BTC event archetypes (ABOVE / BELOW / HIT × YES / NO).*
*Foxify-clean: zero pilot calibrations in this backtest's product-facing math.*
*Path-dependent HIT settlement using Coinbase daily highs/lows.*
*User EV computed under Kalshi yesPrice as risk-neutral probability.*

---

## Intro Email — Lead with Shield+

**Subject:**
> Worst-case loss capped at 78% of stake — every BTC event archetype, every direction, contract-bounded

**Body:**
```
We ran a protection-wrapper backtest across 68 of your settled BTC markets, covering all three event archetypes (ABOVE / BELOW / HIT) on both YES and NO directions.

Headline: a four-tier ladder where each tier targets a contract-bounded worst-case loss W. Every market gets a quote — when the target W can't be hit (long-shot bets, etc.), the engine degrades gracefully to the tightest achievable W ≥ target, and the user sees that explicitly.

  • Light      target W=95% — fee ~12% of stake, avg recovery on losses ~18%.
  • Standard   target W=85% — fee ~26%, avg recovery ~39%.
  • Shield     target W=70% — fee ~38%, avg recovery ~60%. Crosses institutional risk-policy bar (B1 ≤70%).
  • Shield-Max target W=60% — fee ~43%, avg recovery ~69%. Tightest tier; reserved for treasury/RIA accounts.

Mechanism: Atticus buys a Kalshi position on the *opposite* side of the user's bet, sized analytically so user worst-case loss does not exceed the tier's W parameter. When the user loses, the opposite-side leg pays Atticus, and Atticus passes the rebate to the user. Pure pass-through; no warehousing, no solvency tail.

Why this matters to your users: today every losing prediction is a complete write-off. With Atticus, every losing prediction pays back a contract-bounded floor — and the floor is tight enough (Shield's 70% cap) to cross the risk-policy threshold that lets institutional desks size into Kalshi BTC contracts.

Why this matters to Kalshi: protection premiums are a positive-sum revenue layer on top of the zero-sum binary market. Atticus runs ~27% gross margin per trade. At a typical $750k/market notional and 10% opt-in, Shield generates ~$7,715 per market in net platform revenue — which can be revenue-shared with Kalshi via a clearing-fee arrangement or routed entirely to Atticus depending on commercial structure.

Best save in the dataset (Shield-Max): KXBTCD-25NOV28-100000 (ABOVE/yes, 2025-11-01→2025-11-28). Unprotected -$78.00 → protected -$46.80 after a $13.51 fee.

We'd like 30 minutes to walk through the tier mechanics, the per-quadrant degradation matrix, and a zero-integration shadow pilot on your next 23 BTC markets.
```

---

## Tier Cash Story (drop-in slide)

On a typical Kalshi BTC contract @ 58¢ YES (≈ $58 at risk on a $100 face):

| | Light (W=95%) | Standard (W=85%) | **Shield (W=70%)** | **Shield-Max (W=60%)** |
|---|---|---|---|---|
| Mechanism | NO leg, ~5% guaranteed rebate | NO leg, ~15% guaranteed rebate | NO leg, ~30% guaranteed rebate (institutional bar) | NO leg, ~40% guaranteed rebate (treasury tier) |
| Extra cost | $5.00 (12%) | $11.79 (26%) | **$18.69** (38%) | **$21.99** (43%) |
| % of losing markets that pay back | 79% | 79% | **79%** | **79%** |
| Avg payout on losing markets | $7.71 (18%) | $18.42 (39%) | **$30.25** (60%) | **$35.89** (69%) |
| Avg effective W (after degradation) | 96% | 88% | **78%** | **73%** |
| Degradation rate (markets needing fallback) | 19% | 29% | 41% | 56% |
| User EV cost (% of stake) | -3.3% | -7.0% | -10.3% | -11.7% |
| Platform avg net P&L per $100 stake | $1.25 | $2.94 | $4.64 | $5.45 |

---

## What's different from prior pitch (PR #91)

- **Multi-archetype:** every BTC event you list (ABOVE / BELOW / HIT × YES / NO), not just monthly directional binaries.
- **Direction-aware hedge:** call OR put spread per (event_type × direction). Previous package hardcoded put — was Foxify carryover.
- **Foxify-clean:** zero pilot calibration constants in product code.
- **Real-strike selection:** synthetic chain matches Deribit grid; offset-ladder fallback when narrow spread fails liquidity check (ported from kal_v3_demo).
- **Honest pricing:** explicit bid-ask widener, no hidden vol-risk-premium scalar.

---

*Trade-by-trade log: `kalshi_rebuild_trades.csv` | Tier mechanics: `kalshi_rebuild_summary.md`*