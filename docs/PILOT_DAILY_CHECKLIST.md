# Pilot Daily Checklist

The simplest possible monitoring routine. **All you actually need to do.**

---

## One-time setup (5 minutes, do once)

### 1. Set environment variables permanently

Add to your `~/.zshrc` (or `~/.bashrc`):

```bash
export PILOT_API="https://foxify-pilot-new.onrender.com"
export PILOT_ADMIN_TOKEN="foxify-pilot-admin-2026"   # or whatever the real token is
setopt interactivecomments    # so pasting commented commands doesn't break
```

Then reload:

```bash
source ~/.zshrc
```

### 2. Verify the status script is in place

```bash
cd /Users/michaelwilliam/Desktop/Foxify_Collar
./scripts/pilot-status
```

Expect: green "All checks pass." If not, the script tells you exactly which check failed.

---

## Daily check (30 seconds)

**Just run this:**

```bash
./scripts/pilot-status
```

That's the entire daily routine. The script returns:
- **All green** → nothing to do
- **Yellow (`!`)** → something deserves attention but not urgent
- **Red (`✗`)** → investigate immediately

**Optional one-line version that fits in a calendar reminder:**

```bash
cd /Users/michaelwilliam/Desktop/Foxify_Collar && ./scripts/pilot-status
```

---

## Hands-off automation (5 minutes, do once)

### Set up a cron job to run the check every hour and ping you only on attention

This pings Telegram (via your existing alert webhook) only when something needs attention. Silent if everything is green.

Add to your crontab (`crontab -e`):

```cron
# Pilot status — every hour at :05; only outputs anything if checks fail
5 * * * * cd /Users/michaelwilliam/Desktop/Foxify_Collar && ./scripts/pilot-status --quiet || ./scripts/pilot-status >> /tmp/pilot-status.log 2>&1
```

What this does:
- Runs every hour
- Exits silently if all green
- If any check needs attention, runs again with full output and appends to `/tmp/pilot-status.log`

**Even simpler — Telegram on attention via existing alert webhook:**

```cron
# If any check fails, send a Telegram message via the platform's own alerting
5 * * * * cd /Users/michaelwilliam/Desktop/Foxify_Collar && ./scripts/pilot-status --quiet || curl -s -X POST -H "x-admin-token: $PILOT_ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"level":"warning","message":"hourly status check found attention items - run pilot-status locally"}' "$PILOT_API/pilot/admin/test-alert" > /dev/null
```

(You'll get a Telegram ping that says "hourly status check found attention items — run pilot-status locally". You then run `./scripts/pilot-status` to see what.)

---

## When something fires (Telegram alert arrives)

You get a Telegram notification. Two paths:

### If the alert is from the platform itself (e.g., `circuit_breaker_tripped`)

1. **Read the message** — every alert says what fired and what it means
2. **Run the status script** to see full state:
   ```bash
   ./scripts/pilot-status
   ```
3. **Look up the alert code** in the table at the bottom of this doc
4. **Take the recommended action** (or escalate)

### If the alert is from your own cron job

The cron tells you "checks need attention." Run the status script to see which:

```bash
./scripts/pilot-status
```

Then look up which check needs attention and act accordingly.

---

## Manual checks (if something feels off, in addition to the status script)

### See current open positions

```bash
curl -s -H "x-admin-token: $PILOT_ADMIN_TOKEN" \
  "$PILOT_API/pilot/protections/export?scope=open&format=json" \
  | python3 -m json.tool | head -60
```

### See recent alerts (last 20)

```bash
curl -s -H "x-admin-token: $PILOT_ADMIN_TOKEN" \
  "$PILOT_API/pilot/monitor/alerts?limit=20" \
  | python3 -m json.tool
```

### Drill into per-trade fills (slippage diagnosis)

```bash
curl -s -H "x-admin-token: $PILOT_ADMIN_TOKEN" \
  "$PILOT_API/pilot/admin/diagnostics/per-trade-fills?limit=20" \
  | python3 -m json.tool
```

### Reset a tripped circuit breaker

Only if you've investigated and decided it's safe to resume:

```bash
curl -X POST -H "x-admin-token: $PILOT_ADMIN_TOKEN" \
  "$PILOT_API/pilot/admin/circuit-breaker/reset"
```

---

## Render logs (when you need depth)

Web UI: https://dashboard.render.com → your service → Logs

Search prefixes that matter most:
- `[CircuitBreaker]` — breaker activity
- `[HedgeManager]` — TP cycles, sales, errors
- `[AutoRenew]` — renewal cycles, freezes
- `[AlertDispatcher]` — alert send results, including failures with detail
- `[PricingRegime]` — regime transitions
- `[Activate]` — new protection activations
- `WARN` or `ERROR` — anything noteworthy

---

## Alert codes you might receive (keep this handy)

| Code | Severity | What it means | What to do |
|---|---|---|---|
| `circuit_breaker_tripped` | critical | Deribit equity dropped > 50% in 24h | Investigate immediately; see incident playbook in `docs/GO_TO_PRODUCTION_RUNBOOK.md` |
| `trigger_monitor_price_errors` | critical | 10+ consecutive price-feed errors | Check Deribit/Coinbase status pages |
| `trigger_monitor_cycle_error` | critical | Trigger-monitor scheduler crashed | Restart Render service, inspect logs |
| `fill_circuit_breaker` | critical | 5+ consecutive hedge fill failures | Hedging impaired; check Deribit health |
| `treasury_critical` | critical | Treasury below floor | Top up |
| `hedge_no_spot` | warning | Deribit getIndexPrice failed once | Often transient; investigate if persistent |
| `negative_spread` | warning | A hedge cost more than premium received | Investigate the trade |
| `fill_failure` | warning | Hedge fill failed | Often transient; investigate if multiple |
| `treasury_low` | warning | Treasury below comfort threshold | Schedule top-up |
| `trigger_fired` | info | A protection triggered | Informational |
| `circuit_breaker_manual_reset` | info | You reset the breaker | Confirms your action |

---

## Pilot end (Day 28)

```bash
# 1. Stop new sales — set in Render env, restart:
#    PILOT_ACTIVATION_ENABLED=false

# 2. Wait 24-48h for open protections to expire/settle

# 3. Final reconciliation
curl -s -H "x-admin-token: $PILOT_ADMIN_TOKEN" \
  "$PILOT_API/pilot/admin/metrics?scope=all" | python3 -m json.tool

# 4. Final snapshot
cd services/api && npm run pilot:phase0:live-analysis
```

---

## Troubleshooting

### `./scripts/pilot-status` says "PILOT_ADMIN_TOKEN not set"

```bash
export PILOT_ADMIN_TOKEN="<your token>"
```

For permanence, add the export to `~/.zshrc`.

### Status script shows "circuit breaker armed but no balance samples yet"

This is a known signal: the circuit breaker can't read your Deribit account balance. Causes:
1. Deribit credentials are testnet keys (no permission to call mainnet account_summary)
2. The hedge-management cycle is failing silently — check Render logs for `[CircuitBreaker]` warnings
3. Deribit API outage

Not a launch blocker if you haven't activated live trading yet. Becomes critical once you have real funds at risk.

### Telegram alerts stop arriving

```bash
# Verify dispatcher routes are still configured
curl -X POST -H "x-admin-token: $PILOT_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"level":"warning","message":"manual ping"}' \
  "$PILOT_API/pilot/admin/test-alert"
```

If no Telegram message arrives, check Render logs for `[AlertDispatcher]` lines. PR #66 captures the failure detail in the log so you can see exactly why Telegram refused (chat not found, unauthorized, etc.).

### Render service restart needed

Render dashboard → Service → Manual Deploy → Restart Service. Use after env var changes or if the platform feels stuck.

---

*Designed to be the entire operational guide for the 28-day pilot. Print or pin it; you should not need anything else day-to-day.*
