/**
 * Shadow scorecard store — append-only JSONL persistence so the Tier-0 shadow cron accumulates a
 * track record across runs. Isolated + default-off: a plain file under logs/ (no DB schema touched),
 * matching the repo's existing logs/*.jsonl convention. One line per shadow session.
 */

import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { ShadowRunRecord } from "./shadowAggregate";

export const DEFAULT_SHADOW_STORE_PATH = process.env.SHADOW_STORE_PATH ?? "./logs/shadow-scorecards.jsonl";

// Resolve a WRITABLE store path: if the configured dir can't be created/written (e.g. /var/data with
// no Render disk attached → EACCES), fall back to a temp path so the loop + dashboard keep working
// (ephemeral). Cached per preferred path so append + load agree within the process. Attach a disk
// for durability across restarts.
let _resolved: { preferred: string; effective: string } | null = null;
export const resolveWritablePath = (preferred: string): string => {
  if (_resolved && _resolved.preferred === preferred) return _resolved.effective;
  let effective = preferred;
  try {
    const dir = dirname(preferred);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    accessSync(dir || ".", constants.W_OK);
  } catch {
    effective = join(tmpdir(), basename(preferred) || "shadow-scorecards.jsonl");
    console.warn(`[shadow-store] '${preferred}' not writable — falling back to ephemeral '${effective}'. Attach a disk for a durable track record.`);
  }
  _resolved = { preferred, effective };
  return effective;
};

export const appendScorecard = (record: ShadowRunRecord, path = DEFAULT_SHADOW_STORE_PATH): void => {
  const effective = resolveWritablePath(path);
  try {
    appendFileSync(effective, JSON.stringify(record) + "\n", "utf8");
  } catch (e) {
    console.warn(`[shadow-store] append failed (${(e as Error).message}) — scorecard not persisted this cycle.`);
  }
};

export const loadScorecards = (path = DEFAULT_SHADOW_STORE_PATH): ShadowRunRecord[] => {
  const effective = resolveWritablePath(path);
  if (!existsSync(effective)) return [];
  const out: ShadowRunRecord[] = [];
  for (const line of readFileSync(effective, "utf8").split("\n")) {
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
