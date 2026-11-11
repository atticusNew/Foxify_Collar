/**
 * EVERY FILE THE SERVICE KEEPS, LISTED, so a backup can copy all of them.
 *
 * The export route used to reach three kinds of file: the record's ledger, the shared lock
 * ledger and each named holder's. Everything else lived only on the one disk: the hedge
 * receipts, the pending trail of real-money lock attempts, the parlay ledger, the daily venue
 * reconciliation, the terms acceptances, the daily fingerprints of each ledger, and every
 * archive a reset made. A backup that copies three files of those is not a backup of the book.
 *
 * This is the list, worked out from what is on the disk rather than from a list of names in a
 * workflow, so a holder's ledger whose key was removed, an archive from a reset, and a file a
 * later change adds beside a ledger are all found without anyone remembering to add them:
 *
 *   - each file the service is configured to write (the "bases");
 *   - every file in the same folder whose name is a base's name with something added after the
 *     stem: `<stem>.fingerprints.jsonl`, `<stem>.<stamp>.archived.jsonl`,
 *     `<stem>-<holder>.jsonl` and that holder file's own fingerprints and archives.
 *
 * NOT COPIED, AND SAID. The members' sealed venue connections are listed and never exported:
 * they are credentials, a copy of them in a second place is a second place to lose them from,
 * and a member whose connection is lost connects again. Any other file in those folders is
 * listed under `others` so that nothing on the disk is left out without a line saying so.
 *
 * A name in the list is the file's own name on the disk, so restoring is putting the file back
 * under the same name in the folder the list gives. Pure but for the folder listing, which is
 * injected.
 */

import { readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

export interface KeptBase {
  /** a short fixed word for the kind of file, for a script to pick one out by */
  key: string;
  /** what the file is, in the operator's words */
  role: string;
  path: string;
  /** set when the file is listed and never exported, and why */
  notCopied?: string;
}

export interface KeptFile {
  /** the name to ask the export for; the file's own name on the disk unless two folders hold the same name */
  name: string;
  /** where it is on the disk, which is where a restore puts it back */
  path: string;
  /** the kind of file it is or belongs to (the base's key) */
  key: string;
  /** true for the file the service writes under that key; false for one beside it (a holder's, fingerprints, an archive) */
  base: boolean;
  role: string;
  bytes: number;
  modified: string;
  format: "jsonl" | "json" | "other";
}

export interface KeptFilesList {
  /** exported by name */
  files: KeptFile[];
  /** configured, and not on the disk yet (nothing of that kind has been written) */
  missing: Array<{ key: string; role: string; path: string }>;
  /** on the disk, listed, never exported */
  notCopied: Array<{ name: string; path: string; role: string; bytes: number; why: string }>;
  /** other files in the same folders: not the service's record, not exported */
  others: Array<{ name: string; path: string; bytes: number }>;
}

export interface KeptFilesFs {
  list: (dir: string) => Array<{ name: string; bytes: number; modifiedMs: number; isFile: boolean }>;
}

const realFs: KeptFilesFs = {
  list: (dir) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const out: Array<{ name: string; bytes: number; modifiedMs: number; isFile: boolean }> = [];
    for (const name of names) {
      try {
        const st = statSync(join(dir, name));
        out.push({ name, bytes: st.size, modifiedMs: st.mtimeMs, isFile: st.isFile() });
      } catch {
        // gone between the listing and the stat (a rename during a reset): the next listing has it
      }
    }
    return out;
  },
};

/** What a derived file is, from what follows the base's stem in its name. */
function derivedRole(baseRole: string, tail: string): string {
  const parts: string[] = [];
  const holder = /^-([a-z0-9][a-z0-9_-]{1,23})(?=\.|$)/.exec(tail);
  if (holder) parts.push(`holder ${holder[1]}`);
  if (/\.fingerprints(\.|$)/.test(tail)) parts.push("daily fingerprints");
  if (/\.archived(\.|$)/.test(tail)) parts.push("archived by a reset");
  return parts.length > 0 ? `${baseRole}: ${parts.join(", ")}` : `${baseRole}: ${tail.replace(/^[.-]/, "")}`;
}

const formatOf = (name: string): KeptFile["format"] => (name.endsWith(".jsonl") ? "jsonl" : name.endsWith(".json") ? "json" : "other");

/** A name safe to put in an address and in a file name on the copy. */
export const KEPT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,150}$/;

export function keptFiles(bases: ReadonlyArray<KeptBase>, fs: KeptFilesFs = realFs): KeptFilesList {
  const out: KeptFilesList = { files: [], missing: [], notCopied: [], others: [] };
  // plain code-unit order everywhere: the same list on every machine
  const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const dirs = [...new Set(bases.map((b) => dirname(b.path)))].sort(byText);
  const seenNames = new Map<string, number>();
  const seenPaths = new Set<string>();
  for (const dir of dirs) {
    const here = bases.filter((b) => dirname(b.path) === dir);
    const stems = here
      .map((b) => ({ base: b, file: basename(b.path), stem: basename(b.path, extname(b.path)) }))
      // the longest stem first, so `lock-ledger-ann` is never read as something of `lock`
      .sort((a, b) => b.stem.length - a.stem.length);
    const entries = fs.list(dir).filter((e) => e.isFile).sort((a, b) => byText(a.name, b.name));
    const present = new Set(entries.map((e) => e.name));
    for (const s of stems) if (!present.has(s.file) && !s.base.notCopied) out.missing.push({ key: s.base.key, role: s.base.role, path: s.base.path });
    for (const e of entries) {
      const path = join(dir, e.name);
      if (seenPaths.has(path)) continue;
      seenPaths.add(path);
      // a half-written remainder during a reset: never the record, gone a moment later
      if (e.name.endsWith(".tmp")) continue;
      const exact = stems.find((s) => s.file === e.name);
      const from = exact ?? stems.find((s) => e.name.startsWith(s.stem) && /^[.-]/.test(e.name.slice(s.stem.length)));
      if (!from) {
        out.others.push({ name: e.name, path, bytes: e.bytes });
        continue;
      }
      const role = exact ? from.base.role : derivedRole(from.base.role, e.name.slice(from.stem.length));
      if (from.base.notCopied) {
        out.notCopied.push({ name: e.name, path, role, bytes: e.bytes, why: from.base.notCopied });
        continue;
      }
      if (!KEPT_NAME_RE.test(e.name)) {
        out.notCopied.push({ name: e.name, path, role, bytes: e.bytes, why: "its name cannot be put in an address; rename it on the disk or copy it by hand" });
        continue;
      }
      // the same name in two folders: the second is asked for by its folder and name
      const n = (seenNames.get(e.name) ?? 0) + 1;
      seenNames.set(e.name, n);
      const name = n === 1 ? e.name : `${n}~${e.name}`;
      out.files.push({ name, path, key: from.base.key, base: Boolean(exact), role, bytes: e.bytes, modified: new Date(e.modifiedMs).toISOString(), format: formatOf(e.name) });
    }
  }
  out.missing.sort((a, b) => byText(a.path, b.path));
  return out;
}

/** The file a name in the list stands for; null for a name that is not in the list (never a path from the caller). */
export function keptFileByName(list: KeptFilesList, name: string | null): KeptFile | null {
  if (!name || !KEPT_NAME_RE.test(name)) return null;
  return list.files.find((f) => f.name === name) ?? null;
}
