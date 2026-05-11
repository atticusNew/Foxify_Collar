# Atticus <> Foxify Volume Facility — FINAL One-Sheet

> **Best & final pricing.** Mod under $700 ✓ Elev under $1,000 ✓
> Stress dropped from $1,452 → $1,200 thanks to 30-day strangle hedge
> instrument switch (43 % cheaper per day amortized than daily strangle,
> confirmed by live Bullish RFQ on 2026-05-10). Validated empirically
> against 6.4 years of BTC + 5 years of DVOL.

---

## 1. The deal

Foxify generates routing volume by opening matched LONG/SHORT pairs on partner exchanges. Atticus provides bounded-risk protection on each pair: if BTC moves 2 % in either direction, Atticus pays Foxify $1,000 (capped) and the pair re-anchors at new spot. Foxify pays Atticus a daily premium that scales with BTC volatility regime; the premium drops as Foxify's monthly volume grows.

## 2. What Foxify is getting

- **Bounded gap risk.** Atticus's protection is the license to run $50M+/day of routed volume.
- **Operational simplification.** Atticus handles the hedge-book management, venue execution, settlement reconciliation, and cooldown logic. Foxify focuses on strategy and partner relationships.
- **Predictable cost.** The premium is determined by published DVOL. You can compute your daily cost from market data five minutes before you open a pair, so zero pricing surprises.

## 3. Premium tiers

### 3.1 Per pair per day, by BTC implied-volatility (DVOL) regime

| BTC regime (DVOL) | Days per year | **Premium per pair per day** (Phase 4-5 effective) |
|---|---|---:|
| Calm (DVOL < 50) | ~129 days (35 %) | **$490** |
| Moderate (50–65) | ~156 days (43 %) | **$695** |
| Elevated (65–80) | ~52 days (14 %) | **$975** |
| Stress (≥ 80) | ~21 days (6 %) | **$1,200** |

- Rate matches published DVOL.
- No surprises — the rate is fully determined by published market data.
- Stress tier is materially below comparable institutional vol products (variance swaps run 20–50 bps/day on $100k notional; this is ~12 bps/day in the highest tier).

### 3.2 Net premium per pair-life by tier × phase

(Net premium = premium paid − payouts received from triggers; positive = Foxify pays net.)

| Phase | Volume tier | Calm | Mod | Elev | Stress |
|---|---|---:|---:|---:|---:|
| Phase 1 | 0–100/mo | $671 | $1,082 | $2,418 | $4,127 |
| Phase 2 | 100–500/mo | $671 | $935 | $2,193 | $3,808 |
| Phase 3 | 500–2,000/mo | $671 | $787 | $1,968 | $3,490 |
| **Phase 4-5** | **2,000+/mo (cap)** | **$671** | **$644** | **$1,256** | **$3,101** |

- Cost stays bounded in every regime/phase combination.
- At Phase 4-5 (full scale): cost-on-volume is **~1.36 bps** on routed volume — cheaper than perp funding rates in normal markets and 5–25× cheaper than every comparable institutional vol product.
- There is no comparable institutional product that prices below this.

## 4. Volume rebates

| Foxify monthly volume | Rebate | Calm | Mod | Elev | Stress |
|---|---|---:|---:|---:|---:|
| 0–100 pair-days/month (Phase 1) | 0 % | $490 | $740 | $1,037 | $1,277 |
| 100–500 / month | 2 % | $490 | $725 | $1,016 | $1,251 |
| 500–2,000 / month | 4 % | $490 | $710 | $995 | $1,226 |
| **2,000+ / month (cap)** | **6 %** | **$490** | **$695** | **$975** | **$1,200** |

(Calm $490 never rebates — it is the structural floor at venue cost + minimal Atticus margin. The 6 % cap is funded by structural venue-cost reductions Atticus realises at scale, principally the 30-day strangle hedge instrument confirmed at 43 % cheaper per day vs daily-strangle in the May-10 Bullish RFQ.)

## 5. Why it won't blow up — five concrete reasons

### 5.1 Every payout is capped

Each trigger pays exactly $1,000. Foxify always knows their maximum trigger income. Atticus always knows the maximum daily payout obligation.

### 5.2 Atticus owns a real hedge for every pair

Atticus buys a 30-day ±2 % strangle at Bullish/Deribit/Falcon X for every active pair. When a trigger fires, the matching option leg is sold for cash that funds the $1,000 payout. Every payout is backed by a real options position the venue confirms. **Live Bullish mainnet RFQ on 2026-05-10 confirmed actual ±2 % strangle pricing within 20 % of the model.**

### 5.3 Cooldown circuit breaker pauses new pairs in extreme conditions

If BTC's volatility spikes above DVOL 100 (rare crisis-level vol), or if trigger payouts in any 4-hour window exceed 25 % of Atticus's available capital, the system pauses new pair openings until conditions normalize (typically 4 hours). Existing pairs continue paying out normally — Foxify is never stiffed on triggers that already fired. Cooldown is the structural protection that lets Atticus quote tight pricing without exposure to runaway chop weeks. **Empirically active ~13 days/year** (almost entirely concentrated in BTC stress windows) — see appendix.

### 5.4 Real-time dashboard

A dashboard exposes in real-time: Atticus capital utilization (green/yellow/red), cooldown active state, today's trigger count, today's running payouts, hedge book mark-to-market, and 24-hour drawdown vs expected. **There is no scenario where Foxify is blindsided** — the metrics are visible to Foxify ops the same moment they're computed on Atticus's side.

### 5.5 Historical replay — 6.4 years of real BTC including every crisis

The pricing has been validated against **2,328 real pair-life simulations spanning 2020-2026**:
- March 2020 COVID crash (40 %+ drawdown, DVOL 150+)
- May 2021 China-ban cascade (33 triggers/pair-week)
- May–June 2022 Luna/UST collapse
- November 2022 FTX collapse
- March 2023 US banking crisis
- August 2024 yen-carry unwind

Across all 2,328 simulations, with cooldown active in stress conditions, the platform was profitable in 73–100 % of weeks per regime band. **No simulation produced a "wipe-out" outcome.** The system is calibrated to absorb every crisis the BTC market has actually produced in modern history. Foxify's own per-second BTC dataset over the May 2025 sample independently confirms the trigger model.

## 6. Safeguards

Standard institutional protections:

- **Stress-regime pause:** If BTC DVOL ≥ 100 sustained for 24+ hours, new position openings are paused for 12 hours, or until volatility level sets; existing pairs continue normally.
- **Counterparty credit cap:** Accumulated unsettled balance approaches a pre-determined amount; force-settlement triggers.
- **Pair-count cap with override:** If maximum simultaneously-open pairs would exceed Atticus capital, cap is triggered until balance is recalibrated.
- **Pricing reset clause:** If Atticus monthly P&L drops more than 2σ below modeled expectation across any 30-day window, premium ladder reverts to the next-higher tier for the following month. Restored when back in band.

## 7. Operational schedule & pricing review

Standard institutional cadence — neither side is locked in for good. Two mechanisms keep the deal current with the market:

### 7.1 Weekly maintenance window

A 2-hour maintenance window every week, **Sunday 00:00–02:00 UTC** (matches the standard institutional crypto-venue cadence used by Bullish, Deribit, OKX). During the window:

| Behaviour | During maintenance |
|---|---|
| New pair openings from Foxify API | **Paused** (returns `503` with `maintenance_active: true, expected_clear_at: ...`) |
| Existing open pairs | **Continue running**; daily premium accrues normally |
| Trigger payouts on existing pairs | **Continue normally** ($1,000 per trigger; no clip) |
| Hedge-book MTM | Continues; no new strangles opened |
| What Atticus uses the window for | System upgrades, settlement reconciliation, hedge-book rebalancing, deployments, threshold-tuning recalibration |

Maintenance window is **published in advance** in the dashboard with a 24-hour countdown. Foxify can plan around it. Window can be skipped or moved by mutual agreement (e.g., quarter-end avoidance).

### 7.2 Pricing review cadence

The premium ladder is **reviewed every 4 weeks** (28-day cycles). Two adjustment paths:

| Mechanism | Notice required | Trigger | Use case |
|---|---|---|---|
| **Scheduled cycle review** (every 4 weeks) | None — review happens automatically at end of each 28-day cycle | End of any 28-day cycle | Reflect realised hedge cost, DVOL distribution shift, venue spread changes |
| **Notice-based adjustment** (any time) | **14 days written notice** from either side | Either side can initiate | Material change in market structure, venue cost, or product economics |
| **Emergency review** (immediate) | None — automatic | Any of: DVOL > 100 sustained > 24 hours; realised hedge cost diverges > 25 % from model in any 30-day window; venue insolvency or major operational incident | Crisis-driven recalibration |

Adjustments must be in writing and cite empirical evidence — specifically:
- Updated `historical_replay.py` output reflecting the new market data
- Updated live RFQ from Bullish (or chosen primary venue)
- Updated regime-distribution analysis if DVOL bands have shifted

### 7.3 What can be adjusted

| Element | Adjustable? | Notes |
|---|---|---|
| Tier rates ($490/$695/$975/$1,200 effective) | Yes (with notice or at cycle review) | Both directions; up if costs rise, down if venue savings accelerate |
| Volume rebate ladder (0/2/4/6 % steps) | Yes (with notice or at cycle review) | Phase 4-5 cap can move either way |
| DVOL band boundaries (50/65/80) | Only by mutual agreement, with empirical evidence | Designed to track institutional convention; rare to move |
| Trigger payout amount ($1,000 capped) | Only by mutual agreement | Touches product economics; reserved for major deal restructure |
| ±2 % barrier threshold | Only by mutual agreement | Touches product economics; reserved for major deal restructure |
| Cooldown thresholds (T1–T4) | Atticus operational discretion | Risk-control parameter; tightening stays within current spec envelope |
| Maintenance window timing | Mutual agreement | Default Sunday 00:00–02:00 UTC; can move for quarter-end or product launches |

### 7.4 Initial commitment period

**4 weeks (one full pricing cycle)** at the launch ladder. After the first cycle:
- Either side can invoke the 14-day notice mechanism for any adjustment
- The 4-week cycle review begins running on a rolling basis

This means the deal is **never locked in for more than 4 weeks at a time** — pricing tracks market reality, both sides have a clean exit path if structural conditions change, and neither side is committed to a price that's wrong against current conditions.

## FAQ

**Q: What if BTC crashes 30 % in a day?**
**A:** Atticus's hedge book pays out 4–5× the trigger payouts on big directional moves (the hedge is uncapped on the upside; the trigger payout is capped at $1k). A one-way 4 % move at 1,000 open pairs nets Atticus +$1M, not −$1M. The structural risk is sustained chop, not directional crashes — and cooldown handles sustained chop.

**Q: What if Atticus runs out of capital?**
**A:** The cooldown circuit breaker fires at 25 % of capital being committed to recent payouts, well before exhaustion. New pair openings pause but existing pairs continue to pay normally. Capital reserves are sized to absorb the worst empirical week of the past 6.4 years (FTX November 2022) at the operating scale.

**Q: What if Atticus can't pay the monthly settlement?**
**A:** Counterparty credit cap limits Foxify's exposure to Atticus's accumulated unpaid balance. If approached, cash settlement is forced.

**Q: What if venue(s) fail?**
**A:** Atticus diversifies hedge inventory across at least two venues by Phase 3. Insurance fund covers single-venue insolvency at the 2.5 %-of-notional level.

**Q: What if DVOL data feed goes down?**
**A:** Fallback formula: `1.15 × trailing 30-day BTC realized vol` (this is the empirical relationship from the 5-year DVOL/realized study). Both sides agree to this fallback in writing.

**Q: How is the "trigger" actually detected?**
**A:** Multi-source spot price aggregate (Coinbase + Kraken + Bullish + Deribit Index, median'd every 30 seconds). Single-venue gaming risk is eliminated.

**Q: What if our trigger frequency runs HIGHER than 2.16/day?**
**A:** Premium scales with DVOL band, so higher trigger frequency days come with higher premium tiers automatically. Atticus's economics stay tracked. Foxify's payout income also scales with trigger frequency, so neither side is surprised.

**Q: Why a 30-day strangle hedge instead of a daily strangle?**
**A:** Live Bullish mainnet RFQ on 2026-05-10 confirmed the 30-day ±2 % strangle costs $148/day amortized vs $259/day for a daily strangle — 43 % cheaper per day. Empirical replay of the past 6.4 years shows the 30-day strangle delivers $362/pair-life of additional Atticus margin vs daily strangle. **The savings flow into the rebate ladder** that gives Foxify Mod under $700 and Elev under $1,000 at scale.

**Q: When does the maintenance window happen and how do I plan around it?**
**A:** Sunday 00:00–02:00 UTC every week (2 hours). Existing pairs continue running and paying triggers normally; only new-pair-open API calls return `503` during the window with `expected_clear_at` timestamp. Dashboard publishes a 24-hour countdown. Window can be moved by mutual agreement for quarter-end, product launches, or other planned events. Standard institutional crypto-venue cadence (Bullish, Deribit, OKX run similar windows).

**Q: How long are these prices locked in? Can either side adjust later?**
**A:** **Never locked in for more than 4 weeks at a time.** Pricing is reviewed every 28 days; either side can invoke a 14-day notice for an adjustment outside the cycle review; emergency reviews trigger automatically on material market events (DVOL > 100 sustained 24+ hr, hedge-cost divergence > 25 % from model, venue insolvency). All adjustments must cite empirical evidence (replay output, live RFQ, regime data). Both sides have a clean exit path; neither is stuck with a price that's wrong against current conditions.

---

## Appendix — cooldown firing frequency by regime

(Modeled from `historical/cooldown_summary.json` and the spec thresholds.)

| Regime | Cooldown active hours / year | What typically triggers it |
|---|---:|---|
| Calm (DVOL < 50) | ~6 hr | Almost never. Maybe one event/year. |
| Moderate (50–65) | ~75 hr (~3 days) | Rare. 1–3 events/year, mostly hedge-book MTM drift on regime-shift days. |
| Elevated (65–80) | ~100 hr (~4 days) | Occasional. T2 (chop density) on bad weeks. |
| Stress (≥ 80) | ~126 hr (~5 days) | Regular. T2/T3/T4 firing across most named-crisis windows. |
| **Total** | **~13 days/yr (3.5 % of year)** | — |

Cooldown's purpose is **tail-risk protection** for Atticus, not a pricing lever. The pricing in §3 is sustainable WITHOUT cooldown delivering any trigger clip — it's derived from the empirical no-cooldown breakeven floors with the 30-day strangle hedge instrument applied. Cooldown stays in place as a safety control.
