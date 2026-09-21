/**
 * The minimum-credit rule (server-side, in the scan) and the archive-not-delete reset.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  DEFAULT_MINIMUM_CREDIT,
  applyMinimumCredit,
  clearsMinimumCredit,
  describeMinimumCredit,
  minimumCreditCents,
  minimumCreditRuleFromEnv,
} from "../src/eventCollar/crossVenue/minimumCredit";
import { archiveLedgerFile, archivePathFor, archiveStamp } from "../src/eventCollar/crossVenue/ledgerArchive";
import { quoteLadderWrap } from "../src/eventCollar/crossVenue/kalshiLadder";
import { DEFAULT_CROSS_CONFIG, type CollarTerms, type CrossQuote } from "../src/eventCollar/crossVenue/types";
import { retailCrossQuote } from "../src/eventCollar/retailShowcase";

process.env.NODE_ENV = "test";
const TMP_DIR = mkdtempSync(join(tmpdir(), "event-min-credit-"));
process.env.EVENT_X_FUNNEL_PATH = join(TMP_DIR, "funnel.json");
process.env.EVENT_X_LEDGER_PATH = join(TMP_DIR, "cross-quotes.jsonl");
process.env.EVENT_X_ADMIN_TOKEN = "t0ken";

const T0 = Date.parse("2026-09-18T12:00:00.000Z");

test("minimum credit: the line is 25¢ or 0.25% of stake, whichever is more; env overrides; junk falls back", () => {
  assert.deepEqual(DEFAULT_MINIMUM_CREDIT, { cents: 25, bpsOfStake: 25 });
  assert.equal(minimumCreditCents(10), 25, "$10 staked: the absolute floor binds");
  assert.equal(minimumCreditCents(150), 38, "$150 staked: 0.25% = 37.5¢ rounds to 38¢");
  assert.equal(minimumCreditCents(1000), 250, "$1,000 staked: $2.50");
  assert.equal(clearsMinimumCredit(38, 150), true);
  assert.equal(clearsMinimumCredit(37, 150), false);
  assert.equal(describeMinimumCredit(), "25¢ and 0.25% of stake, whichever is more");
  assert.deepEqual(minimumCreditRuleFromEnv({}), DEFAULT_MINIMUM_CREDIT);
  assert.deepEqual(minimumCreditRuleFromEnv({ EVENT_X_MIN_CREDIT_CENTS: "50", EVENT_X_MIN_CREDIT_BPS: "10" }), { cents: 50, bpsOfStake: 10 });
  assert.deepEqual(minimumCreditRuleFromEnv({ EVENT_X_MIN_CREDIT_CENTS: "abc", EVENT_X_MIN_CREDIT_BPS: "-4" }), DEFAULT_MINIMUM_CREDIT, "junk and negatives fall back");
  assert.deepEqual(minimumCreditRuleFromEnv({ EVENT_X_MIN_CREDIT_CENTS: "0", EVENT_X_MIN_CREDIT_BPS: "0" }), { cents: 0, bpsOfStake: 0 }, "0/0 turns the rule off");
});

/** A production-shaped ladder quote with three distinct tiers, hand-checked in the collarSearch tests. */
function ladderQuote(): CrossQuote {
  const q = quoteLadderWrap({
    pair: { kalshi: { ticker: "KXNFLGAME-26SEP27CARCLE-CAR" }, gameStartTime: new Date(T0 + 6 * 3_600_000).toISOString() },
    markCents: 60,
    entryCents: 55,
    contracts: 150,
    now: new Date(T0),
    noAsks: [
      { priceCents: 41, qtyMilli: 100_000 },
      { priceCents: 42, qtyMilli: 300_000 },
      { priceCents: 43, qtyMilli: 900_000 },
    ],
    config: DEFAULT_CROSS_CONFIG,
  });
  assert.ok(q.ok);
  return q;
}

test("applyMinimumCredit: tiers under the line drop; the default stays when it clears; a clearing tier is promoted when it does not; nothing clearing refuses", () => {
  const q = ladderQuote();
  const tiers = Object.keys(q.tiers);
  assert.ok(tiers.length >= 2, `fixture funds ${tiers.length} tiers`);
  const credits = Object.fromEntries(Object.entries(q.tiers).map(([k, t]) => [k, (t as CollarTerms).creditCents]));

  // 1. everything clears at a rule no tier can fail: the quote is returned untouched (same object)
  const off = applyMinimumCredit(q, { cents: 0, bpsOfStake: 0 });
  assert.equal(off, q, "rule off: identity, no copy");

  // 2. a line between the smallest and the default credit: the small tier drops, the default stays on top
  const sorted = Object.values(credits).sort((a, b) => a - b);
  const line = sorted[0] + 1;
  assert.ok(line <= credits[q.tier], "fixture: the default credit is not the smallest");
  const trimmed = applyMinimumCredit(q, { cents: line, bpsOfStake: 0 });
  assert.ok(trimmed.ok);
  assert.equal(trimmed.tier, q.tier, "the default tier stays");
  assert.equal(trimmed.creditCents, q.creditCents);
  assert.ok(!Object.values(trimmed.tiers).some((t) => (t as CollarTerms).creditCents < line), "no offered tier is under the line");
  assert.ok(Object.keys(trimmed.tiers).length < tiers.length, "at least one tier dropped");
  assert.ok(trimmed.tiers[q.tier], "the default is still in the offered set");

  // 3. a quote whose default is the smallest tier (Safest at 40¢ heads it): a line of 41¢ drops it and
  //    promotes Balanced (390¢) to the top-level terms, take, hedge leg and EV cost included
  const tight = q.tiers.tight as CollarTerms;
  const balanced = q.tiers.balanced as CollarTerms;
  assert.ok(tight && balanced && tight.creditCents < balanced.creditCents, "fixture: Safest pays less than Balanced");
  const headedByTight: CrossQuote = { ...q, ...tight, tier: "tight" };
  const promoted = applyMinimumCredit(headedByTight, { cents: tight.creditCents + 1, bpsOfStake: 0 });
  assert.ok(promoted.ok);
  assert.equal(promoted.tier, "balanced", "Balanced is promoted first");
  assert.equal(promoted.creditCents, balanced.creditCents, "top-level credit is the promoted tier's");
  assert.equal(promoted.floorCents, balanced.floorCents);
  assert.equal(promoted.capCents, balanced.capCents);
  assert.equal(promoted.takeCents, balanced.takeCents, "and so is the take");
  assert.deepEqual(promoted.hedge, balanced.hedge, "and the hedge leg");
  assert.equal(promoted.evCostBps, balanced.evCostBps);
  assert.ok(!promoted.tiers.tight, "the old default is no longer offered");
  assert.equal(promoted.contracts, q.contracts);
  assert.equal(promoted.kalshiTicker, q.kalshiTicker, "everything not in the terms is unchanged");
  // when Balanced is under the line too, Safest is next, then Most upside
  const wide = q.tiers.wide as CollarTerms;
  const onlyWide = applyMinimumCredit({ ...q, tiers: { tight, balanced: { ...balanced, creditCents: 1 }, wide } }, { cents: Math.max(tight.creditCents, 2), bpsOfStake: 0 });
  assert.ok(onlyWide.ok);
  assert.equal(onlyWide.tier, tight.creditCents >= 2 ? "tight" : "wide");

  // 4. a line above every credit: an honest refusal that names the best credit and the line
  const best = Math.max(...Object.values(credits));
  const refused = applyMinimumCredit(q, { cents: best + 1, bpsOfStake: 0 });
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.code, "credit_too_small");
    assert.match(refused.detail, new RegExp(`the best credit is ${best}¢ on \\$150\\.00 staked; the minimum is ${best + 1}¢`));
  }
  assert.deepEqual(retailCrossQuote(refused), { ok: false, code: "credit_too_small", detail: "The market can't fund a worthwhile credit on this one right now." });

  // 5. a refusal passes through untouched
  const r = { ok: false as const, code: "pm_book_empty" as const, detail: "x" };
  assert.equal(applyMinimumCredit(r), r);

  // 6. a legacy quote with no tiers is judged on its own credit
  const legacy = { ...q, tiers: {} } as CrossQuote;
  assert.equal(applyMinimumCredit(legacy, { cents: q.creditCents, bpsOfStake: 0 }), legacy);
  assert.equal(applyMinimumCredit(legacy, { cents: q.creditCents + 1, bpsOfStake: 0 }).ok, false);
});

test("demo service: the rule runs in the scan before the ceiling; the EV cost follows a promoted tier; refusals carry their own code", async () => {
  const { applyMinimumCreditRule, applyQuoteRules, applyEvCeiling, MIN_CREDIT_RULE } = await import("../scripts/eventProtectXDemoService");
  const { evCostBps } = await import("../src/eventCollar/crossVenue/crossVenuePricer");
  assert.deepEqual(MIN_CREDIT_RULE, DEFAULT_MINIMUM_CREDIT, "no env: the defaults");
  const q = ladderQuote();
  const base = {
    kind: "sports" as const,
    league: "nfl",
    market: { ticker: q.kalshiTicker } as unknown as import("../src/eventCollar/types").KalshiMarket,
    pair: null,
    sideName: "Panthers",
    eventTitle: "Panthers to win",
    eventTimeIso: new Date(T0 + 6 * 3_600_000).toISOString(),
    parityNote: "own No side",
    fingerprint: "x",
    markCents: 60,
    position: { contracts: 150, entryCents: 55, entrySource: "real_print" as const, entryTime: null },
    quote: q,
    route: "kalshi_self" as const,
    evBps: evCostBps(60, q.floorCents, q.capCents, q.creditCents, 150),
    routesChecked: [],
    books: {},
  };
  // untouched when the default clears
  const same = applyMinimumCreditRule(base as never, { cents: 0, bpsOfStake: 0 });
  assert.equal(same, base);

  const credits = Object.fromEntries(Object.entries(q.tiers).map(([k, t]) => [k, (t as CollarTerms).creditCents]));
  const best = Math.max(...Object.values(credits));
  const tight = q.tiers.tight as CollarTerms;
  const headedByTight = { ...base, quote: { ...q, ...tight, tier: "tight" as const }, evBps: evCostBps(60, tight.floorCents, tight.capCents, tight.creditCents, 150) };
  const promoted = applyMinimumCreditRule(headedByTight as never, { cents: tight.creditCents + 1, bpsOfStake: 0 });
  assert.ok(promoted.quote.ok);
  assert.equal(promoted.quote.tier, "balanced");
  assert.equal(promoted.evBps, evCostBps(60, promoted.quote.floorCents, promoted.quote.capCents, promoted.quote.creditCents, 150), "EV cost re-derived from the promoted terms");
  assert.notEqual(promoted.evBps, headedByTight.evBps);
  assert.equal(promoted.route, "kalshi_self", "the route is unchanged");

  const refused = applyMinimumCreditRule(base as never, { cents: best + 1, bpsOfStake: 0 });
  assert.equal(refused.quote.ok, false);
  assert.equal(!refused.quote.ok && refused.quote.code, "credit_too_small");
  assert.equal(refused.route, null);
  assert.equal(refused.evBps, null);
  assert.equal(applyEvCeiling(refused).quote.ok, false, "the ceiling leaves a refusal alone");

  // order: minimum credit first, then the ceiling; a quote that clears the line but is rich is refused as rich
  const rich = applyQuoteRules({ ...base, evBps: 9_999 } as never);
  assert.equal(!rich.quote.ok && rich.quote.code, "protection_too_rich");
});

test("archive: a ledger is renamed beside itself with a UTC stamp, never deleted; a missing file is a no-op", () => {
  assert.equal(archiveStamp("2026-09-21T01:30:05.123Z"), "2026-09-21T013005Z");
  assert.equal(archivePathFor("/var/data/shadow-ledger.jsonl", "2026-09-21T01:30:05.123Z"), "/var/data/shadow-ledger.2026-09-21T013005Z.archived.jsonl");
  assert.equal(archivePathFor("/var/data/funnel.json", "2026-09-21T01:30:05.123Z"), "/var/data/funnel.2026-09-21T013005Z.archived.json");
  const dir = mkdtempSync(join(tmpdir(), "archive-"));
  const path = join(dir, "ledger.jsonl");
  assert.deepEqual(archiveLedgerFile(path, "2026-09-21T01:30:05.123Z"), { path, archivedTo: null }, "nothing to archive");
  writeFileSync(path, '{"a":1}\n{"a":2}\n');
  const r = archiveLedgerFile(path, "2026-09-21T01:30:05.123Z");
  assert.equal(r.archivedTo, join(dir, "ledger.2026-09-21T013005Z.archived.jsonl"));
  assert.equal(existsSync(path), false);
  assert.equal(readFileSync(r.archivedTo as string, "utf8"), '{"a":1}\n{"a":2}\n', "byte for byte");
});

test("demo service: POST /api/admin/reset archives the quote ledger and the funnel and starts fresh; operator only", async () => {
  const { server, primeScanForTests } = await import("../scripts/eventProtectXDemoService");
  primeScanForTests({ atIso: "2026-09-20T18:00:00.000Z", rows: [], fallback: null, fetchFailures: 0 });
  const ledgerPath = process.env.EVENT_X_LEDGER_PATH as string;
  const funnelPath = process.env.EVENT_X_FUNNEL_PATH as string;
  writeFileSync(ledgerPath, '{"at":"2026-09-18T10:00:00.000Z","kind":"cross_venue_quote","result":{"ok":false,"code":"pm_book_empty","detail":"x"}}\n');
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fetch(`${base}/`); // a page load lands in the funnel
    const before = (await (await fetch(`${base}/api/admin/funnel?token=t0ken`)).json()) as { funnel: { pageLoads7d: Array<{ byPage: Record<string, number> }> } };
    assert.ok(before.funnel.pageLoads7d.some((d) => (d.byPage.embed ?? 0) > 0), "the funnel has a load to archive");

    assert.equal((await fetch(`${base}/api/admin/reset`, { method: "POST" })).status, 403, "operator only");
    assert.equal((await fetch(`${base}/api/admin/reset?token=t0ken`)).status, 405, "a bare GET does nothing");
    const reset = await fetch(`${base}/api/admin/reset?token=t0ken`, { method: "POST" });
    assert.equal(reset.status, 200);
    const body = (await reset.json()) as { ok: boolean; archived: Array<{ from: string; to: string }>; rules: { minimumCredit: string; maxEvCostBps: number } };
    assert.equal(body.ok, true);
    assert.deepEqual(
      body.archived.map((a) => a.from).sort(),
      [funnelPath, ledgerPath].sort(),
      "both files archived",
    );
    for (const a of body.archived) {
      assert.match(a.to, /\.\d{4}-\d{2}-\d{2}T\d{6}Z\.archived\.jsonl?$|\.archived\.json$/);
      assert.ok(existsSync(a.to), `${a.to} exists`);
    }
    assert.equal(body.rules.minimumCredit, "25¢ and 0.25% of stake, whichever is more", "the reset names the rules the new window runs under");
    assert.equal(body.rules.maxEvCostBps, 300);
    assert.equal(existsSync(ledgerPath), false, "the live ledger path is empty until the next scan writes it");
    const after = (await (await fetch(`${base}/api/admin/funnel?token=t0ken`)).json()) as { funnel: { pageLoads7d: Array<{ byPage: Record<string, number> }> } };
    assert.equal(after.funnel.pageLoads7d.reduce((n, d) => n + (d.byPage.embed ?? 0), 0), 0, "the funnel starts over");
    const receipts = (await (await fetch(`${base}/api/receipts`)).json()) as { summary?: { priced: number; refused: number }; priced?: number; refused?: number };
    const s = receipts.summary ?? receipts;
    assert.equal((s.priced ?? 0) + (s.refused ?? 0), 0, "the receipts start over");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
