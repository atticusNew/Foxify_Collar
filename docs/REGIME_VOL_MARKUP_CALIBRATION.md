# Regime Cost Markup — Empirical Calibration

**Generated:** 2026-05-27T21:02:38.096Z
**Window:** 2025-05-27 → 2026-05-27 (365 days)
**Source:** Deribit DVOL daily history (public API)

## Methodology

1. Classify each daily DVOL into regime band (calm <40, moderate 40-60, elevated 60-85, stress ≥85).
2. Compute median DVOL within each regime → median σ = DVOL/100.
3. Price a representative 3-day ITM guts strangle ($76000/$74000, spot $75000, 1.4 BTC) at that σ via BS.
4. Markup = premium_at_regime_median / premium_at_calm_median.

## Results

| Regime | Days | Median DVOL | Median σ | BS strangle premium | Empirical markup vs calm |
|---|---:|---:|---:|---:|---:|
| calm | 143 | 38.03 | 0.380 | $4501 | 1.000× |
| moderate | 221 | 45.95 | 0.460 | $5066 | 1.126× |
| elevated | 2 | 71.53 | 0.715 | $6945 | 1.543× |
| stress | 0 | 0.00 | 0.000 | $0 | n/a (no samples in window) |

## Comparison to hardcoded values

Current `REGIME_COST_MARKUP` in runTwoSidedStrangleProof.ts:
```
{
  "calm": 1,
  "moderate": 1.08,
  "elevated": 1.2,
  "stress": 1.35
}
```

| Regime | Empirical | Hardcoded | Δ% | Action |
|---|---:|---:|---:|---|
| calm | 1.000× | 1.00× | 0.0% | within tolerance |
| moderate | 1.126× | 1.08× | 4.2% | within tolerance |
| elevated | 1.543× | 1.20× | 28.6% | **UPDATE** hardcoded |
| stress | n/a | 1.35× | n/a | no data |

**Caveat:** this calibration uses BS theoretical with constant smile shape; real market markup also includes
bid/ask widening + skew steepening which BS doesn't capture. The hardcoded values include a ~5-15% premium over
pure BS σ-scaling to account for these effects. Operator judgement required if empirical Δ > 10%.

Re-run: `npx tsx services/api/scripts/backtest/singleSide/calibrateRegimeVolMarkup.ts`