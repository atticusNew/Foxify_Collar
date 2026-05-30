#!/usr/bin/env bash
set -euo pipefail

# Weighted stress bands (USD) by tier:
# - Bronze   : pilot 200k-250k, production 125k-150k
# - Silver   : pilot 120k-150k, production 75k-90k
# - Gold     : pilot 60k-75k,  production 38k-45k
# - Platinum : pilot 20k-25k,  production 13k-15k
#
# Run from services/api:
#   bash scripts/pilot_backtest_weighted_reprice.sh

BASE="${BASE:-artifacts/desktop/final_targeted_pass}"
GRID="${GRID:-25,50,75,100,125,150,175,200,250,300}"

npm run -s pilot:backtest:band-targets -- --results-json "$BASE/bronze/premium_sweep_results.json" --out-dir "$BASE/bronze" --bands 'severe_400_500:200000-250000,severe_250_300:125000-150000' --issuance-scale-grid "$GRID"
npm run -s pilot:backtest:band-targets -- --results-json "$BASE/silver/premium_sweep_results.json" --out-dir "$BASE/silver" --bands 'severe_400_500:120000-150000,severe_250_300:75000-90000' --issuance-scale-grid "$GRID"
npm run -s pilot:backtest:band-targets -- --results-json "$BASE/gold/premium_sweep_results.json" --out-dir "$BASE/gold" --bands 'severe_400_500:60000-75000,severe_250_300:38000-45000' --issuance-scale-grid "$GRID"
npm run -s pilot:backtest:band-targets -- --results-json "$BASE/platinum/premium_sweep_results.json" --out-dir "$BASE/platinum" --bands 'severe_400_500:20000-25000,severe_250_300:13000-15000' --issuance-scale-grid "$GRID"

npm run -s pilot:backtest:multi-tier-launch-verdict -- \
  --bronze-targets-json "$BASE/bronze/premium_sweep_band_targets.json" \
  --silver-targets-json "$BASE/silver/premium_sweep_band_targets.json" \
  --gold-targets-json "$BASE/gold/premium_sweep_band_targets.json" \
  --platinum-targets-json "$BASE/platinum/premium_sweep_band_targets.json" \
  --pilot-band severe_400_500 \
  --production-band severe_250_300 \
  --out-json "$BASE/premium_sweep_multi_tier_launch_verdict_weighted.json"

npm run -s pilot:backtest:final-candidate-monthly-economics -- \
  --verdict-json "$BASE/premium_sweep_multi_tier_launch_verdict_weighted.json" \
  --out-csv "$BASE/final_candidate_monthly_economics_weighted.csv"

echo "DONE"
echo "Verdict: $BASE/premium_sweep_multi_tier_launch_verdict_weighted.json"
echo "Economics CSV: $BASE/final_candidate_monthly_economics_weighted.csv"
