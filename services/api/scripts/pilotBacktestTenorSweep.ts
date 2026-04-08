/**
 * Tenor Sweep: 1-day vs 2-day vs 3-day vs 5-day vs 7-day
 * 
 * For each tenor × SL tier, compute:
 * - Hedge cost, trigger rate, payout, recovery
 * - Recovery as % of payout (the TP profit engine)
 * - Break-even, optimal price
 * - Platform P&L per trade
 * - Weekly cost to trader
 * - Composite score: platform profit × trader value
 * 
 * Find the sweet spot tenor per SL tier.
 */

const SL_TIERS = [1, 2, 3, 5, 10];
const TENORS = [1, 2, 3, 5, 7];
const NOTIONAL = 10_000;
const RF = 0.05;

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

type Result = {
  sl: number;
  tenor: number;
  trigRate: number;
  hedgePer1k: number;
  payoutPer1k: number;
  recovPer1k: number;
  recovPctOfPayout: number;
  tpRecovPer1k: number;
  tpRecovPctOfPayout: number;
  bePer1k: number;
  beWithTpPer1k: number;
  optimalPer1k: number;
  optimalWithTpPer1k: number;
  weeklyTraderCostPer10k: number;
  weeklyTraderCostWithTpPer10k: number;
  pnlPer1k: number;
  pnlWithTpPer1k: number;
  winRate: number;
  winRateWithTp: number;
};

async function main() {
  console.log("═══════════════════════════════════════════════════════════════════════════");
  console.log("  TENOR SWEEP: Find the Sweet Spot (1d / 2d / 3d / 5d / 7d)");
  console.log("  With and without Take-Profit optimization");
  console.log("  " + new Date().toISOString());
  console.log("═══════════════════════════════════════════════════════════════════════════\n");

  const prices = await fetchPrices("2022-01-01", "2026-04-07");
  console.log(`  ${prices.length} days loaded\n`);
  const pv = prices.map(p => p.price);

  const results: Result[] = [];

  for (const tenor of TENORS) {
    for (const sl of SL_TIERS) {
      let n = 0, trigs = 0, totalH = 0, totalPay = 0, totalRecov = 0, totalTpRecov = 0;
      const pnls: number[] = [];
      const pnlsTp: number[] = [];

      // Per-year break-evens for worst-year pricing
      const yearBEs: number[] = [];
      const yearBEsTp: number[] = [];
      const yearRanges = [
        ["2022-01-01", "2022-12-31"],
        ["2023-01-01", "2023-12-31"],
        ["2024-01-01", "2024-12-31"],
        ["2025-01-01", "2026-04-07"],
      ];

      for (const [ys, ye] of yearRanges) {
        let yn = 0, yh = 0, yp = 0, yr = 0, ytr = 0;
        const yrPrices = prices.filter(p => p.date >= ys && p.date <= ye);
        for (let i = 0; i + tenor < yrPrices.length; i++) {
          const entry = yrPrices[i].price;
          if (entry <= 0) continue;
          yn++;
          const trigger = entry * (1 - sl / 100);
          const qty = NOTIONAL / entry;
          const gi = pv.indexOf(entry);
          const vol = rVol(pv.slice(0, Math.max(gi + 1, 30)), 30) * 0.85;
          const hedge = bsPut(entry, trigger, tenor / 365, RF, vol) * qty;
          yh += hedge;
          const window = yrPrices.slice(i, i + tenor + 1);
          const minLow = Math.min(...window.map(w => w.low));
          const triggered = minLow <= trigger;
          if (triggered) {
            yp += NOTIONAL * (sl / 100);
            const ep = yrPrices[i + tenor]?.price || entry;
            yr += Math.max(0, trigger - ep) * qty;
            // TP: find deepest point within 2 days of trigger
            let trigDay = 0;
            for (let d = 0; d < window.length; d++) { if (window[d].low <= trigger) { trigDay = d; break; } }
            let deepest = trigger;
            for (let d = trigDay; d < Math.min(trigDay + 3, window.length); d++) {
              if (window[d].low < deepest) deepest = window[d].low;
            }
            ytr += Math.max(0, trigger - deepest) * qty;
          }
        }
        if (yn > 0) {
          yearBEs.push((yh + yp - yr) / yn / (NOTIONAL / 1000));
          yearBEsTp.push((yh + yp - ytr) / yn / (NOTIONAL / 1000));
        }
      }

      // Full dataset
      for (let i = 0; i + tenor < prices.length; i++) {
        const entry = prices[i].price;
        if (entry <= 0) continue;
        n++;
        const trigger = entry * (1 - sl / 100);
        const qty = NOTIONAL / entry;
        const vol = rVol(pv.slice(0, i + 1), 30) * 0.85;
        const hedge = bsPut(entry, trigger, tenor / 365, RF, vol) * qty;
        totalH += hedge;
        const window = prices.slice(i, i + tenor + 1);
        const minLow = Math.min(...window.map(w => w.low));
        const triggered = minLow <= trigger;
        const payout = triggered ? NOTIONAL * (sl / 100) : 0;
        totalPay += payout;
        if (triggered) trigs++;

        let recov = 0, tpRecov = 0;
        if (triggered) {
          const ep = prices[i + tenor]?.price || entry;
          recov = Math.max(0, trigger - ep) * qty;
          let trigDay = 0;
          for (let d = 0; d < window.length; d++) { if (window[d].low <= trigger) { trigDay = d; break; } }
          let deepest = trigger;
          for (let d = trigDay; d < Math.min(trigDay + 3, window.length); d++) {
            if (window[d].low < deepest) deepest = window[d].low;
          }
          tpRecov = Math.max(recov, Math.max(0, trigger - deepest) * qty);
        }
        totalRecov += recov;
        totalTpRecov += tpRecov;
      }

      const trigRate = trigs / n;
      const h1k = totalH / n / (NOTIONAL / 1000);
      const p1k = totalPay / n / (NOTIONAL / 1000);
      const r1k = totalRecov / n / (NOTIONAL / 1000);
      const tp1k = totalTpRecov / n / (NOTIONAL / 1000);
      const be = h1k + p1k - r1k;
      const beTp = h1k + p1k - tp1k;
      const recovPct = trigs > 0 ? (totalRecov / totalPay) * 100 : 0;
      const tpRecovPct = trigs > 0 ? (totalTpRecov / totalPay) * 100 : 0;

      const worstYearBE = Math.max(...yearBEs, be);
      const worstYearBETp = Math.max(...yearBEsTp, beTp);
      const optimal = Math.ceil(worstYearBE * 1.20 * 4) / 4;
      const optimalTp = Math.ceil(worstYearBETp * 1.20 * 4) / 4;

      // P&L and win rate at optimal
      let wins = 0, winsTp = 0, tPnl = 0, tPnlTp = 0;
      for (let i = 0; i + tenor < prices.length; i++) {
        const entry = prices[i].price;
        if (entry <= 0) continue;
        const trigger = entry * (1 - sl / 100);
        const qty = NOTIONAL / entry;
        const vol = rVol(pv.slice(0, i + 1), 30) * 0.85;
        const hedge = bsPut(entry, trigger, tenor / 365, RF, vol) * qty / (NOTIONAL / 1000);
        const window = prices.slice(i, i + tenor + 1);
        const triggered = Math.min(...window.map(w => w.low)) <= trigger;
        const payout = triggered ? sl : 0;
        let recov = 0, tpR = 0;
        if (triggered) {
          const ep = prices[i + tenor]?.price || entry;
          recov = Math.max(0, trigger - ep) * qty / (NOTIONAL / 1000);
          let td = 0;
          for (let d = 0; d < window.length; d++) { if (window[d].low <= trigger) { td = d; break; } }
          let deep = trigger;
          for (let d = td; d < Math.min(td + 3, window.length); d++) { if (window[d].low < deep) deep = window[d].low; }
          tpR = Math.max(recov, Math.max(0, trigger - deep) * qty / (NOTIONAL / 1000));
        }
        const p = optimal - hedge - payout + recov;
        const pTp = optimalTp - hedge - payout + tpR;
        tPnl += p; tPnlTp += pTp;
        if (p >= 0) wins++;
        if (pTp >= 0) winsTp++;
      }

      const protectionsPerWeek = 7 / tenor;

      results.push({
        sl, tenor, trigRate, hedgePer1k: h1k, payoutPer1k: p1k, recovPer1k: r1k,
        recovPctOfPayout: recovPct, tpRecovPer1k: tp1k, tpRecovPctOfPayout: tpRecovPct,
        bePer1k: be, beWithTpPer1k: beTp, optimalPer1k: optimal, optimalWithTpPer1k: optimalTp,
        weeklyTraderCostPer10k: optimal * 10 * protectionsPerWeek,
        weeklyTraderCostWithTpPer10k: optimalTp * 10 * protectionsPerWeek,
        pnlPer1k: tPnl / n, pnlWithTpPer1k: tPnlTp / n,
        winRate: wins / n, winRateWithTp: winsTp / n,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Output: Per SL tier, compare all tenors
  // ═══════════════════════════════════════════════════════════════════

  for (const sl of SL_TIERS) {
    const tierResults = results.filter(r => r.sl === sl);
    console.log("\n═══════════════════════════════════════════════════════════════════════════");
    console.log(`  ${sl}% STOP LOSS — TENOR COMPARISON`);
    console.log("═══════════════════════════════════════════════════════════════════════════\n");

    console.log("  Tenor │ TrigRt │ Hedge/$1k │ Recov%Pay │ TP Recov% │ BE/$1k  │ BE+TP/$1k │ Optimal │ Opt+TP │ WkCost/$10k │ WkCost+TP │ WinRate │ WR+TP");
    console.log("  ──────┼────────┼───────────┼───────────┼───────────┼─────────┼───────────┼─────────┼────────┼─────────────┼───────────┼─────────┼──────");

    for (const r of tierResults) {
      const protsWk = 7 / r.tenor;
      console.log(
        `  ${String(r.tenor).padStart(2)}d   │ ${(r.trigRate * 100).toFixed(0).padStart(4)}%  │ $${r.hedgePer1k.toFixed(2).padStart(7)} │ ${r.recovPctOfPayout.toFixed(0).padStart(7)}%  │ ${r.tpRecovPctOfPayout.toFixed(0).padStart(7)}%  │ $${r.bePer1k.toFixed(2).padStart(5)}  │ $${r.beWithTpPer1k.toFixed(2).padStart(7)}   │ $${r.optimalPer1k.toFixed(2).padStart(5)} │ $${r.optimalWithTpPer1k.toFixed(2).padStart(4)} │ $${r.weeklyTraderCostPer10k.toFixed(0).padStart(9)} │ $${r.weeklyTraderCostWithTpPer10k.toFixed(0).padStart(7)} │ ${(r.winRate * 100).toFixed(0).padStart(5)}%  │ ${(r.winRateWithTp * 100).toFixed(0).padStart(3)}%`
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // SWEET SPOT: Best tenor per SL tier
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n\n═══════════════════════════════════════════════════════════════════════════");
  console.log("  SWEET SPOT: Best Tenor per SL Tier (with Take-Profit)");
  console.log("  Optimized for: lowest weekly cost to trader while platform profitable");
  console.log("═══════════════════════════════════════════════════════════════════════════\n");

  console.log("  SL%  │ Best Tenor │ Price/$1k │ Daily/$10k │ Weekly/$10k │ Payout │ Savings │ Win Rate │ TP Recovery");
  console.log("  ─────┼────────────┼───────────┼────────────┼─────────────┼────────┼─────────┼──────────┼────────────");

  for (const sl of SL_TIERS) {
    const tierResults = results.filter(r => r.sl === sl && r.pnlWithTpPer1k > 0);
    if (!tierResults.length) {
      console.log(`  ${String(sl).padStart(3)}%  │ NONE PROFITABLE`);
      continue;
    }
    // Best = lowest weekly cost with TP that is profitable
    const best = tierResults.sort((a, b) => a.weeklyTraderCostWithTpPer10k - b.weeklyTraderCostWithTpPer10k)[0];
    const payout = NOTIONAL * (sl / 100);
    const dailyCost = best.optimalWithTpPer1k * 10;
    const weeklyCost = best.weeklyTraderCostWithTpPer10k;
    const savings = payout - dailyCost;

    console.log(`  ${String(sl).padStart(3)}%  │ ${String(best.tenor).padStart(5)}d     │ $${best.optimalWithTpPer1k.toFixed(2).padStart(7)} │ $${dailyCost.toFixed(0).padStart(8)} │ $${weeklyCost.toFixed(0).padStart(9)} │ $${payout.toFixed(0).padStart(4)}  │ $${savings.toFixed(0).padStart(5)}  │ ${(best.winRateWithTp * 100).toFixed(0).padStart(6)}%  │ ${best.tpRecovPctOfPayout.toFixed(0)}% of payout`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // CEO Table
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n\n═══════════════════════════════════════════════════════════════════════════");
  console.log("  CEO PRESENTATION: Optimal Product Configuration");
  console.log("═══════════════════════════════════════════════════════════════════════════\n");

  console.log("  ┌──────┬───────┬─────────────┬──────────────┬──────────────┬──────────┬──────────────────────────────┐");
  console.log("  │ SL%  │ Tenor │ Cost/period  │ Cost/week    │ Payout       │ Savings  │ How it works                 │");
  console.log("  ├──────┼───────┼─────────────┼──────────────┼──────────────┼──────────┼──────────────────────────────┤");

  for (const sl of SL_TIERS) {
    const tierResults = results.filter(r => r.sl === sl && r.pnlWithTpPer1k > 0);
    if (!tierResults.length) continue;
    const best = tierResults.sort((a, b) => a.weeklyTraderCostWithTpPer10k - b.weeklyTraderCostWithTpPer10k)[0];
    const payout = NOTIONAL * (sl / 100);
    const periodCost = best.optimalWithTpPer1k * 10;
    const weeklyCost = best.weeklyTraderCostWithTpPer10k;
    const savings = payout - periodCost;
    const renewals = 7 / best.tenor;
    const how = `${best.tenor}d option, renews ${renewals.toFixed(best.tenor === 7 ? 0 : 1)}x/wk`;

    console.log(`  │ ${String(sl).padStart(3)}% │ ${String(best.tenor).padStart(3)}d  │ $${periodCost.toFixed(0).padStart(9)} │ $${weeklyCost.toFixed(0).padStart(10)} │ $${payout.toFixed(0).padStart(10)} │ $${savings.toFixed(0).padStart(6)}  │ ${how.padEnd(28)} │`);
  }
  console.log("  └──────┴───────┴─────────────┴──────────────┴──────────────┴──────────┴──────────────────────────────┘");
  console.log("\n  All costs per $10,000 position. Savings = payout - single period cost.");
  console.log("  Take-profit optimization active: platform sells option at optimal point after breach.\n");
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
