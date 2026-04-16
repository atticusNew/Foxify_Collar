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
│  Backend API (FastAPI / Node + Fastify)                       │
│  ├── Pilot Routes — Quote, activate, monitor, admin          │
│  ├── Treasury Routes — Status, history, billing, execute     │
│  ├── Trigger Monitor — 3s polling for floor breaches         │
│  ├── Hedge Manager — TP logic, bounce detection, salvage     │
│  ├── Auto-Renew — Automated protection renewal at expiry     │
│  └── Treasury Scheduler — Daily automated treasury cycles    │
├─────────────────────────────────────────────────────────────┤
│  External Services                                           │
│  ├── Deribit — Options execution (testnet/live)              │
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

1. User selects position type (long/short), size ($10k-$50k), and SL% (2/3/5/10)
2. Frontend calls `POST /pilot/protections/quote`
3. Backend fetches spot price from Coinbase (fallback: Deribit perpetual)
4. Computes floor/trigger price: `entry × (1 - SL%/100)` for longs
5. Computes V7 premium: `notional / 1000 × ratePer1k` (e.g., $5/1k for 2%)
6. Calls Deribit `listInstruments("BTC")` to get available options
7. Filters by expiry window (requested tenor ± 2 days, min half-tenor)
8. Scores candidates by strike proximity, tenor alignment, and ITM preference
9. Fetches order book for top 8 candidates, applies cost cap
10. Returns quote with instrument, premium, strike, and expiry

### Activation Phase

1. User clicks "Open + Protect"
2. Frontend calls `POST /pilot/protections/activate` with quoteId
3. Backend retrieves cached quote, validates it hasn't expired
4. Executes market buy on Deribit for the selected option
5. Creates protection record in DB with status `active`
6. Creates sim position, price snapshot, venue execution, and ledger entry
7. Returns protection ID to frontend

### Monitoring Phase

1. Frontend polls `GET /pilot/protections/:id/monitor` every 5s
2. Returns current spot, distance to floor, time remaining, option mark
3. Trigger monitor runs independently every 3s server-side

### Trigger Phase

1. Trigger monitor detects `spot <= floorPrice` (longs) or `spot >= ceilingPrice` (shorts)
2. Atomically updates protection to `status: triggered` with optimistic lock
3. Records payout amount: `notional × SL%`
4. Credits sim position balance
5. Inserts ledger entry for `trigger_payout_due`
6. Hedge manager begins TP recovery cycle on the option

### TP Recovery Phase

1. Hedge manager evaluates triggered positions every 60s
2. Computes option value via Black-Scholes (put for longs, call for shorts)
3. Decision tree:
   - Near expiry (<10h) + value ≥ $3 → sell (salvage)
   - Deep drop (1.5%+ past strike) + past 10min → sell
   - Past 30min cooling + option OTM (bounced) + value ≥ $3 → sell
   - Prime window (0.5-8h) + value ≥ 0.25× payout → sell
   - Late window (8h+) + value ≥ 0.10× payout → sell
4. Executes market sell on Deribit
5. Records proceeds in metadata as `sellResult`

### Expiry Phase

1. Expiry resolver runs every 30s checking `expiry_at <= NOW()`
2. Fetches final spot price
3. Computes settlement: ITM puts → payout; OTM → zero
4. Sets status to `expired_itm` or `expired_otm`
5. If auto-renew enabled → auto-renew cycle creates new protection

### Active Salvage (Non-Triggered)

1. Hedge manager checks active positions within 8h of expiry
2. If option has ≥ $5 in value → sells to capture remaining time value
3. This recovers value from positions that never triggered

---

## 3. V7 Pricing Model

### Premium Schedule

| SL% | Rate per $1k | Tenor | Payout per $10k |
|-----|-------------|-------|-----------------|
| 2%  | $5.00       | 2 days | $200           |
| 3%  | $4.00       | 2 days | $300           |
| 5%  | $3.00       | 2 days | $500           |
| 10% | $2.00       | 2 days | $1,000         |

Premium formula: `notional / 1000 × ratePer1k`

Example: $50,000 at 2% SL = $50k / 1k × $5 = $250 premium

### Margin Economics

- **Spread** = Client Premium - Hedge Cost
- **Net P&L** = Total Spreads - Total Payouts + TP Recovery
- Target: positive spread on every trade (cost cap ensures this)

---

## 4. Option Selection Algorithm

### Phase A — Candidate Filtering & Ranking

1. Fetch all BTC options from Deribit
2. Filter by option type (puts for longs, calls for shorts)
3. Filter by expiry window: `[now + max(8h, tenor×0.5), now + tenor + 2 days]`
4. For trigger-aligned mode: filter strikes within 0.5% buffer of trigger price
5. Sort with asymmetric tenor penalty (too-short expiry penalized 3×)
6. ITM preference for ≤2.5% SL: puts at/above trigger get -2.0 bonus

### Phase B — Order Book Scoring

1. Fetch order books for top 8 candidates
2. Score: `costScore = ask + strikeDist × 0.5`
3. ITM bonus: `-0.002` for ITM candidates when preferItm is true
4. Cost cap: if hedge cost > client premium, proportional penalty added
5. Winner: lowest costScore

### Key Parameters

- `preferItm`: true when `drawdownFloorPct ≤ 0.025` (2% and 2.5% SL) and option type is put
- `strikeSelectionMode`: `trigger_aligned` (aligns strikes to trigger price)
- `maxTenorDriftDays`: 1.5 (max allowed deviation from requested tenor)
- `quotePolicy`: `ask_or_mark_fallback` (use ask price, fall back to mark if no ask)

---

## 5. Hedge Management & TP Logic

### Parameters

| Parameter | Value |
|-----------|-------|
| Cooling period | 30 min (10 min for deep drops) |
| Deep drop threshold | 1.5% past strike |
| Prime window | 0.5-8h after trigger |
| Prime threshold | 0.25× payout |
| Late threshold | 0.10× payout |
| Near-expiry salvage | <10h to expiry, min $3 |
| Active salvage | <8h to expiry, min $5 |
| Bounce detection | OTM after trigger, min $3 |
| Cycle interval | 60s |

### Bounce Detection

When a triggered position's option goes OTM (spot recovered past strike), the system sells immediately after the 30-min cooling period. An OTM option after trigger only loses time value — waiting gains nothing.

---

## 6. Trigger Monitoring

- **Interval**: 3 seconds
- **Primary price source**: Coinbase (`/products/BTC-USD/ticker`)
- **Fallback**: Deribit perpetual ticker
- **Retry**: 3 attempts with 180ms delay per source
- **Freshness check**: Rejects prices older than 5 seconds
- **Breach logic**: `spot ≤ triggerPrice` (longs), `spot ≥ triggerPrice` (shorts)
- **Atomic update**: Uses `WHERE status = 'active'` guard to prevent double-trigger
- **Batch size**: 50 protections per cycle
- **Error tracking**: Consecutive price errors logged, warning at 10+

---

## 7. Auto-Renew System

- **Interval**: 5 minutes
- **Candidates**: `auto_renew = true` AND `expiry_at` within 30 min ahead or 2 hours past
- **Protection type**: Reads from original protection (supports both long/short)
- **Dedup**: Skips if `metadata.renewedTo` already set
- **On success**: Creates new protection, patches old with `renewedTo` pointer
- **On failure**: Logs error, old protection stays active until expiry resolver handles it
- **Frontend**: Polls monitor, follows `renewedTo` chain to display new protection

---

## 8. Treasury Platform

### Overview

Separate system for institutional daily protection ($1M+ notional). Runs on the same infrastructure but with independent tables, routes, and scheduler.

### Daily Cycle

1. At scheduled execution time (configurable UTC hour/minute)
2. Gets current spot price
3. Computes floor: `spot × (1 - floorPct/100)`
4. Requests option quote from Deribit
5. Executes purchase
6. Records protection with premium, hedge cost, spread
7. Monitors for trigger throughout the day
8. Settles at expiry

### Structure: Fixed Payout

- Client pays daily premium (e.g., 25 bps of notional)
- If BTC breaches floor → client receives fixed payout (notional × floorPct)
- Option value beyond fixed payout is Atticus profit (TP recovery)

### Treasury Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/treasury/status` | Current protection status (Foxify view) |
| GET | `/treasury/history` | Protection history |
| POST | `/treasury/pause` | Pause daily execution |
| POST | `/treasury/resume` | Resume execution |
| POST | `/treasury/notional` | Adjust notional amount |
| POST | `/treasury/execute-now` | Force immediate execution |
| POST | `/treasury/reset` | Reset all treasury data |
| GET | `/treasury/admin/status` | Full admin view with P&L |
| GET | `/treasury/billing/summary` | Monthly billing breakdown |

---

## 9. API Reference — Retail Pilot

### Core Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/pilot/protections/quote` | None | Generate protection quote |
| POST | `/pilot/protections/activate` | None | Execute protection |
| GET | `/pilot/protections/:id/monitor` | None | Live protection status |
| GET | `/pilot/protections` | Admin | List all protections |
| GET | `/pilot/reference-price` | None | Current BTC spot price |
| GET | `/pilot/regime` | None | Current volatility regime |
| GET | `/pilot/health` | None | Platform health check |

### Admin Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/pilot/admin/metrics` | Aggregate P&L and metrics |
| GET | `/pilot/admin/diagnostics/execution-quality` | Fill rates and slippage |
| POST | `/pilot/admin/protections/:id/premium-settled` | Mark premium as settled |
| POST | `/pilot/admin/protections/:id/payout-settled` | Mark payout as settled |
| GET | `/pilot/admin/protections/:id/ledger` | Protection ledger entries |
| POST | `/pilot/admin/reset` | Reset all pilot data |
| GET | `/pilot/monitor/status` | Monitor health status |
| GET | `/pilot/monitor/alerts` | Recent alerts |

---

## 10. Database Schema — Core Tables

### pilot_protections
Primary table for all protection records.

Key columns: `id`, `user_hash`, `status`, `tier_name`, `sl_pct`, `drawdown_floor_pct`, `floor_price`, `entry_price`, `protected_notional`, `expiry_at`, `venue`, `instrument_id`, `size`, `execution_price`, `premium`, `payout_due_amount`, `auto_renew`, `hedge_status`, `metadata`

Status values: `pending_activation`, `active`, `triggered`, `expired_itm`, `expired_otm`, `cancelled`, `reconcile_pending`, `activation_failed`, `awaiting_expiry_price`, `awaiting_renew_decision`

### pilot_sim_positions
Simulated perp positions (frontend-driven).

Key columns: `id`, `user_hash`, `status`, `market_id`, `side`, `notional_usd`, `entry_price`, `sl_pct`, `protection_id`, `trigger_credited_usd`

### pilot_ledger_entries
Accounting trail for premiums and payouts.

Key columns: `id`, `protection_id`, `entry_type`, `amount`, `reference`

Entry types: `premium_due`, `premium_collected`, `trigger_payout_due`, `payout_due`, `payout_settled`

---

## 11. Environment Configuration

### Required for Pilot

| Variable | Purpose | Example |
|----------|---------|---------|
| `PILOT_API_ENABLED` | Enable pilot routes | `true` |
| `PILOT_ACTIVATION_ENABLED` | Enable trade execution | `true` |
| `PILOT_VENUE_MODE` | Execution venue | `deribit_test` or `deribit_live` |
| `DERIBIT_API_KEY` | Deribit credentials | (from Deribit) |
| `DERIBIT_API_SECRET` | Deribit credentials | (from Deribit) |
| `POSTGRES_URL` / `DATABASE_URL` | Database connection | (internal Render URL) |
| `PILOT_ADMIN_TOKEN` | Admin dashboard auth | (any secure string) |
| `V7_PRICING_ENABLED` | Enable V7 tiered pricing | `true` |
| `V7_DEFAULT_TENOR_DAYS` | Default option tenor | `2` |
| `VITE_PILOT_WIDGET` | Enable PilotWidget UI | `true` |
| `VITE_PILOT_ACCESS_CODE` | Frontend access gate | (any shared code) |
| `VITE_API_BASE` | Backend API URL | `https://foxify-pilot-new.onrender.com` |

### Optional Tuning

| Variable | Default | Purpose |
|----------|---------|---------|
| `PILOT_TRIGGER_MONITOR_INTERVAL_MS` | 3000 | Trigger check frequency |
| `PILOT_HEDGE_MGMT_INTERVAL_MS` | 60000 | TP evaluation frequency |
| `PILOT_AUTO_RENEW_INTERVAL_MS` | 300000 | Auto-renew check frequency |
| `PILOT_DERIBIT_MAX_TENOR_DRIFT_DAYS` | 1.5 | Max tenor deviation |
| `PILOT_STRIKE_SELECTION_MODE` | `trigger_aligned` | Strike alignment mode |
| `PILOT_DERIBIT_QUOTE_POLICY` | `ask_or_mark_fallback` | Order book pricing policy |

---

## 12. Monitoring & Logging

### Log Prefixes

| Prefix | System | What to Look For |
|--------|--------|-----------------|
| `[TriggerMonitor]` | Trigger detection | `TRIGGERED:` events, price errors, consecutive failure warnings |
| `[HedgeManager]` | TP recovery | `Selling (reason):` events, `Sell result:`, cycle summaries |
| `[AutoRenew]` | Protection renewal | `Renewed X → Y`, `FAILED` errors |
| `[OptionSelection]` | Strike selection | `WINNER:` with margin %, `OVER_PREMIUM` warnings |
| `[DeribitAdapter]` | Deribit execution | Order fills, execution details |
| `[V7Pricing]` | Premium calculation | `slPct=X premium=$Y` |
| `[Treasury]` | Treasury operations | Cycle execution, triggers, settlements |

### Health Checks

- `GET /pilot/health` — DB + price feed status
- `GET /pilot/monitor/status` — Monitor health, consecutive failures, fill rate
- `GET /pilot/monitor/alerts` — Recent system alerts

---

## 13. Known Pilot Limitations

- **Deribit testnet**: Paper trades until KYC completes
- **Single tenant**: One user hash for all positions
- **Simulated perps**: Positions stored in localStorage, not a real exchange
- **Manual settlement**: Premium/payout settlement tracked via admin actions
- **HTTP polling**: Price feeds poll every 3s (not WebSocket)
- **No automated alerts**: Monitoring via Render logs only
- **Frontend state**: Position history in localStorage can be lost if browser data cleared
