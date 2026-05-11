#!/usr/bin/env python3
"""Compute per-pair-life P&L impact of cooldown from cooldown_per_pair.csv.

Plots empirical Atticus P&L per band per cooldown config so we can see
what the actual economic effect of cooldown is — and whether the
20/30/50% trigger-clip assumption used in the pricing math is
recoverable under any cooldown threshold tuning.
"""
from __future__ import annotations
import csv
from collections import defaultdict
from pathlib import Path

CSV_PATH = Path("docs/cfo-report/double-barrier-analysis/historical/cooldown_per_pair.csv")
OUT_PATH = Path("docs/cfo-report/double-barrier-analysis/historical/cooldown_pnl_summary.csv")

BANDS = ["calm", "mod", "elev", "stress"]
WEIGHTS = {"calm": 0.354, "mod": 0.428, "elev": 0.144, "stress": 0.058}
PAIR_LIVES_PER_YEAR = 365 / 7  # ~52 pair-lives per year per slot

rows: dict[tuple[str, str], list[dict]] = defaultdict(list)
with CSV_PATH.open() as f:
    for r in csv.DictReader(f):
        key = (r["cd_config"], r["dvol_band"])
        rows[key].append({
            "premium": float(r["premium_collected"]),
            "payouts": float(r["payouts_paid"]),
            "hedge_out": float(r["hedge_cash_out"]),
            "hedge_in": float(r["hedge_cash_in"]),
            "triggers": int(r["triggers"]),
            "pnl": float(r["pnl_pair_life"]),
            "cd_hours": int(r["cd_hours_active"]),
            "pair_hours": int(r["pair_hours"]),
        })

cfg_names = sorted({k[0] for k in rows.keys()})

# Compute per (cfg, band) means and blended numbers
agg: dict[tuple[str, str], dict] = {}
for (cfg, band), bucket in rows.items():
    n = len(bucket)
    mean_premium = sum(b["premium"] for b in bucket) / n
    mean_payouts = sum(b["payouts"] for b in bucket) / n
    mean_hedge_net = sum(b["hedge_out"] - b["hedge_in"] for b in bucket) / n
    mean_pnl = sum(b["pnl"] for b in bucket) / n
    mean_triggers = sum(b["triggers"] for b in bucket) / n
    mean_cd_pct = sum(b["cd_hours"] for b in bucket) / max(sum(b["pair_hours"] for b in bucket), 1) * 100
    agg[(cfg, band)] = {
        "n": n,
        "mean_premium_pl": mean_premium,
        "mean_payouts_pl": mean_payouts,
        "mean_hedge_net_pl": mean_hedge_net,
        "mean_pnl_pl": mean_pnl,
        "mean_triggers_pl": mean_triggers,
        "cd_active_pct_hours": mean_cd_pct,
        "atticus_margin_pct": (mean_pnl / mean_premium * 100) if mean_premium > 0 else 0,
    }

# Blended per cfg
blended = {}
for cfg in cfg_names:
    pnl_blend = sum(WEIGHTS[b] * agg[(cfg, b)]["mean_pnl_pl"] for b in BANDS if (cfg, b) in agg)
    premium_blend = sum(WEIGHTS[b] * agg[(cfg, b)]["mean_premium_pl"] for b in BANDS if (cfg, b) in agg)
    payouts_blend = sum(WEIGHTS[b] * agg[(cfg, b)]["mean_payouts_pl"] for b in BANDS if (cfg, b) in agg)
    hedge_blend = sum(WEIGHTS[b] * agg[(cfg, b)]["mean_hedge_net_pl"] for b in BANDS if (cfg, b) in agg)
    triggers_blend = sum(WEIGHTS[b] * agg[(cfg, b)]["mean_triggers_pl"] for b in BANDS if (cfg, b) in agg)
    cd_blend = sum(WEIGHTS[b] * agg[(cfg, b)]["cd_active_pct_hours"] for b in BANDS if (cfg, b) in agg)
    foxify_cost_blend = premium_blend - payouts_blend
    blended[cfg] = {
        "pnl_pl_blended": pnl_blend,
        "premium_pl_blended": premium_blend,
        "payouts_pl_blended": payouts_blend,
        "hedge_net_pl_blended": hedge_blend,
        "triggers_pl_blended": triggers_blend,
        "cd_active_pct_blended": cd_blend,
        "atticus_margin_blended_pct": (pnl_blend / premium_blend * 100) if premium_blend > 0 else 0,
        "foxify_cost_pl_blended": foxify_cost_blend,
        "atticus_annual_at_1k_pairs": pnl_blend * PAIR_LIVES_PER_YEAR * 1000,
        "foxify_cost_annual_at_1k_pairs": foxify_cost_blend * PAIR_LIVES_PER_YEAR * 1000,
    }

# Pretty-print
print("\n" + "=" * 100)
print("EMPIRICAL P&L PER COOLDOWN CONFIG (premium schedule = tiered_400_600_900 per side)")
print("=" * 100)
print(f"{'config':<12} {'band':<8} {'n':>4} {'premium':>9} {'payouts':>9} "
      f"{'hedge_net':>10} {'pnl/pl':>9} {'margin%':>8} {'cd_h%':>6} {'trig':>5}")
for cfg in cfg_names:
    for band in BANDS:
        if (cfg, band) not in agg:
            continue
        a = agg[(cfg, band)]
        print(f"{cfg:<12} {band:<8} {a['n']:>4} "
              f"{a['mean_premium_pl']:>9.0f} {a['mean_payouts_pl']:>9.0f} "
              f"{a['mean_hedge_net_pl']:>10.0f} {a['mean_pnl_pl']:>9.0f} "
              f"{a['atticus_margin_pct']:>7.2f}% "
              f"{a['cd_active_pct_hours']:>5.2f}% {a['mean_triggers_pl']:>5.1f}")

print("\n" + "=" * 100)
print("BLENDED ACROSS REGIMES (35.4 / 42.8 / 14.4 / 5.8 weights)")
print("=" * 100)
print(f"{'config':<12} {'pnl/pl':>9} {'premium':>9} {'foxify_cost':>12} {'margin%':>8} "
      f"{'cd_h%':>6} {'Atticus_$/yr_1k':>17} {'Foxify_$/yr_1k':>16}")
for cfg in cfg_names:
    b = blended[cfg]
    print(f"{cfg:<12} {b['pnl_pl_blended']:>9.0f} {b['premium_pl_blended']:>9.0f} "
          f"{b['foxify_cost_pl_blended']:>12.0f} "
          f"{b['atticus_margin_blended_pct']:>7.2f}% "
          f"{b['cd_active_pct_blended']:>5.2f}% "
          f"{b['atticus_annual_at_1k_pairs']:>17,.0f} "
          f"{b['foxify_cost_annual_at_1k_pairs']:>16,.0f}")

# Write CSV
out_rows = []
for cfg in cfg_names:
    out_rows.append({"cfg": cfg, **{k: round(v, 2) for k, v in blended[cfg].items()}})
with OUT_PATH.open("w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(out_rows[0].keys()))
    w.writeheader()
    for r in out_rows:
        w.writerow(r)
print(f"\nWrote blended summary -> {OUT_PATH}")
