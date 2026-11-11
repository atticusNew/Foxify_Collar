/**
 * The BTC service runs in 512 MB and a day of its snapshots is over 200 MB. These tests hold the
 * three things that keep it inside that: the reload reads a day as a stream, the history keeps
 * numbers in blocks and lets go of settled ladders, and the page's series are bounded while its
 * numbers still count every point. No network.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createWriteStream, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGzip, gunzipSync, gzipSync } from "node:zlib";
import { once } from "node:events";
import { GAP_SERIES_RUNS, gapSeries } from "../src/btcCurve/analytics";
import * as dayFiles from "../src/btcCurve/dayFiles";
import { PairsCollector } from "../src/btcCurve/pairsCollector";
import { buildReport } from "../src/btcCurve/report";
import { renderReportHtml } from "../src/btcCurve/reportHtml";
import { ROW_WIDTH, SETTLED_GRACE_MS, SnapshotStore, toDisk, toHistoryPoint } from "../src/btcCurve/store";
import type { Ladder, Snapshot, VenueQuote } from "../src/btcCurve/types";

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = (name: string) => mkdtempSync(join(tmpdir(), `btc-boot-${name}-`));
const MIN = 60_000;
const T0 = Date.parse("2026-11-10T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

let seed = 20261111;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const quote = (venue: VenueQuote["venue"], bucketKey: string, bidCents: number, askCents: number): VenueQuote => ({ venue, bucketKey, id: `${venue}-${bucketKey}`, bidCents, askCents, bidQty: 10, askQty: 10, volume: 0, openInterest: 0, feeTheta: 0.07 });

function ladder(id: string, settlesAt: string, keys: string[], price: (key: string, venue: "kalshi" | "polymarket_us") => [number, number] | null, model: (key: string) => number | null = () => 0.5): Ladder {
  const l: Ladder = { id, title: id, settlesAt, buckets: keys.map((key) => ({ key, kind: "above", level: Number(key.split(":")[1]), settlesAt })), quotes: [], model: {} };
  for (const key of new Set(keys)) {
    for (const venue of ["kalshi", "polymarket_us"] as const) {
      const p = price(key, venue);
      if (p) l.quotes.push(quote(venue, key, p[0], p[1]));
    }
    const m = model(key);
    if (m !== null) l.model[key] = { p: m, expiry: "25DEC26", iv: 0.5 };
  }
  return l;
}

const snapshot = (atMs: number, ladders: Ladder[]): Snapshot => ({ at: iso(atMs), spotUsd: 74000, spotSource: "brti", ladders, options: [], health: {} });

/* ---- the history as it was kept before: an object per bucket, a tuple per row. Kept here as the reference. ---- */

type OldPoint = { atMs: number; ladders: Record<string, Record<string, [number, number, number, number, number]>> };

function oldPoint(s: Snapshot): OldPoint {
  const ladders: OldPoint["ladders"] = {};
  for (const l of s.ladders) {
    const row: Record<string, [number, number, number, number, number]> = {};
    for (const b of l.buckets) {
      const k = l.quotes.find((q) => q.venue === "kalshi" && q.bucketKey === b.key);
      const p = l.quotes.find((q) => q.venue === "polymarket_us" && q.bucketKey === b.key);
      const m = l.model[b.key];
      row[b.key] = [k ? k.bidCents : -1, k ? k.askCents : -1, p ? p.bidCents : -1, p ? p.askCents : -1, m ? m.p * 100 : -1];
    }
    ladders[l.id] = row;
  }
  return { atMs: Date.parse(s.at), ladders };
}

function oldGapSeries(history: OldPoint[], ladderId: string) {
  const keys = new Set<string>();
  for (const h of history) for (const k of Object.keys(h.ladders[ladderId] ?? {})) keys.add(k);
  const out: Array<{ key: string; venue: Array<[number, number]>; kalshiModel: Array<[number, number]>; polyModel: Array<[number, number]>; stats: { venueMeanAbs: number | null; venueMax: number | null; venueLast: number | null; n: number } }> = [];
  for (const key of keys) {
    const venue: Array<[number, number]> = [];
    const kalshiModel: Array<[number, number]> = [];
    const polyModel: Array<[number, number]> = [];
    for (const h of history) {
      const row = h.ladders[ladderId]?.[key];
      if (!row) continue;
      const [kb, ka, pb, pa, m] = row;
      const km = kb >= 0 && ka > 0 && ka <= 99 ? (kb + ka) / 2 : null;
      const pm = pb >= 0 && pa > 0 && pa <= 99 ? (pb + pa) / 2 : null;
      if (km !== null && pm !== null) venue.push([h.atMs, km - pm]);
      if (km !== null && m >= 0) kalshiModel.push([h.atMs, km - m]);
      if (pm !== null && m >= 0) polyModel.push([h.atMs, pm - m]);
    }
    const abs = venue.map(([, g]) => Math.abs(g));
    out.push({
      key,
      venue,
      kalshiModel,
      polyModel,
      stats: {
        venueMeanAbs: abs.length ? Math.round((abs.reduce((a, b) => a + b, 0) / abs.length) * 100) / 100 : null,
        venueMax: abs.length ? Math.round(Math.max(...abs) * 100) / 100 : null,
        venueLast: venue.length ? Math.round(venue[venue.length - 1][1] * 100) / 100 : null,
        n: venue.length,
      },
    });
  }
  const level = (k: string) => Number(k.split(":")[1]?.split("-")[0]) || 0;
  return out.sort((a, b) => level(a.key) - level(b.key));
}

/** Random snapshots of one ladder: quotes come and go, a venue is missing, the model is missing, buckets join later, a key is listed twice. */
function randomRun(points: number): Snapshot[] {
  const all = ["above:70000", "above:71000", "above:72000", "above:73000", "above:74000", "above:75000", "above:76000"];
  const out: Snapshot[] = [];
  for (let i = 0; i < points; i += 1) {
    const listed = all.filter((_, at) => at < 4 || i > points / 3 || rnd() < 0.3);
    if (rnd() < 0.1) listed.push(listed[0]);
    const l = ladder(
      "L",
      "2027-01-01T05:00:00Z",
      listed,
      (_, venue) => {
        if (rnd() < 0.08) return null;
        const bid = Math.floor(rnd() * 101) - 1;
        return [bid, rnd() < 0.05 ? 100 : bid + 1 + Math.floor(rnd() * 3)];
      },
      () => (rnd() < 0.1 ? null : rnd()),
    );
    // a second quote for a bucket a venue already gave: the first is the one kept
    if (rnd() < 0.2 && l.quotes.length) l.quotes.push({ ...l.quotes[0], bidCents: 1, askCents: 2 });
    out.push(snapshot(T0 + i * MIN, [l, ladder("other", "2027-01-01T05:00:00Z", ["above:1"], () => [10, 11])]));
  }
  return out;
}

test("the history point holds a ladder's numbers in one block, and the gap series it gives are the ones the object-per-bucket form gave, to the last digit", () => {
  const snaps = randomRun(GAP_SERIES_RUNS);
  const got = gapSeries(snaps.map((s) => toHistoryPoint(s)), "L");
  const want = oldGapSeries(snaps.map(oldPoint), "L");
  assert.equal(got.length, 7);
  assert.deepEqual(
    got.map((g) => ({ key: g.key, venue: g.venue, kalshiModel: g.kalshiModel, polyModel: g.polyModel, stats: g.stats })),
    want,
    "series, order and rounded numbers all the same",
  );
  assert.ok(got.every((g) => g.seriesEvery === 1), "a window this short keeps every point");
  assert.ok(want.some((g) => g.venue.length > 100) && want.some((g) => g.venue.length < want[0].venue.length), "the run exercised full and partial buckets");

  const p = toHistoryPoint(snaps[snaps.length - 1]);
  assert.ok(p.ladders.L.v instanceof Float64Array);
  assert.equal(p.ladders.L.v.length, p.ladders.L.keys.length * ROW_WIDTH);
  assert.equal(new Set(p.ladders.L.keys).size, p.ladders.L.keys.length, "a key listed twice is held once");
});

test("a window longer than the drawing: every number still counts every point, a one-minute spike is still drawn, and the series start and end where the window does", () => {
  const points = 3651;
  const spikeAt = 1777;
  const snaps: Snapshot[] = [];
  for (let i = 0; i < points; i += 1) {
    // Kalshi mid 50.5; Polymarket US mid wanders a little under it, and for one minute sits 30 cents over
    const poly = i === spikeAt ? 80 : 48 + Math.floor(rnd() * 3);
    snaps.push(snapshot(T0 + i * MIN, [ladder("btc-yearend-2026-range", "2027-01-01T05:00:00Z", ["range:70000-74999.99"], (_, venue) => (venue === "kalshi" ? [50, 51] : [poly, poly + 1]))]));
  }
  const history = snaps.map((s) => toHistoryPoint(s));
  const [g] = gapSeries(history, "btc-yearend-2026-range");
  const [ref] = oldGapSeries(snaps.map(oldPoint), "btc-yearend-2026-range");

  const every = Math.ceil(points / GAP_SERIES_RUNS);
  assert.equal(g.seriesEvery, every);
  assert.equal(every, 16, "three days of points a minute apart");
  assert.ok(g.venue.length <= 2 * Math.ceil(points / every) + 2, `${g.venue.length} points kept of ${points}`);
  assert.ok(g.venue.length < points / 5);

  assert.deepEqual(g.stats, ref.stats, "the rounded numbers are the ones from every point");
  const abs = ref.venue.map(([, x]) => Math.abs(x));
  assert.deepEqual(g.window.venue, { n: points, meanAbs: abs.reduce((a, b) => a + b, 0) / abs.length, maxAbs: 30, last: ref.venue[points - 1][1] });
  assert.equal(g.window.kalshiModel.n, points);

  const real = new Map(ref.venue.map(([t, x]) => [t, x]));
  assert.ok(g.venue.every(([t, x]) => real.get(t) === x), "every kept point is a point that happened");
  assert.ok(g.venue.every(([t], i) => i === 0 || t > g.venue[i - 1][0]), "in time order, none twice");
  assert.deepEqual(g.venue[0], ref.venue[0]);
  assert.deepEqual(g.venue[g.venue.length - 1], ref.venue[points - 1]);
  assert.ok(g.venue.some(([t, x]) => t === T0 + spikeAt * MIN && x === -30), "the spike is in the drawing");
  for (let run = 0; run * every < points; run += 1) {
    const slice: number[] = ref.venue.slice(run * every, (run + 1) * every).map(([, x]) => x);
    const kept: number[] = g.venue.filter(([t]) => t >= T0 + run * every * MIN && t < T0 + (run + 1) * every * MIN).map(([, x]) => x);
    assert.equal(Math.min(...kept), Math.min(...slice), `run ${run} keeps its low`);
    assert.equal(Math.max(...kept), Math.max(...slice), `run ${run} keeps its high`);
  }

  // the page: the numbers beside the drawing are the window's, not the drawing's
  const last = snaps[points - 1];
  const html = renderReportHtml(buildReport({ snapshot: last, history, candles: [], replay: { n: 0, open: 0, meanNaked: null, meanStatic: null, meanDynamic: null, p90AbsNaked: null, p90AbsStatic: null, p90AbsDynamic: null, meanStaticEntryUsd: null, meanDynamicCostUsd: null, recent: [] }, collar: null, intervalSec: 60, collectingSince: null }), { refreshSec: 60 });
  const row = html.slice(html.indexOf("Kalshi − Poly, window"));
  assert.match(row, new RegExp(`<td class="dim">${points}</td>`), "n is every point");
  assert.match(row, />30(\.0+)?¢?</, "max is the spike");
});

test("a ladder's rows are let go an hour after it settles, in memory only; the keys are one shared list; a reload holds the same as a running service", async () => {
  const dir = tmp("settled");
  const hourlySettles = T0 + 10 * MIN;
  const hourly = (bid: number) => ladder("btc-hourly:KXBTCD-26NOV1012", iso(hourlySettles), ["above:73000", "above:74000"], () => [bid, bid + 1]);
  const yearEnd = (bid: number) => ladder("btc-yearend-2026-range", "2027-01-01T05:00:00Z", ["above:70000", "above:80000"], () => [bid, bid + 1]);
  const undated = (bid: number) => ladder("poly:no-date", "not a date", ["above:1"], () => [bid, bid + 1]);

  const store = new SnapshotStore(dir, { keepHours: 72 });
  store.append(snapshot(T0, [hourly(40), yearEnd(20), undated(5)]));
  store.append(snapshot(T0 + 5 * MIN, [hourly(41), yearEnd(21), undated(5)]));
  store.append(snapshot(T0 + 30 * MIN, [yearEnd(22), undated(5)]));
  const idsAt = (s: SnapshotStore) => s.getHistory().map((h) => Object.keys(h.ladders).sort().join(","));
  const all = "btc-hourly:KXBTCD-26NOV1012,btc-yearend-2026-range,poly:no-date";
  const kept = "btc-yearend-2026-range,poly:no-date";
  assert.deepEqual(idsAt(store), [all, all, kept], "20 minutes after the close the hourly rows are still there");

  store.append(snapshot(hourlySettles + SETTLED_GRACE_MS, [yearEnd(23), undated(5)]));
  assert.deepEqual(idsAt(store), [all, all, kept, kept], "exactly an hour after: still there");
  store.append(snapshot(hourlySettles + SETTLED_GRACE_MS + MIN, [yearEnd(24), undated(5)]));
  assert.deepEqual(idsAt(store), [kept, kept, kept, kept, kept], "past the hour: gone from every point, the unsettled and the undated ones kept");

  const h = store.getHistory();
  assert.ok(h.every((p) => p.ladders["btc-yearend-2026-range"].keys === h[0].ladders["btc-yearend-2026-range"].keys), "one list of keys, shared by every point");
  assert.deepEqual([...h[4].ladders["btc-yearend-2026-range"].v], [24, 25, 24, 25, 50, 24, 25, 24, 25, 50]);
  assert.deepEqual(
    gapSeries(h, "btc-yearend-2026-range").map((g) => g.kalshiModel.map(([, x]) => x)),
    [
      [-29.5, -28.5, -27.5, -26.5, -25.5],
      [-29.5, -28.5, -27.5, -26.5, -25.5],
    ],
  );

  // the file is the record: both hourly snapshots are still on disk, whole
  const lines = readFileSync(join(dir, "snapshots-2026-11-10.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 5);
  assert.equal(lines.filter((l) => l.includes("btc-hourly:KXBTCD-26NOV1012")).length, 2);

  // a reload at the same moment holds what the running service holds
  const now = hourlySettles + SETTLED_GRACE_MS + MIN;
  const again = new SnapshotStore(dir, { keepHours: 72 });
  assert.equal(await again.load(now), 5);
  assert.deepEqual(again.getHistory(), store.getHistory());
  // and a reload inside the hour holds the hourly rows, then lets them go with the next snapshot past it
  const earlyDir = tmp("early");
  writeFileSync(join(earlyDir, "snapshots-2026-11-10.jsonl"), `${lines.slice(0, 3).join("\n")}\n`);
  const early = new SnapshotStore(earlyDir, { keepHours: 72 });
  assert.equal(await early.load(T0 + 40 * MIN), 3);
  assert.deepEqual(idsAt(early), [all, all, kept]);
  early.append(snapshot(now + MIN, [yearEnd(25), undated(5)]));
  assert.deepEqual(idsAt(early), [kept, kept, kept, kept]);
});

test("a snapshot taken while the files are being read is kept once and in order; a day that breaks half way through adds nothing and is named on /healthz", async () => {
  const dir = tmp("meanwhile");
  const now = Date.parse("2026-11-11T02:00:00Z");
  const empty = (at: string): Snapshot => ({ at, spotUsd: 74000, spotSource: "brti", ladders: [], options: [], health: {} });
  const writer = new SnapshotStore(dir, { keepHours: 96 });
  for (const at of ["2026-11-10T10:00:00.000Z", "2026-11-10T10:01:00.000Z", "2026-11-11T01:00:00.000Z"]) writer.append(empty(at));

  // 400 good lines then a cut: the stream gives lines before it fails, and none of them may count
  const day = Array.from({ length: 400 }, (_, i) => JSON.stringify(empty(iso(Date.parse("2026-11-09T00:00:00Z") + i * MIN)))).join("\n") + "\n";
  const gz = gzipSync(Buffer.from(day));
  writeFileSync(join(dir, "snapshots-2026-11-09.jsonl.gz"), gz.subarray(0, Math.floor(gz.length / 2)));

  const store = new SnapshotStore(dir, { keepHours: 96 });
  const loading = store.load(now);
  // these two land while the reload is still reading: one is also on disk by then, one is in memory only
  store.append(empty("2026-11-11T01:59:00.000Z"));
  const memoryOnly = new SnapshotStore(tmp("elsewhere"), { keepHours: 96 });
  memoryOnly.append(empty("2026-11-11T01:30:00.000Z"));
  (store as unknown as { history: unknown[] }).history.push(...memoryOnly.getHistory());
  const fromDisk = await loading;

  const ats = store.getHistory().map((h) => h.at);
  assert.deepEqual(ats, ["2026-11-10T10:00:00.000Z", "2026-11-10T10:01:00.000Z", "2026-11-11T01:00:00.000Z", "2026-11-11T01:30:00.000Z", "2026-11-11T01:59:00.000Z"]);
  assert.ok(fromDisk === 3 || fromDisk === 4, `the count is what the files gave (${fromDisk})`);
  assert.equal(store.getLatest()?.at, "2026-11-11T01:59:00.000Z", "the newest snapshot stays the latest");
  assert.match((store.dataHealth(now).notes ?? []).join(" "), /snapshots-2026-11-09\.jsonl\.gz could not be read on start-up.*it is left on disk and is not in the window/);
  assert.ok(readdirSync(dir).includes("snapshots-2026-11-09.jsonl.gz"));
});

test("nothing can read a day into memory whole any more: the only reader is the stream", () => {
  assert.equal("forEachLineSync" in dayFiles, false);
  for (const file of ["src/btcCurve/store.ts", "src/sportsVenues/store.ts", "src/btcCurve/pairsCollector.ts"]) {
    const src = readFileSync(join(API_DIR, file), "utf8");
    assert.doesNotMatch(src, /readFileSync|gunzipSync/, `${file} reads no file whole`);
    assert.match(src, /readLines\(/, `${file} reads through the stream`);
  }
});

test("the pairs collector reloads before its first cycle, and a stop during the reload starts no cycle", async () => {
  const dir = tmp("pairs");
  const now = Date.parse("2026-11-11T00:15:00Z");
  writeFileSync(join(dir, "gaps-2026-11-11.jsonl"), `${JSON.stringify({ at: now - MIN, rows: [["2026-11-11T01:00:00Z", "above:73700", 4]] })}\n`);
  const calls: string[] = [];
  const log: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url));
    // both venues answer at once with nothing listed, so a cycle ends without a retry
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const settle = () => new Promise((r) => setTimeout(r, 150));

  const stopped = new PairsCollector({ dataDir: dir, clock: () => now, log: (l) => log.push(l), fetchImpl });
  stopped.start();
  stopped.stop();
  await settle();
  assert.equal(calls.length, 0, "stopped while reloading: no cycle, no request");

  const running = new PairsCollector({ dataDir: dir, clock: () => now, log: (l) => log.push(l), fetchImpl });
  running.start();
  assert.equal(calls.length, 0, "nothing is asked of a venue before the reload is done");
  await settle();
  running.stop();
  assert.ok(calls.length > 0, "the first cycle ran after the reload");
  const reloadLine = log.findIndex((l) => /1 cycles of gap history reloaded/.test(l));
  assert.ok(reloadLine >= 0, log.join("\n"));
});

const CHILD = `
import { readFileSync } from "node:fs";
const hwmKb = () => Number(/VmHWM:\\s+(\\d+)/.exec(readFileSync("/proc/self/status", "utf8"))?.[1]);
const { SnapshotStore } = await import(process.argv[2]);
const store = new SnapshotStore(process.argv[3], { keepHours: 72 });
const before = hwmKb();
let ticks = 0;
const timer = setInterval(() => { ticks += 1; }, 5);
const points = await store.load(Number(process.argv[4]));
clearInterval(timer);
console.log(JSON.stringify({ points, ticks, grewKb: hwmKb() - before }));
`;

test("a gzipped day of 192 MB reloads in a fraction of its size and the process keeps answering meanwhile", { skip: process.platform !== "linux" ? "reads /proc for the peak" : false }, async () => {
  const dir = tmp("big");
  const now = Date.parse("2026-11-11T02:00:00Z");
  // a snapshot as wide as the live service writes. Its ladder settled a day ago, so the points
  // hold no rows and what the process grows by is the cost of reading, not of keeping.
  const keys = Array.from({ length: 700 }, (_, i) => `above:${60000 + i * 100}`);
  const wide = (atMs: number) => snapshot(atMs, [ladder("btc-daily:KXBTCD-26NOV0917", "2026-11-09T22:00:00Z", keys, (key, venue) => [Number(key.slice(6)) % 97, (Number(key.slice(6)) % 97) + (venue === "kalshi" ? 1 : 2)])]);
  const lineBytes = toDisk(wide(0)).length;
  const lines = Math.ceil((192 * 1_048_576) / lineBytes);
  const gz = createGzip({ level: 1 });
  const file = createWriteStream(join(dir, "snapshots-2026-11-10.jsonl.gz"));
  gz.pipe(file);
  const day0 = Date.parse("2026-11-10T00:00:00Z");
  for (let i = 0; i < lines; i += 1) if (!gz.write(`${toDisk(wide(day0 + i * 10))}\n`)) await once(gz, "drain");
  gz.end();
  await once(file, "finish");
  const rawBytes = lines * (lineBytes + 1);
  assert.ok(rawBytes >= 192 * 1_048_576);

  const script = join(dir, "reload.mts");
  writeFileSync(script, CHILD);
  const run = spawnSync(process.execPath, ["--import", "tsx", script, join(API_DIR, "src/btcCurve/store.ts"), dir, String(now)], { encoding: "utf8", cwd: API_DIR });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout.trim().split("\n").pop() as string) as { points: number; ticks: number; grewKb: number };
  assert.equal(out.points, lines, "every line came back");
  // read whole, the day alone is 192 MB before a single line is parsed; the stream stays far under that
  assert.ok(out.grewKb * 1024 < rawBytes / 2, `the peak grew ${Math.round(out.grewKb / 1024)} MB reloading a ${Math.round(rawBytes / 1_048_576)} MB day`);
  assert.ok(out.ticks >= 20, `a 5 ms timer fired ${out.ticks} times during the reload`);
  // the gzip is intact
  assert.equal(gunzipSync(readFileSync(join(dir, "snapshots-2026-11-10.jsonl.gz"))).length, rawBytes);
});
