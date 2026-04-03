#!/usr/bin/env bash
set -euo pipefail

FROM_ISO="${FROM_ISO:-2025-10-01T00:00:00Z}"
TO_ISO="${TO_ISO:-2026-04-01T00:00:00Z}"
CONFIG_PATH="${CONFIG_PATH:-scripts/fixtures/pilot_backtest_config.example.json}"
PRICES_CSV="${PRICES_CSV:-artifacts/backtest/btc_usd_1h.csv}"
OUT_JSON="${OUT_JSON:-artifacts/backtest/pilot_backtest.json}"
OUT_CSV="${OUT_CSV:-artifacts/backtest/pilot_backtest.csv}"
MODE="${MODE:-both}"
BREACH_MODE="${BREACH_MODE:-}"
SOURCE="${SOURCE:-auto}"

echo "[1/3] Fetching hourly BTC prices..."
npm run -s pilot:backtest:fetch-btc -- \
  --from "${FROM_ISO}" \
  --to "${TO_ISO}" \
  --source "${SOURCE}" \
  --out-csv "${PRICES_CSV}"

echo "[2/3] Running pilot backtest..."
BACKTEST_CMD=(npm run -s pilot:backtest:run -- \
  --config "${CONFIG_PATH}" \
  --prices-csv "${PRICES_CSV}" \
  --mode "${MODE}" \
  --out-json "${OUT_JSON}" \
  --out-csv "${OUT_CSV}")
if [[ -n "${BREACH_MODE}" ]]; then
  BACKTEST_CMD+=(--breach-mode "${BREACH_MODE}")
fi
"${BACKTEST_CMD[@]}"

echo "[3/3] Summary"
jq '.summary' "${OUT_JSON}"

echo
echo "Done."
echo "Prices CSV: ${PRICES_CSV}"
echo "Backtest JSON: ${OUT_JSON}"
echo "Backtest CSV: ${OUT_CSV}"
