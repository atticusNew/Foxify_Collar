# IBKR CME Bridge Integration (Pilot)

This integration supports pilot quote + activation flows against IBKR/CME using a private broker bridge.

## Topology

- `services/api` talks to `services/broker-bridge` over private network HTTP.
- `services/broker-bridge` is the only service expected to hold direct TWS/Gateway connectivity.
- API authenticates to bridge via `Authorization: Bearer <IBKR_BRIDGE_TOKEN>`.

## Modes

- `PILOT_VENUE_MODE=ibkr_cme_live`:
  - Uses IBKR/CME quote path.
  - Execution controlled by `IBKR_ENABLE_EXECUTION=true|false`.
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

