# Trigger Source and Feed Spec — Two-Sided Cooperative Volume Facility

**Status:** Phase 0 launch spec
**Generated:** 2026-05-27
**Owner:** Atticus engineering
**Audience:** Foxify integration team, Atticus operators, future agents
**Decision authority:** Operator (2026-05-27): Atticus's own composite spot/index feed is the canonical and exclusive trigger source for all two-sided pairs.

---

## 1. Why this matters

A two-sided pair fires when the underlying BTC price crosses ±2% from the spot at activation. The fire event closes both Foxify perps and starts Atticus's theta-aware TP curve on the strangle hedge. **Who decides "crossed"** is therefore the single most important integrity question in the product.

Previous handoff docs left this ambiguous (partner-exchange index? composite? Deribit DVOL underlying? Bullish mark?). This spec settles it.

**Canonical answer:** Atticus's own feed, defined in §3, is the *only* source consulted for trigger detection. Foxify's bot does not push trigger events to Atticus; Atticus polls its own feed and notifies Foxify on fire. Partner-exchange perps may internally trigger at slightly different prices (each partner uses its own mark/index); this divergence is **Foxify's risk to manage**, not Atticus's. Atticus's commitment is: detect, execute, and notify accurately against the canonical feed.

---

## 2. End-to-end activation flow

```
Foxify bot                              Atticus API                          Bullish + Deribit
    |                                        |                                       |
    | POST /single-side/two-sided/activate   |                                       |
    | { cell_id, max_acceptable_hedge_cost,  |                                       |
    |   foxify_pair_ref }                    |                                       |
    | -------------------------------------> |                                       |
    |                                        | read live chain + feed snapshot       |
    |                                        | pick venue per leg (depth + ask)      |
    |                                        | check cost <= max_acceptable          |
    |                                        | place limit-IOC both legs ----------> |
    |                                        |                                       |
    |                                        | <---------- fills (within 8s ceiling) |
    |                                        | record pair_leg rows w/ live anchors  |
    |                                        | record pair w/ feed_snapshot          |
    |                                        | start trigger detector                |
    | <-- 201 Created                        |                                       |
    |   { pair_id, status: "active",         |                                       |
    |     put_leg, call_leg,                 |                                       |
    |     trigger_down_price,                |                                       |
    |     trigger_up_price,                  |                                       |
    |     total_hedge_cost_usdc, ... }       |                                       |
    |                                        |                                       |
    | (Foxify opens long perp + short perp   |                                       |
    |  on partner exchange)                  |                                       |
    |                                        |                                       |
    |                              [time passes; Atticus polls feed]                 |
    |                                        |                                       |
    |                                        | feed price crosses ±2% boundary       |
    |                                        | emit trigger_detected event           |
    |                                        | run theta-aware TP on strangle -----> |
    |                                        |                                       |
    |                                        | <----------- sells, fills, settlement |
    |                                        |                                       |
    | <-- POST /foxify-webhook/pair-closed   |                                       |
    |   { pair_id, trigger_side, salvage,    |                                       |
    |     foxify_share, atticus_share,       |                                       |
    |     trigger_feed_snapshot }            |                                       |
    |                                        |                                       |
```

Atticus is the synchronous counterparty for the activation. Atticus is the asynchronous reporter for the close. Foxify is responsible for opening their perps on partner exchanges in response to the 201 (timing window: ≤30s recommended; Atticus's hedge is already live).

---

## 3. The canonical Atticus feed

### 3.1 Sources (Phase 0)

Multi-source aggregation. Phase 0 ships with these sources, polled in parallel:

| Source | Symbol | Polled cadence | Failover priority |
|---|---|---|---|
| Bullish BTC-USDC spot | `BTCUSDC` (Bullish public ticker) | 1s | 1 (primary, since hedge venue) |
| Deribit BTC index (DVOL underlying) | `btc_usd` index | 1s | 2 |
| Coinbase BTC-USD | `BTC-USD` ticker | 1s | 3 |
| Binance BTC-USDT | `BTCUSDT` ticker (spot, not perp) | 1s | 4 |
| Kraken BTC-USD | `XBT/USD` ticker | 1s | 5 |

### 3.2 Aggregation method

Per-tick:
1. Collect quotes from all available sources within the last 1.5 s window.
2. Reject any source whose quote deviates more than **0.5%** from the median of the rest (outlier protection against single-venue glitches).
3. Take the median of the surviving sources as the canonical feed value.
4. If fewer than **3 sources** survive after rejection, emit `feed_degraded` warning but continue (with a faster `source_stale` SLA — 2 s instead of 5 s).
5. If fewer than **2 sources** survive, emit `feed_unavailable` → Atticus halt (no new activations, existing pairs frozen with operator alert).

### 3.3 Cadence and SLA

- **Push cadence:** 1 second (each surviving source contributes its latest tick).
- **`source_stale` SLA:** 5 seconds since last successful aggregation under normal conditions; 2 seconds in `feed_degraded` mode.
- **Latency budget for trigger detection:** ≤200 ms from boundary crossing on the feed to `trigger_detected` event emission.

### 3.4 Audit and verifiability

Every trigger event records a `feed_snapshot` to the `pair_event` table containing:

```
{
  ts: ISO timestamp,
  canonical_price: number,
  sources: [
    { source: "bullish", price: 76234.5, ts: 1748385600.123 },
    { source: "deribit", price: 76233.8, ts: 1748385600.140 },
    { source: "coinbase", price: 76235.1, ts: 1748385600.118 },
    ...
  ],
  rejected_sources: [
    { source: "binance", price: 76301.0, deviation_pct: 0.087, reason: "outlier_gt_0.5pct" }
  ],
  median_calculation: "76234.5 = median([76234.5, 76233.8, 76235.1])"
}
```

Foxify (or any third party) can independently verify any trigger event by replaying the source quotes at the recorded timestamps.

### 3.5 Feed config versioning

The feed config (sources list, aggregation parameters) is **versioned**. Any change increments the feed version. The version active at pair activation is recorded in `pair.feed_snapshot_at_activation.feed_version`. Active pairs continue using the version under which they were activated, even if Atticus rolls out a new feed config mid-pair. New activations use the latest version.

---

## 4. API contract — activation

### 4.1 Endpoint

```
POST /single-side/two-sided/activate
Headers:
  X-Foxify-Token: <bearer>
  Content-Type: application/json
  Idempotency-Key: <uuid v4>   # optional but recommended
```

### 4.2 Request body

```jsonc
{
  "cell_id": "pair_50k_2pct",                  // only cell available in Phase 0
  "max_acceptable_hedge_cost_usdc": 3500,      // Foxify's cap on total hedge cost
  "foxify_pair_ref": "fxy-2026-05-27-001",     // Foxify's idempotency key (UNIQUE)
  "metadata": {                                // optional, opaque to Atticus
    "foxify_perp_long_id": "...",
    "foxify_perp_short_id": "...",
    "any_other_foxify_data": "..."
  }
}
```

### 4.3 Responses

#### 201 Created — hedge filled, pair active

```jsonc
{
  "pair_id": "f4e2c8a6-...",
  "status": "active",
  "cell_id": "pair_50k_2pct",
  "foxify_pair_ref": "fxy-2026-05-27-001",
  "activated_at": "2026-05-27T18:42:15.230Z",

  "spot_at_activation": 76042.50,
  "feed_version": "v1.0.0",

  "put_strike": 77000,
  "call_strike": 75000,
  "contracts_btc": 1.4,

  "put_leg": {
    "venue": "bullish",
    "symbol": "BTC-29MAY26-77000-P",
    "ask_filled_usdc_per_btc": 1150.00,
    "contracts_btc": 1.4,
    "leg_cost_usdc": 1610.00,
    "filled_at": "2026-05-27T18:42:14.880Z"
  },
  "call_leg": {
    "venue": "deribit",
    "symbol": "BTC-29MAY26-75000-C",
    "ask_filled_usdc_per_btc": 1162.86,
    "contracts_btc": 1.4,
    "leg_cost_usdc": 1628.00,
    "filled_at": "2026-05-27T18:42:14.910Z"
  },

  "total_hedge_cost_usdc": 3238.00,
  "trigger_down_price": 74521.65,    // = spot_at_activation × 0.98
  "trigger_up_price": 77563.35,      // = spot_at_activation × 1.02

  "tier_at_activation": "tier_1",
  "atticus_split_pct": 0.15,
  "atticus_floor_usdc": 25.00,
  "foxify_split_pct": 0.85,

  "hedge_tenor_days": 3,
  "expires_at": "2026-05-30T18:42:14.880Z",

  "tp_force_exit_at": "2026-05-30T14:42:14.880Z"   // expiry - 4h
}
```

#### 422 Unprocessable Entity — price exceeded cap

```jsonc
{
  "error": "price_exceeded",
  "message": "Live hedge cost exceeds max_acceptable_hedge_cost_usdc",
  "live_quoted_cost_usdc": 3612.40,
  "max_acceptable_usdc": 3500.00,
  "retry_recommended": false,
  "feed_snapshot": { /* current Atticus feed state at quote time */ }
}
```

No orders placed. Foxify bot can retry with a higher cap or wait.

#### 503 Service Unavailable — Atticus cannot fulfill

```jsonc
{
  "error": "atticus_halt" | "depth_insufficient" | "feed_unavailable" | "venue_down",
  "message": "Human-readable reason",
  "retry_after_s": 60,
  "halt_reason_code": "rolling_salvage_below_threshold" | null
}
```

#### 409 Conflict — idempotent replay

```jsonc
{
  "error": "duplicate_foxify_pair_ref",
  "existing_pair_id": "f4e2c8a6-...",
  "existing_status": "active" | "triggered" | "settled" | ...,
  "existing_activated_at": "2026-05-27T18:42:15.230Z"
}
```

Atticus treats `foxify_pair_ref` as a strict idempotency key. Replaying the same ref returns the existing pair record without placing new orders.

#### 4xx other

Standard validation errors (missing field, malformed body, auth failure, etc.).

### 4.4 Timing guarantees

- **p50 activation latency:** ≤2 s (quote + multi-venue fill + DB write).
- **p99 activation latency:** ≤8 s (worst case with one venue slow + retry).
- **Hard timeout:** 12 s. If not filled within 12 s, all partial fills are reversed via limit-IOC and 503 is returned with `partial_fill_reversed`.

---

## 5. API contract — close notification (Atticus → Foxify webhook)

### 5.1 Webhook delivery

Atticus POSTs to a Foxify-registered webhook URL when a pair settles:

```jsonc
POST <foxify_webhook_url>
Headers:
  X-Atticus-Signature: <hmac-sha256>
  Content-Type: application/json
```

### 5.2 Payload

```jsonc
{
  "pair_id": "f4e2c8a6-...",
  "foxify_pair_ref": "fxy-2026-05-27-001",
  "closed_at": "2026-05-28T03:21:09.450Z",
  "closed_reason": "trigger" | "foxify_close" | "expiry",

  "trigger_side": "down" | "up" | null,
  "trigger_feed_snapshot": { /* §3.4 audit object */ } | null,

  "salvage_proceeds_usdc": 3840.00,
  "uplift_usdc": 602.00,         // = salvage - hedge_cost (can be negative)
  "foxify_share_usdc": 3727.30,  // includes return of hedge_cost on win; lower on loss
  "atticus_share_usdc": 112.70,

  "put_leg_close": { /* venue, ask, fill, ts */ },
  "call_leg_close": { /* same */ },

  "tier_at_settlement": "tier_1",
  "exit_mode": "capture_window_peak" | "trail_retrace" | "hard_floor" | "force_expiry" | "foxify_close"
}
```

### 5.3 Delivery semantics

- At-least-once delivery with exponential backoff (1s, 5s, 30s, 5m, 30m, 2h, 12h).
- Signed with HMAC-SHA256 over the payload body using a shared secret.
- Foxify endpoint must respond 2xx within 10 s; non-2xx triggers retry.
- Idempotent on `pair_id` — Foxify should treat duplicate deliveries as no-ops.

---

## 6. Foxify-initiated early close

```
POST /single-side/two-sided/close
Headers: X-Foxify-Token
Body: { pair_id, foxify_close_reason?: string }

Response 200:
  { pair_id, status: "unwinding", initiated_at, estimated_settlement_in_s: 30 }

Response 409:
  { error: "pair_not_active", current_status }

Response 404:
  { error: "pair_not_found" }
```

Triggers the same theta-aware TP curve immediately. Settlement webhook fires when complete (typically <30 s).

---

## 7. Non-API audit endpoints

Read-only, for Foxify/operator verification:

```
GET  /single-side/two-sided/pairs/:pair_id              # full pair record
GET  /single-side/two-sided/pairs/:pair_id/events       # event timeline
GET  /single-side/two-sided/pairs/:pair_id/feed-audit   # trigger feed snapshot + replay
GET  /single-side/two-sided/feed/current                # current canonical feed value + sources
GET  /single-side/two-sided/feed/health                 # feed degradation status
```

---

## 8. Open items requiring operator action before live cutover

- [ ] Foxify provides webhook URL + shared HMAC secret.
- [ ] Confirm 5 sources in §3.1 are accessible from Atticus production env (Render).
- [ ] Confirm `max_acceptable_hedge_cost_usdc` reasonable defaults with Foxify (e.g., 110% of last 24h mean cost as a safe baseline).
- [ ] Confirm Foxify accepts the 30 s timing window between Atticus 201 and Foxify perp open (or specify alternative).
- [ ] Sign-off on this spec by both teams.

---

**End of spec.**
