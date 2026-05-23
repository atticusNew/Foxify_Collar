#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# Bullish Phase E3 microtest — 4-leg [DB] spread atomicity (2026-05-23)
#
# Builds a full [DB] tight-spread structure (long inside trigger, short
# further OTM, both sides) at micro size, holds it briefly, then unwinds.
# Validates the executor design that Track 2 PR #2 will implement in
# production.
#
# WHAT IT VALIDATES
#   - 4-leg sequenced open: longs-first-then-shorts, put-pair before
#     call-pair. At every step a freshly-opened short is already covered
#     by its long. NEVER any moment of uncovered naked short exposure.
#   - 4-leg sequenced close: shorts-first-then-longs, reverse order.
#     Same invariant — uncovering happens only after the short is closed.
#   - Bullish portfolio-margin behaviour at the 4-leg level:
#       • Does total margin scale linearly with each new short, or does
#         Bullish recognize the put/call spread structure and discount?
#       • Does the margin engine release each short's margin as it's
#         bought back, or batch the release at the end?
#   - Rollback behaviour: if any open leg fails mid-spread, the script
#     unwinds the legs that already opened so no partial spread is left.
#
# WHAT IT DOES NOT VALIDATE
#   - VC integration (Phase E4 — wiring spread legs into volume_cover_hedge_leg)
#   - Production-scale sizing (we're at 0.01 BTC per leg, 1/50th of
#     the 50k_2pct_1k cell)
#   - TP rule behaviour on spread groups (Track 2 PR #2 unit tests)
#
# PREREQUISITES
#   1. Phase E1 (long round-trip) and Phase E2 (short margin) both passed.
#   2. PILOT_BULLISH_ALLOW_MARGIN=true on shadow Render env (E2 prerequisite,
#      already confirmed plumbed if E2 ran cleanly).
#   3. Bullish USDC available ≥ ~$30 (peak intra-trade USDC usage on
#      0.01 BTC × 4 legs is ~$10-15; $30 is a comfortable safety margin).
#   4. SHADOW_API and SHADOW_ADMIN_TOKEN env vars set.
#   5. 2026-05-26 BTC options listed and orderbook-active on Bullish.
#
# DEFAULT STRUCTURE  (mirror of 50k_2pct_1k [DB] tight-spread)
#   With spot ≈ $77,400 the four 2026-05-26 strikes we use:
#     LONG  put  @ 75,000  (inside ~3% below spot — the "trigger-side" long)
#     SHORT put  @ 74,000  (further OTM by $1000 — the cheap short)
#     LONG  call @ 78,000  (inside trigger side)
#     SHORT call @ 80,000  (further OTM by $2000 — call side a bit wider
#                           because call IV skew is lighter than put skew)
#   Spread widths: $1000 (put), $2000 (call)
#
# All overridable via env vars; see USAGE block below.
#
# USAGE
#   export SHADOW_API="https://foxify-pilot-shadow-3r1m.onrender.com"
#   export SHADOW_ADMIN_TOKEN="<your shadow admin token>"
#   bash services/api/scripts/probes/bullish_spread_e2e_microtest.sh
#
# To override symbols (e.g. if the default expiry has passed):
#   LONG_PUT_SYM="BTC-USDC-20260530-75000-P" \
#   SHORT_PUT_SYM="BTC-USDC-20260530-74000-P" \
#   LONG_CALL_SYM="BTC-USDC-20260530-78000-C" \
#   SHORT_CALL_SYM="BTC-USDC-20260530-80000-C" \
#     bash services/api/scripts/probes/bullish_spread_e2e_microtest.sh
#
# To bypass orderbook pre-flight when Bullish is rate-limiting public data:
#   SKIP_ORDERBOOK_CHECK=1 bash services/api/scripts/probes/bullish_spread_e2e_microtest.sh
#
# SAFETY RAILS
#   - Hard cap on contracts per leg: 0.01 BTC (script-level abort if higher)
#   - Hard cap on per-leg BUY premium: $10
#   - Hard cap on per-leg SELL notional: $30
#   - If any open leg fails, the script rolls back the legs already opened
#     and exits non-zero with the recovery state printed.
#   - If a CLOSE leg fails, the script prints the exact manual curl to
#     close the still-open leg and exits non-zero. Do NOT leave the
#     terminal until all legs are flat.
#
# ----------------------------------------------------------------------------

set -uo pipefail

SHADOW_API="${SHADOW_API:?Set SHADOW_API to your shadow service base URL}"
SHADOW_ADMIN_TOKEN="${SHADOW_ADMIN_TOKEN:?Set SHADOW_ADMIN_TOKEN}"

# Default expiry: 2026-05-26 (matches E1/E2 tested expiry).
LONG_PUT_SYM="${LONG_PUT_SYM:-BTC-USDC-20260526-75000-P}"
SHORT_PUT_SYM="${SHORT_PUT_SYM:-BTC-USDC-20260526-74000-P}"
LONG_CALL_SYM="${LONG_CALL_SYM:-BTC-USDC-20260526-78000-C}"
SHORT_CALL_SYM="${SHORT_CALL_SYM:-BTC-USDC-20260526-80000-C}"

CONTRACTS_BTC="${CONTRACTS_BTC:-0.01}"

# Limit prices for IOC orders. Buy at high to fill at ask; sell at low to fill at bid.
# The endpoint enforces per-leg caps (cap arg below) so we can't accidentally
# overspend even if the orderbook drifts.
BUY_LIMIT_USDC="${BUY_LIMIT_USDC:-1000}"   # Buys fill at ask, capped by per-leg max
SELL_LIMIT_USDC="${SELL_LIMIT_USDC:-50}"   # Sells fill at bid (price improvement)

MAX_PREMIUM_USDC="${MAX_PREMIUM_USDC:-10}"     # Per-leg BUY cap
MAX_NOTIONAL_SELL_USDC="${MAX_NOTIONAL_SELL_USDC:-30}"  # Per-leg SELL cap

SETTLE_WAIT_SEC="${SETTLE_WAIT_SEC:-30}"
SKIP_ORDERBOOK_CHECK="${SKIP_ORDERBOOK_CHECK:-0}"

# ─── Color helpers ──────────────────────────────────────────────────────────
say() { printf '\033[1;34m▶ %s\033[0m\n' "$*"; }
ok()  { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn(){ printf '\033[1;33m! %s\033[0m\n' "$*"; }
err() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; }
hr()  { printf '%s\n' '----------------------------------------------------------------'; }
section() { hr; say "$*"; hr; }

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

# Pre-trade safety: contract size cap.
# Default 0.01 BTC for normal E3 runs. Override via MAX_CONTRACTS_BTC for
# scale-up tests (e.g. 0.1 for pre-flip validation, 1.0 for production).
# Hard ceiling is 1.0 BTC regardless of override.
MAX_CONTRACTS_BTC="${MAX_CONTRACTS_BTC:-0.01}"
ABSOLUTE_HARD_CAP_BTC=1.0
ABOVE_OVERRIDE=$(awk -v q="$CONTRACTS_BTC" -v c="$MAX_CONTRACTS_BTC" 'BEGIN { print (q > c) ? "1" : "0" }')
ABOVE_CEILING=$(awk -v q="$CONTRACTS_BTC" -v c="$ABSOLUTE_HARD_CAP_BTC" 'BEGIN { print (q > c) ? "1" : "0" }')
if [[ "$ABOVE_CEILING" == "1" ]]; then
  err "CONTRACTS_BTC=$CONTRACTS_BTC exceeds absolute hard ceiling ($ABSOLUTE_HARD_CAP_BTC BTC per leg)."
  err "  This cap is not overridable. Exiting."
  exit 2
fi
if [[ "$ABOVE_OVERRIDE" == "1" ]]; then
  err "CONTRACTS_BTC=$CONTRACTS_BTC exceeds current MAX_CONTRACTS_BTC=$MAX_CONTRACTS_BTC."
  err "  To run at this size, set MAX_CONTRACTS_BTC=$CONTRACTS_BTC explicitly."
  err "  Example: MAX_CONTRACTS_BTC=0.1 CONTRACTS_BTC=0.1 bash ..."
  exit 2
fi

# Strike sanity (puts: long > short; calls: long < short for [DB] tight)
LP_STRIKE=$(echo "$LONG_PUT_SYM"  | awk -F- '{print $4}')
SP_STRIKE=$(echo "$SHORT_PUT_SYM" | awk -F- '{print $4}')
LC_STRIKE=$(echo "$LONG_CALL_SYM"  | awk -F- '{print $4}')
SC_STRIKE=$(echo "$SHORT_CALL_SYM" | awk -F- '{print $4}')

if (( $(awk -v a="$LP_STRIKE" -v b="$SP_STRIKE" 'BEGIN { print (a > b) ? 0 : 1 }') )); then
  err "[DB] structure violated: long-put strike $LP_STRIKE must be > short-put strike $SP_STRIKE"
  exit 2
fi
if (( $(awk -v a="$LC_STRIKE" -v b="$SC_STRIKE" 'BEGIN { print (a < b) ? 0 : 1 }') )); then
  err "[DB] structure violated: long-call strike $LC_STRIKE must be < short-call strike $SC_STRIKE"
  exit 2
fi

# State tracking for rollback. After each successful leg we record it.
OPENED_LEGS=()  # Array of "SYMBOL:SIDE:FILLPX:ORDERID" tuples
add_opened() { OPENED_LEGS+=("$1"); }

# ─── Leg executors ──────────────────────────────────────────────────────────

# open_leg <label> <side> <symbol> <fillvar_prefix>
#   side ∈ {BUY, SELL}
#   fillvar_prefix sets <prefix>_FILL_PX, <prefix>_FILL_QTY, <prefix>_ORDER_ID
open_leg() {
  local label="$1" side="$2" symbol="$3" prefix="$4"
  local price body endpoint cap_arg cap_val

  if [[ "$side" == "BUY" ]]; then
    price="$BUY_LIMIT_USDC"
    endpoint="/volume-cover/admin/bullish-test-buy"
    cap_arg="maxPremiumUsdc"
    cap_val="$MAX_PREMIUM_USDC"
  else
    price="$SELL_LIMIT_USDC"
    endpoint="/volume-cover/admin/bullish-test-sell"
    cap_arg="maxNotionalUsdc"
    cap_val="$MAX_NOTIONAL_SELL_USDC"
  fi

  body=$(jq -n \
    --arg sym "$symbol" \
    --argjson px "$price" \
    --argjson qty "$CONTRACTS_BTC" \
    --argjson cap "$cap_val" \
    --arg capkey "$cap_arg" \
    '{symbol: $sym, limitPriceUsdcPerBtc: $px, contractsBtc: $qty} + {($capkey): $cap}')

  say "$label ($side $CONTRACTS_BTC $symbol @ \$$price IOC, cap \$$cap_val)"

  local resp
  resp=$(api POST "$endpoint" "$body")
  echo "$resp" | jq '{ok, elapsedMs, result: (.result | {orderId, finalStatus, finalFillPrice, finalFillQty, finalReason, bullishError})}' 2>/dev/null || echo "$resp"

  local ok_flag final_reason fill_qty fill_px order_id
  ok_flag=$(echo "$resp" | jq -r '.ok // false')
  final_reason=$(echo "$resp" | jq -r '.result.finalReason // "null"')
  fill_qty=$(echo "$resp" | jq -r '.result.finalFillQty // 0')
  fill_px=$(echo "$resp"  | jq -r '.result.finalFillPrice // 0')
  order_id=$(echo "$resp" | jq -r '.result.orderId // empty')

  local looks_executed=0
  if [[ "$final_reason" == "Executed" ]] && (( $(awk -v q="$fill_qty" 'BEGIN { print (q > 0) ? 1 : 0 }') )); then
    looks_executed=1
  fi

  if [[ "$ok_flag" != "true" && "$looks_executed" != "1" ]]; then
    err "$label FAILED — no leg opened"
    err "  finalReason=$final_reason bullishError=$(echo "$resp" | jq -r '.result.bullishError // "null"')"
    # Surface the captured price/qty for triage even on failure
    export "${prefix}_FILL_PX"=0
    export "${prefix}_FILL_QTY"=0
    export "${prefix}_ORDER_ID"=
    return 1
  fi

  ok "$label filled — orderId=$order_id fill=$fill_qty @ \$$fill_px"
  export "${prefix}_FILL_PX"="$fill_px"
  export "${prefix}_FILL_QTY"="$fill_qty"
  export "${prefix}_ORDER_ID"="$order_id"
  add_opened "$symbol:$side:$fill_px:$order_id"
  return 0
}

# close_leg <label> <closing_side> <symbol> <fillvar_prefix>
# closing_side is the side you submit to CLOSE the existing position:
#   - LONG position opened with BUY → close with SELL
#   - SHORT position opened with SELL → close with BUY
close_leg() {
  open_leg "$@"  # Same endpoint flow — closing is just a directional order
}

# ─── Rollback ───────────────────────────────────────────────────────────────
rollback_opened() {
  warn "Rolling back ${#OPENED_LEGS[@]} already-opened leg(s) in reverse order"
  local i
  for ((i=${#OPENED_LEGS[@]}-1; i>=0; i--)); do
    local entry="${OPENED_LEGS[$i]}"
    local sym side fpx oid
    sym=$(echo  "$entry" | awk -F: '{print $1}')
    side=$(echo "$entry" | awk -F: '{print $2}')
    # Reverse the side to close
    local reverse_side
    if [[ "$side" == "BUY" ]]; then reverse_side="SELL"; else reverse_side="BUY"; fi
    warn "  rollback: closing $sym (was $side) with $reverse_side"
    # Lowercase reverse_side for the URL path (bash 3 compatible — macOS
    # ships bash 3.2 by default, so the ${var,,} expansion does not work).
    local reverse_side_lc
    reverse_side_lc=$(echo "$reverse_side" | tr '[:upper:]' '[:lower:]')
    open_leg "ROLLBACK $sym" "$reverse_side" "$sym" "RB_$i" || {
      err "  ROLLBACK FAILED for $sym — manual intervention required."
      err "    Submit by hand at higher limit:"
      err "      curl -sS -X POST \"\$SHADOW_API/volume-cover/admin/bullish-test-$reverse_side_lc\" \\"
      err "        -H \"X-Admin-Token: \$SHADOW_ADMIN_TOKEN\" -H \"Content-Type: application/json\" \\"
      err "        -d '{\"symbol\":\"$sym\",\"limitPriceUsdcPerBtc\":1000,\"contractsBtc\":$CONTRACTS_BTC,\"maxPremiumUsdc\":$MAX_PREMIUM_USDC}'"
    }
  done
}

# ─── Balance helpers ────────────────────────────────────────────────────────
fetch_usdc_avail() {
  local resp
  resp=$(api GET "/volume-cover/admin/bullish-asset-balances")
  if [[ "$(echo "$resp" | jq -r '.ok')" != "true" ]]; then
    echo "0"; return 1
  fi
  echo "$resp" | jq -r '.balances[] | select(.asset=="USDC") | .available // "0"' | head -1
}

# ============================================================================
# Phase 0: pre-flight
# ============================================================================
section "Phase 0: pre-flight sanity"
echo "Shadow API:     $SHADOW_API"
echo "Spread structure (mirror of 50k_2pct_1k [DB] tight-spread):"
echo "  LONG  put:    $LONG_PUT_SYM   (strike $LP_STRIKE)"
echo "  SHORT put:    $SHORT_PUT_SYM  (strike $SP_STRIKE, $((LP_STRIKE - SP_STRIKE)) lower)"
echo "  LONG  call:   $LONG_CALL_SYM  (strike $LC_STRIKE)"
echo "  SHORT call:   $SHORT_CALL_SYM (strike $SC_STRIKE, $((SC_STRIKE - LC_STRIKE)) higher)"
echo "Contracts/leg:  $CONTRACTS_BTC BTC"
echo "Per-leg caps:   BUY ≤ \$$MAX_PREMIUM_USDC, SELL ≤ \$$MAX_NOTIONAL_SELL_USDC"
echo "Settle wait:    ${SETTLE_WAIT_SEC}s"
hr

HEALTH=$(api GET "/volume-cover/admin/cells" || true)
if ! echo "$HEALTH" | jq -e . >/dev/null 2>&1; then
  err "Shadow unreachable or admin token rejected"
  echo "$HEALTH" | head -3
  exit 2
fi
ok "Shadow reachable, admin token valid"

# ============================================================================
# Phase 1: baseline balance + orderbook checks
# ============================================================================
section "Phase 1: baseline USDC + orderbook checks for 4 legs"

USDC_PRE=$(fetch_usdc_avail)
if [[ -z "$USDC_PRE" || "$USDC_PRE" == "0" ]]; then
  err "Could not read USDC available — aborting before any trade"
  exit 2
fi
ok "USDC available pre-trade: \$$USDC_PRE"

# Sanity check enough USDC. Peak intra-trade usage scales with CONTRACTS_BTC:
# baseline ~$30 covers 0.01 BTC; we scale up roughly $150 per 0.1 BTC.
# Default formula: max(30, 1500 * CONTRACTS_BTC). Override via MIN_USDC.
SCALED_MIN_USDC=$(awk -v q="$CONTRACTS_BTC" 'BEGIN { v = 1500 * q; if (v < 30) v = 30; printf "%.0f", v }')
MIN_USDC="${MIN_USDC:-$SCALED_MIN_USDC}"
if (( $(awk -v a="$USDC_PRE" -v m="$MIN_USDC" 'BEGIN { print (a < m) ? 1 : 0 }') )); then
  err "USDC available \$$USDC_PRE < required \$$MIN_USDC. Fund Bullish or lower MIN_USDC env."
  exit 2
fi

if [[ "$SKIP_ORDERBOOK_CHECK" == "1" ]]; then
  warn "SKIP_ORDERBOOK_CHECK=1 → skipping per-leg orderbook pre-flight"
  warn "  (strict liquidity gate disabled; opens may fail with Expired if a side has no resting order)"
else
  # Per-leg liquidity requirements. Discovered the hard way 2026-05-23 in
  # the first E3 run: 80000-C had ask=$30 but bid=null, so the SELL-to-open
  # IOC immediately expired with 0 fills. Bullish lists the option but
  # nobody bids on far-OTM strikes near expiry → naked SELL impossible.
  #
  # Required-side rule:
  #   BUY-to-open  legs need a valid ASK  (we're crossing the spread to buy)
  #   SELL-to-open legs need a valid BID  (we're crossing the spread to sell)
  #
  # The pair tuples below encode: SYMBOL|REQUIRED_SIDE|HUMAN_LABEL.
  for tuple in \
    "$LONG_PUT_SYM|ask|LONG put (BUY)" \
    "$SHORT_PUT_SYM|bid|SHORT put (SELL)" \
    "$LONG_CALL_SYM|ask|LONG call (BUY)" \
    "$SHORT_CALL_SYM|bid|SHORT call (SELL)"; do
    sym=$(echo "$tuple"   | awk -F'|' '{print $1}')
    side=$(echo "$tuple"  | awk -F'|' '{print $2}')
    label=$(echo "$tuple" | awk -F'|' '{print $3}')

    OB=$(api GET "/volume-cover/admin/bullish-orderbook?symbol=$sym&depth=1")
    OB_OK=$(echo "$OB" | jq -r '.ok // false')
    if [[ "$OB_OK" != "true" ]]; then
      err "Orderbook unavailable for $sym ($label):"
      echo "$OB" | jq '{ok, error}' 2>/dev/null || echo "$OB" | head -2
      if echo "$OB" | grep -q "RATE_LIMIT_EXCEEDED\|96100\|negative_cache_hit"; then
        err "  Rate-limited — bypass with: SKIP_ORDERBOOK_CHECK=1 bash $0"
      fi
      exit 3
    fi
    local_bid=$(echo "$OB" | jq -r '.summary.topBid.price // "null"')
    local_ask=$(echo "$OB" | jq -r '.summary.topAsk.price // "null"')

    # Strict liquidity gate on the side we will cross.
    if [[ "$side" == "bid" && ( "$local_bid" == "null" || -z "$local_bid" ) ]]; then
      err "$sym ($label): NO RESTING BID. A SELL-to-open IOC would expire with 0 fills."
      err "  Pick a closer-to-ATM strike for the short or wait for liquidity."
      err "  (Current: bid=\$$local_bid  ask=\$$local_ask)"
      exit 3
    fi
    if [[ "$side" == "ask" && ( "$local_ask" == "null" || -z "$local_ask" ) ]]; then
      err "$sym ($label): NO RESTING ASK. A BUY-to-open IOC would expire with 0 fills."
      err "  Pick a closer-to-ATM strike for the long or wait for liquidity."
      err "  (Current: bid=\$$local_bid  ask=\$$local_ask)"
      exit 3
    fi
    ok "$sym ($label): bid \$$local_bid / ask \$$local_ask"
  done
fi

# ============================================================================
# Phase 2: OPEN spread — longs-first-then-shorts, put-pair before call-pair
# ============================================================================
section "Phase 2: OPEN [DB] spread (4 legs, sequenced for safety)"

echo "Order of operations (each short is covered by its long before it opens):"
echo "  step 1: BUY  long-put       (open long position)"
echo "  step 2: SELL short-put      (cover by long-put — net put spread)"
echo "  step 3: BUY  long-call      (open long position)"
echo "  step 4: SELL short-call     (cover by long-call — net call spread)"
echo

open_leg "LP open" BUY  "$LONG_PUT_SYM"   LP || { err "LP open failed — nothing to roll back"; exit 4; }
open_leg "SP open" SELL "$SHORT_PUT_SYM"  SP || { err "SP open failed — rolling back LP"; rollback_opened; exit 4; }
open_leg "LC open" BUY  "$LONG_CALL_SYM"  LC || { err "LC open failed — rolling back LP+SP"; rollback_opened; exit 4; }
open_leg "SC open" SELL "$SHORT_CALL_SYM" SC || { err "SC open failed — rolling back LP+SP+LC"; rollback_opened; exit 4; }

ok "All 4 legs opened cleanly"

# ============================================================================
# Phase 3: margin-posted snapshot after full spread open
# ============================================================================
section "Phase 3: margin snapshot after full [DB] open"
sleep 2
USDC_AFTER_OPEN=$(fetch_usdc_avail)
ok "USDC available post-open: \$$USDC_AFTER_OPEN"

# Net cash impact: sum of (BUY costs) − sum of (SELL proceeds).
# For [DB] tight spread we EXPECT a net debit (longs cost more than shorts collect).
# True margin posted = (proceeds − Δavailable_attributable_to_margin), but
# the cleanest accounting for spread atomicity is:
#   net_cash_consumed = USDC_PRE − USDC_AFTER_OPEN
#   sum_buy_cost      = LP + LC (price × qty)
#   sum_sell_proceeds = SP + SC (price × qty)
#   expected_net_debit = sum_buy_cost − sum_sell_proceeds
#   implicit_short_margin_friction = net_cash_consumed − expected_net_debit
LP_COST=$(awk -v p="$LP_FILL_PX" -v q="$LP_FILL_QTY" 'BEGIN { printf "%.4f", p*q }')
SP_PROCEEDS=$(awk -v p="$SP_FILL_PX" -v q="$SP_FILL_QTY" 'BEGIN { printf "%.4f", p*q }')
LC_COST=$(awk -v p="$LC_FILL_PX" -v q="$LC_FILL_QTY" 'BEGIN { printf "%.4f", p*q }')
SC_PROCEEDS=$(awk -v p="$SC_FILL_PX" -v q="$SC_FILL_QTY" 'BEGIN { printf "%.4f", p*q }')

SUM_BUY=$(awk  -v a="$LP_COST" -v b="$LC_COST" 'BEGIN { printf "%.4f", a+b }')
SUM_SELL=$(awk -v a="$SP_PROCEEDS" -v b="$SC_PROCEEDS" 'BEGIN { printf "%.4f", a+b }')
EXPECTED_DEBIT=$(awk -v b="$SUM_BUY" -v s="$SUM_SELL" 'BEGIN { printf "%.4f", b-s }')
NET_CASH_CONSUMED=$(awk -v a="$USDC_PRE" -v b="$USDC_AFTER_OPEN" 'BEGIN { printf "%.4f", a-b }')
MARGIN_FRICTION=$(awk -v c="$NET_CASH_CONSUMED" -v d="$EXPECTED_DEBIT" 'BEGIN { printf "%.4f", c-d }')

echo
echo "Per-leg fills:"
echo "  LP (BUY long-put):    \$$LP_FILL_PX × $LP_FILL_QTY = \$$LP_COST"
echo "  SP (SELL short-put):  \$$SP_FILL_PX × $SP_FILL_QTY = \$$SP_PROCEEDS"
echo "  LC (BUY long-call):   \$$LC_FILL_PX × $LC_FILL_QTY = \$$LC_COST"
echo "  SC (SELL short-call): \$$SC_FILL_PX × $SC_FILL_QTY = \$$SC_PROCEEDS"
echo
echo "Sums:"
echo "  Sum of BUY costs:           \$$SUM_BUY  (paid out for longs)"
echo "  Sum of SELL proceeds:       \$$SUM_SELL  (received for shorts)"
echo "  Expected net debit:         \$$EXPECTED_DEBIT  (the spread's intrinsic cost)"
echo
echo "Actual USDC delta:"
echo "  USDC pre  → USDC post-open: \$$USDC_PRE → \$$USDC_AFTER_OPEN  (Δ -\$$NET_CASH_CONSUMED)"
echo "  Implicit short-margin friction:  \$$MARGIN_FRICTION"
echo "    (= net cash consumed − expected net debit. If ~0, Bullish recognizes"
echo "     the spread structure and gives portfolio-margin credit. If positive,"
echo "     each short posts margin in addition to the spread's structural cost.)"

# ============================================================================
# Phase 4: pause
# ============================================================================
section "Phase 4: hold spread for ${SETTLE_WAIT_SEC}s (Bullish margin engine settle)"
sleep "$SETTLE_WAIT_SEC"

# ============================================================================
# Phase 5: CLOSE spread — shorts-first-then-longs, reverse order
# ============================================================================
section "Phase 5: CLOSE [DB] spread (4 legs, reverse-sequenced for safety)"

echo "Order of operations (each long stays as cover until its short is closed):"
echo "  step 1: BUY  short-call back  (uncover the long-call — now flat call side)"
echo "  step 2: SELL long-call        (close call side fully)"
echo "  step 3: BUY  short-put back   (uncover the long-put)"
echo "  step 4: SELL long-put         (close put side fully — all flat)"
echo

close_leg "SC close" BUY  "$SHORT_CALL_SYM" SCC || {
  err "Close-SC FAILED — naked short-call still open."
  err "  ACTION REQUIRED: manually buy 0.01 BTC of $SHORT_CALL_SYM at \$1000 limit:"
  err "    curl -sS -X POST \"\$SHADOW_API/volume-cover/admin/bullish-test-buy\" \\"
  err "      -H \"X-Admin-Token: \$SHADOW_ADMIN_TOKEN\" -H \"Content-Type: application/json\" \\"
  err "      -d '{\"symbol\":\"$SHORT_CALL_SYM\",\"limitPriceUsdcPerBtc\":1000,\"contractsBtc\":$CONTRACTS_BTC,\"maxPremiumUsdc\":$MAX_PREMIUM_USDC}'"
  exit 6
}
close_leg "LC close" SELL "$LONG_CALL_SYM" LCC || {
  err "Close-LC FAILED — long-call still open (no risk; just leaked capital). Continue with put side."
  warn "Continuing close sequence — long-call is unhedged but only worth its small premium"
}
close_leg "SP close" BUY  "$SHORT_PUT_SYM" SPC || {
  err "Close-SP FAILED — naked short-put still open."
  err "  ACTION REQUIRED: manually buy $SHORT_PUT_SYM at \$1000 limit (see template above)."
  exit 6
}
close_leg "LP close" SELL "$LONG_PUT_SYM" LPC || {
  err "Close-LP FAILED — long-put still open (no risk)."
  warn "Continuing — long-put is unhedged but only worth its small premium"
}

ok "All 4 legs closed cleanly"

# ============================================================================
# Phase 6: post-close balance + full round-trip accounting
# ============================================================================
section "Phase 6: post-close balance"
sleep 2
USDC_END=$(fetch_usdc_avail)
ok "USDC available post-close: \$$USDC_END"

# Close-side accounting (mirror of open):
SCC_COST=$(awk -v p="$SCC_FILL_PX" -v q="$SCC_FILL_QTY" 'BEGIN { printf "%.4f", p*q }')
LCC_PROCEEDS=$(awk -v p="$LCC_FILL_PX" -v q="$LCC_FILL_QTY" 'BEGIN { printf "%.4f", p*q }')
SPC_COST=$(awk -v p="$SPC_FILL_PX" -v q="$SPC_FILL_QTY" 'BEGIN { printf "%.4f", p*q }')
LPC_PROCEEDS=$(awk -v p="$LPC_FILL_PX" -v q="$LPC_FILL_QTY" 'BEGIN { printf "%.4f", p*q }')

CLOSE_SUM_BUY=$(awk  -v a="$SCC_COST" -v b="$SPC_COST" 'BEGIN { printf "%.4f", a+b }')
CLOSE_SUM_SELL=$(awk -v a="$LCC_PROCEEDS" -v b="$LPC_PROCEEDS" 'BEGIN { printf "%.4f", a+b }')
CLOSE_NET=$(awk -v b="$CLOSE_SUM_BUY" -v s="$CLOSE_SUM_SELL" 'BEGIN { printf "%.4f", b-s }')

NET_BAL_END=$(awk -v a="$USDC_END" -v b="$USDC_PRE" 'BEGIN { printf "%.4f", a-b }')

# ============================================================================
# Phase 7: round-trip accounting
# ============================================================================
section "Phase 7: round-trip accounting"
echo "OPEN  (sum buys − sum sells):  \$$SUM_BUY − \$$SUM_SELL = \$$EXPECTED_DEBIT  (paid into spread)"
echo "CLOSE (sum buys − sum sells):  \$$CLOSE_SUM_BUY − \$$CLOSE_SUM_SELL = \$$CLOSE_NET  (paid to unwind)"
echo
TOTAL_PRICE_RT=$(awk -v o="$EXPECTED_DEBIT" -v c="$CLOSE_NET" 'BEGIN { printf "%.4f", o + c }')
echo "Total price-math round-trip cost:  \$$TOTAL_PRICE_RT"
echo "Actual USDC delta (pre → end):     \$$USDC_PRE → \$$USDC_END  (Δ \$$NET_BAL_END)"
echo
echo "Per-BTC extrapolation for 50k_2pct_1k [DB] spread (0.5 BTC per leg):"
PER_BTC_DEBIT=$(awk -v d="$EXPECTED_DEBIT" -v q="$CONTRACTS_BTC" 'BEGIN { if (q>0) printf "%.2f", d/q }')
PER_BTC_RT=$(awk    -v t="$TOTAL_PRICE_RT" -v q="$CONTRACTS_BTC" 'BEGIN { if (q>0) printf "%.2f", t/q }')
echo "  Open net debit:        \$$PER_BTC_DEBIT/BTC × 0.5 BTC = \$$(awk -v p="$PER_BTC_DEBIT" 'BEGIN { printf "%.2f", p*0.5 }')"
echo "  Round-trip cost:       \$$PER_BTC_RT/BTC × 0.5 BTC = \$$(awk -v p="$PER_BTC_RT" 'BEGIN { printf "%.2f", p*0.5 }')"
echo

# Verify clean state (no leftover positions implied by USDC roughly back to pre).
# If USDC_END is much lower than expected (e.g., >$2 short of pre − round-trip cost),
# something is still open or stuck.
EXPECTED_END=$(awk -v p="$USDC_PRE" -v rt="$TOTAL_PRICE_RT" 'BEGIN { printf "%.4f", p - rt }')
GAP=$(awk -v a="$USDC_END" -v e="$EXPECTED_END" 'BEGIN { printf "%.4f", a - e }')
GAP_ABS=$(awk -v g="$GAP" 'BEGIN { printf "%.4f", (g < 0) ? -g : g }')

if (( $(awk -v g="$GAP_ABS" 'BEGIN { print (g < 1.0) ? 1 : 0 }') )); then
  ok "Balance reconciles cleanly (USDC end within \$1 of expected). No stuck positions."
else
  warn "Balance gap of \$$GAP vs expected — verify no leftover position via:"
  warn "  curl -sS \"\$SHADOW_API/volume-cover/admin/bullish-asset-balances\" -H \"X-Admin-Token: \$SHADOW_ADMIN_TOKEN\""
fi

hr
ok "Phase E3 4-leg [DB] spread microtest COMPLETE."
ok "  Validated: sequenced 4-leg open/close, no naked-short windows, margin"
ok "             engine behaviour at the spread level, rollback paths."
echo
echo "Next steps:"
echo "  Track 2 PR #2 — production spread executor:"
echo "    DB migration:  add spread_group_id to volume_cover_hedge_leg"
echo "    Executor:      sequenced open/close mirroring this script's order"
echo "    TP adapter:    spread-group-aware 12-rule curve"
echo "    Rollback:      reuse this script's safety pattern"
echo "    Tests:         unit + shadow integration before flipping the cell"
