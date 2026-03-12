# Pilot API (Foxify Protection)

These endpoints are enabled when `PILOT_API_ENABLED=true`.

## Public pilot endpoints

- `POST /pilot/protections/quote`
- `POST /pilot/protections/activate`
- `GET /pilot/protections?userId=<id>&limit=<n>`
- `GET /pilot/protections/:id`
- `GET /pilot/protections/:id/monitor` (optionally scoped with `?userId=<id>`)
- `GET /pilot/protections/:id/proof` (requires `x-proof-token` or `Authorization: Bearer <token>`)
- `POST /pilot/protections/:id/renewal-decision`

## Internal/admin endpoints

Requires:

- `x-admin-token` header matching `PILOT_ADMIN_TOKEN`
- request IP in `PILOT_ADMIN_IP_ALLOWLIST`

Endpoints:

- `POST /pilot/admin/protections/:id/premium-settled`
- `POST /pilot/admin/protections/:id/payout-settled`
- `GET /pilot/admin/protections/:id/ledger`
- `GET /pilot/admin/metrics`
- `GET /pilot/protections/export?format=json|csv`
- `POST /pilot/internal/protections/:id/resolve-expiry` (internal operations/testing)

## Price source chain

1. Canonical primary reference endpoint (`PRICE_REFERENCE_URL`)
2. Market id pinned by config (`PRICE_REFERENCE_MARKET_ID`, default `BTC-USD`)
3. Optional fallback endpoint (`FALLBACK_PRICE_URL`) only when `PRICE_SINGLE_SOURCE=false`
4. If reference resolution fails or payload is invalid, response is:
   - `status=error`
   - `reason=price_unavailable`
   - message: `Price temporarily unavailable, please retry.`
5. If storage is unavailable, response may be:
   - `status=error`
   - `reason=storage_unavailable`
   - message: `Storage temporarily unavailable, please retry.`
6. If venue quote generation fails, response may be:
   - `status=error`
   - `reason=quote_generation_failed`
   - message: `Unable to generate a venue quote right now. Please retry.`

## Ledger entries

The pilot ledger stores:

- `premium_due`
- `premium_settled`
- `payout_due`
- `payout_settled`

## Tier and trigger semantics

- Pilot quote/activate accepts `tierName` and optional `drawdownFloorPct`.
- Pilot quote/activate accepts `protectionType`:
  - `long` (default): downside protection via put semantics
  - `short`: upside protection via call semantics
- If `drawdownFloorPct` is omitted, tier default drawdown is used:
  - Bronze: 20%
  - Silver: 15%
  - Gold: 12%
  - Platinum: 12%
- Trigger price is calculated as:
  - `long`: `trigger_price = manual_entry_price * (1 - drawdown_floor_pct)` (floor)
  - `short`: `trigger_price = manual_entry_price * (1 + drawdown_floor_pct)` (ceiling)
- Payout due logic at expiry:
  - `long`: `payout_due = max(trigger_price - expiry_price, 0) / entry_price * protected_notional`
  - `short`: `payout_due = max(expiry_price - trigger_price, 0) / entry_price * protected_notional`

## Pilot constraints

- Tenor is fixed at 7 days by tier defaults for pilot.
- `protectedNotional` must be `<= 50,000` USDC per protection.
- Daily protected notional cap is `50,000` USDC per user hash and is enforced on activation.
- Quote responses may still be returned when the projected daily cap is exceeded, with limit telemetry included.
- `entryPrice` is required and treated as manual user input (not auto-derived from spot).
- Activation must include a fresh `quoteId` from `/pilot/protections/quote`.
- Venue quote/execute operations enforce bounded timeouts:
  - `PILOT_VENUE_QUOTE_TIMEOUT_MS` (default 10000ms)
  - `PILOT_VENUE_EXEC_TIMEOUT_MS` (default 8000ms)
  - `PILOT_VENUE_MARK_TIMEOUT_MS` (default 3000ms)
- Quote, activation, and expiry resolution all use the same canonical reference feed configuration.

## Proof payload policy

- Proof response is authenticated and intentionally minimal:
  - protection status, floor/drawdown, entry/expiry price snapshots, and hedge execution references.
- Proof excludes internal economics fields (platform PnL, margins, and ledger economics).

