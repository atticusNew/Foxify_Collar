# Atticus → Kalshi Pitch Snippets — Multi-Archetype Rebuild
*Four protection tiers across all Kalshi BTC event archetypes (ABOVE / BELOW / HIT × YES / NO).*
*Foxify-clean: zero pilot calibrations in this backtest's product-facing math.*

---

## Intro Email — Lead with Shield+

**Subject:**
> A losing Kalshi BTC bet that pays back 72-75% of stake — across every BTC event you trade

**Body:**
```
We ran a protection-wrapper backtest across 50 of your settled BTC markets, covering all three event archetypes (ABOVE / BELOW / HIT) on both YES and NO directions.

The product is a four-tier ladder where each tier targets a contract-bounded worst-case loss:
  • Light    (W=95%): cheapest tier, ~15% fee, every loss pays back ~18% of stake.
  • Standard (W=85%): ~25% fee, ~39% recovery on every loss.
  • Shield   (W=70%): institutional bar — worst-case loss ≤ 70% of stake by contract, ~38% fee, ~72% recovery.
  • Shield+  (W=70% + BTC overlay): Shield's floor PLUS an option-spread overlay — ~41% fee, ~75% recovery, with extra cash on tail BTC moves.

Mechanism: Atticus pairs the user's Kalshi position with (a) a Kalshi-NO leg sized analytically so user worst-case loss does not exceed the tier's W parameter, and (b) for Shield+, a Deribit option-spread overlay (call OR put per event archetype) for tail-upside cash recovery.

Crucially, every tier crosses A1+A2+A3 (every loss pays back something, ≥15% of stake on average, never worse than unprotected). Shield/Shield+ also cross B1 (≤70% worst case) — the institutional risk-policy threshold that lets treasuries and RIAs whitelist the wrapped instrument.

Tiers are NOT_OFFERED on markets where the math is infeasible (loss-leg price × markup ≥ 1). The offer-rate matrix in the summary doc shows where each tier prices: Atticus protection naturally fits the high-yesPrice favorite trades (~89% offer rate on Shield for ABOVE/YES) and is honest about not pricing on long-shot trades (where users don't need or want it).

Best save in the dataset (Shield+): KXBTCD-24DEC31-100000 (ABOVE/yes, 2024-12-01→2024-12-31). Unprotected -$72.00 → protected -$46.70 after a $19.78 fee.

Atticus runs ~30% gross margin per trade across all four tiers. Both legs (Kalshi-NO and Deribit overlay) are pass-through hedged — no warehousing, no solvency tail. Same operational pattern as our live Foxify pilot, but the calibration parameters and product structure are entirely Kalshi-native.

We'd like 30 minutes to walk through the tier mechanics, the offer-rate matrix per event archetype, and a zero-integration shadow pilot on your next 17 BTC markets.
```

---

## Tier Cash Story (drop-in slide)

On a typical Kalshi BTC contract @ 58¢ YES (≈ $58 at risk on a $100 face):

| | Light (W=95%) | Standard (W=85%) | **Shield (W=70%)** | **Shield+ (W=70%+overlay)** |
|---|---|---|---|---|
| Mechanism | Kalshi-NO leg sized for 5% rebate | NO leg sized for 15% rebate | NO leg sized for 30% rebate | NO leg + BTC option-spread overlay |
| Extra cost | $6.84 (15%) | $13.59 (25%) | **$22.95** (38%) | **$25.94** (41%) |
| % of losing markets that pay back | 100% | 100% | **100%** | **100%** |
| Avg payout on losing markets | $9.04 (18%) | $22.49 (39%) | **$42.93** (72%) | **$46.97** (75%) |
| Worst-case loss (% of stake) | 95% | 85% | **70%** | **70%** |
| Offer rate (markets where tier prices) | 76% | 66% | 56% | 44% |

---

## What's different from prior pitch (PR #91)

- **Multi-archetype:** every BTC event you list (ABOVE / BELOW / HIT × YES / NO), not just monthly directional binaries.
- **Direction-aware hedge:** call OR put spread per (event_type × direction). Previous package hardcoded put — was Foxify carryover.
- **Foxify-clean:** zero pilot calibration constants in product code.
- **Real-strike selection:** synthetic chain matches Deribit grid; offset-ladder fallback when narrow spread fails liquidity check (ported from kal_v3_demo).
- **Honest pricing:** explicit bid-ask widener, no hidden vol-risk-premium scalar.

---

*Trade-by-trade log: `kalshi_rebuild_trades.csv` | Tier mechanics: `kalshi_rebuild_summary.md`*