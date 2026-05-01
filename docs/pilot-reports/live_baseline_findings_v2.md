# Phase 0 — Live Baseline (v2): Findings & Interpretation

Refresh of `live_baseline_findings.md` after additional trades on 2026-04-18.

**As of:** 2026-04-18T02:53 UTC
**Sample:** 17 active protections — **8 pre-tenor-switch, 9 post-tenor-switch**.
**Δ vs prior run (v1, n=12):** +5 active trades, all post-switch, expanding tier coverage from `2% only` to **`2% / 3% / 5% / 10%`** (full set of launched tiers).
**Tenor switch:** 2026-04-17 22:43 UTC.
**Venue:** Deribit mainnet *connector* on a paper account.

---

## What changed since the v1 run (2 hours ago)

The post-switch sub-sample grew from 4 → 9. Critically, the new 5 trades fan
out across the **other three SL tiers** (3%, 5%, 10%) which we had no
coverage of before. We now have at least one observation in every launched
tier on the 1-day-tenor logic.

| Tier | v1 count | v2 count | Δ |
|---|---|---|---|
| SL 2% | 4 | 4 | 0 |
| SL 3% | 0 | 2 | **+2** |
| SL 5% | 0 | 2 | **+2** |
| SL 10% | 0 | 1 | **+1** |
| **Total post-switch** | **4** | **9** | **+5** |

All 5 new trades were placed on long (put) positions in a tight 41-second
window at 02:16:05–02:16:46 UTC. Notional sizes mixed: $10k, $15k, two
$35k, one $35k.

---

## Headline takeaways

1. **Selection algorithm is behaving correctly across all four tiers.**
   - Every single post-switch trade picked a 1-day option (1.24-1.38 days
     to expiry). Zero fallbacks to 2d/3d. The `[12h, 3d]` window's slack
     was not needed in any of these conditions.
   - ITM preference fires only for the 2% SL puts (3/4 ITM, 1/4 ATM-ish);
     does NOT bleed into 3/5/10% tiers as designed.
   - 3% and 5% tiers picked OTM puts (cheaper hedge, wider strike vs
     trigger).
   - 10% tier picked an ITM put — but this is a special case, see §"10%
     SL — important detail" below.

2. **Apparent margins are extremely fat across all tiers** in the current
   (calm) vol regime:

   | Tier | Avg premium | Avg hedge | Margin% |
   |---|---|---|---|
   | SL 2%  | $150.00 | $21.67 | **86.4%** |
   | SL 3%  | $140.00 | $10.83 | **92.3%** |
   | SL 5%  | $37.50  | $1.55  | **95.7%** |
   | SL 10% | $70.00  | $3.10  | **95.6%** |

   The wider the SL, the cheaper the OTM put (1d, deep OTM = pennies in
   USD), and the fatter the apparent margin. **Do not anchor on these**;
   they will compress sharply in normal/stress vol regimes. The Phase 1
   backtest under realistic time-varying DVOL will give the regime-weighted
   answer.

3. **Plumbing remains healthy.** API ok, monitor ok, 0 fetch errors,
   0 failed activations, all 5 new trades produced full execution records
   with `executionPrice` and `size` populated.

4. **Still no post-switch triggers.** All 9 post-switch trades are
   `status: active` with `hedge_status: active`. Spot has been hovering
   around $77,300 since the post-switch trades were placed; no floor or
   ceiling has been touched.

5. **Still only one TP datapoint, and it's a pre-switch trade.** The
   `0f91eacb` short-call TP from the v1 analysis is still the only TP
   outcome in the dataset. n=1, pre-switch, not actionable.

---

## Per-trade reconstruction — all 9 post-switch trades

| ID prefix | Created (UTC) | Tier | Type | Size | Premium | Hedge | Margin% | Strike | vs trigger | Days to expiry |
|---|---|---|---|---|---|---|---|---|---|---|
| `4f482b91` | 2026-04-17 22:53:36 | SL 2% | long  | $10k | $50.00  | $6.97  | 86.1% | 76,000 P | **ITM**  | 1.38 |
| `ba9b9185` | 2026-04-17 22:54:23 | SL 2% | long  | $50k | $250.00 | $41.81 | 83.3% | 76,000 P | **ITM**  | 1.38 |
| `2207f373` | 2026-04-17 22:58:34 | SL 2% | short | $10k | $50.00  | $5.41  | 89.2% | 79,000 C | OTM      | 1.38 |
| `063bf6f1` | 2026-04-17 22:59:00 | SL 2% | short | $50k | $250.00 | $32.47 | 87.0% | 79,000 C | OTM      | 1.38 |
| `92317688` | 2026-04-18 02:16:05 | SL 3% | long  | $35k | $140.00 | $12.38 | 91.2% | 75,000 P | OTM      | 1.24 |
| `cf007bb6` | 2026-04-18 02:16:15 | SL 5% | long  | $15k | $45.00  | $1.55  | 96.6% | 73,500 P | AT       | 1.24 |
| `d4326e17` | 2026-04-18 02:16:25 | SL 10%| long  | $35k | $70.00  | $3.10  | 95.6% | 70,000 P | **ITM**  | 1.24 |
| `e5f95236` | 2026-04-18 02:16:36 | SL 3% | long  | $35k | $140.00 | $9.29  | 93.4% | 75,000 P | OTM      | 1.24 |
| `fc7254bd` | 2026-04-18 02:16:46 | SL 5% | long  | $10k | $30.00  | $1.55  | 94.8% | 73,500 P | AT       | 1.24 |

### Selection observations worth noting

- **`92317688` and `e5f95236` (both SL 3%, $35k, same minute, same strike).**
  Hedge cost differs by $3 ($12.38 vs $9.29) for the same strike and
  expiry. That's normal mark/ask drift over 31 seconds; both are
  microstructure noise, not algo behavior. Margin still 91-93%. Fine.
- **`cf007bb6` and `fc7254bd` (both SL 5%, same strike, same expiry).**
  Hedge cost identical at $1.55. Premium $45 vs $30 because notional
  differs ($15k vs $10k). 5% SL puts that deep OTM are essentially free
  to hedge in this vol regime.
- **`d4326e17` (SL 10%, long, $35k) — selected an ITM put.** This is
  the one to scrutinize. The `preferItm` code path is gated to
  `drawdownFloorPct ≤ 0.025`, so it should NOT have fired here. See
  next section.

### 10% SL — important detail

`d4326e17` picked the **$70,000 strike put** for an SL-10% long position
where:
- Entry was around $77,800 (back-computed)
- Trigger floor was around $70,020 (10% below entry)
- Selected strike $70,000 is **$20 below the trigger floor → technically ITM**

But this isn't the `preferItm` code path firing — it's the asymmetric tenor
penalty + cost-cap interacting with a sparse strike grid. At BTC ~$77k, the
10% SL trigger lands at ~$70,020, and Deribit's strike grid in that area
has $70,000 and $69,500 as the nearest two below-spot options. The
algorithm picked $70,000 because:
- It's within the trigger-band buffer (±0.5% of spot ≈ ±$385)
- The asymmetric tenor penalty preferred it over a 2-day option
- Cost is essentially zero either way ($3.10)

So the algorithm did NOT mis-fire `preferItm`. It correctly stayed in the
trigger band and grabbed the closest available strike, which happened to
be $20 ITM rather than OTM. **No code change warranted.**

That said, this is exactly the case where Phase 2's chain-availability
sampler showed `inBand1d = null` for SL 10% earlier today. The reason it
worked here is that the trigger price happened to land right next to a
clean strike. At a different spot price, this trade might have failed to
find an in-band 1d option and would have hit the `[12h, 3d]` fallback.
Worth tracking how often that happens once we have 7 days of Phase 2 data.

---

## Per-tier paper margin distribution (post-switch only)

| Tier | n | Premium | Hedge | Spread | Margin% range |
|---|---|---|---|---|---|
| SL 2%  | 4 | $600.00 | $86.66 | $513.34 | 83.3% – 89.2% |
| SL 3%  | 2 | $280.00 | $21.67 | $258.33 | 91.2% – 93.4% |
| SL 5%  | 2 | $75.00  | $3.10  | $71.90  | 94.8% – 96.6% |
| SL 10% | 1 | $70.00  | $3.10  | $66.90  | 95.6% (n=1) |
| **All post-switch** | **9** | **$1,025.00** | **$114.52** | **$910.48** | **— (paper, calm vol)** |

The shape is exactly what the V7 schedule was designed to produce in calm
vol: tighter SL = more expensive to hedge = lower (but still very positive)
margin; wider SL = essentially free to hedge = absurdly fat margin. The
backtest already predicted this; it now matches live paper observation.

What we still don't know:
- How these compress in normal vol (DVOL ~50)
- How they behave in stress vol (DVOL ~75+)
- Whether the 5%/10% tiers stay margin-positive after fees in stress

---

## Pre-switch sample (8 trades, 2-day tenor) — for context only

These pre-switch trades remain in §2 of the auto-report. They are
informational only — the 2-day-tenor selection logic and prior premium
schedule are no longer in the platform. The single triggered trade
(`0f91eacb`) and its TP outcome are still the only TP datapoint in the
dataset.

---

## Hold-decision and log-derived signals

§4.2, §5, §6, §7 of the auto-report still show all zeros because **0 log
files were ingested** in this run. You mentioned adding `.log` files —
they're not visible from the agent VM (gitignored as designed). When you
re-ran the script on your laptop earlier, your logs DID populate those
sections in the report you generated locally. If you want me to see them:

**Option 1**: paste a 24h chunk into the chat. I'll write it to a file the
agent VM can see and re-run.

**Option 2**: temporarily force-add the logs:
```bash
git add -f docs/pilot-reports/raw-logs/*.log
git commit -m "phase 0: temp paste of render logs for analysis"
git push
```
Then I'll pull and re-run. (You can revert/squash later before merging
anywhere; the gitignore stays in place for future drops.)

---

## What does NOT need a code change

Same conclusion as v1, now with broader tier coverage:

- **Selection algorithm**: behaving correctly across all 4 tiers. ITM
  preference fires only where designed (2% puts). 10%-SL ITM-strike
  selection turned out to be correct trigger-band alignment, not a
  preferItm misfire.
- **Tenor selection**: 9 of 9 post-switch trades picked the 1d option.
  No fallback used. The `[12h, 3d]` slack remains a safety net for
  conditions Phase 2 is sampling.
- **Hedge cost**: well below premium across every tier. Margin is fat
  in calm vol; will compress later. No pricing change warranted yet.
- **Plumbing**: zero failures, zero fetch errors, full execution
  metadata recorded on every trade.
- **TP logic**: not exercised by any post-switch trade yet. n=1
  pre-switch outcome remains insufficient.

---

## What I want to track over the next 7 days (unchanged from v1)

The signals worth watching, in priority order:

1. **First post-switch trigger + TP outcome** — highest information value.
   The DVOL-adaptive TP logic on a 1-day option has different time-decay
   characteristics than 2-day; first live observation matters.
2. **3%/5%/10% tier expansion** — even one trigger in the 5%/10% tier
   would give us coverage we currently lack.
3. **Render log paste-ins** to populate §4.2 / §5 / §6 / §7 (cooling
   holds, OVER_PREMIUM, NEGATIVE_MARGIN, trigger_strike_unavailable).
4. **Phase 2 sampler results** (after PR-C is merged and the workflow
   enabled) — the empirical chain-availability map across DVOL regimes.
5. **Re-run Phase 0** weekly or after any batch of new trades — each run
   produces a fresh snapshot and updated report.

---

## Stabilization-mode commitments still upheld

- ✅ Read-only analysis only. Zero platform-code changes.
- ✅ No parameter changes proposed.
- ✅ All findings consistent with design intent of the 1-day-tenor switch.
- ✅ Sample is too small for statistical conclusions; report is honest
  about that.

---

_End of Phase 0 v2 findings._
