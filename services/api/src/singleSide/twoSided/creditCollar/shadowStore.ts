/**
 * Shadow scorecard store — append-only JSONL persistence so the Tier-0 shadow cron accumulates a
 * track record across runs. Isolated + default-off: a plain file under logs/ (no DB schema touched),
 * matching the repo's existing logs/*.jsonl convention. One line per shadow session.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ShadowRunRecord } from "./shadowAggregate";

export const DEFAULT_SHADOW_STORE_PATH = process.env.SHADOW_STORE_PATH ?? "./logs/shadow-scorecards.jsonl";

export const appendScorecard = (record: ShadowRunRecord, path = DEFAULT_SHADOW_STORE_PATH): void => {
  const dir = dirname(path);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
};

export const loadScorecards = (path = DEFAULT_SHADOW_STORE_PATH): ShadowRunRecord[] => {
  if (!existsSync(path)) return [];
  const out: ShadowRunRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as ShadowRunRecord;
      if (rec && rec.scorecard) out.push(rec);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
};

/** Optional: keep only records since a cutoff (e.g. a clean post-fix cohort). */
export const filterSince = (records: ShadowRunRecord[], sinceMs?: number): ShadowRunRecord[] =>
  sinceMs == null ? records : records.filter((r) => r.tsMs >= sinceMs);
