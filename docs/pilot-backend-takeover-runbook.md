# Atticus Protection API Backend Takeover Runbook (Foxify FUNDED Pilot)

This document is backend-only and excludes UI/MVP frontend tasks.

Scope:

- pricing/selector/treasury/monitoring logic
- Deribit + IBKR testing operations
- repeatable commands for calibration and diagnostics

## 1) Canonical branch and backend bring-up

```bash
set -euo pipefail
cd /opt/ibkr-stack
git fetch origin cursor/atticus-drawdown-protection-d1ae
git checkout -B cursor/atticus-drawdown-protection-d1ae origin/cursor/atticus-drawdown-protection-d1ae
git pull origin cursor/atticus-drawdown-protection-d1ae

docker compose up -d postgres broker-bridge
docker compose build atticus
docker compose up -d --no-deps --force-recreate atticus

until curl -sS http://127.0.0.1:8000/health >/dev/null; do
  echo "waiting for /health..."
  sleep 2
done
curl -sS http://127.0.0.1:8000/health | jq .
```

Notes:

- `/health` is process readiness.
- `/pilot/health` can be non-2xx by design in degraded venue states.

## 2) Preset normalization (strict baseline + hybrid candidate)

Use this helper for deterministic `.env` updates:

```bash
upsert () { k="$1"; v="$2"; grep -q "^${k}=" .env && sed -i "s|^${k}=.*|${k}=${v}|" .env || echo "${k}=${v}" >> .env; }
```

### 2.1 Strict baseline preset

```bash
cd /opt/ibkr-stack
upsert PILOT_VENUE_MODE deribit_test
upsert PILOT_HEDGE_POLICY options_only_native
upsert PILOT_PREMIUM_PRICING_MODE actuarial_strict
upsert PILOT_SELECTOR_MODE strict_profitability

# keep hybrid knobs pinned for apples-to-apples matrix comparisons
upsert PILOT_HYBRID_TRIGGER_PROB_CAP 0.18
upsert PILOT_HYBRID_CLAIMS_COVERAGE_FACTOR 0.29
upsert PILOT_HYBRID_MARKUP_FACTOR 1.50
upsert PILOT_HYBRID_BASE_FEE_USD 5

# treasury rails
upsert PILOT_TREASURY_PER_QUOTE_SUBSIDY_CAP_PCT 0.65
upsert PILOT_TREASURY_DAILY_SUBSIDY_CAP_USDC 12000
upsert PILOT_TREASURY_STRICT_FALLBACK_ENABLED true

docker compose up -d --no-deps --force-recreate atticus
curl -sS http://127.0.0.1:8000/pilot/health | jq .
```

### 2.2 Hybrid candidate preset (recommended default for Deribit calibration)

```bash
cd /opt/ibkr-stack
upsert PILOT_VENUE_MODE deribit_test
upsert PILOT_HEDGE_POLICY options_only_native
upsert PILOT_PREMIUM_PRICING_MODE hybrid_otm_treasury
upsert PILOT_SELECTOR_MODE hybrid_treasury

upsert PILOT_HYBRID_TRIGGER_PROB_CAP 0.18
upsert PILOT_HYBRID_CLAIMS_COVERAGE_FACTOR 0.29
upsert PILOT_HYBRID_MARKUP_FACTOR 1.50
upsert PILOT_HYBRID_BASE_FEE_USD 5

upsert PILOT_TREASURY_PER_QUOTE_SUBSIDY_CAP_PCT 0.65
upsert PILOT_TREASURY_DAILY_SUBSIDY_CAP_USDC 12000
upsert PILOT_TREASURY_STRICT_FALLBACK_ENABLED true

docker compose up -d --no-deps --force-recreate atticus
curl -sS http://127.0.0.1:8000/pilot/health | jq .
```

## 3) Quote + activate smoke tests

### 3.1 Quote smoke

```bash
curl -sS -X POST http://127.0.0.1:8000/pilot/protections/quote \
  -H 'Content-Type: application/json' \
  -d '{
    "protectedNotional": 10000,
    "foxifyExposureNotional": 10000,
    "instrumentId": "BTC-USD-7D-P",
    "marketId": "BTC-USD",
    "tierName": "Pro (Bronze)",
    "drawdownFloorPct": 0.2,
    "protectionType": "long"
  }' | jq .
```

### 3.2 Activate smoke (using fresh quoteId)

```bash
Q=$(curl -sS -X POST http://127.0.0.1:8000/pilot/protections/quote \
  -H 'Content-Type: application/json' \
  -d '{
    "protectedNotional": 10000,
    "foxifyExposureNotional": 10000,
    "instrumentId": "BTC-USD-7D-P",
    "marketId": "BTC-USD",
    "tierName": "Pro (Bronze)",
    "drawdownFloorPct": 0.2,
    "protectionType": "long"
  }')

QUOTE_ID=$(echo "$Q" | jq -r '.quote.quoteId // empty')

curl -sS -X POST http://127.0.0.1:8000/pilot/protections/activate \
  -H 'Content-Type: application/json' \
  -d "{
    \"quoteId\": \"${QUOTE_ID}\",
    \"protectedNotional\": 10000,
    \"foxifyExposureNotional\": 10000,
    \"instrumentId\": \"BTC-USD-7D-P\",
    \"marketId\": \"BTC-USD\",
    \"tierName\": \"Pro (Bronze)\",
    \"drawdownFloorPct\": 0.2,
    \"protectionType\": \"long\"
  }" | jq .
```

## 4) Deribit calibration matrix + KPI extraction

### 4.1 Compare script (fixture)

```bash
cd /opt/ibkr-stack/services/api
npm run -s pilot:compare-models -- \
  --fixture /opt/ibkr-stack/services/api/tests/fixtures/pilotCompareModels.fixture.json \
  --out-json /tmp/pilot-compare.json \
  --out-csv /tmp/pilot-compare.csv
jq '.summary' /tmp/pilot-compare.json
```

### 4.2 Compare script (live Deribit input generation)

```bash
cd /opt/ibkr-stack/services/api
npm run -s pilot:compare-models -- \
  --live-deribit \
  --out-json /tmp/pilot-compare-live-deribit.json \
  --out-csv /tmp/pilot-compare-live-deribit.csv
jq '.summary' /tmp/pilot-compare-live-deribit.json
```

### 4.2b Tenor sweep script (live Deribit, requested 14/21/28d)

```bash
cd /opt/ibkr-stack/services/api
npm run -s pilot:compare-tenors -- \
  --tenors 14,21,28 \
  --notionals 5000,10000 \
  --tiers "Pro (Bronze),Pro (Silver),Pro (Gold)" \
  --out-json /tmp/pilot-tenor-compare.json \
  --out-csv /tmp/pilot-tenor-compare.csv

jq '.summaryByTenor' /tmp/pilot-tenor-compare.json
```

Notes:

- Output reports requested tenor, selected tenor, and tenor drift days for each row.
- Deribit expiry availability can cause requested 28d to map to nearest listed expiry.

### 4.3 Required KPI table fields

`pilot:compare-models` summary now includes:

- `strictMeanPremiumUsd`
- `hybridMeanPremiumUsd`
- `meanDeltaUsd`
- `medianDeltaUsd`
- `claimsFloorHitRatePct`
- `impliedSubsidyGapMeanUsd`
- `impliedSubsidyGapMedianUsd`
- `impliedSubsidyGapTotalUsd`

Build a compact KPI table:

```bash
jq -r '
  .summary as $s |
  [
    ["metric","value"],
    ["strict_mean_usd",$s.strictMeanPremiumUsd],
    ["hybrid_mean_usd",$s.hybridMeanPremiumUsd],
    ["mean_delta_usd",$s.meanDeltaUsd],
    ["median_delta_usd",$s.medianDeltaUsd],
    ["claims_floor_hit_rate_pct",$s.claimsFloorHitRatePct],
    ["implied_subsidy_gap_mean_usd",$s.impliedSubsidyGapMeanUsd],
    ["implied_subsidy_gap_median_usd",$s.impliedSubsidyGapMedianUsd],
    ["implied_subsidy_gap_total_usd",$s.impliedSubsidyGapTotalUsd]
  ] | .[] | @tsv
' /tmp/pilot-compare.json | column -t -s $'\t'
```

Interpretation:

- `mean_delta_usd < 0` means hybrid prices lower than strict on average.
- high `claims_floor_hit_rate_pct` means hybrid pricing often binds on claims floor.
- high `implied_subsidy_gap_*` indicates more expected treasury subsidy pressure.

## 5) IBKR market-hours diagnostic runbook

### 5.1 IBKR smoke profile

```bash
cd /opt/ibkr-stack
upsert PILOT_VENUE_MODE ibkr_cme_live
upsert PILOT_HEDGE_POLICY options_only_native
upsert PILOT_PREMIUM_PRICING_MODE hybrid_otm_treasury
upsert PILOT_SELECTOR_MODE hybrid_treasury
upsert IBKR_REQUIRE_LIVE_TRANSPORT true
upsert IBKR_OPTION_LIQUIDITY_SELECTION_ENABLED true
upsert IBKR_OPTION_LIQUIDITY_TENOR_WINDOW_DAYS 4
upsert IBKR_MAX_OPTION_PREMIUM_RATIO 0.15

docker compose up -d --no-deps --force-recreate atticus
curl -sS http://127.0.0.1:8000/pilot/health | jq .
```

### 5.2 Selector diagnostics call

```bash
ADMIN=$(awk -F= '/^PILOT_ADMIN_TOKEN=/{print $2}' /opt/ibkr-stack/.env | tr -d '\r')
curl -sS \
  -H "x-admin-token: $ADMIN" \
  -H "x-forwarded-for: 127.0.0.1" \
  http://127.0.0.1:8000/pilot/admin/diagnostics/selector | jq .
```

Key fields to inspect:

- `timingsMs.total`, `timingsMs.qualify`, `timingsMs.top`, `timingsMs.depth`
- counters: `qualifyCalls`, `topCalls`, `depthCalls`, `optionsLegTimedOut`
- candidate failures:
  - `nNoTop`, `nNoAsk`, `nFailedProtection`, `nFailedEconomics`, `nTimedOut`, `nPassed`

### 5.3 Failure interpretation matrix

- `reason=quote_liquidity_unavailable` and rising `nNoTop`/`nNoAsk`:
  - likely market-window liquidity issue, not transport defect
  - action: wait for better liquidity window, then retry
- `reason=ibkr_transport_not_live`:
  - transport/connectivity issue
  - action: verify bridge transport health/session, then retry
- high `nFailedEconomics` with healthy top/depth:
  - constraints too strict for current market
  - action: adjust constraints (for example max premium ratio/tolerance) under change control

Fallback decisions:

- wait: thin window + deterministic liquidity errors
- switch mode: severe/extended IBKR transport degradation to `deribit_test` for calibration continuity
- adjust constraints: repeated economics failures with valid liquidity

## 6) Treasury risk report template

Populate from current `.env` + compare output:

```markdown
# Treasury Risk Snapshot

## Config snapshot
- pricing mode:
- selector mode:
- per-quote subsidy cap pct:
- daily subsidy cap usdc:
- strict fallback enabled:
- hybrid trigger prob cap:
- hybrid claims coverage factor:
- hybrid markup factor:
- hybrid base fee usd:

## Expected claims approximation
- Approx formula per quote: protected_notional * drawdown_floor_pct * expected_trigger_prob_capped
- Portfolio estimate:

## Premium coverage ratio
- strict mean premium / strict mean expected claims:
- hybrid mean premium / hybrid mean expected claims:

## Daily subsidy cap utilization risk
- implied subsidy gap total (matrix):
- daily cap:
- utilization = implied_subsidy_gap_total / daily_cap

## Trigger concentration warnings
- high concentration tiers/notionals:
- claims-floor hit rate:
- notes on concentrated tenor/strike buckets:
```

## 7) Recommended default preset and expected premium bands

Recommended default for active Deribit calibration:

- `PILOT_PREMIUM_PRICING_MODE=hybrid_otm_treasury`
- `PILOT_SELECTOR_MODE=hybrid_treasury`
- treasury strict fallback enabled with conservative subsidy caps

Expected premium bands should be generated from live quote sweeps by tier/notional:

```bash
for tier in "Pro (Bronze)" "Pro (Silver)" "Pro (Gold)" "Pro (Platinum)"; do
  for n in 5000 10000 25000; do
    curl -sS -X POST http://127.0.0.1:8000/pilot/protections/quote \
      -H 'Content-Type: application/json' \
      -d "{
        \"protectedNotional\": ${n},
        \"foxifyExposureNotional\": ${n},
        \"instrumentId\": \"BTC-USD-7D-P\",
        \"marketId\": \"BTC-USD\",
        \"tierName\": \"${tier}\",
        \"drawdownFloorPct\": 0.2,
        \"protectionType\": \"long\"
      }" | jq -c '{tierName:.quote.tierName, notional:'"${n}"', premiumUsd:.quote.premium, method:.quote.details.pricingBreakdown.method, mode:.quote.details.pricingBreakdown.pricingMode}'
  done
done
```

## 8) Immediate next tuning steps

1. Run fixture and live Deribit compare outputs under strict + hybrid presets and archive JSON/CSV artifacts.
2. Check `claimsFloorHitRatePct` and `impliedSubsidyGap*`; tighten claims coverage / markup if subsidy risk is too high.
3. Run IBKR market-hours smoke and classify failures by liquidity vs transport using selector diagnostics.
4. If transport is healthy but economics fail, adjust IBKR constraints in small increments and rerun matrix.
5. Keep strict fallback enabled while iterating hybrid parameters in live-style calibration.

## 9) Helper script included in repo

Use `scripts/pilot_backend_takeover_ops.sh` to run reproducible backend operations:

- `pull-build-start`
- `preset-strict-baseline`
- `preset-hybrid-candidate`
- `apply-ibkr-market-smoke-profile`
- `recreate-atticus`
- `quote-smoke`
- `activate-smoke`
- `selector-diagnostics`
- `compare-fixture`
- `compare-live-deribit`
- `deribit-matrix`
