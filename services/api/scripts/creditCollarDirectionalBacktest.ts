/**
 * Directional-edge backtest (offline). Instead of a neutral both-sides book, Foxify opens ONE directional
 * position per event based on a view that is correct with probability `hitRate` (their edge). We sweep the
 * hit-rate across regimes and report Foxify's P&L per 2-week pilot, plus the BREAKEVEN hit-rate — i.e. how
 * often they must be right for the collared directional book to net positive. Uses the same collar payoff
 * and calibrated paths as the gate backtest.
 *
 * Key asymmetry this exposes: the collar caps wins EARLY (~+2%) but protects losses LATE (~−6%), so on
 * moderate moves it clips winners while leaving losers exposed — a directional trader needs edge ABOVE 50%
 * just to overcome the collar's clipping (before the credit helps).
 *
 * Run: npx tsx scripts/creditCollarDirectionalBacktest.ts   (BT_FEE=25 for a realistic perp cost)
 */

const STEPS_PER_DAY = 96;
const CYCLE_MS = 900_000;
const NOTIONAL = 50_000;
const CREDIT = 80;
const FEE = Number(process.env.BT_FEE ?? 25);
const POS_PER_DAY = 2; // 2 directional positions/day = the pilot cadence
const DAYS = 14;
const N_PATHS = 500;

const CAP_LONG = 0.021, CAP_SHORT = 0.029, FLOOR = 0.06;
const collarLong = (m: number) => NOTIONAL * (Math.max(0, -m - FLOOR) - Math.max(0, m - CAP_LONG));
const collarShort = (m: number) => NOTIONAL * (Math.max(0, m - FLOOR) - Math.max(0, -m - CAP_SHORT));

const mulberry32 = (seed: number) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const normal = (rng: () => number) => Math.sqrt(-2 * Math.log(rng() + 1e-12)) * Math.cos(2 * Math.PI * rng());

const genPath = (rng: () => number, drift: number, vol: number, n: number, p0 = 60_000): number[] => {
  const ds = drift / STEPS_PER_DAY, vs = vol / Math.sqrt(STEPS_PER_DAY);
  const out: number[] = []; let p = p0;
  for (let i = 0; i < n; i++) { out.push(p); p = p * (1 + ds + vs * normal(rng)); }
  return out;
};

// One pilot: 2 directional positions/day, each a view correct with prob hitRate. Returns Foxify net.
const simPilot = (path: number[], hitRate: number, rng: () => number): number => {
  const step = Math.round(STEPS_PER_DAY / POS_PER_DAY);
  let net = 0;
  for (let s = 0; s < DAYS * STEPS_PER_DAY; s += step) {
    const m = (path[s + STEPS_PER_DAY] - path[s]) / path[s]; // realized 24h move
    const winningSideLong = m >= 0; // long wins if price rose
    const correct = rng() < hitRate;
    const isLong = correct ? winningSideLong : !winningSideLong; // right ⟹ on the winning side
    const perp = isLong ? m * NOTIONAL : -m * NOTIONAL;
    const collar = isLong ? collarLong(m) : collarShort(m);
    net += perp + collar + CREDIT - FEE;
  }
  return net;
};

const scenarios = [
  { name: "rally  (+2.5%/d, 2% vol)", drift: 0.025, vol: 0.02 },
  { name: "calm   (0 drift, 1% vol)", drift: 0.0, vol: 0.01 },
  { name: "chop   (0 drift, 3.5% vol)", drift: 0.0, vol: 0.035 },
  { name: "selloff(−2.5%/d, 2% vol)", drift: -0.025, vol: 0.02 },
  // The reviewer's "both strikes bind" regime: daily moves large enough that winners cap AND losers floor.
  { name: "extreme(0 drift, 6% vol)", drift: 0.0, vol: 0.06 },
  { name: "crash  (0 drift, 8% vol)", drift: 0.0, vol: 0.08 }
];
const hitRates = [0.5, 0.525, 0.55, 0.575, 0.6, 0.65, 0.7, 0.75];

const fmt = (x: number) => (x < 0 ? "−" : "") + "$" + Math.abs(Math.round(x)).toLocaleString("en-US");

console.log(`\nDIRECTIONAL-EDGE BACKTEST — ${N_PATHS} paths · ${DAYS}d · ${POS_PER_DAY}/day (28 positions) · $${CREDIT} credit · $${FEE} fee`);
console.log("Foxify net per 2-week pilot at each hit-rate (edge). Breakeven = hit-rate where net crosses $0.\n");
console.log(["scenario", ...hitRates.map((h) => `${(h * 100).toFixed(1)}%`), "breakeven"].map((h) => h.padEnd(13)).join(""));

for (const sc of scenarios) {
  const nets: number[] = [];
  for (const hr of hitRates) {
    let sum = 0;
    for (let p = 0; p < N_PATHS; p++) {
      const rng = mulberry32(p * 7919 + Math.round(hr * 1000) * 104729 + sc.name.length);
      const path = genPath(rng, sc.drift, sc.vol, (DAYS + 2) * STEPS_PER_DAY);
      sum += simPilot(path, hr, rng);
    }
    nets.push(sum / N_PATHS);
  }
  // breakeven interpolation (first crossing from negative to positive)
  let be = "—";
  for (let i = 1; i < hitRates.length; i++) {
    if (nets[i - 1] < 0 && nets[i] >= 0) {
      const t = -nets[i - 1] / (nets[i] - nets[i - 1]);
      be = `${((hitRates[i - 1] + t * (hitRates[i] - hitRates[i - 1])) * 100).toFixed(1)}%`;
      break;
    }
  }
  if (be === "—" && nets[0] >= 0) be = "≤50%";
  console.log([sc.name, ...nets.map(fmt), be].map((c) => c.padEnd(13)).join(""));
}
console.log("\nnet = perp + collar + credit − fee, summed over 28 directional positions. 'right' ⟹ on the winning side.\n");
