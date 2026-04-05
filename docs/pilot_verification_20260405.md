# Bullish Testnet Pilot Verification Report

**Run ID:** `pilot_auth_debug_20260405T025840Z`
**Date:** 2026-04-05T02:58:40Z (updated 2026-04-05T03:16Z with testnet resolution)
**Branch:** `cursor/-bc-e51d2b47-923d-4e8c-9cb9-44b1a0efb37c-4a4e`
**Base branch:** `cursor/bullish-locked-profile-phase-a` (merged, ancestor confirmed)
**Commit:** `b983579`

---

## A) Branch and Env Sanity

| Check | Result |
|-------|--------|
| Branch confirmed | `cursor/-bc-e51d2b47-923d-4e8c-9cb9-44b1a0efb37c-4a4e` |
| Base branch merged | YES (is ancestor of HEAD) |
| Working tree | Clean |
| npm deps (root) | Installed |
| npm deps (services/api) | Installed |
| Node.js available | YES |

### Env Var Presence

| Variable | Status |
|----------|--------|
| `PILOT_BULLISH_REST_BASE_URL` | **SET** (`https://api.simnext.bullish-test.com`) |
| `PILOT_BULLISH_TRADING_ACCOUNT_ID` | SET (discovered: `111920783890876`) |
| `PILOT_BULLISH_ECDSA_METADATA` | **SET** (userId `222847629947099`, credentialId `9907722786`) |
| `PILOT_BULLISH_ECDSA_PUBLIC_KEY` | **SET** (derived from private key, fingerprint `458c48...`) |
| `PILOT_BULLISH_ECDSA_PRIVATE_KEY` | **SET** (PKCS8, EC P-256) |

---

## B) Bullish Auth Diagnostics

### Root-cause resolution: error 8011 USER_NOT_EXISTS

The previous blocker was caused by pointing at the **production** URL (`api.exchange.bullish.com`) instead of the **testnet** URL (`api.simnext.bullish-test.com`). The user account exists on the Bullish SimNext testnet, not on production.

**Fix:** Changed `PILOT_BULLISH_REST_BASE_URL` from `https://api.exchange.bullish.com` to `https://api.simnext.bullish-test.com`. Updated `.env.example` accordingly.

### Commands Run

```bash
cd /workspace/services/api
RUN_DIR="artifacts/pilot_auth_debug_20260405T025840Z"
npx tsx scripts/pilotBullishKeyCheck.ts          # -> 02_key_check.json
npx tsx scripts/pilotBullishAuthDebug.ts          # -> 18_auth_debug_testnet.json
npx tsx scripts/pilotBullishSmokeTest.ts --symbol BTCUSDC  # -> 19_smoke_testnet.json
```

### Results (against testnet)

| Script | Exit | Status | Detail |
|--------|------|--------|--------|
| `pilot:bullish:key-check` | 0 | `ok` | Keys present, parse OK, fingerprint match |
| `pilot:bullish:auth-debug` | 0 | `ok` | `publicPrivateMatch: true`, userId `222847629947099` |
| `pilot:bullish:smoke` | 0 | **`ok`** | **ECDSA login succeeded, trading account discovered, orderbook live** |

### Smoke test output (testnet)

```json
{
  "status": "ok",
  "symbol": "BTCUSDC",
  "steps": {
    "auth": { "mode": "jwt_via_ecdsa_login" },
    "tradingAccounts": {
      "count": 1,
      "tradingAccountIds": ["111920783890876"]
    },
    "orderbook": {
      "bids": [{"price": "67141.7000", "quantity": "0.00005750"}, ...],
      "asks": [{"price": "67141.8000", "quantity": "0.00634155"}, ...],
      "sequenceNumber": "10861031",
      "timestamp": "1775359755665"
    }
  }
}
```

---

## C) Public Endpoint Sanity

### Testnet endpoint

```bash
curl -s "https://api.simnext.bullish-test.com/trading-api/v1/markets"
```

| Check | Result |
|-------|--------|
| HTTP status | **200 OK** |
| BTCUSDC present | **YES** |

### Production endpoint (also verified)

| Check | Result |
|-------|--------|
| HTTP status | **200 OK** |
| Total markets | 703 |
| BTCUSDC present | **YES** |

**Verdict: PASS** - Both testnet and production public APIs are reachable and BTCUSDC is a valid trading pair.

---

## D) Pilot Pricing and Policy Checks

### Commands

```bash
npx tsx --test tests/pilotFloor.test.ts
npx tsx --test tests/pricingPolicy.test.ts
npx tsx --test tests/premiumRegime.test.ts
npx tsx --test tests/pilotConfig.test.ts
npx tsx --test tests/modelComparison.test.ts
npx tsx --test tests/pilotPremiumRegimeRoutes.test.ts
npx tsx --test tests/protectionMath.test.ts
```

### Results

| Test Suite | Tests | Pass | Fail | Verdict |
|------------|-------|------|------|---------|
| `pilotFloor.test.ts` | 6 | 6 | 0 | **PASS** |
| `pricingPolicy.test.ts` | 6 | 6 | 0 | **PASS** |
| `premiumRegime.test.ts` | 4 | 4 | 0 | **PASS** |
| `pilotConfig.test.ts` | 24 | 24 | 0 | **PASS** |
| `modelComparison.test.ts` | 4 | 4 | 0 | **PASS** |
| `pilotPremiumRegimeRoutes.test.ts` | 1 | 1 | 0 | **PASS** |
| `protectionMath.test.ts` | 4 | 4 | 0 | **PASS** |
| **Total** | **49** | **49** | **0** | **ALL PASS** |

### Coverage Verification

- **Floor defaults:** Bronze 0.20, Silver 0.15, Gold/Platinum 0.12 - tested via `resolveDrawdownFloorPct` and `computeFloorPrice`
- **7-day tenor:** `resolveExpiryDays` clamps to configured bounds, default `expiryDays: 7` from `PILOT_TIER_DEFAULTS`
- **Premium policy modes:**
  - `actuarial_strict`: floor profitability behavior verified
  - `hybrid_otm_treasury`: discount pricing with actuarial diagnostics preserved
  - `resolvePricingPolicyMode` normalization tested
- **Premium regime overlay:** stress/watch/normal transitions, dwell enforcement, add-per-1k + multiplier + cap logic, disabled-mode no-op

### Pre-existing Failures (Out of Scope)

`pilotVenue.test.ts`: 11 IBKR `ibkr_cme_paper` tests fail (futures fallback, liquidity-first mode, qualify cache). These are IBKR-specific and pre-existing. Not related to Bullish pilot.

---

## E) Premium Analytics

### E.1) Model Comparison (actuarial baseline vs hybrid)

**Command:**
```bash
npx tsx scripts/pilotCompareModels.ts \
  --fixture tests/fixtures/pilotCompareModels.fixture.json \
  --out-json $RUN_DIR/14_model_compare.json \
  --out-csv $RUN_DIR/14_model_compare.csv
```

**Summary:**

| Metric | Value |
|--------|-------|
| Scenarios | 2 |
| Strict mean premium | $178.75 |
| Hybrid mean premium | $112.40 |
| Mean delta | -$66.36 (hybrid saves 37%) |
| Median delta | -$66.36 |

**Per-scenario:**

| Scenario | Tier | Notional | Floor% | Strict | Hybrid | Delta |
|----------|------|----------|--------|--------|--------|-------|
| bronze_5k_1k | Pro (Bronze) | $5,000 | 20% | $210.50 | $126.30 | -$84.20 |
| silver_5k_750 | Pro (Silver) | $5,000 | 15% | $147.00 | $98.49 | -$48.51 |

### E.2) Premium Sweep Backtest

**Command:**
```bash
npx tsx scripts/pilotBacktestPremiumSweep.ts \
  --config scripts/fixtures/pilot_backtest_config.example.json \
  --out-dir $RUN_DIR/premium_sweep \
  --source coinbase \
  --period-profile consistent_core \
  --bronze-grid 18,19,20,21,22,23,24,25 \
  --skip-fetch false
```

**Per-tier minimum viable fixed premium candidates:**

| Bronze $/1k | Decision | Stress Subsidy Need | Stress Blocked | Rolling 12m Subsidy Need | Rolling 12m Blocked | Rec Buffer |
|-------------|----------|---------------------|----------------|--------------------------|---------------------|------------|
| **18.00** | acceptable | $0 | $0 | $7,959.56 | $3,448.76 | $25,000 |
| 19.00 | acceptable | $0 | $0 | $7,601.56 | $2,840.16 | $25,000 |
| 20.00 | acceptable | $0 | $0 | $7,243.56 | $2,231.56 | $25,000 |
| 21.00 | acceptable | $0 | $0 | $6,885.56 | $1,622.96 | $25,000 |
| 22.00 | acceptable | $0 | $0 | $6,527.56 | $1,014.36 | $25,000 |
| 23.00 | acceptable | $0 | $0 | $6,169.56 | $405.76 | $25,000 |
| 24.00 | acceptable | $0 | $0 | $5,811.56 | $81.16 | $25,000 |
| 25.00 | acceptable | $0 | $0 | $5,453.56 | $76.06 | $25,000 |

**Sweep recommendation:** Bronze **$18.00/1k** is the lowest acceptable premium. All 8 grid points pass stress cap. Rolling 12m blocked subsidy decreases as premium rises, reaching near-zero at $24-25/1k.

---

## F) Go/No-Go Checklist for Canary

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | Branch integrity | **GO** | Base merged, clean tree |
| 2 | Bullish testnet API reachable | **GO** | HTTP 200, `api.simnext.bullish-test.com` |
| 3 | BTCUSDC symbol available | **GO** | Confirmed in market list |
| 4 | ECDSA key material valid | **GO** | Keys parse, match, fingerprint `458c48...` |
| 5 | Bullish user provisioned | **GO** | userId `222847629947099` exists on SimNext testnet |
| 6 | Smoke auth end-to-end | **GO** | JWT login succeeded, trading account `111920783890876` discovered |
| 7 | Orderbook live data | **GO** | BTCUSDC bids/asks streaming, sequenceNumber advancing |
| 8 | Pilot floor defaults (20/15/12) | **GO** | 6/6 tests pass |
| 9 | 7-day tenor enforcement | **GO** | Verified via resolveExpiryDays |
| 10 | Premium policy modes | **GO** | actuarial_strict + hybrid_otm_treasury validated |
| 11 | Premium regime overlay | **GO** | stress/watch/dwell/cap logic passes |
| 12 | Model comparison | **GO** | Hybrid saves ~37% vs strict |
| 13 | Premium sweep | **GO** | All 8 grid points acceptable |
| 14 | Execution safety | **GO** | `PILOT_BULLISH_ENABLE_EXECUTION=false` confirmed |

### Overall Verdict: **GO**

All checks pass. The previous 8011 blocker is resolved -- root cause was using the production URL instead of the SimNext testnet URL. Auth, orderbook, and trading account discovery all succeed on `api.simnext.bullish-test.com`.

### Recommended Canary Execution Settings

```env
PILOT_BULLISH_REST_BASE_URL=https://api.simnext.bullish-test.com
PILOT_BULLISH_ENABLE_EXECUTION=false
PILOT_BULLISH_ENABLE_SMOKE_ORDER=false
PILOT_VENUE_MODE=bullish_testnet
PILOT_BULLISH_AUTH_MODE=ecdsa
PILOT_BULLISH_SYMBOL=BTCUSDC
PILOT_BULLISH_TRADING_ACCOUNT_ID=111920783890876
PILOT_PREMIUM_POLICY_MODE=hybrid_otm_treasury
```

---

## Artifact Paths

```
artifacts/pilot_auth_debug_20260405T025840Z/
  01_env_presence.txt
  02_key_check.json
  03_auth_debug.json
  04_smoke.json
  05_metadata_decode.json
  06_markets_public.txt
  07_symbol_check.json
  08_pilotFloor_test.txt
  09_pricingPolicy_test.txt
  10_premiumRegime_test.txt
  11_pilotConfig_test.txt
  12_modelComparison_test.txt
  13_premiumRegimeRoutes_test.txt
  14_model_compare.json
  14_model_compare.csv
  14_model_compare_output.txt
  15_premium_sweep_output.txt
  16_ibkr_venue_failures.txt
  17_all_pricing_tests.txt
  18_auth_debug_testnet.json     (NEW - testnet auth-debug)
  19_smoke_testnet.json          (NEW - testnet smoke PASS)
  premium_sweep/
    premium_sweep_results.json
    premium_sweep_candidate_summary.csv
    premium_sweep_period_detail.csv
    premium_sweep_overview.md
    configs/   (8 backtest configs)
    prices/    (3 price CSVs)
    runs/      (8 tier dirs x 3 period outputs each)
```

## How to Pull Reports

From the repo root:

```bash
# Pull the latest verification report
git pull origin cursor/-bc-e51d2b47-923d-4e8c-9cb9-44b1a0efb37c-4a4e
cat docs/pilot_verification_20260405.md

# Re-run and regenerate local artifacts
cd services/api
npm install
RUN_DIR="artifacts/pilot_auth_debug_$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$RUN_DIR"
npx tsx scripts/pilotBullishAuthDebug.ts | tee "$RUN_DIR/auth_debug.json"
npx tsx scripts/pilotBullishSmokeTest.ts --symbol BTCUSDC | tee "$RUN_DIR/smoke.json"
npx tsx scripts/pilotCompareModels.ts \
  --fixture tests/fixtures/pilotCompareModels.fixture.json \
  --out-json "$RUN_DIR/model_compare.json" \
  --out-csv "$RUN_DIR/model_compare.csv"
npx tsx scripts/pilotBacktestPremiumSweep.ts \
  --config scripts/fixtures/pilot_backtest_config.example.json \
  --out-dir "$RUN_DIR/premium_sweep" \
  --source coinbase \
  --period-profile consistent_core \
  --bronze-grid 18,19,20,21,22,23,24,25
```
