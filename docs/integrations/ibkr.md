# IBKR CME Bridge Integration (Pilot)

This integration supports pilot quote + activation flows against IBKR/CME using a private broker bridge.

## Topology

- `services/api` talks to `services/broker-bridge` over private network HTTP.
- `services/broker-bridge` is the only service expected to hold direct TWS/Gateway connectivity.
- API authenticates to bridge via `Authorization: Bearer <IBKR_BRIDGE_TOKEN>`.
- Bridge transport can run in:
  - `IBKR_BRIDGE_TRANSPORT=synthetic` (default deterministic mode)
  - `IBKR_BRIDGE_TRANSPORT=ib_socket` (real TWS/Gateway socket transport)
  - optional `IBKR_BRIDGE_FALLBACK_TO_SYNTHETIC=true` for safe fallback during connectivity or subscription gaps.

## Modes

- `PILOT_VENUE_MODE=ibkr_cme_live`:
  - Uses IBKR/CME quote path.
  - Execution controlled by `IBKR_ENABLE_EXECUTION=true|false`.
  - Recommended: `IBKR_REQUIRE_LIVE_TRANSPORT=true` to fail fast if bridge is not truly on `ib_socket`.
- `PILOT_VENUE_MODE=ibkr_cme_paper`:
  - Same quote path with paper-only execution intent.

## Hedge policy

- `PILOT_HEDGE_POLICY=options_primary_futures_fallback`
  - Attempts CME MBT options quote first.
  - Falls back to MBT futures synthetic hedge when options are unavailable.
  - Route/UI diagnostics expose `hedgeMode` (`options_native` or `futures_synthetic`).

## Tenor controls

- `PILOT_TENOR_MIN_DAYS` (default: `1`)
- `PILOT_TENOR_MAX_DAYS` (default: `7`)
- `PILOT_TENOR_DEFAULT_DAYS` (default: `7`)

Quote/activate requests can include `tenorDays`; API enforces configured bounds.

## Optional Deribit comparison

- `PILOT_ENABLE_DERIBIT_COMPARISON=true` enables a shadow Deribit quote in quote diagnostics.
- Comparison is intended for pilot benchmarking only and can be disabled for production rollout.

## Required IBKR-side readiness

- Trading permissions:
  - CME crypto futures and options (MBT/FOP as applicable).
- Market data:
  - CME top-of-book for MBT products used by the pilot.
- API session:
  - Gateway/TWS API enabled with stable client ID routing for bridge service.

## Near-live paper realism mode (recommended before live)

Use this when you want realistic paper execution behavior before live production cutover.

Bridge env:

- `IBKR_BRIDGE_TRANSPORT=ib_socket`
- `IBKR_BRIDGE_FALLBACK_TO_SYNTHETIC=true` (paper realism safety mode)
- `IBKR_GATEWAY_HOST=127.0.0.1` (or private host)
- `IBKR_GATEWAY_PORT=7497` for TWS paper (or `4002` for IB Gateway paper)
- `IBKR_GATEWAY_CLIENT_ID=101` (must be unique per active API client)
- `IBKR_GATEWAY_CONNECT_TIMEOUT_MS=5000`
- `IBKR_GATEWAY_REQUEST_TIMEOUT_MS=6000`
- `IBKR_MARKET_DATA_TYPE=1` (real-time), use `3` to force delayed data path if subscriptions are not yet active

Production guardrail:

- Set `IBKR_REQUIRE_LIVE_TRANSPORT=true` on API when venue mode is `ibkr_cme_live`.
- This enforces `GET /health` to report `transport=ib_socket` and `activeTransport=ib_socket`.
- If bridge falls back to synthetic, quote/activate fails with `ibkr_transport_not_live` instead of silently drifting.

Observability:

- `GET /health` now includes:
  - `transport`: configured mode (`synthetic` or `ib_socket`)
  - `activeTransport`: currently serving transport (`ib_socket`, `synthetic`, `synthetic_fallback`)
  - `fallbackEnabled`, `lastError`, `lastFallbackReason`

This lets you verify whether quotes/execution are actually using live socket data or fallback responses.

