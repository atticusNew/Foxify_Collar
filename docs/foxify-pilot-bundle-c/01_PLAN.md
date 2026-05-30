# Atticus Foxify Pilot — Production-Hardening Plan (rev 6 — EXECUTION LOCKED)

> **Live pilot status preserved.** Render production deploy auto-deploys from a separate branch (`cursor/-bc-c2468b87-...-6ba4`); our work happens on the cursor-session branch which does NOT trigger production deploys. Production untouched until explicit Gate 2 cutover.

> **Rev 6 scope:** locks final pilot config per user reply 2026-05-13 (drop 10%, add 7% as new wide tier, lift stress 2% to 1.8× trader return, branch isolation strategy). Execution begins on rev 6 lock. All prior rev content preserved; rev 6 deltas marked inline.

---

## 🚀 REV 6 EXECUTION LOCK (read first)

### Final tier set
**Drop 10%. Add 7%. Keep 2/3/5/7.** Reasoning:
- 10% on Bullish: no strikes near $73k put or $89k call; would be Deribit-only forever
- 10% lowest-margin tier ($1.72/$1k blended P&L)
- 7% fills the demand gap (12.5× → 23× return) and Bullish 1-week strike grid covers it ($75k put, $86k call)
- 8% NOT added (Bullish 1-week jumps $86k → $90k, no good 8% SHORT alignment)

### Final pricing schedule (Bundle C / P3)

| Regime | 2% (per $1k) | 3% | 5% | **7% NEW** |
|---|---|---|---|---|
| Calm | $10.00 | $7.00 | $4.00 | **$3.00** |
| Normal | $10.50 | $7.50 | $4.50 | **$3.50** |
| Stress | **$11.00** ← was $13 | $11.00 | $9.00 | **$7.00** |

Stress 2% lifted to 1.8× trader return per Q B in user reply 2026-05-13. Cost: ~$1k of pilot P&L. Other tiers unchanged.

### Final tier mix assumption
- 2%: 30% (unchanged)
- 3%: 30% (unchanged)
- 5%: 25% (+5%, picking up some 10% demand)
- 7%: 15% (NEW)
- 10%: dropped

### Branch isolation strategy
- **Production deploys from:** `cursor/-bc-c2468b87-16cc-4357-84a5-12c8079ff3c2-6ba4` (Render auto-deploy)
- **Our work branch:** `cursor/-bc-3aa2d238-ebb4-479a-98c7-2ade2838103f-6425` (cursor session branch)
- **Production untouched** until Gate 2 sign-off and explicit operator merge
- **Cutover mechanics (Day 11):** merge work branch → production branch + Render env update + 72h monitoring
- **Rollback:** revert merge commit; Render auto-deploys prior state; original protections continue functioning (DB additions are additive, no destructive migrations)

### Gates before production cutover
- **Gate 1 (Day 5 EOD)** — operator reviews WS#9 backtest harness output; signs off on pricing decision (P2 vs P3) and overall economics
- **Gate 2 (Day 10)** — operator + CEO review pre-cutover validation matrix; sign off on production cutover

### Bundle C projected pilot P&L (rev 6 with 7% tier and stress 2% adjustment)
- Mid estimate: **+$15,500 over 28 days** (was +$16,500 in rev 5; small drop from stress 2% lift and 10% drop, partially offset by 7% addition)
- Range: **+$5k to +$24k**
- Bot defense closes additional ~$8k attack surface

---

## Rev 5 changelog (carry-forward)

---

## Rev 5 changelog (read this first)

### Critical findings from live Bullish vs Deribit comparison (2026-05-13)

**Pulled live REST orderbooks from both venues.** Findings:

1. **Bullish CANNOT serve 10% tier.** Bullish has zero strikes at $73k or $89k for tomorrow's 1-DTE expiry. Lowest available strike $78k (4% below spot), highest $85k (4.7% above). 10% protection (which needs $73k put or $89k call) is completely uncoverable on Bullish at 1-DTE. Same true at 1-week expiry (lowest $70k, highest $90k — covers 10% only when BTC is at $80k spot, which it is today, but breaks the moment spot moves).

2. **Bullish is marginal on 5% tier.** Strike grid misalignment forces hedge $866 from trigger (vs Deribit's $134) — implies +85% hedge cost on LONG side, +23% on SHORT side.

3. **Bullish is competitive on 2% tier.** Pricing within 1-4% of Deribit; strikes at $200 increments give better trigger alignment than Deribit's $500 increments.

4. **Bullish liquidity at pilot scale is sufficient but brittle.** Top-of-book ask 1.91 BTC (~$155k) vs Deribit 34.3 BTC (~$2.78M). Fine for 2 × $50k/day; gets thin above 4 × $50k/day.

5. **Bullish bid-ask spreads are slightly wider** — TP recovery on Bullish will run ~5-15 percentage points worse than Deribit's R1 baseline of 68.3%.

**Operational consequence:** **Multi-venue routing is mandatory from Day 1.** Cannot go pure Bullish. Plan now ships dynamic per-quote routing instead of single-venue flip.

### Critical finding from rev 4 — current pricing is structurally loss-making

You confirmed live pricing is **$125 premium for $50k 2% protection (= $25 per $10k notional = $2.50 per $1k notional)**. This does NOT match the Design A schedule in the repo ($65–$100/$10k). The deployed Render env has overrides reducing pricing materially.

This matters because at $125 premium per trade, **per-trade economics are −$280 (calm) to −$440 (stress)**. Across 2 trades/day × 28 days = **−$15k to −$25k projected pilot P&L**. That blows through the entire $12k Atticus cap inside week 1–2.

**Pricing change is no longer optional or "lever optimization" — it's the gating fix for pilot viability.** Pre-cutover Day 1 must include "audit deployed env vs code" so we know exactly what's live.

### Locked from your 2026-05-13 reply 2 (rev 3 → rev 4)

| # | Question | Locked value |
|---|---|---|
| 2 | H2 longer-dated hedges | **Backtest first, ship if positive** |
| 3 | Layer 6 Foxify trader binding | **Yes, request from Foxify Day 1** |
| 4 | Tenor max 14 → 7 | **Yes** |
| 5 | Foxify pre-fund ask | **No upfront ask; operate at 2 × $50k full pilot** |
| 7 | Anti-bot Layers 1-4 | **Ship together at cutover** |

### Still open (rev 5: now 4 questions)

| # | Question | Recommended default |
|---|---|---|
| 1 | **Pricing — P1 / P2 / P3 / wait-for-backtest?** | **Wait for WS#9 backtest harness output, then choose**. Bundle C / P3 is the prior. |
| 6 | **Audit deployed pricing env Day 1** | Yes — operator gives me read access to Render env |
| **8** *(NEW rev 5)* | **10% tier — keep on Deribit-only, or drop from product?** | **Keep on Deribit-only**. Multi-venue router handles routing transparently. |
| **9** *(NEW rev 5)* | **Backtest harness gate — operator approval required before any production cutover, or auto-approve if numbers match Bundle C projection within ±25%?** | **Operator approval required**. You see the numbers, you sign off. |

### Corrected dollar figures (the headline numbers)

For a $50k position with 2% SL (= $1,000 max payout):

| Pricing | Premium charged | Trader return on trigger | 28-day platform P&L (2/day) |
|---|---|---|---|
| **Current (deployed)** | $125 | 8.0× | **−$15k to −$25k** |
| **P1** (Design A in code) | $325 (calm) → $500 (stress) | 3.1× → 2.0× | **−$5k to −$10k** |
| **P2** (lift floors) | $400 (calm) → $550 (stress) | 2.5× → 1.8× | **−$2k to +$2.5k** |
| **P3** (aggressive) | $500 (calm) → $650 (stress) | 2.0× → 1.5× | **+$2.5k to +$6k** |

P2 is the **minimum prudent move**. P3 is the cleanest answer for a 28-day pilot. Backtest will give the final number Day 5.

### Layer 6 plain-English (per your Q3)

The trader does nothing different. Layer 6 is an integration ask to *Foxify*, not the trader. Foxify already knows their traders by account ID; right now they don't tell us which trader is making each request. Layer 6 = Foxify adds one HTTP header (`X-Foxify-Trader-ID`, HMAC-signed) on each protection request. We use it to enforce per-trader rules (like blocking the same person from opening long+short pairs across browser sessions). Trader UX = unchanged. Foxify integration = a few lines.

I'll draft a one-page integration spec for Foxify on Day 1 of execution.

### Rev 5 addition — fingerprinting from our side (per follow-up Q)

Even without Foxify integration, we can do **browser fingerprinting on our side** that captures ~80% of Layer 6's effectiveness. No trader action required (their browser provides the data automatically). Full detail in companion artifact `FINGERPRINT_FROM_OUR_SIDE.md`. **Recommend ship browser fingerprinting Day 5 of execution as part of WS#3 (~2 days incremental); request Foxify Layer 6 in parallel as a stretch goal.**

### Rev 5 addition — backtest harness as explicit pre-cutover gate

Per your direction "need full backtesting before execution so we can validate", WS#9 (backtest harness) is now an **explicit gate**: operator (you) reviews harness output before any production cutover proceeds. If projected economics differ materially from Bundle C model (>25%), pricing decision (P2 vs P3) is revisited; cutover may slip. Detail in §7 below.

---

---

## Section 0 — Decisions locked from rev 2 reply

| # | Decision | Locked value |
|---|---|---|
| 1 | Foxify pool semantics | **A** (trader-facing balance) |
| 2 | Foxify deposit | **$0 starting** — operate off Atticus capital alone |
| 3 | Position cap | **2 × $50k/day** (= $100k notional/day) |
| 4 | Withdrawal lockup | **T+7** |
| 5 | Credential rotation | **After Day 3 smoke test** |
| 6 | Plan in repo | **No** — artifacts only |
| 7 | Atticus capital | **$12k** (bumped from $10k) |

These are baked into all numbers below.

---

## Section 1 — Seven new requirements, my read on each

### 1.1 Visual change-impact outline  *(NEW DELIVERABLE — Section 2 below)*

You asked for a simple chart/outline of all changes and their effect on platform performance/economics. Built. See **Section 2: Change → Impact Map**. Single-glance view, no math required to read.

### 1.2 Lower tenor max from 14 → 7 days

**My read:** Yes, do it. Three reinforcing reasons:

1. **Pilot is 1-DTE.** The 14-day cap exists for the biweekly product variant, which isn't part of this pilot. Lowering to 7 has zero impact on the live 1-DTE flow.
2. **Observed trader behavior matches.** Per your note, traders aren't holding 14 days. The cap currently lets them, but few use it. Lowering to 7 codifies what's already happening.
3. **Platform economics improve marginally.** Shorter max tenor → less time-value risk on hedges, less capital tied up per position, more frequent quote-pricing refreshes against current regime. CFO Lever 7 had recommended *adding* longer tenors (5%/10% on 7-day) for product reasons; lowering the *max* to 7 doesn't conflict — it just removes the unused 8–14 day band.

**Implementation:** single env update `PILOT_TENOR_MAX_DAYS=7` (was 14). Side effect: the biweekly 14-day product becomes uncallable. If you ever want biweekly back, override per-product. Acceptance criterion: `/pilot/regime` shows max tenor 7d, no quote requests fail with `tenor_above_max`.

**Economic impact:** ~+$0.05/$1k expected daily P&L (CFO §3.4 Lever-7 directional estimate, scaled inversely). Tiny absolute, free move, do it.

### 1.3 Different-length protection or different hedge strategy

**My read:** Three candidate optimizations exist; one is a quick win, one is a real optimization that needs a parity probe, one is a big bet that's probably wrong.

#### Option H1 — Aggregate hedge across same-strike trades  *(quick win, recommended)*
Instead of buying 4 separate 1-DTE puts when 4 traders open at the same trigger price, buy 1 larger 1-DTE put covering the aggregate notional. Already partially scaffolded in code (`HedgeBatchManager` in `hedgeOptimizations.ts`, `PILOT_HEDGE_BATCH_ENABLED=false` today).

Savings:
- ~$0.50–$2.00 per avoided Bullish/Deribit order in fixed fees
- Fewer fills = less slippage drag
- Better aggregate-fill price (deeper book sweep)
- At 2 × $50k/day pilot scale: maybe $5–15/day → modest but free

**Recommend:** enable `PILOT_HEDGE_BATCH_ENABLED=true` with 30s window, 50-position max. Reverts trivially.

#### Option H2 — Longer-dated hedges for short-dated protections  *(real optimization, needs parity data)*
A 7-DTE BTC put costs ~$5/$1k vs ~$2/$1k for 1-DTE. But 7 sequential 1-DTE puts cost ~$14/$1k cumulative. Theta is non-linear → buying a single 7-DTE hedge to cover 7 days of 1-DTE protections is materially cheaper per unit time IF strike alignment holds.

The catch: 1-DTE protections want strike = trigger = entry × (1 ± 2%). Each new protection has a fresh entry price. A held-over 7-DTE hedge can only match strike for protections opened at similar BTC price levels. So:
- Works well in low-volatility periods (BTC range-bound; aggregated trigger prices cluster)
- Breaks in trending markets (each day's entry is materially different from yesterday's)

Not a no-brainer. **Recommend:** model in the WS#9 backtest (§14). If it shows ≥ 30% hedge-cost reduction in calm regimes with acceptable strike-mismatch P&L drag in normal regimes, ship as a regime-conditional optimization. If not, drop.

#### Option H3 — Switch from puts/calls to perp-based delta hedge  *(probably wrong)*
Some platforms hedge with the underlying perpetual (futures) instead of options. Math:
- Cheaper carry (perp funding ~ 0–10 bps/day vs option theta of 50+ bps/day on 1-DTE)
- BUT: requires constant rebalancing as delta changes with spot
- BUT: gamma exposure (catastrophic in a fast move — exactly when protection needs to pay)
- BUT: payout pattern is asymmetric (option matches the protection contract; perp creates basis risk)

For a bounded-payout protection product, options are the structurally correct hedge. **Recommend:** do not switch to perp hedge. Keep options-primary. Already correct.

#### Combined recommendation
Enable H1 immediately (low-risk quick win). Model H2 in WS#9 backtest, decide based on results. Reject H3.

### 1.4 Premium revisit (especially 2%)  *[rev 4: pricing baseline corrected to deployed reality]*

**Confirmed live:** $125 premium for $50k 2% protection = **$25/$10k = $2.50/$1k**. This is BELOW the Design A schedule that's checked into the repo ($65–$100/$10k). The deployed Render env has overrides reducing pricing materially. Day 1 of execution must audit the env to map exactly what's live.

| Regime | DVOL band | Code schedule (per $1k) | **Deployed (per $1k)** |
|---|---|---|---|
| Low | ≤ 50 | $6.50 | **$2.50** |
| Moderate | 50-65 | $7.00 | **$2.50** (assumed; needs env audit) |
| Elevated | 65-80 | $8.00 | **$2.50** (assumed; needs env audit) |
| High | > 80 | $10.00 | **$2.50** (assumed; needs env audit) |

**Per-trade economics on $50k 2% at deployed pricing:**

| Regime | Hedge cost | Premium income | Expected payout (35% × $1000) | TP recovery (~50%) | **Net per trade** |
|---|---|---|---|---|---|
| Calm (DVOL 40) | $111 | $125 | $350 | +$56 | **−$280** |
| Normal (DVOL 50) | $155 | $125 | $350 | +$77 | **−$303** |
| Elevated (DVOL 70) | $356 | $125 | $350 | +$178 | **−$403** |
| Stress (DVOL 80) | $427 | $125 | $350 | +$214 | **−$438** |

**At 2 × $50k/day × 28 days, projected pilot P&L is −$15k to −$25k.** This is the dominant problem in the pilot economics — bigger than venue cutover, bigger than bot defense, bigger than anything.

**Three pricing options compared on a $50k 2% trade, 1-DTE, against the actual deployed baseline:**

| Option | Per $1k notional | $50k 2% premium | Trader return on trigger | Per-trade P&L (blended regime) | 28-day pilot P&L (2/day) |
|---|---|---|---|---|---|
| **Hold current** | $2.50 | $125 | 8.0× | **−$310** | **−$15k to −$25k (LOSS)** |
| **P1** = Design A as coded ($6.50–$10/$1k) | $6.50–$10 | $325–$500 | 3.1× → 2.0× | **−$110** | **−$5k to −$10k (LOSS)** |
| **P2** = lift floors ($8–$11/$1k) | $8.00–$11 | $400–$550 | 2.5× → 1.8× | **−$30** | **−$2k to +$2.5k (~breakeven)** |
| **P3** = aggressive ($10–$13/$1k) | $10–$13 | $500–$650 | 2.0× → 1.5× | **+$50** | **+$2.5k to +$6k (PROFIT)** |

(Hedge cost = blended Bullish/Deribit cost across regime distribution; expected payout = 35% trigger probability × $1000 payout; TP recovery = ~50% of hedge value at sell time. Source: CFO §3.1 + Appendix B.)

**Reading:**
- Holding current pricing for the pilot guarantees the pilot loses $15–25k of Atticus capital. We started with $12k Atticus cap.
- P1 (the schedule that's *supposed* to be deployed per the repo) cuts the loss to $5–10k — still bleeds.
- P2 is the **minimum prudent move** to bring the pilot to break-even.
- P3 is the **cleanest answer for a short pilot** — get to profit quickly, prove the model, retain optionality to lower later.

**Trader return at trigger context:**
- Current 8× return is generous and fragile (driven by under-pricing, not by Atticus's risk-bearing capacity)
- P2 at 2.5× → 1.8× sits above the CEO's stated 2× psychological floor in calm regime, dips just below in stress
- P3 at 2.0× → 1.5× — at the floor or just below

**My revised recommendation in light of the deployed baseline being so under-priced:**
- **P2 is the floor.** Anything less means we run a 28-day loss on purpose.
- **P3 is the pragmatic call** for a 28-day pilot specifically. Easier to lower P3 to P2 mid-pilot if adoption tanks than to raise P2 to P3 mid-pilot if losses mount.
- **Final decision should wait for WS#9 backtest output** (Day 5 of execution) which will run all four (current + P1 + P2 + P3) against full pilot history with Bullish-pricing simulation.

**Why your $650 / $800 estimates were higher than my numbers:** my best read is you doubled because the bot strategy from §3 buys a paired long+short — that pair would cost 2 × premium = $650 (P1) or $800 (P2). For a single position, the premium is half: P1 = $325, P2 = $400. Confirming your sanity check.

**Same exercise for 3% / 5% / 10% mechanics identical.** WS#9 backtest covers all four tiers.

### 1.5 Bot defense for opposing-perp arbitrage  *(critical, gets its own section)*

The CEO's described attack is real and our current defenses don't cover it. Detailed analysis and proposed defenses in **Section 3 — Opposing-Perp Arb Defense**.

### 1.6 Platform guardrails — payout treasury exhaustion + others

**My read:** Existing guardrails (circuit breaker, hedge budget cap) are *symptom-of-loss* defenses — they trip after losses have already occurred. We need *anticipatory* guardrails that block new exposure before treasury runs dry. Section 4 has the full set.

Quick preview of what's missing:
1. **Foxify pool minimum balance kill-switch** (block new sales if pool < projected payout liability + buffer)
2. **Open-position aggregate liability monitor** (sum of (active protection notional × payout%) — must stay ≤ pool balance × coverage factor)
3. **Stale price feed kill-switch** (already partial, needs hardening)
4. **High-DVOL spike auto-pause** (DVOL > 100 = halt new sales for 1 hour)
5. **Bullish API health degradation pause** (consecutive 5xx or > 5s p95 latency = halt)
6. **Daily premium velocity cap** (new — limits worst-day exposure independent of position count)
7. **Reconciliation check** (Bullish account balance vs our DB-tracked pool balance daily; halt if drift > 1%)

### 1.7 Backtest against historical data — all proposed changes

**My read:** This is a real engineering task, not a checkbox. Existing backtest scripts (`pilotBacktest*.ts`, ~30 of them) are point-in-time studies, not a regression harness. **WS#9 will build a proper backtest harness** that takes a single config object (premium schedule, tenor, TP rules, hedge strategy, etc.) and outputs comparable economics. Then we run all proposed changes through it side-by-side against the same historical data window.

Detailed harness design in §14. Output is a single comparison table you can read in 30 seconds.

---

## Section 2 — Change → Impact Map  *(NEW; the visual you asked for)*

Reading guide:
- **Direction**: ↑ = improves platform economics, ↓ = worsens, → = neutral, ⚡ = high uncertainty
- **Magnitude**: $/day on a $100k notional/day pilot (your 2 × $50k baseline)
- **Risk**: trader UX or operational risk introduced
- **Reversibility**: how hard to roll back

### 2.A — Pricing & product changes  *[rev 4: magnitudes recomputed against deployed $25/$10k baseline]*

| Change | Direction | Magnitude ($/day) | Trader impact | Risk | Revert |
|---|---|---|---|---|---|
| Lower max tenor 14 → 7 days | ↑ | +$1–5 | None (no one's using > 7d) | None | env flip |
| **Pricing — hold current $25/$10k** | ↓↓↓ | **−$540 to −$890** | None (status quo) | Pilot ends in $15-25k loss | n/a |
| **Pricing P1** (Design A as coded) | ↑↑ | **+$360 to +$540 vs current** | +160% premium increase, 3.1× → 2.0× return | Adoption shock | env flip |
| **Pricing P2** (lift floors) | ↑↑↑ | **+$510 to +$680 vs current** | +220% premium increase, 2.5× → 1.8× return | Adoption shock | env flip |
| **Pricing P3** (aggressive) | ↑↑↑↑ | **+$650 to +$840 vs current** | +300% premium increase, 2.0× → 1.5× return | Severe retention risk | env flip |
| Enable batched hedge buys (H1) | ↑ | +$3–10 | None | Low (well-tested code) | env flip |
| Switch to longer-dated hedges (H2) | ⚡ | +$5–30 (or −$10 if wrong) | None | Strike mismatch risk | code revert |
| Stress pricing overlay enable | ↑ | +$5–15 in stress | Premium spikes during stress | None (well-tested) | env flip |

### 2.B — Risk & guardrail changes

| Change | Direction | Magnitude ($/day) | Trader impact | Risk | Revert |
|---|---|---|---|---|---|
| Anti-bot ENFORCE | ↑↑ | Closes attack worth up to −$200/day | Real traders see cooldowns; small UX friction | Honest traders may hit cooldown false positives | env flip |
| Opposing-perp arb defense (§3) | ↑↑↑ | Closes attack worth up to −$760/day at 2.17 triggers | Honest traders blocked from opening simultaneous long+short 2% protections | Some legit hedging strategies blocked | per-rule env flip |
| Hedge budget cap reshape | → | $0 expected, stops drift | None | None | env flip |
| Foxify pool kill-switch | ↑ on tail | $0 expected, prevents catastrophe | Sales pause when pool low | Operational pause = trader frustration | env flip |
| Tighter circuit breaker (50 → 35%) | ↑ on tail | $0 expected, faster auto-halt | None | More false trips | env flip |
| High-DVOL pause (DVOL > 100) | ↑ on tail | $0 expected, blocks crisis trades | Sales pause in extreme regime | Lost crisis-period revenue | env flip |
| Reconciliation drift halt | ↑ on tail | Catches accounting bugs early | None | None | env flip |
| Random cooldowns for bot defense | ↑ | +$5–50 | UX friction (tens of seconds) | Honest trader annoyance | env flip |

### 2.C — TP & hedge management

| Change | Direction | Magnitude ($/day) | Trader impact | Risk | Revert |
|---|---|---|---|---|---|
| Gap 1 (vol-spike forced exit) ENFORCE | ↑ | +$2–10 | None | Some sells leave time value | env flip |
| Gap 3 (cooling shrink) ENFORCE | ↑ | +$2–8 | None | Sells slightly earlier | env flip |
| Deep-OTM short-tenor writeoff | ↑ | +$1–5 | None | None | env flip |
| Per-direction recovery floor alert | → | $0 (alerting) | None | None | env flip |
| Active TP window expansion in stress | ↑ | +$3–10 | None | Sells more aggressively in stress | env flip |

### 2.D — Venue & infrastructure

| Change | Direction | Magnitude ($/day) | Trader impact | Risk | Revert |
|---|---|---|---|---|---|
| Bullish mainnet cutover | ⚡ | Unknown until parity probe | None visible | Liquidity may be thinner | env flip + restart |
| Multi-venue (Bullish primary + Deribit fallback) | ↑ | +$2–8 (better fills) | None | More moving parts | env flip |
| Bullish bug fixes (trigger-monitor + premium semantics) | → | $0, prevents cutover crashes | None | None | code revert |
| Foxify capital segregation (WS#0) | → | $0 (accounting) | None | None | env flip |
| T+7 withdrawal lockup | → | $0 (accounting) | Foxify-only | None | DB field flip |
| Backtest harness (WS#9) | → | Validates other changes | None | None | n/a |

### 2.E — Aggregate impact  *[rev 4: recomputed against deployed $25/$10k baseline]*

The single biggest variable is which pricing option lands. Three bundles:

**Bundle A — Hold current pricing + ship all defenses:**
- Daily P&L: **−$500 to −$800/day** (pricing dominates)
- 28-day pilot P&L: **−$14k to −$22k** (LOSS — blows through Atticus $12k cap)
- Why: defenses save tail-risk dollars but don't fix structural under-pricing

**Bundle B (recommended baseline) — Pricing P2 + ship all defenses:**
- Daily P&L: **+$10 to +$50/day**
- 28-day pilot P&L: **+$280 to +$1,400 (modest profit)**
- Tail-risk reduction: ~50%
- Trader UX cost: small (premium 2.5× return, few-sec cooldowns, occasional pause)

**Bundle C — Pricing P3 + ship all defenses + ship H2 if backtest positive:**
- Daily P&L: **+$80 to +$130/day**
- 28-day pilot P&L: **+$2,240 to +$3,640 (clean profit)**
- Tail-risk reduction: ~70%
- Trader UX cost: larger (premium 2.0× return, retention risk material)

**My read:** Bundle B is the conservative win. Bundle C is the right answer for a 28-day pilot specifically — it gets the platform to profit fast, builds a margin buffer for any unexpected losses, and we can lower mid-pilot if adoption drops. WS#9 backtest output Day 5 gives the empirical answer.

---

## Section 3 — Opposing-perp arb defense  *(NEW; the CEO's identified threat)*

### 3.1 Threat model walked through

**The attack:**
1. Bot opens equal long + short BTC perp on Foxify (delta-neutral)
2. Bot buys 2% protection on each (long-side put + short-side call)
3. Bot waits for any 2% BTC move within tenor
4. Whichever direction fires → bot collects fixed payout on that side, closes both perps
5. Repeats; CEO observed 2.17 trigger events per day

**Bot economics at current $65/$10k pricing on $10k notional per side:**
- Premium cost per pair: 2 × $65 = **$130**
- Payout on trigger: $200 per trigger (only one side fires)
- Combined trigger probability per day (long-side OR short-side fires): ~55% (CFO §3.1 35.2% per direction, with overlap correction)
- Bot expected daily PnL per pair: $200 × 0.55 − $130 = **+$0/pair/day** (essentially break-even at $65 pricing, slightly losing)

**Bot economics at observed 2.17 triggers/day** (CEO's number — implies higher trigger rate than 55%, likely because bot ladders multiple pairs):
- If 4 pairs running, 2.17 triggers/day on the cohort = 0.54 per pair = matches the 55% combined rate
- So at scale: 4 pairs × $0/pair = **roughly break-even**
- BUT: the CEO's concern is what happens when realized trigger rate exceeds 55% (trending markets, whipsaw days)

**At what price does the bot strictly lose?**
- Bot break-even: $200 × p_combined = 2 × premium → premium = $100 × p_combined
- At p = 0.55 (typical balanced): bot needs premium ≥ $55/$10k → current $65 is enough by $10
- At p = 0.65 (trending day cluster): bot needs premium ≥ $65/$10k → current $65 is exactly at break-even
- At p = 0.75 (whipsaw cluster): bot needs premium ≥ $75/$10k → current loses

**Conclusion:** current pricing is structurally too thin to defend against this strategy in trending or whipsaw markets. **Pricing alone is not the answer.** The bot strategy fundamentally exploits the fact that we sell a delta-neutral package cheaper than the option market itself does.

### 3.2 Defense layers (combined approach, defense-in-depth)

#### Layer 1 — Same-asset opposite-side block per fingerprint  *(strongest single defense)*

**Rule:** if a fingerprint has any active 2% protection on BTC (regardless of direction), reject any new 2% BTC protection on the opposite direction.

Implementation:
```typescript
// In activate handler:
const existing = await pool.query(
  `SELECT id, side FROM pilot_protections
   WHERE user_hash = $1 AND market_id = $2 AND sl_pct = 2
   AND status IN ('active','pending_activation','triggered')
   AND metadata->>'fingerprint' = $3`,
  [userHash, marketId, fingerprint]
);
const hasOpposite = existing.rows.some(r =>
  (r.side === 'short' && newProtectionType === 'long') ||
  (r.side === 'long' && newProtectionType === 'short')
);
if (hasOpposite) {
  return { status: 'error', reason: 'opposing_protection_active',
           message: 'You already have 2% protection on the opposite direction. Close it first.' };
}
```

This kills the long+short pair pattern at root.

**Counter-attack:** bot uses two fingerprints (two browser sessions). Defense: require Foxify-side trader_id binding via `X-Foxify-Trader-ID` header. Foxify has the real trader account, can sign and pass it. We bind that to the protection record. Two browser sessions but one trader_id = same restriction applies.

**Acceptable false positive rate:** legitimate hedgers running covered-call structures might hit this. Counter: allow opt-in `?bypass_opposing=true` query that requires trader to have committed > $X notional in pilot history (filters new accounts). Acceptable trade-off.

#### Layer 2 — Random-jitter activation cooldown  *(throws off scripted timing)*

**Rule:** after any activation by a fingerprint, enforce cooldown = `base + random_jitter` before next activation.

- Base: 60 seconds
- Jitter: uniform random 30–300 seconds (so total window: 90–360s)

Implementation in `throttleStore.ts` (planned for WS#3):
```typescript
const cooldownMs = 60_000 + Math.floor(Math.random() * 270_000);
throttleStore.recordActivate(fingerprint, cooldownMs);
```

This is deliberately non-deterministic so the bot can't predict when its next activation will be allowed. Forces the bot to either (a) idle for the worst-case wait, killing throughput, or (b) get rejected and retry.

**Trader UX:** real traders rarely activate twice within 5 minutes; cooldown is invisible to them. Bot can't operate at the cadence it needs.

#### Layer 3 — Trigger-induced fingerprint cooldown

**Rule:** when a protection triggers for a fingerprint, that fingerprint cannot activate any new 2% protection on the same asset for 4 hours.

Rationale: 2.17 triggers/day for a single fingerprint is the bot signature. A real trader rarely triggers 2x/day; if they do, we want to confirm it's not bot behavior before allowing more.

Implementation: new field on `pilot_protections` for `triggered_at` (already present), join in activate path against fingerprint history.

#### Layer 4 — Premium surcharge on suspicious patterns

**Rule:** detect patterns and apply premium surcharge (50–100%) on the *next* protection from that fingerprint.

Patterns:
- More than 3 protections opened within 1 hour
- Quote/activate ratio > 5:1 over 50 quotes
- Same-fingerprint open + close cycle < 60 seconds repeatedly
- Long+short pair attempt blocked by Layer 1

When pattern detected: next protection from fingerprint quoted at 1.5× current schedule. Stays at 1.5× for 24h, then resets if pattern stops.

This makes the arb economics structurally negative. Bot break-even at p=0.55 needs premium ≤ $100/$10k; at 1.5× current ($97.50/$10k) it's at the edge; combined with Layer 1 blocking the pair entirely, the attack is shut.

#### Layer 5 — Open-interest aware pricing  *(stretch goal)*

**Rule:** if the platform's aggregate open 2% protection interest is highly skewed (e.g., > 70% one direction), raise premium on the opposite direction to discourage building the other side of a pair.

Implementation more involved; defer to post-pilot if the first four layers prove insufficient.

#### Layer 6 — Foxify-side trader binding (requires Foxify cooperation)

**Rule:** require `X-Foxify-Trader-ID` header signed by Foxify-side secret on every quote/activate. Bind to protection record. Per-trader (not per-fingerprint) cap and cooldown enforcement.

This is the ultimate defense — fingerprint can be spoofed by browser rotation but Foxify trader_id can't (without Sybil-attacking Foxify itself). Requires a small Foxify integration spec. **Recommend asking Foxify to sign trader_id in quote requests** as a Day 1 ask of the cutover.

### 3.3 Combined effectiveness

| Layer | Bot must do | Cost to bot |
|---|---|---|
| 1: Opposite-side block | Use 2 fingerprints (browser sessions) | Trivial workaround |
| 1+6: + Trader binding | Use 2 Foxify accounts | Hard (Foxify KYC, $) |
| 1+2: + Random jitter | Idle 60-360s between activations | Cuts throughput 70-90% |
| 1+2+3: + Trigger cooldown | Wait 4h after each trigger | Cuts throughput another 80% |
| 1+2+3+4: + Surcharge | Pay 1.5× on next trade | Negative expected value |
| All five layers: | All of the above | **Strategy non-viable** |

**Recommend:** ship Layers 1, 2, 3, 4 in initial cutover. Layer 6 (Foxify trader binding) requires Foxify ack — request as Day 1 of execution. Layer 5 = post-pilot only if needed.

### 3.4 What this costs honest traders

- Layer 1: blocks ~2% of legitimate hedging strategies (covered structures); bypass available with history filter
- Layer 2: invisible to anyone not making rapid back-to-back trades
- Layer 3: blocks new 2% activation 4h after a trigger; affects re-protection roll behavior; mitigation = trader uses different SL tier (3% / 5%) for re-protection
- Layer 4: only triggers if pattern matches; honest traders don't match patterns

Net trader UX cost: minimal. Net platform protection: substantial.

---

## Section 4 — Platform guardrails (full set)  *(EXPANDED from rev 2)*

### 4.1 Pre-emptive (block-before-loss) guardrails

| Guardrail | Trigger | Action | Status |
|---|---|---|---|
| **Foxify pool min balance kill-switch** | Foxify pool < $X | Halt new activations until pool ≥ $X + buffer | NEW |
| **Aggregate open liability cap** | Σ(active notional × payout%) > pool × 0.8 | Halt new activations | NEW |
| **Atticus hedge cap** | Cumulative hedge spend ≥ tier cap | Block (already exists, will reshape WS#2) | EXISTS |
| **Per-tier daily concentration** | One tier > 60% of daily new notional | Block that tier (already exists) | EXISTS |
| **Per-position max notional** | Position > $50k | Block (already exists) | EXISTS |
| **Aggregate active notional** | Sum > $200k | Block (already exists) | EXISTS |

### 4.2 Reactive (loss-already-happening) guardrails

| Guardrail | Trigger | Action | Status |
|---|---|---|---|
| **Atticus equity circuit breaker** | 35% drawdown in 24h | Halt new activations + alert | EXISTS, will tighten 50→35 |
| **Foxify pool drawdown alert** | 25% drop in pool from week-start | Operator alert (no auto-halt) | NEW |
| **Reconciliation drift halt** | Bullish balance vs DB pool > 1% drift | Halt + alert | NEW |
| **Stress regime auto-renew freeze** | DVOL > 65 | Skip auto-renews (already exists) | EXISTS |

### 4.3 Operational (data-quality) guardrails

| Guardrail | Trigger | Action | Status |
|---|---|---|---|
| **Stale price feed kill-switch** | Coinbase + Deribit perp feeds both stale > 10s | Halt new quotes (already partial) | EXISTS, harden |
| **High-DVOL pause** | DVOL > 100 (extreme crisis) | Halt new sales for 1h | NEW |
| **Bullish API health pause** | 5xx rate > 10% for 5 min OR p95 latency > 5s | Halt new sales | NEW |
| **Daily premium velocity cap** | Premium income today > 3× rolling avg | Slow new activations (rate limit halved) | NEW |
| **Spot price feed disagreement** | Coinbase vs Deribit > 1% drift | Halt + alert | NEW |

### 4.4 Implementation order

**Wave 1 (with cutover):** Foxify pool kill-switch, aggregate liability cap, reconciliation drift halt. These are the most consequential.

**Wave 2 (week 2 of pilot):** High-DVOL pause, Bullish API health pause, spot disagreement halt, premium velocity cap. These are tail-event protections; low immediate value, high catastrophic-loss prevention.

All have env kill-switches for rollback.

---

## Section 5 — Revised hedge budget math (Atticus $12k, 2 × $50k/day)

### 5.1 Daily expected hedge spend

At 2 × $50k = $100k notional/day, balanced tier mix (30% / 30% / 20% / 20% across SL 2/3/5/10):

| Regime | Distribution | Hedge cost per $1k | Daily hedge spend |
|---|---|---|---|
| Calm (DVOL < 50) | 30% of days | $0.84 | **$84** |
| Normal (50-65) | 51% | $2.18 | **$218** |
| Elevated (65-80) | 19% | $3.81 | **$381** |
| Stress (>80) | minor | $5.46 | **$546** |

Blended expected daily: 0.30 × 84 + 0.51 × 218 + 0.19 × 381 = **$210/day**

### 5.2 28-day cumulative projection

- Expected: 28 × $210 = **$5,880**
- 80th percentile: $9,500
- 95th percentile (one stress week): $13,200
- 99th percentile: $17,000

### 5.3 With $12k Atticus cap, what fits?

$12k cap, 28-day horizon, expected burn $5.9k → **room for ~2× the expected amount, comfortably handles 80th-percentile path**. 95th-percentile path (1 stress week) would burn through the cap with 4 days to spare; manageable with the dynamic concentration tightening (§5 of WS#2).

**Verdict on 2 × $50k/day:** $12k Atticus cap supports this comfortably. We can scale to 3 × $50k/day if pilot data shows actual burn rate < $200/day.

### 5.4 If Foxify pre-funds later

Each $5k Foxify deposit roughly funds one extra position per day for the remaining pilot duration. So:
- Foxify $10k → +1 position/day → 3 × $50k/day feasible
- Foxify $25k → +2.5 positions/day → 4 × $50k/day with margin
- Foxify $40k → +4 positions/day → 6 × $50k/day theoretically

But that's the *Foxify pool* (payout-side capacity), not Atticus pool (hedge capacity). The Atticus $12k cap still binds the hedge-buying. To scale Atticus past 3 × $50k/day we'd need to either (a) raise Atticus cap, or (b) confirm via pre-flight that real burn rate is below the modeled $210/day — which is plausible if tier mix skews wider than balanced.

### 5.5 Auto-throttle behavior

The existing dynamic concentration tightening (§5 of WS#2) handles regime shifts:
- Calm/normal: 2 × $50k/day = $100k notional, full caps active
- Elevated regime detected: tighten 60% → 40% per-tier, soft-block excess 2% activations
- Stress regime detected: drop to 1 × $50k/day or pause new sales (operator confirms)

This keeps us within the $12k cap regardless of regime.

---

## Section 6 — Workstream list (revised, now ten)

| # | Workstream | Status changes from rev 2 |
|---|---|---|
| 0 | Foxify capital segregation, weekly settlement, audit reporting | Foxify deposit = $0 to start, but architecture stays so we can onboard Foxify funds mid-pilot without code change |
| 1 | Bullish MAINNET cutover (with bug fixes) | Unchanged from rev 2 |
| 2 | Hedge budget cap reshape (Atticus $12k pool) | Cap raised from $10k → $12k schedule |
| 3 | Anti-bot / arb-farm safeguards (ENFORCE) | EXPANDED to include 4 layers of opposing-perp defense (§3) |
| 4 | Stress pricing overlay (ENABLE) | Unchanged |
| 5 | TP optimization | Unchanged |
| 6 | Pre-flight live evaluation (full history, two phases) | Unchanged |
| 7 | Bullish-mainnet vs Deribit-mainnet parity probe | Unchanged |
| 8 | Operational guardrails (expanded set) | EXPANDED — see §4 |
| 9 | **Backtest harness + scenario suite (NEW)** | Built in §7 below |

### 6.1 Tenor and pricing changes ride on existing workstreams

The new tenor (max=7) and pricing changes (P2 recommended) ride on **existing** WS#2 and WS#4 — they're config updates, not separate workstreams.

### 6.2 Hedge strategy options (H1, H2, H3) ride on the backtest

H1 (batched hedges) is shipped via env flip in WS#5. H2 (longer-dated hedges) is studied in WS#9 backtest first, then shipped if results support. H3 (perp hedges) is rejected.

---

## Section 7 — Workstream #9: Backtest harness  *(NEW)*

### 7.1 Goal

A single TypeScript module that takes a `PilotConfig` object and a historical date range, and outputs a comparable economic scorecard. Then we run all proposed-changes side-by-side against the same data.

### 7.2 Existing scaffolding to reuse

The repo has ~30 existing `pilotBacktest*.ts` scripts that each implement bespoke logic. They share common pieces (BTC price history fetcher, BS pricing, regime classifier). We extract these into a shared backtest core.

### 7.3 Architecture

```
services/api/scripts/backtest/
├── core/
│   ├── BacktestEngine.ts        // simulate one config over one window
│   ├── HistoricalDataLoader.ts  // BTC closes, DVOL, RVOL
│   ├── HedgeSimulator.ts        // simulate Bullish + Deribit pricing
│   ├── TPSimulator.ts           // simulate hedge manager decisions
│   └── ScorecardWriter.ts       // emit comparable JSON + Markdown
├── scenarios/
│   ├── current_baseline.ts      // current Design A schedule
│   ├── pricing_p2.ts            // recommended price lift
│   ├── pricing_p3.ts            // aggressive price lift
│   ├── tenor_7max.ts            // tenor max change
│   ├── batched_hedges_h1.ts     // H1
│   ├── longer_hedges_h2.ts      // H2
│   ├── all_recommended.ts       // P2 + tenor + H1 + bot defense + stress overlay
│   └── all_aggressive.ts        // P3 + H2 + everything
└── runComparison.ts             // run all scenarios, output side-by-side
```

### 7.4 Inputs per scenario

```typescript
type ScenarioConfig = {
  pricingSchedule: Record<Regime, Record<SlPct, number>>;
  tenorMaxDays: number;
  hedgeStrategy: 'rolling_1dte' | 'rolling_7dte' | 'batched_aggregate';
  tpRules: TpRulesConfig;
  premiumStressOverlay: PremiumStressOverlayConfig;
  positionCapPerDay: number;
  positionSizeMax: number;
  startDate: string;
  endDate: string;
};
```

### 7.5 Outputs per scenario

```typescript
type ScenarioScorecard = {
  scenarioName: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  // Volume & activity
  totalProtectionsOpened: number;
  totalNotionalUsd: number;
  // Trigger statistics
  totalTriggersFired: number;
  triggerRateByTier: Record<SlPct, number>;
  triggerRateByRegime: Record<Regime, number>;
  // Economics
  totalPremiumIncomeUsd: number;
  totalPayoutOutUsd: number;
  totalHedgeCostUsd: number;
  totalTpRecoveryUsd: number;
  netPlatformPnLUsd: number;
  netPlatformPnLPerDayUsd: number;
  // Per-tier breakdown
  perTierEconomics: Record<SlPct, {triggers, premium, payout, hedge, recovery, netPnL}>;
  // Per-regime breakdown
  perRegimeEconomics: Record<Regime, {...}>;
  // Risk
  worstSingleDayLossUsd: number;
  largestDrawdownUsd: number;
  daysWithNetLoss: number;
  capExceededEvents: number;
  // Bot defense (synthetic adversary)
  botExpectedPnLUsd: number;     // simulates the opposing-perp bot
  botBlockRate: number;
  // Trader UX
  cooldownEvents: number;
  rejectionEvents: number;
};
```

### 7.6 Bullish-pricing simulation

Once the WS#7 parity probe runs for 7 days, we have empirical Bullish-vs-Deribit price ratios per tier × regime. The hedge simulator multiplies historical Deribit-implied hedge costs by those ratios to estimate Bullish economics. Until probe data is available, we run two extreme scenarios: Bullish = Deribit (optimistic) and Bullish = 1.3× Deribit (pessimistic).

### 7.7 Comparison output

A single Markdown table with one row per scenario, columns for the headline metrics. Plus per-scenario detailed JSON in `docs/backtest/<scenario>.json`. Sample preview:

| Scenario | Net P&L (28d) | Worst day | Daily avg | Bot P&L | Trigger rate |
|---|---|---|---|---|---|
| Current baseline | +$420 | −$1,200 | +$15 | +$610 | 14.2% |
| All recommended | +$1,380 | −$680 | +$49 | −$280 | 14.5% |
| All aggressive | +$2,580 | −$540 | +$92 | −$1,140 | 14.5% |
| H2 longer hedges | +$1,050 | −$2,100 | +$37 | −$280 | 14.5% |
| P3 only | +$2,200 | −$680 | +$78 | −$280 | 14.5% |

(Numbers above are illustrative; actual numbers come from running the backtest.)

### 7.8 Acceptance

- All scenarios run end-to-end against ≥ 1,000 historical days
- Output is reproducible (deterministic given seed)
- Comparison Markdown is human-readable
- Backtest can be re-run nightly during pilot to validate live data against projection

### 7.9 Effort estimate

3-4 days of focused work. Largest piece is Bullish-pricing simulation. Existing `pilotBacktest1Day.ts` and `pilotBacktestDefinitiveV7.ts` provide ~60% of the core logic.

---

## Section 8 — Sequenced execution (rev 5: backtest-first gate, multi-venue routing)

Order changed in rev 5. Backtest harness now comes early and gates cutover. Multi-venue routing replaces single-venue cutover.

| Day | Workstream | Deliverable | Production impact |
|---|---|---|---|
| 1 AM | WS#1 bug fixes | Trigger-monitor + venue.ts PRs | Staging only |
| 1 AM | **Audit deployed env** | Map what overrides are actually live (especially pricing); confirm $25/$10k vs Design A | None — read-only |
| 1 PM | WS#1 phase 1 — Bullish auth smoke | Live login on mainnet with provided creds; trading account discovery | None |
| 1 PM | WS#7 phase 1 — parity probe scaffold | Read-only quote scrape from both venues for 4 tiers × 2 sides | None |
| 2 | WS#6 pre-flight | Phase A vs Phase B baseline report from production DB | None — read-only |
| 2 | WS#7 parity probe runs continuously | 24-48h Bullish-mainnet vs Deribit-mainnet feed | None |
| 3 | **WS#9 backtest harness — core build** | HistoricalDataLoader, BacktestEngine, scorecard writer (~2 days) | None |
| 3-4 | WS#0 schema + ledger | Capital pool tables, CRUD, settlement runner | None |
| 4 | **WS#9 backtest harness — scenario suite** | Current + P1 + P2 + P3 × {Bullish-only, Deribit-only, multi-venue} | None |
| 5 | **WS#9 backtest harness — RUN + REPORT** | Generate comparison Markdown; **operator review** | None |
| **5 EOD** | **🛑 GATE 1 — Operator backtest sign-off** | **You review WS#9 output. If numbers match Bundle C projection within ±25%, proceed. Otherwise revisit pricing decision.** | None — decision point |
| 6 | WS#3 anti-bot + opposing-perp defense + browser fingerprinting | All 4 layers; ENFORCE; FingerprintJS integration | Staging |
| 6 | WS#5 TP optimization | Gap 1/3 enforce decisions from observe data | Staging |
| 7 | WS#1 phase 2 — Bullish smoke trade | One end-to-end paper-scale trade on mainnet | None on prod |
| 7 | WS#2 hedge budget reshape | $12k schedule + utilization alerts | Staging |
| 8 | WS#4 stress overlay enable | Calibrated thresholds | Staging |
| 8 | Tenor max 14 → 7; H1 batched hedges | Env updates | Staging |
| 9 | **WS#1 — Multi-venue routing** | Per-tier per-quote routing (Bullish primary 2%/3%; Deribit primary 5%/10%) | Staging |
| 9 | WS#8 ops guardrails (Wave 1 + 2) | All guardrails | Staging |
| 10 | **GATE 2 — Pre-cutover validation matrix** | Full smoke matrix on staging; verify all 10 workstreams interact correctly; **CEO sign-off** | Staging |
| 11 | **Production cutover** | Single env update on Render — pricing schedule + multi-venue routing + all defenses + Bullish credentials | **Cutover.** Bullish primary for 2%/3%; Deribit for 5%/10%. |
| 11 PM | **Credential rotation** | Generate fresh ECDSA keys, swap, decommission burner | Production |
| 12-14 | Post-cutover monitoring | 72h close watch; daily settlement dry-run; threshold tuning; first weekly settlement run | Production |
| 15+ | Foxify-side trader binding (Layer 6) | If Foxify accepts integration ask | Production |

Realistic timeline: **2–3 calendar weeks** to land all 10 workstreams + cutover.

### Gate definitions

**GATE 1 (Day 5 EOD) — Backtest sign-off:**
- Operator reviews `WS9_backtest_results.md` (auto-generated)
- Confirms expected pilot P&L within ±25% of Bundle C projection (+$8k to +$25k for 28 days)
- Confirms per-tier, per-regime economics roughly match the projection
- Confirms Bullish-vs-Deribit routing decisions per tier
- If pass: pricing decision locks (P2 vs P3); execution proceeds to Day 6
- If fail: pause, revisit pricing decision, possibly delay cutover

**GATE 2 (Day 10) — Pre-cutover validation:**
- Full smoke matrix: 10 sample trades on staging covering tier × side × regime combinations
- All defenses (anti-bot, guardrails, fingerprint) verified active
- Multi-venue routing exercised (manually trigger at least 1 quote per tier)
- Capital pool ledger entries posting correctly
- Operator + CEO sign off on Day 11 production cutover

---

## Section 9 — Risks and unknowns (updated)

| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| 1 | Bullish mainnet liquidity insufficient | Medium-high | WS#7 parity probe — go/no-go gate |
| 2 | Bullish multi-trading-account unsupported | Medium | Virtual segregation in DB |
| 3 | Provided credentials leak before rotation | Medium | §16 covers handling; rotate after Day 3 |
| 4 | Stress regime hits during pilot week 1 | 10-15% | Auto-throttle + circuit breaker + Foxify cushion (when funded) |
| 5 | TP recovery in stress materially worse than R1 calm | High (unmeasured) | Per-direction recovery floor alert |
| 6 | Atticus $12k insufficient at 2 × $50k/day | Low (5-10%) | Dynamic throttle; can request top-up mid-pilot |
| 7 | Bot uses 2 fingerprints to bypass Layer 1 | Medium without Foxify trader binding | Layer 6 (Foxify trader binding) — Day 1 ask |
| 8 | Pricing P2 lift causes adoption drag | Medium | A/B test if Foxify allows; otherwise revert in 1 env flip |
| 9 | Tenor max change breaks an existing UI assumption | Low | Test on staging before flip |
| 10 | Backtest harness validation gap (sim ≠ reality) | Medium | Run nightly during pilot; alert if observed > 20% off projected |

---

## Section 10 — Updated open questions for your decision before execution  *[rev 4]*

Locked from prior replies: Q2, Q3, Q4, Q5, Q6 (per your 2026-05-13 reply 2), Q7. Two remain open.

| # | Question | My recommended default |
|---|---|---|
| 1 | **Pricing option — Hold / P1 / P2 / P3?** Decide now or wait for backtest? | **Wait for WS#9 backtest output Day 5**, then choose between P2 (conservative) and P3 (recommended for 28-day pilot). Holding current is not viable. |
| 6 | **Day 1 task: audit deployed env vs code** — give me read access to Render env to map what overrides are actually live (especially pricing) | **Yes, Day 1 of execution** |

---

## Section 11 — Decision summary at rev 5

- Foxify pool semantics: **A**, deposit $0 to start (architecture supports later top-up)
- Position cap: **2 × $50k/day** = $100k notional/day
- Atticus pool: **$12k**
- **Pricing: TO BE DECIDED Day 5 (Gate 1) from WS#9 backtest output. Choosing between P2 and P3; Bundle C / P3 is the prior. Holding current = pilot loses ~$10k.**
- Tenor max: **14 → 7**
- Hedge strategy: **H1 batched (ship)**, **H2 longer-dated (BACKTEST FIRST — likely ship on Bullish given strike-grid advantage)**, **H3 perp (reject)**
- Anti-bot: **Layers 1-4 ENFORCE at cutover** + **browser fingerprinting from our side** (~80% of Layer 6 effectiveness, ships Day 6); Layer 6 (Foxify trader binding) requested Day 1 in parallel
- Foxify pre-fund: **$0 starting**, no upfront ask, architecture supports mid-pilot top-up
- All guardrails (Wave 1 + 2) shipped
- **Multi-venue routing from Day 1 (rev 5):** Bullish primary for 2%/3%; Deribit primary for 5%/10%; per-quote dynamic fallback if best ask differs > 30%
- **WS#9 backtest harness as Gate 1 before cutover (rev 5):** operator review required
- Bullish mainnet cutover with provided credentials (rotate Day 11 PM after smoke validation)
- T+7 lockup, plan stays in artifacts
- Companion artifacts: `BULLISH_VS_DERIBIT_LIVE_COMPARISON.md`, `BUNDLE_C_PRICING_TABLE.md`, `BACKTEST_PROJECTION.md`, `FINGERPRINT_FROM_OUR_SIDE.md`, `CHANGE_IMPACT_OVERVIEW.md`

If this matches your intent, execution can start. The Gate 1 backtest review preserves your right to revisit pricing before any production change.

---

## Section 12 — Things rev 3 still does NOT cover (intentional deferrals)

Same as rev 2 §15. No changes:
- Treasury platform (separate plan)
- Per-user multi-tenancy refactor (post-pilot)
- Foxify production API integration (post-pilot)
- Tenor variants on 5%/10% (post-pilot)
- Mainnet → second venue automation (architected, not built)

Plus rev 3 additions to deferral list:
- Layer 5 (open-interest aware pricing) — post-pilot
- A/B testing framework for pricing changes — post-pilot
- Fingerprint Sybil resistance beyond Foxify trader binding — out of scope

---

## Section 13 — Credential security (carries from rev 2)

Unchanged from rev 2 §16. ECDSA keys, UUID, ID stay out of plan/scratchpad/repo, used only via env vars, rotated after Day 3 smoke test. Recommend you generate fresh keys via Bullish dashboard for production cutover and treat the rev-2 burner keys as staging-only.

---
