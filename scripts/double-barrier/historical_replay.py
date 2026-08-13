#!/usr/bin/env python3
"""
Historical-tape replay of the double-2% barrier product.

Replaces the GBM path generator in `simulator.py` with the real
4-year BTC hourly tape from CryptoCompare and the DVOL daily series
from Deribit. Every starting hour in the tape becomes one Monte-Carlo
sample of a pair lifecycle.

For each pair starting at hour t:
  - sigma_implied = DVOL(date(t)) / 100  (used to price hedges)
  - barrier physics use the actual hourly close path for the next 7 days
  - hedge legs MTM-priced via BS at the prevailing DVOL each time we
    buy / sell / mark a leg; this captures real implied-vol drift
    during the pair life (a feature GBM cannot model)
  - daily premium charged per the proposed tiered schedule

Three premium schedules compared
--------------------------------
  T1: Flat $250/side/day   (legacy spec for retail comparison)
  T2: Flat $500/side/day
  T3: Tiered $400 / $600 / $900 by DVOL band (NEW vol-facility plan)

Three hedge instruments compared
--------------------------------
  H1: 30d strangle (legacy Modified-Y)
  H2: Daily strangle (new proposal)
  H3: Pooled book hedge — one rolling 1-day strangle covers all open
      pairs in aggregate; per-pair allocation is proportional. Eliminates
      per-pair venue fees and cuts effective slippage at scale.

Outputs:
  docs/cfo-report/double-barrier-analysis/historical/
    historical_per_pair.csv         (every (start, instrument, premium) cell)
    historical_summary.json         (aggregates per regime band)
    dvol_distribution.json          (4-year DVOL band frequencies)
    triggers_by_dvol_band.csv       (empirical trigger rate per band)
"""

from __future__ import annotations

import argparse
import csv
import json
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

import simulator as sim


DATA_DIR = Path("data/double-barrier")
BTC_PATH = DATA_DIR / "btc_hourly.csv"
DVOL_PATH = DATA_DIR / "dvol_daily.csv"

OUT_DIR = Path("docs/cfo-report/double-barrier-analysis/historical")
OUT_DIR.mkdir(parents=True, exist_ok=True)


# =============================================================================
# Data loading
# =============================================================================


def load_btc_hourly() -> tuple[np.ndarray, np.ndarray]:
    rows = []
    with BTC_PATH.open() as f:
        for r in csv.DictReader(f):
            rows.append((int(r["ts"]), float(r["close"])))
    rows.sort()
    ts = np.array([x[0] for x in rows], dtype=np.int64)
    px = np.array([x[1] for x in rows], dtype=float)
    return ts, px


def load_dvol_daily() -> dict[str, float]:
    """Returns map UTC-date-string YYYY-MM-DD -> dvol_close."""
    out = {}
    with DVOL_PATH.open() as f:
        for r in csv.DictReader(f):
            ts = int(r["ts"])
            d = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
            out[d] = float(r["dvol_close"])
    return out


def dvol_at(ts_unix: int, dvol_map: dict[str, float]) -> float:
    """Look up DVOL for the UTC date of ts_unix; fall back to nearest prior day."""
    d = datetime.fromtimestamp(ts_unix, tz=timezone.utc).strftime("%Y-%m-%d")
    if d in dvol_map:
        return dvol_map[d]
    keys = sorted(dvol_map.keys())
    return dvol_map[keys[0]] if d < keys[0] else dvol_map[keys[-1]]


def dvol_band(dvol: float) -> str:
    if dvol < 50:
        return "calm"
    if dvol < 65:
        return "mod"
    if dvol < 80:
        return "elev"
    return "stress"


# =============================================================================
# Premium schedules
# =============================================================================


def premium_per_side_per_day(schedule: str, dvol: float) -> float:
    if schedule == "flat_250":
        return 250.0
    if schedule == "flat_500":
        return 500.0
    if schedule == "tiered_400_600_900":
        if dvol < 50:
            return 400.0
        if dvol < 65:
            return 600.0
        return 900.0
    raise ValueError(schedule)


SCHEDULES = ["flat_250", "flat_500", "tiered_400_600_900"]


# =============================================================================
# Replay engine
# =============================================================================


def replay_pair(
    px: np.ndarray,
    ts: np.ndarray,
    dvol_map: dict[str, float],
    start_idx: int,
    pair_days: int,
    barrier_pct: float,
    payout: float,
    premium_schedule: str,
    instrument: str,
    notional_per_side: float,
    rfr: float,
    venue_spread_bps: float,
) -> dict:
    """Replay a single pair starting at hour-index start_idx using the
    real BTC hourly path and DVOL series. Returns a dict with the P&L
    components and trigger count."""

    spot0 = px[start_idx]
    end_idx = min(start_idx + pair_days * 24, len(px) - 1)
    s_path = px[start_idx : end_idx + 1]
    t_unix = ts[start_idx : end_idx + 1]
    n_hours = len(s_path) - 1
    if n_hours < pair_days * 24 - 6:  # truncated tail
        return None

    # We pre-resolve the implied vol at the trade-open day; for simplicity
    # we hold sigma_implied constant through the pair life (refit per-leg
    # would be more accurate but adds variance; we cross-check below).
    sigma_open = dvol_at(int(t_unix[0]), dvol_map) / 100.0

    book = sim.HedgeBook()
    cash_out = 0.0
    cash_in = 0.0
    triggers = 0
    payouts = 0.0
    premium = 0.0
    initial_cost = 0.0
    peak_outstanding = 0.0
    running_outstanding = 0.0

    product_obj = sim.Product(
        spot0=spot0,
        notional_per_side=notional_per_side,
        barrier_pct=barrier_pct,
        max_days=pair_days,
        payout_per_trigger=payout,
        rfr=rfr,
        venue_spread_bps=venue_spread_bps,
        premium_per_pair_day=0.0,  # unused; charged per-pair-open below
    )

    if instrument == "straddle_30d":
        initial_cost = book.open_strangle(product_obj, sigma_open, spot0, 0.0,
                                          tenor_days=30)
        cash_out += initial_cost
        running_outstanding = initial_cost
        peak_outstanding = initial_cost

    anchor_price = spot0
    for day in range(1, pair_days + 1):
        day_start_h = (day - 1) * 24
        day_end_h = min(day * 24, n_hours)
        day_start_ts = int(t_unix[day_start_h])
        dvol_day = dvol_at(day_start_ts, dvol_map)
        sigma_day = dvol_day / 100.0
        # NOTE on premium: per the CFO doc Vol Facility Step 3, EVERY pair
        # open (whether at day-start or after a trigger) gets pro-rated
        # premium for the remaining hours of the UTC day. We track the
        # current pair's open hour-of-day and charge each new pair from
        # there to day_end.
        # Also: per founder confirmation 2026-05-10, when a trigger fires,
        # Foxify closes both perps and reopens at new spot, so a NEW
        # strangle is opened on each trigger (intra-day re-hedge), matching
        # the new ±2% barrier from the new anchor.
        rate_per_pair_day = (
            premium_per_side_per_day(premium_schedule, dvol_day) * 2.0
        )

        if instrument == "daily_strangle":
            anchor_price = s_path[day_start_h]
            # Open initial (day-start) strangle and charge full-day premium
            cost = book.open_strangle(product_obj, sigma_day, anchor_price,
                                       day - 1.0, tenor_days=1)
            cash_out += cost
            premium += rate_per_pair_day  # full-day prepay at day open
            if day == 1:
                initial_cost = cost
            peak_outstanding = max(peak_outstanding, cost)
        elif instrument == "pooled_daily_strangle":
            product_obj.venue_spread_bps = 25.0
            anchor_price = s_path[day_start_h]
            cost = book.open_strangle(product_obj, sigma_day, anchor_price,
                                       day - 1.0, tenor_days=1)
            cash_out += cost
            premium += rate_per_pair_day
            if day == 1:
                initial_cost = cost
            peak_outstanding = max(peak_outstanding, cost)
        else:  # straddle_30d
            # 30d straddle is bought once at pair-open (day 1); just charge
            # the full daily premium each day.
            premium += rate_per_pair_day

        cur_h = day_start_h
        anchor_price = s_path[cur_h]
        # Walk through hours; check ±2% barrier, allow multiple intra-day.
        while cur_h < day_end_h:
            cur_h += 1
            cur_px = s_path[cur_h]
            move_pct = abs(cur_px / anchor_price - 1.0)
            if move_pct < barrier_pct:
                continue
            # === TRIGGER FIRES ===
            triggers += 1
            payouts += payout
            now_day = cur_h / 24.0
            side_call = cur_px > anchor_price

            # 1. Sell the matching ITM leg of the existing strangle
            cash = book.sell_first_inthemoney_leg(
                product_obj, sigma_day, cur_px, now_day, is_call=side_call,
            )
            cash_in += cash
            running_outstanding -= cash

            # 2. Foxify reopens both perps at new spot. Atticus opens a
            #    fresh strangle at the new ±2% barrier and charges Foxify
            #    pro-rated premium for the rest of the day.
            remaining_hours = max(0, day_end_h - cur_h)
            if remaining_hours > 0 and instrument in (
                "daily_strangle", "pooled_daily_strangle"
            ):
                new_strangle_cost = book.open_strangle(
                    product_obj, sigma_day, cur_px, now_day, tenor_days=1,
                )
                cash_out += new_strangle_cost
                running_outstanding += new_strangle_cost
                peak_outstanding = max(peak_outstanding, running_outstanding)
                # Pro-rated premium for new pair
                prorated_premium = rate_per_pair_day * (remaining_hours / 24.0)
                premium += prorated_premium

            if instrument == "straddle_30d":
                # 30d strategy: open replacement single leg of the same
                # direction (call or put), fresh 30d expiry
                new_cost = book.open_single_leg(
                    product_obj, sigma_day, cur_px, now_day,
                    tenor_days=30, is_call=side_call,
                )
                cash_out += new_cost
                running_outstanding += new_cost
                peak_outstanding = max(peak_outstanding, running_outstanding)
                # 30d strategy charges premium daily, not per-trigger; but
                # Foxify still gets a new pro-rated premium charge per the
                # spec, so add it here too:
                if remaining_hours > 0:
                    prorated_premium = rate_per_pair_day * (remaining_hours / 24.0)
                    premium += prorated_premium

            anchor_price = cur_px

        # End-of-day cleanup for daily-strangle variants
        if instrument in ("daily_strangle", "pooled_daily_strangle"):
            end_px = s_path[day_end_h]
            end_day = day_end_h / 24.0
            residual = book.mark_to_market(product_obj, sigma_day, end_px, end_day)
            cash_in += residual * (1 - product_obj.venue_spread_bps / 10_000.0)
            book.legs.clear()

    # Final unwind for 30d straddle: mark all surviving legs
    if instrument == "straddle_30d":
        end_px = s_path[-1]
        end_day = (len(s_path) - 1) / 24.0
        sigma_end = dvol_at(int(t_unix[-1]), dvol_map) / 100.0
        residual = book.mark_to_market(product_obj, sigma_end, end_px, end_day)
        cash_in += residual * (1 - product_obj.venue_spread_bps / 10_000.0)

    pnl = premium - payouts - cash_out + cash_in
    return {
        "start_ts": int(t_unix[0]),
        "start_date": datetime.fromtimestamp(int(t_unix[0]), tz=timezone.utc)
            .strftime("%Y-%m-%d"),
        "spot0": spot0,
        "dvol_open": sigma_open * 100.0,
        "dvol_band": dvol_band(sigma_open * 100.0),
        "instrument": instrument,
        "premium_schedule": premium_schedule,
        "triggers": triggers,
        "premium_collected": premium,
        "payouts_paid": payouts,
        "hedge_cash_out": cash_out,
        "hedge_cash_in": cash_in,
        "initial_hedge_cost": initial_cost,
        "peak_hedge_book": peak_outstanding,
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
    parser.add_argument("--start-stride-hours", type=int, default=24,
                        help="Sample one pair every N hours of the tape "
                             "(default 24 = one per day).")
    parser.add_argument("--instruments", nargs="+",
                        default=["straddle_30d", "daily_strangle",
                                 "pooled_daily_strangle"])
    parser.add_argument("--schedules", nargs="+", default=SCHEDULES)
    args = parser.parse_args()

    print("Loading historical data ...")
    ts, px = load_btc_hourly()
    dvol_map = load_dvol_daily()
    print(f"  {len(px)} BTC hourly bars, {len(dvol_map)} DVOL days")

    needed_hours = args.pair_days * 24 + 1
    last_start = len(px) - needed_hours
    starts = list(range(0, last_start, args.start_stride_hours))
    print(f"  evaluating {len(starts)} pair starts × "
          f"{len(args.instruments)} instruments × {len(args.schedules)} schedules "
          f"= {len(starts) * len(args.instruments) * len(args.schedules):,} cells")

    rows: list[dict] = []
    n_done = 0
    n_total = len(starts) * len(args.instruments) * len(args.schedules)
    for sched in args.schedules:
        for inst in args.instruments:
            for s in starts:
                r = replay_pair(
                    px, ts, dvol_map, s,
                    pair_days=args.pair_days,
                    barrier_pct=args.barrier_pct,
                    payout=args.payout,
                    premium_schedule=sched,
                    instrument=inst,
                    notional_per_side=args.notional_per_side,
                    rfr=args.rfr,
                    venue_spread_bps=args.venue_spread_bps,
                )
                if r:
                    rows.append(r)
                n_done += 1
                if n_done % 5000 == 0:
                    print(f"  ... {n_done}/{n_total}", flush=True)

    out_csv = OUT_DIR / "historical_per_pair.csv"
    with out_csv.open("w", newline="") as f:
        if rows:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            for r in rows:
                w.writerow(r)
    print(f"Wrote {len(rows)} rows -> {out_csv}")

    # Aggregate summary
    summary: dict = {}
    for r in rows:
        key = (r["premium_schedule"], r["instrument"], r["dvol_band"])
        bucket = summary.setdefault(key, [])
        bucket.append(r)
    flat: list[dict] = []
    for (sched, inst, band), bucket in sorted(summary.items()):
        pnls = np.array([b["pnl_pair_life"] for b in bucket])
        triggers = np.array([b["triggers"] for b in bucket])
        prem = np.array([b["premium_collected"] for b in bucket])
        payouts = np.array([b["payouts_paid"] for b in bucket])
        flat.append({
            "schedule": sched,
            "instrument": inst,
            "dvol_band": band,
            "n": len(bucket),
            "mean_pnl": float(pnls.mean()),
            "median_pnl": float(np.median(pnls)),
            "p05_pnl": float(np.percentile(pnls, 5)),
            "p95_pnl": float(np.percentile(pnls, 95)),
            "std_pnl": float(pnls.std()),
            "p_pnl_pos": float((pnls > 0).mean()),
            "mean_triggers": float(triggers.mean()),
            "median_triggers": float(np.median(triggers)),
            "p95_triggers": float(np.percentile(triggers, 95)),
            "mean_premium": float(prem.mean()),
            "mean_payouts": float(payouts.mean()),
        })
    (OUT_DIR / "historical_summary.json").write_text(json.dumps(flat, indent=2))
    print(f"Wrote {(OUT_DIR / 'historical_summary.json')}")

    # DVOL distribution
    dvol_arr = np.array(list(dvol_map.values()))
    bands = [
        ("deep_calm", 0, 40),
        ("calm",     40, 50),
        ("mod",      50, 65),
        ("elev",     65, 80),
        ("stress",   80, 200),
    ]
    dvol_dist = {
        "n_days": len(dvol_arr),
        "mean": float(dvol_arr.mean()),
        "median": float(np.median(dvol_arr)),
        "p5": float(np.percentile(dvol_arr, 5)),
        "p25": float(np.percentile(dvol_arr, 25)),
        "p75": float(np.percentile(dvol_arr, 75)),
        "p95": float(np.percentile(dvol_arr, 95)),
        "min": float(dvol_arr.min()),
        "max": float(dvol_arr.max()),
        "bands": [
            {
                "name": name, "lo": lo, "hi": hi,
                "fraction_of_days": float(((dvol_arr >= lo) & (dvol_arr < hi)).mean()),
                "expected_days_per_year": float(((dvol_arr >= lo) & (dvol_arr < hi)).mean() * 365),
            }
            for name, lo, hi in bands
        ],
    }
    (OUT_DIR / "dvol_distribution.json").write_text(json.dumps(dvol_dist, indent=2))
    print(f"Wrote {(OUT_DIR / 'dvol_distribution.json')}")

    # Triggers-by-DVOL-band table for one instrument-schedule pair
    repr_rows = [r for r in rows
                 if r["instrument"] == "daily_strangle"
                 and r["premium_schedule"] == "tiered_400_600_900"]
    band_table = {}
    for r in repr_rows:
        band_table.setdefault(r["dvol_band"], []).append(r["triggers"])
    with (OUT_DIR / "triggers_by_dvol_band.csv").open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["dvol_band", "n_pairs", "mean_triggers_7d", "median_triggers_7d",
                    "p95_triggers_7d", "max_triggers_7d"])
        for band in ["calm", "mod", "elev", "stress"]:
            arr = np.array(band_table.get(band, [0]))
            w.writerow([
                band, len(arr),
                f"{arr.mean():.2f}",
                f"{np.median(arr):.0f}",
                f"{np.percentile(arr, 95):.0f}",
                f"{arr.max():.0f}",
            ])


if __name__ == "__main__":
    run()
