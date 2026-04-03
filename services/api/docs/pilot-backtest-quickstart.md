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
  - Downloads hourly BTC history CSV for backtest windows (auto source fallback: Binance -> CoinGecko).
- `scripts/pilotBacktestRun.ts`
  - Runs strict/hybrid historical replay over notionals x tiers.
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
- `artifacts/backtest/pilot_backtest.json`
  - Includes full rows + compact `summary` table per model

## Config knobs to edit first

Edit: `scripts/fixtures/pilot_backtest_config.example.json`

- `tenorDays`: default 7 (set 14/21/28 for longer-tenor tests)
- `entryStepHours`: 24 for one new trade/day (lower for denser simulation)
- `notionalsUsd`: basket of tested notionals
- `treasury.startingBalanceUsd`
- `treasury.dailySubsidyCapUsd`
- `treasury.perQuoteSubsidyCapPct`
- Per tier:
  - `strictPremiumPer1kProtectedUsd`
  - `hybridPremiumPer1kProtectedUsd`
  - `fallbackHedgePremiumPer1kProtectedUsd`
  - `strictHedgeRecoveryPct`
  - `hybridHedgeRecoveryPct`

## FalconX integration path (next step)

To make hedge cost fully FalconX-native:

1. Export RFQ/order history (timestamp, tenor, strike distance, premium paid, fill status).
2. Build a bucket map (tier + tenor + moneyness => hedge premium per 1k, recovery assumptions).
3. Replace `fallbackHedgePremiumPer1kProtectedUsd` and recovery factors with those FalconX-derived values per bucket.

You can keep this script structure unchanged and swap only the config generation step.
