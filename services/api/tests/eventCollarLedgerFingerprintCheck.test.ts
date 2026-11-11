/**
 * The check anyone can run (scripts/eventLedgerFingerprint.ts): a copy of a ledger against a
 * published list of daily fingerprints, in every outcome, as a function and as the real command.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprintLedger, fingerprintReport, type LedgerFingerprintStatus } from "../src/eventCollar/crossVenue/ledgerFingerprint";
import { EXIT_DIFFERS, EXIT_MATCH, EXIT_NOT_RUN, EXIT_STOPS_SHORT, fingerprintFile, runLedgerFingerprint } from "../scripts/eventLedgerFingerprint";

const rec = (at: string, n: number): string => `${JSON.stringify({ type: "open", at, ticker: "KXTEST", n })}\n`;
const LINES = [
  rec("2026-09-12T16:00:00.000Z", 1),
  rec("2026-09-12T18:30:00.000Z", 2),
  rec("2026-09-13T01:00:00.000Z", 3),
  rec("2026-09-13T20:00:00.000Z", 4),
  rec("2026-09-14T09:00:00.000Z", 5),
  rec("2026-09-15T09:00:00.000Z", 6),
  rec("2026-09-15T10:00:00.000Z", 7),
];

const dir = mkdtempSync(join(tmpdir(), "fingerprint-check-"));
const write = (name: string, text: string): string => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};

/** the route's body for a ledger whose every closed day was published */
function publishedBody(ledger: string, earlier: LedgerFingerprintStatus["earlier"] = [], chain = 1): Record<string, unknown> {
  const f = fingerprintLedger(Buffer.from(ledger));
  const status: LedgerFingerprintStatus = {
    state: "ok",
    chain,
    days: f.days.map((d) => ({ ...d, publishedAt: "2026-11-10T22:00:00.000Z" })),
    open: f.open,
    pendingBytes: 0,
    mismatch: null,
    earlier,
    mismatches: [],
    fullCheckAt: "2026-11-10T22:00:00.000Z",
    error: null,
  };
  return fingerprintReport(status, { atIso: "2026-11-10T22:05:00.000Z" });
}

async function run(...argv: string[]): Promise<{ code: number; out: string[] }> {
  const out: string[] = [];
  const code = await runLedgerFingerprint(argv, (l) => out.push(l));
  return { code, out };
}

const LEDGER = write("ledger.jsonl", LINES.join(""));
const LIST = write("fingerprints.json", JSON.stringify(publishedBody(LINES.join(""))));

test("fingerprint check: prints the same daily fingerprints the service publishes, the open day marked not final", async () => {
  const f = fingerprintLedger(readFileSync(LEDGER));
  assert.deepEqual(fingerprintFile(LEDGER), f, "read in pieces from the file, the same as from memory");
  const { code, out } = await run(LEDGER);
  assert.equal(code, EXIT_MATCH);
  assert.equal(out[0], `${LEDGER}: 7 lines, ${Buffer.byteLength(LINES.join("")).toLocaleString("en-US")} bytes, 3 closed days`);
  assert.deepEqual(out.slice(1, 4), f.days.map((d) => `${d.day}  ${d.lines} lines  ${d.bytes} bytes  ${d.sha256}`));
  assert.equal(out[4], `2026-09-15  7 lines  ${f.open!.bytes} bytes  ${f.open!.sha256}  (open day, not final)`);
  assert.equal(out.length, 5);

  const json = await run(LEDGER, "--json");
  assert.equal(json.code, EXIT_MATCH);
  assert.deepEqual(JSON.parse(json.out.join("\n")), f);

  // an unfinished last line is said, and covered by nothing
  const unfinished = '{"type":"open","at":"2026-09-1';
  const cut = await run(write("cut.jsonl", LINES.join("") + unfinished));
  assert.equal(cut.out[cut.out.length - 1], `${unfinished.length} bytes after the last newline are an unfinished line and are covered by no fingerprint.`);
  assert.ok(!cut.out.join("\n").includes("\u2014") && !cut.out.join("\n").includes("\u2013"));
});

test("fingerprint check: --expect says MATCH and exits 0 when the copy is the published history", async () => {
  const { code, out } = await run(LEDGER, "--expect", LIST);
  assert.equal(code, EXIT_MATCH);
  assert.equal(out[out.length - 1], "MATCH: all 3 published days, 2026-09-12 to 2026-09-14.");

  // a bare list of days, as someone might have saved it
  const bare = write("bare.json", JSON.stringify(fingerprintLedger(readFileSync(LEDGER)).days));
  assert.equal((await run(LEDGER, "--expect", bare)).code, EXIT_MATCH);

  // a copy newer than the list: the days the list has are reproduced, the rest are new
  const older = write("older-list.json", JSON.stringify(publishedBody(LINES.slice(0, 5).join(""))));
  const newer = await run(LEDGER, "--expect", older);
  assert.equal(newer.code, EXIT_MATCH);
  assert.equal(newer.out[newer.out.length - 1], "MATCH: all 2 published days, 2026-09-12 to 2026-09-13. This file has 1 closed day after that, newer than the list.");

  // a copy that ends exactly on the last published day's last line
  const exact = await run(write("exact.jsonl", LINES.slice(0, 5).join("")), "--expect", LIST);
  assert.equal(exact.code, EXIT_MATCH);
  assert.equal(exact.out[exact.out.length - 1], "MATCH: all 3 published days, 2026-09-12 to 2026-09-14; the file ends on the last line of 2026-09-14.");

  // nothing published yet
  const none = await run(LEDGER, "--expect", write("none.json", JSON.stringify(publishedBody(LINES.slice(0, 2).join("")))));
  assert.equal(none.code, EXIT_MATCH);
  assert.equal(none.out[none.out.length - 1], "The published list has no closed day yet, so there is nothing to compare.");
});

test("fingerprint check: --expect exits non-zero and names the first day that differs", async () => {
  const f = fingerprintLedger(readFileSync(LEDGER));
  // one character of the second day
  const tampered = LINES.join("").replace('"n":3', '"n":8');
  const t = fingerprintLedger(Buffer.from(tampered));
  const { code, out } = await run(write("tampered.jsonl", tampered), "--expect", LIST);
  assert.equal(code, EXIT_DIFFERS);
  assert.deepEqual(out.slice(-4), [
    "The 1 day before it matches.",
    `published  2026-09-13  4 lines  ${f.days[1].bytes} bytes  ${f.days[1].sha256}`,
    `this file  2026-09-13  4 lines  ${t.days[1].bytes} bytes  ${t.days[1].sha256}`,
    "DIFFERS at 2026-09-13: this file is not the history that was published for that day.",
  ]);

  // a line removed from the first day
  const removed = await run(write("removed.jsonl", LINES.slice(1).join("")), "--expect", LIST);
  assert.equal(removed.code, EXIT_DIFFERS);
  assert.equal(removed.out[removed.out.length - 1], "DIFFERS at 2026-09-12: this file is not the history that was published for that day.");
  assert.ok(!removed.out.some((l) => l.includes("before it match")), "nothing before the first day");

  // a line added at the end of a closed day
  const added = await run(write("added.jsonl", [...LINES.slice(0, 5), rec("2026-09-14T23:00:00.000Z", 99), ...LINES.slice(5)].join("")), "--expect", LIST);
  assert.equal(added.code, EXIT_DIFFERS);
  assert.equal(added.out[added.out.length - 1], "DIFFERS at 2026-09-14: this file is not the history that was published for that day.");

  // later lines re-dated so that a published day never closes: the file runs past where that day
  // ended without reproducing it, which is a difference and not an older copy
  const redated = await run(write("redated.jsonl", LINES.join("").replace(/2026-09-1[45]/g, "2026-09-13")), "--expect", LIST);
  assert.equal(redated.code, EXIT_DIFFERS);
  assert.equal(redated.out[redated.out.length - 1], "DIFFERS at 2026-09-13: this file is not the history that was published for that day.");
});

test("fingerprint check: a copy that stops before the published list does is neither a match nor a difference", async () => {
  // yesterday's backup against today's list: the days it closes match, the rest cannot be checked
  const older = await run(write("backup.jsonl", LINES.slice(0, 3).join("")), "--expect", LIST);
  assert.equal(older.code, EXIT_STOPS_SHORT);
  assert.deepEqual(older.out.slice(-2), [
    "The 1 day this file reaches, 2026-09-12 to 2026-09-12, matches.",
    "STOPS SHORT at 2026-09-13: the file ends before that day's last line, so 2026-09-13 and 1 later published day were not checked. An older copy does this; so does a copy that was cut short.",
  ]);
  const empty = await run(write("empty.jsonl", ""), "--expect", LIST);
  assert.equal(empty.code, EXIT_STOPS_SHORT);
  assert.equal(empty.out[empty.out.length - 2], "This file reaches no published day.");
});

test("fingerprint check: an archived ledger is compared with the chain it belonged to, to its last byte", async () => {
  const archivedText = LINES.join("");
  const a = fingerprintLedger(Buffer.from(archivedText));
  const { final: _final, ...closing } = a.open!;
  const earlier: LedgerFingerprintStatus["earlier"] = [
    {
      chain: 1,
      days: a.days.map((d) => ({ ...d, publishedAt: "2026-11-01T00:00:00.000Z" })),
      mismatches: [],
      standing: null,
      ended: { at: "2026-11-10T01:30:00.000Z", reason: "the ledger was archived whole and a new one started", archivedTo: "ledger.2026-11-10T013000Z.archived.jsonl", closing, intact: true },
    },
  ];
  const fresh = rec("2026-11-10T02:00:00.000Z", 1) + rec("2026-11-11T02:00:00.000Z", 2);
  const list = write("after-reset.json", JSON.stringify(publishedBody(fresh, earlier, 2)));
  const archived = write("ledger.2026-11-10T013000Z.archived.jsonl", archivedText);

  const ok = await run(archived, "--expect", list, "--chain", "1");
  assert.equal(ok.code, EXIT_MATCH);
  assert.equal(ok.out[ok.out.length - 1], "MATCH: all 3 published days, 2026-09-12 to 2026-09-14, and the whole file as it stood when it was archived.");

  // compared with the current chain by mistake: it differs, and the answer says where to look
  const wrong = await run(archived, "--expect", list);
  assert.equal(wrong.code, EXIT_DIFFERS);
  assert.ok(wrong.out.includes("The list also carries 1 earlier chain (ledgers archived by a reset). If this file is an archived ledger, compare it with --chain 1."));

  // the last line of the archived file changed: every closed day still matches, the whole file does not
  const lastChanged = await run(write("archived-edited.jsonl", archivedText.replace('"n":7', '"n":0')), "--expect", list, "--chain", "1");
  assert.equal(lastChanged.code, EXIT_DIFFERS);
  assert.equal(lastChanged.out[lastChanged.out.length - 1], "DIFFERS at 2026-09-15: this file is not the history that was published for that day.");

  // the new ledger against the current chain
  assert.equal((await run(write("fresh.jsonl", fresh), "--expect", list)).code, EXIT_MATCH);
  assert.equal((await run(archived, "--expect", list, "--chain", "5")).code, EXIT_NOT_RUN);
});

test("fingerprint check: --expect reads a URL; what cannot be run says so and exits 2", async () => {
  const body = JSON.stringify(publishedBody(LINES.join("")));
  const server = createServer((req, res) => {
    if (req.url === "/api/shadow/fingerprints") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    } else if (req.url === "/html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>not a list</html>");
    } else {
      res.writeHead(503);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const ok = await run(LEDGER, "--expect", `${base}/api/shadow/fingerprints`);
    assert.equal(ok.code, EXIT_MATCH);
    assert.equal(ok.out[ok.out.length - 1], "MATCH: all 3 published days, 2026-09-12 to 2026-09-14.");
    const bad = await run(write("tampered-url.jsonl", LINES.join("").replace('"n":1', '"n":9')), "--expect", `${base}/api/shadow/fingerprints`);
    assert.equal(bad.code, EXIT_DIFFERS);
    assert.match(bad.out[bad.out.length - 1], /^DIFFERS at 2026-09-12:/);

    const down = await run(LEDGER, "--expect", `${base}/down`);
    assert.equal(down.code, EXIT_NOT_RUN);
    assert.equal(down.out[down.out.length - 1], `could not read the published list from ${base}/down: ${base}/down answered 503`);
    assert.equal((await run(LEDGER, "--expect", `${base}/html`)).code, EXIT_NOT_RUN);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }

  assert.equal((await run()).code, EXIT_NOT_RUN);
  assert.equal((await run(join(dir, "no-such-file.jsonl"))).code, EXIT_NOT_RUN);
  assert.equal((await run(LEDGER, "--expect")).code, EXIT_NOT_RUN);
  assert.equal((await run(LEDGER, "--expect", join(dir, "no-such-list.json"))).code, EXIT_NOT_RUN);
  assert.equal((await run(LEDGER, "--expect", write("not-a-list.json", '{"ok":true}'))).code, EXIT_NOT_RUN);
  assert.equal((await run(LEDGER, "--chain", "one")).code, EXIT_NOT_RUN);
  assert.equal((await run(LEDGER, "--verbose")).code, EXIT_NOT_RUN);
  assert.equal((await run(LEDGER, LEDGER)).code, EXIT_NOT_RUN);
});

test("fingerprint check: the command itself, as the script header gives it, in both outcomes", () => {
  const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const cli = (...args: string[]) => spawnSync("npx", ["tsx", "scripts/eventLedgerFingerprint.ts", ...args], { cwd: apiDir, encoding: "utf8" });
  const ok = cli(LEDGER, "--expect", LIST);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /MATCH: all 3 published days, 2026-09-12 to 2026-09-14\.\n$/);
  const bad = cli(join(dir, "tampered.jsonl"), "--expect", LIST);
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stdout, /DIFFERS at 2026-09-13: this file is not the history that was published for that day\.\n$/);
});
