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
DERIBIT_ENV="$(value_of "DERIBIT_ENV")"
DERIBIT_PAPER="$(value_of "DERIBIT_PAPER")"
V7_ENABLED="$(value_of "V7_PRICING_ENABLED")"

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

# V7 validation
if [[ "${V7_ENABLED}" == "true" || -z "${V7_ENABLED}" ]]; then
  echo "V7 pricing enabled (default). Validating Bullish venue config..."
  if [[ "${MODE}" != "bullish_testnet" ]]; then
    warn "V7 pricing expects PILOT_VENUE_MODE=bullish_testnet, got: ${MODE}"
  fi
fi

# IBKR modes are deprecated for V7 pilot
if [[ "${MODE}" == ibkr_cme_live || "${MODE}" == ibkr_cme_paper ]]; then
  warn "IBKR venue modes are deprecated for V7 pilot. Use bullish_testnet instead."
fi

if [[ "${MODE}" == "deribit_test" ]]; then
  [[ "${DERIBIT_ENV}" == "testnet" ]] || warn "Recommended DERIBIT_ENV=testnet for deribit_test"
  [[ "${DERIBIT_PAPER}" == "true" ]] || warn "Recommended DERIBIT_PAPER=true for deribit_test"
fi

if [[ "${issues}" -gt 0 ]]; then
  echo "pilot env validation failed (${issues} issue(s))" >&2
  exit 2
fi

echo "pilot env validation passed (${ENV_FILE})"
