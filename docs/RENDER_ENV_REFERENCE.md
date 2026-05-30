# Render Environment Variables Reference

Comprehensive list of every environment variable the platform reads, what it controls, the default value, and when to flip it. Grouped by category for fast operator lookup.

Last updated: 2026-05-29

---

## Quick reference - the only vars you usually touch

| Variable | Stage | Default | When to change |
|---|---|---|---|
| `FOXIFY_V2_ENABLED` | Always | `false` | Set to `true` to mount routes (one-time) |
| `SHADOW_AUTO_ACTIVATE` | Shadow | `false` | Set to `true` to run signal-driven shadow loop |
| `SHADOW_AUTO_POLICY` | Shadow | `conservative` | Set to `opportunistic` or `hybrid` to test alternative policies |
| `SS_TWO_SIDED_LIVE_ENABLED` | LIVE money | `false` | Flip to `true` only when ready to ship real money |
| `FOXIFY_V2_LIVE_EXECUTION` | LIVE money | `false` | Must be `true` alongside `SS_TWO_SIDED_LIVE_ENABLED` |
| `SS_TWO_SIDED_BOOT_HALT` | Safety | `true` | Leave true; means every deploy starts halted until operator clears |

Everything else has sensible defaults you usually don't need to think about.

---

## 1. Critical infrastructure (must be set for platform to function)

| Variable | Type | Required? | Description |
|---|---|---|---|
| `POSTGRES_URL` or `DATABASE_URL` | URL | YES | Postgres connection string. Pair/event/audit persistence. Without this the service won't boot. |
| `PORT` or `API_PORT` | int | NO (default 4100) | HTTP port the API listens on. Render auto-sets PORT. |
| `HOST` | string | NO (default 0.0.0.0) | Host to bind. |
| `PILOT_ADMIN_TOKEN` | string (32+ chars) | YES | All `/admin/foxify/v2/*` endpoints require `X-Admin-Token` matching this value. |
| `FOXIFY_API_KEY` | string (32+ chars) | YES (for Foxify integration) | All `/foxify/v2/*` endpoints require `X-Foxify-Token` matching this value. Share with Foxify when they integrate. |

---

## 2. Venue credentials (price feeds + execution)

### Deribit
| Variable | Type | Required? | Description |
|---|---|---|---|
| `DERIBIT_CLIENT_ID` | string | YES | Deribit API client ID. Required for live option quotes and live execution. |
| `DERIBIT_CLIENT_SECRET` | string | YES | Deribit API client secret. |
| `DERIBIT_ENV` | `live` or `testnet` | NO (default `live`) | Which Deribit environment to hit. |
| `DERIBIT_PAPER` | bool | NO | If `true`, uses Deribit paper trading. |

### Bullish
| Variable | Type | Required? | Description |
|---|---|---|---|
| `PILOT_BULLISH_ENABLED` | bool | YES (set to `true`) | Enables Bullish as a venue for quotes/routing. |
| `PILOT_BULLISH_AUTH_MODE` | `ecdsa` or `hmac` | YES (set to `ecdsa`) | Authentication mode. Production uses ECDSA. |
| `PILOT_BULLISH_ECDSA_PUBLIC_KEY` | string | YES | Bullish ECDSA public key. |
| `PILOT_BULLISH_ECDSA_PRIVATE_KEY` | string | YES | Bullish ECDSA private key. Sensitive - rotate periodically. |
| `PILOT_BULLISH_ECDSA_METADATA` | string | YES | Bullish ECDSA metadata field. |
| `PILOT_BULLISH_TRADING_ACCOUNT_ID` | string | YES | Trading account ID for live execution. |
| `PILOT_BULLISH_REST_BASE_URL` | URL | NO (sensible default) | Override Bullish REST URL. |
| `PILOT_BULLISH_PUBLIC_WS_URL` | URL | NO (sensible default) | Override Bullish public WS URL. |
| `PILOT_BULLISH_PRIVATE_WS_URL` | URL | NO (sensible default) | Override Bullish private WS URL. |
| `PILOT_BULLISH_DEFAULT_SYMBOL` | string | NO (default `BTCUSDC`) | Default trading symbol. |

---

## 3. Foxify v2 feature flags

| Variable | Type | Default | Description |
|---|---|---|---|
| `FOXIFY_V2_ENABLED` | bool | `false` | Master switch to mount `/foxify/v2/*` and `/admin/foxify/v2/*` routes. **Must be `true` for any v2 functionality.** |
| `SS_TWO_SIDED_LIVE_ENABLED` | bool | `false` | Master switch for REAL-MONEY execution. Stays `false` during shadow testing. |
| `FOXIFY_V2_LIVE_EXECUTION` | bool | `false` | Secondary gate inside v2 flow. Both this AND `SS_TWO_SIDED_LIVE_ENABLED` must be `true` for real-money to execute (defense in depth). |
| `SS_TWO_SIDED_BOOT_HALT` | bool | `true` | System auto-halts on every deploy boot. Operator clears with `POST /admin/foxify/v2/resume`. Belt-and-suspenders. |
| `SS_TWO_SIDED_MAX_PAIRS_PER_DAY` | int | `2` | Hard cap on real-money activations per day. Increase incrementally as confidence grows. |
| `SS_TWO_SIDED_CELL_ALLOWLIST` | csv | `pair_50k_2pct` | Global cell allowlist (env-level). Per-regime allowlists are stored in DB; override via `/admin/foxify/v2/cell-allowlist`. |
| `SS_TWO_SIDED_NEWBORN_REVIEW_PER_REGIME` | int | `10` | After N newborn triggers in a regime, system auto-halts for operator review. |

---

## 4. Shadow auto-activator (signal-driven shadow loop)

| Variable | Type | Default | Description |
|---|---|---|---|
| `SHADOW_AUTO_ACTIVATE` | bool | `false` | Master switch. When `true`, background loop polls signal every `SHADOW_AUTO_POLL_MS` and fires shadow activations when policy permits. **Zero real-money risk** - all activations use `ShadowStrangleExecutor`. |
| `SHADOW_AUTO_POLICY` | `conservative` / `opportunistic` / `hybrid` | `conservative` | Determines which signal triggers activation:<br>- **conservative**: only when global signal flips `good_to_activate=true`<br>- **opportunistic**: when any cell shows verdict=PROFITABLE (regardless of global signal)<br>- **hybrid**: either condition above |
| `SHADOW_AUTO_POLL_MS` | int (ms) | `60000` | How often the loop checks the signal. |
| `SHADOW_AUTO_SUSTAINED_SEC` | int (sec) | `60` | Global signal must be GO for this many seconds before conservative/hybrid activates (filters one-tick noise). Bypassed by pure-opportunistic activations. |
| `SHADOW_AUTO_MAX_PER_WINDOW` | int | `3` | Max activations per rolling window. Prevents activation spam. |
| `SHADOW_AUTO_MAX_CELL_TRIGGER_PCT` | float | `0.05` | Only cells with trigger band ≤ this % are eligible. Default `0.05` = 5%. |
| `SHADOW_AUTO_MAX_COST_USDC` | int | `100000` | Max shadow cost cap. (Irrelevant since shadow doesn't risk real capital, but harness for sanity check.) |

---

## 5. Operational tuning (defaults are fine, override only if you need to)

### Logging + observability
| Variable | Default | Description |
|---|---|---|
| `TWO_SIDED_LOG_LEVEL` | `info` | Set to `debug` for verbose lifecycle logs. |
| `PILOT_TRUST_PROXY` | (unset) | Set to `true` if running behind a reverse proxy (Render uses one). |

### Circuit breaker (pilot-level, for the broader system)
| Variable | Default | Description |
|---|---|---|
| `PILOT_CIRCUIT_BREAKER_MAX_LOSS_PCT` | `0.5` | Max session loss as % before circuit trips. |
| `PILOT_CIRCUIT_BREAKER_WINDOW_MS` | `86400000` (24h) | Loss measurement window. |
| `PILOT_CIRCUIT_BREAKER_COOLDOWN_MS` | `14400000` (4h) | Time to wait after trip before recovery. |
| `PILOT_CIRCUIT_BREAKER_MIN_SAMPLES` | `4` | Min trades before circuit can trip. |
| `PILOT_CIRCUIT_BREAKER_ENFORCE` | `true` | Set to `false` to disable enforcement (logging only). |

### Volume cover (older subsystem, runs alongside)
| Variable | Default | Description |
|---|---|---|
| `VOLUME_COVER_ENABLED` | `false` | Enable the older volume-cover subsystem. Independent of foxify v2. |
| `VOLUME_COVER_TRIGGER_DETECTOR_ENABLED` | `true` | Volume-cover trigger detector poll. |
| `VOLUME_COVER_HEDGE_MANAGER_ENABLED` | `true` | Volume-cover hedge manager. |
| `VOLUME_COVER_AUTH_DISABLED` | `false` | Disable auth on volume-cover routes (dev only). |

---

## 6. Required env-var checklist by deployment stage

### Stage 1: Service mounted, no auto-activity (read-only state)

```
POSTGRES_URL
PILOT_ADMIN_TOKEN
FOXIFY_V2_ENABLED=true
DERIBIT_CLIENT_ID
DERIBIT_CLIENT_SECRET
PILOT_BULLISH_ENABLED=true
PILOT_BULLISH_AUTH_MODE=ecdsa
PILOT_BULLISH_ECDSA_PUBLIC_KEY
PILOT_BULLISH_ECDSA_PRIVATE_KEY
PILOT_BULLISH_ECDSA_METADATA
PILOT_BULLISH_TRADING_ACCOUNT_ID
```

Verify with: `curl -H "X-Admin-Token: $RENDER_ADMIN_TOKEN" .../admin/foxify/v2/diagnostics | jq '.feed.health, .liquidChainCache.venue_status'`

Expected: `"healthy"` and both venues `ok: true`.

### Stage 2: Add shadow auto-loop + Foxify-facing endpoints

Add to Stage 1:
```
SHADOW_AUTO_ACTIVATE=true
SHADOW_AUTO_POLICY=conservative   # or opportunistic / hybrid
FOXIFY_API_KEY=<generate via: openssl rand -hex 32>
```

Verify with: `curl -H "X-Admin-Token: $RENDER_ADMIN_TOKEN" .../admin/foxify/v2/shadow-auto/status | jq '.enabled, .config.policy'`

Expected: `true` and your chosen policy name.

### Stage 3: Add real-money execution (only after extensive shadow soak)

Add to Stage 2:
```
SS_TWO_SIDED_LIVE_ENABLED=true
FOXIFY_V2_LIVE_EXECUTION=true
SS_TWO_SIDED_MAX_PAIRS_PER_DAY=2   # start tight, ramp up
SS_TWO_SIDED_CELL_ALLOWLIST=pair_50k_2pct,pair_50k_5pct_otm,pair_50k_4pct_otm_short
```

After deploy, clear boot halt:
```
curl -X POST -H "X-Admin-Token: $RENDER_ADMIN_TOKEN" .../admin/foxify/v2/resume \
  -H "Content-Type: application/json" -d '{"kind":"atticus"}'
```

---

## 7. Activation policy decision matrix

When choosing `SHADOW_AUTO_POLICY`:

| Policy | Fires when... | Activation cadence | Use case |
|---|---|---|---|
| **conservative** | Global signal `good_to_activate=true` AND signal sustained ≥ 60s | Low - depends on regime + VRP threshold crossings | "What if Foxify uses the strictest policy?" - validates the safest baseline |
| **opportunistic** | Any cell has verdict=PROFITABLE (regardless of global signal) | Higher - includes calm-regime cells with +EV | "What if Foxify uses the cell-level EV directly?" - validates the more aggressive policy |
| **hybrid** | EITHER conservative OR opportunistic conditions | Highest - broadest coverage | "What if Foxify uses both signals?" - validates the most-frequent policy |

You can run all three policies in parallel by deploying with one, observing the audit log for a day, then switching - all decisions are tagged with `policy: <value>` in the `details` field.

Most operators start with `conservative` to validate the strict baseline, then move to `hybrid` for production after they're confident in the close stack.

---

## 8. Security notes

1. **Rotate `PILOT_ADMIN_TOKEN` and `FOXIFY_API_KEY` periodically.** Especially before going live with real money.
2. **Never paste tokens in chat/issues/PRs.** Render dashboard is the only place they should live (besides your operator notes).
3. **`PILOT_BULLISH_ECDSA_PRIVATE_KEY` is the most sensitive value.** Compromise = full account access. Rotate immediately if exposed.
4. **`DERIBIT_CLIENT_SECRET` likewise.** Different account but same severity.

---

## 9. Where to find variables in code

- `services/api/src/server.ts` - top-level platform flags
- `services/api/src/singleSide/twoSided/shadowAutoActivator.ts` - shadow loop config (`readAutoActivatorConfig`)
- `services/api/src/singleSide/twoSided/routes.ts` - auth tokens, exposed in `/admin/foxify/v2/diagnostics` `env` field
- `services/api/src/pilot/config.ts` - Bullish + Deribit credentials

`grep -rn "process.env" services/api/src/` will list every env reference if you need to audit comprehensively.

---

## 10. Verification snippets

After any env change + redeploy, run these to confirm correct state:

```bash
# Platform health + env reflection
curl -sS -H "X-Admin-Token: $RENDER_ADMIN_TOKEN" \
  "<api-base-url>/admin/foxify/v2/diagnostics" \
  | jq '{env, feed_health: .feed.health, venues: .liquidChainCache.venue_status}'

# Shadow auto-loop config
curl -sS -H "X-Admin-Token: $RENDER_ADMIN_TOKEN" \
  "<api-base-url>/admin/foxify/v2/shadow-auto/status" \
  | jq '{enabled, policy: .config.policy, totals}'

# Foxify token works (use the value of FOXIFY_API_KEY)
curl -sS -H "X-Foxify-Token: <FOXIFY_API_KEY>" \
  "<api-base-url>/foxify/v2/should_activate" \
  | jq '.signal_tier, (.cell_opportunities | length)'
```

All three should respond 200 with sensible data.
