# Atticus / Foxify Pilot — Technical Guide

This document describes the **Atticus/Foxify pilot protection platform**: a Bitcoin options protection layer that hedges Foxify Funded trader deposits using exchange-traded BTC options (Bullish SimNext testnet in the current pilot).

---

## 1. Architecture Overview

### Request path

```
React + Vite SPA (apps/web)
        │
        ▼  HTTPS (JSON)
Fastify API (services/api, TypeScript)
        │
        ├──► Bullish Exchange (REST + WebSocket) — quotes, IOC orders, fills
        │
        └──► PostgreSQL — protections, ledger, venue audit, sim state, diagnostics
```

### Deployment model

- **Frontend**: Static build of the Vite SPA, suitable for hosting as a static site (e.g. Render static).
- **Backend**: Node process running the Fastify server as a long-lived web service (e.g. Render web service).
- **Exchange**: **Bullish SimNext testnet** for option discovery, pricing, and execution during the pilot.
- **Database**: Postgres holds all durable pilot state (protections, snapshots, venue quotes/executions, admin/sim/monitoring data).

### Tenancy and identity

The pilot uses a **single logical tenant**: `PILOT_TENANT_SCOPE_ID` (default `foxify-pilot`). That value is normalized and passed through **HMAC-SHA256** with `USER_HASH_SECRET` to produce a stable **`user_hash`** (`hash.ts`). All protections, sim positions, and ledger rows for the pilot share this tenant hash unless operators override scope or hashing for advanced testing.

### Runtime profiles

When `PILOT_PROFILE=bullish_locked_v1`, the runtime **locks** venue to `bullish_testnet`, forces Bullish-only execution paths, and pins several pricing/selector behaviors (see `config.ts` `lockedProfile` / `bullishLockedProfile`).

---

## 2. File Map

All paths are relative to the repository root.

### `services/api/src/pilot/` (backend pilot module)

| File | Purpose |
|------|---------|
| **`routes.ts`** | Registers **all** pilot HTTP routes: protections (quote, activate, list, monitor, proof, export, renewal), terms, sim, health, tenor policy, admin/diagnostics/settlement, monitor/treasury, and internal hooks (e.g. expiry resolution, sim trigger monitor). |
| **`venue.ts`** | **Venue adapters** implementing `PilotVenueAdapter`: FalconX (live RFQ), **mock FalconX**, **Deribit test**, **IBKR CME** (live/paper — legacy/deprecated for the Bullish pilot), and **`BullishTestnetAdapter`** (active path for SimNext). Factory: `createPilotVenueAdapter`. |
| **`db.ts`** | **`ensurePilotSchema`**: `CREATE TABLE IF NOT EXISTS` / `ALTER` migrations for **15+ tables**; connection pooling; and the **data access layer** (insert/list/patch helpers for protections, quotes, executions, ledger, sim, terms, hedge decisions, execution quality, etc.). |
| **`config.ts`** | Central **`pilotConfig`**: parses env vars into typed runtime config (venue mode, Bullish client settings, premium/hedge/tenor/regime knobs, admin/proof tokens, IP allowlist, pilot window, locked profile). |
| **`types.ts`** | Shared TypeScript types for protections, venue records, sim, diagnostics payloads, etc. |
| **`pricingPolicy.ts`** | Client **premium** resolution: **actuarial_strict** vs **hybrid_otm_treasury**, broker-fee estimates, caps, diagnostics for quotes and activation. |
| **`protectionMath.ts`** | **Drawdown budget** in USD and related math used when evaluating loss vs floor (breach / payout logic). |
| **`floor.ts`** | Tier defaults, **trigger / floor price** derivation, expiry/renew window helpers, tier normalization. |
| **`price.ts`** | **Reference price snapshots**: primary URL + optional fallback chain, timeouts, retries, freshness — used for marks and operational pricing. |
| **`hash.ts`** | **`buildUserHash`**: HMAC-SHA256 over normalized user/tenant id with server secret (`USER_HASH_SECRET`). |
| **`triggerMonitor.ts`** | Background **breach scanning** for active protections using Bullish reference pricing; coordinates status transitions (e.g. `payout_due`, user-side closure semantics). |
| **`regimePolicy.ts`** | **Hedge regime** resolution: **calm / neutral / stress** — drives tenor/strike guardrails for the optimizer path. |
| **`premiumRegime.ts`** | **Premium overlay** state machine: **normal / watch / stress** — optional surcharge multipliers based on operational metrics (trigger rate, subsidy, treasury drawdown). |
| **`hedgeCandidates.ts`** | Builds **strike/tenor candidate ladders** for option selection. |
| **`hedgeScoring.ts`** | **Optimizer-weighted scoring** across candidates (subsidy, tail risk, liquidity, fill risk, basis, carry, tenor drift, strike distance, etc.). |
| **`modelComparison.ts`** | Side-by-side **pricing model comparison** utilities for diagnostics and quote transparency. |
| **`marketData.ts`** | **Options chain adapter** interface / plumbing for pulling normalized chain snapshots where applicable. |
| **`bullish.ts`** | **`BullishTradingClient`**: REST (login, nonce, command, markets, hybrid order book, order placement path), **ECDSA or HMAC** auth, **private WebSocket** subscriptions (e.g. orders/fills). |
| **`monitor.ts`** | **`PilotMonitor`**: platform health signals, alert buffer, **treasury balance** checks via Bullish client. |
| **`hedgeOptimizations.ts`** | Four **toggleable optimizations**: auto-renew tenor, roll, batch hedging, dynamic strike range — each gated by env-driven config. |
| **`migrate.ts`** | CLI-style entry to run **`ensurePilotSchema`** against configured Postgres (schema bootstrap for empty DBs). |

### `apps/web/src/` (frontend)

| File | Purpose |
|------|---------|
| **`PilotWidget.tsx`** | Primary **3-state** pilot UX: configure → **active** protection → **closed** / post-state. |
| **`AdminDashboard.tsx`** | **Admin** surface: metrics, diagnostics, **settlement** actions aligned with admin API routes. |
| **`PilotApp.tsx`** | **Legacy** pilot UI kept for reference / regression comparison. |
| **`SimpleSimPilotApp.tsx`** | Lightweight **simulation** UI for sandbox flows. |
| **`config.ts`** | Frontend **environment flags** (API base URL, feature toggles, etc.). |
| **`main.tsx`** | SPA **entry** and router: includes **path-based** routing for **`/admin`**. |

---

## 3. API Reference

Conventions:

- **`PILOT_API_ENABLED`** must be `"true"` for pilot routes to mount.
- **Tenant scope**: most user-facing routes derive identity from **`resolveTenantScopeHash()`** (`PILOT_TENANT_SCOPE_ID` + `USER_HASH_SECRET`). Optional header **`x-user-id`** can appear on some quote paths for attribution experiments; ownership checks still use the tenant hash for standard flows.
- **Admin auth**: `x-admin-token` must match **`PILOT_ADMIN_TOKEN`**. If **`PILOT_ADMIN_IP_ALLOWLIST`** is non-empty, the client IP (or `PILOT_ADMIN_TRUSTED_IP_HEADER` hop) must be listed.
- **Proof auth**: `GET /pilot/protections/:id/proof` requires **`PILOT_PROOF_TOKEN`** via `x-proof-token` or `Authorization: Bearer …`.
- **Internal auth**: internal routes accept **`x-internal-token`** matching the configured internal token, or admin credentials.

### Protections and pricing

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/pilot/reference-price` | Public (pilot enabled) | **BTC reference price**; when **`bullish_locked_v1`** is active, resolves **Bullish mid** for the mapped symbol instead of the generic reference feed. |
| POST | `/pilot/protections/quote` | Tenant hash (config) | **Quote** protection: venue quote, premium policy output, diagnostics, tenor policy hints. |
| POST | `/pilot/protections/activate` | Tenant hash | **Activate** protection: consumes quote, may place **IOC** hedge on Bullish when execution enabled, persists protection + venue rows. |
| GET | `/pilot/protections` | Tenant hash | **List** protections for the tenant. |
| GET | `/pilot/protections/:id` | Tenant hash + ownership | **Get** one protection. |
| GET | `/pilot/protections/:id/monitor` | Tenant hash + ownership | **Monitor** payload for an active protection (status, marks, key timestamps). |
| GET | `/pilot/protections/:id/proof` | **Proof token** | **Cryptographic / essential proof** bundle for external verification. |
| GET | `/pilot/protections/export` | **Admin** | **Export** protections as JSON or **`?format=csv`** for the tenant scope. |
| POST | `/pilot/protections/:id/renewal-decision` | Tenant hash + ownership | Record **auto-renew** decision at expiry window. |

### Terms

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/pilot/terms/status` | Tenant hash | Whether terms for the current version are accepted. |
| POST | `/pilot/terms/accept` | Tenant hash | Record terms acceptance (IP, user agent, version). |

### Simulation

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/pilot/sim/positions/open` | Tenant hash | Open a **sim** position (optional linked protection). |
| GET | `/pilot/sim/positions` | Tenant hash | **List** sim positions. |
| POST | `/pilot/sim/positions/:id/close` | Tenant hash | **Close** sim position with mark from price resolver. |
| GET | `/pilot/sim/platform/metrics` | Tenant hash | Aggregate **sim platform** metrics + recent treasury ledger. |
| GET | `/pilot/sim/account/summary` | Tenant hash | **Account-style summary** over open/closed sim state and ledger. |

### Health and policy

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/pilot/health` | Public | Liveness / dependency snapshot for the pilot subsystem. |
| GET | `/pilot/tenor-policy` | Public | **Dynamic tenor policy** rows and versioning (when enabled). |

### Admin

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/pilot/admin/metrics` | Admin | Aggregated **admin metrics** (protections, usage, diagnostics). |
| GET | `/pilot/admin/diagnostics/selector` | Admin | **Selector** diagnostics (scoring, last decisions). |
| GET | `/pilot/admin/diagnostics/execution-quality` | Admin | Recent **execution quality** samples. |
| GET | `/pilot/admin/governance/rollout-guards` | Admin | **Rollout guard** status (pause/fallback thresholds). |
| POST | `/pilot/admin/protections/:id/premium-settled` | Admin | Mark **premium settled** (ledger + metadata). |
| POST | `/pilot/admin/protections/:id/payout-settled` | Admin | Mark **payout settled** with optional tx reference. |
| GET | `/pilot/admin/protections/:id/ledger` | Admin + ownership | **Ledger** entries for a protection (admin view). |
| GET | `/pilot/admin/protections/:id/monitor` | Admin | **Monitor** any protection id without tenant ownership check (ops). |
| POST | `/pilot/admin/protections/archive-except-current` | Admin | Archive historical protections for tenant, optionally keeping one id. |

### Monitor (operational)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/pilot/monitor/status` | Admin token (no actor envelope required) | **Monitor** heartbeat: health, failure counts, fill rate aggregates. |
| GET | `/pilot/monitor/alerts` | Admin token | **Recent alerts** (`limit` query, capped). |
| POST | `/pilot/monitor/treasury-check` | Admin token | On-demand **treasury** balance snapshot via Bullish private API. |

### Internal / automation

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/pilot/internal/sim/trigger-monitor/run` | **Internal token** or admin | Run one **sim trigger monitor** cycle (testing/cron). |
| POST | `/pilot/internal/protections/:id/resolve-expiry` | **Internal token** or admin | Force **expiry resolution** for a protection (settlement path). |

The route module also registers a **background interval** (configurable via `EXPIRY_RETRY_INTERVAL_MS`, default 30000 ms) to resolve expired protections that still lack `expiry_price`, and optionally **`registerPilotTriggerMonitor`** when `triggerMonitorEnabled` is set in config.

---

## 4. Configuration Reference

Values below are **code defaults** from `config.ts` / related parsers unless noted. Production may override heavily via env.

### Core pilot switches

| Variable | Default / notes |
|----------|------------------|
| `PILOT_API_ENABLED` | Must be `"true"` to expose routes. |
| `PILOT_ACTIVATION_ENABLED` | **`false`** — must be **`true`** for real venue execution (Bullish orders). |
| `PILOT_VENUE_MODE` | **`bullish_testnet`** (if unset). Other values: `falconx`, `mock_falconx`, `deribit_test`, `ibkr_cme_live`, `ibkr_cme_paper`. |
| `PILOT_PROFILE` | `default` or **`bullish_locked_v1`** (locks Bullish testnet + pinned economics). |

### Tenant, hashing, tokens

| Variable | Default / notes |
|----------|------------------|
| `PILOT_TENANT_SCOPE_ID` | **`foxify-pilot`** — raw id before HMAC. |
| `USER_HASH_SECRET` | **Required** for tenant hash derivation (empty → errors on hash build). |
| `PILOT_ADMIN_TOKEN` | Admin bearer (**`x-admin-token`**). |
| `PILOT_ADMIN_IP_ALLOWLIST` | Optional comma-separated IPs; if set, enforced with token. |
| `PILOT_ADMIN_TRUSTED_IP_HEADER` | Optional trusted proxy header for client IP resolution. |
| `PILOT_PROOF_TOKEN` | Enables proof endpoint auth. |
| `PILOT_INTERNAL_TOKEN` | Accepts internal routes when matched on **`x-internal-token`**. |

### Bullish (`PILOT_BULLISH_*`)

| Variable | Default / notes |
|----------|------------------|
| `PILOT_BULLISH_ENABLED` | `false` — gate Bullish integration. |
| `PILOT_BULLISH_REST_BASE_URL` / `PILOT_BULLISH_API_HOSTNAME` | REST base (hostname fallback supported). |
| `PILOT_BULLISH_PUBLIC_WS_URL` | Default `wss://api.exchange.bullish.com/trading-api/v1/market-data/orderbook`. |
| `PILOT_BULLISH_PRIVATE_WS_URL` | Default `wss://api.exchange.bullish.com/trading-api/v1/private-data`. |
| `PILOT_BULLISH_AUTH_MODE` | **`ecdsa`** (or `hmac`). |
| `PILOT_BULLISH_ECDSA_*` / `PILOT_BULLISH_HMAC_*` | Keys/secrets for chosen mode. |
| `PILOT_BULLISH_TRADING_ACCOUNT_ID` | Trading account for commands. |
| `PILOT_BULLISH_DEFAULT_SYMBOL` | `BTCUSDC`. |
| `PILOT_BULLISH_SYMBOL_MAP` | Optional `marketId:symbol` comma list. |
| `PILOT_BULLISH_*_PATH` | Login, nonce, command, trading accounts, orderbook template overrides. |
| `PILOT_BULLISH_ENABLE_EXECUTION` | `false` — separate from activation; both must allow live orders. |
| `PILOT_BULLISH_ORDER_TIMEOUT_MS` | Order / request timeout budget. |
| `PILOT_BULLISH_ORDER_TIF` | **`IOC`** (also `DAY`, `GTC`). |
| `PILOT_BULLISH_ALLOW_MARGIN` | `false`. |
| `PILOT_BULLISH_PRICE_STALENESS_MAX_PCT` | Default **`5`** (percent) — max acceptable move of **best ask** vs quoted unit price before execution is rejected (`price_staleness_exceeded`). |
| `PILOT_BULLISH_MAX_HEDGE_COST_PER_1K` | Optional cap when scoring Bullish candidates. |

### Tenor and window

| Variable | Default / notes |
|----------|------------------|
| `PILOT_TENOR_MIN_DAYS` | **1** |
| `PILOT_TENOR_MAX_DAYS` | **7** |
| `PILOT_TENOR_DEFAULT_DAYS` | Parser fallback **7** (must sit within min/max). Foxify pilot docs often target **5 days** — set the env explicitly to `5` if min/max bounds allow. |
| `PILOT_FIXED_TENOR_DAYS` | **7** when not using locked profile branch (locked profile uses fixed **7** in code). |
| `PILOT_ENFORCE_WINDOW` | When not `"false"`, enforces `PILOT_START_AT` + `PILOT_DURATION_DAYS` (default 30 days). |

### Premium, selector, hedge policy

| Variable | Default / notes |
|----------|------------------|
| `PILOT_PREMIUM_PRICING_MODE` | `actuarial_strict` (unless locked profile → `hybrid_otm_treasury`). |
| `PILOT_PREMIUM_POLICY_MODE` | `legacy` (locked → `pass_through_markup`). |
| `PILOT_SELECTOR_MODE` | `strict_profitability` (locked profile forces strict). |
| `PILOT_HEDGE_POLICY` | `options_primary_futures_fallback`. |
| `PILOT_PREMIUM_POLICY_VERSION` | `v2`. |
| `PILOT_PREMIUM_ENFORCE` / `PILOT_ENFORCE_PREMIUM_CAP` | `false`. |
| `PILOT_OPTION_SELECTION_*_WEIGHT` | Weights for legacy selection scoring. |
| `PILOT_PREMIUM_TRIGGER_*` | Tier trigger probability inputs for actuarial path. |
| `PILOT_HEDGE_OPTIMIZER_*` | Normalization bounds, weights, hard constraints for optimizer scoring. |

### Regime and rollout

| Variable | Default / notes |
|----------|------------------|
| `PILOT_HEDGE_REGIME_*` | Calm / neutral / stress strike and tenor bounds. |
| `PILOT_GUARD_*` | Rollout guard thresholds (trigger hit rate, subsidy utilization, treasury drawdown). |
| `PILOT_PREMIUM_REGIME_*` | Premium overlay enablement, dwell times, thresholds, surcharges. |

### Database

| Variable | Default / notes |
|----------|------------------|
| `PILOT_DB_CONNECT_TIMEOUT_MS` | `3000` |
| `PILOT_DB_QUERY_TIMEOUT_MS` | `7000` |

---

## 5. Database Schema

Tables are created in **`ensurePilotSchema`** (`db.ts`). Below are the **operator-facing** tables plus closely related audit tables.

### Core protection lifecycle

- **`pilot_protections`** — Canonical protection row: tenant `user_hash`, tier/floor, notional, entry/expiry prices, venue instrument, sizes, premium, execution ids, payout fields, status, JSON `metadata`, timestamps.
- **`pilot_price_snapshots`** — Immutable **price observations** tied to a protection (entry, expiry, marks, etc.) with source and request correlation.
- **`pilot_ledger_entries`** — **Accounting ledger** lines (premium, payout, adjustments) per protection.

### Venue audit

- **`pilot_venue_quotes`** — Each **quote** offered to the client (venue, instrument, side, qty, premium, TTL, `details` JSON, consumption linkage).
- **`pilot_venue_executions`** — Each **execution** attempt outcome (success/failure, external order/fill ids, pricing).

### Quality and selection

- **`pilot_execution_quality_daily`** — **Reconciled daily rollups** per venue/day/`hedge_mode`: fill success rate, slippage, spread, depth, sample counts (used in governance/diagnostics).
- **`pilot_hedge_decisions`** — **Optimizer audit**: regime, selector mode, chosen candidate, score breakdown, full candidate set JSON for replay.

### Simulation

- **`pilot_sim_positions`** — Sim trader positions, optional link to `pilot_protections`, trigger credits, PnL metadata.
- **`pilot_sim_treasury_ledger`** — Sim **treasury** movements tied to positions/protections.

### Governance and compliance

- **`pilot_admin_actions`** — Append-only style record of **admin** operations (actor, IP, JSON details).
- **`pilot_terms_acceptances`** — **Terms** acceptance per `user_hash` + version (unique constraint).

### Usage caps

- **`pilot_daily_usage`** — **Per-user per-day** protected notional accumulator (rate limits / caps).
- **`pilot_daily_treasury_subsidy_usage`** — **Per-user per-day** treasury subsidy consumption tracker.

### Additional chain / RFQ tables (supporting)

- **`pilot_options_chain_snapshots`** — Historical option chain rows (bid/ask/greeks) for analytics.
- **`pilot_rfq_quotes`** / **`pilot_rfq_fills`** — RFQ-style quote/fill audit (non-Bullish paths / legacy).
- **`pilot_user_day_locks`** — Lightweight **idempotency / day lock** keys for concurrent operations.

---

## 6. Execution Flows

### 1. Hedge execution (Bullish testnet)

1. **Quote** (`POST /pilot/protections/quote`): venue adapter pulls **hybrid order book**; `BullishTestnetAdapter` scores nearby expiries/strikes and selects an option; premium economics checked against policy.
2. **Select option**: symbol like **`BTC-USDC-YYYYMMDD-STRIKE-P/C`** (parsed via `parseBullishOptionSymbol`); quantity aligned to BTC hedge size.
3. **Price guard (staleness)**: on **`execute`**, refresh order book; if **best ask** moved beyond **`PILOT_BULLISH_PRICE_STALENESS_MAX_PCT`** vs the quoted **per-unit** price, return structured **failure** (`price_staleness_exceeded`) without sending an aggressive fill.
4. **IOC order**: **`V3CreateOrder`** command (ECDSA mode) via **`POST`** to configured **`commandPath`** (default **`/trading-api/v2/command`**); REST **`/trading-api/v2/orders`** is also used in the client for related flows. **`timeInForce`** comes from **`PILOT_BULLISH_ORDER_TIF`** (default **IOC**).
5. **WebSocket fill confirmation**: private WS subscription on the **orders** topic confirms state transitions / fills where implemented.
6. **Record**: `pilot_venue_executions`, update `pilot_protections`, append `pilot_ledger_entries`, and optional execution-quality upserts.

### 2. Premium computation (pilot flat display vs policy)

- **Client-facing simple rule** (Bullish adapter scoring): **`$11 per $1,000`** protected notional appears in selection scoring as `premiumPer1k: 11` / `protectedNotional / 1000 * 11` for spread checks against hedge cost.
- **`pricingPolicy.ts`** computes the **contractual premium** for quotes/activation under **`PILOT_PREMIUM_PRICING_MODE`** (**actuarial_strict** vs **hybrid_otm_treasury**), optional **premium regime overlay** (`premiumRegime.ts`), caps, and pass-through markup when configured.

### 3. Trigger monitoring

1. **Poll** Bullish-based **reference mid** (when locked profile) or configured reference feeds.
2. **Breach detect** using floor/trigger math (`floor.ts`, `protectionMath.ts`): if spot breaches the protection trigger, compute **`payout_due`** amounts.
3. **User side**: mark protection **`triggered`** / payout due, **close** trader-visible protection state while **hedge leg** may remain **active** (exchange option position retained for treasury/ops settlement — **`hedge_status: active`** semantics in metadata/status transitions as implemented in `triggerMonitor.ts` + `routes.ts`).

---

## 7. Bullish API Integration

### Authentication

- **ECDSA JWT** session (default **`PILOT_BULLISH_AUTH_MODE=ecdsa`**): PEM private key signs login; bearer token reused for REST and private WebSocket (`Authorization` + cookie-style JWT header where required).
- **HMAC** mode remains supported for alternate deployments (`hmac` login + command signing).

### Order placement

- Primary command: **`V3CreateOrder`** with **`type: "LIMIT"`**, side **`BUY`/`SELL`**, **`timeInForce`** from config (**IOC** in pilot), **`tradingAccountId`**, and client order id.
- HTTP surface: commands posted to **`commandPath`** (default `/trading-api/v2/command`); the trading client also references **`/trading-api/v2/orders`** for order operations.

### Market data

- **Hybrid order book** REST template default: `/trading-api/v1/markets/:symbol/orderbook/hybrid`.
- **Public WebSocket** for L1/L2 order book snapshots (subscribe to `l2Orderbook` / heartbeat).

### Symbol convention

- Options: **`BTC-USDC-YYYYMMDD-STRIKE-P`** (put) or **`...-C`** (call), parsed to strike, expiry, and right in `bullish.ts` / adapter.

### Risk controls

- **IOC** minimizes resting liquidity risk.
- **Staleness guard**: default **5%** max deviation of fresh **ask** vs quoted unit price (`PILOT_BULLISH_PRICE_STALENESS_MAX_PCT`).
- **`PILOT_BULLISH_ENABLE_EXECUTION`** and **`PILOT_ACTIVATION_ENABLED`** provide **two-layer** kill switches for production safety.

---

## Related documentation

For deployment specifics, see `docs/DEPLOYMENT.md`. For a narrower HTTP catalog, see `docs/pilot-api.md` / `docs/API_REFERENCE.md`. This guide focuses on the **`services/api/src/pilot`** implementation as wired for the **Foxify** pilot.
