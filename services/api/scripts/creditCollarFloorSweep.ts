/**
 * Floor-depth side-by-side (offline analysis). For a $80 credit target, sweep the floor depth and show
 * how wide the pricer can then set the cap, how often that cap breaches at realistic 24h vol, and the
 * resulting expected collar payout (the short-vol bleed) + Foxify net. Uses the REAL pricer + a
 * representative BTC skew. Move distribution: lognormal-ish, modelled Normal on daily return.
 *
 * Run: npx tsx scripts/creditCollarFloorSweep.ts
 */

import { solveAndPriceCreditCollar, type AtticusSpreadConfig } from "../src/singleSide/twoSided/creditCollar/creditCollarPricer";
import { linearDownsideSkew } from "../src/singleSide/twoSided/creditCollar/skew";

const SPOT = 60_000;
const NOTIONAL = 50_000;
const TENOR_DAYS = 1;
const TARGET_CREDIT = 80;
const ATM_IV = 0.5; // ~50% annualized — representative BTC 24h implied

const skew = linearDownsideSkew(SPOT, ATM_IV, 0.12);
const cfgBase: AtticusSpreadConfig = {
  fillMode: "touch",
  pricingModel: "pass_through",
  feeMode: "clob_taker",
  feeVenue: "okx",
  strikeGridUsdc: 250,
  operationFeeBps: 2,
  minOperationFeeUsdc: 10,
  maxFoxifyCreditUsdc: TARGET_CREDIT
};

// ── Normal helpers ────────────────────────────────────────────────────────────
const erf = (x: number): number => {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
};
const cdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));
const pdf = (z: number) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);

// Expected collar payout to Foxify for one position, integrating over the daily move ~ N(0, sigma^2).
// long-perp collar payout(move)  = N * [ max(0, −move − floorPct) − max(0, move − capPct) ]
// short-perp collar payout(move) = N * [ max(0, move − floorPct) − max(0, −move − capPct) ]  (mirror)
const expectedPayout = (side: "long" | "short", capPct: number, floorPct: number, sigma: number): number => {
  const lo = -0.3, hi = 0.3, step = 0.0002;
  let e = 0;
  for (let m = lo; m <= hi; m += step) {
    const dens = pdf(m / sigma) / sigma;
    const pay =
      side === "long"
        ? Math.max(0, -m - floorPct) - Math.max(0, m - capPct)
        : Math.max(0, m - floorPct) - Math.max(0, -m - capPct);
    e += NOTIONAL * pay * dens * step;
  }
  return e;
};

const dailySigma = (annualIv: number) => annualIv * Math.sqrt(TENOR_DAYS / 365);
const SIGMAS = { calm: dailySigma(0.3), normal: dailySigma(0.5), active: dailySigma(0.7) };

const fmt = (x: number, d = 2) => (x < 0 ? "−" : "") + "$" + Math.abs(x).toFixed(d);
const pctS = (x: number) => (x * 100).toFixed(2) + "%";

console.log(`\nFLOOR-DEPTH SWEEP — $${TARGET_CREDIT} credit target, ${TENOR_DAYS}d tenor, $${NOTIONAL} clip, ATM IV ${ATM_IV}`);
console.log(`Daily σ: calm ${pctS(SIGMAS.calm)} (30% ann) · normal ${pctS(SIGMAS.normal)} (50%) · active ${pctS(SIGMAS.active)} (70%)`);
console.log("Book = 50/50 long+short; 'cap' = the funding-leg width Foxify forfeits beyond.\n");

const floors = [0.03, 0.04, 0.05, 0.06, 0.08, 0.1, 0.15];
const header = ["floor", "capL", "capS", "P(cap hit)@norm", "E[payout]/pos", "Foxify net @fee80", "Foxify net @fee25"];
console.log(header.map((h) => h.padEnd(17)).join(""));

for (const floor of floors) {
  const qL = solveAndPriceCreditCollar({ side: "long", spot: SPOT, notionalUsdc: NOTIONAL, tenorDays: TENOR_DAYS, targetCreditUsdc: TARGET_CREDIT, maxFloorPct: floor, referenceMode: "position" }, skew, cfgBase);
  const qS = solveAndPriceCreditCollar({ side: "short", spot: SPOT, notionalUsdc: NOTIONAL, tenorDays: TENOR_DAYS, targetCreditUsdc: TARGET_CREDIT, maxFloorPct: floor, referenceMode: "position" }, skew, cfgBase);
  if (!qL.ok || !qS.ok) {
    console.log(`${pctS(floor).padEnd(17)}INFEASIBLE (${(!qL.ok ? qL.error : qS.ok ? "" : qS.error)})`);
    continue;
  }
  const capL = qL.legs.cap_pct, capS = qS.legs.cap_pct;
  const sig = SIGMAS.normal;
  const pCapL = 1 - cdf(capL / sig), pCapS = 1 - cdf(capS / sig);
  const pCapAvg = (pCapL + pCapS) / 2;
  // book expected payout per position = average of long+short expected payouts
  const eL = expectedPayout("long", capL, qL.legs.floor_pct, sig);
  const eS = expectedPayout("short", capS, qS.legs.floor_pct, sig);
  const ePayout = (eL + eS) / 2;
  const credit = (qL.economics.foxify_credit_usdc + qS.economics.foxify_credit_usdc) / 2;
  const net80 = credit + ePayout - 80;
  const net25 = credit + ePayout - 25;
  console.log(
    [pctS(floor), pctS(capL), pctS(capS), pctS(pCapAvg), fmt(ePayout), fmt(net80), fmt(net25)]
      .map((c) => c.padEnd(17))
      .join("")
  );
}

// Sensitivity: E[payout] per position across vol regimes at the shallow (4%) vs deep (10%) floor.
console.log("\nRegime sensitivity — book E[payout]/pos (short-vol bleed) at 4% vs 10% floor:");
for (const floor of [0.04, 0.1]) {
  const qL = solveAndPriceCreditCollar({ side: "long", spot: SPOT, notionalUsdc: NOTIONAL, tenorDays: TENOR_DAYS, targetCreditUsdc: TARGET_CREDIT, maxFloorPct: floor, referenceMode: "position" }, skew, cfgBase);
  const qS = solveAndPriceCreditCollar({ side: "short", spot: SPOT, notionalUsdc: NOTIONAL, tenorDays: TENOR_DAYS, targetCreditUsdc: TARGET_CREDIT, maxFloorPct: floor, referenceMode: "position" }, skew, cfgBase);
  if (!qL.ok || !qS.ok) continue;
  const row = (Object.entries(SIGMAS) as Array<[string, number]>).map(([k, s]) => {
    const e = (expectedPayout("long", qL.legs.cap_pct, qL.legs.floor_pct, s) + expectedPayout("short", qS.legs.cap_pct, qS.legs.floor_pct, s)) / 2;
    return `${k} ${fmt(e)}`;
  });
  console.log(`  floor ${pctS(floor)} (cap ${pctS(qL.legs.cap_pct)}/${pctS(qS.legs.cap_pct)}): ${row.join(" · ")}`);
}
console.log();
