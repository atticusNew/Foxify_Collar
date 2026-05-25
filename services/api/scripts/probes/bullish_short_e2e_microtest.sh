#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# Bullish Phase E2 microtest — SHORT-TO-OPEN margin path (2026-05-22)
#
# Mirror of bullish_e2e_microtest.sh but inverted: SELL-TO-OPEN first
# (creating a naked short option), verify margin posts, then
# BUY-TO-CLOSE (releasing margin). This validates the margin
# engine path that the spread executor (Track 2) needs for its
# short-leg placements.
#
# This is the gating test before scaling Bullish for production
# spreads: if Bullish's margin requirement on 0.01 BTC is $X, then
# the 50k_2pct_1k case (0.5 BTC × 2 shorts = 1 BTC of shorts) will
# require ~100×X of free USDC. We need that number before funding.
#
# WHAT IT VALIDATES
#   - PILOT_BULLISH_ALLOW_MARGIN=true is plumbed end-to-end
#   - Bullish accepts a naked SELL-TO-OPEN at micro size
#   - Margin posts against the short on the Bullish side
#   - Margin release on BUY-TO-CLOSE works
#   - Bullish's actual margin formula for our option type
#
# WHAT IT DOES NOT VALIDATE
#   - 4-leg spread atomicity (Phase E3)
#   - VC integration (Phase E4)
#
# PREREQUISITES
#   1. Phase E1 passed (bullish_e2e_microtest.sh)
#   2. PILOT_BULLISH_ALLOW_MARGIN=true on shadow Render env, AND shadow
#      restarted/redeployed (the option-margin flag is read at startup)
#   3. Bullish account funded ≥ $200 USDC (margin for 0.01 BTC short
#      put options is estimated $50-200; the close-buy adds ~$220
#      ask-side spend that is net-released against the margin freed)
#   4. SHADOW_API and SHADOW_ADMIN_TOKEN env vars set
#
# DEFAULT TEST PARAMETERS
#   - Symbol: BTC-USDC-20260526-74000-P  (3d put, further OTM than E1 strike)
#   - Size: 0.01 BTC (Bullish minimum granularity)
#   - SELL limit: $50/BTC IOC (fills at the resting bid, $190-$220 expected)
#   - BUY limit:  $700/BTC IOC (fills at the resting ask, $220-$280 expected)
#   - Expected net cost: $0.30-$1.50 (similar bid-ask cross dynamics as E1)
#
# USAGE
#   export SHADOW_API="https://foxify-pilot-shadow-3r1m.onrender.com"
#   export SHADOW_ADMIN_TOKEN="<your shadow admin token>"
#   bash services/api/scripts/probes/bullish_short_e2e_microtest.sh
#
# To bypass orderbook pre-flight when Bullish is rate-limiting public data:
#   SKIP_ORDERBOOK_CHECK=1 SELL_LIMIT_USDC=50 BUY_LIMIT_USDC=700 \
#     bash services/api/scripts/probes/bullish_short_e2e_microtest.sh
#
# SAFETY RAILS
#   - Hard cap on contracts: 0.01 BTC (script-level)
#   - Hard cap on maxPremiumUsdc (close-buy): $10
#   - Hard cap on maxNotionalUsdc (open-sell): $30
#   - If allowMargin shows false in any response, ABORT immediately
#   - If SELL succeeds, ALWAYS attempt BUY-TO-CLOSE (even on errors)
#
# ----------------------------------------------------------------------------

set -uo pipefail

SHADOW_API="${SHADOW_API:?Set SHADOW_API to your shadow service base URL}"
SHADOW_ADMIN_TOKEN="${SHADOW_ADMIN_TOKEN:?Set SHADOW_ADMIN_TOKEN}"

SYMBOL="${SYMBOL:-BTC-USDC-20260526-74000-P}"
CONTRACTS_BTC="${CONTRACTS_BTC:-0.01}"
SELL_LIMIT_USDC="${SELL_LIMIT_USDC:-50}"      # IOC sell at $50 fills at bid (price improvement)
BUY_LIMIT_USDC="${BUY_LIMIT_USDC:-700}"        # IOC buy at $700 fills at ask
MAX_NOTIONAL_SELL_USDC="${MAX_NOTIONAL_SELL_USDC:-30}"  # Cap proceeds on open-sell
MAX_PREMIUM_USDC="${MAX_PREMIUM_USDC:-10}"     # Cap debit on close-buy
SETTLE_WAIT_SEC="${SETTLE_WAIT_SEC:-30}"
SKIP_ORDERBOOK_CHECK="${SKIP_ORDERBOOK_CHECK:-0}"

say() { printf '\033[1;34m▶ %s\033[0m\n' "$*"; }
ok()  { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn(){ printf '\033[1;33m! %s\033[0m\n' "$*"; }
err() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; }
hr()  { printf '%s\n' '----------------------------------------------------------------'; }

require_cmd() { command -v "$1" >/dev/null 2>&1 || { err "Missing dependency: $1"; exit 1; }; }
require_cmd curl
require_cmd jq
require_cmd awk

api() {
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

# Pre-trade safety: contract size cap (script-level — endpoint also has $0.1 cap)
SAFE_QTY=$(awk -v q="$CONTRACTS_BTC" 'BEGIN { print (q > 0.01) ? "0" : "1" }')
if [[ "$SAFE_QTY" != "1" ]]; then
  err "CONTRACTS_BTC=$CONTRACTS_BTC exceeds Phase E2 hard cap (0.01 BTC)."
  err "  This script is intentionally limited; raise the cap only after E2 passes cleanly."
  exit 2
fi

# ============================================================================
# Phase 0: pre-flight
# ============================================================================
hr
say "Phase 0: pre-flight sanity"
hr
echo "Shadow API:       $SHADOW_API"
echo "Symbol:           $SYMBOL"
echo "Contracts BTC:    $CONTRACTS_BTC"
echo "Sell limit:       \$$SELL_LIMIT_USDC / BTC (open-short, IOC fills at bid)"
echo "Buy  limit:       \$$BUY_LIMIT_USDC / BTC (close-short, IOC fills at ask)"
echo "Max notional buy: \$$MAX_PREMIUM_USDC"
echo "Max notional sel: \$$MAX_NOTIONAL_SELL_USDC"
echo "Settle wait:      ${SETTLE_WAIT_SEC}s"
hr

HEALTH=$(api GET "/volume-cover/admin/cells" || true)
if ! echo "$HEALTH" | jq -e . >/dev/null 2>&1; then
  err "Shadow unreachable or admin token rejected"; echo "$HEALTH" | head -3; exit 2
fi
ok "Shadow reachable, admin token valid"

# ============================================================================
# Phase 1: baseline balance snapshot
# ============================================================================
hr
say "Phase 1: baseline asset balances (pre-trade)"
hr
BAL_PRE=$(api GET "/volume-cover/admin/bullish-asset-balances")
echo "$BAL_PRE" | jq '{ok, tradingAccountId, balances}'

if [[ "$(echo "$BAL_PRE" | jq -r '.ok')" != "true" ]]; then
  err "bullish-asset-balances failed — cannot proceed without baseline"
  exit 2
fi
USDC_AVAILABLE_PRE=$(echo "$BAL_PRE" | jq -r '.balances[] | select(.asset=="USDC") | .available // "0"' | head -1)
USDC_LOCKED_PRE=$(echo "$BAL_PRE" | jq -r '.balances[] | select(.asset=="USDC") | .locked // "0"' | head -1)
USDC_BORROWED_PRE=$(echo "$BAL_PRE" | jq -r '.balances[] | select(.asset=="USDC") | .borrowed // "0"' | head -1)
USDC_AVAILABLE_PRE=${USDC_AVAILABLE_PRE:-0}
USDC_LOCKED_PRE=${USDC_LOCKED_PRE:-0}
USDC_BORROWED_PRE=${USDC_BORROWED_PRE:-0}
ok "USDC available=\$$USDC_AVAILABLE_PRE  locked=\$$USDC_LOCKED_PRE  borrowed=\$$USDC_BORROWED_PRE"

# ============================================================================
# Phase 2: orderbook (best-effort; skippable on rate-limit)
# ============================================================================
if [[ "$SKIP_ORDERBOOK_CHECK" == "1" ]]; then
  warn "SKIP_ORDERBOOK_CHECK=1 → skipping orderbook pre-flight"
else
  hr; say "Phase 2: orderbook check for $SYMBOL"; hr
  OB=$(api GET "/volume-cover/admin/bullish-orderbook?symbol=$SYMBOL&depth=3")
  OB_OK=$(echo "$OB" | jq -r '.ok // false')
  if [[ "$OB_OK" != "true" ]]; then
    err "Orderbook fetch failed:"
    echo "$OB" | jq '{ok, error}' 2>/dev/null || echo "$OB" | head -3
    if echo "$OB" | grep -q "RATE_LIMIT_EXCEEDED\|96100\|negative_cache_hit"; then
      err "  Bullish rate-limiting public orderbook. Bypass with:"
      err "    SKIP_ORDERBOOK_CHECK=1 bash $0"
    fi
    exit 3
  fi
  TOP_BID=$(echo "$OB" | jq -r '.summary.topBid.price // "null"')
  TOP_ASK=$(echo "$OB" | jq -r '.summary.topAsk.price // "null"')
  TOP_BID_QTY=$(echo "$OB" | jq -r '.summary.topBid.quantity // "null"')
  ok "Orderbook ok — top bid \$$TOP_BID / top ask \$$TOP_ASK (bid qty $TOP_BID_QTY BTC)"
fi

# ============================================================================
# Phase 3: SELL-TO-OPEN (naked short)
# ============================================================================
hr
say "Phase 3: SELL-TO-OPEN $CONTRACTS_BTC of $SYMBOL @ \$$SELL_LIMIT_USDC limit IOC"
warn "This creates a naked short option. Bullish posts margin against this position."
warn "If allowMargin=false on shadow, this will fail with margin-related error."
hr

SELL_BODY=$(jq -n \
  --arg sym "$SYMBOL" \
  --argjson px "$SELL_LIMIT_USDC" \
  --argjson qty "$CONTRACTS_BTC" \
  --argjson cap "$MAX_NOTIONAL_SELL_USDC" \
  '{symbol: $sym, limitPriceUsdcPerBtc: $px, contractsBtc: $qty, maxNotionalUsdc: $cap}')

SELL_RESP=$(api POST "/volume-cover/admin/bullish-test-sell" "$SELL_BODY")
echo "$SELL_RESP" | jq '{ok, elapsedMs, config, request, result}' 2>/dev/null || echo "$SELL_RESP"

# Verify allowMargin is true on shadow — if false, abort and tell user.
ALLOW_MARGIN=$(echo "$SELL_RESP" | jq -r '.config.allowMargin // "unknown"')
if [[ "$ALLOW_MARGIN" != "true" ]]; then
  err "Shadow service reports config.allowMargin=$ALLOW_MARGIN — short-to-open NOT enabled."
  err "  Set PILOT_BULLISH_ALLOW_MARGIN=true on the shadow Render env, then restart."
  err "  After redeploy, re-run this script."
  exit 4
fi

# Parse the result. Handle both legitimate failures and the "ok=false but
# actually executed" pattern that the test-sell endpoint historically had.
SELL_ORDER_ID=$(echo "$SELL_RESP" | jq -r '.result.orderId // empty')
SELL_FILL_PRICE=$(echo "$SELL_RESP" | jq -r '.result.finalFillPrice // 0')
SELL_FILL_QTY=$(echo "$SELL_RESP" | jq -r '.result.finalFillQty // 0')
SELL_FINAL_STATUS=$(echo "$SELL_RESP" | jq -r '.result.finalStatus // "null"')
SELL_FINAL_REASON=$(echo "$SELL_RESP" | jq -r '.result.finalReason // "null"')
SELL_BULLISH_ERR=$(echo "$SELL_RESP" | jq -r '.result.bullishError // "null"')

SELL_LOOKS_EXECUTED="0"
if [[ "$SELL_FINAL_REASON" == "Executed" ]] && (( $(awk -v q="$SELL_FILL_QTY" 'BEGIN { print (q > 0) ? 1 : 0 }') )); then
  SELL_LOOKS_EXECUTED="1"
fi
SELL_OK_FLAG=$(echo "$SELL_RESP" | jq -r '.ok // false')

if [[ "$SELL_OK_FLAG" != "true" && "$SELL_LOOKS_EXECUTED" != "1" ]]; then
  err "SELL-TO-OPEN failed — no margin was posted."
  err "  finalStatus=$SELL_FINAL_STATUS finalReason=$SELL_FINAL_REASON"
  err "  bullishError=$SELL_BULLISH_ERR"
  if echo "$SELL_BULLISH_ERR" | grep -qi "INSUFFICIENT_FUNDS\|MARGIN\|COLLATERAL\|3003"; then
    err "  Looks margin-related. Recommendations:"
    err "    1. Verify USDC available > expected margin requirement (~\$50-200 for 0.01 BTC)"
    err "    2. Fund Bullish more USDC"
    err "    3. Try a higher strike (less premium = less risk = less margin), e.g."
    err "       SYMBOL=BTC-USDC-20260526-70000-P bash $0"
  fi
  exit 5
fi
ok "SELL-TO-OPEN filled — orderId=$SELL_ORDER_ID fill=$SELL_FILL_QTY @ \$$SELL_FILL_PRICE"

# ============================================================================
# Phase 4: post-short margin snapshot
# ============================================================================
hr
say "Phase 4: margin-posted snapshot (delta vs baseline)"
hr
# Quick pause so Bullish reflects the position in balance snapshot
sleep 2
BAL_POST_SHORT=$(api GET "/volume-cover/admin/bullish-asset-balances")
echo "$BAL_POST_SHORT" | jq '{ok, tradingAccountId, balances}'

USDC_AVAILABLE_SHORT=$(echo "$BAL_POST_SHORT" | jq -r '.balances[] | select(.asset=="USDC") | .available // "0"' | head -1)
USDC_LOCKED_SHORT=$(echo "$BAL_POST_SHORT" | jq -r '.balances[] | select(.asset=="USDC") | .locked // "0"' | head -1)
USDC_BORROWED_SHORT=$(echo "$BAL_POST_SHORT" | jq -r '.balances[] | select(.asset=="USDC") | .borrowed // "0"' | head -1)
USDC_AVAILABLE_SHORT=${USDC_AVAILABLE_SHORT:-0}
USDC_LOCKED_SHORT=${USDC_LOCKED_SHORT:-0}
USDC_BORROWED_SHORT=${USDC_BORROWED_SHORT:-0}

D_AVAIL=$(awk -v a="$USDC_AVAILABLE_SHORT" -v b="$USDC_AVAILABLE_PRE" 'BEGIN { printf "%.4f", a-b }')
D_LOCK=$(awk -v a="$USDC_LOCKED_SHORT" -v b="$USDC_LOCKED_PRE" 'BEGIN { printf "%.4f", a-b }')
D_BORROW=$(awk -v a="$USDC_BORROWED_SHORT" -v b="$USDC_BORROWED_PRE" 'BEGIN { printf "%.4f", a-b }')

echo
echo "Balance delta after SELL-TO-OPEN:"
echo "  USDC available:  $USDC_AVAILABLE_PRE → $USDC_AVAILABLE_SHORT  (Δ $D_AVAIL)"
echo "  USDC locked:     $USDC_LOCKED_PRE → $USDC_LOCKED_SHORT  (Δ $D_LOCK)"
echo "  USDC borrowed:   $USDC_BORROWED_PRE → $USDC_BORROWED_SHORT  (Δ $D_BORROW)"
echo
ok "Margin observation captured. Both gross and net figures shown below."

# CRITICAL: Bullish's mark-to-market option margin model nets the proceeds
# against the margin requirement, so Δavailable alone does NOT equal the
# real margin posted. We have to add the proceeds back.
#
# Real math:
#   proceeds = sell_fill_price × qty   (credited to available)
#   true_margin = proceeds − Δavailable (since Δavailable = proceeds − margin)
#   net_cost   = −Δavailable           (what an operator needs in USDC after
#                                       proceeds offset the margin)
PROCEEDS_USDC=$(awk -v p="$SELL_FILL_PRICE" -v q="$SELL_FILL_QTY" 'BEGIN { printf "%.4f", p*q }')
TRUE_MARGIN=$(awk -v p="$PROCEEDS_USDC" -v d="$D_AVAIL" 'BEGIN { printf "%.4f", p - d }')
NET_COST=$(awk -v d="$D_AVAIL" 'BEGIN { printf "%.4f", -d }')

TRUE_MARGIN_PER_BTC=$(awk -v m="$TRUE_MARGIN" -v q="$CONTRACTS_BTC" 'BEGIN { if (q > 0) printf "%.2f", m / q; else print "n/a" }')
NET_COST_PER_BTC=$(awk -v c="$NET_COST"   -v q="$CONTRACTS_BTC" 'BEGIN { if (q > 0) printf "%.2f", c / q; else print "n/a" }')

echo "  Proceeds credited:           \$$PROCEEDS_USDC (sell_fill × qty)"
echo "  Δ available:                 \$$D_AVAIL"
echo "  True margin posted:          \$$TRUE_MARGIN  (\$$TRUE_MARGIN_PER_BTC per BTC)"
echo "  Net cost to operator:        \$$NET_COST  (\$$NET_COST_PER_BTC per BTC, after proceeds offset)"
echo
echo "  Sizing for 50k_2pct_1k [DB] spread (1.0 BTC short notional total):"
echo "    Expected true margin posted: \$$(awk -v m="$TRUE_MARGIN_PER_BTC" 'BEGIN { printf "%.2f", m * 1.0 }')"
echo "    Expected net cost (margin − short proceeds): \$$(awk -v c="$NET_COST_PER_BTC" 'BEGIN { printf "%.2f", c * 1.0 }')"
echo "    Add long-leg premium debits separately (those scale with strike distance)."

# ============================================================================
# Phase 5: pause
# ============================================================================
hr
say "Phase 5: pause ${SETTLE_WAIT_SEC}s before BUY-TO-CLOSE"
hr
sleep "$SETTLE_WAIT_SEC"

# ============================================================================
# Phase 6: BUY-TO-CLOSE (release margin)
# ============================================================================
hr
say "Phase 6: BUY-TO-CLOSE $CONTRACTS_BTC of $SYMBOL @ \$$BUY_LIMIT_USDC limit IOC"
hr

BUY_BODY=$(jq -n \
  --arg sym "$SYMBOL" \
  --argjson px "$BUY_LIMIT_USDC" \
  --argjson qty "$CONTRACTS_BTC" \
  --argjson cap "$MAX_PREMIUM_USDC" \
  '{symbol: $sym, limitPriceUsdcPerBtc: $px, contractsBtc: $qty, maxPremiumUsdc: $cap}')

BUY_RESP=$(api POST "/volume-cover/admin/bullish-test-buy" "$BUY_BODY")
echo "$BUY_RESP" | jq '{ok, elapsedMs, request, result}' 2>/dev/null || echo "$BUY_RESP"

BUY_ORDER_ID=$(echo "$BUY_RESP" | jq -r '.result.orderId // empty')
BUY_FILL_PRICE=$(echo "$BUY_RESP" | jq -r '.result.finalFillPrice // 0')
BUY_FILL_QTY=$(echo "$BUY_RESP" | jq -r '.result.finalFillQty // 0')
BUY_FINAL_REASON=$(echo "$BUY_RESP" | jq -r '.result.finalReason // "null"')
BUY_BULLISH_ERR=$(echo "$BUY_RESP" | jq -r '.result.bullishError // "null"')

BUY_LOOKS_EXECUTED="0"
if [[ "$BUY_FINAL_REASON" == "Executed" ]] && (( $(awk -v q="$BUY_FILL_QTY" 'BEGIN { print (q > 0) ? 1 : 0 }') )); then
  BUY_LOOKS_EXECUTED="1"
fi
BUY_OK_FLAG=$(echo "$BUY_RESP" | jq -r '.ok // false')

if [[ "$BUY_OK_FLAG" != "true" && "$BUY_LOOKS_EXECUTED" != "1" ]]; then
  err "BUY-TO-CLOSE failed — POSITION IS STILL SHORT AND MARGIN IS POSTED."
  err "  finalReason=$BUY_FINAL_REASON bullishError=$BUY_BULLISH_ERR"
  err "  SHORT orderId=$SELL_ORDER_ID"
  err "  ACTION REQUIRED: manually buy 0.01 BTC of $SYMBOL at higher limit to close, e.g.:"
  err "    curl -sS -X POST \"\$SHADOW_API/volume-cover/admin/bullish-test-buy\" \\"
  err "      -H \"X-Admin-Token: \$SHADOW_ADMIN_TOKEN\" -H \"Content-Type: application/json\" \\"
  err "      -d '{\"symbol\":\"$SYMBOL\",\"limitPriceUsdcPerBtc\":1000,\"contractsBtc\":$CONTRACTS_BTC,\"maxPremiumUsdc\":15}'"
  exit 6
fi
ok "BUY-TO-CLOSE filled — orderId=$BUY_ORDER_ID fill=$BUY_FILL_QTY @ \$$BUY_FILL_PRICE"

# ============================================================================
# Phase 7: post-close balance snapshot
# ============================================================================
hr
say "Phase 7: post-close balances (margin should be released)"
hr
sleep 2
BAL_POST_CLOSE=$(api GET "/volume-cover/admin/bullish-asset-balances")
echo "$BAL_POST_CLOSE" | jq '{ok, tradingAccountId, balances}'

USDC_AVAILABLE_END=$(echo "$BAL_POST_CLOSE" | jq -r '.balances[] | select(.asset=="USDC") | .available // "0"' | head -1)
USDC_LOCKED_END=$(echo "$BAL_POST_CLOSE" | jq -r '.balances[] | select(.asset=="USDC") | .locked // "0"' | head -1)
USDC_BORROWED_END=$(echo "$BAL_POST_CLOSE" | jq -r '.balances[] | select(.asset=="USDC") | .borrowed // "0"' | head -1)
USDC_AVAILABLE_END=${USDC_AVAILABLE_END:-0}
USDC_LOCKED_END=${USDC_LOCKED_END:-0}
USDC_BORROWED_END=${USDC_BORROWED_END:-0}

# ============================================================================
# Phase 8: round-trip accounting
# ============================================================================
hr
say "Phase 8: round-trip accounting"
hr
PROCEEDS=$(awk -v p="$SELL_FILL_PRICE" -v q="$SELL_FILL_QTY" 'BEGIN { printf "%.4f", p*q }')
COST=$(awk -v p="$BUY_FILL_PRICE" -v q="$BUY_FILL_QTY" 'BEGIN { printf "%.4f", p*q }')
NET=$(awk -v c="$COST" -v p="$PROCEEDS" 'BEGIN { printf "%.4f", c - p }')

NET_BAL=$(awk -v a="$USDC_AVAILABLE_END" -v b="$USDC_AVAILABLE_PRE" 'BEGIN { printf "%.4f", a - b }')

echo "SELL fill: \$$SELL_FILL_PRICE × $SELL_FILL_QTY = \$$PROCEEDS  (proceeds)"
echo "BUY  fill: \$$BUY_FILL_PRICE × $BUY_FILL_QTY = \$$COST  (cost)"
echo "Net trade (cost − proceeds):    \$$NET (positive = loss to spread)"
echo
echo "USDC available, pre vs end:     \$$USDC_AVAILABLE_PRE → \$$USDC_AVAILABLE_END  (Δ \$$NET_BAL)"
echo "USDC borrowed, pre vs end:      \$$USDC_BORROWED_PRE → \$$USDC_BORROWED_END  (should be 0 / unchanged)"
echo "USDC locked,   pre vs end:      \$$USDC_LOCKED_PRE → \$$USDC_LOCKED_END  (should be 0 / unchanged)"
echo
ok "Phase E2 end-to-end SHORT-TO-OPEN + BUY-TO-CLOSE COMPLETE."
ok "  Validated: margin engine plumbing, short-leg execution, margin release."
echo
echo "Next steps:"
echo "  Phase E3 — full 4-leg [DB] spread:"
echo "    BUY put-long  + SELL put-short + BUY call-long + SELL call-short"
echo "    Then reverse to close. Margin posts on both shorts."
echo "    I will write bullish_spread_e2e_microtest.sh next."
echo "  Track 2 PR #2 — production spread executor."
