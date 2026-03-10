# Pilot API (Foxify Protection)

These endpoints are enabled when `PILOT_API_ENABLED=true`.

## Public pilot endpoints

- `POST /pilot/protections/quote`
- `POST /pilot/protections/activate`
- `GET /pilot/protections/:id`
- `GET /pilot/protections/:id/proof`
- `GET /pilot/protections/export?format=json|csv`
- `POST /pilot/protections/:id/renewal-decision`

## Internal/admin endpoints

Requires:

- `x-admin-token` header matching `PILOT_ADMIN_TOKEN`
- request IP in `PILOT_ADMIN_IP_ALLOWLIST`

Endpoints:

- `POST /pilot/admin/protections/:id/premium-settled`
- `POST /pilot/admin/protections/:id/payout-settled`
- `GET /pilot/admin/protections/:id/ledger`
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

