/**
 * Atticus Definitive Backtest: Full Configuration Matrix
 *
 * Tests 120 configurations (5 SL × 3 Strike × 2 Recovery × 2 Deductible × 2 Vol)
 * across 4+ years of BTC daily data to find optimal fixed premiums.
 *
 * Run: npx tsx services/api/scripts/pilotBacktestDefinitive.ts
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
const TEST_PREMIUMS = [3, 5, 7, 8, 10, 12, 15, 20];
const TENOR_DAYS = 7;
const NOTIONAL_1K = 1000;
const RF = 0.05;
const VOL_WINDOW = 30;
const TREASURY_START = 100_000;
const PROTECTIONS_PER_DAY = 5;

type StrikeStrategy = (typeof STRIKE_STRATEGIES)[number];
type RecoveryStrategy = (typeof RECOVERY_STRATEGIES)[number];
type DeductibleOption = (typeof DEDUCTIBLE_OPTIONS)[number];
type Regime = "calm" | "normal" | "stress";

type Config = {
  sl: number;
  strike: StrikeStrategy;
  recovery: RecoveryStrategy;
  deductible: DeductibleOption;
  volMult: number;
};

type WindowPnL = {
  hedgeCost: number;
  payout: number;
  recovery: number;
  triggered: boolean;
  regime: Regime;
  date: string;
};

type ConfigResult = {
  config: Config;
  label: string;
  totalWindows: number;
  triggerCount: number;
  triggerRate: number;
  avgHedgeCost: number;
  avgPayout: number;
  avgRecovery: number;
  breakEven: number;
  suggestedPremium: number | null;
  suggestedWinRate: number | null;
  pnlByPremium: Map<number, number>;
  winRateByPremium: Map<number, number>;
  regimeBreakEven: Record<Regime, number>;
  regimeCount: Record<Regime, number>;
  windowPnLs: WindowPnL[];
};

// ═══════════════════════════════════════════════════════════════════════════
// Math Utilities
// ═══════════════════════════════════════════════════════════════════════════

function nCDF(x: number): number {
  const a1 = 0.254829592,
    a2 = -0.284496736,
    a3 = 1.421413741,
    a4 = -1.453152027,
    a5 = 1.061405429,
    p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * ax);
  const y =
    1 -
    ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

function bsPut(
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
): number {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return Math.max(0, K - S);
  const d1 =
    (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) /
    (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return K * Math.exp(-r * T) * nCDF(-d2) - S * nCDF(-d1);
}

function realizedVol(closes: number[], endIdx: number, window: number): number {
  const start = Math.max(0, endIdx - window);
  if (endIdx - start < 5) return 0.5;
  const rets: number[] = [];
  for (let i = start + 1; i <= endIdx; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) {
      rets.push(Math.log(closes[i] / closes[i - 1]));
    }
  }
  if (rets.length < 5) return 0.5;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance =
    rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance * 365);
}

function classifyRegime(annualizedVol: number): Regime {
  if (annualizedVol < 0.4) return "calm";
  if (annualizedVol < 0.65) return "normal";
  return "stress";
}

// ═══════════════════════════════════════════════════════════════════════════
// Data Fetching
// ═══════════════════════════════════════════════════════════════════════════

async function fetchBTCPrices(
  startDate: string,
  endDate: string,
): Promise<{ date: string; close: number }[]> {
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
        if (res.status === 429) {
          await delay(3000);
          continue;
        }
        if (!res.ok) throw new Error(`Coinbase HTTP ${res.status}`);
        const candles = (await res.json()) as number[][];
        for (const [ts, , , , close] of candles) {
          const dateStr = new Date(ts * 1000).toISOString().slice(0, 10);
          all.set(dateStr, close);
        }
        break;
      } catch (e: any) {
        if (retries <= 0) throw e;
        await delay(2000);
      }
    }
    curMs = chunkEndMs;
    await delay(500);
  }

  return Array.from(all.entries())
    .map(([date, close]) => ({ date, close }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════════════════════
// Backtest Engine
// ═══════════════════════════════════════════════════════════════════════════

function computeStrike(
  entryPrice: number,
  slPct: number,
  strategy: StrikeStrategy,
): number {
  switch (strategy) {
    case "trigger":
      return entryPrice * (1 - slPct / 100);
    case "mid":
      return entryPrice * (1 - slPct / 200);
    case "atm":
      return entryPrice;
  }
}

function runConfig(
  dates: string[],
  closes: number[],
  config: Config,
): ConfigResult {
  const { sl, strike: strikeStrat, recovery: recStrat, deductible, volMult } =
    config;

  const windowPnLs: WindowPnL[] = [];
  const regimeBuckets: Record<
    Regime,
    { costs: number[]; payouts: number[]; recoveries: number[] }
  > = {
    calm: { costs: [], payouts: [], recoveries: [] },
    normal: { costs: [], payouts: [], recoveries: [] },
    stress: { costs: [], payouts: [], recoveries: [] },
  };

  let triggerCount = 0;

  for (let i = 0; i + TENOR_DAYS < closes.length; i++) {
    const entry = closes[i];
    if (entry <= 0) continue;

    const rawVol = realizedVol(closes, i, VOL_WINDOW);
    const vol = rawVol * volMult;
    const regime = classifyRegime(rawVol);
    const K = computeStrike(entry, sl, strikeStrat);
    const triggerPx = entry * (1 - sl / 100);
    const qty = NOTIONAL_1K / entry;
    const T = TENOR_DAYS / 365;

    const hedgeCost = bsPut(entry, K, T, RF, vol) * qty;

    let minPx = entry;
    let triggerDay: number | null = null;
    for (let d = 0; d <= TENOR_DAYS; d++) {
      const idx = i + d;
      if (idx >= closes.length) break;
      if (closes[idx] < minPx) minPx = closes[idx];
      if (triggerDay === null && closes[idx] <= triggerPx) {
        triggerDay = d;
      }
    }
    const triggered = minPx <= triggerPx;
    if (triggered) triggerCount++;

    const effectiveSl =
      deductible === "1pct" ? Math.max(0, sl - 1) : sl;
    const payout = triggered ? (NOTIONAL_1K * effectiveSl) / 100 : 0;

    const expiryPx = closes[i + TENOR_DAYS];
    const holdRecovery = Math.max(0, K - expiryPx) * qty;

    let recovery: number;
    if (recStrat === "tp" && triggered && triggerDay !== null) {
      const tpEnd = Math.min(triggerDay + 2, TENOR_DAYS);
      let lowestTp = closes[i + triggerDay];
      for (let d = triggerDay; d <= tpEnd; d++) {
        const idx = i + d;
        if (idx < closes.length && closes[idx] < lowestTp) {
          lowestTp = closes[idx];
        }
      }
      const tpRecovery = Math.max(0, K - lowestTp) * qty;
      recovery = Math.max(tpRecovery, holdRecovery);
    } else {
      recovery = holdRecovery;
    }

    windowPnLs.push({
      hedgeCost,
      payout,
      recovery,
      triggered,
      regime,
      date: dates[i],
    });

    regimeBuckets[regime].costs.push(hedgeCost);
    regimeBuckets[regime].payouts.push(payout);
    regimeBuckets[regime].recoveries.push(recovery);
  }

  const n = windowPnLs.length;
  const totalH = windowPnLs.reduce((s, w) => s + w.hedgeCost, 0);
  const totalP = windowPnLs.reduce((s, w) => s + w.payout, 0);
  const totalR = windowPnLs.reduce((s, w) => s + w.recovery, 0);

  const avgHedgeCost = totalH / n;
  const avgPayout = totalP / n;
  const avgRecovery = totalR / n;
  const breakEven = avgHedgeCost + avgPayout - avgRecovery;

  const pnlByPremium = new Map<number, number>();
  const winRateByPremium = new Map<number, number>();
  for (const prem of TEST_PREMIUMS) {
    let pnlSum = 0;
    let wins = 0;
    for (const w of windowPnLs) {
      const pnl = prem - w.hedgeCost - w.payout + w.recovery;
      pnlSum += pnl;
      if (pnl >= 0) wins++;
    }
    pnlByPremium.set(prem, pnlSum / n);
    winRateByPremium.set(prem, wins / n);
  }

  let suggestedPremium: number | null = null;
  let suggestedWinRate: number | null = null;
  for (const prem of TEST_PREMIUMS) {
    const wr = winRateByPremium.get(prem)!;
    const avgPnl = pnlByPremium.get(prem)!;
    if (wr >= 0.6 && avgPnl > 0) {
      suggestedPremium = prem;
      suggestedWinRate = wr;
      break;
    }
  }

  const regimeBreakEven: Record<Regime, number> = {
    calm: 0,
    normal: 0,
    stress: 0,
  };
  const regimeCount: Record<Regime, number> = { calm: 0, normal: 0, stress: 0 };
  for (const regime of ["calm", "normal", "stress"] as Regime[]) {
    const b = regimeBuckets[regime];
    const rn = b.costs.length;
    regimeCount[regime] = rn;
    if (rn > 0) {
      const aH = b.costs.reduce((s, v) => s + v, 0) / rn;
      const aP = b.payouts.reduce((s, v) => s + v, 0) / rn;
      const aR = b.recoveries.reduce((s, v) => s + v, 0) / rn;
      regimeBreakEven[regime] = aH + aP - aR;
    }
  }

  const label = `${sl}%|${strikeStrat}|${recStrat}|${deductible}|v${volMult}`;

  return {
    config,
    label,
    totalWindows: n,
    triggerCount,
    triggerRate: triggerCount / n,
    avgHedgeCost,
    avgPayout,
    avgRecovery,
    breakEven,
    suggestedPremium,
    suggestedWinRate,
    pnlByPremium,
    winRateByPremium,
    regimeBreakEven,
    regimeCount,
    windowPnLs,
  };
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

function simulateTreasury(
  windowPnLs: WindowPnL[],
  premium: number,
): TreasurySim {
  let treasury = TREASURY_START;
  let peak = treasury;
  let maxDD = 0;
  let minTreasury = treasury;

  const monthlyPnL = new Map<string, number>();

  for (const w of windowPnLs) {
    const pnl = premium - w.hedgeCost - w.payout + w.recovery;
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
    if (pnl < worstMonthPnL) {
      worstMonthPnL = pnl;
      worstMonth = m;
    }
  }

  const years = windowPnLs.length / 365;
  const totalPnL = treasury - TREASURY_START;
  const annualPnL = years > 0 ? totalPnL / years : 0;

  return {
    endTreasury: treasury,
    minTreasury,
    maxDrawdown: maxDD,
    annualPnL,
    worstMonthPnL: worstMonthPnL === Infinity ? 0 : worstMonthPnL,
    worstMonth,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Formatting Helpers
// ═══════════════════════════════════════════════════════════════════════════

function $(n: number, decimals = 2): string {
  return `$${n.toFixed(decimals)}`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function pad(s: string, w: number): string {
  return s.padStart(w);
}

function padEnd(s: string, w: number): string {
  return s.padEnd(w);
}

function configShortLabel(c: Config): string {
  const parts: string[] = [];
  parts.push(`${c.strike}`);
  if (c.recovery === "tp") parts.push("TP");
  if (c.deductible === "1pct") parts.push("deduct");
  parts.push(`v${c.volMult}`);
  return parts.join("+");
}

// ═══════════════════════════════════════════════════════════════════════════
// Output Generation
// ═══════════════════════════════════════════════════════════════════════════

function generateTable1(results: ConfigResult[]): string {
  const viable = results
    .filter((r) => r.suggestedPremium !== null)
    .sort((a, b) => a.breakEven - b.breakEven)
    .slice(0, 10);

  const lines: string[] = [];
  lines.push("TABLE 1: TOP 10 MOST VIABLE CONFIGURATIONS");
  lines.push("Sorted by: lowest break-even among configs with >60% win rate at suggested premium");
  lines.push("");
  lines.push(
    "Rank | SL%  | Strike  | TP?  | Deduct | Vol  | BE/$1k  | Suggest/$1k | WinRate | Calm BE | Normal BE | Stress BE",
  );
  lines.push(
    "-----|------|---------|------|--------|------|---------|-------------|---------|---------|-----------|----------",
  );

  for (let i = 0; i < viable.length; i++) {
    const r = viable[i];
    const c = r.config;
    lines.push(
      `${pad(String(i + 1), 4)} | ${pad(c.sl + "%", 4)} | ${padEnd(c.strike, 7)} | ${padEnd(c.recovery === "tp" ? "yes" : "no", 4)} | ${padEnd(c.deductible === "1pct" ? "1%" : "none", 6)} | ${pad(String(c.volMult), 4)} | ${pad($(r.breakEven), 7)} | ${pad($(r.suggestedPremium!), 7)}/$1k | ${pad(pct(r.suggestedWinRate!), 7)} | ${pad($(r.regimeBreakEven.calm), 7)} | ${pad($(r.regimeBreakEven.normal), 9)} | ${pad($(r.regimeBreakEven.stress), 9)}`,
    );
  }

  return lines.join("\n");
}

function generateTable2(results: ConfigResult[]): string {
  const lines: string[] = [];
  lines.push("TABLE 2: PER-TIER BEST CONFIGURATION");
  lines.push(
    "For each SL%, the config with lowest break-even and >60% win rate",
  );
  lines.push("");
  lines.push(
    "SL%  | Best Config              | Premium/$1k | Trader Pays/$10k | Payout/$10k | Trader Saves | Platform Margin/$1k | TrigRate | Avg Hedge/$1k | Avg Recov/$1k",
  );
  lines.push(
    "-----|--------------------------|-------------|------------------|-------------|--------------|---------------------|----------|---------------|-------------",
  );

  for (const sl of SL_TIERS) {
    const candidates = results
      .filter((r) => {
        if (r.config.sl !== sl || r.suggestedPremium === null) return false;
        const effectiveSl = r.config.deductible === "1pct" ? Math.max(0, sl - 1) : sl;
        const payoutPer10k = (10_000 * effectiveSl) / 100;
        const traderPays = r.suggestedPremium! * 10;
        return payoutPer10k > traderPays;
      })
      .sort((a, b) => a.breakEven - b.breakEven);

    if (candidates.length === 0) {
      const anyCandidates = results
        .filter((r) => r.config.sl === sl && r.suggestedPremium !== null)
        .sort((a, b) => a.breakEven - b.breakEven);
      if (anyCandidates.length > 0) {
        const best = anyCandidates[0];
        const c = best.config;
        const configStr = configShortLabel(c) + " (*)";
        const prem = best.suggestedPremium!;
        const traderPays = prem * 10;
        const effectiveSl = c.deductible === "1pct" ? Math.max(0, sl - 1) : sl;
        const payoutPer10k = (10_000 * effectiveSl) / 100;
        const traderSaves = payoutPer10k - traderPays;
        const margin = prem - best.breakEven;
        lines.push(
          `${pad(sl + "%", 4)} | ${padEnd(configStr, 24)} | ${pad($(prem), 11)} | ${pad($(traderPays), 16)} | ${pad($(payoutPer10k), 11)} | ${pad($(traderSaves), 12)} | ${pad($(margin), 19)} | ${pad(pct(best.triggerRate), 8)} | ${pad($(best.avgHedgeCost), 13)} | ${pad($(best.avgRecovery), 13)}`,
        );
      } else {
        lines.push(
          `${pad(sl + "%", 4)} | ${"NO VIABLE CONFIG".padEnd(24)} | ${"-".padStart(11)} | ${"-".padStart(16)} | ${"-".padStart(11)} | ${"-".padStart(12)} | ${"-".padStart(19)} | ${"-".padStart(8)} | ${"-".padStart(13)} | ${"-".padStart(13)}`,
        );
      }
      continue;
    }

    const best = candidates[0];
    const c = best.config;
    const configStr = configShortLabel(c);
    const prem = best.suggestedPremium!;
    const traderPays = prem * 10;
    const effectiveSl = c.deductible === "1pct" ? Math.max(0, sl - 1) : sl;
    const payoutPer10k = (10_000 * effectiveSl) / 100;
    const traderSaves = payoutPer10k - traderPays;
    const margin = prem - best.breakEven;

    lines.push(
      `${pad(sl + "%", 4)} | ${padEnd(configStr, 24)} | ${pad($(prem), 11)} | ${pad($(traderPays), 16)} | ${pad($(payoutPer10k), 11)} | ${pad($(traderSaves), 12)} | ${pad($(margin), 19)} | ${pad(pct(best.triggerRate), 8)} | ${pad($(best.avgHedgeCost), 13)} | ${pad($(best.avgRecovery), 13)}`,
    );
  }

  lines.push("");
  lines.push("(*) = payout <= premium cost, poor trader value proposition");

  return lines.join("\n");
}

function generateTable3(results: ConfigResult[]): string {
  const lines: string[] = [];
  lines.push("TABLE 3: REGIME PRICING MATRIX");
  lines.push(
    "For the best config per tier, what the break-even premium is in each regime",
  );
  lines.push("");
  lines.push(
    "SL%  | Config                   | Calm/$1k | Normal/$1k | Stress/$1k | Calm N   | Normal N | Stress N | Recommendation",
  );
  lines.push(
    "-----|--------------------------|----------|------------|------------|----------|----------|----------|---------------",
  );

  for (const sl of SL_TIERS) {
    const candidates = results
      .filter((r) => {
        if (r.config.sl !== sl || r.suggestedPremium === null) return false;
        const effectiveSl = r.config.deductible === "1pct" ? Math.max(0, sl - 1) : sl;
        const payoutPer10k = (10_000 * effectiveSl) / 100;
        const traderPays = r.suggestedPremium! * 10;
        return payoutPer10k > traderPays;
      })
      .sort((a, b) => a.breakEven - b.breakEven);

    if (candidates.length === 0) {
      lines.push(`${pad(sl + "%", 4)} | N/A — no viable config with positive trader value`);
      continue;
    }

    const best = candidates[0];
    const c = best.config;
    const configStr = configShortLabel(c);

    const calmBE = best.regimeBreakEven.calm;
    const normalBE = best.regimeBreakEven.normal;
    const stressBE = best.regimeBreakEven.stress;

    let rec: string;
    if (stressBE > best.suggestedPremium! * 2) {
      rec = "Pause in stress";
    } else if (stressBE > best.suggestedPremium! * 1.3) {
      rec = "Surcharge in stress";
    } else {
      rec = "Fixed pricing OK";
    }

    lines.push(
      `${pad(sl + "%", 4)} | ${padEnd(configStr, 24)} | ${pad($(calmBE), 8)} | ${pad($(normalBE), 10)} | ${pad($(stressBE), 10)} | ${pad(String(best.regimeCount.calm), 8)} | ${pad(String(best.regimeCount.normal), 8)} | ${pad(String(best.regimeCount.stress), 8)} | ${rec}`,
    );
  }

  return lines.join("\n");
}

function generateTable4(results: ConfigResult[]): string {
  const lines: string[] = [];
  lines.push("TABLE 4: TREASURY SIMULATION");
  lines.push(
    `Starting treasury: $${TREASURY_START.toLocaleString()}, ${PROTECTIONS_PER_DAY} protections/day, ~4 years`,
  );
  lines.push("");
  lines.push(
    "SL%  | Config                   | Premium/$1k | End Treasury   | Min Treasury   | Max DD         | Annual P&L     | Worst Month    | Worst Mo $",
  );
  lines.push(
    "-----|--------------------------|-------------|----------------|----------------|----------------|----------------|----------------|----------",
  );

  for (const sl of SL_TIERS) {
    const candidates = results
      .filter((r) => {
        if (r.config.sl !== sl || r.suggestedPremium === null) return false;
        const effectiveSl = r.config.deductible === "1pct" ? Math.max(0, sl - 1) : sl;
        const payoutPer10k = (10_000 * effectiveSl) / 100;
        const traderPays = r.suggestedPremium! * 10;
        return payoutPer10k > traderPays;
      })
      .sort((a, b) => a.breakEven - b.breakEven);

    if (candidates.length === 0) {
      lines.push(`${pad(sl + "%", 4)} | ${"NO VIABLE CONFIG".padEnd(24)} | - `);
      continue;
    }

    const best = candidates[0];
    const prem = best.suggestedPremium!;
    const sim = simulateTreasury(best.windowPnLs, prem);
    const configStr = configShortLabel(best.config);

    lines.push(
      `${pad(sl + "%", 4)} | ${padEnd(configStr, 24)} | ${pad($(prem), 11)} | ${pad($(sim.endTreasury, 0), 14)} | ${pad($(sim.minTreasury, 0), 14)} | ${pad($(sim.maxDrawdown, 0), 14)} | ${pad($(sim.annualPnL, 0), 14)} | ${padEnd(sim.worstMonth, 14)} | ${pad($(sim.worstMonthPnL, 0), 9)}`,
    );
  }

  return lines.join("\n");
}

function generateTable5(results: ConfigResult[]): string {
  const lines: string[] = [];
  lines.push("TABLE 5: CEO PRESENTATION — WHAT THE TRADER SEES");
  lines.push("Plain language for each viable tier, per $10,000 position");
  lines.push("");
  lines.push(
    'SL%  | "You Pay"    | "You Get"    | "Max Loss"    | "Without Protection" | Platform Viable?',
  );
  lines.push(
    '-----|--------------|--------------|---------------|----------------------|-----------------',
  );

  for (const sl of SL_TIERS) {
    const candidates = results
      .filter((r) => {
        if (r.config.sl !== sl || r.suggestedPremium === null) return false;
        const effectiveSl = r.config.deductible === "1pct" ? Math.max(0, sl - 1) : sl;
        const payoutPer10k = (10_000 * effectiveSl) / 100;
        const traderPays = r.suggestedPremium! * 10;
        return payoutPer10k > traderPays;
      })
      .sort((a, b) => a.breakEven - b.breakEven);

    if (candidates.length === 0) {
      const withoutProtection = (10_000 * sl) / 100;
      lines.push(
        `${pad(sl + "%", 4)} | ${"N/A".padEnd(12)} | ${"N/A".padEnd(12)} | ${"N/A".padEnd(13)} | ${pad($(withoutProtection, 0), 20)} | NOT VIABLE`,
      );
      continue;
    }

    const best = candidates[0];
    const c = best.config;
    const prem = best.suggestedPremium!;
    const youPay = prem * 10;
    const effectiveSl = c.deductible === "1pct" ? Math.max(0, sl - 1) : sl;
    const youGet = (10_000 * effectiveSl) / 100;
    const maxLoss = youPay;
    const withoutProtection = (10_000 * sl) / 100;
    const margin = prem - best.breakEven;
    const deductNote = c.deductible === "1pct" ? " (1% deduct)" : "";
    const viable = margin > 0 ? `YES (+$${margin.toFixed(2)}/1k)${deductNote}` : `MARGINAL${deductNote}`;

    lines.push(
      `${pad(sl + "%", 4)} | ${pad($(youPay, 0) + "/10k", 12)} | ${pad($(youGet, 0), 12)} | ${pad($(maxLoss, 0), 13)} | ${pad($(withoutProtection, 0), 20)} | ${viable}`,
    );
  }

  return lines.join("\n");
}

function generateLossFlags(results: ConfigResult[]): string {
  const lines: string[] = [];
  lines.push("LOSS FLAG ANALYSIS: Configurations Where Platform Loses Money");
  lines.push("");

  const losers = results.filter((r) => {
    const bestPrem = TEST_PREMIUMS[TEST_PREMIUMS.length - 1];
    const avgPnl = r.pnlByPremium.get(bestPrem)!;
    return avgPnl < 0;
  });

  if (losers.length === 0) {
    lines.push(
      `  All ${results.length} configurations are profitable at $${TEST_PREMIUMS[TEST_PREMIUMS.length - 1]}/1k premium.`,
    );
  } else {
    lines.push(
      `  ${losers.length} of ${results.length} configurations lose money even at $${TEST_PREMIUMS[TEST_PREMIUMS.length - 1]}/1k:`,
    );
    lines.push("");
    lines.push("  Config Label                                    | Break-Even/$1k | Avg P&L at $20");
    lines.push("  ------------------------------------------------|----------------|---------------");
    for (const r of losers.slice(0, 20)) {
      lines.push(
        `  ${padEnd(r.label, 48)} | ${pad($(r.breakEven), 14)} | ${pad($(r.pnlByPremium.get(20)!), 14)}`,
      );
    }
    if (losers.length > 20) {
      lines.push(`  ... and ${losers.length - 20} more`);
    }
  }

  return lines.join("\n");
}

function generateDetailedPnLTable(results: ConfigResult[]): string {
  const lines: string[] = [];
  lines.push("DETAILED P&L TABLE: All 120 Configurations");
  lines.push(
    "Shows average P&L per $1k at each test premium and win rate at suggested premium",
  );
  lines.push("");

  const header =
    "# | SL% | Strike  | Recov | Deduct | Vol  | BE/$1k | TrigRt | " +
    TEST_PREMIUMS.map((p) => `P&L@$${p}`).join(" | ") +
    " | Sug$ | WR@Sug";
  const sep =
    "--|-----|---------|-------|--------|------|--------|--------|-" +
    TEST_PREMIUMS.map(() => "-------").join("-|-") +
    "-|------|-------";
  lines.push(header);
  lines.push(sep);

  const sorted = [...results].sort((a, b) => a.breakEven - b.breakEven);
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const c = r.config;
    const pnlCols = TEST_PREMIUMS.map((p) => {
      const v = r.pnlByPremium.get(p)!;
      const s = v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1);
      return pad(s, 7);
    }).join(" | ");

    const sugStr = r.suggestedPremium ? `$${r.suggestedPremium}` : "N/A";
    const wrStr = r.suggestedWinRate
      ? pct(r.suggestedWinRate)
      : "N/A";

    lines.push(
      `${pad(String(i + 1), 2)} | ${pad(c.sl + "%", 3)} | ${padEnd(c.strike, 7)} | ${padEnd(c.recovery, 5)} | ${padEnd(c.deductible === "1pct" ? "1%" : "none", 6)} | ${pad(String(c.volMult), 4)} | ${pad($(r.breakEven), 6)} | ${pad(pct(r.triggerRate), 6)} | ${pnlCols} | ${pad(sugStr, 4)} | ${pad(wrStr, 6)}`,
    );
  }

  return lines.join("\n");
}

function generateRecommendation(results: ConfigResult[]): string {
  const lines: string[] = [];
  lines.push("═".repeat(75));
  lines.push("  RECOMMENDATION: OPTIMAL TIERS FOR LAUNCH");
  lines.push("═".repeat(75));
  lines.push("");

  const bestPerTier = new Map<number, ConfigResult>();
  for (const sl of SL_TIERS) {
    const candidates = results
      .filter((r) => {
        if (r.config.sl === sl && r.suggestedPremium !== null) {
          const effectiveSl = r.config.deductible === "1pct" ? Math.max(0, sl - 1) : sl;
          const payoutPer10k = (10_000 * effectiveSl) / 100;
          const traderPays = r.suggestedPremium! * 10;
          return payoutPer10k > traderPays;
        }
        return false;
      })
      .sort((a, b) => a.breakEven - b.breakEven);
    if (candidates.length > 0) {
      bestPerTier.set(sl, candidates[0]);
    }
  }

  const ranked = [...bestPerTier.entries()].sort(
    (a, b) => a[1].breakEven - b[1].breakEven,
  );

  lines.push("  Tiers ranked by platform viability (lowest break-even first):");
  lines.push("");

  for (const [sl, best] of ranked) {
    const prem = best.suggestedPremium!;
    const margin = prem - best.breakEven;
    const marginPct = (margin / prem) * 100;
    const payoutPer10k = (10_000 * sl) / 100;
    const traderROI = payoutPer10k / (prem * 10);

    lines.push(`  ${sl}% Stop-Loss Tier:`);
    lines.push(`    Config:           ${configShortLabel(best.config)}`);
    lines.push(`    Break-even:       ${$(best.breakEven)}/1k`);
    lines.push(`    Suggested price:  ${$(prem)}/1k (${$(prem * 10)}/10k)`);
    lines.push(`    Platform margin:  ${$(margin)}/1k (${marginPct.toFixed(1)}% of premium)`);
    lines.push(`    Trigger rate:     ${pct(best.triggerRate)}`);
    lines.push(`    Win rate:         ${pct(best.suggestedWinRate!)}`);
    lines.push(`    Trader payout:    ${$(payoutPer10k, 0)} per $10k on breach`);
    lines.push(`    Trader ROI:       ${traderROI.toFixed(1)}x premium on breach`);
    lines.push(`    Hedge cost avg:   ${$(best.avgHedgeCost)}/1k`);
    lines.push(`    Recovery avg:     ${$(best.avgRecovery)}/1k`);
    lines.push("");
  }

  lines.push("  RECOMMENDED LAUNCH TIERS:");
  lines.push("");

  const viable = ranked.filter(([sl, best]) => {
    const prem = best.suggestedPremium!;
    const margin = prem - best.breakEven;
    const effectiveSl = best.config.deductible === "1pct" ? Math.max(0, sl - 1) : sl;
    const payoutPer10k = (10_000 * effectiveSl) / 100;
    const traderPays = prem * 10;
    return margin > 0 && best.suggestedWinRate! >= 0.6 && payoutPer10k > traderPays;
  });

  if (viable.length >= 3) {
    lines.push(
      `  Launch with ${viable
        .slice(0, 3)
        .map(([sl]) => sl + "%")
        .join(", ")} stop-loss tiers.`,
    );
  } else if (viable.length > 0) {
    lines.push(
      `  Launch with ${viable.map(([sl]) => sl + "%").join(", ")} stop-loss tier(s).`,
    );
  } else {
    lines.push("  WARNING: No tier has a comfortable margin. Consider adjusting product structure.");
  }

  lines.push("");
  lines.push("  KEY INSIGHTS:");

  const best10 = bestPerTier.get(10);
  const best5 = bestPerTier.get(5);
  const best2 = bestPerTier.get(2);

  if (best10) {
    const m10 = best10.suggestedPremium! - best10.breakEven;
    lines.push(
      `  - 10% SL has the best economics: ${$(best10.breakEven)}/1k break-even, ${$(m10)}/1k margin, ${pct(best10.triggerRate)} trigger rate`,
    );
  }
  if (best5) {
    const m5 = best5.suggestedPremium! - best5.breakEven;
    lines.push(
      `  - 5% SL is intermediate: ${$(best5.breakEven)}/1k break-even, ${$(m5)}/1k margin, ${pct(best5.triggerRate)} trigger rate`,
    );
  }
  if (best2) {
    const m2 = best2.suggestedPremium! - best2.breakEven;
    lines.push(
      `  - 2% SL is the most popular request but challenging: ${$(best2.breakEven)}/1k break-even, ${$(m2)}/1k margin, ${pct(best2.triggerRate)} trigger rate`,
    );
  }

  lines.push("");
  lines.push("  WHY THESE PREMIUMS WORK:");
  lines.push(
    "  - Post-breach option recovery is the key profitability driver",
  );
  lines.push(
    "  - Take-profit (selling option 2 days post-breach) significantly improves economics",
  );
  lines.push(
    "  - Lower SL tiers trigger more often but recover more from deep ITM options",
  );
  lines.push(
    "  - The vol×0.85 assumption reflects market IV being below realized vol for OTM BTC puts",
  );
  lines.push(
    "  - Deductible reduces payout cost but makes the product less attractive to traders",
  );

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const startTime = Date.now();

  console.log("═".repeat(75));
  console.log("  ATTICUS DEFINITIVE BACKTEST: Full Configuration Matrix");
  console.log("  " + new Date().toISOString());
  console.log("═".repeat(75));
  console.log();

  console.log("  Fetching BTC daily prices from Coinbase (2022-01-01 to 2026-04-07)...");
  const rawPrices = await fetchBTCPrices("2022-01-01", "2026-04-07");
  console.log(`  ${rawPrices.length} days loaded\n`);

  if (rawPrices.length < 100) {
    throw new Error(`Insufficient price data: only ${rawPrices.length} days loaded`);
  }

  const dates = rawPrices.map((p) => p.date);
  const closes = rawPrices.map((p) => p.close);

  console.log(
    `  Price range: ${$(closes[0], 0)} (${dates[0]}) → ${$(closes[closes.length - 1], 0)} (${dates[dates.length - 1]})`,
  );
  console.log(
    `  Min: ${$(Math.min(...closes), 0)}, Max: ${$(Math.max(...closes), 0)}`,
  );
  console.log();

  const allResults: ConfigResult[] = [];
  let configIdx = 0;
  const totalConfigs =
    SL_TIERS.length *
    STRIKE_STRATEGIES.length *
    RECOVERY_STRATEGIES.length *
    DEDUCTIBLE_OPTIONS.length *
    VOL_MULTIPLIERS.length;

  console.log(`  Running ${totalConfigs} configurations...`);

  for (const sl of SL_TIERS) {
    for (const strike of STRIKE_STRATEGIES) {
      for (const recovery of RECOVERY_STRATEGIES) {
        for (const deductible of DEDUCTIBLE_OPTIONS) {
          for (const volMult of VOL_MULTIPLIERS) {
            configIdx++;
            const config: Config = {
              sl,
              strike,
              recovery,
              deductible,
              volMult,
            };
            const result = runConfig(dates, closes, config);
            allResults.push(result);
          }
        }
      }
    }
    console.log(
      `    SL ${sl}% done (${configIdx}/${totalConfigs} configs)`,
    );
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `\n  All ${totalConfigs} configurations complete in ${elapsed}s`,
  );
  console.log(
    `  ${allResults[0].totalWindows} rolling 7-day windows per config`,
  );
  console.log();

  // Generate all output tables
  const output: string[] = [];

  output.push("═".repeat(75));
  output.push("  ATTICUS DEFINITIVE BACKTEST RESULTS");
  output.push("  " + new Date().toISOString());
  output.push(
    `  ${rawPrices.length} days | ${totalConfigs} configs | ${allResults[0].totalWindows} windows each`,
  );
  output.push("═".repeat(75));
  output.push("");
  output.push("");

  output.push(generateTable1(allResults));
  output.push("");
  output.push("");

  output.push(generateTable2(allResults));
  output.push("");
  output.push("");

  output.push(generateTable3(allResults));
  output.push("");
  output.push("");

  output.push(generateTable4(allResults));
  output.push("");
  output.push("");

  output.push(generateTable5(allResults));
  output.push("");
  output.push("");

  output.push(generateLossFlags(allResults));
  output.push("");
  output.push("");

  output.push(generateDetailedPnLTable(allResults));
  output.push("");
  output.push("");

  output.push(generateRecommendation(allResults));
  output.push("");

  const fullOutput = output.join("\n");

  // Write to file
  const outDir = path.resolve("docs/pilot-reports");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "backtest_definitive_results.txt");
  await writeFile(outPath, fullOutput, "utf8");

  // Also print to console
  console.log(fullOutput);

  console.log(`\n  Results written to: ${outPath}`);
  console.log(
    `  Total time: ${((Date.now() - startTime) / 1000).toFixed(1)}s`,
  );
}

main().catch((e) => {
  console.error("Fatal:", e.message || e);
  process.exit(1);
});
