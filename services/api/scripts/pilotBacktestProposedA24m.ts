/**
 * Proposed A ($7/5/3.5/2.5) — 24-month backtest with quarterly breakdown.
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

const PROPOSED_A: TierDef[] = [
  { slPct: 0.02, premiumPer1k: 7, label: "2%" },
  { slPct: 0.03, premiumPer1k: 5, label: "3%" },
  { slPct: 0.05, premiumPer1k: 3.5, label: "5%" },
  { slPct: 0.10, premiumPer1k: 2.5, label: "10%" },
];

type CycleResult = {
  entryTs: number;
  entryPrice: number;
  triggered: boolean;
  premium: number;
  hedgeCost: number;
  payout: number;
  tpProceeds: number;
  netPnl: number;
};

const runTier = (prices: PricePoint[], tier: TierDef, notional: number): CycleResult[] => {
  const premium = notional / 1000 * tier.premiumPer1k;
  const payout = notional * tier.slPct;
  const results: CycleResult[] = [];

  let cycleStart = 0;
  while (cycleStart < prices.length - 1) {
    const entry = prices[cycleStart];
    const floorPrice = entry.price * (1 - tier.slPct);
    const strikeRaw = Math.round(floorPrice / 500) * 500;
    const strike = strikeRaw <= floorPrice ? strikeRaw : strikeRaw - 500;
    const expiryTs = entry.tsMs + TENOR_DAYS * DAY_MS;
    const qty = notional / entry.price;
    const hedgeCost = bsPut(entry.price, strike, TENOR_DAYS / 365.25, SIGMA) * qty;

    let triggered = false, triggerTs = 0, tpProceeds = 0, tpDone = false;

    for (let i = cycleStart + 1; i < prices.length; i++) {
      const p = prices[i];
      if (p.tsMs > expiryTs) break;

      const T = Math.max(0, expiryTs - p.tsMs) / (365.25 * 24 * 3600 * 1000);
      const intrinsic = Math.max(0, strike - p.price);
      const total = Math.max(intrinsic, bsPut(p.price, strike, T, SIGMA)) * qty;

      if (!triggered && p.price <= floorPrice) {
        triggered = true; triggerTs = p.tsMs;
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

        if (sell) { tpProceeds = total; tpDone = true; }
      }
    }

    const payoutActual = triggered ? payout : 0;
    results.push({
      entryTs: entry.tsMs, entryPrice: entry.price,
      triggered, premium, hedgeCost, payout: payoutActual, tpProceeds,
      netPnl: premium - hedgeCost - payoutActual + tpProceeds
    });

    cycleStart += 48;
  }
  return results;
};

const getQuarter = (tsMs: number): string => {
  const d = new Date(tsMs);
  const y = d.getUTCFullYear();
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${y}-Q${q}`;
};

const aggregateCycles = (cycles: CycleResult[]) => {
  const n = cycles.length;
  const triggers = cycles.filter(c => c.triggered).length;
  const totalPremium = cycles.reduce((s, c) => s + c.premium, 0);
  const totalHedge = cycles.reduce((s, c) => s + c.hedgeCost, 0);
  const totalPayouts = cycles.reduce((s, c) => s + c.payout, 0);
  const totalTp = cycles.reduce((s, c) => s + c.tpProceeds, 0);
  const netPnl = totalPremium - totalHedge - totalPayouts + totalTp;
  return { n, triggers, triggerRate: n > 0 ? triggers / n * 100 : 0, totalPremium, totalHedge, spread: totalPremium - totalHedge, totalPayouts, totalTp, netPnl, perCycle: n > 0 ? netPnl / n : 0 };
};

const main = async () => {
  const csvPath = process.argv[2] || "artifacts/backtest/tp_v2/btc_usd_24m_1h.csv";
  const raw = await readFile(csvPath, "utf8");
  const prices: PricePoint[] = raw.trim().split("\n").slice(1).map(l => {
    const [ts, p] = l.split(",");
    return { tsMs: new Date(ts).getTime(), price: Number(p) };
  }).filter(p => p.price > 0);

  const startPrice = prices[0].price;
  const endPrice = prices[prices.length - 1].price;

  console.log("\n════════════════════════════════════════════════════════════════════");
  console.log("  PROPOSED A ($7/5/3.5/2.5) — 24-MONTH BACKTEST");
  console.log("════════════════════════════════════════════════════════════════════\n");
  console.log(`Data: ${prices.length} hourly points (${new Date(prices[0].tsMs).toISOString().slice(0,10)} to ${new Date(prices[prices.length-1].tsMs).toISOString().slice(0,10)})`);
  console.log(`BTC: $${startPrice.toFixed(0)} → $${endPrice.toFixed(0)} (${((endPrice - startPrice) / startPrice * 100).toFixed(1)}%)\n`);

  // Overall by tier
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  OVERALL — 24 MONTHS ($10k notional)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  console.log("  SL%  │ Cycles │ Triggers │ Rate  │ Premium  │ Hedge    │ Spread   │ Payouts  │ TP $     │ Net P&L   │ $/cycle │ Annual");
  console.log("  ─────┼────────┼──────────┼───────┼──────────┼──────────┼──────────┼──────────┼──────────┼───────────┼─────────┼────────");

  let bPrem = 0, bHedge = 0, bPay = 0, bTp = 0, bCycles = 0;
  const allByTier: Record<string, CycleResult[]> = {};

  for (const tier of PROPOSED_A) {
    const cycles = runTier(prices, tier, 10000);
    allByTier[tier.label] = cycles;
    const a = aggregateCycles(cycles);
    bPrem += a.totalPremium; bHedge += a.totalHedge; bPay += a.totalPayouts; bTp += a.totalTp; bCycles += a.n;
    const annual = a.perCycle * 182.5;
    console.log(`  ${tier.label.padEnd(4)} │ ${String(a.n).padStart(6)} │ ${String(a.triggers).padStart(8)} │ ${(a.triggerRate.toFixed(1) + "%").padStart(5)} │ $${a.totalPremium.toFixed(0).padStart(7)} │ $${a.totalHedge.toFixed(0).padStart(7)} │ $${a.spread.toFixed(0).padStart(7)} │ $${a.totalPayouts.toFixed(0).padStart(7)} │ $${a.totalTp.toFixed(0).padStart(7)} │ $${a.netPnl.toFixed(0).padStart(8)} │ $${a.perCycle.toFixed(2).padStart(6)} │ $${annual.toFixed(0).padStart(5)}`);
  }
  const bNet = bPrem - bHedge - bPay + bTp;
  console.log("  ─────┼────────┼──────────┼───────┼──────────┼──────────┼──────────┼──────────┼──────────┼───────────┼─────────┼────────");
  console.log(`  BLND │ ${String(bCycles).padStart(6)} │          │       │ $${bPrem.toFixed(0).padStart(7)} │ $${bHedge.toFixed(0).padStart(7)} │ $${(bPrem - bHedge).toFixed(0).padStart(7)} │ $${bPay.toFixed(0).padStart(7)} │ $${bTp.toFixed(0).padStart(7)} │ $${bNet.toFixed(0).padStart(8)} │ $${(bNet / bCycles).toFixed(2).padStart(6)} │ $${(bNet / bCycles * 182.5 * 4).toFixed(0).padStart(5)}`);

  // Quarterly breakdown per tier
  console.log("\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  QUARTERLY BREAKDOWN ($10k notional)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  const quarters = new Set<string>();
  for (const tier of PROPOSED_A) {
    for (const c of allByTier[tier.label]) quarters.add(getQuarter(c.entryTs));
  }
  const sortedQuarters = Array.from(quarters).sort();

  // BTC price per quarter
  console.log("  Quarter  │ BTC Start │ BTC End  │ Return");
  console.log("  ─────────┼───────────┼──────────┼────────");
  for (const q of sortedQuarters) {
    const qCycles = allByTier["2%"].filter(c => getQuarter(c.entryTs) === q);
    if (!qCycles.length) continue;
    const first = qCycles[0].entryPrice;
    const last = qCycles[qCycles.length - 1].entryPrice;
    const ret = ((last - first) / first * 100).toFixed(1);
    console.log(`  ${q.padEnd(8)} │ $${first.toFixed(0).padStart(8)} │ $${last.toFixed(0).padStart(7)} │ ${ret.padStart(6)}%`);
  }

  // Per-tier per-quarter
  for (const tier of PROPOSED_A) {
    console.log(`\n  ── ${tier.label} SL ($${tier.premiumPer1k}/1k) ──`);
    console.log("  Quarter  │ Cycles │ Triggers │ Rate  │ Premium │ Hedge   │ Payouts │ TP $    │ Net P&L  │ $/cyc");
    console.log("  ─────────┼────────┼──────────┼───────┼─────────┼─────────┼─────────┼─────────┼──────────┼──────");
    for (const q of sortedQuarters) {
      const qCycles = allByTier[tier.label].filter(c => getQuarter(c.entryTs) === q);
      if (!qCycles.length) continue;
      const a = aggregateCycles(qCycles);
      console.log(`  ${q.padEnd(8)} │ ${String(a.n).padStart(6)} │ ${String(a.triggers).padStart(8)} │ ${(a.triggerRate.toFixed(0) + "%").padStart(5)} │ $${a.totalPremium.toFixed(0).padStart(6)} │ $${a.totalHedge.toFixed(0).padStart(6)} │ $${a.totalPayouts.toFixed(0).padStart(6)} │ $${a.totalTp.toFixed(0).padStart(6)} │ $${a.netPnl.toFixed(0).padStart(7)} │ $${a.perCycle.toFixed(1).padStart(4)}`);
    }
  }

  // Blended quarterly
  console.log(`\n  ── BLENDED (all tiers) ──`);
  console.log("  Quarter  │ Net P&L  │ $/cycle │ Profitable?");
  console.log("  ─────────┼──────────┼─────────┼────────────");
  for (const q of sortedQuarters) {
    let qNet = 0, qCyc = 0;
    for (const tier of PROPOSED_A) {
      const qCycles = allByTier[tier.label].filter(c => getQuarter(c.entryTs) === q);
      const a = aggregateCycles(qCycles);
      qNet += a.netPnl; qCyc += a.n;
    }
    console.log(`  ${q.padEnd(8)} │ $${qNet.toFixed(0).padStart(7)} │ $${(qCyc > 0 ? qNet / qCyc : 0).toFixed(2).padStart(6)} │ ${qNet >= 0 ? "✓ YES" : "✗ NO"}`);
  }

  // $50k summary
  console.log("\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  $50k NOTIONAL — OVERALL 24 MONTHS");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  console.log("  SL%  │ Net P&L    │ $/cycle  │ Annualized");
  console.log("  ─────┼────────────┼──────────┼───────────");
  let b5Net = 0, b5Cyc = 0;
  for (const tier of PROPOSED_A) {
    const cycles = runTier(prices, tier, 50000);
    const a = aggregateCycles(cycles);
    b5Net += a.netPnl; b5Cyc += a.n;
    console.log(`  ${tier.label.padEnd(4)} │ $${a.netPnl.toFixed(0).padStart(9)} │ $${a.perCycle.toFixed(2).padStart(7)} │ $${(a.perCycle * 182.5).toFixed(0).padStart(9)}`);
  }
  console.log("  ─────┼────────────┼──────────┼───────────");
  console.log(`  BLND │ $${b5Net.toFixed(0).padStart(9)} │ $${(b5Net / b5Cyc).toFixed(2).padStart(7)} │ $${(b5Net / b5Cyc * 182.5 * 4).toFixed(0).padStart(9)}`);
};

main().catch(err => { console.error(err); process.exitCode = 1; });
