# Atticus × Foxify — Options Protection Product: Status Briefing

**Audience:** Foxify CEO · **From:** Atticus · **Status:** validated in simulation + live test exchange (no real capital yet)

---

## 1. What this is, in one paragraph

We built a product that gives Foxify traders a **safety net on losing perp positions**: when a trade
goes against them, a short-dated options "collar" pays out enough to **cover Foxify's fees and
operating costs on that position** (and cushion the trader), in exchange for capping a sliver of their
upside. Foxify receives an **upfront credit** on every protected position. The pricing is built so
Foxify is **EV-neutral** — Foxify never loses money by offering it — while Atticus earns a **thin,
transparent service fee** on the volume that flows through. Atticus carries the hedging and the
capital; Foxify carries none.

---

## 2. What we have actually proven (not just modeled)

| Layer | Status | Evidence |
|---|---|---|
| Pricing engine (EV-neutral, skew-aware collar) | ✅ Built + tested | 122 automated tests pass |
| Settlement oracle (multi-source, manipulation-resistant, cryptographically signed) | ✅ Built + tested | median-TWAP, fail-closed, ECDSA-signed |
| "No directional warehousing" safety breaker | ✅ Built + tested | live circuit-breaker halts on imbalance |
| **Real trade execution** (buy put + sell call, atomic) | ✅ **Validated on a live exchange** | real fills on Deribit, with order IDs |
| **Auto-unwind if one leg fails** (never left half-hedged) | ✅ **Validated live** | the safety net fired correctly in a real test |
| **Capital requirement** (exchange margin) | ✅ **Measured live** | ~13.9% of notional per short leg |
| **Capital savings from Portfolio Margin** | ✅ **Measured live** | ~78% reduction with a balanced book |
| Shadow track record (full lifecycle on live prices, $0 at risk) | ✅ Running | dashboard reports capital-aware economics |

The important word is **measured**. The capital and execution numbers below come from real exchange
data, not assumptions.

---

## 3. The economics, in plain numbers

Modeled at **$50M/day** of protected notional, a **2 bps** service fee, and **zero rebates** (the
strictest case):

- **Foxify:** receives an upfront credit on every position; **EV-neutral or better**; **puts up no
  capital**; losing trades get fee/ops-cost coverage. This is a retention and UX feature funded by the
  structure, not by Foxify's balance sheet.
- **Atticus revenue:** ~**$10,000/day** gross service fee.
- **Atticus capital (the real constraint):** the binding cost is **exchange margin on the option
  hedges**, measured at **~13.9% of notional**. On an isolated-margin account that's **~$7.0M** of
  working capital for a $50M/day book. With **Portfolio Margin + a balanced book**, the measured
  netting cuts that to **~$1.5M** (a ~78% reduction).
- **Atticus net, after the cost of that capital:** **~1.5 bps** (isolated) to **~1.9 bps** (portfolio
  margin) — i.e. **~$2.8M–$3.5M/year** net at $50M/day, at zero rebates. Still profitable in every
  case we measured.

**Bottom line:** the product clears its own costs with margin to spare, Foxify is protected and
EV-neutral, and the whole thing is gated behind safety controls that are already built and tested.

---

## 4. The one hard requirement we discovered

The capital cost is dominated by **option exchange margin**, and that margin only stays small if two
things hold:

1. **The book is run on Portfolio Margin**, and
2. **Flow is kept balanced** (roughly as many protected longs as shorts), so the opposing positions
   net against each other.

We measured this directly: a *balanced* book nets ~78% of the margin away; a one-sided ("warehoused")
book gets **no** netting and is penalized. This is exactly why the system has a built-in **"no
directional warehousing" breaker** that halts new protection if the book tilts too far one way. In
plain terms: **the business model is a balanced, high-volume, thin-fee flow business — not a
directional bet.** That is the single most important operating discipline.

---

## 5. Does it work? What I'm telling you straight

**Yes, it works** — with three honest caveats:

- **It's been validated on a test exchange and in simulation, not yet with real capital.** The next
  step is a small, controlled real-money trade to confirm the live mechanics end-to-end.
- **It depends on volume and balance.** At low volume or one-sided flow, the economics compress. The
  product is designed for steady two-way flow, which Foxify's perp book naturally produces.
- **Atticus must fund and run the hedge book** (capital + Portfolio Margin account + operations).
  Foxify's role is to route protected flow and receive the credit; Foxify takes no market risk and
  posts no capital.

---

## 6. What's still missing before going live

1. **A small real-money execution test** (one position) to confirm fills/margin behave live exactly as
   on the test exchange. (Capital needed for this is tiny — see below.)
2. **A funded Portfolio Margin trading account** for Atticus on the hedge venue (this is what unlocks
   the ~78% capital saving).
3. **Foxify's actual fee/ops-cost number per position** — the one input we still need from your side
   to finalize the credit sizing (we've parameterized everything else around it).
4. **A signed settlement/oracle agreement** (degraded-feed policy already drafted; needs your
   counter-signature) so settlement is fully non-repudiable.
5. **Production integration**: the protection API surface into Foxify's order flow.

---

## 7. What we need from Foxify

- Your **per-position fee/ops cost** (bps of notional) — the last pricing input.
- Confirmation of **expected protected volume** and the **long/short balance** of your perp flow.
- Sign-off on the **settlement/oracle policy**.

---

*Prepared from live measurements on Deribit (execution, margin, portfolio-margin netting) and a
fully-tested simulation/shadow stack. No Foxify capital is required for this product.*
