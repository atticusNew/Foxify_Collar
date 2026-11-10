#!/usr/bin/env tsx
/**
 * LEDGER FINGERPRINT CHECK. Reads a copy of an event ledger (an operator export, a nightly
 * backup, an archived file) and prints the same daily fingerprints the record service publishes.
 * With --expect it compares them with a published list and says whether the copy is the history
 * that was published. The scheme is written out in src/eventCollar/crossVenue/ledgerFingerprint.ts.
 * Reads one file, writes nothing, sends nothing but one GET when --expect is a URL. Needs Node 18
 * or later and nothing else beyond this repository's own runner (tsx).
 *
 * THE FOUNDER, from the repository root:
 *
 *   # a fresh export of the record's ledger (operator token), or last night's backup file
 *   curl -s -H "x-admin-token: $EVENT_X_ADMIN_TOKEN" https://atticus-event-shadow.onrender.com/api/shadow/export > ledger.jsonl
 *
 *   # print its daily fingerprints
 *   npx tsx services/api/scripts/eventLedgerFingerprint.ts ledger.jsonl
 *
 *   # compare with what the record publishes now, or with a list saved earlier
 *   npx tsx services/api/scripts/eventLedgerFingerprint.ts ledger.jsonl --expect https://atticus-event-shadow.onrender.com/api/shadow/fingerprints
 *   npx tsx services/api/scripts/eventLedgerFingerprint.ts ledger.jsonl --expect fingerprints-2026-11-10.json
 *
 *   # a ledger archived by a reset is compared with the chain it belonged to (the list's "restarts")
 *   npx tsx services/api/scripts/eventLedgerFingerprint.ts event-shadow-ledger.2026-11-10T013000Z.archived.jsonl --expect <list> --chain 1
 *
 *   # a lock ledger: export it with ?ledger=lock (and &holder=<alias>), fetch its list from the same
 *   # route with the operator token (it is not public), and compare the two files
 *   curl -s -H "x-admin-token: $EVENT_X_ADMIN_TOKEN" "https://atticus-event-shadow.onrender.com/api/shadow/fingerprints?ledger=lock" > lock-fingerprints.json
 *
 * The answer is in the last line and in the exit code:
 *   0  every published day is reproduced by this file
 *   1  a day differs; the first one is named, with what was published and what this file gives
 *   2  the check could not be run (a file or the list could not be read)
 *   3  no day differs, but the file stops before the published list does: an older copy, or one
 *      cut short. The first day it does not reach is named.
 *
 * AN OUTSIDER GIVEN AN EXPORT. The raw ledger is not public (it carries holder aliases), so this
 * check is run by the operator, or by someone the operator hands a copy to: a venue, an investor's
 * diligence, an auditor. That person needs the copy and a list of fingerprints they trust, best of
 * all one they saved themselves from the public route on an earlier day. Two ways to run it:
 *
 *   with this script: Node 18 or later, this file and src/eventCollar/crossVenue/ledgerFingerprint.ts
 *   kept in the same folders relative to each other, then the commands above.
 *
 *   with no code of ours, for any day on the list (day, lines, bytes, ledgerSha256, previous, sha256):
 *     head -c <bytes> ledger.jsonl | sha256sum      prints ledgerSha256
 *     head -c <bytes> ledger.jsonl | wc -l          prints lines
 *     printf 'earn-and-protect ledger fingerprint v1\nprevious %s\nday %s\nlines %s\nbytes %s\nledger %s\n' \
 *       <previous> <day> <lines> <bytes> <ledgerSha256> | sha256sum      prints sha256
 *   and `previous` is the sha256 of the day before on the list (64 zeros for the first day). The
 *   last line inside the first <bytes> bytes is dated that day or earlier, and the line after it
 *   is dated later: that is where the day ends.
 *
 * WHAT A MATCH MEANS. The copy is, byte for byte, the history the fingerprints were published for.
 * It does not mean a line was true when it was written, and a fingerprint binds only from the day
 * it was first published (publishedAt on the list).
 */

import { closeSync, fstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LedgerFingerprinter, firstDifference, publishedDaysFrom, type FingerprintCore, type LedgerFingerprints } from "../src/eventCollar/crossVenue/ledgerFingerprint";

export const EXIT_MATCH = 0;
export const EXIT_DIFFERS = 1;
export const EXIT_NOT_RUN = 2;
export const EXIT_STOPS_SHORT = 3;

const USAGE = "usage: npx tsx services/api/scripts/eventLedgerFingerprint.ts <ledger.jsonl> [--expect <json file or URL>] [--chain <n>] [--json]";

/** The fingerprints of a file, read in pieces so a large ledger is never held in memory whole. */
export function fingerprintFile(path: string): LedgerFingerprints {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const f = new LedgerFingerprinter();
    const buf = Buffer.allocUnsafe(Math.max(1, Math.min(4 * 1024 * 1024, size)));
    let pos = 0;
    while (pos < size) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
      if (n <= 0) break;
      f.update(buf.subarray(0, n));
      pos += n;
    }
    return f.snapshot();
  } finally {
    closeSync(fd);
  }
}

const num = (n: number): string => n.toLocaleString("en-US");
const coreLine = (c: FingerprintCore): string => `${c.day}  ${num(c.lines)} lines  ${num(c.bytes)} bytes  ${c.sha256}`;

async function readExpected(source: string, fetchImpl: typeof fetch): Promise<unknown> {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetchImpl(source, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`${source} answered ${res.status}`);
    return (await res.json()) as unknown;
  }
  return JSON.parse(readFileSync(source, "utf8")) as unknown;
}

/**
 * The check as a function: arguments in, lines out, the exit code back. `fetchImpl` is the one
 * thing replaced in tests.
 */
export async function runLedgerFingerprint(argv: readonly string[], out: (line: string) => void, fetchImpl: typeof fetch = fetch): Promise<number> {
  let file: string | null = null;
  let expect: string | null = null;
  let chain: number | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--expect" || a === "--chain") {
      const v = argv[i + 1];
      if (v === undefined) {
        out(`${a} needs a value`);
        out(USAGE);
        return EXIT_NOT_RUN;
      }
      i += 1;
      if (a === "--expect") expect = v;
      else if (/^[1-9]\d*$/.test(v)) chain = Number(v);
      else {
        out(`--chain takes a whole number, 1 or more; got ${v}`);
        return EXIT_NOT_RUN;
      }
    } else if (a === "--json") json = true;
    else if (a.startsWith("--")) {
      out(`unknown option ${a}`);
      out(USAGE);
      return EXIT_NOT_RUN;
    } else if (file === null) file = a;
    else {
      out(`one ledger file at a time; got ${file} and ${a}`);
      return EXIT_NOT_RUN;
    }
  }
  if (file === null) {
    out(USAGE);
    return EXIT_NOT_RUN;
  }

  let got: LedgerFingerprints;
  try {
    got = fingerprintFile(file);
  } catch (err) {
    out(`could not read ${file}: ${String(err instanceof Error ? err.message : err)}`);
    return EXIT_NOT_RUN;
  }

  if (json) out(JSON.stringify({ days: got.days, open: got.open, pendingBytes: got.pendingBytes }, null, 2));
  else {
    const end = got.open;
    out(`${file}: ${num(end?.lines ?? 0)} lines, ${num(end?.bytes ?? 0)} bytes, ${got.days.length} closed day${got.days.length === 1 ? "" : "s"}`);
    for (const d of got.days) out(coreLine(d));
    if (end) out(`${end.day ?? "undated"}  ${num(end.lines)} lines  ${num(end.bytes)} bytes  ${end.sha256}  (open day, not final)`);
    if (got.pendingBytes > 0) out(`${num(got.pendingBytes)} bytes after the last newline are an unfinished line and are covered by no fingerprint.`);
  }
  if (expect === null) return EXIT_MATCH;

  let body: unknown;
  try {
    body = await readExpected(expect, fetchImpl);
  } catch (err) {
    out(`could not read the published list from ${expect}: ${String(err instanceof Error ? err.message : err)}`);
    return EXIT_NOT_RUN;
  }
  const list = publishedDaysFrom(body, chain);
  if ("error" in list) {
    out(`could not read the published list from ${expect}: ${list.error}`);
    return EXIT_NOT_RUN;
  }
  const published = list.days;
  const n = Math.min(published.length, got.days.length);
  const differs = (d: { day: string; published: FingerprintCore; found: FingerprintCore | null }, matched: number): number => {
    if (matched > 0) out(`The ${matched} day${matched === 1 ? "" : "s"} before it match${matched === 1 ? "es" : ""}.`);
    out(`published  ${coreLine(d.published)}`);
    out(d.found ? `this file  ${coreLine(d.found)}` : "this file  has no such day");
    if (matched === 0 && chain === undefined && list.chains.length > 0) out(`The list also carries ${list.chains.length} earlier chain${list.chains.length === 1 ? "" : "s"} (ledgers archived by a reset). If this file is an archived ledger, compare it with --chain ${list.chains.join(" or --chain ")}.`);
    out(`DIFFERS at ${d.day}: this file is not the history that was published for that day.`);
    return EXIT_DIFFERS;
  };

  const diff = firstDifference(published.slice(0, n), got.days.slice(0, n));
  if (diff) return differs(diff, diff.index);

  if (published.length > n) {
    // The file closes fewer days than were published. If it is simply older it ends inside the next
    // published day; if it reaches that day's end or beyond without reproducing it, it differs.
    const next = published[n];
    const end = got.open;
    const endCore: FingerprintCore | null = end && end.day !== null ? { day: end.day, lines: end.lines, bytes: end.bytes, sha256: end.sha256 } : null;
    const sameAsNext = endCore !== null && endCore.day === next.day && endCore.lines === next.lines && endCore.bytes === next.bytes && endCore.sha256 === next.sha256;
    if (end && end.bytes >= next.bytes && !sameAsNext) return differs({ day: next.day, published: next, found: endCore }, n);
    const reached = sameAsNext ? n + 1 : n;
    if (reached === published.length) {
      out(`MATCH: all ${reached} published day${reached === 1 ? "" : "s"}, ${published[0].day} to ${published[reached - 1].day}; the file ends on the last line of ${next.day}.`);
      return EXIT_MATCH;
    }
    const first = published[reached];
    out(
      reached > 0
        ? `The ${reached} day${reached === 1 ? "" : "s"} this file reaches, ${published[0].day} to ${published[reached - 1].day}, match${reached === 1 ? "es" : ""}.`
        : "This file reaches no published day.",
    );
    out(`STOPS SHORT at ${first.day}: the file ends before that day's last line, so ${first.day} and ${published.length - reached - 1} later published day${published.length - reached - 1 === 1 ? "" : "s"} were not checked. An older copy does this; so does a copy that was cut short.`);
    return EXIT_STOPS_SHORT;
  }

  if (published.length === 0) {
    out("The published list has no closed day yet, so there is nothing to compare.");
    return EXIT_MATCH;
  }
  if (list.closing) {
    // an archived ledger: the list also carries the whole file's fingerprint at the moment it was archived
    const end = got.open;
    const same = end !== null && end.day === list.closing.day && end.lines === list.closing.lines && end.bytes === list.closing.bytes && end.sha256 === list.closing.sha256;
    if (!same) return differs({ day: list.closing.day, published: list.closing, found: end && end.day !== null ? { day: end.day, lines: end.lines, bytes: end.bytes, sha256: end.sha256 } : null }, n);
    out(`MATCH: all ${n} published day${n === 1 ? "" : "s"}, ${published[0].day} to ${published[n - 1].day}, and the whole file as it stood when it was archived.`);
    return EXIT_MATCH;
  }
  const extra = got.days.length - n;
  out(`MATCH: all ${n} published day${n === 1 ? "" : "s"}, ${published[0].day} to ${published[n - 1].day}.${extra > 0 ? ` This file has ${extra} closed day${extra === 1 ? "" : "s"} after that, newer than the list.` : ""}`);
  return EXIT_MATCH;
}

/** Whether this file is the command being run (and not imported by a test), whatever links the path went through. */
function invokedDirectly(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  runLedgerFingerprint(process.argv.slice(2), (line) => console.log(line)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(String(err instanceof Error ? err.message : err));
      process.exitCode = EXIT_NOT_RUN;
    },
  );
}
