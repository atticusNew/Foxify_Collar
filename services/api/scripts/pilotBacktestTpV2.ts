/**
 * TP V2 Backtest — Simulates the current hedge manager TP logic
 * against historical hourly BTC price data.
 *
 * Simulates: 2% SL long protections with 2-day tenor, opened every
 * 2 days (rolling). For each protection cycle, tracks trigger events,
 * TP decisions using the exact same logic as hedgeManager.ts, and
 * computes P&L.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";

const DVOL_LOW = 35;
const DVOL_HIGH = 60;

type PricePoint = { tsMs: number; price: number };
type VolRegime = "low" | "normal" | "high";

type TpParams = {
  coolingHours: number;
  deepDropCoolingHours: number;
  primeThreshold: number;
  lateThreshold: number;
  primeWindowEndHours: number;
};

type ProtectionCycle = {
  entryPrice: number;
  entryTs: number;
  floorPrice: number;
  strike: number;
  expiryTs: number;
  notional: number;
  premium: number;
  hedgeCost: number;
  triggered: boolean;
  triggerTs: number;
  triggerPrice: number;
  payout: number;
  tpProceeds: number;
  tpReason: string;
  tpTs: number;
  optionValueAtTp: number;
  optionValueAtExpiry: number;
  peakOptionValue: number;
  peakOptionValueTs: number;
  regime: VolRegime;
};

const resolveAdaptive = (dvol: number): TpParams => {
  if (dvol > DVOL_HIGH) return { coolingHours: 1.0, deepDropCoolingHours: 0.25, primeThreshold: 0.35, lateThreshold: 0.15, primeWindowEndHours: 10 };
  if (dvol < DVOL_LOW) return { coolingHours: 0.25, deepDropCoolingHours: 0.1, primeThreshold: 0.15, lateThreshold: 0.05, primeWindowEndHours: 6 };
  return { coolingHours: 0.5, deepDropCoolingHours: 0.167, primeThreshold: 0.25, lateThreshold: 0.10, primeWindowEndHours: 8 };
};

const resolveRegime = (dvol: number): VolRegime => {
  if (dvol > DVOL_HIGH) return "high";
  if (dvol < DVOL_LOW) return "low";
  return "normal";
};

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

const computePutValue = (spot: number, strike: number, expiryMs: number, nowMs: number, sigma: number, qty: number) => {
  const T = Math.max(0, expiryMs - nowMs) / (365.25 * 24 * 3600 * 1000);
  const intrinsic = Math.max(0, strike - spot);
  const total = bsPut(spot, strike, T, sigma);
  return {
    totalValue: Math.max(intrinsic, total) * qty,
    intrinsicValue: intrinsic * qty,
    timeValue: Math.max(0, total - intrinsic) * qty
  };
};

const estimateHedgeCost = (spot: number, strike: number, tenorDays: number, sigma: number, qty: number): number => {
  const T = tenorDays / 365.25;
  return bsPut(spot, strike, T, sigma) * qty;
};

const main = async () => {
  const csvPath = process.argv[2] || "artifacts/backtest/tp_v2/btc_usd_6m_1h.csv";
  const outPath = process.argv[3] || "artifacts/backtest/tp_v2/tp_backtest_results.json";

  const raw = await readFile(csvPath, "utf8");
  const lines = raw.trim().split("\n").slice(1);
  const prices: PricePoint[] = lines.map(line => {
    const [tsIso, priceStr] = line.split(",");
    return { tsMs: new Date(tsIso).getTime(), price: Number(priceStr) };
  }).filter(p => p.price > 0 && Number.isFinite(p.tsMs));

  const HOUR_MS = 3600000;
  const DAY_MS = 86400000;
  const SL_PCT = 0.02;
  const TENOR_DAYS = 2;
  const NOTIONAL = 10000;
  const PREMIUM_PER_1K = 5;
  const PREMIUM = NOTIONAL / 1000 * PREMIUM_PER_1K;
  const PAYOUT = NOTIONAL * SL_PCT;
  const CYCLE_INTERVAL_HOURS = 48;
  const SIGMA = 0.50;
  const DVOL_SCENARIOS = [30, 45, 65];

  const results: Record<string, {
    dvol: number;
    regime: VolRegime;
    cycles: number;
    triggered: number;
    triggerRate: number;
    tpSold: number;
    tpRate: number;
    totalPremium: number;
    totalHedgeCost: number;
    totalSpread: number;
    totalPayouts: number;
    totalTpProceeds: number;
    netPnl: number;
    avgTpRecovery: number;
    avgTpRecoveryPct: number;
    avgPeakMissed: number;
    avgPeakMissedPct: number;
    holdToExpiryTotalValue: number;
    tpVsHoldDiff: number;
    cycleDetails: ProtectionCycle[];
  }> = {};

  for (const dvol of DVOL_SCENARIOS) {
    const adaptive = resolveAdaptive(dvol);
    const regime = resolveRegime(dvol);
    const sigma = dvol / 100;
    const cycles: ProtectionCycle[] = [];

    let cycleStart = 0;
    while (cycleStart < prices.length - 1) {
      const entry = prices[cycleStart];
      const entryPrice = entry.price;
      const floorPrice = entryPrice * (1 - SL_PCT);
      const strikeRaw = Math.round(floorPrice / 500) * 500;
      const strike = strikeRaw <= floorPrice ? strikeRaw : strikeRaw - 500;
      const expiryTs = entry.tsMs + TENOR_DAYS * DAY_MS;
      const qty = NOTIONAL / entryPrice;
      const hedgeCost = estimateHedgeCost(entryPrice, strike, TENOR_DAYS, sigma, qty);

      const cycle: ProtectionCycle = {
        entryPrice, entryTs: entry.tsMs, floorPrice, strike, expiryTs,
        notional: NOTIONAL, premium: PREMIUM, hedgeCost,
        triggered: false, triggerTs: 0, triggerPrice: 0,
        payout: 0, tpProceeds: 0, tpReason: "", tpTs: 0,
        optionValueAtTp: 0, optionValueAtExpiry: 0,
        peakOptionValue: 0, peakOptionValueTs: 0,
        regime
      };

      let tpDone = false;
      for (let i = cycleStart + 1; i < prices.length; i++) {
        const p = prices[i];
        if (p.tsMs > expiryTs) break;

        const optVal = computePutValue(p.price, strike, expiryTs, p.tsMs, sigma, qty);

        if (optVal.totalValue > cycle.peakOptionValue) {
          cycle.peakOptionValue = optVal.totalValue;
          cycle.peakOptionValueTs = p.tsMs;
        }

        if (!cycle.triggered && p.price <= floorPrice) {
          cycle.triggered = true;
          cycle.triggerTs = p.tsMs;
          cycle.triggerPrice = p.price;
          cycle.payout = PAYOUT;
        }

        if (cycle.triggered && !tpDone) {
          const hoursSinceTrigger = (p.tsMs - cycle.triggerTs) / HOUR_MS;
          const hoursToExpiry = (expiryTs - p.tsMs) / HOUR_MS;
          const dropFromFloor = ((floorPrice - p.price) / floorPrice) * 100;
          const isDeepDrop = dropFromFloor >= 1.5;
          const bounced = p.price > floorPrice;
          const gapPct = Math.abs(strike - floorPrice) / floorPrice * 100;
          const gapInDeadZone = gapPct >= 0.3 && !bounced && p.price > strike;
          const effectiveCooling = gapInDeadZone ? adaptive.coolingHours + 0.5 : adaptive.coolingHours;

          let shouldSell = false;
          let reason = "";

          if (hoursToExpiry < 10 && optVal.totalValue >= 3) {
            shouldSell = true; reason = "near_expiry_salvage";
          } else if (isDeepDrop && hoursSinceTrigger >= adaptive.deepDropCoolingHours && optVal.totalValue >= PAYOUT * adaptive.primeThreshold) {
            shouldSell = true; reason = "deep_drop_tp";
          } else if (hoursSinceTrigger < effectiveCooling) {
            // cooling
          } else if (bounced && optVal.totalValue >= 3) {
            shouldSell = true; reason = "bounce_recovery";
          } else if (hoursSinceTrigger < adaptive.primeWindowEndHours) {
            if (optVal.totalValue >= PAYOUT * adaptive.primeThreshold) {
              shouldSell = true; reason = "take_profit_prime";
            }
          } else {
            if (optVal.totalValue >= PAYOUT * adaptive.lateThreshold) {
              shouldSell = true; reason = "take_profit_late";
            }
          }

          if (shouldSell) {
            cycle.tpProceeds = optVal.totalValue;
            cycle.tpReason = reason;
            cycle.tpTs = p.tsMs;
            cycle.optionValueAtTp = optVal.totalValue;
            tpDone = true;
          }
        }
      }

      // Compute option value at expiry
      const expiryIdx = prices.findIndex(p => p.tsMs >= expiryTs);
      if (expiryIdx >= 0) {
        const expirySpot = prices[expiryIdx].price;
        cycle.optionValueAtExpiry = Math.max(0, strike - expirySpot) * qty;
      }

      cycles.push(cycle);

      cycleStart += Math.max(1, Math.floor(CYCLE_INTERVAL_HOURS));
    }

    const triggered = cycles.filter(c => c.triggered);
    const tpSold = cycles.filter(c => c.tpProceeds > 0);
    const totalPremium = cycles.reduce((s, c) => s + c.premium, 0);
    const totalHedgeCost = cycles.reduce((s, c) => s + c.hedgeCost, 0);
    const totalPayouts = triggered.reduce((s, c) => s + c.payout, 0);
    const totalTpProceeds = tpSold.reduce((s, c) => s + c.tpProceeds, 0);
    const holdToExpiryTotal = triggered.reduce((s, c) => s + c.optionValueAtExpiry, 0);

    const avgTpRecovery = tpSold.length > 0 ? totalTpProceeds / tpSold.length : 0;
    const avgTpRecoveryPct = tpSold.length > 0 ? tpSold.reduce((s, c) => s + (c.payout > 0 ? c.tpProceeds / c.payout : 0), 0) / tpSold.length * 100 : 0;
    const avgPeakMissed = tpSold.length > 0 ? tpSold.reduce((s, c) => s + (c.peakOptionValue - c.tpProceeds), 0) / tpSold.length : 0;
    const avgPeakMissedPct = tpSold.length > 0 ? tpSold.reduce((s, c) => s + (c.peakOptionValue > 0 ? (c.peakOptionValue - c.tpProceeds) / c.peakOptionValue * 100 : 0), 0) / tpSold.length : 0;

    results[`dvol_${dvol}`] = {
      dvol, regime,
      cycles: cycles.length,
      triggered: triggered.length,
      triggerRate: cycles.length > 0 ? triggered.length / cycles.length * 100 : 0,
      tpSold: tpSold.length,
      tpRate: triggered.length > 0 ? tpSold.length / triggered.length * 100 : 0,
      totalPremium, totalHedgeCost,
      totalSpread: totalPremium - totalHedgeCost,
      totalPayouts, totalTpProceeds,
      netPnl: totalPremium - totalHedgeCost - totalPayouts + totalTpProceeds,
      avgTpRecovery, avgTpRecoveryPct,
      avgPeakMissed, avgPeakMissedPct,
      holdToExpiryTotalValue: holdToExpiryTotal,
      tpVsHoldDiff: totalTpProceeds - holdToExpiryTotal,
      cycleDetails: cycles
    };
  }

  // TP reason breakdown
  const reasonBreakdown: Record<string, Record<string, number>> = {};
  for (const [key, data] of Object.entries(results)) {
    const reasons: Record<string, number> = {};
    for (const c of data.cycleDetails.filter(c => c.tpProceeds > 0)) {
      reasons[c.tpReason] = (reasons[c.tpReason] || 0) + 1;
    }
    reasonBreakdown[key] = reasons;
  }

  const output = {
    dataRange: { from: prices[0].tsMs, to: prices[prices.length - 1].tsMs, points: prices.length },
    parameters: { slPct: SL_PCT, tenorDays: TENOR_DAYS, notional: NOTIONAL, premiumPer1k: PREMIUM_PER_1K },
    scenarios: Object.fromEntries(
      Object.entries(results).map(([key, data]) => [key, {
        dvol: data.dvol, regime: data.regime,
        cycles: data.cycles, triggered: data.triggered,
        triggerRate: `${data.triggerRate.toFixed(1)}%`,
        tpSold: data.tpSold, tpRate: `${data.tpRate.toFixed(1)}%`,
        totalPremium: `$${data.totalPremium.toFixed(2)}`,
        totalHedgeCost: `$${data.totalHedgeCost.toFixed(2)}`,
        totalSpread: `$${data.totalSpread.toFixed(2)}`,
        totalPayouts: `$${data.totalPayouts.toFixed(2)}`,
        totalTpProceeds: `$${data.totalTpProceeds.toFixed(2)}`,
        netPnl: `$${data.netPnl.toFixed(2)}`,
        avgTpRecovery: `$${data.avgTpRecovery.toFixed(2)}`,
        avgTpRecoveryPct: `${data.avgTpRecoveryPct.toFixed(1)}%`,
        avgPeakMissed: `$${data.avgPeakMissed.toFixed(2)}`,
        avgPeakMissedPct: `${data.avgPeakMissedPct.toFixed(1)}%`,
        holdToExpiryTotal: `$${data.holdToExpiryTotalValue.toFixed(2)}`,
        tpVsHold: `$${data.tpVsHoldDiff.toFixed(2)} (${data.tpVsHoldDiff >= 0 ? "TP better" : "hold better"})`,
        tpReasonBreakdown: reasonBreakdown[key]
      }])
    )
  };

  await mkdir("artifacts/backtest/tp_v2", { recursive: true });
  await writeFile(outPath, JSON.stringify(output, null, 2), "utf8");

  console.log("\n═══════════════════════════════════════════════════");
  console.log("  TP V2 BACKTEST RESULTS — 6 Month Historical");
  console.log("═══════════════════════════════════════════════════\n");
  console.log(`Data: ${prices.length} hourly points (${new Date(prices[0].tsMs).toISOString().slice(0,10)} to ${new Date(prices[prices.length-1].tsMs).toISOString().slice(0,10)})`);
  console.log(`Parameters: ${SL_PCT*100}% SL, ${TENOR_DAYS}d tenor, $${NOTIONAL} notional, $${PREMIUM_PER_1K}/1k premium\n`);

  for (const [key, data] of Object.entries(results)) {
    console.log(`── DVOL ${data.dvol} (${data.regime} regime) ──`);
    console.log(`  Cycles: ${data.cycles}  Triggered: ${data.triggered} (${data.triggerRate.toFixed(1)}%)  TP Sold: ${data.tpSold} (${data.tpRate.toFixed(1)}% of triggers)`);
    console.log(`  Premium: $${data.totalPremium.toFixed(0)}  Hedge: $${data.totalHedgeCost.toFixed(0)}  Spread: $${data.totalSpread.toFixed(0)}`);
    console.log(`  Payouts: $${data.totalPayouts.toFixed(0)}  TP Recovery: $${data.totalTpProceeds.toFixed(0)}  Hold-to-expiry: $${data.holdToExpiryTotalValue.toFixed(0)}`);
    console.log(`  NET P&L: $${data.netPnl.toFixed(2)}`);
    console.log(`  Avg TP: $${data.avgTpRecovery.toFixed(2)} (${data.avgTpRecoveryPct.toFixed(1)}% of payout)  Avg peak missed: $${data.avgPeakMissed.toFixed(2)} (${data.avgPeakMissedPct.toFixed(1)}%)`);
    console.log(`  TP vs Hold: $${data.tpVsHoldDiff.toFixed(2)} (${data.tpVsHoldDiff >= 0 ? "TP better" : "hold better"})`);
    console.log(`  Reasons: ${JSON.stringify(reasonBreakdown[key])}`);
    console.log();
  }
};

main().catch(err => { console.error(err); process.exitCode = 1; });
