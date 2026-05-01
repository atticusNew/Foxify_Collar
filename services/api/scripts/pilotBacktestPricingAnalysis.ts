/**
 * Pricing Analysis — Tests different premium/payout combinations
 * to find the optimal balance between margin and trader optics.
 */

import { readFile } from "node:fs/promises";

const bsPut = (S: number, K: number, T: number, sigma: number): number => {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return Math.max(0, K - S);
  const d1 = (Math.log(S / K) + (sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  const nCDF = (x: number) => {
    const a = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
    const p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x) / Math.SQRT2;
    const t = 1 / (1 + p * ax);
    const y = 1 - ((((a[4] * t + a[3]) * t + a[2]) * t + a[1]) * t + a[0]) * t * Math.exp(-ax * ax);
    return 0.5 * (1 + sign * y);
  };
  return K * nCDF(-d2) - S * nCDF(-d1);
};

type PricePoint = { tsMs: number; price: number };
const HOUR_MS = 3600000;
const DAY_MS = 86400000;
const TENOR_DAYS = 2;
const DVOL = 45;
const SIGMA = DVOL / 100;

const adaptive = { coolingHours: 0.5, deepDropCoolingHours: 0.167, primeThreshold: 0.25, lateThreshold: 0.10, primeWindowEndHours: 8 };

type TierDef = { slPct: number; premiumPer1k: number; label: string };

const runScenario = (prices: PricePoint[], tier: TierDef, notional: number) => {
  const premium = notional / 1000 * tier.premiumPer1k;
  const payout = notional * tier.slPct;
  let totalPremium = 0, totalHedge = 0, totalPayouts = 0, totalTp = 0;
  let cycles = 0, triggers = 0, tpSold = 0;

  let cycleStart = 0;
  while (cycleStart < prices.length - 1) {
    const entry = prices[cycleStart];
    const floorPrice = entry.price * (1 - tier.slPct);
    const strikeRaw = Math.round(floorPrice / 500) * 500;
    const strike = strikeRaw <= floorPrice ? strikeRaw : strikeRaw - 500;
    const expiryTs = entry.tsMs + TENOR_DAYS * DAY_MS;
    const qty = notional / entry.price;
    const hedgeCost = bsPut(entry.price, strike, TENOR_DAYS / 365.25, SIGMA) * qty;

    totalPremium += premium;
    totalHedge += hedgeCost;
    cycles++;

    let triggered = false, triggerTs = 0, tpDone = false;

    for (let i = cycleStart + 1; i < prices.length; i++) {
      const p = prices[i];
      if (p.tsMs > expiryTs) break;

      const T = Math.max(0, expiryTs - p.tsMs) / (365.25 * 24 * 3600 * 1000);
      const intrinsic = Math.max(0, strike - p.price);
      const total = Math.max(intrinsic, bsPut(p.price, strike, T, SIGMA)) * qty;

      if (!triggered && p.price <= floorPrice) {
        triggered = true; triggerTs = p.tsMs;
        triggers++; totalPayouts += payout;
      }

      if (triggered && !tpDone) {
        const hSince = (p.tsMs - triggerTs) / HOUR_MS;
        const hToExp = (expiryTs - p.tsMs) / HOUR_MS;
        const dropFloor = ((floorPrice - p.price) / floorPrice) * 100;
        const bounced = p.price > floorPrice;
        const gapPct = Math.abs(strike - floorPrice) / floorPrice * 100;
        const gapDead = gapPct >= 0.3 && !bounced && p.price > strike;
        const effCool = gapDead ? adaptive.coolingHours + 0.5 : adaptive.coolingHours;

        let sell = false;
        if (hToExp < 10 && total >= 3) sell = true;
        else if (dropFloor >= 1.5 && hSince >= adaptive.deepDropCoolingHours && total >= payout * adaptive.primeThreshold) sell = true;
        else if (hSince >= effCool && bounced && total >= 3) sell = true;
        else if (hSince >= effCool && hSince < adaptive.primeWindowEndHours && total >= payout * adaptive.primeThreshold) sell = true;
        else if (hSince >= adaptive.primeWindowEndHours && total >= payout * adaptive.lateThreshold) sell = true;

        if (sell) { totalTp += total; tpDone = true; tpSold++; }
      }
    }
    cycleStart += 48;
  }

  return {
    cycles, triggers, tpSold,
    triggerRate: cycles > 0 ? triggers / cycles * 100 : 0,
    totalPremium, totalHedge, totalPayouts, totalTp,
    spread: totalPremium - totalHedge,
    netPnl: totalPremium - totalHedge - totalPayouts + totalTp,
    marginPerCycle: cycles > 0 ? (totalPremium - totalHedge - totalPayouts + totalTp) / cycles : 0,
    avgTpPct: tpSold > 0 ? (totalTp / tpSold) / payout * 100 : 0
  };
};

const main = async () => {
  const csvPath = process.argv[2] || "artifacts/backtest/tp_v2/btc_usd_12m_1h.csv";
  const raw = await readFile(csvPath, "utf8");
  const prices: PricePoint[] = raw.trim().split("\n").slice(1).map(l => {
    const [ts, p] = l.split(",");
    return { tsMs: new Date(ts).getTime(), price: Number(p) };
  }).filter(p => p.price > 0);

  console.log("\n══════════════════════════════════════════════════════════");
  console.log("  PRICING ANALYSIS — Premium/Payout Optimization");
  console.log("══════════════════════════════════════════════════════════\n");
  console.log(`Data: 12 months, BTC $${prices[0].price.toFixed(0)} → $${prices[prices.length-1].price.toFixed(0)}\n`);

  // ── Current vs Proposed schedules ──
  const schedules: { name: string; tiers: TierDef[] }[] = [
    {
      name: "CURRENT ($5/4/3/2 per 1k)",
      tiers: [
        { slPct: 0.02, premiumPer1k: 5, label: "2%" },
        { slPct: 0.03, premiumPer1k: 4, label: "3%" },
        { slPct: 0.05, premiumPer1k: 3, label: "5%" },
        { slPct: 0.10, premiumPer1k: 2, label: "10%" },
      ]
    },
    {
      name: "PROPOSED A ($7/5/3.5/2.5 per 1k)",
      tiers: [
        { slPct: 0.02, premiumPer1k: 7, label: "2%" },
        { slPct: 0.03, premiumPer1k: 5, label: "3%" },
        { slPct: 0.05, premiumPer1k: 3.5, label: "5%" },
        { slPct: 0.10, premiumPer1k: 2.5, label: "10%" },
      ]
    },
    {
      name: "PROPOSED B ($8/6/4/2.5 per 1k)",
      tiers: [
        { slPct: 0.02, premiumPer1k: 8, label: "2%" },
        { slPct: 0.03, premiumPer1k: 6, label: "3%" },
        { slPct: 0.05, premiumPer1k: 4, label: "5%" },
        { slPct: 0.10, premiumPer1k: 2.5, label: "10%" },
      ]
    },
  ];

  const NOTIONAL_EXAMPLES = [10000, 25000, 50000];

  for (const schedule of schedules) {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`  ${schedule.name}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    // Trader optics table
    console.log("  ── TRADER VIEW (What the user sees) ──\n");
    console.log("  Position    │ SL%  │ Premium   │ Payout    │ Ratio     │ Protection Period");
    console.log("  ────────────┼──────┼───────────┼───────────┼───────────┼──────────────────");
    for (const notional of NOTIONAL_EXAMPLES) {
      for (const tier of schedule.tiers) {
        const premium = notional / 1000 * tier.premiumPer1k;
        const payout = notional * tier.slPct;
        const ratio = payout / premium;
        console.log(`  $${(notional / 1000).toFixed(0)}k${" ".repeat(8 - `${(notional / 1000).toFixed(0)}k`.length)}│ ${tier.label.padEnd(4)} │ $${premium.toFixed(0).padStart(7)}  │ $${payout.toFixed(0).padStart(7)}  │ ${ratio.toFixed(1)}x${" ".repeat(7 - `${ratio.toFixed(1)}x`.length)} │ 2 days`);
      }
      if (notional !== NOTIONAL_EXAMPLES[NOTIONAL_EXAMPLES.length - 1]) console.log("  ────────────┼──────┼───────────┼───────────┼───────────┼──────────────────");
    }

    // Backtest financials at $10k
    console.log("\n  ── PLATFORM FINANCIALS (12-month backtest, $10k notional per cycle) ──\n");
    console.log("  SL%  │ Cycles │ Triggers │ Rate  │ Premium  │ Hedge    │ Spread   │ Payouts  │ TP $     │ Net P&L   │ $/cycle");
    console.log("  ─────┼────────┼──────────┼───────┼──────────┼──────────┼──────────┼──────────┼──────────┼───────────┼────────");

    let bPrem = 0, bHedge = 0, bPay = 0, bTp = 0, bCycles = 0;
    for (const tier of schedule.tiers) {
      const r = runScenario(prices, tier, 10000);
      bPrem += r.totalPremium; bHedge += r.totalHedge; bPay += r.totalPayouts; bTp += r.totalTp; bCycles += r.cycles;
      console.log(`  ${tier.label.padEnd(4)} │ ${String(r.cycles).padStart(6)} │ ${String(r.triggers).padStart(8)} │ ${(r.triggerRate.toFixed(1) + "%").padStart(5)} │ $${r.totalPremium.toFixed(0).padStart(7)} │ $${r.totalHedge.toFixed(0).padStart(7)} │ $${r.spread.toFixed(0).padStart(7)} │ $${r.totalPayouts.toFixed(0).padStart(7)} │ $${r.totalTp.toFixed(0).padStart(7)} │ $${r.netPnl.toFixed(0).padStart(8)} │ $${r.marginPerCycle.toFixed(2).padStart(6)}`);
    }
    const bNet = bPrem - bHedge - bPay + bTp;
    console.log("  ─────┼────────┼──────────┼───────┼──────────┼──────────┼──────────┼──────────┼──────────┼───────────┼────────");
    console.log(`  BLND │ ${String(bCycles).padStart(6)} │          │       │ $${bPrem.toFixed(0).padStart(7)} │ $${bHedge.toFixed(0).padStart(7)} │ $${(bPrem - bHedge).toFixed(0).padStart(7)} │ $${bPay.toFixed(0).padStart(7)} │ $${bTp.toFixed(0).padStart(7)} │ $${bNet.toFixed(0).padStart(8)} │ $${(bNet / bCycles).toFixed(2).padStart(6)}`);

    // $50k financials
    console.log("\n  ── PLATFORM FINANCIALS (12-month backtest, $50k notional per cycle) ──\n");
    let b5Prem = 0, b5Hedge = 0, b5Pay = 0, b5Tp = 0, b5Cycles = 0;
    console.log("  SL%  │ Net P&L   │ $/cycle  │ Annualized");
    console.log("  ─────┼───────────┼──────────┼───────────");
    for (const tier of schedule.tiers) {
      const r = runScenario(prices, tier, 50000);
      b5Prem += r.totalPremium; b5Hedge += r.totalHedge; b5Pay += r.totalPayouts; b5Tp += r.totalTp; b5Cycles += r.cycles;
      console.log(`  ${tier.label.padEnd(4)} │ $${r.netPnl.toFixed(0).padStart(8)} │ $${r.marginPerCycle.toFixed(2).padStart(7)} │ $${(r.marginPerCycle * 182.5).toFixed(0).padStart(9)}`);
    }
    const b5Net = b5Prem - b5Hedge - b5Pay + b5Tp;
    console.log("  ─────┼───────────┼──────────┼───────────");
    console.log(`  BLND │ $${b5Net.toFixed(0).padStart(8)} │ $${(b5Net / b5Cycles).toFixed(2).padStart(7)} │ $${(b5Net / b5Cycles * 182.5 * 4).toFixed(0).padStart(9)}`);
  }

  // ── Direct comparison ──
  console.log("\n\n══════════════════════════════════════════════════════════");
  console.log("  SIDE-BY-SIDE COMPARISON (12mo, $10k, blended all tiers)");
  console.log("══════════════════════════════════════════════════════════\n");
  console.log("  Schedule      │ Total Premium │ Total Spread │ Total TP  │ Net P&L   │ $/cycle │ Status");
  console.log("  ──────────────┼───────────────┼──────────────┼───────────┼───────────┼─────────┼────────");

  for (const schedule of schedules) {
    let tP = 0, tH = 0, tPay = 0, tTp = 0, tC = 0;
    for (const tier of schedule.tiers) {
      const r = runScenario(prices, tier, 10000);
      tP += r.totalPremium; tH += r.totalHedge; tPay += r.totalPayouts; tTp += r.totalTp; tC += r.cycles;
    }
    const net = tP - tH - tPay + tTp;
    const status = net >= 0 ? "✓ PROFIT" : "✗ LOSS";
    const shortName = schedule.name.split("(")[0].trim();
    console.log(`  ${shortName.padEnd(14)} │ $${tP.toFixed(0).padStart(11)} │ $${(tP - tH).toFixed(0).padStart(10)} │ $${tTp.toFixed(0).padStart(8)} │ $${net.toFixed(0).padStart(8)} │ $${(net / tC).toFixed(2).padStart(6)} │ ${status}`);
  }
};

main().catch(err => { console.error(err); process.exitCode = 1; });
