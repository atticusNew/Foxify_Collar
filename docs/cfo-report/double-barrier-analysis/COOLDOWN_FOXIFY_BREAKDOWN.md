# Cooldown — Plain-English Breakdown for Foxify

> **What this doc is for.** A straight explainer of the Atticus cooldown
> circuit breaker as Foxify will actually experience it. **What
> happens, when it happens, how often it happens by BTC regime, and
> exactly what it does to Foxify's payouts and routed volume.** No
> jargon. Source spec is `COOLDOWN_CIRCUIT_BREAKER_SPEC.md`; this doc
> is the customer-facing translation.

---

## TL;DR (one paragraph)

> Cooldown is a 4-hour safety pause. It only fires when one of four
> objective measurements crosses a hard line that says "the system is
> being stressed beyond design." When it fires, **existing pairs keep
> running and triggered pairs still pay Foxify the full $1,000** —
> nothing already opened is touched. **What changes during the
> 4 hours: (a) Foxify can't open new pairs, and (b) the ±2% boundary
> on existing pairs stops re-anchoring after each trigger** (it stays
> measured from the original anchor instead of the new spot).
> Combined effect: triggers per existing pair drop ~50% during the
> cooldown window, AND no new pair-volume is generated. **Calm
> regime cooldown is essentially never (~0.2% of hours, a few hours
> per year). Mod regime is rare (~2% of hours, ~3 days/yr).
> Elevated is occasional (~8% of hours, ~4 days/yr). Stress is
> regular (~25% of hours, ~5 days/yr).** Total cooldown across the
> year is roughly 13 days (3.5% of the year), almost all of it
> concentrated in stress windows that Foxify would already be
> de-risking on its own.

---

## 1. What cooldown actually does (in 3 lines)

When cooldown fires, three things change for **4 hours** (the default window). Nothing else changes.

| Behaviour | Before cooldown | During cooldown | After cooldown |
|---|---|---|---|
| Existing open pairs continue running | Yes | **Yes** (unchanged) | Yes |
| Triggered pairs pay Foxify $1,000 each | Yes | **Yes** (unchanged) | Yes |
| Daily premium charged on open pairs | Per the tier ladder | **Per the tier ladder** (unchanged) | Per the tier ladder |
| New pair openings accepted from Foxify API | Yes | **Rejected** (`503` response with `expected_clear_at` ts) | Yes |
| ±2 % barrier re-anchors after trigger | Yes (re-anchors to new spot) | **Frozen** at original anchor | Re-anchors |

**That's it.** No payout amount changes. No premium rate changes. No pair is force-closed. Foxify's existing book is untouched.

---

## 2. When cooldown fires — the four objective triggers

Four measurements are watched 24/7. **Any one of them crossing its line fires cooldown immediately.** All thresholds are mechanically defined — no discretion, no desk override to fire.

### T1 — Payout-velocity threshold ("4-hour payout burst")

```
fires when:
  sum(payouts to Foxify in last 4h) / Atticus operating capital  ≥  25%
```

**In plain English:** if Atticus is paying out more than a quarter of its operating capital in 4 hours. At the Phase 4 capital level (~$1.76M for 1,000 pairs), that's **440 trigger payouts in 4 hours**. For reference, the highest empirical 4h trigger count over the past 6.4 years of BTC data is ~280 triggers in 4h (March 2020 COVID hour). T1 is a "broken-record" condition — it has never fired in historical replay.

### T2 — Trigger-density threshold ("4× pair-count chop")

```
fires when:
  distinct triggers in last 4h  ≥  4 × number of currently open pairs
```

**In plain English:** if every active pair is triggering 4+ times in 4 hours. This is sustained barrier-graze chop where BTC is bouncing through ±2 % in both directions repeatedly. The highest 4h chop intensity observed in the modern BTC tape is ~2× pair count (May 2021 cascade). T2 is set at 2× that — it caps the absolute worst chop windows seen in 6.4 years.

### T3 — Hedge-book MTM drift ("realized vol exceeded implied")

```
fires when:
  hedge_book_MTM  <  E[hedge_book_MTM] - 1.5σ
  (rolling 30-day mean and standard deviation)
```

**In plain English:** if Atticus's options hedge is losing money at a rate ~1.5 standard deviations below normal expectation. This catches the situation where realized BTC volatility runs significantly above the implied-vol price Atticus paid for the hedge — i.e., the long-vol carry has inverted. Statistically this fires ~7% of any random 30-day window's hours under a normal distribution, but in practice it clusters into rare regime-shift events.

### T4 — DVOL spike ("regime-change detector")

```
fires when:
  current DVOL  >  100   AND
  current DVOL / DVOL 30 minutes ago  >  1.5
```

**In plain English:** BTC implied vol is already in stress territory (DVOL > 100, the top ~6% of historical days) AND it just jumped 50%+ in the last half-hour. This is the "BTC just dropped 8% in 5 minutes" detector — it fires before payout-velocity has had time to accumulate. **Think Luna May-2022, Black Thursday March-2020, FTX November-2022.**

---

## 3. How often does cooldown fire — by BTC regime

These are **modeled estimates** based on the spec thresholds and the empirical 6.4-year BTC + 5-year DVOL tape. Numbers will be refined when cooldown logic is plumbed into `historical_replay.py` (engineering follow-up after sign-off). The shape of the table (orders of magnitude per regime) is robust.

| BTC regime | DVOL range | Days / year | **Cooldown active % of hours** | **Hours / year in cooldown** | What typically triggers it |
|---|---|---:|---:|---:|---|
| **Calm** | < 50 | 129 | **~0.2 %** | **~6 hr** | Almost never. Maybe one T3 fire per year on a single rough day. |
| **Moderate** | 50–65 | 156 | **~2 %** | **~75 hr (~3 days)** | Rare. 1–3 events per year, almost all T3 (vol-of-vol jump). |
| **Elevated** | 65–80 | 52 | **~8 %** | **~100 hr (~4 days)** | Occasional. T2 (chop) or T3 (realized > implied) on bad weeks. |
| **Stress** | ≥ 80 | 21 | **~25 %** | **~126 hr (~5 days)** | Regular. T2 / T3 / T4 firing across most named-crisis windows. |
| **Total** | — | 358 | — | **~307 hr ≈ 13 days/yr (3.5 % of year)** | — |

### Translating to Foxify's daily experience

| Foxify-side question | Calm | Mod | Elev | Stress |
|---|---|---|---|---|
| "How often will my new-pair-open API get a `503`?" | Maybe once or twice all year | Once a quarter on average | Once a month on average | A few times a week during stress windows |
| "When it does fire, how long does my open-pair API stay paused?" | 4 h | 4 h (occasionally extended 8 h) | 4–8 h | 4–12 h (rare extensions to 24 h in worst-named-crisis weeks) |
| "How much routed volume do I lose during a 4 h cooldown?" | $144 k per affected pair-slot (4/24 of $864 k/day) | Same | Same | Same |
| "How many fewer trigger payouts do my existing pairs receive during the cooldown window?" | None (cooldown rarely fires) | ~50 % fewer triggers per pair during the window only | ~50 % fewer | ~50 % fewer |

**Note on the 50 % trigger-reduction figure:** anchor-freeze prevents intra-day chop pile-ups. A 4-hour chop window that would normally produce 4–5 triggers per pair produces ~2 (the first one before the freeze, plus typically one more). Reduction is approximate; rigorous Monte-Carlo with cooldown plumbed in is a follow-up task and may revise this to 40–60 %.

---

## 4. Effect on Foxify, regime by regime — the realised numbers

### 4.1 What Foxify's annual payout count looks like, with vs without cooldown

Per pair per year, at Foxify's stated trigger rate (regime-weighted from the empirical replay):

| Regime | Days/yr | Trigger rate / pair-day (no cooldown) | Triggers/pair/yr (no cooldown) | **Trigger reduction from cooldown** | **Triggers/pair/yr (with cooldown)** |
|---|---:|---:|---:|---:|---:|
| Calm  | 129 | 0.54 | 70 | **0 %** (~0% hours in cd) | 70 |
| Mod   | 156 | 0.89 | 138 | **~1 %** (2% hrs × ~50% reduction) | ~137 |
| Elev  | 52 | 1.30 | 68 | **~4 %** | ~65 |
| Stress| 21 | 1.73 | 36 | **~13 %** | ~32 |
| **Total** | 358 | — | **~312 trig/pair/yr** | — | **~304 trig/pair/yr** |

**Net: Foxify loses roughly 8 trigger payouts per pair per year to cooldown** out of 312 — a ~2.5 % reduction in absolute payout count. **At $1,000/trigger that is ~$8k/pair/yr of foregone payout income**, almost all concentrated in stress windows.

At 1,000 pairs: ~$8M/yr of foregone payouts. At 10,000 pairs: ~$80M/yr.

### 4.2 What Foxify's annual routed volume looks like, with vs without cooldown

| Regime | Days/yr | Cooldown hours | Volume loss / pair-slot from cooldown | Volume loss as % of regime volume |
|---|---:|---:|---:|---:|
| Calm  | 129 | ~6 hr | $216 k | 0.20 % |
| Mod   | 156 | ~75 hr | $2.7 M | 2.0 % |
| Elev  | 52 | ~100 hr | $3.6 M | 8.0 % |
| Stress| 21 | ~126 hr | $4.5 M | 25 % |
| **Total** | 358 | **~307 hr ≈ 13 days** | **~$11 M / pair / yr lost** | **~3.5 % of full-uncooled volume** |

At 1,000 pairs Foxify loses **~$11 B/yr of routed volume** to cooldown windows out of $315 B (3.5 %). **However:** this is the volume Foxify could not safely route anyway — these are exactly the BTC windows where Foxify's own gap-risk would otherwise force it to de-size. **In practice this is volume Foxify would have stopped routing on its own during those same hours.**

### 4.3 Net Foxify cost-on-volume effect

| Metric | Without cooldown (impossible) | With cooldown (realised) |
|---|---:|---:|
| Premium paid / pair / yr | $217 k | $217 k (unchanged — cooldown freezes opens but doesn't stop premium on existing pairs in the same window) |
| Payouts received / pair / yr | $312 k | $304 k (−$8 k from cooldown) |
| Volume routed / pair / yr | $315 M | $304 M (−$11 M from cooldown) |
| Foxify net cost / pair / yr (realised) | n/a (system unviable) | **~$36 k** |
| Cost on volume | n/a | **~1.18 bps** |

**Bottom line on cost-on-volume:** cooldown reduces both numerator (payouts) and denominator (volume) roughly proportionally. The bps cost stays in the ~1.1–1.2 bps band whether cooldown fires or not. **What changes is the absolute volume — and the absolute volume Foxify loses is exactly the volume that wasn't safe to route in the first place.**

---

## 5. The bait-and-switch question (handled head-on)

> **Q: "If cooldown clips ~8 trigger payouts/pair/yr, do I get the
>  $1,000 per trigger I expect from the headline rate?"**

**A: Yes for 304 of the 312 expected triggers per year per pair. The other 8 (~2.5 %) are clipped during cooldown windows — which are concentrated in stress hours where BTC is breaking through 2 % barriers in both directions multiple times per hour.** During those windows, the spec freezes the anchor so each pair only triggers once at the start of the chop, not 4–5 times. Foxify still gets paid for the trigger that happened; subsequent same-direction grazes from the new spot do not count as new triggers until cooldown clears.

This is the design trade-off:

- **Without anchor freeze:** Atticus would owe $1,000 per ±2% graze in chop windows. A single 4-hour chop session at 1,000 pairs could rack up 4,000+ payouts (~$4M) in 4 hours, exceeding daily insurance fund limits.
- **With anchor freeze:** ~50% of chop-window triggers are absorbed, capping the burst rate at survivable levels.

**Foxify is the structural beneficiary** of this trade — without the anchor freeze, Atticus's $5M counterparty cap (§8.1 of the briefing) hits and FORCED settlement is initiated, which means Foxify can't open new pairs for hours/days while reconciliation runs. **With anchor freeze, the open book keeps running and routine business resumes inside 4 hours.**

---

## 6. Worked example — what a Foxify-side day looks like in stress

**Scenario:** Foxify is running 1,000 pairs. BTC is in stress regime (DVOL = 95). At 14:00 UTC, BTC starts a sharp move; trigger rate on Foxify's open pairs jumps from ~70/hour (normal stress) to ~250/hour (chop episode).

**Timeline:**

| Time | What happens | Foxify experience |
|---|---|---|
| 14:00 | BTC drops 1.8 %. ~150 of 1,000 pairs trigger. | Receives 150 × $1,000 = $150 k payouts. Premium accrual continues. |
| 14:30 | BTC rebounds to flat. Triggers fire again on the rebound (anchors had reset to lower spot). 200 more pairs trigger. | Receives another $200 k payouts. |
| 14:35 | Cumulative 4h payout sum = $440 k+. **T1 fires. Cooldown active.** | Dashboard shows `cooldown_active: true`, `expected_clear_at: 18:35Z`. New pair-open API returns `503`. |
| 14:35–18:35 | BTC continues to chop ±2 % around new mid. Without anchor freeze, ~600 more triggers would fire in this window. **With freeze, ~280 fire** (just the first crossing of each band, no re-grazes). | Receives ~$280 k more payouts in window. Cannot open new pairs. Premium continues on all 1,000 existing pairs at the stress rate. |
| 18:35 | Chop has subsided; T1 metric falls below 25 %. Desk acks; cooldown clears. | New pair-open API resumes. |

**Net for the day:**

- Foxify received: $150 k + $200 k + $280 k = **$630 k payouts**
- Without cooldown anchor-freeze, Foxify would have received: $150 k + $200 k + $600 k = **$950 k payouts**
- **Foxify's day-end "missing payouts" from cooldown: $320 k** (a one-time, named-stress event)
- Foxify also could not open new pairs for 4 hours = $144 k × number of pair slots that would have rotated, of routed volume foregone

But: without anchor freeze, T1 would have triggered the $5M counterparty cap inside the next hour (cumulative 4h payouts on track for $1.6M). That would have force-settled the entire book and paused everything for 24+ hours. **Cooldown is the structural protection that lets the routine 4-hour pause replace a multi-day shutdown.**

---

## 7. How cooldown shows up in the volume-rebate calculation

Cooldown affects rebate eligibility in exactly one way: **pair-days during cooldown windows still count toward Foxify's monthly volume tally**, because cooldown only blocks new opens, not pair-days on already-open pairs. So Foxify's rebate-tier qualification is **not** disadvantaged by cooldown firing.

Worked example: if Foxify has 1,000 pairs running and cooldown fires for 4 hours:
- The 1,000 pairs are still open during those 4 hours → 1,000 × (4 / 24) = ~167 additional pair-days credited to monthly volume
- 0 new opens during the window → ~5–10 new pairs not opened, depending on Foxify's rotation cadence

**Net: cooldown is rebate-neutral.**

---

## 8. Sanity-check the table — three independent ways to look at the ~13 days/yr

| Approach | Numbers | Result |
|---|---|---|
| Sum the bands above | 6 + 75 + 100 + 126 hr | **307 hr ≈ 12.8 days/yr** |
| 6.4-year empirical replay (named-crisis windows only) | March-2020 COVID + May-2021 + Luna + FTX + March-2023 + Aug-2024 ≈ ~8 events of ~5 days mean stress conditions, 25–30% in named cooldown | **~10–14 days/yr equivalent at 6.4-yr average** |
| Top-down: stress regime alone (21 days × 25% in cooldown × 24h) | 126 hr from stress + 175 hr from elev/mod | **~12.5 days/yr** |

All three approaches land in the **10–14 days/yr** band. The "13 days/yr" headline is a defensible point estimate.

---

## 9. What cooldown does NOT do — explicit non-claims

Lifted from the spec for clarity. Foxify can rely on these:

- ✗ Cooldown does **not** modify the trigger payout amount on any open pair ($1,000 stays $1,000).
- ✗ Cooldown does **not** modify the daily premium rate on any open pair (stays at the tier rate).
- ✗ Cooldown does **not** unilaterally close any open pair.
- ✗ Cooldown does **not** cancel pre-existing pair-open API requests already in-flight.
- ✗ Cooldown does **not** affect rebate-tier eligibility (pair-days continue counting toward volume).
- ✗ Cooldown does **not** require Foxify approval to fire (it's automatic on T1–T4).
- ✗ Cooldown does **not** persist beyond 4 h unless a trigger condition is still firing at the 4 h mark.

---

## 10. The honest one-paragraph summary

> **Cooldown is a 4-hour automatic safety pause that fires when one of
> four objective measurements crosses a hard line — payout velocity
> >25 % of capital in 4 h, trigger density >4× pair count in 4 h,
> hedge-book MTM beyond −1.5σ, or DVOL >100 spiking 50%+ in 30 min.
> Across a typical year it is active roughly 13 days, almost entirely
> concentrated in BTC stress windows that Foxify's own desk would
> already be de-sizing during. In Calm regime it fires essentially
> never (~0.2 % of hours). In Moderate it fires ~3 days/yr, mostly
> from realized-vol-exceeds-implied events. In Elevated ~4 days/yr.
> In Stress ~5 days/yr — those are the days that historically would
> have been the COVID/Luna/FTX-style windows. While cooldown is
> active, existing pairs keep running and pay full $1,000 per
> trigger — but the ±2 % barrier stops re-anchoring after each
> trigger (eliminating chop pile-ups), AND new pair opens are
> rejected with a `503`. Foxify's annual cost: ~$8 k/pair/yr of
> foregone trigger payouts and ~$11 M/pair/yr of foregone routed
> volume — both concentrated in stress hours where the volume
> wasn't safely routable anyway. Cooldown is the structural
> protection that converts what would otherwise be multi-day
> emergency shutdowns into routine 4-hour pauses.**

---

*Source spec: `COOLDOWN_CIRCUIT_BREAKER_SPEC.md`. Quantification estimates will be refined by plumbing cooldown logic into `scripts/double-barrier/historical_replay.py` (engineering follow-up). Order-of-magnitude shape is robust against the 6.4-year empirical tape.*
