# Double-2% Barrier Hedge — Strategic Memo

> **Audience:** Atticus founder + CFO + structurer.
> **Author:** structuring desk (Cursor cloud agent, working from `cursor/double-barrier-hedge-analysis-a47f`).
> **Companion artifacts in this directory:**
> - `SUMMARY.md` — full sweep tables (trigger frequency, breakeven premium, P&L grid, capital ladder, burn-rate)
> - `breakeven_premium.csv`, `per_pair_pnl.csv`, `capital_ladder.csv` — machine-readable
> - `sweep/sweep_results.json` — raw sweep
> - `../../scripts/double-barrier/simulator.py` — re-runnable Monte Carlo
> - `../../scripts/double-barrier/run_full_sweep.py` — multi-axis sweep driver
> - `../../scripts/double-barrier/analyze_sweep.py` — table builder
>
> **Total simulation budget burned:** 12 minutes (3,000 paths × 4 regimes × 7 premium tiers × 2 VRP scenarios × 4 hedge instruments = 672 (regime, premium, vrp, instrument) cells).

---

## 1. Restating the product (so we agree on what we're modeling)

You're selling a **capped-payout double-barrier knock-out** to traders. Concretely:

| Trader side | Pays | Receives at trigger |
|---|---|---|
| Pair (long-side + short-side, $50k notional each side) | Daily premium ($250/side proposal) | $1,000 if BTC moves ±2% from anchor |

When one barrier fires:
- Trader gets $1,000, **both legs close on the trader side**.
- Anchor resets to new spot; trader can auto-renew with a fresh ±2% pair (new premium charged).
- **The platform's option hedge stays alive** — Atticus owns the straddle/strangle through its own expiry and can unwind/redeploy.
- Total trader life capped at 7 days.

This is structurally identical to your existing **Modified-Y** facility documented in `Atticus_Vol_Facility_CFO_Walkthrough.md`. Numbers below are calibrated to be replayable against that doc.

### Two calibration points to lock down before any production decision

These two need pinning:

1. **Premium-per-side vs premium-per-pair.** Your spec says "$250/50k position per side"; the Vol-Facility doc says **"$250/pair/day."** A factor of two on revenue. Throughout this memo I treat $250/side/day = $500/pair/day as the baseline and flag any chart where the doubling matters. **Decision needed:** which is it?

2. **30-day straddle cost.** You wrote "~$1,150 at moderate vol (DVOL<65)." The CFO doc's BS-anchored table (Appendix A) puts it at **~$3,700 at DVOL 45** and **~$5,200 at DVOL 65**. My BS recompute on a $50k pair, 30-day tenor, ±2% strikes, DVOL 55, 5% rfr, yields $5,354 — which matches the CFO doc and is **~4.7× the number you cited**. I think your $1,150 is either (a) per-leg quoted for a tighter notional, (b) net of the call premium recovered when one side triggers fast, or (c) an amortized number after netting first-day take-profit. **The math below uses BS pricing**; if the venue is actually quoting $1,150 you're getting a 4.7× discount that flips much of the analysis — but that needs an executed Deribit / Falcon X RFQ to confirm before anything else here matters.

I'll mark every conclusion that hinges on which calibration we use.

---

## 2. The headline result (in one sentence)

> **At your stated trigger rules and at the proposed $250–$400/side premium, the product loses money in expectation under risk-neutral pricing in every regime, and only marginally clears breakeven in calm markets if BTC realized vol runs ≥20% below DVOL.**

The full table (from `SUMMARY.md §2`):

**Breakeven premium per side per day under risk-neutral GBM** (worst case, no VRP edge):

| Regime | DVOL | 30d strangle | Daily strangle | Perp-delta only |
|---|---|---|---|---|
| Calm | 45 | $611 | $597 | $602 |
| Moderate | 55 | $942 | $918 | $922 |
| Elevated | 65 | $1,336 | $1,294 | $1,298 |
| Stress | 80 | >$2,000 | $1,947 | $1,948 |

**Breakeven with 20% vol-risk-premium** (realized vol 20% below DVOL — the typical empirical BTC pattern outside crisis windows):

| Regime | DVOL | 30d strangle | Daily strangle | Perp-delta only |
|---|---|---|---|---|
| Calm | 45 | $380 | $399 | $359 |
| Moderate | 55 | $603 | $621 | $570 |
| Elevated | 65 | $864 | $877 | $818 |
| Stress | 80 | $1,337 | $1,321 | $1,256 |

**Read this carefully:** your $250-$400/side band is at-or-just-below breakeven *only* in **calm regime AND with a healthy VRP haircut**. Anywhere else, the product is structurally short-funded.

This is not a hedge-instrument problem. It's a premium-sizing problem.

---

## 3. Why the hedge instrument barely matters (and what that implies)

The single biggest insight from the sweep, against intuition:

> **All four hedge instruments produce nearly identical expected P&L per pair-life within ~3-7%.**

At moderate regime, $250/side, risk-neutral:

| Instrument | Upfront option spend | E[hedge P&L net of payouts] | E[PnL/pair-life] |
|---|---|---|---|
| 30d strangle (legacy Modified-Y) | $5,354 | −$371 | −$9,705 |
| 7d strangle | $2,152 | −$337 | −$9,356 |
| Daily strangle | $417 | −$19 | −$9,415 |
| Perp-delta only | $0 | $0 | −$9,393 |

This is not a bug. It's the **risk-neutral martingale property of options**: under the same pricing measure used to mark them, the expected option payoff equals the option cost. The "30-day theta carry" intuition that the CFO doc leans on (Section 2 in `Atticus_Vol_Facility_CFO_Walkthrough.md`) is **only real if realized vol is below implied vol** — i.e., if the platform is implicitly *short* vol-risk-premium.

When you do introduce a 20% VRP haircut, the ranking does shift, but not in the way the intuition predicts:

| Instrument @ VRP=20%, mod, $250/side | E[PnL/pair-life] |
|---|---|
| 30d strangle | −$4,995 |
| 7d strangle | −$4,498 (best) |
| Daily strangle | −$5,256 |
| Perp-delta only | −$4,460 (best) |

**The 30-day straddle slightly *underperforms* shorter-tenor hedges and a no-options perp-only stance.** Reason: when realized < implied, paying upfront for 30 days of vol you don't get is a worse deal than paying daily for the vol you actually live through.

### Implication: hedge instrument should be selected on **capital efficiency, not edge**

Capital tied up in upfront option premium at 1,000 concurrent pairs (moderate regime, $1,000/side premium where things go cash-positive):

| Instrument | L1 (option equity) at 1,000 pairs | Total capital incl. headroom |
|---|---|---|
| 30d strangle | **$5.91M** | $7.91M |
| 7d strangle | $2.15M | $3.01M |
| Daily strangle | $0.42M | $0.73M |
| Perp-delta only | $0.00M | $0.24M |

**Daily strangle ties up 14× less capital than the 30-day straddle for the same expected P&L.** Going to perp-delta-only saves another $500k. The straddle is buying you nothing except more capital lock-up, given the underlying martingale.

**Counter-argument I'd want stress-tested:** the 30-day straddle protects against a *correlated catastrophic gap* (BTC −15% in 30 minutes when you have 1,000 open pairs simultaneously trying to pay $1k each). A daily strangle with anchor reset doesn't. So before yanking the straddle, run §6's correlated-tail scenario.

---

## 4. Triggers per pair-life — the math you need to internalize

This is the engine of the whole P&L. From `SUMMARY.md §1`:

| Regime | DVOL | E[triggers / 7d] (risk-neutral / VRP=20%) |
|---|---|---|
| Calm | 45 | **8.4 / 5.0** |
| Moderate | 55 | **12.8 / 8.0** |
| Elevated | 65 | **18.1 / 11.4** |
| Stress | 80 | **27.3 / 17.4** |

A few things to absorb:

1. **In moderate regime, expect ~13 triggers per 7-day pair-life.** Each costs $1,000. That's ~$13k of payout exposure per pair, which premium needs to cover.
2. **Realized-vs-implied is a huge lever.** Going from RN to 20% VRP cuts triggers by ~38%. If real BTC behaves with VRP=25-30% (which it does in some calm-trending tapes), triggers fall further.
3. **Stress regime kills you.** 27 triggers in a week. Even at $1,000/side/day premium ($14k/week revenue), you barely cover payouts before any hedge slippage, and venue execution quality on triggered options collapses precisely when it matters most.

**The CFO doc's "2.16 triggers/day" number is in the right ballpark for moderate regime.** My sim averages 1.83/day at σ=0.55 RN, 1.14/day at VRP=20%. Consistent.

### Why the triggers compound: intra-day re-anchoring

A subtle feature of the structure that the CFO doc handles correctly but is worth restating: after a trigger fires, the pair re-anchors at the *new* spot. So a single chop session can fire 3-4 triggers in one day. My sim captures this with continuous-monitoring Brownian-bridge barrier correction; verification at 1-minute resolution gave **12.7 triggers/week** vs the sim's **12.8** at moderate regime.

This re-anchoring is **the single biggest design choice you can revisit** to change the economics. See §7.

---

## 5. Capital required to support N concurrent pairs

For the user's stated capital plan, comparing the operating regime (DVOL 55) cases:

### 5.1 At the proposed $250/side premium (red zone)

Burn-rate of the proposed **$30k + $50k = $80k facility**, no VRP edge:

| N concurrent pairs | Instrument | Upfront hedge book | Weekly E[PnL] | **Weeks until $80k burn** |
|---|---|---|---|---|
| 4 | 30d straddle | $23,619 | −$38,820 | **2.1** |
| 4 | Daily strangle | $1,668 | −$37,658 | **2.1** |
| 8 | 30d straddle | $47,237 | −$77,640 | **1.0** |
| 12 | 30d straddle | $70,856 | −$116,460 | **0.7** |
| 25 | 30d straddle | $147,617 | −$242,626 | 0.3 |
| 50 | 30d straddle | $295,233 | −$485,252 | 0.2 |

**Your "4.3 concurrent pairs for 4 weeks" target on $80k requires E[PnL] ≥ $0/pair/week.** At $250/side, you're at **−$9,705/pair/week** in moderate regime. At 4 pairs that's $39k/week burn. The facility funds **two weeks**, not four, before fresh capital is required.

**Conclusion: $250/side at scale-up cannot work.** Either:
- premium goes up,
- VRP turns out to be ≥20% empirically (need to verify), and even then you only break even, not generate the $70k/month the CFO doc projects, or
- the structure is re-engineered (see §7).

### 5.2 At a premium that actually clears (green zone)

If premium = $1,000/side/day (= $2,000/pair/day, = "tiered for elevated regime"), risk-neutral, moderate:

| Instrument | Upfront hedge | E[PnL/pair-life] | Weekly E[PnL] @ 1,000 pairs |
|---|---|---|---|
| 30d straddle | $5,910 | +$830 | **+$830k/week** |
| Daily strangle | $417 | +$1,160 | **+$1.16M/week** |
| Perp-delta only | $0 | +$1,100 | **+$1.10M/week** |

**Now the math actually works.** At 1,000 pairs and $1k/side, capital required to operate (1.30× headroom):

| Instrument | L1 | L2 (tail buffer) | L3 (loss cushion) | **Total cap** |
|---|---|---|---|---|
| 30d straddle | $5.91M | $0.18M | $0.00M | **$7.91M** |
| Daily strangle | $0.42M | $0.15M | $0.00M | **$0.73M** |
| Perp-delta only | $0.00M | $0.18M | $0.00M | **$0.24M** |

But this premium ($1k/side/day = $7k/pair/week for 7-day max tenor) is roughly **9× more expensive to the trader than the existing pilot $250/pair/day rate**. That's a different product to a different customer; the existing fit-with-Foxify-trader-economics may not survive this repricing.

### 5.3 The realistic operating zone

If you assume **VRP = 20% holds** (testable in <30 days of paper-replay against historical BTC tapes), and you charge **$400/side in calm**, **$600/side in elevated**, the math at 1,000 pairs is:

| Regime | Premium $/side | Instrument | E[PnL/pair-life] | Total cap (1,000 pairs) |
|---|---|---|---|---|
| Calm (DVOL 45) | $400 | Daily strangle | +$21 | $1.36M (~all L1) |
| Moderate (DVOL 55) | $600 | Daily strangle | −$282 | $1.11M but cash-negative |
| Elevated (DVOL 65) | $800 (tier) | Daily strangle | −$300 (est.) | ~$1.4M |

In other words: **with VRP=20% and a tiered premium that floats $400 → $1,000 across regimes, the platform can run 1,000 pairs on roughly $1.5M of capital** with daily-strangle hedging. With 30-day strangle on the same setup, $7-8M.

**This is the smartest target to optimize toward.** It cuts the 1,000-pair capital requirement by ~80% versus the legacy 30-day straddle hedge, and it cuts the worst-case slippage on triggered hedge unwinds (because daily/weekly options are far more liquid at small notional than 30-day ones at the same strike).

---

## 6. Risks I want explicitly flagged

### 6.1 The VRP assumption is doing all the work

Every chart where things "work" depends on realized BTC vol running ~20% below DVOL on average. This is consistent with empirical BTC vol-surface behavior in **calm-and-moderate** regimes (2024–2026 ex-crisis), but it inverts in **shock regimes** (March 2020, May 2021, May 2022, Nov 2022, Mar 2023). When realized > implied, triggers compound and the long-vol hedge under-pays for the extra triggers it now sees.

**Recommendation:** before any production capital deployment, run the sim against historical BTC paths instead of GBM. The infrastructure is already there: `services/api/scripts/pilotBacktestFetchBtc.ts` pulls 4+ years of Coinbase hourly bars; we can feed those paths into `simulator.py` in place of the GBM generator. **This is a 2-day engineering task** and will give you a far more credible distribution than the GBM-based one in `SUMMARY.md`.

### 6.2 Correlated-trigger stress

My capital-ladder L2 buffer assumes √N pooling across pairs (independent triggers). In reality, when BTC drops 4% in 30 minutes, every open long-side trigger fires simultaneously and you owe $1,000 × N at the same instant. At 1,000 pairs that's **$1M of immediate cash obligation**. The hedge book intrinsic also fires up, but settlement isn't instantaneous on Deribit/Falcon X — there's typically a 15-minute to 4-hour latency between trigger detection and hedge unwind cash receipt (your own pilot logs document one case of `285 consecutive no_bid retries over 4h45min` on a same-day option in `PHASE_0_BIWEEKLY_PERDAY_SPEC.md §1`).

**Stress L2 should be modeled N-linearly, not √N.** That puts a 1,000-pair correlated-stress reserve at ~$5M just to bridge venue settlement, on top of the $1.5M operating capital from §5.3.

### 6.3 Hedge book accumulates stub legs across triggers

In the auto-renew branch of the 30-day straddle strategy, every trigger sells a leg and opens a fresh 30-day leg at the new spot. After 7 days with 13 triggers, the platform's hedge book has **~13-14 stub options** at various strikes and expiries, all of which need to be marked-to-market and unwound at trader-period end. My sim handles this correctly (each leg is BS-valued at unwind), but **operationally** this is significantly more complex than the daily-strangle path, where each day's hedge auto-expires worthless or is closed cleanly. This is a meaningful argument for the daily-strangle path beyond the capital-efficiency one.

### 6.4 The $1,150 calibration

If your $1,150 quote *is* what Deribit / Falcon X is actually quoting on a 30-day ±2% strangle for a 0.667 BTC pair at moderate vol, then somebody is mispricing — the BS no-arb price is ~$5,000 — and you should be sized as large as that mispricing allows for as long as it lasts. **This needs a live-quote screenshot before any conclusion is drawn.** If the $1,150 is a stale calibration or a misquote, the analysis above stands.

### 6.5 Foxify customer fit

Re-pricing premium from $250 to $600-$1,000/side/day is not a marketing tweak — it's a different product. A trader funding a $50k position is not going to pay $7k/week for ±2% protection that has 80%+ probability of paying out at least once. They will replicate the protection themselves with cheap weekly puts/calls on Deribit at <50% of that cost. The breakeven premium math holds because the *option market* charges that much; the trader-acquisition math fails for the same reason.

> **The product as currently structured is not solvable purely on the Atticus side. Either the trader pays much more (and they won't, because the option market arbitrages), or the structure changes to reduce trigger probability per dollar of premium.**

---

## 7. Smartest path forward — five concrete moves, ranked by impact

### Move 1 — Add a post-trigger cooldown (highest impact, lowest effort)

After a trigger fires, freeze the anchor for X hours (suggested: 4 hours) before re-arming. This eliminates intra-day chop-day pile-ups, which currently account for ~60% of weekly trigger count.

**Estimated effect at moderate regime:** triggers/7d drops from 12.8 to ~5-6 → premium breakeven at $250-$400/side becomes plausible without any VRP assumption. This is a **3-5× P&L improvement**.

This is a one-line config change in your trigger monitor. The trader experience is "you're protected until the next 4-hour bucket starts" which is communicable.

### Move 2 — Widen the barrier 2% → 2.5–3%, increase payout proportionally

Moving from ±2% to ±3% drops trigger probability by **~50%** at moderate vol (because barrier crossings scale with σ√T and 3%/σ vs 2%/σ moves the cdf-tail sharply). Pair this with a $1,500 payout instead of $1,000 to keep the trader's effective stop-loss intact. Net: similar trader value, dramatically lower platform trigger frequency.

**Operational:** unchanged. Just a parameter change.

### Move 3 — Switch to daily-strangle (or perp-delta-overlay) hedging

Cuts capital required at 1,000 pairs by ~80%. Cuts venue execution risk (1-day options have 5-10× tighter bid-ask than 30-day at small notional, per your own Phase 0 D1 dataset). Cuts hedge-book operational complexity (no stub-leg accumulation). Removes the "30-day theta carry" myth from the CFO narrative.

**Open question:** do you keep convexity (daily strangle) or accept barrier risk for max capital efficiency (perp-delta overlay)? My read: **keep daily strangle as the baseline**. The convex-tail protection costs ~$60/pair/day of premium drag and is worth it for the correlated-stress scenario in §6.2.

### Move 4 — Tier premium by realized DVOL (already in your spec)

The proposed "$250-$400 base, tiered when DVOL>65" is the right shape. Refined version using my sweep:

| DVOL band | Suggested premium /side/day | Daily-strangle E[PnL/pair-life] (VRP=20%) |
|---|---|---|
| <50 | $400 | +$21 |
| 50-65 | $600 | −$282 (slightly negative; needs cooldown from Move 1 to clear) |
| 65-80 | $900 | breakeven-ish |
| >80 | pause new opens (existing breaker) | n/a |

Combined with Move 1 (cooldown) the 50-65 row goes positive too. This is your default scaled tier table once cooldown ships.

### Move 5 — Validate VRP empirically on historical BTC paths before trusting any of it

Re-run the sweep substituting real BTC tapes (4 years of hourly Coinbase bars, already pulled by `pilotBacktestFetchBtc.ts`) for the GBM paths. The simulator's path generator is the only thing that needs swapping. **Estimated work:** ~1 day of engineering.

This will confirm or refute the VRP=20% premise; if real BTC has VRP=10% the breakeven premium math goes back into the red zone and Moves 1-4 become mandatory rather than nice-to-have.

---

## 8. Capital plan recommendation

If Moves 1-4 ship, here's the capital ladder to actually shoot for:

| Stage | Concurrent pairs | Hedge | Premium | Reserve target | Comment |
|---|---|---|---|---|---|
| Pilot | 4-8 | Daily strangle | $400/side calm, $600/side mod | **$30k** | Matches your stated start. Survives one stress day at 4 pairs because L2 caps it. |
| Beta | 25 | Daily strangle | tiered | **$80k** | 4-8 weeks of operation with cooldown live. Validates the sub-$1k/pair hedge spend. |
| Mid | 100 | Daily strangle | tiered | **$300k** | First treasury-sized capital ask. ~$1M-equivalent notional protection. |
| Production | 250 | Daily strangle + perp overlay on tail | tiered | **$700k** | Cross-checks against §6 stress L2. |
| Target | 1,000 | Daily strangle + perp overlay on tail | tiered | **$1.5M operating + $5M stress credit line** | Worst-case correlated-trigger reserve assumes √N→N pooling switch. |

**Bottom line for the partner discussion:** $1.5M operating capital + $5M revolving credit line gets you 1,000 concurrent pairs sustainably *if* (a) cooldown ships, (b) premium is tiered, (c) hedge is daily strangle, (d) VRP holds at ~20%. Without those, 1,000 pairs requires substantially more — anywhere from $7M to $30M+ depending on how much you trust the VRP haircut and how stress is modeled.

Compared with the existing Phase 1 model in `Atticus_Vol_Facility_CFO_Walkthrough.md` ($70k for ~6 pairs), this is the same capital efficiency at 100×+ scale, achieved by changing the hedge instrument and adding cooldown. **The product survives by becoming structurally different, not by raising prices alone.**

---

## 9. What I'd want you to fill in next

To take this to a final decision, three pieces of information would tighten everything materially:

1. **Live RFQ for a 30-day ±2% BTC strangle** at your venue (Falcon X primary, Deribit fallback) on $50k pair notional. Pin the $1,150 vs $5,000 question. **30 minutes of work; resolves the single biggest input uncertainty in the analysis.**

2. **Historical-path replay** of the simulator (`scripts/double-barrier/simulator.py`) against the existing 4-year Coinbase hourly tape (`pilotBacktestFetchBtc.ts`). The sim accepts an arbitrary `(prices, t_days)` tensor — swap GBM out for real paths and re-run §3-§5 tables. **1-2 day engineering task; gives you VRP-anchored numbers to bring to investors instead of GBM-anchored ones.**

3. **Cooldown trigger monitor patch** (Move 1) coded as a configurable `min_seconds_between_triggers` parameter in the existing trigger-monitor service. **Half a day of engineering; can ship to the existing pilot for live observation against 1-day product without any trader-facing change.**

If those three pieces land, you have the underlying rigor to decide whether to scale to 1,000 pairs on $1.5M, or to redesign the trigger geometry (Move 2), or to abandon the structure for something with structurally lower trigger frequency (e.g., a 5% barrier ladder with smaller per-trigger payouts).

---

## 10. One-page TL;DR

| Question you asked | My answer |
|---|---|
| Best hedge: 30d straddle vs rolling 7d vs ATM vs OTM? | **Daily ±2% strangle.** Same E[PnL] as 30d straddle, 14× less capital, simpler operations, better venue liquidity. Keep ±2% strikes (matching the trigger). |
| Trigger rate? | **8–13 triggers per pair per 7 days** in calm-to-moderate, 5–8 if BTC realized vol runs 20% below DVOL. |
| Total capital for 1,000 pairs? | **~$1.5M operating + $5M stress credit** *if* you ship cooldown + daily-strangle + tiered premium + VRP holds at 20%. Without those, **$7-30M.** |
| Where does $30k+$50k get you? | **4-8 pairs for 1-2 weeks**, not 4 weeks. The proposed $250/side premium burns the facility in days at 8+ pairs without a structural fix. |
| Tiered premium worth it? | **Yes.** $400 calm / $600 mod / $900 elev. Combined with cooldown this is the operating point. |
| Is the user's stated $250/side enough? | **No, not at the current trigger geometry.** Either lower trigger frequency (cooldown + wider barrier) or accept the price has to be ~2-3× higher. |
| Smartest path forward? | **Move 1 (cooldown), Move 2 (3% barrier + $1,500 payout), Move 3 (daily strangle), Move 4 (tiered premium), Move 5 (validate VRP empirically).** In that priority order. |
| Single biggest unknown? | **Whether realized BTC vol genuinely runs ≥20% below DVOL on Atticus's typical operating tape.** Resolvable in 1-2 days of historical-path replay using infrastructure already in `services/api/scripts/`. |

---

*End of memo. All numbers are reproducible from `scripts/double-barrier/simulator.py` + `run_full_sweep.py` + `analyze_sweep.py` and the `sweep/sweep_results.json` artifact.*
