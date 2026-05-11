# The Foxify-Profitability Reality

> **Founder concern raised 2026-05-10:** "Foxify is not profitable.
> They have to show profit on these. That's what they're looking to see."
>
> **Honest answer:** the founder is right that the prior memos didn't
> address this clearly. Foxify CANNOT be naively profitable on the
> Atticus premium-vs-payout flow — this is structurally impossible.
> But the right framing fixes the conversation.

---

## 1. The structural constraint (it cannot be circumvented)

For Atticus to operate, premium revenue must cover (a) trigger payouts and (b) hedge cost. Therefore:

```
Premium > Payouts + Hedge_cost
       (Atticus profit > 0)

Foxify net cost = Premium − Payouts > Hedge_cost > 0
       (Foxify ALWAYS pays more than they receive)
```

**Even if Atticus took zero margin, Foxify still pays the full hedge cost.** That's the irreducible floor:

| DVOL band | Hedge cost / pair-life | Foxify min net cost / pair-life | Foxify min $/day | Foxify min bps/day |
|---|---|---|---|---|
| Calm (<50) | $200 | **$200** | $29 | **2.9 bps** |
| Mod (50-65) | $500 (with cooldown $400) | **$400** | $57 | **5.7 bps** |
| Elev (65-80) | $1,200 (with cooldown $840) | **$840** | $120 | **12.0 bps** |
| Stress (≥80) | $2,200 (with cooldown $1,100) | **$1,100** | $157 | **15.7 bps** |
| **Blended** | — | — | **$77/day** | **7.7 bps/day** |

**At Atticus's BREAKEVEN (zero margin), Foxify still pays $77/day blended per pair = 7.7 bps/day on $100k notional.**

This is **the hedge cost being passed through**, not Atticus's markup. It's the cost of buying the actual ±2% strangle at the venue (which we confirmed at $148-262/pair/day from live Bullish RFQ on 2026-05-10).

**There is no structure where premium < payouts AND Atticus operates sustainably.** That requires Atticus to subsidize Foxify's hedge cost — a free lunch, not insurance.

---

## 2. What "profitable" really means for Foxify

Insurance is, by definition, a NET COST to the buyer in expectation. Always. That's how every insurance product works:

| Insurance type | Customer pays | Customer expected gain | Why customer buys |
|---|---|---|---|
| Auto insurance | $1,500/yr | -$1,200/yr (insurer profit) | Bounded risk → can drive |
| Equity options hedge | $500k/yr | -$300k/yr | Bounded risk → can hold leveraged book |
| Treasury credit-default swap | $50k/yr | -$45k/yr | Bounded risk → can hold debt instrument |
| **Atticus volume facility** | **$X/yr** | **−$Y/yr** | **Bounded risk → can run $50M+/day matched-pair volume** |

Foxify's actual question they should be asking — and what they're really targeting when they say "show profit":

> *"Does the Atticus structure UNLOCK enough business volume for me that the rebate/funding/spread income exceeds the protection cost?"*

That's a YES if Foxify earns >$77/day blended per pair (7.7 bps/day) from cross-venue rebates + funding + basis spread. For a desk routing $100k pair × matched volume × institutional VIP rates, this is **easily achievable** — typical institutional MM nets 10-30 bps/day on routed volume.

**Foxify's profit doesn't come from "premium < payouts." It comes from "running $50M+/day they couldn't run without bounded risk."** Without Atticus's protection, gap risk caps their position size to a fraction of what they actually deploy.

---

## 3. Reframing the conversation for Foxify CEO

The right pitch is in **bps-per-day per dollar of protected notional**, not $premium-vs-$payouts. Same math, different framing:

| Atticus margin over hedge cost | Foxify cost in bps/day on $100k notional | Tier (per pair/day) |
|---|---|---|
| 0% (Atticus breakeven, hypothetical) | 7.7 bps/day | $466/$578/$756/$825 |
| 5 % (original "tightest" — Mod 2.3 % margin, fragile) | 11.7 bps/day | $490/$605/$795/$865 |
| **~7 % (hardened recommendation)** | **13.0 bps/day** | **$490/$625/$795/$865** |
| 10% (current commercial floor) | 15.6 bps/day | $512/$635/$832/$907 |
| 15% (typical structured-products desk) | 19.6 bps/day | $536/$664/$870/$948 |
| 20% (premium quality structurer) | 23.6 bps/day | $559/$693/$908/$989 |

**Recommended tightest sustainable tier: $490 / $625 / $795 / $865 per pair per day** (Mod raised from $605 → $625 to harden Mod margin from 2.3 % → 7.4 % under realistic cooldown clip assumptions; see `PRICING_LADDER_STRESS_TEST.md`).

Foxify hears: *"For 11.7 bps/day on $100k notional, we provide unlimited bounded-risk operating capacity — more than half the cost of you self-hedging at the venue."*

This is **a competitive institutional rate.** Compare to:
- Self-hedging (Foxify buying daily strangles themselves at Bullish): ~26 bps/day in calm regime (Foxify pays $260/day for the strangle, gets the option payoff). Atticus is offering it at less than half that all-in, with operational handling.
- Perp funding rates (typical BTC perp funding cost): 5-15 bps/day in normal markets, 30-100+ bps in stress. Atticus's 11.7 bps blended is competitive vs even normal funding.
- Cross-margined institutional vol products (e.g., variance swaps): 20-50 bps/day at this notional. Atticus is 2-4× cheaper.

---

## 4. The earnings table both sides should see (hardened ~7% Atticus margin tier)

**Recommended ladder: $490 / $625 / $795 / $865 per pair per day** with cooldown enabled (Mod raised from $605 → $625 to harden the binding-constraint margin from 2.3 % to 7.4 %; rebate top tier capped at 6 % base / 8 % stretch).

### 4.1 Per-pair-life economics (balanced 35/43/14/6 weights, design-target cooldown clip)

| DVOL band | Rate | Cooldown clip | Atticus PnL | Foxify net cost | Foxify $/day | Foxify bps/day |
|---|---|---|---|---|---|---|
| Calm (35%/yr) | $490 | 0% | +$209 | $409 | $48 | 4.8 |
| Mod (43%/yr) | $625 | 20% | +$590 | $897 | $91 | 9.1 |
| Elev (14%/yr) | $795 | 30% | +$1,234 | $2,074 | $195 | 19.5 |
| Stress (6%/yr) | $865 | 50% | +$1,817 | $2,917 | $281 | 28.1 |
| **Blended** | — | — | **+$687/pair-life** | **+$1,172/pair-life** | **$130/day** | **13.0 bps** |

### 4.2 Annual P&L at scale (no rebate active yet; Phase 1 pricing)

| Scale | Atticus annual P&L | Foxify net cost |
|---|---|---|
| 4.3 pairs (Phase 1) | **$145k** | $247k |
| 12.9 pairs (Phase 2) | $434k | $740k |
| 100 pairs | $3.37M | $5.74M |
| 1,000 pairs | **$33.7M** | $57.4M |
| 10,000 pairs | **$337M** | $574M |

### 4.2.bis Annual P&L at scale (with 6 % top-tier rebate active in Phase 4+)

| Scale | Atticus annual P&L | Foxify net cost (realised) |
|---|---|---|
| 1,000 pairs (6 % rebate) | **$21M** | $42M |
| 10,000 pairs (6 % rebate) | **$210M** | $420M |
| 10,000 pairs (8 % stretch rebate) | **$170M** | $390M |

**For Foxify at 1,000 pairs:** $42M annual cost (6 % rebate active), financed by $50M+/day notional × ~10-30 bps/day = $50-150M/year of cross-venue rebate income. **Foxify nets +$10-100M/year** at the integrated business level — well within their stated "scale to $50M daily notional makes this worth it" target.

**For Atticus at 1,000 pairs:** $21M annual P&L (6 % rebate). Scales to $210M/year at 10,000 pairs ($170M at the 8 % stretch slot).

### 4.3 Sensitivity at higher Atticus margin (Foxify negotiation room)

| Atticus margin | Atticus annual @ 1k (6 % rebate) | Foxify annual cost @ 1k | Foxify cost @ 10k pairs |
|---|---|---|---|
| 5 % (original — Mod 2.3 %, fragile) | $13M | $34M | $340M |
| **~7 % (hardened recommendation)** | **$21M** | **$42M** | **$420M (base) / $390M (8 % stretch)** |
| 10% | $30M | $51M | $510M |
| 15% | $46M | $66M | $660M |
| 20% | $62M | $82M | $820M |

**The hardened ~7 % tier (Mod $625) is the structurally tightest sustainable. Going below would mean Mod margin compresses to 2.3 % at full rebate — fragile against any cost overrun in the Bullish institutional pricing tier or Falcon-X cross-venue routing rollout.** The hardened tier preserves Foxify's "$490 calm" anchor and adds only $20/pair/day in Mod (~6 % more in absolute Foxify cost) in exchange for 3× more Atticus margin headroom in the binding-constraint band.

---

## 5. The honest conversation to have with Foxify CEO

Three points to make, in order:

### Point 1: "You can't show profit on Atticus premium-vs-payouts. That's how insurance works."

> *"Insurance is structurally a net cost to the buyer. Auto insurance, equity hedge protection, credit-default swaps — every one of them. The customer profit comes from the underlying business, not from arbitraging the insurance contract. Same applies here."*

If Foxify CEO doesn't accept this premise, the deal won't work — there's no insurance product on earth that pays out more than its premium in expectation.

### Point 2: "The right metric is bps/day on protected notional, not $premium-vs-$payouts."

> *"At our tightest sustainable tier you're paying 11.7 bps/day blended on $100k notional. For comparison: BTC perp funding runs 5-15 bps/day in normal markets and 30-100+ in stress. Self-hedging at the venue costs you 26 bps/day. Variance swaps run 20-50 bps/day. We're at the low end of every comparable institutional vol product."*

This grounds it in numbers Foxify CEO recognizes from his own operating experience.

### Point 3: "The protection is what unlocks the volume that creates your profit."

> *"Without bounded protection, your matched-pair gap risk forces you to size positions at maybe 1/5 of what you actually deploy. Atticus's protection is the LICENSE to run $50M+/day. That license costs 11.7 bps/day. The rebates, funding, and basis spread you earn on $50M of routed volume should comfortably cover that cost — and the volume itself is your profit center."*

This shifts the narrative from "Atticus charging me a fee" to "Atticus enabling my business."

---

## 6. What if Foxify still wants premium < payouts?

**This is non-negotiable for Atticus.** It would require Atticus to subsidize Foxify's hedge cost — economically untenable.

Three things you can offer instead:

1. **Lower the Atticus margin to 5%.** Tightest sustainable. This is the proposed tier ($490/$605/$795/$865).

2. **Remove the calm-tier rebate floor in volume rebates.** Currently calm doesn't rebate (it's at the breakeven floor). At max-volume tier, even calm could see a 2-4% rebate, dropping calm from $490 to ~$470. Atticus calm margin goes negative, but blended remains positive. Risky.

3. **Backed-in rebate based on Atticus annual P&L.** If Atticus profits more than $X/year, rebate Y% back to Foxify. Tied to Atticus's reported numbers. Could turn Foxify net positive in scaled operation. Adds reporting complexity but it's a clear "we share the upside" signal.

**Option 3 is the strongest commercial signal** if Foxify CEO genuinely doesn't accept the insurance framing. Example structure:

```
Atticus annual P&L threshold:    Rebate to Foxify (% of Atticus excess):
  $0 - $30M           0%
  $30 - $100M         15%
  $100M+              25%
```

At 1,000 pairs with 10% Atticus margin, Atticus earns $29M/year — falls below the $30M threshold; no rebate; Atticus keeps full margin. At 10,000 pairs Atticus earns $290M/year; rebate to Foxify on the excess above $30M = 0.25 × ($290M − $30M) = $65M/year to Foxify. **Net: Atticus keeps $225M; Foxify gets $65M of "scale rebate."** Foxify CAN show direct profit on the structure if and only if Atticus is making a lot of money — aligned incentives.

---

## 7. Updated final recommendation

**Tier: $490 / $625 / $795 / $865 per pair per day** with cooldown enabled (design target: 20%/30%/50% trigger reduction in mod/elev/stress; conservative spec read of `COOLDOWN_CIRCUIT_BREAKER_SPEC.md` delivers ~1%/4%/12.5% reduction — gap to be closed by either tightening cooldown thresholds or empirical recalibration in the historical replay).

**Volume rebates capped at 6 % base; 8 % stretch slot unlocks only on demonstrated Bullish institutional + Falcon-X savings** — preserves calm at $490, rebates mod/elev/stress at scale, decouples Atticus margin from venue commitments not yet in production.

**Optional: Atticus excess-profit rebate.** If Foxify CEO genuinely needs to "show profit," add a tier-3 rebate where 15-25% of Atticus's annual profit above $30M flows back to Foxify. Aligns incentives and gives Foxify a defensible "as Atticus wins, I win" narrative.

**Foxify pays $42M/year at 1,000 pairs (6 % rebate active).** Atticus earns $21M/year at the same scale. **The deal still works, with hardened margin in the binding-constraint Mod band — exactly what the founder asked for, with structural protection against the single biggest fragility.**

---

## 8. Bottom line

> **The structural reality: Foxify always pays more than they receive in
> Atticus payouts, by a minimum of $77/day per pair (7.7 bps/day on
> $100k notional). This is hedge cost passed through, not Atticus
> markup. Foxify's actual profit comes from being able to run
> $50M+/day notional that earns rebates/funding/basis income they
> couldn't earn without bounded protection.**
>
> **Recommended: hardened ~7 % Atticus margin tier = $490 / $625 / $795 /
> $865 per pair per day, with rebate capped at 6 % base / 8 % stretch on
> demonstrated venue savings. Foxify pays 13.0 bps/day blended on $100k
> notional — competitive vs every institutional vol-product alternative.
> If Foxify CEO genuinely needs to "show profit," add an excess-profit
> rebate structure that returns 15-25% of Atticus's >$30M annual P&L
> back to Foxify; aligns incentives.**
>
> **The conversation with Foxify CEO is about reframing the metric
> (bps/day on notional, not $premium-vs-$payouts) and grounding the
> deal in standard institutional insurance economics. Without that
> reframe, the math truly is irreconcilable — but with it, the deal
> is structurally clean and competitive.**
