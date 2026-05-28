# Foxify Shadow Bot — Operator Runbook

> Driver that simulates Foxify's bot hitting Atticus's `/foxify/v2/activate` in
> shadow mode (no real venue orders) to gather 14 days of empirical settled-PnL
> data for cell EV validation.

---

## What it does

1. Polls `GET /foxify/v2/regime` every ~57 min (for 25 pairs/day cadence)
2. Looks up `CELL_PREFERENCE_BY_REGIME[regime]`
3. Sends `POST /foxify/v2/activate {isShadow: true, cellId: ...}`
4. Logs structured JSON (one line per event) for Loki/CloudWatch/Render
5. Skips when Atticus halt is active; resumes on next tick when cleared
6. Tracks success/blocked counts; prints `STATS` every 10 ticks (~10 hours)

It does **not** execute any real orders. All pairs are inserted with
`is_shadow = TRUE` and never reach Bullish/Deribit. Trigger detector and
execution runtime still run for these pairs in mocked mode (via
`ShadowStrangleExecutor` / `ShadowCloseExecutor`), so settled-PnL math
exercises the same code path as live but uses simulated fills.

---

## Why we need it

Three MC iterations (V1/V2/V3) have known limitations:

| Iteration | Cost model              | Limitation                              |
|-----------|-------------------------|------------------------------------------|
| V1        | BS × 1.07 fudge         | 30–100% off real spreads                 |
| V2        | Single 3d-tenor smile   | Pessimistic for 6h/1d cells              |
| V3        | Per-tenor smile + spread | Best available, but still simulation     |

The shadow bot produces **real** settled PnL from real BTC paths. After 14 days,
we cross-check shadow EV against V3 MC prediction via
`computeShadowReconciliation`. If drift > 15%, we know V3 still has bias and
should re-calibrate before going live.

---

## Setup

### Required env

```bash
export FOXIFY_API_URL=<atticus-api-base-url>      # required, e.g. your Render host
export FOXIFY_API_KEY=<foxify_token>              # X-Foxify-Token header value
export SHADOW_BOT_PAIRS_PER_DAY=25                # default 25
export SHADOW_BOT_MAX_HEDGE_USD=10000             # generous so most quotes pass
export SHADOW_BOT_STOP_AFTER_HOURS=0              # 0 = run forever
```

### Run locally

```bash
cd services/api
npx tsx scripts/integration/foxifyShadowBot.ts
```

### Run on Render (recommended for 14d unattended)

Add a new background worker service to `render.yaml` (or via dashboard):

```yaml
- name: foxify-shadow-bot
  type: worker
  env: node
  buildCommand: cd services/api && npm install
  startCommand: cd services/api && npx tsx scripts/integration/foxifyShadowBot.ts
  envVars:
    - key: FOXIFY_API_URL
      sync: false   # set to your Atticus API host in dashboard
    - key: FOXIFY_API_KEY
      sync: false   # set in dashboard
    - key: SHADOW_BOT_PAIRS_PER_DAY
      value: "25"
```

---

## Reading results

### Real-time stats (stdout)

```
{"ts":"...","svc":"foxify-shadow-bot","msg":"STATS","tickCount":50,"successCount":47,"blockedCount":3,"successRatePct":"94.0","blockReasonCounts":{"price_exceeded":2,"halt:atticus:dvol_calm":1}}
```

### Aggregate via dashboard

```bash
curl -H "X-Foxify-Token: $FOXIFY_API_KEY" \
  "$FOXIFY_API_URL/foxify/v2/status"
```

Filter the response for `is_shadow=true` pairs (or use the admin
diagnostics endpoint for unfiltered detail).

### Shadow-vs-MC reconciliation

The `computeShadowReconciliation` function in
`services/api/src/singleSide/twoSided/shadowReconciliation.ts` computes
realized shadow PnL vs MC prediction per cell, alerting if drift > 15%.

Recommended cron: nightly Render cron job calling the reconciliation
function, logging output, alerting on drift.

---

## What to watch for

### Healthy signal

- `successRatePct` > 70% during moderate+ regimes
- `blockReasonCounts` dominated by `cell_disabled_in_regime` during calm
  (expected behaviour — V3 says calm is loss-making)
- `STATS` logs steady; no `tick error` entries
- Shadow PnL within ±15% of V3 MC prediction after 14d

### Warning signs

- `successRatePct` < 50% during moderate+ → look at `blockReasonCounts`,
  likely `price_exceeded` (live spreads worse than V3 expected) or
  `depth_insufficient` (Deribit quote depth gone)
- `halt:atticus:capital_pool_exhausted` → Atticus running out of $3,500
  budget; expected if many pairs trigger simultaneously
- Shadow PnL drift > 15% from MC → re-run multi-tenor probe + V3 sweep
  with fresh data, recalibrate `REGIME_COST_MARKUP`

---

## Stopping

- `kill -SIGINT <pid>` for graceful shutdown (prints final STATS)
- Or set `SHADOW_BOT_STOP_AFTER_HOURS=336` (14d) to auto-stop

---

## Operator decisions captured

- **Cell preference per regime**: hard-coded in `CELL_PREFERENCE_BY_REGIME`.
  Update the constant + redeploy to change behaviour.
- **Cadence**: `SHADOW_BOT_PAIRS_PER_DAY` env var, default 25.
- **Max hedge cap**: `SHADOW_BOT_MAX_HEDGE_USD` env var, default $10k.

---

## Next steps after 14d shadow run

1. Pull `SELECT cell_id, COUNT(*), AVG(foxify_pnl_usdc) FROM two_sided_pair
   WHERE is_shadow=TRUE GROUP BY cell_id` — get realized per-cell EV
2. Compare to V3 MC prediction
3. If drift acceptable → flip live cutover flag (`SS_TWO_SIDED_LIVE_ENABLED=1`)
   with same cell allowlist
4. If drift unacceptable → debug and re-test in shadow
