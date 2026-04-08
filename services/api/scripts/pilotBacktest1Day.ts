/**
 * Backtest: 1-Day Tenor across all SL tiers
 * + Live Deribit pricing for 1-day BTC puts
 * 
 * Tests if shorter tenor dramatically reduces hedge cost
 * while maintaining protection value
 */

const SL_TIERS = [1, 2, 3, 5, 10];
const TENOR = 1;
const NOTIONAL = 10_000;
const RF = 0.05;
const TEST_PREMIUMS = [3, 5, 7, 8, 10, 12, 15, 20, 25, 30];

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

function regime(vol: number): "calm" | "normal" | "stress" {
  return vol < 0.40 ? "calm" : vol < 0.65 ? "normal" : "stress";
}

async function fetchPrices(start: string, end: string): Promise<{ date: string; price: number; low: number; high: number }[]> {
  const all = new Map<string, { price: number; low: number; high: number }>();
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
        for (const [ts, lo, hi, op, cl] of c) {
          all.set(new Date(ts * 1000).toISOString().slice(0, 10), { price: cl, low: lo, high: hi });
        }
        break;
      } catch (e: any) { if (retries <= 0) throw e; await new Promise(r => setTimeout(r, 2000)); }
    }
    cur = ce; await new Promise(r => setTimeout(r, 500));
  }
  return Array.from(all.entries()).map(([d, v]) => ({ date: d, ...v })).sort((a, b) => a.date.localeCompare(b.date));
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════════════════");
  console.log("  1-DAY TENOR BACKTEST + LIVE DERIBIT PRICING");
  console.log("  SL Tiers: " + SL_TIERS.join("%, ") + "% | Tenor: " + TENOR + " day | Notional: $" + NOTIONAL.toLocaleString());
  console.log("  " + new Date().toISOString());
  console.log("═══════════════════════════════════════════════════════════════════════════\n");

  const prices = await fetchPrices("2022-01-01", "2026-04-07");
  console.log(`  ${prices.length} days loaded\n`);
  const pv = prices.map(p => p.price);

  // ═══════════════════════════════════════════════════════════════════
  // BACKTEST: 1-DAY vs 7-DAY comparison
  // ═══════════════════════════════════════════════════════════════════

  for (const tenor of [1, 2, 7]) {
    console.log("═══════════════════════════════════════════════════════════════════════════");
    console.log(`  ${tenor}-DAY TENOR — Market IV (vol × 0.85)`);
    console.log("═══════════════════════════════════════════════════════════════════════════\n");

    console.log("  SL%  │ Trig Rt │ Hedge/$1k │ Payout/$1k │ Recov/$1k │ BE/$1k  │ P&L @$5 │ P&L @$8 │ P&L @$10 │ P&L @$15");
    console.log("  ─────┼─────────┼───────────┼────────────┼───────────┼─────────┼─────────┼─────────┼──────────┼─────────");

    for (const sl of SL_TIERS) {
      let triggers = 0, n = 0, totalHedge = 0, totalPayout = 0, totalRecov = 0;
      const pnlAccum: Record<number, number[]> = {};
      for (const p of TEST_PREMIUMS) pnlAccum[p] = [];

      for (let i = 0; i + tenor < prices.length; i++) {
        const entry = prices[i].price;
        if (entry <= 0) continue;
        n++;
        const trigger = entry * (1 - sl / 100);
        const qty = NOTIONAL / entry;
        const T = tenor / 365;
        const vol = rVol(pv.slice(0, i + 1), 30) * 0.85;
        const hedge = bsPut(entry, trigger, T, RF, vol) * qty;
        totalHedge += hedge;

        // Use intraday low for 1-day check (more accurate than close-only)
        let triggered = false;
        if (tenor === 1) {
          triggered = prices[i + 1]?.low <= trigger;
        } else {
          const window = prices.slice(i, i + tenor + 1);
          const minPx = Math.min(...window.map(p => p.low));
          triggered = minPx <= trigger;
        }

        const payout = triggered ? NOTIONAL * (sl / 100) : 0;
        totalPayout += payout;
        if (triggered) triggers++;

        let recov = 0;
        if (triggered) {
          const expiryPx = prices[i + tenor]?.price || entry;
          recov = Math.max(0, trigger - expiryPx) * qty;
        }
        totalRecov += recov;

        for (const prem of TEST_PREMIUMS) {
          pnlAccum[prem].push(prem - hedge / (NOTIONAL / 1000) - payout / (NOTIONAL / 1000) + recov / (NOTIONAL / 1000));
        }
      }

      const trigRate = triggers / n;
      const avgH = totalHedge / n / (NOTIONAL / 1000);
      const avgP = totalPayout / n / (NOTIONAL / 1000);
      const avgR = totalRecov / n / (NOTIONAL / 1000);
      const be = avgH + avgP - avgR;

      const p5 = pnlAccum[5] ? pnlAccum[5].reduce((s, v) => s + v, 0) / pnlAccum[5].length : 0;
      const p8 = pnlAccum[8] ? pnlAccum[8].reduce((s, v) => s + v, 0) / pnlAccum[8].length : 0;
      const p10 = pnlAccum[10] ? pnlAccum[10].reduce((s, v) => s + v, 0) / pnlAccum[10].length : 0;
      const p15 = pnlAccum[15] ? pnlAccum[15].reduce((s, v) => s + v, 0) / pnlAccum[15].length : 0;

      const f = (v: number) => (v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2)).padStart(7);

      console.log(`  ${String(sl).padStart(3)}%  │ ${(trigRate * 100).toFixed(1).padStart(5)}%  │ $${avgH.toFixed(2).padStart(7)} │ $${avgP.toFixed(2).padStart(8)} │ $${avgR.toFixed(2).padStart(7)} │ $${be.toFixed(2).padStart(5)}  │ $${f(p5)} │ $${f(p8)} │ $${f(p10)}  │ $${f(p15)}`);
    }

    // Win rates
    console.log(`\n  Win rates:`);
    console.log("  SL%  │ @$5   │ @$8   │ @$10  │ @$15  │ @$20  │ @$25  │ @$30 ");
    console.log("  ─────┼───────┼───────┼───────┼───────┼───────┼───────┼──────");
    for (const sl of SL_TIERS) {
      let n = 0;
      const pnlAccum: Record<number, number[]> = {};
      for (const p of TEST_PREMIUMS) pnlAccum[p] = [];

      for (let i = 0; i + tenor < prices.length; i++) {
        const entry = prices[i].price;
        if (entry <= 0) continue;
        n++;
        const trigger = entry * (1 - sl / 100);
        const qty = NOTIONAL / entry;
        const vol = rVol(pv.slice(0, i + 1), 30) * 0.85;
        const hedge = bsPut(entry, trigger, tenor / 365, RF, vol) * qty;
        let triggered = false;
        if (tenor === 1) { triggered = prices[i + 1]?.low <= trigger; }
        else { triggered = Math.min(...prices.slice(i, i + tenor + 1).map(p => p.low)) <= trigger; }
        const payout = triggered ? NOTIONAL * (sl / 100) : 0;
        let recov = 0;
        if (triggered) { const ep = prices[i + tenor]?.price || entry; recov = Math.max(0, trigger - ep) * qty; }
        for (const prem of TEST_PREMIUMS) {
          pnlAccum[prem].push(prem - hedge / 10 - payout / 10 + recov / 10);
        }
      }

      const wr = (p: number) => pnlAccum[p] ? `${(pnlAccum[p].filter(v => v >= 0).length / pnlAccum[p].length * 100).toFixed(0)}%`.padStart(5) : "  N/A";
      console.log(`  ${String(sl).padStart(3)}%  │ ${wr(5)} │ ${wr(8)} │ ${wr(10)} │ ${wr(15)} │ ${wr(20)} │ ${wr(25)} │ ${wr(30)}`);
    }
    console.log();
  }

  // ═══════════════════════════════════════════════════════════════════
  // CALM vs STRESS breakdown for 1-day tenor
  // ═══════════════════════════════════════════════════════════════════
  console.log("═══════════════════════════════════════════════════════════════════════════");
  console.log("  1-DAY TENOR: CALM vs NORMAL vs STRESS");
  console.log("═══════════════════════════════════════════════════════════════════════════\n");

  for (const sl of SL_TIERS) {
    const regimeData: Record<string, { n: number; hedge: number; payout: number; recov: number; triggers: number }> = {
      calm: { n: 0, hedge: 0, payout: 0, recov: 0, triggers: 0 },
      normal: { n: 0, hedge: 0, payout: 0, recov: 0, triggers: 0 },
      stress: { n: 0, hedge: 0, payout: 0, recov: 0, triggers: 0 },
    };

    for (let i = 0; i + 1 < prices.length; i++) {
      const entry = prices[i].price;
      if (entry <= 0) continue;
      const vol30 = rVol(pv.slice(0, i + 1), 30);
      const reg = regime(vol30);
      const d = regimeData[reg];
      d.n++;
      const trigger = entry * (1 - sl / 100);
      const qty = NOTIONAL / entry;
      const vol = vol30 * 0.85;
      d.hedge += bsPut(entry, trigger, 1 / 365, RF, vol) * qty;
      const triggered = prices[i + 1]?.low <= trigger;
      const payout = triggered ? NOTIONAL * (sl / 100) : 0;
      d.payout += payout;
      if (triggered) d.triggers++;
      if (triggered) {
        const ep = prices[i + 1]?.price || entry;
        d.recov += Math.max(0, trigger - ep) * qty;
      }
    }

    console.log(`  ${sl}% SL (1-day):`);
    for (const [reg, d] of Object.entries(regimeData)) {
      if (d.n === 0) continue;
      const tr = (d.triggers / d.n * 100).toFixed(1);
      const h = (d.hedge / d.n / 10).toFixed(2);
      const p = (d.payout / d.n / 10).toFixed(2);
      const r = (d.recov / d.n / 10).toFixed(2);
      const be = ((d.hedge + d.payout - d.recov) / d.n / 10).toFixed(2);
      console.log(`    ${reg.padEnd(7)} │ N=${String(d.n).padStart(4)} │ Trig: ${tr.padStart(5)}% │ Hedge: $${h.padStart(5)}/$1k │ BE: $${be.padStart(5)}/$1k`);
    }
    console.log();
  }

  // ═══════════════════════════════════════════════════════════════════
  // LIVE DERIBIT PRICING
  // ═══════════════════════════════════════════════════════════════════
  console.log("═══════════════════════════════════════════════════════════════════════════");
  console.log("  LIVE DERIBIT 1-DAY PUT PRICING (mainnet, public API)");
  console.log("═══════════════════════════════════════════════════════════════════════════\n");

  try {
    const tickerRes = await fetch("https://www.deribit.com/api/v2/public/ticker?instrument_name=BTC-PERPETUAL");
    const tickerData = await tickerRes.json() as any;
    const btcPrice = tickerData?.result?.last_price || tickerData?.result?.mark_price || 0;
    console.log(`  BTC spot: $${Number(btcPrice).toFixed(2)}\n`);

    const instRes = await fetch("https://www.deribit.com/api/v2/public/get_instruments?currency=BTC&kind=option&expired=false");
    const instData = await instRes.json() as any;
    const instruments = instData?.result || [];

    const now = Date.now();
    const puts = instruments.filter((i: any) =>
      i.option_type === "put" &&
      i.is_active &&
      (i.expiration_timestamp - now) > 0 &&
      (i.expiration_timestamp - now) < 3 * 86400000
    );

    console.log(`  Found ${puts.length} puts expiring within 3 days\n`);

    if (puts.length > 0) {
      console.log("  SL%  │ Strike   │ Instrument                     │ Ask BTC    │ Hedge/$1k │ Expiry");
      console.log("  ─────┼──────────┼────────────────────────────────┼────────────┼───────────┼────────");

      for (const sl of SL_TIERS) {
        const targetStrike = btcPrice * (1 - sl / 100);
        const sorted = puts.sort((a: any, b: any) =>
          Math.abs(a.strike - targetStrike) - Math.abs(b.strike - targetStrike)
        );

        for (const inst of sorted.slice(0, 1)) {
          try {
            const obRes = await fetch(`https://www.deribit.com/api/v2/public/get_order_book?instrument_name=${inst.instrument_name}`);
            const obData = await obRes.json() as any;
            const bestAsk = obData?.result?.best_ask_price || 0;
            const askUsd = bestAsk * btcPrice;
            const qty = NOTIONAL / btcPrice;
            const hedgePer1k = (askUsd * qty) / (NOTIONAL / 1000);
            const expiry = new Date(inst.expiration_timestamp).toISOString().slice(0, 16);
            const otm = ((btcPrice - inst.strike) / btcPrice * 100).toFixed(1);

            console.log(`  ${String(sl).padStart(3)}%  │ $${String(inst.strike).padStart(6)} │ ${inst.instrument_name.padEnd(30)} │ ${bestAsk.toFixed(6).padStart(10)} │ $${hedgePer1k.toFixed(2).padStart(7)} │ ${expiry}`);
          } catch { continue; }
          await new Promise(r => setTimeout(r, 200));
        }
      }
    }
  } catch (e: any) {
    console.log(`  Deribit API error: ${e.message}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // COMPARISON: 1-day vs 2-day vs 7-day break-even
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n\n═══════════════════════════════════════════════════════════════════════════");
  console.log("  TENOR COMPARISON: Break-Even per $1k (Market IV)");
  console.log("═══════════════════════════════════════════════════════════════════════════\n");

  console.log("  SL%  │ 1-Day BE/$1k │ 2-Day BE/$1k │ 7-Day BE/$1k │ 1d Cheaper? │ Trigger 1d │ Trigger 7d");
  console.log("  ─────┼──────────────┼──────────────┼──────────────┼─────────────┼────────────┼───────────");

  for (const sl of SL_TIERS) {
    const bes: Record<number, { be: number; tr: number }> = {};
    for (const tenor of [1, 2, 7]) {
      let n = 0, totalH = 0, totalP = 0, totalR = 0, triggers = 0;
      for (let i = 0; i + tenor < prices.length; i++) {
        const entry = prices[i].price;
        if (entry <= 0) continue;
        n++;
        const trigger = entry * (1 - sl / 100);
        const qty = NOTIONAL / entry;
        const vol = rVol(pv.slice(0, i + 1), 30) * 0.85;
        totalH += bsPut(entry, trigger, tenor / 365, RF, vol) * qty;
        let triggered = false;
        if (tenor === 1) { triggered = prices[i + 1]?.low <= trigger; }
        else { triggered = Math.min(...prices.slice(i, i + tenor + 1).map(p => p.low)) <= trigger; }
        if (triggered) { triggers++; totalP += NOTIONAL * (sl / 100); const ep = prices[i + tenor]?.price || entry; totalR += Math.max(0, trigger - ep) * qty; }
      }
      bes[tenor] = { be: (totalH + totalP - totalR) / n / 10, tr: triggers / n };
    }

    const d1 = bes[1], d2 = bes[2], d7 = bes[7];
    const cheaper = d1.be < d7.be ? `${((1 - d1.be / d7.be) * 100).toFixed(0)}% cheaper` : `${((d1.be / d7.be - 1) * 100).toFixed(0)}% more`;

    console.log(`  ${String(sl).padStart(3)}%  │ $${d1.be.toFixed(2).padStart(10)} │ $${d2.be.toFixed(2).padStart(10)} │ $${d7.be.toFixed(2).padStart(10)} │ ${cheaper.padStart(11)} │ ${(d1.tr * 100).toFixed(1).padStart(8)}%  │ ${(d7.tr * 100).toFixed(1).padStart(7)}%`);
  }
  console.log();
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
