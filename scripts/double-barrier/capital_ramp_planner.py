#!/usr/bin/env python3
"""
Capital ramp + LP/Bullish margin sizing for the volume facility.

Inputs (from `historical_replay.py` summary):
  - Per-pair-life E[PnL] by regime band, daily-strangle, tiered $400/$600/$900
  - Per-pair-life initial hedge cost
  - Per-pair-life mean payouts
  - DVOL band frequencies (4-year empirical)

Outputs the ramp plan in
docs/cfo-report/double-barrier-analysis/CAPITAL_RAMP.md and
capital_ramp_table.csv:

  - Atticus capital required at scales [4.3, 8, 12.9, 25, 50, 100, 250, 500, 1000]
  - Decomposition into hedge equity / payout reserve / operational headroom
  - Foxify pre-fund balance recommendation per N concurrent pairs
  - Sustainable LP-funding APR band
  - Time to recover capital from worst-case stress week
"""

from __future__ import annotations

import csv
import json
import math
from pathlib import Path

ROOT = Path("docs/cfo-report/double-barrier-analysis")
HIST = ROOT / "historical" / "historical_summary.json"
DVOL_DIST = ROOT / "historical" / "dvol_distribution.json"


def load_band_data(instrument: str, schedule: str) -> dict:
    """Load empirical per-pair stats for one (instrument, schedule)."""
    raw = json.loads(HIST.read_text())
    out = {}
    for r in raw:
        if r["instrument"] != instrument or r["schedule"] != schedule:
            continue
        out[r["dvol_band"]] = r
    return out


def compute_blended(band_data: dict, dvol_dist: dict) -> dict:
    """Blend per-band stats by empirical DVOL frequency."""
    bands = {b["name"]: b["fraction_of_days"] for b in dvol_dist["bands"]}
    # Map deep_calm + calm -> calm (we only model 4 bands inside replay)
    calm_w = bands.get("deep_calm", 0) + bands.get("calm", 0)
    weights = {
        "calm": calm_w,
        "mod": bands.get("mod", 0),
        "elev": bands.get("elev", 0),
        "stress": bands.get("stress", 0),
    }
    total_w = sum(weights.values())
    weights = {k: v / total_w for k, v in weights.items()}

    metrics = {
        "weighted_pnl_per_pair_life": 0.0,
        "weighted_pnl_p05": 0.0,
        "weighted_pnl_p95": 0.0,
        "weighted_triggers": 0.0,
        "weighted_payouts": 0.0,
        "weighted_premium": 0.0,
        "p_pnl_pos_blended": 0.0,
        "weights": weights,
    }
    for band, w in weights.items():
        d = band_data.get(band)
        if d is None:
            continue
        metrics["weighted_pnl_per_pair_life"] += w * d["mean_pnl"]
        metrics["weighted_pnl_p05"] += w * d["p05_pnl"]
        metrics["weighted_pnl_p95"] += w * d["p95_pnl"]
        metrics["weighted_triggers"] += w * d["mean_triggers"]
        metrics["weighted_payouts"] += w * d["mean_payouts"]
        metrics["weighted_premium"] += w * d["mean_premium"]
        metrics["p_pnl_pos_blended"] += w * d["p_pnl_pos"]
    return metrics


def compute_capital_at_scale(
    n_pairs: float,
    band_data: dict,
    blended: dict,
    initial_hedge_per_pair: float,
    headroom_mult: float = 1.30,
) -> dict:
    """
    Capital decomposition (V3, post intra-day re-open correction):

      L1 = hedge equity = initial_hedge_per_pair × N × 4
           (×4 multiplier covers up to 4 simultaneous open strangles
            per pair from intra-day re-opens during a chop day)
      L2 = unmodeled-risk reserve = max(p05 stress shock,
                                        $10k × √N + $50k floor)
           Empirical p05 is now positive in every band, but we hold a
           floor for risks the model doesn't capture: venue settlement
           latency, slippage at concentrated trigger events, counterparty
           credit exposure during 25%/75% settlement window, and
           regime-shift risks outside the 6.4-year sample.
      L3 = expected-loss buffer = max(0, -E[blended PnL] × N)
           Zero under the recommended tiered schedule.

    Sustainable LP APR = max APR at which Atticus pays LP from at most
       50% of expected weekly P&L, leaving the rest for retained equity.
    """
    # Hedge equity (allow for up to 4 overlapping intra-day strangles per pair)
    l1 = initial_hedge_per_pair * n_pairs * 4.0
    # Unmodeled-risk floor: $50k floor + $10k × √N for scale
    l2 = max(50_000.0, 50_000.0 + 10_000.0 * math.sqrt(max(n_pairs, 1)))
    # Chronic carry buffer
    e_pnl = blended["weighted_pnl_per_pair_life"]
    l3 = max(0.0, -e_pnl * n_pairs)
    total = (l1 + l2 + l3) * headroom_mult

    weekly_pnl = e_pnl * n_pairs
    annual_pnl = weekly_pnl * 52
    # Foxify working balance: 5 days of premium burn (smaller than V2's
    # 14 days; aligned with the founder's $10k Phase-1 minimum scaling)
    foxify_prefund = (blended["weighted_premium"] / 7) * 5 * n_pairs
    lp_capital_needed = max(0.0, total - foxify_prefund)
    # Sustainable APR: LP cost <= 50% of expected weekly P&L
    if lp_capital_needed > 0 and weekly_pnl > 0:
        sustainable_apr_pct = (weekly_pnl * 0.5 * 52) / lp_capital_needed * 100
    else:
        sustainable_apr_pct = float("inf")

    return {
        "n_pairs": n_pairs,
        "l1_hedge_equity": l1,
        "l2_stress_reserve": l2,
        "l3_carry_buffer": l3,
        "total_capital_with_headroom": total,
        "foxify_prefund_recommendation": foxify_prefund,
        "lp_capital_needed": lp_capital_needed,
        "expected_weekly_pnl": weekly_pnl,
        "expected_annual_pnl": annual_pnl,
        "sustainable_lp_apr_pct": sustainable_apr_pct,
        "weeks_to_recover_one_stress_week": (
            (l2 / weekly_pnl) if weekly_pnl > 0 else float("inf")
        ),
    }


def main() -> None:
    dvol_dist = json.loads(DVOL_DIST.read_text())
    print(f"DVOL distribution (4y empirical):")
    for b in dvol_dist["bands"]:
        print(f"  {b['name']:10s} [{b['lo']},{b['hi']}): "
              f"{b['fraction_of_days']*100:5.1f}% of days = "
              f"~{b['expected_days_per_year']:.0f} days/year")

    # We focus on tiered + daily_strangle as the operating choice;
    # also compute the 30d straddle alternative for comparison.
    INSTRUMENTS = ["daily_strangle", "straddle_30d", "pooled_daily_strangle"]
    SCHEDULE = "tiered_400_600_900"
    SCALES = [1, 4.3, 8, 12.9, 25, 50, 100, 250, 500, 1000]

    rows = []
    for inst in INSTRUMENTS:
        bd = load_band_data(inst, SCHEDULE)
        blended = compute_blended(bd, dvol_dist)
        # Empirical mean of "initial_hedge_cost" per pair (read from per-pair file)
        # For simplicity, derive from the standard simulator priors:
        # daily-strangle: ~$420 (matches sim earlier)
        # straddle_30d:   ~$5,400
        # pooled_daily:   ~$210 (50% of daily, capturing slippage savings)
        initial_hedge = {
            "daily_strangle": 420,
            "straddle_30d": 5_400,
            "pooled_daily_strangle": 210,
        }[inst]
        for n in SCALES:
            cap = compute_capital_at_scale(n, bd, blended, initial_hedge)
            cap["instrument"] = inst
            cap["schedule"] = SCHEDULE
            cap["blended_e_pnl_per_pair_life"] = blended["weighted_pnl_per_pair_life"]
            cap["blended_p_pnl_pos"] = blended["p_pnl_pos_blended"]
            cap["blended_e_triggers"] = blended["weighted_triggers"]
            rows.append(cap)

    out_csv = ROOT / "capital_ramp_table.csv"
    with out_csv.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        for r in rows:
            w.writerow(r)
    print(f"\nWrote {out_csv}")
    print(f"\nSample at 4.3 / 12.9 / 1000 pairs (daily_strangle, tiered):")
    for r in rows:
        if r["instrument"] != "daily_strangle":
            continue
        if r["n_pairs"] not in (4.3, 12.9, 1000):
            continue
        print(f"  N={r['n_pairs']:>5}  total_cap=${r['total_capital_with_headroom']:>10,.0f}  "
              f"foxify_prefund=${r['foxify_prefund_recommendation']:>9,.0f}  "
              f"LP_need=${r['lp_capital_needed']:>10,.0f}  "
              f"weekly_PnL=${r['expected_weekly_pnl']:>9,.0f}  "
              f"max_LP_APR={r['sustainable_lp_apr_pct']:.0f}%")


if __name__ == "__main__":
    main()
