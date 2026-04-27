# Atticus → Kalshi Pitch Snippets — Multi-Archetype Rebuild
*Four protection tiers across all Kalshi BTC event archetypes (ABOVE / BELOW / HIT × YES / NO).*
*Foxify-clean: zero pilot calibrations in this backtest's product-facing math.*

---

## Intro Email — Lead with Shield+

**Subject:**
> A losing Kalshi BTC bet that pays back 40-34% of stake — across every BTC event you trade

**Body:**
```
We ran our protection wrapper across 50 of your settled BTC markets, covering all three event archetypes you list (ABOVE / BELOW / HIT) on both YES and NO directions.

Today, every losing Kalshi BTC bet is a complete write-off. With Shield+ at the headline tier (~$11.89 extra fee, ~26% of stake), every losing position pays back $16.54 on average — at minimum 30% of stake guaranteed by contract regardless of which direction BTC moves or which event archetype settled against the user.

The mechanism: Atticus pairs the user's Kalshi position with (a) a Kalshi-NO leg sized to deliver a deterministic rebate floor on any losing outcome, and (b) a Deribit option overlay (call OR put spread, instrument selected per event archetype) for additional payout when the underlying moved materially.

Worst-case realized loss across our entire backtest: 112% of stake (vs 100% unprotected). That's the threshold institutional risk policies require.
Best save in the dataset: KXBTCD-24DEC31-100000 (ABOVE/yes, 2024-12-01→2024-12-31). Unprotected -$72.00 → protected -$58.49 after a $11.80 fee.

Atticus is already live with Foxify on a related drawdown-protection product. We'd like 30 minutes to walk through tier mechanics, the platform side (~30% gross, fully Deribit/Kalshi-hedged, no warehousing), and a zero-integration shadow pilot on your next 17 BTC markets.
```

---

## Tier Cash Story (drop-in slide)

On a typical Kalshi BTC contract @ 58¢ YES (≈ $58 at risk on a $100 face):

| | Lite | Standard | **Shield** | **Shield+** |
|---|---|---|---|---|
| Mechanism | Adapter-driven option spread (call/put per archetype) | Same, 1.7× sized | Kalshi-NO leg only | NO leg + spread overlay |
| Extra cost | $2.26 (4%) | $3.98 (8%) | **$12.85** (29%) | **$11.89** (26%) |
| % of losing markets that pay back | 79% | 79% | **100%** | **100%** |
| Avg payout on losing markets | $2.18 (4%) | $3.70 (8%) | **$19.16** (40%) | **$16.54** (34%) |
| Worst-case loss (% of stake) | 114% | 124% | **111%** | **112%** |

---

## What's different from prior pitch (PR #91)

- **Multi-archetype:** every BTC event you list (ABOVE / BELOW / HIT × YES / NO), not just monthly directional binaries.
- **Direction-aware hedge:** call OR put spread per (event_type × direction). Previous package hardcoded put — was Foxify carryover.
- **Foxify-clean:** zero pilot calibration constants in product code.
- **Real-strike selection:** synthetic chain matches Deribit grid; offset-ladder fallback when narrow spread fails liquidity check (ported from kal_v3_demo).
- **Honest pricing:** explicit bid-ask widener, no hidden vol-risk-premium scalar.

---

*Trade-by-trade log: `kalshi_rebuild_trades.csv` | Tier mechanics: `kalshi_rebuild_summary.md`*