# R8 — Pre-Flight Live Deribit Smoke Test Runbook

**Purpose:** Verify the live Deribit account behaves the way the testnet
account did, before any real-money pilot trade is opened. Catches credential
misconfiguration, fee schedule surprises, scope mismatches, and order-type
incompatibilities — the class of issues that you only discover when you flip
to live.

**Trigger:** Run this immediately after Deribit KYC approval and the live
API credentials land, **before** flipping `PILOT_VENUE_MODE=deribit_live` on
Render and **before** opening the pilot to the Foxify CEO.

**Estimated time:** 30-45 minutes.

**Estimated cost:** ~$15-30 USD (one round-trip option trade at a tiny size).

---

## What this catches that the testnet pilot did not

| Risk surface | Testnet covers? | Live-only difference |
|---|---|---|
| API credential format / scopes | Partially | Live keys use a different secret format; permissions may not include trading by default |
| Order-type acceptance | Yes | None expected, but worth verifying market-buy of OTM options doesn't trip a pre-trade compliance gate |
| Fee schedule | No | Testnet doesn't charge fees; live has 0.03% taker fee capped at 12.5% of premium per Deribit spec |
| Settlement timing | No | Testnet settles instantly; live is also near-instant for buys but the audit trail format may differ |
| Margin requirements | No | Live requires you to have collateral on the account; testnet is unlimited paper |
| Rate limits | Partially | Live applies stricter rate limits per IP and per API key |
| Withdrawal scope | No | If the live API key has withdrawal permission enabled by mistake, that's a security exposure |
| BTC USDC vs BTC settlement | Indirectly | Confirm option premiums settle in the currency we expect |

---

## Pre-flight checklist (do BEFORE running the test trade)

### Step 0 — confirm credentials in hand

You need from Deribit:
- `client_id` (the API key public part)
- `client_secret` (the API key secret part — store in a password manager, not chat)

Both must be for **mainnet** (`https://www.deribit.com`), not testnet (`https://test.deribit.com`).

### Step 1 — fund the live account with a small trial balance

Deposit a small amount of BTC or USDC to the live Deribit account — enough to cover ~10 option trades at SL 2% × $50k notional. That's roughly:

- Per-trade hedge cost: ~$30-50 (in normal vol regime, per the n=9 sample's avg of $42).
- 10 trades worth of buffer: **~$500 USDC equivalent** (or ~0.007 BTC).

Confirm the deposit credited via the Deribit web UI before doing anything else.

### Step 2 — confirm API key scopes

Log into the Deribit web UI → Account → API Management → click the new key.

Confirm the following scopes are enabled:
- ✅ `trade:read_write` (must be enabled for the platform to place orders)
- ✅ `account:read` (for position/margin queries)
- ❌ `wallet:read_write` — **MUST BE DISABLED** (we only need trading, never withdrawals; if this is on it's a security exposure)

If `wallet:read_write` is on, regenerate the key with it disabled.

### Step 3 — set Render staging env vars (do NOT touch production yet)

Easiest way to do the smoke test without affecting the deployed pilot is to spin up a **temporary local API server** on your laptop pointed at the live Deribit account, instead of changing production env vars.

```bash
cd /Users/michaelwilliam/Desktop/Foxify_Collar/services/api

# Live Deribit credentials — REPLACE WITH REAL VALUES
export DERIBIT_CLIENT_ID="<your-live-client-id>"
export DERIBIT_CLIENT_SECRET="<your-live-client-secret>"
export PILOT_VENUE_MODE="deribit_live"
export PILOT_API_ENABLED="true"
export PILOT_ACTIVATION_ENABLED="true"
export V7_PRICING_ENABLED="true"
export V7_DEFAULT_TENOR_DAYS="1"
export PILOT_ADMIN_TOKEN="local-smoke-test-token"

# Use a LOCAL Postgres (not the Render one — we don't want smoke-test data in prod)
export POSTGRES_URL="postgres://localhost:5432/foxify_smoke"

# Tenant scope hash secret — anything; this is a fresh local DB
export PILOT_USER_HASH_SECRET="smoke-test-hash-secret"

# Run the API
npm run dev
```

If you don't have local Postgres, install via Homebrew:
```bash
brew install postgresql@16
brew services start postgresql@16
createdb foxify_smoke
```

The API will start on `http://localhost:3000` (or whatever your default port is — check the `npm run dev` output).

---

## The smoke test (~15 min execution, $15-30 cost)

### Step A — verify connectivity (free)

```bash
# 1. Confirm health
curl -sS http://localhost:3000/pilot/health | python3 -m json.tool

# Expected: status: "ok", venue.mode: "deribit_live"
```

```bash
# 2. Confirm DVOL is mainnet (should match real-time market)
curl -sS http://localhost:3000/pilot/regime | python3 -m json.tool

# Expected: dvol matches the live Deribit web UI's DVOL display.
# If dvol is ~133 (synthetic testnet number), the connector is misrouted.
```

```bash
# 3. Confirm reference price is accurate
curl -sS http://localhost:3000/pilot/reference-price | python3 -m json.tool

# Expected: BTC price within $50 of Coinbase / Deribit web UI displayed price.
```

### Step B — Deribit account assertion (free)

Hit the Deribit private API directly to confirm balance + key scopes:

```bash
# Replace these
DERIBIT_KEY="<your-live-client-id>"
DERIBIT_SEC="<your-live-client-secret>"

# Get an access token
TOKEN=$(curl -sS "https://www.deribit.com/api/v2/public/auth?grant_type=client_credentials&client_id=$DERIBIT_KEY&client_secret=$DERIBIT_SEC" | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['access_token'])")

# Account summary
curl -sS -H "Authorization: Bearer $TOKEN" "https://www.deribit.com/api/v2/private/get_account_summary?currency=BTC" | python3 -m json.tool

# Look for:
#   - "balance" matches your deposit
#   - "available_funds" > 0
#   - "deposit_enabled": true
#   - Note the "currency" — confirm it matches what you funded with
```

### Step C — execute a SINGLE smoke trade (~$5-15 cost)

**Using the local widget** (simplest):
1. Visit `http://localhost:3000` (whatever the local frontend serves on, or hit the API directly).
2. Open + Protect: **SL 5%, $10,000, long, no auto-renew**.
   - Why these parameters: SL 5% is the cheapest tier (~$1.55 hedge cost per the n=9 data), $10k is the smallest notional, long is the most-tested side.
3. Watch for the activation to complete (~1-3 sec).
4. Capture the protection ID returned.

**Using curl directly** (alternative):
```bash
# Get a quote
QUOTE=$(curl -sS -X POST http://localhost:3000/pilot/protections/quote \
  -H "Content-Type: application/json" \
  -d '{
    "protectedNotional": 10000,
    "foxifyExposureNotional": 10000,
    "entryPrice": 77000,
    "slPct": 5,
    "tierName": "SL 5%",
    "drawdownFloorPct": 0.05,
    "protectionType": "long",
    "tenorDays": 1
  }')
echo "$QUOTE" | python3 -m json.tool

QUOTE_ID=$(echo "$QUOTE" | python3 -c "import json,sys; print(json.load(sys.stdin)['quote']['quoteId'])")

# Activate
curl -sS -X POST http://localhost:3000/pilot/protections/activate \
  -H "Content-Type: application/json" \
  -d "{
    \"quoteId\": \"$QUOTE_ID\",
    \"protectedNotional\": 10000,
    \"foxifyExposureNotional\": 10000,
    \"entryPrice\": 77000,
    \"slPct\": 5,
    \"tierName\": \"SL 5%\",
    \"drawdownFloorPct\": 0.05,
    \"protectionType\": \"long\",
    \"tenorDays\": 1
  }" | python3 -m json.tool
```

### Step D — verify the live order on Deribit

Open the Deribit web UI → Trade → look for the option position.

**Confirm**:
- ✅ Position exists with the instrument name returned by the activate response
- ✅ Quantity matches the platform's recorded `size`
- ✅ Average fill price matches `executionPrice` in the platform record (within rounding)
- ✅ Account balance decreased by approximately the option premium + fees

If any of these don't match, **STOP** and investigate. Do not flip `PILOT_VENUE_MODE` on Render until reconciled.

### Step E — verify the platform recorded the trade correctly

```bash
# List protections via local API
curl -sS -H "x-admin-token: local-smoke-test-token" \
  http://localhost:3000/pilot/protections?limit=10 | python3 -m json.tool

# Confirm:
#  - The smoke trade is present
#  - status: "active"
#  - venue: "deribit_live" (or whatever venue label deribit_live mode produces)
#  - executionPrice and size are populated
#  - external_order_id matches the Deribit order ID from Step D
```

### Step F — verify exec-quality rollup populated

```bash
curl -sS -H "x-admin-token: local-smoke-test-token" \
  "http://localhost:3000/pilot/admin/diagnostics/execution-quality?lookbackDays=1" | python3 -m json.tool

# Confirm:
#  - rows[0].sample_count == 1
#  - rows[0].fill_success_rate_pct == 100
#  - rows[0].metadata.fills == 1
#  - rows[0].avg_slippage_bps reflects realized fill vs quoted ask
#    (will be small for a SL 5% trade — typically 0-50 bps)
```

### Step G — close the smoke position (capture remaining value)

The smoke position will sit open until expiry (~1 day). To close immediately and recover most of the hedge cost, manually sell on Deribit:

1. Deribit web UI → Positions → click Sell on the position.
2. Choose Market order, full quantity.
3. Confirm.

You'll get back somewhere between 50-100% of the original premium depending on bid-ask spread (per the v6 analysis, ~32% spread drag on 1-day options).

**OR** let it expire naturally. SL 5% has a ~7% trigger rate per backtests; at $10k notional the worst case is a $500 payout on the rare trigger. With BTC trading where it is, very unlikely.

### Step H — checkpoint verification

After the smoke trade is closed (or expired), check:

| Item | Where | Expected |
|---|---|---|
| Deribit account balance | Deribit web UI | Decreased by approximately (premium + fee) − sell-back proceeds |
| Platform protection status | `/pilot/protections` | `expired_otm` or `tp_sold` (if you closed manually) |
| Platform exec-quality row | `/pilot/admin/diagnostics/execution-quality` | sample_count = 1, fill_success_rate_pct = 100 |
| `[Activate] Execution quality upsert failed` | Local API logs | Should NOT appear (PR #31 fix verified) |
| `[HedgeManager] Cycle complete: ... vol=normal(XX)` | Local API logs | DVOL value matches mainnet, not 133 |

If all checkpoints pass: **the live wiring is verified. Proceed to flip `PILOT_VENUE_MODE` on Render.**

If any fail: do NOT flip Render. Document the failure and address before retrying.

---

## What to do AFTER R8 passes

1. **Flip Render env var**: in the Render dashboard for the `foxify-pilot-new` service, set `PILOT_VENUE_MODE=deribit_live` (it may already be that string — check; the connector mode and the trading account binding are independent).
2. **Update `DERIBIT_CLIENT_ID` and `DERIBIT_CLIENT_SECRET`** on Render to the live credentials (NOT the testnet ones).
3. **Trigger a manual deploy** to pick up the env var change.
4. **Watch the Render logs** for the next `[HedgeManager] Cycle complete:` line — confirm it still shows `vol=normal(XX)` (mainnet DVOL) and runs cleanly.
5. **Place ONE more activation via the deployed pilot UI** (not local) at the smallest possible size to confirm the production path works on live.
6. **Then open the pilot URL** to the Foxify CEO.

## What NOT to do

- ❌ Don't flip Render to live without running the smoke test.
- ❌ Don't run the smoke test against the production database — use a local Postgres (per Step 3).
- ❌ Don't enable `wallet:read_write` on the API key.
- ❌ Don't fund the live Deribit account with more than ~$500-1000 USDC for the smoke test. Add more after verification.
- ❌ Don't skip Step G (close or let expire). A dangling open position complicates reconciliation.

## Issues to surface in this turn (analysis only, NO platform changes)

While drafting this, two things worth flagging:

### Issue R8.1 — Local API server requires `apps/web` env to point at it

The `PilotWidget` reads `VITE_API_BASE` to know where to send requests. If you want to use the local widget instead of curl during the smoke test, you'll need to start the frontend with `VITE_API_BASE=http://localhost:3000` instead of the Render URL. Otherwise the local API never gets hit. **Recommend curl-only for smoke test** to avoid the frontend reconfig overhead.

### Issue R8.2 — There's no env var to lock the platform out of trading until smoke complete

`PILOT_ACTIVATION_ENABLED=false` exists and would prevent any activation. Recommend: **set `PILOT_ACTIVATION_ENABLED=false` on Render right before swapping the credentials, then flip back to `true` only after the post-credential-change smoke step (#5 in the after-R8 list) passes.** This protects against any in-flight Foxify CEO request that happens to land during the swap.

This is a runbook detail — no platform code change needed; the env var already exists.

---

_End of R8 runbook._
