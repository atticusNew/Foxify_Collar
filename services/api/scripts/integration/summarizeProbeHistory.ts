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
  type Agg = { cellId: string; hour: number; n: number; sumHedge: number; sumPutSpread: number; nPutSpread: number; sumCallSpread: number; nCallSpread: number };
  const aggs = new Map<string, Agg>();
  for (const e of entries) {
    const key = `${e.cellId}::${e.utcHour}`;
    const a = aggs.get(key) ?? { cellId: e.cellId, hour: e.utcHour, n: 0, sumHedge: 0, sumPutSpread: 0, nPutSpread: 0, sumCallSpread: 0, nCallSpread: 0 };
    a.n++;
    a.sumHedge += e.hedgeCostTotal;
    if (e.putSpread != null) { a.sumPutSpread += e.putSpread; a.nPutSpread++; }
    if (e.callSpread != null) { a.sumCallSpread += e.callSpread; a.nCallSpread++; }
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
    lines.push(`| UTC hour | Session | N probes | Mean hedge | Mean put spread | Mean call spread |`);
    lines.push(`|---:|---|---:|---:|---:|---:|`);
    for (let h = 0; h < 24; h++) {
      const a = aggs.get(`${cellId}::${h}`);
      if (!a) continue;
      const session = h < 8 || h >= 21 ? "ASIA" : h < 13 ? "EU" : "US";
      lines.push(`| ${h.toString().padStart(2, "0")}:00 | ${session} | ${a.n} | ${fmt$(a.sumHedge / a.n)} | ${fmtPct(a.nPutSpread > 0 ? a.sumPutSpread / a.nPutSpread : null)} | ${fmtPct(a.nCallSpread > 0 ? a.sumCallSpread / a.nCallSpread : null)} |`);
    }
    lines.push("");
  }

  lines.push(`## Interpretation`);
  lines.push("");
  lines.push(`Look for systematic patterns:`);
  lines.push(`- If hedge cost in 13-21 UTC (US session) is 20%+ lower than 0-8 UTC (Asia) → US session is the better trade window`);
  lines.push(`- If spreads in US session drop dramatically for the ITM cell → confirms our Asian-session over-estimate`);
  lines.push(`- If costs are flat across all hours → spreads are structural, not session-dependent`);
  lines.push("");
  lines.push(`Use this to determine whether to gate cell activation by UTC hour, e.g.,`);
  lines.push(`only allow Phase 0 (ITM) activations when UTC hour ∈ [13, 21] (US session).`);
  lines.push("");

  const outPath = path.resolve(process.cwd(), "../..", `docs/PHASE_1_SPREAD_TIMEOFDAY_${new Date().toISOString().slice(0, 10)}.md`);
  await fs.writeFile(outPath, lines.join("\n"));
  console.log(`✓ Report: ${outPath}`);
};

import { fileURLToPath } from "node:url";
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
