/**
 * Backtest V4: Complete financial simulation
 * 
 * 1. Trader-facing summary: what they see per tier
 * 2. Platform P&L with $50k and $100k treasury
 * 3. Take-profit analysis: sell option on breach vs hold to expiry
 * 4. Full regime-aware pricing simulation
 */

const SL_TIERS = [1, 2, 3, 5, 10];
const TENOR = 7;
const NOTIONAL = 10_000;
const RF = 0.05;
const DAILY_PROTECTIONS = 5;
const TREASURY_SIZES = [50_000, 100_000];

const PRICING_CONFIG: Record<number, {
  model: string;
  calm: number;
  normal: number;
  stress: number;
  deductiblePct: number;
  description: string;
}> = {
  1: { model: "regime", calm: 60, normal: 110, stress: 170, deductiblePct: 0, description: "Regime-adjusted, no deductible" },
  2: { model: "regime", calm: 50, normal: 90, stress: 150, deductiblePct: 0, description: "Regime-adjusted, no deductible" },
  3: { model: "fixed+regime", calm: 65, normal: 80, stress: 120, deductiblePct: 0, description: "Fixed base + stress surcharge" },
  5: { model: "fixed", calm: 50, normal: 50, stress: 80, deductiblePct: 0, description: "Fixed price, stress surcharge" },
  10: { model: "fixed", calm: 30, normal: 30, stress: 50, deductiblePct: 0, description: "Fixed price, crash protection" },
};

// Also test with deductibles
const PRICING_WITH_DEDUCTIBLE: Record<number, {
  calm: number; normal: number; stress: number; deductiblePct: number;
}> = {
  2: { calm: 35, normal: 65, stress: 110, deductiblePct: 1 },
  3: { calm: 45, normal: 60, stress: 90, deductiblePct: 1 },
  5: { calm: 35, normal: 40, stress: 60, deductiblePct: 1.5 },
};

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
  if (prices.length < w + 1) return 0.6;
  const rets: number[] = [];
  for (let i = Math.max(0, prices.length - w - 1); i < prices.length - 1; i++) {
    if (prices[i] > 0 && prices[i + 1] > 0) rets.push(Math.log(prices[i + 1] / prices[i]));
  }
  if (rets.length < 5) return 0.6;
  const m = rets.reduce((s, r) => s + r, 0) / rets.length;
  const v = rets.reduce((s, r) => s + (r - m) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v * 365);
}

function regime(vol: number): "calm" | "normal" | "stress" {
  if (vol < 0.40) return "calm";
  if (vol < 0.65) return "normal";
  return "stress";
}

async function fetchPrices(start: string, end: string): Promise<{ date: string; price: number }[]> {
  const all = new Map<string, number>();
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
        const candles = await res.json() as number[][];
        for (const [ts, , , , cl] of candles) all.set(new Date(ts * 1000).toISOString().slice(0, 10), cl);
        break;
      } catch (e: any) { if (retries <= 0) throw e; await new Promise(r => setTimeout(r, 2000)); }
    }
    cur = ce; await new Promise(r => setTimeout(r, 500));
  }
  return Array.from(all.entries()).map(([d, p]) => ({ date: d, price: p })).sort((a, b) => a.date.localeCompare(b.date));
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════════════════");
  console.log("  ATTICUS V4: COMPLETE FINANCIAL SIMULATION");
  console.log("  " + new Date().toISOString());
  console.log("═══════════════════════════════════════════════════════════════════════════\n");

  const prices = await fetchPrices("2022-01-01", "2026-04-07");
  console.log(`  ${prices.length} days loaded (${prices[0]?.date} → ${prices[prices.length-1]?.date})\n`);
  const pv = prices.map(p => p.price);

  // ═══════════════════════════════════════════════════════════════════
  // PART 1: TRADER-FACING SUMMARY
  // ═══════════════════════════════════════════════════════════════════
  console.log("═══════════════════════════════════════════════════════════════════════════");
  console.log("  PART 1: WHAT THE TRADER SEES");
  console.log("═══════════════════════════════════════════════════════════════════════════\n");

  console.log("  ┌──────┬─────────────────────────────────┬──────────────────────────────────────────────┐");
  console.log("  │ SL%  │ Trader Pays (per $10k, 7 days)  │ What They Get                                │");
  console.log("  ├──────┼─────────────────────────────────┼──────────────────────────────────────────────┤");
  for (const sl of SL_TIERS) {
    const c = PRICING_CONFIG[sl];
    const payout = NOTIONAL * (sl / 100);
    const priceRange = c.calm === c.normal ? `$${c.calm}` : `$${c.calm}-$${c.stress}`;
    const payoutStr = `$${payout} if SL hit`;
    console.log(`  │ ${String(sl).padStart(3)}% │ ${priceRange.padEnd(31)} │ ${payoutStr.padEnd(44)} │`);
  }
  console.log("  └──────┴─────────────────────────────────┴──────────────────────────────────────────────┘\n");

  console.log("  Detailed breakdown per tier:\n");

  for (const sl of SL_TIERS) {
    const c = PRICING_CONFIG[sl];
    const payout = NOTIONAL * (sl / 100);
    const exampleEntry = 70000;
    const triggerPx = exampleEntry * (1 - sl / 100);
    console.log(`  ── ${sl}% Stop Loss ──`);
    console.log(`    Model:             ${c.description}`);
    console.log(`    Premium:           Calm $${c.calm} | Normal $${c.normal} | Stress $${c.stress} (per $10k)`);
    console.log(`    Payout on breach:  $${payout}`);
    console.log(`    Example: BTC long at $${exampleEntry.toLocaleString()}, SL at $${triggerPx.toLocaleString()} (-${sl}%)`);
    console.log(`      → Trader pays $${c.normal} (normal market)`);
    console.log(`      → If BTC drops to $${triggerPx.toLocaleString()}, trader receives $${payout}`);
    console.log(`      → Max loss WITH protection: $${c.normal} (the premium)`);
    console.log(`      → Max loss WITHOUT protection: $${payout}`);
    console.log(`      → Savings on breach: $${payout - c.normal}`);
    console.log();
  }

  // ═══════════════════════════════════════════════════════════════════
  // PART 2: PLATFORM P&L SIMULATION
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n═══════════════════════════════════════════════════════════════════════════");
  console.log("  PART 2: PLATFORM P&L SIMULATION (${DAILY_PROTECTIONS}/day, regime pricing)");
  console.log("═══════════════════════════════════════════════════════════════════════════\n");

  for (const sl of SL_TIERS) {
    const c = PRICING_CONFIG[sl];
    console.log(`\n  ── ${sl}% SL | ${c.description} ──\n`);

    for (const treasuryStart of TREASURY_SIZES) {
      let treasury = treasuryStart;
      let minTreasury = treasury, maxDD = 0;
      let totalPremiums = 0, totalHedgeCosts = 0, totalPayouts = 0, totalResidual = 0;
      let totalTpProfit = 0;
      let triggerCount = 0, totalProtections = 0;
      let worstMonth = Infinity, bestMonth = -Infinity;
      let monthPnl = 0, monthCount = 0;
      let currentMonth = "";
      let recoveredAfterDD = true, ddRecoveryDay = 0;
      let maxDDday = 0;

      for (let i = 0; i + TENOR < prices.length; i++) {
        const entry = prices[i].price;
        if (entry <= 0) continue;

        const thisMonth = prices[i].date.slice(0, 7);
        if (thisMonth !== currentMonth) {
          if (currentMonth) {
            if (monthPnl < worstMonth) worstMonth = monthPnl;
            if (monthPnl > bestMonth) bestMonth = monthPnl;
          }
          currentMonth = thisMonth;
          monthPnl = 0;
          monthCount++;
        }

        const vol30 = rVol(pv.slice(0, i + 1), 30);
        const reg = regime(vol30);
        const premium = c[reg];
        const trigger = entry * (1 - sl / 100);
        const qty = NOTIONAL / entry;
        const vol = vol30 * 1.15;
        const hedgeCost = bsPut(entry, trigger, TENOR / 365, RF, vol) * qty;

        const window = prices.slice(i, i + TENOR + 1).map(p => p.price);
        const minPx = Math.min(...window);
        const triggered = minPx <= trigger;
        const payout = triggered ? NOTIONAL * (sl / 100) : 0;

        let residual = 0;
        let tpProfit = 0;
        if (triggered) {
          const expiryPx = prices[i + TENOR]?.price || entry;
          residual = Math.max(0, trigger - expiryPx) * qty;

          // Take-profit: find the minimum price during window after trigger
          let triggerDay = 0;
          for (let d = 0; d < window.length; d++) { if (window[d] <= trigger) { triggerDay = d; break; } }
          let minAfterTrigger = trigger;
          for (let d = triggerDay; d < window.length; d++) {
            if (window[d] < minAfterTrigger) minAfterTrigger = window[d];
          }
          // Option value at the deepest point after trigger
          const tpValue = Math.max(0, trigger - minAfterTrigger) * qty;
          tpProfit = tpValue;
        }

        totalProtections++;
        treasury += premium - hedgeCost - payout + residual;
        totalPremiums += premium;
        totalHedgeCosts += hedgeCost;
        totalPayouts += payout;
        totalResidual += residual;
        totalTpProfit += tpProfit;
        if (triggered) triggerCount++;

        monthPnl += premium - hedgeCost - payout + residual;

        if (treasury < minTreasury) { minTreasury = treasury; maxDDday = i; }
        const dd = treasuryStart - treasury;
        if (dd > maxDD) maxDD = dd;
      }

      // Final month
      if (monthPnl < worstMonth) worstMonth = monthPnl;
      if (monthPnl > bestMonth) bestMonth = monthPnl;

      const avgPremium = totalPremiums / totalProtections;
      const avgHedge = totalHedgeCosts / totalProtections;
      const avgPayout = totalPayouts / totalProtections;
      const avgResidual = totalResidual / totalProtections;
      const avgPnl = (totalPremiums - totalHedgeCosts - totalPayouts + totalResidual) / totalProtections;
      const trigRate = triggerCount / totalProtections;
      const totalNetPnl = totalPremiums - totalHedgeCosts - totalPayouts + totalResidual;
      const annualizedPnl = totalNetPnl / (prices.length / 365);

      console.log(`    Treasury $${(treasuryStart / 1000)}k:`);
      console.log(`      Ending treasury:   $${treasury.toFixed(0).padStart(10)} (${treasury >= treasuryStart ? "PROFIT" : "LOSS"})`);
      console.log(`      Min treasury:      $${minTreasury.toFixed(0).padStart(10)} (day ${maxDDday})`);
      console.log(`      Max drawdown:      $${maxDD.toFixed(0).padStart(10)}`);
      console.log(`      Total premiums:    $${totalPremiums.toFixed(0).padStart(10)}`);
      console.log(`      Total hedge costs: $${totalHedgeCosts.toFixed(0).padStart(10)}`);
      console.log(`      Total payouts:     $${totalPayouts.toFixed(0).padStart(10)}`);
      console.log(`      Option recovery:   $${totalResidual.toFixed(0).padStart(10)}`);
      console.log(`      Net P&L:           $${totalNetPnl.toFixed(0).padStart(10)}`);
      console.log(`      Annualized P&L:    $${annualizedPnl.toFixed(0).padStart(10)}/year`);
      console.log(`      Trigger rate:      ${(trigRate * 100).toFixed(1)}%`);
      console.log(`      Avg premium:       $${avgPremium.toFixed(2)}/trade`);
      console.log(`      Avg hedge cost:    $${avgHedge.toFixed(2)}/trade`);
      console.log(`      Avg P&L per trade: $${avgPnl.toFixed(2)}`);
      console.log(`      Worst month:       $${worstMonth.toFixed(0)}`);
      console.log(`      Best month:        $${bestMonth.toFixed(0)}`);
      console.log(`      TP potential:      $${totalTpProfit.toFixed(0)} (if sold at deepest point after breach)`);
      console.log();
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // PART 3: TAKE-PROFIT ANALYSIS
  // ═══════════════════════════════════════════════════════════════════
  console.log("═══════════════════════════════════════════════════════════════════════════");
  console.log("  PART 3: TAKE-PROFIT ON BREACH — SELL OPTION EARLY VS HOLD TO EXPIRY");
  console.log("═══════════════════════════════════════════════════════════════════════════\n");

  for (const sl of SL_TIERS) {
    let holdTotal = 0, tpTotal = 0, tpBetter = 0, holdBetter = 0, trigN = 0;

    for (let i = 0; i + TENOR < prices.length; i++) {
      const entry = prices[i].price;
      if (entry <= 0) continue;
      const trigger = entry * (1 - sl / 100);
      const qty = NOTIONAL / entry;
      const window = prices.slice(i, i + TENOR + 1).map(p => p.price);
      const minPx = Math.min(...window);
      if (minPx > trigger) continue;
      trigN++;

      const expiryPx = prices[i + TENOR]?.price || entry;
      const holdValue = Math.max(0, trigger - expiryPx) * qty;

      let triggerDay = 0;
      for (let d = 0; d < window.length; d++) { if (window[d] <= trigger) { triggerDay = d; break; } }

      // TP strategy: sell when option gains 50% above payout, or at deepest point within 2 days of trigger
      let bestTpValue = 0;
      for (let d = triggerDay; d < Math.min(triggerDay + 3, window.length); d++) {
        const optValue = Math.max(0, trigger - window[d]) * qty;
        if (optValue > bestTpValue) bestTpValue = optValue;
      }
      // Also check if we can cover payout + 30% profit
      const payout = NOTIONAL * (sl / 100);
      const targetTp = payout * 1.3;
      let tpValue = bestTpValue;

      // Use whichever is better: TP within 2 days or hold to expiry
      holdTotal += holdValue;
      tpTotal += tpValue;
      if (tpValue > holdValue) tpBetter++;
      else holdBetter++;
    }

    if (trigN === 0) { console.log(`  ${sl}% SL: no triggers`); continue; }
    console.log(`  ${sl}% SL (${trigN} trigger events):`);
    console.log(`    Hold to expiry:     $${(holdTotal / trigN).toFixed(2)} avg | $${holdTotal.toFixed(0)} total`);
    console.log(`    Take-profit (2d):   $${(tpTotal / trigN).toFixed(2)} avg | $${tpTotal.toFixed(0)} total`);
    console.log(`    TP better:          ${tpBetter} times (${(tpBetter / trigN * 100).toFixed(0)}%)`);
    console.log(`    Hold better:        ${holdBetter} times (${(holdBetter / trigN * 100).toFixed(0)}%)`);
    console.log(`    Improvement:        ${tpTotal > holdTotal ? "+" : ""}$${(tpTotal - holdTotal).toFixed(0)} total (${((tpTotal / holdTotal - 1) * 100).toFixed(0)}%)`);
    console.log();
  }

  // ═══════════════════════════════════════════════════════════════════
  // PART 4: COMBINED SUMMARY
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n═══════════════════════════════════════════════════════════════════════════");
  console.log("  PART 4: COMBINED SUMMARY — TRADER vs PLATFORM");
  console.log("═══════════════════════════════════════════════════════════════════════════\n");

  console.log("  ┌──────┬───────────────────────────────────────┬────────────────────────────────────────────┐");
  console.log("  │ SL%  │ TRADER                                │ PLATFORM ($100k treasury)                  │");
  console.log("  ├──────┼───────────────────────────────────────┼────────────────────────────────────────────┤");

  for (const sl of SL_TIERS) {
    const c = PRICING_CONFIG[sl];
    const payout = NOTIONAL * (sl / 100);

    let treasury = 100_000, minT = treasury, totalPrem = 0, totalPay = 0, totalNet = 0, n = 0;
    for (let i = 0; i + TENOR < prices.length; i++) {
      const entry = prices[i].price;
      if (entry <= 0) continue;
      n++;
      const vol30 = rVol(pv.slice(0, i + 1), 30);
      const reg = regime(vol30);
      const prem = c[reg];
      const trigger = entry * (1 - sl / 100);
      const qty = NOTIONAL / entry;
      const hedge = bsPut(entry, trigger, TENOR / 365, RF, vol30 * 1.15) * qty;
      const window = prices.slice(i, i + TENOR + 1).map(p => p.price);
      const triggered = Math.min(...window) <= trigger;
      const pay = triggered ? payout : 0;
      const expiryPx = prices[i + TENOR]?.price || entry;
      const resid = triggered ? Math.max(0, trigger - expiryPx) * qty : 0;
      treasury += prem - hedge - pay + resid;
      totalPrem += prem;
      totalPay += pay;
      totalNet += prem - hedge - pay + resid;
      if (treasury < minT) minT = treasury;
    }

    const avgPrem = totalPrem / n;
    const traderSaving = payout - avgPrem;
    const traderDesc = `Pays $${avgPrem.toFixed(0)} avg | Gets $${payout} on breach`.padEnd(37);
    const platDesc = `Net $${totalNet.toFixed(0)} | Min $${minT.toFixed(0)} | End $${treasury.toFixed(0)}`.padEnd(40);
    console.log(`  │ ${String(sl).padStart(3)}% │ ${traderDesc} │ ${platDesc} │`);
  }
  console.log("  └──────┴───────────────────────────────────────┴────────────────────────────────────────────┘\n");
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
