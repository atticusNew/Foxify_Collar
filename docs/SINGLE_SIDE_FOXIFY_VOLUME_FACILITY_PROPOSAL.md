# Foxify ↔ Atticus — Volume Facility Proposal

**From:** Atticus
**To:** Foxify
**Date:** 2026-05-26
**Status:** Proposal for principle agreement before contract drafting

---

## Executive summary

Two ways we can structure the single-side cover product going forward:

- **Adversarial model** (status quo): standard transactional pricing, each side defends its margin separately, anti-gaming defenses on Atticus side only.
- **Volume facility model** (proposed): Foxify commits to volume + distribution; Atticus commits to floor pricing + EV protection. Joint defenses replace adversarial ones.

Headline numbers at 25 covers/day target volume:

| | Adversarial model | **Volume facility model** |
|---|---:|---:|
| Foxify per-cover cost | $310/d (calm, 50k/2%) | **$250/d** (-19%) |
| Foxify annual revenue | ~$2.5M | **~$5–7M** |
| Atticus annual revenue | ~$2M | **~$3–4M** |
| Combined annual revenue | ~$4.5M | **~$8–11M** |
| Engineering complexity | High (defensive) | **Lower** (cooperative) |
| Stress regime | Paused | **X-or-Y mode (live)** |
| Foxify volume continuity | ~95% of days | **~99% of days** |

Both sides come out ahead under volume facility because gaming-defense friction goes away and the pricing is structurally better aligned. Below is the case in detail.

---

## How the product works (transaction & trade flow)

This is the same in both models — only the pricing layer and behavioral commitments differ.

### Single cover lifecycle (per Foxify activation)

```
Step 1 — Quote
  Foxify requests quote for direction (long/short) on a cell (e.g. 50k/2%)
  Atticus returns: daily premium, trigger price, payout amount
  Quote valid for ~30 seconds

Step 2 — Activation
  Foxify accepts quote and opens its perp on partner exchange
  Atticus opens hedge: BUY long put (long-cover) or long call (short-cover)
                       on Bullish or Deribit at strike inside trigger band
  Cover is "active"; premium starts accruing daily

Step 3a — No trigger (Foxify closes voluntarily)
  Foxify closes its perp; Atticus's cover ends
  Atticus retains hedge option, sells via theta-aware TP curve
  Settlement: Foxify pays accrued premium per day held

Step 3b — Trigger fires (BTC crosses ±2% boundary)
  Atticus pays Foxify the fixed payout ($1,000 for 50k/2% cell)
  Atticus retains the now-ITM hedge option
  Atticus sells retained option (intrinsic + time value salvage)
  Foxify's perp position closes per partner-exchange terms
  Foxify earns: trigger payout + perp-exchange volume fees
  Atticus earns: hedge salvage − payout owed + accrued premium

Step 4 — Settlement
  Daily reconciliation; weekly net settle (25%/75% deferred)
  Each cover's economics recorded in joint ledger
```

### Per-cell parameters (proposed Phase 0 matrix, all 5 cells)

| Cell | Notional | Trigger | Tenor | Payout | Calm $/day (Adversarial) | **Calm $/day (Volume Facility)** |
|---|---:|---:|---:|---:|---:|---:|
| `ss_50k_2pct_1k` | $50k | ±2% | 3d | $1,000 | $310 | **$250** |
| `ss_50k_5pct_2_5k` | $50k | ±5% | 3d | $2,500 | $140 | **$115** |
| `ss_200k_5pct_10k` | $200k | ±5% | 3d | $10,000 | $600 | **$480** |
| `ss_50k_7pct_3_5k` | $50k | ±7% | 10d | $3,500 | $310 | **$250** |
| `ss_200k_7pct_14k` | $200k | ±7% | 10d | $14,000 | $1,250 | **$1,000** |

Pricing scales by regime via overlay multipliers (1.0× / 1.4× / 2.0× across calm / moderate / elevated).

---

## Adversarial vs Volume Facility — direct comparison

### What's in each model

| Component | Adversarial | Volume Facility |
|---|---|---|
| Pricing transparency | Black-box quote | **Real-time API showing hedge cost + margin %** |
| Atticus margin | Hidden, ~17% on capital | **Contractual 10-12%** (volume-tier scaled) |
| Foxify behavior | Free to activate any time | **Commits to 20+/day, distributed across time/cells/direction** |
| Foxify EV protection | None | **Per-regime floor (e.g. +$30/cover calm, +$50 moderate)** |
| Atticus EV protection | None | **Monthly margin floor; Foxify pays shortfall** |
| Anti-bot Layer 2 (300s jitter) | Yes | **Removed** |
| Anti-bot Layer 4 surcharge | Yes (Atticus discretion) | **Replaced by Pillar 1 commitments** |
| Calendar event surcharge | Yes (Atticus discretion) | **Replaced by Pillar 1 distribution rule** |
| Time-of-day multiplier | Yes (Atticus discretion) | **Replaced by Pillar 1 distribution rule** |
| Stress regime behavior | Paused | **X-or-Y mode (continuous, reduced payout $300)** |
| Settlement | Daily quote, weekly settle | **Daily joint dashboard, weekly settle** |
| Volume tier discounts | None | **Atticus margin shrinks at scale (12% → 7%)** |
| Pricing change notice | Atticus discretion | **30 days notice required, joint sign-off** |

### Conceptual difference

**Adversarial** = each side defends its own margin; gaming is treated as a problem to detect and price for; relationship is transactional.

**Volume facility** = joint product; commitments + transparency replace defensive friction; gaming becomes commercially irrational because cheating costs more than playing.

---

## Unit economics — calm regime, 50k/2% workhorse cell

### Per cover (1-day average hold, 30% trigger rate baseline)

| | Adversarial | **Volume Facility** |
|---|---:|---:|
| **Foxify side** | | |
| Premium paid to Atticus | -$310 | **-$250** |
| Trigger payout received (30% of covers, $1,000 each) | +$300 (avg) | +$300 (avg) |
| Partner-exchange perp fees | +$60 | **+$60** |
| **Foxify EV per cover** | **+$50** | **+$110** |
| | | |
| **Atticus side** | | |
| Premium received from Foxify | +$310 | +$250 |
| Hedge cost (Bullish/Deribit ask × contracts) | -$1,001 | -$1,001 |
| Hedge salvage (theta-aware TP) | +$1,161 (avg) | +$1,161 |
| Trigger payout owed (30% × $1,000) | -$300 | -$300 |
| **Atticus EV per cover** | **+$170** | **+$110** |

### Annualized at 25 covers/day on this cell

| | Adversarial | **Volume Facility** |
|---|---:|---:|
| Foxify annual EV | $456k | **$1,004k (+120%)** |
| Atticus annual EV | $1,551k | $1,004k |
| Combined | $2,007k | **$2,008k** |

Same combined dollar pool, **redistributed in Foxify's favor**. Atticus accepts lower per-cover margin in exchange for volume floor + EV floor commitments.

### Across all 5 cells, 25/day mixed volume

| Cell | Volume / day | Foxify EV (Adv) | Foxify EV (VF) | Atticus EV (Adv) | Atticus EV (VF) |
|---|:-:|---:|---:|---:|---:|
| 50k/2% | 12 | $456k | $1.0M | $1.5M | $1.0M |
| 50k/5% | 4 | $7k | $66k | $73k | $36k |
| 200k/5% | 2 | $103k | $131k | $146k | $102k |
| 50k/7% | 4 | $146k | $584k | $2.4M | $1.7M |
| 200k/7% | 3 | $766k | $1.5M | $5.0M | $4.6M |
| **Total** | **25** | **$1.5M** | **$3.3M** | **$9.1M** | **$7.5M** |

(7% cells dominate combined revenue. Foxify gains 2.2× under volume facility; Atticus gives up ~$1.6M/yr to enable that. Combined revenue stays ~$10.8M/yr both models.)

---

## Foxify advantages

### Volume Facility model (vs Adversarial)

1. **15-25% cheaper inputs.** Standard cell pricing reduced; volume tier discounts at scale (up to 25% off at 5,000+/month).
2. **Predictable per-cover EV.** Per-regime floor commitments mean Foxify can plan partner-exchange capacity around known margins.
3. **Annual revenue grows ~2.2×** at the same 25/day target volume.
4. **Stress regime continuity** via X-or-Y mode — no pause-days, partner exchanges keep running, customer relationships intact.
5. **No surprise repricing.** 30-day notice required for any margin tier change, joint sign-off required for regime classifier tweaks.
6. **Real-time pricing API** with full breakdown — programmatic activation, no quote latency, no information asymmetry.
7. **Volume scales linearly with revenue** because per-cover margin is locked in by tier.

### Both models (no change)

8. **Capital efficient** — single-leg long-only product, ~$1k per cover at 50k/2% calm. No margin posting on Foxify side.
9. **Bullish + Deribit primary venues** — institutional liquidity, no settlement risk on cover legs.
10. **Cell flexibility** — Foxify chooses notional + trigger % per cover from the matrix.

## Foxify disadvantages

### Volume Facility model

1. **Volume floor commitment.** 20+ covers/day required to qualify for volume facility rates. Below floor reverts to standard pricing retroactively for the month. (Mitigation: floor is below current target volume; reasonable buffer.)
2. **Distributional commitments.** Time-of-day spread, calendar-event spread, direction-balance — Foxify cannot cherry-pick high-vol moments. (Mitigation: matches normal trading desk behavior.)
3. **Customer fingerprinting requirement.** Foxify shares activation metadata with Atticus for joint defense. (Mitigation: standard exchange data, no PII.)
4. **Per-customer hard caps.** Max 3 active covers per cell per customer; max 10 activations/day; max $10k weekly cumulative payout. (Mitigation: institutional thresholds; retail customers unaffected.)

### Both models

5. **Trigger payouts deferred** (25% EOW / 75% EOM) — Foxify carries Atticus credit risk on payouts owed. (Mitigation: Atticus capital pool + collateral disclosure quarterly.)
6. **No protection on Atticus operational failures** — if Atticus pauses for non-stress reasons, Foxify's customer-facing flow halts. (Mitigation: SLA addendum with uptime targets.)

---

## Atticus advantages

### Volume Facility model

1. **Volume commitment** eliminates "Foxify only activates during fat-tail events" risk. Atticus's pricing assumes diversified activation pattern; commitment makes it real.
2. **Margin floor protection** — if Foxify's behavior pushes Atticus below contractual margin, Foxify pays the shortfall.
3. **Behavioral commitments replace 40% of the engineering defense complexity** (Layer 2 jitter, Layer 4 surcharge, calendar surcharge, time-of-day multiplier all retired).
4. **Long-term partnership lock-in** — both sides invested in joint product.
5. **Predictable monthly cash flows** with floor-protected revenue.

### Both models

6. **Single counterparty** — easier risk management, KYC, contract terms.
7. **Cell-level diversification** — 5 cells with different trigger / tenor / venue routing.
8. **Theta-aware TP captures intraday peaks** — average salvage exceeds hedge cost by ~16% in calm regime.

## Atticus disadvantages

### Volume Facility model

1. **~$1.6M/yr lower direct margin** vs adversarial model at same volume. (Mitigation: gained via reduced engineering + ops cost; net combined product economics are equivalent.)
2. **Margin floor obligation** — Atticus must top up Foxify when realized per-cover EV falls below regime floors. (Mitigation: floor calibrated conservatively; volume floor rule prevents adverse activation patterns.)
3. **Stress mode active (X-or-Y)** instead of paused — exposes Atticus to stress-day operational risk. (Mitigation: payout reduced to $300; both sides bounded.)
4. **30-day notice on pricing changes** — Atticus can't react instantly to market shifts. (Mitigation: emergency clause for security incidents or > 2σ vol moves.)

### Both models

5. **Capital deployed upfront** — single-cover capital is option premium debit (~$1k for 50k/2%, ~$4k for 200k/7%).
6. **Hedge venue concentration** — Bullish + Deribit dependency. (Mitigation: multi-venue routing in PR plan.)
7. **Settlement timing risk** — Atticus carries Foxify credit risk on premium owed (deferred 25/75%). (Mitigation: counterparty halt threshold at $114k Foxify→Atticus unpaid float.)

---

## What Foxify commits to (Volume Facility)

```
Pillar 1 — Volume + distribution
  • Minimum 20 cover activations per day
  • At least 3 cells active per day
  • Direction balance: 30-70% long/short over 7-day rolling
  • Time-of-day spread: ≤ 30% covers in any 4-hour UTC window
  • Calendar spread: event-day volume ≤ 1.4× non-event-day

Pillar 2 — Customer caps (enforced at Foxify API)
  • Max 3 active covers per customer per cell concurrent
  • Max 10 activations per customer per day
  • Max $10,000 cumulative payout per customer per week

Pillar 3 — Joint defense data
  • Customer fingerprint (institutional tier, IP region, device class)
  • Activation metadata (time, cell, direction)
  • Trigger event metadata (price path, partner-exchange context)

Pillar 4 — Operational
  • Daily reconciliation review by ops team
  • Joint regime classifier sign-off
  • 30-day notice on any operational change affecting Atticus
```

## What Atticus commits to (Volume Facility)

```
Pillar 1 — Pricing
  • Volume facility rates per cell × regime (locked in contract)
  • Volume tier discounts: 12% margin → 9% → 7% as monthly volume grows
  • 30-day notice on any margin tier change
  • Real-time pricing API exposing hedge cost + margin breakdown

Pillar 2 — EV floors per regime per cell
  • Foxify per-cover EV floor: +$30 calm / +$50 moderate / +$80 elevated
  • If realized < floor over ≥ 20 covers in regime, Atticus tops up

Pillar 3 — Operational
  • Daily empirical chain validator run, results shared
  • Multi-venue routing (Bullish + Deribit) for liquidity resilience
  • 99.5% uptime SLA target on quote API
  • Settlement reliability: weekly net + monthly true-up

Pillar 4 — Capital + transparency
  • Hedge capital pool publicly disclosed quarterly
  • Bullish/Deribit account residual position transparency
  • Counterparty halt threshold at $114k unpaid Foxify→Atticus
```

---

## Decision framework

### When Volume Facility is the right choice

- Foxify's primary use case is **volume generation for partner exchanges**, not opportunistic alpha extraction
- Foxify has confidence in driving 20+/day distributed activation
- Foxify wants predictable revenue + transparent pricing more than absolute lowest cost on individual quotes
- Both parties expect a **multi-year partnership**, not a transactional vendor relationship

### When Adversarial is the right choice

- Foxify wants flexibility to activate opportunistically (event-driven, alpha-focused)
- Foxify cannot commit to distributional rules
- Foxify prefers transactional pricing over predictable floors
- Either party expects a **short-term test** before committing to terms

### Recommended path

Start with **Volume Facility**. The economics favor Foxify (~2.2× annual revenue at same volume); Atticus accepts lower per-cover margin in exchange for behavioral commitments. If Foxify cannot meet the volume + distribution commitments after 60-day pilot, fall back to Adversarial pricing automatically per contract — no re-negotiation needed.

---

## What we need to advance

1. **Approval in principle** of the 7-pillar Volume Facility framework
2. **Foxify volume commitment** — confirm 20+/day target is achievable at launch
3. **Foxify operational sign-off** — customer fingerprinting + per-customer caps + daily reconciliation
4. **Joint regime classifier review** — DVOL bands, calendar event list, time-of-day rules
5. **Pilot phase agreement** — 30-day pilot at 5/day volume to validate operational flow before scaling to 25/day

---

## Open negotiation items (flagged for joint discussion)

| Item | Atticus position | Open question |
|---|---|---|
| Atticus margin floor | $80k/month at 600 covers/mo | Is Foxify comfortable with this commitment? |
| Foxify per-cover EV floor | +$30 calm / +$50 moderate / +$80 elevated | Should elevated floor be higher? |
| Volume tier breakpoints | 500 / 2,000 / 5,000 monthly | Aligned with Foxify scaling plan? |
| Stress mode payout | $300 (X-or-Y) | Foxify preference: $200 / $300 / $500? |
| Settlement frequency | Weekly net | Daily preferred? Monthly? |
| Counterparty halt threshold | $114k unpaid Foxify→Atticus | Acceptable, or want higher cap with collateral? |

---

## Next step

If approved in principle, we draft the operating addendum within 7 days. Target signing within 21 days. Target Phase 0 launch (5/day pilot) within 30 days; Phase A scale (25/day) within 90 days post-launch.

If revisions requested, we iterate this proposal in 48-hour cycles until alignment.

---

**Bottom line for Foxify:** Volume Facility doubles your annual revenue at the same 25/day target volume. The trade is volume + distributional commitments in exchange for transparent pricing, predictable margins, and stress-mode continuity. Both sides come out ahead vs the adversarial model. If you can hit the volume targets, this is strictly better.

**Bottom line for Atticus:** Volume Facility lower per-cover margin is acceptable because the volume + distribution commitments substantially reduce gaming-defense engineering cost and stabilize cash flow. Combined product economics are equivalent (~$10.8M/yr at 25/day) but redistributed to favor Foxify, in exchange for a stickier partnership.
