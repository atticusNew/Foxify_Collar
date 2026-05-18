# Treasury Platform Spec — Atticus Bitcoin Treasury Protection

> **Status:** ready-to-execute spec. No implementation in this doc.
> **Scope:** Treasury B2B structured protection, distinct from Retail. The Retail
> platform is specified at `docs/platforms/retail_platform_spec.md`.
> **Last updated:** 2026-05-06

---

## 1. Why this is a different product

Retail and treasury share *some* infrastructure (Deribit/Falcon X connectors,
DB layer, monitoring) but differ in every economically meaningful dimension.
Mixing them under one product config produces mediocre economics for both.

| Dimension | Retail | **Treasury** |
|---|---|---|
| Buyer | Foxify trader hedging an open perp | Corporate / DAO / fund hedging spot inventory |
| Notional cadence | Random, per-trade | **Scheduled, programmatic** |
| Notional size | $1k–$50k | **$250k–$10M** |
| Direction | LONG and SHORT | **LONG only** (downside protection on inventory) |
| Floor tiers | 2/3/5/10% | **2/3/5%** (treasuries don't buy disaster strikes) |
| Time pattern | Open at any time, often clustered around vol | **Always-on or scheduled windows** |
| Toxicity | Medium-high (informed trader entry timing) | **Very low** (mechanical, no information edge) |
| Settlement | Instant on trigger (T+0) | **T+1 settlement window** |
| Hedging strategy | Per-trade puts/calls, optional pooling | **Collar (long put + short call), with calendar rolls** |
| Pricing | $2.50/$1k/day flat | **$1.25–$1.75/$1k/day** (lower because lower toxicity + collar offsets) |
| Capital ask of platform | Float + Deribit equity | **Net-zero capital at limit** (collar fully funded by call premium) |
| Primary venue | Deribit | **Deribit + Falcon X OTC** for size |

The defining principle: **treasury is a structured-finance product (collar), not
an insurance product**. It uses techniques that have been standard in TradFi for
decades but are essentially absent from DeFi-native treasury management. The
Atticus edge is operating that structure with on-chain transparency and Falcon X
desk pricing, both of which compound with volume.

---

## 2. Three scenarios (placeholder until CEO confirms Q2)

The spec is written to support three notional scenarios. The actual treasury
client will fall into one of these; rate tables, capital math, and operational
cadence parameterize on the scenario.

### Scenario A — Small Treasury ($250k notional, exploration)

| Property | Value |
|---|---|
| Protected notional | $250k |
| Subscription tenor | 30-day, max 90d with weekly roll option |
| Floor | 2% |
| Direction | LONG |
| Daily rate (proposed) | **$1.50/$1k/day** = $375/day = ~$11.3k/month |
| Annual cost to client | ~$135k |
| Hedge strategy | Collar: 30d put @ −2% + short 30d call @ +2% |
| Net hedge cost (calm) | ~$0.40/$1k/day after call premium offset |
| Platform gross margin | ~$1.10/$1k/day = ~$8.3k/month |

### Scenario B — Mid Treasury ($1M notional, the CEO's stated reference)

| Property | Value |
|---|---|
| Protected notional | $1M |
| Subscription tenor | 30-day, max 90d with weekly roll |
| Floor | 2% |
| Direction | LONG |
| Daily rate (proposed) | **$1.25/$1k/day** = $1,250/day = ~$37.5k/month |
| Annual cost to client | ~$450k |
| Hedge strategy | Collar: 30d put @ −2% + short 30d call @ +2% |
| Net hedge cost (calm, Falcon X pricing) | ~$0.30/$1k/day after call premium offset |
| Platform gross margin | ~$0.95/$1k/day = ~$28.5k/month |
| Backtest reference | +$1.2M settlement vs −$1.9M unprotected on any 12-month window of last 4 years |

### Scenario C — Large Treasury ($5M+ notional, production target)

| Property | Value |
|---|---|
| Protected notional | $5M |
| Subscription tenor | 30-day, max 90d with weekly roll |
| Floor | 2% (potentially 3% blend) |
| Direction | LONG |
| Daily rate (proposed) | **$1.00/$1k/day** = $5,000/day = ~$150k/month |
| Annual cost to client | ~$1.8M |
| Hedge strategy | Collar via Falcon X primary, Deribit backstop |
| Net hedge cost | ~$0.20/$1k/day after call premium offset (institutional Falcon X pricing) |
| Platform gross margin | ~$0.80/$1k/day = ~$120k/month |

**Volume → pricing relationship:** the more reliable structured volume Atticus
delivers to Falcon X, the better the executed pricing. This is the institutional
moat that compounds — Scenario C's $0.20/$1k/day net is achievable *because*
of cumulative Atticus volume across treasury clients, not in isolation.

---

## 3. The collar — economics primer

Treasury hedging uses a **protective collar**: long put + short call with strikes
equidistant around spot. The math:

```
Net hedge cost = Put premium (we pay) − Call premium (we receive)
```

For BTC at $75k, 30-day tenor, DVOL ~50:

| Leg | Strike | Premium per $1k | Direction (Atticus) |
|---|---|---|---|
| Long put | $73.5k (−2% floor) | ~$25 | We BUY (we pay) |
| Short call | $76.5k (+2% cap) | ~$23 | We SELL (we receive) |
| **Net** | | **~$2/$1k/30d** | We pay |

**Per day per $1k:** ~$0.07 net cost vs $1.25 trader subscription rate. The
arbitrage is between what the treasury pays (subscription cost predictability)
and the underlying collar net cost (mechanical structured finance).

The trade-off the treasury accepts: **upside capped at +2%** for the protection
period. For a treasury that holds inventory and isn't trying to time markets
(by definition), this is acceptable. Most treasury operators *want* upside cap
because it disciplines their balance sheet against unrealized-gains volatility.

### 3.1 What can go wrong (collar)

| Failure mode | Mitigation |
|---|---|
| BTC rallies past upper strike → call assigned, treasury obligated to deliver | Cap notional to inventory; never sell calls beyond owned BTC |
| BTC drops below lower strike → put pays | This is the design — payout flows to treasury per subscription terms |
| Both legs expire OTM → small net cost realized | Expected outcome ~70% of months historically |
| Implied vol explodes mid-position → call can be marked against us heavily | T+1 settlement plus 30-day roll cadence absorbs single-day vol spikes |
| Falcon X pricing dislocates from Deribit | Backup execution on Deribit; price-feed sanity check required |

### 3.2 Calendar rolls (Phase 2 enhancement)

After 7 days the collar's residual time-value can be rolled to a fresh 30d
position, capturing theta on both legs. This is standard treasury practice and
is the natural Phase 2 of the product. **Not in the v1 ship; documented for
future activation.**

---

## 4. Pricing model

Treasury subscription pricing differs from retail in two structural ways:

1. **Lower base rate** — toxicity discount. Retail traders may be informed
   buyers; treasuries are mechanical. Same insurance principle as auto insurance
   pricing on driving record.
2. **Volume tiers** — larger notional gets better pricing because Falcon X
   execution improves with size.

| Notional band | 2% floor | 3% floor | 5% floor |
|---|---|---|---|
| $250k–$999k | $1.50/$1k/day | $1.25/$1k/day | $0.75/$1k/day |
| $1M–$4.99M | $1.25/$1k/day | $1.00/$1k/day | $0.60/$1k/day |
| $5M+ | $1.00/$1k/day | $0.85/$1k/day | $0.50/$1k/day |

These rates are **flat across volatility regimes** (initial design principle —
predictability over revenue optimization for the structured product). Regime
stepping can be reintroduced in v2 once we have ≥6 months of treasury data.

**Lock duration:** rate locks for full subscription tenor at activation. No
mid-period rate change. If the treasury rolls to a new 30-day position, the
new period is repriced at then-current rate.

**Contract minimum:** 30 days (subscription floor; unlike retail's 1-day min).
Reflects the cost structure — collar setup is a one-time operational cost we
amortize across the period.

---

## 5. Operational cadence

### 5.1 Subscription lifecycle

```
Day 0: Treasury client signs subscription, locks notional + floor + tenor
Day 0+1h: Atticus opens collar (long put + short call) via Falcon X primary
Day 1–29: Daily mark-to-market; weekly status report to treasury
Day 7, 14, 21: Roll-evaluation checkpoints (Phase 2; v1 holds to expiry)
Day 30 OR trigger: Position closes; settlement window opens
Day 31: T+1 settlement complete
```

### 5.2 Settlement timing

Treasury settles **T+1** rather than T+0. This is structurally important:

- Gives platform 24h to execute optimal Deribit/Falcon X unwind (instead of
  forcing immediate spread-cost capture as retail does).
- Aligns with treasury operations (payment runs are typically EOD batch).
- Per D2 modeling, T+1 unwind captures 15–25% more value than T+0 forced.

Settlement instructions: USD wire / USDC on-chain / BTC on-chain — client picks
at subscription time. No mid-period changes.

### 5.3 Trigger handling under collar

A collar trigger is asymmetric: the **put** is what triggers the payout to the
treasury. The **call** position remains open. Two cases:

| BTC spot at trigger | Put | Call | Action |
|---|---|---|---|
| Below put strike (<−2%) | ITM, pays out | OTM, expires worthless | Pay treasury, close put, hold/expire call |
| Above call strike (>+2%) | OTM | ITM, owes counterparty | Treasury delivers call obligation; platform-side breakeven |
| Between strikes | OTM | OTM | Both expire; small net cost realized |

**Asymmetric payouts** are the entire point of the collar — treasury wants
downside protected, accepts capped upside. The platform's job is to operate
the collar mechanics correctly.

---

## 6. Risk controls (treasury-specific)

| Control | Setting | Rationale |
|---|---|---|
| Aggregate notional cap | $10M (initial) | Limit Atticus exposure; scales with capital |
| Single-treasury concentration cap | 60% of aggregate | Diversification across treasury clients |
| Roll concentration cap | No more than 50% of book rolling on any single day | Avoid rolling everything into a vol spike |
| Falcon X counterparty exposure cap | $5M cumulative open positions | OTC counterparty risk |
| Deribit backup execution cap | $2M (existing pilot infrastructure) | Backstop liquidity if Falcon X lags |
| Circuit breaker | 30% drawdown / 30 days (slower than retail) | Treasury slower-moving than retail |

The retail per-tier daily concentration cap does **not** apply — treasury is
single-floor, single-direction, scheduled.

---

## 7. Capital model

Treasury is materially less capital-intensive than retail because the collar
self-funds the put through the call premium.

### 7.1 Per-scenario capital requirement (working capital)

Numbers assume calm-regime DVOL and 1.30× headroom.

| Scenario | Notional | Working capital required | Reasoning |
|---|---|---|---|
| A: $250k | $250k | **~$2k–$3k** | Net collar cost × headroom; tiny |
| B: $1M | $1M | **~$5k–$8k** | Collar net cost ~$2/$1k × 30d × notional |
| C: $5M | $5M | **~$20k–$35k** | Falcon X institutional pricing further reduces |

**Compared to retail** ($40k working capital supports 5–8 concurrent biweekly
trades at $10k notional = $50–80k aggregate), treasury produces ~10× the
notional coverage per dollar of working capital. **This is the central reason
treasury is the more attractive product economically.**

### 7.2 Funding flow

Subscription invoiced monthly in advance. Working capital cushions the period
between invoice and any trigger payout (T+1 settlement gives 24h to deploy
recovered call premium toward put-payout obligation).

### 7.3 What capital does NOT need to cover

- Trigger payouts beyond the put leg's intrinsic value — the put is bought
  *for* the payout obligation. Atticus is a pass-through, not a balance-sheet
  underwriter.
- Call assignment — bounded by capped upside in the collar geometry.
- Counterparty failure — Deribit / Falcon X are the counterparties, not Atticus.

---

## 8. Ops / API surface

### 8.1 Existing skeleton

The `services/api/src/pilot/treasury*` modules contain a working skeleton:

| Module | State | Activation gate |
|---|---|---|
| `treasuryConfig.ts` | Env-driven config, env-flagged off via `TREASURY_ENABLED=false` | Flip env on |
| `treasuryDb.ts` | Schema migrated | Already migrated |
| `treasuryRoutes.ts` | API endpoints stubbed | Activate alongside config flip |
| `treasuryScheduler.ts` | Cron-style scheduled execution | Activate at 09:00 UTC daily check |
| `services/hedging/src/collarBuilder.ts` | Collar primitive exists | Wire into treasury activate path |

### 8.2 Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /pilot/treasury/subscribe` | Create treasury subscription — notional, floor, tenor, settlement instructions |
| `POST /pilot/treasury/:id/close` | Early close (rare; subscription minimum applies) |
| `GET /pilot/treasury/:id/status` | Current collar geometry, mark-to-market, days remaining |
| `GET /pilot/treasury/:id/statement` | Monthly settlement statement (CSV/PDF) |
| Admin endpoints | Subscription list, collar inventory, P&L roll-up |

### 8.3 Background workers

| Worker | Cadence | Purpose |
|---|---|---|
| Treasury scheduler | Daily 09:00 UTC | Open new subscriptions per pre-scheduled queue |
| Collar manager | Hourly | Mark-to-market, prepare statements, alert on drift |
| Trigger monitor (treasury variant) | 60s | Same logic as retail but T+1 settlement |
| Roll evaluator (Phase 2) | Daily | Calendar-roll opportunity detection |
| Falcon X reconciliation | Hourly | Position reconciliation against `GET /v1/derivatives` |

---

## 9. Validation plan

### 9.1 Pre-launch checklist

Treasury launches in three phases, each with explicit gating:

#### Phase 1 — Internal shadow

- Activate `TREASURY_ENABLED=true` in non-production environment
- Run scheduler in shadow mode (compute collar opens, log, but do not execute)
- 2-week shadow window minimum
- Verify Falcon X RFQ flow on test environment
- Reconcile shadow logs against live Deribit prices

#### Phase 2 — Single small treasury (Scenario A or B)

- Live Falcon X / Deribit execution
- Single client, $250k–$1M notional
- 30-day initial subscription
- Daily reconciliation, weekly client report
- Decision gate after first 30-day subscription completes

#### Phase 3 — Multi-client scale

- 3+ active treasury subscriptions
- Calendar roll evaluator activated
- Falcon X primary, Deribit backup
- Aggregate cap raised in steps as confidence accumulates

### 9.2 Per-subscription monitoring

| Metric | Target | Action if breached |
|---|---|---|
| Daily mark-to-market drift vs entry | ±5% net of theta | Investigate; consider unwind if >10% adverse |
| Collar leg correlation | Put delta + call delta ≈ 1 | Re-strike if drift >0.15 |
| Falcon X execution slippage | <1.5% vs Deribit reference | Switch to Deribit backup if sustained |
| Roll execution timing | Within 1h of scheduled window | Operational alert |

---

## 10. Production-ready ship checklist

A treasury platform is **production ready** when all of the following are true.

### 10.1 Code

- [ ] `TREASURY_ENABLED` flag honored across all treasury modules
- [ ] Treasury pricing module separate from biweekly: per-tier × per-notional-band table
- [ ] Collar builder wired into treasury activate path (not single-leg)
- [ ] T+1 settlement window implemented (separate from retail T+0)
- [ ] Falcon X connector implements buy-RFQ + sell-RFQ + position reconciliation
- [ ] Treasury circuit breaker (30% / 30d) distinct from retail's
- [ ] Aggregate notional cap, single-treasury cap, roll concentration cap enforced
- [ ] No new TS errors against baseline
- [ ] Unit tests: subscription lifecycle, collar pricing, T+1 settlement, roll evaluator

### 10.2 Configuration

- [ ] `TREASURY_ENABLED=false` default; flippable per-environment
- [ ] `FALCONX_*` credentials present in production env
- [ ] `TREASURY_VENUE=deribit|falconx` configurable
- [ ] `TREASURY_AGGREGATE_CAP_USD` set with current capital model
- [ ] `TREASURY_CHECK_INTERVAL_MS` matches scheduler design
- [ ] Treasury admin token distinct from retail

### 10.3 Operational

- [ ] Falcon X BD relationship confirmed: KYC, account funded, sell-side RFQ confirmed working
- [ ] Settlement instructions per client documented and signature-locked
- [ ] Monthly statement generator tested end-to-end
- [ ] Reconciliation cron runs and alerts on mismatch
- [ ] Manual unwind runbook documented (every collar can be force-unwound by ops)
- [ ] Phase 1 shadow week complete with no anomalies

### 10.4 Documentation

- [ ] Client onboarding doc (legal/KYC requirements per client jurisdiction)
- [ ] Treasury SLA: response times, statement cadence, support contacts
- [ ] Roll-evaluation runbook (Phase 2)
- [ ] Falcon X failover runbook (Deribit backup activation)

### 10.5 Validation

- [ ] Phase 1 shadow data reviewed by engineering + finance
- [ ] First Scenario-A or Scenario-B subscription completed and reconciled
- [ ] Net P&L on first subscription within 15% of modeled expectation

---

## 11. Falcon X integration — already adapter-ready

Per `docs/integrations/falconx.md`, the Falcon X OTC adapter is documented and
ready to wire. Open BD-side items remaining (per the doc's section 12):

- Confirm sell-side RFQ via `/v3/derivatives/option/quote` with `side: "sell"`
- Minimum quantity on sell-side RFQs (treasury unwinds typically 10+ BTC)
- Quote validity window
- 30DTE, 90DTE option liquidity confirmation
- Rate limits (treasury typically <5 RFQs/day; well below retail volume)

These are conversations with the Falcon X BD team, not engineering blockers.

**Deribit remains primary for v1.** Falcon X activates in Phase 2 once BD items
close. The architecture supports both with venue-routing decisions made at
quote time based on size + tenor.

---

## 12. Why this product compounds

The treasury platform has three structural advantages over retail that make it
the more attractive long-term Atticus business:

1. **Capital efficiency** — collar net cost is ~10–20% of single-leg put cost.
   Same dollar of working capital backs 5–10× more notional.
2. **Falcon X pricing curve** — institutional desk pricing improves with our
   cumulative volume. This is a flywheel: more treasury clients → better Falcon X
   pricing → tighter spreads on retail too.
3. **Toxicity profile** — scheduled mechanical flow has near-zero adverse
   selection. Retail has medium-high. Treasury earnings are more predictable
   per dollar than retail earnings per dollar.

Combined with the fact that the technique itself (protective collar) is
TradFi-standard but DeFi-rare, treasury is **structurally underpriced in the
current market** and Atticus has a meaningful first-mover window.

---

## 13. Out of scope for v1

- Synthetic collar variants (zero-cost collar with mismatched strikes)
- Multi-leg butterflies / iron condors (over-engineered for treasury demand)
- Cross-asset treasury hedging (BTC-only initially)
- Real-time NAV reporting (monthly statement is the v1 deliverable)
- Treasury client self-serve dashboard (admin-managed initially)

---

*End of Treasury Platform Spec.*
