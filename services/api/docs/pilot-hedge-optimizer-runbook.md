# Pilot Hedge Optimizer Runbook

## Purpose

This runbook describes how to operate the dynamic hedge selector that keeps strikes as close to ATM/small ITM as feasible while respecting treasury and execution constraints.

## Core controls

### 1) Dynamic selector + constraints

Key env/config:

- `PILOT_HEDGE_OPTIMIZER_ENABLED`
- `PILOT_HEDGE_WEIGHT_*`
- `PILOT_HEDGE_CONSTRAINT_*`

Hard constraints are applied before scoring:

- max premium ratio
- max spread
- min ask size
- max tenor drift
- min tail-protection score
- max expected subsidy

### 2) Regime switching

Regime policy controls closer/farther strike tolerance:

- `PILOT_HEDGE_REGIME_CALM_*`
- `PILOT_HEDGE_REGIME_NEUTRAL_*`
- `PILOT_HEDGE_REGIME_STRESS_*`

### 3) Data ingestion + execution feedback

Use:

- `npm run -s pilot:backfill:options-chain -- ...`
- `npm run -s pilot:backfill:rfq-history -- ...`
- `npm run -s pilot:backfill:execution-quality -- ...`

Execution quality daily rows are stored in `pilot_execution_quality_daily`.

### 4) Tier batching + tenor ladder controls

Key env/config:

- `PILOT_TIER_BATCHING_ENABLED`
- `PILOT_TIER_BATCHING_WINDOW_SECONDS`
- `PILOT_TIER_BATCHING_MAX_QUOTES`
- `PILOT_TENOR_LADDER_ENABLED`
- `PILOT_TENOR_LADDER_DAYS`

### 5) Rollout guards

Key env/config:

- `PILOT_GUARD_FALLBACK_*`
- `PILOT_GUARD_PAUSE_*`
- `PILOT_GUARD_PAUSE_ON_BLOCKED_SUBSIDY`

Guard action helper in trigger monitor:

- `normal_hybrid_ok`
- `strict_fallback`
- `issuance_pause`

## Diagnostics endpoints

- `GET /pilot/admin/diagnostics/selector`
- `GET /pilot/admin/diagnostics/execution-quality?lookbackDays=30`
- `GET /pilot/admin/governance/rollout-guards`

## Backtest outputs

Backtest/risk-pack now include selector metadata in rows and summary:

- dynamic selector enabled
- selector mode
- hedge regime
- selected tenor days
- selected strike distance

Use these to verify subsidy reduction vs. baseline.

