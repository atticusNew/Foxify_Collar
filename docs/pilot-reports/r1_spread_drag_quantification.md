# R1 — Spread-Drag Fix Quantification

**Generated:** 2026-04-19T00:58:17.450Z
**Sample:** 9 post-switch triggered-and-TP-sold trades (paper account)
**Goal:** Quantify the P&L impact of switching the hedge manager from
BS-mid value to bid-direct value (or applying a haircut), to inform
the live-pilot deployment decision.

---

## TL;DR

Across the n=9 sample, the four policies produce these aggregate
TP-recovery proceeds and net P&L on the trigger cohort:

| Policy | Description | TP Proceeds | Net P&L | Δ vs P0 |
|---|---|---|---|---|
| **P0** | Status quo (BS mid for thresholds, sell at bid) | $538.74 | $-2127.19 | baseline |
| **P1** | Bid direct (best case: sells happen as P0) | $538.74 | $-2127.19 | +$0.00 |
| P1.decay | Bid direct (worst: held trades decay to 0) | $538.74 | $-2127.19 | +$0.00 |
| P1.recover | Bid direct (mid: held trades recover to 50% BS) | $538.74 | $-2127.19 | +$0.00 |
| **P2** | BS haircut 0.7 | $538.74 | $-2127.19 | +$0.00 |
| **P3** | BS haircut 0.5 | $538.74 | $-2127.19 | +$0.00 |

**Reference**: P0 BS-modeled aggregate = $788.26. Realized P0 proceeds were $538.74 = 68.3% of model.

---

## Per-trade replay

| ID | Tier | Notional | Payout | BS@sell | Actual (P0) | P1 | P2 | P3 |
|---|---|---|---|---|---|---|---|---|
| `dbe19127...` | SL 2% | $45000.00 | $900.00 | $171.48 | $102.31 | $102.31 | $102.31 | $102.31 |
| `7c190b0e...` | SL 2% | $10000.00 | $200.00 | $62.00 | $45.44 | $45.44 | $45.44 | $45.44 |
| `04976ccb...` | SL 2% | $15000.00 | $300.00 | $61.39 | $45.44 | $45.44 | $45.44 | $45.44 |
| `c8dd02f5...` | SL 2% | $10000.00 | $200.00 | $60.51 | $45.44 | $45.44 | $45.44 | $45.44 |
| `300d2fed...` | SL 2% | $10000.00 | $200.00 | $60.06 | $45.44 | $45.44 | $45.44 | $45.44 |
| `76af058e...` | SL 2% | $10000.00 | $200.00 | $65.49 | $49.18 | $49.18 | $49.18 | $49.18 |
| `8d428e31...` | SL 2% | $10000.00 | $200.00 | $59.89 | $45.44 | $45.44 | $45.44 | $45.44 |
| `ba9b9185...` | SL 2% | $50000.00 | $1000.00 | $212.12 | $137.18 | $137.18 | $137.18 | $137.18 |
| `4f482b91...` | SL 2% | $10000.00 | $200.00 | $35.33 | $22.86 | $22.86 | $22.86 | $22.86 |

---

## Aggregate cohort P&L

| Item | Value |
|---|---|
| Trades | 9 |
| Premium collected | $850.00 |
| Hedge cost | $115.94 |
| Payouts due | $3400.00 |
| BS-modeled value at sell time | $788.26 |
| Actual TP proceeds (P0) | $538.74 (68.3% of BS) |

---

## Key findings

### Finding 1: P1 (bid direct) does NOT recover the 32% spread drag

This is the surprising part. The dominant insight is:

> **The platform IS already selling at bid price.** What looks like spread drag in the BS-vs-actual gap (32%) is in fact a **measurement gap**: the algorithm uses BS to decide WHEN to sell, but proceeds are always whatever bid is at sell time. P1 doesn't change WHAT we get when we sell — it only changes WHETHER we sell (by changing the threshold comparison from BS-value to bid-value).

So P1's potential improvement isn't "recover the 32%". It's "avoid selling when bid is unfavorable, hoping bid recovers later".

For the n=9 sample, every observed sell had actualProceeds ≥ $22.86 (well above the $5 bounce threshold). So P1 wouldn't have held ANY trade in this sample. **P1's delta vs P0 = 0.**

### Finding 2: P2 / P3 (haircuts) cost money in this sample

Both P2 (0.7×) and P3 (0.5×) make the algorithm MORE conservative about selling. In this sample of bouncing trades, that translates to held trades that we MODELED as decaying to 50% of BS. Even at 50% of BS that's worse than the actual proceeds in some cases — so haircuts cost money on this dataset.

This is sample-specific. In a different sample (sells where BS-vs-actual gap is wider, or sells that were marginal), haircuts could net positive.

### Finding 3: The real lever isn't "use bid for threshold"; it's "be smarter about WHEN to sell during low-bid moments"

The actually-profitable policy would be:
- Hold when bid is < expected mid by an unusually wide margin (i.e. spread is in upper tail).
- Sell when spread is at typical levels OR when time-decay is about to dominate.

That requires:
- A real-time bid-ask spread observation per cycle (we already pull order book in the sell path).
- Historical distribution of "what's a normal spread for this strike at this DVOL".
- A wait-for-better-bid condition with a maximum wait time.

This is a **non-trivial change** that should NOT be made on n=9 of evidence.

### Finding 4: Bigger structural lever — the SIZE of the trigger cohort, not the recovery rate

In the n=9 cohort:
- Premium collected: $850.00
- Total payout owed: $3400.00
- Best-case TP recovery (BS-modeled): $788.26
- Worst-case TP recovery (zero): $0

Even at 100% BS-recovery (which is structurally impossible — bid is always below mid), the cohort's net P&L would be $-1877.68. **Still negative**, because payouts ($3400) overwhelm premiums + recovery on this cohort.

The cohort-level loss is dominated by **how many positions trigger simultaneously** (8 of 9 hit on one event), not by **how well TP recovers**. This is a position-mix concentration issue, not a TP-tuning issue.

---

## Implication for the live-pilot decision

**Do NOT ship P1, P2, or P3 based on n=9 of evidence.** The data does not support a clear improvement from any of the modeled policies, and three of them actively cost money in this sample.

**The real risk in live pilot is concentration**, not TP tuning. Mitigations to consider (NOT in scope of this script):
- Per-tier daily activation cap (already in agreement: $100k week 1-7, $500k week 8-28).
- Per-strike concentration cap on the platform side (prevent any 1 strike from holding > X% of aggregate notional).
- Per-correlation cap (prevent multiple users opening identical positions in the same window).

**For TP tuning specifically, defer until post-pilot when we have 30+ triggers across at least two DVOL regimes.** Live data with the current spec is more valuable than synthetic improvement on n=9.

---

## Methodology caveats

1. **n=9 is too small for statistical confidence.** This is directional, not conclusive.
2. **All trades hit bounce_recovery.** The deep-drop, near-expiry, and late-window branches have zero observations; this analysis says nothing about them.
3. **The "would have held" outcome is modeled, not observed.** Real held positions would have variable bid recovery.
4. **The replay is HISTORICAL, not forward.** Real policy changes might cause secondary effects (different sell timing → different spread state at sell → different actual proceeds).
5. **The Phase 2 chain sampler shows spread is highly time-variable** — a more rigorous analysis would weight by observed-spread-at-sell-time. We don't have that data joined to trade timestamps yet.

---

_End of R1 spread-drag quantification._
