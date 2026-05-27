# Two-Sided Cooperative Volume Facility — Deploy Guide

**Audience:** Operator + on-call engineering
**Service:** `foxify-pilot-new` on Render (mainnet — see operator for current URL)
**Strategy:** Same-service additive deploy (OD-11)

---

## 1. Deploy strategy

Two-sided code is **additive** to the existing Volume Cover (VC) service. We deploy to the **same Render service** (`foxify-pilot-new`) as live VC, sharing the same Postgres database.

**Why same-service:**
- Lower operational cost (one service to monitor, one DB to manage)
- Atomic deploys (no cross-service coordination)
- Schemas are namespaced (`two_sided_*` vs `volume_cover_*`) — zero overlap
- Feature flag (`SS_TWO_SIDED_LIVE_ENABLED`) provides instant rollback without redeploy

**Schema isolation:** every two-sided table starts with `two_sided_`. No CREATE/ALTER/DROP touches any `volume_cover_*` table. Verified by inspecting `services/api/src/singleSide/twoSided/*.ts` and the migrate.ts call sequence.

---

## 2. Deploy sequence

### 2.1 Pre-merge

1. All Wave A + B + C PRs merged to `cursor/two-sided-cooperative-phase0`
2. `tsc --strict` clean on the entire service (existing pre-merge gate)
3. Full test suite green: `TEST_FILTER=twoSided node scripts/run-tests.mjs` shows 200+ passing
4. PR opened against `cursor/-bc-c2468b87-...-6ba4` (live tracking) — operator reviews

### 2.2 Pre-deploy (immediately before merge to live)

Run pre-deploy check locally against pg-mem mirror:

```
cd services/api
npx tsx scripts/preDeployCheck.ts
```

Expected output: `✅ Pre-deploy schema check PASSED`. Exits non-zero if any schema fails.

This catches SQL parse errors / pg-mem incompatibilities before they hit production Postgres. Production Postgres is strictly more permissive than pg-mem, so a green here means production migrations will succeed.

### 2.3 Render deploy

1. Merge feature branch → live tracking branch
2. Render auto-deploys on push to the tracked branch
3. Render's build runs `npm install + node build.mjs` (existing)
4. Render's start runs `node dist/server.js` (existing) — which:
   - Calls `migrate.ts` early (existing pattern, now includes all `ensureXxxSchema` for two-sided)
   - Registers `/foxify/v2/*` routes alongside existing `/volume-cover/*`
   - Starts FeedService + DvolService poll loops
   - Calls `bootResurrect(pool, deps)` to resume any in-flight pairs (PR A6)
5. Deploy completes; Render serves both surfaces

### 2.4 Post-deploy verification

Run these in order — STOP if any fails:

```
# 1. Service is up
curl -sf "$RENDER_API_URL/volume-cover/health" | jq

# 2. Two-sided diagnostics responds with full payload
curl -sf -H "X-Admin-Token: $ADMIN_TOKEN" "$RENDER_API_URL/admin/foxify/v2/diagnostics" | jq

# 3. Feed health: at least 4 of 5 sources healthy
curl -sf -H "X-Foxify-Token: $FOXIFY_TOKEN" "$RENDER_API_URL/foxify/v2/feed/health" | jq

# 4. DVOL service alive
curl -sf -H "X-Foxify-Token: $FOXIFY_TOKEN" "$RENDER_API_URL/foxify/v2/regime" | jq

# 5. Existing VC traffic still works
curl -sf -H "X-Admin-Token: $ADMIN_TOKEN" "$RENDER_API_URL/volume-cover/admin/positions?status=active" | jq '. | length'

# 6. Halt state: atticus_halt should be TRUE on first deploy (SS_TWO_SIDED_BOOT_HALT default)
curl -sf -H "X-Admin-Token: $ADMIN_TOKEN" "$RENDER_API_URL/admin/foxify/v2/diagnostics" | jq '.halt'
```

If any step fails, **do not enable live traffic.** Use the rollback procedure (§4).

---

## 3. Env vars required on Render

Set via Render dashboard. **Never** paste secrets in code, commits, or chat.

### Required for service to function

| Env var | Purpose | Source |
|---|---|---|
| `POSTGRES_URL` or `DATABASE_URL` | Postgres connection | Existing — shared with VC |
| `PILOT_ADMIN_TOKEN` | X-Admin-Token bearer for /admin/foxify/v2/* | Existing — shared with VC admin |
| `FOXIFY_API_KEY` | X-Foxify-Token bearer for /foxify/v2/* | NEW — generate fresh; share with Foxify |

### Required for live execution (PR A4 + A5 wire these)

| Env var | Purpose | Source |
|---|---|---|
| `BULLISH_ECDSA_PRIVATE_KEY` | Bullish auth | Existing on Render |
| `BULLISH_ECDSA_PUBLIC_KEY` | Bullish auth | Existing on Render |
| `DERIBIT_API_KEY` | Deribit auth | Provision — confirm subaccount |
| `DERIBIT_API_SECRET` | Deribit auth | Provision — confirm subaccount |

### Feature flags (control live cutover)

| Env var | Default | Production value |
|---|---|---|
| `SS_TWO_SIDED_LIVE_ENABLED` | `false` | `true` after operator approval |
| `SS_TWO_SIDED_CELL_ALLOWLIST` | `pair_50k_2pct` | Phase 0: same. Phase 1: add cells from Wave C sweep |
| `SS_TWO_SIDED_MAX_PAIRS_PER_DAY` | `2` | `2` initially. Raise after 14d soak |
| `SS_TWO_SIDED_BOOT_HALT` | `true` | `true` — operator clears manually |
| `SS_TWO_SIDED_NEWBORN_REVIEW_PER_REGIME` | `3` | `3` |

### Webhook (set via admin endpoint after deploy, not env)

```
POST /admin/foxify/v2/webhook-config
  Body: { webhook_url: "...", hmac_secret: "..." }
```

---

## 4. Rollback procedure

Two-sided is fully reversible via feature flag — no redeploy needed.

### 4.1 Immediate halt (stop new traffic; in-flight pairs continue)

```
curl -X POST -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"kind":"atticus","reason":"manual_operator","notes":"emergency halt"}' \
  "$RENDER_API_URL/admin/foxify/v2/halt"
```

Effect: all new activations return 503 `atticus_halt`. Existing pairs (active, triggered, unwinding) continue lifecycle to completion. Trigger detection + execution + settlement keep running.

### 4.2 Disable feature flag (next deploy)

If a Wave A-C PR introduces a bug that affects live VC:
1. Set `SS_TWO_SIDED_LIVE_ENABLED=false` in Render dashboard
2. Render auto-redeploys (or trigger manual redeploy)
3. Two-sided routes still register but checkLiveEnabled() rejects every activation
4. Live VC traffic continues unaffected

### 4.3 Schema rollback

Two-sided schemas are **additive only**. No destructive migrations. Rollback = re-deploy older code + leave tables in place. Tables stay safely unused; next forward deploy resumes from them.

If you absolutely must drop schemas (testing only — NEVER in production):
```
DROP TABLE IF EXISTS two_sided_webhook_attempt CASCADE;
DROP TABLE IF EXISTS two_sided_webhook_config CASCADE;
DROP TABLE IF EXISTS two_sided_newborn_review CASCADE;
DROP TABLE IF EXISTS two_sided_deferred_pool_ledger CASCADE;
DROP TABLE IF EXISTS two_sided_deferred_pool_state CASCADE;
DROP TABLE IF EXISTS two_sided_halt_event CASCADE;
DROP TABLE IF EXISTS two_sided_halt_state CASCADE;
DROP TABLE IF EXISTS two_sided_pair_event CASCADE;
DROP TABLE IF EXISTS two_sided_pair_leg CASCADE;
DROP TABLE IF EXISTS two_sided_pair CASCADE;
```

---

## 5. Live cutover checklist (Foxify ship gate)

After Wave A + B + C green:

```
□ Pre-deploy check PASSED on the deploy commit
□ tsc --strict clean
□ All twoSided tests green (target: 250+ tests at full Wave C)
□ Deploy to live Render service successful
□ Post-deploy verification §2.4 all green
□ Microtest tier 1 (0.01 BTC) on shadow API — clean round-trip
□ Microtest tier 2 (0.05 BTC) operator-reviewed — clean
□ Microtest tier 3 (1.4 BTC + each Phase 1 cell at full size) operator-reviewed — clean
□ Webhook config set via /admin/foxify/v2/webhook-config — Foxify receiver acks
□ Operator approves SS_TWO_SIDED_LIVE_ENABLED=true (Render dashboard env update)
□ Operator clears boot atticus halt via POST /admin/foxify/v2/resume
□ Foxify bot performs first end-to-end activate → trigger → settle on tier-1 cell
□ Foxify confirms webhook signature verification round-trips
□ Newborn review approved for first 3 triggers per regime (per regime via /admin/.../newborn-review/clear)
□ 14-day soak at SS_TWO_SIDED_MAX_PAIRS_PER_DAY=2 — no operator-cleared halts attributable to systematic issues
□ Operator approves volume cap raise to next tier
```

---

## 6. Incident response shortcuts

| Symptom | First action |
|---|---|
| Activations failing with `feed_unavailable` | Check `/foxify/v2/feed/health` — if all 5 sources fail, network/firewall issue |
| Trigger detector quiet | `/admin/foxify/v2/diagnostics` → check `feed.lastAggregationMs` recent |
| Pair stuck in `unwinding` > 5 min | Check event log: `/foxify/v2/pairs/:id/events` — look for `execution_stuck` |
| DVOL spiked > 60 | Auto-halt fires; verify via `/admin/foxify/v2/diagnostics`. Resume manually when DVOL < 55 |
| Foxify reports webhook signature mismatch | Webhook secret rotation needed: POST /admin/foxify/v2/webhook-config with new secret |
| `bootResurrect` log shows skipped pairs with errors | Check `pair_events` for those pair_ids; may need manual intervention |
| Render restart loop | Disable `SS_TWO_SIDED_LIVE_ENABLED` first; investigate after |

---

## 7. Operator quick reference

**Pause everything:** `POST /admin/foxify/v2/halt {kind: "atticus"}`
**Resume:** `POST /admin/foxify/v2/resume {kind: "atticus"}`
**Foxify-elected pause:** `POST /admin/foxify/v2/halt {kind: "foxify"}`
**Toggle deferred pool:** `POST /admin/foxify/v2/deferred-pool {active: true|false}`
**Clear newborn for regime:** `POST /admin/foxify/v2/newborn-review/clear {regime: "calm"}`
**Full status:** `GET /admin/foxify/v2/diagnostics`
**Daily report:** invoke `dashboardService.generateDailyReport()` (cron-side; today's payload visible via `/foxify/v2/status`)
