#!/usr/bin/env tsx
/**
 * DKEX RECORD, command line: read DraftKings' exchange's public daily files and write the
 * replay of its finished games to src/sportsVenues/dkexSeed/record.json, which the service
 * reads (src/sportsVenues/dkexRecord.ts). What the files are and how a game is read from them
 * is the header of src/sportsVenues/dkex.ts.
 *
 * It calls one host, railbirdexchange.com, with no key, and writes two places: the cache dir
 * and the record. Each day's three files are streamed, never held: the rows about game-winner
 * contracts are kept in the cache (about 1 MB a day of some 200), with the day's totals beside
 * them, so a second run downloads only the days it has not seen.
 *
 * Run:  npx tsx services/api/scripts/sportsDkexBuild.ts
 *
 * Flags (each also as --flag=value):
 *   --cache <path>      where the kept rows go (default /tmp/dkex-cache)
 *   --from YYYY-MM-DD   first day (default: the first published)
 *   --to YYYY-MM-DD     last day (default: the last published)
 *   --out <path>        the record (default: the one that ships with the code)
 *   --offline           read the cache only; a day not in it is an error
 *
 * Exit code 0 with a record written, 2 when it could not be.
 */

import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import { DKEX_WINNER_ROW, DkexAssembler } from "../src/sportsVenues/dkex";
import { DKEX_RECORD_PATH, dkexRecordOf } from "../src/sportsVenues/dkexRecord";
import { openTallyOf } from "../src/sportsVenues/tapeReplay";

const HOST = "https://railbirdexchange.com";
const KINDS = ["time-and-sales", "daily-market", "daily-settlement"] as const;
type Kind = (typeof KINDS)[number];
interface DayStat {
  date: string;
  rows: number;
  kept: number;
  bytes: number;
  /** Time & Sales only: contracts traded that day, and those in combos */
  contracts: number;
  combo: number;
}

function flags(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`not a flag: ${a}`);
    const eq = a.indexOf("=");
    const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
    if (!["cache", "from", "to", "out", "offline"].includes(name)) throw new Error(`unknown flag --${name}`);
    if (name === "offline") out.set(name, "1");
    else if (eq >= 0) out.set(name, a.slice(eq + 1));
    else out.set(name, argv[(i += 1)] ?? "");
  }
  return out;
}

const browser = { "user-agent": "Mozilla/5.0 (compatible; atticus-dkex-record)" };

async function manifest(kind: Kind): Promise<Array<{ date: string; href: string }>> {
  const res = await fetch(`${HOST}/reports/${kind}/manifest.json`, { headers: browser });
  if (!res.ok) throw new Error(`${kind} manifest: HTTP ${res.status}`);
  const body = (await res.json()) as { reports?: Array<{ date: string; href: string }> };
  return body.reports ?? [];
}

/** One day's file, streamed: its winner rows to the cache, its totals beside them. */
async function pull(kind: Kind, date: string, href: string, cache: string): Promise<void> {
  const res = await fetch(HOST + encodeURI(href).replace(/&/g, "%26"), { headers: browser });
  if (!res.ok || !res.body) throw new Error(`${kind} ${date}: HTTP ${res.status}`);
  const part = join(cache, `${kind}-${date}.csv.part`);
  const out = createWriteStream(part);
  const stat: DayStat = { date, rows: 0, kept: 0, bytes: 0, contracts: 0, combo: 0 };
  let head = true;
  for await (const line of createInterface({ input: Readable.fromWeb(res.body as ReadableStream<Uint8Array>), crlfDelay: Infinity })) {
    stat.bytes += Buffer.byteLength(line) + 1;
    if (head) {
      head = false;
      out.write(`${line}\n`);
      continue;
    }
    stat.rows += 1;
    if (kind === "time-and-sales") {
      const qty = Number(line.slice(line.lastIndexOf(",") + 1));
      if (Number.isFinite(qty)) {
        stat.contracts += qty;
        if (line.includes(",COMBO-")) stat.combo += qty;
      }
    }
    if (DKEX_WINNER_ROW.test(line)) {
      stat.kept += 1;
      out.write(`${line}\n`);
    }
  }
  await new Promise<void>((done, fail) => out.end((err?: Error | null) => (err ? fail(err) : done())));
  renameSync(part, join(cache, `${kind}-${date}.csv`));
  writeFileSync(join(cache, `${kind}-${date}.stat.json`), JSON.stringify(stat));
}

async function retried(what: string, run: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= 3) throw err;
      console.error(`${what}: ${(err as Error).message}; trying again`);
      await new Promise((r) => setTimeout(r, 4000 * 2 ** attempt));
    }
  }
}

async function eachRow(path: string, row: (line: string) => void): Promise<void> {
  let head = true;
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    if (head) head = false;
    else row(line);
  }
}

async function main(): Promise<number> {
  const f = flags(process.argv.slice(2));
  const cache = f.get("cache") || "/tmp/dkex-cache";
  const out = f.get("out") || DKEX_RECORD_PATH;
  const offline = f.has("offline");
  mkdirSync(cache, { recursive: true });

  // the days: the exchange's own list, or what the cache holds
  const days = new Map<string, Partial<Record<Kind, string>>>();
  if (offline) {
    for (const name of readdirSync(cache)) {
      const m = /^(time-and-sales|daily-market|daily-settlement)-(\d{4}-\d{2}-\d{2})\.stat\.json$/.exec(name);
      if (m) days.set(m[2], { ...days.get(m[2]), [m[1]]: "" });
    }
  } else {
    for (const kind of KINDS) for (const r of await manifest(kind)) days.set(r.date, { ...days.get(r.date), [kind]: r.href });
  }
  const from = f.get("from") || "0000";
  const to = f.get("to") || "9999";
  const dates = [...days.keys()].filter((d) => d >= from && d <= to && KINDS.every((k) => days.get(d)?.[k] !== undefined)).sort();
  if (!dates.length) throw new Error("no day has all three files");

  const jobs = dates.flatMap((date) => KINDS.map((kind) => ({ kind, date }))).filter((j) => !existsSync(join(cache, `${j.kind}-${j.date}.stat.json`)));
  if (jobs.length && offline) throw new Error(`${jobs.length} files are not in the cache`);
  let next = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < jobs.length) {
        const j = jobs[next];
        next += 1;
        await retried(`${j.kind} ${j.date}`, () => pull(j.kind, j.date, days.get(j.date)?.[j.kind] as string, cache));
        console.error(`read ${j.kind} ${j.date}`);
      }
    }),
  );

  const dkex = new DkexAssembler();
  const exchange = { prints: 0, contracts: 0, comboContracts: 0, winnerPrints: 0, winnerContracts: 0 };
  for (const date of dates) {
    await eachRow(join(cache, `daily-market-${date}.csv`), (line) => dkex.market(line));
    await eachRow(join(cache, `daily-settlement-${date}.csv`), (line) => dkex.settlement(line));
    await eachRow(join(cache, `time-and-sales-${date}.csv`), (line) => dkex.print(line));
    const stat = JSON.parse(readFileSync(join(cache, `time-and-sales-${date}.stat.json`), "utf8")) as DayStat;
    exchange.prints += stat.rows;
    exchange.contracts += Math.round(stat.contracts);
    exchange.comboContracts += Math.round(stat.combo);
  }
  exchange.winnerPrints = dkex.winnerPrints;
  exchange.winnerContracts = Math.round(dkex.winnerQty / 100);
  const { games, listed } = dkex.games();
  const record = dkexRecordOf(games, { builtAt: new Date().toISOString(), firstDay: dates[0], lastDay: dates[dates.length - 1], days: dates.length, exchange, listed });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(record)}\n`);

  const t = record.report.all;
  const tickets = openTallyOf(t);
  console.log(`${record.firstDay} to ${record.lastDay}, ${record.days} days: ${listed} games listed, ${t.games} finished with a result, ${record.noResult} without`);
  console.log(`${exchange.prints.toLocaleString("en-US")} trades on the exchange, ${exchange.winnerPrints.toLocaleString("en-US")} of them on game-winner contracts; ${tickets.n.toLocaleString("en-US")} tickets followed`);
  console.log(`written: ${out}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(String((err as Error)?.message ?? err));
    process.exit(2);
  },
);
