/**
 * 1-Day Tenor Backtest — Tests daily cycling vs 2-day cycling
 * with appropriate pricing for each.
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
const DVOL = 45;
const SIGMA = DVOL / 100;

const adaptive = { coolingHours: 0.5, deepDropCoolingHours: 0.167, primeThreshold: 0.25, lateThreshold: 0.10, primeWindowEndHours: 8 };

type TierDef = { slPct: number; premiumPer1k: number; label: string };

const runScenario = (prices: PricePoint[], tier: TierDef, notional: number, tenorDays: number, cycleHours: number) => {
  const premium = notional / 1000 * tier.premiumPer1k;
  const payout = notional * tier.slPct;
  let totalPremium = 0, totalHedge = 0, totalPayouts = 0, totalTp = 0;
  let cycles = 0, triggers = 0, tpSold = 0;
  const reasons: Record<string, number> = {};

  // Adjust TP params for 1-day tenor
  const nearExpirySalvageHours = tenorDays === 1 ? 6 : 10;
  const activeSalvageHours = tenorDays === 1 ? 4 : 8;

  let cycleStart = 0;
  while (cycleStart < prices.length - 1) {
    const entry = prices[cycleStart];
    const floorPrice = entry.price * (1 - tier.slPct);
    const strikeRaw = Math.round(floorPrice / 500) * 500;
    const strike = strikeRaw <= floorPrice ? strikeRaw : strikeRaw - 500;
    const expiryTs = entry.tsMs + tenorDays * DAY_MS;
    const qty = notional / entry.price;
    const hedgeCost = bsPut(entry.price, strike, tenorDays / 365.25, SIGMA) * qty;

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

        let sell = false, reason = "";
        if (hToExp < nearExpirySalvageHours && total >= 3) { sell = true; reason = "near_expiry_salvage"; }
        else if (dropFloor >= 1.5 && hSince >= adaptive.deepDropCoolingHours && total >= payout * adaptive.primeThreshold) { sell = true; reason = "deep_drop_tp"; }
        else if (hSince >= effCool && bounced && total >= 3) { sell = true; reason = "bounce_recovery"; }
        else if (hSince >= effCool && hSince < adaptive.primeWindowEndHours && total >= payout * adaptive.primeThreshold) { sell = true; reason = "take_profit_prime"; }
        else if (hSince >= adaptive.primeWindowEndHours && total >= payout * adaptive.lateThreshold) { sell = true; reason = "take_profit_late"; }

        if (sell) { totalTp += total; tpDone = true; tpSold++; reasons[reason] = (reasons[reason] || 0) + 1; }
      }

      // Active salvage for non-triggered positions near expiry
      if (!triggered && !tpDone && (expiryTs - p.tsMs) / HOUR_MS < activeSalvageHours && total >= 5) {
        totalTp += total; tpDone = true; tpSold++;
        reasons["active_salvage"] = (reasons["active_salvage"] || 0) + 1;
      }
    }

    cycleStart += Math.max(1, Math.floor(cycleHours));
  }

  const netPnl = totalPremium - totalHedge - totalPayouts + totalTp;
  return {
    tenorDays, cycles, triggers, tpSold,
    triggerRate: cycles > 0 ? triggers / cycles * 100 : 0,
    tpRate: triggers > 0 ? tpSold / triggers * 100 : 0,
    totalPremium, totalHedge, spread: totalPremium - totalHedge,
    totalPayouts, totalTp, netPnl,
    perCycle: cycles > 0 ? netPnl / cycles : 0,
    annualized: cycles > 0 ? netPnl / (cycles / (365 / (cycleHours / 24))) : 0,
    avgTp: tpSold > 0 ? totalTp / tpSold : 0,
    avgTpPct: tpSold > 0 ? totalTp / tpSold / payout * 100 : 0,
    reasons
  };
};

const main = async () => {
  const csvPath = process.argv[2] || "artifacts/backtest/tp_v2/btc_usd_24m_1h.csv";
  const raw = await readFile(csvPath, "utf8");
  const prices: PricePoint[] = raw.trim().split("\n").slice(1).map(l => {
    const [ts, p] = l.split(",");
    return { tsMs: new Date(ts).getTime(), price: Number(p) };
  }).filter(p => p.price > 0);

  console.log("\n════════════════════════════════════════════════════════════════════════");
  console.log("  1-DAY vs 2-DAY TENOR COMPARISON — 24 MONTH BACKTEST");
  console.log("════════════════════════════════════════════════════════════════════════\n");
  console.log(`Data: ${prices.length} points, BTC $${prices[0].price.toFixed(0)} → $${prices[prices.length-1].price.toFixed(0)}\n`);

  const configs: { name: string; tenorDays: number; cycleHours: number; tiers: TierDef[] }[] = [
    {
      name: "2-DAY TENOR (Proposed A — current)",
      tenorDays: 2, cycleHours: 48,
      tiers: [
        { slPct: 0.02, premiumPer1k: 7, label: "2%" },
        { slPct: 0.03, premiumPer1k: 6, label: "3%" },
        { slPct: 0.05, premiumPer1k: 3.5, label: "5%" },
        { slPct: 0.10, premiumPer1k: 2.5, label: "10%" },
      ]
    },
    {
      name: "1-DAY TENOR ($4/3.50/2/1.50 per 1k)",
      tenorDays: 1, cycleHours: 24,
      tiers: [
        { slPct: 0.02, premiumPer1k: 4, label: "2%" },
        { slPct: 0.03, premiumPer1k: 3.5, label: "3%" },
        { slPct: 0.05, premiumPer1k: 2, label: "5%" },
        { slPct: 0.10, premiumPer1k: 1.5, label: "10%" },
      ]
    },
    {
      name: "1-DAY TENOR ($4.50/3.50/2.50/1.75 per 1k)",
      tenorDays: 1, cycleHours: 24,
      tiers: [
        { slPct: 0.02, premiumPer1k: 4.5, label: "2%" },
        { slPct: 0.03, premiumPer1k: 3.5, label: "3%" },
        { slPct: 0.05, premiumPer1k: 2.5, label: "5%" },
        { slPct: 0.10, premiumPer1k: 1.75, label: "10%" },
      ]
    },
    {
      name: "1-DAY TENOR ($5/4/3/2 per 1k — premium)",
      tenorDays: 1, cycleHours: 24,
      tiers: [
        { slPct: 0.02, premiumPer1k: 5, label: "2%" },
        { slPct: 0.03, premiumPer1k: 4, label: "3%" },
        { slPct: 0.05, premiumPer1k: 3, label: "5%" },
        { slPct: 0.10, premiumPer1k: 2, label: "10%" },
      ]
    },
  ];

  for (const config of configs) {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`  ${config.name}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    // Trader view
    console.log("  ── TRADER VIEW ($10k position) ──");
    console.log("  SL%  │ Premium │ Payout │ Ratio  │ Period");
    console.log("  ─────┼─────────┼────────┼────────┼────────");
    for (const tier of config.tiers) {
      const prem = 10000 / 1000 * tier.premiumPer1k;
      const pay = 10000 * tier.slPct;
      console.log(`  ${tier.label.padEnd(4)} │ $${prem.toFixed(0).padStart(5)}  │ $${pay.toFixed(0).padStart(4)}  │ ${(pay / prem).toFixed(1).padStart(5)}x │ ${config.tenorDays} day`);
    }

    // Financials
    console.log("\n  ── PLATFORM FINANCIALS (24mo, $10k) ──");
    console.log("  SL%  │ Cycles │ Triggers │ Rate  │ Premium  │ Hedge    │ Spread   │ Payouts  │ TP $     │ Net P&L   │ $/cyc  │ TP%");
    console.log("  ─────┼────────┼──────────┼───────┼──────────┼──────────┼──────────┼──────────┼──────────┼───────────┼────────┼─────");

    let bP = 0, bH = 0, bPay = 0, bTp = 0, bC = 0;
    for (const tier of config.tiers) {
      const r = runScenario(prices, tier, 10000, config.tenorDays, config.cycleHours);
      bP += r.totalPremium; bH += r.totalHedge; bPay += r.totalPayouts; bTp += r.totalTp; bC += r.cycles;
      console.log(`  ${tier.label.padEnd(4)} │ ${String(r.cycles).padStart(6)} │ ${String(r.triggers).padStart(8)} │ ${(r.triggerRate.toFixed(1) + "%").padStart(5)} │ $${r.totalPremium.toFixed(0).padStart(7)} │ $${r.totalHedge.toFixed(0).padStart(7)} │ $${r.spread.toFixed(0).padStart(7)} │ $${r.totalPayouts.toFixed(0).padStart(7)} │ $${r.totalTp.toFixed(0).padStart(7)} │ $${r.netPnl.toFixed(0).padStart(8)} │ $${r.perCycle.toFixed(1).padStart(5)} │ ${r.avgTpPct.toFixed(0).padStart(3)}%`);
    }
    const bNet = bP - bH - bPay + bTp;
    console.log("  ─────┼────────┼──────────┼───────┼──────────┼──────────┼──────────┼──────────┼──────────┼───────────┼────────┼─────");
    console.log(`  BLND │ ${String(bC).padStart(6)} │          │       │ $${bP.toFixed(0).padStart(7)} │ $${bH.toFixed(0).padStart(7)} │ $${(bP - bH).toFixed(0).padStart(7)} │ $${bPay.toFixed(0).padStart(7)} │ $${bTp.toFixed(0).padStart(7)} │ $${bNet.toFixed(0).padStart(8)} │ $${(bNet / bC).toFixed(1).padStart(5)} │`);

    // TP reason breakdown for 2% tier
    const r2 = runScenario(prices, config.tiers[0], 10000, config.tenorDays, config.cycleHours);
    console.log(`\n  2% TP reasons: ${JSON.stringify(r2.reasons)}`);
  }

  // Summary comparison
  console.log("\n\n════════════════════════════════════════════════════════════════════════");
  console.log("  SUMMARY COMPARISON (24mo, $10k, blended)");
  console.log("════════════════════════════════════════════════════════════════════════\n");
  console.log("  Config                              │ Cycles │ Premium  │ Spread   │ Payouts  │ TP $     │ Net P&L   │ Status");
  console.log("  ────────────────────────────────────┼────────┼──────────┼──────────┼──────────┼──────────┼───────────┼────────");

  for (const config of configs) {
    let tP = 0, tH = 0, tPay = 0, tTp = 0, tC = 0;
    for (const tier of config.tiers) {
      const r = runScenario(prices, tier, 10000, config.tenorDays, config.cycleHours);
      tP += r.totalPremium; tH += r.totalHedge; tPay += r.totalPayouts; tTp += r.totalTp; tC += r.cycles;
    }
    const net = tP - tH - tPay + tTp;
    const shortName = config.name.split("(")[0].trim().padEnd(36);
    console.log(`  ${shortName} │ ${String(tC).padStart(6)} │ $${tP.toFixed(0).padStart(7)} │ $${(tP - tH).toFixed(0).padStart(7)} │ $${tPay.toFixed(0).padStart(7)} │ $${tTp.toFixed(0).padStart(7)} │ $${net.toFixed(0).padStart(8)} │ ${net >= 0 ? "✓ PROFIT" : "✗ LOSS"}`);
  }
};

main().catch(err => { console.error(err); process.exitCode = 1; });
