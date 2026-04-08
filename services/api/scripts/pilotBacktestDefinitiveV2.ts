/**
 * Atticus Definitive Backtest V2: Full Analysis Suite
 *
 * Phase 1: Enhanced trader-centric output, recovery curves, regime pricing,
 *          win rate at all premiums, 1% pass-through, strike placement analysis
 * Phase 2: Tenor sweep (2-7 days), fine premium grid ($1-$25), regime transitions
 * Phase 3: Put spread hedge test
 *
 * Run: npx tsx services/api/scripts/pilotBacktestDefinitiveV2.ts
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

const SL_TIERS = [1, 2, 3, 5, 10];
const STRIKE_STRATEGIES = ["trigger", "mid", "atm"] as const;
const RECOVERY_STRATEGIES = ["hold", "tp"] as const;
const DEDUCTIBLE_OPTIONS = ["none", "1pct"] as const;
const VOL_MULTIPLIERS = [0.85, 1.0];
const TENORS = [2, 3, 4, 5, 7];
const FINE_PREMIUMS = Array.from({ length: 25 }, (_, i) => i + 1); // $1-$25/1k
const COARSE_PREMIUMS = [3, 5, 7, 8, 10, 12, 15, 20];
const NOTIONAL_1K = 1000;
const RF = 0.05;
const VOL_WINDOW = 30;
const TREASURY_START = 100_000;
const PROTECTIONS_PER_DAY = 5;

type StrikeStrategy = (typeof STRIKE_STRATEGIES)[number];
type RecoveryStrategy = (typeof RECOVERY_STRATEGIES)[number];
type DeductibleOption = (typeof DEDUCTIBLE_OPTIONS)[number];
type Regime = "calm" | "normal" | "stress";

// ═══════════════════════════════════════════════════════════════════════════
// Math Utilities
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

function classifyRegime(annualizedVol: number): Regime {
  if (annualizedVol < 0.4) return "calm";
  if (annualizedVol < 0.65) return "normal";
  return "stress";
}

function computeStrike(entryPrice: number, slPct: number, strategy: StrikeStrategy): number {
  switch (strategy) {
    case "trigger": return entryPrice * (1 - slPct / 100);
    case "mid": return entryPrice * (1 - slPct / 200);
    case "atm": return entryPrice;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Data Fetching
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
        if (!res.ok) throw new Error(`Coinbase HTTP ${res.status}`);
        const candles = (await res.json()) as number[][];
        for (const [ts, , , , close] of candles) {
          all.set(new Date(ts * 1000).toISOString().slice(0, 10), close);
        }
        break;
      } catch (e: any) { if (retries <= 0) throw e; await delay(2000); }
    }
    curMs = chunkEndMs;
    await delay(500);
  }
  return Array.from(all.entries()).map(([date, close]) => ({ date, close })).sort((a, b) => a.date.localeCompare(b.date));
}

function delay(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════════════════════
// Core Backtest Engine
// ═══════════════════════════════════════════════════════════════════════════

type WindowResult = {
  hedgeCost: number;
  payout: number;
  recoveryByDay: number[];   // intrinsic at each day from breach
  holdRecovery: number;
  tpRecovery: number;        // best of intrinsic in [breach_day..breach_day+2]
  triggered: boolean;
  triggerDay: number | null;
  regime: Regime;
  regimeAtExit: Regime;
  date: string;
  entryPrice: number;
  strikePrice: number;
  triggerPrice: number;
};

function runWindows(
  closes: number[],
  dates: string[],
  sl: number,
  strikeStrat: StrikeStrategy,
  deductible: DeductibleOption,
  volMult: number,
  tenor: number,
  spreadLowerPct?: number, // if set, sell a put at this % below entry (put spread)
): WindowResult[] {
  const results: WindowResult[] = [];

  for (let i = 0; i + tenor < closes.length; i++) {
    const entry = closes[i];
    if (entry <= 0) continue;

    const rawVol = realizedVol(closes, i, VOL_WINDOW);
    const vol = rawVol * volMult;
    const regime = classifyRegime(rawVol);
    const K = computeStrike(entry, sl, strikeStrat);
    const triggerPx = entry * (1 - sl / 100);
    const qty = NOTIONAL_1K / entry;
    const T = tenor / 365;

    let hedgeCost: number;
    if (spreadLowerPct !== undefined) {
      const Klow = entry * (1 - spreadLowerPct / 100);
      hedgeCost = (bsPut(entry, K, T, RF, vol) - bsPut(entry, Klow, T, RF, vol)) * qty;
    } else {
      hedgeCost = bsPut(entry, K, T, RF, vol) * qty;
    }
    if (hedgeCost < 0) hedgeCost = 0;

    let triggerDay: number | null = null;
    for (let d = 0; d <= tenor; d++) {
      const idx = i + d;
      if (idx >= closes.length) break;
      if (triggerDay === null && closes[idx] <= triggerPx) triggerDay = d;
    }
    const triggered = triggerDay !== null;

    const effectiveSl = deductible === "1pct" ? Math.max(0, sl - 1) : sl;
    const payout = triggered ? (NOTIONAL_1K * effectiveSl) / 100 : 0;

    const recoveryByDay: number[] = [];
    for (let d = 0; d <= tenor; d++) {
      const idx = i + d;
      if (idx >= closes.length) { recoveryByDay.push(0); continue; }
      let intrinsic = Math.max(0, K - closes[idx]) * qty;
      if (spreadLowerPct !== undefined) {
        const Klow = entry * (1 - spreadLowerPct / 100);
        const spreadCap = Math.max(0, K - Klow) * qty;
        intrinsic = Math.min(intrinsic, spreadCap);
      }
      recoveryByDay.push(intrinsic);
    }

    const holdRecovery = recoveryByDay[tenor] ?? 0;

    let tpRecovery = holdRecovery;
    if (triggered && triggerDay !== null) {
      const tpEnd = Math.min(triggerDay + 2, tenor);
      for (let d = triggerDay; d <= tpEnd; d++) {
        if (recoveryByDay[d] > tpRecovery) tpRecovery = recoveryByDay[d];
      }
    }

    const exitIdx = i + tenor;
    const exitRawVol = exitIdx < closes.length ? realizedVol(closes, exitIdx, VOL_WINDOW) : rawVol;
    const regimeAtExit = classifyRegime(exitRawVol);

    results.push({
      hedgeCost, payout, recoveryByDay, holdRecovery, tpRecovery,
      triggered, triggerDay, regime, regimeAtExit, date: dates[i],
      entryPrice: entry, strikePrice: K, triggerPrice: triggerPx,
    });
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// Analysis Functions
// ═══════════════════════════════════════════════════════════════════════════

type PremiumStats = {
  premium: number;
  avgPnl: number;
  winRate: number;
  winCount: number;
  lossCount: number;
};

function analyzePremiums(windows: WindowResult[], recoveryMode: "hold" | "tp", premiums: number[]): PremiumStats[] {
  const n = windows.length;
  return premiums.map(prem => {
    let pnlSum = 0, wins = 0;
    for (const w of windows) {
      const rec = recoveryMode === "tp" ? w.tpRecovery : w.holdRecovery;
      const pnl = prem - w.hedgeCost - w.payout + rec;
      pnlSum += pnl;
      if (pnl >= 0) wins++;
    }
    return {
      premium: prem,
      avgPnl: pnlSum / n,
      winRate: wins / n,
      winCount: wins,
      lossCount: n - wins,
    };
  });
}

function computeBreakEven(windows: WindowResult[], recoveryMode: "hold" | "tp"): number {
  const n = windows.length;
  let totalH = 0, totalP = 0, totalR = 0;
  for (const w of windows) {
    totalH += w.hedgeCost;
    totalP += w.payout;
    totalR += (recoveryMode === "tp" ? w.tpRecovery : w.holdRecovery);
  }
  return (totalH + totalP - totalR) / n;
}

function regimeBreakEvens(windows: WindowResult[], recoveryMode: "hold" | "tp"): Record<Regime, { be: number; count: number }> {
  const buckets: Record<Regime, { h: number; p: number; r: number; n: number }> = {
    calm: { h: 0, p: 0, r: 0, n: 0 },
    normal: { h: 0, p: 0, r: 0, n: 0 },
    stress: { h: 0, p: 0, r: 0, n: 0 },
  };
  for (const w of windows) {
    const b = buckets[w.regime];
    b.h += w.hedgeCost;
    b.p += w.payout;
    b.r += (recoveryMode === "tp" ? w.tpRecovery : w.holdRecovery);
    b.n++;
  }
  const out: Record<Regime, { be: number; count: number }> = {} as any;
  for (const regime of ["calm", "normal", "stress"] as Regime[]) {
    const b = buckets[regime];
    out[regime] = { be: b.n > 0 ? (b.h + b.p - b.r) / b.n : 0, count: b.n };
  }
  return out;
}

function regimePremiumStats(windows: WindowResult[], recoveryMode: "hold" | "tp", premiums: number[]): Record<Regime, PremiumStats[]> {
  const byRegime: Record<Regime, WindowResult[]> = { calm: [], normal: [], stress: [] };
  for (const w of windows) byRegime[w.regime].push(w);
  return {
    calm: analyzePremiums(byRegime.calm, recoveryMode, premiums),
    normal: analyzePremiums(byRegime.normal, recoveryMode, premiums),
    stress: analyzePremiums(byRegime.stress, recoveryMode, premiums),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Formatting Helpers
// ═══════════════════════════════════════════════════════════════════════════

function $(n: number, d = 2): string { return `$${n.toFixed(d)}`; }
function pct(n: number): string { return `${(n * 100).toFixed(1)}%`; }
function pad(s: string, w: number): string { return s.padStart(w); }
function padE(s: string, w: number): string { return s.padEnd(w); }

function header(title: string): string {
  return "\n" + "═".repeat(80) + "\n  " + title + "\n" + "═".repeat(80) + "\n";
}

function subheader(title: string): string {
  return "\n  " + "─".repeat(70) + "\n  " + title + "\n  " + "─".repeat(70) + "\n";
}

// ═══════════════════════════════════════════════════════════════════════════
// Output Generators
// ═══════════════════════════════════════════════════════════════════════════

function genTraderCentric(
  closes: number[], dates: string[],
): string {
  const lines: string[] = [];
  lines.push(header("PHASE 1A: TRADER-CENTRIC VIEW — What does the trader actually get?"));
  lines.push("  All values per $1k notional. Best config (mid strike, TP recovery, vol×0.85) used.\n");

  const configs: { sl: number; deduct: DeductibleOption; label: string }[] = [
    { sl: 1, deduct: "none", label: "1% (no deduct)" },
    { sl: 2, deduct: "none", label: "2% (no deduct)" },
    { sl: 2, deduct: "1pct", label: "2% (1% deduct)" },
    { sl: 3, deduct: "none", label: "3% (no deduct)" },
    { sl: 3, deduct: "1pct", label: "3% (1% deduct)" },
    { sl: 5, deduct: "none", label: "5% (no deduct)" },
    { sl: 5, deduct: "1pct", label: "5% (1% deduct)" },
    { sl: 10, deduct: "none", label: "10% (no deduct)" },
    { sl: 10, deduct: "1pct", label: "10% (1% deduct)" },
  ];

  lines.push("  Tier             | Prem/$1k | Payout/$1k | Net Gain | Trig Rt | Trader EV/$1k | Payout/Prem | Hedge/$1k | Recovery/$1k | Plat P&L/$1k");
  lines.push("  -----------------|----------|------------|----------|---------|---------------|-------------|-----------|--------------|------------");

  for (const c of configs) {
    const wins = runWindows(closes, dates, c.sl, "mid", c.deduct, 0.85, 7);
    const be = computeBreakEven(wins, "tp");
    const trigRate = wins.filter(w => w.triggered).length / wins.length;
    const effSl = c.deduct === "1pct" ? Math.max(0, c.sl - 1) : c.sl;
    const payoutPer1k = effSl * 10; // $10 per 1% per $1k
    const avgHedge = wins.reduce((s, w) => s + w.hedgeCost, 0) / wins.length;
    const avgRec = wins.reduce((s, w) => s + w.tpRecovery, 0) / wins.length;

    const testPremiums = [3, 4, 5, 6, 7, 8, 10, 12, 15];
    // find lowest premium where payout > premium AND platform is profitable
    let bestPrem = 0;
    for (const p of testPremiums) {
      if (payoutPer1k > p && p > be) { bestPrem = p; break; }
    }
    if (bestPrem === 0 && payoutPer1k > 0) {
      // use break-even + $1 margin
      bestPrem = Math.ceil(be) + 1;
      if (bestPrem < 1) bestPrem = 1;
    }
    if (payoutPer1k <= 0) bestPrem = Math.ceil(be) + 1;

    const prem = bestPrem;
    const netGain = payoutPer1k - prem;
    const traderEV = trigRate * payoutPer1k - prem;
    const payoutRatio = prem > 0 ? payoutPer1k / prem : 0;
    const platPnl = prem - be;

    lines.push(
      `  ${padE(c.label, 17)} | ${pad($(prem), 8)} | ${pad($(payoutPer1k), 10)} | ${pad($(netGain), 8)} | ${pad(pct(trigRate), 7)} | ${pad($(traderEV), 13)} | ${pad(payoutRatio.toFixed(1) + "×", 11)} | ${pad($(avgHedge), 9)} | ${pad($(avgRec), 12)} | ${pad($(platPnl), 12)}`
    );
  }

  lines.push("\n  Trader EV = (TriggerRate × Payout) - Premium.  Negative means protection costs more than expected return.");
  lines.push("  Payout/Prem ratio > 3× generally feels like good value to the trader.");
  lines.push("  Platform P&L = Premium - BreakEven. Must be positive for sustainability.");

  return lines.join("\n");
}

function genStrikePlacement(): string {
  const lines: string[] = [];
  lines.push(header("PHASE 1B: STRIKE PLACEMENT — Where is the option bought vs the stop-loss?"));
  lines.push("  Example with BTC at $80,000 entry price.\n");

  lines.push("  SL%  | Strategy | Put Strike    | Distance from Entry | Relative to SL Level | Option Goes ITM When...");
  lines.push("  -----|----------|---------------|--------------------|-----------------------|-------------------------");

  for (const sl of SL_TIERS) {
    const entry = 80000;
    const trigger = entry * (1 - sl / 100);
    for (const strat of STRIKE_STRATEGIES) {
      const K = computeStrike(entry, sl, strat);
      const distPct = ((entry - K) / entry * 100).toFixed(2);
      const relLabel = K > trigger ? `${((K - trigger) / entry * 100).toFixed(2)}% ABOVE SL` :
                        K === trigger ? "AT SL level" :
                        `${((trigger - K) / entry * 100).toFixed(2)}% BELOW SL`;
      const itmWhen = K === entry ? "Any price drop" :
                      `BTC drops below $${K.toFixed(0)}`;
      lines.push(
        `  ${pad(sl + "%", 4)} | ${padE(strat, 8)} | $${pad(K.toFixed(0), 8)}    | ${pad(distPct + "% OTM", 19)} | ${padE(relLabel, 21)} | ${itmWhen}`
      );
    }
    if (sl < 10) lines.push("  -----|----------|---------------|--------------------|-----------------------|-------------------------");
  }

  lines.push("\n  KEY: 'mid' and 'atm' strikes go ITM BEFORE the stop-loss is hit.");
  lines.push("  This means the hedge option gains value from small drops that don't trigger payout.");
  lines.push("  'trigger' strike only gains value when BTC is AT or PAST the stop-loss.");

  return lines.join("\n");
}

function genRecoveryCurves(closes: number[], dates: string[]): string {
  const lines: string[] = [];
  lines.push(header("PHASE 1C: POST-BREACH RECOVERY CURVE — When should the platform sell the option?"));
  lines.push("  For triggered windows only: average option intrinsic value by day relative to breach.");
  lines.push("  Config: mid strike, vol×0.85, 7-day tenor.\n");

  for (const sl of SL_TIERS) {
    const wins = runWindows(closes, dates, sl, "mid", "none", 0.85, 7);
    const triggered = wins.filter(w => w.triggered && w.triggerDay !== null);
    if (triggered.length === 0) { lines.push(`  ${sl}% SL: No triggered windows\n`); continue; }

    lines.push(`  ${sl}% SL (${triggered.length} triggered windows out of ${wins.length}):`);

    // Compute recovery relative to breach day
    const maxDaysAfter = 7;
    const recovByDayAfterBreach: number[][] = Array.from({ length: maxDaysAfter + 1 }, () => []);

    for (const w of triggered) {
      const bd = w.triggerDay!;
      for (let dAfter = 0; dAfter <= maxDaysAfter; dAfter++) {
        const absDay = bd + dAfter;
        if (absDay < w.recoveryByDay.length) {
          recovByDayAfterBreach[dAfter].push(w.recoveryByDay[absDay]);
        }
      }
    }

    lines.push("    Day After Breach | Avg Recovery/$1k | Median | Max    | % > Hold-to-Expiry");
    lines.push("    -----------------|------------------|--------|--------|-------------------");

    const holdValues = triggered.map(w => w.holdRecovery);
    const avgHold = holdValues.reduce((s, v) => s + v, 0) / holdValues.length;

    for (let d = 0; d <= maxDaysAfter; d++) {
      const vals = recovByDayAfterBreach[d];
      if (vals.length === 0) continue;
      const sorted = [...vals].sort((a, b) => a - b);
      const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
      const median = sorted[Math.floor(sorted.length / 2)];
      const max = sorted[sorted.length - 1];
      const pctBetterThanHold = vals.filter(v => v > avgHold).length / vals.length;
      const marker = d <= 2 ? " ← TP window" : "";
      lines.push(
        `    Day +${d}             | ${pad($(avg), 16)} | ${pad($(median), 6)} | ${pad($(max), 6)} | ${pad(pct(pctBetterThanHold), 18)}${marker}`
      );
    }

    // Best day
    const avgByDay = recovByDayAfterBreach.map((vals, d) => ({
      day: d,
      avg: vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : 0,
    }));
    const bestDay = avgByDay.reduce((best, cur) => cur.avg > best.avg ? cur : best, avgByDay[0]);
    lines.push(`    → OPTIMAL SELL DAY: Day +${bestDay.day} after breach (avg recovery ${$(bestDay.avg)}/1k)`);
    lines.push(`    → Hold-to-expiry avg: ${$(avgHold)}/1k`);
    lines.push(`    → TP improvement: +${$((bestDay.avg - avgHold), 2)}/1k (+${((bestDay.avg / avgHold - 1) * 100).toFixed(0)}%)\n`);
  }

  return lines.join("\n");
}

function genWinRateGrid(closes: number[], dates: string[]): string {
  const lines: string[] = [];
  lines.push(header("PHASE 1D: WIN RATE AT EVERY PREMIUM — Fine-grained premium sweep"));
  lines.push("  Config: mid strike, TP recovery, no deductible, vol×0.85, 7-day tenor.");
  lines.push("  Shows which premiums give >50%, >60%, >70% win rate per tier.\n");

  for (const sl of SL_TIERS) {
    const wins = runWindows(closes, dates, sl, "mid", "none", 0.85, 7);
    const stats = analyzePremiums(wins, "tp", FINE_PREMIUMS);
    const be = computeBreakEven(wins, "tp");

    lines.push(`  ${sl}% SL (BE = ${$(be)}/1k, trigger rate = ${pct(wins.filter(w => w.triggered).length / wins.length)}):`);
    lines.push("    Prem/$1k | Avg P&L | WinRate | Verdict");
    lines.push("    ---------|---------|--------|--------");

    for (const s of stats) {
      let verdict = "";
      if (s.avgPnl < 0) verdict = "LOSS";
      else if (s.winRate < 0.5) verdict = "unstable";
      else if (s.winRate < 0.6) verdict = "marginal";
      else if (s.winRate < 0.7) verdict = "OK";
      else verdict = "GOOD";
      lines.push(
        `    ${pad($(s.premium, 0), 8)} | ${pad($(s.avgPnl), 7)} | ${pad(pct(s.winRate), 6)} | ${verdict}`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

function genRegimePricing(closes: number[], dates: string[]): string {
  const lines: string[] = [];
  lines.push(header("PHASE 1E: REGIME-BASED PRICING — What to charge in calm vs normal vs stress"));
  lines.push("  Config: mid strike, TP recovery, no deductible, vol×0.85, 7-day tenor.\n");

  const regimePremiums = [2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20];

  for (const sl of SL_TIERS) {
    const wins = runWindows(closes, dates, sl, "mid", "none", 0.85, 7);
    const rbe = regimeBreakEvens(wins, "tp");
    const rps = regimePremiumStats(wins, "tp", regimePremiums);
    const payoutPer1k = sl * 10;

    lines.push(`  ${sl}% SL:`);
    lines.push(`    Calm   BE = ${$(rbe.calm.be)}/1k (${rbe.calm.count} windows, ${pct(rbe.calm.count / wins.length)} of data)`);
    lines.push(`    Normal BE = ${$(rbe.normal.be)}/1k (${rbe.normal.count} windows)`);
    lines.push(`    Stress BE = ${$(rbe.stress.be)}/1k (${rbe.stress.count} windows)`);
    lines.push("");
    lines.push("    Premium/$1k |    CALM P&L / WinRt |  NORMAL P&L / WinRt |  STRESS P&L / WinRt | Trader Pays/$10k | Payout/$10k");
    lines.push("    ------------|---------------------|---------------------|---------------------|------------------|------------");

    for (const prem of regimePremiums) {
      const cs = rps.calm.find(s => s.premium === prem)!;
      const ns = rps.normal.find(s => s.premium === prem)!;
      const ss = rps.stress.find(s => s.premium === prem)!;
      const traderPays = prem * 10;

      const cLabel = cs ? `${$(cs.avgPnl, 1)} / ${pct(cs.winRate)}` : "N/A";
      const nLabel = ns ? `${$(ns.avgPnl, 1)} / ${pct(ns.winRate)}` : "N/A";
      const sLabel = ss ? `${$(ss.avgPnl, 1)} / ${pct(ss.winRate)}` : "N/A";

      lines.push(
        `    ${pad($(prem, 0), 11)} | ${pad(cLabel, 19)} | ${pad(nLabel, 19)} | ${pad(sLabel, 19)} | ${pad($(traderPays, 0), 16)} | ${pad($(payoutPer1k * 10, 0), 11)}`
      );
    }

    // Regime recommendation
    let calmPrem = 0, normalPrem = 0, stressPrem = 0;
    for (const p of regimePremiums) {
      const cs = rps.calm.find(s => s.premium === p);
      if (!calmPrem && cs && cs.avgPnl > 0 && cs.winRate >= 0.55 && p < payoutPer1k) calmPrem = p;
    }
    for (const p of regimePremiums) {
      const ns = rps.normal.find(s => s.premium === p);
      if (!normalPrem && ns && ns.avgPnl > 0 && ns.winRate >= 0.55 && p < payoutPer1k) normalPrem = p;
    }
    for (const p of regimePremiums) {
      const ss = rps.stress.find(s => s.premium === p);
      if (!stressPrem && ss && ss.avgPnl > 0 && ss.winRate >= 0.55 && p < payoutPer1k) stressPrem = p;
    }

    lines.push("");
    lines.push(`    → RECOMMENDED: Calm ${$(calmPrem, 0)}/1k (${$(calmPrem * 10, 0)}/10k) | Normal ${$(normalPrem, 0)}/1k (${$(normalPrem * 10, 0)}/10k) | Stress ${stressPrem ? $(stressPrem, 0) + "/1k (" + $(stressPrem * 10, 0) + "/10k)" : "PAUSE"}`);
    if (calmPrem > 0) {
      lines.push(`    → Calm trader value: pay ${$(calmPrem * 10, 0)} for ${$(payoutPer1k * 10, 0)} payout = ${(payoutPer1k * 10 / (calmPrem * 10)).toFixed(1)}× return on breach`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function genOnePercentPassthrough(closes: number[], dates: string[]): string {
  const lines: string[] = [];
  lines.push(header("PHASE 1F: 1% STOP-LOSS PASS-THROUGH PRICING"));
  lines.push("  Even if unrealistic, showing full economics for 1% SL with no deductible.\n");

  const configs: { strat: StrikeStrategy; label: string }[] = [
    { strat: "trigger", label: "trigger (at SL)" },
    { strat: "mid", label: "mid (0.5% OTM)" },
    { strat: "atm", label: "atm (at entry)" },
  ];

  for (const c of configs) {
    const wins = runWindows(closes, dates, 1, c.strat, "none", 0.85, 7);
    const be = computeBreakEven(wins, "tp");
    const trigRate = wins.filter(w => w.triggered).length / wins.length;
    const avgH = wins.reduce((s, w) => s + w.hedgeCost, 0) / wins.length;
    const avgR = wins.reduce((s, w) => s + w.tpRecovery, 0) / wins.length;
    const stats = analyzePremiums(wins, "tp", FINE_PREMIUMS);
    const rbe = regimeBreakEvens(wins, "tp");

    lines.push(subheader(`1% SL — ${c.label}`));
    lines.push(`  Break-even: ${$(be)}/1k | Trigger rate: ${pct(trigRate)} | Hedge: ${$(avgH)}/1k | Recovery: ${$(avgR)}/1k`);
    lines.push(`  Regime BEs: Calm ${$(rbe.calm.be)}/1k | Normal ${$(rbe.normal.be)}/1k | Stress ${$(rbe.stress.be)}/1k`);
    lines.push("");
    lines.push("  Prem/$1k | P&L/$1k | WinRate | Trader Pays/$10k | Gets/$10k | Net/$10k | Plat Margin");
    lines.push("  ---------|---------|--------|------------------|-----------|----------|------------");

    for (const s of stats.filter(s => s.premium <= 15)) {
      const traderPays = s.premium * 10;
      const traderGets = 100; // 1% of $10k
      const net = traderGets - traderPays;
      const margin = s.premium - be;
      lines.push(
        `  ${pad($(s.premium, 0), 8)} | ${pad($(s.avgPnl), 7)} | ${pad(pct(s.winRate), 6)} | ${pad($(traderPays, 0), 16)} | ${pad($(traderGets, 0), 9)} | ${pad($(net, 0), 8)} | ${pad($(margin), 11)}`
      );
    }

    // Treasury sim at a few key premiums
    lines.push("");
    lines.push("  Treasury simulation ($100k start, 5/day):");
    for (const prem of [3, 5, 7]) {
      const sim = simulateTreasury(wins, "tp", prem);
      lines.push(`    At ${$(prem, 0)}/1k: End ${$(sim.endTreasury, 0)} | Min ${$(sim.minTreasury, 0)} | MaxDD ${$(sim.maxDrawdown, 0)} | Annual ${$(sim.annualPnL, 0)} | Worst month ${sim.worstMonth} (${$(sim.worstMonthPnL, 0)})`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2: Tenor Sweep
// ═══════════════════════════════════════════════════════════════════════════

function genTenorSweep(closes: number[], dates: string[]): string {
  const lines: string[] = [];
  lines.push(header("PHASE 2A: TENOR SWEEP — How does protection duration affect economics?"));
  lines.push("  Config: mid strike, TP recovery, no deductible, vol×0.85.\n");

  lines.push("  SL%  | Tenor | Windows | TrigRate | Hedge/$1k | Payout/$1k | Recovery/$1k | BE/$1k  | Calm BE | Stress BE | Best Prem | WR@Best");
  lines.push("  -----|-------|---------|----------|-----------|------------|-------------|---------|---------|-----------|-----------|--------");

  for (const sl of SL_TIERS) {
    for (const tenor of TENORS) {
      const wins = runWindows(closes, dates, sl, "mid", "none", 0.85, tenor);
      if (wins.length === 0) continue;
      const n = wins.length;
      const be = computeBreakEven(wins, "tp");
      const trigRate = wins.filter(w => w.triggered).length / n;
      const avgH = wins.reduce((s, w) => s + w.hedgeCost, 0) / n;
      const avgP = wins.reduce((s, w) => s + w.payout, 0) / n;
      const avgR = wins.reduce((s, w) => s + w.tpRecovery, 0) / n;
      const rbe = regimeBreakEvens(wins, "tp");

      const stats = analyzePremiums(wins, "tp", FINE_PREMIUMS);
      const payoutPer1k = sl * 10;
      let bestPrem = "N/A";
      let bestWR = "N/A";
      for (const s of stats) {
        if (s.avgPnl > 0 && s.winRate >= 0.55 && s.premium < payoutPer1k) {
          bestPrem = $(s.premium, 0);
          bestWR = pct(s.winRate);
          break;
        }
      }

      lines.push(
        `  ${pad(sl + "%", 4)} | ${pad(tenor + "d", 5)} | ${pad(String(n), 7)} | ${pad(pct(trigRate), 8)} | ${pad($(avgH), 9)} | ${pad($(avgP), 10)} | ${pad($(avgR), 11)} | ${pad($(be), 7)} | ${pad($(rbe.calm.be), 7)} | ${pad($(rbe.stress.be), 9)} | ${pad(bestPrem, 9)} | ${pad(bestWR, 7)}`
      );
    }
    if (sl < 10) lines.push("  -----|-------|---------|----------|-----------|------------|-------------|---------|---------|-----------|-----------|--------");
  }

  lines.push("\n  INSIGHT: Shorter tenors reduce hedge cost but also reduce recovery. Net effect varies by SL tier.");

  return lines.join("\n");
}

function genTenorDetailForBestSL(closes: number[], dates: string[]): string {
  const lines: string[] = [];
  lines.push(header("PHASE 2B: TENOR DETAIL — Full premium grid for 2%, 3%, 5% SL at each tenor"));
  lines.push("  Config: mid strike, TP recovery, no deductible, vol×0.85.\n");

  for (const sl of [2, 3, 5]) {
    lines.push(subheader(`${sl}% SL — Tenor comparison`));
    const payoutPer1k = sl * 10;

    for (const tenor of TENORS) {
      const wins = runWindows(closes, dates, sl, "mid", "none", 0.85, tenor);
      const be = computeBreakEven(wins, "tp");
      const trigRate = wins.filter(w => w.triggered).length / wins.length;
      const premiums = [2, 3, 4, 5, 6, 7, 8, 10, 12, 15];
      const stats = analyzePremiums(wins, "tp", premiums);

      lines.push(`  ${tenor}-day tenor (BE=${$(be)}/1k, trig=${pct(trigRate)}):`);
      let row = "    ";
      for (const s of stats) {
        const wr = (s.winRate * 100).toFixed(0);
        const marker = s.avgPnl > 0 && s.premium < payoutPer1k ? "✓" : " ";
        row += `$${s.premium}:${$(s.avgPnl, 1)}/${wr}%${marker} | `;
      }
      lines.push(row);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2: Regime Transitions
// ═══════════════════════════════════════════════════════════════════════════

function genRegimeTransitions(closes: number[], dates: string[]): string {
  const lines: string[] = [];
  lines.push(header("PHASE 2C: REGIME TRANSITION RISK — Does calm stay calm during a 7-day trade?"));
  lines.push("  Tracking: what regime is the market in when the trade is OPENED vs when it EXITS.\n");

  const wins = runWindows(closes, dates, 2, "mid", "none", 0.85, 7);

  const transitions: Record<string, number> = {};
  for (const w of wins) {
    const key = `${w.regime}→${w.regimeAtExit}`;
    transitions[key] = (transitions[key] || 0) + 1;
  }

  const regimes: Regime[] = ["calm", "normal", "stress"];
  lines.push("  Entry Regime → Exit Regime:");
  lines.push("  ─────────────┬──────────────┬──────────────┬──────────────┬─────────");
  lines.push("               │ Exit: Calm   │ Exit: Normal │ Exit: Stress │ Total");
  lines.push("  ─────────────┼──────────────┼──────────────┼──────────────┼─────────");

  for (const entry of regimes) {
    const total = regimes.reduce((s, exit) => s + (transitions[`${entry}→${exit}`] || 0), 0);
    const cells = regimes.map(exit => {
      const count = transitions[`${entry}→${exit}`] || 0;
      const pctVal = total > 0 ? (count / total * 100).toFixed(1) : "0.0";
      return pad(`${count} (${pctVal}%)`, 12);
    });
    lines.push(`  Entry: ${padE(entry, 6)} │ ${cells.join(" │ ")} │ ${pad(String(total), 7)}`);
  }
  lines.push("  ─────────────┴──────────────┴──────────────┴──────────────┴─────────");

  // Compute "opened in calm, triggered in non-calm" risk
  const calmOpened = wins.filter(w => w.regime === "calm");
  const calmTriggered = calmOpened.filter(w => w.triggered);
  const calmOpenedStressExit = calmOpened.filter(w => w.regimeAtExit === "stress");

  lines.push(`\n  KEY RISK METRICS:`);
  lines.push(`  - Trades opened in CALM: ${calmOpened.length} (${pct(calmOpened.length / wins.length)})`);
  lines.push(`  - Of those, triggered: ${calmTriggered.length} (${pct(calmTriggered.length / calmOpened.length)})`);
  lines.push(`  - Calm→Stress transitions: ${calmOpenedStressExit.length} (${pct(calmOpenedStressExit.length / calmOpened.length)})`);
  lines.push(`  - Implication: ${calmOpenedStressExit.length === 0 ? "Regime is sticky over 7 days — safe for regime pricing" : calmOpenedStressExit.length < calmOpened.length * 0.05 ? "Rare transitions — regime pricing is generally safe" : "WARNING: Significant regime transitions — regime pricing has gap risk"}`);

  // Same analysis for longer tenors
  lines.push(`\n  Transition risk by tenor (calm→stress probability):`);
  for (const tenor of TENORS) {
    const tw = runWindows(closes, dates, 2, "mid", "none", 0.85, tenor);
    const tCalmOpened = tw.filter(w => w.regime === "calm");
    const tCalmToStress = tCalmOpened.filter(w => w.regimeAtExit === "stress");
    lines.push(`    ${tenor}-day: ${pct(tCalmToStress.length / (tCalmOpened.length || 1))} (${tCalmToStress.length}/${tCalmOpened.length})`);
  }

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3: Put Spread Hedge
// ═══════════════════════════════════════════════════════════════════════════

function genPutSpreadAnalysis(closes: number[], dates: string[]): string {
  const lines: string[] = [];
  lines.push(header("PHASE 3: PUT SPREAD HEDGE — Cheaper hedging with capped recovery"));
  lines.push("  Instead of buying a naked put, buy a put spread: buy higher strike, sell lower strike.");
  lines.push("  Dramatically reduces hedge cost but caps maximum recovery.\n");

  // Test different spread widths
  const spreadWidths: { label: string; upperStrat: StrikeStrategy; lowerPctBelow: number }[] = [
    { label: "mid / trigger (narrow)", upperStrat: "mid", lowerPctBelow: -1 }, // special: lower = trigger
    { label: "atm / mid", upperStrat: "atm", lowerPctBelow: -2 }, // special: lower = mid
    { label: "atm / entry-SL*1.5", upperStrat: "atm", lowerPctBelow: -3 }, // lower = entry*(1-SL*1.5)
  ];

  for (const sl of [2, 3, 5, 10]) {
    lines.push(subheader(`${sl}% SL — Put Spread Comparison`));

    const nakedWins = runWindows(closes, dates, sl, "mid", "none", 0.85, 7);
    const nakedBE = computeBreakEven(nakedWins, "tp");
    const nakedAvgH = nakedWins.reduce((s, w) => s + w.hedgeCost, 0) / nakedWins.length;
    const nakedAvgR = nakedWins.reduce((s, w) => s + w.tpRecovery, 0) / nakedWins.length;
    const nakedTrig = nakedWins.filter(w => w.triggered).length / nakedWins.length;
    const nakedStats = analyzePremiums(nakedWins, "tp", FINE_PREMIUMS);

    lines.push(`  Naked mid put (baseline):`);
    lines.push(`    Hedge: ${$(nakedAvgH)}/1k | Recovery: ${$(nakedAvgR)}/1k | BE: ${$(nakedBE)}/1k | TrigRate: ${pct(nakedTrig)}`);

    // Test actual spread configs
    const spreadConfigs: { label: string; lowerPct: number }[] = [
      { label: `mid/${sl * 1.5}% spread`, lowerPct: sl * 1.5 },
      { label: `mid/${sl * 2}% spread`, lowerPct: sl * 2 },
      { label: `atm/${sl}% spread`, lowerPct: sl },
      { label: `atm/${sl * 1.5}% spread`, lowerPct: sl * 1.5 },
    ];

    lines.push("");
    lines.push("    Config                | Hedge/$1k | Recovery/$1k | BE/$1k  | vs Naked | Best Prem | WR@Best | Trader Value");
    lines.push("    ----------------------|-----------|-------------|---------|----------|-----------|---------|-------------");

    for (const sc of spreadConfigs) {
      // upper strike = mid strategy, lower = entry*(1-lowerPct/100)
      const upperStrat = sc.lowerPct === sl ? "atm" as StrikeStrategy : "mid" as StrikeStrategy;
      const spreadWins = runWindows(closes, dates, sl, upperStrat, "none", 0.85, 7, sc.lowerPct);
      const spreadBE = computeBreakEven(spreadWins, "tp");
      const spreadAvgH = spreadWins.reduce((s, w) => s + w.hedgeCost, 0) / spreadWins.length;
      const spreadAvgR = spreadWins.reduce((s, w) => s + w.tpRecovery, 0) / spreadWins.length;
      const spreadStats = analyzePremiums(spreadWins, "tp", FINE_PREMIUMS);

      const payoutPer1k = sl * 10;
      let bestPrem = "N/A";
      let bestWR = "N/A";
      for (const s of spreadStats) {
        if (s.avgPnl > 0 && s.winRate >= 0.55 && s.premium < payoutPer1k) {
          bestPrem = $(s.premium, 0);
          bestWR = pct(s.winRate);
          break;
        }
      }
      const savings = nakedBE - spreadBE;
      const traderVal = bestPrem !== "N/A" ? `${(payoutPer1k / parseInt(bestPrem.replace("$", ""))).toFixed(1)}× return` : "N/A";

      lines.push(
        `    ${padE(sc.label, 22)} | ${pad($(spreadAvgH), 9)} | ${pad($(spreadAvgR), 11)} | ${pad($(spreadBE), 7)} | ${pad($(savings), 8)} | ${pad(bestPrem, 9)} | ${pad(bestWR, 7)} | ${traderVal}`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Treasury Simulation
// ═══════════════════════════════════════════════════════════════════════════

type TreasurySim = {
  endTreasury: number;
  minTreasury: number;
  maxDrawdown: number;
  annualPnL: number;
  worstMonthPnL: number;
  worstMonth: string;
};

function simulateTreasury(windows: WindowResult[], recoveryMode: "hold" | "tp", premium: number): TreasurySim {
  let treasury = TREASURY_START;
  let peak = treasury;
  let maxDD = 0;
  let minTreasury = treasury;
  const monthlyPnL = new Map<string, number>();

  for (const w of windows) {
    const rec = recoveryMode === "tp" ? w.tpRecovery : w.holdRecovery;
    const pnl = premium - w.hedgeCost - w.payout + rec;
    const dailyImpact = pnl * PROTECTIONS_PER_DAY;
    treasury += dailyImpact;
    if (treasury < minTreasury) minTreasury = treasury;
    if (treasury > peak) peak = treasury;
    const dd = peak - treasury;
    if (dd > maxDD) maxDD = dd;
    const month = w.date.slice(0, 7);
    monthlyPnL.set(month, (monthlyPnL.get(month) || 0) + dailyImpact);
  }

  let worstMonthPnL = Infinity;
  let worstMonth = "";
  for (const [m, pnl] of monthlyPnL.entries()) {
    if (pnl < worstMonthPnL) { worstMonthPnL = pnl; worstMonth = m; }
  }

  const years = windows.length / 365;
  const totalPnL = treasury - TREASURY_START;
  return {
    endTreasury: treasury,
    minTreasury,
    maxDrawdown: maxDD,
    annualPnL: years > 0 ? totalPnL / years : 0,
    worstMonthPnL: worstMonthPnL === Infinity ? 0 : worstMonthPnL,
    worstMonth,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Comprehensive Summary / Recommendation
// ═══════════════════════════════════════════════════════════════════════════

function genFinalRecommendation(closes: number[], dates: string[]): string {
  const lines: string[] = [];
  lines.push(header("FINAL RECOMMENDATION: OPTIMAL PRODUCT STRUCTURE"));

  // For each SL tier, test all combos of tenor × strike × deductible with TP, vol 0.85
  // and find the absolute best config
  type BestEntry = {
    sl: number; tenor: number; strike: StrikeStrategy; deduct: DeductibleOption;
    spreadLower?: number; be: number; trigRate: number; bestPrem: number; bestWR: number;
    avgH: number; avgR: number; calmBE: number; normalBE: number; stressBE: number;
    windows: WindowResult[];
  };
  const allBests: BestEntry[] = [];

  for (const sl of SL_TIERS) {
    const payoutPer1k = sl * 10;
    for (const tenor of TENORS) {
      for (const strike of STRIKE_STRATEGIES) {
        for (const deduct of DEDUCTIBLE_OPTIONS) {
          const effSl = deduct === "1pct" ? Math.max(0, sl - 1) : sl;
          const effPayout = effSl * 10;
          if (effPayout <= 0) continue;

          const wins = runWindows(closes, dates, sl, strike, deduct, 0.85, tenor);
          if (wins.length < 100) continue;
          const be = computeBreakEven(wins, "tp");
          const trigRate = wins.filter(w => w.triggered).length / wins.length;
          const stats = analyzePremiums(wins, "tp", FINE_PREMIUMS);
          const rbe = regimeBreakEvens(wins, "tp");
          const avgH = wins.reduce((s, w) => s + w.hedgeCost, 0) / wins.length;
          const avgR = wins.reduce((s, w) => s + w.tpRecovery, 0) / wins.length;

          for (const s of stats) {
            if (s.avgPnl > 0 && s.winRate >= 0.55 && s.premium < effPayout) {
              allBests.push({
                sl, tenor, strike, deduct, be, trigRate,
                bestPrem: s.premium, bestWR: s.winRate,
                avgH, avgR,
                calmBE: rbe.calm.be, normalBE: rbe.normal.be, stressBE: rbe.stress.be,
                windows: wins,
              });
              break;
            }
          }
        }
      }
    }
  }

  // Also test put spreads
  for (const sl of [2, 3, 5, 10]) {
    const payoutPer1k = sl * 10;
    for (const tenor of [3, 5, 7]) {
      for (const spreadLower of [sl * 1.5, sl * 2]) {
        for (const strike of ["mid", "atm"] as StrikeStrategy[]) {
          const wins = runWindows(closes, dates, sl, strike, "none", 0.85, tenor, spreadLower);
          if (wins.length < 100) continue;
          const be = computeBreakEven(wins, "tp");
          const trigRate = wins.filter(w => w.triggered).length / wins.length;
          const stats = analyzePremiums(wins, "tp", FINE_PREMIUMS);
          const rbe = regimeBreakEvens(wins, "tp");
          const avgH = wins.reduce((s, w) => s + w.hedgeCost, 0) / wins.length;
          const avgR = wins.reduce((s, w) => s + w.tpRecovery, 0) / wins.length;

          for (const s of stats) {
            if (s.avgPnl > 0 && s.winRate >= 0.55 && s.premium < payoutPer1k) {
              allBests.push({
                sl, tenor, strike, deduct: "none", spreadLower, be, trigRate,
                bestPrem: s.premium, bestWR: s.winRate,
                avgH, avgR,
                calmBE: rbe.calm.be, normalBE: rbe.normal.be, stressBE: rbe.stress.be,
                windows: wins,
              });
              break;
            }
          }
        }
      }
    }
  }

  // Sort by: lowest premium that works (best trader value)
  allBests.sort((a, b) => {
    if (a.sl !== b.sl) return a.sl - b.sl;
    return a.bestPrem - b.bestPrem;
  });

  lines.push("\n  TOP CONFIG PER SL TIER (lowest viable premium = best trader value):\n");
  lines.push("  SL% | Tenor | Strike  | Deduct | Spread?    | Prem/$1k | Payout/$1k | Ratio | TrigRt | WinRt  | BE/$1k | Plat $/1k | Calm BE | Stress BE");
  lines.push("  ----|-------|---------|--------|------------|----------|------------|-------|--------|--------|--------|-----------|---------|----------");

  const shown = new Set<number>();
  for (const b of allBests) {
    if (shown.has(b.sl)) continue;
    shown.add(b.sl);
    const effSl = b.deduct === "1pct" ? Math.max(0, b.sl - 1) : b.sl;
    const payoutPer1k = effSl * 10;
    const ratio = payoutPer1k / b.bestPrem;
    const spreadLabel = b.spreadLower ? `${b.spreadLower}%` : "none";
    const platMargin = b.bestPrem - b.be;

    lines.push(
      `  ${pad(b.sl + "%", 3)} | ${pad(b.tenor + "d", 5)} | ${padE(b.strike, 7)} | ${padE(b.deduct === "1pct" ? "1%" : "none", 6)} | ${padE(spreadLabel, 10)} | ${pad($(b.bestPrem, 0), 8)} | ${pad($(payoutPer1k, 0), 10)} | ${pad(ratio.toFixed(1) + "×", 5)} | ${pad(pct(b.trigRate), 6)} | ${pad(pct(b.bestWR), 6)} | ${pad($(b.be), 6)} | ${pad($(platMargin), 9)} | ${pad($(b.calmBE), 7)} | ${pad($(b.stressBE), 9)}`
    );
  }

  // CEO table for the winners
  lines.push("\n\n  CEO PRESENTATION — WHAT THE TRADER SEES (per $10,000 position):\n");
  lines.push('  SL%  | Tenor | "You Pay" | "If BTC Hits SL" | "Return on Breach" | "Without Protection" | Calm Price | Normal Price | Stress');
  lines.push('  -----|-------|-----------|-----------------|--------------------|---------------------|------------|-------------|-------');

  shown.clear();
  for (const b of allBests) {
    if (shown.has(b.sl)) continue;
    shown.add(b.sl);
    const effSl = b.deduct === "1pct" ? Math.max(0, b.sl - 1) : b.sl;
    const payoutPer10k = effSl * 100;
    const youPay = b.bestPrem * 10;
    const withoutProt = b.sl * 100;

    // Regime pricing
    const rps = regimePremiumStats(b.windows, "tp", FINE_PREMIUMS);
    let calmPrem = b.bestPrem, normalPrem = b.bestPrem, stressPrem = 0;
    for (const s of rps.calm) {
      if (s.avgPnl > 0 && s.winRate >= 0.55 && s.premium < effSl * 10) { calmPrem = s.premium; break; }
    }
    for (const s of rps.normal) {
      if (s.avgPnl > 0 && s.winRate >= 0.55 && s.premium < effSl * 10) { normalPrem = s.premium; break; }
    }
    for (const s of rps.stress) {
      if (s.avgPnl > 0 && s.winRate >= 0.55 && s.premium < effSl * 10) { stressPrem = s.premium; break; }
    }

    lines.push(
      `  ${pad(b.sl + "%", 4)} | ${pad(b.tenor + "d", 5)} | ${pad($(youPay, 0), 9)} | ${pad($(payoutPer10k, 0), 15)} | ${pad((payoutPer10k / youPay).toFixed(1) + "×", 18)} | ${pad($(withoutProt, 0), 19)} | ${pad($(calmPrem * 10, 0), 10)} | ${pad($(normalPrem * 10, 0), 11)} | ${stressPrem ? $(stressPrem * 10, 0) : "PAUSE"}`
    );
  }

  // Treasury simulations
  lines.push("\n\n  TREASURY SIMULATION ($100k start, 5 protections/day):\n");
  lines.push("  SL%  | Tenor | Prem/$1k | End Treasury | Min Treasury | Max DD     | Annual P&L | Worst Month | Worst Mo $");
  lines.push("  -----|-------|----------|-------------|-------------|-----------|-----------|------------|----------");

  shown.clear();
  for (const b of allBests) {
    if (shown.has(b.sl)) continue;
    shown.add(b.sl);
    const sim = simulateTreasury(b.windows, "tp", b.bestPrem);
    lines.push(
      `  ${pad(b.sl + "%", 4)} | ${pad(b.tenor + "d", 5)} | ${pad($(b.bestPrem, 0), 8)} | ${pad($(sim.endTreasury, 0), 11)} | ${pad($(sim.minTreasury, 0), 11)} | ${pad($(sim.maxDrawdown, 0), 9)} | ${pad($(sim.annualPnL, 0), 9)} | ${padE(sim.worstMonth, 10)} | ${pad($(sim.worstMonthPnL, 0), 9)}`
    );
  }

  // Alternative pricing ideas
  lines.push("\n\n  ALTERNATIVE STRUCTURES WORTH EXPLORING:\n");
  lines.push("  1. REGIME-DYNAMIC: Charge calm price 60% of the time, normal 30%, pause 10%");
  lines.push("     → Weighted avg premium is much lower than flat pricing");
  lines.push("     → Trader sees fair prices in calm markets, accepts higher in vol markets");
  lines.push("");
  lines.push("  2. SHORT ROLLING PROTECTION: 2-3 day renewables instead of 7-day");
  lines.push("     → Lower per-period cost, trader pays only when they want coverage");
  lines.push("     → Platform buys cheaper short-dated options");
  lines.push("");
  lines.push("  3. PREMIUM REBATE: Return 20-30% of premium if protection expires unused");
  lines.push("     → Increases trader perceived value without affecting triggered-trade economics");
  lines.push("     → Cost: rebate_rate × (1 - trigger_rate) × premium");
  lines.push("");
  lines.push("  4. PUT SPREAD HEDGE (tested above): Buy put spread instead of naked put");
  lines.push("     → Reduces hedge cost significantly");
  lines.push("     → Caps recovery but allows much lower premiums");
  lines.push("");
  lines.push("  5. TIERED COVERAGE: Offer 50/70/100% payout levels at different prices");
  lines.push("     → 70% coverage at 2% SL: payout = $140/10k instead of $200, premium drops ~30%");
  lines.push("");
  lines.push("  6. LOSS-LEADER 10%: Price 10% SL at near-cost to attract users");
  lines.push("     → Outstanding trader value (14×+ return on breach)");
  lines.push("     → Upsell to tighter SL tiers once they're familiar with the product");

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const startTime = Date.now();

  console.log("═".repeat(80));
  console.log("  ATTICUS DEFINITIVE BACKTEST V2: Full Analysis Suite");
  console.log("  " + new Date().toISOString());
  console.log("═".repeat(80));
  console.log();

  console.log("  Fetching BTC daily prices from Coinbase (2022-01-01 to 2026-04-07)...");
  const rawPrices = await fetchBTCPrices("2022-01-01", "2026-04-07");
  console.log(`  ${rawPrices.length} days loaded\n`);
  if (rawPrices.length < 100) throw new Error(`Insufficient data: ${rawPrices.length} days`);

  const dates = rawPrices.map(p => p.date);
  const closes = rawPrices.map(p => p.close);
  console.log(`  Price range: ${$(closes[0], 0)} (${dates[0]}) → ${$(closes[closes.length - 1], 0)} (${dates[dates.length - 1]})`);
  console.log(`  Min: ${$(Math.min(...closes), 0)}, Max: ${$(Math.max(...closes), 0)}\n`);

  const sections: string[] = [];

  sections.push("═".repeat(80));
  sections.push("  ATTICUS DEFINITIVE BACKTEST V2 RESULTS");
  sections.push("  " + new Date().toISOString());
  sections.push(`  ${rawPrices.length} days of BTC data | 5 SL tiers | 5 tenors | 3 strikes | 2 deductibles | 2 vol assumptions`);
  sections.push("═".repeat(80));

  // Phase 1
  console.log("  Running Phase 1A: Trader-centric view...");
  sections.push(genTraderCentric(closes, dates));

  console.log("  Running Phase 1B: Strike placement...");
  sections.push(genStrikePlacement());

  console.log("  Running Phase 1C: Recovery curves...");
  sections.push(genRecoveryCurves(closes, dates));

  console.log("  Running Phase 1D: Win rate grid...");
  sections.push(genWinRateGrid(closes, dates));

  console.log("  Running Phase 1E: Regime pricing...");
  sections.push(genRegimePricing(closes, dates));

  console.log("  Running Phase 1F: 1% pass-through...");
  sections.push(genOnePercentPassthrough(closes, dates));

  // Phase 2
  console.log("  Running Phase 2A: Tenor sweep...");
  sections.push(genTenorSweep(closes, dates));

  console.log("  Running Phase 2B: Tenor detail...");
  sections.push(genTenorDetailForBestSL(closes, dates));

  console.log("  Running Phase 2C: Regime transitions...");
  sections.push(genRegimeTransitions(closes, dates));

  // Phase 3
  console.log("  Running Phase 3: Put spread analysis...");
  sections.push(genPutSpreadAnalysis(closes, dates));

  // Final
  console.log("  Running Final Recommendation...");
  sections.push(genFinalRecommendation(closes, dates));

  const fullOutput = sections.join("\n");

  const outDir = path.resolve("docs/pilot-reports");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "backtest_definitive_v2_results.txt");
  await writeFile(outPath, fullOutput, "utf8");

  console.log(fullOutput);
  console.log(`\n  Results written to: ${outPath}`);
  console.log(`  Total time: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
}

main().catch(e => { console.error("Fatal:", e.message || e); process.exit(1); });
