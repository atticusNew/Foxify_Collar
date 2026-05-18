# Bundle C Backtest Projection — Foxify Pilot

> **What this is:** an analytical projection of Bundle C economics (P3 pricing + all defenses + Bullish cutover) against real historical data, without writing or running new code. Built from the existing V7 backtest output (`docs/pilot-reports/backtest_definitive_v7_results.txt`, `backtest_1day_tiered_results.txt`) which used 1,558 days of BTC closes, real Deribit hedge prices, real per-tier trigger rates.
>
> **Limitations:** this is the *modeled* answer. The proper backtest (WS#9 harness, Day 5 of execution) will run the real engine end-to-end including TP simulation, anti-bot adversary simulation, and Bullish parity correction. Numbers below are point estimates with my error bars; expect ±25% on the harness output. Direction and ranking are robust.

---

## 1. Source data (from existing backtest)

### 1.1 Trigger rates (1-day tenor, 1,558 historical days)
| SL | Calm (n=467) | Normal (n=790) | Stress (n=300) | Blended |
|---|---|---|---|---|
| 1% | 46.9% | 65.3% | 69.3% | 60.6% |
| **2%** | **23.3%** | **37.2%** | **48.3%** | **35.2%** |
| 3% | 12.6% | 21.8% | 30.7% | 20.7% |
| 5% | 3.6% | 8.5% | 11.3% | 7.6% |
| 10% | 0.9% | 1.1% | 2.0% | 1.2% |

### 1.2 Hedge cost per $1k (1-DTE BS at realized vol × 0.85)
| SL | Calm | Normal | Stress | Blended |
|---|---|---|---|---|
| 2% | $0.54 | $2.15 | $5.68 | $2.35 |
| 3% | $0.11 | $0.88 | $3.38 | $1.13 |
| 5% | $0.00 | $0.10 | $0.99 | $0.24 |
| 10% | $0.00 | $0.00 | $0.01 | $0.00 |

### 1.3 Break-even premium per $1k (hedge + expected payout − recovery)
| SL | Calm | Normal | Stress | Blended |
|---|---|---|---|---|
| 2% | $3.36 | $6.40 | $10.81 | $6.34 |
| 3% | $2.89 | $5.44 | $9.86 | $5.52 |
| 5% | $1.57 | $3.55 | $5.41 | $3.32 |
| 10% | $0.86 | $1.01 | $1.83 | $1.12 |

### 1.4 Regime distribution
- Calm (DVOL < ~40): 30% of days
- Normal (DVOL 40–65): 50% of days
- Stress (DVOL > 65): 20% of days

### 1.5 Pilot configuration (locked in plan rev 4)
- Position cap: 2 × $50k/day = $100k notional/day
- Pilot duration: 28 days = 56 trades total (assuming both fill each day)
- Atticus capital: $12k
- Tier mix assumption: balanced 30% / 30% / 20% / 20% across SL 2/3/5/10

---

## 2. Pricing scenarios head-to-head

### 2.1 Premium per $1k notional, by regime

| Tier | Current (deployed) | P1 (Design A in code) | P2 (lift floors) | **P3 (recommended)** |
|---|---|---|---|---|
| 2% calm | $2.50 | $6.50 | $8.00 | **$10.00** |
| 2% normal | $2.50 | $7.00 | $8.50 | **$10.50** |
| 2% stress | $2.50 | $10.00 | $11.00 | **$13.00** |
| 3% calm | $2.50 | $5.00 | $6.00 | **$7.00** |
| 3% normal | $2.50 | $5.50 | $6.50 | **$7.50** |
| 3% stress | $2.50 | $7.00 | $9.50 | **$11.00** |
| 5% calm | $2.50 | $3.00 | $3.50 | **$4.00** |
| 5% normal | $2.50 | $3.00 | $4.00 | **$4.50** |
| 5% stress | $2.50 | $4.00 | $7.50 | **$9.00** |
| 10% calm | $2.50 | $2.00 | $2.00 | **$2.00** |
| 10% normal | $2.50 | $2.00 | $2.25 | **$2.50** |
| 10% stress | $2.50 | $2.00 | $5.00 | **$6.00** |

### 2.2 Profit per $1k notional (Premium − Break-Even), by regime

Negative = loss. Bold = stress.

| Tier × Regime | Current | P1 | P2 | P3 |
|---|---|---|---|---|
| 2% calm | −$0.86 | +$3.14 | +$4.64 | **+$6.64** |
| 2% normal | −$3.90 | +$0.60 | +$2.10 | **+$4.10** |
| **2% stress** | **−$8.31** | −$0.81 | +$0.19 | **+$2.19** |
| 3% calm | −$0.39 | +$2.11 | +$3.11 | **+$4.11** |
| 3% normal | −$2.94 | +$0.06 | +$1.06 | **+$2.06** |
| **3% stress** | **−$7.36** | −$2.86 | −$0.36 | **+$1.14** |
| 5% calm | +$0.93 | +$1.43 | +$1.93 | **+$2.43** |
| 5% normal | −$1.05 | −$0.55 | +$0.45 | **+$0.95** |
| **5% stress** | **−$2.91** | −$1.41 | +$2.09 | **+$3.59** |
| 10% calm | +$1.64 | +$1.14 | +$1.14 | **+$1.14** |
| 10% normal | +$1.49 | +$0.99 | +$1.24 | **+$1.49** |
| **10% stress** | **+$0.67** | +$0.17 | +$3.17 | **+$4.17** |

Weighted by regime distribution (30% / 50% / 20%) and tier mix (30 / 30 / 20 / 20):

| Scenario | Weighted P&L per $1k | Daily P&L on $100k notional | **28-day pilot P&L** |
|---|---|---|---|
| **Current (deployed)** | −$2.65/$1k | −$265/day | **−$7,420 (LOSS)** |
| P1 (Design A code) | +$0.59/$1k | +$59/day | **+$1,652** |
| P2 (lift floors) | +$1.85/$1k | +$185/day | **+$5,180** |
| **P3 (Bundle C)** | +$2.97/$1k | +$297/day | **+$8,316** |

### 2.3 Reading the numbers

- **Current pricing burns $7.4k of the $12k Atticus cap over 28 days from pricing alone.** Less catastrophic than my earlier estimate (which double-counted some hedge cost) but still kills the pilot.
- P1 just barely turns positive — would need every other lever to work for it to feel like a win.
- P2 produces a respectable $5k pilot profit. The "conservative win" framing holds.
- P3 produces ~$8.3k pilot profit before any other Bundle C improvements. Adds 70% of buffer above P2.

---

## 3. Bundle C — Stack the other changes on top of P3

### 3.1 Anti-bot defenses

The CEO observed 2.17 triggers/day, suggesting a bot was opening ~4 pairs/day. At deployed pricing each triggered pair pays the bot ~$870 net. 2.17 triggers/day × $870 = ~**$1,605/day to bot = −$1,605/day from platform**.

**At P3 pricing, the bot strategy is already structurally negative** (−$90 to −$150/pair/day expected — see plan §3.1). So the bot will likely exit organically. Defenses are belt-and-suspenders:
- Layer 1 alone closes the long+short pair attack
- Layers 1-4 combined: bot strategy non-viable
- Conservative net savings vs current state: **+$300/day** (assumes some bot decay before they fully exit; floor of +$100/day if they're already gone, ceiling of +$1,600/day if they were operating at full rate)

**Bundle C anti-bot value: +$300/day × 28 days = +$8,400 (mid)**

### 3.2 TP optimizations (Gap 1/3 enforce, deep-OTM writeoff, etc.)

Estimated +5–10% improvement in average recovery rate per triggered trade.
- Avg recovery per $1k for 2% = $3.05 → +5% = +$0.15/$1k
- Across all tiers blended: ~$0.20/$1k incremental
- Daily impact at $100k notional: **+$20/day = +$560 over 28 days**

### 3.3 Hedge batching (H1)

Saves Bullish/Deribit per-order fees (~$0.50–$2 per avoided order).
- At 2 trades/day, batch saves at most ~$2/day
- Negligible at pilot scale: **+$50 over 28 days**

### 3.4 Tenor max 14 → 7

Pilot is 1-DTE. No economic impact. Documentation cleanup.

### 3.5 Stress pricing overlay enable

Adds $1–$3/$1k in stress regime when triggered.
- Stress = 20% of days × maybe 30% of stress days hit overlay threshold = 6% of days
- Per active day: +$1.50/$1k × $100k = +$150
- Annualized expected: +$9/day average → **+$252 over 28 days**

### 3.6 Bullish-vs-Deribit hedge cost parity

Assumption: Bullish mainnet hedge cost is +10–20% vs Deribit. (Real number from WS#7 parity probe Day 2.)
- Avg hedge cost on $100k notional: $235/day at +0% baseline
- +15% drag: −$35/day
- **−$980 over 28 days** (mid estimate)

### 3.7 Operational guardrails

Tail-event protection, $0 expected on normal days. Catches catastrophic days that would otherwise wipe out 2-3 weeks of profit. Modeled value:
- Probability of catastrophic day during pilot: ~10%
- Catastrophic loss without guardrail: −$2,000
- With guardrail: −$500
- Expected savings: 10% × $1,500 = **+$150 over 28 days**

### 3.8 Foxify capital segregation, backtest harness

$0 direct economic impact. Architecture / accounting / validation.

---

## 4. Bundle C totals

| Component | 28-day P&L contribution |
|---|---|
| **P3 pricing baseline** | +$8,316 |
| Anti-bot defenses (mid estimate) | +$8,400 |
| TP optimizations | +$560 |
| Hedge batching (H1) | +$50 |
| Tenor 14 → 7 | +$0 |
| Stress overlay | +$252 |
| Bullish parity drag | −$980 |
| Operational guardrails (tail value) | +$150 |
| **Bundle C 28-day total** | **+$16,748** |

### 4.1 Sensitivity

| Scenario | 28-day P&L | Vs Atticus $12k cap |
|---|---|---|
| Bundle C — pessimistic (no bot, +25% Bullish drag, calm-heavy regime) | **+$5,200** | +43% buffer growth |
| Bundle C — mid (assumptions above) | **+$16,750** | +140% (more than doubles cap) |
| Bundle C — optimistic (bot still active, parity neutral, balanced regime) | **+$24,500** | +204% |

Even pessimistic case is comfortably profitable. Even at zero bot value (assume bots already left), Bundle C is +$8,300/28-day. Worst credible 28-day outcome is roughly breakeven — if regime is unfavorably skewed AND Bullish parity is 30% worse AND TP underperforms, we end with +$0 to +$2k. Hard to lose money on Bundle C.

### 4.2 Comparison to other bundles (modeled, same methodology)

| Bundle | 28-day P&L (mid) | Atticus cap survival | Verdict |
|---|---|---|---|
| Bundle A (hold pricing + all defenses) | **−$5,000 to −$8,000** | breaks cap by week 3 | NOT VIABLE |
| Bundle B (P2 + all defenses) | **+$5,000 to +$13,000** | survives + cushion | RECOMMENDED FLOOR |
| **Bundle C (P3 + all defenses)** | **+$8,000 to +$24,000** | survives + meaningful profit | **RECOMMENDED** |
| Bundle C + H2 (longer-dated hedges) | **+$10,000 to +$28,000 (if H2 works), +$2,000 to +$15,000 (if H2 misfires)** | survives | SHIP IF BACKTEST CONFIRMS H2 |

---

## 5. Per-tier breakdown for Bundle C (the per-trade math)

For a $50k position under P3 pricing in each tier × regime:

### 2% tier ($1000 payout)
| Regime | Premium | Hedge | Expected payout (35% × $1000) | TP recovery (43% × $1000) | **Net per trade** |
|---|---|---|---|---|---|
| Calm | $500 | $27 | $233 | +$152 | **+$392** |
| Normal | $525 | $108 | $372 | +$152 | **+$197** |
| Stress | $650 | $284 | $483 | +$152 | **+$35** |
| **Weighted** | $539 | $126 | $343 | +$152 | **+$222** |

### 3% tier ($1500 payout)
| Regime | Premium | Hedge | Expected payout (20.7% × $1500) | TP recovery | **Net per trade** |
|---|---|---|---|---|---|
| Calm | $350 | $6 | $189 | +$92 | **+$247** |
| Normal | $375 | $44 | $327 | +$92 | **+$96** |
| Stress | $550 | $169 | $461 | +$92 | **+$12** |
| **Weighted** | $390 | $63 | $279 | +$92 | **+$140** |

### 5% tier ($2500 payout)
| Regime | Premium | Hedge | Expected payout (7.6% × $2500) | TP recovery | **Net per trade** |
|---|---|---|---|---|---|
| Calm | $200 | $0 | $90 | +$36 | **+$146** |
| Normal | $225 | $5 | $213 | +$36 | **+$43** |
| Stress | $450 | $50 | $283 | +$36 | **+$153** |
| **Weighted** | $245 | $14 | $169 | +$36 | **+$98** |

### 10% tier ($5000 payout)
| Regime | Premium | Hedge | Expected payout (1.2% × $5000) | TP recovery | **Net per trade** |
|---|---|---|---|---|---|
| Calm | $100 | $0 | $45 | +$5 | **+$60** |
| Normal | $125 | $0 | $55 | +$5 | **+$75** |
| Stress | $300 | $1 | $100 | +$5 | **+$204** |
| **Weighted** | $145 | $0 | $58 | +$5 | **+$92** |

**At 2 trades/day balanced mix (avg per-trade P&L ≈ $147), 28-day pilot ≈ +$8,200 from pricing alone**, before stacking other Bundle C wins. Matches the $8,316 in §2.3 within rounding.

---

## 6. What this projection does and doesn't capture

**Captured:**
- Real historical trigger rates (1,558 days)
- Real Deribit hedge cost (BS at realized vol)
- Real recovery rates (R1 measurement)
- All four pricing scenarios
- All major Bundle C deltas with directional confidence

**Not captured (will require WS#9 backtest harness):**
- Day-by-day path dependency (one bad day can throttle subsequent days via cap or breaker)
- Trigger-event clustering (multiple positions triggering same day)
- Bullish-specific microstructure (waiting for Day 2 parity probe)
- Adversarial bot behavior under Layers 1-4 defenses (whether they adapt or exit)
- Real trader tier-mix demand (assumed balanced 30/30/20/20)
- Auto-renew adoption rate impact

**Confidence intervals:**
- Pricing P&L direction: very high confidence (math is direct)
- Bot defense value: medium confidence (depends on whether bots are still operating; my +$300/day is a midpoint)
- TP optimization value: medium-low confidence (Gap 1/3 still observe-only in production data)
- Bullish parity drag: low confidence (no real Bullish data yet — Day 2 parity probe resolves this)

---

## 7. Bottom line

**Bundle C projects +$16,750 over 28 days, with a pessimistic floor of +$5,200 and optimistic ceiling of +$24,500.**

Comparing to current state:
- Current pricing (no Bundle C): **−$7,420 to −$10,000** (loss)
- Bundle B (P2 minimum): **+$5,000 to +$13,000**
- **Bundle C (P3 + all defenses): +$8,000 to +$24,500**

P3 alone provides +$8,316 of expected pilot P&L. Anti-bot defenses contribute another +$8,400 (high uncertainty). Other improvements net to +$32 (small). Bullish parity is the meaningful drag at −$980.

**The dominant levers are pricing (P3) and anti-bot defenses — they account for ~99% of the Bundle C uplift.** Everything else is rounding error at pilot scale (will matter more at 10× and 100× scale).

**Decision support:** Bundle C is approved by the math. Recommend pulling the trigger pending the formal WS#9 harness output Day 5 of execution. Final pricing decision (P2 vs P3) can wait until that output, but at this point the case for P3 is strong.

---

*End of projection. Real numbers from WS#9 harness will arrive Day 5 of execution and supersede this document.*
