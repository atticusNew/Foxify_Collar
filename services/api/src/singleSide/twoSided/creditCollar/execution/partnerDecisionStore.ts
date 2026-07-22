/**
 * Partner directional-decision store — the ELEVATED-day call belongs to the PARTNER, not to us.
 * On elevated days the live runner does not auto-open a trend single: it waits (within the daily
 * execution window) for an explicit partner decision — "take" (optionally with a side) or "pass".
 * No decision by the window close ⟹ the day is skipped (never chase, never assume).
 *
 * Append-only JSONL; the LATEST record for a UTC day wins (a partner can revise until executed).
 * Recorded via the CLI (scripts/creditCollarPartnerDecision.ts) today; the partner-facing API posts
 * the same record shape later.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolveWritablePath } from "../shadowStore";
import type { PerpSide } from "../creditCollarPricer";

export const DEFAULT_PARTNER_DECISION_PATH = process.env.LIVE_PARTNER_DECISION_PATH ?? "./logs/live-partner-decisions.jsonl";

export type PartnerDecision = {
  dayUtc: string;                 // YYYY-MM-DD the decision applies to
  action: "take" | "pass";
  /** Partner-chosen side; null ⟹ defer to our trend signal. Ignored on "pass". */
  side: PerpSide | null;
  decidedAtIso: string;
  source?: string;                // "cli" | "api" | operator note
};

export const appendPartnerDecision = (rec: PartnerDecision, path = DEFAULT_PARTNER_DECISION_PATH): void => {
  try {
    appendFileSync(resolveWritablePath(path), JSON.stringify(rec) + "\n", "utf8");
  } catch (e) {
    console.error(`[partner-decision] append failed: ${(e as Error).message}`);
  }
};

export const loadPartnerDecisions = (path = DEFAULT_PARTNER_DECISION_PATH): PartnerDecision[] => {
  const eff = resolveWritablePath(path);
  if (!existsSync(eff)) return [];
  const out: PartnerDecision[] = [];
  for (const line of readFileSync(eff, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as PartnerDecision);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
};

/** Latest decision for a UTC day (append order wins), or null when the partner hasn't spoken. */
export const latestDecisionForDay = (dayUtc: string, path = DEFAULT_PARTNER_DECISION_PATH): PartnerDecision | null => {
  const all = loadPartnerDecisions(path).filter((d) => d.dayUtc === dayUtc);
  return all.length > 0 ? all[all.length - 1] : null;
};
