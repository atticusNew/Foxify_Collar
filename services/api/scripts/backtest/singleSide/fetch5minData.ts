/**
 * Pull ~16 months of BTC 5-min OHLC from Binance public API.
 * Saves to /tmp/btc_5min_ohlc.json for the intraday harness.
 *
 * Binance kline format per bar:
 *   [openTime, open, high, low, close, volume, closeTime, ...]
 *
 * Limits: 1000 bars per request × 5min = ~83 hours per request.
 * Window: 487 days × 24h × 12 (5-min bars/hr) = ~140k bars → ~140 requests.
 */

import * as fs from "node:fs/promises";

const SYMBOL = "BTCUSDT";
const INTERVAL = "5m";
const BAR_MS = 5 * 60_000;
const PER_REQUEST = 1000;

const main = async () => {
  console.log("# Pulling BTC 5-min OHLC from Binance\n");

  const endMs = Date.now();
  const startMs = endMs - 487 * 86_400_000;

  const allBars: Array<{
    timestamp: number;
    date: string;
    minute: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }> = [];

  let cursor = startMs;
  let chunkCount = 0;
  while (cursor < endMs) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${INTERVAL}&startTime=${cursor}&limit=${PER_REQUEST}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      console.error(`Binance fetch failed at ${new Date(cursor).toISOString()}: ${res.status}`);
      const errBody = await res.text();
      console.error(errBody.slice(0, 200));
      break;
    }
    const bars = (await res.json()) as Array<Array<unknown>>;
    if (bars.length === 0) break;
    for (const b of bars) {
      const ts = b[0] as number;
      const iso = new Date(ts).toISOString();
      allBars.push({
        timestamp: ts,
        date: iso.slice(0, 10),
        minute: iso.slice(0, 16),
        open: Number(b[1]),
        high: Number(b[2]),
        low: Number(b[3]),
        close: Number(b[4]),
        volume: Number(b[5])
      });
    }
    const lastTs = bars[bars.length - 1][0] as number;
    cursor = lastTs + BAR_MS;
    chunkCount++;
    if (chunkCount % 10 === 0) {
      process.stdout.write(`  ${chunkCount} chunks, last=${new Date(lastTs).toISOString().slice(0, 13)}, total=${allBars.length} bars\n`);
    }
    await new Promise((r) => setTimeout(r, 120));
  }

  console.log(`\nTotal bars: ${allBars.length}`);
  console.log(`First: ${allBars[0]?.minute} (close $${allBars[0]?.close.toFixed(2)})`);
  console.log(`Last:  ${allBars[allBars.length - 1]?.minute} (close $${allBars[allBars.length - 1]?.close.toFixed(2)})`);

  // Group into per-day index for fast lookup by date
  const dailyIndex: Record<string, { startIdx: number; endIdx: number }> = {};
  for (let i = 0; i < allBars.length; i++) {
    const d = allBars[i].date;
    if (!(d in dailyIndex)) dailyIndex[d] = { startIdx: i, endIdx: i };
    dailyIndex[d].endIdx = i;
  }

  const out = {
    source: "Binance public klines",
    symbol: SYMBOL,
    interval: INTERVAL,
    pulledAt: new Date().toISOString(),
    bars: allBars,
    dailyIndex
  };
  await fs.writeFile("/tmp/btc_5min_ohlc.json", JSON.stringify(out));
  console.log(`\nSaved ${allBars.length} bars to /tmp/btc_5min_ohlc.json`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
