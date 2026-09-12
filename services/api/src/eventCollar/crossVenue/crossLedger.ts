/**
 * Append-only JSONL ledger of every cross-venue quote and refusal.
 * Same discipline as the Tier 1 ledger: each line is a dated, reproducible
 * artifact (pairing + inputs + terms) so the demo's history is auditable.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CrossQuoteResult, HedgeRoute, RouteCheck } from "./types";

export function crossLedgerPath(): string {
  return process.env.EVENT_X_LEDGER_PATH || "/tmp/event-demo/cross-quotes.jsonl";
}

export interface CrossLedgerRecord {
  at: string;
  kind: "cross_venue_quote";
  kalshiTicker: string;
  pmEventSlug: string;
  fingerprint: string;
  markCents: number;
  entryCents: number;
  contracts: number;
  result: CrossQuoteResult;
  /** which hedge route won (absent on refusals and on records from before routing) */
  route?: HedgeRoute;
  /** true EV cost of the chosen quote in bps (absent on refusals / older records) */
  evCostBps?: number;
  /** every route examined for this quote, quotable or honestly refused */
  routesChecked?: RouteCheck[];
}

export function appendCrossLedger(
  record: CrossLedgerRecord,
  path: string = crossLedgerPath(),
): void {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // the ledger must never take the demo down
  }
}

/** Aggregate view of the ledger for the public receipts page. */
export interface CrossLedgerSummary {
  totalQuotes: number;
  priced: number;
  refused: number;
  refusalsByCode: Record<string, number>;
  /** sum of holder credits across priced quotes, cents */
  creditsSourcedCents: number;
  /** sum of the published take actually kept, cents */
  takeKeptCents: number;
  /** mean true cost of priced protection, bps of naked EV (null when unrecorded) */
  avgEvCostBps: number | null;
  /** priced quotes per winning hedge route */
  routeSplit: Record<string, number>;
  firstAt: string | null;
  lastAt: string | null;
}

/**
 * Read and aggregate the JSONL ledger. Unparseable lines are skipped; a
 * missing file is an empty (honest) history, never an error.
 */
export function summarizeCrossLedger(path: string = crossLedgerPath()): CrossLedgerSummary {
  const summary: CrossLedgerSummary = {
    totalQuotes: 0,
    priced: 0,
    refused: 0,
    refusalsByCode: {},
    creditsSourcedCents: 0,
    takeKeptCents: 0,
    avgEvCostBps: null,
    routeSplit: {},
    firstAt: null,
    lastAt: null,
  };
  let lines: string[] = [];
  try {
    if (!existsSync(path)) return summary;
    lines = readFileSync(path, "utf8").split("\n");
  } catch {
    return summary;
  }
  let evSum = 0;
  let evCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: CrossLedgerRecord;
    try {
      rec = JSON.parse(trimmed) as CrossLedgerRecord;
    } catch {
      continue;
    }
    if (!rec || rec.kind !== "cross_venue_quote" || !rec.result) continue;
    summary.totalQuotes += 1;
    if (!summary.firstAt || rec.at < summary.firstAt) summary.firstAt = rec.at;
    if (!summary.lastAt || rec.at > summary.lastAt) summary.lastAt = rec.at;
    if (rec.result.ok) {
      summary.priced += 1;
      summary.creditsSourcedCents += rec.result.creditCents;
      summary.takeKeptCents += rec.result.takeCents;
      const route = rec.route ?? "polymarket"; // pre-routing records were all cross-venue
      summary.routeSplit[route] = (summary.routeSplit[route] ?? 0) + 1;
      if (typeof rec.evCostBps === "number") {
        evSum += rec.evCostBps;
        evCount += 1;
      }
    } else {
      summary.refused += 1;
      const code = rec.result.code || "unknown";
      summary.refusalsByCode[code] = (summary.refusalsByCode[code] ?? 0) + 1;
    }
  }
  if (evCount > 0) summary.avgEvCostBps = Math.round(evSum / evCount);
  return summary;
}
