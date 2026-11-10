/**
 * Ledger fingerprint keeper: each closed day recorded once, only the appended bytes read between
 * full checks, a ledger that stops hashing to a published day found and never repaired, and the
 * archive-and-reset case.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { archiveLedgerFile, archiveLedgerLines, archiveLinesPathFor, archivePathFor } from "../src/eventCollar/crossVenue/ledgerArchive";
import { FINGERPRINT_GENESIS, fingerprintLedger, type FingerprintMismatch } from "../src/eventCollar/crossVenue/ledgerFingerprint";
import { LedgerFingerprintKeeper, fingerprintPathFor } from "../src/eventCollar/crossVenue/ledgerFingerprintKeeper";
import { buildShadowAlerter, type ShadowAlertConfig } from "../src/eventCollar/crossVenue/shadowAlerts";

const rec = (at: string, n: number, ticker = "KXTEST"): string => `${JSON.stringify({ type: "open", at, ticker, n })}\n`;
const DAY1 = [rec("2026-09-12T16:00:00.000Z", 1), rec("2026-09-12T18:30:00.000Z", 2)];
const DAY2 = [rec("2026-09-13T01:00:00.000Z", 3), rec("2026-09-13T20:00:00.000Z", 4)];
const DAY3 = [rec("2026-09-14T09:00:00.000Z", 5)];
const DAY4 = [rec("2026-09-15T09:00:00.000Z", 6)];
const DAY5 = [rec("2026-09-16T09:00:00.000Z", 7)];

/** a clock that moves a minute every time it is read, so every write has its own stamp */
function clock(startIso = "2026-11-10T22:00:00.000Z"): () => Date {
  let ms = Date.parse(startIso);
  return () => {
    const d = new Date(ms);
    ms += 60_000;
    return d;
  };
}

function setup(lines: string[] = []): { dir: string; path: string; recordPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "fingerprint-keeper-"));
  const path = join(dir, "ledger.jsonl");
  if (lines.length) writeFileSync(path, lines.join(""));
  return { dir, path, recordPath: join(dir, "ledger.fingerprints.jsonl") };
}

const recordLines = (recordPath: string): Array<Record<string, unknown>> =>
  existsSync(recordPath)
    ? readFileSync(recordPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];

test("fingerprint keeper: the record sits beside the ledger under its own name", () => {
  assert.equal(fingerprintPathFor("/var/data/event-shadow-ledger.jsonl"), "/var/data/event-shadow-ledger.fingerprints.jsonl");
  assert.equal(fingerprintPathFor("/var/data/lock-ledger-ann.jsonl"), "/var/data/lock-ledger-ann.fingerprints.jsonl");
  assert.equal(fingerprintPathFor("/var/data/ledger"), "/var/data/ledger.fingerprints.jsonl");
  const { path, recordPath } = setup();
  assert.equal(new LedgerFingerprintKeeper(path).recordPath, recordPath);
});

test("fingerprint keeper: a closed day is recorded once, when it is first seen closed, and stays as recorded", () => {
  const { path, recordPath } = setup();
  const keeper = new LedgerFingerprintKeeper(path, { now: clock() });

  // no ledger yet: nothing to say, nothing written
  let s = keeper.sync();
  assert.deepEqual({ state: s.state, days: s.days, open: s.open, chain: s.chain }, { state: "ok", days: [], open: null, chain: 1 });
  assert.ok(!existsSync(recordPath));

  appendFileSync(path, DAY1.join(""));
  s = keeper.sync();
  assert.deepEqual(s.days, [], "the only day in the file is open");
  assert.equal(s.open?.day, "2026-09-12");
  assert.equal(s.open?.final, false);
  assert.ok(!existsSync(recordPath), "an open day is not recorded");

  appendFileSync(path, DAY2[0]);
  s = keeper.sync();
  assert.equal(s.days.length, 1);
  const first = s.days[0];
  assert.deepEqual({ ...first, publishedAt: undefined }, { ...fingerprintLedger(readFileSync(path)).days[0], publishedAt: undefined });
  assert.equal(first.previous, FINGERPRINT_GENESIS);
  assert.match(first.publishedAt, /^2026-11-10T22:0\d:00\.000Z$/);
  assert.deepEqual(recordLines(recordPath), [{ type: "day", chain: 1, ...first }]);

  // asked again, nothing is written again
  keeper.sync();
  keeper.sync({ full: true });
  assert.equal(recordLines(recordPath).length, 1);

  appendFileSync(path, DAY2[1] + DAY3.join("") + DAY4.join(""));
  s = keeper.sync();
  assert.deepEqual(s.days.map((d) => d.day), ["2026-09-12", "2026-09-13", "2026-09-14"]);
  assert.deepEqual(s.days[0], first, "the first day is as it was first recorded, stamp included");
  assert.ok(s.days[1].publishedAt > first.publishedAt);
  assert.equal(s.days[1].previous, first.sha256);
  assert.deepEqual(
    s.days.map(({ publishedAt: _p, ...d }) => d),
    fingerprintLedger(readFileSync(path)).days,
  );
  assert.deepEqual(s.open, fingerprintLedger(readFileSync(path)).open);

  // the service stops and starts: what was published is read back, not published again
  const before = readFileSync(recordPath, "utf8");
  const again = new LedgerFingerprintKeeper(path, { now: clock("2026-11-12T00:00:00.000Z") }).sync();
  assert.deepEqual(again.days, s.days);
  assert.equal(again.fullCheckAt, "2026-11-12T00:00:00.000Z");
  assert.equal(readFileSync(recordPath, "utf8"), before);
});

test("fingerprint keeper: between full checks only the appended bytes are read", () => {
  const { path } = setup([...DAY1, ...DAY2, ...DAY3]);
  const keeper = new LedgerFingerprintKeeper(path, { now: clock() });
  const first = keeper.sync();
  assert.equal(first.days.length, 2);
  const fullAt = first.fullCheckAt;
  assert.ok(fullAt, "the first sync hashes from the first byte");

  // one character of a closed day changed in place, the length kept: the bytes already read are
  // not read again, so the cheap path cannot see it, however many appends follow
  const original = readFileSync(path);
  const edited = Buffer.from(original);
  const at = edited.indexOf('"n":1');
  edited.write('"n":9', at);
  assert.equal(edited.length, original.length);
  writeFileSync(path, edited);
  let s = keeper.sync();
  assert.equal(s.state, "ok");
  assert.equal(s.fullCheckAt, fullAt, "no full pass was made");
  appendFileSync(path, DAY4.join(""));
  s = keeper.sync();
  assert.equal(s.state, "ok");
  assert.equal(s.days.length, 3, "the appended bytes were read: the next day closed");
  assert.equal(s.fullCheckAt, fullAt);
  assert.equal(s.open?.lines, 6);

  // the full pass is what finds it
  s = keeper.sync({ full: true });
  assert.equal(s.state, "mismatch");
  assert.equal(s.mismatch?.day, "2026-09-12");
  assert.notEqual(s.fullCheckAt, fullAt);
});

test("fingerprint keeper: a ledger that no longer hashes to a published day is reported, recorded once, and never repaired", () => {
  const { path, recordPath } = setup([...DAY1, ...DAY2, ...DAY3, ...DAY4]);
  const told: FingerprintMismatch[] = [];
  const restored: FingerprintMismatch[] = [];
  const opts = { now: clock(), onMismatch: (m: FingerprintMismatch) => told.push(m), onRestored: (m: FingerprintMismatch) => restored.push(m) };
  const keeper = new LedgerFingerprintKeeper(path, opts);
  const good = keeper.sync();
  assert.deepEqual(good.days.map((d) => d.day), ["2026-09-12", "2026-09-13", "2026-09-14"]);
  const publishedFile = readFileSync(recordPath, "utf8");
  const original = readFileSync(path);

  // a line of the second day is changed after it was published
  const edited = Buffer.from(original);
  edited.write('"n":8', edited.indexOf('"n":3'));
  writeFileSync(path, edited);
  let s = keeper.sync({ full: true });
  assert.equal(s.state, "mismatch");
  assert.equal(s.mismatch?.day, "2026-09-13", "the first day still matches; the second is the first that does not");
  assert.equal(s.mismatch?.published.sha256, good.days[1].sha256);
  assert.equal(s.mismatch?.found?.sha256, fingerprintLedger(edited).days[1].sha256);
  assert.equal(told.length, 1);
  assert.deepEqual(told[0], s.mismatch);
  assert.deepEqual(s.days, good.days, "what was published is still what is shown");
  let file = readFileSync(recordPath, "utf8");
  assert.ok(file.startsWith(publishedFile), "the record is appended to, never rewritten");
  assert.deepEqual(recordLines(recordPath).slice(3), [{ type: "mismatch", chain: 1, ...s.mismatch }]);

  // every full check says it again; the record is written once; the cheap path says nothing
  s = keeper.sync({ full: true });
  assert.equal(told.length, 2);
  keeper.sync();
  keeper.sync();
  assert.equal(told.length, 2);
  assert.equal(readFileSync(recordPath, "utf8"), file);

  // the ledger goes on growing and closes another day: nothing is published on top of a broken chain
  appendFileSync(path, DAY5.join(""));
  s = keeper.sync();
  assert.equal(s.state, "mismatch");
  assert.equal(s.days.length, 3);
  assert.equal(s.open?.day, "2026-09-16", "the file itself is still read");
  assert.equal(readFileSync(recordPath, "utf8"), file);

  // the service restarts: still a mismatch, said again, not written again
  const second = new LedgerFingerprintKeeper(path, opts);
  s = second.sync();
  assert.equal(s.state, "mismatch");
  assert.equal(s.mismatch?.at, told[0].at, "first seen when it was first seen");
  assert.equal(told.length, 3);
  assert.equal(readFileSync(recordPath, "utf8"), file);
  assert.deepEqual(s.days, good.days);

  // a different change is a different finding: one more line
  const worse = Buffer.from(readFileSync(path));
  worse.write('"n":9', worse.indexOf('"n":1'));
  writeFileSync(path, worse);
  s = second.sync({ full: true });
  assert.equal(s.mismatch?.day, "2026-09-12");
  assert.equal(s.mismatches.length, 2);
  assert.equal(told.length, 4);
  file = readFileSync(recordPath, "utf8");
  assert.ok(file.startsWith(publishedFile));
  assert.equal(recordLines(recordPath).filter((l) => l.type === "mismatch").length, 2);
  assert.equal(recordLines(recordPath).filter((l) => l.type === "day").length, 3, "no day was added or changed");

  // the bytes that were published are put back (with the lines written since): it matches again,
  // that is on the record too, and only now is the next day published
  writeFileSync(path, Buffer.concat([original, Buffer.from(DAY5.join(""))]));
  assert.equal(restored.length, 0);
  s = second.sync({ full: true });
  assert.equal(s.state, "ok");
  assert.equal(s.mismatch, null);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].day, "2026-09-12");
  assert.equal(s.mismatches.length, 2, "the mismatches stay on the record");
  assert.deepEqual(s.days.map((d) => d.day), ["2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15"]);
  assert.deepEqual(s.days.slice(0, 3), good.days);
  const after = recordLines(recordPath);
  assert.deepEqual(after.slice(-2).map((l) => l.type), ["restored", "day"]);
  assert.ok(readFileSync(recordPath, "utf8").startsWith(file));
  assert.equal(told.length, 4);
});

test("fingerprint keeper: a ledger cut short or swapped for another file is seen without waiting for the full check", () => {
  // cut short: the file is smaller than what was already read
  {
    const { path } = setup([...DAY1, ...DAY2, ...DAY3]);
    const told: FingerprintMismatch[] = [];
    const keeper = new LedgerFingerprintKeeper(path, { now: clock(), onMismatch: (m) => told.push(m) });
    const good = keeper.sync();
    assert.equal(good.days.length, 2);
    truncateSync(path, good.days[1].bytes);
    const s = keeper.sync();
    assert.equal(s.state, "mismatch");
    assert.equal(s.mismatch?.day, "2026-09-13", "the file ends on the second day's last line, so that day is no longer closed by a later one");
    assert.equal(s.mismatch?.found, null);
    assert.equal(told.length, 1);
    assert.deepEqual(s.days, good.days);
  }
  // swapped: another file under the same name, longer than the one before
  {
    const { dir, path } = setup([...DAY1, ...DAY2, ...DAY3]);
    const keeper = new LedgerFingerprintKeeper(path, { now: clock() });
    assert.equal(keeper.sync().days.length, 2);
    const other = join(dir, "other.jsonl");
    writeFileSync(other, [rec("2026-09-12T16:00:00.000Z", 100), ...DAY1.slice(1), ...DAY2, ...DAY3, ...DAY4].join(""));
    renameSync(other, path);
    const s = keeper.sync();
    assert.equal(s.state, "mismatch");
    assert.equal(s.mismatch?.day, "2026-09-12");
    assert.equal(s.days.length, 2, "the new file's days are not published over the old ones");
  }
  // swapped for a copy with the same bytes and more: no finding, the new day is published
  {
    const { dir, path } = setup([...DAY1, ...DAY2, ...DAY3]);
    const keeper = new LedgerFingerprintKeeper(path, { now: clock() });
    keeper.sync();
    const copy = join(dir, "copy.jsonl");
    writeFileSync(copy, [...DAY1, ...DAY2, ...DAY3, ...DAY4].join(""));
    renameSync(copy, path);
    const s = keeper.sync();
    assert.equal(s.state, "ok");
    assert.equal(s.days.length, 3);
  }
  // nothing was published yet: a new file under the name has nothing to differ from
  {
    const { path } = setup(DAY1);
    const keeper = new LedgerFingerprintKeeper(path, { now: clock() });
    keeper.sync();
    writeFileSync(path, DAY2.join(""));
    truncateSync(path, Buffer.byteLength(DAY2[0]));
    assert.equal(keeper.sync().state, "ok");
  }
});

test("fingerprint keeper: archive and reset ends the chain on the record and starts a new one; the old days stay listed", () => {
  const { path, recordPath } = setup([...DAY1, ...DAY2, ...DAY3]);
  const keeper = new LedgerFingerprintKeeper(path, { now: clock() });
  const before = keeper.sync();
  const publishedFile = readFileSync(recordPath, "utf8");
  const atIso = "2026-11-11T01:30:00.000Z";
  const archivedTo = archivePathFor(path, atIso);

  keeper.restart("the ledger was archived whole and a new one started", atIso, archivedTo);
  assert.deepEqual(archiveLedgerFile(path, atIso), { path, archivedTo });
  let s = keeper.sync();
  assert.equal(s.state, "ok", "a reset the keeper was told about is not a mismatch");
  assert.equal(s.chain, 2);
  assert.deepEqual(s.days, []);
  assert.equal(s.open, null);
  assert.equal(s.earlier.length, 1);
  const old = s.earlier[0];
  assert.equal(old.chain, 1);
  assert.deepEqual(old.days, before.days, "the days published for the archived ledger are kept as they were");
  const { final: _final, ...closing } = before.open!;
  assert.deepEqual(old.ended, { at: atIso, reason: "the ledger was archived whole and a new one started", archivedTo: basename(archivedTo), closing, intact: true });
  assert.ok(readFileSync(recordPath, "utf8").startsWith(publishedFile));
  assert.equal(recordLines(recordPath).slice(-1)[0].type, "restart");

  // the archived file still hashes to what was published for it, to its last byte
  const archived = fingerprintLedger(readFileSync(archivedTo));
  assert.deepEqual(archived.days, before.days.map(({ publishedAt: _p, ...d }) => d));
  assert.deepEqual(archived.open, before.open);

  // the new ledger is a new chain from its first byte
  appendFileSync(path, rec("2026-11-11T02:00:00.000Z", 1) + rec("2026-11-12T02:00:00.000Z", 2));
  s = keeper.sync();
  assert.equal(s.state, "ok");
  assert.deepEqual(s.days.map((d) => [d.day, d.previous]), [["2026-11-11", FINGERPRINT_GENESIS]]);
  assert.equal(recordLines(recordPath).slice(-1)[0].chain, 2);

  // read back after a restart of the service: two chains, the first ended
  const again = new LedgerFingerprintKeeper(path, { now: clock("2026-11-13T00:00:00.000Z") }).sync();
  assert.equal(again.chain, 2);
  assert.deepEqual(again.earlier, s.earlier);
  assert.deepEqual(again.days, s.days);
});

test("fingerprint keeper: a ledger archived without saying so is a mismatch; a mismatched ledger archived is on the record as not intact", () => {
  const { path } = setup([...DAY1, ...DAY2, ...DAY3]);
  const told: FingerprintMismatch[] = [];
  const keeper = new LedgerFingerprintKeeper(path, { now: clock(), onMismatch: (m) => told.push(m) });
  const before = keeper.sync();
  archiveLedgerFile(path, "2026-11-11T01:30:00.000Z");
  let s = keeper.sync();
  assert.equal(s.state, "mismatch");
  assert.equal(s.mismatch?.day, "2026-09-12");
  assert.equal(s.mismatch?.found, null);
  assert.equal(told.length, 1);
  assert.deepEqual(s.days, before.days);

  // the operator's reset is the way out, and it says the chain was broken when it ended
  keeper.restart("the ledger was archived whole and a new one started", "2026-11-11T02:00:00.000Z", null);
  s = keeper.sync();
  assert.equal(s.state, "ok");
  assert.equal(s.chain, 2);
  assert.equal(s.earlier[0].ended?.intact, false);
  assert.equal(s.earlier[0].ended?.archivedTo, null);
  assert.equal(s.earlier[0].mismatches.length, 1);
  assert.deepEqual(s.earlier[0].days, before.days);
});

test("fingerprint keeper: lines moved out of a shared ledger end its chain; what is left is fingerprinted from its first byte", () => {
  const lines = [
    rec("2026-09-12T16:00:00.000Z", 1, "KXA"),
    rec("2026-09-12T17:00:00.000Z", 2, "KXB"),
    rec("2026-09-13T16:00:00.000Z", 3, "KXA"),
    rec("2026-09-14T16:00:00.000Z", 4, "KXB"),
    rec("2026-09-15T16:00:00.000Z", 5, "KXB"),
  ];
  const { path } = setup(lines);
  const keeper = new LedgerFingerprintKeeper(path, { now: clock() });
  const before = keeper.sync();
  assert.equal(before.days.length, 3);
  const atIso = "2026-11-11T01:30:00.000Z";
  keeper.restart("lock reset: the lines of KXA were moved to an archive beside the ledger", atIso, archiveLinesPathFor(path, "KXA", atIso));
  const moved = archiveLedgerLines(path, (r) => r.ticker === "KXA", "KXA", atIso);
  assert.equal(moved.moved, 2);
  assert.equal(moved.archivedTo, archiveLinesPathFor(path, "KXA", atIso), "the archive is where the record says it is");
  const s = keeper.sync();
  assert.equal(s.state, "ok");
  assert.equal(s.chain, 2);
  assert.deepEqual(
    s.days.map(({ publishedAt: _p, ...d }) => d),
    fingerprintLedger(readFileSync(path)).days,
  );
  assert.deepEqual(s.days.map((d) => d.day), ["2026-09-12", "2026-09-14"]);
  assert.deepEqual(s.earlier[0].days, before.days);
  assert.equal(s.earlier[0].ended?.archivedTo, basename(moved.archivedTo!));
});

test("fingerprint keeper: it never throws and never writes to the ledger", () => {
  // a ledger that cannot be read: said, not thrown
  {
    const { dir } = setup();
    const asDir = join(dir, "ledger-dir.jsonl");
    mkdirSync(asDir);
    const s = new LedgerFingerprintKeeper(asDir, { now: clock() }).sync();
    assert.equal(s.state, "unread");
    assert.ok(s.error);
  }
  // a record that cannot be written: the days are not recorded, and that is said
  {
    const { dir, path } = setup([...DAY1, ...DAY2]);
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "a file where a folder is needed");
    const keeper = new LedgerFingerprintKeeper(path, { now: clock(), recordPath: join(blocker, "fingerprints.jsonl") });
    const s = keeper.sync();
    assert.equal(s.state, "unread");
    assert.ok(s.error);
    assert.deepEqual(s.days, []);
    assert.equal(s.open?.day, "2026-09-13", "the ledger itself was read");
  }
  // a mismatch is told even when its line cannot be written (a record that can be read and not
  // appended to; the superuser can append to anything, so there is nothing to see as root)
  if (process.getuid?.() !== 0) {
    const { path, recordPath } = setup([...DAY1, ...DAY2, ...DAY3]);
    const told: FingerprintMismatch[] = [];
    const keeper = new LedgerFingerprintKeeper(path, { now: clock(), onMismatch: (m) => told.push(m) });
    assert.equal(keeper.sync().days.length, 2);
    const published = readFileSync(recordPath, "utf8");
    chmodSync(recordPath, 0o444);
    const edited = Buffer.from(readFileSync(path));
    edited.write('"n":9', edited.indexOf('"n":1'));
    writeFileSync(path, edited);
    const s = keeper.sync({ full: true });
    assert.equal(s.state, "mismatch", "the mismatch outranks the write that failed");
    assert.ok(s.error);
    assert.equal(told.length, 1);
    assert.equal(readFileSync(recordPath, "utf8"), published);
    chmodSync(recordPath, 0o644);
  }
  // a listener that throws does not stop the record being kept
  {
    const { path, recordPath } = setup([...DAY1, ...DAY2, ...DAY3]);
    const keeper = new LedgerFingerprintKeeper(path, {
      now: clock(),
      onMismatch: () => {
        throw new Error("alerts are down");
      },
    });
    keeper.sync();
    truncateSync(path, 10);
    const s = keeper.sync();
    assert.equal(s.state, "mismatch");
    assert.equal(recordLines(recordPath).slice(-1)[0].type, "mismatch");
  }
  // whatever it is asked, the ledger's bytes are the writer's alone and its folder gains one file
  {
    const { dir, path } = setup([...DAY1, ...DAY2, ...DAY3]);
    const bytes = readFileSync(path);
    const keeper = new LedgerFingerprintKeeper(path, { now: clock() });
    keeper.sync();
    keeper.sync({ full: true });
    keeper.sync();
    assert.deepEqual(readFileSync(path), bytes);
    assert.deepEqual(readdirSync(dir).sort(), ["ledger.fingerprints.jsonl", "ledger.jsonl"]);
  }
});

test("shadow alerts: a fingerprint mismatch is sent every time it is raised, so one ledger's alarm cannot hide another's", async () => {
  const cfg: ShadowAlertConfig = { telegramBotToken: null, telegramChatId: null, webhookUrl: "https://hooks.example/x", dedupeMs: 6 * 3_600_000, scanFailureThreshold: 3, stallIntervals: 3 };
  const sent: Array<{ kind: string; message: string }> = [];
  const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body ?? "null")) as { kind: string; message: string });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const alerter = buildShadowAlerter(cfg, fakeFetch, () => 1_000, () => undefined);
  await alerter({ kind: "ledger_fingerprint_mismatch", message: "the record's ledger" });
  await alerter({ kind: "ledger_fingerprint_mismatch", message: "the lock ledger of ann" });
  await alerter({ kind: "ledger_fingerprint_restored", message: "the record's ledger" });
  await alerter({ kind: "ledger_fingerprint_restored", message: "the lock ledger of ann" });
  assert.deepEqual(sent.map((s) => s.kind), ["ledger_fingerprint_mismatch", "ledger_fingerprint_mismatch", "ledger_fingerprint_restored", "ledger_fingerprint_restored"]);
  // the kinds that were deduplicated before still are
  await alerter({ kind: "scan_stalled", message: "a" });
  await alerter({ kind: "scan_stalled", message: "b" });
  assert.equal(sent.length, 5);
});
