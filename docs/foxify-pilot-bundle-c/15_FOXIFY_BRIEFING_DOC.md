# Foxify Volume Cover — Pilot Briefing Document

**Counterparty:** Foxify
**Provider:** Atticus
**Effective:** Day of signing
**Term:** 28 calendar days (pilot)

---

## 1. Product

**Volume Cover** — Atticus protects Foxify's paired long+short trader positions against directional touch events.

- **One Atticus cover per Foxify pair** (one premium, one fixed payout per pair).
- **Touch trigger**: Atticus pays Foxify the fixed payout when BTC spot touches a ±X% boundary from the pair entry price.
- **Settlement**: 25% weekly (Mondays 00:00 UTC) + 75% end-of-month (1st 00:00 UTC), aligned both directions (premium-in to Atticus, payout-out to Foxify).

## 2. Cells (price matrix)

| Cell ID | Pair Notional | Trigger | Payout | Daily Premium |
|---|---|---|---|---|
| `50k_2pct_1k` | $50k each leg | ±2% | $1,000 | **$350** |
| `50k_5pct_2_5k` | $50k each leg | ±5% | $2,500 | **$200** |
| `50k_10pct_5k` | $50k each leg | ±10% | $5,000 | **$100** |
| `200k_5pct_10k` | $200k each leg | ±5% | $10,000 | **$800** |
| `200k_10pct_20k` | $200k each leg | ±10% | $20,000 | **$400** |
| `200k_15pct_30k` | $200k each leg | ±15% | $30,000 | **$370** |

All prices Atticus-side runtime-tunable; lock for pilot duration unless either party requests adjustment with 24h notice.

## 3. Capacity ramp (phased)

| Period | Per-cell daily cap | Trigger to ramp |
|---|---|---|
| Days 1-5 | 5 positions/day | (discovery — gather salvage data) |
| Days 6-14 | 30 positions/day | live salvage rate ≥85% confirmed |
| Days 15-28 | 100 positions/day | live salvage rate ≥95% confirmed |

Caps are per-cell. Total system-wide cap = sum across the 6 cells.

## 4. Salvage assumption + reset clause

Atticus prices each cell assuming a hedge salvage rate of **~95% of the payout amount** on touch trigger via TIGHT strangle hedging on Bullish (primary) and Deribit (fallback).

**Reset clause (mid-pilot adjustment):** End of week 1 (Day 5 EOD), parties review the measured live salvage rate.
- If salvage ≥85%: matrix prices stay locked, ramp to Days 6-14 cap.
- If salvage 70-85%: 24-hour adjustment window — parties may renegotiate prices ±20%, otherwise pilot continues at Days 1-5 cap.
- If salvage <70%: 24-hour opt-out for either party; pilot pauses for review.

Same review repeats end of week 2 and week 3 with the same brackets.

## 5. Auto-halt conditions (Atticus side)

Atticus may automatically halt new activations under any of:

| Condition | Threshold | Effect |
|---|---|---|
| Cumulative Atticus loss | ≥ $5,000 over rolling 7 days | Hard halt; manual reset only |
| Live salvage rate | <70% over rolling 5 triggers | Hard halt; operator review |
| Live salvage rate | <85% over rolling 5 triggers | Per-cell cap drops to 3/day |
| Trigger surge | >5 triggers in 24h | 30-min pause |
| Bullish + Deribit both unavailable | Order routing failure | Activation rejected with error |
| Equity drawdown | -50% in 24h | Circuit breaker, manual reset |

Foxify is notified within 5 minutes of any halt via daily report endpoint and (optional) ops contact.

## 6. API access

Foxify integration uses HMAC-SHA256 signed HTTP requests.

**Endpoints:**
- `POST /volume-cover/quote` — get a price for a pair
- `POST /volume-cover/activate` — open a cover position (idempotent on `foxifyPairId`)
- `GET  /volume-cover/positions/:id` — check status of a position
- `POST /volume-cover/positions/:id/close` — close early (no penalty, hedge sold at market)

**Auth:** `X-Foxify-Signature: HMAC-SHA256(timestamp + method + path + body, sharedSecret)` + `X-Foxify-Timestamp: <ms-since-epoch>`. Secrets exchanged in person at signing.

**Rate limits:** 60 quotes/min, 30 activations/min per API key. Per-fingerprint anti-bot cooldowns also active.

**Reporting:** Atticus delivers daily report via API pull (no automated push). Foxify ops contact captured in this doc; no automated comms in pilot.

## 7. Operational contacts

| Party | Role | Contact |
|---|---|---|
| Atticus | Operator (sole approval authority for pilot) | _to be filled at signing_ |
| Foxify | Ops contact (in-doc only, no automated comms) | _to be filled at signing_ |

## 8. Acknowledgments (signature block)

By signing below, both parties acknowledge:
- The salvage rate is a model assumption; actual live salvage will be measured and may trigger the §4 reset clause.
- The capacity ramp in §3 is conditional on validated salvage rates; Day-1 cap is 5/cell/day regardless.
- Either party may invoke the §4 opt-out if salvage <70% by Day 5.
- The auto-halt conditions in §5 do not constitute breach by Atticus; they are protective and reverse upon condition resolution.
- All settlements per §1 cadence; weekly + monthly aggregation; no per-trade cash flow.

| Party | Name | Signature | Date |
|---|---|---|---|
| Atticus | | | |
| Foxify | | | |
