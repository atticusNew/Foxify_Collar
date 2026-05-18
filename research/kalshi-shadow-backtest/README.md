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

### v2 + v3 — tiered (Lite, Standard, Shield, Shield+)

```bash
npm run backtest:tiered
```

Outputs in `./output/tiered/`:
- `kalshi_tiered_trades.csv` — trade-by-trade log, **per tier** (108 rows = 27 markets × 4 tiers)
- `kalshi_tiered_summary.md` — four-tier comparison, threshold scorecard, per-market detail
- `kalshi_tiered_pitch_snippets.md` — email-ready snippets, lead with Shield+ for institutional pitch

Two product families:

**v2 put-spread tiers (rebate, BTC-path-dependent):**
- Lite: ~$3.91 fee (7% of stake), avg recovery $3.68 on losers (~6% of stake).
- Standard: ~$8.43 fee (14% of stake), 1.7× sized, avg recovery $7.05 (~12% of stake).
- These cross **retail behavioral** thresholds but not the **institutional deterministic-floor** threshold.

**v3 Shield tiers (deterministic floor, contract-bounded):**
- Shield: Kalshi-NO leg only. ~$13.44 fee (23% of stake). **40% of stake guaranteed back on every losing market.** Worst-case realized loss: ~92% of stake (down from 100%).
- Shield+: NO leg + small BTC put spread. ~$12.95 fee. 30% guaranteed floor + variable BTC-tail upside; best single save in dataset is **$13.54 on $12.75 fee** (Nov 2025, BTC −17.4%).
- These cross thresholds A1, A2, A3, and B2 (deterministic floor) — the institutional risk-policy bar.

See `EVAL_AND_NEXT_STEPS.md` for the threshold framework, full v2 evaluation against retail/institutional/economic thresholds, and the rationale for v3 Shield design.

Tier configuration lives in single config blocks:
- v2 (Lite, Standard): top of `src/tieredHedgeModel.ts`
- v3 (Shield, Shield+): bottom of `src/shieldHedgeModel.ts`

The tiered backtest:
- Prices put-spread tiers as real 30-day BTC put spreads on Deribit (direct Black-Scholes on actual BTC strikes at each market's open).
- Prices Shield NO legs as $1 face × (100−YES)/100 with a 3% Kalshi fee assumption on NO settlement.
- Reports recovery on multiple subsets (all losers, BTC-down losers, deep-drop ≥10% losers, hedge-triggered losers).
- Reports worst-case realized loss per tier and a threshold scorecard against retail/institutional bars.
- Uses **derived** outcomes (BTC at settle vs strike) instead of the curated `outcome` field — 4 mismatches in the dataset are flagged but not silently mutated.

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
