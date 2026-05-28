/**
 * Multi-tenor Deribit smile probe — fits a separate smile per tenor bucket.
 *
 * The single-tenor probe (probeDeribitSmile.ts) pulls only 3d-tenor options.
 * That's correct for the production Phase 0 cell (3d) but wrong for the
 * shorter-tenor cells (6h, 1d, 2d) — they have different smile shapes due
 * to vol term-structure inversion in calm regimes.
 *
 * This script probes 4 tenor buckets:
 *   - 6h  (±2h, ~today's expiry)
 *   - 1d  (±0.5d)
 *   - 2d  (±0.5d)
 *   - 3d  (±0.5d)
 *
 * Each bucket gets its own smile fit + per-strike spread observations.
 *
 * Output: /tmp/two_sided_smile_multi.json
 */

import * as fs from "node:fs/promises";
import { fitSmile, type SmileObservation, type SpreadObservation, type SmileFit } from "./smileModel";

const STRIKE_WINDOW_PCT = 0.15;
const OUT_PATH = "/tmp/two_sided_smile_multi.json";

const TENOR_BUCKETS = [
  { label: "6h", targetHours: 6, tolHours: 4 },
  { label: "1d", targetHours: 24, tolHours: 8 },
  { label: "2d", targetHours: 48, tolHours: 12 },
  { label: "3d", targetHours: 72, tolHours: 24 }
];

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
  console.log("# Multi-tenor Deribit smile probe\n");
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
  console.log(`  ${instr.result.length} options total`);

  const lo = spot * (1 - STRIKE_WINDOW_PCT);
  const hi = spot * (1 + STRIKE_WINDOW_PCT);

  type PerTenor = {
    label: string;
    targetHours: number;
    instruments: DeribitInstrument[];
    smileObservations: SmileObservation[];
    spreadObservations: SpreadObservation[];
    wideSpreads: string[];
    fit: SmileFit | null;
  };

  const buckets: PerTenor[] = TENOR_BUCKETS.map((b) => ({
    label: b.label,
    targetHours: b.targetHours,
    instruments: [],
    smileObservations: [],
    spreadObservations: [],
    wideSpreads: [],
    fit: null
  }));

  // Bucket instruments by tenor
  for (const i of instr.result) {
    if (i.kind !== "option") continue;
    if (i.strike < lo || i.strike > hi) continue;
    const hoursOut = (i.expiration_timestamp - now) / 3_600_000;
    if (hoursOut <= 0) continue;
    for (let b = 0; b < TENOR_BUCKETS.length; b++) {
      const bucket = TENOR_BUCKETS[b];
      if (Math.abs(hoursOut - bucket.targetHours) <= bucket.tolHours) {
        buckets[b].instruments.push(i);
      }
    }
  }
  for (const b of buckets) {
    console.log(`  ${b.label}: ${b.instruments.length} instruments in window`);
  }

  // Probe each instrument's orderbook
  for (const bucket of buckets) {
    console.log(`\nProbing ${bucket.label} bucket (${bucket.instruments.length} instruments) ...`);
    for (const i of bucket.instruments) {
      try {
        const ob = await fetchJson<{ result: DeribitOrderBook }>(
          `https://www.deribit.com/api/v2/public/get_order_book?instrument_name=${i.instrument_name}&depth=3`
        );
        const o = ob.result;
        if (!o.mark_iv || !o.mark_price) continue;
        const wideSpread = o.ask_iv != null && o.mark_iv != null && (o.ask_iv > 2 * o.mark_iv || o.ask_iv > 80);
        if (wideSpread) {
          bucket.wideSpreads.push(i.instrument_name);
          continue;
        }
        const mid = (o.best_bid_price + o.best_ask_price) / 2;
        const midUsd = mid * o.underlying_price;
        const bidUsd = o.best_bid_price * o.underlying_price;
        const askUsd = o.best_ask_price * o.underlying_price;
        bucket.smileObservations.push({ strike: i.strike, ivAnnual: o.mark_iv / 100 });
        bucket.spreadObservations.push({
          strike: i.strike,
          optionType: i.option_type,
          bidUsdcPerBtc: bidUsd,
          askUsdcPerBtc: askUsd,
          midUsdcPerBtc: midUsd
        });
      } catch { /* skip individual failures */ }
      await new Promise((r) => setTimeout(r, 40));
    }
    console.log(`  ${bucket.smileObservations.length} smile obs, ${bucket.wideSpreads.length} wide-spread excluded`);
    bucket.fit = fitSmile(bucket.smileObservations, spot);
    if (bucket.fit) {
      console.log(`  smile: a0=${(bucket.fit.a0*100).toFixed(2)}% a1=${bucket.fit.a1.toFixed(3)} R²=${bucket.fit.rSquared.toFixed(2)}`);
    } else {
      console.log(`  ⚠ insufficient data for smile fit`);
    }
  }

  const out = {
    generatedAt: new Date(now).toISOString(),
    spotAtPull: spot,
    buckets: buckets.map((b) => ({
      label: b.label,
      targetHours: b.targetHours,
      fit: b.fit,
      smileObservations: b.smileObservations.sort((a, c) => a.strike - c.strike),
      spreadObservations: b.spreadObservations.sort((a, c) => a.strike - c.strike),
      wideSpreadsExcluded: b.wideSpreads
    }))
  };
  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`\n✓ Multi-tenor smile data: ${OUT_PATH}`);
};

import { fileURLToPath } from "node:url";
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
