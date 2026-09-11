/**
 * Append-only JSONL ledger of every cross-venue quote and refusal.
 * Same discipline as the Tier 1 ledger: each line is a dated, reproducible
 * artifact (pairing + inputs + terms) so the demo's history is auditable.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CrossQuoteResult } from "./types";

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
