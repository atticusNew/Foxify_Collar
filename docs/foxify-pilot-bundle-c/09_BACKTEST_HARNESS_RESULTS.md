# WS#9 Backtest Harness — Bundle C Scenario Comparison

> **Generated:** 2026-05-13T08:09:22.086Z
> **Scope:** 28-day pilot window, 2 × $50k positions/day baseline.
> **Atticus capital cap:** $12,000.
>
> **Methodology:** expected-value math over historical 1,558-day BTC distribution.
> Per-tier trigger rates and BS hedge costs sourced from
> `docs/pilot-reports/backtest_1day_tiered_results.txt`.
> Bullish hedge cost markup +15% vs Deribit baseline (per 2026-05-13 live snapshot).
> TP recovery rate 68% (R1 baseline).

---

## Headline comparison

| Scenario | 28-day P&L | Daily avg | Worst regime | Cap utilization | Bot defense |
|---|---|---|---|---|---|
| ❌ **S0_CURRENT_BASELINE** | -$12,036 | -$430 | -$5,234 | 25.1% | OFF |
| ❌ **S1_P1_AS_CODED** | -$2,842 | -$101 | -$2,243 | 27.2% | ENFORCE |
| ✅ **S2_P2_LIFT_FLOORS** | $568 | $20 | -$630 | 27.2% | ENFORCE |
| ✅ **S3_P3_BUNDLE_C** | $3,241 | $116 | -$117 | 27.2% | ENFORCE |
| ✅ **S4_P3_BULLISH_ONLY** | $3,089 | $110 | -$233 | 28.5% | ENFORCE |
| ✅ **S5_P3_NO_BOT_DEFENSE** | $441 | $16 | -$117 | 27.2% | OFF |

**Best projected scenario: S3_P3_BUNDLE_C** ($3,241 over 28 days).

---

## Scenario: S0_CURRENT_BASELINE

> Hold current deployed pricing ($25/$10k flat across regimes), Deribit-only, no anti-bot. This is what the pilot is doing today.

**Volume:**
- Total protections opened: 56
- Total notional: $2,800,000
- Total triggers fired: 10.4 (18.6% of opens)

**Day distribution:**
- Calm: 8 days | Normal: 15 days | Stress: 5 days

**Economics:**
| Component | USD |
|---|---|
| Premium income | $7,000 |
| Hedge cost | -$3,009 |
| Expected payouts | -$13,949 |
| TP recovery | $721 |
| Bot extraction (no defense) | -$2,800 |
| **Net pilot P&L** | **-$12,036** |
| Daily P&L average | -$430 |

**Per-regime breakdown (P&L):**
| Regime | Days | Trades | Premium | Hedge | Payouts | Recovery | Net P&L |
|---|---|---|---|---|---|---|---|
| calm | 8 | 16 | $2,000 | -$156 | -$2,458 | $23 | **-$591** |
| normal | 15 | 30 | $3,750 | -$1,394 | -$7,896 | $305 | **-$5,234** |
| stress | 5 | 10 | $1,250 | -$1,459 | -$3,596 | $393 | **-$3,411** |

**Per-tier breakdown (P&L):**
| Tier | Trades | Premium | Hedge | Payouts | Recovery | Net P&L | Per-trade avg |
|---|---|---|---|---|---|---|---|
| 2% | 17 | $2,100 | -$1,949 | -$5,915 | $545 | **-$5,219** | -$310.68 |
| 3% | 17 | $2,100 | -$929 | -$5,232 | $167 | **-$3,894** | -$231.80 |
| 5% | 11 | $1,400 | -$129 | -$2,128 | $9 | **-$848** | -$75.68 |
| 10% | 11 | $1,400 | -$1 | -$674 | $0 | **$725** | $64.73 |

**Risk:**
- Worst single-regime loss: -$5,234
- Cap utilization: 25.1% of $12,000

---

## Scenario: S1_P1_AS_CODED

> Switch to Design A schedule already in code ($6.50-$10/$1k for 2%). Bundle C tier set + multi-venue + anti-bot.

**Volume:**
- Total protections opened: 56
- Total notional: $2,800,000
- Total triggers fired: 10.8 (19.3% of opens)

**Day distribution:**
- Calm: 8 days | Normal: 15 days | Stress: 5 days

**Economics:**
| Component | USD |
|---|---|
| Premium income | $14,683 |
| Hedge cost | -$3,268 |
| Expected payouts | -$14,982 |
| TP recovery | $725 |
| Bot extraction (no defense) | $0 |
| **Net pilot P&L** | **-$2,842** |
| Daily P&L average | -$101 |

**Per-regime breakdown (P&L):**
| Regime | Days | Trades | Premium | Hedge | Payouts | Recovery | Net P&L |
|---|---|---|---|---|---|---|---|
| calm | 8 | 16 | $3,720 | -$163 | -$2,537 | $23 | **$1,043** |
| normal | 15 | 30 | $7,538 | -$1,493 | -$8,594 | $306 | **-$2,243** |
| stress | 5 | 10 | $3,425 | -$1,612 | -$3,852 | $397 | **-$1,642** |

**Per-tier breakdown (P&L):**
| Tier | Trades | Premium | Hedge | Payouts | Recovery | Net P&L | Per-trade avg |
|---|---|---|---|---|---|---|---|
| 2% | 17 | $6,210 | -$2,008 | -$5,915 | $545 | **-$1,168** | -$69.52 |
| 3% | 17 | $4,725 | -$1,050 | -$5,232 | $167 | **-$1,390** | -$82.74 |
| 5% | 14 | $2,225 | -$161 | -$2,660 | $12 | **-$585** | -$41.76 |
| 7% | 8 | $1,523 | -$49 | -$1,175 | $2 | **$301** | $35.79 |

**Risk:**
- Worst single-regime loss: -$2,243
- Cap utilization: 27.2% of $12,000

---

## Scenario: S2_P2_LIFT_FLOORS

> P2 pricing (raise calm/normal floors). Bundle C tier set + multi-venue + anti-bot. Conservative recommended baseline.

**Volume:**
- Total protections opened: 56
- Total notional: $2,800,000
- Total triggers fired: 10.8 (19.3% of opens)

**Day distribution:**
- Calm: 8 days | Normal: 15 days | Stress: 5 days

**Economics:**
| Component | USD |
|---|---|
| Premium income | $18,093 |
| Hedge cost | -$3,268 |
| Expected payouts | -$14,982 |
| TP recovery | $725 |
| Bot extraction (no defense) | $0 |
| **Net pilot P&L** | **$568** |
| Daily P&L average | $20 |

**Per-regime breakdown (P&L):**
| Regime | Days | Trades | Premium | Hedge | Payouts | Recovery | Net P&L |
|---|---|---|---|---|---|---|---|
| calm | 8 | 16 | $4,480 | -$163 | -$2,537 | $23 | **$1,803** |
| normal | 15 | 30 | $9,150 | -$1,493 | -$8,594 | $306 | **-$630** |
| stress | 5 | 10 | $4,463 | -$1,612 | -$3,852 | $397 | **-$604** |

**Per-tier breakdown (P&L):**
| Tier | Trades | Premium | Hedge | Payouts | Recovery | Net P&L | Per-trade avg |
|---|---|---|---|---|---|---|---|
| 2% | 17 | $7,395 | -$2,008 | -$5,915 | $545 | **$17** | $1.02 |
| 3% | 17 | $5,790 | -$1,050 | -$5,232 | $167 | **-$325** | -$19.35 |
| 5% | 14 | $3,138 | -$161 | -$2,660 | $12 | **$328** | $23.42 |
| 7% | 8 | $1,770 | -$49 | -$1,175 | $2 | **$548** | $65.26 |

**Risk:**
- Worst single-regime loss: -$630
- Cap utilization: 27.2% of $12,000

---

## Scenario: S3_P3_BUNDLE_C

> P3 aggressive pricing with rev 6 stress 2% adjustment ($11/$1k not $13). Bundle C tier set + multi-venue + anti-bot. RECOMMENDED.

**Volume:**
- Total protections opened: 56
- Total notional: $2,800,000
- Total triggers fired: 10.8 (19.3% of opens)

**Day distribution:**
- Calm: 8 days | Normal: 15 days | Stress: 5 days

**Economics:**
| Component | USD |
|---|---|
| Premium income | $20,765 |
| Hedge cost | -$3,268 |
| Expected payouts | -$14,982 |
| TP recovery | $725 |
| Bot extraction (no defense) | $0 |
| **Net pilot P&L** | **$3,241** |
| Daily P&L average | $116 |

**Per-regime breakdown (P&L):**
| Regime | Days | Trades | Premium | Hedge | Payouts | Recovery | Net P&L |
|---|---|---|---|---|---|---|---|
| calm | 8 | 16 | $5,240 | -$163 | -$2,537 | $23 | **$2,563** |
| normal | 15 | 30 | $10,575 | -$1,493 | -$8,594 | $306 | **$795** |
| stress | 5 | 10 | $4,950 | -$1,612 | -$3,852 | $397 | **-$117** |

**Per-tier breakdown (P&L):**
| Tier | Trades | Premium | Hedge | Payouts | Recovery | Net P&L | Per-trade avg |
|---|---|---|---|---|---|---|---|
| 2% | 17 | $8,775 | -$2,008 | -$5,915 | $545 | **$1,397** | $83.16 |
| 3% | 17 | $6,705 | -$1,050 | -$5,232 | $167 | **$590** | $35.11 |
| 5% | 14 | $3,613 | -$161 | -$2,660 | $12 | **$803** | $57.35 |
| 7% | 8 | $1,673 | -$49 | -$1,175 | $2 | **$451** | $53.65 |

**Risk:**
- Worst single-regime loss: -$117
- Cap utilization: 27.2% of $12,000

---

## Scenario: S4_P3_BULLISH_ONLY

> P3 pricing routed entirely through Bullish (illustrative — shows why multi-venue routing is necessary; Bullish drag dominates).

**Volume:**
- Total protections opened: 56
- Total notional: $2,800,000
- Total triggers fired: 10.8 (19.3% of opens)

**Day distribution:**
- Calm: 8 days | Normal: 15 days | Stress: 5 days

**Economics:**
| Component | USD |
|---|---|
| Premium income | $20,765 |
| Hedge cost | -$3,419 |
| Expected payouts | -$14,982 |
| TP recovery | $725 |
| Bot extraction (no defense) | $0 |
| **Net pilot P&L** | **$3,089** |
| Daily P&L average | $110 |

**Per-regime breakdown (P&L):**
| Regime | Days | Trades | Premium | Hedge | Payouts | Recovery | Net P&L |
|---|---|---|---|---|---|---|---|
| calm | 8 | 16 | $5,240 | -$163 | -$2,537 | $23 | **$2,563** |
| normal | 15 | 30 | $10,575 | -$1,528 | -$8,594 | $306 | **$759** |
| stress | 5 | 10 | $4,950 | -$1,728 | -$3,852 | $397 | **-$233** |

**Per-tier breakdown (P&L):**
| Tier | Trades | Premium | Hedge | Payouts | Recovery | Net P&L | Per-trade avg |
|---|---|---|---|---|---|---|---|
| 2% | 17 | $8,775 | -$2,008 | -$5,915 | $545 | **$1,397** | $83.16 |
| 3% | 17 | $6,705 | -$1,050 | -$5,232 | $167 | **$590** | $35.11 |
| 5% | 14 | $3,613 | -$298 | -$2,660 | $12 | **$666** | $47.56 |
| 7% | 8 | $1,673 | -$63 | -$1,175 | $2 | **$436** | $51.91 |

**Risk:**
- Worst single-regime loss: -$233
- Cap utilization: 28.5% of $12,000

---

## Scenario: S5_P3_NO_BOT_DEFENSE

> P3 pricing without anti-bot defenses (illustrative — shows defense value). Bot extracts $100/day under this config.

**Volume:**
- Total protections opened: 56
- Total notional: $2,800,000
- Total triggers fired: 10.8 (19.3% of opens)

**Day distribution:**
- Calm: 8 days | Normal: 15 days | Stress: 5 days

**Economics:**
| Component | USD |
|---|---|
| Premium income | $20,765 |
| Hedge cost | -$3,268 |
| Expected payouts | -$14,982 |
| TP recovery | $725 |
| Bot extraction (no defense) | -$2,800 |
| **Net pilot P&L** | **$441** |
| Daily P&L average | $16 |

**Per-regime breakdown (P&L):**
| Regime | Days | Trades | Premium | Hedge | Payouts | Recovery | Net P&L |
|---|---|---|---|---|---|---|---|
| calm | 8 | 16 | $5,240 | -$163 | -$2,537 | $23 | **$2,563** |
| normal | 15 | 30 | $10,575 | -$1,493 | -$8,594 | $306 | **$795** |
| stress | 5 | 10 | $4,950 | -$1,612 | -$3,852 | $397 | **-$117** |

**Per-tier breakdown (P&L):**
| Tier | Trades | Premium | Hedge | Payouts | Recovery | Net P&L | Per-trade avg |
|---|---|---|---|---|---|---|---|
| 2% | 17 | $8,775 | -$2,008 | -$5,915 | $545 | **$1,397** | $83.16 |
| 3% | 17 | $6,705 | -$1,050 | -$5,232 | $167 | **$590** | $35.11 |
| 5% | 14 | $3,613 | -$161 | -$2,660 | $12 | **$803** | $57.35 |
| 7% | 8 | $1,673 | -$49 | -$1,175 | $2 | **$451** | $53.65 |

**Risk:**
- Worst single-regime loss: -$117
- Cap utilization: 27.2% of $12,000

---

## Gate 1 decision support

- **Profitable scenarios:** 4/6 (S2_P2_LIFT_FLOORS, S3_P3_BUNDLE_C, S4_P3_BULLISH_ONLY, S5_P3_NO_BOT_DEFENSE)
- **Loss scenarios:** 2/6 (S0_CURRENT_BASELINE, S1_P1_AS_CODED)
- **Cap-exceeding scenarios:** 0/6 (none)

**Recommendation:** Choose **S3_P3_BUNDLE_C** for Gate 1 sign-off.

Reasoning: produces highest projected pilot P&L ($3,241) with 27.2% cap utilization. Worst-regime loss bounded at -$117.

**Operator action:** Approve a pricing scenario, then proceed to Day 6 of execution. If you want to revisit any assumption (tier mix, Bullish parity drag, TP recovery rate), edit the corresponding scenario config and re-run the harness.
