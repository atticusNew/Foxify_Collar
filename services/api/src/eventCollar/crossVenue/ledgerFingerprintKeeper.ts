/**
 * LEDGER FINGERPRINT KEEPER. Holds one ledger's fingerprints (ledgerFingerprint.ts) for a running
 * service: reads the file, records each closed day once in a small append-only file beside it, and
 * compares what the ledger gives now with what was recorded before.
 *
 * READ-ONLY TOWARDS THE LEDGER. It opens the ledger for reading and nothing else. The one file it
 * writes is `<ledger name>.fingerprints.jsonl` beside it, by append only.
 *
 * WHAT IS READ WHEN. The first sync, and every sync asked to be full, hashes the file from its
 * first byte. Every other sync reads only the bytes appended since the last one. A file that is
 * shorter than what was already read, or is a different file under the same name (another inode),
 * is hashed again from its first byte. An edit in place that keeps the length is not seen by the
 * cheap path; the full pass at start-up and once a day is what finds it.
 *
 * A MISMATCH IS NEVER REPAIRED. When the ledger stops hashing to a published day, a `mismatch`
 * line is appended, the callback is told (the service alerts), and nothing else is written: the
 * published days stay as they were and no new day is published on top of a broken chain. It ends
 * in one of two ways, both on the record: the file hashes to every published day again (a copy
 * put back; a `restored` line is appended), or the operator archives the ledger and a new chain
 * starts (`restart`). There is no way to accept the changed file as the published one.
 *
 * ARCHIVE AND RESET (ledgerArchive.ts). The caller says so first: `restart()` writes the closing
 * fingerprint of the file as it stands and ends the chain, then the file is archived, then the
 * next sync fingerprints whatever is there from its first byte as chain n+1. Written before the
 * rename so that a stop between the two leaves a restart with an unchanged file (harmless: the
 * same days are published again on the new chain) and never a changed file with no restart (a
 * false alarm). The earlier chain's days stay listed, and the archived file still hashes to them.
 * A ledger archived or rewritten without `restart()` is a mismatch, as it should be.
 *
 * WHAT THE RECORD IS NOT. It is this service's only memory of what it published, on the same
 * disk as the ledger. If the record itself is lost, the days are recorded again from the ledger
 * as it then stands, with new publication stamps, and nothing here can tell. The fingerprints
 * people saved outside this disk are what catch that; see ledgerFingerprint.ts on who is bound.
 *
 * ISOLATION: node:fs and node:path; no imports outside src/eventCollar/**.
 */

import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import {
  LedgerFingerprinter,
  firstDifference,
  replayFingerprintFile,
  type FingerprintChain,
  type FingerprintFileRecord,
  type FingerprintMismatch,
  type LedgerFingerprintStatus,
} from "./ledgerFingerprint";

/** `/var/data/event-shadow-ledger.jsonl` -> `/var/data/event-shadow-ledger.fingerprints.jsonl` */
export function fingerprintPathFor(ledgerPath: string): string {
  const ext = extname(ledgerPath);
  return join(dirname(ledgerPath), `${basename(ledgerPath, ext)}.fingerprints${ext || ".jsonl"}`);
}

export interface LedgerFingerprintKeeperOptions {
  /** where the published days are recorded; beside the ledger by default */
  recordPath?: string;
  now?: () => Date;
  /** told when a mismatch is first found, and again on every full check that still finds it */
  onMismatch?: (m: FingerprintMismatch) => void;
  /** told when a full check finds the ledger hashing to every published day again */
  onRestored?: (was: FingerprintMismatch) => void;
}

const READ_CHUNK = 4 * 1024 * 1024;
const sameFinding = (a: FingerprintMismatch, b: FingerprintMismatch): boolean => a.day === b.day && (a.found?.sha256 ?? null) === (b.found?.sha256 ?? null) && (a.found?.day ?? null) === (b.found?.day ?? null);

export class LedgerFingerprintKeeper {
  readonly ledgerPath: string;
  readonly recordPath: string;
  private readonly now: () => Date;
  private readonly onMismatch?: (m: FingerprintMismatch) => void;
  private readonly onRestored?: (was: FingerprintMismatch) => void;
  private fingerprinter = new LedgerFingerprinter();
  /** bytes of the file already fed to the fingerprinter, finished lines or not */
  private offset = 0;
  private fileId: string | null = null;
  private started = false;
  private chains: FingerprintChain[] = replayFingerprintFile("");
  private fullCheckAt: string | null = null;
  private error: string | null = null;

  constructor(ledgerPath: string, opts: LedgerFingerprintKeeperOptions = {}) {
    this.ledgerPath = ledgerPath;
    this.recordPath = opts.recordPath ?? fingerprintPathFor(ledgerPath);
    this.now = opts.now ?? (() => new Date());
    this.onMismatch = opts.onMismatch;
    this.onRestored = opts.onRestored;
  }

  /**
   * Bring the fingerprints up to the file as it is now and return them. `full` hashes from the
   * first byte whatever was read before. Never throws: a read or write that fails leaves the last
   * good state in place and is reported as `unread` with the error.
   */
  sync(opts: { full?: boolean } = {}): LedgerFingerprintStatus {
    try {
      this.read(opts.full === true);
      this.error = null;
    } catch (err) {
      this.error = String(err instanceof Error ? err.message : err);
    }
    return this.status();
  }

  /**
   * End the chain before the ledger is archived or has lines moved out of it. Call it first, then
   * archive. `archivedTo` is where the old lines go, when the caller knows.
   */
  restart(reason: string, atIso: string, archivedTo: string | null): void {
    this.sync();
    const cur = this.current();
    const open = this.error === null ? this.fingerprinter.open() : null;
    const closing = open ? { day: open.day, lines: open.lines, bytes: open.bytes, ledgerSha256: open.ledgerSha256, previous: open.previous, sha256: open.sha256 } : null;
    const ended = { at: atIso, reason, archivedTo: archivedTo ? basename(archivedTo) : null, closing, intact: cur.standing === null && this.error === null };
    this.append({ type: "restart", chain: cur.chain, ...ended });
    cur.ended = ended;
    this.chains.push({ chain: cur.chain + 1, days: [], mismatches: [], standing: null, ended: null });
    this.started = false;
  }

  status(): LedgerFingerprintStatus {
    const cur = this.current();
    const snap = this.fingerprinter.snapshot();
    return {
      state: cur.standing ? "mismatch" : this.error !== null ? "unread" : "ok",
      chain: cur.chain,
      days: cur.days.slice(),
      open: this.started ? snap.open : null,
      pendingBytes: this.started ? snap.pendingBytes : 0,
      mismatch: cur.standing,
      earlier: this.chains.slice(0, -1),
      mismatches: cur.mismatches.slice(),
      fullCheckAt: this.fullCheckAt,
      error: this.error,
    };
  }

  private current(): FingerprintChain {
    return this.chains[this.chains.length - 1];
  }

  private read(full: boolean): void {
    let fd: number | null = null;
    try {
      let size = 0;
      let id: string | null = null;
      if (existsSync(this.ledgerPath)) {
        fd = openSync(this.ledgerPath, "r");
        const st = fstatSync(fd);
        size = st.size;
        id = `${st.dev}:${st.ino}`;
      }
      const fromStart = full || !this.started || id !== this.fileId || size < this.offset;
      // a pass from the first byte is built aside and swapped in whole: a read that fails halfway leaves the last good state
      const fingerprinter = fromStart ? new LedgerFingerprinter() : this.fingerprinter;
      let pos = fromStart ? 0 : this.offset;
      if (fd !== null && pos < size) {
        const buf = Buffer.allocUnsafe(Math.min(READ_CHUNK, size - pos));
        try {
          while (pos < size) {
            const n = readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
            if (n <= 0) break;
            fingerprinter.update(buf.subarray(0, n));
            pos += n;
          }
        } catch (err) {
          // a tail half fed cannot be fed again: the next sync starts from the first byte
          if (!fromStart) this.started = false;
          throw err;
        }
      }
      if (fromStart) this.chains = replayFingerprintFile(existsSync(this.recordPath) ? readFileSync(this.recordPath, "utf8") : "");
      this.fingerprinter = fingerprinter;
      this.offset = pos;
      this.fileId = id;
      this.started = true;
      this.reconcile(fromStart);
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }

  /** Compare what the file gives with what was published; record a finding or the new days, never both. */
  private reconcile(fullPass: boolean): void {
    const cur = this.current();
    const computed = this.fingerprinter.days();
    const diff = firstDifference(cur.days, computed);
    const at = this.now().toISOString();
    if (fullPass) this.fullCheckAt = at;
    if (diff) {
      const finding: FingerprintMismatch = { at, day: diff.day, published: diff.published, found: diff.found };
      const isNew = !cur.standing || !sameFinding(cur.standing, finding);
      if (isNew) {
        cur.mismatches.push(finding);
        cur.standing = finding;
      }
      // told before the line is written: a disk that refuses the line must not also swallow the alarm
      if (isNew || fullPass) this.tell(this.onMismatch, cur.standing as FingerprintMismatch);
      if (isNew) this.append({ type: "mismatch", chain: cur.chain, ...finding });
      return;
    }
    if (cur.standing) {
      const was = cur.standing;
      this.append({ type: "restored", chain: cur.chain, at });
      cur.standing = null;
      this.tell(this.onRestored, was);
    }
    for (const d of computed.slice(cur.days.length)) {
      const published = { ...d, publishedAt: at };
      this.append({ type: "day", chain: cur.chain, ...published });
      cur.days.push(published);
    }
  }

  private tell(fn: ((m: FingerprintMismatch) => void) | undefined, m: FingerprintMismatch): void {
    try {
      fn?.(m);
    } catch {
      // a listener that throws must not stop the record being kept
    }
  }

  private append(record: FingerprintFileRecord): void {
    mkdirSync(dirname(this.recordPath), { recursive: true });
    appendFileSync(this.recordPath, `${JSON.stringify(record)}\n`, "utf8");
  }
}
