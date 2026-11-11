/**
 * Day files: what the read-only lane keeps on disk. One `<family>-YYYY-MM-DD.jsonl` per UTC day,
 * append-only, for the curve snapshots, the pairs cycles and episodes, and the sports snapshots.
 * This is what the three stores share:
 *
 *   retention   every day is kept unless a window is set. A window of N days keeps the current
 *               day and the N whole days before it. A setting that cannot be read deletes
 *               nothing and says so; it is never guessed at.
 *   gzip        a day that has closed is compressed to `<name>.jsonl.gz`, written to a temp name,
 *               read back and compared (bytes, line count, sha256 of the uncompressed bytes) and
 *               only then renamed; the original is removed after that. A compression that fails
 *               anywhere leaves the original and is tried again on a later pass.
 *   reading     a day is read from its `.jsonl` when that exists, else from its `.jsonl.gz`.
 *               Both exist only between the rename and the removal, so a day is never counted
 *               twice.
 *   the guard   bytes on disk against an optional budget, said on /healthz. The budget deletes
 *               nothing: the operator raises the disk or sets a window.
 *   writes      an append that fails (a full disk) does not throw into the cycle. The service
 *               keeps serving from memory and /healthz says it is not recording and why. A
 *               write that failed part way leaves a fragment with no newline; the next line
 *               starts on a line of its own, so the fragment costs one line and not two.
 *
 * Nothing here reads a venue or holds a credential.
 */

import { createHash } from "node:crypto";
import { appendFileSync, closeSync, createReadStream, createWriteStream, existsSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, statSync, statfsSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { createGunzip, createGzip } from "node:zlib";

const DAY_MS = 86_400_000;

/* ---- retention ---- */

export interface Retention {
  /** whole days kept; null keeps every day */
  days: number | null;
  /** `all` or `N days`, as /healthz prints it */
  label: string;
  /** set when the setting could not be read: what it held, and that nothing is deleted */
  note: string | null;
  /** the setting's name, for the plain-words notes */
  setting: string;
}

/**
 * The retention setting as a rule. Unset, empty, `0`, `all` and `none` keep every day; a positive
 * whole number is that many days; anything else (`abc`, `-3`, `2.5`, `21d`) keeps every day and
 * carries a note saying so. A typo must never delete a day.
 */
export function parseRetention(raw: string | number | null | undefined, setting = "the retention setting"): Retention {
  const text = String(raw ?? "").trim().toLowerCase();
  if (text === "" || text === "all" || text === "none" || /^0+$/.test(text)) return { days: null, label: "all", note: null, setting };
  if (/^[0-9]+$/.test(text)) {
    const n = Number(text);
    if (Number.isSafeInteger(n) && n > 0) return { days: n, label: n === 1 ? "1 day" : `${n} days`, note: null, setting };
  }
  return {
    days: null,
    label: "all",
    note: `${setting} is ${JSON.stringify(String(raw))}, which is not a whole number of days. Nothing is deleted. Set a whole number of days for a window, or remove it to keep every day.`,
    setting,
  };
}

export interface Budget {
  /** the size the operator expects the data to stay under, MB; null when none is set */
  mb: number | null;
  note: string | null;
  setting: string;
}

/** The size budget in MB: a positive number, or none. Unset, empty and `0` are no budget; anything else unreadable is no budget with a note. */
export function parseBudgetMb(raw: string | number | null | undefined, setting = "the disk budget setting"): Budget {
  const text = String(raw ?? "").trim();
  if (text === "" || /^0+$/.test(text)) return { mb: null, note: null, setting };
  const n = Number(text);
  if (/^[0-9]+(\.[0-9]+)?$/.test(text) && Number.isFinite(n) && n > 0) return { mb: n, note: null, setting };
  return { mb: null, note: `${setting} is ${JSON.stringify(String(raw))}, which is not a size in MB. No budget is in force.`, setting };
}

/* ---- naming and listing ---- */

const DAY_FILE = /^([A-Za-z][A-Za-z0-9_]*)-(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/;

export interface DayFile {
  family: string;
  /** YYYY-MM-DD, UTC */
  day: string;
  /** the first instant of that day, ms */
  dayMs: number;
  /** full path of the `.jsonl`, when it exists */
  plain: string | null;
  /** full path of the `.jsonl.gz`, when it exists */
  gz: string | null;
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function dayFilePath(dir: string, family: string, atMs: number): string {
  return join(dir, `${family}-${utcDay(atMs)}.jsonl`);
}

/** The day files of the given families in `dir` (not below it), oldest day first. A day with both forms is one entry. */
export function listDayFiles(dir: string, families: readonly string[]): DayFile[] {
  if (!existsSync(dir)) return [];
  const byKey = new Map<string, DayFile>();
  for (const name of readdirSync(dir)) {
    const m = DAY_FILE.exec(name);
    if (!m || !families.includes(m[1])) continue;
    const dayMs = Date.parse(`${m[2]}T00:00:00Z`);
    if (!Number.isFinite(dayMs)) continue;
    const key = `${m[2]}|${m[1]}`;
    const f = byKey.get(key) ?? { family: m[1], day: m[2], dayMs, plain: null, gz: null };
    if (m[3]) f.gz = join(dir, name);
    else f.plain = join(dir, name);
    byKey.set(key, f);
  }
  return [...byKey.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, f]) => f);
}

/**
 * The one file a reader takes for a day: the `.jsonl` when it exists, else the `.jsonl.gz`. The
 * plain file is the original; the compressed copy only stands in for it once it has been
 * verified and the original removed.
 */
export function readablePath(f: DayFile): string {
  return (f.plain ?? f.gz) as string;
}

/** Whether a file ends on a line end, so a line appended to it starts on its own line. True for a file that is empty or not there. */
function endsWithNewline(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return true;
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return true;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] === 10;
  } finally {
    closeSync(fd);
  }
}

/* ---- reading ---- */

/**
 * Every non-empty line of a day file, plain or gzip, in order, as a stream. This is the only
 * reader: a day is hundreds of megabytes raw, and the services run in 512 MB, so nothing takes
 * a day into memory whole. Throws when the file cannot be read or is not gzip where it says it is.
 */
export async function* readLines(path: string): AsyncGenerator<string> {
  const source = createReadStream(path);
  const stream = path.endsWith(".gz") ? source.pipe(createGunzip()) : source;
  if (stream !== source) source.on("error", (err) => stream.destroy(err));
  const decoder = new StringDecoder("utf8");
  let carry = "";
  try {
    for await (const chunk of stream) {
      carry += decoder.write(chunk as Buffer);
      let from = 0;
      for (let nl = carry.indexOf("\n", from); nl >= 0; nl = carry.indexOf("\n", from)) {
        if (nl > from) yield carry.slice(from, nl);
        from = nl + 1;
      }
      carry = carry.slice(from);
    }
    carry += decoder.end();
    if (carry) yield carry;
  } finally {
    source.destroy();
  }
}

/* ---- gzip of a closed day ---- */

interface Digest {
  bytes: number;
  lines: number;
  sha256: string;
}

function newlines(chunk: Buffer): number {
  let n = 0;
  for (let i = chunk.indexOf(10); i >= 0; i = chunk.indexOf(10, i + 1)) n += 1;
  return n;
}

/** Bytes, newline count and sha256 of a file's uncompressed content, read as a stream. */
async function digestOf(path: string): Promise<Digest> {
  const source = createReadStream(path);
  const stream = path.endsWith(".gz") || path.endsWith(".gz.tmp") ? source.pipe(createGunzip()) : source;
  if (stream !== source) source.on("error", (err) => stream.destroy(err));
  const hash = createHash("sha256");
  let bytes = 0;
  let lines = 0;
  try {
    for await (const chunk of stream) {
      const c = chunk as Buffer;
      hash.update(c);
      bytes += c.length;
      lines += newlines(c);
    }
  } finally {
    source.destroy();
  }
  return { bytes, lines, sha256: hash.digest("hex") };
}

const sameDigest = (a: Digest, b: Digest): boolean => a.bytes === b.bytes && a.lines === b.lines && a.sha256 === b.sha256;

export type CompressResult =
  | { ok: true; file: string; lines: number; rawBytes: number; gzBytes: number; ms: number; sha256: string; finishedEarlier?: true }
  | { ok: false; file: string; reason: string; ms: number };

export interface CompressOptions {
  /** test seam: runs after the temp file is written and before it is read back */
  afterWrite?: (tmpPath: string) => void | Promise<void>;
}

async function syncPath(path: string): Promise<void> {
  const fh = await open(path, "r");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Compress one closed day file to `<name>.gz` and remove the original, in that order and only
 * after the compressed copy has been read back and matches. Streams throughout (the gzip runs
 * on a worker thread), so the caller's cycle is not held. Never throws: a failure is a result,
 * the original stays, and the temp file is removed.
 *
 * When the `.gz` already exists an earlier pass got as far as the rename: if it holds the same
 * bytes the original is removed now; if it does not, neither file is touched and the result
 * says so, because which of the two is right cannot be known from here.
 */
export async function compressDayFile(plainPath: string, opts: CompressOptions = {}): Promise<CompressResult> {
  const t0 = Date.now();
  const gzPath = `${plainPath}.gz`;
  const tmpPath = `${gzPath}.tmp`;
  const file = basename(plainPath);
  const fail = (reason: string): CompressResult => ({ ok: false, file, reason, ms: Date.now() - t0 });
  try {
    const before = statSync(plainPath);
    if (existsSync(gzPath)) {
      const [plain, gz] = [await digestOf(plainPath), await digestOf(gzPath)];
      if (!sameDigest(plain, gz)) return fail(`${file} and ${basename(gzPath)} both exist and do not hold the same lines. Neither is removed; readers use ${file}.`);
      unlinkSync(plainPath);
      return { ok: true, file: basename(gzPath), lines: gz.lines, rawBytes: gz.bytes, gzBytes: statSync(gzPath).size, ms: Date.now() - t0, sha256: gz.sha256, finishedEarlier: true };
    }
    const hash = createHash("sha256");
    let bytes = 0;
    let lines = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _enc, done) {
        hash.update(chunk);
        bytes += chunk.length;
        lines += newlines(chunk);
        done(null, chunk);
      },
    });
    await pipeline(createReadStream(plainPath), tap, createGzip(), createWriteStream(tmpPath));
    const source: Digest = { bytes, lines, sha256: hash.digest("hex") };
    await opts.afterWrite?.(tmpPath);
    await syncPath(tmpPath);
    const copy = await digestOf(tmpPath);
    const after = statSync(plainPath);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || source.bytes !== before.size) return fail(`${file} changed while it was being compressed; it is left as it is`);
    if (!sameDigest(source, copy)) return fail(`the compressed copy of ${file} did not read back the same (${copy.lines} lines against ${source.lines}); the original is kept`);
    renameSync(tmpPath, gzPath);
    try {
      // the rename is on disk before the original goes, so a power cut between the two leaves both, never neither
      await syncPath(dirname(gzPath));
    } catch {
      // not every filesystem lets a directory be synced; the rename itself has succeeded
    }
    unlinkSync(plainPath);
    return { ok: true, file: basename(gzPath), lines: source.lines, rawBytes: source.bytes, gzBytes: statSync(gzPath).size, ms: Date.now() - t0, sha256: source.sha256 };
  } catch (err) {
    return fail(`${file} could not be compressed: ${failureText(err)}; the original is kept`);
  } finally {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // a temp file that will not go is overwritten by the next pass
    }
  }
}

/* ---- what is on disk ---- */

export interface DataUsage {
  /** file sizes summed, everything under the dir */
  bytes: number;
  files: number;
  dayFiles: { plain: number; gz: number };
  oldestDay: string | null;
  newestDay: string | null;
}

/** Everything under `dir`, subfolders included: bytes, files, and the day files among them. A file that vanishes mid-walk is skipped. */
export function dataUsage(dir: string): DataUsage {
  const u: DataUsage = { bytes: 0, files: 0, dayFiles: { plain: 0, gz: 0 }, oldestDay: null, newestDay: null };
  const walk = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!e.isFile()) continue;
      try {
        u.bytes += statSync(p).size;
      } catch {
        continue;
      }
      u.files += 1;
      const m = DAY_FILE.exec(e.name);
      if (!m) continue;
      if (m[3]) u.dayFiles.gz += 1;
      else u.dayFiles.plain += 1;
      if (u.oldestDay === null || m[2] < u.oldestDay) u.oldestDay = m[2];
      if (u.newestDay === null || m[2] > u.newestDay) u.newestDay = m[2];
    }
  };
  walk(dir);
  return u;
}

/** An error from the filesystem (it carries a code such as ENOSPC), as against a fault in our own arithmetic. */
export function isFsError(err: unknown): err is NodeJS.ErrnoException {
  return typeof (err as NodeJS.ErrnoException | null)?.code === "string" && typeof (err as NodeJS.ErrnoException).syscall === "string";
}

function failureText(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  if (e?.code === "ENOSPC") return "the disk is full (ENOSPC)";
  if (e?.code === "EDQUOT") return "the disk quota is used up (EDQUOT)";
  const text = String(e?.message ?? err).replace(/\s+/g, " ").slice(0, 160);
  return e?.code && !text.includes(e.code) ? `${e.code}: ${text}` : text;
}

/** What /healthz prints under `data`. */
export interface DataHealth {
  dir: string;
  /** file sizes summed, everything under the dir */
  bytes: number;
  files: number;
  dayFiles: { plain: number; gz: number };
  oldestDay: string | null;
  newestDay: string | null;
  /** `all`, or `N days` when a window is set */
  retention: string;
  /** set when the retention setting could not be read */
  retentionNote?: string;
  /** set when a budget is: its size and how much of it the data fills */
  budget?: { mb: number; usedPct: number };
  /** plain words when the data has passed 80% of the budget */
  warning?: string;
  /** false while the last write to disk failed */
  recording: boolean;
  /** plain words: what failed, when, why, and how many writes are not on disk */
  notRecording?: string;
  /** writes that failed since this process started, kept after writing resumes */
  writesLost?: { count: number; first: string; last: string; reason: string };
  compression: {
    /** closed days still waiting as `.jsonl` */
    pending: number;
    last?: { file: string; at: string; lines: number; rawBytes: number; gzBytes: number; ms: number };
    lastError?: string;
  };
  /** the filesystem the dir sits on, where the platform says */
  filesystem?: { totalBytes: number; freeBytes: number };
  notes?: string[];
}

export interface DayKeeperOptions {
  dir: string;
  /** the day-file families this keeper appends, sweeps and compresses in `dir`; nothing else there is touched */
  families: readonly string[];
  retention?: Retention;
  budget?: Budget;
  /** how long after a UTC day ends before its file is compressed, so a late line of that day still lands in it; default one hour */
  graceMs?: number;
  /** test seam: the append itself */
  appendImpl?: (path: string, data: string) => void;
  /** test seam for the compression */
  compress?: CompressOptions;
}

const WARN_AT = 0.8;
const USAGE_TTL_MS = 30_000;
const MB = 1024 * 1024;

/**
 * One store's files: the guarded append, the retention sweep, the one-file-a-pass compression
 * and the figures for /healthz. The store keeps its own memory; this keeps its disk.
 */
export class DayKeeper {
  readonly dir: string;
  readonly retention: Retention;
  readonly budget: Budget;
  private readonly families: readonly string[];
  private readonly graceMs: number;
  private readonly appendImpl: (path: string, data: string) => void;
  private readonly compressOpts: CompressOptions;
  /** writes failing now, by what is written (a family of day files, a state file): one recovering does not hide another */
  private readonly failing = new Map<string, { what: string; since: string; last: string; count: number; reason: string }>();
  private lost: { count: number; first: string; last: string; reason: string } | null = null;
  private usage: { at: number; value: DataUsage; pending: number } | null = null;
  private lastCompressed: DataHealth["compression"]["last"];
  private lastCompressError = "";
  private readonly notes = new Map<string, string>();
  /** days tried since the last full round, so one file that will not compress does not hold up the rest */
  private readonly tried = new Set<string>();
  private maintaining: Promise<MaintainReport> | null = null;
  /** the day file this keeper last appended to in full, per family: known to end on a line end */
  private readonly whole = new Map<string, string>();

  constructor(opts: DayKeeperOptions) {
    this.dir = opts.dir;
    this.families = opts.families;
    this.retention = opts.retention ?? parseRetention(undefined);
    this.budget = opts.budget ?? parseBudgetMb(undefined);
    this.graceMs = Math.max(0, opts.graceMs ?? 3_600_000);
    this.appendImpl = opts.appendImpl ?? ((path, data) => appendFileSync(path, data));
    this.compressOpts = opts.compress ?? {};
  }

  /**
   * Append one line to the family's file for the day of `atMs`. Returns false, and remembers
   * why, when the write fails; it never throws, so a full disk cannot stop a cycle.
   */
  append(family: string, atMs: number, line: string, nowMs = Date.now()): boolean {
    const path = dayFilePath(this.dir, family, atMs);
    const text = line.endsWith("\n") ? line : `${line}\n`;
    const ok = this.guarded(family, basename(path), () => {
      mkdirSync(this.dir, { recursive: true });
      // a write that failed part way (a full disk, a kill) left a fragment with no line end: this line must not be glued onto it
      const clean = this.whole.get(family) === path || endsWithNewline(path);
      this.appendImpl(path, clean ? text : `\n${text}`);
    }, nowMs);
    if (ok) this.whole.set(family, path);
    else this.whole.delete(family);
    return ok;
  }

  /** Run one write of any kind (a state file, a marker). A filesystem failure is remembered and false returned; any other error is the caller's. */
  guard(what: string, write: () => void, nowMs = Date.now()): boolean {
    return this.guarded(what, what, write, nowMs);
  }

  private guarded(key: string, what: string, write: () => void, nowMs: number): boolean {
    try {
      write();
    } catch (err) {
      if (!isFsError(err)) throw err;
      const at = new Date(nowMs).toISOString();
      const reason = failureText(err);
      const was = this.failing.get(key);
      this.failing.set(key, { what, since: was?.since ?? at, last: at, count: (was?.count ?? 0) + 1, reason });
      this.lost = { count: (this.lost?.count ?? 0) + 1, first: this.lost?.first ?? at, last: at, reason };
      return false;
    }
    this.failing.delete(key);
    return true;
  }

  /** Something a reader of /healthz should know that is not a failed write (a day that could not be read on boot). Keyed so it is said once. */
  note(key: string, text: string | null): void {
    if (text) this.notes.set(key, text);
    else this.notes.delete(key);
  }

  /** A day is closed once its UTC day has ended and the grace has passed. The current day never is. */
  private closed(f: DayFile, nowMs: number): boolean {
    return nowMs >= f.dayMs + DAY_MS + this.graceMs;
  }

  /**
   * Delete the day files outside the retention window, both forms. A day is outside once its
   * last instant is more than the window before now, so a window of N days always holds N whole
   * days besides the current one and no line younger than N days is deleted. With no window (the
   * default, and whenever the setting could not be read) nothing is deleted. Returns the names
   * removed.
   */
  sweep(nowMs = Date.now()): string[] {
    const days = this.retention.days;
    if (days === null) return [];
    const removed: string[] = [];
    for (const f of listDayFiles(this.dir, this.families)) {
      if (!(nowMs - (f.dayMs + DAY_MS) > days * DAY_MS)) continue;
      for (const path of [f.plain, f.gz]) {
        if (!path) continue;
        try {
          unlinkSync(path);
          removed.push(basename(path));
        } catch {
          // a file that will not delete is left for the next sweep
        }
      }
    }
    if (removed.length) this.usage = null;
    return removed;
  }

  /** Closed days still held as `.jsonl`, oldest first. */
  pending(nowMs = Date.now()): DayFile[] {
    return listDayFiles(this.dir, this.families).filter((f) => f.plain !== null && this.closed(f, nowMs));
  }

  /**
   * One maintenance pass, off the cycle: the retention sweep, then at most one closed day
   * compressed. Passes do not overlap; a call made while one runs returns that one's result.
   */
  maintain(nowMs = Date.now()): Promise<MaintainReport> {
    if (!this.maintaining) {
      this.maintaining = this.maintainOnce(nowMs).finally(() => {
        this.maintaining = null;
      });
    }
    return this.maintaining;
  }

  private async maintainOnce(nowMs: number): Promise<MaintainReport> {
    const report: MaintainReport = { removed: [], compressed: null };
    try {
      report.removed = this.sweep(nowMs);
      const waiting = this.pending(nowMs);
      let next = waiting.find((f) => !this.tried.has(f.plain as string));
      if (!next && waiting.length) {
        this.tried.clear();
        next = waiting[0];
      }
      if (next) {
        const plain = next.plain as string;
        this.tried.add(plain);
        const result = await compressDayFile(plain, this.compressOpts);
        report.compressed = result;
        if (result.ok) {
          this.tried.delete(plain);
          this.lastCompressed = { file: result.file, at: new Date().toISOString(), lines: result.lines, rawBytes: result.rawBytes, gzBytes: result.gzBytes, ms: result.ms };
          this.lastCompressError = "";
        } else {
          this.lastCompressError = result.reason;
        }
      } else {
        this.lastCompressError = "";
      }
    } catch (err) {
      this.lastCompressError = `maintenance pass failed: ${failureText(err)}`;
    }
    this.usage = null;
    return report;
  }

  private usageNow(nowMs: number): { value: DataUsage; pending: number } {
    const real = Date.now();
    if (!this.usage || real - this.usage.at > USAGE_TTL_MS) this.usage = { at: real, value: dataUsage(this.dir), pending: this.pending(nowMs).length };
    return this.usage;
  }

  health(nowMs = Date.now()): DataHealth {
    const { value: u, pending } = this.usageNow(nowMs);
    const out: DataHealth = {
      dir: this.dir,
      bytes: u.bytes,
      files: u.files,
      dayFiles: u.dayFiles,
      oldestDay: u.oldestDay,
      newestDay: u.newestDay,
      retention: this.retention.label,
      recording: this.failing.size === 0,
      compression: { pending },
    };
    if (this.retention.note) out.retentionNote = this.retention.note;
    if (this.budget.mb !== null) {
      const share = u.bytes / (this.budget.mb * MB);
      out.budget = { mb: this.budget.mb, usedPct: Math.round(share * 1000) / 10 };
      if (share > WARN_AT) out.warning = this.budgetWarning(u.bytes, share);
    }
    if (this.failing.size) {
      const each = [...this.failing.values()].map((f) => `the last write to ${f.what} failed at ${f.last} because ${f.reason}; ${f.count} in a row since ${f.since} ${f.count === 1 ? "is" : "are"} not on disk`);
      out.notRecording = `Not recording: ${each.join(". Also ")}. The pages keep serving from memory.`;
    }
    if (this.lost) out.writesLost = { ...this.lost };
    if (this.lastCompressed) out.compression.last = this.lastCompressed;
    if (this.lastCompressError) out.compression.lastError = this.lastCompressError;
    try {
      const fs = statfsSync(this.dir);
      out.filesystem = { totalBytes: fs.blocks * fs.bsize, freeBytes: fs.bavail * fs.bsize };
    } catch {
      // the dir does not exist yet, or the platform does not say
    }
    const notes = [...(this.budget.note ? [this.budget.note] : []), ...this.notes.values()];
    if (notes.length) out.notes = notes;
    return out;
  }

  private budgetWarning(bytes: number, share: number): string {
    const pct = (Math.round(share * 1000) / 10).toFixed(1);
    const mb = Math.round(bytes / MB);
    const how = share > 1 ? `over the budget: ${mb} MB is ${pct}% of the ${this.budget.mb} MB` : `at ${pct}% of the ${this.budget.mb} MB budget (${mb} MB)`;
    return `Data is ${how} set in ${this.budget.setting}. Nothing is deleted because of the budget. Raise the disk, or set ${this.retention.setting} to a number of days to keep a window.`;
  }

  /** What the start-up log line says about the disk: what is kept, how much is there, and anything the operator should act on. */
  startupLine(nowMs = Date.now()): string {
    const h = this.health(nowMs);
    const kept = this.retention.days === null ? "keeping every day" : `keeping ${this.retention.label}`;
    const parts = [`${kept}, closed days gzipped`, `${Math.round(h.bytes / MB)} MB in ${h.dayFiles.plain + h.dayFiles.gz} day files${h.oldestDay ? ` since ${h.oldestDay}` : ""}`];
    if (h.budget) parts.push(`${h.budget.usedPct}% of the ${h.budget.mb} MB budget`);
    for (const extra of [h.retentionNote, h.warning, h.notRecording, ...(h.notes ?? [])]) if (extra) parts.push(extra);
    return parts.join(" · ");
  }
}

export interface MaintainReport {
  /** day files the retention window removed on this pass */
  removed: string[];
  /** the one compression tried on this pass; null when no closed day was waiting */
  compressed: CompressResult | null;
}

/** The log lines one pass is worth: what the window removed, what was gzipped, what would not gzip. Nothing when the pass did nothing. */
export function maintainLines(r: MaintainReport, retention: Retention): string[] {
  const out: string[] = [];
  if (r.removed.length) out.push(`retention ${retention.label}: removed ${r.removed.join(", ")}`);
  const c = r.compressed;
  if (c?.ok) out.push(`gzipped ${c.file}: ${c.lines} lines, ${c.rawBytes} to ${c.gzBytes} bytes in ${c.ms} ms${c.finishedEarlier ? " (finishing an earlier pass)" : ""}`);
  else if (c) out.push(`not gzipped: ${c.reason}`);
  return out;
}
