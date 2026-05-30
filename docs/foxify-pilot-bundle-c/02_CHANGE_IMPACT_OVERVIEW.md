# Foxify Pilot — Changes & Impact Overview (companion to PLAN.md rev 4)

> Reading guide: ↑ improves economics, ↓ worsens, → neutral, ⚡ uncertain. Magnitude is $/day on the 2 × $50k baseline.

> **Rev 4 critical update:** deployed pricing is $25/$10k (= $125 premium per $50k 2% trade), NOT the $65–$100/$10k Design A schedule in code. At deployed pricing the pilot loses $15–25k over 28 days. Pricing change is now the dominant lever.

---

## A. Pricing & product  *[rev 4: pricing magnitudes vs deployed $25/$10k baseline]*

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ Change                              │ Direction │ $/day      │ UX cost │ Revert │
├─────────────────────────────────────────────────────────────────────────────────┤
│ Tenor max 14 → 7 days               │   ↑       │ +1-5       │ none    │ env    │
│ HOLD current $25/$10k pricing       │   ↓↓↓     │ -540 to    │ none    │ n/a    │
│   (status quo deployed)             │           │ -890       │         │        │
│ Pricing P1 (Design A, code default) │   ↑↑      │ +360 to    │ medium  │ env    │
│   $6.50-$10/$1k                     │           │ +540       │ (premium│        │
│                                     │           │            │  +160%) │        │
│ Pricing P2 (lift floors)            │   ↑↑↑     │ +510 to    │ medium  │ env    │
│   $8-$11/$1k                        │           │ +680       │ (premium│        │
│                                     │           │            │  +220%) │        │
│ Pricing P3 (aggressive)             │   ↑↑↑↑    │ +650 to    │ large   │ env    │
│   $10-$13/$1k                       │           │ +840       │ (premium│        │
│                                     │           │            │  +300%) │        │
│ Stress pricing overlay enable       │   ↑       │ +5-15*     │ small** │ env    │
│ Hedge: batched buys (H1)            │   ↑       │ +3-10      │ none    │ env    │
│ Hedge: longer-dated puts (H2)       │   ⚡      │ ±30        │ none    │ code   │
│ Hedge: perp delta (H3) — REJECT     │   ↓↓      │ -∞ tail    │ none    │ —      │
└─────────────────────────────────────────────────────────────────────────────────┘
* in stress regimes only         ** premium spikes during stress
```

## B. Risk & guardrails

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Change                              │ Direction │ $/day  │ UX cost │ Revert    │
├────────────────────────────────────────────────────────────────────────────────┤
│ Anti-bot Layers 1-4 ENFORCE         │   ↑↑      │ closes │ small   │ env flip  │
│   (incl. opposing-perp defense)     │           │ -200/d │         │           │
│                                     │           │ attack │         │           │
│ Foxify pool kill-switch             │   ↑ tail  │ 0 exp  │ pause   │ env flip  │
│ Aggregate liability cap             │   ↑ tail  │ 0 exp  │ pause   │ env flip  │
│ Reconciliation drift halt           │   ↑ tail  │ 0 exp  │ pause   │ env flip  │
│ Tighter circuit breaker (50→35%)    │   ↑ tail  │ 0 exp  │ none    │ env flip  │
│ High-DVOL pause (>100)              │   ↑ tail  │ 0 exp  │ pause   │ env flip  │
│ Bullish API health pause            │   ↑ tail  │ 0 exp  │ pause   │ env flip  │
│ Daily premium velocity cap          │   ↑ tail  │ 0 exp  │ slowdwn │ env flip  │
│ Random-jitter activation cooldown   │   ↑↑      │ +5-50  │ small   │ env flip  │
│   (60-360s)                         │           │        │         │           │
│ Trigger-induced 4h fingerprint      │   ↑       │ +5-20  │ medium  │ env flip  │
│   cooldown                          │           │        │         │           │
│ Premium surcharge on suspicious     │   ↑       │ +5-15  │ medium  │ env flip  │
│   patterns (1.5x next protection)   │           │        │         │           │
│ Foxify trader binding (Layer 6)     │   ↑↑     │ closes │ none    │ env flip  │
│   — requires Foxify integration     │           │ Sybil  │         │           │
└────────────────────────────────────────────────────────────────────────────────┘
```

## C. TP & hedge management

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Change                              │ Direction │ $/day  │ UX cost │ Revert    │
├────────────────────────────────────────────────────────────────────────────────┤
│ Gap 1 (vol-spike forced exit)       │   ↑       │ +2-10  │ none    │ env flip  │
│   ENFORCE                           │           │        │         │           │
│ Gap 3 (cooling shrink) ENFORCE      │   ↑       │ +2-8   │ none    │ env flip  │
│ Deep-OTM short-tenor writeoff       │   ↑       │ +1-5   │ none    │ env flip  │
│ Per-direction recovery floor alert  │   →       │ 0 alrt │ none    │ env flip  │
│ Active TP window expansion (stress) │   ↑       │ +3-10  │ none    │ env flip  │
└────────────────────────────────────────────────────────────────────────────────┘
```

## D. Venue & infrastructure

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Change                              │ Direction │ $/day  │ UX cost │ Revert    │
├────────────────────────────────────────────────────────────────────────────────┤
│ Bullish mainnet cutover             │   ⚡      │ ?      │ none    │ env+restart│
│ Multi-venue (Bullish + Deribit)     │   ↑       │ +2-8   │ none    │ env flip  │
│ Bullish bug fixes                   │   →       │ 0      │ none    │ code      │
│ Foxify capital segregation (WS#0)   │   →       │ 0      │ none    │ env flip  │
│ T+7 withdrawal lockup               │   →       │ 0      │ Foxify  │ DB field  │
│ Backtest harness (WS#9)             │   →       │ 0      │ none    │ —         │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

## E. Aggregate impact comparison  *[rev 4]*

```
                  Bundle A           Bundle B               Bundle C
                  HOLD pricing       P2 + all defenses      P3 + all defenses
                  + all defenses                            + H2 if backtest +
                  ────────────       ──────────────────     ─────────────────
Daily P&L (avg):  -$500 to -$800     +$10 to +$50           +$80 to +$130
28-day pilot:     -$14k to -$22k     +$280 to +$1,400       +$2,240 to +$3,640
                  (LOSS)             (modest profit)        (clean profit)
Worst-day loss:   ~$1,400            ~$680                  ~$540
Bot expected:     +$200/day          -$200/day              -$1,000/day
Tail risk:        baseline           ~50% reduction         ~70% reduction
Trader UX cost:   none               small                  larger
                                     (premium 2.5x, sec     (premium 2.0x,
                                      cooldowns)             cooldowns)
Atticus capital   blown by week 2    survives full pilot    survives + buffer
```

**Bundle A is not viable.** Hold-current-pricing kills the pilot in week 2.

**Bundle B is the conservative win.** Modest profit, low retention risk, easy to justify.

**Bundle C is the recommended choice for a 28-day pilot.** Clean profit, rebuilds margin
buffer fast, easy to step down to P2 mid-pilot if adoption drops.

---

## F. Pricing options at full detail (the dominant lever)  *[rev 4]*

What the 2% premium changes for a $50k position with $1000 payout:

```
Regime         CURRENT       P1            P2            P3
               (deployed)    (Design A)    (lift floor)  (aggressive)
─────────────  ──────────    ──────────    ──────────    ──────────
Calm (DVOL≤50) $125          $325          $400          $500
Moderate       $125          $350          $425          $525
Elevated       $125          $400          $450          $550
Stress         $125          $500          $550          $650

Trader return on trigger:
Calm           8.0×          3.1×          2.5×          2.0×
Moderate       8.0×          2.9×          2.4×          1.9×
Elevated       8.0×          2.5×          2.2×          1.8×
Stress         8.0×          2.0×          1.8×          1.5×
```

Per-trade expected P&L on $50k 2% (TP recovery ~50% factored in):

```
Regime         CURRENT       P1            P2            P3
─────────────  ──────────    ──────────    ──────────    ──────────
Calm           -$280         -$80          -$5           +$95
Moderate       -$303         -$103         -$28          +$72
Elevated       -$403         -$203         -$128         -$28
Stress         -$438         -$238         -$163         -$63

Weighted by historical regime distribution (30/51/19):
Blended        -$310         -$110         -$30          +$50
```

28-day pilot P&L at 2 × $50k/day (= 2 trades/day):

```
                CURRENT          P1               P2              P3
                ──────────       ──────────       ──────────      ──────────
Total trades    56               56               56              56
Total P&L       -$17,360         -$6,160          -$1,680         +$2,800

vs $12k cap     BLOWS THROUGH    bleeds 51%       loses 14%       PROFIT 23%
```

**Read:** holding current charges trader 8× return at our expense. P1 still bleeds. P2 is breakeven. P3 is the right answer.

---

## G. Bot-defense effectiveness ladder

```
Defense layer                    Bot must do                 Cost to bot
──────────────────────────       ──────────────────────      ────────────
1. Opposite-side block           Use 2 fingerprints          Low
   (per fingerprint, 2% only)
1+2. Add random jitter           Idle 60-360s/activation     Cuts throughput 70-90%
1+2+3. Add trigger cooldown      Wait 4h after each trigger  Cuts another 80%
1+2+3+4. Add surcharge           Pay 1.5× on next trade      Negative expected value
1+2+3+4+6. Add Foxify binding    Use 2 Foxify accounts       Hard (KYC, $)
                                                              ATTACK NON-VIABLE
```

---

## H. What gets shipped / not shipped at rev 4 lock

```
SHIPPED (env flip or small code change):
  ✓ Tenor max 14 → 7
  ✓ H1 batched hedges
  ✓ Stress pricing overlay
  ✓ All TP optimizations (Gap 1/3, deep-OTM writeoff, recovery floor)
  ✓ Anti-bot Layers 1-4 (incl. opposing-perp defense)
  ✓ All Wave 1 + 2 guardrails
  ✓ Bullish mainnet cutover (with provided creds; rotate after Day 3)
  ✓ Foxify capital segregation (architecture, $0 deposit to start)
  ✓ Backtest harness — run all 4 pricing options before pricing decision
  ✓ Pricing — TBD between P2 and P3 based on backtest output Day 5

PENDING DECISION (Day 5 of execution after backtest):
  ⚖ Pricing P2 vs P3 — CEO call after seeing backtest numbers

PENDING FOXIFY (Day 1 ask, ship if accepted):
  ◯ Layer 6 Foxify trader binding — small Foxify integration

NOT SHIPPED (deferred or rejected):
  ✗ Hold current pricing — verified loss-making, not viable
  ✗ Pricing P1 — strictly dominated by P2
  ✗ H2 longer-dated hedges — pending backtest results, ship if positive
  ✗ H3 perp delta hedges — rejected
  ✗ Layer 5 open-interest aware pricing — post-pilot
  ✗ Treasury / multi-tenant / Foxify production API — separate plans
```

---

## I. Quick reference — what binds what

```
$12k Atticus cap    →  binds hedge budget at 2-3 × $50k/day depending on regime
$50k position max   →  binds individual position size
60% per-tier cap    →  binds 2% concentration
$200k aggregate     →  binds total open exposure
Daily $100k cap     →  binds new opens per day (will auto-bump to $500k Day 8)

What blocks bot:
  Layer 1 + Layer 2 + Layer 3 + Layer 4 = strategy non-viable
```

---

End of overview. Full plan and rationale in PLAN.md rev 3.
