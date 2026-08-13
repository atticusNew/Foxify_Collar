#!/usr/bin/env python3
"""
Compile the multi-axis sweep into the operational tables the user asked
for in their question:

  1. Per-pair-life P&L by (regime, premium, vrp, instrument).
  2. Breakeven premium per side per day by regime, by VRP scenario.
  3. Capital ladder: total capital required to support N concurrent pairs
     for each instrument.
  4. Burn-rate analysis: how long $30k + $50k credit line lasts at each
     premium / regime / vrp scenario.
  5. Trigger geometry: triggers/week by regime, distribution of P&L
     percentiles.

Outputs:
  - docs/cfo-report/double-barrier-analysis/SUMMARY.md  (human-readable)
  - docs/cfo-report/double-barrier-analysis/capital_ladder.csv
  - docs/cfo-report/double-barrier-analysis/breakeven_premium.csv
  - docs/cfo-report/double-barrier-analysis/per_pair_pnl.csv
"""

from __future__ import annotations

import csv
import json
import math
from pathlib import Path

ROOT = Path("docs/cfo-report/double-barrier-analysis")
SWEEP_PATH = ROOT / "sweep" / "sweep_results.json"

CONCURRENT_SCALES = [1, 4, 8, 12, 25, 50, 100, 250, 500, 1000]
HEDGE_INSTRUMENTS = ["straddle_30d", "strangle_7d", "daily_strangle",
                     "perp_delta_only"]
INSTRUMENT_LABELS = {
    "straddle_30d": "30d strangle (legacy Modified-Y)",
    "strangle_7d": "7d strangle",
    "daily_strangle": "Daily strangle",
    "perp_delta_only": "Perp-delta only (no convex hedge)",
}
REGIME_DVOL = {"calm": 45, "mod": 55, "elev": 65, "stress": 80}


def load_sweep() -> dict:
    return json.loads(SWEEP_PATH.read_text())


def get_row(sweep: dict, regime: str, premium: int, vrp: float):
    for r in sweep["results"]:
        if (r["regime"] == regime and r["premium_per_side_per_day"] == premium
                and abs(r["vrp"] - vrp) < 1e-9):
            return r
    return None


def write_per_pair_pnl(sweep: dict) -> None:
    with (ROOT / "per_pair_pnl.csv").open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow([
            "regime", "DVOL", "vrp", "premium_per_side_per_day",
            "instrument", "E[triggers/7d]",
            "E[premium/pair-life]", "E[payouts/pair-life]",
            "E[upfront_hedge]", "E[PnL/pair-life]",
            "p05_PnL/pair-life", "p95_PnL/pair-life",
            "P[PnL>0]_estimate",
        ])
        for r in sweep["results"]:
            for inst, sd in r["strategies"].items():
                # Quick estimate of P[PnL>0] from normal approximation
                mean = sd["e_pnl_pair_life"]
                std = sd["std_pnl"]
                if std > 1e-3:
                    z = mean / std
                    # standard normal CDF approx
                    p_pos = 0.5 * (1 + math.erf(z / math.sqrt(2)))
                else:
                    p_pos = 1.0 if mean > 0 else 0.0
                w.writerow([
                    r["regime"], REGIME_DVOL[r["regime"]], r["vrp"],
                    r["premium_per_side_per_day"], inst,
                    f"{sd['e_triggers']:.1f}",
                    f"{sd['premium_collected']:.0f}",
                    f"{sd['payouts_paid']:.0f}",
                    f"{sd['upfront_hedge']:.0f}",
                    f"{sd['e_pnl_pair_life']:.0f}",
                    f"{sd['p05_pnl']:.0f}",
                    f"{sd['p95_pnl']:.0f}",
                    f"{p_pos:.2f}",
                ])


def write_breakeven_premium(sweep: dict) -> None:
    """For each (regime, vrp, instrument), find the premium level at which
    E[PnL/pair-life] just turns non-negative.
    """
    rows = []
    premiums = sorted(set(r["premium_per_side_per_day"] for r in sweep["results"]))
    for vrp in sorted(set(r["vrp"] for r in sweep["results"])):
        for regime in ["calm", "mod", "elev", "stress"]:
            for inst in HEDGE_INSTRUMENTS:
                last_neg = None
                first_pos = None
                for p in premiums:
                    r = get_row(sweep, regime, p, vrp)
                    if r is None:
                        continue
                    pnl = r["strategies"][inst]["e_pnl_pair_life"]
                    if pnl < 0:
                        last_neg = (p, pnl)
                    elif first_pos is None:
                        first_pos = (p, pnl)
                # linear interpolate breakeven between last_neg and first_pos
                if last_neg and first_pos:
                    p1, pnl1 = last_neg
                    p2, pnl2 = first_pos
                    if pnl2 != pnl1:
                        be = p1 + (p2 - p1) * (-pnl1) / (pnl2 - pnl1)
                    else:
                        be = p2
                elif first_pos:
                    be = first_pos[0]
                else:
                    be = float("inf")
                rows.append({
                    "regime": regime,
                    "DVOL": REGIME_DVOL[regime],
                    "vrp": vrp,
                    "instrument": inst,
                    "breakeven_premium_per_side_per_day": be,
                    "breakeven_premium_per_pair_per_day": be * 2,
                })
    with (ROOT / "breakeven_premium.csv").open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow([
            "regime", "DVOL", "vrp", "instrument",
            "breakeven_premium_$/side/day",
            "breakeven_premium_$/pair/day",
        ])
        for r in rows:
            be = r["breakeven_premium_per_side_per_day"]
            be_str = f"{be:.0f}" if be != float("inf") else ">2000"
            be_pair = r["breakeven_premium_per_pair_per_day"]
            be_pair_str = f"{be_pair:.0f}" if be_pair != float("inf") else ">4000"
            w.writerow([
                r["regime"], r["DVOL"], r["vrp"], r["instrument"],
                be_str, be_pair_str,
            ])


def write_capital_ladder(sweep: dict) -> None:
    """For each scenario at the lowest premium that's break-even or better
    in that regime/vrp, compute capital required at each scale.
    """
    rows = []
    for vrp in [0.0, 0.20]:
        for regime in ["calm", "mod", "elev", "stress"]:
            for inst in HEDGE_INSTRUMENTS:
                # We compute capital at the user's stated premium ($250) AND
                # at the breakeven premium for context.
                for premium in [250, 400, 600, 800, 1000, 1500]:
                    r = get_row(sweep, regime, premium, vrp)
                    if r is None:
                        continue
                    sd = r["strategies"][inst]
                    upfront = sd["upfront_hedge"]
                    peak = sd["peak_hedge_book"]
                    pnl_mean = sd["e_pnl_pair_life"]
                    pnl_std = sd["std_pnl"]
                    pnl_p05 = sd["p05_pnl"]
                    for n in CONCURRENT_SCALES:
                        l1 = peak * n
                        # tail-shock buffer with sqrt-N pooling, p01 (z=2.33)
                        l2 = max(0.0, -pnl_p05) * math.sqrt(n) * 2.33 / 1.65
                        l3 = max(0.0, -pnl_mean) * n  # expected loss buffer
                        total = (l1 + l2 + l3) * 1.30
                        weekly_pnl_central = pnl_mean * n
                        weekly_pnl_p05 = (pnl_mean * n
                                          - 1.645 * pnl_std * math.sqrt(n))
                        rows.append({
                            "regime": regime,
                            "vrp": vrp,
                            "instrument": inst,
                            "premium_$/side/day": premium,
                            "concurrent_pairs": n,
                            "L1_hedge_equity": int(l1),
                            "L2_tail_buffer": int(l2),
                            "L3_loss_buffer": int(l3),
                            "total_capital_$": int(total),
                            "expected_weekly_aggregate_PnL": int(weekly_pnl_central),
                            "p05_weekly_aggregate_PnL": int(weekly_pnl_p05),
                            "weeks_to_burn_30k_at_E[PnL]": (
                                int(30_000 / -pnl_mean / max(1, n))
                                if pnl_mean < 0 else None
                            ),
                        })
    with (ROOT / "capital_ladder.csv").open("w", newline="") as f:
        if rows:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            for r in rows:
                w.writerow(r)


def render_summary_md(sweep: dict) -> None:
    cfg = sweep["config"]
    lines: list[str] = []
    push = lines.append

    push(f"# Double-Barrier Hedge Analysis — Sweep Summary\n")
    push(f"> Generated by `scripts/double-barrier/analyze_sweep.py` from "
         f"`{SWEEP_PATH.name}`.\n")
    push("> Each cell is the mean across "
         f"{cfg['paths']:,} risk-neutral GBM Monte-Carlo paths "
         f"per regime, with continuous-monitoring Brownian-bridge barrier "
         f"correction. Hedge legs are priced at implied vol (DVOL); "
         f"barrier physics use realized vol = implied × (1 − VRP).\n")
    push("> Product invariants: "
         f"$50,000 notional per side, ±2% trigger, 7-day max trader tenor, "
         f"$1,000 per-trigger payout, 50 bps round-trip option spread, "
         f"5% risk-free.\n")

    push("## 1. Trigger frequency by regime\n")
    push("How many ±2% triggers we expect per pair over the 7-day life.")
    push("| Regime | DVOL | σ implied | σ realized (vrp=0.20) | E[triggers / 7d] | p95 triggers / 7d |")
    push("|---|---|---|---|---|---|")
    for regime in ["calm", "mod", "elev", "stress"]:
        r0 = get_row(sweep, regime, 250, 0.0)
        r1 = get_row(sweep, regime, 250, 0.20)
        if r0 is None or r1 is None:
            continue
        sd0 = r0["strategies"]["straddle_30d"]
        sd1 = r1["strategies"]["straddle_30d"]
        push(f"| {regime} | {REGIME_DVOL[regime]} | "
             f"{r0['sigma_implied']:.2f} | "
             f"{r1['sigma_realized']:.2f} | "
             f"{sd0['e_triggers']:.1f} (rn) / {sd1['e_triggers']:.1f} (vrp=20%) | "
             f"{sd0['p95_triggers']:.0f} (rn) / {sd1['p95_triggers']:.0f} |")
    push("")

    push("## 2. Breakeven premium per side per day\n")
    push("Lowest premium at which expected P&L per pair-life turns ≥ 0.")
    push("Reading: in the **moderate** regime under risk-neutral pricing, "
         "the platform must charge **about the breakeven number per side per "
         "day** to cover expected payouts. Numbers above the bracketed range are "
         "well outside the user-proposed $250–$400/side band.\n")

    push("**Risk-neutral (σ_realized = σ_implied):**\n")
    push("| Regime | 30d strangle | 7d strangle | Daily strangle | Perp-delta only |")
    push("|---|---|---|---|---|")
    for regime in ["calm", "mod", "elev", "stress"]:
        cells = [f"{regime} (DVOL {REGIME_DVOL[regime]})"]
        for inst in HEDGE_INSTRUMENTS:
            be = _breakeven_for(sweep, regime, inst, 0.0)
            cells.append(f"${be:.0f}/side/day" if be < 5000 else ">$2000")
        push("| " + " | ".join(cells) + " |")
    push("")

    push("**With 20% vol-risk-premium (realized vol 20% below DVOL — the typical empirical regime):**\n")
    push("| Regime | 30d strangle | 7d strangle | Daily strangle | Perp-delta only |")
    push("|---|---|---|---|---|")
    for regime in ["calm", "mod", "elev", "stress"]:
        cells = [f"{regime} (DVOL {REGIME_DVOL[regime]})"]
        for inst in HEDGE_INSTRUMENTS:
            be = _breakeven_for(sweep, regime, inst, 0.20)
            cells.append(f"${be:.0f}/side/day" if be < 5000 else ">$2000")
        push("| " + " | ".join(cells) + " |")
    push("")

    push("## 3. Per-pair-life P&L at the user-proposed premium tiers\n")
    push("These are the headline economics at the **user's proposed premium "
         "schedule** ($250 base, $400 elevated). The numbers below assume "
         "realized vol = DVOL. With VRP haircut, all numbers improve modestly.\n")

    for vrp in [0.0, 0.20]:
        push(f"### VRP = {int(vrp*100)}% "
             f"({'risk-neutral' if vrp==0 else 'realized 20% below implied'})\n")
        push("| Regime | Premium/side | Instrument | E[Triggers/7d] | "
             "Premium collected | Payouts paid | E[Hedge PnL] | "
             "**E[PnL/pair-life]** |")
        push("|---|---|---|---|---|---|---|---|")
        for premium in [250, 400, 600]:
            for regime in ["calm", "mod", "elev"]:
                r = get_row(sweep, regime, premium, vrp)
                if r is None:
                    continue
                for inst in ["straddle_30d", "daily_strangle"]:
                    sd = r["strategies"][inst]
                    hedge_pnl = (sd["e_pnl_pair_life"]
                                 - sd["premium_collected"]
                                 + sd["payouts_paid"])
                    push(f"| {regime} | ${premium} | {INSTRUMENT_LABELS[inst]} | "
                         f"{sd['e_triggers']:.1f} | "
                         f"${sd['premium_collected']:.0f} | "
                         f"${sd['payouts_paid']:.0f} | "
                         f"${hedge_pnl:.0f} | "
                         f"**${sd['e_pnl_pair_life']:.0f}** |")
        push("")

    push("## 4. Capital required at scale (1000 concurrent pairs)\n")
    push("Total capital = `1.30 × (L1 hedge equity + L2 tail buffer + L3 expected loss buffer)`. "
         "L1 scales linearly; L2 scales sub-linearly with √N (pair independence); "
         "L3 scales linearly when E[PnL] is negative.\n")

    for vrp in [0.0, 0.20]:
        push(f"### VRP = {int(vrp*100)}%\n")
        push("| Regime | Instrument | Premium $/side/day | "
             "L1 (option equity) | L2 (tail buffer) | L3 (loss buffer) | "
             "**Total cap** | E[weekly P&L] | p05 weekly P&L |")
        push("|---|---|---|---|---|---|---|---|---|")
        for regime in ["mod"]:  # focus on moderate as the operating regime
            for inst in HEDGE_INSTRUMENTS:
                for premium in [250, 600, 1000]:
                    r = get_row(sweep, regime, premium, vrp)
                    if r is None:
                        continue
                    sd = r["strategies"][inst]
                    n = 1000
                    l1 = sd["peak_hedge_book"] * n
                    l2 = max(0.0, -sd["p05_pnl"]) * math.sqrt(n) * 2.33 / 1.65
                    l3 = max(0.0, -sd["e_pnl_pair_life"]) * n
                    total = (l1 + l2 + l3) * 1.30
                    weekly = sd["e_pnl_pair_life"] * n
                    weekly_p05 = weekly - 1.645 * sd["std_pnl"] * math.sqrt(n)
                    push(f"| {regime} | {INSTRUMENT_LABELS[inst]} | ${premium} | "
                         f"${l1/1e6:.2f}M | ${l2/1e6:.2f}M | ${l3/1e6:.2f}M | "
                         f"**${total/1e6:.2f}M** | "
                         f"${weekly/1e6:+.2f}M | "
                         f"${weekly_p05/1e6:+.2f}M |")
        push("")

    push("## 5. Burn-rate test of user's $30k + $50k facility\n")
    push("How long $80,000 of operating + credit-line capital lasts at "
         "**N concurrent pairs in moderate regime**, before fresh injection. "
         "Negative E[PnL] means the facility is a draining clock.\n")

    push("| Concurrent pairs | Premium $/side | Instrument | "
         "Up-front hedge book | Net E[weekly PnL] | Weeks until $80k burn |")
    push("|---|---|---|---|---|---|")
    for n_pairs in [4, 8, 12, 25, 50]:
        for premium in [250, 600]:
            for inst in ["straddle_30d", "daily_strangle"]:
                r = get_row(sweep, "mod", premium, 0.0)
                if r is None:
                    continue
                sd = r["strategies"][inst]
                upfront_total = sd["peak_hedge_book"] * n_pairs
                weekly_pnl = sd["e_pnl_pair_life"] * n_pairs
                if weekly_pnl < 0:
                    weeks_to_burn = 80_000 / -weekly_pnl
                    weeks_str = f"{weeks_to_burn:.1f}"
                else:
                    weeks_str = "∞ (positive)"
                push(f"| {n_pairs} | ${premium} | {INSTRUMENT_LABELS[inst]} | "
                     f"${upfront_total:,.0f} | "
                     f"${weekly_pnl:+,.0f} | {weeks_str} |")
    push("")

    push("---\n## Methodology notes\n")
    push("- Paths simulated under risk-neutral GBM with sigma_realized = sigma_implied × (1 − VRP). "
         "Brownian-bridge barrier correction applied at each step.")
    push("- Hedge book valued via Black-Scholes at sigma_implied with 50bps round-trip slippage.")
    push("- The 30-day instrument auto-renews each triggered leg at the new spot, fresh 30-day expiry; "
         "all legs are mark-to-market unwound at trader-period end.")
    push("- The risk-neutral case (VRP = 0) shows a structural near-zero mean for hedge P&L "
         "regardless of instrument, because all option payoffs are martingales under Q.")
    push("- The VRP = 20% case mimics the typical empirical BTC implied-realized gap "
         "(Deribit DVOL has run ~10–25% above realized over 2024–2026 outside crisis windows). "
         "In that case, **long-vol hedging is structurally negative carry** and capital-light "
         "hedges (perp-delta, daily strangle) outperform multi-day straddles.")
    push("- These results assume independent trader pairs (paths sampled independently). "
         "Real correlated-trigger episodes (everyone triggers when DVOL pops) require "
         "additional concentration-cap controls. Capital tables apply a sqrt-N pooling of "
         "shocks which tightens for large N; in correlated stress, treat L2 as N-linear.\n")


def _breakeven_for(sweep: dict, regime: str, instrument: str, vrp: float) -> float:
    premiums = sorted(set(r["premium_per_side_per_day"] for r in sweep["results"]))
    last_neg = None
    first_pos = None
    for p in premiums:
        r = get_row(sweep, regime, p, vrp)
        if r is None:
            continue
        pnl = r["strategies"][instrument]["e_pnl_pair_life"]
        if pnl < 0:
            last_neg = (p, pnl)
        elif first_pos is None:
            first_pos = (p, pnl)
    if last_neg and first_pos:
        p1, pnl1 = last_neg
        p2, pnl2 = first_pos
        if pnl2 != pnl1:
            return p1 + (p2 - p1) * (-pnl1) / (pnl2 - pnl1)
        return p2
    if first_pos:
        return first_pos[0]
    return float("inf")


def main() -> None:
    sweep = load_sweep()
    write_per_pair_pnl(sweep)
    write_breakeven_premium(sweep)
    write_capital_ladder(sweep)
    md_lines = []
    # Capture summary into local variable; render_summary_md writes to file
    out_path = ROOT / "SUMMARY.md"
    # We render into a file, replicating render_summary_md but capturing.
    import io, contextlib
    # Simpler: temporarily replace push with file write
    with out_path.open("w") as f:
        # Hack: monkey-patch render_summary_md by re-running with capture
        from contextlib import redirect_stdout
        # We'll directly call render_summary_md but write to file via builder
        old_lines = []
        def push(s):
            old_lines.append(s)
        # Re-import a fresh body executing with our push... simplest approach:
        import importlib, sys
        # Instead, just reuse the function: it appends to a list named lines
        # in its own scope. We refactor differently:
    # Just re-call but capture as string properly:
    s = _build_summary(sweep)
    out_path.write_text(s)
    print(f"Wrote {out_path}")


def _build_summary(sweep: dict) -> str:
    """Re-implementation of render_summary_md that returns the string."""
    cfg = sweep["config"]
    lines: list[str] = []
    P = lines.append

    P(f"# Double-Barrier Hedge Analysis — Sweep Summary\n")
    P(f"> Generated by `scripts/double-barrier/analyze_sweep.py` from "
      f"`{SWEEP_PATH.name}`.")
    P(f"> {cfg['paths']:,} risk-neutral GBM Monte-Carlo paths per regime, "
      f"continuous-monitoring Brownian-bridge barrier correction. "
      f"Hedge legs are priced at implied vol (DVOL); "
      f"barrier physics use realized vol = implied × (1 − VRP).")
    P(f"> Product invariants: "
      f"$50,000 notional per side, ±2% trigger, 7-day max trader tenor, "
      f"$1,000 per-trigger payout, 50 bps round-trip option spread, "
      f"5% risk-free.\n")

    P("## 1. Trigger frequency by regime\n")
    P("Number of ±2% triggers per pair over the 7-day trader life. "
      "Captures intra-day re-anchoring (after a trigger fires, the "
      "next ±2% boundary is measured from the new spot).\n")
    P("| Regime | DVOL | σ implied | σ realized (vrp=20%) | "
      "E[triggers/7d] (rn / vrp20) | p95 triggers/7d |")
    P("|---|---|---|---|---|---|")
    for regime in ["calm", "mod", "elev", "stress"]:
        r0 = get_row(sweep, regime, 250, 0.0)
        r1 = get_row(sweep, regime, 250, 0.20)
        if r0 is None or r1 is None:
            continue
        sd0 = r0["strategies"]["straddle_30d"]
        sd1 = r1["strategies"]["straddle_30d"]
        P(f"| {regime} | {REGIME_DVOL[regime]} | "
          f"{r0['sigma_implied']:.2f} | "
          f"{r1['sigma_realized']:.2f} | "
          f"{sd0['e_triggers']:.1f} / {sd1['e_triggers']:.1f} | "
          f"{sd0['p95_triggers']:.0f} / {sd1['p95_triggers']:.0f} |")
    P("")

    P("## 2. Breakeven premium per side per day\n")
    P("Lowest premium at which **E[P&L per pair-life] ≥ 0**, by hedge instrument. "
      "Linearly interpolated between simulated grid points.\n")

    for vrp in [0.0, 0.20]:
        label = "risk-neutral" if vrp == 0 else "realized 20% below implied"
        P(f"### VRP = {int(vrp*100)}% ({label})\n")
        P("| Regime | 30d strangle | 7d strangle | Daily strangle | Perp-delta only |")
        P("|---|---|---|---|---|")
        for regime in ["calm", "mod", "elev", "stress"]:
            cells = [f"{regime} (DVOL {REGIME_DVOL[regime]})"]
            for inst in HEDGE_INSTRUMENTS:
                be = _breakeven_for(sweep, regime, inst, vrp)
                cells.append(f"${be:.0f}/side/day" if be < 4000 else ">$2,000")
            P("| " + " | ".join(cells) + " |")
        P("")

    P("## 3. Per-pair-life P&L at user-proposed premium tiers\n")
    for vrp in [0.0, 0.20]:
        label = "risk-neutral" if vrp == 0 else "realized 20% below implied"
        P(f"### VRP = {int(vrp*100)}% ({label})\n")
        P("| Regime | Premium $/side | Instrument | E[Triggers/7d] | "
          "Premium $ | Payouts $ | Hedge net $ | **E[PnL/pair-life]** | p05 PnL |")
        P("|---|---|---|---|---|---|---|---|---|")
        for regime in ["calm", "mod", "elev", "stress"]:
            for premium in [250, 400, 600]:
                for inst in ["straddle_30d", "daily_strangle"]:
                    r = get_row(sweep, regime, premium, vrp)
                    if r is None:
                        continue
                    sd = r["strategies"][inst]
                    hedge_net = (sd["e_pnl_pair_life"]
                                 - sd["premium_collected"]
                                 + sd["payouts_paid"])
                    P(f"| {regime} | ${premium} | {INSTRUMENT_LABELS[inst]} | "
                      f"{sd['e_triggers']:.1f} | "
                      f"${sd['premium_collected']:.0f} | "
                      f"${sd['payouts_paid']:.0f} | "
                      f"${hedge_net:.0f} | "
                      f"**${sd['e_pnl_pair_life']:.0f}** | "
                      f"${sd['p05_pnl']:.0f} |")
        P("")

    P("## 4. Capital required to support 1,000 concurrent pairs\n")
    P("Total capital model: `1.30 × (L1 + L2 + L3)` where L1 = peak hedge book "
      "(linear in N), L2 = tail-shock buffer at 99th-percentile pair P&L using "
      "√N independent-pair pooling, L3 = expected-loss reserve = max(0, "
      "−E[PnL]) × N.\n")

    P("| VRP | Regime | Instrument | Premium $/side | "
      "L1 ($M) | L2 ($M) | L3 ($M) | **Total ($M)** | E[weekly P&L] $M | p05 weekly P&L $M |")
    P("|---|---|---|---|---|---|---|---|---|---|")
    for vrp in [0.0, 0.20]:
        for regime in ["mod", "elev"]:
            for inst in HEDGE_INSTRUMENTS:
                for premium in [250, 600, 1000]:
                    r = get_row(sweep, regime, premium, vrp)
                    if r is None:
                        continue
                    sd = r["strategies"][inst]
                    n = 1000
                    l1 = sd["peak_hedge_book"] * n
                    l2 = max(0.0, -sd["p05_pnl"]) * math.sqrt(n) * 2.33 / 1.65
                    l3 = max(0.0, -sd["e_pnl_pair_life"]) * n
                    total = (l1 + l2 + l3) * 1.30
                    weekly = sd["e_pnl_pair_life"] * n
                    weekly_p05 = weekly - 1.645 * sd["std_pnl"] * math.sqrt(n)
                    P(f"| {int(vrp*100)}% | {regime} | "
                      f"{INSTRUMENT_LABELS[inst]} | ${premium} | "
                      f"${l1/1e6:.2f} | ${l2/1e6:.2f} | ${l3/1e6:.2f} | "
                      f"**${total/1e6:.2f}** | "
                      f"${weekly/1e6:+.2f} | ${weekly_p05/1e6:+.2f} |")
    P("")

    P("## 5. Burn-rate of $30k operating + $50k credit line\n")
    P("Worst-case cash drain at moderate (DVOL 55) regime, risk-neutral pricing. "
      "**Negative E[PnL]/week × N concurrent** = how fast $80k is consumed.\n")
    P("| N pairs | Premium $/side | Instrument | "
      "Upfront hedge book | Weekly E[PnL] | Weeks to burn $80k |")
    P("|---|---|---|---|---|---|")
    for n_pairs in [4, 8, 12, 25, 50]:
        for premium in [250, 600, 1000]:
            for inst in ["straddle_30d", "daily_strangle"]:
                r = get_row(sweep, "mod", premium, 0.0)
                if r is None:
                    continue
                sd = r["strategies"][inst]
                upfront_total = sd["peak_hedge_book"] * n_pairs
                weekly_pnl = sd["e_pnl_pair_life"] * n_pairs
                if weekly_pnl < 0:
                    weeks_to_burn = 80_000 / -weekly_pnl
                    weeks_str = f"{weeks_to_burn:.1f}"
                else:
                    weeks_str = "∞ (cash-positive)"
                P(f"| {n_pairs} | ${premium} | {INSTRUMENT_LABELS[inst]} | "
                  f"${upfront_total:,.0f} | "
                  f"${weekly_pnl:+,.0f} | {weeks_str} |")
    P("")

    P("---\n## Methodology notes\n")
    P("- Paths simulated under risk-neutral GBM with σ_realized = σ_implied × (1 − VRP). "
      "Brownian-bridge barrier correction applied at each step.")
    P("- Hedge book valued via Black-Scholes at σ_implied with 50bps round-trip slippage.")
    P("- The 30-day instrument auto-renews each triggered leg at the new spot, fresh 30-day expiry; "
      "all legs are mark-to-market unwound at trader-period end.")
    P("- The risk-neutral case (VRP = 0) shows hedge P&L mean ≈ 0 regardless of instrument, "
      "because option payoffs are Q-martingales by construction. The product is "
      "structurally underpriced unless premium ≥ E[payouts].")
    P("- The VRP = 20% case mimics the typical empirical BTC implied-realized gap "
      "(Deribit DVOL has run ~10–25% above realized BTC vol outside crisis windows). "
      "In that case, **long-vol hedging is negative-carry** and capital-light hedges "
      "(perp-delta, daily strangle) outperform multi-day straddles.")
    P("- Capital tables assume independent pairs (sqrt-N pooling). Correlated-trigger "
      "episodes (everyone triggers when DVOL pops) require additional concentration-cap "
      "controls — for stress scenarios, treat L2 as N-linear, not √N.\n")
    return "\n".join(lines)


if __name__ == "__main__":
    main()
