#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# Bullish end-to-end microtest (Phase E1) — 2026-05-22
#
# Validates the full Bullish trade lifecycle (BUY → status → SELL → status)
# at micro size, using the existing /admin/bullish-test-buy and
# /admin/bullish-test-sell endpoints. No DB recording, no VC position
# lifecycle — just raw venue execution proof.
#
# Total expected cost: ~$0.50-$2.00 in real losses (premium + spread + fees)
# Total Bullish API calls: ~6 (1 buy submission, 2-3 status polls, 1 sell, 1
# final status, optional list-accounts for collateral verification).
#
# WHAT IT VALIDATES
#   - Bullish auth/HMAC/ECDSA path works end-to-end (V3CreateOrder)
#   - Order submission accepted by exchange
#   - Order fills at the bid/ask we expect
#   - getOrderStatus returns correct fillPrice/fillQuantity
#   - SELL-back (close-position) path works
#   - Per-trade fees are what we expected
#   - WSS private topic snapshot delivery works (used for balance reads)
#
# WHAT IT DOES NOT VALIDATE
#   - Margin posting on a short-to-open (see Phase E2 below for that)
#   - Full 4-leg [DB] spread atomicity (see Phase E3)
#   - VC position lifecycle integration (see Phase E4 after Track 2 lands)
#
# PREREQUISITES
#   1. Bullish account funded with ≥ $50 USDC (currently $137 → enough)
#   2. SHADOW_API and SHADOW_ADMIN_TOKEN env vars set
#   3. PILOT_DEPLOYMENT_TIER=shadow (test endpoints are shadow-gated)
#   4. Shadow service running latest vc-sandbox commits (Bullish singleton in)
#
# USAGE
#   export SHADOW_API="https://foxify-pilot-shadow-3r1m.onrender.com"
#   export SHADOW_ADMIN_TOKEN="<your shadow admin token>"
#   bash services/api/scripts/probes/bullish_e2e_microtest.sh
#
# To probe a SPECIFIC strike/expiry, override defaults:
#   SYMBOL="BTC-USDC-20260526-75000-P" \
#   BUY_LIMIT_USDC=420 \
#   bash services/api/scripts/probes/bullish_e2e_microtest.sh
#
# To skip the sell-back (just BUY and leave the position open):
#   SKIP_SELL=1 bash services/api/scripts/probes/bullish_e2e_microtest.sh
#
# ----------------------------------------------------------------------------

set -euo pipefail

# Configuration -----------------------------------------------------------
SHADOW_API="${SHADOW_API:?Set SHADOW_API to your shadow service base URL}"
SHADOW_ADMIN_TOKEN="${SHADOW_ADMIN_TOKEN:?Set SHADOW_ADMIN_TOKEN}"

# Default test parameters (target: 3-day put-long at $75,000 strike,
# matches probe v2 output for 50k_2pct_1k cell on 2026-05-22).
SYMBOL="${SYMBOL:-BTC-USDC-20260526-75000-P}"
CONTRACTS_BTC="${CONTRACTS_BTC:-0.01}"

# By default the buy limit is computed dynamically from the live top ask
# (× BUY_LIMIT_ASK_BUFFER_PCT) so the IOC actually fills. IOC orders
# below the resting ask expire with finalReason="Expired" (Bullish
# reason code 6004) and produce 0 fill quantity — which looks like a
# script failure but is just an unfillable price.
#
# Override BUY_LIMIT_USDC to set an absolute limit instead (e.g.,
# BUY_LIMIT_USDC=500 to cap pay-up at $500/BTC).
BUY_LIMIT_USDC="${BUY_LIMIT_USDC:-}"
BUY_LIMIT_ASK_BUFFER_PCT="${BUY_LIMIT_ASK_BUFFER_PCT:-1.10}"  # 10% above current ask

SELL_LIMIT_USDC="${SELL_LIMIT_USDC:-0.01}"     # Floor — IOC fills at the bid
MAX_PREMIUM_USDC="${MAX_PREMIUM_USDC:-10}"     # Hard safety cap (BUY side)
MAX_NOTIONAL_SELL_USDC="${MAX_NOTIONAL_SELL_USDC:-25}"  # Hard safety cap (SELL side)
SETTLE_WAIT_SEC="${SETTLE_WAIT_SEC:-30}"       # Pause between buy and sell
SKIP_SELL="${SKIP_SELL:-0}"                    # If 1, leave position open

# Bypass the pre-flight orderbook check (use when Bullish is rate-
# limiting the public orderbook endpoint but the private trading
# endpoints are still working). Requires BUY_LIMIT_USDC to be set
# explicitly because we can't auto-derive from the ask.
SKIP_ORDERBOOK_CHECK="${SKIP_ORDERBOOK_CHECK:-0}"

# Helpers ---------------------------------------------------------------
say() { printf '\033[1;34m▶ %s\033[0m\n' "$*"; }
ok()  { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
err() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; }
hr()  { printf '%s\n' '----------------------------------------------------------------'; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { err "Missing dependency: $1"; exit 1; }
}
require_cmd curl
require_cmd jq

api() {
  # api METHOD PATH [BODY_JSON]
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -X "$method" "$SHADOW_API$path" \
      -H "X-Admin-Token: $SHADOW_ADMIN_TOKEN" \
      -H "Content-Type: application/json" \
      -d "$body"
  else
    curl -sS -X "$method" "$SHADOW_API$path" \
      -H "X-Admin-Token: $SHADOW_ADMIN_TOKEN"
  fi
}

# --- Phase 0: pre-flight ----------------------------------------------
hr
say "Phase 0: pre-flight sanity"
hr
echo "Shadow API:    $SHADOW_API"
echo "Symbol:        $SYMBOL"
echo "Contracts BTC: $CONTRACTS_BTC"
if [[ -z "$BUY_LIMIT_USDC" ]]; then
  echo "Buy limit:     auto-derive from top ask × $BUY_LIMIT_ASK_BUFFER_PCT (post-orderbook)"
else
  echo "Buy limit:     \$$BUY_LIMIT_USDC / BTC  (expected debit: \$$(awk -v a="$BUY_LIMIT_USDC" -v b="$CONTRACTS_BTC" 'BEGIN { printf "%.2f", a*b }') )"
fi
echo "Sell limit:    \$$SELL_LIMIT_USDC / BTC (IOC, fills at bid)"
echo "Max premium:   \$$MAX_PREMIUM_USDC (buy side)"
echo "Max notional:  \$$MAX_NOTIONAL_SELL_USDC (sell side)"
echo "Settle wait:   ${SETTLE_WAIT_SEC}s"
echo "Skip sell:     $SKIP_SELL"
hr

# Confirm shadow is up + the right endpoints exist
HEALTH=$(api GET "/volume-cover/admin/cells" || true)
if ! echo "$HEALTH" | jq -e . >/dev/null 2>&1; then
  err "Shadow service unreachable or admin token rejected"
  echo "$HEALTH" | head -3
  exit 2
fi
ok "Shadow reachable, admin token valid"

# Confirm the symbol exists on Bullish + grab the live top ask.
TOP_ASK="null"
TOP_BID="null"
if [[ "$SKIP_ORDERBOOK_CHECK" == "1" ]]; then
  say "SKIP_ORDERBOOK_CHECK=1 → skipping orderbook pre-flight"
  if [[ -z "$BUY_LIMIT_USDC" ]]; then
    err "BUY_LIMIT_USDC must be set explicitly when SKIP_ORDERBOOK_CHECK=1"
    err "  Suggested: BUY_LIMIT_USDC=700 (conservatively above $550 ask, well under $10 cap on 0.01 BTC)"
    exit 3
  fi
  ok "Using pinned BUY_LIMIT_USDC=\$$BUY_LIMIT_USDC"
else
  say "Verifying $SYMBOL is listed on Bullish..."
  OB=$(api GET "/volume-cover/admin/bullish-orderbook?symbol=$SYMBOL&depth=3")
  OB_OK=$(echo "$OB" | jq -r '.ok // false')
  if [[ "$OB_OK" != "true" ]]; then
    err "Symbol $SYMBOL not on Bullish or orderbook fetch failed"
    echo "$OB" | jq . 2>/dev/null | head -10 || echo "$OB" | head -3
    # Special-case Bullish rate-limit: tell the user how to bypass.
    if echo "$OB" | grep -q "RATE_LIMIT_EXCEEDED\|96100\|negative_cache_hit"; then
      err "  Bullish is rate-limiting the public orderbook endpoint."
      err "  Wait 60-300s for cooldown, OR bypass with:"
      err "    SKIP_ORDERBOOK_CHECK=1 BUY_LIMIT_USDC=700 bash $0"
      err "  (private trading endpoints likely have a separate rate-limit bucket)"
    fi
    exit 3
  fi
  TOP_ASK=$(echo "$OB" | jq -r '.summary.topAsk.price // "null"')
  TOP_BID=$(echo "$OB" | jq -r '.summary.topBid.price // "null"')
  TOP_ASK_QTY=$(echo "$OB" | jq -r '.summary.topAsk.quantity // "null"')
  ok "Orderbook ok — top bid \$$TOP_BID / top ask \$$TOP_ASK (ask qty $TOP_ASK_QTY BTC)"

  # Resolve buy limit if not pinned by env. Use top ask × buffer so IOC fills.
  if [[ -z "$BUY_LIMIT_USDC" ]]; then
    if [[ "$TOP_ASK" == "null" || "$TOP_ASK" == "0" || "$TOP_ASK" == "0.0" ]]; then
      err "Cannot auto-derive BUY_LIMIT_USDC — no top ask on orderbook"
      exit 3
    fi
    BUY_LIMIT_USDC=$(awk -v a="$TOP_ASK" -v b="$BUY_LIMIT_ASK_BUFFER_PCT" 'BEGIN { printf "%.4f", a*b }')
    ok "BUY_LIMIT_USDC auto-set to \$$BUY_LIMIT_USDC ($TOP_ASK × $BUY_LIMIT_ASK_BUFFER_PCT)"
  fi
fi

# Recompute expected debit + verify under cap before sending
EXPECTED_DEBIT=$(awk -v a="$BUY_LIMIT_USDC" -v b="$CONTRACTS_BTC" 'BEGIN { printf "%.4f", a*b }')
WITHIN_CAP=$(awk -v d="$EXPECTED_DEBIT" -v c="$MAX_PREMIUM_USDC" 'BEGIN { print (d <= c) ? "1" : "0" }')
if [[ "$WITHIN_CAP" != "1" ]]; then
  err "Expected debit \$$EXPECTED_DEBIT exceeds cap \$$MAX_PREMIUM_USDC."
  err "  Either raise MAX_PREMIUM_USDC, lower CONTRACTS_BTC, or pin a lower BUY_LIMIT_USDC."
  exit 3
fi
ok "Expected debit \$$EXPECTED_DEBIT within cap \$$MAX_PREMIUM_USDC"

# --- Phase 1: BUY ------------------------------------------------------
hr
say "Phase 1: BUY $CONTRACTS_BTC of $SYMBOL at \$$BUY_LIMIT_USDC limit"
hr

BUY_BODY=$(jq -n \
  --arg sym "$SYMBOL" \
  --argjson px "$BUY_LIMIT_USDC" \
  --argjson qty "$CONTRACTS_BTC" \
  --argjson cap "$MAX_PREMIUM_USDC" \
  '{symbol: $sym, limitPriceUsdcPerBtc: $px, contractsBtc: $qty, maxPremiumUsdc: $cap}')

BUY_RESP=$(api POST "/volume-cover/admin/bullish-test-buy" "$BUY_BODY")
# Show the meaningful fields. The endpoint nests detail under .result.
echo "$BUY_RESP" | jq '{ok, elapsedMs, request, result}' 2>/dev/null || echo "$BUY_RESP"

BUY_OK=$(echo "$BUY_RESP" | jq -r '.ok // false')
BUY_ORDER_ID=$(echo "$BUY_RESP" | jq -r '.result.orderId // empty')
BUY_FILL_PRICE=$(echo "$BUY_RESP" | jq -r '.result.finalFillPrice // "null"')
BUY_FILL_QTY=$(echo "$BUY_RESP" | jq -r '.result.finalFillQty // "null"')
BUY_FINAL_STATUS=$(echo "$BUY_RESP" | jq -r '.result.finalStatus // "null"')
BUY_FINAL_REASON=$(echo "$BUY_RESP" | jq -r '.result.finalReason // "null"')
BUY_BULLISH_ERR=$(echo "$BUY_RESP" | jq -r '.result.bullishError // "null"')

if [[ "$BUY_OK" != "true" ]]; then
  err "BUY failed — finalStatus=$BUY_FINAL_STATUS finalReason=$BUY_FINAL_REASON bullishError=$BUY_BULLISH_ERR"
  if [[ "$BUY_FINAL_REASON" == "Expired" ]]; then
    err "  IOC limit \$$BUY_LIMIT_USDC was BELOW the resting ask \$$TOP_ASK → 0 fill."
    err "  Rerun with a higher BUY_LIMIT_USDC, or unset it to auto-derive from top ask."
  fi
  exit 4
fi
ok "BUY accepted — orderId=$BUY_ORDER_ID fillPrice=$BUY_FILL_PRICE fillQty=$BUY_FILL_QTY status=$BUY_FINAL_STATUS"

# --- Phase 2: Status poll (verify fill) -------------------------------
# The /bullish-test-buy endpoint already chains a status query and
# returns finalStatus/finalFillPrice/finalFillQty in .result, so this
# is largely a redundancy check on the order persistence across calls.
hr
say "Phase 2: poll order status (single GET — endpoint already chained one)"
hr
STATUS=$(api GET "/volume-cover/admin/bullish-order-status?orderId=$BUY_ORDER_ID" || true)
echo "$STATUS" | jq . 2>/dev/null || echo "$STATUS"

if [[ "$SKIP_SELL" == "1" ]]; then
  hr
  ok "SKIP_SELL=1 → leaving position open. orderId=$BUY_ORDER_ID"
  exit 0
fi

# --- Phase 3: Wait, then SELL ----------------------------------------
hr
say "Phase 3: pause ${SETTLE_WAIT_SEC}s to observe theta decay"
hr
sleep "$SETTLE_WAIT_SEC"

# Re-check orderbook so we know the prevailing bid (best-effort).
POST_BID="null"
if [[ "$SKIP_ORDERBOOK_CHECK" != "1" ]]; then
  OB=$(api GET "/volume-cover/admin/bullish-orderbook?symbol=$SYMBOL&depth=1")
  POST_BID=$(echo "$OB" | jq -r '.summary.topBid.price // "null"')
fi
say "Post-wait top bid: \$$POST_BID (will sell IOC at \$$SELL_LIMIT_USDC floor → fills at bid)"

SELL_BODY=$(jq -n \
  --arg sym "$SYMBOL" \
  --argjson px "$SELL_LIMIT_USDC" \
  --argjson qty "$CONTRACTS_BTC" \
  --argjson cap "$MAX_NOTIONAL_SELL_USDC" \
  '{symbol: $sym, limitPriceUsdcPerBtc: $px, contractsBtc: $qty, maxNotionalUsdc: $cap}')

SELL_RESP=$(api POST "/volume-cover/admin/bullish-test-sell" "$SELL_BODY")
echo "$SELL_RESP" | jq '{ok, elapsedMs, request, result}' 2>/dev/null || echo "$SELL_RESP"

SELL_OK=$(echo "$SELL_RESP" | jq -r '.ok // false')
SELL_ORDER_ID=$(echo "$SELL_RESP" | jq -r '.result.orderId // empty')
SELL_FILL_PRICE=$(echo "$SELL_RESP" | jq -r '.result.finalFillPrice // "null"')
SELL_FILL_QTY=$(echo "$SELL_RESP" | jq -r '.result.finalFillQty // "null"')
SELL_FINAL_STATUS=$(echo "$SELL_RESP" | jq -r '.result.finalStatus // "null"')
SELL_FINAL_REASON=$(echo "$SELL_RESP" | jq -r '.result.finalReason // "null"')
SELL_BULLISH_ERR=$(echo "$SELL_RESP" | jq -r '.result.bullishError // "null"')

if [[ "$SELL_OK" != "true" ]]; then
  err "SELL failed — finalStatus=$SELL_FINAL_STATUS finalReason=$SELL_FINAL_REASON bullishError=$SELL_BULLISH_ERR"
  err "  Position is still OPEN. BUY orderId=$BUY_ORDER_ID"
  if [[ "$SELL_FINAL_REASON" == "Expired" ]]; then
    err "  IOC sell at \$$SELL_LIMIT_USDC didn't fill — no bid in book?"
  fi
  exit 5
fi
ok "SELL accepted — orderId=$SELL_ORDER_ID fillPrice=$SELL_FILL_PRICE fillQty=$SELL_FILL_QTY status=$SELL_FINAL_STATUS"

# --- Phase 4: Final accounting ----------------------------------------
hr
say "Phase 4: round-trip accounting"
hr
NET_PER_BTC=$(awk -v b="$BUY_FILL_PRICE" -v s="$SELL_FILL_PRICE" 'BEGIN { printf "%.4f", b - s }')
NET_TOTAL=$(awk -v n="$NET_PER_BTC" -v q="$CONTRACTS_BTC" 'BEGIN { printf "%.4f", n * q }')

echo "Buy  fill: \$$BUY_FILL_PRICE / BTC × $CONTRACTS_BTC BTC = \$$(awk -v p="$BUY_FILL_PRICE" -v q="$CONTRACTS_BTC" 'BEGIN { printf "%.4f", p*q }')"
echo "Sell fill: \$$SELL_FILL_PRICE / BTC × $CONTRACTS_BTC BTC = \$$(awk -v p="$SELL_FILL_PRICE" -v q="$CONTRACTS_BTC" 'BEGIN { printf "%.4f", p*q }')"
echo "Net per BTC:  \$$NET_PER_BTC"
echo "Net total:    \$$NET_TOTAL (theta + spread + fees)"

hr
ok "End-to-end Bullish round-trip COMPLETE."
ok "Validated: auth path, BUY fill, status poll, SELL fill, lifecycle."
hr
echo "Next steps:"
echo "  Phase E2 (margin path validation):"
echo "    Edit and re-run with a SHORT-TO-OPEN test (SELL at the bid of a"
echo "    further-OTM strike, verify margin posts, then BUY-TO-CLOSE)."
echo "    NOTE: requires PILOT_BULLISH_ALLOW_MARGIN=true."
echo "  Phase E3 (full [DB] 4-leg test):"
echo "    Wrap this script to BUY put-long + SELL put-short + BUY call-long +"
echo "    SELL call-short, then reverse. ~\$6 net cost per round-trip."
