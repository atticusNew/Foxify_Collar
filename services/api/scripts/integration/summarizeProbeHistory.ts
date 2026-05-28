/**
 * Summarize /tmp/liquid_picker_history.jsonl into a time-of-day distribution.
 *
 * After 24h+ of scheduled probes, this script aggregates by UTC hour and
 * cell, showing mean hedge cost / mean spread per session.
 *
 * Output: docs/PHASE_1_SPREAD_TIMEOFDAY_<date>.md
 *
 * Usage:
 *   npx tsx scripts/integration/summarizeProbeHistory.ts
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

type Entry = {
  runAt: string;
  utcHour: number;
  spot: number;
  cellId: string;
  hedgeCostTotal: number;
  putSpread: number | null;
  callSpread: number | null;
  // New per-venue columns (older entries may not have these)
  pickedPutVenue?: string | null;
  pickedCallVenue?: string | null;
  deribitOnlyHedgeCostTotal?: number | null;
  bullishOnlyHedgeCostTotal?: number | null;
  crossVenueSavingsUsdc?: number | null;
  crossVenueSavingsPct?: number | null;
};

const fmt$ = (n: number) => `\$${Math.round(n).toLocaleString()}`;
const fmtPct = (n: number | null) => n == null ? "—" : `${(n * 100).toFixed(0)}%`;

const main = async () => {
  const histPath = "/tmp/liquid_picker_history.jsonl";
  let raw: string;
  try {
    raw = await fs.readFile(histPath, "utf8");
  } catch {
    console.error(`No history at ${histPath}. Run scheduledSpreadProbe.ts first.`);
    process.exit(1);
  }
  const entries: Entry[] = raw.trim().split("\n").map((l) => JSON.parse(l));
  console.log(`Loaded ${entries.length} probe entries`);

  // Bucket by (cellId, utcHour)
  type Agg = {
    cellId: string; hour: number; n: number;
    sumHedge: number; sumPutSpread: number; nPutSpread: number; sumCallSpread: number; nCallSpread: number;
    // Venue tracking (new)
    sumDeribitOnly: number; nDeribitOnly: number;
    sumBullishOnly: number; nBullishOnly: number;
    sumSavings: number; nSavings: number;
    bullishPutWins: number; bullishCallWins: number; deribitPutWins: number; deribitCallWins: number;
  };
  const aggs = new Map<string, Agg>();
  for (const e of entries) {
    const key = `${e.cellId}::${e.utcHour}`;
    const a = aggs.get(key) ?? {
      cellId: e.cellId, hour: e.utcHour, n: 0,
      sumHedge: 0, sumPutSpread: 0, nPutSpread: 0, sumCallSpread: 0, nCallSpread: 0,
      sumDeribitOnly: 0, nDeribitOnly: 0, sumBullishOnly: 0, nBullishOnly: 0,
      sumSavings: 0, nSavings: 0,
      bullishPutWins: 0, bullishCallWins: 0, deribitPutWins: 0, deribitCallWins: 0
    };
    a.n++;
    a.sumHedge += e.hedgeCostTotal;
    if (e.putSpread != null) { a.sumPutSpread += e.putSpread; a.nPutSpread++; }
    if (e.callSpread != null) { a.sumCallSpread += e.callSpread; a.nCallSpread++; }
    if (e.deribitOnlyHedgeCostTotal != null) { a.sumDeribitOnly += e.deribitOnlyHedgeCostTotal; a.nDeribitOnly++; }
    if (e.bullishOnlyHedgeCostTotal != null) { a.sumBullishOnly += e.bullishOnlyHedgeCostTotal; a.nBullishOnly++; }
    if (e.crossVenueSavingsUsdc != null) { a.sumSavings += e.crossVenueSavingsUsdc; a.nSavings++; }
    if (e.pickedPutVenue === "bullish") a.bullishPutWins++;
    else if (e.pickedPutVenue === "deribit") a.deribitPutWins++;
    if (e.pickedCallVenue === "bullish") a.bullishCallWins++;
    else if (e.pickedCallVenue === "deribit") a.deribitCallWins++;
    aggs.set(key, a);
  }
  const sorted = [...aggs.values()].sort((a, b) => a.cellId.localeCompare(b.cellId) || a.hour - b.hour);

  const lines: string[] = [];
  lines.push(`# Spread Time-of-Day Analysis`);
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Probes analyzed:** ${entries.length}`);
  lines.push(`**First probe:** ${entries[0]?.runAt ?? "—"}`);
  lines.push(`**Last probe:** ${entries[entries.length - 1]?.runAt ?? "—"}`);
  lines.push("");
  lines.push(`## Hedge cost by UTC hour × cell`);
  lines.push("");
  const cells = [...new Set(entries.map((e) => e.cellId))];
  for (const cellId of cells) {
    lines.push(`### ${cellId}`);
    lines.push("");
    lines.push(`| UTC hour | Session | N | Mean cross-venue cost | Mean Deribit-only cost | Mean Bullish-only cost | Mean savings | Put venue wins (B/D) | Call venue wins (B/D) |`);
    lines.push(`|---:|---|---:|---:|---:|---:|---:|---:|---:|`);
    for (let h = 0; h < 24; h++) {
      const a = aggs.get(`${cellId}::${h}`);
      if (!a) continue;
      const session = h < 8 || h >= 21 ? "ASIA" : h < 13 ? "EU" : "US";
      const dOnly = a.nDeribitOnly > 0 ? fmt$(a.sumDeribitOnly / a.nDeribitOnly) : "—";
      const bOnly = a.nBullishOnly > 0 ? fmt$(a.sumBullishOnly / a.nBullishOnly) : "—";
      const savings = a.nSavings > 0 ? fmt$(a.sumSavings / a.nSavings) : "—";
      lines.push(`| ${h.toString().padStart(2, "0")}:00 | ${session} | ${a.n} | ${fmt$(a.sumHedge / a.n)} | ${dOnly} | ${bOnly} | ${savings} | ${a.bullishPutWins}/${a.deribitPutWins} | ${a.bullishCallWins}/${a.deribitCallWins} |`);
    }
    lines.push("");
  }

  lines.push(`## Interpretation`);
  lines.push("");
  lines.push(`Look for systematic patterns:`);
  lines.push(`- **Hour-of-day cost variance:** if mean cross-venue cost in 13-21 UTC (US session) is`);
  lines.push(`  20%+ lower than 0-8 UTC (Asia) → US session is the better trade window. Consider`);
  lines.push(`  gating activations by UTC hour for marginal cells.`);
  lines.push(`- **Cross-venue savings:** if mean savings (vs Deribit-only) is consistently > \$50/pair`);
  lines.push(`  → Bullish is genuinely contributing to economics; routing is paying off.`);
  lines.push(`- **Venue win patterns:** if Bullish dominates puts at most hours but Deribit dominates`);
  lines.push(`  calls → Bullish is structurally cheaper on one side; could optimize cell design.`);
  lines.push(`- **Flat hedge cost across all hours, low savings:** spreads are structural; calm halt`);
  lines.push(`  is permanent regardless of timing.`);
  lines.push("");

  const outPath = path.resolve(process.cwd(), "../..", `docs/PHASE_1_SPREAD_TIMEOFDAY_${new Date().toISOString().slice(0, 10)}.md`);
  await fs.writeFile(outPath, lines.join("\n"));
  console.log(`✓ Report: ${outPath}`);
};

import { fileURLToPath } from "node:url";
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
