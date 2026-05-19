# Volume Cover Production Cutover — Render Env Script

**Date of cutover:** Day 11 (or signing day +1)
**Target service:** Atticus production API (Render)

---

## Pre-cutover (do this BEFORE flipping the master switch)

### 1. Generate secrets locally

```bash
# Foxify HMAC secret (64 chars random)
openssl rand -base64 48
# → save as FOXIFY_HMAC_SECRET (write to envelope, hand to Foxify CEO at signing)

# Admin token (already exists from pilot — reuse)
# If not set, generate similarly.
```

### 2. Set Render env (paste into the Render dashboard env editor)

```
# Master switch (KEEP FALSE during initial deploy + DB migrate)
VOLUME_COVER_ENABLED=false

# Auth
PILOT_ADMIN_TOKEN=<existing pilot token, do not change>
FOXIFY_API_KEY_HMAC_SECRET=<new secret from step 1>

# Trigger detector
VOLUME_COVER_TRIGGER_DETECTOR_ENABLED=true

# Production safety: NO mock fills, NO disabled auth
VOLUME_COVER_HEDGE_MOCK=false
VOLUME_COVER_AUTH_DISABLED=false

# Guards (defaults shown; only override if needed)
# VOLUME_COVER_GUARD_LOSS_KILL_USDC=5000
# VOLUME_COVER_GUARD_SALVAGE_THROTTLE_PCT=0.85
# VOLUME_COVER_GUARD_SALVAGE_HALT_PCT=0.70
# VOLUME_COVER_GUARD_TRIGGER_COUNT_24H_MAX=5
# VOLUME_COVER_THROTTLE_LOW_PER_DAY=3
```

### 3. Merge work branch → production branch

```bash
# From your local checkout:
git checkout cursor/-bc-c2468b87-...-6ba4    # production branch
git fetch origin
git merge --no-ff origin/cursor/-bc-3aa2d238-ebb4-479a-98c7-2ade2838103f-6425
git push origin cursor/-bc-c2468b87-...-6ba4
# → Render auto-deploys
```

### 4. Wait for Render deploy to complete

Watch logs for:
```
[VolumeCover] Disabled (VOLUME_COVER_ENABLED=false)
```

This means deploy succeeded but Volume Cover routes are not registered yet.

### 5. Run DB migration

In Render Shell or a manual `migrate:pilot` job:
```bash
npm run migrate:pilot
```

Expected output:
```
Pilot + Volume Cover schema migration complete.
```

Verify schema:
```sql
SELECT table_name FROM information_schema.tables
WHERE table_name LIKE 'volume_cover_%' ORDER BY table_name;
```
Should return 4 rows: cell, position, hedge_leg, salvage_event.

```sql
SELECT cell_id, enabled, throttle_max_per_day, daily_premium_usdc
FROM volume_cover_cell ORDER BY notional_usdc, trigger_pct;
```
Should return 6 cells, all `enabled=true, throttle_max_per_day=5`.

---

## Cutover (flip the master switch)

### 6. Flip VOLUME_COVER_ENABLED=true in Render env

Save → Render auto-restarts.

### 7. Verify boot logs

```
[VolumeCover] Registered routes (mockFills=false, auth_disabled=false)
[VolumeCover] Trigger detector started
```

### 8. Health probe

```bash
curl https://<atticus-api>/volume-cover/health
```
Expected:
```json
{"status":"ok","cellsConfigured":6,"cellsEnabled":6,"activePositions":0,"totalActivePayoutLiabilityUsdc":0,"manualHalt":{"halted":false,"reason":null}}
```

### 9. Admin token probe

```bash
curl -H "X-Admin-Token: $PILOT_ADMIN_TOKEN" \
     https://<atticus-api>/volume-cover/admin/cells
```
Should return all 6 cells.

### 10. HMAC sign + quote test

Use this snippet to sign a quote request:

```bash
SECRET="<FOXIFY_API_KEY_HMAC_SECRET>"
TS=$(date +%s)000
BODY='{"foxifyPairId":"SMOKE-PAIR-001","pairNotionalUsdc":50000,"triggerPct":0.02}'
SIG=$(printf "%s\nPOST\n/volume-cover/quote\n%s" "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/.*= //')
curl -X POST https://<atticus-api>/volume-cover/quote \
     -H "Content-Type: application/json" \
     -H "X-Foxify-Signature: $SIG" \
     -H "X-Foxify-Timestamp: $TS" \
     -d "$BODY"
```

Expected:
```json
{"cellId":"50k_2pct_1k","dailyPremiumUsdc":350,"payoutUsdc":1000,...}
```

### 11. Hand the secret envelope to Foxify CEO

In person at signing. Confirm receipt. They use it to sign their first activate request.

### 12. Watch first live activation in logs

Foxify makes their first `POST /volume-cover/activate`. You should see:
```
[VolumeCover] activated position=vc-pos-... cell=50k_2pct_1k venue=bullish hedgeCost=$...
```

If anything looks off, immediately:
```bash
curl -X POST https://<atticus-api>/volume-cover/admin/halt \
     -H "X-Admin-Token: $PILOT_ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"reason":"investigation"}'
```

---

## Rollback (if needed)

### Soft rollback: disable new activations
```
VOLUME_COVER_ENABLED=false
```
Save → Render restarts. Existing positions remain monitored; trigger detector continues to fire on real touches.

### Hard rollback: revert merge
```bash
git checkout cursor/-bc-c2468b87-...-6ba4
git revert --no-commit <merge-commit-hash>
git commit -m "rollback: revert Volume Cover merge"
git push
# → Render auto-deploys prior version
```

DB tables remain (additive); harmless to existing pilot.

---

## Post-cutover monitoring (first 72h)

- Watch Render logs continuously for first 4 hours.
- Pull dashboard hourly for first 24h.
- Pull dashboard 3x/day for hours 24-72.
- Settle any payouts via existing weekly settlement process.

After 72h: standard daily ops cadence (per runbook §"Daily operations").
