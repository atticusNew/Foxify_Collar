# Live Production Readiness — Migration Guide

This document covers what needs to change to move from the pilot platform to a live production system serving Foxify's user base.

---

## 1. Deribit Live Execution

### What Changes
Single environment variable:
```
PILOT_VENUE_MODE=deribit_live
```

### Prerequisites
- Deribit mainnet KYC approved
- Live API key and secret generated (with trading permissions)
- Sufficient USDC/BTC balance deposited on Deribit
- Test with a small position ($10k) on live before opening to users

### What Stays the Same
- All option selection logic, TP logic, trigger monitoring, auto-renew
- The `DeribitLiveAdapter` inherits from `DeribitTestAdapter` — identical behavior, different `venue` label
- Same API endpoints, same database schema

### Capital Requirements
- For retail: ~$500-1,000 in options at any time (scales with active positions)
- For treasury ($1M/day): ~$1,000-2,500/day in option purchases
- Deribit account needs enough margin for open option positions

---

## 2. Foxify Platform Integration

### Current State (Pilot)
- Simulated perp positions stored in browser localStorage
- User manually selects position type, size, SL%
- No connection to Foxify's actual trading platform

### Production Target
Foxify's platform calls Atticus API when a user opens/closes a leveraged position:

```
Foxify Platform → POST /api/protections/quote
               → POST /api/protections/activate
               → (position lifecycle)
               → POST /api/protections/close (new endpoint needed)
```

### Integration Points to Build

**A. Position Lifecycle API**
- `POST /api/protections/quote` — Foxify sends position details, gets quote back
- `POST /api/protections/activate` — Foxify confirms, protection activated
- `POST /api/protections/close` — New: when user closes perp, notify Atticus
- `GET /api/protections/:id/status` — Foxify polls or receives webhook

**B. Webhook Notifications (New)**
- Trigger events → notify Foxify to credit user's account
- Expiry events → notify Foxify for settlement
- Auto-renew events → notify Foxify of new premium charge

**C. Authentication**
- API key-based auth for Foxify's server-to-server calls
- Per-user identification (Foxify user ID mapped to Atticus user hash)
- Rate limiting per API key

---

## 3. Settlement Automation

### Current State (Pilot)
- Admin manually clicks "Settle Premium" and "Settle Payout" buttons
- No real money movement

### Production Target
Automated bilateral settlement:

**Option A — Per-Trade Settlement**
- Foxify collects premium from user at activation
- Foxify transfers premium to Atticus (on-chain or wire)
- On trigger: Atticus transfers payout to Foxify
- Foxify credits user's account

**Option B — Periodic Netting (Recommended)**
- Daily/weekly netting of premiums vs payouts
- Net amount settled via single transfer
- Reduces transaction costs and operational overhead
- Requires: invoicing endpoint, bilateral reconciliation, settlement ledger

### Changes Needed
- Billing API endpoint for Foxify to query amounts owed/due
- Automated invoice generation (daily/weekly)
- Settlement confirmation endpoint
- Reconciliation report endpoint

---

## 4. Multi-Tenant Architecture

### Current State (Pilot)
- Single `PILOT_TENANT_SCOPE_ID` for all positions
- Single admin token
- All protections under one user hash

### Production Changes
- Per-user hashing: each Foxify user gets a unique `user_hash`
- User-scoped queries: all endpoints filter by user hash
- Per-user daily limits: configurable per tier/plan
- Multi-admin support: role-based access (operator, viewer, Foxify admin)
- Tenant isolation: Foxify as a tenant, potential for additional clients

---

## 5. Authentication & Authorization

### Current State (Pilot)
- Frontend: access code gate (localStorage)
- Admin: single `PILOT_ADMIN_TOKEN` header
- No per-user auth on trading endpoints

### Production Requirements

**Server-to-Server (Foxify → Atticus)**
- API key + HMAC signature authentication
- IP allowlisting for Foxify's servers
- Rate limiting: 100 req/min per key

**Admin Access**
- JWT-based auth with role differentiation
- Audit log for all admin actions (already have `pilot_admin_actions` table)
- Session management with expiry

**Frontend (if Atticus-hosted dashboard persists)**
- OAuth or JWT auth
- CSRF protection
- Content Security Policy headers

---

## 6. Real-Time Price Feeds

### Current State (Pilot)
- HTTP polling every 3s from Coinbase + Deribit fallback
- 3-retry with 180ms delay per attempt
- ~3-5s worst-case latency for trigger detection

### Production Target
- WebSocket connection to Deribit for real-time BTC index price
- Sub-second trigger detection
- Multiple price sources with 2-of-3 agreement before triggering
- Automatic reconnection with exponential backoff

### Implementation
- Deribit provides `public/subscribe` WebSocket for `deribit_price_index.btc_usd`
- The `DeribitConnector` already has WebSocket infrastructure
- Add a `PriceStream` class that maintains WebSocket connections and emits price updates
- Trigger monitor subscribes to the stream instead of polling

---

## 7. Alerting & Monitoring

### Current State (Pilot)
- Render logs with `[TriggerMonitor]`, `[HedgeManager]`, etc. prefixes
- Admin dashboard with manual refresh
- No external notifications

### Production Requirements

**Telegram Bot (Priority)**
- Trigger events: "Protection #X triggered at $73,400 — Payout $200"
- TP recovery: "TP sold for $76 on protection #X"
- Price feed failures: "⚠ 10 consecutive price errors"
- Auto-renew failures: "Failed to renew protection #X"
- Daily summary: positions, P&L, trigger count

**Uptime Monitoring**
- Health check endpoint monitoring (UptimeRobot, Better Uptime)
- Alert on consecutive 5xx responses
- DB connection monitoring

**Metrics Dashboard (Post-Launch)**
- Grafana or similar for real-time metrics
- Key metrics: trigger rate, TP recovery rate, spread per trade, price feed latency
- Historical P&L charts

---

## 8. Infrastructure

### Current State (Pilot)
- Render web service (Singapore)
- Render Postgres (Singapore, co-located)
- Single instance, no redundancy

### Production Requirements

**Compute**
- Dedicated server or auto-scaling cloud (AWS, GCP, or dedicated VPS)
- At minimum 2 instances behind a load balancer
- Health check-based auto-restart
- Separate process for background schedulers (trigger monitor, hedge manager)

**Database**
- Managed Postgres with daily automated backups
- Point-in-time recovery capability
- Connection pooling (PgBouncer or built-in)
- Read replica for admin/reporting queries (reduces load on primary)
- Index optimization on frequently queried columns:
  - `pilot_protections.status`
  - `pilot_protections.user_hash`
  - `pilot_protections.expiry_at`
  - `pilot_protections.hedge_status`

**Networking**
- TLS everywhere (already via Render, maintain in production)
- API behind CDN/WAF for DDoS protection (Cloudflare)
- Private networking between API and DB

**Secrets Management**
- Deribit API keys in secure vault (AWS Secrets Manager, HashiCorp Vault)
- Rotate keys periodically
- Never in source code (already using env vars)

---

## 9. Legacy Code Cleanup

### Files/Functions to Remove or Refactor

**IBKR Integration (Deprecated)**
- `venue.ts`: `IbkrCmeLiveAdapter`, `IbkrCmePaperAdapter` classes (~1000 lines)
- `config.ts`: All `IBKR_*` config parsing (~50 lines)
- `routes.ts`: `resolveAdminBrokerBalanceSnapshot` (IBKR-only function)
- `routes.ts`: IBKR-specific diagnostics in admin endpoints

**Bullish Integration (Dormant)**
- `venue.ts`: `BullishTestnetAdapter` class (~500 lines)
- `bullish.ts`: Entire file (Bullish trading client)
- `config.ts`: All `PILOT_BULLISH_*` config parsing
- `triggerMonitor.ts`: `resolveBullishTriggerPrice` function
- `config.ts`: `PilotLockedPricingProfile` type and locked profile logic

**Legacy Pricing (Superseded by V7)**
- `config.ts`: `premiumSchedule` regime-based pricing table
- `config.ts`: `HybridStrictMultiplierSchedule` and related types
- `pricingPolicy.ts`: Legacy premium calculation paths

**Recommended Approach**
- Do NOT remove during pilot — risk of breaking imports
- After pilot: create a cleanup branch, remove in order of dependency
- Test thoroughly after each removal
- The venue adapter architecture (`PilotVenueAdapter` interface) is clean — removing implementations doesn't affect the interface

---

## 10. Security Hardening

### Input Validation
- All trading endpoints already validate notional, SL%, tenor
- Add: request body size limits (prevent oversized payloads)
- Add: rate limiting on quote/activate endpoints (prevent abuse)

### Transport
- HTTPS enforced (Render handles this)
- HSTS headers
- CORS restricted to known origins (currently `origin: true` — tighten for production)

### Data Protection
- User hashes are one-way (cannot reverse to identify users)
- No PII stored in the database
- Deribit API keys should be in secure secret management, not plain env vars

### Operational Security
- Admin token rotation schedule
- Audit log review process
- Incident response runbook for: trigger failures, execution failures, price feed outages

---

## 11. Database Scaling

### Current Schema Performance
- Adequate for pilot (single user, ~50 protections)
- Will need attention at 1,000+ protections

### Index Recommendations
```sql
CREATE INDEX idx_protections_status ON pilot_protections(status);
CREATE INDEX idx_protections_user_hash ON pilot_protections(user_hash);
CREATE INDEX idx_protections_expiry ON pilot_protections(expiry_at) WHERE status = 'active';
CREATE INDEX idx_protections_hedge ON pilot_protections(hedge_status) WHERE hedge_status = 'active';
CREATE INDEX idx_protections_auto_renew ON pilot_protections(expiry_at) WHERE auto_renew = true AND status = 'active';
CREATE INDEX idx_sim_positions_user ON pilot_sim_positions(user_hash, status);
CREATE INDEX idx_ledger_protection ON pilot_ledger_entries(protection_id);
```

### Archival Strategy
- Protections older than 90 days: move to `pilot_protections_archive`
- Keep ledger entries indefinitely (audit trail)
- Aggregate daily metrics into summary table for dashboard performance

### Connection Pooling
- Add PgBouncer or use Postgres built-in `max_connections` tuning
- Current pilot: ~5 connections sufficient
- Production: 20-50 connection pool

---

## 12. Performance Targets

| Metric | Pilot (Current) | Production Target |
|--------|-----------------|-------------------|
| Quote latency | 2-4s | <1s |
| Activate latency | 2-3s | <2s |
| Trigger detection | 3s polling | <1s (WebSocket) |
| Admin dashboard load | 1-2s | <500ms |
| Price feed availability | 99% (dual source) | 99.9% (multi-source + WebSocket) |
| Platform uptime | Best effort | 99.9% |
| TP recovery rate | ~60% of triggers | ~70%+ (with tighter parameters) |

---

## 13. Treasury Deployment

### Already Built
- Daily scheduler, trigger monitor, expiry handling
- Foxify dashboard (`/treasury`) and admin dashboard (`/treasury/admin`)
- Billing summary endpoint
- Pause/resume controls
- DB tables and state management

### To Deploy
1. Set `TREASURY_ENABLED=true` in Render env vars
2. Configure:
   - `TREASURY_NOTIONAL_USD=1000000` (or test amount)
   - `TREASURY_FLOOR_PCT=2`
   - `TREASURY_DAILY_PREMIUM_BPS=25` (or negotiated rate)
   - `TREASURY_EXECUTION_HOUR_UTC=0` (execution time)
   - `TREASURY_ADMIN_TOKEN=<token>`
3. Share `/treasury` URL with Foxify CEO (uses same access token pattern)
4. Monitor first few daily cycles via `/treasury/admin`

### Post-Deployment
- Negotiate final pricing with Foxify (22-25 bps proposed)
- Consider annual protection guarantee / rebate structure
- Set up automated billing reports

---

## 14. Compliance & Audit

### Trade Records
- All protections stored with full metadata (entry price, trigger price, option details)
- Ledger entries create an immutable accounting trail
- Venue execution records link to external order IDs on Deribit

### Retention
- Keep all records for minimum 7 years (financial services standard)
- Implement data export functionality for auditors
- Regular reconciliation between DB records and Deribit account statements

### Regulatory
- Determine applicable regulations based on jurisdiction
- Document the product as a hedging service, not a derivative offered to retail
- Atticus is the options counterparty risk bearer, not Foxify's end users
- Legal review of the protection agreement structure

---

## Summary — Priority Order for Production

1. **Deribit live switch** (1 env var, post-KYC)
2. **Treasury deployment** (env vars only, already built)
3. **Foxify API integration** (new endpoints, webhook system)
4. **Settlement automation** (billing API, netting)
5. **WebSocket price feeds** (replace polling)
6. **Alerting** (Telegram bot for critical events)
7. **Multi-tenant auth** (API keys, per-user isolation)
8. **Infrastructure hardening** (redundancy, backups, monitoring)
9. **Legacy cleanup** (IBKR/Bullish removal)
10. **Security audit** (CORS, rate limiting, secret rotation)
