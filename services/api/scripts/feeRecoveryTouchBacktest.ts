/**
 * Fee-Recovery Cover — go/no-go backtest runner.
 *
 * Fetches REAL data (no DB, no keys — all public):
 *   - BTC 1h OHLC (high/low for accurate touch detection) from Binance.
 *   - DVOL 1h history from Deribit (the exchange implied-vol index).
 * Then runs runFeeRecoveryBacktest: per (side, trigger, signal) it compares the REALIZED stop-touch
 * rate (from price highs/lows) to the IMPLIED touch rate (from DVOL), and prices the cooperative
 * pass-through cover (premium = implied×payout + ops_fee). Answers: is there a signal bucket where
 * Foxify's covered trades are +EV net of Atticus's ops fee?
 *
 * Usage:
 *   npm --workspace services/api run backtest:fee-recovery -- \
 *     --days 180 --tenor-hours 24 --payout 60 --ops-fee 1 --trades-per-day 1000 \
 *     --triggers 0.02,0.025,0.03,0.035,0.04 --sides long,short
 */

import {
  runFeeRecoveryBacktest, type Candle, type DvolPoint, type TradeSide
} from "../src/singleSide/twoSided/feeRecoveryBacktest";

const HOUR = 3_600_000;

const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};

const fetchJson = async (url: string): Promise<unknown> => {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) return res.json();
      if (res.status !== 429 && res.status < 500) throw new Error(`http_${res.status}`);
    } catch (e) {
      if (attempt === 4) throw e;
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  throw new Error("fetch_failed");
};

/** Binance 1h klines with high/low. row = [openTime, open, high, low, close, ...]. */
const fetchBinanceOhlc = async (fromMs: number, toMs: number): Promise<Candle[]> => {
  const out: Candle[] = [];
  let cursor = fromMs;
  while (cursor < toMs) {
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&startTime=${cursor}&endTime=${toMs}&limit=1000`;
    const rows = (await fetchJson(url)) as unknown[];
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows as number[][]) {
      const tsMs = Number(r[0]);
      const high = Number(r[2]), low = Number(r[3]), close = Number(r[4]);
      if (Number.isFinite(tsMs) && high > 0 && low > 0 && close > 0) out.push({ tsMs, close, high, low });
    }
    const last = Number((rows as number[][])[rows.length - 1][0]);
    if (!Number.isFinite(last)) break;
    cursor = last + HOUR;
  }
  return out;
};

/** Coinbase 1h candles. row = [timeSec, low, high, open, close, volume]; max 300/req. */
const fetchCoinbaseOhlc = async (fromMs: number, toMs: number): Promise<Candle[]> => {
  const out: Candle[] = [];
  const WINDOW = 300 * HOUR;
  let cursor = fromMs;
  while (cursor < toMs) {
    const end = Math.min(toMs, cursor + WINDOW);
    const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600&start=${new Date(cursor).toISOString()}&end=${new Date(end).toISOString()}`;
    const rows = (await fetchJson(url)) as number[][];
    if (Array.isArray(rows)) {
      for (const r of rows) {
        const tsMs = Number(r[0]) * 1000, low = Number(r[1]), high = Number(r[2]), close = Number(r[4]);
        if (Number.isFinite(tsMs) && high > 0 && low > 0 && close > 0) out.push({ tsMs, close, high, low });
      }
    }
    cursor = end + 1;
    await new Promise((r) => setTimeout(r, 250)); // be gentle with Coinbase rate limits
  }
  return out;
};

const fetchBtcOhlc = async (fromMs: number, toMs: number): Promise<Candle[]> => {
  let raw: Candle[] = [];
  try {
    raw = await fetchBinanceOhlc(fromMs, toMs);
    if (raw.length > 0) console.error(`[backtest] price source: binance`);
  } catch (e) {
    console.error(`[backtest] binance unavailable (${(e as Error).message}); falling back to coinbase`);
  }
  if (raw.length === 0) {
    raw = await fetchCoinbaseOhlc(fromMs, toMs);
    console.error(`[backtest] price source: coinbase`);
  }
  const dedup = new Map<number, Candle>();
  for (const c of raw) if (c.tsMs >= fromMs && c.tsMs <= toMs) dedup.set(Math.round(c.tsMs / HOUR), c);
  return [...dedup.values()].sort((a, b) => a.tsMs - b.tsMs);
};

/** Deribit DVOL 1h. result.data = [[ts, open, high, low, close], ...]; take close. Chunked. */
const fetchDvol = async (fromMs: number, toMs: number): Promise<DvolPoint[]> => {
  const out: DvolPoint[] = [];
  const CHUNK = 700 * HOUR;
  let start = fromMs;
  while (start < toMs) {
    const end = Math.min(toMs, start + CHUNK);
    const url = `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=${start}&end_timestamp=${end}&resolution=3600`;
    const body = (await fetchJson(url)) as { result?: { data?: number[][] } };
    for (const row of body.result?.data ?? []) {
      const tsMs = Number(row[0]); const close = Number(row[4]);
      if (Number.isFinite(tsMs) && close > 0) out.push({ tsMs, dvol: close });
    }
    start = end + 1;
  }
  const dedup = new Map<number, DvolPoint>();
  for (const d of out) dedup.set(Math.round(d.tsMs / HOUR), d);
  return [...dedup.values()].sort((a, b) => a.tsMs - b.tsMs);
};

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

const main = async () => {
  const days = Number(arg("days", "180"));
  const tenorHours = Number(arg("tenor-hours", "24"));
  const payoutUsdc = Number(arg("payout", "60"));
  const opsFeeUsdc = Number(arg("ops-fee", "1"));
  const tradesPerDay = Number(arg("trades-per-day", "1000"));
  const triggers = arg("triggers", "0.02,0.025,0.03,0.035,0.04").split(",").map(Number).filter((x) => x > 0);
  const sides = arg("sides", "long,short").split(",").map((s) => s.trim()).filter((s) => s === "long" || s === "short") as TradeSide[];

  const toMs = Date.now();
  const fromMs = toMs - days * 24 * HOUR;

  console.error(`[backtest] fetching BTC OHLC + DVOL for ${days}d ...`);
  const [candles, dvol] = await Promise.all([fetchBtcOhlc(fromMs, toMs), fetchDvol(fromMs, toMs)]);
  console.error(`[backtest] candles=${candles.length} dvol=${dvol.length}`);
  if (candles.length < tenorHours + 50 || dvol.length < 50) {
    console.error("[backtest] insufficient data fetched"); process.exit(1);
  }

  const rep = runFeeRecoveryBacktest(candles, dvol, {
    triggers, tenorHours, sides, payoutUsdc, opsFeeUsdc, tradesPerDay, minBucketN: 30
  });

  // Console-friendly digest, then full JSON.
  console.log("\n══════════ FEE-RECOVERY GO/NO-GO BACKTEST ══════════");
  console.log(`window: ${rep.window.from_iso?.slice(0, 10)} → ${rep.window.to_iso?.slice(0, 10)}  entries=${rep.window.entries}`);
  console.log(`payout=$${payoutUsdc}  ops_fee=$${opsFeeUsdc}  tenor=${tenorHours}h  trades/day=${tradesPerDay}`);
  console.log("\n--- summary ---");
  for (const s of rep.summary) console.log("• " + s);

  console.log("\n--- unconditional (always-on) by side/trigger ---");
  console.log("side  trig   realized  implied   edge   foxify$/trade  verdict");
  for (const r of rep.rows.filter((x) => x.signal === "all")) {
    console.log(
      `${r.side.padEnd(5)} ${pct(r.trigger).padStart(5)}  ${pct(r.realized_touch_rate).padStart(7)}  ${pct(r.implied_touch_rate).padStart(7)}  ${(r.edge * 100).toFixed(1).padStart(5)}  ${String(r.foxify_ev_per_trade_usdc).padStart(11)}   ${r.verdict}`
    );
  }

  console.log(`\n--- FOXIFY_POSITIVE buckets (${rep.best_positive.length}) ---`);
  if (rep.best_positive.length === 0) {
    console.log("(none — no signal bucket clears the ops fee at these params)");
  } else {
    console.log("side  trig   signal         n     realized  implied   edge   foxify$/trade  foxify$/day");
    for (const r of rep.best_positive.slice(0, 20)) {
      console.log(
        `${r.side.padEnd(5)} ${pct(r.trigger).padStart(5)}  ${r.signal.padEnd(13)} ${String(r.n).padStart(5)}  ${pct(r.realized_touch_rate).padStart(7)}  ${pct(r.implied_touch_rate).padStart(7)}  ${(r.edge * 100).toFixed(1).padStart(5)}  ${String(r.foxify_ev_per_trade_usdc).padStart(11)}  ${String(r.foxify_ev_per_day_usdc ?? "")}`
      );
    }
  }

  console.log("\n--- full JSON ---");
  console.log(JSON.stringify(rep, null, 2));
};

main().catch((e) => { console.error(`[backtest] failed: ${(e as Error).message}`); process.exit(1); });
