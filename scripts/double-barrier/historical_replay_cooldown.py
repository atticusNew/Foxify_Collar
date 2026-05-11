#!/usr/bin/env python3
"""
Historical-tape replay of the double-2% barrier product, WITH per-pair
cooldown circuit-breaker plumbed into the trigger loop.

Companion to `historical_replay.py`. Goal: produce empirical
quantification of how much cooldown actually clips triggers / payouts /
hedge churn per DVOL regime under different cooldown threshold
configurations, so the pricing math's design-target clip
(20/30/50% in mod/elev/stress) can be calibrated against reality.

Per-pair cooldown proxies (must be tractable in single-pair sim):

  T2_proxy: trigger density. If THIS pair has fired N triggers in the
            last cooldown_lookback_hours, freeze its anchor for
            cooldown_duration_hours.

  T4_proxy: DVOL spike. If today's DVOL > dvol_high_threshold AND
            today's DVOL / yesterday's DVOL > dvol_jump_ratio, freeze
            anchor for cooldown_duration_hours.

T1 (payout-velocity vs operating capital) and T3 (hedge-book MTM drift)
are aggregate-book metrics not directly modelled in single-pair sim;
T2 and T4 capture the dominant practical firing modes per the spec.

While anchor is frozen:
  - Existing strangle continues to be MTM'd; no new strangles opened
    on grazes during freeze.
  - Triggers can still fire if BTC gaps through ±2% from the (frozen)
    anchor — but the anchor doesn't reset to new spot, so subsequent
    same-direction grazes do NOT count as new triggers.
  - Premium continues to accrue at the daily rate (no pro-rated
    re-open premium during freeze, because no new pair opens happen).

Outputs:
  docs/cfo-report/double-barrier-analysis/historical/
    cooldown_per_pair.csv             (every (start, sched, cd_config) cell)
    cooldown_summary.json             (per-band trigger / payout clip)
    cooldown_threshold_sweep.csv      (clip % for each cd-config × band)
"""

from __future__ import annotations

import argparse
import csv
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

import simulator as sim
from historical_replay import (
    BTC_PATH, DVOL_PATH, OUT_DIR,
    load_btc_hourly, load_dvol_daily, dvol_at, dvol_band,
    premium_per_side_per_day, SCHEDULES,
)


# =============================================================================
# Cooldown configurations to sweep
# =============================================================================


@dataclass
class CooldownConfig:
    name: str
    enabled: bool
    # T2: per-pair trigger density
    t2_lookback_hours: int = 4
    t2_trigger_threshold: int = 4
    # T4: DVOL spike
    t4_dvol_high: float = 100.0
    t4_dvol_jump_ratio: float = 1.5
    # Cooldown duration after trigger
    duration_hours: int = 4


COOLDOWN_CONFIGS: list[CooldownConfig] = [
    CooldownConfig(name="cd_off", enabled=False),
    # Spec-as-written: T2 fires at 4 triggers in 4h; T4 at DVOL>100 + 50% jump
    CooldownConfig(name="cd_spec",  enabled=True,
                   t2_trigger_threshold=4, t2_lookback_hours=4,
                   t4_dvol_high=100.0, t4_dvol_jump_ratio=1.5,
                   duration_hours=4),
    # Tightened-1: T2 fires at 3 triggers in 4h
    CooldownConfig(name="cd_tight1", enabled=True,
                   t2_trigger_threshold=3, t2_lookback_hours=4,
                   t4_dvol_high=90.0, t4_dvol_jump_ratio=1.4,
                   duration_hours=4),
    # Tightened-2: T2 fires at 2 triggers in 4h, longer 6h window
    CooldownConfig(name="cd_tight2", enabled=True,
                   t2_trigger_threshold=2, t2_lookback_hours=4,
                   t4_dvol_high=85.0, t4_dvol_jump_ratio=1.3,
                   duration_hours=6),
    # Aggressive: T2 fires at 2 triggers in 4h, 8h window
    CooldownConfig(name="cd_aggr",   enabled=True,
                   t2_trigger_threshold=2, t2_lookback_hours=4,
                   t4_dvol_high=80.0, t4_dvol_jump_ratio=1.25,
                   duration_hours=8),
]


# =============================================================================
# Replay engine WITH cooldown
# =============================================================================


def replay_pair_with_cooldown(
    px: np.ndarray,
    ts: np.ndarray,
    dvol_map: dict[str, float],
    start_idx: int,
    pair_days: int,
    barrier_pct: float,
    payout: float,
    premium_schedule: str,
    notional_per_side: float,
    rfr: float,
    venue_spread_bps: float,
    cd: CooldownConfig,
) -> dict:
    """Daily-strangle hedge instrument with per-pair cooldown plumbed in.
    Returns dict with PnL components, trigger count, and cooldown stats.
    """
    spot0 = px[start_idx]
    end_idx = min(start_idx + pair_days * 24, len(px) - 1)
    s_path = px[start_idx : end_idx + 1]
    t_unix = ts[start_idx : end_idx + 1]
    n_hours = len(s_path) - 1
    if n_hours < pair_days * 24 - 6:
        return None

    sigma_open = dvol_at(int(t_unix[0]), dvol_map) / 100.0
    book = sim.HedgeBook()
    cash_out = 0.0
    cash_in = 0.0
    triggers = 0
    triggers_during_cd = 0
    payouts = 0.0
    premium = 0.0
    initial_cost = 0.0
    peak_outstanding = 0.0
    running_outstanding = 0.0

    # Cooldown bookkeeping
    cd_active_until_h = -1   # hour index until which cooldown is active
    trigger_hours: list[int] = []  # hours at which triggers fired (rolling for T2)
    cd_fires = 0
    cd_hours_active = 0
    # During cooldown: track which side has been triggered. Same-side
    # grazes don't re-trigger until price returns inside the ±0.5% buffer
    # around the (frozen) anchor, OR until cooldown clears.
    cd_side_fired_up = False
    cd_side_fired_down = False
    inner_buffer = barrier_pct * 0.25   # 0.5% if barrier is 2%

    product_obj = sim.Product(
        spot0=spot0,
        notional_per_side=notional_per_side,
        barrier_pct=barrier_pct,
        max_days=pair_days,
        payout_per_trigger=payout,
        rfr=rfr,
        venue_spread_bps=venue_spread_bps,
        premium_per_pair_day=0.0,
    )

    anchor_price = spot0
    prev_dvol = None
    for day in range(1, pair_days + 1):
        day_start_h = (day - 1) * 24
        day_end_h = min(day * 24, n_hours)
        day_start_ts = int(t_unix[day_start_h])
        dvol_day = dvol_at(day_start_ts, dvol_map)
        sigma_day = dvol_day / 100.0
        rate_per_pair_day = premium_per_side_per_day(premium_schedule, dvol_day) * 2.0

        # T4: DVOL spike check at day open
        if cd.enabled and prev_dvol is not None:
            if dvol_day > cd.t4_dvol_high and dvol_day / max(prev_dvol, 1e-6) > cd.t4_dvol_jump_ratio:
                if day_start_h > cd_active_until_h:
                    cd_fires += 1
                cd_active_until_h = max(cd_active_until_h, day_start_h + cd.duration_hours)
        prev_dvol = dvol_day

        # Open day-start strangle (hedge book stays in sync regardless of cd)
        anchor_price = s_path[day_start_h]
        cost = book.open_strangle(product_obj, sigma_day, anchor_price,
                                   day - 1.0, tenor_days=1)
        cash_out += cost
        premium += rate_per_pair_day
        if day == 1:
            initial_cost = cost
        peak_outstanding = max(peak_outstanding, cost)

        cur_h = day_start_h
        while cur_h < day_end_h:
            cur_h += 1
            cur_px = s_path[cur_h]
            in_cd = cur_h <= cd_active_until_h
            if in_cd:
                cd_hours_active += 1
            else:
                # cooldown cleared → reset side-fired flags
                cd_side_fired_up = False
                cd_side_fired_down = False

            move_signed = cur_px / anchor_price - 1.0
            move_pct = abs(move_signed)

            # During cooldown: re-arm a side if price returns close to anchor
            if in_cd:
                if abs(move_signed) < inner_buffer:
                    cd_side_fired_up = False
                    cd_side_fired_down = False

            if move_pct < barrier_pct:
                continue

            # === BARRIER CROSSED ===
            side_up = move_signed > 0
            if in_cd:
                # Suppress same-side grazes during cooldown
                if side_up and cd_side_fired_up:
                    continue
                if (not side_up) and cd_side_fired_down:
                    continue

            triggers += 1
            payouts += payout
            if in_cd:
                triggers_during_cd += 1
                if side_up:
                    cd_side_fired_up = True
                else:
                    cd_side_fired_down = True

            now_day = cur_h / 24.0
            side_call = side_up

            # Sell ITM leg (always — the hedge book settles regardless)
            cash = book.sell_first_inthemoney_leg(
                product_obj, sigma_day, cur_px, now_day, is_call=side_call,
            )
            cash_in += cash
            running_outstanding -= cash

            # Anchor reset & new strangle open ONLY if NOT in cooldown
            if not in_cd:
                # T2: did this trigger push us over the threshold?
                trigger_hours.append(cur_h)
                if cd.enabled:
                    # Drop trigger_hours older than lookback window
                    cutoff = cur_h - cd.t2_lookback_hours
                    trigger_hours = [h for h in trigger_hours if h > cutoff]
                    if len(trigger_hours) >= cd.t2_trigger_threshold:
                        cd_fires += 1
                        cd_active_until_h = max(cd_active_until_h, cur_h + cd.duration_hours)
                        # Mark current side as fired so we don't immediately
                        # re-trigger same-direction inside the new cooldown
                        if side_up:
                            cd_side_fired_up = True
                        else:
                            cd_side_fired_down = True

                # Open replacement strangle at new spot (anchor resets)
                remaining_hours = max(0, day_end_h - cur_h)
                if remaining_hours > 0:
                    new_strangle_cost = book.open_strangle(
                        product_obj, sigma_day, cur_px, now_day, tenor_days=1,
                    )
                    cash_out += new_strangle_cost
                    running_outstanding += new_strangle_cost
                    peak_outstanding = max(peak_outstanding, running_outstanding)
                    prorated_premium = rate_per_pair_day * (remaining_hours / 24.0)
                    premium += prorated_premium

                anchor_price = cur_px
            else:
                # During cooldown: anchor stays frozen, no new strangle, no
                # pro-rated re-open premium. Existing strangle continues to
                # MTM. Trigger payout still owed (per spec §4 — existing
                # triggered pairs continue to pay).
                pass

        # End-of-day cleanup
        end_px = s_path[day_end_h]
        end_day = day_end_h / 24.0
        residual = book.mark_to_market(product_obj, sigma_day, end_px, end_day)
        cash_in += residual * (1 - product_obj.venue_spread_bps / 10_000.0)
        book.legs.clear()

    pnl = premium - payouts - cash_out + cash_in
    return {
        "start_ts": int(t_unix[0]),
        "start_date": datetime.fromtimestamp(int(t_unix[0]), tz=timezone.utc)
            .strftime("%Y-%m-%d"),
        "spot0": spot0,
        "dvol_open": sigma_open * 100.0,
        "dvol_band": dvol_band(sigma_open * 100.0),
        "premium_schedule": premium_schedule,
        "cd_config": cd.name,
        "triggers": triggers,
        "triggers_during_cd": triggers_during_cd,
        "premium_collected": premium,
        "payouts_paid": payouts,
        "hedge_cash_out": cash_out,
        "hedge_cash_in": cash_in,
        "initial_hedge_cost": initial_cost,
        "peak_hedge_book": peak_outstanding,
        "cd_fires": cd_fires,
        "cd_hours_active": cd_hours_active,
        "pair_hours": n_hours,
        "pnl_pair_life": pnl,
    }


# =============================================================================
# Driver
# =============================================================================


def run() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pair-days", type=int, default=7)
    parser.add_argument("--barrier-pct", type=float, default=0.02)
    parser.add_argument("--payout", type=float, default=1_000.0)
    parser.add_argument("--notional-per-side", type=float, default=50_000.0)
    parser.add_argument("--rfr", type=float, default=0.05)
    parser.add_argument("--venue-spread-bps", type=float, default=50.0)
    parser.add_argument("--start-stride-hours", type=int, default=24)
    parser.add_argument("--schedules", nargs="+",
                        default=["tiered_400_600_900"])
    args = parser.parse_args()

    print("Loading historical data ...")
    ts, px = load_btc_hourly()
    dvol_map = load_dvol_daily()
    print(f"  {len(px)} BTC hourly bars, {len(dvol_map)} DVOL days")

    needed_hours = args.pair_days * 24 + 1
    last_start = len(px) - needed_hours
    starts = list(range(0, last_start, args.start_stride_hours))
    n_total = len(starts) * len(args.schedules) * len(COOLDOWN_CONFIGS)
    print(f"  evaluating {len(starts)} pair starts × "
          f"{len(args.schedules)} schedules × {len(COOLDOWN_CONFIGS)} cd-configs "
          f"= {n_total:,} cells")

    rows: list[dict] = []
    n_done = 0
    for sched in args.schedules:
        for cd in COOLDOWN_CONFIGS:
            for s in starts:
                r = replay_pair_with_cooldown(
                    px, ts, dvol_map, s,
                    pair_days=args.pair_days,
                    barrier_pct=args.barrier_pct,
                    payout=args.payout,
                    premium_schedule=sched,
                    notional_per_side=args.notional_per_side,
                    rfr=args.rfr,
                    venue_spread_bps=args.venue_spread_bps,
                    cd=cd,
                )
                if r:
                    rows.append(r)
                n_done += 1
                if n_done % 5000 == 0:
                    print(f"  ... {n_done}/{n_total}", flush=True)

    out_csv = OUT_DIR / "cooldown_per_pair.csv"
    with out_csv.open("w", newline="") as f:
        if rows:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            for r in rows:
                w.writerow(r)
    print(f"Wrote {len(rows)} rows -> {out_csv}")

    # =========================================================================
    # Aggregate: per (cd_config, band) compute mean trigger rate, mean payouts,
    # mean hedge cost net. Compare to cd_off baseline to derive empirical clip.
    # =========================================================================

    bands = ["calm", "mod", "elev", "stress"]
    summary: dict[str, dict[str, dict]] = {}
    for cd in COOLDOWN_CONFIGS:
        summary[cd.name] = {}
        for band in bands:
            cells = [r for r in rows
                     if r["cd_config"] == cd.name and r["dvol_band"] == band]
            if not cells:
                continue
            trig = np.array([c["triggers"] for c in cells])
            trig_cd = np.array([c["triggers_during_cd"] for c in cells])
            pay = np.array([c["payouts_paid"] for c in cells])
            net_hedge = np.array([c["hedge_cash_out"] - c["hedge_cash_in"]
                                   for c in cells])
            cd_h = np.array([c["cd_hours_active"] for c in cells])
            pair_h = np.array([c["pair_hours"] for c in cells])
            summary[cd.name][band] = {
                "n_pairs": len(cells),
                "mean_triggers": float(trig.mean()),
                "mean_triggers_during_cd": float(trig_cd.mean()),
                "mean_payouts": float(pay.mean()),
                "mean_net_hedge": float(net_hedge.mean()),
                "mean_cd_hours": float(cd_h.mean()),
                "mean_pair_hours": float(pair_h.mean()),
                "cd_active_hours_pct": float(cd_h.sum() / max(pair_h.sum(), 1) * 100),
            }

    # Compute clip % vs cd_off baseline
    sweep_rows = []
    for cd in COOLDOWN_CONFIGS:
        if cd.name == "cd_off":
            continue
        for band in bands:
            base = summary["cd_off"].get(band)
            test = summary[cd.name].get(band)
            if not base or not test:
                continue
            sweep_rows.append({
                "cd_config": cd.name,
                "band": band,
                "n_pairs": test["n_pairs"],
                "cd_active_pct_of_hours": round(test["cd_active_hours_pct"], 2),
                "baseline_mean_triggers": round(base["mean_triggers"], 2),
                "cooled_mean_triggers": round(test["mean_triggers"], 2),
                "trigger_clip_pct": round(
                    (1 - test["mean_triggers"] / max(base["mean_triggers"], 1e-9)) * 100, 2),
                "baseline_mean_payouts": round(base["mean_payouts"], 0),
                "cooled_mean_payouts": round(test["mean_payouts"], 0),
                "payout_clip_pct": round(
                    (1 - test["mean_payouts"] / max(base["mean_payouts"], 1e-9)) * 100, 2),
                "baseline_mean_net_hedge": round(base["mean_net_hedge"], 0),
                "cooled_mean_net_hedge": round(test["mean_net_hedge"], 0),
                "net_hedge_clip_pct": round(
                    (1 - test["mean_net_hedge"] / max(base["mean_net_hedge"], 1e-9)) * 100, 2),
            })

    sweep_csv = OUT_DIR / "cooldown_threshold_sweep.csv"
    with sweep_csv.open("w", newline="") as f:
        if sweep_rows:
            w = csv.DictWriter(f, fieldnames=list(sweep_rows[0].keys()))
            w.writeheader()
            for r in sweep_rows:
                w.writerow(r)
    print(f"Wrote {len(sweep_rows)} threshold-sweep rows -> {sweep_csv}")

    summary_path = OUT_DIR / "cooldown_summary.json"
    with summary_path.open("w") as f:
        json.dump(summary, f, indent=2, default=float)
    print(f"Wrote summary -> {summary_path}")

    # Pretty-print to stdout for the user
    print("\n" + "=" * 80)
    print("COOLDOWN EMPIRICAL CLIP — BY CONFIG × BAND")
    print("=" * 80)
    print(f"{'config':<12} {'band':<8} {'cd_hrs%':<8} {'trig_clip%':<12} "
          f"{'payout_clip%':<14} {'hedge_clip%':<12}")
    for r in sweep_rows:
        print(f"{r['cd_config']:<12} {r['band']:<8} "
              f"{r['cd_active_pct_of_hours']:<8} "
              f"{r['trigger_clip_pct']:<12} "
              f"{r['payout_clip_pct']:<14} "
              f"{r['net_hedge_clip_pct']:<12}")


if __name__ == "__main__":
    run()
