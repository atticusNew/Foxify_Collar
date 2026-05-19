# Phase 0 D4 — Results Summary

> Companion to the full model at
> `docs/cfo-report/phase0/capital_requirements.md`. This is the
> 1-page operator read.

**Date captured:** 2026-04-30
**Inputs:** D1 pricing dataset (90-day BS-modeled hedge cost surface); live BTC spot $75,900; live DVOL 39.46 (low regime).

---

## What we wanted to find out

D2 confirmed biweekly hedges materially improve trigger recovery. But
the per-trade hedge cost goes from $17 (today's 1-day) to ~$471
(biweekly). With Deribit account at $319 today, **how much do we
need to fund up before Phase 2 (parallel biweekly beta) is operationally
viable?**

---

## Headline: today's account is below the floor for even one biweekly trade

| Trades supported | Today's regime (low) | Worst-case (stress) |
|---|---|---|
| 1 concurrent | $498 | $1,179 |
| 3 concurrent (current pilot run-rate) | $1,494 | $3,537 |
| 5 concurrent (Phase 2 beta target) | $2,491 | $5,895 |
| 10 concurrent (Phase 3 production) | $4,982 | $11,790 |

**Today's $319 account = 0 biweekly trades supported even in calm
regime.** Funding up is a hard prerequisite for Phase 2.

## Per-trade cost across regimes

Computed from D1's BS surface against the pilot's actual mix of
notional × tier × direction:

| Regime | Expected per-trade hedge cost |
|---|---|
| low (current) | $383 |
| moderate | $505 |
| elevated | $717 |
| high (stress) | $907 |
| weighted historical avg | $463 |

Stress is ~2.4× calm. Sizing must use stress-regime numbers since
spot can shift regime mid-portfolio.

## Recommended funding plan

Three checkpoints, each unlocks the next pilot phase. Numbers include
1.30× headroom (20% vol-spike buffer + 10% new-trade headroom):

1. **$1,500 → 1-trade smoke test in current regime.** Floor for
   running ANY biweekly trade live with operational discretion. Use
   to verify the production code path end-to-end (Phase 1 shadow mode
   doesn't need this; Phase 1 is paper).

2. **$5,000 → 3-trade pilot match.** Funds the current 3-trade
   concurrent run-rate even if regime spikes to high mid-portfolio.
   Recommended floor for Phase 2 beta launch.

3. **$12,000 → 10-trade production target.** Funds the Phase 3
   target if/when biweekly is the default product.

These are floors. **Add 30-50% above** for operational buffer
(deposit lag, opportunistic top-ups, tail safety margin). So Phase 2
beta launch realistic floor: **~$7,500**. Production target realistic
floor: **~$18,000**.

## Margin model (for reference)

Deribit `cross_sm`:
- Initial margin = premium paid (long options are fully-paid)
- Maintenance margin = $0 (no variation margin on long options)
- Cross-margin nets across longs/shorts, but the conservative side
  dominates in short-term margin
- Headroom mult: 1.30× (20% vol-spike + 10% new-trade)

We BUY puts (long protection) and BUYING calls (short protection).
We never SELL options on the hedge book, so no assignment risk.

## What this does NOT model

- **Compounding effect of recovered hedge proceeds.** D2's $610 mean
  recovery per triggered trade flows back into the account, growing
  it over time. Not modeled here. Real funding need is lower than
  the static numbers above once the platform has a few weeks of
  triggered-trade settlement under it.
- **3-sigma tail events.** The 20% vol-spike buffer covers ~1-sigma
  moves. Black swan events (March-2020-style) need separate analysis.
- **Concurrent-portfolio correlation.** All hedges are on BTC; a
  5% spot move hits every position at once. The model treats trades
  as independent for premium-sum purposes (correct for initial
  margin, conservative for variation).
- **Deposit/withdrawal timing.** Deribit settles instantly, but
  deposits take 1-2 BTC confirmations. Run with 30-50% slack to
  avoid being stuck waiting for funds during opportunities.

## Verdict for Phase 0 → 1 transition

**Capital is not a blocker for Phase 1 (shadow mode), since shadow
mode doesn't actually buy biweekly options.** Phase 1 produces real
data without real money.

**Capital IS a hard prerequisite for Phase 2.** Funding-up plan
needs to be:
- Confirmed with the user (this is a real-money request)
- Sequenced before any merge of biweekly into the live activation path
- Sized to at least $5,000 for 3-concurrent pilot match

D3 (per-day pricing model) is independent of this and can complete
in parallel.

---

## How to re-run

```bash
cd services/api
npm run pilot:phase0:d4:capital-requirements
```

Optional flags:
- `--concurrent N` (default 10) — max concurrent trades to model
- `--tenor N` (default 14) — hedge tenor; must match D1
- `--d1-dataset PATH` — alternate D1 dataset (default reads `docs/cfo-report/phase0/biweekly_pricing_dataset.json`)
- `--current-account-usd N` (default 319) — current Deribit account proxy
- `--spot-usd N` — override live spot fetch

The script needs the D1 dataset to run; ensure D1 has been generated
first (or pass an alternate path with `--d1-dataset`).
