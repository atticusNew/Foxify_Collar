#!/usr/bin/env tsx
/**
 * Phase 0 Deliverable 1 — Biweekly hedge pricing calibration.
 *
 * Pure analysis. Read-only. No DB, no auth, no production impact.
 *
 * Pulls 90 days of Deribit BTC DVOL history and Coinbase BTC spot
 * history, then computes for each (vol_regime × sl_tier × direction)
 * combination the implied per-day USD-per-$1k hedge cost for a 14-day
 * BTC option at strike = trigger price.
 *
 * Why biweekly: the live 1-day-tenor product has been bottlenecked by
 * Deribit liquidity at our hedge size (3df5cfa1 burned 285 no_bid
 * retries on a 0.1 BTC same-day call). 14-day options on Deribit have
 * materially better bid-ask, AND the per-day amortization of premium is
 * lower despite higher absolute upfront cost (longer-dated theta is
 * cheaper per day). This script gives us the actual numbers — the ones
 * the strategic review estimated at "$25-35/day for 2% SL" but
 * acknowledged were ±50% guesses.
 *
 * Usage:
 *   npx tsx services/api/scripts/phase0/biweekly_pricing_calibration.ts
 *   npx tsx services/api/scripts/phase0/biweekly_pricing_calibration.ts --days 90
 *   npx tsx services/api/scripts/phase0/biweekly_pricing_calibration.ts --tenor 7
 *   npx tsx services/api/scripts/phase0/biweekly_pricing_calibration.ts --out-dir docs/cfo-report/phase0
 *   npx tsx services/api/scripts/phase0/biweekly_pricing_calibration.ts --skip-live-validation
 *
 * Output:
 *   docs/cfo-report/phase0/biweekly_pricing_dataset.json   (machine-readable)
 *   docs/cfo-report/phase0/biweekly_pricing_dataset.md     (human-readable)
 *   docs/cfo-report/phase0/biweekly_chain_snapshot.json    (live Deribit chain validation)
 *
 * Re-runnable. Outputs are idempotent for the same input window
 * (modulo the live-chain snapshot which captures the moment).
 *
 * Exit codes:
 *   0 — calibration completed (artifacts written)
 *   1 — fetch failure (Deribit / Coinbase unreachable, retry later)
 *   2 — bad CLI args
 */

import { bsPut, bsCall } from "../../src/pilot/blackScholes";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// ─────────────────────────────────────────────────────────────────────
// Constants — pulled from production modules, kept inline for clarity
// ─────────────────────────────────────────────────────────────────────

// DVOL band cutoffs from services/api/src/pilot/pricingRegime.ts
// DEFAULT_BANDS (strict < comparisons; DVOL exactly 50 → moderate).
const REGIME_BANDS = {
  low: { upTo: 50 },
  moderate: { upTo: 65 },
  elevated: { upTo: 80 },
  high: { upTo: Infinity }
} as const;

type Regime = keyof typeof REGIME_BANDS;
const REGIMES: readonly Regime[] = ["low", "moderate", "elevated", "high"];

// V7_LAUNCHED_TIERS from services/api/src/pilot/v7Pricing.ts.
const SL_TIERS = [2, 3, 5, 10] as const;
type SlTier = typeof SL_TIERS[number];

const DIRECTIONS = ["long", "short"] as const;
type Direction = typeof DIRECTIONS[number];

// ─────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const argFlag = (name: string, fallback?: string): string | undefined => {
  const idx = argv.indexOf(name);
  if (idx === -1) return fallback;
  return argv[idx + 1];
};
const hasFlag = (name: string): boolean => argv.includes(name);

const DAYS = Number(argFlag("--days", "90"));
const TENOR_DAYS = Number(argFlag("--tenor", "14"));
const OUT_DIR = argFlag("--out-dir", "docs/cfo-report/phase0")!;
const SKIP_LIVE_VALIDATION = hasFlag("--skip-live-validation");

if (!Number.isFinite(DAYS) || DAYS <= 0 || DAYS > 365) {
  console.error("ERROR: --days must be a positive integer ≤ 365");
  process.exit(2);
}
if (!Number.isFinite(TENOR_DAYS) || TENOR_DAYS <= 0 || TENOR_DAYS > 60) {
  console.error("ERROR: --tenor must be a positive integer ≤ 60");
  process.exit(2);
}

// ─────────────────────────────────────────────────────────────────────
// Data fetching
// ─────────────────────────────────────────────────────────────────────

const DERIBIT_BASE = "https://www.deribit.com/api/v2";
const COINBASE_BASE = "https://api.exchange.coinbase.com";

const log = (msg: string): void => {
  process.stderr.write(`[phase0/d1] ${msg}\n`);
};

type DvolPoint = { tsMs: number; dvol: number };
type SpotPoint = { tsMs: number; spotUsd: number };

/**
 * Pull Deribit DVOL hourly close history. Deribit caps each call to
 * roughly 745 samples regardless of resolution, so we paginate by
 * windowing the request. resolution=3600 (1h) gives ~31 days per call.
 */
const fetchDvolHistory = async (days: number): Promise<DvolPoint[]> => {
  const endMs = Date.now();
  const startMs = endMs - days * 86400 * 1000;
  const out: DvolPoint[] = [];
  const WINDOW_MS = 30 * 86400 * 1000;
  let cursor = startMs;
  while (cursor < endMs) {
    const windowEnd = Math.min(cursor + WINDOW_MS, endMs);
    const url =
      `${DERIBIT_BASE}/public/get_volatility_index_data` +
      `?currency=BTC&resolution=3600` +
      `&start_timestamp=${cursor}` +
      `&end_timestamp=${windowEnd}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`deribit dvol http ${res.status}`);
    const j: any = await res.json();
    const rows: any[] = j?.result?.data ?? [];
    for (const r of rows) {
      const tsMs = Number(r?.[0]);
      const close = Number(r?.[4]);
      if (Number.isFinite(tsMs) && Number.isFinite(close) && close > 0) {
        out.push({ tsMs, dvol: close });
      }
    }
    cursor = windowEnd + 1;
  }
  out.sort((a, b) => a.tsMs - b.tsMs);
  // De-dup by tsMs (paginated windows can overlap on boundaries)
  const seen = new Set<number>();
  return out.filter((p) => {
    if (seen.has(p.tsMs)) return false;
    seen.add(p.tsMs);
    return true;
  });
};

/**
 * Pull Coinbase BTC-USD hourly close history. Coinbase caps to 300
 * candles per call, so we paginate.
 */
const fetchSpotHistory = async (days: number): Promise<SpotPoint[]> => {
  const endMs = Date.now();
  const startMs = endMs - days * 86400 * 1000;
  const out: SpotPoint[] = [];
  // 300 candles × 3600s = 1.08e6s = 12.5 days per call. Use 12d windows.
  const WINDOW_MS = 12 * 86400 * 1000;
  let cursor = startMs;
  while (cursor < endMs) {
    const windowEnd = Math.min(cursor + WINDOW_MS, endMs);
    const startIso = new Date(cursor).toISOString();
    const endIso = new Date(windowEnd).toISOString();
    const url =
      `${COINBASE_BASE}/products/BTC-USD/candles` +
      `?granularity=3600&start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "atticus-phase0-d1/1.0" }
    });
    if (!res.ok) throw new Error(`coinbase candles http ${res.status}`);
    const j: any = await res.json();
    if (!Array.isArray(j)) throw new Error("coinbase candles unexpected shape");
    for (const r of j) {
      // Coinbase row: [time, low, high, open, close, volume] — time in seconds
      const tsSec = Number(r?.[0]);
      const close = Number(r?.[4]);
      if (Number.isFinite(tsSec) && Number.isFinite(close) && close > 0) {
        out.push({ tsMs: tsSec * 1000, spotUsd: close });
      }
    }
    cursor = windowEnd + 1;
    // Coinbase rate-limits at 10 req/s public; small sleep between pages.
    await new Promise((r) => setTimeout(r, 350));
  }
  out.sort((a, b) => a.tsMs - b.tsMs);
  const seen = new Set<number>();
  return out.filter((p) => {
    if (seen.has(p.tsMs)) return false;
    seen.add(p.tsMs);
    return true;
  });
};

// ─────────────────────────────────────────────────────────────────────
// Regime classification
// ─────────────────────────────────────────────────────────────────────

const classifyDvol = (dvol: number): Regime => {
  if (dvol < REGIME_BANDS.low.upTo) return "low";
  if (dvol < REGIME_BANDS.moderate.upTo) return "moderate";
  if (dvol < REGIME_BANDS.elevated.upTo) return "elevated";
  return "high";
};

// ─────────────────────────────────────────────────────────────────────
// Pricing math
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute the trigger price for a given (entry, sl_pct, direction).
 *   long protection (downside hedge): trigger = entry × (1 - slPct/100)
 *   short protection (upside hedge):  trigger = entry × (1 + slPct/100)
 */
const triggerPrice = (entry: number, slPct: SlTier, direction: Direction): number => {
  const move = slPct / 100;
  return direction === "short" ? entry * (1 + move) : entry * (1 - move);
};

/**
 * For a given (entry, dvol, sl_tier, direction, tenor_days), price the
 * hedge option at strike = trigger.
 *   long  → put  hedge (strike below spot)
 *   short → call hedge (strike above spot)
 *
 * Returns BS premium in USD per BTC, then converted to USD per $1k of
 * protected notional, then amortized to per-day USD per $1k.
 *
 * Quantity-of-BTC-hedged math: a $1k notional position at spot $S needs
 * 1000/S BTC of hedge to fully cover the slPct payout obligation. So
 * USD-per-$1k-notional cost = bsPremiumUsd × (1000/S) where bsPremiumUsd
 * is the option price per BTC.
 */
const pricePerDayPer1k = (params: {
  entry: number;
  dvol: number;
  slPct: SlTier;
  direction: Direction;
  tenorDays: number;
}): { perDayUsdPer1k: number; upfrontUsdPer1k: number; bsPremiumPerBtc: number } => {
  const { entry, dvol, slPct, direction, tenorDays } = params;
  const sigma = dvol / 100;
  const T = tenorDays / 365.25;
  const strike = triggerPrice(entry, slPct, direction);
  // Risk-free rate 0 (matches production hedgeManager constant).
  const r = 0;
  const bsPremiumPerBtc =
    direction === "long" ? bsPut(entry, strike, T, r, sigma) : bsCall(entry, strike, T, r, sigma);
  // BS premium is in USD per BTC of underlying. Hedge BTC quantity for
  // $1k notional at spot S: 1000/S BTC. So USD-per-$1k = price-per-BTC × 1000/S.
  const upfrontUsdPer1k = bsPremiumPerBtc * (1000 / entry);
  const perDayUsdPer1k = upfrontUsdPer1k / tenorDays;
  return { perDayUsdPer1k, upfrontUsdPer1k, bsPremiumPerBtc };
};

// ─────────────────────────────────────────────────────────────────────
// Aggregation
// ─────────────────────────────────────────────────────────────────────

type HourlyJoined = { tsMs: number; dvol: number; spotUsd: number; regime: Regime };

/**
 * Join DVOL and spot hourly series on closest matching timestamp
 * (DVOL and spot don't always land on the exact same minute mark).
 * Drops any DVOL sample that has no spot within ±90 minutes.
 */
const joinDvolWithSpot = (dvol: DvolPoint[], spot: SpotPoint[]): HourlyJoined[] => {
  const spotMap = new Map<number, number>();
  for (const s of spot) {
    // Bucket spot by its hour to give DVOL samples a nearby key
    const hourMs = Math.floor(s.tsMs / 3600000) * 3600000;
    spotMap.set(hourMs, s.spotUsd);
  }
  const out: HourlyJoined[] = [];
  for (const d of dvol) {
    const hourMs = Math.floor(d.tsMs / 3600000) * 3600000;
    let s = spotMap.get(hourMs);
    if (s === undefined) {
      // Try ±1 hour
      s = spotMap.get(hourMs - 3600000) ?? spotMap.get(hourMs + 3600000);
    }
    if (s === undefined) continue;
    out.push({ tsMs: d.tsMs, dvol: d.dvol, spotUsd: s, regime: classifyDvol(d.dvol) });
  }
  return out;
};

type Cell = {
  regime: Regime;
  slPct: SlTier;
  direction: Direction;
  tenorDays: number;
  sampleCount: number;
  dvolMean: number;
  dvolMin: number;
  dvolMax: number;
  spotMean: number;
  perDayUsdPer1k_mean: number;
  perDayUsdPer1k_p25: number;
  perDayUsdPer1k_p50: number;
  perDayUsdPer1k_p75: number;
  perDayUsdPer1k_p90: number;
  upfrontUsdPer1k_mean: number;
};

const percentile = (arr: number[], p: number): number => {
  if (!arr.length) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1)));
  return sorted[idx];
};

const buildCells = (joined: HourlyJoined[], tenorDays: number): Cell[] => {
  const cells: Cell[] = [];
  for (const regime of REGIMES) {
    const inRegime = joined.filter((j) => j.regime === regime);
    if (inRegime.length === 0) {
      // Still emit an empty cell row so the report shows the regime band
      for (const slPct of SL_TIERS) {
        for (const direction of DIRECTIONS) {
          cells.push({
            regime,
            slPct,
            direction,
            tenorDays,
            sampleCount: 0,
            dvolMean: NaN,
            dvolMin: NaN,
            dvolMax: NaN,
            spotMean: NaN,
            perDayUsdPer1k_mean: NaN,
            perDayUsdPer1k_p25: NaN,
            perDayUsdPer1k_p50: NaN,
            perDayUsdPer1k_p75: NaN,
            perDayUsdPer1k_p90: NaN,
            upfrontUsdPer1k_mean: NaN
          });
        }
      }
      continue;
    }
    const dvols = inRegime.map((j) => j.dvol);
    const spots = inRegime.map((j) => j.spotUsd);
    const dvolMean = dvols.reduce((a, b) => a + b, 0) / dvols.length;
    const dvolMin = Math.min(...dvols);
    const dvolMax = Math.max(...dvols);
    const spotMean = spots.reduce((a, b) => a + b, 0) / spots.length;

    for (const slPct of SL_TIERS) {
      for (const direction of DIRECTIONS) {
        const perDays = inRegime.map((j) => {
          const { perDayUsdPer1k } = pricePerDayPer1k({
            entry: j.spotUsd,
            dvol: j.dvol,
            slPct,
            direction,
            tenorDays
          });
          return perDayUsdPer1k;
        });
        const upfronts = inRegime.map((j) => {
          const { upfrontUsdPer1k } = pricePerDayPer1k({
            entry: j.spotUsd,
            dvol: j.dvol,
            slPct,
            direction,
            tenorDays
          });
          return upfrontUsdPer1k;
        });
        cells.push({
          regime,
          slPct,
          direction,
          tenorDays,
          sampleCount: inRegime.length,
          dvolMean,
          dvolMin,
          dvolMax,
          spotMean,
          perDayUsdPer1k_mean: perDays.reduce((a, b) => a + b, 0) / perDays.length,
          perDayUsdPer1k_p25: percentile(perDays, 25),
          perDayUsdPer1k_p50: percentile(perDays, 50),
          perDayUsdPer1k_p75: percentile(perDays, 75),
          perDayUsdPer1k_p90: percentile(perDays, 90),
          upfrontUsdPer1k_mean: upfronts.reduce((a, b) => a + b, 0) / upfronts.length
        });
      }
    }
  }
  return cells;
};

// ─────────────────────────────────────────────────────────────────────
// Live Deribit chain snapshot (model-vs-market validation)
// ─────────────────────────────────────────────────────────────────────

type ChainSnapshot = {
  capturedAt: string;
  spotUsd: number;
  dvolNow: number;
  expiry: string;
  daysToExpiry: number;
  rows: Array<{
    instrument: string;
    type: "P" | "C";
    strike: number;
    /** Best bid in BTC (Deribit native quote currency for options) */
    bidBtc: number | null;
    /** Best ask in BTC */
    askBtc: number | null;
    /** Best ask converted to USD = askBtc × spotUsd */
    askUsd: number | null;
    /** Mark IV in percent (e.g., 42.16 = 42.16% annualized) */
    markIv: number | null;
    /** BS theoretical price (USD per option, i.e. per BTC underlying) using DVOL/100 as sigma */
    bsAtDvolUsd: number | null;
    /** BS theoretical price (USD per option) using the option's own mark IV as sigma */
    bsAtMarkIvUsd: number | null;
  }>;
};

const fetchLiveChain = async (targetTenorDays: number): Promise<ChainSnapshot> => {
  // 1. Spot
  const tickerRes = await fetch(`${DERIBIT_BASE}/public/ticker?instrument_name=BTC-PERPETUAL`);
  const tickerJson: any = await tickerRes.json();
  const spotUsd = Number(tickerJson?.result?.last_price);
  if (!Number.isFinite(spotUsd)) throw new Error("deribit perpetual price unavailable");

  // 2. Current DVOL
  const dvolRes = await fetch(
    `${DERIBIT_BASE}/public/get_volatility_index_data?currency=BTC&resolution=3600&start_timestamp=${Date.now() - 7200000}&end_timestamp=${Date.now()}`
  );
  const dvolJson: any = await dvolRes.json();
  const dvolRows: any[] = dvolJson?.result?.data ?? [];
  const dvolNow = Number(dvolRows[dvolRows.length - 1]?.[4]) || NaN;

  // 3. Find the option expiry closest to targetTenorDays from now
  const instrRes = await fetch(`${DERIBIT_BASE}/public/get_instruments?currency=BTC&kind=option&expired=false`);
  const instrJson: any = await instrRes.json();
  const instruments: any[] = instrJson?.result ?? [];
  type Expiry = { tsMs: number; iso: string; days: number };
  const expirySet = new Map<number, Expiry>();
  for (const i of instruments) {
    const ts = Number(i?.expiration_timestamp);
    if (!Number.isFinite(ts)) continue;
    if (!expirySet.has(ts)) {
      const days = (ts - Date.now()) / 86400000;
      expirySet.set(ts, { tsMs: ts, iso: new Date(ts).toISOString(), days });
    }
  }
  const expiries = [...expirySet.values()].sort(
    (a, b) => Math.abs(a.days - targetTenorDays) - Math.abs(b.days - targetTenorDays)
  );
  if (!expiries.length) throw new Error("no live BTC option expiries returned");
  const targetExpiry = expiries[0];

  // 4. Pull strikes near each tier's trigger for both LONG (put) and SHORT (call).
  //    We sample strikes ATM ± ~2% to keep the snapshot small but
  //    representative of where we'd actually buy.
  const candidates = instruments.filter(
    (i) => Number(i?.expiration_timestamp) === targetExpiry.tsMs && (i?.option_type === "put" || i?.option_type === "call")
  );
  const wantedStrikes = new Set<number>();
  for (const slPct of SL_TIERS) {
    for (const dir of DIRECTIONS) {
      const trig = triggerPrice(spotUsd, slPct, dir);
      // Find the closest available strike from the chain
      const chainStrikes = candidates
        .map((c) => Number(c.strike))
        .filter((s) => Number.isFinite(s));
      const nearest = chainStrikes
        .slice()
        .sort((a, b) => Math.abs(a - trig) - Math.abs(b - trig))[0];
      if (nearest) wantedStrikes.add(nearest);
    }
  }

  const rows: ChainSnapshot["rows"] = [];
  for (const c of candidates) {
    const strike = Number(c.strike);
    if (!wantedStrikes.has(strike)) continue;
    const isPut = c.option_type === "put";
    const tickerR = await fetch(`${DERIBIT_BASE}/public/ticker?instrument_name=${c.instrument_name}`);
    const tickerJ: any = await tickerR.json();
    const result = tickerJ?.result ?? {};
    const bestBid = Number(result?.best_bid_price);
    const bestAsk = Number(result?.best_ask_price);
    const markIv = Number(result?.mark_iv); // percent
    const T = (targetExpiry.tsMs - Date.now()) / (365.25 * 86400 * 1000);
    const sigmaDvol = Number.isFinite(dvolNow) ? dvolNow / 100 : NaN;
    const bsAtDvol = Number.isFinite(sigmaDvol)
      ? isPut
        ? bsPut(spotUsd, strike, T, 0, sigmaDvol)
        : bsCall(spotUsd, strike, T, 0, sigmaDvol)
      : NaN;
    const bsAtMarkIv = Number.isFinite(markIv)
      ? isPut
        ? bsPut(spotUsd, strike, T, 0, markIv / 100)
        : bsCall(spotUsd, strike, T, 0, markIv / 100)
      : NaN;
    const askBtc = Number.isFinite(bestAsk) && bestAsk > 0 ? bestAsk : null;
    rows.push({
      instrument: String(c.instrument_name),
      type: isPut ? "P" : "C",
      strike,
      bidBtc: Number.isFinite(bestBid) && bestBid > 0 ? bestBid : null,
      askBtc,
      askUsd: askBtc !== null ? askBtc * spotUsd : null,
      markIv: Number.isFinite(markIv) ? markIv : null,
      bsAtDvolUsd: Number.isFinite(bsAtDvol) ? bsAtDvol : null,
      bsAtMarkIvUsd: Number.isFinite(bsAtMarkIv) ? bsAtMarkIv : null
    });
    // Be polite: small sleep between ticker calls
    await new Promise((r) => setTimeout(r, 100));
  }
  rows.sort((a, b) => a.strike - b.strike);

  return {
    capturedAt: new Date().toISOString(),
    spotUsd,
    dvolNow,
    expiry: targetExpiry.iso,
    daysToExpiry: targetExpiry.days,
    rows
  };
};

// ─────────────────────────────────────────────────────────────────────
// Output rendering
// ─────────────────────────────────────────────────────────────────────

const formatUsd = (n: number, places = 2): string => {
  if (!Number.isFinite(n)) return "n/a";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: places, maximumFractionDigits: places })}`;
};

const renderMarkdown = (params: {
  days: number;
  tenorDays: number;
  capturedAt: string;
  joined: HourlyJoined[];
  cells: Cell[];
  chain: ChainSnapshot | null;
}): string => {
  const { days, tenorDays, capturedAt, joined, cells, chain } = params;
  const lines: string[] = [];
  lines.push(`# Phase 0 D1 — Biweekly Hedge Pricing Calibration`);
  lines.push("");
  lines.push(`> Generated by \`services/api/scripts/phase0/biweekly_pricing_calibration.ts\`.`);
  lines.push(`> Pure analysis, read-only. No production state changed.`);
  lines.push("");
  lines.push(`**Captured:** ${capturedAt}`);
  lines.push(`**Lookback:** ${days} days of hourly DVOL × hourly BTC spot`);
  lines.push(`**Hedge tenor priced:** ${tenorDays} days`);
  lines.push(`**Joined hourly samples:** ${joined.length}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## What this is");
  lines.push("");
  lines.push(
    "For each historical hour with both a Deribit DVOL print and a Coinbase BTC-USD spot print, " +
      "we BS-priced a 14-day BTC option at strike = trigger price (entry × (1 ± SL%)) using DVOL/100 " +
      "as sigma. We then convert per-BTC premium to USD per $1k of protected notional, divide by " +
      "tenor days for the per-day cost, and aggregate across hours bucketed by DVOL regime."
  );
  lines.push("");
  lines.push(
    "Regime bands match `services/api/src/pilot/pricingRegime.ts` `DEFAULT_BANDS`: " +
      "low DVOL < 50, moderate < 65, elevated < 80, high otherwise. Tier list matches " +
      "`v7Pricing.ts` `V7_LAUNCHED_TIERS` (2/3/5/10%)."
  );
  lines.push("");
  lines.push(
    "**Sigma source caveat:** DVOL is Deribit's index of forward implied vol, not the " +
      "instrument-level IV we'd actually trade against. The live chain validation " +
      "section below quantifies the gap between DVOL-implied BS pricing and the actual " +
      "Deribit ask at the moment of capture."
  );
  lines.push("");

  // ── DVOL distribution ──
  const regimeCounts: Record<Regime, number> = { low: 0, moderate: 0, elevated: 0, high: 0 };
  for (const j of joined) regimeCounts[j.regime]++;
  lines.push("## DVOL regime distribution over the lookback window");
  lines.push("");
  lines.push("| Regime | DVOL band | Hours observed | Share |");
  lines.push("|---|---|---|---|");
  for (const r of REGIMES) {
    const lo = r === "low" ? "≤" : ">";
    const hi = r === "high" ? "" : ` < ${REGIME_BANDS[r].upTo}`;
    const band =
      r === "low"
        ? `< ${REGIME_BANDS.low.upTo}`
        : r === "moderate"
        ? `[${REGIME_BANDS.low.upTo}, ${REGIME_BANDS.moderate.upTo})`
        : r === "elevated"
        ? `[${REGIME_BANDS.moderate.upTo}, ${REGIME_BANDS.elevated.upTo})`
        : `≥ ${REGIME_BANDS.elevated.upTo}`;
    void lo;
    void hi;
    const share = joined.length > 0 ? (regimeCounts[r] / joined.length) * 100 : 0;
    lines.push(`| ${r} | ${band} | ${regimeCounts[r]} | ${share.toFixed(1)}% |`);
  }
  lines.push("");

  // ── Per-day USD per $1k tables, one per regime ──
  lines.push(`## Per-day USD per \\$1k notional cost (BS-modeled, ${tenorDays}-day tenor)`);
  lines.push("");
  lines.push("Reading the table: a $10k position at SL 2% in this regime would cost the trader ");
  lines.push("**(per-day-cost × 10) per day of subscription**.");
  lines.push("");

  for (const regime of REGIMES) {
    const regimeCells = cells.filter((c) => c.regime === regime);
    const sampleCount = regimeCells[0]?.sampleCount ?? 0;
    const dvolMean = regimeCells[0]?.dvolMean ?? NaN;
    lines.push(`### ${regime[0].toUpperCase()}${regime.slice(1)} regime — ${sampleCount} hours`);
    lines.push(
      `*DVOL mean ${Number.isFinite(dvolMean) ? dvolMean.toFixed(2) : "n/a"} ` +
        `(min ${Number.isFinite(regimeCells[0]?.dvolMin) ? regimeCells[0].dvolMin.toFixed(2) : "n/a"}, ` +
        `max ${Number.isFinite(regimeCells[0]?.dvolMax) ? regimeCells[0].dvolMax.toFixed(2) : "n/a"}). ` +
        `Spot mean ${Number.isFinite(regimeCells[0]?.spotMean) ? formatUsd(regimeCells[0].spotMean, 0) : "n/a"}.*`
    );
    lines.push("");
    if (sampleCount === 0) {
      lines.push(`_No hourly samples in this regime over the lookback window._`);
      lines.push("");
      continue;
    }
    lines.push("| SL % | Direction | Per-day mean | p25 | p50 | p75 | p90 | Upfront mean (full tenor) |");
    lines.push("|---|---|---|---|---|---|---|---|");
    for (const slPct of SL_TIERS) {
      for (const direction of DIRECTIONS) {
        const c = regimeCells.find((x) => x.slPct === slPct && x.direction === direction);
        if (!c) continue;
        lines.push(
          `| ${slPct}% | ${direction} | ${formatUsd(c.perDayUsdPer1k_mean, 3)} | ${formatUsd(c.perDayUsdPer1k_p25, 3)} | ${formatUsd(c.perDayUsdPer1k_p50, 3)} | ${formatUsd(c.perDayUsdPer1k_p75, 3)} | ${formatUsd(c.perDayUsdPer1k_p90, 3)} | ${formatUsd(c.upfrontUsdPer1k_mean, 3)} |`
        );
      }
    }
    lines.push("");
  }

  // ── Comparison vs current 1-day pricing ──
  lines.push("## Comparison vs current 1-day product pricing");
  lines.push("");
  lines.push(
    "Current `pricingRegime.REGIME_SCHEDULES` (1-day tenor, USD per $1k per day; per `pricingRegime.ts`):"
  );
  lines.push("");
  lines.push("| Regime | 2% | 3% | 5% | 10% |");
  lines.push("|---|---|---|---|---|");
  lines.push("| low | $6.50 | $5.00 | $3.00 | $2.00 |");
  lines.push("| moderate | $7.00 | $5.50 | $3.00 | $2.00 |");
  lines.push("| elevated | $8.00 | $6.00 | $3.50 | $2.00 |");
  lines.push("| high | $10.00 | $7.00 | $4.00 | $2.00 |");
  lines.push("");
  lines.push(
    `Biweekly per-day BS-modeled (LONG, mean across regime) for comparison — divide trader-facing rate by these to see expected gross margin per dollar of cover:`
  );
  lines.push("");
  lines.push("| Regime | 2% LONG | 3% LONG | 5% LONG | 10% LONG |");
  lines.push("|---|---|---|---|---|");
  for (const regime of REGIMES) {
    const row = SL_TIERS.map((slPct) => {
      const c = cells.find((x) => x.regime === regime && x.slPct === slPct && x.direction === "long");
      return c ? formatUsd(c.perDayUsdPer1k_mean, 3) : "n/a";
    });
    lines.push(`| ${regime} | ${row.join(" | ")} |`);
  }
  lines.push("");
  lines.push(
    "_BS-modeled cost is the **theoretical** mid; real Deribit asks include a bid-ask spread on top. " +
      "Trader-facing per-day rate must cover hedge cost + spread + platform margin. The chain " +
      "validation below quantifies the spread component._"
  );
  lines.push("");

  // ── Live chain validation ──
  if (chain) {
    lines.push("## Live Deribit chain validation snapshot");
    lines.push("");
    lines.push(`**Captured at:** ${chain.capturedAt}`);
    lines.push(`**Spot:** ${formatUsd(chain.spotUsd, 0)}`);
    lines.push(`**DVOL now:** ${Number.isFinite(chain.dvolNow) ? chain.dvolNow.toFixed(2) : "n/a"}`);
    lines.push(`**Target expiry:** ${chain.expiry} (${chain.daysToExpiry.toFixed(2)} days)`);
    lines.push("");
    lines.push(
      "Per-strike comparison of BS-modeled premium against the live Deribit ask. " +
        "All money values normalized to **USD per option** (per BTC of underlying) " +
        "so the comparison is apples-to-apples. Deribit quotes options in BTC, so " +
        "ask-USD = ask-BTC × spot."
    );
    lines.push("");
    lines.push("| Strike | Type | Ask (BTC) | Ask (USD) | Mark IV % | BS @ DVOL (USD) | BS @ markIV (USD) | Live ask vs BS-DVOL | Live ask vs BS-markIV |");
    lines.push("|---|---|---|---|---|---|---|---|---|");
    for (const r of chain.rows) {
      const askBtcStr = r.askBtc === null ? "n/a" : r.askBtc.toFixed(4);
      const askUsdStr = r.askUsd === null ? "n/a" : formatUsd(r.askUsd, 2);
      const markIvStr = r.markIv === null ? "n/a" : r.markIv.toFixed(2);
      const bsDvolStr = r.bsAtDvolUsd === null ? "n/a" : formatUsd(r.bsAtDvolUsd, 2);
      const bsMarkStr = r.bsAtMarkIvUsd === null ? "n/a" : formatUsd(r.bsAtMarkIvUsd, 2);
      const spreadDvol =
        r.askUsd !== null && r.bsAtDvolUsd !== null && r.bsAtDvolUsd > 0
          ? `${(((r.askUsd - r.bsAtDvolUsd) / r.bsAtDvolUsd) * 100).toFixed(1)}%`
          : "n/a";
      const spreadMark =
        r.askUsd !== null && r.bsAtMarkIvUsd !== null && r.bsAtMarkIvUsd > 0
          ? `${(((r.askUsd - r.bsAtMarkIvUsd) / r.bsAtMarkIvUsd) * 100).toFixed(1)}%`
          : "n/a";
      lines.push(
        `| ${r.strike.toLocaleString()} | ${r.type} | ${askBtcStr} | ${askUsdStr} | ${markIvStr} | ${bsDvolStr} | ${bsMarkStr} | ${spreadDvol} | ${spreadMark} |`
      );
    }
    lines.push("");
    lines.push(
      "_Live-ask-vs-BS-DVOL columns: positive means the live Deribit ask is **above** the " +
        "BS price using DVOL as sigma. That delta combines two effects: (a) the IV smile/skew " +
        "(strike-specific IVs differ from the DVOL index), and (b) the bid-ask spread on top " +
        "of mid. The Live-ask-vs-BS-markIV column controls for (a), so what's left is (b) — " +
        "the actual liquidity cost we'd pay buying at the ask vs fair value._"
    );
    lines.push("");
    // Summarize the typical spread for the operator
    const spreadsVsMark: number[] = [];
    for (const r of chain.rows) {
      if (r.askUsd !== null && r.bsAtMarkIvUsd !== null && r.bsAtMarkIvUsd > 0) {
        spreadsVsMark.push(((r.askUsd - r.bsAtMarkIvUsd) / r.bsAtMarkIvUsd) * 100);
      }
    }
    if (spreadsVsMark.length > 0) {
      const median = percentile(spreadsVsMark, 50);
      const p90 = percentile(spreadsVsMark, 90);
      lines.push(
        `**Spread summary (live ask vs BS @ markIV):** median ${median.toFixed(1)}%, p90 ${p90.toFixed(1)}%. ` +
          `For trader pricing, inflate the BS-modeled hedge cost by roughly ${median.toFixed(0)}% to estimate the actual ` +
          `cost of buying at market on this expiry.`
      );
      lines.push("");
    }
  } else {
    lines.push("## Live Deribit chain validation snapshot");
    lines.push("");
    lines.push("_Skipped (--skip-live-validation set, or fetch failed; see logs)._");
    lines.push("");
  }

  // ── Read footer ──
  lines.push("---");
  lines.push("");
  lines.push("## Notes for D2 (trigger-replay backtest)");
  lines.push("");
  lines.push(
    "1. The per-day BS-modeled costs above are the **floor** for what trader pricing has to clear — actual hedge cost is BS + spread + slippage."
  );
  lines.push(
    "2. For D2 we'll replay the 16 historical triggers using these per-day costs as the hypothetical hedge cost, computing recovery at trigger fire from the same DVOL-as-sigma model. The live chain validation tells us how much to inflate the BS values to match real Deribit asks."
  );
  lines.push(
    "3. The **upfront cost column** matters because it's the capital tied up per trade — feeds D4 (capital requirements model)."
  );
  lines.push(
    "4. Don't draw conclusions about trader pricing from this dataset alone. Pricing model proposal (D3) layers in target gross margin, regime-spike protection, and early-close handling on top of the cost numbers here."
  );
  lines.push("");
  return lines.join("\n");
};

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

const ensureDir = (path: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(path, { recursive: true });
};

const main = async (): Promise<void> => {
  log(`starting biweekly pricing calibration (days=${DAYS}, tenor=${TENOR_DAYS}d, out=${OUT_DIR})`);

  log("fetching DVOL hourly history from Deribit…");
  let dvol: DvolPoint[];
  try {
    dvol = await fetchDvolHistory(DAYS);
    log(`  → ${dvol.length} DVOL samples (first ${new Date(dvol[0]?.tsMs).toISOString()}, last ${new Date(dvol[dvol.length - 1]?.tsMs).toISOString()})`);
  } catch (e: any) {
    log(`ERROR: DVOL fetch failed: ${e?.message}`);
    process.exit(1);
  }

  log("fetching BTC-USD hourly spot from Coinbase…");
  let spot: SpotPoint[];
  try {
    spot = await fetchSpotHistory(DAYS);
    log(`  → ${spot.length} spot samples`);
  } catch (e: any) {
    log(`ERROR: spot fetch failed: ${e?.message}`);
    process.exit(1);
  }

  const joined = joinDvolWithSpot(dvol, spot);
  log(`joined ${joined.length} hourly observations (DVOL × spot)`);
  if (joined.length < 100) {
    log(`WARNING: only ${joined.length} joined samples — calibration may be unreliable`);
  }

  const cells = buildCells(joined, TENOR_DAYS);
  log(`built ${cells.length} (regime × tier × direction) cells`);

  let chain: ChainSnapshot | null = null;
  if (!SKIP_LIVE_VALIDATION) {
    log("fetching live Deribit chain snapshot for validation…");
    try {
      chain = await fetchLiveChain(TENOR_DAYS);
      log(`  → snapshot at ${chain.capturedAt}, expiry ${chain.expiry} (${chain.daysToExpiry.toFixed(2)} days), ${chain.rows.length} strikes`);
    } catch (e: any) {
      log(`WARNING: live chain validation failed: ${e?.message}. Continuing without it.`);
    }
  } else {
    log("--skip-live-validation set; skipping chain snapshot");
  }

  ensureDir(OUT_DIR);
  const capturedAt = new Date().toISOString();
  const datasetPath = join(OUT_DIR, "biweekly_pricing_dataset.json");
  const reportPath = join(OUT_DIR, "biweekly_pricing_dataset.md");
  const chainPath = join(OUT_DIR, "biweekly_chain_snapshot.json");

  const dataset = {
    capturedAt,
    inputs: { days: DAYS, tenorDays: TENOR_DAYS },
    sampleCount: joined.length,
    regimeBands: REGIME_BANDS,
    cells
  };
  writeFileSync(datasetPath, JSON.stringify(dataset, null, 2) + "\n");
  log(`wrote ${datasetPath}`);

  if (chain) {
    writeFileSync(chainPath, JSON.stringify(chain, null, 2) + "\n");
    log(`wrote ${chainPath}`);
  }

  const md = renderMarkdown({ days: DAYS, tenorDays: TENOR_DAYS, capturedAt, joined, cells, chain });
  writeFileSync(reportPath, md);
  log(`wrote ${reportPath}`);

  log("done.");
};

main().catch((e) => {
  log(`fatal: ${e?.message ?? e}`);
  process.exit(1);
});
