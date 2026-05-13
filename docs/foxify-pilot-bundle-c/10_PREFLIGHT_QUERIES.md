# Pre-Flight Live Data Queries (WS#6, Operator Action)

> **Purpose:** Pull live pilot data from production Postgres to (a) validate Bundle C economics against actual observed behavior and (b) calibrate the WS#9 backtest harness "current baseline" with reality.
>
> **Read-only.** Run these against the production read replica or a fresh dump — never the primary. Zero production impact.
>
> **Phase split:** Phase A = pre-iteration trades (configuration history); Phase B = current configuration (started with trade `1c7e17f9`).

---

## How to run

Choose one:
- **Render dashboard:** Database tab → Connect → use the provided `psql` connection string for the read replica → paste each query and capture output
- **Local with read-only credentials:** `psql $POSTGRES_READ_REPLICA_URL -f preflight_<n>.sql`
- **Render shell:** if you have shell access, attach to the Postgres service and paste

Save outputs as `docs/foxify-pilot-bundle-c/preflight-results/<query-name>.tsv` (or paste into chat for non-sensitive results).

---

## Query 1 — Identify the Phase A → Phase B boundary

```sql
-- Find the boundary trade (1c7e17f9...) created_at timestamp
SELECT id, created_at, sl_pct, side, premium, protected_notional
FROM pilot_protections
WHERE id::text LIKE '1c7e17f9%'
LIMIT 1;
```

Capture the `created_at` value — call it `BOUNDARY_TS`. Used by every subsequent query.

---

## Query 2 — Tier mix demand (Phase B)

```sql
-- What % of new protections are in each SL tier per day?
SELECT
  date_trunc('day', created_at) AS day,
  sl_pct,
  side,
  COUNT(*) AS n,
  SUM(protected_notional) AS notional_usd,
  SUM(premium) AS total_premium_usd
FROM pilot_protections
WHERE created_at >= '<BOUNDARY_TS>'
  AND status NOT IN ('cancelled', 'activation_failed')
GROUP BY 1, 2, 3
ORDER BY 1, 2;
```

**Validates:** assumed Bundle C tier mix (30/30/25/15 across 2/3/5/7). If real mix is heavily skewed (>60% in 2%), Bundle C economics need re-tuning.

---

## Query 3 — Trigger rate by tier × side × regime (Phase B)

```sql
-- Per-tier per-side observed trigger rate
SELECT
  sl_pct,
  side,
  COUNT(*) AS total_protections,
  COUNT(*) FILTER (WHERE status IN ('triggered', 'expired_itm')) AS triggered,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE status IN ('triggered', 'expired_itm')) / NULLIF(COUNT(*), 0),
    2
  ) AS trigger_rate_pct
FROM pilot_protections
WHERE created_at >= '<BOUNDARY_TS>'
  AND status NOT IN ('cancelled', 'activation_failed', 'pending_activation', 'active')
GROUP BY 1, 2
ORDER BY 1, 2;
```

**Validates:** historical trigger rates from `backtest_definitive_v7_results.txt`:
- 2% expected ~35%, 3% ~21%, 5% ~8%, 7% ~3.5%, 10% ~1.2% (blended across regimes)

---

## Query 4 — Realized hedge cost vs client premium (margin %) per protection

```sql
-- Per-protection margin = (premium - hedge_cost) / premium
SELECT
  p.id,
  p.created_at,
  p.sl_pct,
  p.side,
  p.protected_notional,
  p.premium AS client_premium,
  ve.execution_price AS hedge_unit_price,
  ve.quantity AS hedge_qty,
  (ve.execution_price * ve.quantity) AS hedge_cost_usd,
  p.premium - (ve.execution_price * ve.quantity) AS margin_usd,
  ROUND(
    100.0 * (p.premium - (ve.execution_price * ve.quantity)) / NULLIF(p.premium, 0),
    2
  ) AS margin_pct
FROM pilot_protections p
JOIN pilot_venue_executions ve ON ve.protection_id = p.id AND ve.side = 'buy'
WHERE p.created_at >= '<BOUNDARY_TS>'
  AND ve.status = 'success'
ORDER BY p.created_at DESC
LIMIT 200;
```

**Validates:** WS#9 backtest assumes ~88% margin in calm regime. If realized margin tracks much lower, hedge cost is being underestimated.

---

## Query 5 — Hedge budget burn rate (cumulative gross)

```sql
-- Cumulative hedge spend by day
SELECT
  date_trunc('day', executed_at) AS day,
  COUNT(*) AS hedges_bought,
  SUM(execution_price * quantity) AS daily_hedge_cost_usd,
  SUM(SUM(execution_price * quantity)) OVER (
    ORDER BY date_trunc('day', executed_at)
  ) AS cumulative_usd
FROM pilot_venue_executions
WHERE side = 'buy'
  AND status = 'success'
  AND executed_at >= '<BOUNDARY_TS>'
GROUP BY 1
ORDER BY 1;
```

**Validates:** Bundle C cap schedule. If cumulative spend is already >$5k by Day 7 of pilot, the rev 6 cap schedule ($5k/$8.5k/$10k by Days 7/14/28) needs to lift.

---

## Query 6 — TP recovery rate per direction (LONG vs SHORT)

```sql
-- Per-protection TP recovery: proceeds vs payout owed
WITH triggered_with_tp AS (
  SELECT
    p.id,
    p.sl_pct,
    p.side,
    p.payout_due_amount,
    (p.metadata->'sellResult'->>'totalProceeds')::numeric AS tp_proceeds,
    (p.metadata->'bsRecovery'->>'totalValue')::numeric AS bs_modeled_value
  FROM pilot_protections p
  WHERE p.status = 'triggered'
    AND p.hedge_status = 'tp_sold'
    AND p.created_at >= '<BOUNDARY_TS>'
)
SELECT
  side,
  sl_pct,
  COUNT(*) AS n,
  ROUND(AVG(tp_proceeds), 2) AS avg_tp_proceeds_usd,
  ROUND(AVG(payout_due_amount), 2) AS avg_payout_due_usd,
  ROUND(AVG(tp_proceeds / NULLIF(payout_due_amount, 0)), 4) AS avg_recovery_vs_payout_ratio,
  ROUND(AVG(tp_proceeds / NULLIF(bs_modeled_value, 0)), 4) AS avg_realization_vs_bs_ratio
FROM triggered_with_tp
GROUP BY 1, 2
ORDER BY 1, 2;
```

**Validates:** WS#9 backtest's 68% TP recovery assumption (R1 baseline measured on Phase A trades). If Phase B recovery is materially different, harness recalibration needed.

---

## Query 7 — Slippage drift (USD per fill)

```sql
-- Average USD slippage per fill, daily
SELECT
  date_trunc('day', executed_at) AS day,
  COUNT(*) AS fills,
  ROUND(AVG((details->'fillConfirmation'->>'fillPrice')::numeric -
           (details->>'quotedAskPrice')::numeric), 4) AS avg_slip_usd,
  ROUND(STDDEV((details->'fillConfirmation'->>'fillPrice')::numeric -
              (details->>'quotedAskPrice')::numeric), 4) AS stddev_slip_usd
FROM pilot_venue_executions
WHERE side = 'buy'
  AND status = 'success'
  AND executed_at >= '<BOUNDARY_TS>'
  AND (details->>'quotedAskPrice') IS NOT NULL
GROUP BY 1
ORDER BY 1;
```

**Validates:** Slippage drift watch trigger from CFO §11.2. Sustained > +$1/fill over 5-day window = investigate microstructure.

---

## Query 8 — Per-trade lifecycle inspection (recently triggered)

```sql
-- Most recent triggered protections — full timeline for each
SELECT
  id,
  sl_pct,
  side,
  status,
  hedge_status,
  protected_notional,
  premium AS client_premium,
  payout_due_amount,
  metadata->'sellResult'->>'totalProceeds' AS tp_proceeds,
  metadata->>'triggerAt' AS trigger_at,
  metadata->>'soldAt' AS sold_at,
  metadata->'sellResult'->>'orderId' AS tp_order_id,
  metadata->>'noBidRetryCount' AS no_bid_retries
FROM pilot_protections
WHERE status = 'triggered'
  AND created_at >= '<BOUNDARY_TS>'
ORDER BY created_at DESC
LIMIT 20;
```

**Validates:** TP cycle behavior; identifies stuck no-bid trades and per-trade outcomes.

---

## Query 9 — Bot suspicion patterns

```sql
-- Look for bot-style behavior: high quote-to-activate ratios, paired
-- long+short opens within minutes
WITH same_session_pairs AS (
  SELECT
    a.id AS long_id,
    b.id AS short_id,
    a.created_at AS long_at,
    b.created_at AS short_at,
    EXTRACT(EPOCH FROM (b.created_at - a.created_at)) AS gap_seconds,
    a.sl_pct,
    a.protected_notional
  FROM pilot_protections a
  JOIN pilot_protections b ON b.user_hash = a.user_hash
    AND a.created_at < b.created_at
    AND b.created_at - a.created_at < INTERVAL '30 minutes'
    AND a.sl_pct = b.sl_pct
    AND a.side = 'long' AND b.side = 'short'
  WHERE a.created_at >= '<BOUNDARY_TS>'
)
SELECT
  sl_pct,
  COUNT(*) AS paired_open_count,
  AVG(gap_seconds) AS avg_gap_seconds,
  AVG(protected_notional) AS avg_notional
FROM same_session_pairs
GROUP BY 1
ORDER BY 1;
```

**Validates:** CEO's bot threat hypothesis — if there are many paired long+short opens within 30 minutes from the same user_hash, the opposing-perp arb pattern is being actively exploited and Bundle C anti-bot defenses are urgent.

---

## Query 10 — Aggregate health check (for Day 1 sanity)

```sql
-- One-row summary across the entire pilot
SELECT
  MIN(created_at) AS pilot_started,
  MAX(created_at) AS most_recent_trade,
  COUNT(*) AS total_protections,
  COUNT(*) FILTER (WHERE created_at >= '<BOUNDARY_TS>') AS phase_b_protections,
  COUNT(*) FILTER (WHERE status = 'triggered') AS triggered,
  COUNT(*) FILTER (WHERE status = 'expired_otm') AS expired_otm,
  COUNT(*) FILTER (WHERE status = 'expired_itm') AS expired_itm,
  COUNT(*) FILTER (WHERE status = 'active') AS still_active,
  SUM(premium) AS total_premium_collected_usd,
  SUM(payout_due_amount) AS total_payouts_due_usd
FROM pilot_protections;
```

---

## Output format suggestion

Save outputs as TSV under `docs/foxify-pilot-bundle-c/preflight-results/`:

```
preflight-results/
  01_boundary_trade.tsv
  02_tier_mix.tsv
  03_trigger_rates.tsv
  04_margin_per_protection.tsv
  05_hedge_burn_rate.tsv
  06_tp_recovery.tsv
  07_slippage.tsv
  08_recent_triggered.tsv
  09_bot_suspicion.tsv
  10_aggregate_health.tsv
```

Then ping the engineering team to:
1. Update WS#9 backtest scenarios to use the real observed numbers (especially current pricing if it differs from $25/$10k assumption)
2. Tune anti-bot defense thresholds based on observed pattern frequency
3. Adjust hedge budget cap schedule if burn rate exceeds projection

---

## What if the queries return nothing or weird data?

- **Pilot just started:** few/no Phase B trades yet → harness uses analytical defaults; ok
- **No triggered trades:** TP recovery query returns empty → use R1 baseline 68% in harness; ok
- **Database read replica unavailable:** can run against primary but rate-limit yourself (`LIMIT 100`) and only during low-traffic windows
- **PERMISSION DENIED on metadata fields:** add `SET role TO read_only_analyst` if your role is correct

If any query produces unexpected results, share with engineering before drawing conclusions — pre-flight data calibration matters too much to misread.
