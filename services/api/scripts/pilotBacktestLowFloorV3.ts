/**
 * Backtest V3: Tests 7-11
 * 7. Execution risk at high trigger frequencies
 * 8. Alternative structures (deductible, sliding scale, subscription)
 * 9. Competitor pricing comparison
 * 10. Monte Carlo simulation (synthetic paths)
 * 11. Break-even volume analysis
 */

const SL_TIERS = [1, 2, 3, 5, 10];
const TENOR = 7;
const NOTIONAL = 10_000;
const RF = 0.05;

// ─── Black-Scholes ───────────────────────────────────────────────────

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

// ─── Data fetch ──────────────────────────────────────────────────────

async function fetchPrices(start: string, end: string): Promise<{ date: string; price: number }[]> {
  const all = new Map<string, number>();
  let cur = new Date(start).getTime();
  const eMs = new Date(end).getTime();
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
        for (const [ts, lo, hi, op, cl] of candles) {
          all.set(new Date(ts * 1000).toISOString().slice(0, 10), cl);
        }
        break;
      } catch (e: any) { if (retries <= 0) throw e; await new Promise(r => setTimeout(r, 2000)); }
    }
    cur = ce;
    await new Promise(r => setTimeout(r, 500));
  }
  return Array.from(all.entries()).map(([d, p]) => ({ date: d, price: p })).sort((a, b) => a.date.localeCompare(b.date));
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

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════════════════════");
  console.log("  ATTICUS LOW-FLOOR BACKTEST V3 — TESTS 7-11");
  console.log("  " + new Date().toISOString());
  console.log("═══════════════════════════════════════════════════════════════════════════\n");

  console.log("Fetching 2022-2026 price data...");
  const prices = await fetchPrices("2022-01-01", "2026-04-07");
  console.log(`  ${prices.length} days loaded\n`);
  const pv = prices.map(p => p.price);

  // ═══════════════════════════════════════════════════════════════════
  // TEST 7: Execution Risk — Simultaneous Triggers
  // ═══════════════════════════════════════════════════════════════════
  console.log("═══════════════════════════════════════════════════════════════════════════");
  console.log("  TEST 7: EXECUTION RISK — SIMULTANEOUS TRIGGERS & LIQUIDITY");
  console.log("═══════════════════════════════════════════════════════════════════════════\n");

  for (const sl of SL_TIERS) {
    const dailyTriggers: number[] = [];
    let maxConsecutive = 0, currentStreak = 0;
    const burstEvents: { date: string; drop: number }[] = [];

    for (let i = 1; i < prices.length; i++) {
      const dayReturn = (prices[i].price - prices[i - 1].price) / prices[i - 1].price * 100;
      if (dayReturn <= -sl) {
        dailyTriggers.push(i);
        currentStreak++;
        burstEvents.push({ date: prices[i].date, drop: dayReturn });
      } else {
        if (currentStreak > maxConsecutive) maxConsecutive = currentStreak;
        currentStreak = 0;
      }
    }
    if (currentStreak > maxConsecutive) maxConsecutive = currentStreak;

    const portfolioSizes = [10, 20, 50];
    console.log(`  ${sl}% SL:`);
    console.log(`    Single-day triggers: ${dailyTriggers.length} / ${prices.length} days (${(dailyTriggers.length / prices.length * 100).toFixed(1)}%)`);
    console.log(`    Max consecutive trigger days: ${maxConsecutive}`);
    console.log(`    Worst single-day drops that trigger:`);
    const worstDrops = burstEvents.sort((a, b) => a.drop - b.drop).slice(0, 5);
    for (const w of worstDrops) console.log(`      ${w.date}: ${w.drop.toFixed(2)}%`);

    console.log(`    Simultaneous payout scenarios (all at $10k notional):`);
    for (const n of portfolioSizes) {
      const totalPayout = n * NOTIONAL * (sl / 100);
      const totalHedgeQty = n * NOTIONAL / 70000;
      console.log(`      ${n} positions: $${totalPayout.toLocaleString()} payout | ${totalHedgeQty.toFixed(2)} BTC in options needed`);
    }
    console.log();
  }

  // ═══════════════════════════════════════════════════════════════════
  // TEST 8: Alternative Structures
  // ═══════════════════════════════════════════════════════════════════
  console.log("═══════════════════════════════════════════════════════════════════════════");
  console.log("  TEST 8: ALTERNATIVE STRUCTURES");
  console.log("═══════════════════════════════════════════════════════════════════════════\n");

  // 8A: Deductible model
  console.log("  ── 8A: DEDUCTIBLE MODEL ──\n");
  console.log("  SL% │ Deductible │ Eff Trigger │ Eff Payout │ Hedge Cost │ Break-Even │ vs Standard");
  console.log("  ────┼────────────┼─────────────┼────────────┼────────────┼────────────┼────────────");

  for (const sl of [2, 3, 5]) {
    for (const deductible of [0.5, 1.0, 1.5]) {
      if (deductible >= sl) continue;
      const effFloor = sl;
      const coveredPct = sl - deductible;
      let triggers = 0, totalHedge = 0, totalPayout = 0, totalResidual = 0, n = 0;

      for (let i = 0; i + TENOR < prices.length; i++) {
        const entry = prices[i].price;
        if (entry <= 0) continue;
        n++;
        const triggerPx = entry * (1 - sl / 100);
        const qty = NOTIONAL / entry;
        const vol = rVol(pv.slice(0, i + 1), 30) * 1.15;
        const hedgeCost = bsPut(entry, triggerPx, TENOR / 365, RF, vol) * qty;
        totalHedge += hedgeCost;

        const window = prices.slice(i, i + TENOR + 1).map(p => p.price);
        const minPx = Math.min(...window);
        if (minPx <= triggerPx) {
          triggers++;
          totalPayout += NOTIONAL * (coveredPct / 100);
          const expiryPx = prices[i + TENOR]?.price || entry;
          totalResidual += Math.max(0, triggerPx - expiryPx) * qty;
        }
      }

      const trigRate = (triggers / n * 100).toFixed(0);
      const avgHedge = totalHedge / n;
      const avgPay = totalPayout / n;
      const avgResid = totalResidual / n;
      const be = avgHedge + avgPay - avgResid;
      const stdBe = sl === 2 ? 165 : sl === 3 ? 184 : 195;
      const saving = ((1 - be / stdBe) * 100).toFixed(0);

      console.log(`  ${String(sl).padStart(2)}%  │ ${String(deductible).padStart(4)}%      │ ${trigRate.padStart(7)}%     │ $${(NOTIONAL * coveredPct / 100).toFixed(0).padStart(7)}   │ $${avgHedge.toFixed(0).padStart(7)}    │ $${be.toFixed(0).padStart(7)}/10k │ ${saving.padStart(4)}% cheaper`);
    }
  }

  // 8B: Sliding scale incentive
  console.log("\n  ── 8B: SLIDING SCALE (incentivize wider SLs) ──\n");
  console.log("  Strategy: Price inversely to SL% to encourage wider stops\n");

  const slidingPrices: Record<number, number> = { 1: 150, 2: 100, 3: 70, 5: 45, 10: 25 };
  console.log("  SL% │ Premium │ Avg P&L/trade │ Annual P&L (5/day) │ Viable?");
  console.log("  ────┼─────────┼───────────────┼────────────────────┼────────");
  for (const sl of SL_TIERS) {
    const prem = slidingPrices[sl];
    let totalPnl = 0, n = 0;
    for (let i = 0; i + TENOR < prices.length; i++) {
      const entry = prices[i].price;
      if (entry <= 0) continue;
      n++;
      const trigger = entry * (1 - sl / 100);
      const qty = NOTIONAL / entry;
      const vol = rVol(pv.slice(0, i + 1), 30) * 1.15;
      const hedge = bsPut(entry, trigger, TENOR / 365, RF, vol) * qty;
      const window = prices.slice(i, i + TENOR + 1).map(p => p.price);
      const minPx = Math.min(...window);
      const triggered = minPx <= trigger;
      const payout = triggered ? NOTIONAL * (sl / 100) : 0;
      const expiryPx = prices[i + TENOR]?.price || entry;
      const residual = triggered ? Math.max(0, trigger - expiryPx) * qty : 0;
      totalPnl += prem - hedge - payout + residual;
    }
    const avgPnl = totalPnl / n;
    const annualPnl = avgPnl * 5 * 365;
    const viable = avgPnl > 0 ? "YES" : avgPnl > -20 ? "MARGINAL" : "NO";
    console.log(`  ${String(sl).padStart(2)}%  │ $${String(prem).padStart(5)}/10k │ $${avgPnl.toFixed(2).padStart(10)}   │ $${annualPnl.toFixed(0).padStart(15)}    │ ${viable}`);
  }

  // 8C: Subscription model
  console.log("\n  ── 8C: SUBSCRIPTION MODEL ──\n");
  const subFees = [300, 500, 750, 1000];
  const maxNotional = 50000;
  console.log("  Monthly fee │ Max notional │ Avg protections/mo │ Avg cost/mo │ Platform P&L │ Viable?");
  console.log("  ────────────┼──────────────┼────────────────────┼─────────────┼──────────────┼────────");

  for (const fee of subFees) {
    const protsPerMonth = 30;
    let totalCost = 0, n = 0;
    for (let i = 0; i + TENOR < prices.length && n < 1000; i += 7) {
      const entry = prices[i].price;
      if (entry <= 0) continue;
      n++;
      const trigger = entry * (1 - 3 / 100);
      const qty = maxNotional / entry;
      const vol = rVol(pv.slice(0, i + 1), 30) * 1.15;
      const hedge = bsPut(entry, trigger, TENOR / 365, RF, vol) * qty;
      const window = prices.slice(i, i + TENOR + 1).map(p => p.price);
      const payout = Math.min(...window) <= trigger ? maxNotional * 0.03 : 0;
      const expiryPx = prices[i + TENOR]?.price || entry;
      const residual = payout > 0 ? Math.max(0, trigger - expiryPx) * qty : 0;
      totalCost += hedge + payout - residual;
    }
    const avgMonthlyCost = (totalCost / n) * (30 / 7);
    const pnl = fee - avgMonthlyCost;
    const viable = pnl > 0 ? "YES" : "NO";
    console.log(`  $${String(fee).padStart(10)} │ $${maxNotional.toLocaleString().padStart(10)} │ ${String(Math.round(30 / 7)).padStart(15)}    │ $${avgMonthlyCost.toFixed(0).padStart(9)}   │ $${pnl.toFixed(0).padStart(10)}   │ ${viable}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // TEST 10: Monte Carlo Simulation
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n═══════════════════════════════════════════════════════════════════════════");
  console.log("  TEST 10: MONTE CARLO SIMULATION (10,000 synthetic 7-day paths)");
  console.log("═══════════════════════════════════════════════════════════════════════════\n");

  const historicalVol = rVol(pv, pv.length - 1);
  const dailyVol = historicalVol / Math.sqrt(365);
  const currentPrice = pv[pv.length - 1];
  console.log(`  Using: spot=$${currentPrice.toFixed(0)} | annualized vol=${(historicalVol * 100).toFixed(1)}% | daily vol=${(dailyVol * 100).toFixed(2)}%\n`);

  const N_PATHS = 10000;

  for (const sl of SL_TIERS) {
    let triggers = 0;
    let totalHedge = 0, totalPayout = 0, totalResidual = 0;
    const pnls: number[] = [];

    for (let path = 0; path < N_PATHS; path++) {
      let price = currentPrice;
      let minPrice = price;
      const trigger = price * (1 - sl / 100);
      const qty = NOTIONAL / price;
      const hedge = bsPut(price, trigger, TENOR / 365, RF, historicalVol * 1.15) * qty;
      totalHedge += hedge;

      for (let d = 0; d < TENOR; d++) {
        const z = gaussianRandom();
        price *= Math.exp((RF / 365 - 0.5 * dailyVol * dailyVol) + dailyVol * z);
        if (price < minPrice) minPrice = price;
      }

      const triggered = minPrice <= trigger;
      const payout = triggered ? NOTIONAL * (sl / 100) : 0;
      const residual = triggered ? Math.max(0, trigger - price) * qty : 0;

      if (triggered) triggers++;
      totalPayout += payout;
      totalResidual += residual;

      for (const prem of [50, 80, 100, 120, 150]) {
        if (prem === 80) pnls.push(prem - hedge - payout + residual);
      }
    }

    const trigRate = (triggers / N_PATHS * 100).toFixed(1);
    const avgHedge = totalHedge / N_PATHS;
    const avgPay = totalPayout / N_PATHS;
    const avgResid = totalResidual / N_PATHS;
    const be = avgHedge + avgPay - avgResid;

    const sortedPnls = pnls.sort((a, b) => a - b);
    const p5 = sortedPnls[Math.floor(N_PATHS * 0.05)];
    const p50 = sortedPnls[Math.floor(N_PATHS * 0.50)];
    const p95 = sortedPnls[Math.floor(N_PATHS * 0.95)];

    console.log(`  ${sl}% SL (Monte Carlo):`);
    console.log(`    Simulated trigger rate: ${trigRate}%`);
    console.log(`    Avg hedge cost:  $${avgHedge.toFixed(2)}/10k`);
    console.log(`    Avg payout:      $${avgPay.toFixed(2)}/10k`);
    console.log(`    Avg residual:    $${avgResid.toFixed(2)}/10k`);
    console.log(`    Break-even:      $${be.toFixed(2)}/10k ($${(be / 10).toFixed(2)}/1k)`);
    console.log(`    At $80/10k prem: P5=$${p5?.toFixed(0)} | Med=$${p50?.toFixed(0)} | P95=$${p95?.toFixed(0)}`);
    console.log();
  }

  // ═══════════════════════════════════════════════════════════════════
  // TEST 11: Break-Even Volume Analysis
  // ═══════════════════════════════════════════════════════════════════
  console.log("═══════════════════════════════════════════════════════════════════════════");
  console.log("  TEST 11: BREAK-EVEN VOLUME ANALYSIS");
  console.log("═══════════════════════════════════════════════════════════════════════════\n");
  console.log("  At aggressive pricing, how many protections/month needed to cover fixed costs?\n");

  const fixedMonthlyCosts = 2000;
  console.log(`  Assumed fixed monthly costs (infra, ops): $${fixedMonthlyCosts}`);
  console.log();
  console.log("  SL% │ Premium │ Avg Margin/trade │ Trades/mo to BE │ Revenue/mo @50/day │ Profit/mo @50/day");
  console.log("  ────┼─────────┼──────────────────┼─────────────────┼────────────────────┼──────────────────");

  for (const sl of SL_TIERS) {
    for (const prem of [50, 80, 120]) {
      let totalPnl = 0, n = 0;
      for (let i = 0; i + TENOR < prices.length; i++) {
        const entry = prices[i].price;
        if (entry <= 0) continue;
        n++;
        const trigger = entry * (1 - sl / 100);
        const qty = NOTIONAL / entry;
        const vol = rVol(pv.slice(0, i + 1), 30) * 1.15;
        const hedge = bsPut(entry, trigger, TENOR / 365, RF, vol) * qty;
        const window = prices.slice(i, i + TENOR + 1).map(p => p.price);
        const payout = Math.min(...window) <= trigger ? NOTIONAL * (sl / 100) : 0;
        const expiryPx = prices[i + TENOR]?.price || entry;
        const residual = payout > 0 ? Math.max(0, trigger - expiryPx) * qty : 0;
        totalPnl += prem - hedge - payout + residual;
      }
      const avgMargin = totalPnl / n;
      const tradesForBe = avgMargin > 0 ? Math.ceil(fixedMonthlyCosts / avgMargin) : -1;
      const dailyTrades = 50;
      const monthlyTrades = dailyTrades * 30;
      const monthlyRev = monthlyTrades * prem;
      const monthlyProfit = monthlyTrades * avgMargin - fixedMonthlyCosts;
      const beStr = tradesForBe > 0 ? String(tradesForBe) : "N/A (loss)";

      console.log(`  ${String(sl).padStart(2)}%  │ $${String(prem).padStart(5)}/10k │ $${avgMargin.toFixed(2).padStart(14)} │ ${beStr.padStart(13)}   │ $${monthlyRev.toLocaleString().padStart(16)} │ $${monthlyProfit.toFixed(0).padStart(14)}`);
    }
    console.log("  ────┼─────────┼──────────────────┼─────────────────┼────────────────────┼──────────────────");
  }

  // ═══════════════════════════════════════════════════════════════════
  // TEST 9: Competitor Pricing Reference
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n═══════════════════════════════════════════════════════════════════════════");
  console.log("  TEST 9: COMPETITOR / MARKET PRICING REFERENCE");
  console.log("═══════════════════════════════════════════════════════════════════════════\n");
  console.log("  DeFi protection protocols (approximate rates):\n");
  console.log("  Protocol       │ Coverage   │ Cost/year │ Equiv/7d per $10k │ Model");
  console.log("  ───────────────┼────────────┼───────────┼───────────────────┼──────────────");
  console.log("  Nexus Mutual   │ Smart cntr │ 2.6%      │ ~$50              │ Pool-based");
  console.log("  InsurAce       │ Protocol   │ 1-4%      │ $19-$77           │ Pool-based");
  console.log("  Bumper Finance │ Price floor│ 3-10%     │ $58-$192          │ Options-like");
  console.log("  Ribbon/Aevo    │ OTM puts   │ Market    │ $30-$150          │ Options vault");
  console.log("  Derive (Lyra)  │ OTM puts   │ Market    │ $40-$200          │ AMM options");
  console.log("  TradFi OTC     │ Collar     │ 1-3%      │ $19-$58           │ Structured");
  console.log("\n  Note: DeFi rates are approximate and vary by market conditions.\n");
  console.log("  Atticus competitive positioning:");
  console.log("  - At $80/10k (2% SL, 7d): competitive with Bumper/Ribbon");
  console.log("  - At $50/10k (5% SL, 7d): cheaper than most DeFi alternatives");
  console.log("  - Key differentiator: instant payout on breach (no claims process)");
  console.log("  - Key differentiator: no smart contract risk (CeFi hedge via Bullish)");
}

function gaussianRandom(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
