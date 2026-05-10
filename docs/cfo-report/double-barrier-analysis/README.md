# Double-2% Barrier Hedge — Analytical Package

Quant analysis of the Atticus volume facility (Foxify B2B) double-barrier
knock-out product (±2% trigger, $50k pair notional, 7-day max trader
tenor, $1,000 capped payout, tiered $400/$600/$900 per side per day
premium) and the capital required to scale it to 1,000 concurrent pairs.

## Reading order

1. **`REVENUE_SPLIT_FRAMEWORK.md`** — **READ FIRST.** The right framing of the pricing question once we understand Foxify is a volume aggregator (not a trader buying insurance). Joint surplus is ~$6k/pair-life; pricing tiers shift the split. Recommends Option C with volume rebates, falling back to Option E with volume commitment.
2. **`PREMIUM_NEGOTIATION.md`** — Detailed trader-side vs platform-side trade-off matrix at four premium tiers; per-band breakeven floors.
3. **`MEMO_V3_ADDENDUM.md`** — Documents the intra-day re-open correction (V3) and what numbers in MEMO_V2 to update.
3. **`MEMO_V2.md`** — Strategic memo (with V2.1 crisis-window addendum). Original headlines; some numbers superseded by MEMO_V3_ADDENDUM and PREMIUM_NEGOTIATION. Founder-direction-aligned, empirically calibrated against 6+ years of real BTC + 5 years of DVOL.
2. **`PREMIUM_RECOMMENDATION.md`** — Direct answer to "what premium for DVOL <50? median price for DVOL <65?" with the full analytic derivation.
3. **`RETAIL_VS_VOL_FACILITY.md`** — Why retail and vol facility are two distinct products that share engineering but not P&L / capital / pricing.
4. **`FOXIFY_SURPRISES_BRIEF.md`** — Counterparty-risk brief addressing Foxify's "system blow up" concern.
5. **`COOLDOWN_CIRCUIT_BREAKER_SPEC.md`** — Spec for the payment-capacity protection mechanism. *Crisis-window stress test elevated this from "defensive guardrail" to "mandatory production control."*
6. **`BULLISH_RFQ_RUNBOOK.md`** — How to run the hedge-cost calibration RFQ in <5 minutes (script ready: `services/api/scripts/volFacilityHedgeRfq.ts`).
7. **`OPERATIONAL_DETAILS.md`** — TP mechanics, option selection logic, cooldown monitoring-vs-activation distinction, full essentials checklist (size caps, max-loss breaker, settlement timing, etc.).
8. **`historical/stress_windows.md`** — Crisis-window stress test results (COVID, May-2021, Luna, FTX, banking-2023, yen-carry).
9. `MEMO.md` — V1 memo (kept for diff history; V2 supersedes).

## Empirical artifacts (~6.4-year historical replay)

| File | What it is |
|---|---|
| `historical/historical_per_pair.csv` | Every (start_date, instrument, schedule) cell — 13,446 rows |
| `historical/historical_summary.json` | Per-band aggregates (mean/median/p05/p95 PnL, trigger rate, P[PnL>0]) |
| `historical/dvol_distribution.json` | DVOL band frequencies + cluster duration stats |
| `historical/triggers_by_dvol_band.csv` | Empirical trigger rate per DVOL band |
| `historical/stress_windows.json` | Per-crisis-window per-schedule P&L distribution |
| `historical/stress_windows.md` | Human-readable crisis-window report |
| `capital_ramp_table.csv` | Capital required at scales 1, 4.3, 8, 12.9, 25, 50, 100, 250, 500, 1,000 pairs |
| `rfq/rfq_<ts>.{json,md}` | Output of `volFacilityHedgeRfq.ts` runs (when executed against Bullish) |

## V1 sweep artifacts (GBM-based, kept for reference)

| File | What it is |
|---|---|
| `SUMMARY.md` | V1 Monte-Carlo sweep summary tables |
| `breakeven_premium.csv` | Breakeven premium under risk-neutral GBM by (regime, instrument, VRP) |
| `per_pair_pnl.csv` | V1 P&L distribution per pair-life |
| `capital_ladder.csv` | V1 capital ladder (GBM-based) |
| `sweep/sweep_results.json` | Raw Monte-Carlo sweep output |

## How to reproduce

```bash
# install deps once
pip install numpy scipy

# === V2 empirical pipeline (recommended) ===
# fetch ~6.4yr BTC hourly + ~5yr DVOL daily (~35 sec)
python3 scripts/double-barrier/fetch_historical.py
# replay product against the real tape (~16 sec)
python3 scripts/double-barrier/historical_replay.py
# capital ramp table
python3 scripts/double-barrier/capital_ramp_planner.py
# crisis-window stress test (COVID, May-2021, Luna, FTX, etc.)
python3 scripts/double-barrier/stress_window_replay.py

# === Bullish live RFQ (calibrate hedge cost) ===
# requires PILOT_BULLISH_* env vars (same as live pilot)
pnpm tsx services/api/scripts/volFacilityHedgeRfq.ts \
    --notional-usd 50000 --tenor-days 30

# === V1 (GBM, reference only) ===
python3 scripts/double-barrier/run_full_sweep.py --paths 3000
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

## Headline conclusions (V2)

See `MEMO_V2.md` for the full argument. One-paragraph version:

> **Empirically, the volume facility is profitable in ~75% of weeks
> across the 4-year BTC tape under the proposed $400/$600/$900 tiered
> premium with daily ±2% strangle hedging. Atticus's required operating
> capital is ~$80k for 4.3 pairs, ~$145k for 12.9 pairs, scaling to
> ~$1.76M for 1,000 pairs — roughly 5× lower than the V1 GBM-based
> estimate because BTC implied vol (DVOL) has run +12% above realized vol
> on average over 4 years (and +22-25% in the elevated/stress bands where
> the platform is also charging the highest premium tier). The $900 tier
> kicks in on roughly 17% of days (~63 days/year, ~4 distinct episodes
> averaging 16 days each). At this scale Atticus can pay LP funding at
> any reasonable APR (5-50%) with multi-x safety margin on weekly P&L.
> Cooldown circuit breaker is reserved as a defensive guardrail only,
> firing on payout-velocity / trigger-density / DVOL-spike thresholds.**

## Status

This is a paper analysis only. Production code is unchanged.

The analytical package in this directory is the input to a go/no-go
decision on whether to repackage the Modified-Y product per the moves in
`MEMO.md §7`.
