/**
 * Multi-tier, multi-notional TP backtest.
 * Runs the current TP logic across 2%, 3%, 5%, 10% SL tiers
 * at $10k and $50k notional for comprehensive P&L analysis.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";

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

type TierConfig = {
  slPct: number;
  premiumPer1k: number;
};

const TIERS: TierConfig[] = [
  { slPct: 0.02, premiumPer1k: 5 },
  { slPct: 0.03, premiumPer1k: 4 },
  { slPct: 0.05, premiumPer1k: 3 },
  { slPct: 0.10, premiumPer1k: 2 },
];

const NOTIONALS = [10000, 50000];
const TENOR_DAYS = 2;
const HOUR_MS = 3600000;
const DAY_MS = 86400000;
const DVOL = 45;
const SIGMA = DVOL / 100;

const adaptive = { coolingHours: 0.5, deepDropCoolingHours: 0.167, primeThreshold: 0.25, lateThreshold: 0.10, primeWindowEndHours: 8 };

const runTier = (prices: PricePoint[], tier: TierConfig, notional: number) => {
  const premium = notional / 1000 * tier.premiumPer1k;
  const payout = notional * tier.slPct;
  let totalPremium = 0, totalHedge = 0, totalPayouts = 0, totalTp = 0, totalHoldValue = 0;
  let cycles = 0, triggers = 0, tpSold = 0;
  const reasons: Record<string, number> = {};

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

    let triggered = false, triggerTs = 0;
    let tpProceeds = 0, tpDone = false;
    let peakVal = 0;

    for (let i = cycleStart + 1; i < prices.length; i++) {
      const p = prices[i];
      if (p.tsMs > expiryTs) break;

      const T = Math.max(0, expiryTs - p.tsMs) / (365.25 * 24 * 3600 * 1000);
      const intrinsic = Math.max(0, strike - p.price);
      const total = Math.max(intrinsic, bsPut(p.price, strike, T, SIGMA)) * qty;
      if (total > peakVal) peakVal = total;

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
        if (hToExp < 10 && total >= 3) { sell = true; reason = "near_expiry_salvage"; }
        else if (dropFloor >= 1.5 && hSince >= adaptive.deepDropCoolingHours && total >= payout * adaptive.primeThreshold) { sell = true; reason = "deep_drop_tp"; }
        else if (hSince < effCool) { /* cooling */ }
        else if (bounced && total >= 3) { sell = true; reason = "bounce_recovery"; }
        else if (hSince < adaptive.primeWindowEndHours && total >= payout * adaptive.primeThreshold) { sell = true; reason = "take_profit_prime"; }
        else if (hSince >= adaptive.primeWindowEndHours && total >= payout * adaptive.lateThreshold) { sell = true; reason = "take_profit_late"; }

        if (sell) { tpProceeds = total; tpDone = true; tpSold++; reasons[reason] = (reasons[reason] || 0) + 1; }
      }
    }

    totalTp += tpProceeds;
    const expiryIdx = prices.findIndex(p => p.tsMs >= expiryTs);
    if (expiryIdx >= 0 && triggered) {
      totalHoldValue += Math.max(0, strike - prices[expiryIdx].price) * qty;
    }

    cycleStart += 48;
  }

  const netPnl = totalPremium - totalHedge - totalPayouts + totalTp;
  const netHold = totalPremium - totalHedge - totalPayouts + totalHoldValue;

  return {
    slPct: `${tier.slPct * 100}%`, notional, cycles, triggers,
    triggerRate: cycles > 0 ? (triggers / cycles * 100).toFixed(1) : "0",
    tpSold, tpRate: triggers > 0 ? (tpSold / triggers * 100).toFixed(1) : "0",
    totalPremium, totalHedge, spread: totalPremium - totalHedge,
    totalPayouts, totalTp, totalHoldValue,
    netPnl, netHold,
    tpVsHold: totalTp - totalHoldValue,
    avgTpPerTrigger: tpSold > 0 ? totalTp / tpSold : 0,
    avgTpPctOfPayout: tpSold > 0 ? (totalTp / tpSold / payout * 100) : 0,
    reasons,
    marginPerCycle: cycles > 0 ? netPnl / cycles : 0,
    annualizedPnl: cycles > 0 ? netPnl / cycles * 182.5 : 0
  };
};

const main = async () => {
  const csvPath = process.argv[2] || "artifacts/backtest/tp_v2/btc_usd_12m_1h.csv";
  const raw = await readFile(csvPath, "utf8");
  const prices: PricePoint[] = raw.trim().split("\n").slice(1).map(l => {
    const [ts, p] = l.split(",");
    return { tsMs: new Date(ts).getTime(), price: Number(p) };
  }).filter(p => p.price > 0);

  const startPrice = prices[0].price;
  const endPrice = prices[prices.length - 1].price;
  const btcReturn = ((endPrice - startPrice) / startPrice * 100).toFixed(1);

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  TP V2 MULTI-TIER BACKTEST — 12 Month (DVOL 45 / Normal)");
  console.log("══════════════════════════════════════════════════════════════\n");
  console.log(`Data: ${prices.length} hourly points (${new Date(prices[0].tsMs).toISOString().slice(0,10)} to ${new Date(prices[prices.length-1].tsMs).toISOString().slice(0,10)})`);
  console.log(`BTC: $${startPrice.toFixed(0)} → $${endPrice.toFixed(0)} (${btcReturn}%)\n`);

  const allResults: any[] = [];

  for (const notional of NOTIONALS) {
    console.log(`\n┌── $${(notional/1000).toFixed(0)}k Notional ────────────────────────────────────┐`);
    console.log(`│ SL%  │ Cycles │ Triggers │ Rate  │ TP Sold │ Premium  │ Hedge    │ Spread   │ Payouts  │ TP $     │ Net P&L   │ $/cycle │ Annual    │`);
    console.log(`├──────┼────────┼──────────┼───────┼─────────┼──────────┼──────────┼──────────┼──────────┼──────────┼───────────┼─────────┼───────────┤`);

    let blendedPremium = 0, blendedHedge = 0, blendedPayouts = 0, blendedTp = 0, blendedCycles = 0;

    for (const tier of TIERS) {
      const r = runTier(prices, tier, notional);
      allResults.push(r);
      blendedPremium += r.totalPremium;
      blendedHedge += r.totalHedge;
      blendedPayouts += r.totalPayouts;
      blendedTp += r.totalTp;
      blendedCycles += r.cycles;

      const pad = (s: string, n: number) => s.padStart(n);
      console.log(`│ ${pad(r.slPct, 4)} │ ${pad(String(r.cycles), 6)} │ ${pad(String(r.triggers), 8)} │ ${pad(r.triggerRate + "%", 5)} │ ${pad(String(r.tpSold), 7)} │ ${pad("$" + r.totalPremium.toFixed(0), 8)} │ ${pad("$" + r.totalHedge.toFixed(0), 8)} │ ${pad("$" + r.spread.toFixed(0), 8)} │ ${pad("$" + r.totalPayouts.toFixed(0), 8)} │ ${pad("$" + r.totalTp.toFixed(0), 8)} │ ${pad("$" + r.netPnl.toFixed(0), 9)} │ ${pad("$" + r.marginPerCycle.toFixed(2), 7)} │ ${pad("$" + r.annualizedPnl.toFixed(0), 9)} │`);
    }

    const blendedNet = blendedPremium - blendedHedge - blendedPayouts + blendedTp;
    const blendedAnnual = blendedCycles > 0 ? blendedNet / blendedCycles * 182.5 * 4 : 0;
    console.log(`├──────┼────────┼──────────┼───────┼─────────┼──────────┼──────────┼──────────┼──────────┼──────────┼───────────┼─────────┼───────────┤`);
    console.log(`│ BLND │ ${String(blendedCycles).padStart(6)} │          │       │         │ $${blendedPremium.toFixed(0).padStart(7)} │ $${blendedHedge.toFixed(0).padStart(7)} │ $${(blendedPremium - blendedHedge).toFixed(0).padStart(7)} │ $${blendedPayouts.toFixed(0).padStart(7)} │ $${blendedTp.toFixed(0).padStart(7)} │ $${blendedNet.toFixed(0).padStart(8)} │         │ $${blendedAnnual.toFixed(0).padStart(8)} │`);
    console.log(`└──────┴────────┴──────────┴───────┴─────────┴──────────┴──────────┴──────────┴──────────┴──────────┴───────────┴─────────┴───────────┘`);
  }

  console.log("\n\n── TP Reason Breakdown (all tiers, $10k) ──");
  for (const tier of TIERS) {
    const r = allResults.find(x => x.slPct === `${tier.slPct * 100}%` && x.notional === 10000);
    if (r) console.log(`  ${r.slPct}: ${JSON.stringify(r.reasons)}`);
  }

  console.log("\n── TP vs Hold-to-Expiry ($10k) ──");
  for (const tier of TIERS) {
    const r = allResults.find(x => x.slPct === `${tier.slPct * 100}%` && x.notional === 10000);
    if (r) console.log(`  ${r.slPct}: TP=$${r.totalTp.toFixed(0)}  Hold=$${r.totalHoldValue.toFixed(0)}  Diff=$${r.tpVsHold.toFixed(0)} (${r.tpVsHold >= 0 ? "TP better" : "hold better"})`);
  }

  console.log("\n── Avg TP Recovery per Trigger ($10k) ──");
  for (const tier of TIERS) {
    const r = allResults.find(x => x.slPct === `${tier.slPct * 100}%` && x.notional === 10000);
    if (r) console.log(`  ${r.slPct}: $${r.avgTpPerTrigger.toFixed(2)} (${r.avgTpPctOfPayout.toFixed(1)}% of payout)`);
  }
};

main().catch(err => { console.error(err); process.exitCode = 1; });
