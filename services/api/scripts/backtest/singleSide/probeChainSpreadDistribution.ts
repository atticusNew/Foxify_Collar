/**
 * Chain-wide moneyness × spread distribution probe.
 *
 * Pulls Deribit book_summary for ALL BTC options at all tenors, computes
 * bid/ask spread per moneyness bucket. Answers: are ITM spreads universally
 * wide right now, or is the 93.7% on pair_50k_2pct_itm call an outlier?
 *
 * Run this multiple times across the day to characterize time-of-day effects.
 * Each run appends to /tmp/spread_distribution_history.jsonl (one line per run).
 *
 * Output: docs/PHASE_1_CHAIN_SPREAD_DISTRIBUTION_<date>.md (overwrites)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

const fetchJson = async <T>(url: string, timeoutMs = 10_000): Promise<T> => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as T;
  } finally { clearTimeout(t); }
};

const main = async () => {
  const startedAt = new Date();
  console.log(`# Chain spread distribution probe (run at ${startedAt.toISOString()})\n`);

  // Spot for moneyness calc
  const idx = await fetchJson<{ result: { index_price: number } }>(
    "https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd"
  );
  const spot = idx.result.index_price;
  console.log(`Spot: \$${spot.toFixed(2)}\n`);

  // Get book summary for all BTC options (one big call, gives bid/ask/mark for everything)
  type BookSummary = {
    instrument_name: string;
    bid_price: number | null;
    ask_price: number | null;
    mid_price: number | null;
    mark_price: number;
    mark_iv: number;
    underlying_price: number;
    creation_timestamp: number;
  };
  const summaryRes = await fetchJson<{ result: BookSummary[] }>(
    "https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option"
  );
  const summaries = summaryRes.result.filter((s) => s.bid_price != null && s.ask_price != null && s.bid_price > 0 && s.ask_price > 0);
  console.log(`Got ${summaries.length} quoted BTC option instruments\n`);

  // Parse instrument name: BTC-DDMMMYY-STRIKE-P|C
  type Parsed = BookSummary & { strike: number; optType: "put" | "call"; expiryMs: number };
  const parsed: Parsed[] = [];
  for (const s of summaries) {
    const m = s.instrument_name.match(/^BTC-(\d{1,2})([A-Z]{3})(\d{2})-(\d+)-([PC])$/);
    if (!m) continue;
    const day = Number(m[1]);
    const mon = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"].indexOf(m[2]);
    const yr = 2000 + Number(m[3]);
    const expiry = Date.UTC(yr, mon, day, 8, 0, 0); // Deribit expires 08:00 UTC
    parsed.push({ ...s, strike: Number(m[4]), optType: m[5] === "P" ? "put" : "call", expiryMs: expiry });
  }

  // Bucket by (tenor band, moneyness band)
  const tenorBands = [
    { label: "0-12h", min: 0, max: 0.5 },
    { label: "12-24h", min: 0.5, max: 1 },
    { label: "1-3d", min: 1, max: 3 },
    { label: "3-7d", min: 3, max: 7 },
    { label: "7-30d", min: 7, max: 30 }
  ];
  const moneyBands = [
    { label: "deep_ITM_(>5%)", min: -100, max: -0.05 },
    { label: "ITM_(2-5%)",     min: -0.05, max: -0.02 },
    { label: "near_ITM_(0-2%)",min: -0.02, max: 0 },
    { label: "ATM_(±0.5%)",    min: -0.005, max: 0.005 },
    { label: "near_OTM_(0-2%)",min: 0, max: 0.02 },
    { label: "OTM_(2-5%)",     min: 0.02, max: 0.05 },
    { label: "deep_OTM_(>5%)", min: 0.05, max: 100 }
  ];
  // Moneyness: for calls, (strike-spot)/spot; for puts, (spot-strike)/spot
  // Both flipped so + = OTM, - = ITM
  const moneynessOf = (p: Parsed): number => p.optType === "call"
    ? (p.strike - spot) / spot
    : (spot - p.strike) / spot;

  const now = Date.now();
  type Bucket = { tenor: string; money: string; optType: "put" | "call"; n: number; meanSpreadPct: number; medianSpreadPct: number; meanIv: number; spreads: number[] };
  const buckets = new Map<string, Bucket>();

  for (const p of parsed) {
    const tenorDays = (p.expiryMs - now) / 86_400_000;
    if (tenorDays <= 0) continue;
    const tb = tenorBands.find((b) => tenorDays >= b.min && tenorDays < b.max);
    if (!tb) continue;
    const m = moneynessOf(p);
    const mb = moneyBands.find((b) => m >= b.min && m < b.max);
    if (!mb) continue;
    if (p.bid_price == null || p.ask_price == null) continue;
    const mid = (p.bid_price + p.ask_price) / 2;
    if (mid <= 0) continue;
    const spreadPct = (p.ask_price - p.bid_price) / mid;
    const key = `${tb.label}::${mb.label}::${p.optType}`;
    const b = buckets.get(key) ?? { tenor: tb.label, money: mb.label, optType: p.optType, n: 0, meanSpreadPct: 0, medianSpreadPct: 0, meanIv: 0, spreads: [] };
    b.n++;
    b.meanSpreadPct += spreadPct;
    b.meanIv += p.mark_iv;
    b.spreads.push(spreadPct);
    buckets.set(key, b);
  }
  for (const b of buckets.values()) {
    b.meanSpreadPct /= b.n;
    b.meanIv /= b.n;
    b.spreads.sort((a, c) => a - c);
    b.medianSpreadPct = b.spreads[Math.floor(b.spreads.length / 2)] ?? 0;
  }

  // Output to console (terse)
  const sorted = [...buckets.values()].sort((a, b) => {
    if (a.tenor !== b.tenor) return tenorBands.findIndex((x) => x.label === a.tenor) - tenorBands.findIndex((x) => x.label === b.tenor);
    if (a.money !== b.money) return moneyBands.findIndex((x) => x.label === a.money) - moneyBands.findIndex((x) => x.label === b.money);
    return a.optType.localeCompare(b.optType);
  });
  console.log(`tenor    | moneyness        | type | N  | median spread% | mean spread% | mean IV%`);
  console.log(`---------|------------------|------|----|----------------|--------------|----------`);
  for (const b of sorted) {
    console.log(`${b.tenor.padEnd(8)} | ${b.money.padEnd(16)} | ${b.optType.padEnd(4)} | ${String(b.n).padStart(2)} | ${(b.medianSpreadPct*100).toFixed(1).padStart(13)}% | ${(b.meanSpreadPct*100).toFixed(1).padStart(11)}% | ${(b.meanIv).toFixed(1)}%`);
  }

  // Write markdown report
  const lines: string[] = [];
  lines.push(`# Chain Spread Distribution — ${startedAt.toISOString()}`);
  lines.push("");
  lines.push(`**Spot:** \$${spot.toFixed(0)}`);
  lines.push(`**UTC hour:** ${startedAt.getUTCHours()}:00 (${startedAt.getUTCHours() < 8 || startedAt.getUTCHours() >= 21 ? "ASIA" : startedAt.getUTCHours() < 13 ? "EU" : "US"} session)`);
  lines.push(`**Instruments parsed:** ${parsed.length}`);
  lines.push("");
  lines.push(`## Spread % by tenor × moneyness × option type`);
  lines.push("");
  lines.push(`Median spread (% of mid). High values = wide quotes = hard to execute at fair price.`);
  lines.push(`Healthy options markets: ATM 3-10%, near-OTM 10-20%, ITM 20-50% (because ITM mid is dominated by intrinsic so % is naturally larger).`);
  lines.push(`Pathological: anything > 60% means MMs are not actively quoting.`);
  lines.push("");
  lines.push(`| Tenor | Moneyness | Type | N | Median spread % | Mean spread % | Mean IV % |`);
  lines.push(`|---|---|---|---:|---:|---:|---:|`);
  for (const b of sorted) {
    lines.push(`| ${b.tenor} | ${b.money} | ${b.optType} | ${b.n} | ${(b.medianSpreadPct*100).toFixed(1)}% | ${(b.meanSpreadPct*100).toFixed(1)}% | ${b.meanIv.toFixed(1)}% |`);
  }
  lines.push("");

  lines.push(`## Interpretation guide`);
  lines.push("");
  lines.push(`- If ITM spreads at THIS hour are universally 60%+ across tenors and option types → market structure issue (low liquidity in Asian session, MMs sleeping)`);
  lines.push(`- If ITM spreads are high but OTM spreads are tight → expected behaviour, V3 ITM is inherently expensive at any hour`);
  lines.push(`- If short-tenor (0-12h, 12-24h) spreads >> longer-tenor → expected (short-dated = high gamma, MMs widen)`);
  lines.push(`- If 3d / 3-7d ITM spreads are 30-60% → V3 cell sweeps should use ITM only when ATM IV is rich enough to overcome`);
  lines.push("");
  lines.push(`## Recommended cross-checks`);
  lines.push("");
  lines.push(`1. Re-run this script at 14:00 UTC (US open) — see if ITM spreads tighten`);
  lines.push(`2. Re-run at 18:00 UTC (EU-US overlap, peak liquidity)`);
  lines.push(`3. Compare ITM spreads at all three times. If they drop from 90% → 30% in US session → ITM is tradable, just not in Asian session.`);
  lines.push("");
  lines.push(`---`);
  lines.push(`*Generated by services/api/scripts/backtest/singleSide/probeChainSpreadDistribution.ts*`);

  const outPath = path.resolve(process.cwd(), "../..", `docs/PHASE_1_CHAIN_SPREAD_DISTRIBUTION_${new Date().toISOString().slice(0, 10)}.md`);
  await fs.writeFile(outPath, lines.join("\n"));
  console.log(`\n✓ Report: ${outPath}`);

  // Append to history JSONL for cross-time comparison
  const histPath = "/tmp/spread_distribution_history.jsonl";
  const histEntry = {
    runAt: startedAt.toISOString(),
    utcHour: startedAt.getUTCHours(),
    spot,
    buckets: sorted.map((b) => ({ tenor: b.tenor, money: b.money, optType: b.optType, n: b.n, medianSpreadPct: b.medianSpreadPct, meanSpreadPct: b.meanSpreadPct, meanIv: b.meanIv }))
  };
  await fs.appendFile(histPath, JSON.stringify(histEntry) + "\n");
  console.log(`Appended to ${histPath} for time-of-day comparison.`);
};

import { fileURLToPath } from "node:url";
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
