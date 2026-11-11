/**
 * The pairs replay over day files on disk: the loader (plain and gzip), the request reader and
 * its caps, the text table, the command line, and the /api/replay route of the collector.
 * The cycles are the hand-made ones of btcPairsReplay.test.ts, where the figures are worked:
 * a lock of 59 cents for ten at t = 10, 18 cents at t = 20, -12 at t = 30, -32 at t = 40.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { compressDayFile } from "../src/btcCurve/dayFiles";
import { PairsCollector, REPLAY_CAPS } from "../src/btcCurve/pairsCollector";
import type { StoredCycle, StoredLeg, StoredPair } from "../src/btcCurve/pairsCycles";
import { DEFAULT_RULE, type ReplayResult, type ReplayRule } from "../src/btcCurve/pairsReplay";
import { ReplayRefused, centsText, dollarsText, firstDayOf, replayDays, replayRequestFrom, replayText, type ReplayRun } from "../src/btcCurve/pairsReplayLoader";

const DAY1 = Date.parse("2026-11-10T12:00:00Z");
const DAY2 = Date.parse("2026-11-11T12:00:00Z");

const leg = (id: string, feeTheta: number, bid: number, ask: number): StoredLeg => ({ id, bidCents: bid, askCents: ask, bidQty: 100, askQty: 100, feeTheta, ageSec: 2, fetchAgeSec: 1, cacheAgeSec: 1, venueAgeSec: null });
const book = (kAsk: number): StoredPair => ({ horizon: "hourly", place: "atm", strike: 74000, key: "above:74000", settlesAt: "2026-11-12T13:00:00.000Z", staleAfterSec: 30, kalshi: leg("K74000", 0.07, kAsk - 2, kAsk), poly: leg("P74000", 0.095, 50, 52) });
const cycleAt = (t0: number, sec: number, kAsk: number): StoredCycle => ({ at: t0 + sec * 1000, rows: [], v: 2, pricedAt: t0 + sec * 1000, intervalSec: 10, spotUsd: 73_700, pairs: [book(kAsk)] });
const fading = (t0: number): string => [cycleAt(t0, 0, 52), cycleAt(t0, 10, 40), cycleAt(t0, 20, 44), cycleAt(t0, 30, 47), cycleAt(t0, 40, 49)].map((c) => JSON.stringify(c)).join("\n") + "\n";
const rules = (...lags: number[]): ReplayRule[] => lags.map((lagSec) => ({ ...DEFAULT_RULE, lagSec }));
const tmp = () => mkdtempSync(join(tmpdir(), "btc-pairs-replay-"));
/** What the replay found, without how long the read took or which form the files were in. */
const found = (run: ReplayRun) => ({ results: run.results, linesRead: run.linesRead, days: run.files.map((f) => [f.day, f.lines]), notes: run.notes });

test("the loader reads plain and gzipped days and gives the same replay; when both forms exist the plain file is the one read", async () => {
  const plainDir = tmp();
  writeFileSync(join(plainDir, "gaps-2026-11-10.jsonl"), fading(DAY1));
  writeFileSync(join(plainDir, "gaps-2026-11-11.jsonl"), fading(DAY2));
  // files of other families and other names are not cycle files
  writeFileSync(join(plainDir, "episodes-2026-11-10.jsonl"), '{"endedAt":"2026-11-10T12:00:00Z"}\n');
  writeFileSync(join(plainDir, "notes.txt"), "x\n");
  const plain = await replayDays({ dir: plainDir, rules: rules(0, 10, 20) });

  const gzDir = tmp();
  writeFileSync(join(gzDir, "gaps-2026-11-10.jsonl"), fading(DAY1));
  writeFileSync(join(gzDir, "gaps-2026-11-11.jsonl"), fading(DAY2));
  for (const name of ["gaps-2026-11-10.jsonl", "gaps-2026-11-11.jsonl"]) assert.equal((await compressDayFile(join(gzDir, name))).ok, true);
  assert.deepEqual(readdirSync(gzDir).sort(), ["gaps-2026-11-10.jsonl.gz", "gaps-2026-11-11.jsonl.gz"]);
  const gz = await replayDays({ dir: gzDir, rules: rules(0, 10, 20) });

  assert.deepEqual(found(gz), found(plain));
  assert.deepEqual(plain.files.map((f) => f.file), ["gaps-2026-11-10.jsonl", "gaps-2026-11-11.jsonl"]);
  assert.deepEqual(gz.files.map((f) => f.file), ["gaps-2026-11-10.jsonl.gz", "gaps-2026-11-11.jsonl.gz"]);
  // two days of the same five cycles: lag 0 captures 59 on each, lag 10 captures 18 on each, lag 20 is gone at -12 on each
  assert.deepEqual(plain.results.map((r) => [r.rule.lagSec, r.total.signals, r.total.captured, r.total.capturedMc, r.total.sentAnywayMc]), [
    [0, 2, 2, 118_000, 118_000],
    [10, 2, 2, 36_000, 36_000],
    [20, 2, 0, 0, -24_000],
  ]);
  assert.equal(plain.linesRead, 10);
  assert.equal(plain.results[0].daysCovered, 2);
  assert.deepEqual([plain.fromDay, plain.toDay], ["2026-11-10", "2026-11-11"]);

  // one day in one form each, and a day in both forms whose gzip says something else: the plain file wins
  const mixed = tmp();
  writeFileSync(join(mixed, "gaps-2026-11-10.jsonl.gz"), gzipSync(fading(DAY1)));
  writeFileSync(join(mixed, "gaps-2026-11-11.jsonl"), fading(DAY2));
  writeFileSync(join(mixed, "gaps-2026-11-11.jsonl.gz"), gzipSync(JSON.stringify(cycleAt(DAY2, 0, 30)) + "\n"));
  const both = await replayDays({ dir: mixed, rules: rules(0, 10, 20) });
  assert.deepEqual(both.files.map((f) => f.file), ["gaps-2026-11-10.jsonl.gz", "gaps-2026-11-11.jsonl"]);
  assert.deepEqual(found(both), found(plain));
});

test("the loader reads the days asked for and says what a file could not give", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "gaps-2026-11-09.jsonl"), [0, 10, 20].map((s) => JSON.stringify({ at: DAY1 - 86_400_000 + s * 1000, rows: [["2026-11-09T13:00:00.000Z", "above:74000", 9]] })).join("\n") + "\n");
  writeFileSync(join(dir, "gaps-2026-11-10.jsonl"), fading(DAY1) + '{"at":17,"rows":[],"v":2,"pricedAt"');
  writeFileSync(join(dir, "gaps-2026-11-11.jsonl"), fading(DAY2));

  const one = await replayDays({ dir, fromDay: "2026-11-10", toDay: "2026-11-10", rules: rules(10) });
  assert.deepEqual(one.files.map((f) => [f.file, f.lines]), [["gaps-2026-11-10.jsonl", 6]]);
  assert.equal(one.results[0].total.capturedMc, 18_000);
  // the torn last line is skipped and counted on its file's day
  assert.equal(one.results[0].linesSkipped, 1);
  assert.equal(one.results[0].days[0].linesSkipped, 1);

  // the old day is read, counted and reported; nothing is replayed on it
  const all = await replayDays({ dir, rules: rules(10) });
  assert.deepEqual(all.results[0].days.map((d) => [d.day, d.cyclesRead, d.cyclesOldFormat, d.signals, d.capturedMc]), [
    ["2026-11-09", 0, 3, 0, 0],
    ["2026-11-10", 5, 0, 1, 18_000],
    ["2026-11-11", 5, 0, 1, 18_000],
  ]);
  assert.match(all.results[0].days[0].note ?? "", /Old form only \(3 cycles of gaps, no books\)/);
  assert.equal(all.results[0].daysCovered, 2);
  assert.deepEqual((await replayDays({ dir, fromDay: "2026-11-11", rules: rules(10) })).files.map((f) => f.day), ["2026-11-11"]);
  assert.deepEqual((await replayDays({ dir, toDay: "2026-11-09", rules: rules(10) })).files.map((f) => f.day), ["2026-11-09"]);

  // no files in the range: a result with nothing in it and a sentence, not an error
  const none = await replayDays({ dir, fromDay: "2026-12-01", toDay: "2026-12-02", rules: rules(10) });
  assert.equal(none.results[0].total.signals, 0);
  assert.match(none.notes.join(" "), /No cycle files \(gaps-YYYY-MM-DD\.jsonl or \.jsonl\.gz\) for 2026-12-01 to 2026-12-02/);
  assert.match(none.results[0].notes.join(" "), /No cycle in the range could be replayed\./);

  // a gzip cut short: what was read before the break is kept, the break is said, and the day after is still read
  const torn = tmp();
  const whole = gzipSync(Buffer.from(Array.from({ length: 400 }, (_, i) => JSON.stringify(cycleAt(DAY1, i * 10, i === 1 ? 40 : 52))).join("\n") + "\n"));
  writeFileSync(join(torn, "gaps-2026-11-10.jsonl.gz"), whole.subarray(0, Math.floor(whole.length / 2)));
  writeFileSync(join(torn, "gaps-2026-11-11.jsonl"), fading(DAY2));
  const cut = await replayDays({ dir: torn, rules: rules(0) });
  assert.ok(cut.files[0].error, "the file's error is kept");
  assert.match(cut.notes.join(" "), /gaps-2026-11-10\.jsonl\.gz could not be read to its end \(.*\)\. \d+ lines were read before the break; the rest of that day is missing, and a trade waiting on it is unknown\./);
  assert.equal(cut.files[1].lines, 5);
  assert.equal(cut.results[0].total.signals, cut.files[0].lines >= 2 ? 2 : 1);
});

test("the loader refuses in words: a day that is not a day, a range backwards, more lines than the cap, a read that takes too long", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "gaps-2026-11-10.jsonl"), fading(DAY1));
  await assert.rejects(replayDays({ dir, fromDay: "10 Nov", rules: rules(0) }), (e: Error) => e instanceof ReplayRefused && /"10 Nov" is not a day\. Write it as YYYY-MM-DD\./.test(e.message));
  await assert.rejects(replayDays({ dir, fromDay: "2026-02-30", rules: rules(0) }), /is not a day/);
  await assert.rejects(replayDays({ dir, fromDay: "2026-11-11", toDay: "2026-11-10", rules: rules(0) }), /The first day \(2026-11-11\) is after the last day \(2026-11-10\)\./);
  await assert.rejects(replayDays({ dir, rules: [] }), /No rule was given\./);
  await assert.rejects(replayDays({ dir, rules: [{ ...DEFAULT_RULE, lagSec: -1 }] }), (e: Error) => e instanceof ReplayRefused && /lag must be zero or more/.test(e.message));
  // five lines against a cap of four: refused, not trimmed to the first four
  await assert.rejects(replayDays({ dir, rules: rules(0), maxLines: 4 }), (e: Error) => e instanceof ReplayRefused && /This range holds more than 4 stored cycles, which is more than one request reads\. Ask for fewer days, or run the command-line replay/.test(e.message));
  assert.equal((await replayDays({ dir, rules: rules(0), maxLines: 5 })).linesRead, 5);
  // a clock that jumps a minute between lines: stopped at the first hand-back
  let now = 0;
  await assert.rejects(replayDays({ dir, rules: rules(0), yieldEveryLines: 2, maxMs: 30_000, clock: () => (now += 60_000) }), (e: Error) => e instanceof ReplayRefused && /took longer than 30 seconds to read and was stopped/.test(e.message));
});

test("the read hands the event loop back while it runs", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "gaps-2026-11-10.jsonl"), Array.from({ length: 2000 }, (_, i) => JSON.stringify(cycleAt(DAY1, i * 10, 52))).join("\n") + "\n");
  let ticks = 0;
  let done = false;
  const tick = () => {
    ticks += 1;
    if (!done) setImmediate(tick);
  };
  setImmediate(tick);
  const run = await replayDays({ dir, rules: rules(0, 10), yieldEveryLines: 100 });
  done = true;
  assert.equal(run.results[0].cyclesRead, 2000);
  // 2000 lines, a hand-back every 100: the loop turned at least 20 times while the replay ran
  assert.ok(ticks >= 20, `the loop turned ${ticks} times`);
});

test("a request is read into one rule per lag; a value that cannot be read or is over a cap is refused, not replaced", () => {
  const caps = { maxLags: 4, maxLagSec: 3600, maxDays: 7 };
  const from = (q: string) => replayRequestFrom((name) => new URLSearchParams(q).get(name), caps);
  const refused = (q: string, words: RegExp) => assert.throws(() => from(q), (e: Error) => e instanceof ReplayRefused && words.test(e.message), q);

  // nothing given: the defaults, and no days so the caller picks
  assert.deepEqual(from(""), { rules: [DEFAULT_RULE], days: null });
  assert.deepEqual(DEFAULT_RULE, { minEdgeCents: 1, minSizeContracts: 10, sizeContracts: 10, lagSec: 10, maxReadAgeSec: 30, horizons: ["fifteen", "hourly", "daily"], gapToleranceSec: 5 });
  const full = from("edge=1.5&size=25&trade=20&lag=0,10,30&age=20&horizons=15m,1h&tolerance=3&days=7");
  assert.equal(full.days, 7);
  assert.deepEqual(full.rules.map((r) => r.lagSec), [0, 10, 30]);
  assert.deepEqual(full.rules[0], { minEdgeCents: 1.5, minSizeContracts: 25, sizeContracts: 20, lagSec: 0, maxReadAgeSec: 20, horizons: ["fifteen", "hourly"], gapToleranceSec: 3 });
  // the size traded follows the size when it is not given
  assert.equal(from("size=40").rules[0].sizeContracts, 40);
  assert.deepEqual(from("horizons=daily,1H").rules[0].horizons, ["daily", "hourly"]);

  refused("edge=abc", /The minimum edge in cents \(edge\) is "abc", which is not a number\./);
  refused("edge=-1", /is "-1", which is not a number/);
  refused("edge=1e3", /not a number/);
  refused("edge=1.0005", /at most three decimals/);
  refused("size=2.5", /The size in contracts \(size\) is "2\.5", which is not a whole number\./);
  refused("size=0", /minimum size must be a whole number of contracts, 1 or more/);
  refused("trade=ten", /The size traded in contracts \(trade\) is "ten"/);
  refused("lag=10,,30", /A lag \(lag\) is "", which is not a number of seconds/);
  refused("lag=fast", /A lag \(lag\) is "fast"/);
  refused("lag=10,10", /A lag is given twice\./);
  refused("lag=0,10,20,30,40", /5 lags were asked for; one request takes at most 4\./);
  refused("lag=3601", /A lag of 3601 seconds is over the limit of 3600\./);
  refused("age=0", /maximum read age must be more than zero/);
  refused("age=old", /The maximum read age in seconds \(age\) is "old"/);
  refused("horizons=1w", /"1w" is not a tenor\. Use 15m, 1h or 1d\./);
  refused("horizons=1h,1h", /named twice/);
  refused("tolerance=-1", /not a number/);
  refused("days=0", /The number of days \(days\) must be 1 or more\./);
  refused("days=8", /8 days were asked for; one request reads at most 7\. Run the command-line replay/);
  refused("days=1.5", /is "1\.5", which is not a whole number/);
  assert.equal(from("lag=3600&days=7").rules.length, 1);

  assert.equal(firstDayOf(1, Date.parse("2026-11-11T00:00:01Z")), "2026-11-11");
  assert.equal(firstDayOf(7, Date.parse("2026-11-11T23:59:59Z")), "2026-11-05");
});

test("the table: exact cents, every lag on one line, lag 0 marked as the upper bound, the days, the assumptions, plain words", async () => {
  assert.equal(centsText(59_000), "59.000");
  assert.equal(centsText(-12_000), "-12.000");
  assert.equal(centsText(5), "0.005");
  assert.equal(centsText(-1_234_567), "-1234.567");
  assert.equal(centsText(0), "0.000");
  assert.equal(dollarsText(59_000), "$0.59000");
  assert.equal(dollarsText(-1_234_567), "-$12.34567");

  const dir = tmp();
  writeFileSync(join(dir, "gaps-2026-11-09.jsonl"), JSON.stringify({ at: DAY1 - 86_400_000, rows: [] }) + "\n");
  writeFileSync(join(dir, "gaps-2026-11-10.jsonl"), fading(DAY1));
  const run = await replayDays({ dir, rules: rules(0, 10, 20, 40), keepTrades: 5 });
  const text = replayText(run, { dir, trades: true });
  const line = (start: string) => text.split("\n").find((l) => l.startsWith(start)) ?? "";
  const cells = (start: string) => line(start).split(/\s{2,}/);
  assert.match(text, /^BTC pairs replay\. Paper only: no order was sent\.\n/);
  assert.match(text, /Rule: a lock of at least 1 c per \$1 pair after both venues' fees, at 10 contracts traded; at least 10 contracts at the top of both books; both reads fresh and no older than 30 s; tenors 15m, 1h, 1d; fill cycle at most one interval plus 5 s late\./);
  assert.match(text, /Cycles replayed: 5\. Old form cycles \(not replayed\): 1\. Lines skipped: 0\. Days covered: 1\. From 2026-11-10T12:00:00\.000Z to 2026-11-10T12:00:40\.000Z\./);
  assert.match(text, /Note: 1 stored cycle is in the old form \(the gap between the mids only\)\. They hold no prices, sizes, fees or read ages/);
  // lag, signals, captured, gone, (edge/size), unknown, captured, median, worst, sent anyway, survived
  assert.deepEqual(cells("0 s *"), ["0 s *", "1", "1", "0", "(0/0)", "0", "59.000", "5.900", "5.900", "59.000", "100.0%"]);
  assert.deepEqual(cells("10 s"), ["10 s", "1", "1", "0", "(0/0)", "0", "18.000", "1.800", "1.800", "18.000", "100.0%"]);
  assert.deepEqual(cells("20 s"), ["20 s", "1", "0", "1", "(1/0)", "0", "0.000", "none", "none", "-12.000", "0.0%"]);
  // lag 40: the data ends at t = 40 and the fill is due at t = 50: unknown, and no share is printed for it
  assert.deepEqual(cells("40 s"), ["40 s", "1", "0", "0", "(0/0)", "1", "0.000", "none", "none", "0.000", "no known outcome"]);
  assert.match(text, /\* lag 0 fills at the signal cycle itself: an upper bound nobody achieves\./);
  assert.match(text, /Unknown 1: no stored cycle in time 1 \(1 of them because the data ends first\), fill read stale 0, fill read too old 0, fill read missing 0\./);
  assert.match(text, /2026-11-09: Old form only \(1 cycles of gaps, no books\): nothing can be replayed on this day\./);
  assert.match(text, /2026-11-10T12:00:10\.000Z\s+1h\s+74000\s+Kalshi\s+5\.900\s+captured\s+2026-11-10T12:00:20\.000Z\s+1\.800\s+18\.000/);
  assert.match(text, /What this does not model:\n- Paper only\./);
  assert.match(text, /- Both legs are assumed to fill together/);
  assert.doesNotMatch(text, /[\u2013\u2014]|guaranteed/i);
  // without the trades flag no trade is listed
  assert.doesNotMatch(replayText(run), /signal at/);
});

const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(API_DIR, "scripts/btcPairsReplay.ts");
const cli = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], { encoding: "utf8", cwd: API_DIR, env: { ...process.env, BTC_PAIRS_DATA_DIR: "", BTC_CURVE_DATA_DIR: "" } });

test("the command line: the table, the JSON, the curve data dir with pairs/ inside it, and a refusal with exit code 2", () => {
  const curveDir = tmp();
  const dir = join(curveDir, "pairs");
  mkdirSync(dir);
  writeFileSync(join(dir, "gaps-2026-11-10.jsonl"), fading(DAY1));

  const table = cli(["--dir", dir, "--lag", "0,10,20", "--edge", "1", "--size", "10"]);
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /^BTC pairs replay\. Paper only: no order was sent\./);
  assert.match(table.stdout, /\n10 s\s+1\s+1\s+0\s+\(0\/0\)\s+0\s+18\.000\s+1\.800\s+1\.800\s+18\.000\s+100\.0%\n/);

  // the curve data dir is accepted: its pairs/ holds the cycle files
  const json = cli([`--dir=${curveDir}`, "--lag=10", "--from=2026-11-10", "--to=2026-11-10", "--trades=3", "--json"]);
  assert.equal(json.status, 0, json.stderr);
  const out = JSON.parse(json.stdout) as { ok: boolean; dir: string; results: ReplayResult[]; linesRead: number };
  assert.equal(out.ok, true);
  assert.equal(out.dir, dir);
  assert.equal(out.linesRead, 5);
  assert.equal(out.results[0].total.capturedMc, 18_000);
  assert.equal(out.results[0].trades.length, 1);
  assert.ok(out.results[0].assumptions.length >= 6);

  for (const [args, words] of [
    [["--dir", dir, "--lag", "soon"], /^Refused: A lag \(lag\) is "soon", which is not a number of seconds/],
    [["--dir", dir, "--lags", "10"], /^Refused: "--lags" is not a flag this replay knows/],
    [["--dir", dir, "--from", "yesterday"], /^Refused: "yesterday" is not a day/],
    [["--dir", dir, "--days", "2", "--from", "2026-11-10"], /^Refused: Give --days or --from, not both\./],
    [["--dir", join(curveDir, "nowhere")], /^Refused: .*nowhere does not exist\./],
    [["--dir", dir, "--edge"], /^Refused: --edge needs a value\./],
  ] as Array<[string[], RegExp]>) {
    const r = cli(args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, words);
    assert.equal(r.stdout, "");
  }
});

/* ---- the route on the collector ---- */

const NOW = Date.parse("2026-11-11T12:10:00Z");

function collectorOver(dir: string): PairsCollector {
  return new PairsCollector({ dataDir: dir, clock: () => NOW, log: () => undefined, fetchImpl: (async () => new Response("{}", { status: 500 })) as typeof fetch });
}

type RouteBody = { ok: boolean; refused?: boolean; error?: string; label?: string; days?: number; caps?: typeof REPLAY_CAPS; results?: ReplayResult[]; files?: Array<{ file: string; lines: number }>; fromDay?: string; toDay?: string; linesRead?: number };
const ask = async (c: PairsCollector, query: string) => (await c.replay(new URLSearchParams(query))) as { status: number; body: RouteBody };

test("GET /api/replay: a small request is answered from the day files without touching the collector's state", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "gaps-2026-11-10.jsonl.gz"), gzipSync(fading(DAY1)));
  writeFileSync(join(dir, "gaps-2026-11-11.jsonl"), fading(DAY2));
  const c = collectorOver(dir);
  const before = readdirSync(dir).sort();

  // today only by default
  const today = await ask(c, "edge=1&size=10&lag=0,10,20");
  assert.equal(today.status, 200);
  assert.equal(today.body.ok, true);
  assert.equal(today.body.days, 1);
  assert.deepEqual([today.body.fromDay, today.body.toDay], ["2026-11-11", "2026-11-11"]);
  assert.deepEqual(today.body.files?.map((f) => f.file), ["gaps-2026-11-11.jsonl"]);
  assert.deepEqual(today.body.results?.map((r) => [r.rule.lagSec, r.total.signals, r.total.capturedMc, r.total.sentAnywayMc]), [[0, 1, 59_000, 59_000], [10, 1, 18_000, 18_000], [20, 1, 0, -12_000]]);
  assert.match(today.body.label ?? "", /^paper only/);
  assert.deepEqual(today.body.caps, REPLAY_CAPS);
  assert.ok((today.body.results?.[0].assumptions.length ?? 0) >= 6);

  // two days: the gzipped day and today
  const two = await ask(c, "lag=10&days=2&k=sometoken");
  assert.equal(two.status, 200);
  assert.deepEqual(two.body.files?.map((f) => f.file), ["gaps-2026-11-10.jsonl.gz", "gaps-2026-11-11.jsonl"]);
  assert.equal(two.body.results?.[0].total.capturedMc, 36_000);
  assert.equal(two.body.results?.[0].daysCovered, 2);
  assert.deepEqual(readdirSync(dir).sort(), before, "nothing was written or removed");
  assert.equal(c.cycles, 0);

  // through handle(): served as JSON once the read is done
  let status = 0;
  let body = "";
  const finished = new Promise<void>((done) => {
    const res = { writeHead: (s: number) => ((status = s), res), end: (s?: string) => ((body += s ?? ""), done()), write: () => true };
    assert.equal(c.handle({} as never, res as never, "/api/replay", new URL("http://x/pairs/api/replay?lag=10"), { base: "/pairs" }), true);
  });
  await finished;
  assert.equal(status, 200);
  assert.equal((JSON.parse(body) as RouteBody).results?.[0].total.capturedMc, 18_000);
});

test("GET /api/replay refuses in plain words: over a cap, a value it cannot read, a parameter it does not know, a second request while one runs, too many stored cycles", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "gaps-2026-11-11.jsonl"), fading(DAY2));
  const c = collectorOver(dir);
  for (const [query, words] of [
    ["days=8", /^8 days were asked for; one request reads at most 7\. Run the command-line replay \(scripts\/btcPairsReplay\.ts\) for a longer range\.$/],
    ["lag=0,10,20,30,60", /^5 lags were asked for; one request takes at most 4\.$/],
    ["lag=7200", /^A lag of 7200 seconds is over the limit of 3600\.$/],
    ["edge=lots", /^The minimum edge in cents \(edge\) is "lots", which is not a number\.$/],
    ["size=0", /^The minimum size must be a whole number of contracts, 1 or more\.$/],
    ["lags=10,30", /^This replay does not know "lags"\. It takes edge, size, trade, lag, age, horizons, tolerance and days\.$/],
    ["horizons=weekly", /^"weekly" is not a tenor\. Use 15m, 1h or 1d\.$/],
  ] as Array<[string, RegExp]>) {
    const r = await ask(c, query);
    assert.equal(r.status, 400, query);
    assert.deepEqual([r.body.ok, r.body.refused], [false, true], query);
    assert.match(r.body.error ?? "", words, query);
    assert.deepEqual(r.body.caps, REPLAY_CAPS);
    assert.equal(r.body.results, undefined, "a refusal carries no result");
    assert.doesNotMatch(r.body.error ?? "", /[\u2013\u2014]/);
  }

  // one at a time: the second is told to wait, and the first still answers
  const first = ask(c, "lag=10");
  const second = await ask(c, "lag=10");
  assert.equal(second.status, 429);
  assert.match(second.body.error ?? "", /^A replay is already running on this service\. Ask again in a few seconds\.$/);
  assert.equal((await first).status, 200);
  assert.equal((await ask(c, "lag=10")).status, 200, "and the next one is served");

  // more stored cycles than one request reads: refused, not answered from the first part
  const big = tmp();
  const lines = Array.from({ length: REPLAY_CAPS.maxLines + 1 }, (_, i) => `{"at":${DAY2 + i},"rows":[]}`).join("\n") + "\n";
  writeFileSync(join(big, "gaps-2026-11-11.jsonl"), lines);
  const over = await ask(collectorOver(big), "lag=10");
  assert.equal(over.status, 400);
  assert.equal(over.body.refused, true);
  assert.match(over.body.error ?? "", new RegExp(`^This range holds more than ${REPLAY_CAPS.maxLines} stored cycles, which is more than one request reads\\. Ask for fewer days, or run the command-line replay`));
  assert.equal(over.body.results, undefined);

  // an empty data dir is not an error: nothing to replay, said
  const empty = tmp();
  const nothing = await ask(collectorOver(empty), "lag=10");
  assert.equal(nothing.status, 200);
  assert.equal(nothing.body.results?.[0].total.signals, 0);
  assert.equal(existsSync(join(empty, "gaps-2026-11-11.jsonl")), false);
});

test("the page names the replay route in its API line", () => {
  const html = readFileSync(join(API_DIR, "src/btcCurve/pairsHtml.ts"), "utf8");
  assert.match(html, /\/api\/replay\?edge=1&amp;size=10&amp;lag=0,10,30&amp;days=1<\/code> what a rule would have captured from the stored cycles if you were that many seconds slow \(paper only; at most 7 days and 4 lags a request\)/);
  assert.equal(REPLAY_CAPS.maxDays, 7);
  assert.equal(REPLAY_CAPS.maxLags, 4);
});
