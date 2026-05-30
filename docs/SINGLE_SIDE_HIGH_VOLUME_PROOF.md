# High-Volume Proof — Foxify @ 1000 positions/day

**Generated:** 2026-05-26T20:58:57.851Z
**Cell:** 50k/2% workhorse (the question generalizes to 7% cells separately)
**Live anchors:** BTC=$75,993.605, DVOL=35.76, hedge cost=$567/cover
**Paths per scenario:** 50,000
**Target volume:** 1000 covers/day

## Headline at 1000/day on 50k/2%

Per-cover EV scales linearly with volume (until hitting depth limits). Annualized:

| Split | Foxify EV/cover | Atticus EV/cover | Foxify annual @ 1000/day | Atticus annual @ 1000/day | Combined |
|---|---:|---:|---:|---:|---:|
| 95/5  (Foxify 95% / Atticus 5%) | +$246 | +$46 | +$89.69M | +$16.95M | +$106.64M |
| 90/10 (Foxify 90% / Atticus 10%) | +$224 | +$68 | +$81.87M | +$24.77M | +$106.64M |
| 85/15 (Foxify 85% / Atticus 15%) | +$203 | +$89 | +$74.05M | +$32.59M | +$106.64M |
| 80/20 (Foxify 80% / Atticus 20%) | +$181 | +$111 | +$66.23M | +$40.41M | +$106.64M |
| 70/30 (Foxify 70% / Atticus 30%) — baseline | +$139 | +$154 | +$50.58M | +$56.05M | +$106.64M |

### Atticus EV 95% confidence intervals (50k paths each)

| Split | Atticus EV/cover | 95% CI | Annualized at 1000/day |
|---|---:|---|---:|
| 95/5  (Foxify 95% / Atticus 5%) | +$46 | [+$46, +$47] | [+$16.85M, +$17.04M] |
| 90/10 (Foxify 90% / Atticus 10%) | +$68 | [+$67, +$68] | [+$24.58M, +$24.96M] |
| 85/15 (Foxify 85% / Atticus 15%) | +$89 | [+$88, +$90] | [+$32.30M, +$32.88M] |
| 80/20 (Foxify 80% / Atticus 20%) | +$111 | [+$110, +$112] | [+$40.03M, +$40.80M] |
| 70/30 (Foxify 70% / Atticus 30%) — baseline | +$154 | [+$152, +$155] | [+$55.48M, +$56.63M] |

### Op-fee sensitivity at 95/5 split (testing Atticus floor)

| Op fee | Foxify EV/cover | Atticus EV/cover | Atticus annual @ 1000/day |
|---:|---:|---:|---:|
| $10 | +$261 | +$31 | +$11.47M |
| $15 | +$256 | +$36 | +$13.30M |
| $25 | +$246 | +$46 | +$16.95M |
| $50 | +$221 | +$71 | +$26.07M |
| $75 | +$196 | +$96 | +$35.20M |

## Capacity analysis at 1000/day

| Metric | Value |
|---|---:|
| Concurrent active covers (1d hold) | 1000 |
| Total BTC outstanding | 1400 BTC |
| Per-direction BTC outstanding | 700 BTC |
| Foxify peak working capital | $567k |
| Activations per minute | 0.7 |
| Triggers per day expected (32% rate) | 320 |
| Salvage proceeds per day (avg $864 × 1000) | $864k |

### Depth constraint check

Bullish observed depth-within-2%-above-best-ask is **16-22 BTC** at the working strike
(empirical, 2026-05-26 validation). Deribit observed depth is **48-52 BTC** for this strike.
Combined Bullish + Deribit ≈ **64-74 BTC at one strike**.

At 1000/day with 1d hold, 700 BTC outstanding per direction. At any time:
- If covers are spread across 5 strikes: ~140 BTC per strike per direction
- If covers are spread across 10 strikes: ~70 BTC per strike per direction

✅ **Spread across ≥10 strikes (using daily expiries 26/27/28/29 May + spot drift), depth holds.**
⚠️ At single-strike concentration, would exceed Bullish single-venue depth — operations
must enforce per-strike-per-direction caps + multi-tenor routing at this scale.

### Trigger fire-storm scenario

Worst-case: BTC moves 2% in minutes, all 1000 active covers in one direction trigger.
That's 700 BTC of long puts (or calls) hitting venue bids simultaneously.

**This is a hard operational constraint at 1000/day.** Mitigations:

1. **Mandatory multi-venue + multi-tenor routing** — Bullish + Deribit + (potentially) OKX or CME options
2. **Stagger sells across 60-120s** — let bid books replenish between salvage exits
3. **Direction-balance caps** — limit per-direction concurrent BTC to total venue depth
4. **Block-trade desks** — for fire-storm exits, RFQ to OTC market makers (Galaxy, Cumberland) instead of order books
5. **Tenor diversification** — stagger across 3d, 5d, 7d expiries so triggered covers don't all hit same strike

Without these: realistic single-venue capacity is ~250-300/day. Multi-venue routing extends to ~1000-1500/day.
Beyond that requires OTC desk integration.

### Capital scaling

Foxify peak working capital: **$567k** at 1000/day on 50k/2% alone.
Fully recycles in ~1 day. Annual capital turnover = $207.0M.

- **95/5  (Foxify 95% / Atticus 5%):** Foxify annual EV +$89.69M → ROI 158× on deployed capital
- **90/10 (Foxify 90% / Atticus 10%):** Foxify annual EV +$81.87M → ROI 144× on deployed capital
- **85/15 (Foxify 85% / Atticus 15%):** Foxify annual EV +$74.05M → ROI 131× on deployed capital
- **80/20 (Foxify 80% / Atticus 20%):** Foxify annual EV +$66.23M → ROI 117× on deployed capital
- **70/30 (Foxify 70% / Atticus 30%) — baseline:** Foxify annual EV +$50.58M → ROI 89× on deployed capital

## Recommendation

At 1000/day target volume, all splits from 95/5 to 70/30 produce sustainable economics for both sides.
The split is therefore a **distribution decision**, not a viability one. Specific findings:

- **80/20** (your proposal): Foxify +$66.23M, Atticus +$40.41M.
  Both massively profitable; Foxify gets clear majority. **Recommended for 1000/day target.**
- **90/10**: Foxify +$81.87M, Atticus +$24.77M.
  Atticus still ~$10M+/yr — sustainable for the operational complexity at scale. Foxify gets even more.
- **95/5**: Foxify +$89.69M, Atticus +$16.95M.
  Atticus margin tight but still positive. Op fee becomes more important at this point.

### Per-cover Atticus floor

At 1000/day, Atticus needs ~$5-10M/yr to cover scaled operations (multi-venue routing, OTC desk integrations,
24/7 coverage, capital adequacy). At any split:

- 70/30: Atticus annual = +$56.05M → ample
- 80/20: Atticus annual = +$40.41M → strong
- 90/10: Atticus annual = +$24.77M → comfortable
- 95/5:  Atticus annual = +$16.95M → tight but ok

### Tiered split proposal (volume-scaled)

Atticus's per-cover margin matters less at higher volume. Proposed tier structure:

| Daily volume | Atticus share | Foxify share | Op fee |
|---:|---:|---:|---:|
| 0 - 50/day | 30% | 70% | $25 |
| 50 - 200/day | 25% | 75% | $25 |
| 200 - 500/day | 20% | 80% | $20 |
| 500 - 1000/day | 15% | 85% | $20 |
| **1000+/day** | **10%** | **90%** | $15 |

Atticus revenue at each tier (50k/2% alone, 50k paths MC):

- 50/day @ 70/30: +$2.80M/yr
- 200/day @ 75/25: estimate ~+$9.65M/yr (interpolated)
- 500/day @ 80/20: +$20.21M/yr
- 1000/day @ 85/15: estimate ~+$32.59M/yr (interpolated)
- 1000/day @ 90/10: +$24.77M/yr

Foxify benefits as they scale (better split at higher volume); Atticus benefits from absolute scale.

### Final recommendation

**Ship with 80/20 baseline split + tiered scaling commitment.** At 1000/day target volume on the
50k/2% cell alone, this generates **$67M Foxify + $41M Atticus = $108M/yr combined** with strong
margins of safety on both sides. Capacity-wise, multi-venue + multi-tenor + stagger logic is
**mandatory** — single-venue Bullish caps at ~300/day. Phase 0 should ship at 25-50/day to
validate, then scale through tier breakpoints as operations prove out.

---

*Generated by services/api/scripts/backtest/singleSide/runHighVolumeProof.ts*