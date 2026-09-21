/**
 * ARCHIVE, NEVER DELETE. A fresh start for a ledger is a rename: the file becomes
 * `<name>.<UTC stamp>.archived<ext>` beside the original and the writer starts a new empty one.
 * The old window stays exportable (it is still the same append-only record, now closed), and
 * nothing that happened is erased. Used by the operator reset endpoints on the perp shadow and the demo.
 */

import { existsSync, renameSync } from "node:fs";
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

export function archiveLedgerFile(path: string, atIso: string = new Date().toISOString()): ArchiveResult {
  if (!existsSync(path)) return { path, archivedTo: null };
  const to = archivePathFor(path, atIso);
  renameSync(path, to);
  return { path, archivedTo: to };
}
