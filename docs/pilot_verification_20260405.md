# Bullish Testnet Pilot Verification Report

**Run ID:** `pilot_auth_debug_20260405T025840Z`
**Date:** 2026-04-05T02:58:40Z
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

### Env Var Presence (Cloud Agent VM)

| Variable | Status |
|----------|--------|
| `PILOT_BULLISH_REST_BASE_URL` | **MISSING** (not injected to cloud agent) |
| `PILOT_BULLISH_TRADING_ACCOUNT_ID` | **MISSING** |
| `PILOT_BULLISH_ECDSA_METADATA` | **MISSING** |
| `PILOT_BULLISH_ECDSA_PUBLIC_KEY` | **MISSING** |
| `PILOT_BULLISH_ECDSA_PRIVATE_KEY` | **MISSING** |

> **Note:** Bullish ECDSA credentials are not present in this Cloud Agent VM environment. Previous runs (with secrets injected) confirmed key validity: `publicPrivateMatch = true`, fingerprint `458c48...`, userId `222847629947099`, credentialId `9907722786`.

---

## B) Bullish Auth Diagnostics

### Commands Run

```bash
cd /workspace/services/api
RUN_DIR="artifacts/pilot_auth_debug_20260405T025840Z"
npm run -s pilot:bullish:key-check        # -> 02_key_check.json
npm run -s pilot:bullish:auth-debug       # -> 03_auth_debug.json
npm run -s pilot:bullish:smoke -- --symbol BTCUSDC  # -> 04_smoke.json
```

### Results

| Script | Exit | Status | Detail |
|--------|------|--------|--------|
| `pilot:bullish:key-check` | 0 | `ok` | Both keys absent (cloud agent lacks creds) |
| `pilot:bullish:auth-debug` | 1 | `error` | `public_key_missing` |
| `pilot:bullish:smoke` | 0 | `error` | `bullish_credentials_missing` |
| Metadata decode | 0 | N/A | `has_metadata: false` |

### Known blocker (when creds are present)

From prior authenticated run:
```json
{
  "status": "error",
  "reason": "bullish_smoke_failed",
  "message": "bullish_http_404:{\"message\":\"User does not exist.\",\"errorCode\":8011,\"errorCodeName\":\"USER_NOT_EXISTS\"}"
}
```

**Blocker:** Bullish API returns HTTP 404 with errorCode `8011` (`USER_NOT_EXISTS`). The ECDSA key material is valid and matches, but the associated userId (`222847629947099`) is not provisioned on the Bullish testnet exchange. This requires Bullish-side account provisioning.

---

## C) Public Endpoint Sanity

### Command

```bash
curl -s "https://api.exchange.bullish.com/trading-api/v1/markets"
```

### Result

| Check | Result |
|-------|--------|
| HTTP status | **200 OK** |
| Total markets | 703 |
| BTCUSDC present | **YES** |
| BTC-related symbols (sample) | BTCAUSD, BTCEUR, BTCEURAU, BTCEURC, BTCFIDD, BTCPAXG, BTCPYUSD, BTCRLUSD, BTCUSD |

**Verdict: PASS** - Bullish public API is reachable and BTCUSDC is a valid trading pair.

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
| 2 | Bullish public API reachable | **GO** | HTTP 200, 703 markets |
| 3 | BTCUSDC symbol available | **GO** | Confirmed in market list |
| 4 | ECDSA key material valid | **GO** (prev run) | Keys parse, match, fingerprint verified |
| 5 | Bullish user provisioned | **NO-GO** | errorCode 8011 USER_NOT_EXISTS |
| 6 | Smoke auth end-to-end | **BLOCKED** | Depends on #5 |
| 7 | Pilot floor defaults (20/15/12) | **GO** | 6/6 tests pass |
| 8 | 7-day tenor enforcement | **GO** | Verified via resolveExpiryDays |
| 9 | Premium policy modes | **GO** | actuarial_strict + hybrid_otm_treasury validated |
| 10 | Premium regime overlay | **GO** | stress/watch/dwell/cap logic passes |
| 11 | Model comparison | **GO** | Hybrid saves ~37% vs strict |
| 12 | Premium sweep | **GO** | All 8 grid points acceptable |
| 13 | Execution safety | **GO** | `PILOT_BULLISH_ENABLE_EXECUTION=false` confirmed |

### Overall Verdict: **CONDITIONAL GO**

The pricing model, policy logic, and premium economics are validated and ready. The sole blocker is Bullish-side account provisioning (error 8011). Once the Bullish testnet user is created for userId `222847629947099`, the smoke test should pass and canary can proceed.

### Recommended Canary Execution Settings

```env
PILOT_BULLISH_ENABLE_EXECUTION=false
PILOT_BULLISH_ENABLE_SMOKE_ORDER=false
PILOT_VENUE_MODE=bullish_testnet
PILOT_BULLISH_AUTH_MODE=ecdsa
PILOT_BULLISH_SYMBOL=BTCUSDC
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
  premium_sweep/
    premium_sweep_results.json
    premium_sweep_candidate_summary.csv
    premium_sweep_period_detail.csv
    premium_sweep_overview.md
    configs/   (8 backtest configs)
    prices/    (3 price CSVs)
    runs/      (8 tier dirs x 3 period outputs each)
```
