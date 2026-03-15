# Pilot Rollout Plan and Acceptance Gates

## Phase 0 (same day)

- Lock pricing to:
  - `final_fee = max(tier_floor_fee, hedge_premium * (1 + tier_markup + leverage_markup))`
- Keep CTC in shadow mode (`ctc_shadow_mode=true`).
- Keep pass-through + floor as charge basis for all pilot tiers.
- Enforce tier cohort minimum notionals. Out-of-cohort requests return `reason=tier_notional_min`.

## Phase 1 (2-3 days)

- Validate CTC exposure semantics with fixed-notional test matrix.
- Validate CTC guardrails:
  - max multiple of hedge premium
  - max percent of protected notional
- Validate tenor control behavior and fallback attribution.

## Phase 2 (canary)

- Re-enable CTC fee influence only if:
  - `ctc_shadow_mode=false`
  - `ctc_price_override_enabled=true`
  - bounds are respected
- Canary on selected tiers and 5-10% traffic.

## Acceptance Gates (before full pilot)

1. No premium caps on pass-through pricing (policy consistency check).
2. Quote-to-audit reconciliation error `< 0.5%` for coverage economics fields.
3. Tenor drift > 2 days only when `tenorReason=tenor_fallback`.
4. Activation success remains stable with no execution regression.

## Rollout-day runbook: daily usage backfill

When deploying the atomic daily cap reservation model (`pilot_daily_usage`) mid-day, backfill current UTC-day usage once to prevent temporary cap drift.

```sql
WITH day_bounds AS (
  SELECT date_trunc('day', now() AT TIME ZONE 'UTC')::date AS day_start
),
daily_agg AS (
  SELECT
    p.user_hash,
    (p.created_at AT TIME ZONE 'UTC')::date AS day_start,
    COALESCE(SUM(p.protected_notional), 0)::numeric(28,10) AS used_notional
  FROM pilot_protections p
  JOIN day_bounds d
    ON (p.created_at AT TIME ZONE 'UTC')::date = d.day_start
  GROUP BY p.user_hash, (p.created_at AT TIME ZONE 'UTC')::date
)
INSERT INTO pilot_daily_usage (user_hash, day_start, used_notional)
SELECT user_hash, day_start, used_notional
FROM daily_agg
ON CONFLICT (user_hash, day_start)
DO UPDATE SET used_notional = EXCLUDED.used_notional;
```

Notes:
- This statement is idempotent and safe to re-run.
- Scope is current UTC day only.

## Optional pilot campaign window (start + hard stop)

To enforce a strict pilot campaign window for new quote/activate requests:

- `PILOT_ENFORCE_WINDOW=true`
- `PILOT_START_AT=<ISO-8601 UTC timestamp>`
- `PILOT_DURATION_DAYS=30`

Behavior:
- before start: `reason=pilot_not_started`
- at/after end: `reason=pilot_window_closed`
- existing protections continue through monitor/expiry/admin flows.
