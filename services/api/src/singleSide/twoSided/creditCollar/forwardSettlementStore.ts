/**
 * Forward-settlement persistence — the OPEN-positions ledger (carried across cycles until expiry) and
 * the SETTLEMENT ledger (append-only, the realized-economics record). Disk-backed (Render disk) with
 * the same writable-fallback as the scorecard store. Open positions are REPLACED each cycle (settled
 * ones drop out); settlements are APPENDED.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolveWritablePath } from "./shadowStore";
import type { OpenPosition, SettlementOutcome } from "./forwardSettlement";

export const DEFAULT_OPEN_POSITIONS_PATH = process.env.SHADOW_OPEN_POSITIONS_PATH ?? "./logs/shadow-open-positions.jsonl";
export const DEFAULT_SETTLEMENT_LEDGER_PATH = process.env.SHADOW_SETTLEMENT_LEDGER_PATH ?? "./logs/shadow-settlements.jsonl";

export const loadOpenPositions = (path = DEFAULT_OPEN_POSITIONS_PATH): OpenPosition[] => {
  const eff = resolveWritablePath(path);
  if (!existsSync(eff)) return [];
  const out: OpenPosition[] = [];
  for (const line of readFileSync(eff, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const p = JSON.parse(t) as OpenPosition;
      if (p && p.ref) out.push(p);
    } catch {
      /* skip */
    }
  }
  return out;
};

/** Replace the open-positions ledger with the current set (settled positions have dropped out). */
export const saveOpenPositions = (positions: OpenPosition[], path = DEFAULT_OPEN_POSITIONS_PATH): void => {
  const eff = resolveWritablePath(path);
  try {
    writeFileSync(eff, positions.map((p) => JSON.stringify(p)).join("\n") + (positions.length ? "\n" : ""), "utf8");
  } catch (e) {
    console.warn(`[fwd-store] save open positions failed (${(e as Error).message})`);
  }
};

export const appendSettlements = (outcomes: SettlementOutcome[], path = DEFAULT_SETTLEMENT_LEDGER_PATH): void => {
  if (outcomes.length === 0) return;
  const eff = resolveWritablePath(path);
  try {
    appendFileSync(eff, outcomes.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf8");
  } catch (e) {
    console.warn(`[fwd-store] append settlements failed (${(e as Error).message})`);
  }
};

export const loadSettlements = (path = DEFAULT_SETTLEMENT_LEDGER_PATH): SettlementOutcome[] => {
  const eff = resolveWritablePath(path);
  if (!existsSync(eff)) return [];
  const out: SettlementOutcome[] = [];
  for (const line of readFileSync(eff, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as SettlementOutcome;
      if (o && o.ref) out.push(o);
    } catch {
      /* skip */
    }
  }
  return out;
};
