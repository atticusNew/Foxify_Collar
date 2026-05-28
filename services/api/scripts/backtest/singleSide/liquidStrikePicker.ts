/**
 * Liquid strike picker — fixes the V3 probe's "pick exact match, even if illiquid" bug.
 *
 * Given a target strike, option type, and tenor, scans the Deribit chain for
 * all strikes within ±tolerance and picks the one with:
 *   1. Best spread (tightest bid-ask % of mid)
 *   2. Reasonable IV (not orphaned/stale quote)
 *   3. Minimum depth
 *
 * Returns the picked instrument's live ask. Caller can compare to naive
 * exact-strike-match to quantify the improvement.
 *
 * Output: when called as main, runs against the Phase 0 strikes and prints
 * naive vs liquid picks side-by-side.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export type DeribitInstrument = {
  instrument_name: string;
  option_type: "put" | "call";
  strike: number;
  expiration_timestamp: number;
};

/**
 * Venue-agnostic option quote. `venue` field distinguishes the source.
 * (Type name kept as DeribitQuote for backward compat with standalone scripts;
 * field set is venue-neutral.)
 */
export type DeribitQuote = {
  instrument_name: string;
  strike: number;
  optType: "put" | "call";
  tenorHours: number;
  bidUsdcPerBtc: number;
  askUsdcPerBtc: number;
  midUsdcPerBtc: number;
  spreadPct: number;
  markIv: number;
  askIv: number | null;
  underlyingPrice: number;
  venue: "deribit" | "bullish";
};

export type PickerConfig = {
  /** ±USD tolerance around target strike (default $3,000) */
  strikeToleranceUsdc: number;
  /** ±days tolerance around target tenor (default 0.3) */
  tenorToleranceDays: number;
  /** Max acceptable spread as % of mid (default 0.30 = 30%) */
  maxSpreadPct: number;
  /** Min mid price in USDC (default 5 — filters dust quotes) */
  minMidUsdc: number;
  /** Reject if ask_iv > X * mark_iv (default 2.0 — flags broken quotes) */
  maxIvSpreadRatio: number;
  /**
   * Preserve moneyness side relative to spot.
   * If true, ITM target stays ITM, OTM stays OTM (won't shift across spot).
   * Default true — otherwise picker may make cheap-but-wrong-product picks.
   */
  preserveMoneynessSide: boolean;
};

export const DEFAULT_PICKER_CONFIG: PickerConfig = {
  strikeToleranceUsdc: 3_000,
  // ±1.5 days tolerance to handle expiry-calendar drift.
  // Deribit has daily expiries at 08:00 UTC. Cells targeting a 3d tenor will,
  // depending on the time of day, see the nearest expiry land anywhere from
  // ~2d to ~3.5d away. ±0.3d was too tight — caused the picker to return null
  // between roughly 14:00-24:00 UTC each day, silently breaking activations.
  // ±1.5d gives us the full daily-expiry window without crossing weekly
  // boundaries (weekly expiries are 7 days apart).
  tenorToleranceDays: 1.5,
  maxSpreadPct: 0.30,
  minMidUsdc: 5,
  maxIvSpreadRatio: 2.0,
  preserveMoneynessSide: true
};

const fetchJson = async <T>(url: string, timeoutMs = 8_000): Promise<T> => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as T;
  } finally { clearTimeout(t); }
};

/**
 * Fetch the full BTC option chain with bid/ask quotes for everything.
 * Returns DeribitQuote[] filtered to options with valid quotes.
 */
export const fetchFullChainSnapshot = async (now = Date.now()): Promise<{ spot: number; quotes: DeribitQuote[] }> => {
  const idx = await fetchJson<{ result: { index_price: number } }>(
    "https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd"
  );
  const spot = idx.result.index_price;

  type BookSummary = {
    instrument_name: string;
    bid_price: number | null;
    ask_price: number | null;
    mark_iv: number;
    underlying_price: number;
  };
  const sumRes = await fetchJson<{ result: BookSummary[] }>(
    "https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option"
  );
  const quotes: DeribitQuote[] = [];
  for (const s of sumRes.result) {
    if (s.bid_price == null || s.ask_price == null) continue;
    if (s.bid_price <= 0 || s.ask_price <= 0) continue;
    const m = s.instrument_name.match(/^BTC-(\d{1,2})([A-Z]{3})(\d{2})-(\d+)-([PC])$/);
    if (!m) continue;
    const day = Number(m[1]);
    const mon = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"].indexOf(m[2]);
    const yr = 2000 + Number(m[3]);
    const expiry = Date.UTC(yr, mon, day, 8, 0, 0);
    const tenorHours = (expiry - now) / 3_600_000;
    if (tenorHours <= 0) continue;
    const midBtc = (s.bid_price + s.ask_price) / 2;
    const midUsdc = midBtc * s.underlying_price;
    if (midUsdc <= 0) continue;
    quotes.push({
      instrument_name: s.instrument_name,
      strike: Number(m[4]),
      optType: m[5] === "P" ? "put" : "call",
      tenorHours,
      bidUsdcPerBtc: s.bid_price * s.underlying_price,
      askUsdcPerBtc: s.ask_price * s.underlying_price,
      midUsdcPerBtc: midUsdc,
      spreadPct: (s.ask_price - s.bid_price) / midBtc,
      markIv: s.mark_iv,
      askIv: null,
      underlyingPrice: s.underlying_price,
      venue: "deribit"
    });
  }
  return { spot, quotes };
};

/**
 * Merge multiple per-venue chain snapshots into one. Quotes are kept separate
 * (one VenueQuote per (venue, strike, type) tuple). pickLiquidStrike will then
 * choose the best across all venues per strike+type pair.
 */
export const mergeChainSnapshots = (snapshots: Array<{ spot: number; quotes: DeribitQuote[] } | null>): { spot: number; quotes: DeribitQuote[] } => {
  const valid = snapshots.filter((s): s is { spot: number; quotes: DeribitQuote[] } => s != null);
  if (valid.length === 0) return { spot: 0, quotes: [] };
  // Use median spot across venues as canonical (defends against one source being stale)
  const spots = valid.map((s) => s.spot).sort((a, b) => a - b);
  const spot = spots[Math.floor(spots.length / 2)];
  const quotes = valid.flatMap((s) => s.quotes);
  return { spot, quotes };
};

export type PickResult = {
  picked: DeribitQuote | null;
  rejected: Array<{ quote: DeribitQuote; reason: string }>;
  candidates: DeribitQuote[];
  picker: "exact_strike" | "best_spread" | "fallback";
};

/**
 * Pick the most-liquid instrument near (targetStrike, targetTenorDays) for optType.
 * Optionally constrained to same moneyness side relative to spot.
 */
export const pickLiquidStrike = (
  chain: DeribitQuote[],
  targetStrike: number,
  targetTenorDays: number,
  optType: "put" | "call",
  spot: number,
  config: PickerConfig = DEFAULT_PICKER_CONFIG
): PickResult => {
  const targetTenorHours = targetTenorDays * 24;
  // Moneyness sign: for puts, > spot = ITM. For calls, < spot = ITM.
  // Sign of (strike - spot) tells us ITM/OTM side per type:
  //   put: strike > spot → positive diff → ITM (sign +)
  //        strike < spot → negative diff → OTM (sign -)
  //   call: strike > spot → positive diff → OTM (sign +)
  //        strike < spot → negative diff → ITM (sign -)
  const targetSideSign = Math.sign(targetStrike - spot);
  const sameSide = (strike: number): boolean => {
    if (!config.preserveMoneynessSide) return true;
    if (targetSideSign === 0) return true;
    const sign = Math.sign(strike - spot);
    return sign === targetSideSign || sign === 0;
  };

  const inWindow = chain.filter((q) =>
    q.optType === optType &&
    Math.abs(q.strike - targetStrike) <= config.strikeToleranceUsdc &&
    Math.abs(q.tenorHours - targetTenorHours) <= config.tenorToleranceDays * 24 &&
    sameSide(q.strike)
  );

  if (inWindow.length === 0) {
    return { picked: null, rejected: [], candidates: [], picker: "fallback" };
  }

  // Filter for tradability
  const rejected: Array<{ quote: DeribitQuote; reason: string }> = [];
  const tradable: DeribitQuote[] = [];
  for (const q of inWindow) {
    if (q.spreadPct > config.maxSpreadPct) {
      rejected.push({ quote: q, reason: `spread ${(q.spreadPct * 100).toFixed(1)}% > max ${(config.maxSpreadPct * 100).toFixed(0)}%` });
      continue;
    }
    if (q.midUsdcPerBtc < config.minMidUsdc) {
      rejected.push({ quote: q, reason: `mid \$${q.midUsdcPerBtc.toFixed(2)} < min \$${config.minMidUsdc}` });
      continue;
    }
    if (q.askIv != null && q.markIv > 0 && q.askIv > config.maxIvSpreadRatio * q.markIv) {
      rejected.push({ quote: q, reason: `ask_iv ${q.askIv.toFixed(0)} > ${config.maxIvSpreadRatio}× mark_iv ${q.markIv.toFixed(0)}` });
      continue;
    }
    tradable.push(q);
  }

  if (tradable.length === 0) {
    // All in-window are illiquid. Fall back to the lowest-ask (least cost) regardless of spread.
    const best = [...inWindow].sort((a, b) => a.askUsdcPerBtc - b.askUsdcPerBtc)[0];
    return { picked: best, rejected, candidates: inWindow, picker: "fallback" };
  }

  // If both venues have the same strike, dedupe to the cheaper ask (proper venue routing).
  // We compute "venue winner" per strike: lowest ask among tradable instruments at this strike.
  type StrikeKey = number;
  const bestPerStrike = new Map<StrikeKey, DeribitQuote>();
  for (const q of tradable) {
    const existing = bestPerStrike.get(q.strike);
    if (!existing || q.askUsdcPerBtc < existing.askUsdcPerBtc) {
      bestPerStrike.set(q.strike, q);
    }
  }
  const venueRoutedTradable = [...bestPerStrike.values()];

  // Now pick across strikes. Prefer:
  //   1. Exact-strike match (honor cell geometry)
  //   2. Lowest ask × spread composite for non-exact
  const exact = venueRoutedTradable.find((q) => q.strike === targetStrike);
  if (exact) return { picked: exact, rejected, candidates: venueRoutedTradable, picker: "exact_strike" };

  // Composite: ask cost (heavier weight) + spread + strike distance
  const ranked = [...venueRoutedTradable].sort((a, b) => {
    const scoreA = a.askUsdcPerBtc + a.spreadPct * 1_000 + Math.abs(a.strike - targetStrike) / 2;
    const scoreB = b.askUsdcPerBtc + b.spreadPct * 1_000 + Math.abs(b.strike - targetStrike) / 2;
    return scoreA - scoreB;
  });
  return { picked: ranked[0], rejected, candidates: venueRoutedTradable, picker: "best_spread" };
};

// =============================================================================
// Main: probe Phase 0 strikes with naive vs liquid picker, write report
// =============================================================================

const PHASE_0_PROBES = [
  { cellId: "pair_50k_2pct_itm", tenorDays: 3, putItmPct: 0.013, callItmPct: 0.013, contractsBtc: 1.4 },
  { cellId: "pair_25k_5pct_otm_3d", tenorDays: 3, putItmPct: -0.020, callItmPct: -0.025, contractsBtc: 0.5 },
  { cellId: "pair_25k_5pct_otm_short", tenorDays: 1, putItmPct: -0.020, callItmPct: -0.025, contractsBtc: 0.5 }
];

const main = async () => {
  console.log("# Liquid strike picker probe vs naive picker\n");
  const startedAt = new Date();
  console.log(`UTC: ${startedAt.toISOString()} (hour ${startedAt.getUTCHours()} = ${startedAt.getUTCHours() < 8 || startedAt.getUTCHours() >= 21 ? "ASIA" : startedAt.getUTCHours() < 13 ? "EU" : "US"} session)\n`);

  const { spot, quotes } = await fetchFullChainSnapshot();
  console.log(`Spot: \$${spot.toFixed(0)}, ${quotes.length} quoted instruments\n`);

  type Row = {
    cellId: string;
    leg: "put" | "call";
    targetStrike: number;
    naive: DeribitQuote | null;
    liquid: DeribitQuote | null;
    naiveAskTotal: number | null;
    liquidAskTotal: number | null;
    improvementPct: number | null;
    candidateCount: number;
    rejectedCount: number;
  };
  const rows: Row[] = [];

  for (const cell of PHASE_0_PROBES) {
    const rawPut = spot * (1 + cell.putItmPct);
    const rawCall = spot * (1 - cell.callItmPct);
    const putStrike = Math.ceil(rawPut / 1_000) * 1_000;
    const callStrike = Math.floor(rawCall / 1_000) * 1_000;

    for (const { leg, strike } of [{ leg: "put" as const, strike: putStrike }, { leg: "call" as const, strike: callStrike }]) {
      // Naive: exact strike + tenor match
      const targetHours = cell.tenorDays * 24;
      const naive = quotes
        .filter((q) => q.optType === leg && q.strike === strike)
        .sort((a, b) => Math.abs(a.tenorHours - targetHours) - Math.abs(b.tenorHours - targetHours))[0] ?? null;
      // Liquid: pickLiquidStrike (preserves moneyness side relative to spot)
      const liquidResult = pickLiquidStrike(quotes, strike, cell.tenorDays, leg, spot);
      rows.push({
        cellId: cell.cellId,
        leg,
        targetStrike: strike,
        naive,
        liquid: liquidResult.picked,
        naiveAskTotal: naive ? naive.askUsdcPerBtc * cell.contractsBtc : null,
        liquidAskTotal: liquidResult.picked ? liquidResult.picked.askUsdcPerBtc * cell.contractsBtc : null,
        improvementPct: naive && liquidResult.picked && naive.askUsdcPerBtc > 0
          ? (naive.askUsdcPerBtc - liquidResult.picked.askUsdcPerBtc) / naive.askUsdcPerBtc
          : null,
        candidateCount: liquidResult.candidates.length,
        rejectedCount: liquidResult.rejected.length
      });
    }
  }

  // Aggregate cell totals
  type CellTotal = { cellId: string; naive: number; liquid: number; improvement: number };
  const cellTotals = new Map<string, CellTotal>();
  for (const r of rows) {
    if (r.naiveAskTotal == null || r.liquidAskTotal == null) continue;
    const ct = cellTotals.get(r.cellId) ?? { cellId: r.cellId, naive: 0, liquid: 0, improvement: 0 };
    ct.naive += r.naiveAskTotal;
    ct.liquid += r.liquidAskTotal;
    ct.improvement = ct.naive > 0 ? (ct.naive - ct.liquid) / ct.naive : 0;
    cellTotals.set(r.cellId, ct);
  }

  // Console output
  console.log("Per-leg detail:");
  console.log(`${"cell".padEnd(28)} ${"leg".padEnd(4)} target  ${"naive_instr".padEnd(20)} naive_ask  spr%  ${"liquid_instr".padEnd(20)} liquid_ask  spr%  improve  cands/rej`);
  for (const r of rows) {
    const naiveStr = r.naive ? r.naive.instrument_name : "(none)";
    const liquidStr = r.liquid ? r.liquid.instrument_name : "(none)";
    const naiveSpr = r.naive ? `${(r.naive.spreadPct * 100).toFixed(0)}%` : "—";
    const liquidSpr = r.liquid ? `${(r.liquid.spreadPct * 100).toFixed(0)}%` : "—";
    const improve = r.improvementPct != null ? `${(r.improvementPct * 100).toFixed(0)}%` : "—";
    console.log(`${r.cellId.padEnd(28)} ${r.leg.padEnd(4)} ${String(r.targetStrike).padStart(6)}  ${naiveStr.padEnd(20)} \$${(r.naiveAskTotal ?? 0).toFixed(0).padStart(6)}  ${naiveSpr.padStart(5)}  ${liquidStr.padEnd(20)} \$${(r.liquidAskTotal ?? 0).toFixed(0).padStart(6)}  ${liquidSpr.padStart(5)}  ${improve.padStart(6)}  ${r.candidateCount}/${r.rejectedCount}`);
  }
  console.log("\nCell totals (naive vs liquid):");
  for (const ct of cellTotals.values()) {
    console.log(`  ${ct.cellId.padEnd(28)} naive=\$${ct.naive.toFixed(0).padStart(6)} liquid=\$${ct.liquid.toFixed(0).padStart(6)} improvement=${(ct.improvement * 100).toFixed(1)}%`);
  }

  // Write markdown report
  const lines: string[] = [];
  lines.push(`# Liquid Strike Picker Probe — ${startedAt.toISOString()}`);
  lines.push("");
  lines.push(`**Spot:** \$${spot.toFixed(0)}`);
  lines.push(`**UTC hour:** ${startedAt.getUTCHours()} (${startedAt.getUTCHours() < 8 || startedAt.getUTCHours() >= 21 ? "ASIA" : startedAt.getUTCHours() < 13 ? "EU" : "US"} session)`);
  lines.push(`**Total quoted instruments:** ${quotes.length}`);
  lines.push("");
  lines.push(`## Per-leg comparison`);
  lines.push("");
  lines.push(`| Cell | Leg | Target K | Naive instrument | Naive ask | Spread% | Liquid instrument | Liquid ask | Spread% | Improve | Pick changes | Cands/Rej |`);
  lines.push(`|---|---|---:|---|---:|---:|---|---:|---:|---:|---|---|`);
  for (const r of rows) {
    const tenorChange = r.naive && r.liquid
      ? Math.abs(r.naive.tenorHours - r.liquid.tenorHours) > 6 ? `⚠ tenor Δ ${(r.liquid.tenorHours - r.naive.tenorHours).toFixed(1)}h` : "same tenor"
      : "";
    const strikeChange = r.naive && r.liquid && r.naive.strike !== r.liquid.strike
      ? `strike: ${r.naive.strike} → ${r.liquid.strike}` : "exact strike";
    lines.push(`| ${r.cellId} | ${r.leg} | \$${r.targetStrike.toLocaleString()} | \`${r.naive?.instrument_name ?? "—"}\` | \$${(r.naiveAskTotal ?? 0).toFixed(0)} | ${r.naive ? (r.naive.spreadPct * 100).toFixed(0) + "%" : "—"} | \`${r.liquid?.instrument_name ?? "—"}\` | \$${(r.liquidAskTotal ?? 0).toFixed(0)} | ${r.liquid ? (r.liquid.spreadPct * 100).toFixed(0) + "%" : "—"} | ${r.improvementPct != null ? (r.improvementPct * 100).toFixed(0) + "%" : "—"} | ${strikeChange}; ${tenorChange} | ${r.candidateCount}/${r.rejectedCount} |`);
  }
  lines.push("");
  lines.push(`## Cell totals`);
  lines.push("");
  lines.push(`| Cell | Naive total | Liquid total | Improvement |`);
  lines.push(`|---|---:|---:|---:|`);
  for (const ct of cellTotals.values()) {
    lines.push(`| ${ct.cellId} | \$${ct.naive.toFixed(0)} | \$${ct.liquid.toFixed(0)} | **${(ct.improvement * 100).toFixed(1)}%** |`);
  }
  lines.push("");
  lines.push(`## Interpretation`);
  lines.push("");
  lines.push(`- If improvement > 20% on a cell → naive picker was hitting the illiquid instrument; liquid picker recovers real cost`);
  lines.push(`- If improvement < 5% → naive picker was already on a liquid strike; no fix needed`);
  lines.push(`- If both naive and liquid produce same instrument → only one tradable strike near target; can't improve via picker`);
  lines.push("");
  lines.push(`## Next steps`);
  lines.push("");
  lines.push(`1. Re-run V3 sweep with liquid picker integrated — see if any calm cells flip positive`);
  lines.push(`2. Re-run this probe at US session (14:00-21:00 UTC) — spreads should tighten further`);
  lines.push(`3. If liquid picker recovers significant cost → integrate into production V3 cost model`);
  lines.push("");
  lines.push(`---`);
  lines.push(`*Generated by services/api/scripts/backtest/singleSide/liquidStrikePicker.ts*`);

  const outPath = path.resolve(process.cwd(), "../..", `docs/PHASE_1_LIQUID_STRIKE_PICKER_${new Date().toISOString().slice(0, 10)}.md`);
  await fs.writeFile(outPath, lines.join("\n"));
  console.log(`\n✓ Report: ${outPath}`);
};

// Bundler-safe entry guard: only run main() when invoked DIRECTLY as a script
// (via tsx). When this file is bundled into dist/server.js by esbuild, the
// fileURLToPath(import.meta.url) === process.argv[1] check spuriously matches
// because both point at the bundled server.js entry. Use basename suffix
// matching instead — server.js never ends with this file's name.
if (process.argv[1] && (
  process.argv[1].endsWith("/liquidStrikePicker.ts") ||
  process.argv[1].endsWith("\\liquidStrikePicker.ts")
)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
