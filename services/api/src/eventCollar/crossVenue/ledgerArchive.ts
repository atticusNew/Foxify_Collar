/**
 * ARCHIVE, NEVER DELETE. A fresh start for a ledger is a rename: the file becomes
 * `<name>.<UTC stamp>.archived<ext>` beside the original and the writer starts a new empty one.
 * The old window stays exportable (it is still the same append-only record, now closed), and
 * nothing that happened is erased. Used by the operator reset endpoints on both event services.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

export interface ArchiveResult {
  path: string;
  /** where the old file went; null when there was nothing to archive */
  archivedTo: string | null;
}

/** `2026-09-21T01:30:00.000Z` -> `2026-09-21T013000Z`: readable, filename-safe, sorts by time. */
export function archiveStamp(atIso: string): string {
  return atIso.slice(0, 19).replace(/:/g, "") + "Z";
}

export function archivePathFor(path: string, atIso: string): string {
  const ext = extname(path);
  const stem = basename(path, ext);
  return join(dirname(path), `${stem}.${archiveStamp(atIso)}.archived${ext}`);
}

/** Where `archiveLedgerLines` puts the lines it moves, for the same path, label and moment. */
export function archiveLinesPathFor(path: string, label: string, atIso: string): string {
  const ext = extname(path);
  const safeLabel = label.replace(/[^A-Za-z0-9_-]+/g, "_");
  return join(dirname(path), `${basename(path, ext)}.${archiveStamp(atIso)}.${safeLabel}.archived${ext}`);
}

export function archiveLedgerFile(path: string, atIso: string = new Date().toISOString()): ArchiveResult {
  if (!existsSync(path)) return { path, archivedTo: null };
  const to = archivePathFor(path, atIso);
  renameSync(path, to);
  return { path, archivedTo: to };
}

export interface ArchiveLinesResult extends ArchiveResult {
  /** lines moved to the archive */
  moved: number;
  /** lines left in the ledger */
  kept: number;
}

/**
 * Archive some of a ledger's lines, not the file: every line whose parsed record satisfies
 * `pick` moves to `<name>.<UTC stamp>.<label>.archived<ext>` beside the original, in order; the
 * rest are written back. Lines that do not parse are kept. For a ledger shared by several
 * holders, where one lock is being reset and the others must stand. Nothing picked: no archive
 * file, the ledger untouched.
 */
export function archiveLedgerLines(path: string, pick: (record: Record<string, unknown>) => boolean, label: string, atIso: string = new Date().toISOString()): ArchiveLinesResult {
  if (!existsSync(path)) return { path, archivedTo: null, moved: 0, kept: 0 };
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const moved: string[] = [];
  const kept: string[] = [];
  for (const line of lines) {
    let rec: Record<string, unknown> | null = null;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      rec = null;
    }
    (rec && pick(rec) ? moved : kept).push(line);
  }
  if (moved.length === 0) return { path, archivedTo: null, moved: 0, kept: kept.length };
  const to = archiveLinesPathFor(path, label, atIso);
  writeFileSync(to, moved.join("\n") + "\n", { flag: "wx" });
  // write the remainder beside, then rename over: the ledger is never half-written
  const tmp = `${path}.${archiveStamp(atIso)}.tmp`;
  writeFileSync(tmp, kept.length ? kept.join("\n") + "\n" : "");
  renameSync(tmp, path);
  return { path, archivedTo: to, moved: moved.length, kept: kept.length };
}
