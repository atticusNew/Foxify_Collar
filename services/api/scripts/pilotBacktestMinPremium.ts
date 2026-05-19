/**
 * Minimum Premium Finder
 * 
 * For each tenor (1d, 2d, 3d) × SL (2%, 3%, 5%, 10%) × vol (0.44, 0.65, 0.85):
 * Find the LOWEST premium where lifetime P&L >= 0 including full option
 * lifecycle: hedge cost, payout, take-profit recovery, expiry settlement.
 * 
 * Track treasury cash flow: drawdown between payout and recovery.
 */

const SL_TIERS = [2, 3, 5, 10];
const TENORS = [1, 2, 3];
const VOL_MULTIPLIERS = [0.44, 0.65, 0.85];
const NOTIONAL = 10_000;
const RF = 0.05;
const TREASURY = 100_000;
const DAILY_PROTS = 10;

function nCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const s = x < 0 ? -1 : 1; x = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * x);
  return 0.5 * (1 + s * (1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x)));
}

function bsPut(S: number, K: number, T: number, r: number, v: number): number {
  if (T <= 0 || v <= 0 || S <= 0 || K <= 0) return Math.max(0, K - S);
  const d1 = (Math.log(S / K) + (r + v * v / 2) * T) / (v * Math.sqrt(T));
  const d2 = d1 - v * Math.sqrt(T);
  return K * Math.exp(-r * T) * nCDF(-d2) - S * nCDF(-d1);
}

function rVol(prices: number[], w: number): number {
  if (prices.length < w + 1) return 0.5;
  const rets: number[] = [];
  for (let i = Math.max(0, prices.length - w - 1); i < prices.length - 1; i++) {
    if (prices[i] > 0 && prices[i + 1] > 0) rets.push(Math.log(prices[i + 1] / prices[i]));
  }
  if (rets.length < 5) return 0.5;
  const m = rets.reduce((s, r) => s + r, 0) / rets.length;
  const v = rets.reduce((s, r) => s + (r - m) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v * 365);
}

async function fetchPrices(start: string, end: string): Promise<{ date: string; price: number; low: number }[]> {
  const all = new Map<string, { price: number; low: number }>();
  let cur = new Date(start).getTime(); const eMs = new Date(end).getTime();
  while (cur < eMs) {
    const ce = Math.min(cur + 300 * 86400000, eMs);
    const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400&start=${new Date(cur).toISOString()}&end=${new Date(ce).toISOString()}`;
    let retries = 3;
    while (retries-- > 0) {
      try {
        const res = await fetch(url);
        if (res.status === 429) { await new Promise(r => setTimeout(r, 3000)); continue; }
        if (!res.ok) throw new Error(`${res.status}`);
        const c = await res.json() as number[][];
        for (const [ts, lo, , , cl] of c) all.set(new Date(ts * 1000).toISOString().slice(0, 10), { price: cl, low: lo });
        break;
      } catch (e: any) { if (retries <= 0) throw e; await new Promise(r => setTimeout(r, 2000)); }
    }
    cur = ce; await new Promise(r => setTimeout(r, 500));
  }
  return Array.from(all.entries()).map(([d, v]) => ({ date: d, ...v })).sort((a, b) => a.date.localeCompare(b.date));
}

type SimResult = {
  sl: number; tenor: number; volMult: number;
  premPer1k: number;
  totalProtections: number; totalTriggers: number; trigRate: number;
  totalPremiums: number; totalHedge: number; totalPayouts: number; totalRecovery: number;
  lifetimePnl: number; lifetimePnlPer1k: number;
  peakDrawdown: number; maxNegDuration: number;
  endTreasury: number;
  winRate: number;
};

function simulate(
  prices: { date: string; price: number; low: number }[],
  pv: number[],
  sl: number, tenor: number, volMult: number, premPer1k: number
): SimResult {
  const premPerTrade = premPer1k * (NOTIONAL / 1000);
  let treasury = TREASURY;
  let minTreasury = treasury;
  let peakDD = 0;
  let maxNegDays = 0, curNegDays = 0;
  let totalPrem = 0, totalHedge = 0, totalPay = 0, totalRecov = 0;
  let triggers = 0, n = 0, wins = 0;

  // Pending recoveries: queue of { settleDay, amount }
  const pendingRecov: { day: number; amount: number }[] = [];

  for (let i = 0; i + tenor < prices.length; i++) {
    const entry = prices[i].price;
    if (entry <= 0) continue;
    n++;

    // Settle any pending recoveries
    while (pendingRecov.length > 0 && pendingRecov[0].day <= i) {
      treasury += pendingRecov[0].amount;
      pendingRecov.shift();
    }

    const trigger = entry * (1 - sl / 100);
    const qty = NOTIONAL / entry;
    const vol = rVol(pv.slice(0, i + 1), 30) * volMult;
    const hedge = bsPut(entry, trigger, tenor / 365, RF, vol) * qty;

    // Day 0: collect premium, pay hedge
    treasury += premPerTrade - hedge;
    totalPrem += premPerTrade;
    totalHedge += hedge;

    // Check trigger
    const window = prices.slice(i, i + tenor + 1);
    const minLow = Math.min(...window.map(w => w.low));
    const triggered = minLow <= trigger;

    if (triggered) {
      triggers++;
      const payout = NOTIONAL * (sl / 100);
      treasury -= payout;
      totalPay += payout;

      // TP: find deepest point within 2 days of trigger, schedule recovery
      let trigDay = 0;
      for (let d = 0; d < window.length; d++) { if (window[d].low <= trigger) { trigDay = d; break; } }
      let deepest = trigger;
      let deepDay = trigDay;
      for (let d = trigDay; d < Math.min(trigDay + 3, window.length); d++) {
        if (window[d].low < deepest) { deepest = window[d].low; deepDay = d; }
      }
      const tpValue = Math.max(0, trigger - deepest) * qty;

      // Also check expiry value
      const expiryPx = prices[i + tenor]?.price || entry;
      const expiryValue = Math.max(0, trigger - expiryPx) * qty;
      const recovAmount = Math.max(tpValue, expiryValue);

      // Recovery settles 1-2 days after trigger
      const settleDay = i + Math.min(deepDay + 1, tenor);
      pendingRecov.push({ day: settleDay, amount: recovAmount });
      totalRecov += recovAmount;

      const tradePnl = premPerTrade - hedge - payout + recovAmount;
      if (tradePnl >= 0) wins++;
    } else {
      const tradePnl = premPerTrade - hedge;
      if (tradePnl >= 0) wins++;
    }

    // Track drawdown
    if (treasury < minTreasury) minTreasury = treasury;
    const dd = TREASURY - treasury;
    if (dd > peakDD) peakDD = dd;
    if (treasury < TREASURY) { curNegDays++; if (curNegDays > maxNegDays) maxNegDays = curNegDays; }
    else curNegDays = 0;
  }

  // Settle remaining
  for (const p of pendingRecov) treasury += p.amount;

  return {
    sl, tenor, volMult, premPer1k,
    totalProtections: n, totalTriggers: triggers, trigRate: triggers / n,
    totalPremiums: totalPrem, totalHedge: totalHedge, totalPayouts: totalPay, totalRecovery: totalRecov,
    lifetimePnl: totalPrem - totalHedge - totalPay + totalRecov,
    lifetimePnlPer1k: (totalPrem - totalHedge - totalPay + totalRecov) / n / (NOTIONAL / 1000),
    peakDrawdown: peakDD, maxNegDuration: maxNegDays,
    endTreasury: treasury, winRate: wins / n,
  };
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════════════════");
  console.log("  MINIMUM PREMIUM FINDER — Full Lifecycle with Cash Flow Tracking");
  console.log("  Treasury: $" + TREASURY.toLocaleString() + " | Protections: " + DAILY_PROTS + "/day");
  console.log("  Vol multipliers: " + VOL_MULTIPLIERS.join(", "));
  console.log("  " + new Date().toISOString());
  console.log("═══════════════════════════════════════════════════════════════════════════\n");

  const prices = await fetchPrices("2022-01-01", "2026-04-07");
  console.log(`  ${prices.length} days loaded\n`);
  const pv = prices.map(p => p.price);

  // For each combo, binary search for minimum premium where lifetime P&L >= 0
  const allResults: {
    sl: number; tenor: number; volMult: number;
    minPremPer1k: number; sim: SimResult;
  }[] = [];

  for (const volMult of VOL_MULTIPLIERS) {
    console.log(`\n═══════════════════════════════════════════════════════════════════════════`);
    console.log(`  VOL MULTIPLIER: ${volMult} (${volMult === 0.44 ? 'low/calm market' : volMult === 0.65 ? 'moderate market' : 'standard market IV'})`);
    console.log(`═══════════════════════════════════════════════════════════════════════════\n`);

    console.log("  SL%  │ Tenor │ Min Prem/$1k │ Per $10k    │ Weekly/$10k │ Trig Rate │ TP Recovery │ Peak DD   │ Lifetime PnL │ Win Rate");
    console.log("  ─────┼───────┼──────────────┼─────────────┼─────────────┼───────────┼─────────────┼───────────┼──────────────┼─────────");

    for (const sl of SL_TIERS) {
      for (const tenor of TENORS) {
        // Binary search for minimum premium
        let lo = 0, hi = 30;
        while (hi - lo > 0.05) {
          const mid = (lo + hi) / 2;
          const sim = simulate(prices, pv, sl, tenor, volMult, mid);
          if (sim.lifetimePnl >= 0) hi = mid;
          else lo = mid;
        }
        const minPrem = Math.ceil(hi * 20) / 20; // Round up to nearest $0.05
        const sim = simulate(prices, pv, sl, tenor, volMult, minPrem);
        const weeklyRenewals = 7 / tenor;
        const weeklyCost = minPrem * 10 * weeklyRenewals;
        const tpRecovPct = sim.totalPayouts > 0 ? (sim.totalRecovery / sim.totalPayouts * 100).toFixed(0) : "0";

        allResults.push({ sl, tenor, volMult, minPremPer1k: minPrem, sim });

        console.log(
          `  ${String(sl).padStart(3)}%  │ ${String(tenor).padStart(3)}d  │ $${minPrem.toFixed(2).padStart(10)} │ $${(minPrem * 10).toFixed(0).padStart(9)} │ $${weeklyCost.toFixed(0).padStart(9)} │ ${(sim.trigRate * 100).toFixed(0).padStart(7)}%  │ ${tpRecovPct.padStart(7)}% pay │ $${sim.peakDrawdown.toFixed(0).padStart(7)} │ $${sim.lifetimePnl.toFixed(0).padStart(10)} │ ${(sim.winRate * 100).toFixed(0).padStart(5)}%`
        );
      }
      console.log("  ─────┼───────┼──────────────┼─────────────┼─────────────┼───────────┼─────────────┼───────────┼──────────────┼─────────");
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // COMPARISON: Best tenor per SL at each vol
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n\n═══════════════════════════════════════════════════════════════════════════");
  console.log("  BEST TENOR PER SL (lowest weekly cost, lifetime profitable)");
  console.log("═══════════════════════════════════════════════════════════════════════════\n");

  for (const volMult of VOL_MULTIPLIERS) {
    console.log(`  Vol × ${volMult}:`);
    console.log("  SL%  │ Best │ Prem/$1k │ Weekly/$10k │ Payout │ Trig │ TP Recov │ Peak DD");
    console.log("  ─────┼──────┼──────────┼─────────────┼────────┼──────┼──────────┼────────");
    for (const sl of SL_TIERS) {
      const options = allResults.filter(r => r.sl === sl && r.volMult === volMult);
      const best = options.sort((a, b) => {
        const aw = a.minPremPer1k * 10 * (7 / a.tenor);
        const bw = b.minPremPer1k * 10 * (7 / b.tenor);
        return aw - bw;
      })[0];
      const weekly = best.minPremPer1k * 10 * (7 / best.tenor);
      const payout = NOTIONAL * (sl / 100);
      const tpPct = best.sim.totalPayouts > 0 ? (best.sim.totalRecovery / best.sim.totalPayouts * 100).toFixed(0) : "0";
      console.log(`  ${String(sl).padStart(3)}%  │ ${String(best.tenor).padStart(2)}d  │ $${best.minPremPer1k.toFixed(2).padStart(6)} │ $${weekly.toFixed(0).padStart(9)} │ $${payout.toFixed(0).padStart(4)}  │ ${(best.sim.trigRate * 100).toFixed(0).padStart(3)}% │ ${tpPct.padStart(6)}%  │ $${best.sim.peakDrawdown.toFixed(0).padStart(6)}`);
    }
    console.log();
  }

  // ═══════════════════════════════════════════════════════════════════
  // FINAL: CEO-ready table at moderate IV (0.65)
  // ═══════════════════════════════════════════════════════════════════
  console.log("═══════════════════════════════════════════════════════════════════════════");
  console.log("  FINAL: LOWEST PREMIUMS (moderate market, vol × 0.65)");
  console.log("═══════════════════════════════════════════════════════════════════════════\n");

  console.log("  ┌──────┬───────┬──────────────┬──────────────┬──────────────┬──────────┬──────────────────────────────────┐");
  console.log("  │ SL%  │ Tenor │ Per Period    │ Per Week     │ Payout       │ Savings  │ Economics                        │");
  console.log("  ├──────┼───────┼──────────────┼──────────────┼──────────────┼──────────┼──────────────────────────────────┤");

  for (const sl of SL_TIERS) {
    const options = allResults.filter(r => r.sl === sl && r.volMult === 0.65);
    const best = options.sort((a, b) => {
      const aw = a.minPremPer1k * 10 * (7 / a.tenor);
      const bw = b.minPremPer1k * 10 * (7 / b.tenor);
      return aw - bw;
    })[0];
    const periodCost = best.minPremPer1k * 10;
    const weekly = periodCost * (7 / best.tenor);
    const payout = NOTIONAL * (sl / 100);
    const savings = payout - periodCost;
    const tpPct = best.sim.totalPayouts > 0 ? (best.sim.totalRecovery / best.sim.totalPayouts * 100).toFixed(0) + "% TP" : "";

    console.log(`  │ ${String(sl).padStart(3)}% │ ${String(best.tenor).padStart(3)}d  │ $${periodCost.toFixed(0).padStart(10)} │ $${weekly.toFixed(0).padStart(10)} │ $${payout.toFixed(0).padStart(10)} │ $${savings.toFixed(0).padStart(6)}  │ Trig ${(best.sim.trigRate * 100).toFixed(0)}%, ${tpPct}, DD $${best.sim.peakDrawdown.toFixed(0).padStart(1)} │`);
  }
  console.log("  └──────┴───────┴──────────────┴──────────────┴──────────────┴──────────┴──────────────────────────────────┘\n");
  console.log("  Per $10,000 position. Savings = payout - single period premium.");
  console.log("  Treasury absorbs temporary drawdown; option recovery recoups within days.\n");
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
