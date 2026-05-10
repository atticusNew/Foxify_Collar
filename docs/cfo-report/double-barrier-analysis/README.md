# Double-2% Barrier Hedge — Analytical Package

Quant analysis of the proposed Atticus / Foxify double-barrier knock-out
product (±2% trigger, $50k pair notional, 7-day max trader tenor, $1,000
capped payout, $250-$400/side premium) and the capital required to scale
it to 1,000 concurrent pairs.

## What's here

| File | What it is |
|---|---|
| `MEMO.md` | **Read this first.** Strategic memo with feedback, recommendations, and ranked path forward. |
| `SUMMARY.md` | Auto-generated tables: trigger frequency, breakeven premium, P&L grid, capital ladder, burn-rate. |
| `breakeven_premium.csv` | Breakeven premium per side per day by (regime, instrument, VRP). |
| `per_pair_pnl.csv` | Full P&L distribution per pair-life by (regime, premium, instrument, VRP). |
| `capital_ladder.csv` | Capital required at scales 1, 4, 8, 12, 25, 50, 100, 250, 500, 1,000 pairs. |
| `sweep/sweep_results.json` | Raw Monte-Carlo sweep output (12 minutes / 3,000 paths × 4 regimes × 7 premium tiers × 2 VRP scenarios × 4 hedge instruments). |

## How to reproduce

```bash
# install deps once
pip install numpy scipy

# headline single-config run (~80 sec)
python3 scripts/double-barrier/simulator.py \
  --paths 4000 --regime mod --premium-side 250 --vrp 0.20

# full multi-axis sweep (~12 min)
python3 scripts/double-barrier/run_full_sweep.py --paths 3000

# regenerate tables and SUMMARY.md from sweep
python3 scripts/double-barrier/analyze_sweep.py
```

## What the simulator does

Per pair, draws a risk-neutral GBM BTC price path with realized vol
σ_real = σ_implied × (1 − VRP). Iterates day-by-day, intra-day:

1. Each day collects the daily premium.
2. Within day, scans for ±2% barrier crossings using continuous-monitoring
   Brownian-bridge correction.
3. On trigger: pays $1,000 to trader, sells the in-the-money leg back to
   venue at BS-implied (priced at σ_implied), opens a new leg at the new
   spot for the same direction.
4. After 7 days: marks all surviving legs to BS-fair and unwinds.
5. Aggregates premium − payouts − hedge_cost + hedge_recovery = P&L.

Four hedge instruments compared:

- `straddle_30d` — legacy Modified-Y 30-day ±2% strangle, auto-renew on triggers
- `strangle_7d` — 7-day ±2% strangle, no renew (matches trader tenor)
- `daily_strangle` — fresh 1-day ±2% strangle each morning
- `perp_delta_only` — no convex hedge, perp funding drag only (used to bound the value of convexity)

Capital model: `1.30 × (L1 hedge equity + L2 tail buffer + L3 expected-loss buffer)`,
where L1 scales linearly in N (independent pair option spend), L2 scales
sub-linearly with √N (independent-pair pooling, z=2.33 for 99th percentile),
L3 scales linearly when E[PnL] < 0.

## Headline conclusions

See `MEMO.md` for the full argument. One-line version:

> **Hedge instrument barely matters; daily strangle ties up 14× less capital
> than 30-day strangle for the same expected P&L. The real lever is reducing
> trigger frequency (cooldown + wider barrier), not optimizing the hedge.
> $1.5M operating + $5M stress credit gets you 1,000 pairs sustainably
> *if* the structural fixes ship.**

## Status

This is a paper analysis only. Production code is unchanged.

The analytical package in this directory is the input to a go/no-go
decision on whether to repackage the Modified-Y product per the moves in
`MEMO.md §7`.
