# Empirical Cooldown Findings — 6.4-Year Replay

> **Status.** Cooldown logic plumbed into `scripts/double-barrier/historical_replay_cooldown.py` (companion to `historical_replay.py`) and run across the full 6.4-year BTC + 5-year DVOL tape under five cooldown-threshold configurations. **Result invalidates the 20/30/50 % design-target trigger clip used in earlier pricing analysis** (`FOXIFY_PROFITABILITY_REALITY.md`, `MEMO_V2.md §6.4`, `COOLDOWN_FOXIFY_BREAKDOWN.md` §3 estimates). This doc is the empirical truth and supersedes those estimates.
>
> **Headline.** Empirically, cooldown clips **0.6 % of stress triggers under the spec as written** (vs assumed 50 %). Even under aggressive threshold tightening (`cd_aggr` config: T2 fires at 2 triggers in 4 h, T4 at DVOL > 80 with 25 % jump, 8 h duration), stress trigger clip caps at 5.3 %. **Cooldown does not, and cannot, deliver the trigger reduction the original pricing math relied on.** Worse: under aggressive thresholds cooldown actively COSTS Atticus money (~$17 M/yr at 1 k pairs) by holding stale strangles whose MTM bleeds out while no new strangle re-anchors.
>
> **Implication.** **Pricing must be derived from the no-cooldown breakeven floors.** Cooldown stays as an operational tail-risk control (limits worst-case pair-life P&L per `MEMO_V2.md §6.4` and `historical/stress_windows.md`) but is not load-bearing on the rate ladder. **The "absolute best price without cooldown" ladder is `$490 / $720 / $1,025 / $1,455` per pair per day at uniform ~5 % Atticus margin** — see §5.

---

## 1. What was plumbed

`scripts/double-barrier/historical_replay_cooldown.py` extends `historical_replay.py` with per-pair cooldown logic faithful to `COOLDOWN_CIRCUIT_BREAKER_SPEC.md`:

- **T2 proxy (per-pair trigger density):** if this pair has fired ≥ N triggers in the last `lookback_hours` window, freeze its anchor for `duration_hours`.
- **T4 proxy (DVOL spike):** if today's DVOL > `dvol_high_threshold` and `dvol_today / dvol_yesterday > jump_ratio`, freeze anchor for `duration_hours`.
- **During cooldown:** existing strangle continues to MTM (no new strangle bought on grazes); same-side grazes do not re-trigger until price returns inside an inner buffer of the (frozen) anchor or cooldown clears (per spec §4 "next ±2 % boundary measured from original anchor").
- **Trigger payouts continue** during cooldown for the first cross of each side (per spec §4 "existing triggered pairs continue to pay").
- **No new pair-opens** are modelled (single-pair sim) — but new-pair-open suppression doesn't affect the per-pair P&L numbers presented here. The per-pair sim measures cooldown's effect on existing-pair economics, which is what the rate ladder is sized against.

T1 (payout-velocity vs operating capital) and T3 (hedge-book MTM drift) are aggregate-book metrics not directly modellable in single-pair sim and are omitted from this run; they fire less often than T2/T4 per spec analysis and would not change the qualitative conclusion.

## 2. Threshold configurations swept

| Config | T2 threshold | T2 lookback | T4 DVOL high | T4 jump ratio | Duration |
|---|---:|---:|---:|---:|---:|
| `cd_off` | — | — | — | — | — |
| `cd_spec` (spec as written) | 4 trig in 4 h | 4 h | 100 | 1.5× | 4 h |
| `cd_tight1` | 3 trig in 4 h | 4 h | 90 | 1.4× | 4 h |
| `cd_tight2` | 2 trig in 4 h | 4 h | 85 | 1.3× | 6 h |
| `cd_aggr` | 2 trig in 4 h | 4 h | 80 | 1.25× | 8 h |

Run inputs: 2,328 pair starts × 5 cd-configs × 1 premium schedule (legacy `tiered_400/600/900` per side; the regime-distribution geometry of the result generalises to any flat-or-tiered ladder).

## 3. Empirical clip per regime

From `historical/cooldown_threshold_sweep.csv`:

| Config | Band | CD active % of regime hours | Trigger clip % | Payout clip % | Hedge-net cost clip % (positive = save) |
|---|---|---:|---:|---:|---:|
| **cd_spec** (as written) | calm | 0.03 | 0.0 | 0.0 | +0.6 |
| | mod | 0.01 | 0.1 | 0.1 | +1.9 |
| | elev | 0.05 | 0.3 | 0.3 | +0.7 |
| | **stress** | **0.14** | **0.6** | **0.6** | **−0.4** |
| cd_tight1 | calm | 0.06 | 0.0 | 0.0 | −4.6 |
| | mod | 0.21 | 0.1 | 0.1 | −6.4 |
| | elev | 0.33 | 1.0 | 1.0 | −4.6 |
| | stress | 0.74 | 1.5 | 1.5 | −10.4 |
| cd_tight2 | calm | 1.06 | 0.3 | 0.3 | −21.4 |
| | mod | 2.66 | 1.7 | 1.7 | −26.4 |
| | elev | 4.59 | 2.1 | 2.1 | −6.5 |
| | stress | 7.45 | 3.7 | 3.7 | −15.8 |
| **cd_aggr** | calm | 1.40 | 0.1 | 0.1 | −25.5 |
| | mod | 3.26 | 2.6 | 2.6 | −30.0 |
| | elev | 6.01 | 2.6 | 2.6 | −8.5 |
| | **stress** | **9.09** | **5.3** | **5.3** | **−21.7** |

**Two findings:**

1. **Trigger / payout clip is far below 20/30/50 % at every threshold tested.** Even the aggressive config (`cd_aggr`, which fires across 9 % of stress hours) clips only 5.3 % of stress triggers. To clip 50 % of stress triggers you would need cooldown active across roughly 100 % of stress hours — i.e., always-on in stress, which defeats the "circuit breaker" framing and would be commercially unacceptable to Foxify (essentially never able to open new pairs in stress regimes).

2. **Hedge-net cost gets WORSE under cooldown** in every regime under tightened thresholds. During cooldown the existing strangle is held without re-anchoring; as BTC drifts, the held strangle's protective value bleeds out and selling it later realises larger losses. This is a real economic cost. **Aggressive cooldown costs Atticus 22–30 % more in net hedge cost in mod and stress.**

## 4. Empirical Atticus P&L per cooldown config (legacy `tiered_400/600/900` per side schedule)

From `historical/cooldown_pnl_summary.csv`:

| Config | Blended P&L / pair-life | Blended margin on premium | CD active % blended | **Atticus annual @ 1,000 pairs** |
|---|---:|---:|---:|---:|
| `cd_off` | $4,985 | 42.6 % | 0.00 % | **$260 M** |
| `cd_spec` | $4,994 | 42.7 % | 0.03 % | $260 M ← essentially identical to cd_off |
| `cd_tight1` | $4,916 | 42.1 % | 0.20 % | $256 M (−$4 M) |
| `cd_tight2` | $4,730 | 41.2 % | 2.61 % | $247 M (−$13 M) |
| `cd_aggr` | $4,668 | 40.9 % | 3.29 % | **$243 M (−$17 M)** |

**Cooldown costs Atticus $0–$17 M/year of mean P&L at 1,000 pairs.** It does NOT add P&L. It is a tail-risk insurance (caps worst-case pair-life P&L per `historical/stress_windows.md`), not an economic feature.

This invalidates the central premise of the original `FOXIFY_PROFITABILITY_REALITY.md` table that quoted Atticus net P&L assuming 20/30/50 % cooldown clip on payouts and hedge.

## 5. The corrected "absolute best price without cooldown" ladder

If cooldown is not load-bearing on pricing (because empirically it doesn't clip), the rate ladder must price each regime above its no-cooldown breakeven floor with whatever margin Atticus needs to operate. Anchors (from `historical_summary.json` and `PRICING_FINAL_PER_PAIR.md`):

```
mult_pair      = {calm: 8.59,  mod: 9.84,  elev: 10.625, stress: 10.39}
payouts/pl     = {calm: 3,800, mod: 6,195, elev: 9,104,  stress: 12,139}
hedge_net/pl   = {calm: 200,   mod: 500,   elev: 1,200,  stress: 2,200}    # no-cooldown
breakeven $/d  = {calm: 466,   mod: 681,   elev: 970,    stress: 1,380}    # PnL = 0 floor
```

For uniform 5 % margin on premium (tightest sustainable):

```
rate = (payouts + hedge) / ((1 - margin) × mult)
```

| Band | Breakeven floor | **Rate at 5 % margin** | Premium / pl | Atticus PnL / pl | Margin |
|---|---:|---:|---:|---:|---:|
| Calm | $466 | **$490** | $4,209 | +$209 | 5.0 % |
| Mod | $681 | **$720** | $7,085 | +$390 | 5.5 % |
| Elev | $970 | **$1,025** | $10,891 | +$587 | 5.4 % |
| Stress | $1,380 | **$1,455** | $15,117 | +$778 | 5.1 % |

**Blended Atticus P&L = +$371 / pair-life** at balanced 35.4 / 42.8 / 14.4 / 5.8 weights. **At 1,000 pairs ≈ +$18 M/year (≈ +$180 M/year at 10,000 pairs).**

### 5.1 Foxify cost at the no-cooldown ladder (no rebate)

| Band | Premium | Payouts (full trig rate) | **Foxify net cost / pl** |
|---|---:|---:|---:|
| Calm | $4,209 | $3,800 | +$409 |
| Mod | $7,085 | $6,195 | +$890 |
| Elev | $10,891 | $9,104 | +$1,787 |
| Stress | $15,117 | $12,139 | +$2,978 |

**Blended Foxify cost = +$956 / pair-life ≈ +$47 k/pair/yr ≈ $47 M/yr at 1,000 pairs ($470 M at 10,000 pairs)**.

**Cost on volume: ~1.49 bps** at all scales (volume scales with pair count proportionally; rebate ladder discussed in §5.2).

### 5.2 With 6 % volume rebate cap maintained on Mod/Elev/Stress (base = ladder/0.94)

| Band | Base rate | Rebated (6 %) | Atticus PnL / pl at 6 % rebate |
|---|---:|---:|---:|
| Calm | $490 | $490 | +$209 (5.0 %) |
| Mod | $766 | $720 | +$390 (5.5 %) |
| Elev | $1,090 | $1,025 | +$587 (5.4 %) |
| Stress | $1,548 | $1,455 | +$778 (5.1 %) |

End-state (full rebate active) Atticus and Foxify economics are identical to §5/§5.1 — the rebate is just a billing mechanic that lets the headline base rate be higher to fund Atticus margin compression at lower-volume tiers.

**Recommended customer-facing format:**

| Foxify monthly volume | Rebate | Calm | Mod | Elev | Stress |
|---|---|---:|---:|---:|---:|
| 0–100 pair-days/mo (Phase 1) | 0 % | $490 | $766 | $1,090 | $1,548 |
| 100–500 / mo | 2 % | $490 | $751 | $1,068 | $1,517 |
| 500–2,000 / mo | 4 % | $490 | $735 | $1,046 | $1,486 |
| **2,000+ / mo (base ladder cap)** | **6 %** | **$490** | **$720** | **$1,025** | **$1,455** |

(Stretch 8 % tier removed — there is no margin to give back beyond 6 % once cooldown's pricing subsidy is gone.)

## 6. Recommendation: cooldown vs no-cooldown — does it make a difference for Foxify?

| Dimension | Hardened cooldown'd ladder ($490/$625/$795/$865 + 6 % rebate) — **as printed in PR #134** | **No-cooldown ladder ($490/$720/$1,025/$1,455 + 6 % rebate cap)** |
|---|---|---|
| Foxify cost @ 1,000 pairs | ~$42 M/yr (per PR #134 doc set) — **but assumes empirically-invalid cooldown clip** | **~$47 M/yr** (empirically validated) |
| Foxify cost @ 10,000 pairs | ~$420 M/yr (assumed) | **~$470 M/yr** (real) |
| Cost on volume | ~1.38 bps (assumed) | **~1.49 bps** (real) |
| Atticus actual P&L @ 1,000 pairs (empirical replay) | **−$49 M/yr** (LOSS — rate is below realised hedge cost) | **+$18 M/yr** (positive, sustainable) |
| Foxify service interruptions per year | ~13 days/yr of `503` on new-pair-open API; ~0–2 % payout clip (per `COOLDOWN_FOXIFY_BREAKDOWN.md`) | **0 days; no payout clip; no service interruptions** |
| Bait-and-switch risk at month-1 reconciliation | Material (Foxify expects $1k × 312 trig/yr = $312k/pair/yr in payouts; cooldown clips ~$8k of that, plus the rate ladder relies on much larger clip that doesn't materialise) | **None** — rate ladder is the actual price; payouts are the actual triggers; nothing hidden |
| Operational complexity for Atticus | Cooldown spec to implement (~3 days eng), production state machine, dashboard signals, threshold tuning that the empirical replay shows can't deliver economic clip anyway | **None on the pricing side**; cooldown stays as an operational tail-risk control with the loose spec thresholds |
| Predictability for Foxify CFO | Variable — payouts and volume both clip in unpredictable bursts during named-crisis windows | **Fully predictable** — published rate × pair-days = monthly bill; published trigger rate × pair-days = monthly payouts |

**Recommendation: quote the no-cooldown ladder.** Three reasons:

1. **It is the actual lowest sustainable price.** The "lower" cooldown'd ladder is fictional; cooldown empirically can't deliver the clip that ladder's math requires. If we quote the cooldown'd ladder, Atticus loses $49 M/yr at 1,000 pairs in production. We can't sign that.

2. **Foxify pays only ~12 % more** than the (fictional) cooldown'd ladder ($47 M vs $42 M at 1,000 pairs, $470 M vs $420 M at 10,000 pairs). On absolute volume terms it's +0.11 bps. **For 12 % more cost, Foxify gets:** zero service interruptions, zero payout clipping, fully predictable monthly billing, no month-1 reconciliation dispute, no need to instrument cooldown handling in their own systems.

3. **Cooldown stays in place as Atticus's tail-risk insurance.** The `COOLDOWN_CIRCUIT_BREAKER_SPEC.md` thresholds (T1 at 25 % capital, T2 at 4× pair count, T3 at −1.5σ MTM, T4 at DVOL > 100) are kept as-written. They fire essentially never (~13 days/yr per `COOLDOWN_FOXIFY_BREAKDOWN.md`) and limit worst-case pair-life P&L per `historical/stress_windows.md` (the COVID-style outlier weeks). They are NOT used to subsidise the ladder; they are not commercial features.

### 6.1 Does cooldown make that much difference, good or bad?

**Bottom line: no, cooldown is essentially decorative on economics.** The four reasons:

| Question | Answer |
|---|---|
| Does it reduce Atticus's mean P&L? | Yes by 0–7 % depending on aggressiveness ($0–$17 M/yr at 1,000 pairs cost). |
| Does it reduce Atticus's worst-case (p05) pair-life P&L? | Yes, materially — caps tail risk in named-crisis weeks per `historical/stress_windows.md`. **This is its real value.** |
| Does it reduce Foxify's payouts? | Trivially — 0.6 % of stress triggers under spec, 5.3 % at most aggressive setting. ~$1k–$8k/pair/yr foregone payout out of ~$312 k/pair/yr. |
| Does it create month-1 reconciliation friction with Foxify? | Yes, if Atticus prices using the assumed clip (it doesn't materialise, so realised Foxify cost is higher than quoted). **No, if Atticus prices using the no-cooldown ladder.** |

**The clean answer:** keep cooldown as an Atticus-side tail-risk control with current loose thresholds (cheap, fires rarely, no commercial impact). Quote Foxify the no-cooldown ladder. Both sides win on predictability; Atticus's economics actually work; Foxify's only cost is +12 % vs the fictional cooldown'd ladder.

## 7. The follow-up that closes this analysis

`historical_replay_cooldown.py` is now in the repo. Outputs in `docs/cfo-report/double-barrier-analysis/historical/`:

- `cooldown_per_pair.csv` — every (start_date, schedule, cd_config) replay cell (11,640 rows)
- `cooldown_summary.json` — per-config per-band aggregates
- `cooldown_threshold_sweep.csv` — clip % per config × band (the table in §3)
- `cooldown_pnl_summary.csv` — blended Atticus P&L per cd config (the table in §4)

To re-run after any cooldown spec change:

```bash
python3 scripts/double-barrier/historical_replay_cooldown.py
python3 scripts/double-barrier/cooldown_pnl_summary.py
```

If a future cooldown spec revision changes T1–T4 thresholds, re-run and compare the empirical clip to whatever pricing assumption depends on it. **Today's empirical clip is the binding fact: 0.0 % calm, 0.1 % mod, 0.3 % elev, 0.6 % stress under the spec as written. None of these are economically material.**

---

## 8. Bottom line — direct answer to the three questions

> **Q1: What's the absolute best price without cooldown?**
> **A1: $490 / $720 / $1,025 / $1,455 per pair per day** (uniform ~5 % Atticus margin on premium, derived directly from the no-cooldown breakeven floors). At 1,000 pairs: Atticus +$18 M/yr, Foxify $47 M/yr (1.49 bps on routed volume). Recommended customer-facing format keeps the 6 %-cap rebate ladder with base rates **$490 / $766 / $1,090 / $1,548**, rebating to the same $490 / $720 / $1,025 / $1,455 effective rates at 2,000+ pair-days/mo.
>
> **Q2: Would Foxify rather higher prices + no cooldown OR lower prices + cooldown?**
> **A2: Higher prices + no cooldown.** The "lower prices + cooldown" option is fictional — cooldown empirically can't deliver the clip the lower prices require, so Atticus would lose $49 M/yr at 1,000 pairs. The honest comparison is "+12 % cost to Foxify, zero service interruptions, zero payout clipping, fully predictable monthly billing, no reconciliation friction" vs "an unstable promised lower price that breaks within a quarter." Quote the no-cooldown ladder.
>
> **Q3: Does cooldown make that much difference, good or bad?**
> **A3: It's decorative on economics, valuable as tail-risk insurance.** Empirical replay across the full 6.4-year tape shows cooldown clips 0.0–0.6 % of triggers under the spec as written (vs the assumed 50 %). Tightening thresholds raises clip to at most 5 % but COSTS Atticus $0–$17 M/yr by holding stale strangles. Cooldown's real value is capping worst-case pair-life P&L in COVID-style outlier weeks (per `historical/stress_windows.md`) — keep it for that, don't price against it.

---

*Run reproducible:* `python3 scripts/double-barrier/historical_replay_cooldown.py && python3 scripts/double-barrier/cooldown_pnl_summary.py`. Inputs: `data/double-barrier/btc_hourly.csv` (56,028 hourly bars 2019-12-19 → 2026-05-10), `data/double-barrier/dvol_daily.csv` (1,874 DVOL days 2021-03-23 → 2026-05-10).
