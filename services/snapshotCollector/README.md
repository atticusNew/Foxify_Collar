# Foxify Pilot Snapshot Collector

Read-only background worker that polls the **live** `foxify-pilot-new` admin endpoints,
persists raw snapshots + derived metrics to its **own** Postgres database, and emits
structured logs.

This service **never writes to the live pilot DB**. It only uses public admin
endpoints with `X-Admin-Token` auth. Worst-case failure = its own DB rows aren't
written. The live pilot is unaffected.

## What it captures

Every 60s ("fast" tick):
- `/volume-cover/health` — spot price, health
- `/volume-cover/admin/dashboard` — halt status, active position count
- `/volume-cover/admin/active-positions-detail?limit=200` — full position + leg detail

Every 300s ("full" tick) — fast tick + the below:
- `/volume-cover/admin/all-open-legs` — leg inventory
- `/volume-cover/admin/pool-ledger?poolId=atticus_hedge&limit=500`
- `/volume-cover/admin/pool-ledger?poolId=foxify_trader&limit=500`
- (optional) `POST /volume-cover/admin/hedge-manager/run?dryRun=true&iv=0.4` —
  rule-firing observations. Disabled by default; enable via
  `SNAPSHOT_HEDGE_MGR_DRY_RUN_ENABLED=true` only after confirming live ops accept it.

Every UTC day at `SNAPSHOT_DAILY_ROLLUP_HOUR` (default 01:00 UTC):
- Computes a `daily_metrics` row covering closed positions, salvage %, premium intake,
  hedge buy/sell, payout, net Atticus P&L, and rule-firing distribution.

## Schema

See `migrations/001_init.sql`. Tables:
- `snapshot_run` — one row per polling tick
- `snapshot_raw` — raw JSON of each endpoint response
- `snapshot_position` — derived per-position rows (one per snapshot, not per position)
- `snapshot_leg` — derived per-leg rows
- `snapshot_pool_ledger` — captured ledger entries
- `snapshot_health` — health/dashboard summary
- `snapshot_rule_firing` — TP rule-firing observations from dry-run
- `daily_metrics` — daily roll-up materialization

Run migrations on boot is the default (`SNAPSHOT_RUN_MIGRATIONS_ON_BOOT=true`).

## Required environment variables

| Var | Required | Default | Meaning |
|---|---|---|---|
| `SNAPSHOT_FOXIFY_PILOT_URL` | yes | — | e.g. `https://foxify-pilot-new.onrender.com` |
| `SNAPSHOT_FOXIFY_ADMIN_TOKEN` | yes | — | The live `PILOT_ADMIN_TOKEN` (read access only — DO NOT share with shadow service) |
| `SNAPSHOT_POSTGRES_URL` | yes | — | Connection string for the collector's own DB |

Optional:

| Var | Default | Meaning |
|---|---|---|
| `SNAPSHOT_FAST_INTERVAL_MS` | `60000` | Fast tick cadence |
| `SNAPSHOT_FULL_INTERVAL_MS` | `300000` | Full tick cadence |
| `SNAPSHOT_DAILY_ROLLUP_HOUR` | `1` | UTC hour for daily roll-up (0-23) |
| `SNAPSHOT_HEDGE_MGR_DRY_RUN_ENABLED` | `false` | Whether to call admin hedge-manager dry-run |
| `SNAPSHOT_HEDGE_MGR_IV` | `0.4` | IV value passed to dry-run |
| `SNAPSHOT_FETCH_TIMEOUT_MS` | `15000` | Per-request timeout |
| `SNAPSHOT_DB_POOL_MAX` | `4` | PG pool max connections |
| `SNAPSHOT_DB_SSL` | `auto` | Force `true` for non-Render hosts behind TLS |
| `SNAPSHOT_RUN_MIGRATIONS_ON_BOOT` | `true` | Idempotent migration on boot |

## Deploy on Render

A blueprint config is provided at the repo root: `render-snapshot.yaml`.

```bash
# Apply blueprint
# Render dashboard → Blueprints → New Blueprint Instance → point at render-snapshot.yaml
```

After the worker + DB are created, set in Render dashboard:
1. `SNAPSHOT_FOXIFY_PILOT_URL=https://foxify-pilot-new.onrender.com`
2. `SNAPSHOT_FOXIFY_ADMIN_TOKEN=<copy from foxify-pilot-new env>`

Logs (structured JSON) appear in the Render service log stream.

## Local development

```bash
# 1. Start a local Postgres (or point at a free Render instance)
export SNAPSHOT_POSTGRES_URL=postgres://localhost:5432/snapshot_dev

# 2. Set live pilot creds (read-only)
export SNAPSHOT_FOXIFY_PILOT_URL=https://foxify-pilot-new.onrender.com
export SNAPSHOT_FOXIFY_ADMIN_TOKEN=<your operator token>

# 3. Run migrations
npm --workspace services/snapshotCollector run migrate

# 4. Start the collector
npm --workspace services/snapshotCollector start

# Or in dev mode with autoreload
npm --workspace services/snapshotCollector run dev
```

## Querying captured data

Useful starter queries against the collector DB:

```sql
-- Latest realized salvage % per closed position
SELECT DISTINCT ON (position_id)
  position_id, cell_id, status, salvage_state,
  hedge_buy_usdc, hedge_sell_usdc, realized_salvage_pct, observed_at
FROM snapshot_position
WHERE status IN ('closed', 'expired', 'triggered')
ORDER BY position_id, observed_at DESC
LIMIT 50;

-- Rule-firing distribution last 24h
SELECT rule, action, count(*)
FROM snapshot_rule_firing
WHERE observed_at >= now() - interval '24 hours'
GROUP BY rule, action
ORDER BY rule, action;

-- Atticus pool running balance over time
SELECT date_trunc('hour', ts::timestamptz) AS hour,
       SUM(amount_usdc) AS net_flow,
       SUM(SUM(amount_usdc)) OVER (ORDER BY date_trunc('hour', ts::timestamptz)) AS running_balance
FROM snapshot_pool_ledger
WHERE pool_id = 'atticus_hedge' AND ts IS NOT NULL
GROUP BY hour
ORDER BY hour;

-- Latest daily metrics
SELECT date_utc, closed_positions_count, triggered_count,
       avg_salvage_pct, total_premium_in_usdc, net_atticus_pnl_usdc
FROM daily_metrics
ORDER BY date_utc DESC
LIMIT 14;
```

## Operational guarantees

- Polling is **read-only**. The live pilot's DB and execution path are not touched.
- Each poll tick is wrapped in a `snapshot_run` row with `ok` + `error_message`. A
  failed poll never crashes the worker — the next tick will retry. Sustained errors
  are observable via `WHERE ok=false`.
- Schema mismatches (live API changes) are captured in `snapshot_run.error_message`
  with prefix `schema_mismatch:`. Raw response payload is still saved in
  `snapshot_raw.payload_jsonb` for forensics.
- The worker shuts down cleanly on SIGTERM / SIGINT (Render's deploy lifecycle).

## Disabling

To pause the collector, suspend the Render worker service. Data already captured
remains queryable. To fully delete, drop the `snapshot_*` and `daily_metrics`
tables.
