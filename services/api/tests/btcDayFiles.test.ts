/**
 * Keeping the day files: the retention rule, the gzip of closed days, reading either form, the
 * figures /healthz prints and what a failed write does. Real files in a temp dir; no network.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { DayKeeper, compressDayFile, dataUsage, listDayFiles, parseBudgetMb, parseRetention, readLines, readablePath } from "../src/btcCurve/dayFiles";
import { SnapshotStore } from "../src/btcCurve/store";
import { PairsCollector, pairsCollectorFromEnv } from "../src/btcCurve/pairsCollector";
import type { LockEpisode } from "../src/btcCurve/pairs";
import type { Snapshot } from "../src/btcCurve/types";

const DAY = 86_400_000;
const T0 = Date.parse("2026-01-01T00:00:00Z");
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const tmp = (tag: string) => mkdtempSync(join(tmpdir(), `btc-day-${tag}-`));
const snap = (at: string): Snapshot => ({ at, spotUsd: 74000, spotSource: "brti", ladders: [], options: [], health: {} });
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const diskFull = () => Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", syscall: "write", errno: -28 });

async function linesOf(path: string): Promise<string[]> {
  const out: string[] = [];
  for await (const l of readLines(path)) out.push(l);
  return out;
}

test("retention setting: unset, empty, 0, all and none keep everything; a positive whole number is that window; anything else keeps everything and says so", () => {
  for (const raw of [undefined, null, "", "   ", "0", "00", "all", "ALL", "none", " None "]) {
    const r = parseRetention(raw as string | undefined, "BTC_CURVE_RETAIN_DAYS");
    assert.deepEqual([r.days, r.label, r.note], [null, "all", null], `${JSON.stringify(raw)} keeps every day, with nothing to say`);
  }
  assert.deepEqual([parseRetention("21").days, parseRetention("21").label, parseRetention("21").note], [21, "21 days", null]);
  assert.deepEqual([parseRetention(" 7 ").days, parseRetention("1").label, parseRetention(3).days], [7, "1 day", 3]);
  for (const raw of ["abc", "-3", "2.5", "21d", "1e3", "+5", "0x10", "21 days", "NaN", "Infinity", "99999999999999999999"]) {
    const r = parseRetention(raw, "BTC_CURVE_RETAIN_DAYS");
    assert.equal(r.days, null, `${raw} is not guessed at`);
    assert.equal(r.label, "all");
    assert.ok(r.note?.includes("BTC_CURVE_RETAIN_DAYS") && r.note.includes(JSON.stringify(raw)) && r.note.includes("Nothing is deleted"), `${raw}: ${r.note}`);
  }
  // numbers handed in by code follow the same rule
  assert.equal(parseRetention(2.5).days, null);
  assert.equal(parseRetention(-3).days, null);
  assert.equal(parseRetention(Number.NaN).days, null);

  assert.deepEqual([parseBudgetMb(undefined).mb, parseBudgetMb("").mb, parseBudgetMb("0").mb], [null, null, null]);
  assert.deepEqual([parseBudgetMb("2800").mb, parseBudgetMb("0.5").mb, parseBudgetMb("2800").note], [2800, 0.5, null]);
  for (const raw of ["3GB", "-1", "lots"]) {
    const b = parseBudgetMb(raw, "BTC_CURVE_DISK_BUDGET_MB");
    assert.equal(b.mb, null);
    assert.ok(b.note?.includes("BTC_CURVE_DISK_BUDGET_MB") && b.note.includes("No budget is in force"));
  }
});

test("an unreadable retention value deletes nothing: files a year old survive the sweep and the pass, and /healthz carries the note", async () => {
  for (const raw of ["abc", "-3", "2.5"]) {
    const dir = tmp("unreadable");
    const now = T0 + 400 * DAY;
    for (const d of [0, 100, 399]) writeFileSync(join(dir, `snapshots-${dayOf(T0 + d * DAY)}.jsonl`), `${JSON.stringify(snap(new Date(T0 + d * DAY).toISOString()))}\n`);
    const keeper = new DayKeeper({ dir, families: ["snapshots"], retention: parseRetention(raw, "BTC_CURVE_RETAIN_DAYS") });
    assert.deepEqual(keeper.sweep(now), []);
    const r = await keeper.maintain(now);
    assert.deepEqual(r.removed, []);
    assert.equal(listDayFiles(dir, ["snapshots"]).length, 3, "all three days are still there");
    const h = keeper.health(now);
    assert.equal(h.retention, "all");
    assert.match(h.retentionNote ?? "", /is not a whole number of days\. Nothing is deleted\./);
    assert.match(keeper.startupLine(now), /keeping every day.*Nothing is deleted\./);
  }
});

test("default: 400 days of snapshots, one a day with the hourly pass run every day, and not one day is gone; every closed day is gzip and reads back", async () => {
  const dir = tmp("400");
  const store = new SnapshotStore(dir, { keepHours: 1 });
  const written = new Map<string, string>();
  for (let d = 0; d < 400; d += 1) {
    const at = new Date(T0 + d * DAY + 12 * 3_600_000).toISOString();
    assert.equal(store.append(snap(at)), true);
    written.set(dayOf(T0 + d * DAY), at);
    const r = await store.maintain(T0 + d * DAY + 13 * 3_600_000);
    assert.deepEqual(r.removed, [], "nothing is removed on any day");
    assert.deepEqual(store.sweep(T0 + d * DAY + 13 * 3_600_000), []);
  }
  const files = listDayFiles(dir, ["snapshots"]);
  assert.equal(files.length, 400);
  assert.deepEqual(files.map((f) => f.day), [...written.keys()]);
  assert.equal(files.filter((f) => f.gz && !f.plain).length, 399, "every closed day is one .jsonl.gz");
  assert.ok(files[399].plain && !files[399].gz, "the last day, still open, is the plain file");
  for (const f of files) {
    const got = (await linesOf(readablePath(f))).map((l) => (JSON.parse(l) as Snapshot).at);
    assert.deepEqual(got, [written.get(f.day)], `${f.day} holds its one snapshot`);
  }
  const h = store.dataHealth(T0 + 400 * DAY);
  assert.deepEqual([h.retention, h.dayFiles, h.oldestDay, h.newestDay], ["all", { plain: 1, gz: 399 }, "2026-01-01", "2027-02-04"]);
});

test("a window of N days keeps the current day and the N whole days before it: no line younger than N days is deleted, at any hour", () => {
  const firstDay = Date.parse("2026-11-01T00:00:00Z");
  for (const [days, nowIso] of [[3, "2026-11-11T00:00:01Z"], [3, "2026-11-11T02:00:00Z"], [3, "2026-11-11T23:59:59Z"], [1, "2026-11-11T00:30:00Z"], [7, "2026-11-11T12:00:00Z"]] as Array<[number, string]>) {
    const dir = tmp("whole-days");
    const now = Date.parse(nowIso);
    // one line at the first and one at the last second of every day, 1 to 11 November
    for (let d = 0; d <= 10; d += 1) writeFileSync(join(dir, `snapshots-${dayOf(firstDay + d * DAY)}.jsonl`), `${JSON.stringify(snap(new Date(firstDay + d * DAY).toISOString()))}\n${JSON.stringify(snap(new Date(firstDay + (d + 1) * DAY - 1000).toISOString()))}\n`);
    const keeper = new DayKeeper({ dir, families: ["snapshots"], retention: parseRetention(days) });
    const removed = keeper.sweep(now);
    const kept = listDayFiles(dir, ["snapshots"]).map((f) => f.day);
    assert.equal(kept.length, days + 1, `${days} days at ${nowIso}: today and ${days} whole days before it`);
    assert.equal(kept[0], dayOf(Date.parse("2026-11-11T00:00:00Z") - days * DAY));
    // the youngest line that went was the last second of the newest day removed: it is older than the window
    const newestRemoved = removed.map((n) => n.slice(10, 20)).sort().pop() as string;
    assert.ok(now - (Date.parse(`${newestRemoved}T00:00:00Z`) + DAY - 1000) > days * DAY, `the youngest line deleted at ${nowIso} was older than ${days} days`);
    assert.deepEqual(keeper.sweep(now), []);
  }
});

test("a window still deletes exactly the days outside it, both forms, and nothing else in the dir", () => {
  const dir = tmp("window");
  const now = Date.parse("2026-11-30T06:00:00Z");
  for (let d = 0; d < 30; d += 1) {
    const day = dayOf(Date.parse("2026-11-01T00:00:00Z") + d * DAY);
    const body = Buffer.from(`${JSON.stringify(snap(`${day}T00:00:00.000Z`))}\n`);
    if (d % 2) writeFileSync(join(dir, `snapshots-${day}.jsonl`), body);
    else writeFileSync(join(dir, `snapshots-${day}.jsonl.gz`), gzipSync(body));
  }
  for (const other of ["collecting-since.txt", "replays.jsonl", "replay-state.json", "notes-2026-11-01.jsonl", "snapshots-2026-11-01.jsonl.bak"]) writeFileSync(join(dir, other), "x");
  const store = new SnapshotStore(dir, { retainDays: 21 });
  // a day is outside the window when its last instant is more than 21 days before now (06:00 on the 30th): 1 to 8 November
  const removed = store.sweep(now);
  const expected = [];
  for (let d = 1; d <= 8; d += 1) expected.push(`snapshots-2026-11-0${d}.jsonl${d % 2 ? ".gz" : ""}`);
  assert.deepEqual(removed.sort(), expected.sort());
  assert.deepEqual(listDayFiles(dir, ["snapshots"]).map((f) => f.day), Array.from({ length: 22 }, (_, i) => `2026-11-${String(i + 9).padStart(2, "0")}`));
  for (const other of ["collecting-since.txt", "replays.jsonl", "replay-state.json", "notes-2026-11-01.jsonl", "snapshots-2026-11-01.jsonl.bak"]) assert.ok(existsSync(join(dir, other)), `${other} is not a day file of this store and stays`);
  assert.deepEqual(store.sweep(now), [], "a second sweep finds nothing more");
  assert.equal(store.dataHealth(now).retention, "21 days");
});

test("gzip of a closed day is byte-exact: the original goes only after the copy reads back the same bytes, lines and sha256; a torn last line survives as it was", async () => {
  const dir = tmp("gzip");
  const plain = join(dir, "snapshots-2026-11-09.jsonl");
  const body = Buffer.from(`${Array.from({ length: 500 }, (_, i) => JSON.stringify({ at: i, text: "é".repeat(i % 7), pad: "x".repeat(300) })).join("\n")}\n{"torn":tr`);
  writeFileSync(plain, body);
  const r = await compressDayFile(plain);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual([r.file, r.lines, r.rawBytes, r.sha256], ["snapshots-2026-11-09.jsonl.gz", 500, body.length, sha(body)]);
  assert.deepEqual(readdirSync(dir), ["snapshots-2026-11-09.jsonl.gz"], "the original and the temp file are gone");
  const back = gunzipSync(readFileSync(`${plain}.gz`));
  assert.ok(back.equals(body), "the uncompressed bytes are the original bytes");
  assert.equal(r.gzBytes, statSync(`${plain}.gz`).size);
  assert.ok(r.gzBytes < body.length);
  assert.deepEqual(await linesOf(`${plain}.gz`), body.toString("utf8").split("\n"), "the stream reader gives the same lines, the torn one included");

  // an empty day file is still a day: it round-trips to an empty gzip
  const empty = join(dir, "snapshots-2026-11-08.jsonl");
  writeFileSync(empty, "");
  const e = await compressDayFile(empty);
  assert.ok(e.ok && e.lines === 0 && e.rawBytes === 0);
  assert.equal(gunzipSync(readFileSync(`${empty}.gz`)).length, 0);
});

test("a compression that fails keeps the original: a torn copy, a copy that reads back different, a day file that changed meanwhile, a disk that will not take the temp file; the next pass tries again", async () => {
  const dir = tmp("torn");
  const plain = join(dir, "snapshots-2026-11-09.jsonl");
  const body = Buffer.from(`${Array.from({ length: 200 }, (_, i) => JSON.stringify({ at: i, pad: "y".repeat(200) })).join("\n")}\n`);
  writeFileSync(plain, body);
  const intact = () => {
    assert.ok(readFileSync(plain).equals(body), "the original is untouched");
    assert.deepEqual(readdirSync(dir), ["snapshots-2026-11-09.jsonl"], "no .gz and no temp file are left");
  };

  // the temp file cut short, as a crash or a full disk mid-write leaves it
  const torn = await compressDayFile(plain, { afterWrite: (t) => truncateSync(t, Math.floor(statSync(t).size / 2)) });
  assert.equal(torn.ok, false);
  assert.match(torn.ok ? "" : torn.reason, /could not be compressed.*the original is kept/);
  intact();

  // a whole, valid gzip of the wrong content
  const wrong = await compressDayFile(plain, { afterWrite: (t) => writeFileSync(t, gzipSync(Buffer.from(body.toString("utf8").replace('"at":7,', '"at":8,')))) });
  assert.equal(wrong.ok, false);
  assert.match(wrong.ok ? "" : wrong.reason, /did not read back the same.*the original is kept/);
  intact();

  // one line short
  const short = await compressDayFile(plain, { afterWrite: (t) => writeFileSync(t, gzipSync(body.subarray(0, body.lastIndexOf(10, body.length - 2) + 1))) });
  assert.equal(short.ok, false);
  assert.match(short.ok ? "" : short.reason, /199 lines against 200/);
  intact();

  // a line appended while the pass ran: the pass gives way
  const grown = await compressDayFile(plain, { afterWrite: () => writeFileSync(plain, Buffer.concat([body, Buffer.from('{"late":1}\n')])) });
  assert.equal(grown.ok, false);
  assert.match(grown.ok ? "" : grown.reason, /changed while it was being compressed/);
  assert.deepEqual(readdirSync(dir), ["snapshots-2026-11-09.jsonl"]);
  writeFileSync(plain, body);

  // the temp file cannot be written at all (its name is taken by a directory)
  mkdirSync(`${plain}.gz.tmp`);
  const blocked = await compressDayFile(plain);
  assert.equal(blocked.ok, false);
  assert.ok(readFileSync(plain).equals(body));
  assert.equal(existsSync(`${plain}.gz`), false);

  // through the keeper: the failure is said, the day stays pending, and the pass after the obstacle is gone succeeds
  const keeper = new DayKeeper({ dir, families: ["snapshots"] });
  const now = Date.parse("2026-11-11T03:00:00Z");
  const first = await keeper.maintain(now);
  assert.equal(first.compressed?.ok, false);
  assert.match(keeper.health(now).compression.lastError ?? "", /could not be compressed/);
  assert.equal(keeper.health(now).compression.pending, 1);
  rmdirSync(`${plain}.gz.tmp`);
  const second = await keeper.maintain(now);
  assert.equal(second.compressed?.ok, true);
  assert.deepEqual(readdirSync(dir), ["snapshots-2026-11-09.jsonl.gz"]);
  assert.ok(gunzipSync(readFileSync(`${plain}.gz`)).equals(body));
  assert.deepEqual([keeper.health(now).compression.pending, keeper.health(now).compression.lastError, keeper.health(now).compression.last?.lines], [0, undefined, 200]);
});

test("both forms of one day: readers take the .jsonl and count the day once; the next pass removes the original only when the copy holds the same bytes, and refuses when it does not", async () => {
  const dir = tmp("both");
  const now = Date.parse("2026-11-11T03:00:00Z");
  const lines = ["2026-11-09T20:00:00.000Z", "2026-11-09T20:01:00.000Z", "2026-11-09T20:02:00.000Z"].map((at) => JSON.stringify(snap(at)));
  const body = Buffer.from(`${lines.join("\n")}\n`);
  const plain = join(dir, "snapshots-2026-11-09.jsonl");
  // the state a stop between the rename and the removal leaves: the same day twice
  writeFileSync(plain, body);
  writeFileSync(`${plain}.gz`, gzipSync(body));
  const files = listDayFiles(dir, ["snapshots"]);
  assert.equal(files.length, 1, "one day, not two");
  assert.equal(readablePath(files[0]), plain, "the plain file is the one read");
  const store = new SnapshotStore(dir, { keepHours: 72 });
  assert.equal(await store.load(now), 3, "three snapshots, not six");
  assert.deepEqual(dataUsage(dir).dayFiles, { plain: 1, gz: 1 });

  const r = await store.maintain(now);
  assert.ok(r.compressed?.ok && r.compressed.finishedEarlier);
  assert.deepEqual(readdirSync(dir), ["snapshots-2026-11-09.jsonl.gz"]);
  assert.equal(await new SnapshotStore(dir, { keepHours: 72 }).load(now), 3, "the same three from the gzip alone");

  // the two disagree: which is right cannot be known, so neither is touched and it is said
  const other = Buffer.from(`${lines.slice(0, 2).join("\n")}\n`);
  writeFileSync(plain, other);
  const again = new SnapshotStore(dir, { keepHours: 72 });
  assert.equal(await again.load(now), 2, "the plain file is still the one read");
  const refused = await again.maintain(now);
  assert.equal(refused.compressed?.ok, false);
  assert.match(again.dataHealth(now).compression.lastError ?? "", /both exist and do not hold the same lines\. Neither is removed; readers use snapshots-2026-11-09\.jsonl\./);
  assert.ok(readFileSync(plain).equals(other));
  assert.ok(gunzipSync(readFileSync(`${plain}.gz`)).equals(body));
});

test("the current UTC day is never compressed, and a day that has just ended waits out the grace so a late line still lands in it", async () => {
  const dir = tmp("today");
  const store = new SnapshotStore(dir, { keepHours: 1 });
  store.append(snap("2026-11-10T23:59:30.000Z"));
  store.append(snap("2026-11-11T00:00:30.000Z"));
  const names = () => readdirSync(dir).sort();
  for (const at of ["2026-11-10T23:59:59Z", "2026-11-11T00:00:00Z", "2026-11-11T00:59:59Z"]) {
    const r = await store.maintain(Date.parse(at));
    assert.equal(r.compressed, null, `nothing is compressed at ${at}`);
    assert.deepEqual(names(), ["snapshots-2026-11-10.jsonl", "snapshots-2026-11-11.jsonl"]);
  }
  // a cycle that began before midnight writes into the day it began in, after midnight
  store.append(snap("2026-11-10T23:59:50.000Z"));
  const r = await store.maintain(Date.parse("2026-11-11T01:00:00Z"));
  assert.ok(r.compressed?.ok && r.compressed.lines === 2, "yesterday goes once the hour of grace has passed, with its late line");
  assert.deepEqual(names(), ["snapshots-2026-11-10.jsonl.gz", "snapshots-2026-11-11.jsonl"]);
  for (let i = 0; i < 3; i += 1) assert.equal((await store.maintain(Date.parse("2026-11-11T23:59:59Z"))).compressed, null, "today stays plain all day");
  assert.deepEqual(names(), ["snapshots-2026-11-10.jsonl.gz", "snapshots-2026-11-11.jsonl"]);

  // with no grace at all the current day is still never taken
  const bare = tmp("today-bare");
  writeFileSync(join(bare, "gaps-2026-11-11.jsonl"), "{}\n");
  const keeper = new DayKeeper({ dir: bare, families: ["gaps"], graceMs: 0 });
  assert.equal((await keeper.maintain(Date.parse("2026-11-11T23:59:59.999Z"))).compressed, null);
  assert.equal((await keeper.maintain(Date.parse("2026-11-12T00:00:00Z"))).compressed?.ok, true);
});

test("one closed day per pass, oldest first; passes do not overlap; a day that will not compress does not hold up the others", async () => {
  const dir = tmp("pace");
  const now = Date.parse("2026-11-11T03:00:00Z");
  for (const day of ["2026-11-07", "2026-11-08", "2026-11-09"]) writeFileSync(join(dir, `snapshots-${day}.jsonl`), `{"day":"${day}"}\n`);
  // 7 November already has a copy that disagrees with it: a refusal every time
  writeFileSync(join(dir, "snapshots-2026-11-07.jsonl.gz"), gzipSync(Buffer.from("{}\n")));
  const keeper = new DayKeeper({ dir, families: ["snapshots"] });
  const [a, b] = [keeper.maintain(now), keeper.maintain(now)];
  assert.equal(a, b, "a pass asked for while one runs is that one");
  assert.equal((await a).compressed?.ok, false);
  assert.equal((await keeper.maintain(now)).compressed?.file, "snapshots-2026-11-08.jsonl.gz");
  assert.equal((await keeper.maintain(now)).compressed?.file, "snapshots-2026-11-09.jsonl.gz");
  assert.equal((await keeper.maintain(now)).compressed?.ok, false, "back to the one that refuses");
  assert.deepEqual(readdirSync(dir).sort(), ["snapshots-2026-11-07.jsonl", "snapshots-2026-11-07.jsonl.gz", "snapshots-2026-11-08.jsonl.gz", "snapshots-2026-11-09.jsonl.gz"]);
});

test("boot reload reads gzip days: the curve history comes back from a .jsonl.gz the same as from the .jsonl, and a gzip that cannot be read is said, left and skipped", async () => {
  const dir = tmp("reload");
  const now = Date.parse("2026-11-11T02:00:00Z");
  const store = new SnapshotStore(dir, { keepHours: 72 });
  for (const at of ["2026-11-09T10:00:00.000Z", "2026-11-09T10:01:00.000Z", "2026-11-10T10:00:00.000Z", "2026-11-11T01:00:00.000Z"]) store.append(snap(at));
  const before = new SnapshotStore(dir, { keepHours: 72 });
  assert.equal(await before.load(now), 4);
  assert.equal((await store.maintain(now)).compressed?.file, "snapshots-2026-11-09.jsonl.gz");
  assert.equal((await store.maintain(now)).compressed?.file, "snapshots-2026-11-10.jsonl.gz");
  assert.deepEqual(readdirSync(dir).sort(), ["snapshots-2026-11-09.jsonl.gz", "snapshots-2026-11-10.jsonl.gz", "snapshots-2026-11-11.jsonl"]);
  const after = new SnapshotStore(dir, { keepHours: 72 });
  assert.equal(await after.load(now), 4);
  assert.deepEqual(after.getHistory(), before.getHistory());
  assert.equal(after.getLatest()?.at, "2026-11-11T01:00:00.000Z");

  writeFileSync(join(dir, "snapshots-2026-11-08.jsonl.gz"), "this is not gzip");
  const bad = new SnapshotStore(dir, { keepHours: 96 });
  assert.equal(await bad.load(now), 4, "the other days still load");
  assert.match((bad.dataHealth(now).notes ?? []).join(" "), /snapshots-2026-11-08\.jsonl\.gz could not be read on start-up.*it is left on disk/);
  assert.ok(existsSync(join(dir, "snapshots-2026-11-08.jsonl.gz")));
});

test("/healthz data block on a hand-made directory: bytes, files, day files of each form, oldest and newest day, retention, the budget and its warning", () => {
  const dir = tmp("health");
  mkdirSync(join(dir, "pairs"));
  const put = (name: string, bytes: number) => writeFileSync(join(dir, name), Buffer.alloc(bytes, 0x61));
  put("snapshots-2026-11-08.jsonl.gz", 1000);
  put("snapshots-2026-11-09.jsonl.gz", 2000);
  put("snapshots-2026-11-10.jsonl", 30_000);
  put("snapshots-2026-11-11.jsonl", 4000);
  put("pairs/gaps-2026-10-30.jsonl.gz", 500);
  put("pairs/gaps-2026-11-11.jsonl", 700);
  put("pairs/episodes-2026-11-12.jsonl", 300);
  put("collecting-since.txt", 24);
  put("replay-state.json", 476);
  const now = Date.parse("2026-11-11T12:00:00Z");
  const total = 1000 + 2000 + 30_000 + 4000 + 500 + 700 + 300 + 24 + 476;
  assert.equal(total, 39_000);

  const plain = new DayKeeper({ dir, families: ["snapshots"], retention: parseRetention(undefined, "BTC_CURVE_RETAIN_DAYS") }).health(now);
  assert.equal(plain.dir, dir);
  assert.deepEqual([plain.bytes, plain.files, plain.dayFiles, plain.oldestDay, plain.newestDay], [39_000, 9, { plain: 4, gz: 3 }, "2026-10-30", "2026-11-12"]);
  assert.deepEqual([plain.retention, plain.retentionNote, plain.budget, plain.warning, plain.recording, plain.notRecording], ["all", undefined, undefined, undefined, true, undefined]);
  assert.equal(plain.compression.pending, 1, "10 November is closed and still plain; the pairs files belong to another keeper");
  assert.ok(plain.filesystem && plain.filesystem.totalBytes > 0 && plain.filesystem.freeBytes >= 0);

  // 39,000 bytes against budgets in MB: 0.05 MB is 52,428.8 bytes (74.4%), 0.04 MB is 41,943.04 (93.0%), 0.03 MB is 31,457.28 (124.0%)
  const at = (mb: string, days?: string) => new DayKeeper({ dir, families: ["snapshots"], retention: parseRetention(days, "BTC_CURVE_RETAIN_DAYS"), budget: parseBudgetMb(mb, "BTC_CURVE_DISK_BUDGET_MB") }).health(now);
  assert.deepEqual([at("0.05").budget, at("0.05").warning], [{ mb: 0.05, usedPct: 74.4 }, undefined]);
  const near = at("0.04", "21");
  assert.deepEqual([near.budget, near.retention], [{ mb: 0.04, usedPct: 93 }, "21 days"]);
  assert.equal(near.warning, "Data is at 93.0% of the 0.04 MB budget (0 MB) set in BTC_CURVE_DISK_BUDGET_MB. Nothing is deleted because of the budget. Raise the disk, or set BTC_CURVE_RETAIN_DAYS to a number of days to keep a window.");
  const over = at("0.03");
  assert.equal(over.budget?.usedPct, 124);
  assert.match(over.warning ?? "", /^Data is over the budget: 0 MB is 124\.0% of the 0\.03 MB set in BTC_CURVE_DISK_BUDGET_MB\. Nothing is deleted because of the budget\./);
  assert.equal(readdirSync(dir).length + readdirSync(join(dir, "pairs")).length, 10, "being over the budget removed nothing");

  const badBudget = at("3GB");
  assert.deepEqual([badBudget.budget, badBudget.warning], [undefined, undefined]);
  assert.match((badBudget.notes ?? []).join(" "), /BTC_CURVE_DISK_BUDGET_MB is "3GB", which is not a size in MB\. No budget is in force\./);
  const line = new DayKeeper({ dir, families: ["snapshots"], budget: parseBudgetMb("0.04", "BTC_CURVE_DISK_BUDGET_MB") }).startupLine(now);
  assert.match(line, /^keeping every day, closed days gzipped · 0 MB in 7 day files since 2026-10-30 · 93% of the 0\.04 MB budget · Data is at 93\.0% of the 0\.04 MB budget/);

  const none = new DayKeeper({ dir: join(dir, "not-there-yet"), families: ["snapshots"] }).health(now);
  assert.deepEqual([none.bytes, none.files, none.dayFiles, none.oldestDay, none.newestDay, none.filesystem], [0, 0, { plain: 0, gz: 0 }, null, null, undefined]);
});

test("a failing append does not throw: the snapshot is still served from memory, /healthz says not recording and why, and the count of lost writes stays after writing resumes", () => {
  const dir = tmp("full");
  let full = false;
  const calls: string[] = [];
  const store = new SnapshotStore(dir, {
    keepHours: 1,
    keeper: {
      appendImpl: (path, data) => {
        calls.push(path);
        if (full) throw diskFull();
        writeFileSync(path, data, { flag: "a" });
      },
    },
  });
  assert.equal(store.append(snap("2026-11-09T20:00:00.000Z")), true);
  assert.equal(store.dataHealth().recording, true);

  full = true;
  assert.doesNotThrow(() => store.append(snap("2026-11-09T20:01:00.000Z")));
  assert.equal(store.append(snap("2026-11-09T20:02:00.000Z")), false);
  assert.equal(store.getLatest()?.at, "2026-11-09T20:02:00.000Z", "the page still has the newest snapshot");
  assert.equal(store.getHistory().length, 3);
  const h = store.dataHealth();
  assert.equal(h.recording, false);
  assert.match(h.notRecording ?? "", /^Not recording: the last write to snapshots-2026-11-09\.jsonl failed at \S+ because the disk is full \(ENOSPC\); 2 in a row since \S+ are not on disk\. The pages keep serving from memory\.$/);
  assert.equal(h.writesLost?.count, 2);
  assert.equal(readFileSync(join(dir, "snapshots-2026-11-09.jsonl"), "utf8").trim().split("\n").length, 1, "the line written before the disk filled is intact");
  assert.match(store.startupLine(), /Not recording: the last write to snapshots-2026-11-09\.jsonl failed/);

  // a write beside the day files that fails is remembered on its own: a snapshot that lands does not hide it
  full = false;
  assert.equal(store.append(snap("2026-11-09T20:03:00.000Z")), true);
  assert.equal(store.dataHealth().recording, true);
  assert.equal(store.guardWrite("replay-state.json", () => {
    throw diskFull();
  }), false);
  assert.equal(store.append(snap("2026-11-09T20:04:00.000Z")), true);
  const mixed = store.dataHealth();
  assert.equal(mixed.recording, false);
  assert.match(mixed.notRecording ?? "", /the last write to replay-state\.json failed/);
  assert.equal(store.guardWrite("replay-state.json", () => {}), true);
  const back = store.dataHealth();
  assert.deepEqual([back.recording, back.notRecording, back.writesLost?.count], [true, undefined, 3]);
  assert.equal(readFileSync(join(dir, "snapshots-2026-11-09.jsonl"), "utf8").trim().split("\n").length, 3);
  // an error that is not the filesystem's is not swallowed as a write failure
  assert.throws(() => store.guardWrite("replay-state.json", () => {
    throw new TypeError("a bug, not a disk");
  }), /a bug, not a disk/);

  // the real filesystem, no seam: the data dir's parent is a file, so no append can land
  const blocker = join(tmp("blocked"), "a-file");
  writeFileSync(blocker, "x");
  const keeper = new DayKeeper({ dir: join(blocker, "data"), families: ["snapshots"] });
  assert.equal(keeper.append("snapshots", Date.parse("2026-11-09T20:00:00Z"), "{}"), false);
  const real = keeper.health();
  assert.equal(real.recording, false);
  assert.match(real.notRecording ?? "", /Not recording: the last write to snapshots-2026-11-09\.jsonl failed .* because (ENOTDIR|EEXIST)/);
});

test("pairs day files: nothing is deleted on load any more, however old; a restart reloads its window from gzip days; BTC_PAIRS_RETAIN_DAYS sets a window and follows the host service's setting when unset", async () => {
  const dir = tmp("pairs");
  const now = Date.parse("2026-11-11T00:30:00Z");
  const episode = (endedAt: string): LockEpisode => ({
    horizon: "fifteen",
    settlesAt: "2026-11-10T23:45:00Z",
    key: "above:73700",
    strike: 73700,
    kalshiId: "KXBTC15M-26NOV101845-45",
    polyId: "cpc-btc-updown-15m-2026-11-10-2330z",
    yesOn: "polymarket_us",
    noOn: "kalshi",
    startedAt: new Date(Date.parse(endedAt) - 10_000).toISOString(),
    endedAt,
    durationSec: 10,
    cycles: 2,
    minLockCents: 1.2,
    minQty: 40,
    valueCents: 48,
  });
  const gap = (atMs: number, g: number) => JSON.stringify({ at: atMs, rows: [["2026-11-11T01:00:00Z", "above:73700", g]] });
  // a year-old day, a day five days back, and yesterday with readings inside the two-hour window
  writeFileSync(join(dir, "gaps-2025-11-01.jsonl"), `${gap(Date.parse("2025-11-01T12:00:00Z"), 1)}\n`);
  writeFileSync(join(dir, "episodes-2025-11-01.jsonl"), `${JSON.stringify(episode("2025-11-01T12:00:10.000Z"))}\n`);
  writeFileSync(join(dir, "episodes-2026-11-06.jsonl"), `${JSON.stringify(episode("2026-11-06T12:00:10.000Z"))}\n`);
  writeFileSync(join(dir, "gaps-2026-11-10.jsonl"), `${gap(now - 3 * 3_600_000, 9)}\n${gap(now - 40 * 60_000, 2)}\n${gap(now - 35 * 60_000, 3)}\n`);
  writeFileSync(join(dir, "episodes-2026-11-10.jsonl"), `${JSON.stringify(episode("2026-11-10T23:40:10.000Z"))}\n`);
  writeFileSync(join(dir, "gaps-2026-11-11.jsonl"), `${gap(now - 60_000, 4)}\n`);
  const before = new Map(readdirSync(dir).map((n) => [n, readFileSync(join(dir, n))]));

  const fresh = () => new PairsCollector({ dataDir: dir, clock: () => now, log: () => {} });
  const a = fresh();
  assert.equal(await a.loadGaps(now), 3, "the three readings inside the window; the one three hours back is outside it");
  assert.equal(await a.loadEpisodes(now), 1, "yesterday's episode; the older ones are kept on disk, not in memory");
  assert.deepEqual(readdirSync(dir).sort(), [...before.keys()].sort(), "loading deletes nothing, not the year-old day either");

  // the hourly pass, as many times as there are closed days: all gzip, none gone, bytes the same
  for (let i = 0; i < 6; i += 1) await a.maintain(now + 3_600_000);
  const names = readdirSync(dir).sort();
  assert.deepEqual(names, ["episodes-2025-11-01.jsonl.gz", "episodes-2026-11-06.jsonl.gz", "episodes-2026-11-10.jsonl.gz", "gaps-2025-11-01.jsonl.gz", "gaps-2026-11-10.jsonl.gz", "gaps-2026-11-11.jsonl"]);
  for (const [name, bytes] of before) {
    const now_ = existsSync(join(dir, name)) ? readFileSync(join(dir, name)) : gunzipSync(readFileSync(join(dir, `${name}.gz`)));
    assert.ok(now_.equals(bytes), `${name} holds the bytes it held`);
  }
  const b = fresh();
  assert.equal(await b.loadGaps(now), 3, "the same window from yesterday's gzip");
  assert.equal(await b.loadEpisodes(now), 1);
  const health = b.health() as { data: { retention: string; dayFiles: { plain: number; gz: number }; oldestDay: string; recording: boolean } };
  assert.deepEqual([health.data.retention, health.data.dayFiles, health.data.oldestDay, health.data.recording], ["all", { plain: 1, gz: 5 }, "2025-11-01", true]);

  // settings: its own, the host's when its own is unset, and an unreadable one that deletes nothing
  const retentionOf = (c: PairsCollector) => (c.health() as { data: { retention: string; retentionNote?: string } }).data;
  const env = { BTC_PAIRS_DATA_DIR: dir };
  assert.equal(retentionOf(pairsCollectorFromEnv(env)).retention, "all");
  assert.equal(retentionOf(pairsCollectorFromEnv({ ...env, BTC_PAIRS_RETAIN_DAYS: "30" })).retention, "30 days");
  assert.equal(retentionOf(pairsCollectorFromEnv(env, { retainDays: "21", retainSetting: "BTC_CURVE_RETAIN_DAYS" })).retention, "21 days");
  assert.equal(retentionOf(pairsCollectorFromEnv(env, { retainDays: "", retainSetting: "BTC_CURVE_RETAIN_DAYS" })).retention, "all");
  assert.equal(retentionOf(pairsCollectorFromEnv({ ...env, BTC_PAIRS_RETAIN_DAYS: "all" }, { retainDays: "21", retainSetting: "BTC_CURVE_RETAIN_DAYS" })).retention, "all", "its own setting wins");
  assert.match(retentionOf(pairsCollectorFromEnv(env, { retainDays: "three weeks", retainSetting: "BTC_CURVE_RETAIN_DAYS" })).retentionNote ?? "", /BTC_CURVE_RETAIN_DAYS is "three weeks".*Nothing is deleted/);
  assert.match(retentionOf(pairsCollectorFromEnv({ ...env, BTC_PAIRS_RETAIN_DAYS: "-3" })).retentionNote ?? "", /BTC_PAIRS_RETAIN_DAYS is "-3".*Nothing is deleted/);

  // a window of 30 days: the year-old day goes, both families, and nothing inside the window
  const windowed = pairsCollectorFromEnv({ ...env, BTC_PAIRS_RETAIN_DAYS: "30" });
  const r = await windowed.maintain(now + 3_600_000);
  assert.deepEqual(r.removed.sort(), ["episodes-2025-11-01.jsonl.gz", "gaps-2025-11-01.jsonl.gz"]);
  assert.deepEqual(readdirSync(dir).sort(), ["episodes-2026-11-06.jsonl.gz", "episodes-2026-11-10.jsonl.gz", "gaps-2026-11-10.jsonl.gz", "gaps-2026-11-11.jsonl"]);
});
