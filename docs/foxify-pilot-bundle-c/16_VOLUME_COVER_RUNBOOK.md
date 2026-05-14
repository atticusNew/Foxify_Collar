# Volume Cover Operations Runbook

**Audience:** Atticus operator (you).
**Scope:** Day-to-day operation of the Volume Cover product during the Foxify pilot.

---

## Quick reference

| Need to... | Do |
|---|---|
| See live state | `GET /volume-cover/admin/dashboard` (markdown) |
| Pull daily report | `GET /volume-cover/admin/foxify-report?date=YYYY-MM-DD` |
| Check salvage stats | `GET /volume-cover/admin/salvage-stats` |
| Disable a cell | `POST /volume-cover/admin/cells/<cellId>/toggle` `{ "enabled": false }` |
| Raise per-cell throttle | `POST /volume-cover/admin/cells/<cellId>/toggle` `{ "throttleMaxPerDay": 30 }` |
| Adjust cell premium | `POST /volume-cover/admin/cells/<cellId>/toggle` `{ "dailyPremiumUsdc": 425 }` |
| HALT all activations | `POST /volume-cover/admin/halt` `{ "reason": "<why>" }` |
| Resume after halt | `POST /volume-cover/admin/halt/clear` `{}` |
| Force trigger detector cycle | `POST /volume-cover/admin/trigger-detector/run` |
| Close a position manually | `POST /volume-cover/admin/positions/:id/close` `{ "reason": "..." }` |

All admin endpoints require `X-Admin-Token: $PILOT_ADMIN_TOKEN` header.

---

## Environment variables (production)

### Required
```
VOLUME_COVER_ENABLED=true
PILOT_ADMIN_TOKEN=<64-char random>
FOXIFY_API_KEY_HMAC_SECRET=<64-char random; shared with Foxify in person at signing>
POSTGRES_URL=<connection string>
```

### Optional (defaults shown)
```
# Trigger detector
VOLUME_COVER_TRIGGER_DETECTOR_ENABLED=true

# Mock mode (DO NOT USE IN PRODUCTION)
VOLUME_COVER_HEDGE_MOCK=false
VOLUME_COVER_AUTH_DISABLED=false

# Multi-venue routing override (optional JSON)
VOLUME_COVER_VENUE_ROUTING_JSON=

# Volume Cover-specific guards
VOLUME_COVER_GUARD_LOSS_KILL_USDC=5000
VOLUME_COVER_GUARD_LOSS_KILL_ENABLED=true

VOLUME_COVER_GUARD_SALVAGE_THROTTLE_PCT=0.85
VOLUME_COVER_GUARD_SALVAGE_HALT_PCT=0.70
VOLUME_COVER_GUARD_SALVAGE_MIN_SAMPLES=3
VOLUME_COVER_GUARD_SALVAGE_THROTTLE_ENABLED=true

VOLUME_COVER_GUARD_TRIGGER_COUNT_24H_MAX=5
VOLUME_COVER_GUARD_TRIGGER_PAUSE_MINUTES=30
VOLUME_COVER_GUARD_TRIGGER_SURGE_ENABLED=true

VOLUME_COVER_THROTTLE_LOW_PER_DAY=3

# Master kill (DO NOT use in production)
VOLUME_COVER_GUARDS_ALL_DISABLED=false
```

---

## Pre-launch checklist

Run through this before flipping `VOLUME_COVER_ENABLED=true` in Render:

- [ ] `PILOT_ADMIN_TOKEN` set in Render env, value matches your local copy
- [ ] `FOXIFY_API_KEY_HMAC_SECRET` set in Render env, secret printed and physically delivered to Foxify CEO
- [ ] DB migration completed: `npm run migrate:pilot` (creates `volume_cover_*` tables, seeds 6 cells with `enabled=true, throttleMaxPerDay=5`)
- [ ] `GET /volume-cover/health` returns 200 with `cellsConfigured: 6, cellsEnabled: 6`
- [ ] `GET /volume-cover/admin/cells` returns all 6 cells with admin token
- [ ] Quote test from Foxify-side: HMAC-signed `POST /volume-cover/quote` returns a valid price
- [ ] Trigger detector logs visible in Render logs: `[VolumeCover] Trigger detector started`

## Day 1 launch sequence

1. Deploy code via merge to production branch (Render auto-deploys).
2. Confirm health endpoint green.
3. Set `VOLUME_COVER_ENABLED=true` in Render env, redeploy.
4. Run smoke quote + activate from your laptop (use the smoke script as template).
5. Verify position appears in admin dashboard.
6. Hand HMAC secret to Foxify CEO in person at signing.
7. Signal go-live to Foxify ops.

## Daily operations (during pilot)

### Morning (00:30-09:00 UTC)
- Pull yesterday's report: `GET /volume-cover/admin/foxify-report?date=<yesterday>`
- Save report to a private file/share for Foxify on request.
- Review salvage stats: any triggers? salvage rate within band?
- Check active guardrails section of dashboard.

### Evening (20:00-23:59 UTC)
- Quick health check.
- Review today's trigger events (if any).
- Confirm cumulative loss < $3k (well below $5k auto-halt).

### Weekly (Monday 00:00 UTC, after settlement)
- Pull report range for prior 7 days.
- Reconcile against Bullish/Deribit account statements.
- Run weekly settlement via existing pilot endpoint (if Foxify pre-funded).

## Common scenarios

### Scenario: salvage rate dropped to 80%
- Auto-throttle kicks in: per-cell cap drops to 3/day.
- Foxify will see `salvageState: "throttle"` in activate responses.
- Continue monitoring. If salvage stays in 70-85% band for 24h, consider price uplift via cell toggle.
- If salvage recovers ≥85%, throttle auto-disengages on next activation cycle.

### Scenario: salvage rate dropped to 65%
- Auto-halt: all activations blocked.
- Foxify will get 403 with `reason: "salvage_rate_below_halt"`.
- Investigate: which positions triggered, what was the BTC move, what did the hedge sell at?
- If venue issue: switch routing via `VOLUME_COVER_VENUE_ROUTING_JSON`.
- If model issue: pause pilot, re-quote with adjusted matrix.
- Manual reset is NOT exposed via API for this guard — restart the service to clear (rolling 5 triggers will refill from new data).

### Scenario: cumulative 7-day loss reached $5k
- Auto-halt: cumulative loss kill-switch fires.
- Manual reset required: there's no API endpoint for this; restart the service after fixing root cause.
- This is a hard guard — do NOT disable via env in production unless you've decided to absorb further losses.

### Scenario: 6+ triggers in 24h
- 30-min pause auto-applied.
- Foxify gets 403 with `reason: "trigger_surge_pause"` or `trigger_surge_cooldown`.
- Investigate: market regime shift? Genuine high-vol period?
- After pause expires, activations resume automatically.
- If condition persists, consider raising trigger count threshold via env.

### Scenario: Foxify says they got an error
1. Ask for the error code (`error` field in response body).
2. If `unauthorized` / `signature_mismatch`: check their HMAC implementation. Re-share secret if needed.
3. If `cell_disabled`: check `/admin/cells` for which cells are disabled.
4. If `daily_throttle_exceeded`: confirm with Foxify what cell + count; expected behavior.
5. If `entry_price_drift_too_high`: their entry price is more than 1% off our spot at request time. Foxify should re-quote.
6. If `guardrail_blocked`: check the `reason` field; matches one of §5 conditions.

### Scenario: Bullish API is down
- Wave 2 Bullish health guard auto-pauses (>10% 5xx or >5s p95).
- Multi-venue router falls back to Deribit on individual orders.
- If Deribit also down: activation fails entirely; client gets 500 with `activate_failed`.
- Monitor venue status pages; once one recovers, the guard auto-clears.

## Rollback

If anything is wrong post-deploy:
1. Set `VOLUME_COVER_ENABLED=false` in Render env, redeploy. New activations rejected; existing positions continue to be monitored.
2. If positions need urgent close: `POST /volume-cover/admin/positions/:id/close` for each.
3. If DB schema issue: tables are additive, no destructive migration ran. Drop tables manually only if confident.

## Escalation

Until cutover is operationally proven (Day 5 EOD):
- Any auto-halt → operator pages CEO within 30 minutes
- Any unexpected error in admin endpoints → operator pulls logs, files incident note
- Any reconciliation drift → halt + investigate before next activation

After Day 5:
- Auto-halts → operator only (CEO summary in weekly report)
- Errors → standard incident workflow
