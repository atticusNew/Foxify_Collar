# FalconX Options Integration — Technical Reference

## Overview

Atticus uses FalconX as an OTC execution venue for BTC options (puts and calls) across two products:

1. **Treasury Protection** — Daily 1DTE puts, ~$1M notional, systematic execution at fixed schedule
2. **Retail Protection** — On-demand 2DTE puts/calls, $10k–$100k notional, tiered by SL%

Both products require **buy-side** and **sell-side** (unwind) capability.

---

## Base URL

- Production: `https://api.falconx.io`
- Streaming: `https://stream.falconx.io`

## Authentication

All requests use HMAC-SHA256 signature via four headers:

| Header | Value |
|--------|-------|
| `FX-ACCESS-KEY` | API key |
| `FX-ACCESS-SIGN` | `base64(HMAC_SHA256(base64_decode(secret), timestamp + METHOD + requestPath + body))` |
| `FX-ACCESS-TIMESTAMP` | Unix epoch seconds (e.g. `1714000000.000`) |
| `FX-ACCESS-PASSPHRASE` | Account passphrase |

### Signature Construction

```
prehash = timestamp + "POST" + "/v3/derivatives/option/quote" + JSON.stringify(body)
signature = base64(HMAC_SHA256(base64_decode(secret), prehash))
```

## Environment Variables

```
FALCONX_BASE_URL=https://api.falconx.io
FALCONX_API_KEY=<key>
FALCONX_SECRET=<base64-encoded secret>
FALCONX_PASSPHRASE=<passphrase>
```

---

## Endpoints — Currently Implemented

### 1. Request Option Quote (Buy)

```
POST /v3/derivatives/option/quote
```

Request body:
```json
{
  "token_pair": {
    "base_token": "BTC",
    "quote_token": "USDC"
  },
  "quantity": 0.5,
  "structure": [
    {
      "side": "buy",
      "symbol": "BTC-25APR26-80000-P",
      "weight": 1
    }
  ],
  "client_order_id": "uuid-v4"
}
```

Response:
```json
{
  "status": "success",
  "fx_quote_id": "abc123...",
  "rfq_id": "rfq-456...",
  "ask_price": { "value": 250.00, "token": "USDC" },
  "bid_price": { "value": 230.00, "token": "USDC" },
  "quantity": 0.5,
  "t_quote": "2026-04-08T12:00:00Z",
  "t_expiry": "2026-04-08T12:00:10Z"
}
```

**Notes:**
- `symbol` uses Deribit-style instrument naming: `BTC-DDMMMYY-STRIKE-P/C`
- `side` in structure determines whether the quote is for buying or selling the option
- Response `ask_price` is the buy price, `bid_price` is the sell price
- Quote validity is typically 5–10 seconds (check `t_expiry`)
- For **sell-side (unwind) quotes**, set `side: "sell"` in the structure array

### 2. Execute Quote

```
POST /v3/derivatives/option/quote/execute
```

Request body:
```json
{
  "fx_quote_id": "abc123..."
}
```

Response:
```json
{
  "status": "success",
  "fx_quote_id": "abc123...",
  "rfq_id": "rfq-456...",
  "executed_price": 250.00,
  "quantity": 0.5,
  "t_execute": "2026-04-08T12:00:05Z"
}
```

**Notes:**
- Must be called before `t_expiry` from the quote response
- For sell-side executions, the `executed_price` is the bid price realized

---

## Endpoints — Required for Full Integration

### 3. Request Option Quote (Sell / Unwind)

Same endpoint as buy, but with `side: "sell"` in the structure:

```
POST /v3/derivatives/option/quote
```

```json
{
  "token_pair": {
    "base_token": "BTC",
    "quote_token": "USDC"
  },
  "quantity": 0.5,
  "structure": [
    {
      "side": "sell",
      "symbol": "BTC-25APR26-80000-P",
      "weight": 1
    }
  ],
  "client_order_id": "unwind-uuid-v4"
}
```

Expected response includes `bid_price` (the unwind price FalconX will pay).
Execute via the same `/v3/derivatives/option/quote/execute` endpoint.

**Use case:** TP (take-profit) recovery — selling options back after a price trigger
to capture remaining time value + intrinsic value.

### 4. Get Open Derivatives Positions

```
GET /v1/derivatives?trade_status=open&product_type=option&market_list=BTC-USD
```

Response:
```json
[
  {
    "trade_id": "13db3a3f832e444a90435e900d1c3222",
    "product": "option",
    "option_type": "put",
    "status": "open",
    "token_pair": { "base_token": "BTC", "quote_token": "USD" },
    "quantity": 10.0,
    "side": "buy",
    "strike_price": { "token": "USD", "value": 78000.0 },
    "premium": { "token": "USD", "value": 1500.0 },
    "maturity_date": "2026-04-09T08:00:00Z",
    "trade_date": "2026-04-08T00:05:00Z",
    "trade_notional": { "token": "USD", "value": 800000.0 },
    "spot_reference_price": { "token": "USD", "value": 80000.0 },
    "delta": -262.0,
    "vega": { "value": -272.0, "token": "USD" },
    "daily_mark": { "value": -50.0, "token": "USD" }
  }
]
```

**Use case:** Position reconciliation, monitoring open hedges, confirming fills.

### 5. Get Derivatives Margins

```
GET /v1/derivatives/margins
```

Response:
```json
[
  { "token": "BTC", "total_margin": 10.1 },
  { "token": "USD", "total_margin": 250000.0 }
]
```

**Use case:** Pre-trade margin checks, capital monitoring.

### 6. Get Option Positions (Dedicated Endpoint)

```
GET /v1/derivatives/option/positions
```

Added October 2023. Returns option-specific position data.

### 7. Get Option Transactions

```
GET /v1/derivatives/option/transactions
```

Added October 2023. Returns option trade history.

### 8. Get Balances

```
GET /v1/balances
```

Response:
```json
[
  { "balance": 500000.0, "token": "USD", "platform": "api" },
  { "balance": 0.5, "token": "BTC", "platform": "api" }
]
```

### 9. Get Quote Status

```
GET /v1/quotes/{fx_quote_id}
```

Check fill status of a previously requested quote.

### 10. Get Executed Quotes (History)

```
GET /v1/quotes?t_start=2026-04-01T00:00:00Z&t_end=2026-04-08T00:00:00Z
```

Returns all executed quotes in the time range.

### 11. Portfolio Position Summary

```
GET /v1/portfolio_position_summary
```

Aggregate portfolio-level view.

---

## Operational Flow — Buy + Unwind

### Buy (Opening a Hedge)

```
1. POST /v3/derivatives/option/quote
   → side: "buy", symbol: "BTC-09APR26-78000-P", quantity: 12.5
   ← fx_quote_id, ask_price

2. POST /v3/derivatives/option/quote/execute
   → fx_quote_id
   ← executed_price, quantity, t_execute

3. Record: instrument, quantity, cost, external_order_id = fx_quote_id
```

### Sell / Unwind (Closing for TP Recovery)

```
1. POST /v3/derivatives/option/quote
   → side: "sell", symbol: "BTC-09APR26-78000-P", quantity: 12.5
   ← fx_quote_id, bid_price

2. POST /v3/derivatives/option/quote/execute
   → fx_quote_id
   ← executed_price (bid realized), quantity

3. Record: tp_proceeds = executed_price * quantity, tp_sold = true
```

### Position Check (Reconciliation)

```
GET /v1/derivatives?trade_status=open&product_type=option
→ Verify position matches expected instrument + quantity
```

---

## Error Mapping

| FalconX Error | Internal Code | Action |
|---------------|---------------|--------|
| `QUOTE_EXPIRED` | `quote_expired` | Re-quote |
| `INVALID_QUOTE_ID` | `invalid_quote_id` | Re-quote |
| Cooldown | `execution_cooldown` | Wait + retry |
| Insufficient balance/equity | `insufficient_balance` | Alert admin |
| Other | `venue_error` | Log + alert |

---

## Testing Without FalconX Credentials

- `PILOT_VENUE_MODE=mock_falconx` — Deterministic local/CI tests
- `PILOT_VENUE_MODE=deribit_test` — Live paper execution via Deribit testnet

---

## Operational Questions for FalconX BD

### Confirmed / Standard
- [x] HMAC-SHA256 authentication (same as spot)
- [x] Options RFQ via `/v3/derivatives/option/quote`
- [x] Execute via `/v3/derivatives/option/quote/execute`
- [x] Position view via `/v1/derivatives`

### To Confirm with BD
- [ ] Sell-side RFQ for options: Does `/v3/derivatives/option/quote` support `side: "sell"` in the structure array to unwind existing positions?
- [ ] Minimum quantity on sell-side RFQs (retail unwinds may be 0.1–0.3 BTC)
- [ ] Are unwinds quoted at mark-to-market or is fixed pricing available for systematic close-outs?
- [ ] Quote validity window for options RFQ (seconds)
- [ ] Supported instrument naming format for options (Deribit-style `BTC-DDMMMYY-STRIKE-P/C`?)
- [ ] Available tenors: do 1DTE and 2DTE options have liquidity on the desk?
- [ ] Rate limits on RFQ requests (we may send 10–50/day retail + 1–2/day treasury)
- [ ] Is `close_rfq` endpoint needed to cancel unfilled quotes, or do they auto-expire?
