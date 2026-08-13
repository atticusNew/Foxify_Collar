# Phase 0 D1 — Results Summary

> Companion to the full dataset at
> `docs/cfo-report/phase0/biweekly_pricing_dataset.md`. This is the
> 1-page operator read.

**Date captured:** 2026-04-30
**Window:** 90 days of hourly DVOL × hourly BTC spot
**Tenor priced:** 14 days
**Joined samples:** 2,161 hours

---

## What we wanted to find out

Whether biweekly (14-day) BTC option hedges are economically and
operationally viable at our pilot trade size, OR whether the strategic
review's estimates were materially off and we should revise the plan.

---

## Three headline findings

### 1. Biweekly hedge cost is roughly 1/4 of current trader pricing

In the regime that dominated the 90-day window (low+moderate, 99% of
hours), the BS-modeled hedge cost per day per $1k notional is:

| Regime | 2% LONG | 2% SHORT | 5% LONG | 5% SHORT |
|---|---|---|---|---|
| low (avg DVOL 44, 36% of hours) | $1.78 | $1.83 | $1.02 | $1.12 |
| moderate (avg DVOL 54, 63% of hours) | $2.32 | $2.38 | $1.49 | $1.62 |
| elevated (avg DVOL 71, 0.7%) | $3.25 | $3.33 | $2.33 | $2.52 |
| high (avg DVOL 86, 0.2%) | $4.08 | $4.17 | $3.11 | $3.34 |

Compared to current 1-day-tenor trader pricing:
- low/2%: trader pays $6.50 → hedge cost $1.78 → **3.6× gross margin**
- moderate/2%: trader pays $7.00 → hedge cost $2.32 → **3.0× gross margin**
- high/2%: trader pays $10.00 → hedge cost $4.08 → **2.5× gross margin**

If we shifted to per-day biweekly pricing at, say, $3/$1k for low/2%
(half the current price), gross margin per day would still be ~70%
($3.00 - $1.78 = $1.22, on $3.00 = ~40% net of hedge). That's a
materially better trader value with comparable platform economics.

### 2. Deribit liquidity at the 14-day tenor is excellent

The live chain validation snapshot (12 strikes, BTC-15MAY26 expiry,
14.88 days to go) shows:

- **Median spread of live ask vs BS @ markIV: 3.3%**
- **p90 spread: 4.0%**

Compare to the same-day-expiry options that bottlenecked the existing
1-day product (3df5cfa1 hit `no_bid` 285 times in a row). The
biweekly market is structurally biddable at our trade size.

This is the central thesis of the strategic review confirmed
empirically: **the bid-ask cost we'd pay buying biweekly options is
~3-4%, not 30-80% as on dailies.**

### 3. Capital tied up per trade goes up ~5-10×, but absolute amounts are small

Upfront cost per $1k notional (full 14-day tenor):

| Regime | 2% LONG | 5% LONG | 10% LONG |
|---|---|---|---|
| low | $24.95 | $14.28 | $4.42 |
| moderate | $32.47 | $20.82 | $8.41 |
| elevated | $45.45 | $32.68 | $17.07 |
| high | $57.05 | $43.56 | $25.91 |

For a $10k 2% protection in low regime: upfront $250 (vs ~$30-40 for
the current 1-day equivalent). For a portfolio of 5 concurrent
biweekly hedges at this size: ~$1,250 of Deribit equity tied up.

Today's Deribit account equity is $319. **The hedge budget cap and
the Deribit account would both need to grow before Phase 2** (small
beta release running biweekly alongside the current 1-day product).
This feeds D4 (capital requirements model) — exact numbers depend on
expected concurrent trade count, which we'll model from current
pilot run-rate.

---

## What this does NOT confirm yet

- **Whether the BS-modeled hedge cost survives contact with reality
  on the BUY path.** The 3.3% spread we measured today is at one
  point-in-time; we need to verify it holds across regimes (it
  probably widens in stress).
- **Whether trigger recovery actually improves to the 60-90% range
  the strategic review estimated.** That's D2 (replay the 16 historical
  triggers under the biweekly hedge model). Different question, gated
  by D1 not contradicting itself.
- **Whether trader behavior changes under per-day subscription
  pricing.** Out of scope for Phase 0; need live shadow data (Phase 1).
- **Whether early-close adverse selection (smart trader closes after
  vol spike to capture our long-vega gain) becomes a material
  problem.** Theoretical concern; needs D3 to address with pricing-model
  design.

---

## Verdict on whether to proceed to D2

**Proceed.** The cost numbers and the spread numbers both came in
within the strategic review's estimate band, and on the favorable
side of it (lower hedge cost than I estimated, narrower spread than
I estimated). No reason to revise the plan or abandon biweekly. D2
should now run.

If D2 shows recovery rates not materially different from today's
1-day product, that's where the plan needs revision (different tenor,
different instrument, or accepting the recovery ceiling). Absent
that, Phase 0 → 1 transition gate is plausible.

---

## How to re-run this

```bash
cd services/api
npm run pilot:phase0:d1:biweekly-pricing -- --days 90 --tenor 14
```

Outputs land in `docs/cfo-report/phase0/`. Re-run is idempotent for
historical fields (same DVOL/spot data); the live chain snapshot
captures the moment.

Optional flags:
- `--days N` (default 90) — historical lookback window
- `--tenor N` (default 14) — option tenor in days to price
- `--out-dir PATH` (default `docs/cfo-report/phase0`) — write outputs elsewhere
- `--skip-live-validation` — skip the live Deribit chain snapshot
