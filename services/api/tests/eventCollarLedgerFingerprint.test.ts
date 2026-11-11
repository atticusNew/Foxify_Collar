/**
 * Ledger fingerprint, the pure scheme: what is hashed, how a line gets its day, how the days
 * chain, that reading in pieces gives what reading whole gives, and the replay of the record of
 * what was published.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  FINGERPRINT_GENESIS,
  FINGERPRINT_PROVES,
  FINGERPRINT_SCHEME,
  LedgerFingerprinter,
  dayOfLine,
  fingerprintLedger,
  fingerprintOf,
  fingerprintReport,
  fingerprintText,
  firstDifference,
  mismatchWords,
  publishedDaysFrom,
  replayFingerprintFile,
  utcDayOf,
  type DayFingerprint,
  type LedgerFingerprintStatus,
  type PublishedDay,
} from "../src/eventCollar/crossVenue/ledgerFingerprint";

const sha = (b: string | Uint8Array): string => createHash("sha256").update(b).digest("hex");
const rec = (at: string, extra: Record<string, unknown> = {}): string => `${JSON.stringify({ type: "open", at, ticker: "KXTEST", ...extra })}\n`;
const bytesOf = (...lines: string[]): Buffer => Buffer.from(lines.join(""), "utf8");

/** three days of lines, the third open */
const LINES = [
  rec("2026-09-12T16:00:00.000Z", { n: 1 }),
  rec("2026-09-12T18:30:00.000Z", { n: 2 }),
  rec("2026-09-13T01:00:00.000Z", { n: 3 }),
  rec("2026-09-13T23:59:59.999Z", { n: 4 }),
  rec("2026-09-15T09:00:00.000Z", { n: 5 }),
  rec("2026-09-15T09:05:00.000Z", { n: 6 }),
];

test("ledger fingerprint: a day's numbers are the file's first bytes, hashed plainly, and the text written in the docstring", () => {
  const ledger = bytesOf(...LINES);
  const f = fingerprintLedger(ledger);
  assert.deepEqual(f.days.map((d) => d.day), ["2026-09-12", "2026-09-13"], "the 14th has no lines and no fingerprint; the 15th is open");
  assert.equal(f.pendingBytes, 0);

  const firstBytes = Buffer.byteLength(LINES[0] + LINES[1]);
  const first = f.days[0];
  assert.equal(first.lines, 2);
  assert.equal(first.bytes, firstBytes);
  assert.equal(first.ledgerSha256, sha(ledger.subarray(0, firstBytes)), "what `head -c <bytes> | sha256sum` prints");
  assert.equal(first.previous, "0".repeat(64));
  assert.equal(first.previous, FINGERPRINT_GENESIS);
  const text = `earn-and-protect ledger fingerprint v1\nprevious ${"0".repeat(64)}\nday 2026-09-12\nlines 2\nbytes ${firstBytes}\nledger ${first.ledgerSha256}\n`;
  assert.equal(fingerprintText(first.previous, first.day, first.lines, first.bytes, first.ledgerSha256), text);
  assert.equal(first.sha256, sha(text));
  assert.equal(first.sha256, fingerprintOf(first.previous, first.day, first.lines, first.bytes, first.ledgerSha256));

  const second = f.days[1];
  const secondBytes = firstBytes + Buffer.byteLength(LINES[2] + LINES[3]);
  assert.equal(second.lines, 4, "lines and bytes count from the first line of the file, not of the day");
  assert.equal(second.bytes, secondBytes);
  assert.equal(second.ledgerSha256, sha(ledger.subarray(0, secondBytes)));
  assert.equal(second.previous, first.sha256, "chained to the day before");
  assert.equal(second.sha256, sha(`earn-and-protect ledger fingerprint v1\nprevious ${first.sha256}\nday 2026-09-13\nlines 4\nbytes ${secondBytes}\nledger ${second.ledgerSha256}\n`));

  assert.ok(f.open);
  assert.equal(f.open.final, false, "the open day says it is not final");
  assert.equal(f.open.day, "2026-09-15");
  assert.equal(f.open.lines, 6);
  assert.equal(f.open.bytes, ledger.length);
  assert.equal(f.open.ledgerSha256, sha(ledger), "the running fingerprint covers every finished line so far");
  assert.equal(f.open.previous, second.sha256);
  assert.equal(f.open.sha256, fingerprintOf(second.sha256, "2026-09-15", 6, ledger.length, sha(ledger)));
});

test("ledger fingerprint: changing or removing any earlier line changes that day and every later one, and nothing before it", () => {
  const base = fingerprintLedger(bytesOf(...LINES));
  const all = (f: ReturnType<typeof fingerprintLedger>): string[] => [...f.days.map((d) => d.sha256), f.open?.sha256 ?? ""];

  // one character of the first day's second line, same length
  const edited = fingerprintLedger(bytesOf(LINES[0], LINES[1].replace('"n":2', '"n":7'), ...LINES.slice(2)));
  assert.deepEqual(edited.days.map((d) => [d.day, d.lines, d.bytes]), base.days.map((d) => [d.day, d.lines, d.bytes]), "same days, same counts");
  all(edited).forEach((h, i) => assert.notEqual(h, all(base)[i], `fingerprint ${i} moved`));

  // one character of the second day: the first day stands, the second and the open day move
  const editedLater = fingerprintLedger(bytesOf(LINES[0], LINES[1], LINES[2].replace('"n":3', '"n":8'), ...LINES.slice(3)));
  assert.deepEqual(editedLater.days[0], base.days[0]);
  assert.notEqual(editedLater.days[1].sha256, base.days[1].sha256);
  assert.notEqual(editedLater.open?.sha256, base.open?.sha256);

  // a line removed from the first day
  const removed = fingerprintLedger(bytesOf(LINES[0], ...LINES.slice(2)));
  all(removed).forEach((h, i) => assert.notEqual(h, all(base)[i], `fingerprint ${i} moved`));

  // two lines of one day swapped: the same bytes in another order are another history
  const swapped = fingerprintLedger(bytesOf(LINES[1], LINES[0], ...LINES.slice(2)));
  all(swapped).forEach((h, i) => assert.notEqual(h, all(base)[i], `fingerprint ${i} moved`));

  // a later day cannot be made to match by keeping its own bytes: the link to the day before carries the change
  assert.equal(edited.days[1].previous, edited.days[0].sha256);
  assert.notEqual(edited.days[1].previous, base.days[1].previous);
});

test("ledger fingerprint: an append moves only the open day; the line that starts a new day closes the old one at its running value", () => {
  const before = fingerprintLedger(bytesOf(...LINES));
  const sameDay = fingerprintLedger(bytesOf(...LINES, rec("2026-09-15T22:00:00.000Z", { n: 7 })));
  assert.deepEqual(sameDay.days, before.days, "closed days are untouched by an append");
  assert.equal(sameDay.open?.day, "2026-09-15");
  assert.notEqual(sameDay.open?.sha256, before.open?.sha256);

  const nextDay = fingerprintLedger(bytesOf(...LINES, rec("2026-09-16T00:00:01.000Z", { n: 7 })));
  assert.deepEqual(nextDay.days.slice(0, 2), before.days);
  const { final: _final, ...ran } = before.open!;
  assert.deepEqual(nextDay.days[2], ran, "the closed fingerprint is exactly the running one the day ended on");
  assert.equal(nextDay.open?.day, "2026-09-16");
  assert.equal(nextDay.open?.previous, nextDay.days[2].sha256);
});

test("ledger fingerprint: the day of a line is its own top-level `at`, in one exact form, or none", () => {
  assert.equal(utcDayOf("2026-09-12T16:00:00.000Z"), "2026-09-12");
  assert.equal(utcDayOf("2026-09-12T16:00:00Z"), "2026-09-12");
  assert.equal(utcDayOf("2026-09-12T23:59:59.999999Z"), "2026-09-12");
  for (const bad of [
    "2026-09-12",
    "2026-09-12T16:00:00.000",
    "2026-09-12T16:00:00+00:00",
    "2026-09-12T19:00:00-05:00",
    "2026-09-12 16:00:00Z",
    " 2026-09-12T16:00:00.000Z",
    "2026-02-30T00:00:00.000Z",
    "2026-13-01T00:00:00.000Z",
    "2026-09-12T24:61:00.000Z",
    "Sat, 12 Sep 2026 16:00:00 GMT",
    "",
    1789228800000,
    null,
    undefined,
    { at: "2026-09-12T16:00:00.000Z" },
  ]) {
    assert.equal(utcDayOf(bad), null, `${JSON.stringify(bad)} is not a day`);
  }
  const day = (s: string): string | null => dayOfLine(Buffer.from(s, "utf8"));
  assert.equal(day('{"type":"open","at":"2026-09-12T16:00:00.000Z"}\n'), "2026-09-12");
  assert.equal(day('{"type":"open","at":"2026-09-12T16:00:00.000Z"}\r\n'), "2026-09-12", "a carriage return before the newline is white space to JSON");
  assert.equal(day('{"type":"open"}\n'), null, "no at");
  assert.equal(day('{"type":"reread","reads":{"at":"2026-09-12T16:00:00.000Z"}}\n'), null, "an `at` inside another object is not the line's");
  assert.equal(day('{"at":"2026-09-12T16:00:00.000Z","at":"2026-09-14T16:00:00.000Z"}\n'), "2026-09-14", "a repeated key reads as JSON reads it: the last one");
  assert.equal(day('{"type":"open","at":"2026-09-12T16:00:00.000Z"\n'), null, "cut short");
  assert.equal(day("not json\n"), null);
  assert.equal(day("\n"), null);
  assert.equal(day("   \n"), null);
  assert.equal(day('"2026-09-12T16:00:00.000Z"\n'), null, "a string is not a record");
  assert.equal(day('[{"at":"2026-09-12T16:00:00.000Z"}]\n'), null, "a list is not a record");
  assert.equal(day("null\n"), null);
  assert.equal(dayOfLine(Buffer.from([0xff, 0xfe, 0x0a])), null, "bytes that are not text");
});

test("ledger fingerprint: lines are taken in file order; a late, undated or broken line is counted in the day already running", () => {
  const lines = [
    "\n",
    "garbage before any date\n",
    rec("2026-09-12T16:00:00.000Z"),
    rec("2026-09-13T00:00:02.000Z"),
    // stamped before midnight, written after: stays in the 13th and does not reopen the 12th
    rec("2026-09-12T23:59:59.000Z"),
    '{"type":"cash","ticker":"KXTEST"}\n',
    "{broken\n",
    rec("2026-09-11T08:00:00.000Z"),
    rec("2026-09-13T10:00:00.000Z"),
    rec("2026-09-14T00:00:00.000Z"),
    rec("2026-09-12T12:00:00.000Z"),
  ];
  const f = fingerprintLedger(bytesOf(...lines));
  assert.deepEqual(
    f.days.map((d) => [d.day, d.lines]),
    [
      ["2026-09-12", 3],
      ["2026-09-13", 9],
    ],
    "lines before the first date join the first day; everything up to the first line of the 14th is the 13th",
  );
  assert.equal(f.open?.day, "2026-09-14");
  assert.equal(f.open?.lines, 11);
  assert.ok(f.days.every((d, i) => i === 0 || d.day > f.days[i - 1].day), "days only move forward");
  assert.equal(f.days[0].bytes, Buffer.byteLength(lines.slice(0, 3).join("")));
  assert.equal(f.days[1].bytes, Buffer.byteLength(lines.slice(0, 9).join("")));

  // a line dated ahead of the calendar opens that day; what follows joins it until a later date appears
  const ahead = fingerprintLedger(bytesOf(rec("2026-09-12T16:00:00.000Z"), rec("2027-01-01T00:00:00.000Z"), rec("2026-09-13T00:00:00.000Z"), rec("2026-09-14T00:00:00.000Z")));
  assert.deepEqual(ahead.days.map((d) => [d.day, d.lines]), [["2026-09-12", 1]]);
  assert.equal(ahead.open?.day, "2027-01-01");
  assert.equal(ahead.open?.lines, 4);
});

test("ledger fingerprint: an empty ledger, one with no dated line, and an unfinished last line", () => {
  assert.deepEqual(fingerprintLedger(Buffer.alloc(0)), { days: [], open: null, pendingBytes: 0 });

  const undated = bytesOf("one\n", "\n", '{"type":"cash"}\n');
  const u = fingerprintLedger(undated);
  assert.deepEqual(u.days, []);
  assert.equal(u.open?.day, null, "no line has a date: one open day with no name");
  assert.equal(u.open?.lines, 3);
  assert.equal(u.open?.bytes, undated.length);
  assert.equal(u.open?.sha256, fingerprintOf(FINGERPRINT_GENESIS, "undated", 3, undated.length, sha(undated)));

  // bytes after the last newline are an unfinished line: reported, covered by nothing
  const whole = bytesOf(...LINES);
  const partial = '{"type":"settle","at":"2026-09-16T00:0';
  const cut = fingerprintLedger(Buffer.concat([whole, Buffer.from(partial)]));
  assert.equal(cut.pendingBytes, Buffer.byteLength(partial));
  assert.deepEqual({ ...cut, pendingBytes: 0 }, fingerprintLedger(whole), "the fingerprints are those of the finished lines");
  assert.deepEqual(fingerprintLedger(Buffer.from("no newline at all")), { days: [], open: null, pendingBytes: 17 });

  // the bytes are hashed as they are: another line ending is another ledger
  const crlf = fingerprintLedger(Buffer.from(LINES.join("").replace(/\n/g, "\r\n")));
  assert.deepEqual(crlf.days.map((d) => d.day), ["2026-09-12", "2026-09-13"]);
  assert.notEqual(crlf.days[0].sha256, fingerprintLedger(whole).days[0].sha256);
});

/** a small deterministic generator, so a failure names a seed that fails again */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** a ledger line as the writers make them, or one of the kinds of line that has no day */
function randomLine(rnd: () => number, clock: { ms: number }): string {
  clock.ms += Math.floor(rnd() * 9 * 3_600_000);
  const roll = rnd();
  if (roll < 0.05) return "\n";
  if (roll < 0.1) return `not json ${Math.floor(rnd() * 1e6)}\n`;
  if (roll < 0.15) return `${JSON.stringify({ type: "cash", ticker: "KXTEST", note: "no at" })}\n`;
  // one in ten is stamped up to two days back, as a late write is
  const at = new Date(roll < 0.25 ? clock.ms - Math.floor(rnd() * 48 * 3_600_000) : clock.ms).toISOString();
  return `${JSON.stringify({ type: "open", at, ticker: `KX${Math.floor(rnd() * 1e6)}`, sideName: "Montr\u00e9al \u2603 \ud83c\udfc8", pad: "x".repeat(Math.floor(rnd() * 300)) })}\n`;
}

test("ledger fingerprint: fed in pieces of any size, append after append, it gives what hashing the whole file gives", () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const rnd = mulberry32(seed);
    const clock = { ms: Date.parse("2026-09-12T00:00:00.000Z") };
    const f = new LedgerFingerprinter();
    let whole = Buffer.alloc(0);
    let lastClosed: DayFingerprint[] = [];
    const appends = 1 + Math.floor(rnd() * 25);
    for (let a = 0; a < appends; a += 1) {
      let chunk = "";
      const n = Math.floor(rnd() * 6);
      for (let i = 0; i < n; i += 1) chunk += randomLine(rnd, clock);
      const added = Buffer.from(chunk, "utf8");
      whole = Buffer.concat([whole, added]);
      // the appended bytes arrive in pieces cut anywhere, inside a line and inside a character
      let pos = 0;
      while (pos < added.length) {
        const size = 1 + Math.floor(rnd() * (rnd() < 0.5 ? 7 : 400));
        f.update(added.subarray(pos, pos + size));
        pos += size;
      }
      const scratch = fingerprintLedger(whole);
      assert.deepEqual(f.snapshot(), scratch, `seed ${seed}, append ${a}`);
      assert.deepEqual(scratch.days.slice(0, lastClosed.length), lastClosed, `seed ${seed}, append ${a}: a closed day never changes by an append`);
      lastClosed = scratch.days;
    }
    // every closed day's numbers are those of the file's own first bytes
    for (const d of lastClosed) {
      assert.equal(d.ledgerSha256, sha(whole.subarray(0, d.bytes)), `seed ${seed}: ${d.day}`);
      assert.equal(whole.subarray(0, d.bytes).filter((b) => b === 0x0a).length, d.lines, `seed ${seed}: ${d.day} line count`);
    }
  }
});

test("ledger fingerprint: an older copy of the ledger closes the same days, as far as it goes", () => {
  const rnd = mulberry32(7);
  const clock = { ms: Date.parse("2026-09-12T00:00:00.000Z") };
  const lines: string[] = [];
  for (let i = 0; i < 300; i += 1) lines.push(randomLine(rnd, clock));
  const full = fingerprintLedger(bytesOf(...lines));
  assert.ok(full.days.length > 20, "enough days for the check to mean something");
  for (const keep of [1, 2, 17, 150, 299]) {
    const older = fingerprintLedger(bytesOf(...lines.slice(0, keep)));
    assert.deepEqual(older.days, full.days.slice(0, older.days.length), `the first ${keep} lines`);
    assert.equal(firstDifference(older.days, full.days), null);
  }
});

test("ledger fingerprint: firstDifference names the first published day the ledger does not reproduce", () => {
  const base = fingerprintLedger(bytesOf(...LINES, rec("2026-09-16T00:00:00.000Z")));
  assert.equal(base.days.length, 3);
  assert.equal(firstDifference(base.days, base.days), null);
  assert.equal(firstDifference([], base.days), null, "nothing published, nothing to differ from");
  assert.equal(firstDifference(base.days.slice(0, 2), base.days), null, "days the ledger closed since are new, not different");

  const edited = fingerprintLedger(bytesOf(LINES[0], LINES[1], LINES[2].replace('"n":3', '"n":8'), ...LINES.slice(3), rec("2026-09-16T00:00:00.000Z")));
  const d = firstDifference(base.days, edited.days);
  assert.equal(d?.index, 1);
  assert.equal(d?.day, "2026-09-13", "the first day is reproduced; the second is the first that is not");
  assert.equal(d?.published.sha256, base.days[1].sha256);
  assert.equal(d?.found?.sha256, edited.days[1].sha256);

  // a ledger that no longer reaches a published day
  const short = firstDifference(base.days, base.days.slice(0, 1));
  assert.equal(short?.day, "2026-09-13");
  assert.equal(short?.found, null);
  // the same hash under another count or another day is still a difference
  assert.equal(firstDifference(base.days, [{ ...base.days[0], lines: base.days[0].lines + 1 }, ...base.days.slice(1)])?.day, "2026-09-12");
  assert.equal(firstDifference(base.days, [{ ...base.days[0], day: "2026-09-11" }, ...base.days.slice(1)])?.day, "2026-09-12");
});

const published = (d: DayFingerprint, publishedAt: string): PublishedDay => ({ ...d, publishedAt });

test("ledger fingerprint: the record file replays to what was first published; a restart ends a chain and keeps it", () => {
  const f = fingerprintLedger(bytesOf(...LINES, rec("2026-09-16T00:00:00.000Z")));
  const [d1, d2, d3] = f.days;
  const closing = { day: "2026-09-16", lines: 7, bytes: 700, ledgerSha256: "a".repeat(64), previous: d3.sha256, sha256: "b".repeat(64) };
  const text = [
    JSON.stringify({ type: "day", chain: 1, ...published(d1, "2026-11-10T22:00:00.000Z") }),
    "not json",
    "",
    JSON.stringify({ type: "day", chain: 1, ...published(d2, "2026-11-10T22:00:00.000Z") }),
    // a second line for a day already published is ignored: the first publication stands
    JSON.stringify({ type: "day", chain: 1, ...published({ ...d2, sha256: "c".repeat(64) }, "2026-11-11T00:00:00.000Z") }),
    JSON.stringify({ type: "day", chain: 1, ...published({ ...d1, sha256: "c".repeat(64) }, "2026-11-11T00:00:00.000Z") }),
    JSON.stringify({ type: "day", chain: 1, day: "2026-09-14", lines: "many", bytes: 1, ledgerSha256: "x", previous: "y", sha256: "z", publishedAt: "2026-11-11T00:00:00.000Z" }),
    JSON.stringify({ type: "mismatch", chain: 1, at: "2026-11-12T00:00:00.000Z", day: d2.day, published: { day: d2.day, lines: d2.lines, bytes: d2.bytes, sha256: d2.sha256 }, found: null }),
    JSON.stringify({ type: "restored", chain: 1, at: "2026-11-12T06:00:00.000Z" }),
    JSON.stringify({ type: "day", chain: 1, ...published(d3, "2026-11-12T06:00:00.000Z") }),
    JSON.stringify({ type: "something else" }),
    JSON.stringify({ type: "restart", chain: 1, at: "2026-11-13T01:30:00.000Z", reason: "the ledger was archived whole and a new one started", archivedTo: "ledger.2026-11-13T013000Z.archived.jsonl", closing, intact: true }),
    JSON.stringify({ type: "day", chain: 2, ...published(d1, "2026-11-14T00:00:00.000Z") }),
    JSON.stringify({ type: "mismatch", chain: 2, at: "2026-11-15T00:00:00.000Z", day: d1.day, published: { day: d1.day, lines: d1.lines, bytes: d1.bytes, sha256: d1.sha256 }, found: { day: d1.day, lines: d1.lines, bytes: d1.bytes, sha256: "d".repeat(64) } }),
  ].join("\n");
  const chains = replayFingerprintFile(text);
  assert.equal(chains.length, 2);
  const [one, two] = chains;
  assert.equal(one.chain, 1);
  assert.deepEqual(one.days.map((d) => [d.day, d.sha256, d.publishedAt]), [
    [d1.day, d1.sha256, "2026-11-10T22:00:00.000Z"],
    [d2.day, d2.sha256, "2026-11-10T22:00:00.000Z"],
    [d3.day, d3.sha256, "2026-11-12T06:00:00.000Z"],
  ]);
  assert.equal(one.mismatches.length, 1, "the mismatch stays on the record after the ledger matched again");
  assert.equal(one.standing, null);
  assert.deepEqual(one.ended, { at: "2026-11-13T01:30:00.000Z", reason: "the ledger was archived whole and a new one started", archivedTo: "ledger.2026-11-13T013000Z.archived.jsonl", closing, intact: true });
  assert.equal(two.chain, 2);
  assert.equal(two.ended, null, "the last chain is the current one");
  assert.deepEqual(two.days.map((d) => d.day), [d1.day]);
  assert.equal(two.standing?.found?.sha256, "d".repeat(64), "a mismatch with nothing after it is still standing");

  assert.deepEqual(replayFingerprintFile(""), [{ chain: 1, days: [], mismatches: [], standing: null, ended: null }]);
});

test("ledger fingerprint: the public list carries fingerprints, counts and dates, never a path or a file name", () => {
  const f = fingerprintLedger(bytesOf(...LINES));
  const days = f.days.map((d) => published(d, "2026-11-10T22:00:00.000Z"));
  const earlier = replayFingerprintFile(
    [
      JSON.stringify({ type: "day", chain: 1, ...days[0] }),
      JSON.stringify({ type: "restart", chain: 1, at: "2026-11-09T01:30:00.000Z", reason: "the ledger was archived whole and a new one started", archivedTo: "event-shadow-ledger.2026-11-09T013000Z.archived.jsonl", closing: null, intact: true }),
    ].join("\n"),
  ).slice(0, 1);
  const status: LedgerFingerprintStatus = { state: "ok", chain: 2, days, open: f.open, pendingBytes: 0, mismatch: null, earlier, mismatches: [], fullCheckAt: "2026-11-10T22:00:00.000Z", error: null };
  const pub = fingerprintReport(status, { atIso: "2026-11-10T22:05:00.000Z" });
  assert.deepEqual(Object.keys(pub), ["ok", "at", "scheme", "proves", "state", "chain", "latest", "days", "open", "restarts"]);
  assert.deepEqual(pub.days, days);
  assert.deepEqual(Object.keys(days[0]).sort(), ["bytes", "day", "ledgerSha256", "lines", "previous", "publishedAt", "sha256"]);
  assert.deepEqual(pub.latest, days[1]);
  assert.equal((pub.open as { final: boolean }).final, false);
  assert.deepEqual(pub.restarts, [{ chain: 1, restartedAt: "2026-11-09T01:30:00.000Z", reason: "the ledger was archived whole and a new one started", intact: true, days: [days[0]], closing: null }]);
  assert.ok(!JSON.stringify(pub).includes("archived.jsonl") && !JSON.stringify(pub).includes("archivedTo"));
  assert.equal(pub.scheme, FINGERPRINT_SCHEME);
  assert.equal(pub.proves, FINGERPRINT_PROVES);

  const op = fingerprintReport(status, { atIso: "2026-11-10T22:05:00.000Z", operator: true });
  assert.deepEqual((op.operator as { archives: unknown[] }).archives, [{ chain: 1, archivedTo: "event-shadow-ledger.2026-11-09T013000Z.archived.jsonl", mismatches: [] }]);

  // a mismatch is in the body, said once, with what was published and what the file gives
  const m = { at: "2026-11-11T00:00:00.000Z", day: days[0].day, published: { day: days[0].day, lines: days[0].lines, bytes: days[0].bytes, sha256: days[0].sha256 }, found: null };
  const bad = fingerprintReport({ ...status, state: "mismatch", mismatch: m, mismatches: [m] }, { atIso: "2026-11-11T00:01:00.000Z" });
  assert.equal(bad.state, "mismatch");
  assert.deepEqual(bad.mismatch, m);
});

test("ledger fingerprint: every sentence a person reads is plain, with no dash and no word the house rules forbid", () => {
  // the product's own name is in the hashed text; it is taken out before the bettor's verb is looked for
  const words = [FINGERPRINT_PROVES, mismatchWords("2026-09-13"), ...Object.values(FINGERPRINT_SCHEME)].join(" ").replace(/earn-and-protect/g, "");
  assert.ok(!/[\u2013\u2014]/.test(words), "no en dash or em dash");
  assert.ok(!/wallet|guarantee|protect/i.test(words));
  assert.match(mismatchWords("2026-09-13"), /no longer matches the fingerprint published for 2026-09-13/);
  assert.match(mismatchWords("2026-09-13"), /nothing has been repaired/);
  // what it proves and what it does not, in the public body
  assert.match(FINGERPRINT_PROVES, /has not been changed since the fingerprint was first published/);
  assert.match(FINGERPRINT_PROVES, /does not show that a line was true when it was written/);
  assert.match(FINGERPRINT_PROVES, /binds only from its first publication/);
  assert.match(FINGERPRINT_PROVES, /exported by the operator only/);
});

test("ledger fingerprint: the published list is read back from the route's body, a bare list, or an earlier chain", () => {
  const f = fingerprintLedger(bytesOf(...LINES));
  const coreOf = (d: DayFingerprint) => ({ day: d.day, lines: d.lines, bytes: d.bytes, sha256: d.sha256 });
  assert.deepEqual(publishedDaysFrom(f.days), { days: f.days.map(coreOf), closing: null, chains: [] });
  const closing = { day: "2026-09-15", lines: 6, bytes: 600, ledgerSha256: "a".repeat(64), previous: f.days[1].sha256, sha256: "b".repeat(64) };
  const body = { ok: true, chain: 2, days: [f.days[0]], restarts: [{ chain: 1, days: f.days, closing }] };
  assert.deepEqual(publishedDaysFrom(body), { days: [coreOf(f.days[0])], closing: null, chains: [1] });
  assert.deepEqual(publishedDaysFrom(body, 2), { days: [coreOf(f.days[0])], closing: null, chains: [1] }, "the current chain by its number");
  assert.deepEqual(publishedDaysFrom(body, 1), { days: f.days.map(coreOf), closing: { day: "2026-09-15", lines: 6, bytes: 600, sha256: "b".repeat(64) }, chains: [1] });
  assert.deepEqual(publishedDaysFrom(body, 3), { error: "the published list has no chain 3" });
  assert.ok("error" in publishedDaysFrom({ ok: true }));
  assert.ok("error" in publishedDaysFrom("days"));
  assert.ok("error" in publishedDaysFrom([{ day: "2026-09-12", lines: 1 }]));
});
