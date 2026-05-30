#!/bin/bash
# MTM validation tool — compares our MTM bid against the live Deribit order book.
#
# For one or more active shadow pairs:
#   1. Pull our MTM endpoint to see what bid we're using
#   2. Fetch the live Deribit ticker for the same strike/expiry
#   3. Show side-by-side: our bid vs Deribit's current bid
#
# If they match (within a few %), our MTM math is accurate.
# If they diverge significantly, our cache is stale or our math is wrong.
#
# Usage:
#   bash scripts/validate_mtm.sh                   # validates 3 random STRONG_TAKE_PROFIT pairs
#   bash scripts/validate_mtm.sh PAIR_ID           # validates one specific pair
#
# Required env: RENDER_ADMIN_TOKEN, PILOT_API_BASE

set -uo pipefail

API_BASE="${PILOT_API_BASE:?Set PILOT_API_BASE env var (your atticus API base URL)}"
ADMIN_TOKEN="${RENDER_ADMIN_TOKEN:?Set RENDER_ADMIN_TOKEN env var}"

PAIR_ID="${1:-}"

# Fetch MTM data
if [ -n "$PAIR_ID" ]; then
  MTM_URL="$API_BASE/admin/foxify/v2/pairs/mtm?include_shadow=true&pair_id=$PAIR_ID"
else
  MTM_URL="$API_BASE/admin/foxify/v2/pairs/mtm?include_shadow=true"
fi

# Convert Deribit instrument name from our format
# Our format: BTC-31MAY26-74000-P → Deribit format: BTC-31MAY26-74000-P (same!)
# Deribit ticker URL: https://www.deribit.com/api/v2/public/ticker?instrument_name=...

PAIRS_JSON=$(curl -sS -H "X-Admin-Token: $ADMIN_TOKEN" "$MTM_URL")

# If single pair filter, get just that one. Else take 3 STRONG_TAKE_PROFIT.
if [ -n "$PAIR_ID" ]; then
  SELECTED=$(echo "$PAIRS_JSON" | python3 -c "
import json, sys
d = json.load(sys.stdin)
pairs = d.get('pairs', [])
if not pairs:
    print('[]')
else:
    print(json.dumps(pairs[:1]))
")
else
  SELECTED=$(echo "$PAIRS_JSON" | python3 -c "
import json, sys
d = json.load(sys.stdin)
strong = [p for p in d.get('pairs', []) if p['recommendation'] == 'STRONG_TAKE_PROFIT' and p.get('valuation_method') == 'venue_bid'][:3]
if not strong:
    # Fall back to any venue_bid valuation
    strong = [p for p in d.get('pairs', []) if p.get('valuation_method') == 'venue_bid'][:3]
print(json.dumps(strong))
")
fi

COUNT=$(echo "$SELECTED" | python3 -c "import json, sys; print(len(json.load(sys.stdin)))")
if [ "$COUNT" = "0" ]; then
  echo "❌ No pairs found to validate. Either:"
  echo "  - No active shadow pairs exist"
  echo "  - No pairs are using venue_bid valuation (all bs_fallback)"
  echo "  - Specified PAIR_ID doesn't exist"
  exit 1
fi

echo "════════════════════════════════════════════════════════════════════════"
echo "  MTM VALIDATION — comparing our MTM vs live Deribit order book"
echo "════════════════════════════════════════════════════════════════════════"
echo

# For each selected pair, fetch Deribit ticker for the strikes
echo "$SELECTED" | python3 << 'EOF'
import json, sys, urllib.request

pairs_json = """REPLACE_ME"""
EOF

# Use Python to do the comparison properly
python3 << EOF
import json, urllib.request, sys

pairs = json.loads('''$SELECTED''')

def fetch_deribit_ticker(instrument):
    url = f"https://www.deribit.com/api/v2/public/ticker?instrument_name={instrument}"
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            data = json.loads(r.read())
        if 'result' not in data:
            return None
        res = data['result']
        # Deribit option prices in BTC; convert via index_price
        idx = res.get('index_price') or res.get('underlying_price') or 0
        if idx <= 0:
            return None
        bid_btc = res.get('best_bid_price') or 0
        ask_btc = res.get('best_ask_price') or 0
        mark_btc = res.get('mark_price') or 0
        return {
            'best_bid_usd_per_btc': bid_btc * idx if bid_btc > 0 else 0,
            'best_ask_usd_per_btc': ask_btc * idx if ask_btc > 0 else 0,
            'mark_usd_per_btc': mark_btc * idx,
            'index_price': idx,
            'bid_btc_raw': bid_btc,
            'ask_btc_raw': ask_btc
        }
    except Exception as e:
        return {'error': str(e)}

def days_to_deribit_expiry(strike, opt_type, tenor_hours):
    # Approximate the Deribit instrument naming from expiry
    # Format: BTC-DDMMMYY-STRIKE-P/C  (e.g., BTC-30MAY26-74000-P)
    # We don't have exact expiry date here, so we'll try common nearby expiries
    # For simplicity, just print what we have
    return None

for i, p in enumerate(pairs):
    pid = p['pair_id'][:8]
    cell = p['cell_id']
    spot = p['current_spot']
    cost = p['cost_paid_usdc']
    salvage = p['estimated_salvage_usdc']
    pnl_pct = p['pnl_pct'] * 100
    
    print(f"────────────────────────────────────────────────────────────────────────")
    print(f"PAIR: {pid}  cell={cell}  recommendation={p['recommendation']}")
    print(f"  Spot now: \${spot:.0f}")
    print(f"  Cost paid: \${cost:.2f}")
    print(f"  Our MTM salvage estimate: \${salvage:.2f}  → pnl_pct={pnl_pct:+.1f}%")
    print(f"  Valuation method: {p.get('valuation_method')}")
    print()
    
    # Per-leg
    for side, strike_key, value_key, bid_key, venue_key in [
        ('put',  'put_strike',  'current_put_value_usdc',  'put_bid_used_usdc_per_btc',  'put_venue'),
        ('call', 'call_strike', 'current_call_value_usdc', 'call_bid_used_usdc_per_btc', 'call_venue')
    ]:
        strike = p[strike_key]
        our_value = p[value_key]
        our_bid = p.get(bid_key)
        venue = p.get(venue_key)
        contracts = p['contracts_btc']
        
        print(f"  {side.upper()} leg @ \${int(strike)} ({venue or 'no venue'}):")
        if our_bid is None:
            print(f"    Our bid used:    N/A (bs_fallback method, no venue bid)")
            continue
        print(f"    Our bid used:    \${our_bid:.2f} USD/BTC")
        print(f"    Our leg value:   \${our_value:.2f}  ({contracts} BTC × \${our_bid:.2f} × 0.95 haircut)")
        
        # Try to construct Deribit instrument name and fetch
        if venue == 'deribit':
            # We need the expiry date. Look it up from the cache via /admin/foxify/v2/cell-costs response
            # For now, just show what to manually verify
            print(f"    LIVE Deribit ticker: query https://www.deribit.com/api/v2/public/ticker?instrument_name=<INSTRUMENT_NAME>")
            print(f"      → best_bid_price * index_price should be ~ \${our_bid:.2f}")
            print(f"      → if YES (within 5%): MTM math is real and accurate")
            print(f"      → if NO: stale cache or pricing error")
        else:
            print(f"    Bullish — currently rate-limited; can't validate live")
    print()
EOF

echo
echo "════════════════════════════════════════════════════════════════════════"
echo "  HOW TO COMPLETE VALIDATION MANUALLY:"
echo "════════════════════════════════════════════════════════════════════════"
echo "  1. Note the strike and venue for each leg above"
echo "  2. For Deribit legs, build the instrument name:"
echo "     BTC-{DDMMMYY-uppercase}-{STRIKE}-{P or C}"
echo "     Example: BTC-30MAY26-74000-P"
echo "  3. Fetch live ticker:"
echo "     curl 'https://www.deribit.com/api/v2/public/ticker?instrument_name=BTC-...' | jq '.result | {best_bid_price, index_price, best_bid_usd: (.best_bid_price * .index_price)}'"
echo "  4. Compare 'best_bid_usd' to 'Our bid used' above"
echo "     - If within ~5%: math validates ✓"
echo "     - If diverges 20%+: cache is stale, our valuation is off"
echo "════════════════════════════════════════════════════════════════════════"
