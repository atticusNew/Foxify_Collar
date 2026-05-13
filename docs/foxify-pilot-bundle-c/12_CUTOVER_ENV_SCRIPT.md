# Production Cutover Environment Script (Operator Action — Day 11)

> **Purpose:** Single consolidated list of every Render env var to set/update at production cutover. Apply after Gate 1 (backtest sign-off) and Gate 2 (pre-cutover validation matrix) pass.
>
> **Apply by:** copy/paste into Render dashboard → Environment tab → Save → restart service. OR use `render envs set` CLI.
>
> **Rollback:** see §99 at the bottom.

---

## Step 1 — Pre-cutover backup

Before changing anything, capture current production env to a secure file:

```bash
render envs list --service-id <prod-service-id> > .env.prod.backup.YYYYMMDD
```

If anything goes wrong, this file is the rollback target.

---

## Step 2 — Bullish credentials (rotate fresh keys before applying)

**Generate new ECDSA key pair via Bullish dashboard.** Don't use the rev-2 burner keys for production — they were shared in chat and are considered compromised.

```bash
PILOT_BULLISH_ENABLED=true
PILOT_BULLISH_ENABLE_EXECUTION=true
PILOT_BULLISH_AUTH_MODE=ecdsa
PILOT_BULLISH_REST_BASE_URL=https://api.exchange.bullish.com
PILOT_BULLISH_PUBLIC_WS_URL=wss://api.exchange.bullish.com/trading-api/v1/market-data/orderbook
PILOT_BULLISH_PRIVATE_WS_URL=wss://api.exchange.bullish.com/trading-api/v1/private-data
PILOT_BULLISH_ECDSA_PUBLIC_KEY=<NEW_PUBLIC_PEM>
PILOT_BULLISH_ECDSA_PRIVATE_KEY=<NEW_PRIVATE_PEM>
PILOT_BULLISH_ECDSA_METADATA=<base64({"userId":"<NEW_USER_UUID>"})>
PILOT_BULLISH_TRADING_ACCOUNT_ID=<NEW_TRADING_ACCOUNT_ID>
PILOT_BULLISH_DEFAULT_SYMBOL=BTCUSDC
PILOT_BULLISH_ORDER_TIF=IOC
PILOT_BULLISH_PRICE_STALENESS_MAX_PCT=5
PILOT_BULLISH_ORDER_TIMEOUT_MS=8000
```

---

## Step 3 — Venue mode (Deribit stays for DVOL feed; Bullish for execution)

```bash
PILOT_VENUE_MODE=bullish_testnet
# Note: env name says "testnet" but baseUrl points at MAINNET (api.exchange.bullish.com).
# Code rename is post-pilot cleanup.
PILOT_PROFILE=default
# Multi-venue routing decisions per tier (rev 6 lock):
PILOT_VENUE_ROUTING_JSON='{"2":{"primary":"bullish","fallback":"deribit","fallbackDriftThresholdPct":0.30},"3":{"primary":"bullish","fallback":"deribit","fallbackDriftThresholdPct":0.30},"5":{"primary":"deribit","fallback":"bullish","fallbackDriftThresholdPct":0.30},"7":{"primary":"deribit","fallback":"bullish","fallbackDriftThresholdPct":0.30}}'
```

---

## Step 4 — Tier set + tenor (rev 6 lock)

```bash
V7_PRICING_ENABLED=true
PILOT_TENOR_MIN_DAYS=1
PILOT_TENOR_MAX_DAYS=7         # was 14; drop to 7 per rev 6
PILOT_TENOR_DEFAULT_DAYS=1
V7_DEFAULT_TENOR_DAYS=1
# Note: 10% tier drop and 7% tier addition are CODE changes
# (V7_LAUNCHED_TIERS in v7Pricing.ts). No env needed.
# Stress 2% lift to $11/$1k is CODE change (REGIME_SCHEDULES in pricingRegime.ts).
```

---

## Step 5 — Pricing regime (Design A live; stress overlay enabled)

```bash
# Design A is always-on once V7_PRICING_ENABLED=true. No env needed.

# Stress pricing overlay (rev 6: ENABLED at cutover per user reply 4):
PILOT_PREMIUM_REGIME_ENABLED=true
PILOT_PREMIUM_REGIME_APPLY_TO_ACTUARIAL=false
PILOT_PREMIUM_REGIME_LOOKBACK_MINUTES=240
PILOT_PREMIUM_REGIME_MIN_SAMPLES=15
PILOT_PREMIUM_REGIME_MIN_DWELL_MINUTES=120
PILOT_PREMIUM_REGIME_MAX_OVERLAY_PCT_OF_BASE=0.4
PILOT_PREMIUM_REGIME_WATCH_ADD_USD_PER_1K=1
PILOT_PREMIUM_REGIME_WATCH_MULTIPLIER=1.05
PILOT_PREMIUM_REGIME_STRESS_ADD_USD_PER_1K=2
PILOT_PREMIUM_REGIME_STRESS_MULTIPLIER=1.15
PILOT_PREMIUM_REGIME_ENTER_WATCH_TRIGGER_HIT_RATE_PCT=8
PILOT_PREMIUM_REGIME_ENTER_WATCH_SUBSIDY_UTILIZATION_PCT=40
PILOT_PREMIUM_REGIME_ENTER_WATCH_TREASURY_DRAWDOWN_PCT=15
PILOT_PREMIUM_REGIME_ENTER_STRESS_TRIGGER_HIT_RATE_PCT=15
PILOT_PREMIUM_REGIME_ENTER_STRESS_SUBSIDY_UTILIZATION_PCT=70
PILOT_PREMIUM_REGIME_ENTER_STRESS_TREASURY_DRAWDOWN_PCT=30
PILOT_PREMIUM_REGIME_EXIT_WATCH_TRIGGER_HIT_RATE_PCT=4
PILOT_PREMIUM_REGIME_EXIT_WATCH_SUBSIDY_UTILIZATION_PCT=25
PILOT_PREMIUM_REGIME_EXIT_WATCH_TREASURY_DRAWDOWN_PCT=8
PILOT_PREMIUM_REGIME_EXIT_STRESS_TRIGGER_HIT_RATE_PCT=8
PILOT_PREMIUM_REGIME_EXIT_STRESS_SUBSIDY_UTILIZATION_PCT=50
PILOT_PREMIUM_REGIME_EXIT_STRESS_TREASURY_DRAWDOWN_PCT=20
```

---

## Step 6 — Caps (per Pilot Agreement + rev 6 lock)

```bash
PILOT_QUOTE_MIN_NOTIONAL_USDC=10000
PILOT_MAX_PROTECTION_NOTIONAL_USDC=50000
PILOT_MAX_DAILY_PROTECTED_NOTIONAL_USDC=100000   # bump to 500000 on Day 8
PILOT_MAX_AGGREGATE_ACTIVE_NOTIONAL_USDC=200000
PILOT_PER_TIER_DAILY_CAP_PCT=0.6
PILOT_CAP_ENFORCEMENT_MODE=enforce               # not warn
```

---

## Step 7 — Hedge budget cap (rev 6 schedule for Atticus $12k pool)

```bash
PILOT_HEDGE_BUDGET_CAP_ENABLED=true
PILOT_HEDGE_BUDGET_SCHEDULE_JSON='[{"throughDay":7,"capUsd":3500},{"throughDay":21,"capUsd":8500},{"throughDay":28,"capUsd":12000},{"throughDay":null,"capUsd":null}]'
PILOT_LIVE_START_DATE=<ISO timestamp of cutover, e.g. 2026-05-13T00:00:00Z>
```

---

## Step 8 — Anti-bot (Layers 1-4 ENFORCE per rev 6 Q7 lock)

```bash
PILOT_ANTI_BOT_ENFORCE=true
# Foxify Layer 6 trader binding (only if Foxify ships their integration):
# PILOT_FOXIFY_SHARED_SECRET=<random 256-bit hex; share via secure channel with Foxify>
```

---

## Step 9 — Operational guardrails (Wave 1 ENABLED)

```bash
# Wave 1 — ship at cutover
PILOT_GUARDS_ALL_DISABLED=false
PILOT_GUARD_FOXIFY_POOL_KILL_ENABLED=true
PILOT_GUARD_FOXIFY_POOL_MIN_USDC=0     # bump when Foxify pre-funds
PILOT_GUARD_AGGREGATE_LIABILITY_ENABLED=true
PILOT_GUARD_AGGREGATE_LIABILITY_COVERAGE_PCT=0.8
PILOT_GUARD_RECONCILIATION_ENABLED=true
PILOT_GUARD_RECONCILIATION_DRIFT_PCT=0.01

# Wave 2 — ship Day 8 of pilot (start with these in observe-only mode):
# PILOT_GUARD_DVOL_HIGH_ENABLED=true
# PILOT_GUARD_DVOL_HIGH_THRESHOLD=100
# PILOT_GUARD_DVOL_HIGH_COOLDOWN_HOURS=1
# PILOT_GUARD_BULLISH_HEALTH_ENABLED=true
# PILOT_GUARD_BULLISH_HEALTH_5XX_RATE_MAX=0.10
# PILOT_GUARD_BULLISH_HEALTH_P95_LATENCY_MS_MAX=5000
# PILOT_GUARD_PREMIUM_VELOCITY_ENABLED=true
# PILOT_GUARD_PREMIUM_VELOCITY_MAX_RATIO=3.0
```

---

## Step 10 — TP optimization (deep-OTM writeoff is on by code default)

```bash
# Gap 1 / Gap 3 enforce decisions — flip true if WS#9 backtest output supports
PILOT_TP_GAP1_ENFORCE=false           # change to true after pre-flight calibration
PILOT_TP_GAP3_ENFORCE=false           # change to true after pre-flight calibration
PILOT_TP_GAP5_ENFORCE=true            # already enabled (per docs 2026-04-22)
PILOT_TP_NO_BID_BACKSTOP_ENABLED=true
PILOT_TP_NO_BID_BACKSTOP_THRESHOLD=60
```

---

## Step 11 — Circuit breaker (tightened per rev 6)

```bash
PILOT_CIRCUIT_BREAKER_ENFORCE=true
PILOT_CIRCUIT_BREAKER_MAX_LOSS_PCT=0.35   # was 0.50; tightened
PILOT_CIRCUIT_BREAKER_COOLDOWN_MS=14400000
PILOT_CIRCUIT_BREAKER_MIN_SAMPLES=4
```

---

## Step 12 — Alert routing (Telegram strongly recommended)

```bash
PILOT_ALERT_TELEGRAM_BOT_TOKEN=<bot token from BotFather>
PILOT_ALERT_TELEGRAM_CHAT_ID=<your numeric chat ID>
PILOT_ALERT_TELEGRAM_LEVELS=warning,critical
# Optionally: Slack and Discord too
```

Test alert delivery: `curl -X POST -H "Authorization: Bearer $PILOT_ADMIN_TOKEN" https://<api>/pilot/admin/test-alert`

---

## Step 13 — Apply + restart

1. Save all env changes in Render dashboard
2. Render auto-deploys from the production branch — wait for green health check
3. Verify boot logs include:
   - `[CapitalPools] schema + seed verified (atticus_hedge, foxify_trader)`
   - `[V7] Regime classifier configured: ...`
   - No `[CapitalPools] schema migration failed` or other red flags
4. Hit `/pilot/health` → must return `{"status":"ok"}`
5. Hit `/pilot/regime` → must return current regime + 7% tier in launched list

---

## Step 14 — Smoke test

```bash
# Quote (will succeed without auth — public pricing)
curl -X POST https://<api>/pilot/protections/quote \
  -H "Content-Type: application/json" \
  -d '{
    "protectedNotional": 10000,
    "foxifyExposureNotional": 10000,
    "entryPrice": 81000,
    "slPct": 7,
    "protectionType": "long",
    "tierName": "SL 7%"
  }'
# Should return ~$30 premium for $700 payout (7% calm regime per Bundle C P3)
```

If quote returns the expected number, **cutover is live**.

---

## Step 15 — Monitor for 72 hours

- Watch `/pilot/admin/metrics` every 4 hours
- Watch Render logs for `[AntiBot]`, `[HedgeManager]`, `[CapitalPools]` warnings
- Watch `/pilot/admin/hedge-budget` daily — confirm burn rate < $400/day
- First weekly settlement run ~Day 7 — verify report generates correctly

---

## §99 — Rollback procedure

If anything breaks:

1. **Single-env emergency:** flip `PILOT_ANTI_BOT_ENFORCE=false` OR `PILOT_GUARDS_ALL_DISABLED=true` — instant relief
2. **Full revert:** restore `.env.prod.backup.YYYYMMDD` (Step 1) → save → restart
3. **Code-level revert:** `git revert <merge-commit>` on production deploy branch → push → Render auto-deploys prior state
4. **Existing protections continue functioning** — DB additions are additive, no destructive migrations
5. **Bullish-purchased open hedges** stay at Bullish regardless of routing change; venue.sellOption handles cross-adapter calls

---

End. Questions on any step → engineering.
