# Atticus Pilot Platform — Technical Guide

## 1. Architecture Overview

The Atticus pilot platform provides automated downside protection for Bitcoin positions. It purchases options on Deribit to hedge against price drops (or rises for shorts), monitors positions in real-time, and manages the option lifecycle including take-profit recovery.

### Components

```
┌─────────────────────────────────────────────────────────────┐
│  Frontend (React / Vite)                                     │
│  ├── PilotWidget — Retail trading interface                  │
│  ├── AdminDashboard — Operator view (P&L, protections)       │
│  ├── TreasuryDashboard — Foxify's treasury view              │
│  └── TreasuryAdmin — Operator treasury admin                 │
├─────────────────────────────────────────────────────────────┤
│  Backend API (Node + Fastify)                                 │
│  ├── Pilot Routes — Quote, activate, monitor, admin          │
│  ├── Treasury Routes — Status, history, billing, execute     │
│  ├── Trigger Monitor — 3s polling for floor breaches         │
│  ├── Hedge Manager — TP logic, bounce detection, salvage     │
│  ├── Auto-Renew — Automated protection renewal at expiry     │
│  └── Treasury Scheduler — Daily automated treasury cycles    │
├─────────────────────────────────────────────────────────────┤
│  External Services                                           │
│  ├── Deribit (trading account) — Options execution           │
│  │     paper on testnet, real on live; venue.mode controls   │
│  ├── Deribit (mainnet, read-only) — DVOL/RVOL/regime data    │
│  │     ALWAYS mainnet regardless of trading account env      │
│  ├── Coinbase — Primary spot price feed                      │
│  └── Deribit Perpetual — Fallback spot price feed            │
├─────────────────────────────────────────────────────────────┤
│  Database (PostgreSQL)                                       │
│  ├── pilot_protections — Protection lifecycle records        │
│  ├── pilot_sim_positions — Simulated perp positions          │
│  ├── pilot_ledger_entries — Premium/payout accounting        │
│  ├── treasury_protections — Treasury daily hedges            │
│  └── treasury_config_state — Treasury operational state      │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

```
User → PilotWidget → API (quote) → Deribit (option pricing)
                   → API (activate) → Deribit (option purchase)
                   → DB (protection record + ledger)

Background:
  Trigger Monitor (3s) → Coinbase/Deribit (spot price) → DB (check floors)
  Hedge Manager (60s) → Deribit (sell options for TP recovery)
  Auto-Renew (5min) → Deribit (buy new option at expiry)
  Expiry Resolver (30s) → DB (settle expired protections)
```

---

## 2. Transaction Flow — End to End

### Quote Phase

1. User selects position type (long/short), size ($10k–$50k), and SL% (2/3/5/10).
2. Frontend calls `POST /pilot/protections/quote`.
3. Backend fetches spot price from Coinbase (fallback: Deribit perpetual).
4. Computes floor/trigger price: `entry × (1 - SL%/100)` for longs, `entry × (1 + SL%/100)` for shorts.
5. Computes V7 premium: `notional / 1000 × ratePer1k` (e.g., $6/1k for 2%).
6. Calls Deribit `listInstruments("BTC")` to get available options.
7. Filters by expiry window: `[now + max(8h, tenor × 0.5), now + tenor + 2 days]`.
8. For trigger-aligned mode: also filters strikes within ±0.5% of the trigger price.
9. Sorts candidates by an asymmetric tenor penalty (too-short expiry penalized 3×), strike-distance, and ITM preference (when applicable).
10. Fetches order books for top 8 candidates, applies a soft cost-cap penalty when hedge cost exceeds client premium.
11. Returns quote with instrument, premium, strike, and expiry.

### Activation Phase

1. User clicks "Open + Protect".
2. Frontend calls `POST /pilot/protections/activate` with `quoteId`.
3. Backend retrieves cached quote, validates it hasn't expired.
4. Executes a market buy on Deribit for the selected option.
5. Creates protection record in DB with status `active`.
6. Creates sim position, price snapshot, venue execution, and ledger entry.
7. Returns protection ID to the frontend.

### Monitoring Phase

1. Frontend polls `GET /pilot/protections/:id/monitor` every 5s.
2. Returns current spot, distance to floor, time remaining, option mark.
3. Trigger monitor runs independently every 3s server-side.

### Trigger Phase

1. Trigger monitor detects `spot ≤ floorPrice` (longs) or `spot ≥ ceilingPrice` (shorts).
2. Atomically updates protection to `status: triggered` with an optimistic lock (`WHERE status = 'active'`).
3. Records payout amount: `notional × SL%`.
4. Credits sim position balance.
5. Inserts ledger entry for `trigger_payout_due`.
6. Hedge manager begins TP recovery cycle on the option.

### TP Recovery Phase

1. Hedge manager evaluates triggered positions every 60s.
2. Computes option value via Black-Scholes (put for longs, call for shorts) using DVOL as `sigma`.
3. Resolves the active TP regime from current DVOL (low / normal / high) — see Section 5.
4. Walks the decision tree (Section 5) and either sells the option, holds for cooling/gap, or holds for an insufficient-value condition.
5. Executes a market sell on Deribit when the decision is to sell.
6. Records proceeds in `metadata.sellResult` and flips `hedge_status` to `tp_sold`.

### Expiry Phase

1. Expiry resolver runs every 30s checking `expiry_at <= NOW()`.
2. Fetches final spot price.
3. Computes settlement: ITM puts → payout owed to Atticus from option settlement; OTM → zero.
4. Sets status to `expired_itm` or `expired_otm`.
5. If auto-renew enabled → auto-renew cycle creates a new protection.

### Active Salvage (Non-Triggered)

1. Hedge manager checks active (non-triggered) positions within the active-salvage window before expiry (Section 5).
2. If option has at least the active-salvage minimum value → sells to capture remaining time value.
3. This recovers value from positions that never triggered.

---

## 3. V7 Pricing Model

### Premium Schedule

| SL% | Rate per $1k | Tenor | Payout per $10k |
|-----|--------------|-------|-----------------|
| 2%  | $6.00        | 1 day | $200            |
| 3%  | $5.00        | 1 day | $300            |
| 5%  | $3.00        | 1 day | $500            |
| 10% | $2.00        | 1 day | $1,000          |

Premium formula: `notional / 1000 × ratePer1k`

Example: $50,000 at 2% SL = $50,000 / 1,000 × $6 = $300 premium.

`SL 1%` ($6/1k, $100 payout per $10k) is defined in `v7Pricing.ts` for forward compatibility but is intentionally excluded from `V7_LAUNCHED_TIERS` and is not selectable via the frontend or quote API during the pilot.

**Pre-launch calibration (2026-04-18 → 2026-04-19).** The 2% SL premium was raised from $5 → $6/$1k, and the 3% SL premium was raised from $4 → $5/$1k. Both changes target the most volatility-sensitive tiers in the schedule. Black-Scholes hedge cost on a 1-DTE 2% put crosses $5 at DVOL ≈ 52 and $6 at DVOL ≈ 62; on a 3% put it crosses $4 at DVOL ≈ 66 and $5 at DVOL ≈ 71. Today's spot DVOL (~43) leaves both prices comfortably profitable; the bumps buy 10 and 5 DVOL points of breakeven headroom respectively before live pilot. The 5% and 10% tiers have an order of magnitude less DVOL sensitivity at 1-DTE and remain unchanged. Trader-side ratio at the new schedule: 2% pays back 3.3× premium on trigger ($60 → $200); 3% pays back 6× ($50 → $300); 5% pays back 16.7×; 10% pays back 50×. Full math and historical justification in `docs/cfo-report/`.

### Margin Economics

- **Spread** = Client Premium − Hedge Cost
- **Net P&L** = Total Spreads − Total Payouts + TP Recovery
- The cost-cap soft penalty in option selection biases the system toward positive-spread instruments. When every available instrument exceeds the client premium, the system still selects the cheapest candidate and logs a `⚠ NEGATIVE_MARGIN` warning rather than failing the activation.

---

## 4. Option Selection Algorithm

### Phase A — Candidate Filtering & Ranking

1. Fetch all BTC options from Deribit.
2. Filter by option type (puts for longs, calls for shorts).
3. Filter by expiry window: `[now + max(8h, tenor × 0.5), now + tenor + 2 days]`.
4. For trigger-aligned mode (`PILOT_STRIKE_SELECTION_MODE=trigger_aligned`): filter strikes within ±0.5% of trigger.
5. Sort with asymmetric tenor penalty (too-short expiry penalized 3×).
6. ITM preference for `drawdownFloorPct ≤ 0.025`: puts at/above the trigger receive a `-2.0` sort bonus. Of the launched tiers, only **2% SL** satisfies this condition.

### Phase B — Order Book Scoring

1. Fetch order books for top 8 candidates.
2. Score: `costScore = ask + strikeDist × 0.5`.
3. ITM bonus: `-0.002` for ITM candidates when `preferItm` is true.
4. Cost cap (soft): if `hedgeCost > clientPremium`, add `(hedgeCost − clientPremium) / clientPremium × 0.5` to `costScore`.
5. Winner: lowest `costScore`. Logged as `[OptionSelection] WINNER:` with margin %, with `⚠ NEGATIVE_MARGIN` annotation when applicable.

### Key Parameters

- `preferItm`: true when `drawdownFloorPct ≤ 0.025` and option type is put.
- `strikeSelectionMode`: `trigger_aligned` (aligns strikes to trigger price).
- `maxTenorDriftDays`: 1.5 (max allowed deviation from requested tenor).
- `quotePolicy`: `ask_or_mark_fallback` (use ask price, fall back to mark if no ask).

If no candidate strike exists in the trigger band under `trigger_aligned` mode, the quote endpoint throws `deribit_quote_unavailable:trigger_strike_unavailable`.

---

## 5. Hedge Management & TP Logic

The hedge manager runs every 60s. It services two classes of positions: **active** (not yet triggered, candidates for active salvage near expiry) and **triggered** (candidates for the full TP decision tree).

### DVOL-Adaptive TP Parameters

The TP timing thresholds adapt to the current DVOL regime resolved from `currentIV`:

| Parameter                   | Low (DVOL < 35) | Normal (35–60) | High (DVOL > 60) |
|-----------------------------|-----------------|----------------|------------------|
| Cooling period (h)          | 0.25            | 0.50           | 1.00             |
| Deep-drop cooling (h)       | 0.10            | 0.167          | 0.25             |
| Prime threshold × payout    | 0.15            | 0.25           | 0.35             |
| Late threshold × payout     | 0.05            | 0.10           | 0.15             |
| Prime window end (h)        | 6               | 8              | 10               |

### Fixed (Non-Adaptive) Parameters

| Parameter                         | Value     |
|-----------------------------------|-----------|
| Deep-drop threshold               | 1.5% past floor |
| Bounce-recovery min option value  | $5        |
| Near-expiry salvage window        | < 6 h to expiry |
| Near-expiry salvage min value     | $3        |
| Active salvage window             | < 4 h to expiry |
| Active salvage min value          | $5        |
| Gap-significant threshold         | 0.3% (strike-vs-floor) |
| Gap-cooling extension             | +0.5 h    |
| Cycle interval                    | 60 s      |

### Decision Tree (Triggered Positions)

The hedge manager evaluates these branches in order; the first matching branch wins:

1. **Near-expiry salvage** — `hoursToExpiry < 6` AND `optionValue ≥ $3` → sell.
2. **Deep-drop TP** — `dropFromFloorPct ≥ 1.5%` AND `hoursSinceTrigger ≥ deepDropCooling` AND `optionValue ≥ payout × primeThreshold` → sell.
3. **Cooling / gap-extended cooling** — `hoursSinceTrigger < effectiveCooling` → hold. `effectiveCooling = cooling + 0.5h` when `gapPct ≥ 0.3%` AND option is OTM AND not yet bounced.
4. **Bounce recovery** — `bounced` (spot back through floor) AND `hoursSinceTrigger ≥ effectiveCooling` AND `optionValue ≥ $5` → sell. (Once OTM after trigger, an option only loses time value; waiting gains nothing. Threshold raised from $3 to $5 to align with realized post-spread proceeds — see TP optimization analysis.)
5. **Prime window TP** — `effectiveCooling ≤ hoursSinceTrigger < primeWindowEnd` AND `optionValue ≥ payout × primeThreshold` → sell.
6. **Late window TP** — `hoursSinceTrigger ≥ primeWindowEnd` AND `optionValue ≥ payout × lateThreshold` → sell.

### Active (Non-Triggered) Positions

Only the active-salvage branch is evaluated:

- `hoursToExpiry ≤ 4` AND `optionValue ≥ $5` → sell to capture remaining time value.

### Sell Execution & Outcomes

Each sell call returns one of `sold`, `no_bid`, or `failed`:

- `sold` — `hedge_status` flips to `tp_sold`, `metadata.sellResult` records `fillPrice`, `totalProceeds`, `orderId`, and Black-Scholes-derived `bsRecovery` snapshot.
- `no_bid` — counted as `noBidRetries`; the hedge will be re-evaluated next cycle. Per R3.C (added 2026-04-19): `metadata.noBidRetryCount` increments on every no-bid retry, `metadata.lastNoBidAt` and `lastNoBidInstrument` are stamped, and `[HedgeManager] WARN` is emitted at threshold counts (30, 60, 120 cycles ≈ 30 min, 1 h, 2 h) for operator visibility on stuck positions.
- `failed` — counted as `errors`; logged with truncated detail payload.

### Failure-Mode Hardening (R3.A / R3.B / R3.C)

Three guards added 2026-04-19 to handle common Deribit / venue failure modes safely:

- **R3.A — Hedge cycle silent-skip guard**: `routes.ts` hedge-mgmt scheduler wraps `getIndexPrice()` in try/catch with explicit `[HedgeManager] no spot price available — cycle skipped` warning. Without this, a Deribit outage caused the cycle to silently return with no log output.
- **R3.B — `placeOrder` timeout wrapper**: `venue.ts execute()` races the Deribit `placeOrder` call against an explicit `PILOT_DERIBIT_EXECUTE_TIMEOUT_MS` (default 8000) timeout. Throws `venue_execute_timeout` if exceeded, which the activate path translates to a 504 response.
- **R3.C — No-bid retry persistence + warnings**: every `no_bid` sell increments `metadata.noBidRetryCount` and stamps `lastNoBidAt` / `lastNoBidInstrument`. WARN fires at thresholds 30/60/120 cycles. Phase 2 chain samples confirm bid is null in 4 of 8 tier×side combos on every snapshot — this is normal behavior, not a bug; persistence makes it operationally visible.

### Volatility Data Source (DVOL / RVOL)

DVOL and RVOL drive (a) the regime classifier, (b) the DVOL-adaptive TP timing/threshold parameters in the hedge manager, and (c) the Black-Scholes recovery-value model. **Both must always be sourced from Deribit mainnet,** regardless of whether the trading account lives on testnet or live.

Implementation:
- `services/api/src/server.ts` constructs two `DeribitConnector` instances:
  - `deribit` — env-driven (`DERIBIT_ENV` / `PILOT_VENUE_MODE`), used for trading and account-bound calls. May point at testnet for the paper pilot.
  - `deribitLive` — always `env="live"`, paper mode, no credentials. Used exclusively for read-only public market data.
- The pilot regime classifier (`configureRegimeClassifier`) and the hedge-manager scheduler are both wired to `deribitLive` for `getDVOL("BTC")` and `getHistoricalVolatility("BTC")`.
- Testnet's `get_volatility_index_data` endpoint returns synthetic flat values (~133 as of Apr 2026, vs mainnet ~43). Routing DVOL through testnet would mis-tune the TP decision tree (running high-vol parameters in a calm market) and overstate Black-Scholes fair values.
- A defensive `console.warn` fires in the connector if `getDVOL` is called against a `testnet`-env instance, as a safety net for future code paths.

Verification: run `npm run pilot:verify:dvol-source` in `services/api/` to confirm the platform's `/pilot/regime` endpoint returns mainnet-aligned DVOL.

---

## 6. Trigger Monitoring

- **Interval**: 3 seconds (`PILOT_TRIGGER_MONITOR_INTERVAL_MS`, min 1 s).
- **Primary price source**: Coinbase (`/products/BTC-USD/ticker`).
- **Fallback**: Deribit perpetual ticker.
- **Retry**: 3 attempts with 180 ms delay per source.
- **Freshness check**: Rejects prices older than 5 seconds.
- **Breach logic**: `spot ≤ triggerPrice` (longs), `spot ≥ triggerPrice` (shorts).
- **Atomic update**: Uses `WHERE status = 'active'` guard to prevent double-trigger.
- **Batch size**: 50 protections per cycle.
- **Error tracking**: Consecutive price errors logged; warning at 10+.

---

## 7. Auto-Renew System

- **Interval**: 5 minutes.
- **Candidates**: `auto_renew = true` AND either:
  - `status = 'active'` AND `expiry_at` within 30 minutes ahead or 2 hours past, OR
  - `status = 'triggered'` AND `expiry_at` within 24 hours past (covers post-trigger renewal of triggered protections).
- **Protection type**: Reads from original protection (supports both long → put, short → call).
- **Dedup**: Skips if `metadata.renewedTo` already set.
- **On success**: Creates new protection, patches old with `renewedTo` pointer and sets old status to `expired_otm`.
- **On failure**: Logs error, old protection stays in place until expiry resolver handles it.
- **Frontend**: Polls monitor, follows `renewedTo` chain to display the new protection seamlessly.

---

## 8. Treasury Platform

### Overview

Separate system for institutional daily protection ($1M+ notional). Runs on the same infrastructure but with independent tables, routes, and scheduler. Treasury is **not enabled** during the retail pilot to avoid contaminating pilot reconciliation data and avoid sharing the testnet Deribit account with non-pilot trades.

### Daily Cycle

1. At scheduled execution time (configurable UTC hour/minute, defaults `00:05` UTC).
2. Gets current spot price.
3. Computes floor: `spot × (1 − floorPct/100)`.
4. Requests option quote from Deribit.
5. Executes purchase.
6. Records protection with premium, hedge cost, spread.
7. Monitors for trigger throughout the day.
8. Settles at expiry.

### Structure: Fixed Payout

- Client pays daily premium (e.g., 25 bps of notional, configurable).
- If BTC breaches floor → client receives fixed payout (`notional × floorPct`).
- Option value beyond fixed payout is Atticus profit (TP recovery).

### Treasury Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET    | `/treasury/status`            | Current protection status (Foxify view) |
| GET    | `/treasury/history`           | Protection history |
| POST   | `/treasury/pause`             | Pause daily execution |
| POST   | `/treasury/resume`            | Resume execution |
| POST   | `/treasury/notional`          | Adjust notional amount |
| POST   | `/treasury/execute-now`       | Force immediate execution |
| POST   | `/treasury/reset`             | Reset all treasury data |
| GET    | `/treasury/admin/status`      | Full admin view with P&L |
| GET    | `/treasury/billing/summary`   | Monthly billing breakdown |

---

## 9. API Reference — Retail Pilot

### Core Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST   | `/pilot/protections/quote`           | None  | Generate protection quote |
| POST   | `/pilot/protections/activate`        | None  | Execute protection |
| POST   | `/pilot/protections/:id/auto-renew`  | None  | Toggle auto-renew on an active protection (`{ enabled: true \| false }`). Optimistic lock requires `status='active'`; per Pilot Agreement §3.3 this is at Client's discretion. The current cycle always runs to its natural expiry; this only affects whether a NEW protection is created at expiry. |
| GET    | `/pilot/protections/:id/monitor`     | None  | Live protection status |
| GET    | `/pilot/protections`                 | Admin | List all protections |
| GET    | `/pilot/reference-price`             | None  | Current BTC spot price |
| GET    | `/pilot/regime`                      | None  | Current volatility regime |
| GET    | `/pilot/health`                      | None  | Platform health check |

### Admin Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET    | `/pilot/admin/metrics`                                  | Aggregate P&L and metrics |
| GET    | `/pilot/admin/diagnostics/execution-quality`            | Fill rates and slippage |
| POST   | `/pilot/admin/protections/:id/premium-settled`          | Mark premium as settled |
| POST   | `/pilot/admin/protections/:id/payout-settled`           | Mark payout as settled |
| GET    | `/pilot/admin/protections/:id/ledger`                   | Protection ledger entries |
| POST   | `/pilot/admin/reset`                                    | Hard reset — wipes 17 tables (use only between pilot phases) |
| POST   | `/pilot/admin/test-reset-protections`                   | Surgical archive of paper-test protections, releases caps, preserves audit data (`{ protectionIds: string[], reason?: string }`) |
| POST   | `/pilot/admin/test-alert`                               | R7 — emit a test alert through the dispatcher (`{ level, message }` optional) |
| GET    | `/pilot/monitor/status`                                 | Monitor health status |
| GET    | `/pilot/monitor/alerts`                                 | Recent alerts |

---

## 10. Database Schema — Core Tables

### pilot_protections
Primary table for all protection records.

Key columns: `id`, `user_hash`, `status`, `tier_name`, `sl_pct`, `drawdown_floor_pct`, `floor_price`, `entry_price`, `protected_notional`, `expiry_at`, `venue`, `instrument_id`, `size`, `execution_price`, `premium`, `payout_due_amount`, `auto_renew`, `hedge_status`, `metadata`.

Status values: `pending_activation`, `active`, `triggered`, `expired_itm`, `expired_otm`, `cancelled`, `reconcile_pending`, `activation_failed`, `awaiting_expiry_price`, `awaiting_renew_decision`.

`hedge_status` values: `active`, `tp_sold`, `expired_settled`.

**Tenancy note (pilot):** all pilot users are mapped to a single `user_hash` derived from `PILOT_TENANT_SCOPE_ID` (default `"foxify-pilot"`). Caps (aggregate-active, daily, per-tier) accumulate across the entire pilot, not per individual trader. Use `POST /pilot/admin/test-reset-protections` to clear cap headroom for paper-test rows without disturbing other audit data. Per-user tenancy is a post-pilot work item.

**`metadata.archivedAt` filter:** rows with `metadata.archivedAt` set are excluded from `sumActiveProtectionNotional` and `getDailyTierUsageForUser`. Only the surgical test-reset endpoint sets this field; ordinary user flows do not.

### pilot_sim_positions
Simulated perp positions (frontend-driven).

Key columns: `id`, `user_hash`, `status`, `market_id`, `side`, `notional_usd`, `entry_price`, `sl_pct`, `protection_id`, `trigger_credited_usd`.

### pilot_ledger_entries
Accounting trail for premiums and payouts.

Key columns: `id`, `protection_id`, `entry_type`, `amount`, `reference`.

Entry types: `premium_due`, `premium_collected`, `trigger_payout_due`, `payout_due`, `payout_settled`.

---

## 11. Environment Configuration

### Required for Pilot

| Variable | Purpose | Example |
|----------|---------|---------|
| `PILOT_API_ENABLED`               | Enable pilot routes        | `true` |
| `PILOT_ACTIVATION_ENABLED`        | Enable trade execution     | `true` |
| `PILOT_VENUE_MODE`                | Execution venue            | `deribit_test` or `deribit_live` |
| `DERIBIT_API_KEY`                 | Deribit credentials        | (from Deribit) |
| `DERIBIT_API_SECRET`              | Deribit credentials        | (from Deribit) |
| `POSTGRES_URL` / `DATABASE_URL`   | Database connection        | (internal Render URL) |
| `PILOT_ADMIN_TOKEN`               | Admin dashboard auth       | (any secure string) |
| `V7_PRICING_ENABLED`              | Enable V7 tiered pricing   | `true` |
| `V7_DEFAULT_TENOR_DAYS`           | Default option tenor       | `1` |
| `VITE_PILOT_WIDGET`               | Enable PilotWidget UI      | `true` |
| `VITE_PILOT_ACCESS_CODE`          | Frontend access gate       | (any shared code) |
| `VITE_API_BASE`                   | Backend API URL            | `https://foxify-pilot-new.onrender.com` |

### Alert Dispatcher (R7 — added 2026-04-19)

The platform fans out `PilotAlert` objects to outbound webhook destinations
via `services/api/src/pilot/alertDispatcher.ts`. All destinations are
configured by env var; leaving any blank disables that destination.

| Variable | Default | Purpose |
|---|---|---|
| `PILOT_ALERT_TELEGRAM_BOT_TOKEN`   | (empty) | Telegram bot HTTP API token |
| `PILOT_ALERT_TELEGRAM_CHAT_ID`     | (empty) | Telegram chat ID (user, group, or channel) |
| `PILOT_ALERT_TELEGRAM_LEVELS`      | `warning,critical` | Comma-list of levels to send |
| `PILOT_ALERT_SLACK_WEBHOOK_URL`    | (empty) | Slack incoming-webhook URL |
| `PILOT_ALERT_SLACK_LEVELS`         | `warning,critical` | |
| `PILOT_ALERT_DISCORD_WEBHOOK_URL`  | (empty) | Discord webhook URL |
| `PILOT_ALERT_DISCORD_LEVELS`       | `critical` | |
| `PILOT_ALERT_GENERIC_WEBHOOK_URL`  | (empty) | Generic JSON POST destination |
| `PILOT_ALERT_GENERIC_LEVELS`       | `info,warning,critical` | |
| `PILOT_ALERT_DEDUP_WINDOW_SEC`     | `300` | Same `(destination,code,level)` suppressed within window |
| `PILOT_ALERT_HTTP_TIMEOUT_MS`      | `5000` | Per-webhook send timeout |

Alerts the platform emits and which level they fire at:

| Code | Level | Emitter | When |
|---|---|---|---|
| `negative_spread` | warning | monitor.recordFill | Hedge cost > premium on a fill |
| `fill_failure` | warning/critical | monitor.recordFill | Hedge fill failed; critical at 5+ consecutive |
| `fill_circuit_breaker` | critical | monitor.recordFill | 5+ consecutive failures = hedging impaired |
| `treasury_low` / `treasury_critical` | warning/critical | monitor.checkTreasuryBalance | Funding below thresholds |
| `hedge_no_spot` | warning | hedge-mgmt scheduler (R3.A) | Deribit getIndexPrice failed; cycle skipped |
| `trigger_fired` | info | trigger monitor (R7) | A protection triggered |
| `trigger_monitor_price_errors` | critical | trigger monitor (R7) | 10+ consecutive price-feed errors |
| `trigger_monitor_cycle_error` | critical | trigger monitor (R7) | Trigger-monitor cycle threw |

**Telegram setup recipe** (the most useful destination for solo operators):

1. Open a chat with `@BotFather` on Telegram. Send `/newbot`. Follow prompts; copy the token.
2. Open a chat with `@userinfobot` to find your numeric chat ID, OR add the bot to a group / channel and use that chat's ID.
3. On Render, set:
   - `PILOT_ALERT_TELEGRAM_BOT_TOKEN=<from BotFather>`
   - `PILOT_ALERT_TELEGRAM_CHAT_ID=<numeric chat id>`
   - `PILOT_ALERT_TELEGRAM_LEVELS=warning,critical` (or `critical` only if you want only the loudest events)
4. Trigger a test alert by hitting `POST /pilot/admin/test-alert` (admin token required) — see endpoint below.

### Notional Cap Configuration (Pilot Agreement §3.1)

| Variable | Default | Agreement | Notes |
|---|---|---|---|
| `PILOT_QUOTE_MIN_NOTIONAL_USDC`              | 10000  | $10,000 min/position  | Hard floor of $10,000 enforced in code regardless of env |
| `PILOT_MAX_PROTECTION_NOTIONAL_USDC`         | 100000 | $50,000 max/position  | **MUST set to 50000 for live pilot** |
| `PILOT_MAX_DAILY_PROTECTED_NOTIONAL_USDC`    | 100000 | $100k Days 1-7, $500k Days 8-28 | Bump to 500000 on Day 8 of pilot |
| `PILOT_MAX_AGGREGATE_ACTIVE_NOTIONAL_USDC`   | 200000 | $200,000 aggregate active | R2.B added 2026-04-19 |
| `PILOT_PER_TIER_DAILY_CAP_PCT`               | 0.6    | (defense-in-depth, not in agreement) | Caps any single SL tier at 60% of daily cap; R2.D added 2026-04-19 |
| `PILOT_CAP_ENFORCEMENT_MODE`                 | `warn` | (operational guard)   | Set to `enforce` on production to block boot if env values exceed agreement caps; R2.E added 2026-04-19 |

### Optional Tuning

| Variable | Default | Purpose |
|----------|---------|---------|
| `PILOT_TRIGGER_MONITOR_INTERVAL_MS`     | 3000   | Trigger check frequency |
| `PILOT_HEDGE_MGMT_INTERVAL_MS`          | 60000  | TP evaluation frequency |
| `PILOT_AUTO_RENEW_INTERVAL_MS`          | 300000 | Auto-renew check frequency |
| `PILOT_DERIBIT_MAX_TENOR_DRIFT_DAYS`    | 1.5    | Max tenor deviation |
| `PILOT_STRIKE_SELECTION_MODE`           | `trigger_aligned`       | Strike alignment mode |
| `PILOT_DERIBIT_QUOTE_POLICY`            | `ask_or_mark_fallback`  | Order book pricing policy |

---

## 12. Monitoring & Logging

### Log Prefixes

| Prefix | System | What to Look For |
|--------|--------|------------------|
| `[TriggerMonitor]` | Trigger detection | `TRIGGERED:` events, price errors, consecutive failure warnings |
| `[HedgeManager]`   | TP recovery       | `Selling (reason):` events, `Sell result:`, `gap_extended_cooling`, `cooling_period`, cycle summaries |
| `[AutoRenew]`      | Protection renewal | `Renewed X → Y`, `FAILED` errors |
| `[OptionSelection]`| Strike selection  | `WINNER:` with margin %, `OVER_PREMIUM` warnings, `⚠ NEGATIVE_MARGIN` |
| `[DeribitAdapter]` | Deribit execution | Order fills, execution details |
| `[V7Pricing]`      | Premium calculation | `slPct=X premium=$Y` |
| `[Treasury]`       | Treasury operations | Cycle execution, triggers, settlements |

### Health Checks

- `GET /pilot/health` — DB + price feed status.
- `GET /pilot/monitor/status` — Monitor health, consecutive failures, fill rate.
- `GET /pilot/monitor/alerts` — Recent system alerts.

---

## 13. Known Pilot Limitations

- **Deribit testnet**: Paper trades until KYC completes and `PILOT_VENUE_MODE` is flipped to `deribit_live`.
- **Single tenant**: One user hash for all positions.
- **Simulated perps**: Positions stored in localStorage, not a real exchange.
- **Manual settlement**: Premium/payout settlement tracked via admin dashboard actions; monthly net reconciliation per pilot agreement.
- **HTTP polling**: Price feeds poll every 3s (not WebSocket).
- **No automated alerts**: Monitoring via Render logs only during the pilot.
- **Frontend state**: Position history in localStorage can be lost if browser data is cleared.
- **Treasury disabled**: Treasury subsystem is built but intentionally not enabled during the retail pilot.
