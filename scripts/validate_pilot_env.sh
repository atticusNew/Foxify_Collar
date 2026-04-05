#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-.env}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: env file not found: ${ENV_FILE}" >&2
  exit 1
fi

value_of() {
  local key="$1"
  local line
  line="$(rg -N "^${key}=" "${ENV_FILE}" -m 1 || true)"
  if [[ -z "${line}" ]]; then
    echo ""
    return 0
  fi
  echo "${line#*=}"
}

MODE="$(value_of "PILOT_VENUE_MODE")"
HEDGE_POLICY="$(value_of "PILOT_HEDGE_POLICY")"
BRIDGE_TRANSPORT="$(value_of "IBKR_BRIDGE_TRANSPORT")"
BRIDGE_FALLBACK="$(value_of "IBKR_BRIDGE_FALLBACK_TO_SYNTHETIC")"
REQUIRE_LIVE="$(value_of "IBKR_REQUIRE_LIVE_TRANSPORT")"
ENABLE_EXEC="$(value_of "IBKR_ENABLE_EXECUTION")"
DERIBIT_ENV="$(value_of "DERIBIT_ENV")"
DERIBIT_PAPER="$(value_of "DERIBIT_PAPER")"

issues=0
warn() {
  echo "WARN: $1"
}
err() {
  echo "ERROR: $1" >&2
  issues=$((issues + 1))
}

if [[ -z "${MODE}" ]]; then
  err "PILOT_VENUE_MODE is required"
fi

if [[ "${MODE}" == ibkr_cme_live || "${MODE}" == ibkr_cme_paper ]]; then
  [[ "${BRIDGE_TRANSPORT}" == "ib_socket" ]] || err "IBKR mode requires IBKR_BRIDGE_TRANSPORT=ib_socket"
  [[ "${HEDGE_POLICY}" == "options_only_native" ]] || warn "Recommended PILOT_HEDGE_POLICY=options_only_native for pilot quote quality"
  if [[ "${MODE}" == "ibkr_cme_live" ]]; then
    [[ "${REQUIRE_LIVE}" == "true" ]] || warn "Recommended IBKR_REQUIRE_LIVE_TRANSPORT=true in live mode"
    [[ "${BRIDGE_FALLBACK}" == "false" ]] || warn "Recommended IBKR_BRIDGE_FALLBACK_TO_SYNTHETIC=false in live mode"
  fi
  if [[ "${ENABLE_EXEC}" == "true" ]]; then
    ACCOUNT_ID="$(value_of "IBKR_ACCOUNT_ID")"
    [[ -n "${ACCOUNT_ID}" ]] || err "IBKR_ENABLE_EXECUTION=true requires IBKR_ACCOUNT_ID"
  fi
fi

if [[ "${MODE}" == "deribit_test" ]]; then
  [[ "${DERIBIT_ENV}" == "testnet" ]] || warn "Recommended DERIBIT_ENV=testnet for deribit_test"
  [[ "${DERIBIT_PAPER}" == "true" ]] || warn "Recommended DERIBIT_PAPER=true for deribit_test"
fi

if [[ "${MODE}" == ibkr_cme_live || "${MODE}" == ibkr_cme_paper ]]; then
  if [[ "${DERIBIT_ENV}" == "live" && "${DERIBIT_PAPER}" == "false" ]]; then
    warn "Deribit live flags are set while running IBKR mode; ensure this is intentional"
  fi
fi

if [[ "${issues}" -gt 0 ]]; then
  echo "pilot env validation failed (${issues} issue(s))" >&2
  exit 2
fi

echo "pilot env validation passed (${ENV_FILE})"
