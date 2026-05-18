# Phase 0 D3 — Results Summary

> Companion to the full proposal at
> `docs/cfo-report/phase0/per_day_pricing_model.md`. This is the
> 1-page operator read.

**Date captured:** 2026-04-30
**Inputs:** D1 pricing dataset (BS hedge cost surface), 30% gross margin floor, 14-day tenor, 7-day average hold assumption, 150% recovery on trigger (per D2 mean).

---

## What we wanted to find out

D1 confirmed biweekly hedges are cheap (~$1.78/day per $1k for low/2%).
D2 confirmed recovery is dramatic (~150% of payout). D3 translates
those into a concrete trader-facing rate table that:
- Stays competitive (cheaper than current 1-day product)
- Maintains gross margin against BS hedge + spread + payouts
- Has clear handling for vol regime shifts mid-protection
- Has clear handling for early close

---

## Proposed rate table

**USD per $1k notional per day, locked at activation:**

| Regime | 2% SL | 3% SL | 5% SL | 10% SL |
|---|---|---|---|---|
| **low** | **$2.50** | **$2.50** | **$1.50** | **$1.00** |
| **moderate** | **$3.50** | **$3.00** | **$2.50** | **$1.00** |
| **elevated** | **$5.00** | **$4.50** | **$3.50** | **$2.00** |
| **high** | **$6.00** | **$5.50** | **$5.00** | **$3.00** |

Method: rate = BS hedge cost × (1 + spread%) × 1.30 (30% margin), rounded UP to nearest $0.50.

## Trader pays materially less under biweekly

Comparison vs current 1-day rates (negative = trader saves money):

| Regime | 2% | 3% | 5% | 10% |
|---|---|---|---|---|
| low | **−$4.00** | **−$2.50** | **−$1.50** | **−$1.00** |
| moderate | **−$3.50** | **−$2.50** | **−$0.50** | **−$1.00** |
| elevated | **−$3.00** | **−$1.50** | $0.00 | $0.00 |
| high | **−$4.00** | **−$1.50** | +$1.00 | +$1.00 |

Pilot has spent ~99% of hours in low/moderate over the last 90 days. **In the dominant regime, trader pays ~half the current rate.** Even in stress, the headline 2% tier is cheaper.

## Platform economics under the proposed rates

Assumes pilot mix (notional × tier × LONG-bias), 7-day average hold, trigger rates 40%/20%/5%/1% by tier, 150% recovery on trigger:

| Regime | Revenue/trade | Hedge buy | Hedge unwind (E) | Payout (E) | Net | Margin |
|---|---|---|---|---|---|---|
| low | $275 | $392 | $343 | $117 | **$109** | **39.7%** |
| moderate | $379 | $525 | $396 | $117 | **$132** | **34.9%** |
| elevated | $546 | $760 | $489 | $117 | **$159** | **29.0%** |
| high | $666 | $988 | $570 | $117 | **$130** | **19.5%** |

All four regimes produce positive expected per-trade margin. **Stress regime margin compresses to 20%** — still positive, but should be monitored and we should consider revising rates upward if stress persists for more than a week or two.

## Five design decisions

1. **Rate locked at activation.** Trader sees one daily rate for the whole protection. Predictability is the entire UX point. Cost: platform eats vol-spike under-pricing within a single protection.

2. **Early close: no refund.** Subscription mechanics. Trader paid for protection while it was active; closing early stops future charges only. Standard SaaS pattern.

3. **Regime spike: platform eats it (bounded).** 30% margin in the rate covers ~one regime step. Stress-regime auto-renew freeze and hedge budget cap keep tail exposure bounded.

4. **Single payout per protection.** First trigger pays once, protection ends, daily charges stop. Avoids re-trigger complexity.

5. **Maximum 14-day duration.** Hard cap matching hedge tenor — no rolls needed.

## What this does NOT confirm

- **Average days held = 7** is an assumption. Actual user behavior (days 1-3 typical? days 10+ typical?) will move the rate calculus 20-30%. **Phase 1 shadow mode tracks this directly.**
- **Trigger rates** (40%/20%/5%/1%) come from a 44-trade snapshot. Future pilot data may shift these meaningfully, especially for 5%/10% tiers where the cohort is too small.
- **Recovery ratio** (150%) is from D2's cohort mean. Actual realized may differ in production.
- **Spread assumptions** (3.3% low → 10% high) are extrapolated from a single D1 chain snapshot. We'll learn empirically in Phase 1.

If average hold is shorter than 7 days, **revenue per trade drops proportionally**. Sensitivity check: at 4-day average hold, low/2% net margin drops from 40% to ~5%. This would require either rate revision UP or a "minimum daily charge" floor (e.g., 3-day minimum on every protection).

## Verdict for Phase 0 → 1 transition

**Strong proceed to Phase 1.** All four regimes produce positive expected per-trade margin. Trader pays materially less than today's product. Combined with D1 (cost confirmed), D2 (recovery confirmed), and D4 (capital sized), the analysis side of Phase 0 is **complete**.

Phase 1 (shadow mode) should track: actual average days held, actual trigger rates by tier in the live cohort, actual Deribit asks vs BS-modeled prices on representative biweekly expiries. Those three measurements close every meaningful "what if my assumption is wrong" exposure in this proposal.

---

## How to re-run

```bash
cd services/api
npm run pilot:phase0:d3:per-day-pricing
```

Optional flags:
- `--gross-margin 0.30` (default 30%)
- `--tenor N` (default 14)
- `--d1-dataset PATH`
- `--out-dir PATH`

Requires the D1 dataset; ensure D1 is generated first or pass `--d1-dataset PATH`.
