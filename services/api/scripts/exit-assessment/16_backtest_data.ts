/**
 * Pull 16+ months of BTC daily OHLC data from public sources.
 * Saves to a JSON file for the backtest to consume.
 *
 * READ ONLY (public Coinbase API).
 */

import * as fs from "node:fs/promises";

const main = async () => {
  console.log("# Pulling BTC daily OHLC history from Coinbase\n");

  // Coinbase public API: get_product_candles
  // Granularity: 86400 = 1 day
  // Max 300 candles per request → 300 days. Need to paginate.
  const granularity = 86_400;
  const endMs = Date.now();
  // 16 months = ~487 days
  const startMs = endMs - 487 * 86_400_000;

  const allCandles: any[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const chunkEnd = Math.min(cursor + 300 * 86_400_000, endMs);
    const startIso = new Date(cursor).toISOString();
    const endIso = new Date(chunkEnd).toISOString();
    const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=${granularity}&start=${startIso}&end=${endIso}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      console.error(`Fetch failed at cursor ${startIso}: ${res.status}`);
      break;
    }
    const candles = await res.json() as any[];
    // Coinbase format: [time, low, high, open, close, volume]
    for (const c of candles) {
      allCandles.push({
        timestamp: c[0] * 1000,
        date: new Date(c[0] * 1000).toISOString().slice(0, 10),
        low: c[1],
        high: c[2],
        open: c[3],
        close: c[4],
        volume: c[5]
      });
    }
    cursor = chunkEnd + 86_400_000;
    await new Promise(r => setTimeout(r, 250));
    process.stdout.write(`  Pulled chunk ending ${endIso.slice(0,10)}... `);
  }

  // Dedupe + sort ascending
  const dedup: Record<string, any> = {};
  for (const c of allCandles) dedup[c.date] = c;
  const sorted = Object.values(dedup).sort((a: any, b: any) => a.timestamp - b.timestamp);

  console.log(`\n\nTotal candles: ${sorted.length}`);
  console.log(`First: ${(sorted[0] as any).date} (close $${(sorted[0] as any).close.toFixed(2)})`);
  console.log(`Last:  ${(sorted[sorted.length-1] as any).date} (close $${(sorted[sorted.length-1] as any).close.toFixed(2)})`);

  // Compute realized vol per 30-day window (annualized)
  const annualVolByDay: Record<string, number> = {};
  for (let i = 30; i < sorted.length; i++) {
    const window = sorted.slice(i - 30, i);
    const returns: number[] = [];
    for (let j = 1; j < window.length; j++) {
      returns.push(Math.log((window[j] as any).close / (window[j-1] as any).close));
    }
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
    const sd = Math.sqrt(variance);
    const annualized = sd * Math.sqrt(365);
    annualVolByDay[(sorted[i] as any).date] = annualized;
  }

  const out = {
    source: "Coinbase Pro candles",
    pulledAt: new Date().toISOString(),
    candles: sorted,
    annualVolByDay
  };
  await fs.writeFile("/tmp/btc_daily_ohlc.json", JSON.stringify(out));
  console.log(`\nSaved to /tmp/btc_daily_ohlc.json`);

  // Sanity: regime distribution
  const regimes = { calm: 0, normal: 0, elevated: 0, stress: 0 };
  for (const v of Object.values(annualVolByDay)) {
    if (v < 0.50) regimes.calm++;
    else if (v < 0.70) regimes.normal++;
    else if (v < 0.95) regimes.elevated++;
    else regimes.stress++;
  }
  console.log(`\nVol regime distribution (${Object.keys(annualVolByDay).length} days):`);
  console.log(`  Calm    (<50% vol):  ${regimes.calm} days (${(regimes.calm/Object.keys(annualVolByDay).length*100).toFixed(0)}%)`);
  console.log(`  Normal  (50-70%):    ${regimes.normal} days (${(regimes.normal/Object.keys(annualVolByDay).length*100).toFixed(0)}%)`);
  console.log(`  Elevated (70-95%):   ${regimes.elevated} days (${(regimes.elevated/Object.keys(annualVolByDay).length*100).toFixed(0)}%)`);
  console.log(`  Stress  (>95%):      ${regimes.stress} days (${(regimes.stress/Object.keys(annualVolByDay).length*100).toFixed(0)}%)`);
};

main().catch(e => { console.error(e); process.exit(1); });
