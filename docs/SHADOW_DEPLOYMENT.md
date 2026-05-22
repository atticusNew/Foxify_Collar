# Shadow Service — Deployment Guide

The shadow service (`foxify-pilot-shadow`) is a **mirror of the live `foxify-pilot-new`** that runs the same code path with strict isolation — admin-only access, mock-mode hedge fills, distinct secrets, separate DB. It exists so we can test new code paths (Bullish, premium regime overlay, TP slippage floor, spreads, pooled book) **without ever risking the live pilot**.

This guide covers (1) how to bring it up, (2) what's safe to do on it, and (3) how to opt into real venue fills for a specific test.

---

## 1. What's deployed

The blueprint at `render-shadow.yaml` provisions:

| Resource | Type | Plan | Cost |
|---|---|---|---|
| `foxify-pilot-shadow` | Web service | starter | ~$7/mo |
| `foxify-pilot-shadow-db` | Postgres | basic-256mb | ~$7/mo |

Both run on the `vc-sandbox` branch. Auto-deploy is on, so any push to `vc-sandbox` redeploys the shadow service automatically. The committed `render.yaml` (live blueprint for `atticus-pilot-api`) is unrelated and unaffected.

---

## 2. Bring-up steps

### 2.1 Apply the blueprint

1. Render dashboard → **Blueprints** → **New Blueprint Instance**
2. Repository: `atticusNew/Foxify_Collar`
3. Branch: `vc-sandbox`
4. Blueprint file path: `render-shadow.yaml`
5. Confirm. Render creates the web service + DB and starts the first deploy.

### 2.2 Confirm isolation guards

After the first deploy completes (~2-3 min), check the **Logs** tab for:

```
{"level":"info","msg":"deployment_tier_resolved","tier":"shadow",...}
```

If you see this line, isolation is in effect:
- Foxify HMAC routes (`/quote`, `/activate`, `/positions/:id`, `/positions/:id/close`) return 403 with `reason: "shadow_tier_blocks_foxify_traffic"` regardless of any signature.
- Hedge execution is mocked (`VOLUME_COVER_HEDGE_MOCK=true`); no real venue orders are placed.

If the boot fails with `deployment_invariants_violated`, the env is misconfigured. Read the error message — it tells you exactly which invariant failed.

### 2.3 Health check

```bash
SHADOW_API="https://foxify-pilot-shadow.onrender.com"
curl -sS "$SHADOW_API/volume-cover/health" | jq .
```

Expected: 200 with the same shape as live's health response.

### 2.4 Distinct secrets

The blueprint generated fresh values for these (Render dashboard → Environment):

- `PILOT_ADMIN_TOKEN` — shadow admin token, **not** the live one
- `FOXIFY_API_KEY_HMAC_SECRET` — random; never share with Foxify
- `PILOT_PROOF_TOKEN`, `PILOT_INTERNAL_TOKEN`, `USER_HASH_SECRET` — random

Save the shadow `PILOT_ADMIN_TOKEN` somewhere accessible to you — it's how you'll exercise the admin endpoints below.

---

## 3. What's safe to do on shadow

### 3.1 Synthetic activations (always safe in mock mode)

The shadow refuses real Foxify HMAC traffic, so to exercise the activate path you call admin-token-gated endpoints. There's already an `/admin/test-activate` endpoint on live — same shape works on shadow. With mock mode, it runs the full code path (auth, drift, sizing, strike grid, atomicity, DB writes, ledger) but the venue-execute step returns synthetic fills.

```bash
SHADOW_API="https://foxify-pilot-shadow.onrender.com"
SHADOW_ADMIN_TOKEN="<shadow PILOT_ADMIN_TOKEN>"

# Get current spot
SPOT=$(curl -sS "$SHADOW_API/volume-cover/health" | jq -r .spotBtcUsdc)

# Synthetic activate on the smallest cell
curl -sS -X POST "$SHADOW_API/volume-cover/admin/test-activate" \
  -H "X-Admin-Token: $SHADOW_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"foxifyPairId\": \"shadow-smoke-$(date +%s)\",
    \"cellId\": \"1k_2pct_20\",
    \"pairLongNotionalUsdc\": 1000,
    \"pairShortNotionalUsdc\": 1000,
    \"pairEntryBtcPrice\": $SPOT
  }" | jq .
```

Expected: 201 with `positionId`, `hedgeLegs[]` populated with synthetic fill prices, `salvageState: "healthy"`.

### 3.2 Drive a full lifecycle in mock mode

Once you have a synthetic position open:

```bash
POS_ID="<from previous response>"

# Confirm DB state matches what the activate returned
curl -sS "$SHADOW_API/volume-cover/admin/active-positions-detail?limit=20" \
  -H "X-Admin-Token: $SHADOW_ADMIN_TOKEN" | jq ".positions[] | select(.id==\"$POS_ID\")"

# Trigger the hedge manager (dry-run first, then real)
curl -sS -X POST "$SHADOW_API/volume-cover/admin/hedge-manager/run?dryRun=true&iv=0.45" \
  -H "X-Admin-Token: $SHADOW_ADMIN_TOKEN" | jq .

# Close the position
curl -sS -X POST "$SHADOW_API/volume-cover/admin/positions/$POS_ID/close" \
  -H "X-Admin-Token: $SHADOW_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason": "shadow smoke test"}' | jq .
```

This validates the full open → TP → close flow with zero capital at risk.

### 3.3 Confirming Foxify traffic is blocked

Sanity check that shadow refuses Foxify HMAC requests even with a valid signature:

```bash
SHADOW_API="https://foxify-pilot-shadow.onrender.com"
SHADOW_HMAC_SECRET="<shadow FOXIFY_API_KEY_HMAC_SECRET>"
TS=$(($(date +%s%N) / 1000000))
BODY='{"foxifyPairId":"test","pairNotionalUsdc":1000,"triggerPct":0.02}'
MSG=$(printf "%s\n%s\n%s\n%s" "$TS" "POST" "/volume-cover/quote" "$BODY")
SIG=$(printf "%s" "$MSG" | openssl dgst -sha256 -hmac "$SHADOW_HMAC_SECRET" -hex | awk '{print $2}')

curl -sS -i -X POST "$SHADOW_API/volume-cover/quote" \
  -H "X-Foxify-Timestamp: $TS" \
  -H "X-Foxify-Signature: $SIG" \
  -H "Content-Type: application/json" \
  -d "$BODY"
```

Expected: HTTP 401 with body `{"error": "unauthorized", "reason": "shadow_tier_blocks_foxify_traffic"}` (or similar). The shadow blocks even when the signature is mathematically valid.

---

## 4. Opting into real venue fills (per-test, never default)

Default mock mode covers ~95% of what shadow is for. The other 5% is when you specifically need to test real venue connectivity (Bullish round-trips, TP slippage floor against real Deribit fills, etc.). To opt in:

### 4.1 Real Deribit fills on shadow

1. Render dashboard → `foxify-pilot-shadow` → Environment, set:
   - `VOLUME_COVER_HEDGE_MOCK=false`
   - `PILOT_SHADOW_ALLOW_REAL_FILLS=true`
   - `DERIBIT_PAPER=false`
   - `DERIBIT_CLIENT_ID=<small sub-account creds>`
   - `DERIBIT_CLIENT_SECRET=<small sub-account creds>`
2. Save → service redeploys
3. Boot logs should show `tier: "shadow"` plus a real Deribit auth-test
4. Run a single `1k_2pct_20` activate as in §3.1 — it will now fill real
5. After the test, **revert** `VOLUME_COVER_HEDGE_MOCK=true` and remove `PILOT_SHADOW_ALLOW_REAL_FILLS` to return to mock mode

If you forget to revert, the boot invariant in `deploymentTier.ts` does NOT block this combination (that's the explicit-override-allowed case), but every activate will burn real fees.

### 4.2 Bullish mainnet round-trip

When Bullish has provisioned the sub-account + enabled margin/options:

1. Render dashboard env on `foxify-pilot-shadow`:
   - `PILOT_BULLISH_ENABLED=true`
   - `PILOT_BULLISH_ALLOW_MARGIN=true`
   - `PILOT_BULLISH_REST_BASE_URL=https://api.exchange.bullish.com`
   - `PILOT_BULLISH_PUBLIC_WS_URL=wss://api.exchange.bullish.com/trading-api/v1/market-data/orderbook`
   - `PILOT_BULLISH_PRIVATE_WS_URL=wss://api.exchange.bullish.com/trading-api/v1/private-data`
   - `PILOT_BULLISH_TRADING_ACCOUNT_ID=<from Bullish provisioning>`
   - `PILOT_BULLISH_ECDSA_PRIVATE_KEY=<paste PEM>`
   - `PILOT_BULLISH_ECDSA_PUBLIC_KEY=<paste PEM>`
   - `PILOT_BULLISH_ECDSA_METADATA=<base64 JSON>`
   - `VOLUME_COVER_HEDGE_MOCK=false`
   - `PILOT_SHADOW_ALLOW_REAL_FILLS=true`
2. Update `VOLUME_COVER_VENUE_ROUTING_JSON` to route the 2% cohort to Bullish:
   ```json
   {"0.02":{"primary":"bullish","fallback":"deribit"}}
   ```
3. Run the smallest activate. Watch logs for `bullish_order_failed:...3003` (margin not enabled → tell Bullish), `ioc_cancelled` (book too thin → switch TIF or widen limit), or success.

---

## 5. Promotion: shadow → live

A change graduates from shadow to live only when:

1. ≥10 successful activations on shadow with the change (mock or real, depending on what's being tested)
2. No `[VC ALERT]` in 7 days
3. If the change touches venue execute paths, a confirmed real round-trip on shadow
4. Operator manual review of shadow logs + DB
5. Explicit operator sign-off — no auto-promotion

To promote:

1. PR from `vc-sandbox` to the live branch (whatever branch `foxify-pilot-new` is configured to deploy from on Render)
2. Coordinate the live deploy window — auto-deploy is enabled on the live service, so the merge triggers it
3. Watch `foxify-pilot-new` logs for the same `deployment_tier_resolved` line — it should say `tier: "live"` (the default when env unset)

---

## 6. Pausing or tearing down shadow

**To pause** (preserve data, stop polling):
- Render dashboard → `foxify-pilot-shadow` → Settings → **Suspend Service**

**To delete** (irreversible):
- Suspend, then Delete on the service
- Decide whether to keep the DB (snapshot data may still be useful)

---

## 7. What's NOT on shadow yet (intentional)

- Snapshot collector: stays pointing at **live** (`foxify-pilot-new`), not shadow. Shadow's data is for ad-hoc testing, not historical analysis.
- Foxify-side traffic: shadow refuses it by design.
- Live ledger: shadow has its own `pilot_pool_ledger` rows that don't affect Atticus capital accounting on the live side.
- Cron schedulers: same as live by default. Disable selectively if a scheduler change is what's being tested.

---

## 8. Quick reference

| Resource | URL |
|---|---|
| Shadow API | `https://foxify-pilot-shadow.onrender.com` |
| Shadow health | `GET /volume-cover/health` |
| Shadow admin endpoints | Same shape as live, gated by `PILOT_ADMIN_TOKEN` (shadow's, not live's) |
| Live API | `https://foxify-pilot-new.onrender.com` (untouched) |
| Snapshot collector | `foxify-snapshot-collector` worker service (polls live, not shadow) |
| Branch | `vc-sandbox` (everything experimental) |
| Live branch | (ops-managed, separate) |
