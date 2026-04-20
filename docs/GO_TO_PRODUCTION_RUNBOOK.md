# Atticus Pilot — Go-to-Production Runbook

**Audience:** the operator (you) standing up the platform for the live Foxify pilot.
**Last updated:** 2026-04-20.
**Companion docs:** `PILOT_TECHNICAL_GUIDE.md` (architecture + behavior reference), `cfo-report/Atticus_Foxify_Pilot_CFO_Report.md` (economics).

This runbook is a chronological checklist. Each section answers "what action do I take, what evidence confirms it worked, what to do if it didn't."

---

## Pre-flight inventory

Before flipping anything live, confirm you have all of:

| Item | Source | Where it lives | Status check |
|---|---|---|---|
| Deribit live API key + secret | Deribit account → API Management | Render env: `DERIBIT_API_KEY`, `DERIBIT_API_SECRET` | `curl -s "https://foxify-pilot-new.onrender.com/pilot/health" | python3 -m json.tool` shows `venue.mode = deribit_live` and `session = ok` |
| $10,000 USD-equivalent BTC funded on Deribit | Deribit account → Deposit | Deribit balance | `curl -s -H "x-admin-token: $PILOT_ADMIN_TOKEN" "https://foxify-pilot-new.onrender.com/pilot/admin/circuit-breaker"` returns `state.currentBtc` ≈ funded amount in BTC |
| Admin token | Render env: `PILOT_ADMIN_TOKEN` | shell `$PILOT_ADMIN_TOKEN` env | `curl -s -H "x-admin-token: $PILOT_ADMIN_TOKEN" "https://foxify-pilot-new.onrender.com/pilot/regime"` returns `status: ok` |
| Telegram (or other) alert webhook | See "Alert webhook setup" below | Render env: `PILOT_ALERT_TELEGRAM_*` | `POST /pilot/admin/test-alert` — message lands in Telegram |
| Foxify CEO has the widget URL | n/a | n/a | n/a |
| Pilot Agreement signed | Legal | n/a | n/a |
| KYC complete on Deribit | Deribit | n/a | live API key works |

If any "Status check" doesn't pass, **stop and fix it before continuing.**

---

## Step 1 — Configure Render env for production

The platform reads all of these on boot. Edit them in Render → Service → Environment, then **manually restart** the service so they take effect.

### Required (must be set before flipping live)

```bash
PILOT_API_ENABLED=true
PILOT_ACTIVATION_ENABLED=true
PILOT_VENUE_MODE=deribit_live
DERIBIT_API_KEY=<from Deribit>
DERIBIT_API_SECRET=<from Deribit>
PILOT_ADMIN_TOKEN=<long random string>
POSTGRES_URL=<Render internal Postgres URL>

V7_PRICING_ENABLED=true
V7_DEFAULT_TENOR_DAYS=1
```

### Pilot Agreement caps (Days 1-7 values)

```bash
PILOT_MAX_PROTECTION_NOTIONAL_USDC=50000
PILOT_MAX_DAILY_PROTECTED_NOTIONAL_USDC=100000
PILOT_MAX_AGGREGATE_ACTIVE_NOTIONAL_USDC=200000
PILOT_PER_TIER_DAILY_CAP_PCT=0.6
PILOT_CAP_ENFORCEMENT_MODE=enforce
```

**On Day 8 of the pilot, bump:**
```bash
PILOT_MAX_DAILY_PROTECTED_NOTIONAL_USDC=500000
```

### Defensive guards (PR B)

```bash
PILOT_CIRCUIT_BREAKER_ENFORCE=true
PILOT_CIRCUIT_BREAKER_MAX_LOSS_PCT=0.5
PILOT_CIRCUIT_BREAKER_COOLDOWN_MS=14400000
# Auto-renew freeze (Gap 4) is on by default; nothing to set unless you want
# to override:
# PILOT_AUTO_RENEW_STRESS_ALLOWED=true
```

### Active TP gaps (PR C — observe-only by default)

Leave these unset for the first 1–2 weeks of pilot. After reviewing the OBSERVE-only logs, decide whether to flip ENFORCE on:

```bash
# After observe-only data review, optionally:
# PILOT_TP_GAP1_ENFORCE=true
# PILOT_TP_GAP3_ENFORCE=true
```

### Alerts

See "Alert webhook setup" section below. At minimum, set Telegram OR Slack OR Discord OR Generic.

---

## Step 2 — Alert webhook setup

The dispatcher (`services/api/src/pilot/alertDispatcher.ts`) supports four destination types. Pick at least one.

### Telegram (recommended for solo operators)

1. Open a chat with `@BotFather` on Telegram. Send `/newbot`. Follow prompts; copy the bot token (looks like `123456:ABC-DEF...`).
2. Open a chat with `@userinfobot` to get your numeric chat ID. (Or add the new bot to a group / channel and use that chat's ID.)
3. Add to Render env:
   ```bash
   PILOT_ALERT_TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
   PILOT_ALERT_TELEGRAM_CHAT_ID=NNNNNNNNNN
   PILOT_ALERT_TELEGRAM_LEVELS=warning,critical
   ```
4. Restart Render service.
5. Test:
   ```bash
   curl -X POST -H "x-admin-token: $PILOT_ADMIN_TOKEN" -H "Content-Type: application/json" \
     -d '{"level":"warning","message":"alert test"}' \
     "https://foxify-pilot-new.onrender.com/pilot/admin/test-alert"
   ```
   You should see the message in Telegram within ~1 second. If you don't, check `PILOT_ALERT_TELEGRAM_BOT_TOKEN` and `PILOT_ALERT_TELEGRAM_CHAT_ID` are correct, and that you've sent at least one message to the bot first (Telegram requires this).

### Slack

1. `https://api.slack.com/apps` → Create App → Incoming Webhooks → enable → Add to workspace → pick channel → copy URL.
2. Render env:
   ```bash
   PILOT_ALERT_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T.../B.../...
   PILOT_ALERT_SLACK_LEVELS=warning,critical
   ```
3. Restart, test as above.

### Discord

1. Discord channel → Settings → Integrations → Webhooks → New Webhook → copy URL.
2. Render env:
   ```bash
   PILOT_ALERT_DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/.../...
   PILOT_ALERT_DISCORD_LEVELS=warning,critical
   ```
3. Restart, test as above.

### Generic webhook (PagerDuty, Opsgenie, custom)

```bash
PILOT_ALERT_GENERIC_WEBHOOK_URL=https://your-endpoint
PILOT_ALERT_GENERIC_AUTH_HEADER=Bearer xyz   # optional
PILOT_ALERT_GENERIC_LEVELS=critical
```

### What you'll get paged on

| Code | Level | Meaning | Action required |
|---|---|---|---|
| `circuit_breaker_tripped` | critical | Deribit equity drawdown > 50% over 24h | Investigate immediately. Check Deribit account, recent fills, current spot. May need to `POST /pilot/admin/circuit-breaker/reset` after diagnosing. |
| `trigger_monitor_price_errors` | critical | 10+ consecutive Deribit/Coinbase price-feed errors | Check Deribit + Coinbase status pages. Restart Render if needed. |
| `trigger_monitor_cycle_error` | critical | Trigger-monitor scheduler crashed | Restart Render service. Inspect Render logs for stack trace. |
| `fill_circuit_breaker` | critical | 5+ consecutive hedge fill failures | Hedging is impaired. Check Deribit health, account state, balance. |
| `treasury_critical` | critical | Treasury below floor (post-pilot) | Top up. |
| `hedge_no_spot` | warning | Deribit `getIndexPrice` failed once or more | Often transient. Investigate if persistent. |
| `negative_spread` | warning | A hedge cost more than premium received | Investigate the trade; pricing or selection may need review. |
| `fill_failure` | warning | Hedge fill failed | Often transient. Investigate if multiple. |
| `treasury_low` | warning | Treasury below comfort threshold (post-pilot) | Schedule top-up. |
| `trigger_fired` | info | A protection triggered | Informational; verify TP system handles it. |

**Recommendation:** filter to `warning,critical` (skip `info`) so you're not paged for routine events.

---

## Step 3 — Pre-launch verification

Run all five and confirm output. If any fails, **do not launch.**

### 3.1 Health
```bash
curl -s "https://foxify-pilot-new.onrender.com/pilot/health" | python3 -m json.tool
```
Expect: `status: ok`, `venue.mode: deribit_live`, `session: ok`.

### 3.2 Pricing regime + tier alignment
```bash
curl -s -H "x-admin-token: $PILOT_ADMIN_TOKEN" \
  "https://foxify-pilot-new.onrender.com/pilot/regime" | python3 -m json.tool
```
Expect: `pricingRegimeLabel` (e.g., "Low") matches what the schedule predicts. The `tiers[]` array should be the matching schedule for that regime:
- Low: `[6, 5, 3, 2]`
- Moderate: `[7, 5.5, 3, 2]`
- Elevated: `[8, 6, 3.5, 2]`
- High: `[9, 7, 4, 2]`

### 3.3 Circuit breaker idle
```bash
curl -s -H "x-admin-token: $PILOT_ADMIN_TOKEN" \
  "https://foxify-pilot-new.onrender.com/pilot/admin/circuit-breaker" | python3 -m json.tool
```
Expect: `state.tripped: false`, `config.enforce: true`, `state.currentBtc` non-null and matching your funded balance.

### 3.4 Caps configured to agreement values
```bash
curl -s -H "x-admin-token: $PILOT_ADMIN_TOKEN" \
  "https://foxify-pilot-new.onrender.com/pilot/admin/metrics?scope=open" | python3 -m json.tool | head -30
```
Expect: returns metrics. Verify in Render env that `PILOT_MAX_*` variables match agreement.

### 3.5 Alert webhook works
```bash
curl -X POST -H "x-admin-token: $PILOT_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"level":"warning","message":"go-live verification ping"}' \
  "https://foxify-pilot-new.onrender.com/pilot/admin/test-alert"
```
Expect: message lands in your configured destination within ~1s.

---

## Step 4 — Smoke test (one real trade)

Buy one minimal protection through the widget OR via curl, watch it through to completion.

### 4.1 Place a small trade through the widget
- Open the widget URL
- Position size: $5,000 (smallest meaningful)
- SL: 10% (lowest trigger probability — safest first trade)
- Click "Open + Protect"
- Verify: widget shows the protection in "Active Positions"

### 4.2 Verify the hedge landed on Deribit
```bash
curl -s -H "x-admin-token: $PILOT_ADMIN_TOKEN" \
  "https://foxify-pilot-new.onrender.com/pilot/protections/export?scope=open&format=json" \
  | python3 -m json.tool | head -40
```
Expect: 1 row with `status: active`, `instrument_id` populated (e.g. `BTC-21APR26-92000-P`), `external_order_id` populated.

### 4.3 Verify execution quality recorded
```bash
curl -s -H "x-admin-token: $PILOT_ADMIN_TOKEN" \
  "https://foxify-pilot-new.onrender.com/pilot/admin/diagnostics/execution-quality" \
  | python3 -m json.tool
```
Expect: 1 row showing fill price, slippage, latency.

### 4.4 Watch hedge management cycle
Check Render logs for `[HedgeManager] Cycle complete:` lines. Should appear every 60s. Confirms the scheduler is running.

### 4.5 If you want to test the full lifecycle
Wait for natural expiry (~24h) OR simulate trigger by manually adjusting BTC price in your test scenario. The platform will:
- Mark protection `triggered` → `expired_otm` (if no trigger) OR `triggered` → TP sells hedge → `expired_settled`
- Insert ledger entries
- Auto-renew if enabled

---

## Step 5 — During-pilot operational duties

### Daily

- **Check Render logs for [CircuitBreaker] / [HedgeManager] / [AutoRenew] lines.** Anything labeled WARN or ERROR deserves attention.
- **Check Telegram (or your alert channel) for any pages.**
- **Spot-check `/pilot/admin/metrics`** to confirm aggregate active is within caps.

### Weekly

- **Run the analysis script** to snapshot pilot state:
  ```bash
  cd services/api && npm run pilot:phase0:live-analysis
  ```
  Compare to previous snapshots. Look for trends in trigger rate, margin %, TP recovery.
- **Review `Gap 1 OBSERVE` and `Gap 3 OBSERVE` log counts** to gather calibration data on the active TP gaps.

### Day 8

- Bump `PILOT_MAX_DAILY_PROTECTED_NOTIONAL_USDC` to `500000` per Pilot Agreement §3.1.

### Pilot end (Day 28)

- Run final `pilot:phase0:live-analysis` snapshot
- Reconcile premium/payout totals manually via admin dashboard
- Generate net settlement amount per Pilot Agreement
- Wire net settlement to/from Foxify

---

## Step 6 — Incident response

### Circuit breaker tripped

You receive a `circuit_breaker_tripped` Telegram/Slack page. The platform has automatically blocked new protection sales. Existing positions are unaffected.

1. **Investigate**:
   ```bash
   curl -s -H "x-admin-token: $PILOT_ADMIN_TOKEN" \
     "https://foxify-pilot-new.onrender.com/pilot/admin/circuit-breaker" | python3 -m json.tool
   ```
   Look at `state.baselineBtc`, `state.currentBtc`, `state.lossPct`, and `state.trippedAt`.

2. **Diagnose the loss**:
   - Check Render logs for recent `[HedgeManager]` errors
   - Check `/pilot/protections/export?scope=open` for triggered positions that may have settled with adverse P&L
   - Check Deribit account directly for unexpected fills

3. **Decide**:
   - If the loss is real and within acceptable bounds → manual reset:
     ```bash
     curl -X POST -H "x-admin-token: $PILOT_ADMIN_TOKEN" \
       "https://foxify-pilot-new.onrender.com/pilot/admin/circuit-breaker/reset"
     ```
   - If something unexpected → keep blocked, investigate further. The breaker auto-resets after 4h regardless; if you want it to stay tripped longer, set `PILOT_CIRCUIT_BREAKER_COOLDOWN_MS=0` in Render env.

### Trigger-monitor consecutive errors

You receive `trigger_monitor_price_errors`. Coinbase or Deribit price feed is failing.

1. Check status pages:
   - Deribit: https://status.deribit.com/
   - Coinbase: https://status.coinbase.com/
2. Check Render logs for the underlying error (e.g., HTTP 503, network timeout).
3. If a single source is down, the platform falls back to the other automatically — alert may auto-clear. If both are down, no new triggers are detected during the outage. Existing protections continue to monitor for triggers when the feeds recover.

### Cap accidentally exceeded (shouldn't happen — caps are atomic)

If somehow you observe aggregate active > $200k:

1. Use `POST /pilot/admin/test-reset-protections` to retire excess test protections (preserves audit data)
2. Investigate via `pilot_admin_actions` log how the cap was bypassed
3. Alert me / file a critical issue

### Deribit auth failure

You see `unauthorized` errors in Render logs.

1. Verify Deribit API key + secret in Render env match what's active in Deribit account
2. Check Deribit IP allowlist (if enabled) includes the Render egress IP
3. Restart Render service after fixing

---

## Step 7 — Pilot exit / handoff

When the 28-day pilot is complete:

1. **Stop new sales**: set `PILOT_ACTIVATION_ENABLED=false` in Render env, restart. Existing protections continue to run to completion.
2. **Wait for all open protections to expire or settle** (~24-48h).
3. **Final reconciliation**:
   ```bash
   curl -s -H "x-admin-token: $PILOT_ADMIN_TOKEN" \
     "https://foxify-pilot-new.onrender.com/pilot/admin/metrics?scope=all" | python3 -m json.tool
   ```
   Note: `clientPremiumTotalUsdc`, `payoutSettledTotalUsdc`, `netSettledCashUsdc`.
4. **Generate the final settlement report** (manual: read the JSON, populate the agreed-upon settlement template).
5. **Wire net settlement amount** to/from Foxify per agreement.
6. **Archive pilot snapshot** for post-pilot review:
   ```bash
   cd services/api && npm run pilot:phase0:live-analysis
   ```
7. **Disable auto-restart**: turn off the cron / scheduled tasks that would keep restarting the platform.

---

## Step 8 — Where to find more detail

- **Architecture & internals**: `docs/PILOT_TECHNICAL_GUIDE.md`
- **Economics & pricing math**: `docs/cfo-report/Atticus_Foxify_Pilot_CFO_Report.md`
- **Pilot agreement**: `docs/FOXIFY_PILOT_AGREEMENT.md`
- **Production transition long-form**: `docs/MAINNET_TRANSITION.md`
- **Pre-flight smoke test (longer form)**: `docs/pilot-reports/R8_live_deribit_smoke_test_runbook.md`
- **Incident playbook (older format)**: `docs/INCIDENT_RUNBOOK.md`
- **Phase 3 cutover gates**: `docs/phase-3-cutover.md`

---

## Quick-reference command cheat sheet

```bash
# Set once per shell session
export PILOT_API="https://foxify-pilot-new.onrender.com"
export PILOT_ADMIN_TOKEN="<your token>"

# Health + regime + caps
curl -s "$PILOT_API/pilot/health" | python3 -m json.tool
curl -s -H "x-admin-token: $PILOT_ADMIN_TOKEN" "$PILOT_API/pilot/regime" | python3 -m json.tool
curl -s -H "x-admin-token: $PILOT_ADMIN_TOKEN" "$PILOT_API/pilot/admin/circuit-breaker" | python3 -m json.tool

# Open protections (admin view)
curl -s -H "x-admin-token: $PILOT_ADMIN_TOKEN" "$PILOT_API/pilot/protections/export?scope=open&format=json" | python3 -m json.tool

# Metrics
curl -s -H "x-admin-token: $PILOT_ADMIN_TOKEN" "$PILOT_API/pilot/admin/metrics?scope=open" | python3 -m json.tool

# Send a test alert
curl -X POST -H "x-admin-token: $PILOT_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"level":"warning","message":"test"}' "$PILOT_API/pilot/admin/test-alert"

# Reset a tripped circuit breaker
curl -X POST -H "x-admin-token: $PILOT_ADMIN_TOKEN" "$PILOT_API/pilot/admin/circuit-breaker/reset"

# Surgical retire a list of protection IDs (preserves audit data)
curl -X POST -H "x-admin-token: $PILOT_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"protectionIds":["uuid-1","uuid-2"],"reason":"cleanup"}' \
  "$PILOT_API/pilot/admin/test-reset-protections"

# Pilot snapshot (locally)
cd services/api && npm run pilot:phase0:live-analysis
```

---

*End of runbook. Update this document as operational issues are discovered and fixed.*
