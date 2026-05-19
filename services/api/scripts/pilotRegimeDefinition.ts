/**
 * Atticus Regime Definition: Principled, Non-Arbitrary Regime Boundaries
 *
 * Three approaches compared:
 * 1. Deribit DVOL (BTC Volatility Index) — the "BTC VIX", industry standard
 * 2. Historical realized vol percentiles — data-driven cutoffs
 * 3. Hedge-cost-based — switch when our actual hedge cost crosses a threshold
 *
 * Run: npx tsx services/api/scripts/pilotRegimeDefinition.ts
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const RF = 0.05;
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════════════
// Math
// ═══════════════════════════════════════════════════════════════════════════

function nCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
    a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

function bsPut(S: number, K: number, T: number, r: number, sigma: number): number {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return Math.max(0, K - S);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return K * Math.exp(-r * T) * nCDF(-d2) - S * nCDF(-d1);
}

function realizedVol(closes: number[], endIdx: number, window: number): number {
  const start = Math.max(0, endIdx - window);
  if (endIdx - start < 5) return 0;
  const rets: number[] = [];
  for (let i = start + 1; i <= endIdx; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (rets.length < 5) return 0;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance * 365);
}

// ═══════════════════════════════════════════════════════════════════════════
// Data
// ═══════════════════════════════════════════════════════════════════════════

async function fetchBTCPrices(startDate: string, endDate: string): Promise<{ date: string; close: number }[]> {
  const all = new Map<string, number>();
  let curMs = new Date(startDate).getTime();
  const endMs = new Date(endDate).getTime();
  while (curMs < endMs) {
    const chunkEndMs = Math.min(curMs + 300 * 86400000, endMs);
    const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400&start=${new Date(curMs).toISOString()}&end=${new Date(chunkEndMs).toISOString()}`;
    let retries = 4;
    while (retries-- > 0) {
      try {
        const res = await fetch(url);
        if (res.status === 429) { await delay(3000); continue; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const candles = (await res.json()) as number[][];
        for (const [ts, , , , close] of candles) all.set(new Date(ts * 1000).toISOString().slice(0, 10), close);
        break;
      } catch (e: any) { if (retries <= 0) throw e; await delay(2000); }
    }
    curMs = chunkEndMs; await delay(500);
  }
  return Array.from(all.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([d, c]) => ({ date: d, close: c }));
}

async function fetchDVOL(): Promise<{ current: number | null; history: { ts: number; dvol: number }[] }> {
  const baseUrl = "https://www.deribit.com/api/v2";
  let current: number | null = null;
  const history: { ts: number; dvol: number }[] = [];

  // Current DVOL
  try {
    const res = await fetch(`${baseUrl}/public/get_volatility_index_data?currency=BTC&resolution=3600&start_timestamp=${Date.now() - 3600000}&end_timestamp=${Date.now()}`);
    if (res.ok) {
      const data = (await res.json()) as any;
      const points = data?.result?.data || [];
      if (points.length > 0) {
        const last = points[points.length - 1];
        current = last[1] || last.close || null; // [timestamp, open, high, low, close]
      }
    }
  } catch { /* DVOL current unavailable */ }

  // Historical DVOL — last 2 years
  try {
    const now = Date.now();
    const twoYearsAgo = now - 730 * 86400000;
    // Fetch in chunks (daily resolution)
    let cursor = twoYearsAgo;
    while (cursor < now) {
      const chunkEnd = Math.min(cursor + 90 * 86400000, now);
      try {
        await delay(200);
        const res = await fetch(`${baseUrl}/public/get_volatility_index_data?currency=BTC&resolution=86400000&start_timestamp=${Math.floor(cursor)}&end_timestamp=${Math.floor(chunkEnd)}`);
        if (res.ok) {
          const data = (await res.json()) as any;
          const points = data?.result?.data || [];
          for (const p of points) {
            const ts = p[0];
            const close = p[4] ?? p[1]; // [ts, open, high, low, close]
            if (ts && close && close > 0) history.push({ ts, dvol: close });
          }
        }
      } catch { /* skip chunk */ }
      cursor = chunkEnd;
    }
  } catch { /* DVOL history unavailable */ }

  return { current, history };
}

// ═══════════════════════════════════════════════════════════════════════════
// Analysis
// ═══════════════════════════════════════════════════════════════════════════

function percentile(sorted: number[], p: number): number {
  const idx = Math.floor(p * (sorted.length - 1));
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

// ═══════════════════════════════════════════════════════════════════════════
// Formatting
// ═══════════════════════════════════════════════════════════════════════════

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const pct0 = (n: number) => `${Math.round(n * 100)}%`;
const $ = (n: number, d = 2) => `$${n.toFixed(d)}`;
const $0 = (n: number) => `$${Math.round(n)}`;
const pad = (s: string, w: number) => s.padStart(w);
const padE = (s: string, w: number) => s.padEnd(w);
const hdr = (t: string) => "\n" + "═".repeat(95) + "\n  " + t + "\n" + "═".repeat(95);

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const L: string[] = [];
  const log = (s: string) => { L.push(s); };

  log("═".repeat(95));
  log("  ATTICUS REGIME DEFINITION: Principled Regime Boundaries for CEO");
  log("  " + new Date().toISOString());
  log("═".repeat(95));

  // Fetch data
  console.log("  Fetching BTC prices (2022-2026)...");
  const prices = await fetchBTCPrices("2022-01-01", "2026-04-08");
  const closes = prices.map(p => p.close);
  const dates = prices.map(p => p.date);

  console.log("  Fetching Deribit DVOL (BTC Volatility Index)...");
  const dvol = await fetchDVOL();

  // Compute daily 30-day realized vol for every day
  const dailyVols: { date: string; vol: number }[] = [];
  for (let i = 30; i < closes.length; i++) {
    const v = realizedVol(closes, i, 30);
    if (v > 0) dailyVols.push({ date: dates[i], vol: v });
  }

  const sortedVols = dailyVols.map(d => d.vol).sort((a, b) => a - b);
  const currentVol = dailyVols[dailyVols.length - 1]?.vol || 0;

  log(`\n  ${prices.length} days of BTC data | ${dailyVols.length} daily vol observations`);
  log(`  Current 30d realized vol: ${pct(currentVol)}`);
  if (dvol.current) log(`  Current Deribit DVOL: ${dvol.current.toFixed(1)}%`);
  log(`  DVOL history: ${dvol.history.length} daily observations`);

  // ═══════════════════════════════════════════════════════════════
  // Section 1: Historical vol distribution
  // ═══════════════════════════════════════════════════════════════
  log(hdr("SECTION 1: HISTORICAL VOL DISTRIBUTION (2022-2026)"));
  log("  30-day realized volatility, annualized.\n");

  const p10 = percentile(sortedVols, 0.10);
  const p20 = percentile(sortedVols, 0.20);
  const p25 = percentile(sortedVols, 0.25);
  const p30 = percentile(sortedVols, 0.30);
  const p40 = percentile(sortedVols, 0.40);
  const p50 = percentile(sortedVols, 0.50);
  const p60 = percentile(sortedVols, 0.60);
  const p70 = percentile(sortedVols, 0.70);
  const p75 = percentile(sortedVols, 0.75);
  const p80 = percentile(sortedVols, 0.80);
  const p90 = percentile(sortedVols, 0.90);
  const p95 = percentile(sortedVols, 0.95);

  log("  Percentile | 30d RVol | What it means");
  log("  -----------|---------|-------------");
  log(`  10th       | ${pad(pct(p10), 6)} | Very calm — low activity`);
  log(`  20th       | ${pad(pct(p20), 6)} | Calm`);
  log(`  25th       | ${pad(pct(p25), 6)} | Below average`);
  log(`  30th       | ${pad(pct(p30), 6)} | ← CALM/NORMAL boundary (30th percentile)`);
  log(`  40th       | ${pad(pct(p40), 6)} | `);
  log(`  50th       | ${pad(pct(p50), 6)} | Median — typical market`);
  log(`  60th       | ${pad(pct(p60), 6)} | `);
  log(`  70th       | ${pad(pct(p70), 6)} | Above average`);
  log(`  75th       | ${pad(pct(p75), 6)} | `);
  log(`  80th       | ${pad(pct(p80), 6)} | ← NORMAL/STRESS boundary (80th percentile)`);
  log(`  90th       | ${pad(pct(p90), 6)} | High vol`);
  log(`  95th       | ${pad(pct(p95), 6)} | Extreme stress`);
  log(`\n  Min: ${pct(sortedVols[0])} | Max: ${pct(sortedVols[sortedVols.length - 1])} | Current: ${pct(currentVol)} (${pct0(dailyVols.filter(d => d.vol <= currentVol).length / dailyVols.length)}ile)`);

  // ═══════════════════════════════════════════════════════════════
  // Section 2: DVOL analysis
  // ═══════════════════════════════════════════════════════════════
  log(hdr("SECTION 2: DERIBIT DVOL — THE OFFICIAL BTC VOLATILITY INDEX"));
  log("");
  log("  The Deribit DVOL is to Bitcoin what the VIX is to the S&P 500.");
  log("  It's calculated from live BTC options prices on Deribit and represents");
  log("  the market's 30-day forward-looking implied volatility.");
  log("");
  log("  Why DVOL is the right benchmark:");
  log("  • Published by Deribit — our primary hedge venue");
  log("  • Derived from options prices — directly reflects our hedge costs");
  log("  • Forward-looking — captures what the market EXPECTS, not what happened");
  log("  • Real-time — updates continuously, no lag");
  log("  • Industry standard — used by every institutional crypto desk");
  log("  • Publicly auditable — anyone can verify the number");

  if (dvol.history.length > 0) {
    const sortedDvol = dvol.history.map(h => h.dvol).sort((a, b) => a - b);
    const dP30 = percentile(sortedDvol, 0.30);
    const dP50 = percentile(sortedDvol, 0.50);
    const dP80 = percentile(sortedDvol, 0.80);
    const dP90 = percentile(sortedDvol, 0.90);
    const dMin = sortedDvol[0];
    const dMax = sortedDvol[sortedDvol.length - 1];

    log(`\n  DVOL Historical Distribution (${dvol.history.length} days):\n`);
    log("  Percentile | DVOL");
    log("  -----------|-----");
    for (const [pctLabel, pctVal] of [["10th", 0.10], ["20th", 0.20], ["30th", 0.30], ["40th", 0.40], ["50th", 0.50], ["60th", 0.60], ["70th", 0.70], ["80th", 0.80], ["90th", 0.90], ["95th", 0.95]] as [string, number][]) {
      const val = percentile(sortedDvol, pctVal);
      const marker = pctVal === 0.30 ? " ← CALM/NORMAL" : pctVal === 0.80 ? " ← NORMAL/STRESS" : "";
      log(`  ${padE(pctLabel, 11)}| ${pad(val.toFixed(1) + "%", 6)}${marker}`);
    }
    log(`\n  Min: ${dMin.toFixed(1)}% | Max: ${dMax.toFixed(1)}% | Current: ${dvol.current ? dvol.current.toFixed(1) + "%" : "N/A"}`);

    // ═══════════════════════════════════════════════════════════════
    // Section 3: Recommended regime definition
    // ═══════════════════════════════════════════════════════════════
    log(hdr("SECTION 3: RECOMMENDED REGIME DEFINITION"));
    log("");
    log("  ╔═══════════════════════════════════════════════════════════════════════════════╗");
    log("  ║                    ATTICUS REGIME CLASSIFICATION                             ║");
    log("  ╠═══════════════════════════════════════════════════════════════════════════════╣");
    log("  ║                                                                             ║");
    log(`  ║  PRIMARY SIGNAL: Deribit DVOL (BTC Volatility Index)                        ║`);
    log(`  ║  SECONDARY SIGNAL: 30-day realized volatility (confirmation)                ║`);
    log("  ║                                                                             ║");
    log(`  ║  CALM     DVOL < ${dP30.toFixed(0)}%     (bottom 30% of historical readings)       ║`);
    log(`  ║  NORMAL   DVOL ${dP30.toFixed(0)}% – ${dP80.toFixed(0)}%  (middle 50%)                              ║`);
    log(`  ║  STRESS   DVOL > ${dP80.toFixed(0)}%     (top 20% of historical readings)          ║`);
    log("  ║                                                                             ║");
    log("  ╚═══════════════════════════════════════════════════════════════════════════════╝");
    log("");

    // Compute exact % of time in each regime using DVOL
    const calmDays = dvol.history.filter(h => h.dvol < dP30).length;
    const normalDays = dvol.history.filter(h => h.dvol >= dP30 && h.dvol <= dP80).length;
    const stressDays = dvol.history.filter(h => h.dvol > dP80).length;
    const totalDays = dvol.history.length;

    log("  REGIME BREAKDOWN:\n");
    log(`  Regime  | DVOL Range       | % of Time | Days in Data | Premium Level      | Action`);
    log(`  --------|------------------|-----------|-------------|--------------------|---------`);
    log(`  CALM    | Below ${dP30.toFixed(0)}%        | ${pad(pct0(calmDays / totalDays), 9)} | ${pad(String(calmDays), 11)} | Lowest             | Sell protection`);
    log(`  NORMAL  | ${dP30.toFixed(0)}% to ${dP80.toFixed(0)}%       | ${pad(pct0(normalDays / totalDays), 9)} | ${pad(String(normalDays), 11)} | Standard           | Sell protection`);
    log(`  STRESS  | Above ${dP80.toFixed(0)}%        | ${pad(pct0(stressDays / totalDays), 9)} | ${pad(String(stressDays), 11)} | Highest or PAUSE   | Sell at premium or pause`);

    // Current status
    log(`\n  CURRENT STATUS:`);
    log(`  DVOL: ${dvol.current ? dvol.current.toFixed(1) + "%" : "N/A"} → ${dvol.current ? (dvol.current < dP30 ? "CALM" : dvol.current <= dP80 ? "NORMAL" : "STRESS") : "Unknown"}`);
    log(`  30d RVol: ${pct(currentVol)} → ${currentVol < p30 ? "CALM" : currentVol <= p80 ? "NORMAL" : "STRESS"} (confirmation)`);

    // Cross-reference: DVOL vs realized vol
    log(hdr("SECTION 4: DVOL vs REALIZED VOL — Do they agree?"));
    log("  Checking if DVOL and 30d realized vol classify regimes consistently.\n");

    // Match DVOL dates to our price data dates
    let agreeCount = 0, disagreeCount = 0;
    const disagreements: { date: string; dvol: number; rvol: number; dvolRegime: string; rvolRegime: string }[] = [];

    for (const dh of dvol.history) {
      const dDate = new Date(dh.ts).toISOString().slice(0, 10);
      const priceIdx = dates.indexOf(dDate);
      if (priceIdx < 30) continue;
      const rv = realizedVol(closes, priceIdx, 30);
      if (rv <= 0) continue;

      const dvolRegime = dh.dvol < dP30 ? "CALM" : dh.dvol <= dP80 ? "NORMAL" : "STRESS";
      const rvolRegime = rv < p30 ? "CALM" : rv <= p80 ? "NORMAL" : "STRESS";

      if (dvolRegime === rvolRegime) agreeCount++;
      else {
        disagreeCount++;
        if (disagreements.length < 5) disagreements.push({ date: dDate, dvol: dh.dvol, rvol: rv, dvolRegime, rvolRegime });
      }
    }

    const total = agreeCount + disagreeCount;
    log(`  Agreement rate: ${pct0(agreeCount / (total || 1))} (${agreeCount}/${total} days)`);
    log(`  Disagreements: ${disagreeCount} days\n`);

    if (disagreements.length > 0) {
      log("  Sample disagreements (DVOL vs RVol):");
      log("  Date       | DVOL   | RVol   | DVOL says | RVol says");
      log("  -----------|--------|--------|-----------|----------");
      for (const d of disagreements) {
        log(`  ${d.date} | ${pad(d.dvol.toFixed(1) + "%", 6)} | ${pad(pct(d.rvol), 6)} | ${padE(d.dvolRegime, 9)} | ${d.rvolRegime}`);
      }
      log("");
    }

    log("  RECOMMENDATION: Use DVOL as primary signal. When DVOL and RVol disagree,");
    log("  default to the MORE CONSERVATIVE classification (i.e., the higher regime).");
    log("  This protects the treasury from being caught in the wrong regime.");

    // ═══════════════════════════════════════════════════════════════
    // Section 5: Hedge-cost-based alternative
    // ═══════════════════════════════════════════════════════════════
    log(hdr("SECTION 5: ALTERNATIVE — HEDGE-COST-BASED REGIME (Smartest Approach)"));
    log("");
    log("  Instead of using a vol index, switch regimes based on what we actually PAY");
    log("  for the hedge option. This is the most direct signal.\n");

    // Compute hedge costs at different vol levels for 5% SL (representative)
    const spot = closes[closes.length - 1];
    const K5 = spot * 0.95;
    const qty = 1000 / spot;
    const T = 2 / 365;

    log("  For 5% SL, 2-day put at trigger strike:\n");
    log("  Vol Level | Hedge/$1k | Hedge/$10k | Regime");
    log("  ----------|-----------|------------|------");
    for (const vol of [0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.70, 0.80, 0.90, 1.00]) {
      const hedgePer1k = bsPut(spot, K5, T, RF, vol) * qty;
      const regime = vol <= 0.45 ? "CALM" : vol <= 0.65 ? "NORMAL" : "STRESS";
      log(`  ${pad(pct(vol), 9)} | ${pad($(hedgePer1k), 9)} | ${pad($0(hedgePer1k * 10), 10)} | ${regime}`);
    }

    log("\n  HEDGE-COST REGIME DEFINITION:\n");
    log("  Instead of monitoring vol, monitor the Deribit ask price for our hedge put.");
    log("  When the ask goes above a threshold, automatically adjust premium tier.\n");
    log("  SL%  | CALM if hedge <   | NORMAL if hedge    | STRESS if hedge >");
    log("  -----|-------------------|--------------------|------------------");

    for (const sl of [1, 2, 3, 5, 10]) {
      const K = spot * (1 - sl / 100);
      const calmH = bsPut(spot, K, T, RF, 0.40) * qty;
      const normalH = bsPut(spot, K, T, RF, 0.60) * qty;
      log(`  ${pad(sl + "%", 4)} | ${pad($(calmH), 9)}/1k       | ${$(calmH)}-${$(normalH)}/1k  | ${pad($(normalH), 9)}/1k`);
    }

    log("\n  This approach is SELF-CALIBRATING:");
    log("  • No need to compute vol or check DVOL — just look at the hedge price");
    log("  • Automatically accounts for IV skew, liquidity, and market conditions");
    log("  • Can be implemented as a simple price check before each protection sale");

    // ═══════════════════════════════════════════════════════════════
    // Section 6: CEO-ready card
    // ═══════════════════════════════════════════════════════════════
    log(hdr("SECTION 6: CEO-READY REGIME CARD"));
    log("");
    log("  ┌─────────────────────────────────────────────────────────────────────────┐");
    log("  │                    ATTICUS PROTECTION — PRICING TIERS                   │");
    log("  ├─────────────────────────────────────────────────────────────────────────┤");
    log("  │                                                                         │");
    log(`  │  We use the Deribit DVOL (BTC Volatility Index) to set pricing.         │`);
    log("  │  DVOL is the industry-standard measure of BTC options volatility,       │");
    log("  │  published in real-time by Deribit (our hedge venue).                   │");
    log("  │                                                                         │");
    log(`  │  ┌──────────┬──────────────────┬─────────────────────────────────────┐  │`);
    log(`  │  │ REGIME   │ DVOL LEVEL       │ WHAT IT MEANS                       │  │`);
    log(`  │  ├──────────┼──────────────────┼─────────────────────────────────────┤  │`);
    log(`  │  │ 🟢 CALM  │ Below ${dP30.toFixed(0)}%        │ Market is quiet. Options are cheap.  │  │`);
    log(`  │  │          │                  │ Lowest premiums. Best trader value.  │  │`);
    log(`  │  ├──────────┼──────────────────┼─────────────────────────────────────┤  │`);
    log(`  │  │ 🟡 NORMAL│ ${dP30.toFixed(0)}% to ${dP80.toFixed(0)}%       │ Typical market conditions.           │  │`);
    log(`  │  │          │                  │ Standard premiums. Good margins.    │  │`);
    log(`  │  ├──────────┼──────────────────┼─────────────────────────────────────┤  │`);
    log(`  │  │ 🔴 STRESS│ Above ${dP80.toFixed(0)}%        │ High volatility. Hedging is costly.  │  │`);
    log(`  │  │          │                  │ Higher premiums. 1% SL paused.      │  │`);
    log(`  │  └──────────┴──────────────────┴─────────────────────────────────────┘  │`);
    log("  │                                                                         │");
    log(`  │  Current DVOL: ${dvol.current ? dvol.current.toFixed(1) + "%" : "N/A"}  →  ${dvol.current ? (dvol.current < dP30 ? "🟢 CALM" : dvol.current <= dP80 ? "🟡 NORMAL" : "🔴 STRESS") : "Unknown"}                                      │`);
    log("  │                                                                         │");
    log("  │  The DVOL cutoffs are based on the 30th and 80th percentiles            │");
    log("  │  of historical DVOL data. This is not arbitrary — it means:             │");
    log("  │  • CALM = cheaper than 70% of historical options pricing                │");
    log("  │  • STRESS = more expensive than 80% of historical options pricing       │");
    log("  │                                                                         │");
    log("  │  The DVOL is publicly visible at deribit.com/statistics/BTC/volatility   │");
    log("  │  and via API at api.deribit.com. Anyone can verify the current reading.  │");
    log("  └─────────────────────────────────────────────────────────────────────────┘");
    log("");

    // Final pricing card with DVOL boundaries
    log("  PRICING WITH DVOL BOUNDARIES:\n");
    log(`  SL%  | 🟢 CALM (<${dP30.toFixed(0)}%)    | 🟡 NORMAL (${dP30.toFixed(0)}-${dP80.toFixed(0)}%) | 🔴 STRESS (>${dP80.toFixed(0)}%)  | Payout/$10k`);
    log(`  -----|-------------------|-----------------------|----------------------|-----------`);

    const v7Pricing = [
      { sl: 1, calm: 5, normal: 9, stress: null as number | null },
      { sl: 2, calm: 3, normal: 6, stress: 13 },
      { sl: 3, calm: 2, normal: 5, stress: 12 },
      { sl: 5, calm: 2, normal: 4, stress: 10 },
      { sl: 10, calm: 1, normal: 2, stress: 6 },
    ];

    for (const p of v7Pricing) {
      const cL = `$${p.calm}/1k ($${p.calm * 10}/10k)`;
      const nL = `$${p.normal}/1k ($${p.normal * 10}/10k)`;
      const sL = p.stress !== null ? `$${p.stress}/1k ($${p.stress * 10}/10k)` : "PAUSED";
      log(`  ${pad(p.sl + "%", 4)} | ${padE(cL, 17)} | ${padE(nL, 21)} | ${padE(sL, 20)} | $${p.sl * 100}`);
    }

  } else {
    log("\n  DVOL historical data not available. Using realized vol percentiles only.\n");

    log("  REGIME DEFINITION (Realized Vol Based):\n");
    log(`  CALM:   30d RVol < ${pct(p30)}  (bottom 30th percentile)`);
    log(`  NORMAL: 30d RVol ${pct(p30)} – ${pct(p80)}  (middle 50%)`);
    log(`  STRESS: 30d RVol > ${pct(p80)}  (top 20th percentile)`);
  }

  log(hdr("RECOMMENDATION"));
  log("");
  log("  USE DVOL AS THE PRIMARY REGIME SIGNAL because:");
  log("  1. It's forward-looking (reflects what hedging WILL cost, not what it cost)");
  log("  2. It's published by our hedge venue (Deribit)");
  log("  3. It's an industry standard (institutional credibility)");
  log("  4. It's publicly verifiable (transparency)");
  log("  5. The percentile-based cutoffs are data-driven, not arbitrary");
  log("");
  log("  IMPLEMENTATION:");
  log("  • Check DVOL via Deribit API before each protection sale");
  log("  • If DVOL < calm threshold: charge CALM premium");
  log("  • If DVOL > stress threshold: charge STRESS premium (or pause 1% SL)");
  log("  • Log the DVOL reading with each trade for audit trail");
  log("  • Review and recalibrate percentile thresholds quarterly");

  // Write
  const fullOutput = L.join("\n");
  const outDir = path.resolve("docs/pilot-reports");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "regime_definition.txt");
  await writeFile(outPath, fullOutput, "utf8");
  console.log(fullOutput);
  console.log(`\n  Results written to: ${outPath}`);
}

main().catch(e => { console.error("Fatal:", e.message || e); process.exit(1); });
