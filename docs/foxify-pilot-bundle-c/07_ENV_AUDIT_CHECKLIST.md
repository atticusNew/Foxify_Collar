# Render Env Audit Checklist (Operator Action — Day 1)

> **Purpose:** Map what env overrides are actually live on the production Render service so we know exactly what's deployed before designing the cutover. The pricing schedule in the repo says $6.50–$10/$1k for 2%, but you reported live charges $25/$10k = $2.50/$1k. Need to identify which env vars are overriding the code defaults.

> **Scope:** Read-only. We only need to *see* the env values; not change them. No production impact from this audit.

---

## How to share env values securely

**Option A (preferred):** Render dashboard → service → Environment tab → click "Show" next to each var below → copy + paste into a shared secure document (1Password share, encrypted email, Slack DM with retention off). NEVER paste secrets in this chat or in any artifact file.

**Option B:** Run `render envs list --service-id <id>` from your terminal and share the output via secure channel.

**Option C:** Grant read access to Render via teammate invite; I can pull values directly.

For non-secret values (booleans, numbers, URLs), pasting in chat is fine. For secrets (API keys, tokens), use secure channel only.

---

## Variables to audit (priority order)

### 🔴 HIGH PRIORITY — pricing & venue (resolves the $25 vs $65 question)

| Env var | What we're checking | Expected if Design A is live | If different |
|---|---|---|---|
| `V7_PRICING_ENABLED` | V7 pricing path active? | `true` | If false, legacy pricing is in use |
| `PILOT_PREMIUM_REGIME_ENABLED` | Stress overlay live? | `false` | If true, pricing has additional regime overlay |
| `PILOT_PREMIUM_POLICY_MODE` | Pricing mode | `pass_through_markup` or `legacy` | Read whatever's set |
| `PILOT_PREMIUM_PRICING_MODE` | Hybrid vs strict | `actuarial_strict` | Read whatever's set |
| `PILOT_PREMIUM_MARKUP_PCT` (and `_BRONZE`/`_SILVER`/`_GOLD`/`_PLATINUM`) | Markup % | code defaults 0.045 / 0.06 / 0.05 / 0.04 / 0.03 | Read all |
| `PILOT_PREMIUM_FLOOR_USD_*` | Per-tier USD floor | code defaults 20/17/14/12 | Read all |
| `PILOT_HYBRID_STRICT_MULTIPLIER_*` | Discount multipliers | code default 0.7 | Read all |
| `PILOT_HYBRID_STRICT_MULTIPLIER_SCHEDULE` | Active multiplier schedule | `cheaper` | Read whatever's set |
| `PILOT_VENUE_MODE` | Active execution venue | `deribit_test` (current state) | Confirm this |
| `PILOT_BULLISH_ENABLED` | Bullish adapter loaded? | `false` (currently) | Confirm this |
| `PILOT_BULLISH_ENABLE_EXECUTION` | Bullish actually trading? | `false` (currently) | Confirm this |
| `PILOT_PROFILE` | Active runtime profile | `default` | If `bullish_locked_v1`, that's the override |
| `V7_DVOL_CALM_THRESHOLD` | Regime boundary | code default 40 | Read |
| `V7_DVOL_STRESS_THRESHOLD` | Regime boundary | code default 65 | Read |

**The critical question:** is there a custom premium schedule env that overrides Design A? Look for any var matching `*PREMIUM*SCHEDULE*` or `*PRICE*OVERRIDE*` that's not in the code.

### 🟡 MEDIUM PRIORITY — caps & limits (confirm Pilot Agreement compliance)

| Env var | Expected | Notes |
|---|---|---|
| `PILOT_QUOTE_MIN_NOTIONAL_USDC` | `10000` | Floor |
| `PILOT_MAX_PROTECTION_NOTIONAL_USDC` | `50000` | Per Pilot Agreement |
| `PILOT_MAX_DAILY_PROTECTED_NOTIONAL_USDC` | `100000` (Days 1-7) or `500000` (Days 8+) | Confirm which phase |
| `PILOT_MAX_AGGREGATE_ACTIVE_NOTIONAL_USDC` | `200000` | |
| `PILOT_PER_TIER_DAILY_CAP_PCT` | `0.6` | |
| `PILOT_CAP_ENFORCEMENT_MODE` | `enforce` (production) | If `warn`, caps are advisory only |
| `PILOT_HEDGE_BUDGET_CAP_ENABLED` | `true` | |
| `PILOT_HEDGE_BUDGET_SCHEDULE_JSON` | If set, share value | This is where the cumulative cap schedule lives |
| `PILOT_LIVE_START_DATE` | ISO timestamp | Used for pilot-day calculation in cap schedule |

### 🟡 MEDIUM PRIORITY — TP & hedge management

| Env var | Expected | Notes |
|---|---|---|
| `PILOT_TP_GAP1_ENFORCE` | `false` (currently observe-only) | We'll flip to `true` if backtest supports |
| `PILOT_TP_GAP3_ENFORCE` | `false` | Same |
| `PILOT_TP_GAP5_ENFORCE` | `true` (per docs, flipped 2026-04-22) | Confirm |
| `PILOT_TP_NO_BID_BACKSTOP_ENABLED` | `true` | |
| `PILOT_TP_NO_BID_BACKSTOP_THRESHOLD` | `60` | |
| `PILOT_HEDGE_MGMT_INTERVAL_MS` | `60000` | |
| `PILOT_TRIGGER_MONITOR_INTERVAL_MS` | `3000` | |
| `PILOT_TENOR_MIN_DAYS` | `1` | |
| `PILOT_TENOR_MAX_DAYS` | `7` (current) or `14` | We'll lower to 7 if not already |
| `PILOT_TENOR_DEFAULT_DAYS` | `1` (V7 default) | |
| `PILOT_DERIBIT_MAX_TENOR_DRIFT_DAYS` | `1.5` | |

### 🟡 MEDIUM PRIORITY — circuit breaker & alerts

| Env var | Expected | Notes |
|---|---|---|
| `PILOT_CIRCUIT_BREAKER_MAX_LOSS_PCT` | `0.5` (we'll tighten to 0.35) | |
| `PILOT_CIRCUIT_BREAKER_COOLDOWN_MS` | `14400000` (4h) | |
| `PILOT_CIRCUIT_BREAKER_MIN_SAMPLES` | `4` | |
| `PILOT_CIRCUIT_BREAKER_ENFORCE` | `true` | |
| `PILOT_AUTO_RENEW_INTERVAL_MS` | `300000` (5min) | |
| `PILOT_AUTO_RENEW_STRESS_ALLOWED` | `false` (freezes in stress) | |
| `PILOT_ALERT_TELEGRAM_BOT_TOKEN` | If set, treat as secret | Don't paste; just confirm presence |
| `PILOT_ALERT_TELEGRAM_CHAT_ID` | If set | |
| `PILOT_ALERT_SLACK_WEBHOOK_URL` | If set, treat as secret | |
| `PILOT_ALERT_DISCORD_WEBHOOK_URL` | If set, treat as secret | |

### 🔵 LOW PRIORITY — infrastructure

| Env var | Expected | Notes |
|---|---|---|
| `POSTGRES_URL` / `DATABASE_URL` | Internal Render Postgres URL | **SECRET — don't share publicly** |
| `PILOT_ADMIN_TOKEN` | **SECRET — don't share publicly** | |
| `PILOT_INTERNAL_TOKEN` | **SECRET — don't share publicly** | |
| `USER_HASH_SECRET` | **SECRET — don't share publicly** | |
| `PILOT_PROOF_TOKEN` | **SECRET — don't share publicly** | |
| `PILOT_TENANT_SCOPE_ID` | `foxify-pilot` | |
| `PILOT_API_ENABLED` | `true` | |
| `PILOT_ACTIVATION_ENABLED` | `true` | |
| `PILOT_ENFORCE_WINDOW` | `true` or `false` | |
| `PILOT_START_AT` | ISO timestamp | When pilot started |
| `PILOT_DURATION_DAYS` | `30` or `28` | |

### 🔴 SECRETS — DO NOT PASTE IN CHAT

For any of these, just confirm they are SET (not their value):
- `DERIBIT_API_KEY`, `DERIBIT_API_SECRET`
- `PILOT_BULLISH_ECDSA_PUBLIC_KEY`, `PILOT_BULLISH_ECDSA_PRIVATE_KEY`, `PILOT_BULLISH_ECDSA_METADATA`, `PILOT_BULLISH_TRADING_ACCOUNT_ID`
- `PILOT_BULLISH_HMAC_PUBLIC_KEY`, `PILOT_BULLISH_HMAC_SECRET`

If Bullish credentials are not yet set on Render, the rev-2 burner keys you shared will go in via Render dashboard before Day 4 staging deploy.

---

## Audit output format

Once you have the values, share them in the format below (paste in chat for non-secret values; secure channel for secrets):

```
=== Pricing & venue ===
V7_PRICING_ENABLED=...
PILOT_PREMIUM_REGIME_ENABLED=...
PILOT_PREMIUM_POLICY_MODE=...
... (etc.)

=== Caps ===
PILOT_QUOTE_MIN_NOTIONAL_USDC=...
... (etc.)

=== TP / hedge ===
PILOT_TP_GAP1_ENFORCE=...
... (etc.)

=== Circuit breaker / alerts ===
... (etc.)

=== Infrastructure (non-secret) ===
... (etc.)

=== Secrets present? ===
DERIBIT_API_KEY: SET / NOT SET
PILOT_BULLISH_ECDSA_PRIVATE_KEY: SET / NOT SET
... (etc.)
```

---

## What I'll do once you share the audit

1. **Decode the $25/$10k mystery** — figure out which env override is producing this pricing
2. **Map current → Bundle C delta** — exact list of env vars to change at cutover
3. **Identify any blockers** — e.g., if `PILOT_CAP_ENFORCEMENT_MODE=warn` instead of `enforce`, that's a tightening we want to make
4. **Write the cutover env script** — operator-runnable list of `render env set` commands
5. **Update WS#9 backtest "current baseline" config** to match what's actually deployed (not what code defaults say)

Estimated turnaround: same-day once you share the values.

---

## Time budget for you

If pasting from Render dashboard: 10–15 minutes.
If using `render envs list`: 2 minutes.

Either works. No rush — execution Day 2-3 doesn't depend on this audit.
