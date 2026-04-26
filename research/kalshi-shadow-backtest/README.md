# Atticus — Kalshi Shadow Hedge Backtest

**Status:** Research only — completely isolated from the live Foxify pilot.

## What this does

Simulates "what if Atticus had been live on Kalshi" by running a shadow protection model over settled Kalshi BTC binary markets from January 2024 to April 2026.

The hedge model is calibrated to the **Foxify production prior**: same pricing schedule, same put-spread structure, same TP recovery rates — scaled to 30-day tenors appropriate for Kalshi's monthly markets.

## Critical isolation guarantee

This package:
- Lives in `/research/kalshi-shadow-backtest/` — a completely separate directory from the pilot
- Has its own `package.json` with its own dependencies
- Imports **zero files** from `services/api`, `services/hedging`, `packages/shared`, or any other pilot code
- Is not referenced by any pilot service or build script
- Cannot affect the Foxify pilot in any way

## Running the backtest

This package ships **two backtest entry points**. Both run on the same 27-market dataset and the same BTC price series — they differ in pricing model and tier structure.

### v1 — single-tier (Foxify-prior shadow)

```bash
cd research/kalshi-shadow-backtest
npm install
npm run backtest
```

Outputs in `./output/`:
- `kalshi_shadow_backtest_trades.csv` — trade-by-trade log
- `kalshi_shadow_backtest_summary.md` — aggregate stats and notable events
- `kalshi_pitch_snippets.md` — email hooks and key numbers

This was the first run. Its limitations and how the v2 redesign addresses them are documented in [`ANALYSIS_AND_PLAN.md`](./ANALYSIS_AND_PLAN.md).

### v2 — tiered (Lite + Standard, direct BS pricing)

```bash
npm run backtest:tiered
```

Outputs in `./output/tiered/`:
- `kalshi_tiered_trades.csv` — trade-by-trade log, **per tier**
- `kalshi_tiered_summary.md` — tier comparison table, recovery metrics on multiple loss subsets, per-market detail
- `kalshi_tiered_pitch_snippets.md` — email-ready snippets calibrated to "feel like real money" on a typical $58 stake

The tiered backtest:
- Prices each protection tier as a real 30-day BTC put spread on Deribit, using direct Black-Scholes on the actual BTC strike at each market's open date (no Foxify SL-tier × √T scaling shortcut).
- Targets fee bands of 5–7% (Lite) and 10–15% (Standard) of stake.
- Reports recovery on three subsets: all losers, BTC-down losers, hedge-triggered losers, and the "deep-drop" subset (BTC ≥10% fall) — which is where the brief's loss-recovery target should be evaluated.
- Includes a sizing-multiplier knob (Standard tier hedges 1.7× the at-risk amount) so cash recovery scales with BTC drawdown without forcing fees out of band.
- Uses the **derived** outcome (BTC at settle vs strike) instead of the curated `outcome` field — the curated field has 4 mismatches in the dataset, flagged in the per-market log.

Tier configuration lives in a single block at the top of `src/tieredHedgeModel.ts` for easy re-tuning.

## Assumptions

All assumptions are explicitly documented in source comments. Key ones:

| Assumption | Value | Why |
|---|---|---|
| Hedge instrument | Put spread (5% OTM buy, 10% OTM sell) | Foxify V6 backtest optimal |
| Premium markup | 40% above raw hedge cost | Foxify target margin |
| Tenor scaling | 1d cost × √30 × 0.65 | √T rule + term-structure discount |
| TP recovery (calm) | 68% | Foxify R1 empirical (n=9) |
| BTC prices | Coinbase daily close | Binance fallback |
| Kalshi YES prices | Approximated from public data/press | Where exact prices unavailable |

## Hedge model calibration (Foxify production prior)

Pricing schedule reproduced from `services/api/src/pilot/pricingRegime.ts` (read-only reference — not imported):

| Regime | DVOL | 2% SL | 3% SL | 5% SL | 10% SL |
|---|---|---|---|---|---|
| Low | ≤50 | $6.50 | $5.00 | $3.00 | $2.00 |
| Moderate | 50-65 | $7.00 | $5.50 | $3.00 | $2.00 |
| Elevated | 65-80 | $8.00 | $6.00 | $3.50 | $2.00 |
| High | >80 | $10.00 | $7.00 | $4.00 | $2.00 |

*(USD per $1k notional, 1-day tenor — scaled to 30-day for Kalshi)*

The Kalshi shadow model uses the **5% SL tier** as the analog because:
1. Kalshi binary markets have wide outcome uncertainty (not just BTC spot)
2. 5% trigger + 10% floor = meaningful protection with clear economics
3. 5% is the "margin sweet spot" tier per Foxify backtest math

## Output interpretation

All dollar amounts are per $100 Kalshi contract face value. Scale linearly:
- 10,000 contracts @ $100 → multiply all values by 100
- Average daily Kalshi BTC volume: ~$500k-$2M → multiply by 50-200x
