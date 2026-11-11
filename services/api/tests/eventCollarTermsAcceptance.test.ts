/**
 * The user terms (crossVenue/termsAcceptance.ts) on the worker's lock path.
 *
 *   - no version in force: nothing asks anyone; every lock is what it was
 *   - a version in force: a named holder with no acceptance of it is refused at the quote and at
 *     the tap, in plain words with the link, and nothing is written; the shared key and the
 *     operator acting for nobody are not asked
 *   - an acceptance is the holder's own tap for the version in force (one line, once), or the
 *     operator's line for a holder who accepted another way, which has to say how
 *   - a new version asks again; the older lines stay and stop counting
 *   - settings that cannot be read refuse every named holder and let nobody accept
 *   - reading one's own record and leaving a lock are never behind the terms
 *
 * The engine is faked and the service is on its paper strategy; nothing touches a venue.
 */

import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EarlyCloseBooks } from "../src/eventCollar/crossVenue/earlyClose";
import { quoteLadderWrap, type NoAskLevel } from "../src/eventCollar/crossVenue/kalshiLadder";
import type { PilotReport } from "../src/eventCollar/crossVenue/pilotCheck";
import { loadShadowPositions } from "../src/eventCollar/crossVenue/shadowLedger";
import {
  acceptanceOf,
  loadTermsAcceptances,
  parseAcceptRequest,
  termsInForceFromEnv,
  termsOnRecordFor,
  termsRefusalMessage,
  termsStanding,
  type TermsAcceptance,
  type TermsInForce,
} from "../src/eventCollar/crossVenue/termsAcceptance";
import { DEFAULT_CROSS_CONFIG, type CrossQuoteResult } from "../src/eventCollar/crossVenue/types";
import type { CandidateResult, GameMarketRow, OneQuoteInputs, OneQuoteResult } from "../scripts/eventProtectXDemoService";

const BOS = "KXNBAGAME-26OCT14LALBOS-BOS";
const NYK = "KXNBAGAME-26OCT15NYKMIA-NYK";
const TITLES: Record<string, [string, string]> = { [BOS]: ["Boston Celtics", "Lakers at Celtics"], [NYK]: ["New York Knicks", "Knicks at Heat"] };
const START = new Date(Date.now() + 3 * 3_600_000).toISOString();
const NO_ASKS: NoAskLevel[] = [
  { priceCents: 41, qtyMilli: 300_000 },
  { priceCents: 42, qtyMilli: 400_000 },
];
const TOKEN = "op-secret-0123456789";
const SHARED_KEY = "lock-key-0123456789";
const ALICE_KEY = "alice-key-0123456789";
const BOB_KEY = "bob-key-0123456789ab";
const URL_V1 = "https://atticustrade.example/terms/2026-11-20";
const V1: TermsInForce = { required: true, terms: { version: "2026-11-20", url: URL_V1 }, notes: [] };
const V2: TermsInForce = { required: true, terms: { version: "2026-12-05", url: "https://atticustrade.example/terms/2026-12-05" }, notes: [] };
const NONE: TermsInForce = { required: false, terms: null, notes: [] };
const NOT_ACCEPTED = "Read and accept the terms to lock in.";
const BEING_UPDATED = "Lock in is not open right now: the terms are being updated.";

function candidate(ticker: string, contracts: number, entryCents: number): CandidateResult {
  const quote = quoteLadderWrap({ pair: { kalshi: { ticker }, gameStartTime: START }, markCents: 60, entryCents, contracts, now: new Date(), noAsks: NO_ASKS, config: DEFAULT_CROSS_CONFIG }) as Extract<CrossQuoteResult, { ok: true }>;
  assert.ok(quote.ok, JSON.stringify(quote));
  const [sideName, eventTitle] = TITLES[ticker];
  return {
    kind: "sports",
    league: "nba",
    market: { ticker, eventTicker: ticker.slice(0, ticker.lastIndexOf("-")), title: `${eventTitle} Winner?`, subtitle: sideName, strike: 0, strikeType: "", status: "active", openTime: "", closeTime: START, yesBidCents: 59, yesAskCents: 61, lastPriceCents: 60, volume: 0, openInterest: 0 },
    pair: null,
    sideName,
    eventTitle,
    eventTimeIso: START,
    parityNote: "",
    fingerprint: `test:${ticker}`,
    markCents: 60,
    position: { contracts, entryCents, entrySource: "entered_now", entryTime: null },
    quote,
    route: "kalshi_self",
    evBps: quote.evCostBps,
    routesChecked: [],
    books: { noAsks: NO_ASKS },
  } as unknown as CandidateResult;
}

type Answer = { status: number; body: Record<string, unknown> };
let dir: string;
let base: string;
let worker: typeof import("../scripts/eventShadowWorker");
const CLOSE_BOOKS: EarlyCloseBooks = { kalshi: { yesBids: [{ priceCents: 62, qtyMilli: 1_000_000 }], noBids: [{ priceCents: 38, qtyMilli: 1_000_000 }] } };
const engine = {
  listGameMarkets: async (): Promise<GameMarketRow[]> =>
    Object.keys(TITLES).map((ticker) => ({ ticker, league: "nba", sideName: TITLES[ticker][0], title: `${TITLES[ticker][1]} Winner?`, dateIso: "2026-10-14", closeTimeIso: START, markCents: 60, startIso: START, protectable: true, protectableUntilIso: START })) as unknown as GameMarketRow[],
  quoteOne: async (inputs: OneQuoteInputs): Promise<OneQuoteResult> => ({ ok: true, result: candidate(inputs.ticker, inputs.contracts, inputs.entryCents ?? 58) }),
  closeBooks: async () => CLOSE_BOOKS,
};
const setTerms = (terms: TermsInForce): void => worker.wireLockEngine({ ...engine, terms });

const termsFile = (): string => join(dir, "terms-acceptances.jsonl");
const lines = (): TermsAcceptance[] => loadTermsAcceptances(termsFile());
const ledgerOf = (holder: string | null): string => join(dir, holder ? `lock-ledger-${holder}.jsonl` : "lock-ledger.jsonl");
const keyOf = (holder: string | null): string => (holder === "alice" ? ALICE_KEY : holder === "bob" ? BOB_KEY : SHARED_KEY);
async function call(who: string | null | { operator: string | null }, method: "GET" | "POST", path: string, body?: unknown): Promise<Answer> {
  const operator = typeof who === "object" && who !== null;
  const url = operator && who.operator ? `${base}${path}${path.includes("?") ? "&" : "?"}holder=${who.operator}` : `${base}${path}`;
  const headers: Record<string, string> = operator ? { "x-admin-token": TOKEN, "content-type": "application/json", "user-agent": "op-agent" } : { "x-lock-key": keyOf(who as string | null), "content-type": "application/json", "user-agent": "Mozilla/5.0 (test)   browser" };
  const res = await fetch(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as Answer["body"] };
}
type Who = Parameters<typeof call>[0];
const quote = (who: Who, ticker = BOS) => call(who, "GET", `/api/shadow/quote?ticker=${ticker}&contracts=20&entry=58`);
const tap = (who: Who, ticker = BOS) => call(who, "POST", "/api/shadow/lock", { ticker, contracts: 20, entryCents: 58 });
const standingOf = (who: Who) => call(who, "GET", "/api/shadow/terms");
const accept = (who: Who, body: unknown) => call(who, "POST", "/api/shadow/terms/accept", body);
const onDisk = (): string[] => readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort();
/** the refusal a holder reads: the code, the exact sentence, the link when there is one, and nothing of a quote */
const refused = (a: Answer, message: string, terms: TermsInForce["terms"], label: string): void => {
  assert.equal(a.status, 200, label);
  assert.deepEqual([a.body.ok, a.body.code, a.body.error, a.body.message], [false, "terms_not_accepted", "terms_not_accepted", message], `${label}: ${JSON.stringify(a.body)}`);
  assert.deepEqual(a.body.terms, terms ?? undefined, label);
  assert.ok(!("quote" in a.body) && !("floorCents" in a.body) && !("hedge" in a.body), `${label}: nothing priced`);
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "terms-"));
  process.env.NODE_ENV = "test";
  process.env.EVENT_SHADOW_LEDGER_PATH = join(dir, "ledger.jsonl");
  process.env.EVENT_SHADOW_LOCK_LEDGER_PATH = ledgerOf(null);
  process.env.EVENT_LASTLEG_LEDGER_PATH = join(dir, "lastleg.jsonl");
  process.env.EVENT_X_ADMIN_TOKEN = TOKEN;
  process.env.EVENT_SHADOW_LOCK_KEY = SHARED_KEY;
  process.env.EVENT_SHADOW_HOLDER_KEYS = `alice:${ALICE_KEY},bob:${BOB_KEY}`;
  // the settings as the deploy spells them: read at start
  process.env.EVENT_SHADOW_TERMS_VERSION = " 2026-11-20 ";
  process.env.EVENT_SHADOW_TERMS_URL = URL_V1;
  for (const k of Object.keys(process.env)) if (/^EVENT_HEDGE_|^EVENT_SHADOW_ALERT_|^EVENT_SHADOW_REAL_ONLY_HOLDERS$|^EVENT_SHADOW_TERMS_PATH$|^EVENT_X_DEV_NO_ADMIN$/.test(k)) delete process.env[k];
  worker = await import("../scripts/eventShadowWorker");
  worker.wireLockEngine(engine);
  await new Promise<void>((r) => worker.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((r) => worker.server.close(() => r()));
});
beforeEach(() => {
  for (const name of readdirSync(dir)) if (name.endsWith(".jsonl")) rmSync(join(dir, name));
  setTerms(V1);
});

test("the settings: both set is a version in force; neither is none; one missing or unreadable asks everyone and lets nobody accept", () => {
  assert.deepEqual(termsInForceFromEnv({}), NONE);
  assert.deepEqual(termsInForceFromEnv({ EVENT_SHADOW_TERMS_VERSION: "  ", EVENT_SHADOW_TERMS_URL: "" }), NONE);
  assert.deepEqual(termsInForceFromEnv({ EVENT_SHADOW_TERMS_VERSION: " v1.2_a-b ", EVENT_SHADOW_TERMS_URL: " https://example.com/terms.pdf " }), { required: true, terms: { version: "v1.2_a-b", url: "https://example.com/terms.pdf" }, notes: [] });

  const half = [
    { EVENT_SHADOW_TERMS_VERSION: "v1" },
    { EVENT_SHADOW_TERMS_URL: "https://example.com/terms" },
    { EVENT_SHADOW_TERMS_VERSION: "v 1", EVENT_SHADOW_TERMS_URL: "https://example.com/terms" },
    { EVENT_SHADOW_TERMS_VERSION: "x".repeat(41), EVENT_SHADOW_TERMS_URL: "https://example.com/terms" },
    { EVENT_SHADOW_TERMS_VERSION: "v1", EVENT_SHADOW_TERMS_URL: "http://example.com/terms" },
    { EVENT_SHADOW_TERMS_VERSION: "v1", EVENT_SHADOW_TERMS_URL: "javascript:alert(1)" },
    { EVENT_SHADOW_TERMS_VERSION: "v1", EVENT_SHADOW_TERMS_URL: "https://user:pass@example.com/terms" },
    { EVENT_SHADOW_TERMS_VERSION: "v1", EVENT_SHADOW_TERMS_URL: "not an address" },
  ];
  for (const env of half) {
    const t = termsInForceFromEnv(env);
    assert.deepEqual([t.required, t.terms], [true, null], JSON.stringify(env));
    assert.ok(t.notes.length >= 1 && t.notes.every((n) => /no holder can accept until/.test(n)), JSON.stringify(t.notes));
    // a note names the setting and never repeats a value that could carry a login
    assert.equal(/pass|alert/.test(t.notes.join(" ")), false);
  }

  // where a caller stands
  const rec = (holder: string, version: string, by: "holder" | "operator" = "holder"): TermsAcceptance => ({ type: "terms_accepted", at: "2026-11-21T00:00:00.000Z", holder, version, url: URL_V1, by });
  assert.deepEqual(termsStanding(NONE, [], "alice"), { asked: false });
  assert.deepEqual(termsStanding(V1, [], null), { asked: false }, "the shared key and the operator acting for nobody are not asked");
  assert.deepEqual(termsStanding(V1, [], "alice"), { asked: true, accepted: false, terms: V1.terms });
  assert.deepEqual(termsStanding(V1, [rec("bob", "2026-11-20")], "alice"), { asked: true, accepted: false, terms: V1.terms }, "another holder's acceptance is not this one's");
  assert.deepEqual(termsStanding(V1, [rec("alice", "2026-10-01")], "alice"), { asked: true, accepted: false, terms: V1.terms }, "an older version does not count");
  assert.deepEqual(termsStanding(V1, [rec("alice", "2026-11-20", "operator")], "alice"), { asked: true, accepted: true, version: "2026-11-20", url: URL_V1, at: "2026-11-21T00:00:00.000Z", by: "operator" });
  assert.deepEqual(termsStanding({ required: true, terms: null, notes: ["x"] }, [rec("alice", "2026-11-20")], "alice"), { asked: true, accepted: false, terms: null }, "unreadable settings: nothing on the file counts");
  assert.equal(acceptanceOf([rec("alice", "2026-11-20"), { ...rec("alice", "2026-11-20"), at: "later" }], "alice", "2026-11-20")?.at, "2026-11-21T00:00:00.000Z", "the first line is the acceptance");
  assert.deepEqual([termsRefusalMessage(V1.terms), termsRefusalMessage(null)], [NOT_ACCEPTED, BEING_UPDATED]);

  // the body of an acceptance
  assert.deepEqual(parseAcceptRequest({ version: "2026-11-20" }, V1, "holder"), { ok: true, version: "2026-11-20", how: null });
  assert.deepEqual(parseAcceptRequest({ version: "2026-11-20", how: "ignored from a holder" }, V1, "holder"), { ok: true, version: "2026-11-20", how: null });
  for (const body of [{}, null, "2026-11-20", { version: "2026-12-05" }, { version: 20261120 }, { version: "" }]) assert.equal(parseAcceptRequest(body, V1, "holder").ok, false, JSON.stringify(body));
  assert.equal(parseAcceptRequest({ version: "2026-11-20" }, V1, "operator").ok, false, "the operator has to say how");
  assert.equal(parseAcceptRequest({ version: "2026-11-20", how: "ok" }, V1, "operator").ok, false, "in a sentence");
  assert.deepEqual(parseAcceptRequest({ version: "2026-11-20", how: "  signed copy   received by email\n2026-11-21 " }, V1, "operator"), { ok: true, version: "2026-11-20", how: "signed copy received by email 2026-11-21" });
  assert.equal(parseAcceptRequest({ version: "2026-11-20" }, NONE, "holder").ok, false);
  assert.equal(parseAcceptRequest({ version: "2026-11-20" }, { required: true, terms: null, notes: [] }, "holder").ok, false);

  // the pilot check's fact
  assert.equal(termsOnRecordFor(NONE, [], ["alice", "bob"]), null);
  assert.deepEqual(termsOnRecordFor(V1, [rec("alice", "2026-11-20"), rec("bob", "2026-10-01"), rec("zed", "2026-11-20")], ["alice", "bob"]), { version: "2026-11-20", holders: 1, missing: ["bob"], notes: [] });
  assert.deepEqual(termsOnRecordFor({ required: true, terms: null, notes: ["n"] }, [rec("alice", "2026-11-20")], ["alice", "bob"]), { version: null, holders: 0, missing: ["alice", "bob"], notes: ["n"] });
});

test("no version in force: nobody is asked, every lock is what it was, and there is nothing to accept", async () => {
  setTerms(NONE);
  const s = await standingOf("alice");
  assert.deepEqual([s.body.ok, s.body.holder, s.body.required, s.body.asked, "version" in s.body, "accepted" in s.body], [true, "alice", false, false, false, false]);
  assert.equal((await quote("alice")).body.ok, true);
  assert.equal((await tap("alice")).body.ok, true);
  assert.equal(loadShadowPositions(ledgerOf("alice")).length, 1);
  const a = await accept("alice", { version: "2026-11-20" });
  assert.deepEqual([a.status, a.body.ok, a.body.message], [409, false, "no terms are in force on this service"]);
  assert.equal(existsSync(termsFile()), false);
});

test("a version in force: a named holder who has not accepted is refused at the quote and at the tap and nothing is written; the shared key and the operator acting for nobody are not asked", async () => {
  // read at start from the env, spaces trimmed
  const s = await standingOf("alice");
  assert.deepEqual([s.body.required, s.body.asked, s.body.accepted, s.body.version, s.body.url, "acceptedAt" in s.body], [true, true, false, "2026-11-20", URL_V1, false]);

  refused(await quote("alice"), NOT_ACCEPTED, V1.terms, "alice's quote");
  refused(await tap("alice"), NOT_ACCEPTED, V1.terms, "alice's tap");
  refused(await quote({ operator: "alice" }), NOT_ACCEPTED, V1.terms, "the operator acting for alice");
  refused(await tap({ operator: "alice" }), NOT_ACCEPTED, V1.terms, "the operator's tap for alice");
  assert.deepEqual(onDisk(), [], "no lock, no receipt, no trail, no acceptance");
  // no dash and no venue in what the holder reads
  assert.equal(/[\u2013\u2014]|kalshi|polymarket/i.test(NOT_ACCEPTED + BEING_UPDATED), false);

  // the operator's own demonstration is not asked
  const shared = await standingOf(null);
  assert.deepEqual([shared.body.required, shared.body.asked, "accepted" in shared.body, "holder" in shared.body], [true, false, false, false]);
  assert.equal((await quote(null)).body.ok, true);
  assert.equal((await tap(null)).body.ok, true);
  assert.equal((await tap({ operator: null }, NYK)).body.ok, true);
  assert.equal(loadShadowPositions(ledgerOf(null)).length, 2);
  assert.equal(existsSync(ledgerOf("alice")), false);

  // the status page counts the refusals and names who has not accepted; the public view carries none of it
  const health = (await (await fetch(`${base}/healthz?token=${TOKEN}`)).json()) as { lock: { terms: { required: boolean; version: string; url: string; accepted: number; notAccepted: string[]; refusals: number; file: { path: string } } } };
  assert.deepEqual([health.lock.terms.required, health.lock.terms.version, health.lock.terms.url, health.lock.terms.accepted, health.lock.terms.notAccepted], [true, "2026-11-20", URL_V1, 0, ["alice", "bob"]]);
  assert.ok(health.lock.terms.refusals >= 4);
  assert.equal(health.lock.terms.file.path, termsFile());
  assert.equal(JSON.stringify(await (await fetch(`${base}/healthz`)).json()).includes("terms"), false);
});

test("accepting: the holder's own tap for the version shown writes one line, once; then the quote and the lock are what they were", async () => {
  // a version the holder was not shown is not accepted
  for (const body of [{ version: "2026-12-05" }, {}, { version: "" }]) {
    const bad = await accept("alice", body);
    assert.deepEqual([bad.status, bad.body.ok, bad.body.message], [400, false, "version has to be the one in force, 2026-11-20"], JSON.stringify(body));
  }
  assert.equal((await call("alice", "GET", "/api/shadow/terms/accept")).status, 405);
  assert.equal(existsSync(termsFile()), false);

  const a = await accept("alice", { version: "2026-11-20", how: "a holder cannot write this" });
  assert.deepEqual([a.status, a.body.ok, a.body.holder, a.body.already, a.body.version, a.body.url, a.body.by], [200, true, "alice", false, "2026-11-20", URL_V1, "holder"]);
  const [line] = lines();
  assert.deepEqual(line, { type: "terms_accepted", at: a.body.acceptedAt, holder: "alice", version: "2026-11-20", url: URL_V1, by: "holder", userAgent: "Mozilla/5.0 (test) browser" });
  assert.ok(Math.abs(Date.parse(line.at) - Date.now()) < 60_000);
  // the file holds no key
  assert.equal(readFileSync(termsFile(), "utf8").includes(ALICE_KEY), false);

  // a second tap is the first one's answer and no second line
  const again = await accept("alice", { version: "2026-11-20" });
  assert.deepEqual([again.body.ok, again.body.already, again.body.acceptedAt, again.body.by], [true, true, line.at, "holder"]);
  assert.equal(lines().length, 1);

  const s = await standingOf("alice");
  assert.deepEqual([s.body.asked, s.body.accepted, s.body.acceptedAt, s.body.by], [true, true, line.at, "holder"]);
  assert.equal((await quote("alice")).body.ok, true);
  const locked = await tap("alice");
  assert.equal(locked.body.ok, true, JSON.stringify(locked.body));
  assert.equal(loadShadowPositions(ledgerOf("alice")).length, 1);

  // alice's acceptance is alice's: bob is still asked
  refused(await quote("bob"), NOT_ACCEPTED, V1.terms, "bob");
});

test("the operator can record an acceptance received another way, for a named holder, and has to say how; nobody accepts for nobody", async () => {
  const noHow = await accept({ operator: "bob" }, { version: "2026-11-20" });
  assert.deepEqual([noHow.status, noHow.body.ok], [400, false]);
  assert.match(String(noHow.body.message), /^how is required: one sentence saying what was received from the holder and when/);
  const nobody = await accept({ operator: null }, { version: "2026-11-20", how: "signed copy received by email 2026-11-21" });
  assert.deepEqual([nobody.status, nobody.body.error], [400, "no_holder"]);
  const sharedKey = await accept(null, { version: "2026-11-20" });
  assert.deepEqual([sharedKey.status, sharedKey.body.error], [400, "no_holder"]);
  assert.equal(existsSync(termsFile()), false);

  const done = await accept({ operator: "bob" }, { version: "2026-11-20", how: "signed copy received by email 2026-11-21" });
  assert.deepEqual([done.status, done.body.ok, done.body.holder, done.body.by, done.body.already], [200, true, "bob", "operator", false]);
  assert.deepEqual(lines(), [{ type: "terms_accepted", at: done.body.acceptedAt, holder: "bob", version: "2026-11-20", url: URL_V1, by: "operator", how: "signed copy received by email 2026-11-21" }]);
  assert.equal(readFileSync(termsFile(), "utf8").includes(TOKEN), false);
  // bob himself now reads it as accepted, and says by whom
  const s = await standingOf("bob");
  assert.deepEqual([s.body.accepted, s.body.by], [true, "operator"]);
  assert.equal((await tap("bob")).body.ok, true);

  // a caller with no key and no token reaches none of it
  for (const path of ["/api/shadow/terms", "/api/shadow/terms/accept"]) assert.equal((await fetch(`${base}${path}`, { method: path.endsWith("accept") ? "POST" : "GET" })).status, 403, path);

  // the pilot check reads the same file: one of two holders with a key has accepted
  const check = (await (await fetch(`${base}/api/shadow/pilot-check`, { headers: { "x-admin-token": TOKEN } })).json()) as PilotReport;
  const item = check.items.find((i) => i.id === "terms");
  assert.equal(item?.answer, "no");
  assert.match(item?.detail ?? "", /^Version 2026-11-20 is in force and 1 holder with a key in force has no acceptance of it on the record \(1 of 2 do\): alice\./);
  await accept("alice", { version: "2026-11-20" });
  const after2 = (await (await fetch(`${base}/api/shadow/pilot-check`, { headers: { "x-admin-token": TOKEN } })).json()) as PilotReport;
  assert.equal(after2.items.find((i) => i.id === "terms")?.answer, "yes");
});

test("a new version asks again and the old lines stay; reading the record and leaving a lock are never behind the terms", async () => {
  await accept("alice", { version: "2026-11-20" });
  assert.equal((await tap("alice")).body.ok, true);

  setTerms(V2);
  refused(await quote("alice", NYK), NOT_ACCEPTED, V2.terms, "alice under the new version");
  refused(await tap("alice", NYK), NOT_ACCEPTED, V2.terms, "alice's tap under the new version");
  const old = await accept("alice", { version: "2026-11-20" });
  assert.deepEqual([old.status, old.body.message], [400, "version has to be the one in force, 2026-12-05"]);

  // what she holds is still hers to read and to leave
  const positions = await call("alice", "GET", "/api/shadow/positions");
  assert.equal(positions.status, 200);
  const receipt = await call("alice", "GET", `/api/shadow/receipt?ticker=${BOS}`);
  assert.deepEqual([receipt.status, receipt.body.ok], [200, true], JSON.stringify(receipt.body));
  const leaveQuote = await call("alice", "GET", `/api/shadow/unwind/quote?ticker=${BOS}`);
  assert.deepEqual([leaveQuote.status, leaveQuote.body.ok], [200, true], JSON.stringify(leaveQuote.body));
  const left = await call("alice", "POST", "/api/shadow/unwind", { ticker: BOS });
  assert.deepEqual([left.status, left.body.ok], [200, true], JSON.stringify(left.body));
  assert.equal(loadShadowPositions(ledgerOf("alice"))[0].status, "closed");

  const a = await accept("alice", { version: "2026-12-05" });
  assert.deepEqual([a.body.ok, a.body.already], [true, false]);
  assert.deepEqual(lines().map((l) => [l.holder, l.version]), [["alice", "2026-11-20"], ["alice", "2026-12-05"]], "append only: the older acceptance is still on the file");
  assert.equal((await quote("alice", NYK)).body.ok, true);
});

test("settings that cannot be read: every named holder is refused without a link, nobody can accept, and what is on the file does not count", async () => {
  await accept("alice", { version: "2026-11-20" });
  setTerms({ required: true, terms: null, notes: ["EVENT_SHADOW_TERMS_URL has to be an https address with no login in it; no holder can accept until it is corrected"] });
  refused(await quote("alice"), BEING_UPDATED, null, "alice, who had accepted");
  refused(await tap("bob"), BEING_UPDATED, null, "bob");
  const a = await accept("bob", { version: "2026-11-20" });
  assert.deepEqual([a.status, a.body.ok, a.body.message], [409, false, "the terms on this service cannot be accepted right now"]);
  assert.equal(lines().length, 1);
  assert.equal((await quote(null)).body.ok, true, "the operator's own demonstration goes on");
  const s = await standingOf("alice");
  assert.deepEqual([s.body.required, s.body.asked, s.body.accepted, "version" in s.body], [true, true, false, false]);
  const health = (await (await fetch(`${base}/healthz?token=${TOKEN}`)).json()) as { lock: { terms: { notes?: string[]; notAccepted: string[] } } };
  assert.match(health.lock.terms.notes?.[0] ?? "", /^EVENT_SHADOW_TERMS_URL has to be an https address/);
  assert.deepEqual(health.lock.terms.notAccepted, ["alice", "bob"]);
});

test("a torn or foreign line on the file is skipped, never repaired, and the holder is asked again", async () => {
  await accept("alice", { version: "2026-11-20" });
  const { appendFileSync, writeFileSync } = await import("node:fs");
  const whole = readFileSync(termsFile(), "utf8");
  writeFileSync(termsFile(), `${whole.slice(0, 40)}\n{"type":"something_else","holder":"bob","version":"2026-11-20","at":"x","by":"holder"}\n{"type":"terms_accepted","holder":"bob","version":"2026-11-20","at":"x","by":"somebody"}\nnot json\n`);
  assert.deepEqual(lines(), []);
  refused(await quote("alice"), NOT_ACCEPTED, V1.terms, "alice after her line was torn");
  refused(await quote("bob"), NOT_ACCEPTED, V1.terms, "bob, whose lines are not acceptances");
  appendFileSync(termsFile(), whole);
  assert.equal((await quote("alice")).body.ok, true);
});

test("the extension and the member page ask with the service's link and record the holder's own tap", async () => {
  const content = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "demo", "event-lockin-extension", "content.js"), "utf8");
  // the quote's refusal carries the terms to the panel; the panel links the document and posts the version it showed
  assert.ok(content.includes('...(r.json.terms ? { terms: r.json.terms } : {})'));
  assert.ok(content.includes('api("/api/shadow/terms/accept", "POST", { version: terms.version })'));
  assert.ok(content.includes('target="_blank" rel="noopener">Read the terms</a>') && content.includes('"I accept the terms"'));
  assert.ok(content.includes("/^https:\\/\\//.test(st0.quote.terms.url || \"\")"), "only an https link is ever drawn");
  assert.ok(content.includes('so.quote.code === "terms_not_accepted"'), "every row refused for the terms is priced again after the tap");
  const member = await import("../scripts/memberAppHtml");
  const page = member.memberAppHtml({ venueName: "STX", configured: true, recordUrl: "https://shadow.example" });
  assert.ok(page.includes('api("/api/shadow/terms")') && page.includes('api("/api/shadow/terms/accept", "POST", { version: S.terms.version })'));
  assert.ok(page.includes("<b>Before you lock in:</b> read the <a href=\"' + esc(S.terms.url) + '\" target=\"_blank\" rel=\"noopener\">terms</a>"));
  assert.ok(page.includes('case "terms_not_accepted": return ["Terms", p && p.terms ? "Read and accept the terms at the top of this page to lock in."'));
});
