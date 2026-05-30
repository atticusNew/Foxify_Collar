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
| `GET`  | `/volume-cover/positions/:positionId` | Look up an active position |
| `POST` | `/volume-cover/positions/:positionId/close` | Close a position (refund tail premium) |

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
  "fingerprintHash": "optional opaque hash for anti-bot"
}
```
- Server validates `pairEntryBtcPrice` is within 1% of live spot. Larger drift → 400 `entry_price_drift_too_high`.
- `foxifyPairId` is the idempotency key. Re-sending the same `foxifyPairId` returns the existing position.

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
    { "id": "vc-leg-<uuid>", "venue": "deribit", "optionKind": "put",  "strikeUsdc": 76032 },
    { "id": "vc-leg-<uuid>", "venue": "deribit", "optionKind": "call", "strikeUsdc": 77568 }
  ],
  "salvageState": "healthy"
}
```

### 2.5 Common error codes

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

### 2.6 Reference curl with HMAC signing (bash)

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

## 6. Quick "who do I call" reference

- **Activate returns 201 but no leg row in DB / Deribit**: that's the atomicity bug we patched on 2026-05-19. Should not happen. If it does, check the `[VC ALERT]` log for `compensating sell FAILED — orphan venue leg`.
- **Activate returns 500 `hedge_execution_failed`**: Deribit refused the order. Check `deribit-auth-test` and Deribit dashboard for venue health. Position is marked closed; no leg row was created; no charge.
- **A leg shows `status: open` in DB but no position on the venue UI**: phantom. Run `force-sell-leg`; if it errors with `bullish_http_404` or `deribit:not_filled:unknown`, use `mark-leg-failed-manual` with the venue error as evidence.
- **A leg shows on the venue UI but no row in DB**: orphan. Sell it directly via the venue UI (or build a one-off API call). Future periodic reconciler will catch these.
- **Hedge-manager refuses to TP a leg you want sold**: check the `rule` it's firing — usually rule 2 (Asia thin window 04:00-06:00 UTC) or rule 3 (gamma zone hold). Override via `force-sell-leg`.
