#!/usr/bin/env python3
"""
Atticus / Foxify Double-2% Barrier Hedge Simulator
==================================================

Monte-Carlo evaluator for the Modified-Y product:

  - Trader pays a flat daily premium for capped protection on a $50k
    BTC pair. If BTC moves +/- 2% from the per-pair anchor, the platform
    pays $1,000 (capped) and re-anchors at new spot. Trader holds for
    up to T_TRADER days.
  - Atticus hedges with options bought at activation. On trigger, the
    in-the-money leg is sold back to the venue (intrinsic + remaining
    time value), and a new leg is opened at the new spot (auto-renew).
    Atticus retains every leg until its own expiry.
  - This simulator answers four operational questions:

        1. Distribution of triggers per pair-life by vol regime.
        2. Distribution of P&L per pair-life by hedge instrument
           and premium schedule.
        3. Initial capital required to support N concurrent pairs.
        4. Probability of capital exhaustion before steady-state
           settlement at scale (1, 12, 100, 250, 1000 pairs).

Hedge instruments compared
--------------------------
  A. STRADDLE_30D  — 30-day +/-2% strangle (legacy "Modified-Y").
  B. STRADDLE_7D   — 7-day +/-2% strangle (matches trader tenor).
  C. STRANGLE_DAILY — fresh 1-day +/-2% strangle each morning.
  D. PERP_DELTA    — short 1x BTC-USD perpetual delta-hedge against
                     the per-pair barrier exposure.

All BS valuations use Decimal-friendly numpy with explicit scalar
conversions; this script is for analysis only and does not call the
production pricing engine.

Usage
-----
    python3 scripts/double-barrier/simulator.py
        [--paths N] [--regime calm|mod|elev|stress|all]
        [--premium-side 250|375|500] [--out OUTDIR]

The defaults (16,000 paths per regime per instrument) take ~2-4 minutes
on a modern laptop.

Outputs (JSON + CSV) are written to
docs/cfo-report/double-barrier-analysis/.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

import numpy as np
from scipy.stats import norm


# =============================================================================
# Black-Scholes pricing
# =============================================================================


def bs_price(
    spot: float,
    strike: float,
    t_years: float,
    sigma: float,
    r: float,
    is_call: bool,
) -> float:
    """Vanilla European BS price. Robust to t_years -> 0 (returns intrinsic)."""
    if t_years <= 1e-9 or sigma <= 1e-9:
        intrinsic = max(0.0, (spot - strike) if is_call else (strike - spot))
        return intrinsic
    d1 = (math.log(spot / strike) + (r + 0.5 * sigma * sigma) * t_years) / (
        sigma * math.sqrt(t_years)
    )
    d2 = d1 - sigma * math.sqrt(t_years)
    if is_call:
        return spot * norm.cdf(d1) - strike * math.exp(-r * t_years) * norm.cdf(d2)
    return strike * math.exp(-r * t_years) * norm.cdf(-d2) - spot * norm.cdf(-d1)


def bs_price_vec(
    spot: np.ndarray,
    strike: np.ndarray,
    t_years: np.ndarray,
    sigma: float,
    r: float,
    is_call: np.ndarray,
) -> np.ndarray:
    """Vectorized BS for fast end-of-life portfolio mark-to-market."""
    spot = np.asarray(spot, dtype=float)
    strike = np.asarray(strike, dtype=float)
    t_years = np.asarray(t_years, dtype=float)
    is_call = np.asarray(is_call, dtype=bool)

    out = np.zeros_like(spot)
    live = t_years > 1e-9
    expired = ~live
    if np.any(expired):
        intrinsic_call = np.maximum(spot[expired] - strike[expired], 0.0)
        intrinsic_put = np.maximum(strike[expired] - spot[expired], 0.0)
        out[expired] = np.where(is_call[expired], intrinsic_call, intrinsic_put)

    if not np.any(live):
        return out
    s = spot[live]
    k = strike[live]
    t = t_years[live]
    sqrt_t = np.sqrt(t)
    d1 = (np.log(s / k) + (r + 0.5 * sigma * sigma) * t) / (sigma * sqrt_t)
    d2 = d1 - sigma * sqrt_t
    call_v = s * norm.cdf(d1) - k * np.exp(-r * t) * norm.cdf(d2)
    put_v = k * np.exp(-r * t) * norm.cdf(-d2) - s * norm.cdf(-d1)
    out[live] = np.where(is_call[live], call_v, put_v)
    return out


# =============================================================================
# Configuration
# =============================================================================


REGIMES = {
    "calm":   {"dvol": 45, "sigma": 0.45},
    "mod":    {"dvol": 55, "sigma": 0.55},
    "elev":   {"dvol": 65, "sigma": 0.65},
    "stress": {"dvol": 80, "sigma": 0.80},
}

# Vol-risk-premium adjustment.  Most listed-vol markets have a positive
# implied-realized vol gap (DVOL > realized BTC vol on average); empirical
# BTC studies place this gap somewhere in the 0%-25% range with wide
# variance.  When VRP > 0, long-vol strategies bleed; barrier triggers
# fire less often than DVOL-implied; the platform's E[payouts] falls.
# We expose this as a knob so the CFO can stress-test both directions.


@dataclass
class Product:
    spot0: float = 75_000.0           # BTC reference spot
    notional_per_side: float = 50_000.0  # USD notional per side
    barrier_pct: float = 0.02         # +/-2% trigger
    max_days: int = 7                 # trader tenor cap
    premium_per_pair_day: float = 500.0  # $250/side x 2 (user proposal)
    payout_per_trigger: float = 1_000.0  # capped payout
    rfr: float = 0.05                 # 5% risk-free
    venue_spread_bps: float = 50.0    # round-trip option execution slippage
    venue_perp_funding_bps_day: float = 1.0  # daily perp funding cost
    auto_renew: bool = True

    def btc_qty_per_side(self) -> float:
        return self.notional_per_side / self.spot0


# =============================================================================
# Hedge book — accumulating leg ledger per pair
# =============================================================================


@dataclass
class OptionLeg:
    is_call: bool
    strike: float
    expiry_day: float       # in trading-days from t=0 of pair-life
    qty_btc: float
    cost_basis: float       # USD paid at open (after spread)


@dataclass
class HedgeBook:
    legs: list[OptionLeg] = field(default_factory=list)

    def open_strangle(
        self,
        product: Product,
        sigma: float,
        spot: float,
        now_day: float,
        tenor_days: int,
    ) -> float:
        """Buy a +/-2% OTM put + call at `spot`. Returns total cost USD."""
        qty = product.notional_per_side / spot  # BTC qty per leg matches one side
        t_years = tenor_days / 365.0
        k_put = spot * (1 - product.barrier_pct)
        k_call = spot * (1 + product.barrier_pct)
        put_px = bs_price(spot, k_put, t_years, sigma, product.rfr, False)
        call_px = bs_price(spot, k_call, t_years, sigma, product.rfr, True)
        slip = (1 + product.venue_spread_bps / 10_000.0)
        put_cost = put_px * qty * slip
        call_cost = call_px * qty * slip
        self.legs.append(
            OptionLeg(False, k_put, now_day + tenor_days, qty, put_cost)
        )
        self.legs.append(
            OptionLeg(True, k_call, now_day + tenor_days, qty, call_cost)
        )
        return put_cost + call_cost

    def open_single_leg(
        self,
        product: Product,
        sigma: float,
        spot: float,
        now_day: float,
        tenor_days: int,
        is_call: bool,
    ) -> float:
        qty = product.notional_per_side / spot
        t_years = tenor_days / 365.0
        k = spot * (1 + product.barrier_pct) if is_call else spot * (1 - product.barrier_pct)
        px = bs_price(spot, k, t_years, sigma, product.rfr, is_call)
        slip = (1 + product.venue_spread_bps / 10_000.0)
        cost = px * qty * slip
        self.legs.append(OptionLeg(is_call, k, now_day + tenor_days, qty, cost))
        return cost

    def sell_first_inthemoney_leg(
        self,
        product: Product,
        sigma: float,
        spot: float,
        now_day: float,
        is_call: bool,
    ) -> float:
        """Sell the cheapest-to-deliver in-the-money leg of the requested type.
        Returns cash received (after spread)."""
        slip = (1 - product.venue_spread_bps / 10_000.0)
        candidate_idx = -1
        candidate_value = -1.0
        for i, leg in enumerate(self.legs):
            if leg.is_call != is_call:
                continue
            t = max(0.0, leg.expiry_day - now_day) / 365.0
            v = bs_price(spot, leg.strike, t, sigma, product.rfr, is_call) * leg.qty_btc
            if v > candidate_value:
                candidate_value = v
                candidate_idx = i
        if candidate_idx < 0:
            return 0.0
        leg = self.legs.pop(candidate_idx)
        return candidate_value * slip

    def mark_to_market(
        self,
        product: Product,
        sigma: float,
        spot: float,
        now_day: float,
    ) -> float:
        if not self.legs:
            return 0.0
        spots = np.full(len(self.legs), spot)
        strikes = np.array([l.strike for l in self.legs])
        ts = np.array([max(0.0, l.expiry_day - now_day) / 365.0 for l in self.legs])
        is_call = np.array([l.is_call for l in self.legs])
        qtys = np.array([l.qty_btc for l in self.legs])
        v = bs_price_vec(spots, strikes, ts, sigma, product.rfr, is_call)
        return float(np.sum(v * qtys))

    def expire_legs(self, now_day: float) -> None:
        self.legs = [l for l in self.legs if l.expiry_day > now_day]


# =============================================================================
# Path simulation
# =============================================================================


def simulate_btc_paths(
    product: Product,
    sigma: float,
    n_paths: int,
    horizon_days: int,
    steps_per_day: int,
    rng: np.random.Generator,
) -> tuple[np.ndarray, np.ndarray]:
    """GBM under risk-neutral measure (drift=r). Returns (prices, t_days)
    of shape (n_paths, n_steps+1). For trigger detection we use intra-day
    discrete sampling; this slightly underestimates barrier-hit probability
    versus continuous Brownian-bridge correction, which we apply below.
    """
    n_steps = horizon_days * steps_per_day
    dt = 1.0 / 365.0 / steps_per_day
    drift = (product.rfr - 0.5 * sigma * sigma) * dt
    diffusion = sigma * math.sqrt(dt)
    z = rng.standard_normal((n_paths, n_steps))
    log_returns = drift + diffusion * z
    log_prices = np.cumsum(log_returns, axis=1)
    prices = np.empty((n_paths, n_steps + 1))
    prices[:, 0] = product.spot0
    prices[:, 1:] = product.spot0 * np.exp(log_prices)
    t_days = np.arange(n_steps + 1) / steps_per_day
    return prices, t_days


def first_barrier_hit_with_bridge(
    s_path: np.ndarray,
    t_days: np.ndarray,
    anchor_idx: int,
    anchor_price: float,
    barrier_pct: float,
    sigma: float,
    rng: np.random.Generator,
) -> tuple[int, int]:
    """Return (hit_idx, side) where side = +1 (up barrier) / -1 (down barrier)
    / 0 (no hit before end of slice). hit_idx is the index in t_days where
    we treat the hit as fired. Uses Brownian-bridge correction for
    intra-step continuous-monitoring barriers.
    """
    upper = anchor_price * (1 + barrier_pct)
    lower = anchor_price * (1 - barrier_pct)
    # Discrete check first
    s_slice = s_path[anchor_idx + 1 :]
    t_slice = t_days[anchor_idx + 1 :]
    s_prev = s_path[anchor_idx]
    t_prev = t_days[anchor_idx]
    for i in range(len(s_slice)):
        s_curr = s_slice[i]
        t_curr = t_slice[i]
        # Bridge probabilities for upper/lower barrier between (t_prev, t_curr)
        dt_step = (t_curr - t_prev) / 365.0
        if dt_step <= 0:
            s_prev = s_curr
            t_prev = t_curr
            continue
        var_step = sigma * sigma * dt_step
        # Probability path crossed upper barrier in (t_prev, t_curr)
        if s_curr < upper and s_prev < upper:
            p_up = math.exp(
                -2.0 * math.log(upper / s_prev) * math.log(upper / s_curr) / var_step
            )
        else:
            p_up = 1.0 if (s_curr >= upper or s_prev >= upper) else 0.0
        if s_curr > lower and s_prev > lower:
            p_dn = math.exp(
                -2.0 * math.log(s_prev / lower) * math.log(s_curr / lower) / var_step
            )
        else:
            p_dn = 1.0 if (s_curr <= lower or s_prev <= lower) else 0.0

        u = rng.random()
        # Treat upper and lower as competing events; use total hit prob
        p_hit = 1.0 - (1.0 - p_up) * (1.0 - p_dn)
        if u < p_hit:
            # Choose side proportional to its individual probability
            if rng.random() * (p_up + p_dn) < p_up:
                return anchor_idx + 1 + i, +1
            return anchor_idx + 1 + i, -1
        s_prev = s_curr
        t_prev = t_curr
    return -1, 0


# =============================================================================
# Lifecycle of a single pair under each hedge strategy
# =============================================================================


@dataclass
class PairResult:
    triggers: int
    premium_collected: float
    payouts_paid: float
    hedge_cash_out: float
    hedge_cash_in: float
    residual_hedge_value: float   # mark-to-market of legs alive after pair ends
    initial_hedge_cost: float     # the upfront option cost
    pnl: float                    # premium - payouts - hedge_out + hedge_in + residual
    max_hedge_book_cost_outstanding: float  # peak unrecovered hedge spend over life

    @staticmethod
    def header() -> list[str]:
        return [
            "triggers", "premium_collected", "payouts_paid",
            "hedge_cash_out", "hedge_cash_in", "residual_hedge_value",
            "initial_hedge_cost", "pnl", "peak_hedge_book_cost",
        ]

    def row(self) -> list[float]:
        return [
            self.triggers, self.premium_collected, self.payouts_paid,
            self.hedge_cash_out, self.hedge_cash_in, self.residual_hedge_value,
            self.initial_hedge_cost, self.pnl, self.max_hedge_book_cost_outstanding,
        ]


def simulate_pair_30d_straddle(
    product: Product,
    sigma_implied: float,
    sigma_realized: float,
    s_path: np.ndarray,
    t_days: np.ndarray,
    rng: np.random.Generator,
) -> PairResult:
    book = HedgeBook()
    # Initial 30-day strangle (priced at IMPLIED vol)
    initial_cost = book.open_strangle(product, sigma_implied, product.spot0, 0.0, tenor_days=30)
    cash_out = initial_cost
    cash_in = 0.0
    triggers = 0
    payouts = 0.0
    premium = 0.0
    peak_outstanding = initial_cost
    running_outstanding = initial_cost

    # Iterate days 1..max_days, with intra-day barrier monitoring
    anchor_idx = 0
    anchor_price = product.spot0
    day_end_idx_step = int(round(len(t_days) / max(1, t_days[-1])))
    # Resolve indexes for end-of-day boundaries
    steps_per_day = day_end_idx_step
    pair_alive_until_day = product.max_days

    # Daily premium charged at start of each day (pro-rated)
    for day in range(1, product.max_days + 1):
        day_start_idx = (day - 1) * steps_per_day
        day_end_idx = min(day * steps_per_day, len(t_days) - 1)
        premium += product.premium_per_pair_day

        cur_idx = max(day_start_idx, anchor_idx)
        if cur_idx == day_start_idx:
            anchor_price = s_path[cur_idx]
        while cur_idx < day_end_idx:
            hit_idx, side = first_barrier_hit_with_bridge(
                s_path, t_days, cur_idx, anchor_price, product.barrier_pct,
                sigma_realized, rng,
            )
            if hit_idx < 0 or hit_idx > day_end_idx:
                break
            triggers += 1
            payouts += product.payout_per_trigger
            trigger_spot = s_path[hit_idx]
            now_day = t_days[hit_idx]
            cash = book.sell_first_inthemoney_leg(
                product, sigma_implied, trigger_spot, now_day, is_call=(side > 0),
            )
            cash_in += cash
            running_outstanding -= cash
            if product.auto_renew and (day < product.max_days or hit_idx < day_end_idx):
                new_cost = book.open_single_leg(
                    product, sigma_implied, trigger_spot, now_day,
                    tenor_days=30, is_call=(side > 0),
                )
                cash_out += new_cost
                running_outstanding += new_cost
                peak_outstanding = max(peak_outstanding, running_outstanding)
            anchor_price = trigger_spot
            cur_idx = hit_idx
        anchor_price = s_path[day_end_idx]

    end_idx = min(product.max_days * steps_per_day, len(t_days) - 1)
    final_spot = s_path[end_idx]
    final_day = t_days[end_idx]
    residual_value = book.mark_to_market(product, sigma_implied, final_spot, final_day)
    cash_in_final = residual_value * (1 - product.venue_spread_bps / 10_000.0)
    cash_in += cash_in_final
    pnl = premium - payouts - cash_out + cash_in
    return PairResult(
        triggers=triggers,
        premium_collected=premium,
        payouts_paid=payouts,
        hedge_cash_out=cash_out,
        hedge_cash_in=cash_in,
        residual_hedge_value=cash_in_final,
        initial_hedge_cost=initial_cost,
        pnl=pnl,
        max_hedge_book_cost_outstanding=peak_outstanding,
    )


def simulate_pair_7d_strangle(
    product: Product,
    sigma_implied: float,
    sigma_realized: float,
    s_path: np.ndarray,
    t_days: np.ndarray,
    rng: np.random.Generator,
) -> PairResult:
    """Buy 7-day +/-2% strangle at activation; on trigger, do NOT auto-renew
    the option leg (the 7-day expires with the trader period). This is the
    cheap-tenor variant that matches trader period exactly.
    """
    book = HedgeBook()
    initial_cost = book.open_strangle(product, sigma_implied, product.spot0, 0.0, tenor_days=7)
    cash_out = initial_cost
    cash_in = 0.0
    triggers = 0
    payouts = 0.0
    premium = 0.0
    peak_outstanding = initial_cost

    steps_per_day = int(round(len(t_days) / max(1, t_days[-1])))
    anchor_idx = 0
    anchor_price = product.spot0
    for day in range(1, product.max_days + 1):
        day_start_idx = (day - 1) * steps_per_day
        day_end_idx = min(day * steps_per_day, len(t_days) - 1)
        premium += product.premium_per_pair_day
        cur_idx = day_start_idx
        anchor_price = s_path[cur_idx]
        while cur_idx < day_end_idx:
            hit_idx, side = first_barrier_hit_with_bridge(
                s_path, t_days, cur_idx, anchor_price, product.barrier_pct,
                sigma_realized, rng,
            )
            if hit_idx < 0 or hit_idx > day_end_idx:
                break
            triggers += 1
            payouts += product.payout_per_trigger
            trigger_spot = s_path[hit_idx]
            now_day = t_days[hit_idx]
            cash = book.sell_first_inthemoney_leg(
                product, sigma_implied, trigger_spot, now_day, is_call=(side > 0),
            )
            cash_in += cash
            anchor_price = trigger_spot
            cur_idx = hit_idx

    end_idx = min(product.max_days * steps_per_day, len(t_days) - 1)
    final_spot = s_path[end_idx]
    final_day = t_days[end_idx]
    residual_value = book.mark_to_market(product, sigma_implied, final_spot, final_day)
    cash_in_final = residual_value * (1 - product.venue_spread_bps / 10_000.0)
    cash_in += cash_in_final
    pnl = premium - payouts - cash_out + cash_in
    return PairResult(
        triggers=triggers,
        premium_collected=premium,
        payouts_paid=payouts,
        hedge_cash_out=cash_out,
        hedge_cash_in=cash_in,
        residual_hedge_value=cash_in_final,
        initial_hedge_cost=initial_cost,
        pnl=pnl,
        max_hedge_book_cost_outstanding=peak_outstanding,
    )


def simulate_pair_daily_strangle(
    product: Product,
    sigma_implied: float,
    sigma_realized: float,
    s_path: np.ndarray,
    t_days: np.ndarray,
    rng: np.random.Generator,
) -> PairResult:
    """Buy a fresh 1-day +/-2% strangle each morning. Cheap, but no
    multi-day theta carry."""
    book = HedgeBook()
    cash_out = 0.0
    cash_in = 0.0
    triggers = 0
    payouts = 0.0
    premium = 0.0
    peak_outstanding = 0.0
    initial_cost = 0.0

    steps_per_day = int(round(len(t_days) / max(1, t_days[-1])))
    for day in range(1, product.max_days + 1):
        day_start_idx = (day - 1) * steps_per_day
        day_end_idx = min(day * steps_per_day, len(t_days) - 1)
        premium += product.premium_per_pair_day
        anchor_price = s_path[day_start_idx]
        cost = book.open_strangle(
            product, sigma_implied, anchor_price, t_days[day_start_idx], tenor_days=1,
        )
        cash_out += cost
        if day == 1:
            initial_cost = cost
        peak_outstanding = max(peak_outstanding, cost)
        cur_idx = day_start_idx
        while cur_idx < day_end_idx:
            hit_idx, side = first_barrier_hit_with_bridge(
                s_path, t_days, cur_idx, anchor_price, product.barrier_pct,
                sigma_realized, rng,
            )
            if hit_idx < 0 or hit_idx > day_end_idx:
                break
            triggers += 1
            payouts += product.payout_per_trigger
            trigger_spot = s_path[hit_idx]
            now_day = t_days[hit_idx]
            cash = book.sell_first_inthemoney_leg(
                product, sigma_implied, trigger_spot, now_day, is_call=(side > 0),
            )
            cash_in += cash
            anchor_price = trigger_spot
            cur_idx = hit_idx
        end_spot = s_path[day_end_idx]
        end_day = t_days[day_end_idx]
        residual = book.mark_to_market(product, sigma_implied, end_spot, end_day)
        cash_in += residual * (1 - product.venue_spread_bps / 10_000.0)
        book.legs.clear()
    pnl = premium - payouts - cash_out + cash_in
    return PairResult(
        triggers=triggers,
        premium_collected=premium,
        payouts_paid=payouts,
        hedge_cash_out=cash_out,
        hedge_cash_in=cash_in,
        residual_hedge_value=0.0,
        initial_hedge_cost=initial_cost,
        pnl=pnl,
        max_hedge_book_cost_outstanding=peak_outstanding,
    )


def simulate_pair_perp_delta(
    product: Product,
    sigma_implied: float,
    sigma_realized: float,
    s_path: np.ndarray,
    t_days: np.ndarray,
    rng: np.random.Generator,
) -> PairResult:
    """Skeleton perp-delta-overlay model: from the platform's perspective,
    each leg is a binary 'pay $1k if BTC moves > 2%'. The simplest
    delta-replication is a perp position sized so that intrinsic P&L on a
    2% move = $1,000 on the relevant side. Net of the matched LONG+SHORT
    pair, the platform's directional exposure is symmetric -> a static
    perp position can't replicate convex payoff. We model the static
    *spread* perp hedge: hold zero net delta, accept barrier risk fully.

    This branch is mainly to quantify why a delta-only hedge is not
    sufficient for this product structure. PnL = premium - payouts +
    perp funding/carry only.
    """
    cash_out = 0.0
    cash_in = 0.0
    triggers = 0
    payouts = 0.0
    premium = 0.0
    initial_cost = 0.0
    steps_per_day = int(round(len(t_days) / max(1, t_days[-1])))
    anchor_price = product.spot0
    funding_drag_per_pair_per_day = (
        product.notional_per_side * 2 * product.venue_perp_funding_bps_day / 10_000.0
    )
    for day in range(1, product.max_days + 1):
        day_start_idx = (day - 1) * steps_per_day
        day_end_idx = min(day * steps_per_day, len(t_days) - 1)
        premium += product.premium_per_pair_day
        cash_out += funding_drag_per_pair_per_day
        anchor_price = s_path[day_start_idx]
        cur_idx = day_start_idx
        while cur_idx < day_end_idx:
            hit_idx, side = first_barrier_hit_with_bridge(
                s_path, t_days, cur_idx, anchor_price, product.barrier_pct,
                sigma_realized, rng,
            )
            if hit_idx < 0 or hit_idx > day_end_idx:
                break
            triggers += 1
            payouts += product.payout_per_trigger
            anchor_price = s_path[hit_idx]
            cur_idx = hit_idx
    pnl = premium - payouts - cash_out + cash_in
    return PairResult(
        triggers=triggers,
        premium_collected=premium,
        payouts_paid=payouts,
        hedge_cash_out=cash_out,
        hedge_cash_in=cash_in,
        residual_hedge_value=0.0,
        initial_hedge_cost=initial_cost,
        pnl=pnl,
        max_hedge_book_cost_outstanding=0.0,
    )


HEDGE_STRATEGIES = {
    "straddle_30d": simulate_pair_30d_straddle,
    "strangle_7d":  simulate_pair_7d_strangle,
    "daily_strangle": simulate_pair_daily_strangle,
    "perp_delta_only": simulate_pair_perp_delta,
}


# =============================================================================
# Driver
# =============================================================================


def run_regime(
    regime_name: str,
    product: Product,
    n_paths: int,
    steps_per_day: int,
    rng: np.random.Generator,
    vrp: float = 0.0,
) -> dict:
    """Run a regime simulation.

    ``vrp`` is the vol-risk-premium: implied vol used for option pricing
    is REGIMES[regime].sigma, but realized vol used to simulate paths is
    sigma_realized = sigma * (1 - vrp).  vrp = 0.20 means realized BTC
    vol is 80% of DVOL — a typical empirical magnitude for the BTC vol
    surface in calm-to-moderate regimes.
    """
    sigma_implied = REGIMES[regime_name]["sigma"]
    sigma_realized = max(0.05, sigma_implied * (1.0 - vrp))
    horizon = max(product.max_days, 30)
    prices, t_days = simulate_btc_paths(
        product, sigma_realized, n_paths, horizon_days=horizon,
        steps_per_day=steps_per_day, rng=rng,
    )
    out: dict = {
        "regime": regime_name,
        "sigma_implied": sigma_implied,
        "sigma_realized": sigma_realized,
        "vrp": vrp,
        "n_paths": n_paths,
        "product": product.__dict__,
        "strategies": {},
    }

    for strat_name, strat_fn in HEDGE_STRATEGIES.items():
        results: list[PairResult] = []
        path_rng = np.random.default_rng(rng.integers(0, 2**63 - 1))
        for i in range(n_paths):
            r = strat_fn(
                product, sigma_implied, sigma_realized,
                prices[i], t_days, path_rng,
            )
            results.append(r)
        out["strategies"][strat_name] = summarize(results)
    return out


def summarize(results: list[PairResult]) -> dict:
    arr = np.array([r.row() for r in results], dtype=float)
    cols = PairResult.header()
    summary = {}
    for j, col in enumerate(cols):
        v = arr[:, j]
        summary[col] = {
            "mean": float(np.mean(v)),
            "std": float(np.std(v)),
            "p05": float(np.percentile(v, 5)),
            "p25": float(np.percentile(v, 25)),
            "p50": float(np.percentile(v, 50)),
            "p75": float(np.percentile(v, 75)),
            "p95": float(np.percentile(v, 95)),
            "min": float(np.min(v)),
            "max": float(np.max(v)),
        }
    summary["pnl_distribution"] = arr[:, cols.index("pnl")].tolist()
    summary["triggers_distribution"] = arr[:, cols.index("triggers")].tolist()
    return summary


def write_outputs(all_results: dict, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)

    distro_only = {}
    summary_only = {}
    for regime, regime_data in all_results["regimes"].items():
        distro_only[regime] = {}
        summary_only[regime] = {}
        for strat, strat_data in regime_data["strategies"].items():
            distro_only[regime][strat] = {
                "pnl": strat_data["pnl_distribution"],
                "triggers": strat_data["triggers_distribution"],
            }
            summary_only[regime][strat] = {
                k: v for k, v in strat_data.items()
                if k not in ("pnl_distribution", "triggers_distribution")
            }

    (out_dir / "summary.json").write_text(json.dumps({
        "config": all_results["config"],
        "regimes": summary_only,
    }, indent=2))

    (out_dir / "distributions.json").write_text(json.dumps(distro_only))

    with (out_dir / "per_pair_summary.csv").open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow([
            "regime", "strategy", "metric", "mean", "p05", "p25", "p50",
            "p75", "p95", "min", "max",
        ])
        for regime, sd in summary_only.items():
            for strat, metrics in sd.items():
                for metric, stats in metrics.items():
                    if isinstance(stats, dict):
                        w.writerow([
                            regime, strat, metric,
                            f"{stats['mean']:.2f}",
                            f"{stats['p05']:.2f}",
                            f"{stats['p25']:.2f}",
                            f"{stats['p50']:.2f}",
                            f"{stats['p75']:.2f}",
                            f"{stats['p95']:.2f}",
                            f"{stats['min']:.2f}",
                            f"{stats['max']:.2f}",
                        ])


def derive_capital_requirements(all_results: dict) -> dict:
    """Translate per-pair P&L distributions into capital requirements at
    common scale checkpoints. Three layers of capital:
      L1: Hedge equity   = mean upfront option cost x N pairs
      L2: Trigger reserve = max( p95(payouts - hedge_cash_in_within_pair),
                                 5x mean intra-life peak outstanding )
      L3: Drawdown reserve = abs(p01(weekly P&L)) x sqrt(N) Bayesian aggregation.
    Operational headroom = 1.30x of L1+L2+L3.
    """
    scales = [1, 4, 8, 12, 25, 50, 100, 250, 500, 1000]
    out = {}
    for regime, regime_data in all_results["regimes"].items():
        out[regime] = {}
        for strat, strat_data in regime_data["strategies"].items():
            init_hedge = strat_data["initial_hedge_cost"]["mean"]
            peak = strat_data["peak_hedge_book_cost"]["p95"]
            pnl_p05 = strat_data["pnl"]["p05"]
            pnl_min = strat_data["pnl"]["min"]
            pnl_mean = strat_data["pnl"]["mean"]
            pnl_std = strat_data["pnl"]["std"]
            scale_table = {}
            for n in scales:
                # L1 - hedge equity at peak (scales linearly)
                l1 = peak * n
                # L2 - trigger reserve: net adverse one-day shock (z=2.33)
                # Uses standard sqrt-N risk pooling for independent pairs
                shock_per_pair = max(0.0, -pnl_p05)
                l2 = shock_per_pair * math.sqrt(n) * 2.33 / 1.65  # convert p05 -> p01
                # L3 - drawdown reserve from extreme tail
                l3_mean = max(0.0, -pnl_mean) * n  # only kicks in if E[PnL] < 0
                # Total before headroom
                base = l1 + l2 + l3_mean
                total = base * 1.30
                scale_table[str(n)] = {
                    "hedge_equity_l1": round(l1, 0),
                    "trigger_reserve_l2": round(l2, 0),
                    "expected_loss_buffer_l3": round(l3_mean, 0),
                    "total_with_30pct_headroom": round(total, 0),
                    "expected_pair_pnl_per_lifecycle": round(pnl_mean, 0),
                    "expected_aggregate_pnl_per_week": round(pnl_mean * n, 0),
                    "p05_aggregate_pnl_per_week": round(
                        pnl_mean * n - 1.645 * pnl_std * math.sqrt(n), 0,
                    ),
                }
            out[regime][strat] = scale_table
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--paths", type=int, default=8000)
    parser.add_argument("--steps-per-day", type=int, default=24)
    parser.add_argument("--regime", choices=list(REGIMES) + ["all"], default="all")
    parser.add_argument("--premium-side", type=float, default=250.0,
                        help="Premium per side per day (per pair = 2x).")
    parser.add_argument("--out", type=str,
                        default="docs/cfo-report/double-barrier-analysis")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--vrp", type=float, default=0.0,
                        help="Vol-risk-premium: realized = implied*(1-vrp). "
                             "0.0 = risk-neutral, 0.20 = realized 20%% below "
                             "implied (typical empirical BTC).")
    args = parser.parse_args()

    product = Product(premium_per_pair_day=args.premium_side * 2)
    rng = np.random.default_rng(args.seed)
    regimes = list(REGIMES) if args.regime == "all" else [args.regime]
    out_dir = Path(args.out)

    all_results = {
        "config": {
            "product": product.__dict__,
            "n_paths": args.paths,
            "steps_per_day": args.steps_per_day,
            "premium_per_side": args.premium_side,
            "premium_per_pair_day": product.premium_per_pair_day,
            "vrp": args.vrp,
        },
        "regimes": {},
    }

    print(f"Simulator config: {args.paths} paths/regime, "
          f"{args.steps_per_day} steps/day, premium=${args.premium_side}/side/day, "
          f"vrp={args.vrp:.2f}")

    for r in regimes:
        s_imp = REGIMES[r]['sigma']
        s_real = s_imp * (1 - args.vrp)
        print(f"  [{r}] σ_implied={s_imp:.2f}  σ_realized={s_real:.2f}  ...")
        all_results["regimes"][r] = run_regime(
            r, product, args.paths, args.steps_per_day, rng, vrp=args.vrp,
        )
        for strat, sd in all_results["regimes"][r]["strategies"].items():
            print(f"      {strat:18s}  E[PnL/pair-life]=${sd['pnl']['mean']:>8.0f}  "
                  f"E[triggers]={sd['triggers']['mean']:>4.1f}  "
                  f"upfront=${sd['initial_hedge_cost']['mean']:>5.0f}  "
                  f"p05 PnL=${sd['pnl']['p05']:>8.0f}")

    capital = derive_capital_requirements(all_results)
    all_results["capital_ladder"] = capital

    write_outputs(all_results, out_dir)
    (out_dir / "capital_ladder.json").write_text(json.dumps(capital, indent=2))

    print(f"\nOutputs written under {out_dir}/")
    print("  summary.json, distributions.json, per_pair_summary.csv, capital_ladder.json")


if __name__ == "__main__":
    main()
