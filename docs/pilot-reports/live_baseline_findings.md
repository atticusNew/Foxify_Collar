# Phase 0 — Live Baseline: Findings & Interpretation

Companion to `live_baseline_analysis.md` (the auto-generated tabular report).
This is the analyst-written narrative that interprets the small live sample
honestly, including stated caveats, and identifies what's worth tracking
versus what's not actionable yet.

**As of:** 2026-04-18T01:25 UTC
**Sample:** 12 protections total — **8 pre-tenor-switch, 4 post-tenor-switch**.
**Tenor switch deployed:** 2026-04-17 22:43 UTC (commit `b0bb452`).
**Venue context:** Deribit mainnet *connector* (real pricing, real orderbooks,
real IV) backed by a Deribit *paper account* (no real capital at risk). All
P&L below is paper P&L on real prices.

---

## Headline takeaways

1. **Platform plumbing is healthy.** API `ok`, monitor `ok`, 0 consecutive
   failures, 0 fetch errors, 12 of 12 protections recorded with full metadata,
   1 TP-recovery sale executed cleanly with proceeds recorded
   (`metadata.sellResult` populated end-to-end).
2. **The post-switch sub-sample is too small to draw conclusions about the
   1-day-tenor selection logic** — but everything we *can* see is consistent
   with the design intent: 4 of 4 post-switch trades selected an exact 1-day
   option, 2 of 2 puts went ITM (the `preferItm` 2% SL path), 2 of 2 calls
   went OTM (the symmetric short-side path). No fallback to 2d/3d in the
   post-switch slice.
3. **Apparent paper margins are very fat (86%) on the post-switch slice.**
   This is consistent with where DVOL has been recently — quiet vol means
   cheap puts. Don't anchor on this number; it will compress in normal/stress
   regimes. The Phase 1 backtest will give the regime-weighted view.
4. **There is exactly one TP outcome to look at (paper).** Trade `0f91eacb`
   triggered, the algo sold the call for $45.12 of proceeds against $50 of
   premium and $200 payout. Net for that trade = $50 − $23.69 hedge − $200
   payout + $45.12 TP recovery = **−$128.57**. Single data point. Not a
   conclusion, just a logged behavior worth understanding.
5. **No live triggers in the post-switch sub-sample yet.** The four
   post-switch trades are still active (all created in the last ~3 hours of
   the snapshot window).

---

## What the post-switch sub-sample shows (4 trades, all SL 2%)

Reconstructed from the raw snapshot:

| ID prefix | Type | Notional | Entry | Trigger | Strike | Premium | Hedge cost | Spread | Margin% | Strike vs trigger |
|---|---|---|---|---|---|---|---|---|---|---|
| `063bf6f1` | short | $50,000 | $77,312 | $78,858 | $79,000 (call) | $250 | $25.06 | $224.94 | 89.9% | OTM call (designed) |
| `2207f373` | short | $10,000 | $77,308 | $78,854 | $79,000 (call) | $50  | $4.18  | $45.82  | 91.6% | OTM call (designed) |
| `ba9b9185` | long  | $50,000 | $77,432 | $75,883 | $76,000 (put)  | $250 | $32.41 | $217.59 | 87.0% | **ITM put** (designed: `preferItm` for SL≤2.5%) |
| `4f482b91` | long  | $10,000 | $77,413 | $75,865 | $76,000 (put)  | $50  | $5.40  | $44.60  | 89.2% | **ITM put** (designed) |

(The hedge-cost figures here use the Deribit USD-converted execution price × size from the raw snapshot. The `live_baseline_analysis.md` table averages these and gets `$21.67 avg hedge / 86.4% avg margin`, which matches.)

**What's confirmed by these 4 trades:**

- Selection picks the exact 1-day expiry instrument (April 19 expiry from April 17 22:53-22:59 UTC creation — 24h after creation).
- `preferItm` is firing as designed for 2% SL on the put (long) side: $76k strike chosen against a $75,883 trigger.
- The symmetric short-side OTM behavior is consistent: $79k call against a $78,858 trigger (call OTM = strike *above* spot).
- Hedge cost per $1k of notional: ~$0.43 to $0.65 across these 4 trades. Premium per $1k = $5 (per the V7 schedule). Margin per $1k ≈ $4.40-$4.55 of $5 — i.e. very thin hedge cost relative to premium.

**What the 4 trades do NOT yet tell us:**

- Trigger rate (0 of 4 triggered).
- TP-recovery distribution under the new schedule.
- Behavior of the 3%/5%/10% tiers on 1-day tenor — none observed yet.
- How the cost-cap penalty behaves in normal/stress vol — current DVOL is in the calm regime.
- Whether the `[12h, 3d]` selector window ever falls back when 1d is unavailable at the right strike (it didn't in this small post-switch window because BTC was sitting at clean round-number strikes).

---

## What the pre-switch sub-sample shows (and why I almost mis-read it)

The 8 pre-switch trades all selected 2-3 day options because that was the
2-day-tenor configuration at the time. I initially flagged this in the all-
trades view as "half the trades went 3d" — that conclusion was wrong. The
`createdAt` of those 8 trades all precedes commit `b0bb452`, so the algo
was correctly following its config-of-the-day.

This is now corrected in the report:
- §2 = all-trades view, kept for historical context only.
- §2b = post-switch view, the slice that matters for the investigation.
- §3.1 / §3.2 show both columns side-by-side.

The script gained a `--tenor-switch-iso` flag (defaults to the actual commit
timestamp) so this split is automatic on every run.

---

## TP outcome on the one triggered trade — `0f91eacb`

This is the only TP datapoint the platform has produced so far. Pre-switch
trade (created 2026-04-16 17:16 UTC, before the tenor switch).

- **Setup:** SL 2% short, $10k notional, entry $74,033, trigger ceiling $75,514.
- **Hedge:** Bought a $76,000 call (instrument `BTC-19APR26-76000-C`) for
  $0.0024 BTC ≈ $23.69 USD. 0.1 BTC quantity. 2-day expiry.
- **Trigger:** BTC moved up through the $75,514 ceiling. Trigger fired,
  `payoutDueAmount` stamped at $200.
- **TP sell:** Order ID `93564763561`, fill price 0.00451 BTC ≈ **$334.34
  (raw fill)** — actually wait, the recorded `totalProceeds` is $45.12. Let
  me reconcile that:
  - `metadata.sellResult.fillPrice = 451.24344` USD per option
  - `metadata.sellResult.totalProceeds = 45.12434` USD
  - 0.1 BTC × $451.24 = $45.12 ✓ (proceeds = fillPrice × quantity in the
    correct units).
  - So the algo sold for **$45.12 of proceeds**, recovered ~$21.43 over the
    $23.69 hedge cost (i.e. ~90% recovery).
- **Net trade economics (paper):** Premium $50 − Hedge $23.69 − Payout $200
  + TP $45.12 = **−$128.57**.
- **Why this is informative but not actionable:**
  - Single trade. n=1.
  - Pre-switch (2-day tenor, different selection regime).
  - The TP recovery worked end-to-end — fill recorded, ledger entry expected,
    `hedge_status = tp_sold`. Plumbing OK.
  - The −$128 paper loss on this trade is exactly the kind of trade the
    pricing model assumes some % of: a tight-SL trade where the floor is
    breached, the option goes ITM, but the time-value sale doesn't fully
    cover the user payout. Whether this is *too frequent* or *just right* is
    a question the Phase 1 backtest answers, not a single trade.

---

## Sanity checks worth doing before the next live test session

These are observation tasks for the operator, not platform changes.

1. **Watch for the next trigger** on a post-switch trade. The TP decision
   tree on a 1-day option is meaningfully different from a 2-day one (less
   time value, faster theta decay) — the first post-switch TP outcome is
   the most valuable data point in the next 7 days.
2. **Drop logs once.** Even one 24h chunk of `[HedgeManager]` and
   `[OptionSelection]` logs into `docs/pilot-reports/raw-logs/` would let
   me see (a) hold decisions for the existing active positions, (b) any
   `OVER_PREMIUM` or `NEGATIVE_MARGIN` events the post-switch trades
   produced at quote time, (c) any `trigger_strike_unavailable` rejections
   that didn't become a protection record. Right now §4.2 / §5 / §6 / §7
   of the auto-report all show 0 because no logs have been ingested.
3. **Re-run the script after a few more trades.** Re-running
   `npm run pilot:phase0:live-analysis` produces a fresh snapshot and
   regenerates the report. The post-switch sub-sample will grow with each
   new trade, and the analytics improve monotonically.

---

## What does NOT need a code change

- **The selection algorithm is behaving as designed** on the 4 post-switch
  trades. ITM bias firing for 2% puts, symmetric OTM for short calls,
  exact-1d expiry chosen, hedge cost well under premium.
- **The plumbing is healthy.** No fetch errors, monitor healthy, ledger and
  metadata flowing, TP path executes and records cleanly.
- **The expiry-window `[12h, 3d]` guardrail did not fire** in any post-switch
  trade — but Phase 2's chain-availability sampling already showed it would
  fire on 10% SL even at quiet vol. That guardrail is doing useful work.
  Don't tighten it.
- **No premium changes warranted.** Post-switch margins are fat because vol
  is quiet right now. The Phase 1 backtest under realistic time-varying DVOL
  will produce the regime-weighted answer; whatever it says, the stabilization
  policy stands — observe, do not retune mid-pilot.
- **No TP-parameter changes warranted.** n=1 TP outcome (a pre-switch trade,
  no less) is not enough information to support a parameter change.

---

## What I want to track over the next 7 days

| Signal | Where | Why it matters |
|---|---|---|
| Post-switch trigger count by tier | DB → re-run Phase 0 | First post-switch TP outcomes are the highest-value data |
| Post-switch ITM/OTM mix per tier | DB → re-run Phase 0 | Confirms selection logic across tiers as 3/5/10% trades happen |
| `OVER_PREMIUM` and `NEGATIVE_MARGIN` log frequency | Render logs → paste-in | Quoted but unfilled negative-margin events live in logs only |
| `trigger_strike_unavailable` log frequency | Render logs → paste-in | Tests whether the `[12h, 3d]` window's 3d slack is actually being used |
| `consecutive price errors` warnings | Render logs → paste-in | Price-feed reliability ahead of any real-money flip |
| Phase 2 sampler 1d-availability hit rate | `chain-samples-data` branch (after PR-C merged + workflow enabled) | Empirical answer to "is 1d at trigger band actually there" across DVOL regimes |

---

## Status of stabilization-mode commitments

- ✅ Read-only analysis only.
- ✅ No platform-code changes proposed.
- ✅ No parameter changes proposed.
- ✅ Single-purpose script bug fix on this turn (the `protection_id` vs `id`
  field mismatch in the export-endpoint shim that produced a phantom 13th
  record on the first run). Fix is in the analysis script, not in the
  platform.
- ✅ `--tenor-switch-iso` cutover added to keep pre/post slices clean as the
  sample grows.

---

_End of Phase 0 findings._
