# Two-Sided Cooperative Volume Facility — Operational Runbook

**Audience:** On-call operator + ops engineering
**Cadence:** Daily checklist + weekly review + ad-hoc incident response
**Service:** `foxify-pilot-new` on Render

---

## 1. Daily checklist

Run within 30 minutes of UTC 00:30 (daily cron tick).

### 1.1 Health check

```
curl -sf -H "X-Admin-Token: $TOKEN" "$API/admin/foxify/v2/diagnostics" | jq '{
  feed_health: .feed.health,
  dvol: .dvol.dvol,
  regime: .dvol.regime,
  halt_atticus: .halt.atticusHalt,
  halt_foxify: .halt.foxifyHalt,
  active_pairs: .status.todayPairsActivated,
  today_pnl: .status.todayFoxifyPnlUsdc,
  unwind_queue_depth: .unwindQueue.queueDepth
}'
```

**Expected:** `feed_health=healthy`, `dvol < 60`, both halts false, queue_depth 0.

**Action if anomalous:**
- `feed_health=degraded` → check `/foxify/v2/feed/health` per-source counts. If one source persistently failing, investigate (geo block, API change, network).
- `dvol > 60` → expected halt fires automatically. Verify halt active in diagnostics.
- `halt_atticus=true` with no operator action → check halt_event log: `SELECT * FROM two_sided_halt_event ORDER BY occurred_at DESC LIMIT 10`.
- `unwind_queue_depth > 3` for >5min → check for execution_stuck on individual pairs.

### 1.2 Drift check (shadow vs MC)

```
psql "$DATABASE_URL" <<SQL
SELECT
  COUNT(*) AS shadow_pairs_settled_7d,
  ROUND(AVG(foxify_share_usdc - hedge_cost_total_usdc), 2) AS mean_foxify_ev,
  543 AS mc_predicted_ev,
  ROUND((AVG(foxify_share_usdc - hedge_cost_total_usdc) - 543) / 543.0 * 100, 1) AS drift_pct
FROM two_sided_pair
WHERE is_shadow = TRUE AND status = 'settled' AND closed_at > NOW() - INTERVAL '7 days';
SQL
```

**Expected:** `|drift_pct| < 15`.

**Action if drift > 15%:**
- Identify cause: regime shift, anchor staleness, executor behavior change
- Run `scripts/backtest/singleSide/runTwoSidedStrangleProof.ts` against fresh anchors
- If MC predictions confirmed → operator decision: adjust threshold or pause cell

### 1.3 Active pair review

```
psql "$DATABASE_URL" <<SQL
SELECT pair_id, status, created_at, expires_at, hedge_cost_total_usdc, tier_at_activation
FROM two_sided_pair
WHERE status IN ('active', 'triggered', 'unwinding')
ORDER BY created_at;
SQL
```

**Action:**
- Any pair in `unwinding` > 5min → investigate (likely execution_stuck event)
- Any pair past `expires_at` still active → manual intervention needed (force expiry close)

---

## 2. Halt-and-resume procedures

### 2.1 Foxify-initiated halt (Foxify operations team)

```
curl -X POST -H "X-Foxify-Token: $FOXIFY_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason": "ops_maintenance", "durationMin": 30}' \
  "$API/admin/foxify/v2/halt"
# Body: { kind: "foxify", reason: "manual_foxify", notes: "..." }
```

Effect: all new activations return 503 `manual_foxify`. Existing pairs continue.

**Resume:**
```
curl -X POST -H "X-Admin-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"kind": "foxify"}' \
  "$API/admin/foxify/v2/resume"
```

### 2.2 Atticus-initiated halt (operator)

Same endpoint with `kind=atticus`. Reasons:
- `manual_operator` — operator judgment
- `dvol_high` — auto (when DVOL > 60); auto-resumes when DVOL < 55 (PR 9)
- `feed_stale` — auto (when canonical feed > 5s old); auto-resumes when fresh
- `rolling_salvage_low` — auto (when rolling 7d salvage/hedge < 1.20×)
- `capital_pool_low` — auto (when pool < 1.5× single-pair cost)
- `per_pair_loss` — auto (any pair closed worse than -$2000)
- `daily_loss` / `weekly_drawdown` — auto (dollar-threshold breaches per PR 9)
- `newborn_review` — auto (first 3 triggers per regime per PR A8)

**Operator clear after auto-halt:**
1. Check halt reason via `/admin/foxify/v2/diagnostics`
2. Investigate root cause (logs, events, manual eval)
3. Document in halt_event notes
4. Clear via `/admin/foxify/v2/resume`

### 2.3 Newborn-review clear (per regime, after first 3 triggers)

After observing the first 3 triggers in a given regime, review each:
```
curl -sf -H "X-Foxify-Token: $TOKEN" "$API/foxify/v2/pairs/$PAIR_ID/explain"
```

If satisfied, clear:
```
curl -X POST -H "X-Admin-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"regime": "calm"}' \
  "$API/admin/foxify/v2/newborn-review/clear"
```

Three clears per regime to fully unlock subsequent activations in that regime.

---

## 3. Token + webhook rotation

### 3.1 Foxify API key (X-Foxify-Token)

Rotation cadence: every 90 days, or immediately after suspected compromise.

1. Generate new token (32+ char random): `openssl rand -hex 32`
2. Update on Render: set `FOXIFY_API_KEY=<new>` env var
3. Trigger Render redeploy (env change auto-redeploys on Render)
4. Share new token with Foxify ops via secure channel (NEVER chat/email/git)
5. Confirm Foxify bot uses new token (first activation 401 = old token in use)

### 3.2 PILOT_ADMIN_TOKEN

Rotation cadence: every 90 days, or after exposure.

1. Generate new token: `openssl rand -hex 32`
2. Update on Render
3. Redeploy
4. Update all operator scripts/curl helpers (per-operator env files)

### 3.3 Foxify webhook HMAC secret

Rotation cadence: every 180 days.

1. Generate new secret: `openssl rand -hex 32`
2. Share with Foxify (out of band, before rotation)
3. Set new config:
```
curl -X POST -H "X-Admin-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"webhook_url": "<unchanged>", "hmac_secret": "<new-secret>"}' \
  "$API/admin/foxify/v2/webhook-config"
```
4. Confirm Foxify can verify the new signature (test webhook → 2xx ack)

### 3.4 Bullish + Deribit credentials

Operator decision in concert with venue ops teams. Update env vars on Render then redeploy. Existing in-flight pairs use connection caches that refresh on next request.

---

## 4. Deferred-pool toggle

### 4.1 When to enable (operator decision)

- Ramping volume from <25 to target (e.g., 25 → 100 pairs/day)
- Operator + Foxify agree to recycle salvage instead of immediately splitting
- Atticus earns ledger credits accrued during deferred period

```
curl -X POST -H "X-Admin-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"active": true, "notes": "ramp phase Q4 2026"}' \
  "$API/admin/foxify/v2/deferred-pool"
```

### 4.2 When to disable

- Volume target reached and stable for 7d
- Operator + Foxify agree to switch to per-pair settlement

```
curl -X POST -H "X-Admin-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"active": false, "notes": "stable at 100/day; switching to settlement"}' \
  "$API/admin/foxify/v2/deferred-pool"
```

### 4.3 Settling the accrued balance (PR C6 ledger)

```
SELECT SUM(atticus_share_usdc) FROM two_sided_deferred_pool_ledger WHERE settled_at IS NULL;
```

Operator runs payout (mechanic per OD-5, deferred), then marks settled.

---

## 5. Incident response

### 5.1 Feed unavailable

**Symptom:** `/foxify/v2/feed/health` returns `unavailable`, all activations return 503 `feed_unavailable`.

**Triage:**
1. Check per-source counts: `/foxify/v2/feed/health` → `perSourceLast60sSuccess`
2. If 0/5 sources healthy → network outage or all-source rate-limit
3. If 1-2 sources healthy → degraded mode; aggregator returns null when <2 sources survive
4. Test individual sources from a Render shell:
   ```
   curl -sf "https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd"
   curl -sf "https://api.coinbase.com/v2/prices/BTC-USD/spot"
   ```
5. Check process: `ps -ef | grep node` — service alive?

**Resolution:**
- Transient network: wait for source recovery (auto-resume)
- Source API change: update fetcher in `feedSources.ts` + emergency deploy
- All sources down: investigate Render-side network/DNS, escalate

### 5.2 Execution stuck

**Symptom:** `two_sided_pair_event.kind = 'execution_stuck'` for a pair_id.

**Triage:**
1. Check details: `SELECT details FROM two_sided_pair_event WHERE pair_id = '$PAIR' AND kind = 'execution_stuck'`
2. Note the failure reason: `venue_error`, `min_px_violated`, `timeout`, `halted`
3. Check current venue state: `/foxify/v2/feed/current` + Bullish/Deribit dashboards

**Resolution:**
- Venue-side issue (Bullish/Deribit down): wait + manual close after recovery
- Slippage floor violation: manual cancel + close at market (operator decision)
- Persistent across pairs: halt facility, root cause before resume

### 5.3 Regime spike (DVOL > 60)

**Symptom:** Auto-halt fires `dvol_high`. New activations 503.

**Expected behavior:** Existing pairs continue lifecycle. Auto-resume when DVOL < 55.

**Operator action:**
- Confirm DVOL via Deribit directly (sanity check our feed)
- If real spike → wait it out
- If feed glitch (false DVOL spike) → manual halt clear + investigate dvolService

### 5.4 Webhook delivery persistent failure

**Symptom:** `two_sided_webhook_attempt.success = FALSE` for >50% of recent attempts.

**Triage:**
1. Verify Foxify receiver alive: `curl -sf "$WEBHOOK_URL"`
2. Check signature header: `SELECT response_body_preview, error_message FROM two_sided_webhook_attempt WHERE pair_id = '$PAIR' ORDER BY attempt_seq`
3. Confirm HMAC secret matches Foxify's

**Resolution:**
- Receiver down: nothing we can do; retries continue per backoff
- Signature mismatch: rotate secret via `/admin/foxify/v2/webhook-config`
- URL change: update config

### 5.5 Process restart loop

**Symptom:** Render shows repeated restarts.

**Triage:**
1. Check Render logs for crash trace
2. Check Postgres connectivity
3. Disable `SS_TWO_SIDED_LIVE_ENABLED=false` to prevent further damage
4. Investigate

**Emergency rollback:** revert to previous tag, redeploy.

---

## 6. Weekly review (operator + on-call lead)

Run every Monday morning UTC.

### 6.1 Week summary

```
psql "$DATABASE_URL" <<SQL
SELECT
  COUNT(*) AS pairs_activated,
  COUNT(*) FILTER (WHERE status = 'settled') AS pairs_settled,
  COUNT(*) FILTER (WHERE trigger_side IS NOT NULL) AS pairs_triggered,
  ROUND(AVG(hedge_cost_total_usdc), 0) AS avg_hedge_cost,
  ROUND(AVG(salvage_proceeds_usdc) FILTER (WHERE status = 'settled'), 0) AS avg_salvage,
  ROUND(SUM(foxify_share_usdc - hedge_cost_total_usdc) FILTER (WHERE status = 'settled'), 0) AS total_foxify_net,
  ROUND(SUM(atticus_share_usdc) FILTER (WHERE status = 'settled'), 0) AS total_atticus_share
FROM two_sided_pair
WHERE is_shadow = FALSE AND created_at > NOW() - INTERVAL '7 days';
SQL
```

### 6.2 Halt summary

```
SELECT kind, reason, COUNT(*), MIN(occurred_at), MAX(occurred_at)
FROM two_sided_halt_event
WHERE occurred_at > NOW() - INTERVAL '7 days'
GROUP BY kind, reason
ORDER BY COUNT(*) DESC;
```

### 6.3 Execution issues

```
SELECT
  details->>'reason' AS reason,
  COUNT(*) AS count
FROM two_sided_pair_event
WHERE kind = 'execution_stuck' AND occurred_at > NOW() - INTERVAL '7 days'
GROUP BY 1;
```

### 6.4 Webhook reliability

```
SELECT
  success,
  COUNT(*) AS count,
  ROUND(AVG(attempt_seq), 1) AS avg_attempts
FROM two_sided_webhook_attempt
WHERE attempted_at > NOW() - INTERVAL '7 days'
GROUP BY success;
```

### 6.5 Action items

Based on the above, create weekly action items:
- Tune dollar kill thresholds if too many false-positive halts
- Adjust DVOL threshold if regime classifier needs calibration
- Update feed source list if persistent failures from one venue
- Escalate cell economics if salvage/hedge ratio < 1.20× rolling 7d

---

## 7. Operator quick reference

| Command | Purpose |
|---|---|
| `GET /foxify/v2/status` | Foxify-facing summary |
| `GET /foxify/v2/regime` | Current DVOL + classification |
| `GET /foxify/v2/feed/health` | Per-source feed status |
| `GET /admin/foxify/v2/diagnostics` | Full system snapshot |
| `GET /metrics` | Prometheus scrape |
| `POST /admin/foxify/v2/halt {kind, reason}` | Halt |
| `POST /admin/foxify/v2/resume {kind}` | Clear halt |
| `POST /admin/foxify/v2/deferred-pool {active}` | Pool toggle |
| `POST /admin/foxify/v2/webhook-config {url, secret}` | Webhook config |
| `POST /admin/foxify/v2/newborn-review/clear {regime}` | Newborn approval |

### Key env vars (Render dashboard)

| Env var | Default | Production |
|---|---|---|
| `SS_TWO_SIDED_LIVE_ENABLED` | false | true after operator approval |
| `SS_TWO_SIDED_MAX_PAIRS_PER_DAY` | 2 | scale via operator approval |
| `SS_TWO_SIDED_BOOT_HALT` | true | true (operator clears boot halt) |
| `SS_TWO_SIDED_NEWBORN_REVIEW_PER_REGIME` | 3 | 3 |
| `SS_TWO_SIDED_CELL_ALLOWLIST` | pair_50k_2pct | per Wave C cell sweep result |
| `TWO_SIDED_LOG_LEVEL` | info | info or warn for high-volume |

---

## 8. Escalation tree

| Severity | Symptoms | First responder | Escalation in |
|---|---|---|---|
| P1 Critical | All activations failing, capital at risk, suspected security incident | On-call ops | Immediate (5 min) |
| P2 High | Auto-halt active >10min, persistent webhook failure, drift >15% | On-call ops | 30 min |
| P3 Medium | Single-pair execution_stuck, transient feed degradation | Operator | 4h |
| P4 Low | Daily report anomaly, single missed trigger | Operator | Weekly review |

Escalation order:
1. On-call ops (Atticus engineering)
2. Engineering lead
3. Operator (Foxify counterparty contact if Foxify-impact)
4. Legal/compliance (if capital movement involved)

---

## 9. Reference data

- DVOL bands: calm <40, moderate 40-60, elevated 60-85, stress 85+
- Phase 0 cell: `pair_50k_2pct` (\$50k notional/leg, ±2% trigger, 1.4 BTC contracts, 3d tenor, 1.3% ITM guts strikes)
- Tier shape: tier_1 (15%/$25), tier_2 (13%/$30), tier_3 (11%/$35), tier_4 (9%/$40), tier_5 (8%/$45)
- Calm-regime MC predicted Foxify EV: +\$543/pair (drift alert at ±15%)
- Slippage haircut bands: 0.92 / 0.85 / 0.75 / 0.65 (depth-aware)
- Concurrent unwind policy (regime-conditional): calm 2/60s, elevated 3/30s
- Force-grant deadline: 20 min (protects capture-window-peak)

---

**End of runbook.** Update as procedures evolve. Tag: `OPS_RUNBOOK_v1.0` (2026-05-27).
