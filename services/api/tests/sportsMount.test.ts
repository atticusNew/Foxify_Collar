/**
 * The sports venues page on the BTC curve service: the same collector the standalone script
 * runs, mounted at /sports behind the BTC service's key, and behind a boundary so a sports
 * fault never reaches the BTC routes. Real HTTP against the scripts' own handlers on a loopback
 * port; real files in a temp dir; no venue is called.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pageLinks, pageLinksHtml } from "../src/btcCurve/pageLinks";
import { GAP_SERIES_MAX_POINTS, gapSeries, readGame } from "../src/sportsVenues/analytics";
import { SportsCollector, mountSports, sportsCollectorFromEnv, type SportsMount } from "../src/sportsVenues/collector";
import { toHistoryPoint } from "../src/sportsVenues/store";
import type { Game, Snapshot, VenueListing } from "../src/sportsVenues/types";

const tmp = (tag: string) => mkdtempSync(join(tmpdir(), `sv-mount-${tag}-`));
const q = (bid: number, ask: number) => ({ bidCents: bid, askCents: ask, bidQty: 500, askQty: 500 });
const listing = (venue: VenueListing["venue"], awayAsk: number, feeTheta: number): VenueListing => ({ venue, id: `${venue}-1`, away: q(awayAsk - 1, awayAsk), home: q(99 - awayAsk, 100 - awayAsk), feeTheta, awayName: "Cleveland", homeName: "Charlotte" });
const game = (awayAsk = 40): Game => ({
  key: "nba:CLE:CHA:2026-11-09",
  league: "nba",
  awayCode: "CLE",
  homeCode: "CHA",
  awayName: "Cleveland Cavaliers",
  homeName: "Charlotte Hornets",
  startsAt: "2026-11-10T00:00:00.000Z",
  startSource: "venue",
  listings: [listing("kalshi", awayAsk, 0.07), listing("novig", awayAsk + 1, 0)],
});
const snapshot = (at: string, awayAsk = 40): Snapshot => ({ at, games: [game(awayAsk)], health: { kalshi: { ok: true, ms: 1 }, polymarket_us: { ok: false, ms: 9, detail: "no answer" }, novig: { ok: true, ms: 1 } } });

async function serve(handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>): Promise<{ server: Server; get: (path: string) => Promise<{ status: number; type: string; text: string }> }> {
  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end("the host handler threw");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    get: async (path) => {
      const r = await fetch(`http://127.0.0.1:${port}${path}`);
      return { status: r.status, type: r.headers.get("content-type") ?? "", text: await r.text() };
    },
  };
}

test("on the BTC service: /sports and its JSON answer with the BTC key and are refused without it, the Lock in pages open only under a reader's own key, /healthz says how sports is doing, and a sports fault stays out of the BTC routes", async () => {
  const dir = tmp("btc");
  mkdirSync(join(dir, "sports"));
  const now = Date.now();
  const at = [new Date(now - 120_000).toISOString(), new Date(now - 60_000).toISOString()];
  for (const [i, a] of at.entries()) writeFileSync(join(dir, "sports", `snapshots-${a.slice(0, 10)}.jsonl`), `${JSON.stringify(snapshot(a, 40 + i))}\n`, { flag: "a" });
  Object.assign(process.env, { NODE_ENV: "test", BTC_CURVE_DATA_DIR: dir, BTC_CURVE_TOKEN: "k 1", BTC_CURVE_COLLAR: "0", PROSPECT_PAGE_KEY: "reader-key-0123456789", LOCK_IN_INTERNAL_KEY: "internal-key-0123456789" });
  delete process.env.BTC_CURVE_SPORTS;
  const service = (await import("../scripts/btcCurveReportService")) as { handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>; sports: SportsMount | null };
  const sports = service.sports;
  assert.ok(sports?.collector, "on unless BTC_CURVE_SPORTS turns it off");
  assert.equal(sports.collector.dataDir, join(dir, "sports"), "its files sit under the BTC data dir");
  assert.equal(sports.collector.windowHours, 24, "24 hours in memory beside the BTC history, not the 72 it holds alone");
  const { server, get } = await serve(service.handle);
  try {
    // cold: the BTC health page answers and says sports is not warm yet
    const cold = JSON.parse((await get("/healthz")).text);
    assert.equal(cold.ok, true);
    assert.equal(cold.sports.warm, false);
    assert.equal((await get("/sports?k=k%201")).status, 503);

    assert.equal(await sports.collector.load(now), 2);
    // without the key, or with one that no longer matches: refused with the short "access link" page (its JSON twin on a JSON path) and nothing of the board
    const refused = async (path: string, why: string): Promise<void> => {
      const r = await get(path);
      assert.equal(r.status, 401, `${path} ${why}`);
      assert.match(r.text, /access link/i, `${path} ${why}`);
      assert.ok(r.text.includes("michael@atticustrade.com"));
      assert.ok(!/Sports on the event venues|historyPoints|Kalshi|Polymarket|Lock in|k%201|k 1/.test(r.text), `${path} ${why}: nothing of what is behind the key`);
      assert.match(r.type, path.includes("/api") ? /application\/json/ : /text\/html/);
    };
    for (const path of ["/sports", "/sports/", "/sports/api/report", "/sports/api/latest", "/sports?k=wrong", "/sports/api/report?k="]) await refused(path, "without the key");
    const page = await get("/sports?k=k%201");
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    assert.ok(page.text.includes("<h1>Sports on the event venues</h1>"));
    assert.ok(page.text.includes("the last 24 hours"));
    // the links to the other two pages carry the key
    assert.ok(page.text.includes('<a href="/?k=k%201">BTC curve</a> · <a href="/pairs?k=k%201">BTC pairs</a> · <b>Sports</b>'));
    assert.equal((await get("/sports/?k=k%201")).status, 200);
    const report = await get("/sports/api/report?k=k%201");
    assert.equal(report.status, 200);
    assert.equal(JSON.parse(report.text).historyPoints, 2);
    assert.equal(JSON.parse((await get("/sports/api/latest?k=k%201")).text).at, at[1]);
    assert.equal((await get("/sports/api/nothing?k=k%201")).status, 404);
    // the Lock in pages are not this key's: not served under it, not linked from the board
    for (const path of ["/sports/replay", "/sports/lock", "/sports/api/replay", "/sports/api/lock"]) {
      assert.equal((await get(`${path}?k=k%201`)).status, 404, `${path} under the BTC key`);
      await refused(path, "without a key");
    }
    assert.ok(!page.text.includes("/sports/replay") && !page.text.includes("/sports/lock") && !page.text.includes("Lock in"));
    assert.ok(!page.text.includes("/prospect") && !(await get("/?k=k%201")).text.includes("/prospect"));

    // a reader's page: one address, its own key, and that key opens nothing else: no tables behind it, no JSON, not the internal pages
    const READER = "reader-key-0123456789";
    const INTERNAL = "internal-key-0123456789";
    for (const path of ["/prospect", "/prospect?k=k%201", "/prospect?k=", "/prospect?k=reader-key-012345678", `/prospect?k=${INTERNAL}`, `/prospect/detail?k=${READER}`, `/prospect/api?k=${READER}`, `/prospect/lock?k=${READER}`]) {
      const r = await get(path);
      assert.equal(r.status, 404, path);
      assert.equal(r.text, "not found");
    }
    for (const path of ["/", "/sports", "/sports/api/report", "/pairs", "/api/latest", "/sports/replay"]) await refused(`${path}?k=${READER}`, "under the reader's key");
    for (const path of ["/lockin", "/lockin/lock", "/lockin/api"]) assert.equal((await get(`${path}?k=${READER}`)).status, 404, `${path} under the reader's key`);
    const reader = await get(`/prospect?k=${READER}`);
    assert.equal(reader.status, 200);
    assert.match(reader.type, /text\/html/);
    assert.ok(reader.text.includes("Prepared for Prospect Markets by Atticus"));
    // every link on it is to itself, and nothing of the board or of how the figures are made is said
    const hrefs = [...reader.text.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(hrefs.length >= 1 && hrefs.every((h) => h.startsWith(`/prospect?k=${READER}&amp;game=past%3A`)), hrefs.join(" "));
    assert.ok(!/Kalshi|Polymarket|Novig|ProphetX|BTC|k%201|k 1|lockin|internal/i.test(reader.text));
    assert.ok(!reader.text.includes("—"));

    // the internal pages: the full tables and the lock card, under their own key and no other
    for (const path of ["/lockin", "/lockin?k=k%201", "/lockin/lock?k=k%201", "/lockin/api", `/lockin/nothing?k=${INTERNAL}`]) assert.equal((await get(path)).status, 404, path);
    for (const path of ["/", "/sports", "/pairs"]) await refused(`${path}?k=${INTERNAL}`, "under the internal key");
    assert.equal((await get(`/prospect?k=${INTERNAL}`)).status, 404, "/prospect under the internal key");
    const full = await get(`/lockin?k=${INTERNAL}`);
    assert.equal(full.status, 200);
    assert.ok(full.text.includes("<h1>Lock in, replayed on real trades</h1>") && full.text.includes(`<a href="/lockin/lock?k=${INTERNAL}">Lock in now</a>`));
    assert.ok(!full.text.includes("/sports") && !full.text.includes("BTC curve") && !full.text.includes("k%201") && !full.text.includes(READER));
    const lockPage = await get(`/lockin/lock?k=${INTERNAL}`);
    assert.equal(lockPage.status, 200);
    assert.ok(lockPage.text.includes('action="/lockin/lock"') && lockPage.text.includes(`name="k" value="${INTERNAL}"`) && lockPage.text.includes(`<a href="/lockin?k=${INTERNAL}">Lock in, replayed on real trades</a>`));
    // the games shipped with the code were copied under the BTC data dir and replayed on the load above
    const shown = JSON.parse((await get(`/lockin/api?k=${INTERNAL}`)).text);
    assert.ok(shown.report.all.games >= 31);
    assert.ok(existsSync(join(dir, "sports", "tape", "replay.json")));
    assert.deepEqual(JSON.parse((await get("/healthz")).text).sports.audiencePages, ["on", "on"]);

    const warm = JSON.parse((await get("/healthz")).text);
    assert.equal(warm.sports.warm, true);
    assert.equal(warm.sports.games, 1);
    assert.equal(warm.sports.historyPoints, 2);
    assert.equal(warm.sports.cycles, 0);
    assert.equal(warm.sports.reload.points, 2);
    assert.deepEqual(warm.sports.venuesNotAnswering, ["polymarket_us: no answer"]);
    assert.equal(warm.sports.data.dir, join(dir, "sports"));
    assert.equal(warm.sports.data.dayFiles.plain >= 1, true);
    assert.equal(warm.sports.lastError, undefined);
    assert.equal(warm.sports.mountError, undefined);

    // the sports routes and the sports health both throw: the BTC routes answer as they did
    const btcBefore = await get("/api/latest?k=k%201");
    const collector = sports.collector as unknown as { handle: () => boolean; health: () => unknown };
    const real = { handle: collector.handle, health: collector.health };
    collector.handle = () => {
      throw new Error("sports page broke");
    };
    collector.health = () => {
      throw new Error("sports health broke");
    };
    const broken = await get("/sports?k=k%201");
    assert.equal(broken.status, 500);
    assert.match(JSON.parse(broken.text).error, /sports page failed on this request/);
    const health = await get("/healthz");
    assert.equal(health.status, 200);
    const h = JSON.parse(health.text);
    assert.equal(h.ok, true);
    assert.equal(h.service, "btc-curve-report");
    assert.equal(h.sports.warm, false);
    assert.match(h.sports.mountError, /the sports health could not be read: sports health broke/);
    assert.deepEqual(await get("/api/latest?k=k%201"), btcBefore);
    assert.equal((await get("/api/replays?k=k%201")).status, 200);
    assert.equal((await get("/api/replays")).status, 401, "still refused without the key");
    Object.assign(collector, real);
    assert.equal((await get("/sports?k=k%201")).status, 200, "and the sports page is back when the fault is gone");
    assert.match(JSON.parse((await get("/healthz")).text).sports.mountError, /sports health broke/, "the last fault stays on /healthz");
  } finally {
    server.close();
  }
});

test("a sports collector that cannot be built or started leaves a mount that says why and serves nothing; the host is not thrown into", async () => {
  const lines: string[] = [];
  const mount = mountSports(() => {
    throw new Error("EROFS: read-only file system, mkdir '/var/data/btc-curve/sports'");
  }, (line) => lines.push(line));
  assert.equal(mount.collector, null);
  mount.start();
  mount.stop();
  const h = mount.health();
  assert.equal(h.warm, false);
  assert.match(String(h.mountError), /the sports collector could not be set up: EROFS/);
  assert.equal(lines.length, 1);
  const { server, get } = await serve(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (!mount.handle(req, res, url.pathname, url)) res.writeHead(404).end("not found");
  });
  try {
    const r = await get("/");
    assert.equal(r.status, 503);
    assert.match(JSON.parse(r.text).error, /The sports page is not running\. the sports collector could not be set up/);
  } finally {
    server.close();
  }

  const dir = tmp("start");
  const started = mountSports(() => {
    const c = new SportsCollector({ dataDir: dir, log: () => undefined });
    c.start = () => {
      throw new Error("no timers");
    };
    return c;
  }, () => undefined);
  started.start();
  assert.match(String(started.health().mountError), /could not be started: no timers/);
});

test("the collector's cycle: a snapshot per cycle on disk and in the window, the report built once per snapshot, the since marker written again until it lands", async () => {
  const dir = tmp("cycle");
  const marker = join(dir, "collecting-since.txt");
  // the marker's name is taken by a directory, so the first write fails the way a full disk fails it
  mkdirSync(marker);
  let reads = 0;
  const collector = new SportsCollector({
    dataDir: dir,
    windowHours: 1,
    log: () => undefined,
    readGames: async (_now, health) => {
      reads += 1;
      health.kalshi = { ok: true, ms: 1 };
      return [game(40 + reads)];
    },
  });
  assert.equal(collector.reportData(), null);
  await collector.collectOnce(new Date("2026-11-09T20:00:00Z"));
  assert.equal(statSync(marker).isDirectory(), true);
  assert.equal((collector.health().data as { recording: boolean }).recording, false);
  rmdirSync(marker);
  const first = collector.reportData();
  assert.equal(collector.reportData(), first, "the same snapshot is not read twice");
  await collector.collectOnce(new Date("2026-11-09T20:01:00Z"));
  assert.equal(readFileSync(marker, "utf8"), "2026-11-09T20:00:00.000Z", "the second cycle wrote it, with the first cycle's time");
  const second = collector.reportData();
  assert.notEqual(second, first);
  assert.equal(second?.historyPoints, 2);
  assert.equal(second?.collectingSince, "2026-11-09T20:00:00.000Z");
  assert.equal(second?.windowHours, 1);
  const h = collector.health();
  assert.equal(h.cycles, 2);
  assert.equal(h.at, "2026-11-09T20:01:00.000Z");
  assert.equal(readFileSync(join(dir, "snapshots-2026-11-09.jsonl"), "utf8").trim().split("\n").length, 2);

  // a restart reads the marker and the window back
  const again = new SportsCollector({ dataDir: dir, windowHours: 1, log: () => undefined, readGames: async () => [] });
  assert.equal(await again.load(Date.parse("2026-11-09T20:02:00Z")), 2);
  assert.equal(again.reportData()?.collectingSince, "2026-11-09T20:00:00.000Z");
});

test("settings: SPORTS_VENUES_* as before, with the host's data dir, retention and window standing in for what they leave unset", () => {
  const dir = tmp("env");
  const own = sportsCollectorFromEnv({ SPORTS_VENUES_DATA_DIR: join(dir, "own"), SPORTS_VENUES_INTERVAL_SEC: "30", SPORTS_VENUES_WINDOW_HOURS: "48", SPORTS_VENUES_RETAIN_DAYS: "5" }, { dataDir: join(dir, "host"), retainDays: "60", retainSetting: "BTC_CURVE_RETAIN_DAYS", windowHours: 24 });
  assert.equal(own.dataDir, join(dir, "own"));
  assert.equal(own.intervalSec, 30);
  assert.equal(own.windowHours, 48);
  assert.equal((own.health().data as { retention: string }).retention, "5 days");
  assert.equal(existsSync(join(dir, "host")), false);

  const hosted = sportsCollectorFromEnv({}, { dataDir: join(dir, "host"), retainDays: "60", retainSetting: "BTC_CURVE_RETAIN_DAYS", windowHours: 24 });
  assert.equal(hosted.dataDir, join(dir, "host"));
  assert.equal(hosted.intervalSec, 60);
  assert.equal(hosted.windowHours, 24);
  assert.equal((hosted.health().data as { retention: string }).retention, "60 days");

  const alone = sportsCollectorFromEnv({ SPORTS_VENUES_DATA_DIR: join(dir, "alone") });
  assert.equal(alone.windowHours, 72);
  assert.equal((alone.health().data as { retention: string }).retention, "all");
});

test("the standalone script still serves the page, its JSON and /healthz, under its own key", async () => {
  const dir = tmp("alone");
  const now = Date.now();
  const at = new Date(now - 60_000).toISOString();
  writeFileSync(join(dir, `snapshots-${at.slice(0, 10)}.jsonl`), `${JSON.stringify(snapshot(at))}\n`);
  Object.assign(process.env, { NODE_ENV: "test", SPORTS_VENUES_DATA_DIR: dir, SPORTS_VENUES_TOKEN: "s1" });
  const service = (await import("../scripts/sportsVenuesReportService")) as { handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>; sports: SportsCollector };
  assert.equal(service.sports.windowHours, 72);
  assert.equal(await service.sports.load(now), 1);
  const { server, get } = await serve(service.handle);
  try {
    const h = JSON.parse((await get("/healthz")).text);
    assert.equal(h.ok, true);
    assert.equal(h.service, "sports-venues-report");
    assert.equal(h.warm, true);
    assert.equal(h.historyPoints, 1);
    assert.equal(typeof h.memoryMb.rss, "number");
    assert.equal((await get("/")).status, 404);
    assert.equal((await get("/api/report")).status, 404);
    const page = await get("/?k=s1");
    assert.equal(page.status, 200);
    assert.ok(page.text.includes("<h1>Sports on the event venues</h1>"));
    // on its own there is no host's line of links, only the sports pages, under its own key
    assert.equal(page.text.split("<nav").length - 1, 1);
    assert.ok(page.text.includes('<a href="/replay?k=s1">') && page.text.includes('<a href="/lock?k=s1">'));
    assert.ok(!page.text.includes("BTC curve"));
    assert.equal((await get("/replay")).status, 404);
    // its key does not open a reader's page
    assert.equal((await get("/prospect?k=s1")).status, 404);
    const replay = await get("/replay?k=s1");
    assert.equal(replay.status, 200);
    assert.ok(replay.text.includes('<a href="/?k=s1">The venues side by side</a>'));
    const lock = await get("/lock?k=s1");
    assert.equal(lock.status, 200);
    assert.ok(lock.text.includes('action="/lock"') && lock.text.includes('name="k" value="s1"'));
    assert.equal(JSON.parse((await get("/api/report?k=s1")).text).at, at);
    assert.equal(JSON.parse((await get("/api/latest?k=s1")).text).games.length, 1);
    assert.equal((await get("/sports?k=s1")).status, 404);
  } finally {
    server.close();
  }
});

test("gaps over the window: the figures are over every snapshot, the plotted series is thinned to what a sparkline can show", () => {
  const n = 3 * GAP_SERIES_MAX_POINTS + 7;
  const t0 = Date.parse("2026-11-09T12:00:00Z");
  // Novig one cent above Kalshi throughout, five cents above on one snapshot in the middle
  const history = Array.from({ length: n }, (_, i) => {
    const s = snapshot(new Date(t0 + i * 60_000).toISOString());
    if (i === 100) s.games[0].listings[1] = listing("novig", 45, 0);
    return toHistoryPoint(s);
  });
  const away = gapSeries(history, [readGame(game(), t0)]).find((g) => g.side === "away" && g.venue === "novig");
  assert.ok(away);
  assert.equal(away.points, n);
  assert.equal(away.series.length, GAP_SERIES_MAX_POINTS);
  assert.deepEqual(away.series[0], [t0, -1]);
  assert.deepEqual(away.series[away.series.length - 1], [t0 + (n - 1) * 60_000, -1]);
  assert.equal(away.max, 5, "the widest gap is counted though its point is not plotted");
  assert.equal(away.meanAbs, Math.round(((n - 1 + 5) / n) * 100) / 100);
  assert.equal(away.last, -1);
  for (let i = 1; i < away.series.length; i += 1) assert.ok(away.series[i][0] > away.series[i - 1][0]);
});

test("the line of links: the host's pages under its key, the page being read not linked, nothing when there is one page", () => {
  const links = pageLinks("a&b c", [{ label: "BTC pairs", base: "/pairs" }, { label: "Sports", base: "/sports" }]);
  assert.deepEqual(links, [{ label: "BTC curve", href: "/?k=a%26b%20c" }, { label: "BTC pairs", href: "/pairs?k=a%26b%20c" }, { label: "Sports", href: "/sports?k=a%26b%20c" }]);
  assert.equal(pageLinksHtml(links, "Sports"), '<nav style="font-size:13px;margin:0 0 10px;color:#6b7280"><a href="/?k=a%26b%20c">BTC curve</a> · <a href="/pairs?k=a%26b%20c">BTC pairs</a> · <b>Sports</b></nav>');
  assert.deepEqual(pageLinks(undefined, [{ label: "Sports", base: "/sports" }]).map((l) => l.href), ["/", "/sports"]);
  assert.equal(pageLinksHtml(pageLinks("k", []), "BTC curve"), "");
  assert.equal(pageLinksHtml(undefined, "Sports"), "");
});
