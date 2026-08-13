# Atticus — Capital & Scaling Model

> **Audience:** investors, partners, and operators evaluating Atticus's capital
> efficiency and scale path.
> **Purpose:** show how working capital flows through the platform, how it
> compounds with operations, and how the Retail and Treasury products scale
> at different ratios.
> **Companion:** mechanics primer in `Atticus_How_It_Works.md`.
> **Last updated:** 2026-05-06

---

## 1. The capital question, framed

The question every prospective investor and partner asks variations of:

> *"How much capital does Atticus need at each scale, what does that capital
> actually do, and at what point does the platform fund itself from operating
> earnings?"*

This document answers each in turn. Numbers come from the Phase 0 D4 capital
requirements model, calibrated against Phase 0 D1 (hedge cost surface), Phase 0
D2 (recovery economics), and live pilot operating data.

---

## 2. What working capital does

Atticus's working capital sits in three economic buckets at any given time:

### 2.1 Hedge equity

The dollars locked at Deribit (and Falcon X) backing each open hedge. For a
14-day biweekly retail hedge, this is the upfront option premium, typically
$200–$500 per $10k of trader notional in calm markets.

This capital is **temporarily out** for the duration of the protection and
returns when:
- The hedge is sold via take-profit (after a trigger fires), or
- The hedge expires (worthless, with no recovery, in the no-trigger case)

In the trigger case, recovered hedge value typically exceeds the original
hedge cost (positive carry on the time-value capture). In the no-trigger
case, the hedge value reduces toward zero; the platform earned the trader's
subscription premium against that decay.

### 2.2 Payout reserve

A buffer covering the worst-case simultaneous trigger of all open positions
in any single day. Sized via the per-tier daily concentration cap (a structural
control limiting any one floor tier to 60% of daily new-protection notional).

For pilot configuration: **~$3k bounded worst-day exposure** under realistic
recovery assumptions. **~$15k worst-day** under zero-recovery (all triggers,
no recovered hedge value — extreme scenario).

### 2.3 Operational reserve

Slack above the deterministic exposure for: deposit timing lag, opportunistic
top-ups during stress windows, vol-spike buffer, fee buffer. Industry rule:
1.30× the deterministic floor.

---

## 3. Retail capital model

### 3.1 Per-trade capital footprint (current biweekly)

| Regime | Hedge equity (per $10k trader notional) | Operational reserve | Total per trade |
|---|---|---|---|
| Calm (DVOL 35–50) | ~$250 | ~$75 | **~$325** |
| Moderate (DVOL 50–65) | ~$330 | ~$100 | **~$430** |
| Elevated (DVOL 65–80) | ~$455 | ~$135 | **~$590** |
| Stress (DVOL >80) | ~$570 | ~$170 | **~$740** |

### 3.2 Capital → trades supported

Concrete checkpoints with realistic mix assumptions (60% calm / 30% moderate /
10% other):

| Working capital | Concurrent trades supported (calm) | Concurrent trades supported (any regime) | Phase |
|---|---|---|---|
| **$1,500** | 4 | 1 | Smoke test floor |
| **$5,000** | 13 | 6 | Phase 2 beta (3-trade run-rate) |
| **$10,000** | 27 | 13 | 5–8 trade run-rate w/ headroom |
| **$20,000** | 55 | 27 | 8–10 trade run-rate w/ ample headroom |
| **$40,000** | 110 | 54 | Foxify retail rollout target |
| **$70,000** | 192 | 95 | CEO's stated reference point |
| **$150,000** | 410 | 200 | Production scale |
| **$300,000** | 820 | 410 | $1M+/day notional comfortably |

These numbers do **not** include compounding from recovered hedge proceeds,
which is the next section.

### 3.3 Compounding from recovery flow

A triggered biweekly hedge typically recovers ~$610 per trade against a
~$471 hedge cost (Phase 0 D2 cohort mean). Settlement T+0 to T+4 days
depending on venue. **At pilot scale this means ~$140 of effective working
capital is added per triggered trade**, recycling into the next position
within 2–4 days of settlement.

At a balanced trigger rate of ~25% on the active biweekly book (mixed
across tiers), in a 30-day month:

| Trades opened | Triggers expected | Recovery flow | Net contribution to working capital |
|---|---|---|---|
| 30 | 7–8 | ~$4,800 | +~$1,000 net (after replacing hedge cost) |
| 100 | 25 | ~$15,250 | +~$3,500 net |
| 300 | 75 | ~$45,750 | +~$10,500 net |

**This is the self-funding mechanism.** Beyond a threshold of consistent
operations (typically ~30 trades / month), the platform's recovered hedge
flow plus subscription gross spread produces net positive working capital
contribution, allowing organic growth without external capital injection.

### 3.4 The $40k–$70k question (CEO reference scale)

Operating at $40k–$70k working capital with the proposed retail biweekly
ship configuration:

| Metric | $40k | $70k |
|---|---|---|
| Concurrent trades supported (any regime) | 54 | 95 |
| Realistic active book at typical mix | 5–8 trades | 8–12 trades |
| Daily new-protection notional supported | $50–80k/day | $100–150k/day |
| Expected gross spread (pilot mix) | ~$25–40/day | ~$50–75/day |
| Expected monthly gross spread | ~$750–1,200 | ~$1,500–2,250 |
| Recovery flow (monthly, ~25% trigger rate) | ~$3,500/mo recycled | ~$5,500/mo recycled |
| Cumulative monthly working capital growth | ~+$1,000 | ~+$1,800 |

**Doubling from $70k organically:** at ~+$1,800/month in net working capital
growth, doubling to $140k organically takes approximately 3–6 months
depending on regime mix and trigger geometry. **A pure compounding model
does not produce monthly doubling**; growth is steady but sub-linear in
unit time without external capital.

For monthly doubling at this scale, the platform either needs:
- An external capital injection (enabling jump-scale rather than compounding), or
- A cohort of large concurrent trades (e.g. a single $50k position per day
  produces ~10× the per-trade gross spread of a $5k position, accelerating
  the compounding rate proportionally)

The CEO's own usage pattern (large positions infrequently) accidentally
selects the second mode. With consistent $50k positions, the compounding
rate is faster than the standard pilot model assumes.

### 3.5 Scaling beyond retail to $1M/day notional

Working capital required: ~$200–300k per Phase 0 D4 plus operational reserve.
Expected daily gross spread at this scale (per CFO Report §8.1) is
~$2,500–3,000/day = **~$900k–$1.1M/year of gross margin** before treasury
contribution and before scaled hedge-pooling efficiency gains.

---

## 4. Treasury capital model

Treasury is structurally cheaper to operate per dollar of protected notional
because the protective collar (long put + short call) self-funds most of
the put cost via the call premium income.

### 4.1 Per-subscription capital footprint

Numbers assume calm-regime DVOL, 30-day tenor, before Falcon X institutional
pricing improvement.

| Treasury notional | Net collar cost (30d) | Working capital (1.30× headroom) |
|---|---|---|
| $250k (Scenario A) | ~$1,500 | **~$2,000** |
| $1M (Scenario B) | ~$5,000 | **~$6,500** |
| $5M (Scenario C) | ~$22,000 | **~$30,000** |
| $10M | ~$42,000 | **~$55,000** |

### 4.2 Treasury vs Retail capital efficiency

| | Retail $40k working cap | Treasury $40k working cap |
|---|---|---|
| Notional supported | ~$50–80k/day flow | ~$3M-equivalent in active subscriptions |
| Expected gross monthly spread | ~$750–1,200 | ~$25,000–30,000 |
| Capital efficiency ratio | 1× (baseline) | **~25–30×** |

This is the central economic difference. **Treasury produces ~25–30× the
gross spread per dollar of working capital** because:

1. The collar's call premium offsets most of the put cost
2. Treasury subscriptions are scheduled and large; retail is ad-hoc and small
3. Falcon X institutional pricing improves with cumulative volume

This does **not** mean retail is unprofitable — retail is profitable on its
own merit and serves a fundamentally different market (B2C trader-facing).
But for capital-allocation purposes, every marginal dollar of working capital
deployed at treasury produces materially more spread than the same dollar
deployed at retail.

### 4.3 Three concurrent treasuries — what it looks like

At three concurrent Scenario-B ($1M each, 2% floor, 30-day) subscriptions:

| Metric | Value |
|---|---|
| Working capital tied up | ~$20,000 |
| Aggregate protected notional | $3M |
| Expected monthly subscription revenue | ~$112,500 |
| Expected monthly hedge net cost | ~$15,000 |
| Expected monthly gross spread | **~$97,500** |
| Annualized run rate at this configuration | **~$1.17M** |

These are pre-fee, pre-cost numbers. At Atticus's stage the cost basis is
substantially below the gross spread — operational cost is engineering
salaries plus venue/connector overhead.

### 4.4 OTC volume flywheel

The Falcon X pricing curve improves as Atticus delivers cumulative volume.
A representative path:

| Cumulative Atticus monthly volume | Falcon X relative pricing improvement |
|---|---|
| $0–5M | Baseline (BD-quoted starting tier) |
| $5–25M | ~5–10% spread reduction |
| $25–100M | ~10–20% spread reduction |
| $100M+ | Institutional flat-rate tier |

This is **a moat that compounds**: the third treasury client benefits from
the volume the first two delivered, and so on. Retail volume contributes to
the same flywheel even though retail uses Deribit primary.

---

## 5. Scaling sequence

A realistic sequence-not-timeline for capital scaling:

```
Stage 0 — Pilot (current)
  ─ ~$1.5k Deribit balance + $5k operational reserve
  ─ 1 biweekly trade smoke test
  ─ Validates production code path live

Stage 1 — Small Scale ($5–10k working capital)
  ─ Phase 2 beta: 3-concurrent biweekly trades
  ─ First 5 clean trades unlock 3-trade-per-24h cap
  ─ Decision gates evaluated (tier mix, recovery rate, days-held)

Stage 2 — Pilot Scale ($20–50k working capital)
  ─ 5–8 concurrent biweekly trades
  ─ Foxify retail rollout to broader user base
  ─ Days-held data confirmed; pricing tuning decisions made
  ─ First treasury Scenario-A subscription opens (~$2k working capital marginal)

Stage 3 — Mid Scale ($100–200k working capital)
  ─ Retail at $200–500k/day notional
  ─ 1–3 active treasury subscriptions (Scenarios A/B)
  ─ Hedge inventory pooling activated; capital efficiency improves 25–40%
  ─ First Falcon X execution path live alongside Deribit

Stage 4 — Production ($300k+ working capital)
  ─ Retail at $1M+/day notional
  ─ 3+ active treasury subscriptions including Scenario-B/C
  ─ Net-pool / floor-laddering / calendar-roll all live
  ─ Multi-venue smart routing operational
```

Each stage is gated on the previous stage's data, not on calendar time.
The platform's design intent is that each stage produces enough operating
margin to bridge to the next stage's working capital without external injection.

External capital accelerates the bridge-time but is not strictly required.

---

## 6. Capital-loss scenarios — bounded

The investor question that matters: *"What's the worst case I lose?"*

### 6.1 Bounded worst-day at each scale

| Scale | Working capital | Realistic worst-day loss | Zero-recovery worst-day |
|---|---|---|---|
| Pilot | $5k | ~$300 | ~$1,500 |
| Beta | $20k | ~$800 | ~$3,000 |
| Pilot scale | $50k | ~$2,500 | ~$15,000 |
| Mid | $200k | ~$10,000 | ~$30,000 |
| Production | $300k | ~$15,000 | ~$50,000 |

These numbers come from the per-tier daily concentration cap × payout
ratio × probability of simultaneous trigger. The "realistic" column applies
the empirically measured ~68% recovery; the "zero-recovery" column models
the unprecedented worst case.

### 6.2 Recovery from worst-day

A worst-day loss is recovered in approximately:
- **Pilot:** 7–10 calm-market days at expected daily spread
- **Production:** 4–6 calm-market days at expected daily spread

The platform's design ensures **no single-day loss can exhaust working
capital at any scale.** This is enforced structurally by the cap layers,
the circuit breaker, and the auto-renew freeze in stress regimes.

### 6.3 Catastrophic-day scenarios (modeled)

The five most violent BTC drawdown days in modern history at full Day-8+
caps would have produced platform losses of approximately $6k–$22k
(2018-12-15, 2020-03-12, 2021-05-19, 2022-06-13, 2022-11-09). At any of
these scales, the loss is recoverable in 7–10 normal-market days at
expected daily spread.

These are **modeled losses against the bounded cap structure**; in practice,
the circuit breaker would have triggered and prevented a full-day exposure
to the back half of any of these moves.

---

## 7. Why the model is robust

### 7.1 What the bounded-loss invariant does NOT depend on

- Bitcoin's directional movement (we're hedged either way)
- Trader behavior (we're hedged regardless)
- Pilot adoption rate (we're capped regardless)
- Market regime (caps are absolute, not regime-conditional)

### 7.2 What it DOES depend on

- **Venue solvency:** Deribit and Falcon X must remain operational. We
  diversify with Falcon X as a second venue specifically to reduce single-
  point-of-failure exposure.
- **Cap enforcement integrity:** the per-tier caps, hedge budget caps, and
  circuit breaker must function correctly. These are continuously tested.
- **Hedge selector correctness:** the selector must pick a strike with
  enough intrinsic value to cover the protection. Verified per-trade.

These dependencies are operational hygiene, not financial bets. The same
hygiene every options market-maker maintains.

---

## 8. Headline numbers for partner discussions

For quick reference in partner conversations:

| Question | Answer |
|---|---|
| Minimum capital to run live | ~$1,500 (Deribit smoke test) |
| Capital for 5-trade run-rate | ~$5,000 working + $5,000 reserve |
| Capital for $1M/day retail | ~$200–300k working + reserve |
| Capital for $1M treasury subscription | ~$6,500 working + reserve |
| Worst single-day loss at pilot | ~$3k (realistic) / $15k (zero-recovery extreme) |
| Worst single-day loss at $1M/day retail | ~$10k (realistic) / $30k (zero-recovery extreme) |
| Annualized gross margin at $1M/day | ~$900k–1.1M before treasury contribution |
| Treasury capital efficiency vs retail | ~25–30× gross spread per dollar |
| Time to recover worst-day loss | 7–10 calm-market days |

---

## 9. What this model does not yet capture

In the spirit of honesty:

- **Hedge inventory pooling impact** — when activated post-pilot, this
  reduces fresh hedge buys ~25–40%, materially improving capital efficiency
  numbers across all stages. Not yet baked in.
- **OTC pricing improvement curve** — the volume flywheel produces real
  improvement that compounds over time. Modeled at "baseline" pricing here.
- **Retail/treasury cross-pollination** — both feed Falcon X volume.
  Treasury volume in particular accelerates pricing improvement that
  benefits retail. Modeled in isolation here.
- **Live cohort behavior** — pilot data is fewer than 50 trades. Live
  trader behavior may diverge from backtest assumptions; we monitor and
  adjust pricing accordingly.

These are reasons the model is **conservative**. We expect realized
performance to exceed these numbers in scaled operations.

---

*End of Atticus — Capital & Scaling Model.*
