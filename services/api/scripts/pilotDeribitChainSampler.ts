/**
 * pilotDeribitChainSampler.ts — Phase 2 of the 1-day-tenor investigation.
 *
 * Empirical answer to: "for each pilot SL tier, is there a 1-day put/call at the
 * trigger band when we need it, at what cost, and with what spread?"
 *
 * Read-only. Mainnet Deribit public API only (no auth). Each invocation produces
 * one snapshot. Designed to be run on a schedule (e.g. every 4-6 hours via a
 * GitHub Action) for ~7 days.
 *
 * Per snapshot:
 *  - Pull live BTC spot (Deribit index price + cross-check with Coinbase).
 *  - Pull DVOL.
 *  - Pull all unexpired BTC option instruments.
 *  - For each SL tier (2 / 3 / 5 / 10) and each protection type (long → put,
 *    short → call):
 *      * Compute the trigger price.
 *      * Identify the in-band candidate (1d expiry within ±0.5% of trigger).
 *      * Identify the next-best fallback in the [12h, 3d] window.
 *      * Pull order book for both (best bid, best ask, mark, IV per Deribit's
 *        get_order_book) — this also feeds the put-skew analysis used in Phase 1.
 *  - Capture per-strike IV near ATM for the skew curve.
 *  - Write a single JSON file under artifacts/chain-samples/<UTC-timestamp>.json
 *    (no overwrite). Optionally also append a one-line CSV row for spreadsheet use.
 *
 * Usage:
 *   npx tsx services/api/scripts/pilotDeribitChainSampler.ts
 *   npx tsx services/api/scripts/pilotDeribitChainSampler.ts --out-dir artifacts/chain-samples
 *   npx tsx services/api/scripts/pilotDeribitChainSampler.ts --no-write
 *   npx tsx services/api/scripts/pilotDeribitChainSampler.ts --skew-strikes 11
 *
 * Exit codes:
 *   0 — success (snapshot written)
 *   1 — fatal fetch failure (e.g. Deribit unreachable for spot)
 */

import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

// ─── Config ─────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../../..");
const DERIBIT_BASE = "https://www.deribit.com/api/v2/public";
const COINBASE_TICKER = "https://api.exchange.coinbase.com/products/BTC-USD/ticker";

const SL_TIERS = [
  { slPct: 0.02, label: "2%" },
  { slPct: 0.03, label: "3%" },
  { slPct: 0.05, label: "5%" },
  { slPct: 0.10, label: "10%" }
] as const;

const STRIKE_BUFFER_PCT = 0.005;          // ±0.5% of spot, mirrors venue.ts
const TENOR_TARGET_DAYS = 1;
const TENOR_MIN_HOURS = 12;
const TENOR_MAX_DAYS = 3;
const FETCH_TIMEOUT_MS = 12000;
const MAX_PARALLEL_BOOKS = 6;

type CliArgs = {
  outDir: string;
  noWrite: boolean;
  skewStrikes: number;
  appendCsv: boolean;
  csvPath: string;
};

const parseArgs = (argv: string[]): CliArgs => {
  const args: CliArgs = {
    outDir: path.join(REPO_ROOT, "artifacts/chain-samples"),
    noWrite: false,
    skewStrikes: 11,
    appendCsv: true,
    csvPath: path.join(REPO_ROOT, "artifacts/chain-samples/index.csv")
  };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === "--out-dir" && argv[i + 1]) { args.outDir = path.resolve(argv[++i]); }
    else if (tok === "--no-write") args.noWrite = true;
    else if (tok === "--no-csv") args.appendCsv = false;
    else if (tok === "--csv-path" && argv[i + 1]) { args.csvPath = path.resolve(argv[++i]); }
    else if (tok === "--skew-strikes" && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      if (Number.isFinite(n) && n > 0 && n < 100) args.skewStrikes = n;
    }
  }
  return args;
};

// ─── HTTP helpers ───────────────────────────────────────────────────────────

const fetchJson = async <T = unknown>(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<T> => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "atticus-chain-sampler/1.0" } });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { throw new Error(`non-json (${res.status}): ${text.slice(0, 120)}`); }
    if (!res.ok) throw new Error(`http_${res.status}: ${json?.error?.message || json?.message || text.slice(0, 120)}`);
    return json as T;
  } finally {
    clearTimeout(timer);
  }
};

// ─── Deribit fetchers ───────────────────────────────────────────────────────

type DeribitInstrument = {
  instrument_name: string;
  expiration_timestamp: number;
  strike: number;
  option_type?: "put" | "call";
};

type DeribitBook = {
  instrument_name: string;
  best_bid_price: number | null;
  best_ask_price: number | null;
  best_bid_amount: number | null;
  best_ask_amount: number | null;
  mark_price: number | null;
  mark_iv: number | null;
  underlying_price: number | null;
};

const fetchSpot = async (): Promise<{ deribitIndex: number | null; coinbaseSpot: number | null; deltaPct: number | null; }> => {
  const out = { deribitIndex: null as number | null, coinbaseSpot: null as number | null, deltaPct: null as number | null };
  try {
    const res = await fetchJson<{ result: { index_price: number } }>(`${DERIBIT_BASE}/get_index_price?index_name=btc_usd`);
    out.deribitIndex = Number(res?.result?.index_price ?? NaN);
  } catch (e: any) { console.warn(`[chain-sampler] deribit index price failed: ${e?.message}`); }
  try {
    const res = await fetchJson<{ price?: string }>(COINBASE_TICKER);
    const p = Number(res?.price ?? NaN);
    if (Number.isFinite(p) && p > 0) out.coinbaseSpot = p;
  } catch (e: any) { console.warn(`[chain-sampler] coinbase spot failed: ${e?.message}`); }
  if (out.deribitIndex && out.coinbaseSpot && out.deribitIndex > 0) {
    out.deltaPct = ((out.coinbaseSpot - out.deribitIndex) / out.deribitIndex) * 100;
  }
  return out;
};

const fetchDvol = async (): Promise<number | null> => {
  try {
    const res = await fetchJson<{ result: number | { last_price?: number } }>(`${DERIBIT_BASE}/get_volatility_index_data?currency=BTC&end_timestamp=${Date.now()}&start_timestamp=${Date.now() - 3600000}&resolution=60`);
    // Deribit returns { result: { data: [[ts, open, high, low, close], ...], continuation: ... } }
    const data = (res as any)?.result?.data;
    if (Array.isArray(data) && data.length > 0) {
      const last = data[data.length - 1];
      if (Array.isArray(last) && Number.isFinite(Number(last[4]))) return Number(last[4]);
    }
  } catch (e: any) { console.warn(`[chain-sampler] dvol fetch failed: ${e?.message}`); }
  return null;
};

const fetchInstruments = async (): Promise<DeribitInstrument[]> => {
  const res = await fetchJson<{ result: any[] }>(`${DERIBIT_BASE}/get_instruments?currency=BTC&kind=option&expired=false`);
  if (!Array.isArray(res?.result)) return [];
  return res.result
    .map((r: any) => ({
      instrument_name: String(r.instrument_name || ""),
      expiration_timestamp: Number(r.expiration_timestamp || 0),
      strike: Number(r.strike || 0),
      option_type: r.option_type === "call" ? "call" : "put"
    } as DeribitInstrument))
    .filter((r) => r.instrument_name && r.strike > 0 && r.expiration_timestamp > 0);
};

const fetchBook = async (instrumentName: string): Promise<DeribitBook | null> => {
  try {
    const res = await fetchJson<{ result: any }>(`${DERIBIT_BASE}/get_order_book?instrument_name=${encodeURIComponent(instrumentName)}`);
    const r = res?.result;
    if (!r) return null;
    return {
      instrument_name: String(r.instrument_name || instrumentName),
      best_bid_price: r.best_bid_price ?? null,
      best_ask_price: r.best_ask_price ?? null,
      best_bid_amount: r.best_bid_amount ?? null,
      best_ask_amount: r.best_ask_amount ?? null,
      mark_price: r.mark_price ?? null,
      mark_iv: r.mark_iv ?? null,
      underlying_price: r.underlying_price ?? null
    };
  } catch (e: any) {
    console.warn(`[chain-sampler] book fetch failed for ${instrumentName}: ${e?.message}`);
    return null;
  }
};

// Limited concurrency map
const mapConcurrent = async <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(limit, items.length); w += 1) {
    workers.push((async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= items.length) return;
        results[idx] = await fn(items[idx]);
      }
    })());
  }
  await Promise.all(workers);
  return results;
};

// ─── Selection logic mirroring venue.ts ─────────────────────────────────────

type PerTierResult = {
  slPct: number;
  protectionType: "long" | "short";
  optionType: "put" | "call";
  triggerPrice: number;
  triggerBandLow: number;
  triggerBandHigh: number;
  inBandCandidates: Array<{
    instrument: string;
    strike: number;
    expiryTs: number;
    daysToExpiry: number;
    book: DeribitBook | null;
    askUsd: number | null;
    bidUsd: number | null;
    spreadBps: number | null;
    markUsd: number | null;
  }>;
  inBand1dCandidate: string | null;     // Best 1d candidate in band (if any)
  fallbackCandidate: string | null;     // Best candidate in [12h, 3d] when 1d in-band is missing
  fallbackDaysToExpiry: number | null;
};

const selectFor = (
  tier: { slPct: number; label: string },
  protectionType: "long" | "short",
  spot: number,
  instruments: DeribitInstrument[],
  nowMs: number
): { triggerPrice: number; triggerBandLow: number; triggerBandHigh: number; inBand: DeribitInstrument[]; fallback: DeribitInstrument | null; optionType: "put" | "call"; } => {
  const optionType = protectionType === "short" ? "call" : "put";
  const triggerPrice = protectionType === "short" ? spot * (1 + tier.slPct) : spot * (1 - tier.slPct);
  const buffer = spot * STRIKE_BUFFER_PCT;
  const triggerBandLow = triggerPrice - buffer;
  const triggerBandHigh = triggerPrice + buffer;

  const minExpiry = nowMs + Math.max(TENOR_MIN_HOURS * 3600 * 1000, TENOR_TARGET_DAYS * 0.5 * 86400 * 1000);
  const maxExpiry = nowMs + (TENOR_TARGET_DAYS + 2) * 86400 * 1000;
  const targetExpiry = nowMs + TENOR_TARGET_DAYS * 86400 * 1000;

  // Filter to right type, in time window, and matching trigger-band rule from venue.ts:
  // For puts:  strike <= triggerPrice + buffer
  // For calls: strike >= triggerPrice - buffer
  const candidates = instruments
    .filter((i) => i.option_type === optionType)
    .filter((i) => i.expiration_timestamp > minExpiry && i.expiration_timestamp < maxExpiry)
    .filter((i) => optionType === "put"
      ? i.strike <= triggerPrice + buffer
      : i.strike >= triggerPrice - buffer);

  const inBand = candidates.filter((i) => i.strike >= triggerBandLow && i.strike <= triggerBandHigh);

  // Sort all candidates by the same asymmetric tenor + strike-distance rule
  const sortKey = (i: DeribitInstrument): number => {
    const rawTenor = (i.expiration_timestamp - targetExpiry) / 86400000;
    const tenorPen = rawTenor < 0 ? Math.abs(rawTenor) * 3 : rawTenor;
    return tenorPen + Math.abs(i.strike - triggerPrice) / Math.max(spot, 1);
  };
  const sorted = candidates.slice().sort((a, b) => sortKey(a) - sortKey(b));
  const fallback = sorted.length > 0 ? sorted[0] : null;

  return { triggerPrice, triggerBandLow, triggerBandHigh, inBand, fallback, optionType };
};

const isApprox1d = (instrument: DeribitInstrument, nowMs: number): boolean => {
  const days = (instrument.expiration_timestamp - nowMs) / 86400000;
  return days >= 0.5 && days <= 1.5;
};

const usdFromBtcAsk = (askBtc: number | null, underlying: number | null, spot: number): number | null => {
  if (askBtc === null || !Number.isFinite(askBtc)) return null;
  const px = underlying && underlying > 0 ? underlying : spot;
  if (!(px > 0)) return null;
  return askBtc * px;
};

const spreadBps = (bid: number | null, ask: number | null): number | null => {
  if (bid === null || ask === null || bid <= 0 || ask <= 0) return null;
  const mid = (bid + ask) / 2;
  if (mid <= 0) return null;
  return ((ask - bid) / mid) * 10000;
};

// ─── Skew snapshot ──────────────────────────────────────────────────────────

type SkewSnapshot = {
  expiryTs: number;
  daysToExpiry: number;
  strikes: Array<{ instrument: string; strike: number; markIv: number | null; bidUsd: number | null; askUsd: number | null; }>;
};

const buildSkew = async (
  instruments: DeribitInstrument[],
  spot: number,
  nowMs: number,
  skewStrikes: number
): Promise<SkewSnapshot | null> => {
  const minExpiry = nowMs + TENOR_MIN_HOURS * 3600 * 1000;
  const maxExpiry = nowMs + TENOR_MAX_DAYS * 86400 * 1000;
  const puts = instruments
    .filter((i) => i.option_type === "put")
    .filter((i) => i.expiration_timestamp > minExpiry && i.expiration_timestamp < maxExpiry);
  if (puts.length === 0) return null;
  // Pick the expiry closest to 1 day
  const target = nowMs + 86400 * 1000;
  const expiries = Array.from(new Set(puts.map((p) => p.expiration_timestamp)))
    .sort((a, b) => Math.abs(a - target) - Math.abs(b - target));
  if (expiries.length === 0) return null;
  const chosenExpiry = expiries[0];
  const sameExpiry = puts.filter((p) => p.expiration_timestamp === chosenExpiry);
  // Pick `skewStrikes` strikes centered on spot
  sameExpiry.sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
  const top = sameExpiry.slice(0, skewStrikes);
  // Re-sort by strike ascending for output
  top.sort((a, b) => a.strike - b.strike);
  const books = await mapConcurrent(top, MAX_PARALLEL_BOOKS, async (i) => fetchBook(i.instrument_name));
  return {
    expiryTs: chosenExpiry,
    daysToExpiry: (chosenExpiry - nowMs) / 86400000,
    strikes: top.map((i, idx) => ({
      instrument: i.instrument_name,
      strike: i.strike,
      markIv: books[idx]?.mark_iv ?? null,
      bidUsd: usdFromBtcAsk(books[idx]?.best_bid_price ?? null, books[idx]?.underlying_price ?? null, spot),
      askUsd: usdFromBtcAsk(books[idx]?.best_ask_price ?? null, books[idx]?.underlying_price ?? null, spot)
    }))
  };
};

// ─── Main ───────────────────────────────────────────────────────────────────

type SnapshotEnvelope = {
  schema: "atticus.deribit.chain-sample.v1";
  timestamp: string;
  source: { deribit: string; coinbase: string };
  spot: { deribitIndex: number | null; coinbaseSpot: number | null; deltaPct: number | null };
  dvol: number | null;
  instrumentsScanned: number;
  perTier: PerTierResult[];
  skew: SkewSnapshot | null;
  fetchErrors: string[];
  durationMs: number;
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  const fetchErrors: string[] = [];

  console.log(`[chain-sampler] starting at ${new Date().toISOString()}`);
  const spot = await fetchSpot();
  if (!spot.deribitIndex && !spot.coinbaseSpot) {
    throw new Error("no_spot_available_from_either_source");
  }
  const usableSpot = spot.deribitIndex || spot.coinbaseSpot!;
  console.log(`[chain-sampler] spot: deribit=${spot.deribitIndex} coinbase=${spot.coinbaseSpot} delta=${spot.deltaPct?.toFixed(3) ?? "—"}%`);

  const dvol = await fetchDvol();
  if (dvol === null) fetchErrors.push("dvol_unavailable");
  console.log(`[chain-sampler] dvol: ${dvol ?? "—"}`);

  const instruments = await fetchInstruments();
  console.log(`[chain-sampler] instruments scanned: ${instruments.length}`);

  const nowMs = Date.now();
  const perTier: PerTierResult[] = [];

  for (const tier of SL_TIERS) {
    for (const protectionType of ["long", "short"] as const) {
      const sel = selectFor(tier, protectionType, usableSpot, instruments, nowMs);
      const inBandWith1d = sel.inBand.filter((i) => isApprox1d(i, nowMs));

      // Fetch books for in-band candidates
      const books = await mapConcurrent(sel.inBand, MAX_PARALLEL_BOOKS, async (i) => fetchBook(i.instrument_name));
      const inBandCandidates = sel.inBand.map((i, idx) => {
        const b = books[idx];
        const askUsd = usdFromBtcAsk(b?.best_ask_price ?? null, b?.underlying_price ?? null, usableSpot);
        const bidUsd = usdFromBtcAsk(b?.best_bid_price ?? null, b?.underlying_price ?? null, usableSpot);
        const markUsd = usdFromBtcAsk(b?.mark_price ?? null, b?.underlying_price ?? null, usableSpot);
        return {
          instrument: i.instrument_name,
          strike: i.strike,
          expiryTs: i.expiration_timestamp,
          daysToExpiry: (i.expiration_timestamp - nowMs) / 86400000,
          book: b,
          askUsd,
          bidUsd,
          spreadBps: spreadBps(bidUsd, askUsd),
          markUsd
        };
      });

      // Pick the best 1d in-band by ask, if any
      const ranked1d = inBandCandidates
        .filter((c) => c.daysToExpiry >= 0.5 && c.daysToExpiry <= 1.5 && c.askUsd && c.askUsd > 0)
        .sort((a, b) => (a.askUsd || Infinity) - (b.askUsd || Infinity));
      const best1d = ranked1d[0]?.instrument ?? null;

      // Fallback (overall sorted winner from selectFor) — already computed
      let fallbackName: string | null = null;
      let fallbackDays: number | null = null;
      if (sel.fallback) {
        fallbackName = sel.fallback.instrument_name;
        fallbackDays = (sel.fallback.expiration_timestamp - nowMs) / 86400000;
      }

      perTier.push({
        slPct: tier.slPct,
        protectionType,
        optionType: sel.optionType,
        triggerPrice: sel.triggerPrice,
        triggerBandLow: sel.triggerBandLow,
        triggerBandHigh: sel.triggerBandHigh,
        inBandCandidates,
        inBand1dCandidate: best1d,
        fallbackCandidate: fallbackName,
        fallbackDaysToExpiry: fallbackDays
      });

      console.log(`[chain-sampler] tier=${tier.label} ${protectionType} ${sel.optionType} trigger=$${sel.triggerPrice.toFixed(0)} inBand=${sel.inBand.length} inBand1d=${inBandWith1d.length} best1d=${best1d || "—"} fallback=${fallbackName || "—"} fallbackDays=${fallbackDays?.toFixed(2) ?? "—"}`);
    }
  }

  console.log("[chain-sampler] building put-skew snapshot...");
  const skew = await buildSkew(instruments, usableSpot, nowMs, args.skewStrikes);
  if (!skew) fetchErrors.push("skew_unavailable");

  const env: SnapshotEnvelope = {
    schema: "atticus.deribit.chain-sample.v1",
    timestamp: new Date().toISOString(),
    source: { deribit: DERIBIT_BASE, coinbase: COINBASE_TICKER },
    spot,
    dvol,
    instrumentsScanned: instruments.length,
    perTier,
    skew,
    fetchErrors,
    durationMs: Date.now() - t0
  };

  if (args.noWrite) {
    console.log(`[chain-sampler] DRY RUN — not writing snapshot. Summary:`);
    console.log(JSON.stringify({
      timestamp: env.timestamp,
      spot: env.spot,
      dvol: env.dvol,
      instrumentsScanned: env.instrumentsScanned,
      perTierSummary: perTier.map((t) => ({
        tier: t.slPct, protectionType: t.protectionType,
        inBand1d: t.inBand1dCandidate, fallback: t.fallbackCandidate,
        fallbackDays: t.fallbackDaysToExpiry
      })),
      skewExpiryTs: skew?.expiryTs ?? null,
      skewStrikes: skew?.strikes.length ?? 0,
      fetchErrors,
      durationMs: env.durationMs
    }, null, 2));
    return;
  }

  if (!existsSync(args.outDir)) {
    await mkdir(args.outDir, { recursive: true });
  }
  const stamp = env.timestamp.replace(/[:.]/g, "-");
  const outFile = path.join(args.outDir, `${stamp}.json`);
  await writeFile(outFile, JSON.stringify(env, null, 2), "utf8");
  console.log(`[chain-sampler] snapshot written: ${path.relative(REPO_ROOT, outFile)}`);

  if (args.appendCsv) {
    const headerNeeded = !existsSync(args.csvPath);
    const cols = ["timestamp", "spotDeribit", "spotCoinbase", "dvol", "instrumentsScanned"] as const;
    const tierCols = SL_TIERS.flatMap((t) =>
      ["long", "short"].flatMap((pt) => [
        `tier${t.label}_${pt}_inBand1d`,
        `tier${t.label}_${pt}_fallback`,
        `tier${t.label}_${pt}_fallbackDays`
      ])
    );
    const rowObj: Record<string, string | number> = {
      timestamp: env.timestamp,
      spotDeribit: env.spot.deribitIndex ?? "",
      spotCoinbase: env.spot.coinbaseSpot ?? "",
      dvol: env.dvol ?? "",
      instrumentsScanned: env.instrumentsScanned
    };
    for (const t of SL_TIERS) {
      for (const pt of ["long", "short"] as const) {
        const found = perTier.find((p) => p.slPct === t.slPct && p.protectionType === pt);
        rowObj[`tier${t.label}_${pt}_inBand1d`] = found?.inBand1dCandidate ?? "";
        rowObj[`tier${t.label}_${pt}_fallback`] = found?.fallbackCandidate ?? "";
        rowObj[`tier${t.label}_${pt}_fallbackDays`] = found?.fallbackDaysToExpiry?.toFixed(3) ?? "";
      }
    }
    const allCols = [...cols, ...tierCols];
    let body = "";
    if (headerNeeded) body += allCols.join(",") + "\n";
    body += allCols.map((c) => String(rowObj[c] ?? "").replace(/,/g, ";")).join(",") + "\n";
    if (!existsSync(path.dirname(args.csvPath))) await mkdir(path.dirname(args.csvPath), { recursive: true });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(args.csvPath, body, "utf8");
    console.log(`[chain-sampler] appended index row: ${path.relative(REPO_ROOT, args.csvPath)}`);
  }

  console.log(`[chain-sampler] done in ${env.durationMs}ms`);
};

main().catch((err) => {
  console.error(`[chain-sampler] FATAL: ${err?.message || err}`);
  if (err?.stack) console.error(err.stack);
  process.exitCode = 1;
});
