/**
 * Calibration check: compare BS-synthetic pricing against live Deribit
 * for a few representative spread structures.
 *
 * Purpose: surface any over/under-pricing in the synthetic model so the
 * backtest report is honest about its accuracy.
 *
 * Run: npx tsx src/_calibrationCheck.ts
 */
import { fetchBtcChainSnapshot, findClosestExpiry, findVerticalSpread } from "./deribitClient.js";
import { putSpreadCost, callSpreadCost, realizedVol30d } from "./math.js";

type Sample = {
  description: string;
  optionType: "C" | "P";
  longOtmFromBarrier: number;  // fraction
  spreadWidth: number;
};

const SAMPLES: Sample[] = [
  { description: "Light  (5%-OTM put,  5% width)",  optionType: "P", longOtmFromBarrier: 0.05, spreadWidth: 0.05 },
  { description: "Std    (2%-OTM put,  8% width)",  optionType: "P", longOtmFromBarrier: 0.02, spreadWidth: 0.08 },
  { description: "Shield (ATM put,    12% width)",  optionType: "P", longOtmFromBarrier: 0.0,  spreadWidth: 0.12 },
  { description: "Light  (5%-OTM call, 5% width)",  optionType: "C", longOtmFromBarrier: 0.05, spreadWidth: 0.05 },
  { description: "Std    (2%-OTM call, 8% width)",  optionType: "C", longOtmFromBarrier: 0.02, spreadWidth: 0.08 },
  { description: "Shield (ATM call,   12% width)",  optionType: "C", longOtmFromBarrier: 0.0,  spreadWidth: 0.12 },
];

async function main() {
  const chain = await fetchBtcChainSnapshot();
  if (!chain) { console.error("Live chain unavailable"); process.exit(1); }
  const expiry = findClosestExpiry(chain, 30, 8);
  if (!expiry) { console.error("No 30-DTE expiry"); process.exit(1); }

  const S = chain.underlying;
  const T = 30 / 365;
  const r = 0.045;

  // Recent rvol estimate from a fixed sample (use 30-day rvol from a known date).
  // For the calibration check we hard-code rvol=0.55 as a typical post-2024 BTC level.
  const rvol = 0.55;
  const ivOverRvol = 1.10;
  const skewSlope = 0.20;
  const bidAskWidener = 0.0;
  const atmIv = rvol * ivOverRvol;

  console.log(`Calibration: BTC=$${S.toFixed(0)}, expiry=${expiry}, T=${T.toFixed(3)}y, rvol=${rvol}, IV(atm)=${(atmIv * 100).toFixed(0)}%`);
  console.log("");
  console.log("Spread                                  | Strike pair        | BS+widener (USD/BTC) | Live (USD/BTC) | Drift");
  console.log("----------------------------------------|--------------------|----------------------|----------------|------");

  for (const s of SAMPLES) {
    // Use S as barrier (ATM-anchored). For a put: K_long = S × (1 - longOtm).
    const K_long = s.optionType === "P" ? S * (1 - s.longOtmFromBarrier) : S * (1 + s.longOtmFromBarrier);
    const K_short = s.optionType === "P" ? K_long - S * s.spreadWidth : K_long + S * s.spreadWidth;
    const otmLong = Math.abs(K_long - S) / S;
    const otmShort = Math.abs(K_short - S) / S;
    const ivLong = atmIv + skewSlope * otmLong;
    const ivShort = atmIv + skewSlope * otmShort;
    const synthPerBtc = (s.optionType === "P"
      ? putSpreadCost(S, K_long, K_short, T, r, ivLong, ivShort)
      : callSpreadCost(S, K_long, K_short, T, r, ivLong, ivShort)) * (1 + bidAskWidener);

    const live = findVerticalSpread(chain, expiry, s.optionType, K_long, S * s.spreadWidth);
    if (!live) { console.log(`${s.description.padEnd(40)}| <no live spread found>`); continue; }
    const longUsd = (live.longRow.ask ?? 0) * (live.longRow.underlying ?? S);
    const shortUsd = (live.shortRow.bid ?? 0) * (live.shortRow.underlying ?? S);
    const livePerBtc = Math.max(0, longUsd - shortUsd);

    const drift = livePerBtc > 0 ? synthPerBtc / livePerBtc : NaN;
    const pair = `${live.K_long}/${live.K_short}`.padEnd(20);
    console.log(`${s.description.padEnd(40)}| ${pair}| ${("$" + synthPerBtc.toFixed(0)).padEnd(20)} | ${("$" + livePerBtc.toFixed(0)).padEnd(14)} | ${drift.toFixed(2)}×`);
  }
}
main();
