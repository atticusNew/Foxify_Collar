# Pilot backtest quickstart (FalconX-ready workflow)

This gives you a fast replay harness for strict vs hybrid pricing economics using hourly BTC history.

## FalconX vs Deribit: does it matter?

Yes, for hedge execution realism.  
No, for immediate unit-economics replay.

- This backtest tool does **premium/claims/treasury replay** with your fixed pricing schedules and configurable hedge recovery assumptions.
- It does **not** require Deribit API connectivity.
- You can run it now, then later replace the fallback hedge cost inputs with FalconX RFQ history exports to make hedge-cost legs fully venue-native.

## What gets added

- `scripts/pilotBacktestFetchBtc.ts`
  - Downloads hourly BTC history CSV for backtest windows (auto source fallback: Binance -> CoinGecko -> Coinbase).
- `scripts/pilotBacktestRun.ts`
  - Runs strict/hybrid historical replay over notionals x tiers.
  - Supports breach modes:
    - `path_min` (recommended): trigger based on worst intra-tenor price
    - `expiry_only` (legacy): trigger based on expiry price only
- `scripts/fixtures/pilot_backtest_config.example.json`
  - Editable config: schedules, treasury caps, hedge assumptions.

## One-time setup

From repo root:

```bash
cd /workspace/services/api
npm install
```

## Fast run (copy/paste)

```bash
cd /workspace/services/api

# 1) Pull 6 months of hourly BTC prices
npm run -s pilot:backtest:fetch-btc -- \
  --from 2025-10-01T00:00:00Z \
  --to 2026-04-01T00:00:00Z \
  --source auto \
  --out-csv artifacts/backtest/btc_usd_1h.csv

# 2) Run both strict + hybrid replay
npm run -s pilot:backtest:run -- \
  --config scripts/fixtures/pilot_backtest_config.example.json \
  --prices-csv artifacts/backtest/btc_usd_1h.csv \
  --mode both \
  --out-json artifacts/backtest/pilot_backtest.json \
  --out-csv artifacts/backtest/pilot_backtest.csv

# 3) Quick summary
jq '.summary' artifacts/backtest/pilot_backtest.json
```

## Multi-month / multi-year runs (recommended approach)

Yes, longer history helps a lot because it captures multiple volatility and drawdown regimes.

For long windows, run in chunks (for example, quarterly) and compare summaries.
This avoids provider throttling and keeps hourly quality stable.

If your environment blocks one source (for example CoinGecko 401), force Coinbase:

```bash
cd /workspace/services/api

# Force Coinbase candles if CoinGecko/Binance are blocked
npm run -s pilot:backtest:fetch-btc -- \
  --from 2024-10-01T00:00:00Z \
  --to 2025-01-01T00:00:00Z \
  --source coinbase \
  --out-csv artifacts/backtest/btc_usd_q4_2024_1h.csv

# Then run replay on that CSV
npm run -s pilot:backtest:run -- \
  --config scripts/fixtures/pilot_backtest_config.example.json \
  --prices-csv artifacts/backtest/btc_usd_q4_2024_1h.csv \
  --mode both \
  --out-json artifacts/backtest/pilot_backtest_q4_2024.json \
  --out-csv artifacts/backtest/pilot_backtest_q4_2024.csv

# Q4 2024
FROM_ISO=2024-10-01T00:00:00Z TO_ISO=2025-01-01T00:00:00Z OUT_JSON=artifacts/backtest/pilot_backtest_q4_2024.json OUT_CSV=artifacts/backtest/pilot_backtest_q4_2024.csv npm run -s pilot:backtest:quick

# Q1 2025
FROM_ISO=2025-01-01T00:00:00Z TO_ISO=2025-04-01T00:00:00Z OUT_JSON=artifacts/backtest/pilot_backtest_q1_2025.json OUT_CSV=artifacts/backtest/pilot_backtest_q1_2025.csv npm run -s pilot:backtest:quick

# Q2 2025
FROM_ISO=2025-04-01T00:00:00Z TO_ISO=2025-07-01T00:00:00Z OUT_JSON=artifacts/backtest/pilot_backtest_q2_2025.json OUT_CSV=artifacts/backtest/pilot_backtest_q2_2025.csv npm run -s pilot:backtest:quick
```

Each run writes independent outputs, so you can aggregate or compare period-by-period.

Hourly quality check after each run:

```bash
jq '.rows' artifacts/backtest/pilot_backtest.json
wc -l artifacts/backtest/btc_usd_1h.csv
```

Rule of thumb:
- ~90-day window should be around `2160` hourly points (minus small gaps)
- If you see very low counts (for example ~90-200 rows for many months), rerun in smaller chunks

## Output files

- `artifacts/backtest/btc_usd_1h.csv`
  - Columns: `ts_iso,price_usd`
- `artifacts/backtest/pilot_backtest.csv`
  - One row per simulated protection trade
  - Includes selector context columns for governance replay:
    - `dynamicSelectorEnabled`
    - `selectorMode`
    - `hedgeRegime`
    - `selectedTenorDays`
    - `selectedStrikeDistancePct`
    - `strikeProximityBias`
    - `selectorCandidateCount`
- `artifacts/backtest/pilot_backtest.json`
  - Includes full rows + compact `summary` table per model
  - Includes `executiveRisk` block per model:
    - `worstDaySubsidyNeedUsd`
    - `lossP95PerTradeUsd`
    - `maxDrawdownUsd` / `maxDrawdownPct`
    - `recommendedMinTreasuryBufferUsd`
  - Includes `takeProfit` runtime block and TP deltas in `summary`:
    - `underwritingPnlBaselineTotalUsd` / `underwritingPnlTpTotalUsd`
    - `underwritingPnlImprovementUsd`
    - `subsidyNeedBaselineTotalUsd` / `subsidyNeedTpTotalUsd`
    - `subsidyNeedReductionUsd`
    - `takeProfitTriggeredCount` / `takeProfitTriggeredRatePct`

## Risk pack export (chart + spreadsheet ready)

After you produce multiple quarterly JSON outputs, export governance metrics:

```bash
cd /workspace/services/api
npm run -s pilot:backtest:risk-pack -- \
  --inputs "artifacts/backtest/stress/pilot_backtest_stress_q2_2022.json,artifacts/backtest/stress/pilot_backtest_stress_q4_2022.json,artifacts/backtest/stress/pilot_backtest_stress_q1_2023.json,artifacts/backtest/stress/pilot_backtest_stress_q1_2024.json" \
  --out-summary-csv artifacts/backtest/risk_pack_summary.csv \
  --out-daily-csv artifacts/backtest/risk_pack_daily.csv
```

Outputs:
- `risk_pack_summary.csv` (period/model level):
  - rolling trigger hit rate
  - worst-day subsidy utilization and date
  - max treasury drawdown
  - automatic strict fallback / issuance pause flags
  - breach-rebound counts (take-profit opportunity proxy)
- `risk_pack_daily.csv` (date/model level):
  - daily subsidy need/applied/blocked
  - daily subsidy utilization %
  - rolling trigger hit rate
  - treasury drawdown
  - auto actions
- `risk_pack_tp_impact.csv` (period/model TP delta view):
  - baseline vs TP underwriting PnL totals
  - baseline vs TP subsidy need totals
  - hedge recovery improvement
  - TP trigger and underperformance counts
- `risk_pack_tp_rules.csv` (period/model rule mix):
  - counts and rates by `takeProfitRule`
- `risk_pack.xlsx`:
  - tabs: `summary`, `daily`, `breach_rebound`, `tp_impact`, `tp_rule_breakdown`

### True TP simulation knobs

Set in `scripts/fixtures/pilot_backtest_config.example.json`:

- `takeProfit.enabled` (true/false)
- `takeProfit.reboundPct` (close hedge when rebound from post-breach low reaches this %)
- `takeProfit.decayPct` (close hedge when intrinsic value decays this % from peak after breach)

CLI overrides (without editing config):

```bash
npm run -s pilot:backtest:run -- \
  --config scripts/fixtures/pilot_backtest_config.example.json \
  --prices-csv artifacts/backtest/btc_usd_1h.csv \
  --mode both \
  --tp-enabled true \
  --tp-rebound-pct 2 \
  --tp-decay-pct 2 \
  --out-json artifacts/backtest/pilot_backtest_tp.json \
  --out-csv artifacts/backtest/pilot_backtest_tp.csv
```

## Config knobs to edit first

Edit: `scripts/fixtures/pilot_backtest_config.example.json`

- `tenorDays`: default 7 (set 14/21/28 for longer-tenor tests)
- `entryStepHours`: 24 for one new trade/day (lower for denser simulation)
- `breachMode`: `path_min` (recommended) or `expiry_only`
- `notionalsUsd`: basket of tested notionals
- `treasury.startingBalanceUsd`
- `treasury.dailySubsidyCapUsd`
- `treasury.perQuoteSubsidyCapPct`
- Per tier:
  - `strictPremiumPer1kProtectedUsd`
  - `hybridPremiumPer1kProtectedUsd` (keep this as a discounted share of strict; live pilot default is the cheaper schedule)
  - `fallbackHedgePremiumPer1kProtectedUsd`
  - `strictHedgeRecoveryPct`
  - `hybridHedgeRecoveryPct`

## Live pilot pricing lock-in

Production pilot defaults:

- Hybrid pricing uses the cheaper strict-discount schedule:
  - Bronze: `0.60 x strict`
  - Silver: `0.67 x strict`
  - Gold: `0.72 x strict`
  - Platinum: `0.72 x strict`
- Premium regimes can still add watch/stress overlays when treasury telemetry deteriorates.
- Take-profit is disabled in production (`tp_off`) for simplicity and treasury governance.
- r/d take-profit settings remain available only in backtests and experiments.

Rounded UI pricing chart (presentation only; underwriting still uses exact cheaper multipliers):

| Tier | Floor | Rounded per 1k/week | 5k | 10k | 25k | 50k |
|---|---:|---:|---:|---:|---:|---:|
| Bronze | 20% | $25 | $125 | $250 | $625 | $1,250 |
| Silver | 15% | $21 | $105 | $210 | $525 | $1,050 |
| Gold | 12% | $18 | $90 | $180 | $450 | $900 |
| Platinum | 12% | $17 | $85 | $170 | $425 | $850 |

## FalconX integration path (next step)

To make hedge cost fully FalconX-native:

1. Export RFQ/order history (timestamp, tenor, strike distance, premium paid, fill status).
2. Build a bucket map (tier + tenor + moneyness => hedge premium per 1k, recovery assumptions).
3. Replace `fallbackHedgePremiumPer1kProtectedUsd` and recovery factors with those FalconX-derived values per bucket.

You can keep this script structure unchanged and swap only the config generation step.

## Executive risk quick query

```bash
jq '.executiveRisk' artifacts/backtest/pilot_backtest.json
```

## Breach mode override from shell

If you want to compare modes without editing config:

```bash
# path-based (default / recommended)
BREACH_MODE=path_min npm run -s pilot:backtest:quick

# legacy expiry-only logic
BREACH_MODE=expiry_only npm run -s pilot:backtest:quick
```

## TP parameter sweep (grid search + ranked workbook)

Purpose:
- Test multiple TP settings across your stress + calm quarter set.
- Rank combinations that reduce stress-quarter subsidy without sacrificing calm-quarter performance.
- Export one workbook with tabs (overall summary, combo scores, per-quarter rows, etc.).

Example (16 combos: rebound 1/2/3/4 x decay 10/20/30/40):

```bash
cd /opt/ibkr-stack/services/api
npm run -s pilot:backtest:tp-sweep -- \
  --out-dir artifacts/backtest/stress_tp/sweep \
  --rebound-grid "1,2,3,4" \
  --decay-grid "10,20,30,40" \
  --quarters "q2_2022,2022-04-01T00:00:00Z,2022-07-01T00:00:00Z,stress;q4_2022,2022-10-01T00:00:00Z,2023-01-01T00:00:00Z,stress;q1_2023,2023-01-01T00:00:00Z,2023-04-01T00:00:00Z,calm;q1_2024,2024-01-01T00:00:00Z,2024-04-01T00:00:00Z,calm" \
  --source coinbase
```

Outputs under `artifacts/backtest/stress_tp/sweep/`:
- `tp_sweep_ranked.csv` (best-to-worst TP combos by weighted score)
- `tp_sweep_combo_summary.csv` (all combos + key metrics)
- `tp_sweep_quarterly.csv` (per-quarter per-model stats)
- `tp_sweep_baseline.csv` (TP-disabled baseline)
- `tp_sweep_overview.md` (concise narrative)
- `tp_sweep.xlsx` with tabs:
  - `ranked`
  - `combo_summary`
  - `quarterly`
  - `baseline`
  - `weights`

Notes:
- Lower score is better.
- Score emphasizes stress subsidy + blocked subsidy + drawdown and adds a smaller penalty if calm-quarter PnL improvement is negative.

## Dynamic selector + governance controls

New runtime controls (env):

```bash
# Optimizer + regime switching
PILOT_HEDGE_OPTIMIZER_ENABLED=true
PILOT_HEDGE_OPTIMIZER_VERSION=optimizer_v1

# Rollout guards (fallback/pause)
PILOT_GUARD_FALLBACK_TRIGGER_HIT_RATE_PCT=8
PILOT_GUARD_FALLBACK_SUBSIDY_UTILIZATION_PCT=50
PILOT_GUARD_FALLBACK_TREASURY_DRAWDOWN_PCT=25
PILOT_GUARD_PAUSE_TRIGGER_HIT_RATE_PCT=15
PILOT_GUARD_PAUSE_SUBSIDY_UTILIZATION_PCT=85
PILOT_GUARD_PAUSE_TREASURY_DRAWDOWN_PCT=50
PILOT_GUARD_PAUSE_ON_BLOCKED_SUBSIDY=true

# Tier batching + tenor ladder
PILOT_TIER_BATCHING_ENABLED=true
PILOT_TIER_BATCHING_WINDOW_SECONDS=30
PILOT_TIER_BATCHING_MAX_QUOTES=50
PILOT_TIER_GROUPING_ENABLED=true
PILOT_TENOR_LADDER_ENABLED=true
PILOT_TENOR_LADDER_DAYS=7,14,21
```

Admin diagnostics endpoints:

- `GET /pilot/admin/diagnostics/selector`
- `GET /pilot/admin/diagnostics/execution-quality?lookbackDays=30`
- `GET /pilot/admin/governance/rollout-guards`
