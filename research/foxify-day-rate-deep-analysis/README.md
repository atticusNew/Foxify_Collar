# Foxify Day-Rate Deep Analysis

**ANALYSIS-ONLY** package. No live Foxify pilot dependencies. No pilot code touched. Public APIs only (Coinbase BTC OHLC).

## Purpose

Answer: **for each Foxify SL tier (2%/3%/5%/10%), is there a fixed daily rate that delivers real trader value AND keeps Atticus sustainable across realistic BTC market conditions?**

Companion to PR #94 (the four-candidate comparison paper). This package goes deeper: per-tier sizing across $10k-$50k positions, all four SL tiers, three strike geometries, vol-regime stress test, premium pool simulation across 24mo of historical BTC data.

## How to run

```bash
cd research/foxify-day-rate-deep-analysis
npm install
npm run sim
```

Outputs:
- `output/foxify_day_rate_summary.md` — the analysis document (the deliverable)
- `output/foxify_day_rate_per_trade.csv` — full 12,312-row simulation log

## Headline answer

| Tier | Recommended rate | Trigger rate (24mo) | Atticus margin |
|---|---|---|---|
| 2% | $58/day per $10k | 72% | 25% |
| 3% | $58/day per $10k | 61% | 25% |
| 5% | $53/day per $10k | 43% | 25% |
| 10% | $26/day per $10k | 12% | 25% |

Reserves required at launch: ~$55k (100 users), ~$275k (500 users). See §5 of the summary.

## Files

```
src/
  fetchPrices.ts            Coinbase BTC daily OHLC (public API)
  math.ts                   BS + spread math
  foxifyDayRateSim.ts       per-position simulator (SL trigger + TP recovery)
  main.ts                   runner + report builder
output/
  foxify_day_rate_summary.md
  foxify_day_rate_per_trade.csv
```
