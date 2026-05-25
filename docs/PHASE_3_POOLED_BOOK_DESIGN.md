# Phase 3 — Pooled Cohort Hedge Book (Design Doc)

**Status:** Draft v0.1 — design only, no implementation gate
**Owner:** TBD
**Reviewers:** Atticus operator + quant
**Branch:** `vc-sandbox`
**Date:** 2026-05-20

---

## 1. Goal & non-goals

### 1.1 Goal

Reduce **gross hedge capital required** for a given concurrent open-position count by replacing per-position dedicated put+call legs with a **shared cohort book** of legs sized to the cohort's net exposure.

Quantitative target: at N=10 concurrent positions in the same `(triggerPct, tenor, venue)` cohort, gross hedge capital ≈ **35-50% of dedicated**. At N=20, ≈ **25-35%**.

### 1.2 Non-goals

- Cross-cohort netting (different `triggerPct` bands stay separate; see §10 future work)
- Dynamic strike re-rolling within a single position's life (positions inherit cohort strikes)
- Replacing the existing per-position Foxify-facing API surface (positions still have IDs, status, salvage state — pooling is internal)
- Regulatory arbitrage or change of legal venue treatment

### 1.3 Why this is right *eventually*, not now

Phase 3 is the right destination once Phase 1 (long strangle) is healthy on live and Phase 2 (vertical spreads) is shadow-validated. Doing it earlier risks correlated-trigger insolvency before we have venue diversification (Bullish + Deribit) and spread-margined capital efficiency.

**Hard prerequisite gates before any live Phase 3 traffic:**

1. Phase 1 live for ≥6 weeks with no `[VC ALERT]` weekly
2. Phase 2 spreads live for ≥4 weeks with salvage parity
3. Bullish mainnet healthy for ≥4 weeks
4. Daily reconciler in production
5. ≥3 distinct cohorts with ≥10 concurrent positions sustained

---

## 2. Cohort definition

A **cohort** is a tuple `(triggerPct, tenorDays, venue)` plus a derived **expiry rolling window**.

Examples:
- `cohort_2pct_3d_deribit` — 2% trigger, 3-day tenor, Deribit primary
- `cohort_5pct_5d_deribit` — 5% trigger, 5-day tenor, Deribit primary
- `cohort_2pct_3d_bullish` — same shape as first, Bullish primary (post-Mission 1)

Why these three axes:
- **`triggerPct`**: governs strike distance from spot; cannot mix without changing intrinsic-coverage math
- **`tenorDays`**: governs theta profile and expiry roll cadence
- **`venue`**: governs settlement currency, contract granularity, and operational risk

Cohorts that are *not* viable fungibility units:
- Different `notional` (`50k_2pct_1k` and `200k_5pct_10k`) — different strike % means different strikes
- Mixing cells with different `hedgePct` — same reason
- Cross-venue (Deribit and Bullish positions claiming the same pool legs) — different settlement, different fungibility

---

## 3. Pool state machine

```
                   ┌──────────┐
       new cohort  │ BUILDING │  no positions yet, no legs held
                   └─────┬────┘
                         │ first position activated
                         ▼
                   ┌──────────┐
        normal     │  ARMED   │◀──┐  positions can claim/release; legs stay
                   └─────┬────┘   │
                         │        │ rebalance complete
            tenor T-1d   │        │
                         ▼        │
                   ┌─────────────┐│
                   │REBALANCING  │┘  selling expiring legs, buying next-tenor
                   └─────┬───────┘
                         │
            cohort drained or paused
                         │
                         ▼
                   ┌──────────┐
                   │ CLOSING  │  selling all legs, refunding open claims
                   └──────────┘
```

State transitions:

| From | To | Trigger |
|---|---|---|
| `BUILDING` | `ARMED` | First position activates; pool buys initial legs sized to that single claim + minimum buffer |
| `ARMED` | `ARMED` | Position activate/close — pool resizes (buy more legs or sell partial) |
| `ARMED` | `REBALANCING` | T-1d before nearest leg expiry, OR explicit operator trigger |
| `REBALANCING` | `ARMED` | Rebalance complete (new tenor legs filled, old tenor legs sold) |
| `ARMED`/`REBALANCING` | `CLOSING` | Cohort disabled in admin OR last position closed AND no new activations in 24h |
| `CLOSING` | `BUILDING` | Reactivation after manual operator unlock |

Invariants enforced at every transition:
- `pool.netDelta` is within `[-deltaCap, +deltaCap]` for the cohort
- `pool.totalContractsBtc >= sum(claims) × bufferMultiplier`
- `pool.totalEquityUsdc >= maxConcurrentTriggerPayout × stressMultiplier`

---

## 4. Allocation algorithm — claim math

When position `P_i` activates in cohort `C`:

1. Compute **per-position required contracts** for the cell (existing `computeHedgeContractSize` logic) → `c_i` BTC
2. Compute **pool's current capacity** = `pool.contractsBtc - sum(claims)` BTC
3. If `c_i ≤ capacity`: allocate fractional claim of `c_i / pool.contractsBtc`; no new orders needed
4. If `c_i > capacity`: pool must **expand** — buy additional `c_i + bufferMultiplier × c_i` contracts of put/call at cohort strikes, then allocate

Claim row (`volume_cover_pool_claim`):

```
claim_id      uuid    PK
position_id   text    FK → volume_cover_position
pool_id       text    FK → volume_cover_pool
contracts_btc numeric per-position pro-rata BTC
claim_cost_usdc numeric position's pro-rata share of pool's cumulative buy cost at claim time
created_at    timestamptz
released_at   timestamptz NULL
release_reason text    one of: 'closed_no_trigger', 'closed_triggered', 'expired', 'force_release'
```

**Position-side accounting** (transparent to Foxify, retains existing API):
- Position open: `claim_cost_usdc` debits `atticus_hedge` pool ledger as `hedge_buy_out`
- Position close (no trigger): pool sells fractional pro-rata; credits `claim_cost_usdc - lossDelta` as `hedge_sell_in`
- Position close (triggered): pool unwinds the equivalent of `c_i` contracts at trigger; credits realized intrinsic + extrinsic; payout debits per existing logic

### 4.1 Pro-rata share formula

When pool sells `x` BTC of legs to cover a position close:

```
contracts_to_sell = position_claim.contracts_btc
sale_proceeds = x × (mark_put + mark_call) × (1 - spread_haircut)
fee_share = pool.fees_paid_lifetime × (contracts_to_sell / pool.cumulative_contracts_held)

position_salvage_usdc = sale_proceeds - fee_share
```

The pool keeps its remaining legs intact; the position is detached from the pool.

### 4.2 Strike adjustment risk

Each cohort holds legs at a **single strike pair** chosen at first activation (or last rebalance). Subsequent positions activate against this fixed strike pair. Risk: if BTC has moved 0.5% since cohort first activated, new positions inherit slightly off-band strikes.

**Mitigation:** rebalance trigger when `|spotChange / cohortStrike| > 0.3%`. Rebalance buys new strikes at current spot, sells old ones, claims migrate pro-rata.

---

## 5. Trigger handling

When position `P_i` triggers (one of triggerHigh or triggerLow breaches):

1. `triggerDetector` fires as today: marks `position.status = 'triggered'`, debits `payout_out`
2. Pool **does not** sell legs immediately — instead, a `pool_trigger_event` row records that `c_i` BTC of pool exposure is now "claimed for liquidation"
3. Pool's hedge manager runs a **trigger-aware TP** on those `c_i` BTC of fractional pool legs:
   - Same 12 rules apply
   - Sells happen at the cohort level, proceeds split pro-rata among triggered positions
4. After all triggered positions in the same tick are unwound, pool checks if remaining `c_i` capacity is below `bufferMultiplier × sum(open_claims)` — if so, rebalance up

Why decouple trigger from sell:
- Reduces N round-trips to venue when M positions trigger in same tick (correlation event)
- Lets pool batch-sell at better-than-market prices (post one large limit instead of M small markets)
- Preserves intrinsic value capture: pool legs near-expiry don't all get sold at the worst tick

### 5.1 Worst case: simultaneous correlated triggers

Stress scenario: 10 positions in `cohort_2pct_3d`, BTC drops 2.5% in 1 minute. All 10 triggerLow breach.

Pool must:
1. Pay 10 × $1k = $10k payouts immediately (Atticus pool reserve)
2. Sell `sum(c_i)` ≈ 14 BTC of put legs (the cohort's full long-put position) into a falling market
3. Distribute proceeds pro-rata

Required reserves:
- Atticus pool must hold ≥ `maxConcurrentPayouts × stressMultiplier` USDC
- For 10 positions: ≥ $10k × 1.5 = $15k reserve, on top of hedge collateral
- This is **stricter than today's single-position reserve** because correlation is total

**Hard guard:** if `currentReserveUsdc < estimatedConcurrentPayout`, cohort rejects new activations.

---

## 6. Schema changes

Two new tables, two existing-table extensions.

### 6.1 New: `volume_cover_pool`

```sql
CREATE TABLE volume_cover_pool (
  id                      text PRIMARY KEY,             -- e.g. 'cohort_2pct_3d_deribit'
  trigger_pct             numeric NOT NULL,
  tenor_days              integer NOT NULL,
  venue                   text NOT NULL,
  state                   text NOT NULL CHECK (state IN ('building','armed','rebalancing','closing')),
  current_put_strike      numeric,                       -- USDC, NULL during BUILDING
  current_call_strike     numeric,
  current_expiry          timestamptz,
  contracts_btc           numeric NOT NULL DEFAULT 0,    -- gross BTC long
  cumulative_buy_usdc     numeric NOT NULL DEFAULT 0,
  cumulative_sell_usdc    numeric NOT NULL DEFAULT 0,
  fees_paid_usdc          numeric NOT NULL DEFAULT 0,
  buffer_multiplier       numeric NOT NULL DEFAULT 1.2,
  delta_cap_btc           numeric NOT NULL DEFAULT 0.5,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
```

### 6.2 New: `volume_cover_pool_claim`

```sql
CREATE TABLE volume_cover_pool_claim (
  id                  text PRIMARY KEY,
  pool_id             text NOT NULL REFERENCES volume_cover_pool(id),
  position_id         text NOT NULL UNIQUE REFERENCES volume_cover_position(id),
  contracts_btc       numeric NOT NULL,
  claim_cost_usdc     numeric NOT NULL,
  realized_proceeds_usdc numeric,
  status              text NOT NULL CHECK (status IN ('active','released_clean','released_triggered','released_force')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  released_at         timestamptz,
  release_reason      text
);
CREATE INDEX ON volume_cover_pool_claim(pool_id) WHERE status = 'active';
```

### 6.3 Extend: `volume_cover_position`

Add: `pool_id text NULL REFERENCES volume_cover_pool(id)` — NULL means dedicated legs (Phase 1/2 path).

### 6.4 Extend: `volume_cover_hedge_leg`

Add: `pool_id text NULL` — NULL means leg belongs to a single position (today's path); non-NULL means leg is owned by a pool.

### 6.5 Audit: `volume_cover_pool_event`

```sql
CREATE TABLE volume_cover_pool_event (
  id                serial PRIMARY KEY,
  pool_id           text NOT NULL REFERENCES volume_cover_pool(id),
  event_type        text NOT NULL,  -- 'state_change','rebalance','expand','contract','trigger_unwind','close'
  payload_jsonb     jsonb NOT NULL,
  occurred_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON volume_cover_pool_event(pool_id, occurred_at DESC);
```

---

## 7. Risk model — failure modes

| Risk | Impact | Mitigation |
|---|---|---|
| **Correlated trigger** (M positions trigger in same tick) | Pool reserve drained; pool sells legs into falling market | Hard reserve guard (§5.1); buffer multiplier 1.2-1.5; pool rejects new activations when reserve < concurrent payout |
| **Mid-rebalance venue outage** | Pool stuck holding expiring legs | Rebalance kicks off at T-24h not T-1h; if venue down, fallback to per-position emergency unwind path |
| **Strike drift** (BTC moves between cohort activations) | New positions get off-band strikes | Auto-rebalance at >0.3% spot change |
| **Pool ledger desync** (claim cost vs pool cost diverges) | Atticus P&L misreported | Daily reconciler diffs `sum(claim_cost)` vs `pool.cumulative_buy_usdc - cumulative_sell_usdc + mark_value`; alert on >1% drift |
| **First position over-pays** (pool buys legs sized for buffer, attributed to single position) | Position 1 sees high `claim_cost`, EV-negative on its own | Buffer cost amortized across cohort lifetime; first position gets a "founder" rebate when subsequent positions claim |
| **Last position under-recovers** (pool sells legs but last position's pro-rata share is small) | Last position sees low salvage even if leg sold well | Pool keeps minimum residual size; force-rebalance when active claims < 30% of contracts held |
| **Pin risk on short legs (Phase 2 spreads in pool)** | Assignment at expiry | Hard force-close at T-4h (rule 1, already in TP engine) |
| **Cohort capture by single large position** | One huge position dominates fractional shares; pool effectively still 1:1 | Per-cohort cap on individual claim share (e.g., max 40% of pool BTC) |

---

## 8. Capital efficiency math

Setup: cohort `2pct_3d_deribit`, hedge cost per dedicated position = $1,700 (current observed live).

### 8.1 Dedicated path (today)

```
gross_hedge_capital(N) = N × $1,700
```

### 8.2 Pooled path

Pool holds:
- Base: contracts to cover one position's required BTC = 1.4 BTC ($1,700)
- Buffer: `bufferMultiplier × N` for concurrent triggers — default 0.2 buffer
- Stress reserve: `1.5 × maxConcurrentPayout × $1k` (Atticus side, not in hedge book)

When N positions claim same pool:

```
pool_hedge_capital(N) = (1 + bufferMultiplier × log(1 + N)) × $1,700
                     ≈ $1,700 × (1 + 0.2 × log(1+N))
```

This is sub-linear because additional positions claim **fractional shares** of existing legs; pool only adds new legs when capacity is exceeded.

| N | Dedicated | Pooled | Savings |
|---|---|---|---|
| 1 | $1,700 | $1,700 | 0% |
| 2 | $3,400 | $1,800 | 47% |
| 5 | $8,500 | $2,510 | 70% |
| 10 | $17,000 | $3,520 | 79% |
| 20 | $34,000 | $4,820 | 86% |
| 50 | $85,000 | $7,440 | 91% |

(Approximation — actual values depend on tenor, rebalance cadence, and trigger correlation. See canvas for interactive calculator.)

### 8.3 Atticus reserve impact

Pooling does **not** reduce Atticus payout reserves — those scale linearly with concurrent positions because each position can independently trigger. The savings are entirely on the **hedge book** side.

```
total_capital(N) = pool_hedge_capital(N) + N × $1,000_payout_reserve × stress_mult
```

For N=10: $3,520 hedge + $15,000 reserve = $18,520 total (vs $32,000 dedicated total).

---

## 9. Migration path — coexistence with Phase 1/2

Pool and dedicated positions must coexist during migration. Strategy:

1. **Cohort opt-in**: `volume_cover_cell` gets a new flag `pool_eligible` (default false). Only flagged cells route activations to a pool.
2. **Cell variant per cohort mode**: e.g., `50k_2pct_1k` is dedicated (today), `50k_2pct_1k_pooled` is the pool-routed variant. Foxify chooses cellId.
3. **Schema bridge**: existing positions have `position.pool_id = NULL`, existing legs have `leg.pool_id = NULL`. Hedge manager checks `pool_id`:
   - NULL: today's per-position TP path
   - Non-NULL: pool-aware TP (defers to pool state machine)
4. **Gradual graduation**: enable `cohort_2pct_3d_deribit` first, then `5pct_5d_deribit`, etc.
5. **No forced migration**: dedicated cells remain available indefinitely; some operators may prefer the cleaner per-position accounting for high-conviction positions.

---

## 10. Future work (not in Phase 3 scope)

- **Cross-cohort delta netting**: book-level delta cap across all cohorts; allow some positions to under-hedge if other cohorts over-hedge in the offsetting direction
- **Variance-swap or vol-swap pool**: replace strangle pool with direct vol exposure; cheaper but less liquid
- **OTC RFQ for pool rebalances**: negotiate large rebalance orders with Deribit/Bullish OTC desks
- **Pool tokenization for revenue sharing**: external LPs can fund the pool and earn a slice of Atticus net hedge P&L
- **Multi-strike pool** (different cohorts share underlying ATM legs via portfolio margin)

---

## 11. Implementation phases (when greenlit)

1. **Phase 3.0 — design review** (this doc) ← we are here
2. **Phase 3.1 — schema migration + read-only pool ledger** (pure additive, no behavior change)
3. **Phase 3.2 — pool state machine in shadow** (one cohort, dry-run, no real fills)
4. **Phase 3.3 — pool execution in shadow** (real Deribit fills, $200 cap, 1 cohort, 5+ positions)
5. **Phase 3.4 — pool TP/rebalance in shadow** (full lifecycle, ≥30 days observation)
6. **Phase 3.5 — single cohort live** (production, smallest cell variant, gated by `PILOT_VC_POOL_ENABLED_COHORTS=cohort_2pct_3d_deribit`)
7. **Phase 3.6 — cohort-by-cohort expansion**

Estimated calendar: 4-6 months from greenlight to first live cohort, given hard prerequisites.

---

## 12. Open questions for review

1. **Cohort granularity**: is `(triggerPct, tenor, venue)` the right cohort key, or should we add `notional` band? E.g., a $200k_5pct position claiming pool sized for $50k_5pct positions — same strikes but very different contract count. Probably needs notional bucketing.
2. **Buffer multiplier calibration**: 1.2 default — should this be regime-aware (higher in elevated vol, lower in calm)?
3. **Pool revenue sharing**: today all positions share `atticus_hedge` pool ledger 1:1. Should pool-claim positions get a different premium discount since their hedge is cheaper?
4. **Trigger event ordering**: when M positions trigger in same tick, which gets the best fractional sale price? FIFO? Pro-rata of payout?
5. **Dedicated → pool conversion**: should an open dedicated position ever migrate into a pool? Probably no — too complex, just let dedicated ones run to close.
6. **Cohort sunset**: when a cohort has been inactive for 7d, do we auto-CLOSE or wait for operator? Auto-close means orphan capital release; manual is safer.

---

## 13. Sign-off checklist (before implementation begins)

- [ ] Operator review + sign-off on §1 goals + §7 risks
- [ ] Quant review + sign-off on §4 allocation math + §8 capital model
- [ ] Engineering review + sign-off on §6 schema + §9 migration
- [ ] Open questions in §12 resolved or explicitly deferred
- [ ] Phase 3 prerequisite gates listed in §1.3 confirmed met (or explicitly waived)
