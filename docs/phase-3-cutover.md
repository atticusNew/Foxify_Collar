# Phase 3A Cutover Plan (Render -> VPS API/IBKR)

This runbook makes VPS the canonical pilot runtime and removes split-risk between Render API and VPS IBKR services.

## Objective

- Keep **web** on Render static hosting for now.
- Move pilot **API + broker-bridge + Postgres** to VPS and treat it as the single live path.
- Point web `VITE_API_BASE` at VPS API.

## Prerequisites

- VPS stack cloned at `/opt/ibkr-stack`
- TLS endpoint ready for API (reverse proxy in front of port `8000`)
- Desktop TWS tunnel stable when using `ib_socket`

## 1) Select and validate env profile

On VPS:

```bash
cd /opt/ibkr-stack
cp env/profiles/pilot_ibkr_live.env .env
# Fill secrets/account IDs in .env before continuing.
./scripts/validate_pilot_env.sh .env
```

Expected: `pilot env validation passed`.

## 2) Deploy VPS runtime

```bash
cd /opt/ibkr-stack
docker compose --env-file .env up -d --build
docker compose ps
```

Validate health:

```bash
curl -s http://127.0.0.1:8000/health | jq
curl -s http://127.0.0.1:8000/pilot/health | jq
```

Expected in live mode:

- `checks.venue.transport = "ib_socket"`
- `checks.venue.activeTransport = "ib_socket"`
- status `ok`

## 3) Smoke quote from VPS API

```bash
curl -sS -X POST "http://127.0.0.1:8000/pilot/protections/quote" \
  -H "Content-Type: application/json" \
  -d '{
    "protectedNotional": 25000,
    "foxifyExposureNotional": 25000,
    "instrumentId": "BTC-USD-14D-P",
    "marketId": "BTC-USD",
    "protectionType": "long",
    "tierName": "Pro (Silver)",
    "drawdownFloorPct": 0.2,
    "tenorDays": 14
  }' | jq
```

## 4) Point Render web to VPS API

In Render static service env vars:

- `VITE_API_BASE=https://<your-vps-api-domain>`

Then redeploy web and verify browser requests target VPS API.

## 5) Lock out Render API from pilot live path

Recommended:

- disable auto-deploy on Render API service, or
- mark it explicitly as non-live fallback/dev

Keep only one canonical pilot API endpoint in operator docs.

## 6) Rollback

If cutover fails:

1. Restore old `VITE_API_BASE` in Render web.
2. Redeploy Render web.
3. Keep VPS services running for debugging, but do not split live traffic.

