/**
 * LEDGER FINGERPRINT. One SHA-256 per UTC day the ledger has lines for, each chained to the day
 * before, so that an outsider who saved a fingerprint can later tell whether the history behind it
 * was changed. Pure: bytes in, fingerprints out. The file reading, the small record of what was
 * published and the comparison live in ledgerFingerprintKeeper.ts; the check anyone can run is
 * scripts/eventLedgerFingerprint.ts. Nothing here writes to a ledger.
 *
 * THE SCHEME (v1), in the order a checker needs it.
 *
 * 1. Lines. The ledger is taken as bytes, in file order. A line is every byte up to and including
 *    a newline (0x0A), blank lines included, so the line count is what `wc -l` prints. Bytes after
 *    the last newline are an unfinished line: not counted, not covered, reported as pending. The
 *    writers append `JSON + "\n"` in one synchronous call, so an export never ends in one.
 *
 * 2. The day of a line. The line is decoded as UTF-8 and parsed as JSON. If it is an object whose
 *    top-level `at` is a string of the exact form `YYYY-MM-DDTHH:MM:SS[.fraction]Z` naming a real
 *    date and time, the line's own day is its first ten characters. Every record type on the event
 *    ledgers carries `at` (shadowLedger.ts). Anything else (no `at`, another form, not JSON, not an
 *    object) has no day of its own. The form is strict on purpose: a lenient date parser reads
 *    differently in different languages, and a checker written elsewhere must agree with this one.
 *
 * 3. The day a line is counted in. The current day is the latest own day seen so far, reading
 *    from the top. A line whose own day is later than the current day starts that day; every other
 *    line (same day, an earlier day, no day) is counted in the current day. Lines before the first
 *    dated line are counted in that first day. So days only move forward, a late or undated or
 *    broken line never reopens a day, and the answer depends on nothing but the bytes and their
 *    order. A day with no lines has no fingerprint; the chain steps over it.
 *
 *    Why the line's own `at` and not the hour the service saw it: a fingerprint must be
 *    recomputable from a copy of the file alone, by someone who was not there.
 *
 * 4. When a day is closed. A day is closed, and its fingerprint final, once a line of a later day
 *    follows it in the file. Not by the clock: a line stamped 23:59:59 is routinely written a few
 *    seconds after midnight, and under rule 3 it is counted in the day it was stamped. Closing by
 *    the clock would publish a fingerprint and then change it. Closing on the next day's first
 *    line means a closed day can never change by an append. The last day in the file is always
 *    open; its fingerprint is a running one, marked not final, and moves with every line.
 *
 * 5. The numbers of a day D: `lines` and `bytes` are the count of lines and bytes from the start of
 *    the file to the end of D's last line; `ledgerSha256` is the plain SHA-256 of exactly those
 *    bytes (`head -c <bytes> ledger.jsonl | sha256sum`); `previous` is the fingerprint of the
 *    closed day before it, or 64 zeros for the first; and the fingerprint itself, `sha256`, is the
 *    SHA-256 of this text, each line ending in a newline:
 *
 *        earn-and-protect ledger fingerprint v1
 *        previous <previous>
 *        day <YYYY-MM-DD>
 *        lines <lines>
 *        bytes <bytes>
 *        ledger <ledgerSha256>
 *
 *    `ledgerSha256` already commits to every earlier byte, so changing or removing any earlier
 *    line changes it for that day and every later one. The explicit link to `previous` adds what
 *    the bytes alone do not carry: where each day ended and what was published for it. Hashing the
 *    whole prefix rather than each day's slice costs a re-read from the top on start-up (the hash
 *    state cannot be saved), which the start-up comparison needs anyway, and buys a check that
 *    needs no code of ours: two shell commands per day.
 *
 * WHAT IT PROVES, AND TO WHOM. A fingerprint is a commitment. Someone who saved one, and is later
 * given a copy of the ledger, can recompute it; if it matches, every byte up to that day's last
 * line is what it was when the fingerprint was published. Someone who only watches the page can
 * see that a day's fingerprint never changes; a change is the evidence. It binds the operator only
 * as far as copies exist outside the operator's disk: this service keeps both the ledger and the
 * record of what it published, so its own comparison catches accidents, a damaged disk and changes
 * by anyone else, and cannot bind a person who controls both files. Saved copies do that.
 *
 * WHAT IT DOES NOT PROVE. That a line was true when it was written, or that nothing was left out
 * at the time. Anything about the open day. Anything earlier than the first publication: a
 * fingerprint binds from the moment it was first published, so history written before the first
 * publication is committed as of that moment, not as of its own dates. And the full check needs
 * the raw ledger, which only the operator can export (it carries holder aliases): the operator, or
 * someone the operator hands an export or a backup to, can run it; the public can hold the
 * operator to it.
 *
 * ISOLATION: node:crypto only; no imports outside src/eventCollar/**.
 */

import { createHash, type Hash } from "node:crypto";

export const FINGERPRINT_VERSION = "v1";
/** `previous` of the first day of a chain */
export const FINGERPRINT_GENESIS = "0".repeat(64);
/** the day word in a running fingerprint taken before any line carried a date */
export const UNDATED = "undated";

export interface DayFingerprint {
  /** UTC day, YYYY-MM-DD */
  day: string;
  /** lines from the start of the file to the end of this day's last line */
  lines: number;
  /** bytes over the same span */
  bytes: number;
  /** plain SHA-256 of those bytes */
  ledgerSha256: string;
  /** the fingerprint of the closed day before, or 64 zeros */
  previous: string;
  /** the fingerprint */
  sha256: string;
}

/** The open day's fingerprint: the same arithmetic over every finished line so far. Moves with every append. */
export interface RunningFingerprint extends Omit<DayFingerprint, "day"> {
  /** null while no line has carried a date */
  day: string | null;
  final: false;
}

export interface LedgerFingerprints {
  /** closed days, oldest first; final */
  days: DayFingerprint[];
  /** the open day; null on an empty ledger */
  open: RunningFingerprint | null;
  /** bytes after the last newline: an unfinished line, covered by nothing */
  pendingBytes: number;
}

export function fingerprintText(previous: string, day: string, lines: number, bytes: number, ledgerSha256: string): string {
  return `earn-and-protect ledger fingerprint ${FINGERPRINT_VERSION}\nprevious ${previous}\nday ${day}\nlines ${lines}\nbytes ${bytes}\nledger ${ledgerSha256}\n`;
}

export function fingerprintOf(previous: string, day: string, lines: number, bytes: number, ledgerSha256: string): string {
  return createHash("sha256").update(fingerprintText(previous, day, lines, bytes, ledgerSha256), "utf8").digest("hex");
}

const AT_FORM = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** The UTC day a timestamp names, when it has the one accepted form and names a real instant. */
export function utcDayOf(at: unknown): string | null {
  if (typeof at !== "string") return null;
  const m = AT_FORM.exec(at);
  if (!m) return null;
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  // 2026-02-30 is read by some engines as 2 March; a day that does not round-trip is not a day
  return new Date(ms).toISOString().slice(0, 10) === m[1] ? m[1] : null;
}

/** A line's own day (rule 2), or null. */
export function dayOfLine(line: Uint8Array): string | null {
  let rec: unknown;
  try {
    rec = JSON.parse(Buffer.from(line.buffer, line.byteOffset, line.byteLength).toString("utf8"));
  } catch {
    return null;
  }
  if (rec === null || typeof rec !== "object" || Array.isArray(rec)) return null;
  return utcDayOf((rec as { at?: unknown }).at);
}

/**
 * The fingerprints of a ledger read in pieces. Feed it the file's bytes in order, in chunks of any
 * size; it keeps the running hash, so an append costs only the appended bytes. It cannot go back:
 * a file that shrank or was replaced needs a new one, fed from the first byte.
 */
export class LedgerFingerprinter {
  private readonly hash: Hash = createHash("sha256");
  private carry: Buffer = Buffer.alloc(0);
  private day: string | null = null;
  private previous = FINGERPRINT_GENESIS;
  private lineCount = 0;
  private byteCount = 0;
  private readonly closed: DayFingerprint[] = [];

  update(chunk: Uint8Array): void {
    const data = this.carry.length > 0 ? Buffer.concat([this.carry, chunk]) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let start = 0;
    for (;;) {
      const nl = data.indexOf(0x0a, start);
      if (nl === -1) break;
      this.line(data.subarray(start, nl + 1));
      start = nl + 1;
    }
    // copied: the caller may reuse its buffer for the next read
    this.carry = Buffer.from(data.subarray(start));
  }

  private line(line: Buffer): void {
    const own = dayOfLine(line);
    if (own !== null && (this.day === null || own > this.day)) {
      if (this.day !== null) {
        const done = this.at(this.day);
        this.closed.push(done);
        this.previous = done.sha256;
      }
      this.day = own;
    }
    this.hash.update(line);
    this.lineCount += 1;
    this.byteCount += line.length;
  }

  private at(day: string): DayFingerprint {
    const ledgerSha256 = this.hash.copy().digest("hex");
    return { day, lines: this.lineCount, bytes: this.byteCount, ledgerSha256, previous: this.previous, sha256: fingerprintOf(this.previous, day, this.lineCount, this.byteCount, ledgerSha256) };
  }

  /** closed days so far, oldest first */
  days(): DayFingerprint[] {
    return this.closed.slice();
  }

  open(): RunningFingerprint | null {
    if (this.lineCount === 0) return null;
    const { day: _day, ...rest } = this.at(this.day ?? UNDATED);
    return { day: this.day, ...rest, final: false };
  }

  /** bytes of finished lines taken in */
  coveredBytes(): number {
    return this.byteCount;
  }

  pendingBytes(): number {
    return this.carry.length;
  }

  snapshot(): LedgerFingerprints {
    return { days: this.days(), open: this.open(), pendingBytes: this.pendingBytes() };
  }
}

/** The fingerprints of a whole ledger held in memory. */
export function fingerprintLedger(bytes: Uint8Array): LedgerFingerprints {
  const f = new LedgerFingerprinter();
  f.update(bytes);
  return f.snapshot();
}

/** the fields two fingerprints of one day must agree on */
export type FingerprintCore = Pick<DayFingerprint, "day" | "lines" | "bytes" | "sha256">;

export interface FingerprintDifference {
  /** position in the published list */
  index: number;
  /** the published day that the ledger no longer hashes to */
  day: string;
  published: FingerprintCore;
  /** what the ledger gives at that position; null when the ledger no longer reaches it */
  found: FingerprintCore | null;
}

const core = (d: FingerprintCore): FingerprintCore => ({ day: d.day, lines: d.lines, bytes: d.bytes, sha256: d.sha256 });
const sameCore = (a: FingerprintCore, b: FingerprintCore): boolean => a.day === b.day && a.lines === b.lines && a.bytes === b.bytes && a.sha256 === b.sha256;

/**
 * The first published day the ledger does not reproduce, or null when every published day is
 * reproduced. A ledger with more closed days than were published is not a difference (they are
 * new); one with fewer is (the published history is no longer all there).
 */
export function firstDifference(published: readonly FingerprintCore[], computed: readonly FingerprintCore[]): FingerprintDifference | null {
  for (let i = 0; i < published.length; i += 1) {
    const found = computed[i];
    if (!found || !sameCore(published[i], found)) return { index: i, day: published[i].day, published: core(published[i]), found: found ? core(found) : null };
  }
  return null;
}

// ── the record of what was published (the small append-only file beside the ledger) ─────────────

/** A closed day as first recorded. */
export interface PublishedDay extends DayFingerprint {
  /** when the service first recorded it, which is when it first answered with it; ISO UTC */
  publishedAt: string;
}

/** The ledger stopped hashing to a published day. Written once per finding, never acted on. */
export interface FingerprintMismatch {
  at: string;
  day: string;
  published: FingerprintCore;
  found: FingerprintCore | null;
}

/** The whole file as it stood when a chain ended: the running fingerprint at that moment. */
export type ClosingFingerprint = Omit<RunningFingerprint, "final">;

export type FingerprintFileRecord =
  | ({ type: "day"; chain: number } & PublishedDay)
  | ({ type: "mismatch"; chain: number } & FingerprintMismatch)
  /** a later check found the ledger hashing to every published day again (a file put back from a copy) */
  | { type: "restored"; chain: number; at: string }
  /**
   * The operator archived the ledger, or moved some of its lines to an archive (ledgerArchive.ts).
   * Written before the file changes. It ends the chain: the days published so far stay on the
   * list as they were, and the file that follows is fingerprinted from its first byte as a new chain.
   */
  | { type: "restart"; chain: number; at: string; reason: string; archivedTo: string | null; closing: ClosingFingerprint | null; intact: boolean };

export interface FingerprintChain {
  /** 1 for the first ledger, one more after every restart */
  chain: number;
  days: PublishedDay[];
  /** every mismatch written, oldest first */
  mismatches: FingerprintMismatch[];
  /** the mismatch still standing: the last one not followed by a "restored" line */
  standing: FingerprintMismatch | null;
  /** how the chain ended; null for the current one */
  ended: { at: string; reason: string; archivedTo: string | null; closing: ClosingFingerprint | null; intact: boolean } | null;
}

const isHex64 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

function coreOf(v: unknown): FingerprintCore | null {
  if (v === null || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  return isDay(r.day) && isCount(r.lines) && isCount(r.bytes) && isHex64(r.sha256) ? { day: r.day, lines: r.lines, bytes: r.bytes, sha256: r.sha256 } : null;
}

function closingOf(v: unknown): ClosingFingerprint | null {
  if (v === null || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (!(r.day === null || isDay(r.day)) || !isCount(r.lines) || !isCount(r.bytes) || !isHex64(r.sha256) || !isHex64(r.ledgerSha256) || !isHex64(r.previous)) return null;
  return { day: r.day, lines: r.lines, bytes: r.bytes, ledgerSha256: r.ledgerSha256, previous: r.previous, sha256: r.sha256 };
}

/**
 * Replay the record file. Lines that do not parse or are not one of ours are skipped. The first
 * line written for a day stands: a second line for the same or an earlier day is ignored, since a
 * fingerprint binds from its first publication. Always returns at least one chain; the last is
 * the current one.
 */
export function replayFingerprintFile(text: string): FingerprintChain[] {
  const fresh = (chain: number): FingerprintChain => ({ chain, days: [], mismatches: [], standing: null, ended: null });
  const chains: FingerprintChain[] = [fresh(1)];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let r: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      r = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const cur = chains[chains.length - 1];
    const at = typeof r.at === "string" ? r.at : "";
    if (r.type === "day") {
      const c = coreOf(r);
      if (!c || !isHex64(r.ledgerSha256) || !isHex64(r.previous) || typeof r.publishedAt !== "string") continue;
      const last = cur.days[cur.days.length - 1];
      if (last && c.day <= last.day) continue;
      cur.days.push({ ...c, ledgerSha256: r.ledgerSha256, previous: r.previous, publishedAt: r.publishedAt });
    } else if (r.type === "mismatch") {
      const published = coreOf(r.published);
      if (!published || !isDay(r.day)) continue;
      const m: FingerprintMismatch = { at, day: r.day, published, found: coreOf(r.found) };
      cur.mismatches.push(m);
      cur.standing = m;
    } else if (r.type === "restored") {
      cur.standing = null;
    } else if (r.type === "restart") {
      cur.ended = { at, reason: typeof r.reason === "string" ? r.reason : "", archivedTo: typeof r.archivedTo === "string" ? r.archivedTo : null, closing: closingOf(r.closing), intact: r.intact === true };
      chains.push(fresh(cur.chain + 1));
    }
  }
  return chains;
}

// ── what a reader is given ──────────────────────────────────────────────────────────────────────

/** A ledger's fingerprints as the service holds them: what was published, what the file gives now. */
export interface LedgerFingerprintStatus {
  /** "mismatch": the ledger no longer hashes to a published day. "unread": the last read failed. */
  state: "ok" | "mismatch" | "unread";
  chain: number;
  /** the current chain's days as first published, oldest first */
  days: PublishedDay[];
  open: RunningFingerprint | null;
  pendingBytes: number;
  mismatch: FingerprintMismatch | null;
  /** chains that ended in a restart, oldest first */
  earlier: FingerprintChain[];
  /** every mismatch ever written on the current chain */
  mismatches: FingerprintMismatch[];
  /** the last time the whole file was hashed from its first byte and compared */
  fullCheckAt: string | null;
  error: string | null;
}

export const FINGERPRINT_SCHEME = {
  version: FINGERPRINT_VERSION,
  line: "Every byte up to and including a newline is one line, blank lines included. Bytes after the last newline are an unfinished line and are not covered.",
  day: "A line's own day is the first ten characters of its top-level `at` (YYYY-MM-DDTHH:MM:SS[.fraction]Z). Reading from the top, a line whose own day is later than any before it starts that day; every other line, dated earlier or not dated at all, is counted in the day already running. A day is closed once a line of a later day follows it; the last day in the file is open and its fingerprint is not final.",
  ledgerSha256: "The plain SHA-256 of the first `bytes` bytes of the ledger file: head -c <bytes> ledger.jsonl | sha256sum",
  sha256: "The SHA-256 of six lines of text, each ending in a newline: `earn-and-protect ledger fingerprint v1`, `previous <previous>`, `day <day>`, `lines <lines>`, `bytes <bytes>`, `ledger <ledgerSha256>`. `previous` is the fingerprint of the closed day before, or 64 zeros for the first day.",
} as const;

export const FINGERPRINT_PROVES =
  "A fingerprint commits to every byte of the ledger up to that day's last line and to every fingerprint before it. Anyone who saved one and has a copy of the ledger can recompute it: a match shows that history has not been changed since the fingerprint was first published (publishedAt). " +
  "It does not show that a line was true when it was written. A fingerprint binds only from its first publication, so history written before then is committed as of that moment, not earlier. The open day is not final. " +
  "The raw ledger carries private details and is exported by the operator only, so the full check can be run by the operator and by anyone the operator gives a copy to; everyone else can save the fingerprints and hold the operator to them.";

/** The plain sentences a reader is shown when the ledger no longer hashes to a published day: the page, /healthz. */
export function mismatchWords(day: string): string {
  return `The ledger no longer matches the fingerprint published for ${day}. The history up to that day was changed after it was published, or the file is damaged. The published fingerprints are kept as they were and nothing has been repaired.`;
}

const publicChain = (c: FingerprintChain) => ({
  chain: c.chain,
  restartedAt: c.ended?.at ?? null,
  reason: c.ended?.reason ?? null,
  // false when the ledger did not hash to its published days at the moment it was archived
  intact: c.ended?.intact ?? null,
  days: c.days,
  closing: c.ended?.closing ?? null,
});

/**
 * The JSON a reader is given. Public by default: fingerprints, counts and dates, no path and no
 * file name. `operator` adds the mismatch history, the archive names and the last read error.
 */
export function fingerprintReport(s: LedgerFingerprintStatus, opts: { atIso: string; operator?: boolean }): Record<string, unknown> {
  return {
    ok: true,
    at: opts.atIso,
    scheme: FINGERPRINT_SCHEME,
    proves: FINGERPRINT_PROVES,
    state: s.state,
    ...(s.mismatch ? { mismatch: s.mismatch } : {}),
    chain: s.chain,
    latest: s.days[s.days.length - 1] ?? null,
    days: s.days,
    open: s.open,
    restarts: s.earlier.map(publicChain),
    ...(opts.operator
      ? {
          operator: {
            pendingBytes: s.pendingBytes,
            fullCheckAt: s.fullCheckAt,
            error: s.error,
            mismatches: s.mismatches,
            archives: s.earlier.map((c) => ({ chain: c.chain, archivedTo: c.ended?.archivedTo ?? null, mismatches: c.mismatches })),
          },
        }
      : {}),
  };
}

/** The published list as the check reads it back: the route's body, or a bare array of days. */
export function publishedDaysFrom(body: unknown, chain?: number): { days: FingerprintCore[]; closing: FingerprintCore | null; chains: number[] } | { error: string } {
  const list = (v: unknown): FingerprintCore[] | null => {
    if (!Array.isArray(v)) return null;
    const out: FingerprintCore[] = [];
    for (const d of v) {
      const c = coreOf(d);
      if (!c) return null;
      out.push(c);
    }
    return out;
  };
  if (Array.isArray(body)) {
    const days = list(body);
    return days ? { days, closing: null, chains: [] } : { error: "the list has an entry that is not a day's fingerprint (day, lines, bytes, sha256)" };
  }
  if (body === null || typeof body !== "object") return { error: "not a list of daily fingerprints" };
  const b = body as Record<string, unknown>;
  const restarts = Array.isArray(b.restarts) ? (b.restarts as Array<Record<string, unknown>>) : [];
  const chains = restarts.map((r) => r.chain).filter((n): n is number => typeof n === "number");
  if (chain !== undefined && chain !== b.chain) {
    const hit = restarts.find((r) => r.chain === chain);
    if (!hit) return { error: `the published list has no chain ${chain}` };
    const days = list(hit.days);
    if (!days) return { error: `chain ${chain} of the published list could not be read` };
    const closing = closingOf(hit.closing);
    return { days, closing: closing && closing.day !== null ? { day: closing.day, lines: closing.lines, bytes: closing.bytes, sha256: closing.sha256 } : null, chains };
  }
  const days = list(b.days);
  return days ? { days, closing: null, chains } : { error: "no `days` list of daily fingerprints (day, lines, bytes, sha256)" };
}
