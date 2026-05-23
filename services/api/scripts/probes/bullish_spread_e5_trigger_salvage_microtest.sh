#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# Bullish Phase E5 microtest — trigger-simulation + partial-close + salvage (2026-05-23)
#
# Simulates the Item 1 close-both-on-trigger flow at micro size:
#
#   PHASE 1: Open 4-leg spread (same as E3 OPEN)
#   PHASE 2: Simulate trigger — close BOTH wings' SHORT legs (partial close)
#            Retain BOTH LONG legs for Atticus salvage
#   PHASE 3: Salvage decision window (configurable hold time, default 60s)
#   PHASE 4: Sell the retained LONG legs (salvage execution)
#   PHASE 5: Verify zero residual via /volume-cover/admin/bullish-option-positions
#   PHASE 6: Round-trip accounting
#
# What this validates that E3/E4 do not:
#   - Partial-close ordering is correct (close-shorts-first preserves
#     spread invariant: as we close call_short, the long_call keeps it
#     covered; same for the put side)
#   - Salvage path: long legs sold separately after a delay (simulates
#     waiting for spot bounce)
#   - Total round-trip accounting captures both the partial-close
#     proceeds AND the salvage proceeds
#
# PREREQUISITES
#   1. E3 passed (4-leg open/close atomicity validated at 0.01 BTC)
#   2. SHADOW_API + SHADOW_ADMIN_TOKEN set
#   3. Bullish USDC ≥ $30
#
# USAGE
#   export SHADOW_API="https://foxify-pilot-shadow-3r1m.onrender.com"
#   export SHADOW_ADMIN_TOKEN="<your shadow admin token>"
#   bash services/api/scripts/probes/bullish_spread_e5_trigger_salvage_microtest.sh
#
# To simulate a DOWN (low) trigger instead of UP (high, default):
#   TRIGGER_DIRECTION=low bash ...
#
# To skip the salvage hold and sell immediately:
#   SALVAGE_HOLD_SEC=0 bash ...
#
# ----------------------------------------------------------------------------

set -uo pipefail

SHADOW_API="${SHADOW_API:?Set SHADOW_API to your shadow service base URL}"
SHADOW_ADMIN_TOKEN="${SHADOW_ADMIN_TOKEN:?Set SHADOW_ADMIN_TOKEN}"

EXPIRY="${EXPIRY:-20260526}"
CONTRACTS_BTC="${CONTRACTS_BTC:-0.01}"
TRIGGER_DIRECTION="${TRIGGER_DIRECTION:-high}"  # 'high' or 'low'
SALVAGE_HOLD_SEC="${SALVAGE_HOLD_SEC:-60}"

# Per-leg hard caps (mirror E3's sizing for 0.01 BTC microtest)
BUY_LIMIT_USDC_PER_BTC="${BUY_LIMIT_USDC:-1000}"
SELL_LIMIT_USDC_PER_BTC="${SELL_LIMIT_USDC:-1000}"
MAX_BUY_NOTIONAL_USDC="${MAX_PREMIUM_USDC:-15}"    # 0.01 BTC × $1000 = $10 + buffer
MAX_SELL_NOTIONAL_USDC="${MAX_NOTIONAL_SELL_USDC:-30}"

LONG_PUT_SYM="${LONG_PUT_SYM:-BTC-USDC-${EXPIRY}-75000-P}"
SHORT_PUT_SYM="${SHORT_PUT_SYM:-BTC-USDC-${EXPIRY}-74000-P}"
LONG_CALL_SYM="${LONG_CALL_SYM:-BTC-USDC-${EXPIRY}-77000-C}"
SHORT_CALL_SYM="${SHORT_CALL_SYM:-BTC-USDC-${EXPIRY}-78000-C}"

red() { printf "\033[31m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }
cyan() { printf "\033[36m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }
bar() { printf "%s\n" "----------------------------------------------------------------"; }

# Submit one IOC limit order via the existing admin proxy. Mirrors the
# E3 script's open_leg helper: posts to /admin/bullish-test-buy or
# /admin/bullish-test-sell with body { symbol, limitPriceUsdcPerBtc,
# contractsBtc, (maxPremiumUsdc|maxNotionalUsdc) }.
submit_ioc() {
  local SYM=$1
  local SIDE=$2     # BUY or SELL
  local PRICE=$3    # limitPriceUsdcPerBtc
  local QTY=$4      # contractsBtc
  local CAP=$5      # USDC cap
  local LBL=$6
  cyan "▶ $LBL ($SIDE $QTY $SYM @ \$$PRICE IOC, cap \$$CAP)"
  local ENDPOINT CAPKEY
  if [ "$SIDE" = "BUY" ]; then
    ENDPOINT="/volume-cover/admin/bullish-test-buy"
    CAPKEY="maxPremiumUsdc"
  else
    ENDPOINT="/volume-cover/admin/bullish-test-sell"
    CAPKEY="maxNotionalUsdc"
  fi
  local BODY
  BODY=$(jq -nc \
    --arg sym "$SYM" \
    --argjson px "$PRICE" \
    --argjson qty "$QTY" \
    --argjson cap "$CAP" \
    --arg capkey "$CAPKEY" \
    '{symbol:$sym, limitPriceUsdcPerBtc:$px, contractsBtc:$qty} + {($capkey): $cap}')
  local RESP
  RESP=$(curl -sS -X POST "$SHADOW_API$ENDPOINT" \
    -H "X-Admin-Token: $SHADOW_ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$BODY")
  echo "$RESP" | jq '{ok, elapsedMs, result:(.result | {orderId, finalStatus, finalFillPrice, finalFillQty, finalReason, bullishError})}' 2>/dev/null || echo "$RESP"
  local OK FINAL_REASON QTY_FILLED
  OK=$(echo "$RESP" | jq -r '.ok // false')
  FINAL_REASON=$(echo "$RESP" | jq -r '.result.finalReason // "null"')
  QTY_FILLED=$(echo "$RESP" | jq -r '.result.finalFillQty // 0')
  local EXECUTED=0
  if [ "$FINAL_REASON" = "Executed" ] && [ "$(awk -v q="$QTY_FILLED" 'BEGIN{print (q>0)?1:0}')" = "1" ]; then
    EXECUTED=1
  fi
  if [ "$OK" != "true" ] && [ "$EXECUTED" != "1" ]; then
    red "✗ $LBL FAILED  finalReason=$FINAL_REASON  bullishError=$(echo "$RESP" | jq -r '.result.bullishError // "null"')"
    return 1
  fi
  green "✓ $LBL fill=$QTY_FILLED @ \$$(echo "$RESP" | jq -r '.result.finalFillPrice')"
  echo "$RESP" >> /tmp/vc-e5-fills.jsonl
  return 0
}

usdc_balance() {
  curl -sS "$SHADOW_API/volume-cover/admin/bullish-asset-balances" \
    -H "X-Admin-Token: $SHADOW_ADMIN_TOKEN" \
    | jq -r '.balances[] | select(.asset == "USDC") | .available'
}

rm -f /tmp/vc-e5-fills.jsonl
> /tmp/vc-e5-fills.jsonl

bar
cyan "▶ Phase 0: pre-flight"
bar
echo "Shadow API:      $SHADOW_API"
echo "Spread (micro size $CONTRACTS_BTC BTC per leg):"
echo "  LONG  put:     $LONG_PUT_SYM"
echo "  SHORT put:     $SHORT_PUT_SYM"
echo "  LONG  call:    $LONG_CALL_SYM"
echo "  SHORT call:    $SHORT_CALL_SYM"
echo "Trigger direction (simulated): $TRIGGER_DIRECTION"
echo "Salvage hold:    ${SALVAGE_HOLD_SEC}s"
bar

USDC_PRE=$(usdc_balance)
echo "Pre-test USDC: \$$USDC_PRE"

bar
cyan "▶ Phase 1: OPEN spread (4 legs sequenced — put pair, then call pair)"
bar
submit_ioc "$LONG_PUT_SYM"  "BUY"  "$BUY_LIMIT_USDC_PER_BTC"  "$CONTRACTS_BTC" "$MAX_BUY_NOTIONAL_USDC"  "LP open (BUY long-put)"  || exit 1
submit_ioc "$SHORT_PUT_SYM" "SELL" "$SELL_LIMIT_USDC_PER_BTC" "$CONTRACTS_BTC" "$MAX_SELL_NOTIONAL_USDC" "SP open (SELL short-put)" || exit 1
submit_ioc "$LONG_CALL_SYM" "BUY"  "$BUY_LIMIT_USDC_PER_BTC"  "$CONTRACTS_BTC" "$MAX_BUY_NOTIONAL_USDC"  "LC open (BUY long-call)" || exit 1
submit_ioc "$SHORT_CALL_SYM" "SELL" "$SELL_LIMIT_USDC_PER_BTC" "$CONTRACTS_BTC" "$MAX_SELL_NOTIONAL_USDC" "SC open (SELL short-call)" || exit 1
green "✓ Spread open complete"

USDC_POST_OPEN=$(usdc_balance)
echo "Post-open USDC: \$$USDC_POST_OPEN"

bar
cyan "▶ Phase 2: TRIGGER SIMULATION — close BOTH shorts (Item 1 partial close)"
cyan "  Winning wing first, then losing wing. Retain BOTH long legs for salvage."
bar
if [ "$TRIGGER_DIRECTION" = "high" ]; then
  # High trigger: call wing wins. Close SHORT_CALL first (lock proceeds), then SHORT_PUT.
  submit_ioc "$SHORT_CALL_SYM" "BUY" "$BUY_LIMIT_USDC_PER_BTC" "$CONTRACTS_BTC" "$MAX_BUY_NOTIONAL_USDC" "SC close (BUY back, winning wing)" || exit 1
  submit_ioc "$SHORT_PUT_SYM"  "BUY" "$BUY_LIMIT_USDC_PER_BTC" "$CONTRACTS_BTC" "$MAX_BUY_NOTIONAL_USDC" "SP close (BUY back, losing wing)" || exit 1
else
  # Low trigger: put wing wins. Close SHORT_PUT first, then SHORT_CALL.
  submit_ioc "$SHORT_PUT_SYM"  "BUY" "$BUY_LIMIT_USDC_PER_BTC" "$CONTRACTS_BTC" "$MAX_BUY_NOTIONAL_USDC" "SP close (BUY back, winning wing)" || exit 1
  submit_ioc "$SHORT_CALL_SYM" "BUY" "$BUY_LIMIT_USDC_PER_BTC" "$CONTRACTS_BTC" "$MAX_BUY_NOTIONAL_USDC" "SC close (BUY back, losing wing)" || exit 1
fi
green "✓ Both shorts closed. Long legs RETAINED in Atticus's pocket for salvage."

USDC_POST_PARTIAL=$(usdc_balance)
echo "Post-partial-close USDC: \$$USDC_POST_PARTIAL"

if [ "$SALVAGE_HOLD_SEC" -gt 0 ]; then
  bar
  yellow "▶ Phase 3: salvage hold (${SALVAGE_HOLD_SEC}s — simulates waiting for spot bounce)"
  bar
  for i in $(seq 1 "$SALVAGE_HOLD_SEC"); do
    printf "."
    sleep 1
  done
  echo ""
fi

bar
cyan "▶ Phase 4: SALVAGE — sell the retained LONG legs"
bar
submit_ioc "$LONG_CALL_SYM" "SELL" "$SELL_LIMIT_USDC_PER_BTC" "$CONTRACTS_BTC" "$MAX_SELL_NOTIONAL_USDC" "LC salvage (SELL retained)" || exit 1
submit_ioc "$LONG_PUT_SYM"  "SELL" "$SELL_LIMIT_USDC_PER_BTC" "$CONTRACTS_BTC" "$MAX_SELL_NOTIONAL_USDC" "LP salvage (SELL retained)" || exit 1
green "✓ Salvage complete"

USDC_POST_ALL=$(usdc_balance)
echo "Post-all USDC: \$$USDC_POST_ALL"

bar
cyan "▶ Phase 5: residual position verification (definitive)"
bar
RESIDUAL=$(curl -sS "$SHADOW_API/volume-cover/admin/bullish-option-positions" \
  -H "X-Admin-Token: $SHADOW_ADMIN_TOKEN")
echo "$RESIDUAL" | jq '.totals, (.positions | map({symbol, side, netQty}))'
COUNT=$(echo "$RESIDUAL" | jq -r '.totals.optionPositionsCount // 0')
if [ "$COUNT" -ne 0 ]; then
  red "✗ Residual positions detected (count=$COUNT) — investigate via /admin/bullish-option-positions"
  exit 5
fi
green "✓ Zero residual option positions — clean exit"

bar
cyan "▶ Phase 6: round-trip accounting"
bar
DELTA=$(echo "$USDC_POST_ALL - $USDC_PRE" | bc -l)
echo "USDC pre → post: \$$USDC_PRE → \$$USDC_POST_ALL  (Δ \$$DELTA)"
echo ""
echo "Trigger-simulation flow:"
echo "  Open  (BUY longs - SELL shorts):  net debit"
echo "  Partial close (BUY back shorts):  pure cost"
echo "  Salvage (SELL longs):             pure proceeds"
echo ""
echo "  Net = (long_proceeds + short_open_proceeds) - (long_open_cost + short_close_cost)"
echo "      = USDC delta above"

green "✓ Phase E5 trigger-simulation + partial-close + salvage microtest COMPLETE"
echo "  Validated: Item 1 close-both-shorts ordering, retained-long salvage path,"
echo "             residual-position verification endpoint, end-to-end accounting."
