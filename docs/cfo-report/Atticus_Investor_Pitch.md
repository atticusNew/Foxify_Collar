# Atticus — Investor Pitch & Funding Structures

> **Audience:** prospective investors, strategic partners, and counterparties.
> **Purpose:** position Atticus's funding ask, present the menu of capital
> structures we are open to, and articulate why we are choosing the right
> capital structure for the company's stage rather than the fastest one.
> **Companion docs:**
> - Mechanics: `Atticus_How_It_Works.md`
> - Capital math: `Atticus_Capital_Scaling.md`
> - Retail spec: `docs/platforms/retail_platform_spec.md`
> - Treasury spec: `docs/platforms/treasury_platform_spec.md`
> **Last updated:** 2026-05-06

---

## 1. Where Atticus is today

Atticus is a Bitcoin protection platform operating two distinct products on
shared infrastructure:

- **Retail Protection** — B2C trader-facing daily-subscription protection,
  currently in live pilot with Foxify
- **Treasury Protection** — institutional structured protection using
  protective collars, ready to launch alongside or after retail per
  partner cadence

The platform is live on Deribit mainnet, has executed real trades, has
backtested across 1,558 days of historical Bitcoin price action, and has
a documented clear-eyed risk register and scaling path.

We have a paying customer engaged. The Foxify CEO is actively using the
retail platform and has independently expressed interest in using the
treasury product for their own balance sheet — an unsolicited validation
of the treasury thesis from the partner who would benefit most from
catching us under-priced.

---

## 2. Why we're discussing capital now

A direct framing the investor should hear from Atticus, not infer:

> *We have been self-funded and have prioritized product development and
> customer acquisition over fundraising. That sequencing has been deliberate.
> The platform is real, the pilot is operating live, and the next-stage
> conversations with both retail and treasury partners are active. We are
> now choosing the right capital structure for our stage — not the fastest
> structure, not the most desperate structure, and not the structure most
> favorable to a single counterparty.*

This is the anchor. From it, the menu of structures below. Atticus has the
runway and product traction to be selective.

---

## 3. What capital unlocks

We separate the funding picture into three discrete asks. Each unlocks a
specific operational milestone. They are independent — a partner can engage
on one without committing to the others.

### 3.1 Working capital ask — operational scale

| Tranche | Working capital | What it does |
|---|---|---|
| Phase 2 beta | **$50–75k** | 5–8 concurrent retail biweekly positions, validate Foxify rollout. ~$1.5–2.5k/month gross spread baseline. |
| Mid scale | **$150k** | $200–500k/day retail notional + first treasury Scenario-A subscriptions live. ~$10–15k/month gross spread. |
| Production | **$300k+** | $1M+/day retail + 2–3 active treasury subscriptions. ~$80–100k/month gross spread (annualized $1M+). |

Each tranche is *unlocked* by data from the previous, not gated by
calendar. Empirical milestones (clean trades, recovery rate measurement,
tier-mix observation) drive the upgrade decisions.

### 3.2 Dev capital ask — engineering velocity (separate)

A **distinct, smaller line** focused on engineering acceleration during
the pilot-to-production phase. We are presenting this separately from the
working-capital ask intentionally — the two have different return profiles
and either can be funded independently.

| Item | Amount | What it accelerates |
|---|---|---|
| Senior dev contractor — pilot duration | **$5–10k** | Brings on a senior engineer for ~6–10 weeks of pilot operations. Specifically: hedge inventory pooling implementation, treasury collar builder activation, days-held instrumentation, Falcon X integration completion. |

Why this is presented as a discrete line:

1. **It's small.** $5–10k is the right size for partner-side flexibility.
2. **It's targeted.** The deliverables are specific engineering modules
   that exist as designs and need execution.
3. **It accelerates platform velocity directly.** Each of the four modules
   above is on the critical path for the next scale milestone; faster
   delivery moves all downstream metrics in.
4. **It does not change Atticus's product strategy.** This is execution
   acceleration, not strategic dependency.

A partner contributing the dev tranche alongside (or instead of) the
working-capital tranche delivers proportional company benefit. We don't
position dev capital as essential to survival — the platform is shipping
either way; dev capital changes velocity, not viability.

### 3.3 Strategic introductions ask — non-financial

A partner who can make 1–3 high-quality introductions to credible
treasury operators (DAOs, corporate BTC holders, fund treasuries) creates
value out of proportion to capital. The treasury product specifically
benefits from the volume flywheel via Falcon X — every additional treasury
client improves pricing for all existing clients.

This is presented as an **advisor relationship** opportunity rather than
investment. Standard early-advisor equity (0.25–1% over 4-year vest) is
how we'd structure it. Independent of any capital commitment.

---

## 4. Funding structure menu

We are open to the following structures for the working-capital ask. They
are presented in the order most aligned with Atticus's stage and interests.

### Structure A — SAFE (Simple Agreement for Future Equity)

The standard early-stage instrument. Partner contributes capital today;
the SAFE converts to equity at the next priced equity round, typically
with:
- A **valuation cap** (the maximum effective price the partner pays)
- A **discount** (typically 15–25%) on whatever the next round prices at

**Why we like it:** clean, fast, no fixed coupon to service, no principal
risk that could cost us strategic flexibility. Defers valuation to a future
sophisticated lead investor. Partner gets the first-mover discount.

**Why a partner likes it:** simple, well-understood, doesn't require
agreement on a current valuation, allows participation in next-round
upside.

**Indicative parameters:** $50–150k at $3M post-money cap, 20% discount,
qualified-financing trigger.

### Structure B — Revenue share with capped MOIC

A non-equity structure where the partner provides capital and receives a
defined percentage of platform gross spread until a target multiple of
invested capital (MOIC, e.g. 1.5–2.0×) is returned, after which the
participation ends.

**Why we like it:** no fixed coupon (bad months don't service debt out of
working capital), aligns the partner with our success directly, no
permanent dilution, no equity governance overhead.

**Why a partner likes it:** clean cash returns, capped exposure to upside
they're not entitled to, doesn't require valuation negotiation, simpler
than equity for some investor types.

**Indicative parameters:** $50–150k for 8–12% of platform gross spread
until 1.75× MOIC achieved, then participation terminates.

**Variant — MOIC-then-equity:** after 2.0× MOIC, the partner's remaining
notional converts to a small equity slice at a SAFE-cap-equivalent
valuation. This combines Structure A's upside with Structure B's
predictable cash component.

### Structure C — Pilot capital + warrants

The partner provides **non-interest-bearing pilot capital** as a
short-tenor instrument. Repayment is gated on a defined revenue
milestone (e.g. $250k cumulative platform revenue). In exchange, the
partner receives warrants to purchase 1–3% equity at a strike price set
at SAFE-cap-equivalent terms.

**Why we like it:** lowest cash cost at this stage. Real partner upside
through warrants. Principal repayment tied to operational milestones we
control.

**Why a partner likes it:** principal protection at a milestone (rather
than equity-only), upside through warrants rather than fixed yield,
reflects the reality that this is early-stage operational capital.

**Indicative parameters:** $50–100k principal, repayable at $250k cumulative
platform revenue or 18 months whichever first, plus 2% equity warrants at
$3M strike valuation.

### Structure D — Priced equity (only if warranted)

A direct equity round with an agreed valuation. We list it for
completeness; we would only pursue this if a partner specifically prefers
priced equity to a SAFE and brings sufficient capital to justify the
overhead of a priced round.

**Indicative parameters:** $150–300k at agreed valuation; standard
preferred-stock terms, single liquidation preference, no participating
preferred.

### What we are NOT pursuing

We have considered and decided against:

- **Senior credit at high-APR yield (12–18% APR).** This structure rewards
  the lender with fixed yield while extracting Atticus's working capital
  in stress months. It misalignsings the partner from our success and
  creates fragility we'd rather avoid at this stage.
- **Convertible debt at high coupon.** The principal-and-interest
  obligations are not a fit for a platform whose working capital should
  flow into hedging, not debt service.
- **Aggressive equity haircuts.** We are not in a position where giving
  away unfavorable terms on a small check is justified by the speed of
  capital. The pilot is operating; partners are engaged; we have time
  to choose well.

We mention this category not to be defensive but to be transparent about
our framing: we are choosing a fit, not accepting any offer.

---

## 5. The dev-capital line — detail

For partners interested in funding the engineering-velocity tranche
specifically (whether alongside a main investment or independently):

### Deliverables for the $5–10k allocation

| Module | Status | What completing it unlocks |
|---|---|---|
| **Days-held instrumentation** | Designed; ~30 lines code | Critical pilot data; gates pricing tuning decisions |
| **Hedge inventory pooling** | Designed; ~250 lines core module + tests | 25–40% reduction in fresh hedge buys; meaningful capital efficiency lift |
| **Treasury collar builder activation** | Skeleton exists in repo; needs wiring | Treasury product ships; ~25–30× capital efficiency vs retail |
| **Falcon X buy/sell-RFQ integration** | Adapter documented; needs full execution path | OTC venue live; volume flywheel begins compounding |

### Engineering capacity model

- A senior engineer at typical contract rates: ~$10–15k/month
- 6–10 weeks of focused work delivers all four modules
- The $5–10k tranche covers the bulk of this; remainder comes from operating
  cashflow as it accumulates
- Atticus's existing engineering velocity is meaningful (the platform
  exists and is live); the tranche specifically accelerates the modules
  above the critical path, freeing the existing team for strategy and
  customer development

### Why this specifically helps a partner who funds it

A partner who funds the dev tranche directly accelerates the timeline to:
- Treasury product launch (which is the product most aligned with
  partner-introduction value)
- OTC volume flywheel activation (which is the strongest moat)
- Capital efficiency improvement (which makes their working-capital
  contribution go further)

Each of these compounds the partner's working-capital contribution if
they made one. A partner who *only* funds dev capital still gets
proportional benefit through the warrant or equity component, depending
on the structure chosen.

---

## 6. The strategic introductions ask — detail

The treasury product specifically benefits from a deliberate set of
introductions to:

- **Crypto-native corporate treasuries** (companies holding BTC on
  balance sheet — public miners, OG companies, recently announced
  corporate-BTC adopters)
- **DAO treasuries** (well-known DeFi protocols with significant BTC
  positions in their treasuries)
- **Fund treasuries** (crypto-native funds with idle BTC inventory)
- **OTC desk relationships beyond Falcon X** (counterparty diversification)

A partner who can make 1–3 of these introductions creates outsize value
because each treasury client compounds into the OTC volume flywheel.
**One Scenario-B treasury subscription delivers ~$1.17M annualized gross
spread**; an introduction that converts is materially more valuable than
most equity checks.

We structure this as **advisor equity:** 0.25–1% over a 4-year vest with
1-year cliff, sized to the magnitude of contribution. Independent of any
capital commitment. A partner can do this *and* a SAFE; they're separate.

---

## 7. The 90-second elevator version

For partners we meet briefly:

> Atticus operates Bitcoin protection — both retail (B2C, daily
> subscription) and institutional treasury (structured collar). The
> platform is live, hedged on every position, and structurally profitable
> across the historical Bitcoin distribution including the 2018 bear
> market and 2020 COVID liquidation. We're discussing capital because
> we've been self-funded and the pilot is now ready to scale. We have
> a menu of structures we're open to — SAFE, revenue share, pilot
> capital with warrants — and we're choosing for fit, not speed. Per
> dollar of working capital, our treasury product produces ~25–30× the
> gross spread of retail; per dollar of cumulative volume, our Falcon X
> partnership compounds into a pricing moat. The $5–10k engineering
> tranche, if a partner is interested in it specifically, ships the
> next four modules on the critical path. Or we can talk about working
> capital. Or both.

---

## 8. Next steps

For an investor who wants to engage:

1. Read `Atticus_How_It_Works.md` for the mechanics
2. Read `Atticus_Capital_Scaling.md` for the math
3. Review whichever platform spec is most relevant
   (`docs/platforms/retail_platform_spec.md` or
   `docs/platforms/treasury_platform_spec.md`)
4. Tell us which structure (A / B / C, dev capital, advisor) fits your
   situation. We'll come back with concrete terms within a short cycle.

There is no pressure to pick today. The platform operates either way.

---

## Appendix — Indicative Term Outlines

**Structure A (SAFE) — example terms:**
- Principal: $50–150k
- Valuation cap: $3M post-money
- Discount: 20%
- Trigger: qualified financing of $1M+
- MFN rights: yes
- No interest, no maturity

**Structure B (Revenue share) — example terms:**
- Principal: $50–150k
- Participation: 8–12% of platform gross spread
- Cap: 1.75× MOIC
- Reporting: monthly
- Tail: zero post-MOIC; clean termination
- Variant: optional 1% equity warrant at MOIC trigger

**Structure C (Pilot + warrants) — example terms:**
- Principal: $50–100k
- Repayment: $250k cumulative platform revenue OR 18 months
- Coupon: zero
- Warrants: 2% equity at $3M strike valuation, 4-year exercise window

**Dev capital tranche — example terms:**
- Principal: $5–10k
- Allocation: senior dev contractor for 6–10 weeks
- Deliverables: 4 modules per §5
- Repayment: rolled into whichever main structure the partner chose, OR
  warranted at SAFE-cap-equivalent if standalone
- Reporting: weekly status, module completion gated to milestone payment

**Strategic introductions / advisor — example terms:**
- Equity: 0.25–1% over 4 years
- Cliff: 1 year
- Acceleration: standard double-trigger
- Independent of any capital commitment

---

*End of Atticus — Investor Pitch & Funding Structures.*
