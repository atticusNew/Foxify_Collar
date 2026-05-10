#!/usr/bin/env python3
"""
Fetch 4 years of BTC hourly closes from CryptoCompare and 4 years of
Deribit DVOL daily values, cache to disk, and emit a clean parquet/CSV
pair the replay simulator can consume.

No API key required. Re-runnable; resumes from the cache.

Outputs:
  data/btc_hourly.csv   (timestamp, open, high, low, close, volume)
  data/dvol_daily.csv   (timestamp, dvol_open, dvol_high, dvol_low, dvol_close)
"""

from __future__ import annotations

import csv
import json
import time
import urllib.request
import urllib.error
from pathlib import Path

DATA_DIR = Path("data/double-barrier")
DATA_DIR.mkdir(parents=True, exist_ok=True)
BTC_PATH = DATA_DIR / "btc_hourly.csv"
DVOL_PATH = DATA_DIR / "dvol_daily.csv"

# ~4 years back from today
NOW = int(time.time())
FOUR_YEARS_AGO = NOW - 4 * 365 * 86400


def fetch_btc_hourly() -> None:
    """CryptoCompare histohour, paginated backwards via toTs."""
    if BTC_PATH.exists():
        print(f"  [btc] cache exists at {BTC_PATH}; skipping fetch")
        return
    rows: list[dict] = []
    to_ts = NOW
    while to_ts > FOUR_YEARS_AGO:
        url = (
            "https://min-api.cryptocompare.com/data/v2/histohour"
            f"?fsym=BTC&tsym=USD&limit=2000&toTs={to_ts}"
        )
        with urllib.request.urlopen(url, timeout=20) as r:
            d = json.loads(r.read())
        if d.get("Response") != "Success":
            raise RuntimeError(f"cc error: {d}")
        bars = d["Data"]["Data"]
        if not bars:
            break
        for b in bars:
            rows.append({
                "ts": b["time"],
                "open": b["open"],
                "high": b["high"],
                "low": b["low"],
                "close": b["close"],
                "vol": b["volumefrom"],
            })
        oldest = bars[0]["time"]
        print(f"  [btc] got {len(bars)} bars to {oldest}, total {len(rows)}", flush=True)
        if oldest <= FOUR_YEARS_AGO:
            break
        to_ts = oldest - 3600
        time.sleep(0.3)
    rows.sort(key=lambda r: r["ts"])
    seen = set()
    dedup = []
    for r in rows:
        if r["ts"] in seen:
            continue
        seen.add(r["ts"])
        dedup.append(r)
    with BTC_PATH.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["ts", "open", "high", "low", "close", "vol"])
        w.writeheader()
        for r in dedup:
            w.writerow(r)
    print(f"  [btc] wrote {len(dedup)} rows -> {BTC_PATH}")


def fetch_dvol_daily() -> None:
    """Deribit DVOL daily candles. Endpoint accepts ms timestamps and
    returns up to ~720 rows per call; we paginate."""
    if DVOL_PATH.exists():
        print(f"  [dvol] cache exists at {DVOL_PATH}; skipping fetch")
        return
    rows: list[dict] = []
    end_ms = NOW * 1000
    start_ms_global = FOUR_YEARS_AGO * 1000
    chunk_days = 700
    chunk_ms = chunk_days * 86400 * 1000
    cursor = end_ms
    while cursor > start_ms_global:
        chunk_start = max(start_ms_global, cursor - chunk_ms)
        url = (
            "https://www.deribit.com/api/v2/public/get_volatility_index_data"
            f"?currency=BTC&start_timestamp={chunk_start}&end_timestamp={cursor}"
            "&resolution=86400"
        )
        with urllib.request.urlopen(url, timeout=20) as r:
            d = json.loads(r.read())
        for ts, dv_open, dv_high, dv_low, dv_close in d["result"]["data"]:
            rows.append({
                "ts": int(ts // 1000),
                "dvol_open": dv_open,
                "dvol_high": dv_high,
                "dvol_low": dv_low,
                "dvol_close": dv_close,
            })
        print(f"  [dvol] chunk -> {len(d['result']['data'])} rows; total {len(rows)}", flush=True)
        cursor = chunk_start - 86400 * 1000
        if not d["result"]["data"]:
            break
        time.sleep(0.3)
    rows.sort(key=lambda r: r["ts"])
    seen = set()
    dedup = []
    for r in rows:
        if r["ts"] in seen:
            continue
        seen.add(r["ts"])
        dedup.append(r)
    with DVOL_PATH.open("w", newline="") as f:
        w = csv.DictWriter(
            f,
            fieldnames=["ts", "dvol_open", "dvol_high", "dvol_low", "dvol_close"],
        )
        w.writeheader()
        for r in dedup:
            w.writerow(r)
    print(f"  [dvol] wrote {len(dedup)} rows -> {DVOL_PATH}")


def main() -> None:
    print("Fetching BTC hourly...")
    fetch_btc_hourly()
    print("Fetching DVOL daily...")
    fetch_dvol_daily()
    print("Done.")


if __name__ == "__main__":
    main()
