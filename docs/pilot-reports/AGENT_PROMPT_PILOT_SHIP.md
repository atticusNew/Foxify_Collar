# Agent Prompt: Atticus/Foxify Pilot Ship -- Full Execution Plan

## Context & Current State

**Repo:** `/workspace` (monorepo)
**Branch:** `cursor/-bc-e51d2b47-923d-4e8c-9cb9-44b1a0efb37c-4a4e`
**Base branch:** `cursor/bullish-locked-profile-phase-a`
**Latest commit:** `58a8968` -- "Update fixed premium chart: flat $11/1k across all tiers, 5-day tenor"
**PR:** https://github.com/atticusNew/Foxify_Collar/pull/14

**What exists and works:**
- Backend API at `services/api/` -- Fastify + TypeScript, full pilot protection engine
- Bullish SimNext testnet: auth, orderbook, option chain scanning, **two live fills confirmed** (order IDs `960800137131065345` and `960813609927573505`)
- Premium engine: $11/1k flat, 5-day tenor, IOC execution, price guard, auto-cancel
- 117/117 tests pass
- Rate limiting, monitoring, fill tracking, hedge optimizations (4 toggleable)
- ECDSA signing for V3CreateOrder via `/trading-api/v2/orders`
- Frontend skeleton at `apps/web/` -- React + Vite, has `PilotApp.tsx`, `SimpleSimPilotApp.tsx`
- Render deployment config at `render.yaml` (API web service + static site + Postgres)
- DB schema via `ensurePilotSchema` idempotent bootstrap (not versioned migrations)
- `funded_levels.json` defines Foxify FUNDED tier rules (Bronze $2.5k/Silver $5k/Gold $7.5k/Plat $10k)

**What's confirmed working (tested live on Bullish testnet):**
- ECDSA JWT login
- Market/option chain discovery (237 puts, 236 calls)
- Hybrid orderbook reads
- Option scoring + selection (spread-positive, dynamic strike)
- V3CreateOrder via `/trading-api/v2/orders` with IOC TIF
- WebSocket fill confirmation (order `960813609927573505` filled + confirmed)
- Price guard (staleness check before execution)

**Production readiness: 8.5/10.** Only gap: per-user auth (single tenant hash currently).

**Fixed premium:** $11/1k flat across all tiers. Validated via:
- Backtest: BS-derived across historical stress periods (all profitable)
- Live: 13 positions tested against real Bullish books (all spread-positive)
- Two real testnet fills ($5k Bronze +$15.33, $50k Gold +$63.53)

**Foxify FUNDED rules (from `funded_levels.json`):**

| Tier | Deposit | Funding | Drawdown | Position Cap |
|------|---------|---------|----------|-------------|
| Bronze | $500 | $2,500 | 20% | $2,500 |
| Silver | $0 | $5,000 | 15% | $5,000 |
| Gold | $0 | $7,500 | 12% | $7,500 |
| Platinum | $0 | $10,000 | 12% | $10,000 |

---

## Execution Phases (in order)

### PHASE 1: Platform Cleanup & Code Hygiene

**Goal:** Clean, organized codebase that a new engineer can read and understand.

1. **Remove dead/stale code:**
   - IBKR adapter in `venue.ts` (lines ~723-3229): mark with `@deprecated` JSDoc comment at class level but do NOT delete -- leave for reference. Remove IBKR from `render.yaml` env vars.
   - Remove duplicate CSV files at repo root (`Atticus_Foxify_fixedPremium_current.csv`, `Atticus_Foxify_fixedPremium_proposed_conservative.csv`, `Atticus_Foxify_fixedPremium_proposed_balanced.csv`) -- keep only `Atticus_Foxify_fixedPremium.csv`.
   - Remove `services/api/Atticus_Foxify_fixedPremium_*.csv` duplicates from services dir.

2. **Fix DB schema mismatch:** `upsertExecutionQualityDaily` in `db.ts` uses columns `day`, `hedge_mode` but CREATE TABLE uses `day_start` with no `hedge_mode`. Reconcile the DDL to match the insert path.

3. **Update `funded_levels.json`:** Change `fixed_price_usdc` to `"11"` for all tiers and `expiry_days` to `"5"` to match current validated rates.

4. **Update `render.yaml`:** Change `PILOT_VENUE_MODE` from `deribit_test` to `bullish_testnet`. Add Bullish env var placeholders (secrets injected via Render dashboard, not in yaml). Update branch to the shipping branch.

5. **Organize reports:** Move all analysis markdown files (`Atticus_Foxify_*.md`) into `docs/pilot-reports/`. Keep `docs/pilot_verification_20260405.md` in `docs/`.

6. **Run full test suite:** Ensure 117/117 still pass after cleanup. Fix any that break.

### PHASE 2: Frontend -- Pilot Widget

**Goal:** Simple, clean pilot frontend for Foxify CEO to simulate opening a protected perp position with real hedge execution.

**Tech:** React + Vite (already scaffolded at `apps/web/`). Use existing `PilotApp.tsx` as starting point.

**Architecture:** The frontend is a static SPA deployed on Render. It calls the backend API at `services/api`. For pilot, the API URL is configured via `VITE_API_BASE_URL` env var.

**UI flow (single page, three states):**

**State 1: Open Position Form**
- Live BTC price display (poll Bullish BTCUSDC mid every 3s via backend `/pilot/reference-price`)
- Inputs:
  - Position type: Long / Short toggle
  - Position size: dropdown matching funded_levels caps ($2,500 / $5,000 / $7,500 / $10,000)
  - Tier auto-selects based on position size (Bronze=$2.5k, Silver=$5k, Gold=$7.5k, Plat=$10k)
  - Stop Loss / Drawdown: auto-filled from tier (20% / 15% / 12% / 12%), read-only
- Below inputs, protection offer appears immediately (no extra click):
  - Header: "Protect Your Position"
  - Clear text: "If your position hits [X]% drawdown, you receive $[payout] instantly."
  - Premium: "Pay $[premium] for 5 days of protection"
  - Auto-renew checkbox (default on)
  - Two buttons: **"Open + Protect"** (primary, prominent) | "Open Without Protection" (secondary, subdued)
  
**CRITICAL: Price sync between perp and protection:**
- When user clicks "Open + Protect", the frontend captures the current BTC reference price
- Sends ONE request to backend that atomically: records the entry price, computes trigger, selects option, places hedge
- The backend `/pilot/protections/quote` already accepts `entryPrice` -- use this to lock the reference
- Backend flow: `resolveBullishReferencePrice` -> compute trigger -> `venue.quote` -> `venue.execute` (if activation enabled)
- For pilot: quote + display -> user confirms -> activate with locked quote ID
- The quote has a TTL (30s default). If user takes longer, re-quote with fresh price.

**State 2: Active Position View**
- Position card showing:
  - Position type + size + tier
  - Entry price
  - Live BTC price (updating)
  - Current PnL (calculated: `(current - entry) / entry * notional` for long, inverse for short)
  - Drawdown floor price (trigger)
  - Distance to floor (% and $)
  - Protection status badge: "Protected" (green) with time remaining
  - Auto-renew indicator
  - "Close Position" button
- If protection is active, show:
  - Time remaining on current protection cycle
  - Premium paid
  - Payout amount if triggered

**State 3: Position Closed / Triggered**
- If breach: show "Position Closed -- Protection Paid $[amount]" with green checkmark
- If user closed: show "Position Closed -- P&L: $[amount]"
- If protection expired without renewal: show prompt to renew or position is now unprotected
- For auto-renew: show "Protection renewed -- new cycle started" notification

**Protection renewal flow:**
- When protection expires and position is still open:
  - If auto-renew ON: backend automatically re-quotes at current spot, charges new premium, buys new put. User sees "Protection renewed" notification.
  - If auto-renew OFF: user gets prompt "Protection expired. Renew for $[premium]?" with button.
  - Renewal uses CURRENT spot as new entry anchor. Trigger price recalculates from current spot. This is correct because the user's risk has changed -- if BTC went from $67k to $70k, the new 20% floor is $56k not $53.6k.

**Auto-renew pricing clarification:**
- Each renewal is a fresh protection at the current spot price
- New premium charged at $11/1k of current notional
- New put purchased at optimal strike relative to new spot
- Old put expires (or sold if roll optimization is on)

**Guardrails during auto-renew:**
- If premium regime is in stress mode, surcharge applies (already implemented)
- If treasury is below critical threshold, monitor alerts fire (already implemented)
- If fill fails, consecutive failure counter increments (already implemented)
- If price is extremely volatile (>5% move during quote), price guard rejects and retries next cycle

### PHASE 3: Admin Dashboard

**Goal:** Simple admin view for platform operator (behind auth).

**Access:** `/admin` route, protected by `PILOT_ADMIN_TOKEN` (entered once, stored in sessionStorage).

**Dashboard panels:**

1. **Platform Health**
   - `GET /pilot/monitor/status` -- healthy badge, consecutive failures, fill rate
   - `GET /pilot/health` -- config surface, venue mode, treasury
   - Treasury balance (via `POST /pilot/monitor/treasury-check`)

2. **Active Protections**
   - `GET /pilot/admin/metrics` -- total protections, active count, premium collected, payouts
   - List of active protections with: user, tier, notional, entry price, trigger, status, time remaining

3. **Execution Quality**
   - `GET /pilot/admin/diagnostics/execution-quality` -- fill rate, slippage, latency
   - Recent fills with spread analysis

4. **Alerts**
   - `GET /pilot/monitor/alerts` -- recent alerts (treasury, fill failures, negative spreads)

5. **Config Levers** (display only for pilot, admin can read but not write via UI)
   - Premium rate, tenor, hedge optimization toggles, regime thresholds
   - Show as a read-only config panel with current values

### PHASE 4: Transaction Flow & Tracking

**Goal:** Track all financial flows as if live production, even though pilot premiums/payouts are settled manually post-pilot.

**Already in place:**
- `pilot_ledger_entries` table: records `premium_due`, `premium_settled`, `payout_due`, `payout_settled`
- `pilot_venue_executions` table: records every hedge fill with price, qty, fees
- `pilot_venue_quotes` table: records every quote with premium, instrument, details
- `pilot_price_snapshots`: records entry/expiry/trigger prices

**What needs to be added/verified:**

1. **Perp price tracking:** The trigger monitor (`triggerMonitor.ts`) already polls reference price and checks breach. Verify it's polling Bullish (not Coinbase) when locked profile is active. Verify interval is appropriate (default 5s).

2. **Two-path close on breach:**
   - USER SIDE: protection status -> `triggered`, payout_due ledger entry, position closed
   - ATTICUS SIDE: option STAYS OPEN. Do NOT sell the put on breach. Let it continue gaining value or expire. Add a flag `hedge_status` to protection metadata: `"active"` | `"expired"` | `"sold"` to track independently.

3. **Option expiry handling:** When the put expires:
   - If ITM: Bullish settles automatically to the trading account (cash-settled options). Atticus receives the intrinsic value in USDC.
   - If OTM: expires worthless, no action needed.
   - Track via `pilot_venue_executions` with a new entry type or metadata update.

4. **Premium flow (pilot):** Premium is recorded in ledger as `premium_due`. Post-pilot, admin marks as `premium_settled` via `POST /pilot/admin/protections/:id/premium-settled`. For production: integrate with Foxify custody or Arbitrum smart contract for real-time settlement.

5. **Payout flow (pilot):** Payout recorded as `payout_due`. Post-pilot, admin marks as `payout_settled` via `POST /pilot/admin/protections/:id/payout-settled`. For production: instant transfer from Atticus/Foxify custody account.

### PHASE 5: Deployment & Infrastructure

**Render setup (pilot):**
- **API:** Web service on Render, `npm --workspace services/api exec tsx src/server.ts`
- **Frontend:** Static site on Render, `npm --workspace apps/web run build`, publish `apps/web/dist`
- **Database:** Render Postgres (basic-256mb for pilot)
- **Secrets:** Bullish credentials injected via Render dashboard (not in render.yaml)

**Update `render.yaml`:**
- Change branch to shipping branch
- Change `PILOT_VENUE_MODE` to `bullish_testnet`
- Add `PILOT_BULLISH_ENABLED: "true"`
- Add placeholder comments for Bullish secrets (injected via dashboard)
- Add `PILOT_ACTIVATION_ENABLED: "true"` (required for live execution)
- Set `PILOT_BULLISH_ORDER_TIF: IOC`
- Set `PILOT_TENOR_DEFAULT_DAYS: "5"`

**For production readiness (post-pilot):**
- Move API to dedicated VPS if needed for lower latency to Bullish
- Add Redis for quote caching if volume requires it
- Add proper secret management (Vault or similar)
- Database: migrate to managed Postgres with connection pooling

### PHASE 6: Security Hardening

**For pilot (minimal, isolated):**
- Admin routes already behind `x-admin-token` + IP allowlist -- sufficient
- Rate limiting implemented (60 req/min per IP) -- sufficient
- Single-user tenant hash -- acceptable for pilot with one user
- HTTPS enforced by Render -- sufficient
- No secrets in codebase -- confirmed

**For production (post-pilot):**
- Per-user JWT authentication (integrate with Foxify auth system)
- Per-user rate limiting (not just per-IP)
- Versioned DB migrations (replace `CREATE TABLE IF NOT EXISTS` bootstrap)
- Audit logging for all admin actions (already in `pilot_admin_actions` table)
- Secret rotation capability for Bullish API keys

### PHASE 7: Documentation

**Create three separate documents:**

1. **Technical Documentation (`docs/TECHNICAL_GUIDE.md`):**
   - Architecture diagram: Frontend -> API -> Bullish -> Postgres
   - File map: every file in `src/pilot/` with purpose
   - API reference: every endpoint with request/response shapes
   - Configuration reference: every env var with description, default, constraints
   - Database schema reference with column descriptions
   - Hedge execution flow: quote -> select option -> price guard -> IOC order -> WS fill -> record
   - Premium computation flow: notional -> $11/1k -> premium
   - Trigger monitoring flow: poll price -> check breach -> payout -> close user side -> keep option

2. **Operational Documentation (`docs/OPERATIONS_GUIDE.md`):**
   - Platform objectives: Atticus protects Foxify Funded trader deposits via BTC options
   - How it got here: testnet validation, two live fills, premium derivation, stress testing
   - Pilot scope: single user (Foxify CEO), simulated perp, real hedge execution on Bullish testnet
   - Key levers and how to adjust: premium rate, tenor, hedge optimization toggles, strike selection, regime thresholds
   - Monitoring: what to watch, what alerts mean, how to respond
   - Incident procedures: fill failure, treasury depletion, Bullish outage

3. **Testnet-to-Mainnet Transition Guide (`docs/MAINNET_TRANSITION.md`):**
   - Step-by-step instructions for lead engineer:
     1. Obtain Bullish mainnet API credentials (ECDSA key pair + metadata)
     2. Update env vars: change `PILOT_BULLISH_REST_BASE_URL` from `api.simnext.bullish-test.com` to `api.exchange.bullish.com`
     3. Update private/public WS URLs similarly
     4. Run credential validation: `npm run -s pilot:bullish:key-check` (expect all fields present + parses)
     5. Run auth test: `npm run -s pilot:bullish:auth-debug` (expect `publicPrivateMatch: true`)
     6. Run smoke test: `npm run -s pilot:bullish:smoke -- --symbol BTCUSDC` (expect `status: ok`, trading accounts listed)
     7. Verify option chain: confirm puts/calls available on mainnet
     8. Run one quote (no execution): verify pricing, option selection, spread
     9. Enable execution: set `PILOT_BULLISH_ENABLE_EXECUTION=true`
     10. Run one small testnet-equivalent order ($500 notional) with `PILOT_ACTIVATION_ENABLED=true`
     11. Verify fill via WebSocket and/or REST fallback
     12. Confirm ledger entries recorded correctly
   - Expected outcomes for each step
   - Things to watch: mainnet spreads will be tighter than testnet (prices should be better), mainnet has real capital at stake
   - Rollback procedure: set `PILOT_BULLISH_ENABLE_EXECUTION=false` to disable all execution instantly

### PHASE 8: Final Verification

1. Run full test suite: 117/117 must pass
2. Deploy to Render staging
3. Foxify CEO walks through: open position -> see protection offer -> accept -> see active position -> (simulate breach or close)
4. Admin verifies: dashboard shows protection, fills, premiums, alerts
5. Confirm no errors in logs
6. Lock and tag release

---

## Key Technical Details for New Agent

**Bullish API quirks:**
- ECDSA orders use `/trading-api/v2/orders` path, NOT `/trading-api/v2/command`
- V3CreateOrder command type with `"LIMIT"` (not `"LMT"`)
- `clientOrderId` must be numeric (i64 as string)
- Sign canonical string directly (NOT the SHA-256 hexdigest for orders path)
- `BX-PUBLIC-KEY` header is NOT needed for ECDSA orders -- JWT Bearer is sufficient
- Option symbols: `BTC-USDC-YYYYMMDD-STRIKE-P` (puts) or `-C` (calls)

**Price sync (atomic protection):**
- Backend `resolveBullishReferencePrice` gets BTCUSDC mid from Bullish orderbook
- Same price used for: entry anchor, trigger calculation, and option selection
- Quote TTL: 30s -- if user takes longer, re-quote
- Price guard on execution: rejects if ask moved >5% since quote

**funded_levels.json** currently has stale fixed prices. Update to match $11/1k flat rate.

**The `pilotConfig.activationEnabled` flag** must be `true` for real execution. Currently defaults to `false`. Set via `PILOT_ACTIVATION_ENABLED=true` in env.
