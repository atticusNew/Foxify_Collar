/**
 * Probe Deribit chain at multiple strikes per side to fit a smile (PR C1).
 *
 * Pulls all listed Deribit BTC options near the target tenor (3d), filters
 * for strikes within ±15% of spot, and outputs smile observations + bid/ask
 * spread observations. Feed into smileModel.fitSmile() for any-strike IV.
 *
 * Use case: Wave C cell sweep validation needs accurate IV at strikes outside
 * the per-leg anchored set ($77k put / $75k call). The smile lets us price
 * OTM strikes (e.g. $74k put, $78k call) accurately, not just extrapolated
 * from the production strikes' calibration multipliers.
 *
 * Output: /tmp/two_sided_smile.json
 *
 * Usage:
 *   cd services/api
 *   npx tsx scripts/backtest/singleSide/probeDeribitSmile.ts
 */

import * as fs from "node:fs/promises";
import { fitSmile, type SmileObservation, type SpreadObservation } from "./smileModel";

const TENOR_DAYS_TARGET = 3;
const TENOR_TOL_DAYS = 1.5;
const STRIKE_WINDOW_PCT = 0.15;
const OUT_PATH = process.env.TWO_SIDED_SMILE_PATH ?? "/tmp/two_sided_smile.json";

type DeribitInstrument = {
  instrument_name: string;
  kind: string;
  option_type: "put" | "call";
  strike: number;
  expiration_timestamp: number;
};

type DeribitOrderBook = {
  best_bid_price: number;
  best_ask_price: number;
  index_price: number;
  underlying_price: number;
  mark_price?: number;
  mark_iv?: number;
  ask_iv?: number;
};

const fetchJson = async <T>(url: string, timeoutMs = 5_000): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as T;
  } finally {
    clearTimeout(timer);
  }
};

const main = async () => {
  console.log("# Deribit smile probe\n");
  const now = Date.now();

  console.log("Fetching index price ...");
  const idx = await fetchJson<{ result: { index_price: number } }>(
    "https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd"
  );
  const spot = idx.result.index_price;
  console.log(`  spot: $${spot.toFixed(2)}`);

  console.log("Fetching all BTC option instruments ...");
  const instr = await fetchJson<{ result: DeribitInstrument[] }>(
    "https://www.deribit.com/api/v2/public/get_instruments?currency=BTC&kind=option&expired=false"
  );
  const all = instr.result;
  console.log(`  ${all.length} options total`);

  const lo = spot * (1 - STRIKE_WINDOW_PCT);
  const hi = spot * (1 + STRIKE_WINDOW_PCT);
  const filtered = all.filter(
    (i) =>
      i.kind === "option" &&
      i.strike >= lo &&
      i.strike <= hi &&
      Math.abs((i.expiration_timestamp - now) / 86_400_000 - TENOR_DAYS_TARGET) < TENOR_TOL_DAYS
  );
  console.log(`  ${filtered.length} options in strike-window ±${(STRIKE_WINDOW_PCT * 100).toFixed(0)}% × tenor ${TENOR_DAYS_TARGET}±${TENOR_TOL_DAYS}d`);

  console.log("Polling per-instrument orderbooks ...");
  const smileObs: SmileObservation[] = [];
  const spreadObs: SpreadObservation[] = [];
  const wideSpreads: string[] = [];

  for (const i of filtered) {
    try {
      const ob = await fetchJson<{ result: DeribitOrderBook }>(
        `https://www.deribit.com/api/v2/public/get_order_book?instrument_name=${i.instrument_name}&depth=3`
      );
      const o = ob.result;
      if (!o.mark_iv || !o.mark_price) continue;
      // Skip wide-spread (stale) anchors — same filter as probeTwoSidedAnchors
      const widespread = o.ask_iv != null && o.mark_iv != null && (o.ask_iv > 2 * o.mark_iv || o.ask_iv > 80);
      if (widespread) {
        wideSpreads.push(i.instrument_name);
        continue;
      }
      const mid = (o.best_bid_price + o.best_ask_price) / 2;
      const midUsd = mid * o.underlying_price;
      const bidUsd = o.best_bid_price * o.underlying_price;
      const askUsd = o.best_ask_price * o.underlying_price;
      smileObs.push({ strike: i.strike, ivAnnual: o.mark_iv / 100 });
      spreadObs.push({
        strike: i.strike,
        optionType: i.option_type,
        bidUsdcPerBtc: bidUsd,
        askUsdcPerBtc: askUsd,
        midUsdcPerBtc: midUsd
      });
    } catch {
      /* skip individual failures */
    }
    // Rate-limit
    await new Promise((r) => setTimeout(r, 50));
  }

  console.log(`\n  ${smileObs.length} observations collected, ${wideSpreads.length} wide-spread skipped`);
  if (smileObs.length < 3) {
    console.error("Insufficient observations to fit smile (need ≥3)");
    process.exit(1);
  }

  const fit = fitSmile(smileObs, spot);
  if (!fit) {
    console.error("Smile fit failed");
    process.exit(1);
  }
  console.log("\nFitted smile:");
  console.log(`  a0 (ATM IV): ${(fit.a0 * 100).toFixed(2)}%`);
  console.log(`  a1 (skew):   ${fit.a1.toFixed(4)}  ${fit.a1 < 0 ? "(put-skew: puts richer)" : "(call-skew)"}`);
  console.log(`  a2 (smile):  ${fit.a2.toFixed(4)}`);
  console.log(`  rSquared:    ${fit.rSquared.toFixed(4)}`);
  console.log(`  observations: ${fit.observationCount}`);

  const out = {
    generatedAt: new Date().toISOString(),
    spotAtPull: spot,
    fit,
    smileObservations: smileObs.sort((a, b) => a.strike - b.strike),
    spreadObservations: spreadObs.sort((a, b) => a.strike - b.strike),
    wideSpreadsExcluded: wideSpreads
  };
  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`\n✓ Wrote smile data to ${OUT_PATH}`);
};

import { fileURLToPath } from "node:url";
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
