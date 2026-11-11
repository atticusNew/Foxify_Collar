/**
 * THE BACKUP COVERS EVERY FILE THE SERVICE KEEPS.
 *
 * Three things are held here:
 *   - the list (keptFiles.ts): the files the service writes and everything beside them that is
 *     theirs, with the sealed member connections listed and never exported;
 *   - the routes: the list, and each file on it byte for byte by its name, never by a path;
 *   - the nightly workflow itself: its two shell steps are taken out of
 *     .github/workflows/event-ledger-backup.yml as written and run against the service, and
 *     the copy is compared with the disk file by file.
 */

import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { execFile, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KEPT_NAME_RE, keptFileByName, keptFiles, type KeptBase, type KeptFilesFs, type KeptFilesList } from "../src/eventCollar/crossVenue/keptFiles";
import type { GameMarketRow, OneQuoteResult } from "../scripts/eventProtectXDemoService";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORKFLOW = join(REPO, ".github", "workflows", "event-ledger-backup.yml");
const TOKEN = "op-secret-0123456789";

const dir = mkdtempSync(join(tmpdir(), "kept-files-"));
const disk = join(dir, "data");
mkdirSync(disk);
process.env.NODE_ENV = "test";
process.env.EVENT_SHADOW_LEDGER_PATH = join(disk, "event-shadow-ledger.jsonl");
process.env.EVENT_SHADOW_LOCK_LEDGER_PATH = join(disk, "lock-ledger.jsonl");
process.env.EVENT_LASTLEG_LEDGER_PATH = join(disk, "event-shadow-lastleg.jsonl");
process.env.EVENT_X_ADMIN_TOKEN = TOKEN;
for (const k of Object.keys(process.env))
  if (/^EVENT_HEDGE_|^EVENT_SHADOW_ALERT_|^EVENT_X_DEV_NO_ADMIN$|^EVENT_SHADOW_(LOCK_PENDING|TERMS|REFUSALS)_PATH$|^EVENT_REALIZED_RECON_PATH$|^MEMBER_APP_|^EVENT_X_ADMIN_QUERY_TOKEN$/.test(k)) delete process.env[k];

const line = (o: Record<string, unknown>): string => `${JSON.stringify(o)}\n`;
/** What is on the disk: every kind of file the service keeps, with made-up but well-formed contents. */
const ON_DISK: Record<string, string> = {
  "event-shadow-ledger.jsonl": line({ type: "note", n: 1 }) + line({ type: "note", n: 2 }) + line({ type: "note", n: 3 }),
  "event-shadow-ledger.fingerprints.jsonl": line({ type: "day", day: "2026-11-10", sha256: "ab".repeat(32) }),
  "event-shadow-ledger.2026-10-01T120000Z.archived.jsonl": line({ type: "note", n: 0 }),
  "lock-ledger.jsonl": "",
  "lock-ledger-ann.jsonl": line({ type: "note", holder: "ann" }),
  "lock-ledger-ann.fingerprints.jsonl": line({ type: "day", day: "2026-11-10", sha256: "cd".repeat(32) }),
  "lock-ledger-ann.2026-11-01T090000Z.KXNBAGAME-X.archived.jsonl": line({ type: "note", holder: "ann", archived: true }),
  // a holder whose key was removed: the ledger is still on the disk, and still theirs
  "lock-ledger-gone.jsonl": line({ type: "note", holder: "gone" }),
  "lock-pending.jsonl": line({ type: "pending", id: "p1" }) + line({ type: "resolved", id: "p1" }),
  "hedge-receipts.jsonl": line({ type: "receipt", id: "r1" }),
  "event-shadow-lastleg.jsonl": line({ type: "ticket", id: "t1" }),
  "realized-recon.jsonl": line({ type: "day", day: "2026-11-10" }),
  "terms-acceptances.jsonl": line({ type: "terms_accepted", holder: "ann", version: "2026-11-01" }),
  "scan-refusals.json": JSON.stringify({ days: {} }),
  "member-combo-legs.json": JSON.stringify({ legs: {} }),
  // never exported
  "member-tokens.json": JSON.stringify({ sealed: "not-a-real-token" }),
  // not the service's
  "notes-from-someone.txt": "hello\n",
  // a remainder half-written during a reset
  "lock-ledger.2026-11-01T090000Z.tmp": "x",
};
for (const [name, body] of Object.entries(ON_DISK)) writeFileSync(join(disk, name), body);
const COPIED = Object.keys(ON_DISK)
  .filter((n) => !["member-tokens.json", "notes-from-someone.txt", "lock-ledger.2026-11-01T090000Z.tmp"].includes(n))
  .sort();

let worker: typeof import("../scripts/eventShadowWorker");
let base = "";
const op = { headers: { "x-admin-token": TOKEN } };

before(async () => {
  worker = await import("../scripts/eventShadowWorker");
  worker.wireLockEngine({
    listGameMarkets: async (): Promise<GameMarketRow[]> => [],
    quoteOne: async (): Promise<OneQuoteResult> => ({ ok: false, status: 404, body: { ok: false } }) as unknown as OneQuoteResult,
  });
  await new Promise<void>((r) => worker.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((r) => worker.server.close(() => r()));
});

const fakeFs = (dirs: Record<string, Record<string, number>>): KeptFilesFs => ({
  list: (d) => Object.entries(dirs[d] ?? {}).map(([name, bytes]) => ({ name, bytes: Math.abs(bytes), modifiedMs: Date.UTC(2026, 10, 11), isFile: bytes >= 0 })),
});

test("the list: each file the service writes, everything beside it that is one of its own, and nothing else", () => {
  const bases: KeptBase[] = [
    { key: "record", role: "the record's ledger", path: "/var/data/event-shadow-ledger.jsonl" },
    { key: "lock", role: "lock ledger", path: "/var/data/lock-ledger.jsonl" },
    { key: "pending", role: "pending trail", path: "/var/data/lock-pending.jsonl" },
    { key: "terms", role: "terms acceptances", path: "/var/data/terms-acceptances.jsonl" },
    { key: "member-connections", role: "members' sealed venue connections", path: "/var/data/member-tokens.json", notCopied: "credentials" },
    // one file kept in another folder, under a name the first folder also holds
    { key: "parlay", role: "parlay ledger", path: "/elsewhere/lock-ledger.jsonl" },
  ];
  const list = keptFiles(
    bases,
    fakeFs({
      "/var/data": {
        "event-shadow-ledger.jsonl": 300,
        "event-shadow-ledger.fingerprints.jsonl": 90,
        "event-shadow-ledger.2026-10-01T120000Z.archived.jsonl": 40,
        "lock-ledger.jsonl": 0,
        "lock-ledger-ann.jsonl": 55,
        "lock-ledger-ann.fingerprints.jsonl": 60,
        "lock-ledger-ann.2026-11-01T090000Z.KX-1.archived.jsonl": 20,
        "lock-ledger.2026-11-01T090000Z.tmp": 5,
        "lock-pending.jsonl": 70,
        "member-tokens.json": 400,
        "service.log": 10,
        "event-shadow-ledgers-old": -1, // a folder: not a file
        "lock-ledger name with spaces.jsonl": 9,
        "lock-ledger-bad name.jsonl": 9,
      },
      "/elsewhere": { "lock-ledger.jsonl": 12 },
    }),
  );
  assert.deepEqual(
    list.files.map((f) => [f.name, f.key, f.base, f.role, f.bytes, f.format]),
    [
      ["lock-ledger.jsonl", "parlay", true, "parlay ledger", 12, "jsonl"],
      ["event-shadow-ledger.2026-10-01T120000Z.archived.jsonl", "record", false, "the record's ledger: archived by a reset", 40, "jsonl"],
      ["event-shadow-ledger.fingerprints.jsonl", "record", false, "the record's ledger: daily fingerprints", 90, "jsonl"],
      ["event-shadow-ledger.jsonl", "record", true, "the record's ledger", 300, "jsonl"],
      ["lock-ledger-ann.2026-11-01T090000Z.KX-1.archived.jsonl", "lock", false, "lock ledger: holder ann, archived by a reset", 20, "jsonl"],
      ["lock-ledger-ann.fingerprints.jsonl", "lock", false, "lock ledger: holder ann, daily fingerprints", 60, "jsonl"],
      ["lock-ledger-ann.jsonl", "lock", false, "lock ledger: holder ann", 55, "jsonl"],
      // the same name in a second folder is asked for by a name of its own
      ["2~lock-ledger.jsonl", "lock", true, "lock ledger", 0, "jsonl"],
      ["lock-pending.jsonl", "pending", true, "pending trail", 70, "jsonl"],
    ],
  );
  assert.equal(list.files.find((f) => f.name === "2~lock-ledger.jsonl")?.path, "/var/data/lock-ledger.jsonl");
  assert.equal(list.files.find((f) => f.name === "lock-ledger.jsonl")?.path, "/elsewhere/lock-ledger.jsonl");
  for (const f of list.files) assert.match(f.name, KEPT_NAME_RE);
  assert.deepEqual(list.missing, [{ key: "terms", role: "terms acceptances", path: "/var/data/terms-acceptances.jsonl" }], "configured, and nothing of that kind written yet");
  assert.deepEqual(
    list.notCopied.map((f) => [f.name, f.why]),
    [
      ["lock-ledger-bad name.jsonl", "its name cannot be put in an address; rename it on the disk or copy it by hand"],
      ["member-tokens.json", "credentials"],
    ],
  );
  assert.deepEqual(
    list.others.map((f) => f.name),
    ["lock-ledger name with spaces.jsonl", "service.log"],
    "a file that is not one of the service's is named, not copied and not dropped without a word; a half-written remainder is neither",
  );

  // a name is looked up on the list; it is never a path
  assert.equal(keptFileByName(list, "lock-pending.jsonl")?.path, "/var/data/lock-pending.jsonl");
  for (const bad of [null, "", "../lock-pending.jsonl", "/var/data/lock-pending.jsonl", "member-tokens.json", "service.log", "lock-pending.jsonl/", "nope.jsonl"]) assert.equal(keptFileByName(list, bad), null, String(bad));

  // the member store missing from the disk is not reported as a gap: it is never copied either way
  assert.deepEqual(keptFiles([{ key: "member-connections", role: "x", path: "/d/member-tokens.json", notCopied: "credentials" }], fakeFs({ "/d": {} })), { files: [], missing: [], notCopied: [], others: [] });
  // a folder that cannot be read lists nothing and says every base is missing
  assert.deepEqual(keptFiles([{ key: "record", role: "r", path: "/nowhere/a.jsonl" }]).missing, [{ key: "record", role: "r", path: "/nowhere/a.jsonl" }]);
});

test("the routes: the list is the operator's; each file on it comes back byte for byte by name; a name off the list is nothing; the sealed connections are refused by name", async () => {
  assert.equal((await fetch(`${base}/api/shadow/export/files`)).status, 403);
  const res = await fetch(`${base}/api/shadow/export/files`, op);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const list = (await res.json()) as KeptFilesList & { ok: boolean };
  assert.equal(list.ok, true);
  assert.deepEqual(list.files.map((f) => f.name).sort(), COPIED);
  assert.deepEqual(list.notCopied.map((f) => [f.name, f.role]), [["member-tokens.json", "members' sealed venue connections"]]);
  assert.deepEqual(list.others.map((f) => f.name), ["notes-from-someone.txt"]);
  assert.deepEqual(list.missing, [], "every kind of file is on this disk");
  assert.equal(list.files.find((f) => f.name === "lock-ledger-gone.jsonl")?.role, "lock ledger: holder gone", "a removed holder's ledger is still found");
  assert.deepEqual(
    list.files.filter((f) => f.base).map((f) => f.key).sort(),
    ["combo-legs", "lock", "parlay", "pending", "receipts", "recon", "record", "refusals", "terms"],
  );

  for (const f of list.files) {
    assert.equal((await fetch(`${base}/api/shadow/export?file=${encodeURIComponent(f.name)}`)).status, 403, `${f.name}: not without the operator`);
    const got = await fetch(`${base}/api/shadow/export?file=${encodeURIComponent(f.name)}`, op);
    assert.equal(got.status, 200, f.name);
    assert.equal(got.headers.get("content-length"), String(Buffer.byteLength(ON_DISK[f.name])), f.name);
    assert.equal(await got.text(), ON_DISK[f.name], `${f.name} byte for byte`);
    assert.equal(f.path, join(disk, f.name), "where a restore puts it back");
  }

  const sealed = await fetch(`${base}/api/shadow/export?file=member-tokens.json`, op);
  assert.equal(sealed.status, 403);
  const sealedBody = (await sealed.json()) as { error: string; message: string };
  assert.equal(sealedBody.error, "not_exported");
  assert.ok(!JSON.stringify(sealedBody).includes("not-a-real-token"));
  for (const name of ["notes-from-someone.txt", "lock-ledger.2026-11-01T090000Z.tmp", "../data/lock-pending.jsonl", join(disk, "lock-pending.jsonl"), "/etc/hostname", "..%2F..%2Fetc%2Fhostname", "", "nope.jsonl"]) {
    const r = await fetch(`${base}/api/shadow/export?file=${encodeURIComponent(name)}`, op);
    assert.equal(r.status, 404, name);
  }
  // the ledger exports that were there before answer as before
  assert.equal(await (await fetch(`${base}/api/shadow/export`, op)).text(), ON_DISK["event-shadow-ledger.jsonl"]);
  assert.equal(await (await fetch(`${base}/api/shadow/export?ledger=lock&holder=ann`, op)).text(), ON_DISK["lock-ledger-ann.jsonl"]);
  const empty = await fetch(`${base}/api/shadow/export?ledger=lock`, op);
  assert.equal(empty.status, 200);
  assert.equal(await empty.text(), "");
});

/** The `run:` script of one step of the workflow, exactly as the file has it. */
function stepScript(stepName: string): string {
  const lines = readFileSync(WORKFLOW, "utf8").split("\n");
  const at = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  assert.ok(at >= 0, `the workflow has a step named ${stepName}`);
  const runAt = lines.findIndex((l, i) => i > at && l.trim() === "run: |");
  const nextStep = lines.findIndex((l, i) => i > at && /^\s*- name: /.test(l));
  assert.ok(runAt > at && (nextStep < 0 || runAt < nextStep), `${stepName} has a run script`);
  const indent = (lines[runAt].match(/^\s*/)?.[0].length ?? 0) + 2;
  const body: string[] = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    if (lines[i].trim() !== "" && (lines[i].match(/^\s*/)?.[0].length ?? 0) < indent) break;
    body.push(lines[i].slice(indent));
  }
  const script = body.join("\n");
  assert.ok(!script.includes("${{"), `${stepName} takes what it needs from its env, not from an expression pasted into the script`);
  return script;
}

interface RunResult {
  code: number;
  out: string;
  backup: string;
  output: string;
  summary: string;
}

/** Run the workflow's fetch step, then its check step, the way the runner does: bash, in a fresh folder. */
async function rehearse(url: string, token: string): Promise<RunResult> {
  const work = mkdtempSync(join(tmpdir(), "backup-run-"));
  const temp = join(work, "runner-temp");
  mkdirSync(temp);
  const outputFile = join(work, "github-output");
  const summaryFile = join(work, "summary.md");
  writeFileSync(outputFile, "");
  writeFileSync(summaryFile, "");
  const env = { PATH: process.env.PATH ?? "", HOME: work, RUNNER_TEMP: temp, GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: summaryFile, EVENT_SHADOW_URL: url, EVENT_X_ADMIN_TOKEN: token };
  const run = (script: string, extra: Record<string, string> = {}): Promise<{ code: number; out: string }> =>
    new Promise((resolve) => {
      // --noprofile --norc -e -o pipefail is how the runner starts `shell: bash`
      execFile("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], { cwd: work, env: { ...env, ...extra }, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code as number) : 1) : 0, out: `${stdout}${stderr}` });
      });
    });
  const fetched = await run(stepScript("Fetch the files"));
  let out = fetched.out;
  let code = fetched.code;
  if (code === 0) {
    const mode = /^mode=(.*)$/m.exec(readFileSync(outputFile, "utf8"))?.[1] ?? "";
    const checked = await run(stepScript("Check the copy and write the summary"), { BACKUP_MODE: mode });
    out += checked.out;
    code = checked.code;
  }
  return { code, out, backup: join(work, "backup"), output: readFileSync(outputFile, "utf8"), summary: readFileSync(summaryFile, "utf8") };
}

const canRehearse = process.platform === "linux" && ["bash", "curl", "jq", "sha256sum"].every((tool) => spawnSync("bash", ["-c", `command -v ${tool}`]).status === 0);
const rehearsal = canRehearse ? test : test.skip;

rehearsal("the nightly workflow, run as written against the service: every kept file is in the copy byte for byte, with the list and a checksum beside each", async () => {
  const run = await rehearse(base, TOKEN);
  assert.equal(run.code, 0, run.out);
  const copied = readdirSync(run.backup).sort();
  assert.deepEqual(copied, [...COPIED, ...COPIED.map((n) => `${n}.sha256`), "manifest.json", "manifest.json.sha256"].sort());
  for (const name of COPIED) {
    assert.equal(readFileSync(join(run.backup, name), "utf8"), ON_DISK[name], `${name} byte for byte`);
    assert.equal(spawnSync("sha256sum", ["-c", `${name}.sha256`], { cwd: run.backup }).status, 0, `${name} checks against its checksum`);
  }
  // the list in the copy says where each file goes back
  const manifest = JSON.parse(readFileSync(join(run.backup, "manifest.json"), "utf8")) as KeptFilesList;
  assert.deepEqual(manifest.files.map((f) => f.path).sort(), COPIED.map((n) => join(disk, n)).sort());
  // nothing of the sealed connections, and the token nowhere
  const everything = copied.map((n) => readFileSync(join(run.backup, n), "utf8")).join("\n") + run.out + run.summary + run.output;
  assert.ok(!everything.includes("not-a-real-token"));
  assert.ok(!everything.includes(TOKEN), "the token is in no file, no log line and no summary");
  assert.match(run.output, /^mode=every file the service keeps$/m);
  assert.match(run.output, /^bad=0$/m);
  assert.match(run.output, /^date=\d{4}-\d{2}-\d{2}$/m);
  // the summary a person reads on the run's page
  assert.ok(run.summary.includes("Copied: every file the service keeps."));
  assert.ok(run.summary.includes("| lock-pending.jsonl | real-money lock attempts (the pending trail) | "));
  assert.ok(run.summary.includes("| terms-acceptances.jsonl | terms acceptances | "));
  assert.ok(run.summary.includes("| lock-ledger-gone.jsonl | lock ledger: holder gone | "));
  assert.ok(run.summary.includes("- member-tokens.json: credentials: kept on the disk only; a member whose connection is lost connects again"));
  assert.ok(run.summary.includes("- notes-from-someone.txt: not one of the files the service writes"));
  assert.ok(run.summary.includes("Not on the disk yet (nothing of that kind has been written):\n- none"));
  assert.ok(!/[\u2013\u2014]/.test(run.summary));
});

rehearsal("the nightly workflow: a wrong token stops it; a line that does not parse is copied and counted; an empty record stops it", async () => {
  const wrong = await rehearse(base, "not-the-token");
  assert.equal(wrong.code, 1);
  assert.ok(wrong.out.includes("answered 403. The EVENT_X_ADMIN_TOKEN secret does not match the service's"), wrong.out);
  assert.ok(!wrong.out.includes("not-the-token"));

  const clear = await rehearse("http://example.test", TOKEN);
  assert.equal(clear.code, 1);
  assert.ok(clear.out.includes("EVENT_SHADOW_URL must start with https://"), "the token is not sent in the clear over a network");
  const noSecret = await rehearse(base, "");
  assert.equal(noSecret.code, 1);
  assert.ok(noSecret.out.includes("The repository secret EVENT_X_ADMIN_TOKEN is not set."));

  const receipts = join(disk, "hedge-receipts.jsonl");
  const refusals = join(disk, "scan-refusals.json");
  try {
    writeFileSync(receipts, `${ON_DISK["hedge-receipts.jsonl"]}{"type":"receipt","id":\n[1,2]\n`);
    writeFileSync(refusals, "{ not json");
    const run = await rehearse(base, TOKEN);
    assert.equal(run.code, 0, run.out);
    assert.match(run.output, /^bad=3$/m, "two lines of the trail and the one document: counted, and the last step of the workflow fails on it");
    assert.equal(readFileSync(join(run.backup, "hedge-receipts.jsonl"), "utf8"), readFileSync(receipts, "utf8"), "the copy is the disk's bytes either way");
    assert.ok(/\| hedge-receipts\.jsonl \| hedge receipts \| \d+ \| 3 \| 2 \| /.test(run.summary), run.summary);
    assert.ok(/\| scan-refusals\.json \| scan refusal counts \| \d+ \| 1 \| 1 \| /.test(run.summary), run.summary);
  } finally {
    writeFileSync(receipts, ON_DISK["hedge-receipts.jsonl"]);
    writeFileSync(refusals, ON_DISK["scan-refusals.json"]);
  }

  const record = join(disk, "event-shadow-ledger.jsonl");
  try {
    writeFileSync(record, "");
    const run = await rehearse(base, TOKEN);
    assert.equal(run.code, 1);
    assert.ok(run.out.includes("The record's ledger is missing or came back empty."), run.out);
  } finally {
    writeFileSync(record, ON_DISK["event-shadow-ledger.jsonl"]);
  }
});

rehearsal("the nightly workflow against a service deployed before the list existed: the ledgers are copied, and the run says what was not", async () => {
  // what the service answered before this change: no list, the three ledger exports, the holders
  const old: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://old");
    const send = (status: number, type: string, body: string): void => {
      res.writeHead(status, { "content-type": type });
      res.end(body);
    };
    if (req.headers["x-admin-token"] !== TOKEN) return send(403, "application/json", JSON.stringify({ ok: false, error: "bad admin token" }));
    if (url.pathname === "/api/shadow/holders") return send(200, "application/json", JSON.stringify({ ok: true, holders: [{ holder: "(shared)" }, { holder: "ann" }] }));
    if (url.pathname === "/api/shadow/export" && url.searchParams.get("ledger") === "lock") return send(200, "application/x-ndjson", url.searchParams.get("holder") === "ann" ? ON_DISK["lock-ledger-ann.jsonl"] : "");
    if (url.pathname === "/api/shadow/export") return send(200, "application/x-ndjson", ON_DISK["event-shadow-ledger.jsonl"]);
    return send(404, "application/json", JSON.stringify({ ok: false, error: "not found" }));
  });
  await new Promise<void>((r) => old.listen(0, "127.0.0.1", () => r()));
  try {
    const run = await rehearse(`http://127.0.0.1:${(old.address() as AddressInfo).port}`, TOKEN);
    assert.equal(run.code, 0, run.out);
    assert.deepEqual(
      readdirSync(run.backup).filter((n) => !n.endsWith(".sha256")).sort(),
      ["event-shadow-ledger.jsonl", "event-shadow-lock-ledger-ann.jsonl", "event-shadow-lock-ledger.jsonl"],
    );
    assert.equal(readFileSync(join(run.backup, "event-shadow-ledger.jsonl"), "utf8"), ON_DISK["event-shadow-ledger.jsonl"]);
    assert.ok(run.out.includes("::warning title=Only the ledgers were copied::This service does not list its files yet"), run.out);
    assert.match(run.output, /^mode=the ledgers only \(older service\)$/m);
    assert.ok(run.summary.includes("Copied: the ledgers only (older service)."));
  } finally {
    await new Promise<void>((r) => old.close(() => r()));
  }
});
