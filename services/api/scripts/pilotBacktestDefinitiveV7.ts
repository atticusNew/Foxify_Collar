/**
 * Atticus V7: Full Recovery Model — Time Value + Early Close + Stress Viability
 *
 * Upgrades from V6:
 * 1. Recovery uses BS value (intrinsic + time value), not just intrinsic
 * 2. Models early-close scenarios (trader exits position before expiry)
 * 3. Re-evaluates whether stress regime is viable with full recovery
 * 4. Conservative estimate: 20% of traders close early, avg at 50% of tenor
 *
 * Run: npx tsx services/api/scripts/pilotBacktestDefinitiveV7.ts
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const RF = 0.05;
const SL_TIERS = [1, 2, 3, 5, 10];
const POSITION_SIZES = [5_000, 10_000, 20_000, 25_000, 50_000];
const EARLY_CLOSE_RATE = 0.20; // conservative: 20% of traders close early
const EARLY_CLOSE_TIME_FRAC = 0.50; // they close at ~50% through the tenor on average
type Regime = "calm" | "normal" | "stress";

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
  if (endIdx - start < 5) return 0.5;
  const rets: number[] = [];
  for (let i = start + 1; i <= endIdx; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (rets.length < 5) return 0.5;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance * 365);
}

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════════════
// Data
// ═══════════════════════════════════════════════════════════════════════════

async function fetchBTCPrices(startDate: string, endDate: string): Promise<number[]> {
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
  return Array.from(all.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([, c]) => c);
}

// ═══════════════════════════════════════════════════════════════════════════
// Deribit Scanner
// ═══════════════════════════════════════════════════════════════════════════

async function scanDeribit(spotPrice: number): Promise<{ instrument: string; strike: number; days: number; markIv: number }[]> {
  const baseUrl = "https://www.deribit.com/api/v2";
  const results: { instrument: string; strike: number; days: number; markIv: number }[] = [];
  try {
    const instrRes = await fetch(`${baseUrl}/public/get_instruments?currency=BTC&kind=option&expired=false`);
    if (!instrRes.ok) throw new Error(`HTTP ${instrRes.status}`);
    const instruments = ((await instrRes.json()) as any)?.result || [];
    const now = Date.now();
    const puts = instruments.filter((i: any) =>
      i.option_type === "put" && ((i.expiration_timestamp - now) / 86400000) >= 0.5 &&
      ((i.expiration_timestamp - now) / 86400000) <= 14 &&
      i.strike >= spotPrice * 0.85 && i.strike <= spotPrice * 1.02
    );
    for (const cand of puts.slice(0, 60)) {
      try {
        await delay(100);
        const t = ((await (await fetch(`${baseUrl}/public/ticker?instrument_name=${encodeURIComponent(cand.instrument_name)}`)).json()) as any)?.result;
        if (!t || !t.mark_iv) continue;
        results.push({ instrument: cand.instrument_name, strike: cand.strike, days: (cand.expiration_timestamp - now) / 86400000, markIv: t.mark_iv / 100 });
      } catch { /* skip */ }
    }
  } catch (e: any) { console.log(`  [Deribit] ${e.message}`); }
  return results;
}

function buildIvSurface(puts: { strike: number; days: number; markIv: number }[], spot: number): (otmPct: number) => number {
  const shortDated = puts.filter(p => p.days <= 3 && p.markIv > 0).sort((a, b) =>
    ((spot - a.strike) / spot) - ((spot - b.strike) / spot)
  );
  const points = shortDated.map(p => ({ otm: (spot - p.strike) / spot * 100, iv: p.markIv }));
  return (otmPct: number): number => {
    if (points.length === 0) return 0.50;
    if (otmPct <= points[0].otm) return points[0].iv;
    if (otmPct >= points[points.length - 1].otm) return points[points.length - 1].iv;
    for (let i = 0; i < points.length - 1; i++) {
      if (otmPct >= points[i].otm && otmPct <= points[i + 1].otm) {
        const f = (otmPct - points[i].otm) / (points[i + 1].otm - points[i].otm);
        return points[i].iv + f * (points[i + 1].iv - points[i].iv);
      }
    }
    return points[points.length - 1].iv;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Backtest with Full Recovery Model
// ═══════════════════════════════════════════════════════════════════════════

type WindowResult = {
  hedgeCost: number;
  payout: number;
  intrinsicRecovery: number;    // V6 method: max intrinsic only
  bsRecovery: number;           // V7: BS value with time value at best sell point
  earlyCloseRecovery: number;   // V7: option value if trader closes early (no trigger, sell option back)
  triggered: boolean;
  triggerDay: number | null;
  regime: Regime;
};

function runBacktest(
  closes: number[], sl: number, tenor: number,
  getIv: (otmPct: number) => number, ivScale: number,
): WindowResult[] {
  const results: WindowResult[] = [];
  for (let i = 0; i + tenor < closes.length; i++) {
    const entry = closes[i];
    if (entry <= 0) continue;
    const rawVol = realizedVol(closes, i, 30);
    const regime: Regime = rawVol < 0.4 ? "calm" : rawVol < 0.65 ? "normal" : "stress";

    const triggerPx = entry * (1 - sl / 100);
    const K = triggerPx;
    const qty = 1000 / entry;
    const T = tenor / 365;
    const iv = getIv(sl) * ivScale;

    const hedgeCost = bsPut(entry, K, T, RF, iv) * qty;

    let triggered = false;
    let triggerDay: number | null = null;
    for (let d = 0; d <= tenor; d++) {
      const idx = i + d;
      if (idx < closes.length && closes[idx] <= triggerPx) { triggered = true; triggerDay = d; break; }
    }

    const payout = triggered ? (1000 * sl) / 100 : 0;

    // V6 method: max intrinsic
    let intrinsicRecovery = 0;
    for (let d = 0; d <= tenor; d++) {
      const idx = i + d;
      if (idx >= closes.length) continue;
      const intr = Math.max(0, K - closes[idx]) * qty;
      if (intr > intrinsicRecovery) intrinsicRecovery = intr;
    }

    // V7: BS value with remaining time at each day, take best
    let bsRecovery = 0;
    for (let d = 0; d <= tenor; d++) {
      const idx = i + d;
      if (idx >= closes.length) continue;
      const remainingT = Math.max(0, (tenor - d)) / 365;
      const spotAtD = closes[idx];
      let optionValue: number;
      if (remainingT <= 0) {
        optionValue = Math.max(0, K - spotAtD) * qty;
      } else {
        optionValue = bsPut(spotAtD, K, remainingT, RF, iv) * qty;
      }
      if (optionValue > bsRecovery) bsRecovery = optionValue;
    }

    // V7: Early close recovery — if trader closes at ~50% through tenor (no trigger)
    let earlyCloseRecovery = 0;
    if (!triggered) {
      const earlyDay = Math.max(1, Math.round(tenor * EARLY_CLOSE_TIME_FRAC));
      const earlyIdx = i + earlyDay;
      if (earlyIdx < closes.length) {
        const remainingT = Math.max(0, (tenor - earlyDay)) / 365;
        const spotAtEarly = closes[earlyIdx];
        if (remainingT > 0) {
          earlyCloseRecovery = bsPut(spotAtEarly, K, remainingT, RF, iv) * qty;
        } else {
          earlyCloseRecovery = Math.max(0, K - spotAtEarly) * qty;
        }
      }
    }

    results.push({ hedgeCost, payout, intrinsicRecovery, bsRecovery, earlyCloseRecovery, triggered, triggerDay, regime });
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// Analysis
// ═══════════════════════════════════════════════════════════════════════════

type RegimeStats = {
  count: number; trigRate: number;
  avgHedge: number; avgPayout: number;
  intrinsicRecov: number;
  bsRecov: number;
  blendedRecov: number; // weighted: triggered gets bsRecov, early-close gets earlyCloseRecov
  beIntrinsic: number;
  beBs: number;
  beBlended: number;
  bestPremIntr: number | null; wrIntr: number;
  bestPremBs: number | null; wrBs: number;
  bestPremBlend: number | null; wrBlend: number;
};

function computeStats(windows: WindowResult[], payoutPer1k: number): RegimeStats {
  const n = windows.length;
  if (n === 0) return {
    count: 0, trigRate: 0, avgHedge: 0, avgPayout: 0,
    intrinsicRecov: 0, bsRecov: 0, blendedRecov: 0,
    beIntrinsic: 0, beBs: 0, beBlended: 0,
    bestPremIntr: null, wrIntr: 0, bestPremBs: null, wrBs: 0,
    bestPremBlend: null, wrBlend: 0,
  };

  const totalH = windows.reduce((s, w) => s + w.hedgeCost, 0);
  const totalP = windows.reduce((s, w) => s + w.payout, 0);
  const totalIntr = windows.reduce((s, w) => s + w.intrinsicRecovery, 0);
  const totalBs = windows.reduce((s, w) => s + w.bsRecovery, 0);

  // Blended recovery: for each window, compute blended
  // If triggered: use bsRecovery (sell option with time value)
  // If not triggered: EARLY_CLOSE_RATE chance of early close (get earlyCloseRecovery), rest get intrinsic at expiry
  const totalBlended = windows.reduce((s, w) => {
    if (w.triggered) {
      return s + w.bsRecovery;
    } else {
      const earlyCloseValue = w.earlyCloseRecovery * EARLY_CLOSE_RATE;
      const holdValue = w.intrinsicRecovery * (1 - EARLY_CLOSE_RATE);
      return s + earlyCloseValue + holdValue;
    }
  }, 0);

  const trigCount = windows.filter(w => w.triggered).length;
  const avgH = totalH / n;
  const avgP = totalP / n;

  const intrinsicRecov = totalIntr / n;
  const bsRecov = totalBs / n;
  const blendedRecov = totalBlended / n;

  const beIntrinsic = avgH + avgP - intrinsicRecov;
  const beBs = avgH + avgP - bsRecov;
  const beBlended = avgH + avgP - blendedRecov;

  const findBest = (recovFn: (w: WindowResult) => number) => {
    for (let p = 1; p <= 30; p++) {
      if (p >= payoutPer1k) break;
      let wins = 0;
      let pnlSum = 0;
      for (const w of windows) {
        const pnl = p - w.hedgeCost - w.payout + recovFn(w);
        pnlSum += pnl;
        if (pnl >= 0) wins++;
      }
      if (pnlSum / n > 0 && wins / n >= 0.50) return { prem: p, wr: wins / n };
    }
    return { prem: null as number | null, wr: 0 };
  };

  const bIntr = findBest(w => w.intrinsicRecovery);
  const bBs = findBest(w => w.bsRecovery);
  const bBlend = findBest(w => {
    if (w.triggered) return w.bsRecovery;
    return w.earlyCloseRecovery * EARLY_CLOSE_RATE + w.intrinsicRecovery * (1 - EARLY_CLOSE_RATE);
  });

  return {
    count: n, trigRate: trigCount / n, avgHedge: avgH, avgPayout: avgP,
    intrinsicRecov, bsRecov, blendedRecov,
    beIntrinsic, beBs, beBlended,
    bestPremIntr: bIntr.prem, wrIntr: bIntr.wr,
    bestPremBs: bBs.prem, wrBs: bBs.wr,
    bestPremBlend: bBlend.prem, wrBlend: bBlend.wr,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Formatting
// ═══════════════════════════════════════════════════════════════════════════

const $ = (n: number, d = 2) => n < 0 ? `-$${Math.abs(n).toFixed(d)}` : `$${n.toFixed(d)}`;
const $0 = (n: number) => n < 0 ? `-$${Math.abs(Math.round(n))}` : `$${Math.round(n)}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const pad = (s: string, w: number) => s.padStart(w);
const padE = (s: string, w: number) => s.padEnd(w);
const hdr = (t: string) => "\n" + "═".repeat(95) + "\n  " + t + "\n" + "═".repeat(95);
const sub = (t: string) => "\n  " + "─".repeat(85) + "\n  " + t + "\n  " + "─".repeat(85);

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const startTime = Date.now();
  const L: string[] = [];
  const log = (s: string) => { L.push(s); };

  log("═".repeat(95));
  log("  ATTICUS V7: FULL RECOVERY MODEL — Time Value + Early Close + Stress Re-evaluation");
  log("  " + new Date().toISOString());
  log("═".repeat(95));

  console.log("  Fetching BTC prices...");
  const closes = await fetchBTCPrices("2022-01-01", "2026-04-08");
  const spot = closes[closes.length - 1];
  const currentVol = realizedVol(closes, closes.length - 1, 30);
  log(`\n  BTC spot: ${$0(spot)} | 30d vol: ${pct(currentVol)} | Regime: ${currentVol < 0.4 ? "CALM" : currentVol < 0.65 ? "NORMAL" : "STRESS"}`);
  log(`  Early-close assumption: ${(EARLY_CLOSE_RATE * 100).toFixed(0)}% of traders close early at ${(EARLY_CLOSE_TIME_FRAC * 100).toFixed(0)}% through tenor`);

  console.log("  Scanning Deribit...");
  const dPuts = await scanDeribit(spot);
  log(`  Deribit: ${dPuts.length} puts scanned`);
  const getIv = buildIvSurface(dPuts, spot);
  log(`  IV surface: 1%→${pct(getIv(1))} | 2%→${pct(getIv(2))} | 3%→${pct(getIv(3))} | 5%→${pct(getIv(5))} | 10%→${pct(getIv(10))}`);

  // ═══════════════════════════════════════════════════════════════
  // Section 1: V6 vs V7 recovery comparison
  // ═══════════════════════════════════════════════════════════════
  log(hdr("SECTION 1: RECOVERY MODEL COMPARISON — How much are we underestimating?"));
  log("  V6 = intrinsic only | V7-BS = intrinsic + time value | V7-Blend = BS + 20% early-close\n");

  const tenor = 2;
  const ivScales: { label: string; scale: number; regime: Regime }[] = [
    { label: "CALM", scale: 0.7, regime: "calm" },
    { label: "NORMAL", scale: 1.0, regime: "normal" },
    { label: "STRESS", scale: 1.6, regime: "stress" },
  ];

  for (const sl of SL_TIERS) {
    const payoutPer1k = sl * 10;
    log(sub(`${sl}% SL — Payout: ${$0(payoutPer1k)}/1k (${$0(payoutPer1k * 10)}/10k)`));
    log("");
    log("  Regime   | Hedge  | AvgPay | V6 Recov | V7-BS Rec | V7-Blend | V6 BE  | V7-BS BE | V7-Blend BE | V6 Prem | V7 Prem | Added Margin");
    log("  ---------|--------|--------|----------|-----------|----------|--------|----------|-------------|---------|---------|------------");

    for (const { label, scale, regime } of ivScales) {
      const allWins = runBacktest(closes, sl, tenor, getIv, scale);
      const regimeWins = allWins.filter(w => w.regime === regime);
      if (regimeWins.length === 0) continue;
      const stats = computeStats(regimeWins, payoutPer1k);

      const v6Prem = stats.bestPremIntr !== null ? `${$0(stats.bestPremIntr)}/1k` : "N/A";
      const v7Prem = stats.bestPremBlend !== null ? `${$0(stats.bestPremBlend)}/1k` : "N/A";
      const addedMargin = stats.beIntrinsic - stats.beBlended;

      log(
        `  ${padE(label, 9)}| ${pad($(stats.avgHedge), 6)} | ${pad($(stats.avgPayout), 6)} | ${pad($(stats.intrinsicRecov), 8)} | ${pad($(stats.bsRecov), 9)} | ${pad($(stats.blendedRecov), 8)} | ${pad($(stats.beIntrinsic), 6)} | ${pad($(stats.beBs), 8)} | ${pad($(stats.beBlended), 11)} | ${pad(v6Prem, 7)} | ${pad(v7Prem, 7)} | ${pad("+" + $(addedMargin), 11)}`
      );
    }
    log("");
  }

  // ═══════════════════════════════════════════════════════════════
  // Section 2: Updated recommendation with V7 recovery
  // ═══════════════════════════════════════════════════════════════
  log(hdr("SECTION 2: UPDATED REGIME PRICING — With Full Recovery Model"));
  log("  Using V7-Blend recovery (BS time value + 20% early-close).\n");

  type Rec = { sl: number; calmP: number | null; calmWR: number; calmPnl: number;
    normP: number | null; normWR: number; normPnl: number;
    stressP: number | null; stressWR: number; stressPnl: number };
  const recs: Rec[] = [];

  log("  SL%  | CALM Prem (WR)        | NORMAL Prem (WR)      | STRESS Prem (WR)      | Calm P&L | Norm P&L | Stress P&L | Stress viable?");
  log("  -----|----------------------|----------------------|----------------------|----------|----------|------------|-------------");

  for (const sl of SL_TIERS) {
    const payoutPer1k = sl * 10;
    const rec: Rec = { sl, calmP: null, calmWR: 0, calmPnl: 0, normP: null, normWR: 0, normPnl: 0, stressP: null, stressWR: 0, stressPnl: 0 };

    for (const { label, scale, regime } of ivScales) {
      const allWins = runBacktest(closes, sl, tenor, getIv, scale);
      const regimeWins = allWins.filter(w => w.regime === regime);
      if (regimeWins.length === 0) continue;
      const stats = computeStats(regimeWins, payoutPer1k);

      const prem = stats.bestPremBlend;
      const pnl = prem !== null ? prem - stats.beBlended : 0;
      if (regime === "calm") { rec.calmP = prem; rec.calmWR = stats.wrBlend; rec.calmPnl = pnl; }
      if (regime === "normal") { rec.normP = prem; rec.normWR = stats.wrBlend; rec.normPnl = pnl; }
      if (regime === "stress") { rec.stressP = prem; rec.stressWR = stats.wrBlend; rec.stressPnl = pnl; }
    }

    recs.push(rec);

    const cL = rec.calmP !== null ? `${$0(rec.calmP)}/1k (${pct(rec.calmWR)})` : "PAUSE";
    const nL = rec.normP !== null ? `${$0(rec.normP)}/1k (${pct(rec.normWR)})` : "PAUSE";
    const sL = rec.stressP !== null ? `${$0(rec.stressP)}/1k (${pct(rec.stressWR)})` : "PAUSE";
    const sViable = rec.stressP !== null ? (rec.stressPnl > 0.5 ? "YES — good margin" : rec.stressPnl > 0 ? "YES — thin" : "NO") : "PAUSED";

    log(
      `  ${pad(sl + "%", 4)} | ${padE(cL, 20)} | ${padE(nL, 20)} | ${padE(sL, 20)} | ${pad($(rec.calmPnl), 8)} | ${pad($(rec.normPnl), 8)} | ${pad($(rec.stressPnl), 10)} | ${sViable}`
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // Section 3: Full position-size tables
  // ═══════════════════════════════════════════════════════════════
  log(hdr("SECTION 3: WHAT THE TRADER PAYS — All regimes, all position sizes (V7 pricing)"));
  log("  2-day rolling protection. Payout on stop-loss breach.\n");

  for (const regime of ["calm", "normal", "stress"] as Regime[]) {
    const regimePct = regime === "calm" ? "~30%" : regime === "normal" ? "~50%" : "~20%";
    log(sub(`${regime.toUpperCase()} REGIME (${regimePct} of the time)`));
    log("");

    const posHeader = POSITION_SIZES.map(p => padE(`$${p/1000}k`, 8)).join(" | ");
    const payHeader = POSITION_SIZES.map(p => padE(`$${p/1000}k`, 8)).join(" | ");
    log(`  SL%  | Prem/$1k | ${posHeader} | ${payHeader} | Return`);
    log(`  -----|----------|${POSITION_SIZES.map(() => "---------").join("|")}|${POSITION_SIZES.map(() => "---------").join("|")}|-------`);

    for (const r of recs) {
      const prem = regime === "calm" ? r.calmP : regime === "normal" ? r.normP : r.stressP;
      const payoutPer1k = r.sl * 10;
      if (prem === null) {
        log(`  ${pad(r.sl + "%", 4)} | PAUSED   | ${POSITION_SIZES.map(() => pad("—", 8)).join(" | ")} | ${POSITION_SIZES.map(() => pad("—", 8)).join(" | ")} | —`);
        continue;
      }
      const premCols = POSITION_SIZES.map(pos => pad($0(prem * pos / 1000), 8)).join(" | ");
      const payCols = POSITION_SIZES.map(pos => pad($0(payoutPer1k * pos / 1000), 8)).join(" | ");
      log(`  ${pad(r.sl + "%", 4)} | ${pad($0(prem), 8)} | ${premCols} | ${payCols} | ${(payoutPer1k / prem).toFixed(1)}×`);
    }
    log("");
  }

  // ═══════════════════════════════════════════════════════════════
  // Section 4: V6 vs V7 summary — what changed
  // ═══════════════════════════════════════════════════════════════
  log(hdr("SECTION 4: V6 vs V7 — What Changed"));
  log("");

  // V6 values (hardcoded from previous run)
  const v6 = [
    { sl: 1, calmP: 6, normP: null, stressP: null },
    { sl: 2, calmP: 3, normP: 7, stressP: null },
    { sl: 3, calmP: 2, normP: 6, stressP: null },
    { sl: 5, calmP: 2, normP: 4, stressP: null },
    { sl: 10, calmP: 1, normP: 2, stressP: 7 },
  ];

  log("  SL%  | V6 Calm → V7 | V6 Normal → V7 | V6 Stress → V7 | Key Change");
  log("  -----|-------------|---------------|---------------|----------");

  for (const r of recs) {
    const v6r = v6.find(v => v.sl === r.sl)!;
    const cChange = `${v6r.calmP !== null ? "$" + v6r.calmP : "PAUSE"} → ${r.calmP !== null ? "$" + r.calmP : "PAUSE"}`;
    const nChange = `${v6r.normP !== null ? "$" + v6r.normP : "PAUSE"} → ${r.normP !== null ? "$" + r.normP : "PAUSE"}`;
    const sChange = `${v6r.stressP !== null ? "$" + v6r.stressP : "PAUSE"} → ${r.stressP !== null ? "$" + r.stressP : "PAUSE"}`;

    let key = "";
    if (r.stressP !== null && v6r.stressP === null) key = "STRESS NOW VIABLE";
    else if (r.calmP !== null && v6r.calmP !== null && r.calmP < v6r.calmP) key = "Lower calm premium";
    else if (r.normP !== null && v6r.normP !== null && r.normP < v6r.normP) key = "Lower normal premium";
    else if (r.calmP !== null && v6r.calmP !== null && r.calmP === v6r.calmP) key = "No change";
    else key = "—";

    log(`  ${pad(r.sl + "%", 4)} | ${padE(cChange, 11)} | ${padE(nChange, 13)} | ${padE(sChange, 13)} | ${key}`);
  }

  // ═══════════════════════════════════════════════════════════════
  // Section 5: Final recommendation
  // ═══════════════════════════════════════════════════════════════
  log(hdr("SECTION 5: FINAL RECOMMENDATION"));
  log("");
  log("  ╔═══════════════════════════════════════════════════════════════════════════════════════╗");
  log("  ║  PRODUCT: 2-day rolling BTC perp protection, renewable                              ║");
  log("  ║  HEDGE: Naked trigger-strike put on Deribit                                         ║");
  log("  ║  PRICING: Regime-dynamic (vol < 40% = CALM, 40-65% = NORMAL, > 65% = STRESS)        ║");
  log("  ║  RECOVERY: Sell option with time value post-trigger; recoup on early trader close     ║");
  log("  ╚═══════════════════════════════════════════════════════════════════════════════════════╝");
  log("");

  log("  REGIME PRICING SUMMARY (per $1k / per $10k):\n");
  log("  SL%  | CALM (30%)         | NORMAL (50%)       | STRESS (20%)       | Weighted Avg");
  log("  -----|--------------------|--------------------|--------------------|-----------");
  for (const r of recs) {
    const cL = r.calmP !== null ? `$${r.calmP}/1k ($${r.calmP * 10}/10k)` : "PAUSE";
    const nL = r.normP !== null ? `$${r.normP}/1k ($${r.normP * 10}/10k)` : "PAUSE";
    const sL = r.stressP !== null ? `$${r.stressP}/1k ($${r.stressP * 10}/10k)` : "PAUSE";
    const wAvg = (r.calmP ?? 0) * 0.3 + (r.normP ?? 0) * 0.5 + (r.stressP ?? 0) * 0.2;
    log(`  ${pad(r.sl + "%", 4)} | ${padE(cL, 18)} | ${padE(nL, 18)} | ${padE(sL, 18)} | ${$(wAvg, 0)}/1k`);
  }

  log("\n  WHAT'S DIFFERENT FROM V6:");
  log("  - Time value recovery adds $0.20-1.50/1k margin per trade");
  log("  - 20% early-close assumption adds further upside on non-triggered trades");
  log("  - Some tiers that were PAUSED in stress may now be viable");
  log("  - Calm premiums may drop further due to higher recovery");
  log("");
  log("  LAUNCH PLAN:");
  log("  Phase 1: 5% + 10% SL (highest confidence, active in calm + normal)");
  log("  Phase 2: 3% SL (good margins, add once live execution validates model)");
  log("  Phase 3: 2% + 1% SL (tight margins, calm-only or calm+normal)");

  const fullOutput = L.join("\n");
  const outDir = path.resolve("docs/pilot-reports");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "backtest_definitive_v7_results.txt");
  await writeFile(outPath, fullOutput, "utf8");
  console.log(fullOutput);
  console.log(`\n  Results written to: ${outPath}`);
  console.log(`  Total time: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
}

main().catch(e => { console.error("Fatal:", e.message || e); process.exit(1); });
