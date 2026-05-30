/**
 * Step 3 of certainty plan: shadow DB analyzer.
 *
 * Connects to the production DATABASE_URL/POSTGRES_URL, pulls all closed pairs
 * (shadow OR real), computes realized PnL per cell, and compares to V3 MC
 * prediction. This is the empirical "ground truth" — what actually happened
 * in the operator's database, not what a simulation predicted.
 *
 * If the DB has 100+ shadow pairs from a multi-day shadow bot run, this is
 * enough sample to validate / falsify V3. If the DB only has a handful of
 * historical pilot pairs, it gives us the per-pair data points the operator
 * remembers but never formally cross-checked.
 *
 * Output: docs/PHASE_1_SHADOW_DB_ANALYSIS_<date>.md
 *
 * Usage:
 *   export POSTGRES_URL=<the operator's live DB URL>
 *   npx tsx scripts/integration/shadowDbAnalyzer.ts
 *
 * Filters: pass --since=YYYY-MM-DD or --cell=<cellId> to scope analysis.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Pool } from "pg";

type Args = {
  since: string | null;
  cell: string | null;
  shadowOnly: boolean;
  liveOnly: boolean;
};

const parseArgs = (): Args => {
  const args: Args = { since: null, cell: null, shadowOnly: false, liveOnly: false };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--since=")) args.since = a.slice(8);
    else if (a.startsWith("--cell=")) args.cell = a.slice(7);
    else if (a === "--shadow") args.shadowOnly = true;
    else if (a === "--live") args.liveOnly = true;
  }
  return args;
};

type PairRow = {
  pair_id: string;
  cell_id: string;
  status: string;
  is_shadow: boolean;
  created_at: string;
  closed_at: string | null;
  spot_at_activation: number;
  hedge_cost_total_usdc: number | null;
  salvage_proceeds_usdc: number | null;
  foxify_share_usdc: number | null;
  atticus_share_usdc: number | null;
  uplift_usdc: number | null;
  triggered_at: string | null;
  trigger_side: string | null;
  closed_reason: string | null;
  tier_at_activation: string | null;
  metadata: Record<string, unknown> | null;
};

const fmt$ = (n: number | null) => n == null ? "—" : `${n < 0 ? "-" : ""}\$${Math.round(Math.abs(n)).toLocaleString()}`;
const fmt$S = (n: number | null) => n == null ? "—" : `${n < 0 ? "-" : "+"}\$${Math.round(Math.abs(n)).toLocaleString()}`;
const fmtPct = (n: number | null) => n == null ? "—" : `${(n * 100).toFixed(1)}%`;

const main = async () => {
  const args = parseArgs();
  const dbUrl = process.env.POSTGRES_URL ?? process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("ERROR: POSTGRES_URL or DATABASE_URL env var required");
    console.error("Usage: export POSTGRES_URL=<conn-string>; npx tsx scripts/integration/shadowDbAnalyzer.ts [--since=YYYY-MM-DD] [--cell=<id>] [--shadow|--live]");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: dbUrl, ssl: dbUrl.includes("render.com") ? { rejectUnauthorized: false } : undefined });

  console.log("# Shadow DB analyzer (Step 3 of certainty plan)\n");
  console.log(`Connecting to: ${dbUrl.replace(/:[^:@]+@/, ":***@").slice(0, 80)}...`);

  // Confirm schema exists
  const schemaCheck = await pool.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables WHERE table_name = 'two_sided_pair'
    ) as exists
  `);
  if (!schemaCheck.rows[0].exists) {
    console.error("ERROR: two_sided_pair table not found. Either wrong DB or migrations not run.");
    await pool.end();
    process.exit(1);
  }

  const whereClauses: string[] = ["status IN ('settled', 'cancelled')"];
  const params: unknown[] = [];
  if (args.since) {
    params.push(args.since);
    whereClauses.push(`created_at >= $${params.length}`);
  }
  if (args.cell) {
    params.push(args.cell);
    whereClauses.push(`cell_id = $${params.length}`);
  }
  if (args.shadowOnly) whereClauses.push("is_shadow = TRUE");
  if (args.liveOnly) whereClauses.push("is_shadow = FALSE");

  const sql = `
    SELECT
      pair_id, cell_id, status, is_shadow, created_at, closed_at,
      spot_at_activation, hedge_cost_total_usdc, salvage_proceeds_usdc,
      foxify_share_usdc, atticus_share_usdc, uplift_usdc,
      triggered_at, trigger_side, closed_reason, tier_at_activation, metadata
    FROM two_sided_pair
    WHERE ${whereClauses.join(" AND ")}
    ORDER BY created_at DESC
    LIMIT 5000
  `;
  const result = await pool.query(sql, params);
  const pairs = result.rows as PairRow[];

  console.log(`Found ${pairs.length} closed pairs matching filters\n`);

  if (pairs.length === 0) {
    console.log("No closed pairs in DB matching filters. Nothing to analyze.");
    console.log("\nNext step: either let the shadow bot accumulate data, or import past pilot data.");
    await pool.end();
    process.exit(0);
  }

  // Derive regime from metadata.regime if present (shadow bot can include it),
  // else fallback to metadata.regime_at_trigger, else "unknown".
  const regimeOf = (p: PairRow): string => {
    const m = p.metadata ?? {};
    return (m.regime as string) ?? (m.regime_at_trigger as string) ?? "unknown";
  };

  // Foxify EV per pair = foxify_share - hedge_cost (because Foxify funded the hedge)
  const foxifyEv = (p: PairRow): number => (p.foxify_share_usdc ?? 0) - (p.hedge_cost_total_usdc ?? 0);

  type CellRegimeAgg = {
    cellId: string;
    regime: string;
    isShadow: boolean;
    pairCount: number;
    triggerCount: number;
    meanHedgeCost: number;
    meanSalvage: number;
    meanFoxifyPnl: number;
    meanAtticusPnl: number;
    medianFoxifyPnl: number;
    minFoxifyPnl: number;
    maxFoxifyPnl: number;
    triggerRate: number;
    pctProfitable: number;
  };
  const aggMap = new Map<string, CellRegimeAgg>();

  for (const p of pairs) {
    const regime = regimeOf(p);
    const key = `${p.cell_id}::${regime}::${p.is_shadow ? "shadow" : "live"}`;
    let agg = aggMap.get(key);
    if (!agg) {
      agg = {
        cellId: p.cell_id, regime, isShadow: p.is_shadow,
        pairCount: 0, triggerCount: 0,
        meanHedgeCost: 0, meanSalvage: 0, meanFoxifyPnl: 0, meanAtticusPnl: 0,
        medianFoxifyPnl: 0, minFoxifyPnl: Infinity, maxFoxifyPnl: -Infinity,
        triggerRate: 0, pctProfitable: 0
      };
      aggMap.set(key, agg);
    }
    agg.pairCount++;
    if (p.triggered_at) agg.triggerCount++;
    agg.meanHedgeCost += p.hedge_cost_total_usdc ?? 0;
    agg.meanSalvage += p.salvage_proceeds_usdc ?? 0;
    const fEv = foxifyEv(p);
    agg.meanFoxifyPnl += fEv;
    agg.meanAtticusPnl += p.atticus_share_usdc ?? 0;
    if (fEv < agg.minFoxifyPnl) agg.minFoxifyPnl = fEv;
    if (fEv > agg.maxFoxifyPnl) agg.maxFoxifyPnl = fEv;
  }

  for (const [key, agg] of aggMap.entries()) {
    const subset = pairs.filter((p) =>
      p.cell_id === agg.cellId &&
      regimeOf(p) === agg.regime &&
      (key.endsWith("::shadow") ? p.is_shadow : !p.is_shadow)
    );
    const foxEvs = subset.map(foxifyEv).sort((a, b) => a - b);
    agg.medianFoxifyPnl = foxEvs.length > 0 ? foxEvs[Math.floor(foxEvs.length / 2)] : 0;
    agg.meanHedgeCost /= agg.pairCount;
    agg.meanSalvage /= agg.pairCount;
    agg.meanFoxifyPnl /= agg.pairCount;
    agg.meanAtticusPnl /= agg.pairCount;
    agg.triggerRate = agg.triggerCount / agg.pairCount;
    agg.pctProfitable = subset.filter((p) => foxifyEv(p) > 0).length / agg.pairCount;
  }

  // Sort: by cell, then regime, then mode (live first)
  const sorted = [...aggMap.values()].sort((a, b) => {
    if (a.cellId !== b.cellId) return a.cellId.localeCompare(b.cellId);
    if (a.regime !== b.regime) return a.regime.localeCompare(b.regime);
    return (a.isShadow ? 1 : 0) - (b.isShadow ? 1 : 0);
  });

  // Report
  const lines: string[] = [];
  lines.push(`# Shadow DB Empirical Analysis — Step 3 of certainty plan`);
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**DB:** \`${dbUrl.replace(/:[^:@]+@/, ":***@").slice(0, 60)}...\``);
  lines.push(`**Filters:** ${[args.since ? `since=${args.since}` : null, args.cell ? `cell=${args.cell}` : null, args.shadowOnly ? "shadow-only" : args.liveOnly ? "live-only" : "all"].filter(Boolean).join(", ") || "(none)"}`);
  lines.push(`**Pair count:** ${pairs.length} closed pairs`);
  lines.push(`  - Shadow: ${pairs.filter((p) => p.is_shadow).length}`);
  lines.push(`  - Live:   ${pairs.filter((p) => !p.is_shadow).length}`);
  lines.push("");
  lines.push(`## Per-cell × regime × mode aggregates`);
  lines.push("");
  lines.push(`| Cell | Regime | Mode | N | TrigRate | Mean hedge | Mean salvage | **Mean FoxPnL** | Median FoxPnL | Mean AttPnL | %profit | Worst | Best |`);
  lines.push(`|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|`);
  for (const a of sorted) {
    const mode = a.isShadow ? "shadow" : "live";
    lines.push(`| ${a.cellId} | ${a.regime} | ${mode} | ${a.pairCount} | ${fmtPct(a.triggerRate)} | ${fmt$(a.meanHedgeCost)} | ${fmt$(a.meanSalvage)} | **${fmt$S(a.meanFoxifyPnl)}** | ${fmt$S(a.medianFoxifyPnl)} | ${fmt$S(a.meanAtticusPnl)} | ${fmtPct(a.pctProfitable)} | ${fmt$S(a.minFoxifyPnl)} | ${fmt$S(a.maxFoxifyPnl)} |`);
  }
  lines.push("");

  // Sample of recent closed pairs
  lines.push(`## Most recent 20 closed pairs (for sanity check)`);
  lines.push("");
  lines.push(`| pair_id | cell | mode | regime | activated | spot | hedge | salvage | FoxPnL | AttPnL | reason |`);
  lines.push(`|---|---|---|---|---|---:|---:|---:|---:|---:|---|`);
  for (const p of pairs.slice(0, 20)) {
    const fEv = (p.foxify_share_usdc ?? 0) - (p.hedge_cost_total_usdc ?? 0);
    const regime = ((p.metadata ?? {}).regime as string) ?? ((p.metadata ?? {}).regime_at_trigger as string) ?? "—";
    lines.push(`| \`${p.pair_id.slice(0, 8)}\` | ${p.cell_id} | ${p.is_shadow ? "shadow" : "live"} | ${regime} | ${p.created_at.slice(0, 16)} | \$${Math.round(Number(p.spot_at_activation)).toLocaleString()} | ${fmt$(p.hedge_cost_total_usdc)} | ${fmt$(p.salvage_proceeds_usdc)} | ${fmt$S(fEv)} | ${fmt$S(p.atticus_share_usdc)} | ${p.closed_reason ?? "—"} |`);
  }
  lines.push("");

  // Comparison vs V3 prediction (operator references the V3 sweep doc)
  lines.push(`## Comparison vs V3 MC prediction`);
  lines.push("");
  lines.push(`Cross-reference each row above against \`docs/PHASE_1_CELL_SWEEP_V3_2026-05-28.md\`.`);
  lines.push(`For each (cell, regime) pair, compute drift = (realized mean FoxPnL − V3 predicted FoxPnL) / |V3 predicted|.`);
  lines.push(`If |drift| < 15% with N ≥ 30 → V3 validated for that cell/regime.`);
  lines.push(`If |drift| > 15% with N ≥ 30 → V3 needs recalibration (cost model bias detected).`);
  lines.push(`If N < 30 → keep accumulating shadow data; sample too small.`);
  lines.push("");

  lines.push(`---`);
  lines.push(`*Generated by services/api/scripts/integration/shadowDbAnalyzer.ts*`);
  lines.push(`*Re-run regularly as shadow bot accumulates more samples.*`);

  const outPath = path.resolve(process.cwd(), "../..", `docs/PHASE_1_SHADOW_DB_ANALYSIS_${new Date().toISOString().slice(0, 10)}.md`);
  await fs.writeFile(outPath, lines.join("\n"));
  console.log(`✓ Shadow DB report: ${outPath}`);
  console.log(`\nTop summary:`);
  for (const a of sorted.slice(0, 10)) {
    console.log(`  ${a.cellId.padEnd(30)} ${a.regime.padEnd(9)} ${(a.isShadow ? "shadow" : "live").padEnd(7)} N=${String(a.pairCount).padStart(4)} FoxPnL=${fmt$S(a.meanFoxifyPnl).padStart(8)} trigRate=${fmtPct(a.triggerRate).padStart(6)}`);
  }
  await pool.end();
};

import { fileURLToPath } from "node:url";
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
