/**
 * Mixed-regime pilot headline (offline). A realistic 2-week fortnight is mostly calm with a few
 * trend/chop days. This simulates that mix (default 9 calm + 3 rally + 2 chop, order shuffled per path)
 * and reports the EXPECTED pilot P&L for (a) a neutral both-sides book and (b) a directional book at
 * several hit-rates, with a P10/P50/P90 range so Foxify sees the spread, not just the average.
 *
 * Run: npx tsx scripts/creditCollarMixedPilot.ts   (BT_FEE=25 realistic; BT_FEE=80 conservative)
 */

const STEPS_PER_DAY = 96;
const NOTIONAL = 50_000;
const CREDIT = 80;
const FEE = Number(process.env.BT_FEE ?? 25);
const POS_PER_DAY = 2;
const DAYS = 14;
const N_PATHS = 2000;

const CAP_LONG = 0.021, CAP_SHORT = 0.029, FLOOR = 0.06;
const collarLong = (m: number) => NOTIONAL * (Math.max(0, -m - FLOOR) - Math.max(0, m - CAP_LONG));
const collarShort = (m: number) => NOTIONAL * (Math.max(0, m - FLOOR) - Math.max(0, -m - CAP_SHORT));

const REGIMES: Record<string, { drift: number; vol: number }> = {
  calm: { drift: 0.0, vol: 0.01 },
  rally: { drift: 0.025, vol: 0.02 },
  chop: { drift: 0.0, vol: 0.035 }
};
const SCHEDULE = [...Array(9).fill("calm"), ...Array(3).fill("rally"), ...Array(2).fill("chop")]; // 14 days

const mulberry32 = (seed: number) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const normal = (rng: () => number) => Math.sqrt(-2 * Math.log(rng() + 1e-12)) * Math.cos(2 * Math.PI * rng());
const shuffle = <T>(arr: T[], rng: () => number): T[] => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

const genMixedPath = (rng: () => number): number[] => {
  const days = [...shuffle(SCHEDULE, rng), "calm", "calm"]; // +2 calm days so the last opens can settle
  const out: number[] = []; let p = 60_000;
  for (const d of days) {
    const { drift, vol } = REGIMES[d];
    const ds = drift / STEPS_PER_DAY, vs = vol / Math.sqrt(STEPS_PER_DAY);
    for (let i = 0; i < STEPS_PER_DAY; i++) { out.push(p); p = p * (1 + ds + vs * normal(rng)); }
  }
  return out;
};

const step = Math.round(STEPS_PER_DAY / POS_PER_DAY);

const simNeutral = (path: number[]): number => {
  let net = 0;
  for (let s = 0; s < DAYS * STEPS_PER_DAY; s += step) {
    const m = (path[s + STEPS_PER_DAY] - path[s]) / path[s];
    net += collarLong(m) + collarShort(m) + 2 * CREDIT - 2 * FEE; // both sides; perps cancel
  }
  return net;
};

const simDirectional = (path: number[], hitRate: number, rng: () => number): number => {
  let net = 0;
  for (let s = 0; s < DAYS * STEPS_PER_DAY; s += step) {
    for (let k = 0; k < POS_PER_DAY; k++) {
      const m = (path[s + STEPS_PER_DAY] - path[s]) / path[s];
      const isLong = (rng() < hitRate) ? m >= 0 : m < 0;
      const perp = isLong ? m * NOTIONAL : -m * NOTIONAL;
      const collar = isLong ? collarLong(m) : collarShort(m);
      net += perp + collar + CREDIT - FEE;
    }
  }
  return net;
};

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const fmt = (x: number) => (x < 0 ? "−" : "") + "$" + Math.abs(Math.round(x)).toLocaleString("en-US");

console.log(`\nMIXED-REGIME PILOT — ${N_PATHS} paths · 14 days (9 calm + 3 rally + 2 chop, shuffled) · 2/day · $${CREDIT} credit · $${FEE} fee\n`);

const runs: Array<{ label: string; fn: (path: number[], rng: () => number) => number }> = [
  { label: "Neutral book (both sides, no edge)", fn: (p) => simNeutral(p) },
  { label: "Directional @ 50% (coin flip)", fn: (p, r) => simDirectional(p, 0.5, r) },
  { label: "Directional @ 55% edge", fn: (p, r) => simDirectional(p, 0.55, r) },
  { label: "Directional @ 60% edge", fn: (p, r) => simDirectional(p, 0.6, r) }
];

console.log(["strategy", "mean", "P10 (bad)", "P50 (median)", "P90 (good)", "% pilots +"].map((h) => h.padEnd(20)).join(""));
for (const run of runs) {
  const nets: number[] = [];
  for (let i = 0; i < N_PATHS; i++) {
    const rng = mulberry32(i * 7919 + run.label.length * 104729);
    nets.push(run.fn(genMixedPath(rng), rng));
  }
  nets.sort((a, b) => a - b);
  const mean = nets.reduce((s, x) => s + x, 0) / nets.length;
  const posRate = nets.filter((x) => x > 0).length / nets.length;
  console.log([run.label, fmt(mean), fmt(pct(nets, 0.1)), fmt(pct(nets, 0.5)), fmt(pct(nets, 0.9)), `${(posRate * 100).toFixed(0)}%`].map((c) => c.padEnd(20)).join(""));
}
console.log("\nnet over the full 14-day pilot (28 positions). Directional 'right' ⟹ on the winning side that day.\n");
