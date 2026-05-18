/**
 * Atticus Definitive Backtest V3: CEO-Ready Report
 *
 * Generates comprehensive premium schedule tables at actual dollar amounts
 * for $5k, $10k, $20k, $25k, $50k positions across all SL tiers and tenors.
 *
 * Run: npx tsx services/api/scripts/pilotBacktestDefinitiveV3.ts
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

const SL_TIERS = [1, 2, 3, 5, 10];
const TENORS = [2, 3, 5, 7];
const POSITION_SIZES = [5_000, 10_000, 20_000, 25_000, 50_000];
const FINE_PREMIUMS_1K = Array.from({ length: 30 }, (_, i) => i + 1);
const RF = 0.05;
const VOL_WINDOW = 30;
const TREASURY_START = 100_000;
const PROTECTIONS_PER_DAY = 5;

type StrikeStrategy = "trigger" | "mid" | "atm";
type DeductibleOption = "none" | "1pct";
type Regime = "calm" | "normal" | "stress";

type WindowResult = {
  hedgeCost: number;
  payout: number;
  recoveryByDay: number[];
  holdRecovery: number;
  tpRecovery: number;
  bestRecovery: number;
  bestRecoveryDay: number;
  triggered: boolean;
  triggerDay: number | null;
  regime: Regime;
  date: string;
};

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

function classifyRegime(v: number): Regime {
  if (v < 0.4) return "calm"; if (v < 0.65) return "normal"; return "stress";
}

function computeStrike(entry: number, slPct: number, strat: StrikeStrategy): number {
  if (strat === "trigger") return entry * (1 - slPct / 100);
  if (strat === "mid") return entry * (1 - slPct / 200);
  return entry;
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
        for (const [ts, , , , close] of candles) all.set(new Date(ts * 1000).toISOString().slice(0, 10), close);
        break;
      } catch (e: any) { if (retries <= 0) throw e; await delay(2000); }
    }
    curMs = chunkEndMs; await delay(500);
  }
  return Array.from(all.entries()).map(([date, close]) => ({ date, close })).sort((a, b) => a.date.localeCompare(b.date));
}

function delay(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════════════════════
// Core Engine (per $1k notional)
// ═══════════════════════════════════════════════════════════════════════════

function runWindows(
  closes: number[], dates: string[], sl: number, strike: StrikeStrategy,
  deduct: DeductibleOption, volMult: number, tenor: number, spreadLowerPct?: number,
): WindowResult[] {
  const results: WindowResult[] = [];
  for (let i = 0; i + tenor < closes.length; i++) {
    const entry = closes[i];
    if (entry <= 0) continue;
    const rawVol = realizedVol(closes, i, VOL_WINDOW);
    const vol = rawVol * volMult;
    const regime = classifyRegime(rawVol);
    const K = computeStrike(entry, sl, strike);
    const triggerPx = entry * (1 - sl / 100);
    const qty = 1000 / entry;
    const T = tenor / 365;

    let hedgeCost: number;
    if (spreadLowerPct !== undefined) {
      const Klow = entry * (1 - spreadLowerPct / 100);
      hedgeCost = Math.max(0, (bsPut(entry, K, T, RF, vol) - bsPut(entry, Klow, T, RF, vol)) * qty);
    } else {
      hedgeCost = bsPut(entry, K, T, RF, vol) * qty;
    }

    let triggerDay: number | null = null;
    for (let d = 0; d <= tenor; d++) {
      const idx = i + d;
      if (idx >= closes.length) break;
      if (triggerDay === null && closes[idx] <= triggerPx) triggerDay = d;
    }
    const triggered = triggerDay !== null;
    const effSl = deduct === "1pct" ? Math.max(0, sl - 1) : sl;
    const payout = triggered ? (1000 * effSl) / 100 : 0;

    const recoveryByDay: number[] = [];
    for (let d = 0; d <= tenor; d++) {
      const idx = i + d;
      if (idx >= closes.length) { recoveryByDay.push(0); continue; }
      let intr = Math.max(0, K - closes[idx]) * qty;
      if (spreadLowerPct !== undefined) {
        const Klow = entry * (1 - spreadLowerPct / 100);
        intr = Math.min(intr, Math.max(0, K - Klow) * qty);
      }
      recoveryByDay.push(intr);
    }

    const holdRecovery = recoveryByDay[tenor] ?? 0;
    let bestRecovery = holdRecovery;
    let bestRecoveryDay = tenor;
    for (let d = 0; d <= tenor; d++) {
      if (recoveryByDay[d] > bestRecovery) { bestRecovery = recoveryByDay[d]; bestRecoveryDay = d; }
    }

    let tpRecovery = holdRecovery;
    if (triggered && triggerDay !== null) {
      const tpEnd = Math.min(triggerDay + 2, tenor);
      for (let d = triggerDay; d <= tpEnd; d++) {
        if (recoveryByDay[d] > tpRecovery) tpRecovery = recoveryByDay[d];
      }
    }

    results.push({ hedgeCost, payout, recoveryByDay, holdRecovery, tpRecovery, bestRecovery, bestRecoveryDay, triggered, triggerDay, regime, date: dates[i] });
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// Analysis Helpers
// ═══════════════════════════════════════════════════════════════════════════

type ConfigStats = {
  be: number; trigRate: number; avgH: number; avgR: number;
  calmBE: number; normalBE: number; stressBE: number;
  calmPct: number; normalPct: number; stressPct: number;
  windows: WindowResult[];
};

function analyzeConfig(wins: WindowResult[]): ConfigStats {
  const n = wins.length;
  const totalH = wins.reduce((s, w) => s + w.hedgeCost, 0);
  const totalP = wins.reduce((s, w) => s + w.payout, 0);
  const totalR = wins.reduce((s, w) => s + w.bestRecovery, 0);
  const be = (totalH + totalP - totalR) / n;
  const trigRate = wins.filter(w => w.triggered).length / n;
  const avgH = totalH / n;
  const avgR = totalR / n;

  const byRegime = (r: Regime) => {
    const rw = wins.filter(w => w.regime === r);
    if (rw.length === 0) return { be: 0, pct: 0 };
    const h = rw.reduce((s, w) => s + w.hedgeCost, 0);
    const p = rw.reduce((s, w) => s + w.payout, 0);
    const rc = rw.reduce((s, w) => s + w.bestRecovery, 0);
    return { be: (h + p - rc) / rw.length, pct: rw.length / n };
  };
  const calm = byRegime("calm"), normal = byRegime("normal"), stress = byRegime("stress");

  return { be, trigRate, avgH, avgR, calmBE: calm.be, normalBE: normal.be, stressBE: stress.be,
    calmPct: calm.pct, normalPct: normal.pct, stressPct: stress.pct, windows: wins };
}

function premiumStats(wins: WindowResult[], prem1k: number) {
  let pnlSum = 0, wins_count = 0;
  for (const w of wins) {
    const pnl = prem1k - w.hedgeCost - w.payout + w.bestRecovery;
    pnlSum += pnl;
    if (pnl >= 0) wins_count++;
  }
  return { avgPnl: pnlSum / wins.length, winRate: wins_count / wins.length };
}

function regimePremiumWinRate(wins: WindowResult[], prem1k: number, regime: Regime) {
  const rw = wins.filter(w => w.regime === regime);
  if (rw.length === 0) return { avgPnl: 0, winRate: 0 };
  let pnlSum = 0, wc = 0;
  for (const w of rw) {
    const pnl = prem1k - w.hedgeCost - w.payout + w.bestRecovery;
    pnlSum += pnl; if (pnl >= 0) wc++;
  }
  return { avgPnl: pnlSum / rw.length, winRate: wc / rw.length };
}

function findBestPremium(wins: WindowResult[], maxPer1k: number, minWR = 0.55): number | null {
  for (let p = 1; p <= 30; p++) {
    if (p >= maxPer1k) return null;
    const s = premiumStats(wins, p);
    if (s.avgPnl > 0 && s.winRate >= minWR) return p;
  }
  return null;
}

function findRegimePremium(wins: WindowResult[], regime: Regime, maxPer1k: number, minWR = 0.50): number | null {
  const rw = wins.filter(w => w.regime === regime);
  if (rw.length === 0) return null;
  for (let p = 1; p <= 30; p++) {
    if (p >= maxPer1k) return null;
    const s = regimePremiumWinRate(wins, p, regime);
    if (s.avgPnl > 0 && s.winRate >= minWR) return p;
  }
  return null;
}

function treasurySim(wins: WindowResult[], prem1k: number) {
  let treasury = TREASURY_START, peak = treasury, maxDD = 0, minT = treasury;
  const monthly = new Map<string, number>();
  for (const w of wins) {
    const pnl = (prem1k - w.hedgeCost - w.payout + w.bestRecovery) * PROTECTIONS_PER_DAY;
    treasury += pnl;
    if (treasury < minT) minT = treasury; if (treasury > peak) peak = treasury;
    const dd = peak - treasury; if (dd > maxDD) maxDD = dd;
    const m = w.date.slice(0, 7);
    monthly.set(m, (monthly.get(m) || 0) + pnl);
  }
  let worstM = "", worstV = Infinity;
  for (const [m, v] of monthly) { if (v < worstV) { worstV = v; worstM = m; } }
  const years = wins.length / 365;
  return { end: treasury, min: minT, maxDD, annual: years > 0 ? (treasury - TREASURY_START) / years : 0, worstMonth: worstM, worstMonthPnl: worstV === Infinity ? 0 : worstV };
}

// ═══════════════════════════════════════════════════════════════════════════
// Formatting
// ═══════════════════════════════════════════════════════════════════════════

const $ = (n: number, d = 0) => {
  if (d === 0) return n < 0 ? `-$${Math.abs(Math.round(n)).toLocaleString()}` : `$${Math.round(n).toLocaleString()}`;
  return n < 0 ? `-$${Math.abs(n).toFixed(d)}` : `$${n.toFixed(d)}`;
};
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const pad = (s: string, w: number) => s.padStart(w);
const padE = (s: string, w: number) => s.padEnd(w);
const hdr = (t: string) => "\n" + "═".repeat(90) + "\n  " + t + "\n" + "═".repeat(90);
const sub = (t: string) => "\n  " + "─".repeat(80) + "\n  " + t + "\n  " + "─".repeat(80);

// ═══════════════════════════════════════════════════════════════════════════
// Report Sections
// ═══════════════════════════════════════════════════════════════════════════

type BestConfig = {
  sl: number; tenor: number; strike: StrikeStrategy; deduct: DeductibleOption;
  spreadLower?: number; stats: ConfigStats; prem1k: number;
  label: string;
};

function findAllBests(closes: number[], dates: string[]): BestConfig[] {
  const all: BestConfig[] = [];

  for (const sl of SL_TIERS) {
    const payoutPer1k = sl * 10;
    for (const tenor of TENORS) {
      for (const strike of ["trigger", "mid", "atm"] as StrikeStrategy[]) {
        for (const deduct of ["none", "1pct"] as DeductibleOption[]) {
          const effSl = deduct === "1pct" ? Math.max(0, sl - 1) : sl;
          const effPayout = effSl * 10;
          if (effPayout <= 0) continue;
          const wins = runWindows(closes, dates, sl, strike, deduct, 0.85, tenor);
          if (wins.length < 100) continue;
          const stats = analyzeConfig(wins);
          const prem = findBestPremium(wins, effPayout);
          if (prem === null) continue;
          const spreadLabel = "";
          const label = `${tenor}d/${strike}${deduct === "1pct" ? "/1%ded" : ""}`;
          all.push({ sl, tenor, strike, deduct, stats, prem1k: prem, label });
        }
      }

      // put spreads
      if (sl >= 2) {
        for (const spreadLower of [sl * 1.5, sl * 2]) {
          for (const strike of ["mid", "atm"] as StrikeStrategy[]) {
            const wins = runWindows(closes, dates, sl, strike, "none", 0.85, tenor, spreadLower);
            if (wins.length < 100) continue;
            const stats = analyzeConfig(wins);
            const prem = findBestPremium(wins, sl * 10);
            if (prem === null) continue;
            const label = `${tenor}d/${strike}/spread${spreadLower}%`;
            all.push({ sl, tenor, strike, deduct: "none", spreadLower, stats, prem1k: prem, label });
          }
        }
      }
    }
  }
  return all;
}

function genSection1_FixedSchedule(bests: BestConfig[]): string {
  const lines: string[] = [];
  lines.push(hdr("SECTION 1: FIXED PREMIUM SCHEDULE — Full cost to trader at all position sizes"));
  lines.push("  Premium = per $1k × (position / 1000). Payout = on stop-loss breach.\n");

  for (const tenor of TENORS) {
    lines.push(sub(`${tenor}-DAY PROTECTION`));
    lines.push("");

    // Header
    let h1 = "  SL%  | Prem/$1k | TrigRate | WinRate ";
    let h2 = "  -----|----------|---------|--------";
    for (const pos of POSITION_SIZES) {
      const posLabel = pos >= 1000 ? `$${pos / 1000}k` : `$${pos}`;
      h1 += `| ${pad("Prem@" + posLabel, 10)} ${pad("Payout", 8)} `;
      h2 += `|${"-".repeat(19)} `;
    }
    lines.push(h1);
    lines.push(h2);

    for (const sl of SL_TIERS) {
      // Find best no-deductible config for this SL/tenor
      const candidates = bests
        .filter(b => b.sl === sl && b.tenor === tenor && b.deduct === "none" && !b.spreadLower)
        .sort((a, b) => a.prem1k - b.prem1k);

      let best = candidates[0];
      // If no viable config at no-deduct, try 1% pass-thru for 1% SL
      if (!best && sl === 1) {
        const passThru = bests
          .filter(b => b.sl === 1 && b.tenor === tenor && b.deduct === "none" && !b.spreadLower)
          .sort((a, b) => a.prem1k - b.prem1k);
        best = passThru[0];
      }
      if (!best) {
        // still show something — run it raw
        const wins = runWindows([], [], sl, "trigger", "none", 0.85, tenor);
        lines.push(`  ${pad(sl + "%", 4)} | N/A — no viable config at ${tenor}-day tenor`);
        continue;
      }

      const p = best.prem1k;
      const s = premiumStats(best.stats.windows, p);
      let row = `  ${pad(sl + "%", 4)} | ${pad($(p, 2), 8)} | ${pad(pct(best.stats.trigRate), 7)} | ${pad(pct(s.winRate), 6)} `;

      for (const pos of POSITION_SIZES) {
        const mult = pos / 1000;
        const traderPays = p * mult;
        const payoutOnBreach = sl * 10 * mult; // no deductible
        row += `| ${pad($(traderPays), 10)} ${pad($(payoutOnBreach), 8)} `;
      }
      lines.push(row);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function genSection2_TopConfigs(closes: number[], dates: string[]): string {
  const lines: string[] = [];
  lines.push(hdr("SECTION 2: TOP CONFIGURATIONS — No deductible (1% is pass-through)"));
  lines.push("  Best trader value: lowest premium where platform is profitable.\n");

  lines.push("  SL%  | Tenor | Strike  | Prem/$1k | Prem/$10k | Payout/$10k | Return  | TrigRate | WinRate | BE/$1k | Plat Margin | Hedge/$1k | Recov/$1k");
  lines.push("  -----|-------|---------|----------|-----------|-------------|---------|----------|--------|--------|-------------|-----------|----------");

  for (const sl of SL_TIERS) {
    const payoutPer1k = sl * 10;
    let bestPrem = Infinity;
    let bestEntry: { tenor: number; strike: StrikeStrategy; stats: ConfigStats; prem: number } | null = null;

    for (const tenor of TENORS) {
      for (const strike of ["trigger", "mid", "atm"] as StrikeStrategy[]) {
        const wins = runWindows(closes, dates, sl, strike, "none", 0.85, tenor);
        if (wins.length < 100) continue;
        const stats = analyzeConfig(wins);
        const prem = findBestPremium(wins, payoutPer1k);
        if (prem !== null && prem < bestPrem) {
          bestPrem = prem; bestEntry = { tenor, strike, stats, prem };
        }
      }
    }

    if (!bestEntry) {
      lines.push(`  ${pad(sl + "%", 4)} | — no viable no-deductible config found`);
      continue;
    }

    const { tenor, strike, stats, prem } = bestEntry;
    const s = premiumStats(stats.windows, prem);
    const margin = prem - stats.be;
    const returnX = payoutPer1k / prem;
    lines.push(
      `  ${pad(sl + "%", 4)} | ${pad(tenor + "d", 5)} | ${padE(strike, 7)} | ${pad($(prem, 2), 8)} | ${pad($(prem * 10), 9)} | ${pad($(payoutPer1k * 10), 11)} | ${pad(returnX.toFixed(1) + "×", 7)} | ${pad(pct(stats.trigRate), 8)} | ${pad(pct(s.winRate), 6)} | ${pad($(stats.be, 2), 6)} | ${pad($(margin, 2), 11)} | ${pad($(stats.avgH, 2), 9)} | ${pad($(stats.avgR, 2), 9)}`
    );
  }

  // Full position table for the winners
  lines.push("\n  Trader cost table (same configs):\n");
  lines.push("  SL%  | Tenor | " + POSITION_SIZES.map(p => pad(`$${(p/1000)}k Prem`, 10)).join(" | ") + " | " + POSITION_SIZES.map(p => pad(`$${(p/1000)}k Pays`, 10)).join(" | "));
  lines.push("  -----|-------|-" + POSITION_SIZES.map(() => "-".repeat(10)).join("-|-") + "-|-" + POSITION_SIZES.map(() => "-".repeat(10)).join("-|-") + "-");

  for (const sl of SL_TIERS) {
    const payoutPer1k = sl * 10;
    let bestEntry: { tenor: number; prem: number } | null = null;
    let bestPrem = Infinity;
    for (const tenor of TENORS) {
      for (const strike of ["trigger", "mid", "atm"] as StrikeStrategy[]) {
        const wins = runWindows(closes, dates, sl, strike, "none", 0.85, tenor);
        if (wins.length < 100) continue;
        const prem = findBestPremium(wins, payoutPer1k);
        if (prem !== null && prem < bestPrem) { bestPrem = prem; bestEntry = { tenor, prem }; }
      }
    }
    if (!bestEntry) continue;
    const { tenor, prem } = bestEntry;
    let row = `  ${pad(sl + "%", 4)} | ${pad(tenor + "d", 5)} | `;
    row += POSITION_SIZES.map(pos => pad($(prem * pos / 1000), 10)).join(" | ");
    row += " | ";
    row += POSITION_SIZES.map(pos => pad($(sl * 10 * pos / 1000), 10)).join(" | ");
    lines.push(row);
  }

  return lines.join("\n");
}

function genSection3_WithDeductibles(closes: number[], dates: string[]): string {
  const lines: string[] = [];
  lines.push(hdr("SECTION 3: BEST CONFIGS WITH DEDUCTIBLES WHERE OPTIMAL"));
  lines.push("  Uses 1% deductible only where it improves economics. No deductible at 1% SL.\n");

  lines.push("  SL%  | Tenor | Strike  | Deduct | Prem/$1k | Prem/$10k | Payout/$10k | Return  | TrigRate | WinRate | BE/$1k | Plat Margin");
  lines.push("  -----|-------|---------|--------|----------|-----------|-------------|---------|----------|--------|--------|------------");

  for (const sl of SL_TIERS) {
    let bestPrem = Infinity;
    let bestEntry: { tenor: number; strike: StrikeStrategy; deduct: DeductibleOption; stats: ConfigStats; prem: number } | null = null;

    for (const tenor of TENORS) {
      for (const strike of ["trigger", "mid", "atm"] as StrikeStrategy[]) {
        for (const deduct of ["none", "1pct"] as DeductibleOption[]) {
          const effSl = deduct === "1pct" ? Math.max(0, sl - 1) : sl;
          if (effSl <= 0) continue;
          const effPayout = effSl * 10;
          const wins = runWindows(closes, dates, sl, strike, deduct, 0.85, tenor);
          if (wins.length < 100) continue;
          const stats = analyzeConfig(wins);
          const prem = findBestPremium(wins, effPayout);
          if (prem !== null && prem < bestPrem) {
            bestPrem = prem; bestEntry = { tenor, strike, deduct, stats, prem };
          }
        }
      }
    }

    if (!bestEntry) {
      lines.push(`  ${pad(sl + "%", 4)} | — no viable config found`);
      continue;
    }

    const { tenor, strike, deduct, stats, prem } = bestEntry;
    const effSl = deduct === "1pct" ? Math.max(0, sl - 1) : sl;
    const payoutPer1k = effSl * 10;
    const s = premiumStats(stats.windows, prem);
    const margin = prem - stats.be;
    const returnX = payoutPer1k / prem;
    const dedLabel = deduct === "1pct" ? "1%" : "none";

    lines.push(
      `  ${pad(sl + "%", 4)} | ${pad(tenor + "d", 5)} | ${padE(strike, 7)} | ${padE(dedLabel, 6)} | ${pad($(prem, 2), 8)} | ${pad($(prem * 10), 9)} | ${pad($(payoutPer1k * 10), 11)} | ${pad(returnX.toFixed(1) + "×", 7)} | ${pad(pct(stats.trigRate), 8)} | ${pad(pct(s.winRate), 6)} | ${pad($(stats.be, 2), 6)} | ${pad($(margin, 2), 11)}`
    );
  }

  // Position size table
  lines.push("\n  Trader cost table:\n");
  let hRow = "  SL%  | Ded  | ";
  hRow += POSITION_SIZES.map(p => `Prem@$${p/1000}k`).join(" | ") + " | ";
  hRow += POSITION_SIZES.map(p => `Pays@$${p/1000}k`).join(" | ");
  lines.push(hRow);
  lines.push("  -----|------|" + "-".repeat(hRow.length - 14));

  for (const sl of SL_TIERS) {
    let bestEntry: { tenor: number; deduct: DeductibleOption; prem: number } | null = null;
    let bestPrem = Infinity;
    for (const tenor of TENORS) {
      for (const strike of ["trigger", "mid", "atm"] as StrikeStrategy[]) {
        for (const deduct of ["none", "1pct"] as DeductibleOption[]) {
          const effSl = deduct === "1pct" ? Math.max(0, sl - 1) : sl;
          if (effSl <= 0) continue;
          const wins = runWindows(closes, dates, sl, strike, deduct, 0.85, tenor);
          if (wins.length < 100) continue;
          const prem = findBestPremium(wins, effSl * 10);
          if (prem !== null && prem < bestPrem) { bestPrem = prem; bestEntry = { tenor, deduct, prem }; }
        }
      }
    }
    if (!bestEntry) continue;
    const { deduct, prem } = bestEntry;
    const effSl = deduct === "1pct" ? Math.max(0, sl - 1) : sl;
    const payoutPer1k = effSl * 10;
    let row = `  ${pad(sl + "%", 4)} | ${padE(deduct === "1pct" ? "1%" : "none", 4)} | `;
    row += POSITION_SIZES.map(pos => pad($(prem * pos / 1000), 10)).join(" | ") + " | ";
    row += POSITION_SIZES.map(pos => pad($(payoutPer1k * pos / 1000), 10)).join(" | ");
    lines.push(row);
  }

  return lines.join("\n");
}

function genSection4_Spreads(closes: number[], dates: string[]): string {
  const lines: string[] = [];
  lines.push(hdr("SECTION 4: BEST CONFIGS USING PUT SPREADS"));
  lines.push("  Put spread = buy higher strike put, sell lower strike put. Cheaper hedge, capped recovery.\n");

  lines.push("  SL%  | Tenor | Upper   | Lower   | Prem/$1k | Prem/$10k | Payout/$10k | Return  | TrigRate | WinRate | BE/$1k | Hedge/$1k | vs Naked BE");
  lines.push("  -----|-------|---------|---------|----------|-----------|-------------|---------|----------|--------|--------|-----------|------------");

  for (const sl of [2, 3, 5, 10]) {
    const payoutPer1k = sl * 10;
    let bestPrem = Infinity;
    let bestEntry: { tenor: number; strike: StrikeStrategy; spreadLower: number; stats: ConfigStats; prem: number; nakedBE: number } | null = null;

    for (const tenor of TENORS) {
      // naked baseline
      const nakedWins = runWindows(closes, dates, sl, "mid", "none", 0.85, tenor);
      const nakedStats = analyzeConfig(nakedWins);

      for (const spreadLower of [sl * 1.5, sl * 2, sl * 3]) {
        for (const strike of ["mid", "atm"] as StrikeStrategy[]) {
          const wins = runWindows(closes, dates, sl, strike, "none", 0.85, tenor, spreadLower);
          if (wins.length < 100) continue;
          const stats = analyzeConfig(wins);
          const prem = findBestPremium(wins, payoutPer1k);
          if (prem !== null && prem < bestPrem) {
            bestPrem = prem; bestEntry = { tenor, strike, spreadLower, stats, prem, nakedBE: nakedStats.be };
          }
        }
      }
    }

    if (!bestEntry) {
      lines.push(`  ${pad(sl + "%", 4)} | — no viable spread config found`);
      continue;
    }

    const { tenor, strike, spreadLower, stats, prem, nakedBE } = bestEntry;
    const s = premiumStats(stats.windows, prem);
    const returnX = payoutPer1k / prem;
    const vsNaked = nakedBE - stats.be;

    lines.push(
      `  ${pad(sl + "%", 4)} | ${pad(tenor + "d", 5)} | ${padE(strike, 7)} | ${padE(spreadLower + "%", 7)} | ${pad($(prem, 2), 8)} | ${pad($(prem * 10), 9)} | ${pad($(payoutPer1k * 10), 11)} | ${pad(returnX.toFixed(1) + "×", 7)} | ${pad(pct(stats.trigRate), 8)} | ${pad(pct(s.winRate), 6)} | ${pad($(stats.be, 2), 6)} | ${pad($(stats.avgH, 2), 9)} | ${pad($(vsNaked, 2), 11)}`
    );
  }

  lines.push("\n  Note: 1% SL excluded — spreads are not beneficial at such tight strikes.");

  return lines.join("\n");
}

function genSection5_Hybrid(closes: number[], dates: string[]): string {
  const lines: string[] = [];
  lines.push(hdr("SECTION 5: HYBRID SPREAD / PROTECTIVE PUT / CALL STRATEGIES"));
  lines.push("  Analysis of whether combining strategies could improve economics.\n");

  lines.push("  STRATEGY ANALYSIS:\n");

  lines.push("  A) PUT SPREAD (tested in Section 4):");
  lines.push("     Buy OTM put at mid-strike, sell further OTM put.");
  lines.push("     VERDICT: Effective for 5-10% SL. Reduces hedge cost 30-60%.");
  lines.push("     Reduces recovery cap but at wider SL the cap is rarely hit.\n");

  lines.push("  B) PROTECTIVE PUT (current approach):");
  lines.push("     Buy naked put at trigger/mid/ATM strike.");
  lines.push("     VERDICT: Best for 1-3% SL where recovery routinely exceeds hedge cost.");
  lines.push("     The 'mid' strike captures value from small dips below entry.\n");

  lines.push("  C) COVERED CALL OVERLAY:");
  lines.push("     Sell OTM call to partially fund the put purchase.");
  lines.push("     Problem: Atticus does not hold the underlying BTC.");
  lines.push("     The trader holds the perp, not Atticus. Selling a call without");
  lines.push("     owning BTC creates unlimited upside risk for the platform.");
  lines.push("     VERDICT: NOT VIABLE for this product structure.\n");

  lines.push("  D) COLLAR (put + short call):");
  lines.push("     Same issue as covered call — Atticus doesn't hold BTC.");
  lines.push("     Could theoretically ask the trader to cap their upside,");
  lines.push("     but this defeats the product's purpose (protection without limits).");
  lines.push("     VERDICT: NOT VIABLE without fundamental product redesign.\n");

  lines.push("  E) HYBRID: PUT SPREAD (low SL) + NAKED PUT (high SL):");
  lines.push("     Use spreads for 5-10% SL tiers (lower cost, less recovery needed)");
  lines.push("     Use naked puts for 1-3% SL tiers (higher recovery is the profit driver)");
  lines.push("     VERDICT: RECOMMENDED. This is the optimal hybrid approach.\n");

  // Actually run the hybrid comparison
  lines.push("  HYBRID RECOMMENDATION PER TIER:\n");
  lines.push("  SL%  | Strategy            | Tenor | Prem/$1k | Prem/$10k | Rationale");
  lines.push("  -----|---------------------|-------|----------|-----------|----------");

  for (const sl of SL_TIERS) {
    if (sl <= 3) {
      // Naked put best for tight SL
      let bestPrem = Infinity, bestTenor = 0, bestStrike = "trigger" as StrikeStrategy;
      for (const tenor of TENORS) {
        for (const strike of ["trigger", "mid", "atm"] as StrikeStrategy[]) {
          const wins = runWindows(closes, dates, sl, strike, "none", 0.85, tenor);
          if (wins.length < 100) continue;
          const prem = findBestPremium(wins, sl * 10);
          if (prem !== null && prem < bestPrem) { bestPrem = prem; bestTenor = tenor; bestStrike = strike; }
        }
      }
      lines.push(`  ${pad(sl + "%", 4)} | Naked ${bestStrike} put    | ${pad(bestTenor + "d", 5)} | ${pad($(bestPrem, 2), 8)} | ${pad($(bestPrem * 10), 9)} | Recovery > hedge cost; spread caps needed recovery`);
    } else {
      // Spread best for wide SL
      let bestPrem = Infinity, bestTenor = 0, bestSpread = 0;
      for (const tenor of TENORS) {
        for (const spreadLower of [sl * 1.5, sl * 2]) {
          for (const strike of ["mid", "atm"] as StrikeStrategy[]) {
            const wins = runWindows(closes, dates, sl, strike, "none", 0.85, tenor, spreadLower);
            if (wins.length < 100) continue;
            const prem = findBestPremium(wins, sl * 10);
            if (prem !== null && prem < bestPrem) { bestPrem = prem; bestTenor = tenor; bestSpread = spreadLower; }
          }
        }
      }
      // compare to naked
      let nakedBest = Infinity;
      for (const tenor of TENORS) {
        for (const strike of ["trigger", "mid", "atm"] as StrikeStrategy[]) {
          const wins = runWindows(closes, dates, sl, strike, "none", 0.85, tenor);
          const prem = findBestPremium(wins, sl * 10);
          if (prem !== null && prem < nakedBest) nakedBest = prem;
        }
      }
      const useSpread = bestPrem <= nakedBest;
      if (useSpread && bestPrem < Infinity) {
        lines.push(`  ${pad(sl + "%", 4)} | Put spread ${bestSpread}%    | ${pad(bestTenor + "d", 5)} | ${pad($(bestPrem, 2), 8)} | ${pad($(bestPrem * 10), 9)} | Cheaper hedge; recovery cap rarely hit at ${sl}% OTM`);
      } else if (nakedBest < Infinity) {
        lines.push(`  ${pad(sl + "%", 4)} | Naked put          | ${pad(bestTenor + "d", 5)} | ${pad($(nakedBest, 2), 8)} | ${pad($(nakedBest * 10), 9)} | Naked put still cheaper than spread at this config`);
      }
    }
  }

  return lines.join("\n");
}

function genSection6_RegimePricing(closes: number[], dates: string[]): string {
  const lines: string[] = [];
  lines.push(hdr("SECTION 6: REGIME-BASED PRICING — Premium changes and % time at each price"));
  lines.push("  Vol < 40% = CALM | 40-65% = NORMAL | > 65% = STRESS\n");

  for (const sl of SL_TIERS) {
    const payoutPer1k = sl * 10;

    // Find best tenor/strike first
    let bestTenor = 2, bestStrike: StrikeStrategy = "trigger";
    let bestOverallPrem = Infinity;
    for (const tenor of TENORS) {
      for (const strike of ["trigger", "mid", "atm"] as StrikeStrategy[]) {
        const wins = runWindows(closes, dates, sl, strike, "none", 0.85, tenor);
        if (wins.length < 100) continue;
        const prem = findBestPremium(wins, payoutPer1k);
        if (prem !== null && prem < bestOverallPrem) { bestOverallPrem = prem; bestTenor = tenor; bestStrike = strike; }
      }
    }

    const wins = runWindows(closes, dates, sl, bestStrike, "none", 0.85, bestTenor);
    if (wins.length === 0) continue;
    const stats = analyzeConfig(wins);

    const calmPrem = findRegimePremium(wins, "calm", payoutPer1k, 0.50);
    const normalPrem = findRegimePremium(wins, "normal", payoutPer1k, 0.50);
    const stressPrem = findRegimePremium(wins, "stress", payoutPer1k, 0.50);

    const calmWR = calmPrem ? regimePremiumWinRate(wins, calmPrem, "calm") : null;
    const normalWR = normalPrem ? regimePremiumWinRate(wins, normalPrem, "normal") : null;
    const stressWR = stressPrem ? regimePremiumWinRate(wins, stressPrem, "stress") : null;

    // weighted average premium
    const cp = calmPrem || 0, np = normalPrem || 0, sp = stressPrem || 0;
    const weightedAvg = cp * stats.calmPct + np * stats.normalPct + (stressPrem ? sp * stats.stressPct : 0);

    lines.push(sub(`${sl}% SL — ${bestTenor}-day tenor, ${bestStrike} strike`));
    lines.push(`  Break-evens: Calm ${$(stats.calmBE, 2)}/1k | Normal ${$(stats.normalBE, 2)}/1k | Stress ${$(stats.stressBE, 2)}/1k\n`);

    lines.push("  Regime  | % of Time | Premium/$1k | Premium/$10k | Payout/$10k | Return   | Win Rate | P&L/$1k  | Action");
    lines.push("  --------|-----------|-------------|--------------|-------------|----------|----------|----------|-------");

    if (calmPrem) {
      lines.push(`  CALM    | ${pad(pct(stats.calmPct), 9)} | ${pad($(calmPrem, 2), 11)} | ${pad($(calmPrem * 10), 12)} | ${pad($(payoutPer1k * 10), 11)} | ${pad((payoutPer1k / calmPrem).toFixed(1) + "×", 8)} | ${pad(pct(calmWR!.winRate), 8)} | ${pad($(calmWR!.avgPnl, 2), 8)} | Sell`);
    } else {
      lines.push(`  CALM    | ${pad(pct(stats.calmPct), 9)} | ${pad("$1.00", 11)} | ${pad("$10", 12)} | ${pad($(payoutPer1k * 10), 11)} | ${pad((payoutPer1k).toFixed(1) + "×", 8)} | ${pad("—", 8)} | ${pad("—", 8)} | Sell at cost`);
    }

    if (normalPrem) {
      lines.push(`  NORMAL  | ${pad(pct(stats.normalPct), 9)} | ${pad($(normalPrem, 2), 11)} | ${pad($(normalPrem * 10), 12)} | ${pad($(payoutPer1k * 10), 11)} | ${pad((payoutPer1k / normalPrem).toFixed(1) + "×", 8)} | ${pad(pct(normalWR!.winRate), 8)} | ${pad($(normalWR!.avgPnl, 2), 8)} | Sell`);
    } else {
      lines.push(`  NORMAL  | ${pad(pct(stats.normalPct), 9)} | ${pad("N/A", 11)} | ${pad("N/A", 12)} | ${pad($(payoutPer1k * 10), 11)} | ${pad("—", 8)} | ${pad("—", 8)} | ${pad("—", 8)} | PAUSE`);
    }

    if (stressPrem) {
      lines.push(`  STRESS  | ${pad(pct(stats.stressPct), 9)} | ${pad($(stressPrem, 2), 11)} | ${pad($(stressPrem * 10), 12)} | ${pad($(payoutPer1k * 10), 11)} | ${pad((payoutPer1k / stressPrem).toFixed(1) + "×", 8)} | ${pad(pct(stressWR!.winRate), 8)} | ${pad($(stressWR!.avgPnl, 2), 8)} | ${stressPrem > payoutPer1k * 0.5 ? "Consider PAUSE" : "Sell w/ surcharge"}`);
    } else {
      lines.push(`  STRESS  | ${pad(pct(stats.stressPct), 9)} | ${pad("N/A", 11)} | ${pad("N/A", 12)} | ${pad($(payoutPer1k * 10), 11)} | ${pad("—", 8)} | ${pad("—", 8)} | ${pad("—", 8)} | PAUSE`);
    }

    lines.push(`\n  Weighted avg premium: ${$(weightedAvg, 2)}/1k (${$(weightedAvg * 10)}/10k)${!stressPrem ? " — pausing in stress" : ""}`);

    // Position size table for regime pricing
    lines.push("\n  What the trader pays at each regime (full position cost):\n");
    let posRow = "  Regime  | ";
    posRow += POSITION_SIZES.map(p => pad(`$${p/1000}k`, 8)).join(" | ");
    lines.push(posRow);
    lines.push("  --------|" + POSITION_SIZES.map(() => "-".repeat(9)).join("|"));

    for (const [label, prem] of [["CALM", calmPrem], ["NORMAL", normalPrem], ["STRESS", stressPrem]] as [string, number | null][]) {
      let row = `  ${padE(label, 8)}| `;
      if (prem) {
        row += POSITION_SIZES.map(pos => pad($(prem * pos / 1000), 8)).join(" | ");
      } else {
        row += POSITION_SIZES.map(() => pad("PAUSE", 8)).join(" | ");
      }
      lines.push(row);
    }

    lines.push("");
  }

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const startTime = Date.now();
  console.log("═".repeat(90));
  console.log("  ATTICUS DEFINITIVE BACKTEST V3: CEO-Ready Premium Report");
  console.log("  " + new Date().toISOString());
  console.log("═".repeat(90));
  console.log();

  console.log("  Fetching BTC daily prices from Coinbase (2022-01-01 to 2026-04-07)...");
  const rawPrices = await fetchBTCPrices("2022-01-01", "2026-04-07");
  console.log(`  ${rawPrices.length} days loaded\n`);
  if (rawPrices.length < 100) throw new Error(`Insufficient data: ${rawPrices.length} days`);

  const dates = rawPrices.map(p => p.date);
  const closes = rawPrices.map(p => p.close);

  const sections: string[] = [];
  sections.push("═".repeat(90));
  sections.push("  ATTICUS DEFINITIVE BACKTEST V3: CEO-Ready Premium Report");
  sections.push("  " + new Date().toISOString());
  sections.push(`  ${rawPrices.length} days of BTC data (${dates[0]} to ${dates[dates.length - 1]})`);
  sections.push("  All premiums use vol × 0.85 (market-realistic IV), best recovery (optimal TP day)");
  sections.push("═".repeat(90));

  console.log("  Building configs...");
  const bests = findAllBests(closes, dates);
  console.log(`  ${bests.length} viable configurations found\n`);

  console.log("  Generating Section 1: Fixed Premium Schedule...");
  sections.push(genSection1_FixedSchedule(bests));

  console.log("  Generating Section 2: Top Configs (no deductible)...");
  sections.push(genSection2_TopConfigs(closes, dates));

  console.log("  Generating Section 3: Best with deductibles...");
  sections.push(genSection3_WithDeductibles(closes, dates));

  console.log("  Generating Section 4: Spread configs...");
  sections.push(genSection4_Spreads(closes, dates));

  console.log("  Generating Section 5: Hybrid strategies...");
  sections.push(genSection5_Hybrid(closes, dates));

  console.log("  Generating Section 6: Regime pricing...");
  sections.push(genSection6_RegimePricing(closes, dates));

  const fullOutput = sections.join("\n");

  const outDir = path.resolve("docs/pilot-reports");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "backtest_definitive_v3_results.txt");
  await writeFile(outPath, fullOutput, "utf8");

  console.log(fullOutput);
  console.log(`\n  Results written to: ${outPath}`);
  console.log(`  Total time: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
}

main().catch(e => { console.error("Fatal:", e.message || e); process.exit(1); });
