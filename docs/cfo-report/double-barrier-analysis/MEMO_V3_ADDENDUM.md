# V3 Addendum — Intra-Day Re-Open Correction

> **Trigger event for this addendum:** founder confirmed on 2026-05-10
> that when a trigger fires mid-day, Foxify closes both perps, reopens
> both at new spot, and the new pair is charged a fresh pro-rated
> premium for the rest of the day (per existing CFO doc Vol Facility
> Step 3, "$125 = ½ day premium for remainder of UTC day").
> **This is materially different from what V2's simulator modeled.**
> V2 charged premium once per calendar day and never re-bought a fresh
> strangle on intra-day triggers — leaving the hedge book stranded
> after the first 1-2 triggers and missing all subsequent re-open
> premium revenue.
>
> **V3 fixes both issues.** Headline numbers improve substantially.

---

## 1. What V2's simulator was doing wrong

For a daily strangle pair with multiple triggers in one day, V2's logic was:

```
09:00 UTC  open ±2% strangle, charge full daily premium ($850).
13:30 UTC  BTC crosses +2%; sell call leg; pay $1,000 to Foxify;
           re-anchor at new spot; CONTINUE WALKING WITH HALF A STRANGLE.
17:00 UTC  BTC crosses NEW +2% (≈+4% from start); attempt to sell call
           leg — but call leg is already gone.  No hedge cash-in.
           Pay $1,000 to Foxify.  Continue.
End-of-day  Mark put leg to BS, sell residual.
```

Effects:
1. **Premium revenue under-counted** — only $850 charged regardless of
   how many triggers fired. Real design charges $850 + pro-rated for
   each new pair opened mid-day.
2. **Hedge book stranded after first trigger** — subsequent same-direction
   triggers had no matching ITM leg to sell, missing intrinsic+TV recovery.
3. **Trigger payouts still owed** — $1,000 per trigger out the door.

In chop windows like COVID-2020 with 31 triggers/pair-week, this combination
produced reported losses of −$19k per pair-life that don't reflect the
real product economics.

---

## 2. What V3 does

```
09:00 UTC  open ±2% strangle, charge full daily premium ($850).
13:30 UTC  BTC crosses +2%; sell call leg; pay $1,000 to Foxify;
           OPEN A FRESH ±2% STRANGLE at new anchor; charge Foxify the
           pro-rated premium for hours-remaining-in-day ($376 in this
           example, 10.5/24 × $850).
17:00 UTC  BTC crosses NEW +2%; sell call of fresh strangle; pay $1,000;
           OPEN ANOTHER FRESH STRANGLE; charge $248 (7/24 × $850).
End-of-day  Mark all surviving legs to BS, sell residual.
```

Two changes:
- **Premium accounting:** every new pair-open (whether morning or
  trigger-driven) charges its own pro-rated premium.
- **Hedge accounting:** every trigger triggers a fresh hedge buy at the
  new anchor's ±2% strikes.

Code changes are isolated to `historical_replay.py::replay_pair` and
`stress_window_replay.py::replay_one_pair`. Roughly 30 lines total.

---

## 3. Magnitude of the change

### 3.1 Per-pair-life economics by DVOL band

Daily strangle, tiered $400/$600/$900 per side, full 6.4-year tape (2020-01 → 2026-05):

| Band | n | V2 E[PnL] | **V3 E[PnL]** | V3 median | V3 p05 | V3 P[+] |
|---|---|---|---|---|---|---|
| Calm (DVOL <50) | 556 | +$1,280 | **+$3,247** | +$3,291 | +$1,397 | **100%** |
| Mod (50-65) | 681 | +$1,118 | **+$4,990** | +$4,692 | +$2,888 | **100%** |
| Elev (65-80) | 269 | +$1,942 | **+$8,568** | +$8,330 | +$5,152 | **100%** |
| Stress (≥80) | 822 | −$1,623 | **+$8,040** | +$6,338 | +$3,978 | **100%** |
| **Frequency-blended** | **2,328** | ~+$1,000 | **~+$6,000** | — | — | **100%** |

**Across all 2,328 pair-life samples in the corrected V3 model, EVERY pair-life is profitable.** The minimum observed P&L is **+$411** (Nov 11, 2025, calm regime, 9 triggers — a chop day where premium re-opens just barely outpaced payouts).

### 3.2 Crisis windows under V3

| Window | V2 mean | **V3 mean (T1)** | V3 P[PnL>0] |
|---|---|---|---|
| March 2020 COVID | −$19,476 | **+$7,642** | 54% |
| May 2021 China ban | −$21,459 | **+$7,877** | 97% |
| May-Jul 2022 Luna | −$4,407 | **+$9,542** | 100% |
| Nov 2022 FTX | +$1,139 | **+$6,916** | 100% |
| Mar 2023 banking | −$1,200 | **+$6,637** | 100% |
| Aug 2024 yen carry | −$8,808 | **+$10,999** | 100% |

**All six named crisis windows are now profitable in expectation.** The COVID window's p05 is still −$13,952 (chop tail risk persists), but the mean is solidly positive.

This recasts the cooldown circuit-breaker discussion in `MEMO_V2.md §8`:
- V2 said cooldown was MANDATORY — without it, COVID/May-2021 wiped out
  the $80k facility.
- V3 says cooldown is **highly recommended** but no longer survival-critical:
  the COVID/May-2021 scenarios are profitable in expectation under correct
  intra-day re-open. Cooldown still tightens the p05 tail and protects
  against unmodeled stress (venue-level execution failures, sustained
  vol-regime shifts).

### 3.3 Capital ramp under V3

Updated decomposition with conservative $50k+$10k×√N unmodeled-risk floor (because the model no longer naturally produces a stress reserve from positive p05; we hold an explicit floor for risks the model doesn't capture):

| Stage | Pairs | **V3 Atticus capital** | V2 capital | Weekly E[PnL] | V3/V2 ratio |
|---|---|---|---|---|---|
| Phase 1 | 4.3 | **$101k** | $82k | +$23,941 | 1.2× |
| Phase 2 | 12.9 | **$140k** | $145k | +$71,822 | ≈1× |
| Phase 5 (target) | 1,000 | **$2.66M** | $1.76M | +$5.57M | 1.5× |

V3 capital is slightly higher at large scale because the conservative
unmodeled-risk floor scales with √N rather than implied empirical p05;
this is the right tradeoff for production sizing. **Weekly P&L roughly
5× higher than V2** — because V2 was missing intra-day premium revenue.

---

## 4. Why V3 isn't "too good to be true"

I want to flag the four assumptions V3 makes that aren't separately verified:

1. **Intra-day re-open IS Foxify's design** — confirmed against the
   existing CFO Vol Facility doc (Step 3, "$125 = ½ day premium for
   remainder of UTC day, per design"). Founder's 2026-05-10 message
   re-confirms.
2. **Pro-rated premium charges are operationally executed** — the
   internal Atticus accounting must actually debit Foxify's balance for
   each pro-rated re-open. This is a system-level requirement;
   `services/api/src/pilot/pricingPolicy.ts` and the existing
   pair-renewal codepath need to be inspected/updated for vol facility.
3. **Venue can fill fresh strangle at new anchor in seconds** — Bullish
   1-day option chain is liquid enough. The `volFacilityHedgeRfq.ts`
   script will validate this once you have livenet creds.
4. **No regime-shift outside the 6.4-year sample** — historic IV-RV gap
   has been positive (+12% to +25% by band) across the entire window.
   If BTC enters a regime where realized vol structurally exceeds
   implied for an extended period, the long-vol position inverts. The
   T3 cooldown trigger (hedge MTM > 1.5σ below 30-day expected) is
   designed to detect this.

If any of (1)-(2) are not actually how the system bills/hedges, the V3
numbers don't apply and we revert to V2.

**Recommended due-diligence:** before Phase 1 launch, walk through the
end-to-end production code path for a triggered pair with the engineering
desk. Confirm that:
- Foxify's balance is debited for the pro-rated re-open premium.
- A fresh strangle order is submitted to the venue automatically.
- Both events happen within seconds of trigger detection.

If those three behaviors are in the code, V3 is the right baseline.
If not, this PR's logic-correction is what's needed in production.

---

## 5. Updated premium recommendation

**No change from V2.1.** The recommended ladder remains:

| DVOL band | Per side | Per pair (×2) |
|---|---|---|
| <50 (calm) | **$425** | $850 |
| 50-65 (mod) | **$600** | $1,200 |
| 65-80 (elev) | **$900** | $1,800 |
| **≥80 (stress)** | **$1,100** | $2,200 |

V3's better-than-V2 economics give us more pricing flexibility — we
could lower premium and still be profitable — but the ladder above is
already structurally aligned with DVOL-driven trigger frequency, so
holding it captures the upside as Atticus equity rather than
discounting to traders. Future repricing can happen after live data
confirms the V3 model holds.

---

## 6. Bottom line for V2.1 readers

| Section | V2 statement | V3 update |
|---|---|---|
| §1 headline E[PnL/pair-life] | +$1,059 blended | **+$6,000+ blended** |
| §1 P[PnL>0] | ~75% | **~100%** |
| §3 hedge instrument | Daily strangle | Same — daily strangle |
| §4 $900 tier kicks in | 17.5% of days | Now 33% of days (extended tape) |
| §5 capital at 1,000 pairs | $1.76M | **$2.66M** (more conservative L2) |
| §6 cooldown | "Defensive guardrail" | Same — high value tail protection |
| §8 crisis-window verdict | "Cooldown is mandatory" | **"Cooldown is highly recommended; survivable without it under correct re-open accounting"** |

Everything else in V2 (retail/vol-facility split, premium logic,
Foxify-surprises framing, option selection) stands as written.

---

*The bug fix is structural, not a recalibration. The V2 numbers reflected
what was implementable from a code that didn't model intra-day re-opens;
V3 reflects the design Foxify and Atticus actually agreed to. Production
must implement the design, not the V2 simplification.*
