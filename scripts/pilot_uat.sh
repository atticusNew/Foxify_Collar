#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:4100}"
PROOF_TOKEN="${PROOF_TOKEN:-proof-local}"
ADMIN_TOKEN="${ADMIN_TOKEN:-admin-local}"
EXPECT_PRICE_SOURCE="${EXPECT_PRICE_SOURCE:-reference_oracle}"
ENTRY_PRICE="${ENTRY_PRICE:-100000}"
INSTRUMENT_ID="${INSTRUMENT_ID:-BTC-USD-7D-P}"
TIER_NAME="${TIER_NAME:-Pro (Bronze)}"

for tool in curl jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Missing required tool: $tool"
    exit 1
  fi
done

PASS_COUNT=0
FAIL_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  echo "PASS: $1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo "FAIL: $1"
  if [[ -n "${2:-}" ]]; then
    echo "  detail: $2"
  fi
}

post_json() {
  local path="$1"
  local payload="$2"
  shift 2 || true
  curl -sS -X POST "${API_BASE}${path}" \
    -H "Content-Type: application/json" \
    "$@" \
    -d "$payload"
}

get_json() {
  local path="$1"
  shift || true
  curl -sS "${API_BASE}${path}" "$@"
}

quote_payload() {
  local user_id="$1"
  local protected_notional="$2"
  local exposure_notional="$3"
  local entry_price="$4"
  jq -n \
    --arg userId "$user_id" \
    --arg instrumentId "$INSTRUMENT_ID" \
    --arg tierName "$TIER_NAME" \
    --argjson protectedNotional "$protected_notional" \
    --argjson foxifyExposureNotional "$exposure_notional" \
    --argjson entryPrice "$entry_price" \
    '{
      userId: $userId,
      protectedNotional: $protectedNotional,
      foxifyExposureNotional: $foxifyExposureNotional,
      entryPrice: $entryPrice,
      instrumentId: $instrumentId,
      tierName: $tierName
    }'
}

activate_payload() {
  local user_id="$1"
  local protected_notional="$2"
  local exposure_notional="$3"
  local entry_price="$4"
  local quote_id="$5"
  local auto_renew="${6:-false}"
  local expiry_at="${7:-}"

  if [[ -n "$expiry_at" ]]; then
    jq -n \
      --arg userId "$user_id" \
      --arg instrumentId "$INSTRUMENT_ID" \
      --arg tierName "$TIER_NAME" \
      --arg quoteId "$quote_id" \
      --arg expiryAt "$expiry_at" \
      --argjson protectedNotional "$protected_notional" \
      --argjson foxifyExposureNotional "$exposure_notional" \
      --argjson entryPrice "$entry_price" \
      --argjson autoRenew "$auto_renew" \
      '{
        userId: $userId,
        protectedNotional: $protectedNotional,
        foxifyExposureNotional: $foxifyExposureNotional,
        entryPrice: $entryPrice,
        instrumentId: $instrumentId,
        tierName: $tierName,
        autoRenew: $autoRenew,
        quoteId: $quoteId,
        expiryAt: $expiryAt
      }'
  else
    jq -n \
      --arg userId "$user_id" \
      --arg instrumentId "$INSTRUMENT_ID" \
      --arg tierName "$TIER_NAME" \
      --arg quoteId "$quote_id" \
      --argjson protectedNotional "$protected_notional" \
      --argjson foxifyExposureNotional "$exposure_notional" \
      --argjson entryPrice "$entry_price" \
      --argjson autoRenew "$auto_renew" \
      '{
        userId: $userId,
        protectedNotional: $protectedNotional,
        foxifyExposureNotional: $foxifyExposureNotional,
        entryPrice: $entryPrice,
        instrumentId: $instrumentId,
        tierName: $tierName,
        autoRenew: $autoRenew,
        quoteId: $quoteId
      }'
  fi
}

SUFFIX="$(date +%s)"
uid() {
  echo "uat-user-${SUFFIX}-$1"
}

echo "Running pilot UAT against ${API_BASE}"

# 1) Happy-path quote
Q1="$(post_json "/pilot/protections/quote" "$(quote_payload "$(uid 01)" 50000 50000 "$ENTRY_PRICE")")"
Q1_STATUS="$(echo "$Q1" | jq -r '.status // ""')"
Q1_SOURCE="$(echo "$Q1" | jq -r '.entrySnapshot.source // ""')"
Q1_FLOOR="$(echo "$Q1" | jq -r '.floorPrice // ""')"
if [[ "$Q1_STATUS" == "ok" && "$Q1_FLOOR" == "80000.0000000000" ]]; then
  if [[ "$EXPECT_PRICE_SOURCE" == "any" || "$Q1_SOURCE" == "$EXPECT_PRICE_SOURCE" ]]; then
    pass "1 happy-path quote + floor + canonical source"
  else
    fail "1 happy-path quote + floor + canonical source" "source=$Q1_SOURCE expected=$EXPECT_PRICE_SOURCE"
  fi
else
  fail "1 happy-path quote + floor + canonical source" "$Q1"
fi

# 2) Over-cap quote
Q2="$(post_json "/pilot/protections/quote" "$(quote_payload "$(uid 02)" 50001 60000 "$ENTRY_PRICE")")"
Q2_REASON="$(echo "$Q2" | jq -r '.reason // ""')"
[[ "$Q2_REASON" == "protection_notional_cap_exceeded" ]] \
  && pass "2 per-protection 50k cap enforced" \
  || fail "2 per-protection 50k cap enforced" "$Q2"

# 3) Protected > exposure
Q3="$(post_json "/pilot/protections/quote" "$(quote_payload "$(uid 03)" 40000 30000 "$ENTRY_PRICE")")"
Q3_REASON="$(echo "$Q3" | jq -r '.reason // ""')"
[[ "$Q3_REASON" == "protected_notional_exceeds_exposure" ]] \
  && pass "3 protected notional cannot exceed exposure" \
  || fail "3 protected notional cannot exceed exposure" "$Q3"

# 4) Daily cap for same user (quote allowed, activation blocked when cap exceeded)
U4="$(uid 04)"
Q4A="$(post_json "/pilot/protections/quote" "$(quote_payload "$U4" 50000 50000 "$ENTRY_PRICE")")"
Q4A_STATUS="$(echo "$Q4A" | jq -r '.status // ""')"
Q4A_ID="$(echo "$Q4A" | jq -r '.quote.quoteId // ""')"
if [[ "$Q4A_STATUS" == "ok" && -n "$Q4A_ID" ]]; then
  A4A="$(post_json "/pilot/protections/activate" "$(activate_payload "$U4" 50000 50000 "$ENTRY_PRICE" "$Q4A_ID")")"
else
  A4A='{"status":"error","reason":"quote_failed"}'
fi
A4A_STATUS="$(echo "$A4A" | jq -r '.status // ""')"
Q4B="$(post_json "/pilot/protections/quote" "$(quote_payload "$U4" 1 1 "$ENTRY_PRICE")")"
Q4B_STATUS="$(echo "$Q4B" | jq -r '.status // ""')"
Q4B_ID="$(echo "$Q4B" | jq -r '.quote.quoteId // ""')"
if [[ "$Q4B_STATUS" == "ok" && -n "$Q4B_ID" ]]; then
  A4B="$(post_json "/pilot/protections/activate" "$(activate_payload "$U4" 1 1 "$ENTRY_PRICE" "$Q4B_ID")")"
else
  A4B='{"status":"error","reason":"quote_failed"}'
fi
Q4B_ACTIVATE_REASON="$(echo "$A4B" | jq -r '.reason // ""')"
if [[ "$Q4A_STATUS" == "ok" && "$A4A_STATUS" == "ok" && "$Q4B_STATUS" == "ok" && "$Q4B_ACTIVATE_REASON" == "daily_notional_cap_exceeded" ]]; then
  pass "4 daily 50k cap per user hash enforced"
else
  fail "4 daily 50k cap per user hash enforced" "first_quote=$Q4A first_activate=$A4A second_quote=$Q4B second_activate=$A4B"
fi

# 5) Quote + activate happy path
U5="$(uid 05)"
Q5="$(post_json "/pilot/protections/quote" "$(quote_payload "$U5" 50000 50000 "$ENTRY_PRICE")")"
Q5_ID="$(echo "$Q5" | jq -r '.quote.quoteId // ""')"
A5="$(post_json "/pilot/protections/activate" "$(activate_payload "$U5" 50000 50000 "$ENTRY_PRICE" "$Q5_ID")")"
A5_STATUS="$(echo "$A5" | jq -r '.status // ""')"
A5_PROTECTION_STATUS="$(echo "$A5" | jq -r '.protection.status // ""')"
A5_ENTRY_SOURCE="$(echo "$A5" | jq -r '.protection.entryPriceSource // ""')"
PID="$(echo "$A5" | jq -r '.protection.id // ""')"
if [[ "$A5_STATUS" == "ok" && "$A5_PROTECTION_STATUS" == "active" && "$A5_ENTRY_SOURCE" == "manual_input" && -n "$PID" ]]; then
  pass "5 quote-lock activation + manual entry source persisted"
else
  fail "5 quote-lock activation + manual entry source persisted" "$A5"
fi

# 6) Quote mismatch guard
U6="$(uid 06)"
Q6="$(post_json "/pilot/protections/quote" "$(quote_payload "$U6" 50000 50000 "$ENTRY_PRICE")")"
Q6_ID="$(echo "$Q6" | jq -r '.quote.quoteId // ""')"
A6="$(post_json "/pilot/protections/activate" "$(activate_payload "$U6" 50000 50000 100001 "$Q6_ID")")"
A6_REASON="$(echo "$A6" | jq -r '.reason // ""')"
if [[ "$A6_REASON" == quote_mismatch_* ]]; then
  pass "6 quote mismatch guard blocks altered activation params"
else
  fail "6 quote mismatch guard blocks altered activation params" "$A6"
fi

# 7) Proof auth required
P7_NOAUTH="$(get_json "/pilot/protections/${PID}/proof")"
P7_AUTH="$(get_json "/pilot/protections/${PID}/proof" -H "x-proof-token: ${PROOF_TOKEN}")"
P7_NOAUTH_REASON="$(echo "$P7_NOAUTH" | jq -r '.reason // ""')"
P7_AUTH_STATUS="$(echo "$P7_AUTH" | jq -r '.status // ""')"
if [[ "$P7_NOAUTH_REASON" == "unauthorized_proof_access" && "$P7_AUTH_STATUS" == "ok" ]]; then
  pass "7 proof endpoint enforces token auth"
else
  fail "7 proof endpoint enforces token auth" "noauth=$P7_NOAUTH auth=$P7_AUTH"
fi

# 8) Proof payload minimality
if echo "$P7_AUTH" | jq -e '
  (.proof.protection | has("userHash") | not) and
  (.proof.protection | has("premium") | not) and
  (.proof | has("liquidity") | not) and
  (.proof | has("profitability") | not)
' >/dev/null; then
  pass "8 proof payload excludes internal economics/identity fields"
else
  fail "8 proof payload excludes internal economics/identity fields" "$P7_AUTH"
fi

# 9) Admin ledger auth
L9_NOAUTH="$(get_json "/pilot/admin/protections/${PID}/ledger")"
L9_AUTH="$(get_json "/pilot/admin/protections/${PID}/ledger" -H "x-admin-token: ${ADMIN_TOKEN}")"
L9_NOAUTH_REASON="$(echo "$L9_NOAUTH" | jq -r '.reason // ""')"
L9_AUTH_STATUS="$(echo "$L9_AUTH" | jq -r '.status // ""')"
if [[ "$L9_NOAUTH_REASON" == "unauthorized_admin" && "$L9_AUTH_STATUS" == "ok" ]]; then
  pass "9 admin ledger endpoint enforces admin token"
else
  fail "9 admin ledger endpoint enforces admin token" "noauth=$L9_NOAUTH auth=$L9_AUTH"
fi

# 10) Payout settlement above due is blocked
U10="$(uid 10)"
Q10="$(post_json "/pilot/protections/quote" "$(quote_payload "$U10" 50000 50000 "$ENTRY_PRICE")")"
Q10_ID="$(echo "$Q10" | jq -r '.quote.quoteId // ""')"
PAST_EXPIRY="$(date -u -d '2 minutes ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || python3 - <<'PY'
from datetime import datetime, timedelta, timezone
print((datetime.now(timezone.utc)-timedelta(minutes=2)).strftime("%Y-%m-%dT%H:%M:%SZ"))
PY
)"
A10="$(post_json "/pilot/protections/activate" "$(activate_payload "$U10" 50000 50000 "$ENTRY_PRICE" "$Q10_ID" false "$PAST_EXPIRY")")"
PID10="$(echo "$A10" | jq -r '.protection.id // ""')"
if [[ -n "$PID10" ]]; then
  _R10="$(post_json "/pilot/internal/protections/${PID10}/resolve-expiry" '{}' )"
  S10="$(post_json "/pilot/admin/protections/${PID10}/payout-settled" '{"amount":9999999,"payoutTxRef":"uat-over-settle"}' -H "x-admin-token: ${ADMIN_TOKEN}")"
  S10_REASON="$(echo "$S10" | jq -r '.reason // ""')"
  [[ "$S10_REASON" == "payout_settlement_exceeds_due" ]] \
    && pass "10 payout settlement cannot exceed payout due" \
    || fail "10 payout settlement cannot exceed payout due" "$S10"
else
  fail "10 payout settlement cannot exceed payout due" "activation_failed=$A10"
fi

echo
echo "UAT Summary: pass=${PASS_COUNT} fail=${FAIL_COUNT}"
if [[ "$FAIL_COUNT" -gt 0 ]]; then
  exit 1
fi

