#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

BASE_OUT="${1:-artifacts/desktop/consistent_matrix}"
SOURCE="${2:-coinbase}"
AS_OF="${3:-$(date -u +"%Y-%m-%dT00:00:00Z")}"

python3 - "$AS_OF" > /tmp/pilot_periods.env <<'PY'
import sys
from datetime import datetime, timezone, timedelta

as_of = datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00")).astimezone(timezone.utc)
if as_of.month in (1, 2, 3):
    q_start = datetime(as_of.year - 1, 10, 1, tzinfo=timezone.utc)
elif as_of.month in (4, 5, 6):
    q_start = datetime(as_of.year, 1, 1, tzinfo=timezone.utc)
elif as_of.month in (7, 8, 9):
    q_start = datetime(as_of.year, 4, 1, tzinfo=timezone.utc)
else:
    q_start = datetime(as_of.year, 7, 1, tzinfo=timezone.utc)
q_end = as_of
r12_start = as_of - timedelta(days=365)
r24_start = as_of - timedelta(days=730)
print(f"LAST_QTR_FROM={q_start.isoformat().replace('+00:00','Z')}")
print(f"LAST_QTR_TO={q_end.isoformat().replace('+00:00','Z')}")
print(f"ROLLING_12M_FROM={r12_start.isoformat().replace('+00:00','Z')}")
print(f"ROLLING_12M_TO={q_end.isoformat().replace('+00:00','Z')}")
print(f"ROLLING_24M_FROM={r24_start.isoformat().replace('+00:00','Z')}")
print(f"ROLLING_24M_TO={q_end.isoformat().replace('+00:00','Z')}")
PY

set -a
source /tmp/pilot_periods.env
set +a

mkdir -p "$BASE_OUT"

# Starting point from attached "cheaper" schedule:
# Bronze=25, Silver=21, Gold=18, Platinum=17
# We sweep around each to find minimum sustainable candidate.
run_tier () {
  local TIER_NAME="$1"
  local SLUG="$2"
  local GRID="$3"
  local MIX_DIR="$4"
  local NOTIONALS="$5"

  npm run -s pilot:backtest:premium-sweep -- \
    --source "$SOURCE" \
    --config "scripts/fixtures/pilot_backtest_config.example.json" \
    --out-dir "$MIX_DIR/$SLUG" \
    --period-profile consistent_core \
    --as-of "$AS_OF" \
    --tier-name "$TIER_NAME" \
    --bronze-grid "$GRID" \
    --notionals "$NOTIONALS" \
    --treasury-starting-balance-usd 500000 \
    --treasury-daily-subsidy-cap-usd 150000 \
    --treasury-per-quote-subsidy-cap-pct 1 \
    --stress-target-min-usd 0 \
    --stress-max-usd 100000000 \
    --decision-require-no-blocked-subsidy false
}

run_mix () {
  local MIX_LABEL="$1"
  local BRONZE_BAND="$2"
  local SILVER_BAND="$3"
  local GOLD_BAND="$4"
  local PLAT_BAND="$5"
  local MIX_DIR="$BASE_OUT/$MIX_LABEL"

  mkdir -p "$MIX_DIR"

  # Volume mixes are modeled via weighted target bands:
  # pilot target 400-500k, production 250-300k.
  # Bronze / Silver / Gold / Platinum allocations per mix.
  # Note: explicit USD (not shorthand) to avoid shell/parser issues.
  run_tier "Pro (Bronze)" bronze "22,23,24,25,26,27,28,29,30" "$MIX_DIR" "5000,10000,25000,50000"
  run_tier "Pro (Silver)" silver "19,20,21,22,23,24,25,26,27,28,29,30" "$MIX_DIR" "5000,10000,25000,50000"
  run_tier "Pro (Gold)" gold "16,17,18,19,20,21,22,23,24,25,26,27,28,29,30" "$MIX_DIR" "5000,10000,25000,50000"
  run_tier "Pro (Platinum)" platinum "15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30" "$MIX_DIR" "5000,10000,25000,50000"

  npm run -s pilot:backtest:band-targets -- \
    --results-json "$MIX_DIR/bronze/premium_sweep_results.json" \
    --out-dir "$MIX_DIR/bronze" \
    --bands "$BRONZE_BAND" \
    --issuance-scale-grid 25,50,75,100,125,150,175,200,250,300

  npm run -s pilot:backtest:band-targets -- \
    --results-json "$MIX_DIR/silver/premium_sweep_results.json" \
    --out-dir "$MIX_DIR/silver" \
    --bands "$SILVER_BAND" \
    --issuance-scale-grid 25,50,75,100,125,150,175,200,250,300

  npm run -s pilot:backtest:band-targets -- \
    --results-json "$MIX_DIR/gold/premium_sweep_results.json" \
    --out-dir "$MIX_DIR/gold" \
    --bands "$GOLD_BAND" \
    --issuance-scale-grid 25,50,75,100,125,150,175,200,250,300

  npm run -s pilot:backtest:band-targets -- \
    --results-json "$MIX_DIR/platinum/premium_sweep_results.json" \
    --out-dir "$MIX_DIR/platinum" \
    --bands "$PLAT_BAND" \
    --issuance-scale-grid 25,50,75,100,125,150,175,200,250,300

  npm run -s pilot:backtest:multi-tier-launch-verdict -- \
    --bronze-targets-json "$MIX_DIR/bronze/premium_sweep_band_targets.json" \
    --silver-targets-json "$MIX_DIR/silver/premium_sweep_band_targets.json" \
    --gold-targets-json "$MIX_DIR/gold/premium_sweep_band_targets.json" \
    --platinum-targets-json "$MIX_DIR/platinum/premium_sweep_band_targets.json" \
    --pilot-band severe_400_500 \
    --production-band severe_250_300 \
    --out-json "$MIX_DIR/premium_sweep_multi_tier_launch_verdict.json"

  npm run -s pilot:backtest:final-candidate-monthly-economics -- \
    --verdict-json "$MIX_DIR/premium_sweep_multi_tier_launch_verdict.json" \
    --out-csv "$MIX_DIR/final_candidate_monthly_economics.csv"
}

# Mix A: 50/30/15/5
run_mix \
  "mix_50_30_15_05" \
  "severe_400_500:200000-250000,severe_250_300:125000-150000" \
  "severe_400_500:120000-150000,severe_250_300:75000-90000" \
  "severe_400_500:60000-75000,severe_250_300:38000-45000" \
  "severe_400_500:20000-25000,severe_250_300:13000-15000"

# Mix B: 40/30/20/10
run_mix \
  "mix_40_30_20_10" \
  "severe_400_500:160000-200000,severe_250_300:100000-120000" \
  "severe_400_500:120000-150000,severe_250_300:75000-90000" \
  "severe_400_500:80000-100000,severe_250_300:50000-60000" \
  "severe_400_500:40000-50000,severe_250_300:25000-30000"

# Mix C: 35/30/20/15
run_mix \
  "mix_35_30_20_15" \
  "severe_400_500:140000-175000,severe_250_300:87500-105000" \
  "severe_400_500:120000-150000,severe_250_300:75000-90000" \
  "severe_400_500:80000-100000,severe_250_300:50000-60000" \
  "severe_400_500:60000-75000,severe_250_300:38000-45000"

node - "$BASE_OUT" <<'NODE'
const fs = require("fs");
const path = require("path");
const baseOut = process.argv[2];
const rows = [];
const mixes = fs
  .readdirSync(baseOut, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("mix_"))
  .map((entry) => entry.name)
  .sort();
for (const mix of mixes) {
  const verdictPath = path.join(baseOut, mix, "premium_sweep_multi_tier_launch_verdict.json");
  if (!fs.existsSync(verdictPath)) continue;
  const verdict = JSON.parse(fs.readFileSync(verdictPath, "utf8"));
  rows.push({
    mix,
    tier: "portfolio_total",
    pilotVerdict: String(verdict?.summary?.overallPilotVerdict || "NO_GO"),
    pilotPremiumPer1kUsd: "n/a",
    productionVerdict: String(verdict?.summary?.overallProductionVerdict || "NO_GO"),
    productionPremiumPer1kUsd: "n/a"
  });
  for (const tier of verdict?.tiers || []) {
    rows.push({
      mix,
      tier: String(tier.tier || ""),
      pilotVerdict: String(tier.pilotVerdict || "NO_GO"),
      pilotPremiumPer1kUsd: String(tier.pilotRecommendedPremiumPer1kUsd || "NONE"),
      productionVerdict: String(tier.productionVerdict || "NO_GO"),
      productionPremiumPer1kUsd: String(tier.productionRecommendedPremiumPer1kUsd || "NONE")
    });
  }
}
const headers = [
  "mix",
  "tier",
  "pilotVerdict",
  "pilotPremiumPer1kUsd",
  "productionVerdict",
  "productionPremiumPer1kUsd"
];
const lines = [headers.join(",")];
for (const row of rows) lines.push(headers.map((h) => row[h] ?? "").join(","));
fs.writeFileSync(path.join(baseOut, "consistent_matrix_summary.csv"), `${lines.join("\n")}\n`, "utf8");
console.log(`Summary: ${path.join(baseOut, "consistent_matrix_summary.csv")}`);
NODE

echo "DONE"
echo "AS_OF=$AS_OF"
echo "LAST_QTR_FROM=$LAST_QTR_FROM LAST_QTR_TO=$LAST_QTR_TO"
echo "ROLLING_12M_FROM=$ROLLING_12M_FROM ROLLING_12M_TO=$ROLLING_12M_TO"
echo "ROLLING_24M_FROM=$ROLLING_24M_FROM ROLLING_24M_TO=$ROLLING_24M_TO"
echo "Results root: $BASE_OUT"
