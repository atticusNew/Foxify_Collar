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

```bash
cd research/kalshi-shadow-backtest
npm install
npm run backtest
```

Output files appear in `./output/`:
- `kalshi_shadow_backtest_trades.csv` — full trade-by-trade log
- `kalshi_shadow_backtest_summary.md` — aggregate statistics and notable events
- `kalshi_pitch_snippets.md` — email-ready pitch hooks and key numbers

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
