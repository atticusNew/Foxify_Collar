# Backtest Calibration Principles

**Effective:** 2026-05-16
**Applies to:** All Atticus backtests going forward (singleSide, volumeCover, future products)

## The principle

**Realized vol ≠ implied vol.** Treat them as separate inputs:

| Variable | What it is | Drives | In our backtests |
|---|---|---|---|
| **Realized volatility** | Computed from past price returns (e.g., 30-day rolling stddev × √365) | Regime classification, trigger detection | Loaded from BTC OHLC history |
| **Implied volatility** | What the option market actually charges (forward-looking) | BS hedge cost calculation | Regime-conditional table (see below) |

Using realized vol as the BS implied-vol input over-states hedge cost in moderate/elevated regimes by 20-40% because realized vol can spike on single-day moves while implied vol smoothly anticipates them.

## The canonical IV table

Anchored to live Bullish data (2026-05-16 — 3-day BTC ATM IV at ~33% during calm regime).

```
DEFAULT_REGIME_IV = {
  calm:     0.35    // BTC vol < 50% realized
  moderate: 0.55    // 50-70% realized
  elevated: 0.75    // 70-90% realized
  stress:   0.95    // > 90% realized
}
```

**Calm IV (0.35) is slightly above the 0.33 live Bullish anchor** because backtest scenarios span more diverse calm-regime conditions than just today's window. The 0.35 represents typical-calm IV across the 487-day data window, not just current-Bullish-snapshot IV.

## How to use

```typescript
import { getRegimeIv, classifyRegime } from "scripts/backtest/lib/regimeIv";

// Step 1: classify regime from realized vol
const regime = classifyRegime(realizedVolFromHistory);

// Step 2: get IV for BS hedge cost
const hedgeIv = getRegimeIv(regime);

// Step 3: use hedgeIv in bsPut/bsCall calls
const hedgeCost = bsPut(spot, strike, T, RFR, hedgeIv);
```

**Do NOT** use historical realized vol as the BS IV input directly. Always go through `getRegimeIv()`.

## Sensitivity testing

If you want to test "what if implied vol is 20% higher than the calibrated table?", set env vars:

```bash
BACKTEST_IV_CALM=0.42         # calm bumped from 0.35
BACKTEST_IV_MODERATE=0.66     # moderate bumped from 0.55
BACKTEST_IV_ELEVATED=0.90
BACKTEST_IV_STRESS=1.15
```

Re-run any backtest. Compare output to baseline. This tests whether pricing recommendations are robust to IV mis-calibration.

## When to re-anchor the table

- **Quarterly:** pull live Bullish ATM IV at multiple tenors and DVOL bands; update table if drift >5% in any bucket.
- **Post-pilot:** if observed P&L diverges from backtest projection by >25%, audit whether IV table needs adjustment.
- **Major regime shift:** if BTC enters a sustained new vol regime (e.g., 6+ months at >60% IV), calibration assumptions need review.

## Files using this calibration

- ✅ `services/api/scripts/backtest/volumeCover/coreEngine.ts`
- ✅ `services/api/scripts/backtest/singleSide/coreEngine.ts`
- Future product backtests should import from `scripts/backtest/lib/regimeIv.ts`

## What this calibration does NOT change

- **Regime classification** still driven by realized vol (the historical price data tells us when conditions were calm/moderate/elevated/stress)
- **Trigger detection** still driven by historical price paths (whether spot actually crossed trigger band on a given day)
- **Hold time models** unchanged
- **IV-aware production pricing** (separate from backtest hedge cost) anchors to live Bullish IV at quote time, not this table

## Rationale (one paragraph)

Realized vol from history can be misleading when used as a forward-looking market price. A single 5% intraday move spikes realized vol for the next 30 days even if the option market doesn't reprice that aggressively. By using a smoothed regime-conditional IV table calibrated to actual venue prices, we get hedge cost numbers that match what the venue would actually charge — not what historical statistics say it "should" charge. This makes pricing recommendations more honest and avoids overpricing during temporary realized-vol spikes that the implied vol market has already discounted.
