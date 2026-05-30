/**
 * Backtest V5: Market-realistic IV + Live Bullish SimNext comparison
 * 
 * Run A: Historical backtest with market-realistic IV (no 15% markup, 
 *        use 0.85x realized vol as proxy for market IV)
 * Run B: Snapshot using actual Bullish SimNext orderbook prices
 * 
 * Both compute: trigger rate, hedge cost, payout liability, option 
 * recovery, break-even, platform P&L at various premiums
 */

import { BullishTradingClient } from "../src/pilot/bullish.ts";

const SL_TIERS = [1, 2, 3, 5, 10];
const TENOR = 7;
const NOTIONAL = 10_000;
const RF = 0.05;
const TEST_PREMIUMS = [30, 40, 50, 60, 70, 80, 100, 120];

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
        const c = await res.json() as number[][];
        for (const [ts, , , , cl] of c) all.set(new Date(ts * 1000).toISOString().slice(0, 10), cl);
        break;
      } catch (e: any) { if (retries <= 0) throw e; await new Promise(r => setTimeout(r, 2000)); }
    }
    cur = ce; await new Promise(r => setTimeout(r, 500));
  }
  return Array.from(all.entries()).map(([d, p]) => ({ date: d, price: p })).sort((a, b) => a.date.localeCompare(b.date));
}

type RunResult = {
  sl: number;
  totalWindows: number;
  triggerCount: number;
  triggerRate: number;
  avgHedgeCost: number;
  avgPayout: number;
  avgRecovery: number;
  breakEven: number;
  pnlByPremium: Record<number, number>;
  winRateByPremium: Record<number, number>;
};

function runHistorical(prices: { date: string; price: number }[], volMultiplier: number, label: string): RunResult[] {
  const pv = prices.map(p => p.price);
  const results: RunResult[] = [];

  for (const sl of SL_TIERS) {
    let triggerCount = 0, totalWindows = 0;
    let totalHedge = 0, totalPayout = 0, totalRecovery = 0;
    const pnlAccum: Record<number, number[]> = {};
    for (const p of TEST_PREMIUMS) pnlAccum[p] = [];

    for (let i = 0; i + TENOR < prices.length; i++) {
      const entry = prices[i].price;
      if (entry <= 0) continue;
      totalWindows++;
      const trigger = entry * (1 - sl / 100);
      const qty = NOTIONAL / entry;
      const T = TENOR / 365;
      const vol = rVol(pv.slice(0, i + 1), 30) * volMultiplier;
      const hedgeCost = bsPut(entry, trigger, T, RF, vol) * qty;
      totalHedge += hedgeCost;

      const window = prices.slice(i, i + TENOR + 1).map(p => p.price);
      const minPx = Math.min(...window);
      const triggered = minPx <= trigger;
      const payout = triggered ? NOTIONAL * (sl / 100) : 0;
      totalPayout += payout;
      if (triggered) triggerCount++;

      let recovery = 0;
      if (triggered) {
        const expiryPx = prices[i + TENOR]?.price || entry;
        recovery = Math.max(0, trigger - expiryPx) * qty;
      }
      totalRecovery += recovery;

      for (const prem of TEST_PREMIUMS) {
        pnlAccum[prem].push(prem - hedgeCost - payout + recovery);
      }
    }

    const avgHedge = totalHedge / totalWindows;
    const avgPayout = totalPayout / totalWindows;
    const avgRecovery = totalRecovery / totalWindows;
    const breakEven = avgHedge + avgPayout - avgRecovery;

    const pnlByPremium: Record<number, number> = {};
    const winRateByPremium: Record<number, number> = {};
    for (const prem of TEST_PREMIUMS) {
      const arr = pnlAccum[prem];
      pnlByPremium[prem] = arr.reduce((s, v) => s + v, 0) / arr.length;
      winRateByPremium[prem] = arr.filter(v => v >= 0).length / arr.length;
    }

    results.push({
      sl, totalWindows, triggerCount,
      triggerRate: triggerCount / totalWindows,
      avgHedgeCost: avgHedge, avgPayout, avgRecovery, breakEven,
      pnlByPremium, winRateByPremium,
    });
  }
  return results;
}

function printResults(results: RunResult[], label: string) {
  console.log(`\n  ┌──────┬──────────┬────────────┬────────────┬────────────┬────────────┐`);
  console.log(`  │ SL%  │ Trig Rt  │ Hedge/10k  │ Payout/10k │ Recov/10k  │ Break-Even │`);
  console.log(`  ├──────┼──────────┼────────────┼────────────┼────────────┼────────────┤`);
  for (const r of results) {
    console.log(`  │ ${String(r.sl).padStart(3)}% │ ${(r.triggerRate * 100).toFixed(1).padStart(6)}%  │ $${r.avgHedgeCost.toFixed(0).padStart(8)} │ $${r.avgPayout.toFixed(0).padStart(8)} │ $${r.avgRecovery.toFixed(0).padStart(8)} │ $${r.breakEven.toFixed(0).padStart(8)} │`);
  }
  console.log(`  └──────┴──────────┴────────────┴────────────┴────────────┴────────────┘`);

  console.log(`\n  P&L per trade at various premiums:`);
  console.log(`  SL%  │ $30     │ $40     │ $50     │ $60     │ $70     │ $80     │ $100    │ $120   `);
  console.log(`  ─────┼─────────┼─────────┼─────────┼─────────┼─────────┼─────────┼─────────┼────────`);
  for (const r of results) {
    const vals = TEST_PREMIUMS.map(p => {
      const v = r.pnlByPremium[p];
      const s = v >= 0 ? `+${v.toFixed(0)}` : v.toFixed(0);
      return s.padStart(7);
    });
    console.log(`  ${String(r.sl).padStart(3)}%  │ $${vals.join(' │ $')} `);
  }

  console.log(`\n  Win rate at various premiums:`);
  console.log(`  SL%  │ $30     │ $40     │ $50     │ $60     │ $70     │ $80     │ $100    │ $120   `);
  console.log(`  ─────┼─────────┼─────────┼─────────┼─────────┼─────────┼─────────┼─────────┼────────`);
  for (const r of results) {
    const vals = TEST_PREMIUMS.map(p => `${(r.winRateByPremium[p] * 100).toFixed(0)}%`.padStart(7));
    console.log(`  ${String(r.sl).padStart(3)}%  │ ${vals.join(' │ ')} `);
  }
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════════════════");
  console.log("  ATTICUS V5: MARKET-REALISTIC IV vs LIVE BULLISH PRICING");
  console.log("  " + new Date().toISOString());
  console.log("═══════════════════════════════════════════════════════════════════════════\n");

  const prices = await fetchPrices("2022-01-01", "2026-04-07");
  console.log(`  ${prices.length} days loaded\n`);

  // ═══════════════════════════════════════════════════════════════════
  // RUN A: Previous (inflated BS, vol × 1.15)
  // ═══════════════════════════════════════════════════════════════════
  console.log("═══════════════════════════════════════════════════════════════════════════");
  console.log("  RUN A: INFLATED BS (vol × 1.15) — Previous backtest methodology");
  console.log("═══════════════════════════════════════════════════════════════════════════");
  const runA = runHistorical(prices, 1.15, "Inflated BS");
  printResults(runA, "Inflated BS");

  // ═══════════════════════════════════════════════════════════════════
  // RUN B: Market-realistic IV (vol × 0.85 — IV typically < realized)
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n═══════════════════════════════════════════════════════════════════════════");
  console.log("  RUN B: MARKET-REALISTIC IV (vol × 0.85) — IV discount to realized vol");
  console.log("═══════════════════════════════════════════════════════════════════════════");
  const runB = runHistorical(prices, 0.85, "Market IV");
  printResults(runB, "Market IV");

  // ═══════════════════════════════════════════════════════════════════
  // RUN C: Conservative market (vol × 1.0 — realized vol directly)
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n═══════════════════════════════════════════════════════════════════════════");
  console.log("  RUN C: NEUTRAL (vol × 1.0) — Realized vol as-is, no adjustment");
  console.log("═══════════════════════════════════════════════════════════════════════════");
  const runC = runHistorical(prices, 1.0, "Neutral");
  printResults(runC, "Neutral");

  // ═══════════════════════════════════════════════════════════════════
  // RUN D: LIVE BULLISH SIMNEXT ORDERBOOK
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n═══════════════════════════════════════════════════════════════════════════");
  console.log("  RUN D: LIVE BULLISH SIMNEXT — Actual orderbook prices right now");
  console.log("═══════════════════════════════════════════════════════════════════════════\n");

  try {
    const config = {
      enabled: true,
      restBaseUrl: process.env.PILOT_BULLISH_REST_BASE_URL || "https://api.simnext.bullish-test.com",
      publicWsUrl: "", privateWsUrl: "",
      authMode: "ecdsa" as const,
      hmacPublicKey: "", hmacSecret: "",
      ecdsaPublicKey: process.env.PILOT_BULLISH_ECDSA_PUBLIC_KEY || "",
      ecdsaPrivateKey: process.env.PILOT_BULLISH_ECDSA_PRIVATE_KEY || "",
      ecdsaMetadata: process.env.PILOT_BULLISH_ECDSA_METADATA || "",
      tradingAccountId: process.env.PILOT_BULLISH_TRADING_ACCOUNT_ID || "",
      defaultSymbol: "BTCUSDC",
      symbolByMarketId: { "BTC-USD": "BTCUSDC" } as Record<string, string>,
      hmacLoginPath: "/trading-api/v1/users/hmac/login",
      ecdsaLoginPath: "/trading-api/v2/users/login",
      tradingAccountsPath: "/trading-api/v1/accounts/trading-accounts",
      noncePath: "/nonce",
      commandPath: "/trading-api/v2/command",
      orderbookPathTemplate: "/trading-api/v1/markets/:symbol/orderbook/hybrid",
      enableExecution: false, orderTimeoutMs: 15000,
      orderTif: "IOC" as const, allowMargin: false,
    };

    const client = new BullishTradingClient(config);
    const spotBook = await client.getHybridOrderBook("BTCUSDC");
    const spotMid = (Number(spotBook.bids[0]?.price || 0) + Number(spotBook.asks[0]?.price || 0)) / 2;
    console.log(`  BTC spot mid: $${spotMid.toFixed(2)}\n`);

    const markets = await client.getMarkets();
    const puts = markets.filter(m => m.marketType === "OPTION" && m.symbol?.includes("-P") && m.createOrderEnabled);
    const now = Date.now();
    const activePuts = puts.filter(m => {
      const e = Date.parse(m.expiryDatetime || "");
      return Number.isFinite(e) && e > now;
    });

    console.log(`  ${activePuts.length} active put options on Bullish SimNext\n`);

    console.log(`  ┌──────┬────────────────────────────────────┬──────────┬──────────┬────────────┬──────────────┐`);
    console.log(`  │ SL%  │ Best Option                        │ Ask/BTC  │ OTM%     │ Hedge/10k  │ At $80 prem  │`);
    console.log(`  ├──────┼────────────────────────────────────┼──────────┼──────────┼────────────┼──────────────┤`);

    for (const sl of SL_TIERS) {
      const triggerPx = spotMid * (1 - sl / 100);
      const qty = NOTIONAL / spotMid;

      const candidates = activePuts.map(m => {
        const sym = m.symbol || "";
        const strike = Number(sym.split("-")[3] || 0);
        const expMs = Date.parse(m.expiryDatetime || "");
        const days = (expMs - now) / 86400000;
        return { symbol: sym, strike, days, expiry: m.expiryDatetime?.slice(0, 10) || "" };
      }).filter(c => {
        if (c.strike <= 0 || c.days <= 0) return false;
        const moneyness = c.strike / spotMid;
        const targetMoneyness = 1 - sl / 100;
        return Math.abs(moneyness - targetMoneyness) < 0.03 && c.days >= 3 && c.days <= 14;
      }).sort((a, b) => Math.abs(a.strike / spotMid - (1 - sl / 100)) - Math.abs(b.strike / spotMid - (1 - sl / 100)));

      let found = false;
      for (const cand of candidates.slice(0, 5)) {
        try {
          const book = await client.getHybridOrderBook(cand.symbol);
          const ask = book.asks[0];
          if (!ask || Number(ask.price) <= 0) continue;
          const askPx = Number(ask.price);
          const hedgeCost = askPx * qty;
          const otmPct = ((spotMid - cand.strike) / spotMid * 100).toFixed(1);
          const payout = NOTIONAL * (sl / 100);
          const pnlAt80 = 80 - hedgeCost - (payout * 0.55);
          const pnlLabel = pnlAt80 >= 0 ? `+$${pnlAt80.toFixed(0)}` : `-$${Math.abs(pnlAt80).toFixed(0)}`;

          console.log(`  │ ${String(sl).padStart(3)}% │ ${cand.symbol.padEnd(34)} │ $${askPx.toFixed(0).padStart(6)} │ ${otmPct.padStart(6)}%  │ $${hedgeCost.toFixed(0).padStart(8)} │ ${pnlLabel.padStart(12)} │`);
          found = true;
          break;
        } catch { continue; }
      }
      if (!found) {
        console.log(`  │ ${String(sl).padStart(3)}% │ ${"(no suitable option found)".padEnd(34)} │ ${"-".padStart(8)} │ ${"-".padStart(8)} │ ${"-".padStart(10)} │ ${"-".padStart(12)} │`);
      }
    }
    console.log(`  └──────┴────────────────────────────────────┴──────────┴──────────┴────────────┴──────────────┘`);

    console.log(`\n  Note: "At $80 prem" = $80 - hedge_cost - (payout × 55% trigger rate estimate)`);
    console.log(`  Positive = platform profit per trade, negative = loss`);

  } catch (e: any) {
    console.log(`  Bullish SimNext scan failed: ${e.message}`);
    console.log(`  (Set PILOT_BULLISH_ECDSA_* env vars to enable live scan)`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // COMPARISON TABLE
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n\n═══════════════════════════════════════════════════════════════════════════");
  console.log("  COMPARISON: Break-Even by Methodology");
  console.log("═══════════════════════════════════════════════════════════════════════════\n");

  console.log("  SL%  │ Inflated BS  │ Neutral (1x) │ Market IV    │ CEO $80 Target");
  console.log("  ─────┼──────────────┼──────────────┼──────────────┼───────────────");
  for (const sl of SL_TIERS) {
    const a = runA.find(r => r.sl === sl)!;
    const b = runB.find(r => r.sl === sl)!;
    const c = runC.find(r => r.sl === sl)!;
    const feasible = b.breakEven <= 80 ? "FEASIBLE" : b.breakEven <= 100 ? "TIGHT" : "TOO HIGH";
    console.log(`  ${String(sl).padStart(3)}%  │ $${a.breakEven.toFixed(0).padStart(5)}/10k   │ $${c.breakEven.toFixed(0).padStart(5)}/10k   │ $${b.breakEven.toFixed(0).padStart(5)}/10k   │ ${feasible}`);
  }

  console.log("\n  Inflated BS = vol × 1.15 (previous backtest, overstates cost)");
  console.log("  Neutral     = vol × 1.0  (realized vol as-is)");
  console.log("  Market IV   = vol × 0.85 (IV typically trades below realized for OTM puts)");

  // At what premium does each tier break even under market IV?
  console.log("\n\n═══════════════════════════════════════════════════════════════════════════");
  console.log("  FINAL ANSWER: What Premium Works Under Market-Realistic IV?");
  console.log("═══════════════════════════════════════════════════════════════════════════\n");

  for (const sl of SL_TIERS) {
    const r = runB.find(x => x.sl === sl)!;
    const beUp = Math.ceil(r.breakEven / 5) * 5;
    const withMargin = Math.ceil(r.breakEven * 1.2 / 5) * 5;
    const aggressive = Math.ceil(r.breakEven * 0.9 / 5) * 5;
    const payout = NOTIONAL * (sl / 100);
    const traderValue = payout - withMargin;

    console.log(`  ${sl}% SL:`);
    console.log(`    Break-even:       $${beUp}/10k`);
    console.log(`    +20% margin:      $${withMargin}/10k ($${(withMargin / 10).toFixed(1)}/1k)`);
    console.log(`    Adoption price:   $${aggressive}/10k ($${(aggressive / 10).toFixed(1)}/1k)`);
    console.log(`    Payout on breach: $${payout}`);
    console.log(`    Trader saves:     $${traderValue} per breach at +20% price`);
    console.log(`    Win rate at +20%: ${(r.winRateByPremium[withMargin] * 100 || 0).toFixed(0)}%`);
    console.log();
  }
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
