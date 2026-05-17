# Volume Cover Operations Runbook

**Audience:** Atticus operator (you).
**Scope:** Day-to-day operation of the Volume Cover product during the Foxify pilot.

---

## Quick reference

| Need to... | Do |
|---|---|
| **Pre-flight check before cutover** | `npx tsx services/api/scripts/volume-cover/preflight-check.ts` |
| See live state | `GET /volume-cover/admin/dashboard` (markdown) |
| Pull daily report | `GET /volume-cover/admin/foxify-report?date=YYYY-MM-DD` |
| Check salvage stats | `GET /volume-cover/admin/salvage-stats` |
| **Pair-event audit log** | `GET /volume-cover/admin/pair-events?limit=100` |
| **Latency P50/P95/P99** | `GET /volume-cover/admin/pair-event-stats?windowHours=24` |
| **Weekly settlement** | `GET /volume-cover/admin/weekly-settlement?week=2026-W21` |
| Disable a cell | `POST /volume-cover/admin/cells/<cellId>/toggle` `{ "enabled": false }` |
| Raise per-cell throttle | `POST /volume-cover/admin/cells/<cellId>/toggle` `{ "throttleMaxPerDay": 30 }` |
| Adjust cell premium (calm hot-fix) | `POST /volume-cover/admin/cells/<cellId>/toggle` `{ "dailyPremiumUsdc": 425 }` |
| HALT all activations | `POST /volume-cover/admin/halt` `{ "reason": "<why>" }` |
| Resume after halt | `POST /volume-cover/admin/halt/clear` `{}` |
| Force trigger detector cycle | `POST /volume-cover/admin/trigger-detector/run` |
| Force hedge manager tick | `POST /volume-cover/admin/hedge-manager/run?dryRun=true` |
| Close a position manually | `POST /volume-cover/admin/positions/:id/close` `{ "reason": "..." }` |

All admin endpoints require `X-Admin-Token: $PILOT_ADMIN_TOKEN` header.

---

## Spot price source-of-truth

**Primary:** Bullish hybrid orderbook (BTCUSDC) — top-of-book bid/ask mid.
**Fallback:** Coinbase BTC-USD spot (auto-engages when Bullish API unavailable).

Why Bullish primary: zero-basis between trigger detection and hedge execution venue.

**Drift detection:** if Bullish vs Coinbase diverge >50bp, console.warn fires (cooldown 60s). Operator review recommended; >100bp warrants halt + investigation.

Source visible in `/admin/pair-events` per-event `metadata.source` field.

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
VOLUME_COVER_TRIGGER_DETECTOR_TICK_MS=3000   # 3s default; tighten to 1000-2000 if Foxify reports detection lag

# Background chain warmer (always-warm venue strike grid cache)
VOLUME_COVER_CHAIN_WARM_ENABLED=true
VC_CHAIN_WARM_TICK_MS=30000

# Anti-bot — for CEO test pilot, Layer 1 (same-cell repeat block)
# would prevent the bot's expected "Repeat" flow at 50k_2pct_1k.
# DISABLE Layer 1 for the test pilot. Re-enable for multi-trader rollout.
VOLUME_COVER_ANTIBOT_LAYER1_ENABLED=false   # !!! pilot-only; re-enable for prod multi-trader
VOLUME_COVER_ANTIBOT_LAYER2_ENABLED=true    # cooldown still active (jitter dampens any rapid-fire bug)
VOLUME_COVER_ANTIBOT_LAYER3_ENABLED=true    # post-trigger cooldown still useful
VOLUME_COVER_ANTIBOT_LAYER4_ENABLED=true    # surcharge still useful

# VC-specific stress regime pause (DVOL >= threshold)
VC_STRESS_PAUSE_ENABLED=true
VC_STRESS_PAUSE_DVOL_THRESHOLD=80


# Hedge manager TP curve (full 12-rule); env-tunable per rule
VOLUME_COVER_HEDGE_MANAGER_ENABLED=true
VC_HM_USE_STUB=false                # set true to fall back to 4-rule stub if full curve misbehaves
VC_HM_TICK_MS=60000
VC_HM_FALLBACK_IV=0.65              # used only when deribitIvCache returns its own fallback

# Hedge tenor + sizing
# (no env knob; see services/api/src/volumeCover/tightHedge.ts)
VC_VOL_BUFFER_ENABLED=true

# Regime overlay pricing (CEO-approved per backtest, calm locked at base)
VC_REGIME_OVERLAY_JSON='{"50k_2pct_1k":{"moderate":420,"elevated":525},"50k_5pct_2_5k":{"moderate":240,"elevated":300},"50k_10pct_5k":{"moderate":120,"elevated":150},"200k_5pct_10k":{"moderate":960,"elevated":1200},"200k_10pct_20k":{"moderate":480,"elevated":600},"200k_15pct_30k":{"moderate":444,"elevated":555}}'
# (stress key intentionally omitted — VC_STRESS_PAUSE auto-halts at DVOL >= 80)

# Loss kill-switch (tighter for first 48h; raise to 5000 after Day-1-3 review)
VOLUME_COVER_GUARD_LOSS_KILL_USDC=1000

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

## CEO test pilot — critical env settings (2026-05-16)

Per CEO-clarified flow: bot calls `/activate` → we hedge → bot opens
perps. The bot will repeat the same 50k_2pct_1k cell over and over.

**Critical env adjustments for the CEO test pilot:**

```
# Disable Layer 1 — same-cell repeat block would block the CEO's
# expected "Repeat" flow at 50k_2pct_1k. Layers 2-4 stay active.
VOLUME_COVER_ANTIBOT_LAYER1_ENABLED=false

# Tighter trigger detector cadence — Foxify perps fire SL near-instant
# on their venue; 3s default closes the perceived "where's the
# payout" gap. Drop to 1000-2000ms if CEO reports lag.
VOLUME_COVER_TRIGGER_DETECTOR_TICK_MS=3000

# Tight loss kill-switch first 48h
VOLUME_COVER_GUARD_LOSS_KILL_USDC=1000

# Throttle for safety (CEO will likely run multiple per hour, but
# capped initially while live data accumulates)
# (per-cell throttle set via DB, not env; default 5/day from matrix.ts)
```

**Re-enable Layer 1 for production multi-trader rollout.**
**Raise loss kill to $5000 after Day-1-3 review.**

## Pre-launch checklist

Run through this before flipping `VOLUME_COVER_ENABLED=true` in Render:

- [ ] `PILOT_ADMIN_TOKEN` set in Render env, value matches your local copy
- [ ] `FOXIFY_API_KEY_HMAC_SECRET` set in Render env, secret printed and physically delivered to Foxify CEO
- [ ] DB migration completed: `npm run migrate:pilot` (creates `volume_cover_*` tables, seeds 6 cells with `enabled=true, throttleMaxPerDay=5`)
- [ ] `GET /volume-cover/health` returns 200 with `cellsConfigured: 6, cellsEnabled: 6`
- [ ] `GET /volume-cover/admin/cells` returns all 6 cells with admin token
- [ ] Quote test from Foxify-side: HMAC-signed `POST /volume-cover/quote` returns a valid price
- [ ] Trigger detector logs visible in Render logs: `[VolumeCover] Trigger detector started`

## Day 1 launch sequence (final, post-2026-05-16 hardening)

### Step 1 — provision credentials (BEFORE deploy)

**Bullish API keys** (operator generates in Bullish dashboard → API Keys):
- `PILOT_BULLISH_PUBLIC_KEY`  (PEM format, ECDSA)
- `PILOT_BULLISH_PRIVATE_KEY` (PEM format — NEVER commit, NEVER log)
- `PILOT_BULLISH_METADATA`    (base64 metadata blob from Bullish)

**Foxify HMAC secret** (operator generates one time):
```bash
openssl rand -hex 32
# Output: e.g., "8f3a9b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a"
```
Set as `FOXIFY_API_KEY_HMAC_SECRET` in Render. Share the same value with Foxify CEO/dev in person or via secure channel — NEVER email or chat.

**Atticus admin token**:
```bash
openssl rand -hex 32
```
Set as `PILOT_ADMIN_TOKEN`. Operator keeps this private; used to call admin endpoints.

### Step 2 — set Render env (full block)

```
# Required
VOLUME_COVER_ENABLED=true
PILOT_ADMIN_TOKEN=<from Step 1>
FOXIFY_API_KEY_HMAC_SECRET=<from Step 1>
POSTGRES_URL=<existing pilot DB connection>
PILOT_BULLISH_ENABLED=true
PILOT_BULLISH_PUBLIC_KEY=<from Step 1>
PILOT_BULLISH_PRIVATE_KEY=<from Step 1>
PILOT_BULLISH_METADATA=<from Step 1>
DERIBIT_ENV=live
DERIBIT_PAPER=false

# CEO-approved regime overlay pricing (paste exactly)
VC_REGIME_OVERLAY_JSON='{"50k_2pct_1k":{"moderate":420,"elevated":525},"50k_5pct_2_5k":{"moderate":240,"elevated":300},"50k_10pct_5k":{"moderate":120,"elevated":150},"200k_5pct_10k":{"moderate":960,"elevated":1200},"200k_10pct_20k":{"moderate":480,"elevated":600},"200k_15pct_30k":{"moderate":444,"elevated":555}}'

# Stress regime auto-pause at DVOL>=80
VC_STRESS_PAUSE_ENABLED=true
VC_STRESS_PAUSE_DVOL_THRESHOLD=80

# Trigger detector cadence (3s for fast detection)
VOLUME_COVER_TRIGGER_DETECTOR_ENABLED=true
VOLUME_COVER_TRIGGER_DETECTOR_TICK_MS=3000

# Hedge manager (full 12-rule TP curve)
VOLUME_COVER_HEDGE_MANAGER_ENABLED=true
VC_HM_USE_STUB=false
VC_HM_TICK_MS=60000
VC_HM_FALLBACK_IV=0.65

# Sizing
VC_VOL_BUFFER_ENABLED=true

# Background chain warmer (always-warm cache)
VOLUME_COVER_CHAIN_WARM_ENABLED=true
VC_CHAIN_WARM_TICK_MS=30000

# Anti-bot Layers (all 4 active for live multi-trader; Layer 1 disabled
# only for CEO-bot-only test pilot — re-enable for prod multi-trader rollout)
VOLUME_COVER_ANTIBOT_LAYER1_ENABLED=true
VOLUME_COVER_ANTIBOT_LAYER2_BASE_MS=60000
VOLUME_COVER_ANTIBOT_LAYER2_JITTER_MS_MAX=300000
VOLUME_COVER_ANTIBOT_LAYER3_ENABLED=true
VOLUME_COVER_ANTIBOT_LAYER3_COOLDOWN_MS=14400000
VOLUME_COVER_ANTIBOT_LAYER4_ENABLED=true

# Risk caps (tighter for first 48h; raise after Day-1-3 review)
VOLUME_COVER_GUARD_LOSS_KILL_USDC=1000
VOLUME_COVER_GUARD_LOSS_KILL_ENABLED=true
VOLUME_COVER_GUARD_SALVAGE_THROTTLE_ENABLED=true
VOLUME_COVER_GUARD_TRIGGER_SURGE_ENABLED=true
```

### Step 3 — DB seed (auto-runs on boot)

`ensureVolumeCoverSchema` + `seedVolumeCoverCellsIfNeeded` run on startup. Seeds 6 cells with default base prices + `enabled=true`. Operator can disable cells they don't want active:

```bash
# Example: disable everything except 50k_2pct_1k for CEO test pilot
curl -X POST -H "X-Admin-Token: $TOKEN" \
  "${BASE}/volume-cover/admin/cells/50k_5pct_2_5k/toggle" \
  -d '{"enabled": false}'
# Repeat for 50k_10pct_5k, 200k_5pct_10k, 200k_10pct_20k, 200k_15pct_30k
```

CEO will start with **2 × 50k_2pct_1k pairs**. Set throttle:

```bash
curl -X POST -H "X-Admin-Token: $TOKEN" \
  "${BASE}/volume-cover/admin/cells/50k_2pct_1k/toggle" \
  -d '{"throttleMaxPerDay": 2}'
```

### Step 4 — pre-flight smoke (BEFORE flipping ENABLED=true)

```bash
PILOT_API_BASE=https://staging.atticus-platform.com \
PILOT_ADMIN_TOKEN=<token> \
npx tsx services/api/scripts/volume-cover/preflight-check.ts
```

Expect GREEN verdict. If YELLOW: review warnings, decide whether safe. If RED: fix issues, do NOT cut over.

Repeat against production URL after Render auto-deploy.

### Step 5 — share Foxify HMAC + endpoint URL with CEO

Share with Foxify CEO/dev:
- Endpoint: `https://<production-url>/volume-cover/activate`
- HMAC secret (the one from Step 1)
- Signing scheme: see `docs/foxify-pilot-bundle-c/api.md`
- Cell ID: `50k_2pct_1k`
- Initial throttle: 2 pairs/day

### Step 6 — first cover under operator watch

CEO bot opens first 50k_2pct_1k pair. Operator watches:
- `/volume-cover/admin/pair-events?limit=10` for activation timing
- `/volume-cover/admin/positions?status=active` for position state
- Render logs for any warnings/errors
- Bullish account UI for actual hedge fill

If anything looks wrong: `POST /volume-cover/admin/halt`. Investigate. Resume only when confident.

### Step 7 — first 4-hour close watch

- Operator monitors every 30 minutes
- Any auto-halt → page CEO within 10 minutes
- Compare actual P&L (from pair-event audit log) to backtest projection

### Step 8 — Day-1-3 review

After 3 days of live trades:
- Pull `/volume-cover/admin/pair-event-stats?windowHours=72`
- Pull `/volume-cover/admin/weekly-settlement?week=<current>`
- Compare per-cover avg P&L to backtest 24_BACKTEST_HARNESS_REVISED_REPORT.md
- If aligned: raise loss kill `VOLUME_COVER_GUARD_LOSS_KILL_USDC=5000`
- If divergent >25%: halt, audit, retune before continuing

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
