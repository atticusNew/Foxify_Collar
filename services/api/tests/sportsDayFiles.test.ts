/**
 * The sports snapshots are kept the way the BTC ones are (src/btcCurve/dayFiles.ts): every day
 * unless a window is set, closed days gzipped, either form read on boot, a failed write said and
 * not thrown. Real files in a temp dir; no network.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { listDayFiles, parseBudgetMb, parseRetention } from "../src/btcCurve/dayFiles";
import { SnapshotStore } from "../src/sportsVenues/store";
import type { Snapshot } from "../src/sportsVenues/types";

const DAY = 86_400_000;
const T0 = Date.parse("2026-01-01T00:00:00Z");
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const tmp = (tag: string) => mkdtempSync(join(tmpdir(), `sv-day-${tag}-`));
const snap = (at: string): Snapshot => ({ at, games: [], health: { kalshi: { ok: true, ms: 1 } } });

test("sports default: 400 days, the hourly pass run every day, and every day is still there, the closed ones as gzip with the bytes they had", async () => {
  const dir = tmp("400");
  const store = new SnapshotStore(dir, { keepHours: 1 });
  const lines = new Map<string, string>();
  for (let d = 0; d < 400; d += 1) {
    const s = snap(new Date(T0 + d * DAY + 18 * 3_600_000).toISOString());
    assert.equal(store.append(s), true);
    lines.set(dayOf(T0 + d * DAY), `${JSON.stringify(s)}\n`);
    assert.deepEqual((await store.maintain(T0 + d * DAY + 19 * 3_600_000)).removed, []);
    assert.equal(store.sweep(T0 + d * DAY + 19 * 3_600_000), 0);
  }
  const files = listDayFiles(dir, ["snapshots"]);
  assert.equal(files.length, 400);
  assert.equal(files.filter((f) => f.gz && !f.plain).length, 399);
  for (const f of files) {
    const bytes = f.plain ? readFileSync(f.plain) : gunzipSync(readFileSync(f.gz as string));
    assert.equal(bytes.toString("utf8"), lines.get(f.day), `${f.day} holds the line it was given`);
  }
  assert.equal(store.dataHealth(T0 + 400 * DAY).retention, "all");
});

test("sports window: SPORTS_VENUES_RETAIN_DAYS as a number deletes exactly the days outside it; unreadable, it deletes nothing and says so", async () => {
  const fill = (dir: string) => {
    for (let d = 0; d < 30; d += 1) {
      const day = dayOf(Date.parse("2026-11-01T00:00:00Z") + d * DAY);
      const body = Buffer.from(`${JSON.stringify(snap(`${day}T12:00:00.000Z`))}\n`);
      if (d < 20) writeFileSync(join(dir, `snapshots-${day}.jsonl.gz`), gzipSync(body));
      else writeFileSync(join(dir, `snapshots-${day}.jsonl`), body);
    }
  };
  const now = Date.parse("2026-11-30T23:00:00Z");

  const dir = tmp("window");
  fill(dir);
  const store = new SnapshotStore(dir, { retention: parseRetention("7", "SPORTS_VENUES_RETAIN_DAYS") });
  // outside: a first instant more than 7 days before 23:00 on the 30th, so 1 to 23 November
  assert.equal(store.sweep(now), 23);
  assert.deepEqual(listDayFiles(dir, ["snapshots"]).map((f) => f.day), ["2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29", "2026-11-30"]);
  assert.equal(store.dataHealth(now).retention, "7 days");

  for (const raw of ["abc", "-3", "2.5"]) {
    const kept = tmp("unreadable");
    fill(kept);
    const s = new SnapshotStore(kept, { retention: parseRetention(raw, "SPORTS_VENUES_RETAIN_DAYS") });
    assert.equal(s.sweep(now), 0);
    assert.deepEqual((await s.maintain(now)).removed, []);
    assert.equal(listDayFiles(kept, ["snapshots"]).length, 30, `${raw} deletes nothing`);
    const h = s.dataHealth(now);
    assert.equal(h.retention, "all");
    assert.match(h.retentionNote ?? "", new RegExp(`SPORTS_VENUES_RETAIN_DAYS is ${JSON.stringify(raw).replace(/[.]/g, "\\.")}, which is not a whole number of days\\. Nothing is deleted\\.`));
    assert.match(s.startupLine(now), /keeping every day.*Nothing is deleted\./);
  }
});

test("sports reload: the window comes back from gzip days, a day present in both forms is counted once, today is never compressed", async () => {
  const dir = tmp("reload");
  const now = Date.parse("2026-11-11T02:00:00Z");
  const store = new SnapshotStore(dir, { keepHours: 72 });
  for (const at of ["2026-11-09T15:00:00.000Z", "2026-11-09T15:01:00.000Z", "2026-11-10T15:00:00.000Z", "2026-11-11T01:00:00.000Z"]) store.append(snap(at));
  const before = new SnapshotStore(dir, { keepHours: 72 });
  assert.equal(before.load(now), 4);

  // the copy is written and the original not yet removed: one day, counted once
  writeFileSync(join(dir, "snapshots-2026-11-09.jsonl.gz"), gzipSync(readFileSync(join(dir, "snapshots-2026-11-09.jsonl"))));
  assert.equal(new SnapshotStore(dir, { keepHours: 72 }).load(now), 4);

  for (let i = 0; i < 4; i += 1) await store.maintain(now);
  assert.deepEqual(readdirSync(dir).sort(), ["snapshots-2026-11-09.jsonl.gz", "snapshots-2026-11-10.jsonl.gz", "snapshots-2026-11-11.jsonl"]);
  const after = new SnapshotStore(dir, { keepHours: 72 });
  assert.equal(after.load(now), 4);
  assert.deepEqual(after.getHistory(), before.getHistory());
  assert.equal(after.getLatest()?.at, "2026-11-11T01:00:00.000Z");
  assert.equal((await store.maintain(Date.parse("2026-11-11T23:59:59Z"))).compressed, null);
  assert.ok(existsSync(join(dir, "snapshots-2026-11-11.jsonl")));
});

test("sports /healthz data block and a failing append: the numbers of a hand-made directory, the budget warning, and a full disk that is said, not thrown", () => {
  const dir = tmp("health");
  writeFileSync(join(dir, "snapshots-2026-11-09.jsonl.gz"), Buffer.alloc(6000, 0x62));
  writeFileSync(join(dir, "snapshots-2026-11-10.jsonl.gz"), Buffer.alloc(8000, 0x62));
  writeFileSync(join(dir, "collecting-since.txt"), Buffer.alloc(24, 0x62));
  const now = Date.parse("2026-11-11T12:00:00Z");
  let full = false;
  const store = new SnapshotStore(dir, {
    keepHours: 1,
    budget: parseBudgetMb("0.015", "SPORTS_VENUES_DISK_BUDGET_MB"),
    retention: parseRetention(undefined, "SPORTS_VENUES_RETAIN_DAYS"),
    keeper: {
      appendImpl: (path, data) => {
        if (full) throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", syscall: "write" });
        writeFileSync(path, data, { flag: "a" });
      },
    },
  });
  // 14,024 bytes of a 0.015 MB (15,728.64 byte) budget: 89.2%
  const h = store.dataHealth(now);
  assert.deepEqual([h.bytes, h.files, h.dayFiles, h.oldestDay, h.newestDay, h.retention, h.budget], [14_024, 3, { plain: 0, gz: 2 }, "2026-11-09", "2026-11-10", "all", { mb: 0.015, usedPct: 89.2 }]);
  assert.match(h.warning ?? "", /^Data is at 89\.2% of the 0\.015 MB budget .* set in SPORTS_VENUES_DISK_BUDGET_MB\. Nothing is deleted because of the budget\. Raise the disk, or set SPORTS_VENUES_RETAIN_DAYS to a number of days to keep a window\.$/);
  assert.equal(h.recording, true);

  full = true;
  assert.doesNotThrow(() => store.append(snap("2026-11-11T11:59:00.000Z")));
  assert.equal(store.getLatest()?.at, "2026-11-11T11:59:00.000Z", "the page still has the snapshot");
  const failed = store.dataHealth(now);
  assert.equal(failed.recording, false);
  assert.match(failed.notRecording ?? "", /^Not recording: the last write to snapshots-2026-11-11\.jsonl failed at \S+ because the disk is full \(ENOSPC\); 1 in a row since \S+ is not on disk\. The pages keep serving from memory\.$/);
  assert.deepEqual(readdirSync(dir).sort(), ["collecting-since.txt", "snapshots-2026-11-09.jsonl.gz", "snapshots-2026-11-10.jsonl.gz"], "nothing was deleted to make room");

  full = false;
  assert.equal(store.append(snap("2026-11-11T12:00:00.000Z")), true);
  assert.deepEqual([store.dataHealth(now).recording, store.dataHealth(now).writesLost?.count], [true, 1]);
});
