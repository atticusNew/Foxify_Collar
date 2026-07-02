/**
 * Regime-gate backtest (offline). Feeds calibrated 15-min BTC paths through the REAL gate + leading-signal
 * code and compares Foxify's collar P&L WITH vs WITHOUT the gate. Monte-Carlo over many paths per regime.
 * The paths are calibrated to the observed pilot regimes (a ~2%/day rally, calm, chop), not the exact tape.
 *
 * Run: npx tsx scripts/creditCollarGateBacktest.ts
 */

import { evaluateRegimeGate, type RegimeGateConfig } from "../src/singleSide/twoSided/creditCollar/regimeGate";
import { computeLiveRegimeSignal, type PriceObs } from "../src/singleSide/twoSided/creditCollar/priceHistoryStore";

const STEPS_PER_DAY = 96; // 15-min cycles
const CYCLE_MS = 900_000;
const DAY_MS = 86_400_000;
const NOTIONAL = 50_000;
const CREDIT = 80; // per leg
const FEE = Number(process.env.BT_FEE ?? 80); // per leg (assumed); set BT_FEE=25 for a realistic perp cost
const PAIRS_PER_DAY = 1; // 1 matched pair (1 long + 1 short) per day = the 2/day pilot
const DAYS = 14;
const N_PATHS = 400;

// Collar strikes (representative, from the floor sweep). Elevated regime ⟹ deeper floor ⟹ wider cap.
const NORMAL = { capLong: 0.021, capShort: 0.029, floor: 0.06 };
const ELEVATED = { capLong: 0.025, capShort: 0.029, floor: 0.1 };

const gateCfg: RegimeGateConfig = {
  enabled: true, lookback: 40, minSamples: 10, elevatedVolPct: 1.5, haltVolPct: 3.0,
  elevatedOpenMultiplier: 0.5, elevatedFloorPct: 0.1, liveLookbackMs: 6 * 3_600_000, liveMinSamples: 4
};

// deterministic RNG
const mulberry32 = (seed: number) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const normal = (rng: () => number) => Math.sqrt(-2 * Math.log(rng() + 1e-12)) * Math.cos(2 * Math.PI * rng());

const genPath = (rng: () => number, dailyDrift: number, dailyVol: number, nSteps: number, p0 = 60_000): PriceObs[] => {
  const driftStep = dailyDrift / STEPS_PER_DAY;
  const volStep = dailyVol / Math.sqrt(STEPS_PER_DAY);
  const out: PriceObs[] = [];
  let p = p0;
  for (let i = 0; i < nSteps; i++) {
    out.push({ tsMs: i * CYCLE_MS, priceUsd: p });
    p = p * (1 + driftStep + volStep * normal(rng));
  }
  return out;
};

const collarLong = (move: number, k: { capLong: number; floor: number }) => NOTIONAL * (Math.max(0, -move - k.floor) - Math.max(0, move - k.capLong));
const collarShort = (move: number, k: { capShort: number; floor: number }) => NOTIONAL * (Math.max(0, move - k.floor) - Math.max(0, -move - k.capShort));

type Result = { opens: number; collar: number; credit: number; fees: number; net: number; halted: number; elevated: number };
const zero = (): Result => ({ opens: 0, collar: 0, credit: 0, fees: 0, net: 0, halted: 0, elevated: 0 });

const simulate = (path: PriceObs[], gated: boolean): Result => {
  const r = zero();
  const openStep = Math.round(STEPS_PER_DAY / PAIRS_PER_DAY);
  const settledMovesByStep: Array<{ settleStep: number; absMove: number }> = [];
  for (let s = 0; s < DAYS * STEPS_PER_DAY; s += openStep) {
    // regime decision using ONLY info up to step s
    let k = NORMAL;
    if (gated) {
      const nowMs = path[s].tsMs;
      const trailing = settledMovesByStep.filter((x) => x.settleStep <= s).slice(-gateCfg.lookback!).map((x) => x.absMove);
      const live = computeLiveRegimeSignal(path.slice(0, s + 1), nowMs, { lookbackMs: gateCfg.liveLookbackMs, minSamples: gateCfg.liveMinSamples });
      const d = evaluateRegimeGate(trailing, gateCfg, live?.gaugePct ?? null);
      if (d.regime === "halt") { r.halted += 1; continue; }
      if (d.regime === "elevated") { r.elevated += 1; k = ELEVATED; if (r.elevated % 2 === 0) continue; } // throttle ×0.5
    }
    // open a matched pair; settle 24h later
    const entry = path[s].priceUsd;
    const settle = path[s + STEPS_PER_DAY].priceUsd;
    const move = (settle - entry) / entry;
    const cLong = collarLong(move, k);
    const cShort = collarShort(move, k);
    r.opens += 2;
    r.collar += cLong + cShort;
    r.credit += 2 * CREDIT;
    r.fees += 2 * FEE;
    // perp nets ~0 for the matched pair
    settledMovesByStep.push({ settleStep: s + STEPS_PER_DAY, absMove: Math.abs(move) });
  }
  r.net = r.credit + r.collar - r.fees;
  return r;
};

const scenarios: Array<{ name: string; drift: number; vol: number }> = [
  { name: "rally (+2.5%/d, 2% vol)", drift: 0.025, vol: 0.02 },
  { name: "calm  (0 drift, 1% vol)", drift: 0.0, vol: 0.01 },
  { name: "chop  (0 drift, 3.5% vol)", drift: 0.0, vol: 0.035 },
  { name: "selloff(−2.5%/d, 2% vol)", drift: -0.025, vol: 0.02 }
];

const fmt = (x: number) => (x < 0 ? "−" : "") + "$" + Math.abs(Math.round(x)).toLocaleString("en-US");
console.log(`\nREGIME-GATE BACKTEST — ${N_PATHS} paths/scenario · ${DAYS}d · ${PAIRS_PER_DAY} pair/day (2/day pilot) · $${NOTIONAL} clip · $${CREDIT} credit · $${FEE} fee\n`);
console.log(["scenario", "baseline net", "gated net", "Δ (saved)", "base bleed", "gated bleed", "opens b/g", "halt/elev"].map((h) => h.padEnd(15)).join(""));

for (const sc of scenarios) {
  const agg = { bNet: 0, gNet: 0, bCollar: 0, gCollar: 0, bOpens: 0, gOpens: 0, halt: 0, elev: 0 };
  for (let p = 0; p < N_PATHS; p++) {
    const rng = mulberry32(p * 7919 + sc.name.length * 104729);
    const path = genPath(rng, sc.drift, sc.vol, (DAYS + 2) * STEPS_PER_DAY);
    const b = simulate(path, false);
    const g = simulate(path, true);
    agg.bNet += b.net; agg.gNet += g.net; agg.bCollar += b.collar; agg.gCollar += g.collar;
    agg.bOpens += b.opens; agg.gOpens += g.opens; agg.halt += g.halted; agg.elev += g.elevated;
  }
  const n = N_PATHS;
  const row = [
    sc.name,
    fmt(agg.bNet / n),
    fmt(agg.gNet / n),
    fmt((agg.gNet - agg.bNet) / n),
    fmt(agg.bCollar / n),
    fmt(agg.gCollar / n),
    `${(agg.bOpens / n).toFixed(0)}/${(agg.gOpens / n).toFixed(0)}`,
    `${(agg.halt / n).toFixed(1)}/${(agg.elev / n).toFixed(1)}`
  ];
  console.log(row.map((c) => c.padEnd(15)).join(""));
}
console.log("\nnet = credit + collar − fees (per Foxify, matched book; perps net ~0). 'saved' = gated − baseline.\n");
