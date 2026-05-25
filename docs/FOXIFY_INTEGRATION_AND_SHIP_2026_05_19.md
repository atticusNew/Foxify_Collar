# Volume Cover — Foxify Integration & Ship Plan (2026-05-19)

This is the single source of truth for the 2026-05-19 production ship.
Three audiences:

- **Atticus operator** (you) — pre-flight checklist + cleanup procedures
- **Foxify bot integrator** — endpoint contract + HMAC signing + curl examples
- **On-call / postmortem** — known risks, env knobs, mitigation playbook

---

## 1. What's shipping

- One venue: **Deribit live**, primary and only.
- Bullish is disabled by env override (see §4.2). Reactivation requires a
  confirmed live Bullish round-trip test (separate workstream).
- Cell mix: `50k_2pct_1k`, `50k_5pct_2_5k`, `50k_10pct_5k`,
  `200k_5pct_10k`, `200k_10pct_20k`, `200k_15pct_30k`.
  Test cell `1k_2pct_20` enabled only for the 06:30 ET smoke test.
- Three new admin endpoints from 2026-05-19 work
  (`all-open-legs`, `mark-leg-failed-manual`, `mark-legs-failed-batch`,
  `backfill-ledger-sold-leg`).
- Hedge manager: rule 12 (hard floor) overrides rule 2 (Asia thin window)
  so cliff drops still TP overnight. Default fallback IV lowered 0.65 → 0.45.
- **Per-cell hedge tenor** (new in 2026-05-19 P2 calibration): each cell
  now uses an `expiryHorizonDays` matched to Foxify's observed hold pattern
  + safety cushion, calibrated by hourly-OHLC Monte Carlo
  (`scripts/probes/vc_monte_carlo_v2.ts`).
  - 2% cells (`50k_2pct_1k`, `1k_2pct_20`): **3d** (hold ~0.5d)
  - 5% cells (`50k_5pct_2_5k`, `200k_5pct_10k`): **5d** (hold ~2.4d)
  - 10%/15% cells (`50k_10pct_5k`, `200k_10pct_20k`, `200k_15pct_30k`):
    **14d** (hold ~9-12d — short tenor here causes uncovered post-expiry
    triggers, MC p5 = −$26k for 15% cell at 3d, vs −$3k at 14d).
  Saves ~50-70% upfront hedge premium on short-hold cells without
  introducing tail risk on long-hold cells. Override per-call via
  `expiryHorizonDays` param on `buildHedgeStructure*`.

---

## 2. Foxify-facing API (this is what Foxify's bot calls)

### 2.1 Auth model

- Every Foxify request must include two headers:
  - `X-Foxify-Timestamp` — Unix epoch in milliseconds, within ±60s of server clock.
  - `X-Foxify-Signature` — HMAC-SHA256 of `${timestamp}\n${METHOD}\n${path}\n${body}` (path is URL pathname, body is the verbatim JSON body string, empty string if no body).
- The shared secret is the value of `FOXIFY_API_KEY_HMAC_SECRET` on Render.
- Admin endpoints use `X-Admin-Token` instead (operator-only, do **not** share with Foxify).

### 2.2 Endpoints to share with Foxify

Base URL: `https://foxify-pilot-new.onrender.com`

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/volume-cover/quote` | Price quote (no commit) |
| `POST` | `/volume-cover/activate` | Open protection. Returns **201** on success. |
| `GET`  | `/volume-cover/positions/:positionId` | Look up a position, including hedge leg expiry timestamps |
| `POST` | `/volume-cover/positions/:positionId/close` | Close a position. Coverage runs to the end of the last paid day. |

Important lifecycle notes:
- Foxify should explicitly call `/close` when protection is no longer needed.
  The position state does not automatically transition to `closed` purely
  because option expiry time has passed.
- **Coverage window on close** (2026-05-19): Foxify is billed in whole-day
  increments (`ceil(daysHeld)`). When `/close` is called, Atticus billing
  stops and the position row flips to `status='closed'`, but **protection
  remains live through the end of the last paid day**. A trigger fired
  within that window still pays out the cell `payoutUsdc`. The exact end
  of coverage is returned to Foxify in the `coverageThroughIso` field on
  the close response and on `GET /positions/:id`.
  - Example: open 14:00 UTC Mon, close 02:30 UTC Tue (12.5h elapsed) →
    `daysBilled = 1`, `coverageThroughIso = 14:00 UTC Tue`. A trigger at
    08:00 UTC Tue pays out; a trigger at 18:00 UTC Tue does not.
  - Position re-opens are independent (each new `foxifyPairId` is its own
    position with its own billing window).

Rate limits (per-IP, in addition to the global 60/min):

- `/quote`: 30/min
- `/activate`: 15/min

Both are overridable via `VC_QUOTE_RATE_LIMIT_MAX` / `VC_ACTIVATE_RATE_LIMIT_MAX`.

### 2.3 Request schemas

**POST /volume-cover/quote** body:
```json
{
  "foxifyPairId": "string (max 128)",
  "pairNotionalUsdc": 50000,
  "triggerPct": 0.02,
  "pairEntryBtcPrice": 76800,
  "cellId": "50k_2pct_1k"
}
```
- `cellId` optional; if omitted, the server picks the matching cell by `(notional, triggerPct)`.
- `pairEntryBtcPrice` optional on quote; if omitted, server uses live spot.

**POST /volume-cover/activate** body:
```json
{
  "foxifyPairId": "string",
  "cellId": "50k_2pct_1k",
  "pairLongNotionalUsdc": 50000,
  "pairShortNotionalUsdc": 50000,
  "pairEntryBtcPrice": 76800,
  "fingerprintHash": "optional, audit-only — see note"
}
```
- Server validates `pairEntryBtcPrice` is within 1% of live spot. Larger drift → 400 `entry_price_drift_too_high`.
- `foxifyPairId` is the idempotency key + Foxify external reference id.
- Re-sending the same `foxifyPairId` returns the existing active position.
- Recommended format: stable per-order identifier (for example
  `BTCUSD-<foxifyInternalOrderId>`). Avoid simple rolling counters that
  can collide across restarts/services.
- **`fingerprintHash` (2026-05-25 update)**: now purely an audit /
  forward-compat field. Atticus's ladder netting matches retained
  hedge legs by `cell + option_kind + strike (±1.5%) + expiry + recency`
  and no longer requires a fingerprint match (single-counterparty
  pilot assumption + tight strike/expiry/cell gates make cross-pattern
  mismatch impossible in practice). Foxify can omit this field
  without affecting hedge economics. If sent, it is recorded on the
  position row + the `volume_cover_ladder_netting_event` audit table
  for surveillance.

### 2.4 Response shape (201 on activate success)

```json
{
  "positionId": "vc-pos-<uuid>",
  "status": "active",
  "cellId": "50k_2pct_1k",
  "triggerHighBtc": 78336,
  "triggerLowBtc": 75264,
  "dailyPremiumUsdc": 350,
  "payoutUsdc": 1000,
  "hedgeLegs": [
    { "id": "vc-leg-<uuid>", "venue": "deribit", "optionKind": "put",  "strikeUsdc": 76032, "expiryIso": "2026-05-23T08:00:00.000Z" },
    { "id": "vc-leg-<uuid>", "venue": "deribit", "optionKind": "call", "strikeUsdc": 77568, "expiryIso": "2026-05-23T08:00:00.000Z" }
  ],
  "coverExpiresAtIso": "2026-05-23T08:00:00.000Z",
  "salvageState": "healthy"
}
```

### 2.5 Position lookup response highlights

`GET /volume-cover/positions/:positionId` now includes:
- `hedgeLegs[]` with `expiryIso` per leg
- `coverExpiresAtIso` (max leg expiry; canonical "cover expiry" timestamp)
- `coverageThroughIso` (NULL while `status='active'`; on close, set to
  `openedAt + ceil(daysHeld) × 24h` — the end of Foxify's paid coverage
  window. Triggers within this window still pay out.)
- `protectionActive` (true if status='active', OR status='closed' with
  `coverageThroughIso > now`. False once the paid window has elapsed.)

`POST /volume-cover/positions/:positionId/close` response now includes:
- `coverageThroughIso` — end of paid coverage (trigger eligibility runs through this)
- `daysBilled` — `ceil(daysHeld)` whole days charged
- `hedgeRetainedLegIds` — Atticus-retained legs (TP curve manages disposition)

### 2.6 Common error codes

| HTTP | error code | Meaning |
|---|---|---|
| 401 | `unauthorized` | HMAC missing / invalid / timestamp drift > 60s |
| 400 | `invalid_request` | Body schema validation failed (`issues` has Zod details) |
| 400 | `cell_not_found` | `cellId` not in matrix |
| 400 | `entry_price_drift_too_high` | `pairEntryBtcPrice` > 1% off live spot |
| 403 | `cell_disabled` | Admin toggled this cell off |
| 429 | `rate_limit_exceeded` | Foxify exceeded per-IP limit |
| 503 | `cell_row_missing` / `spot_price_unavailable` | Transient infra issue, retry with backoff |
| 500 | `activate_failed` | Hedge venue error or DB error; check `message` |

### 2.7 Reference curl with HMAC signing (bash)

```bash
SECRET="<FOXIFY_API_KEY_HMAC_SECRET>"
BASE="https://foxify-pilot-new.onrender.com"
METHOD="POST"
PATH_="/volume-cover/activate"
TS=$(($(date +%s%N) / 1000000))
BODY='{"foxifyPairId":"pair-001","cellId":"50k_2pct_1k","pairLongNotionalUsdc":50000,"pairShortNotionalUsdc":50000,"pairEntryBtcPrice":76800}'
MSG=$(printf "%s\n%s\n%s\n%s" "$TS" "$METHOD" "$PATH_" "$BODY")
SIG=$(printf "%s" "$MSG" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')

curl -sS -X POST "$BASE$PATH_" \
  -H "X-Foxify-Timestamp: $TS" \
  -H "X-Foxify-Signature: $SIG" \
  -H "Content-Type: application/json" \
  -d "$BODY" | jq .
```

The same recipe works for `/quote` and the position endpoints; just change `METHOD` / `PATH_` / `BODY` (use empty string for GETs).

---

## 3. Cleanup procedure for tonight's phantom legs

Run these in order (all admin-token endpoints; `$PILOT_API` =
`https://foxify-pilot-new.onrender.com`, `$PILOT_ADMIN_TOKEN` from Render env).

```bash
# A. Inventory every open leg in the DB
curl -sS "$PILOT_API/volume-cover/admin/all-open-legs" \
  -H "X-Admin-Token: $PILOT_ADMIN_TOKEN" | jq .

# B. Backfill the missing ledger row from the live Deribit recovery
LEG_ID="vc-leg-d97fbb68-f980-448e-b2fa-0b98e001c9b0"
curl -sS -X POST "$PILOT_API/volume-cover/admin/backfill-ledger-sold-leg/$LEG_ID" \
  -H "X-Admin-Token: $PILOT_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"totalProceedsUsdc":245.96,"reason":"backfill pre-fix mark-leg-sold-manual 2026-05-19"}' | jq .

# C. Mark the 6 known phantom legs as failed
curl -sS -X POST "$PILOT_API/volume-cover/admin/mark-legs-failed-batch" \
  -H "X-Admin-Token: $PILOT_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "legIds": [
      "vc-leg-e8737482-7904-4992-ad5b-fb23483b95fc",
      "vc-leg-32071b86-c756-4407-bc36-2f3a167e36e4",
      "vc-leg-be4828c9-81b4-4b50-9946-45176ca46d8d",
      "vc-leg-95706891-69e0-4a02-9797-ae7f2d56327b",
      "vc-leg-200c5172-2d68-4eb3-9efb-1ff4bd1de6f5",
      "vc-leg-37fa1bc0-dd0e-432b-a895-63ee66aa5465"
    ],
    "reason": "paper/sim legs never filled live",
    "evidence": "force-sell-leg returned bullish_http_404 (4) and deribit:not_filled:unknown (2) on 2026-05-19T05:34-05:36Z"
  }' | jq .

# D. Inventory again — repeat (A); any remaining open legs need probing
curl -sS "$PILOT_API/volume-cover/admin/all-open-legs" \
  -H "X-Admin-Token: $PILOT_ADMIN_TOKEN" | jq .

# E. For each remaining open leg, probe and either sell-or-fail:
#    success -> real leg, money realized via force-sell ledger entry
#    bullish_http_404 / deribit:not_filled -> phantom; add to mark-legs-failed-batch
LEG_ID="<replace>"
curl -sS -X POST "$PILOT_API/volume-cover/admin/force-sell-leg/$LEG_ID" \
  -H "X-Admin-Token: $PILOT_ADMIN_TOKEN" | jq .
```

---

## 4. Pre-flight checklist for 06:30 ET test trade

### 4.1 Render env vars to verify / set

| Var | Required value | Why |
|---|---|---|
| `PILOT_DERIBIT_ENV` | `live` | Use real money venue |
| `PILOT_DERIBIT_PAPER` | `false` | Not paper mode |
| `PILOT_DERIBIT_CLIENT_ID` / `_SECRET` | set | Live creds |
| `FOXIFY_API_KEY_HMAC_SECRET` | shared with Foxify | HMAC validation |
| `PILOT_ADMIN_TOKEN` | rotated, shared with you only | Admin endpoints |
| `VOLUME_COVER_VENUE_ROUTING_JSON` | see §4.2 | Force Deribit-only |
| `VC_HM_FALLBACK_IV` | `0.40` | Realistic IV for current BTC vol |
| `VC_HM_SELL_SLIPPAGE_ALERT_PCT` | `0.30` (default) | Alert on >30% slippage |
| `VC_ACTIVATE_RATE_LIMIT_MAX` | `15` (default) | Per-IP /activate cap |
| `VC_QUOTE_RATE_LIMIT_MAX` | `30` (default) | Per-IP /quote cap |
| `VC_TP_THIN_WINDOW_UTC_START` | `4` (default, Asia) | Confirmed sensible for venue mix |
| `VC_TP_THIN_WINDOW_UTC_END` | `6` (default) | |

### 4.2 Deribit-only venue override (lock Bullish OFF)

Set on Render:

```json
{
  "0.02": { "primary": "deribit", "fallback": null },
  "0.05": { "primary": "deribit", "fallback": null },
  "0.1":  { "primary": "deribit", "fallback": null },
  "0.15": { "primary": "deribit", "fallback": null }
}
```

As a single Render env value (JSON minified):

```text
VOLUME_COVER_VENUE_ROUTING_JSON={"0.02":{"primary":"deribit","fallback":null},"0.05":{"primary":"deribit","fallback":null},"0.1":{"primary":"deribit","fallback":null},"0.15":{"primary":"deribit","fallback":null}}
```

This is read by `resolveHedgeVenue()` in `tightHedge.ts`. With `fallback: null`, Bullish is never tried even if Deribit fails — the activate fails closed with `hedge_execution_failed`, which is the correct safety behavior.

### 4.2.1 Pilot launch LOCK-DOWN (2026-05-20)

This is the operator verification you run **right before flipping Foxify on**. It guarantees:

1. Exactly **one cell can activate**: `50k_2pct_1k`
2. Exactly **two real positions** can ever open before the system stops accepting activations
3. After both pilot positions close/trigger, **no auto-reopens** — system stays closed until you explicitly raise the cap
4. Once you're satisfied with the data, **single env-var change** returns the system to normal operation

#### Step 1 — Disable every cell except the 2% pilot cell

```bash
# Disable each non-pilot cell. The activate route returns
# 403 `cell_disabled` for any of these.
for CELL in 50k_5pct_2_5k 50k_10pct_5k 200k_5pct_10k 200k_10pct_20k 200k_15pct_30k 1k_2pct_20; do
  curl -sS -X POST "$PILOT_API/volume-cover/admin/cells/$CELL/toggle" \
    -H "X-Admin-Token: $PILOT_ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"enabled": false}' \
    | jq '{cellId: .cell.cellId, enabled: .cell.enabled}'
done

# Verify: only 50k_2pct_1k should show enabled=true
curl -sS "$PILOT_API/volume-cover/admin/cells" \
  -H "X-Admin-Token: $PILOT_ADMIN_TOKEN" \
  | jq '.cells[] | {cellId, enabled}'
```

#### Step 2 — Set both caps on the pilot cell

On Render, set these two env vars and redeploy:

```text
VC_MAX_CONCURRENT_PER_CELL_50K_2PCT_1K=2
VC_MAX_LIFETIME_PER_CELL_50K_2PCT_1K=2
```

- `VC_MAX_CONCURRENT_PER_CELL_*` — caps simultaneous active positions at 2 (returns 429 `concurrent_throttle_exceeded` on the 3rd).
- `VC_MAX_LIFETIME_PER_CELL_*` — caps **total positions ever opened** at 2, even after the first two close (returns 423 `lifetime_cap_exceeded`). This is the key gate that prevents auto-reopens during the manual-review window. Excludes prior admin-test positions (`metadata.source='admin_test_activate'`) so the count starts fresh on the first real Foxify activation.

#### Step 3 — Verify the gate is wired before Foxify goes live

```bash
# Should show exactly one enabled cell
curl -sS "$PILOT_API/volume-cover/admin/cells" \
  -H "X-Admin-Token: $PILOT_ADMIN_TOKEN" \
  | jq '.cells | map(select(.enabled == true)) | {enabledCount: length, enabledCellIds: map(.cellId)}'
# expect: {"enabledCount": 1, "enabledCellIds": ["50k_2pct_1k"]}

# Optional: dry-fire a 3rd activation against the test cell after seeding 2
# fake real positions — confirms the 423. Skip in prod; the unit test
# `volume-cover/activate honors VC_MAX_LIFETIME_PER_CELL` covers this.
```

#### Step 4 — Unlock criteria (after first 2 positions close/trigger)

When you're satisfied with the calibration data from the first two positions, **make exactly one change** on Render:

```text
# Raise to your next scale-up tier and redeploy
VC_MAX_LIFETIME_PER_CELL_50K_2PCT_1K=5     # next tier (or 10 / 25 / 50 / etc.)
VC_MAX_CONCURRENT_PER_CELL_50K_2PCT_1K=5   # match the lifetime cap or set independently
```

To restore fully normal operation later, delete both env vars (or set to 0).

#### What happens behind the scenes

- Position #1 opens → both counts at 1
- Position #2 opens → both counts at 2 (lifetime cap reached, **no more activations**)
- Position #1 closes → concurrent drops to 1, lifetime stays at 2 → still blocked
- Position #1 triggers payout → concurrent drops to 1 (status='triggered'), lifetime stays at 2 → still blocked
- 2 more close attempts on the same cell from Foxify → **423 `lifetime_cap_exceeded`** with `openedEver: 2, maxLifetime: 2`
- You review the data, raise the env var → activations resume on next request

### 4.3 Pre-test verification (run at ~06:00 ET = 10:00 UTC)

```bash
# 1. Deribit live auth + balance
curl -sS "$PILOT_API/volume-cover/admin/deribit-auth-test" \
  -H "X-Admin-Token: $PILOT_ADMIN_TOKEN" \
  | jq '{env, paper, authOk, equityBtc: .accountSummary.result.equity}'
#    expect: env=live, paper=false, authOk=true, equityBtc > 0.01

# 2. Halt status (should be clear)
curl -sS "$PILOT_API/volume-cover/admin/dashboard" \
  -H "X-Admin-Token: $PILOT_ADMIN_TOKEN" \
  | jq '{halted, activePositions, guardStatuses}'

# 3. Spot source is alive
curl -sS "$PILOT_API/volume-cover/health" | jq .

# 4. Open-leg inventory is clean (≤ a couple of expected open positions)
curl -sS "$PILOT_API/volume-cover/admin/all-open-legs" \
  -H "X-Admin-Token: $PILOT_ADMIN_TOKEN" | jq .count

# 5. Verify cell config — 1k_2pct_20 enabled, others enabled
curl -sS "$PILOT_API/volume-cover/admin/cells" \
  -H "X-Admin-Token: $PILOT_ADMIN_TOKEN" | jq '.cells[] | {cellId, enabled}'

# 6. Hedge-manager run with realistic IV — should not fire anything wild
curl -sS -X POST "$PILOT_API/volume-cover/admin/hedge-manager/run?dryRun=true&iv=0.40" \
  -H "X-Admin-Token: $PILOT_ADMIN_TOKEN" | jq '{legsScanned, legsActioned, actions: [.actions[] | {rule, action}]}'
```

### 4.4 The actual 06:30 ET test trade (admin-only, no Foxify HMAC)

Use the operator self-test endpoint with a tiny cell. This is on Deribit live, real money, but the smallest size that exercises the full path:

```bash
PILOT_API="https://foxify-pilot-new.onrender.com"
curl -sS -X POST "$PILOT_API/volume-cover/admin/test-activate" \
  -H "X-Admin-Token: $PILOT_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "foxifyPairId": "ops-smoke-2026-05-19",
    "cellId": "1k_2pct_20",
    "pairLongNotionalUsdc": 1000,
    "pairShortNotionalUsdc": 1000,
    "pairEntryBtcPrice": <FILL_IN_LIVE_SPOT>
  }' | jq .
```

Expected: 201 with `positionId`, both legs `venue: "deribit"`, both filled.

Then immediately verify:

```bash
POS_ID="<from previous response>"
curl -sS "$PILOT_API/volume-cover/admin/active-positions-detail?limit=20" \
  -H "X-Admin-Token: $PILOT_ADMIN_TOKEN" \
  | jq '.positions[] | select(.id==env.POS_ID)'
```

You should see both legs `status: "open"`, both on Deribit, with fill prices populated.

Close it (or let it run depending on what you want to validate):

```bash
curl -sS -X POST "$PILOT_API/volume-cover/admin/positions/$POS_ID/close" \
  -H "X-Admin-Token: $PILOT_ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"reason":"smoke test complete"}' | jq .
```

This closes the position. The hedge manager will TP the legs on its next tick (or you can `force-sell-leg` each one).

### 4.5 Foxify can start hitting `/activate` at — recommendation

After (1) smoke test succeeds, (2) ledger row appears for each TP'd leg via `pool-ledger?poolId=atticus_hedge`, (3) `active-positions-detail` shows clean state. Recommend Foxify test **one** $50k/2% pair first; verify; then second.

---

## 5. Production readiness verdict

### Production-ready

- **Activate path** — full Foxify HMAC auth, anti-bot, drift-check, per-cell throttle, per-IP rate limit, surcharge ladder, atomicity (DB and venue stay consistent on failure)
- **Trigger detection** — runs on schedule, fires retention + salvage_event
- **Hedge manager** — 12-rule TP curve, rule 12 hard-floor overrides Asia thin window, slippage observability alerts at >30%
- **Force-sell + manual recovery** — `force-sell-leg`, `mark-leg-sold-manual`, `backfill-ledger-sold-leg` all write `hedge_sell_in` ledger rows + finalize salvage
- **Phantom reconciliation** — `all-open-legs`, `mark-leg-failed-manual`, `mark-legs-failed-batch` cover the venue-vs-DB drift class
- **Deribit live execution** — confirmed end-to-end on 2026-05-19 ($430.51 realized)
- **Schema integrity** — `volume_cover_hedge_leg_status_check` enforces (`open`, `sold`, `expired`, `failed`); CI test in place

### Known risks / mitigations

| Risk | Mitigation |
|---|---|
| Bullish live untested | Disabled via `VOLUME_COVER_VENUE_ROUTING_JSON`. Re-enable only after a confirmed live Bullish round-trip. |
| Hedge-manager IV is fallback-only by default | Override per-call with `?iv=` on `/hedge-manager/run`; future work to wire a live Deribit IV source. |
| Pool balance + venue balance not wired into Wave 1/2 guards | Guards default to permissive when balance unknown. Operator should monitor `pool-ledger` daily. |
| `volume_cover_position_status_check` still allows stale `cancelled` value | Harmless (nothing writes it). Schema migration to remove can wait. |
| No periodic venue-vs-DB reconciler yet | Manual sweep via `all-open-legs` works; build a cron version after the first week of live ops. |
| Rule 2 thin-window is fixed clock UTC 4–6 | Configurable via `VC_TP_THIN_WINDOW_UTC_START/_END`. Rule 12 emergency exit overrides it. |
| Salvage finalize errors are best-effort | Logged but non-blocking. Ledger row is the canonical truth. |

### Open follow-ups (post-ship)

1. Wire a real Deribit IV source into the hedge manager `spotIvSource` so we stop relying on the env-default fallback.
2. Add a `vc_admin` Bullish live smoke test mirroring the `1k_2pct_20` Deribit pattern; re-enable Bullish in routing only after that passes.
3. Periodic reconciler — extend `weeklyReconciler` to run a daily venue-vs-DB drift check and alert on mismatch.
4. Pool-balance + venue-balance wiring into Wave 1/2 guards.
5. Drop `'cancelled'` from `volume_cover_position_status_check` (cleanup migration).
6. Slippage cap on hedge-manager SELL → consider switching to limit orders with a floor when bid-ask spread allows it.

---

## 7. LOCKED LAUNCH PARAMETERS (2026-05-19, 2-position pilot)

Decision finalized 2026-05-19: ship with the conservative "pause early,
moderate overlay only" config. Premium sweep MC (`scripts/probes/vc_launch_projection.ts`,
10,000 trials/config on 180d hourly BTC OHLC) showed this is the best
risk/commercial trade-off for the launch.

### 7.1 Cell scope at launch

- **Only `50k_2pct_1k`** active at launch. All other cells stay
  disabled or at conservative throttle until pilot data validates.
- **2 concurrent positions max** per the operator launch plan.
  Enforce via `defaultThrottleMaxPerDay` (currently 5; operator should
  monitor `/admin/throttle-state` and reject above 2 concurrent
  manually for the first week if needed).
- Test cell `1k_2pct_20` enabled only for the 06:30 ET smoke test, then
  disabled.

### 7.2 Required env on Render before launch

```bash
# Pause at elevated AND stress (rvol >= 55% / DVOL >= 65)
VC_STRESS_PAUSE_DVOL_THRESHOLD=65

# Regime overlay: moderate tier gets 2.14× lift. Elevated/stress
# are blocked by the stress-pause check above, but the 9999 values
# act as a belt-and-suspenders should the pause check ever bypass.
VC_REGIME_OVERLAY_JSON='{"50k_2pct_1k":{"moderate":750,"elevated":9999,"stress":9999}}'

# 2-position pilot cap on 50k_2pct_1k cell. Hard-blocks the 3rd
# concurrent activation at the route layer (returns 429
# `concurrent_throttle_exceeded`). Independent of the matrix's
# daily-count throttle. Format: VC_MAX_CONCURRENT_PER_CELL_<UPPER_ID>=N,
# or a global default VC_MAX_CONCURRENT_PER_CELL=N for all cells.
VC_MAX_CONCURRENT_PER_CELL_50K_2PCT_1K=2

# 2026-05-20: pilot launch LOCK-DOWN. Lifetime cap on total positions
# ever opened for the cell (excluding admin_test_activate test
# positions). Once N real activations have happened, blocks all
# further activations — including re-opens after close/trigger.
# Returns 423 `lifetime_cap_exceeded`. Use this to launch with exactly
# 2 positions, review the first triggers/closes manually, then raise
# the cap to unlock normal operation.
#
#   - To unlock all activations:   delete the env var or set =0
#   - To unlock with new ceiling:  raise the number
#
# Format: VC_MAX_LIFETIME_PER_CELL_<UPPER_ID>=N
VC_MAX_LIFETIME_PER_CELL_50K_2PCT_1K=2
```

If/when the 5%/10%/15% cells come online (post-pilot), extend the JSON:

```json
{
  "50k_2pct_1k":    {"moderate": 750,  "elevated": 9999, "stress": 9999},
  "50k_5pct_2_5k":  {"moderate": 460,  "elevated": 9999, "stress": 9999},
  "50k_10pct_5k":   {"moderate": 250,  "elevated": 9999, "stress": 9999},
  "200k_5pct_10k":  {"moderate": 1850, "elevated": 9999, "stress": 9999},
  "200k_10pct_20k": {"moderate": 1000, "elevated": 9999, "stress": 9999},
  "200k_15pct_30k": {"moderate": 850,  "elevated": 9999, "stress": 9999}
}
```

### 7.3 Expected pilot economics (4 weeks, 2 concurrent positions)

| Metric | Value | Notes |
|---|---|---|
| Mean per-position P&L | **−$112** | calm $350/d, mod $750/d, paused above |
| Per-position p5 | −$461 | bad-luck 5th-percentile single position |
| **Worst observed** (10k trials) | **−$566** | well below the $1,000 payout cap |
| Theoretical max loss per position | ~−$1,200 | `hedge_buy + payout` with worthless hedge |
| Expected pilot activations | ~153 | 2 concurrent × 28d / ~9h avg hold |
| **Expected 28d pilot P&L** | **−$17,140** | ~$612/day cost-of-business |
| Pilot p5 (CLT over 153 draws) | ~−$24,000 | |
| Pilot p95 (CLT over 153 draws) | ~−$10,000 | |

**The 2% cell is structurally a small-bleed cell** at any operator-tolerable
calm price. The product math is: $185 mean revenue vs. $2,200 mean hedge
buy + ~$100 trigger drag = ~−$2,015 net structural cost per position offset
by ~$1,900 of salvage on close. Break-even on the 2% cell needs either
(a) calm price ≥ $680/d (commercially unrealistic), (b) wider 1.5% OTM
strikes (post-pilot engineering), or (c) directional one-leg hedge
(post-pilot redesign).

**Loss is bounded** — no single position can exceed −$566 observed
(−$1,200 theoretical). With 2 concurrent positions, no scenario blows
up the operator. This is the right cell to start with for calibration:
fast iteration, bounded cost, exercises the full TP curve.

### 7.4 Calibration path (week-by-week)

- **Week 1**: observe actual Foxify hold patterns. Confirm 18.75%-of-
  payout bot exit model. Compare actual trigger rate vs MC's 25% blend.
  Spot-check ledger entries for consistency.
- **Week 2**: if observed bleed > MC's −$17k/4wk projection by >50%,
  lift calm to $400 via DB toggle (`POST /admin/cells/50k_2pct_1k/toggle`
  with new `daily_premium_usdc`). MC says this drops mean to −$100/pos.
- **Week 3-4**: if hold pattern, trigger rate, salvage all match MC,
  enable `50k_5pct_2_5k` (MC says calm +$30/pos, the only structurally
  EV-positive cell at matrix base).
- **Post-pilot**: ship wider-strike experiment to attack the 2% cell
  hedge cost; consider directional hedge prototype.

### 7.5 Ship-ready criteria (must pass before 06:30 ET smoke test)

- [x] Per-cell `expiryHorizonDays` shipped in `matrix.ts` (3d for 2% cells,
  5d for 5% cells, 14d for 10%/15% cells). Verified by
  `volumeCoverTightHedge.test.ts`.
- [x] Hourly-OHLC MC v2 + launch projection in `scripts/probes/`.
- [x] Loss cap empirically verified: max observed −$566 across 10,000
  trials at proposed pricing.
- [x] Regime classifier + stress-pause guardrail already in code
  (`regimeClassifier.ts` + `volumeCoverGuardrails.ts §12.2`).
- [x] Pricing overlay engine reads `VC_REGIME_OVERLAY_JSON`
  (`volumeCover/pricing.ts:36`).
- [x] Concurrent-position cap enforced at the route layer
  (`VC_MAX_CONCURRENT_PER_CELL_*`). Tested in `volumeCoverRoutes.test.ts`.
- [ ] **Render envs set**: `VC_STRESS_PAUSE_DVOL_THRESHOLD=65`,
  `VC_REGIME_OVERLAY_JSON=...`, `VC_MAX_CONCURRENT_PER_CELL_50K_2PCT_1K=2`
  (per §7.2).
- [ ] **Smoke test passes**: 06:30 ET `1k_2pct_20` end-to-end activate +
  TP on Deribit live.
- [ ] **Pool balance sanity check**: Atticus pool has ≥ 10× expected
  worst-case pilot drawdown (~$30k) in USDC for buffer.
- [ ] **Operator alerting on**: `[VC ALERT]` log channel routed to
  Slack/email so phantom-leg / orphan-leg detection surfaces fast.

Once §7.5 boxes are checked, Foxify can hit `/volume-cover/activate` for
the first real $50k/2% pair.

---

## 6. Quick "who do I call" reference

- **Activate returns 201 but no leg row in DB / Deribit**: that's the atomicity bug we patched on 2026-05-19. Should not happen. If it does, check the `[VC ALERT]` log for `compensating sell FAILED — orphan venue leg`.
- **Activate returns 500 `hedge_execution_failed`**: Deribit refused the order. Check `deribit-auth-test` and Deribit dashboard for venue health. Position is marked closed; no leg row was created; no charge.
- **A leg shows `status: open` in DB but no position on the venue UI**: phantom. Run `force-sell-leg`; if it errors with `bullish_http_404` or `deribit:not_filled:unknown`, use `mark-leg-failed-manual` with the venue error as evidence.
- **A leg shows on the venue UI but no row in DB**: orphan. Sell it directly via the venue UI (or build a one-off API call). Future periodic reconciler will catch these.
- **Hedge-manager refuses to TP a leg you want sold**: check the `rule` it's firing — usually rule 2 (Asia thin window 04:00-06:00 UTC) or rule 3 (gamma zone hold). Override via `force-sell-leg`.

---

## 8. Operational env tuning — 2026-05-25 production calibration

After the first ~10 days of pilot operation we identified four guardrail
gates whose default thresholds were sized for adversarial bot prevention
on a single-counterparty integration that doesn't match the legitimate
Foxify auto-reopen pattern. Production-tuned values are below; **all four
should be set on BOTH Render services** (`foxify-pilot-new` for Live and
`foxify-pilot-shadow-3r1m` for Shadow) so test traffic on Shadow doesn't
hit different rejection paths than Live.

### 8.1 Required Render env vars for the Foxify pilot

```
PILOT_CIRCUIT_BREAKER_ENFORCE=false
VOLUME_COVER_ANTIBOT_LAYER1_ENABLED=false
VC_TICK_SPACING_MIN_MS=15000
VC_TICK_SPACING_MIN_BTC_USDC=100
VC_CONTRACT_MULT_DEFAULT=0.8
VC_MAX_CONTRACTS_BTC_DEFAULT=1.0
```

Rationale per var:

| Env var | Default (code) | Pilot value | Why |
|---|---|---|---|
| `PILOT_CIRCUIT_BREAKER_ENFORCE` | `true` | **`false`** | Breaker monitors Deribit equity. Live's Deribit is essentially empty (Volume Cover routes through Bullish). Empty-account drawdown samples cause spurious trips that block the activate path. Observe-only mode keeps the safety net armed without the false-positive blocking. Re-enable when/if Deribit comes back into active use. |
| `VOLUME_COVER_ANTIBOT_LAYER1_ENABLED` | `true` | **`false`** | Layer 1 enforces a 60-min same-cell cooldown per fingerprint. Foxify currently sends `fingerprintHash: null` (single-counterparty integration), so Layer 1 is a no-op AS-IS — but if Foxify ever begins sending a stable hash, the 60-min window would block all ladder-netting reopens (which run on a 30-min window). Disabling Layer 1 prevents that future regression while keeping Layers 2-4 (jitter cooldown, trigger cooldown, Layer-4 surcharge) fully active. |
| `VC_TICK_SPACING_MIN_MS` | `60000` (60s) | **`15000`** (15s) | Foxify's auto-close-then-reopen logic completes in ~5-30s. The 60s gate blocks legitimate close→reopen cycles. 15s still prevents rapid-fire opens (no bot can usefully cycle <15s on this product) while letting the legitimate pattern through. |
| `VC_TICK_SPACING_MIN_BTC_USDC` | `400` | **`100`** | Same reasoning. The OR-condition fires when BTC moves $400+ between same-cell opens (legitimate volatility-driven reopen). Lowering to $100 catches calm-regime reopens that would otherwise wait the full elapsed-MS window. |
| `VC_CONTRACT_MULT_DEFAULT` | `1.0` (matrix base) | **`0.8`** | The matrix sizes spread contracts to deliver `payoutUsdc=$1000` of intrinsic at trigger, but PR-G's overlay drops the actual Foxify payout to **$800 in calm regime**. Sizing for $1000 cover when only owing $800 = systematic 25% over-hedge. Multiplier 0.8 right-sizes contracts so spread intrinsic at trigger = $800 (matches obligation). Saves ~$110 of hedge cost per pair, improves no-trigger EV by ~$57, capital-efficient enough to fit the 4-leg open at $1,378 collateral. Keeps spread intrinsic ≥ Foxify obligation (no uncovered gap). |
| `VC_MAX_CONTRACTS_BTC_DEFAULT` | `Infinity` (no cap) | **`1.0`** | The matrix-formula contract sizing depends on `min(K2−triggerLow, K4−triggerHigh)` which is grid-snap-sensitive. When BTC entry sits next to a $1k strike grid line, the snap can produce a tiny min intrinsic (e.g., $285) and contracts blow up 3-4× (formula: $1k payout / $285 intrinsic = 3.51 BTC). Even with the 0.8 multiplier that's 2.81 BTC, requiring $1,517 cash for step 1 — exceeds available $1,083 USDC and Bullish rejects with `Reached max leverage`. The cap acts as an absolute ceiling: when the formula × multiplier exceeds 1.0 BTC, scale all legs to 1.0 BTC. Activations succeed at the cost of under-coverage in grid-edge scenarios (~5% of activations expected at typical BTC volatility). |

**Optional per-cell overrides** via JSON if you want different values across cells:
```
VC_CONTRACT_MULT_JSON={"50k_2pct_1k": 0.8, "1k_2pct_20": 1.0}
VC_MAX_CONTRACTS_BTC_JSON={"50k_2pct_1k": 1.0, "1k_2pct_20": 0.1}
```

### 8.2 Verification curl (Live)

After setting the env vars and Render redeploys (~90s), confirm via:

```bash
curl -sS https://foxify-pilot-new.onrender.com/volume-cover/health | jq '.config.flags | {antibot_layer1Enabled, prG_tickSpacing}'
curl -sS -H "x-admin-token: $LIVE_TOKEN" https://foxify-pilot-new.onrender.com/pilot/admin/circuit-breaker | jq '.config.enforce'
```

Expected:
- `antibot_layer1Enabled: false`
- `prG_tickSpacing.minMs: 15000` and `minBtcUsdc: 100`
- `enforce: false`

### 8.3 Foxify error → fix table

When Foxify CTO reports any of these errors, the response is in this
table. The first column is the literal `reason` field on the 4xx/5xx
response body.

| Error reason | What it means | Fix (in priority order) |
|---|---|---|
| `circuit_breaker_active` | Pilot breaker tripped on Deribit drawdown | Add `PILOT_CIRCUIT_BREAKER_ENFORCE=false` (8.1). Until then, manual reset via `POST /pilot/admin/circuit-breaker/reset`. |
| `tick_spacing_violation` | Same-cell reopen too soon after prior open | Wait the `retryAfterMs` shown in the response. Persistent: lower `VC_TICK_SPACING_MIN_MS` (8.1). |
| `venue_book_thin` | Bullish orderbook depth < gate threshold on ≥1 leg | (1) Retry in 30s — books refill. (2) If recurring on 1-day expiry: bias to 2-day via spread builder fix (Bundle 5 candidate). (3) Last resort: `VC_SPREAD_DEPTH_RATIO_REQUIRED=0.4` (still better than no-gate, see Bundle 4 orphan handling below). |
| `volume_cover_spread_open_failed: leg_*_Reached max leverage` | Bullish margin engine rejected a short leg open | Fund Bullish account; verify `marketRiskUSD < totalCollateralUSD` via `/admin/bullish-list-accounts`. Bundle 4 ensures any partial fill is captured as an orphan and not silently lost. |
| `manual_halt_active` | Operator paused Volume Cover via `/admin/manual-halt` | Resume via `POST /admin/manual-halt` with `{ "halt": false }`. Check why halt was triggered before resuming. |
| Any 5xx with no specific `reason` | Likely transient (Bullish API blip, Render cold-start, DB pool) | Retry once after 5s. If recurring 3+ times, capture timestamp + payload and ping Atticus on-call. |

### 8.4 Bundle 4 — orphan-leg sweep procedure (2026-05-25)

If Bullish's risk engine rejects a leg mid-sequence AND the spread
executor's hardened rollback can't unwind the already-placed legs (rare
post-Bundle-4 — was the Foxify-001 failure mode pre-Bundle-4), the
affected legs are persisted with `status='failed'` +
`metadata.rollback_failed_orphan=true` and exposed at:

```
GET /volume-cover/admin/orphan-legs
  Headers: x-admin-token: $LIVE_TOKEN
```

Returns the resolved Bullish symbol, qty, opening side, and the rollback
attempt history. Operator clears the orphan via:

1. **Manual sweep on Bullish** using `bullish-cross-account-sell`
   (SHORT-side opens needing buy-back) or `bullish-test-buy` (LONG-side
   opens needing sell-back) — same admin endpoints used in the
   2026-05-25 cleanup pass. **Note**: the rollback's REVERSE side is the
   right action (i.e., if `opened_side: long`, sell on Bullish; if
   `opened_side: short`, buy on Bullish to close).
2. **Reconcile in DB** via `POST /admin/mark-leg-failed-manual/:legId`
   with the venue order ID as `evidence`. Status flips from `failed`
   (orphan-flagged) to `failed` (cleared).

Bundle 4 health-flag visibility:

```bash
curl -sS https://foxify-pilot-new.onrender.com/volume-cover/health \
  | jq '.config.flags.bundle4_rollbackHardening'
```

Expected: `{ "enabled": true, "improvementFraction": 0, "deepCrossBpsFloor": 1000 }`.

### 8.5 Capital-state sanity check before Foxify activation

Before Foxify reopens the activate path after an outage or env tuning
push, run:

```bash
# Bullish margin health
curl -sS -H "x-admin-token: $LIVE_TOKEN" \
  https://foxify-pilot-new.onrender.com/volume-cover/admin/bullish-list-accounts \
  | jq '.raw[] | select(.tradingAccountId=="111257696062450") | {totalCollateralUSD, marketRiskUSD, freeMargin: ((.totalCollateralUSD | tonumber) - (.marketRiskUSD | tonumber))}'

# No orphans pending
curl -sS -H "x-admin-token: $LIVE_TOKEN" \
  https://foxify-pilot-new.onrender.com/volume-cover/admin/orphan-legs \
  | jq '{count, hasOrphans: (.count > 0)}'
```

Healthy state:

- `freeMargin > $500` (enough headroom for 1× `50k_2pct_1k` open)
- `count: 0` from orphan-legs
- `circuit-breaker.enforce: false` (or breaker not tripped if enforce stays on)
