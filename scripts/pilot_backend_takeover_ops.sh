#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"
API_BASE_URL="${API_BASE_URL:-http://127.0.0.1:8000}"
DEFAULT_BRANCH="${DEFAULT_BRANCH:-cursor/atticus-drawdown-protection-d1ae}"
COMPARE_FIXTURE_PATH="${COMPARE_FIXTURE_PATH:-${ROOT_DIR}/services/api/tests/fixtures/pilotCompareModels.fixture.json}"
COMPARE_OUT_DIR="${COMPARE_OUT_DIR:-/tmp}"
ADMIN_TOKEN_HEADER_NAME="${ADMIN_TOKEN_HEADER_NAME:-x-admin-token}"
ADMIN_IP_HEADER_NAME="${ADMIN_IP_HEADER_NAME:-x-forwarded-for}"
ADMIN_IP_HEADER_VALUE="${ADMIN_IP_HEADER_VALUE:-127.0.0.1}"

upsert_env() {
  local key="$1"
  local value="$2"
  if [[ ! -f "${ENV_FILE}" ]]; then
    touch "${ENV_FILE}"
  fi
  if rg -q "^${key}=" "${ENV_FILE}"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "${ENV_FILE}"
  else
    printf '%s=%s\n' "${key}" "${value}" >>"${ENV_FILE}"
  fi
}

admin_token_from_env() {
  if [[ ! -f "${ENV_FILE}" ]]; then
    return 0
  fi
  local line
  line="$(rg -N "^PILOT_ADMIN_TOKEN=" "${ENV_FILE}" -m 1 || true)"
  printf '%s' "${line#*=}" | tr -d '\r'
}

json_summary_from_compare() {
  local compare_json="$1"
  jq '{
    asOfIso,
    rows: .summary.nRows,
    strictMeanPremiumUsd: .summary.strictMeanPremiumUsd,
    hybridMeanPremiumUsd: .summary.hybridMeanPremiumUsd,
    meanDeltaUsd: .summary.meanDeltaUsd,
    medianDeltaUsd: .summary.medianDeltaUsd,
    claimsFloorHitRatePct: .summary.claimsFloorHitRatePct,
    impliedSubsidyGapMeanUsd: .summary.impliedSubsidyGapMeanUsd,
    impliedSubsidyGapMedianUsd: .summary.impliedSubsidyGapMedianUsd,
    impliedSubsidyGapTotalUsd: .summary.impliedSubsidyGapTotalUsd
  }' "${compare_json}"
}

cmd_pull_build_start() {
  cd "${ROOT_DIR}"
  git fetch origin "${DEFAULT_BRANCH}"
  git checkout -B "${DEFAULT_BRANCH}" "origin/${DEFAULT_BRANCH}"
  git pull origin "${DEFAULT_BRANCH}"

  docker compose up -d postgres broker-bridge
  docker compose build atticus
  docker compose up -d --no-deps --force-recreate atticus

  until curl -sS "${API_BASE_URL}/health" >/dev/null; do
    echo "waiting for /health..."
    sleep 2
  done
  curl -sS "${API_BASE_URL}/health" | jq .
}

cmd_preset_strict_baseline() {
  upsert_env PILOT_VENUE_MODE deribit_test
  upsert_env PILOT_HEDGE_POLICY options_only_native
  upsert_env PILOT_PREMIUM_PRICING_MODE actuarial_strict
  upsert_env PILOT_SELECTOR_MODE strict_profitability

  upsert_env PILOT_HYBRID_TRIGGER_PROB_CAP 0.18
  upsert_env PILOT_HYBRID_CLAIMS_COVERAGE_FACTOR 0.29
  upsert_env PILOT_HYBRID_MARKUP_FACTOR 1.50
  upsert_env PILOT_HYBRID_BASE_FEE_USD 5

  upsert_env PILOT_TREASURY_PER_QUOTE_SUBSIDY_CAP_PCT 0.65
  upsert_env PILOT_TREASURY_SUBSIDY_CAP_PCT 0.65
  upsert_env PILOT_TREASURY_DAILY_SUBSIDY_CAP_USDC 12000
  upsert_env PILOT_TREASURY_STRICT_FALLBACK_ENABLED true
}

cmd_preset_hybrid_candidate() {
  upsert_env PILOT_VENUE_MODE deribit_test
  upsert_env PILOT_HEDGE_POLICY options_only_native
  upsert_env PILOT_PREMIUM_PRICING_MODE hybrid_otm_treasury
  upsert_env PILOT_SELECTOR_MODE hybrid_treasury

  upsert_env PILOT_HYBRID_TRIGGER_PROB_CAP 0.18
  upsert_env PILOT_HYBRID_CLAIMS_COVERAGE_FACTOR 0.29
  upsert_env PILOT_HYBRID_MARKUP_FACTOR 1.50
  upsert_env PILOT_HYBRID_BASE_FEE_USD 5

  upsert_env PILOT_TREASURY_PER_QUOTE_SUBSIDY_CAP_PCT 0.65
  upsert_env PILOT_TREASURY_SUBSIDY_CAP_PCT 0.65
  upsert_env PILOT_TREASURY_DAILY_SUBSIDY_CAP_USDC 12000
  upsert_env PILOT_TREASURY_STRICT_FALLBACK_ENABLED true
}

cmd_apply_ibkr_market_smoke_profile() {
  upsert_env PILOT_VENUE_MODE ibkr_cme_live
  upsert_env PILOT_HEDGE_POLICY options_only_native
  upsert_env PILOT_PREMIUM_PRICING_MODE hybrid_otm_treasury
  upsert_env PILOT_SELECTOR_MODE hybrid_treasury
  upsert_env IBKR_REQUIRE_LIVE_TRANSPORT true
  upsert_env IBKR_OPTION_LIQUIDITY_SELECTION_ENABLED true
  upsert_env IBKR_OPTION_LIQUIDITY_TENOR_WINDOW_DAYS 4
  upsert_env IBKR_MAX_OPTION_PREMIUM_RATIO 0.15
}

cmd_recreate_atticus() {
  cd "${ROOT_DIR}"
  docker compose up -d --no-deps --force-recreate atticus
  curl -sS "${API_BASE_URL}/pilot/health" | jq .
}

cmd_quote_smoke() {
  curl -sS -X POST "${API_BASE_URL}/pilot/protections/quote" \
    -H "Content-Type: application/json" \
    -d '{
      "protectedNotional": 10000,
      "foxifyExposureNotional": 10000,
      "instrumentId": "BTC-USD-7D-P",
      "marketId": "BTC-USD",
      "tierName": "Pro (Bronze)",
      "drawdownFloorPct": 0.2,
      "protectionType": "long"
    }' | jq .
}

cmd_activate_smoke() {
  local quote_json
  quote_json="$(curl -sS -X POST "${API_BASE_URL}/pilot/protections/quote" \
    -H "Content-Type: application/json" \
    -d '{
      "protectedNotional": 10000,
      "foxifyExposureNotional": 10000,
      "instrumentId": "BTC-USD-7D-P",
      "marketId": "BTC-USD",
      "tierName": "Pro (Bronze)",
      "drawdownFloorPct": 0.2,
      "protectionType": "long"
    }')"
  local quote_id
  quote_id="$(printf '%s' "${quote_json}" | jq -r '.quote.quoteId // empty')"
  if [[ -z "${quote_id}" ]]; then
    printf '%s\n' "${quote_json}" | jq .
    echo "quote id missing; cannot run activate smoke" >&2
    return 1
  fi
  curl -sS -X POST "${API_BASE_URL}/pilot/protections/activate" \
    -H "Content-Type: application/json" \
    -d "{
      \"quoteId\": \"${quote_id}\",
      \"protectedNotional\": 10000,
      \"foxifyExposureNotional\": 10000,
      \"instrumentId\": \"BTC-USD-7D-P\",
      \"marketId\": \"BTC-USD\",
      \"tierName\": \"Pro (Bronze)\",
      \"drawdownFloorPct\": 0.2,
      \"protectionType\": \"long\"
    }" | jq .
}

cmd_selector_diagnostics() {
  local admin
  admin="$(admin_token_from_env)"
  if [[ -z "${admin}" ]]; then
    echo "PILOT_ADMIN_TOKEN missing in ${ENV_FILE}" >&2
    return 1
  fi
  curl -sS \
    -H "${ADMIN_TOKEN_HEADER_NAME}: ${admin}" \
    -H "${ADMIN_IP_HEADER_NAME}: ${ADMIN_IP_HEADER_VALUE}" \
    "${API_BASE_URL}/pilot/admin/diagnostics/selector" | jq .
}

cmd_compare_fixture() {
  local out_json="${COMPARE_OUT_DIR}/pilot-compare.json"
  local out_csv="${COMPARE_OUT_DIR}/pilot-compare.csv"
  cd "${ROOT_DIR}/services/api"
  npm run -s pilot:compare-models -- \
    --fixture "${COMPARE_FIXTURE_PATH}" \
    --out-json "${out_json}" \
    --out-csv "${out_csv}"
  json_summary_from_compare "${out_json}"
}

cmd_compare_live_deribit() {
  local out_json="${COMPARE_OUT_DIR}/pilot-compare-live-deribit.json"
  local out_csv="${COMPARE_OUT_DIR}/pilot-compare-live-deribit.csv"
  cd "${ROOT_DIR}/services/api"
  npm run -s pilot:compare-models -- \
    --live-deribit \
    --out-json "${out_json}" \
    --out-csv "${out_csv}"
  json_summary_from_compare "${out_json}"
}

cmd_deribit_matrix() {
  local out_dir="${COMPARE_OUT_DIR}/pilot-matrix"
  mkdir -p "${out_dir}"
  cmd_preset_strict_baseline
  cmd_recreate_atticus
  local strict_json="${out_dir}/strict.json"
  local strict_csv="${out_dir}/strict.csv"
  cd "${ROOT_DIR}/services/api"
  npm run -s pilot:compare-models -- \
    --fixture "${COMPARE_FIXTURE_PATH}" \
    --out-json "${strict_json}" \
    --out-csv "${strict_csv}" >/dev/null

  cmd_preset_hybrid_candidate
  cmd_recreate_atticus
  local hybrid_json="${out_dir}/hybrid.json"
  local hybrid_csv="${out_dir}/hybrid.csv"
  npm run -s pilot:compare-models -- \
    --fixture "${COMPARE_FIXTURE_PATH}" \
    --out-json "${hybrid_json}" \
    --out-csv "${hybrid_csv}" >/dev/null

  jq -n \
    --slurpfile strict "${strict_json}" \
    --slurpfile hybrid "${hybrid_json}" \
    '{
      strict: $strict[0].summary,
      hybrid: $hybrid[0].summary,
      notes: "Strict/hybrid model output under corresponding runtime presets."
    }'
}

usage() {
  cat <<'EOF'
Usage: scripts/pilot_backend_takeover_ops.sh <command>

Commands:
  pull-build-start                Fetch branch, build, restart backend, wait /health
  preset-strict-baseline          Upsert strict actuarial baseline config into .env
  preset-hybrid-candidate         Upsert hybrid candidate config into .env
  apply-ibkr-market-smoke-profile Upsert IBKR market-hours smoke profile knobs
  recreate-atticus                Restart atticus and print /pilot/health
  quote-smoke                     Run quote smoke call
  activate-smoke                  Run quote + activate smoke sequence
  selector-diagnostics            Query /pilot/admin/diagnostics/selector with admin token
  compare-fixture                 Run compare-models against fixture and print KPI summary
  compare-live-deribit            Run compare-models against live Deribit and print KPI summary
  deribit-matrix                  Run strict + hybrid matrix compares (fixture) and print merged summary
EOF
}

main() {
  local cmd="${1:-}"
  case "${cmd}" in
    pull-build-start) cmd_pull_build_start ;;
    preset-strict-baseline) cmd_preset_strict_baseline ;;
    preset-hybrid-candidate) cmd_preset_hybrid_candidate ;;
    apply-ibkr-market-smoke-profile) cmd_apply_ibkr_market_smoke_profile ;;
    recreate-atticus) cmd_recreate_atticus ;;
    quote-smoke) cmd_quote_smoke ;;
    activate-smoke) cmd_activate_smoke ;;
    selector-diagnostics) cmd_selector_diagnostics ;;
    compare-fixture) cmd_compare_fixture ;;
    compare-live-deribit) cmd_compare_live_deribit ;;
    deribit-matrix) cmd_deribit_matrix ;;
    *)
      usage
      if [[ -n "${cmd}" ]]; then
        echo "Unknown command: ${cmd}" >&2
        return 1
      fi
      return 0
      ;;
  esac
}

main "${@}"
