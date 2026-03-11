# Pilot API (Foxify Protection)

These endpoints are enabled when `PILOT_API_ENABLED=true`.

## Public pilot endpoints

- `POST /pilot/protections/quote`
- `POST /pilot/protections/activate`
- `GET /pilot/protections/:id`
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
- `GET /pilot/protections/export?format=json|csv`
- `POST /pilot/internal/protections/:id/resolve-expiry` (internal operations/testing)

## Price source chain

1. Primary: dYdX oracle/index endpoint (`DYDX_PRICE_URL`)
2. Fallback: configured oracle endpoint (`FALLBACK_PRICE_URL`)
3. If both fail or payload is invalid, response is:
   - `status=error`
   - `reason=price_unavailable`
   - message: `Price temporarily unavailable, please retry.`

## Ledger entries

The pilot ledger stores:

- `premium_due`
- `premium_settled`
- `payout_due`
- `payout_settled`

## Tier and floor semantics

- Pilot quote/activate accepts `tierName` and optional `drawdownFloorPct`.
- If `drawdownFloorPct` is omitted, tier default drawdown is used:
  - Bronze: 20%
  - Silver: 15%
  - Gold: 12%
  - Platinum: 12%
- Floor price is calculated as:
  - `floor_price = manual_entry_price * (1 - drawdown_floor_pct)`
- Payout due logic at expiry:
  - `payout_due = max(floor_price - expiry_price, 0) / entry_price * protected_notional`

## Pilot constraints

- Tenor is fixed at 7 days by tier defaults for pilot.
- `protectedNotional` must be `<= 50,000` USDC per protection.
- Daily protected notional cap is `50,000` USDC per user hash.
- `entryPrice` is required and treated as manual user input (not auto-derived from spot).
- Activation must include a fresh `quoteId` from `/pilot/protections/quote`.

## Proof payload policy

- Proof response is authenticated and intentionally minimal:
  - protection status, floor/drawdown, entry/expiry price snapshots, and hedge execution references.
- Proof excludes internal economics fields (platform PnL, margins, and ledger economics).

