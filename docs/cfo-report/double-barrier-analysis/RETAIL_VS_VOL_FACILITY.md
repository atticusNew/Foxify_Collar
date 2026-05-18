# Retail vs Volume Facility — Why Two Models, Not One

> **Purpose:** explain why the live retail pilot and the new Foxify
> volume facility need to be modeled, priced, and capitalized as
> *separate businesses* on top of the same engineering substrate.
> The V1 memo conflated them; V2 fixes this.

---

## 1. The two products are not the same

| Dimension | Retail pilot (live, do-not-disturb) | Volume facility (Foxify B2B, the new focus) |
|---|---|---|
| **Counterparty** | Many individual traders, anonymous | One institutional counterparty (Foxify, Inc.) |
| **Trader behaviour** | Heterogeneous, adverse-selection prone | Structured, predictable, treasury-style |
| **Notional per position** | $2.5k–$50k, mixed | $50k pair, fixed |
| **Tier structure** | Bronze/Silver/Gold/Platinum (drawdown 10-20%) | Single product (±2% barrier, $1k payout) |
| **Premium model** | Flat per-tier per-day, locked at activation | Tiered by DVOL band ($400/$600/$900/side/day) |
| **Hedge** | Per-trade put/call, OTM, varies by tier | Daily ±2% strangle (recommended) or 30d straddle (legacy) |
| **Settlement** | Per-trade, T+0 | Daily / weekly netted |
| **KYC** | Atticus → individual trader (heavy) | Atticus → Foxify (light); Foxify → end-traders (their problem) |
| **Capital model** | Phase 0 D4 (`Atticus_Capital_Scaling.md` §3) | This package (`MEMO_V2.md` §5) |
| **Empirical P&L** | ~$11/pair-week pilot at $11/$1k | ~$1,059/pair-week empirical at tiered |

The engineering stack is shared:
- The pricing engine (`services/api/src/pilot/pricingPolicy.ts`).
- The hedge book and trigger monitor.
- The Deribit / Falcon X / Bullish connectors.
- The risk-controls and circuit-breaker scaffolding.

But **the two products have fundamentally different unit economics, capital plans, customer-care models, and reporting cadences**. They should not share a single P&L narrative. They should not share a single capital allocation. They should not share a single repricing decision.

---

## 2. Why the V1 conclusions about "$250 won't work" don't condemn the retail pilot

V1 concluded that the proposed **$250-$400/side/day** premium structure can't support the volume-facility product. **That conclusion is correct for the volume facility but does not apply to the retail pilot,** because:

1. **The retail pilot doesn't hold 1,000 concurrent pairs.** It runs ~5-10 active trades at any time per `Atticus_Capital_Scaling.md`. The capital efficiency challenge that crushed V1's volume-facility math doesn't bind at retail's actual operating scale.

2. **Retail premium ($11/$1k/day) is structurally cheaper** but the per-trade notional and tier-mix produce different unit economics than V1's $50k pair model. V1 used the volume-facility's notional to compute breakeven; retail's effective per-trader notional is much smaller.

3. **The retail pilot's hedge is single-leg per trade**, not a double-barrier strangle pair. Different convex risk, different breakeven math.

4. **The retail pilot is a live revenue source with paying users.** Disrupting it to "fix" something that the volume-facility analysis flagged would risk known revenue to address an issue that doesn't apply.

**The retail pilot continues unmodified.** Any retail repricing decisions will be made on retail's own data after the volume facility is structurally locked.

---

## 3. The shared engineering — what's actually re-used

| Component | Retail | Vol facility | Reuse? |
|---|---|---|---|
| Pricing engine | per-tier table | DVOL-tiered ladder | partial — same surface, different schedule |
| Hedge selector | per-trade option | daily strangle book | partial — same selector, different cadence |
| Trigger monitor | barrier monitor | barrier monitor | yes — identical |
| Take-profit engine | TP V2 | not used (cooldown only) | retail-only |
| Circuit breakers | drawdown caps | cooldown + utilization | shared scaffold, different thresholds |
| Reporting | per-trade reports | daily/weekly netted | distinct (different counterparties) |
| Capital allocation | dedicated retail Deribit account | dedicated vol-facility Bullish/Falcon X account | **separated** |

**The capital allocations should be physically separated** (different sub-accounts at the venue). This is operational hygiene: it makes either P&L attributable to the right product and prevents one product's drawdown from eating the other's reserve.

---

## 4. Sequencing

| Order | Action |
|---|---|
| 1 | **Lock the volume-facility structure** per `MEMO_V2.md`: tiered premium, daily strangle hedge, cooldown circuit breaker, $80k facility for Phase 1. |
| 2 | **Run the volume-facility pilot in parallel with retail** for 4-8 weeks. Distinct sub-account at the venue. Distinct daily P&L roll-up. Distinct circuit breakers. |
| 3 | **Use volume-facility live data to refine retail pricing** if any cross-application is warranted (it may not be). The key learnings — empirical VRP, cooldown effectiveness, pooled-strangle ops — likely transfer to retail's Phase 1 biweekly model in `PHASE_0_BIWEEKLY_PERDAY_SPEC.md`. |
| 4 | **Only after volume facility is in steady state** consider any retail repricing. The pilot has ~22 days remaining per the existing rollout plan; that's the window to *not* disrupt. |

---

## 5. Checklist for keeping them separate

- [ ] Distinct venue sub-accounts (retail at Deribit, vol facility at Bullish/Falcon X)
- [ ] Distinct capital pools, never co-mingled at the bank-account or venue-balance level
- [ ] Distinct daily P&L reports (`/pilot/admin/diagnostics/triggered-protections` for retail; new endpoint or admin view for vol facility)
- [ ] Distinct circuit-breaker thresholds (retail's drawdown limits unchanged; vol facility's cooldown threshold per `MEMO_V2.md` §6)
- [ ] Distinct trader-facing terms (retail Foxify Funded protection terms unchanged; vol-facility B2B agreement is the new instrument)
- [ ] Distinct reporting cadence to Atticus partners (retail = trade-by-trade; vol facility = weekly netted)

---

*The two products share engineering and learn from each other. They do not share P&L, capital, or pricing decisions. V2 forward, treat them as two distinct businesses.*
