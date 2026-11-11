/**
 * Ledger fingerprints on the shadow worker itself: the record page's section, the public list,
 * /healthz, the operator's lock ledgers, a mismatch made loud and left alone, the reset, and the
 * check script run against the live route.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprintLedger, mismatchWords, type PublishedDay, type RunningFingerprint } from "../src/eventCollar/crossVenue/ledgerFingerprint";
import { appendShadowRecord, type ShadowOpenRecord } from "../src/eventCollar/crossVenue/shadowLedger";
import { EXIT_DIFFERS, EXIT_MATCH, runLedgerFingerprint } from "../scripts/eventLedgerFingerprint";

const OPEN: ShadowOpenRecord = {
  type: "open",
  at: "2026-09-12T16:00:00.000Z",
  ticker: "KXNFLGAME-TEST-KC",
  kind: "sports",
  league: "nfl",
  sideName: "Kansas City Chiefs",
  eventTitle: "Kansas City wins",
  eventTimeIso: "2026-09-21T00:20:00.000Z",
  contracts: 150,
  markCents: 60,
  floorCents: 52,
  capCents: 63,
  creditCents: 112,
  evCostBps: 297,
  route: "polymarket",
  feesCents: 0,
  takeCents: 12,
};

interface ListBody {
  ok: boolean;
  ledger: string;
  state: string;
  chain: number;
  latest: PublishedDay | null;
  days: PublishedDay[];
  open: RunningFingerprint | null;
  mismatch?: { day: string; published: { sha256: string }; found: { sha256: string } | null };
  restarts: Array<{ chain: number; restartedAt: string; reason: string; intact: boolean; days: PublishedDay[]; closing: Omit<RunningFingerprint, "final"> | null }>;
  proves: string;
  scheme: Record<string, string>;
  operator?: { archives: Array<{ archivedTo: string | null }>; mismatches: unknown[]; fullCheckAt: string | null };
}

const withoutStamp = (days: PublishedDay[]) => days.map(({ publishedAt: _p, ...d }) => d);
/** the card on the record page, from its heading to the footer */
const cardOf = (page: string): string => {
  const from = page.indexOf("<h2>Ledger fingerprint</h2>");
  assert.ok(from > 0, "the page carries the fingerprint card");
  return page.slice(from, page.indexOf("<footer>", from));
};

test("shadow worker: daily ledger fingerprints on the record page, the public list, /healthz and the operator views", async () => {
  // the alert path: a webhook on this machine, set before the worker reads its env
  const hooks: Array<{ kind: string; message: string }> = [];
  const hookServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hooks.push(JSON.parse(body) as { kind: string; message: string });
      res.writeHead(200);
      res.end("{}");
    });
  });
  await new Promise<void>((r) => hookServer.listen(0, "127.0.0.1", () => r()));
  const waitForHook = async (kind: string, count = 1): Promise<Array<{ kind: string; message: string }>> => {
    for (let i = 0; i < 200; i += 1) {
      const got = hooks.filter((h) => h.kind === kind);
      if (got.length >= count) return got;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no ${kind} alert arrived`);
  };

  const dir = mkdtempSync(join(tmpdir(), "shadow-fingerprint-"));
  const path = join(dir, "ledger.jsonl");
  const recordPath = join(dir, "ledger.fingerprints.jsonl");
  process.env.NODE_ENV = "test";
  process.env.EVENT_SHADOW_LEDGER_PATH = path;
  process.env.EVENT_LASTLEG_LEDGER_PATH = join(dir, "lastleg-ledger.jsonl");
  process.env.EVENT_X_ADMIN_TOKEN = "op-secret";
  process.env.EVENT_SHADOW_ALERT_WEBHOOK_URL = `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}/hook`;
  delete process.env.EVENT_SHADOW_FINGERPRINTS;
  const { server } = await import("../scripts/eventShadowWorker");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const op = { headers: { "x-admin-token": "op-secret" } };
  const list = async (query = "", init?: RequestInit): Promise<ListBody> => (await (await fetch(`${base}/api/shadow/fingerprints${query}`, init)).json()) as ListBody;
  const page = async (): Promise<string> => (await fetch(`${base}/`)).text();
  const PUBLIC_HEALTH_KEYS = ["lastScanAt", "lastSettleAt", "ok", "positions", "service"];

  try {
    // ── an empty ledger: the section says so, the list is empty, nothing is written ──────────
    let body = await list();
    assert.equal(body.ok, true);
    assert.equal(body.ledger, "record");
    assert.deepEqual({ state: body.state, chain: body.chain, latest: body.latest, days: body.days, open: body.open, restarts: body.restarts }, { state: "ok", chain: 1, latest: null, days: [], open: null, restarts: [] });
    assert.match(cardOf(await page()), /No day of the ledger has closed yet\. Its first fingerprint is published when the first line of a later day is written\./);
    assert.ok(!existsSync(recordPath));

    // ── three days of lines: two closed, the third open ───────────────────────────────────────
    appendShadowRecord(path, OPEN);
    appendShadowRecord(path, { ...OPEN, at: "2026-09-12T18:00:00.000Z", ticker: "KXNFLGAME-TEST-BUF", sideName: "Buffalo Bills", eventTitle: "Buffalo wins" });
    appendShadowRecord(path, { type: "settle", at: "2026-09-13T04:00:00.000Z", ticker: OPEN.ticker, result: "no" });
    appendShadowRecord(path, { ...OPEN, at: "2026-09-14T10:00:00.000Z", ticker: "KXNFLGAME-TEST-DAL", sideName: "Dallas Cowboys", eventTitle: "Dallas wins" });
    const original = readFileSync(path);
    const expected = fingerprintLedger(original);
    body = await list();
    assert.equal(body.state, "ok");
    assert.deepEqual(body.days.map((d) => d.day), ["2026-09-12", "2026-09-13"]);
    assert.deepEqual(withoutStamp(body.days), expected.days, "what the route lists is what the file hashes to");
    assert.deepEqual(Object.keys(body.days[0]).sort(), ["bytes", "day", "ledgerSha256", "lines", "previous", "publishedAt", "sha256"]);
    assert.ok(body.days.every((d) => /^\d{4}-\d{2}-\d{2}T/.test(d.publishedAt)));
    assert.deepEqual(body.latest, body.days[1]);
    assert.deepEqual(body.open, expected.open);
    assert.equal(body.open?.final, false);
    assert.equal(body.open?.day, "2026-09-14");
    assert.ok(body.scheme.sha256 && body.scheme.day && body.scheme.ledgerSha256 && body.scheme.line);
    assert.match(body.proves, /does not show that a line was true when it was written/);
    assert.ok(!("operator" in body), "the public body carries no operator block");
    assert.ok(!JSON.stringify(body).includes(dir), "no path on disk in the public list");
    const published = body.days;

    // recorded once beside the ledger; asking again writes nothing
    assert.deepEqual(readdirSync(dir).sort(), ["ledger.fingerprints.jsonl", "ledger.jsonl"]);
    const recordFile = readFileSync(recordPath, "utf8");
    assert.equal(recordFile.trimEnd().split("\n").length, 2);
    await list();
    await page();
    assert.equal(readFileSync(recordPath, "utf8"), recordFile);
    assert.deepEqual(readFileSync(path), original, "the ledger is only read");

    // ── the record page: the latest closed day, what it covers, what it means, what it shows ──
    let card = cardOf(await page());
    const latest = published[1];
    assert.ok(card.includes(`<span>last closed day</span><b>${latest.day} UTC</b>`));
    assert.ok(card.includes(`<b>${latest.lines.toLocaleString("en-US")} lines · ${latest.bytes.toLocaleString("en-US")} bytes</b>`));
    assert.ok(card.includes(`<div class="fp">sha256 ${latest.sha256}</div>`));
    assert.ok(card.includes("This is a SHA-256 over every byte of the ledger up to the last line of that day, chained to the day before, so changing or removing any earlier line changes it and every later one; to check it, save it today and compare it later, or recompute it from a copy of the ledger."));
    assert.ok(card.includes(`It shows that the history has not been changed since each fingerprint was first published (this one on ${latest.publishedAt.slice(0, 10)}, the first on ${published[0].publishedAt.slice(0, 10)}, so anything older is fixed only as of that day); it does not show that a line was true when it was written; and the full check needs the raw ledger, which carries private details, so it can be run by us and by anyone we give a copy to.`));
    assert.ok(card.includes('<a class="back" href="/api/shadow/fingerprints">'));
    assert.ok(!card.includes("no longer matches") && !card.includes("restarted"));
    // small, plain, and inside the house rules
    assert.ok(card.length < 2500, `the section stays small (${card.length} characters)`);
    assert.ok(!/[\u2013\u2014]/.test(card), "no en dash or em dash");
    assert.ok(!/wallet|guarantee|protect|holder|operator|kalshi|polymarket|prophetx|novig/i.test(card));
    assert.ok(!card.includes(body.open!.sha256), "the open day's running fingerprint is not printed as if it were final");

    // ── /healthz: the public body is unchanged while all is well; the operator's carries the state ─
    assert.deepEqual(Object.keys((await (await fetch(`${base}/healthz`)).json()) as Record<string, unknown>).sort(), PUBLIC_HEALTH_KEYS);
    type OpHealth = { ledgerFingerprints: { on: boolean; mismatches: number; checkEveryMs: number; record: { state: string; publishedDays: number; file: string; latest: PublishedDay | null; mismatch?: { day: string } }; locks: Array<{ holder: string; state: string; publishedDays: number; latest: PublishedDay | null }> } };
    let health = (await (await fetch(`${base}/healthz`, op)).json()) as OpHealth;
    assert.equal(health.ledgerFingerprints.on, true);
    assert.equal(health.ledgerFingerprints.checkEveryMs, 86_400_000);
    assert.equal(health.ledgerFingerprints.mismatches, 0);
    assert.equal(health.ledgerFingerprints.record.state, "ok");
    assert.equal(health.ledgerFingerprints.record.publishedDays, 2);
    assert.equal(health.ledgerFingerprints.record.file, recordPath);
    assert.deepEqual(health.ledgerFingerprints.record.latest, latest);
    assert.deepEqual(health.ledgerFingerprints.locks.map((l) => [l.holder, l.state, l.publishedDays]), [["(shared)", "ok", 0]]);

    // ── the lock ledgers: the same fingerprints, for the operator only ────────────────────────
    const annPath = join(dir, "lock-ledger-ann.jsonl");
    appendShadowRecord(annPath, { ...OPEN, at: "2026-10-15T20:00:00.000Z", ticker: "KXNFLGAME-TEST-IND", sideName: "Indianapolis Colts", eventTitle: "Indianapolis wins" });
    appendShadowRecord(annPath, { ...OPEN, at: "2026-10-16T20:00:00.000Z", ticker: "KXNFLGAME-TEST-DEN", sideName: "Denver Broncos", eventTitle: "Denver wins" });
    const annExpected = fingerprintLedger(readFileSync(annPath));
    assert.equal((await fetch(`${base}/api/shadow/fingerprints?ledger=lock`)).status, 403, "a lock ledger's list needs the operator token");
    assert.equal((await fetch(`${base}/api/shadow/fingerprints?ledger=lock&holder=ann&token=wrong`)).status, 403);
    assert.equal((await fetch(`${base}/api/shadow/fingerprints?ledger=other`)).status, 400);
    assert.equal((await fetch(`${base}/api/shadow/fingerprints?ledger=lock&holder=bob`, op)).status, 404, "no ledger for a holder who never locked");
    assert.equal((await fetch(`${base}/api/shadow/fingerprints?ledger=lock&holder=Not%20An%20Alias`, op)).status, 400);
    const shared = await list("?ledger=lock", op);
    assert.equal(shared.ledger, "lock");
    assert.deepEqual(shared.days, []);
    const ann = await list("?ledger=lock&holder=ann", op);
    assert.equal(ann.ledger, "lock:ann");
    assert.deepEqual(withoutStamp(ann.days), annExpected.days);
    assert.equal(ann.days.length, 1);
    assert.ok(ann.operator, "the operator's body says more");
    assert.ok(existsSync(join(dir, "lock-ledger-ann.fingerprints.jsonl")), "recorded beside its own ledger");
    health = (await (await fetch(`${base}/healthz`, op)).json()) as OpHealth;
    assert.deepEqual(health.ledgerFingerprints.locks.map((l) => [l.holder, l.state, l.publishedDays]), [
      ["(shared)", "ok", 0],
      ["ann", "ok", 1],
    ]);
    const holdersPage = await (await fetch(`${base}/holders?token=op-secret`)).text();
    assert.ok(holdersPage.includes("<h2>Lock ledger fingerprints</h2>"));
    assert.ok(holdersPage.includes(ann.days[0].sha256) && holdersPage.includes('href="/api/shadow/fingerprints?as=operator&amp;ledger=lock&holder=ann"'));
    assert.ok(!holdersPage.includes("op-secret"), "the page carries no token on a link");
    // nothing of a lock ledger on the public page, the public list or the public health body
    const publicText = (await page()) + JSON.stringify(await list()) + (await (await fetch(`${base}/healthz`)).text());
    assert.ok(!publicText.includes(ann.days[0].sha256) && !publicText.includes("lock-ledger") && !/\bann\b/.test(publicText));
    // the record's own fingerprints were not disturbed by a lock joining the page
    assert.deepEqual((await list()).days, published);

    // ── a line of a closed day is changed after it was published ──────────────────────────────
    const tampered = Buffer.from(original);
    tampered.write("Kansas City Chieft", tampered.indexOf("Kansas City Chiefs"));
    assert.equal(tampered.length, original.length);
    writeFileSync(path, tampered);
    // the public may not make the service hash the whole file: ?recheck=1 is the operator's
    body = await list("?recheck=1");
    assert.equal(body.state, "ok", "an edit in place is found by the full check, and only the operator can ask for one early");
    assert.equal(hooks.length, 0);
    body = await list("?recheck=1", op);
    assert.equal(body.state, "mismatch");
    assert.equal(body.mismatch?.day, "2026-09-12");
    assert.equal(body.mismatch?.published.sha256, published[0].sha256);
    assert.equal(body.mismatch?.found?.sha256, fingerprintLedger(tampered).days[0].sha256);
    assert.deepEqual(body.days, published, "the published fingerprints are kept as they were");

    // loud, three ways: the alert path, the page, /healthz
    const [alert] = await waitForHook("ledger_fingerprint_mismatch");
    assert.match(alert.message, /^the record's ledger no longer hashes to the fingerprint published for 2026-09-12 \(published [0-9a-f]{12}, the file now gives [0-9a-f]{12} for 2026-09-12\)\. /);
    assert.match(alert.message, /Nothing was repaired and no new day is published until it matches again\./);
    assert.match(alert.message, /eventLedgerFingerprint\.ts <backup\.jsonl> --expect https?:\/\/\S+\/api\/shadow\/fingerprints$/);
    assert.ok(!/[\u2013\u2014]/.test(alert.message));
    card = cardOf(await page());
    assert.ok(card.includes(`<div class="read fpbad">${mismatchWords("2026-09-12")}</div>`), "said on the public page as a plain sentence");
    assert.ok(card.includes("The ledger no longer matches the fingerprint published for 2026-09-12."));
    assert.ok(card.includes(`<div class="fp">sha256 ${latest.sha256}</div>`), "still printing what was published, not what the changed file gives");
    const sick = (await (await fetch(`${base}/healthz`)).json()) as { ok: boolean; ledgerFingerprint?: { ok: boolean; day: string; message: string } };
    assert.equal(sick.ok, true, "the service is up; the fingerprint is what is wrong");
    assert.deepEqual(sick.ledgerFingerprint, { ok: false, day: "2026-09-12", message: mismatchWords("2026-09-12") });
    health = (await (await fetch(`${base}/healthz`, op)).json()) as OpHealth;
    assert.equal(health.ledgerFingerprints.mismatches, 1);
    assert.equal(health.ledgerFingerprints.record.state, "mismatch");
    assert.equal(health.ledgerFingerprints.record.mismatch?.day, "2026-09-12");

    // never repaired: the record gained one mismatch line and nothing else moved, however often it is read
    await list();
    await page();
    let after = readFileSync(recordPath, "utf8");
    assert.ok(after.startsWith(recordFile), "the record is appended to, never rewritten");
    assert.deepEqual(after.slice(recordFile.length).trimEnd().split("\n").map((l) => (JSON.parse(l) as { type: string }).type), ["mismatch"]);
    // the ledger grows and closes another day: nothing is published on top of a broken chain
    appendShadowRecord(path, { type: "settle", at: "2026-09-15T04:00:00.000Z", ticker: "KXNFLGAME-TEST-BUF", result: "yes" });
    body = await list();
    assert.equal(body.state, "mismatch");
    assert.deepEqual(body.days, published);
    assert.equal(body.open?.day, "2026-09-15");
    assert.equal(readFileSync(recordPath, "utf8"), after);
    // a second full check says it again and writes nothing new
    await list("?recheck=1", op);
    await waitForHook("ledger_fingerprint_mismatch", 2);
    assert.equal(readFileSync(recordPath, "utf8"), after);

    // ── the published bytes are put back: it matches again, and that is on the record too ─────
    const settleLine = readFileSync(path).subarray(original.length);
    writeFileSync(path, Buffer.concat([original, settleLine]));
    body = await list("?recheck=1", op);
    assert.equal(body.state, "ok");
    assert.equal(body.mismatch, undefined);
    assert.deepEqual(body.days.map((d) => d.day), ["2026-09-12", "2026-09-13", "2026-09-14"]);
    assert.deepEqual(body.days.slice(0, 2), published);
    assert.equal(body.operator?.mismatches.length, 1, "the mismatch stays on the operator's list");
    const [back] = await waitForHook("ledger_fingerprint_restored");
    assert.match(back.message, /^the record's ledger hashes to every published fingerprint again\./);
    assert.deepEqual(Object.keys((await (await fetch(`${base}/healthz`)).json()) as Record<string, unknown>).sort(), PUBLIC_HEALTH_KEYS);
    assert.ok(!cardOf(await page()).includes("no longer matches"));
    after = readFileSync(recordPath, "utf8");
    assert.ok(after.startsWith(recordFile));
    const threeDays = body.days;
    const openBeforeReset = body.open!;

    // ── the check script against the live route, with the operator's export ───────────────────
    const exported = join(dir, "export-copy.jsonl");
    const exportRes = await fetch(`${base}/api/shadow/export`, op);
    writeFileSync(exported, Buffer.from(await exportRes.arrayBuffer()));
    const out: string[] = [];
    assert.equal(await runLedgerFingerprint([exported, "--expect", `${base}/api/shadow/fingerprints`], (l) => out.push(l)), EXIT_MATCH);
    assert.equal(out[out.length - 1], "MATCH: all 3 published days, 2026-09-12 to 2026-09-14.");
    const badCopy = join(dir, "export-edited.jsonl");
    writeFileSync(badCopy, readFileSync(exported, "utf8").replace('"result":"no"', '"result":"ye"'));
    const badOut: string[] = [];
    assert.equal(await runLedgerFingerprint([badCopy, "--expect", `${base}/api/shadow/fingerprints`], (l) => badOut.push(l)), EXIT_DIFFERS);
    assert.equal(badOut[badOut.length - 1], "DIFFERS at 2026-09-13: this file is not the history that was published for that day.");

    // ── archive and reset: the chain ends on the record, the old days stay listed ─────────────
    const hooksBefore = hooks.length;
    const reset = (await (await fetch(`${base}/api/shadow/reset`, { method: "POST", ...op })).json()) as { ok: boolean; at: string; archived: Array<{ from: string; to: string }> };
    assert.equal(reset.ok, true);
    const archivedTo = reset.archived.find((a) => a.from === path)?.to;
    assert.ok(archivedTo && existsSync(archivedTo) && !existsSync(path));
    body = await list("", op);
    assert.equal(body.state, "ok", "a reset through the operator's route is not a mismatch");
    assert.equal(body.chain, 2);
    assert.deepEqual(body.days, []);
    assert.equal(body.latest, null);
    assert.equal(body.open, null);
    assert.equal(body.restarts.length, 1);
    const { final: _final, ...closing } = openBeforeReset;
    assert.deepEqual(body.restarts[0], { chain: 1, restartedAt: reset.at, reason: "the ledger was archived whole and a new one started", intact: true, days: threeDays, closing });
    assert.equal(body.operator?.archives[0].archivedTo, archivedTo.slice(dir.length + 1));
    assert.ok(!JSON.stringify(await list()).includes("archived.jsonl"), "the archive's file name is the operator's");
    card = cardOf(await page());
    assert.ok(
      card.includes(`The record was restarted on ${reset.at.slice(0, 10)}: the earlier ledger was archived whole, not deleted, and the 3 daily fingerprints published for it stay on the list. No day of the new ledger has closed yet. Its first fingerprint is published when the first line of a later day is written.`),
      "what the page shows after a reset",
    );
    assert.ok(!/[\u2013\u2014]/.test(card) && !card.includes("no longer matches"));
    assert.ok(readFileSync(recordPath, "utf8").startsWith(after));
    assert.equal(hooks.length, hooksBefore, "no alarm for a reset");

    // the archived ledger still checks out against the chain it belonged to, to its last byte
    const archivedOut: string[] = [];
    assert.equal(await runLedgerFingerprint([archivedTo, "--expect", `${base}/api/shadow/fingerprints`, "--chain", "1"], (l) => archivedOut.push(l)), EXIT_MATCH);
    assert.equal(archivedOut[archivedOut.length - 1], "MATCH: all 3 published days, 2026-09-12 to 2026-09-14, and the whole file as it stood when it was archived.");

    // the new ledger is a new chain; once a day of it closes the page prints it and still says it was restarted
    appendShadowRecord(path, { ...OPEN, at: "2026-11-11T16:00:00.000Z", ticker: "KXNFLGAME-TEST-SEA", sideName: "Seattle Seahawks", eventTitle: "Seattle wins" });
    appendShadowRecord(path, { ...OPEN, at: "2026-11-12T16:00:00.000Z", ticker: "KXNFLGAME-TEST-MIA", sideName: "Miami Dolphins", eventTitle: "Miami wins" });
    body = await list();
    assert.equal(body.chain, 2);
    assert.deepEqual(withoutStamp(body.days), fingerprintLedger(readFileSync(path)).days);
    assert.equal(body.days[0].previous, "0".repeat(64), "a new chain starts from its own first byte");
    assert.deepEqual(body.restarts[0].days, threeDays);
    card = cardOf(await page());
    assert.ok(card.includes(`<div class="fp">sha256 ${body.days[0].sha256}</div>`));
    assert.ok(card.includes(`The record was restarted on ${reset.at.slice(0, 10)}: the earlier ledger was archived whole, not deleted, and the 3 daily fingerprints published for it stay on the list.`));

    // ── a lock reset moves lines out of a holder's ledger: its chain ends the same way ────────
    const lockReset = await fetch(`${base}/api/shadow/lock/reset?ticker=KXNFLGAME-TEST-IND&holder=ann`, { method: "POST", ...op });
    assert.equal(lockReset.status, 200);
    const annAfter = await list("?ledger=lock&holder=ann", op);
    assert.equal(annAfter.state, "ok", "a lock reset is not a mismatch");
    assert.equal(annAfter.chain, 2);
    assert.deepEqual(annAfter.restarts[0].days, ann.days);
    assert.equal(annAfter.restarts[0].reason, "lock reset: the lines of KXNFLGAME-TEST-IND were moved to an archive beside the ledger");
    assert.match(annAfter.operator?.archives[0].archivedTo ?? "", /^lock-ledger-ann\.\d{4}-\d{2}-\d{2}T\d{6}Z\.KXNFLGAME-TEST-IND\.archived\.jsonl$/);
    assert.ok(existsSync(join(dir, annAfter.operator?.archives[0].archivedTo ?? "missing")), "the archive is where the record says it is");
    assert.deepEqual(withoutStamp(annAfter.days), fingerprintLedger(readFileSync(annPath)).days);
    assert.equal(hooks.length, hooksBefore);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => hookServer.close(() => r()));
  }
});
