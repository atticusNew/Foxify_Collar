#!/usr/bin/env python3
"""
Full multi-axis sweep for the Atticus double-barrier hedge analysis.

Axes
----
  - Vol regime: calm / mod / elev / stress
  - Premium: $250 / $375 / $500 / $750 / $1000 / $1500 per side per day
  - Vol-risk-premium haircut: 0% (risk-neutral) and 20% (typical empirical)
  - Hedge instrument: straddle_30d / strangle_7d / daily_strangle / perp_delta_only

Outputs to docs/cfo-report/double-barrier-analysis/sweep/.

This is the canonical artifact the CFO + structurer can replay.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

import simulator as sim


PREMIUM_LEVELS_USD_PER_SIDE = [250, 400, 600, 800, 1000, 1500, 2000]
VRP_LEVELS = [0.0, 0.20]
REGIMES = ["calm", "mod", "elev", "stress"]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--paths", type=int, default=4000)
    parser.add_argument("--steps-per-day", type=int, default=24)
    parser.add_argument("--out", type=str,
                        default="docs/cfo-report/double-barrier-analysis/sweep")
    parser.add_argument("--seed", type=int, default=20260510)
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(args.seed)

    master = {
        "config": {
            "paths": args.paths,
            "steps_per_day": args.steps_per_day,
            "premium_levels_usd_per_side": PREMIUM_LEVELS_USD_PER_SIDE,
            "vrp_levels": VRP_LEVELS,
            "regimes": REGIMES,
            "product_constants": {
                "spot0": 75_000,
                "notional_per_side_usd": 50_000,
                "barrier_pct": 0.02,
                "max_days": 7,
                "payout_per_trigger_usd": 1_000,
                "venue_spread_bps": 50,
            },
        },
        "results": [],
    }

    n_runs = len(REGIMES) * len(VRP_LEVELS) * len(PREMIUM_LEVELS_USD_PER_SIDE)
    run = 0

    for vrp in VRP_LEVELS:
        for premium in PREMIUM_LEVELS_USD_PER_SIDE:
            for regime in REGIMES:
                run += 1
                product = sim.Product(premium_per_pair_day=premium * 2)
                print(f"[{run}/{n_runs}] regime={regime:6s}  vrp={vrp:.2f}  "
                      f"premium=${premium}/side/day", flush=True)
                regime_data = sim.run_regime(
                    regime, product, args.paths, args.steps_per_day, rng, vrp=vrp,
                )
                row = {
                    "regime": regime,
                    "vrp": vrp,
                    "premium_per_side_per_day": premium,
                    "premium_per_pair_per_day": premium * 2,
                    "sigma_implied": regime_data["sigma_implied"],
                    "sigma_realized": regime_data["sigma_realized"],
                    "strategies": {},
                }
                for strat, sd in regime_data["strategies"].items():
                    row["strategies"][strat] = {
                        "e_pnl_pair_life": sd["pnl"]["mean"],
                        "p05_pnl": sd["pnl"]["p05"],
                        "p25_pnl": sd["pnl"]["p25"],
                        "p50_pnl": sd["pnl"]["p50"],
                        "p75_pnl": sd["pnl"]["p75"],
                        "p95_pnl": sd["pnl"]["p95"],
                        "std_pnl": sd["pnl"]["std"],
                        "e_triggers": sd["triggers"]["mean"],
                        "p95_triggers": sd["triggers"]["p95"],
                        "upfront_hedge": sd["initial_hedge_cost"]["mean"],
                        "peak_hedge_book": sd["peak_hedge_book_cost"]["p95"],
                        "premium_collected": sd["premium_collected"]["mean"],
                        "payouts_paid": sd["payouts_paid"]["mean"],
                    }
                master["results"].append(row)

    (out_dir / "sweep_results.json").write_text(json.dumps(master, indent=2))
    print(f"\nSweep complete -> {out_dir / 'sweep_results.json'}")


if __name__ == "__main__":
    main()
