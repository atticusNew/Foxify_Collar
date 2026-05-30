/**
 * 1-Day Tiered Pricing Optimization
 * 
 * Find the LOWEST possible premium per SL tier that is:
 * 1. Profitable on average across all 4 years
 * 2. Profitable in each individual year
 * 3. Win rate > 50%
 * 4. Treasury-sustainable at $100k starting balance
 * 
 * Then validate against live Deribit mainnet pricing
 */

const SL_TIERS = [1, 2, 3, 5, 10];
const TENOR = 1;
const NOTIONAL = 10_000;
const RF = 0.05;
const TREASURY_START = 100_000;
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

async function main() {
  console.log("═══════════════════════════════════════════════════════════════════════════");
  console.log("  1-DAY TIERED PRICING OPTIMIZATION");
  console.log("  Goal: Lowest premium per tier that is sustainable and profitable");
  console.log("  " + new Date().toISOString());
  console.log("═══════════════════════════════════════════════════════════════════════════\n");

  const prices = await fetchPrices("2022-01-01", "2026-04-07");
  console.log(`  ${prices.length} days loaded\n`);
  const pv = prices.map(p => p.price);

  const years = [
    { name: "2022", start: "2022-01-01", end: "2022-12-31" },
    { name: "2023", start: "2023-01-01", end: "2023-12-31" },
    { name: "2024", start: "2024-01-01", end: "2024-12-31" },
    { name: "2025-26", start: "2025-01-01", end: "2026-04-07" },
  ];

  // ═══════════════════════════════════════════════════════════════════
  // STEP 1: Find break-even per tier per year
  // ═══════════════════════════════════════════════════════════════════
  console.log("═══════════════════════════════════════════════════════════════════════════");
  console.log("  STEP 1: Break-Even per Tier per Year (market IV, vol × 0.85)");
  console.log("═══════════════════════════════════════════════════════════════════════════\n");

  const yearBEs: Record<number, Record<string, number>> = {};

  for (const sl of SL_TIERS) {
    yearBEs[sl] = {};
    for (const yr of years) {
      const yrPrices = prices.filter(p => p.date >= yr.start && p.date <= yr.end);
      let n = 0, totalH = 0, totalP = 0, totalR = 0, trigs = 0;
      for (let i = 0; i + 1 < yrPrices.length; i++) {
        const entry = yrPrices[i].price;
        if (entry <= 0) continue;
        n++;
        const trigger = entry * (1 - sl / 100);
        const qty = NOTIONAL / entry;
        const globalIdx = pv.indexOf(entry);
        const vol = rVol(pv.slice(0, Math.max(globalIdx + 1, 30)), 30) * 0.85;
        const hedge = bsPut(entry, trigger, 1 / 365, RF, vol) * qty;
        totalH += hedge;
        const triggered = yrPrices[i + 1]?.low <= trigger;
        if (triggered) {
          trigs++;
          totalP += NOTIONAL * (sl / 100);
          const ep = yrPrices[i + 1]?.price || entry;
          totalR += Math.max(0, trigger - ep) * qty;
        }
      }
      const be = n > 0 ? (totalH + totalP - totalR) / n / (NOTIONAL / 1000) : 0;
      yearBEs[sl][yr.name] = be;
    }
  }

  console.log("  SL%  │ 2022    │ 2023    │ 2024    │ 2025-26 │ Max (worst yr) │ Avg");
  console.log("  ─────┼─────────┼─────────┼─────────┼─────────┼────────────────┼────────");
  for (const sl of SL_TIERS) {
    const vals = years.map(y => yearBEs[sl][y.name]);
    const max = Math.max(...vals);
    const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
    console.log(`  ${String(sl).padStart(3)}%  │ $${vals[0].toFixed(2).padStart(5)} │ $${vals[1].toFixed(2).padStart(5)} │ $${vals[2].toFixed(2).padStart(5)} │ $${vals[3].toFixed(2).padStart(5)} │ $${max.toFixed(2).padStart(12)} │ $${avg.toFixed(2).padStart(5)}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // STEP 2: Find optimal price per tier
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n═══════════════════════════════════════════════════════════════════════════");
  console.log("  STEP 2: Optimal Tiered Pricing (lowest sustainable price)");
  console.log("═══════════════════════════════════════════════════════════════════════════\n");

  const optimalPrices: Record<number, number> = {};

  for (const sl of SL_TIERS) {
    const worstYearBE = Math.max(...years.map(y => yearBEs[sl][y.name]));
    // Price = worst year break-even + 20% margin, rounded to nearest $0.25
    const raw = worstYearBE * 1.20;
    const rounded = Math.ceil(raw * 4) / 4;
    optimalPrices[sl] = rounded;
  }

  console.log("  SL%  │ Worst Yr BE │ +20% Margin │ Optimal/$1k │ Per $10k/day │ Per $10k/week");
  console.log("  ─────┼─────────────┼─────────────┼─────────────┼──────────────┼──────────────");
  for (const sl of SL_TIERS) {
    const wbe = Math.max(...years.map(y => yearBEs[sl][y.name]));
    const opt = optimalPrices[sl];
    console.log(`  ${String(sl).padStart(3)}%  │ $${wbe.toFixed(2).padStart(9)} │ $${(wbe * 1.2).toFixed(2).padStart(9)} │ $${opt.toFixed(2).padStart(9)} │ $${(opt * 10).toFixed(0).padStart(10)} │ $${(opt * 10 * 7).toFixed(0).padStart(10)}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // STEP 3: Full P&L simulation at optimal prices
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n═══════════════════════════════════════════════════════════════════════════");
  console.log("  STEP 3: P&L at Optimal Prices (full 4-year, market IV)");
  console.log("═══════════════════════════════════════════════════════════════════════════\n");

  console.log("  SL%  │ Price/$1k │ Avg P&L/$1k │ Win Rate │ Trig Rate │ Hedge/$1k │ Weekly Cost/$10k │ Trader Value");
  console.log("  ─────┼───────────┼─────────────┼──────────┼───────────┼───────────┼──────────────────┼─────────────");

  for (const sl of SL_TIERS) {
    const prem = optimalPrices[sl];
    let n = 0, wins = 0, trigs = 0, totalH = 0, totalPnl = 0;
    for (let i = 0; i + 1 < prices.length; i++) {
      const entry = prices[i].price;
      if (entry <= 0) continue;
      n++;
      const trigger = entry * (1 - sl / 100);
      const qty = NOTIONAL / entry;
      const vol = rVol(pv.slice(0, i + 1), 30) * 0.85;
      const hedge = bsPut(entry, trigger, 1 / 365, RF, vol) * qty / (NOTIONAL / 1000);
      totalH += hedge;
      const triggered = prices[i + 1]?.low <= trigger;
      const payout = triggered ? sl : 0;
      if (triggered) trigs++;
      let recov = 0;
      if (triggered) {
        const ep = prices[i + 1]?.price || entry;
        recov = Math.max(0, trigger - ep) * qty / (NOTIONAL / 1000);
      }
      const pnl = prem - hedge - payout + recov;
      totalPnl += pnl;
      if (pnl >= 0) wins++;
    }

    const avgPnl = totalPnl / n;
    const winRate = wins / n;
    const trigRate = trigs / n;
    const avgH = totalH / n;
    const weeklyCost = prem * 10 * 7;
    const payoutAmt = NOTIONAL * (sl / 100);
    const traderSaves = payoutAmt - (prem * 10);

    console.log(`  ${String(sl).padStart(3)}%  │ $${prem.toFixed(2).padStart(7)} │ $${avgPnl.toFixed(2).padStart(9)} │ ${(winRate * 100).toFixed(0).padStart(6)}%  │ ${(trigRate * 100).toFixed(1).padStart(7)}%  │ $${avgH.toFixed(2).padStart(7)} │ $${weeklyCost.toFixed(0).padStart(14)} │ Saves $${traderSaves.toFixed(0)} on breach`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // STEP 4: Treasury simulation at optimal prices
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n═══════════════════════════════════════════════════════════════════════════");
  console.log(`  STEP 4: Treasury Simulation ($${TREASURY_START/1000}k start, ${DAILY_PROTS} protections/day)`);
  console.log("═══════════════════════════════════════════════════════════════════════════\n");

  for (const sl of SL_TIERS) {
    const prem = optimalPrices[sl] * (NOTIONAL / 1000);
    let treasury = TREASURY_START, minT = treasury, maxDD = 0;
    let totalPrem = 0, totalPay = 0, totalRecov = 0;

    for (let i = 0; i + 1 < prices.length; i++) {
      const entry = prices[i].price;
      if (entry <= 0) continue;
      for (let p = 0; p < DAILY_PROTS; p++) {
        const trigger = entry * (1 - sl / 100);
        const qty = NOTIONAL / entry;
        const vol = rVol(pv.slice(0, i + 1), 30) * 0.85;
        const hedge = bsPut(entry, trigger, 1 / 365, RF, vol) * qty;
        const triggered = prices[i + 1]?.low <= trigger;
        const payout = triggered ? NOTIONAL * (sl / 100) : 0;
        let recov = 0;
        if (triggered) { const ep = prices[i + 1]?.price || entry; recov = Math.max(0, trigger - ep) * qty; }

        treasury += prem - hedge - payout + recov;
        totalPrem += prem;
        totalPay += payout;
        totalRecov += recov;
      }
      if (treasury < minT) minT = treasury;
      const dd = TREASURY_START - treasury;
      if (dd > maxDD) maxDD = dd;
    }

    const net = treasury - TREASURY_START;
    const annual = net / (prices.length / 365);
    console.log(`  ${sl}% SL @ $${optimalPrices[sl].toFixed(2)}/1k:`);
    console.log(`    End:     $${treasury.toFixed(0).padStart(10)} (${net >= 0 ? "PROFIT" : "LOSS"} $${Math.abs(net).toFixed(0)})`);
    console.log(`    Min:     $${minT.toFixed(0).padStart(10)} | MaxDD: $${maxDD.toFixed(0)}`);
    console.log(`    Annual:  $${annual.toFixed(0).padStart(10)}/year`);
    console.log(`    Premiums: $${totalPrem.toFixed(0)} | Payouts: $${totalPay.toFixed(0)} | Recovery: $${totalRecov.toFixed(0)}`);
    console.log();
  }

  // ═══════════════════════════════════════════════════════════════════
  // STEP 5: Live Deribit validation
  // ═══════════════════════════════════════════════════════════════════
  console.log("═══════════════════════════════════════════════════════════════════════════");
  console.log("  STEP 5: Live Deribit Mainnet — 1-Day Put Prices vs Optimal Premiums");
  console.log("═══════════════════════════════════════════════════════════════════════════\n");

  try {
    const tickerRes = await fetch("https://www.deribit.com/api/v2/public/ticker?instrument_name=BTC-PERPETUAL");
    const tickerData = await tickerRes.json() as any;
    const btcPrice = Number(tickerData?.result?.last_price || 0);
    console.log(`  BTC spot: $${btcPrice.toFixed(2)}\n`);

    const instRes = await fetch("https://www.deribit.com/api/v2/public/get_instruments?currency=BTC&kind=option&expired=false");
    const instruments = ((await instRes.json()) as any)?.result || [];
    const now = Date.now();
    const puts1d = instruments.filter((i: any) => i.option_type === "put" && i.is_active && (i.expiration_timestamp - now) > 0 && (i.expiration_timestamp - now) < 2.5 * 86400000);

    console.log("  SL%  │ Optimal/$1k │ Strike   │ Instrument                 │ Ask BTC    │ Hedge/$1k │ Spread/$1k │ Margin");
    console.log("  ─────┼─────────────┼──────────┼────────────────────────────┼────────────┼───────────┼────────────┼───────");

    for (const sl of SL_TIERS) {
      const targetStrike = btcPrice * (1 - sl / 100);
      const sorted = puts1d.sort((a: any, b: any) => Math.abs(a.strike - targetStrike) - Math.abs(b.strike - targetStrike));
      const inst = sorted[0];
      if (!inst) { console.log(`  ${String(sl).padStart(3)}%  │ No 1-day put found`); continue; }

      try {
        const obRes = await fetch(`https://www.deribit.com/api/v2/public/get_order_book?instrument_name=${inst.instrument_name}`);
        const ob = ((await obRes.json()) as any)?.result;
        const askBtc = ob?.best_ask_price || 0;
        const askUsd = askBtc * btcPrice;
        const qty = NOTIONAL / btcPrice;
        const hedgePer1k = (askUsd * qty) / (NOTIONAL / 1000);
        const optimal = optimalPrices[sl];
        const spread = optimal - hedgePer1k;
        const margin = hedgePer1k > 0 ? ((spread / hedgePer1k) * 100).toFixed(0) + "%" : "∞";

        console.log(`  ${String(sl).padStart(3)}%  │ $${optimal.toFixed(2).padStart(9)} │ $${String(inst.strike).padStart(6)} │ ${inst.instrument_name.padEnd(26)} │ ${askBtc.toFixed(6).padStart(10)} │ $${hedgePer1k.toFixed(2).padStart(7)} │ $${spread.toFixed(2).padStart(8)} │ ${margin.padStart(5)}`);
      } catch { continue; }
      await new Promise(r => setTimeout(r, 200));
    }
  } catch (e: any) {
    console.log(`  Deribit error: ${e.message}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // FINAL: CEO Presentation
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n\n═══════════════════════════════════════════════════════════════════════════");
  console.log("  FINAL: CEO PRESENTATION — WHAT THE TRADER PAYS");
  console.log("═══════════════════════════════════════════════════════════════════════════\n");

  console.log("  ┌──────┬──────────────┬───────────────┬──────────────┬──────────────┬────────────────┐");
  console.log("  │ SL%  │ Per Day/$10k │ Per Week/$10k │ Payout/$10k  │ Max Loss     │ Without Protect│");
  console.log("  ├──────┼──────────────┼───────────────┼──────────────┼──────────────┼────────────────┤");
  for (const sl of SL_TIERS) {
    const opt = optimalPrices[sl];
    const daily = opt * 10;
    const weekly = daily * 7;
    const payout = NOTIONAL * (sl / 100);
    console.log(`  │ ${String(sl).padStart(3)}% │ $${daily.toFixed(0).padStart(10)} │ $${weekly.toFixed(0).padStart(11)} │ $${payout.toFixed(0).padStart(10)} │ $${daily.toFixed(0).padStart(10)} │ $${payout.toFixed(0).padStart(12)} │`);
  }
  console.log("  └──────┴──────────────┴───────────────┴──────────────┴──────────────┴────────────────┘\n");

  console.log("  Example: $10,000 BTC Long, 2% Stop Loss");
  const ex = optimalPrices[2];
  console.log(`    Daily premium: $${(ex * 10).toFixed(2)}`);
  console.log(`    Weekly cost:   $${(ex * 10 * 7).toFixed(2)}`);
  console.log(`    Payout on SL:  $200`);
  console.log(`    Max daily loss with protection: $${(ex * 10).toFixed(2)}`);
  console.log(`    Max daily loss without: $200`);
  console.log(`    Savings on breach: $${(200 - ex * 10).toFixed(2)}`);
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
