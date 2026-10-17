/**
 * Append-only JSONL ledger of every quote and refusal the demo produces.
 * This is the accruing shadow record: each line is a dated, reproducible
 * artifact (inputs + terms) so the demo's history is auditable from day one.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { WrapQuoteResult } from "./types";

export function ledgerPath(): string {
  return process.env.EVENT_DEMO_LEDGER_PATH || "/tmp/event-demo/quotes.jsonl";
}

export interface LedgerRecord {
  at: string;
  kind: "quote" | "refusal";
  marketTicker: string;
  markCents: number;
  contracts: number;
  result: WrapQuoteResult;
  spotUsd: number;
}

export function appendLedger(record: LedgerRecord, path: string = ledgerPath()): void {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // the ledger must never take the demo down
  }
}
